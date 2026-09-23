import { afterEach, describe, expect, it, vi } from "vitest";

const fixtures = vi.hoisted(() => ({ connect: vi.fn(), migrate: vi.fn(), end: vi.fn(), options: undefined as unknown }));
vi.mock("pg", () => ({ default: { Pool: class {
  constructor(options: unknown) { fixtures.options = options; }
  connect = fixtures.connect;
  end = fixtures.end;
} } }));
vi.mock("../../packages/db/src/tennis/migrate.ts", () => ({ migrateTennis: fixtures.migrate }));
const originalArgv = process.argv;
const originalExitCode = process.exitCode;
afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("administrator migration diagnostics", () => {
  it.each([
    [false, Object.assign(new Error("postgres://secret and raw details"), { code: "28P01" }), "connection; SQLSTATE=28P01"],
    [true, new Error("Tennis migration history or checksum mismatch"), "migration history mismatch"],
    [true, Object.assign(new Error("secret lock query"), { code: "55P03" }), "database error; SQLSTATE=55P03"],
    [true, Object.assign(new Error("secret statement"), { code: "57014" }), "database error; SQLSTATE=57014"],
    [true, Object.assign(new Error("secret details"), { code: "ABCDE" }), "database error"],
    [true, Object.assign(new Error("secret details"), { code: "secret\n28P01" }), "database error"],
  ])("reports only fixed classifications and whitelisted SQLSTATE", async (connected, error, expected) => {
    vi.resetModules();
    fixtures.connect.mockReset(); fixtures.migrate.mockReset(); fixtures.end.mockReset().mockResolvedValue(undefined);
    const release = vi.fn();
    fixtures.connect.mockImplementation(async () => { if (!connected) throw error; return { release }; });
    fixtures.migrate.mockRejectedValue(error);
    vi.stubEnv("TENNIS_MIGRATION_DATABASE_URL", "postgres://tennis_demo:secret@localhost/tennis_demo");
    process.argv = ["node", "release-migrate.mjs", "--apply"];
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await import("../../scripts/tennis/release-migrate.mts");
    expect(fixtures.options).toMatchObject({ lock_timeout: 30_000, statement_timeout: 600_000, connectionTimeoutMillis: 5000 });
    expect(log.mock.calls).toEqual([[`Tennis migration failed: ${expected}`]]);
    expect(process.exitCode).toBe(1);
    expect(fixtures.end).toHaveBeenCalledOnce();
    if (connected) expect(release).toHaveBeenCalledOnce();
  });
});
