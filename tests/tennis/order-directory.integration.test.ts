import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createCourt, createVenue } from "../../packages/db/src/tennis/catalog.ts";
import { createCustomer, type CustomerActor } from "../../packages/db/src/tennis/customers.ts";
import type { OrderRecord } from "../../packages/db/src/tennis/booking.ts";
import { orderList } from "../../packages/db/src/tennis/views.ts";
import { assertLocalTennisDatabaseUrl, localTennisTestDatabaseUrl } from "../../packages/db/src/tennis/local-config.ts";
import { migrateTennis } from "../../packages/db/src/tennis/migrate.ts";
import { seedTenantFixture, removeTenantFixture, type TenantFixture } from "./tenant-fixture.ts";

const db = new pg.Pool({
  connectionString: assertLocalTennisDatabaseUrl(
    process.env.TENNIS_TEST_DATABASE_URL ?? localTennisTestDatabaseUrl,
    "test",
  ),
  max: 4,
  connectionTimeoutMillis: 5000,
  statement_timeout: 10000,
});
let first: TenantFixture, second: TenantFixture;
let customer: CustomerActor, otherCustomerId: string, courtId: string;
interface SeedOrder {
  id?: string;
  customerId?: string;
  venueId?: string;
  courtId?: string;
  status?: OrderRecord["status"];
  createdAt?: string;
  holdUntil?: string;
  lines?: { startAt: string; endAt: string; cancelled?: boolean }[];
}
/** Scoped synthetic read-model history; no real customer data, payments or global cleanup. */
async function seedOrders(inputs: SeedOrder[], fixture = first) {
  const tx = await db.connect();
  const ids: string[] = [];
  try {
    await tx.query("BEGIN");
    for (const input of inputs) {
      const id = input.id ?? randomUUID(),
        quoteId = randomUUID();
      const profile = input.customerId ?? customer.customerId;
      const venue = input.venueId ?? fixture.venueId;
      const status = input.status ?? "CONFIRMED";
      const lines = input.lines ?? [{ startAt: "2035-01-01T11:00:00Z", endAt: "2035-01-01T12:00:00Z" }];
      await tx.query(
        `INSERT INTO tennis.quotes(id,tenant_id,venue_id,customer_id,created_by,price_snapshot,expires_at)
         VALUES($1,$2,$3,$4,$5,'{}','2099-01-01T00:00:00Z')`,
        [quoteId, fixture.actor.tenantId, venue, profile, fixture.actor.subjectId],
      );
      await tx.query(
        `INSERT INTO tennis.orders(id,tenant_id,venue_id,customer_id,quote_id,created_by,status,payment_status,
          total_cents,hold_kind,hold_until,confirmation_request,price_snapshot,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,'UNPAID',0,'PAYMENT',$8,'{}','{}',$9)`,
        [
          id,
          fixture.actor.tenantId,
          venue,
          profile,
          quoteId,
          fixture.actor.subjectId,
          status,
          status === "HELD" ? (input.holdUntil ?? "2099-01-01T00:00:00Z") : null,
          input.createdAt ?? "2030-01-01T00:00:00.000123Z",
        ],
      );
      for (const [position, line] of lines.entries()) {
        await tx.query(
          `INSERT INTO tennis.order_lines(id,tenant_id,venue_id,order_id,court_id,position,start_at,end_at,amount_cents,initial_funding_cents,price_snapshot,cancelled_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,0,0,'{}',$9)`,
          [
            randomUUID(),
            fixture.actor.tenantId,
            venue,
            id,
            input.courtId ?? courtId,
            position,
            line.startAt,
            line.endAt,
            line.cancelled ? "2030-01-01T00:00:00Z" : null,
          ],
        );
      }
      ids.push(id);
    }
    await tx.query("COMMIT");
    return ids;
  } catch (error) {
    await tx.query("ROLLBACK");
    throw error;
  } finally {
    tx.release();
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
  courtId = (await createCourt(db, first.actor, { venueId: first.venueId, name: "目录测试一号场", indoor: true })).id;
  const profile = await createCustomer(db, first.actor, { nickname: "Rare_100% Customer" });
  await db.query("UPDATE tennis.customers SET subject_id=$1 WHERE tenant_id=$2 AND id=$3", [
    first.actor.subjectId,
    first.actor.tenantId,
    profile.id,
  ]);
  customer = { ...first.actor, kind: "customer", customerId: profile.id };
  otherCustomerId = (await createCustomer(db, first.actor, { nickname: "Ordinary Customer" })).id;
});
afterEach(async () => {
  for (const fixture of [first, second].filter(Boolean)) await removeTenantFixture(db, fixture);
});
afterAll(() => db.end());

describe("complete, scoped order directory", () => {
  it("finds old orders by status, literal customer substring and ID before limiting the page", async () => {
    const [old] = await seedOrders([{ createdAt: "2029-01-01T00:00:00Z" }]);
    await seedOrders(Array.from({ length: 121 }, () => ({ customerId: otherCustomerId, status: "EXPIRED" })));
    expect((await orderList(db, first.actor, first.venueId)).orders).toHaveLength(25);
    for (const query of [
      { q: old! },
      { q: "rARE_100%" },
      { status: "CONFIRMED" },
      { status: "ACTIVE", date: "2035-01-01" },
    ]) {
      const result = await orderList(db, first.actor, first.venueId, { ...query, pageSize: 1 });
      expect(result.orders.map((order) => order.id)).toEqual([old]);
      expect(result.nextCursor).toBeNull();
    }
    expect((await orderList(db, first.actor, first.venueId, { q: "%" })).orders.map((order) => order.id)).toEqual([
      old,
    ]);
  });
  it("pages every order exactly once, retaining database microseconds and deterministic timestamp ties", async () => {
    await seedOrders(
      Array.from({ length: 107 }, (_, index) => ({
        createdAt: index < 103 ? "2030-01-01T00:00:00.000123Z" : `2030-01-01T00:00:00.00012${index - 99}Z`,
      })),
    );
    const expected = (
      await db.query<{ id: string }>(
        "SELECT id FROM tennis.orders WHERE tenant_id=$1 AND venue_id=$2 ORDER BY created_at DESC,id DESC",
        [first.actor.tenantId, first.venueId],
      )
    ).rows.map((row) => row.id);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await orderList(db, first.actor, first.venueId, { pageSize: "13", ...(cursor ? { cursor } : {}) });
      expect(page.orders.length).toBeLessThanOrEqual(13);
      seen.push(...page.orders.map((order) => order.id));
      cursor = page.nextCursor ?? undefined;
      expect(seen.length).toBeLessThanOrEqual(107);
    } while (cursor);
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(107);
  });
  it("selects only uncancelled lines overlapping the venue-local day, including midnight crossings", async () => {
    const [mixed, cancelledOnly, endBoundary, nextBoundary, midnightCrossing, cancelledOrder] = await seedOrders([
      {
        lines: [
          { startAt: "2035-01-02T11:00:00Z", endAt: "2035-01-02T12:00:00Z" },
          { startAt: "2035-01-01T10:00:00Z", endAt: "2035-01-01T11:00:00Z", cancelled: true },
          { startAt: "2035-01-01T11:00:00Z", endAt: "2035-01-01T12:00:00Z" },
        ],
      },
      { lines: [{ startAt: "2035-01-01T11:00:00Z", endAt: "2035-01-01T12:00:00Z", cancelled: true }] },
      { lines: [{ startAt: "2034-12-31T15:00:00Z", endAt: "2034-12-31T16:00:00Z" }] },
      { lines: [{ startAt: "2035-01-01T16:00:00Z", endAt: "2035-01-01T17:00:00Z" }] },
      { lines: [{ startAt: "2034-12-31T15:30:00Z", endAt: "2034-12-31T16:30:00Z" }] },
      { status: "CANCELLED" },
    ]);
    const result = await orderList(db, first.actor, first.venueId, { date: "2035-01-01", status: "ACTIVE" });
    expect(new Set(result.orders.map((order) => order.id))).toEqual(new Set([mixed, midnightCrossing]));
    expect(result.orders.find((order) => order.id === mixed)).toMatchObject({
      lines: expect.arrayContaining([expect.objectContaining({ cancelledAt: expect.any(String) })]),
      matchingLines: [expect.objectContaining({ startAt: "2035-01-01T11:00:00.000Z", courtName: "目录测试一号场" })],
    });
    expect(
      result.orders.every((order) => ![cancelledOnly, endBoundary, nextBoundary, cancelledOrder].includes(order.id)),
    ).toBe(true);
    // Same facts, different venue timezone: the previous UTC evening is not January 1 in Los Angeles.
    await db.query("UPDATE tennis.venues SET timezone='America/Los_Angeles' WHERE tenant_id=$1 AND id=$2", [
      first.actor.tenantId,
      first.venueId,
    ]);
    const west = await orderList(db, first.actor, first.venueId, { date: "2035-01-01", status: "ACTIVE" });
    expect(new Set(west.orders.map((order) => order.id))).toEqual(new Set([mixed, nextBoundary]));
  });
  it("isolates customers, venues and tenants in both results and cursor lookup", async () => {
    const [own, other] = await seedOrders([{}, { customerId: otherCustomerId }]);
    const otherVenue = await createVenue(db, first.actor, { name: "隔离场馆", timezone: "Asia/Shanghai" });
    const otherCourt = await createCourt(db, first.actor, { venueId: otherVenue.id, name: "隔离球场", indoor: true });
    const [differentVenue] = await seedOrders([{ venueId: otherVenue.id, courtId: otherCourt.id }]);
    const foreignCustomer = await createCustomer(db, second.actor, { nickname: "外租户客户" });
    const foreignCourt = await createCourt(db, second.actor, {
      venueId: second.venueId,
      name: "外租户球场",
      indoor: true,
    });
    const [foreign] = await seedOrders([{ customerId: foreignCustomer.id, courtId: foreignCourt.id }], second);
    expect((await orderList(db, customer, first.venueId)).orders.map((order) => order.id)).toEqual([own]);
    expect((await orderList(db, customer, first.venueId, { q: other! })).orders).toEqual([]);
    for (const cursor of [other, differentVenue, foreign, "missing"]) {
      await expect(orderList(db, customer, first.venueId, { cursor })).rejects.toMatchObject({
        code: "INVALID_ORDER_CURSOR",
        statusCode: 400,
      });
    }
    await expect(orderList(db, second.actor, first.venueId)).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    await db.query(
      "UPDATE tennis.tenant_memberships SET role='STAFF',all_venues=false,permissions=ARRAY['read'] WHERE tenant_id=$1 AND subject_id=$2",
      [first.actor.tenantId, first.actor.subjectId],
    );
    await db.query("INSERT INTO tennis.membership_venues(tenant_id,subject_id,venue_id) VALUES($1,$2,$3)", [
      first.actor.tenantId,
      first.actor.subjectId,
      first.venueId,
    ]);
    await expect(orderList(db, first.actor, otherVenue.id)).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
  });
  it("expires overdue holds before applying active status and rejects a skipped local date", async () => {
    const [expired, active] = await seedOrders([
      { status: "HELD", holdUntil: "2020-01-01T00:00:00Z" },
      { status: "HELD" },
    ]);
    expect(
      (await orderList(db, first.actor, first.venueId, { status: "ACTIVE" })).orders.map((order) => order.id),
    ).toEqual([active]);
    expect(
      (await orderList(db, first.actor, first.venueId, { status: "EXPIRED" })).orders.map((order) => order.id),
    ).toEqual([expired]);
    await db.query("UPDATE tennis.venues SET timezone='Pacific/Apia' WHERE tenant_id=$1 AND id=$2", [
      first.actor.tenantId,
      first.venueId,
    ]);
    await expect(orderList(db, first.actor, first.venueId, { date: "2011-12-30" })).rejects.toMatchObject({
      statusCode: 400,
    });
  });
});
