import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { buildTennisServer } from "../../apps/api/src/tennis/server.ts";
import { createLocalAccount, type AccountInput, type SessionView } from "../../packages/db/src/tennis/auth.ts";
import { getCommandReceipt } from "../../packages/db/src/tennis/booking.ts";
import { correctCustomerContact, type CustomerContactCorrectionInput } from "../../packages/db/src/tennis/customer-contact-correction.ts";
import { createCustomer, type CustomerRecord } from "../../packages/db/src/tennis/customers.ts";
import { LocalMockPaymentGateway } from "../../packages/db/src/tennis/mock-payments.ts";
import { assertLocalTennisDatabaseUrl, localTennisTestDatabaseUrl } from "../../packages/db/src/tennis/local-config.ts";
import { migrateTennis } from "../../packages/db/src/tennis/migrate.ts";
import { recordOfflineTopup } from "../../packages/db/src/tennis/wallet.ts";
import { removeTenantFixture, seedTenantFixture, type TenantFixture } from "./tenant-fixture.ts";

const db = new pg.Pool({ connectionString: assertLocalTennisDatabaseUrl(
  process.env.TENNIS_TEST_DATABASE_URL ?? localTennisTestDatabaseUrl, "test"), max: 8,
  connectionTimeoutMillis: 5000, statement_timeout: 10000 });
let fixture: TenantFixture, other: TenantFixture, customer: CustomerRecord;
let subjects: string[] = [];
beforeAll(async () => { const tx = await db.connect(); try { await migrateTennis(tx); } finally { tx.release(); } });
beforeEach(async () => {
  subjects = [];
  fixture = await seedTenantFixture(db); other = await seedTenantFixture(db);
  customer = await createCustomer(db, fixture.actor, { nickname: "合成待纠错会员", phone: "13800000001" });
});
afterEach(async () => {
  const tenantIds = [fixture.actor.tenantId, other.actor.tenantId];
  await db.query("DELETE FROM tennis.auth_sessions WHERE subject_id=ANY($1::text[]) OR tenant_id=ANY($2::text[])", [subjects, tenantIds]);
  await db.query("DELETE FROM tennis.auth_audit_events WHERE subject_id=ANY($1::text[]) OR tenant_id=ANY($2::text[])", [subjects, tenantIds]);
  await db.query("DELETE FROM tennis.local_accounts WHERE subject_id=ANY($1::text[])", [subjects]);
  await removeTenantFixture(db, fixture); await removeTenantFixture(db, other);
  await db.query("DELETE FROM tennis.subjects WHERE id=ANY($1::text[])", [subjects]);
});
afterAll(() => db.end());
function input(overrides: Partial<CustomerContactCorrectionInput> = {}): CustomerContactCorrectionInput {
  return { venueId: fixture.venueId, customerId: customer.id, commandKey: randomUUID(),
    expectedPhone: customer.phone, phone: "13900000001", reason: "客户确认原手机号录入有误", ...overrides };
}
async function audits() {
  return (await db.query("SELECT subject_id,resource_id,details FROM tennis.audit_events WHERE tenant_id=$1 AND action='customer.contact.correct'", [fixture.actor.tenantId])).rows;
}

it("normalizes numbers, replays concurrent commands once and recovers the original receipt after later changes", async () => {
  const request = input({ phone: "+86 139-0000-0001", reason: "  客户当面纠错  " });
  const [one, two] = await Promise.all([correctCustomerContact(db, fixture.actor, request), correctCustomerContact(db, fixture.actor, request)]);
  expect(one).toEqual(two);
  expect(one.customer).toEqual({ ...customer, phone: "+8613900000001" });
  expect(await audits()).toEqual([{ subject_id: fixture.actor.subjectId, resource_id: customer.id,
    details: { venueId: fixture.venueId, previousPhone: customer.phone, phone: "+8613900000001", reason: "客户当面纠错" } }]);
  await correctCustomerContact(db, fixture.actor, input({ expectedPhone: one.customer.phone, phone: "13700000001" }));
  expect(await correctCustomerContact(db, fixture.actor, { ...request, phone: "13900000001", reason: "客户当面纠错" })).toEqual(one);
  expect((await getCommandReceipt(db, fixture.actor, request.commandKey))?.result).toEqual(one);
  await expect(correctCustomerContact(db, fixture.actor, { ...request, phone: "13600000001" })).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  expect((await db.query("SELECT phone FROM tennis.customers WHERE id=$1", [customer.id])).rows[0].phone).toBe("+8613700000001");
});

it("rejects stale concurrent editors without overriding the winner or leaving a losing receipt", async () => {
  const requests = [input(), input({ phone: "13700000001" })];
  const results = await Promise.allSettled(requests.map((request) => correctCustomerContact(db, fixture.actor, request)));
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  const loser = results.findIndex((result) => result.status === "rejected");
  expect((results[loser] as PromiseRejectedResult).reason).toMatchObject({ code: "STALE_CUSTOMER_CONTACT" });
  expect(await getCommandReceipt(db, fixture.actor, requests[loser]!.commandKey)).toBeNull();
  expect(await audits()).toHaveLength(1);
});

it("rejects duplicate, invalid and unchanged contacts without mutations; accepts a missing old phone", async () => {
  await createCustomer(db, fixture.actor, { nickname: "已有手机号", phone: "13900000001" });
  await expect(correctCustomerContact(db, fixture.actor, input())).rejects.toMatchObject({ code: "PHONE_ALREADY_EXISTS" });
  for (const patch of [{ phone: "" }, { phone: "+12025550123" }, { phone: "123" }, { reason: "  " }, { reason: "x".repeat(2001) }])
    await expect(correctCustomerContact(db, fixture.actor, input(patch))).rejects.toMatchObject({ code: "INVALID_CONTACT_CORRECTION" });
  await expect(correctCustomerContact(db, fixture.actor, input({ phone: "13800000001" }))).rejects.toMatchObject({ code: "CUSTOMER_CONTACT_UNCHANGED" });
  expect(await audits()).toEqual([]);
  expect((await db.query("SELECT command_key FROM tennis.command_receipts WHERE tenant_id=$1", [fixture.actor.tenantId])).rows).toEqual([]);
  const empty = await createCustomer(db, fixture.actor, { nickname: "历史缺失联系人" });
  expect((await correctCustomerContact(db, fixture.actor, input({ customerId: empty.id, expectedPhone: null, phone: "13700000001" }))).customer.phone).toBe("+8613700000001");
  // Tenant isolation permits the same phone in an unrelated tenant.
  const foreign = await createCustomer(db, other.actor, { nickname: "另一租户", phone: "13700000001" });
  expect(foreign.id).not.toBe(empty.id);
});

it("preserves customer identity, account, wallet, order and channel binding, even if the old phone is reused", async () => {
  await db.query("UPDATE tennis.customers SET subject_id=$2 WHERE id=$1", [customer.id, fixture.actor.subjectId]);
  await recordOfflineTopup(db, fixture.actor, { venueId: fixture.venueId, customerId: customer.id, commandKey: randomUUID(),
    principalCents: 10000, giftCents: 2000, receiptReference: randomUUID(), reason: "合成已收款" });
  const quoteId = randomUUID(), orderId = randomUUID(), integrationId = randomUUID(), bindingId = randomUUID();
  await db.query("INSERT INTO tennis.quotes(id,tenant_id,venue_id,customer_id,created_by,price_snapshot,expires_at) VALUES($1,$2,$3,$4,$5,'{}','2099-01-01')", [quoteId, fixture.actor.tenantId, fixture.venueId, customer.id, fixture.actor.subjectId]);
  await db.query(`INSERT INTO tennis.orders(id,tenant_id,venue_id,customer_id,quote_id,created_by,status,payment_status,total_cents,hold_kind,confirmation_request,price_snapshot)
    VALUES($1,$2,$3,$4,$5,$6,'CONFIRMED','NOT_REQUIRED',0,'PAYMENT','{}','{}')`, [orderId, fixture.actor.tenantId, fixture.venueId, customer.id, quoteId, fixture.actor.subjectId]);
  await db.query("INSERT INTO tennis.gateway_integrations(id,tenant_id,name,token_hash,created_by) VALUES($1,$2,'合成渠道',$3,$4)", [integrationId, fixture.actor.tenantId, randomUUID(), fixture.actor.subjectId]);
  await db.query(`INSERT INTO tennis.gateway_bindings(id,tenant_id,integration_id,external_subject,subject_id,customer_id,actor_kind,created_by,reason)
    VALUES($1,$2,$3,'synthetic-external-user',$4,$5,'customer',$4,'人工已核验')`, [bindingId, fixture.actor.tenantId, integrationId, fixture.actor.subjectId, customer.id]);
  async function references() {
    const snapshots: Record<string, unknown> = {};
    for (const table of ["wallet_accounts", "wallet_batches", "wallet_entries", "orders", "gateway_bindings"])
      snapshots[table] = (await db.query(`SELECT * FROM tennis.${table} WHERE tenant_id=$1`, [fixture.actor.tenantId])).rows;
    return snapshots;
  }
  const before = await references();
  await correctCustomerContact(db, fixture.actor, input());
  const replacement = await createCustomer(db, fixture.actor, { nickname: "另一位新客户", phone: customer.phone });
  expect(await references()).toEqual(before);
  expect((await db.query("SELECT id,subject_id FROM tennis.customers WHERE id=ANY($1::text[]) ORDER BY id", [[customer.id, replacement.id]])).rows)
    .toEqual(expect.arrayContaining([{ id: customer.id, subject_id: fixture.actor.subjectId }, { id: replacement.id, subject_id: null }]));
});

it("rechecks staff, tenant, venue and manage_members permission on correction and receipt recovery", async () => {
  const foreign = await createCustomer(db, other.actor, { nickname: "其他租户" });
  await expect(correctCustomerContact(db, fixture.actor, input({ customerId: foreign.id }))).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
  await expect(correctCustomerContact(db, fixture.actor, input({ venueId: other.venueId }))).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
  await db.query("UPDATE tennis.customers SET subject_id=$2 WHERE id=$1", [customer.id, fixture.actor.subjectId]);
  const customerActor = { ...fixture.actor, kind: "customer" as const, customerId: customer.id };
  await expect(correctCustomerContact(db, customerActor, input())).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
  await db.query("UPDATE tennis.tenant_memberships SET role='STAFF',permissions=ARRAY['read','manage_members'],all_venues=false WHERE tenant_id=$1", [fixture.actor.tenantId]);
  await expect(correctCustomerContact(db, fixture.actor, input())).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
  await db.query("INSERT INTO tennis.membership_venues(tenant_id,subject_id,venue_id) VALUES($1,$2,$3)", [fixture.actor.tenantId, fixture.actor.subjectId, fixture.venueId]);
  const request = input();
  await correctCustomerContact(db, fixture.actor, request);
  await expect(getCommandReceipt(db, customerActor, request.commandKey)).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
  await db.query("UPDATE tennis.tenant_memberships SET permissions=ARRAY['read','book'] WHERE tenant_id=$1", [fixture.actor.tenantId]);
  await expect(correctCustomerContact(db, fixture.actor, request)).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
  await expect(getCommandReceipt(db, fixture.actor, request.commandKey)).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
  expect(await audits()).toHaveLength(1);
});

it("rolls back the contact and receipt if audit persistence fails", async () => {
  const failingPool = { connect: async () => {
    const tx = await db.connect();
    return new Proxy(tx, { get(target, property) {
      if (property === "query") return (query: string, values?: unknown[]) => query.includes("INSERT INTO tennis.audit_events")
        ? Promise.reject(new Error("synthetic audit persistence failure")) : target.query(query, values);
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    } });
  } } as unknown as pg.Pool;
  const request = input();
  await expect(correctCustomerContact(failingPool, fixture.actor, request)).rejects.toThrow("synthetic audit persistence failure");
  expect((await db.query("SELECT phone FROM tennis.customers WHERE id=$1", [customer.id])).rows[0].phone).toBe(customer.phone);
  expect(await getCommandReceipt(db, fixture.actor, request.commandKey)).toBeNull();
  expect(await audits()).toEqual([]);
  expect((await correctCustomerContact(db, fixture.actor, request)).customer.phone).toBe("+8613900000001");
});

it("enforces schema, CSRF and authenticated staff permissions at the real HTTP boundary", async () => {
  const app = await buildTennisServer({ db, gateway: new LocalMockPaymentGateway("contact-correction-synthetic-secret", "local-simulation"),
    allowSimulation: true, runExpiryWorker: false, aiEncryptionKey: Buffer.alloc(32, 7) });
  async function signIn(input: Partial<AccountInput>) {
    const credentials = { username: `contact_${randomUUID()}`, password: "contact-synthetic-password-123!", displayName: "合成纠错账号", ...input };
    const account = await createLocalAccount(db, credentials); subjects.push(account.subjectId);
    const response = await app.inject({ method: "POST", url: "/api/tennis/auth/login", payload: { username: credentials.username, password: credentials.password } });
    expect(response.statusCode, response.body).toBe(200);
    const session = response.json<SessionView>();
    return { cookie: String(response.headers["set-cookie"]).split(";")[0]!, "x-csrf-token": session.csrfToken,
      "x-workspace-version": String(session.contextVersion) };
  }
  try {
    const staff = await signIn({ tenantId: fixture.actor.tenantId, role: "STAFF", permissions: ["read", "manage_members"], allVenues: true });
    const bookingStaff = await signIn({ tenantId: fixture.actor.tenantId, role: "STAFF", permissions: ["read", "book"], allVenues: true });
    const customerSession = await signIn({ tenantId: fixture.actor.tenantId, customerId: customer.id });
    const { customerId: _, ...payload } = input();
    const url = `/api/tennis/customers/${customer.id}/contact-corrections`;
    for (const headers of [bookingStaff, customerSession]) expect((await app.inject({ method: "POST", url, headers, payload })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url, headers: { ...staff, "x-csrf-token": "" }, payload })).statusCode).toBe(403);
    for (const malformed of [{ ...payload, tenantId: other.actor.tenantId }, { ...payload, expectedPhone: undefined }, { ...payload, reason: undefined }])
      expect((await app.inject({ method: "POST", url, headers: staff, payload: malformed })).statusCode).toBe(400);
    const response = await app.inject({ method: "POST", url, headers: staff, payload });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().customer).toMatchObject({ id: customer.id, phone: "+8613900000001" });
    expect((await app.inject({ method: "POST", url, headers: staff, payload })).json()).toEqual(response.json());
    expect((await app.inject({ method: "GET", url: `/api/tennis/receipts/${payload.commandKey}`, headers: staff })).json().result).toEqual(response.json());
  } finally { await app.close(); }
});
