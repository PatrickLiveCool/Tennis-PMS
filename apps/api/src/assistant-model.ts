import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import { DomainError } from "@qintopia/contracts";

export const aiError = (message: string) => new DomainError("VALIDATION_ERROR", message, 400);
export function encryptionKey(): Buffer {
  const source = process.env.AI_SETTINGS_ENCRYPTION_KEY ?? "";
  const key = Buffer.from(source, "base64");
  if (key.length !== 32 || key.toString("base64") !== source) throw aiError("AI 密钥保护尚未配置，请管理员联系部署人员设置服务端加密密钥。");
  return key;
}
export function keyReady(): boolean { try { encryptionKey(); return true; } catch { return false; } }
export function encryptKey(value: string): string {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(Buffer.from("qintopia:ai:installation:v1"));
  return ["v1", iv.toString("base64"), Buffer.concat([cipher.update(value, "utf8"), cipher.final()]).toString("base64"), cipher.getAuthTag().toString("base64")].join(".");
}
export function decryptKey(value: string): string {
  try {
    const [version, iv, content, tag] = value.split(".");
    if (version !== "v1" || !iv || !content || !tag) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64"));
    decipher.setAAD(Buffer.from("qintopia:ai:installation:v1"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(content, "base64")), decipher.final()]).toString("utf8");
  } catch { throw aiError("AI 凭证无法解密，请核对服务端加密密钥或重新保存模型凭证。"); }
}
export function normalizeBaseUrl(input: string): string {
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw aiError("请填写有效的 HTTPS Base URL。"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || input.length > 2048)
    throw aiError("Base URL 必须是 HTTPS 地址，不能包含凭证、查询参数或片段。");
  if (url.pathname.endsWith("/chat/completions")) throw aiError("请填写 API 根地址（通常以 /v1 结尾），不要包含 /chat/completions。");
  return url.toString().replace(/\/+$/, "");
}
export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0, 168].includes(b))
      || (a === 198 && [18, 19, 51].includes(b)) || (a === 203 && b === 0));
  }
  if (isIP(address) === 6) {
    const lower = address.toLowerCase();
    // Native global unicast only; deny mapped/translation/tunnel and special-use prefixes.
    return /^[23][0-9a-f]{3}:/.test(lower) && !/^(2001:|2002:|3fff:)/.test(lower);
  }
  return false;
}
export async function resolvePublicEndpoint(baseUrl: string) {
  const url = new URL(normalizeBaseUrl(baseUrl) + "/chat/completions");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const addresses = await Promise.race([
      lookup(hostname, { all: true }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(aiError("模型服务域名解析超时。")), 5000); })
    ]);
    if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) throw aiError("模型服务必须使用公网地址，不能连接内网或本机服务。");
    return { url, address: addresses[0]! };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw aiError("无法解析模型服务地址，请检查 Base URL。");
  } finally { clearTimeout(timer); }
}
export type ModelMessage = { role: "system" | "user" | "assistant" | "tool"; content: string | null; tool_calls?: ModelToolCall[]; tool_call_id?: string };
export type ModelToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type ModelTool = { type: "function"; function: { name: string; description: string; parameters: object } };
export interface ModelInput { baseUrl: string; apiKey: string; model: string; messages: ModelMessage[]; tools: ModelTool[]; toolChoice?: string }
export type ModelTransport = (input: ModelInput) => Promise<{ content: string | null; tool_calls?: ModelToolCall[] }>;

export const callModel: ModelTransport = async (input) => {
  const endpoint = await resolvePublicEndpoint(input.baseUrl);
  const body = JSON.stringify({ model: input.model, messages: input.messages, tools: input.tools, stream: false,
    max_tokens: 2048, ...(input.toolChoice ? { tool_choice: { type: "function", function: { name: input.toolChoice } } } : {}) });
  let raw: string;
  try {
    raw = await new Promise<string>((resolve, reject) => {
      const req = request(endpoint.url, {
        method: "POST", family: endpoint.address.family,
        lookup: (_hostname, _options, callback) => callback(null, endpoint.address.address, endpoint.address.family),
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${input.apiKey}`, "Content-Length": Buffer.byteLength(body) }
      }, (response) => {
        if (response.statusCode !== 200) { response.resume(); reject(aiError(`模型服务返回 HTTP ${response.statusCode ?? "未知"}，请检查模型、凭证或稍后重试。`)); return; }
        let size = 0; const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 1_000_000) req.destroy(new Error("oversize")); else chunks.push(chunk); });
        response.on("error", reject);
        response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      });
      const deadline = setTimeout(() => req.destroy(new Error("timeout")), 25_000);
      req.once("close", () => clearTimeout(deadline)); req.once("error", reject); req.end(body);
    });
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw aiError("模型服务连接失败或超时，本次未自动重试。请稍后重试或联系管理员检查连接。");
  }
  try {
    const parsed = JSON.parse(raw);
    const choice = parsed.choices?.[0];
    const message = choice?.message;
    if (!message || choice.finish_reason === "length" || choice.finish_reason === "content_filter") throw new Error();
    if (message.content !== null && typeof message.content !== "string" && message.content !== undefined) throw new Error();
    if (typeof message.content === "string" && message.content.length > 12000) throw new Error();
    if (message.tool_calls !== undefined && (!Array.isArray(message.tool_calls) || message.tool_calls.length > 6)) throw new Error();
    for (const tool of message.tool_calls ?? []) {
      if (tool.type !== "function" || typeof tool.id !== "string" || tool.id.length > 200
        || typeof tool.function?.name !== "string" || typeof tool.function?.arguments !== "string" || tool.function.arguments.length > 6000) throw new Error();
    }
    if (!message.content?.trim() && !message.tool_calls?.length) throw new Error();
    return { content: message.content ?? null, ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}) };
  } catch { throw aiError("模型返回了不完整或不兼容的内容，请确认服务支持 Chat Completions 和工具调用。"); }
};
