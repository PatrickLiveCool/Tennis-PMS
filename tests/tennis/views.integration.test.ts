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
import { confirmQuote, createQuote, getOrder } from "../../packages/db/src/tennis/booking.ts";
import { beginOrderPayment, settleVerifiedPayment, type PaymentRecord } from "../../packages/db/src/tennis/payments.ts";
import { LocalMockPaymentGateway, type MockPaymentPayload } from "../../packages/db/src/tennis/mock-payments.ts";
import { getWallet, recordOfflineTopup } from "../../packages/db/src/tennis/wallet.ts";
import {
  requestOrderRefundGroup,
  retryFailedRefund,
  settleVerifiedRefund,
  type RefundRecord,
} from "../../packages/db/src/tennis/refunds.ts";
import {
  beginTopupPayment,
  createTopupQuote,
  saveTopupOffer,
  settleVerifiedTopup,
  type TopupPayment,
} from "../../packages/db/src/tennis/topups.ts";
import { financeLedger } from "../../packages/db/src/tennis/views.ts";
import { removeTenantFixture, seedTenantFixture, syntheticPhone, type TenantFixture } from "./tenant-fixture.ts";

const db = new pg.Pool({
  connectionString: assertLocalTennisDatabaseUrl(
    process.env.TENNIS_TEST_DATABASE_URL ?? localTennisTestDatabaseUrl,
    "test",
  ),
  max: 8,
  connectionTimeoutMillis: 5000,
  statement_timeout: 10000,
});
const gateway = new LocalMockPaymentGateway("finance-only-synthetic-private-signing-secret", "local-simulation");
const date = "2035-01-01";
const eventTime = "2035-01-01T04:00:00Z";
const key = () => randomUUID();
const hours = Array.from({ length: 7 }, (_, weekday) => ({ weekday, startMinute: 480, endMinute: 1320 }));
let first: TenantFixture, second: TenantFixture;
let customer: CustomerActor;
let courtId: string;
let customerSubject: string;
async function configureCourt(venueId: string) {
  const venue = (await listVenues(db, first.actor)).find((row) => row.id === venueId)!;
  await updateVenue(db, first.actor, {
    ...venue,
    expectedRevision: venue.catalogRevision,
    openingHours: hours,
    minimumBookingMinutes: 15,
  });
  const court = await createCourt(db, first.actor, { venueId, name: "财务测试球场", indoor: true, surface: "ACRYLIC", profile: { specification: "STANDARD" }, hourlyPriceCents: 12000 });
  await setCourtPrice(db, first.actor, {
    venueId,
    courtId: court.id,
    expectedRevision: court.revision,
    hourlyPriceCents: 12000,
  });
  return court.id;
}
async function order(hour = 19, venueId = first.venueId, selectedCourt = courtId) {
  const quote = await createQuote(db, customer, {
    venueId,
    customerId: customer.customerId,
    lines: [
      {
        courtId: selectedCourt,
        startAt: `2099-09-18T${hour}:00:00+08:00`,
        endAt: `2099-09-18T${hour + 1}:00:00+08:00`,
      },
    ],
  });
  return confirmQuote(db, customer, { quoteId: quote.id, commandKey: key() });
}
async function credit(principalCents = 5000, giftCents = 1000, venueId = first.venueId) {
  return recordOfflineTopup(db, first.actor, {
    venueId,
    customerId: customer.customerId,
    principalCents,
    giftCents,
    receiptReference: key(),
    reason: "合成财务实收",
    commandKey: key(),
  });
}
function event(payment: PaymentRecord | TopupPayment, overrides: Partial<MockPaymentPayload> = {}) {
  const signed = gateway.signForLocalSimulator({
    provider: "MOCK",
    merchantId: payment.merchantId,
    paymentId: payment.id,
    eventId: key(),
    transactionId: key(),
    status: "SUCCEEDED",
    amountCents: "externalCents" in payment ? payment.externalCents : payment.principalCents,
    currency: "CNY",
    issuedAt: Date.now(),
    ...overrides,
  });
  return gateway.verify(signed.body, signed.signature);
}
function refundEvent(refund: RefundRecord, payment: PaymentRecord, status: "SUCCEEDED" | "FAILED" = "SUCCEEDED") {
  const signed = gateway.signForLocalSimulator({
    eventType: "REFUND",
    provider: "MOCK",
    merchantId: payment.merchantId,
    refundId: refund.id,
    eventId: key(),
    transactionId: payment.providerTransactionId!,
    providerRefundId: key(),
    status,
    amountCents: refund.externalCents,
    currency: "CNY",
    issuedAt: Date.now(),
  });
  return gateway.verifyRefund(signed.body, signed.signature);
}
async function onlineTopup(principalCents = 10000, giftCents = 2000) {
  const offer = await saveTopupOffer(db, first.actor, {
    name: "合成充值档位",
    principalCents,
    giftCents,
    active: true,
  });
  const quote = await createTopupQuote(db, customer, {
    venueId: first.venueId,
    customerId: customer.customerId,
    offerId: offer.id,
  });
  return beginTopupPayment(db, customer, gateway, { quoteId: quote.id, commandKey: key() });
}
/** Move only this test tenant's synthetic financial facts to a fixed reconciliation date. */
async function fixEventTimes() {
  for (const [table, column] of [
    ["wallet_batches", "credited_at"],
    ["external_payment_receipts", "received_at"],
    ["topup_payments", "settled_at"],
    ["topup_exceptions", "created_at"],
    ["financial_exceptions", "created_at"],
    ["payment_attempts", "settled_at"],
    ["refunds", "completed_at"],
  ]) {
    await db.query(`UPDATE tennis.${table} SET ${column}=$2 WHERE tenant_id=$1 AND ${column} IS NOT NULL`, [
      first.actor.tenantId,
      eventTime,
    ]);
  }
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
  courtId = await configureCourt(first.venueId);
  const profile = await createCustomer(db, first.actor, { nickname: "财务测试客户", phone: syntheticPhone() });
  customerSubject = key();
  await db.query("INSERT INTO tennis.subjects (id,display_name) VALUES ($1,'synthetic finance customer')", [
    customerSubject,
  ]);
  await db.query("UPDATE tennis.customers SET subject_id=$1 WHERE tenant_id=$2 AND id=$3", [
    customerSubject,
    first.actor.tenantId,
    profile.id,
  ]);
  customer = { tenantId: first.actor.tenantId, subjectId: customerSubject, customerId: profile.id, kind: "customer" };
});
afterEach(async () => {
  if (first) await removeTenantFixture(db, first);
  if (second) await removeTenantFixture(db, second);
  if (customerSubject) await db.query("DELETE FROM tennis.subjects WHERE id=$1", [customerSubject]);
});
afterAll(async () => {
  await db.end();
});

describe("venue financial reconciliation", () => {
  it("keeps real cash, top-ups, gifts and wallet spending separate without counting online credit batches twice", async () => {
    await credit(); // Cash 50 + gift 10.
    const topup = await onlineTopup(); // Cash 100 + gift 20.
    const topupCapture = event(topup);
    await settleVerifiedTopup(db, topupCapture);
    await settleVerifiedTopup(db, topupCapture);
    const booking = await order();
    const pending = await beginOrderPayment(db, customer, gateway, {
      orderId: booking.id,
      walletCents: 6000,
      commandKey: key(),
    });
    const orderCapture = event(pending);
    await settleVerifiedPayment(db, orderCapture);
    await settleVerifiedPayment(db, orderCapture);
    const walletOnlyOrder = await order(20);
    await beginOrderPayment(db, customer, gateway, {
      orderId: walletOnlyOrder.id,
      walletCents: 12000,
      commandKey: key(),
    });
    await fixEventTimes();
    const ledger = await financeLedger(db, first.actor, first.venueId, date);
    expect(ledger.totals).toEqual({
      cashInCents: 21000,
      cashRefundCents: 0,
      walletConsumedCents: 18000,
      walletRefundCents: 0,
      giftCents: 3000,
    });
    expect(ledger.entries.map((entry) => entry.kind).sort()).toEqual([
      "OFFLINE_TOPUP",
      "ONLINE_TOPUP",
      "ORDER_RECEIPT",
      "WALLET_CONSUMPTION",
      "WALLET_CONSUMPTION",
    ]);
    expect(
      ledger.entries.filter((entry) => entry.kind === "WALLET_CONSUMPTION").every((entry) => entry.cashCents === 0),
    ).toBe(true);
    expect((await getWallet(db, customer, customer.customerId)).balance.totalCents).toBe(0);
    expect(ledger).not.toHaveProperty("revenue");
  });
  it("counts refunds only after success, with the cash and original stored-value portions separated", async () => {
    await credit();
    const booking = await order();
    const payment = await settleVerifiedPayment(
      db,
      event(
        await beginOrderPayment(db, customer, gateway, { orderId: booking.id, walletCents: 6000, commandKey: key() }),
      ),
    );
    const paid = await getOrder(db, first.actor, booking.id);
    const group = await requestOrderRefundGroup(db, first.actor, {
      orderId: paid.id,
      expectedRevision: paid.revision,
      reason: "员工全退",
      commandKey: key(),
      lines: [{ lineId: paid.lines[0]!.id, refundCents: 12000, cancel: true }],
    });
    const refund = group.refunds[0]!;
    await fixEventTimes();
    const pending = await financeLedger(db, first.actor, first.venueId, date);
    expect(pending.totals).toMatchObject({ cashRefundCents: 0, walletRefundCents: 0 });
    expect(pending.pendingRefunds).toMatchObject([{ id: refund.id, status: "REQUESTED" }]);
    await settleVerifiedRefund(db, refundEvent(refund, payment, "FAILED"));
    expect((await financeLedger(db, first.actor, first.venueId, date)).totals).toMatchObject({
      cashRefundCents: 0,
      walletRefundCents: 0,
    });
    await retryFailedRefund(db, first.actor, refund.id, key());
    const settled = refundEvent(refund, payment);
    await settleVerifiedRefund(db, settled);
    await settleVerifiedRefund(db, settled);
    await fixEventTimes();
    const result = await financeLedger(db, first.actor, first.venueId, date);
    expect(result.totals).toEqual({
      cashInCents: 11000,
      cashRefundCents: 6000,
      walletConsumedCents: 6000,
      walletRefundCents: 6000,
      giftCents: 1000,
    });
    expect(result.entries.filter((entry) => entry.kind === "REFUND")).toMatchObject([
      { cashCents: -6000, walletCents: -6000, giftCents: 0 },
    ]);
    expect(result.pendingRefunds).toEqual([]);
    expect((await getWallet(db, customer, customer.customerId)).balance).toMatchObject({
      principalCents: 5000,
      giftCents: 1000,
    });
  });
  it("excludes unconfirmed and failed payment attempts while retaining real additional captures and their exceptions once", async () => {
    const pendingTopup = await onlineTopup();
    const topupCapture = event(pendingTopup);
    const booking = await order();
    const pendingOrder = await beginOrderPayment(db, customer, gateway, {
      orderId: booking.id,
      walletCents: 0,
      commandKey: key(),
    });
    await fixEventTimes();
    expect((await financeLedger(db, first.actor, first.venueId, date)).entries).toEqual([]);
    await settleVerifiedTopup(db, event(pendingTopup, { status: "FAILED" }));
    await fixEventTimes();
    expect((await financeLedger(db, first.actor, first.venueId, date)).totals.cashInCents).toBe(0);
    await settleVerifiedTopup(db, topupCapture);
    const extraTopup = event(pendingTopup);
    await settleVerifiedTopup(db, extraTopup);
    await settleVerifiedTopup(db, extraTopup);
    await settleVerifiedPayment(db, event(pendingOrder));
    const extraOrder = event(pendingOrder);
    await settleVerifiedPayment(db, extraOrder);
    await settleVerifiedPayment(db, extraOrder);
    await fixEventTimes();
    const result = await financeLedger(db, first.actor, first.venueId, date);
    expect(result.totals).toEqual({
      cashInCents: 44000,
      cashRefundCents: 0,
      walletConsumedCents: 0,
      walletRefundCents: 0,
      giftCents: 2000,
    });
    expect(result.entries.map((entry) => entry.kind).sort()).toEqual([
      "EXTRA_TOPUP_RECEIPT",
      "ONLINE_TOPUP",
      "ORDER_RECEIPT",
      "ORDER_RECEIPT",
    ]);
    expect(result.exceptions.map((exception) => exception.kind).sort()).toEqual([
      "DUPLICATE_PAYMENT",
      "EXTRA_TOPUP_RECEIPT",
    ]);
    expect((await getWallet(db, customer, customer.customerId)).balance.totalCents).toBe(12000);
  });
  it("uses the venue's local half-open calendar day and excludes another venue's cash", async () => {
    const timestamps = [
      "2034-12-31T15:59:59.999Z",
      "2034-12-31T16:00:00.000Z",
      "2035-01-01T15:59:59.999Z",
      "2035-01-01T16:00:00.000Z",
    ];
    for (const [index, time] of timestamps.entries()) {
      const batch = await credit((index + 1) * 100, 0);
      await db.query("UPDATE tennis.wallet_batches SET credited_at=$3 WHERE tenant_id=$1 AND id=$2", [
        first.actor.tenantId,
        batch.batchId,
        time,
      ]);
    }
    const otherVenue = await createVenue(db, first.actor, { name: "另一校区", timezone: "Asia/Shanghai" });
    const otherCredit = await credit(5000, 0, otherVenue.id);
    await db.query("UPDATE tennis.wallet_batches SET credited_at=$3 WHERE tenant_id=$1 AND id=$2", [
      first.actor.tenantId,
      otherCredit.batchId,
      eventTime,
    ]);
    const result = await financeLedger(db, first.actor, first.venueId, date);
    expect(result.totals.cashInCents).toBe(500);
    expect(result.entries).toHaveLength(2);
    expect((await financeLedger(db, first.actor, first.venueId, "2034-12-31")).totals.cashInCents).toBe(100);
    expect((await financeLedger(db, first.actor, first.venueId, "2035-01-02")).totals.cashInCents).toBe(400);
    expect((await financeLedger(db, first.actor, otherVenue.id, date)).totals.cashInCents).toBe(5000);
  });
  it("attributes cross-campus wallet use to the booking venue while retaining recharge cash at its collection venue", async () => {
    const otherVenue = await createVenue(db, first.actor, { name: "跨校区使用", timezone: "Asia/Shanghai" });
    const otherCourt = await configureCourt(otherVenue.id);
    await credit(10000, 2000);
    const booking = await order(19, otherVenue.id, otherCourt);
    await beginOrderPayment(db, customer, gateway, { orderId: booking.id, walletCents: 12000, commandKey: key() });
    await fixEventTimes();
    expect((await financeLedger(db, first.actor, first.venueId, date)).totals).toEqual({
      cashInCents: 10000,
      cashRefundCents: 0,
      walletConsumedCents: 0,
      walletRefundCents: 0,
      giftCents: 2000,
    });
    expect((await financeLedger(db, first.actor, otherVenue.id, date)).totals).toEqual({
      cashInCents: 0,
      cashRefundCents: 0,
      walletConsumedCents: 12000,
      walletRefundCents: 0,
      giftCents: 0,
    });
  });
  it("requires staff financial authority and the correct tenant and venue scope", async () => {
    await credit();
    await fixEventTimes();
    await expect(financeLedger(db, customer, first.venueId, date)).rejects.toMatchObject({
      code: "TENANT_ACCESS_DENIED",
    });
    await expect(financeLedger(db, second.actor, first.venueId, date)).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
    });
    await db.query(
      "UPDATE tennis.tenant_memberships SET role='STAFF',all_venues=true,permissions=ARRAY['read','book'] WHERE tenant_id=$1 AND subject_id=$2",
      [first.actor.tenantId, first.actor.subjectId],
    );
    await expect(financeLedger(db, first.actor, first.venueId, date)).rejects.toMatchObject({
      code: "TENANT_ACCESS_DENIED",
    });
    await db.query(
      "UPDATE tennis.tenant_memberships SET all_venues=false,permissions=ARRAY['read','manage_members'] WHERE tenant_id=$1 AND subject_id=$2",
      [first.actor.tenantId, first.actor.subjectId],
    );
    await expect(financeLedger(db, first.actor, first.venueId, date)).rejects.toMatchObject({
      code: "TENANT_ACCESS_DENIED",
    });
    await db.query("INSERT INTO tennis.membership_venues (tenant_id,subject_id,venue_id) VALUES ($1,$2,$3)", [
      first.actor.tenantId,
      first.actor.subjectId,
      first.venueId,
    ]);
    expect((await financeLedger(db, first.actor, first.venueId, date)).totals.cashInCents).toBe(5000);
  });
});
