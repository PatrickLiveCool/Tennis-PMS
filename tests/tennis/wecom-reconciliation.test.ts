import { afterEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { TrustedWecomCollectionSource, ingestWecomCollection, simulateWecomReceipt, validateWecomCollection, type WecomCollectionFacts } from "../../packages/db/src/tennis/wecom-reconciliation.ts";
const facts: WecomCollectionFacts = { tenantId: "tenant-a", corporationId: "corp-a", merchantId: "merchant-a", transactionId: "tx-a", provider: "MOCK", amountCents: 12000, currency: "CNY", paidAt: "2026-09-20T12:00:00Z", simulation: true, trustedOperationId: null };
class SyntheticSource extends TrustedWecomCollectionSource { certify(f: WecomCollectionFacts) { return this.certifyCollection(f); } }
const originalEnvironment = process.env.NODE_ENV;
afterEach(() => { process.env.NODE_ENV = originalEnvironment; });
describe("WeCom authenticated receipt boundary", () => {
  it("rejects request-body casts, before acquiring a database connection", async () => {
    await expect(ingestWecomCollection({} as pg.Pool, facts as never)).rejects.toMatchObject({ code: "INVALID_WECOM_RECEIPT" });
  });
  it("makes authenticated observations immutable and normalizes the provider timestamp", () => {
    const receipt = new SyntheticSource().certify(facts);
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(receipt.paidAt).toBe("2026-09-20T12:00:00.000Z");
  });
  it.each([
    { amountCents: 0 }, { amountCents: 0.5 }, { amountCents: Number.MAX_SAFE_INTEGER + 1 },
    { merchantId: " " }, { paidAt: "yesterday" }, { simulation: false }, { provider: "WECHAT" }, { trustedOperationId: "" }, { currency: "USD" },
  ])("rejects unverified or ambiguous money facts %s", override => {
    expect(() => validateWecomCollection({ ...facts, ...override } as WecomCollectionFacts)).toThrow("INVALID_WECOM_RECEIPT");
  });
  it("cannot enable the simulation endpoint in production or without the explicit server switch", async () => {
    const input = { operationId: "operation", referenceMode: "EXACT" as const, commandKey: "retry" };
    await expect(simulateWecomReceipt({} as pg.Pool, { tenantId: "t", subjectId: "s" }, input, { allowSimulation: false })).rejects.toMatchObject({ code: "WECOM_SIMULATION_DISABLED" });
    process.env.NODE_ENV = "production";
    await expect(simulateWecomReceipt({} as pg.Pool, { tenantId: "t", subjectId: "s" }, input, { allowSimulation: true })).rejects.toMatchObject({ code: "WECOM_SIMULATION_DISABLED" });
  });
});
