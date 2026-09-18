import { createHash } from "node:crypto";
import { TennisWalletError } from "../../../domain/src/tennis-wallet.ts";
import type { MerchantBindingSnapshot } from "./merchant-bindings.ts";

export type PaymentProvider = "MOCK" | "WECHAT";
export interface PaymentPortInput {
  binding: MerchantBindingSnapshot;
  operationId: string;
  merchantOrderNo: string;
  sourceKind: "ORDER" | "TOPUP";
  sourceId: string;
  amountCents: number;
  currency: "CNY";
  expiresAt: string;
}
/** Definitively failed refund numbers are closed. Authorized retries use a new operationId and merchantRefundNo. */
export interface RefundPortInput {
  binding: MerchantBindingSnapshot;
  operationId: string;
  merchantOrderNo: string;
  sourceId: string;
  transactionId: string;
  merchantRefundNo: string;
  refundId: string;
  amountCents: number;
  currency: "CNY";
}
/** This release has no live provider: no payment URL or QR data is invented. */
export interface CheckoutAction {
  kind: "LOCAL_SIMULATION";
  operationId: string;
  expiresAt: string;
}
export interface PaymentEventData {
  provider: PaymentProvider;
  merchantId: string;
  paymentId: string;
  eventId: string;
  transactionId?: string;
  status: "SUCCEEDED" | "FAILED";
  amountCents: number;
  currency: "CNY";
  /** Observation/envelope timestamp, not part of the stable financial semantics. */
  issuedAt: number;
}
export interface RefundEventData {
  eventType: "REFUND";
  provider: PaymentProvider;
  merchantId: string;
  refundId: string;
  eventId: string;
  transactionId?: string;
  providerRefundId?: string;
  status: "SUCCEEDED" | "FAILED";
  amountCents: number;
  currency: "CNY";
  issuedAt: number;
}
const paymentBrand = Symbol("authenticated payment observation");
const refundBrand = Symbol("authenticated refund observation");
const trustedPayments = new WeakSet<object>();
const trustedRefunds = new WeakSet<object>();
type PaymentBrand = { readonly [paymentBrand]: true };
type RefundBrand = { readonly [refundBrand]: true };
export type VerifiedPaymentSuccessEvent = Readonly<PaymentEventData & { status: "SUCCEEDED"; transactionId: string }> & PaymentBrand;
export type VerifiedPaymentFailureEvent = Readonly<PaymentEventData & { status: "FAILED" }> & PaymentBrand;
export type VerifiedPaymentEvent = VerifiedPaymentSuccessEvent | VerifiedPaymentFailureEvent;
export type VerifiedRefundSuccessEvent = Readonly<RefundEventData & { status: "SUCCEEDED"; transactionId: string; providerRefundId: string }> & RefundBrand;
export type VerifiedRefundFailureEvent = Readonly<RefundEventData & { status: "FAILED" }> & RefundBrand;
export type VerifiedRefundEvent = VerifiedRefundSuccessEvent | VerifiedRefundFailureEvent;
export function isVerifiedPaymentEvent(value: unknown): value is VerifiedPaymentEvent {
  return typeof value === "object" && value !== null && trustedPayments.has(value);
}
export function isVerifiedRefundEvent(value: unknown): value is VerifiedRefundEvent {
  return typeof value === "object" && value !== null && trustedRefunds.has(value);
}
export type PaymentCreateResult =
  | { status: "PENDING"; checkout?: CheckoutAction }
  | { status: "SUCCEEDED"; event: VerifiedPaymentSuccessEvent }
  | { status: "DEFINITIVELY_FAILED"; event: VerifiedPaymentFailureEvent }
  | { status: "UNKNOWN"; code: string };
export type PaymentQueryResult = PaymentCreateResult | { status: "NOT_FOUND" };
export type RefundCreateResult =
  | { status: "PENDING" }
  | { status: "SUCCEEDED"; event: VerifiedRefundSuccessEvent }
  | { status: "DEFINITIVELY_FAILED"; event: VerifiedRefundFailureEvent }
  | { status: "UNKNOWN"; code: string };
export type RefundQueryResult = RefundCreateResult | { status: "NOT_FOUND" };
export type VerifiedPaymentNotification = {
  kind: "PAYMENT";
  bindingId: string;
  bindingVersion: number;
  /** Must be recovered from authenticated provider metadata, never copied from the callback URL. */
  operationId: string;
  event: VerifiedPaymentEvent;
};
export type VerifiedRefundNotification = {
  kind: "REFUND";
  bindingId: string;
  bindingVersion: number;
  /** Must be recovered from authenticated provider metadata, never copied from the callback URL. */
  operationId: string;
  event: VerifiedRefundEvent;
};
export interface PaymentNotificationInput {
  binding: MerchantBindingSnapshot;
  rawBody: string;
  headers: Readonly<Record<string, string | undefined>>;
}
/** Inputs come from durable server-side facts, never from caller-reported money or merchant identity. */
export interface PaymentProviderPort {
  readonly provider: PaymentProvider;
  readonly simulation: boolean;
  createPayment(input: PaymentPortInput): Promise<PaymentCreateResult>;
  queryPayment(input: PaymentPortInput): Promise<PaymentQueryResult>;
  createRefund(input: RefundPortInput): Promise<RefundCreateResult>;
  queryRefund(input: RefundPortInput): Promise<RefundQueryResult>;
  verifyNotification(input: PaymentNotificationInput): Promise<VerifiedPaymentNotification | VerifiedRefundNotification>;
}
const validId = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 200;
function invalid(): never { throw new TennisWalletError("INVALID_PAYMENT_EVENT"); }
function validateCommon(input: PaymentEventData | RefundEventData): void {
  if (!input || !["MOCK", "WECHAT"].includes(input.provider) || !validId(input.merchantId) ||
    !validId(input.eventId) || !["SUCCEEDED", "FAILED"].includes(input.status) || input.currency !== "CNY" ||
    !Number.isSafeInteger(input.amountCents) || input.amountCents <= 0 ||
    !Number.isSafeInteger(input.issuedAt) || input.issuedAt <= 0 ||
    (input.transactionId !== undefined && !validId(input.transactionId)) ||
    (input.status === "SUCCEEDED" && !validId(input.transactionId))) invalid();
}
function paymentFacts(input: PaymentEventData): Omit<PaymentEventData, "issuedAt"> {
  return {
    provider: input.provider, merchantId: input.merchantId, paymentId: input.paymentId, eventId: input.eventId,
    status: input.status, amountCents: input.amountCents, currency: input.currency,
    ...(input.transactionId === undefined ? {} : { transactionId: input.transactionId }),
  };
}
function refundFacts(input: RefundEventData): Omit<RefundEventData, "issuedAt"> {
  return {
    eventType: "REFUND", provider: input.provider, merchantId: input.merchantId, refundId: input.refundId,
    eventId: input.eventId, status: input.status, amountCents: input.amountCents, currency: input.currency,
    ...(input.transactionId === undefined ? {} : { transactionId: input.transactionId }),
    ...(input.providerRefundId === undefined ? {} : { providerRefundId: input.providerRefundId }),
  };
}
/** Stable across retries with a new signed-envelope timestamp; callers still bind eventId to this hash. */
export function paymentEventSemanticHash(input: PaymentEventData): string {
  return createHash("sha256").update(JSON.stringify(paymentFacts(input))).digest("hex");
}
export function refundEventSemanticHash(input: RefundEventData): string {
  return createHash("sha256").update(JSON.stringify(refundFacts(input))).digest("hex");
}
/** Only provider implementations may certify observations, after authenticating the provider or trusted store. */
export abstract class TrustedPaymentProvider implements PaymentProviderPort {
  abstract readonly provider: PaymentProvider;
  abstract readonly simulation: boolean;
  abstract createPayment(input: PaymentPortInput): Promise<PaymentCreateResult>;
  abstract queryPayment(input: PaymentPortInput): Promise<PaymentQueryResult>;
  abstract createRefund(input: RefundPortInput): Promise<RefundCreateResult>;
  abstract queryRefund(input: RefundPortInput): Promise<RefundQueryResult>;
  abstract verifyNotification(input: PaymentNotificationInput): Promise<VerifiedPaymentNotification | VerifiedRefundNotification>;
  protected certifyPaymentEvent(input: PaymentEventData): VerifiedPaymentEvent {
    validateCommon(input);
    if (input.provider !== this.provider || !validId(input.paymentId)) invalid();
    const event = Object.freeze({ ...paymentFacts(input), issuedAt: input.issuedAt, [paymentBrand]: true as const });
    trustedPayments.add(event);
    return event as VerifiedPaymentEvent;
  }
  protected certifyRefundEvent(input: RefundEventData): VerifiedRefundEvent {
    validateCommon(input);
    if (input.provider !== this.provider || input.eventType !== "REFUND" || !validId(input.refundId) ||
      (input.providerRefundId !== undefined && !validId(input.providerRefundId)) ||
      (input.status === "SUCCEEDED" && !validId(input.providerRefundId))) invalid();
    const event = Object.freeze({ ...refundFacts(input), issuedAt: input.issuedAt, [refundBrand]: true as const });
    trustedRefunds.add(event);
    return event as VerifiedRefundEvent;
  }
}
