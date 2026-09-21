import { randomUUID } from "node:crypto";
import type pg from "pg";
import { getActiveMerchantBinding, type MerchantBindingSnapshot } from "./merchant-bindings.ts";
import type { PaymentPortInput, PaymentProviderPort, RefundPortInput } from "./payment-port.ts";
import { requestHash } from "./receipts.ts";

export class PaymentChannelError extends Error {
  constructor(
    readonly code:
      | "CHANNEL_NOT_READY"
      | "CHANNEL_RESULT_UNKNOWN"
      | "INVALID_CHANNEL_EVENT"
      | "CHANNEL_REQUEST_CONFLICT"
      | "CHANNEL_PROVIDER_UNAVAILABLE",
  ) {
    super(code);
  }
}
export function merchantSnapshot(binding: MerchantBindingSnapshot): MerchantBindingSnapshot {
  const { id, tenantId, version, provider, merchantId, appId, credentialRef } = binding;
  return { id, tenantId, version, provider, merchantId, appId, credentialRef };
}
export async function resolvePaymentMerchant(
  tx: pg.PoolClient,
  tenantId: string,
  gateway: PaymentProviderPort,
): Promise<MerchantBindingSnapshot> {
  return merchantSnapshot(
    await getActiveMerchantBinding(tx, tenantId, gateway.provider, {
      allowLocalMockDefault: gateway.simulation && gateway.provider === "MOCK",
    }),
  );
}
export async function enqueuePaymentChannel(
  tx: pg.PoolClient,
  input: {
    tenantId: string;
    sourceKind: "ORDER" | "TOPUP";
    sourceId: string;
    binding: MerchantBindingSnapshot;
    amountCents: number;
    expiresAt: string;
  },
): Promise<void> {
  const id = randomUUID();
  const request: PaymentPortInput = {
    binding: merchantSnapshot(input.binding),
    operationId: id,
    merchantOrderNo: input.sourceId.replaceAll("-", ""),
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    amountCents: input.amountCents,
    currency: "CNY",
    expiresAt: input.expiresAt,
  };
  await tx.query(
    `INSERT INTO tennis.channel_operations(id,tenant_id,source_kind,source_id,binding_id,provider,request,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
    [
      id,
      input.tenantId,
      input.sourceKind,
      input.sourceId,
      input.binding.id,
      input.binding.provider,
      JSON.stringify(request),
      requestHash(request),
    ],
  );
}
/** Legacy local receipts retain their original merchant, including after platform rotation. */
async function originalBinding(
  tx: pg.PoolClient,
  tenantId: string,
  provider: "MOCK" | "WECHAT",
  merchantId: string,
): Promise<MerchantBindingSnapshot> {
  const existing = (
    await tx.query<MerchantBindingSnapshot>(
      `SELECT id,tenant_id AS "tenantId",version,provider,merchant_id AS "merchantId",app_id AS "appId",credential_ref AS "credentialRef" FROM tennis.payment_merchant_bindings WHERE tenant_id=$1 AND provider=$2 AND merchant_id=$3 ORDER BY version DESC LIMIT 1`,
      [tenantId, provider, merchantId],
    )
  ).rows[0];
  if (existing) return merchantSnapshot(existing);
  if (provider !== "MOCK" || process.env.NODE_ENV === "production") throw new PaymentChannelError("CHANNEL_NOT_READY");
  const binding = (
    await tx.query<MerchantBindingSnapshot>(
      `INSERT INTO tennis.payment_merchant_bindings(id,tenant_id,version,provider,merchant_id,active) SELECT $1,$2,coalesce(max(version),0)+1,'MOCK',$3,false FROM tennis.payment_merchant_bindings WHERE tenant_id=$2 AND provider='MOCK' RETURNING id,tenant_id AS "tenantId",version,provider,merchant_id AS "merchantId",app_id AS "appId",credential_ref AS "credentialRef"`,
      [randomUUID(), tenantId, merchantId],
    )
  ).rows[0]!;
  return merchantSnapshot(binding);
}
interface RefundFunding {
  refundId: string;
  source_kind: "ORDER" | "TOPUP";
  source_id: string;
  provider: "MOCK" | "WECHAT";
  merchant_id: string;
  transaction_id: string;
  amountCents: number;
  originalPaymentCents: number;
}
async function refundOperationExists(
  tx: pg.PoolClient, tenantId: string, kind: "REFUND" | "EXCEPTION_REFUND", refundId: string,
): Promise<boolean> {
  return Boolean((await tx.query(
    "SELECT 1 FROM tennis.channel_operations WHERE tenant_id=$1 AND source_kind=$2 AND source_id=$3 LIMIT 1",
    [tenantId, kind, refundId],
  )).rowCount);
}
/** Read the exact authenticated channel capture. Current order totals and remaining refundable amounts are irrelevant. */
async function refundFunding(
  tx: pg.PoolClient, tenantId: string, kind: "REFUND" | "EXCEPTION_REFUND", refundId: string,
): Promise<RefundFunding> {
  const query = kind === "REFUND"
    ? `SELECT 'ORDER'::text AS source_kind,p.id AS source_id,p.provider,p.merchant_id,
        p.provider_transaction_id AS transaction_id,r.external_cents AS refund_cents,
        p.external_cents AS expected_cents,c.amount_cents AS original_payment_cents
      FROM tennis.refunds r JOIN tennis.payment_attempts p ON p.tenant_id=r.tenant_id AND p.id=r.payment_id
      JOIN tennis.channel_transactions c ON c.provider=p.provider AND c.merchant_id=p.merchant_id
        AND c.transaction_id=p.provider_transaction_id AND c.tenant_id=p.tenant_id AND c.source_type='ORDER' AND c.source_id=p.id
      WHERE r.tenant_id=$1 AND r.id=$2`
    : `SELECT r.source_kind,r.source_id,r.provider,r.merchant_id,r.transaction_id,
        r.amount_cents AS refund_cents,r.amount_cents AS expected_cents,c.amount_cents AS original_payment_cents
      FROM tennis.exception_refunds r JOIN tennis.channel_transactions c
        ON c.provider=r.provider AND c.merchant_id=r.merchant_id AND c.transaction_id=r.transaction_id
        AND c.tenant_id=r.tenant_id AND c.source_type=r.source_kind AND c.source_id=r.source_id
      WHERE r.tenant_id=$1 AND r.id=$2`;
  const row = (await tx.query<Omit<RefundFunding, "refundId" | "amountCents" | "originalPaymentCents"> & {
    refund_cents: string; expected_cents: string; original_payment_cents: string;
  }>(query, [tenantId, refundId])).rows[0];
  if (!row) throw new PaymentChannelError("CHANNEL_NOT_READY");
  const amountCents = Number(row.refund_cents), originalPaymentCents = Number(row.original_payment_cents);
  if (!["MOCK", "WECHAT"].includes(row.provider) || !row.transaction_id ||
    !Number.isSafeInteger(amountCents) || amountCents <= 0 ||
    !Number.isSafeInteger(originalPaymentCents) || originalPaymentCents < amountCents ||
    originalPaymentCents !== Number(row.expected_cents)) throw new PaymentChannelError("CHANNEL_REQUEST_CONFLICT");
  return { ...row, refundId, amountCents, originalPaymentCents };
}
function checkRefundBinding(binding: MerchantBindingSnapshot, tenantId: string, funding: RefundFunding): void {
  if (!binding || binding.tenantId !== tenantId || binding.provider !== funding.provider || binding.merchantId !== funding.merchant_id)
    throw new PaymentChannelError("CHANNEL_REQUEST_CONFLICT");
}
/** Only a new, explicitly authorized retry receives missing facts; never repair a contradictory old snapshot. */
function retryRefundTotal(input: RefundPortInput, tenantId: string, funding: RefundFunding): number {
  checkRefundBinding(input.binding, tenantId, funding);
  if (input.refundId !== funding.refundId || input.sourceId !== funding.source_id || input.transactionId !== funding.transaction_id ||
    input.amountCents !== funding.amountCents || input.currency !== "CNY" ||
    (input.originalPaymentCents !== undefined && input.originalPaymentCents !== funding.originalPaymentCents))
    throw new PaymentChannelError("CHANNEL_REQUEST_CONFLICT");
  return funding.originalPaymentCents;
}
export async function enqueueRefundChannel(tx: pg.PoolClient, tenantId: string, refundId: string): Promise<void> {
  if (await refundOperationExists(tx, tenantId, "REFUND", refundId)) return;
  const source = await refundFunding(tx, tenantId, "REFUND", refundId);
  const original = (
    await tx.query<{ request: PaymentPortInput }>(
      `SELECT request FROM tennis.channel_operations WHERE tenant_id=$1 AND source_kind='ORDER' AND source_id=$2`,
      [tenantId, source.source_id],
    )
  ).rows[0]?.request;
  const binding = original?.binding ?? (await originalBinding(tx, tenantId, source.provider, source.merchant_id));
  checkRefundBinding(binding, tenantId, source);
  const id = randomUUID();
  const request: RefundPortInput = {
    binding,
    operationId: id,
    merchantOrderNo: original?.merchantOrderNo ?? source.source_id.replaceAll("-", ""),
    sourceId: source.source_id,
    transactionId: source.transaction_id,
    merchantRefundNo: refundId.replaceAll("-", ""),
    refundId,
    amountCents: source.amountCents,
    originalPaymentCents: source.originalPaymentCents,
    currency: "CNY",
  };
  await tx.query(
    `INSERT INTO tennis.channel_operations(id,tenant_id,source_kind,source_id,binding_id,provider,request,request_hash) VALUES($1,$2,'REFUND',$3,$4,$5,$6::jsonb,$7) ON CONFLICT(tenant_id,source_kind,source_id,generation) DO NOTHING`,
    [id, tenantId, refundId, binding.id, binding.provider, JSON.stringify(request), requestHash(request)],
  );
}
export async function retryRefundChannel(tx: pg.PoolClient, tenantId: string, refundId: string): Promise<void> {
  await enqueueRefundChannel(tx, tenantId, refundId);
  const op = (
    await tx.query<{ id: string; state: string; generation: number; request: RefundPortInput }>(
      `SELECT id,state,generation,request FROM tennis.channel_operations WHERE tenant_id=$1 AND source_kind='REFUND' AND source_id=$2 ORDER BY generation DESC LIMIT 1 FOR UPDATE`,
      [tenantId, refundId],
    )
  ).rows[0]!;
  const legacyFailure =
    op.state === "READY" &&
    Boolean(
      (
        await tx.query(
          `SELECT 1 FROM tennis.refund_events WHERE tenant_id=$1 AND refund_id=$2 AND payload->>'status'='FAILED'`,
          [tenantId, refundId],
        )
      ).rowCount,
    );
  if (op.state !== "FAILED" && !legacyFailure) throw new PaymentChannelError("CHANNEL_RESULT_UNKNOWN");
  if (legacyFailure) await tx.query(`UPDATE tennis.channel_operations SET state='FAILED' WHERE id=$1`, [op.id]);
  const id = randomUUID();
  const funding = await refundFunding(tx, tenantId, "REFUND", refundId);
  const request: RefundPortInput = {
    ...op.request, originalPaymentCents: retryRefundTotal(op.request, tenantId, funding),
    operationId: id, merchantRefundNo: id.replaceAll("-", ""),
  };
  await tx.query(
    `INSERT INTO tennis.channel_operations(id,tenant_id,source_kind,source_id,generation,binding_id,provider,request,request_hash) VALUES($1,$2,'REFUND',$3,$4,$5,$6,$7::jsonb,$8)`,
    [
      id,
      tenantId,
      refundId,
      op.generation + 1,
      request.binding.id,
      request.binding.provider,
      JSON.stringify(request),
      requestHash(request),
    ],
  );
}

/** On-demand upgrade for pre-port local MOCK intents; never invent a real merchant mapping. */
export async function ensureLegacyPaymentChannel(
  tx: pg.PoolClient,
  tenantId: string,
  kind: "ORDER" | "TOPUP",
  sourceId: string,
): Promise<void> {
  if (
    (
      await tx.query(`SELECT 1 FROM tennis.channel_operations WHERE tenant_id=$1 AND source_kind=$2 AND source_id=$3`, [
        tenantId,
        kind,
        sourceId,
      ])
    ).rowCount
  )
    return;
  const query =
    kind === "ORDER"
      ? `SELECT p.provider,p.merchant_id,p.external_cents::float8 AS amount,p.created_at,coalesce(m.hold_until,o.hold_until,p.created_at+interval '10 minutes') AS expires_at FROM tennis.payment_attempts p JOIN tennis.orders o ON o.tenant_id=p.tenant_id AND o.id=p.order_id LEFT JOIN tennis.order_amendments m ON m.tenant_id=p.tenant_id AND m.id=p.amendment_id WHERE p.tenant_id=$1 AND p.id=$2`
      : `SELECT provider,merchant_id,principal_cents::float8 AS amount,created_at,created_at+interval '10 minutes' AS expires_at FROM tennis.topup_payments WHERE tenant_id=$1 AND id=$2`;
  const source = (
    await tx.query<{ provider: string; merchant_id: string; amount: number; expires_at: Date }>(query, [
      tenantId,
      sourceId,
    ])
  ).rows[0];
  if (!source || source.provider !== "MOCK" || process.env.NODE_ENV === "production" || source.amount <= 0)
    throw new PaymentChannelError("CHANNEL_NOT_READY");
  const binding = await originalBinding(tx, tenantId, "MOCK", source.merchant_id);
  await enqueuePaymentChannel(tx, {
    tenantId,
    sourceKind: kind,
    sourceId,
    binding,
    amountCents: source.amount,
    expiresAt: source.expires_at.toISOString(),
  });
}

/** Cash-only compensation keeps the exact capture that did not fund an order or wallet. */
export async function enqueueExceptionRefundChannel(
  tx: pg.PoolClient,
  tenantId: string,
  refundId: string,
): Promise<void> {
  if (await refundOperationExists(tx, tenantId, "EXCEPTION_REFUND", refundId)) return;
  const source = await refundFunding(tx, tenantId, "EXCEPTION_REFUND", refundId);
  const original = (
    await tx.query<{ request: PaymentPortInput }>(
      `SELECT request FROM tennis.channel_operations WHERE tenant_id=$1 AND source_kind=$2 AND source_id=$3 ORDER BY generation DESC LIMIT 1`,
      [tenantId, source.source_kind, source.source_id],
    )
  ).rows[0]?.request;
  const binding = original?.binding ?? (await originalBinding(tx, tenantId, source.provider, source.merchant_id));
  checkRefundBinding(binding, tenantId, source);
  const id = randomUUID();
  const request: RefundPortInput = {
    binding,
    operationId: id,
    merchantOrderNo: original?.merchantOrderNo ?? source.source_id.replaceAll("-", ""),
    sourceId: source.source_id,
    transactionId: source.transaction_id,
    merchantRefundNo: refundId.replaceAll("-", ""),
    refundId,
    amountCents: source.amountCents,
    originalPaymentCents: source.originalPaymentCents,
    currency: "CNY",
  };
  await tx.query(
    `INSERT INTO tennis.channel_operations(id,tenant_id,source_kind,source_id,binding_id,provider,request,request_hash) VALUES($1,$2,'EXCEPTION_REFUND',$3,$4,$5,$6::jsonb,$7) ON CONFLICT(tenant_id,source_kind,source_id,generation) DO NOTHING`,
    [id, tenantId, refundId, binding.id, binding.provider, JSON.stringify(request), requestHash(request)],
  );
}
export async function retryExceptionRefundChannel(
  tx: pg.PoolClient,
  tenantId: string,
  refundId: string,
): Promise<void> {
  const op = (
    await tx.query<{ state: string; generation: number; request: RefundPortInput }>(
      `SELECT state,generation,request FROM tennis.channel_operations WHERE tenant_id=$1 AND source_kind='EXCEPTION_REFUND' AND source_id=$2 ORDER BY generation DESC LIMIT 1 FOR UPDATE`,
      [tenantId, refundId],
    )
  ).rows[0];
  if (!op || op.state !== "FAILED") throw new PaymentChannelError("CHANNEL_RESULT_UNKNOWN");
  const id = randomUUID();
  const funding = await refundFunding(tx, tenantId, "EXCEPTION_REFUND", refundId);
  const request: RefundPortInput = {
    ...op.request, originalPaymentCents: retryRefundTotal(op.request, tenantId, funding),
    operationId: id, merchantRefundNo: id.replaceAll("-", ""),
  };
  await tx.query(
    `INSERT INTO tennis.channel_operations(id,tenant_id,source_kind,source_id,generation,binding_id,provider,request,request_hash) VALUES($1,$2,'EXCEPTION_REFUND',$3,$4,$5,$6,$7::jsonb,$8)`,
    [
      id,
      tenantId,
      refundId,
      op.generation + 1,
      request.binding.id,
      request.binding.provider,
      JSON.stringify(request),
      requestHash(request),
    ],
  );
}
