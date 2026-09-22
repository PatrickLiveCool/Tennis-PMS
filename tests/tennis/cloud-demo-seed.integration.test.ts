import pg from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { buildCloudDemoData, cloudDemoAccounts, cloudDemoTransactionPool, initializeCloudDemo, type CloudDemoPasswords } from "../../scripts/tennis/cloud-demo-data.ts";
import { assertLocalTennisDatabaseUrl, localTennisTestDatabaseUrl } from "../../packages/db/src/tennis/local-config.ts";

const db = new pg.Pool({
  connectionString: assertLocalTennisDatabaseUrl(process.env.TENNIS_TEST_DATABASE_URL ?? localTennisTestDatabaseUrl, "test"),
  max: 2, connectionTimeoutMillis: 5000, statement_timeout: 10000,
});
const passwords: CloudDemoPasswords = {
  "demo.platform": "synthetic-platform-secret-01", "demo.green": "synthetic-admin-secret-02",
  "demo.staff": "synthetic-staff-secret-03", "demo.customer": "synthetic-customer-secret-04",
};
afterAll(async () => { await db.end(); });

/**
 * Existing tennis_test fixtures are preserved. Only the bootstrap empty-database
 * SELECT is substituted; every business query/savepoint uses the real tennis_test
 * connection and all generated records are rolled back by this test.
 */
function fixtureClient(tx: pg.PoolClient, failOnPayment = false): pg.PoolClient {
  return new Proxy(tx, {
    get(target, property) {
      if (property !== "query") return Reflect.get(target, property);
      return async (sql: string, values?: unknown[]) => {
        if (sql.includes("OR EXISTS(SELECT 1 FROM tennis.subjects)"))
          return { command: "SELECT", rowCount: 1, rows: [{ occupied: false }], fields: [] };
        if (failOnPayment && sql.includes("INSERT INTO tennis.payment_attempts")) return target.query("SELECT 1/0");
        return target.query(sql, values);
      };
    },
  });
}
async function assertNoAccountCollision() {
  expect((await db.query("SELECT username FROM tennis.local_accounts WHERE username=ANY($1::text[])", [cloudDemoAccounts])).rowCount).toBe(0);
}

describe("cloud demo seed real PostgreSQL transaction behavior", () => {
  it("rejects the actual tennis_test connection before initialization writes", async () => {
    await expect(initializeCloudDemo(db, { databaseUrl: "postgres://tennis_demo:synthetic@db/tennis_demo", passwords }))
      .rejects.toThrow("database or role other than tennis_demo");
  });
  it("refuses an occupied database without deleting or merging existing tenant records", async () => {
    const tx = await db.connect();
    await tx.query("BEGIN");
    try {
      const tenantId = randomUUID();
      await tx.query("INSERT INTO tennis.tenants(id,name) VALUES($1,'synthetic existing tenant')", [tenantId]);
      const before = (await tx.query("SELECT id FROM tennis.tenants ORDER BY id")).rows;
      await expect(buildCloudDemoData(cloudDemoTransactionPool(tx), passwords)).rejects.toThrow("requires an empty tennis database");
      expect((await tx.query("SELECT id FROM tennis.tenants ORDER BY id")).rows).toEqual(before);
      expect((await tx.query("SELECT username FROM tennis.local_accounts WHERE username=ANY($1::text[])", [cloudDemoAccounts])).rowCount).toBe(0);
    } finally { await tx.query("ROLLBACK"); tx.release(); }
  });
  it("creates one tenant, two usable campuses and paid synthetic bookings, and preserves password/money on rerun", async () => {
    await assertNoAccountCollision();
    const tx = await db.connect();
    await tx.query("BEGIN");
    try {
      const seedDb = cloudDemoTransactionPool(fixtureClient(tx));
      const first = await buildCloudDemoData(seedDb, passwords);
      expect(first.created).toBe(true);
      expect(first.manifest.tenantName).toBe("格林网球");
      expect(first.manifest.venues.map((venue) => venue.name)).toEqual(["省体校区", "高新校区"]);
      const tenantId = first.manifest.tenantId;
      const venues = (await tx.query("SELECT minimum_booking_minutes,opening_hours FROM tennis.venues WHERE tenant_id=$1", [tenantId])).rows;
      expect(venues).toHaveLength(2);
      for (const venue of venues) {
        expect(venue.minimum_booking_minutes).toBe(30);
        expect(venue.opening_hours).toEqual(Array.from({ length: 7 }, (_, weekday) => ({ weekday, startMinute: 420, endMinute: 1380 })));
      }
      expect((await tx.query("SELECT id FROM tennis.courts WHERE tenant_id=$1", [tenantId])).rowCount).toBe(8);
      expect((await tx.query("SELECT id FROM tennis.orders WHERE tenant_id=$1 AND payment_status='PAID' AND status='CONFIRMED'", [tenantId])).rowCount).toBe(2);
      expect((await tx.query("SELECT id FROM tennis.occupancies WHERE tenant_id=$1 AND kind='COURSE' AND start_at>now()", [tenantId])).rowCount).toBe(2);
      expect((await tx.query("SELECT id FROM tennis.occupancies WHERE tenant_id=$1 AND kind='MAINTENANCE'", [tenantId])).rowCount).toBe(2);
      expect((await tx.query("SELECT phone FROM tennis.customers WHERE tenant_id=$1 AND phone IS NOT NULL", [tenantId])).rowCount).toBe(3);
      const hashes = (await tx.query("SELECT username,password_hash FROM tennis.local_accounts WHERE username=ANY($1::text[]) ORDER BY username", [cloudDemoAccounts])).rows;
      const balances = (await tx.query("SELECT * FROM tennis.wallet_accounts WHERE tenant_id=$1 ORDER BY customer_id", [tenantId])).rows;
      const entries = (await tx.query("SELECT id FROM tennis.wallet_entries WHERE tenant_id=$1", [tenantId])).rowCount;
      const second = await buildCloudDemoData(seedDb, { ...passwords, "demo.green": "changed-password-must-not-apply" });
      expect(second).toEqual({ created: false, manifest: first.manifest });
      expect((await tx.query("SELECT username,password_hash FROM tennis.local_accounts WHERE username=ANY($1::text[]) ORDER BY username", [cloudDemoAccounts])).rows).toEqual(hashes);
      expect((await tx.query("SELECT * FROM tennis.wallet_accounts WHERE tenant_id=$1 ORDER BY customer_id", [tenantId])).rows).toEqual(balances);
      expect((await tx.query("SELECT id FROM tennis.wallet_entries WHERE tenant_id=$1", [tenantId])).rowCount).toBe(entries);
    } finally { await tx.query("ROLLBACK"); tx.release(); }
    await assertNoAccountCollision();
  });
  it("rolls back all accounts, wallet credits and court data after a real SQL failure mid-seed", async () => {
    await assertNoAccountCollision();
    const before = (await db.query("SELECT (SELECT count(*) FROM tennis.tenants) AS tenants,(SELECT count(*) FROM tennis.wallet_entries) AS entries,(SELECT count(*) FROM tennis.courts) AS courts")).rows[0];
    const tx = await db.connect();
    await tx.query("BEGIN");
    try {
      await expect(buildCloudDemoData(cloudDemoTransactionPool(fixtureClient(tx, true)), passwords)).rejects.toMatchObject({ code: "22012" });
    } finally { await tx.query("ROLLBACK"); tx.release(); }
    expect((await db.query("SELECT (SELECT count(*) FROM tennis.tenants) AS tenants,(SELECT count(*) FROM tennis.wallet_entries) AS entries,(SELECT count(*) FROM tennis.courts) AS courts")).rows[0]).toEqual(before);
    await assertNoAccountCollision();
  });
});
