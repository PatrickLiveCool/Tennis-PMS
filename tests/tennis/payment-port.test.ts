import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MerchantBindingSnapshot } from "../../packages/db/src/tennis/merchant-bindings.ts";
import {
  isVerifiedPaymentEvent,
  isVerifiedRefundEvent,
  paymentEventSemanticHash,
  refundEventSemanticHash,
  requireRefundOriginalPaymentCents,
  type PaymentPortInput,
  type RefundPortInput,
} from "../../packages/db/src/tennis/payment-port.ts";
import {
  LocalMockPaymentGateway,
  type MockChannelKey,
  type MockChannelRecord,
  type MockChannelStore,
  type MockPaymentPayload,
  type MockRefundPayload,
  type MockStoredOutcome,
} from "../../packages/db/src/tennis/mock-payments.ts";

const secret = "synthetic-local-only-port-signing-secret-at-least-32";
const binding: MerchantBindingSnapshot = {
  id: "binding-a", tenantId: "tenant-a", version: 1, provider: "MOCK", merchantId: "mock:tenant-a",
  appId: null, credentialRef: null,
};
const payment = (): PaymentPortInput => ({
  binding: { ...binding }, operationId: "operation-payment-a", merchantOrderNo: "merchant-order-a",
  sourceKind: "ORDER", sourceId: "payment-a", amountCents: 12000, currency: "CNY",
  expiresAt: "2099-01-01T12:00:00.000Z",
});
const refund = (): RefundPortInput => ({
  binding: { ...binding }, operationId: "operation-refund-a", merchantOrderNo: "merchant-order-a",
  sourceId: "payment-a", transactionId: "original-channel-transaction-a", merchantRefundNo: "merchant-refund-a",
  refundId: "refund-a", amountCents: 3000, currency: "CNY",
});
const paymentPayload = (): MockPaymentPayload => ({
  provider: "MOCK", merchantId: binding.merchantId, paymentId: "payment-a", eventId: "event-payment-a",
  status: "SUCCEEDED", transactionId: "transaction-a", amountCents: 12000, currency: "CNY", issuedAt: Date.now(),
});
const refundPayload = (): MockRefundPayload => ({
  eventType: "REFUND", provider: "MOCK", merchantId: binding.merchantId, refundId: "refund-a",
  eventId: "event-refund-a", status: "SUCCEEDED", transactionId: "transaction-a", providerRefundId: "channel-refund-a",
  amountCents: 3000, currency: "CNY", issuedAt: Date.now(),
});
const sameKey = (a: MockChannelKey, b: MockChannelKey) =>
  a.kind === b.kind && a.merchantId === b.merchantId && a.merchantReference === b.merchantReference;

/** File-backed test double: each call reloads disk; no adapter or Store instance owns the state. */
class FileStore implements MockChannelStore {
  loseCreateResponse = false;
  loseOutcomeResponse = false;
  failReads = false;
  constructor(readonly file: string) {}
  records(): MockChannelRecord[] { return JSON.parse(readFileSync(this.file, "utf8")) as MockChannelRecord[]; }
  private write(rows: MockChannelRecord[]) { writeFileSync(this.file, JSON.stringify(rows)); }
  async get(key: MockChannelKey): Promise<MockChannelRecord | null> {
    if (this.failReads) throw new Error("synthetic disconnected channel store");
    return this.records().find((row) => sameKey(row, key)) ?? null;
  }
  async putIfAbsent(record: MockChannelRecord): Promise<MockChannelRecord> {
    const rows = this.records();
    const found = rows.find((row) => sameKey(row, record));
    if (found) return found;
    this.write([...rows, record]);
    if (this.loseCreateResponse) throw new Error("synthetic response lost after durable create");
    return JSON.parse(JSON.stringify(record)) as MockChannelRecord;
  }
  async recordOutcome(key: MockChannelKey, expectedRequestHash: string, outcome: MockStoredOutcome): Promise<MockChannelRecord> {
    const rows = this.records();
    const found = rows.find((row) => sameKey(row, key));
    if (!found || found.requestHash !== expectedRequestHash || found.kind !== outcome.kind)
      throw new Error("synthetic mismatched stored request");
    if (found.outcome?.event.status === "SUCCEEDED" || found.outcome?.event.status === outcome.event.status ||
      (found.kind === "REFUND" && found.outcome?.event.status === "FAILED")) return found;
    found.outcome = outcome;
    this.write(rows);
    if (this.loseOutcomeResponse) throw new Error("synthetic response lost after durable settlement");
    return JSON.parse(JSON.stringify(found)) as MockChannelRecord;
  }
}
let directory: string, file: string, store: FileStore, gateway: LocalMockPaymentGateway;
const restarted = () => new LocalMockPaymentGateway(secret, "local-simulation", new FileStore(file));
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "tennis-payment-port-"));
  file = join(directory, "channel.json");
  writeFileSync(file, "[]");
  store = new FileStore(file);
  gateway = new LocalMockPaymentGateway(secret, "local-simulation", store);
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(directory, { recursive: true, force: true });
});

describe("provider-neutral payment evidence", () => {
  it("accepts authenticated legacy events but rejects request-body casts, JSON copies and object spreads", () => {
    const raw = paymentPayload();
    const signed = gateway.signForLocalSimulator(raw);
    const event = gateway.verify(signed.body, signed.signature);
    expect(isVerifiedPaymentEvent(event)).toBe(true);
    expect(Object.isFrozen(event)).toBe(true);
    expect(isVerifiedPaymentEvent(raw)).toBe(false);
    expect(isVerifiedPaymentEvent(JSON.parse(JSON.stringify(event)))).toBe(false);
    expect(isVerifiedPaymentEvent({ ...event })).toBe(false);
    expect(isVerifiedRefundEvent(event)).toBe(false);
    const signedRefund = gateway.signForLocalSimulator(refundPayload());
    const refundEvent = gateway.verifyRefund(signedRefund.body, signedRefund.signature);
    expect(isVerifiedRefundEvent(refundEvent)).toBe(true);
    expect(isVerifiedRefundEvent({ ...refundEvent })).toBe(false);
    expect(isVerifiedPaymentEvent(refundEvent)).toBe(false);
  });

  it("allows definitive failures without invented transaction or provider-refund identifiers", () => {
    const { transactionId: _transactionId, ...base } = paymentPayload();
    const signed = gateway.signForLocalSimulator({ ...base, status: "FAILED" });
    const event = gateway.verify(signed.body, signed.signature);
    expect(event).toMatchObject({ status: "FAILED", paymentId: "payment-a" });
    expect(event).not.toHaveProperty("transactionId");
    const { transactionId: _original, providerRefundId: _refundId, ...refundBase } = refundPayload();
    const signedRefund = gateway.signForLocalSimulator({ ...refundBase, status: "FAILED" });
    const refundEvent = gateway.verifyRefund(signedRefund.body, signedRefund.signature);
    expect(refundEvent).toMatchObject({ status: "FAILED", refundId: "refund-a" });
    expect(refundEvent).not.toHaveProperty("transactionId");
    expect(refundEvent).not.toHaveProperty("providerRefundId");
    const missingTransaction = gateway.signForLocalSimulator({ ...base, status: "SUCCEEDED" });
    expect(() => gateway.verify(missingTransaction.body, missingTransaction.signature)).toThrow("INVALID_PAYMENT_EVENT");
    const missingRefund = gateway.signForLocalSimulator({ ...refundBase, status: "SUCCEEDED" });
    expect(() => gateway.verifyRefund(missingRefund.body, missingRefund.signature)).toThrow("INVALID_PAYMENT_EVENT");
  });

  it("separates changing signed-envelope time from stable payment and refund event semantics", () => {
    const first = paymentPayload();
    expect(paymentEventSemanticHash(first)).toBe(paymentEventSemanticHash({ ...first, issuedAt: first.issuedAt + 1000 }));
    expect(paymentEventSemanticHash(first)).not.toBe(paymentEventSemanticHash({ ...first, amountCents: first.amountCents + 1 }));
    expect(paymentEventSemanticHash(first)).not.toBe(paymentEventSemanticHash({ ...first, transactionId: "another-transaction" }));
    const withOperation: MockPaymentPayload = { ...first, operationId: "signed-routing-metadata" };
    expect(paymentEventSemanticHash(withOperation)).toBe(paymentEventSemanticHash(first));
    const returned = refundPayload();
    expect(refundEventSemanticHash(returned)).toBe(refundEventSemanticHash({ ...returned, issuedAt: returned.issuedAt + 1000 }));
    expect(refundEventSemanticHash(returned)).not.toBe(refundEventSemanticHash({ ...returned, providerRefundId: "another-refund" }));
    expect(refundEventSemanticHash(returned)).not.toBe(refundEventSemanticHash({ ...returned, merchantId: "another-merchant" }));
    const refundWithOperation: MockRefundPayload = { ...returned, operationId: "signed-refund-routing-metadata" };
    expect(refundEventSemanticHash(refundWithOperation)).toBe(refundEventSemanticHash(returned));
  });

  it("verifies raw notifications against the supplied trusted merchant snapshot and original bytes", async () => {
    const signed = gateway.signForLocalSimulator({ ...paymentPayload(), operationId: payment().operationId });
    const input = { binding, rawBody: signed.body, headers: { "x-mock-signature": signed.signature } };
    const notification = await gateway.verifyNotification(input);
    expect(notification).toMatchObject({ kind: "PAYMENT", bindingId: binding.id, bindingVersion: binding.version, operationId: payment().operationId });
    expect(isVerifiedPaymentEvent(notification.event)).toBe(true);
    await expect(gateway.verifyNotification({ ...input, binding: { ...binding, merchantId: "mock:another-tenant" } }))
      .rejects.toThrow("INVALID_PAYMENT_EVENT");
    await expect(gateway.verifyNotification({ ...input, binding: { ...binding, provider: "WECHAT" } }))
      .rejects.toThrow("INVALID_PAYMENT_EVENT");
    await expect(gateway.verifyNotification({ ...input, rawBody: signed.body.replace("12000", "13000") }))
      .rejects.toThrow("INVALID_PAYMENT_EVENT");
    await expect(gateway.verifyNotification({ ...input, headers: {} })).rejects.toThrow("INVALID_PAYMENT_EVENT");
    const unsignedOperation = gateway.signForLocalSimulator(paymentPayload());
    await expect(gateway.verifyNotification({
      binding, rawBody: unsignedOperation.body, headers: { "x-mock-signature": unsignedOperation.signature },
    })).rejects.toThrow("INVALID_PAYMENT_EVENT");
    const tamperedOperation = signed.body.replace(payment().operationId, "another-operation");
    await expect(gateway.verifyNotification({ ...input, rawBody: tamperedOperation })).rejects.toThrow("INVALID_PAYMENT_EVENT");
    const refundSigned = gateway.signForLocalSimulator({ ...refundPayload(), operationId: refund().operationId });
    const refundNotification = await gateway.verifyNotification({
      binding, rawBody: refundSigned.body, headers: { "x-mock-signature": refundSigned.signature },
    });
    expect(refundNotification).toMatchObject({ kind: "REFUND", operationId: refund().operationId });
    expect(isVerifiedRefundEvent(refundNotification.event)).toBe(true);
  });
});

describe("durable local simulated payment channel", () => {
  it("does not replace a missing durable store with process-local state", async () => {
    const withoutStore = new LocalMockPaymentGateway(secret, "local-simulation");
    for (const result of await Promise.all([
      withoutStore.createPayment(payment()), withoutStore.queryPayment(payment()),
      withoutStore.createRefund(refund()), withoutStore.queryRefund(refund()),
    ])) expect(result).toEqual({ status: "UNKNOWN", code: "MOCK_STORE_UNAVAILABLE" });
    expect(withoutStore.provider).toBe("MOCK");
    expect(withoutStore.simulation).toBe(true);
    const signed = withoutStore.signForLocalSimulator(paymentPayload());
    expect(isVerifiedPaymentEvent(withoutStore.verify(signed.body, signed.signature))).toBe(true);
    const attached = withoutStore.withStore(store);
    expect(attached).not.toBe(withoutStore);
    expect(isVerifiedPaymentEvent(attached.verify(signed.body, signed.signature))).toBe(true);
    expect((await attached.createPayment(payment())).status).toBe("PENDING");
    expect((await restarted().queryPayment(payment())).status).toBe("PENDING");
  });

  it("keeps a fixed payment across fresh adapter and Store instances and returns only explicit local checkout", async () => {
    const input = payment();
    expect(await gateway.queryPayment(input)).toEqual({ status: "NOT_FOUND" });
    const result = await gateway.createPayment(input);
    expect(result).toEqual({ status: "PENDING", checkout: { kind: "LOCAL_SIMULATION", operationId: input.operationId, expiresAt: input.expiresAt } });
    expect(await restarted().queryPayment(input)).toEqual(result);
    expect(await restarted().createPayment(input)).toEqual(result);
    expect(store.records()).toHaveLength(1);
    expect(store.records()[0]?.input).toMatchObject({ sourceKind: "ORDER", sourceId: input.sourceId, amountCents: input.amountCents, binding });
    expect(JSON.stringify(result)).not.toMatch(/https?:|credentialRef|merchantId|signingSecret/);
  });

  it("rejects changed amounts, tenant snapshots and binding versions under an existing merchant order number", async () => {
    const input = payment();
    await gateway.createPayment(input);
    for (const changed of [
      { ...input, amountCents: input.amountCents + 1 },
      { ...input, binding: { ...binding, tenantId: "another-tenant" } },
      { ...input, binding: { ...binding, version: 2 } },
      { ...input, sourceKind: "TOPUP" as const },
    ]) {
      expect(await restarted().createPayment(changed)).toEqual({ status: "UNKNOWN", code: "MOCK_REQUEST_CONFLICT" });
      expect(await restarted().queryPayment(changed)).toEqual({ status: "UNKNOWN", code: "MOCK_REQUEST_CONFLICT" });
    }
    expect(store.records()).toHaveLength(1);
    expect((store.records()[0]!.input as PaymentPortInput).amountCents).toBe(input.amountCents);
  });

  it("recovers an accepted create whose response was lost without making a second channel record", async () => {
    const input = payment();
    store.loseCreateResponse = true;
    expect(await gateway.createPayment(input)).toEqual({ status: "UNKNOWN", code: "MOCK_STORE_UNAVAILABLE" });
    expect((await restarted().queryPayment(input)).status).toBe("PENDING");
    expect((await restarted().createPayment(input)).status).toBe("PENDING");
    expect(store.records()).toHaveLength(1);
  });

  it("recovers durable success after a lost response and re-certifies the same terminal facts on every query", async () => {
    const input = payment();
    await gateway.createPayment(input);
    store.loseOutcomeResponse = true;
    expect(await gateway.simulatePayment(input, "SUCCEEDED")).toEqual({ status: "UNKNOWN", code: "MOCK_STORE_UNAVAILABLE" });
    const recovered = await restarted().queryPayment(input);
    expect(recovered.status).toBe("SUCCEEDED");
    if (recovered.status !== "SUCCEEDED") throw new Error("Expected recovered success");
    expect(isVerifiedPaymentEvent(recovered.event)).toBe(true);
    expect(isVerifiedPaymentEvent(store.records()[0]!.outcome!.event)).toBe(false);
    const next = await restarted().queryPayment(input);
    expect(next).toEqual(recovered);
    if (next.status !== "SUCCEEDED") throw new Error("Expected repeated success");
    expect(next.event).not.toBe(recovered.event);
    expect(await restarted().simulatePayment(input, "FAILED")).toEqual(recovered);
    expect(await restarted().simulatePayment(input, "SUCCEEDED")).toEqual(recovered);
    expect(store.records()).toHaveLength(1);
  });

  it("preserves late actual success after a definitive failure without fabricating a failed transaction", async () => {
    const input = payment();
    const failed = await gateway.simulatePayment(input, "FAILED");
    expect(failed.status).toBe("DEFINITIVELY_FAILED");
    if (failed.status !== "DEFINITIVELY_FAILED") throw new Error("Expected definitive failure");
    expect(isVerifiedPaymentEvent(failed.event)).toBe(true);
    expect(failed.event).not.toHaveProperty("transactionId");
    expect(await restarted().queryPayment(input)).toEqual(failed);
    const success = await restarted().simulatePayment(input, "SUCCEEDED");
    expect(success.status).toBe("SUCCEEDED");
    expect(await restarted().queryPayment(input)).toEqual(success);
    expect(store.records()).toHaveLength(1);
  });

  it("keeps historical channel success queryable after a notification freshness window has elapsed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const original = await gateway.simulatePayment(payment(), "SUCCEEDED");
    if (original.status !== "SUCCEEDED") throw new Error("Expected success");
    const signed = gateway.signForLocalSimulator({ ...original.event, provider: "MOCK" });
    vi.setSystemTime(new Date("2030-01-02T00:00:00Z"));
    expect(() => gateway.verify(signed.body, signed.signature)).toThrow("INVALID_PAYMENT_EVENT");
    expect(await restarted().queryPayment(payment())).toEqual(original);
  });

  it("distinguishes reliable not-found from a disconnected query, without changing the stored result", async () => {
    expect(await gateway.queryPayment(payment())).toEqual({ status: "NOT_FOUND" });
    expect(await gateway.queryRefund(refund())).toEqual({ status: "NOT_FOUND" });
    await gateway.createPayment(payment());
    store.failReads = true;
    expect(await gateway.queryPayment(payment())).toEqual({ status: "UNKNOWN", code: "MOCK_STORE_UNAVAILABLE" });
    expect(await gateway.queryRefund(refund())).toEqual({ status: "UNKNOWN", code: "MOCK_STORE_UNAVAILABLE" });
    expect((await restarted().queryPayment(payment())).status).toBe("PENDING");
    expect(store.records()[0]!.outcome).toBeNull();
  });

  it("recovers refund results against the same original transaction and merchant refund number", async () => {
    const input = refund();
    expect(await gateway.createRefund(input)).toEqual({ status: "PENDING" });
    expect(await restarted().queryRefund(input)).toEqual({ status: "PENDING" });
    expect(await restarted().createRefund({ ...input, transactionId: "wrong-original-transaction" }))
      .toEqual({ status: "UNKNOWN", code: "MOCK_REQUEST_CONFLICT" });
    store.loseOutcomeResponse = true;
    expect(await gateway.simulateRefund(input, "SUCCEEDED")).toEqual({ status: "UNKNOWN", code: "MOCK_STORE_UNAVAILABLE" });
    const result = await restarted().queryRefund(input);
    if (result.status !== "SUCCEEDED") throw new Error("Expected recovered refund success");
    expect(isVerifiedRefundEvent(result.event)).toBe(true);
    expect(result.event).toMatchObject({ refundId: input.refundId, transactionId: input.transactionId, amountCents: input.amountCents });
    expect(await restarted().simulateRefund(input, "FAILED")).toEqual(result);
    expect(await restarted().simulateRefund(input, "SUCCEEDED")).toEqual(result);
    expect(store.records()).toHaveLength(1);
  });

  it("keeps a definitively failed refund number closed and requires a new authorized channel attempt", async () => {
    const input = refund();
    const failed = await gateway.simulateRefund(input, "FAILED");
    if (failed.status !== "DEFINITIVELY_FAILED") throw new Error("Expected refund failure");
    expect(failed.event).not.toHaveProperty("providerRefundId");
    expect(failed.event.transactionId).toBe(input.transactionId);
    expect(await restarted().queryRefund(input)).toEqual(failed);
    expect(await restarted().simulateRefund(input, "SUCCEEDED")).toEqual(failed);
    expect(store.records()).toHaveLength(1);
    const retry = { ...input, operationId: "operation-refund-retry", merchantRefundNo: "merchant-refund-retry" };
    const recovered = await restarted().simulateRefund(retry, "SUCCEEDED");
    expect(recovered.status).toBe("SUCCEEDED");
    if (recovered.status !== "SUCCEEDED") throw new Error("Expected successful new refund attempt");
    expect(recovered.event).toMatchObject({ refundId: input.refundId, transactionId: input.transactionId, merchantId: binding.merchantId });
    expect(await restarted().queryRefund(retry)).toEqual(recovered);
    expect(await restarted().queryRefund(input)).toEqual(failed);
    expect(store.records()).toHaveLength(2);
  });

  it("does not certify a corrupted persisted outcome for a different payment or amount", async () => {
    const input = payment();
    await gateway.createPayment(input);
    const rows = store.records();
    rows[0]!.outcome = { kind: "PAYMENT", event: { ...paymentPayload(), paymentId: "another-payment" } };
    writeFileSync(file, JSON.stringify(rows));
    expect(await restarted().queryPayment(input)).toEqual({ status: "UNKNOWN", code: "MOCK_STORED_RESULT_INVALID" });
    rows[0]!.outcome = { kind: "PAYMENT", event: { ...paymentPayload(), amountCents: 1 } };
    writeFileSync(file, JSON.stringify(rows));
    expect(await restarted().queryPayment(input)).toEqual({ status: "UNKNOWN", code: "MOCK_STORED_RESULT_INVALID" });
  });
});


describe("original channel refund totals", () => {
  it.each([undefined, null, 0, -1, 2999, 3000.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])(
    "refuses missing or invalid original totals (%s) for live refund creation", (total) => {
      expect(() => requireRefundOriginalPaymentCents({ ...refund(), originalPaymentCents: total as number }))
        .toThrow("INVALID_PAYMENT_EVENT");
    },
  );
  it("accepts a full or partial refund only against a valid original channel total", () => {
    expect(requireRefundOriginalPaymentCents({ ...refund(), originalPaymentCents: 3000 })).toBe(3000);
    expect(requireRefundOriginalPaymentCents({ ...refund(), originalPaymentCents: 12000 })).toBe(12000);
    for (const amountCents of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
      expect(() => requireRefundOriginalPaymentCents({ ...refund(), amountCents, originalPaymentCents: 12000 }))
        .toThrow("INVALID_PAYMENT_EVENT");
  });
  it("persists a new total and refuses changing or removing it under the same refund number", async () => {
    const input = { ...refund(), originalPaymentCents: 12000 };
    expect(await gateway.createRefund(input)).toEqual({ status: "PENDING" });
    const snapshot = store.records();
    for (const changed of [{ ...input, originalPaymentCents: 6000 }, refund()]) {
      expect(await restarted().createRefund(changed)).toEqual({ status: "UNKNOWN", code: "MOCK_REQUEST_CONFLICT" });
      expect(await restarted().queryRefund(changed)).toEqual({ status: "UNKNOWN", code: "MOCK_REQUEST_CONFLICT" });
    }
    for (const originalPaymentCents of [0, -1, 2999, 12000.5])
      await expect(restarted().createRefund({ ...input, originalPaymentCents })).rejects.toThrow("INVALID_PAYMENT_EVENT");
    expect(store.records()).toEqual(snapshot);
    expect((await restarted().simulateRefund(input, "SUCCEEDED")).status).toBe("SUCCEEDED");
  });
  it("recovers a pre-F15 persisted request without modifying its bytes, hash or merchant number", async () => {
    // Construct the historical stored record independently of the current adapter normalizer.
    const input = refund();
    const oldHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    writeFileSync(file, JSON.stringify([{
      kind: "REFUND", merchantId: binding.merchantId, merchantReference: input.merchantRefundNo,
      input, requestHash: oldHash, outcome: null,
    }]));
    const before = readFileSync(file, "utf8");
    expect(await restarted().queryRefund(input)).toEqual({ status: "PENDING" });
    expect(await restarted().createRefund(input)).toEqual({ status: "PENDING" });
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(await restarted().queryRefund({ ...input, originalPaymentCents: 12000 }))
      .toEqual({ status: "UNKNOWN", code: "MOCK_REQUEST_CONFLICT" });
    expect((await restarted().simulateRefund(input, "SUCCEEDED")).status).toBe("SUCCEEDED");
    expect((await restarted().queryRefund(input)).status).toBe("SUCCEEDED");
    expect(store.records()[0]).toMatchObject({ input, requestHash: oldHash });
    expect(store.records()[0]!.input).not.toHaveProperty("originalPaymentCents");
  });
});
