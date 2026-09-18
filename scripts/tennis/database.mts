import pg from "pg";
import { assertLocalTennisDatabaseUrl, localTennisDatabaseUrl } from "../../packages/db/src/tennis/local-config.ts";
import { migrateTennis } from "../../packages/db/src/tennis/migrate.ts";

const connectionString = assertLocalTennisDatabaseUrl(
  process.env.TENNIS_DATABASE_URL ?? localTennisDatabaseUrl,
  "development",
);
const pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000 });
try {
  const client = await pool.connect();
  try {
    await migrateTennis(client);
  } finally {
    client.release();
  }
  const result = await pool.query(
    "SELECT current_database() AS database, to_regclass('tennis.occupancies') AS inventory",
  );
  console.log(result.rows[0]);
} finally {
  await pool.end();
}
