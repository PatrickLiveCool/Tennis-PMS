import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertLocalTennisDatabaseUrl, localTennisTestDatabaseUrl } from "../../packages/db/src/tennis/local-config.ts";
import { migrateTennis } from "../../packages/db/src/tennis/migrate.ts";
import type { TenantActor } from "../../packages/db/src/tennis/access.ts";
import { createCustomer, type CustomerActor } from "../../packages/db/src/tennis/customers.ts";
import { listOrders } from "../../packages/db/src/tennis/booking.ts";
import { beginTopupPayment, createTopupQuote } from "../../packages/db/src/tennis/topups.ts";
import { createLocalAccount, type SessionView } from "../../packages/db/src/tennis/auth.ts";
import { createConversation, getConversation, getConversationRequest, handoffConversation, issueDelegation, resolveDelegation } from "../../packages/db/src/tennis/external-agent.ts";
import {
  completeGatewayMessage,
  createGatewayBinding,
  createTenantGatewayIntegration,
  grantGatewayMessage,
  listTenantGatewayIntegrations,
  receiveGatewayMessage,
  resolveGatewayIdentity,
  updateTenantGatewayIntegration,
  type GatewayPrincipal,
} from "../../packages/db/src/tennis/gateway.ts";
import { LocalMockPaymentGateway } from "../../packages/db/src/tennis/mock-payments.ts";
import { buildTennisServer } from "../../apps/api/src/tennis/server.ts";
import { removeTenantFixture, seedTenantFixture, syntheticPhone, type TenantFixture } from "./tenant-fixture.ts";

const db = new pg.Pool({
  connectionString: assertLocalTennisDatabaseUrl(process.env.TENNIS_TEST_DATABASE_URL ?? localTennisTestDatabaseUrl, "test"),
  max: 8, connectionTimeoutMillis: 5000, statement_timeout: 10000,
});
const encryptionKey = Buffer.alloc(32, 7);
const gateway = new LocalMockPaymentGateway("gateway-management-synthetic-payment-secret", "local-simulation");
const key = () => randomUUID();
const externalSubjectId = "verified-management-customer";
const daysBetween = (end: unknown, start: unknown) => (new Date(String(end)).getTime() - new Date(String(start)).getTime()) / 86400000;
let first: TenantFixture, second: TenantFixture, customer: CustomerActor, staff: TenantActor;
let integration: Awaited<ReturnType<typeof createTenantGatewayIntegration>>, principal: GatewayPrincipal;
let extraSubjects: string[], accountSubjects: string[];
const incoming = (externalMessageId = "original-message") => ({
  externalConversationId: "management-conversation", externalMessageId,
  venueId: first.venueId, content: "请查一下我的预约",
});
async function granted() {
  const received = await receiveGatewayMessage(db, principal, incoming());
  const grant = await grantGatewayMessage(db, principal, encryptionKey, received.conversation.id, received.messageId, received.conversation.generation);
  const delegated = await resolveDelegation(db, grant.token);
  return { received, grant, delegated };
}
async function lifecycle(action: "pause" | "resume" | "revoke" | "rotate", expectedRevision: number, expiresInDays?: number) {
  return updateTenantGatewayIntegration(db, first.actor, integration.id, {
    action, expectedRevision, reason: `合成接入管理 ${action}`, ...(expiresInDays === undefined ? {} : { expiresInDays }),
  });
}
async function expectCleared(messageId: string, conversationId: string, generation: number) {
  const message = (await db.query("SELECT encrypted_token,token_hash,grant_snapshot FROM tennis.gateway_messages WHERE tenant_id=$1 AND id=$2", [first.actor.tenantId, messageId])).rows[0];
  expect(message).toEqual({ encrypted_token: null, token_hash: null, grant_snapshot: null });
  expect((await db.query("SELECT 1 FROM tennis.agent_delegations WHERE tenant_id=$1 AND conversation_id=$2", [first.actor.tenantId, conversationId])).rowCount).toBe(0);
  expect((await getConversation(db, first.actor, conversationId)).conversation.generation).toBeGreaterThan(generation);
}

beforeAll(async () => {
  const tx = await db.connect();
  try { await migrateTennis(tx); } finally { tx.release(); }
});
beforeEach(async () => {
  extraSubjects = []; accountSubjects = [];
  first = await seedTenantFixture(db); second = await seedTenantFixture(db);
  const profile = await createCustomer(db, first.actor, { nickname: "合成接入管理客户", phone: syntheticPhone() });
  customer = { tenantId: first.actor.tenantId, subjectId: key(), kind: "customer", customerId: profile.id };
  staff = { tenantId: first.actor.tenantId, subjectId: key() };
  for (const actor of [customer, staff]) {
    await db.query("INSERT INTO tennis.subjects(id,display_name) VALUES($1,'synthetic gateway management subject')", [actor.subjectId]);
    extraSubjects.push(actor.subjectId);
  }
  await db.query("UPDATE tennis.customers SET subject_id=$1 WHERE tenant_id=$2 AND id=$3", [customer.subjectId, customer.tenantId, customer.customerId]);
  await db.query("INSERT INTO tennis.tenant_memberships(tenant_id,subject_id,role,all_venues,permissions) VALUES($1,$2,'STAFF',true,ARRAY['read','book','manage_members','reconcile_payments'])", [staff.tenantId, staff.subjectId]);
  integration = await createTenantGatewayIntegration(db, first.actor, { name: "合成租户智能体接入" });
  await createGatewayBinding(db, first.actor, { integrationId: integration.id, externalSubjectId, subjectId: customer.subjectId, actorKind: "customer", reason: "合成渠道身份已核验" });
  principal = await resolveGatewayIdentity(db, integration.token, externalSubjectId);
});
afterEach(async () => {
  const ids = [first.actor.tenantId, second.actor.tenantId];
  await db.query("DELETE FROM tennis.auth_sessions WHERE tenant_id=ANY($1::text[]) OR subject_id=ANY($2::text[])", [ids, accountSubjects]);
  await db.query("DELETE FROM tennis.auth_audit_events WHERE tenant_id=ANY($1::text[]) OR subject_id=ANY($2::text[])", [ids, accountSubjects]);
  await db.query("DELETE FROM tennis.local_accounts WHERE subject_id=ANY($1::text[])", [accountSubjects]);
  await removeTenantFixture(db, first); await removeTenantFixture(db, second);
  await db.query("DELETE FROM tennis.subjects WHERE id=ANY($1::text[])", [[...extraSubjects, ...accountSubjects]]);
});
afterAll(() => db.end());

describe("tenant administrator gateway credential management", () => {
  it("creates a bounded credential without platform provisioning and only returns its plaintext at issuance", async () => {
    expect((await db.query("SELECT 1 FROM tennis.platform_operators WHERE subject_id=$1", [first.actor.subjectId])).rowCount).toBe(0);
    expect(integration).toMatchObject({ tenantId: first.actor.tenantId, revision: 1, active: true, pausedAt: null, revokedAt: null, rotatedAt: null });
    expect(integration.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(daysBetween(integration.expiresAt, integration.createdAt)).toBeCloseTo(90, 4);
    const stored = (await db.query("SELECT token_hash FROM tennis.gateway_integrations WHERE tenant_id=$1 AND id=$2", [first.actor.tenantId, integration.id])).rows[0];
    expect(stored.token_hash).toBe(createHash("sha256").update(integration.token).digest("hex"));
    const listed = await listTenantGatewayIntegrations(db, first.actor);
    expect(listed).toEqual([expect.objectContaining({ id: integration.id, revision: 1 })]);
    for (const secret of [integration.token, stored.token_hash, "token_hash", "tokenHash"]) expect(JSON.stringify(listed)).not.toContain(secret);
    const audit = (await db.query("SELECT details FROM tennis.audit_events WHERE tenant_id=$1 UNION ALL SELECT details FROM tennis.auth_audit_events WHERE tenant_id=$1", [first.actor.tenantId])).rows;
    expect(JSON.stringify(audit)).not.toContain(integration.token);
    expect(JSON.stringify(audit)).not.toContain(stored.token_hash);
    const foreign = await createTenantGatewayIntegration(db, second.actor, { name: "另一租户接入", expiresInDays: 1 });
    expect((await listTenantGatewayIntegrations(db, first.actor)).map(i => i.id)).toEqual([integration.id]);
    expect((await listTenantGatewayIntegrations(db, second.actor)).map(i => i.id)).toEqual([foreign.id]);
    expect(daysBetween(foreign.expiresAt, foreign.createdAt)).toBeCloseTo(1, 4);
  });

  it("validates finite expiration, explicit reasons and optimistic revisions", async () => {
    for (const expiresInDays of [0, -1, 1.5, 366]) {
      await expect(createTenantGatewayIntegration(db, first.actor, { name: "无效期限", expiresInDays })).rejects.toMatchObject({ code: "INVALID_GATEWAY_INPUT" });
      await expect(lifecycle("rotate", 1, expiresInDays)).rejects.toMatchObject({ code: "INVALID_GATEWAY_INPUT" });
    }
    await expect(createTenantGatewayIntegration(db, first.actor, { name: "  " })).rejects.toMatchObject({ code: "INVALID_GATEWAY_INPUT" });
    await expect(updateTenantGatewayIntegration(db, first.actor, integration.id, { action: "pause", expectedRevision: 1, reason: " " })).rejects.toMatchObject({ code: "INVALID_GATEWAY_INPUT" });
    const maximum = await createTenantGatewayIntegration(db, first.actor, { name: "最长有效期", expiresInDays: 365 });
    expect(daysBetween(maximum.expiresAt, maximum.createdAt)).toBeCloseTo(365, 4);
    await expect(lifecycle("pause", 99)).rejects.toMatchObject({ code: "GATEWAY_CONFIGURATION_CHANGED" });
    expect((await listTenantGatewayIntegrations(db, first.actor)).find(i => i.id === integration.id)?.revision).toBe(1);
    expect((await resolveGatewayIdentity(db, integration.token, externalSubjectId)).integrationId).toBe(integration.id);
  });

  it("denies non-admins, customer identities, delegated admins and gateway admins without leaking another tenant", async () => {
    const conversation = await createConversation(db, first.actor, first.venueId);
    const normalGrant = await issueDelegation(db, first.actor, conversation.id);
    const delegatedAdmin = await resolveDelegation(db, normalGrant.token);
    await createGatewayBinding(db, first.actor, { integrationId: integration.id, externalSubjectId: "gateway-admin", subjectId: first.actor.subjectId, actorKind: "staff", reason: "合成管理员渠道绑定" });
    const gatewayAdmin = await resolveGatewayIdentity(db, integration.token, "gateway-admin");
    for (const actor of [staff, customer, delegatedAdmin.actor, gatewayAdmin.actor]) {
      await expect(listTenantGatewayIntegrations(db, actor)).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
      await expect(createTenantGatewayIntegration(db, actor, { name: "不能自行创建" })).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
      await expect(updateTenantGatewayIntegration(db, actor, integration.id, { action: "rotate", expectedRevision: 1, reason: "不能自行更换密钥" })).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
    }
    for (const action of ["pause", "resume", "revoke", "rotate"] as const) {
      await expect(updateTenantGatewayIntegration(db, second.actor, integration.id, { action, expectedRevision: 1, reason: "禁止跨租户操作" })).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    }
    expect(await listTenantGatewayIntegrations(db, second.actor)).toEqual([]);
    expect((await listTenantGatewayIntegrations(db, first.actor))[0]!.revision).toBe(1);
  });

  it("pauses authority immediately and resumes without reviving old messages or short grants", async () => {
    const { received, grant, delegated } = await granted();
    const paused = await lifecycle("pause", 1);
    expect(paused).toMatchObject({ id: integration.id, revision: 2, revokedAt: null });
    expect(paused.pausedAt).not.toBeNull();
    expect(paused).not.toHaveProperty("token");
    await expectCleared(received.messageId, received.conversation.id, received.conversation.generation);
    expect((await getConversation(db, first.actor, received.conversation.id)).conversation.mode).toBe("HUMAN");
    expect((await db.query("SELECT status FROM tennis.agent_message_dispatches WHERE tenant_id=$1 AND message_id=$2", [first.actor.tenantId, received.messageId])).rows[0]?.status).toBe("UNCERTAIN");
    await expect(resolveGatewayIdentity(db, integration.token, externalSubjectId)).rejects.toMatchObject({ code: "GATEWAY_IDENTITY_UNBOUND" });
    await expect(listOrders(db, principal.actor, first.venueId)).rejects.toMatchObject({ code: "GATEWAY_ACCESS_REVOKED" });
    await expect(resolveDelegation(db, grant.token)).rejects.toMatchObject({ code: "AGENT_DELEGATION_REVOKED" });
    await expect(listOrders(db, delegated.actor, first.venueId)).rejects.toMatchObject({ code: "AGENT_DELEGATION_REVOKED" });
    const resumed = await lifecycle("resume", 2);
    expect(resumed).toMatchObject({ revision: 3, pausedAt: null, revokedAt: null });
    expect(resumed).not.toHaveProperty("token");
    const fresh = await resolveGatewayIdentity(db, integration.token, externalSubjectId);
    const duplicate = await receiveGatewayMessage(db, fresh, incoming());
    expect(duplicate).toMatchObject({ duplicate: true, messageId: received.messageId });
    expect(duplicate.conversation.generation).toBeGreaterThan(received.conversation.generation);
    await expect(grantGatewayMessage(db, fresh, encryptionKey, received.conversation.id, received.messageId, duplicate.conversation.generation)).rejects.toMatchObject({ code: "GATEWAY_SCOPE_CHANGED" });
    await expect(completeGatewayMessage(db, fresh, received.conversation.id, received.messageId, { status: "SUCCEEDED", content: "旧消息不能恢复执行" })).rejects.toMatchObject({ code: "GATEWAY_GRANT_CLOSED" });
    await handoffConversation(db, first.actor, received.conversation.id, { mode: "AGENT", reason: "工作人员已核对原请求结果" });
    const next = await receiveGatewayMessage(db, fresh, incoming("new-message-after-resume"));
    const freshGrant = await grantGatewayMessage(db, fresh, encryptionKey, next.conversation.id, next.messageId, next.conversation.generation);
    expect((await resolveDelegation(db, freshGrant.token)).actor.subjectId).toBe(customer.subjectId);
    await expect(resolveDelegation(db, grant.token)).rejects.toMatchObject({ code: "AGENT_DELEGATION_REVOKED" });
    expect((await getConversation(db, customer, received.conversation.id)).messages.some(m => m.content === "旧消息不能恢复执行")).toBe(false);
  });

  it("rotates once under competing revisions and invalidates previously resolved identities and grants", async () => {
    const { received, grant, delegated } = await granted();
    const quote = await createTopupQuote(db, delegated.actor, { venueId: first.venueId, customerId: customer.customerId, principalCents: 10000 });
    const commandKey = key();
    const topup = await beginTopupPayment(db, delegated.actor, gateway, { quoteId: quote.id, commandKey });
    const unrelated = await createTenantGatewayIntegration(db, first.actor, { name: "应保留的另一接入" });
    await createGatewayBinding(db, first.actor, { integrationId: unrelated.id, externalSubjectId, subjectId: customer.subjectId, actorKind: "customer", reason: "独立接入的已核验绑定" });
    const unrelatedPrincipal = await resolveGatewayIdentity(db, unrelated.token, externalSubjectId);
    const unrelatedMessage = await receiveGatewayMessage(db, unrelatedPrincipal, incoming());
    const unrelatedGrant = await grantGatewayMessage(db, unrelatedPrincipal, encryptionKey, unrelatedMessage.conversation.id, unrelatedMessage.messageId, unrelatedMessage.conversation.generation);
    const attempts = await Promise.allSettled([lifecycle("rotate", 1, 30), lifecycle("rotate", 1, 60)]);
    const wins = attempts.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof lifecycle>>> => r.status === "fulfilled");
    expect(wins).toHaveLength(1);
    expect(attempts.filter(r => r.status === "rejected")).toEqual([expect.objectContaining({ reason: expect.objectContaining({ code: "GATEWAY_CONFIGURATION_CHANGED" }) })]);
    const changed = wins[0]!.value;
    expect(changed).toMatchObject({ id: integration.id, revision: 2, pausedAt: null });
    expect(changed.rotatedAt).not.toBeNull();
    expect(changed.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(changed.token).not.toBe(integration.token);
    await expectCleared(received.messageId, received.conversation.id, received.conversation.generation);
    await expect(resolveGatewayIdentity(db, integration.token, externalSubjectId)).rejects.toMatchObject({ code: "GATEWAY_IDENTITY_UNBOUND" });
    await expect(listOrders(db, principal.actor, first.venueId)).rejects.toMatchObject({ code: "GATEWAY_ACCESS_REVOKED" });
    await expect(resolveDelegation(db, grant.token)).rejects.toMatchObject({ code: "AGENT_DELEGATION_REVOKED" });
    await expect(listOrders(db, delegated.actor, first.venueId)).rejects.toMatchObject({ code: "AGENT_DELEGATION_REVOKED" });
    expect((await resolveGatewayIdentity(db, changed.token!, externalSubjectId)).bindingId).toBe(principal.bindingId);
    expect((await resolveDelegation(db, unrelatedGrant.token)).actor.subjectId).toBe(customer.subjectId);
    expect((await getConversation(db, customer, unrelatedMessage.conversation.id)).conversation).toMatchObject({ mode: "AGENT", generation: unrelatedMessage.conversation.generation });
    expect(await getConversationRequest(db, customer, received.conversation.id, grant.requestId)).toMatchObject({
      commandCount: 1, commands: [expect.objectContaining({ commandKey, resources: [{ type: "topup", id: topup.id, status: "PENDING" }] })],
    });
    const listed = await listTenantGatewayIntegrations(db, first.actor);
    expect(listed.find(i => i.id === integration.id)?.revision).toBe(2);
    expect(JSON.stringify(listed)).not.toContain(changed.token);
    expect(JSON.stringify(listed)).not.toContain(integration.token);
  });

  it("keeps rotation paused until explicitly resumed with the latest revision", async () => {
    const paused = await lifecycle("pause", 1);
    const changed = await lifecycle("rotate", 2, 120);
    expect(changed).toMatchObject({ revision: 3, pausedAt: paused.pausedAt });
    await expect(resolveGatewayIdentity(db, changed.token!, externalSubjectId)).rejects.toMatchObject({ code: "GATEWAY_IDENTITY_UNBOUND" });
    await expect(lifecycle("resume", 2)).rejects.toMatchObject({ code: "GATEWAY_CONFIGURATION_CHANGED" });
    expect((await lifecycle("resume", 3)).pausedAt).toBeNull();
    expect((await resolveGatewayIdentity(db, changed.token!, externalSubjectId)).integrationId).toBe(integration.id);
    await expect(resolveGatewayIdentity(db, integration.token, externalSubjectId)).rejects.toMatchObject({ code: "GATEWAY_IDENTITY_UNBOUND" });
  });

  it("keeps a completed conversation available after rotation while preserving its reply and closing old message grants", async () => {
    const { received } = await granted();
    const completion = { status: "SUCCEEDED" as const, content: "已查明没有待处理预约" };
    await completeGatewayMessage(db, principal, received.conversation.id, received.messageId, completion);
    const changed = await lifecycle("rotate", 1);
    await expectCleared(received.messageId, received.conversation.id, received.conversation.generation);
    const fresh = await resolveGatewayIdentity(db, changed.token!, externalSubjectId);
    const detail = await getConversation(db, customer, received.conversation.id);
    expect(detail.conversation.mode).toBe("AGENT");
    expect(detail.messages.filter(m => m.role === "assistant").map(m => m.content)).toEqual([completion.content]);
    expect((await db.query("SELECT status FROM tennis.agent_message_dispatches WHERE tenant_id=$1 AND message_id=$2", [first.actor.tenantId, received.messageId])).rows[0]?.status).toBe("SUCCEEDED");
    await expect(grantGatewayMessage(db, fresh, encryptionKey, received.conversation.id, received.messageId, detail.conversation.generation)).rejects.toMatchObject({ code: "GATEWAY_SCOPE_CHANGED" });
    expect(await completeGatewayMessage(db, fresh, received.conversation.id, received.messageId, completion)).toMatchObject({ duplicate: true });
    const next = await receiveGatewayMessage(db, fresh, incoming("new-message-after-completed-rotation"));
    const nextGrant = await grantGatewayMessage(db, fresh, encryptionKey, next.conversation.id, next.messageId, next.conversation.generation);
    expect((await resolveDelegation(db, nextGrant.token)).actor.subjectId).toBe(customer.subjectId);
  });

  it("permanently revokes both credential layers and cannot resume or rotate the revoked integration", async () => {
    const { received, grant } = await granted();
    const revoked = await lifecycle("revoke", 1);
    expect(revoked).toMatchObject({ id: integration.id, revision: 2, active: false });
    expect(revoked.revokedAt).not.toBeNull();
    expect(revoked).not.toHaveProperty("token");
    await expectCleared(received.messageId, received.conversation.id, received.conversation.generation);
    await expect(resolveGatewayIdentity(db, integration.token, externalSubjectId)).rejects.toMatchObject({ code: "GATEWAY_IDENTITY_UNBOUND" });
    await expect(resolveDelegation(db, grant.token)).rejects.toMatchObject({ code: "AGENT_DELEGATION_REVOKED" });
    await expect(lifecycle("resume", 2)).rejects.toBeInstanceOf(Error);
    await expect(lifecycle("rotate", 2)).rejects.toBeInstanceOf(Error);
    expect((await listTenantGatewayIntegrations(db, first.actor))[0]).toMatchObject({ revision: 2, active: false });
  });

  it("checks expiration on fresh identity resolution and already-resolved gateway and short-delegation actors", async () => {
    const { grant, delegated } = await granted();
    await db.query("UPDATE tennis.gateway_integrations SET expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND id=$2", [first.actor.tenantId, integration.id]);
    await expect(resolveGatewayIdentity(db, integration.token, externalSubjectId)).rejects.toMatchObject({ code: "GATEWAY_IDENTITY_UNBOUND" });
    await expect(listOrders(db, principal.actor, first.venueId)).rejects.toMatchObject({ code: "GATEWAY_ACCESS_REVOKED" });
    await expect(listOrders(db, delegated.actor, first.venueId)).rejects.toMatchObject({ code: "GATEWAY_ACCESS_REVOKED" });
    await expect(resolveDelegation(db, grant.token)).rejects.toMatchObject({ code: "GATEWAY_ACCESS_REVOKED" });
    await lifecycle("pause", 1);
    await expect(lifecycle("resume", 2)).rejects.toMatchObject({ code: "GATEWAY_CONFIGURATION_CHANGED" });
    const renewed = await lifecycle("rotate", 2, 7);
    expect(new Date(String(renewed.expiresAt)).getTime()).toBeGreaterThan(Date.now());
    await lifecycle("resume", 3);
    expect((await resolveGatewayIdentity(db, renewed.token!, externalSubjectId)).integrationId).toBe(integration.id);
    await expect(resolveDelegation(db, grant.token)).rejects.toMatchObject({ code: "AGENT_DELEGATION_REVOKED" });
  });

  it("uses tenant-admin cookie sessions, CSRF and workspace versions and rejects self-declared scope or Bearer management", async () => {
    const app = await buildTennisServer({ db, gateway, aiEncryptionKey: encryptionKey, allowSimulation: true, runExpiryWorker: false });
    const origin = "http://127.0.0.1:4273", password = "synthetic-gateway-management-http-893!";
    const base = "/api/tennis/gateway-integrations";
    async function login(kind: "ADMIN" | "STAFF" | "FOREIGN") {
      const username = `gateway_management_${key()}`;
      const account = await createLocalAccount(db, { username, password, displayName: "合成接入管理账号", tenantId: kind === "FOREIGN" ? second.actor.tenantId : first.actor.tenantId, role: kind === "STAFF" ? "STAFF" : "ADMIN" });
      accountSubjects.push(account.subjectId);
      const response = await app.inject({ method: "POST", url: "/api/tennis/auth/login", headers: { origin }, payload: { username, password } });
      expect(response.statusCode, response.body).toBe(200);
      const view = response.json<SessionView>(), cookies = response.headers["set-cookie"];
      return { origin, cookie: (Array.isArray(cookies) ? cookies[0]! : String(cookies)).split(";")[0]!, "x-csrf-token": view.csrfToken, "x-workspace-version": String(view.contextVersion) };
    }
    try {
      const adminHeaders = await login("ADMIN"), staffHeaders = await login("STAFF"), foreignHeaders = await login("FOREIGN");
      const payload = { name: "HTTP合成接入", expiresInDays: 30 };
      const { grant } = await granted();
      for (const token of [integration.token, grant.token]) {
        const headers = { origin, authorization: `Bearer ${token}`, "x-gateway-subject": externalSubjectId };
        expect((await app.inject({ url: base, headers })).statusCode).toBe(401);
        expect((await app.inject({ method: "POST", url: base, headers, payload })).statusCode).toBe(401);
      }
      expect((await app.inject({ url: base, headers: staffHeaders })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url: base, headers: staffHeaders, payload })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url: base, headers: { ...adminHeaders, "x-csrf-token": "" }, payload })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url: base, headers: { ...adminHeaders, "x-workspace-version": "999" }, payload })).statusCode).toBe(409);
      expect((await app.inject({ method: "POST", url: base, headers: adminHeaders, payload: { ...payload, tenantId: second.actor.tenantId } })).statusCode).toBe(400);
      expect((await app.inject({ url: `${base}?tenantId=${second.actor.tenantId}`, headers: adminHeaders })).statusCode).toBe(400);
      const created = await app.inject({ method: "POST", url: base, headers: adminHeaders, payload });
      expect(created.statusCode, created.body).toBe(200);
      const item = created.json();
      expect(item).toMatchObject({ tenantId: first.actor.tenantId, revision: 1 });
      expect(item.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const list = await app.inject({ url: base, headers: adminHeaders });
      expect(list.statusCode, list.body).toBe(200);
      expect(list.body).not.toContain(item.token);
      expect(list.body).not.toContain("token_hash");
      expect((await app.inject({ method: "POST", url: `${base}/${item.id}/pause`, headers: foreignHeaders, payload: { expectedRevision: 1, reason: "越租户" } })).statusCode).toBe(404);
      expect((await app.inject({ method: "POST", url: `${base}/${item.id}/rotate`, headers: adminHeaders, payload: { expectedRevision: 1, reason: "不能覆盖租户", tenantId: second.actor.tenantId } })).statusCode).toBe(400);
      const rotated = await app.inject({ method: "POST", url: `${base}/${item.id}/rotate`, headers: adminHeaders, payload: { expectedRevision: 1, reason: "定期更换", expiresInDays: 60 } });
      expect(rotated.statusCode, rotated.body).toBe(200);
      expect(rotated.json()).toMatchObject({ id: item.id, revision: 2 });
      expect(rotated.json().token).not.toBe(item.token);
      let revision = 2;
      for (const action of ["pause", "resume", "revoke"]) {
        const result = await app.inject({ method: "POST", url: `${base}/${item.id}/${action}`, headers: adminHeaders, payload: { expectedRevision: revision, reason: `HTTP合成 ${action}` } });
        expect(result.statusCode, result.body).toBe(200);
        expect(result.json().revision).toBe(++revision);
        expect(result.json()).not.toHaveProperty("token");
      }
      expect((await listTenantGatewayIntegrations(db, second.actor))).toEqual([]);
    } finally { await app.close(); }
  });
});
