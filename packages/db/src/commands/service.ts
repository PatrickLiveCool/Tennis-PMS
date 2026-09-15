import { sql, type Kysely, type Transaction } from "kysely";
import {
  currentReleaseFeatures,
  DomainError,
  commandTypes,
  type AuthPrincipal,
  type CommandEnvelope,
  type CommandReason,
  type CommandType,
  type CreateQuoteCommandInputDto,
  type CreateQuoteCommandResponseDto,
  type ErrorDto,
  type HistoricalRecoverableCommandType,
  type PreviewDto,
  type QuoteReadDto,
  type ReceiptDto,
  type StoredQuoteDto
} from "@qintopia/contracts";
import { amountSummary, enumerateServiceDates, newId, paidStayTypeForNights, sha256, stableHash } from "@qintopia/domain";
import { createQuoteInTransaction, loadStoredQuote, projectQuoteForExternalRead } from "../pricing-service.ts";
import { bumpRoomStatusRevision } from "../room-status.ts";
import { bindExternalPayments, type ExternalPaymentBasis } from "../external-payments.ts";
import { getOrderViewSnapshot, loadTemporaryOtherRoomCreateEvidence } from "../orders.ts";
import {
  maskIdentityCardNumber,
  maskPhone,
  maskWechat,
  sampleAuthoritativePropertyWallClock,
  withPropertyOperationClockSnapshot
} from "../members.ts";
import type { Database } from "../schema.ts";
import {
  HISTORICAL_STAY_ARRANGEMENT_CORRECTION_COMMAND,
  normalizeHistoricalStayArrangementCorrectionInput
} from "../admin-historical-stay-corrections.ts";
import {
  historicalProtocolEpochMigration,
  legacyEffectProtocol,
  legacyReceiptProtocol,
  type HistoricalProtocolVersion
} from "../historical-command-protocol.ts";
import {
  auditCommandResourceNotFound,
  authorizeCommandAccess,
  baseCommandCatalogType,
  effectiveSubjectCommandGrants,
  isCommandAuthorizationError,
  throwCommandAuthorizationDenial,
  withCommandAuthorizationAudit,
  type CommandAuthorizationStage,
  type CommandAuthorizationTokenLifecycleConstraint
} from "../command-authorization.ts";
import { applyCommand, lockCommandResources } from "./apply.ts";
import { buildCommandEffect, normalizePhoneNumber, projectCommandEffectForRead, projectPrimaryGuestForRead } from "./effects.ts";
import { isMemberCorrectionCommandType, normalizeMemberCorrectionInput } from "./member-corrections.ts";

export interface ConfirmRequest {
  propertyId: string;
  commandType: CommandType;
  confirmation: boolean;
  expectedEffectHash: string;
  reason: CommandReason;
}

export interface UnknownCommandResult {
  commandId?: string;
  executionStatus: "UNKNOWN";
  businessCommitted: false;
  correlationId?: string;
}

export interface ResolveCommandResultRequest {
  propertyId: string;
  commandType: HistoricalRecoverableCommandType;
  idempotencyKey: string;
}

export type ReceiptReadDto = ReceiptDto & {
  protocolVersion?: HistoricalProtocolVersion;
  recoveryMode?: "HISTORICAL_READ_ONLY";
};

class HistoricalPreviewReadOnlyError extends DomainError {
  constructor() {
    super("PREVIEW_STALE", "Historical previews are read-only; request a new preview", 409);
  }
}

class ConfirmationIdentityMismatchError extends DomainError {
  constructor() {
    super("CONFIRMATION_MISMATCH", "Confirmed property or command type does not match the preview", 409);
  }
}

type ExecutableCommandType = (typeof commandTypes)[number];

function isExecutableCommandType(commandType: string): commandType is ExecutableCommandType {
  return (commandTypes as readonly string[]).includes(commandType);
}

const roomStatusVisibleCommands = new Set<CommandType>([
  "MANAGE_ROOM_CATALOG",
  "REVOKE_CHECK_OUT",
  "CREATE_ORDER",
  "CORRECT_ORDER_OCCUPANT",
  "MANAGE_ORDER_OCCUPANTS",
  "CORRECT_HISTORICAL_STAY_ARRANGEMENTS",
  "RESCHEDULE_STAY",
  "SHORTEN_STAY",
  "EXTEND_STAY",
  "MOVE_UNIT",
  "REPRICE_ORDER",
  "RECORD_COLLECTION",
  "RECORD_REFUND",
  "REVERSE_FACT",
  "REFRESH_MEMBER_COVERAGE",
  "CANCEL_ORDER",
  "MARK_NO_SHOW",
  "REVOKE_CHECK_IN",
  "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP",
  "VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY",
  "CHECK_IN",
  "CHECK_OUT",
  "COMPLETE_STAY",
  "LOCK_MAINTENANCE",
  "RELEASE_MAINTENANCE",
  "COMPLETE_CLEANING"
]);

const createOrderConfirmationReasonCodes = new Set([
  "CREATE_STANDARD_ORDER",
  "BACKFILL_STAY",
  "TEMPORARY_OTHER_ROOM"
]);

const strictRecoveryEvidenceCommands = new Set<CommandType>([
  "MANAGE_ORDER_OCCUPANTS",
  "REVOKE_CHECK_OUT",
  "RESCHEDULE_STAY",
  "EXTEND_STAY",
  "SHORTEN_STAY",
  "MOVE_UNIT",
  "CANCEL_ORDER",
  "MARK_NO_SHOW",
  "REVOKE_CHECK_IN",
  "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP",
  "COMPLETE_STAY",
  "CORRECT_HISTORICAL_STAY_ARRANGEMENTS",
  "CORRECT_MEMBER_PROFILE",
  "CORRECT_MEMBERSHIP_EFFECTIVE_DATE",
  "BACKFILL_HISTORICAL_MEMBERSHIP",
  "VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY"
]);

function requiresStrictRecoveryEvidence(commandType: CommandType, effect: Record<string, unknown>): boolean {
  return strictRecoveryEvidenceCommands.has(commandType)
    || asRecord(effect.temporaryOtherRoomArrangement) !== undefined
    || (commandType === "CREATE_ORDER" && (
      asRecord(effect.backfill) !== undefined
    ));
}

async function lockCommandProtocolEpoch(trx: Transaction<Database>): Promise<void> {
  await sql`select pg_advisory_xact_lock_shared(hashtextextended('qintopia:protocol-epoch', 0::bigint))`.execute(trx);
}

function assertWriteMetadata(idempotencyKey: string | undefined, correlationId: string | undefined): { idempotencyKey: string; correlationId: string } {
  if (!idempotencyKey?.trim()) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key header is required", 400);
  if (!correlationId?.trim()) throw new DomainError("CORRELATION_ID_REQUIRED", "X-Correlation-ID header is required", 400);
  if (idempotencyKey.length > 160 || correlationId.length > 160) throw new DomainError("VALIDATION_ERROR", "Command metadata is too long");
  return { idempotencyKey: idempotencyKey.trim(), correlationId: correlationId.trim() };
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function strictStoredStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)
    || value.some((entry) => typeof entry !== "string" || entry.trim() === "")
    || new Set(value).size !== value.length) {
    throw new Error(`Persisted complete-stay ${field} is malformed`);
  }
  return value as string[];
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

export function projectStayMembershipConversionResultEvidenceForRead(
  result: Record<string, unknown>,
  ledger: ReadonlyArray<{ fact_id: string; coverage_id: string | null }>
): Record<string, unknown> {
  const ledgerFactIds = strictStoredStringArray(result.conversionLedgerFactIds, "conversion ledger evidence");
  const coverageIds = strictStoredStringArray(result.conversionCoverageIds, "conversion coverage evidence");
  const convertedUnits = result.convertedUnits;
  if (!Number.isSafeInteger(convertedUnits) || Number(convertedUnits) < 1) {
    throw new Error("Persisted stay-membership conversion unit evidence is malformed");
  }
  const persistedLedgerFactIds = ledger.map((fact) => fact.fact_id);
  if (ledger.length !== convertedUnits || !sameStringSet(persistedLedgerFactIds, ledgerFactIds)) {
    throw new Error("Persisted stay-membership conversion ledger differs from its receipt");
  }
  const nonNullCoverageIds = ledger.flatMap((fact) => fact.coverage_id === null ? [] : [fact.coverage_id]);
  const conversionMode = nonNullCoverageIds.length === ledger.length
    ? "IN_HOUSE"
    : nonNullCoverageIds.length === 0
      ? "COMPLETED"
      : undefined;
  if (!conversionMode || !sameStringSet(nonNullCoverageIds, coverageIds)) {
    throw new Error("Persisted stay-membership conversion coverage differs from its receipt");
  }
  if (Object.hasOwn(result, "conversionMode") && result.conversionMode !== conversionMode) {
    throw new Error("Persisted stay-membership conversion mode differs from its ledger");
  }
  return Object.hasOwn(result, "conversionMode") ? result : { ...result, conversionMode };
}

async function projectStayMembershipConversionResultForRead(
  db: Kysely<Database> | Transaction<Database>,
  commandId: string,
  result: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const ledger = await db.selectFrom("entitlement_ledger")
    .select(["fact_id", "coverage_id"])
    .where("command_id", "=", commandId)
    .where("entry_type", "=", "CONVERSION_CONSUME")
    .orderBy("fact_id")
    .execute();
  return projectStayMembershipConversionResultEvidenceForRead(result, ledger);
}

const completeStayExternalChannelCodes = new Set(["YOUMUDAO", "CTRIP", "MEITUAN"]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function assertCreateOrderConfirmationReason(effect: Record<string, unknown>, reason: CommandReason): void {
  const backfill = asRecord(effect.backfill);
  if (backfill) {
    const lockedReason = typeof backfill.reason === "string" ? backfill.reason.trim() : "";
    if (!lockedReason
      || reason.code !== "BACKFILL_STAY"
      || reason.note.trim() !== lockedReason) {
      throw new DomainError(
        "CONFIRMATION_MISMATCH",
        "补录确认原因必须与核对页锁定的原因一致",
        409
      );
    }
    return;
  }

  const temporaryOtherRoomArrangement = asRecord(effect.temporaryOtherRoomArrangement);
  if (temporaryOtherRoomArrangement) {
    const lockedReason = typeof effect.temporaryOtherRoomReason === "string"
      ? effect.temporaryOtherRoomReason.trim()
      : "";
    if (!lockedReason
      || lockedReason.length > 200
      || reason.code !== "TEMPORARY_OTHER_ROOM"
      || reason.note !== lockedReason) {
      throw new DomainError(
        "CONFIRMATION_MISMATCH",
        "临时安排确认原因必须与核对页锁定的原因一致",
        409
      );
    }
    return;
  }

  if (reason.code !== "CREATE_STANDARD_ORDER" || reason.note !== "") {
    throw new DomainError("CONFIRMATION_MISMATCH", "普通创建订单必须使用标准建单确认原因", 409);
  }
}

async function historicalProtocolEpoch(
  db: Kysely<Database> | Transaction<Database>,
  protocolVersion: HistoricalProtocolVersion
): Promise<Date> {
  const migrationName = historicalProtocolEpochMigration(protocolVersion);
  const migration = await db.selectFrom("schema_migrations")
    .select("applied_at")
    .where("name", "=", migrationName)
    .executeTakeFirst();
  if (!migration) {
    throw new DomainError("INTERNAL_ERROR", `Historical protocol epoch ${migrationName} is unavailable`, 500);
  }
  return asDate(migration.applied_at);
}

async function assertHistoricalReadPredatesProtocolEpoch(
  db: Kysely<Database> | Transaction<Database>,
  protocolVersion: HistoricalProtocolVersion,
  createdAt: Date | string,
  resource: string
): Promise<void> {
  const epoch = await historicalProtocolEpoch(db, protocolVersion);
  if (asDate(createdAt).getTime() >= epoch.getTime()) {
    throw new DomainError("INTERNAL_ERROR", `${resource} uses ${protocolVersion} after its protocol epoch`, 500);
  }
}

async function bindPersistedEffectHash(
  trx: Transaction<Database>,
  commandId: string,
  commandType: CommandType,
  confirmedEffect: Record<string, unknown>,
  rebuiltEffectHash: string
): Promise<string> {
  if (commandType === "CORRECT_HISTORICAL_STAY_ARRANGEMENTS") {
    const corrections = await trx.selectFrom("historical_stay_arrangement_corrections")
      .innerJoin("amendments", "amendments.id", "historical_stay_arrangement_corrections.amendment_id")
      .select([
        "historical_stay_arrangement_corrections.order_id",
        "historical_stay_arrangement_corrections.stay_id",
        "historical_stay_arrangement_corrections.expected_version",
        "amendments.payload"
      ])
      .where("historical_stay_arrangement_corrections.created_by_command_id", "=", commandId)
      .orderBy("historical_stay_arrangement_corrections.order_id")
      .execute();
    const authoritativeCorrections = corrections.map((correction) => {
      const payload = asRecord(correction.payload);
      const after = asRecord(payload?.after);
      if (!payload || !after) throw new Error("Persisted historical stay correction payload is malformed");
      const { pricing: _pricing, ...arrangementAfter } = after;
      return {
        orderId: correction.order_id,
        stayId: correction.stay_id,
        expectedVersion: correction.expected_version,
        before: payload.before,
        after: arrangementAfter,
        unchanged: payload.unchanged
      };
    });
    const authoritativeEffect = {
      operation: "CORRECT_HISTORICAL_STAY_ARRANGEMENTS",
      corrections: authoritativeCorrections
    };
    if (authoritativeCorrections.length === 0
      || stableHash(authoritativeEffect) !== stableHash(confirmedEffect)) {
      throw new Error("Persisted historical stay correction set differs from the confirmed Preview");
    }
    return rebuiltEffectHash;
  }
  if (commandType === "CORRECT_MEMBER_PROFILE") {
    const correction = await trx.selectFrom("member_profile_corrections")
      .selectAll()
      .where("command_id", "=", commandId)
      .executeTakeFirst();
    if (!correction) throw new Error("Persisted member profile correction is missing");
    const authoritativeEffect = {
      operation: "CORRECT_MEMBER_PROFILE",
      memberId: correction.member_id,
      before: {
        fullName: correction.prior_full_name,
        nickname: correction.prior_nickname,
        identityCardNumber: correction.prior_identity_card_number,
        phone: correction.prior_phone,
        wechat: correction.prior_wechat
      },
      after: {
        fullName: correction.corrected_full_name,
        nickname: correction.corrected_nickname,
        identityCardNumber: correction.corrected_identity_card_number,
        phone: correction.corrected_phone,
        wechat: correction.corrected_wechat
      },
      changedFields: correction.changed_fields,
      evidenceNote: correction.evidence_note
    };
    if (stableHash(authoritativeEffect) !== stableHash(confirmedEffect)) {
      throw new Error("Persisted member profile correction differs from the confirmed Preview");
    }
    return rebuiltEffectHash;
  }
  if (commandType === "CORRECT_MEMBERSHIP_EFFECTIVE_DATE") {
    const correction = await trx.selectFrom("membership_effective_date_corrections")
      .selectAll()
      .where("command_id", "=", commandId)
      .executeTakeFirst();
    const before = asRecord(confirmedEffect.before);
    const after = asRecord(confirmedEffect.after);
    if (!correction || !before || !after
      || confirmedEffect.operation !== commandType
      || confirmedEffect.memberId !== correction.member_id
      || confirmedEffect.membershipOrderId !== correction.membership_order_id
      || confirmedEffect.contractId !== correction.contract_id
      || confirmedEffect.entitlementLotId !== correction.entitlement_lot_id
      || confirmedEffect.evidenceNote !== correction.evidence_note
      || before.validFrom !== correction.prior_valid_from
      || before.validUntil !== correction.prior_valid_until
      || after.validFrom !== correction.corrected_valid_from
      || after.validUntil !== correction.corrected_valid_until) {
      throw new Error("Persisted membership effective-date correction differs from the confirmed Preview");
    }
    return rebuiltEffectHash;
  }
  if (commandType === "BACKFILL_HISTORICAL_MEMBERSHIP") {
    const backfill = await trx.selectFrom("historical_membership_backfills")
      .innerJoin("members", "members.id", "historical_membership_backfills.member_id")
      .innerJoin("membership_payment_facts", "membership_payment_facts.fact_id", "historical_membership_backfills.payment_fact_id")
      .select([
        "historical_membership_backfills.member_id",
        "historical_membership_backfills.actual_membership_date",
        "historical_membership_backfills.valid_until",
        "historical_membership_backfills.product_id",
        "historical_membership_backfills.product_code",
        "historical_membership_backfills.product_version",
        "historical_membership_backfills.product_name",
        "historical_membership_backfills.listed_price_minor",
        "historical_membership_backfills.agreed_price_minor",
        "historical_membership_backfills.currency",
        "historical_membership_backfills.entitlement_unit_kind",
        "historical_membership_backfills.entitlement_units",
        "historical_membership_backfills.validity_period",
        "historical_membership_backfills.allowed_room_type_code",
        "historical_membership_backfills.allowed_inventory_kind",
        "historical_membership_backfills.evidence_note",
        "members.full_name",
        "membership_payment_facts.amount_minor",
        "membership_payment_facts.business_date",
        "membership_payment_facts.transaction_reference",
        "membership_payment_facts.note"
      ])
      .where("historical_membership_backfills.command_id", "=", commandId)
      .executeTakeFirst();
    if (!backfill) throw new Error("Persisted historical membership backfill is missing");
    const authoritativeEffect = {
      operation: commandType,
      evidenceNote: backfill.evidence_note,
      member: { memberId: backfill.member_id, fullName: backfill.full_name },
      product: {
        productId: backfill.product_id,
        code: backfill.product_code,
        version: backfill.product_version,
        name: backfill.product_name,
        listedPrice: { currency: backfill.currency, minorUnits: backfill.listed_price_minor },
        agreedPrice: { currency: backfill.currency, minorUnits: backfill.agreed_price_minor },
        entitlementUnitKind: backfill.entitlement_unit_kind,
        entitlementUnits: backfill.entitlement_units,
        validityPeriod: backfill.validity_period,
        allowedRoomTypeCode: backfill.allowed_room_type_code,
        allowedInventoryKind: backfill.allowed_inventory_kind
      },
      payment: {
        amount: { currency: backfill.currency, minorUnits: backfill.amount_minor },
        businessDate: backfill.business_date,
        transactionReference: backfill.transaction_reference,
        note: backfill.note
      },
      validFrom: backfill.actual_membership_date,
      validUntil: backfill.valid_until,
      entitlementUnitKind: backfill.entitlement_unit_kind,
      entitlementUnits: backfill.entitlement_units,
      status: "ACTIVE"
    };
    if (stableHash(authoritativeEffect) !== stableHash(confirmedEffect)) {
      throw new Error("Persisted historical membership backfill differs from the confirmed Preview");
    }
    return rebuiltEffectHash;
  }
  if (commandType === "VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY") {
    const correction = await trx.selectFrom("membership_void_reconversions")
      .selectAll()
      .where("command_id", "=", commandId)
      .executeTakeFirst();
    const member = asRecord(confirmedEffect.member);
    const oldMembership = asRecord(confirmedEffect.oldMembership);
    const sourceStay = asRecord(confirmedEffect.sourceStay);
    const newMembership = asRecord(confirmedEffect.newMembership);
    if (!correction || !member || !oldMembership || !sourceStay || !newMembership
      || confirmedEffect.operation !== commandType
      || member.memberId !== correction.member_id
      || oldMembership.membershipOrderId !== correction.old_membership_order_id
      || oldMembership.contractId !== correction.old_contract_id
      || oldMembership.entitlementLotId !== correction.old_entitlement_lot_id
      || sourceStay.orderId !== correction.source_order_id
      || sourceStay.stayId !== correction.source_stay_id
      || newMembership.validFrom !== correction.actual_membership_date
      || newMembership.validUntil !== correction.valid_until
      || confirmedEffect.evidenceNote !== correction.evidence_note) {
      throw new Error("Persisted membership void and reconversion differs from the confirmed Preview");
    }
    return rebuiltEffectHash;
  }
  const amendments = await trx.selectFrom("amendments")
    .select(["id", "reason_code", "reason_note", "payload"])
    .where("command_id", "=", commandId)
    .where("amendment_type", "=", commandType)
    .execute();
  if (commandType === "COMPLETE_STAY") {
    const fulfillment = await trx.selectFrom("amendments")
      .select([
        "id",
        "order_id",
        "sequence",
        "amendment_type",
        "reason_code",
        "reason_note",
        "prior_version",
        "new_version",
        "payload"
      ])
      .where("command_id", "=", commandId)
      .orderBy("sequence")
      .execute();
    const effectOrderId = typeof confirmedEffect.orderId === "string" ? confirmedEffect.orderId : null;
    const effectStayId = typeof confirmedEffect.stayId === "string" ? confirmedEffect.stayId : null;
    const reasonNote = typeof confirmedEffect.reasonNote === "string" ? confirmedEffect.reasonNote : null;
    if (fulfillment.length !== 2
      || fulfillment[0]!.amendment_type !== "CHECK_IN"
      || fulfillment[1]!.amendment_type !== "CHECK_OUT"
      || !effectOrderId
      || !effectStayId
      || !reasonNote
      || fulfillment.some((amendment) => amendment.order_id !== effectOrderId
        || amendment.reason_code !== "COMPLETE_STAY"
        || amendment.reason_note !== reasonNote)
      || fulfillment[1]!.sequence !== fulfillment[0]!.sequence + 1
      || fulfillment[0]!.prior_version !== fulfillment[0]!.sequence - 1
      || fulfillment[0]!.new_version !== fulfillment[0]!.sequence
      || fulfillment[1]!.prior_version !== fulfillment[0]!.new_version
      || fulfillment[1]!.new_version !== fulfillment[1]!.sequence) {
      throw new Error("Complete-stay effect does not have the authoritative CHECK_IN and CHECK_OUT amendments");
    }
    const persistedCheckIn = asRecord(fulfillment[0]!.payload);
    const persistedCheckOut = asRecord(fulfillment[1]!.payload);
    const confirmedCheckIn = asRecord(confirmedEffect.checkIn);
    const confirmedCheckOut = asRecord(confirmedEffect.checkOut);
    if (!persistedCheckIn || !persistedCheckOut || !confirmedCheckIn || !confirmedCheckOut
      || stableHash(persistedCheckIn) !== stableHash(confirmedCheckIn)
      || stableHash(persistedCheckOut) !== stableHash(confirmedCheckOut)) {
      throw new Error("Persisted complete-stay effect differs from the confirmed Preview");
    }

    const orderState = await trx.selectFrom("orders")
      .innerJoin("stays", "stays.order_id", "orders.id")
      .innerJoin("pricing_revisions", "pricing_revisions.id", "orders.current_revision_id")
      .select([
        "orders.status as order_status",
        "orders.version as order_version",
        "orders.stay_type",
        "orders.booking_channel_code",
        "orders.channel_order_reference",
        "orders.member_id",
        "orders.member_contract_id",
        "orders.current_revision_id",
        "stays.id as stay_id",
        "stays.status as stay_status",
        "pricing_revisions.current_contract_amount_minor",
        "pricing_revisions.currency",
        "pricing_revisions.pricing_basis"
      ])
      .where("orders.id", "=", effectOrderId)
      .executeTakeFirst();
    if (!orderState
      || orderState.stay_id !== effectStayId
      || orderState.order_status !== "CHECKED_OUT"
      || orderState.stay_status !== "COMPLETED"
      || orderState.order_version !== fulfillment[1]!.new_version) {
      throw new Error("Persisted complete-stay order or Stay state differs from the confirmed effect");
    }

    const lifecycle = await getOrderViewSnapshot(trx, effectOrderId);
    if (lifecycle.order.status !== "CHECKED_OUT"
      || lifecycle.stay.status !== "COMPLETED"
      || lifecycle.fulfillment.checkIn?.reason.code !== "COMPLETE_STAY"
      || lifecycle.fulfillment.checkOut?.reason.code !== "COMPLETE_STAY"
      || lifecycle.fulfillment.checkIn.reason.note !== reasonNote
      || lifecycle.fulfillment.checkOut.reason.note !== reasonNote) {
      throw new Error("Persisted complete-stay lifecycle does not match the confirmed effect");
    }

    const inventoryRelease = asRecord(confirmedEffect.inventoryRelease);
    const expectedClaimIds = strictStoredStringArray(inventoryRelease?.claimIds, "Claim evidence");
    if (!inventoryRelease
      || !Number.isSafeInteger(inventoryRelease.claimCount)
      || inventoryRelease.claimCount !== expectedClaimIds.length) {
      throw new Error("Persisted complete-stay Claim evidence is malformed");
    }
    const segmentIds = (await trx.selectFrom("stay_segments")
      .select("id")
      .where("stay_id", "=", effectStayId)
      .orderBy("sequence")
      .execute()).map((segment) => segment.id);
    const claims = await trx.selectFrom("inventory_claims")
      .select(["id", "active", "released_at"])
      .where("source_type", "=", "ORDER_SEGMENT")
      .where("source_id", "in", segmentIds)
      .orderBy("id")
      .execute();
    const releasedClaimIds = claims
      .filter((claim) => !claim.active && claim.released_at !== null && expectedClaimIds.includes(claim.id))
      .map((claim) => claim.id);
    if (!sameStringSet(releasedClaimIds, expectedClaimIds) || claims.some((claim) => claim.active)) {
      throw new Error("Persisted complete-stay Claim releases differ from the confirmed effect");
    }

    const entitlementTransition = asRecord(confirmedEffect.entitlementTransition);
    const expectedCoverageIds = strictStoredStringArray(entitlementTransition?.coverageIds, "coverage evidence");
    if (!entitlementTransition
      || entitlementTransition.from !== "HELD"
      || entitlementTransition.to !== "CONSUMED"
      || !Number.isSafeInteger(entitlementTransition.coverageCount)
      || entitlementTransition.coverageCount !== expectedCoverageIds.length) {
      throw new Error("Persisted complete-stay coverage evidence is malformed");
    }
    const coverage = await trx.selectFrom("coverage_items")
      .select(["id", "status"])
      .where("order_id", "=", effectOrderId)
      .orderBy("id")
      .execute();
    const consumedCoverageIds = coverage.filter((item) => item.status === "CONSUMED").map((item) => item.id);
    const entitlementFacts = await trx.selectFrom("entitlement_ledger")
      .select(["entry_type", "quantity_delta", "order_id", "coverage_id", "reason"])
      .where("command_id", "=", commandId)
      .orderBy("fact_id")
      .execute();
    if (!sameStringSet(consumedCoverageIds, expectedCoverageIds)
      || coverage.some((item) => item.status === "HELD")
      || entitlementFacts.length !== expectedCoverageIds.length
      || entitlementFacts.some((fact) => fact.entry_type !== "CONSUME"
        || fact.quantity_delta !== 0
        || fact.order_id !== effectOrderId
        || fact.coverage_id === null
        || !expectedCoverageIds.includes(fact.coverage_id)
        || fact.reason !== "CHECK_IN_ENTITLEMENT_CONSUMED")) {
      throw new Error("Persisted complete-stay entitlement results differ from the confirmed effect");
    }

    const collectionFacts = await trx.selectFrom("collection_facts")
      .selectAll()
      .where("order_id", "=", effectOrderId)
      .orderBy("created_at")
      .orderBy("fact_id")
      .execute();
    const commandCollections = collectionFacts.filter((fact) => fact.command_id === commandId);
    const confirmedCollection = confirmedEffect.collection === null
      ? null
      : asRecord(confirmedEffect.collection);
    if (confirmedEffect.collection === null) {
      if (commandCollections.length !== 0) {
        throw new Error("Persisted complete-stay unexpectedly appended a collection fact");
      }
    } else {
      if (!confirmedCollection) {
        throw new Error("Persisted complete-stay collection effect is malformed");
      }
      const expectedAmountMinor = confirmedCollection.amountMinor;
      const expectedCurrency = confirmedCollection.currency;
      const expectedMethod = confirmedCollection.method;
      const expectedReference = typeof confirmedCollection.transactionReference === "string"
        ? confirmedCollection.transactionReference
        : null;
      const expectedCollector = typeof confirmedCollection.cashCollector === "string"
        ? confirmedCollection.cashCollector
        : null;
      const expectedNote = typeof confirmedCollection.note === "string" ? confirmedCollection.note : null;
      const persistedCollection = commandCollections[0];
      if (commandCollections.length !== 1
        || !persistedCollection
        || !Number.isSafeInteger(expectedAmountMinor)
        || typeof expectedCurrency !== "string"
        || typeof expectedMethod !== "string"
        || expectedNote === null
        || persistedCollection.fact_type !== "COLLECTION"
        || persistedCollection.amount_minor !== expectedAmountMinor
        || persistedCollection.net_effect_minor !== expectedAmountMinor
        || persistedCollection.currency !== expectedCurrency
        || persistedCollection.method !== expectedMethod
        || persistedCollection.transaction_reference !== expectedReference
        || persistedCollection.cash_collector !== expectedCollector
        || persistedCollection.note !== expectedNote
        || persistedCollection.pricing_revision_id !== orderState.current_revision_id) {
        throw new Error("Persisted complete-stay collection differs from the confirmed effect");
      }
    }

    if (collectionFacts.some((fact) => fact.currency !== orderState.currency)) {
      throw new Error("Persisted complete-stay collection currency is inconsistent");
    }
    const persistedAmounts = amountSummary(
      orderState.currency,
      orderState.current_contract_amount_minor,
      collectionFacts.map((fact) => fact.net_effect_minor)
    );
    const confirmedAmounts = asRecord(confirmedEffect.amounts);
    const isExternalChannel = Boolean(orderState.booking_channel_code
      && completeStayExternalChannelCodes.has(orderState.booking_channel_code));
    const specialSettlement = orderState.stay_type === "FREE"
      || Boolean(orderState.member_id || orderState.member_contract_id)
      || isExternalChannel;
    const expectedSettlementStatus = specialSettlement
      || persistedAmounts.netRecordedCollection.minorUnits >= orderState.current_contract_amount_minor
      ? "SETTLED"
      : "ARREARS";
    if (!confirmedAmounts
      || stableHash(confirmedAmounts) !== stableHash(persistedAmounts)
      || confirmedEffect.settlementStatus !== expectedSettlementStatus
      || (specialSettlement && collectionFacts.length > 0)
      || (isExternalChannel && (orderState.pricing_basis !== "CHANNEL_CONTRACT"
        || !orderState.channel_order_reference?.trim()
        || orderState.current_contract_amount_minor <= 0))) {
      throw new Error("Persisted complete-stay settlement differs from the confirmed effect");
    }
    const cleaningTask = await trx.selectFrom("cleaning_tasks")
      .select("id")
      .where("order_id", "=", effectOrderId)
      .executeTakeFirst();
    if (cleaningTask) {
      throw new Error("Persisted complete-stay unexpectedly created a cleaning task");
    }
    return rebuiltEffectHash;
  }
  if (amendments.length !== 1) {
    throw new Error("Command effect does not have one authoritative amendment");
  }
  const persistedEffect = asRecord(amendments[0]!.payload);
  if (!persistedEffect) {
    throw new Error("Persisted command effect is malformed");
  }
  if (commandType === "CREATE_ORDER" && asRecord(confirmedEffect.temporaryOtherRoomArrangement)) {
    const amendment = amendments[0]!;
    const inventoryUnit = asRecord(confirmedEffect.inventoryUnit);
    const lockedReason = typeof confirmedEffect.temporaryOtherRoomReason === "string"
      ? confirmedEffect.temporaryOtherRoomReason.trim()
      : "";
    const authoritativeEffect = {
      quoteId: confirmedEffect.quoteId,
      inventoryUnitId: inventoryUnit?.id,
      arrivalDate: confirmedEffect.arrivalDate,
      departureDate: confirmedEffect.departureDate,
      primaryGuest: confirmedEffect.primaryGuest,
      occupants: Array.isArray(confirmedEffect.occupants)
        ? confirmedEffect.occupants.map((value) => {
          const occupant = asRecord(value);
          return {
            id: occupant?.id,
            ordinal: occupant?.ordinal,
            role: occupant?.role,
            fullName: occupant?.fullName,
            nickname: occupant?.nickname,
            phone: typeof occupant?.phone === "string" && occupant.phone.trim() ? occupant.phone.trim() : null,
            documentNumber: typeof occupant?.documentNumber === "string" && occupant.documentNumber.trim()
              ? occupant.documentNumber.trim()
              : null
          };
        })
        : confirmedEffect.occupants,
      bookingChannelCode: confirmedEffect.bookingChannelCode,
      channelOrderReference: confirmedEffect.channelOrderReference,
      freeStayReason: confirmedEffect.freeStayReason,
      freeStayCategoryCode: confirmedEffect.freeStayCategoryCode,
      temporaryOtherRoomArrangement: confirmedEffect.temporaryOtherRoomArrangement,
      pricingDecision: confirmedEffect.pricingDecision
    };
    if (!inventoryUnit?.id
      || !lockedReason
      || lockedReason.length > 200
      || amendment.reason_code !== "TEMPORARY_OTHER_ROOM"
      || amendment.reason_note !== lockedReason
      || stableHash(persistedEffect) !== stableHash(authoritativeEffect)) {
      throw new Error("Persisted temporary other-room create-order evidence differs from the confirmed Preview");
    }
    return rebuiltEffectHash;
  }
  const authoritativeEffect = commandType === "CREATE_ORDER" && asRecord(confirmedEffect.backfill)
    ? asRecord(persistedEffect.confirmedEffect)
    : persistedEffect;
  if (!authoritativeEffect || stableHash(authoritativeEffect) !== stableHash(confirmedEffect)) {
    throw new Error("Persisted command effect differs from the confirmed Preview");
  }
  return rebuiltEffectHash;
}

export async function projectStoredPreviewForRead(
  db: Kysely<Database> | Transaction<Database>,
  preview: {
    command_type: string;
    effect: unknown;
    created_at: Date | string;
    [key: string]: unknown;
  }
): Promise<Record<string, unknown>> {
  const response = {
    id: preview.id,
    property_id: preview.property_id,
    command_type: preview.command_type,
    input_hash: preview.input_hash,
    effect: preview.effect,
    effect_hash: preview.effect_hash,
    expires_at: preview.expires_at,
    status: preview.status,
    created_at: preview.created_at,
    used_at: preview.used_at
  };
  const effect = asRecord(preview.effect);
  if (!effect) return response;
  const projectedEffect = projectCommandEffectForRead(preview.command_type, effect);
  await assertTemporaryOtherRoomEvidenceForRead(db, preview.command_type, projectedEffect);
  const protocolVersion = legacyEffectProtocol(preview.command_type, projectedEffect);
  if (!protocolVersion) return { ...response, effect: projectedEffect };
  await assertHistoricalReadPredatesProtocolEpoch(db, protocolVersion, preview.created_at, "Stored preview");
  return {
    ...response,
    effect: projectedEffect,
    protocolVersion,
    recoveryMode: "HISTORICAL_READ_ONLY",
    confirmable: false
  };
}

function isTokenLifecycleCommand(commandType: string): boolean {
  const baseType = commandType.startsWith("PREVIEW:") ? commandType.slice("PREVIEW:".length) : commandType;
  return baseType === "ISSUE_TOKEN" || baseType === "ROTATE_TOKEN" || baseType === "REVOKE_TOKEN";
}

function tokenLifecycleAuthorizationConstraint(
  commandType: CommandType,
  input: Record<string, unknown>
): CommandAuthorizationTokenLifecycleConstraint | undefined {
  if (commandType === "ISSUE_TOKEN") {
    return {
      kind: "ISSUE_TOKEN",
      subjectId: input.subjectId,
      accessCeiling: input.accessCeiling,
      commandCeiling: input.commandCeiling,
      expiresAt: input.expiresAt
    };
  }

  if (commandType === "ROTATE_TOKEN") {
    return {
      kind: "ROTATE_TOKEN",
      tokenId: input.tokenId,
      commandCeiling: input.commandCeiling,
      expiresAt: input.expiresAt
    };
  }

  if (commandType === "REVOKE_TOKEN") {
    return {
      kind: "REVOKE_TOKEN",
      tokenId: input.tokenId
    };
  }

  return undefined;
}

async function assertTokenExpiryCeiling(
  db: Kysely<Database> | Transaction<Database>,
  principal: AuthPrincipal,
  propertyId: string,
  commandType: CommandType,
  effect: Record<string, unknown>,
  attempt: { stage: CommandAuthorizationStage; idempotencyKey: string | undefined; correlationId: string | undefined }
): Promise<void> {
  if (principal.credentialType !== "TOKEN" || (commandType !== "ISSUE_TOKEN" && commandType !== "ROTATE_TOKEN")) return;
  if (typeof effect.expiresAt !== "string") throw new DomainError("INTERNAL_ERROR", "Token command effect has no expiry", 500);
  const caller = await db.selectFrom("api_tokens")
    .select("expires_at")
    .where("id", "=", principal.credentialId)
    .where("subject_id", "=", principal.subjectId)
    .executeTakeFirst();
  if (!caller) {
    return throwCommandAuthorizationDenial({
      principal,
      propertyId,
      commandType,
      ...attempt,
      denialReason: "TOKEN_INVALID",
      message: "Bearer token is invalid",
      code: "AUTHENTICATION_REQUIRED",
      statusCode: 401
    });
  }
  if (Date.parse(effect.expiresAt) > asDate(caller.expires_at).getTime()) {
    return throwCommandAuthorizationDenial({
      principal,
      propertyId,
      commandType,
      ...attempt,
      denialReason: "TOKEN_EXPIRY_CEILING_EXCEEDED",
      message: "A Token cannot issue or rotate a Token beyond its own expiry"
    });
  }
}

function strictEffectStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)
    || value.some((entry) => typeof entry !== "string" || entry.trim() === "")
    || new Set(value).size !== value.length) {
    throw new DomainError("INTERNAL_ERROR", `${field} is malformed`, 500);
  }
  return value as string[];
}

async function assertTokenCommandCeiling(
  trx: Transaction<Database>,
  principal: AuthPrincipal,
  propertyId: string,
  commandType: CommandType,
  effect: Record<string, unknown>,
  attempt: { stage: CommandAuthorizationStage; idempotencyKey: string | undefined; correlationId: string | undefined }
): Promise<void> {
  if (commandType !== "ISSUE_TOKEN" && commandType !== "ROTATE_TOKEN") return;
  const commandCeiling = strictEffectStringArray(effect.commandCeiling, "Token command ceiling");
  const persistedCommandCeiling = strictEffectStringArray(
    effect.persistedCommandCeiling,
    "Persisted Token command ceiling"
  );
  const commandCeilingSet = new Set(commandCeiling);
  const callerEffectiveCommands = await effectiveSubjectCommandGrants(trx, principal, propertyId);
  if (persistedCommandCeiling.length !== commandCeiling.length
    || persistedCommandCeiling.some((candidate) => !commandCeilingSet.has(candidate))
    || persistedCommandCeiling.some((candidate) => !callerEffectiveCommands.has(candidate))) {
    return throwCommandAuthorizationDenial({
      principal,
      propertyId,
      commandType,
      ...attempt,
      denialReason: "TOKEN_COMMAND_CEILING_ESCALATION",
      message: "Persisted Token command ceiling must equal the explicit ceiling and remain within the caller's current command scope"
    });
  }
}

const opaqueTokenSecret = /^qtp_[A-Za-z0-9_-]{43}$/;

function normalizeCommandEnvelope(envelope: CommandEnvelope): CommandEnvelope {
  if (envelope.commandType === "CREATE_ORDER") {
    const primaryGuest = envelope.input.primaryGuest;
    if (!primaryGuest || typeof primaryGuest !== "object" || Array.isArray(primaryGuest)) return envelope;
    const normalizedGuest = { ...(primaryGuest as Record<string, unknown>) };
    for (const field of ["fullName", "nickname", "phone", "documentNumber"] as const) {
      const value = normalizedGuest[field];
      if (typeof value === "string") normalizedGuest[field] = value.trim();
    }
    const additionalGuests = Array.isArray(envelope.input.additionalGuests)
      ? envelope.input.additionalGuests.map((guest) => {
        if (!guest || typeof guest !== "object" || Array.isArray(guest)) return guest;
        const normalized = { ...(guest as Record<string, unknown>) };
        for (const field of ["fullName", "nickname", "phone", "documentNumber"] as const) {
          const value = normalized[field];
          if (typeof value === "string") normalized[field] = value.trim();
        }
        return normalized;
      })
      : envelope.input.additionalGuests;
    return {
      commandType: envelope.commandType,
      input: {
        ...envelope.input,
        primaryGuest: normalizedGuest,
        ...(additionalGuests !== undefined ? { additionalGuests } : {})
      }
    };
  }
  if (envelope.commandType === "CREATE_MEMBER") {
    const trim = (field: string, uppercase = false) => {
      const value = envelope.input[field];
      if (typeof value !== "string") return value;
      const normalized = value.trim();
      return uppercase ? normalized.toUpperCase() : normalized;
    };
    return {
      commandType: envelope.commandType,
      input: {
        ...envelope.input,
        fullName: trim("fullName"),
        nickname: trim("nickname"),
        identityCardNumber: trim("identityCardNumber", true),
        phone: typeof envelope.input.phone === "string" ? normalizePhoneNumber(envelope.input.phone) : envelope.input.phone,
        wechat: trim("wechat")
      }
    };
  }
  if (isMemberCorrectionCommandType(envelope.commandType)) {
    return {
      commandType: envelope.commandType,
      input: normalizeMemberCorrectionInput(envelope.commandType, envelope.input)
    };
  }
  if (envelope.commandType === HISTORICAL_STAY_ARRANGEMENT_CORRECTION_COMMAND) {
    return {
      commandType: envelope.commandType,
      input: normalizeHistoricalStayArrangementCorrectionInput(envelope.input)
    };
  }
  if (envelope.commandType !== "ISSUE_TOKEN" && envelope.commandType !== "ROTATE_TOKEN") return envelope;
  const value = envelope.input.tokenSecret;
  if (typeof value !== "string" || !opaqueTokenSecret.test(value) || new Set(value.slice(4)).size < 16) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "tokenSecret must be a 256-bit qtp_ base64url secret generated by a cryptographically secure random source"
    );
  }
  const { tokenSecret: _discardedSecret, ...safeInput } = envelope.input;
  return { commandType: envelope.commandType, input: { ...safeInput, tokenSecretHash: sha256(value) } };
}

function freezeCreateOrderOccupantIds(commandType: CommandType, input: Record<string, unknown>): Record<string, unknown> {
  if (commandType !== "CREATE_ORDER") return input;
  const additionalCount = Array.isArray(input.additionalGuests) ? input.additionalGuests.length : 0;
  return {
    ...input,
    _occupantIds: Array.from({ length: additionalCount + 1 }, () => newId("occupant"))
  };
}

function executionLockKey(subjectId: string, propertyId: string, commandType: string, idempotencyKey: string): string {
  return `qintopia:command:${subjectId}:${propertyId}:${commandType}:${idempotencyKey}`;
}

type CommandAuthorizationOptions = Parameters<typeof authorizeCommandAccess>[3];
type BusyExecutionAuthorizationGuard = (connection: Kysely<Database>) => Promise<void>;

function busyExecutionAuthorizationGuard(
  auditDb: Kysely<Database>,
  principal: AuthPrincipal,
  options: CommandAuthorizationOptions
): BusyExecutionAuthorizationGuard {
  return (connection) => connection.transaction().setIsolationLevel("repeatable read").execute((trx) => (
    authorizeCommandAccess(auditDb, trx, principal, options)
  ));
}

async function withExecutionLock<T>(
  db: Kysely<Database>,
  lockKey: string,
  work: (connection: Kysely<Database>) => Promise<T>,
  authorizeWhenBusy?: BusyExecutionAuthorizationGuard
): Promise<T> {
  return db.connection().execute(async (connection) => {
    const lockResult = await sql<{ acquired: boolean }>`
      select pg_try_advisory_lock(hashtextextended(${lockKey}, 0::bigint)) as acquired
    `.execute(connection);
    if (!lockResult.rows[0]?.acquired) {
      if (authorizeWhenBusy) await authorizeWhenBusy(connection);
      throw new DomainError("COMMAND_STATUS_UNKNOWN", "Another request is executing this command", 409, true);
    }
    try {
      return await work(connection);
    } finally {
      await sql`select pg_advisory_unlock(hashtextextended(${lockKey}, 0::bigint))`.execute(connection);
    }
  });
}

async function withQuoteQuotaLock<T>(
  connection: Kysely<Database>,
  quotaLockKey: string,
  work: () => Promise<T>
): Promise<T> {
  const quotaLock = await sql<{ acquired: boolean }>`
    select pg_try_advisory_lock(hashtextextended(${quotaLockKey}, 0::bigint)) as acquired
  `.execute(connection);
  if (!quotaLock.rows[0]?.acquired) {
    throw new DomainError("RATE_LIMITED", "Another quote request is updating this subject's property quota", 429, true);
  }
  try {
    return await work();
  } finally {
    await sql`select pg_advisory_unlock(hashtextextended(${quotaLockKey}, 0::bigint))`.execute(connection);
  }
}

async function existingQuoteCommand(
  db: Kysely<Database>,
  principal: AuthPrincipal,
  propertyId: string,
  idempotencyKey: string,
  requestHash: string,
  correlationId: string | undefined
): Promise<CreateQuoteCommandResponseDto | undefined> {
  return db.transaction().setIsolationLevel("repeatable read").execute(async (trx) => {
    await authorizeCommandAccess(db, trx, principal, {
      propertyId,
      commandType: "CREATE_QUOTE",
      stage: "REPLAY",
      idempotencyKey,
      correlationId,
      mode: "READ"
    });
    const replay = await replayOrConflict(trx, {
      subjectId: principal.subjectId,
      propertyId,
      commandType: "CREATE_QUOTE",
      idempotencyKey,
      requestHash
    });
    if (!replay) return undefined;
    return { quote: quoteFromReceipt(replay), receipt: replay };
  });
}

function temporaryOtherRoomRecoveryError(message: string): DomainError {
  return new DomainError("INTERNAL_ERROR", `临时安排恢复证据${message}`, 500);
}

async function assertTemporaryOtherRoomCreatePreviewEvidence(
  db: Kysely<Database> | Transaction<Database>,
  effect: Record<string, unknown>
): Promise<void> {
  const arrangement = asRecord(effect.temporaryOtherRoomArrangement);
  const inventoryUnit = asRecord(effect.inventoryUnit);
  const requiredArrangementFields = [
    "membershipOrderId",
    "memberContractId",
    "entitlementLotId",
    "originalRoomTypeCode",
    "actualInventoryUnitId",
    "actualRoomTypeCode",
    "arrivalDate",
    "departureDate"
  ] as const;
  const reason = typeof effect.temporaryOtherRoomReason === "string"
    ? effect.temporaryOtherRoomReason.trim()
    : "";
  const arrangementArrivalDate = typeof arrangement?.arrivalDate === "string" ? arrangement.arrivalDate : "";
  const arrangementDepartureDate = typeof arrangement?.departureDate === "string" ? arrangement.departureDate : "";
  if (!arrangement
    || Object.keys(arrangement).length !== 12
    || arrangement.kind !== "TEMPORARY_OTHER_ROOM"
    || arrangement.originalInventoryKind !== "ROOM"
    || arrangement.entitlementUnitKind !== "ROOM_NIGHT"
    || arrangement.actualInventoryKind !== "ROOM"
    || requiredArrangementFields.some((field) => (
      typeof arrangement[field] !== "string" || (arrangement[field] as string).trim() === ""
    ))
    || arrangement.originalRoomTypeCode === arrangement.actualRoomTypeCode
    || arrangementDepartureDate <= arrangementArrivalDate
    || !reason
    || reason.length > 200
    || typeof effect.memberId !== "string"
    || effect.memberId.trim() === ""
    || effect.memberContractId !== arrangement.memberContractId
    || inventoryUnit?.id !== arrangement.actualInventoryUnitId
    || inventoryUnit?.kind !== "ROOM"
    || inventoryUnit?.roomTypeCode !== arrangement.actualRoomTypeCode
    || effect.arrivalDate !== arrangementArrivalDate
    || effect.departureDate !== arrangementDepartureDate) {
    throw temporaryOtherRoomRecoveryError("已损坏");
  }
  const quoteId = typeof effect.quoteId === "string" && effect.quoteId.trim() !== "" ? effect.quoteId : null;
  if (!quoteId) throw temporaryOtherRoomRecoveryError("缺少原报价");
  let quote: Awaited<ReturnType<typeof loadStoredQuote>>;
  try {
    quote = await loadStoredQuote(db, quoteId, false);
  } catch {
    throw temporaryOtherRoomRecoveryError("无法核对原报价");
  }
  if (!quote.temporaryOtherRoomArrangement
    || stableHash(arrangement) !== stableHash(quote.temporaryOtherRoomArrangement)
    || quote.memberId !== effect.memberId
    || quote.memberContractId !== effect.memberContractId
    || quote.inventoryUnitId !== inventoryUnit?.id
    || quote.arrivalDate !== effect.arrivalDate
    || quote.departureDate !== effect.departureDate) {
    throw temporaryOtherRoomRecoveryError("与原报价不一致");
  }
}

async function assertTemporaryOtherRoomEvidenceForRead(
  db: Kysely<Database> | Transaction<Database>,
  commandType: string,
  value: Record<string, unknown>
): Promise<void> {
  const previewCommandType = commandType.startsWith("PREVIEW:")
    ? commandType.slice("PREVIEW:".length)
    : null;
  const preview = previewCommandType ? asRecord(value.preview) : undefined;
  const target = previewCommandType ? asRecord(preview?.effect) : value;
  if (!target) return;

  const hasArrangement = Object.hasOwn(target, "temporaryOtherRoomArrangement");
  const hasCreateAmendmentId = Object.hasOwn(target, "temporaryOtherRoomCreateAmendmentId");
  const effectiveCommandType = previewCommandType ?? commandType;
  const orderId = typeof target.orderId === "string" && target.orderId.trim() !== ""
    ? target.orderId
    : null;

  if (effectiveCommandType === "CREATE_ORDER" && !orderId) {
    if (!hasArrangement && !hasCreateAmendmentId) {
      if (Object.hasOwn(target, "temporaryOtherRoomReason")) {
        throw temporaryOtherRoomRecoveryError("不完整");
      }
      const quoteId = typeof target.quoteId === "string" && target.quoteId.trim() !== ""
        ? target.quoteId
        : null;
      if (quoteId) {
        try {
          const quote = await loadStoredQuote(db, quoteId, false);
          if (quote.temporaryOtherRoomArrangement) throw temporaryOtherRoomRecoveryError("缺少安排快照");
        } catch (error) {
          if (error instanceof DomainError && error.code === "INTERNAL_ERROR") throw error;
        }
      }
      return;
    }
    if (!hasArrangement || hasCreateAmendmentId) throw temporaryOtherRoomRecoveryError("不完整");
    await assertTemporaryOtherRoomCreatePreviewEvidence(db, target);
    return;
  }

  if (!orderId) {
    if (hasArrangement || hasCreateAmendmentId) throw temporaryOtherRoomRecoveryError("缺少所属订单");
    return;
  }

  const authoritative = await loadTemporaryOtherRoomCreateEvidence(db, orderId);
  if (!authoritative) {
    if (hasArrangement || hasCreateAmendmentId) {
      throw temporaryOtherRoomRecoveryError("与订单创建记录不一致");
    }
    return;
  }
  const arrangement = asRecord(target.temporaryOtherRoomArrangement);
  if (!hasArrangement
    || !hasCreateAmendmentId
    || !arrangement
    || target.temporaryOtherRoomCreateAmendmentId !== authoritative.createAmendmentId
    || stableHash(arrangement) !== stableHash(authoritative.arrangement)) {
    throw temporaryOtherRoomRecoveryError("与订单创建记录不一致");
  }
}

async function assertTemporaryOtherRoomQuoteReceiptEvidenceForRead(
  db: Kysely<Database> | Transaction<Database>,
  result: Record<string, unknown>
): Promise<void> {
  const receiptQuote = asRecord(result.quote);
  const quoteId = typeof receiptQuote?.quoteId === "string" && receiptQuote.quoteId.trim() !== ""
    ? receiptQuote.quoteId
    : null;
  if (!receiptQuote || !quoteId) return;
  let authoritative: Awaited<ReturnType<typeof loadStoredQuote>>;
  try {
    authoritative = await loadStoredQuote(db, quoteId, false);
  } catch {
    return;
  }
  if (!authoritative.temporaryOtherRoomArrangement
    && !Object.hasOwn(receiptQuote, "temporaryOtherRoomArrangement")) return;
  if (stableHash(receiptQuote) !== stableHash(projectQuoteForExternalRead(authoritative))) {
    throw temporaryOtherRoomRecoveryError("与原报价不一致");
  }
}

async function receiptByCommand(
  db: Kysely<Database> | Transaction<Database>,
  commandId: string,
  readMode: "STRICT_CURRENT" | "HISTORICAL_READ" = "STRICT_CURRENT"
): Promise<ReceiptReadDto | undefined> {
  const row = await db.selectFrom("command_receipts")
    .innerJoin("command_executions", "command_executions.id", "command_receipts.command_id")
    .select([
      "command_receipts.id", "command_receipts.command_id", "command_receipts.execution_status", "command_receipts.business_committed",
      "command_receipts.result", "command_receipts.error", "command_receipts.resource_refs", "command_receipts.fact_refs", "command_receipts.committed_at",
      "command_executions.correlation_id", "command_executions.command_type",
      "command_receipts.created_at as protocol_created_at"
    ])
    .where("command_receipts.command_id", "=", commandId).executeTakeFirst();
  if (!row) return undefined;
  const storedResult = asRecord(row.result);
  let result = storedResult ? projectReceiptResultForRead(row.command_type, storedResult) : undefined;
  let historicalConversionProtocol: "PRE_INHOUSE_MEMBERSHIP_FULFILLMENT" | undefined;
  if (readMode === "HISTORICAL_READ"
    && row.command_type === "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP"
    && result
    && !Object.hasOwn(result, "conversionCoverageIds")) {
    const protocolVersion = "PRE_INHOUSE_MEMBERSHIP_FULFILLMENT" as const;
    await assertHistoricalReadPredatesProtocolEpoch(db, protocolVersion, row.protocol_created_at, "Command receipt");
    result = projectReceiptResultForRead(row.command_type, result, protocolVersion);
    historicalConversionProtocol = protocolVersion;
  }
  if (row.command_type === "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP" && result) {
    result = await projectStayMembershipConversionResultForRead(db, row.command_id, result);
  }
  if (result) {
    await assertTemporaryOtherRoomEvidenceForRead(db, row.command_type, result);
    if (row.command_type === "CREATE_QUOTE") {
      await assertTemporaryOtherRoomQuoteReceiptEvidenceForRead(db, result);
    }
  }
  const error = asRecord(row.error) as ErrorDto | undefined;
  const receipt: ReceiptReadDto = {
    receiptId: row.id,
    commandId: row.command_id,
    executionStatus: row.execution_status,
    businessCommitted: row.business_committed,
    correlationId: row.correlation_id,
    ...(result ? { result } : {}),
    ...(error ? { error } : {}),
    resourceRefs: asStringArray(row.resource_refs),
    factRefs: asStringArray(row.fact_refs),
    ...(row.committed_at ? { committedAt: asDate(row.committed_at).toISOString() } : {})
  };
  if (readMode !== "HISTORICAL_READ" || !result) return receipt;
  if (historicalConversionProtocol) {
    return { ...receipt, protocolVersion: historicalConversionProtocol, recoveryMode: "HISTORICAL_READ_ONLY" };
  }
  const protocolVersion = legacyReceiptProtocol(row.command_type, result);
  if (!protocolVersion) return receipt;
  await assertHistoricalReadPredatesProtocolEpoch(db, protocolVersion, row.protocol_created_at, "Command receipt");
  return { ...receipt, protocolVersion, recoveryMode: "HISTORICAL_READ_ONLY" };
}

export function projectReceiptResultForRead(
  commandType: string,
  result: Record<string, unknown>,
  protocolVersion?: HistoricalProtocolVersion
): Record<string, unknown> {
  if (commandType.startsWith("PREVIEW:")) {
    const preview = asRecord(result.preview);
    const effect = preview ? asRecord(preview.effect) : undefined;
    if (!preview || !effect) return result;
    const previewCommandType = commandType.slice("PREVIEW:".length);
    return {
      ...result,
      preview: { ...preview, effect: projectCommandEffectForRead(previewCommandType, effect) }
    };
  }
  if (commandType === "CREATE_ORDER") {
    return {
      ...result,
      primaryGuest: Object.hasOwn(result, "primaryGuest") ? projectPrimaryGuestForRead(result.primaryGuest) : null,
      ...(Object.hasOwn(result, "occupants") ? { occupants: result.occupants } : {}),
      bookingChannelCode: Object.hasOwn(result, "bookingChannelCode") ? result.bookingChannelCode : null,
      channelOrderReference: Object.hasOwn(result, "channelOrderReference") ? result.channelOrderReference : null,
      freeStayReason: Object.hasOwn(result, "freeStayReason") ? result.freeStayReason : null,
      freeStayCategoryCode: Object.hasOwn(result, "freeStayCategoryCode") ? result.freeStayCategoryCode : null
    };
  }
  if (commandType === "CREATE_QUOTE") {
    const quote = asRecord(result.quote);
    if (!quote) return result;
    return {
      ...result,
      quote: projectQuoteForExternalRead(quote as unknown as StoredQuoteDto | QuoteReadDto)
    };
  }
  if (commandType === "CORRECT_MEMBER_PROFILE") {
    const projectProfile = (value: unknown): Record<string, unknown> | null => {
      const profile = asRecord(value);
      if (!profile) return null;
      return {
        ...profile,
        identityCardNumber: typeof profile.identityCardNumber === "string"
          ? maskIdentityCardNumber(profile.identityCardNumber)
          : null,
        phone: typeof profile.phone === "string" ? maskPhone(profile.phone) : "****",
        wechat: typeof profile.wechat === "string" ? maskWechat(profile.wechat) : "***"
      };
    };
    return {
      ...result,
      before: projectProfile(result.before),
      after: projectProfile(result.after)
    };
  }
  if (commandType === "RECORD_COLLECTION" || commandType === "RECORD_REFUND" || commandType === "REVERSE_FACT") {
    return {
      ...result,
      transactionReference: Object.hasOwn(result, "transactionReference") ? result.transactionReference : null
    };
  }
  if (commandType === "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP"
    && protocolVersion === "PRE_INHOUSE_MEMBERSHIP_FULFILLMENT"
    && !Object.hasOwn(result, "conversionCoverageIds")) {
    return { ...result, conversionMode: "COMPLETED", conversionCoverageIds: [] };
  }
  return result;
}

async function replayOrConflict(db: Kysely<Database> | Transaction<Database>, options: {
  subjectId: string;
  propertyId: string;
  commandType: string;
  idempotencyKey: string;
  requestHash: string;
}): Promise<ReceiptDto | undefined> {
  const existing = await db.selectFrom("command_executions").selectAll()
    .where("subject_id", "=", options.subjectId)
    .where("property_id", "=", options.propertyId)
    .where("command_type", "=", options.commandType)
    .where("idempotency_key", "=", options.idempotencyKey)
    .executeTakeFirst();
  if (!existing) return undefined;
  if (existing.request_hash !== options.requestHash) throw new DomainError("IDEMPOTENCY_KEY_REUSED", "Idempotency key was already used with a different request", 409);
  const receipt = await receiptByCommand(db, existing.id, "HISTORICAL_READ");
  if (receipt) return receipt;
  throw new DomainError("COMMAND_STATUS_UNKNOWN", "Command is still executing or its final state is unknown", 409, true, { commandId: existing.id });
}

function quoteFromReceipt(receipt: ReceiptDto): QuoteReadDto {
  const quote = asRecord(receipt.result)?.quote;
  if (!quote || typeof quote !== "object" || Array.isArray(quote)) {
    throw new DomainError("INTERNAL_ERROR", "Quote receipt is malformed", 500);
  }
  return projectQuoteForExternalRead(quote as unknown as StoredQuoteDto | QuoteReadDto);
}

export async function executeQuoteCommand(
  db: Kysely<Database>,
  principal: AuthPrincipal,
  input: CreateQuoteCommandInputDto,
  metadata: { idempotencyKey: string | undefined; correlationId: string | undefined }
): Promise<CreateQuoteCommandResponseDto> {
  const headers = assertWriteMetadata(metadata.idempotencyKey, metadata.correlationId);
  const propertyId = input.propertyId?.trim();
  if (!propertyId) throw new DomainError("VALIDATION_ERROR", "propertyId is required");

  const nights = enumerateServiceDates(input.arrivalDate, input.departureDate).length;
  const derivedPaidStayType = paidStayTypeForNights(nights);
  if (input.stayType !== undefined && input.stayType !== "FREE" && input.stayType !== derivedPaidStayType) {
    throw new DomainError("PRICING_POLICY_UNCONFIGURED", `住宿类型与 ${nights} 晚住宿不一致，请重新报价`, 422);
  }
  const stayType = input.stayType === "FREE" ? "FREE" : derivedPaidStayType;
  if (input.memberId && input.memberContractId) {
    throw new DomainError("VALIDATION_ERROR", "会员报价只能选择会员档案，不能同时指定会员合同");
  }

  const commandType = "CREATE_QUOTE" as const;
  const normalizedInput: CreateQuoteCommandInputDto = {
    propertyId,
    inventoryUnitId: input.inventoryUnitId,
    stayType,
    arrivalDate: input.arrivalDate,
    departureDate: input.departureDate,
    pricingPolicyVersionId: input.pricingPolicyVersionId,
    ...(input.memberId ? { memberId: input.memberId } : {}),
    ...(input.memberContractId ? { memberContractId: input.memberContractId } : {}),
    ...(input.temporaryOtherRoom === true ? { temporaryOtherRoom: true } : {})
  };
  const requestHash = stableHash(normalizedInput);
  const commandLockKey = executionLockKey(principal.subjectId, propertyId, commandType, headers.idempotencyKey);
  const quoteQuotaLockKey = `qintopia:quote:${principal.subjectId}:${propertyId}`;
  const authorizeWhenBusy = busyExecutionAuthorizationGuard(db, principal, {
    propertyId,
    commandType,
    stage: "COMMAND",
    idempotencyKey: headers.idempotencyKey,
    correlationId: headers.correlationId,
    mode: "READ"
  });

  return withCommandAuthorizationAudit(db, () => withExecutionLock(db, commandLockKey, async (lockedDb) => {
    const replayBeforeQuota = await existingQuoteCommand(
      lockedDb,
      principal,
      propertyId,
      headers.idempotencyKey,
      requestHash,
      headers.correlationId
    );
    if (replayBeforeQuota) return replayBeforeQuota;

    return withQuoteQuotaLock(lockedDb, quoteQuotaLockKey, () => (
      lockedDb.transaction().setIsolationLevel("repeatable read").execute(async (trx) => {
      await lockCommandProtocolEpoch(trx);
      await lockRoomCatalog(trx, propertyId);
      await authorizeCommandAccess(db, trx, principal, {
        propertyId,
        commandType,
        stage: "COMMAND",
        idempotencyKey: headers.idempotencyKey,
        correlationId: headers.correlationId,
        mode: "READ"
      });
      const replay = await replayOrConflict(trx, {
        subjectId: principal.subjectId,
        propertyId,
        commandType,
        idempotencyKey: headers.idempotencyKey,
        requestHash
      });
      if (replay) return { quote: quoteFromReceipt(replay), receipt: replay };

      const commandId = newId("command");
      const inserted = await trx.insertInto("command_executions").values({
        id: commandId,
        subject_id: principal.subjectId,
        credential_id: principal.credentialId,
        property_id: propertyId,
        command_type: commandType,
        idempotency_key: headers.idempotencyKey,
        request_hash: requestHash,
        correlation_id: headers.correlationId,
        state: "EXECUTING",
        completed_at: null
      }).onConflict((oc) => oc.columns(["subject_id", "property_id", "command_type", "idempotency_key"]).doNothing())
        .returning("id")
        .executeTakeFirst();
      if (!inserted) {
        const concurrent = await replayOrConflict(trx, {
          subjectId: principal.subjectId,
          propertyId,
          commandType,
          idempotencyKey: headers.idempotencyKey,
          requestHash
        });
        if (!concurrent) throw new DomainError("COMMAND_STATUS_UNKNOWN", "Concurrent quote command state is unknown", 409, true);
        return { quote: quoteFromReceipt(concurrent), receipt: concurrent };
      }

      const quote = await createQuoteInTransaction(trx, {
        ...normalizedInput,
        requesterSubjectId: principal.subjectId
      });
      const readableQuote = projectQuoteForExternalRead(quote);
      const receiptId = newId("receipt");
      const committedAt = new Date();
      await trx.updateTable("command_executions")
        .set({ state: "APPLIED", completed_at: committedAt })
        .where("id", "=", commandId)
        .execute();
      await trx.insertInto("command_receipts").values({
        id: receiptId,
        command_id: commandId,
        execution_status: "EXECUTED",
        business_committed: true,
        result: { quote: readableQuote },
        error: null,
        resource_refs: JSON.stringify([quote.quoteId]),
        fact_refs: JSON.stringify([]),
        committed_at: committedAt
      }).execute();
      await trx.insertInto("audit_entries").values({
        id: newId("audit"),
        subject_id: principal.subjectId,
        credential_id: principal.credentialId,
        action: commandType,
        decision: "ALLOWED",
        command_id: commandId,
        correlation_id: headers.correlationId,
        reason: null,
        target_refs: JSON.stringify([quote.quoteId]),
        metadata: { quoteInputHash: quote.inputHash }
      }).execute();
      const receipt = await receiptByCommand(trx, commandId);
      if (!receipt) throw new DomainError("INTERNAL_ERROR", "Quote receipt was not persisted", 500);
      return { quote: readableQuote, receipt };
      })
    ));
  }, authorizeWhenBusy));
}

function previewFromReceipt(receipt: ReceiptDto): PreviewDto {
  const result = receipt.result;
  if (!result) throw new DomainError("INTERNAL_ERROR", "Preview receipt has no result", 500);
  const preview = result.preview;
  if (!preview || typeof preview !== "object" || Array.isArray(preview)) throw new DomainError("INTERNAL_ERROR", "Preview receipt is malformed", 500);
  return preview as unknown as PreviewDto;
}

export async function createCommandPreview(db: Kysely<Database>, principal: AuthPrincipal, envelope: CommandEnvelope, metadata: {
  idempotencyKey: string | undefined;
  correlationId: string | undefined;
}): Promise<{ preview: PreviewDto; receipt: ReceiptDto }> {
  const headers = assertWriteMetadata(metadata.idempotencyKey, metadata.correlationId);
  if (!isExecutableCommandType(envelope.commandType)) throw new DomainError("VALIDATION_ERROR", "Unsupported command type");
  const normalizedEnvelope = normalizeCommandEnvelope(envelope);
  const executionType = `PREVIEW:${normalizedEnvelope.commandType}`;
  const requestHash = stableHash(normalizedEnvelope);
  const requestedPropertyId = normalizedEnvelope.input.propertyId;
  if (typeof requestedPropertyId !== "string" || !requestedPropertyId) throw new DomainError("VALIDATION_ERROR", "propertyId is required");
  const commandLockKey = executionLockKey(principal.subjectId, requestedPropertyId, executionType, headers.idempotencyKey);
  const tokenLifecycleConstraint = tokenLifecycleAuthorizationConstraint(normalizedEnvelope.commandType, normalizedEnvelope.input);
  const authorizeWhenBusy = busyExecutionAuthorizationGuard(db, principal, {
    propertyId: requestedPropertyId,
    commandType: normalizedEnvelope.commandType,
    stage: "PREVIEW",
    idempotencyKey: headers.idempotencyKey,
    correlationId: headers.correlationId,
    mode: "EXECUTE",
    ...(tokenLifecycleConstraint ? { tokenLifecycleConstraint } : {})
  });

  return withCommandAuthorizationAudit(db, () => withExecutionLock(db, commandLockKey, (lockedDb) => lockedDb.transaction().setIsolationLevel("repeatable read").execute(async (trx) => {
    await lockCommandProtocolEpoch(trx);
    await lockRoomCatalog(trx, requestedPropertyId);
    await authorizeCommandAccess(db, trx, principal, {
      propertyId: requestedPropertyId,
      commandType: normalizedEnvelope.commandType,
      stage: "PREVIEW",
      idempotencyKey: headers.idempotencyKey,
      correlationId: headers.correlationId,
      mode: "EXECUTE",
      ...(tokenLifecycleConstraint ? { tokenLifecycleConstraint } : {})
    });
    const replay = await replayOrConflict(trx, { subjectId: principal.subjectId, propertyId: requestedPropertyId, commandType: executionType, idempotencyKey: headers.idempotencyKey, requestHash });
    if (replay) return { preview: previewFromReceipt(replay), receipt: replay };
    const frozenInput = freezeCreateOrderOccupantIds(normalizedEnvelope.commandType, normalizedEnvelope.input);
    const built = await buildCommandEffect(trx, normalizedEnvelope.commandType, frozenInput);
    const authorizationAttempt = {
      stage: "PREVIEW" as const,
      idempotencyKey: headers.idempotencyKey,
      correlationId: headers.correlationId
    };
    await assertTokenExpiryCeiling(trx, principal, built.propertyId, normalizedEnvelope.commandType, built.effect, authorizationAttempt);
    await assertTokenCommandCeiling(trx, principal, built.propertyId, normalizedEnvelope.commandType, built.effect, authorizationAttempt);
    const inserted = await trx.insertInto("command_executions").values({
      id: newId("command"), subject_id: principal.subjectId, credential_id: principal.credentialId,
      property_id: built.propertyId,
      command_type: executionType, idempotency_key: headers.idempotencyKey, request_hash: requestHash,
      correlation_id: headers.correlationId, state: "EXECUTING", completed_at: null
    }).onConflict((oc) => oc.columns(["subject_id", "property_id", "command_type", "idempotency_key"]).doNothing()).returning("id").executeTakeFirst();
    if (!inserted) {
      const concurrent = await replayOrConflict(trx, { subjectId: principal.subjectId, propertyId: built.propertyId, commandType: executionType, idempotencyKey: headers.idempotencyKey, requestHash });
      if (!concurrent) throw new DomainError("COMMAND_STATUS_UNKNOWN", "Concurrent preview state is unknown", 409, true);
      return { preview: previewFromReceipt(concurrent), receipt: concurrent };
    }
    const previewId = newId("preview");
    const expiresAt = new Date(Date.now() + Number(process.env.PREVIEW_TTL_SECONDS ?? 600) * 1000);
    const preview: PreviewDto = { previewId, commandType: normalizedEnvelope.commandType, effectHash: built.effectHash, effect: built.effect, expiresAt: expiresAt.toISOString() };
    await trx.insertInto("command_previews").values({
      id: previewId, subject_id: principal.subjectId, property_id: built.propertyId, command_type: normalizedEnvelope.commandType,
      normalized_input: frozenInput, input_hash: stableHash(normalizedEnvelope.input), effect: built.effect,
      effect_hash: built.effectHash, basis_versions: built.basisVersions, expires_at: expiresAt, status: "OPEN", used_at: null
    }).execute();
    const receiptId = newId("receipt");
    await trx.updateTable("command_executions").set({ state: "APPLIED", completed_at: new Date() }).where("id", "=", inserted.id).execute();
    await trx.insertInto("command_receipts").values({
      id: receiptId, command_id: inserted.id, execution_status: "EXECUTED", business_committed: true,
      result: { preview }, error: null, resource_refs: JSON.stringify([previewId]), fact_refs: JSON.stringify([]), committed_at: new Date()
    }).execute();
    await trx.insertInto("audit_entries").values({
      id: newId("audit"), subject_id: principal.subjectId, credential_id: principal.credentialId,
      action: executionType, decision: "ALLOWED", command_id: inserted.id, correlation_id: headers.correlationId,
      reason: null, target_refs: JSON.stringify([previewId]), metadata: { effectHash: built.effectHash }
    }).execute();
    const receipt = await receiptByCommand(trx, inserted.id);
    if (!receipt) throw new DomainError("INTERNAL_ERROR", "Preview receipt was not persisted", 500);
    return { preview, receipt };
  }), authorizeWhenBusy));
}

async function persistRejected(db: Kysely<Database>, principal: AuthPrincipal, options: {
  propertyId: string;
  commandType: CommandType;
  idempotencyKey: string;
  correlationId: string;
  requestHash: string;
  reason: CommandReason;
  error: DomainError;
  replayExisting?: boolean;
  closePreviewId?: string;
}): Promise<ReceiptDto> {
  return db.transaction().execute(async (trx) => {
    await lockCommandProtocolEpoch(trx);
    if (options.closePreviewId) {
      await trx.updateTable("command_previews")
        .set({ status: "EXPIRED", used_at: null })
        .where("id", "=", options.closePreviewId)
        .where("subject_id", "=", principal.subjectId)
        .where("property_id", "=", options.propertyId)
        .where("command_type", "=", options.commandType)
        .where("status", "=", "OPEN")
        .execute();
    }
    const commandId = newId("command");
    const inserted = await trx.insertInto("command_executions").values({
      id: commandId, subject_id: principal.subjectId, credential_id: principal.credentialId, property_id: options.propertyId,
      command_type: options.commandType, idempotency_key: options.idempotencyKey, request_hash: options.requestHash,
      correlation_id: options.correlationId, state: "REJECTED", completed_at: new Date()
    }).onConflict((oc) => oc.columns(["subject_id", "property_id", "command_type", "idempotency_key"]).doNothing()).returning("id").executeTakeFirst();
    if (!inserted) {
      if (options.replayExisting === false) throw options.error;
      const replay = await replayOrConflict(trx, { subjectId: principal.subjectId, propertyId: options.propertyId, commandType: options.commandType, idempotencyKey: options.idempotencyKey, requestHash: options.requestHash });
      if (replay) return replay;
      throw new DomainError("COMMAND_STATUS_UNKNOWN", "Rejected command state is unknown", 409, true);
    }
    const receiptId = newId("receipt");
    const errorDto: ErrorDto = {
      code: options.error.code,
      message: options.error.message,
      correlationId: options.correlationId,
      retryable: options.error.retryable,
      commandId,
      receiptId,
      ...(options.error.details ? { details: options.error.details } : {})
    };
    await trx.insertInto("command_receipts").values({
      id: receiptId, command_id: commandId, execution_status: "NOT_EXECUTED", business_committed: false,
      result: null, error: errorDto, resource_refs: JSON.stringify([]), fact_refs: JSON.stringify([]), committed_at: new Date()
    }).execute();
    await trx.insertInto("audit_entries").values({
      id: newId("audit"), subject_id: principal.subjectId, credential_id: principal.credentialId,
      action: options.commandType, decision: "DENIED", command_id: commandId, correlation_id: options.correlationId,
      reason: options.reason, target_refs: JSON.stringify([]), metadata: { errorCode: options.error.code }
    }).execute();
    return (await receiptByCommand(trx, commandId))!;
  });
}

export async function confirmCommandPreview(db: Kysely<Database>, principal: AuthPrincipal, previewId: string, confirmation: ConfirmRequest, metadata: {
  idempotencyKey: string | undefined;
  correlationId: string | undefined;
}): Promise<ReceiptDto> {
  const headers = assertWriteMetadata(metadata.idempotencyKey, metadata.correlationId);
  const requestHash = stableHash({ previewId, confirmation });
  return withCommandAuthorizationAudit(db, async () => {
    const storedIdentity = await db.selectFrom("command_previews")
      .select(["subject_id", "property_id", "command_type", "normalized_input"])
      .where("id", "=", previewId)
      .executeTakeFirst();
    if (!storedIdentity) {
      if (!isExecutableCommandType(confirmation.commandType)) {
        throw new DomainError("VALIDATION_ERROR", "Unsupported command type");
      }
      const replayPropertyId = confirmation.propertyId?.trim();
      if (!replayPropertyId) throw new DomainError("VALIDATION_ERROR", "propertyId is required");
      if (confirmation.confirmation !== true) throw new DomainError("CONFIRMATION_REQUIRED", "Explicit confirmation is required");
      if (!confirmation.expectedEffectHash?.trim()) {
        throw new DomainError("CONFIRMATION_MISMATCH", "expectedEffectHash is required");
      }
      if (!confirmation.reason?.code?.trim()
        || (confirmation.commandType !== "CREATE_ORDER" && !confirmation.reason.note?.trim())) {
        throw new DomainError("REASON_REQUIRED", "A structured reason is required");
      }
      if (confirmation.commandType === "CREATE_ORDER"
        && !createOrderConfirmationReasonCodes.has(confirmation.reason.code)) {
        throw new DomainError(
          "VALIDATION_ERROR",
          "CREATE_ORDER confirmation reason must be CREATE_STANDARD_ORDER, BACKFILL_STAY, or TEMPORARY_OTHER_ROOM"
        );
      }
      return db.transaction().setIsolationLevel("repeatable read").execute(async (trx) => {
        await authorizeCommandAccess(db, trx, principal, {
          propertyId: replayPropertyId,
          commandType: confirmation.commandType,
          stage: "REPLAY",
          idempotencyKey: headers.idempotencyKey,
          correlationId: headers.correlationId,
          mode: "READ"
        });
        const replay = await replayOrConflict(trx, {
          subjectId: principal.subjectId,
          propertyId: replayPropertyId,
          commandType: confirmation.commandType,
          idempotencyKey: headers.idempotencyKey,
          requestHash
        });
        if (replay) return replay;
        throw new DomainError("PREVIEW_NOT_FOUND", "Preview not found", 404);
      });
    }
    const propertyId = storedIdentity.property_id;
    if (!isExecutableCommandType(storedIdentity.command_type)) {
      throw new DomainError("INTERNAL_ERROR", "Stored Preview command type is unsupported", 500);
    }
    const commandType = storedIdentity.command_type;
    if (storedIdentity.subject_id !== principal.subjectId) {
      return auditCommandResourceNotFound(db, {
        principal,
        propertyId,
        commandType,
        stage: "CONFIRM",
        idempotencyKey: headers.idempotencyKey,
        correlationId: headers.correlationId,
        message: "Preview not found",
        code: "PREVIEW_NOT_FOUND"
      });
    }
    const storedNormalizedInput = asRecord(storedIdentity.normalized_input);
    if (!storedNormalizedInput) throw new DomainError("INTERNAL_ERROR", "Stored Preview input is malformed", 500);
    const tokenLifecycleConstraint = tokenLifecycleAuthorizationConstraint(commandType, storedNormalizedInput);
    const lockKey = executionLockKey(principal.subjectId, propertyId, commandType, headers.idempotencyKey);
    const authorizeWhenBusy = busyExecutionAuthorizationGuard(db, principal, {
      propertyId,
      commandType,
      stage: "CONFIRM",
      idempotencyKey: headers.idempotencyKey,
      correlationId: headers.correlationId,
      mode: "EXECUTE",
      ...(tokenLifecycleConstraint ? { tokenLifecycleConstraint } : {})
    });
    return withExecutionLock(db, lockKey, async (lockedDb) => {
      try {
        return await lockedDb.transaction().execute(async (trx) => {
        await lockCommandProtocolEpoch(trx);
        await lockRoomCatalog(trx, propertyId, commandType === "MANAGE_ROOM_CATALOG");
        const previewIdentity = await trx.selectFrom("command_previews")
          .selectAll()
          .where("id", "=", previewId)
          .executeTakeFirst();
        if (!previewIdentity) throw new DomainError("PREVIEW_NOT_FOUND", "Preview not found", 404);
        if (previewIdentity.subject_id !== principal.subjectId) {
          return auditCommandResourceNotFound(db, {
            principal,
            propertyId: previewIdentity.property_id,
            commandType: previewIdentity.command_type,
            stage: "CONFIRM",
            idempotencyKey: headers.idempotencyKey,
            correlationId: headers.correlationId,
            message: "Preview not found",
            code: "PREVIEW_NOT_FOUND"
          });
        }
        const normalizedInput = asRecord(previewIdentity.normalized_input);
        if (!normalizedInput) throw new DomainError("INTERNAL_ERROR", "Stored Preview input is malformed", 500);
        const lockedTokenLifecycleConstraint = tokenLifecycleAuthorizationConstraint(commandType, normalizedInput);
        await authorizeCommandAccess(db, trx, principal, {
          propertyId,
          commandType,
          stage: "CONFIRM",
          idempotencyKey: headers.idempotencyKey,
          correlationId: headers.correlationId,
          mode: "EXECUTE",
          ...(lockedTokenLifecycleConstraint ? { tokenLifecycleConstraint: lockedTokenLifecycleConstraint } : {})
        });
        const preflightEffect = asRecord(previewIdentity.effect);
        if (!preflightEffect) throw new DomainError("INTERNAL_ERROR", "Stored Preview effect is malformed", 500);
        const authorizationAttempt = {
          stage: "CONFIRM" as const,
          idempotencyKey: headers.idempotencyKey,
          correlationId: headers.correlationId
        };
        await assertTokenExpiryCeiling(trx, principal, propertyId, commandType, preflightEffect, authorizationAttempt);
        await assertTokenCommandCeiling(trx, principal, propertyId, commandType, preflightEffect, authorizationAttempt);
        if (confirmation.propertyId?.trim() !== propertyId || confirmation.commandType !== commandType) {
          throw new ConfirmationIdentityMismatchError();
        }
        if (confirmation.confirmation !== true) throw new DomainError("CONFIRMATION_REQUIRED", "Explicit confirmation is required");
        if (!confirmation.expectedEffectHash?.trim()) throw new DomainError("CONFIRMATION_MISMATCH", "expectedEffectHash is required");
        if (!confirmation.reason?.code?.trim()
          || (commandType !== "CREATE_ORDER" && !confirmation.reason.note?.trim())) {
          throw new DomainError("REASON_REQUIRED", "A structured reason is required");
        }
        if (commandType === "CREATE_ORDER"
          && !createOrderConfirmationReasonCodes.has(confirmation.reason.code)) {
          throw new DomainError(
            "VALIDATION_ERROR",
            "CREATE_ORDER confirmation reason must be CREATE_STANDARD_ORDER, BACKFILL_STAY, or TEMPORARY_OTHER_ROOM"
          );
        }
        const replay = await replayOrConflict(trx, {
          subjectId: principal.subjectId,
          propertyId,
          commandType,
          idempotencyKey: headers.idempotencyKey,
          requestHash
        });
        if (replay) return replay;

        const inserted = await trx.insertInto("command_executions").values({
          id: newId("command"),
          subject_id: principal.subjectId,
          credential_id: principal.credentialId,
          property_id: propertyId,
          command_type: commandType,
          idempotency_key: headers.idempotencyKey,
          request_hash: requestHash,
          correlation_id: headers.correlationId,
          state: "EXECUTING",
          completed_at: null
        }).onConflict((oc) => oc.columns(["subject_id", "property_id", "command_type", "idempotency_key"]).doNothing())
          .returning("id")
          .executeTakeFirst();
        if (!inserted) {
          const concurrent = await replayOrConflict(trx, {
            subjectId: principal.subjectId,
            propertyId,
            commandType,
            idempotencyKey: headers.idempotencyKey,
            requestHash
          });
          if (concurrent) return concurrent;
          throw new DomainError("COMMAND_STATUS_UNKNOWN", "Concurrent command state is unknown", 409, true);
        }

        const preview = await trx.selectFrom("command_previews")
          .selectAll()
          .where("id", "=", previewId)
          .forUpdate()
          .executeTakeFirst();
        if (!preview) throw new DomainError("PREVIEW_NOT_FOUND", "Preview not found", 404);
        if (preview.subject_id !== principal.subjectId) {
          return auditCommandResourceNotFound(db, {
            principal,
            propertyId: preview.property_id,
            commandType: preview.command_type,
            stage: "CONFIRM",
            idempotencyKey: headers.idempotencyKey,
            correlationId: headers.correlationId,
            message: "Preview not found",
            code: "PREVIEW_NOT_FOUND"
          });
        }
        if (preview.property_id !== propertyId || preview.command_type !== commandType) {
          throw new DomainError("INTERNAL_ERROR", "Stored Preview identity changed while confirming", 500);
        }
        if (preview.status === "EXPIRED") {
          throw new DomainError("PREVIEW_STALE", "Preview has expired; request a new preview", 409, false, { causeCode: "PREVIEW_EXPIRED" });
        }
        if (preview.status !== "OPEN") throw new DomainError("PREVIEW_ALREADY_USED", "Preview has already been used", 409);
        if (asDate(preview.expires_at).getTime() <= Date.now()) {
          throw new DomainError("PREVIEW_STALE", "Preview has expired; request a new preview", 409, false, { causeCode: "PREVIEW_EXPIRED" });
        }
        const storedEffect = asRecord(preview.effect);
        if (!storedEffect) throw new DomainError("INTERNAL_ERROR", "Stored Preview effect is malformed", 500);
        const legacyProtocolVersion = storedEffect
          ? legacyEffectProtocol(preview.command_type, storedEffect)
          : undefined;
        if (legacyProtocolVersion) {
          await assertHistoricalReadPredatesProtocolEpoch(trx, legacyProtocolVersion, preview.created_at, "Stored preview");
          throw new HistoricalPreviewReadOnlyError();
        }
        if (commandType === "CREATE_ORDER") {
          assertCreateOrderConfirmationReason(storedEffect, confirmation.reason);
        }
        if (commandType === "COMPLETE_STAY") {
          const lockedReason = typeof storedEffect.reasonNote === "string" ? storedEffect.reasonNote.trim() : "";
          if (confirmation.reason.code !== "COMPLETE_STAY"
            || !lockedReason
            || confirmation.reason.note.trim() !== lockedReason) {
            throw new DomainError(
              "CONFIRMATION_MISMATCH",
              "完成住宿确认原因必须与核对页锁定的说明一致",
              409
            );
          }
        }
        if (preview.effect_hash !== confirmation.expectedEffectHash) throw new DomainError("CONFIRMATION_MISMATCH", "Confirmed effect hash does not match the preview", 409);
        await lockCommandResources(trx, commandType, preview.normalized_input);
        const authoritativeWallInstant = commandType === "CREATE_ORDER"
          ? await sampleAuthoritativePropertyWallClock(trx)
          : null;
        const rebuildAndApply = async () => {
          let rebuilt: Awaited<ReturnType<typeof buildCommandEffect>>;
          try {
            rebuilt = await buildCommandEffect(trx, commandType, preview.normalized_input, true);
            const authorizationAttempt = {
              stage: "CONFIRM" as const,
              idempotencyKey: headers.idempotencyKey,
              correlationId: headers.correlationId
            };
            await assertTokenExpiryCeiling(trx, principal, propertyId, commandType, rebuilt.effect, authorizationAttempt);
            await assertTokenCommandCeiling(trx, principal, propertyId, commandType, rebuilt.effect, authorizationAttempt);
          } catch (error) {
            if (error instanceof DomainError && ([
              "INVENTORY_CONFLICT",
              "ENTITLEMENT_CONFLICT",
              "AGGREGATE_VERSION_CONFLICT",
              "INVALID_ORDER_STATE",
              "QUOTE_EXPIRED",
              "FACT_ALREADY_REVERSED",
              "REFUND_LIMIT_EXCEEDED"
            ].includes(error.code)
              || (isTokenLifecycleCommand(commandType) && error.code === "VALIDATION_ERROR")
              || (commandType === "CREATE_ORDER" && error.code === "VALIDATION_ERROR")
              || ((commandType === "RESCHEDULE_STAY" || commandType === "EXTEND_STAY" || commandType === "SHORTEN_STAY") && error.code === "VALIDATION_ERROR")
              || (commandType === "MOVE_UNIT" && error.code === "VALIDATION_ERROR")
              || (["MANAGE_ORDER_OCCUPANTS", "MANAGE_ROOM_CATALOG"].includes(commandType) && ["VALIDATION_ERROR", "NOT_FOUND"].includes(error.code))
              || (commandType === "COMPLETE_STAY" && error.code === "VALIDATION_ERROR")
              || (commandType === "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP" && error.code === "VALIDATION_ERROR")
              || (commandType === "CORRECT_HISTORICAL_STAY_ARRANGEMENTS" && error.code === "VALIDATION_ERROR")
              || (isMemberCorrectionCommandType(commandType) && error.code === "VALIDATION_ERROR")
              || (commandType === "CREATE_MEMBER" && error.code === "VALIDATION_ERROR"))) {
              throw new DomainError("PREVIEW_STALE", "Preview basis changed; request a new preview", 409, false, { causeCode: error.code });
            }
            throw error;
          }
          if (rebuilt.effectHash !== preview.effect_hash) throw new DomainError("PREVIEW_STALE", "Preview basis changed; request a new preview", 409);
          const applied = await applyCommand(trx, {
            commandType,
            input: preview.normalized_input,
            effect: rebuilt.effect,
            reason: confirmation.reason,
            commandId: inserted.id
          });
          await bindExternalPayments(trx, inserted.id, (rebuilt.basisVersions.externalPayments ?? []) as ExternalPaymentBasis[]);
          return { rebuilt, applied };
        };
        const { rebuilt, applied } = authoritativeWallInstant
          ? await withPropertyOperationClockSnapshot(authoritativeWallInstant, rebuildAndApply)
          : await rebuildAndApply();
        const strictRecoveryEvidence = requiresStrictRecoveryEvidence(commandType, storedEffect);
        const persistedEffectHash = strictRecoveryEvidence
          ? await bindPersistedEffectHash(trx, inserted.id, commandType, storedEffect, rebuilt.effectHash)
          : undefined;
        if (roomStatusVisibleCommands.has(commandType)) {
          await bumpRoomStatusRevision(trx, propertyId);
        }
        await trx.updateTable("command_previews").set({ status: "USED", used_at: new Date() }).where("id", "=", previewId).execute();
        await trx.updateTable("command_executions").set({ state: "APPLIED", completed_at: new Date() }).where("id", "=", inserted.id).execute();
        const receiptId = newId("receipt");
        const persistedResult = strictRecoveryEvidence
          ? { ...applied.persistedResult, effectHash: persistedEffectHash }
          : applied.persistedResult;
        await trx.insertInto("command_receipts").values({
          id: receiptId,
          command_id: inserted.id,
          execution_status: "EXECUTED",
          business_committed: true,
          result: persistedResult,
          error: null,
          resource_refs: JSON.stringify(applied.resourceRefs),
          fact_refs: JSON.stringify(applied.factRefs),
          committed_at: new Date()
        }).execute();
        await trx.insertInto("audit_entries").values({
          id: newId("audit"),
          subject_id: principal.subjectId,
          credential_id: principal.credentialId,
          action: commandType,
          decision: "ALLOWED",
          command_id: inserted.id,
          correlation_id: headers.correlationId,
          reason: confirmation.reason,
          target_refs: JSON.stringify(applied.resourceRefs),
          metadata: { previewId, effectHash: rebuilt.effectHash }
        }).execute();
        const receipt = await receiptByCommand(trx, inserted.id);
        if (!receipt) throw new DomainError("INTERNAL_ERROR", "Command receipt was not persisted", 500);
        return receipt;
        });
      } catch (error) {
        if (isCommandAuthorizationError(error)) throw error;
        if (error instanceof ConfirmationIdentityMismatchError) throw error;
        // A Preview outside this subject's namespace is not a command attempt and
        // must not create an artifact that can be used as an existence oracle.
        if (error instanceof DomainError && error.code === "PREVIEW_NOT_FOUND") throw error;
      // Preserve exact replays of historical receipts, but do not create a new
      // rejected command artifact for an open cleaning Preview while disabled.
        if (error instanceof DomainError
          && commandType === "COMPLETE_CLEANING"
          && !currentReleaseFeatures.cleaningWorkflow
          && error.code === "VALIDATION_ERROR") throw error;
        const rejectionError = error instanceof DomainError
          ? error
          : new DomainError(
            "COMMAND_INTERRUPTED",
            "The command transaction failed before any business facts committed; retry with a new idempotency key",
            409,
            true
          );
        try {
          return await persistRejected(lockedDb, principal, {
            propertyId,
            commandType,
            idempotencyKey: headers.idempotencyKey,
            correlationId: headers.correlationId,
            requestHash,
            reason: confirmation.reason,
            error: rejectionError,
            replayExisting: false,
            ...(rejectionError.code === "PREVIEW_STALE"
              && !(rejectionError instanceof HistoricalPreviewReadOnlyError)
              ? { closePreviewId: previewId }
              : {})
          });
        } catch (persistenceError) {
          if (!(error instanceof DomainError)) throw error;
          throw persistenceError;
        }
      }
    }, authorizeWhenBusy);
  });
}

export async function getReceipt(db: Kysely<Database>, principal: AuthPrincipal, receiptId: string): Promise<ReceiptReadDto> {
  return withCommandAuthorizationAudit(db, () => db.transaction().execute(async (trx) => {
    const command = await trx.selectFrom("command_receipts")
      .innerJoin("command_executions", "command_executions.id", "command_receipts.command_id")
      .select(["command_executions.id", "command_executions.subject_id", "command_executions.property_id", "command_executions.command_type", "command_executions.idempotency_key", "command_executions.correlation_id"])
      .where("command_receipts.id", "=", receiptId).executeTakeFirst();
    if (!command) throw new DomainError("NOT_FOUND", "Receipt not found", 404);
    if (command.subject_id !== principal.subjectId) {
      return auditCommandResourceNotFound(db, {
        principal,
        propertyId: command.property_id,
        commandType: command.command_type,
        stage: "RECEIPT",
        idempotencyKey: command.idempotency_key,
        correlationId: command.correlation_id,
        message: "Receipt not found"
      });
    }
    await authorizeCommandAccess(db, trx, principal, {
      propertyId: command.property_id,
      commandType: command.command_type,
      stage: "RECEIPT",
      idempotencyKey: command.idempotency_key,
      correlationId: command.correlation_id,
      mode: "READ"
    });
    const receipt = await receiptByCommand(trx, command.id, "HISTORICAL_READ");
    if (!receipt) throw new DomainError("NOT_FOUND", "Receipt not found", 404);
    return receipt;
  }));
}

export async function getCommand(db: Kysely<Database>, principal: AuthPrincipal, commandId: string): Promise<ReceiptReadDto | UnknownCommandResult> {
  return withCommandAuthorizationAudit(db, () => db.transaction().execute(async (trx) => {
    const command = await trx.selectFrom("command_executions").selectAll().where("id", "=", commandId).executeTakeFirst();
    if (!command) throw new DomainError("NOT_FOUND", "Command not found", 404);
    if (command.subject_id !== principal.subjectId) {
      return auditCommandResourceNotFound(db, {
        principal,
        propertyId: command.property_id,
        commandType: command.command_type,
        stage: "COMMAND",
        idempotencyKey: command.idempotency_key,
        correlationId: command.correlation_id,
        message: "Command not found"
      });
    }
    await authorizeCommandAccess(db, trx, principal, {
      propertyId: command.property_id,
      commandType: command.command_type,
      stage: "COMMAND",
      idempotencyKey: command.idempotency_key,
      correlationId: command.correlation_id,
      mode: "READ"
    });
    return (await receiptByCommand(trx, command.id, "HISTORICAL_READ")) ?? {
      commandId: command.id,
      executionStatus: "UNKNOWN",
      businessCommitted: false,
      correlationId: command.correlation_id
    };
  }));
}

export async function findCommandResult(
  db: Kysely<Database>,
  principal: AuthPrincipal,
  propertyId: string,
  commandType: string,
  idempotencyKey: string
) {
  const normalizedIdempotencyKey = idempotencyKey.trim();
  if (!normalizedIdempotencyKey) throw new DomainError("VALIDATION_ERROR", "idempotencyKey is required");
  const findExecution = (connection: Kysely<Database> | Transaction<Database>) => connection.selectFrom("command_executions").selectAll()
    .where("subject_id", "=", principal.subjectId)
    .where("property_id", "=", propertyId)
    .where("command_type", "=", commandType)
    .where("idempotency_key", "=", normalizedIdempotencyKey)
    .executeTakeFirst();
  const toVisibleResult = async (connection: Kysely<Database> | Transaction<Database>, execution: NonNullable<Awaited<ReturnType<typeof findExecution>>>) => {
    return (await receiptByCommand(connection, execution.id, "HISTORICAL_READ")) ?? {
      commandId: execution.id,
      executionStatus: "UNKNOWN" as const,
      businessCommitted: false as const,
      correlationId: execution.correlation_id
    };
  };

  return withCommandAuthorizationAudit(db, () => db.transaction().execute(async (trx) => {
    await authorizeCommandAccess(db, trx, principal, {
      propertyId,
      commandType,
      stage: "FIND",
      idempotencyKey: normalizedIdempotencyKey,
      correlationId: undefined,
      mode: "READ"
    });
    const execution = await findExecution(trx);
    if (execution) return toVisibleResult(trx, execution);

    // A read-only lookup cannot prove that a request still in transit will never
    // arrive. Only resolveCommandResult may publish durable NOT_EXECUTED.
    return { executionStatus: "UNKNOWN" as const, businessCommitted: false as const };
  }));
}

export async function resolveCommandResult(
  db: Kysely<Database>,
  principal: AuthPrincipal,
  request: ResolveCommandResultRequest,
  metadata: { idempotencyKey: string | undefined; correlationId: string | undefined }
): Promise<ReceiptReadDto | UnknownCommandResult> {
  const headers = assertWriteMetadata(metadata.idempotencyKey, metadata.correlationId);
  const propertyId = request.propertyId.trim();
  const originalIdempotencyKey = request.idempotencyKey.trim();
  if (!propertyId) throw new DomainError("VALIDATION_ERROR", "propertyId is required");
  if (!originalIdempotencyKey) throw new DomainError("VALIDATION_ERROR", "idempotencyKey is required");

  const findExecution = (connection: Kysely<Database> | Transaction<Database>) => connection
    .selectFrom("command_executions")
    .selectAll()
    .where("subject_id", "=", principal.subjectId)
    .where("property_id", "=", propertyId)
    .where("command_type", "=", request.commandType)
    .where("idempotency_key", "=", originalIdempotencyKey)
    .executeTakeFirst();
  const visibleResult = async (
    connection: Kysely<Database> | Transaction<Database>,
    execution: NonNullable<Awaited<ReturnType<typeof findExecution>>>
  ): Promise<ReceiptReadDto | UnknownCommandResult> => {
    return (await receiptByCommand(connection, execution.id, "HISTORICAL_READ")) ?? {
      commandId: execution.id,
      executionStatus: "UNKNOWN",
      businessCommitted: false,
      correlationId: execution.correlation_id
    };
  };

  const lockKey = executionLockKey(
    principal.subjectId,
    propertyId,
    request.commandType,
    originalIdempotencyKey
  );
  return withCommandAuthorizationAudit(db, () => db.transaction().execute(async (trx) => {
    await lockCommandProtocolEpoch(trx);
    await authorizeCommandAccess(db, trx, principal, {
      propertyId,
      commandType: request.commandType,
      stage: "RESOLVE",
      idempotencyKey: originalIdempotencyKey,
      correlationId: headers.correlationId,
      mode: "READ"
    });
    const lockResult = await sql<{ acquired: boolean }>`
      select pg_try_advisory_xact_lock(hashtextextended(${lockKey}, 0::bigint)) as acquired
    `.execute(trx);
    if (!lockResult.rows[0]?.acquired) {
      return { executionStatus: "UNKNOWN" as const, businessCommitted: false as const };
    }

    const raced = await findExecution(trx);
    if (raced) return visibleResult(trx, raced);

    if (request.commandType !== "CREATE_QUOTE") {
      if (!isExecutableCommandType(request.commandType as CommandType)) {
        return { executionStatus: "UNKNOWN" as const, businessCommitted: false as const };
      }
      await authorizeCommandAccess(db, trx, principal, {
        propertyId,
        commandType: request.commandType,
        stage: "RESOLVE",
        idempotencyKey: originalIdempotencyKey,
        correlationId: headers.correlationId,
        mode: "EXECUTE"
      });
    }

    const commandId = newId("command");
    const receiptId = newId("receipt");
    const completedAt = new Date();
    const fenceHash = stableHash({
      protocol: "COMMAND_RESULT_RESOLUTION_FENCE_V1",
      subjectId: principal.subjectId,
      propertyId,
      commandType: request.commandType,
      idempotencyKey: originalIdempotencyKey
    });
    const inserted = await trx.insertInto("command_executions").values({
      id: commandId,
      subject_id: principal.subjectId,
      credential_id: principal.credentialId,
      property_id: propertyId,
      command_type: request.commandType,
      idempotency_key: originalIdempotencyKey,
      request_hash: fenceHash,
      correlation_id: headers.correlationId,
      state: "REJECTED",
      completed_at: completedAt
    }).onConflict((oc) => oc
      .columns(["subject_id", "property_id", "command_type", "idempotency_key"])
      .doNothing())
      .returning("id")
      .executeTakeFirst();
    if (!inserted) {
      const concurrent = await findExecution(trx);
      if (concurrent) return visibleResult(trx, concurrent);
      throw new DomainError("COMMAND_STATUS_UNKNOWN", "Command resolution state is unknown", 409, true);
    }

    const error: ErrorDto = {
      code: "COMMAND_INTERRUPTED",
      message: "The original request was not executed and its idempotency key is now closed",
      correlationId: headers.correlationId,
      retryable: false,
      commandId,
      receiptId
    };
    await trx.insertInto("command_receipts").values({
      id: receiptId,
      command_id: commandId,
      execution_status: "NOT_EXECUTED",
      business_committed: false,
      result: null,
      error,
      resource_refs: JSON.stringify([]),
      fact_refs: JSON.stringify([]),
      committed_at: completedAt
    }).execute();
    await trx.insertInto("audit_entries").values({
      id: newId("audit"),
      subject_id: principal.subjectId,
      credential_id: principal.credentialId,
      action: `RESOLVE_COMMAND_RESULT:${request.commandType}`,
      decision: "DENIED",
      command_id: commandId,
      correlation_id: headers.correlationId,
      reason: { code: "COMMAND_RESULT_RESOLUTION", note: "Original request fenced as not executed" },
      target_refs: JSON.stringify([]),
      metadata: {
        errorCode: error.code,
        resolutionFence: true,
        resolutionRequestHash: sha256(headers.idempotencyKey)
      }
    }).execute();
    const receipt = await receiptByCommand(trx, commandId);
    if (!receipt) throw new DomainError("INTERNAL_ERROR", "Command resolution receipt was not persisted", 500);
    return receipt;
  }));
}
import { lockRoomCatalog } from "../room-catalog.ts";
