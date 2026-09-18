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
import {
  cancelUnpaidOrder,
  confirmQuote,
  createQuote,
  expireDueOrders,
  getOrder,
} from "../../packages/db/src/tennis/booking.ts";
import {
  beginOrderPayment,
  getOrderPayment,
  settleVerifiedPayment,
  type PaymentRecord,
} from "../../packages/db/src/tennis/payments.ts";
import {
  LocalMockPaymentGateway,
  type MockPaymentPayload,
  type VerifiedPaymentEvent,
} from "../../packages/db/src/tennis/mock-payments.ts";
import { getWallet, recordOfflineTopup } from "../../packages/db/src/tennis/wallet.ts";
import {
  getRefund,
  requestOrderRefund,
  retryFailedRefund,
  settleVerifiedRefund,
  type RefundRecord,
} from "../../packages/db/src/tennis/refunds.ts";
import type { MockRefundPayload } from "../../packages/db/src/tennis/mock-payments.ts";
import {
  beginTopupPayment,
  createTopupQuote,
  getTopupPayment,
  listTopupOffers,
  saveTopupOffer,
  settleVerifiedTopup,
  type TopupPayment,
} from "../../packages/db/src/tennis/topups.ts";
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
const gateway = new LocalMockPaymentGateway("only-synthetic-test-private-signing-secret", "local-simulation");
const hours = Array.from({ length: 7 }, (_, weekday) => ({ weekday, startMinute: 480, endMinute: 1320 }));
let first: TenantFixture, second: TenantFixture;
let customer: CustomerActor;
let secondVenue: string;
let courtIds: string[];
const subjects: string[] = [];
const key = () => randomUUID();
async function setupCourt(venueId: string) {
  const venue = (await listVenues(db, first.actor)).find((v) => v.id === venueId)!;
  await updateVenue(db, first.actor, {
    ...venue,
    expectedRevision: venue.catalogRevision,
    openingHours: hours,
    minimumBookingMinutes: 15,
  });
  const court = await createCourt(db, first.actor, { venueId, name: "测试球场", indoor: true });
  await setCourtPrice(db, first.actor, {
    venueId,
    courtId: court.id,
    expectedRevision: court.revision,
    hourlyPriceCents: 12000,
  });
  return court.id;
}
async function order(index = 0) {
  const venueId = index === 0 ? first.venueId : secondVenue;
  const quote = await createQuote(db, customer, {
    venueId,
    customerId: customer.customerId,
    lines: [{ courtId: courtIds[index]!, startAt: "2099-09-18T19:00:00+08:00", endAt: "2099-09-18T20:00:00+08:00" }],
  });
  return confirmQuote(db, customer, { quoteId: quote.id, commandKey: key() });
}
async function topup(principalCents = 1000000, giftCents = 200000) {
  return recordOfflineTopup(db, first.actor, {
    venueId: first.venueId,
    customerId: customer.customerId,
    principalCents,
    giftCents,
    receiptReference: key(),
    reason: "合成线下收款凭据",
    commandKey: key(),
  });
}
function event(payment: PaymentRecord, overrides: Partial<MockPaymentPayload> = {}): VerifiedPaymentEvent {
  const signed = gateway.signForLocalSimulator({
    provider: "MOCK",
    paymentId: payment.id,
    merchantId: payment.merchantId,
    eventId: key(),
    transactionId: key(),
    status: "SUCCEEDED",
    amountCents: payment.externalCents,
    currency: "CNY",
    issuedAt: Date.now(),
    ...overrides,
  });
  return gateway.verify(signed.body, signed.signature);
}
function refundEvent(refund: RefundRecord, payment: PaymentRecord, overrides: Partial<MockRefundPayload> = {}) {
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
function topupEvent(payment: TopupPayment, overrides: Partial<MockPaymentPayload> = {}) {
  const signed = gateway.signForLocalSimulator({
    provider: "MOCK",
    paymentId: payment.id,
    merchantId: payment.merchantId,
    eventId: key(),
    transactionId: key(),
    status: "SUCCEEDED",
    amountCents: payment.principalCents,
    currency: "CNY",
    issuedAt: Date.now(),
    ...overrides,
  });
  return gateway.verify(signed.body, signed.signature);
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
  secondVenue = (await createVenue(db, first.actor, { name: "第二校区", timezone: "Asia/Shanghai" })).id;
  courtIds = [await setupCourt(first.venueId), await setupCourt(secondVenue)];
  const profile = await createCustomer(db, first.actor, { nickname: "储值测试客户" });
  const subjectId = key();
  subjects.push(subjectId);
  await db.query("INSERT INTO tennis.subjects (id,display_name) VALUES ($1,'synthetic wallet customer')", [subjectId]);
  await db.query("UPDATE tennis.customers SET subject_id=$1 WHERE tenant_id=$2 AND id=$3", [
    subjectId,
    first.actor.tenantId,
    profile.id,
  ]);
  customer = { tenantId: first.actor.tenantId, subjectId, customerId: profile.id, kind: "customer" };
});
afterEach(async () => {
  if (first) await removeTenantFixture(db, first);
  if (second) await removeTenantFixture(db, second);
  for (const id of subjects.splice(0)) await db.query("DELETE FROM tennis.subjects WHERE id=$1", [id]);
});
afterAll(async () => {
  await db.end();
});

describe("wallet and local simulated payments", () => {
  it("records principal and gift once per real-world receipt, with immutable credit entries", async () => {
    const input = {
      venueId: first.venueId,
      customerId: customer.customerId,
      principalCents: 1000000,
      giftCents: 200000,
      receiptReference: key(),
      reason: "合成转账",
      commandKey: key(),
    };
    const results = await Promise.all([
      recordOfflineTopup(db, first.actor, input),
      recordOfflineTopup(db, first.actor, input),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect((await recordOfflineTopup(db, first.actor, { ...input, commandKey: key() })).batchId).toBe(
      results[0]!.batchId,
    );
    await expect(
      recordOfflineTopup(db, first.actor, { ...input, commandKey: key(), principalCents: 1 }),
    ).rejects.toMatchObject({ code: "TOPUP_REFERENCE_REUSED" });
    const wallet = await getWallet(db, customer, customer.customerId);
    expect(wallet.balance).toEqual({
      totalCents: 1200000,
      availableCents: 1200000,
      reservedCents: 0,
      principalCents: 1000000,
      giftCents: 200000,
    });
    expect(wallet.entries).toHaveLength(1);
  });
  it("settles pure-wallet payments atomically across campuses and debits the confirmed ratio", async () => {
    await topup();
    const booking = await order(1);
    const request = { orderId: booking.id, walletCents: 12000, commandKey: key() };
    const payment = await beginOrderPayment(db, customer, gateway, request);
    expect(payment).toMatchObject({ status: "SUCCEEDED", provider: "WALLET", externalCents: 0, walletCents: 12000 });
    expect(await beginOrderPayment(db, customer, gateway, request)).toEqual(payment);
    expect(await getOrder(db, customer, booking.id)).toMatchObject({
      status: "CONFIRMED",
      paymentStatus: "PAID",
      holdUntil: null,
    });
    const wallet = await getWallet(db, customer, customer.customerId);
    expect(wallet.balance).toMatchObject({
      principalCents: 990000,
      giftCents: 198000,
      totalCents: 1188000,
      reservedCents: 0,
    });
    expect(wallet.entries.filter((row) => row.kind === "CONSUME")).toMatchObject([
      { principalCents: 10000, giftCents: 2000 },
    ]);
  });
  it("takes older batches first and conserves components when crossing batches", async () => {
    const firstCredit = await topup(50, 10);
    await topup(12000, 0);
    const booking = await order();
    await beginOrderPayment(db, customer, gateway, { orderId: booking.id, walletCents: 12000, commandKey: key() });
    const used = (
      await db.query<{ batch_id: string; principal_cents: string; gift_cents: string }>(
        "SELECT batch_id,principal_cents,gift_cents FROM tennis.wallet_allocations WHERE tenant_id=$1",
        [first.actor.tenantId],
      )
    ).rows;
    expect(used.find((row) => row.batch_id === firstCredit.batchId)).toMatchObject({
      principal_cents: "50",
      gift_cents: "10",
    });
    expect((await getWallet(db, customer, customer.customerId)).balance).toMatchObject({
      totalCents: 60,
      principalCents: 60,
      giftCents: 0,
    });
  });
  it("prevents two concurrent cross-campus orders from overdrawing the same wallet", async () => {
    await topup(15000, 0);
    const one = await order(),
      two = await order(1);
    const results = await Promise.allSettled([
      beginOrderPayment(db, customer, gateway, { orderId: one.id, walletCents: 12000, commandKey: key() }),
      beginOrderPayment(db, customer, gateway, { orderId: two.id, walletCents: 12000, commandKey: key() }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason.code).toBe(
      "INSUFFICIENT_BALANCE",
    );
    expect((await getWallet(db, customer, customer.customerId)).balance).toMatchObject({
      availableCents: 3000,
      reservedCents: 0,
    });
    expect(
      (await db.query("SELECT id FROM tennis.payment_attempts WHERE tenant_id=$1", [first.actor.tenantId])).rowCount,
    ).toBe(1);
  });
  it("reserves balance for a mixed payment and captures it only after the exact gap arrives", async () => {
    await topup(5000, 1000);
    const booking = await order();
    const payment = await beginOrderPayment(db, customer, gateway, {
      orderId: booking.id,
      walletCents: 6000,
      commandKey: key(),
    });
    expect(payment).toMatchObject({ status: "PENDING", provider: "MOCK", externalCents: 6000, walletCents: 6000 });
    expect((await getOrder(db, customer, booking.id)).paymentStatus).toBe("UNPAID");
    expect((await getWallet(db, customer, customer.customerId)).balance).toMatchObject({
      totalCents: 6000,
      availableCents: 0,
      reservedCents: 6000,
    });
    await expect(
      beginOrderPayment(db, customer, gateway, { orderId: booking.id, walletCents: 0, commandKey: key() }),
    ).rejects.toMatchObject({ code: "PAYMENT_ALREADY_PENDING" });
    const notification = event(payment);
    const results = await Promise.all([
      settleVerifiedPayment(db, notification),
      settleVerifiedPayment(db, notification),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]!.status).toBe("SUCCEEDED");
    expect((await getWallet(db, customer, customer.customerId)).balance).toMatchObject({
      totalCents: 0,
      availableCents: 0,
      reservedCents: 0,
    });
    expect(
      (
        await db.query("SELECT id FROM tennis.wallet_entries WHERE tenant_id=$1 AND kind='CONSUME'", [
          first.actor.tenantId,
        ])
      ).rowCount,
    ).toBe(1);
  });
  it("rejects unsigned, wrong-merchant and wrong-amount events without spending funds", async () => {
    await topup(6000, 0);
    const booking = await order();
    const payment = await beginOrderPayment(db, customer, gateway, {
      orderId: booking.id,
      walletCents: 6000,
      commandKey: key(),
    });
    await expect(
      settleVerifiedPayment(db, JSON.parse(JSON.stringify(event(payment))) as VerifiedPaymentEvent),
    ).rejects.toMatchObject({ code: "INVALID_PAYMENT_EVENT" });
    await expect(
      settleVerifiedPayment(db, event(payment, { merchantId: gateway.merchantForTenant(second.actor.tenantId) })),
    ).rejects.toMatchObject({ code: "INVALID_PAYMENT_EVENT" });
    await expect(settleVerifiedPayment(db, event(payment, { amountCents: 1 }))).rejects.toMatchObject({
      code: "INVALID_PAYMENT_EVENT",
    });
    expect((await getOrderPayment(db, customer, payment.id)).status).toBe("PENDING");
    expect((await getWallet(db, customer, customer.customerId)).balance.reservedCents).toBe(6000);
    expect(
      (await db.query("SELECT event_id FROM tennis.payment_events WHERE tenant_id=$1", [first.actor.tenantId]))
        .rowCount,
    ).toBe(0);
  });
  it("releases both reservation and court on failed payment without pretending a refund occurred", async () => {
    await topup(5000, 1000);
    const booking = await order();
    const payment = await beginOrderPayment(db, customer, gateway, {
      orderId: booking.id,
      walletCents: 6000,
      commandKey: key(),
    });
    expect((await settleVerifiedPayment(db, event(payment, { status: "FAILED" }))).status).toBe("FAILED");
    expect(await getOrder(db, customer, booking.id)).toMatchObject({ status: "CANCELLED", paymentStatus: "UNPAID" });
    expect((await getWallet(db, customer, customer.customerId)).balance).toMatchObject({
      availableCents: 6000,
      reservedCents: 0,
      principalCents: 5000,
      giftCents: 1000,
    });
    expect((await order()).status).toBe("HELD");
  });
  it("releases mixed funds when cancelled and sends late captured cash to an explicit refund task", async () => {
    await topup(6000, 0);
    const booking = await order();
    const payment = await beginOrderPayment(db, customer, gateway, {
      orderId: booking.id,
      walletCents: 6000,
      commandKey: key(),
    });
    await cancelUnpaidOrder(db, customer, {
      orderId: booking.id,
      expectedRevision: booking.revision,
      commandKey: key(),
      reason: "停止付款",
    });
    const replacement = await order();
    const notification = event(payment);
    expect((await settleVerifiedPayment(db, notification)).status).toBe("REFUND_REQUIRED");
    await settleVerifiedPayment(db, notification);
    expect((await getOrder(db, customer, booking.id)).status).toBe("CANCELLED");
    expect((await getOrder(db, customer, replacement.id)).status).toBe("HELD");
    expect((await getWallet(db, customer, customer.customerId)).balance).toMatchObject({
      availableCents: 6000,
      reservedCents: 0,
    });
    expect(
      (
        await db.query(
          "SELECT id FROM tennis.financial_exceptions WHERE tenant_id=$1 AND kind='LATE_PAYMENT' AND status='OPEN'",
          [first.actor.tenantId],
        )
      ).rowCount,
    ).toBe(1);
  });
  it("makes expiration racing a late payment deterministic and releases reservations exactly once", async () => {
    await topup(5000, 1000);
    const booking = await order();
    const payment = await beginOrderPayment(db, customer, gateway, {
      orderId: booking.id,
      walletCents: 6000,
      commandKey: key(),
    });
    await db.query("UPDATE tennis.orders SET hold_until=clock_timestamp()-interval '1 second' WHERE id=$1", [
      booking.id,
    ]);
    const [, settled] = await Promise.all([expireDueOrders(db), settleVerifiedPayment(db, event(payment))]);
    expect(settled.status).toBe("REFUND_REQUIRED");
    expect((await getOrder(db, customer, booking.id)).status).toBe("EXPIRED");
    expect((await getWallet(db, customer, customer.customerId)).balance).toMatchObject({
      availableCents: 6000,
      reservedCents: 0,
    });
    expect(
      (
        await db.query("SELECT id FROM tennis.wallet_entries WHERE tenant_id=$1 AND kind='RELEASE'", [
          first.actor.tenantId,
        ])
      ).rowCount,
    ).toBe(1);
  });
  it("does not let a later failure undo a successful capture and tracks duplicate cash separately", async () => {
    const booking = await order();
    const payment = await beginOrderPayment(db, customer, gateway, {
      orderId: booking.id,
      walletCents: 0,
      commandKey: key(),
    });
    const success = event(payment);
    await settleVerifiedPayment(db, success);
    expect((await settleVerifiedPayment(db, event(payment, { status: "FAILED" }))).status).toBe("SUCCEEDED");
    expect((await settleVerifiedPayment(db, event(payment))).status).toBe("SUCCEEDED");
    expect(
      (
        await db.query("SELECT id FROM tennis.financial_exceptions WHERE tenant_id=$1 AND kind='DUPLICATE_PAYMENT'", [
          first.actor.tenantId,
        ])
      ).rowCount,
    ).toBe(1);
    const other = await order(1);
    const otherPayment = await beginOrderPayment(db, customer, gateway, {
      orderId: other.id,
      walletCents: 0,
      commandKey: key(),
    });
    await expect(
      settleVerifiedPayment(db, event(otherPayment, { transactionId: success.transactionId })),
    ).rejects.toMatchObject({ code: "PAYMENT_TRANSACTION_REUSED" });
    await expect(settleVerifiedPayment(db, event(payment, { eventId: success.eventId }))).rejects.toMatchObject({
      code: "PAYMENT_EVENT_REUSED",
    });
    expect((await getOrder(db, customer, other.id)).paymentStatus).toBe("UNPAID");
  });
  it("checks customer ownership, tenant isolation and staff wallet privileges", async () => {
    await topup(12000, 0);
    const booking = await order();
    await expect(getWallet(db, second.actor, customer.customerId)).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
    });
    await expect(
      beginOrderPayment(db, second.actor, gateway, {
        orderId: booking.id,
        walletCents: 12000,
        commandKey: key(),
        staffReason: "越权",
      }),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    await db.query(
      "UPDATE tennis.tenant_memberships SET role='STAFF',all_venues=true,permissions=ARRAY['read','book'] WHERE tenant_id=$1",
      [first.actor.tenantId],
    );
    await expect(
      beginOrderPayment(db, first.actor, gateway, {
        orderId: booking.id,
        walletCents: 12000,
        commandKey: key(),
        staffReason: "代扣",
      }),
    ).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
    await expect(
      recordOfflineTopup(db, first.actor, {
        venueId: first.venueId,
        customerId: customer.customerId,
        principalCents: 1,
        giftCents: 0,
        receiptReference: key(),
        reason: "越权",
        commandKey: key(),
      }),
    ).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
    const other = await db.query<{ id: string }>(
      "INSERT INTO tennis.customers (id,tenant_id,nickname) VALUES ($1,$2,'synthetic other customer') RETURNING id",
      [key(), first.actor.tenantId],
    );
    await expect(getWallet(db, customer, other.rows[0]!.id)).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    expect((await getWallet(db, customer, customer.customerId)).balance.availableCents).toBe(12000);
  });
});

describe("authorized refunds to original sources", () => {
  it("restores original principal, gift and batch after pure-wallet cancellation, exactly once", async () => {
    const credit = await topup();
    const booking = await order();
    await beginOrderPayment(db, customer, gateway, { orderId: booking.id, walletCents: 12000, commandKey: key() });
    const paid = await getOrder(db, first.actor, booking.id);
    const input = {
      orderId: paid.id,
      expectedRevision: paid.revision,
      reason: "雨天场地停用，人工确认全退",
      commandKey: key(),
      lines: [{ lineId: paid.lines[0]!.id, refundCents: 12000, cancel: true }],
    };
    const [one, two] = await Promise.all([
      requestOrderRefund(db, first.actor, input),
      requestOrderRefund(db, first.actor, input),
    ]);
    expect(one).toEqual(two);
    expect(one).toMatchObject({ status: "SUCCEEDED", amountCents: 12000, walletCents: 12000, externalCents: 0 });
    expect((await getWallet(db, customer, customer.customerId)).balance).toMatchObject({
      totalCents: 1200000,
      principalCents: 1000000,
      giftCents: 200000,
    });
    expect(await getOrder(db, customer, booking.id)).toMatchObject({ status: "CANCELLED", paymentStatus: "REFUNDED" });
    const entries = (
      await db.query(
        "SELECT batch_id,principal_cents,gift_cents FROM tennis.wallet_entries WHERE tenant_id=$1 AND kind='REFUND'",
        [first.actor.tenantId],
      )
    ).rows;
    expect(entries).toEqual([{ batch_id: credit.batchId, principal_cents: "10000", gift_cents: "2000" }]);
    expect((await order()).status).toBe("HELD");
  });
  it("waits for external refund confirmation before completing both parts, then permits only the remaining amount", async () => {
    await topup(5000, 1000);
    const booking = await order();
    const pending = await beginOrderPayment(db, customer, gateway, {
      orderId: booking.id,
      walletCents: 6000,
      commandKey: key(),
    });
    const payment = await settleVerifiedPayment(db, event(pending));
    const paid = await getOrder(db, first.actor, booking.id);
    const refund = await requestOrderRefund(db, first.actor, {
      orderId: paid.id,
      expectedRevision: paid.revision,
      reason: "员工确认半价退费，不取消使用",
      commandKey: key(),
      lines: [{ lineId: paid.lines[0]!.id, refundCents: 6000, cancel: false }],
    });
    expect(refund).toMatchObject({
      status: "REQUESTED",
      amountCents: 6000,
      walletCents: 3000,
      externalCents: 3000,
      completedAt: null,
    });
    expect((await getWallet(db, customer, customer.customerId)).balance.totalCents).toBe(0);
    const notification = refundEvent(refund, payment);
    const [one, two] = await Promise.all([
      settleVerifiedRefund(db, notification),
      settleVerifiedRefund(db, notification),
    ]);
    expect(one).toEqual(two);
    expect(one.status).toBe("SUCCEEDED");
    expect((await getWallet(db, customer, customer.customerId)).balance).toMatchObject({
      totalCents: 3000,
      principalCents: 2500,
      giftCents: 500,
    });
    const partial = await getOrder(db, first.actor, booking.id);
    expect(partial).toMatchObject({ status: "CONFIRMED", paymentStatus: "PARTIALLY_REFUNDED" });
    await expect(
      requestOrderRefund(db, first.actor, {
        orderId: partial.id,
        expectedRevision: partial.revision,
        reason: "不能重复退",
        commandKey: key(),
        lines: [{ lineId: partial.lines[0]!.id, refundCents: 6001, cancel: true }],
      }),
    ).rejects.toMatchObject({ code: "REFUND_EXCEEDS_PAYMENT" });
    const rest = await requestOrderRefund(db, first.actor, {
      orderId: partial.id,
      expectedRevision: partial.revision,
      reason: "人工确认退余款",
      commandKey: key(),
      lines: [{ lineId: partial.lines[0]!.id, refundCents: 6000, cancel: true }],
    });
    await settleVerifiedRefund(db, refundEvent(rest, payment));
    expect((await getWallet(db, customer, customer.customerId)).balance).toMatchObject({
      totalCents: 6000,
      principalCents: 5000,
      giftCents: 1000,
    });
    expect(await getOrder(db, customer, booking.id)).toMatchObject({ status: "CANCELLED", paymentStatus: "REFUNDED" });
  });
  it("keeps a failed refund pending for resolution and retries the same allocation without over-refunding", async () => {
    await topup(6000, 0);
    const booking = await order();
    const payment = await settleVerifiedPayment(
      db,
      event(
        await beginOrderPayment(db, customer, gateway, { orderId: booking.id, walletCents: 6000, commandKey: key() }),
      ),
    );
    const paid = await getOrder(db, first.actor, booking.id);
    const refund = await requestOrderRefund(db, first.actor, {
      orderId: paid.id,
      expectedRevision: paid.revision,
      reason: "人工取消退款",
      commandKey: key(),
      lines: [{ lineId: paid.lines[0]!.id, refundCents: 12000, cancel: true }],
    });
    const failed = await settleVerifiedRefund(db, refundEvent(refund, payment, { status: "FAILED" }));
    expect(failed.status).toBe("FAILED");
    expect((await getWallet(db, customer, customer.customerId)).balance.totalCents).toBe(0);
    const current = await getOrder(db, first.actor, paid.id);
    await expect(
      requestOrderRefund(db, first.actor, {
        orderId: paid.id,
        expectedRevision: current.revision,
        reason: "不允许重复申请",
        commandKey: key(),
        lines: [{ lineId: paid.lines[0]!.id, refundCents: 1, cancel: false }],
      }),
    ).rejects.toMatchObject({ code: "REFUND_EXCEEDS_PAYMENT" });
    const retryKey = key();
    expect((await retryFailedRefund(db, first.actor, refund.id, retryKey)).status).toBe("REQUESTED");
    expect((await retryFailedRefund(db, first.actor, refund.id, retryKey)).status).toBe("REQUESTED");
    const completed = await settleVerifiedRefund(db, refundEvent(refund, payment));
    expect(completed.status).toBe("SUCCEEDED");
    expect((await getWallet(db, customer, customer.customerId)).balance.totalCents).toBe(6000);
    expect((await settleVerifiedRefund(db, refundEvent(refund, payment, { status: "FAILED" }))).status).toBe(
      "SUCCEEDED",
    );
  });
  it("partially cancels multi-line orders without releasing the other courts, including zero refund decisions", async () => {
    await topup(24000, 0);
    const quote = await createQuote(db, customer, {
      venueId: first.venueId,
      customerId: customer.customerId,
      lines: [
        { courtId: courtIds[0]!, startAt: "2099-09-18T18:00:00+08:00", endAt: "2099-09-18T19:00:00+08:00" },
        { courtId: courtIds[0]!, startAt: "2099-09-18T20:00:00+08:00", endAt: "2099-09-18T21:00:00+08:00" },
      ],
    });
    const booking = await confirmQuote(db, customer, { quoteId: quote.id, commandKey: key() });
    await beginOrderPayment(db, customer, gateway, { orderId: booking.id, walletCents: 24000, commandKey: key() });
    const paid = await getOrder(db, first.actor, booking.id);
    const refund = await requestOrderRefund(db, first.actor, {
      orderId: paid.id,
      expectedRevision: paid.revision,
      reason: "迟到按人工约定不退费用",
      commandKey: key(),
      lines: [{ lineId: paid.lines[0]!.id, refundCents: 0, cancel: true }],
    });
    expect(refund).toMatchObject({ status: "SUCCEEDED", amountCents: 0 });
    const current = await getOrder(db, customer, paid.id);
    expect(current).toMatchObject({ status: "CONFIRMED", paymentStatus: "PAID" });
    expect(current.lines[0]!.cancelledAt).not.toBeNull();
    expect(current.lines[1]!.cancelledAt).toBeNull();
    expect(
      (
        await db.query("SELECT order_line_id FROM tennis.occupancies WHERE tenant_id=$1 AND released_at IS NULL", [
          first.actor.tenantId,
        ])
      ).rows,
    ).toEqual([{ order_line_id: current.lines[1]!.id }]);
  });
  it("requires authorized staff decisions and validates refund identities, merchants and amounts", async () => {
    const booking = await order();
    const payment = await settleVerifiedPayment(
      db,
      event(await beginOrderPayment(db, customer, gateway, { orderId: booking.id, walletCents: 0, commandKey: key() })),
    );
    const paid = await getOrder(db, first.actor, booking.id);
    const input = {
      orderId: paid.id,
      expectedRevision: paid.revision,
      reason: "人工退款",
      commandKey: key(),
      lines: [{ lineId: paid.lines[0]!.id, refundCents: 12000, cancel: true }],
    };
    await expect(requestOrderRefund(db, customer, input)).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
    await expect(requestOrderRefund(db, second.actor, input)).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    const refund = await requestOrderRefund(db, first.actor, input);
    await expect(getRefund(db, second.actor, refund.id)).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    await expect(settleVerifiedRefund(db, refundEvent(refund, payment, { amountCents: 1 }))).rejects.toMatchObject({
      code: "INVALID_REFUND_EVENT",
    });
    await expect(
      settleVerifiedRefund(db, refundEvent(refund, payment, { transactionId: key() })),
    ).rejects.toMatchObject({ code: "INVALID_REFUND_EVENT" });
    await expect(
      settleVerifiedRefund(
        db,
        refundEvent(refund, payment, { merchantId: gateway.merchantForTenant(second.actor.tenantId) }),
      ),
    ).rejects.toMatchObject({ code: "INVALID_REFUND_EVENT" });
    expect((await getRefund(db, customer, refund.id)).status).toBe("REQUESTED");
    const notification = refundEvent(refund, payment);
    await settleVerifiedRefund(db, notification);
    await expect(
      settleVerifiedRefund(db, refundEvent(refund, payment, { eventId: notification.eventId, status: "FAILED" })),
    ).rejects.toMatchObject({ code: "REFUND_EVENT_REUSED" });
  });
});

describe("online top-ups with authorized gifts", () => {
  it("uses server-defined offers, preserves confirmed amounts and credits only verified principal cash", async () => {
    const offer = await saveTopupOffer(db, first.actor, {
      name: "合成充一万送两千",
      principalCents: 1000000,
      giftCents: 200000,
      active: true,
    });
    const quote = await createTopupQuote(db, customer, {
      venueId: first.venueId,
      customerId: customer.customerId,
      offerId: offer.id,
    });
    expect(quote).toMatchObject({ principalCents: 1000000, giftCents: 200000 });
    const input = { quoteId: quote.id, commandKey: key() };
    const [one, two] = await Promise.all([
      beginTopupPayment(db, customer, gateway, input),
      beginTopupPayment(db, customer, gateway, input),
    ]);
    expect(one).toEqual(two);
    expect((await beginTopupPayment(db, customer, gateway, { ...input, commandKey: key() })).id).toBe(one.id);
    await saveTopupOffer(db, first.actor, { ...offer, expectedRevision: offer.revision, giftCents: 0, active: false });
    expect(await listTopupOffers(db, customer)).toEqual([]);
    expect((await getWallet(db, customer, customer.customerId)).balance.totalCents).toBe(0);
    await expect(settleVerifiedTopup(db, topupEvent(one, { amountCents: 1200000 }))).rejects.toMatchObject({
      code: "INVALID_PAYMENT_EVENT",
    });
    const notification = topupEvent(one);
    const results = await Promise.all([settleVerifiedTopup(db, notification), settleVerifiedTopup(db, notification)]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toMatchObject({ status: "SUCCEEDED", principalCents: 1000000, giftCents: 200000 });
    expect((await getWallet(db, customer, customer.customerId)).balance).toMatchObject({
      totalCents: 1200000,
      principalCents: 1000000,
      giftCents: 200000,
    });
    expect((await getWallet(db, customer, customer.customerId)).entries).toHaveLength(1);
    const booking = await order(1);
    expect(
      (await beginOrderPayment(db, customer, gateway, { orderId: booking.id, walletCents: 12000, commandKey: key() }))
        .status,
    ).toBe("SUCCEEDED");
  });
  it("supports custom recharge amounts without letting client fields invent gifts", async () => {
    const input = { venueId: first.venueId, customerId: customer.customerId, principalCents: 12000, giftCents: 999999 };
    const quote = await createTopupQuote(db, customer, input);
    expect(quote.giftCents).toBe(0);
    await db.query("UPDATE tennis.topup_quotes SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [
      quote.id,
    ]);
    await expect(
      beginTopupPayment(db, customer, gateway, { quoteId: quote.id, commandKey: key() }),
    ).rejects.toMatchObject({ code: "INVALID_TOPUP" });
    await expect(
      createTopupQuote(db, customer, { venueId: first.venueId, customerId: customer.customerId, principalCents: 0 }),
    ).rejects.toMatchObject({ code: "INVALID_TOPUP" });
  });
  it("credits a later confirmed capture once after an earlier failure and creates a task for additional cash", async () => {
    const quote = await createTopupQuote(db, customer, {
      venueId: first.venueId,
      customerId: customer.customerId,
      principalCents: 12000,
    });
    const payment = await beginTopupPayment(db, customer, gateway, { quoteId: quote.id, commandKey: key() });
    expect((await settleVerifiedTopup(db, topupEvent(payment, { status: "FAILED" }))).status).toBe("FAILED");
    expect((await getWallet(db, customer, customer.customerId)).balance.totalCents).toBe(0);
    const success = topupEvent(payment);
    expect((await settleVerifiedTopup(db, success)).status).toBe("SUCCEEDED");
    await settleVerifiedTopup(db, topupEvent(payment, { status: "FAILED" }));
    const extra = topupEvent(payment);
    await settleVerifiedTopup(db, extra);
    await settleVerifiedTopup(db, extra);
    expect((await getWallet(db, customer, customer.customerId)).balance.totalCents).toBe(12000);
    expect(
      (
        await db.query("SELECT id FROM tennis.topup_exceptions WHERE tenant_id=$1 AND status='OPEN'", [
          first.actor.tenantId,
        ])
      ).rowCount,
    ).toBe(1);
    await expect(settleVerifiedTopup(db, topupEvent(payment, { eventId: success.eventId }))).rejects.toMatchObject({
      code: "PAYMENT_EVENT_REUSED",
    });
  });
  it("cannot spend one channel capture on both a top-up and an order, in either direction", async () => {
    const quote = await createTopupQuote(db, customer, {
      venueId: first.venueId,
      customerId: customer.customerId,
      principalCents: 12000,
    });
    const topupPayment = await beginTopupPayment(db, customer, gateway, { quoteId: quote.id, commandKey: key() });
    const notification = topupEvent(topupPayment);
    await settleVerifiedTopup(db, notification);
    const booking = await order();
    const orderPayment = await beginOrderPayment(db, customer, gateway, {
      orderId: booking.id,
      walletCents: 0,
      commandKey: key(),
    });
    await expect(
      settleVerifiedPayment(db, event(orderPayment, { transactionId: notification.transactionId })),
    ).rejects.toMatchObject({ code: "PAYMENT_TRANSACTION_REUSED" });
    const orderSuccess = event(orderPayment);
    await settleVerifiedPayment(db, orderSuccess);
    const anotherQuote = await createTopupQuote(db, customer, {
      venueId: first.venueId,
      customerId: customer.customerId,
      principalCents: 12000,
    });
    const another = await beginTopupPayment(db, customer, gateway, { quoteId: anotherQuote.id, commandKey: key() });
    await expect(
      settleVerifiedTopup(db, topupEvent(another, { transactionId: orderSuccess.transactionId })),
    ).rejects.toMatchObject({ code: "PAYMENT_TRANSACTION_REUSED" });
    expect((await getTopupPayment(db, customer, another.id)).status).toBe("PENDING");
    expect((await getWallet(db, customer, customer.customerId)).balance.totalCents).toBe(12000);
  });
  it("enforces tenant, ownership, gift-management permissions and the recorded merchant", async () => {
    const offer = await saveTopupOffer(db, first.actor, {
      name: "合成档位",
      principalCents: 12000,
      giftCents: 1200,
      active: true,
    });
    const foreignCustomer = await createCustomer(db, second.actor, { nickname: "其他租户客户" });
    await expect(
      createTopupQuote(db, second.actor, {
        venueId: second.venueId,
        customerId: foreignCustomer.id,
        offerId: offer.id,
      }),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    await expect(
      saveTopupOffer(db, customer, { name: "自行赠送", principalCents: 1, giftCents: 1000000, active: true }),
    ).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
    const staffQuote = await createTopupQuote(db, first.actor, {
      venueId: first.venueId,
      customerId: customer.customerId,
      offerId: offer.id,
    });
    await expect(
      beginTopupPayment(db, customer, gateway, { quoteId: staffQuote.id, commandKey: key() }),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    const payment = await beginTopupPayment(db, first.actor, gateway, { quoteId: staffQuote.id, commandKey: key() });
    expect((await getTopupPayment(db, customer, payment.id)).id).toBe(payment.id);
    await expect(getTopupPayment(db, second.actor, payment.id)).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    await expect(
      settleVerifiedTopup(db, topupEvent(payment, { merchantId: gateway.merchantForTenant(second.actor.tenantId) })),
    ).rejects.toMatchObject({ code: "INVALID_PAYMENT_EVENT" });
    await db.query(
      "UPDATE tennis.tenant_memberships SET role='STAFF',all_venues=true,permissions=ARRAY['read','book','manage_members'] WHERE tenant_id=$1",
      [first.actor.tenantId],
    );
    await expect(
      saveTopupOffer(db, first.actor, { ...offer, expectedRevision: offer.revision, giftCents: 999999 }),
    ).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
  });
});
