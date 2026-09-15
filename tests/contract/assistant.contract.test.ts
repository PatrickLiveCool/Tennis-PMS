import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { createDatabase, databaseReady, type Database } from "@qintopia/db";
import { sql } from "kysely";
import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../../apps/api/src/server.ts";
import { demo } from "../../packages/db/src/seed.ts";
import { resetDatabase } from "../helpers/database.ts";
import { runtimeDatabaseUrlForTesting } from "../helpers/runtime-database.ts";
import type { ModelInput, ModelTransport } from "../../apps/api/src/assistant-model.ts";
vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]) }));
const url = process.env.ASSISTANT_TEST_DATABASE_URL ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_ai_contract";
let owner: Kysely<Database>, runtime: Kysely<Database>, app: FastifyInstance, admin: string, staff: string;
const calls: ModelInput[] = [];
let mode = "guide";
let duringModel: (() => Promise<void>) | undefined;
const transport: ModelTransport = async input => {
  calls.push(input);
  if (duringModel) { const action = duringModel; duringModel = undefined; await action(); }
  if (mode === "fail") throw new Error("DO-NOT-LEAK synthetic-provider-key");
  if (input.toolChoice) return { content: null, tool_calls: [{ id: "ping", type: "function", function: { name: "connection_check", arguments: '{"ok":true}' } }] };
  if (mode === "unknown") return { content: null, tool_calls: [{ id: "evil", type: "function", function: { name: "execute_sql", arguments: '{"sql":"DELETE FROM orders"}' } }] };
  const last = input.messages.at(-1);
  if (last?.role === "tool") return { content: "已找到操作入口，请在正式页面核对并操作。" };
  const name = mode === "members" ? "search_members" : mode === "cross" ? "order_details" : "open_entry";
  const args = mode === "members" ? { query: "Demo" } : mode === "cross" ? { orderId: "foreign-order-id" } : { page: "members" };
  return { content: null, tool_calls: [{ id: "call-1", type: "function", function: { name, arguments: JSON.stringify(args) } }] };
};
const cookies = (value: string) => ({ qintopia_session: value });
const settingsBody = (extra: object = {}) => ({ propertyId: demo.propertyId, expectedVersion: 0, enabled: true, baseUrl: "https://model.example.com/v1", model: "synthetic-model", apiKey: "synthetic-provider-key", ...extra });
let peer = 10;
// Keep HTTP rate buckets independent; concurrency tests still share the authenticated subject.
const chat = (value = staff, extra: object = {}) => app.inject({ method: "POST", remoteAddress: `127.0.0.${++peer}`, url: "/api/v1/assistant/chat", cookies: cookies(value), payload: { propertyId: demo.propertyId, message: "请打开会员入口", page: "房态", ...extra } });
const feedback = (questionId: string, value = staff, choice = "RESOLVED", propertyId: string = demo.propertyId) => app.inject({ method: "POST", url: `/api/v1/assistant/questions/${questionId}/feedback`, cookies: cookies(value), payload: { propertyId, feedback: choice } });
const rows = async () => (await sql<Record<string, unknown>>`SELECT * FROM ai_question_records ORDER BY created_at`.execute(owner)).rows;
const totals = async () => (await sql<{ questions: number; answered: number; pending: number; interrupted: number; resolved: number; unresolved: number }>`SELECT coalesce(sum(question_count),0)::int AS questions, coalesce(sum(answered_count),0)::int AS answered,
  coalesce(sum(pending_count),0)::int AS pending, coalesce(sum(interrupted_count),0)::int AS interrupted,
  coalesce(sum(resolved_count),0)::int AS resolved, coalesce(sum(unresolved_count),0)::int AS unresolved FROM ai_question_daily`.execute(owner)).rows[0]!;
beforeAll(async () => {
  vi.stubEnv("AI_SETTINGS_ENCRYPTION_KEY", randomBytes(32).toString("base64")); vi.stubEnv("LOG_LEVEL", "silent"); vi.stubEnv("STAFF_PROFILE_MANIFEST_NAME", "demo");
  owner = await resetDatabase(url); runtime = createDatabase(runtimeDatabaseUrlForTesting(url));
  app = await buildServer(runtime, { assistantTransport: transport });
  for (const name of ["admin", "operator"]) {
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: name, password: "demo-pass-2026" } }); expect(login.statusCode, login.body).toBe(200);
    const value = login.cookies.find(c => c.name === "qintopia_session")!.value; if (name === "admin") admin = value; else staff = value;
  }
}, 120_000);
afterAll(async () => { await app?.close(); await runtime?.destroy(); await owner?.destroy(); vi.unstubAllEnvs(); });
describe.sequential("AI assistant authenticated contract", () => {
  it("keeps database readiness valid after additive migration", async () => expect(await databaseReady(runtime)).toBe(true));
  it("rejects unauthenticated and staff configuration writes", async () => {
    const anonymous = await app.inject({ url: `/api/v1/assistant/settings?propertyId=${demo.propertyId}` }); expect(anonymous.statusCode).toBe(401);
    const response = await app.inject({ method: "PUT", url: "/api/v1/assistant/settings", cookies: cookies(staff), payload: settingsBody() }); expect(response.statusCode).toBe(403);
  });
  it("tests tool compatibility without persisting anything", async () => {
    const response = await app.inject({ method: "POST", url: "/api/v1/assistant/test", cookies: cookies(admin), payload: settingsBody() }); expect(response.statusCode, response.body).toBe(200);
    expect(await owner.selectFrom("ai_model_settings").selectAll().execute()).toEqual([]);
  });
  it("encrypts secrets, masks responses and denies direct runtime writes", async () => {
    const response = await app.inject({ method: "PUT", url: "/api/v1/assistant/settings", cookies: cookies(admin), payload: settingsBody() }); expect(response.statusCode, response.body).toBe(200); expect(response.body).not.toContain("synthetic-provider-key"); expect(response.json().version).toBe(1);
    const row = await owner.selectFrom("ai_model_settings").selectAll().executeTakeFirstOrThrow(); expect(row.encrypted_key).not.toContain("synthetic-provider-key");
    const audit = await sql`SELECT * FROM ai_settings_audit`.execute(owner); expect(JSON.stringify(audit.rows)).not.toContain("synthetic-provider-key");
    await expect(sql`UPDATE ai_model_settings SET model='bypass'`.execute(runtime)).rejects.toThrow("permission denied");
    const staffSettings = await app.inject({ url: `/api/v1/assistant/settings?propertyId=${demo.propertyId}`, cookies: cookies(staff) }); expect(staffSettings.json()).toMatchObject({ canManage: false, baseUrl: "", model: "", hasKey: false });
  });
  it("rejects stale saves, cross-origin requests and Key reuse at a changed host", async () => {
    const stale = await app.inject({ method: "PUT", url: "/api/v1/assistant/settings", cookies: cookies(admin), payload: settingsBody() }); expect(stale.statusCode).toBe(409);
    const cross = await app.inject({ method: "PUT", url: "/api/v1/assistant/settings", cookies: cookies(admin), headers: { origin: "https://evil.example" }, payload: settingsBody({ expectedVersion: 1 }) }); expect(cross.statusCode).toBe(403);
    const changed = settingsBody({ expectedVersion: 1, baseUrl: "https://another.example/v1" }); delete (changed as { apiKey?: string }).apiKey;
    const response = await app.inject({ method: "PUT", url: "/api/v1/assistant/settings", cookies: cookies(admin), payload: changed }); expect(response.statusCode).toBe(400);
  });
  it("opens a whitelisted entry through a real tool loop without writing business commands", async () => {
    mode = "guide"; calls.length = 0;
    const before = await owner.selectFrom("command_executions").selectAll().execute();
    const response = await chat(); expect(response.statusCode, response.body).toBe(200); expect(response.json().entries[0].page).toBe("members"); expect(calls).toHaveLength(2); expect(calls[1]!.messages.some(m => m.role === "tool")).toBe(true);
    expect(await owner.selectFrom("command_executions").selectAll().execute()).toHaveLength(before.length);
    const foreignConversation = await chat(admin, { conversationId: response.json().conversationId }); expect(foreignConversation.statusCode).toBe(400);
  });
  it("rejects other properties, unknown write tools and unavailable orders", async () => {
    const other = await chat(staff, { propertyId: "other-property" }); expect(other.statusCode).toBe(403);
    mode = "unknown"; const unknown = await chat(); expect(unknown.statusCode).toBe(400);
    mode = "cross"; const cross = await chat(); expect(cross.statusCode).toBe(404);
  });
  it("never relays provider errors containing secrets", async () => {
    mode = "fail"; const response = await chat(); expect(response.statusCode).toBe(400); expect(response.body).not.toContain("DO-NOT-LEAK"); expect(response.body).not.toContain("synthetic-provider-key");
  });
  it("projects members without full phone or identity documents", async () => {
    mode = "members"; calls.length = 0;
    const response = await chat(); expect(response.statusCode, response.body).toBe(200);
    const toolMessage = calls[1]!.messages.find(m => m.role === "tool")!.content!;
    expect(toolMessage).toContain(demo.memberId); expect(toolMessage).not.toContain("13800000000"); expect(toolMessage).not.toContain("DEMO-ID");
  });
  it("does not accept bearer tokens for chat or settings", async () => {
    const response = await app.inject({ method: "POST", url: "/api/v1/assistant/chat", headers: { authorization: `Bearer ${demo.administratorWriteToken}` }, payload: { propertyId: demo.propertyId, message: "查房态", page: "房态" } });
    expect(response.statusCode).toBe(403);
  });
  it("rechecks a revoked session after model returns, before returning any result", async () => {
    mode = "guide";
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "operator", password: "demo-pass-2026" } });
    const temporaryCookie = login.cookies.find(c => c.name === "qintopia_session")!.value;
    duringModel = async () => { const logout = await app.inject({ method: "POST", url: "/api/v1/auth/logout", cookies: cookies(temporaryCookie) }); expect(logout.statusCode).toBe(204); };
    const response = await chat(temporaryCookie); expect(response.statusCode).toBe(401); expect(response.json()).not.toHaveProperty("entries");
    expect((await rows()).at(-1)).toMatchObject({ outcome: "FAILED", error_code: "AUTHENTICATION_REQUIRED" });
  });
  it("blocks concurrent work for the same user even across new conversations", async () => {
    mode = "guide";
    duringModel = async () => { const concurrent = await chat(); expect(concurrent.statusCode).toBe(429); };
    const response = await chat(); expect(response.statusCode, response.body).toBe(200);
  });
  it("persists redacted questions, controlled context, source and outcomes without business writes", async () => {
    mode = "guide";
    const before = await totals();
    const response = await chat(staff, { source: "USER", page: "订单详情", message: "姓名：张三，13800000000，续住 2 晚，apiKey: private-short-key" });
    expect(response.statusCode, response.body).toBe(200); expect(response.json().questionId).toBeTruthy();
    const row = (await rows()).find(r => r.id === response.json().questionId)!;
    expect(row).toMatchObject({ source: "USER", page: "order", topic: "STAY_EXTENSION", outcome: "ANSWERED", feedback: "UNKNOWN", tools_used: ["open_entry"] });
    expect(String(row.question_redacted)).toContain("续住 2 晚");
    for (const sensitive of ["张三", "13800000000", "private-short-key"]) expect(JSON.stringify(row)).not.toContain(sensitive);
    expect((await totals()).questions).toBe(before.questions + 1);
    expect((await totals()).answered).toBe(before.answered + 1);
    const suggested = await chat(staff, { source: "SUGGESTION" }); expect(suggested.statusCode).toBe(200);
    const legacy = await chat(); expect(legacy.statusCode).toBe(200);
    expect((await rows()).find(r => r.id === suggested.json().questionId)?.source).toBe("SUGGESTION");
    expect((await rows()).find(r => r.id === legacy.json().questionId)?.source).toBe("UNKNOWN");
  });
  it("records safe failure codes but rejects unauthenticated input before persistence", async () => {
    const count = (await rows()).length;
    const unauthenticated = await chat("invalid-session"); expect(unauthenticated.statusCode).toBe(401);
    const outside = await chat(staff, { propertyId: "outside" }); expect(outside.statusCode).toBe(403);
    const invalidSource = await chat(staff, { source: "invented" }); expect(invalidSource.statusCode).toBe(400);
    expect(await rows()).toHaveLength(count);
    mode = "fail"; const failed = await chat(); expect(failed.statusCode).toBe(400);
    expect((await rows()).at(-1)).toMatchObject({ outcome: "FAILED", error_code: "VALIDATION_ERROR", feedback: "UNKNOWN" });
    expect(JSON.stringify(await rows())).not.toContain("DO-NOT-LEAK");
    const invalidConversation = await chat(staff, { conversationId: "private-conversation-value" }); expect(invalidConversation.statusCode).toBe(400);
    expect(JSON.stringify(await rows())).not.toContain("private-conversation-value");
    mode = "guide";
  });
  it("continues answering when telemetry cannot start, without retrying the model", async () => {
    mode = "guide"; calls.length = 0;
    await sql`REVOKE EXECUTE ON FUNCTION qintopia_begin_ai_question(text,text,text,text,text,text,text,text,text,text) FROM qintopia_runtime`.execute(owner);
    try {
      const response = await chat(); expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).not.toHaveProperty("questionId"); expect(calls).toHaveLength(2);
    } finally { await sql`GRANT EXECUTE ON FUNCTION qintopia_begin_ai_question(text,text,text,text,text,text,text,text,text,text) TO qintopia_runtime`.execute(owner); }
  });
  it("updates only the owner's feedback and keeps concurrent/repeated aggregate counts exact", async () => {
    mode = "guide"; const question = (await chat()).json().questionId as string;
    const before = await totals();
    const responses = await Promise.all([feedback(question), feedback(question), feedback(question)]);
    for (const response of responses) expect(response.statusCode, response.body).toBe(200);
    expect((await totals()).resolved).toBe(before.resolved + 1);
    expect((await feedback(question, staff, "UNRESOLVED")).statusCode).toBe(200);
    expect((await totals()).resolved).toBe(before.resolved);
    expect((await totals()).unresolved).toBe(before.unresolved + 1);
    expect((await feedback(question, admin)).statusCode).toBe(404);
    expect((await feedback(question, staff, "RESOLVED", "outside")).statusCode).toBe(403);
    expect((await feedback(question, "invalid-session")).statusCode).toBe(401);
    const cross = await app.inject({ method: "POST", url: `/api/v1/assistant/questions/${question}/feedback`, cookies: cookies(staff), headers: { origin: "https://evil.example" }, payload: { propertyId: demo.propertyId, feedback: "RESOLVED" } }); expect(cross.statusCode).toBe(403);
    const bearer = await app.inject({ method: "POST", url: `/api/v1/assistant/questions/${question}/feedback`, headers: { authorization: `Bearer ${demo.administratorWriteToken}` }, payload: { propertyId: demo.propertyId, feedback: "RESOLVED" } }); expect(bearer.statusCode).toBe(403);
    expect((await totals()).unresolved).toBe(before.unresolved + 1);
  });
  it("rejects feedback after session revocation, including at the database boundary", async () => {
    mode = "guide";
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "operator", password: "demo-pass-2026" } });
    const temporary = login.cookies.find(c => c.name === "qintopia_session")!.value;
    const question = (await chat(temporary)).json().questionId as string;
    const row = (await rows()).find(r => r.id === question)!;
    await app.inject({ method: "POST", url: "/api/v1/auth/logout", cookies: cookies(temporary) });
    expect((await feedback(question, temporary)).statusCode).toBe(401);
    await expect(sql`SELECT qintopia_feedback_ai_question(${question}, ${row.actor_subject_id}, ${row.actor_session_id}, ${demo.propertyId}, 'RESOLVED')`.execute(runtime)).rejects.toThrow("AI_QUESTION_FORBIDDEN");
  });
  it("denies runtime reads and arbitrary mutation, and exposes no record-list route", async () => {
    for (const table of ["ai_question_records", "ai_question_export", "ai_question_daily"]) {
      await expect(sql`SELECT * FROM ${sql.table(table)}`.execute(runtime)).rejects.toThrow("permission denied");
    }
    await expect(sql`DELETE FROM ai_question_records`.execute(runtime)).rejects.toThrow("permission denied");
    await expect(sql`UPDATE ai_question_daily SET question_count=0`.execute(runtime)).rejects.toThrow("permission denied");
    await expect(sql`SELECT qintopia_begin_ai_question('bad','forged','forged',${demo.propertyId},'bad','text','USER','unknown','OTHER','test')`.execute(runtime)).rejects.toThrow("AI_QUESTION_FORBIDDEN");
    expect((await app.inject({ url: "/api/v1/assistant/questions", cookies: cookies(admin) })).statusCode).toBe(404);
    await owner.transaction().execute(async trx => {
      await sql`SET LOCAL ROLE qintopia_ai_analytics_reader`.execute(trx);
      const exported = (await sql<Record<string, unknown>>`SELECT * FROM ai_question_export`.execute(trx)).rows;
      expect(exported.length).toBeGreaterThan(0);
      for (const row of exported) { expect(row).not.toHaveProperty("actor_subject_id"); expect(row).not.toHaveProperty("actor_session_id"); }
    });
    await expect(owner.transaction().execute(async trx => { await sql`SET LOCAL ROLE qintopia_ai_analytics_reader`.execute(trx); await sql`SELECT * FROM ai_question_records`.execute(trx); })).rejects.toThrow("permission denied");
    await expect(owner.transaction().execute(async trx => { await sql`SET LOCAL ROLE qintopia_ai_analytics_reader`.execute(trx); await sql`SELECT qintopia_maintain_ai_questions()`.execute(trx); })).rejects.toThrow("permission denied");
  });
  it("expires details and interrupts abandoned requests without erasing lifetime counts", async () => {
    const base = (await rows()).find(r => r.outcome === "ANSWERED")!;
    for (const [id, age, outcome] of [["retention-old", "91 days", "ANSWERED"], ["retention-abandoned", "91 days", "PENDING"], ["retention-keep", "89 days", "ANSWERED"], ["retention-pending", "11 minutes", "PENDING"]]) {
      await sql`INSERT INTO ai_question_records(id, property_id, actor_subject_id, actor_session_id, conversation_id, question_redacted, source, page, topic, application_version, created_at, outcome)
        VALUES (${id},${demo.propertyId},${base.actor_subject_id},${base.actor_session_id},'retention-fixture','合成保留测试','USER','unknown','OTHER','test',clock_timestamp()-${age}::interval,${outcome})`.execute(owner);
    }
    expect((await sql`SELECT * FROM ai_question_export WHERE id IN ('retention-old','retention-abandoned')`.execute(owner)).rows).toEqual([]);
    const before = await totals();
    await sql`SELECT qintopia_maintain_ai_questions()`.execute(runtime);
    const after = await totals(); expect(after.questions).toBe(before.questions); expect(after.pending).toBe(before.pending - 2); expect(after.interrupted).toBe(before.interrupted + 2);
    const remaining = await rows(); expect(remaining.some(r => r.id === "retention-old" || r.id === "retention-abandoned")).toBe(false);
    expect(remaining.find(r => r.id === "retention-keep")?.outcome).toBe("ANSWERED");
    expect(remaining.find(r => r.id === "retention-pending")?.outcome).toBe("INTERRUPTED");
    await sql`SELECT qintopia_maintain_ai_questions()`.execute(runtime); expect(await totals()).toEqual(after);
  });
  it("exports complete paginated snapshots with a read-only role, no identifiers and no overwrite", async () => {
    const base = (await rows())[0]!;
    await sql`INSERT INTO ai_question_records(id,property_id,actor_subject_id,actor_session_id,conversation_id,question_redacted,source,page,topic,application_version,outcome)
      SELECT 'export-boundary-'||n,${demo.propertyId},${base.actor_subject_id},${base.actor_session_id},'export-fixture','合成导出测试','USER','unknown','OTHER','test','ANSWERED' FROM generate_series(1,1005) n`.execute(owner);
    await sql`INSERT INTO ai_question_daily(property_id,recorded_day,topic,source,question_count,answered_count)
      SELECT ${demo.propertyId},(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date-n,'OTHER','UNKNOWN',1,1 FROM generate_series(1,1010) n ON CONFLICT DO NOTHING`.execute(owner);
    const directory = await mkdtemp(join(tmpdir(), "ai-export-contract-")), role = `ai_export_${randomUUID().replaceAll("-", "")}`;
    const roleUrl = new URL(url); roleUrl.username = role; roleUrl.password = "synthetic-export-only";
    const output = join(directory, "snapshot.jsonl");
    const run = (connection: string, path = output, extra: string[] = []) => promisify(execFile)(process.execPath,
      ["scripts/export-ai-questions.mjs", "--property", demo.propertyId, "--output", path, ...extra], { env: { ...process.env, AI_QUESTION_EXPORT_DATABASE_URL: connection } });
    await sql`CREATE ROLE ${sql.id(role)} LOGIN PASSWORD 'synthetic-export-only'`.execute(owner);
    await sql`GRANT qintopia_ai_analytics_reader TO ${sql.id(role)}`.execute(owner);
    try {
      await run(roleUrl.toString());
      const content = await readFile(output, "utf8"), snapshot = content.trim().split("\n").map(line => JSON.parse(line));
      expect(snapshot[0]).toMatchObject({ recordType: "manifest", schemaVersion: 1, snapshotType: "REPLACEMENT", propertyId: demo.propertyId });
      const questions = snapshot.filter(row => row.recordType === "question"), daily = snapshot.filter(row => row.recordType === "daily");
      expect(questions.length).toBe((await rows()).length); expect(new Set(questions.map(row => row.id)).size).toBe(questions.length);
      expect(daily.length).toBeGreaterThan(1000);
      expect(snapshot.at(-1)).toEqual({ recordType: "complete", questionCount: questions.length, dailyCount: daily.length });
      expect(content).not.toContain("actor_session_id"); expect(content).not.toContain("actor_subject_id");
      expect((await stat(output)).mode & 0o777).toBe(0o600);
      await expect(run(roleUrl.toString())).rejects.toThrow(); expect(await readFile(output, "utf8")).toBe(content);
      await expect(run(runtimeDatabaseUrlForTesting(url), join(directory, "denied.jsonl"))).rejects.toThrow();
      await expect(run(roleUrl.toString(), join(directory, "invalid.jsonl"), ["--from", "2026-02-30"])).rejects.toThrow();
      expect(await readdir(directory)).toEqual(["snapshot.jsonl"]);
    } finally { await sql`DROP ROLE ${sql.id(role)}`.execute(owner); await rm(directory, { recursive: true, force: true }); }
  });
  it("retains Key on same host, records versions and disables chat", async () => {
    mode = "guide";
    const body = settingsBody({ expectedVersion: 1, enabled: false }); delete (body as { apiKey?: string }).apiKey;
    const response = await app.inject({ method: "PUT", url: "/api/v1/assistant/settings", cookies: cookies(admin), payload: body }); expect(response.statusCode, response.body).toBe(200); expect(response.json()).toMatchObject({ version: 2, enabled: false, hasKey: true });
    const disabled = await chat(); expect(disabled.statusCode).toBe(400); expect(disabled.body).toContain("尚未启用");
  });
});
