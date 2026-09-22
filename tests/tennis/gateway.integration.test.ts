import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertLocalTennisDatabaseUrl, localTennisTestDatabaseUrl } from "../../packages/db/src/tennis/local-config.ts";
import { migrateTennis } from "../../packages/db/src/tennis/migrate.ts";
import {
  createCourt,
  createVenue,
  listVenues,
  setCourtPrice,
  updateVenue,
} from "../../packages/db/src/tennis/catalog.ts";
import { createCustomer, type CustomerActor } from "../../packages/db/src/tennis/customers.ts";
import { createQuote, confirmQuote, listOrders } from "../../packages/db/src/tennis/booking.ts";
import {
  getConversation,
  handoffConversation,
  resolveDelegation,
} from "../../packages/db/src/tennis/external-agent.ts";
import {
  completeGatewayMessage,
  createGatewayBinding,
  createGatewayIntegration,
  gatewayBindingTargets,
  grantGatewayMessage,
  listGatewayBindings,
  listPlatformGateways,
  receiveGatewayMessage,
  requireGatewayConversation,
  resolveGatewayIdentity,
  revokeGatewayBinding,
  revokeGatewayIntegration,
  type GatewayPrincipal,
} from "../../packages/db/src/tennis/gateway.ts";
import { pollBusinessEvents } from "../../packages/db/src/tennis/business-events.ts";
import { LocalMockPaymentGateway } from "../../packages/db/src/tennis/mock-payments.ts";
import { buildTennisServer } from "../../apps/api/src/tennis/server.ts";
import { seedTenantFixture, removeTenantFixture, syntheticPhone, type TenantFixture } from "./tenant-fixture.ts";
const db = new pg.Pool({
  connectionString: assertLocalTennisDatabaseUrl(localTennisTestDatabaseUrl, "test"),
  max: 8,
  connectionTimeoutMillis: 5000,
  statement_timeout: 10000,
});
const encryptionKey = randomBytes(32);
let first: TenantFixture,
  second: TenantFixture,
  customer: CustomerActor,
  courtId: string,
  principal: GatewayPrincipal,
  integration: { id: string; token: string },
  binding: { id: string };
const selection = () => ({
  venueId: first.venueId,
  customerId: customer.customerId,
  lines: [{ courtId, startAt: "2099-09-18T19:00:00+08:00", endAt: "2099-09-18T20:00:00+08:00" }],
});
const incoming = (changes: Record<string, string> = {}) => ({
  externalConversationId: "channel-conversation-1",
  externalMessageId: "channel-message-1",
  venueId: first.venueId,
  content: "请预订一小时",
  ...changes,
});
async function grant() {
  const received = await receiveGatewayMessage(db, principal, incoming());
  return {
    received,
    grant: await grantGatewayMessage(
      db,
      principal,
      encryptionKey,
      received.conversation.id,
      received.messageId,
      received.conversation.generation,
    ),
  };
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
  await db.query("INSERT INTO tennis.platform_operators(subject_id) VALUES($1)", [first.actor.subjectId]);
  const venue = (await listVenues(db, first.actor))[0]!;
  await updateVenue(db, first.actor, {
    ...venue,
    expectedRevision: venue.catalogRevision,
    minimumBookingMinutes: 15,
    openingHours: Array.from({ length: 7 }, (_, weekday) => ({ weekday, startMinute: 480, endMinute: 1320 })),
  });
  const court = await createCourt(db, first.actor, { venueId: first.venueId, name: "gateway court", indoor: true, surface: "ACRYLIC", profile: { specification: "STANDARD" }, hourlyPriceCents: 10000 });
  courtId = court.id;
  await setCourtPrice(db, first.actor, {
    venueId: first.venueId,
    courtId,
    expectedRevision: court.revision,
    hourlyPriceCents: 10000,
  });
  const profile = await createCustomer(db, first.actor, { nickname: "合成绑定客户", phone: syntheticPhone() }),
    subjectId = randomUUID();
  await db.query("INSERT INTO tennis.subjects(id,display_name) VALUES($1,'合成渠道客户')", [subjectId]);
  await db.query("UPDATE tennis.customers SET subject_id=$1 WHERE tenant_id=$2 AND id=$3", [
    subjectId,
    first.actor.tenantId,
    profile.id,
  ]);
  customer = { tenantId: first.actor.tenantId, subjectId, kind: "customer", customerId: profile.id };
  integration = await createGatewayIntegration(db, first.actor.subjectId, {
    tenantId: first.actor.tenantId,
    name: "合成渠道",
  });
  binding = await createGatewayBinding(db, first.actor, {
    integrationId: integration.id,
    externalSubjectId: "verified-channel-user",
    subjectId,
    actorKind: "customer",
    reason: "合成身份已人工核对",
  });
  principal = await resolveGatewayIdentity(db, integration.token, "verified-channel-user");
});
afterEach(async () => {
  for (const table of [
    "gateway_messages",
    "gateway_conversations",
    "agent_delegations",
    "gateway_bindings",
    "gateway_integrations",
    "agent_conversations",
    "auth_audit_events",
  ])
    await db.query(`DELETE FROM tennis.${table} WHERE tenant_id=ANY($1::text[])`, [
      [first.actor.tenantId, second.actor.tenantId],
    ]);
  await db.query("DELETE FROM tennis.platform_operators WHERE subject_id=$1", [first.actor.subjectId]);
  await removeTenantFixture(db, first);
  await removeTenantFixture(db, second);
  await db.query("DELETE FROM tennis.subjects WHERE id=$1", [customer.subjectId]);
});
afterAll(() => db.end());
describe("trusted gateway boundary and recoverable delivery", () => {
  it("anchors persisted order context to the original message and rejects changed-context retries", async () => {
    const quote = await createQuote(db, customer, selection());
    const order = await confirmQuote(db, customer, { quoteId: quote.id, commandKey: randomUUID() });
    const input = { ...incoming(), context: { page: "order", orderId: order.id } };
    const received = await receiveGatewayMessage(db, principal, input);
    expect((await receiveGatewayMessage(db, principal, input)).duplicate).toBe(true);
    await expect(
      receiveGatewayMessage(db, principal, { ...input, context: { page: "different", orderId: order.id } }),
    ).rejects.toMatchObject({ code: "GATEWAY_MESSAGE_CONFLICT" });
    await expect(
      receiveGatewayMessage(db, principal, {
        ...incoming({ externalMessageId: "foreign-context" }),
        context: { page: "order", orderId: randomUUID() },
      }),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    await receiveGatewayMessage(db, principal, {
      ...incoming({ externalMessageId: "later-page", content: "新的问题" }),
      context: { page: "wallet" },
    });
    const granted = await grantGatewayMessage(
      db,
      principal,
      encryptionKey,
      received.conversation.id,
      received.messageId,
      received.conversation.generation,
    );
    expect(granted.context).toEqual(input.context);
    expect(granted.messages.at(-1)).toMatchObject({ id: received.messageId, context: input.context });
    expect((await resolveDelegation(db, granted.token)).context).toEqual(input.context);
    const replay = await grantGatewayMessage(
      db,
      principal,
      encryptionKey,
      received.conversation.id,
      received.messageId,
      received.conversation.generation,
    );
    expect(replay).toMatchObject({
      token: granted.token,
      expiresAt: granted.expiresAt,
      context: input.context,
      replayed: true,
    });
    const detail = await getConversation(db, first.actor, received.conversation.id);
    expect(detail.latestOrderContext?.orderId).toBe(order.id);
  });
  it("persists HUMAN gateway order messages without granting new agent authority", async () => {
    const quote = await createQuote(db, customer, selection());
    const order = await confirmQuote(db, customer, { quoteId: quote.id, commandKey: randomUUID() });
    const received = await receiveGatewayMessage(db, principal, incoming());
    await handoffConversation(db, principal.actor, received.conversation.id, {
      mode: "HUMAN",
      reason: "合成接管",
      context: { page: "order", orderId: order.id },
    });
    const human = await receiveGatewayMessage(db, principal, {
      ...incoming({ externalMessageId: "human-message", content: "这单需要员工帮助" }),
      context: { page: "order", orderId: order.id },
    });
    expect(human.conversation.mode).toBe("HUMAN");
    const detail = await getConversation(db, first.actor, received.conversation.id);
    expect(detail.messages.at(-1)).toMatchObject({ context: { page: "order", orderId: order.id } });
    await expect(
      grantGatewayMessage(
        db,
        principal,
        encryptionKey,
        human.conversation.id,
        human.messageId,
        human.conversation.generation,
      ),
    ).rejects.toMatchObject({ code: "GATEWAY_SCOPE_CHANGED" });
  });
  it("allows only platform provisioning and tenant admins binding existing identities", async () => {
    await expect(
      createGatewayIntegration(db, second.actor.subjectId, { tenantId: first.actor.tenantId, name: "rogue" }),
    ).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
    await expect(
      createGatewayBinding(db, second.actor, {
        integrationId: integration.id,
        externalSubjectId: "fake",
        subjectId: customer.subjectId,
        actorKind: "customer",
        reason: "wrong tenant",
      }),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    await expect(listGatewayBindings(db, customer)).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
    await expect(resolveGatewayIdentity(db, integration.token, "reported-phone-123")).rejects.toMatchObject({
      code: "GATEWAY_IDENTITY_UNBOUND",
    });
    const lists = await listPlatformGateways(db, first.actor.subjectId, first.actor.tenantId);
    expect(JSON.stringify(lists)).not.toContain(integration.token);
    expect(JSON.stringify(lists)).not.toContain("token_hash");
    expect(await gatewayBindingTargets(db, first.actor, "合成绑定")).toEqual([
      expect.objectContaining({
        subjectId: customer.subjectId,
        actorKind: "customer",
        customerId: customer.customerId,
      }),
    ]);
  });
  it("deduplicates concurrent inbound delivery and replays only the original encrypted finite grant", async () => {
    const results = await Promise.all([
      receiveGatewayMessage(db, principal, incoming()),
      receiveGatewayMessage(db, principal, incoming()),
    ]);
    expect(results[0]!.messageId).toBe(results[1]!.messageId);
    expect(results.map((x) => x.duplicate).sort()).toEqual([false, true]);
    const r = results[0]!;
    const [a, b] = await Promise.all([
      grantGatewayMessage(db, principal, encryptionKey, r.conversation.id, r.messageId, 1),
      grantGatewayMessage(db, principal, encryptionKey, r.conversation.id, r.messageId, 1),
    ]);
    expect(a.token).toBe(b.token);
    expect(new Date(a.expiresAt as string).toISOString()).toBe(new Date(b.expiresAt as string).toISOString());
    expect(a.requestId).toBe(r.messageId);
    const persisted = (
      await db.query("SELECT encrypted_token,grant_snapshot FROM tennis.gateway_messages WHERE id=$1", [r.messageId])
    ).rows[0];
    expect(JSON.stringify(persisted)).not.toContain(a.token);
    expect((await getConversation(db, customer, r.conversation.id)).messages).toHaveLength(1);
  });
  it("anchors an older queued request snapshot to its original message despite more than 200 later messages", async () => {
    const r = await receiveGatewayMessage(db, principal, incoming());
    for (let i = 0; i < 205; i++)
      await receiveGatewayMessage(
        db,
        principal,
        incoming({ externalMessageId: `future-${i}`, content: `后续请求${i}` }),
      );
    const g = await grantGatewayMessage(db, principal, encryptionKey, r.conversation.id, r.messageId, 1);
    expect(g.messages).toEqual([expect.objectContaining({ id: r.messageId, content: incoming().content })]);
    expect(g.requestId).toBe(r.messageId);
  });
  it("serializes queued handoff before completion so no old-generation reply commits afterward", async () => {
    const { received: r } = await grant();
    const gate = await db.connect();
    let handoff: Promise<unknown> | undefined, completion: Promise<unknown> | undefined;
    const waitForQueued = async (count: number) => {
      const end = Date.now() + 3000;
      while (Date.now() < end) {
        const waiting = Number(
          (
            await db.query(
              "SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())",
            )
          ).rows[0].count,
        );
        if (waiting >= count) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("Expected tenant transactions to queue behind the test gate");
    };
    try {
      await gate.query("BEGIN");
      await gate.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `tennis:transactions:${first.actor.tenantId}`,
      ]);
      handoff = handoffConversation(db, first.actor, r.conversation.id, { mode: "HUMAN", reason: "并发接管" });
      await waitForQueued(1);
      completion = completeGatewayMessage(db, principal, r.conversation.id, r.messageId, {
        status: "SUCCEEDED",
        content: "接管后不应出现",
      });
      const settled = Promise.allSettled([handoff, completion]);
      await waitForQueued(2);
      await gate.query("COMMIT");
      const results = await settled;
      expect(results[0]!.status).toBe("fulfilled");
      expect(results[1]).toMatchObject({ status: "rejected", reason: { code: "GATEWAY_SCOPE_CHANGED" } });
      expect(
        (await getConversation(db, customer, r.conversation.id)).messages.some((m) => m.content === "接管后不应出现"),
      ).toBe(false);
    } finally {
      await gate.query("ROLLBACK");
      gate.release();
      await Promise.allSettled([handoff, completion].filter(Boolean));
    }
  });
  it("rejects message identifier reuse, identity substitution and implicit venue switches", async () => {
    const r = await receiveGatewayMessage(db, principal, incoming());
    await expect(receiveGatewayMessage(db, principal, incoming({ content: "改成其他需求" }))).rejects.toMatchObject({
      code: "GATEWAY_MESSAGE_CONFLICT",
    });
    const other = await createVenue(db, first.actor, { name: "另一校区", timezone: "Asia/Shanghai" });
    await expect(receiveGatewayMessage(db, principal, incoming({ venueId: other.id }))).rejects.toMatchObject({
      code: "GATEWAY_SCOPE_CHANGED",
    });
    await createGatewayBinding(db, first.actor, {
      integrationId: integration.id,
      externalSubjectId: "staff-user",
      subjectId: first.actor.subjectId,
      actorKind: "staff",
      reason: "人工核对员工",
    });
    const staff = await resolveGatewayIdentity(db, integration.token, "staff-user");
    await expect(requireGatewayConversation(db, staff, r.conversation.id)).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
    });
    await expect(
      receiveGatewayMessage(db, principal, incoming({ venueId: second.venueId, externalMessageId: "different" })),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
  });
  it("revokes already-resolved tool actors and read actors when binding is revoked", async () => {
    const { grant: g } = await grant();
    const resolved = await resolveDelegation(db, g.token as string);
    const quote = await createQuote(db, resolved.actor, selection());
    await revokeGatewayBinding(db, first.actor, binding.id, "身份解绑");
    await expect(
      confirmQuote(db, resolved.actor, { quoteId: quote.id, commandKey: randomUUID() }),
    ).rejects.toMatchObject({ code: "GATEWAY_ACCESS_REVOKED" });
    await expect(pollBusinessEvents(db, principal.actor, first.venueId)).rejects.toMatchObject({
      code: "GATEWAY_ACCESS_REVOKED",
    });
    expect(await listOrders(db, first.actor, first.venueId)).toHaveLength(0);
  });
  it("revokes already-resolved tool actors when integration is revoked", async () => {
    const { grant: g } = await grant(),
      resolved = await resolveDelegation(db, g.token as string);
    const quote = await createQuote(db, resolved.actor, selection());
    await revokeGatewayIntegration(db, first.actor.subjectId, integration.id, "停用合成渠道");
    await expect(
      confirmQuote(db, resolved.actor, { quoteId: quote.id, commandKey: randomUUID() }),
    ).rejects.toMatchObject({ code: "AGENT_DELEGATION_REVOKED" });
    await expect(resolveGatewayIdentity(db, integration.token, "verified-channel-user")).rejects.toMatchObject({
      code: "GATEWAY_IDENTITY_UNBOUND",
    });
  });
  it("keeps old grants invalid across handoff and never appends stale assistant answers", async () => {
    const { received: r, grant: g } = await grant();
    await handoffConversation(db, first.actor, r.conversation.id, { mode: "HUMAN", reason: "核对原交易" });
    await expect(resolveDelegation(db, g.token as string)).rejects.toMatchObject({ code: "AGENT_DELEGATION_REVOKED" });
    await expect(
      grantGatewayMessage(db, principal, encryptionKey, r.conversation.id, r.messageId, 1),
    ).rejects.toMatchObject({ code: "GATEWAY_SCOPE_CHANGED" });
    await expect(
      completeGatewayMessage(db, principal, r.conversation.id, r.messageId, {
        status: "SUCCEEDED",
        content: "过时回复",
      }),
    ).rejects.toMatchObject({ code: "GATEWAY_SCOPE_CHANGED" });
    await completeGatewayMessage(db, principal, r.conversation.id, r.messageId, { status: "UNCERTAIN" });
    await handoffConversation(db, first.actor, r.conversation.id, { mode: "AGENT", reason: "已核对完成" });
    await expect(
      grantGatewayMessage(db, principal, encryptionKey, r.conversation.id, r.messageId, 3),
    ).rejects.toMatchObject({ code: "GATEWAY_SCOPE_CHANGED" });
    expect(
      (await getConversation(db, customer, r.conversation.id)).messages.some((m) => m.content === "过时回复"),
    ).toBe(false);
  });
  it("expires without extending or reissuing authorization on replay", async () => {
    const { received: r } = await grant();
    await db.query(
      "UPDATE tennis.agent_delegations SET expires_at=clock_timestamp()-interval '1 second' WHERE conversation_id=$1",
      [r.conversation.id],
    );
    await expect(
      grantGatewayMessage(db, principal, encryptionKey, r.conversation.id, r.messageId, 1),
    ).rejects.toMatchObject({ code: "GATEWAY_GRANT_CLOSED" });
    expect(
      Number(
        (await db.query("SELECT count(*) FROM tennis.agent_requests WHERE conversation_id=$1", [r.conversation.id]))
          .rows[0].count,
      ),
    ).toBe(1);
  });
  it("completes once, closes original write token, and permits the next distinct message", async () => {
    const { received: r, grant: g } = await grant();
    const result = await completeGatewayMessage(db, principal, r.conversation.id, r.messageId, {
      status: "SUCCEEDED",
      content: "已查询，请确认",
    });
    expect(result.duplicate).toBe(false);
    expect(
      (
        await completeGatewayMessage(db, principal, r.conversation.id, r.messageId, {
          status: "SUCCEEDED",
          content: "已查询，请确认",
        })
      ).duplicate,
    ).toBe(true);
    await expect(resolveDelegation(db, g.token as string)).rejects.toMatchObject({ code: "AGENT_DELEGATION_REVOKED" });
    await expect(
      completeGatewayMessage(db, principal, r.conversation.id, r.messageId, {
        status: "SUCCEEDED",
        content: "不同回复",
      }),
    ).rejects.toMatchObject({ code: "GATEWAY_MESSAGE_CONFLICT" });
    const secondMessage = await receiveGatewayMessage(
      db,
      principal,
      incoming({ externalMessageId: "next-message", content: "确认原报价" }),
    );
    expect(
      (await grantGatewayMessage(db, principal, encryptionKey, r.conversation.id, secondMessage.messageId, 1))
        .requestId,
    ).toBe(secondMessage.messageId);
    expect(
      (await getConversation(db, customer, r.conversation.id)).messages.filter((m) => m.role === "assistant"),
    ).toHaveLength(1);
  });
  it("holds new grants after uncertain completion until employee reconciliation and takeover", async () => {
    const { received: r } = await grant();
    await completeGatewayMessage(db, principal, r.conversation.id, r.messageId, { status: "UNCERTAIN" });
    const next = await receiveGatewayMessage(db, principal, incoming({ externalMessageId: "next", content: "再试试" }));
    await expect(
      grantGatewayMessage(db, principal, encryptionKey, r.conversation.id, next.messageId, 1),
    ).rejects.toMatchObject({ code: "ASSISTANT_RESULT_UNKNOWN" });
    expect(await requireGatewayConversation(db, principal, r.conversation.id)).toMatchObject({ mode: "AGENT" });
  });
  it("recovers committed commands through gateway reads after the response is lost and human takeover closes writes", async () => {
    const { received: r, grant: g } = await grant();
    const delegated = await resolveDelegation(db, g.token);
    const quote = await createQuote(db, delegated.actor, selection());
    const commandKey = randomUUID();
    const order = await confirmQuote(db, delegated.actor, { quoteId: quote.id, commandKey });
    await completeGatewayMessage(db, principal, r.conversation.id, r.messageId, { status: "UNCERTAIN" });
    const app = await buildTennisServer({
      db,
      gateway: new LocalMockPaymentGateway(randomBytes(32).toString("hex"), "local-simulation"),
      allowSimulation: true,
      aiEncryptionKey: encryptionKey,
    });
    const headers = { authorization: `Bearer ${integration.token}`, "x-gateway-subject": "verified-channel-user" };
    try {
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/tennis/gateway/conversations/${r.conversation.id}/handoff`,
            headers,
            payload: { reason: "先核对原预订" },
          })
        ).statusCode,
      ).toBe(200);
      const index = await app.inject({
        method: "GET",
        url: `/api/tennis/gateway/conversations/${r.conversation.id}/requests`,
        headers,
      });
      expect(index.statusCode).toBe(200);
      expect(index.json().items).toEqual([
        expect.objectContaining({ requestId: r.messageId, commandCount: 1, dispatchStatus: "UNCERTAIN" }),
      ]);
      const detail = await app.inject({
        method: "GET",
        url: `/api/tennis/gateway/conversations/${r.conversation.id}/requests/${r.messageId}`,
        headers,
      });
      expect(detail.statusCode).toBe(200);
      expect(detail.json().commands).toEqual([
        expect.objectContaining({
          commandKey,
          resources: expect.arrayContaining([expect.objectContaining({ type: "order", id: order.id, status: "HELD" })]),
        }),
      ]);
      expect(await listOrders(db, first.actor, first.venueId)).toHaveLength(1);
      await expect(resolveDelegation(db, g.token)).rejects.toMatchObject({ code: "AGENT_DELEGATION_REVOKED" });
    } finally {
      await app.close();
    }
  });
  it("guards HTTP independently from session cookies and rejects self-declared tenant or customer fields", async () => {
    const app = await buildTennisServer({
      db,
      gateway: new LocalMockPaymentGateway(randomBytes(32).toString("hex"), "local-simulation"),
      allowSimulation: true,
      aiEncryptionKey: encryptionKey,
    });
    try {
      const headers = { authorization: `Bearer ${integration.token}`, "x-gateway-subject": "verified-channel-user" };
      expect(
        (await app.inject({ method: "POST", url: "/api/tennis/gateway/messages", payload: incoming() })).statusCode,
      ).toBe(409);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/tennis/gateway/messages",
            headers,
            payload: { ...incoming(), tenantId: second.actor.tenantId, customerId: customer.customerId },
          })
        ).statusCode,
      ).toBe(400);
      const response = await app.inject({
        method: "POST",
        url: "/api/tennis/gateway/messages",
        headers,
        payload: incoming(),
      });
      expect(response.statusCode).toBe(200);
      const r = response.json();
      const delegated = await app.inject({
        method: "POST",
        url: `/api/tennis/gateway/conversations/${r.conversation.id}/messages/${r.messageId}/grant`,
        headers,
        payload: { expectedGeneration: 1 },
      });
      expect(delegated.statusCode).toBe(200);
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/api/tennis/agent/context",
            headers: { authorization: `Bearer ${delegated.json().token}` },
          })
        ).json(),
      ).toMatchObject({ customerId: customer.customerId, tenantId: first.actor.tenantId });
      const events = await app.inject({
        method: "GET",
        url: `/api/tennis/gateway/events?venueId=${first.venueId}`,
        headers,
      });
      expect(events.statusCode).toBe(200);
      expect(events.json()).toMatchObject({ events: [] });
    } finally {
      await app.close();
    }
  });
});
