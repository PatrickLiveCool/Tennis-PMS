/** Administrator-only entry point; never imported by server startup or seed. */
import pg from "pg";
import { migrateTennis } from "../../packages/db/src/tennis/migrate.ts";

if (process.argv.slice(2).join(" ") !== "--apply")
  throw new Error("Migration requires an explicit administrator invocation with --apply");
const connectionString = process.env.TENNIS_MIGRATION_DATABASE_URL;
let valid = false;
try {
  const url = new URL(connectionString ?? "");
  valid = ["postgres:", "postgresql:"].includes(url.protocol) && !!url.hostname &&
    url.pathname === "/tennis_demo" && url.username === "tennis_demo" && !!url.password && !url.hash && !url.search;
} catch { /* Never include credentials in diagnostics. */ }
if (!valid) throw new Error("TENNIS_MIGRATION_DATABASE_URL must target the independent tennis_demo database and owner role");
const pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000,
  lock_timeout: 30_000, statement_timeout: 600_000 });
let connected = false;
const diagnosticStates = new Set([
  "08000", "08001", "08003", "08004", "08006", "08007", "08P01", "28000", "28P01", "3D000",
  "42501", "42P01", "42704", "42710", "23502", "23503", "23505", "23514", "40001", "40P01",
  "53300", "53400", "55P03", "57014", "57P01", "57P02", "57P03", "58P01", "XX000",
]);
function reportFailure(error: unknown): void {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  const sqlstate = typeof code === "string" && diagnosticStates.has(code) ? `; SQLSTATE=${code}` : "";
  const category = !connected ? "connection" :
    error instanceof Error && error.message === "Tennis migration history or checksum mismatch"
      ? "migration history mismatch" : "database error";
  console.error(`Tennis migration failed: ${category}${sqlstate}`);
  process.exitCode = 1;
}
try {
  const client = await pool.connect();
  connected = true;
  try { await migrateTennis(client); } finally { client.release(); }
  console.log("Tennis migration completed; no seed was run. Verify the release baseline before starting the app.");
} catch (error) {
  reportFailure(error);
} finally { await pool.end().catch(reportFailure); }
