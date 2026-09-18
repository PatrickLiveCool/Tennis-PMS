import { randomUUID } from "node:crypto";
import pg from "pg";
import type { FastifyInstance, InjectOptions } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildTennisServer } from "../../apps/api/src/tennis/server.ts";
import { createLocalAccount, type AccountInput, type SessionView } from "../../packages/db/src/tennis/auth.ts";
import { createCourt, listVenues, setCourtPrice, updateVenue } from "../../packages/db/src/tennis/catalog.ts";
import { createCustomer } from "../../packages/db/src/tennis/customers.ts";
import { LocalMockPaymentGateway } from "../../packages/db/src/tennis/mock-payments.ts";
import { assertLocalTennisDatabaseUrl, localTennisTestDatabaseUrl } from "../../packages/db/src/tennis/local-config.ts";
import { migrateTennis } from "../../packages/db/src/tennis/migrate.ts";
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
const gateway = new LocalMockPaymentGateway("api-only-synthetic-local-payment-signing-secret", "local-simulation");
const password = "api-synthetic-passphrase-only-492!";
const origin = "http://127.0.0.1:4273";
const key = () => randomUUID();
const hours = Array.from({ length: 7 }, (_, weekday) => ({ weekday, startMinute: 480, endMinute: 1320 }));
interface Client {
  cookie: string;
  session: SessionView;
  app: FastifyInstance;
}
let app: Awaited<ReturnType<typeof buildTennisServer>>;
let first: TenantFixture, second: TenantFixture;
let subjects: string[] = [];
let staff: Client, customer: Client, foreign: Client;
let customerId: string, otherCustomerId: string, courtId: string;
async function account(input: Partial<AccountInput>) {
  const credentials = { username: `api_${key()}`, password, displayName: "API合成账号", ...input };
  const created = await createLocalAccount(db, credentials);
  subjects.push(created.subjectId);
  return credentials;
}
async function signIn(
  credentials: { username: string; password: string },
  server: FastifyInstance = app,
): Promise<Client> {
  const response = await server.inject({
    method: "POST",
    url: "/api/tennis/auth/login",
    headers: { origin },
    payload: { username: credentials.username, password: credentials.password },
  });
  expect(response.statusCode, response.body).toBe(200);
  const cookies = response.headers["set-cookie"];
  const cookie = (Array.isArray(cookies) ? cookies[0]! : String(cookies)).split(";")[0]!;
  expect(cookie).toMatch(/^tennis_session=/);
  return { app: server, cookie, session: response.json<SessionView>() };
}
async function request(
  client: Client,
  method: "GET" | "POST" | "PATCH",
  path: string,
  payload?: unknown,
  headers: Record<string, string> = {},
) {
  const options: InjectOptions = {
    method,
    url: `/api/tennis${path}`,
    headers: {
      cookie: client.cookie,
      origin,
      "x-csrf-token": client.session.csrfToken,
      "x-workspace-version": String(client.session.contextVersion),
      ...headers,
    },
  };
  if (payload !== undefined) options.payload = payload as NonNullable<InjectOptions["payload"]>;
  return client.app.inject(options);
}
async function okay(client: Client, method: "GET" | "POST" | "PATCH", path: string, payload?: unknown) {
  const response = await request(client, method, path, payload);
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}
function selection(profileId = customerId) {
  return {
    venueId: first.venueId,
    customerId: profileId,
    lines: [{ courtId, startAt: "2099-09-18T19:00:00+08:00", endAt: "2099-09-18T20:00:00+08:00" }],
  };
}
async function booking(client = customer, profileId = customerId) {
  const quote = await okay(client, "POST", "/quotes", selection(profileId));
  return okay(client, "POST", `/quotes/${quote.id}/confirm`, { commandKey: key() });
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
  subjects = [];
  first = await seedTenantFixture(db);
  second = await seedTenantFixture(db);
  const venue = (await listVenues(db, first.actor))[0]!;
  await updateVenue(db, first.actor, {
    ...venue,
    expectedRevision: venue.catalogRevision,
    openingHours: hours,
    minimumBookingMinutes: 15,
  });
  const court = await createCourt(db, first.actor, { venueId: first.venueId, name: "API测试球场", indoor: true });
  await setCourtPrice(db, first.actor, {
    venueId: first.venueId,
    courtId: court.id,
    expectedRevision: court.revision,
    hourlyPriceCents: 12000,
  });
  courtId = court.id;
  customerId = (await createCustomer(db, first.actor, { nickname: "本人客户" })).id;
  otherCustomerId = (await createCustomer(db, first.actor, { nickname: "他人私有客户" })).id;
  app = await buildTennisServer({
    db,
    gateway,
    allowSimulation: true,
    runExpiryWorker: false,
    aiEncryptionKey: Buffer.alloc(32, 7),
  });
  staff = await signIn(await account({ tenantId: first.actor.tenantId, role: "ADMIN" }));
  customer = await signIn(await account({ tenantId: first.actor.tenantId, customerId }));
  foreign = await signIn(await account({ tenantId: second.actor.tenantId, role: "ADMIN" }));
});
afterEach(async () => {
  if (app) await app.close();
  const fixtures = [first, second].filter(Boolean);
  const tenantIds = fixtures.map((fixture) => fixture.actor.tenantId);
  await db.query("DELETE FROM tennis.auth_sessions WHERE subject_id=ANY($1::text[]) OR tenant_id=ANY($2::text[])", [
    subjects,
    tenantIds,
  ]);
  await db.query("DELETE FROM tennis.auth_audit_events WHERE subject_id=ANY($1::text[]) OR tenant_id=ANY($2::text[])", [
    subjects,
    tenantIds,
  ]);
  await db.query("DELETE FROM tennis.platform_operators WHERE subject_id=ANY($1::text[])", [subjects]);
  await db.query("DELETE FROM tennis.local_accounts WHERE subject_id=ANY($1::text[])", [subjects]);
  for (const fixture of fixtures) await removeTenantFixture(db, fixture);
  await db.query("DELETE FROM tennis.subjects WHERE id=ANY($1::text[])", [subjects]);
});
afterAll(async () => {
  await db.end();
});

describe("authenticated Tennis HTTP boundary with real PostgreSQL", () => {
  it("searches the full order directory and validates paginated HTTP queries", async () => {
    const old = await booking();
    const seeds = Array.from({ length: 105 }, () => ({ id: key(), quote_id: key() }));
    // Historical rows are isolated to this test tenant and derived from its valid quote.
    await db.query(
      `WITH seed AS (SELECT * FROM jsonb_to_recordset($3::jsonb) AS x(id text,quote_id text)),
      new_quotes AS (
        INSERT INTO tennis.quotes(id,tenant_id,venue_id,customer_id,created_by,price_snapshot,expires_at)
        SELECT s.quote_id,q.tenant_id,q.venue_id,q.customer_id,q.created_by,q.price_snapshot,q.expires_at
        FROM seed s CROSS JOIN tennis.quotes q WHERE q.tenant_id=$1 AND q.id=$2 RETURNING id
      )
      INSERT INTO tennis.orders(id,tenant_id,venue_id,customer_id,quote_id,created_by,status,payment_status,
        total_cents,hold_kind,confirmation_request,price_snapshot)
      SELECT s.id,o.tenant_id,o.venue_id,o.customer_id,q.id,o.created_by,'EXPIRED','UNPAID',
        o.total_cents,'PAYMENT',o.confirmation_request,o.price_snapshot
      FROM seed s JOIN new_quotes q ON q.id=s.quote_id CROSS JOIN tennis.orders o
      WHERE o.tenant_id=$1 AND o.id=$4`,
      [first.actor.tenantId, old.quoteId, JSON.stringify(seeds), old.id],
    );
    const path = `/venues/${first.venueId}/orders`;
    const recent = await okay(staff, "GET", `${path}?pageSize=1`);
    expect(recent.orders).toHaveLength(1);
    expect(recent.orders[0].id).not.toBe(old.id);
    expect(recent.nextCursor).toBe(recent.orders[0].id);
    const next = await okay(staff, "GET", `${path}?pageSize=1&cursor=${recent.nextCursor}`);
    expect(next.orders[0].id).not.toBe(recent.orders[0].id);
    expect(await okay(staff, "GET", `${path}?q=${old.id}`)).toMatchObject({
      orders: [{ id: old.id }],
      nextCursor: null,
    });
    expect(await okay(customer, "GET", `${path}?status=ACTIVE&date=2099-09-18`)).toMatchObject({
      orders: [{ id: old.id, matchingLines: [expect.objectContaining({ id: old.lines[0].id })] }],
      nextCursor: null,
    });
    for (const query of [
      "pageSize=0",
      "pageSize=101",
      "pageSize=2.5",
      "pageSize=1&pageSize=2",
      "q=a&q=b",
      "date=2026-02-30",
      "date=",
      "date=2026-01-01&date=2026-01-02",
      "status=UNKNOWN",
      "status=HELD&status=CONFIRMED",
      "cursor=",
      "cursor=missing",
      "cursor=a&cursor=b",
      "tenantId=override",
    ]) {
      const invalid = await request(staff, "GET", `${path}?${query}`);
      expect(invalid.statusCode, `${query}: ${invalid.body}`).toBe(400);
      expect(invalid.json().error.code).toMatch(/^INVALID_ORDER_(QUERY|CURSOR)$/);
    }
    expect((await request(foreign, "GET", path)).statusCode).toBe(404);
  });

  it("exposes scoped wallet history pagination and rejects invalid page inputs", async () => {
    for (let index = 0; index < 3; index++) {
      await okay(staff, "POST", `/customers/${customerId}/topups/offline`, {
        venueId: first.venueId,
        principalCents: 100,
        giftCents: 20,
        receiptReference: key(),
        reason: "合成翻页核对",
        commandKey: key(),
      });
    }
    const firstPage = await okay(customer, "GET", `/customers/${customerId}/wallet?pageSize=2`);
    expect(firstPage.entries).toHaveLength(2);
    expect(firstPage.nextCursor).toBe(firstPage.entries[1].id);
    const secondPage = await okay(
      customer,
      "GET",
      `/customers/${customerId}/wallet?pageSize=2&cursor=${encodeURIComponent(firstPage.nextCursor)}`,
    );
    expect(secondPage.entries).toHaveLength(1);
    expect(secondPage.nextCursor).toBeNull();
    expect(secondPage.balance).toEqual(firstPage.balance);
    expect(new Set([...firstPage.entries, ...secondPage.entries].map((entry: { id: string }) => entry.id)).size).toBe(
      3,
    );
    expect((await request(customer, "GET", `/customers/${customerId}/wallet?pageSize=201`)).statusCode).toBe(400);
    expect((await request(customer, "GET", `/customers/${customerId}/wallet?cursor=`)).statusCode).toBe(400);
    expect(
      (await request(foreign, "GET", `/customers/${customerId}/wallet?cursor=${firstPage.nextCursor}`)).statusCode,
    ).toBe(404);
  });
  it("recovers online topups from a scoped persistent directory without browser drafts", async () => {
    const quote = await okay(customer, "POST", `/customers/${customerId}/topup-quotes`, {
      venueId: first.venueId,
      principalCents: 2300,
    });
    const payment = await okay(customer, "POST", `/topup-quotes/${quote.id}/confirm`, { commandKey: key() });
    const path = `/venues/${first.venueId}/customers/${customerId}/topups`;
    expect((await okay(customer, "GET", path + "?status=PENDING&pageSize=1")).items).toEqual([
      expect.objectContaining({ id: payment.id, principalCents: 2300, status: "PENDING" }),
    ]);
    expect((await okay(staff, "GET", path)).items[0].id).toBe(payment.id);
    expect(
      (await request(customer, "GET", `/venues/${first.venueId}/customers/${otherCustomerId}/topups`)).statusCode,
    ).toBe(404);
    expect((await request(foreign, "GET", path)).statusCode).toBe(404);
    expect((await request(customer, "GET", path + "?status=PENDING&status=FAILED")).statusCode).toBe(400);
    await okay(customer, "POST", `/topups/${payment.id}/simulate`, { status: "SUCCEEDED" });
    expect((await okay(customer, "GET", path + "?status=PENDING")).items).toHaveLength(0);
    expect((await okay(customer, "GET", path + "?status=SUCCEEDED")).items[0].id).toBe(payment.id);
  });
  it("persists handoff order context and exposes only scoped conversation directory results", async () => {
    const order = await booking();
    const conversation = await okay(customer, "POST", "/assistant/conversations", { venueId: first.venueId });
    const context = { page: "order", orderId: order.id };
    await okay(customer, "POST", `/assistant/conversations/${conversation.id}/handoff`, {
      mode: "HUMAN",
      reason: "合成订单人工接管",
      context,
    });
    const detail = await okay(staff, "GET", `/assistant/conversations/${conversation.id}`);
    expect(detail.latestOrderContext).toMatchObject(context);
    expect(detail.messages.at(-1).context).toEqual(context);
    const path = `/assistant/conversation-directory?venueId=${first.venueId}&mode=HUMAN&q=${order.id}`;
    expect((await okay(staff, "GET", path)).items).toEqual([
      expect.objectContaining({ id: conversation.id, latestOrderId: order.id }),
    ]);
    expect((await okay(customer, "GET", path)).items[0].id).toBe(conversation.id);
    expect((await request(foreign, "GET", path)).statusCode).toBe(404);
    expect((await request(staff, "GET", path + "&pageSize=0")).statusCode).toBe(400);
    expect((await request(staff, "GET", path + `&venueId=${first.venueId}`)).statusCode).toBe(400);
  });
  it("requires a server session and validates CSRF, workspace version and origin without leaking identity secrets", async () => {
    const anonymous = await app.inject({ method: "GET", url: "/api/tennis/venues" });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json().error.code).toBe("SESSION_EXPIRED");
    const credentials = await account({ tenantId: first.actor.tenantId, role: "ADMIN" });
    const loggedIn = await app.inject({
      method: "POST",
      url: "/api/tennis/auth/login",
      payload: { username: credentials.username, password: credentials.password },
    });
    expect(loggedIn.statusCode, loggedIn.body).toBe(200);
    expect(loggedIn.headers["set-cookie"]).toContain("HttpOnly");
    expect(loggedIn.headers["set-cookie"]).toContain("SameSite=Strict");
    expect(loggedIn.json()).not.toHaveProperty("token");
    expect(loggedIn.json()).not.toHaveProperty("sessionId");
    expect(loggedIn.json()).not.toHaveProperty("actor");
    const before = (
      await db.query("SELECT count(*)::int AS count FROM tennis.customers WHERE tenant_id=$1", [first.actor.tenantId])
    ).rows[0].count;
    for (const headers of [{ "x-csrf-token": "" }, { "x-csrf-token": "€".repeat(staff.session.csrfToken.length) }]) {
      const response = await request(staff, "POST", "/customers", { nickname: "拒绝写入" }, headers);
      expect(response.statusCode, response.body).toBe(403);
      expect(response.json().error.code).toBe("CSRF_REJECTED");
    }
    const wrongVersion = await request(
      staff,
      "POST",
      "/customers",
      { nickname: "拒绝写入" },
      { "x-workspace-version": "0" },
    );
    expect(wrongVersion.statusCode).toBe(409);
    expect(wrongVersion.json().error.code).toBe("WORKSPACE_CHANGED");
    const crossOrigin = await request(
      staff,
      "POST",
      "/customers",
      { nickname: "拒绝写入" },
      { origin: "https://untrusted.invalid" },
    );
    expect(crossOrigin.statusCode).toBe(403);
    expect(crossOrigin.json().error.code).toBe("ORIGIN_REJECTED");
    expect(
      (await db.query("SELECT count(*)::int AS count FROM tennis.customers WHERE tenant_id=$1", [first.actor.tenantId]))
        .rows[0].count,
    ).toBe(before);
    const loggedOut = await okay(staff, "POST", "/auth/logout", {});
    expect(loggedOut.ok).toBe(true);
    expect((await request(staff, "GET", "/session")).statusCode).toBe(401);
  });
  it("lets only the platform suspend and restore tenant service without altering existing bookings", async () => {
    const operator = await signIn(await account({ platformOperator: true }));
    const order = await booking();
    const path = `/platform/tenants/${first.actor.tenantId}/status`;
    const suspend = { active: false, expectedActive: true, reason: "试点租户服务暂停" };
    for (const client of [staff, customer, foreign]) {
      const denied = await request(client, "POST", path, suspend);
      expect(denied.statusCode, denied.body).toBe(403);
      expect(denied.json().error.code).toBe("PLATFORM_ACCESS_DENIED");
    }
    const invalid = await request(operator, "POST", path, { active: false, expectedActive: true });
    expect(invalid.statusCode).toBe(400);
    const before = (
      await db.query("SELECT * FROM tennis.orders WHERE tenant_id=$1 AND id=$2", [first.actor.tenantId, order.id])
    ).rows[0];
    const occupancyBefore = (
      await db.query(
        "SELECT * FROM tennis.occupancies WHERE tenant_id=$1 AND order_line_id IN (SELECT id FROM tennis.order_lines WHERE tenant_id=$1 AND order_id=$2) ORDER BY id",
        [first.actor.tenantId, order.id],
      )
    ).rows;
    expect(await okay(operator, "POST", path, suspend)).toMatchObject({ id: first.actor.tenantId, active: false });
    expect((await request(staff, "GET", "/venues")).statusCode).toBe(403);
    expect((await request(customer, "GET", `/orders/${order.id}`)).statusCode).toBe(403);
    const recovery = await okay(staff, "GET", "/session");
    expect(recovery).toMatchObject({ contextValid: false, permissions: [] });
    expect(
      (await request(staff, "POST", "/session/context", { tenantId: first.actor.tenantId, kind: "staff" })).statusCode,
    ).toBe(403);
    expect((await okay(foreign, "GET", "/venues"))[0].id).toBe(second.venueId);
    const stale = await request(operator, "POST", path, suspend);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("STALE_TENANT_STATUS");
    expect(
      await okay(operator, "POST", path, { active: true, expectedActive: false, reason: "恢复试点服务" }),
    ).toMatchObject({ active: true });
    for (const client of [staff, customer]) {
      client.session = await okay(client, "POST", "/session/context", {
        tenantId: first.actor.tenantId,
        kind: client.session.kind,
      });
      expect(client.session.contextValid).toBe(true);
    }
    expect((await okay(customer, "GET", `/orders/${order.id}`)).id).toBe(order.id);
    expect(
      (await db.query("SELECT * FROM tennis.orders WHERE tenant_id=$1 AND id=$2", [first.actor.tenantId, order.id]))
        .rows[0],
    ).toEqual(before);
    expect(
      (
        await db.query(
          "SELECT * FROM tennis.occupancies WHERE tenant_id=$1 AND order_line_id IN (SELECT id FROM tennis.order_lines WHERE tenant_id=$1 AND order_id=$2) ORDER BY id",
          [first.actor.tenantId, order.id],
        )
      ).rows,
    ).toEqual(occupancyBefore);
    expect((await request(operator, "GET", "/venues")).json().error.code).toBe("SELECT_TENANT");
    expect(
      (await request(operator, "POST", "/session/context", { tenantId: first.actor.tenantId, kind: "staff" }))
        .statusCode,
    ).toBe(403);
  });
  it("recovers from a revoked workspace using only the session's remaining valid contexts", async () => {
    await db.query(
      "INSERT INTO tennis.tenant_memberships (tenant_id,subject_id,role,all_venues) VALUES ($1,$2,'VIEWER',true)",
      [second.actor.tenantId, staff.session.subjectId],
    );
    await db.query("UPDATE tennis.tenant_memberships SET active=false WHERE tenant_id=$1 AND subject_id=$2", [
      first.actor.tenantId,
      staff.session.subjectId,
    ]);
    expect((await request(staff, "GET", "/venues")).statusCode).toBe(403);
    const recovery = await okay(staff, "GET", "/session");
    expect(recovery).toMatchObject({ contextValid: false, permissions: [], customerId: null });
    expect(recovery.tenants.map((tenant: { id: string }) => tenant.id)).toEqual([second.actor.tenantId]);
    expect(
      (await request(staff, "POST", "/session/context", { tenantId: first.actor.tenantId, kind: "staff" })).statusCode,
    ).toBe(403);
    const original = { ...staff.session };
    staff.session = await okay(staff, "POST", "/session/context", { tenantId: second.actor.tenantId, kind: "staff" });
    expect(staff.session).toMatchObject({
      contextValid: true,
      tenantId: second.actor.tenantId,
      permissions: ["read"],
      contextVersion: original.contextVersion + 1,
    });
    expect(staff.session.csrfToken).not.toBe(original.csrfToken);
    expect((await okay(staff, "GET", "/venues")).map((venue: { id: string }) => venue.id)).toEqual([second.venueId]);
    const stale = await request(
      staff,
      "POST",
      "/customers",
      { nickname: "旧标签页输入" },
      { "x-csrf-token": original.csrfToken, "x-workspace-version": String(original.contextVersion) },
    );
    expect(stale.statusCode).toBe(403);
    expect(stale.json().error.code).toBe("CSRF_REJECTED");
    const forged = await request(staff, "POST", "/session/context", { tenantId: null, kind: "platform" });
    expect(forged.statusCode).toBe(403);
    expect((await okay(staff, "GET", "/session")).tenantId).toBe(second.actor.tenantId);
  });
  it("rejects request-supplied identities, prices and gift amounts instead of silently trusting or stripping them", async () => {
    const invalidQuote = await request(customer, "POST", "/quotes", {
      ...selection(),
      totalCents: 1,
      actor: first.actor,
    });
    expect(invalidQuote.statusCode).toBe(400);
    expect(invalidQuote.json().error.code).toBe("INVALID_REQUEST");
    const invalidGift = await request(customer, "POST", `/customers/${customerId}/topup-quotes`, {
      venueId: first.venueId,
      principalCents: 1000,
      giftCents: 999999,
    });
    expect(invalidGift.statusCode).toBe(400);
    const quote = await okay(customer, "POST", "/quotes", selection());
    const invalidConfirm = await request(customer, "POST", `/quotes/${quote.id}/confirm`, {
      commandKey: key(),
      totalCents: 1,
    });
    expect(invalidConfirm.statusCode).toBe(400);
    const order = await okay(customer, "POST", `/quotes/${quote.id}/confirm`, { commandKey: key() });
    const invalidPayment = await request(customer, "POST", `/orders/${order.id}/payments`, {
      commandKey: key(),
      walletCents: 0,
      externalCents: 1,
    });
    expect(invalidPayment.statusCode).toBe(400);
    expect(
      (await db.query("SELECT id FROM tennis.payment_attempts WHERE tenant_id=$1", [first.actor.tenantId])).rowCount,
    ).toBe(0);
    expect((await okay(customer, "GET", `/orders/${order.id}`)).totalCents).toBe(12000);
  });
  it("enforces tenant and customer ownership on bookings, wallets, payment state and customer records", async () => {
    const otherOrder = await booking(staff, otherCustomerId);
    expect((await request(foreign, "GET", `/orders/${otherOrder.id}`)).statusCode).toBe(404);
    expect((await request(foreign, "GET", `/venues/${first.venueId}/courts`)).statusCode).toBe(404);
    expect((await request(customer, "GET", `/orders/${otherOrder.id}`)).statusCode).toBe(404);
    expect((await request(customer, "GET", `/customers/${otherCustomerId}/wallet`)).statusCode).toBe(404);
    expect((await okay(customer, "GET", "/customers")).map((profile: { id: string }) => profile.id)).toEqual([
      customerId,
    ]);
    const impersonated = await request(customer, "POST", "/quotes", selection(otherCustomerId));
    expect(impersonated.statusCode).toBe(404);
    const otherPayment = await okay(staff, "POST", `/orders/${otherOrder.id}/payments`, {
      commandKey: key(),
      walletCents: 0,
    });
    expect((await request(customer, "GET", `/payments/${otherPayment.id}`)).statusCode).toBe(404);
    expect(
      (await request(foreign, "POST", `/payments/${otherPayment.id}/simulate`, { status: "SUCCEEDED" })).statusCode,
    ).toBe(404);
    const schedule = await okay(customer, "GET", `/venues/${first.venueId}/schedule?date=2099-09-18`);
    expect(schedule.occupancies).toHaveLength(1);
    expect(schedule.occupancies[0]).toMatchObject({
      kind: "OCCUPIED",
      orderId: null,
      customerName: null,
      status: "OCCUPIED",
    });
    expect(JSON.stringify(schedule)).not.toContain(otherCustomerId);
    expect(JSON.stringify(schedule)).not.toContain("他人私有客户");
  });
  it("lets booking-only staff find a minimal customer identity without gaining wallet or tenant-wide profile access", async () => {
    await db.query("UPDATE tennis.customers SET phone='+8613800000001' WHERE tenant_id=$1 AND id=$2", [
      first.actor.tenantId,
      customerId,
    ]);
    await db.query(
      "UPDATE tennis.tenant_memberships SET role='STAFF',all_venues=true,permissions=ARRAY['read','book'] WHERE tenant_id=$1 AND subject_id=$2",
      [first.actor.tenantId, staff.session.subjectId],
    );
    const found = await okay(staff, "GET", `/venues/${first.venueId}/booking-customers?q=13800000001`);
    expect(found).toEqual([
      { id: customerId, tenantId: first.actor.tenantId, nickname: "本人客户", phone: null, active: true },
    ]);
    expect((await request(staff, "GET", "/customers")).statusCode).toBe(403);
    expect((await request(staff, "GET", `/customers/${customerId}/wallet`)).statusCode).toBe(403);
    const quote = await okay(staff, "POST", "/quotes", selection(found[0].id));
    expect((await okay(staff, "POST", `/quotes/${quote.id}/confirm`, { commandKey: key() })).customerId).toBe(
      customerId,
    );
    expect(
      (await okay(customer, "GET", `/venues/${first.venueId}/booking-customers`)).map(
        (profile: { id: string }) => profile.id,
      ),
    ).toEqual([customerId]);
    expect(
      await okay(customer, "GET", `/venues/${first.venueId}/booking-customers?q=${encodeURIComponent("他人")}`),
    ).toEqual([]);
    expect((await request(foreign, "GET", `/venues/${first.venueId}/booking-customers`)).statusCode).toBe(404);
    await db.query("UPDATE tennis.tenant_memberships SET all_venues=false WHERE tenant_id=$1 AND subject_id=$2", [
      first.actor.tenantId,
      staff.session.subjectId,
    ]);
    expect((await request(staff, "GET", `/venues/${first.venueId}/booking-customers`)).statusCode).toBe(403);
    await db.query("INSERT INTO tennis.membership_venues (tenant_id,subject_id,venue_id) VALUES ($1,$2,$3)", [
      first.actor.tenantId,
      staff.session.subjectId,
      first.venueId,
    ]);
    expect(await okay(staff, "GET", `/venues/${first.venueId}/booking-customers`)).toHaveLength(2);
  });
  it("completes quoted booking, balance plus simulated cash payment and authorized original-source refund", async () => {
    await okay(staff, "POST", `/customers/${customerId}/topups/offline`, {
      venueId: first.venueId,
      principalCents: 5000,
      giftCents: 1000,
      receiptReference: key(),
      reason: "合成线下实收",
      commandKey: key(),
    });
    const quote = await okay(customer, "POST", "/quotes", selection());
    expect(quote.price.totalCents).toBe(12000);
    const confirmKey = key();
    const order = await okay(customer, "POST", `/quotes/${quote.id}/confirm`, { commandKey: confirmKey });
    expect(order).toMatchObject({ status: "HELD", paymentStatus: "UNPAID", totalCents: 12000 });
    expect((await okay(customer, "POST", `/quotes/${quote.id}/confirm`, { commandKey: confirmKey })).id).toBe(order.id);
    const paymentKey = key();
    const payment = await okay(customer, "POST", `/orders/${order.id}/payments`, {
      commandKey: paymentKey,
      walletCents: 6000,
    });
    expect(payment).toMatchObject({ status: "PENDING", provider: "MOCK", walletCents: 6000, externalCents: 6000 });
    expect((await okay(customer, "GET", `/customers/${customerId}/wallet`)).balance).toMatchObject({
      availableCents: 0,
      reservedCents: 6000,
      totalCents: 6000,
    });
    expect(
      (await okay(customer, "POST", `/orders/${order.id}/payments`, { commandKey: paymentKey, walletCents: 6000 })).id,
    ).toBe(payment.id);
    const captured = await okay(customer, "POST", `/payments/${payment.id}/simulate`, { status: "SUCCEEDED" });
    expect(captured.status).toBe("SUCCEEDED");
    await okay(customer, "POST", `/payments/${payment.id}/simulate`, { status: "SUCCEEDED" });
    const paid = await okay(customer, "GET", `/orders/${order.id}`);
    expect(paid).toMatchObject({ status: "CONFIRMED", paymentStatus: "PAID" });
    expect((await okay(customer, "GET", `/customers/${customerId}/wallet`)).balance).toMatchObject({
      totalCents: 0,
      reservedCents: 0,
    });
    const refundInput = {
      expectedRevision: paid.revision,
      reason: "授权员工确认雨天全退",
      commandKey: key(),
      lines: [{ lineId: paid.lines[0].id, refundCents: 12000, cancel: true }],
    };
    expect((await request(customer, "POST", `/orders/${paid.id}/refunds`, refundInput)).statusCode).toBe(403);
    const group = await okay(staff, "POST", `/orders/${paid.id}/refunds`, refundInput);
    expect(group).toMatchObject({ status: "REQUESTED", amountCents: 12000 });
    expect(group.refunds).toHaveLength(1);
    const refund = group.refunds[0];
    expect(refund).toMatchObject({ status: "REQUESTED", amountCents: 12000, walletCents: 6000, externalCents: 6000 });
    expect((await okay(customer, "GET", `/customers/${customerId}/wallet`)).balance.totalCents).toBe(0);
    expect((await okay(staff, "POST", `/refunds/${refund.id}/simulate`, { status: "SUCCEEDED" })).status).toBe(
      "SUCCEEDED",
    );
    await okay(staff, "POST", `/refunds/${refund.id}/simulate`, { status: "SUCCEEDED" });
    expect(await okay(customer, "GET", `/orders/${paid.id}`)).toMatchObject({
      status: "CANCELLED",
      paymentStatus: "REFUNDED",
    });
    expect((await okay(customer, "GET", `/customers/${customerId}/wallet`)).balance).toMatchObject({
      totalCents: 6000,
      principalCents: 5000,
      giftCents: 1000,
      reservedCents: 0,
    });
    expect(
      (
        await db.query("SELECT transaction_id FROM tennis.external_payment_receipts WHERE tenant_id=$1", [
          first.actor.tenantId,
        ])
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await db.query("SELECT provider_refund_id FROM tennis.external_refund_receipts WHERE tenant_id=$1", [
          first.actor.tenantId,
        ])
      ).rowCount,
    ).toBe(1);
  });
  it("prevents read-only staff from settling simulated payments while retaining customer ownership checks", async () => {
    const order = await booking();
    const payment = await okay(customer, "POST", `/orders/${order.id}/payments`, { commandKey: key(), walletCents: 0 });
    await db.query(
      "UPDATE tennis.tenant_memberships SET role='VIEWER',permissions=ARRAY['read'] WHERE tenant_id=$1 AND subject_id=$2",
      [first.actor.tenantId, staff.session.subjectId],
    );
    expect((await okay(staff, "GET", `/payments/${payment.id}`)).status).toBe("PENDING");
    for (const status of ["SUCCEEDED", "FAILED"]) {
      const rejected = await request(staff, "POST", `/payments/${payment.id}/simulate`, { status });
      expect(rejected.statusCode, rejected.body).toBe(403);
      expect(rejected.json().error.code).toBe("TENANT_ACCESS_DENIED");
    }
    expect(await okay(customer, "GET", `/orders/${order.id}`)).toMatchObject({
      status: "HELD",
      paymentStatus: "UNPAID",
    });
    expect((await okay(customer, "GET", `/payments/${payment.id}`)).status).toBe("PENDING");
    expect((await okay(customer, "POST", `/payments/${payment.id}/simulate`, { status: "SUCCEEDED" })).status).toBe(
      "SUCCEEDED",
    );
    expect(await okay(customer, "GET", `/orders/${order.id}`)).toMatchObject({
      status: "CONFIRMED",
      paymentStatus: "PAID",
    });
  });
  it("keeps the simulation route unavailable when this capability is disabled", async () => {
    const order = await booking();
    const payment = await okay(customer, "POST", `/orders/${order.id}/payments`, { commandKey: key(), walletCents: 0 });
    const locked = await buildTennisServer({ db, gateway, allowSimulation: false, runExpiryWorker: false });
    try {
      const lockedClient = { ...customer, app: locked };
      const response = await request(lockedClient, "POST", `/payments/${payment.id}/simulate`, { status: "SUCCEEDED" });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe("SIMULATION_DISABLED");
      expect((await okay(customer, "GET", `/payments/${payment.id}`)).status).toBe("PENDING");
      expect((await okay(lockedClient, "GET", "/session")).localSimulation).toBe(false);
    } finally {
      await locked.close();
    }
  });
  it("exposes durable channel state and accepts only a signed raw notification for that operation", async () => {
    const order = await booking();
    const payment = await okay(customer, "POST", `/orders/${order.id}/payments`, { walletCents: 0, commandKey: key() });
    const ready = await okay(customer, "GET", `/payments/${payment.id}/channel`);
    expect(ready.state).toBe("READY");
    expect((await request(foreign, "GET", `/payments/${payment.id}/channel`)).statusCode).toBe(404);
    const pending = await okay(customer, "POST", `/payments/${payment.id}/channel/reconcile`, {});
    expect(pending.state).toBe("PENDING");
    expect(pending.checkout).toMatchObject({ kind: "LOCAL_SIMULATION", operationId: ready.operationId });
    const payload = {
      provider: "MOCK" as const,
      operationId: ready.operationId,
      paymentId: payment.id,
      merchantId: payment.merchantId,
      eventId: key(),
      transactionId: key(),
      status: "SUCCEEDED" as const,
      amountCents: payment.externalCents,
      currency: "CNY" as const,
      issuedAt: Date.now(),
    };
    const signed = gateway.signForLocalSimulator(payload);
    const url = `/api/tennis/payment-notifications/${ready.operationId}`;
    expect(
      (await app.inject({ method: "POST", url, headers: { "content-type": "application/json" }, payload: signed.body }))
        .statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          headers: { "content-type": "application/json", "x-mock-signature": signed.signature },
          payload: signed.body,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          headers: { "content-type": "application/json", "x-mock-signature": signed.signature },
          payload: signed.body,
        })
      ).statusCode,
    ).toBe(200);
    expect((await okay(customer, "GET", `/payments/${payment.id}`)).status).toBe("SUCCEEDED");
    expect((await okay(customer, "GET", `/payments/${payment.id}/channel`)).state).toBe("SUCCEEDED");
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          headers: { "content-type": "application/json", "x-mock-signature": signed.signature },
          payload: signed.body + " ",
        })
      ).statusCode,
    ).toBe(409);
  });
  it("lets authorized staff refund verified unused cash and closes the exception only after channel success", async () => {
    const order = await booking();
    const payment = await okay(customer, "POST", `/orders/${order.id}/payments`, { walletCents: 0, commandKey: key() });
    await okay(customer, "POST", `/orders/${order.id}/cancel`, {
      expectedRevision: order.revision,
      reason: "合成取消后迟到付款",
      commandKey: key(),
    });
    expect((await okay(customer, "POST", `/payments/${payment.id}/simulate`, { status: "SUCCEEDED" })).status).toBe(
      "REFUND_REQUIRED",
    );
    const exceptionId = (
      await db.query<{ id: string }>(
        "SELECT id FROM tennis.financial_exceptions WHERE tenant_id=$1 AND payment_id=$2",
        [first.actor.tenantId, payment.id],
      )
    ).rows[0]!.id;
    expect((await request(customer, "GET", `/cash-exceptions/${exceptionId}`)).statusCode).toBe(403);
    expect((await request(foreign, "GET", `/cash-exceptions/${exceptionId}`)).statusCode).toBe(404);
    const detail = await okay(staff, "GET", `/cash-exceptions/${exceptionId}`);
    expect(detail).toMatchObject({ status: "OPEN", amountCents: 12000, refund: null });
    expect(
      (
        await request(staff, "POST", `/cash-exceptions/${exceptionId}/refund`, {
          amountCents: 11999,
          reason: "合成金额错误",
          commandKey: key(),
        })
      ).statusCode,
    ).toBe(409);
    const input = { amountCents: detail.amountCents, reason: "已核对合成迟到实收，原额原路退回", commandKey: key() };
    const refund = await okay(staff, "POST", `/cash-exceptions/${exceptionId}/refund`, input);
    expect((await okay(staff, "POST", `/cash-exceptions/${exceptionId}/refund`, input)).id).toBe(refund.id);
    expect((await okay(customer, "GET", `/exception-refunds/${refund.id}`)).id).toBe(refund.id);
    expect((await request(customer, "POST", `/exception-refunds/${refund.id}/channel/reconcile`, {})).statusCode).toBe(
      403,
    );
    expect((await okay(staff, "POST", `/exception-refunds/${refund.id}/channel/reconcile`, {})).state).toBe("PENDING");
    expect((await okay(staff, "POST", `/exception-refunds/${refund.id}/simulate`, { status: "FAILED" })).status).toBe(
      "FAILED",
    );
    expect((await okay(staff, "GET", `/cash-exceptions/${exceptionId}`)).status).toBe("OPEN");
    await okay(staff, "POST", `/exception-refunds/${refund.id}/retry`, { commandKey: key() });
    expect(
      (await okay(staff, "POST", `/exception-refunds/${refund.id}/simulate`, { status: "SUCCEEDED" })).status,
    ).toBe("SUCCEEDED");
    expect(await okay(staff, "GET", `/cash-exceptions/${exceptionId}`)).toMatchObject({
      status: "RESOLVED",
      refund: { id: refund.id, status: "SUCCEEDED" },
    });
    expect((await okay(customer, "GET", `/orders/${order.id}`)).status).toBe("CANCELLED");
    const date = (
      await db.query<{ date: string }>(
        "SELECT to_char(clock_timestamp() AT TIME ZONE timezone,'YYYY-MM-DD') AS date FROM tennis.venues WHERE id=$1",
        [first.venueId],
      )
    ).rows[0]!.date;
    const ledger = await okay(staff, "GET", `/venues/${first.venueId}/finance?date=${date}`);
    expect(ledger.exceptions).toEqual([]);
    expect(ledger.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "EXCEPTION_REFUND",
          cashCents: -12000,
          walletCents: 0,
          referenceId: exceptionId,
        }),
      ]),
    );
  });
});
