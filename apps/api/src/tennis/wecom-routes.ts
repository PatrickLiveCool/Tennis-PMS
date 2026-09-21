import type { FastifyInstance, FastifyRequest } from "fastify";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import type pg from "pg";
import type { TenantActor } from "../../../../packages/db/src/tennis/access.ts";
import { linkWecomReceipt, listWecomPaymentTargets, listWecomReceipts, simulateWecomReceipt } from "../../../../packages/db/src/tennis/wecom-reconciliation.ts";

/** These routes consume existing authenticated staff sessions. No live receipt-import HTTP route is provided. */
export function registerWecomRoutes(app: FastifyInstance, input: {
  db: pg.Pool; actor: (request: FastifyRequest) => TenantActor; allowSimulation: boolean;
}): void {
  const base = "/api/tennis/wecom";
  const id = Type.String({ minLength: 1, maxLength: 200 });
  const obj = <T extends Record<string, TSchema>>(properties: T) => Type.Object(properties, { additionalProperties: false });
  const query = (r: FastifyRequest) => r.query as Record<string, string | undefined>;
  app.get(base + "/receipts", { schema: { querystring: obj({
    state: Type.Optional(Type.Union([Type.Literal("UNMATCHED"), Type.Literal("REVIEW"), Type.Literal("LINKED"), Type.Literal("EXCEPTION")])),
    q: Type.Optional(Type.String({ maxLength: 200 })), cursor: Type.Optional(Type.String({ maxLength: 1000 })),
  }) } }, r => listWecomReceipts(input.db, input.actor(r), query(r)));
  app.get(base + "/payment-targets", { schema: { querystring: obj({ venueId: id, operationId: Type.Optional(id) }) } }, r =>
    listWecomPaymentTargets(input.db, input.actor(r), query(r).venueId!, query(r).operationId));
  const linkBody = obj({ operationId: id, reason: Type.String({ minLength: 1, maxLength: 2000 }) });
  app.post<{ Body: Static<typeof linkBody>; Params: { id: string } }>(base + "/receipts/:id/link", {
    schema: { body: linkBody, params: obj({ id }) },
  }, r => linkWecomReceipt(input.db, input.actor(r), { ...r.body, receiptId: r.params.id }));
  const demoBody = obj({ operationId: id, referenceMode: Type.Union([Type.Literal("EXACT"), Type.Literal("UNMATCHED")]), commandKey: id });
  app.post<{ Body: Static<typeof demoBody> }>(base + "/demo-receipts", { schema: { body: demoBody } }, r =>
    simulateWecomReceipt(input.db, input.actor(r), r.body, { allowSimulation: input.allowSimulation }));
}
