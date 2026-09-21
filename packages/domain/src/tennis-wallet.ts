import { allocateCents, assertCents } from "./tennis-pricing.ts";

export interface WalletBatch {
  id: string;
  principalCents: number;
  giftCents: number;
  availablePrincipalCents: number;
  availableGiftCents: number;
}
export interface WalletPortion {
  batchId: string;
  principalCents: number;
  giftCents: number;
}
export class TennisWalletError extends Error {
  constructor(
    readonly code:
      | "INSUFFICIENT_BALANCE"
      | "INVALID_WALLET_AMOUNT"
      | "INVALID_TOPUP"
      | "TOPUP_REFERENCE_REUSED"
      | "PAYMENT_ALREADY_PENDING"
      | "ORDER_NOT_PAYABLE"
      | "INVALID_PAYMENT_EVENT"
      | "PAYMENT_EVENT_REUSED"
      | "PAYMENT_TRANSACTION_REUSED",
  ) {
    super(code);
    this.name = "TennisWalletError";
  }
}
/** Batches arrive in credit order. Gifts never become principal, including rounding tails. */
export function allocateWalletDebit(amountCents: number, batches: readonly WalletBatch[]): WalletPortion[] {
  assertCents(amountCents);
  let remaining = amountCents;
  const portions: WalletPortion[] = [];
  for (const batch of batches) {
    [batch.principalCents, batch.giftCents, batch.availablePrincipalCents, batch.availableGiftCents].forEach(
      assertCents,
    );
    if (batch.availablePrincipalCents > batch.principalCents || batch.availableGiftCents > batch.giftCents)
      throw new TennisWalletError("INVALID_WALLET_AMOUNT");
    const available = batch.availablePrincipalCents + batch.availableGiftCents;
    assertCents(available);
    const take = Math.min(remaining, available);
    if (take === 0) continue;
    const allocated = allocateCents(take, [batch.principalCents, batch.giftCents]);
    const principalCents = Math.max(
      take - batch.availableGiftCents,
      Math.min(allocated[0]!, batch.availablePrincipalCents),
    );
    portions.push({ batchId: batch.id, principalCents, giftCents: take - principalCents });
    remaining -= take;
    if (remaining === 0) break;
  }
  if (remaining !== 0) throw new TennisWalletError("INSUFFICIENT_BALANCE");
  return portions;
}
