import type { FastifyInstance, FastifyRequest } from "fastify";
import { Type, type TSchema, type Static } from "@sinclair/typebox";
import type pg from "pg";
import type { BookingActor } from "../../../../packages/db/src/tennis/customers.ts";
import {
  completeGatewayMessage,
  createGatewayBinding,
  createGatewayIntegration,
  gatewayBindingTargets,
  grantGatewayMessage,
  listGatewayBindings,
  listPlatformGateways,
  receiveGatewayMessage,
  requireGatewayConversation,
  resolveGatewayIdentity,
  revokeGatewayBinding,
  revokeGatewayIntegration,
  type GatewayPrincipal,
} from "../../../../packages/db/src/tennis/gateway.ts";
import { GatewayAccessError } from "../../../../packages/db/src/tennis/gateway-guard.ts";
import {
  getConversation,
  getConversationRequest,
  listConversationRequests,
  handoffConversation,
} from "../../../../packages/db/src/tennis/external-agent.ts";
import { pollBusinessEvents } from "../../../../packages/db/src/tennis/business-events.ts";
export function registerGatewayRoutes(
  app: FastifyInstance,
  input: {
    db: pg.Pool;
    key: Buffer;
    actor: (r: FastifyRequest) => BookingActor;
    subject: (r: FastifyRequest) => string;
  },
) {
  const { db, key } = input,
    base = "/api/tennis";
  const id = Type.String({ minLength: 1, maxLength: 200 }),
    reason = Type.String({ minLength: 1, maxLength: 2000 });
  const obj = <T extends Record<string, TSchema>>(p: T) => Type.Object(p, { additionalProperties: false });
  const params = (r: FastifyRequest) => r.params as Record<string, string>,
    query = (r: FastifyRequest) => r.query as Record<string, string>;
  function post<S extends TSchema>(
    path: string,
    schema: S,
    work: (r: FastifyRequest, b: Static<S>) => Promise<unknown>,
  ) {
    app.post<{ Body: Static<S> }>(base + path, { schema: { body: schema } }, (r) => work(r, r.body));
  }
  app.get(base + "/platform/gateways", (r) => listPlatformGateways(db, input.subject(r), query(r).tenantId ?? ""));
  post("/platform/gateways", obj({ tenantId: id, name: id }), (r, b) =>
    createGatewayIntegration(db, input.subject(r), b),
  );
  post("/platform/gateways/:id/revoke", obj({ reason }), (r, b) =>
    revokeGatewayIntegration(db, input.subject(r), params(r).id!, b.reason),
  );
  app.get(base + "/gateway-bindings", (r) => listGatewayBindings(db, input.actor(r)));
  app.get(base + "/gateway-binding-targets", (r) => gatewayBindingTargets(db, input.actor(r), query(r).q ?? ""));
  post(
    "/gateway-bindings",
    obj({
      integrationId: id,
      externalSubjectId: id,
      subjectId: id,
      actorKind: Type.Union([Type.Literal("staff"), Type.Literal("customer")]),
      reason,
    }),
    (r, b) => createGatewayBinding(db, input.actor(r), b),
  );
  post("/gateway-bindings/:id/revoke", obj({ reason }), (r, b) =>
    revokeGatewayBinding(db, input.actor(r), params(r).id!, b.reason),
  );
  const principals = new WeakMap<FastifyRequest, GatewayPrincipal>();
  const auth = async (r: FastifyRequest) => {
    const token = r.headers.authorization,
      subject = r.headers["x-gateway-subject"];
    if (typeof token !== "string" || !token.startsWith("Bearer ") || typeof subject !== "string")
      throw new GatewayAccessError("GATEWAY_ACCESS_REVOKED");
    principals.set(r, await resolveGatewayIdentity(db, token.slice(7), subject));
  };
  const p = (r: FastifyRequest) => principals.get(r)!;
  function gatewayPost<S extends TSchema>(
    path: string,
    schema: S,
    work: (r: FastifyRequest, b: Static<S>) => Promise<unknown>,
  ) {
    app.post<{ Body: Static<S> }>(base + "/gateway" + path, { onRequest: auth, schema: { body: schema } }, (r) =>
      work(r, r.body),
    );
  }
  gatewayPost(
    "/messages",
    obj({
      externalConversationId: id,
      externalMessageId: id,
      venueId: id,
      content: Type.String({ minLength: 1, maxLength: 8000 }),
    }),
    (r, b) => receiveGatewayMessage(db, p(r), b),
  );
  gatewayPost(
    "/conversations/:id/messages/:messageId/grant",
    obj({ expectedGeneration: Type.Integer({ minimum: 1 }) }),
    (r, b) => grantGatewayMessage(db, p(r), key, params(r).id!, params(r).messageId!, b.expectedGeneration),
  );
  gatewayPost(
    "/conversations/:id/messages/:messageId/complete",
    obj({
      status: Type.Union([Type.Literal("SUCCEEDED"), Type.Literal("UNCERTAIN")]),
      content: Type.Optional(Type.String({ minLength: 1, maxLength: 16000 })),
    }),
    (r, b) => completeGatewayMessage(db, p(r), params(r).id!, params(r).messageId!, b),
  );
  app.get(base + "/gateway/conversations/:id", { onRequest: auth }, async (r) => {
    await requireGatewayConversation(db, p(r), params(r).id!);
    return getConversation(db, p(r).actor, params(r).id!);
  });
  app.get(base + "/gateway/conversations/:id/requests", { onRequest: auth }, async (r) => {
    await requireGatewayConversation(db, p(r), params(r).id!);
    return listConversationRequests(db, p(r).actor, params(r).id!, query(r).cursor);
  });
  app.get(base + "/gateway/conversations/:id/requests/:requestId", { onRequest: auth }, async (r) => {
    await requireGatewayConversation(db, p(r), params(r).id!);
    return getConversationRequest(db, p(r).actor, params(r).id!, params(r).requestId!);
  });
  gatewayPost("/conversations/:id/handoff", obj({ reason }), async (r, b) => {
    await requireGatewayConversation(db, p(r), params(r).id!);
    return handoffConversation(db, p(r).actor, params(r).id!, { mode: "HUMAN", reason: b.reason });
  });
  app.get(base + "/gateway/events", { onRequest: auth }, (r) =>
    pollBusinessEvents(db, p(r).actor, query(r).venueId ?? "", {
      ...(query(r).cursor === undefined ? {} : { cursor: query(r).cursor }),
      ...(query(r).pageSize === undefined ? {} : { pageSize: Number(query(r).pageSize) }),
    }),
  );
}
