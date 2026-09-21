import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertLocalTennisDatabaseUrl, localTennisTestDatabaseUrl } from "../../packages/db/src/tennis/local-config.ts";
import { migrateTennis } from "../../packages/db/src/tennis/migrate.ts";
import {
  createCourt,
  createVenue,
  findAvailableCourts,
  findMatchingCourts,
  listCourts,
  listDiscounts,
  listVenues,
  priceSelection,
  saveDiscount,
  setCourtPrice,
  updateCourt,
  updateVenue,
  type CourtRecord,
} from "../../packages/db/src/tennis/catalog.ts";
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
const hours = Array.from({ length: 7 }, (_, weekday) => ({ weekday, startMinute: 480, endMinute: 1320 }));
const interval = (start = "19:00", end = "20:00", date = "2026-09-18") => ({
  startAt: `${date}T${start}:00+08:00`,
  endAt: `${date}T${end}:00+08:00`,
});
let first: TenantFixture;
let second: TenantFixture;

async function setupCourt(fixture = first, price = 10000): Promise<CourtRecord> {
  const venue = (await listVenues(db, fixture.actor)).find((venue) => venue.id === fixture.venueId)!;
  await updateVenue(db, fixture.actor, {
    ...venue,
    expectedRevision: venue.catalogRevision,
    openingHours: hours,
    minimumBookingMinutes: 15,
  });
  const court = await createCourt(db, fixture.actor, { venueId: fixture.venueId, name: "1 号场", indoor: false });
  return setCourtPrice(db, fixture.actor, {
    courtId: court.id,
    venueId: fixture.venueId,
    expectedRevision: court.revision,
    hourlyPriceCents: price,
  });
}
function discount(courtId: string) {
  return {
    active: true,
    rule: {
      venueId: first.venueId,
      name: "日间八折",
      courtIds: [courtId],
      dateFrom: "2026-09-01",
      dateTo: "2026-09-30",
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      startMinute: 600,
      endMinute: 1080,
      discountBps: 8000,
    },
  };
}
beforeAll(async () => {
  const tx = await db.connect();
  try {
    await migrateTennis(tx);
    await migrateTennis(tx);
  } finally {
    tx.release();
  }
});
beforeEach(async () => {
  first = await seedTenantFixture(db);
  second = await seedTenantFixture(db);
});
afterEach(async () => {
  if (first) await removeTenantFixture(db, first);
  if (second) await removeTenantFixture(db, second);
});
afterAll(async () => {
  await db.end();
});

describe("tenant catalog and pricing", () => {
  it("persists clay independently of indoor status and preserves it for older update clients", async () => {
    const original = await setupCourt();
    expect(original.surface).toBe("UNSPECIFIED");
    const clay = await updateCourt(db, first.actor, { ...original, expectedRevision: original.revision, indoor: true, surface: "CLAY" });
    expect(clay).toMatchObject({ indoor: true, surface: "CLAY", hourlyPriceCents: 10000 });
    const { surface: _surface, ...legacy } = clay;
    const renamed = await updateCourt(db, first.actor, { ...legacy, name: "室内红土", expectedRevision: clay.revision });
    expect(renamed.surface).toBe("CLAY");
    expect((await findAvailableCourts(db, first.actor, first.venueId, interval())).courts[0]?.court.surface).toBe("CLAY");
    expect((await priceSelection(db, first.actor, first.venueId, [{ courtId: clay.id, ...interval() }])).totalCents).toBe(10000);
    await expect(updateCourt(db, second.actor, { ...renamed, expectedRevision: renamed.revision, surface: "UNSPECIFIED" })).rejects.toBeTruthy();
    await expect(updateCourt(db, first.actor, { ...renamed, expectedRevision: renamed.revision, surface: "unsafe" as never })).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
  });
  it("starts new assets unconfigured instead of inventing sale hours or prices", async () => {
    const venue = await createVenue(db, first.actor, {
      name: "新校区",
      address: "模拟地址",
      timezone: "Asia/Shanghai",
    });
    expect(venue.openingHours).toEqual([]);
    expect(venue.minimumBookingMinutes).toBeNull();
    const court = await createCourt(db, first.actor, { venueId: venue.id, name: "1 号场", indoor: true });
    expect(court.hourlyPriceCents).toBeNull();
    expect((await findAvailableCourts(db, first.actor, venue.id, interval())).courts).toEqual([]);
    await expect(
      priceSelection(db, first.actor, venue.id, [{ courtId: court.id, ...interval() }]),
    ).rejects.toMatchObject({ code: "PRICE_NOT_CONFIGURED" });
  });
  it("quotes across price boundaries, sums multiple lines and preserves old results after a price change", async () => {
    const court = await setupCourt();
    await saveDiscount(db, first.actor, discount(court.id));
    const original = await priceSelection(db, first.actor, first.venueId, [
      { courtId: court.id, ...interval("17:30", "18:30") },
      { courtId: court.id, ...interval("20:00", "21:00") },
    ]);
    expect(original.totalCents).toBe(19000);
    expect(original.lines.map((line) => line.totalCents)).toEqual([9000, 10000]);
    const changed = await setCourtPrice(db, first.actor, {
      courtId: court.id,
      venueId: first.venueId,
      expectedRevision: court.revision,
      hourlyPriceCents: 20000,
    });
    const latest = await priceSelection(db, first.actor, first.venueId, [
      { courtId: court.id, ...interval("17:30", "18:30") },
    ]);
    expect(latest.totalCents).toBe(18000);
    expect(latest.catalogRevision).toBeGreaterThan(original.catalogRevision);
    expect(original.totalCents).toBe(19000);
    expect(changed.revision).toBe(court.revision + 1);
    await expect(
      setCourtPrice(db, first.actor, {
        courtId: court.id,
        venueId: first.venueId,
        expectedRevision: court.revision,
        hourlyPriceCents: 1,
      }),
    ).rejects.toMatchObject({ code: "STALE_CONFIGURATION" });
  });
  it("rejects overlapping lines for one court while allowing same-time different courts", async () => {
    const one = await setupCourt();
    const two = await setupCourt();
    await expect(
      priceSelection(db, first.actor, first.venueId, [
        { courtId: one.id, ...interval() },
        { courtId: one.id, ...interval("19:30", "20:30") },
      ]),
    ).rejects.toMatchObject({ code: "INVALID_SELECTION" });
    expect(
      (
        await priceSelection(db, first.actor, first.venueId, [
          { courtId: one.id, ...interval() },
          { courtId: two.id, ...interval() },
        ])
      ).totalCents,
    ).toBe(20000);
  });
  it("serializes conflicting discount configurations and requires fixing overlaps before activation", async () => {
    const court = await setupCourt();
    const results = await Promise.allSettled([
      saveDiscount(db, first.actor, discount(court.id)),
      saveDiscount(db, first.actor, discount(court.id)),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason.code).toBe(
      "DISCOUNT_OVERLAP",
    );
    const dormant = await saveDiscount(db, first.actor, { ...discount(court.id), active: false });
    await expect(
      saveDiscount(db, first.actor, { active: true, rule: dormant, expectedRevision: dormant.revision }),
    ).rejects.toMatchObject({ code: "DISCOUNT_OVERLAP" });
    expect((await listDiscounts(db, first.actor, first.venueId)).filter((rule) => rule.active)).toHaveLength(1);
  });
  it("does not merge two courts available at different times into a simultaneous multi-court result", async () => {
    const one = await setupCourt();
    const two = await setupCourt();
    await occupyCourt(db, first.actor, {
      id: randomUUID(),
      sourceId: randomUUID(),
      courtId: one.id,
      kind: "COURSE",
      ...interval("19:00", "19:30"),
    });
    await occupyCourt(db, first.actor, {
      id: randomUUID(),
      sourceId: randomUUID(),
      courtId: two.id,
      kind: "MAINTENANCE",
      ...interval("19:30", "20:00"),
    });
    const found = await findMatchingCourts(db, first.actor, first.venueId, interval(), 2);
    expect(found).toMatchObject({ sufficient: false, requestedCount: 2, availableCount: 0, candidates: [] });
    const later = await findMatchingCourts(db, first.actor, first.venueId, interval("20:00", "21:00"), 2);
    expect(later).toMatchObject({ sufficient: true, availableCount: 2 });
    const available = await findAvailableCourts(db, first.actor, first.venueId, interval("19:00", "21:00"));
    const freeOne = available.courts.find((item) => item.court.id === one.id)!;
    expect(freeOne.intervals).toEqual([{ startAt: "2026-09-18T11:30:00.000Z", endAt: "2026-09-18T13:00:00.000Z" }]);
  });
  it("preserves future bookings when closing a court or shrinking venue hours", async () => {
    const court = await setupCourt();
    const booking = {
      id: randomUUID(),
      sourceId: randomUUID(),
      courtId: court.id,
      kind: "BOOKING" as const,
      ...interval("19:00", "20:00", "2099-09-18"),
    };
    await occupyCourt(db, first.actor, booking);
    await expect(
      updateCourt(db, first.actor, { ...court, expectedRevision: court.revision, active: false }),
    ).rejects.toMatchObject({ code: "AFFECTED_OCCUPANCIES", details: { occupancyIds: [booking.id] } });
    const venue = (await listVenues(db, first.actor)).find((venue) => venue.id === first.venueId)!;
    await expect(
      updateVenue(db, first.actor, {
        ...venue,
        expectedRevision: venue.catalogRevision,
        minimumBookingMinutes: 15,
        openingHours: hours.map((window) => ({ ...window, endMinute: 1080 })),
      }),
    ).rejects.toMatchObject({ code: "AFFECTED_OCCUPANCIES" });
    expect((await listCourts(db, first.actor, first.venueId))[0]?.active).toBe(true);
    expect((await listVenues(db, first.actor)).find((item) => item.id === first.venueId)?.catalogRevision).toBe(
      venue.catalogRevision,
    );
    await releaseCourtOccupancy(db, first.actor, booking.id, 1);
    await updateCourt(db, first.actor, { ...court, expectedRevision: court.revision, active: false });
    expect((await findMatchingCourts(db, first.actor, first.venueId, interval(), 1)).availableCount).toBe(0);
  });
  it("separates price permissions from ordinary booking and asset operations", async () => {
    const court = await setupCourt();
    await db.query(
      "UPDATE tennis.tenant_memberships SET role='STAFF',all_venues=true,permissions=ARRAY['read','book','manage_assets'] WHERE tenant_id=$1",
      [first.actor.tenantId],
    );
    expect((await listCourts(db, first.actor, first.venueId))[0]?.id).toBe(court.id);
    await updateCourt(db, first.actor, { ...court, expectedRevision: court.revision, indoor: true });
    await expect(
      setCourtPrice(db, first.actor, {
        courtId: court.id,
        venueId: first.venueId,
        expectedRevision: court.revision + 1,
        hourlyPriceCents: 1,
      }),
    ).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
    await expect(saveDiscount(db, first.actor, discount(court.id))).rejects.toMatchObject({
      code: "TENANT_ACCESS_DENIED",
    });
    await expect(
      createVenue(db, first.actor, { name: "不能自行扩权建校区", timezone: "Asia/Shanghai" }),
    ).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
  });
  it("restricts catalog lists, pricing and discount targets to tenant and venue scope", async () => {
    const one = await setupCourt();
    const foreign = await setupCourt(second);
    expect((await listVenues(db, first.actor)).map((venue) => venue.id)).toEqual([first.venueId]);
    await expect(listCourts(db, first.actor, second.venueId)).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    await expect(
      priceSelection(db, first.actor, first.venueId, [{ courtId: foreign.id, ...interval() }]),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    await expect(
      saveDiscount(db, first.actor, {
        ...discount(one.id),
        rule: { ...discount(one.id).rule, courtIds: [foreign.id] },
      }),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    await db.query(
      "UPDATE tennis.tenant_memberships SET role='STAFF',all_venues=false,permissions=ARRAY['read','book'] WHERE tenant_id=$1",
      [first.actor.tenantId],
    );
    expect(await listVenues(db, first.actor)).toEqual([]);
    await expect(listCourts(db, first.actor, first.venueId)).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
  });
});
