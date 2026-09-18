import {
  constants, createCipheriv, generateKeyPairSync, sign, verify, X509Certificate,
  type KeyObject,
} from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WechatPayV3Security,
  WechatPayV3SecurityError,
} from "../../packages/db/src/tennis/wechatpay-v3-security.ts";
import { isVerifiedPaymentEvent, isVerifiedRefundEvent } from "../../packages/db/src/tennis/payment-port.ts";

// All keys, identifiers, amounts and payloads in this file are synthetic and local.
// Canonical strings and envelopes are built independently from the production module.
const pair = () => generateKeyPairSync("rsa", { modulusLength: 2048 });
const merchant = pair(), platformA = pair(), platformB = pair();
const privatePem = (key: KeyObject) => key.export({ type: "pkcs8", format: "pem" }).toString();
const publicPem = (key: KeyObject) => key.export({ type: "spki", format: "pem" }).toString();
const merchantPem = privatePem(merchant.privateKey);
const apiV3Key = "0123456789abcdef0123456789abcdef";
const now = Date.UTC(2026, 8, 19, 4, 0, 0);
const timestamp = String(now / 1000);
const keyA = "PUB_KEY_ID_01111111111111111111111111111111";
const keyB = "PUB_KEY_ID_02222222222222222222222222222222";
const rawResponse = '{ "synthetic_private_note": "仅合成测试，不是真实客户", "amount":12000 }\n';
const config = () => ({
  merchantId: "1900000100",
  merchantCertificateSerial: "AABB00112233445566778899",
  merchantPrivateKeyPem: merchantPem,
  apiV3Key,
  platformKeys: [
    { id: keyA, publicKeyPem: publicPem(platformA.publicKey) },
    { id: keyB, publicKeyPem: publicPem(platformB.publicKey) },
  ],
  now: () => now,
});
const security = () => new WechatPayV3Security(config());
type Code = "INVALID_WECHAT_CONFIGURATION" | "INVALID_WECHAT_REQUEST" | "INVALID_WECHAT_SIGNATURE" | "INVALID_WECHAT_NOTIFICATION";
function rejected(action: () => unknown, code: Code, extraSecrets: string[] = []) {
  let failure: unknown;
  try { action(); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(WechatPayV3SecurityError);
  expect((failure as WechatPayV3SecurityError).code).toBe(code);
  const exposed = `${String(failure)} ${JSON.stringify(failure)}`;
  for (const secret of [apiV3Key, merchantPem, rawResponse, "仅合成测试，不是真实客户", ...extraSecrets])
    if (secret) expect(exposed).not.toContain(secret);
}
function responseHeaders(body = rawResponse, options: { key?: KeyObject; keyId?: string; time?: string; nonce?: string } = {}) {
  const time = options.time ?? timestamp;
  const nonce = options.nonce ?? "synthetic-response-nonce";
  return {
    "Wechatpay-Timestamp": time,
    "Wechatpay-Nonce": nonce,
    "Wechatpay-Serial": options.keyId ?? keyA,
    "Wechatpay-Signature": sign("RSA-SHA256", Buffer.from(`${time}\n${nonce}\n${body}\n`), {
      key: options.key ?? platformA.privateKey, padding: constants.RSA_PKCS1_PADDING,
    }).toString("base64"),
  };
}
function authorization(headers: Readonly<Record<string, string>>) {
  const value = Object.entries(headers).find(([name]) => name.toLowerCase() === "authorization")?.[1] ?? "";
  expect(value).toMatch(/^WECHATPAY2-SHA256-RSA2048 /);
  const fields = Object.fromEntries([...value.matchAll(/([a-z_]+)="([^"]*)"/g)].map((match) => [match[1]!, match[2]!]));
  expect(fields.mchid).toBe(config().merchantId);
  expect(fields.serial_no).toBe(config().merchantCertificateSerial);
  expect(fields.timestamp).toBe(timestamp);
  expect(fields.nonce_str).toBeTruthy();
  return fields;
}
function authenticRequest(fields: Record<string, string>, method: string, path: string, body: string) {
  return verify("RSA-SHA256", Buffer.from(`${method}\n${path}\n${fields.timestamp}\n${fields.nonce_str}\n${body}\n`),
    { key: merchant.publicKey, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(fields.signature!, "base64"));
}

// Minimal, standards-shaped self-signed X.509 certificate for the certificate-key branch.
// DER construction is confined to test fixture generation; node:crypto parses and verifies it.
function der(tag: number, bytes: Buffer): Buffer {
  let length: Buffer;
  if (bytes.length < 128) length = Buffer.from([bytes.length]);
  else {
    let hex = bytes.length.toString(16);
    if (hex.length % 2) hex = `0${hex}`;
    const size = Buffer.from(hex, "hex");
    length = Buffer.concat([Buffer.from([0x80 + size.length]), size]);
  }
  return Buffer.concat([Buffer.from([tag]), length, bytes]);
}
const sequence = (...parts: Buffer[]) => der(0x30, Buffer.concat(parts));
function certificate(validFrom = "260101000000Z", validTo = "270101000000Z") {
  const algorithm = sequence(der(0x06, Buffer.from("2a864886f70d01010b", "hex")), der(0x05, Buffer.alloc(0)));
  const name = sequence(der(0x31, sequence(der(0x06, Buffer.from("550403", "hex")), der(0x0c, Buffer.from("Synthetic WeChat Test Platform")))));
  const tbs = sequence(
    der(0xa0, der(0x02, Buffer.from([2]))), der(0x02, Buffer.from("1234abcd", "hex")), algorithm, name,
    sequence(der(0x17, Buffer.from(validFrom)), der(0x17, Buffer.from(validTo))), name,
    platformB.publicKey.export({ type: "spki", format: "der" }),
  );
  const signature = sign("RSA-SHA256", tbs, { key: platformB.privateKey, padding: constants.RSA_PKCS1_PADDING });
  const encoded = sequence(tbs, algorithm, der(0x03, Buffer.concat([Buffer.from([0]), signature]))).toString("base64");
  const pem = `-----BEGIN CERTIFICATE-----\n${encoded.match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`;
  const parsed = new X509Certificate(pem);
  if (!parsed.verify(platformB.publicKey)) throw new Error("Synthetic certificate fixture is invalid");
  return { id: parsed.serialNumber, certificatePem: pem };
}
const platformCertificate = certificate();

const transaction = {
  mchid: "1900000100", out_trade_no: "synthetic-order", transaction_id: "synthetic-channel-receipt",
  trade_state: "SUCCESS", amount: { total: 12000, currency: "CNY" },
  description: "仅合成测试，不是真实客户",
};
function envelope(options: { associatedData?: string; omitAssociatedData?: boolean; plaintext?: string | Buffer; key?: string; nonce?: string } = {}) {
  const associatedData = options.associatedData ?? (options.omitAssociatedData ? "" : "transaction");
  const nonce = options.nonce ?? "abcdefghijkl";
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(options.key ?? apiV3Key), Buffer.from(nonce));
  cipher.setAAD(Buffer.from(associatedData));
  const plaintext = options.plaintext ?? JSON.stringify(transaction);
  const ciphertext = Buffer.concat([
    cipher.update(typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext), cipher.final(), cipher.getAuthTag(),
  ]).toString("base64");
  return {
    id: "synthetic-notification-001", create_time: "2026-09-19T12:00:00+08:00", event_type: "TRANSACTION.SUCCESS",
    resource_type: "encrypt-resource", summary: "synthetic only",
    resource: {
      algorithm: "AEAD_AES_256_GCM", original_type: "transaction", nonce, ciphertext,
      ...(options.omitAssociatedData ? {} : { associated_data: associatedData }),
    },
  };
}
function decrypted(value = envelope(), target = security()) {
  const body = JSON.stringify(value);
  return target.decryptNotification(body, responseHeaders(body));
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("WeChat API v3 configured trust and request signing", () => {
  it("rejects invalid merchant credentials and byte-incorrect API v3 keys without exposing them", () => {
    for (const patch of [
      { merchantId: "" }, { merchantCertificateSerial: "serial\r\nInjected: yes" },
      { merchantPrivateKeyPem: "synthetic-secret-invalid-private-pem" },
      { apiV3Key: "x".repeat(31) }, { apiV3Key: "密".repeat(32) },
    ]) rejected(() => new WechatPayV3Security({ ...config(), ...patch }), "INVALID_WECHAT_CONFIGURATION", Object.values(patch));
  });

  it("rejects duplicate trust IDs, malformed keys, private material in a public-key field and non-RSA keys", () => {
    const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const first = config().platformKeys[0]!;
    for (const platformKeys of [
      [first, { id: first.id, publicKeyPem: publicPem(platformB.publicKey) }],
      [{ id: keyA, publicKeyPem: "synthetic-secret-invalid-public-pem" }],
      [{ id: keyA, publicKeyPem: privatePem(platformA.privateKey) }],
      [{ id: keyA, publicKeyPem: publicPem(ec.publicKey) }],
      [{ id: platformCertificate.id, publicKeyPem: platformCertificate.certificatePem }],
      [],
    ]) rejected(() => new WechatPayV3Security({ ...config(), platformKeys }), "INVALID_WECHAT_CONFIGURATION");
  });

  it("rejects a certificate registered under a different serial number", () => {
    for (const id of ["FFFF9999", platformCertificate.id.toLowerCase()])
      rejected(() => new WechatPayV3Security({ ...config(), platformKeys: [{ ...platformCertificate, id }] }),
        "INVALID_WECHAT_CONFIGURATION");
  });

  it("signs the exact POST UTF-8 body and ordered query while retaining the fixed official origin", () => {
    const path = "/v3/pay/transactions/native?note=%E7%BD%91%E7%90%83&note=a%2Bb";
    const rawBody = '{\n "description":"网球场 synthetic", "amount":{"total":12000,"currency":"CNY"}\n}';
    const request = security().prepareRequest({ method: "POST", path, rawBody });
    expect(request).toMatchObject({ url: `https://api.mch.weixin.qq.com${path}`, method: "POST", rawBody });
    expect(authenticRequest(authorization(request.headers), "POST", path, rawBody)).toBe(true);
  });

  it("supports the declared methods, authenticates empty GET bodies and generates fresh request nonces", () => {
    const target = security();
    const nonces = new Set<string>();
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"] as const) {
      const body = method === "GET" ? "" : '{"synthetic":true}';
      const request = target.prepareRequest({ method, path: "/v3/synthetic/resource?x=1", rawBody: body });
      const auth = authorization(request.headers);
      expect(authenticRequest(auth, method, "/v3/synthetic/resource?x=1", body)).toBe(true);
      nonces.add(auth.nonce_str!);
    }
    expect(nonces.size).toBe(5);
  });

  it("binds a request signature to method, complete query and exact body bytes", () => {
    const path = "/v3/pay/transactions/native?mchid=1900000100&x=first&x=second";
    const body = '{"amount":12000}';
    const request = security().prepareRequest({ method: "POST", path, rawBody: body });
    const auth = authorization(request.headers);
    for (const [method, changedPath, changedBody] of [
      ["PUT", path, body], ["POST", path.replace("first&x=second", "second&x=first"), body],
      ["POST", path, '{ "amount":12000}'], ["POST", path, '{"amount":12001}'],
    ]) expect(authenticRequest(auth, method!, changedPath!, changedBody!)).toBe(false);
  });

  it("rejects absolute, authority-relative and non-v3 paths", () => {
    for (const path of ["https://api.mch.weixin.qq.com/v3/pay", "https://evil.example/v3/pay", "//evil.example/v3/pay", "v3/pay", "/v2/pay", "/v30/pay", "/v3"])
      rejected(() => security().prepareRequest({ method: "GET", path, rawBody: "" }), "INVALID_WECHAT_REQUEST");
  });

  it("rejects paths that a URL parser would normalize or reinterpret", () => {
    for (const path of ["/v3/a/../pay", "/v3/./pay", "/v3/%2e%2e/pay", "/v3/a/%2E/pay", " /v3/pay", "/v3/pay?q=a b"])
      rejected(() => security().prepareRequest({ method: "GET", path, rawBody: "" }), "INVALID_WECHAT_REQUEST");
  });

  it("rejects fragment, backslash and control-character request targets", () => {
    for (const path of ["/v3/pay#fragment", "/v3/pay\\other", "/v3/pay\r\nX-Test: forged", "/v3/pay?x=1\n", "/v3/pa\ty"])
      rejected(() => security().prepareRequest({ method: "GET", path, rawBody: "" }), "INVALID_WECHAT_REQUEST");
  });

  it("rejects GET bodies and verbs outside the declared canonical method set", () => {
    for (const rawBody of ["{}", " ", "\n"])
      rejected(() => security().prepareRequest({ method: "GET", path: "/v3/pay", rawBody }), "INVALID_WECHAT_REQUEST");
    for (const method of ["get", "HEAD", "POST\nGET"])
      rejected(() => security().prepareRequest({ method: method as "GET", path: "/v3/pay", rawBody: "" }), "INVALID_WECHAT_REQUEST");
  });

  it("enforces the local 1 MiB body bound in UTF-8 bytes for both requests and responses", () => {
    const localBodyLimit = 1024 * 1024;
    const body = "场".repeat(Math.floor(localBodyLimit / 3) + 1);
    expect(body.length).toBeLessThan(localBodyLimit);
    expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(localBodyLimit);
    rejected(() => security().prepareRequest({ method: "POST", path: "/v3/synthetic", rawBody: body }),
      "INVALID_WECHAT_REQUEST", ["场".repeat(16)]);
    rejected(() => security().verifyResponse(body, responseHeaders(body)), "INVALID_WECHAT_SIGNATURE", ["场".repeat(16)]);
  });

  it("does not perform network requests when preparing, authenticating or decrypting", () => {
    const fetch = vi.fn(() => { throw new Error("Unexpected external request"); });
    vi.stubGlobal("fetch", fetch);
    const target = security();
    target.prepareRequest({ method: "GET", path: "/v3/synthetic", rawBody: "" });
    target.verifyResponse(rawResponse, responseHeaders());
    decrypted(envelope(), target);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("WeChat API v3 response authentication", () => {
  it("accepts case-insensitive HTTP header names and the original signed raw body", () => {
    const headers = Object.fromEntries(Object.entries(responseHeaders()).map(([name, value]) => [name.toUpperCase(), value]));
    expect(security().verifyResponse(rawResponse, headers)).toBeUndefined();
    expect(security().verifyResponse("", responseHeaders(""))).toBeUndefined();
  });

  it("accepts either explicitly configured rotation key and a valid configured certificate", () => {
    expect(security().verifyResponse(rawResponse, responseHeaders())).toBeUndefined();
    expect(security().verifyResponse(rawResponse, responseHeaders(rawResponse, { key: platformB.privateKey, keyId: keyB }))).toBeUndefined();
    const target = new WechatPayV3Security({ ...config(), platformKeys: [platformCertificate] });
    expect(target.verifyResponse(rawResponse, responseHeaders(rawResponse, { key: platformB.privateKey, keyId: platformCertificate.id }))).toBeUndefined();
  });

  it("rejects unknown IDs and signatures made by another key even when both keys are trusted", () => {
    for (const headers of [
      responseHeaders(rawResponse, { keyId: "PUB_KEY_ID_UNKNOWN" }),
      responseHeaders(rawResponse, { keyId: keyA.toLowerCase() }),
      responseHeaders(rawResponse, { key: platformB.privateKey, keyId: keyA }),
    ]) rejected(() => security().verifyResponse(rawResponse, headers), "INVALID_WECHAT_SIGNATURE");
  });

  it("does not normalize or reserialize a response before authenticating it", () => {
    const headers = responseHeaders();
    for (const body of [JSON.stringify(JSON.parse(rawResponse)), rawResponse.trimEnd(), rawResponse.replace("12000", "12001")])
      rejected(() => security().verifyResponse(body, headers), "INVALID_WECHAT_SIGNATURE");
  });

  it("rejects nonce and timestamp tampering on an otherwise valid response", () => {
    for (const change of [{ "Wechatpay-Nonce": "other-nonce" }, { "Wechatpay-Timestamp": String(now / 1000 + 1) }])
      rejected(() => security().verifyResponse(rawResponse, { ...responseHeaders(), ...change }), "INVALID_WECHAT_SIGNATURE");
  });

  it("requires all four security headers to be present and nonempty", () => {
    for (const name of Object.keys(responseHeaders())) {
      for (const missing of [undefined, ""]) {
        const headers: Record<string, string | undefined> = { ...responseHeaders(), [name]: missing };
        rejected(() => security().verifyResponse(rawResponse, headers), "INVALID_WECHAT_SIGNATURE");
      }
    }
  });

  it("rejects case-colliding duplicate security headers and inherited forged header values", () => {
    for (const [name, value] of Object.entries(responseHeaders()))
      rejected(() => security().verifyResponse(rawResponse, { ...responseHeaders(), [name.toLowerCase()]: value }), "INVALID_WECHAT_SIGNATURE");
    rejected(() => security().verifyResponse(rawResponse, Object.create(responseHeaders()) as Record<string, string>), "INVALID_WECHAT_SIGNATURE");
  });

  it("rejects comma-joined duplicate values and control characters in security header values", () => {
    for (const [name, value] of Object.entries(responseHeaders())) {
      for (const changed of [`${value}, ${value}`, `${value}\r\nX-Synthetic: forged`])
        rejected(() => security().verifyResponse(rawResponse, { ...responseHeaders(), [name]: changed }), "INVALID_WECHAT_SIGNATURE");
    }
  });

  it("accepts 299 seconds of skew but rejects either 300-second boundary", () => {
    for (const delta of [-299, 299])
      expect(security().verifyResponse(rawResponse, responseHeaders(rawResponse, { time: String(now / 1000 + delta) }))).toBeUndefined();
    for (const delta of [-301, -300, 300, 301])
      rejected(() => security().verifyResponse(rawResponse, responseHeaders(rawResponse, { time: String(now / 1000 + delta) })), "INVALID_WECHAT_SIGNATURE");
  });

  it("rejects noncanonical numeric timestamps even if their signature is cryptographically correct", () => {
    for (const time of [` ${timestamp}`, `${timestamp}.0`, `+${timestamp}`, `${timestamp}e0`, "NaN"])
      rejected(() => security().verifyResponse(rawResponse, responseHeaders(rawResponse, { time })), "INVALID_WECHAT_SIGNATURE");
  });

  it("rejects malformed Base64 and WeChat signature-probe strings", () => {
    for (const signature of ["WECHATPAY/SIGNTEST/synthetic-signature", "not-base64!", `${responseHeaders()["Wechatpay-Signature"]}!`, "AQ=="])
      rejected(() => security().verifyResponse(rawResponse, { ...responseHeaders(), "Wechatpay-Signature": signature }), "INVALID_WECHAT_SIGNATURE");
  });

  it("allows an omitted or exact signature-type header and rejects every other declared type", () => {
    expect(security().verifyResponse(rawResponse, responseHeaders())).toBeUndefined();
    expect(security().verifyResponse(rawResponse, {
      ...responseHeaders(), "Wechatpay-Signature-Type": "WECHATPAY2-SHA256-RSA2048",
    })).toBeUndefined();
    for (const type of ["", "WECHATPAY2-SHA256-RSA1024", "wechatpay2-sha256-rsa2048", "WECHATPAY2-SHA256-RSA2048, OTHER"])
      rejected(() => security().verifyResponse(rawResponse, {
        ...responseHeaders(), "Wechatpay-Signature-Type": type,
      }), "INVALID_WECHAT_SIGNATURE");
  });

  it("rejects RSA-PSS signatures rather than silently changing the declared PKCS1 algorithm", () => {
    const headers = responseHeaders();
    headers["Wechatpay-Signature"] = sign("RSA-SHA256", Buffer.from(`${timestamp}\n${headers["Wechatpay-Nonce"]}\n${rawResponse}\n`), {
      key: platformA.privateKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32,
    }).toString("base64");
    rejected(() => security().verifyResponse(rawResponse, headers), "INVALID_WECHAT_SIGNATURE");
  });

  it("requires the configured certificate to be valid at both current and response-signing time", () => {
    for (const [cert, delta] of [
      [certificate("250101000000Z", "260101000000Z"), 0],
      [certificate("260919040100Z", "270101000000Z"), 120],
      [certificate("260101000000Z", "260919040100Z"), 299],
    ] as const) {
      const target = new WechatPayV3Security({ ...config(), platformKeys: [cert] });
      rejected(() => target.verifyResponse(rawResponse, responseHeaders(rawResponse, {
        key: platformB.privateKey, keyId: cert.id, time: String(now / 1000 + delta),
      })), "INVALID_WECHAT_SIGNATURE");
    }
  });
});

describe("WeChat API v3 notification verification and decryption", () => {
  it("authenticates then decrypts a notification without certifying a PMS payment or refund event", () => {
    const result = decrypted();
    expect(result).toEqual({
      eventId: "synthetic-notification-001", eventType: "TRANSACTION.SUCCESS", createdAt: "2026-09-19T12:00:00+08:00",
      originalType: "transaction", resource: transaction,
    });
    expect(isVerifiedPaymentEvent(result)).toBe(false);
    expect(isVerifiedPaymentEvent(result.resource)).toBe(false);
    expect(isVerifiedRefundEvent(result)).toBe(false);
    expect(isVerifiedRefundEvent(result.resource)).toBe(false);
  });

  it("supports omitted associated_data as empty AAD and retains UTF-8 plaintext", () => {
    expect(decrypted(envelope({ omitAssociatedData: true })).resource).toEqual(transaction);
    expect(decrypted(envelope({ associatedData: "" })).resource).toEqual(transaction);
  });

  it("rejects an unsigned malformed body before JSON parsing or decryption", () => {
    const body = 'not-json synthetic confidential body';
    rejected(() => security().decryptNotification(body, {}), "INVALID_WECHAT_SIGNATURE", [body]);
    rejected(() => security().decryptNotification(body, responseHeaders(body)), "INVALID_WECHAT_NOTIFICATION", [body]);
  });

  it("rejects missing event metadata, non-object envelopes and the wrong resource_type", () => {
    const original = envelope();
    for (const invalid of [
      null, [], "synthetic", { ...original, id: "" }, { ...original, event_type: "" },
      { ...original, create_time: "invalid-date" }, { ...original, resource_type: "plaintext" },
      { ...original, resource: null }, { ...original, resource: { ...original.resource, original_type: "" } },
    ]) {
      const body = JSON.stringify(invalid);
      rejected(() => security().decryptNotification(body, responseHeaders(body)), "INVALID_WECHAT_NOTIFICATION");
    }
  });

  it("rejects unsupported algorithms, non-12-byte nonces and invalid or short ciphertext", () => {
    const original = envelope();
    for (const patch of [
      { algorithm: "AES_256_GCM" }, { algorithm: "AEAD_AES_128_GCM" },
      { nonce: "too-short" }, { nonce: "abcdefghijklX" }, { nonce: "汉".repeat(12) },
      { ciphertext: "not-base64!" }, { ciphertext: Buffer.alloc(15).toString("base64") },
    ]) {
      const body = JSON.stringify({ ...original, resource: { ...original.resource, ...patch } });
      rejected(() => security().decryptNotification(body, responseHeaders(body)), "INVALID_WECHAT_NOTIFICATION");
    }
  });

  it("authenticates nonce, AAD, ciphertext and tag even when the outer notification is correctly signed", () => {
    const original = envelope();
    const ciphertext = Buffer.from(original.resource.ciphertext, "base64");
    const changedCiphertext = Buffer.from(ciphertext);
    changedCiphertext[0] = changedCiphertext[0]! ^ 1;
    const changedTag = Buffer.from(ciphertext);
    changedTag[changedTag.length - 1] = changedTag[changedTag.length - 1]! ^ 1;
    for (const patch of [
      { nonce: "abcdefghijkm" }, { associated_data: "another-resource" },
      { ciphertext: changedCiphertext.toString("base64") }, { ciphertext: changedTag.toString("base64") },
    ]) {
      const body = JSON.stringify({ ...original, resource: { ...original.resource, ...patch } });
      rejected(() => security().decryptNotification(body, responseHeaders(body)), "INVALID_WECHAT_NOTIFICATION");
    }
  });

  it("rejects decryption under a different valid-length merchant API v3 key", () => {
    const wrongKey = "abcdef0123456789abcdef0123456789";
    const body = JSON.stringify(envelope());
    const target = new WechatPayV3Security({ ...config(), apiV3Key: wrongKey });
    rejected(() => target.decryptNotification(body, responseHeaders(body)), "INVALID_WECHAT_NOTIFICATION", [wrongKey, body]);
  });

  it("rejects authenticated plaintext with invalid UTF-8 instead of accepting replacement characters", () => {
    const plaintext = Buffer.concat([Buffer.from('{"description":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')]);
    const body = JSON.stringify(envelope({ plaintext }));
    rejected(() => security().decryptNotification(body, responseHeaders(body)), "INVALID_WECHAT_NOTIFICATION", [body]);
  });

  it("rejects authenticated plaintext that is not a JSON object", () => {
    for (const plaintext of ["not-json", "null", "[]", '"synthetic scalar"', "42"]) {
      const body = JSON.stringify(envelope({ plaintext }));
      rejected(() => security().decryptNotification(body, responseHeaders(body)), "INVALID_WECHAT_NOTIFICATION", [plaintext === "not-json" ? plaintext : body]);
    }
  });
});
