import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import pg from "pg";
import { buildTennisServer } from "../../apps/api/src/tennis/server.ts";
import { assertLocalTennisDatabaseUrl, localTennisDatabaseUrl } from "../../packages/db/src/tennis/local-config.ts";
import { migrateTennis } from "../../packages/db/src/tennis/migrate.ts";
import { LocalMockPaymentGateway } from "../../packages/db/src/tennis/mock-payments.ts";

if (process.env.NODE_ENV === "production") throw new Error("Local Tennis launcher cannot run in production");
const db = new pg.Pool({
  connectionString: assertLocalTennisDatabaseUrl(
    process.env.TENNIS_DATABASE_URL ?? localTennisDatabaseUrl,
    "development",
  ),
  max: 12,
  connectionTimeoutMillis: 5000,
});
const path = resolve(".local-workspace/tennis-secrets.json");
await mkdir(resolve(".local-workspace"), { recursive: true });
try {
  await writeFile(
    path,
    JSON.stringify({ paymentSigning: randomBytes(32).toString("hex"), aiEncryption: randomBytes(32).toString("hex") }),
    { flag: "wx", mode: 0o600 },
  );
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
}
const secrets = JSON.parse(await readFile(path, "utf8")) as { paymentSigning: string; aiEncryption: string };
const key = Buffer.from(secrets.aiEncryption, "hex");
if (key.length !== 32) throw new Error("Invalid local AI encryption key");
const client = await db.connect();
try {
  await migrateTennis(client);
} finally {
  client.release();
}
const app = await buildTennisServer({
  db,
  gateway: new LocalMockPaymentGateway(secrets.paymentSigning, "local-simulation"),
  allowSimulation: true,
  aiEncryptionKey: key,
  runExpiryWorker: true,
  logger: true,
});
app.addHook("onClose", () => db.end());
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
await app.listen({ host: "127.0.0.1", port: 4200 });
