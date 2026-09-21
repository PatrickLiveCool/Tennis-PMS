import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { backofficeExecutor, boundedHistory, parseBackofficeToolArguments, testBackofficeModel } from "../../apps/api/src/tennis/backoffice-model.ts";
import type { BackofficeRun } from "../../packages/db/src/tennis/backoffice-assistant.ts";
import type { ModelInput } from "../../apps/api/src/assistant-model.ts";

const run = (): BackofficeRun => ({
  config: { model: "synthetic", baseUrl: "https://synthetic.example.test/v1", apiKey: "synthetic-secret" },
  history: [{ role: "user", content: "请打开排场" }],
  context: { page: "schedule" }, venue: { id: "private-venue-id", name: "示例场馆", timezone: "Asia/Shanghai" }, authorize: vi.fn(async () => {}), signal: new AbortController().signal,
});
const pool = {} as pg.Pool, actor = { tenantId: "tenant", subjectId: "employee" };
const call = (name: string, args = "{}") => ({ content: null, tool_calls: [{ id: "synthetic-call", type: "function" as const, function: { name, arguments: args } }] });
describe("bounded backoffice model executor without external connections", () => {
  it("does not silently connect when no synthetic transport is injected", async () => {
    expect(() => backofficeExecutor(pool, actor)).toThrow("BACKOFFICE_MODEL_CONNECTION_NOT_ENABLED");
    await expect(testBackofficeModel(run().config)).rejects.toMatchObject({ code: "BACKOFFICE_MODEL_CONNECTION_NOT_ENABLED" });
  });
  it.each([
    ["create_quote", "{}"], ["get_courts", '{"tenantId":"other"}'], ["get_schedule", '{"date":"2099-09-18","venueId":"other"}'],
    ["get_current_order", '{"orderId":"other"}'], ["open_page", '{"page":"https://evil.example"}'], ["open_page", '{"page":"orders","orderId":"other"}'],
    ["get_schedule", '{"date":"tomorrow"}'], ["__proto__", "{}"], ["get_courts", "[]"],
  ])("rejects tool identity injection or non-read tool %s", (name, args) => expect(() => parseBackofficeToolArguments(name, args)).toThrow());
  it("returns only server-created local actions and excludes private context ids from model input", async () => {
    const snapshots: ModelInput[] = [];
    const transport = vi.fn(async (input: ModelInput) => { snapshots.push(structuredClone(input)); return snapshots.length === 1 ? call("open_page", '{"page":"schedule"}') : { content: "可在排场页查看。" }; });
    const context = run(); context.context.orderId = "private-order-id";
    const result = await backofficeExecutor(pool, actor, transport)(context);
    expect(result.actions).toEqual([{ page: "schedule", label: "打开排场" }]);
    expect(JSON.stringify(snapshots)).not.toContain("private-order-id");
    expect(JSON.stringify(snapshots)).not.toContain("private-venue-id");
    expect(context.authorize).toHaveBeenCalledTimes(3);
    expect(snapshots[1]?.messages.at(-1)?.content).toContain('"submitted":false');
  });
  it("bounds model rounds and rejects duplicate call ids", async () => {
    const repeat = vi.fn(async () => call("get_current_order"));
    await expect(backofficeExecutor(pool, actor, repeat)(run())).rejects.toMatchObject({ code: "ASSISTANT_UNAVAILABLE" });
    expect(repeat).toHaveBeenCalledTimes(4);
    await expect(backofficeExecutor(pool, actor, async () => ({ content: null, tool_calls: [...call("get_current_order").tool_calls, ...call("get_current_order").tool_calls] }))(run())).rejects.toMatchObject({ code: "ASSISTANT_UNAVAILABLE" });
  });
  it("rechecks authorization before tools or a further model call", async () => {
    const context = run();
    context.authorize = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("revoked"));
    const transport = vi.fn(async () => call("open_page", '{"page":"schedule"}'));
    await expect(backofficeExecutor(pool, actor, transport)(context)).rejects.toThrow("revoked");
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("caps history and connection tests verify a tool response instead of guessing success", async () => {
    const history = boundedHistory(Array.from({ length: 40 }, (_, index) => ({ role: index % 2 ? "user" as const : "assistant" as const, content: "x".repeat(3000) })));
    expect(history.reduce((sum, item) => sum + (item.content?.length ?? 0), 0)).toBeLessThanOrEqual(24000);
    expect(history[0]?.role).toBe("user");
    await expect(testBackofficeModel(run().config, async () => ({ content: "ok" }))).rejects.toMatchObject({ code: "ASSISTANT_UNAVAILABLE" });
    await expect(testBackofficeModel(run().config, async () => call("connection_check"))).resolves.toBeUndefined();
  });
});
