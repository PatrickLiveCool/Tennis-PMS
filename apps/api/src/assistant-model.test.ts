import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { decryptKey, encryptKey, keyReady, normalizeBaseUrl, publicAddress, resolvePublicEndpoint } from "./assistant-model.ts";
import { validateDateRange } from "./assistant.ts";
vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
import { lookup } from "node:dns/promises";
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
describe("AI credential boundary", () => {
  it("requires a separate encryption key and detects tampering/wrong key", () => {
    vi.stubEnv("AI_SETTINGS_ENCRYPTION_KEY", ""); expect(keyReady()).toBe(false);
    vi.stubEnv("AI_SETTINGS_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
    const first = encryptKey("synthetic-provider-key"), second = encryptKey("synthetic-provider-key");
    expect(first).not.toBe(second); expect(first).not.toContain("synthetic-provider-key"); expect(decryptKey(first)).toBe("synthetic-provider-key");
    const parts = first.split("."); parts[2] = Buffer.from("corrupt").toString("base64"); expect(() => decryptKey(parts.join("."))).toThrow("无法解密");
    vi.stubEnv("AI_SETTINGS_ENCRYPTION_KEY", randomBytes(32).toString("base64")); expect(() => decryptKey(first)).toThrow("无法解密");
  });
  it.each(["http://api.example.com/v1", "https://key:secret@api.example.com", "https://api.example.com?key=x", "https://api.example.com#secret", "https://api.example.com/v1/chat/completions"])("rejects unsafe/non-root URLs: %s", value => expect(() => normalizeBaseUrl(value)).toThrow());
  it("normalizes a configured proxy prefix", () => expect(normalizeBaseUrl(" https://api.example.com/proxy/v1/ ")).toBe("https://api.example.com/proxy/v1"));
  it.each(["127.0.0.1", "0.0.0.0", "10.0.0.1", "172.16.0.2", "192.168.0.1", "169.254.169.254", "100.64.0.1", "198.19.0.1", "224.0.0.1", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "2002:7f00:1::", "2001:db8::1"])("rejects internal/special address %s", value => expect(publicAddress(value)).toBe(false));
  it("accepts public IPv4 and native global IPv6", () => { expect(publicAddress("8.8.8.8")).toBe(true); expect(publicAddress("2606:4700:4700::1111")).toBe(true); });
  it("rejects a DNS answer containing any private address", async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }] as never);
    await expect(resolvePublicEndpoint("https://api.example.com/v1")).rejects.toThrow("公网");
  });
  it("pins the validated DNS result", async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: "8.8.8.8", family: 4 }] as never);
    const result = await resolvePublicEndpoint("https://api.example.com/custom/v1"); expect(result.address.address).toBe("8.8.8.8"); expect(result.url.pathname).toBe("/custom/v1/chat/completions");
  });
  it.each([["2026-02-30", "2026-03-03"], ["2026-03-01", "2026-02-28"], ["2026-01-01", "2026-03-01"], ["invalid", "2026-09-15"]])("bounds availability dates %s %s", (a,b) => expect(() => validateDateRange(a,b)).toThrow());
});
