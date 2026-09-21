import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ request: vi.fn(), resolve: vi.fn() }));
vi.mock("node:https", () => ({ request: mocks.request }));
vi.mock("../../apps/api/src/assistant-model.ts", () => ({ resolvePublicEndpoint: mocks.resolve }));
import { modelStream, parseModelReply, tennisModelTransport } from "../../apps/api/src/tennis/model-transport.ts";
const input = { baseUrl: "https://models.example.test/v1", apiKey: "synthetic-secret", model: "test", messages: [{ role: "user" as const, content: "hello" }], tools: [] };
const reply = (message: object, finish_reason = "stop") => JSON.stringify({ choices: [{ message, finish_reason }] });
afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });
function respond(status: number, chunks: string[]) {
  mocks.resolve.mockResolvedValue({ url: new URL(`${input.baseUrl}/chat/completions`), address: { address: "8.8.8.8", family: 4 } });
  let body = "";
  const req = new EventEmitter() as EventEmitter & { end: (text: string) => void; destroy: (error: Error) => void };
  req.destroy = (error) => { req.emit("error", error); req.emit("close"); };
  mocks.request.mockImplementation((_url, _opts, cb) => {
    req.end = (text) => { body = text; queueMicrotask(() => {
      const res = new EventEmitter() as EventEmitter & { statusCode: number; resume: () => void };
      res.statusCode = status; res.resume = () => {};
      cb(res); chunks.forEach((chunk) => res.emit("data", Buffer.from(chunk)));
      res.emit("end"); req.emit("close");
    }); };
    return req;
  });
  return () => body;
}
describe("platform model transport", () => {
  it("reassembles split SSE text and tool arguments, and rejects an interrupted stream", () => {
    const text: string[] = [], stream = modelStream((chunk) => text.push(chunk));
    const events = [
      { choices: [{ delta: { content: "红土场" } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call1", type: "function", function: { name: "get_schedule", arguments: '{"date":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"2099-09-21"}' } }] }, finish_reason: "tool_calls" }] },
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
    for (let i = 0; i < events.length; i += 7) stream.push(events.slice(i, i + 7));
    expect(stream.finish()).toMatchObject({ content: "红土场", tool_calls: [{ function: { name: "get_schedule", arguments: '{"date":"2099-09-21"}' } }] });
    expect(text.join("")).toBe("红土场");
    const interrupted = modelStream(() => {});
    interrupted.push('data: {"choices":[{"delta":{"content":"不完整回答"}}]}\n\n');
    expect(() => interrupted.finish()).toThrow("MODEL_RESPONSE_INVALID");
  });
  it("sends only to the validated endpoint with pinned DNS, saved credentials and tool check", async () => {
    const body = respond(200, [reply({ content: "可以继续。" })]);
    const signal = new AbortController().signal;
    expect(await tennisModelTransport({ ...input, signal, toolChoice: "connection_check" } as typeof input)).toEqual({ content: "可以继续。" });
    const [url, options] = mocks.request.mock.calls[0]!;
    expect(url.href).toBe(`${input.baseUrl}/chat/completions`);
    expect(options.signal).toBe(signal);
    expect(options.headers.Authorization).toBe("Bearer synthetic-secret");
    const resolved = vi.fn(); options.lookup("ignored", {}, resolved);
    expect(resolved).toHaveBeenCalledWith(null, "8.8.8.8", 4);
    expect(JSON.parse(body()).tool_choice.function.name).toBe("connection_check");
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });
  it("does not follow redirects or expose provider bodies and never retries", async () => {
    respond(302, ["synthetic-secret provider detail"]);
    await expect(tennisModelTransport(input)).rejects.toThrow("MODEL_HTTP_ERROR");
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });
  it("rejects oversized responses", async () => {
    respond(200, ["x".repeat(1_000_001)]);
    await expect(tennisModelTransport(input)).rejects.toThrow("MODEL_CONNECTION_FAILED");
  });
  it("does not contact a model for an already cancelled request or a rejected endpoint", async () => {
    await expect(tennisModelTransport({ ...input, signal: AbortSignal.abort() } as typeof input)).rejects.toThrow();
    expect(mocks.resolve).not.toHaveBeenCalled();
    mocks.resolve.mockRejectedValue(new Error("private address"));
    await expect(tennisModelTransport(input)).rejects.toThrow("private address");
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("rejects incomplete or malformed model replies", () => {
    for (const raw of ["not json", reply({ content: "truncated" }, "length"), reply({ content: 4 }), reply({ content: "" }), reply({ content: null, tool_calls: [{ id: "x", type: "function", function: { name: "get_courts", arguments: 3 } }] })]) expect(() => parseModelReply(raw)).toThrow("MODEL_RESPONSE_INVALID");
  });
});
