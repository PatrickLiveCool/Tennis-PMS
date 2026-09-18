import type { FastifyInstance, FastifyRequest } from "fastify";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import type pg from "pg";
import type { BookingActor } from "../../../../packages/db/src/tennis/customers.ts";
import {
  assistantStatus,
  createConversation,
  getAIConfig,
  getConversation,
  handoffConversation,
  listConversations,
  resolveDelegation,
  saveAIConfig,
  sendAssistantMessage,
  setAssistantMessageFeedback,
  type AgentTransport,
} from "../../../../packages/db/src/tennis/external-agent.ts";
import {
  cancelUnpaidOrder,
  confirmQuote,
  createQuote,
  getCommandReceipt,
  listOrders,
} from "../../../../packages/db/src/tennis/booking.ts";
import {
  accessibleCourts,
  bookingCustomers,
  orderDetail,
  venueSchedule,
} from "../../../../packages/db/src/tennis/views.ts";
import { getWallet } from "../../../../packages/db/src/tennis/wallet.ts";
import { beginOrderPayment, getOrderPayment } from "../../../../packages/db/src/tennis/payments.ts";
import {
  beginTopupPayment,
  createTopupQuote,
  getTopupPayment,
  listTopupOffers,
} from "../../../../packages/db/src/tennis/topups.ts";
import { LocalMockPaymentGateway } from "../../../../packages/db/src/tennis/mock-payments.ts";
import { AgentAccessError } from "../../../../packages/db/src/tennis/agent-guard.ts";

export function registerAssistantRoutes(
  app: FastifyInstance,
  input: {
    db: pg.Pool;
    key: Buffer;
    gateway: LocalMockPaymentGateway;
    actor: (request: FastifyRequest) => BookingActor;
    subject: (request: FastifyRequest) => string;
    transport?: AgentTransport;
  },
) {
  const { db, key, gateway } = input,
    base = "/api/tennis";
  const id = Type.String({ minLength: 1, maxLength: 200 }),
    reason = Type.String({ minLength: 1, maxLength: 2000 }),
    cents = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    commandKey = Type.String({ minLength: 8, maxLength: 128 });
  const obj = <T extends Record<string, TSchema>>(properties: T) =>
    Type.Object(properties, { additionalProperties: false });
  const param = (request: FastifyRequest) => (request.params as { id: string }).id;
  const query = (request: FastifyRequest) => request.query as Record<string, string>;
  function post<S extends TSchema>(
    path: string,
    schema: S,
    work: (request: FastifyRequest, value: Static<S>) => Promise<unknown>,
  ) {
    app.post<{ Body: Static<S> }>(base + path, { schema: { body: schema } }, (request) => work(request, request.body));
  }
  app.get(base + "/assistant/status", () => assistantStatus(db));
  app.get(base + "/platform/ai-config", (request) => getAIConfig(db, input.subject(request)));
  const config = obj({
    enabled: Type.Boolean(),
    model: Type.String({ maxLength: 200 }),
    baseUrl: Type.String({ maxLength: 2000 }),
    externalAgentUrl: Type.String({ maxLength: 2000 }),
    apiKey: Type.Optional(Type.String({ maxLength: 4096 })),
    expectedRevision: Type.Integer({ minimum: 1 }),
  });
  app.put<{ Body: Static<typeof config> }>(base + "/platform/ai-config", { schema: { body: config } }, (request) =>
    saveAIConfig(db, input.subject(request), key, request.body),
  );
  app.get(base + "/assistant/conversations", (request) =>
    listConversations(db, input.actor(request), query(request).venueId ?? ""),
  );
  post("/assistant/conversations", obj({ venueId: id }), (request, body) =>
    createConversation(db, input.actor(request), body.venueId),
  );
  app.get(base + "/assistant/conversations/:id", (request) =>
    getConversation(db, input.actor(request), param(request)),
  );
  post(
    "/assistant/conversations/:id/handoff",
    obj({ mode: Type.Union([Type.Literal("AGENT"), Type.Literal("HUMAN")]), reason }),
    (request, body) => handoffConversation(db, input.actor(request), param(request), body),
  );
  post(
    "/assistant/conversations/:id/messages",
    obj({
      messageId: id,
      content: Type.String({ minLength: 1, maxLength: 8000 }),
      context: Type.Optional(obj({ page: Type.String({ maxLength: 100 }), orderId: Type.Optional(id) })),
    }),
    (request, body) => sendAssistantMessage(db, input.actor(request), key, param(request), body, input.transport),
  );
  post(
    "/assistant/conversations/:id/messages/:messageId/feedback",
    obj({ resolved: Type.Boolean() }),
    (request, body) =>
      setAssistantMessageFeedback(
        db,
        input.actor(request),
        param(request),
        (request.params as { messageId: string }).messageId,
        body.resolved,
      ),
  );

  // This surface deliberately omits refunds, manual receipts, asset changes and simulation.
  // Tenant/subject identity comes only from an ephemeral PMS-issued bearer token.
  const principals = new WeakMap<FastifyRequest, Awaited<ReturnType<typeof resolveDelegation>>>();
  const auth = async (request: FastifyRequest) => {
    const header = request.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer "))
      throw new AgentAccessError("AGENT_DELEGATION_REVOKED");
    principals.set(request, await resolveDelegation(db, header.slice(7)));
  };
  const principal = (request: FastifyRequest) => principals.get(request)!;
  const agent = (request: FastifyRequest) => principal(request).actor;
  const venue = (request: FastifyRequest) => principal(request).conversation.venueId;
  function agentGet(path: string, work: (request: FastifyRequest) => Promise<unknown> | unknown) {
    app.get(base + "/agent" + path, { onRequest: auth }, work);
  }
  function agentPost<S extends TSchema>(
    path: string,
    schema: S,
    work: (request: FastifyRequest, value: Static<S>) => Promise<unknown>,
  ) {
    app.post<{ Body: Static<S> }>(base + "/agent" + path, { onRequest: auth, schema: { body: schema } }, (request) =>
      work(request, request.body),
    );
  }
  agentGet("/context", (request) => ({
    conversationId: principal(request).conversation.id,
    tenantId: agent(request).tenantId,
    venueId: venue(request),
    customerId: principal(request).conversation.customerId,
    actorKind: principal(request).conversation.actorKind,
    mode: principal(request).conversation.mode,
  }));
  agentGet("/booking-customers", (request) =>
    bookingCustomers(db, agent(request), venue(request), query(request).q ?? ""),
  );
  agentGet("/courts", (request) => accessibleCourts(db, agent(request), venue(request)));
  agentGet("/schedule", (request) => venueSchedule(db, agent(request), venue(request), query(request).date ?? ""));
  agentGet("/orders", (request) => listOrders(db, agent(request), venue(request)));
  agentGet("/orders/:id", (request) => orderDetail(db, agent(request), param(request)));
  agentGet("/customers/:id/wallet", (request) => getWallet(db, agent(request), param(request)));
  agentGet("/receipts/:id", (request) => getCommandReceipt(db, agent(request), param(request)));
  agentPost(
    "/quotes",
    obj({
      customerId: id,
      lines: Type.Array(obj({ courtId: id, startAt: Type.String(), endAt: Type.String() }), {
        minItems: 1,
        maxItems: 100,
      }),
    }),
    (request, body) => createQuote(db, agent(request), { ...body, venueId: venue(request) }),
  );
  agentPost("/quotes/:id/confirm", obj({ commandKey }), (request, body) =>
    confirmQuote(db, agent(request), { ...body, quoteId: param(request) }),
  );
  agentPost(
    "/orders/:id/payments",
    obj({ commandKey, walletCents: cents, staffReason: Type.Optional(reason) }),
    (request, body) => beginOrderPayment(db, agent(request), gateway, { ...body, orderId: param(request) }),
  );
  agentGet("/payments/:id", (request) => getOrderPayment(db, agent(request), param(request)));
  agentPost(
    "/orders/:id/cancel",
    obj({ commandKey, expectedRevision: Type.Integer({ minimum: 1 }), reason }),
    (request, body) => cancelUnpaidOrder(db, agent(request), { ...body, orderId: param(request) }),
  );
  agentGet("/topup-offers", (request) => listTopupOffers(db, agent(request)));
  agentPost(
    "/customers/:id/topup-quotes",
    obj({ principalCents: Type.Optional(cents), offerId: Type.Optional(id) }),
    (request, body) =>
      createTopupQuote(db, agent(request), { ...body, customerId: param(request), venueId: venue(request) }),
  );
  agentPost("/topup-quotes/:id/confirm", obj({ commandKey }), (request, body) =>
    beginTopupPayment(db, agent(request), gateway, { ...body, quoteId: param(request) }),
  );
  agentGet("/topups/:id", (request) => getTopupPayment(db, agent(request), param(request)));
}
