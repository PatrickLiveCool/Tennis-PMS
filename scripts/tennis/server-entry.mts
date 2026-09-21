import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import { tennisModelTransport } from "../../apps/api/src/tennis/model-transport.ts";
import { buildTennisServer } from "../../apps/api/src/tennis/server.ts";
import { LocalMockPaymentGateway } from "../../packages/db/src/tennis/mock-payments.ts";

if (process.env.NODE_ENV === "production" || process.env.TENNIS_ALLOW_SIMULATION !== "true") {
  throw new Error("Tennis has only a local payment adapter. A real provider must be integrated before production startup; use explicit development simulation for local verification.");
}
const databaseUrl = process.env.TENNIS_DATABASE_URL;
if (!databaseUrl) throw new Error("TENNIS_DATABASE_URL is required");
if (process.env.NODE_ENV !== "development" && process.env.TENNIS_ALLOW_NONLOCAL_DATABASE !== "true") {
  throw new Error("TENNIS_ALLOW_NONLOCAL_DATABASE=true is required for a non-local database");
}

const db = new pg.Pool({ connectionString: databaseUrl, max: 12, connectionTimeoutMillis: 5000 });
try {
  // Read-only readiness: schema changes require a separate, explicitly run migration.
  const directory = resolve("packages/db/src/tennis/migrations");
  const expected = await Promise.all((await readdir(directory)).filter(name => name.endsWith(".sql")).sort().map(async name => ({
    name, checksum: createHash("sha256").update(await readFile(resolve(directory, name))).digest("hex"),
  })));
  const applied = await db.query<{ name: string; checksum: string }>(
    "SELECT name, checksum FROM public.tennis_schema_migrations ORDER BY name",
  );
  if (!expected.length || JSON.stringify(applied.rows) !== JSON.stringify(expected))
    throw new Error("Tennis migration baseline mismatch; run the approved migration separately");
} catch (error) {
  await db.end();
  throw error;
}

const signingKey = process.env.TENNIS_PAYMENT_SIGNING_KEY;
if (!signingKey || signingKey.length < 32) throw new Error("TENNIS_PAYMENT_SIGNING_KEY must contain at least 32 characters");
const encryptionKey = process.env.TENNIS_AI_ENCRYPTION_KEY
  ? Buffer.from(process.env.TENNIS_AI_ENCRYPTION_KEY, "base64")
  : undefined;
if (encryptionKey && (encryptionKey.length !== 32 || encryptionKey.toString("base64") !== process.env.TENNIS_AI_ENCRYPTION_KEY))
  throw new Error("TENNIS_AI_ENCRYPTION_KEY must be canonical Base64 encoding of 32 bytes");
const origins = process.env.TENNIS_WEB_ORIGINS?.split(",").map((value) => value.trim()).filter(Boolean);
const app = await buildTennisServer({
  db,
  gateway: new LocalMockPaymentGateway(signingKey, "local-simulation"),
  allowSimulation: process.env.TENNIS_ALLOW_SIMULATION === "true",
  ...(origins?.length ? { origins } : {}),
  ...(encryptionKey ? { aiEncryptionKey: encryptionKey } : {}),
  modelTransport: tennisModelTransport,
  runExpiryWorker: true,
  logger: true,
});

// Serve the public web entry separately so the existing API authentication hook
// continues to protect every API route without blocking the login page/assets.
app.addHook("onClose", () => db.end());
await app.ready();
const web = Fastify({
  serverFactory(handler) {
    return createServer((request, response) => {
      const path = request.url?.split("?")[0] ?? "/";
      if (path === "/health" || path === "/api" || path.startsWith("/api/")) {
        // Dispatch the original request, preserving peer IP, raw bodies and cookies.
        app.routing(request, response);
        return;
      }
      handler(request, response);
    });
  },
});
await web.register(fastifyStatic, {
  root: resolve("apps/web/dist-tennis"),
  index: "index.html",
});
web.get("/version", async () => ({
  version: (process.env.TENNIS_RELEASE_VERSION ?? "development").replace(/^v/, ""),
  revision: process.env.TENNIS_RELEASE_REVISION ?? "development",
}));
web.addHook("onClose", () => app.close());
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void web.close().then(() => process.exit(0));
  });

await web.listen({
  host: process.env.TENNIS_HTTP_HOST ?? "0.0.0.0",
  port: Number(process.env.TENNIS_HTTP_PORT ?? "4200"),
});
