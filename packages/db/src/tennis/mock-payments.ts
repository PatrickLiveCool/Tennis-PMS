import { createHmac, timingSafeEqual } from "node:crypto";
import { TennisWalletError } from "../../../domain/src/tennis-wallet.ts";

const verified = Symbol("verified payment event");
const verifiedRefund = Symbol("verified refund event");
export interface MockPaymentPayload {
  provider: "MOCK";
  merchantId: string;
  paymentId: string;
  eventId: string;
  transactionId: string;
  status: "SUCCEEDED" | "FAILED";
  amountCents: number;
  currency: "CNY";
  issuedAt: number;
}
export type VerifiedPaymentEvent = Readonly<MockPaymentPayload> & { readonly [verified]: true };
export function isVerifiedPaymentEvent(event: VerifiedPaymentEvent): boolean {
  return !!event && event[verified] === true;
}
export interface MockRefundPayload {
  eventType: "REFUND";
  provider: "MOCK";
  merchantId: string;
  refundId: string;
  eventId: string;
  transactionId: string;
  providerRefundId: string;
  status: "SUCCEEDED" | "FAILED";
  amountCents: number;
  currency: "CNY";
  issuedAt: number;
}
export type VerifiedRefundEvent = Readonly<MockRefundPayload> & { readonly [verifiedRefund]: true };
export function isVerifiedRefundEvent(event: VerifiedRefundEvent): boolean {
  return !!event && event[verifiedRefund] === true;
}

/** Local simulator only. No real merchant or WeChat payment is represented by this class. */
export class LocalMockPaymentGateway {
  readonly provider = "MOCK" as const;
  constructor(
    private readonly signingSecret: string,
    mode: "local-simulation",
  ) {
    if (mode !== "local-simulation" || process.env.NODE_ENV === "production" || signingSecret.length < 32)
      throw new Error("Local payment simulator requires explicit local mode and a private signing secret");
  }
  merchantForTenant(tenantId: string): string {
    return `mock:${tenantId}`;
  }
  signForLocalSimulator(payload: MockPaymentPayload | MockRefundPayload): { body: string; signature: string } {
    const body = JSON.stringify(payload);
    return { body, signature: createHmac("sha256", this.signingSecret).update(body).digest("hex") };
  }
  verify(body: string, signature: string): VerifiedPaymentEvent {
    const invalid = () => {
      throw new TennisWalletError("INVALID_PAYMENT_EVENT");
    };
    if (body.length > 16384 || !/^[a-f0-9]{64}$/.test(signature)) return invalid();
    const expected = createHmac("sha256", this.signingSecret).update(body).digest();
    if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) return invalid();
    let payload: MockPaymentPayload;
    try {
      payload = JSON.parse(body) as MockPaymentPayload;
    } catch {
      return invalid();
    }
    if (
      !payload ||
      payload.provider !== "MOCK" ||
      payload.currency !== "CNY" ||
      !["SUCCEEDED", "FAILED"].includes(payload.status) ||
      !Number.isSafeInteger(payload.amountCents) ||
      payload.amountCents <= 0 ||
      !Number.isSafeInteger(payload.issuedAt) ||
      Math.abs(Date.now() - payload.issuedAt) > 300000 ||
      [payload.merchantId, payload.paymentId, payload.eventId, payload.transactionId].some(
        (value) => typeof value !== "string" || !value.trim() || value.length > 200,
      )
    )
      return invalid();
    return Object.freeze({ ...payload, [verified]: true as const });
  }
  verifyRefund(body: string, signature: string): VerifiedRefundEvent {
    const invalid = () => {
      throw new TennisWalletError("INVALID_PAYMENT_EVENT");
    };
    if (body.length > 16384 || !/^[a-f0-9]{64}$/.test(signature)) return invalid();
    const expected = createHmac("sha256", this.signingSecret).update(body).digest();
    if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) return invalid();
    let payload: MockRefundPayload;
    try {
      payload = JSON.parse(body) as MockRefundPayload;
    } catch {
      return invalid();
    }
    if (
      !payload ||
      payload.eventType !== "REFUND" ||
      payload.provider !== "MOCK" ||
      payload.currency !== "CNY" ||
      !["SUCCEEDED", "FAILED"].includes(payload.status) ||
      !Number.isSafeInteger(payload.amountCents) ||
      payload.amountCents <= 0 ||
      !Number.isSafeInteger(payload.issuedAt) ||
      Math.abs(Date.now() - payload.issuedAt) > 300000 ||
      [payload.merchantId, payload.refundId, payload.eventId, payload.transactionId, payload.providerRefundId].some(
        (value) => typeof value !== "string" || !value.trim() || value.length > 200,
      )
    )
      return invalid();
    return Object.freeze({ ...payload, [verifiedRefund]: true as const });
  }
}
