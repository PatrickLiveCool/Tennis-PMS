import { randomUUID } from "node:crypto";
import type pg from "pg";
import { recordTenantAudit, requireTenantPermission, TenantAccessError, type TenantActor } from "./access.ts";
import { requireBookingVenue } from "./booking.ts";
import { isCustomerActor, requireCustomer, withBookingTransaction, type BookingActor } from "./customers.ts";
import { enqueueExceptionRefundChannel, retryExceptionRefundChannel } from "./channel-intents.ts";
import { claimCashRefundTransaction } from "./channel-refunds.ts";
import { isVerifiedRefundEvent, refundEventSemanticHash, type VerifiedRefundEvent } from "./payment-port.ts";
import { idempotentCommand } from "./receipts.ts";
import { lockTenantTransactions } from "./transaction-locks.ts";

export class TennisExceptionRefundError extends Error {
  constructor(
    readonly code:
      | "INVALID_EXCEPTION_REFUND"
      | "EXCEPTION_NOT_REFUNDABLE"
      | "INVALID_REFUND_EVENT"
      | "REFUND_EVENT_REUSED"
      | "REFUND_NOT_RETRYABLE",
  ) {
    super(code);
    this.name = "TennisExceptionRefundError";
  }
}
export interface ExceptionRefundRecord {
  id: string;
  tenantId: string;
  venueId: string;
  customerId: string;
  sourceKind: "ORDER" | "TOPUP";
  sourceId: string;
  exceptionId: string;
  provider: "MOCK" | "WECHAT";
  merchantId: string;
  transactionId: string;
  amountCents: number;
  status: "REQUESTED" | "PROCESSING" | "SUCCEEDED" | "FAILED";
  reason: string;
  providerRefundId: string | null;
  createdAt: string;
  completedAt: string | null;
}
export interface CashExceptionRecord {
  id: string;
  sourceKind: "ORDER" | "TOPUP";
  sourceId: string;
  orderId: string | null;
  tenantId: string;
  venueId: string;
  customerId: string;
  provider: "MOCK" | "WECHAT";
  merchantId: string;
  transactionId: string;
  amountCents: number;
  status: "OPEN" | "RESOLVED";
  kind: string;
  createdAt: string;
  refund: ExceptionRefundRecord | null;
}
type RefundRow = Omit<ExceptionRefundRecord, "createdAt" | "completedAt"> & {
  createdAt: Date;
  completedAt: Date | null;
};
const refundColumns = `id,tenant_id AS "tenantId",venue_id AS "venueId",customer_id AS "customerId",
  source_kind AS "sourceKind",source_id AS "sourceId",exception_id AS "exceptionId",provider,
  merchant_id AS "merchantId",transaction_id AS "transactionId",amount_cents::float8 AS "amountCents",
  status,reason,provider_refund_id AS "providerRefundId",created_at AS "createdAt",completed_at AS "completedAt"`;
async function refundInTransaction(tx: pg.PoolClient, tenantId: string, id: string): Promise<ExceptionRefundRecord> {
  const row = (
    await tx.query<RefundRow>(
      `SELECT ${refundColumns} FROM tennis.exception_refunds WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
      [tenantId, id],
    )
  ).rows[0];
  if (!row) throw new TenantAccessError("RESOURCE_NOT_FOUND");
  return { ...row, createdAt: row.createdAt.toISOString(), completedAt: row.completedAt?.toISOString() ?? null };
}
type ExceptionSource = Omit<CashExceptionRecord, "amountCents" | "refund" | "createdAt" | "provider"> & {
  provider: string;
  createdAt: Date;
  sourceStatus: string;
  originalTransactionId: string | null;
  expectedAmountCents: number;
};
/** Read verified channel cash, never the display-only exception details JSON. */
async function cashExceptionInTransaction(
  tx: pg.PoolClient,
  tenantId: string,
  id: string,
): Promise<CashExceptionRecord> {
  const sources = (
    await tx.query<ExceptionSource>(
      `SELECT x.id,'ORDER' AS "sourceKind",p.id AS "sourceId",p.order_id AS "orderId",x.tenant_id AS "tenantId",
      p.venue_id AS "venueId",p.customer_id AS "customerId",p.provider,p.merchant_id AS "merchantId",
      x.external_transaction_id AS "transactionId",x.status,x.kind,x.created_at AS "createdAt",
      p.status AS "sourceStatus",p.provider_transaction_id AS "originalTransactionId",p.external_cents::float8 AS "expectedAmountCents"
      FROM tennis.financial_exceptions x JOIN tennis.payment_attempts p ON p.tenant_id=x.tenant_id AND p.id=x.payment_id
      WHERE x.tenant_id=$1 AND x.id=$2
    UNION ALL
    SELECT x.id,'TOPUP',p.id,NULL,x.tenant_id,p.venue_id,p.customer_id,p.provider,p.merchant_id,
      x.external_transaction_id,x.status,'EXTRA_TOPUP_RECEIPT',x.created_at,p.status,p.provider_transaction_id,p.principal_cents::float8
      FROM tennis.topup_exceptions x JOIN tennis.topup_payments p ON p.tenant_id=x.tenant_id AND p.id=x.topup_id
      WHERE x.tenant_id=$1 AND x.id=$2`,
      [tenantId, id],
    )
  ).rows;
  if (sources.length !== 1) throw new TenantAccessError("RESOURCE_NOT_FOUND");
  const source = sources[0]!;
  if (
    (source.provider !== "MOCK" && source.provider !== "WECHAT") ||
    !source.originalTransactionId ||
    (source.kind === "LATE_PAYMENT" &&
      (source.sourceStatus !== "REFUND_REQUIRED" || source.transactionId !== source.originalTransactionId)) ||
    (source.kind === "DUPLICATE_PAYMENT" &&
      (!["SUCCEEDED", "REFUND_REQUIRED"].includes(source.sourceStatus) ||
        source.transactionId === source.originalTransactionId)) ||
    (source.kind === "EXTRA_TOPUP_RECEIPT" &&
      (source.sourceStatus !== "SUCCEEDED" || source.transactionId === source.originalTransactionId))
  )
    throw new TennisExceptionRefundError("EXCEPTION_NOT_REFUNDABLE");
  const cash = (
    await tx.query<{ tenant_id: string; source_type: string; source_id: string; amount_cents: string }>(
      `SELECT tenant_id,source_type,source_id,amount_cents FROM tennis.channel_transactions
      WHERE provider=$1 AND merchant_id=$2 AND transaction_id=$3`,
      [source.provider, source.merchantId, source.transactionId],
    )
  ).rows[0];
  const amountCents = Number(cash?.amount_cents);
  if (
    !cash ||
    cash.tenant_id !== tenantId ||
    cash.source_type !== source.sourceKind ||
    cash.source_id !== source.sourceId ||
    !Number.isSafeInteger(amountCents) ||
    amountCents <= 0 ||
    amountCents !== source.expectedAmountCents
  )
    throw new TennisExceptionRefundError("EXCEPTION_NOT_REFUNDABLE");
  const refundId = (
    await tx.query<{ id: string }>(`SELECT id FROM tennis.exception_refunds WHERE tenant_id=$1 AND exception_id=$2`, [
      tenantId,
      id,
    ])
  ).rows[0]?.id;
  return {
    id: source.id,
    sourceKind: source.sourceKind,
    sourceId: source.sourceId,
    orderId: source.orderId,
    tenantId: source.tenantId,
    venueId: source.venueId,
    customerId: source.customerId,
    provider: source.provider,
    merchantId: source.merchantId,
    transactionId: source.transactionId,
    amountCents,
    status: source.status,
    kind: source.kind,
    createdAt: source.createdAt.toISOString(),
    refund: refundId ? await refundInTransaction(tx, tenantId, refundId) : null,
  };
}
async function authorizeStaff(tx: pg.PoolClient, actor: BookingActor, venueId?: string, write = false): Promise<void> {
  if (isCustomerActor(actor)) throw new TenantAccessError("TENANT_ACCESS_DENIED");
  await requireTenantPermission(tx, actor, "manage_members", venueId);
  if (venueId) await requireBookingVenue(tx, actor, venueId, "manage_members");
  if (write) await requireTenantPermission(tx, actor, "refund", venueId);
}
export async function getCashException(
  db: pg.Pool,
  actor: BookingActor,
  exceptionId: string,
): Promise<CashExceptionRecord> {
  return withBookingTransaction(db, actor, async (tx) => {
    await authorizeStaff(tx, actor);
    const exception = await cashExceptionInTransaction(tx, actor.tenantId, exceptionId);
    await authorizeStaff(tx, actor, exception.venueId);
    return exception;
  });
}
export async function requestExceptionRefund(
  db: pg.Pool,
  actor: TenantActor,
  input: { exceptionId: string; amountCents: number; reason: string; commandKey: string },
): Promise<ExceptionRefundRecord> {
  if (
    !Number.isSafeInteger(input.amountCents) ||
    input.amountCents <= 0 ||
    typeof input.reason !== "string" ||
    !input.reason.trim() ||
    input.reason.length > 2000
  )
    throw new TennisExceptionRefundError("INVALID_EXCEPTION_REFUND");
  return withBookingTransaction(db, actor, async (tx) => {
    await authorizeStaff(tx, actor);
    const exception = await cashExceptionInTransaction(tx, actor.tenantId, input.exceptionId);
    await authorizeStaff(tx, actor, exception.venueId, true);
    if (input.amountCents !== exception.amountCents) throw new TennisExceptionRefundError("INVALID_EXCEPTION_REFUND");
    const receipt = await idempotentCommand(
      tx,
      actor,
      exception.venueId,
      input.commandKey,
      "exception_refund.request",
      { exceptionId: input.exceptionId, amountCents: input.amountCents, reason: input.reason },
      async () => {
        // A second operator may safely recover the same refund after a lost response.
        if (exception.refund) return { refundId: exception.refund.id };
        if (exception.status !== "OPEN") throw new TennisExceptionRefundError("EXCEPTION_NOT_REFUNDABLE");
        const id = randomUUID();
        await tx.query(
          `INSERT INTO tennis.exception_refunds(id,tenant_id,venue_id,customer_id,source_kind,source_id,exception_id,
            order_exception_id,topup_exception_id,provider,merchant_id,transaction_id,amount_cents,status,reason,created_by)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'REQUESTED',$14,$15)`,
          [
            id,
            actor.tenantId,
            exception.venueId,
            exception.customerId,
            exception.sourceKind,
            exception.sourceId,
            exception.id,
            exception.sourceKind === "ORDER" ? exception.id : null,
            exception.sourceKind === "TOPUP" ? exception.id : null,
            exception.provider,
            exception.merchantId,
            exception.transactionId,
            exception.amountCents,
            input.reason.trim(),
            actor.subjectId,
          ],
        );
        await enqueueExceptionRefundChannel(tx, actor.tenantId, id);
        await recordTenantAudit(tx, actor, "exception_refund.request", id, {
          exceptionId: exception.id,
          amountCents: exception.amountCents,
          reason: input.reason.trim(),
        });
        return { refundId: id };
      },
    );
    return refundInTransaction(tx, actor.tenantId, receipt.refundId);
  });
}
export async function getExceptionRefund(db: pg.Pool, actor: BookingActor, id: string): Promise<ExceptionRefundRecord> {
  return withBookingTransaction(db, actor, async (tx) => {
    if (!isCustomerActor(actor)) await authorizeStaff(tx, actor);
    const refund = await refundInTransaction(tx, actor.tenantId, id);
    if (isCustomerActor(actor)) {
      await requireCustomer(tx, actor, refund.customerId);
      await requireBookingVenue(tx, actor, refund.venueId, "read");
    } else await authorizeStaff(tx, actor, refund.venueId);
    return refund;
  });
}
export async function retryExceptionRefund(
  db: pg.Pool,
  actor: TenantActor,
  id: string,
  commandKey: string,
): Promise<ExceptionRefundRecord> {
  return withBookingTransaction(db, actor, async (tx) => {
    await authorizeStaff(tx, actor);
    const refund = await refundInTransaction(tx, actor.tenantId, id);
    await authorizeStaff(tx, actor, refund.venueId, true);
    await idempotentCommand(
      tx,
      actor,
      refund.venueId,
      commandKey,
      "exception_refund.retry",
      { refundId: id },
      async () => {
        if (refund.status !== "FAILED") throw new TennisExceptionRefundError("REFUND_NOT_RETRYABLE");
        const exception = await cashExceptionInTransaction(tx, actor.tenantId, refund.exceptionId);
        if (exception.status !== "OPEN") throw new TennisExceptionRefundError("EXCEPTION_NOT_REFUNDABLE");
        await retryExceptionRefundChannel(tx, actor.tenantId, id);
        await tx.query(`UPDATE tennis.exception_refunds SET status='REQUESTED' WHERE tenant_id=$1 AND id=$2`, [
          actor.tenantId,
          id,
        ]);
        await recordTenantAudit(tx, actor, "exception_refund.retry", id, { exceptionId: refund.exceptionId });
        return { refundId: id };
      },
    );
    return refundInTransaction(tx, actor.tenantId, id);
  });
}
export async function settleVerifiedExceptionRefund(
  db: pg.Pool,
  event: VerifiedRefundEvent,
): Promise<ExceptionRefundRecord> {
  if (!isVerifiedRefundEvent(event)) throw new TennisExceptionRefundError("INVALID_REFUND_EVENT");
  const located = (
    await db.query<{ tenant_id: string; venue_id: string }>(
      `SELECT tenant_id,venue_id FROM tennis.exception_refunds WHERE id=$1`,
      [event.refundId],
    )
  ).rows[0];
  if (!located) throw new TennisExceptionRefundError("INVALID_REFUND_EVENT");
  const tenantId = located.tenant_id;
  const tx = await db.connect();
  try {
    await tx.query("BEGIN");
    await lockTenantTransactions(tx, tenantId);
    await tx.query(`SELECT id FROM tennis.venues WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [
      tenantId,
      located.venue_id,
    ]);
    const refund = await refundInTransaction(tx, tenantId, event.refundId);
    const exception = await cashExceptionInTransaction(tx, tenantId, refund.exceptionId);
    if (
      event.provider !== refund.provider ||
      event.merchantId !== refund.merchantId ||
      event.amountCents !== refund.amountCents ||
      event.currency !== "CNY" ||
      (event.transactionId !== undefined && event.transactionId !== refund.transactionId) ||
      exception.sourceKind !== refund.sourceKind ||
      exception.sourceId !== refund.sourceId ||
      exception.provider !== refund.provider ||
      exception.merchantId !== refund.merchantId ||
      exception.transactionId !== refund.transactionId ||
      exception.amountCents !== refund.amountCents ||
      exception.customerId !== refund.customerId ||
      exception.venueId !== refund.venueId
    )
      throw new TennisExceptionRefundError("INVALID_REFUND_EVENT");
    const hash = refundEventSemanticHash(event);
    const previous = (
      await tx.query<{ request_hash: string; refund_id: string; tenant_id: string }>(
        `SELECT request_hash,refund_id,tenant_id FROM tennis.exception_refund_events
        WHERE provider=$1 AND merchant_id=$2 AND event_id=$3`,
        [event.provider, event.merchantId, event.eventId],
      )
    ).rows[0];
    if (previous) {
      if (previous.request_hash !== hash || previous.refund_id !== refund.id || previous.tenant_id !== tenantId)
        throw new TennisExceptionRefundError("REFUND_EVENT_REUSED");
      await tx.query("COMMIT");
      return refund;
    }
    if (event.status === "SUCCEEDED") {
      if (refund.providerRefundId !== null && refund.providerRefundId !== event.providerRefundId)
        throw new TennisExceptionRefundError("INVALID_REFUND_EVENT");
      await claimCashRefundTransaction(tx, {
        provider: event.provider,
        merchantId: event.merchantId,
        providerRefundId: event.providerRefundId,
        tenantId,
        sourceKind: "EXCEPTION",
        sourceId: refund.id,
        amountCents: event.amountCents,
        transactionId: event.transactionId,
      });
      if (refund.status !== "SUCCEEDED") {
        await tx.query(
          `UPDATE tennis.exception_refunds SET status='SUCCEEDED',provider_refund_id=$1,completed_at=clock_timestamp()
          WHERE tenant_id=$2 AND id=$3`,
          [event.providerRefundId, tenantId, refund.id],
        );
      }
      const table = refund.sourceKind === "ORDER" ? "financial_exceptions" : "topup_exceptions";
      await tx.query(`UPDATE tennis.${table} SET status='RESOLVED' WHERE tenant_id=$1 AND id=$2`, [
        tenantId,
        refund.exceptionId,
      ]);
    } else if (refund.status !== "SUCCEEDED") {
      // Old generation failures cannot overwrite a newly requested retry, even when the observation was persisted before the retry.
      const superseded = (
        await tx.query(
          `SELECT 1 FROM tennis.channel_observations obs JOIN tennis.channel_operations old ON old.id=obs.operation_id
          WHERE obs.provider=$1 AND obs.merchant_id=$2 AND obs.event_kind='REFUND' AND obs.event_id=$3
            AND old.tenant_id=$4 AND old.source_kind='EXCEPTION_REFUND' AND old.source_id=$5
            AND EXISTS(SELECT 1 FROM tennis.channel_operations newer WHERE newer.tenant_id=old.tenant_id
              AND newer.source_kind='EXCEPTION_REFUND' AND newer.source_id=old.source_id AND newer.generation>old.generation)`,
          [event.provider, event.merchantId, event.eventId, tenantId, refund.id],
        )
      ).rowCount;
      if (!superseded)
        await tx.query(`UPDATE tennis.exception_refunds SET status='FAILED' WHERE tenant_id=$1 AND id=$2`, [
          tenantId,
          refund.id,
        ]);
    }
    await tx.query(
      `INSERT INTO tennis.exception_refund_events(provider,merchant_id,event_id,tenant_id,refund_id,request_hash,payload)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [event.provider, event.merchantId, event.eventId, tenantId, refund.id, hash, JSON.stringify(event)],
    );
    await recordTenantAudit(tx, { tenantId, subjectId: "system:tennis" }, "exception_refund.event", refund.id, {
      status: event.status,
      eventId: event.eventId,
      exceptionId: refund.exceptionId,
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
