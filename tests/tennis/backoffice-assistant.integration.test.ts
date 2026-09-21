import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assertLocalTennisDatabaseUrl, localTennisTestDatabaseUrl } from "../../packages/db/src/tennis/local-config.ts";
import { migrateTennis } from "../../packages/db/src/tennis/migrate.ts";
import { createBackofficeConversation, getBackofficeAIConfig, getBackofficeConversation, listBackofficeConversations, saveBackofficeAIConfig, sendBackofficeMessage, setBackofficeMessageFeedback, testBackofficeAIConfig, type BackofficeRun } from "../../packages/db/src/tennis/backoffice-assistant.ts";
import { getAIConfig } from "../../packages/db/src/tennis/external-agent.ts";
import { createLocalAccount, login, selectSessionContext } from "../../packages/db/src/tennis/auth.ts";
import { createCourt, listVenues, setCourtPrice, updateVenue } from "../../packages/db/src/tennis/catalog.ts";
import { createCustomer } from "../../packages/db/src/tennis/customers.ts";
import { confirmQuote, createQuote } from "../../packages/db/src/tennis/booking.ts";
import { prepareAssistantAction } from "../../apps/api/src/tennis/assistant-preparation.ts";
import { backofficeExecutor } from "../../apps/api/src/tennis/backoffice-model.ts";
import { buildTennisServer } from "../../apps/api/src/tennis/server.ts";
import { LocalMockPaymentGateway } from "../../packages/db/src/tennis/mock-payments.ts";
import type { ModelInput } from "../../apps/api/src/assistant-model.ts";
import { removeTenantFixture, seedTenantFixture, type TenantFixture } from "./tenant-fixture.ts";

const db = new pg.Pool({ connectionString: assertLocalTennisDatabaseUrl(localTennisTestDatabaseUrl, "test"), max: 8, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
const key = randomBytes(32);
let first: TenantFixture, second: TenantFixture;
let previousConfig: Record<string, unknown>;
let subjects: string[] = [];
beforeAll(async () => { const tx = await db.connect(); try { await migrateTennis(tx); } finally { tx.release(); } });
beforeEach(async () => {
  subjects = [];
  previousConfig = (await db.query("SELECT * FROM tennis.backoffice_ai_config WHERE singleton")).rows[0];
  first = await seedTenantFixture(db); second = await seedTenantFixture(db);
  await db.query("INSERT INTO tennis.platform_operators(subject_id) VALUES($1)", [first.actor.subjectId]);
});
afterEach(async () => {
  await db.query("UPDATE tennis.backoffice_ai_config SET enabled=$1,model=$2,base_url=$3,encrypted_key=$4,revision=$5,updated_by=$6,updated_at=$7 WHERE singleton", [previousConfig.enabled, previousConfig.model, previousConfig.base_url, previousConfig.encrypted_key, previousConfig.revision, previousConfig.updated_by, previousConfig.updated_at]);
  await db.query("DELETE FROM tennis.auth_audit_events WHERE subject_id=$1", [first.actor.subjectId]);
  await db.query("DELETE FROM tennis.platform_operators WHERE subject_id=$1", [first.actor.subjectId]);
  await db.query("DELETE FROM tennis.auth_sessions WHERE subject_id=ANY($1::text[])", [subjects]);
  await db.query("DELETE FROM tennis.auth_audit_events WHERE subject_id=ANY($1::text[])", [subjects]);
  await db.query("DELETE FROM tennis.platform_operators WHERE subject_id=ANY($1::text[])", [subjects]);
  await db.query("DELETE FROM tennis.local_accounts WHERE subject_id=ANY($1::text[])", [subjects]);
  await removeTenantFixture(db, first); await removeTenantFixture(db, second);
  await db.query("DELETE FROM tennis.subjects WHERE id=ANY($1::text[])", [subjects]);
});
afterAll(() => db.end());
async function configure() {
  const config = await getBackofficeAIConfig(db, first.actor.subjectId);
  return saveBackofficeAIConfig(db, first.actor.subjectId, key, { enabled: true, model: "synthetic-model", baseUrl: "https://model.example.test/v1", apiKey: "synthetic-secret", expectedRevision: config.revision });
}
const reply = async () => ({ content: "请在排场页查看可用时段。", actions: [] });

describe("private backoffice assistant configuration and request lifecycle", () => {
  it("separates model keys from Runtime config and exposes only masked platform config", async () => {
    const runtime = await getAIConfig(db, first.actor.subjectId);
    const result = await configure();
    expect(result).toMatchObject({ enabled: true, hasApiKey: true });
    expect(JSON.stringify(result)).not.toContain("synthetic-secret");
    expect(result).not.toHaveProperty("externalAgentUrl");
    expect(await getAIConfig(db, first.actor.subjectId)).toEqual(runtime);
    await expect(getBackofficeAIConfig(db, second.actor.subjectId)).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
    await expect(saveBackofficeAIConfig(db, first.actor.subjectId, key, { ...result, expectedRevision: result.revision - 1 })).rejects.toMatchObject({ code: "STALE_CONFIGURATION" });
    const audit = (await db.query("SELECT details FROM tennis.auth_audit_events WHERE subject_id=$1 AND action='platform.backoffice_ai_config'", [first.actor.subjectId])).rows;
    expect(JSON.stringify(audit)).not.toContain("synthetic-secret");
  });
  it("never carries a model credential to a new origin or through an empty URL", async () => {
    const config = await configure();
    for (const baseUrl of ["", "https://different.example.test/v1"])
      await expect(saveBackofficeAIConfig(db, first.actor.subjectId, key, { ...config, enabled: false, baseUrl, expectedRevision: config.revision })).rejects.toMatchObject({ code: "INVALID_AGENT_CONFIG" });
    const cleared = await saveBackofficeAIConfig(db, first.actor.subjectId, key, { ...config, enabled: false, baseUrl: "", apiKey: "", expectedRevision: config.revision });
    expect(cleared.hasApiKey).toBe(false);
    await expect(saveBackofficeAIConfig(db, first.actor.subjectId, key, { ...cleared, enabled: true, baseUrl: "https://different.example.test/v1", expectedRevision: cleared.revision })).rejects.toMatchObject({ code: "INVALID_AGENT_CONFIG" });
  });
  it("tests saved configuration only for platform operators and hides provider error text", async () => {
    const config = await configure(), test = vi.fn(async () => { throw new Error("provider disclosed synthetic-secret"); });
    await expect(testBackofficeAIConfig(db, second.actor.subjectId, key, config.revision, test)).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
    expect(test).not.toHaveBeenCalled();
    await expect(testBackofficeAIConfig(db, first.actor.subjectId, key, config.revision, test)).rejects.toMatchObject({ message: "ASSISTANT_UNAVAILABLE" });
    await expect(testBackofficeAIConfig(db, first.actor.subjectId, key, config.revision, async () => {})).resolves.toEqual({ ok: true, message: "模型连接成功" });
  });
  it("keeps an employee's sessions private even from another same-tenant administrator", async () => {
    const conversation = await createBackofficeConversation(db, first.actor, first.venueId);
    await db.query("INSERT INTO tennis.tenant_memberships(tenant_id,subject_id,role) VALUES($1,$2,'ADMIN')", [first.actor.tenantId, second.actor.subjectId]);
    const colleague = { tenantId: first.actor.tenantId, subjectId: second.actor.subjectId };
    try {
      expect(await listBackofficeConversations(db, colleague, first.venueId)).toEqual([]);
      await expect(getBackofficeConversation(db, colleague, conversation.id)).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
      await expect(getBackofficeConversation(db, second.actor, conversation.id)).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
      await expect(createBackofficeConversation(db, first.actor, second.venueId)).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    } finally { await db.query("DELETE FROM tennis.tenant_memberships WHERE tenant_id=$1 AND subject_id=$2", [first.actor.tenantId, second.actor.subjectId]); }
  });
  it("delivers once, replays the original result, and rejects message id reuse with changed content", async () => {
    await configure();
    const conversation = await createBackofficeConversation(db, first.actor, first.venueId), messageId = randomUUID();
    const execute = vi.fn(async (run: BackofficeRun) => { await run.authorize(); expect(run.config.apiKey).toBe("synthetic-secret"); return { content: "不会显示 synthetic-secret", actions: [] }; });
    const input = { messageId, content: "今天哪些场地可用？" };
    const one = await sendBackofficeMessage(db, first.actor, key, conversation.id, input, execute);
    const two = await sendBackofficeMessage(db, first.actor, key, conversation.id, input, execute);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(two.messages).toEqual(one.messages);
    expect(one.requests[0]?.status).toBe("SUCCEEDED");
    expect(one.messages.at(-1)?.content).toBe("不会显示 [已隐藏凭证]");
    await expect(sendBackofficeMessage(db, first.actor, key, conversation.id, { ...input, content: "different" }, execute)).rejects.toMatchObject({ code: "INVALID_AGENT_MESSAGE" });
    await setBackofficeMessageFeedback(db, first.actor, conversation.id, one.messages.at(-1)!.id, true);
    expect((await getBackofficeConversation(db, first.actor, conversation.id)).messages.at(-1)?.resolved).toBe(true);
  });
  it("claims once across concurrent messages and makes crash/timeout recovery explicit", async () => {
    await configure();
    const conversation = await createBackofficeConversation(db, first.actor, first.venueId), input = { messageId: randomUUID(), content: "查询" };
    let enter!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => { enter = resolve; }), gate = new Promise<void>((resolve) => { release = resolve; });
    const pending = sendBackofficeMessage(db, first.actor, key, conversation.id, input, async () => { enter(); await gate; return reply(); });
    await started;
    try {
      const replay = await sendBackofficeMessage(db, first.actor, key, conversation.id, input, reply);
      expect(replay.requests[0]?.status).toBe("RUNNING");
      await expect(sendBackofficeMessage(db, first.actor, key, conversation.id, { ...input, messageId: randomUUID() }, reply)).rejects.toMatchObject({ code: "ASSISTANT_BUSY" });
      await db.query("UPDATE tennis.backoffice_requests SET deadline_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND conversation_id=$2", [first.actor.tenantId, conversation.id]);
      expect((await getBackofficeConversation(db, first.actor, conversation.id)).requests[0]?.status).toBe("FAILED");
    } finally { release(); await pending; }
    const detail = await getBackofficeConversation(db, first.actor, conversation.id);
    expect(detail.messages).toHaveLength(1);
    expect(detail.requests[0]?.errorCode).toBe("ASSISTANT_UNAVAILABLE");
    const retry = vi.fn(reply);
    await sendBackofficeMessage(db, first.actor, key, conversation.id, input, retry);
    expect(retry).not.toHaveBeenCalled();
    await sendBackofficeMessage(db, first.actor, key, conversation.id, { ...input, messageId: randomUUID() }, retry);
    expect(retry).toHaveBeenCalledTimes(1);
  });
  it("rechecks permissions after a model result and does not persist a reply after revocation", async () => {
    await configure();
    const conversation = await createBackofficeConversation(db, first.actor, first.venueId);
    await expect(sendBackofficeMessage(db, first.actor, key, conversation.id, { messageId: randomUUID(), content: "查询" }, async () => {
      await db.query("UPDATE tennis.tenant_memberships SET active=false WHERE tenant_id=$1 AND subject_id=$2", [first.actor.tenantId, first.actor.subjectId]);
      return reply();
    })).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
    expect((await db.query("SELECT status FROM tennis.backoffice_requests WHERE conversation_id=$1", [conversation.id])).rows[0]?.status).toBe("FAILED");
    expect((await db.query("SELECT 1 FROM tennis.backoffice_messages WHERE conversation_id=$1 AND role='ASSISTANT'", [conversation.id])).rowCount).toBe(0);
  });
  it("does not invoke the executor when unconfigured or when context points outside the conversation venue", async () => {
    const previous = await getBackofficeAIConfig(db, first.actor.subjectId);
    await saveBackofficeAIConfig(db, first.actor.subjectId, key, { enabled: false, model: "", baseUrl: "", apiKey: "", expectedRevision: previous.revision });
    const conversation = await createBackofficeConversation(db, first.actor, first.venueId), execute = vi.fn(reply);
    await expect(sendBackofficeMessage(db, first.actor, key, conversation.id, { messageId: randomUUID(), content: "查询" }, execute)).rejects.toMatchObject({ code: "BACKOFFICE_ASSISTANT_NOT_CONFIGURED" });
    await configure();
    await expect(sendBackofficeMessage(db, first.actor, key, conversation.id, { messageId: randomUUID(), content: "查询", context: { page: "orders", orderId: randomUUID() } }, execute)).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    expect(execute).not.toHaveBeenCalled();
  });
  it("keeps synthetic model tool results free of customer, order and payment identifiers", async () => {
    await configure();
    const venue = (await listVenues(db, first.actor))[0]!;
    await updateVenue(db, first.actor, { ...venue, expectedRevision: venue.catalogRevision, minimumBookingMinutes: 15, openingHours: Array.from({ length: 7 }, (_, weekday) => ({ weekday, startMinute: 480, endMinute: 1320 })) });
    const court = await createCourt(db, first.actor, { venueId: first.venueId, name: "示例1号场", indoor: true });
    await setCourtPrice(db, first.actor, { venueId: first.venueId, courtId: court.id, expectedRevision: court.revision, hourlyPriceCents: 12000 });
    const customer = await createCustomer(db, first.actor, { nickname: "private-synthetic-customer", phone: "+8613800138000" });
    const quote = await createQuote(db, first.actor, { venueId: first.venueId, customerId: customer.id, lines: [{ courtId: court.id, startAt: "2099-09-18T19:00:00+08:00", endAt: "2099-09-18T20:00:00+08:00" }] });
    const order = await confirmQuote(db, first.actor, { quoteId: quote.id, commandKey: randomUUID() });
    const conversation = await createBackofficeConversation(db, first.actor, first.venueId), snapshots: ModelInput[] = [];
    const execute = backofficeExecutor(db, first.actor, async (input) => {
      snapshots.push(structuredClone(input));
      if (snapshots.length > 1) return { content: "当前订单正在等待付款，可以打开订单页核对。" };
      return { content: null, tool_calls: [
        { id: "schedule", type: "function", function: { name: "get_schedule", arguments: '{"date":"2099-09-18"}' } },
        { id: "order", type: "function", function: { name: "get_current_order", arguments: '{}' } },
        { id: "open", type: "function", function: { name: "open_page", arguments: '{"page":"orders"}' } },
      ] };
    });
    const result = await sendBackofficeMessage(db, first.actor, key, conversation.id, { messageId: randomUUID(), content: "查询当前订单和当天排场", context: { page: "orders", orderId: order.id } }, execute);
    expect(result.requests[0]?.status).toBe("SUCCEEDED");
    const modelInput = JSON.stringify(snapshots);
    for (const privateValue of [first.actor.tenantId, first.venueId, court.id, customer.id, customer.nickname, customer.phone!, order.id]) expect(modelInput).not.toContain(privateValue);
    expect(modelInput).toContain("示例1号场");
    expect(modelInput).toContain("busyIntervals");
    expect(result.messages.at(-1)?.actions).toEqual([{ page: "orders", orderId: order.id, label: "查看订单详情" }]);
    expect((await db.query("SELECT status,payment_status FROM tennis.orders WHERE tenant_id=$1 AND id=$2", [first.actor.tenantId, order.id])).rows[0]).toEqual({ status: "HELD", payment_status: "UNPAID" });
  });
  it("HTTP distinguishes saved configuration from an enabled connection and enforces session/CSRF/platform boundaries", async () => {
    const config = await configure();
    const password = "synthetic-backoffice-test-password", username = `bo_${randomUUID()}`;
    const account = await createLocalAccount(db, { username, password, displayName: "合成只读运营人员", tenantId: first.actor.tenantId, role: "VIEWER", permissions: ["read"], allVenues: true, platformOperator: true });
    subjects.push(account.subjectId);
    const session = await login(db, { username, password });
    const context = await selectSessionContext(db, session.token, { tenantId: first.actor.tenantId, kind: "staff" });
    const headers = { cookie: `tennis_session=${session.token}`, "x-csrf-token": context.csrfToken, "x-workspace-version": String(context.contextVersion) };
    const app = await buildTennisServer({ db, gateway: new LocalMockPaymentGateway(randomBytes(32).toString("hex"), "local-simulation"), aiEncryptionKey: key, allowSimulation: true, runExpiryWorker: false });
    try {
      expect((await app.inject({ url: "/api/tennis/backoffice-assistant/status" })).statusCode).toBe(401);
      const status = await app.inject({ url: "/api/tennis/backoffice-assistant/status", headers });
      expect(status.json()).toEqual({ enabled: true, configReady: true, configured: false, connectionAvailable: false });
      const saved = await app.inject({ url: "/api/tennis/platform/ai-config", headers });
      expect(saved.json()).toMatchObject({ model: "synthetic-model", hasApiKey: true, connectionAvailable: false });
      expect(saved.body).not.toContain("synthetic-secret");
      expect((await app.inject({ method: "POST", url: "/api/tennis/platform/ai-config/test", headers: { cookie: headers.cookie }, payload: { expectedRevision: config.revision } })).statusCode).toBe(403);
      const unavailable = await app.inject({ method: "POST", url: "/api/tennis/platform/ai-config/test", headers, payload: { expectedRevision: config.revision } });
      expect(unavailable.json().error.code).toBe("BACKOFFICE_MODEL_CONNECTION_NOT_ENABLED");
      const conversation = await app.inject({ method: "POST", url: "/api/tennis/backoffice-assistant/conversations", headers, payload: { venueId: first.venueId } });
      expect(conversation.statusCode, conversation.body).toBe(200);
      const sent = await app.inject({ method: "POST", url: `/api/tennis/backoffice-assistant/conversations/${conversation.json().id}/messages`, headers, payload: { messageId: randomUUID(), content: "查询" } });
      expect(sent.json().error.code).toBe("BACKOFFICE_MODEL_CONNECTION_NOT_ENABLED");
      await db.query("UPDATE tennis.platform_operators SET active=false WHERE subject_id=$1", [account.subjectId]);
      expect((await app.inject({ url: "/api/tennis/platform/ai-config", headers })).statusCode).toBe(403);
    } finally { await app.close(); }
  });
  it("streams only owned conversations with CSRF and replays the same receipt without a second model call", async () => {
    await configure();
    const password = "synthetic-stream-test-password", username = `stream_${randomUUID()}`;
    const account = await createLocalAccount(db, { username, password, displayName: "合成流式验证", tenantId: first.actor.tenantId, role: "VIEWER", permissions: ["read"], allVenues: true });
    subjects.push(account.subjectId);
    const session = await login(db, { username, password });
    const context = await selectSessionContext(db, session.token, { tenantId: first.actor.tenantId, kind: "staff" });
    const headers = { cookie: `tennis_session=${session.token}`, "x-csrf-token": context.csrfToken, "x-workspace-version": String(context.contextVersion), accept: "text/event-stream" };
    const transport = vi.fn(async (input: ModelInput) => {
      (input as ModelInput & { onText?: (text: string) => void }).onText?.("已查询当前场馆。".repeat(12));
      return { content: "已查询当前场馆。".repeat(12) };
    });
    const app = await buildTennisServer({ db, gateway: new LocalMockPaymentGateway(randomBytes(32).toString("hex"), "local-simulation"), aiEncryptionKey: key, modelTransport: transport, allowSimulation: true, runExpiryWorker: false });
    try {
      const owned = await createBackofficeConversation(db, { tenantId: first.actor.tenantId, subjectId: account.subjectId }, first.venueId);
      const foreign = await createBackofficeConversation(db, first.actor, first.venueId);
      const url = `/api/tennis/backoffice-assistant/conversations/${owned.id}/messages`;
      const payload = { messageId: randomUUID(), content: "查询场馆" };
      expect((await app.inject({ method: "POST", url, payload, headers: { cookie: headers.cookie, accept: headers.accept } })).statusCode).toBe(403);
      const denied = await app.inject({ method: "POST", url: url.replace(owned.id, foreign.id), payload, headers });
      expect(denied.statusCode).toBe(404);
      expect(denied.headers["content-type"]).not.toContain("text/event-stream");
      expect(transport).not.toHaveBeenCalled();
      const result = await app.inject({ method: "POST", url, payload, headers });
      expect(result.statusCode).toBe(200);
      expect(result.headers["content-type"]).toContain("text/event-stream");
      const events = result.body.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)));
      expect(events.some((event) => event.type === "delta")).toBe(true);
      expect(events.at(-1).result.requests[0].status).toBe("SUCCEEDED");
      expect(result.body).not.toContain("synthetic-secret");
      const replay = await app.inject({ method: "POST", url, payload, headers });
      const final = JSON.parse(replay.body.trim().slice(6));
      expect(final.type).toBe("result");
      expect(final.result.messages).toEqual(events.at(-1).result.messages);
      expect(transport).toHaveBeenCalledTimes(1);
    } finally { await app.close(); }
  });
  it("ends a hung model execution and ignores a late answer without waiting for another GET", async () => {
    await configure();
    const conversation = await createBackofficeConversation(db, first.actor, first.venueId);
    let complete!: (value: { content: string; actions: [] }) => void, execution: BackofficeRun | undefined;
    const result = await sendBackofficeMessage(db, first.actor, key, conversation.id, { messageId: randomUUID(), content: "查询" }, async (run) => {
      execution = run;
      return new Promise((resolve) => { complete = resolve; });
    }, { timeoutMs: 20 });
    expect(result.requests[0]?.status).toBe("FAILED");
    expect(execution!.signal.aborted).toBe(true);
    await expect(execution!.authorize()).rejects.toMatchObject({ code: "ASSISTANT_UNAVAILABLE" });
    complete({ content: "迟到的回答不能落库", actions: [] });
    expect((await getBackofficeConversation(db, first.actor, conversation.id)).messages).toHaveLength(1);
  });
  it("redacts split credential chunks and terminates cancelled generation without saving a late reply", async () => {
    await configure();
    const conversation = await createBackofficeConversation(db, first.actor, first.venueId);
    const streamed: unknown[] = [];
    const result = await sendBackofficeMessage(db, first.actor, key, conversation.id, { messageId: randomUUID(), content: "查询" }, async (run) => {
      run.onEvent?.({ type: "delta", text: "安全说明 synthetic-" });
      run.onEvent?.({ type: "delta", text: "secret" + "答复".repeat(50) });
      return { content: "安全说明 synthetic-secret", actions: [] };
    }, { onEvent: (event) => streamed.push(event) });
    expect(JSON.stringify(streamed)).not.toContain("synthetic-secret");
    expect(result.messages.at(-1)?.content).toContain("[已隐藏凭证]");
    const controller = new AbortController();
    let late!: (result: { content: string; actions: [] }) => void;
    const stopped = await sendBackofficeMessage(db, first.actor, key, conversation.id, { messageId: randomUUID(), content: "停止测试" }, async () => {
      controller.abort(); return new Promise((resolve) => { late = resolve; });
    }, { signal: controller.signal });
    expect(stopped.requests[0]?.status).toBe("FAILED");
    late({ content: "不能落库的迟到回答", actions: [] });
    expect((await getBackofficeConversation(db, first.actor, conversation.id)).messages.some((m) => m.content === "不能落库的迟到回答")).toBe(false);
  });
  it("validates local actions at the persistence boundary and rejects secrets, extra fields and unauthorized ids", async () => {
    await configure();
    const conversation = await createBackofficeConversation(db, first.actor, first.venueId);
    for (const action of [
      { page: "orders", label: "synthetic-secret" },
      { page: "orders", label: "查看", debug: "synthetic-secret" },
      { page: "orders", label: "查看", orderId: randomUUID() },
      { page: "https://evil.example", label: "查看" },
    ]) {
      const result = await sendBackofficeMessage(db, first.actor, key, conversation.id, { messageId: randomUUID(), content: "查询" }, async () => ({ content: "提供入口", actions: [action] as never }));
      expect(result.requests[0]?.status).toBe("FAILED");
    }
    const messages = (await getBackofficeConversation(db, first.actor, conversation.id)).messages;
    expect(messages.every((message) => message.role === "USER")).toBe(true);
    expect(JSON.stringify(messages)).not.toContain("synthetic-secret");
  });
  async function assistantFixture() {
    await configure();
    const venue = (await listVenues(db, first.actor))[0]!;
    await updateVenue(db, first.actor, { ...venue, expectedRevision: venue.catalogRevision, minimumBookingMinutes: 60, openingHours: Array.from({ length: 7 }, (_, weekday) => ({ weekday, startMinute: 480, endMinute: 1320 })) });
    const court = await createCourt(db, first.actor, { venueId: first.venueId, name: "助手测试场", indoor: true });
    await setCourtPrice(db, first.actor, { venueId: first.venueId, courtId: court.id, expectedRevision: court.revision, hourlyPriceCents: 12000 });
    const line = { courtId: court.id, startAt: "2099-09-18T11:00:00.000Z", endAt: "2099-09-18T12:00:00.000Z" };
    const conversation = await createBackofficeConversation(db, first.actor, first.venueId);
    const run: BackofficeRun = { config: { model: "test", baseUrl: "https://example.test/v1", apiKey: "test" }, history: [], context: { page: "booking", date: "2099-09-18", viewDays: 3, selection: [line] }, venue: { id: first.venueId, name: venue.name, timezone: venue.timezone }, authorize: async () => {}, signal: new AbortController().signal };
    return { court, line, conversation, run };
  }
  it("uses real selected slots to prepare a persisted booking action without creating inventory or orders", async () => {
    const { line, conversation, run } = await assistantFixture();
    const snapshots: ModelInput[] = [];
    const execute = backofficeExecutor(db, first.actor, async (input) => {
      snapshots.push(structuredClone(input));
      return snapshots.length === 1 ? { content: null, tool_calls: [
        { id: "ctx", type: "function", function: { name: "get_work_context", arguments: "{}" } },
        { id: "prepare", type: "function", function: { name: "prepare_booking", arguments: '{"source":"selection"}' } },
      ] } : { content: "已准备，请在预订表单核对客户和正式报价后确认。" };
    });
    const result = await sendBackofficeMessage(db, first.actor, key, conversation.id, { messageId: randomUUID(), content: "准备已选时段", context: run.context }, execute);
    expect(result.requests[0]?.status).toBe("SUCCEEDED");
    expect(result.messages.at(-1)?.actions[0]).toMatchObject({ page: "schedule", preparation: { kind: "booking", lines: [line] } });
    expect(JSON.stringify(snapshots)).toContain("助手测试场");
    expect(JSON.stringify(snapshots)).not.toContain(line.courtId);
    expect((await db.query("SELECT count(*)::int AS n FROM tennis.orders WHERE tenant_id=$1", [first.actor.tenantId])).rows[0].n).toBe(0);
    expect((await db.query("SELECT count(*)::int AS n FROM tennis.occupancies WHERE tenant_id=$1", [first.actor.tenantId])).rows[0].n).toBe(0);
  });
  it("rejects a foreign court or malformed context before any model call", async () => {
    const { conversation, run, line } = await assistantFixture();
    const foreign = await createCourt(db, second.actor, { venueId: second.venueId, name: "另一租户", indoor: true });
    const execute = vi.fn(reply);
    await expect(sendBackofficeMessage(db, first.actor, key, conversation.id, { messageId: randomUUID(), content: "查询", context: { ...run.context, selection: [{ ...line, courtId: foreign.id }] } }, execute)).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    await expect(sendBackofficeMessage(db, first.actor, key, conversation.id, { messageId: randomUUID(), content: "查询", context: { ...run.context, date: "2099-02-31" } }, execute)).rejects.toMatchObject({ code: "INVALID_AGENT_MESSAGE" });
    expect(execute).not.toHaveBeenCalled();
  });
  it("blocks occupied, closed, duplicate and non-grid preparations and respects read-only roles", async () => {
    const { run, line } = await assistantFixture();
    const customer = await createCustomer(db, first.actor, { nickname: "助手准备验证" });
    const quote = await createQuote(db, first.actor, { venueId: first.venueId, customerId: customer.id, lines: [line] });
    await confirmQuote(db, first.actor, { quoteId: quote.id, commandKey: randomUUID() });
    await expect(prepareAssistantAction(db, first.actor, run, "prepare_booking", { source: "selection" })).rejects.toThrow("已有占用");
    await expect(prepareAssistantAction(db, first.actor, run, "prepare_booking", { source: "specified", courtNames: "助手测试场", startAt: "2099-09-18T02:00:00+08:00", endAt: "2099-09-18T03:00:00+08:00" })).rejects.toThrow("营业时间");
    await expect(prepareAssistantAction(db, first.actor, run, "prepare_booking", { source: "specified", courtNames: "助手测试场", startAt: "2099-09-18T09:01:00+08:00", endAt: "2099-09-18T10:01:00+08:00" })).rejects.toThrow();
    await expect(prepareAssistantAction(db, first.actor, run, "prepare_booking", { source: "specified", courtNames: "助手测试场,助手测试场", startAt: "2099-09-18T09:00:00+08:00", endAt: "2099-09-18T10:00:00+08:00" })).rejects.toThrow("相互重叠");
    await db.query("UPDATE tennis.tenant_memberships SET role='VIEWER',permissions=ARRAY['read']::text[] WHERE tenant_id=$1 AND subject_id=$2", [first.actor.tenantId, first.actor.subjectId]);
    await expect(prepareAssistantAction(db, first.actor, run, "prepare_booking", { source: "selection" })).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
  });
  it("prepares an order amendment and reason but never applies it or takes payment", async () => {
    const { run, line } = await assistantFixture();
    const customer = await createCustomer(db, first.actor, { nickname: "助手改期验证" });
    const quote = await createQuote(db, first.actor, { venueId: first.venueId, customerId: customer.id, lines: [line] });
    const order = await confirmQuote(db, first.actor, { quoteId: quote.id, commandKey: randomUUID() });
    run.context = { page: "orders", orderId: order.id };
    const prepared = await prepareAssistantAction(db, first.actor, run, "prepare_order_action", { action: "amend", lineIndex: "1", courtNames: "助手测试场", startAt: "2099-09-18T20:00:00+08:00", endAt: "2099-09-18T21:00:00+08:00", reason: "客户要求晚一小时" });
    expect(prepared).toMatchObject({ orderId: order.id, preparation: { kind: "amend", reason: "客户要求晚一小时", lineId: order.lines[0]!.id } });
    expect((await prepareAssistantAction(db, first.actor, run, "prepare_order_action", { action: "pay" })).preparation?.kind).toBe("pay");
    await expect(prepareAssistantAction(db, first.actor, run, "prepare_order_action", { action: "refund" })).rejects.toThrow("付款记录");
    const current = (await db.query("SELECT status,payment_status FROM tennis.orders WHERE tenant_id=$1 AND id=$2", [first.actor.tenantId, order.id])).rows[0];
    expect(current).toEqual({ status: "HELD", payment_status: "UNPAID" });
    expect((await db.query("SELECT count(*)::int AS n FROM tennis.order_amendments WHERE tenant_id=$1", [first.actor.tenantId])).rows[0].n).toBe(0);
  });

});
