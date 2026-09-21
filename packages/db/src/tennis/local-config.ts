/** This bootstrap is local-only. Production credentials and deployments are not configured. */
export const localTennisDatabaseUrl = "postgres://tennis_dev:tennis_local_only@127.0.0.1:55439/tennis_dev";
export const localTennisTestDatabaseUrl = "postgres://tennis_dev:tennis_local_only@127.0.0.1:55439/tennis_test";

export function assertLocalTennisDatabaseUrl(value: string, mode: "development" | "test"): string {
  const url = new URL(value);
  const database = mode === "test" ? "/tennis_test" : "/tennis_dev";
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    url.hostname !== "127.0.0.1" ||
    url.port !== "55439" ||
    url.pathname !== database ||
    url.search ||
    url.hash ||
    url.username !== "tennis_dev"
  ) {
    throw new Error(`Tennis bootstrap requires local 127.0.0.1:55439${database} as tennis_dev, without URL options`);
  }
  return url.toString();
}
