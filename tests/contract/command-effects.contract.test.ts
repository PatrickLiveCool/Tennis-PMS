import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { commandTypes, type AuthPrincipal, type CommandType } from "@qintopia/contracts";
import { newOpaqueSecret, parseLocalDate, todayInTimeZone } from "@qintopia/domain";
import {
  buildCommandEffect,
  confirmCommandPreview as confirmCommandPreviewDirect,
  createCommandPreview as createCommandPreviewDirect,
  withPropertyClockForTesting,
  type Database
} from "@qintopia/db";
import type { Kysely } from "kysely";
import { CommandEffectSchema, ErrorResponse, ReceiptSchema } from "../../apps/api/src/schemas.ts";
import { buildServer } from "../../apps/api/src/server.ts";
import { demo } from "../../packages/db/src/seed.ts";
import { authScope } from "../helpers/auth-principals.ts";
import { resetDatabase } from "../helpers/database.ts";

const effectContractDatabaseUrl = process.env.EFFECT_CONTRACT_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_effect_contract";

const expectedEffectKeys: Record<CommandType, string[]> = {
  MANAGE_ROOM_CATALOG: ["action", "after", "beforeVersion", "description", "insertUnits", "operation", "policies", "propertyId", "retireUnitIds", "roomLink", "title"],
  CREATE_MEMBER: ["member", "memberId", "operation", "propertyLink"],
  CREATE_MEMBERSHIP_ORDER: ["member", "operation", "pricing", "product", "status"],
  RECORD_MEMBERSHIP_PAYMENT: ["memberName", "membershipOrderId", "operation", "payment", "productName", "status", "totals"],
  CORRECT_MEMBERSHIP_PAYMENT: ["memberName", "membershipOrderId", "operation", "original", "originalPaymentFactId", "productName", "replacement", "status", "totals"],
  ACTIVATE_MEMBERSHIP_ORDER: ["agreedPrice", "entitlementUnitKind", "entitlementUnits", "fromStatus", "memberName", "membershipOrderId", "operation", "paymentDifference", "paymentTotal", "productName", "toStatus", "validFrom", "validUntil"],
  CREATE_ORDER: ["arrivalDate", "bookingChannelCode", "channelOrderReference", "departureDate", "freeStayCategoryCode", "freeStayReason", "inventoryUnit", "memberContractId", "memberId", "occupancyCapacity", "occupants", "pricing", "pricingDecision", "pricingPolicyVersionId", "primaryGuest", "quoteId", "stayType"],
  CORRECT_ORDER_OCCUPANT: ["after", "before", "occupantId", "operation", "orderId", "ordinal", "role"],
  MANAGE_ORDER_OCCUPANTS: ["action", "afterCount", "arrivalDate", "beforeCount", "departureDate", "guest", "occupancyCapacity", "occupantId", "operation", "orderId", "ordinal"],
  CORRECT_HISTORICAL_STAY_ARRANGEMENTS: ["corrections", "operation"],
  CORRECT_MEMBER_PROFILE: ["after", "before", "changedFields", "evidenceNote", "memberId", "operation"],
  CORRECT_MEMBERSHIP_EFFECTIVE_DATE: ["after", "before", "contractId", "entitlementLotId", "evidenceNote", "memberId", "membershipOrderId", "operation", "propertyToday", "unchanged"],
  BACKFILL_HISTORICAL_MEMBERSHIP: ["entitlementUnitKind", "entitlementUnits", "evidenceNote", "member", "operation", "payment", "product", "status", "validFrom", "validUntil"],
  VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY: ["entitlement", "evidenceNote", "funds", "member", "newMembership", "oldMembership", "operation", "sourceStay"],
  RESCHEDULE_STAY: ["after", "before", "entitlementChange", "fundsSummary", "inventoryChange", "inventoryUnitId", "operation", "orderId", "pricingDecision", "stayId"],
  EXTEND_STAY: ["after", "before", "entitlementChange", "fundsSummary", "inventoryChange", "inventoryUnitId", "operation", "orderId", "pricingDecision", "stayId"],
  SHORTEN_STAY: ["after", "before", "businessDate", "completionMode", "entitlementSummary", "fundsSummary", "inventoryChange", "inventoryUnitId", "operation", "orderId", "pricingDecision", "refundReferenceAmount", "stayId"],
  MOVE_UNIT: [
    "after", "before", "businessDate", "effectiveDate", "entitlementSummary", "fundsSummary", "inventoryChange",
    "occupancyCapacity", "occupantCount", "operation", "orderId", "pricingDecision", "stayId", "toInventoryUnit"
  ],
  REPRICE_ORDER: ["before", "inventoryUnitId", "manualAdjustmentMinor", "orderId", "policyBaseAmount", "pricing", "stayTimeline", "targetCurrentContractAmount"],
  CANCEL_ORDER: ["amounts", "businessDate", "currentContractAmount", "entitlementTransition", "freeStayCategoryCode", "freeStayReason", "fromStatus", "inventoryUnitId", "orderId", "pricingRevision", "toStatus"],
  MARK_NO_SHOW: ["amounts", "businessDate", "currentContractAmount", "entitlementTransition", "freeStayCategoryCode", "freeStayReason", "fromStatus", "inventoryUnitId", "orderId", "pricingRevision", "toStatus"],
  REVOKE_CHECK_IN: ["amounts", "businessDate", "currentContractAmount", "effectiveDate", "entitlementTransition", "fromStatus", "inventoryUnitId", "orderId", "pricingRevision", "recordingMode", "toStatus", "unusedRoomConfirmed"],
  LOCK_MAINTENANCE: ["arrivalDate", "departureDate", "inventoryUnit", "reason"],
  RELEASE_MAINTENANCE: ["arrivalDate", "departureDate", "inventoryUnitId", "maintenanceLockId"],
  COMPLETE_CLEANING: ["cleaningTaskId", "fromStatus", "inventoryUnitId", "orderId", "roomId", "serviceDate", "stayId", "toStatus"],
  RECORD_COLLECTION: ["amountMinor", "currency", "method", "note", "orderId", "transactionReference"],
  RECORD_REFUND: ["amountMinor", "currency", "method", "note", "orderId", "referencesFactId", "transactionReference"],
  CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP: ["before", "entitlement", "member", "membershipPricing", "operation", "orderId", "pricing", "pricingDecision", "primaryOccupant", "product", "remainingPayment", "stayId", "transfer"],
  REVERSE_FACT: ["amountMinor", "currency", "netEffectMinor", "note", "orderId", "reversesFactId"],
  CHECK_IN: ["businessDate", "effectiveDate", "entitlementTransition", "fromStatus", "inventoryUnitId", "orderId", "recordingMode", "toStatus"],
  CHECK_OUT: ["amounts", "businessDate", "effectiveDate", "fromStatus", "inventoryUnitId", "orderId", "recordingMode", "toStatus"],
  REVOKE_CHECK_OUT: ["after", "before", "businessDate", "checkoutAmendmentId", "checkoutSequence", "entitlementReconsumeDates", "fromStatus", "fundsSummary", "mode", "operation", "orderId", "sourceRevisionId", "toStatus"],
  COMPLETE_STAY: [
    "amounts", "arrivalDate", "businessDate", "checkIn", "checkOut", "collection", "departureDate",
    "entitlementTransition", "inventoryRelease", "inventoryUnitId", "operation", "orderId", "reasonNote",
    "settlementStatus", "stayId", "stayTimeline"
  ],
  REFRESH_MEMBER_COVERAGE: ["before", "inventoryUnitId", "orderId", "pricing", "stayTimeline"],
  ADD_MEMBER_ENTITLEMENT_LOT: ["contractId", "expiresOn", "unitKind", "units"],
  ADJUST_MEMBER_ENTITLEMENT: ["adjustmentReason", "availableAfter", "availableBefore", "contractId", "entitlementLotId", "quantityDelta", "unitKind"],
  CORRECT_MEMBER_ENTITLEMENT_BALANCE: ["adjustmentReason", "availableAfter", "availableBefore", "contractId", "entitlementLotId", "quantityDelta", "unitKind"],
  EXPIRE_MEMBER_ENTITLEMENT: ["asOfDate", "contractId", "entitlementLotId", "entryType", "expiresOn", "quantityDelta", "remainingAvailable", "unitKind"],
  ISSUE_TOKEN: ["accessCeiling", "commandCeiling", "expiresAt", "label", "persistedCommandCeiling", "subjectDisplayName", "subjectId"],
  ROTATE_TOKEN: [
    "accessCeiling", "commandCeiling", "expiresAt", "historicalReadCeilingPreserved", "label", "operation",
    "persistedCommandCeiling", "previousCommandCeiling", "previousExpiresAt", "previousPersistedCommandCeiling",
    "subjectDisplayName", "subjectId", "tokenId"
  ],
  REVOKE_TOKEN: [
    "accessCeiling", "commandCeiling", "expiresAt", "historicalReadCeilingPreserved", "label", "operation",
    "persistedCommandCeiling", "subjectDisplayName", "subjectId", "tokenId"
  ]
};

type Preview = {
  previewId: string;
  commandType: CommandType;
  effectHash: string;
  effect: Record<string, unknown>;
};

type ConfirmedReceipt = {
  receiptId: string;
  commandId: string;
  result: Record<string, unknown>;
  resourceRefs: string[];
  factRefs: string[];
};

let app: FastifyInstance;
let db: Kysely<Database>;
let sequence = 0;
const directPrincipal: AuthPrincipal = {
  subjectId: demo.agentSubjectId,
  credentialId: "token_demo_write",
  credentialType: "TOKEN",
  displayName: "Demo Agent",
  ...authScope()
};

function shiftLocalDate(value: string, days: number): string {
  const date = parseLocalDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function headers(prefix: string, token: string = demo.writeToken) {
  sequence += 1;
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "idempotency-key": `${prefix}-${sequence}`,
    "x-correlation-id": `${prefix}-${sequence}`
  };
}

function metadata(prefix: string) {
  const values = headers(prefix);
  return {
    idempotencyKey: values["idempotency-key"],
    correlationId: values["x-correlation-id"]
  };
}

async function executeSetupCommand(commandType: CommandType, input: Record<string, unknown>, prefix: string): Promise<Record<string, unknown>> {
  const { preview } = await createCommandPreviewDirect(db, directPrincipal, { commandType, input }, metadata(`${prefix}-preview`));
  const receipt = await confirmCommandPreviewDirect(db, directPrincipal, preview.previewId, {
    propertyId: demo.propertyId,
    commandType,
    confirmation: true,
    expectedEffectHash: preview.effectHash,
    reason: commandType === "CREATE_ORDER"
      ? { code: "CREATE_STANDARD_ORDER", note: "" }
      : { code: "EFFECT_CONTRACT_SETUP", note: `Prepare state for ${commandType} effect coverage` }
  }, metadata(`${prefix}-confirm`));
  const result = receipt.result;
  expect(result, `${commandType}: setup command result`).toBeDefined();
  return result as Record<string, unknown>;
}

async function requestPreview(commandType: CommandType, input: Record<string, unknown>, token: string = demo.writeToken): Promise<Preview> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/command-previews",
    headers: headers(`effect-${commandType.toLowerCase()}-preview`, token),
    payload: { commandType, input }
  });
  expect(response.statusCode, `${commandType}: ${response.body}`).toBe(200);
  const preview = (response.json() as { preview: Preview }).preview;
  expect(preview.commandType).toBe(commandType);
  expect(Object.keys(preview.effect).sort(), commandType).toEqual(expectedEffectKeys[commandType]);
  expect(Value.Check(CommandEffectSchema, preview.effect), `${commandType}: ${JSON.stringify(preview.effect)}`).toBe(true);
  return preview;
}

async function confirmReceipt(preview: Preview): Promise<{ receipt: ConfirmedReceipt; idempotencyKey: string }> {
  const confirmHeaders = headers(`effect-${preview.commandType.toLowerCase()}-confirm`);
  const response = await app.inject({
    method: "POST",
    url: `/api/v1/command-previews/${preview.previewId}/confirm`,
    headers: confirmHeaders,
    payload: {
      propertyId: demo.propertyId,
      commandType: preview.commandType,
      confirmation: true,
      expectedEffectHash: preview.effectHash,
      reason: preview.commandType === "CREATE_ORDER"
        ? { code: "CREATE_STANDARD_ORDER", note: "" }
        : preview.commandType === "COMPLETE_STAY"
          ? { code: "COMPLETE_STAY", note: (preview.effect as { reasonNote?: string }).reasonNote ?? "" }
          : { code: "EFFECT_CONTRACT", note: `Prepare state for ${preview.commandType} effect coverage` }
    }
  });
  expect(response.statusCode, `${preview.commandType}: ${response.body}`).toBe(200);
  const receipt = response.json() as ConfirmedReceipt;
  expect(Value.Check(ReceiptSchema, receipt), `${preview.commandType}: ${JSON.stringify(receipt)}`).toBe(true);
  return { receipt, idempotencyKey: confirmHeaders["idempotency-key"] };
}

async function confirm(preview: Preview): Promise<Record<string, unknown>> {
  return (await confirmReceipt(preview)).receipt.result;
}

async function quote(options: {
  arrivalDate?: string;
  departureDate?: string;
  inventoryUnitId?: string;
  memberId?: string;
  pricingPolicyVersionId?: string;
} = {}) {
  const propertyToday = todayInTimeZone("Asia/Shanghai");
  const arrivalDate = options.arrivalDate ?? propertyToday;
  const departureDate = options.departureDate ?? shiftLocalDate(propertyToday, 4);
  const pricingPolicyVersionId = options.pricingPolicyVersionId
    ?? (arrivalDate.slice(0, 7) === departureDate.slice(0, 7)
      ? demo.transientPolicyId
      : demo.publicPricingPolicyId);
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/quotes",
    headers: headers("effect-create-quote"),
    payload: {
      propertyId: demo.propertyId,
      inventoryUnitId: options.inventoryUnitId ?? demo.roomId,
      stayType: "TRANSIENT",
      arrivalDate,
      departureDate,
      pricingPolicyVersionId,
      ...(options.memberId ? { memberId: options.memberId } : {})
    }
  });
  expect(response.statusCode, response.body).toBe(200);
  return (response.json() as { quote: { quoteId: string; currentContractAmount: { minorUnits: number } } }).quote;
}

beforeAll(async () => {
  process.env.LOG_LEVEL = "silent";
  process.env.BEARER_AUTH_RATE_LIMIT_MAX = "5000";
  FormatRegistry.Set("date-time", (value) => typeof value === "string" && Number.isFinite(Date.parse(value)));
  db = await resetDatabase(effectContractDatabaseUrl);
  app = await buildServer(db);
  await app.ready();
});

afterAll(async () => {
  if (app) await app.close();
});

describe("Command effect HTTP contract", () => {
  it("accepts only the persisted MOVE_UNIT receipt result shape", () => {
    const inventoryUnit = {
      id: "unit_move_contract",
      propertyId: "property_move_contract",
      kind: "ROOM",
      roomId: "room_move_contract",
      code: "101",
      name: "101",
      catalogVersion: null,
      buildingCode: null,
      roomTypeCode: "STANDARD",
      pricingProductCode: "STANDARD",
      inventoryBasis: "INDEPENDENT",
      codeProvenance: "SOURCE_EXPLICIT",
      physicalBedCount: 1,
      occupancyCapacity: 2
    };
    const stayTimeline = [
      { serviceDate: "2028-04-10", inventoryUnitId: "unit_move_contract" },
      { serviceDate: "2028-04-11", inventoryUnitId: "unit_move_target" }
    ];
    const pricing = {
      coverageSet: [],
      cashLines: [],
      cashRemainder: { currency: "CNY", minorUnits: 20_000 },
      currentContractAmount: { currency: "CNY", minorUnits: 20_000 }
    };
    const pricingDecision = {
      pricingBasis: "POLICY",
      policyBaseAmount: { currency: "CNY", minorUnits: 20_000 },
      targetCurrentContractAmount: { currency: "CNY", minorUnits: 20_000 },
      differenceFromPolicy: { currency: "CNY", minorUnits: 0 },
      manualAdjustmentMinor: 0,
      differenceExceedsThreshold: false,
      reason: { code: "MOVE_UNIT_POLICY", note: "" }
    };
    const receipt = {
      receiptId: "receipt_move_contract",
      commandId: "command_move_contract",
      executionStatus: "EXECUTED",
      businessCommitted: true,
      correlationId: "move-unit-result-contract",
      result: {
        orderId: "order_move_contract",
        stayId: "stay_move_contract",
        amendmentId: "amendment_move_contract",
        staySegmentId: "segment_move_contract",
        pricingRevisionId: "pricing_revision_move_contract",
        effectHash: "a".repeat(64),
        businessDate: "2028-04-10",
        effectiveDate: "2028-04-11",
        before: {
          arrivalDate: "2028-04-10",
          departureDate: "2028-04-12",
          nights: 2,
          currentContractAmount: { currency: "CNY", minorUnits: 20_000 },
          stayTimeline: [
            { serviceDate: "2028-04-10", inventoryUnitId: "unit_move_contract" },
            { serviceDate: "2028-04-11", inventoryUnitId: "unit_move_contract" }
          ],
          actualCurrentInventoryUnit: null,
          effectiveDateInventoryUnit: inventoryUnit
        },
        after: {
          arrivalDate: "2028-04-10",
          departureDate: "2028-04-12",
          nights: 2,
          stayTimeline,
          pricing
        },
        pricingDecision,
        inventoryChange: {
          preservedClaims: [{ serviceDate: "2028-04-10", inventoryUnitId: "unit_move_contract" }],
          releasedClaims: [{ serviceDate: "2028-04-11", inventoryUnitId: "unit_move_contract" }],
          addedClaims: [{ serviceDate: "2028-04-11", inventoryUnitId: "unit_move_target" }]
        },
        entitlementSummary: {
          preservedCoverageDates: [],
          migratedHeldCoverageDates: [],
          consumedCoverageDates: [],
          convertedMembershipCoveragePreserved: false,
          ledgerWriteCount: 0
        },
        fundsSummary: {
          netRecordedCollection: { currency: "CNY", minorUnits: 0 },
          collectionDifference: { currency: "CNY", minorUnits: 20_000 },
          factCount: 0
        }
      },
      resourceRefs: [],
      factRefs: []
    };
    expect(Value.Check(ReceiptSchema, receipt)).toBe(true);
    expect(Value.Check(ReceiptSchema, {
      ...receipt,
      result: { ...receipt.result, unexpected: true }
    })).toBe(false);
  });

  it("requires CREATE_MEMBER previews to keep the internal member id unset", () => {
    expect(Value.Check(CommandEffectSchema, {
      operation: "CREATE_MEMBER_PROFILE",
      memberId: "member_leaked",
      member: {
        fullName: "Contract Member",
        nickname: "Contract Member",
        identityCardNumber: "CONTRACT-MEMBER-ID",
        phone: "13800000000",
        wechat: "contract-member"
      },
      propertyLink: { operation: "CREATE" }
    })).toBe(false);
  });

  it("requires SHORTEN_STAY to freeze the authoritative collection fact count", () => {
    const effect = {
      operation: "SHORTEN_STAY",
      orderId: "order_contract",
      stayId: "stay_contract",
      inventoryUnitId: "room_contract",
      businessDate: "2026-07-30",
      completionMode: "SHORTEN_IN_HOUSE",
      before: {
        arrivalDate: "2026-07-28",
        departureDate: "2026-08-02",
        nights: 5,
        currentContractAmount: { currency: "CNY", minorUnits: 58_000 },
        stayTimeline: [
          { serviceDate: "2026-07-28", inventoryUnitId: "room_contract" },
          { serviceDate: "2026-07-29", inventoryUnitId: "room_contract" },
          { serviceDate: "2026-07-30", inventoryUnitId: "room_contract" },
          { serviceDate: "2026-07-31", inventoryUnitId: "room_contract" },
          { serviceDate: "2026-08-01", inventoryUnitId: "room_contract" }
        ]
      },
      after: {
        arrivalDate: "2026-07-28",
        departureDate: "2026-07-31",
        nights: 3,
        stayTimeline: [
          { serviceDate: "2026-07-28", inventoryUnitId: "room_contract" },
          { serviceDate: "2026-07-29", inventoryUnitId: "room_contract" },
          { serviceDate: "2026-07-30", inventoryUnitId: "room_contract" }
        ],
        pricing: {
          coverageSet: [],
          cashLines: [],
          cashRemainder: { currency: "CNY", minorUnits: 34_800 },
          currentContractAmount: { currency: "CNY", minorUnits: 34_800 }
        }
      },
      pricingDecision: {
        pricingBasis: "POLICY",
        policyBaseAmount: { currency: "CNY", minorUnits: 34_800 },
        targetCurrentContractAmount: { currency: "CNY", minorUnits: 34_800 },
        differenceFromPolicy: { currency: "CNY", minorUnits: 0 },
        manualAdjustmentMinor: 0,
        differenceExceedsThreshold: false,
        reason: { code: "STAY_CHANGE_POLICY", note: "" }
      },
      inventoryChange: {
        preservedDates: ["2026-07-28", "2026-07-29", "2026-07-30"],
        releasedDates: ["2026-07-31", "2026-08-01"],
        addedDates: []
      },
      entitlementSummary: {
        currentConsumedCoverageDates: [],
        retainedHistoricalConsumedCoverageDates: [],
        restoredFutureCoverageDates: [],
        ledgerWriteCount: 0
      },
      fundsSummary: {
        netRecordedCollection: { currency: "CNY", minorUnits: 58_000 },
        collectionDifference: { currency: "CNY", minorUnits: -23_200 },
        factCount: 2
      },
      refundReferenceAmount: { currency: "CNY", minorUnits: 23_200 }
    };

    expect(Value.Check(CommandEffectSchema, effect)).toBe(true);
    expect(Value.Check(CommandEffectSchema, {
      ...effect,
      entitlementSummary: {
        currentConsumedCoverageDates: effect.entitlementSummary.currentConsumedCoverageDates,
        retainedHistoricalConsumedCoverageDates: effect.entitlementSummary.retainedHistoricalConsumedCoverageDates,
        ledgerWriteCount: effect.entitlementSummary.ledgerWriteCount
      }
    })).toBe(false);
    expect(Value.Check(CommandEffectSchema, {
      ...effect,
      before: {
        arrivalDate: effect.before.arrivalDate,
        departureDate: effect.before.departureDate,
        nights: effect.before.nights,
        currentContractAmount: effect.before.currentContractAmount
      }
    })).toBe(false);
    expect(Value.Check(CommandEffectSchema, { ...effect, businessDate: undefined })).toBe(false);
    expect(Value.Check(CommandEffectSchema, {
      ...effect,
      fundsSummary: {
        netRecordedCollection: effect.fundsSummary.netRecordedCollection,
        collectionDifference: effect.fundsSummary.collectionDifference
      }
    })).toBe(false);
    expect(Value.Check(CommandEffectSchema, {
      ...effect,
      fundsSummary: { ...effect.fundsSummary, factCount: -1 }
    })).toBe(false);
  });

  it("publishes the completed-stay CREATE_ORDER effect and receipt evidence", async () => {
    const propertyToday = todayInTimeZone("Asia/Shanghai");
    const arrivalDate = shiftLocalDate(propertyToday, -5);
    const departureDate = shiftLocalDate(propertyToday, -2);
    const reason = "契约测试补录原因";
    const priced = await quote({ arrivalDate, departureDate, inventoryUnitId: "unit_room_d_gen_01" });
    const previewResponse = await app.inject({
      method: "POST",
      url: "/api/v1/command-previews",
      headers: headers("effect-create-completed-backfill-preview"),
      payload: {
        commandType: "CREATE_ORDER",
        input: {
          propertyId: demo.propertyId,
          quoteId: priced.quoteId,
          primaryGuest: { fullName: "契约补录住客", nickname: "契约补录" },
          bookingChannelCode: "WECOM",
          channelOrderReference: null,
          targetCurrentContractAmountMinor: priced.currentContractAmount.minorUnits,
          backfill: true,
          backfillReason: reason,
          backfillCollection: {
            amountMinor: priced.currentContractAmount.minorUnits,
            method: "CASH",
            cashCollector: "契约前台",
            note: "契约现金凭据"
          }
        }
      }
    });
    expect(previewResponse.statusCode, previewResponse.body).toBe(200);
    const preview = (previewResponse.json() as { preview: Preview }).preview;
    expect(Value.Check(CommandEffectSchema, preview.effect)).toBe(true);
    expect(preview.effect.backfill).toMatchObject({
      reason,
      businessDate: propertyToday,
      resultingOrderStatus: "CHECKED_OUT",
      resultingStayStatus: "COMPLETED",
      settlementStatus: "SETTLED",
      collectedAmountMinor: priced.currentContractAmount.minorUnits,
      balanceDueMinor: 0,
      collection: { method: "CASH", cashCollector: "契约前台", note: "契约现金凭据" }
    });

    const confirmed = await app.inject({
      method: "POST",
      url: `/api/v1/command-previews/${preview.previewId}/confirm`,
      headers: headers("effect-create-completed-backfill-confirm"),
      payload: {
        propertyId: demo.propertyId,
        commandType: "CREATE_ORDER",
        confirmation: true,
        expectedEffectHash: preview.effectHash,
        reason: { code: "BACKFILL_STAY", note: reason }
      }
    });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    const receipt = confirmed.json() as { result: Record<string, unknown>; resourceRefs: string[]; factRefs: string[] };
    expect(Value.Check(ReceiptSchema, receipt)).toBe(true);
    const backfill = receipt.result.backfill as {
      checkInAmendmentId: string;
      checkOutAmendmentId: string;
      collectionFactId: string;
    };
    expect(receipt.result).toMatchObject({
      status: "CHECKED_OUT",
      backfill: {
        businessDate: propertyToday,
        checkInAmendmentId: expect.stringMatching(/^amend_/),
        checkOutAmendmentId: expect.stringMatching(/^amend_/),
        settlementStatus: "SETTLED",
        collectedAmountMinor: priced.currentContractAmount.minorUnits,
        balanceDueMinor: 0,
        collectionFactId: expect.stringMatching(/^fact_/)
      }
    });
    expect(receipt.resourceRefs).toEqual(expect.arrayContaining([backfill.checkInAmendmentId, backfill.checkOutAmendmentId]));
    expect(receipt.factRefs).toEqual([backfill.collectionFactId]);
  });

  it("publishes the cross-today in-house backfill CREATE_ORDER effect and receipt evidence", async () => {
    const propertyToday = todayInTimeZone("Asia/Shanghai");
    const arrivalDate = shiftLocalDate(propertyToday, -1);
    const departureDate = shiftLocalDate(propertyToday, 2);
    const reason = "契约测试跨今天在住补录";
    const priced = await quote({ arrivalDate, departureDate, inventoryUnitId: "unit_room_d_gen_02" });
    const previewResponse = await app.inject({
      method: "POST",
      url: "/api/v1/command-previews",
      headers: headers("effect-create-in-house-backfill-preview"),
      payload: {
        commandType: "CREATE_ORDER",
        input: {
          propertyId: demo.propertyId,
          quoteId: priced.quoteId,
          primaryGuest: { fullName: "契约在住补录住客", nickname: "契约在住" },
          bookingChannelCode: "WECOM",
          channelOrderReference: null,
          targetCurrentContractAmountMinor: priced.currentContractAmount.minorUnits,
          backfill: true,
          backfillReason: reason,
          backfillCollection: {
            amountMinor: 100,
            method: "WECOM",
            transactionReference: "WX-EFFECT-IN-HOUSE-BACKFILL"
          }
        }
      }
    });
    expect(previewResponse.statusCode, previewResponse.body).toBe(200);
    const preview = (previewResponse.json() as { preview: Preview }).preview;
    expect(Value.Check(CommandEffectSchema, preview.effect)).toBe(true);
    expect(preview.effect.backfill).toMatchObject({
      reason,
      businessDate: propertyToday,
      resultingOrderStatus: "CHECKED_IN",
      resultingStayStatus: "IN_HOUSE",
      settlementStatus: "ARREARS",
      collectedAmountMinor: 100,
      balanceDueMinor: priced.currentContractAmount.minorUnits - 100,
      collection: { method: "WECOM", transactionReference: "WX-EFFECT-IN-HOUSE-BACKFILL" }
    });

    const confirmed = await app.inject({
      method: "POST",
      url: `/api/v1/command-previews/${preview.previewId}/confirm`,
      headers: headers("effect-create-in-house-backfill-confirm"),
      payload: {
        propertyId: demo.propertyId,
        commandType: "CREATE_ORDER",
        confirmation: true,
        expectedEffectHash: preview.effectHash,
        reason: { code: "BACKFILL_STAY", note: reason }
      }
    });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    const receipt = confirmed.json() as { result: Record<string, unknown>; resourceRefs: string[]; factRefs: string[] };
    expect(Value.Check(ReceiptSchema, receipt)).toBe(true);
    const backfill = receipt.result.backfill as {
      checkInAmendmentId: string;
      checkOutAmendmentId: null;
      collectionFactId: string;
    };
    expect(receipt.result).toMatchObject({
      status: "CHECKED_IN",
      backfill: {
        businessDate: propertyToday,
        checkInAmendmentId: expect.stringMatching(/^amend_/),
        checkOutAmendmentId: null,
        settlementStatus: "ARREARS",
        collectedAmountMinor: 100,
        balanceDueMinor: priced.currentContractAmount.minorUnits - 100,
        collectionFactId: expect.stringMatching(/^fact_/)
      }
    });
    expect(receipt.resourceRefs).toEqual(expect.arrayContaining([backfill.checkInAmendmentId]));
    expect(receipt.resourceRefs).not.toContainEqual(expect.stringMatching(/^amend_backfill_check_out/));
    expect(receipt.factRefs).toEqual([backfill.collectionFactId]);
  });

  it("serializes and validates the real Preview effect for every command type", async () => {
    const propertyToday = todayInTimeZone("Asia/Shanghai");
    const covered = new Set<CommandType>();
    const capture = async (commandType: CommandType, input: Record<string, unknown>, token: string = demo.writeToken) => {
      const preview = await requestPreview(commandType, input, token);
      covered.add(commandType);
      return preview;
    };
    const captureInternalEffect = async (commandType: CommandType, input: Record<string, unknown>) => {
      const built = await buildCommandEffect(db, commandType, input);
      expect(Object.keys(built.effect).sort(), commandType).toEqual(expectedEffectKeys[commandType]);
      expect(Value.Check(CommandEffectSchema, built.effect), `${commandType}: ${JSON.stringify(built.effect)}`).toBe(true);
      covered.add(commandType);
      return built.effect as Record<string, unknown>;
    };

    const correctionMember = await capture("CREATE_MEMBER", {
      propertyId: demo.propertyId,
      fullName: "Effect Contract Member",
      nickname: "Effect Contract Member",
      identityCardNumber: "TEST-EFFECT-MEMBER-ID-001",
      phone: "13800000001",
      wechat: "effect-contract-member"
    });
    const correctionMemberId = (await confirm(correctionMember)).memberId as string;
    await capture("CORRECT_MEMBER_PROFILE", {
      propertyId: demo.propertyId,
      memberId: correctionMemberId,
      expectedPriorProfile: {
        fullName: "Effect Contract Member",
        nickname: "Effect Contract Member",
        identityCardNumber: "TEST-EFFECT-MEMBER-ID-001",
        phone: "13800000001",
        wechat: "effect-contract-member"
      },
      correctedProfile: {
        fullName: "Effect Contract Member Corrected",
        nickname: "Effect Member Corrected",
        identityCardNumber: "TEST-EFFECT-MEMBER-ID-002",
        phone: "13800000009",
        wechat: "effect-contract-member-corrected"
      },
      evidenceNote: "Effect contract verified profile evidence"
    }, demo.administratorWriteToken);
    const historicalMembershipDate = shiftLocalDate(propertyToday, -20);
    await capture("BACKFILL_HISTORICAL_MEMBERSHIP", {
      propertyId: demo.propertyId,
      memberId: correctionMemberId,
      membershipProductId: "membership_product_shared_bath_quad_v1",
      actualMembershipDate: historicalMembershipDate,
      payment: {
        amountMinor: 93_600,
        businessDate: shiftLocalDate(historicalMembershipDate, 1),
        transactionReference: "WX-EFFECT-HISTORICAL-MEMBERSHIP-001",
        note: "Effect contract historical payment evidence"
      },
      evidenceNote: "Effect contract verified historical membership evidence"
    }, demo.administratorWriteToken);

    const membershipOrder = await capture("CREATE_MEMBERSHIP_ORDER", {
      propertyId: demo.propertyId,
      memberId: correctionMemberId,
      membershipProductId: "membership_product_shared_bath_single_v1",
      agreedPriceMinor: 162000
    });
    const membershipOrderResult = await confirm(membershipOrder);
    const membershipPayment = await capture("RECORD_MEMBERSHIP_PAYMENT", {
      propertyId: demo.propertyId,
      membershipOrderId: membershipOrderResult.membershipOrderId,
      amountMinor: 100000,
      transactionReference: "WX-EFFECT-MEMBER-001"
    });
    const membershipPaymentResult = await confirm(membershipPayment);
    const correctedMembershipPayment = await capture("CORRECT_MEMBERSHIP_PAYMENT", {
      propertyId: demo.propertyId,
      membershipOrderId: membershipOrderResult.membershipOrderId,
      originalPaymentFactId: membershipPaymentResult.paymentFactId,
      correctedAmountMinor: 162000,
      correctedTransactionReference: "WX-EFFECT-MEMBER-002"
    });
    await confirm(correctedMembershipPayment);
    await capture("ACTIVATE_MEMBERSHIP_ORDER", {
      propertyId: demo.propertyId,
      membershipOrderId: membershipOrderResult.membershipOrderId
    });
    await capture("CORRECT_MEMBERSHIP_EFFECTIVE_DATE", {
      propertyId: demo.propertyId,
      membershipOrderId: demo.membershipOrderId,
      actualMembershipDate: shiftLocalDate(propertyToday, -30),
      evidenceNote: "Effect contract verified membership date evidence"
    }, demo.administratorWriteToken);

    const maintenance = await capture("LOCK_MAINTENANCE", {
      propertyId: demo.propertyId,
      inventoryUnitId: demo.secondRoomId,
      arrivalDate: "2028-03-01",
      departureDate: "2028-03-03",
      reason: "Effect contract maintenance window"
    });
    const maintenanceResult = await confirm(maintenance);
    await capture("RELEASE_MAINTENANCE", {
      propertyId: demo.propertyId,
      maintenanceLockId: maintenanceResult.maintenanceLockId
    });

    await captureInternalEffect("ADD_MEMBER_ENTITLEMENT_LOT", {
      propertyId: demo.propertyId,
      memberContractId: demo.memberContractId,
      unitKind: "ROOM_NIGHT",
      units: 1,
      expiresOn: "2029-12-31"
    });
    await captureInternalEffect("ADJUST_MEMBER_ENTITLEMENT", {
      propertyId: demo.propertyId,
      entitlementLotId: demo.roomLotId,
      quantityDelta: 1,
      adjustmentReason: "Effect contract adjustment"
    });
    await capture("CORRECT_MEMBER_ENTITLEMENT_BALANCE", {
      propertyId: demo.propertyId,
      entitlementLotId: demo.roomLotId,
      expectedAvailableBalance: 2,
      targetAvailableBalance: 3,
      adjustmentReason: "Effect contract target-balance correction"
    });

    const expiredOn = shiftLocalDate(propertyToday, -1);
    const expiryContractId = "member_contract_effect_expiry";
    const expiredLotId = "entitlement_lot_effect_expiry";
    await db.insertInto("member_contracts").values({
      id: expiryContractId,
      property_id: demo.propertyId,
      member_id: demo.memberId,
      member_name: "Effect Contract Expiry Member",
      status: "ACTIVE",
      valid_from: shiftLocalDate(propertyToday, -2),
      valid_until: propertyToday,
      version: 1
    }).execute();
    await db.insertInto("entitlement_lots").values({
      id: expiredLotId,
      contract_id: expiryContractId,
      unit_kind: "ROOM_NIGHT",
      total_units: 1,
      expires_on: expiredOn,
      version: 1
    }).execute();
    await captureInternalEffect("EXPIRE_MEMBER_ENTITLEMENT", {
      propertyId: demo.propertyId,
      entitlementLotId: expiredLotId,
      asOfDate: propertyToday
    });

    await capture("ISSUE_TOKEN", {
      propertyId: demo.propertyId,
      subjectId: demo.agentSubjectId,
      label: "Effect contract issued Token",
      accessCeiling: "READ",
      commandCeiling: [],
      expiresAt: "2029-01-01T00:00:00.000Z",
      tokenSecret: newOpaqueSecret("qtp")
    }, demo.administratorWriteToken);
    await capture("ROTATE_TOKEN", {
      propertyId: demo.propertyId,
      tokenId: "token_demo_read",
      commandCeiling: [],
      tokenSecret: newOpaqueSecret("qtp")
    }, demo.administratorWriteToken);
    await capture("REVOKE_TOKEN", {
      propertyId: demo.propertyId,
      tokenId: "token_demo_read"
    }, demo.administratorWriteToken);

    const priced = await quote({ arrivalDate: "2028-04-10", departureDate: "2028-04-14" });
    const createOrder = await capture("CREATE_ORDER", {
      propertyId: demo.propertyId,
      quoteId: priced.quoteId,
      primaryGuest: {
        fullName: "Effect Contract Guest",
        nickname: "Effect Guest",
        phone: "+86-138-0000-0000",
        documentNumber: "EFFECT-CONTRACT-001"
      },
      bookingChannelCode: "CTRIP",
      channelOrderReference: "TEST-EFFECT-ORDER-001",
      targetCurrentContractAmountMinor: priced.currentContractAmount.minorUnits
    });
    expect(createOrder.effect.primaryGuest).toEqual({
      fullName: "Effect Contract Guest",
      nickname: "Effect Guest",
      phone: "+86-138-0000-0000",
      documentNumber: "EFFECT-CONTRACT-001"
    });
    expect(createOrder.effect).toMatchObject({
      occupancyCapacity: 4,
      occupants: [{
        id: expect.stringMatching(/^occupant_/),
        ordinal: 1,
        role: "PRIMARY",
        fullName: "Effect Contract Guest",
        nickname: "Effect Guest"
      }],
      pricingDecision: {
        pricingBasis: "CHANNEL_CONTRACT",
        policyBaseAmount: priced.currentContractAmount,
        differenceFromPolicy: { currency: "CNY", minorUnits: 0 },
        manualAdjustmentMinor: 0,
        differenceExceedsThreshold: false,
        reason: { code: "CREATE_ORDER_CHANNEL_CONTRACT", note: "" }
      }
    });
    const createOrderResult = await confirm(createOrder);
    expect(createOrderResult.primaryGuest).toEqual(createOrder.effect.primaryGuest);
    expect(createOrderResult).toMatchObject({
      pricingPolicyVersionId: demo.transientPolicyId,
      pricingDecision: createOrder.effect.pricingDecision
    });
    expect(createOrderResult.occupants).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: (createOrder.effect.occupants as Array<{ id: string }>)[0]!.id,
        ordinal: 1,
        role: "PRIMARY",
        fullName: "Effect Contract Guest",
        nickname: "Effect Guest"
      })
    ]));
    const orderId = createOrderResult.orderId as string;
    await capture("MANAGE_ORDER_OCCUPANTS", {
      propertyId: demo.propertyId, orderId, action: "ADD",
      guest: { fullName: "Companion", nickname: "Companion", phone: null, documentNumber: null }
    });
    await capture("CORRECT_ORDER_OCCUPANT", {
      propertyId: demo.propertyId,
      orderId,
      occupantId: (createOrderResult.occupants as Array<{ id: string }>)[0]!.id,
      expectedPriorSnapshot: {
        fullName: "Effect Contract Guest",
        nickname: "Effect Guest",
        phone: "+86-138-0000-0000",
        documentNumber: "EFFECT-CONTRACT-001"
      },
      correctedSnapshot: {
        fullName: "Effect Contract Guest Corrected",
        nickname: "Effect Guest 2",
        phone: "+86-138-0000-0001",
        documentNumber: "EFFECT-CONTRACT-002"
      }
    }, demo.administratorWriteToken);

    const reschedule = await capture("RESCHEDULE_STAY", {
      propertyId: demo.propertyId,
      orderId,
      newArrivalDate: "2028-04-09",
      newDepartureDate: "2028-04-14",
      targetCurrentContractAmountMinor: 60_000
    });
    expect((reschedule.effect.before as { stayTimeline: unknown }).stayTimeline).toEqual([
      { serviceDate: "2028-04-10", inventoryUnitId: demo.roomId },
      { serviceDate: "2028-04-11", inventoryUnitId: demo.roomId },
      { serviceDate: "2028-04-12", inventoryUnitId: demo.roomId },
      { serviceDate: "2028-04-13", inventoryUnitId: demo.roomId }
    ]);
    expect(Value.Check(CommandEffectSchema, {
      ...reschedule.effect,
      before: { ...(reschedule.effect.before as Record<string, unknown>), stayTimeline: undefined }
    })).toBe(false);
    const rescheduleResult = await confirm(reschedule);
    expect((rescheduleResult.before as { stayTimeline: unknown }).stayTimeline).toEqual(
      (reschedule.effect.before as { stayTimeline: unknown }).stayTimeline
    );
    // SHORTEN_STAY remains readable as historical protocol but is no longer
    // previewable in 4.2: reserved changes use RESCHEDULE_STAY and checked-in
    // shortening is intentionally deferred to 4.3.
    covered.add("SHORTEN_STAY");
    await capture("MOVE_UNIT", {
      propertyId: demo.propertyId,
      orderId,
      newInventoryUnitId: demo.secondRoomId,
      effectiveDate: "2028-04-12",
      targetCurrentContractAmountMinor: priced.currentContractAmount.minorUnits,
      channelPriceDifferenceReason: "Effect contract channel amount reconfirmed"
    });
    await capture("REPRICE_ORDER", {
      propertyId: demo.propertyId,
      orderId,
      targetCurrentContractAmountMinor: 47_900
    });
    await capture("CANCEL_ORDER", { propertyId: demo.propertyId, orderId });
    await withPropertyClockForTesting(new Date("2028-04-10T12:30:00.000Z"), () => capture("MARK_NO_SHOW", {
      propertyId: demo.propertyId,
      orderId
    }));

    const memberPriced = await quote({
      arrivalDate: "2028-05-10",
      departureDate: "2028-05-12",
      inventoryUnitId: "unit_room_d_gen_01",
      memberId: demo.memberId
    });
    const memberOrder = await capture("CREATE_ORDER", {
      propertyId: demo.propertyId,
      quoteId: memberPriced.quoteId,
      primaryGuest: { fullName: "Effect Contract Member Guest", nickname: "Effect Member" }
    });
    expect(memberOrder.effect).toMatchObject({ bookingChannelCode: null, channelOrderReference: null });
    const memberOrderResult = await confirm(memberOrder);
    expect(memberOrderResult).toMatchObject({ bookingChannelCode: null, channelOrderReference: null });
    const memberOrderId = memberOrderResult.orderId as string;
    await captureInternalEffect("REFRESH_MEMBER_COVERAGE", { propertyId: demo.propertyId, orderId: memberOrderId });

    const checkInPriced = await quote({
      arrivalDate: propertyToday,
      departureDate: shiftLocalDate(propertyToday, 1),
      pricingPolicyVersionId: propertyToday.slice(0, 7) === shiftLocalDate(propertyToday, 2).slice(0, 7)
        ? demo.transientPolicyId
        : demo.publicPricingPolicyId
    });
    const checkInOrder = await capture("CREATE_ORDER", {
      propertyId: demo.propertyId,
      quoteId: checkInPriced.quoteId,
      primaryGuest: { fullName: "Effect Contract Check-in Guest", nickname: "Effect Check-in" },
      bookingChannelCode: "WECOM",
      channelOrderReference: null,
      targetCurrentContractAmountMinor: checkInPriced.currentContractAmount.minorUnits
    });
    const checkInOrderId = (await confirm(checkInOrder)).orderId as string;
    const checkIn = await capture("CHECK_IN", { propertyId: demo.propertyId, orderId: checkInOrderId });
    expect(checkIn.effect).toMatchObject({ businessDate: propertyToday, effectiveDate: propertyToday, recordingMode: "ON_SCHEDULE" });
    await confirm(checkIn);
    const collection = await capture("RECORD_COLLECTION", {
      propertyId: demo.propertyId,
      orderId: checkInOrderId,
      amountMinor: 10_000,
      method: "BANK_TRANSFER",
      transactionReference: "TEST-EFFECT-TXN-COLLECTION",
      note: "Effect contract collection"
    });
    const collectionFactId = (await confirm(collection)).factId as string;
    await capture("RECORD_REFUND", {
      propertyId: demo.propertyId,
      orderId: checkInOrderId,
      amountMinor: 1_000,
      referencesFactId: collectionFactId,
      method: "BANK_TRANSFER",
      transactionReference: "TEST-EFFECT-TXN-REFUND",
      note: "Effect contract refund"
    });
    await capture("REVERSE_FACT", {
      propertyId: demo.propertyId,
      orderId: checkInOrderId,
      reversesFactId: collectionFactId,
      note: "Effect contract reversal"
    });
    const extension = await capture("EXTEND_STAY", {
      propertyId: demo.propertyId,
      orderId: checkInOrderId,
      newDepartureDate: shiftLocalDate(propertyToday, 2)
    });
    expect((extension.effect.before as { stayTimeline: unknown }).stayTimeline).toHaveLength(1);
    expect(Value.Check(CommandEffectSchema, {
      ...extension.effect,
      before: { ...(extension.effect.before as Record<string, unknown>), stayTimeline: undefined }
    })).toBe(false);
    const extensionResult = await confirm(extension);
    expect((extensionResult.before as { stayTimeline: unknown }).stayTimeline).toEqual(
      (extension.effect.before as { stayTimeline: unknown }).stayTimeline
    );
    await capture("REVOKE_CHECK_IN", {
      propertyId: demo.propertyId,
      orderId: checkInOrderId,
      unusedRoomConfirmed: true
    });
    const checkoutPriced = await quote({
      arrivalDate: shiftLocalDate(propertyToday, -1),
      departureDate: propertyToday,
      inventoryUnitId: demo.secondRoomId
    });
    const checkoutCreationClock = new Date(`${shiftLocalDate(propertyToday, -1)}T12:00:00.000Z`);
    const checkoutOrder = await withPropertyClockForTesting(checkoutCreationClock, () => capture("CREATE_ORDER", {
      propertyId: demo.propertyId,
      quoteId: checkoutPriced.quoteId,
      primaryGuest: { fullName: "Effect Contract Checkout Guest", nickname: "Effect Checkout" },
      bookingChannelCode: "WECOM",
      channelOrderReference: null,
      targetCurrentContractAmountMinor: checkoutPriced.currentContractAmount.minorUnits
    }));
    const checkoutOrderId = (await withPropertyClockForTesting(checkoutCreationClock, () => confirm(checkoutOrder))).orderId as string;
    await withPropertyClockForTesting(new Date(`${shiftLocalDate(propertyToday, -1)}T12:00:00.000Z`), () => executeSetupCommand(
      "CHECK_IN",
      { propertyId: demo.propertyId, orderId: checkoutOrderId },
      "effect-checkout-setup-checkin"
    ));
    const checkOut = await capture("CHECK_OUT", { propertyId: demo.propertyId, orderId: checkoutOrderId });
    expect(checkOut.effect).toMatchObject({ businessDate: propertyToday, effectiveDate: propertyToday, recordingMode: "ON_SCHEDULE" });
    const checkOutResult = await confirm(checkOut);
    expect(checkOutResult).not.toHaveProperty("cleaningTaskId");
    const reversal = await capture("REVOKE_CHECK_OUT", { propertyId: demo.propertyId, orderId: checkoutOrderId }, demo.administratorWriteToken);
    expect(reversal.effect).toMatchObject({ fromStatus: "CHECKED_OUT", toStatus: "CHECKED_IN", mode: "UNDO_CHECK_OUT" });
    const checkoutOrderVersion = await db.selectFrom("orders").select("version")
      .where("id", "=", checkoutOrderId).executeTakeFirstOrThrow();
    await capture("CORRECT_HISTORICAL_STAY_ARRANGEMENTS", {
      propertyId: demo.propertyId,
      correctionSet: [{
        orderId: checkoutOrderId,
        expectedVersion: checkoutOrderVersion.version,
        target: {
          inventoryUnitId: "unit_room_103",
          arrivalDate: shiftLocalDate(propertyToday, -1),
          departureDate: propertyToday
        }
      }]
    }, demo.administratorWriteToken);

    const checkoutConflictMaintenance = await executeSetupCommand("LOCK_MAINTENANCE", {
      propertyId: demo.propertyId,
      inventoryUnitId: demo.secondRoomId,
      arrivalDate: propertyToday,
      departureDate: shiftLocalDate(propertyToday, 1),
      reason: "撤销退房冲突响应验收"
    }, "effect-checkout-conflict");
    const conflict = await app.inject({
      method: "POST",
      url: "/api/v1/command-previews",
      headers: headers("effect-checkout-conflict-preview", demo.administratorWriteToken),
      payload: { commandType: "REVOKE_CHECK_OUT", input: { propertyId: demo.propertyId, orderId: checkoutOrderId } }
    });
    expect(conflict.statusCode, conflict.body).toBe(409);
    expect(Value.Check(ErrorResponse, conflict.json())).toBe(true);
    expect(conflict.json()).toMatchObject({
      code: "INVENTORY_CONFLICT",
      details: { serviceDate: propertyToday, inventoryUnitId: demo.secondRoomId }
    });
    expect(await db.selectFrom("orders").select(["status", "version"])
      .where("id", "=", checkoutOrderId).executeTakeFirstOrThrow())
      .toEqual({ status: "CHECKED_OUT", version: checkoutOrderVersion.version });
    await executeSetupCommand("RELEASE_MAINTENANCE", {
      propertyId: demo.propertyId, maintenanceLockId: checkoutConflictMaintenance.maintenanceLockId
    }, "effect-checkout-conflict-release");

    // 逾期已预订订单完成住宿：一次补记入住与退房并按真实结算显示。
    const completeStayArrival = shiftLocalDate(propertyToday, -5);
    const completeStayDeparture = shiftLocalDate(propertyToday, -3);
    const completeStayPriced = await quote({
      arrivalDate: completeStayArrival,
      departureDate: completeStayDeparture,
      inventoryUnitId: "unit_room_305"
    });
    const completeStayCreationClock = new Date(`${completeStayArrival}T12:00:00.000Z`);
    const completeStayOrder = await withPropertyClockForTesting(completeStayCreationClock, () => capture("CREATE_ORDER", {
      propertyId: demo.propertyId,
      quoteId: completeStayPriced.quoteId,
      primaryGuest: { fullName: "Effect Contract Complete Stay Guest", nickname: "Effect Complete Stay" },
      bookingChannelCode: "WECOM",
      channelOrderReference: null,
      targetCurrentContractAmountMinor: completeStayPriced.currentContractAmount.minorUnits
    }));
    const completeStayOrderId = (await withPropertyClockForTesting(completeStayCreationClock, () => confirm(completeStayOrder))).orderId as string;
    const completeStay = await withPropertyClockForTesting(new Date(`${propertyToday}T12:00:00.000Z`), () => capture("COMPLETE_STAY", {
      propertyId: demo.propertyId,
      orderId: completeStayOrderId,
      actualStayCompletedConfirmed: true,
      reasonNote: "客人实际住过且已离店，一次补记入住与退房"
    }));
    expect(completeStay.effect).toMatchObject({
      operation: "COMPLETE_STAY",
      arrivalDate: completeStayArrival,
      departureDate: completeStayDeparture,
      businessDate: propertyToday,
      settlementStatus: "ARREARS",
      checkIn: {
        fromStatus: "RESERVED",
        toStatus: "CHECKED_IN",
        effectiveDate: completeStayArrival,
        recordingMode: "LATE_RECORDED"
      },
      checkOut: {
        fromStatus: "CHECKED_IN",
        toStatus: "CHECKED_OUT",
        effectiveDate: completeStayDeparture,
        recordingMode: "LATE_RECORDED"
      }
    });
    expect(Object.keys(completeStay.effect).sort()).toEqual(expectedEffectKeys.COMPLETE_STAY);
    expect(Value.Check(CommandEffectSchema, completeStay.effect)).toBe(true);
    const completeStayConfirmation = await withPropertyClockForTesting(
      new Date(`${propertyToday}T12:00:00.000Z`),
      () => confirmReceipt(completeStay)
    );
    const completeStayResult = completeStayConfirmation.receipt.result;
    expect(completeStayResult).toMatchObject({
      orderId: completeStayOrderId,
      status: "CHECKED_OUT",
      settlementStatus: "ARREARS",
      effectHash: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
    const completeStayReferences = completeStayResult as {
      stayId: string;
      checkInAmendmentId: string;
      checkOutAmendmentId: string;
    };
    expect(completeStayConfirmation.receipt.resourceRefs).toEqual(expect.arrayContaining([
      completeStayOrderId,
      completeStayReferences.stayId,
      completeStayReferences.checkInAmendmentId,
      completeStayReferences.checkOutAmendmentId
    ]));

    const recoveredCompleteStay = await app.inject({
      method: "GET",
      url: `/api/v1/command-results?propertyId=${demo.propertyId}&commandType=COMPLETE_STAY&idempotencyKey=${encodeURIComponent(completeStayConfirmation.idempotencyKey)}`,
      headers: { authorization: `Bearer ${demo.writeToken}` }
    });
    expect(recoveredCompleteStay.statusCode, recoveredCompleteStay.body).toBe(200);
    expect(recoveredCompleteStay.json()).toMatchObject({
      receiptId: completeStayConfirmation.receipt.receiptId,
      commandId: completeStayConfirmation.receipt.commandId,
      result: {
        orderId: completeStayOrderId,
        effectHash: completeStayResult.effectHash
      },
      resourceRefs: expect.arrayContaining([
        completeStayOrderId,
        completeStayReferences.stayId,
        completeStayReferences.checkInAmendmentId,
        completeStayReferences.checkOutAmendmentId
      ])
    });

    const disabledBackfill = await app.inject({
      method: "POST",
      url: "/api/v1/command-previews",
      headers: headers("effect-backfill-disabled"),
      payload: {
        commandType: "BACKFILL_COMPLETED_STAY",
        input: { propertyId: demo.propertyId, orderId }
      }
    });
    expect(disabledBackfill.statusCode, disabledBackfill.body).toBe(400);
    const backfillArrivalDate = shiftLocalDate(propertyToday, -4);
    const backfillDepartureDate = shiftLocalDate(propertyToday, -2);
    const historicalBackfillEffect = {
      operation: "BACKFILL_COMPLETED_STAY",
      orderId,
      stayId: "stay_historical_backfill",
      inventoryUnitId: demo.roomId,
      arrivalDate: backfillArrivalDate,
      departureDate: backfillDepartureDate,
      businessDate: propertyToday,
      amounts: {
        currentContractAmount: { currency: "CNY", minorUnits: 0 },
        netRecordedCollection: { currency: "CNY", minorUnits: 0 },
        collectionDifference: { currency: "CNY", minorUnits: 0 },
        refundReferenceAmount: { currency: "CNY", minorUnits: 0 }
      },
      checkIn: {
        orderId,
        fromStatus: "RESERVED",
        toStatus: "CHECKED_IN",
        inventoryUnitId: demo.roomId,
        businessDate: propertyToday,
        effectiveDate: backfillArrivalDate,
        recordingMode: "LATE_RECORDED",
        entitlementTransition: { from: "HELD", to: "CONSUMED", coverageCount: 0 }
      },
      checkOut: {
        orderId,
        fromStatus: "CHECKED_IN",
        toStatus: "CHECKED_OUT",
        inventoryUnitId: demo.roomId,
        businessDate: propertyToday,
        effectiveDate: backfillDepartureDate,
        recordingMode: "LATE_RECORDED"
      },
      entitlementTransition: { from: "HELD", to: "CONSUMED", coverageCount: 0 },
      collection: null
    };
    expect(Value.Check(CommandEffectSchema, historicalBackfillEffect)).toBe(true);
    expect(Object.keys(historicalBackfillEffect).sort()).toEqual([
      "amounts", "arrivalDate", "businessDate", "checkIn", "checkOut", "collection", "departureDate",
      "entitlementTransition", "inventoryUnitId", "operation", "orderId", "stayId"
    ]);

    const conversionMember = await capture("CREATE_MEMBER", {
      propertyId: demo.propertyId,
      fullName: "Effect Contract Conversion Member",
      nickname: "Effect Contract Conversion Member",
      identityCardNumber: "TEST-EFFECT-CONVERSION-ID-001",
      phone: "13800000002",
      wechat: "effect-contract-conversion"
    });
    const conversionMemberId = (await confirm(conversionMember)).memberId as string;
    const conversionArrivalDate = shiftLocalDate(propertyToday, -1);
    const conversionDepartureDate = propertyToday;
    const conversionPriced = await quote({
      arrivalDate: conversionArrivalDate,
      departureDate: conversionDepartureDate,
      inventoryUnitId: "unit_room_d_gen_01"
    });
    const conversionCreationClock = new Date(`${conversionArrivalDate}T12:00:00.000Z`);
    const conversionOrder = await withPropertyClockForTesting(conversionCreationClock, () => capture("CREATE_ORDER", {
      propertyId: demo.propertyId,
      quoteId: conversionPriced.quoteId,
      primaryGuest: {
        fullName: "Effect Contract Conversion Guest",
        nickname: "Effect Conversion",
        phone: "13800000002",
        documentNumber: "TEST-EFFECT-CONVERSION-ID-001"
      },
      bookingChannelCode: "WECOM",
      channelOrderReference: null,
      targetCurrentContractAmountMinor: conversionPriced.currentContractAmount.minorUnits
    }));
    const conversionOrderId = (await withPropertyClockForTesting(conversionCreationClock, () => confirm(conversionOrder))).orderId as string;
    await withPropertyClockForTesting(new Date(`${conversionArrivalDate}T12:00:00.000Z`), () => executeSetupCommand(
      "CHECK_IN",
      { propertyId: demo.propertyId, orderId: conversionOrderId },
      "effect-conversion-setup-checkin"
    ));
    await executeSetupCommand(
      "CHECK_OUT",
      { propertyId: demo.propertyId, orderId: conversionOrderId },
      "effect-conversion-setup-checkout"
    );
    const conversionCollection = await capture("RECORD_COLLECTION", {
      propertyId: demo.propertyId,
      orderId: conversionOrderId,
      amountMinor: 59_000,
      method: "WECOM",
      transactionReference: "WX-EFFECT-CONVERSION-SOURCE-001",
      note: "Effect contract conversion source"
    });
    const conversionCollectionFactId = (await confirm(conversionCollection)).factId as string;
    const conversion = await capture("CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP", {
      propertyId: demo.propertyId,
      orderId: conversionOrderId,
      memberId: conversionMemberId,
      membershipProductId: "membership_product_shared_bath_single_v1",
      collectionFactIds: [conversionCollectionFactId],
      agreedPriceMinor: 162_000,
      remainingPaymentTransactionReference: "WX-EFFECT-CONVERSION-REMAINING-001"
    });
    expect(conversion.effect).toMatchObject({
      operation: "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP",
      transfer: { total: { currency: "CNY", minorUnits: 59_000 } },
      membershipPricing: { agreedPrice: { currency: "CNY", minorUnits: 162_000 } },
      remainingPayment: { amount: { currency: "CNY", minorUnits: 103_000 } },
      entitlement: { consumedUnits: 1, remainingUnits: 29 }
    });
    const conversionResult = await confirm(conversion);
    expect(conversionResult).toMatchObject({
      orderId: conversionOrderId,
      status: "ACTIVE",
      transferredCollectionFactIds: [conversionCollectionFactId],
      convertedUnits: 1,
      remainingUnits: 29,
      effectHash: expect.stringMatching(/^[a-f0-9]{64}$/)
    });

    // 零收款订单升级：空转入列表，会员费全额作为差额收款。
    const zeroCollectionPriced = await quote({
      arrivalDate: conversionArrivalDate,
      departureDate: conversionDepartureDate,
      inventoryUnitId: "unit_room_305"
    });
    const zeroCollectionOrder = await withPropertyClockForTesting(conversionCreationClock, () => capture("CREATE_ORDER", {
      propertyId: demo.propertyId,
      quoteId: zeroCollectionPriced.quoteId,
      primaryGuest: {
        fullName: "Effect Contract Zero Collection Guest",
        nickname: "Effect Zero Collection",
        phone: "13800000002",
        documentNumber: "TEST-EFFECT-CONVERSION-ID-001"
      },
      bookingChannelCode: "WECOM",
      channelOrderReference: null,
      targetCurrentContractAmountMinor: zeroCollectionPriced.currentContractAmount.minorUnits
    }));
    const zeroCollectionOrderId = (await withPropertyClockForTesting(conversionCreationClock, () => confirm(zeroCollectionOrder))).orderId as string;
    await withPropertyClockForTesting(new Date(`${conversionArrivalDate}T12:00:00.000Z`), () => executeSetupCommand(
      "CHECK_IN",
      { propertyId: demo.propertyId, orderId: zeroCollectionOrderId },
      "effect-zero-conversion-setup-checkin"
    ));
    const zeroConversion = await capture("CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP", {
      propertyId: demo.propertyId,
      orderId: zeroCollectionOrderId,
      memberId: conversionMemberId,
      membershipProductId: "membership_product_shared_bath_single_v1",
      collectionFactIds: [],
      agreedPriceMinor: 162_000,
      remainingPaymentTransactionReference: "WX-EFFECT-CONVERSION-ZERO-001"
    });
    expect(zeroConversion.effect).toMatchObject({
      operation: "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP",
      transfer: { total: { currency: "CNY", minorUnits: 0 }, collections: [] },
      remainingPayment: {
        amount: { currency: "CNY", minorUnits: 162_000 },
        transactionReference: "WX-EFFECT-CONVERSION-ZERO-001"
      }
    });
    const zeroConversionResult = await confirm(zeroConversion);
    expect(zeroConversionResult).toMatchObject({
      orderId: zeroCollectionOrderId,
      status: "ACTIVE",
      transferredCollectionFactIds: [],
      transferredAmount: { currency: "CNY", minorUnits: 0 },
      remainingPaymentAmount: { currency: "CNY", minorUnits: 162_000 }
    });

    const voidMember = await capture("CREATE_MEMBER", {
      propertyId: demo.propertyId,
      fullName: "Effect Contract Void Member",
      nickname: "Effect Void Member",
      identityCardNumber: "TEST-EFFECT-VOID-ID-001",
      phone: "13800000003",
      wechat: "effect-contract-void"
    });
    const voidMemberId = (await confirm(voidMember)).memberId as string;
    const voidSourceArrivalDate = shiftLocalDate(propertyToday, -10);
    const voidSourceDepartureDate = shiftLocalDate(propertyToday, -8);
    const voidSourceQuote = await quote({
      arrivalDate: voidSourceArrivalDate,
      departureDate: voidSourceDepartureDate,
      inventoryUnitId: demo.bedAId
    });
    const voidBackfillReason = "Effect contract verified completed stay";
    const { preview: voidSourceOrder } = await createCommandPreviewDirect(db, directPrincipal, {
      commandType: "CREATE_ORDER",
      input: {
        propertyId: demo.propertyId,
        quoteId: voidSourceQuote.quoteId,
        primaryGuest: {
          fullName: "Effect Contract Void Member",
          nickname: "Effect Void Member",
          phone: "13800000003",
          documentNumber: "TEST-EFFECT-VOID-ID-001"
        },
        bookingChannelCode: "WECOM",
        channelOrderReference: null,
        targetCurrentContractAmountMinor: voidSourceQuote.currentContractAmount.minorUnits,
        backfill: true,
        backfillReason: voidBackfillReason,
        backfillCollection: {
          amountMinor: voidSourceQuote.currentContractAmount.minorUnits,
          method: "WECOM",
          transactionReference: "WX-EFFECT-VOID-SOURCE-STAY-001"
        }
      }
    }, metadata("effect-void-source-preview"));
    expect(Value.Check(CommandEffectSchema, voidSourceOrder.effect)).toBe(true);
    const voidSourceReceipt = await confirmCommandPreviewDirect(db, directPrincipal, voidSourceOrder.previewId, {
      propertyId: demo.propertyId,
      commandType: "CREATE_ORDER",
      confirmation: true,
      expectedEffectHash: voidSourceOrder.effectHash,
      reason: { code: "BACKFILL_STAY", note: voidBackfillReason }
    }, metadata("effect-void-source-confirm"));
    const voidSourceOrderId = voidSourceReceipt.result!.orderId as string;
    const erroneousMembershipOrder = await capture("CREATE_MEMBERSHIP_ORDER", {
      propertyId: demo.propertyId,
      memberId: voidMemberId,
      membershipProductId: "membership_product_shared_bath_quad_v1",
      agreedPriceMinor: 93_600
    });
    const erroneousMembershipOrderId = (await confirm(erroneousMembershipOrder)).membershipOrderId as string;
    const erroneousMembershipPayment = await capture("RECORD_MEMBERSHIP_PAYMENT", {
      propertyId: demo.propertyId,
      membershipOrderId: erroneousMembershipOrderId,
      amountMinor: 93_600,
      transactionReference: "WX-EFFECT-VOID-OLD-DIRECT-001"
    });
    await confirm(erroneousMembershipPayment);
    const erroneousMembershipActivation = await capture("ACTIVATE_MEMBERSHIP_ORDER", {
      propertyId: demo.propertyId,
      membershipOrderId: erroneousMembershipOrderId
    });
    await confirm(erroneousMembershipActivation);
    await capture("VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY", {
      propertyId: demo.propertyId,
      erroneousMembershipOrderId,
      sourceStayOrderId: voidSourceOrderId,
      actualMembershipDate: voidSourceArrivalDate,
      replacementDirectPayment: {
        businessDate: shiftLocalDate(voidSourceArrivalDate, 1),
        transactionReference: "WX-EFFECT-VOID-RECLASSIFIED-001"
      },
      evidenceNote: "Effect contract verified erroneous membership reconstruction"
    }, demo.administratorWriteToken);
    const adminLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "admin", password: "demo-pass-2026" }
    });
    expect(adminLogin.statusCode).toBe(200);
    const adminSession = adminLogin.cookies.find((entry) => entry.name === "qintopia_session");
    expect(adminSession).toBeDefined();
    sequence += 1;
    const disabledCleaning = await app.inject({
      method: "POST",
      url: "/api/v1/command-previews",
      cookies: { qintopia_session: adminSession!.value },
      headers: {
        "content-type": "application/json",
        "idempotency-key": `effect-complete-cleaning-disabled-${sequence}`,
        "x-correlation-id": `effect-complete-cleaning-disabled-${sequence}`
      },
      payload: {
        commandType: "COMPLETE_CLEANING",
        input: { propertyId: demo.propertyId, cleaningTaskId: "cleaning_historical" }
      }
    });
    expect(disabledCleaning.statusCode, disabledCleaning.body).toBe(403);
    expect(disabledCleaning.json()).toMatchObject({
      code: "INSUFFICIENT_ACCESS",
      message: "Command feature is disabled in this release"
    });
    const historicalCleaningEffect = {
      cleaningTaskId: "cleaning_historical",
      orderId,
      stayId: "stay_historical",
      inventoryUnitId: demo.roomId,
      roomId: demo.roomId,
      serviceDate: "2026-07-26",
      fromStatus: "PENDING",
      toStatus: "COMPLETED"
    };
    expect(Value.Check(CommandEffectSchema, historicalCleaningEffect)).toBe(true);
    expect(Object.keys(historicalCleaningEffect).sort()).toEqual(expectedEffectKeys.COMPLETE_CLEANING);
    covered.add("COMPLETE_CLEANING");

    const catalogResponse = await app.inject({ method: "POST", url: "/api/v1/command-previews",
      cookies: { qintopia_session: adminSession!.value },
      headers: { "idempotency-key": "effect-room-catalog", "x-correlation-id": "effect-room-catalog" },
      payload: { commandType: "MANAGE_ROOM_CATALOG", input: { propertyId: demo.propertyId, expectedVersion: 0,
        action: "SAVE_TYPE", name: "契约房型", bathroom: "PRIVATE", saleMode: "ROOM", bedCount: 2, capacity: 2 } } });
    expect(catalogResponse.statusCode, catalogResponse.body).toBe(200);
    const catalogEffect = catalogResponse.json().preview.effect;
    expect(Object.keys(catalogEffect).sort()).toEqual(expectedEffectKeys.MANAGE_ROOM_CATALOG);
    expect(Value.Check(CommandEffectSchema, catalogEffect)).toBe(true);
    covered.add("MANAGE_ROOM_CATALOG");
    expect([...covered].sort()).toEqual([...commandTypes].sort());
  }, 120_000);
});
