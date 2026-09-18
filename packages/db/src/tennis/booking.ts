import { bookingPolicyInTransaction } from "./booking-policy.ts";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { assertDelegation } from "./agent-guard.ts";
import type { CourtInterval } from "../../../domain/src/court-interval.ts";
import type { CourtPrice } from "../../../domain/src/tennis-pricing.ts";
import { recordTenantAudit, requireVenuePermission, TenantAccessError, type TenantPermission } from "./access.ts";
import { priceSelectionInTransaction, type PricedSelection } from "./catalog.ts";
import { isCustomerActor, requireCustomer, withBookingTransaction, type BookingActor } from "./customers.ts";
import { CourtInventoryError } from "./inventory.ts";
import { idempotentCommand, requestHash } from "./receipts.ts";
import { lockTenantTransactions } from "./transaction-locks.ts";
import { assertNoPendingAmendment, expireVenueAmendments } from "./amendments.ts";
import { releasePendingPayments } from "./payment-lifecycle.ts";

export class TennisBookingError extends Error {
  constructor(
    readonly code:
      | "QUOTE_EXPIRED"
      | "QUOTE_ALREADY_USED"
      | "PAST_INTERVAL"
      | "INVALID_HOLD"
      | "INVALID_REASON"
      | "ORDER_REQUIRES_REFUND"
      | "ORDER_NOT_CANCELLABLE"
      | "STALE_ORDER",
  ) {
    super(code);
    this.name = "TennisBookingError";
  }
}
export interface QuoteRecord {
  paymentHoldMinutes: number;
  id: string;
  venueId: string;
  customerId: string;
  createdBy: string;
  price: PricedSelection;
  expiresAt: string;
  createdAt: string;
}
export interface OrderLine extends CourtInterval {
  id: string;
  courtId: string;
  amountCents: number;
  price: CourtPrice;
  cancelledAt: string | null;
}
export interface OrderRecord {
  id: string;
  venueId: string;
  customerId: string;
  quoteId: string;
  createdBy: string;
  status: "HELD" | "CONFIRMED" | "EXPIRED" | "CANCELLED" | "COMPLETED";
  paymentStatus: "UNPAID" | "PAID" | "PARTIALLY_REFUNDED" | "REFUNDED" | "NOT_REQUIRED";
  totalCents: number;
  currency: "CNY";
  holdKind: "PAYMENT" | "STAFF";
  holdUntil: string | null;
  holdReason: string | null;
  revision: number;
  price: PricedSelection;
  createdAt: string;
  lines: OrderLine[];
}
type QuoteRow = Omit<QuoteRecord, "expiresAt" | "createdAt"> & { expiresAt: Date; createdAt: Date };
type OrderRow = Omit<OrderRecord, "holdUntil" | "createdAt" | "lines"> & { holdUntil: Date | null; createdAt: Date };
type LineRow = Omit<OrderLine, "startAt" | "endAt" | "cancelledAt"> & {
  startAt: Date;
  endAt: Date;
  cancelledAt: Date | null;
};
const quoteColumns = `id,venue_id AS "venueId",customer_id AS "customerId",created_by AS "createdBy",
  payment_hold_minutes AS "paymentHoldMinutes",price_snapshot AS price,expires_at AS "expiresAt",created_at AS "createdAt"`;
const orderColumns = `id,venue_id AS "venueId",customer_id AS "customerId",quote_id AS "quoteId",created_by AS "createdBy",status,
  payment_status AS "paymentStatus",total_cents::float8 AS "totalCents",currency,hold_kind AS "holdKind",hold_until AS "holdUntil",
  hold_reason AS "holdReason",revision,price_snapshot AS price,created_at AS "createdAt"`;

/** Every order command locks the venue before orders/quotes and inventory. */
export async function requireBookingVenue(
  tx: pg.PoolClient,
  actor: BookingActor,
  venueId: string,
  permission: TenantPermission,
): Promise<void> {
  await assertDelegation(tx, actor, venueId);
  if (!isCustomerActor(actor)) return requireVenuePermission(tx, actor, venueId, permission, "update");
  if (permission !== "read" && permission !== "book") throw new TenantAccessError("TENANT_ACCESS_DENIED");
  const result = await tx.query("SELECT id FROM tennis.venues WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [
    actor.tenantId,
    venueId,
  ]);
  if (result.rowCount !== 1) throw new TenantAccessError("RESOURCE_NOT_FOUND");
}
async function databaseTime(tx: pg.PoolClient): Promise<number> {
  return (await tx.query<{ time: Date }>("SELECT clock_timestamp() AS time")).rows[0]!.time.getTime();
}
function ownCustomer(actor: BookingActor, customerId: string): void {
  if (isCustomerActor(actor) && actor.customerId !== customerId) throw new TenantAccessError("RESOURCE_NOT_FOUND");
}
async function quoteInTransaction(tx: pg.PoolClient, actor: BookingActor, id: string): Promise<QuoteRow> {
  const row = (
    await tx.query<QuoteRow>(`SELECT ${quoteColumns} FROM tennis.quotes WHERE tenant_id=$1 AND id=$2`, [
      actor.tenantId,
      id,
    ])
  ).rows[0];
  if (!row || row.createdBy !== actor.subjectId) throw new TenantAccessError("RESOURCE_NOT_FOUND");
  ownCustomer(actor, row.customerId);
  return row;
}
/** Authorize and hold the venue lock before calling this internal reader. */
export async function orderInTransaction(tx: pg.PoolClient, actor: BookingActor, id: string): Promise<OrderRecord> {
  const row = (
    await tx.query<OrderRow>(`SELECT ${orderColumns} FROM tennis.orders WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [
      actor.tenantId,
      id,
    ])
  ).rows[0];
  if (!row) throw new TenantAccessError("RESOURCE_NOT_FOUND");
  ownCustomer(actor, row.customerId);
  const lines = (
    await tx.query<LineRow>(
      `SELECT id,court_id AS "courtId",start_at AS "startAt",end_at AS "endAt",
    amount_cents::float8 AS "amountCents",price_snapshot AS price,cancelled_at AS "cancelledAt"
    FROM tennis.order_lines WHERE tenant_id=$1 AND order_id=$2 ORDER BY position`,
      [actor.tenantId, id],
    )
  ).rows;
  return {
    ...row,
    holdUntil: row.holdUntil?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    lines: lines.map((line) => ({
      ...line,
      startAt: line.startAt.toISOString(),
      endAt: line.endAt.toISOString(),
      cancelledAt: line.cancelledAt?.toISOString() ?? null,
    })),
  };
}
export async function locateOrder(tx: pg.PoolClient, actor: BookingActor, id: string): Promise<string> {
  const row = (
    await tx.query<{ venue_id: string; customer_id: string }>(
      "SELECT venue_id,customer_id FROM tennis.orders WHERE tenant_id=$1 AND id=$2",
      [actor.tenantId, id],
    )
  ).rows[0];
  if (!row) throw new TenantAccessError("RESOURCE_NOT_FOUND");
  ownCustomer(actor, row.customer_id);
  return row.venue_id;
}
async function available(
  tx: pg.PoolClient,
  actor: BookingActor,
  lines: readonly (CourtInterval & { courtId: string })[],
): Promise<void> {
  const now = await databaseTime(tx);
  if (lines.some((line) => Date.parse(line.startAt) <= now)) throw new TennisBookingError("PAST_INTERVAL");
  for (const line of [...lines].sort(
    (a, b) => a.courtId.localeCompare(b.courtId) || a.startAt.localeCompare(b.startAt),
  )) {
    const conflict = await tx.query(
      `SELECT id FROM tennis.occupancies WHERE tenant_id=$1 AND court_id=$2
      AND released_at IS NULL AND start_at<$4 AND end_at>$3 LIMIT 1`,
      [actor.tenantId, line.courtId, line.startAt, line.endAt],
    );
    if (conflict.rowCount) throw new CourtInventoryError("INVENTORY_CONFLICT");
  }
}
export async function releaseOrderInventory(tx: pg.PoolClient, tenantId: string, orderId: string): Promise<void> {
  await tx.query(
    `UPDATE tennis.occupancies SET released_at=clock_timestamp(),revision=revision+1
    WHERE tenant_id=$1 AND released_at IS NULL AND order_line_id IN
    (SELECT id FROM tennis.order_lines WHERE tenant_id=$1 AND order_id=$2)`,
    [tenantId, orderId],
  );
}
/** Internal lifecycle operation, also valid for suspended tenants. Caller holds venue lock. */
export async function expireVenueHolds(tx: pg.PoolClient, tenantId: string, venueId: string): Promise<string[]> {
  await expireVenueAmendments(tx, tenantId, venueId);
  const due = await tx.query<{ id: string }>(
    `SELECT id FROM tennis.orders WHERE tenant_id=$1 AND venue_id=$2
    AND status='HELD' AND hold_until<=clock_timestamp() ORDER BY id FOR UPDATE`,
    [tenantId, venueId],
  );
  for (const row of due.rows) {
    await releasePendingPayments(tx, tenantId, row.id, "EXPIRED");
    await releaseOrderInventory(tx, tenantId, row.id);
    await tx.query(
      `UPDATE tennis.orders SET status='EXPIRED',hold_until=NULL,revision=revision+1,updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND id=$2`,
      [tenantId, row.id],
    );
    await recordTenantAudit(tx, { tenantId, subjectId: "system:tennis" }, "order.expire", row.id);
  }
  return due.rows.map((row) => row.id);
}
/** Run from the local worker; a bounded batch supports safe retries. */
export async function expireDueOrders(db: pg.Pool, limit = 100): Promise<string[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new TennisBookingError("INVALID_HOLD");
  const venues = await db.query<{ tenant_id: string; venue_id: string }>(
    `SELECT DISTINCT tenant_id,venue_id FROM tennis.orders
    WHERE status='HELD' AND hold_until<=clock_timestamp() ORDER BY tenant_id,venue_id LIMIT $1`,
    [limit],
  );
  const expired: string[] = [];
  for (const venue of venues.rows) {
    const tx = await db.connect();
    try {
      await tx.query("BEGIN");
      await lockTenantTransactions(tx, venue.tenant_id);
      await tx.query("SELECT id FROM tennis.venues WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [
        venue.tenant_id,
        venue.venue_id,
      ]);
      expired.push(...(await expireVenueHolds(tx, venue.tenant_id, venue.venue_id)));
      await tx.query("COMMIT");
    } catch (error) {
      await tx.query("ROLLBACK");
      throw error;
    } finally {
      tx.release();
    }
  }
  return expired;
}

export async function createQuote(
  db: pg.Pool,
  actor: BookingActor,
  input: {
    venueId: string;
    customerId: string;
    lines: readonly (CourtInterval & { courtId: string })[];
  },
): Promise<QuoteRecord> {
  return withBookingTransaction(db, actor, async (tx) => {
    await requireBookingVenue(tx, actor, input.venueId, "book");
    await requireCustomer(tx, actor, input.customerId);
    await expireVenueHolds(tx, actor.tenantId, input.venueId);
    const policy = await bookingPolicyInTransaction(tx, actor.tenantId);
    const price = await priceSelectionInTransaction(tx, actor, input.venueId, input.lines);
    await available(tx, actor, price.lines);
    const id = randomUUID();
    const row = (
      await tx.query<QuoteRow>(
        `INSERT INTO tennis.quotes (id,tenant_id,venue_id,customer_id,created_by,price_snapshot,expires_at,payment_hold_minutes)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb,clock_timestamp()+$7*interval '1 minute',$8) RETURNING ${quoteColumns}`,
        [id, actor.tenantId, input.venueId, input.customerId, actor.subjectId, JSON.stringify(price), policy.quoteMinutes, policy.paymentHoldMinutes],
      )
    ).rows[0]!;
    await recordTenantAudit(tx, actor, "quote.create", id, {
      customerId: input.customerId,
      totalCents: price.totalCents,
      venueId: input.venueId,
    });
    return { ...row, expiresAt: row.expiresAt.toISOString(), createdAt: row.createdAt.toISOString() };
  });
}
export interface StaffHold {
  until: string;
  reason: string;
}
function confirmationRequest(quoteId: string, staffHold?: StaffHold): { quoteId: string; staffHold: StaffHold | null } {
  if (!staffHold) return { quoteId, staffHold: null };
  const time = Date.parse(staffHold.until);
  if (!Number.isFinite(time) || !staffHold.reason.trim() || staffHold.reason.length > 2000)
    throw new TennisBookingError("INVALID_HOLD");
  return { quoteId, staffHold: { until: new Date(time).toISOString(), reason: staffHold.reason.trim() } };
}
export async function confirmQuote(
  db: pg.Pool,
  actor: BookingActor,
  input: { quoteId: string; commandKey: string; staffHold?: StaffHold },
): Promise<OrderRecord> {
  const request = confirmationRequest(input.quoteId, input.staffHold);
  try {
    return await withBookingTransaction(db, actor, async (tx) => {
      const quote = await quoteInTransaction(tx, actor, input.quoteId);
      await requireBookingVenue(tx, actor, quote.venueId, "book");
      if (request.staffHold) await requireBookingVenue(tx, actor, quote.venueId, "hold_unpaid");
      await requireCustomer(tx, actor, quote.customerId);
      await expireVenueHolds(tx, actor.tenantId, quote.venueId);
      const result = await idempotentCommand(
        tx,
        actor,
        quote.venueId,
        input.commandKey,
        "quote.confirm",
        request,
        async () => {
          const existing = (
            await tx.query<{ id: string; confirmation_request: unknown }>(
              "SELECT id,confirmation_request FROM tennis.orders WHERE tenant_id=$1 AND quote_id=$2",
              [actor.tenantId, quote.id],
            )
          ).rows[0];
          if (existing) {
            if (requestHash(existing.confirmation_request) !== requestHash(request))
              throw new TennisBookingError("QUOTE_ALREADY_USED");
            return { orderId: existing.id };
          }
          if (quote.expiresAt.getTime() <= (await databaseTime(tx))) throw new TennisBookingError("QUOTE_EXPIRED");
          // Current opening/asset rules must still permit sale. Keep the saved quote's prices.
          await priceSelectionInTransaction(tx, actor, quote.venueId, quote.price.lines);
          await available(tx, actor, quote.price.lines);
          const now = await databaseTime(tx);
          if (quote.expiresAt.getTime() <= now) throw new TennisBookingError("QUOTE_EXPIRED");
          const until = request.staffHold ? Date.parse(request.staffHold.until) : now + quote.paymentHoldMinutes * 60_000;
          if (until <= now) throw new TennisBookingError("INVALID_HOLD");
          const id = randomUUID();
          const free = quote.price.totalCents === 0;
          await tx.query(
            `INSERT INTO tennis.orders (id,tenant_id,venue_id,customer_id,quote_id,created_by,status,payment_status,total_cents,
          hold_kind,hold_until,hold_reason,confirmation_request,price_snapshot)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb)`,
            [
              id,
              actor.tenantId,
              quote.venueId,
              quote.customerId,
              quote.id,
              actor.subjectId,
              free ? "CONFIRMED" : "HELD",
              free ? "NOT_REQUIRED" : "UNPAID",
              quote.price.totalCents,
              request.staffHold ? "STAFF" : "PAYMENT",
              free ? null : new Date(until),
              request.staffHold?.reason ?? null,
              JSON.stringify(request),
              JSON.stringify(quote.price),
            ],
          );
          for (const [position, line] of quote.price.lines.entries()) {
            const lineId = randomUUID();
            await tx.query(
              `INSERT INTO tennis.order_lines (id,tenant_id,venue_id,order_id,court_id,position,start_at,end_at,amount_cents,initial_funding_cents,price_snapshot)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10::jsonb)`,
              [
                lineId,
                actor.tenantId,
                quote.venueId,
                id,
                line.courtId,
                position,
                line.startAt,
                line.endAt,
                line.totalCents,
                JSON.stringify(line),
              ],
            );
            await tx.query(
              `INSERT INTO tennis.occupancies (id,tenant_id,court_id,kind,source_id,start_at,end_at,order_line_id)
            VALUES ($1,$2,$3,'BOOKING',$4,$5,$6,$7)`,
              [randomUUID(), actor.tenantId, line.courtId, id, line.startAt, line.endAt, lineId],
            );
          }
          await recordTenantAudit(tx, actor, "order.create", id, {
            quoteId: quote.id,
            totalCents: quote.price.totalCents,
            holdKind: request.staffHold ? "STAFF" : "PAYMENT",
          });
          return { orderId: id };
        },
      );
      return orderInTransaction(tx, actor, result.orderId);
    });
  } catch (error) {
    if ((error as { code?: string }).code === "23P01") throw new CourtInventoryError("INVENTORY_CONFLICT");
    throw error;
  }
}
export async function getOrder(db: pg.Pool, actor: BookingActor, id: string): Promise<OrderRecord> {
  return withBookingTransaction(db, actor, async (tx) => {
    const venueId = await locateOrder(tx, actor, id);
    await requireBookingVenue(tx, actor, venueId, "read");
    await expireVenueHolds(tx, actor.tenantId, venueId);
    return orderInTransaction(tx, actor, id);
  });
}
export async function listOrders(db: pg.Pool, actor: BookingActor, venueId: string): Promise<OrderRecord[]> {
  return withBookingTransaction(db, actor, async (tx) => {
    await requireBookingVenue(tx, actor, venueId, "read");
    await expireVenueHolds(tx, actor.tenantId, venueId);
    const ids = await tx.query<{ id: string }>(
      `SELECT id FROM tennis.orders WHERE tenant_id=$1 AND venue_id=$2
      AND ($3::text IS NULL OR customer_id=$3) ORDER BY created_at DESC,id LIMIT 100`,
      [actor.tenantId, venueId, isCustomerActor(actor) ? actor.customerId : null],
    );
    const orders: OrderRecord[] = [];
    for (const row of ids.rows) orders.push(await orderInTransaction(tx, actor, row.id));
    return orders;
  });
}
export async function getCommandReceipt(
  db: pg.Pool,
  actor: BookingActor,
  key: string,
): Promise<{
  commandType: string;
  result: Record<string, unknown>;
  completedAt: string;
} | null> {
  return withBookingTransaction(db, actor, async (tx) => {
    const row = (
      await tx.query<{ venue_id: string; command_type: string; result: Record<string, unknown>; completed_at: Date }>(
        `SELECT venue_id,command_type,result,completed_at
      FROM tennis.command_receipts WHERE tenant_id=$1 AND subject_id=$2 AND command_key=$3 AND completed_at IS NOT NULL`,
        [actor.tenantId, actor.subjectId, key],
      )
    ).rows[0];
    if (!row) return null;
    await requireBookingVenue(tx, actor, row.venue_id, "read");
    if (isCustomerActor(actor)) {
      // A subject may also have an employee role. Switching to customer context
      // must not reveal their earlier staff commands for other customers.
      let customerId: string | undefined;
      if (typeof row.result.orderId === "string")
        customerId = (
          await tx.query<{ customer_id: string }>(
            "SELECT customer_id FROM tennis.orders WHERE tenant_id=$1 AND id=$2",
            [actor.tenantId, row.result.orderId],
          )
        ).rows[0]?.customer_id;
      else if (typeof row.result.paymentId === "string")
        customerId = (
          await tx.query<{ customer_id: string }>(
            "SELECT customer_id FROM tennis.payment_attempts WHERE tenant_id=$1 AND id=$2",
            [actor.tenantId, row.result.paymentId],
          )
        ).rows[0]?.customer_id;
      else if (typeof row.result.topupId === "string")
        customerId = (
          await tx.query<{ customer_id: string }>(
            "SELECT customer_id FROM tennis.topup_payments WHERE tenant_id=$1 AND id=$2",
            [actor.tenantId, row.result.topupId],
          )
        ).rows[0]?.customer_id;
      else if (typeof row.result.refundId === "string")
        customerId = (
          await tx.query<{ customer_id: string }>(
            "SELECT customer_id FROM tennis.refunds WHERE tenant_id=$1 AND id=$2",
            [actor.tenantId, row.result.refundId],
          )
        ).rows[0]?.customer_id;
      else if (typeof row.result.amendmentId === "string")
        customerId = (
          await tx.query<{ customer_id: string }>(
            "SELECT customer_id FROM tennis.order_amendments WHERE tenant_id=$1 AND id=$2",
            [actor.tenantId, row.result.amendmentId],
          )
        ).rows[0]?.customer_id;
      else if (typeof row.result.refundGroupId === "string")
        customerId = (
          await tx.query<{ customer_id: string }>(
            "SELECT customer_id FROM tennis.refund_groups WHERE tenant_id=$1 AND id=$2",
            [actor.tenantId, row.result.refundGroupId],
          )
        ).rows[0]?.customer_id;
      else if (typeof row.result.batchId === "string")
        customerId = (
          await tx.query<{ customer_id: string }>(
            "SELECT customer_id FROM tennis.wallet_batches WHERE tenant_id=$1 AND id=$2",
            [actor.tenantId, row.result.batchId],
          )
        ).rows[0]?.customer_id;
      if (customerId !== actor.customerId) return null;
    }
    return { commandType: row.command_type, result: row.result, completedAt: row.completed_at.toISOString() };
  });
}
/** No funds move here. Paid changes require the separate authorized refund workflow. */
export async function cancelUnpaidOrder(
  db: pg.Pool,
  actor: BookingActor,
  input: { orderId: string; commandKey: string; expectedRevision: number; reason: string },
): Promise<OrderRecord> {
  if (!input.reason.trim() || input.reason.length > 2000) throw new TennisBookingError("INVALID_REASON");
  return withBookingTransaction(db, actor, async (tx) => {
    const venueId = await locateOrder(tx, actor, input.orderId);
    await requireBookingVenue(tx, actor, venueId, "book");
    await expireVenueHolds(tx, actor.tenantId, venueId);
    const { commandKey, ...request } = input;
    const result = await idempotentCommand(tx, actor, venueId, commandKey, "order.cancel_unpaid", request, async () => {
      const order = await orderInTransaction(tx, actor, input.orderId);
      if (order.status === "CANCELLED" || order.status === "EXPIRED") return { orderId: order.id };
      await assertNoPendingAmendment(tx, actor.tenantId, order.id);
      if (order.revision !== input.expectedRevision) throw new TennisBookingError("STALE_ORDER");
      if (order.paymentStatus !== "UNPAID" && order.paymentStatus !== "NOT_REQUIRED")
        throw new TennisBookingError("ORDER_REQUIRES_REFUND");
      if (order.status !== "HELD" && !(order.status === "CONFIRMED" && order.paymentStatus === "NOT_REQUIRED"))
        throw new TennisBookingError("ORDER_NOT_CANCELLABLE");
      await releasePendingPayments(tx, actor.tenantId, order.id, "CANCELLED");
      await releaseOrderInventory(tx, actor.tenantId, order.id);
      await tx.query(
        "UPDATE tennis.order_lines SET cancelled_at=clock_timestamp() WHERE tenant_id=$1 AND order_id=$2 AND cancelled_at IS NULL",
        [actor.tenantId, order.id],
      );
      await tx.query(
        "UPDATE tennis.orders SET status='CANCELLED',hold_until=NULL,revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",
        [actor.tenantId, order.id],
      );
      await recordTenantAudit(tx, actor, "order.cancel_unpaid", order.id, { reason: input.reason.trim() });
      return { orderId: order.id };
    });
    return orderInTransaction(tx, actor, result.orderId);
  });
}

/** Authorized staff can cancel individual free lines without inventing a payment/refund record. */
export async function cancelFreeOrderLines(
  db: pg.Pool,
  actor: BookingActor,
  input: { orderId: string; expectedRevision: number; lineIds: readonly string[]; commandKey: string; reason: string },
): Promise<OrderRecord> {
  if (isCustomerActor(actor)) throw new TenantAccessError("TENANT_ACCESS_DENIED");
  if (
    !input.reason.trim() ||
    input.reason.length > 2000 ||
    !input.lineIds.length ||
    input.lineIds.length > 100 ||
    input.lineIds.some((id) => typeof id !== "string" || !id) ||
    new Set(input.lineIds).size !== input.lineIds.length
  )
    throw new TennisBookingError("INVALID_REASON");
  return withBookingTransaction(db, actor, async (tx) => {
    const venueId = await locateOrder(tx, actor, input.orderId);
    await requireBookingVenue(tx, actor, venueId, "book");
    await expireVenueHolds(tx, actor.tenantId, venueId);
    const { commandKey, ...request } = input;
    const result = await idempotentCommand(
      tx,
      actor,
      venueId,
      commandKey,
      "order.cancel_free_lines",
      request,
      async () => {
        const order = await orderInTransaction(tx, actor, input.orderId);
        if (order.revision !== input.expectedRevision) throw new TennisBookingError("STALE_ORDER");
        await assertNoPendingAmendment(tx, actor.tenantId, order.id);
        if (order.totalCents !== 0 || !["NOT_REQUIRED", "REFUNDED"].includes(order.paymentStatus))
          throw new TennisBookingError("ORDER_REQUIRES_REFUND");
        if (
          order.status !== "CONFIRMED" ||
          input.lineIds.some((id) => !order.lines.some((l) => l.id === id && !l.cancelledAt))
        )
          throw new TennisBookingError("ORDER_NOT_CANCELLABLE");
        await tx.query(
          "UPDATE tennis.order_lines SET cancelled_at=clock_timestamp() WHERE tenant_id=$1 AND order_id=$2 AND id=ANY($3::text[])",
          [actor.tenantId, order.id, input.lineIds],
        );
        await tx.query(
          "UPDATE tennis.occupancies SET released_at=clock_timestamp(),revision=revision+1 WHERE tenant_id=$1 AND order_line_id=ANY($2::text[]) AND released_at IS NULL",
          [actor.tenantId, input.lineIds],
        );
        await tx.query(
          `UPDATE tennis.orders SET status=CASE WHEN NOT EXISTS(SELECT 1 FROM tennis.order_lines WHERE tenant_id=$1 AND order_id=$2 AND cancelled_at IS NULL) THEN 'CANCELLED' ELSE status END,
        revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2`,
          [actor.tenantId, order.id],
        );
        await recordTenantAudit(tx, actor, "order.cancel_free_lines", order.id, {
          lineIds: input.lineIds,
          reason: input.reason.trim(),
        });
        return { orderId: order.id };
      },
    );
    return orderInTransaction(tx, actor, result.orderId);
  });
}
