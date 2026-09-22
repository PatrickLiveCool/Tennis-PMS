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
import {
  beginAmendmentPayment,
  cancelUnpaidOrderLines,
  confirmOrderAmendment,
  previewOrderAmendment,
} from "../../packages/db/src/tennis/amendments.ts";
import { beginOrderPayment, settleVerifiedPayment, type PaymentRecord } from "../../packages/db/src/tennis/payments.ts";
import {
  requestOrderRefundGroup,
  retryFailedRefund,
  settleVerifiedRefund,
  type RefundRecord,
} from "../../packages/db/src/tennis/refunds.ts";
import { recordOfflineTopup } from "../../packages/db/src/tennis/wallet.ts";
import {
  beginTopupPayment,
  createTopupQuote,
  saveTopupOffer,
  settleVerifiedTopup,
  type TopupPayment,
} from "../../packages/db/src/tennis/topups.ts";
import {
  createConversation,
  handoffConversation,
  issueDelegation,
  resolveDelegation,
} from "../../packages/db/src/tennis/external-agent.ts";
import { pollBusinessEvents } from "../../packages/db/src/tennis/business-events.ts";
import { LocalMockPaymentGateway, type MockPaymentPayload } from "../../packages/db/src/tennis/mock-payments.ts";
import { seedTenantFixture, removeTenantFixture, syntheticPhone, type TenantFixture } from "./tenant-fixture.ts";

const db = new pg.Pool({
  connectionString: assertLocalTennisDatabaseUrl(
    process.env.TENNIS_TEST_DATABASE_URL ?? localTennisTestDatabaseUrl,
    "test",
  ),
  max: 8,
  connectionTimeoutMillis: 5000,
  statement_timeout: 10000,
});
const gateway = new LocalMockPaymentGateway("events-only-synthetic-private-signing-secret", "local-simulation");
const key = () => randomUUID();
const time = (hour: number) => `2099-09-18T${String(hour).padStart(2, "0")}:00:00+08:00`;
let first: TenantFixture, second: TenantFixture, customer: CustomerActor, courtId: string;
let subjects: string[];
async function configureCourt(venueId: string, fixture = first) {
  const venue = (await listVenues(db, fixture.actor)).find((row) => row.id === venueId)!;
  await updateVenue(db, fixture.actor, {
    ...venue,
    expectedRevision: venue.catalogRevision,
    minimumBookingMinutes: 15,
    openingHours: Array.from({ length: 7 }, (_, weekday) => ({ weekday, startMinute: 480, endMinute: 1320 })),
  });
  const court = await createCourt(db, fixture.actor, { venueId, name: "事件合成球场", indoor: true, surface: "ACRYLIC", profile: { specification: "STANDARD" }, hourlyPriceCents: 12000 });
  await setCourtPrice(db, fixture.actor, {
    venueId,
    courtId: court.id,
    expectedRevision: court.revision,
    hourlyPriceCents: 12000,
  });
  return court.id;
}
async function profile(fixture = first): Promise<CustomerActor> {
  const record = await createCustomer(db, fixture.actor, { nickname: "事件合成客户", phone: syntheticPhone() });
  const subjectId = key();
  subjects.push(subjectId);
  await db.query("INSERT INTO tennis.subjects(id,display_name) VALUES($1,'synthetic event customer')", [subjectId]);
  await db.query("UPDATE tennis.customers SET subject_id=$1 WHERE tenant_id=$2 AND id=$3", [
    subjectId,
    fixture.actor.tenantId,
    record.id,
  ]);
  return { ...fixture.actor, subjectId, kind: "customer", customerId: record.id };
}
async function book(hour = 19, actor = customer, venueId = first.venueId, courtIds = [courtId]) {
  const quote = await createQuote(db, actor, {
    venueId,
    customerId: actor.customerId,
    lines: courtIds.map((id) => ({ courtId: id, startAt: time(hour), endAt: time(hour + 1) })),
  });
  return confirmQuote(db, actor, { quoteId: quote.id, commandKey: key() });
}
async function credit(principalCents = 10000, giftCents = 2000, actor = customer, venueId = first.venueId) {
  return recordOfflineTopup(db, first.actor, {
    venueId,
    customerId: actor.customerId,
    principalCents,
    giftCents,
    receiptReference: key(),
    reason: "合成实收",
    commandKey: key(),
  });
}
async function events(actor = first.actor, venueId = first.venueId) {
  return (await pollBusinessEvents(db, actor, venueId, { pageSize: 100 })).events;
}
function paymentEvent(payment: PaymentRecord | TopupPayment, overrides: Partial<MockPaymentPayload> = {}) {
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
function refundEvent(refund: RefundRecord, payment: PaymentRecord, status: "SUCCEEDED" | "FAILED") {
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
beforeAll(async () => {
  const tx = await db.connect();
  try {
    await migrateTennis(tx);
  } finally {
    tx.release();
  }
});
beforeEach(async () => {
  subjects = [];
  first = await seedTenantFixture(db);
  second = await seedTenantFixture(db);
  courtId = await configureCourt(first.venueId);
  customer = await profile();
});
afterEach(async () => {
  const fixtures = [first, second].filter(Boolean);
  await db.query("DELETE FROM tennis.agent_conversations WHERE tenant_id=ANY($1::text[])", [
    fixtures.map((fixture) => fixture.actor.tenantId),
  ]);
  for (const fixture of fixtures) await removeTenantFixture(db, fixture);
  await db.query("DELETE FROM tennis.subjects WHERE id=ANY($1::text[])", [subjects]);
});
afterAll(() => db.end());

describe("transactional business event feed", () => {
  it("publishes a stable held event, rolls back facts and events together, and emits expiry only after it occurs", async () => {
    const order = await book();
    const firstPage = await pollBusinessEvents(db, customer, first.venueId);
    expect(firstPage.events).toEqual([
      expect.objectContaining({
        type: "booking.held",
        schemaVersion: 1,
        tenantId: first.actor.tenantId,
        venueId: first.venueId,
        customerId: customer.customerId,
        subjectId: customer.subjectId,
        resource: { type: "order", id: order.id, version: 1 },
        payload: expect.objectContaining({ status: "HELD", paymentStatus: "UNPAID" }),
      }),
    ]);
    expect(firstPage.hasMore).toBe(false);
    expect(firstPage.nextCursor).toBe(firstPage.events[0]!.eventId);
    const tx = await db.connect();
    try {
      await tx.query("BEGIN");
      await tx.query(
        "UPDATE tennis.orders SET status='CANCELLED',hold_until=NULL,revision=revision+1 WHERE tenant_id=$1 AND id=$2",
        [first.actor.tenantId, order.id],
      );
      expect(
        (
          await tx.query("SELECT 1 FROM tennis.business_events WHERE tenant_id=$1 AND event_type='booking.cancelled'", [
            first.actor.tenantId,
          ])
        ).rowCount,
      ).toBe(1);
      expect(await pollBusinessEvents(db, customer, first.venueId, { cursor: firstPage.nextCursor! })).toEqual({
        events: [],
        nextCursor: firstPage.nextCursor,
        hasMore: false,
      });
      await tx.query("ROLLBACK");
    } finally {
      await tx.query("ROLLBACK");
      tx.release();
    }
    expect((await getOrder(db, customer, order.id)).status).toBe("HELD");
    expect(await events(customer)).toEqual(firstPage.events);
    await db.query(
      "UPDATE tennis.orders SET hold_until=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND id=$2",
      [first.actor.tenantId, order.id],
    );
    expect((await getOrder(db, customer, order.id)).status).toBe("EXPIRED");
    const later = await pollBusinessEvents(db, customer, first.venueId, { cursor: firstPage.nextCursor! });
    expect(later.events).toEqual([
      expect.objectContaining({ type: "booking.expired", resource: { type: "order", id: order.id, version: 2 } }),
    ]);
    expect((await events(customer))[0]!.eventId).toBe(firstPage.events[0]!.eventId);
    expect(JSON.stringify(later)).not.toMatch(/tenant_sequence|tenantSequence|last_sequence/);
  });

  it("emits mixed-payment and original-source refund results exactly once per real transition", async () => {
    await credit(5000, 1000);
    const order = await book();
    const payment = await beginOrderPayment(db, customer, gateway, {
      orderId: order.id,
      walletCents: 6000,
      commandKey: key(),
    });
    expect((await events()).filter((event) => event.type === "payment.result")).toEqual([]);
    const settled = paymentEvent(payment);
    const paid = await settleVerifiedPayment(db, settled);
    await settleVerifiedPayment(db, settled);
    const facts = await events(customer);
    expect(facts.filter((event) => event.type === "payment.result")).toEqual([
      expect.objectContaining({
        resource: { type: "payment", id: payment.id, version: 1 },
        payload: expect.objectContaining({ status: "SUCCEEDED", walletCents: 6000, externalCents: 6000 }),
      }),
    ]);
    expect(facts.filter((event) => event.type === "booking.confirmed")).toHaveLength(1);
    const latest = await getOrder(db, customer, order.id);
    const group = await requestOrderRefundGroup(db, first.actor, {
      orderId: order.id,
      expectedRevision: latest.revision,
      reason: "合成退款",
      commandKey: key(),
      lines: [{ lineId: latest.lines[0]!.id, refundCents: 12000, cancel: true }],
    });
    expect(group.refunds).toHaveLength(1);
    const refund = group.refunds[0]!;
    expect((await events()).filter((event) => event.type === "refund.result")).toEqual([]);
    const failed = refundEvent(refund, paid, "FAILED");
    await settleVerifiedRefund(db, failed);
    await settleVerifiedRefund(db, failed);
    await retryFailedRefund(db, first.actor, refund.id, key());
    const success = refundEvent(refund, paid, "SUCCEEDED");
    await settleVerifiedRefund(db, success);
    await settleVerifiedRefund(db, success);
    const result = (await events()).filter((event) => event.type === "refund.result");
    expect(result.map((event) => [event.payload.status, event.resource.version])).toEqual([
      ["FAILED", 1],
      ["SUCCEEDED", 2],
    ]);
    expect(result[1]!.payload).toMatchObject({
      refundId: refund.id,
      amountCents: 12000,
      walletCents: 6000,
      externalCents: 6000,
    });
    expect(JSON.stringify(result)).not.toMatch(/merchantId|providerTransactionId|providerRefundId/);
    expect((await events()).filter((event) => event.type === "booking.cancelled")).toHaveLength(1);
    expect((await events()).filter((event) => event.type === "booking.line_cancelled")).toHaveLength(1);
  });

  it("covers pure wallet payment, offline credit and online topup recovery without duplicate credit events", async () => {
    const offline = await credit();
    const order = await book();
    const payment = await beginOrderPayment(db, customer, gateway, {
      orderId: order.id,
      walletCents: 12000,
      commandKey: key(),
    });
    expect(payment.status).toBe("SUCCEEDED");
    expect((await events()).find((event) => event.type === "payment.result")!.payload).toMatchObject({
      walletCents: 12000,
      externalCents: 0,
      status: "SUCCEEDED",
    });
    const offer = await saveTopupOffer(db, first.actor, {
      name: "事件充值档位",
      principalCents: 10000,
      giftCents: 2000,
      active: true,
    });
    const quote = await createTopupQuote(db, customer, {
      venueId: first.venueId,
      customerId: customer.customerId,
      offerId: offer.id,
    });
    const topup = await beginTopupPayment(db, customer, gateway, { quoteId: quote.id, commandKey: key() });
    const before = (await events()).filter((event) => event.type === "topup.result");
    expect(before).toHaveLength(1);
    expect(before[0]!.resource).toEqual({ type: "wallet_batch", id: offline.batchId, version: 1 });
    await settleVerifiedTopup(db, paymentEvent(topup, { status: "FAILED" }));
    const done = paymentEvent(topup);
    await settleVerifiedTopup(db, done);
    await settleVerifiedTopup(db, done);
    const results = (await events()).filter(
      (event) => event.type === "topup.result" && event.resource.type === "topup",
    );
    expect(results.map((event) => [event.payload.status, event.resource.version])).toEqual([
      ["FAILED", 1],
      ["SUCCEEDED", 2],
    ]);
    expect(results[1]!.payload).toMatchObject({ principalCents: 10000, giftCents: 2000, sourceKind: "MOCK" });
    expect((await events()).filter((event) => event.type === "topup.result")).toHaveLength(3);
  });

  it("captures partial cancellation and applied amendments, without promoting previews or unpaid orders", async () => {
    const otherCourt = await configureCourt(first.venueId);
    const order = await book(19, customer, first.venueId, [courtId, otherCourt]);
    const partial = await cancelUnpaidOrderLines(db, first.actor, {
      orderId: order.id,
      expectedRevision: order.revision,
      lineIds: [order.lines[0]!.id],
      reason: "取消一片",
      commandKey: key(),
    });
    expect(partial.status).toBe("HELD");
    const proposal = await previewOrderAmendment(db, first.actor, {
      orderId: order.id,
      expectedRevision: partial.revision,
      reason: "剩余场地改期",
      changes: [{ lineId: partial.lines[1]!.id, courtId: otherCourt, startAt: time(20), endAt: time(21) }],
    });
    expect((await events()).filter((event) => event.type === "booking.amended")).toEqual([]);
    const input = { amendmentId: proposal.id, commandKey: key() };
    await confirmOrderAmendment(db, first.actor, input);
    await confirmOrderAmendment(db, first.actor, input);
    const changes = await events(customer);
    expect(changes.map((event) => event.type)).toEqual(["booking.held", "booking.line_cancelled", "booking.amended"]);
    expect(changes[2]!.payload).toMatchObject({
      orderId: order.id,
      amendmentId: proposal.id,
      status: "APPLIED",
      unpaid: true,
    });
    expect((await getOrder(db, customer, order.id)).status).toBe("HELD");
  });

  it("does not invent a payment for a free confirmed booking", async () => {
    const revision = (
      await db.query<{ revision: number }>("SELECT revision FROM tennis.courts WHERE tenant_id=$1 AND id=$2", [
        first.actor.tenantId,
        courtId,
      ])
    ).rows[0]!.revision;
    await setCourtPrice(db, first.actor, {
      venueId: first.venueId,
      courtId,
      expectedRevision: revision,
      hourlyPriceCents: 0,
    });
    const order = await book();
    expect(order.paymentStatus).toBe("NOT_REQUIRED");
    expect(await events()).toEqual([
      expect.objectContaining({
        type: "booking.confirmed",
        payload: expect.objectContaining({ status: "CONFIRMED", paymentStatus: "NOT_REQUIRED", totalCents: 0 }),
      }),
    ]);
  });

  it("keeps failed and late payments distinct from booking success", async () => {
    await credit(5000, 1000);
    const order = await book();
    const payment = await beginOrderPayment(db, customer, gateway, {
      orderId: order.id,
      walletCents: 6000,
      commandKey: key(),
    });
    await settleVerifiedPayment(db, paymentEvent(payment, { status: "FAILED" }));
    await settleVerifiedPayment(db, paymentEvent(payment));
    const results = await events(customer);
    expect(
      results
        .filter((event) => event.type === "payment.result")
        .map((event) => [event.payload.status, event.resource.version]),
    ).toEqual([
      ["FAILED", 1],
      ["REFUND_REQUIRED", 2],
    ]);
    expect(results.some((event) => event.type === "booking.confirmed")).toBe(false);
    expect((await getOrder(db, customer, order.id)).status).toBe("CANCELLED");
  });

  it("rolls a temporary paid-amendment success back with its savepoint before publishing the refund-required result", async () => {
    await credit();
    const order = await book();
    await beginOrderPayment(db, customer, gateway, { orderId: order.id, walletCents: 12000, commandKey: key() });
    const paidOrder = await getOrder(db, customer, order.id);
    const proposal = await previewOrderAmendment(db, first.actor, {
      orderId: order.id,
      expectedRevision: paidOrder.revision,
      reason: "合成加时",
      changes: [{ lineId: order.lines[0]!.id, courtId, startAt: time(20), endAt: time(22) }],
    });
    await confirmOrderAmendment(db, first.actor, { amendmentId: proposal.id, commandKey: key() });
    const payment = await beginAmendmentPayment(db, customer, gateway, {
      amendmentId: proposal.id,
      walletCents: 0,
      commandKey: key(),
    });
    // Force a guarded asset rejection after external funds arrive. Only this synthetic court is touched.
    await db.query("UPDATE tennis.courts SET active=false WHERE tenant_id=$1 AND id=$2", [
      first.actor.tenantId,
      courtId,
    ]);
    const result = await settleVerifiedPayment(db, paymentEvent(payment));
    expect(result.status).toBe("REFUND_REQUIRED");
    const facts = await events(customer);
    expect(facts.some((event) => event.type === "booking.amended")).toBe(false);
    const paymentFacts = facts.filter((event) => event.type === "payment.result" && event.resource.id === payment.id);
    expect(paymentFacts.some((event) => event.payload.status === "SUCCEEDED")).toBe(false);
    expect(paymentFacts.at(-1)!.payload.status).toBe("REFUND_REQUIRED");
    expect(paymentFacts.map((event) => event.resource.version)).toEqual(paymentFacts.map((_, index) => index + 1));
    expect((await getOrder(db, customer, order.id)).lines[0]!.startAt).toBe(order.lines[0]!.startAt);
  });

  it("filters authorization before paging, rejects foreign cursors and revalidates revocation", async () => {
    const other = await profile();
    await credit(10000, 0, other);
    const mine = await book(18);
    await book(19, other);
    const secondVenue = await createVenue(db, first.actor, { name: "事件第二校区", timezone: "Asia/Shanghai" });
    const secondCourt = await configureCourt(secondVenue.id);
    await book(19, customer, secondVenue.id, [secondCourt]);
    const foreignCustomer = await profile(second);
    const foreignCourt = await configureCourt(second.venueId, second);
    await book(19, foreignCustomer, second.venueId, [foreignCourt]);
    const ownConversation = await createConversation(db, customer, first.venueId);
    await handoffConversation(db, customer, ownConversation.id, { mode: "HUMAN", reason: "本人请求协助" });
    const otherConversation = await createConversation(db, other, first.venueId);
    await handoffConversation(db, other, otherConversation.id, { mode: "HUMAN", reason: "其他客户请求协助" });
    const firstPage = await pollBusinessEvents(db, customer, first.venueId, { pageSize: 1 });
    expect(firstPage.events[0]!.resource.id).toBe(mine.id);
    expect(firstPage.hasMore).toBe(true);
    const secondPage = await pollBusinessEvents(db, customer, first.venueId, {
      pageSize: 1,
      cursor: firstPage.nextCursor!,
    });
    expect(secondPage.events[0]!.resource.id).toBe(ownConversation.id);
    expect(secondPage.hasMore).toBe(false);
    const empty = await pollBusinessEvents(db, customer, first.venueId, { cursor: secondPage.nextCursor! });
    expect(empty).toEqual({ events: [], nextCursor: secondPage.nextCursor, hasMore: false });
    const otherCursor = (await events(other))[0]!.eventId;
    const venueCursor = (await events(customer, secondVenue.id))[0]!.eventId;
    const tenantCursor = (await events(second.actor, second.venueId))[0]!.eventId;
    for (const cursor of [otherCursor, venueCursor, tenantCursor, key()])
      await expect(pollBusinessEvents(db, customer, first.venueId, { cursor })).rejects.toMatchObject({
        code: "INVALID_EVENT_CURSOR",
      });
    await expect(pollBusinessEvents(db, second.actor, first.venueId)).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
    });
    // A read-only employee may view booking outcomes, not recharge or private conversations.
    await db.query(
      "UPDATE tennis.tenant_memberships SET role='VIEWER',permissions=ARRAY['read'],all_venues=false WHERE tenant_id=$1 AND subject_id=$2",
      [first.actor.tenantId, first.actor.subjectId],
    );
    await db.query("INSERT INTO tennis.membership_venues(tenant_id,subject_id,venue_id) VALUES($1,$2,$3)", [
      first.actor.tenantId,
      first.actor.subjectId,
      first.venueId,
    ]);
    const staffPage = await pollBusinessEvents(db, first.actor, first.venueId, { pageSize: 1 });
    expect(staffPage.events[0]!.type).toBe("booking.held");
    expect(
      (await events()).every((event) => event.type !== "topup.result" && event.type !== "conversation.handoff"),
    ).toBe(true);
    await expect(pollBusinessEvents(db, first.actor, secondVenue.id)).rejects.toMatchObject({
      code: "TENANT_ACCESS_DENIED",
    });
    await db.query("UPDATE tennis.tenant_memberships SET active=false WHERE tenant_id=$1 AND subject_id=$2", [
      first.actor.tenantId,
      first.actor.subjectId,
    ]);
    await expect(pollBusinessEvents(db, first.actor, first.venueId)).rejects.toMatchObject({
      code: "TENANT_ACCESS_DENIED",
    });
  });

  it("records handoff generations and denies an already resolved short-term delegation after takeover", async () => {
    const conversation = await createConversation(db, customer, first.venueId);
    const token = await issueDelegation(db, customer, conversation.id);
    const delegated = await resolveDelegation(db, token.token);
    expect(await events(delegated.actor)).toEqual([]);
    await handoffConversation(db, first.actor, conversation.id, { mode: "HUMAN", reason: "授权员工接管" });
    await expect(pollBusinessEvents(db, delegated.actor, first.venueId)).rejects.toMatchObject({
      code: "AGENT_DELEGATION_REVOKED",
    });
    await handoffConversation(db, first.actor, conversation.id, { mode: "AGENT", reason: "交回智能体" });
    const handoffs = await events(customer);
    expect(handoffs.map((event) => [event.payload.mode, event.payload.generation, event.resource.version])).toEqual([
      ["HUMAN", 2, 1],
      ["AGENT", 3, 2],
    ]);
    expect(handoffs[0]!.subjectId).toBe(customer.subjectId);
    expect(handoffs[0]!.payload.takenBy).toBe(first.actor.subjectId);
  });

  it("retains commit order when a second publisher starts while the first event is uncommitted", async () => {
    const orderA = await book(18),
      orderB = await book(19);
    const baseline = await pollBusinessEvents(db, customer, first.venueId);
    const txA = await db.connect(),
      txB = await db.connect();
    let secondWrite: Promise<unknown> | undefined;
    try {
      await txA.query("BEGIN");
      await txB.query("BEGIN");
      const pidA = (await txA.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      const pidB = (await txB.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      await txA.query(
        "UPDATE tennis.orders SET status='CANCELLED',hold_until=NULL,revision=revision+1 WHERE tenant_id=$1 AND id=$2",
        [first.actor.tenantId, orderA.id],
      );
      secondWrite = txB.query(
        "UPDATE tennis.orders SET status='CANCELLED',hold_until=NULL,revision=revision+1 WHERE tenant_id=$1 AND id=$2",
        [first.actor.tenantId, orderB.id],
      );
      // Observe the database lock itself, rather than hoping a fixed delay creates the race.
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        blocked = (
          await db.query<{ blocked: boolean }>("SELECT $1::int=ANY(pg_blocking_pids($2::int)) AS blocked", [pidA, pidB])
        ).rows[0]!.blocked;
        if (blocked) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      expect((await pollBusinessEvents(db, customer, first.venueId, { cursor: baseline.nextCursor! })).events).toEqual(
        [],
      );
      await txA.query("COMMIT");
      await secondWrite;
      const committedA = await pollBusinessEvents(db, customer, first.venueId, { cursor: baseline.nextCursor! });
      expect(committedA.events.map((event) => event.resource.id)).toEqual([orderA.id]);
      await txB.query("COMMIT");
      const committedB = await pollBusinessEvents(db, customer, first.venueId, { cursor: committedA.nextCursor! });
      expect(committedB.events.map((event) => event.resource.id)).toEqual([orderB.id]);
      const retried = await pollBusinessEvents(db, customer, first.venueId, { cursor: committedA.nextCursor! });
      expect(retried).toEqual(committedB);
    } finally {
      await txA.query("ROLLBACK");
      await secondWrite?.catch(() => undefined);
      await txB.query("ROLLBACK");
      txA.release();
      txB.release();
    }
  });
});
