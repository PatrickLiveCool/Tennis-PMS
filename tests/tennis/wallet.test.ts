import { describe, expect, it } from "vitest";
import { allocateWalletDebit } from "../../packages/domain/src/tennis-wallet.ts";
import { LocalMockPaymentGateway } from "../../packages/db/src/tennis/mock-payments.ts";

describe("wallet allocation", () => {
  it("uses credit order and separates principal from gift in the confirmed example", () => {
    expect(
      allocateWalletDebit(12000, [
        {
          id: "first",
          principalCents: 1000000,
          giftCents: 200000,
          availablePrincipalCents: 1000000,
          availableGiftCents: 200000,
        },
        { id: "next", principalCents: 10000, giftCents: 0, availablePrincipalCents: 10000, availableGiftCents: 0 },
      ]),
    ).toEqual([{ batchId: "first", principalCents: 10000, giftCents: 2000 }]);
    expect(() =>
      allocateWalletDebit(2, [
        { id: "tiny", principalCents: 1, giftCents: 0, availablePrincipalCents: 1, availableGiftCents: 0 },
      ]),
    ).toThrow("INSUFFICIENT_BALANCE");
  });
  it("conserves every cent and both components through rounding tails and varied withdrawals", () => {
    for (let principal = 0; principal <= 23; principal++)
      for (let gift = 0; gift <= 17; gift++) {
        const batch = {
          id: "test",
          principalCents: principal,
          giftCents: gift,
          availablePrincipalCents: principal,
          availableGiftCents: gift,
        };
        let spentPrincipal = 0,
          spentGift = 0,
          turn = 0;
        while (batch.availablePrincipalCents + batch.availableGiftCents > 0) {
          const amount = Math.min((++turn % 7) + 1, batch.availablePrincipalCents + batch.availableGiftCents);
          const portion = allocateWalletDebit(amount, [batch])[0]!;
          expect(portion.principalCents + portion.giftCents).toBe(amount);
          batch.availablePrincipalCents -= portion.principalCents;
          batch.availableGiftCents -= portion.giftCents;
          expect(batch.availablePrincipalCents).toBeGreaterThanOrEqual(0);
          expect(batch.availableGiftCents).toBeGreaterThanOrEqual(0);
          spentPrincipal += portion.principalCents;
          spentGift += portion.giftCents;
        }
        expect([spentPrincipal, spentGift]).toEqual([principal, gift]);
      }
  });
  it("rejects forged or changed simulated payment notifications", () => {
    const gateway = new LocalMockPaymentGateway("a-local-test-secret-at-least-32-characters", "local-simulation");
    const message = gateway.signForLocalSimulator({
      provider: "MOCK",
      merchantId: "mock:test",
      paymentId: "payment",
      eventId: "event",
      transactionId: "txn",
      status: "SUCCEEDED",
      amountCents: 2000,
      currency: "CNY",
      issuedAt: Date.now(),
    });
    expect(gateway.verify(message.body, message.signature).amountCents).toBe(2000);
    expect(() => gateway.verify(message.body.replace("2000", "9000"), message.signature)).toThrow(
      "INVALID_PAYMENT_EVENT",
    );
    expect(() => gateway.verify(message.body, "00".repeat(32))).toThrow("INVALID_PAYMENT_EVENT");
  });
});
