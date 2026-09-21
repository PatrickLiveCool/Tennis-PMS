import { request } from "node:https";
import { StringDecoder } from "node:string_decoder";
import { resolvePublicEndpoint, type ModelTransport, type ModelToolCall } from "../assistant-model.ts";

export function modelStream(onText: (text: string) => void) {
  let pending = "", content = "", finished = false, reason = "";
  const calls = new Map<number, ModelToolCall>();
  function push(chunk: string) {
    pending += chunk.replace(/\r\n/g, "\n");
    let newline: number;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newline).trim(); pending = pending.slice(newline + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") { finished = true; continue; }
      const choice = JSON.parse(data).choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) reason = choice.finish_reason;
      const delta = choice.delta ?? {};
      if (delta.content != null) {
        if (typeof delta.content !== "string" || content.length + delta.content.length > 12000) throw new Error("MODEL_RESPONSE_INVALID");
        content += delta.content; onText(delta.content);
      }
      for (const part of delta.tool_calls ?? []) {
        if (!Number.isInteger(part.index) || part.index < 0 || part.index > 5) throw new Error("MODEL_RESPONSE_INVALID");
        const call = calls.get(part.index) ?? { id: "", type: "function" as const, function: { name: "", arguments: "" } };
        if (part.id) call.id += part.id;
        if (part.type && part.type !== "function") throw new Error("MODEL_RESPONSE_INVALID");
        if (part.function?.name) call.function.name += part.function.name;
        if (part.function?.arguments) call.function.arguments += part.function.arguments;
        if (call.function.arguments.length > 6000) throw new Error("MODEL_RESPONSE_INVALID");
        calls.set(part.index, call);
      }
    }
  }
  return { push, finish() {
    if (pending.trim()) push("\n");
    if (!finished || !reason) throw new Error("MODEL_RESPONSE_INVALID");
    return parseModelReply(JSON.stringify({ choices: [{ finish_reason: reason, message: { content: content || null, ...(calls.size ? { tool_calls: [...calls.values()] } : {}) } }] }));
  } };
}

/** Platform-configured HTTPS endpoint only; no redirects, retries or provider bodies in errors. */
export function createTennisModelTransport(resolveEndpoint = resolvePublicEndpoint): ModelTransport {
return async (rawInput) => {
  const input = rawInput as typeof rawInput & { signal?: AbortSignal; onText?: (text: string) => void };
  const signal = input.signal;
  signal?.throwIfAborted();
  const endpoint = await resolveEndpoint(input.baseUrl);
  signal?.throwIfAborted();
  const body = JSON.stringify({ model: input.model, messages: input.messages, tools: input.tools,
    stream: !!input.onText, max_tokens: 4096,
    ...(input.toolChoice ? { tool_choice: { type: "function", function: { name: input.toolChoice } } } : {}),
  });
  const stream = input.onText ? modelStream(input.onText) : null;
  const raw = await new Promise<string>((resolve, reject) => {
    const req = request(endpoint.url, {
      method: "POST", signal, family: endpoint.address.family,
      lookup: (_hostname, _options, callback) => callback(null, endpoint.address.address, endpoint.address.family),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${input.apiKey}`, "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error("MODEL_HTTP_ERROR")); return; }
      let size = 0; const chunks: Buffer[] = []; const decoder = new StringDecoder("utf8");
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 1_000_000) req.destroy(new Error("MODEL_RESPONSE_TOO_LARGE"));
        else if (stream) { try { stream.push(decoder.write(chunk)); } catch { req.destroy(new Error("MODEL_RESPONSE_INVALID")); } }
        else chunks.push(chunk);
      });
      res.on("error", () => reject(new Error("MODEL_CONNECTION_FAILED")));
      res.on("end", () => { try { if (stream) stream.push(decoder.end()); resolve(Buffer.concat(chunks).toString("utf8")); } catch { reject(new Error("MODEL_RESPONSE_INVALID")); } });
    });
    const deadline = setTimeout(() => req.destroy(new Error("MODEL_TIMEOUT")), 60_000);
    req.once("close", () => clearTimeout(deadline));
    req.once("error", () => reject(new Error("MODEL_CONNECTION_FAILED")));
    req.end(body);
  });
  return stream ? stream.finish() : parseModelReply(raw);
};

}
export const tennisModelTransport = createTennisModelTransport();

export function parseModelReply(raw: string): { content: string | null; tool_calls?: ModelToolCall[] } {
  try {
    const choice = JSON.parse(raw).choices?.[0], message = choice?.message;
    if (!message || ["length", "content_filter"].includes(choice.finish_reason)) throw new Error();
    if (message.content != null && (typeof message.content !== "string" || message.content.length > 12000)) throw new Error();
    if (message.tool_calls !== undefined && (!Array.isArray(message.tool_calls) || message.tool_calls.length > 6)) throw new Error();
    const ids = new Set<string>();
    for (const call of message.tool_calls ?? []) {
      if (call?.type !== "function" || typeof call.id !== "string" || !call.id || call.id.length > 200 || ids.has(call.id)
        || typeof call.function?.name !== "string" || typeof call.function?.arguments !== "string" || call.function.arguments.length > 6000) throw new Error();
      ids.add(call.id);
    }
    if (!message.content?.trim() && !message.tool_calls?.length) throw new Error();
    return { content: message.content ?? null, ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}) };
  } catch { throw new Error("MODEL_RESPONSE_INVALID"); }
}
