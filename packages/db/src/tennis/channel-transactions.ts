import type pg from "pg";
import { TennisWalletError } from "../../../domain/src/tennis-wallet.ts";

/** One external capture can fund exactly one order or top-up, across all tenants. */
export async function claimChannelTransaction(
  tx: pg.PoolClient,
  input: {
    provider: string;
    merchantId: string;
    transactionId: string;
    tenantId: string;
    sourceType: "ORDER" | "TOPUP";
    sourceId: string;
    amountCents: number;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO tennis.channel_transactions (provider,merchant_id,transaction_id,tenant_id,source_type,source_id,amount_cents)
    VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
    [
      input.provider,
      input.merchantId,
      input.transactionId,
      input.tenantId,
      input.sourceType,
      input.sourceId,
      input.amountCents,
    ],
  );
  const current = (
    await tx.query<{ tenant_id: string; source_type: string; source_id: string; amount_cents: string }>(
      "SELECT tenant_id,source_type,source_id,amount_cents FROM tennis.channel_transactions WHERE provider=$1 AND merchant_id=$2 AND transaction_id=$3",
      [input.provider, input.merchantId, input.transactionId],
    )
  ).rows[0]!;
  if (
    current.tenant_id !== input.tenantId ||
    current.source_type !== input.sourceType ||
    current.source_id !== input.sourceId ||
    Number(current.amount_cents) !== input.amountCents
  )
    throw new TennisWalletError("PAYMENT_TRANSACTION_REUSED");
}
