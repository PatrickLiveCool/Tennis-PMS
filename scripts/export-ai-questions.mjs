import { randomUUID } from "node:crypto";
import { open, mkdir, link, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import pg from "pg";

pg.types.setTypeParser(1082, value => value);
const help = `Export redacted AI question records and cumulative daily totals as one read-only snapshot.
Usage: node scripts/export-ai-questions.mjs --property <id> --output <new.jsonl> [--from YYYY-MM-DD] [--until YYYY-MM-DD]
Set AI_QUESTION_EXPORT_DATABASE_URL through the authorized database environment. No .env files are loaded.
Dates are UTC; --from is inclusive (default 1970-01-01), --until is exclusive (default tomorrow).
Details remain limited to the last 90 days. Output is created as 0600 and never overwrites an existing file.
`;

export function exportOptions(args, now = new Date()) {
  const { values } = parseArgs({ args, allowPositionals: false, options: {
    property: { type: "string" }, output: { type: "string" }, from: { type: "string", default: "1970-01-01" },
    until: { type: "string", default: new Date(now.getTime() + 86400000).toISOString().slice(0, 10) }, help: { type: "boolean" }
  } });
  if (values.help) return { help: true };
  const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  if (!values.property || !/^[A-Za-z0-9_-]{1,160}$/.test(values.property)) throw new Error("A valid --property is required");
  if (!values.output?.trim()) throw new Error("A new --output file is required");
  if (!validDate(values.from) || !validDate(values.until) || values.from >= values.until) throw new Error("Use a valid UTC --from/--until date range");
  return { propertyId: values.property, output: resolve(values.output), from: values.from, until: values.until };
}

export async function exportQuestions(connectionString, options) {
  const client = new pg.Client({ connectionString, options: "-c default_transaction_read_only=on", connectionTimeoutMillis: 5000, statement_timeout: 30000 });
  const temporary = `${options.output}.partial.${randomUUID()}`;
  let file, transaction = false;
  let questionCount = 0, dailyCount = 0;
  try {
    await client.connect();
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); transaction = true;
    const { rows: [clock] } = await client.query("SELECT CURRENT_TIMESTAMP AS snapshot_at, CURRENT_TIMESTAMP - interval '90 days' AS details_after");
    await mkdir(dirname(options.output), { recursive: true, mode: 0o700 });
    file = await open(temporary, "wx", 0o600);
    const write = value => file.writeFile(`${JSON.stringify(value)}\n`);
    await write({ recordType: "manifest", schemaVersion: 1, snapshotType: "REPLACEMENT", snapshotAt: clock.snapshot_at,
      propertyId: options.propertyId, from: options.from, until: options.until, timezone: "UTC", detailsRetainedAfter: clock.details_after });
    let afterId = "";
    while (true) {
      const { rows } = await client.query(`SELECT * FROM public.ai_question_export
        WHERE property_id = $1 AND recorded_day >= $2::date AND recorded_day < $3::date AND id > $4
        ORDER BY id LIMIT 1000`, [options.propertyId, options.from, options.until, afterId]);
      for (const row of rows) { await write({ recordType: "question", ...row }); questionCount++; }
      if (rows.length < 1000) break;
      afterId = rows.at(-1).id;
    }
    let afterDay = "0001-01-01", afterTopic = "", afterSource = "";
    while (true) {
      const { rows } = await client.query(`SELECT * FROM public.ai_question_daily
        WHERE property_id = $1 AND recorded_day >= $2::date AND recorded_day < $3::date
          AND (recorded_day, topic, source) > ($4::date, $5, $6)
        ORDER BY recorded_day, topic, source LIMIT 1000`, [options.propertyId, options.from, options.until, afterDay, afterTopic, afterSource]);
      for (const row of rows) { await write({ recordType: "daily", ...row }); dailyCount++; }
      if (rows.length < 1000) break;
      const last = rows.at(-1); afterDay = last.recorded_day; afterTopic = last.topic; afterSource = last.source;
    }
    await write({ recordType: "complete", questionCount, dailyCount });
    await client.query("COMMIT"); transaction = false;
    await file.sync(); await file.close(); file = undefined;
    // link() fails on an existing target, unlike rename(), so an earlier export is never overwritten.
    await link(temporary, options.output); await unlink(temporary);
    return { output: options.output, questionCount, dailyCount };
  } finally {
    if (transaction) await client.query("ROLLBACK").catch(() => {});
    await file?.close();
    await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
    await client.end();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const options = exportOptions(process.argv.slice(2));
    if (options.help) process.stdout.write(help);
    else {
      const connection = process.env.AI_QUESTION_EXPORT_DATABASE_URL;
      if (!connection) throw new Error("AI_QUESTION_EXPORT_DATABASE_URL is required");
      process.stdout.write(`${JSON.stringify(await exportQuestions(connection, options))}\n`);
    }
  } catch {
    // Connection errors may contain credentials or SQL data. Print neither.
    process.stderr.write("AI question export failed. Check the authorized database connection, read permission, date range and unused output path. See --help.\n");
    process.exitCode = 1;
  }
}
