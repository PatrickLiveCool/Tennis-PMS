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
import { confirmQuote, createQuote, listOrders } from "../../packages/db/src/tennis/booking.ts";
import {
  createConversation,
  getAIConfig,
  getConversation,
  handoffConversation,
  issueDelegation,
  listConversations,
  resolveDelegation,
  saveAIConfig,
  sendAssistantMessage,
  setAssistantMessageFeedback,
} from "../../packages/db/src/tennis/external-agent.ts";
import { buildTennisServer } from "../../apps/api/src/tennis/server.ts";
import { LocalMockPaymentGateway } from "../../packages/db/src/tennis/mock-payments.ts";
import { removeTenantFixture, seedTenantFixture, type TenantFixture } from "./tenant-fixture.ts";

const db = new pg.Pool({
  connectionString: assertLocalTennisDatabaseUrl(localTennisTestDatabaseUrl, "test"),
  max: 8,
  connectionTimeoutMillis: 5000,
  statement_timeout: 10000,
});
const key = randomBytes(32),
  gateway = new LocalMockPaymentGateway(randomBytes(32).toString("hex"), "local-simulation");
let first: TenantFixture, second: TenantFixture, customer: CustomerActor, courtId: string;
let previousConfig: Record<string, unknown>;
const selection = () => ({
  venueId: first.venueId,
  customerId: customer.customerId,
  lines: [{ courtId, startAt: "2099-09-18T19:00:00+08:00", endAt: "2099-09-18T20:00:00+08:00" }],
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
  previousConfig = (await db.query("SELECT * FROM tennis.platform_ai_config WHERE singleton")).rows[0];
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
  const court = await createCourt(db, first.actor, { venueId: first.venueId, name: "assistant court", indoor: true });
  courtId = court.id;
  await setCourtPrice(db, first.actor, {
    venueId: first.venueId,
    courtId,
    expectedRevision: court.revision,
    hourlyPriceCents: 12000,
  });
  const profile = await createCustomer(db, first.actor, { nickname: "synthetic assistant customer" });
  const subjectId = randomUUID();
  await db.query("INSERT INTO tennis.subjects(id,display_name) VALUES($1,'synthetic assistant customer')", [subjectId]);
  await db.query("UPDATE tennis.customers SET subject_id=$1 WHERE tenant_id=$2 AND id=$3", [
    subjectId,
    first.actor.tenantId,
    profile.id,
  ]);
  customer = { tenantId: first.actor.tenantId, subjectId, kind: "customer", customerId: profile.id };
});
afterEach(async () => {
  await db.query(
    "UPDATE tennis.platform_ai_config SET enabled=$1,model=$2,base_url=$3,external_agent_url=$4,encrypted_key=$5,revision=$6,updated_by=$7,updated_at=$8 WHERE singleton",
    [
      previousConfig.enabled,
      previousConfig.model,
      previousConfig.base_url,
      previousConfig.external_agent_url,
      previousConfig.encrypted_key,
      previousConfig.revision,
      previousConfig.updated_by,
      previousConfig.updated_at,
    ],
  );
  await db.query("DELETE FROM tennis.agent_conversations WHERE tenant_id=ANY($1::text[])", [
    [first.actor.tenantId, second.actor.tenantId],
  ]);
  await db.query("DELETE FROM tennis.auth_audit_events WHERE subject_id=$1", [first.actor.subjectId]);
  await db.query("DELETE FROM tennis.platform_operators WHERE subject_id=$1", [first.actor.subjectId]);
  await removeTenantFixture(db, first);
  await removeTenantFixture(db, second);
  await db.query("DELETE FROM tennis.subjects WHERE id=$1", [customer.subjectId]);
});
afterAll(() => db.end());
async function configured() {
  const current = await getAIConfig(db, first.actor.subjectId);
  return saveAIConfig(db, first.actor.subjectId, key, {
    enabled: true,
    model: "provided-model",
    baseUrl: "https://models.example.test/v1",
    externalAgentUrl: "https://agent.example.test/messages",
    apiKey: "synthetic-service-secret",
    expectedRevision: current.revision,
  });
}

describe("external assistant adapter and human handoff", () => {
  it("keeps model settings platform-only and never returns stored plaintext credentials", async () => {
    await expect(getAIConfig(db, second.actor.subjectId)).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
    const result = await configured();
    expect(result.hasApiKey).toBe(true);
    expect(JSON.stringify(result)).not.toContain("synthetic-service-secret");
    const stored = (await db.query("SELECT encrypted_key FROM tennis.platform_ai_config WHERE singleton")).rows[0]
      .encrypted_key as string;
    expect(stored).not.toContain("synthetic-service-secret");
    await expect(
      saveAIConfig(db, first.actor.subjectId, key, {
        ...result,
        expectedRevision: result.revision,
        externalAgentUrl: "http://unsecured.example.test/",
      }),
    ).rejects.toMatchObject({ code: "INVALID_AGENT_CONFIG" });
  });
  it("revokes an already resolved bearer inside the business transaction after human takeover", async () => {
    const conv = await createConversation(db, customer, first.venueId),
      delegation = await issueDelegation(db, customer, conv.id);
    const resolved = await resolveDelegation(db, delegation.token),
      quote = await createQuote(db, resolved.actor, selection());
    await handoffConversation(db, first.actor, conv.id, { mode: "HUMAN", reason: "员工接管办理" });
    await expect(
      confirmQuote(db, resolved.actor, { quoteId: quote.id, commandKey: randomUUID() }),
    ).rejects.toMatchObject({ code: "AGENT_DELEGATION_REVOKED" });
    expect(await listOrders(db, first.actor, first.venueId)).toHaveLength(0);
    await handoffConversation(db, first.actor, conv.id, { mode: "AGENT", reason: "交回继续咨询" });
    await expect(resolveDelegation(db, delegation.token)).rejects.toMatchObject({ code: "AGENT_DELEGATION_REVOKED" });
    const fresh = await issueDelegation(db, customer, conv.id);
    expect((await resolveDelegation(db, fresh.token)).actor).toMatchObject({ customerId: customer.customerId });
  });
  it("rejects cross-tenant conversations and same-tenant venue escapes", async () => {
    const conv = await createConversation(db, customer, first.venueId);
    await expect(getConversation(db, second.actor, conv.id)).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    await expect(listConversations(db, second.actor, first.venueId)).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
    });
    const other = await createVenue(db, first.actor, { name: "second venue", timezone: "Asia/Shanghai" });
    const delegation = await issueDelegation(db, customer, conv.id),
      resolved = await resolveDelegation(db, delegation.token);
    await expect(listOrders(db, resolved.actor, other.id)).rejects.toMatchObject({ code: "AGENT_SCOPE_DENIED" });
    await expect(
      handoffConversation(db, customer, conv.id, { mode: "AGENT", reason: "自行恢复" }),
    ).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
  });
  it("only proxies to an external runtime and preserves one reply for retried message IDs", async () => {
    await configured();
    const conv = await createConversation(db, customer, first.venueId),
      messageId = randomUUID();
    let count = 0;
    const transport = async (url: string, input: { headers: Record<string, string>; body: string }) => {
      count++;
      expect(url).toBe("https://agent.example.test/messages");
      expect(input.headers.Authorization).toBe("Bearer synthetic-service-secret");
      const payload = JSON.parse(input.body);
      expect(payload.model).toBe("provided-model");
      expect(payload.requestId).toBe(messageId);
      expect((await resolveDelegation(db, payload.delegation.token)).actor).toMatchObject({
        tenantId: customer.tenantId,
        customerId: customer.customerId,
      });
      return { ok: true, json: async () => ({ content: "外部测试服务回复" }) };
    };
    const result = await sendAssistantMessage(
      db,
      customer,
      key,
      conv.id,
      { messageId, content: "明天晚上有哪些场地？", context: { page: "schedule" } },
      transport,
    );
    expect(result.messages.map((message) => message.content)).toEqual(["明天晚上有哪些场地？", "外部测试服务回复"]);
    await sendAssistantMessage(db, customer, key, conv.id, { messageId, content: "明天晚上有哪些场地？" }, transport);
    expect(count).toBe(1);
    expect(
      (await db.query("SELECT * FROM tennis.agent_delegations WHERE tenant_id=$1", [first.actor.tenantId])).rowCount,
    ).toBe(0);
  });
  it("keeps feedback per person, restricts customer conversations and only accepts assistant messages", async () => {
    await configured();
    const conv = await createConversation(db, customer, first.venueId),
      messageId = randomUUID();
    const initial = await sendAssistantMessage(
      db,
      customer,
      key,
      conv.id,
      { messageId, content: "查看空场" },
      async () => ({ ok: true, json: async () => ({ content: "这里是可预订场地" }) }),
    );
    const replyId = `reply:${messageId}`;
    expect(initial.messages.find((message) => message.id === replyId)?.feedback).toBeNull();
    const firstFeedback = await setAssistantMessageFeedback(db, customer, conv.id, replyId, true);
    expect(firstFeedback).toMatchObject({ conversationId: conv.id, messageId: replyId, resolved: true });
    expect(await setAssistantMessageFeedback(db, customer, conv.id, replyId, true)).toEqual(firstFeedback);
    await setAssistantMessageFeedback(db, customer, conv.id, replyId, false);
    await setAssistantMessageFeedback(db, first.actor, conv.id, replyId, true);
    expect(
      (await getConversation(db, customer, conv.id)).messages.find((message) => message.id === replyId)?.feedback,
    ).toBe(false);
    expect(
      (await getConversation(db, first.actor, conv.id)).messages.find((message) => message.id === replyId)?.feedback,
    ).toBe(true);
    expect(
      (
        await db.query("SELECT resolved FROM tennis.agent_message_feedback WHERE tenant_id=$1 AND message_id=$2", [
          customer.tenantId,
          replyId,
        ])
      ).rowCount,
    ).toBe(2);
    await expect(setAssistantMessageFeedback(db, customer, conv.id, messageId, true)).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
    });
    await expect(setAssistantMessageFeedback(db, customer, conv.id, "missing-message", true)).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
    });
    await expect(setAssistantMessageFeedback(db, second.actor, conv.id, replyId, true)).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
    });
    const otherProfile = await createCustomer(db, first.actor, { nickname: "另一位客户" });
    await db.query("UPDATE tennis.customers SET subject_id=$1 WHERE tenant_id=$2 AND id=$3", [
      first.actor.subjectId,
      first.actor.tenantId,
      otherProfile.id,
    ]);
    const otherCustomer: CustomerActor = { ...first.actor, kind: "customer", customerId: otherProfile.id };
    const otherConv = await createConversation(db, otherCustomer, first.venueId),
      otherMessageId = randomUUID();
    await sendAssistantMessage(
      db,
      otherCustomer,
      key,
      otherConv.id,
      { messageId: otherMessageId, content: "私人咨询" },
      async () => ({ ok: true, json: async () => ({ content: "另一位客户的回复" }) }),
    );
    await setAssistantMessageFeedback(db, otherCustomer, otherConv.id, `reply:${otherMessageId}`, true);
    await expect(getConversation(db, customer, otherConv.id)).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    await expect(
      setAssistantMessageFeedback(db, customer, otherConv.id, `reply:${otherMessageId}`, false),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    await expect(
      setAssistantMessageFeedback(db, customer, conv.id, `reply:${otherMessageId}`, false),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    expect(
      (await getConversation(db, otherCustomer, otherConv.id)).messages.find(
        (message) => message.id === `reply:${otherMessageId}`,
      )?.feedback,
    ).toBe(true);
  });
  it("discards a delayed assistant response after an employee has taken over", async () => {
    await configured();
    const conv = await createConversation(db, customer, first.venueId);
    await expect(
      sendAssistantMessage(db, customer, key, conv.id, { messageId: randomUUID(), content: "请帮我订场" }, async () => {
        await handoffConversation(db, first.actor, conv.id, { mode: "HUMAN", reason: "处理特殊情况" });
        return { ok: true, json: async () => ({ content: "不得出现在已接管会话的回复" }) };
      }),
    ).rejects.toMatchObject({ code: "HUMAN_HANDOFF_ACTIVE" });
    expect(
      (await getConversation(db, customer, conv.id)).messages.some((message) => message.role === "assistant"),
    ).toBe(false);
  });
  it("claims each external message only once and blocks concurrent duplicate execution", async () => {
    await configured();
    const conv = await createConversation(db, customer, first.venueId),
      messageId = randomUUID();
    let release!: () => void,
      entered!: () => void,
      count = 0;
    const started = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    const transport = async () => {
      count++;
      entered();
      await gate;
      return { ok: true, json: async () => ({ content: "仅回复一次" }) };
    };
    const one = sendAssistantMessage(db, customer, key, conv.id, { messageId, content: "查询" }, transport);
    await started;
    try {
      await expect(
        sendAssistantMessage(db, customer, key, conv.id, { messageId, content: "查询" }, transport),
      ).rejects.toMatchObject({ code: "ASSISTANT_BUSY" });
    } finally {
      release();
      await one;
    }
    expect(count).toBe(1);
  });
  it("requires human reconciliation instead of redispatching an unknown external result", async () => {
    await configured();
    const conv = await createConversation(db, customer, first.venueId),
      messageId = randomUUID();
    let count = 0;
    const transport = async () => {
      count++;
      throw new Error("response lost after possible business action");
    };
    await expect(
      sendAssistantMessage(db, customer, key, conv.id, { messageId, content: "订场" }, transport),
    ).rejects.toMatchObject({ code: "ASSISTANT_RESULT_UNKNOWN" });
    await expect(
      sendAssistantMessage(db, customer, key, conv.id, { messageId, content: "订场" }, transport),
    ).rejects.toMatchObject({ code: "ASSISTANT_RESULT_UNKNOWN" });
    expect(count).toBe(1);
    await handoffConversation(db, first.actor, conv.id, { mode: "HUMAN", reason: "核对原订单结果" });
    await handoffConversation(db, first.actor, conv.id, { mode: "AGENT", reason: "原交易已人工核对" });
    const result = await sendAssistantMessage(
      db,
      customer,
      key,
      conv.id,
      { messageId: randomUUID(), content: "继续咨询" },
      async () => ({ ok: true, json: async () => ({ content: "已恢复咨询" }) }),
    );
    expect(result.messages.at(-1)?.content).toBe("已恢复咨询");
  });
  it("fails clearly when unconfigured and preserves human messages without invoking AI", async () => {
    const conv = await createConversation(db, customer, first.venueId),
      current = await getAIConfig(db, first.actor.subjectId);
    await saveAIConfig(db, first.actor.subjectId, key, {
      enabled: false,
      model: "",
      baseUrl: "",
      externalAgentUrl: "",
      apiKey: "",
      expectedRevision: current.revision,
    });
    await expect(
      sendAssistantMessage(db, customer, key, conv.id, { messageId: randomUUID(), content: "咨询" }),
    ).rejects.toMatchObject({ code: "ASSISTANT_NOT_CONFIGURED" });
    await handoffConversation(db, customer, conv.id, { mode: "HUMAN", reason: "请员工协助" });
    const result = await sendAssistantMessage(
      db,
      first.actor,
      key,
      conv.id,
      { messageId: randomUUID(), content: "前台正在为您确认" },
      async () => {
        throw new Error("must not invoke external transport");
      },
    );
    expect(result.messages.at(-1)).toMatchObject({ role: "staff", content: "前台正在为您确认" });
  });
  it("lets booking agents select only their tenant customers without wallet authority", async () => {
    const other = await createCustomer(db, second.actor, { nickname: "outside tenant" });
    await db.query(
      "UPDATE tennis.tenant_memberships SET role='STAFF',all_venues=true,permissions=ARRAY['read','book']::text[] WHERE tenant_id=$1 AND subject_id=$2",
      [first.actor.tenantId, first.actor.subjectId],
    );
    const conv = await createConversation(db, first.actor, first.venueId),
      delegation = await issueDelegation(db, first.actor, conv.id);
    const customerConv = await createConversation(db, customer, first.venueId),
      customerToken = await issueDelegation(db, customer, customerConv.id);
    const app = await buildTennisServer({ db, gateway, allowSimulation: true, aiEncryptionKey: key });
    try {
      const headers = { authorization: `Bearer ${delegation.token}` };
      const found = await app.inject({ url: "/api/tennis/agent/booking-customers?q=synthetic", headers });
      expect(found.statusCode).toBe(200);
      expect(found.json()).toEqual([expect.objectContaining({ id: customer.customerId, phone: null })]);
      expect(JSON.stringify(found.json())).not.toContain(other.id);
      expect(
        (await app.inject({ url: `/api/tennis/agent/customers/${customer.customerId}/wallet`, headers })).statusCode,
      ).toBe(403);
      const self = await app.inject({
        url: "/api/tennis/agent/booking-customers",
        headers: { authorization: `Bearer ${customerToken.token}` },
      });
      expect(self.statusCode).toBe(200);
      expect(self.json()).toHaveLength(1);
      expect(self.json()[0].id).toBe(customer.customerId);
      await handoffConversation(db, first.actor, conv.id, { mode: "HUMAN", reason: "接管选客操作" });
      expect((await app.inject({ url: "/api/tennis/agent/booking-customers", headers })).statusCode).toBe(409);
    } finally {
      await app.close();
    }
  });
  it("protects external tool routes without cookies and omits staff-only money commands", async () => {
    const conv = await createConversation(db, customer, first.venueId),
      delegation = await issueDelegation(db, customer, conv.id);
    const app = await buildTennisServer({ db, gateway, allowSimulation: true, aiEncryptionKey: key });
    try {
      expect((await app.inject({ url: "/api/tennis/agent/context" })).statusCode).toBe(409);
      const headers = { authorization: `Bearer ${delegation.token}` };
      const quote = await app.inject({
        method: "POST",
        url: "/api/tennis/agent/quotes",
        headers,
        payload: { customerId: customer.customerId, lines: selection().lines },
      });
      expect(quote.statusCode).toBe(200);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/tennis/agent/quotes",
            headers,
            payload: { customerId: customer.customerId, lines: selection().lines, tenantId: second.actor.tenantId },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (await app.inject({ method: "POST", url: "/api/tennis/agent/orders/something/refunds", headers, payload: {} }))
          .statusCode,
      ).toBe(404);
      await handoffConversation(db, first.actor, conv.id, { mode: "HUMAN", reason: "接管" });
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/tennis/agent/quotes/${quote.json().id}/confirm`,
            headers,
            payload: { commandKey: randomUUID() },
          })
        ).statusCode,
      ).toBe(409);
    } finally {
      await app.close();
    }
  });
});
