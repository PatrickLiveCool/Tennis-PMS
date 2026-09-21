import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ lookup: vi.fn(), fallback: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("../../apps/api/src/assistant-model.ts", async (original) => ({
  ...await original<typeof import("../../apps/api/src/assistant-model.ts")>(), resolvePublicEndpoint: mocks.fallback,
}));
import { resolveLocalModelEndpoint } from "../../scripts/tennis/local-model-endpoint.mts";
const base = "https://model.example.test/v1";
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });
describe("local model DNS compatibility", () => {
  it("resolves a proxy fake IP through public DNS and keeps the HTTPS hostname", async () => {
    mocks.lookup.mockResolvedValue([{ address: "198.18.2.75", family: 4 }]);
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ Status: 0, Answer: [{ type: 1, data: "104.21.39.105" }] }) });
    vi.stubGlobal("fetch", fetch);
    const endpoint = await resolveLocalModelEndpoint(base);
    expect(endpoint.url.href).toBe(`${base}/chat/completions`);
    expect(endpoint.address).toEqual({ address: "104.21.39.105", family: 4 });
    const [url, options] = fetch.mock.calls[0]!;
    expect(url.origin).toBe("https://cloudflare-dns.com");
    expect(url.searchParams.get("name")).toBe("model.example.test");
    expect(options.redirect).toBe("error");
    expect(options.headers).toEqual({ Accept: "application/dns-json" });
    expect(mocks.fallback).not.toHaveBeenCalled();
  });
  it("rejects DNS answers containing any private IP, failed lookup or no address", async () => {
    mocks.lookup.mockResolvedValue([{ address: "198.19.0.2", family: 4 }]);
    for (const result of [
      { Status: 0, Answer: [{ type: 1, data: "104.21.39.105" }, { type: 1, data: "127.0.0.1" }] },
      { Status: 3, Answer: [{ type: 1, data: "104.21.39.105" }] },
      { Status: 0, Answer: [] },
    ]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => result }));
      await expect(resolveLocalModelEndpoint(base)).rejects.toThrow("MODEL_DNS_NOT_PUBLIC");
    }
  });
  it("retains the standard resolver for ordinary DNS and refuses production", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    mocks.lookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    mocks.fallback.mockRejectedValue(new Error("private IP denied"));
    await expect(resolveLocalModelEndpoint(base)).rejects.toThrow("private IP denied");
    expect(fetch).not.toHaveBeenCalled();
    vi.stubEnv("NODE_ENV", "production");
    await expect(resolveLocalModelEndpoint(base)).rejects.toThrow("cannot run in production");
    expect(mocks.lookup).toHaveBeenCalledTimes(1);
  });
  it("bounds system DNS lookup time", async () => {
    vi.useFakeTimers(); mocks.lookup.mockReturnValue(new Promise(() => {}));
    const check = expect(resolveLocalModelEndpoint(base)).rejects.toThrow("MODEL_DNS_UNAVAILABLE");
    await vi.advanceTimersByTimeAsync(5000); await check;
  });
});
