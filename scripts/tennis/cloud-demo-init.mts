import pg from "pg";
import { initializeCloudDemo, readCloudDemoConfig } from "./cloud-demo-data.ts";

const config = readCloudDemoConfig();
const db = new pg.Pool({ connectionString: config.databaseUrl, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 30000 });
try {
  const result = await initializeCloudDemo(db, config);
  console.log(JSON.stringify({
    status: result.created ? "initialized" : "already-initialized", ...result.manifest,
    note: "合成 Demo 数据，无真实款项。重复运行保留既有密码、余额和客户试用数据。",
  }, null, 2));
} catch (error) {
  console.error("Cloud demo initialization did not complete. Inspect the initialization manifest before retrying; the script never resets existing data.");
  throw error;
} finally { await db.end(); }
