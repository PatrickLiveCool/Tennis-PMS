import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertLocalTennisDatabaseUrl, localTennisTestDatabaseUrl } from "../../packages/db/src/tennis/local-config.ts";
import { migrateTennis } from "../../packages/db/src/tennis/migrate.ts";
import { createCourt, findAvailableCourts, listCourts, listVenues, priceSelection, saveCourt, setCourtPrice, updateVenue } from "../../packages/db/src/tennis/catalog.ts";
import { createCustomer, type CustomerActor } from "../../packages/db/src/tennis/customers.ts";
import { confirmQuote, createQuote } from "../../packages/db/src/tennis/booking.ts";
import { accessibleCourts, venueSchedule } from "../../packages/db/src/tennis/views.ts";
import { removeTenantFixture, seedTenantFixture, syntheticPhone, type TenantFixture } from "./tenant-fixture.ts";

const db = new pg.Pool({ connectionString: assertLocalTennisDatabaseUrl(process.env.TENNIS_TEST_DATABASE_URL ?? localTennisTestDatabaseUrl, "test"), max: 4, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
const date = "2099-09-18";
const interval = { startAt: `${date}T19:00:00+08:00`, endAt: `${date}T20:00:00+08:00` };
let fixture: TenantFixture;
let customer: CustomerActor;
let customerSubject: string;

beforeAll(async () => {
  const tx = await db.connect();
  try { await migrateTennis(tx); } finally { tx.release(); }
});
beforeEach(async () => {
  fixture = await seedTenantFixture(db);
  const venue = (await listVenues(db, fixture.actor))[0]!;
  await updateVenue(db, fixture.actor, { ...venue, expectedRevision: venue.catalogRevision, openingHours: Array.from({ length: 7 }, (_, weekday) => ({ weekday, startMinute: 480, endMinute: 1320 })), minimumBookingMinutes: 15 });
  const profile = await createCustomer(db, fixture.actor, { nickname: "合成选购客户", phone: syntheticPhone() });
  customerSubject = randomUUID();
  await db.query("INSERT INTO tennis.subjects(id,display_name) VALUES($1,'synthetic court purchase customer')", [customerSubject]);
  await db.query("UPDATE tennis.customers SET subject_id=$1 WHERE tenant_id=$2 AND id=$3", [customerSubject, fixture.actor.tenantId, profile.id]);
  customer = { tenantId: fixture.actor.tenantId, subjectId: customerSubject, customerId: profile.id, kind: "customer" };
});
afterEach(async () => {
  if (fixture) await removeTenantFixture(db, fixture);
  if (customerSubject) await db.query("DELETE FROM tennis.subjects WHERE id=$1", [customerSubject]);
});
afterAll(async () => { await db.end(); });

function completeCourtInput() {
  return { venueId: fixture.venueId, name: "合成完整场地", environment: "INDOOR" as const, surface: "ACRYLIC" as const, profile: { specification: "STANDARD" as const }, hourlyPriceCents: 12000 };
}
async function catalogState() {
  const [courts, venues, audit] = await Promise.all([
    listCourts(db, fixture.actor, fixture.venueId),
    listVenues(db, fixture.actor),
    db.query<{ count: string }>("SELECT count(*)::text AS count FROM tennis.audit_events WHERE tenant_id=$1", [fixture.actor.tenantId]),
  ]);
  return { courts, catalogRevision: venues[0]!.catalogRevision, auditCount: audit.rows[0]!.count };
}

describe("court purchase readiness", () => {
  it("requires an explicit environment for creation while accepting the legacy false indoor value", async () => {
    await expect(createCourt(db, fixture.actor, { venueId: fixture.venueId, name: "不得默认室外" })).rejects.toMatchObject({ code: "INVALID_CONFIGURATION", details: { field: "environment" } });
    expect(await listCourts(db, fixture.actor, fixture.venueId)).toEqual([]);
    const { environment: _environment, ...input } = completeCourtInput();
    const court = await createCourt(db, fixture.actor, { ...input, name: "明确室外", indoor: false, active: false, hourlyPriceCents: 0 });
    expect(court).toMatchObject({ environment: "OUTDOOR", active: false, surface: "ACRYLIC", hourlyPriceCents: 0 });
  });
  it("rejects incomplete active or inactive creations without writing a court, revision or audit", async () => {
    const complete = completeCourtInput();
    const { hourlyPriceCents: _price, ...withoutPrice } = complete;
    const before = await catalogState();
    for (const input of [
      withoutPrice,
      { ...complete, hourlyPriceCents: null },
      { ...complete, surface: "UNSPECIFIED" as const },
      { ...complete, profile: { specification: "UNSPECIFIED" as const } },
      { ...withoutPrice, active: false },
      { ...complete, active: false, surface: "UNSPECIFIED" as const },
    ]) {
      await expect(createCourt(db, fixture.actor, input)).rejects.toMatchObject({ code: "COURT_DETAILS_INCOMPLETE" });
      expect(await catalogState()).toEqual(before);
    }
  });
  it("retains historical incomplete assets for staff but requires a complete merged result before saving or selling them", async () => {
    const draft = await createCourt(db, fixture.actor, { ...completeCourtInput(), name: "历史待补资料", hourlyPriceCents: 0 });
    // Model a historical row; current write APIs cannot create this incomplete state.
    await db.query("UPDATE tennis.courts SET surface='UNSPECIFIED',profile=jsonb_set(profile,'{specification}','\"UNSPECIFIED\"'::jsonb) WHERE tenant_id=$1 AND id=$2", [fixture.actor.tenantId, draft.id]);
    const before = await catalogState();
    expect(before.courts[0]).toMatchObject({ active: true, surface: "UNSPECIFIED", profile: { specification: "UNSPECIFIED" } });
    expect((await accessibleCourts(db, fixture.actor, fixture.venueId)).map((c) => c.id)).toEqual([draft.id]);
    expect((await venueSchedule(db, fixture.actor, fixture.venueId, date)).courts.map((c) => c.id)).toEqual([draft.id]);
    expect(await accessibleCourts(db, customer, fixture.venueId)).toEqual([]);
    expect((await venueSchedule(db, customer, fixture.venueId, date)).courts).toEqual([]);
    expect((await findAvailableCourts(db, fixture.actor, fixture.venueId, interval)).courts).toEqual([]);
    await expect(priceSelection(db, fixture.actor, fixture.venueId, [{ courtId: draft.id, ...interval }])).rejects.toMatchObject({ code: "COURT_DETAILS_INCOMPLETE", details: { fields: ["surface", "specification"] } });
    await expect(saveCourt(db, fixture.actor, { id: draft.id, venueId: fixture.venueId, expectedRevision: draft.revision, assets: { name: "不得部分补写", surface: "CLAY" } })).rejects.toMatchObject({ code: "COURT_DETAILS_INCOMPLETE", details: { fields: ["specification"] } });
    await expect(setCourtPrice(db, fixture.actor, { venueId: fixture.venueId, courtId: draft.id, expectedRevision: draft.revision, hourlyPriceCents: 16000 })).rejects.toMatchObject({ code: "COURT_DETAILS_INCOMPLETE" });
    expect(await catalogState()).toEqual(before);
    const ready = await saveCourt(db, fixture.actor, { id: draft.id, venueId: fixture.venueId, expectedRevision: draft.revision, assets: { name: draft.name, surface: "ACRYLIC", profile: { specification: "STANDARD" } } });
    expect(ready.environment).toBe("INDOOR");
    expect(ready.revision).toBe(draft.revision + 1);
    expect((await accessibleCourts(db, customer, fixture.venueId)).map((c) => c.id)).toEqual([draft.id]);
    expect((await venueSchedule(db, customer, fixture.venueId, date)).courts.map((c) => c.id)).toEqual([draft.id]);
    expect((await findAvailableCourts(db, fixture.actor, fixture.venueId, interval)).courts.map((c) => c.court.id)).toEqual([draft.id]);
    expect((await priceSelection(db, fixture.actor, fixture.venueId, [{ courtId: draft.id, ...interval }])).totalCents).toBe(0);
  });
  it("preserves partial editing permissions for complete records and rejects incomplete or unauthorized writes atomically", async () => {
    const court = await createCourt(db, fixture.actor, completeCourtInput());
    await db.query("UPDATE tennis.tenant_memberships SET role='STAFF',all_venues=true,permissions=ARRAY['read','manage_assets'] WHERE tenant_id=$1", [fixture.actor.tenantId]);
    const before = await catalogState();
    await expect(createCourt(db, fixture.actor, completeCourtInput())).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
    await expect(saveCourt(db, fixture.actor, { id: court.id, venueId: fixture.venueId, expectedRevision: court.revision, hourlyPriceCents: 10000 })).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
    await expect(saveCourt(db, fixture.actor, { id: court.id, venueId: fixture.venueId, expectedRevision: court.revision, assets: { name: "不得清空材质", active: false, surface: "UNSPECIFIED" } })).rejects.toMatchObject({ code: "COURT_DETAILS_INCOMPLETE" });
    expect(await catalogState()).toEqual(before);
    const assets = await saveCourt(db, fixture.actor, { id: court.id, venueId: fixture.venueId, expectedRevision: court.revision, assets: { name: "仅修改资料", surface: "CLAY" } });
    expect(assets.hourlyPriceCents).toBe(12000);
    expect(assets.profile.specification).toBe("STANDARD");
    await db.query("UPDATE tennis.tenant_memberships SET permissions=ARRAY['read','manage_prices'] WHERE tenant_id=$1", [fixture.actor.tenantId]);
    const beforePrice = await catalogState();
    await expect(saveCourt(db, fixture.actor, { id: court.id, venueId: fixture.venueId, expectedRevision: assets.revision, assets: { name: "不得改名" }, hourlyPriceCents: 10000 })).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
    await expect(saveCourt(db, fixture.actor, { id: court.id, venueId: fixture.venueId, expectedRevision: assets.revision, hourlyPriceCents: null })).rejects.toMatchObject({ code: "COURT_DETAILS_INCOMPLETE", details: { fields: ["hourlyPriceCents"] } });
    await expect(setCourtPrice(db, fixture.actor, { venueId: fixture.venueId, courtId: court.id, expectedRevision: court.revision, hourlyPriceCents: 16000 })).rejects.toMatchObject({ code: "STALE_CONFIGURATION" });
    expect(await catalogState()).toEqual(beforePrice);
    const complete = await setCourtPrice(db, fixture.actor, { venueId: fixture.venueId, courtId: court.id, expectedRevision: assets.revision, hourlyPriceCents: 0 });
    expect(complete).toMatchObject({ name: "仅修改资料", surface: "CLAY", hourlyPriceCents: 0, profile: { specification: "STANDARD" } });
    expect(complete.revision).toBe(assets.revision + 1);
  });
  it("blocks new quotations after details become incomplete while honoring an already issued quotation and its price", async () => {
    const court = await createCourt(db, fixture.actor, { venueId: fixture.venueId, name: "既有报价场地", environment: "INDOOR", surface: "ACRYLIC", profile: { specification: "STANDARD" }, hourlyPriceCents: 12000 });
    const request = { venueId: fixture.venueId, customerId: customer.customerId, lines: [{ courtId: court.id, ...interval }] };
    const quote = await createQuote(db, customer, request);
    const before = await catalogState();
    await expect(saveCourt(db, fixture.actor, { id: court.id, venueId: fixture.venueId, expectedRevision: court.revision, assets: { name: court.name, profile: { specification: "UNSPECIFIED" } }, hourlyPriceCents: 16000 })).rejects.toMatchObject({ code: "COURT_DETAILS_INCOMPLETE" });
    expect(await catalogState()).toEqual(before);
    // An old record can predate the required-fields contract. Current saves may
    // not produce it; existing quote snapshots must still remain usable.
    await db.query("UPDATE tennis.courts SET profile=jsonb_set(profile,'{specification}','\"UNSPECIFIED\"'::jsonb),hourly_price_cents=16000 WHERE tenant_id=$1 AND id=$2", [fixture.actor.tenantId, court.id]);
    await expect(createQuote(db, customer, request)).rejects.toMatchObject({ code: "COURT_DETAILS_INCOMPLETE" });
    const order = await confirmQuote(db, customer, { quoteId: quote.id, commandKey: randomUUID() });
    expect(order.totalCents).toBe(12000);
    expect(order.lines[0]?.amountCents).toBe(12000);
    expect((await venueSchedule(db, fixture.actor, fixture.venueId, date)).occupancies.some((o) => o.orderId === order.id)).toBe(true);
  });
});
