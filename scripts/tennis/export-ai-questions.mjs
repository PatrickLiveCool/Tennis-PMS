import { randomUUID } from "node:crypto";
import { open, mkdir, link, unlink, lstat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import pg from "pg";

pg.types.setTypeParser(1082, value => value);
const help = `Export Tennis PMS redacted staff-assistant questions and daily totals as one read-only snapshot.
Usage: node scripts/tennis/export-ai-questions.mjs --tenant <id> --venue <id> --output <new.jsonl> [--from YYYY-MM-DD] [--until YYYY-MM-DD]
Set TENNIS_AI_QUESTION_EXPORT_DATABASE_URL to a dedicated authorized analytics login. No .env files are loaded.
Dates are UTC; --from is inclusive (default 1970-01-01), --until is exclusive (default tomorrow).
Details remain limited to the last 90 days. Output is created as 0600 and never overwrites an existing file.
The login must inherit tennis_ai_analytics_reader, have an explicit venue grant and no business-table access or write privileges.
`;

const questionFields = [
  "id", "tenant_id", "venue_id", "conversation_id", "created_at", "recorded_day", "updated_at",
  "question_redacted", "redaction_version", "source", "page", "topic", "application_version",
  "outcome", "error_code", "tools_used", "duration_ms", "feedback",
];
const dailyFields = [
  "tenant_id", "venue_id", "recorded_day", "topic", "source", "question_count", "answered_count",
  "failed_count", "interrupted_count", "pending_count", "resolved_count", "unresolved_count", "updated_at",
];

export function exportOptions(args, now = new Date()) {
  const { values } = parseArgs({ args, allowPositionals: false, options: {
    tenant: { type: "string" }, venue: { type: "string" }, output: { type: "string" },
    from: { type: "string", default: "1970-01-01" },
    until: { type: "string", default: new Date(now.getTime() + 86400000).toISOString().slice(0, 10) },
    help: { type: "boolean" },
  } });
  if (values.help) return { help: true };
  const validId = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value);
  const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value;
  if (!validId(values.tenant)) throw new Error("A valid --tenant is required");
  if (!validId(values.venue)) throw new Error("A valid --venue is required");
  if (!values.output?.trim()) throw new Error("A new --output file is required");
  if (!validDate(values.from) || !validDate(values.until) || values.from >= values.until)
    throw new Error("Use a valid UTC --from/--until date range");
  return { tenantId: values.tenant, venueId: values.venue, output: resolve(values.output), from: values.from, until: values.until };
}

// Verify the authenticated login, not a role chosen through connection options.
// The views also enforce per-login venue grants independently of our bound filters.
const authorizedReaderQuery = `SELECT
  session_user = current_user
  AND login.rolcanlogin
  AND pg_has_role(session_user, 'tennis_ai_analytics_reader', 'USAGE')
  AND NOT EXISTS (
    SELECT 1 FROM pg_roles elevated
    WHERE (elevated.rolsuper OR elevated.rolbypassrls OR elevated.rolcreatedb OR elevated.rolcreaterole OR elevated.rolreplication
      OR elevated.rolname IN ('pg_read_server_files', 'pg_write_server_files', 'pg_execute_server_program'))
      AND pg_has_role(session_user, elevated.oid, 'MEMBER')
  )
  AND NOT pg_has_role(session_user, (SELECT datdba FROM pg_database WHERE datname = current_database()), 'MEMBER')
  AND NOT pg_has_role(session_user, (SELECT nspowner FROM pg_namespace WHERE nspname = 'tennis'), 'MEMBER')
  AND NOT has_schema_privilege(session_user, 'tennis', 'CREATE')
  AND has_table_privilege(session_user, 'tennis.ai_question_export', 'SELECT')
  AND has_table_privilege(session_user, 'tennis.ai_question_daily_export', 'SELECT')
  AND NOT EXISTS (
    SELECT 1 FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'tennis' AND relation.relkind IN ('r', 'p', 'v', 'm', 'f') AND (
      pg_has_role(session_user, relation.relowner, 'MEMBER')
      OR has_table_privilege(session_user, relation.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR has_any_column_privilege(session_user, relation.oid, 'INSERT,UPDATE,REFERENCES')
      OR (relation.relname NOT IN ('ai_question_export', 'ai_question_daily_export') AND (
        has_table_privilege(session_user, relation.oid, 'SELECT')
        OR has_any_column_privilege(session_user, relation.oid, 'SELECT')
      ))
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_proc function JOIN pg_namespace namespace ON namespace.oid = function.pronamespace
    WHERE namespace.nspname = 'tennis' AND function.prosecdef
      AND has_function_privilege(session_user, function.oid, 'EXECUTE')
  ) AS authorized
FROM pg_roles login WHERE login.rolname = session_user`;

export async function exportQuestions(connectionString, options) {
  if (typeof connectionString !== "string" || !connectionString.trim()) throw new Error("An authorized analytics connection is required");
  // An existing target, including a symbolic link, is never reused.
  try { await lstat(options.output); throw new Error("Output already exists"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const client = new pg.Client({ connectionString, options: "-c default_transaction_read_only=on", connectionTimeoutMillis: 5000, statement_timeout: 30000 });
  const temporary = `${options.output}.partial.${randomUUID()}`;
  let file, transaction = false;
  let questionCount = 0, dailyCount = 0;
  try {
    await client.connect();
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); transaction = true;
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    const { rows: [identity] } = await client.query(authorizedReaderQuery);
    if (identity?.authorized !== true) throw new Error("A dedicated read-only analytics login is required");
    const { rows: [clock] } = await client.query("SELECT CURRENT_TIMESTAMP AS snapshot_at, CURRENT_TIMESTAMP - interval '90 days' AS details_after");
    await mkdir(dirname(options.output), { recursive: true, mode: 0o700 });
    file = await open(temporary, "wx", 0o600);
    const write = value => file.writeFile(`${JSON.stringify(value)}\n`);
    const writeRow = (recordType, row, fields) => write({ recordType, ...Object.fromEntries(fields.map(field => [field, row[field]])) });
    await write({ recordType: "manifest", schemaVersion: 1, dataset: "tennis-ai-questions", snapshotType: "REPLACEMENT",
      snapshotAt: clock.snapshot_at, tenantId: options.tenantId, venueId: options.venueId,
      from: options.from, until: options.until, timezone: "UTC", detailsRetainedAfter: clock.details_after });
    let afterId = "";
    while (true) {
      const { rows } = await client.query(`SELECT ${questionFields.join(", ")} FROM tennis.ai_question_export
        WHERE tenant_id = $1 AND venue_id = $2 AND recorded_day >= $3::date AND recorded_day < $4::date AND id > $5
        ORDER BY id LIMIT 1000`, [options.tenantId, options.venueId, options.from, options.until, afterId]);
      for (const row of rows) { await writeRow("question", row, questionFields); questionCount++; }
      if (rows.length < 1000) break;
      afterId = rows.at(-1).id;
    }
    let afterDay = "0001-01-01", afterTopic = "", afterSource = "";
    while (true) {
      const { rows } = await client.query(`SELECT ${dailyFields.join(", ")} FROM tennis.ai_question_daily_export
        WHERE tenant_id = $1 AND venue_id = $2 AND recorded_day >= $3::date AND recorded_day < $4::date
          AND (recorded_day, topic, source) > ($5::date, $6, $7)
        ORDER BY recorded_day, topic, source LIMIT 1000`, [options.tenantId, options.venueId, options.from, options.until, afterDay, afterTopic, afterSource]);
      for (const row of rows) { await writeRow("daily", row, dailyFields); dailyCount++; }
      if (rows.length < 1000) break;
      const last = rows.at(-1); afterDay = last.recorded_day; afterTopic = last.topic; afterSource = last.source;
    }
    await write({ recordType: "complete", questionCount, dailyCount });
    await client.query("COMMIT"); transaction = false;
    await file.sync(); await file.close(); file = undefined;
    // link fails if another export created the final target after our initial check.
    await link(temporary, options.output); await unlink(temporary);
    return { output: options.output, questionCount, dailyCount };
  } finally {
    if (transaction) await client.query("ROLLBACK").catch(() => {});
    await file?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    await client.end().catch(() => {});
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const options = exportOptions(process.argv.slice(2));
    if (options.help) process.stdout.write(help);
    else {
      const connection = process.env.TENNIS_AI_QUESTION_EXPORT_DATABASE_URL;
      if (!connection) throw new Error("TENNIS_AI_QUESTION_EXPORT_DATABASE_URL is required");
      process.stdout.write(`${JSON.stringify(await exportQuestions(connection, options))}\n`);
    }
  } catch {
    // Connection and SQL errors may contain credentials or data. Print neither.
    process.stderr.write("Tennis AI question export failed. Check the dedicated analytics login, venue grant, UTC date range and unused output path. See --help.\n");
    process.exitCode = 1;
  }
}
