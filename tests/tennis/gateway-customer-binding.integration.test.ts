import { randomBytes, randomUUID } from "node:crypto";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertLocalTennisDatabaseUrl, localTennisTestDatabaseUrl } from "../../packages/db/src/tennis/local-config.ts";
import { migrateTennis } from "../../packages/db/src/tennis/migrate.ts";
import { createCustomer, type CustomerRecord } from "../../packages/db/src/tennis/customers.ts";
import {
  createGatewayBinding,
  createGatewayIntegration,
  gatewayBindingTargets,
  grantGatewayMessage,
  receiveGatewayMessage,
  requireGatewayConversation,
  resolveGatewayIdentity,
  revokeGatewayBinding,
  revokeGatewayIntegration,
  type GatewayBindingInput,
} from "../../packages/db/src/tennis/gateway.ts";
import { resolveDelegation } from "../../packages/db/src/tennis/external-agent.ts";
import { registerGatewayRoutes } from "../../apps/api/src/tennis/gateway-routes.ts";
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
const encryptionKey = randomBytes(32);
let first: TenantFixture, second: TenantFixture;
let integration: { id: string; token: string };
let profile: CustomerRecord;
let prefix: string;
const input = (customerId = profile.id, externalSubjectId = randomUUID()): GatewayBindingInput => ({
  integrationId: integration.id,
  externalSubjectId,
  actorKind: "customer",
  customerId,
  reason: "已当面核验本人渠道账号与客户档案",
});
const inbound = () => ({
  externalConversationId: "synthetic-conversation",
  externalMessageId: randomUUID(),
  venueId: first.venueId,
  content: "查询空场",
});
async function subjectFor(customerId = profile.id) {
  return (
    await db.query<{ subject_id: string | null }>("SELECT subject_id FROM tennis.customers WHERE id=$1", [customerId])
  ).rows[0]!.subject_id;
}
async function createdSubjects() {
  return (
    await db.query<{ id: string }>("SELECT id FROM tennis.subjects WHERE strpos(display_name,$1)=1 ORDER BY id", [
      prefix,
    ])
  ).rows.map((row) => row.id);
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
  prefix = `binding-${randomUUID()}`;
  await db.query("INSERT INTO tennis.platform_operators(subject_id) VALUES($1)", [first.actor.subjectId]);
  integration = await createGatewayIntegration(db, first.actor.subjectId, {
    tenantId: first.actor.tenantId,
    name: "新客户合成接入",
  });
  profile = await createCustomer(db, first.actor, { nickname: `${prefix}-客户` });
});
afterEach(async () => {
  const subjects = await createdSubjects();
  const tenants = [first.actor.tenantId, second.actor.tenantId];
  for (const table of [
    "gateway_messages",
    "gateway_conversations",
    "agent_delegations",
    "gateway_bindings",
    "gateway_integrations",
    "agent_conversations",
    "auth_audit_events",
  ])
    await db.query(`DELETE FROM tennis.${table} WHERE tenant_id=ANY($1::text[])`, [tenants]);
  await db.query("DELETE FROM tennis.platform_operators WHERE subject_id=ANY($1::text[])", [
    [first.actor.subjectId, second.actor.subjectId],
  ]);
  await db.query("DELETE FROM tennis.auth_sessions WHERE subject_id=ANY($1::text[])", [subjects]);
  await db.query("DELETE FROM tennis.local_accounts WHERE subject_id=ANY($1::text[])", [subjects]);
  await removeTenantFixture(db, first);
  await removeTenantFixture(db, second);
  await db.query("DELETE FROM tennis.subjects WHERE id=ANY($1::text[])", [subjects]);
});
afterAll(() => db.end());

describe("manually verified gateway binding for ordinary customer profiles", () => {
  it("lists customer profiles without a login subject and binds only the selected same-name profile", async () => {
    const sibling = await createCustomer(db, first.actor, { nickname: profile.nickname });
    const targets = await gatewayBindingTargets(db, first.actor, prefix);
    expect(targets).toHaveLength(2);
    expect(targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ customerId: profile.id, subjectId: null, actorKind: "customer" }),
        expect.objectContaining({ customerId: sibling.id, subjectId: null, actorKind: "customer" }),
      ]),
    );
    const binding = await createGatewayBinding(db, first.actor, input());
    expect(binding).toMatchObject({ customerId: profile.id, actorKind: "customer", active: true });
    expect(await subjectFor()).toBe(binding.subjectId);
    expect(await subjectFor(sibling.id)).toBeNull();
    expect(await createdSubjects()).toEqual([binding.subjectId]);
    const actor = await resolveGatewayIdentity(db, integration.token, binding.externalSubjectId);
    expect(actor.actor).toMatchObject({
      tenantId: first.actor.tenantId,
      customerId: profile.id,
      subjectId: binding.subjectId,
      kind: "customer",
    });
    for (const table of ["local_accounts", "auth_sessions", "tenant_memberships", "platform_operators"])
      expect((await db.query(`SELECT 1 FROM tennis.${table} WHERE subject_id=$1`, [binding.subjectId])).rowCount).toBe(
        0,
      );
    const received = await receiveGatewayMessage(db, actor, inbound());
    expect(received.conversation).toMatchObject({
      subjectId: binding.subjectId,
      customerId: profile.id,
      actorKind: "customer",
    });
  });
  it("creates one subject when two authorized channels bind the same new customer concurrently", async () => {
    const results = await Promise.all([
      createGatewayBinding(db, first.actor, input()),
      createGatewayBinding(db, first.actor, input()),
    ]);
    expect(results[0]!.subjectId).toBe(results[1]!.subjectId);
    expect(results[0]!.id).not.toBe(results[1]!.id);
    expect(await createdSubjects()).toEqual([results[0]!.subjectId]);
    expect(
      (
        await db.query("SELECT id FROM tennis.gateway_bindings WHERE tenant_id=$1 AND customer_id=$2 AND active", [
          first.actor.tenantId,
          profile.id,
        ])
      ).rowCount,
    ).toBe(2);
  });
  it("conflicting concurrent first bindings roll back the losing customer subject entirely", async () => {
    const sibling = await createCustomer(db, first.actor, { nickname: `${prefix}-另一客户` });
    const externalSubjectId = randomUUID();
    const results = await Promise.allSettled([
      createGatewayBinding(db, first.actor, input(profile.id, externalSubjectId)),
      createGatewayBinding(db, first.actor, input(sibling.id, externalSubjectId)),
    ]);
    const successes = results.filter((result) => result.status === "fulfilled");
    expect(successes).toHaveLength(1);
    expect((results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({
      code: "GATEWAY_MESSAGE_CONFLICT",
    });
    expect(await createdSubjects()).toHaveLength(1);
    expect([await subjectFor(), await subjectFor(sibling.id)].filter(Boolean)).toHaveLength(1);
    expect(
      (await db.query("SELECT id FROM tennis.gateway_bindings WHERE tenant_id=$1", [first.actor.tenantId])).rowCount,
    ).toBe(1);
  });
  it("returns an explicit conflict on duplicate submission without changing existing identity", async () => {
    const command = input();
    const binding = await createGatewayBinding(db, first.actor, command);
    await expect(createGatewayBinding(db, first.actor, command)).rejects.toMatchObject({
      code: "GATEWAY_MESSAGE_CONFLICT",
    });
    expect(await subjectFor()).toBe(binding.subjectId);
    expect(await createdSubjects()).toHaveLength(1);
  });
  it("reuses existing customer subjects and keeps the legacy subject branch and staff branch", async () => {
    const firstBinding = await createGatewayBinding(db, first.actor, input());
    const legacy = await createGatewayBinding(db, first.actor, {
      integrationId: integration.id,
      externalSubjectId: randomUUID(),
      actorKind: "customer",
      subjectId: firstBinding.subjectId,
      reason: "复核第二渠道",
    });
    const byCustomer = await createGatewayBinding(db, first.actor, input());
    expect(legacy).toMatchObject({ customerId: profile.id, subjectId: firstBinding.subjectId });
    expect(byCustomer.subjectId).toBe(firstBinding.subjectId);
    expect(await createdSubjects()).toHaveLength(1);
    const staff = await createGatewayBinding(db, first.actor, {
      integrationId: integration.id,
      externalSubjectId: randomUUID(),
      actorKind: "staff",
      subjectId: first.actor.subjectId,
      reason: "员工本人核验",
    });
    expect(staff).toMatchObject({ subjectId: first.actor.subjectId, actorKind: "staff", customerId: null });
  });
  it("rejects ambiguous, missing and mismatched identity selectors without creating a subject", async () => {
    const base = { integrationId: integration.id, externalSubjectId: randomUUID(), reason: "合成核验" };
    for (const invalid of [
      { ...base, actorKind: "customer", customerId: profile.id, subjectId: first.actor.subjectId },
      { ...base, actorKind: "customer" },
      { ...base, actorKind: "staff", customerId: profile.id },
      { ...base, actorKind: "customer", customerId: "   " },
    ])
      await expect(createGatewayBinding(db, first.actor, invalid as GatewayBindingInput)).rejects.toMatchObject({
        code: "INVALID_GATEWAY_INPUT",
      });
    expect(await subjectFor()).toBeNull();
    expect(await createdSubjects()).toHaveLength(0);
  });
  it("keeps tenant, integration and customer activation boundaries", async () => {
    const foreign = await createCustomer(db, second.actor, { nickname: `${prefix}-其他租户` });
    await expect(createGatewayBinding(db, first.actor, input(foreign.id))).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
    });
    await expect(createGatewayBinding(db, second.actor, input(profile.id))).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
    });
    await db.query("UPDATE tennis.customers SET active=false WHERE id=$1", [profile.id]);
    expect(await gatewayBindingTargets(db, first.actor, prefix)).toEqual([]);
    await expect(createGatewayBinding(db, first.actor, input())).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    await db.query("UPDATE tennis.customers SET active=true WHERE id=$1", [profile.id]);
    await revokeGatewayIntegration(db, first.actor.subjectId, integration.id, "停用合成接入");
    await expect(createGatewayBinding(db, first.actor, input())).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    expect(await createdSubjects()).toHaveLength(0);
  });
  it("requires tenant ADMIN even for member-management staff or platform operators", async () => {
    await db.query("INSERT INTO tennis.platform_operators(subject_id) VALUES($1)", [second.actor.subjectId]);
    const platformOnly = { tenantId: first.actor.tenantId, subjectId: second.actor.subjectId };
    await expect(createGatewayBinding(db, platformOnly, input())).rejects.toMatchObject({
      code: "TENANT_ACCESS_DENIED",
    });
    await db.query(
      "UPDATE tennis.tenant_memberships SET role='STAFF',all_venues=true,permissions=ARRAY['read','manage_members'] WHERE tenant_id=$1",
      [first.actor.tenantId],
    );
    await expect(gatewayBindingTargets(db, first.actor)).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
    await expect(createGatewayBinding(db, first.actor, input())).rejects.toMatchObject({
      code: "TENANT_ACCESS_DENIED",
    });
    expect(await createdSubjects()).toHaveLength(0);
  });
  it("does not let a customer grant channel identity or bypass a disabled local account", async () => {
    const binding = await createGatewayBinding(db, first.actor, input());
    const principal = await resolveGatewayIdentity(db, integration.token, binding.externalSubjectId);
    await expect(createGatewayBinding(db, principal.actor, input())).rejects.toMatchObject({
      code: "TENANT_ACCESS_DENIED",
    });
    await db.query(
      "INSERT INTO tennis.local_accounts(subject_id,username,password_hash,active) VALUES($1,$2,'synthetic-unused-hash',false)",
      [binding.subjectId, `disabled-${randomUUID()}`],
    );
    expect(await gatewayBindingTargets(db, first.actor, prefix)).toEqual([]);
    await expect(createGatewayBinding(db, first.actor, input())).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    await expect(
      createGatewayBinding(db, first.actor, {
        integrationId: integration.id,
        externalSubjectId: randomUUID(),
        actorKind: "customer",
        subjectId: binding.subjectId,
        reason: "试图复用停用账号",
      }),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    await expect(receiveGatewayMessage(db, principal, inbound())).rejects.toMatchObject({
      code: "GATEWAY_ACCESS_REVOKED",
    });
    expect(await createdSubjects()).toHaveLength(1);
  });
  it("revoking then manually rebinding keeps the subject but never inherits old conversations or delegations", async () => {
    const command = input();
    const firstBinding = await createGatewayBinding(db, first.actor, command);
    const original = await resolveGatewayIdentity(db, integration.token, firstBinding.externalSubjectId);
    const received = await receiveGatewayMessage(db, original, inbound());
    const grant = await grantGatewayMessage(
      db,
      original,
      encryptionKey,
      received.conversation.id,
      received.messageId,
      received.conversation.generation,
    );
    await revokeGatewayBinding(db, first.actor, firstBinding.id, "重新人工核验渠道身份");
    await expect(receiveGatewayMessage(db, original, inbound())).rejects.toMatchObject({
      code: "GATEWAY_ACCESS_REVOKED",
    });
    await expect(resolveDelegation(db, grant.token)).rejects.toMatchObject({ code: "GATEWAY_ACCESS_REVOKED" });
    const replacement = await createGatewayBinding(db, first.actor, command);
    expect(replacement.subjectId).toBe(firstBinding.subjectId);
    expect(replacement.id).not.toBe(firstBinding.id);
    const current = await resolveGatewayIdentity(db, integration.token, replacement.externalSubjectId);
    await expect(requireGatewayConversation(db, current, received.conversation.id)).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
    });
    const next = await receiveGatewayMessage(db, current, inbound());
    expect(next.conversation.id).not.toBe(received.conversation.id);
  });
  it.each(["customer", "tenant"])(
    "rechecks a new customer's %s activation on an already-resolved principal",
    async (kind) => {
      const binding = await createGatewayBinding(db, first.actor, input());
      const principal = await resolveGatewayIdentity(db, integration.token, binding.externalSubjectId);
      if (kind === "customer") await db.query("UPDATE tennis.customers SET active=false WHERE id=$1", [profile.id]);
      else await db.query("UPDATE tennis.tenants SET active=false WHERE id=$1", [first.actor.tenantId]);
      await expect(receiveGatewayMessage(db, principal, inbound())).rejects.toMatchObject({
        code: kind === "customer" ? "RESOURCE_NOT_FOUND" : "GATEWAY_ACCESS_REVOKED",
      });
    },
  );
  it("validates customerId and legacy subjectId HTTP branches without accepting authority fields", async () => {
    // Session authentication is covered by the server suite; this fixture isolates the actual route schemas.
    const app = Fastify({ ajv: { customOptions: { removeAdditional: false } } });
    registerGatewayRoutes(app, {
      db,
      key: encryptionKey,
      actor: () => first.actor,
      subject: () => first.actor.subjectId,
    });
    try {
      const command = input();
      const response = await app.inject({ method: "POST", url: "/api/tennis/gateway-bindings", payload: command });
      expect(response.statusCode).toBe(200);
      const binding = response.json();
      const malformed = [
        { ...command, externalSubjectId: randomUUID(), subjectId: binding.subjectId },
        { integrationId: integration.id, externalSubjectId: randomUUID(), actorKind: "customer", reason: "无身份选择" },
        { ...command, externalSubjectId: randomUUID(), actorKind: "staff" },
        { ...command, externalSubjectId: randomUUID(), tenantId: second.actor.tenantId },
        { ...command, externalSubjectId: randomUUID(), role: "ADMIN" },
      ];
      for (const payload of malformed)
        expect((await app.inject({ method: "POST", url: "/api/tennis/gateway-bindings", payload })).statusCode).toBe(
          400,
        );
      const legacy = await app.inject({
        method: "POST",
        url: "/api/tennis/gateway-bindings",
        payload: {
          integrationId: integration.id,
          externalSubjectId: randomUUID(),
          actorKind: "customer",
          subjectId: binding.subjectId,
          reason: "兼容旧调用",
        },
      });
      expect(legacy.statusCode).toBe(200);
      expect(legacy.json().customerId).toBe(profile.id);
    } finally {
      await app.close();
    }
  });
});
