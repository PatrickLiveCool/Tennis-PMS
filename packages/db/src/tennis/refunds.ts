import { randomUUID } from "node:crypto";
import type pg from "pg";
import { allocateCents, assertCents } from "../../../domain/src/tennis-pricing.ts";
import { recordTenantAudit, TenantAccessError, type TenantActor } from "./access.ts";
import { locateOrder, orderInTransaction, requireBookingVenue } from "./booking.ts";
import { withBookingTransaction, type BookingActor } from "./customers.ts";
import { isVerifiedRefundEvent, refundEventSemanticHash, type VerifiedRefundEvent } from "./payment-port.ts";
import { enqueueRefundChannel, retryRefundChannel } from "./channel-intents.ts";
import { idempotentCommand, requestHash } from "./receipts.ts";
import { lockTenantTransactions } from "./transaction-locks.ts";
import { assertNoPendingAmendment, expireVenueAmendments } from "./amendments.ts";
import { appendWalletEntry, lockWallet } from "./wallet-store.ts";

export class TennisRefundError extends Error {
  constructor(
    readonly code:
      | "INVALID_REFUND"
      | "REFUND_EXCEEDS_PAYMENT"
      | "STALE_ORDER"
      | "ORDER_NOT_REFUNDABLE"
      | "INVALID_REFUND_EVENT"
      | "REFUND_EVENT_REUSED"
      | "REFUND_NOT_RETRYABLE"
      | "USE_REFUND_GROUP",
  ) {
    super(code);
    this.name = "TennisRefundError";
  }
}
export interface RefundRecord {
  id: string;
  orderId: string;
  customerId: string;
  venueId: string;
  paymentId: string;
  amountCents: number;
  walletCents: number;
  externalCents: number;
  status: "REQUESTED" | "PROCESSING" | "SUCCEEDED" | "FAILED";
  reason: string;
  providerRefundId: string | null;
  createdAt: string;
  completedAt: string | null;
}
type RefundRow = Omit<RefundRecord, "createdAt" | "completedAt"> & { createdAt: Date; completedAt: Date | null };
const columns = `id,order_id AS "orderId",customer_id AS "customerId",venue_id AS "venueId",payment_id AS "paymentId",amount_cents::float8 AS "amountCents",
  wallet_cents::float8 AS "walletCents",external_cents::float8 AS "externalCents",status,reason,provider_refund_id AS "providerRefundId",created_at AS "createdAt",completed_at AS "completedAt"`;
async function refundInTransaction(tx: pg.PoolClient, tenantId: string, id: string): Promise<RefundRecord> {
  const row = (
    await tx.query<RefundRow>(`SELECT ${columns} FROM tennis.refunds WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [
      tenantId,
      id,
    ])
  ).rows[0];
  if (!row) throw new TenantAccessError("RESOURCE_NOT_FOUND");
  return { ...row, createdAt: row.createdAt.toISOString(), completedAt: row.completedAt?.toISOString() ?? null };
}
async function completeRefund(
  tx: pg.PoolClient,
  tenantId: string,
  refund: RefundRecord,
  providerRefundId: string | null,
): Promise<void> {
  if (refund.status === "SUCCEEDED") return;
  const allocations = (
    await tx.query<{ batchId: string; principalCents: number; giftCents: number }>(
      `SELECT batch_id AS "batchId",
    principal_cents::float8 AS "principalCents",gift_cents::float8 AS "giftCents" FROM tennis.refund_wallet_allocations
    WHERE tenant_id=$1 AND refund_id=$2 ORDER BY batch_id`,
      [tenantId, refund.id],
    )
  ).rows;
  if (allocations.length) await lockWallet(tx, tenantId, refund.customerId);
  for (const portion of allocations) {
    await tx.query(
      `UPDATE tennis.wallet_batches SET available_principal_cents=available_principal_cents+$1,available_gift_cents=available_gift_cents+$2
      WHERE tenant_id=$3 AND customer_id=$4 AND id=$5`,
      [portion.principalCents, portion.giftCents, tenantId, refund.customerId, portion.batchId],
    );
    await appendWalletEntry(tx, tenantId, refund.customerId, "REFUND", refund.id, portion);
  }
  await tx.query(
    "UPDATE tennis.refunds SET status='SUCCEEDED',provider_refund_id=$1,completed_at=clock_timestamp() WHERE tenant_id=$2 AND id=$3",
    [providerRefundId, tenantId, refund.id],
  );
  await refreshOrderPaymentStatus(tx, tenantId, refund.orderId);
}
/** Recomputed from cash history, independent of the current court price. */
export async function refreshOrderPaymentStatus(tx: pg.PoolClient, tenantId: string, orderId: string): Promise<void> {
  await tx.query(
    `UPDATE tennis.orders SET payment_status=CASE
    WHEN (SELECT coalesce(sum(wallet_cents+external_cents),0) FROM tennis.payment_attempts WHERE tenant_id=$1 AND order_id=$2 AND status='SUCCEEDED')=0
      THEN CASE WHEN total_cents=0 THEN 'NOT_REQUIRED' ELSE 'UNPAID' END
    WHEN (SELECT coalesce(sum(amount_cents),0) FROM tennis.refunds WHERE tenant_id=$1 AND order_id=$2 AND status='SUCCEEDED') >=
      (SELECT coalesce(sum(wallet_cents+external_cents),0) FROM tennis.payment_attempts WHERE tenant_id=$1 AND order_id=$2 AND status='SUCCEEDED') THEN 'REFUNDED'
    WHEN EXISTS (SELECT 1 FROM tennis.refunds WHERE tenant_id=$1 AND order_id=$2 AND status='SUCCEEDED' AND amount_cents>0) THEN 'PARTIALLY_REFUNDED'
    ELSE 'PAID' END,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2`,
    [tenantId, orderId],
  );
}
export interface RefundInput {
  orderId: string;
  expectedRevision: number;
  reason: string;
  commandKey: string;
  lines: readonly { lineId: string; refundCents: number; cancel: boolean }[];
}
export interface RefundGroupRecord {
  id: string;
  orderId: string;
  customerId: string;
  venueId: string;
  amendmentId: string | null;
  reason: string;
  amountCents: number;
  status: "REQUESTED" | "PROCESSING" | "SUCCEEDED" | "FAILED";
  refunds: RefundRecord[];
}
/** Caller holds tenant/venue/order locks. Pending/failed refunds still reserve their original amounts. */
export async function refundableLines(
  tx: pg.PoolClient,
  tenantId: string,
  orderId: string,
): Promise<Map<string, number>> {
  const rows = (
    await tx.query<{ id: string; remaining: string }>(
      `SELECT l.id,
    l.initial_funding_cents + coalesce((SELECT sum(a.funding_cap_delta_cents) FROM tennis.order_amendment_lines a
      JOIN tennis.order_amendments m ON m.tenant_id=a.tenant_id AND m.id=a.amendment_id
      WHERE a.tenant_id=l.tenant_id AND a.line_id=l.id AND m.status='APPLIED'),0)
    - coalesce((SELECT sum(r.amount_cents) FROM tennis.refund_lines r WHERE r.tenant_id=l.tenant_id AND r.order_line_id=l.id),0) AS remaining
    FROM tennis.order_lines l WHERE l.tenant_id=$1 AND l.order_id=$2`,
      [tenantId, orderId],
    )
  ).rows;
  return new Map(rows.map((row) => [row.id, Number(row.remaining)]));
}
export async function refundGroupInTransaction(
  tx: pg.PoolClient,
  tenantId: string,
  id: string,
): Promise<RefundGroupRecord> {
  const row = (
    await tx.query<Omit<RefundGroupRecord, "status" | "refunds">>(
      `SELECT id,order_id AS "orderId",customer_id AS "customerId",
    venue_id AS "venueId",amendment_id AS "amendmentId",reason,amount_cents::float8 AS "amountCents" FROM tennis.refund_groups
    WHERE tenant_id=$1 AND id=$2`,
      [tenantId, id],
    )
  ).rows[0];
  if (!row) throw new TenantAccessError("RESOURCE_NOT_FOUND");
  const ids = (
    await tx.query<{ id: string }>("SELECT id FROM tennis.refunds WHERE tenant_id=$1 AND group_id=$2 ORDER BY id", [
      tenantId,
      id,
    ])
  ).rows;
  const refunds: RefundRecord[] = [];
  for (const child of ids) refunds.push(await refundInTransaction(tx, tenantId, child.id));
  const status = refunds.every((r) => r.status === "SUCCEEDED")
    ? "SUCCEEDED"
    : refunds.some((r) => r.status === "FAILED")
      ? "FAILED"
      : refunds.some((r) => r.status === "PROCESSING" || r.status === "SUCCEEDED")
        ? "PROCESSING"
        : "REQUESTED";
  return { ...row, status, refunds };
}
function validateRefund(input: Pick<RefundInput, "reason" | "lines">): void {
  if (
    !input.reason.trim() ||
    input.reason.length > 2000 ||
    input.lines.length < 1 ||
    input.lines.length > 100 ||
    new Set(input.lines.map((l) => l.lineId)).size !== input.lines.length
  )
    throw new TennisRefundError("INVALID_REFUND");
  for (const line of input.lines) {
    assertCents(line.refundCents);
    if (typeof line.cancel !== "boolean" || (!line.cancel && line.refundCents === 0))
      throw new TennisRefundError("INVALID_REFUND");
  }
}
/** Internal group creator: caller authorizes amounts and owns the current order lock. */
export async function createRefundGroupInTransaction(
  tx: pg.PoolClient,
  actor: TenantActor,
  input: Pick<RefundInput, "orderId" | "reason" | "lines"> & { amendmentId?: string },
): Promise<string> {
  validateRefund(input);
  const order = await orderInTransaction(tx, actor, input.orderId);
  const remaining = await refundableLines(tx, actor.tenantId, order.id);
  for (const line of input.lines) {
    const original = order.lines.find((l) => l.id === line.lineId);
    if (!original || (line.cancel && original.cancelledAt)) throw new TennisRefundError("INVALID_REFUND");
    if (line.refundCents > (remaining.get(line.lineId) ?? 0)) throw new TennisRefundError("REFUND_EXCEEDS_PAYMENT");
  }
  const total = input.lines.reduce((sum, l) => sum + l.refundCents, 0);
  assertCents(total);
  const payments = (
    await tx.query<{ id: string; external_cents: string }>(
      "SELECT id,external_cents FROM tennis.payment_attempts WHERE tenant_id=$1 AND order_id=$2 AND status='SUCCEEDED' ORDER BY created_at,id FOR UPDATE",
      [actor.tenantId, order.id],
    )
  ).rows;
  if (!payments.length) throw new TennisRefundError("ORDER_NOT_REFUNDABLE");
  type Source = { paymentId: string; batchId: string | null; principal: boolean; remaining: number };
  const sources: Source[] = [];
  for (const payment of payments) {
    const wallet = (
      await tx.query<{ batch_id: string; principal: string; gift: string }>(
        `SELECT a.batch_id,
      a.principal_cents-coalesce((SELECT sum(r.principal_cents) FROM tennis.refund_wallet_allocations r JOIN tennis.refunds f ON f.tenant_id=r.tenant_id AND f.id=r.refund_id WHERE r.tenant_id=a.tenant_id AND f.payment_id=a.payment_id AND r.batch_id=a.batch_id),0) AS principal,
      a.gift_cents-coalesce((SELECT sum(r.gift_cents) FROM tennis.refund_wallet_allocations r JOIN tennis.refunds f ON f.tenant_id=r.tenant_id AND f.id=r.refund_id WHERE r.tenant_id=a.tenant_id AND f.payment_id=a.payment_id AND r.batch_id=a.batch_id),0) AS gift
      FROM tennis.wallet_allocations a WHERE a.tenant_id=$1 AND a.payment_id=$2 AND a.status='CONSUMED' ORDER BY a.batch_id`,
        [actor.tenantId, payment.id],
      )
    ).rows;
    for (const batch of wallet)
      sources.push(
        { paymentId: payment.id, batchId: batch.batch_id, principal: true, remaining: Number(batch.principal) },
        { paymentId: payment.id, batchId: batch.batch_id, principal: false, remaining: Number(batch.gift) },
      );
    const returned = Number(
      (
        await tx.query<{ total: string }>(
          "SELECT coalesce(sum(external_cents),0) AS total FROM tennis.refunds WHERE tenant_id=$1 AND payment_id=$2",
          [actor.tenantId, payment.id],
        )
      ).rows[0]!.total,
    );
    sources.push({
      paymentId: payment.id,
      batchId: null,
      principal: false,
      remaining: Number(payment.external_cents) - returned,
    });
  }
  if (total > sources.reduce((sum, s) => sum + s.remaining, 0) || sources.some((s) => s.remaining < 0))
    throw new TennisRefundError("REFUND_EXCEEDS_PAYMENT");
  const portions = allocateCents(
    total,
    sources.map((s) => s.remaining),
  );
  const groupId = randomUUID();
  await tx.query(
    `INSERT INTO tennis.refund_groups(id,tenant_id,venue_id,order_id,customer_id,amendment_id,reason,created_by,amount_cents)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      groupId,
      actor.tenantId,
      order.venueId,
      order.id,
      order.customerId,
      input.amendmentId ?? null,
      input.reason.trim(),
      actor.subjectId,
      total,
    ],
  );
  const lineRemainder = input.lines.map((l) => l.refundCents);
  const usedPayments = payments.filter((p) =>
    total === 0 ? p.id === payments[0]!.id : sources.some((s, i) => s.paymentId === p.id && portions[i]! > 0),
  );
  for (const [paymentIndex, payment] of usedPayments.entries()) {
    const owned = sources.map((s, i) => ({ ...s, amount: portions[i]! })).filter((s) => s.paymentId === payment.id);
    const amount = owned.reduce((sum, s) => sum + s.amount, 0),
      external = owned.filter((s) => s.batchId === null).reduce((sum, s) => sum + s.amount, 0);
    const refundId = randomUUID();
    await tx.query(
      `INSERT INTO tennis.refunds(id,tenant_id,venue_id,order_id,customer_id,payment_id,group_id,amount_cents,wallet_cents,external_cents,status,reason,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'REQUESTED',$11,$12)`,
      [
        refundId,
        actor.tenantId,
        order.venueId,
        order.id,
        order.customerId,
        payment.id,
        groupId,
        amount,
        amount - external,
        external,
        input.reason.trim(),
        actor.subjectId,
      ],
    );
    const batches = [...new Set(owned.filter((s) => s.batchId !== null).map((s) => s.batchId!))];
    for (const batchId of batches) {
      const principal = owned.find((s) => s.batchId === batchId && s.principal)?.amount ?? 0,
        gift = owned.find((s) => s.batchId === batchId && !s.principal)?.amount ?? 0;
      if (principal + gift)
        await tx.query(
          "INSERT INTO tennis.refund_wallet_allocations(tenant_id,customer_id,refund_id,batch_id,principal_cents,gift_cents) VALUES($1,$2,$3,$4,$5,$6)",
          [actor.tenantId, order.customerId, refundId, batchId, principal, gift],
        );
    }
    let left = amount;
    for (const [i, line] of input.lines.entries()) {
      const take = Math.min(left, lineRemainder[i]!);
      left -= take;
      lineRemainder[i]! -= take;
      // Zero cancellation still has one persistent business record; cancellation applies once below.
      if (take > 0 || (paymentIndex === 0 && line.refundCents === 0))
        await tx.query(
          "INSERT INTO tennis.refund_lines(tenant_id,refund_id,order_line_id,amount_cents,cancel_line) VALUES($1,$2,$3,$4,$5)",
          [actor.tenantId, refundId, line.lineId, take, line.cancel],
        );
    }
    if (external === 0)
      await completeRefund(tx, actor.tenantId, await refundInTransaction(tx, actor.tenantId, refundId), null);
    else await enqueueRefundChannel(tx, actor.tenantId, refundId);
  }
  for (const line of input.lines)
    if (line.cancel) {
      await tx.query("UPDATE tennis.order_lines SET cancelled_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2", [
        actor.tenantId,
        line.lineId,
      ]);
      await tx.query(
        "UPDATE tennis.occupancies SET released_at=clock_timestamp(),revision=revision+1 WHERE tenant_id=$1 AND order_line_id=$2 AND released_at IS NULL",
        [actor.tenantId, line.lineId],
      );
    }
  await tx.query(
    `UPDATE tennis.orders SET status=CASE WHEN NOT EXISTS (SELECT 1 FROM tennis.order_lines WHERE tenant_id=$1 AND order_id=$2 AND cancelled_at IS NULL) THEN 'CANCELLED' ELSE status END,
    revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2`,
    [actor.tenantId, order.id],
  );
  await recordTenantAudit(tx, actor, "refund.request", groupId, {
    orderId: order.id,
    amountCents: total,
    reason: input.reason.trim(),
    lines: input.lines,
    amendmentId: input.amendmentId ?? null,
  });
  return groupId;
}
async function requestGroup(
  db: pg.Pool,
  actor: TenantActor,
  input: RefundInput,
  legacy: boolean,
): Promise<RefundGroupRecord> {
  validateRefund(input);
  return withBookingTransaction(db, actor, async (tx) => {
    const venueId = await locateOrder(tx, actor, input.orderId);
    await requireBookingVenue(tx, actor, venueId, "refund");
    await expireVenueAmendments(tx, actor.tenantId, venueId);
    const { commandKey, ...request } = input;
    const result = await idempotentCommand(
      tx,
      actor,
      venueId,
      commandKey,
      legacy ? "order.refund" : "order.refund_group",
      request,
      async () => {
        const order = await orderInTransaction(tx, actor, input.orderId);
        if (order.revision !== input.expectedRevision) throw new TennisRefundError("STALE_ORDER");
        await assertNoPendingAmendment(tx, actor.tenantId, order.id);
        if (
          !["PAID", "PARTIALLY_REFUNDED"].includes(order.paymentStatus) &&
          !(order.paymentStatus === "REFUNDED" && input.lines.every((l) => l.cancel && l.refundCents === 0))
        )
          throw new TennisRefundError("ORDER_NOT_REFUNDABLE");
        if (
          legacy &&
          Number(
            (
              await tx.query<{ count: string }>(
                "SELECT count(*) AS count FROM tennis.payment_attempts WHERE tenant_id=$1 AND order_id=$2 AND status='SUCCEEDED'",
                [actor.tenantId, order.id],
              )
            ).rows[0]!.count,
          ) > 1
        )
          throw new TennisRefundError("USE_REFUND_GROUP");
        const groupId = await createRefundGroupInTransaction(tx, actor, input);
        const group = await refundGroupInTransaction(tx, actor.tenantId, groupId);
        return { refundGroupId: groupId, refundId: group.refunds[0]!.id };
      },
    );
    // Historical receipts predate groups; migrated groups keep their original refund ID.
    return refundGroupInTransaction(tx, actor.tenantId, result.refundGroupId ?? result.refundId);
  });
}
/** Compatibility endpoint for original single-payment callers. Multi-payment callers use the group endpoint. */
export async function requestOrderRefund(db: pg.Pool, actor: TenantActor, input: RefundInput): Promise<RefundRecord> {
  return (await requestGroup(db, actor, input, true)).refunds[0]!;
}
export async function requestOrderRefundGroup(
  db: pg.Pool,
  actor: TenantActor,
  input: RefundInput,
): Promise<RefundGroupRecord> {
  return requestGroup(db, actor, input, false);
}
export async function getRefundGroup(db: pg.Pool, actor: BookingActor, id: string): Promise<RefundGroupRecord> {
  return withBookingTransaction(db, actor, async (tx) => {
    const located = (
      await tx.query<{ order_id: string }>("SELECT order_id FROM tennis.refund_groups WHERE tenant_id=$1 AND id=$2", [
        actor.tenantId,
        id,
      ])
    ).rows[0];
    if (!located) throw new TenantAccessError("RESOURCE_NOT_FOUND");
    const venueId = await locateOrder(tx, actor, located.order_id);
    await requireBookingVenue(tx, actor, venueId, "read");
    return refundGroupInTransaction(tx, actor.tenantId, id);
  });
}
export async function getRefund(db: pg.Pool, actor: BookingActor, id: string): Promise<RefundRecord> {
  return withBookingTransaction(db, actor, async (tx) => {
    const located = (
      await tx.query<{ order_id: string }>("SELECT order_id FROM tennis.refunds WHERE tenant_id=$1 AND id=$2", [
        actor.tenantId,
        id,
      ])
    ).rows[0];
    if (!located) throw new TenantAccessError("RESOURCE_NOT_FOUND");
    const venueId = await locateOrder(tx, actor, located.order_id);
    await requireBookingVenue(tx, actor, venueId, "read");
    return refundInTransaction(tx, actor.tenantId, id);
  });
}
export async function retryFailedRefund(
  db: pg.Pool,
  actor: TenantActor,
  id: string,
  commandKey: string,
): Promise<RefundRecord> {
  return withBookingTransaction(db, actor, async (tx) => {
    const located = (
      await tx.query<{ order_id: string }>("SELECT order_id FROM tennis.refunds WHERE tenant_id=$1 AND id=$2", [
        actor.tenantId,
        id,
      ])
    ).rows[0];
    if (!located) throw new TenantAccessError("RESOURCE_NOT_FOUND");
    const venueId = await locateOrder(tx, actor, located.order_id);
    await requireBookingVenue(tx, actor, venueId, "refund");
    await idempotentCommand(tx, actor, venueId, commandKey, "refund.retry", { refundId: id }, async () => {
      const refund = await refundInTransaction(tx, actor.tenantId, id);
      if (refund.status !== "FAILED") throw new TennisRefundError("REFUND_NOT_RETRYABLE");
      await retryRefundChannel(tx, actor.tenantId, id);
      await tx.query("UPDATE tennis.refunds SET status='REQUESTED' WHERE tenant_id=$1 AND id=$2", [actor.tenantId, id]);
      await recordTenantAudit(tx, actor, "refund.retry", id);
      return { refundId: id };
    });
    return refundInTransaction(tx, actor.tenantId, id);
  });
}
export async function settleVerifiedRefund(db: pg.Pool, event: VerifiedRefundEvent): Promise<RefundRecord> {
  if (!isVerifiedRefundEvent(event)) throw new TennisRefundError("INVALID_REFUND_EVENT");
  const located = (
    await db.query<{ tenant_id: string; venue_id: string; order_id: string }>(
      "SELECT tenant_id,venue_id,order_id FROM tennis.refunds WHERE id=$1",
      [event.refundId],
    )
  ).rows[0];
  if (!located) throw new TennisRefundError("INVALID_REFUND_EVENT");
  const tenantId = located.tenant_id;
  const tx = await db.connect();
  try {
    await tx.query("BEGIN");
    await lockTenantTransactions(tx, tenantId);
    await tx.query("SELECT id FROM tennis.venues WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [
      tenantId,
      located.venue_id,
    ]);
    await tx.query("SELECT id FROM tennis.orders WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [
      tenantId,
      located.order_id,
    ]);
    const refund = await refundInTransaction(tx, tenantId, event.refundId);
    const payment = (
      await tx.query<{ provider: string; merchant_id: string; provider_transaction_id: string | null }>(
        "SELECT provider,merchant_id,provider_transaction_id FROM tennis.payment_attempts WHERE tenant_id=$1 AND id=$2",
        [tenantId, refund.paymentId],
      )
    ).rows[0]!;
    if (
      event.provider !== payment.provider ||
      event.merchantId !== payment.merchant_id ||
      (event.transactionId !== undefined && event.transactionId !== payment.provider_transaction_id) ||
      event.amountCents !== refund.externalCents ||
      event.currency !== "CNY"
    )
      throw new TennisRefundError("INVALID_REFUND_EVENT");
    const hash = refundEventSemanticHash(event);
    const existing = (
      await tx.query<{ request_hash: string }>(
        "SELECT request_hash FROM tennis.refund_events WHERE provider=$1 AND merchant_id=$2 AND event_id=$3",
        [event.provider, event.merchantId, event.eventId],
      )
    ).rows[0];
    if (existing) {
      // Preserve exact replay of legacy hashes; new observations exclude the envelope timestamp.
      if (existing.request_hash !== hash && existing.request_hash !== requestHash(event))
        throw new TennisRefundError("REFUND_EVENT_REUSED");
      await tx.query("COMMIT");
      return refund;
    }
    if (event.status === "SUCCEEDED") {
      await tx.query(
        `INSERT INTO tennis.external_refund_receipts (provider,merchant_id,provider_refund_id,tenant_id,refund_id,amount_cents)
        VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
        [event.provider, event.merchantId, event.providerRefundId, tenantId, refund.id, event.amountCents],
      );
      const claimed = (
        await tx.query<{ refund_id: string }>(
          "SELECT refund_id FROM tennis.external_refund_receipts WHERE provider=$1 AND merchant_id=$2 AND provider_refund_id=$3",
          [event.provider, event.merchantId, event.providerRefundId],
        )
      ).rows[0]!;
      if (
        claimed.refund_id !== refund.id ||
        (refund.providerRefundId !== null && refund.providerRefundId !== event.providerRefundId)
      )
        throw new TennisRefundError("INVALID_REFUND_EVENT");
      await completeRefund(tx, tenantId, refund, event.providerRefundId);
    } else if (refund.status !== "SUCCEEDED") {
      const superseded = (
        await tx.query(
          `SELECT 1 FROM tennis.channel_observations obs JOIN tennis.channel_operations old ON old.id=obs.operation_id WHERE obs.provider=$1 AND obs.merchant_id=$2 AND obs.event_kind='REFUND' AND obs.event_id=$3 AND old.tenant_id=$4 AND old.source_id=$5 AND EXISTS (SELECT 1 FROM tennis.channel_operations newer WHERE newer.tenant_id=old.tenant_id AND newer.source_kind='REFUND' AND newer.source_id=old.source_id AND newer.generation>old.generation)`,
          [event.provider, event.merchantId, event.eventId, tenantId, refund.id],
        )
      ).rowCount;
      if (!superseded)
        await tx.query("UPDATE tennis.refunds SET status='FAILED' WHERE tenant_id=$1 AND id=$2", [tenantId, refund.id]);
    }
    await tx.query(
      "INSERT INTO tennis.refund_events (provider,merchant_id,event_id,tenant_id,refund_id,request_hash,payload) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)",
      [event.provider, event.merchantId, event.eventId, tenantId, refund.id, hash, JSON.stringify(event)],
    );
    await recordTenantAudit(tx, { tenantId, subjectId: "system:tennis" }, "refund.event", refund.id, {
      status: event.status,
      eventId: event.eventId,
    });
    const result = await refundInTransaction(tx, tenantId, refund.id);
    await tx.query("COMMIT");
    return result;
  } catch (error) {
    await tx.query("ROLLBACK");
    throw error;
  } finally {
    tx.release();
  }
}
