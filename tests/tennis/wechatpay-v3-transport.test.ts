import { constants, generateKeyPairSync, sign, verify } from "node:crypto";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { RequestOptions } from "node:https";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WechatPayV3Security, type WechatPayV3Request } from "../../packages/db/src/tennis/wechatpay-v3-security.ts";
import {
  WechatPayV3Transport, WechatPayV3TransportError, type WechatPayV3HttpRequestFactory,
} from "../../packages/db/src/tennis/wechatpay-v3-transport.ts";

// Synthetic RSA credentials and loopback sockets only. The injected factory fails
// closed unless the production transport passes the exact official HTTPS origin.
const merchant = generateKeyPairSync("rsa", { modulusLength: 2048 });
const platform = generateKeyPairSync("rsa", { modulusLength: 2048 });
const merchantPem = merchant.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const apiV3Key = "0123456789abcdef0123456789abcdef";
const now = Date.UTC(2026, 8, 20, 4, 0, 0);
const timestamp = String(now / 1000);
const platformId = "PUB_KEY_ID_03333333333333333333333333333333";
const confidential = "synthetic-private-provider-detail";
const security = () => new WechatPayV3Security({
  merchantId: "1900000100", merchantCertificateSerial: "AABBCCDDEEFF00112233",
  merchantPrivateKeyPem: merchantPem, apiV3Key,
  platformKeys: [{ id: platformId, publicKeyPem: platform.publicKey.export({ type: "spki", format: "pem" }).toString() }],
  now: () => now,
});
const input = (overrides: Partial<WechatPayV3Request> = {}): WechatPayV3Request => ({
  method: "GET", path: "/v3/synthetic?mchid=1900000100", rawBody: "", ...overrides,
});
function bytes(body: string | Buffer) { return typeof body === "string" ? Buffer.from(body, "utf8") : body; }
function signedHeaders(body: string | Buffer) {
  const nonce = "synthetic-response-nonce";
  const canonical = Buffer.concat([Buffer.from(`${timestamp}\n${nonce}\n`), bytes(body), Buffer.from("\n")]);
  return {
    "Wechatpay-Timestamp": timestamp, "Wechatpay-Nonce": nonce, "Wechatpay-Serial": platformId,
    "Wechatpay-Signature": sign("RSA-SHA256", canonical, { key: platform.privateKey, padding: constants.RSA_PKCS1_PADDING }).toString("base64"),
  };
}
function signed(res: ServerResponse, body: string | Buffer, status = 200, extra: Record<string, string | number> = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...signedHeaders(body), ...extra });
  res.end(body);
}
const servers = new Set<Server>();
const timers = new Set<ReturnType<typeof setTimeout>>();
function delayed(work: () => void, ms: number) {
  const timer = setTimeout(() => { timers.delete(timer); work(); }, ms);
  timers.add(timer);
  return timer;
}
async function bodyOf(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}
async function loopback(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) {
  const server = createServer((req, res) => {
    res.on("error", () => {});
    void Promise.resolve(handler(req, res)).catch(() => res.destroy());
  });
  servers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const port = (server.address() as AddressInfo).port;
  const calls: { url: string; options: RequestOptions }[] = [];
  let responseSeen!: () => void;
  const receivedHeaders = new Promise<void>((resolve) => { responseSeen = resolve; });
  const factory: WechatPayV3HttpRequestFactory = (url, options, onResponse) => {
    if (url.origin !== "https://api.mch.weixin.qq.com" || url.protocol !== "https:" || url.username || url.password)
      throw new Error("Test factory refused a non-official request target");
    calls.push({ url: url.href, options: { ...options } });
    const local = new URL(`http://127.0.0.1:${port}${url.pathname}${url.search}`);
    return httpRequest(local, {
      method: options.method, headers: options.headers, agent: false,
      ...(options.maxHeaderSize === undefined ? {} : { maxHeaderSize: options.maxHeaderSize }),
    }, (res) => { responseSeen(); onResponse(res); });
  };
  const transport = (timeoutMs = 1000) => new WechatPayV3Transport(security(), { timeoutMs, request: factory });
  async function close() {
    if (!server.listening) return;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    servers.delete(server);
  }
  return { server, factory, calls, receivedHeaders, transport, close };
}
type Result = Awaited<ReturnType<WechatPayV3Transport["request"]>>;
type UnknownCode = Extract<Result, { kind: "UNKNOWN" }>["code"];
function unknown(result: Result, code: UnknownCode) {
  expect(result).toEqual({ kind: "UNKNOWN", code });
  const exposed = JSON.stringify(result);
  for (const secret of [merchantPem, apiV3Key, confidential, "rawHeaders", "Authorization"])
    expect(exposed).not.toContain(secret);
}
function assertMerchantSignature(req: { url?: string | undefined; method?: string | undefined; headers: IncomingMessage["headers"]; body: Buffer }) {
  const authorization = req.headers.authorization ?? "";
  expect(authorization).toMatch(/^WECHATPAY2-SHA256-RSA2048 /);
  const fields = Object.fromEntries([...authorization.matchAll(/([a-z_]+)="([^"]*)"/g)].map((part) => [part[1]!, part[2]!]));
  expect(fields.mchid).toBe("1900000100");
  expect(fields.serial_no).toBe("AABBCCDDEEFF00112233");
  const canonical = Buffer.concat([
    Buffer.from(`${req.method}\n${req.url}\n${fields.timestamp}\n${fields.nonce_str}\n`), req.body, Buffer.from("\n"),
  ]);
  expect(verify("RSA-SHA256", canonical, { key: merchant.publicKey, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(fields.signature!, "base64"))).toBe(true);
}
afterEach(async () => {
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
  await Promise.all([...servers].map(async (server) => {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }));
  servers.clear();
  vi.restoreAllMocks();
});

describe("WeChat API v3 bounded HTTPS request contract", () => {
  it("accepts the default and 1..10000ms timeouts and rejects invalid deadline configuration", () => {
    expect(() => new WechatPayV3Transport(security())).not.toThrow();
    for (const timeoutMs of [1, 10000]) expect(() => new WechatPayV3Transport(security(), { timeoutMs })).not.toThrow();
    for (const timeoutMs of [0, -1, 1.5, NaN, Infinity, 10001, 60000]) {
      let error: unknown;
      try { new WechatPayV3Transport(security(), { timeoutMs }); } catch (next) { error = next; }
      expect(error).toBeInstanceOf(WechatPayV3TransportError);
      expect(error).toMatchObject({ code: "INVALID_WECHAT_TRANSPORT_CONFIGURATION" });
    }
  });

  it("rejects invalid paths and GET bodies before invoking a network factory", async () => {
    const factory = vi.fn<WechatPayV3HttpRequestFactory>(() => { throw new Error("Network must not be reached"); });
    const transport = new WechatPayV3Transport(security(), { request: factory });
    for (const request of [input({ path: "https://evil.example/v3/pay" }), input({ path: "/v3/a/../pay" }), input({ rawBody: "{}" })])
      await expect(Promise.resolve().then(() => transport.request(request))).rejects.toMatchObject({ code: "INVALID_WECHAT_REQUEST" });
    expect(factory).not.toHaveBeenCalled();
  });

  it("sends exact POST bytes and query with a valid merchant signature and explicit transport safeguards", async () => {
    let captured: { url: string | undefined; method: string | undefined; headers: IncomingMessage["headers"]; body: Buffer } | undefined;
    const h = await loopback(async (req, res) => {
      captured = { url: req.url, method: req.method, headers: req.headers, body: await bodyOf(req) };
      signed(res, '{ "result":"accepted", "synthetic":true }\n');
    });
    const path = "/v3/pay/transactions/native?note=%E7%BD%91%E7%90%83&x=a%2Bb&x=second";
    const rawBody = '{\n "description":"网球场", "amount":{"total":12000,"currency":"CNY"}\n}';
    expect(await h.transport().request(input({ method: "POST", path, rawBody }))).toEqual({
      kind: "VERIFIED_RESPONSE", httpStatus: 200, body: { result: "accepted", synthetic: true },
    });
    expect(captured?.url).toBe(path);
    expect(captured?.body.equals(Buffer.from(rawBody))).toBe(true);
    expect(captured?.headers["content-length"]).toBe(String(Buffer.byteLength(rawBody)));
    expect(captured?.headers["accept-encoding"]).toBe("identity");
    assertMerchantSignature(captured!);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.url).toBe(`https://api.mch.weixin.qq.com${path}`);
    expect(h.calls[0]!.options).toMatchObject({ rejectUnauthorized: true, minVersion: "TLSv1.2", agent: false, maxHeaderSize: 16384 });
  });

  it("sends GET with no body and signs the same empty-body request observed by the server", async () => {
    let captured: { url: string | undefined; method: string | undefined; headers: IncomingMessage["headers"]; body: Buffer } | undefined;
    const h = await loopback(async (req, res) => {
      captured = { url: req.url, method: req.method, headers: req.headers, body: await bodyOf(req) };
      signed(res, "{}");
    });
    expect((await h.transport().request(input())).kind).toBe("VERIFIED_RESPONSE");
    expect(captured?.body.length).toBe(0);
    expect(captured?.method).toBe("GET");
    assertMerchantSignature(captured!);
  });

  it("sets explicit byte Content-Length for every non-GET method including an empty body", async () => {
    const observed: { method: string | undefined; length: string | undefined; body: Buffer }[] = [];
    const h = await loopback(async (req, res) => {
      observed.push({ method: req.method, length: req.headers["content-length"], body: await bodyOf(req) });
      signed(res, "{}");
    });
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      const rawBody = method === "DELETE" ? "" : '"球场"';
      expect((await h.transport().request(input({ method, rawBody }))).kind).toBe("VERIFIED_RESPONSE");
      expect(observed.at(-1)?.length).toBe(String(Buffer.byteLength(rawBody)));
      expect(observed.at(-1)?.body.toString()).toBe(rawBody);
    }
  });
});

describe("WeChat API v3 complete authenticated responses", () => {
  it("reassembles split multibyte UTF-8 before signature verification and JSON parsing", async () => {
    const body = Buffer.from('{"text":"网球场"}');
    const h = await loopback((_req, res) => {
      res.writeHead(200, signedHeaders(body));
      const split = Buffer.from('{"text":"').length + 1;
      res.write(body.subarray(0, split));
      delayed(() => res.end(body.subarray(split)), 15);
    });
    expect(await h.transport().request(input())).toEqual({ kind: "VERIFIED_RESPONSE", httpStatus: 200, body: { text: "网球场" } });
  });

  it("returns signed 4xx and 5xx as verified provider responses without inventing payment outcomes", async () => {
    const h = await loopback((req, res) => {
      const status = Number(new URL(req.url!, "http://localhost").searchParams.get("status"));
      signed(res, JSON.stringify({ code: status === 404 ? "RESOURCE_NOT_EXISTS" : "SYSTEM_ERROR", message: confidential }), status);
    });
    for (const httpStatus of [400, 404, 409, 500, 503]) {
      const result = await h.transport().request(input({ path: `/v3/synthetic?status=${httpStatus}` }));
      expect(result).toEqual({ kind: "VERIFIED_RESPONSE", httpStatus,
        body: { code: httpStatus === 404 ? "RESOURCE_NOT_EXISTS" : "SYSTEM_ERROR", message: confidential } });
      expect(result).not.toHaveProperty("status");
    }
  });

  it("accepts an authenticated empty 204 as body null", async () => {
    const h = await loopback((_req, res) => signed(res, "", 204));
    expect(await h.transport().request(input())).toEqual({ kind: "VERIFIED_RESPONSE", httpStatus: 204, body: null });
  });

  it("rejects an authenticated empty 200 rather than treating it as success", async () => {
    const h = await loopback((_req, res) => signed(res, ""));
    unknown(await h.transport().request(input()), "INVALID_RESPONSE");
  });

  it("rejects malformed JSON only after its valid signature has been checked", async () => {
    const h = await loopback((_req, res) => signed(res, `not-json ${confidential}`));
    unknown(await h.transport().request(input()), "INVALID_RESPONSE");
  });

  it("classifies unsigned JSON, unsigned malformed text and unsigned 204 as invalid signatures", async () => {
    const h = await loopback((req, res) => {
      const empty = req.url?.includes("empty");
      res.writeHead(empty ? 204 : 200, { "Content-Type": "application/json" });
      res.end(empty ? "" : req.url?.includes("malformed") ? `not-json ${confidential}` : '{"ok":true}');
    });
    for (const path of ["/v3/json", "/v3/malformed", "/v3/empty"])
      unknown(await h.transport().request(input({ path })), "INVALID_SIGNATURE");
  });

  it("rejects a complete body that differs from the valid signed body without exposing provider text", async () => {
    const h = await loopback((_req, res) => {
      res.writeHead(200, signedHeaders('{"amount":12000}'));
      res.end(JSON.stringify({ amount: 12001, message: confidential }));
    });
    unknown(await h.transport().request(input()), "INVALID_SIGNATURE");
    expect(h.calls).toHaveLength(1);
  });

  it("rejects security headers duplicated with different case in rawHeaders", async () => {
    const body = "{}";
    const h = await loopback((req, res) => {
      const original = signedHeaders(body);
      const duplicated = new URL(req.url!, "http://localhost").searchParams.get("header")!;
      const value = original[duplicated as keyof typeof original];
      res.writeHead(200, [...Object.entries(original).flat(), duplicated.toLowerCase(), value]);
      res.end(body);
    });
    for (const header of Object.keys(signedHeaders(body)))
      unknown(await h.transport().request(input({ path: `/v3/duplicate?header=${encodeURIComponent(header)}` })), "INVALID_SIGNATURE");
  });

  it("rejects security header values that an intermediary merged with commas", async () => {
    const body = "{}";
    const h = await loopback((req, res) => {
      const headers = signedHeaders(body);
      const name = new URL(req.url!, "http://localhost").searchParams.get("header")! as keyof typeof headers;
      res.writeHead(200, { ...headers, [name]: `${headers[name]}, ${headers[name]}` });
      res.end(body);
    });
    for (const header of ["Wechatpay-Timestamp", "Wechatpay-Serial", "Wechatpay-Signature"])
      unknown(await h.transport().request(input({ path: `/v3/merged?header=${encodeURIComponent(header)}` })), "INVALID_SIGNATURE");
  });

  it("refuses every 3xx response without following its Location", async () => {
    let followed = 0;
    const h = await loopback((req, res) => {
      if (req.url?.startsWith("/v3/followed")) { followed++; signed(res, "{}"); return; }
      const status = Number(new URL(req.url!, "http://localhost").searchParams.get("status"));
      res.writeHead(status, { Location: "https://api.mch.weixin.qq.com/v3/followed" });
      res.end(confidential);
    });
    for (const status of [301, 302, 303, 304, 307, 308])
      unknown(await h.transport().request(input({ path: `/v3/redirect?status=${status}` })), "REDIRECT_REFUSED");
    expect(followed).toBe(0);
    expect(h.calls).toHaveLength(6);
  });

  it("does not strip a UTF-8 BOM before authenticating the original bytes", async () => {
    const body = '\uFEFF{"synthetic":true}';
    const h = await loopback((_req, res) => signed(res, body));
    unknown(await h.transport().request(input()), "INVALID_RESPONSE");
  });

  it("rejects fully delivered malformed and truncated UTF-8 without replacement decoding", async () => {
    const invalid = Buffer.concat([Buffer.from('{"text":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')]);
    const truncated = Buffer.concat([Buffer.from('{"text":"'), Buffer.from([0xe7, 0xbd])]);
    const h = await loopback((req, res) => signed(res, req.url?.includes("truncated") ? truncated : invalid));
    for (const path of ["/v3/invalid", "/v3/truncated"])
      unknown(await h.transport().request(input({ path })), "INVALID_RESPONSE");
  });
});

describe("WeChat API v3 bounded streaming and cancellation", () => {
  it("times out a connected request that never receives response headers", async () => {
    const h = await loopback(() => {});
    unknown(await h.transport(80).request(input()), "TIMEOUT");
    expect(h.calls).toHaveLength(1);
  });

  it("keeps its total deadline active after headers arrive while the body stalls", async () => {
    const h = await loopback((_req, res) => {
      res.writeHead(200, signedHeaders('{"ok":true}'));
      res.flushHeaders();
      res.write("{");
    });
    unknown(await h.transport(100).request(input()), "TIMEOUT");
    expect(h.calls).toHaveLength(1);
  });

  it("does not extend the total deadline for a slowly trickling body", async () => {
    const body = `${" ".repeat(16)}{}`;
    let chunks = 0;
    const h = await loopback((_req, res) => {
      res.writeHead(200, signedHeaders(body));
      res.flushHeaders();
      const tick = () => {
        if (res.destroyed) return;
        if (chunks === 16) { res.end("{}"); return; }
        chunks++; res.write(" "); delayed(tick, 20);
      };
      tick();
    });
    unknown(await h.transport(100).request(input()), "TIMEOUT");
    expect(chunks).toBeGreaterThan(1);
    expect(chunks).toBeLessThan(16);
  });

  it("returns an unknown network outcome when a chunked body disconnects mid-stream", async () => {
    const h = await loopback((_req, res) => {
      res.writeHead(200, signedHeaders('{"ok":true}'));
      res.write('{"ok":');
      delayed(() => res.destroy(), 15);
    });
    unknown(await h.transport().request(input()), "NETWORK_ERROR");
    expect(h.calls).toHaveLength(1);
  });

  it("rejects a connection that ends before its advertised Content-Length", async () => {
    const full = '{"ok":true}';
    const h = await loopback((_req, res) => {
      res.writeHead(200, { ...signedHeaders(full), "Content-Length": String(Buffer.byteLength(full) + 100) });
      res.write(full);
      delayed(() => res.destroy(), 15);
    });
    unknown(await h.transport().request(input()), "NETWORK_ERROR");
  });

  it("enforces the 1 MiB limit on streamed chunked bytes without a Content-Length", async () => {
    const body = Buffer.from(`"${"场".repeat(Math.floor(1024 * 1024 / 3) + 1)}"`);
    const h = await loopback((_req, res) => {
      res.writeHead(200, signedHeaders(body));
      for (let index = 0; index < body.length; index += 8192) res.write(body.subarray(index, index + 8192));
      res.end();
    });
    unknown(await h.transport().request(input()), "RESPONSE_TOO_LARGE");
    expect(h.calls).toHaveLength(1);
  });

  it("rejects an advertised oversized body without waiting for it to arrive", async () => {
    const h = await loopback((_req, res) => {
      res.writeHead(200, { ...signedHeaders(""), "Content-Length": String(1024 * 1024 + 1) });
      res.flushHeaders();
    });
    unknown(await h.transport(150).request(input()), "RESPONSE_TOO_LARGE");
  });

  it("handles a pre-aborted signal without invoking the request factory", async () => {
    const factory = vi.fn<WechatPayV3HttpRequestFactory>(() => { throw new Error("No network after pre-abort"); });
    const controller = new AbortController();
    controller.abort(new Error(confidential));
    const target = new WechatPayV3Transport(security(), { request: factory });
    unknown(await target.request(input(), controller.signal), "ABORTED");
    expect(factory).not.toHaveBeenCalled();
  });

  it("cancels after response headers and never reports the partial body as provider failure", async () => {
    const h = await loopback((_req, res) => {
      res.writeHead(200, signedHeaders('{"ok":true}'));
      res.flushHeaders(); res.write("{");
    });
    const controller = new AbortController();
    const result = h.transport().request(input(), controller.signal);
    await h.receivedHeaders;
    controller.abort(confidential);
    unknown(await result, "ABORTED");
    expect(h.calls).toHaveLength(1);
  });

  it("returns a connection failure as unknown without automatically retrying", async () => {
    const h = await loopback((_req, res) => signed(res, "{}"));
    await h.close();
    unknown(await h.transport().request(input()), "NETWORK_ERROR");
    expect(h.calls).toHaveLength(1);
  });

  it("sanitizes a synchronous request-factory failure and does not retry it", async () => {
    const factory = vi.fn<WechatPayV3HttpRequestFactory>(() => { throw new Error(`${confidential} ${apiV3Key} ${merchantPem}`); });
    unknown(await new WechatPayV3Transport(security(), { request: factory }).request(input()), "NETWORK_ERROR");
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("applies the header-size cap to a real HTTP response", async () => {
    const h = await loopback((_req, res) => signed(res, "{}", 200, { "X-Synthetic-Padding": "x".repeat(17 * 1024) }));
    unknown(await h.transport().request(input()), "NETWORK_ERROR");
    expect(h.calls).toHaveLength(1);
  });
});
