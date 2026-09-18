import { randomUUID } from "node:crypto";
import type pg from "pg";
import { allocateCents, assertCents, type CourtPrice } from "../../../domain/src/tennis-pricing.ts";
import { recordTenantAudit, TenantAccessError, type TenantActor } from "./access.ts";
import { locateOrder, orderInTransaction, requireBookingVenue, type OrderLine, type OrderRecord } from "./booking.ts";
import { priceSelectionInTransaction } from "./catalog.ts";
import { isCustomerActor, requireCustomer, withBookingTransaction, type BookingActor } from "./customers.ts";
import { CourtInventoryError } from "./inventory.ts";
import type { PaymentProviderPort } from "./payment-port.ts";
import { resolvePaymentMerchant, enqueuePaymentChannel } from "./channel-intents.ts";
import { paymentInTransaction, type PaymentRecord } from "./payments.ts";
import { idempotentCommand, requestHash } from "./receipts.ts";
import { createRefundGroupInTransaction, refundableLines, refreshOrderPaymentStatus } from "./refunds.ts";
import { lockTenantTransactions } from "./transaction-locks.ts";
import { reserveWallet, settleWalletReservation } from "./wallet-store.ts";

export class TennisAmendmentError extends Error {
  constructor(
    readonly code:
      | "INVALID_AMENDMENT"
      | "ORDER_NOT_AMENDABLE"
      | "UNPAID_ORDER_PAYMENT_UNRESOLVED"
      | "STALE_ORDER"
      | "AMENDMENT_EXPIRED"
      | "ORDER_AMENDMENT_PENDING"
      | "AMENDMENT_ALREADY_CONFIRMED"
      | "AMENDMENT_NOT_PAYABLE"
      | "AMENDMENT_NOT_CANCELLABLE",
  ) {
    super(code);
    this.name = "TennisAmendmentError";
  }
}
export interface AmendmentLine {
  lineId: string;
  old: OrderLine;
  new: CourtPrice;
  originalOccupancyId: string;
  fundingCapDeltaCents: number;
  suggestedRefundCents: number;
  approvedRefundCents: number | null;
}
export interface AmendmentRecord {
  id: string;
  orderId: string;
  venueId: string;
  customerId: string;
  createdBy: string;
  baseRevision: number;
  unpaid: boolean;
  reason: string;
  status: "QUOTED" | "AWAITING_PAYMENT" | "APPLIED" | "CANCELLED" | "EXPIRED";
  expiresAt: string;
  holdUntil: string | null;
  supplementalCents: number;
  suggestedRefundCents: number;
  approvedRefundCents: number | null;
  lines: AmendmentLine[];
  refundGroupId: string | null;
}
type AmendmentRow = Omit<AmendmentRecord, "expiresAt" | "holdUntil" | "lines" | "refundGroupId"> & {
  expiresAt: Date;
  holdUntil: Date | null;
  confirmationRequest: unknown;
};
export async function amendmentInTransaction(
  tx: pg.PoolClient,
  tenantId: string,
  id: string,
): Promise<AmendmentRecord & { confirmationRequest: unknown }> {
  const row = (
    await tx.query<AmendmentRow>(
      `SELECT id,order_id AS "orderId",venue_id AS "venueId",customer_id AS "customerId",created_by AS "createdBy",base_revision AS "baseRevision",unpaid,reason,status,
    expires_at AS "expiresAt",hold_until AS "holdUntil",supplemental_cents::float8 AS "supplementalCents",suggested_refund_cents::float8 AS "suggestedRefundCents",approved_refund_cents::float8 AS "approvedRefundCents",confirmation_request AS "confirmationRequest"
    FROM tennis.order_amendments WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
      [tenantId, id],
    )
  ).rows[0];
  if (!row) throw new TenantAccessError("RESOURCE_NOT_FOUND");
  const lines = (
    await tx.query<AmendmentLine>(
      `SELECT line_id AS "lineId",old_snapshot AS old,new_snapshot AS new,original_occupancy_id AS "originalOccupancyId",funding_cap_delta_cents::float8 AS "fundingCapDeltaCents",suggested_refund_cents::float8 AS "suggestedRefundCents",approved_refund_cents::float8 AS "approvedRefundCents"
    FROM tennis.order_amendment_lines WHERE tenant_id=$1 AND amendment_id=$2 ORDER BY line_id`,
      [tenantId, id],
    )
  ).rows;
  const group = (
    await tx.query<{ id: string }>("SELECT id FROM tennis.refund_groups WHERE tenant_id=$1 AND amendment_id=$2", [
      tenantId,
      id,
    ])
  ).rows[0];
  return {
    ...row,
    expiresAt: row.expiresAt.toISOString(),
    holdUntil: row.holdUntil?.toISOString() ?? null,
    lines,
    refundGroupId: group?.id ?? null,
  };
}
async function locateAmendment(
  tx: pg.PoolClient,
  actor: BookingActor,
  id: string,
  permission: "read" | "book" = "read",
) {
  const row = (
    await tx.query<{ order_id: string }>("SELECT order_id FROM tennis.order_amendments WHERE tenant_id=$1 AND id=$2", [
      actor.tenantId,
      id,
    ])
  ).rows[0];
  if (!row) throw new TenantAccessError("RESOURCE_NOT_FOUND");
  const venueId = await locateOrder(tx, actor, row.order_id);
  await requireBookingVenue(tx, actor, venueId, permission);
  return { venueId, orderId: row.order_id };
}
export async function assertNoPendingAmendment(tx: pg.PoolClient, tenantId: string, orderId: string): Promise<void> {
  if (
    (
      await tx.query(
        "SELECT id FROM tennis.order_amendments WHERE tenant_id=$1 AND order_id=$2 AND status='AWAITING_PAYMENT'",
        [tenantId, orderId],
      )
    ).rowCount
  )
    throw new TennisAmendmentError("ORDER_AMENDMENT_PENDING");
}
function employee(actor: BookingActor) {
  if (isCustomerActor(actor)) throw new TenantAccessError("TENANT_ACCESS_DENIED");
}
async function now(tx: pg.PoolClient): Promise<number> {
  return (await tx.query<{ time: Date }>("SELECT clock_timestamp() AS time")).rows[0]!.time.getTime();
}
/** Caller holds tenant/venue/order locks. Payment facts are never changed to permit an edit. */
async function assertUnpaidEditable(tx: pg.PoolClient, tenantId: string, order: OrderRecord): Promise<void> {
  if (
    order.status !== "HELD" ||
    order.paymentStatus !== "UNPAID" ||
    !order.holdUntil ||
    Date.parse(order.holdUntil) <= (await now(tx))
  )
    throw new TennisAmendmentError("ORDER_NOT_AMENDABLE");
  const payment = await tx.query(
    `SELECT id FROM tennis.payment_attempts p WHERE p.tenant_id=$1 AND p.order_id=$2 AND
      (p.status NOT IN ('FAILED','EXPIRED','CANCELLED') OR p.provider_transaction_id IS NOT NULL
       OR EXISTS(SELECT 1 FROM tennis.external_payment_receipts r WHERE r.tenant_id=p.tenant_id AND r.payment_id=p.id)
       OR EXISTS(SELECT 1 FROM tennis.financial_exceptions x WHERE x.tenant_id=p.tenant_id AND x.payment_id=p.id)) LIMIT 1`,
    [tenantId, order.id],
  );
  if (payment.rowCount) throw new TennisAmendmentError("UNPAID_ORDER_PAYMENT_UNRESOLVED");
}
function overlaps(
  a: { courtId: string; startAt: string; endAt: string },
  b: { courtId: string; startAt: string; endAt: string },
) {
  return (
    a.courtId === b.courtId &&
    Date.parse(a.startAt) < Date.parse(b.endAt) &&
    Date.parse(a.endAt) > Date.parse(b.startAt)
  );
}
async function checkTargets(
  tx: pg.PoolClient,
  tenantId: string,
  orderId: string,
  lines: readonly AmendmentLine[],
  ownAmendment?: string,
): Promise<void> {
  const order = await orderInTransaction(tx, { tenantId, subjectId: "system:tennis" }, orderId);
  const ids = new Set(lines.map((l) => l.lineId));
  const final = [...order.lines.filter((l) => !l.cancelledAt && !ids.has(l.id)), ...lines.map((l) => l.new)];
  for (let i = 0; i < final.length; i++)
    for (let j = i + 1; j < final.length; j++)
      if (overlaps(final[i]!, final[j]!)) throw new CourtInventoryError("INVENTORY_CONFLICT");
  const time = await now(tx);
  for (const line of lines) {
    if (Date.parse(line.old.startAt) <= time || Date.parse(line.new.startAt) <= time)
      throw new TennisAmendmentError("ORDER_NOT_AMENDABLE");
    const conflict = await tx.query(
      `SELECT id FROM tennis.occupancies WHERE tenant_id=$1 AND court_id=$2 AND released_at IS NULL
      AND start_at<$4 AND end_at>$3 AND NOT(id=ANY($5::text[])) AND ($6::text IS NULL OR amendment_id IS DISTINCT FROM $6) LIMIT 1`,
      [
        tenantId,
        line.new.courtId,
        line.new.startAt,
        line.new.endAt,
        lines.map((l) => l.originalOccupancyId),
        ownAmendment ?? null,
      ],
    );
    if (conflict.rowCount) throw new CourtInventoryError("INVENTORY_CONFLICT");
  }
}
/** Reprice only the current active projection; cancelled row snapshots stay available for history. */
async function refreshUnpaidProjection(tx: pg.PoolClient, tenantId: string, orderId: string): Promise<void> {
  await tx.query(
    `WITH value AS (
      SELECT count(*) AS count,coalesce(sum(amount_cents),0) AS total,
        coalesce(jsonb_agg(price_snapshot ORDER BY position),'[]'::jsonb) AS lines
      FROM tennis.order_lines WHERE tenant_id=$1 AND order_id=$2 AND cancelled_at IS NULL
    ) UPDATE tennis.orders o SET
      total_cents=CASE WHEN v.count=0 THEN o.total_cents ELSE v.total END,
      price_snapshot=CASE WHEN v.count=0 THEN o.price_snapshot ELSE jsonb_set(jsonb_set(o.price_snapshot,'{lines}',v.lines),'{totalCents}',to_jsonb(v.total)) END,
      status=CASE WHEN v.count=0 THEN 'CANCELLED' WHEN v.total=0 THEN 'CONFIRMED' ELSE 'HELD' END,
      payment_status=CASE WHEN v.count>0 AND v.total=0 THEN 'NOT_REQUIRED' ELSE 'UNPAID' END,
      hold_until=CASE WHEN v.count=0 OR v.total=0 THEN NULL ELSE o.hold_until END,
      revision=o.revision+1,updated_at=clock_timestamp()
    FROM value v WHERE o.tenant_id=$1 AND o.id=$2`,
    [tenantId, orderId],
  );
}
/** No payment/refund is created: employees remove selected unpaid lines under the original hold. */
export async function cancelUnpaidOrderLines(
  db: pg.Pool,
  actor: TenantActor,
  input: {
    orderId: string;
    expectedRevision: number;
    lineIds: readonly string[];
    reason: string;
    commandKey: string;
  },
): Promise<OrderRecord> {
  employee(actor);
  if (
    !input.reason.trim() ||
    input.reason.length > 2000 ||
    !input.lineIds.length ||
    input.lineIds.length > 100 ||
    new Set(input.lineIds).size !== input.lineIds.length
  )
    throw new TennisAmendmentError("INVALID_AMENDMENT");
  return withBookingTransaction(db, actor, async (tx) => {
    const venueId = await locateOrder(tx, actor, input.orderId);
    await requireBookingVenue(tx, actor, venueId, "book");
    const { commandKey, ...request } = input;
    const result = await idempotentCommand(
      tx,
      actor,
      venueId,
      commandKey,
      "order.cancel_unpaid_lines",
      { ...request, lineIds: [...request.lineIds].sort() },
      async () => {
        const order = await orderInTransaction(tx, actor, input.orderId);
        if (order.revision !== input.expectedRevision) throw new TennisAmendmentError("STALE_ORDER");
        await assertUnpaidEditable(tx, actor.tenantId, order);
        await assertNoPendingAmendment(tx, actor.tenantId, order.id);
        if (input.lineIds.some((id) => !order.lines.some((line) => line.id === id && !line.cancelledAt)))
          throw new TennisAmendmentError("INVALID_AMENDMENT");
        await tx.query(
          "UPDATE tennis.order_lines SET cancelled_at=clock_timestamp(),cancelled_before_payment=true,initial_funding_cents=0 WHERE tenant_id=$1 AND order_id=$2 AND id=ANY($3::text[])",
          [actor.tenantId, order.id, input.lineIds],
        );
        await tx.query(
          "UPDATE tennis.occupancies SET released_at=clock_timestamp(),revision=revision+1 WHERE tenant_id=$1 AND order_line_id=ANY($2::text[]) AND released_at IS NULL",
          [actor.tenantId, input.lineIds],
        );
        if (Date.parse(order.holdUntil!) <= (await now(tx))) throw new TennisAmendmentError("ORDER_NOT_AMENDABLE");
        await refreshUnpaidProjection(tx, actor.tenantId, order.id);
        await recordTenantAudit(tx, actor, "order.cancel_unpaid_lines", order.id, {
          reason: input.reason.trim(),
          lineIds: input.lineIds,
          previousTotalCents: order.totalCents,
        });
        return { orderId: order.id };
      },
    );
    return orderInTransaction(tx, actor, result.orderId);
  });
}
export async function previewOrderAmendment(
  db: pg.Pool,
  actor: TenantActor,
  input: {
    orderId: string;
    expectedRevision: number;
    changes: readonly {
      lineId: string;
      courtId: string;
      startAt: string;
      endAt: string;
    }[];
    reason: string;
  },
): Promise<AmendmentRecord> {
  employee(actor);
  if (
    !input.reason.trim() ||
    input.reason.length > 2000 ||
    !input.changes.length ||
    input.changes.length > 100 ||
    new Set(input.changes.map((l) => l.lineId)).size !== input.changes.length
  )
    throw new TennisAmendmentError("INVALID_AMENDMENT");
  return withBookingTransaction(db, actor, async (tx) => {
    const venueId = await locateOrder(tx, actor, input.orderId);
    await requireBookingVenue(tx, actor, venueId, "book");
    await expireVenueAmendments(tx, actor.tenantId, venueId);
    const order = await orderInTransaction(tx, actor, input.orderId);
    if (order.revision !== input.expectedRevision) throw new TennisAmendmentError("STALE_ORDER");
    const unpaid = order.status === "HELD" && order.paymentStatus === "UNPAID";
    if (unpaid) await assertUnpaidEditable(tx, actor.tenantId, order);
    else if (order.status !== "CONFIRMED" || order.paymentStatus === "UNPAID")
      throw new TennisAmendmentError("ORDER_NOT_AMENDABLE");
    await assertNoPendingAmendment(tx, actor.tenantId, order.id);
    await requireCustomer(tx, actor, order.customerId);
    const price = await priceSelectionInTransaction(tx, actor, venueId, input.changes);
    const available = unpaid ? new Map<string, number>() : await refundableLines(tx, actor.tenantId, order.id);
    const lines: AmendmentLine[] = [];
    for (const [i, change] of input.changes.entries()) {
      const old = order.lines.find((l) => l.id === change.lineId && !l.cancelledAt);
      if (!old) throw new TennisAmendmentError("INVALID_AMENDMENT");
      const occupancy = (
        await tx.query<{ id: string }>(
          "SELECT id FROM tennis.occupancies WHERE tenant_id=$1 AND order_line_id=$2 AND released_at IS NULL",
          [actor.tenantId, old.id],
        )
      ).rows[0];
      if (!occupancy) throw new TennisAmendmentError("ORDER_NOT_AMENDABLE");
      lines.push({
        lineId: old.id,
        old,
        new: price.lines[i]!,
        originalOccupancyId: occupancy.id,
        fundingCapDeltaCents: 0,
        suggestedRefundCents: 0,
        approvedRefundCents: null,
      });
    }
    // Stable order controls all rounding, independent of the request array order.
    lines.sort((a, b) => a.lineId.localeCompare(b.lineId));
    const increases = lines.map((l) => (unpaid ? 0 : Math.max(0, l.new.totalCents - l.old.amountCents)));
    const credits = lines.map((l) =>
      Math.min(Math.max(0, l.old.amountCents - l.new.totalCents), available.get(l.lineId) ?? 0),
    );
    const increase = increases.reduce((a, b) => a + b, 0),
      credit = credits.reduce((a, b) => a + b, 0),
      transfer = Math.min(increase, credit);
    const transfers = allocateCents(transfer, credits),
      refunds = credits.map((c, i) => c - transfers[i]!);
    for (const [i, line] of lines.entries()) {
      line.fundingCapDeltaCents = increases[i]! - transfers[i]!;
      line.suggestedRefundCents = refunds[i]!;
    }
    const supplemental = Math.max(0, increase - credit),
      refund = Math.max(0, credit - increase);
    assertCents(supplemental);
    assertCents(refund);
    await checkTargets(tx, actor.tenantId, order.id, lines);
    const id = randomUUID();
    await tx.query(
      `INSERT INTO tennis.order_amendments(id,tenant_id,venue_id,order_id,customer_id,created_by,base_revision,status,reason,expires_at,supplemental_cents,suggested_refund_cents,unpaid)
      VALUES($1,$2,$3,$4,$5,$6,$7,'QUOTED',$8,least(clock_timestamp()+interval '5 minutes',coalesce($12::timestamptz,'infinity')),$9,$10,$11)`,
      [
        id,
        actor.tenantId,
        venueId,
        order.id,
        order.customerId,
        actor.subjectId,
        order.revision,
        input.reason.trim(),
        supplemental,
        refund,
        unpaid,
        unpaid ? order.holdUntil : null,
      ],
    );
    for (const line of lines)
      await tx.query(
        `INSERT INTO tennis.order_amendment_lines(tenant_id,amendment_id,line_id,old_snapshot,new_snapshot,original_occupancy_id,funding_cap_delta_cents,suggested_refund_cents)
      VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8)`,
        [
          actor.tenantId,
          id,
          line.lineId,
          JSON.stringify(line.old),
          JSON.stringify(line.new),
          line.originalOccupancyId,
          line.fundingCapDeltaCents,
          line.suggestedRefundCents,
        ],
      );
    await recordTenantAudit(tx, actor, "amendment.preview", id, {
      orderId: order.id,
      supplementalCents: supplemental,
      suggestedRefundCents: refund,
    });
    return amendmentInTransaction(tx, actor.tenantId, id);
  });
}
/** Target minus selected original intervals. Keeps original inventory intact while awaiting payment. */
async function holdNewCoverage(tx: pg.PoolClient, tenantId: string, amendment: AmendmentRecord): Promise<void> {
  for (const line of amendment.lines) {
    let fragments: [number, number][] = [[Date.parse(line.new.startAt), Date.parse(line.new.endAt)]];
    for (const original of amendment.lines.filter((l) => l.old.courtId === line.new.courtId)) {
      const start = Date.parse(original.old.startAt),
        end = Date.parse(original.old.endAt);
      fragments = fragments.flatMap(([a, b]) =>
        end <= a || start >= b
          ? [[a, b] as [number, number]]
          : [
              ...(a < start ? [[a, Math.min(start, b)] as [number, number]] : []),
              ...(end < b ? [[Math.max(end, a), b] as [number, number]] : []),
            ],
      );
    }
    for (const [start, end] of fragments)
      await tx.query(
        `INSERT INTO tennis.occupancies(id,tenant_id,court_id,kind,source_id,start_at,end_at,amendment_id)
      VALUES($1,$2,$3,'BOOKING',$4,$5,$6,$4)`,
        [randomUUID(), tenantId, line.new.courtId, amendment.id, new Date(start), new Date(end)],
      );
  }
}
/** Caller owns tenant/venue/order/amendment locks. Any error rolls the original booking back intact. */
export async function applyAmendmentInTransaction(tx: pg.PoolClient, tenantId: string, id: string): Promise<void> {
  const amendment = await amendmentInTransaction(tx, tenantId, id);
  if (amendment.status === "APPLIED") return;
  if (!["QUOTED", "AWAITING_PAYMENT"].includes(amendment.status))
    throw new TennisAmendmentError("AMENDMENT_NOT_PAYABLE");
  const actor = { tenantId, subjectId: amendment.createdBy };
  const order = await orderInTransaction(tx, actor, amendment.orderId);
  if (order.revision !== amendment.baseRevision) throw new TennisAmendmentError("STALE_ORDER");
  if (amendment.unpaid) await assertUnpaidEditable(tx, tenantId, order);
  else if (order.status !== "CONFIRMED") throw new TennisAmendmentError("ORDER_NOT_AMENDABLE");
  if (amendment.supplementalCents > 0) {
    const captured = (
      await tx.query<{ amount: string }>(
        "SELECT (wallet_cents+external_cents)::text AS amount FROM tennis.payment_attempts WHERE tenant_id=$1 AND amendment_id=$2 AND status='SUCCEEDED'",
        [tenantId, id],
      )
    ).rows;
    if (captured.length !== 1 || Number(captured[0]!.amount) !== amendment.supplementalCents)
      throw new TennisAmendmentError("AMENDMENT_NOT_PAYABLE");
  }
  const time = await now(tx);
  if (amendment.holdUntil && Date.parse(amendment.holdUntil) <= time)
    throw new TennisAmendmentError("AMENDMENT_EXPIRED");
  // Asset configuration writers see both old and staged holds and cannot silently close them.
  await priceSelectionInTransaction(
    tx,
    actor,
    amendment.venueId,
    amendment.lines.map((l) => l.new),
  );
  await checkTargets(tx, tenantId, order.id, amendment.lines, id);
  for (const line of amendment.lines) {
    const live = (
      await tx.query(
        "SELECT id FROM tennis.occupancies WHERE tenant_id=$1 AND id=$2 AND order_line_id=$3 AND released_at IS NULL FOR UPDATE",
        [tenantId, line.originalOccupancyId, line.lineId],
      )
    ).rowCount;
    if (!live) throw new TennisAmendmentError("STALE_ORDER");
  }
  await tx.query(
    "UPDATE tennis.occupancies SET released_at=clock_timestamp(),revision=revision+1 WHERE tenant_id=$1 AND released_at IS NULL AND (id=ANY($2::text[]) OR amendment_id=$3)",
    [tenantId, amendment.lines.map((l) => l.originalOccupancyId), id],
  );
  for (const line of amendment.lines) {
    await tx.query(
      "UPDATE tennis.order_lines SET court_id=$1,start_at=$2,end_at=$3,amount_cents=$4,price_snapshot=$5::jsonb,initial_funding_cents=CASE WHEN $8 THEN $4 ELSE initial_funding_cents END WHERE tenant_id=$6 AND id=$7",
      [
        line.new.courtId,
        line.new.startAt,
        line.new.endAt,
        line.new.totalCents,
        JSON.stringify(line.new),
        tenantId,
        line.lineId,
        amendment.unpaid,
      ],
    );
    await tx.query(
      `INSERT INTO tennis.occupancies(id,tenant_id,court_id,kind,source_id,start_at,end_at,order_line_id) VALUES($1,$2,$3,'BOOKING',$4,$5,$6,$7)`,
      [randomUUID(), tenantId, line.new.courtId, order.id, line.new.startAt, line.new.endAt, line.lineId],
    );
  }
  const commitTime = await now(tx);
  const deadline = Date.parse(amendment.status === "QUOTED" ? amendment.expiresAt : amendment.holdUntil!);
  if (
    deadline <= commitTime ||
    (amendment.unpaid && Date.parse(order.holdUntil!) <= commitTime) ||
    amendment.lines.some((l) => Date.parse(l.old.startAt) <= commitTime || Date.parse(l.new.startAt) <= commitTime)
  )
    throw new TennisAmendmentError("AMENDMENT_EXPIRED");
  await tx.query(
    "UPDATE tennis.order_amendments SET status='APPLIED',hold_until=NULL,applied_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",
    [tenantId, id],
  );
  // The current projection may change; original quote and immutable amendment snapshots preserve history.
  if (amendment.unpaid) await refreshUnpaidProjection(tx, tenantId, order.id);
  else
    await tx.query(
      `UPDATE tennis.orders SET payment_status=CASE WHEN payment_status='NOT_REQUIRED' AND (SELECT sum(amount_cents) FROM tennis.order_lines WHERE tenant_id=$1 AND order_id=$2 AND NOT cancelled_before_payment)>0 THEN 'PAID' ELSE payment_status END, total_cents=(SELECT sum(amount_cents) FROM tennis.order_lines WHERE tenant_id=$1 AND order_id=$2 AND NOT cancelled_before_payment),
    price_snapshot=jsonb_set(jsonb_set(price_snapshot,'{lines}',(SELECT jsonb_agg(price_snapshot ORDER BY position) FROM tennis.order_lines WHERE tenant_id=$1 AND order_id=$2 AND NOT cancelled_before_payment)),
    '{totalCents}',to_jsonb((SELECT sum(amount_cents) FROM tennis.order_lines WHERE tenant_id=$1 AND order_id=$2 AND NOT cancelled_before_payment))),revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2`,
      [tenantId, order.id],
    );
  const refundLines = amendment.lines
    .filter((l) => (l.approvedRefundCents ?? 0) > 0)
    .map((l) => ({
      lineId: l.lineId,
      refundCents: l.approvedRefundCents!,
      cancel: false,
    }));
  if (refundLines.length)
    await createRefundGroupInTransaction(tx, actor, {
      orderId: order.id,
      reason: amendment.reason,
      amendmentId: id,
      lines: refundLines,
    });
  if (!amendment.unpaid) await refreshOrderPaymentStatus(tx, tenantId, order.id);
  await recordTenantAudit(tx, actor, "amendment.apply", id, {
    orderId: order.id,
    supplementalCents: amendment.supplementalCents,
    approvedRefundCents: amendment.approvedRefundCents,
  });
}
export async function confirmOrderAmendment(
  db: pg.Pool,
  actor: TenantActor,
  input: {
    amendmentId: string;
    commandKey: string;
    approvedRefundLines?: readonly { lineId: string; refundCents: number }[];
  },
): Promise<AmendmentRecord> {
  employee(actor);
  const approved = [...(input.approvedRefundLines ?? [])].sort((a, b) => a.lineId.localeCompare(b.lineId));
  if (new Set(approved.map((l) => l.lineId)).size !== approved.length)
    throw new TennisAmendmentError("INVALID_AMENDMENT");
  approved.forEach((l) => assertCents(l.refundCents));
  return withBookingTransaction(db, actor, async (tx) => {
    const located = await locateAmendment(tx, actor, input.amendmentId, "book");
    await expireVenueAmendments(tx, actor.tenantId, located.venueId);
    const request = {
      amendmentId: input.amendmentId,
      approvedRefundLines: approved,
    };
    const result = await idempotentCommand(
      tx,
      actor,
      located.venueId,
      input.commandKey,
      "amendment.confirm",
      request,
      async () => {
        const order = await orderInTransaction(tx, actor, located.orderId);
        const amendment = await amendmentInTransaction(tx, actor.tenantId, input.amendmentId);
        if (amendment.createdBy !== actor.subjectId) throw new TenantAccessError("RESOURCE_NOT_FOUND");
        if (amendment.confirmationRequest) {
          if (requestHash(amendment.confirmationRequest) !== requestHash(request))
            throw new TennisAmendmentError("AMENDMENT_ALREADY_CONFIRMED");
          return { amendmentId: amendment.id };
        }
        if (amendment.status !== "QUOTED" || Date.parse(amendment.expiresAt) <= (await now(tx)))
          throw new TennisAmendmentError("AMENDMENT_EXPIRED");
        if (order.revision !== amendment.baseRevision) throw new TennisAmendmentError("STALE_ORDER");
        if (amendment.unpaid) await assertUnpaidEditable(tx, actor.tenantId, order);
        await assertNoPendingAmendment(tx, actor.tenantId, order.id);
        if (amendment.suggestedRefundCents > 0) {
          await requireBookingVenue(tx, actor, located.venueId, "refund");
          if (amendment.lines.some((l) => l.suggestedRefundCents > 0 && !approved.some((a) => a.lineId === l.lineId)))
            throw new TennisAmendmentError("INVALID_AMENDMENT");
        }
        for (const value of approved)
          if (!amendment.lines.some((l) => l.lineId === value.lineId && value.refundCents <= l.suggestedRefundCents))
            throw new TennisAmendmentError("INVALID_AMENDMENT");
        const refund = approved.reduce((s, l) => s + l.refundCents, 0);
        assertCents(refund);
        await priceSelectionInTransaction(
          tx,
          actor,
          located.venueId,
          amendment.lines.map((l) => l.new),
        );
        await checkTargets(tx, actor.tenantId, order.id, amendment.lines);
        for (const line of amendment.lines)
          await tx.query(
            "UPDATE tennis.order_amendment_lines SET approved_refund_cents=$1 WHERE tenant_id=$2 AND amendment_id=$3 AND line_id=$4",
            [
              approved.find((l) => l.lineId === line.lineId)?.refundCents ?? 0,
              actor.tenantId,
              amendment.id,
              line.lineId,
            ],
          );
        await tx.query(
          "UPDATE tennis.order_amendments SET approved_refund_cents=$1,confirmation_request=$2::jsonb WHERE tenant_id=$3 AND id=$4",
          [refund, JSON.stringify(request), actor.tenantId, amendment.id],
        );
        if (amendment.supplementalCents > 0) {
          await holdNewCoverage(tx, actor.tenantId, amendment);
          const deadline = Math.min(
            (await now(tx)) + 600000,
            ...amendment.lines.flatMap((l) => [Date.parse(l.old.startAt), Date.parse(l.new.startAt)]),
          );
          if (deadline <= (await now(tx)) || Date.parse(amendment.expiresAt) <= (await now(tx)))
            throw new TennisAmendmentError("AMENDMENT_EXPIRED");
          await tx.query(
            "UPDATE tennis.order_amendments SET status='AWAITING_PAYMENT',hold_until=$1 WHERE tenant_id=$2 AND id=$3",
            [new Date(deadline), actor.tenantId, amendment.id],
          );
        } else await applyAmendmentInTransaction(tx, actor.tenantId, amendment.id);
        await recordTenantAudit(tx, actor, "amendment.confirm", amendment.id, {
          orderId: order.id,
          approvedRefundCents: refund,
        });
        return { amendmentId: amendment.id };
      },
    );
    return amendmentInTransaction(tx, actor.tenantId, result.amendmentId);
  });
}
export async function releaseAmendmentInTransaction(
  tx: pg.PoolClient,
  tenantId: string,
  id: string,
  status: "CANCELLED" | "EXPIRED",
): Promise<void> {
  const amendment = await amendmentInTransaction(tx, tenantId, id);
  if (!["QUOTED", "AWAITING_PAYMENT"].includes(amendment.status)) return;
  const payments = (
    await tx.query<{ id: string }>(
      "SELECT id FROM tennis.payment_attempts WHERE tenant_id=$1 AND amendment_id=$2 AND status='PENDING' ORDER BY id FOR UPDATE",
      [tenantId, id],
    )
  ).rows;
  for (const payment of payments) {
    await settleWalletReservation(tx, tenantId, amendment.customerId, payment.id, false);
    await tx.query("UPDATE tennis.payment_attempts SET status=$1 WHERE tenant_id=$2 AND id=$3", [
      status,
      tenantId,
      payment.id,
    ]);
  }
  await tx.query(
    "UPDATE tennis.occupancies SET released_at=clock_timestamp(),revision=revision+1 WHERE tenant_id=$1 AND amendment_id=$2 AND released_at IS NULL",
    [tenantId, id],
  );
  await tx.query("UPDATE tennis.order_amendments SET status=$1,hold_until=NULL WHERE tenant_id=$2 AND id=$3", [
    status,
    tenantId,
    id,
  ]);
  await recordTenantAudit(tx, { tenantId, subjectId: "system:tennis" }, "amendment.release", id, {
    status,
    orderId: amendment.orderId,
  });
}
export async function expireVenueAmendments(tx: pg.PoolClient, tenantId: string, venueId: string): Promise<string[]> {
  const due = (
    await tx.query<{ id: string; order_id: string }>(
      "SELECT id,order_id FROM tennis.order_amendments WHERE tenant_id=$1 AND venue_id=$2 AND status='AWAITING_PAYMENT' AND hold_until<=clock_timestamp() ORDER BY order_id,id",
      [tenantId, venueId],
    )
  ).rows;
  for (const row of due) {
    await tx.query("SELECT id FROM tennis.orders WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [tenantId, row.order_id]);
    await releaseAmendmentInTransaction(tx, tenantId, row.id, "EXPIRED");
  }
  return due.map((r) => r.id);
}
export async function expireDueAmendments(db: pg.Pool, limit = 100): Promise<string[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new TennisAmendmentError("INVALID_AMENDMENT");
  const venues = (
    await db.query<{ tenant_id: string; venue_id: string }>(
      "SELECT DISTINCT tenant_id,venue_id FROM tennis.order_amendments WHERE status='AWAITING_PAYMENT' AND hold_until<=clock_timestamp() ORDER BY tenant_id,venue_id LIMIT $1",
      [limit],
    )
  ).rows;
  const result: string[] = [];
  for (const venue of venues) {
    const tx = await db.connect();
    try {
      await tx.query("BEGIN");
      await lockTenantTransactions(tx, venue.tenant_id);
      await tx.query("SELECT id FROM tennis.venues WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [
        venue.tenant_id,
        venue.venue_id,
      ]);
      result.push(...(await expireVenueAmendments(tx, venue.tenant_id, venue.venue_id)));
      await tx.query("COMMIT");
    } catch (error) {
      await tx.query("ROLLBACK");
      throw error;
    } finally {
      tx.release();
    }
  }
  return result;
}
export async function getOrderAmendment(db: pg.Pool, actor: BookingActor, id: string): Promise<AmendmentRecord> {
  return withBookingTransaction(db, actor, async (tx) => {
    const { venueId } = await locateAmendment(tx, actor, id);
    await expireVenueAmendments(tx, actor.tenantId, venueId);
    return amendmentInTransaction(tx, actor.tenantId, id);
  });
}
export async function cancelOrderAmendment(
  db: pg.Pool,
  actor: TenantActor,
  input: { amendmentId: string; commandKey: string; reason: string },
): Promise<AmendmentRecord> {
  employee(actor);
  if (!input.reason.trim() || input.reason.length > 2000) throw new TennisAmendmentError("INVALID_AMENDMENT");
  return withBookingTransaction(db, actor, async (tx) => {
    const { venueId, orderId } = await locateAmendment(tx, actor, input.amendmentId, "book");
    await orderInTransaction(tx, actor, orderId);
    const { commandKey, ...request } = input;
    await idempotentCommand(tx, actor, venueId, commandKey, "amendment.cancel", request, async () => {
      const amendment = await amendmentInTransaction(tx, actor.tenantId, input.amendmentId);
      if (amendment.status === "APPLIED") throw new TennisAmendmentError("AMENDMENT_NOT_CANCELLABLE");
      await releaseAmendmentInTransaction(tx, actor.tenantId, amendment.id, "CANCELLED");
      await recordTenantAudit(tx, actor, "amendment.cancel", amendment.id, {
        reason: input.reason.trim(),
      });
      return { amendmentId: amendment.id };
    });
    return amendmentInTransaction(tx, actor.tenantId, input.amendmentId);
  });
}
export async function beginAmendmentPayment(
  db: pg.Pool,
  actor: BookingActor,
  gateway: PaymentProviderPort,
  input: {
    amendmentId: string;
    walletCents: number;
    commandKey: string;
    staffReason?: string;
  },
): Promise<PaymentRecord> {
  assertCents(input.walletCents);
  return withBookingTransaction(db, actor, async (tx) => {
    const { venueId, orderId } = await locateAmendment(tx, actor, input.amendmentId, "book");
    if (!isCustomerActor(actor) && input.walletCents > 0) {
      await requireBookingVenue(tx, actor, venueId, "manage_members");
      if (!input.staffReason?.trim() || input.staffReason.length > 2000)
        throw new TennisAmendmentError("INVALID_AMENDMENT");
    }
    await expireVenueAmendments(tx, actor.tenantId, venueId);
    const { commandKey, ...request } = input;
    const result = await idempotentCommand(tx, actor, venueId, commandKey, "amendment.payment", request, async () => {
      const order = await orderInTransaction(tx, actor, orderId);
      const amendment = await amendmentInTransaction(tx, actor.tenantId, input.amendmentId);
      await requireCustomer(tx, actor, amendment.customerId);
      if (
        amendment.status !== "AWAITING_PAYMENT" ||
        order.revision !== amendment.baseRevision ||
        input.walletCents > amendment.supplementalCents
      )
        throw new TennisAmendmentError("AMENDMENT_NOT_PAYABLE");
      if (
        (
          await tx.query(
            "SELECT id FROM tennis.payment_attempts WHERE tenant_id=$1 AND order_id=$2 AND status='PENDING'",
            [actor.tenantId, orderId],
          )
        ).rowCount
      )
        throw new TennisAmendmentError("ORDER_AMENDMENT_PENDING");
      const id = randomUUID(),
        external = amendment.supplementalCents - input.walletCents;
      const binding = external > 0 ? await resolvePaymentMerchant(tx, actor.tenantId, gateway) : null;
      await tx.query(
        `INSERT INTO tennis.payment_attempts(id,tenant_id,venue_id,customer_id,order_id,amendment_id,provider,merchant_id,external_cents,wallet_cents,status,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'PENDING',$11)`,
        [
          id,
          actor.tenantId,
          venueId,
          amendment.customerId,
          orderId,
          amendment.id,
          binding?.provider ?? "WALLET",
          binding?.merchantId ?? `wallet:${actor.tenantId}`,
          external,
          input.walletCents,
          actor.subjectId,
        ],
      );
      await reserveWallet(tx, actor.tenantId, amendment.customerId, id, input.walletCents);
      if (Date.parse(amendment.holdUntil!) <= (await now(tx))) throw new TennisAmendmentError("AMENDMENT_EXPIRED");
      if (binding)
        await enqueuePaymentChannel(tx, {
          tenantId: actor.tenantId,
          sourceKind: "ORDER",
          sourceId: id,
          binding,
          amountCents: external,
          expiresAt: amendment.holdUntil!,
        });
      if (!external) {
        await settleWalletReservation(tx, actor.tenantId, amendment.customerId, id, true);
        await tx.query(
          "UPDATE tennis.payment_attempts SET status='SUCCEEDED',settled_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",
          [actor.tenantId, id],
        );
        await applyAmendmentInTransaction(tx, actor.tenantId, amendment.id);
      }
      await recordTenantAudit(tx, actor, "amendment.payment", id, {
        amendmentId: amendment.id,
        walletCents: input.walletCents,
        externalCents: external,
        staffReason: input.staffReason ?? null,
      });
      return { paymentId: id };
    });
    return paymentInTransaction(tx, actor.tenantId, result.paymentId);
  });
}
/** Recovery after a browser/session interruption: always read current amendments for the authorized order. */
export async function listOrderAmendments(
  db: pg.Pool,
  actor: BookingActor,
  orderId: string,
): Promise<AmendmentRecord[]> {
  return withBookingTransaction(db, actor, async (tx) => {
    const venueId = await locateOrder(tx, actor, orderId);
    await requireBookingVenue(tx, actor, venueId, "read");
    await expireVenueAmendments(tx, actor.tenantId, venueId);
    const rows = (
      await tx.query<{ id: string }>(
        "SELECT id FROM tennis.order_amendments WHERE tenant_id=$1 AND order_id=$2 ORDER BY created_at DESC,id LIMIT 100",
        [actor.tenantId, orderId],
      )
    ).rows;
    const records: AmendmentRecord[] = [];
    for (const row of rows) records.push(await amendmentInTransaction(tx, actor.tenantId, row.id));
    return records;
  });
}
