import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertLocalTennisDatabaseUrl, localTennisTestDatabaseUrl } from "../../packages/db/src/tennis/local-config.ts";
import { migrateTennis } from "../../packages/db/src/tennis/migrate.ts";
import { removeTenantFixture, seedTenantFixture, type TenantFixture } from "./tenant-fixture.ts";

const db = new pg.Pool({ connectionString: assertLocalTennisDatabaseUrl(localTennisTestDatabaseUrl, "test"),
  max: 8, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
const readerGroup = "tennis_ai_analytics_reader";
const readerRoles: string[] = [];
let first: TenantFixture, second: TenantFixture;
let otherVenue: string;
beforeAll(async () => {
  const tx = await db.connect();
  try { await migrateTennis(tx); } finally { tx.release(); }
});
beforeEach(async () => {
  first = await seedTenantFixture(db);
  second = await seedTenantFixture(db);
  otherVenue = randomUUID();
  await db.query("INSERT INTO tennis.venues(id,tenant_id,name) VALUES($1,$2,'synthetic second venue')", [otherVenue, first.actor.tenantId]);
});
afterEach(async () => {
  await removeTenantFixture(db, first);
  await removeTenantFixture(db, second);
  for (const role of readerRoles.splice(0)) {
    // Names are locally generated alphanumeric identifiers; never input from a user.
    await db.query(`REVOKE tennis_ai_analytics_reader FROM "${role}"`);
    await db.query(`DROP ROLE "${role}"`);
  }
});
afterAll(() => db.end());

type Queryable = Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">;
async function insertQuestion(fixture = first, overrides: {
  id?: string; venueId?: string; createdAt?: string; outcome?: string; source?: string; topic?: string;
} = {}, client: Queryable = db): Promise<string> {
  const id = overrides.id ?? randomUUID();
  await client.query(`INSERT INTO tennis.ai_question_records
    (id,tenant_id,venue_id,conversation_id,question_redacted,source,page,topic,application_version,created_at,outcome)
    VALUES($1,$2,$3,$4,'今晚还有空场吗？',$5,'schedule',$6,'synthetic-test',$7,$8)`,
  [id, fixture.actor.tenantId, overrides.venueId ?? fixture.venueId, randomUUID(),
    overrides.source ?? "USER", overrides.topic ?? "AVAILABILITY", overrides.createdAt ?? new Date().toISOString(), overrides.outcome ?? "PENDING"]);
  return id;
}
async function totals(client: Queryable = db) {
  return (await client.query(`SELECT sum(question_count)::int AS total,sum(answered_count)::int AS answered,
    sum(failed_count)::int AS failed,sum(interrupted_count)::int AS interrupted,sum(pending_count)::int AS pending,
    sum(resolved_count)::int AS resolved,sum(unresolved_count)::int AS unresolved
    FROM tennis.ai_question_daily WHERE tenant_id=$1`, [first.actor.tenantId])).rows[0];
}
async function createReader(): Promise<string> {
  const role = `tennis_analytics_test_${randomUUID().replaceAll("-", "")}`;
  await db.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
  readerRoles.push(role);
  await db.query(`GRANT tennis_ai_analytics_reader TO "${role}"`);
  return role;
}
async function withReader<T>(role: string, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    // Exercise PostgreSQL view/base-table ACLs as a real non-superuser identity.
    // The original local test connection is superuser, so it can restore itself.
    await client.query(`SET SESSION AUTHORIZATION "${role}"`);
    return await work(client);
  } finally {
    await client.query("RESET ROLE");
    await client.query("RESET SESSION AUTHORIZATION");
    client.release();
  }
}
async function grant(role: string, fixture = first, venueId = fixture.venueId) {
  await db.query("INSERT INTO tennis.ai_question_reader_grants(login_role,tenant_id,venue_id) VALUES($1,$2,$3)",
    [role, fixture.actor.tenantId, venueId]);
}

describe("redacted assistant analytics schema", () => {
  it("rolls up lifecycle and changed feedback once, preserving totals after detail deletion", async () => {
    const id = await insertQuestion();
    expect(await totals()).toEqual({ total: 1, answered: 0, failed: 0, interrupted: 0, pending: 1, resolved: 0, unresolved: 0 });
    await db.query("UPDATE tennis.ai_question_records SET outcome='ANSWERED',tools_used=ARRAY['get_schedule'],duration_ms=80 WHERE id=$1", [id]);
    for (const feedback of ["RESOLVED", "RESOLVED", "UNRESOLVED", "UNRESOLVED"])
      await db.query("UPDATE tennis.ai_question_records SET feedback=$2 WHERE id=$1", [id, feedback]);
    expect(await totals()).toEqual({ total: 1, answered: 1, failed: 0, interrupted: 0, pending: 0, resolved: 0, unresolved: 1 });
    await db.query("DELETE FROM tennis.ai_question_records WHERE id=$1", [id]);
    expect(await totals()).toEqual({ total: 1, answered: 1, failed: 0, interrupted: 0, pending: 0, resolved: 0, unresolved: 1 });
  });

  it("serializes concurrent questions in the same daily bucket without lost counts", async () => {
    const ids = await Promise.all(Array.from({ length: 6 }, () => insertQuestion()));
    await Promise.all(ids.map((id, index) => db.query("UPDATE tennis.ai_question_records SET outcome=$2 WHERE id=$1",
      [id, index % 2 ? "FAILED" : "ANSWERED"])));
    expect(await totals()).toEqual({ total: 6, answered: 3, failed: 3, interrupted: 0, pending: 0, resolved: 0, unresolved: 0 });
  });

  it("uses request identity once and rejects changes to immutable dimensions", async () => {
    const id = await insertQuestion();
    await db.query(`INSERT INTO tennis.ai_question_records(id,tenant_id,venue_id,conversation_id,question_redacted,
      source,page,topic,application_version) SELECT id,tenant_id,venue_id,conversation_id,question_redacted,
      source,page,topic,application_version FROM tennis.ai_question_records WHERE id=$1 ON CONFLICT(id) DO NOTHING`, [id]);
    expect((await totals()).total).toBe(1);
    for (const update of [
      "question_redacted='另一个问题'", "source='SUGGESTION'", "page='orders'", "topic='BOOKING'",
      "application_version='changed'", "conversation_id='changed'", "created_at=created_at-interval '1 day'",
      "id='changed'",
    ]) await expect(db.query(`UPDATE tennis.ai_question_records SET ${update} WHERE id=$1`, [id]))
      .rejects.toMatchObject({ message: "AI_QUESTION_IMMUTABLE" });
    await expect(db.query("UPDATE tennis.ai_question_records SET venue_id=$2 WHERE id=$1", [id, otherVenue]))
      .rejects.toMatchObject({ message: "AI_QUESTION_IMMUTABLE" });
    expect((await totals()).total).toBe(1);
  });

  it("rejects raw error strings, unknown tools and invalid redacted record fields", async () => {
    const id = await insertQuestion();
    for (const [assignment, value] of [
      ["error_code=$2", "Error: secret model response"], ["tools_used=$2::text[]", ["run_sql"]],
      ["tools_used=$2::text[]", [null]], ["duration_ms=$2", -1], ["duration_ms=$2", 600001],
      ["redaction_version=$2", 2], ["source=$2", "EXTERNAL"], ["page=$2", "raw-order-id"],
      ["topic=$2", "STAY_EXTENSION"], ["feedback=$2", "RESOLVED"],
      ["question_redacted=$2", " ".repeat(8001)],
    ] as const) await expect(db.query(`UPDATE tennis.ai_question_records SET ${assignment} WHERE id=$1`, [id, value]))
      .rejects.toMatchObject({ code: "23514" });
    expect((await totals()).pending).toBe(1);
  });

  it("groups by UTC day and separates venue, topic and source", async () => {
    await insertQuestion(first, { createdAt: "2026-09-23T00:30:00+08:00" });
    await insertQuestion(first, { createdAt: "2026-09-22T16:30:00Z", source: "SUGGESTION" });
    await insertQuestion(first, { createdAt: "2026-09-22T16:30:00Z", topic: "BOOKING" });
    await insertQuestion(first, { createdAt: "2026-09-22T16:30:00Z", venueId: otherVenue });
    const rows = (await db.query("SELECT recorded_day::text,question_count::int FROM tennis.ai_question_daily WHERE tenant_id=$1", [first.actor.tenantId])).rows;
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.recorded_day === "2026-09-22" && row.question_count === 1)).toBe(true);
    await expect(insertQuestion(second, { venueId: first.venueId })).rejects.toMatchObject({ code: "23503" });
  });

  it("exports only explicitly authorized venues using the login identity, and revocation is immediate", async () => {
    const a = await insertQuestion();
    await insertQuestion(first, { venueId: otherVenue });
    await insertQuestion(second);
    const reader = await createReader();
    await withReader(reader, async (client) => {
      expect((await client.query("SELECT * FROM tennis.ai_question_export")).rows).toEqual([]);
      expect((await client.query("SELECT * FROM tennis.ai_question_daily_export")).rows).toEqual([]);
    });
    await grant(reader);
    await withReader(reader, async (client) => {
      expect((await client.query("SELECT id FROM tennis.ai_question_export")).rows).toEqual([{ id: a }]);
      expect((await client.query("SELECT question_count::int FROM tennis.ai_question_daily_export")).rows).toEqual([{ question_count: 1 }]);
      expect((await client.query("SELECT id FROM tennis.ai_question_export WHERE tenant_id=$1", [second.actor.tenantId])).rows).toEqual([]);
      expect((await client.query("SELECT id FROM tennis.ai_question_export WHERE venue_id=$1", [otherVenue])).rows).toEqual([]);
      await client.query("SET ROLE tennis_ai_analytics_reader");
      expect((await client.query("SELECT session_user,current_user")).rows[0]).toEqual({ session_user: reader, current_user: readerGroup });
      expect((await client.query("SELECT id FROM tennis.ai_question_export")).rows).toEqual([{ id: a }]);
    });
    await db.query("DELETE FROM tennis.ai_question_reader_grants WHERE login_role=$1", [reader]);
    await withReader(reader, async (client) => {
      expect((await client.query("SELECT * FROM tennis.ai_question_export")).rows).toEqual([]);
      expect((await client.query("SELECT * FROM tennis.ai_question_daily_export")).rows).toEqual([]);
    });
  });

  it("enforces real SQL reader ACLs against private data, writes, grants and maintenance", async () => {
    await insertQuestion();
    const reader = await createReader();
    await grant(reader);
    await withReader(reader, async (client) => {
      for (const table of ["ai_question_records", "ai_question_daily", "ai_question_reader_grants",
        "backoffice_messages", "backoffice_requests", "backoffice_conversations", "backoffice_ai_config", "customers", "orders"])
        await expect(client.query(`SELECT * FROM tennis.${table} LIMIT 1`)).rejects.toMatchObject({ code: "42501" });
      for (const statement of [
        "DELETE FROM tennis.ai_question_records", "DELETE FROM tennis.ai_question_reader_grants",
        "UPDATE tennis.ai_question_export SET question_redacted='tampered'", "DELETE FROM tennis.ai_question_daily_export",
        "SELECT tennis.maintain_ai_questions()", "CREATE TABLE tennis.unauthorized_analytics_probe(id text)",
      ]) await expect(client.query(statement)).rejects.toMatchObject({ code: "42501" });
    });
    const attributes = (await db.query("SELECT rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=$1", [readerGroup])).rows[0];
    expect(Object.values(attributes).every((value) => value === false)).toBe(true);
    const barriers = (await db.query("SELECT reloptions FROM pg_class WHERE oid=ANY($1::regclass[])",
      [["tennis.ai_question_export", "tennis.ai_question_daily_export"]])).rows;
    expect(barriers).toHaveLength(2);
    expect(barriers.every((row) => row.reloptions.includes("security_barrier=true"))).toBe(true);
    expect((await db.query("SELECT has_function_privilege($1,'tennis.ai_question_rollup()','EXECUTE') AS allowed", [reader])).rows[0].allowed).toBe(false);
  });

  it("hides aged details before maintenance and preserves cumulative counts after cleanup", async () => {
    const reader = await createReader();
    await grant(reader);
    const old = await insertQuestion(first, { createdAt: new Date(Date.now() - 91 * 86400000).toISOString(), outcome: "ANSWERED" });
    const pending = await insertQuestion(first, { createdAt: new Date(Date.now() - 11 * 60000).toISOString() });
    const current = await insertQuestion();
    await withReader(reader, async (client) => {
      const ids = (await client.query("SELECT id FROM tennis.ai_question_export")).rows.map((row) => row.id);
      expect(ids.sort()).toEqual([pending, current].sort());
      expect((await client.query("SELECT sum(question_count)::int AS total FROM tennis.ai_question_daily_export")).rows[0].total).toBe(3);
    });
    const client = await db.connect();
    try {
      // Maintenance is global by design; roll this test transaction back so
      // no old record belonging to another test/run is changed by our proof.
      await client.query("BEGIN");
      await client.query("SELECT tennis.maintain_ai_questions()");
      expect((await client.query("SELECT id FROM tennis.ai_question_records WHERE id=$1", [old])).rows).toEqual([]);
      expect((await client.query("SELECT outcome,error_code FROM tennis.ai_question_records WHERE id=$1", [pending])).rows[0])
        .toEqual({ outcome: "INTERRUPTED", error_code: "REQUEST_INTERRUPTED" });
      expect(await totals(client)).toEqual({ total: 3, answered: 1, failed: 0, interrupted: 1, pending: 1, resolved: 0, unresolved: 0 });
      await client.query("SELECT tennis.maintain_ai_questions()");
      expect(await totals(client)).toEqual({ total: 3, answered: 1, failed: 0, interrupted: 1, pending: 1, resolved: 0, unresolved: 0 });
    } finally { await client.query("ROLLBACK"); client.release(); }
  });

  it("keeps chat-independent analytics private and cascades only the target venue", async () => {
    await insertQuestion();
    await insertQuestion(first, { venueId: otherVenue });
    const reader = await createReader();
    await grant(reader);
    const columns = (await db.query("SELECT column_name FROM information_schema.columns WHERE table_schema='tennis' AND table_name='ai_question_export'")).rows.map((row) => row.column_name);
    for (const forbidden of ["actor_subject_id", "subject_id", "actor_session_id", "order_id", "context", "content", "tool_arguments", "tool_results"])
      expect(columns).not.toContain(forbidden);
    // conversation_id is only a grouping value; no backing chat/request exists.
    expect((await db.query("SELECT count(*)::int AS count FROM tennis.backoffice_conversations WHERE tenant_id=$1", [first.actor.tenantId])).rows[0].count).toBe(0);
    await db.query("DELETE FROM tennis.venues WHERE tenant_id=$1 AND id=$2", [first.actor.tenantId, first.venueId]);
    expect((await db.query("SELECT venue_id FROM tennis.ai_question_records WHERE tenant_id=$1", [first.actor.tenantId])).rows).toEqual([{ venue_id: otherVenue }]);
    expect((await db.query("SELECT venue_id FROM tennis.ai_question_daily WHERE tenant_id=$1", [first.actor.tenantId])).rows).toEqual([{ venue_id: otherVenue }]);
    expect((await db.query("SELECT * FROM tennis.ai_question_reader_grants WHERE tenant_id=$1", [first.actor.tenantId])).rows).toEqual([]);
  });
});
