import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { commandTypes, historicalRecoverableCommandTypes, type CommandType } from "@qintopia/contracts";
import { humanGrantableCommandTypes, newId, newOpaqueSecret, stableHash, systemDerivedCommandTypes } from "@qintopia/domain";
import { buildServer } from "../../apps/api/src/server.ts";
import { importQintopia2026ReferenceCatalog, type Database } from "@qintopia/db";
import { demo } from "../../packages/db/src/seed.ts";
import { resetTestDatabase } from "../helpers/database.ts";

let app: FastifyInstance;
let database: Kysely<Database>;
const catalogWithoutImportPropertyId = "prop_contract_catalog_without_import";

type JsonSchema = Record<string, unknown>;
type PublicCommandEnvelopeType = Exclude<CommandType, (typeof systemDerivedCommandTypes)[number]>;

const publicCommandEnvelopeTypes = commandTypes.filter((commandType): commandType is PublicCommandEnvelopeType =>
  (humanGrantableCommandTypes as readonly string[]).includes(commandType)
);

const commandInputContract: Record<Exclude<PublicCommandEnvelopeType, "MANAGE_ROOM_CATALOG">, { required: string[]; properties: string[] }> = {
  MANAGE_ORDER_OCCUPANTS: { required: ["propertyId", "orderId", "action"], properties: ["propertyId", "orderId", "action", "guest", "occupantId"] },
  CREATE_MEMBER: {
    required: ["propertyId", "fullName", "nickname", "phone", "wechat"],
    properties: ["propertyId", "fullName", "nickname", "identityCardNumber", "phone", "wechat"]
  },
  CREATE_MEMBERSHIP_ORDER: {
    required: ["propertyId", "memberId", "membershipProductId", "agreedPriceMinor"],
    properties: ["propertyId", "memberId", "membershipProductId", "agreedPriceMinor", "priceAdjustmentReason"]
  },
  RECORD_MEMBERSHIP_PAYMENT: {
    required: ["propertyId", "membershipOrderId", "amountMinor", "transactionReference"],
    properties: ["propertyId", "membershipOrderId", "amountMinor", "transactionReference", "note"]
  },
  CORRECT_MEMBERSHIP_PAYMENT: {
    required: ["propertyId", "membershipOrderId", "originalPaymentFactId", "correctedAmountMinor", "correctedTransactionReference"],
    properties: ["propertyId", "membershipOrderId", "originalPaymentFactId", "correctedAmountMinor", "correctedTransactionReference", "note"]
  },
  ACTIVATE_MEMBERSHIP_ORDER: {
    required: ["propertyId", "membershipOrderId"],
    properties: ["propertyId", "membershipOrderId"]
  },
  CORRECT_HISTORICAL_STAY_ARRANGEMENTS: {
    required: ["propertyId", "correctionSet"],
    properties: ["propertyId", "correctionSet", "evidenceNote"]
  },
  CORRECT_MEMBER_PROFILE: {
    required: ["propertyId", "memberId", "expectedPriorProfile", "correctedProfile", "evidenceNote"],
    properties: ["propertyId", "memberId", "expectedPriorProfile", "correctedProfile", "evidenceNote"]
  },
  CORRECT_MEMBERSHIP_EFFECTIVE_DATE: {
    required: ["propertyId", "membershipOrderId", "actualMembershipDate", "evidenceNote"],
    properties: ["propertyId", "membershipOrderId", "actualMembershipDate", "evidenceNote"]
  },
  BACKFILL_HISTORICAL_MEMBERSHIP: {
    required: ["propertyId", "memberId", "membershipProductId", "actualMembershipDate", "payment", "evidenceNote"],
    properties: ["propertyId", "memberId", "membershipProductId", "actualMembershipDate", "payment", "evidenceNote"]
  },
  VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY: {
    required: ["propertyId", "erroneousMembershipOrderId", "sourceStayOrderId", "actualMembershipDate", "evidenceNote"],
    properties: ["propertyId", "erroneousMembershipOrderId", "sourceStayOrderId", "actualMembershipDate", "replacementDirectPayment", "evidenceNote"]
  },
  CREATE_ORDER: {
    required: ["propertyId", "quoteId", "primaryGuest"],
    properties: [
      "propertyId", "quoteId", "primaryGuest", "additionalGuests", "bookingChannelCode", "channelOrderReference",
      "targetCurrentContractAmountMinor", "channelPriceDifferenceReason", "manualPriceAdjustmentReason",
      "freeStayReason", "freeStayCategoryCode", "backfill", "backfillReason", "backfillCollection",
      "temporaryOtherRoomReason"
    ]
  },
  CORRECT_ORDER_OCCUPANT: { required: ["propertyId", "orderId", "occupantId", "expectedPriorSnapshot", "correctedSnapshot"], properties: ["propertyId", "orderId", "occupantId", "expectedPriorSnapshot", "correctedSnapshot"] },
  RESCHEDULE_STAY: {
    required: ["propertyId", "orderId", "newArrivalDate", "newDepartureDate"],
    properties: ["propertyId", "orderId", "newArrivalDate", "newDepartureDate", "targetCurrentContractAmountMinor", "channelPriceDifferenceReason", "manualPriceAdjustmentReason"]
  },
  EXTEND_STAY: {
    required: ["propertyId", "orderId", "newDepartureDate"],
    properties: ["propertyId", "orderId", "newDepartureDate", "targetCurrentContractAmountMinor", "channelPriceDifferenceReason", "manualPriceAdjustmentReason"]
  },
  SHORTEN_STAY: {
    required: ["propertyId", "orderId", "newDepartureDate"],
    properties: ["propertyId", "orderId", "newDepartureDate", "targetCurrentContractAmountMinor", "channelPriceDifferenceReason", "manualPriceAdjustmentReason"]
  },
  MOVE_UNIT: {
    required: ["propertyId", "orderId", "newInventoryUnitId", "effectiveDate"],
    properties: [
      "propertyId", "orderId", "newInventoryUnitId", "effectiveDate", "targetCurrentContractAmountMinor",
      "channelPriceDifferenceReason", "manualPriceAdjustmentReason"
    ]
  },
  REPRICE_ORDER: { required: ["propertyId", "orderId", "targetCurrentContractAmountMinor"], properties: ["propertyId", "orderId", "targetCurrentContractAmountMinor"] },
  CANCEL_ORDER: { required: ["propertyId", "orderId"], properties: ["propertyId", "orderId"] },
  MARK_NO_SHOW: { required: ["propertyId", "orderId"], properties: ["propertyId", "orderId"] },
  REVOKE_CHECK_IN: { required: ["propertyId", "orderId", "unusedRoomConfirmed"], properties: ["propertyId", "orderId", "unusedRoomConfirmed"] },
  LOCK_MAINTENANCE: { required: ["propertyId", "inventoryUnitId", "arrivalDate", "departureDate", "reason"], properties: ["propertyId", "inventoryUnitId", "arrivalDate", "departureDate", "reason"] },
  RELEASE_MAINTENANCE: { required: ["propertyId", "maintenanceLockId"], properties: ["propertyId", "maintenanceLockId"] },
  COMPLETE_CLEANING: { required: ["propertyId", "cleaningTaskId"], properties: ["propertyId", "cleaningTaskId"] },
  RECORD_COLLECTION: { required: ["propertyId", "orderId", "amountMinor", "method"], properties: ["propertyId", "orderId", "amountMinor", "method", "transactionReference", "note"] },
  RECORD_REFUND: { required: ["propertyId", "orderId", "amountMinor", "referencesFactId", "method"], properties: ["propertyId", "orderId", "amountMinor", "referencesFactId", "method", "transactionReference", "refundReference", "note"] },
  CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP: {
    required: ["propertyId", "orderId", "memberId", "membershipProductId", "collectionFactIds", "agreedPriceMinor"],
    properties: [
      "propertyId", "orderId", "memberId", "membershipProductId", "collectionFactIds", "agreedPriceMinor",
      "priceAdjustmentReason", "remainingPaymentTransactionReference", "remainingPaymentNote"
    ]
  },
  REVERSE_FACT: { required: ["propertyId", "orderId", "reversesFactId", "note"], properties: ["propertyId", "orderId", "reversesFactId", "note"] },
  CHECK_IN: { required: ["propertyId", "orderId"], properties: ["propertyId", "orderId"] },
  CHECK_OUT: { required: ["propertyId", "orderId"], properties: ["propertyId", "orderId"] },
  REVOKE_CHECK_OUT: { required: ["propertyId", "orderId"], properties: ["propertyId", "orderId"] },
  COMPLETE_STAY: {
    required: ["propertyId", "orderId", "actualStayCompletedConfirmed", "reasonNote"],
    properties: ["propertyId", "orderId", "actualStayCompletedConfirmed", "reasonNote", "collection"]
  },
  CORRECT_MEMBER_ENTITLEMENT_BALANCE: {
    required: ["propertyId", "entitlementLotId", "targetAvailableBalance", "expectedAvailableBalance", "adjustmentReason"],
    properties: ["propertyId", "entitlementLotId", "targetAvailableBalance", "expectedAvailableBalance", "adjustmentReason"]
  },
  ISSUE_TOKEN: { required: ["propertyId", "subjectId", "label", "accessCeiling", "commandCeiling", "expiresAt", "tokenSecret"], properties: ["propertyId", "subjectId", "label", "accessCeiling", "commandCeiling", "expiresAt", "tokenSecret"] },
  ROTATE_TOKEN: { required: ["propertyId", "tokenId", "commandCeiling", "tokenSecret"], properties: ["propertyId", "tokenId", "commandCeiling", "expiresAt", "tokenSecret"] },
  REVOKE_TOKEN: { required: ["propertyId", "tokenId"], properties: ["propertyId", "tokenId"] }
};

function arbitraryRecordLocations(schema: unknown, path = "schema"): string[] {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [];
  const record = schema as JsonSchema;
  const result: string[] = [];
  const additional = record.additionalProperties;
  if (additional === true || (additional !== null && typeof additional === "object" && !Array.isArray(additional) && Object.keys(additional).length === 0)) {
    result.push(`${path}.additionalProperties`);
  }
  for (const [key, value] of Object.entries(record)) {
    if (key === "additionalProperties" && additional !== true) continue;
    if (Array.isArray(value)) value.forEach((entry, index) => result.push(...arbitraryRecordLocations(entry, `${path}.${key}[${index}]`)));
    else if (value && typeof value === "object") result.push(...arbitraryRecordLocations(value, `${path}.${key}`));
  }
  return result;
}

function nestedSchemaObjects(schema: unknown): JsonSchema[] {
  if (!schema || typeof schema !== "object") return [];
  if (Array.isArray(schema)) return schema.flatMap(nestedSchemaObjects);
  const record = schema as JsonSchema;
  return [record, ...Object.values(record).flatMap(nestedSchemaObjects)];
}

beforeAll(async () => {
  database = await resetTestDatabase();
  await database.insertInto("properties").values({
    id: catalogWithoutImportPropertyId,
    code: "QTP-NO-CATALOG",
    name: "Property without reference import",
    timezone: "Asia/Shanghai",
    currency: "CNY"
  }).execute();
  await database.insertInto("subject_property_grants").values({
    subject_id: demo.operatorSubjectId,
    property_id: catalogWithoutImportPropertyId,
    access_level: "READ"
  }).execute();
  await importQintopia2026ReferenceCatalog(database);
  app = await buildServer(database);
  await app.ready();
});

afterAll(async () => {
  if (app) await app.close();
});

describe("OpenAPI 3.1 command contract", () => {
  let commandSequence = 0;
  async function command(token: string, commandType: string, input: Record<string, unknown>) {
    commandSequence += 1;
    const previewResponse = await app.inject({
      method: "POST", url: "/api/v1/command-previews",
      headers: {
        authorization: `Bearer ${token}`, "content-type": "application/json",
        "idempotency-key": `contract-preview-${commandSequence}`, "x-correlation-id": `contract-${commandSequence}`
      },
      payload: { commandType, input }
    });
    expect(previewResponse.statusCode).toBe(200);
    const preview = previewResponse.json().preview;
    const confirmResponse = await app.inject({
      method: "POST", url: `/api/v1/command-previews/${preview.previewId}/confirm`,
      headers: {
        authorization: `Bearer ${token}`, "content-type": "application/json",
        "idempotency-key": `contract-confirm-${commandSequence}`, "x-correlation-id": `contract-${commandSequence}`
      },
      payload: {
        propertyId: input.propertyId,
        commandType,
        confirmation: true,
        expectedEffectHash: preview.effectHash,
        reason: commandType === "CREATE_ORDER"
          ? { code: "CREATE_STANDARD_ORDER", note: "" }
          : { code: "CONTRACT_TEST", note: "Token lifecycle contract" }
      }
    });
    expect(confirmResponse.statusCode).toBe(200);
    return confirmResponse.json();
  }

  it("serves the production Web entry and SPA routes without swallowing API 404s", async () => {
    for (const url of ["/", "/orders/permanent-order-reference"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/html");
      expect(response.body).toContain('<div id="root"></div>');
    }
    const missingApi = await app.inject({ method: "GET", url: "/api/v1/does-not-exist" });
    expect(missingApi.statusCode).toBe(404);
    expect(missingApi.json()).toMatchObject({ code: "NOT_FOUND", retryable: false });
  });

  it("publishes versioned query, preview/confirm, receipt, fact, and recovery endpoints", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/openapi.json" });
    expect(response.statusCode).toBe(200);
    const document = response.json();
    expect(document.openapi).toBe("3.1.0");
    for (const path of [
      "/api/v1/properties/{id}/availability",
      "/api/v1/quotes",
      "/api/v1/command-previews",
      "/api/v1/command-previews/{previewId}/confirm",
      "/api/v1/commands/{id}",
      "/api/v1/command-results",
      "/api/v1/command-results/resolve",
      "/api/v1/receipts/{id}",
      "/api/v1/facts/{id}",
      "/api/v1/members",
      "/api/v1/members/{id}",
      "/api/v1/maintenance-locks"
    ]) expect(document.paths[path]).toBeDefined();
    const headerParameters = document.paths["/api/v1/command-previews"].post.parameters;
    expect(headerParameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "idempotency-key", in: "header", required: true }),
      expect.objectContaining({ name: "x-correlation-id", in: "header", required: true })
    ]));
    const quoteHeaderParameters = document.paths["/api/v1/quotes"].post.parameters;
    expect(quoteHeaderParameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "idempotency-key", in: "header", required: true }),
      expect.objectContaining({ name: "x-correlation-id", in: "header", required: true })
    ]));
    const quoteResponse = document.paths["/api/v1/quotes"].post.responses["200"].content["application/json"].schema;
    expect(quoteResponse).toMatchObject({ additionalProperties: false, required: ["quote", "receipt"] });
    expect(quoteResponse.properties.quote.properties.pricingExplanation).toBeDefined();
    expect(JSON.stringify(quoteResponse.properties.quote)).not.toContain("numeratorMinor");
    expect(JSON.stringify(quoteResponse.properties.quote)).not.toContain("anchorAmountMinor");
    const quoteRequest = document.paths["/api/v1/quotes"].post.requestBody.content["application/json"].schema;
    expect(quoteRequest.required).toEqual([
      "propertyId", "inventoryUnitId", "arrivalDate", "departureDate", "pricingPolicyVersionId"
    ]);
    expect(quoteRequest.properties.stayType).toBeDefined();
    const recoveryCommandType = document.paths["/api/v1/command-results"].get.parameters
      .find((parameter: { name: string }) => parameter.name === "commandType").schema;
    expect(recoveryCommandType.anyOf.map((variant: { enum: string[] }) => variant.enum[0]).sort())
      .toEqual([...historicalRecoverableCommandTypes].sort());
    const resolveOperation = document.paths["/api/v1/command-results/resolve"].post;
    expect(resolveOperation.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "idempotency-key", in: "header", required: true }),
      expect.objectContaining({ name: "x-correlation-id", in: "header", required: true })
    ]));
    const resolveRequest = resolveOperation.requestBody.content["application/json"].schema;
    expect(resolveRequest).toMatchObject({
      additionalProperties: false,
      required: ["propertyId", "commandType", "idempotencyKey"]
    });
    expect(resolveRequest.properties.commandType.anyOf.map((variant: { enum: string[] }) => variant.enum[0]).sort())
      .toEqual([...historicalRecoverableCommandTypes].sort());
    const commandSchema = document.paths["/api/v1/command-previews"].post.requestBody.content["application/json"].schema;
    expect(commandSchema.anyOf).toHaveLength(publicCommandEnvelopeTypes.length);
    const variants = new Map<string, JsonSchema>(commandSchema.anyOf.map((variant: JsonSchema) => {
      const properties = variant.properties as Record<string, JsonSchema>;
      return [((properties.commandType!.enum as string[])[0])!, variant];
    }));
    expect([...variants.keys()].sort()).toEqual([...publicCommandEnvelopeTypes].sort());
    expect(variants.has("CREATE_QUOTE")).toBe(false);
    expect(commandTypes).not.toContain("PLACE_INTERNAL_USE");
    expect(commandTypes).not.toContain("RELEASE_INTERNAL_USE");
    expect(variants.has("PLACE_INTERNAL_USE")).toBe(false);
    expect(variants.has("RELEASE_INTERNAL_USE")).toBe(false);
    for (const commandType of systemDerivedCommandTypes) {
      expect(variants.has(commandType), commandType).toBe(false);
    }
    for (const commandType of publicCommandEnvelopeTypes) {
      const variant = variants.get(commandType)!;
      const input = (variant.properties as Record<string, JsonSchema>).input!;
      expect(variant.additionalProperties, commandType).toBe(false);
      expect(variant.required, commandType).toEqual(["commandType", "input"]);
      if (commandType === "MANAGE_ROOM_CATALOG") {
        const shapes: Record<string, { required: string[]; optional?: string[] }> = {
          SAVE_TYPE: { required: ["name", "bathroom", "saleMode", "bedCount", "capacity"], optional: ["typeCode"] },
          DELETE_TYPE: { required: ["typeCode"] }, SET_TYPE_ACTIVE: { required: ["typeCode", "active"] },
          SAVE_ROOM: { required: ["typeCode", "code", "buildingCode", "bedCount", "capacity"], optional: ["roomId"] },
          SET_ROOM_ACTIVE: { required: ["roomId", "active"] }, PUBLISH_RATES: { required: ["typeCode", "effectiveFrom", "anchors"] }
        };
        expect(input.discriminator).toEqual({ propertyName: "action" });
        const actions = input.oneOf as JsonSchema[];
        expect(actions).toHaveLength(6);
        for (const shape of actions) {
          const properties = shape.properties as Record<string, JsonSchema>;
          const actionName = (properties.action!.const ?? (properties.action!.enum as string[])[0]) as string;
          const expected = shapes[actionName]!;
          expect(expected).toBeDefined();
          expect(shape.additionalProperties).toBe(false);
          const required = ["propertyId", "expectedVersion", "action", ...expected.required];
          expect([...(shape.required as string[])].sort()).toEqual(required.sort());
          expect(Object.keys(properties).sort()).toEqual([...required, ...(expected.optional ?? [])].sort());
        }
        continue;
      }
      expect(input.additionalProperties, commandType).toBe(false);
      expect((input.required as string[]).sort(), commandType).toEqual([...commandInputContract[commandType].required].sort());
      expect(Object.keys(input.properties as object).sort(), commandType).toEqual([...commandInputContract[commandType].properties].sort());
    }
    const confirmReceiptSchema = document.paths["/api/v1/command-previews/{previewId}/confirm"]
      .post.responses["200"].content["application/json"].schema;
    const completeStayResultSchema = nestedSchemaObjects(confirmReceiptSchema).find((candidate) => {
      const properties = candidate.properties as Record<string, JsonSchema> | undefined;
      return properties?.orderId !== undefined
        && properties?.stayId !== undefined
        && properties?.checkInAmendmentId !== undefined
        && properties?.checkOutAmendmentId !== undefined
        && properties?.effectHash !== undefined;
    });
    expect(completeStayResultSchema).toBeDefined();
    expect(completeStayResultSchema!.required).toContain("effectHash");
    expect((completeStayResultSchema!.properties as Record<string, JsonSchema>).effectHash).toMatchObject({
      type: "string",
      minLength: 64,
      maxLength: 64,
      pattern: "^[a-f0-9]{64}$"
    });
    const createInput = (variants.get("CREATE_ORDER")!.properties as Record<string, JsonSchema>).input!;
    const createGuest = ((createInput.properties as Record<string, JsonSchema>).primaryGuest)!;
    expect(createGuest).toMatchObject({ additionalProperties: false, required: ["fullName", "nickname"] });
    expect((createGuest.properties as Record<string, JsonSchema>).nickname).toMatchObject({
      type: "string",
      minLength: 1,
      maxLength: 200,
      pattern: "\\S"
    });
    const additionalGuest = (((createInput.properties as Record<string, JsonSchema>).additionalGuests!.items as JsonSchema));
    expect(additionalGuest).toMatchObject({ additionalProperties: false, required: ["fullName", "nickname"] });
    const createChannel = ((createInput.properties as Record<string, JsonSchema>).bookingChannelCode)!;
    const createChannelVariants = createChannel.anyOf as Array<{ enum: string[] }>;
    expect(createChannelVariants.map((variant) => variant.enum[0])).toEqual(["YOUMUDAO", "CTRIP", "MEITUAN", "WECOM"]);
    expect(JSON.stringify((createInput.properties as Record<string, JsonSchema>).channelOrderReference)).toContain('"type":"null"');
    expect((createInput.properties as Record<string, JsonSchema>).targetCurrentContractAmountMinor).toMatchObject({
      type: "integer",
      minimum: 0,
      maximum: 2_147_483_600,
      multipleOf: 100
    });
    expect((createInput.properties as Record<string, JsonSchema>).channelPriceDifferenceReason).toMatchObject({
      type: "string",
      minLength: 1,
      maxLength: 1000
    });
    expect((createInput.properties as Record<string, JsonSchema>).manualPriceAdjustmentReason).toMatchObject({
      type: "string",
      minLength: 1,
      maxLength: 1000
    });
    for (const commandType of ["RESCHEDULE_STAY", "EXTEND_STAY"] as const) {
      const stayChangeInput = (variants.get(commandType)!.properties as Record<string, JsonSchema>).input!;
      expect((stayChangeInput.properties as Record<string, JsonSchema>).targetCurrentContractAmountMinor).toMatchObject({
        type: "integer",
        minimum: 0,
        maximum: 2_147_483_600,
        multipleOf: 100
      });
      expect((stayChangeInput.properties as Record<string, JsonSchema>).channelPriceDifferenceReason).toMatchObject({
        type: "string", minLength: 1, maxLength: 1000
      });
      expect((stayChangeInput.properties as Record<string, JsonSchema>).manualPriceAdjustmentReason).toMatchObject({
        type: "string", minLength: 1, maxLength: 1000
      });
    }
    expect((createInput.properties as Record<string, JsonSchema>).freeStayReason).toMatchObject({ minLength: 1, maxLength: 1000 });
    const createFreeStayCategory = ((createInput.properties as Record<string, JsonSchema>).freeStayCategoryCode)!;
    const createFreeStayCategoryVariants = createFreeStayCategory.anyOf as Array<{ enum: string[] }>;
    expect(createFreeStayCategoryVariants.map((variant) => variant.enum[0])).toEqual(["VOLUNTEER", "RECEPTION"]);
    const previewSchema = document.paths["/api/v1/command-previews"].post.responses["200"].content["application/json"].schema;
    const previewResponseVariants = previewSchema.anyOf as JsonSchema[];
    expect(previewResponseVariants).toHaveLength(6);
    expect(previewResponseVariants.every((variant) => variant.additionalProperties === false)).toBe(true);
    const currentPreviewResponse = previewResponseVariants.find((variant) => {
      const responseProperties = variant.properties as Record<string, JsonSchema> | undefined;
      const previewProperties = responseProperties?.preview?.properties as Record<string, JsonSchema> | undefined;
      return Array.isArray(previewProperties?.effect?.anyOf);
    })!;
    const previewProperties = ((currentPreviewResponse.properties as Record<string, JsonSchema>).preview!.properties) as Record<string, JsonSchema>;
    const createEffect = (previewProperties.effect!.anyOf as JsonSchema[]).find((variant) => {
      const properties = variant.properties as Record<string, JsonSchema> | undefined;
      return properties?.quoteId !== undefined && properties?.primaryGuest !== undefined;
    })!;
    const effectGuest = (createEffect.properties as Record<string, JsonSchema>).primaryGuest!;
    expect(effectGuest.required).toEqual(["fullName"]);
    expect(JSON.stringify((effectGuest.properties as Record<string, JsonSchema>).nickname)).toContain('"type":"null"');
    expect((createEffect.properties as Record<string, JsonSchema>)).toHaveProperty("occupants");
    expect((createEffect.properties as Record<string, JsonSchema>)).toHaveProperty("occupancyCapacity");
    const createPricingDecision = (createEffect.properties as Record<string, JsonSchema>).pricingDecision!;
    expect(createPricingDecision).toMatchObject({
      additionalProperties: false,
      required: [
        "pricingBasis", "policyBaseAmount", "targetCurrentContractAmount", "differenceFromPolicy", "manualAdjustmentMinor",
        "differenceExceedsThreshold", "reason"
      ]
    });
    expect(Object.keys(createPricingDecision.properties as Record<string, JsonSchema>).sort()).toEqual([
      "differenceExceedsThreshold", "differenceFromPolicy", "manualAdjustmentMinor", "policyBaseAmount", "pricingBasis", "reason",
      "targetCurrentContractAmount"
    ]);
    const createMemberInput = (variants.get("CREATE_MEMBER")!.properties as Record<string, JsonSchema>).input!;
    expect((createMemberInput.properties as Record<string, JsonSchema>).nickname).toMatchObject({ minLength: 1, maxLength: 200 });
    expect(createMemberInput.properties).not.toHaveProperty("validFrom");
    expect(createMemberInput.properties).not.toHaveProperty("sourceApplicationRecordId");
    for (const commandType of ["ISSUE_TOKEN", "ROTATE_TOKEN"] as const) {
      const tokenInput = (variants.get(commandType)!.properties as Record<string, JsonSchema>).input!;
      expect((tokenInput.properties as Record<string, JsonSchema>).tokenSecret).toMatchObject({
        minLength: 47,
        maxLength: 47,
        pattern: "^qtp_[A-Za-z0-9_-]{43}$"
      });
      expect(tokenInput.properties).not.toHaveProperty("tokenSecretHash");
    }
    const topLevelErrorCode = document.paths["/api/v1/command-previews"].post.responses["400"].content["application/json"].schema.properties.code;
    expect(topLevelErrorCode.anyOf.map((variant: { enum: string[] }) => variant.enum[0])).not.toContain("PREVIEW_EXPIRED");
    const repriceInput = (variants.get("REPRICE_ORDER")!.properties as Record<string, JsonSchema>).input!;
    expect((repriceInput.properties as Record<string, JsonSchema>).targetCurrentContractAmountMinor).toMatchObject({
      type: "integer",
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
      multipleOf: 100
    });
  });

  it("keeps deferred command history readable without accepting it as a write command", async () => {
    const legacyPreview = {
      previewId: "preview_legacy_internal",
      commandType: "RELEASE_INTERNAL_USE",
      effectHash: "a".repeat(64),
      effect: {
        internalUseBlockId: "block_legacy_internal",
        inventoryUnitId: "unit_legacy_internal",
        arrivalDate: "2026-07-24",
        departureDate: "2026-07-25",
        reason: "Preserved historical record",
        fromStatus: "ACTIVE",
        toStatus: "RELEASED"
      },
      expiresAt: "2026-07-24T12:00:00.000Z"
    };
    const commandId = "command_legacy_internal";
    const receiptId = "receipt_legacy_internal";
    await database.transaction().execute(async (trx) => {
      await trx.insertInto("command_executions").values({
        id: commandId,
        subject_id: demo.agentSubjectId,
        credential_id: "token_demo_write",
        property_id: demo.propertyId,
        command_type: "PREVIEW:RELEASE_INTERNAL_USE",
        idempotency_key: "legacy-internal-read",
        request_hash: "b".repeat(64),
        correlation_id: "legacy-internal-read",
        state: "APPLIED",
        completed_at: new Date("2026-07-24T11:30:00.000Z")
      }).execute();
      await trx.insertInto("command_previews").values({
        id: legacyPreview.previewId,
        subject_id: demo.agentSubjectId,
        property_id: demo.propertyId,
        command_type: legacyPreview.commandType,
        normalized_input: { propertyId: demo.propertyId, internalUseBlockId: "block_legacy_internal" },
        input_hash: "b".repeat(64),
        effect: legacyPreview.effect,
        effect_hash: legacyPreview.effectHash,
        basis_versions: {},
        expires_at: new Date(legacyPreview.expiresAt),
        status: "USED",
        used_at: new Date("2026-07-24T11:30:00.000Z")
      }).execute();
      await trx.insertInto("command_receipts").values({
        id: receiptId,
        command_id: commandId,
        execution_status: "EXECUTED",
        business_committed: true,
        result: { preview: legacyPreview },
        error: null,
        resource_refs: JSON.stringify([legacyPreview.previewId]),
        fact_refs: JSON.stringify([]),
        committed_at: new Date("2026-07-24T11:30:00.000Z")
      }).execute();
    });
    await database.insertInto("subject_command_grants").values({
      subject_id: demo.agentSubjectId,
      property_id: demo.propertyId,
      command_type: "RELEASE_INTERNAL_USE"
    }).execute();
    await database.insertInto("token_command_ceilings").values({
      token_id: "token_demo_write",
      subject_id: demo.agentSubjectId,
      property_id: demo.propertyId,
      command_type: "RELEASE_INTERNAL_USE"
    }).execute();

    const previewResponse = await app.inject({
      method: "GET",
      url: `/api/v1/command-previews/${legacyPreview.previewId}`,
      headers: { authorization: `Bearer ${demo.writeToken}` }
    });
    expect(previewResponse.statusCode).toBe(200);
    expect(previewResponse.json()).toMatchObject({ command_type: "RELEASE_INTERNAL_USE", effect: legacyPreview.effect });
    const receiptResponse = await app.inject({
      method: "GET",
      url: `/api/v1/receipts/${receiptId}`,
      headers: { authorization: `Bearer ${demo.writeToken}` }
    });
    expect(receiptResponse.statusCode).toBe(200);
    expect(receiptResponse.json()).toMatchObject({ result: { preview: legacyPreview } });

    const rejectedWrite = await app.inject({
      method: "POST",
      url: "/api/v1/command-previews",
      headers: {
        authorization: `Bearer ${demo.writeToken}`,
        "content-type": "application/json",
        "idempotency-key": "legacy-internal-write-rejected",
        "x-correlation-id": "legacy-internal-write-rejected"
      },
      payload: {
        commandType: "RELEASE_INTERNAL_USE",
        input: { propertyId: demo.propertyId, internalUseBlockId: "block_legacy_internal" }
      }
    });
    expect(rejectedWrite.statusCode).toBe(400);
  });

  it("rejects missing or blank guest nicknames at the HTTP contract without creating an order", async () => {
    const orders = async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/orders?propertyId=${demo.propertyId}`,
        headers: { authorization: `Bearer ${demo.writeToken}` }
      });
      expect(response.statusCode, response.body).toBe(200);
      return response.json().orders as Array<{ id: string }>;
    };
    const quoteResponse = await app.inject({
      method: "POST",
      url: "/api/v1/quotes",
      headers: {
        authorization: `Bearer ${demo.writeToken}`,
        "content-type": "application/json",
        "idempotency-key": "contract-nickname-quote",
        "x-correlation-id": "contract-nickname-quote"
      },
      payload: {
        propertyId: demo.propertyId,
        inventoryUnitId: demo.roomId,
        stayType: "TRANSIENT",
        arrivalDate: "2030-04-20",
        departureDate: "2030-04-21",
        pricingPolicyVersionId: demo.transientPolicyId
      }
    });
    expect(quoteResponse.statusCode, quoteResponse.body).toBe(200);
    const quoteId = quoteResponse.json().quote.quoteId as string;
    const before = await orders();

    for (const [label, primaryGuest] of [
      ["missing", { fullName: "Missing nickname contract guest" }],
      ["blank", { fullName: "Blank nickname contract guest", nickname: "   " }]
    ] as const) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/command-previews",
        headers: {
          authorization: `Bearer ${demo.writeToken}`,
          "content-type": "application/json",
          "idempotency-key": `contract-nickname-${label}`,
          "x-correlation-id": `contract-nickname-${label}`
        },
        payload: {
          commandType: "CREATE_ORDER",
          input: {
            propertyId: demo.propertyId,
            quoteId,
            primaryGuest,
            bookingChannelCode: "WECOM",
            channelOrderReference: null
          }
        }
      });
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json()).toMatchObject({ code: "VALIDATION_ERROR", retryable: false });
    }

    const unrelatedUnauthenticatedInvalid = await app.inject({
      method: "POST",
      url: "/api/v1/command-previews",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "contract-nickname-invalid-unauthenticated",
        "x-correlation-id": "contract-nickname-invalid-unauthenticated"
      },
      payload: {
        commandType: "CREATE_ORDER",
        input: {
          propertyId: demo.propertyId,
          quoteId,
          primaryGuest: { fullName: "Invalid unauthenticated guest", nickname: null },
          bookingChannelCode: "WECOM",
          channelOrderReference: null
        }
      }
    });
    expect(unrelatedUnauthenticatedInvalid.statusCode, unrelatedUnauthenticatedInvalid.body).toBe(400);
    expect(unrelatedUnauthenticatedInvalid.json()).toMatchObject({ code: "VALIDATION_ERROR", retryable: false });

    expect(await orders()).toEqual(before);
  });

  it("replays an exact pre-nickname CREATE_ORDER Preview without weakening new command validation", async () => {
    const quoteResponse = await app.inject({
      method: "POST",
      url: "/api/v1/quotes",
      headers: {
        authorization: `Bearer ${demo.writeToken}`,
        "content-type": "application/json",
        "idempotency-key": "contract-historical-nickname-quote",
        "x-correlation-id": "contract-historical-nickname-quote"
      },
      payload: {
        propertyId: demo.propertyId,
        inventoryUnitId: demo.roomId,
        stayType: "TRANSIENT",
        arrivalDate: "2030-04-22",
        departureDate: "2030-04-23",
        pricingPolicyVersionId: demo.transientPolicyId
      }
    });
    expect(quoteResponse.statusCode, quoteResponse.body).toBe(200);
    const historicalQuote = quoteResponse.json().quote as {
      quoteId: string;
      currentContractAmount: { minorUnits: number };
    };
    const quoteId = historicalQuote.quoteId;
    const historicalKey = "contract-historical-nickname-preview";
    const preparedResponse = await app.inject({
      method: "POST",
      url: "/api/v1/command-previews",
      headers: {
        authorization: `Bearer ${demo.writeToken}`,
        "content-type": "application/json",
        "idempotency-key": "contract-historical-nickname-fixture-source",
        "x-correlation-id": "contract-historical-nickname-original"
      },
      payload: {
        commandType: "CREATE_ORDER",
        input: {
          propertyId: demo.propertyId,
          quoteId,
          primaryGuest: { fullName: "Historical Replay Guest", nickname: "Historical Replay" },
          bookingChannelCode: "WECOM",
          channelOrderReference: null,
          targetCurrentContractAmountMinor: historicalQuote.currentContractAmount.minorUnits
        }
      }
    });
    expect(preparedResponse.statusCode, preparedResponse.body).toBe(200);
    const prepared = preparedResponse.json();
    const storedPreview = await database.selectFrom("command_previews")
      .select(["basis_versions", "expires_at"])
      .where("id", "=", prepared.preview.previewId)
      .executeTakeFirstOrThrow();
    const storedExecution = await database.selectFrom("command_executions")
      .select(["subject_id", "credential_id"])
      .where("id", "=", prepared.receipt.commandId)
      .executeTakeFirstOrThrow();
    const historicalEnvelope = {
      commandType: "CREATE_ORDER" as const,
      input: {
        propertyId: demo.propertyId,
        quoteId,
        primaryGuest: { fullName: "Historical Replay Guest" },
        bookingChannelCode: "WECOM" as const,
        channelOrderReference: null
      }
    };
    const historicalEffect = {
      ...prepared.preview.effect,
      primaryGuest: { fullName: "Historical Replay Guest" }
    };
    const historicalEffectHash = stableHash({
      effect: historicalEffect,
      basisVersions: storedPreview.basis_versions
    });
    const historicalPreviewId = newId("preview");
    const historicalCommandId = newId("command");
    const historicalReceiptId = newId("receipt");
    const historicalPreview = {
      ...prepared.preview,
      previewId: historicalPreviewId,
      effectHash: historicalEffectHash,
      effect: historicalEffect
    };
    await database.transaction().execute(async (trx) => {
      const committedAt = new Date();
      await trx.insertInto("command_executions").values({
        id: historicalCommandId,
        subject_id: storedExecution.subject_id,
        credential_id: storedExecution.credential_id,
        property_id: demo.propertyId,
        command_type: "PREVIEW:CREATE_ORDER",
        idempotency_key: historicalKey,
        request_hash: stableHash(historicalEnvelope),
        correlation_id: "contract-historical-nickname-original",
        state: "APPLIED",
        completed_at: committedAt
      }).execute();
      await trx.insertInto("command_previews").values({
          id: historicalPreviewId,
          subject_id: storedExecution.subject_id,
          property_id: demo.propertyId,
          command_type: "CREATE_ORDER",
          normalized_input: historicalEnvelope.input,
          input_hash: stableHash(historicalEnvelope.input),
          effect: historicalEffect,
          effect_hash: historicalEffectHash,
          basis_versions: storedPreview.basis_versions,
          expires_at: storedPreview.expires_at,
          status: "OPEN",
          used_at: null
        }).execute();
      await trx.insertInto("command_receipts").values({
        id: historicalReceiptId,
        command_id: historicalCommandId,
        execution_status: "EXECUTED",
        business_committed: true,
        result: { preview: historicalPreview },
        error: null,
        resource_refs: JSON.stringify([historicalPreviewId]),
        fact_refs: JSON.stringify([]),
        committed_at: committedAt
      }).execute();
      await trx.insertInto("audit_entries").values({
        id: newId("audit"),
        subject_id: storedExecution.subject_id,
        credential_id: storedExecution.credential_id,
        action: "PREVIEW:CREATE_ORDER",
        decision: "ALLOWED",
        command_id: historicalCommandId,
        correlation_id: "contract-historical-nickname-original",
        reason: null,
        target_refs: JSON.stringify([historicalPreviewId]),
        metadata: { effectHash: historicalEffectHash }
      }).execute();
    });

    const replay = await app.inject({
      method: "POST",
      url: "/api/v1/command-previews",
      headers: {
        authorization: `Bearer ${demo.writeToken}`,
        "content-type": "application/json",
        "idempotency-key": historicalKey,
        "x-correlation-id": "contract-historical-nickname-replay"
      },
      payload: historicalEnvelope
    });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toMatchObject({
      preview: {
        previewId: historicalPreviewId,
        effectHash: historicalEffectHash,
        effect: { primaryGuest: { fullName: "Historical Replay Guest" } }
      },
      receipt: {
        receiptId: historicalReceiptId,
        commandId: historicalCommandId,
        correlationId: "contract-historical-nickname-original"
      }
    });
    expect(Object.hasOwn(replay.json().preview.effect.primaryGuest, "nickname")).toBe(false);

    const readOnlyReplay = await app.inject({
      method: "POST",
      url: "/api/v1/command-previews",
      headers: {
        authorization: `Bearer ${demo.readToken}`,
        "content-type": "application/json",
        "idempotency-key": historicalKey,
        "x-correlation-id": "contract-historical-nickname-read"
      },
      payload: historicalEnvelope
    });
    expect(readOnlyReplay.statusCode, readOnlyReplay.body).toBe(403);
    expect(readOnlyReplay.json()).toMatchObject({ code: "INSUFFICIENT_ACCESS" });

    for (const [idempotencyKey, payload] of [
      [historicalKey, {
        ...historicalEnvelope,
        input: { ...historicalEnvelope.input, primaryGuest: { fullName: "Different Historical Guest" } }
      }],
      ["contract-historical-nickname-new-key", historicalEnvelope],
      [historicalKey, {
        ...historicalEnvelope,
        input: { ...historicalEnvelope.input, primaryGuest: { fullName: "Historical Replay Guest", nickname: null } }
      }]
    ] as const) {
      const rejected = await app.inject({
        method: "POST",
        url: "/api/v1/command-previews",
        headers: {
          authorization: `Bearer ${demo.writeToken}`,
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
          "x-correlation-id": `reject-${idempotencyKey}`
        },
        payload
      });
      expect(rejected.statusCode, rejected.body).toBe(400);
      expect(rejected.json()).toMatchObject({ code: "VALIDATION_ERROR", retryable: false });
    }

    const executions = await database.selectFrom("command_executions")
      .select(["idempotency_key", "request_hash"])
      .where("command_type", "=", "PREVIEW:CREATE_ORDER")
      .where("idempotency_key", "in", [historicalKey, "contract-historical-nickname-new-key"])
      .execute();
    expect(executions).toEqual([{ idempotency_key: historicalKey, request_hash: stableHash(historicalEnvelope) }]);
  });

  it("replays exact pre-Stage 11 Preview and Confirm POST receipts but rejects legacy shapes written after the epoch", async () => {
    const stage11Epoch = await database.selectFrom("schema_migrations")
      .select("applied_at")
      .where("name", "=", "028_stage11_move_unit_guards.sql")
      .executeTakeFirstOrThrow();
    const historicalCreatedAt = new Date(new Date(stage11Epoch.applied_at).getTime() - 1_000);
    const money = (minorUnits: number) => ({ currency: "CNY", minorUnits });
    const pricing = {
      coverageSet: [],
      cashLines: [],
      cashRemainder: money(0),
      currentContractAmount: money(10_000)
    };
    const pricingDecision = {
      pricingBasis: "POLICY",
      policyBaseAmount: money(10_000),
      targetCurrentContractAmount: money(10_000),
      differenceFromPolicy: money(0),
      manualAdjustmentMinor: 0,
      differenceExceedsThreshold: false,
      reason: { code: "POLICY_DEFAULT", note: "" }
    };
    const before = {
      arrivalDate: "2026-07-29",
      departureDate: "2026-08-01",
      nights: 3,
      currentContractAmount: money(10_000)
    };
    const after = {
      arrivalDate: "2026-07-30",
      departureDate: "2026-08-02",
      nights: 3,
      stayTimeline: [
        { serviceDate: "2026-07-30", inventoryUnitId: "unit_legacy_target" },
        { serviceDate: "2026-07-31", inventoryUnitId: "unit_legacy_target" },
        { serviceDate: "2026-08-01", inventoryUnitId: "unit_legacy_target" }
      ],
      pricing
    };
    const shortenBefore = {
      arrivalDate: after.arrivalDate,
      departureDate: "2026-08-03",
      nights: 4,
      currentContractAmount: money(10_000)
    };
    const shortenInventoryChange = {
      preservedDates: ["2026-07-30", "2026-07-31", "2026-08-01"],
      releasedDates: ["2026-08-02"],
      addedDates: []
    };
    const unit = (id: string) => ({
      id,
      propertyId: demo.propertyId,
      kind: "ROOM",
      roomId: id,
      code: id,
      name: id,
      catalogVersion: null,
      buildingCode: null,
      roomTypeCode: null,
      pricingProductCode: null,
      inventoryBasis: null,
      codeProvenance: null,
      physicalBedCount: null
    });
    const fixtures = [
      {
        suffix: "stage9_post_replay",
        commandType: "RESCHEDULE_STAY",
        protocolVersion: "LEGACY_STAGE_9_10",
        envelope: {
          commandType: "RESCHEDULE_STAY",
          input: {
            propertyId: demo.propertyId,
            orderId: "order_legacy_stage9_post",
            newArrivalDate: "2026-07-30",
            newDepartureDate: "2026-08-02"
          }
        },
        effect: {
          operation: "RESCHEDULE_STAY",
          orderId: "order_legacy_stage9_post",
          stayId: "stay_legacy_stage9_post",
          inventoryUnitId: "unit_legacy_target",
          before,
          after,
          pricingDecision,
          inventoryChange: { preservedDates: [], releasedDates: [], addedDates: [] },
          entitlementChange: {
            preservedCoverageDates: [], releasedCoverageDates: [], addedCoverageDates: [], consumedCoverageDates: []
          },
          fundsSummary: { netRecordedCollection: money(0), collectionDifference: money(-10_000) }
        },
        confirmResult: {
          orderId: "order_legacy_stage9_post",
          stayId: "stay_legacy_stage9_post",
          amendmentId: "amendment_legacy_stage9_post",
          staySegmentId: "segment_legacy_stage9_post",
          pricingRevisionId: "revision_legacy_stage9_post",
          arrivalDate: after.arrivalDate,
          departureDate: after.departureDate,
          before,
          after,
          pricingDecision,
          inventoryChange: { preservedDates: [], releasedDates: [], addedDates: [] },
          entitlementChange: {
            preservedCoverageDates: [], releasedCoverageDates: [], addedCoverageDates: [], consumedCoverageDates: []
          },
          fundsSummary: { netRecordedCollection: money(0), collectionDifference: money(-10_000) }
        }
      },
      {
        suffix: "stage10_post_replay",
        commandType: "SHORTEN_STAY",
        protocolVersion: "LEGACY_STAGE_10",
        envelope: {
          commandType: "SHORTEN_STAY",
          input: {
            propertyId: demo.propertyId,
            orderId: "order_legacy_stage10_post",
            newDepartureDate: "2026-08-02"
          }
        },
        effect: {
          operation: "SHORTEN_STAY",
          orderId: "order_legacy_stage10_post",
          stayId: "stay_legacy_stage10_post",
          inventoryUnitId: "unit_legacy_target",
          businessDate: "2026-07-30",
          completionMode: "SHORTEN_IN_HOUSE",
          before: shortenBefore,
          after,
          pricingDecision,
          inventoryChange: shortenInventoryChange,
          entitlementSummary: {
            currentConsumedCoverageDates: [], retainedHistoricalConsumedCoverageDates: [], ledgerWriteCount: 0
          },
          fundsSummary: { netRecordedCollection: money(0), collectionDifference: money(-10_000), factCount: 0 },
          refundReferenceAmount: money(0)
        },
        confirmResult: {
          orderId: "order_legacy_stage10_post",
          stayId: "stay_legacy_stage10_post",
          arrangementAmendmentId: "amendment_legacy_stage10_post",
          checkoutAmendmentId: null,
          staySegmentId: "segment_legacy_stage10_post",
          pricingRevisionId: "revision_legacy_stage10_post",
          completionMode: "SHORTEN_IN_HOUSE",
          arrivalDate: after.arrivalDate,
          departureDate: after.departureDate,
          before: shortenBefore,
          after,
          pricingDecision,
          inventoryChange: shortenInventoryChange,
          entitlementSummary: {
            currentConsumedCoverageDates: [], retainedHistoricalConsumedCoverageDates: [], ledgerWriteCount: 0
          },
          fundsSummary: { netRecordedCollection: money(0), collectionDifference: money(-10_000), factCount: 0 },
          refundReferenceAmount: money(0),
          fulfillmentTiming: null
        }
      },
      {
        suffix: "pre_stage11_post_replay",
        commandType: "MOVE_UNIT",
        protocolVersion: "PRE_STAGE_11",
        envelope: {
          commandType: "MOVE_UNIT",
          input: {
            propertyId: demo.propertyId,
            orderId: "order_legacy_move_post",
            newInventoryUnitId: "unit_legacy_target",
            effectiveDate: "2026-07-30"
          }
        },
        effect: {
          orderId: "order_legacy_move_post",
          fromInventoryUnit: unit("unit_legacy_source"),
          toInventoryUnit: unit("unit_legacy_target"),
          effectiveDate: "2026-07-30",
          stayTimeline: after.stayTimeline,
          pricing
        },
        confirmResult: {
          orderId: "order_legacy_move_post",
          amendmentId: "amendment_legacy_move_post",
          staySegmentId: "segment_legacy_move_post",
          pricingRevisionId: "revision_legacy_move_post"
        }
      }
    ] as const;

    for (const fixture of fixtures) {
      const previewId = `preview_${fixture.suffix}`;
      const previewEffectHash = stableHash(fixture.effect);
      const preview = {
        previewId,
        commandType: fixture.commandType,
        effectHash: previewEffectHash,
        effect: fixture.effect,
        expiresAt: "2030-01-01T00:00:00.000Z"
      };
      const previewKey = `preview-${fixture.suffix}`;
      const confirmKey = `confirm-${fixture.suffix}`;
      const confirmation = {
        propertyId: demo.propertyId,
        commandType: fixture.commandType,
        confirmation: true,
        expectedEffectHash: previewEffectHash,
        reason: { code: "HISTORICAL_EXACT_REPLAY", note: "历史命令精确重放" }
      };
      const previewCommandId = `command_preview_${fixture.suffix}`;
      const confirmCommandId = `command_confirm_${fixture.suffix}`;
      const previewReceiptId = `receipt_preview_${fixture.suffix}`;
      const confirmReceiptId = `receipt_confirm_${fixture.suffix}`;
      await database.transaction().execute(async (trx) => {
        await trx.insertInto("command_executions").values([
          {
            id: previewCommandId,
            subject_id: demo.agentSubjectId,
            credential_id: "token_demo_write",
            property_id: demo.propertyId,
            command_type: `PREVIEW:${fixture.commandType}`,
            idempotency_key: previewKey,
            request_hash: stableHash(fixture.envelope),
            correlation_id: `original-${previewKey}`,
            state: "EXECUTING",
            created_at: historicalCreatedAt,
            completed_at: null
          },
          {
            id: confirmCommandId,
            subject_id: demo.agentSubjectId,
            credential_id: "token_demo_write",
            property_id: demo.propertyId,
            command_type: fixture.commandType,
            idempotency_key: confirmKey,
            request_hash: stableHash({ previewId, confirmation }),
            correlation_id: `original-${confirmKey}`,
            state: "EXECUTING",
            created_at: historicalCreatedAt,
            completed_at: null
          }
        ]).execute();
        await trx.insertInto("command_receipts").values([
          {
            id: previewReceiptId,
            command_id: previewCommandId,
            execution_status: "EXECUTED",
            business_committed: true,
            result: { preview },
            error: null,
            resource_refs: JSON.stringify([previewId]),
            fact_refs: JSON.stringify([]),
            committed_at: historicalCreatedAt,
            created_at: historicalCreatedAt
          },
          {
            id: confirmReceiptId,
            command_id: confirmCommandId,
            execution_status: "EXECUTED",
            business_committed: true,
            result: fixture.confirmResult,
            error: null,
            resource_refs: JSON.stringify([fixture.confirmResult.orderId]),
            fact_refs: JSON.stringify([]),
            committed_at: historicalCreatedAt,
            created_at: historicalCreatedAt
          }
        ]).execute();
      });

      const previewReplay = await app.inject({
        method: "POST",
        url: "/api/v1/command-previews",
        headers: {
          authorization: `Bearer ${demo.writeToken}`,
          "content-type": "application/json",
          "idempotency-key": previewKey,
          "x-correlation-id": `replay-${previewKey}`
        },
        payload: fixture.envelope
      });
      expect(previewReplay.statusCode, previewReplay.body).toBe(200);
      expect(previewReplay.json()).toEqual({
        preview,
        receipt: {
          receiptId: previewReceiptId,
          commandId: previewCommandId,
          executionStatus: "EXECUTED",
          businessCommitted: true,
          correlationId: `original-${previewKey}`,
          result: { preview },
          resourceRefs: [previewId],
          factRefs: [],
          committedAt: historicalCreatedAt.toISOString(),
          protocolVersion: fixture.protocolVersion,
          recoveryMode: "HISTORICAL_READ_ONLY"
        }
      });

      const confirmReplay = await app.inject({
        method: "POST",
        url: `/api/v1/command-previews/${previewId}/confirm`,
        headers: {
          authorization: `Bearer ${demo.writeToken}`,
          "content-type": "application/json",
          "idempotency-key": confirmKey,
          "x-correlation-id": `replay-${confirmKey}`
        },
        payload: confirmation
      });
      expect(confirmReplay.statusCode, confirmReplay.body).toBe(200);
      expect(confirmReplay.json()).toEqual({
        receiptId: confirmReceiptId,
        commandId: confirmCommandId,
        executionStatus: "EXECUTED",
        businessCommitted: true,
        correlationId: `original-${confirmKey}`,
        result: fixture.confirmResult,
        resourceRefs: [fixture.confirmResult.orderId],
        factRefs: [],
        committedAt: historicalCreatedAt.toISOString(),
        protocolVersion: fixture.protocolVersion,
        recoveryMode: "HISTORICAL_READ_ONLY"
      });
    }

    const postStage11Fixture = fixtures[1];
    const postStage11Key = "preview-stage10-post-epoch-rejected";
    const postStage11CommandId = "command_preview_stage10_post_epoch_rejected";
    const postStage11ReceiptId = "receipt_preview_stage10_post_epoch_rejected";
    const postStage11Preview = {
      previewId: "preview_stage10_post_epoch_rejected",
      commandType: postStage11Fixture.commandType,
      effectHash: stableHash(postStage11Fixture.effect),
      effect: postStage11Fixture.effect,
      expiresAt: "2030-01-01T00:00:00.000Z"
    };
    await database.transaction().execute(async (trx) => {
      await trx.insertInto("command_executions").values({
        id: postStage11CommandId,
        subject_id: demo.agentSubjectId,
        credential_id: "token_demo_write",
        property_id: demo.propertyId,
        command_type: `PREVIEW:${postStage11Fixture.commandType}`,
        idempotency_key: postStage11Key,
        request_hash: stableHash(postStage11Fixture.envelope),
        correlation_id: `original-${postStage11Key}`,
        state: "EXECUTING",
        created_at: stage11Epoch.applied_at,
        completed_at: null
      }).execute();
      await trx.insertInto("command_receipts").values({
        id: postStage11ReceiptId,
        command_id: postStage11CommandId,
        execution_status: "EXECUTED",
        business_committed: true,
        result: { preview: postStage11Preview },
        error: null,
        resource_refs: JSON.stringify([postStage11Preview.previewId]),
        fact_refs: JSON.stringify([]),
        committed_at: stage11Epoch.applied_at,
        created_at: stage11Epoch.applied_at
      }).execute();
    });

    const postStage11Replay = await app.inject({
      method: "POST",
      url: "/api/v1/command-previews",
      headers: {
        authorization: `Bearer ${demo.writeToken}`,
        "content-type": "application/json",
        "idempotency-key": postStage11Key,
        "x-correlation-id": `replay-${postStage11Key}`
      },
      payload: postStage11Fixture.envelope
    });
    expect(postStage11Replay.statusCode, postStage11Replay.body).toBe(500);
    expect(postStage11Replay.json()).toMatchObject({ code: "INTERNAL_ERROR", retryable: false });
  });

  it("publishes every documented error status for the query and recovery surfaces", async () => {
    const document = (await app.inject({ method: "GET", url: "/api/v1/openapi.json" })).json();
    const expected: Array<[string, string, string[]]> = [
      ["/api/v1/properties/{id}/availability", "get", ["400", "403", "404", "429"]],
      ["/api/v1/quotes", "post", ["400", "403", "404", "409", "422", "429"]],
      ["/api/v1/command-previews/{previewId}/confirm", "post", ["400", "403", "404", "409", "429"]],
      ["/api/v1/receipts/{id}", "get", ["400", "403", "404", "429"]],
      ["/api/v1/commands/{id}", "get", ["400", "403", "404", "429"]],
      ["/api/v1/command-results", "get", ["400", "403", "404", "429"]],
      ["/api/v1/command-results/resolve", "post", ["400", "403", "409", "429"]]
    ];
    for (const [path, method, statuses] of expected) {
      const responses = document.paths[path][method].responses;
      for (const status of statuses) {
        expect(responses[status], `${method.toUpperCase()} ${path} ${status}`).toBeDefined();
        expect(arbitraryRecordLocations(responses[status].content["application/json"].schema)).toEqual([]);
      }
    }

    const errorSchema = document.paths["/api/v1/quotes"].post.responses["400"].content["application/json"].schema;
    expect(errorSchema.additionalProperties).toBe(false);
    const detailVariants = errorSchema.properties.details.anyOf as Array<{ required?: string[] }>;
    expect(detailVariants).toHaveLength(18);
    expect(detailVariants.some((variant) => variant.required?.includes("serviceDate")
      && variant.required.includes("inventoryUnitId"))).toBe(true);
    expect(detailVariants.some((variant) => variant.required?.includes("businessDate")
      && variant.required.includes("arrivalDate"))).toBe(true);
    expect(detailVariants.some((variant) => variant.required?.includes("businessDate")
      && variant.required.includes("departureDate"))).toBe(true);
    const receiptSchema = document.paths["/api/v1/receipts/{id}"].get.responses["200"].content["application/json"].schema;
    expect(JSON.stringify(receiptSchema)).not.toContain("tokenSecret");
    expect(JSON.stringify(receiptSchema)).toContain("bookingChannelCode");
    expect(JSON.stringify(receiptSchema)).toContain("channelOrderReference");
    expect(JSON.stringify(receiptSchema)).toContain("transactionReference");
    expect(JSON.stringify(receiptSchema)).toContain("pricingDecision");
    expect(JSON.stringify(receiptSchema)).toContain("pricingPolicyVersionId");
    expect(JSON.stringify(receiptSchema)).toContain("checkInAmendmentId");
    expect(JSON.stringify(receiptSchema)).toContain("settlementStatus");

    for (const [path, pathItem] of Object.entries(document.paths) as Array<[string, Record<string, unknown>]>) {
      if (!path.startsWith("/api/v1/")) continue;
      for (const method of ["get", "post", "put", "patch", "delete"]) {
        const operation = pathItem[method] as { responses?: Record<string, unknown> } | undefined;
        if (operation) expect(operation.responses?.["500"], `${method.toUpperCase()} ${path} 500`).toBeDefined();
      }
    }
  });

  it("returns the declared 404 when an availability exclusion order is absent", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/properties/${demo.propertyId}/availability?arrivalDate=2028-08-01&departureDate=2028-08-02&excludeOrderId=order_missing_availability`,
      headers: { authorization: `Bearer ${demo.writeToken}` }
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: "NOT_FOUND", retryable: false });
  });

  it("publishes finite schemas for every core client response", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/openapi.json" });
    const document = response.json();
    const coreResponses: Array<[string, string]> = [
      ["/api/v1/meta", "get"],
      ["/api/v1/properties/{id}/reference-catalog", "get"],
      ["/api/v1/orders", "get"],
      ["/api/v1/orders/{id}", "get"],
      ["/api/v1/members", "get"],
      ["/api/v1/members/{id}", "get"],
      ["/api/v1/facts/{id}", "get"],
      ["/api/v1/maintenance-locks", "get"],
      ["/api/v1/command-results", "get"],
      ["/api/v1/command-results/resolve", "post"],
      ["/api/v1/quotes", "post"],
      ["/api/v1/receipts/{id}", "get"],
      ["/api/v1/audit", "get"],
      ["/api/v1/command-previews", "post"],
      ["/api/v1/command-previews/{previewId}/confirm", "post"],
      ["/api/v1/properties/{id}/room-status", "get"]
    ];
    for (const [path, method] of coreResponses) {
      const schema = document.paths[path][method].responses["200"].content["application/json"].schema;
      expect(arbitraryRecordLocations(schema), `${method.toUpperCase()} ${path}`).toEqual([]);
    }
    const orderDetailSchema = document.paths["/api/v1/orders/{id}"].get.responses["200"].content["application/json"].schema as JsonSchema;
    expect(orderDetailSchema.required).toEqual(expect.arrayContaining([
      "originalArrangement", "effectiveArrangement", "fulfillment", "arrangementHistory"
    ]));
    const pricingRevisionSchema = (((orderDetailSchema.properties as Record<string, JsonSchema>).pricingRevisions!.items) as JsonSchema);
    expect(pricingRevisionSchema.required).toEqual(expect.arrayContaining([
      "policy_version_id", "policy_base_amount_minor", "pricing_basis", "manual_adjustment_minor",
      "current_contract_amount_minor", "difference_from_policy_minor", "reason"
    ]));
    expect(pricingRevisionSchema.properties).not.toHaveProperty("channel_contract_amount_minor");
    expect(pricingRevisionSchema.properties).not.toHaveProperty("channel_settlement_amount_minor");
    const collectionFactSchema = (((orderDetailSchema.properties as Record<string, JsonSchema>).collectionFacts!.items) as JsonSchema);
    expect(collectionFactSchema.required).toContain("cash_collector");
    expect((collectionFactSchema.properties as Record<string, JsonSchema>).cash_collector).toBeDefined();
    const fulfillmentSchema = (orderDetailSchema.properties as Record<string, JsonSchema>).fulfillment!;
    expect(fulfillmentSchema.additionalProperties).toBe(false);
    expect(Object.keys(fulfillmentSchema.properties as Record<string, JsonSchema>).sort()).toEqual(["checkIn", "checkInRevocation", "checkOut", "state"]);
    expect(JSON.stringify((fulfillmentSchema.properties as Record<string, JsonSchema>).state)).toEqual(expect.stringContaining("NOT_CHECKED_IN"));
    expect(JSON.stringify((fulfillmentSchema.properties as Record<string, JsonSchema>).state)).toEqual(expect.stringContaining("IN_HOUSE"));
    expect(JSON.stringify((fulfillmentSchema.properties as Record<string, JsonSchema>).state)).toEqual(expect.stringContaining("CHECKED_OUT"));
    expect(JSON.stringify((fulfillmentSchema.properties as Record<string, JsonSchema>).state)).toEqual(expect.stringContaining("CANCELLED"));
    expect(JSON.stringify((fulfillmentSchema.properties as Record<string, JsonSchema>).state)).toEqual(expect.stringContaining("NO_SHOW"));
    for (const [slot, type] of [["checkIn", "CHECK_IN"], ["checkOut", "CHECK_OUT"], ["checkInRevocation", "REVOKE_CHECK_IN"]] as const) {
      const slotSchema = (fulfillmentSchema.properties as Record<string, JsonSchema>)[slot]!;
      const recordSchema = (slotSchema.anyOf as JsonSchema[]).find((variant) => variant.type === "object")!;
      expect(recordSchema.additionalProperties).toBe(false);
      expect(recordSchema.required).toEqual(expect.arrayContaining([
        "type", "plannedBusinessDate", "recordedBusinessDate", "recordingMode", "recordedAt", "actor", "reason"
      ]));
      const properties = recordSchema.properties as Record<string, JsonSchema>;
      expect(properties.type).toMatchObject({ enum: [type] });
      const modeJson = JSON.stringify(properties.recordingMode);
      expect(modeJson).toContain("ON_SCHEDULE");
      expect(modeJson).toContain("LATE_RECORDED");
      expect(modeJson).toContain("LEGACY_UNCLASSIFIED");
    }
    for (const field of ["originalArrangement", "effectiveArrangement"] as const) {
      const arrangementSchema = (orderDetailSchema.properties as Record<string, JsonSchema>)[field]!;
      expect(arrangementSchema.additionalProperties).toBe(false);
      expect(arrangementSchema.required).toEqual(expect.arrayContaining(["arrivalDate", "departureDate", "intervals"]));
      const arrangementProperties = arrangementSchema.properties as Record<string, JsonSchema>;
      const intervalSchema = arrangementProperties.intervals!.items as JsonSchema;
      expect(intervalSchema.additionalProperties).toBe(false);
      expect(intervalSchema.required).toEqual(["inventoryUnitId", "arrivalDate", "departureDate"]);
    }
    const effectiveArrangementSchema = (orderDetailSchema.properties as Record<string, JsonSchema>).effectiveArrangement!;
    expect(effectiveArrangementSchema.required).toEqual(expect.arrayContaining(["presentation", "businessDate"]));
    const arrangementHistorySchema = (orderDetailSchema.properties as Record<string, JsonSchema>).arrangementHistory!.items as JsonSchema;
    expect(arrangementHistorySchema.additionalProperties).toBe(false);
    expect(arrangementHistorySchema.required).toEqual(expect.arrayContaining([
      "type", "before", "after", "reason", "actor", "recordedAt", "pricingSummary", "fundsSummary"
    ]));
    const arrangementHistoryProperties = arrangementHistorySchema.properties as Record<string, JsonSchema>;
    expect(JSON.stringify(arrangementHistoryProperties.type)).toEqual(expect.stringContaining("INITIAL_BOOKING"));
    expect(JSON.stringify(arrangementHistoryProperties.type)).toEqual(expect.stringContaining("MOVE"));
    const roomStatusSchema = document.paths["/api/v1/properties/{id}/room-status"].get.responses["200"].content["application/json"].schema;
    const roomProperties = (((roomStatusSchema.properties as Record<string, JsonSchema>).rooms!.items as JsonSchema).properties) as Record<string, JsonSchema>;
    expect(roomProperties).toHaveProperty("bedOccupancies");
    const occupancyProperties = ((roomProperties.bedOccupancies!.items as JsonSchema).properties) as Record<string, JsonSchema>;
    expect(Object.keys(occupancyProperties).sort()).toEqual(["occupants", "occupiedBedCount", "serviceDate", "totalBedCount"]);
    const occupantProperties = ((occupancyProperties.occupants!.items as JsonSchema).properties) as Record<string, JsonSchema>;
    expect(Object.keys(occupantProperties).sort()).toEqual([
      "inventoryUnitCode", "inventoryUnitId", "occupantId", "primaryOccupantLabel", "sourceReference"
    ]);
    expect((occupantProperties.sourceReference!.properties as Record<string, JsonSchema>).type).toMatchObject({ enum: ["ORDER"] });
    const confirmConflictSchema = document.paths["/api/v1/command-previews/{previewId}/confirm"].post.responses["409"].content["application/json"].schema;
    expect(confirmConflictSchema.anyOf).toHaveLength(2);
    expect(arbitraryRecordLocations(confirmConflictSchema)).toEqual([]);
  });

  it("serves the imported catalog as reference-only data", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/properties/${demo.propertyId}/reference-catalog`,
      headers: { authorization: `Bearer ${demo.readToken}` }
    });
    expect(response.statusCode).toBe(200);
    const catalog = response.json();
    expect(catalog.batch).toMatchObject({ sourceRevision: 561, executionState: "REFERENCE_ONLY" });
    expect(catalog.batch).not.toHaveProperty("sourceDocumentToken");
    expect(catalog.inventoryEntries).toHaveLength(8);
    expect(catalog.rates).toHaveLength(32);
    expect(catalog.membershipProducts).toHaveLength(3);
    expect(catalog.unresolvedIssues.length).toBeGreaterThan(0);
    expect(catalog.rates.every((rate: { executionState: string }) => rate.executionState === "REFERENCE_ONLY")).toBe(true);

    const openapi = (await app.inject({ method: "GET", url: "/api/v1/openapi.json" })).json();
    const batchSchema = openapi.paths["/api/v1/properties/{id}/reference-catalog"].get
      .responses["200"].content["application/json"].schema.properties.batch;
    expect(batchSchema.properties).not.toHaveProperty("sourceDocumentToken");
  });

  it("enforces authentication, property scope, and an in-scope missing-catalog 404", async () => {
    const unauthenticated = await app.inject({
      method: "GET",
      url: `/api/v1/properties/${demo.propertyId}/reference-catalog`
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.json()).toMatchObject({
      code: "AUTHENTICATION_REQUIRED",
      correlationId: expect.any(String),
      retryable: false
    });

    const outsideTokenScope = await app.inject({
      method: "GET",
      url: `/api/v1/properties/${catalogWithoutImportPropertyId}/reference-catalog`,
      headers: { authorization: `Bearer ${demo.readToken}` }
    });
    expect(outsideTokenScope.statusCode).toBe(403);
    expect(outsideTokenScope.json()).toMatchObject({
      code: "RESOURCE_SCOPE_DENIED",
      correlationId: expect.any(String),
      retryable: false
    });

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "operator", password: "demo-pass-2026" }
    });
    expect(login.statusCode).toBe(200);
    const session = login.cookies.find((entry) => entry.name === "qintopia_session");
    expect(session).toBeDefined();
    const missingCatalog = await app.inject({
      method: "GET",
      url: `/api/v1/properties/${catalogWithoutImportPropertyId}/reference-catalog`,
      cookies: { qintopia_session: session!.value }
    });
    expect(missingCatalog.statusCode).toBe(404);
    expect(missingCatalog.json()).toMatchObject({
      code: "NOT_FOUND",
      message: "Reference catalog not found",
      correlationId: expect.any(String),
      retryable: false
    });
  });

  it("publishes and enforces the scoped maintenance-lock query contract", async () => {
    const openapi = (await app.inject({ method: "GET", url: "/api/v1/openapi.json" })).json();
    const operation = openapi.paths["/api/v1/maintenance-locks"].get;
    const propertyParameter = operation.parameters.find((parameter: { name: string }) => parameter.name === "propertyId");
    const statusParameter = operation.parameters.find((parameter: { name: string }) => parameter.name === "status");
    expect(propertyParameter).toMatchObject({ in: "query", required: true, schema: { type: "string", minLength: 3, maxLength: 160 } });
    expect(statusParameter).toMatchObject({ in: "query", required: false });
    expect(statusParameter.schema.anyOf).toEqual(expect.arrayContaining([
      expect.objectContaining({ enum: ["ACTIVE"] }),
      expect.objectContaining({ enum: ["RELEASED"] })
    ]));
    const responseSchema = operation.responses["200"].content["application/json"].schema;
    expect(responseSchema).toMatchObject({ additionalProperties: false, required: ["maintenanceLocks"] });
    expect(arbitraryRecordLocations(responseSchema)).toEqual([]);
    const lockItem = responseSchema.properties.maintenanceLocks.items;
    expect(lockItem.additionalProperties).toBe(false);
    expect([...lockItem.required].sort()).toEqual([
      "arrival_date", "created_at", "departure_date", "id", "inventory_unit_id", "property_id",
      "reason", "released_at", "status", "version"
    ].sort());

    const createdLater = await command(demo.writeToken, "LOCK_MAINTENANCE", {
      propertyId: demo.propertyId,
      inventoryUnitId: demo.secondRoomId,
      arrivalDate: "2027-04-05",
      departureDate: "2027-04-07",
      reason: "Later maintenance query contract"
    });
    const created = await command(demo.writeToken, "LOCK_MAINTENANCE", {
      propertyId: demo.propertyId,
      inventoryUnitId: demo.secondRoomId,
      arrivalDate: "2027-04-01",
      departureDate: "2027-04-03",
      reason: "Maintenance query contract"
    });
    const maintenanceLockId = created.result.maintenanceLockId as string;
    const authorized = await app.inject({
      method: "GET",
      url: `/api/v1/maintenance-locks?propertyId=${demo.propertyId}&status=ACTIVE`,
      headers: { authorization: `Bearer ${demo.readToken}` }
    });
    expect(authorized.statusCode).toBe(200);
    const maintenanceLocks = authorized.json().maintenanceLocks as Array<{ id: string }>;
    expect(maintenanceLocks
      .filter((candidate) => [maintenanceLockId, createdLater.result.maintenanceLockId].includes(candidate.id))
      .map((candidate) => candidate.id)
    ).toEqual([maintenanceLockId, createdLater.result.maintenanceLockId]);
    const lock = maintenanceLocks.find((candidate) => candidate.id === maintenanceLockId) as Record<string, unknown>;
    expect(lock).toMatchObject({
      id: maintenanceLockId,
      property_id: demo.propertyId,
      inventory_unit_id: demo.secondRoomId,
      arrival_date: "2027-04-01",
      departure_date: "2027-04-03",
      reason: "Maintenance query contract",
      status: "ACTIVE",
      version: 1,
      released_at: null
    });
    expect(Object.keys(lock).sort()).toEqual([
      "arrival_date", "created_at", "departure_date", "id", "inventory_unit_id", "property_id",
      "reason", "released_at", "status", "version"
    ].sort());
    const released = await app.inject({
      method: "GET",
      url: `/api/v1/maintenance-locks?propertyId=${demo.propertyId}&status=RELEASED`,
      headers: { authorization: `Bearer ${demo.readToken}` }
    });
    expect(released.statusCode).toBe(200);
    expect(released.json()).toEqual({ maintenanceLocks: [] });
    const outsideScope = await app.inject({
      method: "GET",
      url: "/api/v1/maintenance-locks?propertyId=prop_outside_scope",
      headers: { authorization: `Bearer ${demo.readToken}` }
    });
    expect(outsideScope.statusCode).toBe(403);
    expect(outsideScope.json()).toMatchObject({ code: "RESOURCE_SCOPE_DENIED", retryable: false });
  });

  it("returns a stable 409 error when a Confirm idempotency key is reused with another payload", async () => {
    const previewResponse = await app.inject({
      method: "POST",
      url: "/api/v1/command-previews",
      headers: {
        authorization: `Bearer ${demo.writeToken}`,
        "content-type": "application/json",
        "idempotency-key": "confirm-reuse-preview",
        "x-correlation-id": "confirm-reuse"
      },
      payload: {
        commandType: "LOCK_MAINTENANCE",
        input: {
          propertyId: demo.propertyId,
          inventoryUnitId: demo.secondRoomId,
          arrivalDate: "2027-03-01",
          departureDate: "2027-03-02",
          reason: "Contract idempotency test"
        }
      }
    });
    expect(previewResponse.statusCode).toBe(200);
    const preview = previewResponse.json().preview;
    const confirmHeaders = {
      authorization: `Bearer ${demo.writeToken}`,
      "content-type": "application/json",
      "idempotency-key": "confirm-reused-key",
      "x-correlation-id": "confirm-reuse"
    };
    const first = await app.inject({
      method: "POST",
      url: `/api/v1/command-previews/${preview.previewId}/confirm`,
      headers: confirmHeaders,
      payload: { propertyId: demo.propertyId, commandType: "LOCK_MAINTENANCE", confirmation: true, expectedEffectHash: preview.effectHash, reason: { code: "CONTRACT_TEST", note: "First confirmation payload" } }
    });
    expect(first.statusCode).toBe(200);
    const conflicting = await app.inject({
      method: "POST",
      url: `/api/v1/command-previews/${preview.previewId}/confirm`,
      headers: confirmHeaders,
      payload: { propertyId: demo.propertyId, commandType: "LOCK_MAINTENANCE", confirmation: true, expectedEffectHash: preview.effectHash, reason: { code: "CONTRACT_TEST", note: "Different confirmation payload" } }
    });
    expect(conflicting.statusCode).toBe(409);
    expect(conflicting.json()).toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED",
      correlationId: "confirm-reuse",
      retryable: false
    });
  });

  it("enforces the read-only token ceiling and returns a stable error DTO", async () => {
    const read = await app.inject({ method: "GET", url: "/api/v1/meta", headers: { authorization: `Bearer ${demo.readToken}` } });
    expect(read.statusCode).toBe(200);
    const denied = await app.inject({
      method: "POST",
      url: "/api/v1/command-previews",
      headers: {
        authorization: `Bearer ${demo.readToken}`,
        "content-type": "application/json",
        "idempotency-key": "readonly-contract",
        "x-correlation-id": "readonly-contract"
      },
      payload: {
        commandType: "LOCK_MAINTENANCE",
        input: { propertyId: demo.propertyId, inventoryUnitId: demo.secondRoomId, arrivalDate: "2026-07-21", departureDate: "2026-07-22", reason: "contract" }
      }
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: "INSUFFICIENT_ACCESS", correlationId: "readonly-contract", retryable: false });
  });

  it("requires command metadata before any write", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/command-previews",
      headers: { authorization: `Bearer ${demo.writeToken}`, "content-type": "application/json" },
      payload: { commandType: "CHECK_IN", input: { propertyId: demo.propertyId, orderId: "order_missing" } }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "IDEMPOTENCY_KEY_REQUIRED", retryable: false });

    const quote = await app.inject({
      method: "POST",
      url: "/api/v1/quotes",
      headers: { authorization: `Bearer ${demo.readToken}`, "content-type": "application/json" },
      payload: {
        propertyId: demo.propertyId,
        inventoryUnitId: demo.roomId,
        stayType: "TRANSIENT",
        arrivalDate: "2027-11-01",
        departureDate: "2027-11-02",
        pricingPolicyVersionId: demo.transientPolicyId
      }
    });
    expect(quote.statusCode).toBe(400);
    expect(quote.json()).toMatchObject({ code: "IDEMPOTENCY_KEY_REQUIRED", retryable: false });
  });

  it("derives paid stay type from dates and rejects an inconsistent compatibility value", async () => {
    const omitted = await app.inject({
      method: "POST",
      url: "/api/v1/quotes",
      headers: {
        authorization: `Bearer ${demo.writeToken}`,
        "content-type": "application/json",
        "idempotency-key": "contract-derived-stay-type",
        "x-correlation-id": "contract-derived-stay-type"
      },
      payload: {
        propertyId: demo.propertyId,
        inventoryUnitId: "unit_room_104",
        arrivalDate: "2026-07-26",
        departureDate: "2026-08-05",
        pricingPolicyVersionId: demo.publicPricingPolicyId
      }
    });
    expect(omitted.statusCode, omitted.body).toBe(200);
    expect(omitted.json().quote).toMatchObject({
      stayType: "CUSTOM",
      currentContractAmount: { currency: "CNY", minorUnits: 176_000 }
    });
    expect(omitted.json().quote.pricingExplanation).toMatchObject({
      pricingModel: "DURATION_BAND_TOTAL",
      totalNights: 10,
      quoteAmount: { currency: "CNY", minorUnits: 176_000 },
      amountField: "currentContractAmount",
      durationBand: {
        anchorNights: 7,
        finalAmount: { currency: "CNY", minorUnits: 176_000 },
        auditCalculationFieldsAreAmounts: false
      }
    });

    const halfMonth = await app.inject({
      method: "POST",
      url: "/api/v1/quotes",
      headers: {
        authorization: `Bearer ${demo.writeToken}`,
        "content-type": "application/json",
        "idempotency-key": "contract-duration-band-15-night-explanation",
        "x-correlation-id": "contract-duration-band-15-night-explanation"
      },
      payload: {
        propertyId: demo.propertyId,
        inventoryUnitId: demo.bedAId,
        arrivalDate: "2026-08-15",
        departureDate: "2026-08-30",
        pricingPolicyVersionId: demo.publicPricingPolicyId
      }
    });
    expect(halfMonth.statusCode, halfMonth.body).toBe(200);
    const halfMonthQuote = halfMonth.json().quote;
    expect(halfMonthQuote).toMatchObject({
      stayType: "CUSTOM",
      currentContractAmount: { currency: "CNY", minorUnits: 51_400 },
      pricingExplanation: {
        pricingModel: "DURATION_BAND_TOTAL",
        totalNights: 15,
        quoteAmount: { currency: "CNY", minorUnits: 51_400 },
        amountField: "currentContractAmount",
        durationBand: {
          anchorNights: 14,
          finalAmount: { currency: "CNY", minorUnits: 51_400 },
          auditCalculationFieldsAreAmounts: false
        }
      }
    });
    expect(halfMonthQuote.pricingExplanation.summary).toContain("15 夜按 14 夜档折算");
    expect(halfMonthQuote.pricingExplanation.agentInstruction).toContain("currentContractAmount");
    expect(halfMonthQuote.pricingExplanation.agentInstruction).toContain("cashLines[].amount 是明细行金额");
    expect(halfMonthQuote.cashLines[0]).toMatchObject({
      lineKind: "STAY_TOTAL",
      pricingBandAnchorNights: 14,
      amount: { currency: "CNY", minorUnits: 51_400 }
    });
    expect(halfMonthQuote.cashLines[0].pricingSummary).toContain("本行最终金额 ¥514.00");
    expect(JSON.stringify(halfMonthQuote)).not.toContain("numeratorMinor");
    expect(JSON.stringify(halfMonthQuote)).not.toContain("anchorAmountMinor");
    expect(JSON.stringify(halfMonth.json().receipt.result.quote)).not.toContain("numeratorMinor");

    const before = await database.selectFrom("command_executions")
      .select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow();
    const mismatch = await app.inject({
      method: "POST",
      url: "/api/v1/quotes",
      headers: {
        authorization: `Bearer ${demo.writeToken}`,
        "content-type": "application/json",
        "idempotency-key": "contract-mismatched-stay-type",
        "x-correlation-id": "contract-mismatched-stay-type"
      },
      payload: {
        propertyId: demo.propertyId,
        inventoryUnitId: "unit_room_104",
        stayType: "TRANSIENT",
        arrivalDate: "2026-08-20",
        departureDate: "2026-08-30",
        pricingPolicyVersionId: demo.publicPricingPolicyId
      }
    });
    expect(mismatch.statusCode, mismatch.body).toBe(422);
    expect(mismatch.json()).toMatchObject({
      code: "PRICING_POLICY_UNCONFIGURED",
      message: "住宿类型与 10 晚住宿不一致，请重新报价",
      retryable: false
    });
    const after = await database.selectFrom("command_executions")
      .select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow();
    expect(Number(after.count)).toBe(Number(before.count));
  });

  it("uses an HttpOnly session for Web while preserving the same subject grants", async () => {
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "operator", password: "demo-pass-2026" } });
    expect(login.statusCode).toBe(200);
    const cookie = login.cookies.find((entry) => entry.name === "qintopia_session");
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("Strict");
    const me = await app.inject({ method: "GET", url: "/api/v1/me", cookies: { qintopia_session: cookie!.value } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ subjectId: demo.operatorSubjectId, credentialType: "SESSION", propertyAccess: { [demo.propertyId]: "WRITE" } });
  });

  it("does not claim a missing command is durably not executed from a read-only lookup", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/command-results?propertyId=${demo.propertyId}&commandType=CREATE_ORDER&idempotencyKey=never-arrived`,
      headers: { authorization: `Bearer ${demo.writeToken}` }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ executionStatus: "UNKNOWN", businessCommitted: false });
  });

  it("serializes and recovers a committed terminal order result", async () => {
    const quoteResponse = await app.inject({
      method: "POST",
      url: "/api/v1/quotes",
      headers: {
        authorization: `Bearer ${demo.writeToken}`,
        "content-type": "application/json",
        "idempotency-key": "contract-terminal-order-quote",
        "x-correlation-id": "contract-terminal-order-quote"
      },
      payload: {
        propertyId: demo.propertyId,
        inventoryUnitId: demo.roomId,
        stayType: "TRANSIENT",
        arrivalDate: "2027-12-20",
        departureDate: "2027-12-22",
        pricingPolicyVersionId: demo.transientPolicyId
      }
    });
    expect(quoteResponse.statusCode, quoteResponse.body).toBe(200);
    const created = await command(demo.writeToken, "CREATE_ORDER", {
      propertyId: demo.propertyId,
      quoteId: quoteResponse.json().quote.quoteId,
      primaryGuest: {
        fullName: "Terminal Contract Guest",
        nickname: "Terminal Guest",
        phone: "13800000555",
        documentNumber: "DOC-TERMINAL-CONTRACT-1"
      },
      bookingChannelCode: "WECOM"
    });
    const orderId = created.result.orderId as string;
    const previewResponse = await app.inject({
      method: "POST",
      url: "/api/v1/command-previews",
      headers: {
        authorization: `Bearer ${demo.writeToken}`,
        "content-type": "application/json",
        "idempotency-key": "contract-terminal-cancel-preview",
        "x-correlation-id": "contract-terminal-cancel"
      },
      payload: { commandType: "CANCEL_ORDER", input: { propertyId: demo.propertyId, orderId } }
    });
    expect(previewResponse.statusCode, previewResponse.body).toBe(200);
    const preview = previewResponse.json().preview;
    const confirmResponse = await app.inject({
      method: "POST",
      url: `/api/v1/command-previews/${preview.previewId}/confirm`,
      headers: {
        authorization: `Bearer ${demo.writeToken}`,
        "content-type": "application/json",
        "idempotency-key": "contract-terminal-cancel-confirm",
        "x-correlation-id": "contract-terminal-cancel"
      },
      payload: {
        propertyId: demo.propertyId,
        commandType: "CANCEL_ORDER",
        confirmation: true,
        expectedEffectHash: preview.effectHash,
        reason: { code: "CONTRACT_TEST", note: "Verify terminal receipt serialization" }
      }
    });
    expect(confirmResponse.statusCode, confirmResponse.body).toBe(200);
    const cancelled = confirmResponse.json();
    expect(cancelled.result).toMatchObject({
      orderId,
      status: "CANCELLED",
      pricingRevisionId: expect.any(String),
      effectHash: expect.stringMatching(/^[a-f0-9]{64}$/)
    });

    const recovered = await app.inject({
      method: "GET",
      url: `/api/v1/command-results?propertyId=${demo.propertyId}&commandType=CANCEL_ORDER&idempotencyKey=contract-terminal-cancel-confirm`,
      headers: { authorization: `Bearer ${demo.writeToken}` }
    });
    expect(recovered.statusCode, recovered.body).toBe(200);
    expect(recovered.json()).toMatchObject({
      executionStatus: "EXECUTED",
      businessCommitted: true,
      result: {
        orderId,
        status: "CANCELLED",
        pricingRevisionId: cancelled.result.pricingRevisionId,
        effectHash: cancelled.result.effectHash
      }
    });
  });

  it("serializes stable order, member, fact, and audit views from executed facts", async () => {
    const quoteResponse = await app.inject({
      method: "POST",
      url: "/api/v1/quotes",
      headers: {
        authorization: `Bearer ${demo.writeToken}`,
        "content-type": "application/json",
        "idempotency-key": "contract-view-quote",
        "x-correlation-id": "contract-view-quote"
      },
      payload: {
        propertyId: demo.propertyId,
        inventoryUnitId: demo.roomId,
        stayType: "TRANSIENT",
        arrivalDate: "2026-11-10",
        departureDate: "2026-11-12",
        pricingPolicyVersionId: demo.transientPolicyId
      }
    });
    expect(quoteResponse.statusCode).toBe(200);
    const created = await command(demo.writeToken, "CREATE_ORDER", {
      propertyId: demo.propertyId,
      quoteId: quoteResponse.json().quote.quoteId,
      primaryGuest: { fullName: "Contract View Guest", nickname: "Contract Guest", phone: "13800000000", documentNumber: "DOC-CONTRACT-1" },
      bookingChannelCode: "WECOM",
      channelOrderReference: null,
      targetCurrentContractAmountMinor: quoteResponse.json().quote.currentContractAmount.minorUnits
    });
    expect(created.result.primaryGuest).toEqual({
      fullName: "Contract View Guest",
      nickname: "Contract Guest",
      phone: "13800000000",
      documentNumber: "DOC-CONTRACT-1"
    });
    const orderId = created.result.orderId as string;
    const listed = await app.inject({
      method: "GET", url: `/api/v1/orders?propertyId=${demo.propertyId}`,
      headers: { authorization: `Bearer ${demo.writeToken}` }
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().orders).toEqual(expect.arrayContaining([expect.objectContaining({
      id: orderId,
      current_contract_amount_minor: quoteResponse.json().quote.currentContractAmount.minorUnits,
      currency: "CNY"
    })]));
    const detail = await app.inject({
      method: "GET", url: `/api/v1/orders/${orderId}`,
      headers: { authorization: `Bearer ${demo.writeToken}` }
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      order: { id: orderId, primary_guest_snapshot: { fullName: "Contract View Guest", nickname: "Contract Guest" }, booking_channel_code: "WECOM", channel_order_reference: null },
      stay: { status: "PLANNED" },
      pricingRevisions: [{ revision_no: 1 }],
      cleaningTasks: []
    });
    const collection = await command(demo.writeToken, "RECORD_COLLECTION", {
      propertyId: demo.propertyId, orderId, amountMinor: 6_000, method: "BANK_TRANSFER", transactionReference: "TEST-CONTRACT-TXN-COLLECTION-1", note: "Contract fact"
    });
    const factId = collection.result.factId as string;
    const fact = await app.inject({
      method: "GET", url: `/api/v1/facts/${factId}`,
      headers: { authorization: `Bearer ${demo.writeToken}` }
    });
    expect(fact.statusCode).toBe(200);
    expect(fact.json()).toMatchObject({ fact_id: factId, order_id: orderId, fact_type: "COLLECTION", transaction_reference: "TEST-CONTRACT-TXN-COLLECTION-1", pricing_revision_id: expect.any(String), property_id: demo.propertyId });
    const registeredMember = await command(demo.writeToken, "CREATE_MEMBER", {
      propertyId: demo.propertyId,
      fullName: "Contract API Member",
      nickname: "契约会员",
      phone: "13800000333",
      wechat: "contract-api-member"
    });
    expect(registeredMember.result).toMatchObject({ memberCreated: true });
    const memberId = registeredMember.result.memberId as string;
    expect(registeredMember.resourceRefs).toEqual([memberId]);
    const memberSearch = await app.inject({
      method: "GET",
      url: `/api/v1/members?propertyId=${demo.propertyId}&query=contract-api`,
      headers: { authorization: `Bearer ${demo.writeToken}` }
    });
    expect(memberSearch.statusCode).toBe(200);
    expect(memberSearch.json()).toMatchObject({
      members: [{
        member: { id: memberId, identity_card_number: null, nickname: "契约会员", full_name: "Contract API Member" }
      }]
    });
    expect(Object.keys((memberSearch.json() as { members: Array<Record<string, unknown>> }).members[0]!)).toEqual(["member"]);
    const allMembersWithEmptyQuery = await app.inject({
      method: "GET",
      url: `/api/v1/members?propertyId=${demo.propertyId}&query=`,
      headers: { authorization: `Bearer ${demo.writeToken}` }
    });
    expect(allMembersWithEmptyQuery.statusCode).toBe(200);
    expect((allMembersWithEmptyQuery.json() as { members: Array<{ member: { id: string } }> }).members)
      .toEqual(expect.arrayContaining([expect.objectContaining({ member: expect.objectContaining({ id: memberId }) })]));
    const metaAfterMemberCreate = await app.inject({
      method: "GET",
      url: "/api/v1/meta",
      headers: { authorization: `Bearer ${demo.writeToken}` }
    });
    expect(metaAfterMemberCreate.statusCode).toBe(200);
    expect(metaAfterMemberCreate.json()).toMatchObject({ members: [], memberContracts: [] });
    const member = await app.inject({
      method: "GET", url: `/api/v1/members/${memberId}?propertyId=${demo.propertyId}`,
      headers: { authorization: `Bearer ${demo.writeToken}` }
    });
    expect(member.statusCode).toBe(200);
    expect(member.json()).toMatchObject({
      member: { id: memberId, identity_card_number: null, nickname: "契约会员" },
      contracts: [],
      lots: [],
      ledger: [],
      externalReferences: [],
      availableBalance: { ROOM_NIGHT: 0, BED_NIGHT: 0 }
    });
    const duplicateMember = await app.inject({
      method: "POST",
      url: "/api/v1/command-previews",
      headers: {
        authorization: `Bearer ${demo.writeToken}`,
        "content-type": "application/json",
        "idempotency-key": "contract-duplicate-member-preview",
        "x-correlation-id": "contract-duplicate-member-preview"
      },
      payload: {
        commandType: "CREATE_MEMBER",
        input: {
          propertyId: demo.propertyId,
          fullName: "Duplicate Contract API Member",
          nickname: "重复契约会员",
          phone: " 13800000333 ",
          wechat: "duplicate-contract-member"
        }
      }
    });
    expect(duplicateMember.statusCode).toBe(409);
    expect(duplicateMember.json()).toMatchObject({ code: "VALIDATION_ERROR", message: "该手机号已登记，不能重复创建会员档案" });
    const audit = await app.inject({
      method: "GET", url: `/api/v1/audit?propertyId=${demo.propertyId}`,
      headers: { authorization: `Bearer ${demo.writeToken}` }
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().entries).toEqual(expect.arrayContaining([expect.objectContaining({ action: "RECORD_COLLECTION" })]));
  });

  it("enforces narrowed Token issuance and immediate rotation/revocation", async () => {
    const readSecret = newOpaqueSecret("qtp");
    const readIssue = await command(demo.administratorWriteToken, "ISSUE_TOKEN", {
      propertyId: demo.propertyId, subjectId: demo.agentSubjectId, label: "Contract read token",
      accessCeiling: "READ", commandCeiling: [], expiresAt: "2029-01-01T00:00:00.000Z", tokenSecret: readSecret
    });
    expect(readIssue.result).not.toHaveProperty("tokenSecret");
    const denied = await app.inject({
      method: "POST", url: "/api/v1/command-previews",
      headers: {
        authorization: `Bearer ${readSecret}`, "content-type": "application/json",
        "idempotency-key": "narrowed-write", "x-correlation-id": "narrowed-write"
      },
      payload: { commandType: "LOCK_MAINTENANCE", input: { propertyId: demo.propertyId, inventoryUnitId: demo.roomId, arrivalDate: "2026-07-25", departureDate: "2026-07-26", reason: "denied" } }
    });
    expect(denied.statusCode).toBe(403);

    const oldSecret = newOpaqueSecret("qtp");
    const writeIssue = await command(demo.administratorWriteToken, "ISSUE_TOKEN", {
      propertyId: demo.propertyId, subjectId: demo.agentSubjectId, label: "Contract rotating token",
      accessCeiling: "WRITE", commandCeiling: ["CREATE_ORDER", "LOCK_MAINTENANCE"], expiresAt: "2029-01-01T00:00:00.000Z", tokenSecret: oldSecret
    });
    expect(writeIssue.result).not.toHaveProperty("tokenSecret");
    const oldTokenId = writeIssue.result.tokenId as string;
    const replacementSecret = newOpaqueSecret("qtp");
    const rotated = await command(demo.administratorWriteToken, "ROTATE_TOKEN", {
      propertyId: demo.propertyId,
      tokenId: oldTokenId,
      commandCeiling: ["CREATE_ORDER", "LOCK_MAINTENANCE"],
      tokenSecret: replacementSecret
    });
    expect(rotated.result).not.toHaveProperty("tokenSecret");
    const replacementTokenId = rotated.result.tokenId as string;
    const oldResponse = await app.inject({ method: "GET", url: "/api/v1/meta", headers: { authorization: `Bearer ${oldSecret}` } });
    expect(oldResponse.statusCode).toBe(401);
    expect(oldResponse.json().code).toBe("TOKEN_REVOKED");
    expect((await app.inject({ method: "GET", url: "/api/v1/meta", headers: { authorization: `Bearer ${replacementSecret}` } })).statusCode).toBe(200);
    await command(demo.administratorWriteToken, "REVOKE_TOKEN", { propertyId: demo.propertyId, tokenId: replacementTokenId });
    const revoked = await app.inject({ method: "GET", url: "/api/v1/meta", headers: { authorization: `Bearer ${replacementSecret}` } });
    expect(revoked.statusCode).toBe(401);
    expect(revoked.json().code).toBe("TOKEN_REVOKED");
  });
});
