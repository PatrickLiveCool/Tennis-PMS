import type { FastifyInstance, FastifyRequest } from "fastify";
import { Type, type Static } from "@sinclair/typebox";
import type pg from "pg";
import { PassThrough } from "node:stream";
import type { BookingActor } from "../../../../packages/db/src/tennis/customers.ts";
import { backofficeAssistantStatus, createBackofficeConversation, getBackofficeAIConfig, getBackofficeConversation, listBackofficeConversations, saveBackofficeAIConfig, sendBackofficeMessage, setBackofficeMessageFeedback, testBackofficeAIConfig } from "../../../../packages/db/src/tennis/backoffice-assistant.ts";
import { BackofficeModelConnectionError, backofficeExecutor, testBackofficeModel } from "./backoffice-model.ts";
import type { ModelTransport } from "../assistant-model.ts";

export function registerBackofficeAssistantRoutes(app: FastifyInstance, input: {
  db: pg.Pool; key: Buffer; actor: (request: FastifyRequest) => BookingActor;
  subject: (request: FastifyRequest) => string; modelTransport?: ModelTransport;
}) {
  const base = "/api/tennis", assistant = `${base}/backoffice-assistant`, connectionAvailable = !!input.modelTransport;
  const id = Type.String({ minLength: 1, maxLength: 200 });
  const config = Type.Object({ enabled: Type.Boolean(), model: Type.String({ maxLength: 200 }), baseUrl: Type.String({ maxLength: 2000 }), apiKey: Type.Optional(Type.String({ maxLength: 4096 })), expectedRevision: Type.Integer({ minimum: 1 }) }, { additionalProperties: false });
  const test = Type.Object({ expectedRevision: Type.Integer({ minimum: 1 }) }, { additionalProperties: false });
  const venue = Type.Object({ venueId: id }, { additionalProperties: false });
  const params = Type.Object({ id }, { additionalProperties: false });
  const message = Type.Object({ messageId: id, content: Type.String({ minLength: 1, maxLength: 8000 }), context: Type.Optional(Type.Object({ page: Type.String({ maxLength: 100 }), orderId: Type.Optional(id), date: Type.Optional(Type.String({ maxLength: 10 })), viewDays: Type.Optional(Type.Integer()), selection: Type.Optional(Type.Array(Type.Object({ courtId: id, startAt: Type.String({ maxLength: 40 }), endAt: Type.String({ maxLength: 40 }) }, { additionalProperties: false }), { maxItems: 32 })) }, { additionalProperties: false })) }, { additionalProperties: false });
  const feedback = Type.Object({ resolved: Type.Boolean() }, { additionalProperties: false });
  app.get(`${base}/platform/ai-config`, async (request) => ({ ...await getBackofficeAIConfig(input.db, input.subject(request)), connectionAvailable }));
  app.put<{ Body: Static<typeof config> }>(`${base}/platform/ai-config`, { schema: { body: config } }, async (request) => ({ ...await saveBackofficeAIConfig(input.db, input.subject(request), input.key, request.body), connectionAvailable }));
  app.post<{ Body: Static<typeof test> }>(`${base}/platform/ai-config/test`, { schema: { body: test }, config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (request) => {
    await getBackofficeAIConfig(input.db, input.subject(request));
    if (!input.modelTransport) throw new BackofficeModelConnectionError();
    return testBackofficeAIConfig(input.db, input.subject(request), input.key, request.body.expectedRevision, (config) => testBackofficeModel(config, input.modelTransport));
  });
  app.get(`${assistant}/status`, async (request) => {
    const status = await backofficeAssistantStatus(input.db, input.actor(request));
    return { enabled: status.enabled, configReady: status.configured, configured: status.configured && connectionAvailable, connectionAvailable };
  });
  app.get<{ Querystring: Static<typeof venue> }>(`${assistant}/conversations`, { schema: { querystring: venue } }, (request) => listBackofficeConversations(input.db, input.actor(request), request.query.venueId));
  app.post<{ Body: Static<typeof venue> }>(`${assistant}/conversations`, { schema: { body: venue }, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, (request) => createBackofficeConversation(input.db, input.actor(request), request.body.venueId));
  app.get<{ Params: Static<typeof params> }>(`${assistant}/conversations/:id`, { schema: { params } }, (request) => getBackofficeConversation(input.db, input.actor(request), request.params.id));
  app.post<{ Params: Static<typeof params>; Body: Static<typeof message> }>(`${assistant}/conversations/:id/messages`, { schema: { params, body: message }, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request, reply) => {
    const actor = input.actor(request);
    await getBackofficeConversation(input.db, actor, request.params.id);
    const execute = backofficeExecutor(input.db, actor, input.modelTransport);
    if (!request.headers.accept?.includes("text/event-stream")) return sendBackofficeMessage(input.db, actor, input.key, request.params.id, request.body, execute);
    const stream = new PassThrough(), controller = new AbortController();
    const emit = (event: unknown) => { if (!stream.destroyed) stream.write(`data: ${JSON.stringify(event)}\n\n`); };
    reply.raw.once("close", () => controller.abort());
    reply.type("text/event-stream").header("Cache-Control", "no-cache, no-transform").header("X-Accel-Buffering", "no");
    void sendBackofficeMessage(input.db, actor, input.key, request.params.id, request.body, execute, { signal: controller.signal, onEvent: emit })
      .then((result) => { emit({ type: "result", result }); stream.end(); })
      .catch((error) => { emit({ type: "error", code: ["ASSISTANT_BUSY", "TENANT_ACCESS_DENIED", "BACKOFFICE_ASSISTANT_NOT_CONFIGURED"].includes(error?.code) ? error.code : "ASSISTANT_UNAVAILABLE" }); stream.end(); });
    return reply.send(stream);
  });
  app.post<{ Params: { id: string; messageId: string }; Body: Static<typeof feedback> }>(`${assistant}/conversations/:id/messages/:messageId/feedback`, { schema: { params: Type.Object({ id, messageId: id }, { additionalProperties: false }), body: feedback } }, (request) => setBackofficeMessageFeedback(input.db, input.actor(request), request.params.id, request.params.messageId, request.body.resolved));
}
