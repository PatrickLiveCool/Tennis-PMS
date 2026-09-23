import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  connect: vi.fn(), query: vi.fn(), end: vi.fn(), configurations: [] as Record<string, unknown>[],
}));
vi.mock("pg", () => ({ default: {
  types: { setTypeParser: vi.fn() },
  Client: class {
    constructor(configuration: Record<string, unknown>) { db.configurations.push(configuration); }
    connect = db.connect;
    query = db.query;
    end = db.end;
  },
} }));
// @ts-expect-error The operational exporter is intentionally a standalone Node .mjs script.
import { exportOptions, exportQuestions } from "../../scripts/tennis/export-ai-questions.mjs";

const clock = { snapshot_at: "2026-09-23T02:00:00.000Z", details_after: "2026-06-25T02:00:00.000Z" };
const connection = "postgres://synthetic_reader:synthetic_secret@localhost/tennis_test";
const script = resolve("scripts/tennis/export-ai-questions.mjs");
let directory: string;
let output: string;
let questions: Record<string, unknown>[];
let daily: Record<string, unknown>[];
const options = () => ({ tenantId: "tenant-a", venueId: "venue-a", output, from: "2026-09-01", until: "2026-10-01" });
const question = (id: string) => ({
  id, tenant_id: "tenant-a", venue_id: "venue-a", conversation_id: "anonymous-conversation",
  created_at: clock.snapshot_at, recorded_day: "2026-09-23", updated_at: clock.snapshot_at,
  question_redacted: "如何修改[手机号]？", redaction_version: 1, source: "USER", page: "members",
  topic: "MEMBERSHIP", application_version: "test", outcome: "ANSWERED", error_code: null,
  tools_used: ["get_work_context"], duration_ms: 123, feedback: "UNRESOLVED",
});
const totals = (topic = "MEMBERSHIP") => ({
  tenant_id: "tenant-a", venue_id: "venue-a", recorded_day: "2026-09-23", topic, source: "USER",
  question_count: "9007199254740993", answered_count: "9007199254740993", failed_count: "0",
  interrupted_count: "0", pending_count: "0", resolved_count: "0", unresolved_count: "1", updated_at: clock.snapshot_at,
});
async function records(): Promise<Record<string, unknown>[]> {
  return (await readFile(output, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeEach(async () => {
  vi.clearAllMocks();
  db.configurations.length = 0;
  directory = await mkdtemp(join(tmpdir(), "tennis-ai-question-export-"));
  output = join(directory, "new-snapshot.jsonl");
  questions = [question("question-1")];
  daily = [totals()];
  db.connect.mockResolvedValue(undefined);
  db.end.mockResolvedValue(undefined);
  db.query.mockImplementation(async (sql: string, parameters?: string[]) => {
    if (sql.includes("AS authorized")) return { rows: [{ authorized: true }] };
    if (sql.includes("AS snapshot_at")) return { rows: [clock] };
    if (sql.includes("FROM tennis.ai_question_export")) {
      return { rows: questions.filter((row) => String(row.id) > parameters![4]!).slice(0, 1000) };
    }
    if (sql.includes("FROM tennis.ai_question_daily_export")) {
      const cursor = parameters!.slice(4).join("\t");
      return { rows: daily.filter((row) => [row.recorded_day, row.topic, row.source].join("\t") > cursor).slice(0, 1000) };
    }
    return { rows: [] };
  });
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe("Tennis AI question export options", () => {
  it("requires both tenant and venue and interprets dates as UTC half-open bounds", () => {
    const args = ["--tenant", "tenant-a", "--venue", "venue-a", "--output", output];
    expect(exportOptions(args, new Date("2026-09-23T23:30:00Z"))).toEqual({
      tenantId: "tenant-a", venueId: "venue-a", output, from: "1970-01-01", until: "2026-09-24",
    });
    expect(() => exportOptions(args.slice(2))).toThrow("--tenant");
    expect(() => exportOptions(["--tenant", "tenant-a", "--output", output])).toThrow("--venue");
    expect(() => exportOptions([...args, "--from", "2026-02-30"])).toThrow("UTC");
    expect(() => exportOptions([...args, "--from", "2026-09-23", "--until", "2026-09-23"])).toThrow("UTC");
    expect(() => exportOptions(["--property", "old-green", "--output", output])).toThrow();
    expect(() => exportOptions([...args, "--venue", "venue-a' OR true--"])).toThrow("--venue");
  });

  it("supports help without a database connection or scope", () => {
    expect(exportOptions(["--help"])).toEqual({ help: true });
    const result = spawnSync(process.execPath, [script, "--help"], { encoding: "utf8", env: {} });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("TENNIS_AI_QUESTION_EXPORT_DATABASE_URL");
    expect(result.stderr).toBe("");
  });
});

describe("read-only snapshot publication", () => {
  it("publishes a private complete snapshot with fixed exported fields and exact bigint counts", async () => {
    questions[0] = { ...questions[0], actor_subject_id: "private-actor", raw_question: "private-question", tool_result: "private-result" };
    expect(await exportQuestions(connection, options())).toEqual({ output, questionCount: 1, dailyCount: 1 });
    const rows = await records();
    expect(rows[0]).toEqual({ recordType: "manifest", schemaVersion: 1, dataset: "tennis-ai-questions",
      snapshotType: "REPLACEMENT", snapshotAt: clock.snapshot_at, tenantId: "tenant-a", venueId: "venue-a",
      from: "2026-09-01", until: "2026-10-01", timezone: "UTC", detailsRetainedAfter: clock.details_after });
    expect(rows[1]).toEqual({ recordType: "question", ...question("question-1") });
    expect(rows[2]?.question_count).toBe("9007199254740993");
    expect(rows.at(-1)).toEqual({ recordType: "complete", questionCount: 1, dailyCount: 1 });
    expect((await stat(output)).mode & 0o777).toBe(0o600);
    expect(await readdir(directory)).toEqual(["new-snapshot.jsonl"]);
    expect(db.configurations[0]?.options).toBe("-c default_transaction_read_only=on");
    const statements = db.query.mock.calls.map(([sql]) => sql as string);
    expect(statements[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(statements[1]).toBe("SET LOCAL TIME ZONE 'UTC'");
    expect(statements.at(-1)).toBe("COMMIT");
    expect(db.connect).toHaveBeenCalledOnce();
    expect(db.end).toHaveBeenCalledOnce();
  });

  it("paginates both datasets within the same transaction with bound tenant, venue and range", async () => {
    questions = Array.from({ length: 1001 }, (_, index) => question(`question-${String(index).padStart(4, "0")}`));
    daily = Array.from({ length: 1001 }, (_, index) => totals(`TOPIC_${String(index).padStart(4, "0")}`));
    await exportQuestions(connection, options());
    const rows = await records();
    expect(rows.at(-1)).toEqual({ recordType: "complete", questionCount: 1001, dailyCount: 1001 });
    expect(new Set(rows.filter((row) => row.recordType === "question").map((row) => row.id)).size).toBe(1001);
    const pages = db.query.mock.calls.filter(([sql]) => /FROM tennis\.ai_question_(export|daily_export)\n/.test(sql as string));
    expect(pages).toHaveLength(4);
    for (const [sql, parameters] of pages) {
      expect(sql).toContain("tenant_id = $1 AND venue_id = $2");
      expect(parameters.slice(0, 4)).toEqual(["tenant-a", "venue-a", "2026-09-01", "2026-10-01"]);
    }
    expect(pages[1]![1][4]).toBe("question-0999");
    expect(pages[3]![1].slice(4)).toEqual(["2026-09-23", "TOPIC_0999", "USER"]);
    expect(db.query.mock.calls.filter(([sql]) => String(sql).startsWith("BEGIN"))).toHaveLength(1);
  });

  it("supports an empty authorized snapshot without claiming activity exists", async () => {
    questions = []; daily = [];
    await exportQuestions(connection, options());
    expect((await records()).map((row) => row.recordType)).toEqual(["manifest", "complete"]);
  });

  it("refuses a privileged or non-reader login before opening an export", async () => {
    db.query.mockResolvedValue({ rows: [{ authorized: false }] });
    await expect(exportQuestions(connection, options())).rejects.toThrow("dedicated read-only");
    expect(await readdir(directory)).toEqual([]);
    expect(db.query).toHaveBeenCalledWith("ROLLBACK");
    expect(db.query.mock.calls.some(([sql]) => String(sql).includes("FROM tennis.ai_question_export"))).toBe(false);
  });

  it("never replaces an existing final file", async () => {
    await writeFile(output, "previous export", { mode: 0o600 });
    await expect(exportQuestions(connection, options())).rejects.toThrow("already exists");
    expect(await readFile(output, "utf8")).toBe("previous export");
    expect(db.connect).not.toHaveBeenCalled();
  });

  it("does not overwrite a target published concurrently after export began", async () => {
    const query = db.query.getMockImplementation()!;
    db.query.mockImplementation(async (...args: unknown[]) => {
      if (args[0] === "COMMIT") await writeFile(output, "concurrent export", { flag: "wx", mode: 0o600 });
      return query(...args);
    });
    await expect(exportQuestions(connection, options())).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(output, "utf8")).toBe("concurrent export");
    expect(await readdir(directory)).toEqual(["new-snapshot.jsonl"]);
  });

  it("rolls back and leaves no final or partial export on a page failure", async () => {
    const query = db.query.getMockImplementation()!;
    db.query.mockImplementation(async (...args: unknown[]) => {
      if (String(args[0]).includes("FROM tennis.ai_question_daily_export")) throw new Error("synthetic SQL secret");
      return query(...args);
    });
    await expect(exportQuestions(connection, options())).rejects.toThrow("synthetic SQL secret");
    expect(await readdir(directory)).toEqual([]);
    expect(db.query).toHaveBeenCalledWith("ROLLBACK");
    expect(db.end).toHaveBeenCalledOnce();
  });

  it("requires its dedicated environment variable and suppresses connection errors in CLI output", () => {
    const args = [script, "--tenant", "tenant-a", "--venue", "venue-a", "--output", output];
    const missing = spawnSync(process.execPath, args, { encoding: "utf8", env: { AI_QUESTION_EXPORT_DATABASE_URL: connection } });
    expect(missing.status).toBe(1);
    expect(missing.stdout).toBe("");
    const failed = spawnSync(process.execPath, args, { encoding: "utf8", env: {
      TENNIS_AI_QUESTION_EXPORT_DATABASE_URL: "postgres://private-role:private-password@127.0.0.1:1/private-database",
    } });
    expect(failed.status).toBe(1);
    expect(failed.stdout).toBe("");
    expect(failed.stderr).toBe(missing.stderr);
    expect(failed.stderr).not.toMatch(/private-role|private-password|private-database|ECONNREFUSED|SELECT|postgres:\/\//);
  });
});
