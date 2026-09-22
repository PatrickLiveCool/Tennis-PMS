import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertLocalTennisDatabaseUrl, localTennisTestDatabaseUrl } from "../../packages/db/src/tennis/local-config.ts";
import { migrateTennis } from "../../packages/db/src/tennis/migrate.ts";
import { removeTenantFixture, seedTenantFixture, type TenantFixture } from "./tenant-fixture.ts";
// @ts-expect-error Standalone Node operational script; the integration test exercises its public functions.
import { exportQuestions } from "../../scripts/tennis/export-ai-questions.mjs";

const connection = assertLocalTennisDatabaseUrl(process.env.TENNIS_TEST_DATABASE_URL ?? localTennisTestDatabaseUrl, "test");
const db = new pg.Pool({ connectionString: connection, max: 3, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
let fixture: TenantFixture, other: TenantFixture;
let otherVenue: string, directory: string, reader: string, readerConnection: string;
let questionId: string;
const options = (venueId = fixture.venueId, tenantId = fixture.actor.tenantId) => ({
  tenantId, venueId, output: join(directory, `${randomUUID()}.jsonl`), from: "1970-01-01", until: "9999-12-31",
});
async function insert(scope: TenantFixture, venueId = scope.venueId, old = false) {
  const id = randomUUID();
  await db.query(`INSERT INTO tennis.ai_question_records
    (id,tenant_id,venue_id,conversation_id,question_redacted,source,page,topic,application_version,outcome,feedback,created_at)
    VALUES($1,$2,$3,$4,'如何修改[手机号]？','USER','members','MEMBERSHIP','synthetic-export','ANSWERED','UNRESOLVED',
      CURRENT_TIMESTAMP - CASE WHEN $5 THEN interval '91 days' ELSE interval '0 days' END)`,
    [id, scope.actor.tenantId, venueId, randomUUID(), old]);
  return id;
}
async function readRecords(path: string): Promise<Record<string, unknown>[]> {
  return (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeAll(async () => { const tx = await db.connect(); try { await migrateTennis(tx); } finally { tx.release(); } });
beforeEach(async () => {
  fixture = await seedTenantFixture(db);
  other = await seedTenantFixture(db);
  otherVenue = randomUUID();
  await db.query("INSERT INTO tennis.venues(id,tenant_id,name) VALUES($1,$2,'synthetic export other venue')", [otherVenue, fixture.actor.tenantId]);
  directory = await mkdtemp(join(tmpdir(), "tennis-ai-export-pg-"));
  reader = `tennis_export_test_${randomUUID().replaceAll("-", "")}`;
  const password = randomUUID();
  // Role and password are generated locally; no deployed login is modified.
  await db.query(`CREATE ROLE "${reader}" LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
  await db.query(`GRANT tennis_ai_analytics_reader TO "${reader}"`);
  await db.query("INSERT INTO tennis.ai_question_reader_grants(login_role,tenant_id,venue_id) VALUES($1,$2,$3)",
    [reader, fixture.actor.tenantId, fixture.venueId]);
  const url = new URL(connection);
  url.username = reader; url.password = password;
  readerConnection = url.toString();
  questionId = await insert(fixture);
  await insert(fixture, fixture.venueId, true);
  await insert(fixture, otherVenue);
  await insert(other);
});
afterEach(async () => {
  await removeTenantFixture(db, fixture);
  await removeTenantFixture(db, other);
  await db.query(`REVOKE ALL ON tennis.customers FROM "${reader}"`);
  await db.query(`REVOKE tennis_ai_analytics_reader FROM "${reader}"`);
  await db.query(`DROP ROLE "${reader}"`);
  await rm(directory, { recursive: true, force: true });
});
afterAll(() => db.end());

describe("dedicated PostgreSQL analytics exports", () => {
  it("exports only the authorized venue, retains daily history and creates a private complete file", async () => {
    const input = options();
    const result = await exportQuestions(readerConnection, input);
    expect(result).toEqual({ output: input.output, questionCount: 1, dailyCount: 2 });
    const rows = await readRecords(input.output);
    expect(rows[0]).toMatchObject({ dataset: "tennis-ai-questions", tenantId: fixture.actor.tenantId, venueId: fixture.venueId });
    expect(rows.filter((row) => row.recordType === "question").map((row) => row.id)).toEqual([questionId]);
    expect(rows.filter((row) => row.recordType === "daily").every((row) => row.question_count === "1")).toBe(true);
    expect(rows.at(-1)).toEqual({ recordType: "complete", questionCount: 1, dailyCount: 2 });
    expect((await stat(input.output)).mode & 0o777).toBe(0o600);
    const readerClient = new pg.Client({ connectionString: readerConnection });
    await readerClient.connect();
    try {
      await expect(readerClient.query("SELECT * FROM tennis.ai_question_records")).rejects.toMatchObject({ code: "42501" });
      await expect(readerClient.query("SELECT * FROM tennis.customers")).rejects.toMatchObject({ code: "42501" });
      await expect(readerClient.query("DELETE FROM tennis.ai_question_daily")).rejects.toMatchObject({ code: "42501" });
    } finally { await readerClient.end(); }
  });

  it("returns no rows for a different venue or tenant even when the caller requests it", async () => {
    for (const input of [options(otherVenue), options(other.venueId, other.actor.tenantId)]) {
      expect(await exportQuestions(readerConnection, input)).toEqual({ output: input.output, questionCount: 0, dailyCount: 0 });
      expect((await readRecords(input.output)).map((row) => row.recordType)).toEqual(["manifest", "complete"]);
    }
  });

  it("refuses the application owner and a reader given business table access", async () => {
    await expect(exportQuestions(connection, options())).rejects.toThrow("dedicated read-only");
    await db.query(`GRANT SELECT ON tennis.customers TO "${reader}"`);
    await expect(exportQuestions(readerConnection, options())).rejects.toThrow("dedicated read-only");
    expect(await readdir(directory)).toEqual([]);
  });

  it("refuses an analytics login that can create roles", async () => {
    await db.query(`ALTER ROLE "${reader}" CREATEROLE`);
    await expect(exportQuestions(readerConnection, options())).rejects.toThrow("dedicated read-only");
    expect(await readdir(directory)).toEqual([]);
  });

  it("refuses server-file and program-execution role memberships", async () => {
    for (const group of ["pg_read_server_files", "pg_write_server_files", "pg_execute_server_program"]) {
      await db.query(`GRANT ${group} TO "${reader}"`);
      try {
        await expect(exportQuestions(readerConnection, options())).rejects.toThrow("dedicated read-only");
        expect(await readdir(directory)).toEqual([]);
      } finally {
        await db.query(`REVOKE ${group} FROM "${reader}"`);
      }
    }
  });
});
