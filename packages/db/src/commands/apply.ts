import { sql, type Transaction } from "kysely";
import { applyCheckoutReversal, lockCheckoutReversalInventory } from "./checkout-reversal.ts";
import { applyCompanionEffect } from "./companions.ts";
import {
  createOrderPricingBasisCodes,
  currentReleaseFeatures,
  DomainError,
  type CommandCatalogType,
  type CommandReason,
  type CommandType,
  type CoverageItemDto,
  type CreateOrderPricingBasis,
  type TemporaryOtherRoomArrangementDto
} from "@qintopia/contracts";
import { enumerateServiceDates, newId, parseLocalDate, requireTransactionReference, validateBookingChannel } from "@qintopia/domain";
import { assertUnitAvailable, createInventoryClaims, loadInventoryUnit, loadInventoryUnitIncludingInactive, lockRoomDays, lockUnitDates, releaseInventoryClaims, releaseInventoryClaimsOnDates } from "../inventory.ts";
import { appendAmendment, consumeCoverage, holdCoverage, incrementContractAndLotVersions, loadActiveStayTimeline, loadOrderContext, loadOrderMembershipConversion, reconcileCoverage, releaseCoverage, restoreConsumedCoverage, restoreFutureConsumedCoverage, type OrderContext, type StayTimelineItem } from "../orders.ts";
import { loadStoredQuote, lockEntitlementLots, lockMemberEntitlementLots } from "../pricing-service.ts";
import type { Database } from "../schema.ts";
import { planStayDateChangeTimeline, timelinePairDiff } from "../stay-timeline-plan.ts";
import { normalizePhoneNumber, optionalIdentityCardNumber, requireInteger, requireObject, requireString } from "./effects.ts";
import {
  HISTORICAL_STAY_ARRANGEMENT_CORRECTION_COMMAND,
  applyHistoricalStayArrangementCorrection,
  lockHistoricalStayArrangementCorrectionResources
} from "../admin-historical-stay-corrections.ts";
import {
  applyMemberCorrectionCommand,
  isMemberCorrectionCommandType,
  lockMemberCorrectionResources
} from "./member-corrections.ts";

export interface AppliedCommand {
  persistedResult: Record<string, unknown>;
  resourceRefs: string[];
  factRefs: string[];
}

function rethrowTokenSecretConflict(error: unknown): never {
  const databaseError = error as { code?: unknown; constraint?: unknown };
  if (databaseError.code === "23505" && databaseError.constraint === "api_tokens_secret_hash_key") {
    throw new DomainError("AGGREGATE_VERSION_CONFLICT", "Token secret is already assigned", 409);
  }
  throw error;
}

async function insertTokenCommandCeiling(
  trx: Transaction<Database>,
  tokenId: string,
  subjectId: string,
  propertyId: string,
  commandCeiling: readonly string[]
): Promise<void> {
  if (commandCeiling.length === 0) return;
  await trx.insertInto("token_command_ceilings")
    .values(commandCeiling.map((commandType) => ({
      token_id: tokenId,
      subject_id: subjectId,
      property_id: propertyId,
      command_type: commandType as CommandCatalogType
    })))
    .execute();
}

function rethrowMemberRegistrationConflict(error: unknown): never {
  const databaseError = error as { code?: unknown; constraint?: unknown };
  if (databaseError.code === "23505" && databaseError.constraint === "members_phone_unique") {
    throw new DomainError("VALIDATION_ERROR", "该手机号已登记，不能重复创建会员档案", 409);
  }
  throw error;
}

function nestedObject(record: Record<string, unknown>, field: string): Record<string, unknown> {
  return requireObject(record[field], field);
}

function pricingObject(effect: Record<string, unknown>): Record<string, unknown> {
  if (effect.pricing) return requireObject(effect.pricing, "pricing");
  return nestedObject(nestedObject(effect, "after"), "pricing");
}

function moneyMinor(value: unknown, field: string): { currency: string; minorUnits: number } {
  const money = requireObject(value, field);
  const currency = requireString(money, "currency");
  if (!Number.isInteger(money.minorUnits)) throw new DomainError("INTERNAL_ERROR", `${field}.minorUnits is invalid`, 500);
  return { currency, minorUnits: money.minorUnits as number };
}

function temporaryOtherRoomArrangementFromEffect(effect: Record<string, unknown>): TemporaryOtherRoomArrangementDto | null {
  if (effect.temporaryOtherRoomArrangement === undefined || effect.temporaryOtherRoomArrangement === null) return null;
  const raw = requireObject(effect.temporaryOtherRoomArrangement, "temporaryOtherRoomArrangement");
  const arrangement: TemporaryOtherRoomArrangementDto = {
    kind: requireString(raw, "kind") as TemporaryOtherRoomArrangementDto["kind"],
    membershipOrderId: requireString(raw, "membershipOrderId"),
    memberContractId: requireString(raw, "memberContractId"),
    entitlementLotId: requireString(raw, "entitlementLotId"),
    originalRoomTypeCode: requireString(raw, "originalRoomTypeCode"),
    originalInventoryKind: requireString(raw, "originalInventoryKind") as TemporaryOtherRoomArrangementDto["originalInventoryKind"],
    entitlementUnitKind: requireString(raw, "entitlementUnitKind") as TemporaryOtherRoomArrangementDto["entitlementUnitKind"],
    actualInventoryUnitId: requireString(raw, "actualInventoryUnitId"),
    actualRoomTypeCode: requireString(raw, "actualRoomTypeCode"),
    actualInventoryKind: requireString(raw, "actualInventoryKind") as TemporaryOtherRoomArrangementDto["actualInventoryKind"],
    arrivalDate: requireString(raw, "arrivalDate"),
    departureDate: requireString(raw, "departureDate")
  };
  if (arrangement.kind !== "TEMPORARY_OTHER_ROOM"
    || arrangement.originalInventoryKind !== "ROOM"
    || arrangement.entitlementUnitKind !== "ROOM_NIGHT"
    || arrangement.actualInventoryKind !== "ROOM"
    || arrangement.originalRoomTypeCode === arrangement.actualRoomTypeCode
    || Object.keys(raw).length !== 12) {
    throw new DomainError("INTERNAL_ERROR", "Temporary other-room arrangement is invalid", 500);
  }
  return arrangement;
}

function temporaryOtherRoomReceiptEvidenceFromEffect(effect: Record<string, unknown>): Record<string, unknown> {
  const arrangement = temporaryOtherRoomArrangementFromEffect(effect);
  return arrangement
    ? {
        temporaryOtherRoomArrangement: arrangement,
        temporaryOtherRoomCreateAmendmentId: requireString(effect, "temporaryOtherRoomCreateAmendmentId")
      }
    : {};
}

function pricingSnapshot(effect: Record<string, unknown>, orderIdentity?: {
  stayType: string;
  memberId: string | null;
  memberContractId: string | null;
}) {
  const pricing = pricingObject(effect);
  const coverageSet = pricing.coverageSet;
  const cashLines = pricing.cashLines;
  if (!Array.isArray(coverageSet) || !Array.isArray(cashLines)) throw new DomainError("INTERNAL_ERROR", "Pricing effect is invalid", 500);
  const contract = moneyMinor(pricing.currentContractAmount, "currentContractAmount");
  const cashRemainder = moneyMinor(pricing.cashRemainder, "cashRemainder");
  const decision = effect.pricingDecision ? requireObject(effect.pricingDecision, "pricingDecision") : undefined;
  const policyBase = decision ? moneyMinor(decision.policyBaseAmount, "policyBaseAmount") : cashRemainder;
  const pricingBasisValue = decision?.pricingBasis;
  const categoricalBasis = orderIdentity?.stayType === "FREE"
    ? "FREE"
    : orderIdentity?.memberId || orderIdentity?.memberContractId
      ? "MEMBER_ENTITLEMENT"
      : undefined;
  const pricingBasis = pricingBasisValue === undefined
    ? categoricalBasis ?? (contract.minorUnits === cashRemainder.minorUnits ? "POLICY" : "MANUAL_ADJUSTMENT")
    : createOrderPricingBasisCodes.includes(pricingBasisValue as CreateOrderPricingBasis)
      ? pricingBasisValue as CreateOrderPricingBasis
      : undefined;
  if (!pricingBasis) throw new DomainError("INTERNAL_ERROR", "Create order pricing basis is invalid", 500);
  if (policyBase.currency !== contract.currency) throw new DomainError("INTERNAL_ERROR", "Pricing currencies do not match", 500);
  const manualAdjustmentMinor = decision?.manualAdjustmentMinor;
  if (manualAdjustmentMinor !== undefined && !Number.isInteger(manualAdjustmentMinor)) {
    throw new DomainError("INTERNAL_ERROR", "Create order manual adjustment is invalid", 500);
  }
  const reasonValue = decision?.reason;
  const reason = reasonValue === undefined ? undefined : requireObject(reasonValue, "reason");
  const reasonCode = reason === undefined ? undefined : requireString(reason, "code");
  const reasonNoteValue = reason?.note;
  if (reasonNoteValue !== undefined && typeof reasonNoteValue !== "string") {
    throw new DomainError("INTERNAL_ERROR", "Create order pricing reason note is invalid", 500);
  }
  return {
    coverageSet: coverageSet as CoverageItemDto[],
    cashLines,
    policyBaseAmountMinor: policyBase.minorUnits,
    pricingBasis,
    currentContractAmountMinor: contract.minorUnits,
    manualAdjustmentMinor: manualAdjustmentMinor as number | undefined ?? contract.minorUnits - cashRemainder.minorUnits,
    currency: contract.currency,
    ...(reasonCode ? { reason: { code: reasonCode, note: reasonNoteValue as string ?? "" } } : {})
  };
}

function stayTimelineFromEffect(effect: Record<string, unknown>): StayTimelineItem[] {
  const after = effect.after && typeof effect.after === "object" && !Array.isArray(effect.after) ? effect.after as Record<string, unknown> : undefined;
  const rawTimeline = effect.stayTimeline ?? after?.stayTimeline;
  if (!Array.isArray(rawTimeline) || rawTimeline.length === 0) throw new DomainError("INTERNAL_ERROR", "Command effect has no stay timeline", 500);
  return rawTimeline.map((rawItem, index) => {
    const item = requireObject(rawItem, `stayTimeline[${index}]`);
    return { serviceDate: requireString(item, "serviceDate"), inventoryUnitId: requireString(item, "inventoryUnitId") };
  });
}

function stringArray(record: Record<string, unknown>, field: string): string[] {
  const value = record[field];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)) {
    throw new DomainError("INTERNAL_ERROR", `${field} is invalid`, 500);
  }
  return value as string[];
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function inventoryClaimSummaries(record: Record<string, unknown>, field: string): Array<{ serviceDate: string; inventoryUnitId: string }> {
  const value = record[field];
  if (!Array.isArray(value)) throw new DomainError("INTERNAL_ERROR", `${field} is invalid`, 500);
  return value.map((entry, index) => {
    const item = requireObject(entry, `${field}[${index}]`);
    return {
      serviceDate: requireString(item, "serviceDate"),
      inventoryUnitId: requireString(item, "inventoryUnitId")
    };
  });
}

function trailingTimelineRun(timeline: StayTimelineItem[]): { inventoryUnitId: string; arrivalDate: string } {
  const last = timeline.at(-1)!;
  let startIndex = timeline.length - 1;
  while (startIndex > 0 && timeline[startIndex - 1]!.inventoryUnitId === last.inventoryUnitId) startIndex -= 1;
  return { inventoryUnitId: last.inventoryUnitId, arrivalDate: timeline[startIndex]!.serviceDate };
}

async function roomDatesForTimeline(trx: Transaction<Database>, propertyId: string, timeline: StayTimelineItem[]) {
  const unitIds = [...new Set(timeline.map((item) => item.inventoryUnitId))];
  const units = new Map((await Promise.all(unitIds.map((unitId) => loadInventoryUnit(trx, propertyId, unitId)))).map((unit) => [unit.id, unit]));
  return timeline.map((item) => ({ roomId: units.get(item.inventoryUnitId)!.roomId, serviceDate: item.serviceDate }));
}

async function lockOrderForProperty(trx: Transaction<Database>, propertyId: string, orderId: string): Promise<void> {
  const order = await trx.selectFrom("orders")
    .select("id")
    .where("id", "=", orderId)
    .where("property_id", "=", propertyId)
    .forUpdate()
    .executeTakeFirst();
  if (!order) throw new DomainError("NOT_FOUND", "Order not found", 404);
}

async function loadLockedOrderContextForProperty(trx: Transaction<Database>, propertyId: string, orderId: string): Promise<OrderContext> {
  await lockOrderForProperty(trx, propertyId, orderId);
  return loadOrderContext(trx, orderId);
}

async function lockSubjectForProperty(trx: Transaction<Database>, propertyId: string, subjectId: string, notFoundMessage: string): Promise<void> {
  const subject = await trx.selectFrom("subjects")
    .innerJoin("subject_property_grants", "subject_property_grants.subject_id", "subjects.id")
    .select("subjects.id")
    .where("subjects.id", "=", subjectId)
    .where("subject_property_grants.property_id", "=", propertyId)
    .forUpdate("subjects")
    .executeTakeFirst();
  if (!subject) throw new DomainError("NOT_FOUND", notFoundMessage, 404);
}

async function lockTokenLifecycleTarget(trx: Transaction<Database>, propertyId: string, tokenId: string): Promise<{ subjectId: string }> {
  const token = await trx.selectFrom("api_tokens")
    .innerJoin("subject_property_grants", "subject_property_grants.subject_id", "api_tokens.subject_id")
    .select(["api_tokens.id", "api_tokens.subject_id"])
    .where("api_tokens.id", "=", tokenId)
    .where("api_tokens.property_scope", "=", propertyId)
    .where("subject_property_grants.property_id", "=", propertyId)
    .executeTakeFirst();
  if (!token) throw new DomainError("NOT_FOUND", "Token not found", 404);

  await lockSubjectForProperty(trx, propertyId, token.subject_id, "Token not found");
  const lockedToken = await trx.selectFrom("api_tokens")
    .select("id")
    .where("id", "=", token.id)
    .where("subject_id", "=", token.subject_id)
    .where("property_scope", "=", propertyId)
    .forUpdate()
    .executeTakeFirst();
  if (!lockedToken) throw new DomainError("NOT_FOUND", "Token not found", 404);

  return { subjectId: token.subject_id };
}

async function lockMemberEntitlementIdentity(trx: Transaction<Database>, memberId: string | null): Promise<void> {
  if (!memberId) {
    throw new DomainError("ENTITLEMENT_CONFLICT", "Member entitlement owner is missing", 409);
  }
  await sql`select pg_advisory_xact_lock(hashtextextended(${`qintopia:member-entitlements:${memberId}`}, 0::bigint))`.execute(trx);
  const member = await trx.selectFrom("members").select("id").where("id", "=", memberId).forUpdate().executeTakeFirst();
  if (!member) {
    throw new DomainError("ENTITLEMENT_CONFLICT", "Member entitlement owner is missing", 409);
  }
}

async function resolveQuoteMemberEntitlementOwner(
  trx: Transaction<Database>,
  propertyId: string,
  quoteMemberId: string | undefined,
  memberContractId: string | undefined
): Promise<string | null> {
  if (!memberContractId) return quoteMemberId ?? null;
  const contract = await trx.selectFrom("member_contracts").select("member_id")
    .where("id", "=", memberContractId)
    .where("property_id", "=", propertyId)
    .executeTakeFirst();
  if (!contract?.member_id) {
    throw new DomainError("ENTITLEMENT_CONFLICT", "Member entitlement owner is missing", 409);
  }
  if (quoteMemberId && quoteMemberId !== contract.member_id) {
    throw new DomainError("ENTITLEMENT_CONFLICT", "Quoted member entitlement owner is inconsistent", 409);
  }
  return contract.member_id;
}

export async function lockCommandResources(trx: Transaction<Database>, commandType: CommandType, rawInput: unknown): Promise<void> {
  const input = requireObject(rawInput);
  const propertyId = requireString(input, "propertyId");
  if (commandType === "MANAGE_ROOM_CATALOG") return;

  if (commandType === HISTORICAL_STAY_ARRANGEMENT_CORRECTION_COMMAND) {
    await lockHistoricalStayArrangementCorrectionResources(trx, rawInput);
    return;
  }
  if (isMemberCorrectionCommandType(commandType)) {
    await lockMemberCorrectionResources(trx, commandType, rawInput);
    return;
  }

  if (commandType === "CREATE_MEMBER") {
    const phone = normalizePhoneNumber(input.phone);
    await sql`select pg_advisory_xact_lock(hashtextextended(${`qintopia:member-phone:${phone}`}, 0::bigint))`.execute(trx);
    await trx.selectFrom("members").select("id")
      .where("phone", "=", phone).forUpdate().executeTakeFirst();
    return;
  }

  if (commandType === "CREATE_MEMBERSHIP_ORDER") {
    const memberId = requireString(input, "memberId");
    const productId = requireString(input, "membershipProductId");
    const member = await trx.selectFrom("member_property_links").select("member_id")
      .where("member_id", "=", memberId).where("property_id", "=", propertyId).executeTakeFirst();
    if (!member) throw new DomainError("NOT_FOUND", "当前门店未找到该会员", 404);
    const product = await trx.selectFrom("membership_products").select("id").where("id", "=", productId).executeTakeFirst();
    if (!product) throw new DomainError("NOT_FOUND", "会员产品不存在", 404);
    return;
  }

  if (commandType === "ACTIVATE_MEMBERSHIP_ORDER") {
    const membershipOrderId = requireString(input, "membershipOrderId");
    const identity = await trx.selectFrom("membership_orders").select(["id", "member_id"])
      .where("id", "=", membershipOrderId).where("property_id", "=", propertyId).executeTakeFirst();
    if (!identity) throw new DomainError("NOT_FOUND", "会员订单不存在", 404);
    await lockMemberEntitlementIdentity(trx, identity.member_id);
    const order = await trx.selectFrom("membership_orders").select("id")
      .where("id", "=", membershipOrderId)
      .where("property_id", "=", propertyId)
      .where("member_id", "=", identity.member_id)
      .forUpdate().executeTakeFirst();
    if (!order) throw new DomainError("AGGREGATE_VERSION_CONFLICT", "会员订单身份已变化", 409);
    await trx.selectFrom("membership_payment_facts").select("fact_id")
      .where("membership_order_id", "=", membershipOrderId).forUpdate().execute();
    return;
  }

  if (commandType === "RECORD_MEMBERSHIP_PAYMENT" || commandType === "CORRECT_MEMBERSHIP_PAYMENT") {
    const membershipOrderId = requireString(input, "membershipOrderId");
    const order = await trx.selectFrom("membership_orders").select("id")
      .where("id", "=", membershipOrderId).where("property_id", "=", propertyId).forUpdate().executeTakeFirst();
    if (!order) throw new DomainError("NOT_FOUND", "会员订单不存在", 404);
    await trx.selectFrom("membership_payment_facts").select("fact_id")
      .where("membership_order_id", "=", membershipOrderId).forUpdate().execute();
    return;
  }

  if (commandType === "CREATE_ORDER") {
    const quote = await loadStoredQuote(trx, requireString(input, "quoteId"));
    const entitlementOwnerId = await resolveQuoteMemberEntitlementOwner(
      trx,
      propertyId,
      quote.memberId,
      quote.memberContractId
    );
    if (entitlementOwnerId) {
      await lockMemberEntitlementIdentity(trx, entitlementOwnerId);
    }
    const lockedContractOwnerId = await lockEntitlementLots(trx, quote.memberContractId);
    if (quote.memberContractId && lockedContractOwnerId !== entitlementOwnerId) {
      throw new DomainError("ENTITLEMENT_CONFLICT", "Quoted member entitlement owner is inconsistent", 409);
    }
    await lockUnitDates(trx, propertyId, quote.inventoryUnitId, quote.arrivalDate, quote.departureDate);
    return;
  }
  if (commandType === "LOCK_MAINTENANCE") {
    await lockUnitDates(trx, propertyId, requireString(input, "inventoryUnitId"), requireString(input, "arrivalDate"), requireString(input, "departureDate"));
    return;
  }
  if (commandType === "RELEASE_MAINTENANCE") {
    const lock = await trx.selectFrom("maintenance_locks").selectAll().where("id", "=", requireString(input, "maintenanceLockId")).where("property_id", "=", propertyId).forUpdate().executeTakeFirst();
    if (!lock) throw new DomainError("NOT_FOUND", "Maintenance lock not found", 404);
    await lockUnitDates(trx, propertyId, lock.inventory_unit_id, lock.arrival_date, lock.departure_date, true);
    return;
  }
  if (commandType === "COMPLETE_CLEANING") {
    const task = await trx.selectFrom("cleaning_tasks").select("id")
      .where("id", "=", requireString(input, "cleaningTaskId"))
      .where("property_id", "=", propertyId)
      .forUpdate()
      .executeTakeFirst();
    if (!task) throw new DomainError("NOT_FOUND", "Cleaning task not found", 404);
    return;
  }
  if (commandType === "ADD_MEMBER_ENTITLEMENT_LOT") {
    const contractId = requireString(input, "memberContractId");
    const contract = await trx.selectFrom("member_contracts").select(["id", "member_id"])
      .where("id", "=", contractId).where("property_id", "=", propertyId).executeTakeFirst();
    if (!contract) throw new DomainError("NOT_FOUND", "Member contract not found", 404);
    await lockMemberEntitlementIdentity(trx, contract.member_id);
    await lockEntitlementLots(trx, contractId);
    return;
  }
  if (commandType === "ADJUST_MEMBER_ENTITLEMENT" || commandType === "CORRECT_MEMBER_ENTITLEMENT_BALANCE" || commandType === "EXPIRE_MEMBER_ENTITLEMENT") {
    const lot = await trx.selectFrom("entitlement_lots").innerJoin("member_contracts", "member_contracts.id", "entitlement_lots.contract_id")
      .select(["entitlement_lots.id", "entitlement_lots.contract_id", "member_contracts.member_id"])
      .where("entitlement_lots.id", "=", requireString(input, "entitlementLotId"))
      .where("member_contracts.property_id", "=", propertyId).executeTakeFirst();
    if (!lot) throw new DomainError("NOT_FOUND", "Entitlement lot not found", 404);
    await lockMemberEntitlementIdentity(trx, lot.member_id);
    await lockEntitlementLots(trx, lot.contract_id);
    return;
  }
  if (commandType === "ISSUE_TOKEN") {
    const subjectId = requireString(input, "subjectId");
    await lockSubjectForProperty(trx, propertyId, subjectId, "Subject not found");
    return;
  }
  if (commandType === "ROTATE_TOKEN" || commandType === "REVOKE_TOKEN") {
    await lockTokenLifecycleTarget(trx, propertyId, requireString(input, "tokenId"));
    return;
  }

  if (commandType === "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP") {
    const orderId = requireString(input, "orderId");
    const memberId = requireString(input, "memberId");
    await lockMemberEntitlementIdentity(trx, memberId);
    await loadLockedOrderContextForProperty(trx, propertyId, orderId);
    await trx.selectFrom("membership_products").select("id")
      .where("id", "=", requireString(input, "membershipProductId"))
      .executeTakeFirst();
    const rawCollectionFactIds = input.collectionFactIds;
    if (Array.isArray(rawCollectionFactIds)) {
      const collectionFactIds = [...new Set(rawCollectionFactIds
        .filter((value): value is string => typeof value === "string" && value.trim() !== "")
        .map((value) => value.trim()))].sort();
      for (const factId of collectionFactIds) {
        await sql`select pg_advisory_xact_lock(hashtextextended(${`qintopia:stay-collection-transfer:${factId}`}, 0::bigint))`.execute(trx);
      }
      if (collectionFactIds.length > 0) {
        await trx.selectFrom("collection_facts")
          .select("fact_id")
          .where("fact_id", "in", collectionFactIds)
          .forUpdate()
          .execute();
        await trx.selectFrom("stay_collection_membership_transfers")
          .select("id")
          .where("source_collection_fact_id", "in", collectionFactIds)
          .forUpdate()
          .execute();
      }
    }
    return;
  }

  const orderId = requireString(input, "orderId");
  const orderIdentity = await trx.selectFrom("orders")
    .select(["member_id", "member_contract_id"])
    .where("id", "=", orderId)
    .where("property_id", "=", propertyId)
    .executeTakeFirst();
  if (!orderIdentity) throw new DomainError("NOT_FOUND", "Order not found", 404);
  const entitlementOwnerId = await resolveQuoteMemberEntitlementOwner(
    trx,
    propertyId,
    orderIdentity.member_id ?? undefined,
    orderIdentity.member_contract_id ?? undefined
  );
  if (entitlementOwnerId) {
    await lockMemberEntitlementIdentity(trx, entitlementOwnerId);
  }
  const context = await loadLockedOrderContextForProperty(trx, propertyId, orderId);
  if (context.order.member_id !== orderIdentity.member_id
    || context.order.member_contract_id !== orderIdentity.member_contract_id) {
    throw new DomainError("AGGREGATE_VERSION_CONFLICT", "Order membership identity changed", 409);
  }
  if (entitlementOwnerId) {
    await lockMemberEntitlementLots(trx, propertyId, entitlementOwnerId);
  } else {
    await lockEntitlementLots(trx, context.order.member_contract_id ?? undefined);
  }

  // A competing completion can close the order and release every Claim while
  // this transaction waits on the order lock. Let effect rebuilding classify
  // that lifecycle change as a stale Preview; still fail closed on a broken
  // RESERVED / PLANNED inventory timeline.
  if (commandType === "COMPLETE_STAY"
    && (context.order.status !== "RESERVED" || context.stay.status !== "PLANNED")) {
    return;
  }

  if (commandType === "REVOKE_CHECK_OUT") {
    await lockCheckoutReversalInventory(trx, context);
    return;
  }
  if (commandType === "MANAGE_ORDER_OCCUPANTS") {
    if (!["RESERVED", "CHECKED_IN"].includes(context.order.status)) return;
    const timeline = await loadActiveStayTimeline(trx, context);
    await trx.selectFrom("inventory_units").select("id")
      .where("id", "in", [...new Set(timeline.map((day) => day.inventoryUnitId))].sort())
      .orderBy("id").forShare().execute();
    return;
  }
  if (["RESCHEDULE_STAY", "SHORTEN_STAY", "EXTEND_STAY", "MOVE_UNIT", "CANCEL_ORDER", "MARK_NO_SHOW", "REVOKE_CHECK_IN", "CHECK_OUT", "COMPLETE_STAY"].includes(commandType)) {
    const timeline = await loadActiveStayTimeline(trx, context);
    const roomDates = await roomDatesForTimeline(trx, propertyId, timeline);
    if (commandType === "RESCHEDULE_STAY" || commandType === "EXTEND_STAY") {
      const plannedTimeline = planStayDateChangeTimeline({
        currentTimeline: timeline,
        oldArrivalDate: context.order.arrival_date,
        oldDepartureDate: context.order.departure_date,
        newArrivalDate: commandType === "RESCHEDULE_STAY"
          ? requireString(input, "newArrivalDate")
          : context.order.arrival_date,
        newDepartureDate: requireString(input, "newDepartureDate")
      });
      roomDates.push(...await roomDatesForTimeline(trx, propertyId, plannedTimeline));
    }
    if (commandType === "MOVE_UNIT") {
      const newInventoryUnitId = requireString(input, "newInventoryUnitId");
      const target = await trx.selectFrom("inventory_units")
        .select(["id", "parent_room_id"])
        .where("id", "=", newInventoryUnitId)
        .where("property_id", "=", propertyId)
        .executeTakeFirst();
      if (!target) throw new DomainError("NOT_FOUND", "Inventory unit not found", 404);
      const metadataUnitIds = [...new Set([target.id, target.parent_room_id].filter((id): id is string => Boolean(id)))].sort();
      await trx.selectFrom("inventory_units")
        .select("id")
        .where("id", "in", metadataUnitIds)
        .orderBy("id")
        .forUpdate()
        .execute();
      const newUnit = await loadInventoryUnit(trx, propertyId, newInventoryUnitId);
      const effectiveDate = requireString(input, "effectiveDate");
      parseLocalDate(effectiveDate);
      roomDates.push(...enumerateServiceDates(effectiveDate, context.order.departure_date)
        .map((serviceDate) => ({ roomId: newUnit.roomId, serviceDate })));
    }
    await lockRoomDays(trx, roomDates);
  }
  if (commandType === "RECORD_REFUND") {
    await trx.selectFrom("collection_facts")
      .innerJoin("orders", "orders.id", "collection_facts.order_id")
      .select("collection_facts.fact_id")
      .where("collection_facts.fact_id", "=", requireString(input, "referencesFactId"))
      .where("orders.property_id", "=", propertyId)
      .forUpdate("collection_facts")
      .executeTakeFirst();
  }
  if (commandType === "REVERSE_FACT") {
    await trx.selectFrom("collection_facts")
      .innerJoin("orders", "orders.id", "collection_facts.order_id")
      .select("collection_facts.fact_id")
      .where("collection_facts.fact_id", "=", requireString(input, "reversesFactId"))
      .where("orders.property_id", "=", propertyId)
      .forUpdate("collection_facts")
      .executeTakeFirst();
  }
}

async function insertRevision(trx: Transaction<Database>, options: {
  orderId: string;
  revisionNo: number;
  amendmentId: string;
  policyVersionId: string;
  arrivalDate: string;
  departureDate: string;
  pricing: ReturnType<typeof pricingSnapshot>;
}): Promise<string> {
  const id = newId("revision");
  await trx.insertInto("pricing_revisions").values({
    id,
    order_id: options.orderId,
    revision_no: options.revisionNo,
    amendment_id: options.amendmentId,
    policy_version_id: options.policyVersionId,
    arrival_date: options.arrivalDate,
    departure_date: options.departureDate,
    coverage_set: JSON.stringify(options.pricing.coverageSet),
    cash_lines: JSON.stringify(options.pricing.cashLines),
    policy_base_amount_minor: options.pricing.policyBaseAmountMinor,
    pricing_basis: options.pricing.pricingBasis,
    manual_adjustment_minor: options.pricing.manualAdjustmentMinor,
    current_contract_amount_minor: options.pricing.currentContractAmountMinor,
    currency: options.pricing.currency
  }).execute();
  return id;
}

async function bumpMembershipForCoverage(trx: Transaction<Database>, contractId: string | null, coverageSet: CoverageItemDto[]): Promise<void> {
  if (coverageSet.length === 0) return;
  const lotIds = [...new Set(coverageSet.map((item) => item.entitlementLotId))];
  const lots = await trx.selectFrom("entitlement_lots").select(["id", "contract_id"]).where("id", "in", lotIds).execute();
  if (lots.length !== lotIds.length) throw new DomainError("ENTITLEMENT_CONFLICT", "会员权益批次不存在", 409);
  for (const ownerContractId of new Set(lots.map((lot) => lot.contract_id))) {
    if (!contractId && !ownerContractId) continue;
    await incrementContractAndLotVersions(trx, ownerContractId, lots.filter((lot) => lot.contract_id === ownerContractId).map((lot) => lot.id));
  }
}

export async function applyCommand(trx: Transaction<Database>, options: {
  commandType: CommandType;
  input: unknown;
  effect: Record<string, unknown>;
  reason: CommandReason;
  commandId: string;
}): Promise<AppliedCommand> {
  const input = requireObject(options.input);
  const propertyId = requireString(input, "propertyId");
  const effect = options.effect;
  if (options.commandType === "MANAGE_ROOM_CATALOG") return applyRoomCatalogEffect(trx, options.commandId, effect, options.reason.note);

  if (isMemberCorrectionCommandType(options.commandType)) {
    return applyMemberCorrectionCommand(trx, {
      commandType: options.commandType,
      propertyId,
      effect,
      commandId: options.commandId,
      reason: options.reason
    });
  }

  if (options.commandType === "CREATE_MEMBER") {
    const operation = requireString(effect, "operation");
    const memberProfile = nestedObject(effect, "member");
    const propertyLink = nestedObject(effect, "propertyLink");
    if (operation !== "CREATE_MEMBER_PROFILE"
      || effect.memberId !== null
      || requireString(propertyLink, "operation") !== "CREATE") {
      throw new DomainError("INTERNAL_ERROR", "Member registration effect has an invalid operation", 500);
    }
    const memberId = newId("member");
    try {
      await trx.insertInto("members").values({
        id: memberId,
        identity_card_number: optionalIdentityCardNumber(memberProfile.identityCardNumber),
        nickname: requireString(memberProfile, "nickname"),
        full_name: requireString(memberProfile, "fullName"),
        phone: normalizePhoneNumber(memberProfile.phone),
        wechat: requireString(memberProfile, "wechat")
      }).execute();
      await trx.insertInto("member_property_links").values({
        member_id: memberId,
        property_id: propertyId
      }).execute();
      return {
        persistedResult: { memberId, memberCreated: true },
        resourceRefs: [memberId],
        factRefs: []
      };
    } catch (error) {
      rethrowMemberRegistrationConflict(error);
    }
  }

  if (options.commandType === "CREATE_MEMBERSHIP_ORDER") {
    const member = nestedObject(effect, "member");
    const product = nestedObject(effect, "product");
    const pricing = nestedObject(effect, "pricing");
    const listedPrice = moneyMinor(pricing.listedPrice, "listedPrice");
    const agreedPrice = moneyMinor(pricing.agreedPrice, "agreedPrice");
    const adjustment = moneyMinor(pricing.adjustment, "adjustment");
    const adjustmentReason = typeof pricing.adjustmentReason === "string" ? pricing.adjustmentReason : null;
    const entitlementUnitKind = requireString(product, "entitlementUnitKind");
    const allowedInventoryKind = requireString(product, "allowedInventoryKind");
    if (entitlementUnitKind !== "ROOM_NIGHT" && entitlementUnitKind !== "BED_NIGHT") throw new DomainError("INTERNAL_ERROR", "Invalid membership entitlement unit", 500);
    if (allowedInventoryKind !== "ROOM" && allowedInventoryKind !== "BED") throw new DomainError("INTERNAL_ERROR", "Invalid membership inventory kind", 500);
    const entitlementUnits = product.entitlementUnits;
    const productVersion = product.version;
    if (!Number.isInteger(entitlementUnits) || (entitlementUnits as number) <= 0 || !Number.isInteger(productVersion) || (productVersion as number) <= 0) {
      throw new DomainError("INTERNAL_ERROR", "Invalid membership product snapshot", 500);
    }
    const membershipOrderId = newId("membership_order");
    await trx.insertInto("membership_orders").values({
      id: membershipOrderId,
      property_id: propertyId,
      member_id: requireString(member, "memberId"),
      product_id: requireString(product, "productId"),
      product_code: requireString(product, "code"),
      product_version: productVersion as number,
      product_name: requireString(product, "name"),
      listed_price_minor: listedPrice.minorUnits,
      agreed_price_minor: agreedPrice.minorUnits,
      price_adjustment_minor: adjustment.minorUnits,
      price_adjustment_reason: adjustmentReason,
      currency: agreedPrice.currency,
      entitlement_unit_kind: entitlementUnitKind,
      entitlement_units: entitlementUnits as number,
      allowed_room_type_code: requireString(product, "allowedRoomTypeCode"),
      allowed_inventory_kind: allowedInventoryKind,
      status: "DRAFT",
      activated_at: null,
      valid_from: null,
      valid_until: null,
      contract_id: null,
      entitlement_lot_id: null,
      version: 1,
      created_by_command_id: options.commandId,
      activated_by_command_id: null
    }).execute();
    return {
      persistedResult: { membershipOrderId, status: "DRAFT" },
      resourceRefs: [membershipOrderId, requireString(member, "memberId")],
      factRefs: []
    };
  }

  if (options.commandType === "RECORD_MEMBERSHIP_PAYMENT") {
    const payment = nestedObject(effect, "payment");
    const amount = moneyMinor(payment.amount, "payment.amount");
    const factId = newId("membership_payment");
    const membershipOrderId = requireString(effect, "membershipOrderId");
    const status = requireString(effect, "status");
    if (status !== "DRAFT" && status !== "ACTIVE") {
      throw new DomainError("INTERNAL_ERROR", "Membership payment effect has an invalid order status", 500);
    }
    await trx.insertInto("membership_payment_facts").values({
      fact_id: factId,
      membership_order_id: membershipOrderId,
      fact_type: "COLLECTION",
      amount_minor: amount.minorUnits,
      net_effect_minor: amount.minorUnits,
      currency: amount.currency,
      transaction_reference: requireTransactionReference(payment.transactionReference),
      corrects_fact_id: null,
      reverses_fact_id: null,
      note: typeof payment.note === "string" ? payment.note : "",
      command_id: options.commandId,
      business_date: requireString(payment, "businessDate")
    }).execute();
    if (status === "DRAFT") {
      await trx.updateTable("membership_orders").set({ version: sql`version + 1`, updated_at: new Date() })
        .where("id", "=", membershipOrderId).where("status", "=", "DRAFT").executeTakeFirstOrThrow();
    }
    return { persistedResult: { membershipOrderId, paymentFactId: factId, status }, resourceRefs: [membershipOrderId], factRefs: [factId] };
  }

  if (options.commandType === "CORRECT_MEMBERSHIP_PAYMENT") {
    const originalPaymentFactId = requireString(effect, "originalPaymentFactId");
    const original = nestedObject(effect, "original");
    const replacement = nestedObject(effect, "replacement");
    const originalAmount = moneyMinor(original.amount, "original.amount");
    const replacementAmount = moneyMinor(replacement.amount, "replacement.amount");
    const membershipOrderId = requireString(effect, "membershipOrderId");
    const reversalFactId = newId("membership_payment_reversal");
    const replacementFactId = newId("membership_payment");
    const note = typeof replacement.note === "string" ? replacement.note : "";
    await trx.insertInto("membership_payment_facts").values({
      fact_id: reversalFactId,
      membership_order_id: membershipOrderId,
      fact_type: "REVERSAL",
      amount_minor: originalAmount.minorUnits,
      net_effect_minor: -originalAmount.minorUnits,
      currency: originalAmount.currency,
      transaction_reference: null,
      corrects_fact_id: null,
      reverses_fact_id: originalPaymentFactId,
      note: `更正原企微收款：${note}`,
      command_id: options.commandId,
      business_date: requireString(original, "businessDate")
    }).execute();
    await trx.insertInto("membership_payment_facts").values({
      fact_id: replacementFactId,
      membership_order_id: membershipOrderId,
      fact_type: "COLLECTION",
      amount_minor: replacementAmount.minorUnits,
      net_effect_minor: replacementAmount.minorUnits,
      currency: replacementAmount.currency,
      transaction_reference: requireTransactionReference(replacement.transactionReference),
      corrects_fact_id: originalPaymentFactId,
      reverses_fact_id: null,
      note,
      command_id: options.commandId,
      business_date: requireString(replacement, "businessDate")
    }).execute();
    await trx.updateTable("membership_orders").set({ version: sql`version + 1`, updated_at: new Date() })
      .where("id", "=", membershipOrderId).where("status", "=", "DRAFT").executeTakeFirstOrThrow();
    return {
      persistedResult: { membershipOrderId, originalPaymentFactId, reversalFactId, replacementFactId, status: "DRAFT" },
      resourceRefs: [membershipOrderId],
      factRefs: [reversalFactId, replacementFactId]
    };
  }

  if (options.commandType === "ACTIVATE_MEMBERSHIP_ORDER") {
    const membershipOrderId = requireString(effect, "membershipOrderId");
    const order = await trx.selectFrom("membership_orders")
      .innerJoin("members", "members.id", "membership_orders.member_id")
      .selectAll("membership_orders")
      .select("members.full_name as member_name")
      .where("membership_orders.id", "=", membershipOrderId)
      .where("membership_orders.property_id", "=", propertyId)
      .where("membership_orders.status", "=", "DRAFT")
      .executeTakeFirst();
    if (!order) throw new DomainError("AGGREGATE_VERSION_CONFLICT", "会员订单已经生效或不存在", 409);
    const contractId = newId("contract");
    const lotId = newId("lot");
    const activatedAt = new Date();
    const validFrom = requireString(effect, "validFrom");
    const validUntil = requireString(effect, "validUntil");
    const entitlementUnitKind = requireString(effect, "entitlementUnitKind");
    const entitlementUnits = effect.entitlementUnits;
    if ((entitlementUnitKind !== "ROOM_NIGHT" && entitlementUnitKind !== "BED_NIGHT") || !Number.isInteger(entitlementUnits) || (entitlementUnits as number) <= 0) {
      throw new DomainError("INTERNAL_ERROR", "Invalid activation entitlement", 500);
    }
    const [activeOrders, activeContracts, activeLots] = await Promise.all([
      trx.selectFrom("membership_orders").select("id")
        .where("property_id", "=", propertyId)
        .where("member_id", "=", order.member_id)
        .where("status", "=", "ACTIVE")
        .orderBy("id")
        .execute(),
      trx.selectFrom("member_contracts").select("id")
        .where("property_id", "=", propertyId)
        .where("member_id", "=", order.member_id)
        .where("status", "=", "ACTIVE")
        .orderBy("id")
        .execute(),
      trx.selectFrom("entitlement_lots")
        .innerJoin("member_contracts", "member_contracts.id", "entitlement_lots.contract_id")
        .select("entitlement_lots.id")
        .where("member_contracts.property_id", "=", propertyId)
        .where("member_contracts.member_id", "=", order.member_id)
        .where("entitlement_lots.status", "=", "ACTIVE")
        .orderBy("entitlement_lots.id")
        .execute()
    ]);
    if (activeOrders.length > 0 || activeContracts.length > 0 || activeLots.length > 0) {
      throw new DomainError("ENTITLEMENT_CONFLICT", "该会员已有有效会员链，不能再次激活会员订单", 409);
    }
    await trx.insertInto("member_contracts").values({
      id: contractId,
      property_id: propertyId,
      member_id: order.member_id,
      member_name: order.member_name,
      status: "ACTIVE",
      valid_from: validFrom,
      valid_until: validUntil,
      version: 1,
      membership_order_id: membershipOrderId
    }).execute();
    await trx.insertInto("entitlement_lots").values({
      id: lotId,
      contract_id: contractId,
      unit_kind: entitlementUnitKind,
      total_units: entitlementUnits as number,
      expires_on: validUntil,
      version: 1
    }).execute();
    const updated = await trx.updateTable("membership_orders").set({
      status: "ACTIVE",
      activated_at: activatedAt,
      valid_from: validFrom,
      valid_until: validUntil,
      contract_id: contractId,
      entitlement_lot_id: lotId,
      version: sql`version + 1`,
      activated_by_command_id: options.commandId,
      updated_at: activatedAt
    }).where("id", "=", membershipOrderId).where("status", "=", "DRAFT").returning("id").executeTakeFirst();
    if (!updated) throw new DomainError("AGGREGATE_VERSION_CONFLICT", "会员订单已经生效", 409);
    return {
      persistedResult: { membershipOrderId, status: "ACTIVE", contractId, entitlementLotId: lotId, validFrom, validUntil, entitlementUnits },
      resourceRefs: [membershipOrderId, contractId, lotId],
      factRefs: []
    };
  }

  if (options.commandType === "CREATE_ORDER") {
    const orderId = newId("order");
    const stayId = newId("stay");
    const amendmentId = newId("amend");
    const segmentId = newId("segment");
    const pricing = pricingSnapshot(effect);
    const inventoryUnit = nestedObject(effect, "inventoryUnit");
    const temporaryOtherRoomArrangement = temporaryOtherRoomArrangementFromEffect(effect);
    const temporaryOtherRoomReason = temporaryOtherRoomArrangement ? requireString(effect, "temporaryOtherRoomReason") : null;
    if (temporaryOtherRoomReason && temporaryOtherRoomReason.length > 200) {
      throw new DomainError("INTERNAL_ERROR", "Temporary other-room reason is too long", 500);
    }
    const primaryGuest = nestedObject(effect, "primaryGuest");
    requireString(primaryGuest, "fullName");
    requireString(primaryGuest, "nickname");
    if (!Array.isArray(effect.occupants) || effect.occupants.length < 1) {
      throw new DomainError("INTERNAL_ERROR", "Create order effect has no occupants", 500);
    }
    const occupants = effect.occupants.map((value, index) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new DomainError("INTERNAL_ERROR", `Create order occupant ${index + 1} is invalid`, 500);
      }
      const occupant = value as Record<string, unknown>;
      const id = requireString(occupant, "id");
      const ordinal = occupant.ordinal;
      const role = occupant.role;
      if (!Number.isSafeInteger(ordinal) || ordinal !== index + 1
        || role !== (index === 0 ? "PRIMARY" : "ADDITIONAL")) {
        throw new DomainError("INTERNAL_ERROR", `Create order occupant ${index + 1} ordering is invalid`, 500);
      }
      return {
        id,
        ordinal: ordinal as number,
        role: role as "PRIMARY" | "ADDITIONAL",
        fullName: requireString(occupant, "fullName"),
        nickname: requireString(occupant, "nickname"),
        phone: typeof occupant.phone === "string" && occupant.phone.trim() ? occupant.phone.trim() : null,
        documentNumber: typeof occupant.documentNumber === "string" && occupant.documentNumber.trim()
          ? occupant.documentNumber.trim()
          : null
      };
    });
    const unitId = requireString(inventoryUnit, "id");
    const arrivalDate = requireString(effect, "arrivalDate");
    const departureDate = requireString(effect, "departureDate");
    const stayType = requireString(effect, "stayType");
    const policyVersionId = requireString(effect, "pricingPolicyVersionId");
    const memberId = typeof effect.memberId === "string" ? effect.memberId : null;
    const memberContractId = typeof effect.memberContractId === "string" ? effect.memberContractId : null;
    const memberStay = Boolean(memberId || memberContractId);
    if (temporaryOtherRoomArrangement) {
      const effectInventoryKind = requireString(inventoryUnit, "kind");
      const effectRoomTypeCode = requireString(inventoryUnit, "roomTypeCode");
      if (!memberId
        || memberContractId !== temporaryOtherRoomArrangement.memberContractId
        || unitId !== temporaryOtherRoomArrangement.actualInventoryUnitId
        || effectInventoryKind !== "ROOM"
        || effectRoomTypeCode !== temporaryOtherRoomArrangement.actualRoomTypeCode
        || arrivalDate !== temporaryOtherRoomArrangement.arrivalDate
        || departureDate !== temporaryOtherRoomArrangement.departureDate
        || pricing.coverageSet.length !== enumerateServiceDates(arrivalDate, departureDate).length
        || pricing.coverageSet.some((item) => item.inventoryUnitId !== unitId
          || item.entitlementLotId !== temporaryOtherRoomArrangement.entitlementLotId
          || item.unitKind !== "ROOM_NIGHT")
        || pricing.cashLines.length !== 0
        || pricing.currentContractAmountMinor !== 0
        || pricing.manualAdjustmentMinor !== 0) {
        throw new DomainError("INTERNAL_ERROR", "Temporary other-room create-order effect is inconsistent", 500);
      }
    }
    const backfill = effect.backfill && typeof effect.backfill === "object" && !Array.isArray(effect.backfill)
      ? effect.backfill as Record<string, unknown>
      : null;
    if (backfill && !currentReleaseFeatures.completedStayBackfillCreation) {
      throw new DomainError("VALIDATION_ERROR", "补录提交将在 8.3 开放", 409);
    }
    const backfillStatus = backfill ? requireString(backfill, "resultingOrderStatus") : "RESERVED";
    const backfillStayStatus = backfill ? requireString(backfill, "resultingStayStatus") : "PLANNED";
    if (!(["RESERVED", "CHECKED_IN", "CHECKED_OUT"] as string[]).includes(backfillStatus)
      || !(["PLANNED", "IN_HOUSE", "COMPLETED"] as string[]).includes(backfillStayStatus)) {
      throw new DomainError("INTERNAL_ERROR", "Create order backfill status is invalid", 500);
    }
    if (backfill) {
      const lockedReason = requireString(backfill, "reason");
      const businessDate = requireString(backfill, "businessDate");
      const completedBackfill = backfillStatus === "CHECKED_OUT" && backfillStayStatus === "COMPLETED";
      const inHouseBackfill = backfillStatus === "CHECKED_IN" && backfillStayStatus === "IN_HOUSE";
      if (!completedBackfill && !inHouseBackfill) {
        throw new DomainError("INTERNAL_ERROR", "Create order backfill lifecycle pair is invalid", 500);
      }
      if (arrivalDate >= businessDate
        || (completedBackfill && departureDate > businessDate)
        || (inHouseBackfill && departureDate <= businessDate)) {
        throw new DomainError("INTERNAL_ERROR", "Create order backfill dates do not match the locked lifecycle", 500);
      }
      if (options.reason.code !== "BACKFILL_STAY" || options.reason.note.trim() !== lockedReason) {
        throw new DomainError("CONFIRMATION_MISMATCH", "补录确认原因必须与核对页锁定的原因一致", 409);
      }
    } else if (temporaryOtherRoomArrangement) {
      if (options.reason.code !== "TEMPORARY_OTHER_ROOM"
        || !temporaryOtherRoomReason
        || options.reason.note !== temporaryOtherRoomReason) {
        throw new DomainError("CONFIRMATION_MISMATCH", "临时安排确认原因必须与核对页锁定的原因一致", 409);
      }
    } else if (options.reason.code !== "CREATE_STANDARD_ORDER" || options.reason.note !== "") {
      throw new DomainError("CONFIRMATION_MISMATCH", "普通创建订单必须使用标准建单确认原因", 409);
    }
    if (memberStay && (effect.bookingChannelCode !== null || effect.channelOrderReference !== null)) {
      throw new DomainError("VALIDATION_ERROR", "会员住宿不得写入订单来源渠道或渠道订单号");
    }
    if (stayType === "FREE" && (effect.bookingChannelCode !== null || effect.channelOrderReference !== null)) {
      throw new DomainError("VALIDATION_ERROR", "免费入住不得写入订单来源渠道或渠道订单号");
    }
    const { bookingChannelCode, channelOrderReference } = memberStay || stayType === "FREE"
      ? { bookingChannelCode: null, channelOrderReference: null }
      : validateBookingChannel(effect.bookingChannelCode, effect.channelOrderReference);
    const freeStayReason = stayType === "FREE" ? requireString(effect, "freeStayReason") : null;
    const freeStayCategoryCode = stayType === "FREE" ? requireString(effect, "freeStayCategoryCode") : null;
    await trx.insertInto("orders").values({
      id: orderId, property_id: propertyId, status: backfillStatus, stay_type: stayType,
      arrival_date: arrivalDate, departure_date: departureDate, primary_guest_snapshot: primaryGuest,
      booking_channel_code: bookingChannelCode, channel_order_reference: channelOrderReference, free_stay_reason: freeStayReason,
      free_stay_category_code: freeStayCategoryCode,
      pricing_policy_version_id: policyVersionId, member_id: memberId, member_contract_id: memberContractId, current_revision_id: null, version: 1
    }).execute();
    const occupantCreatedAt = new Date();
    const persistedOccupants = occupants.map(({ id, ordinal, role, ...snapshot }) => ({
      id,
      orderId,
      ordinal,
      role,
      ...snapshot,
      createdAt: occupantCreatedAt.toISOString()
    }));
    await trx.insertInto("order_occupants").values(persistedOccupants.map((occupant) => ({
      id: occupant.id,
      order_id: occupant.orderId,
      ordinal: occupant.ordinal,
      role: occupant.role,
      full_name: occupant.fullName,
      nickname: occupant.nickname,
      phone: occupant.phone,
      document_number: occupant.documentNumber,
      created_by_command_id: options.commandId,
      created_at: occupantCreatedAt
    }))).execute();
    await trx.insertInto("stays").values({ id: stayId, order_id: orderId, status: backfillStayStatus }).execute();
    await trx.insertInto("amendments").values({
      id: amendmentId, order_id: orderId, sequence: 1, amendment_type: "CREATE_ORDER",
      reason_code: options.reason.code, reason_note: options.reason.note, prior_version: 0, new_version: 1,
      payload: {
        quoteId: effect.quoteId,
        inventoryUnitId: unitId,
        arrivalDate,
        departureDate,
        primaryGuest,
        occupants,
        bookingChannelCode,
        channelOrderReference,
        freeStayReason,
        freeStayCategoryCode,
        ...(temporaryOtherRoomArrangement ? { temporaryOtherRoomArrangement } : {}),
        pricingDecision: effect.pricingDecision,
        ...(backfill ? { confirmedEffect: effect } : {})
      },
      command_id: options.commandId
    }).execute();
    await trx.insertInto("stay_segments").values({
      id: segmentId, stay_id: stayId, sequence: 1, inventory_unit_id: unitId, arrival_date: arrivalDate,
      departure_date: departureDate, segment_type: "INITIAL", supersedes_segment_id: null, amendment_id: amendmentId
    }).execute();
    const revisionId = await insertRevision(trx, { orderId, revisionNo: 1, amendmentId, policyVersionId, arrivalDate, departureDate, pricing });
    await trx.updateTable("orders").set({ current_revision_id: revisionId }).where("id", "=", orderId).execute();
    const unit = await loadInventoryUnit(trx, propertyId, unitId);
    await createInventoryClaims(trx, { propertyId, unit, dates: enumerateServiceDates(arrivalDate, departureDate), sourceType: "ORDER_SEGMENT", sourceId: segmentId });
    const coverageRefs = memberContractId
      ? await holdCoverage(trx, { orderId, contractId: memberContractId, ...(memberId ? { memberId } : {}), inventoryUnitId: unitId, revisionId, coverageSet: pricing.coverageSet, commandId: options.commandId })
      : { coverageIds: [], factIds: [] };
    if (memberContractId) {
      await bumpMembershipForCoverage(trx, memberContractId, pricing.coverageSet);
    }
    const backfillAmendmentIds: string[] = [];
    let backfillCheckInAmendmentId: string | null = null;
    let backfillCheckOutAmendmentId: string | null = null;
    let backfillCollectionFactId: string | null = null;
    if (backfill) {
      const businessDate = requireString(backfill, "businessDate");
      const checkInId = newId("amend");
      await trx.insertInto("amendments").values({
        id: checkInId, order_id: orderId, sequence: 2, amendment_type: "CHECK_IN",
        reason_code: options.reason.code, reason_note: options.reason.note, prior_version: 1, new_version: 2,
        payload: { fromStatus: "RESERVED", toStatus: "CHECKED_IN", inventoryUnitId: unitId, businessDate, effectiveDate: arrivalDate, recordingMode: businessDate === arrivalDate ? "ON_SCHEDULE" : "LATE_RECORDED" },
        command_id: options.commandId
      }).execute();
      backfillCheckInAmendmentId = checkInId;
      backfillAmendmentIds.push(checkInId);
      if (backfillStatus === "CHECKED_OUT") {
        const checkOutId = newId("amend");
        await trx.insertInto("amendments").values({
          id: checkOutId, order_id: orderId, sequence: 3, amendment_type: "CHECK_OUT",
          reason_code: options.reason.code, reason_note: options.reason.note, prior_version: 2, new_version: 3,
          payload: { fromStatus: "CHECKED_IN", toStatus: "CHECKED_OUT", inventoryUnitId: unitId, businessDate, effectiveDate: departureDate, recordingMode: businessDate === departureDate ? "ON_SCHEDULE" : "LATE_RECORDED" },
          command_id: options.commandId
        }).execute();
        backfillCheckOutAmendmentId = checkOutId;
        backfillAmendmentIds.push(checkOutId);
        await releaseInventoryClaims(trx, "ORDER_SEGMENT", [segmentId]);
        if (memberContractId) await consumeCoverage(trx, orderId, options.commandId);
      }
      await trx.updateTable("orders").set({
        version: backfillStatus === "CHECKED_OUT" ? 3 : 2,
        updated_at: new Date()
      }).where("id", "=", orderId).execute();
      const rawCollection = backfill.collection;
      if (rawCollection !== null && rawCollection !== undefined) {
        const collection = requireObject(rawCollection, "collection");
        const amountMinor = requireInteger(collection, "amountMinor", { min: 0 });
        if (amountMinor > 0) {
          const factId = newId("fact");
          await trx.insertInto("collection_facts").values({
            fact_id: factId, order_id: orderId, fact_type: "COLLECTION", amount_minor: amountMinor,
            net_effect_minor: amountMinor, currency: pricing.currency, references_fact_id: null, reverses_fact_id: null,
            method: requireString(collection, "method"), note: typeof collection.note === "string" ? collection.note : options.reason.note,
            transaction_reference: typeof collection.transactionReference === "string" ? collection.transactionReference : null,
            cash_collector: typeof collection.cashCollector === "string" ? collection.cashCollector : null,
            pricing_revision_id: revisionId, command_id: options.commandId
          }).execute();
          backfillCollectionFactId = factId;
        }
      }
    }
    if (backfill && (!backfillCheckInAmendmentId || (backfillStatus === "CHECKED_OUT" && !backfillCheckOutAmendmentId))) {
      throw new DomainError("INTERNAL_ERROR", "Backfill stay amendment evidence is incomplete", 500);
    }
    if (backfill && backfillStatus === "CHECKED_IN" && backfillCheckOutAmendmentId) {
      throw new DomainError("INTERNAL_ERROR", "In-house backfill must not include checkout evidence", 500);
    }
    const backfillResult = backfill ? {
      businessDate: requireString(backfill, "businessDate"),
      checkInAmendmentId: backfillCheckInAmendmentId,
      checkOutAmendmentId: backfillCheckOutAmendmentId,
      settlementStatus: requireString(backfill, "settlementStatus"),
      collectedAmountMinor: requireInteger(backfill, "collectedAmountMinor", { min: 0 }),
      balanceDueMinor: requireInteger(backfill, "balanceDueMinor", { min: 0 }),
      collectionFactId: backfillCollectionFactId
    } : undefined;
    return {
      persistedResult: { orderId, stayId, segmentId, pricingRevisionId: revisionId, primaryGuest, occupants: persistedOccupants, bookingChannelCode, channelOrderReference, freeStayReason, freeStayCategoryCode, pricingPolicyVersionId: policyVersionId, pricingDecision: effect.pricingDecision, ...(temporaryOtherRoomArrangement ? { temporaryOtherRoomArrangement, temporaryOtherRoomCreateAmendmentId: amendmentId } : {}), ...(backfill ? { status: backfillStatus, backfill: backfillResult } : {}) },
      resourceRefs: [orderId, stayId, segmentId, revisionId, ...backfillAmendmentIds, ...persistedOccupants.map((occupant) => occupant.id), ...coverageRefs.coverageIds],
      factRefs: [...coverageRefs.factIds, ...(backfillCollectionFactId ? [backfillCollectionFactId] : [])]
    };
  }

  if (options.commandType === "LOCK_MAINTENANCE") {
    const maintenanceLockId = newId("maint");
    const unitObject = nestedObject(effect, "inventoryUnit");
    const unitId = requireString(unitObject, "id");
    const arrivalDate = requireString(effect, "arrivalDate");
    const departureDate = requireString(effect, "departureDate");
    await trx.insertInto("maintenance_locks").values({
      id: maintenanceLockId, property_id: propertyId, inventory_unit_id: unitId, arrival_date: arrivalDate,
      departure_date: departureDate, reason: requireString(effect, "reason"), status: "ACTIVE", version: 1,
      created_by_command_id: options.commandId, released_by_command_id: null, released_at: null
    }).execute();
    const unit = await loadInventoryUnit(trx, propertyId, unitId);
    const claimIds = await createInventoryClaims(trx, {
      propertyId,
      unit,
      dates: enumerateServiceDates(arrivalDate, departureDate),
      sourceType: "MAINTENANCE",
      sourceId: maintenanceLockId
    });
    return { persistedResult: { maintenanceLockId }, resourceRefs: [maintenanceLockId], factRefs: claimIds };
  }

  if (options.commandType === "RELEASE_MAINTENANCE") {
    const maintenanceLockId = requireString(effect, "maintenanceLockId");
    const releasedClaimIds = await releaseInventoryClaims(trx, "MAINTENANCE", [maintenanceLockId]);
    const released = await trx.updateTable("maintenance_locks").set({
      status: "RELEASED",
      version: sql`version + 1`,
      released_by_command_id: options.commandId,
      released_at: new Date()
    }).where("id", "=", maintenanceLockId).where("status", "=", "ACTIVE").returning("id").executeTakeFirst();
    if (!released) throw new DomainError("AGGREGATE_VERSION_CONFLICT", "Maintenance lock is already released", 409);
    return {
      persistedResult: { maintenanceLockId, status: "RELEASED" },
      resourceRefs: [maintenanceLockId],
      factRefs: releasedClaimIds
    };
  }

  if (options.commandType === "COMPLETE_CLEANING") {
    if (!currentReleaseFeatures.cleaningWorkflow) {
      throw new DomainError("VALIDATION_ERROR", "Cleaning workflow is disabled in this release", 409);
    }
    const cleaningTaskId = requireString(effect, "cleaningTaskId");
    const updated = await trx.updateTable("cleaning_tasks").set({
      status: "COMPLETED",
      version: sql`version + 1`,
      completed_by_command_id: options.commandId,
      completed_at: new Date()
    }).where("id", "=", cleaningTaskId).where("status", "=", "PENDING").returning("id").executeTakeFirst();
    if (!updated) throw new DomainError("AGGREGATE_VERSION_CONFLICT", "Cleaning task is already completed", 409);
    return {
      persistedResult: { cleaningTaskId, status: "COMPLETED" },
      resourceRefs: [cleaningTaskId],
      factRefs: []
    };
  }

  if (options.commandType === "ADD_MEMBER_ENTITLEMENT_LOT") {
    const contractId = requireString(effect, "contractId");
    const unitKind = requireString(effect, "unitKind");
    if (unitKind !== "ROOM_NIGHT" && unitKind !== "BED_NIGHT") throw new DomainError("INTERNAL_ERROR", "Entitlement lot effect has an invalid unit kind", 500);
    const units = effect.units;
    if (!Number.isInteger(units) || (units as number) <= 0) throw new DomainError("INTERNAL_ERROR", "Entitlement lot effect has invalid units", 500);
    const expiresOn = requireString(effect, "expiresOn");
    const lotId = newId("lot");
    const factId = newId("fact");
    await trx.insertInto("entitlement_lots").values({
      id: lotId, contract_id: contractId, unit_kind: unitKind, total_units: 0, expires_on: expiresOn, version: 1
    }).execute();
    await trx.insertInto("entitlement_ledger").values({
      fact_id: factId, lot_id: lotId, entry_type: "ADJUST", quantity_delta: units as number,
      service_date: null, order_id: null, coverage_id: null,
      reason: `MEMBER_ENTITLEMENT_LOT_ADDED ${options.reason.code}: ${options.reason.note}`,
      command_id: options.commandId
    }).execute();
    await trx.updateTable("member_contracts").set({ version: sql`version + 1` }).where("id", "=", contractId).execute();
    return {
      persistedResult: { entitlementLotId: lotId, contractId, adjustmentFactId: factId, units },
      resourceRefs: [contractId, lotId],
      factRefs: [factId]
    };
  }

  if (options.commandType === "ADJUST_MEMBER_ENTITLEMENT" || options.commandType === "CORRECT_MEMBER_ENTITLEMENT_BALANCE") {
    const lotId = requireString(effect, "entitlementLotId");
    const contractId = requireString(effect, "contractId");
    const factId = newId("fact");
    await trx.insertInto("entitlement_ledger").values({
      fact_id: factId, lot_id: lotId, entry_type: "ADJUST", quantity_delta: effect.quantityDelta as number,
      service_date: null, order_id: null, coverage_id: null, reason: requireString(effect, "adjustmentReason"), command_id: options.commandId
    }).execute();
    await incrementContractAndLotVersions(trx, contractId, [lotId]);
    return {
      persistedResult: {
        entitlementLotId: lotId,
        adjustmentFactId: factId,
        availableBefore: effect.availableBefore,
        availableAfter: effect.availableAfter,
        quantityDelta: effect.quantityDelta
      },
      resourceRefs: [contractId, lotId],
      factRefs: [factId]
    };
  }

  if (options.commandType === "EXPIRE_MEMBER_ENTITLEMENT") {
    const lotId = requireString(effect, "entitlementLotId");
    const contractId = requireString(effect, "contractId");
    const asOfDate = requireString(effect, "asOfDate");
    const remainingAvailable = effect.remainingAvailable;
    if (!Number.isInteger(remainingAvailable) || (remainingAvailable as number) < 0) {
      throw new DomainError("INTERNAL_ERROR", "Expiration effect has an invalid remaining balance", 500);
    }
    const factId = newId("fact");
    await trx.insertInto("entitlement_ledger").values({
      fact_id: factId,
      lot_id: lotId,
      entry_type: "EXPIRE",
      quantity_delta: -(remainingAvailable as number),
      service_date: null,
      order_id: null,
      coverage_id: null,
      reason: `ENTITLEMENT_EXPIRED asOfDate=${asOfDate}`,
      command_id: options.commandId
    }).execute();
    await incrementContractAndLotVersions(trx, contractId, [lotId]);
    return {
      persistedResult: {
        entitlementLotId: lotId,
        contractId,
        factId,
        entryType: "EXPIRE",
        expiredUnits: remainingAvailable,
        remainingAvailable: 0,
        asOfDate
      },
      resourceRefs: [contractId, lotId],
      factRefs: [factId]
    };
  }

  if (options.commandType === "ISSUE_TOKEN") {
    const tokenId = newId("token");
    const secretHash = requireString(input, "tokenSecretHash");
    const subjectId = requireString(effect, "subjectId");
    const commandCeiling = stringArray(effect, "commandCeiling");
    const persistedCommandCeiling = stringArray(effect, "persistedCommandCeiling");
    try {
      await trx.insertInto("api_tokens").values({
        id: tokenId, subject_id: subjectId, label: requireString(effect, "label"), secret_hash: secretHash,
        access_ceiling: requireString(effect, "accessCeiling") as "READ" | "WRITE", property_scope: propertyId,
        expires_at: requireString(effect, "expiresAt"), revoked_at: null, rotated_from_id: null, replaced_by_id: null
      }).execute();
    } catch (error) {
      rethrowTokenSecretConflict(error);
    }
    await insertTokenCommandCeiling(trx, tokenId, subjectId, propertyId, persistedCommandCeiling);
    return {
      persistedResult: {
        tokenId,
        subjectId,
        subjectDisplayName: requireString(effect, "subjectDisplayName"),
        label: requireString(effect, "label"),
        accessCeiling: requireString(effect, "accessCeiling"),
        commandCeiling,
        persistedCommandCeiling,
        expiresAt: requireString(effect, "expiresAt")
      },
      resourceRefs: [tokenId, subjectId],
      factRefs: []
    };
  }

  if (options.commandType === "ROTATE_TOKEN") {
    const oldTokenId = requireString(effect, "tokenId");
    const tokenId = newId("token");
    const secretHash = requireString(input, "tokenSecretHash");
    const subjectId = requireString(effect, "subjectId");
    const commandCeiling = stringArray(effect, "commandCeiling");
    const persistedCommandCeiling = stringArray(effect, "persistedCommandCeiling");
    try {
      await trx.insertInto("api_tokens").values({
        id: tokenId, subject_id: subjectId, label: requireString(effect, "label"), secret_hash: secretHash,
        access_ceiling: requireString(effect, "accessCeiling") as "READ" | "WRITE", property_scope: propertyId,
        expires_at: requireString(effect, "expiresAt"), revoked_at: null, rotated_from_id: oldTokenId, replaced_by_id: null
      }).execute();
    } catch (error) {
      rethrowTokenSecretConflict(error);
    }
    await insertTokenCommandCeiling(trx, tokenId, subjectId, propertyId, persistedCommandCeiling);
    await trx.updateTable("api_tokens").set({ revoked_at: new Date(), replaced_by_id: tokenId })
      .where("id", "=", oldTokenId)
      .where("property_scope", "=", propertyId)
      .execute();
    return {
      persistedResult: {
        tokenId,
        rotatedFromTokenId: oldTokenId,
        subjectId,
        subjectDisplayName: requireString(effect, "subjectDisplayName"),
        label: requireString(effect, "label"),
        accessCeiling: requireString(effect, "accessCeiling"),
        previousCommandCeiling: stringArray(effect, "previousCommandCeiling"),
        commandCeiling,
        previousPersistedCommandCeiling: stringArray(effect, "previousPersistedCommandCeiling"),
        persistedCommandCeiling,
        previousExpiresAt: requireString(effect, "previousExpiresAt"),
        expiresAt: requireString(effect, "expiresAt"),
        historicalReadCeilingPreserved: effect.historicalReadCeilingPreserved === true
      },
      resourceRefs: [oldTokenId, tokenId, subjectId],
      factRefs: []
    };
  }

  if (options.commandType === "REVOKE_TOKEN") {
    const tokenId = requireString(effect, "tokenId");
    const subjectId = requireString(effect, "subjectId");
    await trx.updateTable("api_tokens").set({ revoked_at: new Date() })
      .where("id", "=", tokenId)
      .where("property_scope", "=", propertyId)
      .execute();
    return {
      persistedResult: {
        tokenId,
        subjectId,
        subjectDisplayName: requireString(effect, "subjectDisplayName"),
        label: requireString(effect, "label"),
        accessCeiling: requireString(effect, "accessCeiling"),
        commandCeiling: stringArray(effect, "commandCeiling"),
        persistedCommandCeiling: stringArray(effect, "persistedCommandCeiling"),
        expiresAt: requireString(effect, "expiresAt"),
        historicalReadCeilingPreserved: false,
        revoked: true
      },
      resourceRefs: [tokenId, subjectId],
      factRefs: []
    };
  }

  if (options.commandType === HISTORICAL_STAY_ARRANGEMENT_CORRECTION_COMMAND) {
    return applyHistoricalStayArrangementCorrection(trx, {
      input: options.input,
      effect,
      reason: options.reason,
      commandId: options.commandId
    });
  }

  const orderId = requireString(effect, "orderId");
  const context = await loadLockedOrderContextForProperty(trx, propertyId, orderId);

  if (options.commandType === "MANAGE_ORDER_OCCUPANTS") return applyCompanionEffect(trx, context, effect, options);

  if (options.commandType === "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP") {
    if (requireString(effect, "operation") !== "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP") {
      throw new DomainError("INTERNAL_ERROR", "Stay collection conversion effect has an invalid operation", 500);
    }
    const member = nestedObject(effect, "member");
    const product = nestedObject(effect, "product");
    const transfer = nestedObject(effect, "transfer");
    const membershipPricing = nestedObject(effect, "membershipPricing");
    const entitlement = nestedObject(effect, "entitlement");
    const pricing = pricingSnapshot(effect, {
      stayType: context.order.stay_type,
      memberId: null,
      memberContractId: null
    });
    const listedPrice = moneyMinor(membershipPricing.listedPrice, "membershipPricing.listedPrice");
    const agreedPrice = moneyMinor(membershipPricing.agreedPrice, "membershipPricing.agreedPrice");
    const adjustment = moneyMinor(membershipPricing.adjustment, "membershipPricing.adjustment");
    const adjustmentReason = typeof membershipPricing.adjustmentReason === "string" ? membershipPricing.adjustmentReason : null;
    const transferTotal = moneyMinor(transfer.total, "transfer.total");
    const transferCollectionsValue = transfer.collections;
    if (!Array.isArray(transferCollectionsValue)) {
      throw new DomainError("INTERNAL_ERROR", "Stay collection conversion effect has no source collection", 500);
    }
    const transferCollections = transferCollectionsValue.map((value, index) => {
      const item = requireObject(value, `transfer.collections[${index}]`);
      return {
        factId: requireString(item, "factId"),
        amount: moneyMinor(item.amount, `transfer.collections[${index}].amount`)
      };
    });
    const transferCollectionIds = transferCollections.map((item) => item.factId);
    if (new Set(transferCollectionIds).size !== transferCollectionIds.length) {
      throw new DomainError("INTERNAL_ERROR", "Stay collection conversion effect contains duplicate source collections", 500);
    }
    const transferAmountMinor = transferCollections.reduce((sum, item) => sum + item.amount.minorUnits, 0);
    if (transferAmountMinor !== transferTotal.minorUnits) {
      throw new DomainError("INTERNAL_ERROR", "Stay collection conversion transfer total is inconsistent", 500);
    }
    const entitlementUnitKind = requireString(entitlement, "entitlementUnitKind");
    const allowedInventoryKind = requireString(product, "allowedInventoryKind");
    if (entitlementUnitKind !== "ROOM_NIGHT" && entitlementUnitKind !== "BED_NIGHT") throw new DomainError("INTERNAL_ERROR", "Invalid conversion entitlement unit", 500);
    if (allowedInventoryKind !== "ROOM" && allowedInventoryKind !== "BED") throw new DomainError("INTERNAL_ERROR", "Invalid conversion inventory kind", 500);
    const entitlementUnits = entitlement.entitlementUnits;
    const consumedUnits = entitlement.consumedUnits;
    const remainingUnits = entitlement.remainingUnits;
    const productVersion = product.version;
    if (!Number.isInteger(entitlementUnits) || (entitlementUnits as number) <= 0
      || !Number.isInteger(consumedUnits) || (consumedUnits as number) <= 0
      || !Number.isInteger(remainingUnits) || (remainingUnits as number) < 0
      || (entitlementUnits as number) - (consumedUnits as number) !== remainingUnits
      || !Number.isInteger(productVersion) || (productVersion as number) <= 0) {
      throw new DomainError("INTERNAL_ERROR", "Invalid conversion membership product snapshot", 500);
    }
    const serviceDates = stringArray(entitlement, "serviceDates");
    if (serviceDates.length !== consumedUnits || new Set(serviceDates).size !== serviceDates.length) {
      throw new DomainError("INTERNAL_ERROR", "Conversion consumption dates do not match consumed units", 500);
    }
    const validFrom = requireString(entitlement, "validFrom");
    const validUntil = requireString(entitlement, "validUntil");
    const remainingPayment = effect.remainingPayment === null ? null : nestedObject(effect, "remainingPayment");
    const remainingPaymentAmount = remainingPayment ? moneyMinor(remainingPayment.amount, "remainingPayment.amount") : null;
    if (listedPrice.currency !== agreedPrice.currency
      || adjustment.currency !== agreedPrice.currency
      || transferTotal.currency !== agreedPrice.currency
      || pricing.currency !== agreedPrice.currency
      || transferCollections.some((item) => item.amount.currency !== agreedPrice.currency)
      || (remainingPaymentAmount && remainingPaymentAmount.currency !== agreedPrice.currency)
      || agreedPrice.minorUnits - transferTotal.minorUnits !== (remainingPaymentAmount?.minorUnits ?? 0)
      || adjustment.minorUnits !== agreedPrice.minorUnits - listedPrice.minorUnits) {
      throw new DomainError("INTERNAL_ERROR", "Stay collection conversion money summary is inconsistent", 500);
    }
    if (agreedPrice.minorUnits <= 0) {
      throw new DomainError("INTERNAL_ERROR", "Stay collection conversion requires a positive membership agreed price", 500);
    }

    const membershipOrderId = newId("membership_order");
    await trx.insertInto("membership_orders").values({
      id: membershipOrderId,
      property_id: propertyId,
      member_id: requireString(member, "memberId"),
      product_id: requireString(product, "productId"),
      product_code: requireString(product, "code"),
      product_version: productVersion as number,
      product_name: requireString(product, "name"),
      listed_price_minor: listedPrice.minorUnits,
      agreed_price_minor: agreedPrice.minorUnits,
      price_adjustment_minor: adjustment.minorUnits,
      price_adjustment_reason: adjustmentReason,
      currency: agreedPrice.currency,
      entitlement_unit_kind: entitlementUnitKind,
      entitlement_units: entitlementUnits as number,
      allowed_room_type_code: requireString(product, "allowedRoomTypeCode"),
      allowed_inventory_kind: allowedInventoryKind,
      status: "DRAFT",
      activated_at: null,
      valid_from: null,
      valid_until: null,
      contract_id: null,
      entitlement_lot_id: null,
      version: 1,
      created_by_command_id: options.commandId,
      activated_by_command_id: null
    }).execute();

    const membershipTransferPaymentFactIds: string[] = [];
    const lodgingReversalFactIds: string[] = [];
    const transferIds: string[] = [];
    for (const item of transferCollections) {
      const membershipPaymentFactId = newId("membership_payment");
      await trx.insertInto("membership_payment_facts").values({
        fact_id: membershipPaymentFactId,
        membership_order_id: membershipOrderId,
        fact_type: "COLLECTION",
        amount_minor: item.amount.minorUnits,
        net_effect_minor: item.amount.minorUnits,
        currency: item.amount.currency,
        transaction_reference: null,
        corrects_fact_id: null,
        reverses_fact_id: null,
        source_type: "STAY_COLLECTION_TRANSFER",
        source_order_id: orderId,
        source_collection_fact_id: item.factId,
        note: "升级会员：住宿收款转入",
        command_id: options.commandId,
        business_date: sql<string>`(
          SELECT (source.created_at AT TIME ZONE property_row.timezone)::date
          FROM collection_facts AS source
          JOIN orders AS source_order ON source_order.id = source.order_id
          JOIN properties AS property_row ON property_row.id = source_order.property_id
          WHERE source.fact_id = ${item.factId}
        )`
      }).execute();
      const reversalFactId = newId("fact");
      await trx.insertInto("collection_facts").values({
        fact_id: reversalFactId,
        order_id: orderId,
        fact_type: "REVERSAL",
        amount_minor: item.amount.minorUnits,
        net_effect_minor: -item.amount.minorUnits,
        currency: item.amount.currency,
        references_fact_id: null,
        reverses_fact_id: item.factId,
        method: "REVERSAL",
        note: "升级会员：住宿收款已用于会员订单",
        transaction_reference: null,
        pricing_revision_id: context.revision.id,
        command_id: options.commandId
      }).execute();
      const transferId = newId("transfer");
      await trx.insertInto("stay_collection_membership_transfers").values({
        id: transferId,
        property_id: propertyId,
        order_id: orderId,
        source_collection_fact_id: item.factId,
        source_reversal_fact_id: reversalFactId,
        membership_order_id: membershipOrderId,
        membership_payment_fact_id: membershipPaymentFactId,
        command_id: options.commandId
      }).execute();
      membershipTransferPaymentFactIds.push(membershipPaymentFactId);
      lodgingReversalFactIds.push(reversalFactId);
      transferIds.push(transferId);
    }

    const membershipPaymentFactIds = [...membershipTransferPaymentFactIds];
    if (remainingPayment) {
      const remainingPaymentFactId = newId("membership_payment");
      await trx.insertInto("membership_payment_facts").values({
        fact_id: remainingPaymentFactId,
        membership_order_id: membershipOrderId,
        fact_type: "COLLECTION",
        amount_minor: remainingPaymentAmount!.minorUnits,
        net_effect_minor: remainingPaymentAmount!.minorUnits,
        currency: remainingPaymentAmount!.currency,
        transaction_reference: requireTransactionReference(remainingPayment.transactionReference),
        corrects_fact_id: null,
        reverses_fact_id: null,
        note: typeof remainingPayment.note === "string" ? remainingPayment.note : "",
        command_id: options.commandId,
        business_date: validFrom
      }).execute();
      membershipPaymentFactIds.push(remainingPaymentFactId);
    }

    const contractId = newId("contract");
    const lotId = newId("lot");
    const activatedAt = new Date();
    await trx.insertInto("member_contracts").values({
      id: contractId,
      property_id: propertyId,
      member_id: requireString(member, "memberId"),
      member_name: requireString(member, "fullName"),
      status: "ACTIVE",
      valid_from: validFrom,
      valid_until: validUntil,
      version: 1,
      membership_order_id: membershipOrderId
    }).execute();
    await trx.insertInto("entitlement_lots").values({
      id: lotId,
      contract_id: contractId,
      unit_kind: entitlementUnitKind,
      total_units: entitlementUnits as number,
      expires_on: validUntil,
      version: 1
    }).execute();
    const updatedMembershipOrder = await trx.updateTable("membership_orders").set({
      status: "ACTIVE",
      activated_at: activatedAt,
      valid_from: validFrom,
      valid_until: validUntil,
      contract_id: contractId,
      entitlement_lot_id: lotId,
      version: sql`version + 1`,
      activated_by_command_id: options.commandId,
      updated_at: activatedAt
    }).where("id", "=", membershipOrderId).where("status", "=", "DRAFT").returning("id").executeTakeFirst();
    if (!updatedMembershipOrder) throw new DomainError("AGGREGATE_VERSION_CONFLICT", "会员订单已经生效", 409);

    const amendmentId = await appendAmendment(trx, {
      orderId,
      sequence: context.order.version + 1,
      amendmentType: "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP",
      reasonCode: options.reason.code,
      reasonNote: options.reason.note,
      priorVersion: context.order.version,
      payload: effect,
      commandId: options.commandId
    });
    const revisionId = await insertRevision(trx, {
      orderId,
      revisionNo: context.revision.revisionNo + 1,
      amendmentId,
      policyVersionId: context.order.pricing_policy_version_id,
      arrivalDate: context.order.arrival_date,
      departureDate: context.order.departure_date,
      pricing
    });

    await trx.updateTable("orders").set({
      current_revision_id: revisionId,
      member_id: requireString(member, "memberId"),
      member_contract_id: contractId,
      version: context.order.version + 1,
      updated_at: new Date()
    }).where("id", "=", orderId).execute();

    const inHouseConversion = context.order.status === "CHECKED_IN" && context.stay.status === "IN_HOUSE";
    const conversionTimeline = inHouseConversion ? await loadActiveStayTimeline(trx, context) : [];
    if (inHouseConversion && (conversionTimeline.length !== serviceDates.length
      || conversionTimeline.some((item, index) => item.serviceDate !== serviceDates[index]))) {
      throw new DomainError("INTERNAL_ERROR", "In-house conversion coverage dates do not match the active stay timeline", 500);
    }
    const conversionCoverageIds: string[] = [];
    const conversionLedgerFactIds: string[] = [];
    for (const [index, serviceDate] of serviceDates.entries()) {
      const coverageId = inHouseConversion ? newId("coverage") : null;
      if (coverageId) {
        await trx.insertInto("coverage_items").values({
          id: coverageId,
          order_id: orderId,
          contract_id: contractId,
          lot_id: lotId,
          inventory_unit_id: conversionTimeline[index]!.inventoryUnitId,
          service_date: serviceDate,
          unit_kind: entitlementUnitKind,
          status: "CONSUMED",
          held_by_revision_id: revisionId
        }).execute();
        conversionCoverageIds.push(coverageId);
      }
      const factId = newId("fact");
      await trx.insertInto("entitlement_ledger").values({
        fact_id: factId,
        lot_id: lotId,
        entry_type: "CONVERSION_CONSUME",
        quantity_delta: -1,
        service_date: serviceDate,
        order_id: orderId,
        coverage_id: coverageId,
        reason: "STAY_COLLECTION_TO_MEMBERSHIP_CONSUMED",
        command_id: options.commandId
      }).execute();
      conversionLedgerFactIds.push(factId);
    }
    await incrementContractAndLotVersions(trx, contractId, [lotId]);
    return {
      persistedResult: {
        orderId,
        memberId: requireString(member, "memberId"),
        amendmentId,
        pricingRevisionId: revisionId,
        membershipOrderId,
        status: "ACTIVE",
        contractId,
        entitlementLotId: lotId,
        transferredCollectionFactIds: transferCollectionIds,
        lodgingReversalFactIds,
        membershipPaymentFactIds,
        transferIds,
        conversionMode: inHouseConversion ? "IN_HOUSE" : "COMPLETED",
        conversionCoverageIds,
        conversionLedgerFactIds,
        transferredAmount: { currency: transferTotal.currency, minorUnits: transferTotal.minorUnits },
        membershipAgreedPrice: { currency: agreedPrice.currency, minorUnits: agreedPrice.minorUnits },
        remainingPaymentAmount: remainingPaymentAmount
          ? { currency: remainingPaymentAmount.currency, minorUnits: remainingPaymentAmount.minorUnits }
          : { currency: agreedPrice.currency, minorUnits: 0 },
        entitlementUnitKind,
        convertedUnits: consumedUnits,
        remainingUnits
      },
      resourceRefs: [orderId, amendmentId, revisionId, membershipOrderId, contractId, lotId, ...transferIds, ...conversionCoverageIds],
      factRefs: [...lodgingReversalFactIds, ...membershipPaymentFactIds, ...conversionLedgerFactIds]
    };
  }

  if (options.commandType === "CORRECT_ORDER_OCCUPANT") {
    const occupantId = requireString(effect, "occupantId");
    const before = nestedObject(effect, "before");
    const after = nestedObject(effect, "after");
    const latest = await trx.selectFrom("order_occupant_corrections")
      .select("sequence")
      .where("occupant_id", "=", occupantId)
      .orderBy("sequence", "desc")
      .executeTakeFirst();
    const amendmentId = await appendAmendment(trx, {
      orderId,
      sequence: context.order.version + 1,
      amendmentType: options.commandType,
      reasonCode: options.reason.code,
      reasonNote: options.reason.note,
      priorVersion: context.order.version,
      payload: effect,
      commandId: options.commandId
    });
    const correctionId = newId("fact");
    const command = await trx.selectFrom("command_executions")
      .select("subject_id")
      .where("id", "=", options.commandId)
      .executeTakeFirstOrThrow();
    const nullableSnapshotString = (snapshot: Record<string, unknown>, field: string): string | null => {
      const value = snapshot[field];
      if (value === null) return null;
      return requireString(snapshot, field);
    };
    await trx.insertInto("order_occupant_corrections").values({
      id: correctionId,
      order_id: orderId,
      occupant_id: occupantId,
      sequence: (latest?.sequence ?? 0) + 1,
      prior_full_name: before.fullName === null ? null : requireString(before, "fullName"),
      prior_nickname: before.nickname === null ? null : requireString(before, "nickname"),
      prior_phone: nullableSnapshotString(before, "phone"),
      prior_document_number: nullableSnapshotString(before, "documentNumber"),
      corrected_full_name: requireString(after, "fullName"),
      corrected_nickname: requireString(after, "nickname"),
      corrected_phone: nullableSnapshotString(after, "phone"),
      corrected_document_number: nullableSnapshotString(after, "documentNumber"),
      reason_code: options.reason.code,
      reason_note: options.reason.note,
      actor_subject_id: command.subject_id,
      amendment_id: amendmentId,
      created_by_command_id: options.commandId
    }).execute();
    await trx.updateTable("orders").set({
      version: context.order.version + 1,
      updated_at: new Date()
    }).where("id", "=", orderId).execute();
    return {
      persistedResult: {
        orderId,
        occupantId,
        correctionId,
        amendmentId,
        occupant: after,
        ...temporaryOtherRoomReceiptEvidenceFromEffect(effect)
      },
      resourceRefs: [orderId, occupantId, correctionId, amendmentId],
      factRefs: []
    };
  }

  if (options.commandType === "RESCHEDULE_STAY" || options.commandType === "EXTEND_STAY") {
    const amendmentId = await appendAmendment(trx, {
      orderId,
      sequence: context.order.version + 1,
      amendmentType: options.commandType,
      reasonCode: options.reason.code,
      reasonNote: options.reason.note,
      priorVersion: context.order.version,
      payload: effect,
      commandId: options.commandId
    });
    const after = nestedObject(effect, "after");
    const arrivalDate = requireString(after, "arrivalDate");
    const departureDate = requireString(after, "departureDate");
    const stayTimeline = stayTimelineFromEffect(effect);
    const inventoryUnitId = requireString(effect, "inventoryUnitId");
    const currentTimeline = await loadActiveStayTimeline(trx, context);
    const expectedTimeline = planStayDateChangeTimeline({
      currentTimeline,
      oldArrivalDate: context.order.arrival_date,
      oldDepartureDate: context.order.departure_date,
      newArrivalDate: arrivalDate,
      newDepartureDate: departureDate
    });
    if (stayTimeline.length !== expectedTimeline.length || stayTimeline.some((item, index) => (
      item.serviceDate !== expectedTimeline[index]?.serviceDate
      || item.inventoryUnitId !== expectedTimeline[index]?.inventoryUnitId
    ))) {
      throw new DomainError("INTERNAL_ERROR", "调整住宿日期的结果与方案 B 时间线不一致", 500);
    }
    const currentTail = trailingTimelineRun(stayTimeline);
    if (inventoryUnitId !== currentTail.inventoryUnitId) {
      throw new DomainError("INTERNAL_ERROR", "调整住宿日期的尾段房源不一致", 500);
    }
    const segmentArrivalDate = currentTail.arrivalDate;
    const inventoryChange = nestedObject(effect, "inventoryChange");
    const releasedDates = stringArray(inventoryChange, "releasedDates");
    const addedDates = stringArray(inventoryChange, "addedDates");
    const preservedDates = stringArray(inventoryChange, "preservedDates");
    const pairDiff = timelinePairDiff(currentTimeline, stayTimeline);
    const sameDates = (actual: string[], expected: StayTimelineItem[]) => actual.length === expected.length
      && actual.every((date, index) => date === expected[index]?.serviceDate);
    if (!sameDates(preservedDates, pairDiff.preserved)
      || !sameDates(releasedDates, pairDiff.released)
      || !sameDates(addedDates, pairDiff.added)) {
      throw new DomainError("INTERNAL_ERROR", "调整住宿日期的库存差异与完整时间线不一致", 500);
    }
    const pricing = pricingSnapshot(effect, {
      stayType: context.order.stay_type,
      memberId: context.order.member_id,
      memberContractId: context.order.member_contract_id
    });
    const segmentId = newId("segment");
    await trx.insertInto("stay_segments").values({
      id: segmentId,
      stay_id: context.stay.id,
      sequence: context.currentSegment.sequence + 1,
      inventory_unit_id: inventoryUnitId,
      arrival_date: segmentArrivalDate,
      departure_date: departureDate,
      segment_type: options.commandType,
      supersedes_segment_id: context.currentSegment.id,
      amendment_id: amendmentId
    }).execute();

    const revisionId = await insertRevision(trx, {
      orderId,
      revisionNo: context.revision.revisionNo + 1,
      amendmentId,
      policyVersionId: context.order.pricing_policy_version_id,
      arrivalDate,
      departureDate,
      pricing
    });

    const releasedClaimIds = await releaseInventoryClaimsOnDates(
      trx,
      "ORDER_SEGMENT",
      context.segmentIds,
      releasedDates
    );
    if (releasedClaimIds.length !== pairDiff.released.length) {
      throw new DomainError("INTERNAL_ERROR", "调整住宿日期未精确释放旧库存占用", 500);
    }
    const addedByUnit = new Map<string, string[]>();
    for (const item of pairDiff.added) {
      const dates = addedByUnit.get(item.inventoryUnitId) ?? [];
      dates.push(item.serviceDate);
      addedByUnit.set(item.inventoryUnitId, dates);
    }
    const addedClaimIds: string[] = [];
    for (const [unitId, dates] of addedByUnit) {
      const unit = await loadInventoryUnit(trx, propertyId, unitId);
      addedClaimIds.push(...await createInventoryClaims(trx, {
        propertyId,
        unit,
        dates,
        sourceType: "ORDER_SEGMENT",
        sourceId: segmentId,
        excludeSourceIds: [...context.segmentIds, segmentId]
      }));
    }
    if (addedClaimIds.length !== pairDiff.added.length) {
      throw new DomainError("INTERNAL_ERROR", "调整住宿日期未精确创建新库存占用", 500);
    }

    const reconciled = context.order.member_id || context.order.member_contract_id
      ? await reconcileCoverage(trx, {
        orderId,
        contractId: context.order.member_contract_id ?? "",
        ...(context.order.member_id ? { memberId: context.order.member_id } : {}),
        revisionId,
        coverageSet: pricing.coverageSet,
        commandId: options.commandId
      })
      : { coverageIds: [], factIds: [] };
    const entitlementChange = nestedObject(effect, "entitlementChange");
    const consumedCoverageDates = stringArray(entitlementChange, "consumedCoverageDates");
    const consumed = options.commandType === "EXTEND_STAY" && (context.order.member_id || context.order.member_contract_id)
      ? await consumeCoverage(trx, orderId, options.commandId, {
        serviceDates: consumedCoverageDates,
        reason: "EXTEND_STAY_ENTITLEMENT_CONSUMED"
      })
      : { coverageIds: [], factIds: [] };

    await trx.updateTable("orders").set({
      arrival_date: arrivalDate,
      departure_date: departureDate,
      current_revision_id: revisionId,
      version: context.order.version + 1,
      updated_at: new Date()
    }).where("id", "=", orderId).execute();

    const pricingDecision = nestedObject(effect, "pricingDecision");
    const fundsSummary = nestedObject(effect, "fundsSummary");
    const before = nestedObject(effect, "before");
    return {
      persistedResult: {
        orderId,
        stayId: context.stay.id,
        amendmentId,
        staySegmentId: segmentId,
        pricingRevisionId: revisionId,
        arrivalDate,
        departureDate,
        before,
        after,
        pricingDecision,
        inventoryChange,
        entitlementChange,
        fundsSummary,
        ...temporaryOtherRoomReceiptEvidenceFromEffect(effect)
      },
      resourceRefs: [...new Set([
        orderId,
        context.stay.id,
        amendmentId,
        segmentId,
        revisionId,
        ...releasedClaimIds,
        ...addedClaimIds,
        ...reconciled.coverageIds,
        ...consumed.coverageIds
      ])],
      factRefs: [...new Set([...reconciled.factIds, ...consumed.factIds])]
    };
  }

  if (options.commandType === "SHORTEN_STAY") {
    if (requireString(effect, "operation") !== "SHORTEN_STAY") {
      throw new DomainError("INTERNAL_ERROR", "Shorten stay effect has an invalid operation", 500);
    }
    const completionMode = requireString(effect, "completionMode");
    if (completionMode !== "SHORTEN_IN_HOUSE" && completionMode !== "EARLY_CHECK_OUT") {
      throw new DomainError("INTERNAL_ERROR", "Shorten stay effect has an invalid completion mode", 500);
    }
    const businessDate = requireString(effect, "businessDate");
    const after = nestedObject(effect, "after");
    const arrivalDate = requireString(after, "arrivalDate");
    const departureDate = requireString(after, "departureDate");
    if ((completionMode === "EARLY_CHECK_OUT" && departureDate !== businessDate)
      || (completionMode === "SHORTEN_IN_HOUSE" && departureDate <= businessDate)) {
      throw new DomainError("INTERNAL_ERROR", "Shorten stay effect completion mode does not match its business date", 500);
    }
    const stayTimeline = stayTimelineFromEffect(effect);
    const currentTail = trailingTimelineRun(stayTimeline);
    const inventoryUnitId = currentTail.inventoryUnitId;
    const inventoryChange = nestedObject(effect, "inventoryChange");
    const releasedDates = stringArray(inventoryChange, "releasedDates");
    const entitlementSummary = nestedObject(effect, "entitlementSummary");
    const restoredFutureCoverageDates = stringArray(entitlementSummary, "restoredFutureCoverageDates");
    const expectedLedgerWriteCount = requireInteger(entitlementSummary, "ledgerWriteCount", { min: 0 });
    if (expectedLedgerWriteCount !== restoredFutureCoverageDates.length) {
      throw new DomainError("INTERNAL_ERROR", "Shorten stay entitlement restoration count is inconsistent", 500);
    }
    const pricing = pricingSnapshot(effect, {
      stayType: context.order.stay_type,
      memberId: context.order.member_id,
      memberContractId: context.order.member_contract_id
    });
    const arrangementAmendmentId = await appendAmendment(trx, {
      orderId, sequence: context.order.version + 1, amendmentType: "SHORTEN_STAY",
      reasonCode: options.reason.code, reasonNote: options.reason.note, priorVersion: context.order.version, payload: effect,
      commandId: options.commandId
    });
    const segmentId = newId("segment");
    await trx.insertInto("stay_segments").values({
      id: segmentId, stay_id: context.stay.id, sequence: context.currentSegment.sequence + 1,
      inventory_unit_id: inventoryUnitId, arrival_date: currentTail.arrivalDate, departure_date: departureDate,
      segment_type: "SHORTEN_STAY", supersedes_segment_id: context.currentSegment.id, amendment_id: arrangementAmendmentId
    }).execute();
    const revisionId = await insertRevision(trx, {
      orderId, revisionNo: context.revision.revisionNo + 1, amendmentId: arrangementAmendmentId,
      policyVersionId: context.order.pricing_policy_version_id,
      arrivalDate, departureDate, pricing
    });
    const releasedClaimIds = completionMode === "EARLY_CHECK_OUT"
      ? await releaseInventoryClaims(trx, "ORDER_SEGMENT", context.segmentIds)
      : await releaseInventoryClaimsOnDates(trx, "ORDER_SEGMENT", context.segmentIds, releasedDates);
    let checkoutAmendmentId: string | null = null;
    let fulfillmentTiming: { effectiveDate: string; recordedBusinessDate: string; recordingMode: "ON_SCHEDULE" } | null = null;
    if (completionMode === "EARLY_CHECK_OUT") {
      const checkoutEffect = {
        orderId,
        fromStatus: "CHECKED_IN",
        toStatus: "CHECKED_OUT",
        inventoryUnitId,
        businessDate: departureDate,
        effectiveDate: departureDate,
        recordingMode: "ON_SCHEDULE"
      };
      checkoutAmendmentId = await appendAmendment(trx, {
        orderId,
        sequence: context.order.version + 2,
        amendmentType: "CHECK_OUT",
        reasonCode: options.reason.code,
        reasonNote: options.reason.note,
        priorVersion: context.order.version + 1,
        payload: checkoutEffect,
        commandId: options.commandId
      });
      fulfillmentTiming = {
        effectiveDate: departureDate,
        recordedBusinessDate: departureDate,
        recordingMode: "ON_SCHEDULE"
      };
      await trx.updateTable("stays").set({ status: "COMPLETED" }).where("id", "=", context.stay.id).execute();
    }
    const restoredCoverage = await restoreFutureConsumedCoverage(
      trx,
      orderId,
      options.commandId,
      restoredFutureCoverageDates
    );
    await trx.updateTable("orders").set({
      departure_date: departureDate,
      current_revision_id: revisionId,
      ...(completionMode === "EARLY_CHECK_OUT" ? { status: "CHECKED_OUT" } : {}),
      version: context.order.version + (completionMode === "EARLY_CHECK_OUT" ? 2 : 1),
      updated_at: new Date()
    }).where("id", "=", orderId).execute();
    const before = nestedObject(effect, "before");
    const pricingDecision = nestedObject(effect, "pricingDecision");
    const fundsSummary = nestedObject(effect, "fundsSummary");
    const refundReferenceAmount = moneyMinor(effect.refundReferenceAmount, "refundReferenceAmount");
    return {
      persistedResult: {
        orderId,
        stayId: context.stay.id,
        arrangementAmendmentId,
        checkoutAmendmentId,
        staySegmentId: segmentId,
        pricingRevisionId: revisionId,
        completionMode,
        businessDate,
        arrivalDate,
        departureDate,
        before,
        after,
        pricingDecision,
        inventoryChange,
        entitlementSummary,
        fundsSummary,
        refundReferenceAmount,
        fulfillmentTiming,
        ...temporaryOtherRoomReceiptEvidenceFromEffect(effect)
      },
      resourceRefs: [...new Set([
        orderId,
        context.stay.id,
        arrangementAmendmentId,
        ...(checkoutAmendmentId ? [checkoutAmendmentId] : []),
        segmentId,
        revisionId,
        ...releasedClaimIds,
        ...restoredCoverage.coverageIds
      ])],
      factRefs: restoredCoverage.factIds
    };
  }

  if (options.commandType === "MOVE_UNIT") {
    if (requireString(effect, "operation") !== "MOVE_UNIT") {
      throw new DomainError("INTERNAL_ERROR", "Move unit effect has an invalid operation", 500);
    }
    const amendmentId = await appendAmendment(trx, {
      orderId, sequence: context.order.version + 1, amendmentType: "MOVE_UNIT",
      reasonCode: options.reason.code, reasonNote: options.reason.note, priorVersion: context.order.version, payload: effect,
      commandId: options.commandId
    });
    const segmentId = newId("segment");
    const after = nestedObject(effect, "after");
    const pricing = pricingSnapshot(effect, {
      stayType: context.order.stay_type,
      memberId: context.order.member_id,
      memberContractId: context.order.member_contract_id
    });
    const stayTimeline = stayTimelineFromEffect(effect);
    const currentTail = trailingTimelineRun(stayTimeline);
    const unitId = currentTail.inventoryUnitId;
    const arrivalDate = requireString(after, "arrivalDate");
    const departureDate = requireString(after, "departureDate");
    const effectiveDate = requireString(effect, "effectiveDate");
    const businessDate = requireString(effect, "businessDate");
    if (arrivalDate !== context.order.arrival_date || departureDate !== context.order.departure_date
      || currentTail.arrivalDate > effectiveDate || unitId !== requireString(nestedObject(effect, "toInventoryUnit"), "id")) {
      throw new DomainError("INTERNAL_ERROR", "Move unit effect has an invalid resulting timeline", 500);
    }
    await trx.insertInto("stay_segments").values({
      id: segmentId, stay_id: context.stay.id, sequence: context.currentSegment.sequence + 1,
      inventory_unit_id: unitId, arrival_date: effectiveDate, departure_date: departureDate,
      segment_type: "MOVE", supersedes_segment_id: context.currentSegment.id, amendment_id: amendmentId
    }).execute();
    const inventoryChange = nestedObject(effect, "inventoryChange");
    const preservedClaims = inventoryClaimSummaries(inventoryChange, "preservedClaims");
    const releasedClaims = inventoryClaimSummaries(inventoryChange, "releasedClaims");
    const addedClaims = inventoryClaimSummaries(inventoryChange, "addedClaims");
    const beforeTimelineByDate = new Map(
      inventoryClaimSummaries(nestedObject(effect, "before"), "stayTimeline")
        .map((claim) => [claim.serviceDate, claim.inventoryUnitId])
    );
    const afterTimelineByDate = new Map(stayTimeline.map((claim) => [claim.serviceDate, claim.inventoryUnitId]));
    const expectedPreserved = [...beforeTimelineByDate].filter(([serviceDate, inventoryUnitId]) =>
      afterTimelineByDate.get(serviceDate) === inventoryUnitId
    );
    const expectedReleased = [...beforeTimelineByDate].filter(([serviceDate, inventoryUnitId]) =>
      afterTimelineByDate.get(serviceDate) !== inventoryUnitId
    );
    const expectedAdded = [...afterTimelineByDate].filter(([serviceDate, inventoryUnitId]) =>
      beforeTimelineByDate.get(serviceDate) !== inventoryUnitId
    );
    const matchesClaimSet = (
      actual: Array<{ serviceDate: string; inventoryUnitId: string }>,
      expected: Array<[string, string]>
    ) => {
      const actualKeys = actual.map((claim) => `${claim.serviceDate}\u0000${claim.inventoryUnitId}`).sort();
      const expectedKeys = expected.map(([serviceDate, inventoryUnitId]) => `${serviceDate}\u0000${inventoryUnitId}`).sort();
      return actualKeys.length === expectedKeys.length
        && new Set(actualKeys).size === actualKeys.length
        && new Set(expectedKeys).size === expectedKeys.length
        && actualKeys.every((key, index) => key === expectedKeys[index]);
    };
    if (!matchesClaimSet(preservedClaims, expectedPreserved)
      || !matchesClaimSet(releasedClaims, expectedReleased)
      || !matchesClaimSet(addedClaims, expectedAdded)
      || addedClaims.some((claim) => claim.inventoryUnitId !== unitId)) {
      throw new DomainError("INTERNAL_ERROR", "Move unit effect inventory diff does not match its stay timeline", 500);
    }
    const releasedClaimIds = await releaseInventoryClaimsOnDates(
      trx,
      "ORDER_SEGMENT",
      context.segmentIds,
      releasedClaims.map((claim) => claim.serviceDate)
    );
    if (releasedClaimIds.length !== releasedClaims.length) {
      throw new DomainError("INTERNAL_ERROR", "Move unit did not release the exact inventory claim set", 500);
    }
    const unit = await loadInventoryUnit(trx, propertyId, unitId);
    const addedClaimIds = await createInventoryClaims(trx, {
      propertyId,
      unit,
      dates: addedClaims.map((claim) => claim.serviceDate),
      sourceType: "ORDER_SEGMENT",
      sourceId: segmentId,
      excludeSourceIds: [...context.segmentIds, segmentId]
    });
    if (addedClaimIds.length !== addedClaims.length) {
      throw new DomainError("INTERNAL_ERROR", "Move unit did not create the exact inventory claim set", 500);
    }
    const revisionId = await insertRevision(trx, {
      orderId, revisionNo: context.revision.revisionNo + 1, amendmentId,
      policyVersionId: context.order.pricing_policy_version_id,
      arrivalDate, departureDate, pricing
    });
    const entitlementSummary = nestedObject(effect, "entitlementSummary");
    const conversionCoveragePreserved = entitlementSummary.convertedMembershipCoveragePreserved;
    if (typeof conversionCoveragePreserved !== "boolean") {
      throw new DomainError("INTERNAL_ERROR", "Move unit effect has no converted coverage preservation marker", 500);
    }
    const membershipConversion = await loadOrderMembershipConversion(trx, context);
    if (conversionCoveragePreserved !== (membershipConversion !== null)) {
      throw new DomainError("INTERNAL_ERROR", "Move unit converted coverage marker is inconsistent", 500);
    }
    let reconciled: { coverageIds: string[]; factIds: string[] };
    if (membershipConversion) {
      const coverageRows = await trx.selectFrom("coverage_items")
        .select(["id", "service_date", "contract_id", "lot_id", "inventory_unit_id", "unit_kind", "status"])
        .where("order_id", "=", orderId)
        .where("status", "in", ["HELD", "CONSUMED"])
        .orderBy("service_date")
        .forUpdate()
        .execute();
      const expectedDates = enumerateServiceDates(arrivalDate, departureDate);
      const pricingCoverage = new Map(pricing.coverageSet.map((item) => [item.serviceDate, item]));
      if (context.order.status !== "CHECKED_IN"
        || unit.kind !== membershipConversion.allowedInventoryKind
        || unit.roomTypeCode !== membershipConversion.allowedRoomTypeCode
        || coverageRows.length !== expectedDates.length
        || pricing.coverageSet.length !== expectedDates.length
        || pricingCoverage.size !== expectedDates.length
        || pricing.cashLines.length !== 0
        || pricing.currentContractAmountMinor !== 0
        || pricing.manualAdjustmentMinor !== 0
        || coverageRows.some((coverage, index) => {
          const priced = pricingCoverage.get(coverage.service_date);
          return coverage.service_date !== expectedDates[index]
            || coverage.status !== "CONSUMED"
            || coverage.contract_id !== membershipConversion.contractId
            || coverage.lot_id !== membershipConversion.entitlementLotId
            || coverage.unit_kind !== membershipConversion.entitlementUnitKind
            || !priced
            || priced.inventoryUnitId !== coverage.inventory_unit_id
            || priced.entitlementLotId !== coverage.lot_id
            || priced.unitKind !== coverage.unit_kind;
        })) {
        throw new DomainError("ENTITLEMENT_CONFLICT", "升级会员后的已核销权益与换房计划不一致，不能安全换房", 409);
      }
      reconciled = { coverageIds: coverageRows.map((coverage) => coverage.id), factIds: [] };
    } else {
      reconciled = context.order.member_id || context.order.member_contract_id
        ? await reconcileCoverage(trx, {
          orderId,
          contractId: context.order.member_contract_id ?? "",
          ...(context.order.member_id ? { memberId: context.order.member_id } : {}),
          revisionId,
          coverageSet: pricing.coverageSet,
          commandId: options.commandId
        })
        : { coverageIds: [], factIds: [] };
    }
    const ledgerWriteCount = entitlementSummary.ledgerWriteCount;
    if (!Number.isSafeInteger(ledgerWriteCount) || ledgerWriteCount !== reconciled.factIds.length) {
      throw new DomainError("INTERNAL_ERROR", "Move unit entitlement summary does not match persisted ledger writes", 500);
    }
    await trx.updateTable("orders").set({
      current_revision_id: revisionId,
      version: context.order.version + 1,
      updated_at: new Date()
    }).where("id", "=", orderId).execute();
    const before = nestedObject(effect, "before");
    const pricingDecision = nestedObject(effect, "pricingDecision");
    const fundsSummary = nestedObject(effect, "fundsSummary");
    return {
      persistedResult: {
        orderId,
        stayId: context.stay.id,
        amendmentId,
        staySegmentId: segmentId,
        pricingRevisionId: revisionId,
        businessDate,
        effectiveDate,
        before,
        after,
        pricingDecision,
        inventoryChange,
        entitlementSummary,
        fundsSummary
      },
      resourceRefs: [...new Set([
        orderId,
        context.stay.id,
        amendmentId,
        segmentId,
        revisionId,
        ...releasedClaimIds,
        ...addedClaimIds,
        ...reconciled.coverageIds
      ])],
      factRefs: [...new Set(reconciled.factIds)]
    };
  }

  if (options.commandType === "REPRICE_ORDER" || options.commandType === "REFRESH_MEMBER_COVERAGE") {
    const amendmentId = await appendAmendment(trx, {
      orderId, sequence: context.order.version + 1, amendmentType: options.commandType,
      reasonCode: options.reason.code, reasonNote: options.reason.note, priorVersion: context.order.version, payload: effect,
      commandId: options.commandId
    });
    const pricing = pricingSnapshot(effect, {
      stayType: context.order.stay_type,
      memberId: context.order.member_id,
      memberContractId: context.order.member_contract_id
    });
    const revisionId = await insertRevision(trx, {
      orderId, revisionNo: context.revision.revisionNo + 1, amendmentId,
      policyVersionId: context.order.pricing_policy_version_id,
      arrivalDate: context.order.arrival_date, departureDate: context.order.departure_date, pricing
    });
    const reconciledCoverage = context.order.member_id || context.order.member_contract_id
      ? await reconcileCoverage(trx, {
        orderId,
        contractId: context.order.member_contract_id ?? "",
        ...(context.order.member_id ? { memberId: context.order.member_id } : {}),
        revisionId,
        coverageSet: pricing.coverageSet,
        commandId: options.commandId
      })
      : { coverageIds: [], factIds: [] };
    const consumedCoverage = (context.order.member_id || context.order.member_contract_id) && context.order.status === "CHECKED_IN"
      ? await consumeCoverage(trx, orderId, options.commandId)
      : { coverageIds: [], factIds: [] };
    const coverageRefs = {
      coverageIds: [...new Set([...reconciledCoverage.coverageIds, ...consumedCoverage.coverageIds])],
      factIds: [...new Set([...reconciledCoverage.factIds, ...consumedCoverage.factIds])]
    };
    await trx.updateTable("orders").set({ current_revision_id: revisionId, version: context.order.version + 1, updated_at: new Date() }).where("id", "=", orderId).execute();
    const persistedResult: Record<string, unknown> = { orderId, amendmentId, pricingRevisionId: revisionId };
    if (options.commandType === "REPRICE_ORDER") {
      persistedResult.policyBaseAmount = moneyMinor(effect.policyBaseAmount, "policyBaseAmount");
      persistedResult.targetCurrentContractAmount = moneyMinor(effect.targetCurrentContractAmount, "targetCurrentContractAmount");
      persistedResult.manualAdjustmentMinor = effect.manualAdjustmentMinor;
    }
    return {
      persistedResult,
      resourceRefs: [orderId, amendmentId, revisionId, ...coverageRefs.coverageIds],
      factRefs: coverageRefs.factIds
    };
  }

  if (options.commandType === "RECORD_COLLECTION" || options.commandType === "RECORD_REFUND" || options.commandType === "REVERSE_FACT") {
    const factId = newId("fact");
    const amountMinor = effect.amountMinor as number;
    const factType = options.commandType === "RECORD_COLLECTION" ? "COLLECTION" : options.commandType === "RECORD_REFUND" ? "REFUND" : "REVERSAL";
    const netEffectMinor = factType === "COLLECTION" ? amountMinor : factType === "REFUND" ? -amountMinor : effect.netEffectMinor as number;
    const transactionReference = factType === "REVERSAL" ? null
      : typeof effect.transactionReference === "string" && effect.transactionReference.trim() !== "" ? effect.transactionReference.trim() : null;
    const refundReference = factType === "REFUND" && typeof effect.refundReference === "string" ? effect.refundReference : undefined;
    await trx.insertInto("collection_facts").values({
      fact_id: factId, order_id: orderId, fact_type: factType, amount_minor: amountMinor,
      net_effect_minor: netEffectMinor, currency: requireString(effect, "currency"),
      references_fact_id: typeof effect.referencesFactId === "string" ? effect.referencesFactId : null,
      reverses_fact_id: typeof effect.reversesFactId === "string" ? effect.reversesFactId : null,
      method: typeof effect.method === "string" ? effect.method : "REVERSAL",
      note: typeof effect.note === "string" ? effect.note : options.reason.note,
      transaction_reference: transactionReference,
      refund_reference: refundReference ?? null,
      pricing_revision_id: context.revision.id,
      command_id: options.commandId
    }).execute();
    return { persistedResult: { orderId, factId, factType, netEffectMinor, transactionReference, ...(refundReference ? { refundReference } : {}) }, resourceRefs: [orderId], factRefs: [factId] };
  }

  const statusCommands: Partial<Record<CommandType, { orderStatus: string; stayStatus: string }>> = {
    CHECK_IN: { orderStatus: "CHECKED_IN", stayStatus: "IN_HOUSE" },
    CHECK_OUT: { orderStatus: "CHECKED_OUT", stayStatus: "COMPLETED" },
    CANCEL_ORDER: { orderStatus: "CANCELLED", stayStatus: "CANCELLED" },
    MARK_NO_SHOW: { orderStatus: "NO_SHOW", stayStatus: "NO_SHOW" },
    REVOKE_CHECK_IN: { orderStatus: "CHECK_IN_REVOKED", stayStatus: "CHECK_IN_REVOKED" }
  };
  const target = statusCommands[options.commandType];
  if (options.commandType === "REVOKE_CHECK_OUT") {
    return applyCheckoutReversal(trx, context, options.commandId, options.reason, effect);
  }
  if (options.commandType === "COMPLETE_STAY") {
    if (requireString(effect, "operation") !== "COMPLETE_STAY") {
      throw new DomainError("INTERNAL_ERROR", "Complete-stay effect has an invalid operation", 500);
    }
    if (options.reason.code !== "COMPLETE_STAY") {
      throw new DomainError("VALIDATION_ERROR", "完成住宿确认原因必须是 COMPLETE_STAY");
    }
    if (options.reason.note.trim() === "") {
      throw new DomainError("VALIDATION_ERROR", "完成住宿必须填写说明");
    }
    if (requireString(effect, "reasonNote") !== options.reason.note.trim()) {
      throw new DomainError("VALIDATION_ERROR", "完成住宿说明与核对页锁定内容不一致");
    }
    const checkIn = nestedObject(effect, "checkIn");
    const checkOut = nestedObject(effect, "checkOut");
    const stayTimeline = stayTimelineFromEffect(effect);
    const inventoryRelease = nestedObject(effect, "inventoryRelease");
    const expectedClaimIds = stringArray(inventoryRelease, "claimIds");
    const expectedClaimCount = requireInteger(inventoryRelease, "claimCount", { min: 1 });
    const entitlementTransition = nestedObject(effect, "entitlementTransition");
    const expectedCoverageIds = stringArray(entitlementTransition, "coverageIds");
    const expectedCoverageCount = requireInteger(entitlementTransition, "coverageCount", { min: 0 });
    const effectBusinessDate = requireString(effect, "businessDate");
    if (requireString(checkIn, "fromStatus") !== "RESERVED"
      || requireString(checkIn, "toStatus") !== "CHECKED_IN"
      || requireString(checkOut, "fromStatus") !== "CHECKED_IN"
      || requireString(checkOut, "toStatus") !== "CHECKED_OUT"
      || requireString(checkIn, "orderId") !== orderId
      || requireString(checkOut, "orderId") !== orderId
      || requireString(checkIn, "inventoryUnitId") !== stayTimeline[0]!.inventoryUnitId
      || requireString(checkOut, "inventoryUnitId") !== stayTimeline.at(-1)!.inventoryUnitId
      || requireString(checkIn, "businessDate") !== effectBusinessDate
      || requireString(checkOut, "businessDate") !== effectBusinessDate
      || requireString(checkIn, "effectiveDate") !== context.order.arrival_date
      || requireString(checkOut, "effectiveDate") !== context.order.departure_date
      || expectedClaimCount !== expectedClaimIds.length
      || expectedClaimIds.length !== stayTimeline.length
      || expectedCoverageCount !== expectedCoverageIds.length) {
      throw new DomainError("INTERNAL_ERROR", "Complete-stay transition payload is inconsistent", 500);
    }
    const settlementStatus = requireString(effect, "settlementStatus");
    if (settlementStatus !== "SETTLED" && settlementStatus !== "ARREARS") {
      throw new DomainError("INTERNAL_ERROR", "Complete-stay settlement status is invalid", 500);
    }
    const checkInAmendmentId = await appendAmendment(trx, {
      orderId,
      sequence: context.order.version + 1,
      amendmentType: "CHECK_IN",
      reasonCode: "COMPLETE_STAY",
      reasonNote: options.reason.note,
      priorVersion: context.order.version,
      payload: checkIn,
      commandId: options.commandId
    });
    const coverageRefs = expectedCoverageIds.length > 0
      ? await consumeCoverage(trx, orderId, options.commandId, {
          serviceDates: stayTimeline.map((item) => item.serviceDate)
        })
      : { coverageIds: [], factIds: [] };
    if (!sameStringSet(coverageRefs.coverageIds, expectedCoverageIds)) {
      throw new DomainError("INTERNAL_ERROR", "Complete-stay did not consume the exact confirmed coverage set", 500);
    }
    const checkOutAmendmentId = await appendAmendment(trx, {
      orderId,
      sequence: context.order.version + 2,
      amendmentType: "CHECK_OUT",
      reasonCode: "COMPLETE_STAY",
      reasonNote: options.reason.note,
      priorVersion: context.order.version + 1,
      payload: checkOut,
      commandId: options.commandId
    });
    const releasedClaimIds = await releaseInventoryClaims(trx, "ORDER_SEGMENT", context.segmentIds);
    if (!sameStringSet(releasedClaimIds, expectedClaimIds)) {
      throw new DomainError("INTERNAL_ERROR", "Complete-stay did not release the exact confirmed inventory Claim set", 500);
    }
    const orderUpdate = await trx.updateTable("orders").set({
      status: "CHECKED_OUT",
      version: context.order.version + 2,
      updated_at: new Date()
    })
      .where("id", "=", orderId)
      .where("status", "=", "RESERVED")
      .where("version", "=", context.order.version)
      .executeTakeFirst();
    if (orderUpdate.numUpdatedRows !== 1n) {
      throw new DomainError("INTERNAL_ERROR", "Complete-stay did not update the exact confirmed order state", 500);
    }
    const stayUpdate = await trx.updateTable("stays")
      .set({ status: "COMPLETED" })
      .where("id", "=", context.stay.id)
      .where("status", "=", "PLANNED")
      .executeTakeFirst();
    if (stayUpdate.numUpdatedRows !== 1n) {
      throw new DomainError("INTERNAL_ERROR", "Complete-stay did not update the exact confirmed Stay state", 500);
    }
    let collectionFactId: string | null = null;
    const collection = effect.collection;
    if (collection !== null && collection !== undefined) {
      const collectionInput = requireObject(collection, "collection");
      const amountMinor = requireInteger(collectionInput, "amountMinor", { min: 1 });
      const currency = requireString(collectionInput, "currency");
      if (currency !== context.revision.currency) {
        throw new DomainError("INTERNAL_ERROR", "Complete-stay collection currency mismatch", 500);
      }
      const method = requireString(collectionInput, "method");
      const transactionReference = typeof collectionInput.transactionReference === "string" && collectionInput.transactionReference.trim() !== ""
        ? collectionInput.transactionReference.trim()
        : null;
      const cashCollector = method === "CASH"
        ? requireString(collectionInput, "cashCollector").trim()
        : null;
      const note = method === "CASH"
        ? requireString(collectionInput, "note").trim()
        : typeof collectionInput.note === "string" ? collectionInput.note.trim() : options.reason.note;
      collectionFactId = newId("fact");
      await trx.insertInto("collection_facts").values({
        fact_id: collectionFactId,
        order_id: orderId,
        fact_type: "COLLECTION",
        amount_minor: amountMinor,
        net_effect_minor: amountMinor,
        currency,
        references_fact_id: null,
        reverses_fact_id: null,
        method,
        note,
        transaction_reference: transactionReference,
        cash_collector: cashCollector,
        pricing_revision_id: context.revision.id,
        command_id: options.commandId
      }).execute();
    }
    return {
      persistedResult: {
        orderId,
        stayId: context.stay.id,
        checkInAmendmentId,
        checkOutAmendmentId,
        collectionFactId,
        releasedClaimIds,
        consumedCoverageIds: coverageRefs.coverageIds,
        status: "CHECKED_OUT",
        settlementStatus,
        fulfillmentTiming: {
          effectiveDate: requireString(checkOut, "effectiveDate"),
          recordedBusinessDate: requireString(checkOut, "businessDate"),
          recordingMode: requireString(checkOut, "recordingMode")
        },
        ...temporaryOtherRoomReceiptEvidenceFromEffect(effect)
      },
      resourceRefs: [...new Set([
        orderId,
        context.stay.id,
        checkInAmendmentId,
        checkOutAmendmentId,
        ...releasedClaimIds,
        ...coverageRefs.coverageIds
      ])],
      factRefs: [...coverageRefs.factIds, ...(collectionFactId ? [collectionFactId] : [])]
    };
  }
  if ((options.commandType as string) === "BACKFILL_COMPLETED_STAY") {
    if (!currentReleaseFeatures.stayBackfillSubmission) {
      throw new DomainError("VALIDATION_ERROR", "补录已改为创建时一次完成，请使用“补录住宿”入口", 409);
    }
    if (requireString(effect, "operation") !== "BACKFILL_COMPLETED_STAY") {
      throw new DomainError("INTERNAL_ERROR", "Backfill effect has an invalid operation", 500);
    }
    if (options.reason.note.trim() === "") {
      throw new DomainError("VALIDATION_ERROR", "补录完成住宿必须填写补录原因");
    }
    const checkIn = nestedObject(effect, "checkIn");
    const checkOut = nestedObject(effect, "checkOut");
    if (requireString(checkIn, "fromStatus") !== "RESERVED"
      || requireString(checkIn, "toStatus") !== "CHECKED_IN"
      || requireString(checkOut, "fromStatus") !== "CHECKED_IN"
      || requireString(checkOut, "toStatus") !== "CHECKED_OUT") {
      throw new DomainError("INTERNAL_ERROR", "Backfill transition payload is inconsistent", 500);
    }
    const checkInAmendmentId = await appendAmendment(trx, {
      orderId,
      sequence: context.order.version + 1,
      amendmentType: "CHECK_IN",
      reasonCode: options.reason.code,
      reasonNote: options.reason.note,
      priorVersion: context.order.version,
      payload: checkIn,
      commandId: options.commandId
    });
    const coverageRefs = await consumeCoverage(trx, orderId, options.commandId);
    const checkOutAmendmentId = await appendAmendment(trx, {
      orderId,
      sequence: context.order.version + 2,
      amendmentType: "CHECK_OUT",
      reasonCode: options.reason.code,
      reasonNote: options.reason.note,
      priorVersion: context.order.version + 1,
      payload: checkOut,
      commandId: options.commandId
    });
    const releasedClaimIds = await releaseInventoryClaims(trx, "ORDER_SEGMENT", context.segmentIds);
    await trx.updateTable("orders").set({
      status: "CHECKED_OUT",
      version: context.order.version + 2,
      updated_at: new Date()
    }).where("id", "=", orderId).execute();
    await trx.updateTable("stays").set({ status: "COMPLETED" }).where("id", "=", context.stay.id).execute();
    let collectionFactId: string | null = null;
    const collection = effect.collection;
    if (collection !== null && collection !== undefined) {
      const collectionInput = requireObject(collection, "collection");
      const amountMinor = requireInteger(collectionInput, "amountMinor", { min: 1 });
      const currency = requireString(collectionInput, "currency");
      if (currency !== context.revision.currency) {
        throw new DomainError("INTERNAL_ERROR", "Backfill collection currency mismatch", 500);
      }
      const transactionReference = typeof collectionInput.transactionReference === "string" && collectionInput.transactionReference.trim() !== ""
        ? collectionInput.transactionReference.trim()
        : null;
      collectionFactId = newId("fact");
      await trx.insertInto("collection_facts").values({
        fact_id: collectionFactId,
        order_id: orderId,
        fact_type: "COLLECTION",
        amount_minor: amountMinor,
        net_effect_minor: amountMinor,
        currency,
        references_fact_id: null,
        reverses_fact_id: null,
        method: requireString(collectionInput, "method"),
        note: typeof collectionInput.note === "string" ? collectionInput.note : options.reason.note,
        transaction_reference: transactionReference,
        pricing_revision_id: context.revision.id,
        command_id: options.commandId
      }).execute();
    }
    return {
      persistedResult: {
        orderId,
        stayId: context.stay.id,
        checkInAmendmentId,
        checkOutAmendmentId,
        collectionFactId,
        status: "CHECKED_OUT",
        fulfillmentTiming: {
          effectiveDate: requireString(checkOut, "effectiveDate"),
          recordedBusinessDate: requireString(checkOut, "businessDate"),
          recordingMode: requireString(checkOut, "recordingMode")
        }
      },
      resourceRefs: [...new Set([
        orderId,
        context.stay.id,
        checkInAmendmentId,
        checkOutAmendmentId,
        ...releasedClaimIds,
        ...coverageRefs.coverageIds
      ])],
      factRefs: [...coverageRefs.factIds, ...(collectionFactId ? [collectionFactId] : [])]
    };
  }
  if (target) {
    const amendmentId = await appendAmendment(trx, {
      orderId, sequence: context.order.version + 1, amendmentType: options.commandType,
      reasonCode: options.reason.code, reasonNote: options.reason.note, priorVersion: context.order.version, payload: effect,
      commandId: options.commandId
    });
    let coverageRefs = { coverageIds: [] as string[], factIds: [] as string[] };
    let statusPricingRevisionId: string | undefined;
    let cleaningTaskId: string | undefined;
    if (options.commandType === "CANCEL_ORDER" || options.commandType === "MARK_NO_SHOW" || options.commandType === "REVOKE_CHECK_IN") {
      const prior = await trx.selectFrom("pricing_revisions").selectAll().where("id", "=", context.revision.id).executeTakeFirstOrThrow();
      const pricingRevision = nestedObject(effect, "pricingRevision");
      const pricingBasis = requireString(pricingRevision, "pricingBasis");
      if (!createOrderPricingBasisCodes.includes(pricingBasis as CreateOrderPricingBasis)
        || moneyMinor(pricingRevision.currentContractAmount, "pricingRevision.currentContractAmount").minorUnits !== 0) {
        throw new DomainError("INTERNAL_ERROR", "Terminal pricing revision must be a typed zero amount", 500);
      }
      statusPricingRevisionId = await insertRevision(trx, {
        orderId,
        revisionNo: context.revision.revisionNo + 1,
        amendmentId,
        policyVersionId: context.order.pricing_policy_version_id,
        arrivalDate: context.order.arrival_date,
        departureDate: context.order.departure_date,
        pricing: {
          coverageSet: [],
          cashLines: [],
          policyBaseAmountMinor: 0,
          pricingBasis: pricingBasis as CreateOrderPricingBasis,
          manualAdjustmentMinor: 0,
          currentContractAmountMinor: 0,
          currency: prior.currency
        }
      });
    }
    if (options.commandType === "CHECK_IN") {
      coverageRefs = await consumeCoverage(trx, orderId, options.commandId);
    }
    if (options.commandType === "CHECK_OUT") {
      await releaseInventoryClaims(trx, "ORDER_SEGMENT", context.segmentIds);
      if (currentReleaseFeatures.cleaningWorkflow) {
        const cleaningTask = nestedObject(effect, "cleaningTask");
        const inventoryUnitId = requireString(cleaningTask, "inventoryUnitId");
        const serviceDate = requireString(cleaningTask, "serviceDate");
        const unit = await loadInventoryUnitIncludingInactive(trx, propertyId, inventoryUnitId);
        cleaningTaskId = newId("cleaning");
        await trx.insertInto("cleaning_tasks").values({
          id: cleaningTaskId,
          property_id: propertyId,
          order_id: orderId,
          stay_id: context.stay.id,
          inventory_unit_id: inventoryUnitId,
          room_id: unit.roomId,
          service_date: serviceDate,
          status: "PENDING",
          version: 1,
          created_by_command_id: options.commandId,
          completed_by_command_id: null,
          completed_at: null
        }).execute();
      }
    }
    if (options.commandType === "CANCEL_ORDER" || options.commandType === "MARK_NO_SHOW") {
      coverageRefs = await releaseCoverage(trx, orderId, options.commandId);
      await releaseInventoryClaims(trx, "ORDER_SEGMENT", context.segmentIds);
    }
    if (options.commandType === "REVOKE_CHECK_IN") {
      if (effect.unusedRoomConfirmed !== true) {
        throw new DomainError("INTERNAL_ERROR", "撤销入住缺少未使用房间确认", 500);
      }
      coverageRefs = await restoreConsumedCoverage(trx, orderId, options.commandId);
      await releaseInventoryClaims(trx, "ORDER_SEGMENT", context.segmentIds);
    }
    await trx.updateTable("orders").set({
      status: target.orderStatus,
      ...(statusPricingRevisionId ? { current_revision_id: statusPricingRevisionId } : {}),
      version: context.order.version + 1,
      updated_at: new Date()
    }).where("id", "=", orderId).execute();
    await trx.updateTable("stays").set({ status: target.stayStatus }).where("id", "=", context.stay.id).execute();
    return {
      persistedResult: {
        orderId,
        amendmentId,
        status: target.orderStatus,
        ...((options.commandType === "CHECK_IN" || options.commandType === "CANCEL_ORDER" || options.commandType === "MARK_NO_SHOW" || options.commandType === "REVOKE_CHECK_IN") ? {
          entitlementTransition: {
            from: options.commandType === "REVOKE_CHECK_IN" ? "CONSUMED" : "HELD",
            to: options.commandType === "CHECK_IN" ? "CONSUMED" : options.commandType === "REVOKE_CHECK_IN" ? "RESTORED" : "RELEASED",
            coverageCount: coverageRefs.coverageIds.length
          }
        } : {}),
        ...(statusPricingRevisionId ? { pricingRevisionId: statusPricingRevisionId } : {}),
        ...((options.commandType === "CHECK_IN" || options.commandType === "CHECK_OUT" || options.commandType === "REVOKE_CHECK_IN") ? {
          fulfillmentTiming: {
            effectiveDate: requireString(effect, "effectiveDate"),
            recordedBusinessDate: requireString(effect, "businessDate"),
            recordingMode: requireString(effect, "recordingMode")
          }
        } : {}),
        ...(cleaningTaskId ? { cleaningTaskId } : {}),
        ...temporaryOtherRoomReceiptEvidenceFromEffect(effect)
      },
      resourceRefs: [orderId, amendmentId, ...(statusPricingRevisionId ? [statusPricingRevisionId] : []), ...(cleaningTaskId ? [cleaningTaskId] : []), ...coverageRefs.coverageIds],
      factRefs: coverageRefs.factIds
    };
  }

  throw new DomainError("VALIDATION_ERROR", `Unsupported command: ${options.commandType}`);
}
import { applyRoomCatalogEffect } from "../room-catalog.ts";
