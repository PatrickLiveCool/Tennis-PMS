import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptBackofficeKey, encryptBackofficeKey, normalizeBackofficeBaseUrl } from "../../packages/db/src/tennis/backoffice-assistant.ts";

describe("backoffice model credential storage", () => {
  it("uses a separate authenticated format, hides plaintext and rejects other-purpose/tampered keys", () => {
    const key = randomBytes(32), value = "synthetic-backoffice-provider-key";
    const encrypted = encryptBackofficeKey(value, key);
    expect(encrypted).not.toContain(value);
    expect(encryptBackofficeKey(value, key)).not.toBe(encrypted);
    expect(decryptBackofficeKey(encrypted, key)).toBe(value);
    expect(() => decryptBackofficeKey(encrypted, randomBytes(32))).toThrow();
    expect(() => decryptBackofficeKey(encrypted.slice(3), key)).toThrow();
    const pieces = encrypted.split("."); pieces[3] = Buffer.from("changed").toString("base64url");
    expect(() => decryptBackofficeKey(pieces.join("."), key)).toThrow();
    expect(() => encryptBackofficeKey(value, Buffer.alloc(16))).toThrow();
  });
  it.each(["http://localhost:8000/v1", "https://key:secret@example.test/v1", "https://example.test/v1?apiKey=secret", "https://example.test/v1#secret", "https://example.test/v1/chat/completions/", "invalid"])("rejects invalid model roots %s", (url) => {
    expect(() => normalizeBackofficeBaseUrl(url)).toThrow();
  });
  it("accepts a disabled empty configuration and normalizes compatible model roots", () => {
    expect(normalizeBackofficeBaseUrl(" ")).toBe("");
    expect(normalizeBackofficeBaseUrl(" https://model.example.test/proxy/v1/ ")).toBe("https://model.example.test/proxy/v1");
  });
});
