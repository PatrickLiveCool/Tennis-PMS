import { afterEach, describe, expect, it, vi } from "vitest";
import { readTennisRuntimeConfig } from "../../scripts/tennis/runtime-config.mts";
import { LocalMockPaymentGateway } from "../../packages/db/src/tennis/mock-payments.ts";

const local = {
  NODE_ENV: "development",
  TENNIS_ALLOW_SIMULATION: "true",
  TENNIS_DATABASE_URL: "postgres://tennis_dev:synthetic@127.0.0.1:55439/tennis_dev",
  TENNIS_PAYMENT_SIGNING_KEY: "synthetic-runtime-signing-key-at-least-32-characters",
};
const demo = {
  ...local,
  TENNIS_DEMO_MODE: "true",
  TENNIS_ALLOW_NONLOCAL_DATABASE: "true",
  TENNIS_DATABASE_URL: "postgres://tennis_demo:synthetic@postgres:5432/tennis_demo",
  TENNIS_AI_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  TENNIS_WEB_ORIGINS: "https://tennis.example.com",
  TENNIS_TRUSTED_PROXY: "172.30.42.1",
};
afterEach(() => vi.unstubAllEnvs());

describe("Tennis demo startup configuration", () => {
  it("accepts an isolated HTTPS demo before AI provider credentials are configured", () => {
    expect(readTennisRuntimeConfig(demo)).toMatchObject({
      demoMode: true, secureCookies: true, databasePoolMax: 4, httpPort: 4200,
      trustedProxy: "172.30.42.1", origins: ["https://tennis.example.com"],
      encryptionKey: Buffer.alloc(32, 7),
    });
  });
  it("retains local simulation defaults without requiring AI configuration or a proxy", () => {
    expect(readTennisRuntimeConfig(local)).toMatchObject({
      demoMode: false, secureCookies: false, databasePoolMax: 12,
      origins: undefined, encryptionKey: undefined, trustedProxy: undefined,
    });
  });
  it("refuses production simulation at both the startup boundary and payment adapter", () => {
    expect(() => readTennisRuntimeConfig({ ...demo, NODE_ENV: "production" })).toThrow("Production startup is unavailable");
    vi.stubEnv("NODE_ENV", "production");
    expect(() => new LocalMockPaymentGateway(demo.TENNIS_PAYMENT_SIGNING_KEY, "local-simulation")).toThrow();
  });
  it.each([
    "NODE_ENV", "TENNIS_ALLOW_SIMULATION", "TENNIS_ALLOW_NONLOCAL_DATABASE", "TENNIS_DATABASE_URL",
    "TENNIS_PAYMENT_SIGNING_KEY", "TENNIS_AI_ENCRYPTION_KEY", "TENNIS_WEB_ORIGINS", "TENNIS_TRUSTED_PROXY",
  ])("refuses missing demo configuration before connecting: %s", name => {
    const env: Record<string, string | undefined> = { ...demo };
    delete env[name];
    expect(() => readTennisRuntimeConfig(env)).toThrow();
  });
  it.each([
    "", "http://tennis.example.com", "https://tennis.example.com/", "https://tennis.example.com/path",
    "https://user:password@tennis.example.com", "https://tennis.example.com?query=1", "https://tennis.example.com#part",
    "https://tennis.example.com,https://other.example.com", "invalid",
  ])("refuses non-canonical or multiple demo origins: %s", origin => {
    expect(() => readTennisRuntimeConfig({ ...demo, TENNIS_WEB_ORIGINS: origin })).toThrow("exactly one canonical HTTPS origin");
  });
  it.each(["true", "*", "0.0.0.0/0", "172.30.42.0/24", "127.0.0.1,172.30.42.1", "proxy.example.com"])(
    "refuses broadly trusted proxy configuration: %s", proxy => {
      expect(() => readTennisRuntimeConfig({ ...demo, TENNIS_TRUSTED_PROXY: proxy })).toThrow("exact IP");
    },
  );
  it.each([
    "postgres://tennis_demo:synthetic@postgres/tennis_dev", "postgres://tennis_demo:synthetic@postgres/qintopia",
    "postgres://postgres:synthetic@postgres/tennis_demo", "postgres://tennis_demo@postgres/tennis_demo",
    "postgres://tennis_demo:synthetic@postgres/tennis_demo?host=other", "https://tennis_demo:synthetic@postgres/tennis_demo",
    "invalid",
  ])("refuses unintended or ambiguous demo databases", databaseUrl => {
    expect(() => readTennisRuntimeConfig({ ...demo, TENNIS_DATABASE_URL: databaseUrl })).toThrow(/tennis_demo/);
  });
  it.each(["", "short", Buffer.alloc(31).toString("base64"), demo.TENNIS_AI_ENCRYPTION_KEY.replace(/=$/, "")])(
    "requires a valid encryption key independently of provider readiness", key => {
      expect(() => readTennisRuntimeConfig({ ...demo, TENNIS_AI_ENCRYPTION_KEY: key })).toThrow("TENNIS_AI_ENCRYPTION_KEY");
    },
  );
  it.each([Buffer.alloc(32, 7).toString("base64"), Buffer.alloc(32, 7).toString("hex")])(
    "refuses reuse of the AI encryption key for payment signing", key => {
      expect(() => readTennisRuntimeConfig({ ...demo, TENNIS_PAYMENT_SIGNING_KEY: key })).toThrow("must be independent");
    },
  );
  it.each(["0", "5", "1.5", "NaN", "", "-1"])("caps demo pool connections: %s", max => {
    expect(() => readTennisRuntimeConfig({ ...demo, TENNIS_DATABASE_POOL_MAX: max })).toThrow("TENNIS_DATABASE_POOL_MAX");
  });
  it.each(["0", "65536", "1.5", "NaN", ""])("rejects invalid HTTP ports: %s", port => {
    expect(() => readTennisRuntimeConfig({ ...demo, TENNIS_HTTP_PORT: port })).toThrow("TENNIS_HTTP_PORT");
  });
});
