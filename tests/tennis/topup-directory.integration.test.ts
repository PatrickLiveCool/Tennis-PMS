import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertLocalTennisDatabaseUrl, localTennisTestDatabaseUrl } from "../../packages/db/src/tennis/local-config.ts";
import { migrateTennis } from "../../packages/db/src/tennis/migrate.ts";
import { createVenue } from "../../packages/db/src/tennis/catalog.ts";
import { createCustomer, type CustomerActor, type BookingActor } from "../../packages/db/src/tennis/customers.ts";
import { listCustomerTopups } from "../../packages/db/src/tennis/topup-directory.ts";
import {
  beginTopupPayment,
  createTopupQuote,
  settleVerifiedTopup,
  type TopupPayment,
} from "../../packages/db/src/tennis/topups.ts";
import { LocalMockPaymentGateway } from "../../packages/db/src/tennis/mock-payments.ts";
import { removeTenantFixture, seedTenantFixture, type TenantFixture } from "./tenant-fixture.ts";

const db = new pg.Pool({
  connectionString: assertLocalTennisDatabaseUrl(
    process.env.TENNIS_TEST_DATABASE_URL ?? localTennisTestDatabaseUrl,
    "test",
  ),
  max: 6,
  connectionTimeoutMillis: 5000,
  statement_timeout: 10000,
});
const gateway = new LocalMockPaymentGateway("synthetic-topup-directory-signing-secret", "local-simulation");
let first: TenantFixture, second: TenantFixture;
let customer: CustomerActor, otherCustomerId: string, otherVenueId: string;
interface SeedTopup {
  id?: string;
  createdAt?: string;
  status?: "PENDING" | "FAILED";
  customerId?: string;
  venueId?: string;
}
/** Synthetic historical intents for pagination; this helper performs no simulated collection. */
async function seedTopups(inputs: SeedTopup[], fixture = first) {
  const rows = inputs.map((input) => ({
    id: input.id ?? randomUUID(),
    quote_id: randomUUID(),
    created_at: input.createdAt ?? "2030-01-01T00:00:00.000123Z",
    status: input.status ?? "PENDING",
    customer_id: input.customerId ?? customer.customerId,
    venue_id: input.venueId ?? fixture.venueId,
  }));
  const tx = await db.connect();
  try {
    await tx.query("BEGIN");
    await tx.query(
      `INSERT INTO tennis.topup_quotes(id,tenant_id,venue_id,customer_id,created_by,principal_cents,gift_cents,expires_at)
      SELECT x.quote_id,$2,x.venue_id,x.customer_id,$3,1000,200,'2099-01-01T00:00:00Z' FROM jsonb_to_recordset($1::jsonb) AS x(quote_id text,venue_id text,customer_id text)`,
      [JSON.stringify(rows), fixture.actor.tenantId, fixture.actor.subjectId],
    );
    await tx.query(
      `INSERT INTO tennis.topup_payments(id,tenant_id,venue_id,customer_id,quote_id,provider,merchant_id,principal_cents,gift_cents,status,created_by,created_at)
      SELECT x.id,$2,x.venue_id,x.customer_id,x.quote_id,'MOCK',$4,1000,200,x.status,$3,x.created_at::timestamptz FROM jsonb_to_recordset($1::jsonb) AS x(id text,venue_id text,customer_id text,quote_id text,status text,created_at text)`,
      [JSON.stringify(rows), fixture.actor.tenantId, fixture.actor.subjectId, `mock:${fixture.actor.tenantId}`],
    );
    await tx.query("COMMIT");
    return rows.map((row) => row.id);
  } catch (error) {
    await tx.query("ROLLBACK");
    throw error;
  } finally {
    tx.release();
  }
}
async function readAll(
  input: { pageSize: number | string; status?: TopupPayment["status"] },
  actor: BookingActor = first.actor,
) {
  const items: TopupPayment[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await listCustomerTopups(db, actor, first.venueId, customer.customerId, {
      ...input,
      ...(cursor ? { cursor } : {}),
    });
    expect(page.items.length).toBeLessThanOrEqual(Number(input.pageSize));
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
    expect(++pages).toBeLessThan(30);
  } while (cursor);
  return items;
}
async function liveTopup(status: TopupPayment["status"]) {
  const quote = await createTopupQuote(db, customer, {
    venueId: first.venueId,
    customerId: customer.customerId,
    principalCents: 12000,
  });
  const payment = await beginTopupPayment(db, customer, gateway, { quoteId: quote.id, commandKey: randomUUID() });
  if (status === "PENDING") return payment;
  const signed = gateway.signForLocalSimulator({
    provider: "MOCK",
    merchantId: payment.merchantId,
    paymentId: payment.id,
    eventId: randomUUID(),
    transactionId: randomUUID(),
    status,
    amountCents: payment.principalCents,
    currency: "CNY",
    issuedAt: Date.now(),
  });
  return settleVerifiedTopup(db, gateway.verify(signed.body, signed.signature));
}
async function storedFacts() {
  const tables = [
    "topup_quotes",
    "topup_payments",
    "topup_events",
    "wallet_accounts",
    "wallet_batches",
    "wallet_entries",
    "channel_transactions",
    "channel_operations",
    "channel_observations",
    "payment_merchant_bindings",
    "audit_events",
    "business_events",
    "business_event_counters",
  ];
  return Promise.all(
    tables.map(async (table) => ({
      table,
      rows: (
        await db.query<{ rows: unknown }>(
          `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM tennis.${table} t WHERE tenant_id=$1`,
          [first.actor.tenantId],
        )
      ).rows[0]!.rows,
    })),
  );
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
  const profile = await createCustomer(db, first.actor, { nickname: "合成充值目录客户" });
  await db.query("UPDATE tennis.customers SET subject_id=$1 WHERE tenant_id=$2 AND id=$3", [
    first.actor.subjectId,
    first.actor.tenantId,
    profile.id,
  ]);
  customer = { ...first.actor, kind: "customer", customerId: profile.id };
  otherCustomerId = (await createCustomer(db, first.actor, { nickname: "另一客户" })).id;
  otherVenueId = (await createVenue(db, first.actor, { name: "第二校区", timezone: "Asia/Shanghai" })).id;
});
afterEach(async () => {
  for (const fixture of [first, second].filter(Boolean)) await removeTenantFixture(db, fixture);
});
afterAll(() => db.end());

describe("complete and read-only customer topup history", () => {
  it("pages more than 100 identical timestamps once each and keeps the default page bounded", async () => {
    const prefix = randomUUID();
    const ids = await seedTopups(
      Array.from({ length: 121 }, (_, index) => ({ id: `${prefix}-${String(index).padStart(3, "0")}` })),
    );
    const firstPage = await listCustomerTopups(db, first.actor, first.venueId, customer.customerId);
    expect(firstPage.items).toHaveLength(20);
    expect(firstPage.nextCursor).toBe(firstPage.items[19]!.id);
    const all = await readAll({ pageSize: "17" });
    expect(all.map((row) => row.id)).toEqual([...ids].reverse());
    expect(new Set(all.map((row) => row.id)).size).toBe(121);
  });
  it("retains PostgreSQL microsecond boundaries even when every returned timestamp rounds to one millisecond", async () => {
    const prefix = randomUUID();
    const ids = await seedTopups(
      Array.from({ length: 127 }, (_, index) => ({
        id: `${prefix}-${String(126 - index).padStart(3, "0")}`,
        createdAt: `2030-01-01T00:00:00.${String(index + 100).padStart(6, "0")}Z`,
      })),
    );
    const all = await readAll({ pageSize: 13 });
    expect(all.map((row) => row.id)).toEqual([...ids].reverse());
    expect(new Set(all.map((row) => row.createdAt)).size).toBe(1);
    expect(new Set(all.map((row) => row.id)).size).toBe(127);
  });
  it("filters status before paging so old failures remain reachable behind newer pending topups", async () => {
    await seedTopups(Array.from({ length: 110 }, () => ({ createdAt: "2035-01-01T00:00:00Z" })));
    const failures = await seedTopups(
      Array.from({ length: 9 }, () => ({ status: "FAILED", createdAt: "2030-01-01T00:00:00Z" })),
    );
    const success = await liveTopup("SUCCEEDED");
    const failed = await readAll({ pageSize: 4, status: "FAILED" });
    expect(new Set(failed.map((row) => row.id))).toEqual(new Set(failures));
    expect(failed.every((row) => row.status === "FAILED")).toBe(true);
    const succeeded = await listCustomerTopups(db, first.actor, first.venueId, customer.customerId, {
      status: "SUCCEEDED",
    });
    expect(succeeded).toEqual({ items: [success], nextCursor: null });
    const pending = await readAll({ pageSize: 31, status: "PENDING" });
    expect(pending).toHaveLength(110);
    expect(pending.every((row) => row.status === "PENDING")).toBe(true);
  });
  it("isolates tenant, campus and customer in both rows and cursor lookup", async () => {
    const [own] = await seedTopups([{}]);
    const [other] = await seedTopups([{ customerId: otherCustomerId }]);
    const [otherCampus] = await seedTopups([{ venueId: otherVenueId }]);
    const foreignCustomer = await createCustomer(db, second.actor, { nickname: "外租户客户" });
    const [foreign] = await seedTopups([{ customerId: foreignCustomer.id }], second);
    expect(
      (await listCustomerTopups(db, first.actor, first.venueId, customer.customerId)).items.map((row) => row.id),
    ).toEqual([own]);
    expect(
      (await listCustomerTopups(db, first.actor, first.venueId, otherCustomerId)).items.map((row) => row.id),
    ).toEqual([other]);
    expect(
      (await listCustomerTopups(db, first.actor, otherVenueId, customer.customerId)).items.map((row) => row.id),
    ).toEqual([otherCampus]);
    for (const cursor of [other, otherCampus, foreign, "missing"])
      await expect(
        listCustomerTopups(db, first.actor, first.venueId, customer.customerId, { cursor }),
      ).rejects.toMatchObject({ code: "INVALID_TOPUP_CURSOR", statusCode: 400 });
    await expect(listCustomerTopups(db, second.actor, first.venueId, customer.customerId)).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
    });
    await expect(listCustomerTopups(db, first.actor, first.venueId, foreignCustomer.id)).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
    });
  });
  it("lets customers read only their own history and never reuses another customer's cursor", async () => {
    const [own, other] = await seedTopups([{}, { customerId: otherCustomerId }]);
    expect(
      (await listCustomerTopups(db, customer, first.venueId, customer.customerId)).items.map((row) => row.id),
    ).toEqual([own]);
    await expect(listCustomerTopups(db, customer, first.venueId, otherCustomerId)).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
    });
    await expect(
      listCustomerTopups(db, customer, first.venueId, customer.customerId, { cursor: other }),
    ).rejects.toMatchObject({ code: "INVALID_TOPUP_CURSOR" });
  });
  it("requires member-management permission and reevaluates campus grants on every page", async () => {
    await seedTopups([{}, {}]);
    const firstPage = await listCustomerTopups(db, first.actor, first.venueId, customer.customerId, { pageSize: 1 });
    await db.query(
      "UPDATE tennis.tenant_memberships SET role='STAFF',all_venues=true,permissions=ARRAY['read','book'] WHERE tenant_id=$1",
      [first.actor.tenantId],
    );
    await expect(
      listCustomerTopups(db, first.actor, first.venueId, customer.customerId, { cursor: firstPage.nextCursor }),
    ).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
    await db.query(
      "UPDATE tennis.tenant_memberships SET all_venues=false,permissions=ARRAY['read','manage_members'] WHERE tenant_id=$1",
      [first.actor.tenantId],
    );
    await db.query("INSERT INTO tennis.membership_venues(tenant_id,subject_id,venue_id) VALUES($1,$2,$3)", [
      first.actor.tenantId,
      first.actor.subjectId,
      first.venueId,
    ]);
    expect((await listCustomerTopups(db, first.actor, first.venueId, customer.customerId)).items).toHaveLength(2);
    await expect(listCustomerTopups(db, first.actor, otherVenueId, customer.customerId)).rejects.toMatchObject({
      code: "TENANT_ACCESS_DENIED",
    });
    await db.query("DELETE FROM tennis.membership_venues WHERE tenant_id=$1 AND subject_id=$2", [
      first.actor.tenantId,
      first.actor.subjectId,
    ]);
    await expect(
      listCustomerTopups(db, first.actor, first.venueId, customer.customerId, { cursor: firstPage.nextCursor }),
    ).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
  });
  it("rejects unsupported query fields and malformed page limits without defaulting to a broader query", async () => {
    for (const input of [
      null,
      [],
      "PENDING",
      { status: "UNKNOWN" },
      { status: ["PENDING"] },
      { pageSize: 0 },
      { pageSize: 101 },
      { pageSize: 1.5 },
      { pageSize: true },
      { pageSize: "1e2" },
      { pageSize: " 1" },
      { pageSize: "01" },
      { cursor: "" },
      { cursor: " " },
      { cursor: 9 },
      { tenantId: second.actor.tenantId },
      { customerId: otherCustomerId },
      { q: "all" },
    ])
      await expect(
        listCustomerTopups(db, first.actor, first.venueId, customer.customerId, input),
      ).rejects.toMatchObject({ code: "INVALID_TOPUP_QUERY", statusCode: 400 });
  });
  it("does not create a wallet, merchant binding or channel operation merely by listing historical intents", async () => {
    await seedTopups([{}, { status: "FAILED" }]);
    const before = await storedFacts();
    expect(
      (await db.query("SELECT 1 FROM tennis.wallet_accounts WHERE tenant_id=$1", [first.actor.tenantId])).rowCount,
    ).toBe(0);
    expect(
      (await db.query("SELECT 1 FROM tennis.channel_operations WHERE tenant_id=$1", [first.actor.tenantId])).rowCount,
    ).toBe(0);
    await readAll({ pageSize: 1 }, customer);
    await listCustomerTopups(db, first.actor, first.venueId, customer.customerId, { status: "FAILED" });
    expect(await storedFacts()).toEqual(before);
  });
  it("returns exact persisted payment facts without settlement, reissue or wallet changes", async () => {
    const payments = [await liveTopup("PENDING"), await liveTopup("FAILED"), await liveTopup("SUCCEEDED")];
    const before = await storedFacts();
    for (const payment of payments) {
      const page = await listCustomerTopups(db, customer, first.venueId, customer.customerId, {
        status: payment.status,
      });
      expect(page).toEqual({ items: [payment], nextCursor: null });
    }
    await readAll({ pageSize: 1 });
    expect(await storedFacts()).toEqual(before);
  });
});
