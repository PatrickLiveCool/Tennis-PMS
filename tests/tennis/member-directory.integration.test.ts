import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { buildTennisServer } from "../../apps/api/src/tennis/server.ts";
import { createLocalAccount, type AccountInput } from "../../packages/db/src/tennis/auth.ts";
import { createCustomer, searchCustomers } from "../../packages/db/src/tennis/customers.ts";
import { getMemberProfile, listMemberDirectory, type MemberDirectoryPage } from "../../packages/db/src/tennis/member-directory.ts";
import { LocalMockPaymentGateway } from "../../packages/db/src/tennis/mock-payments.ts";
import { assertLocalTennisDatabaseUrl, localTennisTestDatabaseUrl } from "../../packages/db/src/tennis/local-config.ts";
import { migrateTennis } from "../../packages/db/src/tennis/migrate.ts";
import { removeTenantFixture, seedTenantFixture, type TenantFixture } from "./tenant-fixture.ts";

const db = new pg.Pool({
  connectionString: assertLocalTennisDatabaseUrl(process.env.TENNIS_TEST_DATABASE_URL ?? localTennisTestDatabaseUrl, "test"),
  max: 8,
  connectionTimeoutMillis: 5000,
  statement_timeout: 10000,
});
let fixture: TenantFixture, other: TenantFixture;
let subjects: string[] = [];
beforeAll(async () => {
  const tx = await db.connect();
  try { await migrateTennis(tx); } finally { tx.release(); }
});
beforeEach(async () => {
  subjects = [];
  fixture = await seedTenantFixture(db);
  other = await seedTenantFixture(db);
});
afterEach(async () => {
  const tenantIds = [fixture.actor.tenantId, other.actor.tenantId];
  await db.query("DELETE FROM tennis.auth_sessions WHERE subject_id=ANY($1::text[]) OR tenant_id=ANY($2::text[])", [subjects, tenantIds]);
  await db.query("DELETE FROM tennis.auth_audit_events WHERE subject_id=ANY($1::text[]) OR tenant_id=ANY($2::text[])", [subjects, tenantIds]);
  await db.query("DELETE FROM tennis.local_accounts WHERE subject_id=ANY($1::text[])", [subjects]);
  await removeTenantFixture(db, fixture);
  await removeTenantFixture(db, other);
  await db.query("DELETE FROM tennis.subjects WHERE id=ANY($1::text[])", [subjects]);
});
afterAll(() => db.end());

async function seedDirectory(count: number) {
  // Repeated names verify that the ID tie-breaker also survives a page boundary.
  const customers = Array.from({ length: count }, (_, index) => ({
    id: randomUUID(), nickname: `会员${String(Math.floor(index / 3)).padStart(3, "0")}`,
    phone: `+86139${String(index).padStart(8, "0")}`,
  }));
  await db.query(
    `INSERT INTO tennis.customers(id,tenant_id,nickname,phone)
     SELECT id,$1,nickname,phone FROM jsonb_to_recordset($2::jsonb) AS records(id text,nickname text,phone text)`,
    [fixture.actor.tenantId, JSON.stringify(customers)],
  );
  return customers;
}

it("walks all 125 members in stable name/ID pages and resolves a profile beyond page one", async () => {
  await seedDirectory(125);
  await createCustomer(db, other.actor, { nickname: "会员000", phone: "13900000000" });
  const expected = (await db.query<{ id: string }>(
    "SELECT id FROM tennis.customers WHERE tenant_id=$1 ORDER BY nickname,id", [fixture.actor.tenantId],
  )).rows.map(({ id }) => id);
  const first = await listMemberDirectory(db, fixture.actor);
  expect(first.customers).toHaveLength(50);
  expect(first.nextCursor).toBeTypeOf("string");
  const second = await listMemberDirectory(db, fixture.actor, { cursor: first.nextCursor });
  expect(second.customers).toHaveLength(50);
  const third = await listMemberDirectory(db, fixture.actor, { cursor: second.nextCursor });
  expect(third.customers).toHaveLength(25);
  expect(third.nextCursor).toBeNull();
  expect([...first.customers, ...second.customers, ...third.customers].map(({ id }) => id)).toEqual(expected);
  expect((await getMemberProfile(db, fixture.actor, expected.at(-1)!)).id).toBe(expected.at(-1));
  expect((await listMemberDirectory(db, fixture.actor, { pageSize: "100" })).customers).toHaveLength(100);
  // The existing picker API keeps its bounded result contract.
  expect(await searchCustomers(db, fixture.actor)).toHaveLength(100);
});

it("searches names and phones literally, trims input, and returns an empty completed page", async () => {
  const literal = await createCustomer(db, fixture.actor, { nickname: "Alice_%教练", phone: "13800138000" });
  await createCustomer(db, fixture.actor, { nickname: "Alice其他", phone: "13900139000" });
  await createCustomer(db, other.actor, { nickname: "Alice_%教练", phone: "13800138000" });
  expect((await listMemberDirectory(db, fixture.actor, { q: "  ALICE_%  " })).customers).toEqual([literal]);
  expect((await listMemberDirectory(db, fixture.actor, { q: "13800138" })).customers).toEqual([literal]);
  expect(await listMemberDirectory(db, fixture.actor, { q: "没有这个会员" })).toEqual({ customers: [], nextCursor: null });
});

it("rejects malformed queries and cursors belonging to another tenant or search", async () => {
  await seedDirectory(3);
  for (const input of [null, [], { pageSize: 0 }, { pageSize: 101 }, { pageSize: 1.5 }, { pageSize: "1e2" },
    { pageSize: [] }, { q: [] }, { q: "x".repeat(201) }, { tenantId: other.actor.tenantId }]) {
    await expect(listMemberDirectory(db, fixture.actor, input)).rejects.toMatchObject({ code: "INVALID_MEMBER_QUERY", statusCode: 400 });
  }
  for (const cursor of ["", "not-a-cursor", [], Buffer.from("null").toString("base64url")]) {
    await expect(listMemberDirectory(db, fixture.actor, { cursor })).rejects.toMatchObject({ code: "INVALID_MEMBER_CURSOR" });
  }
  const { nextCursor: cursor } = await listMemberDirectory(db, fixture.actor, { pageSize: 1 });
  await expect(listMemberDirectory(db, other.actor, { cursor })).rejects.toMatchObject({ code: "INVALID_MEMBER_CURSOR" });
  await expect(listMemberDirectory(db, fixture.actor, { q: "会员", cursor })).rejects.toMatchObject({ code: "INVALID_MEMBER_CURSOR" });
});

it("requires current manage_members permission and hides foreign member profiles", async () => {
  const local = await createCustomer(db, fixture.actor, { nickname: "本租户" });
  const foreign = await createCustomer(db, other.actor, { nickname: "其他租户" });
  await expect(getMemberProfile(db, fixture.actor, foreign.id)).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
  await db.query("UPDATE tennis.tenant_memberships SET role='STAFF',permissions=ARRAY['read','book'],all_venues=false WHERE tenant_id=$1", [fixture.actor.tenantId]);
  await db.query("INSERT INTO tennis.membership_venues(tenant_id,subject_id,venue_id) VALUES($1,$2,$3)", [fixture.actor.tenantId, fixture.actor.subjectId, fixture.venueId]);
  await expect(listMemberDirectory(db, fixture.actor)).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
  await expect(getMemberProfile(db, fixture.actor, local.id)).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
  await db.query("UPDATE tennis.tenant_memberships SET permissions=ARRAY['read','manage_members'] WHERE tenant_id=$1", [fixture.actor.tenantId]);
  expect((await listMemberDirectory(db, fixture.actor)).customers).toEqual([local]);
  expect(await getMemberProfile(db, fixture.actor, local.id)).toEqual(local);
  await db.query("UPDATE tennis.tenant_memberships SET active=false WHERE tenant_id=$1", [fixture.actor.tenantId]);
  await expect(listMemberDirectory(db, fixture.actor)).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
  await expect(getMemberProfile(db, fixture.actor, local.id)).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
});

it("exposes paged and single profiles only to authorized staff at the HTTP boundary", async () => {
  const [local] = await seedDirectory(105);
  const foreign = await createCustomer(db, other.actor, { nickname: "其他租户" });
  const app = await buildTennisServer({
    db, gateway: new LocalMockPaymentGateway("member-directory-synthetic-secret", "local-simulation"),
    allowSimulation: true, runExpiryWorker: false, aiEncryptionKey: Buffer.alloc(32, 7),
  });
  async function signIn(input: Partial<AccountInput>) {
    const credentials = { username: `directory_${randomUUID()}`, password: "directory-synthetic-password-123!", displayName: "会员测试账号", ...input };
    const account = await createLocalAccount(db, credentials);
    subjects.push(account.subjectId);
    const response = await app.inject({ method: "POST", url: "/api/tennis/auth/login", payload: { username: credentials.username, password: credentials.password } });
    expect(response.statusCode, response.body).toBe(200);
    const cookies = response.headers["set-cookie"];
    return (Array.isArray(cookies) ? cookies[0]! : String(cookies)).split(";")[0]!;
  }
  const get = (cookie: string, path: string) => app.inject({ method: "GET", url: `/api/tennis${path}`, headers: { cookie } });
  try {
    const staff = await signIn({ tenantId: fixture.actor.tenantId, role: "STAFF", permissions: ["read", "manage_members"], allVenues: true });
    const picker = await get(staff, "/customers");
    expect(picker.statusCode, picker.body).toBe(200);
    expect(picker.json()).toHaveLength(100);
    const page = await get(staff, "/customers/directory?pageSize=100");
    expect(page.statusCode, page.body).toBe(200);
    const result = page.json<MemberDirectoryPage>();
    expect(result.customers).toHaveLength(100);
    const next = await get(staff, `/customers/directory?cursor=${result.nextCursor}`);
    expect(next.statusCode, next.body).toBe(200);
    expect(next.json<MemberDirectoryPage>().customers).toHaveLength(5);
    const profile = await get(staff, `/customers/${local!.id}`);
    expect(profile.statusCode, profile.body).toBe(200);
    expect(profile.json()).toMatchObject(local!);
    expect((await get(staff, `/customers/${foreign.id}`)).statusCode).toBe(404);
    expect((await get(staff, "/customers/directory?pageSize=101")).statusCode).toBe(400);
    expect((await get(staff, "/customers/directory?cursor=invalid")).statusCode).toBe(400);
    const bookingStaff = await signIn({ tenantId: fixture.actor.tenantId, role: "STAFF", permissions: ["read", "book"], venueIds: [fixture.venueId], allVenues: false });
    const customer = await signIn({ tenantId: fixture.actor.tenantId, customerId: local!.id });
    for (const cookie of [bookingStaff, customer]) {
      expect((await get(cookie, "/customers/directory")).statusCode).toBe(403);
      expect((await get(cookie, `/customers/${local!.id}`)).statusCode).toBe(403);
    }
    expect((await get(customer, "/customers")).json()).toHaveLength(1);
  } finally { await app.close(); }
});
