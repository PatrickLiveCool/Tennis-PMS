import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertLocalTennisDatabaseUrl, localTennisTestDatabaseUrl } from "../../packages/db/src/tennis/local-config.ts";
import { migrateTennis } from "../../packages/db/src/tennis/migrate.ts";
import {
  createCourt,
  createVenue,
  listVenues,
  setCourtPrice,
  updateVenue,
} from "../../packages/db/src/tennis/catalog.ts";
import { createCustomer, type CustomerActor } from "../../packages/db/src/tennis/customers.ts";
import { cancelUnpaidOrder, confirmQuote, createQuote, getOrder } from "../../packages/db/src/tennis/booking.ts";
import { beginOrderPayment, settleVerifiedPayment, type PaymentRecord } from "../../packages/db/src/tennis/payments.ts";
import { getWallet, recordOfflineTopup } from "../../packages/db/src/tennis/wallet.ts";
import {
  beginTopupPayment,
  createTopupQuote,
  saveTopupOffer,
  settleVerifiedTopup,
} from "../../packages/db/src/tennis/topups.ts";
import {
  getRefund,
  requestOrderRefund,
  settleVerifiedRefund,
  type RefundRecord,
} from "../../packages/db/src/tennis/refunds.ts";
import {
  LocalMockPaymentGateway,
  type MockPaymentPayload,
  type MockRefundPayload,
} from "../../packages/db/src/tennis/mock-payments.ts";
import { postgresMockChannelStore } from "../../packages/db/src/tennis/mock-channel-store.ts";
import {
  getPaymentChannel,
  reconcilePaymentChannel,
  simulatePaymentChannel,
} from "../../packages/db/src/tennis/payment-channel.ts";
import { listMerchantBindings, saveMerchantBinding } from "../../packages/db/src/tennis/merchant-bindings.ts";
import { type RefundPortInput, type VerifiedRefundEvent } from "../../packages/db/src/tennis/payment-port.ts";
import {
  getCashException,
  getExceptionRefund,
  requestExceptionRefund,
  retryExceptionRefund,
  settleVerifiedExceptionRefund,
  type ExceptionRefundRecord,
} from "../../packages/db/src/tennis/exception-refunds.ts";
import { enqueueExceptionRefundChannel } from "../../packages/db/src/tennis/channel-intents.ts";
import { requestHash } from "../../packages/db/src/tennis/receipts.ts";
import { removeTenantFixture, seedTenantFixture, type TenantFixture } from "./tenant-fixture.ts";

const db = new pg.Pool({
  connectionString: assertLocalTennisDatabaseUrl(
    process.env.TENNIS_TEST_DATABASE_URL ?? localTennisTestDatabaseUrl,
    "test",
  ),
  max: 8,
  connectionTimeoutMillis: 5000,
  statement_timeout: 10000,
});
const gateway = new LocalMockPaymentGateway(
  "synthetic-exception-refund-test-secret",
  "local-simulation",
  postgresMockChannelStore(db),
);
const hours = Array.from({ length: 7 }, (_, weekday) => ({ weekday, startMinute: 480, endMinute: 1320 }));
const key = () => randomUUID();
const subjects: string[] = [];
let first: TenantFixture, second: TenantFixture;
let customer: CustomerActor;
let courtId: string;

type ExceptionKind = "LATE_PAYMENT" | "DUPLICATE_PAYMENT" | "EXTRA_TOPUP_RECEIPT";
async function order() {
  const quote = await createQuote(db, customer, {
    venueId: first.venueId,
    customerId: customer.customerId,
    lines: [{ courtId, startAt: "2099-09-18T19:00:00+08:00", endAt: "2099-09-18T20:00:00+08:00" }],
  });
  return confirmQuote(db, customer, { quoteId: quote.id, commandKey: key() });
}
function paymentEvent(
  input: { id: string; merchantId: string; amountCents: number },
  overrides: Partial<MockPaymentPayload> = {},
) {
  const signed = gateway.signForLocalSimulator({
    provider: "MOCK",
    paymentId: input.id,
    merchantId: input.merchantId,
    eventId: key(),
    transactionId: key(),
    status: "SUCCEEDED",
    amountCents: input.amountCents,
    currency: "CNY",
    issuedAt: Date.now(),
    ...overrides,
  });
  return gateway.verify(signed.body, signed.signature);
}
function exceptionEvent(refund: ExceptionRefundRecord, overrides: Partial<MockRefundPayload> = {}) {
  const signed = gateway.signForLocalSimulator({
    eventType: "REFUND",
    provider: "MOCK",
    merchantId: refund.merchantId,
    refundId: refund.id,
    eventId: key(),
    transactionId: refund.transactionId,
    providerRefundId: key(),
    status: "SUCCEEDED",
    amountCents: refund.amountCents,
    currency: "CNY",
    issuedAt: Date.now(),
    ...overrides,
  });
  return gateway.verifyRefund(signed.body, signed.signature);
}
function ordinaryEvent(refund: RefundRecord, payment: PaymentRecord, overrides: Partial<MockRefundPayload> = {}) {
  const signed = gateway.signForLocalSimulator({
    eventType: "REFUND",
    provider: "MOCK",
    merchantId: payment.merchantId,
    refundId: refund.id,
    eventId: key(),
    transactionId: payment.providerTransactionId!,
    providerRefundId: key(),
    status: "SUCCEEDED",
    amountCents: refund.externalCents,
    currency: "CNY",
    issuedAt: Date.now(),
    ...overrides,
  });
  return gateway.verifyRefund(signed.body, signed.signature);
}
async function createException(kind: ExceptionKind) {
  if (kind === "EXTRA_TOPUP_RECEIPT") {
    const offer = await saveTopupOffer(db, first.actor, {
      name: "合成充值档位",
      principalCents: 5000,
      giftCents: 1000,
      active: true,
    });
    const quote = await createTopupQuote(db, customer, {
      venueId: first.venueId,
      customerId: customer.customerId,
      offerId: offer.id,
    });
    const topup = await beginTopupPayment(db, customer, gateway, { quoteId: quote.id, commandKey: key() });
    const success = paymentEvent({ ...topup, amountCents: topup.principalCents });
    await settleVerifiedTopup(db, success);
    const extra = paymentEvent({ ...topup, amountCents: topup.principalCents });
    await settleVerifiedTopup(db, extra);
    const id = (
      await db.query<{ id: string }>("SELECT id FROM tennis.topup_exceptions WHERE tenant_id=$1 AND topup_id=$2", [
        first.actor.tenantId,
        topup.id,
      ])
    ).rows[0]!.id;
    return { exception: await getCashException(db, first.actor, id), payment: null };
  }
  await recordOfflineTopup(db, first.actor, {
    venueId: first.venueId,
    customerId: customer.customerId,
    principalCents: 5000,
    giftCents: 1000,
    receiptReference: key(),
    reason: "合成实收凭据",
    commandKey: key(),
  });
  const booking = await order();
  const pending = await beginOrderPayment(db, customer, gateway, {
    orderId: booking.id,
    walletCents: 6000,
    commandKey: key(),
  });
  let payment = pending;
  if (kind === "LATE_PAYMENT") {
    await cancelUnpaidOrder(db, customer, {
      orderId: booking.id,
      expectedRevision: booking.revision,
      commandKey: key(),
      reason: "客户取消未付款预约",
    });
    await order();
  } else {
    payment = await settleVerifiedPayment(db, paymentEvent({ ...pending, amountCents: pending.externalCents }));
  }
  const extra = paymentEvent({ ...pending, amountCents: pending.externalCents });
  await settleVerifiedPayment(db, extra);
  const id = (
    await db.query<{ id: string }>(
      "SELECT id FROM tennis.financial_exceptions WHERE tenant_id=$1 AND payment_id=$2 AND kind=$3",
      [first.actor.tenantId, pending.id, kind],
    )
  ).rows[0]!.id;
  return { exception: await getCashException(db, first.actor, id), payment };
}
async function businessState() {
  const rows = await Promise.all(
    ["orders", "order_lines", "occupancies", "payment_attempts", "topup_payments"].map(
      async (table) =>
        (await db.query(`SELECT * FROM tennis.${table} WHERE tenant_id=$1 ORDER BY id`, [first.actor.tenantId])).rows,
    ),
  );
  return { wallet: await getWallet(db, customer, customer.customerId), rows };
}
async function channelOperation(id: string) {
  return (
    await db.query<{ id: string; generation: number; state: string; request: RefundPortInput }>(
      "SELECT id,generation,state,request FROM tennis.channel_operations WHERE tenant_id=$1 AND source_id=$2 ORDER BY generation DESC LIMIT 1",
      [first.actor.tenantId, id],
    )
  ).rows[0]!;
}
function request(exception: { id: string; amountCents: number }, commandKey = key()) {
  return {
    exceptionId: exception.id,
    amountCents: exception.amountCents,
    reason: "人工核对多收现金，按原交易全额退回",
    commandKey,
  };
}
beforeAll(async () => {
  const tx = await db.connect();
  try {
    await migrateTennis(tx);
  } finally {
    tx.release();
  }
});
beforeEach(async () => {
  first = await seedTenantFixture(db);
  second = await seedTenantFixture(db);
  const venue = (await listVenues(db, first.actor))[0]!;
  await updateVenue(db, first.actor, {
    ...venue,
    expectedRevision: venue.catalogRevision,
    openingHours: hours,
    minimumBookingMinutes: 15,
  });
  const court = await createCourt(db, first.actor, { venueId: first.venueId, name: "异常退款测试球场", indoor: true });
  courtId = court.id;
  await setCourtPrice(db, first.actor, {
    venueId: first.venueId,
    courtId,
    expectedRevision: court.revision,
    hourlyPriceCents: 12000,
  });
  const profile = await createCustomer(db, first.actor, { nickname: "异常实收客户" });
  const subjectId = key();
  subjects.push(subjectId);
  await db.query("INSERT INTO tennis.subjects(id,display_name) VALUES($1,'synthetic cash exception customer')", [
    subjectId,
  ]);
  await db.query("UPDATE tennis.customers SET subject_id=$1 WHERE tenant_id=$2 AND id=$3", [
    subjectId,
    first.actor.tenantId,
    profile.id,
  ]);
  customer = { tenantId: first.actor.tenantId, subjectId, customerId: profile.id, kind: "customer" };
});
afterEach(async () => {
  if (first) {
    await db.query("DELETE FROM tennis.platform_operators WHERE subject_id=$1", [first.actor.subjectId]);
    await removeTenantFixture(db, first);
  }
  if (second) await removeTenantFixture(db, second);
  for (const id of subjects.splice(0)) await db.query("DELETE FROM tennis.subjects WHERE id=$1", [id]);
});
afterAll(() => db.end());

describe("verified excess cash refunds", () => {
  it.each<ExceptionKind>(["LATE_PAYMENT", "DUPLICATE_PAYMENT", "EXTRA_TOPUP_RECEIPT"])(
    "returns only the original %s cash and never changes wallets or occupied courts",
    async (kind) => {
      const { exception } = await createException(kind);
      const before = await businessState();
      expect(exception.amountCents).toBe(kind === "EXTRA_TOPUP_RECEIPT" ? 5000 : 6000);
      expect(before.wallet.balance).toMatchObject({
        totalCents: kind === "DUPLICATE_PAYMENT" ? 0 : 6000,
        reservedCents: 0,
      });
      const refund = await requestExceptionRefund(db, first.actor, request(exception));
      expect(refund).toMatchObject({
        exceptionId: exception.id,
        amountCents: exception.amountCents,
        transactionId: exception.transactionId,
        merchantId: exception.merchantId,
        status: "REQUESTED",
      });
      expect((await getCashException(db, first.actor, exception.id)).status).toBe("OPEN");
      const op = await channelOperation(refund.id);
      expect(op.request).toMatchObject({
        refundId: refund.id,
        sourceId: exception.sourceId,
        transactionId: exception.transactionId,
        amountCents: exception.amountCents,
        originalPaymentCents: exception.amountCents,
        binding: { merchantId: exception.merchantId },
      });
      expect(await businessState()).toEqual(before);
      const event = exceptionEvent(refund);
      const results = await Promise.all([
        settleVerifiedExceptionRefund(db, event),
        settleVerifiedExceptionRefund(db, event),
      ]);
      expect(results[0]).toEqual(results[1]);
      expect(results[0]).toMatchObject({ status: "SUCCEEDED", providerRefundId: event.providerRefundId });
      expect((await getCashException(db, first.actor, exception.id)).status).toBe("RESOLVED");
      expect(await businessState()).toEqual(before);
      expect(
        (await db.query("SELECT 1 FROM tennis.cash_refund_transactions WHERE tenant_id=$1", [first.actor.tenantId]))
          .rowCount,
      ).toBe(1);
    },
  );
  it("concurrent same and different command keys create one internal refund and one channel intent", async () => {
    const { exception } = await createException("DUPLICATE_PAYMENT");
    const input = request(exception);
    const results = await Promise.all([
      requestExceptionRefund(db, first.actor, input),
      requestExceptionRefund(db, first.actor, input),
      requestExceptionRefund(db, first.actor, { ...input, commandKey: key() }),
    ]);
    expect(new Set(results.map((row) => row.id)).size).toBe(1);
    expect(
      (await db.query("SELECT id FROM tennis.exception_refunds WHERE tenant_id=$1", [first.actor.tenantId])).rowCount,
    ).toBe(1);
    expect(
      (
        await db.query("SELECT id FROM tennis.channel_operations WHERE tenant_id=$1 AND source_id=$2", [
          first.actor.tenantId,
          results[0]!.id,
        ])
      ).rowCount,
    ).toBe(1);
    await expect(requestExceptionRefund(db, first.actor, { ...input, reason: "修改原命令内容" })).rejects.toMatchObject(
      { code: "IDEMPOTENCY_KEY_REUSED" },
    );
  });
  it("requires the entire verified cash amount and a reason before writing a refund", async () => {
    const { exception } = await createException("LATE_PAYMENT");
    for (const amountCents of [0, -1, 1.5, exception.amountCents - 1, exception.amountCents + 1]) {
      await expect(
        requestExceptionRefund(db, first.actor, { ...request(exception), amountCents }),
      ).rejects.toMatchObject({ code: "INVALID_EXCEPTION_REFUND" });
    }
    await expect(
      requestExceptionRefund(db, first.actor, { ...request(exception), reason: "   " }),
    ).rejects.toMatchObject({ code: "INVALID_EXCEPTION_REFUND" });
    expect(
      (await db.query("SELECT id FROM tennis.exception_refunds WHERE tenant_id=$1", [first.actor.tenantId])).rowCount,
    ).toBe(0);
  });
  it("uses verified receipt amounts instead of display details and rejects unreceived cash", async () => {
    const { exception } = await createException("DUPLICATE_PAYMENT");
    await db.query("UPDATE tennis.financial_exceptions SET details=$1::jsonb WHERE tenant_id=$2 AND id=$3", [
      JSON.stringify({ externalCents: 999999, merchantId: "not-the-captured-merchant" }),
      first.actor.tenantId,
      exception.id,
    ]);
    expect(await getCashException(db, first.actor, exception.id)).toMatchObject({
      amountCents: 6000,
      merchantId: exception.merchantId,
      transactionId: exception.transactionId,
    });
    const forgedId = key();
    await db.query(
      `INSERT INTO tennis.financial_exceptions(id,tenant_id,payment_id,kind,external_transaction_id,details)
      SELECT $1,tenant_id,payment_id,'DUPLICATE_PAYMENT',$2,'{}'::jsonb FROM tennis.financial_exceptions WHERE tenant_id=$3 AND id=$4`,
      [forgedId, key(), first.actor.tenantId, exception.id],
    );
    await expect(
      requestExceptionRefund(db, first.actor, { ...request(exception), exceptionId: forgedId }),
    ).rejects.toMatchObject({ code: "EXCEPTION_NOT_REFUNDABLE" });
    expect(
      (await db.query("SELECT id FROM tennis.exception_refunds WHERE tenant_id=$1", [first.actor.tenantId])).rowCount,
    ).toBe(0);
  });
  it("rejects forged or mismatched refund results without closing the exception", async () => {
    const { exception, payment } = await createException("DUPLICATE_PAYMENT");
    const refund = await requestExceptionRefund(db, first.actor, request(exception));
    const before = await businessState();
    const event = exceptionEvent(refund);
    await expect(
      settleVerifiedExceptionRefund(db, JSON.parse(JSON.stringify(event)) as VerifiedRefundEvent),
    ).rejects.toMatchObject({ code: "INVALID_REFUND_EVENT" });
    for (const overrides of [
      { transactionId: key() },
      { transactionId: payment!.providerTransactionId! },
      { merchantId: `mock:${second.actor.tenantId}` },
      { amountCents: 1 },
    ]) {
      await expect(settleVerifiedExceptionRefund(db, exceptionEvent(refund, overrides))).rejects.toMatchObject({
        code: "INVALID_REFUND_EVENT",
      });
    }
    expect((await getExceptionRefund(db, first.actor, refund.id)).status).toBe("REQUESTED");
    expect((await getCashException(db, first.actor, exception.id)).status).toBe("OPEN");
    expect(await businessState()).toEqual(before);
  });
  it("keeps failed refunds open and retries the same cash with a new channel operation", async () => {
    const { exception } = await createException("LATE_PAYMENT");
    const before = await businessState();
    const refund = await requestExceptionRefund(db, first.actor, request(exception));
    await reconcilePaymentChannel(db, first.actor, "EXCEPTION_REFUND", refund.id, gateway);
    const original = await channelOperation(refund.id);
    await simulatePaymentChannel(db, first.actor, "EXCEPTION_REFUND", refund.id, gateway, "FAILED");
    expect(await getExceptionRefund(db, first.actor, refund.id)).toMatchObject({
      status: "FAILED",
      amountCents: exception.amountCents,
    });
    expect((await getCashException(db, first.actor, exception.id)).status).toBe("OPEN");
    expect(await businessState()).toEqual(before);
    const commandKey = key();
    const retries = await Promise.all([
      retryExceptionRefund(db, first.actor, refund.id, commandKey),
      retryExceptionRefund(db, first.actor, refund.id, commandKey),
    ]);
    expect(retries[0]).toEqual(retries[1]);
    const retried = await channelOperation(refund.id);
    expect(retried.generation).toBe(original.generation + 1);
    expect(retried.id).not.toBe(original.id);
    expect(retried.request.merchantRefundNo).not.toBe(original.request.merchantRefundNo);
    expect(retried.request).toMatchObject({
      transactionId: original.request.transactionId,
      amountCents: original.request.amountCents,
      originalPaymentCents: exception.amountCents,
      binding: original.request.binding,
    });
    await reconcilePaymentChannel(db, first.actor, "EXCEPTION_REFUND", refund.id, gateway);
    await simulatePaymentChannel(db, first.actor, "EXCEPTION_REFUND", refund.id, gateway, "SUCCEEDED");
    expect((await getCashException(db, first.actor, exception.id)).status).toBe("RESOLVED");
    expect((await getPaymentChannel(db, first.actor, "EXCEPTION_REFUND", refund.id, gateway)).state).toBe("SUCCEEDED");
    expect(await businessState()).toEqual(before);
  });
  it("refuses retry while the original result is pending", async () => {
    const { exception } = await createException("EXTRA_TOPUP_RECEIPT");
    const refund = await requestExceptionRefund(db, first.actor, request(exception));
    await expect(retryExceptionRefund(db, first.actor, refund.id, key())).rejects.toMatchObject({
      code: "REFUND_NOT_RETRYABLE",
    });
    expect(
      (
        await db.query("SELECT id FROM tennis.channel_operations WHERE tenant_id=$1 AND source_id=$2", [
          first.actor.tenantId,
          refund.id,
        ])
      ).rowCount,
    ).toBe(1);
  });
  it("rejects customers, unrelated tenants and staff lacking refund privileges", async () => {
    const { exception } = await createException("LATE_PAYMENT");
    await expect(requestExceptionRefund(db, customer, request(exception))).rejects.toMatchObject({
      code: "TENANT_ACCESS_DENIED",
    });
    await expect(requestExceptionRefund(db, second.actor, request(exception))).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
    });
    await expect(getCashException(db, second.actor, exception.id)).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
    });
    const refund = await requestExceptionRefund(db, first.actor, request(exception));
    await expect(getExceptionRefund(db, second.actor, refund.id)).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    await db.query(
      "UPDATE tennis.tenant_memberships SET role='STAFF',all_venues=true,permissions=ARRAY['read','manage_members'] WHERE tenant_id=$1",
      [first.actor.tenantId],
    );
    expect((await getCashException(db, first.actor, exception.id)).id).toBe(exception.id);
    await expect(requestExceptionRefund(db, first.actor, request(exception))).rejects.toMatchObject({
      code: "TENANT_ACCESS_DENIED",
    });
    await db.query(
      "UPDATE tennis.tenant_memberships SET role='VIEWER',permissions=ARRAY['read','refund'] WHERE tenant_id=$1",
      [first.actor.tenantId],
    );
    await expect(requestExceptionRefund(db, first.actor, request(exception))).rejects.toMatchObject({
      code: "TENANT_ACCESS_DENIED",
    });
    await expect(retryExceptionRefund(db, first.actor, refund.id, key())).rejects.toMatchObject({
      code: "TENANT_ACCESS_DENIED",
    });
  });
  it("does not expose or refund exceptions outside the authorized staff campus", async () => {
    const { exception } = await createException("EXTRA_TOPUP_RECEIPT");
    const refund = await requestExceptionRefund(db, first.actor, request(exception));
    const otherVenue = await createVenue(db, first.actor, { name: "仅授权此校区", timezone: "Asia/Shanghai" });
    await db.query(
      "UPDATE tennis.tenant_memberships SET role='STAFF',all_venues=false,permissions=ARRAY['read','refund','manage_members'] WHERE tenant_id=$1",
      [first.actor.tenantId],
    );
    await db.query("INSERT INTO tennis.membership_venues(tenant_id,subject_id,venue_id) VALUES($1,$2,$3)", [
      first.actor.tenantId,
      first.actor.subjectId,
      otherVenue.id,
    ]);
    await expect(getCashException(db, first.actor, exception.id)).rejects.toMatchObject({
      code: "TENANT_ACCESS_DENIED",
    });
    await expect(getExceptionRefund(db, first.actor, refund.id)).rejects.toMatchObject({
      code: "TENANT_ACCESS_DENIED",
    });
    await expect(requestExceptionRefund(db, first.actor, request(exception))).rejects.toMatchObject({
      code: "TENANT_ACCESS_DENIED",
    });
  });
  it("retains the captured merchant snapshot after platform rotation", async () => {
    const { exception } = await createException("DUPLICATE_PAYMENT");
    await db.query("INSERT INTO tennis.platform_operators(subject_id) VALUES($1)", [first.actor.subjectId]);
    const original = (await listMerchantBindings(db, first.actor.subjectId, first.actor.tenantId))[0]!;
    const replacement = await saveMerchantBinding(db, first.actor.subjectId, {
      tenantId: first.actor.tenantId,
      provider: "MOCK",
      merchantId: `mock:rotated:${key()}`,
      expectedVersion: original.version,
    });
    const refund = await requestExceptionRefund(db, first.actor, request(exception));
    const op = await channelOperation(refund.id);
    expect(op.request.binding).toMatchObject({
      id: original.id,
      version: original.version,
      merchantId: original.merchantId,
    });
    expect(op.request.binding.id).not.toBe(replacement.id);
    await expect(
      settleVerifiedExceptionRefund(db, exceptionEvent(refund, { merchantId: replacement.merchantId })),
    ).rejects.toMatchObject({ code: "INVALID_REFUND_EVENT" });
    expect((await settleVerifiedExceptionRefund(db, exceptionEvent(refund))).status).toBe("SUCCEEDED");
  });
  it.each(["ordinary-first", "exception-first"])(
    "never spends a channel refund receipt twice across normal and exception refunds: %s",
    async (direction) => {
      const { exception, payment } = await createException("DUPLICATE_PAYMENT");
      const paid = await getOrder(db, first.actor, payment!.orderId);
      const normal = await requestOrderRefund(db, first.actor, {
        orderId: paid.id,
        expectedRevision: paid.revision,
        reason: "客户申请正常订单退款",
        commandKey: key(),
        lines: [{ lineId: paid.lines[0]!.id, refundCents: 12000, cancel: true }],
      });
      const exceptional = await requestExceptionRefund(db, first.actor, request(exception));
      const providerRefundId = key();
      if (direction === "ordinary-first") {
        await settleVerifiedRefund(db, ordinaryEvent(normal, payment!, { providerRefundId }));
        await expect(
          settleVerifiedExceptionRefund(db, exceptionEvent(exceptional, { providerRefundId })),
        ).rejects.toMatchObject({ code: "INVALID_REFUND_EVENT" });
        expect((await getCashException(db, first.actor, exception.id)).status).toBe("OPEN");
        expect((await getExceptionRefund(db, first.actor, exceptional.id)).status).toBe("REQUESTED");
      } else {
        await settleVerifiedExceptionRefund(db, exceptionEvent(exceptional, { providerRefundId }));
        await expect(
          settleVerifiedRefund(db, ordinaryEvent(normal, payment!, { providerRefundId })),
        ).rejects.toMatchObject({ code: "INVALID_REFUND_EVENT" });
        expect((await getRefund(db, first.actor, normal.id)).status).toBe("REQUESTED");
      }
      expect(
        (await db.query("SELECT 1 FROM tennis.cash_refund_transactions WHERE tenant_id=$1", [first.actor.tenantId]))
          .rowCount,
      ).toBe(1);
    },
  );
  it("replays an authenticated refund observation without allowing semantic event reuse or failure downgrade", async () => {
    const { exception } = await createException("EXTRA_TOPUP_RECEIPT");
    const refund = await requestExceptionRefund(db, first.actor, request(exception));
    const event = exceptionEvent(refund);
    const settled = await settleVerifiedExceptionRefund(db, event);
    expect(
      await settleVerifiedExceptionRefund(
        db,
        exceptionEvent(refund, {
          eventId: event.eventId,
          providerRefundId: event.providerRefundId!,
          issuedAt: Date.now() + 1000,
        }),
      ),
    ).toEqual(settled);
    await expect(
      settleVerifiedExceptionRefund(db, exceptionEvent(refund, { eventId: event.eventId, status: "FAILED" })),
    ).rejects.toMatchObject({ code: "REFUND_EVENT_REUSED" });
    expect((await settleVerifiedExceptionRefund(db, exceptionEvent(refund, { status: "FAILED" }))).status).toBe(
      "SUCCEEDED",
    );
    expect((await getCashException(db, first.actor, exception.id)).status).toBe("RESOLVED");
  });
});


describe("historical exception refund totals", () => {
  it.each(["missing", "contradictory"])("handles a %s original total without altering the old request", async (scenario) => {
    const { exception } = await createException("EXTRA_TOPUP_RECEIPT");
    const refund = await requestExceptionRefund(db, first.actor, request(exception));
    const op = await channelOperation(refund.id);
    const { originalPaymentCents: _total, ...old } = op.request;
    const input = scenario === "missing" ? old : { ...old, originalPaymentCents: 6000 };
    // Reconstruct only this fixture's pre-F15 channel request; never disable the immutable-request trigger.
    await db.query("DELETE FROM tennis.channel_operations WHERE id=$1 AND tenant_id=$2", [op.id, first.actor.tenantId]);
    await db.query(
      `INSERT INTO tennis.channel_operations(id,tenant_id,source_kind,source_id,binding_id,provider,request,request_hash)
       VALUES($1,$2,'EXCEPTION_REFUND',$3,$4,$5,$6::jsonb,$7)`,
      [op.id, first.actor.tenantId, refund.id, input.binding.id, input.binding.provider, JSON.stringify(input), requestHash(input)],
    );
    const snapshot = async () => (await db.query("SELECT request,request_hash FROM tennis.channel_operations WHERE id=$1", [op.id])).rows[0];
    const before = await snapshot();
    const tx = await db.connect();
    try { await enqueueExceptionRefundChannel(tx, first.actor.tenantId, refund.id); } finally { tx.release(); }
    expect(await snapshot()).toEqual(before);
    await simulatePaymentChannel(db, first.actor, "EXCEPTION_REFUND", refund.id, gateway, "FAILED");
    if (scenario === "contradictory") {
      await expect(retryExceptionRefund(db, first.actor, refund.id, key())).rejects.toMatchObject({ code: "CHANNEL_REQUEST_CONFLICT" });
      expect((await channelOperation(refund.id)).id).toBe(op.id);
      expect((await getExceptionRefund(db, first.actor, refund.id)).status).toBe("FAILED");
    } else {
      await retryExceptionRefund(db, first.actor, refund.id, key());
      const retry = await channelOperation(refund.id);
      expect(retry.id).not.toBe(op.id);
      expect(retry.request).toMatchObject({ originalPaymentCents: 5000, amountCents: 5000, transactionId: exception.transactionId, binding: input.binding });
      await simulatePaymentChannel(db, first.actor, "EXCEPTION_REFUND", refund.id, gateway, "SUCCEEDED");
      expect((await getCashException(db, first.actor, exception.id)).status).toBe("RESOLVED");
    }
    expect(await snapshot()).toEqual(before);
    expect((await getWallet(db, first.actor, customer.customerId)).balance.totalCents).toBe(6000);
  });
});
