import type { ClientRequest, IncomingMessage } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import {
  WechatPayV3Security, type WechatPayV3Request,
} from "./wechatpay-v3-security.ts";

const maximumBodyBytes = 1024 * 1024;
const maximumTimeoutMs = 10_000;
export type WechatPayV3UnknownCode = "NETWORK_ERROR" | "TIMEOUT" | "ABORTED" |
  "INVALID_RESPONSE" | "INVALID_SIGNATURE" | "REDIRECT_REFUSED" | "RESPONSE_TOO_LARGE";
export type WechatPayV3TransportResult =
  | { readonly kind: "VERIFIED_RESPONSE"; readonly httpStatus: number; readonly body: unknown }
  | { readonly kind: "UNKNOWN"; readonly code: WechatPayV3UnknownCode };
/** Dependency injection for trusted process code/tests; never take a transport or endpoint from HTTP callers. */
export type WechatPayV3HttpRequestFactory = (
  url: URL, options: RequestOptions, onResponse: (response: IncomingMessage) => void,
) => ClientRequest;
export interface WechatPayV3TransportOptions {
  /** At most two calls (query, then create) fit inside the existing 30-second channel lease. */
  readonly timeoutMs?: number;
  readonly request?: WechatPayV3HttpRequestFactory;
}
export class WechatPayV3TransportError extends Error {
  readonly code = "INVALID_WECHAT_TRANSPORT_CONFIGURATION";
  constructor() {
    super("INVALID_WECHAT_TRANSPORT_CONFIGURATION");
    this.name = "WechatPayV3TransportError";
  }
}
const unknown = (code: WechatPayV3UnknownCode): WechatPayV3TransportResult => Object.freeze({ kind: "UNKNOWN", code });

/**
 * One authenticated HTTP exchange. No retries, business-state mapping, credential loading, or live-provider registration.
 * VERIFIED_RESPONSE authenticates bytes only: the product adapter must still validate merchant, order, amounts and state.
 */
export class WechatPayV3Transport {
  readonly #security: WechatPayV3Security;
  readonly #timeoutMs: number;
  readonly #request: WechatPayV3HttpRequestFactory;

  constructor(security: WechatPayV3Security, options: WechatPayV3TransportOptions = {}) {
    if (!(security instanceof WechatPayV3Security) || !options ||
      !Number.isSafeInteger(options.timeoutMs ?? maximumTimeoutMs) ||
      (options.timeoutMs ?? maximumTimeoutMs) < 1 || (options.timeoutMs ?? maximumTimeoutMs) > maximumTimeoutMs ||
      (options.request !== undefined && typeof options.request !== "function")) throw new WechatPayV3TransportError();
    this.#security = security;
    this.#timeoutMs = options.timeoutMs ?? maximumTimeoutMs;
    this.#request = options.request ?? ((url, settings, callback) => httpsRequest(url, settings, callback));
  }

  async request(input: WechatPayV3Request, signal?: AbortSignal): Promise<WechatPayV3TransportResult> {
    // Invalid caller input is rejected before any network effect. Signed bytes are sent without reserialization.
    const prepared = this.#security.prepareRequest(input);
    if (signal?.aborted) return unknown("ABORTED");
    const payload = Buffer.from(prepared.rawBody, "utf8");
    return new Promise((resolve) => {
      const deadline = performance.now() + this.#timeoutMs;
      let settled = false;
      let outgoing: ClientRequest | undefined;
      let incoming: IncomingMessage | undefined;
      const finish = (result: WechatPayV3TransportResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        // Destroy only this exchange. Keep error handlers installed to absorb late socket errors safely.
        outgoing?.destroy();
        incoming?.destroy();
        resolve(performance.now() >= deadline ? unknown("TIMEOUT") : result);
      };
      const onAbort = () => finish(unknown("ABORTED"));
      const timer = setTimeout(() => finish(unknown("TIMEOUT")), this.#timeoutMs);
      try {
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) { onAbort(); return; }
        outgoing = this.#request(new URL(prepared.url), {
          method: prepared.method,
          headers: {
            ...prepared.headers,
            "Accept-Encoding": "identity",
            ...(prepared.method === "GET" ? {} : { "Content-Length": String(payload.length) }),
          },
          rejectUnauthorized: true,
          minVersion: "TLSv1.2",
          agent: false,
          maxHeaderSize: 16 * 1024,
          insecureHTTPParser: false,
        }, (response) => {
          incoming = response;
          response.on("error", () => finish(unknown("NETWORK_ERROR")));
          response.on("aborted", () => finish(unknown("NETWORK_ERROR")));
          response.on("close", () => {
            if (!response.complete) finish(unknown("NETWORK_ERROR"));
          });
          if (settled) { response.destroy(); return; }
          const httpStatus = response.statusCode;
          if (!Number.isInteger(httpStatus) || httpStatus === undefined || httpStatus < 200 || httpStatus >= 600) {
            finish(unknown("INVALID_RESPONSE")); return;
          }
          // Node https.request does not follow redirects; no second request is ever issued here.
          if (httpStatus >= 300 && httpStatus < 400) { finish(unknown("REDIRECT_REFUSED")); return; }
          const headers: Record<string, string> = Object.create(null) as Record<string, string>;
          for (let i = 0; i < response.rawHeaders.length; i += 2) {
            const name = response.rawHeaders[i]?.toLowerCase(), value = response.rawHeaders[i + 1];
            if (!name || value === undefined) { finish(unknown("INVALID_RESPONSE")); return; }
            if (!name.startsWith("wechatpay-")) continue;
            // Preserve duplicate detection before Node's normalized headers can join or discard them.
            if (Object.hasOwn(headers, name)) { finish(unknown("INVALID_SIGNATURE")); return; }
            headers[name] = value;
          }
          const encoding = response.headers["content-encoding"];
          if (encoding !== undefined && encoding !== "identity") { finish(unknown("INVALID_RESPONSE")); return; }
          const lengthHeader = response.headers["content-length"];
          if (lengthHeader !== undefined && (typeof lengthHeader !== "string" || !/^[0-9]+$/u.test(lengthHeader))) {
            finish(unknown("INVALID_RESPONSE")); return;
          }
          const expectedLength = lengthHeader === undefined ? undefined : Number(lengthHeader);
          if (expectedLength !== undefined && (!Number.isSafeInteger(expectedLength) || expectedLength > maximumBodyBytes)) {
            finish(unknown("RESPONSE_TOO_LARGE")); return;
          }
          let length = 0;
          const chunks: Buffer[] = [];
          response.on("data", (chunk: unknown) => {
            if (settled) return;
            if (!Buffer.isBuffer(chunk)) { finish(unknown("INVALID_RESPONSE")); return; }
            length += chunk.length;
            if (length > maximumBodyBytes) { finish(unknown("RESPONSE_TOO_LARGE")); return; }
            chunks.push(chunk);
          });
          response.once("end", () => {
            if (settled) return;
            if (!response.complete || (expectedLength !== undefined && expectedLength !== length)) {
              finish(unknown("NETWORK_ERROR")); return;
            }
            let rawBody: string;
            try {
              const bytes = Buffer.concat(chunks, length);
              // Preserve a UTF-8 BOM for authentication. Never silently replace malformed bytes.
              rawBody = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
              if (!Buffer.from(rawBody, "utf8").equals(bytes)) { finish(unknown("INVALID_RESPONSE")); return; }
            } catch { finish(unknown("INVALID_RESPONSE")); return; }
            try {
              this.#security.verifyResponse(rawBody, headers);
            } catch { finish(unknown("INVALID_SIGNATURE")); return; }
            try {
              const body: unknown = rawBody === "" && httpStatus === 204 ? null : JSON.parse(rawBody);
              finish(Object.freeze({ kind: "VERIFIED_RESPONSE", httpStatus, body }));
            } catch { finish(unknown("INVALID_RESPONSE")); }
          });
        });
        outgoing.on("error", () => finish(unknown("NETWORK_ERROR")));
        outgoing.on("close", () => {
          if (!incoming || !incoming.complete) finish(unknown("NETWORK_ERROR"));
        });
        if (settled) { outgoing.destroy(); return; }
        if (signal?.aborted) { onAbort(); return; }
        if (prepared.method === "GET") outgoing.end();
        else outgoing.end(payload);
      } catch { finish(unknown("NETWORK_ERROR")); }
    });
  }
}
