import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertLocalTennisDatabaseUrl, localTennisTestDatabaseUrl } from "../../packages/db/src/tennis/local-config.ts";
import { migrateTennis } from "../../packages/db/src/tennis/migrate.ts";
import { requireTenantPermission, withTenantTransaction } from "../../packages/db/src/tennis/access.ts";
import {
  findCourtConflicts,
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
  max: 5,
  connectionTimeoutMillis: 5000,
  statement_timeout: 10000,
});
const interval = { startAt: "2026-09-18T19:00+08:00", endAt: "2026-09-18T20:00+08:00" };
const request = (courtId: string) => ({
  id: randomUUID(),
  sourceId: randomUUID(),
  courtId,
  kind: "BOOKING" as const,
  ...interval,
});
let first: TenantFixture;
let second: TenantFixture;
let firstCourt: string;
let secondCourt: string;

async function court(fixture: TenantFixture, venueId = fixture.venueId) {
  const id = randomUUID();
  await db.query("INSERT INTO tennis.courts (id, tenant_id, venue_id, name) VALUES ($1, $2, $3, '1 号场')", [
    id,
    fixture.actor.tenantId,
    venueId,
  ]);
  return id;
}
beforeAll(async () => {
  const client = await db.connect();
  try {
    await migrateTennis(client);
    await migrateTennis(client);
  } finally {
    client.release();
  }
});
beforeEach(async () => {
  first = await seedTenantFixture(db);
  second = await seedTenantFixture(db);
  firstCourt = await court(first);
  secondCourt = await court(second);
});
afterEach(async () => {
  if (first) await removeTenantFixture(db, first);
  if (second) await removeTenantFixture(db, second);
});
afterAll(async () => {
  await db.end();
});

describe("tenant and venue isolation", () => {
  it("requires an explicit reconciliation grant for staff without granting booking or member access", async () => {
    const allowed = () => withTenantTransaction(db, first.actor, (tx) =>
      requireTenantPermission(tx, first.actor, "reconcile_payments"),
    );
    await expect(allowed()).resolves.toBeUndefined();
    await db.query(
      "UPDATE tennis.tenant_memberships SET role='STAFF', permissions=ARRAY['read','book','manage_members'] WHERE tenant_id=$1",
      [first.actor.tenantId],
    );
    await expect(allowed()).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
    await db.query(
      "UPDATE tennis.tenant_memberships SET permissions=ARRAY['read','reconcile_payments'] WHERE tenant_id=$1",
      [first.actor.tenantId],
    );
    await expect(allowed()).resolves.toBeUndefined();
    for (const permission of ["book", "manage_members"] as const) {
      await expect(withTenantTransaction(db, first.actor, (tx) =>
        requireTenantPermission(tx, first.actor, permission),
      )).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
    }
    await expect(withTenantTransaction(db, { ...first.actor, tenantId: second.actor.tenantId }, (tx) =>
      requireTenantPermission(tx, { ...first.actor, tenantId: second.actor.tenantId }, "reconcile_payments"),
    )).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
    await db.query("UPDATE tennis.tenant_memberships SET role='VIEWER' WHERE tenant_id=$1", [first.actor.tenantId]);
    await expect(allowed()).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
  });
  it("keeps identically named courts and overlapping times independent across tenants", async () => {
    const a = request(firstCourt);
    const b = request(secondCourt);
    await occupyCourt(db, first.actor, a);
    await occupyCourt(db, second.actor, b);
    expect(await findCourtConflicts(db, first.actor, firstCourt, interval)).toEqual([a.id]);
    expect(await findCourtConflicts(db, second.actor, secondCourt, interval)).toEqual([b.id]);
    await expect(findCourtConflicts(db, first.actor, secondCourt, interval)).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
    });
    await expect(occupyCourt(db, first.actor, request(secondCourt))).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
    });
    await expect(
      findCourtConflicts(db, { ...first.actor, tenantId: second.actor.tenantId }, secondCourt, interval),
    ).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
  });
  it("cannot release or move another tenant's occupancy, or move its own to another tenant", async () => {
    const a = request(firstCourt);
    const b = request(secondCourt);
    await occupyCourt(db, first.actor, a);
    await occupyCourt(db, second.actor, b);
    await expect(releaseCourtOccupancy(db, first.actor, b.id, 1)).rejects.toMatchObject({ code: "STALE_OCCUPANCY" });
    await expect(rescheduleCourtOccupancy(db, first.actor, b.id, 1, firstCourt, interval)).rejects.toMatchObject({
      code: "STALE_OCCUPANCY",
    });
    await expect(rescheduleCourtOccupancy(db, first.actor, a.id, 1, secondCourt, interval)).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
    });
    expect(await findCourtConflicts(db, first.actor, firstCourt, interval)).toEqual([a.id]);
    expect(await findCourtConflicts(db, second.actor, secondCourt, interval)).toEqual([b.id]);
    const audit = await db.query("SELECT action FROM tennis.audit_events WHERE tenant_id = $1", [first.actor.tenantId]);
    expect(audit.rows).toEqual([{ action: "occupancy.create" }]);
  });
  it("limits staff to granted venues and checks both sides of a move", async () => {
    const otherVenue = randomUUID();
    await db.query("INSERT INTO tennis.venues (id, tenant_id, name) VALUES ($1, $2, 'another venue')", [
      otherVenue,
      first.actor.tenantId,
    ]);
    const otherCourt = await court(first, otherVenue);
    const own = request(firstCourt);
    const other = request(otherCourt);
    await occupyCourt(db, first.actor, own);
    await occupyCourt(db, first.actor, other);
    await db.query(
      "UPDATE tennis.tenant_memberships SET role = 'STAFF', permissions = ARRAY['read','book'] WHERE tenant_id = $1",
      [first.actor.tenantId],
    );
    await db.query("INSERT INTO tennis.membership_venues (tenant_id, subject_id, venue_id) VALUES ($1, $2, $3)", [
      first.actor.tenantId,
      first.actor.subjectId,
      first.venueId,
    ]);
    expect(await findCourtConflicts(db, first.actor, firstCourt, interval)).toEqual([own.id]);
    await expect(findCourtConflicts(db, first.actor, otherCourt, interval)).rejects.toMatchObject({
      code: "TENANT_ACCESS_DENIED",
    });
    await expect(rescheduleCourtOccupancy(db, first.actor, own.id, 1, otherCourt, interval)).rejects.toMatchObject({
      code: "TENANT_ACCESS_DENIED",
    });
    await expect(rescheduleCourtOccupancy(db, first.actor, other.id, 1, firstCourt, interval)).rejects.toMatchObject({
      code: "TENANT_ACCESS_DENIED",
    });
    await expect(releaseCourtOccupancy(db, first.actor, other.id, 1)).rejects.toMatchObject({
      code: "TENANT_ACCESS_DENIED",
    });
    await releaseCourtOccupancy(db, first.actor, own.id, 1);
    expect(await findCourtConflicts(db, first.actor, firstCourt, interval)).toEqual([]);
  });
  it("allows a viewer to read but denies writes even with an erroneously granted book permission", async () => {
    await db.query(
      "UPDATE tennis.tenant_memberships SET role = 'VIEWER', all_venues = true, permissions = ARRAY['read','book'] WHERE tenant_id = $1",
      [first.actor.tenantId],
    );
    expect(await findCourtConflicts(db, first.actor, firstCourt, interval)).toEqual([]);
    await expect(occupyCourt(db, first.actor, request(firstCourt))).rejects.toMatchObject({
      code: "TENANT_ACCESS_DENIED",
    });
    expect(
      (
        await db.query("SELECT count(*)::int AS total FROM tennis.occupancies WHERE tenant_id = $1", [
          first.actor.tenantId,
        ])
      ).rows[0].total,
    ).toBe(0);
  });
  it("rejects inactive tenants and revoked memberships on subsequent calls", async () => {
    await db.query("UPDATE tennis.tenants SET active = false WHERE id = $1", [first.actor.tenantId]);
    await expect(findCourtConflicts(db, first.actor, firstCourt, interval)).rejects.toMatchObject({
      code: "TENANT_ACCESS_DENIED",
    });
    await expect(occupyCourt(db, first.actor, request(firstCourt))).rejects.toMatchObject({
      code: "TENANT_ACCESS_DENIED",
    });
    await db.query("UPDATE tennis.tenants SET active = true WHERE id = $1", [first.actor.tenantId]);
    await db.query("UPDATE tennis.tenant_memberships SET active = false WHERE tenant_id = $1", [first.actor.tenantId]);
    await expect(findCourtConflicts(db, first.actor, firstCourt, interval)).rejects.toMatchObject({
      code: "TENANT_ACCESS_DENIED",
    });
  });
  it("enforces asset ownership on direct SQL references", async () => {
    await expect(
      db.query("INSERT INTO tennis.courts (id, tenant_id, venue_id, name) VALUES ($1, $2, $3, 'cross tenant')", [
        randomUUID(),
        first.actor.tenantId,
        second.venueId,
      ]),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      db.query(
        `INSERT INTO tennis.occupancies (id, tenant_id, court_id, kind, source_id, start_at, end_at)
      VALUES ($1, $2, $3, 'BOOKING', $1, $4, $5)`,
        [randomUUID(), first.actor.tenantId, secondCourt, interval.startAt, interval.endAt],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });
  it("blocks new bookings on disabled resources but permits authorized release of existing occupancy", async () => {
    const input = request(firstCourt);
    await occupyCourt(db, first.actor, input);
    await db.query("UPDATE tennis.courts SET active = false WHERE id = $1", [firstCourt]);
    await expect(occupyCourt(db, first.actor, request(firstCourt))).rejects.toMatchObject({
      code: "RESOURCE_UNAVAILABLE",
    });
    await releaseCourtOccupancy(db, first.actor, input.id, 1);
    expect(await findCourtConflicts(db, first.actor, firstCourt, interval)).toEqual([]);
    const audit = await db.query("SELECT action FROM tennis.audit_events WHERE tenant_id = $1 ORDER BY created_at", [
      first.actor.tenantId,
    ]);
    expect(audit.rows).toEqual([{ action: "occupancy.create" }, { action: "occupancy.release" }]);
  });
});
