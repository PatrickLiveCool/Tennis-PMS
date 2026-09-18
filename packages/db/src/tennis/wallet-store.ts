import { randomUUID } from "node:crypto";
import type pg from "pg";
import { allocateWalletDebit, type WalletBatch, type WalletPortion } from "../../../domain/src/tennis-wallet.ts";
import { assertCents } from "../../../domain/src/tennis-pricing.ts";
import type { TenantActor } from "./access.ts";

export interface WalletBalance {
  availableCents: number;
  reservedCents: number;
  totalCents: number;
  principalCents: number;
  giftCents: number;
}
export async function lockWallet(tx: pg.PoolClient, tenantId: string, customerId: string): Promise<void> {
  await tx.query("INSERT INTO tennis.wallet_accounts (tenant_id,customer_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [
    tenantId,
    customerId,
  ]);
  await tx.query("SELECT customer_id FROM tennis.wallet_accounts WHERE tenant_id=$1 AND customer_id=$2 FOR UPDATE", [
    tenantId,
    customerId,
  ]);
}
export async function walletBalanceInTransaction(
  tx: pg.PoolClient,
  tenantId: string,
  customerId: string,
): Promise<WalletBalance> {
  const totals = (
    await tx.query<{ availableCents: number; reservedCents: number; principalCents: number; giftCents: number }>(
      `SELECT
    coalesce(sum(available_principal_cents+available_gift_cents),0)::float8 AS "availableCents",
    coalesce(sum(reserved_principal_cents+reserved_gift_cents),0)::float8 AS "reservedCents",
    coalesce(sum(available_principal_cents+reserved_principal_cents),0)::float8 AS "principalCents",
    coalesce(sum(available_gift_cents+reserved_gift_cents),0)::float8 AS "giftCents"
    FROM tennis.wallet_batches WHERE tenant_id=$1 AND customer_id=$2`,
      [tenantId, customerId],
    )
  ).rows[0]!;
  const balance = { ...totals, totalCents: totals.availableCents + totals.reservedCents };
  Object.values(balance).forEach(assertCents);
  return balance;
}
export async function appendWalletEntry(
  tx: pg.PoolClient,
  tenantId: string,
  customerId: string,
  kind: "TOPUP" | "RESERVE" | "RELEASE" | "CONSUME" | "REFUND",
  sourceId: string,
  portion: WalletPortion,
): Promise<void> {
  await tx.query(
    `INSERT INTO tennis.wallet_entries (id,tenant_id,customer_id,batch_id,kind,principal_cents,gift_cents,source_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [randomUUID(), tenantId, customerId, portion.batchId, kind, portion.principalCents, portion.giftCents, sourceId],
  );
}
/** Caller validates the real/simulated cash source and authorization; this is not a balance editor. */
export async function creditWalletBatch(
  tx: pg.PoolClient,
  actor: TenantActor,
  input: {
    venueId: string;
    customerId: string;
    principalCents: number;
    giftCents: number;
    sourceKind: "OFFLINE" | "MOCK" | "WECHAT";
    sourceReference: string;
    reason: string;
  },
): Promise<string> {
  [input.principalCents, input.giftCents, input.principalCents + input.giftCents].forEach(assertCents);
  await lockWallet(tx, actor.tenantId, input.customerId);
  // Lifetime cap leaves headroom for original-source refunds after later top-ups.
  const credited = Number(
    (
      await tx.query<{ total: string }>(
        "SELECT coalesce(sum(principal_cents+gift_cents),0) AS total FROM tennis.wallet_batches WHERE tenant_id=$1 AND customer_id=$2",
        [actor.tenantId, input.customerId],
      )
    ).rows[0]!.total,
  );
  assertCents(credited + input.principalCents + input.giftCents);
  const batchId = randomUUID();
  await tx.query(
    `INSERT INTO tennis.wallet_batches (id,tenant_id,customer_id,venue_id,principal_cents,gift_cents,available_principal_cents,available_gift_cents,source_kind,source_reference,reason,created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$5,$6,$7,$8,$9,$10)`,
    [
      batchId,
      actor.tenantId,
      input.customerId,
      input.venueId,
      input.principalCents,
      input.giftCents,
      input.sourceKind,
      input.sourceReference,
      input.reason,
      actor.subjectId,
    ],
  );
  await appendWalletEntry(tx, actor.tenantId, input.customerId, "TOPUP", batchId, {
    batchId,
    principalCents: input.principalCents,
    giftCents: input.giftCents,
  });
  return batchId;
}
/** Caller holds tenant transaction lock and has authorized spending for this customer. */
export async function reserveWallet(
  tx: pg.PoolClient,
  tenantId: string,
  customerId: string,
  paymentId: string,
  amountCents: number,
): Promise<void> {
  if (amountCents === 0) return;
  await lockWallet(tx, tenantId, customerId);
  const batches = (
    await tx.query<WalletBatch>(
      `SELECT id,principal_cents::float8 AS "principalCents",gift_cents::float8 AS "giftCents",
    available_principal_cents::float8 AS "availablePrincipalCents",available_gift_cents::float8 AS "availableGiftCents"
    FROM tennis.wallet_batches WHERE tenant_id=$1 AND customer_id=$2 ORDER BY credit_sequence FOR UPDATE`,
      [tenantId, customerId],
    )
  ).rows;
  const portions = allocateWalletDebit(amountCents, batches);
  for (const portion of portions) {
    await tx.query(
      `UPDATE tennis.wallet_batches SET available_principal_cents=available_principal_cents-$1,available_gift_cents=available_gift_cents-$2,
      reserved_principal_cents=reserved_principal_cents+$1,reserved_gift_cents=reserved_gift_cents+$2 WHERE tenant_id=$3 AND customer_id=$4 AND id=$5`,
      [portion.principalCents, portion.giftCents, tenantId, customerId, portion.batchId],
    );
    await tx.query(
      "INSERT INTO tennis.wallet_allocations (tenant_id,customer_id,payment_id,batch_id,principal_cents,gift_cents,status) VALUES ($1,$2,$3,$4,$5,$6,'RESERVED')",
      [tenantId, customerId, paymentId, portion.batchId, portion.principalCents, portion.giftCents],
    );
    await appendWalletEntry(tx, tenantId, customerId, "RESERVE", paymentId, portion);
  }
}
/** Idempotent release/consume of only currently reserved allocations. */
export async function settleWalletReservation(
  tx: pg.PoolClient,
  tenantId: string,
  customerId: string,
  paymentId: string,
  consume: boolean,
): Promise<void> {
  await lockWallet(tx, tenantId, customerId);
  const portions = (
    await tx.query<WalletPortion>(
      `SELECT batch_id AS "batchId",principal_cents::float8 AS "principalCents",gift_cents::float8 AS "giftCents"
    FROM tennis.wallet_allocations WHERE tenant_id=$1 AND customer_id=$2 AND payment_id=$3 AND status='RESERVED' ORDER BY batch_id FOR UPDATE`,
      [tenantId, customerId, paymentId],
    )
  ).rows;
  for (const portion of portions) {
    await tx.query(
      `UPDATE tennis.wallet_batches SET reserved_principal_cents=reserved_principal_cents-$1,reserved_gift_cents=reserved_gift_cents-$2,
      available_principal_cents=available_principal_cents+$3,available_gift_cents=available_gift_cents+$4 WHERE tenant_id=$5 AND customer_id=$6 AND id=$7`,
      [
        portion.principalCents,
        portion.giftCents,
        consume ? 0 : portion.principalCents,
        consume ? 0 : portion.giftCents,
        tenantId,
        customerId,
        portion.batchId,
      ],
    );
    await tx.query(
      "UPDATE tennis.wallet_allocations SET status=$1 WHERE tenant_id=$2 AND payment_id=$3 AND batch_id=$4",
      [consume ? "CONSUMED" : "RELEASED", tenantId, paymentId, portion.batchId],
    );
    await appendWalletEntry(tx, tenantId, customerId, consume ? "CONSUME" : "RELEASE", paymentId, portion);
  }
}
