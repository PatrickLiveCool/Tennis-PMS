import { isIP } from "node:net";

type Environment = Readonly<Record<string, string | undefined>>;

/** Validate deployment inputs before connecting to the database or opening a listener. */
export function readTennisRuntimeConfig(env: Environment) {
  if (env.NODE_ENV === "production" || env.TENNIS_ALLOW_SIMULATION !== "true") {
    throw new Error("Tennis has only a simulated payment adapter. Production startup is unavailable; explicitly enable development simulation for a demo.");
  }
  const demoMode = env.TENNIS_DEMO_MODE === "true";
  if (env.TENNIS_DEMO_MODE && !["true", "false"].includes(env.TENNIS_DEMO_MODE))
    throw new Error("TENNIS_DEMO_MODE must be true or false");
  if (demoMode && env.NODE_ENV !== "development")
    throw new Error("TENNIS_DEMO_MODE requires NODE_ENV=development");
  const databaseUrl = env.TENNIS_DATABASE_URL;
  if (!databaseUrl) throw new Error("TENNIS_DATABASE_URL is required");
  if ((demoMode || env.NODE_ENV !== "development") && env.TENNIS_ALLOW_NONLOCAL_DATABASE !== "true")
    throw new Error("TENNIS_ALLOW_NONLOCAL_DATABASE=true is required for a non-local database");
  if (demoMode) {
    let database: URL;
    try { database = new URL(databaseUrl); }
    catch { throw new Error("TENNIS_DATABASE_URL must be a PostgreSQL URL for the independent tennis_demo database"); }
    if (!["postgres:", "postgresql:"].includes(database.protocol) || !database.hostname ||
      database.pathname !== "/tennis_demo" || database.username !== "tennis_demo" || !database.password ||
      database.search || database.hash)
      throw new Error("Demo requires the independent tennis_demo database and tennis_demo role, without URL options");
  }
  const signingKey = env.TENNIS_PAYMENT_SIGNING_KEY;
  if (!signingKey || signingKey.length < 32)
    throw new Error("TENNIS_PAYMENT_SIGNING_KEY must contain at least 32 characters");
  const encryptionKey = env.TENNIS_AI_ENCRYPTION_KEY ? Buffer.from(env.TENNIS_AI_ENCRYPTION_KEY, "base64") : undefined;
  if (encryptionKey && (encryptionKey.length !== 32 || encryptionKey.toString("base64") !== env.TENNIS_AI_ENCRYPTION_KEY))
    throw new Error("TENNIS_AI_ENCRYPTION_KEY must be canonical Base64 encoding of 32 bytes");
  if (demoMode && !encryptionKey)
    throw new Error("TENNIS_AI_ENCRYPTION_KEY is required in demo mode; provider credentials can be configured after startup");
  if (demoMode && encryptionKey && [encryptionKey.toString("base64"), encryptionKey.toString("hex"), encryptionKey.toString("utf8")].includes(signingKey))
    throw new Error("Demo payment signing and AI encryption keys must be independent");

  const origins = env.TENNIS_WEB_ORIGINS?.split(",").map(value => value.trim()).filter(Boolean);
  if (demoMode) {
    let valid = false;
    if (origins?.length === 1) {
      try {
        const origin = new URL(origins[0]!);
        valid = origin.protocol === "https:" && origin.origin === origins[0] && !!origin.hostname;
      } catch { /* Report the configuration field, without echoing its contents. */ }
    }
    if (!valid) throw new Error("Demo requires exactly one canonical HTTPS origin in TENNIS_WEB_ORIGINS");
  }
  const trustedProxy = env.TENNIS_TRUSTED_PROXY;
  if (trustedProxy !== undefined && !isIP(trustedProxy))
    throw new Error("TENNIS_TRUSTED_PROXY must be the exact IP of the reverse proxy, never a wildcard or subnet");
  if (demoMode && !trustedProxy)
    throw new Error("TENNIS_TRUSTED_PROXY is required in demo mode; publish the HTTP port only on host loopback behind HTTPS Nginx");
  const httpHost = env.TENNIS_HTTP_HOST ?? "0.0.0.0";
  if (!isIP(httpHost)) throw new Error("TENNIS_HTTP_HOST must be a bind IP address");
  const httpPort = integer(env.TENNIS_HTTP_PORT ?? "4200", "TENNIS_HTTP_PORT", 1, 65535);
  const databasePoolMax = integer(env.TENNIS_DATABASE_POOL_MAX ?? (demoMode ? "4" : "12"), "TENNIS_DATABASE_POOL_MAX", 1, demoMode ? 4 : 32);
  return { demoMode, databaseUrl, signingKey, encryptionKey, origins, trustedProxy, httpHost, httpPort, databasePoolMax, secureCookies: demoMode };
}

function integer(value: string, name: string, min: number, max: number): number {
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max)
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return Number(value);
}
