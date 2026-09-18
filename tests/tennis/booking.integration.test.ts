import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertLocalTennisDatabaseUrl, localTennisTestDatabaseUrl } from "../../packages/db/src/tennis/local-config.ts";
import { migrateTennis } from "../../packages/db/src/tennis/migrate.ts";
import {
  createCourt,
  listVenues,
  setCourtPrice,
  updateCourt,
  updateVenue,
  type CourtRecord,
} from "../../packages/db/src/tennis/catalog.ts";
import { createCustomer, searchCustomers, type CustomerActor } from "../../packages/db/src/tennis/customers.ts";
import {
  cancelUnpaidOrder,
  confirmQuote,
  createQuote,
  expireDueOrders,
  getCommandReceipt,
  getOrder,
  listOrders,
} from "../../packages/db/src/tennis/booking.ts";
import {
  occupyCourt,
  releaseCourtOccupancy,
  rescheduleCourtOccupancy,
} from "../../packages/db/src/tennis/inventory.ts";
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
const hours = Array.from({ length: 7 }, (_, weekday) => ({ weekday, startMinute: 480, endMinute: 1320 }));
const interval = (start = "19:00", end = "20:00") => ({
  startAt: `2099-09-18T${start}:00+08:00`,
  endAt: `2099-09-18T${end}:00+08:00`,
});
let first: TenantFixture;
let second: TenantFixture;
let customer: CustomerActor;
let courts: CourtRecord[];
const subjects: string[] = [];
const key = () => randomUUID();
function lines(indices = [0], start = "19:00", end = "20:00") {
  return indices.map((i) => ({ courtId: courts[i]!.id, ...interval(start, end) }));
}
async function quote(indices = [0], start = "19:00", end = "20:00") {
  return createQuote(db, first.actor, {
    venueId: first.venueId,
    customerId: customer.customerId,
    lines: lines(indices, start, end),
  });
}
async function confirm(indices = [0], start = "19:00", end = "20:00") {
  return confirmQuote(db, first.actor, { quoteId: (await quote(indices, start, end)).id, commandKey: key() });
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
  courts = [];
  for (let i = 0; i < 3; i++) {
    const court = await createCourt(db, first.actor, { venueId: first.venueId, name: `${i + 1} 号场`, indoor: false });
    courts.push(
      await setCourtPrice(db, first.actor, {
        courtId: court.id,
        venueId: first.venueId,
        expectedRevision: court.revision,
        hourlyPriceCents: 10000,
      }),
    );
  }
  const profile = await createCustomer(db, first.actor, { nickname: "合成客户", phone: "13800138000" });
  const subjectId = randomUUID();
  subjects.push(subjectId);
  await db.query("INSERT INTO tennis.subjects (id,display_name) VALUES ($1,'synthetic customer')", [subjectId]);
  await db.query("UPDATE tennis.customers SET subject_id=$1 WHERE tenant_id=$2 AND id=$3", [
    subjectId,
    first.actor.tenantId,
    profile.id,
  ]);
  customer = { kind: "customer", tenantId: first.actor.tenantId, subjectId, customerId: profile.id };
});
afterEach(async () => {
  if (first) await removeTenantFixture(db, first);
  if (second) await removeTenantFixture(db, second);
  for (const id of subjects.splice(0)) await db.query("DELETE FROM tennis.subjects WHERE id=$1", [id]);
});
afterAll(async () => {
  await db.end();
});

describe("quotes and atomic multi-line orders", () => {
  it("holds three simultaneous courts together with exact saved totals and independent payment status", async () => {
    const preview = await quote([0, 1, 2]);
    expect(Date.parse(preview.expiresAt) - Date.parse(preview.createdAt)).toBeCloseTo(300000, -1);
    const order = await confirmQuote(db, first.actor, { quoteId: preview.id, commandKey: key() });
    expect(order).toMatchObject({
      status: "HELD",
      paymentStatus: "UNPAID",
      totalCents: 30000,
      currency: "CNY",
      holdKind: "PAYMENT",
    });
    expect(order.lines.map((line) => line.amountCents)).toEqual([10000, 10000, 10000]);
    expect(Date.parse(order.holdUntil!) - Date.parse(order.createdAt)).toBeCloseTo(600000, -1);
    expect(
      (
        await db.query(
          "SELECT id FROM tennis.occupancies WHERE tenant_id=$1 AND source_id=$2 AND released_at IS NULL",
          [first.actor.tenantId, order.id],
        )
      ).rowCount,
    ).toBe(3);
  });
  it("rolls back a whole group if one court was taken after the quote", async () => {
    const preview = await quote([0, 1, 2]);
    await confirm([1]);
    const commandKey = key();
    await expect(confirmQuote(db, first.actor, { quoteId: preview.id, commandKey })).rejects.toMatchObject({
      code: "INVENTORY_CONFLICT",
    });
    expect(await getCommandReceipt(db, first.actor, commandKey)).toBeNull();
    expect(await listOrders(db, first.actor, first.venueId)).toHaveLength(1);
    expect(
      (
        await db.query("SELECT id FROM tennis.occupancies WHERE tenant_id=$1 AND court_id=ANY($2::text[])", [
          first.actor.tenantId,
          [courts[0]!.id, courts[2]!.id],
        ])
      ).rowCount,
    ).toBe(0);
  });
  it("serializes overlapping concurrent groups without a half-order or deadlock", async () => {
    const one = await quote([0, 1]);
    const two = await quote([1, 2]);
    const results = await Promise.allSettled([
      confirmQuote(db, first.actor, { quoteId: one.id, commandKey: key() }),
      confirmQuote(db, first.actor, { quoteId: two.id, commandKey: key() }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason.code).toBe(
      "INVENTORY_CONFLICT",
    );
    expect(
      (
        await db.query("SELECT id FROM tennis.occupancies WHERE tenant_id=$1 AND released_at IS NULL", [
          first.actor.tenantId,
        ])
      ).rowCount,
    ).toBe(2);
  });
  it("leaves gaps between one customer's different times available for other orders", async () => {
    const preview = await createQuote(db, first.actor, {
      venueId: first.venueId,
      customerId: customer.customerId,
      lines: [...lines([0], "18:00", "19:00"), ...lines([0], "20:00", "21:00"), ...lines([1], "19:00", "20:00")],
    });
    const order = await confirmQuote(db, first.actor, { quoteId: preview.id, commandKey: key() });
    const gap = await confirm([0], "19:00", "20:00");
    expect(order.lines).toHaveLength(3);
    expect(gap.status).toBe("HELD");
    await expect(quote([0], "18:30", "19:30")).rejects.toMatchObject({ code: "INVENTORY_CONFLICT" });
  });
  it("deduplicates concurrent retries and new keys for the same quote; mismatched intent is rejected", async () => {
    const preview = await quote();
    const commandKey = key();
    const input = { quoteId: preview.id, commandKey };
    const [one, two, three] = await Promise.all([
      confirmQuote(db, first.actor, input),
      confirmQuote(db, first.actor, input),
      confirmQuote(db, first.actor, { ...input, commandKey: key() }),
    ]);
    expect(new Set([one.id, two.id, three.id]).size).toBe(1);
    expect(await listOrders(db, first.actor, first.venueId)).toHaveLength(1);
    const otherQuote = await quote([1]);
    await expect(confirmQuote(db, first.actor, { quoteId: otherQuote.id, commandKey })).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED",
    });
    await expect(
      confirmQuote(db, first.actor, {
        quoteId: preview.id,
        commandKey: key(),
        staffHold: { until: "2099-09-19T00:00:00Z", reason: "电话保留" },
      }),
    ).rejects.toMatchObject({ code: "QUOTE_ALREADY_USED" });
    expect(await getCommandReceipt(db, first.actor, commandKey)).toMatchObject({
      commandType: "quote.confirm",
      result: { orderId: one.id },
    });
  });
  it("rejects expired unconsumed quotes but recovers a consumed quote and its current order status", async () => {
    const dead = await quote([1]);
    await db.query("UPDATE tennis.quotes SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [dead.id]);
    await expect(confirmQuote(db, first.actor, { quoteId: dead.id, commandKey: key() })).rejects.toMatchObject({
      code: "QUOTE_EXPIRED",
    });
    const live = await quote();
    const commandKey = key();
    const original = await confirmQuote(db, first.actor, { quoteId: live.id, commandKey });
    await db.query("UPDATE tennis.quotes SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [live.id]);
    await db.query("UPDATE tennis.orders SET hold_until=clock_timestamp()-interval '1 second' WHERE id=$1", [
      original.id,
    ]);
    const retry = await confirmQuote(db, first.actor, { quoteId: live.id, commandKey });
    expect(retry).toMatchObject({ id: original.id, status: "EXPIRED", paymentStatus: "UNPAID", holdUntil: null });
    expect((await confirmQuote(db, first.actor, { quoteId: live.id, commandKey: key() })).id).toBe(original.id);
    expect((await confirm()).id).not.toBe(original.id);
  });
  it("keeps a valid quote price after repricing and uses the new price on later quotes", async () => {
    const preview = await quote();
    const court = courts[0]!;
    await setCourtPrice(db, first.actor, {
      courtId: court.id,
      venueId: first.venueId,
      expectedRevision: court.revision,
      hourlyPriceCents: 20000,
    });
    expect((await confirmQuote(db, first.actor, { quoteId: preview.id, commandKey: key() })).totalCents).toBe(10000);
    expect((await quote([0], "20:00", "21:00")).price.totalCents).toBe(20000);
  });
  it("checks closures, maintenance and revoked permission again when confirming", async () => {
    const closed = await quote();
    await updateCourt(db, first.actor, { ...courts[0]!, expectedRevision: courts[0]!.revision, active: false });
    await expect(confirmQuote(db, first.actor, { quoteId: closed.id, commandKey: key() })).rejects.toMatchObject({
      code: "RESOURCE_UNAVAILABLE",
    });
    const maintained = await quote([1]);
    await occupyCourt(db, first.actor, {
      id: key(),
      sourceId: key(),
      kind: "MAINTENANCE",
      courtId: courts[1]!.id,
      ...interval(),
    });
    await expect(confirmQuote(db, first.actor, { quoteId: maintained.id, commandKey: key() })).rejects.toMatchObject({
      code: "INVENTORY_CONFLICT",
    });
    const revoked = await quote([2]);
    await db.query("UPDATE tennis.tenant_memberships SET role='VIEWER',permissions=ARRAY['read'] WHERE tenant_id=$1", [
      first.actor.tenantId,
    ]);
    await expect(confirmQuote(db, first.actor, { quoteId: revoked.id, commandKey: key() })).rejects.toMatchObject({
      code: "TENANT_ACCESS_DENIED",
    });
  });
  it("enforces staff hold authority, reason and future deadline without claiming payment", async () => {
    const preview = await quote();
    await expect(
      confirmQuote(db, first.actor, {
        quoteId: preview.id,
        commandKey: key(),
        staffHold: { until: "invalid", reason: "" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_HOLD" });
    await expect(
      confirmQuote(db, first.actor, {
        quoteId: preview.id,
        commandKey: key(),
        staffHold: { until: "2000-01-01T00:00:00Z", reason: "过期" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_HOLD" });
    const request = {
      quoteId: preview.id,
      commandKey: key(),
      staffHold: { until: "2099-09-18T11:00:00Z", reason: "老客电话保留，等待转账" },
    };
    await db.query(
      "UPDATE tennis.tenant_memberships SET role='STAFF',all_venues=true,permissions=ARRAY['read','book'] WHERE tenant_id=$1",
      [first.actor.tenantId],
    );
    await expect(confirmQuote(db, first.actor, request)).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
    await db.query(
      "UPDATE tennis.tenant_memberships SET permissions=ARRAY['read','book','hold_unpaid'] WHERE tenant_id=$1",
      [first.actor.tenantId],
    );
    expect(await confirmQuote(db, first.actor, request)).toMatchObject({
      status: "HELD",
      paymentStatus: "UNPAID",
      holdKind: "STAFF",
      holdReason: request.staffHold.reason,
      holdUntil: "2099-09-18T11:00:00.000Z",
    });
  });
  it("limits customers to their identity and rejects staff quote adoption and foreign tenant resources", async () => {
    const other = await createCustomer(db, first.actor, { nickname: "另一客户" });
    await expect(
      createQuote(db, customer, { venueId: first.venueId, customerId: other.id, lines: lines() }),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    const staffPreview = await quote();
    await expect(confirmQuote(db, customer, { quoteId: staffPreview.id, commandKey: key() })).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
    });
    const own = await createQuote(db, customer, {
      venueId: first.venueId,
      customerId: customer.customerId,
      lines: lines(),
    });
    await expect(
      confirmQuote(db, customer, {
        quoteId: own.id,
        commandKey: key(),
        staffHold: { until: "2099-09-18T11:00:00Z", reason: "伪造员工" },
      }),
    ).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
    const commandKey = key();
    const order = await confirmQuote(db, customer, { quoteId: own.id, commandKey });
    expect((await listOrders(db, customer, first.venueId)).map((item) => item.id)).toEqual([order.id]);
    await expect(getOrder(db, second.actor, order.id)).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    expect(await getCommandReceipt(db, first.actor, commandKey)).toBeNull();
    const otherPreview = await createQuote(db, first.actor, {
      venueId: first.venueId,
      customerId: other.id,
      lines: lines([1]),
    });
    const otherOrder = await confirmQuote(db, first.actor, { quoteId: otherPreview.id, commandKey: key() });
    await expect(getOrder(db, customer, otherOrder.id)).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    await expect(getOrder(db, { ...customer, customerId: other.id }, otherOrder.id)).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
    });
    await db.query(
      "UPDATE tennis.tenant_memberships SET role='STAFF',all_venues=false,permissions=ARRAY['read','book'] WHERE tenant_id=$1",
      [first.actor.tenantId],
    );
    await expect(getOrder(db, first.actor, order.id)).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
  });
  it("expires holds once even when the tenant is suspended, releasing all lines", async () => {
    const order = await confirm([0, 1, 2]);
    await db.query("UPDATE tennis.orders SET hold_until=clock_timestamp()-interval '1 second' WHERE id=$1", [order.id]);
    await db.query("UPDATE tennis.tenants SET active=false WHERE id=$1", [first.actor.tenantId]);
    const attempts = await Promise.all([expireDueOrders(db), expireDueOrders(db)]);
    expect(attempts.flat().filter((id) => id === order.id)).toHaveLength(1);
    expect(
      (
        await db.query("SELECT id FROM tennis.occupancies WHERE tenant_id=$1 AND released_at IS NULL", [
          first.actor.tenantId,
        ])
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await db.query("SELECT id FROM tennis.audit_events WHERE tenant_id=$1 AND action='order.expire'", [
          first.actor.tenantId,
        ])
      ).rowCount,
    ).toBe(1);
  });
  it("does not expose staff command results after the same subject switches to a customer role", async () => {
    const ownProfile = await createCustomer(db, first.actor, { nickname: "员工自己的客户档案" });
    await db.query("UPDATE tennis.customers SET subject_id=$1 WHERE tenant_id=$2 AND id=$3", [
      first.actor.subjectId,
      first.actor.tenantId,
      ownProfile.id,
    ]);
    const preview = await quote();
    const commandKey = key();
    const order = await confirmQuote(db, first.actor, { quoteId: preview.id, commandKey });
    const customerContext: CustomerActor = { ...first.actor, kind: "customer", customerId: ownProfile.id };
    expect(await getCommandReceipt(db, customerContext, commandKey)).toBeNull();
    expect(await getCommandReceipt(db, first.actor, commandKey)).toMatchObject({ result: { orderId: order.id } });
  });
  it("cancels unpaid orders atomically and idempotently, with current status returned on original confirmation retries", async () => {
    const preview = await quote([0, 1]);
    const confirmKey = key();
    const order = await confirmQuote(db, first.actor, { quoteId: preview.id, commandKey: confirmKey });
    const command = { orderId: order.id, commandKey: key(), expectedRevision: order.revision, reason: "客户不再预订" };
    const [one, two] = await Promise.all([
      cancelUnpaidOrder(db, first.actor, command),
      cancelUnpaidOrder(db, first.actor, command),
    ]);
    expect(one).toEqual(two);
    expect(one).toMatchObject({ status: "CANCELLED", paymentStatus: "UNPAID", holdUntil: null });
    expect(one.lines.every((line) => line.cancelledAt)).toBe(true);
    expect((await confirmQuote(db, first.actor, { quoteId: preview.id, commandKey: confirmKey })).status).toBe(
      "CANCELLED",
    );
    expect((await confirm([0, 1])).status).toBe("HELD");
  });
  it("rejects stale cancellation and cannot use unpaid cancellation to skip a paid refund", async () => {
    const order = await confirm();
    await expect(
      cancelUnpaidOrder(db, first.actor, {
        orderId: order.id,
        commandKey: key(),
        expectedRevision: 99,
        reason: "旧页面",
      }),
    ).rejects.toMatchObject({ code: "STALE_ORDER" });
    await db.query("UPDATE tennis.orders SET status='CONFIRMED',payment_status='PAID',hold_until=NULL WHERE id=$1", [
      order.id,
    ]);
    await expect(
      cancelUnpaidOrder(db, first.actor, { orderId: order.id, commandKey: key(), expectedRevision: 1, reason: "退款" }),
    ).rejects.toMatchObject({ code: "ORDER_REQUIRES_REFUND" });
    expect((await getOrder(db, first.actor, order.id)).status).toBe("CONFIRMED");
  });
  it("prevents legacy single-occupancy APIs from bypassing an order's lifecycle", async () => {
    const order = await confirm();
    const occupancy = (
      await db.query<{ id: string }>("SELECT id FROM tennis.occupancies WHERE tenant_id=$1 AND source_id=$2", [
        first.actor.tenantId,
        order.id,
      ])
    ).rows[0]!;
    await expect(releaseCourtOccupancy(db, first.actor, occupancy.id, 1)).rejects.toMatchObject({
      code: "ORDER_MANAGED_OCCUPANCY",
    });
    await expect(
      rescheduleCourtOccupancy(db, first.actor, occupancy.id, 1, courts[1]!.id, interval()),
    ).rejects.toMatchObject({ code: "ORDER_MANAGED_OCCUPANCY" });
    expect((await getOrder(db, first.actor, order.id)).lines[0]!.courtId).toBe(courts[0]!.id);
  });
  it("confirms zero-price orders as no payment required, with no invented receipt", async () => {
    const court = courts[0]!;
    await setCourtPrice(db, first.actor, {
      courtId: court.id,
      venueId: first.venueId,
      expectedRevision: court.revision,
      hourlyPriceCents: 0,
    });
    expect(await confirm()).toMatchObject({
      status: "CONFIRMED",
      paymentStatus: "NOT_REQUIRED",
      totalCents: 0,
      holdUntil: null,
    });
  });
  it("keeps normalized customer phone numbers tenant-local and protects profile searches", async () => {
    expect((await searchCustomers(db, first.actor, "1380013"))[0]?.phone).toBe("+8613800138000");
    await expect(createCustomer(db, first.actor, { nickname: "重复", phone: "+86 13800138000" })).rejects.toMatchObject(
      { code: "PHONE_ALREADY_EXISTS" },
    );
    await createCustomer(db, second.actor, { nickname: "另一商户", phone: "13800138000" });
    expect(await searchCustomers(db, first.actor)).toHaveLength(1);
    await db.query(
      "UPDATE tennis.tenant_memberships SET role='STAFF',all_venues=true,permissions=ARRAY['read','book'] WHERE tenant_id=$1",
      [first.actor.tenantId],
    );
    await expect(searchCustomers(db, first.actor)).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
  });
});
