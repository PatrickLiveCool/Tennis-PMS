import { expect, it } from "vitest";
import {
  assertLocalTennisDatabaseUrl,
  localTennisDatabaseUrl,
  localTennisTestDatabaseUrl,
} from "../../packages/db/src/tennis/local-config.ts";

it("separates development and test targets", () => {
  expect(assertLocalTennisDatabaseUrl(localTennisDatabaseUrl, "development")).toBe(localTennisDatabaseUrl);
  expect(assertLocalTennisDatabaseUrl(localTennisTestDatabaseUrl, "test")).toBe(localTennisTestDatabaseUrl);
  expect(() => assertLocalTennisDatabaseUrl(localTennisDatabaseUrl, "test")).toThrow();
  expect(() => assertLocalTennisDatabaseUrl(localTennisTestDatabaseUrl, "development")).toThrow();
});
it.each([
  "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia",
  localTennisTestDatabaseUrl.replace("tennis_test", "qintopia_e2e"),
  localTennisTestDatabaseUrl.replace("127.0.0.1", "db.example.com"),
  localTennisTestDatabaseUrl.replace("55439", "55432"),
  `${localTennisTestDatabaseUrl}?host=evil.example.com`,
  `${localTennisTestDatabaseUrl}#fragment`,
])("refuses a wrong test target before connecting: %s", (value) => {
  expect(() => assertLocalTennisDatabaseUrl(value, "test")).toThrow();
});
