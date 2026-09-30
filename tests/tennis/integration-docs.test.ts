import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTennisServer } from "../../apps/api/src/tennis/server.ts";
import { LocalMockPaymentGateway } from "../../packages/db/src/tennis/mock-payments.ts";

const db = new pg.Pool();
let app: Awaited<ReturnType<typeof buildTennisServer>>;

beforeAll(async () => {
  app = await buildTennisServer({
    db,
    gateway: new LocalMockPaymentGateway("integration-docs-test-secret-for-local-only", "local-simulation"),
    allowSimulation: true,
    runExpiryWorker: false,
  });
});
afterAll(async () => {
  await app.close();
  await db.end();
});

describe("published Tennis integration documents", () => {
  it("serves the handoff and linked API contract without a login session", async () => {
    for (const [name, heading] of [
      ["agent-handoff.md", "# Tennis PMS 外部智能体交接入口"],
      ["gateway.md", "# 可信 Gateway 接入契约"],
      ["external-agent.md", "# 外部智能体与人工接管接口"],
    ]) {
      const response = await app.inject({ method: "GET", url: `/api/tennis/integration-docs/${name}` });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/markdown");
      expect(response.body).toContain(heading);
    }
  });

  it("does not expose arbitrary project documents", async () => {
    const response = await app.inject({ method: "GET", url: "/api/tennis/integration-docs/development.md" });
    expect(response.statusCode).toBe(404);
  });
});
