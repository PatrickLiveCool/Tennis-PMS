import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { TennisWalletError } from "../../../domain/src/tennis-wallet.ts";
import type { MerchantBindingSnapshot } from "./merchant-bindings.ts";
import {
  TrustedPaymentProvider,
  requireRefundOriginalPaymentCents,
  type PaymentCreateResult,
  type PaymentEventData,
  type PaymentNotificationInput,
  type PaymentPortInput,
  type PaymentQueryResult,
  type RefundCreateResult,
  type RefundEventData,
  type RefundPortInput,
  type RefundQueryResult,
  type VerifiedPaymentEvent,
  type VerifiedPaymentNotification,
  type VerifiedRefundEvent,
  type VerifiedRefundNotification,
} from "./payment-port.ts";
export {
  isVerifiedPaymentEvent,
  isVerifiedRefundEvent,
  type VerifiedPaymentEvent,
  type VerifiedRefundEvent,
} from "./payment-port.ts";

export interface MockPaymentPayload extends PaymentEventData { provider: "MOCK"; operationId?: string }
export interface MockRefundPayload extends RefundEventData { provider: "MOCK"; operationId?: string }
export interface MockChannelKey {
  kind: "PAYMENT" | "REFUND";
  merchantId: string;
  merchantReference: string;
}
export type MockStoredOutcome =
  | { kind: "PAYMENT"; event: MockPaymentPayload }
  | { kind: "REFUND"; event: MockRefundPayload };
export interface MockChannelRecord extends MockChannelKey {
  requestHash: string;
  input: PaymentPortInput | RefundPortInput;
  outcome: MockStoredOutcome | null;
}
/**
 * Inject a durable shared store. Every method must be atomic across workers.
 * putIfAbsent returns the existing record without changing its request.
 * recordOutcome rejects request-hash mismatches and preserves the first stored
 * event for repeated outcomes. Payment FAILED may advance to SUCCEEDED; success is final.
 * A refund FAILED is final for that merchantRefundNo; authorized retries use a new number.
 * This is the simulated channel ledger, not the PMS's money ledger.
 */
export interface MockChannelStore {
  get(key: MockChannelKey): Promise<MockChannelRecord | null>;
  putIfAbsent(record: MockChannelRecord): Promise<MockChannelRecord>;
  recordOutcome(key: MockChannelKey, expectedRequestHash: string, outcome: MockStoredOutcome): Promise<MockChannelRecord>;
}
const validId = (value: unknown, maximum = 200): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const unknown = (code: string): { status: "UNKNOWN"; code: string } => ({ status: "UNKNOWN", code });
function invalid(): never { throw new TennisWalletError("INVALID_PAYMENT_EVENT"); }
function bindingSnapshot(binding: MerchantBindingSnapshot): MerchantBindingSnapshot {
  if (!binding || binding.provider !== "MOCK" || !validId(binding.id) || !validId(binding.tenantId) ||
    !validId(binding.merchantId) || !Number.isSafeInteger(binding.version) || binding.version < 1 ||
    (binding.appId !== null && !validId(binding.appId)) ||
    (binding.credentialRef !== null && !validId(binding.credentialRef, 500))) invalid();
  return Object.freeze({
    id: binding.id, tenantId: binding.tenantId, version: binding.version, provider: binding.provider,
    merchantId: binding.merchantId, appId: binding.appId, credentialRef: binding.credentialRef,
  });
}
function paymentInput(input: PaymentPortInput): PaymentPortInput {
  if (!input || !validId(input.operationId) || !validId(input.merchantOrderNo) || !validId(input.sourceId) ||
    !["ORDER", "TOPUP"].includes(input.sourceKind) || input.currency !== "CNY" ||
    !Number.isSafeInteger(input.amountCents) || input.amountCents <= 0 || typeof input.expiresAt !== "string" ||
    !/(Z|[+-]\d{2}:\d{2})$/i.test(input.expiresAt) || !Number.isFinite(Date.parse(input.expiresAt))) invalid();
  return Object.freeze({
    binding: bindingSnapshot(input.binding), operationId: input.operationId, merchantOrderNo: input.merchantOrderNo,
    sourceKind: input.sourceKind, sourceId: input.sourceId, amountCents: input.amountCents, currency: input.currency,
    expiresAt: new Date(input.expiresAt).toISOString(),
  });
}
function refundInput(input: RefundPortInput): RefundPortInput {
  if (!input || !validId(input.operationId) || !validId(input.merchantOrderNo) || !validId(input.sourceId) ||
    !validId(input.transactionId) || !validId(input.merchantRefundNo) || !validId(input.refundId) ||
    input.currency !== "CNY" || !Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) invalid();
  return Object.freeze({
    binding: bindingSnapshot(input.binding), operationId: input.operationId, merchantOrderNo: input.merchantOrderNo,
    sourceId: input.sourceId, transactionId: input.transactionId, merchantRefundNo: input.merchantRefundNo,
    refundId: input.refundId, amountCents: input.amountCents, currency: input.currency,
    // Keep pre-F15 bytes/hash unchanged; only newly supplied totals enter the immutable mock request.
    ...(input.originalPaymentCents === undefined ? {} : { originalPaymentCents: requireRefundOriginalPaymentCents(input) }),
  });
}
const paymentKey = (input: PaymentPortInput): MockChannelKey =>
  ({ kind: "PAYMENT", merchantId: input.binding.merchantId, merchantReference: input.merchantOrderNo });
const refundKey = (input: RefundPortInput): MockChannelKey =>
  ({ kind: "REFUND", merchantId: input.binding.merchantId, merchantReference: input.merchantRefundNo });
function matchingRecord(record: MockChannelRecord, key: MockChannelKey, input: PaymentPortInput | RefundPortInput): boolean {
  return record.kind === key.kind && record.merchantId === key.merchantId &&
    record.merchantReference === key.merchantReference && record.requestHash === digest(input);
}

/** Local simulator only. It never represents a live merchant or makes an external network call. */
export class LocalMockPaymentGateway extends TrustedPaymentProvider {
  readonly provider = "MOCK" as const;
  readonly simulation = true;
  constructor(
    private readonly signingSecret: string,
    mode: "local-simulation",
    private readonly store?: MockChannelStore,
  ) {
    super();
    if (mode !== "local-simulation" || process.env.NODE_ENV === "production" || signingSecret.length < 32)
      throw new Error("Local payment simulator requires explicit local mode and a private signing secret");
  }
  withStore(store: MockChannelStore): LocalMockPaymentGateway {
    return new LocalMockPaymentGateway(this.signingSecret, "local-simulation", store);
  }
  /** Legacy local tests only. Production bindings are resolved and snapshotted by the business service. */
  merchantForTenant(tenantId: string): string { return `mock:${tenantId}`; }
  signForLocalSimulator(payload: MockPaymentPayload | MockRefundPayload): { body: string; signature: string } {
    const body = JSON.stringify(payload);
    return { body, signature: createHmac("sha256", this.signingSecret).update(body).digest("hex") };
  }
  private signedPayload(body: string, signature: string): (PaymentEventData | RefundEventData) & { operationId?: string } {
    if (typeof body !== "string" || Buffer.byteLength(body) > 16384 || !/^[a-f0-9]{64}$/.test(signature)) invalid();
    const expected = createHmac("sha256", this.signingSecret).update(body).digest();
    if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) invalid();
    let payload: PaymentEventData | RefundEventData;
    try { payload = JSON.parse(body) as PaymentEventData | RefundEventData; } catch { return invalid(); }
    if (!payload || payload.provider !== "MOCK" || !Number.isSafeInteger(payload.issuedAt) ||
      Math.abs(Date.now() - payload.issuedAt) > 300000) invalid();
    return payload;
  }
  verify(body: string, signature: string): VerifiedPaymentEvent {
    const payload = this.signedPayload(body, signature);
    if ("eventType" in payload) invalid();
    return this.certifyPaymentEvent(payload);
  }
  verifyRefund(body: string, signature: string): VerifiedRefundEvent {
    const payload = this.signedPayload(body, signature);
    if (!("eventType" in payload) || payload.eventType !== "REFUND") invalid();
    return this.certifyRefundEvent(payload);
  }
  async verifyNotification(input: PaymentNotificationInput): Promise<VerifiedPaymentNotification | VerifiedRefundNotification> {
    const binding = bindingSnapshot(input.binding);
    const payload = this.signedPayload(input.rawBody, input.headers["x-mock-signature"] ?? "");
    if (payload.merchantId !== binding.merchantId || !validId(payload.operationId)) invalid();
    const context = { bindingId: binding.id, bindingVersion: binding.version, operationId: payload.operationId };
    return "eventType" in payload
      ? { kind: "REFUND", ...context, event: this.certifyRefundEvent(payload) }
      : { kind: "PAYMENT", ...context, event: this.certifyPaymentEvent(payload) };
  }
  private paymentResult(record: MockChannelRecord, input: PaymentPortInput): PaymentCreateResult {
    if (!matchingRecord(record, paymentKey(input), input)) return unknown("MOCK_REQUEST_CONFLICT");
    if (record.outcome === null)
      return { status: "PENDING", checkout: { kind: "LOCAL_SIMULATION", operationId: input.operationId, expiresAt: input.expiresAt } };
    if (record.outcome.kind !== "PAYMENT") return unknown("MOCK_STORED_RESULT_INVALID");
    const data = record.outcome.event;
    if (data.paymentId !== input.sourceId || data.merchantId !== input.binding.merchantId ||
      data.amountCents !== input.amountCents || data.currency !== input.currency) return unknown("MOCK_STORED_RESULT_INVALID");
    const event = this.certifyPaymentEvent(data);
    return event.status === "SUCCEEDED" ? { status: "SUCCEEDED", event } : { status: "DEFINITIVELY_FAILED", event };
  }
  private refundResult(record: MockChannelRecord, input: RefundPortInput): RefundCreateResult {
    if (!matchingRecord(record, refundKey(input), input)) return unknown("MOCK_REQUEST_CONFLICT");
    if (record.outcome === null) return { status: "PENDING" };
    if (record.outcome.kind !== "REFUND") return unknown("MOCK_STORED_RESULT_INVALID");
    const data = record.outcome.event;
    if (data.refundId !== input.refundId || data.merchantId !== input.binding.merchantId ||
      (data.transactionId !== undefined && data.transactionId !== input.transactionId) ||
      data.amountCents !== input.amountCents || data.currency !== input.currency) return unknown("MOCK_STORED_RESULT_INVALID");
    const event = this.certifyRefundEvent(data);
    return event.status === "SUCCEEDED" ? { status: "SUCCEEDED", event } : { status: "DEFINITIVELY_FAILED", event };
  }
  async createPayment(value: PaymentPortInput): Promise<PaymentCreateResult> {
    const input = paymentInput(value);
    if (!this.store) return unknown("MOCK_STORE_UNAVAILABLE");
    try {
      const record = await this.store.putIfAbsent({ ...paymentKey(input), requestHash: digest(input), input, outcome: null });
      return this.paymentResult(record, input);
    } catch { return unknown("MOCK_STORE_UNAVAILABLE"); }
  }
  async queryPayment(value: PaymentPortInput): Promise<PaymentQueryResult> {
    const input = paymentInput(value);
    if (!this.store) return unknown("MOCK_STORE_UNAVAILABLE");
    try {
      const record = await this.store.get(paymentKey(input));
      return record ? this.paymentResult(record, input) : { status: "NOT_FOUND" };
    } catch { return unknown("MOCK_STORE_UNAVAILABLE"); }
  }
  async createRefund(value: RefundPortInput): Promise<RefundCreateResult> {
    const input = refundInput(value);
    if (!this.store) return unknown("MOCK_STORE_UNAVAILABLE");
    try {
      const record = await this.store.putIfAbsent({ ...refundKey(input), requestHash: digest(input), input, outcome: null });
      return this.refundResult(record, input);
    } catch { return unknown("MOCK_STORE_UNAVAILABLE"); }
  }
  async queryRefund(value: RefundPortInput): Promise<RefundQueryResult> {
    const input = refundInput(value);
    if (!this.store) return unknown("MOCK_STORE_UNAVAILABLE");
    try {
      const record = await this.store.get(refundKey(input));
      return record ? this.refundResult(record, input) : { status: "NOT_FOUND" };
    } catch { return unknown("MOCK_STORE_UNAVAILABLE"); }
  }
  async simulatePayment(value: PaymentPortInput, status: "SUCCEEDED" | "FAILED"): Promise<PaymentCreateResult> {
    const input = paymentInput(value);
    if (!["SUCCEEDED", "FAILED"].includes(status)) invalid();
    const current = await this.createPayment(input);
    if (current.status === "UNKNOWN" || current.status === "SUCCEEDED" ||
      (current.status === "DEFINITIVELY_FAILED" && status === "FAILED")) return current;
    const event: MockPaymentPayload = {
      provider: "MOCK", merchantId: input.binding.merchantId, paymentId: input.sourceId, operationId: input.operationId,
      eventId: `mock-payment-event:${digest([input.operationId, status])}`, status, amountCents: input.amountCents,
      currency: input.currency, issuedAt: Date.now(),
      ...(status === "SUCCEEDED" ? { transactionId: `mock-payment:${digest(input.operationId)}` } : {}),
    };
    try {
      const record = await this.store!.recordOutcome(paymentKey(input), digest(input), { kind: "PAYMENT", event });
      return this.paymentResult(record, input);
    } catch { return unknown("MOCK_STORE_UNAVAILABLE"); }
  }
  async simulateRefund(value: RefundPortInput, status: "SUCCEEDED" | "FAILED"): Promise<RefundCreateResult> {
    const input = refundInput(value);
    if (!["SUCCEEDED", "FAILED"].includes(status)) invalid();
    const current = await this.createRefund(input);
    if (current.status === "UNKNOWN" || current.status === "SUCCEEDED" || current.status === "DEFINITIVELY_FAILED") return current;
    const event: MockRefundPayload = {
      eventType: "REFUND", provider: "MOCK", merchantId: input.binding.merchantId, refundId: input.refundId, operationId: input.operationId,
      eventId: `mock-refund-event:${digest([input.operationId, status])}`, transactionId: input.transactionId,
      status, amountCents: input.amountCents, currency: input.currency, issuedAt: Date.now(),
      ...(status === "SUCCEEDED" ? { providerRefundId: `mock-refund:${digest(input.operationId)}` } : {}),
    };
    try {
      const record = await this.store!.recordOutcome(refundKey(input), digest(input), { kind: "REFUND", event });
      return this.refundResult(record, input);
    } catch { return unknown("MOCK_STORE_UNAVAILABLE"); }
  }
}
