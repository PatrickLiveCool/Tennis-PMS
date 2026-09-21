import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createCustomer, type CustomerActor } from "../../packages/db/src/tennis/customers.ts";
import { assertLocalTennisDatabaseUrl, localTennisTestDatabaseUrl } from "../../packages/db/src/tennis/local-config.ts";
import { migrateTennis } from "../../packages/db/src/tennis/migrate.ts";
import { getWallet, recordOfflineTopup } from "../../packages/db/src/tennis/wallet.ts";
import { removeTenantFixture, seedTenantFixture, type TenantFixture } from "./tenant-fixture.ts";

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
let customer: CustomerActor;
let activeHistoryWork: { controller: AbortController; done: Promise<void> } | null = null;
const credit = (customerId = customer.customerId, fixture = first) =>
  recordOfflineTopup(db, fixture.actor, {
    venueId: fixture.venueId,
    customerId,
    principalCents: 100,
    giftCents: 20,
    receiptReference: randomUUID(),
    reason: "合成历史流水核对",
    commandKey: randomUUID(),
  });
beforeAll(async () => {
  const tx = await db.connect();
  try {
    await migrateTennis(tx);
  } finally {
    tx.release();
  }
});
beforeEach(async () => {
  activeHistoryWork = null;
  first = await seedTenantFixture(db);
  second = await seedTenantFixture(db);
  const profile = await createCustomer(db, first.actor, { nickname: "历史流水测试客户" });
  await db.query("UPDATE tennis.customers SET subject_id=$2 WHERE tenant_id=$1 AND id=$3", [
    first.actor.tenantId,
    first.actor.subjectId,
    profile.id,
  ]);
  customer = { ...first.actor, kind: "customer", customerId: profile.id };
});
afterEach(async () => {
  // Vitest deadlines do not cancel an async test body. Settle the current DB call and stop
  // its remaining loop before removing this fixture or starting the next test's fixture.
  if (activeHistoryWork) {
    activeHistoryWork.controller.abort();
    await activeHistoryWork.done.catch(() => {});
    activeHistoryWork = null;
  }
  for (const fixture of [first, second].filter(Boolean)) await removeTenantFixture(db, fixture);
});
afterAll(() => db.end());

describe("complete, scoped wallet history", () => {
  it("reaches every entry beyond 200 without duplicates or skips at microsecond ties and concurrent new credits", async () => {
    const fixture = first, owner = { ...customer }, controller = new AbortController();
    const run = async <T>(operation: () => Promise<T>): Promise<T> => {
      controller.signal.throwIfAborted();
      const result = await operation();
      controller.signal.throwIfAborted();
      return result;
    };
    const work = async () => {
      for (let index = 0; index < 205; index++) await run(() => credit(owner.customerId, fixture));
      // PostgreSQL timestamps retain more precision than JS Date. Keep both ties and sub-ms differences.
      await run(() => db.query(
        `WITH ranked AS (
        SELECT id,row_number() OVER (ORDER BY id) AS rn FROM tennis.wallet_entries WHERE tenant_id=$1
      ) UPDATE tennis.wallet_entries e SET created_at='2020-01-01T00:00:00Z'::timestamptz + (ranked.rn % 3) * interval '1 microsecond'
        FROM ranked WHERE e.tenant_id=$1 AND e.id=ranked.id`,
        [fixture.actor.tenantId],
      ));
      const expected = (
        await run(() => db.query<{ id: string }>(
          "SELECT id FROM tennis.wallet_entries WHERE tenant_id=$1 AND customer_id=$2 ORDER BY created_at DESC,id DESC",
          [fixture.actor.tenantId, owner.customerId],
        ))
      ).rows.map((entry) => entry.id);
      let page = await run(() => getWallet(db, owner, owner.customerId));
      expect(page.entries).toHaveLength(50);
      const seen = page.entries.map((entry) => entry.id);
      await run(() => credit(owner.customerId, fixture)); // New head must not shift the continuation.
      while (page.nextCursor) {
        const cursor = page.nextCursor;
        page = await run(() => getWallet(db, owner, owner.customerId, { cursor }));
        seen.push(...page.entries.map((entry) => entry.id));
      }
      expect(seen).toEqual(expected);
      expect(new Set(seen).size).toBe(205);
      expect(page.entries).toHaveLength(5);
      expect(page.balance.totalCents).toBe(206 * 120);
      expect((await run(() => getWallet(db, fixture.actor, owner.customerId, { pageSize: 200 }))).entries).toHaveLength(200);
      const refreshed = await run(() => getWallet(db, owner, owner.customerId, { pageSize: 1 }));
      expect(expected).not.toContain(refreshed.entries[0]!.id);
      expect(refreshed.balance).toEqual(page.balance);
    };
    const done = work();
    activeHistoryWork = { controller, done };
    await done;
  }, 60000); // 206 real transactions have a separate budget from ordinary 15s integration cases.

  it("rejects another customer or tenant's cursor and enforces ownership and staff wallet grants", async () => {
    await credit();
    const own = await getWallet(db, customer, customer.customerId);
    const other = await createCustomer(db, first.actor, { nickname: "另一客户" });
    await credit(other.id);
    const otherPage = await getWallet(db, first.actor, other.id);
    const foreign = await createCustomer(db, second.actor, { nickname: "另一租户客户" });
    await credit(foreign.id, second);
    const foreignPage = await getWallet(db, second.actor, foreign.id);
    for (const cursor of [otherPage.entries[0]!.id, foreignPage.entries[0]!.id, "missing-record"]) {
      await expect(getWallet(db, customer, customer.customerId, { cursor })).rejects.toMatchObject({
        code: "RESOURCE_NOT_FOUND",
      });
    }
    await expect(getWallet(db, customer, other.id, { cursor: otherPage.entries[0]!.id })).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
    });
    await expect(
      getWallet(db, second.actor, customer.customerId, { cursor: own.entries[0]!.id }),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    await db.query(
      "UPDATE tennis.tenant_memberships SET role='STAFF',permissions=ARRAY['read','book'] WHERE tenant_id=$1 AND subject_id=$2",
      [first.actor.tenantId, first.actor.subjectId],
    );
    await expect(getWallet(db, first.actor, customer.customerId, { cursor: own.entries[0]!.id })).rejects.toMatchObject(
      { code: "TENANT_ACCESS_DENIED" },
    );
    expect((await getWallet(db, customer, customer.customerId, { cursor: own.entries[0]!.id })).entries).toEqual([]);
  });

  it("validates page bounds and returns an explicit end of history", async () => {
    expect(await getWallet(db, customer, customer.customerId)).toMatchObject({
      entries: [],
      nextCursor: null,
    });
    for (const pageSize of [0, -1, 201, 1.5, NaN, Infinity]) {
      await expect(getWallet(db, customer, customer.customerId, { pageSize })).rejects.toMatchObject({
        code: "INVALID_REQUEST",
        statusCode: 400,
      });
    }
    for (const cursor of ["", "x".repeat(201)]) {
      await expect(getWallet(db, customer, customer.customerId, { cursor })).rejects.toMatchObject({
        code: "INVALID_REQUEST",
        statusCode: 400,
      });
    }
    await credit();
    const page = await getWallet(db, customer, customer.customerId, { pageSize: 1 });
    expect(page.entries).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
  });
});
