import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assertLocalTennisDatabaseUrl, localTennisTestDatabaseUrl } from "../../packages/db/src/tennis/local-config.ts";
import { migrateTennis } from "../../packages/db/src/tennis/migrate.ts";
import { createBackofficeConversation, getBackofficeAIConfig, saveBackofficeAIConfig, sendBackofficeMessage, setBackofficeMessageFeedback } from "../../packages/db/src/tennis/backoffice-assistant.ts";
import { backofficeExecutor } from "../../apps/api/src/tennis/backoffice-model.ts";
import { createLocalAccount, login, selectSessionContext } from "../../packages/db/src/tennis/auth.ts";
import { buildTennisServer } from "../../apps/api/src/tennis/server.ts";
import { LocalMockPaymentGateway } from "../../packages/db/src/tennis/mock-payments.ts";
import { beginAssistantQuestion, maintainAssistantQuestions } from "../../packages/db/src/tennis/assistant-question-records.ts";
import { removeTenantFixture, seedTenantFixture, type TenantFixture } from "./tenant-fixture.ts";

const db = new pg.Pool({ connectionString: assertLocalTennisDatabaseUrl(localTennisTestDatabaseUrl, "test"), max: 8, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
const key = randomBytes(32);
let first: TenantFixture, second: TenantFixture, previous: Record<string, unknown>;
const secret = "synthetic-model-secret";
const reply = async () => ({ content: "请在排场页核对。", actions: [] });
beforeAll(async () => { const tx = await db.connect(); try { await migrateTennis(tx); } finally { tx.release(); } });
beforeEach(async () => {
  previous = (await db.query("SELECT * FROM tennis.backoffice_ai_config WHERE singleton")).rows[0];
  first = await seedTenantFixture(db); second = await seedTenantFixture(db);
  await db.query("INSERT INTO tennis.platform_operators(subject_id) VALUES($1)", [first.actor.subjectId]);
  const config = await getBackofficeAIConfig(db, first.actor.subjectId);
  await saveBackofficeAIConfig(db, first.actor.subjectId, key, { enabled: true, model: "synthetic-model", baseUrl: "https://model.example.test/v1", apiKey: secret, expectedRevision: config.revision });
});
afterEach(async () => {
  await db.query("UPDATE tennis.backoffice_ai_config SET enabled=$1,model=$2,base_url=$3,encrypted_key=$4,revision=$5,updated_by=$6,updated_at=$7 WHERE singleton", [previous.enabled, previous.model, previous.base_url, previous.encrypted_key, previous.revision, previous.updated_by, previous.updated_at]);
  await db.query("DELETE FROM tennis.auth_audit_events WHERE subject_id=$1", [first.actor.subjectId]);
  await db.query("DELETE FROM tennis.platform_operators WHERE subject_id=$1", [first.actor.subjectId]);
  await removeTenantFixture(db, first); await removeTenantFixture(db, second);
});
afterAll(() => db.end());
async function records() { return (await db.query("SELECT * FROM tennis.ai_question_records WHERE tenant_id=$1 ORDER BY created_at", [first.actor.tenantId])).rows; }
async function daily() { return (await db.query("SELECT * FROM tennis.ai_question_daily WHERE tenant_id=$1", [first.actor.tenantId])).rows; }

describe("后台助手的问题分析链路", () => {
  it("只记录脱敏问题和真实尝试的工具，重放不新增提问，反馈改评不重复累计", async () => {
    const conversation = await createBackofficeConversation(db, first.actor, first.venueId);
    const businessId = randomUUID();
    let calls = 0;
    const transport = vi.fn(async () => ++calls === 1 ? { content: null, tool_calls: [{ id: "pricing", type: "function" as const, function: { name: "get_discounts", arguments: "{}" } }] } : { content: "目前没有时段折扣。" });
    const input = { messageId: randomUUID(), source: "SUGGESTION" as const, content: `姓名：测试人，电话13800138000，订单${businessId}，密钥 ${secret}，明天1号场价格多少？`, context: { page: "booking" } };
    const execute = backofficeExecutor(db, first.actor, transport);
    const result = await sendBackofficeMessage(db, first.actor, key, conversation.id, input, execute);
    await sendBackofficeMessage(db, first.actor, key, conversation.id, { ...input, source: "USER" }, execute);
    expect(transport).toHaveBeenCalledTimes(2);
    const saved = await records();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ id: result.requests[0]!.id, venue_id: first.venueId, source: "SUGGESTION", page: "schedule", topic: "PRICING", outcome: "ANSWERED", feedback: "UNKNOWN", tools_used: ["get_discounts"] });
    for (const value of ["测试人", "13800138000", businessId, secret, "目前没有时段折扣"]) expect(JSON.stringify(saved)).not.toContain(value);
    expect(saved[0].duration_ms).toBeGreaterThanOrEqual(0);
    const answer = result.messages.find((m) => m.role === "ASSISTANT")!;
    await setBackofficeMessageFeedback(db, first.actor, conversation.id, answer.id, true);
    await setBackofficeMessageFeedback(db, first.actor, conversation.id, answer.id, true);
    await Promise.all([false, false].map((resolved) => setBackofficeMessageFeedback(db, first.actor, conversation.id, answer.id, resolved)));
    expect((await daily())[0]).toMatchObject({ question_count: "1", answered_count: "1", resolved_count: "0", unresolved_count: "1", pending_count: "0", failed_count: "0", interrupted_count: "0" });
    expect((await records())[0].feedback).toBe("UNRESOLVED");
    expect((await db.query("SELECT content FROM tennis.backoffice_messages WHERE request_id=$1 AND role='USER'", [saved[0].id])).rows[0].content).toBe(input.content);
  });

  it("模型失败、超时与主动停止记录安全的不同结果，旧客户端来源为 UNKNOWN", async () => {
    const conversation = await createBackofficeConversation(db, first.actor, first.venueId);
    await sendBackofficeMessage(db, first.actor, key, conversation.id, { messageId: randomUUID(), content: "怎么操作" }, async (run) => {
      run.onTool?.("get_schedule"); run.onTool?.("evil-private-name");
      throw new Error("private provider response secret@example.test");
    });
    await sendBackofficeMessage(db, first.actor, key, conversation.id, { messageId: randomUUID(), content: "怎么操作" }, async () => new Promise(() => {}), { timeoutMs: 10 });
    const controller = new AbortController();
    await sendBackofficeMessage(db, first.actor, key, conversation.id, { messageId: randomUUID(), content: "怎么操作" }, async () => {
      controller.abort(); return new Promise(() => {});
    }, { signal: controller.signal });
    const saved = await records();
    expect(saved.map((r) => [r.outcome, r.error_code, r.source])).toEqual([
      ["FAILED", "ASSISTANT_UNAVAILABLE", "UNKNOWN"], ["FAILED", "ASSISTANT_TIMEOUT", "UNKNOWN"], ["INTERRUPTED", "REQUEST_INTERRUPTED", "UNKNOWN"],
    ]);
    expect(saved[0].tools_used).toEqual(["get_schedule"]);
    expect(JSON.stringify(saved)).not.toContain("private provider");
    expect((await daily())[0]).toMatchObject({ question_count: "3", answered_count: "0", failed_count: "2", interrupted_count: "1", pending_count: "0" });
  });

  it("未获授权的提问和他人的反馈不能新增或改写分析记录", async () => {
    const conversation = await createBackofficeConversation(db, first.actor, first.venueId);
    const result = await sendBackofficeMessage(db, first.actor, key, conversation.id, { messageId: randomUUID(), content: "查空场" }, reply);
    const answer = result.messages.find((m) => m.role === "ASSISTANT")!;
    await db.query("INSERT INTO tennis.tenant_memberships(tenant_id,subject_id,role) VALUES($1,$2,'ADMIN')", [first.actor.tenantId, second.actor.subjectId]);
    try {
      const colleague = { tenantId: first.actor.tenantId, subjectId: second.actor.subjectId };
      for (const actor of [second.actor, colleague]) {
        await expect(sendBackofficeMessage(db, actor, key, conversation.id, { messageId: randomUUID(), content: "未授权正文" }, reply)).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
        await expect(setBackofficeMessageFeedback(db, actor, conversation.id, answer.id, false)).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
      }
      expect(await records()).toHaveLength(1);
      expect((await records())[0].feedback).toBe("UNKNOWN");
    } finally { await db.query("DELETE FROM tennis.tenant_memberships WHERE tenant_id=$1 AND subject_id=$2", [first.actor.tenantId, second.actor.subjectId]); }
  });

  it("分析插入、结果和反馈的 SQL 故障均不破坏聊天事务，仅输出固定诊断码", async () => {
    const conversation = await createBackofficeConversation(db, first.actor, first.venueId), log = vi.fn();
    const suffix = randomUUID().replaceAll("-", ""), fn = `test_question_fault_${suffix}`, trigger = `test_question_fault_${suffix}`;
    const install = async (event: string) => {
      await db.query(`DROP TRIGGER IF EXISTS ${trigger} ON tennis.ai_question_records`);
      await db.query(`CREATE TRIGGER ${trigger} BEFORE ${event} ON tennis.ai_question_records FOR EACH ROW WHEN (NEW.tenant_id='${first.actor.tenantId}') EXECUTE FUNCTION tennis.${fn}()`);
    };
    await db.query(`CREATE FUNCTION tennis.${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic private SQL failure'; END $$`);
    try {
      await install("INSERT");
      const sent = await sendBackofficeMessage(db, first.actor, key, conversation.id, { messageId: randomUUID(), content: "查空场" }, reply, { questionLogger: log });
      expect(sent.requests[0]!.status).toBe("SUCCEEDED");
      expect(await records()).toHaveLength(0);
      expect(log).toHaveBeenLastCalledWith("AI_QUESTION_RECORD_FAILED");
      await install("UPDATE OF outcome");
      const finished = await sendBackofficeMessage(db, first.actor, key, conversation.id, { messageId: randomUUID(), content: "查空场" }, reply, { questionLogger: log });
      expect(finished.requests[0]!.status).toBe("SUCCEEDED");
      expect((await records())[0].outcome).toBe("PENDING");
      expect(log).toHaveBeenLastCalledWith("AI_QUESTION_FINISH_FAILED");
      await install("UPDATE OF feedback");
      const answered = await sendBackofficeMessage(db, first.actor, key, conversation.id, { messageId: randomUUID(), content: "查空场" }, reply, { questionLogger: log });
      const message = answered.messages.filter((m) => m.role === "ASSISTANT").at(-1)!;
      expect(await setBackofficeMessageFeedback(db, first.actor, conversation.id, message.id, false, log)).toEqual({ id: message.id, resolved: false });
      expect((await records()).at(-1)!.feedback).toBe("UNKNOWN");
      expect(log).toHaveBeenLastCalledWith("AI_QUESTION_FEEDBACK_FAILED");
      expect(JSON.stringify(log.mock.calls)).not.toContain("private SQL");
    } finally {
      await db.query(`DROP TRIGGER IF EXISTS ${trigger} ON tennis.ai_question_records`);
      await db.query(`DROP FUNCTION tennis.${fn}()`);
    }
  });

  it("HTTP 的流式与普通请求均携带来源，错误来源在接受提问前被拒绝", async () => {
    const account = await createLocalAccount(db, { username: `analytics_${randomUUID()}`, password: "synthetic-test-password", displayName: "合成工作人员", tenantId: first.actor.tenantId, role: "VIEWER", permissions: ["read"], allVenues: true });
    const session = await login(db, { username: account.username, password: "synthetic-test-password" });
    const context = await selectSessionContext(db, session.token, { tenantId: first.actor.tenantId, kind: "staff" });
    const headers = { cookie: `tennis_session=${session.token}`, "x-csrf-token": context.csrfToken, "x-workspace-version": String(context.contextVersion) };
    const app = await buildTennisServer({ db, gateway: new LocalMockPaymentGateway(randomBytes(32).toString("hex"), "local-simulation"), allowSimulation: true, aiEncryptionKey: key, modelTransport: async () => ({ content: "合成回答" }), runExpiryWorker: false });
    try {
      const conversation = await createBackofficeConversation(db, { tenantId: first.actor.tenantId, subjectId: account.subjectId }, first.venueId);
      const url = `/api/tennis/backoffice-assistant/conversations/${conversation.id}/messages`;
      const invalid = await app.inject({ method: "POST", url, headers, payload: { messageId: randomUUID(), content: "查询", source: "PRIVATE_SOURCE" } });
      expect(invalid.statusCode).toBe(400);
      for (const source of ["USER", "SUGGESTION"] as const) {
        const result = await app.inject({ method: "POST", url, headers: { ...headers, ...(source === "SUGGESTION" ? { accept: "text/event-stream" } : {}) }, payload: { messageId: randomUUID(), content: "查询", source } });
        expect(result.statusCode, result.body).toBe(200);
      }
      expect((await records()).map((r) => r.source)).toEqual(["USER", "SUGGESTION"]);
    } finally {
      await app.close();
      await db.query("DELETE FROM tennis.auth_sessions WHERE subject_id=$1", [account.subjectId]);
      await db.query("DELETE FROM tennis.auth_audit_events WHERE subject_id=$1", [account.subjectId]);
      await db.query("DELETE FROM tennis.audit_events WHERE subject_id=$1", [account.subjectId]);
      await db.query("DELETE FROM tennis.backoffice_conversations WHERE subject_id=$1", [account.subjectId]);
      await db.query("DELETE FROM tennis.local_accounts WHERE subject_id=$1", [account.subjectId]);
      await db.query("DELETE FROM tennis.tenant_memberships WHERE subject_id=$1", [account.subjectId]);
      await db.query("DELETE FROM tennis.subjects WHERE id=$1", [account.subjectId]);
    }
  });

  it("分析表被锁定时仍能完成回答，维护超时可诊断且不留下等待中的 SQL", async () => {
    const conversation = await createBackofficeConversation(db, first.actor, first.venueId), log = vi.fn();
    const locker = await db.connect();
    await locker.query("BEGIN");
    try {
      await locker.query("LOCK TABLE tennis.ai_question_records IN ACCESS EXCLUSIVE MODE");
      const start = Date.now();
      const result = await sendBackofficeMessage(db, first.actor, key, conversation.id, { messageId: randomUUID(), content: "怎么操作" }, reply, { questionLogger: log });
      expect(result.requests[0]!.status).toBe("SUCCEEDED");
      expect(Date.now() - start).toBeLessThan(5000);
      expect(log.mock.calls).toEqual([["AI_QUESTION_RECORD_FAILED"], ["AI_QUESTION_FINISH_FAILED"]]);
      await maintainAssistantQuestions(db, log);
      expect(log).toHaveBeenLastCalledWith("AI_QUESTION_MAINTENANCE_FAILED");
      const waiting = await locker.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%tennis.ai_question_records%'");
      expect(waiting.rows[0].n).toBe(0);
    } finally { await locker.query("ROLLBACK"); locker.release(); }
  });

  it("分析保存点成功或失败后恢复原事务的超时设置", async () => {
    const tx = await db.connect(), log = vi.fn();
    await tx.query("BEGIN");
    try {
      await tx.query("SET LOCAL statement_timeout='9s'");
      await tx.query("SET LOCAL lock_timeout='2s'");
      for (const source of ["USER", "invalid"] as const) {
        await beginAssistantQuestion(tx, { id: randomUUID(), tenantId: first.actor.tenantId, venueId: first.venueId, conversationId: randomUUID(), content: "怎么操作", page: "settings", source: source as "USER", secrets: [] }, log);
        expect((await tx.query("SELECT current_setting('statement_timeout') AS statement,current_setting('lock_timeout') AS lock")).rows[0]).toEqual({ statement: "9s", lock: "2s" });
      }
      expect(log.mock.calls).toEqual([["AI_QUESTION_RECORD_FAILED"]]);
    } finally { await tx.query("ROLLBACK"); tx.release(); }
  });
});
