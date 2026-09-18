import { randomUUID } from "node:crypto";
import type pg from "pg";
import { TenantAccessError } from "./access.ts";
import { requireBookingVenue } from "./booking.ts";
import { isCustomerActor, requireCustomer, withBookingTransaction, type BookingActor } from "./customers.ts";
import {
  ensureLegacyPaymentChannel,
  enqueueRefundChannel,
  enqueueExceptionRefundChannel,
  PaymentChannelError,
} from "./channel-intents.ts";
import {
  TrustedPaymentProvider,
  isVerifiedPaymentEvent,
  isVerifiedRefundEvent,
  paymentEventSemanticHash,
  refundEventSemanticHash,
  type PaymentProviderPort,
  type PaymentPortInput,
  type RefundPortInput,
  type CheckoutAction,
  type PaymentQueryResult,
  type RefundQueryResult,
  type VerifiedPaymentEvent,
  type VerifiedRefundEvent,
  type PaymentEventData,
  type RefundEventData,
  type PaymentNotificationInput,
} from "./payment-port.ts";
import { getOrderPayment, settleVerifiedPayment } from "./payments.ts";
import { getTopupPayment, settleVerifiedTopup } from "./topups.ts";
import { getRefund, settleVerifiedRefund } from "./refunds.ts";
import { getExceptionRefund, settleVerifiedExceptionRefund } from "./exception-refunds.ts";
import { LocalMockPaymentGateway } from "./mock-payments.ts";

export type ChannelSource = "ORDER" | "TOPUP" | "REFUND" | "EXCEPTION_REFUND";
function isRefundSource(kind: ChannelSource): boolean {
  return kind === "REFUND" || kind === "EXCEPTION_REFUND";
}
export type ChannelState = "READY" | "IN_FLIGHT" | "UNKNOWN" | "PENDING" | "SUCCEEDED" | "FAILED";
interface Operation {
  id: string;
  tenant_id: string;
  source_kind: ChannelSource;
  source_id: string;
  generation: number;
  provider: "MOCK" | "WECHAT";
  request: PaymentPortInput | RefundPortInput;
  state: ChannelState;
  lease_token: string | null;
  lease_until: Date | null;
  checkout: CheckoutAction | null;
  last_checked_at: Date | null;
}
export interface ChannelView {
  sourceId: string;
  operationId: string | null;
  provider: "MOCK" | "WECHAT" | "WALLET";
  simulation: boolean;
  state: ChannelState | "NOT_REQUIRED";
  checkout: CheckoutAction | null;
  lastCheckedAt: string | null;
  message: string;
  canReconcile: boolean;
}
const stateMessages: Record<ChannelState | string, string> = {
  READY: "付款渠道尚未提交。",
  IN_FLIGHT: "渠道处理中，请稍后查询原结果。",
  UNKNOWN: "尚未确认渠道结果；请查询原操作，不要重复付款。",
  PENDING: "渠道已受理，等待付款或退款结果。",
  SUCCEEDED: "渠道已确认成功。",
  FAILED: "渠道已明确失败。",
  NOT_REQUIRED: "本次无需外部渠道付款。",
};
async function readOperation(db: pg.Pool, id: string): Promise<Operation> {
  const row = (await db.query<Operation>("SELECT * FROM tennis.channel_operations WHERE id=$1", [id])).rows[0];
  if (!row) throw new TenantAccessError("RESOURCE_NOT_FOUND");
  return row;
}
async function authorize(db: pg.Pool, actor: BookingActor, kind: ChannelSource, id: string, write: boolean) {
  const source =
    kind === "ORDER"
      ? await getOrderPayment(db, actor, id)
      : kind === "TOPUP"
        ? await getTopupPayment(db, actor, id)
        : kind === "EXCEPTION_REFUND"
          ? await getExceptionRefund(db, actor, id)
          : await getRefund(db, actor, id);
  await withBookingTransaction(db, actor, async (tx) => {
    await requireCustomer(tx, actor, source.customerId);
    const permission = write
      ? isRefundSource(kind)
        ? "refund"
        : kind === "TOPUP" && !isCustomerActor(actor)
          ? "manage_members"
          : "book"
      : "read";
    if (write && isRefundSource(kind) && isCustomerActor(actor)) throw new TenantAccessError("TENANT_ACCESS_DENIED");
    await requireBookingVenue(tx, actor, source.venueId, permission);
  });
  return source;
}
export async function getPaymentChannel(
  db: pg.Pool,
  actor: BookingActor,
  kind: ChannelSource,
  id: string,
  port: PaymentProviderPort,
): Promise<ChannelView> {
  const source = await authorize(db, actor, kind, id, false);
  const op = (
    await db.query<Operation>(
      "SELECT * FROM tennis.channel_operations WHERE tenant_id=$1 AND source_kind=$2 AND source_id=$3 ORDER BY generation DESC LIMIT 1",
      [actor.tenantId, kind, id],
    )
  ).rows[0];
  let allowed = true;
  try {
    await authorize(db, actor, kind, id, true);
  } catch (error) {
    if (error instanceof TenantAccessError) allowed = false;
    else throw error;
  }
  if (!op) {
    const required =
      "principalCents" in source
        ? source.principalCents
        : "externalCents" in source
          ? source.externalCents
          : source.amountCents;
    const provider =
      "provider" in source ? source.provider : (await getOrderPayment(db, actor, source.paymentId)).provider;
    const verifiedSuccess =
      source.status === "SUCCEEDED" &&
      ("providerTransactionId" in source ? Boolean(source.providerTransactionId) : Boolean(source.providerRefundId));
    let verifiedFailure = false;
    if (source.status === "FAILED") {
      const table =
        kind === "ORDER"
          ? "payment_events"
          : kind === "TOPUP"
            ? "topup_events"
            : kind === "EXCEPTION_REFUND"
              ? "exception_refund_events"
              : "refund_events";
      const column = isRefundSource(kind) ? "refund_id" : kind === "TOPUP" ? "topup_id" : "payment_id";
      verifiedFailure = Boolean(
        (
          await db.query(
            `SELECT 1 FROM tennis.${table} WHERE tenant_id=$1 AND ${column}=$2 AND payload->>'status'='FAILED' LIMIT 1`,
            [actor.tenantId, id],
          )
        ).rowCount,
      );
    }
    const state =
      required === 0 ? "NOT_REQUIRED" : verifiedSuccess ? "SUCCEEDED" : verifiedFailure ? "FAILED" : "UNKNOWN";
    return {
      sourceId: id,
      operationId: null,
      provider,
      simulation: provider === "MOCK",
      state,
      checkout: null,
      lastCheckedAt: null,
      message:
        state === "SUCCEEDED"
          ? "历史收款或退款已有验签入账记录。"
          : state === "FAILED"
            ? "历史渠道已有验签失败记录。"
            : required
              ? "历史记录尚未建立渠道操作，可按原支付流水恢复核对。"
              : stateMessages.NOT_REQUIRED!,
      canReconcile:
        allowed && required > 0 && !verifiedSuccess && !verifiedFailure && provider === "MOCK" && port.simulation,
    };
  }
  const state = op.state === "IN_FLIGHT" && op.lease_until && op.lease_until <= new Date() ? "UNKNOWN" : op.state;
  return {
    sourceId: id,
    operationId: op.id,
    provider: op.provider,
    simulation: op.provider === "MOCK",
    state,
    checkout: state === "PENDING" ? op.checkout : null,
    lastCheckedAt: op.last_checked_at?.toISOString() ?? null,
    message: stateMessages[state]!,
    canReconcile: allowed && op.provider === port.provider && state !== "IN_FLIGHT" && state !== "SUCCEEDED",
  };
}
function validateEvent(op: Operation, event: VerifiedPaymentEvent | VerifiedRefundEvent): void {
  const input = op.request;
  const refund = isRefundSource(op.source_kind);
  if (
    (refund ? !isVerifiedRefundEvent(event) : !isVerifiedPaymentEvent(event)) ||
    event.provider !== op.provider ||
    event.merchantId !== input.binding.merchantId ||
    event.amountCents !== input.amountCents ||
    event.currency !== input.currency ||
    (refund
      ? (event as VerifiedRefundEvent).refundId !== op.source_id
      : (event as VerifiedPaymentEvent).paymentId !== op.source_id)
  )
    throw new PaymentChannelError("INVALID_CHANNEL_EVENT");
  if (refund && event.transactionId !== undefined && event.transactionId !== (input as RefundPortInput).transactionId)
    throw new PaymentChannelError("INVALID_CHANNEL_EVENT");
}
/** Only DB rows inserted after a verified adapter observation enter this private rehydrator. */
class StoredObservationReader extends TrustedPaymentProvider {
  readonly simulation = false;
  constructor(readonly provider: "MOCK" | "WECHAT") {
    super();
  }
  createPayment(): never {
    throw new Error("Stored observations cannot send payments");
  }
  queryPayment(): never {
    throw new Error("Stored observations cannot query payments");
  }
  createRefund(): never {
    throw new Error("Stored observations cannot send refunds");
  }
  queryRefund(): never {
    throw new Error("Stored observations cannot query refunds");
  }
  verifyNotification(_input: PaymentNotificationInput): never {
    throw new Error("Stored observations cannot accept notifications");
  }
  payment(payload: PaymentEventData) {
    return this.certifyPaymentEvent(payload);
  }
  refund(payload: RefundEventData) {
    return this.certifyRefundEvent(payload);
  }
}
async function applyStoredObservation(db: pg.Pool, observationId: string): Promise<void> {
  const observation = (
    await db.query<{
      operation_id: string;
      payload: PaymentEventData | RefundEventData;
      event_kind: "PAYMENT" | "REFUND";
      applied_at: Date | null;
    }>("SELECT * FROM tennis.channel_observations WHERE id=$1", [observationId])
  ).rows[0]!;
  const op = await readOperation(db, observation.operation_id);
  if (!observation.applied_at) {
    const reader = new StoredObservationReader(op.provider);
    if (observation.event_kind === "REFUND") {
      const newer = (
        await db.query(
          `SELECT 1 FROM tennis.channel_operations WHERE tenant_id=$1 AND source_kind=$4 AND source_id=$2 AND generation>$3`,
          [op.tenant_id, op.source_id, op.generation, op.source_kind],
        )
      ).rowCount;
      if (observation.payload.status !== "FAILED" || !newer) {
        const event = reader.refund(observation.payload as RefundEventData);
        if (op.source_kind === "EXCEPTION_REFUND") await settleVerifiedExceptionRefund(db, event);
        else await settleVerifiedRefund(db, event);
      }
    } else if (op.source_kind === "TOPUP")
      await settleVerifiedTopup(db, reader.payment(observation.payload as PaymentEventData));
    else await settleVerifiedPayment(db, reader.payment(observation.payload as PaymentEventData));
  }
  // Mark durable application and its visible projection atomically after the idempotent business settlement.
  const tx = await db.connect();
  try {
    await tx.query("BEGIN");
    await tx.query(
      `UPDATE tennis.channel_operations SET state=CASE WHEN state='SUCCEEDED' OR $2='SUCCEEDED' THEN 'SUCCEEDED' ELSE 'FAILED' END,checkout=NULL,lease_token=NULL,lease_until=NULL,last_checked_at=clock_timestamp(),last_error=NULL WHERE id=$1`,
      [op.id, observation.payload.status],
    );
    await tx.query("UPDATE tennis.channel_observations SET applied_at=clock_timestamp() WHERE id=$1", [observationId]);
    await tx.query("COMMIT");
  } catch (error) {
    await tx.query("ROLLBACK");
    throw error;
  } finally {
    tx.release();
  }
}
async function recordObservation(
  db: pg.Pool,
  op: Operation,
  event: VerifiedPaymentEvent | VerifiedRefundEvent,
): Promise<void> {
  validateEvent(op, event);
  const kind = isRefundSource(op.source_kind) ? "REFUND" : "PAYMENT";
  const hash =
    kind === "REFUND"
      ? refundEventSemanticHash(event as VerifiedRefundEvent)
      : paymentEventSemanticHash(event as VerifiedPaymentEvent);
  await db.query(
    `INSERT INTO tennis.channel_observations(id,operation_id,tenant_id,provider,merchant_id,event_kind,event_id,semantic_hash,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) ON CONFLICT(provider,merchant_id,event_kind,event_id) DO NOTHING`,
    [
      randomUUID(),
      op.id,
      op.tenant_id,
      event.provider,
      event.merchantId,
      kind,
      event.eventId,
      hash,
      JSON.stringify(event),
    ],
  );
  const saved = (
    await db.query<{ id: string; operation_id: string; semantic_hash: string }>(
      `SELECT id,operation_id,semantic_hash FROM tennis.channel_observations WHERE provider=$1 AND merchant_id=$2 AND event_kind=$3 AND event_id=$4`,
      [event.provider, event.merchantId, kind, event.eventId],
    )
  ).rows[0]!;
  if (saved.operation_id !== op.id || saved.semantic_hash !== hash)
    throw new PaymentChannelError("INVALID_CHANNEL_EVENT");
  await applyStoredObservation(db, saved.id);
}
async function isPayable(db: pg.Pool, op: Operation): Promise<boolean> {
  if (isRefundSource(op.source_kind))
    return Boolean(
      (
        await db.query(
          `SELECT 1 FROM tennis.${op.source_kind === "EXCEPTION_REFUND" ? "exception_refunds" : "refunds"} r WHERE tenant_id=$1 AND id=$2 AND status IN ('REQUESTED','PROCESSING') AND NOT EXISTS (SELECT 1 FROM tennis.channel_operations newer WHERE newer.tenant_id=r.tenant_id AND newer.source_kind=$4 AND newer.source_id=r.id AND newer.generation>$3)`,
          [op.tenant_id, op.source_id, op.generation, op.source_kind],
        )
      ).rowCount,
    );
  if (Date.parse((op.request as PaymentPortInput).expiresAt) <= Date.now()) return false;
  const table = op.source_kind === "ORDER" ? "payment_attempts" : "topup_payments";
  return Boolean(
    (
      await db.query(`SELECT 1 FROM tennis.${table} WHERE tenant_id=$1 AND id=$2 AND status='PENDING'`, [
        op.tenant_id,
        op.source_id,
      ])
    ).rowCount,
  );
}
/** Lease transaction ends before any provider I/O or settlement transaction begins. */
export async function reconcileChannelOperation(
  db: pg.Pool,
  port: PaymentProviderPort,
  operationId: string,
): Promise<void> {
  const replay = (
    await db.query<{ id: string }>(
      "SELECT id FROM tennis.channel_observations WHERE operation_id=$1 AND applied_at IS NULL ORDER BY created_at,id",
      [operationId],
    )
  ).rows;
  for (const item of replay) await applyStoredObservation(db, item.id);
  const token = randomUUID();
  let op: Operation;
  let priorState: ChannelState;
  const claim = await db.connect();
  try {
    await claim.query("BEGIN");
    const old = (
      await claim.query<Operation>("SELECT * FROM tennis.channel_operations WHERE id=$1 FOR UPDATE", [operationId])
    ).rows[0];
    if (!old) throw new TenantAccessError("RESOURCE_NOT_FOUND");
    if (old.provider !== port.provider) throw new PaymentChannelError("CHANNEL_PROVIDER_UNAVAILABLE");
    if (old.state === "SUCCEEDED" || (old.lease_until && old.lease_until > new Date())) {
      await claim.query("COMMIT");
      return;
    }
    priorState = old.state;
    op = (
      await claim.query<Operation>(
        `UPDATE tennis.channel_operations SET state='IN_FLIGHT',lease_token=$2,lease_until=clock_timestamp()+interval '30 seconds',attempts=attempts+1 WHERE id=$1 RETURNING *`,
        [operationId, token],
      )
    ).rows[0]!;
    await claim.query("COMMIT");
  } catch (error) {
    await claim.query("ROLLBACK");
    throw error;
  } finally {
    claim.release();
  }
  try {
    let result: PaymentQueryResult | RefundQueryResult;
    const input = op.request;
    // Every uncertain/repeated attempt queries the exact persisted merchant reference first.
    if (priorState === "READY" && (await isPayable(db, op)))
      result = isRefundSource(op.source_kind)
        ? await port.createRefund(input as RefundPortInput)
        : await port.createPayment(input as PaymentPortInput);
    else
      result = isRefundSource(op.source_kind)
        ? await port.queryRefund(input as RefundPortInput)
        : await port.queryPayment(input as PaymentPortInput);
    if (result.status === "NOT_FOUND" && (await isPayable(db, op)))
      result = isRefundSource(op.source_kind)
        ? await port.createRefund(input as RefundPortInput)
        : await port.createPayment(input as PaymentPortInput);
    if (result.status === "SUCCEEDED" || result.status === "DEFINITIVELY_FAILED")
      await recordObservation(db, op, result.event);
    else {
      const checkout = result.status === "PENDING" && "checkout" in result ? (result.checkout ?? null) : null;
      if (
        checkout &&
        (checkout.kind !== "LOCAL_SIMULATION" ||
          op.provider !== "MOCK" ||
          !port.simulation ||
          checkout.operationId !== op.id)
      )
        throw new PaymentChannelError("INVALID_CHANNEL_EVENT");
      await db.query(
        `UPDATE tennis.channel_operations SET state=$3,checkout=$4::jsonb,last_checked_at=clock_timestamp(),next_check_at=clock_timestamp()+interval '30 seconds',lease_token=NULL,lease_until=NULL,last_error=$5 WHERE id=$1 AND lease_token=$2 AND state<>'SUCCEEDED'`,
        [
          op.id,
          token,
          result.status === "PENDING" ? "PENDING" : "UNKNOWN",
          JSON.stringify(checkout),
          result.status === "UNKNOWN"
            ? "PROVIDER_RESULT_UNKNOWN"
            : result.status === "NOT_FOUND"
              ? "NO_CHANNEL_RECORD"
              : null,
        ],
      );
    }
  } catch (error) {
    await db.query(
      `UPDATE tennis.channel_operations SET state='UNKNOWN',last_error='RECONCILIATION_INCOMPLETE',next_check_at=clock_timestamp()+interval '30 seconds',lease_token=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2 AND state<>'SUCCEEDED'`,
      [op.id, token],
    );
    if (error instanceof PaymentChannelError || (error instanceof Error && "code" in error)) throw error;
    // Transport/adapter errors do not establish a financial failure.
  }
}
export async function reconcilePaymentChannel(
  db: pg.Pool,
  actor: BookingActor,
  kind: ChannelSource,
  id: string,
  port: PaymentProviderPort,
): Promise<ChannelView> {
  await authorize(db, actor, kind, id, true);
  const previous = await getPaymentChannel(db, actor, kind, id, port);
  if (
    previous.state === "SUCCEEDED" ||
    previous.state === "NOT_REQUIRED" ||
    (previous.operationId === null && previous.state === "FAILED")
  )
    return previous;
  await withBookingTransaction(db, actor, async (tx) => {
    if (kind === "EXCEPTION_REFUND") await enqueueExceptionRefundChannel(tx, actor.tenantId, id);
    else if (kind === "REFUND") await enqueueRefundChannel(tx, actor.tenantId, id);
    else await ensureLegacyPaymentChannel(tx, actor.tenantId, kind, id);
  });
  const op = (
    await db.query<{ id: string }>(
      "SELECT id FROM tennis.channel_operations WHERE tenant_id=$1 AND source_kind=$2 AND source_id=$3 ORDER BY generation DESC LIMIT 1",
      [actor.tenantId, kind, id],
    )
  ).rows[0];
  if (!op) throw new PaymentChannelError("CHANNEL_NOT_READY");
  await reconcileChannelOperation(db, port, op.id);
  return getPaymentChannel(db, actor, kind, id, port);
}
export async function simulatePaymentChannel(
  db: pg.Pool,
  actor: BookingActor,
  kind: ChannelSource,
  id: string,
  gateway: LocalMockPaymentGateway,
  status: "SUCCEEDED" | "FAILED",
): Promise<void> {
  await authorize(db, actor, kind, id, true);
  await withBookingTransaction(db, actor, async (tx) => {
    if (kind === "EXCEPTION_REFUND") await enqueueExceptionRefundChannel(tx, actor.tenantId, id);
    else if (kind === "REFUND") await enqueueRefundChannel(tx, actor.tenantId, id);
    else await ensureLegacyPaymentChannel(tx, actor.tenantId, kind, id);
  });
  const op = (
    await db.query<Operation>(
      "SELECT * FROM tennis.channel_operations WHERE tenant_id=$1 AND source_kind=$2 AND source_id=$3 ORDER BY generation DESC LIMIT 1",
      [actor.tenantId, kind, id],
    )
  ).rows[0];
  if (!op || op.provider !== "MOCK") throw new PaymentChannelError("CHANNEL_NOT_READY");
  const result = isRefundSource(kind)
    ? await gateway.simulateRefund(op.request as RefundPortInput, status)
    : await gateway.simulatePayment(op.request as PaymentPortInput, status);
  if (result.status !== "SUCCEEDED" && result.status !== "DEFINITIVELY_FAILED")
    throw new PaymentChannelError("CHANNEL_RESULT_UNKNOWN");
  await recordObservation(db, op, result.event);
}
export async function acceptPaymentNotification(
  db: pg.Pool,
  port: PaymentProviderPort,
  operationId: string,
  rawBody: string,
  headers: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const op = await readOperation(db, operationId);
  if (port.provider !== op.provider) throw new PaymentChannelError("INVALID_CHANNEL_EVENT");
  const notification = await port.verifyNotification({ binding: op.request.binding, rawBody, headers });
  if (
    notification.operationId !== op.id ||
    notification.bindingId !== op.request.binding.id ||
    notification.bindingVersion !== op.request.binding.version ||
    notification.kind !== (isRefundSource(op.source_kind) ? "REFUND" : "PAYMENT")
  )
    throw new PaymentChannelError("INVALID_CHANNEL_EVENT");
  await recordObservation(db, op, notification.event);
}
export async function processDueChannelOperations(db: pg.Pool, port: PaymentProviderPort, limit = 20): Promise<void> {
  const ids = (
    await db.query<{ id: string }>(
      `SELECT DISTINCT o.id FROM tennis.channel_operations o LEFT JOIN tennis.channel_observations v ON v.operation_id=o.id AND v.applied_at IS NULL WHERE o.provider=$1 AND o.next_check_at<=clock_timestamp() AND ((o.state NOT IN ('SUCCEEDED','FAILED') AND (o.lease_until IS NULL OR o.lease_until<=clock_timestamp())) OR v.id IS NOT NULL) ORDER BY o.id LIMIT $2`,
      [port.provider, Math.min(Math.max(limit, 1), 100)],
    )
  ).rows;
  for (const row of ids) {
    try {
      await reconcileChannelOperation(db, port, row.id);
    } catch {
      await db.query(
        `UPDATE tennis.channel_operations SET state=CASE WHEN state='SUCCEEDED' THEN state ELSE 'UNKNOWN' END,last_error='REQUIRES_RECONCILIATION',next_check_at=clock_timestamp()+interval '5 minutes',lease_token=NULL,lease_until=NULL WHERE id=$1`,
        [row.id],
      );
    }
  }
}
