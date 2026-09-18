import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertLocalTennisDatabaseUrl, localTennisTestDatabaseUrl } from "../../packages/db/src/tennis/local-config.ts";
import { migrateTennis } from "../../packages/db/src/tennis/migrate.ts";
import { createCourt, listVenues, setCourtPrice, updateVenue } from "../../packages/db/src/tennis/catalog.ts";
import { createCustomer, type CustomerActor } from "../../packages/db/src/tennis/customers.ts";
import {
  cancelFreeOrderLines,
  confirmQuote,
  createQuote,
  getOrder,
  getCommandReceipt,
  type OrderRecord,
} from "../../packages/db/src/tennis/booking.ts";
import {
  beginOrderPayment,
  getOrderPayment,
  settleVerifiedPayment,
  type PaymentRecord,
} from "../../packages/db/src/tennis/payments.ts";
import {
  beginAmendmentPayment,
  cancelOrderAmendment,
  confirmOrderAmendment,
  expireDueAmendments,
  getOrderAmendment,
  previewOrderAmendment,
  type AmendmentRecord,
} from "../../packages/db/src/tennis/amendments.ts";
import {
  getRefundGroup,
  requestOrderRefundGroup,
  settleVerifiedRefund,
  type RefundRecord,
} from "../../packages/db/src/tennis/refunds.ts";
import { LocalMockPaymentGateway, type MockPaymentPayload } from "../../packages/db/src/tennis/mock-payments.ts";
import { getWallet, recordOfflineTopup } from "../../packages/db/src/tennis/wallet.ts";
import { occupyCourt, releaseCourtOccupancy } from "../../packages/db/src/tennis/inventory.ts";
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
const gateway = new LocalMockPaymentGateway("only-synthetic-amendment-test-signing-secret", "local-simulation");
const key = () => randomUUID();
const time = (hm: string) => `2099-09-18T${hm}:00+08:00`;
let first: TenantFixture, other: TenantFixture, customer: CustomerActor, courts: string[];
async function book(indices = [0], walletCents?: number) {
  const quote = await createQuote(db, customer, {
    venueId: first.venueId,
    customerId: customer.customerId,
    lines: indices.map((i) => ({ courtId: courts[i]!, startAt: time("18:00"), endAt: time("19:00") })),
  });
  const order = await confirmQuote(db, customer, { quoteId: quote.id, commandKey: key() });
  if (order.totalCents) {
    const payment = await beginOrderPayment(db, customer, gateway, {
      orderId: order.id,
      walletCents: walletCents ?? order.totalCents,
      commandKey: key(),
    });
    if (payment.externalCents) await settleVerifiedPayment(db, event(payment));
  }
  return getOrder(db, customer, order.id);
}
function event(payment: PaymentRecord, overrides: Partial<MockPaymentPayload> = {}) {
  const signed = gateway.signForLocalSimulator({
    provider: "MOCK",
    merchantId: payment.merchantId,
    paymentId: payment.id,
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
async function settleRefund(refund: RefundRecord) {
  if (!refund.externalCents) return;
  const payment = await getOrderPayment(db, customer, refund.paymentId);
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
  });
  const payload = gateway.verifyRefund(signed.body, signed.signature);
  await settleVerifiedRefund(db, payload);
  await settleVerifiedRefund(db, payload);
}
async function preview(order: OrderRecord, index = 2, start = "19:00", end = "20:00") {
  return previewOrderAmendment(db, first.actor, {
    orderId: order.id,
    expectedRevision: order.revision,
    reason: "客户确认改期",
    changes: [{ lineId: order.lines[0]!.id, courtId: courts[index]!, startAt: time(start), endAt: time(end) }],
  });
}
async function confirm(amendment: AmendmentRecord) {
  return confirmOrderAmendment(db, first.actor, {
    amendmentId: amendment.id,
    commandKey: key(),
    approvedRefundLines: amendment.lines
      .filter((l) => l.suggestedRefundCents > 0)
      .map((l) => ({ lineId: l.lineId, refundCents: l.suggestedRefundCents })),
  });
}
async function pay(amendment: AmendmentRecord, walletCents = amendment.supplementalCents) {
  const payment = await beginAmendmentPayment(db, customer, gateway, {
    amendmentId: amendment.id,
    walletCents,
    commandKey: key(),
  });
  return payment.externalCents ? settleVerifiedPayment(db, event(payment)) : payment;
}
async function active() {
  return (
    await db.query<{ id: string; court_id: string; start_at: Date; end_at: Date; amendment_id: string | null }>(
      "SELECT id,court_id,start_at,end_at,amendment_id FROM tennis.occupancies WHERE tenant_id=$1 AND released_at IS NULL ORDER BY start_at",
      [first.actor.tenantId],
    )
  ).rows;
}
beforeAll(async () => {
  const tx = await db.connect();
  try {
    await migrateTennis(tx);
    await tx.query("SELECT id FROM tennis.order_amendments LIMIT 0");
  } finally {
    tx.release();
  }
});
beforeEach(async () => {
  first = await seedTenantFixture(db);
  other = await seedTenantFixture(db);
  const venue = (await listVenues(db, first.actor))[0]!;
  await updateVenue(db, first.actor, {
    ...venue,
    expectedRevision: venue.catalogRevision,
    openingHours: Array.from({ length: 7 }, (_, weekday) => ({ weekday, startMinute: 480, endMinute: 1320 })),
    minimumBookingMinutes: 15,
  });
  courts = [];
  for (const [i, price] of [10000, 8000, 12000, 10000].entries()) {
    const court = await createCourt(db, first.actor, { venueId: first.venueId, name: `合成球场${i}`, indoor: true });
    await setCourtPrice(db, first.actor, {
      venueId: first.venueId,
      courtId: court.id,
      expectedRevision: court.revision,
      hourlyPriceCents: price,
    });
    courts.push(court.id);
  }
  const profile = await createCustomer(db, first.actor, { nickname: "改期客户" }),
    subjectId = key();
  await db.query("INSERT INTO tennis.subjects(id,display_name) VALUES($1,'synthetic amendment customer')", [subjectId]);
  await db.query("UPDATE tennis.customers SET subject_id=$1 WHERE tenant_id=$2 AND id=$3", [
    subjectId,
    first.actor.tenantId,
    profile.id,
  ]);
  customer = { kind: "customer", tenantId: first.actor.tenantId, subjectId, customerId: profile.id };
  await recordOfflineTopup(db, first.actor, {
    venueId: first.venueId,
    customerId: profile.id,
    principalCents: 1000000,
    giftCents: 200000,
    receiptReference: key(),
    reason: "模拟充值",
    commandKey: key(),
  });
});
afterEach(async () => {
  if (first) await removeTenantFixture(db, first);
  if (other) await removeTenantFixture(db, other);
  if (customer) await db.query("DELETE FROM tennis.subjects WHERE id=$1", [customer.subjectId]);
});
afterAll(() => db.end());
describe("paid order amendments", () => {
  it("moves an overlapping interval atomically at equal price and preserves the immutable original", async () => {
    const order = await book();
    const proposal = await preview(order, 0, "18:30", "19:30");
    expect(proposal.supplementalCents).toBe(0);
    expect((await confirm(proposal)).status).toBe("APPLIED");
    const after = await getOrder(db, customer, order.id);
    expect(after.id).toBe(order.id);
    expect(after.lines[0]!.startAt).toBe(new Date(time("18:30")).toISOString());
    expect(await active()).toHaveLength(1);
    expect((await getOrderAmendment(db, customer, proposal.id)).lines[0]!.old.startAt).toBe(order.lines[0]!.startAt);
  });
  it("supports two courts swapping intervals with a zero-net financial transfer", async () => {
    const order = await book([0, 1]);
    const proposal = await previewOrderAmendment(db, first.actor, {
      orderId: order.id,
      expectedRevision: order.revision,
      reason: "两片互换",
      changes: order.lines.map((line, i) => ({
        lineId: line.id,
        courtId: courts[i === 0 ? 1 : 0]!,
        startAt: line.startAt,
        endAt: line.endAt,
      })),
    });
    expect(proposal.supplementalCents).toBe(0);
    expect(proposal.suggestedRefundCents).toBe(0);
    await confirm(proposal);
    const changed = await getOrder(db, customer, order.id);
    expect(changed.lines.map((l) => l.amountCents)).toEqual([8000, 10000]);
    expect(await active()).toHaveLength(2);
    const refund = await requestOrderRefundGroup(db, first.actor, {
      orderId: order.id,
      expectedRevision: changed.revision,
      reason: "取消使用",
      commandKey: key(),
      lines: changed.lines.map((l) => ({ lineId: l.id, refundCents: l.amountCents, cancel: true })),
    });
    expect(refund.amountCents).toBe(18000);
    expect(refund.status).toBe("SUCCEEDED");
    expect((await getWallet(db, customer, customer.customerId)).balance.totalCents).toBe(1200000);
  });
  it("holds only N minus O and captures only a mixed payment supplement", async () => {
    const order = await book();
    const proposal = await confirm(await preview(order, 0, "18:30", "20:00"));
    expect(proposal.supplementalCents).toBe(5000);
    const holds = await active();
    expect(holds).toHaveLength(2);
    expect(holds.find((o) => o.amendment_id)?.start_at.toISOString()).toBe(new Date(time("19:00")).toISOString());
    const pending = await beginAmendmentPayment(db, customer, gateway, {
      amendmentId: proposal.id,
      walletCents: 2000,
      commandKey: key(),
    });
    expect(pending.externalCents).toBe(3000);
    expect((await getOrder(db, customer, order.id)).lines[0]!.startAt).toBe(order.lines[0]!.startAt);
    const notice = event(pending);
    await Promise.all([settleVerifiedPayment(db, notice), settleVerifiedPayment(db, notice)]);
    expect((await getOrderAmendment(db, customer, proposal.id)).status).toBe("APPLIED");
    expect((await getOrder(db, customer, order.id)).totalCents).toBe(15000);
    expect(await active()).toHaveLength(1);
    expect(
      (
        await db.query("SELECT id FROM tennis.payment_attempts WHERE tenant_id=$1 AND status='SUCCEEDED'", [
          first.actor.tenantId,
        ])
      ).rowCount,
    ).toBe(2);
  });
  it("protects staged intervals from normal inventory edits and competing bookings", async () => {
    const order = await book();
    const proposal = await confirm(await preview(order, 0, "18:30", "20:00"));
    const hold = (await active()).find((o) => o.amendment_id)!;
    await expect(releaseCourtOccupancy(db, first.actor, hold.id, 1)).rejects.toMatchObject({
      code: "ORDER_MANAGED_OCCUPANCY",
    });
    await expect(
      createQuote(db, customer, {
        venueId: first.venueId,
        customerId: customer.customerId,
        lines: [{ courtId: courts[0]!, startAt: time("19:00"), endAt: time("20:00") }],
      }),
    ).rejects.toMatchObject({ code: "INVENTORY_CONFLICT" });
    await cancelOrderAmendment(db, first.actor, { amendmentId: proposal.id, reason: "保留原时段", commandKey: key() });
    expect(await active()).toHaveLength(1);
  });
  it("rolls back a whole group when a target court is occupied after preview", async () => {
    const order = await book([0, 1]);
    const proposal = await previewOrderAmendment(db, first.actor, {
      orderId: order.id,
      expectedRevision: order.revision,
      reason: "一起延后",
      changes: order.lines.map((l) => ({
        lineId: l.id,
        courtId: l.courtId,
        startAt: time("19:00"),
        endAt: time("20:00"),
      })),
    });
    await occupyCourt(db, first.actor, {
      id: key(),
      courtId: courts[1]!,
      kind: "MAINTENANCE",
      sourceId: key(),
      startAt: time("19:00"),
      endAt: time("20:00"),
    });
    await expect(confirm(proposal)).rejects.toMatchObject({ code: "INVENTORY_CONFLICT" });
    expect((await getOrder(db, customer, order.id)).lines).toEqual(order.lines);
    expect((await active()).filter((o) => o.amendment_id)).toHaveLength(0);
  });
  it("failed supplemental payment releases only new holds and reserved money", async () => {
    const order = await book();
    const proposal = await confirm(await preview(order));
    const payment = await beginAmendmentPayment(db, customer, gateway, {
      amendmentId: proposal.id,
      walletCents: 1000,
      commandKey: key(),
    });
    expect((await settleVerifiedPayment(db, event(payment, { status: "FAILED" }))).status).toBe("FAILED");
    expect((await getOrder(db, customer, order.id)).lines).toEqual(order.lines);
    expect((await getOrder(db, customer, order.id)).status).toBe("CONFIRMED");
    expect(await active()).toHaveLength(1);
    expect((await getWallet(db, customer, customer.customerId)).balance.reservedCents).toBe(0);
  });
  it("expires pending amendments and treats racing late money as a refund task without losing the original", async () => {
    const order = await book();
    const proposal = await confirm(await preview(order));
    const payment = await beginAmendmentPayment(db, customer, gateway, {
      amendmentId: proposal.id,
      walletCents: 1000,
      commandKey: key(),
    });
    await db.query("UPDATE tennis.order_amendments SET hold_until=clock_timestamp()-interval '1 second' WHERE id=$1", [
      proposal.id,
    ]);
    const [, settled] = await Promise.all([expireDueAmendments(db), settleVerifiedPayment(db, event(payment))]);
    expect(settled.status).toBe("REFUND_REQUIRED");
    expect((await getOrder(db, customer, order.id)).lines).toEqual(order.lines);
    expect(await active()).toHaveLength(1);
    expect(
      (
        await db.query("SELECT id FROM tennis.financial_exceptions WHERE tenant_id=$1 AND kind='LATE_PAYMENT'", [
          first.actor.tenantId,
        ])
      ).rowCount,
    ).toBe(1);
  });
  it("requires explicit employee refund amounts and keeps new bookings when external refunds are pending", async () => {
    const order = await book([0], 0);
    const proposal = await preview(order, 1);
    await expect(
      confirmOrderAmendment(db, first.actor, { amendmentId: proposal.id, commandKey: key() }),
    ).rejects.toMatchObject({ code: "INVALID_AMENDMENT" });
    const applied = await confirm(proposal);
    expect(applied.status).toBe("APPLIED");
    expect(applied.refundGroupId).toBeTruthy();
    const group = await getRefundGroup(db, customer, applied.refundGroupId!);
    expect(group).toMatchObject({ amountCents: 2000, status: "REQUESTED" });
    expect((await getOrder(db, customer, order.id)).lines[0]!.courtId).toBe(courts[1]);
    await settleRefund(group.refunds[0]!);
    expect((await getRefundGroup(db, customer, group.id)).status).toBe("SUCCEEDED");
    expect(await active()).toHaveLength(1);
  });
  it("conserves all amounts across 100 to 80 refund 20 to 120 supplement 40 and full cancellation", async () => {
    const order = await book();
    await confirm(await preview(order, 1));
    let current = await getOrder(db, customer, order.id);
    expect(current.totalCents).toBe(8000);
    const increase = await confirm(await preview(current, 2, "20:00", "21:00"));
    expect(increase.supplementalCents).toBe(4000);
    await pay(increase);
    current = await getOrder(db, customer, order.id);
    const group = await requestOrderRefundGroup(db, first.actor, {
      orderId: order.id,
      expectedRevision: current.revision,
      reason: "全部取消",
      commandKey: key(),
      lines: [{ lineId: current.lines[0]!.id, refundCents: 12000, cancel: true }],
    });
    expect(group.refunds).toHaveLength(2);
    expect(group.status).toBe("SUCCEEDED");
    expect((await getWallet(db, customer, customer.customerId)).balance).toMatchObject({
      totalCents: 1200000,
      principalCents: 1000000,
      giftCents: 200000,
    });
    expect((await getOrder(db, customer, order.id)).paymentStatus).toBe("REFUNDED");
  });
  it("refunds multiple mixed payments to their original transactions and wallet batches", async () => {
    const order = await book([0], 5000);
    const proposal = await confirm(await preview(order));
    await pay(proposal, 1000);
    const current = await getOrder(db, customer, order.id);
    const group = await requestOrderRefundGroup(db, first.actor, {
      orderId: order.id,
      expectedRevision: current.revision,
      reason: "多次收款原路退款",
      commandKey: key(),
      lines: [{ lineId: current.lines[0]!.id, refundCents: 12000, cancel: true }],
    });
    expect(group.refunds).toHaveLength(2);
    expect(group.refunds.reduce((s, r) => s + r.externalCents, 0)).toBe(6000);
    expect(group.refunds.reduce((s, r) => s + r.walletCents, 0)).toBe(6000);
    await settleRefund(group.refunds[0]!);
    expect((await getRefundGroup(db, customer, group.id)).status).toBe("PROCESSING");
    await settleRefund(group.refunds[1]!);
    expect((await getRefundGroup(db, customer, group.id)).status).toBe("SUCCEEDED");
    expect((await getWallet(db, customer, customer.customerId)).balance).toMatchObject({
      totalCents: 1200000,
      principalCents: 1000000,
      giftCents: 200000,
    });
  });
  it("preserves a prior goodwill refund and caps later reductions by actual remaining funds", async () => {
    const order = await book();
    await requestOrderRefundGroup(db, first.actor, {
      orderId: order.id,
      expectedRevision: order.revision,
      reason: "人工补偿",
      commandKey: key(),
      lines: [{ lineId: order.lines[0]!.id, refundCents: 3000, cancel: false }],
    });
    const current = await getOrder(db, customer, order.id);
    const proposal = await preview(current, 1);
    expect(proposal.suggestedRefundCents).toBe(2000);
    await confirm(proposal);
    const changed = await getOrder(db, customer, order.id);
    await expect(
      requestOrderRefundGroup(db, first.actor, {
        orderId: order.id,
        expectedRevision: changed.revision,
        reason: "禁止超退",
        commandKey: key(),
        lines: [{ lineId: order.lines[0]!.id, refundCents: 8000, cancel: true }],
      }),
    ).rejects.toMatchObject({ code: "REFUND_EXCEEDS_PAYMENT" });
    await requestOrderRefundGroup(db, first.actor, {
      orderId: order.id,
      expectedRevision: changed.revision,
      reason: "余额全退",
      commandKey: key(),
      lines: [{ lineId: order.lines[0]!.id, refundCents: 5000, cancel: true }],
    });
    expect((await getWallet(db, customer, customer.customerId)).balance.totalCents).toBe(1200000);
  });
  it.each([0, 12000])(
    "supports free-to-paid and paid-to-free without fabricating an initial successful payment: wallet $0",
    async (wallet) => {
      await db.query("UPDATE tennis.courts SET hourly_price_cents=0 WHERE tenant_id=$1 AND id=$2", [
        first.actor.tenantId,
        courts[0],
      ]);
      const order = await book();
      expect(order.paymentStatus).toBe("NOT_REQUIRED");
      const charge = await confirm(await preview(order));
      expect(charge.supplementalCents).toBe(12000);
      await pay(charge, wallet);
      const paid = await getOrder(db, customer, order.id);
      const applied = await confirm(await preview(paid, 0, "20:00", "21:00"));
      if (applied.refundGroupId) {
        for (const refund of (await getRefundGroup(db, customer, applied.refundGroupId)).refunds)
          await settleRefund(refund);
      }
      expect((await getOrder(db, customer, order.id)).paymentStatus).toBe("REFUNDED");
      expect((await getWallet(db, customer, customer.customerId)).balance.totalCents).toBe(1200000);
    },
  );
  it("recovers the same result for duplicate confirmations and rejects changed intent", async () => {
    const order = await book();
    const proposal = await preview(order, 3);
    const input = { amendmentId: proposal.id, commandKey: key() };
    const results = await Promise.all([
      confirmOrderAmendment(db, first.actor, input),
      confirmOrderAmendment(db, first.actor, input),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect((await confirmOrderAmendment(db, first.actor, { ...input, commandKey: key() })).id).toBe(proposal.id);
    expect((await getCommandReceipt(db, first.actor, input.commandKey))?.result.amendmentId).toBe(proposal.id);
    expect(await active()).toHaveLength(1);
    await expect(
      confirmOrderAmendment(db, first.actor, {
        ...input,
        approvedRefundLines: [{ lineId: order.lines[0]!.id, refundCents: 0 }],
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });
  it("denies customer refund approvals, cross-tenant access, and stale previews", async () => {
    const order = await book();
    const proposal = await preview(order);
    await expect(
      confirmOrderAmendment(db, customer, { amendmentId: proposal.id, commandKey: key() }),
    ).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
    await expect(getOrderAmendment(db, other.actor, proposal.id)).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    await db.query("UPDATE tennis.order_amendments SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [
      proposal.id,
    ]);
    await expect(confirm(proposal)).rejects.toMatchObject({ code: "AMENDMENT_EXPIRED" });
    expect((await getOrder(db, customer, order.id)).lines).toEqual(order.lines);
  });
  it("serializes competing amendments and blocks refunds until the pending change is resolved", async () => {
    const order = await book();
    const a = await preview(order),
      b = await preview(order, 2, "20:00", "21:00");
    const results = await Promise.allSettled([confirm(a), confirm(b)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    await expect(
      requestOrderRefundGroup(db, first.actor, {
        orderId: order.id,
        expectedRevision: order.revision,
        reason: "先完成改期",
        commandKey: key(),
        lines: [{ lineId: order.lines[0]!.id, refundCents: 10000, cancel: true }],
      }),
    ).rejects.toMatchObject({ code: "ORDER_AMENDMENT_PENDING" });
  });
  it("changes disconnected intervals without occupying the gap or touching other lines", async () => {
    const quote = await createQuote(db, customer, {
      venueId: first.venueId,
      customerId: customer.customerId,
      lines: [
        { courtId: courts[0]!, startAt: time("16:00"), endAt: time("17:00") },
        { courtId: courts[0]!, startAt: time("18:00"), endAt: time("19:00") },
      ],
    });
    const original = await confirmQuote(db, customer, { quoteId: quote.id, commandKey: key() });
    await beginOrderPayment(db, customer, gateway, { orderId: original.id, walletCents: 20000, commandKey: key() });
    const order = await getOrder(db, customer, original.id);
    await confirm(await preview(order, 0, "15:00", "16:00"));
    const changed = await getOrder(db, customer, order.id);
    expect(changed.lines[1]).toEqual(order.lines[1]);
    expect(
      (
        await createQuote(db, customer, {
          venueId: first.venueId,
          customerId: customer.customerId,
          lines: [{ courtId: courts[0]!, startAt: time("16:00"), endAt: time("18:00") }],
        })
      ).price.totalCents,
    ).toBe(20000);
  });
  it.each([
    { end: "20:00", supplement: 0, refund: 2000 },
    { end: "20:30", supplement: 4000, refund: 0 },
  ])("conserves per-line caps for simultaneous rises and falls: $end", async ({ end, supplement, refund }) => {
    const order = await book([0, 2]);
    const proposal = await previewOrderAmendment(db, first.actor, {
      orderId: order.id,
      expectedRevision: order.revision,
      reason: "多片共同改期",
      changes: [
        { lineId: order.lines[0]!.id, courtId: courts[2]!, startAt: time("19:00"), endAt: time(end) },
        { lineId: order.lines[1]!.id, courtId: courts[1]!, startAt: time("19:00"), endAt: time("20:00") },
      ],
    });
    expect(proposal.supplementalCents).toBe(supplement);
    expect(proposal.suggestedRefundCents).toBe(refund);
    await confirm(proposal);
    if (supplement) await pay(proposal);
    const current = await getOrder(db, customer, order.id);
    const group = await requestOrderRefundGroup(db, first.actor, {
      orderId: order.id,
      expectedRevision: current.revision,
      reason: "逐明细全退",
      commandKey: key(),
      lines: current.lines.map((l) => ({ lineId: l.id, refundCents: l.amountCents, cancel: true })),
    });
    expect(group.status).toBe("SUCCEEDED");
    expect((await getWallet(db, customer, customer.customerId)).balance.totalCents).toBe(1200000);
  });
  it("keeps an explicitly retained fee separate from the current price and permits refunding the actual balance later", async () => {
    const order = await book();
    const proposal = await preview(order, 1);
    await confirmOrderAmendment(db, first.actor, {
      amendmentId: proposal.id,
      commandKey: key(),
      approvedRefundLines: [{ lineId: order.lines[0]!.id, refundCents: 0 }],
    });
    const current = await getOrder(db, customer, order.id);
    expect(current.totalCents).toBe(8000);
    const group = await requestOrderRefundGroup(db, first.actor, {
      orderId: order.id,
      expectedRevision: current.revision,
      reason: "退场地和保留费用",
      commandKey: key(),
      lines: [{ lineId: order.lines[0]!.id, refundCents: 10000, cancel: true }],
    });
    expect(group.amountCents).toBe(10000);
    expect((await getWallet(db, customer, customer.customerId)).balance.totalCents).toBe(1200000);
  });
  it("keeps supplement quote prices fixed and does not consume wallet twice on repeated payment commands", async () => {
    const order = await book();
    const proposal = await preview(order);
    await db.query("UPDATE tennis.courts SET hourly_price_cents=15000 WHERE tenant_id=$1 AND id=$2", [
      first.actor.tenantId,
      courts[2],
    ]);
    await confirm(proposal);
    const input = { amendmentId: proposal.id, walletCents: 2000, commandKey: key() };
    const results = await Promise.all([
      beginAmendmentPayment(db, customer, gateway, input),
      beginAmendmentPayment(db, customer, gateway, input),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect((await getOrder(db, customer, order.id)).totalCents).toBe(12000);
    expect(
      (
        await db.query("SELECT id FROM tennis.wallet_entries WHERE tenant_id=$1 AND source_id=$2 AND kind='CONSUME'", [
          first.actor.tenantId,
          results[0]!.id,
        ])
      ).rowCount,
    ).toBe(1);
  });

  it("does not invalidate a pending supplement when an already committed refund finishes", async () => {
    const order = await book([0], 0);
    const originalRefund = await requestOrderRefundGroup(db, first.actor, {
      orderId: order.id,
      expectedRevision: order.revision,
      reason: "已同意人工补偿",
      commandKey: key(),
      lines: [{ lineId: order.lines[0]!.id, refundCents: 2000, cancel: false }],
    });
    const proposal = await confirm(await preview(await getOrder(db, customer, order.id)));
    const pending = await beginAmendmentPayment(db, customer, gateway, {
      amendmentId: proposal.id,
      walletCents: 1000,
      commandKey: key(),
    });
    await settleRefund(originalRefund.refunds[0]!);
    expect((await settleVerifiedPayment(db, event(pending))).status).toBe("SUCCEEDED");
    expect((await getOrderAmendment(db, customer, proposal.id)).status).toBe("APPLIED");
  });
  it("can release an active booking after all its funds were refunded without inventing another charge", async () => {
    const order = await book();
    await requestOrderRefundGroup(db, first.actor, {
      orderId: order.id,
      expectedRevision: order.revision,
      reason: "保留使用全额补偿",
      commandKey: key(),
      lines: [{ lineId: order.lines[0]!.id, refundCents: 10000, cancel: false }],
    });
    const current = await getOrder(db, customer, order.id);
    expect(current.paymentStatus).toBe("REFUNDED");
    await requestOrderRefundGroup(db, first.actor, {
      orderId: order.id,
      expectedRevision: current.revision,
      reason: "后来取消使用",
      commandKey: key(),
      lines: [{ lineId: order.lines[0]!.id, refundCents: 0, cancel: true }],
    });
    expect(await active()).toHaveLength(0);
    expect((await getWallet(db, customer, customer.customerId)).balance.totalCents).toBe(1200000);
  });

  it("records captured money for refund if a new minimum-duration rule prevents completing the change", async () => {
    const order = await book();
    const proposal = await confirm(await preview(order));
    const payment = await beginAmendmentPayment(db, customer, gateway, {
      amendmentId: proposal.id,
      walletCents: 1000,
      commandKey: key(),
    });
    const venue = (await listVenues(db, first.actor))[0]!;
    await updateVenue(db, first.actor, {
      ...venue,
      expectedRevision: venue.catalogRevision,
      minimumBookingMinutes: 120,
    });
    expect((await settleVerifiedPayment(db, event(payment))).status).toBe("REFUND_REQUIRED");
    expect((await getOrder(db, customer, order.id)).lines).toEqual(order.lines);
    expect(await active()).toHaveLength(1);
    expect(
      (
        await db.query("SELECT id FROM tennis.financial_exceptions WHERE tenant_id=$1 AND payment_id=$2", [
          first.actor.tenantId,
          payment.id,
        ])
      ).rowCount,
    ).toBe(1);
  });

  it("cancels individual originally free lines with staff authority and no artificial financial transactions", async () => {
    await db.query("UPDATE tennis.courts SET hourly_price_cents=0 WHERE tenant_id=$1 AND id=ANY($2::text[])", [
      first.actor.tenantId,
      [courts[0], courts[1]],
    ]);
    const order = await book([0, 1]);
    const input = {
      orderId: order.id,
      expectedRevision: order.revision,
      lineIds: [order.lines[0]!.id],
      commandKey: key(),
      reason: "免费活动退一片",
    };
    await expect(cancelFreeOrderLines(db, customer, input)).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
    const results = await Promise.all([
      cancelFreeOrderLines(db, first.actor, input),
      cancelFreeOrderLines(db, first.actor, input),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]!.status).toBe("CONFIRMED");
    expect(results[0]!.lines[0]!.cancelledAt).toBeTruthy();
    expect(results[0]!.lines[1]).toEqual(order.lines[1]);
    expect(await active()).toHaveLength(1);
    expect(
      (await db.query("SELECT id FROM tennis.payment_attempts WHERE tenant_id=$1", [first.actor.tenantId])).rowCount,
    ).toBe(0);
    expect((await db.query("SELECT id FROM tennis.refunds WHERE tenant_id=$1", [first.actor.tenantId])).rowCount).toBe(
      0,
    );
    expect(
      (
        await cancelFreeOrderLines(db, first.actor, {
          ...input,
          expectedRevision: results[0]!.revision,
          lineIds: [order.lines[1]!.id],
          commandKey: key(),
        })
      ).status,
    ).toBe("CANCELLED");
    expect(await active()).toHaveLength(0);
  });
  it("does not let the free-line endpoint release a paid booking or access another tenant", async () => {
    const order = await book();
    const input = {
      orderId: order.id,
      expectedRevision: order.revision,
      lineIds: [order.lines[0]!.id],
      commandKey: key(),
      reason: "不能跳过退款确认",
    };
    await expect(cancelFreeOrderLines(db, first.actor, input)).rejects.toMatchObject({ code: "ORDER_REQUIRES_REFUND" });
    await expect(cancelFreeOrderLines(db, other.actor, input)).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    expect(await active()).toHaveLength(1);
  });
});
