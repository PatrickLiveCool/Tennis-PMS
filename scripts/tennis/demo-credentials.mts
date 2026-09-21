import { randomBytes, scryptSync } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { assertLocalTennisDatabaseUrl, localTennisDatabaseUrl } from "../../packages/db/src/tennis/local-config.ts";

// Fixed, intentionally documented credentials for the isolated local demo only.
export const demoPassword = "TennisPMS123!";
export const demoAccounts = {
  "demo.platform": "演示平台运营（模拟）",
  "demo.green": "格林网球（模拟租户）管理员",
  "demo.staff": "演示前台（模拟）",
  "demo.customer": "演示球友（模拟）",
  "demo.second": "第二租户（隔离演示）管理员",
};
export const credentialsPath = ".local-workspace/demo-credentials.json";

export async function syncDemoCredentials(db: pg.Pool) {
  if (process.env.NODE_ENV === "production") throw new Error("Demo credentials are local-only");
  const tx = await db.connect();
  try {
    await tx.query("BEGIN");
    const database = (await tx.query<{ name: string }>("SELECT current_database() AS name")).rows[0]?.name;
    if (database !== "tennis_dev") throw new Error("Demo credentials require tennis_dev");
    for (const [username, displayName] of Object.entries(demoAccounts)) {
      const result = await tx.query<{ display_name: string }>(
        `SELECT s.display_name FROM tennis.local_accounts a JOIN tennis.subjects s ON s.id=a.subject_id
         WHERE a.username=$1 FOR UPDATE OF a`, [username],
      );
      if (result.rows[0]?.display_name !== displayName)
        throw new Error(`Missing demo account or unrelated account collision: ${username}`);
      const salt = randomBytes(16);
      const derived = scryptSync(demoPassword, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
      const hash = `scrypt$32768$8$1$${salt.toString("hex")}$${derived.toString("hex")}`;
      await tx.query("UPDATE tennis.local_accounts SET password_hash=$1 WHERE username=$2", [hash, username]);
    }
    await tx.query("COMMIT");
  } catch (error) {
    await tx.query("ROLLBACK");
    throw error;
  } finally {
    tx.release();
  }
  await mkdir(".local-workspace", { recursive: true });
  await writeFile(credentialsPath, JSON.stringify({ password: demoPassword, accounts: Object.keys(demoAccounts) }, null, 2), { mode: 0o600 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const db = new pg.Pool({
    connectionString: assertLocalTennisDatabaseUrl(process.env.TENNIS_DATABASE_URL ?? localTennisDatabaseUrl, "development"),
    connectionTimeoutMillis: 5000,
  });
  try {
    await syncDemoCredentials(db);
    console.log("五个本地演示账号已使用固定密码；未修改业务数据或账号权限。");
  } finally {
    await db.end();
  }
}
