import { describe, expect, it } from "vitest";
import { readCloudDemoConfig } from "../../scripts/tennis/cloud-demo-data.ts";

function environment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "development", TENNIS_DEMO_MODE: "true", TENNIS_ALLOW_SIMULATION: "true",
    TENNIS_DATABASE_URL: "postgres://tennis_demo:private-database-secret@postgres:5432/tennis_demo",
    TENNIS_DEMO_PLATFORM_PASSWORD: "synthetic-platform-secret-01",
    TENNIS_DEMO_ADMIN_PASSWORD: "synthetic-admin-secret-02",
    TENNIS_DEMO_STAFF_PASSWORD: "synthetic-staff-secret-03",
    TENNIS_DEMO_CUSTOMER_PASSWORD: "synthetic-customer-secret-04",
  };
}
describe("cloud demo initialization guards", () => {
  it("accepts only an explicit isolated demo configuration", () => {
    expect(Object.keys(readCloudDemoConfig(environment()).passwords)).toEqual(["demo.platform", "demo.green", "demo.staff", "demo.customer"]);
    for (const key of ["TENNIS_DEMO_MODE", "TENNIS_ALLOW_SIMULATION", "TENNIS_DATABASE_URL", "TENNIS_DEMO_ADMIN_PASSWORD"]) {
      const env = environment();
      delete env[key];
      expect(() => readCloudDemoConfig(env)).toThrow();
    }
    expect(() => readCloudDemoConfig({ ...environment(), NODE_ENV: "production" })).toThrow();
  });
  it("refuses housing/local/test DBs, roles, URL options and invalid credentials without echoing secrets", () => {
    for (const url of [
      "postgres://housing:private-secret@db/housing",
      "postgres://tennis_dev:private-secret@127.0.0.1:55439/tennis_dev",
      "postgres://tennis_demo:private-secret@db/tennis_test",
      "postgres://postgres:private-secret@db/tennis_demo",
      "postgres://tennis_demo:private-secret@db/tennis_demo?options=anything",
      "postgres://tennis_demo@db/tennis_demo",
    ]) expect(() => readCloudDemoConfig({ ...environment(), TENNIS_DATABASE_URL: url })).toThrow();
    for (const password of ["TennisPMS123!", "TennisPMS123!long-suffix", "short", "x".repeat(257), "private-database-secret", "synthetic-staff-secret-03"]) {
      expect(() => readCloudDemoConfig({ ...environment(), TENNIS_DEMO_ADMIN_PASSWORD: password })).toThrow();
      try { readCloudDemoConfig({ ...environment(), TENNIS_DEMO_ADMIN_PASSWORD: password }); }
      catch (error) { expect(String(error)).not.toContain(password); }
    }
  });
});
