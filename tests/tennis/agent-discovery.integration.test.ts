import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertLocalTennisDatabaseUrl, localTennisTestDatabaseUrl } from "../../packages/db/src/tennis/local-config.ts";
import { migrateTennis } from "../../packages/db/src/tennis/migrate.ts";
import {
  createCourt,
  createVenue,
  listVenues,
  priceSelection,
  saveDiscount,
  setCourtPrice,
  updateVenue,
} from "../../packages/db/src/tennis/catalog.ts";
import { createCustomer, type CustomerActor } from "../../packages/db/src/tennis/customers.ts";
import { confirmQuote, createQuote } from "../../packages/db/src/tennis/booking.ts";
import { beginOrderPayment } from "../../packages/db/src/tennis/payments.ts";
import { recordOfflineTopup } from "../../packages/db/src/tennis/wallet.ts";
import { confirmOrderAmendment, previewOrderAmendment } from "../../packages/db/src/tennis/amendments.ts";
import { occupyCourt } from "../../packages/db/src/tennis/inventory.ts";
import {
  createConversation,
  handoffConversation,
  issueDelegation,
  resolveDelegation,
} from "../../packages/db/src/tennis/external-agent.ts";
import { discoverAgentVenues } from "../../packages/db/src/tennis/agent-discovery.ts";
import { LocalMockPaymentGateway } from "../../packages/db/src/tennis/mock-payments.ts";
import { buildTennisServer } from "../../apps/api/src/tennis/server.ts";
import { removeTenantFixture, seedTenantFixture, type TenantFixture } from "./tenant-fixture.ts";

const db = new pg.Pool({
  connectionString: assertLocalTennisDatabaseUrl(localTennisTestDatabaseUrl, "test"),
  max: 8,
  connectionTimeoutMillis: 5000,
  statement_timeout: 10000,
});
const gateway = new LocalMockPaymentGateway(randomBytes(32).toString("hex"), "local-simulation");
const key = () => randomUUID();
const at = (time: string) => `2099-09-18T${time}:00+08:00`;
const request = (courtCount = 2) => ({ startAt: at("19:00"), endAt: at("20:00"), courtCount });
let first: TenantFixture, second: TenantFixture, customer: CustomerActor, alternateVenueId: string;
let originalCourts: string[], alternateCourts: string[];
async function prepareVenue(venueId: string) {
  const venue = (await listVenues(db, first.actor)).find((item) => item.id === venueId)!;
  await updateVenue(db, first.actor, {
    ...venue,
    expectedRevision: venue.catalogRevision,
    minimumBookingMinutes: 15,
    openingHours: Array.from({ length: 7 }, (_, weekday) => ({ weekday, startMinute: 480, endMinute: 1320 })),
  });
}
async function makeCourt(venueId: string, price: number, name: string) {
  const court = await createCourt(db, first.actor, { venueId, name, indoor: true });
  await setCourtPrice(db, first.actor, {
    venueId,
    courtId: court.id,
    expectedRevision: court.revision,
    hourlyPriceCents: price,
  });
  return court.id;
}
async function token(staff = false) {
  const actor = staff ? first.actor : customer;
  const conversation = await createConversation(db, actor, first.venueId);
  return issueDelegation(db, actor, conversation.id);
}
async function block(
  courtId: string,
  startAt = at("19:00"),
  endAt = at("20:00"),
  kind: "COURSE" | "MAINTENANCE" = "COURSE",
) {
  await occupyCourt(db, first.actor, { id: key(), courtId, kind, sourceId: `private-${key()}`, startAt, endAt });
}
async function hold(venueId: string, courtId: string, startAt = at("19:00"), endAt = at("20:00")) {
  const quote = await createQuote(db, customer, {
    venueId,
    customerId: customer.customerId,
    lines: [{ courtId, startAt, endAt }],
  });
  return confirmQuote(db, customer, { quoteId: quote.id, commandKey: key() });
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
  await prepareVenue(first.venueId);
  alternateVenueId = (
    await createVenue(db, first.actor, { name: "替代校区", timezone: "Asia/Shanghai", address: "合成地址" })
  ).id;
  await prepareVenue(alternateVenueId);
  originalCourts = [
    await makeCourt(first.venueId, 10000, "原校区一号"),
    await makeCourt(first.venueId, 8000, "原校区二号"),
  ];
  alternateCourts = [
    await makeCourt(alternateVenueId, 6000, "替代一号"),
    await makeCourt(alternateVenueId, 9000, "替代二号"),
  ];
  const profile = await createCustomer(db, first.actor, { nickname: "不可泄露的预订人", phone: "+8613900000000" });
  const subjectId = key();
  await db.query("INSERT INTO tennis.subjects(id,display_name) VALUES($1,'synthetic discovery customer')", [subjectId]);
  await db.query("UPDATE tennis.customers SET subject_id=$1 WHERE tenant_id=$2 AND id=$3", [
    subjectId,
    first.actor.tenantId,
    profile.id,
  ]);
  customer = { tenantId: first.actor.tenantId, subjectId, kind: "customer", customerId: profile.id };
});
afterEach(async () => {
  await db.query("DELETE FROM tennis.agent_conversations WHERE tenant_id=ANY($1::text[])", [
    [first.actor.tenantId, second.actor.tenantId],
  ]);
  await removeTenantFixture(db, first);
  await removeTenantFixture(db, second);
  await db.query("DELETE FROM tennis.subjects WHERE id=$1", [customer.subjectId]);
});
afterAll(() => db.end());

describe("delegated same-tenant venue discovery", () => {
  it("finds a complete same-time multi-court alternative using the catalog discount price and no booking identity", async () => {
    await block(originalCourts[0]!);
    await saveDiscount(db, first.actor, {
      active: true,
      rule: {
        name: "查询用分时折扣",
        venueId: alternateVenueId,
        courtIds: [alternateCourts[0]!],
        dateFrom: "2099-09-18",
        dateTo: "2099-09-18",
        weekdays: [0, 1, 2, 3, 4, 5, 6],
        startMinute: 1140,
        endMinute: 1170,
        discountBps: 5000,
      },
    });
    const delegated = await token();
    const result = await discoverAgentVenues(db, delegated.token, request());
    expect(result).toMatchObject({
      inventoryHeld: false,
      quoteRequired: true,
      switchVenueRequiresNewConversation: true,
    });
    expect(result.venues.map((venue) => venue.venueId)).toEqual([alternateVenueId]);
    const expected = await priceSelection(
      db,
      first.actor,
      alternateVenueId,
      alternateCourts.map((courtId) => ({ courtId, startAt: request().startAt, endAt: request().endAt })),
    );
    expect(result.venues[0]!.suggestedSelection).toMatchObject({ totalCents: expected.totalCents, currency: "CNY" });
    expect(result.venues[0]!.courts.map((court) => court.price.totalCents).sort()).toEqual(
      expected.lines.map((line) => line.totalCents).sort(),
    );
    const serialized = JSON.stringify(result);
    for (const secret of [
      customer.customerId,
      customer.subjectId,
      "不可泄露的预订人",
      "+8613900000000",
      "sourceId",
      "orderId",
      "occupancy",
      second.actor.tenantId,
    ])
      expect(serialized).not.toContain(secret);
  });
  it("does not combine spare courts from different venues or disconnected portions of a court", async () => {
    await block(originalCourts[0]!, at("19:00"), at("19:30"));
    await block(alternateCourts[0]!, at("19:30"), at("20:00"));
    const delegated = await token();
    expect((await discoverAgentVenues(db, delegated.token, request(2))).venues).toEqual([]);
    const single = await discoverAgentVenues(db, delegated.token, request(1));
    expect(single.venues).toHaveLength(2);
    expect(single.venues.every((venue) => venue.availableCourtCount === 1)).toBe(true);
  });
  it("subtracts booking, course and maintenance while allowing adjacent intervals", async () => {
    await hold(first.venueId, originalCourts[0]!);
    await block(originalCourts[1]!, at("19:00"), at("20:00"), "MAINTENANCE");
    await block(alternateCourts[0]!, at("18:00"), at("19:00"));
    await block(alternateCourts[1]!, at("20:00"), at("21:00"));
    const delegated = await token();
    expect((await discoverAgentVenues(db, delegated.token, request())).venues.map((venue) => venue.venueId)).toEqual([
      alternateVenueId,
    ]);
  });
  it("uses live active assets, minimum sale duration and whole-window opening rules", async () => {
    const delegated = await token();
    const alternate = (await listVenues(db, first.actor)).find((venue) => venue.id === alternateVenueId)!;
    await updateVenue(db, first.actor, {
      ...alternate,
      expectedRevision: alternate.catalogRevision,
      minimumBookingMinutes: 90,
    });
    expect((await discoverAgentVenues(db, delegated.token, request())).venues.map((venue) => venue.venueId)).toEqual([
      first.venueId,
    ]);
    const source = (await listVenues(db, first.actor)).find((venue) => venue.id === first.venueId)!;
    await updateVenue(db, first.actor, {
      ...source,
      expectedRevision: source.catalogRevision,
      minimumBookingMinutes: 15,
      openingHours: Array.from({ length: 7 }, (_, weekday) => ({ weekday, startMinute: 480, endMinute: 1170 })),
    });
    expect((await discoverAgentVenues(db, delegated.token, request())).venues).toEqual([]);
  });
  it("does not show inactive or unpriced courts, disabled venues, or another tenant", async () => {
    const delegated = await token();
    await db.query("UPDATE tennis.courts SET active=false WHERE id=$1", [originalCourts[0]]);
    await db.query("UPDATE tennis.courts SET hourly_price_cents=NULL WHERE id=$1", [originalCourts[1]]);
    expect((await discoverAgentVenues(db, delegated.token, request(1))).venues.map((venue) => venue.venueId)).toEqual([
      alternateVenueId,
    ]);
    await db.query("UPDATE tennis.venues SET active=false WHERE id=$1", [alternateVenueId]);
    expect((await discoverAgentVenues(db, delegated.token, request(1))).venues).toEqual([]);
  });
  it("restricts employees to their actual read-and-book venue scope and rechecks revoked permissions", async () => {
    await db.query(
      "UPDATE tennis.tenant_memberships SET role='STAFF',permissions=ARRAY['read','book']::text[],all_venues=false WHERE tenant_id=$1",
      [first.actor.tenantId],
    );
    await db.query("INSERT INTO tennis.membership_venues(tenant_id,subject_id,venue_id) VALUES($1,$2,$3)", [
      first.actor.tenantId,
      first.actor.subjectId,
      first.venueId,
    ]);
    const delegated = await token(true);
    expect((await discoverAgentVenues(db, delegated.token, request())).venues.map((venue) => venue.venueId)).toEqual([
      first.venueId,
    ]);
    await db.query("INSERT INTO tennis.membership_venues(tenant_id,subject_id,venue_id) VALUES($1,$2,$3)", [
      first.actor.tenantId,
      first.actor.subjectId,
      alternateVenueId,
    ]);
    expect((await discoverAgentVenues(db, delegated.token, request())).venues).toHaveLength(2);
    await db.query("UPDATE tennis.tenant_memberships SET permissions=ARRAY['read']::text[] WHERE tenant_id=$1", [
      first.actor.tenantId,
    ]);
    await expect(discoverAgentVenues(db, delegated.token, request())).rejects.toMatchObject({
      code: "TENANT_ACCESS_DENIED",
    });
  });
  it("keeps the original token bound to its venue and requires a new conversation for a different booking", async () => {
    const delegated = await token();
    await discoverAgentVenues(db, delegated.token, request());
    const original = await resolveDelegation(db, delegated.token);
    const selection = {
      venueId: alternateVenueId,
      customerId: customer.customerId,
      lines: [{ courtId: alternateCourts[0]!, startAt: request().startAt, endAt: request().endAt }],
    };
    await expect(createQuote(db, original.actor, selection)).rejects.toMatchObject({ code: "AGENT_SCOPE_DENIED" });
    const nextConversation = await createConversation(db, customer, alternateVenueId);
    const fresh = await issueDelegation(db, customer, nextConversation.id);
    const next = await resolveDelegation(db, fresh.token);
    expect((await createQuote(db, next.actor, selection)).venueId).toBe(alternateVenueId);
  });
  it("rejects expired/revoked delegates, human takeover and a disabled customer", async () => {
    const delegated = await token();
    await handoffConversation(db, first.actor, delegated.conversation.id, { mode: "HUMAN", reason: "运营接管" });
    await expect(discoverAgentVenues(db, delegated.token, request())).rejects.toMatchObject({
      code: "AGENT_DELEGATION_REVOKED",
    });
    const fresh = await token();
    await db.query(
      "UPDATE tennis.agent_delegations SET expires_at=clock_timestamp()-interval '1 second' WHERE conversation_id=$1",
      [fresh.conversation.id],
    );
    await expect(discoverAgentVenues(db, fresh.token, request())).rejects.toMatchObject({
      code: "AGENT_DELEGATION_REVOKED",
    });
    const active = await token();
    await db.query("UPDATE tennis.customers SET active=false WHERE id=$1", [customer.customerId]);
    await expect(discoverAgentVenues(db, active.token, request())).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
    });
  });
  it("treats expired initial holds as available without running cross-venue mutation or locking inventory", async () => {
    const order = await hold(alternateVenueId, alternateCourts[0]!);
    await db.query("UPDATE tennis.orders SET hold_until=clock_timestamp()-interval '1 second' WHERE id=$1", [order.id]);
    const delegated = await token();
    const result = await discoverAgentVenues(db, delegated.token, request());
    expect(result.venues.some((venue) => venue.venueId === alternateVenueId)).toBe(true);
    expect((await db.query("SELECT status FROM tennis.orders WHERE id=$1", [order.id])).rows[0]!.status).toBe("HELD");
    expect(
      (await db.query("SELECT released_at FROM tennis.occupancies WHERE order_line_id=$1", [order.lines[0]!.id]))
        .rows[0]!.released_at,
    ).toBeNull();
  });
  it("includes staged amendment holds until their deadline but preserves the old confirmed occupancy", async () => {
    const order = await hold(alternateVenueId, alternateCourts[0]!, at("18:00"), at("19:00"));
    await recordOfflineTopup(db, first.actor, {
      venueId: alternateVenueId,
      customerId: customer.customerId,
      principalCents: 6000,
      giftCents: 0,
      receiptReference: key(),
      reason: "合成充值",
      commandKey: key(),
    });
    await beginOrderPayment(db, customer, gateway, { orderId: order.id, walletCents: 6000, commandKey: key() });
    const paidRevision = (
      await db.query<{ revision: number }>("SELECT revision FROM tennis.orders WHERE id=$1", [order.id])
    ).rows[0]!.revision;
    const proposal = await previewOrderAmendment(db, first.actor, {
      orderId: order.id,
      expectedRevision: paidRevision,
      reason: "合成改期",
      changes: [
        {
          lineId: order.lines[0]!.id,
          courtId: alternateCourts[1]!,
          startAt: request().startAt,
          endAt: request().endAt,
        },
      ],
    });
    await confirmOrderAmendment(db, first.actor, { amendmentId: proposal.id, commandKey: key() });
    const delegated = await token();
    expect(
      (await discoverAgentVenues(db, delegated.token, request())).venues.some(
        (venue) => venue.venueId === alternateVenueId,
      ),
    ).toBe(false);
    await db.query("UPDATE tennis.order_amendments SET hold_until=clock_timestamp()-interval '1 second' WHERE id=$1", [
      proposal.id,
    ]);
    expect(
      (await discoverAgentVenues(db, delegated.token, request())).venues.some(
        (venue) => venue.venueId === alternateVenueId,
      ),
    ).toBe(true);
    const originalTime = await discoverAgentVenues(db, delegated.token, {
      startAt: at("18:00"),
      endAt: at("19:00"),
      courtCount: 2,
    });
    expect(originalTime.venues.some((venue) => venue.venueId === alternateVenueId)).toBe(false);
  });
  it("validates full timestamps, quarter-hour boundaries, future time and complete count", async () => {
    const delegated = await token();
    for (const invalid of [
      { ...request(), startAt: "2099-09-18T19:00:00" },
      { ...request(), endAt: at("20:05") },
      { ...request(), courtCount: 0 },
      { ...request(), courtCount: 1.5 },
      { ...request(), courtCount: 101 },
      { ...request(), endAt: request().startAt },
    ])
      await expect(discoverAgentVenues(db, delegated.token, invalid)).rejects.toMatchObject({
        code: "INVALID_DISCOVERY_QUERY",
      });
    await expect(
      discoverAgentVenues(db, delegated.token, {
        ...request(),
        startAt: "2000-01-01T19:00:00+08:00",
        endAt: "2000-01-01T20:00:00+08:00",
      }),
    ).rejects.toMatchObject({ code: "PAST_INTERVAL" });
  });
  it("offers a read-only bearer HTTP surface without accepting tenant or scope overrides", async () => {
    const app = await buildTennisServer({ db, gateway, aiEncryptionKey: randomBytes(32), allowSimulation: true });
    try {
      const delegated = await token();
      const qs = new URLSearchParams({ startAt: request().startAt, endAt: request().endAt, courtCount: "2" });
      const url = `/api/tennis/agent/available-venues?${qs}`;
      const denied = await app.inject({ method: "GET", url });
      expect(denied.statusCode).toBe(409);
      const headers = { authorization: `Bearer ${delegated.token}` };
      const response = await app.inject({ method: "GET", url, headers });
      expect(response.statusCode).toBe(200);
      expect(response.json().venues).toHaveLength(2);
      expect(
        (await app.inject({ method: "GET", url: `${url}&tenantId=${second.actor.tenantId}`, headers })).statusCode,
      ).toBe(400);
      expect((await app.inject({ method: "GET", url: `${url}&courtCount=1`, headers })).statusCode).toBe(400);
      expect((await db.query("SELECT id FROM tennis.orders WHERE tenant_id=$1", [first.actor.tenantId])).rowCount).toBe(
        0,
      );
      expect((await db.query("SELECT id FROM tennis.quotes WHERE tenant_id=$1", [first.actor.tenantId])).rowCount).toBe(
        0,
      );
      expect(
        (await db.query("SELECT id FROM tennis.occupancies WHERE tenant_id=$1", [first.actor.tenantId])).rowCount,
      ).toBe(0);
    } finally {
      await app.close();
    }
  });
});
