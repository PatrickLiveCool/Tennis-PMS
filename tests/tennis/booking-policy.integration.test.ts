import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getBookingPolicy, saveBookingPolicy } from "../../packages/db/src/tennis/booking-policy.ts";
import { assertLocalTennisDatabaseUrl, localTennisTestDatabaseUrl } from "../../packages/db/src/tennis/local-config.ts";
import { migrateTennis } from "../../packages/db/src/tennis/migrate.ts";
import { removeTenantFixture, seedTenantFixture, type TenantFixture } from "./tenant-fixture.ts";

const db = new pg.Pool({ connectionString: assertLocalTennisDatabaseUrl(process.env.TENNIS_TEST_DATABASE_URL ?? localTennisTestDatabaseUrl, "test"), max: 8, statement_timeout: 10000 });
let first: TenantFixture, second: TenantFixture;
const input = { quoteMinutes: 3, paymentHoldMinutes: 7, expectedRevision: 1 };
beforeAll(async () => { const tx = await db.connect(); try { await migrateTennis(tx); } finally { tx.release(); } });
beforeEach(async () => { first = await seedTenantFixture(db); second = await seedTenantFixture(db); });
afterEach(async () => { for (const fixture of [first, second]) if (fixture) await removeTenantFixture(db, fixture); });
afterAll(async () => { await db.end(); });

describe("tenant booking deadline configuration", () => {
  it("reads defaults without writes and audits changes only within the authorized tenant", async () => {
    expect(await getBookingPolicy(db, first.actor)).toEqual({ quoteMinutes: 5, paymentHoldMinutes: 10, revision: 1 });
    expect((await db.query("SELECT 1 FROM tennis.booking_policies WHERE tenant_id=$1", [first.actor.tenantId])).rowCount).toBe(0);
    expect(await saveBookingPolicy(db, first.actor, input)).toEqual({ quoteMinutes: 3, paymentHoldMinutes: 7, revision: 2 });
    expect(await getBookingPolicy(db, second.actor)).toEqual({ quoteMinutes: 5, paymentHoldMinutes: 10, revision: 1 });
    const audit = (await db.query("SELECT details FROM tennis.audit_events WHERE tenant_id=$1 AND action='booking-policy.save'", [first.actor.tenantId])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]!.details).toMatchObject({ before: { quoteMinutes: 5, paymentHoldMinutes: 10 }, after: { quoteMinutes: 3, paymentHoldMinutes: 7 } });
    await expect(saveBookingPolicy(db, { ...first.actor, tenantId: second.actor.tenantId }, input)).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
  });
  it("does not grant configuration access to asset staff, viewers, suspended membership or tenant", async () => {
    for (const role of ["STAFF", "VIEWER"]) {
      await db.query("UPDATE tennis.tenant_memberships SET role=$1,permissions=ARRAY['read','manage_assets'] WHERE tenant_id=$2", [role, first.actor.tenantId]);
      await expect(getBookingPolicy(db, first.actor)).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
      await expect(saveBookingPolicy(db, first.actor, input)).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
    }
    await db.query("UPDATE tennis.tenant_memberships SET role='ADMIN',active=false WHERE tenant_id=$1", [first.actor.tenantId]);
    await expect(saveBookingPolicy(db, first.actor, input)).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
    await db.query("UPDATE tennis.tenant_memberships SET active=true WHERE tenant_id=$1", [first.actor.tenantId]);
    await db.query("UPDATE tennis.tenants SET active=false WHERE id=$1", [first.actor.tenantId]);
    await expect(getBookingPolicy(db, first.actor)).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
    expect((await db.query("SELECT 1 FROM tennis.booking_policies WHERE tenant_id=$1", [first.actor.tenantId])).rowCount).toBe(0);
  });
  it("serializes competing first saves and rejects stale revisions without extra audit writes", async () => {
    const results = await Promise.allSettled([
      saveBookingPolicy(db, first.actor, input),
      saveBookingPolicy(db, first.actor, { ...input, quoteMinutes: 9, paymentHoldMinutes: 13 }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason.code).toBe("STALE_CONFIGURATION");
    const current = await getBookingPolicy(db, first.actor);
    expect(current.revision).toBe(2);
    await expect(saveBookingPolicy(db, first.actor, input)).rejects.toMatchObject({ code: "STALE_CONFIGURATION" });
    expect((await db.query("SELECT 1 FROM tennis.audit_events WHERE tenant_id=$1 AND action='booking-policy.save'", [first.actor.tenantId])).rowCount).toBe(1);
  });
  it("rejects invalid minutes in services and database constraints", async () => {
    for (const value of [0, -1, 1.5, 1441, NaN, Infinity]) {
      for (const field of ["quoteMinutes", "paymentHoldMinutes"])
        await expect(saveBookingPolicy(db, first.actor, { ...input, [field]: value })).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    }
    await expect(db.query("INSERT INTO tennis.booking_policies(tenant_id,quote_minutes) VALUES($1,0)", [first.actor.tenantId])).rejects.toMatchObject({ code: "23514" });
    expect(await saveBookingPolicy(db, first.actor, { quoteMinutes: 1, paymentHoldMinutes: 1440, expectedRevision: 1 }))
      .toMatchObject({ quoteMinutes: 1, paymentHoldMinutes: 1440 });
  });
});
