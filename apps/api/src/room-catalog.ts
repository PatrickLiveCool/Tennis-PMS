import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import type { Database } from "@qintopia/db";
import { trialRoomRate } from "@qintopia/domain";
import { Type } from "@sinclair/typebox";
import { readRoomCatalog } from "../../../packages/db/src/room-catalog.ts";
import { requirePrincipal, requirePropertyAccess } from "./auth.ts";
import { ErrorResponse } from "./schemas.ts";
import { RoomCatalogViewSchema, RoomRateTrialSchema, RoomRateTrialResultSchema } from "./room-catalog-schemas.ts";

export function registerRoomCatalog(app: FastifyInstance, db: Kysely<Database>) {
  const params = Type.Object({ id: Type.String({ minLength: 1, maxLength: 160 }) }, { additionalProperties: false });
  const errors = { 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse, 422: ErrorResponse,
    429: ErrorResponse, 500: ErrorResponse, 503: ErrorResponse };
  app.get("/api/v1/properties/:id/room-catalog", { schema: { tags: ["queries"], params, response: { 200: RoomCatalogViewSchema, ...errors } } }, async (request) => {
    const { id } = request.params as { id: string };
    const principal = await requirePrincipal(db, request);
    requirePropertyAccess(principal, id, "READ");
    return readRoomCatalog(db, id);
  });
  app.post("/api/v1/properties/:id/room-rate-trial", { schema: { tags: ["queries"], params, body: RoomRateTrialSchema,
    response: { 200: RoomRateTrialResultSchema, ...errors } } }, async (request) => {
    const { id } = request.params as { id: string };
    const principal = await requirePrincipal(db, request);
    requirePropertyAccess(principal, id, "READ");
    const input = request.body as { anchors: unknown; arrivalDate: string; departureDate: string; multiplier?: number };
    return trialRoomRate(input.anchors, input.arrivalDate, input.departureDate, input.multiplier);
  });
}
