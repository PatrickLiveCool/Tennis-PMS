import type pg from "pg";
import { assertCents } from "../../../domain/src/tennis-pricing.ts";
import { TennisWalletError } from "../../../domain/src/tennis-wallet.ts";
import { recordTenantAudit, requireTenantPermission, requireVenuePermission, type TenantActor } from "./access.ts";
import { isCustomerActor, requireCustomer, withBookingTransaction, type BookingActor } from "./customers.ts";
import { idempotentCommand } from "./receipts.ts";
import { creditWalletBatch, lockWallet, walletBalanceInTransaction, type WalletBalance } from "./wallet-store.ts";

export async function recordOfflineTopup(
  db: pg.Pool,
  actor: TenantActor,
  input: {
    venueId: string;
    customerId: string;
    principalCents: number;
    giftCents: number;
    receiptReference: string;
    reason: string;
    commandKey: string;
  },
): Promise<{ batchId: string; balance: WalletBalance }> {
  [input.principalCents, input.giftCents, input.principalCents + input.giftCents].forEach(assertCents);
  if (
    input.principalCents + input.giftCents === 0 ||
    !input.receiptReference.trim() ||
    input.receiptReference.length > 200 ||
    !input.reason.trim() ||
    input.reason.length > 2000
  )
    throw new TennisWalletError("INVALID_TOPUP");
  return withBookingTransaction(db, actor, async (tx) => {
    await requireVenuePermission(tx, actor, input.venueId, "manage_members", "update");
    await requireCustomer(tx, actor, input.customerId);
    const { commandKey, ...raw } = input;
    const request = { ...raw, receiptReference: raw.receiptReference.trim(), reason: raw.reason.trim() };
    const result = await idempotentCommand(
      tx,
      actor,
      input.venueId,
      commandKey,
      "wallet.offline_topup",
      request,
      async () => {
        await lockWallet(tx, actor.tenantId, input.customerId);
        const existing = (
          await tx.query<{
            id: string;
            customer_id: string;
            venue_id: string;
            principal_cents: string;
            gift_cents: string;
            reason: string;
          }>(
            `SELECT id,customer_id,venue_id,principal_cents,gift_cents,reason
        FROM tennis.wallet_batches WHERE tenant_id=$1 AND source_kind='OFFLINE' AND source_reference=$2`,
            [actor.tenantId, request.receiptReference],
          )
        ).rows[0];
        if (existing) {
          if (
            existing.customer_id !== input.customerId ||
            existing.venue_id !== input.venueId ||
            Number(existing.principal_cents) !== input.principalCents ||
            Number(existing.gift_cents) !== input.giftCents ||
            existing.reason !== request.reason
          )
            throw new TennisWalletError("TOPUP_REFERENCE_REUSED");
          return { batchId: existing.id };
        }
        const batchId = await creditWalletBatch(tx, actor, {
          ...request,
          sourceKind: "OFFLINE",
          sourceReference: request.receiptReference,
        });
        await recordTenantAudit(tx, actor, "wallet.offline_topup", batchId, { ...request });
        return { batchId };
      },
    );
    return { ...result, balance: await walletBalanceInTransaction(tx, actor.tenantId, input.customerId) };
  });
}
export async function getWallet(
  db: pg.Pool,
  actor: BookingActor,
  customerId: string,
): Promise<{
  balance: WalletBalance;
  entries: {
    id: string;
    kind: string;
    principalCents: number;
    giftCents: number;
    sourceId: string;
    createdAt: string;
  }[];
}> {
  return withBookingTransaction(db, actor, async (tx) => {
    if (!isCustomerActor(actor)) await requireTenantPermission(tx, actor, "manage_members");
    await requireCustomer(tx, actor, customerId);
    const rows = (
      await tx.query<{
        id: string;
        kind: string;
        principalCents: number;
        giftCents: number;
        sourceId: string;
        createdAt: Date;
      }>(
        `SELECT id,kind,
      principal_cents::float8 AS "principalCents",gift_cents::float8 AS "giftCents",source_id AS "sourceId",created_at AS "createdAt"
      FROM tennis.wallet_entries WHERE tenant_id=$1 AND customer_id=$2 ORDER BY created_at DESC,id LIMIT 200`,
        [actor.tenantId, customerId],
      )
    ).rows;
    return {
      balance: await walletBalanceInTransaction(tx, actor.tenantId, customerId),
      entries: rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
    };
  });
}
