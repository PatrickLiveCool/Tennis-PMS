import {
  constants, createDecipheriv, createPrivateKey, createPublicKey, randomBytes,
  sign, verify, X509Certificate, type KeyObject,
} from "node:crypto";

const origin = "https://api.mch.weixin.qq.com";
const signatureType = "WECHATPAY2-SHA256-RSA2048";
const maximumBodyBytes = 1024 * 1024;
type ErrorCode = "INVALID_WECHAT_CONFIGURATION" | "INVALID_WECHAT_REQUEST" |
  "INVALID_WECHAT_SIGNATURE" | "INVALID_WECHAT_NOTIFICATION";
export class WechatPayV3SecurityError extends Error {
  constructor(readonly code: ErrorCode) {
    super(code);
    this.name = "WechatPayV3SecurityError";
  }
}
export type WechatPayVerificationKey =
  | { readonly id: string; readonly publicKeyPem: string; readonly certificatePem?: never }
  | { readonly id: string; readonly certificatePem: string; readonly publicKeyPem?: never };
export interface WechatPayV3SecurityConfig {
  readonly merchantId: string;
  readonly merchantCertificateSerial: string;
  readonly merchantPrivateKeyPem: string;
  readonly apiV3Key: string;
  /** Trusted, server-provisioned keys only. Never download a key selected by an incoming message. */
  readonly platformKeys: readonly WechatPayVerificationKey[];
  readonly now?: () => number;
}
type Headers = Readonly<Record<string, string | undefined>>;
export interface WechatPayV3Request {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Exact encoded path and query. Absolute URLs, fragments and normalization are rejected. */
  readonly path: string;
  readonly rawBody: string;
}
export interface PreparedWechatPayV3Request {
  readonly url: string;
  readonly method: WechatPayV3Request["method"];
  readonly rawBody: string;
  readonly headers: Readonly<Record<string, string>>;
}
export interface DecryptedWechatPayNotification {
  readonly eventId: string;
  readonly eventType: string;
  readonly createdAt: string;
  readonly originalType: string;
  /** Authenticated JSON, NOT a verified payment/refund event. The product adapter must validate all facts. */
  readonly resource: unknown;
}
type VerificationKey = { key: KeyObject; notBefore?: number; notAfter?: number };
function fail(code: ErrorCode): never { throw new WechatPayV3SecurityError(code); }
function token(value: unknown, maximum = 128): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && /^[A-Za-z0-9_:-]+$/u.test(value);
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function bodyValid(value: unknown): value is string {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") <= maximumBodyBytes;
}
function rsa(key: KeyObject): KeyObject {
  if (key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength ?? 0) !== 2048)
    fail("INVALID_WECHAT_CONFIGURATION");
  return key;
}
function base64(value: unknown, code: ErrorCode): Buffer {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumBodyBytes ||
    value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) fail(code);
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) fail(code);
  return bytes;
}
function requiredText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\x00-\x1f\x7f]/u.test(value);
}

/**
 * Product-independent API v3 cryptography. This class does not send HTTP, choose a payment product,
 * read secrets, certify financial events, or enable the WECHAT provider in the local application.
 * Use one instance per immutable merchant credential version; never accept configuration from a callback.
 */
export class WechatPayV3Security {
  readonly #merchantId: string;
  readonly #merchantCertificateSerial: string;
  readonly #privateKey: KeyObject;
  readonly #apiV3Key: Buffer;
  readonly #platformKeys = new Map<string, VerificationKey>();
  readonly #now: () => number;

  constructor(config: WechatPayV3SecurityConfig) {
    try {
      if (!config || !token(config.merchantId) || !token(config.merchantCertificateSerial) ||
        typeof config.apiV3Key !== "string" || Buffer.byteLength(config.apiV3Key, "utf8") !== 32 ||
        !Array.isArray(config.platformKeys) || config.platformKeys.length === 0 || config.platformKeys.length > 20 ||
        (config.now !== undefined && typeof config.now !== "function")) fail("INVALID_WECHAT_CONFIGURATION");
      this.#merchantId = config.merchantId;
      this.#merchantCertificateSerial = config.merchantCertificateSerial;
      this.#privateKey = rsa(createPrivateKey(config.merchantPrivateKeyPem));
      this.#apiV3Key = Buffer.from(config.apiV3Key, "utf8");
      this.#now = config.now ?? Date.now;
      for (const entry of config.platformKeys) {
        if (!entry || !token(entry.id) || this.#platformKeys.has(entry.id)) fail("INVALID_WECHAT_CONFIGURATION");
        if (entry.certificatePem !== undefined) {
          if (entry.publicKeyPem !== undefined) fail("INVALID_WECHAT_CONFIGURATION");
          const certificate = new X509Certificate(entry.certificatePem);
          if (certificate.serialNumber !== entry.id) fail("INVALID_WECHAT_CONFIGURATION");
          const notBefore = Date.parse(certificate.validFrom), notAfter = Date.parse(certificate.validTo);
          if (!Number.isFinite(notBefore) || !Number.isFinite(notAfter) || notBefore >= notAfter)
            fail("INVALID_WECHAT_CONFIGURATION");
          this.#platformKeys.set(entry.id, { key: rsa(certificate.publicKey), notBefore, notAfter });
        } else {
          // Reject private keys/certificates here: Node createPublicKey would otherwise silently accept them.
          if (typeof entry.publicKeyPem !== "string" ||
            !/^-----BEGIN (?:RSA )?PUBLIC KEY-----/u.test(entry.publicKeyPem.trim())) fail("INVALID_WECHAT_CONFIGURATION");
          this.#platformKeys.set(entry.id, { key: rsa(createPublicKey(entry.publicKeyPem)) });
        }
      }
    } catch {
      // Do not include PEM, API keys, provider bodies or crypto library errors in an outward error.
      fail("INVALID_WECHAT_CONFIGURATION");
    }
  }

  prepareRequest(input: WechatPayV3Request): PreparedWechatPayV3Request {
    try {
      if (!input || !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(input.method) ||
        typeof input.path !== "string" || input.path.length > 8192 || !input.path.startsWith("/v3/") ||
        /[\s\\#\x00-\x1f\x7f]/u.test(input.path) || !bodyValid(input.rawBody) ||
        (input.method === "GET" && input.rawBody !== "")) fail("INVALID_WECHAT_REQUEST");
      const url = new URL(input.path, origin);
      if (url.origin !== origin || url.pathname + url.search !== input.path || url.hash || url.username || url.password)
        fail("INVALID_WECHAT_REQUEST");
      const timestamp = this.#timestamp("INVALID_WECHAT_REQUEST");
      const nonce = randomBytes(16).toString("hex");
      const message = `${input.method}\n${input.path}\n${timestamp}\n${nonce}\n${input.rawBody}\n`;
      const signature = sign("RSA-SHA256", Buffer.from(message, "utf8"), {
        key: this.#privateKey, padding: constants.RSA_PKCS1_PADDING,
      }).toString("base64");
      const authorization = `${signatureType} mchid="${this.#merchantId}",nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${this.#merchantCertificateSerial}",signature="${signature}"`;
      return Object.freeze({
        url: url.href, method: input.method, rawBody: input.rawBody,
        headers: Object.freeze({ Authorization: authorization, Accept: "application/json", "Content-Type": "application/json" }),
      });
    } catch { fail("INVALID_WECHAT_REQUEST"); }
  }

  /** Verify the exact response bytes before parsing JSON or interpreting status; empty 204 bodies also require a signature. */
  verifyResponse(rawBody: string, headers: Headers): void {
    try {
      if (!bodyValid(rawBody) || !object(headers)) fail("INVALID_WECHAT_SIGNATURE");
      const selected = new Map<string, string>();
      for (const [name, value] of Object.entries(headers)) {
        const normalized = name.toLowerCase();
        if (!normalized.startsWith("wechatpay-")) continue;
        if (selected.has(normalized) || typeof value !== "string" || /[\r\n]/u.test(value)) fail("INVALID_WECHAT_SIGNATURE");
        selected.set(normalized, value);
      }
      const type = selected.get("wechatpay-signature-type");
      if (type !== undefined && type !== signatureType) fail("INVALID_WECHAT_SIGNATURE");
      const timestamp = selected.get("wechatpay-timestamp"), nonce = selected.get("wechatpay-nonce");
      const serial = selected.get("wechatpay-serial"), signature = selected.get("wechatpay-signature");
      if (!timestamp || !/^[1-9][0-9]{0,11}$/u.test(timestamp) || !requiredText(nonce, 128) ||
        !token(serial) || !signature) fail("INVALID_WECHAT_SIGNATURE");
      const seconds = Number(timestamp), now = this.#timestamp("INVALID_WECHAT_SIGNATURE");
      if (!Number.isSafeInteger(seconds) || Math.abs(now - seconds) >= 300) fail("INVALID_WECHAT_SIGNATURE");
      const candidate = this.#platformKeys.get(serial);
      if (!candidate || (candidate.notBefore !== undefined && (seconds * 1000 < candidate.notBefore || now * 1000 < candidate.notBefore)) ||
        (candidate.notAfter !== undefined && (seconds * 1000 >= candidate.notAfter || now * 1000 >= candidate.notAfter)))
        fail("INVALID_WECHAT_SIGNATURE");
      const signed = base64(signature, "INVALID_WECHAT_SIGNATURE");
      if (signed.length !== 256 || !verify("RSA-SHA256", Buffer.from(`${timestamp}\n${nonce}\n${rawBody}\n`, "utf8"), {
        key: candidate.key, padding: constants.RSA_PKCS1_PADDING,
      }, signed)) fail("INVALID_WECHAT_SIGNATURE");
    } catch { fail("INVALID_WECHAT_SIGNATURE"); }
  }

  decryptNotification(rawBody: string, headers: Headers): DecryptedWechatPayNotification {
    // Signature errors stay distinct. Never parse/decrypt untrusted callback content before this check.
    this.verifyResponse(rawBody, headers);
    try {
      const envelope: unknown = JSON.parse(rawBody);
      if (!object(envelope) || !requiredText(envelope.id, 200) || !requiredText(envelope.event_type, 128) ||
        !requiredText(envelope.create_time, 64) || !Number.isFinite(Date.parse(envelope.create_time)) ||
        envelope.resource_type !== "encrypt-resource" || !object(envelope.resource)) fail("INVALID_WECHAT_NOTIFICATION");
      const resource = envelope.resource;
      if (resource.algorithm !== "AEAD_AES_256_GCM" || !requiredText(resource.original_type, 128) ||
        typeof resource.nonce !== "string" || Buffer.byteLength(resource.nonce, "utf8") !== 12 ||
        (resource.associated_data !== undefined && typeof resource.associated_data !== "string")) fail("INVALID_WECHAT_NOTIFICATION");
      const encrypted = base64(resource.ciphertext, "INVALID_WECHAT_NOTIFICATION");
      if (encrypted.length <= 16) fail("INVALID_WECHAT_NOTIFICATION");
      const decipher = createDecipheriv("aes-256-gcm", this.#apiV3Key, Buffer.from(resource.nonce, "utf8"), { authTagLength: 16 });
      decipher.setAAD(Buffer.from(resource.associated_data ?? "", "utf8"));
      decipher.setAuthTag(encrypted.subarray(-16));
      const plaintext = Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]);
      const content: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
      if (!object(content)) fail("INVALID_WECHAT_NOTIFICATION");
      return Object.freeze({
        eventId: envelope.id, eventType: envelope.event_type, createdAt: envelope.create_time,
        originalType: resource.original_type, resource: content,
      });
    } catch { fail("INVALID_WECHAT_NOTIFICATION"); }
  }

  #timestamp(code: ErrorCode): number {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 1000) fail(code);
    return Math.floor(now / 1000);
  }
}
