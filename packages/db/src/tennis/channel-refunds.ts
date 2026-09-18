import type pg from "pg";

export class CashRefundTransactionError extends Error {
  readonly code = "INVALID_REFUND_EVENT";
  constructor() {
    super("INVALID_REFUND_EVENT");
    this.name = "CashRefundTransactionError";
  }
}
/** Claim a provider refund once across both ordinary and exceptional cash refunds. */
export async function claimCashRefundTransaction(
  tx: pg.PoolClient,
  input: {
    provider: "MOCK" | "WECHAT";
    merchantId: string;
    providerRefundId: string;
    tenantId: string;
    sourceKind: "ORDER" | "EXCEPTION";
    sourceId: string;
    amountCents: number;
    transactionId: string;
  },
): Promise<void> {
  if (
    !Number.isSafeInteger(input.amountCents) ||
    input.amountCents <= 0 ||
    !input.providerRefundId ||
    !input.transactionId
  )
    throw new CashRefundTransactionError();
  await tx.query(
    `INSERT INTO tennis.cash_refund_transactions
      (provider,merchant_id,provider_refund_id,tenant_id,source_kind,source_id,amount_cents,transaction_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
    [
      input.provider,
      input.merchantId,
      input.providerRefundId,
      input.tenantId,
      input.sourceKind,
      input.sourceId,
      input.amountCents,
      input.transactionId,
    ],
  );
  const receipt = (
    await tx.query<{
      tenant_id: string;
      source_kind: string;
      source_id: string;
      amount_cents: string;
      transaction_id: string;
    }>(
      `SELECT tenant_id,source_kind,source_id,amount_cents,transaction_id FROM tennis.cash_refund_transactions
      WHERE provider=$1 AND merchant_id=$2 AND provider_refund_id=$3`,
      [input.provider, input.merchantId, input.providerRefundId],
    )
  ).rows[0];
  if (
    !receipt ||
    receipt.tenant_id !== input.tenantId ||
    receipt.source_kind !== input.sourceKind ||
    receipt.source_id !== input.sourceId ||
    Number(receipt.amount_cents) !== input.amountCents ||
    receipt.transaction_id !== input.transactionId
  )
    throw new CashRefundTransactionError();
}
