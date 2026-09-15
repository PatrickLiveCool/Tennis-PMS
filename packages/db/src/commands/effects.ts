import { sql } from "kysely";
import { buildCheckoutReversalEffect } from "./checkout-reversal.ts";
import { buildCompanionEffect } from "./companions.ts";
import { backfillCollectionMethods, currentReleaseFeatures, DomainError, freeStayCategoryCodes, type BackfillCollectionMethod, type CommandCapability, type CommandCatalogType, type CommandType, type CoverageItemDto, type FreeStayCategoryCode, type InventoryUnitKind, type StayType, type StoredQuoteDto, type TemporaryOtherRoomArrangementDto } from "@qintopia/contracts";
import {
  amountSummary,
  calculatePricing,
  calculateDurationTimelinePricing,
  commandFeatureEnabled,
  createOrderPricingDecision,
  entitlementKindFor,
  enumerateServiceDates,
  isHumanGrantableCommandCapability,
  parseLocalDate,
  requireTransactionReference,
  stayChangePricingDecision,
  stableHash,
  validateBookingChannel,
  type CoverageCandidate,
  type PricingResult
} from "@qintopia/domain";
import { adjustedEntitlementAvailableBalance, entitlementAvailableBalance, parsePostgresBigInt } from "../entitlement-balance.ts";
import {
  activeCoverageCandidates,
  loadActiveStayTimeline,
  loadOrderMembershipConversion,
  loadOrderContext,
  loadTemporaryOtherRoomCreateEvidence,
  hasTemporaryOtherRoomMemberChainEvidence,
  getOrderViewSnapshot,
  orderAmountSummary,
  projectOrderLifecycle,
  type OrderContext,
  type StayTimelineItem,
  type TemporaryOtherRoomCreateEvidence
} from "../orders.ts";
import { allocateCoverageCandidates, loadPricingPolicy, loadStoredQuote, resolveMemberCoverage, resolveTemporaryOtherRoomCoverage, sameTemporaryOtherRoomArrangement } from "../pricing-service.ts";
import { inventoryFingerprint, loadInventoryUnit, type DbExecutor } from "../inventory.ts";
import { propertyLocalClock, propertyLocalToday } from "../members.ts";
import { planStayDateChangeTimeline, timelinePairDiff } from "../stay-timeline-plan.ts";
import {
  HISTORICAL_STAY_ARRANGEMENT_CORRECTION_COMMAND,
  buildHistoricalStayArrangementCorrectionEffect
} from "../admin-historical-stay-corrections.ts";
import {
  buildMemberCorrectionEffect,
  isMemberCorrectionCommandType
} from "./member-corrections.ts";

export interface BuiltCommandEffect {
  propertyId: string;
  effect: Record<string, unknown>;
  basisVersions: Record<string, unknown>;
  effectHash: string;
}

export function requireObject(value: unknown, field = "input"): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new DomainError("VALIDATION_ERROR", `${field} must be an object`);
  return value as Record<string, unknown>;
}

export function requireString(input: Record<string, unknown>, field: string): string {
  const value = input[field];
  if (typeof value !== "string" || value.trim() === "") throw new DomainError("VALIDATION_ERROR", `${field} is required`);
  return value.trim();
}

export function optionalString(input: Record<string, unknown>, field: string): string | undefined {
  const value = input[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new DomainError("VALIDATION_ERROR", `${field} must be a string`);
  const normalized = value.trim();
  return normalized === "" ? undefined : normalized;
}

export function optionalIdentityCardNumber(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new DomainError("VALIDATION_ERROR", "identityCardNumber must be a string");
  const normalized = value.trim().toUpperCase();
  return normalized === "" ? null : normalized;
}

export function normalizePhoneNumber(value: unknown): string {
  if (typeof value !== "string") throw new DomainError("VALIDATION_ERROR", "phone must be a string");
  const normalized = value.replace(/\s+/g, "");
  if (normalized === "") throw new DomainError("VALIDATION_ERROR", "phone is required");
  return normalized;
}

const strictDateTime = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const sha256Hex = /^[a-f0-9]{64}$/;

function requireFutureDateTime(input: Record<string, unknown>, field: string): string {
  const value = requireString(input, field);
  const match = strictDateTime.exec(value);
  if (!match) throw new DomainError("VALIDATION_ERROR", `${field} must be an RFC 3339 date-time`);
  parseLocalDate(match[1]!);
  if (Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59) {
    throw new DomainError("VALIDATION_ERROR", `${field} must be a valid date-time`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp <= Date.now()) throw new DomainError("VALIDATION_ERROR", `${field} must be in the future`);
  return value;
}

function optionalTokenSecretHash(input: Record<string, unknown>): string | undefined {
  const value = input.tokenSecretHash;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !sha256Hex.test(value)) {
    throw new DomainError("VALIDATION_ERROR", "tokenSecretHash must be a 64-character lowercase SHA-256 hex digest");
  }
  return value;
}

function requireTokenSecretHash(input: Record<string, unknown>): string {
  const value = optionalTokenSecretHash(input);
  if (!value) throw new DomainError("VALIDATION_ERROR", "tokenSecretHash is required for Token rotation");
  return value;
}

function optionalCommandCeiling(input: Record<string, unknown>): CommandCapability[] | undefined {
  const value = input.commandCeiling;
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    throw new DomainError("VALIDATION_ERROR", "commandCeiling must be an array of exact command names");
  }
  const normalized = [...new Set(value.map((entry) => (entry as string).trim()))].sort();
  if (normalized.some((entry) => !isHumanGrantableCommandCapability(entry))) {
    throw new DomainError("VALIDATION_ERROR", "commandCeiling contains a non-grantable command");
  }
  return normalized as CommandCapability[];
}

function requireCommandCeiling(input: Record<string, unknown>): CommandCapability[] {
  const commandCeiling = optionalCommandCeiling(input);
  if (!commandCeiling) throw new DomainError("VALIDATION_ERROR", "commandCeiling is required");
  return commandCeiling;
}

async function targetSubjectCommandGrants(
  db: DbExecutor,
  subjectId: string,
  propertyId: string
): Promise<Array<{
  command_type: CommandCatalogType;
  command_class: "DIRECT_READ" | "HUMAN_COMMAND" | "SYSTEM_DERIVED" | "FUTURE_DISABLED" | "HISTORICAL_READ";
}>> {
  const rows = await db.selectFrom("subject_command_grants")
    .innerJoin("command_catalog", "command_catalog.command_type", "subject_command_grants.command_type")
    .select(["subject_command_grants.command_type", "command_catalog.command_class"])
    .where("subject_id", "=", subjectId)
    .where("property_id", "=", propertyId)
    .orderBy("subject_command_grants.command_type")
    .execute();
  return rows;
}

function sortedUniqueStrings<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort() as T[];
}

function commandGrantTypes(grants: ReadonlyArray<{ command_type: CommandCatalogType }>): CommandCatalogType[] {
  return sortedUniqueStrings(grants.map((grant) => grant.command_type));
}

function commandGrantBasis(grants: ReadonlyArray<{
  command_type: CommandCatalogType;
  command_class: string;
}>): Array<{ commandType: CommandCatalogType; commandClass: string; featureEnabled: boolean }> {
  return grants.map((grant) => ({
    commandType: grant.command_type,
    commandClass: grant.command_class,
    featureEnabled: commandFeatureEnabled(grant.command_type)
  }));
}

function executableCommandCeilingFromGrants(grants: ReadonlyArray<{
  command_type: CommandCatalogType;
  command_class: string;
}>): CommandCapability[] {
  return sortedUniqueStrings(grants.flatMap((grant) => grant.command_class === "HUMAN_COMMAND"
    && isHumanGrantableCommandCapability(grant.command_type)
    && commandFeatureEnabled(grant.command_type)
    ? [grant.command_type]
    : []));
}

function persistedTokenCommandCeiling(
  accessCeiling: "READ" | "WRITE",
  commandCeiling: readonly CommandCapability[]
): CommandCatalogType[] {
  if (accessCeiling === "READ") return [];
  return [...commandCeiling];
}

function resolveTokenCommandCeiling(options: {
  requested: readonly CommandCapability[];
  targetGrants: ReadonlyArray<{ command_type: CommandCatalogType; command_class: string }>;
  accessCeiling: "READ" | "WRITE";
}): CommandCapability[] {
  if (options.accessCeiling === "READ") {
    if (options.requested && options.requested.length > 0) {
      throw new DomainError("VALIDATION_ERROR", "READ tokens cannot carry command ceilings");
    }
    return [];
  }

  const targetGrantSet = new Set(executableCommandCeilingFromGrants(options.targetGrants));
  const ceiling = sortedUniqueStrings(options.requested);
  const invalid = ceiling.find((commandType) => !targetGrantSet.has(commandType));
  if (invalid) {
    throw new DomainError("INSUFFICIENT_ACCESS", "Token command ceiling cannot exceed the target subject's exact command grants", 403);
  }
  return ceiling;
}

export function requireInteger(input: Record<string, unknown>, field: string, options: { min?: number; allowZero?: boolean } = {}): number {
  const value = input[field];
  if (!Number.isSafeInteger(value) || (value as number) < -2_147_483_648 || (value as number) > 2_147_483_647) {
    throw new DomainError("VALIDATION_ERROR", `${field} must be a safe PostgreSQL integer`);
  }
  const number = value as number;
  if (options.min !== undefined && number < options.min) throw new DomainError("VALIDATION_ERROR", `${field} must be at least ${options.min}`);
  if (options.allowZero === false && number === 0) throw new DomainError("VALIDATION_ERROR", `${field} must not be zero`);
  return number;
}

function requireNonNegativeWholeYuanMinor(input: Record<string, unknown>, field: string): number {
  const value = requireInteger(input, field, { min: 0 });
  if (value % 100 !== 0) throw new DomainError("VALIDATION_ERROR", `${field} must be a non-negative whole-yuan CNY amount`);
  return value;
}

function requirePositiveWholeYuanMinor(input: Record<string, unknown>, field: string): number {
  const value = requireInteger(input, field, { min: 1 });
  if (value % 100 !== 0) throw new DomainError("VALIDATION_ERROR", `${field} must be a positive whole-yuan CNY amount`);
  return value;
}

const externalChannelCodes = new Set(["YOUMUDAO", "CTRIP", "MEITUAN"]);
const operatorCollectionMethods = new Set(["WECOM", "BANK_TRANSFER", "CASH", "OTHER"]);
const backfillCollectionMethodSet = new Set<string>(backfillCollectionMethods);

function assertOperatorFundsAllowedForOrder(context: OrderContext): void {
  if (context.order.booking_channel_code && externalChannelCodes.has(context.order.booking_channel_code)) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "外部渠道订单不在 PMS 登记单笔收款或退款；请核对渠道订单号和本单渠道应结金额，由财务按渠道总账核对。"
    );
  }
}

async function hasStayMembershipConversion(db: DbExecutor, orderId: string): Promise<boolean> {
  const existingConversion = await db.selectFrom("amendments")
    .select("id")
    .where("order_id", "=", orderId)
    .where("amendment_type", "=", "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP")
    .executeTakeFirst();
  return Boolean(existingConversion);
}

const temporaryOtherRoomLifecycleClosedMessage = "临时安排的订单如需增加日期或再次换房，请重新建立符合现场安排的订单";

const temporaryOtherRoomBlockedOrderCommands = new Set<CommandType>([
  "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP",
  "EXTEND_STAY",
  "MOVE_UNIT",
  "REPRICE_ORDER",
  "REFRESH_MEMBER_COVERAGE",
  "RECORD_COLLECTION",
  "RECORD_REFUND",
  "REVERSE_FACT"
]);

function temporaryOtherRoomEffectEvidence(evidence: TemporaryOtherRoomCreateEvidence | null): Record<string, unknown> {
  return evidence
    ? {
        temporaryOtherRoomArrangement: evidence.arrangement,
        temporaryOtherRoomCreateAmendmentId: evidence.createAmendmentId
      }
    : {};
}

function rejectTemporaryOtherRoomLifecycleChange(): never {
  throw new DomainError("VALIDATION_ERROR", temporaryOtherRoomLifecycleClosedMessage, 409);
}

async function rejectTemporaryOtherRoomMemberChainChange(
  db: DbExecutor,
  propertyId: string,
  target: Parameters<typeof hasTemporaryOtherRoomMemberChainEvidence>[2]
): Promise<void> {
  if (await hasTemporaryOtherRoomMemberChainEvidence(db, propertyId, target)) {
    rejectTemporaryOtherRoomLifecycleChange();
  }
}

function assertNoTemporaryOtherRoomStayPricingInputs(input: Record<string, unknown>): void {
  if (input.targetCurrentContractAmountMinor !== undefined
    || input.channelPriceDifferenceReason !== undefined
    || input.manualPriceAdjustmentReason !== undefined) {
    rejectTemporaryOtherRoomLifecycleChange();
  }
}

function assertTemporaryOtherRoomReservedSubset(options: {
  oldDates: readonly string[];
  newDates: readonly string[];
  inventoryChange: { releasedDates: readonly string[]; addedDates: readonly string[] };
}): void {
  const oldDateSet = new Set(options.oldDates);
  const newDateSet = new Set(options.newDates);
  if (options.newDates.length === 0
    || options.newDates.length >= options.oldDates.length
    || options.newDates.some((date) => !oldDateSet.has(date))
    || options.oldDates.filter((date) => newDateSet.has(date)).join("\u0000") !== options.newDates.join("\u0000")
    || options.inventoryChange.addedDates.length !== 0
    || options.inventoryChange.releasedDates.length !== options.oldDates.length - options.newDates.length) {
    rejectTemporaryOtherRoomLifecycleChange();
  }
}

function temporaryOtherRoomSubsetPricing(options: {
  evidence: TemporaryOtherRoomCreateEvidence;
  coverageRows: ReadonlyArray<{
    service_date: string;
    inventory_unit_id: string;
    contract_id: string;
    lot_id: string;
    unit_kind: string;
    status: string;
  }>;
  currentTimeline: readonly StayTimelineItem[];
  newDates: readonly string[];
  currency: string;
}): PricingResult {
  const oldDates = options.currentTimeline.map((item) => item.serviceDate);
  const newDateSet = new Set(options.newDates);
  const timelineByDate = new Map(options.currentTimeline.map((item) => [item.serviceDate, item.inventoryUnitId]));
  const coverageByDate = new Map(options.coverageRows.map((row) => [row.service_date, row]));
  if (options.coverageRows.length !== oldDates.length
    || coverageByDate.size !== oldDates.length
    || oldDates.some((date) => {
      const row = coverageByDate.get(date);
      return !row
        || row.status !== "HELD"
        || row.contract_id !== options.evidence.arrangement.memberContractId
        || row.lot_id !== options.evidence.arrangement.entitlementLotId
        || row.unit_kind !== "ROOM_NIGHT"
        || row.inventory_unit_id !== timelineByDate.get(date)
        || row.inventory_unit_id !== options.evidence.arrangement.actualInventoryUnitId;
    })) {
    throw new DomainError("ENTITLEMENT_CONFLICT", "临时安排会员权益冻结与原创建证据不一致，不能调整日期", 409);
  }
  return {
    coverageSet: options.coverageRows
      .filter((row) => newDateSet.has(row.service_date))
      .map((row) => ({
        serviceDate: row.service_date,
        inventoryUnitId: row.inventory_unit_id,
        unitKind: "ROOM_NIGHT",
        entitlementLotId: row.lot_id
      })),
    cashLines: [],
    cashRemainder: money(options.currency, 0),
    currentContractAmount: money(options.currency, 0)
  };
}

export function isExactConvertedCoverageGraph(
  rows: ReadonlyArray<{
    service_date: string;
    status: string;
    contract_id: string;
    lot_id: string;
    unit_kind: string;
  }>,
  expectedDates: readonly string[],
  conversion: {
    contractId: string;
    entitlementLotId: string;
    entitlementUnitKind: "ROOM_NIGHT" | "BED_NIGHT";
  }
): boolean {
  return rows.length === expectedDates.length
    && rows.every((item, index) => item.service_date === expectedDates[index]
      && item.status === "CONSUMED"
      && item.contract_id === conversion.contractId
      && item.lot_id === conversion.entitlementLotId
      && item.unit_kind === conversion.entitlementUnitKind);
}

async function assertLodgingFundsOpenForOrder(db: DbExecutor, orderId: string): Promise<void> {
  if (await hasStayMembershipConversion(db, orderId)) {
    throw new DomainError(
      "AGGREGATE_VERSION_CONFLICT",
      "已完成升级会员，本订单不再追加住宿收退款；后续会员收款请在会员订单中处理",
      409
    );
  }
}

async function assertOrderNotConvertedToMembership(db: DbExecutor, orderId: string): Promise<void> {
  if (await hasStayMembershipConversion(db, orderId)) {
    throw new DomainError("INVALID_ORDER_STATE", "已升级会员的住宿订单不能使用普通住宿操作", 409);
  }
}

function requireCollectionMethod(input: Record<string, unknown>): string {
  const method = requireString(input, "method");
  if (!operatorCollectionMethods.has(method)) throw new DomainError("VALIDATION_ERROR", "收款方式必须是企业微信、银行转账、现金或其他");
  return method;
}

function fundsTransactionAndNote(input: Record<string, unknown>, method: string, isRefund: boolean): { transactionReference: string | null; note: string; refundReference?: string } {
  const rawReference = typeof input.transactionReference === "string" ? input.transactionReference.trim() : "";
  const note = optionalString(input, "note")?.trim() ?? "";
  const referenceRequired = method === "BANK_TRANSFER" || (!isRefund && method === "WECOM");
  if (rawReference && (method === "CASH" || method === "OTHER" || (isRefund && method === "WECOM"))) {
    throw new DomainError(
      "VALIDATION_ERROR",
      method === "WECOM"
        ? "企业微信退款请填写独立的退款单号，原收款通过所选收款记录关联"
        : method === "CASH"
          ? "现金收退款不填写交易单号"
          : "其他收退款不填写交易单号"
    );
  }
  if (referenceRequired && !rawReference) {
    throw new DomainError("VALIDATION_ERROR", method === "WECOM" ? "必须填写企业微信交易单号" : "必须填写交易单号或流水号");
  }
  if (isRefund && !note) {
    throw new DomainError("VALIDATION_ERROR", "必须填写退款原因");
  }
  const refundReference = typeof input.refundReference === "string" ? input.refundReference.trim() : "";
  if (isRefund && method === "WECOM" && (!refundReference || refundReference.length > 200)) {
    throw new DomainError("VALIDATION_ERROR", "必须填写本次企业微信退款单号");
  }
  if (input.refundReference !== undefined && (!isRefund || method !== "WECOM")) {
    throw new DomainError("VALIDATION_ERROR", "独立退款单号仅用于企业微信退款");
  }
  if (!isRefund && !referenceRequired && !note) {
    throw new DomainError("VALIDATION_ERROR", method === "CASH" ? "必须填写收款人" : "必须填写其他收款说明");
  }
  return { transactionReference: rawReference || null, note, ...(refundReference ? { refundReference } : {}) };
}

export type NormalizedBackfillCollection =
  | {
      amountMinor: number;
      method: "WECOM" | "BANK_TRANSFER";
      transactionReference?: string;
      note: string;
    }
  | {
      amountMinor: number;
      method: "CASH";
      cashCollector?: string;
      note?: string;
    };

export function normalizeBackfillCollectionInput(
  value: unknown,
  field = "backfillCollection",
  actionLabel = "补录"
): NormalizedBackfillCollection {
  const input = requireObject(value, field);
  const amountMinor = requireInteger(input, "amountMinor", { min: 0 });
  const submittedMethod = requireString(input, "method");
  if (!backfillCollectionMethodSet.has(submittedMethod)) {
    throw new DomainError("VALIDATION_ERROR", `${actionLabel}收款方式必须是企业微信、银行转账或现金`);
  }
  const method = submittedMethod as BackfillCollectionMethod;
  const transactionReference = optionalString(input, "transactionReference");
  const cashCollector = optionalString(input, "cashCollector");
  const note = optionalString(input, "note");

  if (method === "CASH") {
    if (input.transactionReference !== undefined && input.transactionReference !== null) {
      throw new DomainError("VALIDATION_ERROR", `现金${actionLabel}收款不填写交易单号`);
    }
    if (amountMinor > 0 && !cashCollector) {
      throw new DomainError("VALIDATION_ERROR", `现金${actionLabel}收款必须填写收款人`);
    }
    if (amountMinor > 0 && !note) {
      throw new DomainError("VALIDATION_ERROR", `现金${actionLabel}收款必须填写备注`);
    }
    return {
      amountMinor,
      method,
      ...(cashCollector ? { cashCollector } : {}),
      ...(note ? { note } : {})
    };
  }

  if (input.cashCollector !== undefined && input.cashCollector !== null) {
    throw new DomainError("VALIDATION_ERROR", `企业微信或银行转账${actionLabel}收款不填写现金收款人`);
  }
  if (amountMinor > 0 && !transactionReference) {
    throw new DomainError(
      "VALIDATION_ERROR",
      method === "WECOM" ? "必须填写企业微信交易单号" : "必须填写银行转账交易单号或流水号"
    );
  }
  return {
    amountMinor,
    method,
    ...(transactionReference ? { transactionReference } : {}),
    note: note ?? ""
  };
}

async function assertNoCompletedStayOverlap(
  db: DbExecutor,
  options: {
    propertyId: string;
    inventoryUnitId: string;
    roomId: string;
    inventoryKind: InventoryUnitKind;
    arrivalDate: string;
    departureDate: string;
  }
): Promise<void> {
  const candidates = await db.selectFrom("inventory_claims as claim")
    .innerJoin("stay_segments as segment", (join) => join
      .onRef("segment.id", "=", "claim.source_id")
      .on("claim.source_type", "=", "ORDER_SEGMENT"))
    .innerJoin("stays as stay", "stay.id", "segment.stay_id")
    .innerJoin("orders as order", "order.id", "stay.order_id")
    .select("order.id")
    .distinct()
    .where("claim.property_id", "=", options.propertyId)
    .where("claim.room_id", "=", options.roomId)
    .where("claim.service_date", ">=", options.arrivalDate)
    .where("claim.service_date", "<", options.departureDate)
    .where("order.status", "=", "CHECKED_OUT")
    .where("stay.status", "=", "COMPLETED")
    .orderBy("order.id")
    .execute();
  const units = new Map<string, Awaited<ReturnType<typeof loadInventoryUnit>>>();
  for (const candidate of candidates) {
    const lifecycle = await getOrderViewSnapshot(db, candidate.id);
    for (const interval of lifecycle.effectiveArrangement.intervals) {
      if (interval.arrivalDate >= options.departureDate || interval.departureDate <= options.arrivalDate) continue;
      let intervalUnit = units.get(interval.inventoryUnitId);
      if (!intervalUnit) {
        intervalUnit = await loadInventoryUnit(db, options.propertyId, interval.inventoryUnitId);
        units.set(interval.inventoryUnitId, intervalUnit);
      }
      const overlapsRequestedUnit = options.inventoryKind === "ROOM"
        ? intervalUnit.roomId === options.roomId
        : intervalUnit.id === options.inventoryUnitId
          || (intervalUnit.kind === "ROOM" && intervalUnit.roomId === options.roomId);
      if (overlapsRequestedUnit) {
        throw new DomainError(
          "INVENTORY_CONFLICT",
          "所选历史房源与已有住宿记录重叠，请先核对原订单",
          409,
          false,
          { orderId: candidate.id, inventoryUnitId: interval.inventoryUnitId }
        );
      }
    }
  }
}

function money(currency: string, minorUnits: number) {
  return { currency, minorUnits };
}

function addOneCalendarYear(localDate: string): string {
  const parsed = parseLocalDate(localDate);
  const year = parsed.getUTCFullYear() + 1;
  const month = parsed.getUTCMonth();
  const day = parsed.getUTCDate();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(day, lastDay))).toISOString().slice(0, 10);
}

async function membershipPaymentState(db: DbExecutor, membershipOrderId: string) {
  const facts = await db.selectFrom("membership_payment_facts")
    .selectAll()
    .where("membership_order_id", "=", membershipOrderId)
    .orderBy("created_at")
    .orderBy("fact_id")
    .execute();
  const total = facts.reduce((sum, fact) => sum + fact.net_effect_minor, 0);
  if (!Number.isSafeInteger(total) || total < 0 || total > 2_147_483_647) {
    throw new DomainError("VALIDATION_ERROR", "会员订单收款合计超出支持范围");
  }
  return {
    facts,
    total,
    hash: stableHash(facts.map((fact) => ({
      factId: fact.fact_id,
      type: fact.fact_type,
      amountMinor: fact.amount_minor,
      netEffectMinor: fact.net_effect_minor,
      transactionReference: fact.transaction_reference,
      correctsFactId: fact.corrects_fact_id,
      reversesFactId: fact.reverses_fact_id,
      businessDate: fact.business_date
    })))
  };
}

function assertOrderMutable(status: string): void {
  if (!new Set(["RESERVED", "CHECKED_IN"]).has(status)) throw new DomainError("INVALID_ORDER_STATE", `Order cannot be changed from ${status}`, 409);
}

async function memberBasis(
  db: DbExecutor,
  propertyId: string,
  memberContractId: string | null,
  memberId?: string | null
) {
  if (!memberContractId && !memberId) return null;
  let contractQuery = db.selectFrom("member_contracts")
    .select(["id", "version", "status"])
    .where("property_id", "=", propertyId);
  contractQuery = memberId
    ? contractQuery.where("member_id", "=", memberId)
    : contractQuery.where("id", "=", memberContractId!);
  const contracts = await contractQuery.orderBy("id").execute();
  const contractIds = contracts.map((contract) => contract.id);
  const lots = await db.selectFrom("entitlement_lots")
    .leftJoin("entitlement_ledger", "entitlement_ledger.lot_id", "entitlement_lots.id")
    .select(["entitlement_lots.id", "entitlement_lots.version", sql<string>`cast(coalesce(sum(entitlement_ledger.quantity_delta), 0) as text)`.as("delta")])
    .where("entitlement_lots.contract_id", "in", contractIds.length ? contractIds : ["__none__"])
    .groupBy(["entitlement_lots.id", "entitlement_lots.version"])
    .orderBy("entitlement_lots.id").execute();
  return {
    contracts,
    lots: lots.map((lot) => ({ ...lot, delta: parsePostgresBigInt(lot.delta, "Entitlement ledger sum").toString() }))
  };
}

async function priceSingleUnit(db: DbExecutor, options: {
  propertyId: string;
  orderId?: string;
  memberId: string | null;
  memberContractId: string | null;
  unitId: string;
  arrivalDate: string;
  departureDate: string;
  stayType: StayType;
  policyVersionId: string;
  manualAdjustmentMinor: number;
}): Promise<PricingResult> {
  if (options.stayType === "FREE" && (options.memberId || options.memberContractId)) {
    throw new DomainError("PRICING_POLICY_UNCONFIGURED", "Free stays cannot use member entitlement coverage", 409);
  }
  const unit = await loadInventoryUnit(db, options.propertyId, options.unitId);
  const dates = enumerateServiceDates(options.arrivalDate, options.departureDate);
  const preserved = options.orderId ? await activeCoverageCandidates(db, options.orderId, dates) : [];
  const candidates = options.memberId
    ? (await resolveMemberCoverage(db, {
      propertyId: options.propertyId,
      memberId: options.memberId,
      inventoryUnitKind: unit.kind,
      roomTypeCode: unit.roomTypeCode,
      dates,
      preserved
    })).coverageCandidates
    : await allocateCoverageCandidates(db, {
      propertyId: options.propertyId,
      inventoryUnitKind: unit.kind,
      dates,
      preserved,
      ...(options.memberContractId ? { memberContractId: options.memberContractId } : {})
    });
  const policy = await loadPricingPolicy(db, options.propertyId, options.policyVersionId, Boolean(options.orderId));
  return calculatePricing({
    propertyId: options.propertyId,
    inventoryUnitId: unit.id,
    inventoryUnitKind: unit.kind,
    inventoryProductCode: unit.pricingProductCode,
    arrivalDate: options.arrivalDate,
    departureDate: options.departureDate,
    stayType: options.stayType,
    policy,
    memberCoverage: Boolean(options.memberId || options.memberContractId),
    coverageCandidates: candidates,
    manualAdjustmentMinor: options.manualAdjustmentMinor
  });
}

function requireTemporaryOtherRoomReason(input: Record<string, unknown>): string {
  const value = input.temporaryOtherRoomReason;
  if (typeof value !== "string") {
    throw new DomainError("VALIDATION_ERROR", "临时安排其他房型必须填写现场原因");
  }
  const normalized = value.trim();
  if (normalized === "") {
    throw new DomainError("VALIDATION_ERROR", "临时安排其他房型必须填写现场原因");
  }
  if (normalized.length > 200) {
    throw new DomainError("VALIDATION_ERROR", "临时安排其他房型原因不能超过 200 个字符");
  }
  return normalized;
}

async function priceTemporaryOtherRoomQuote(
  db: DbExecutor,
  quote: StoredQuoteDto,
  arrangement: TemporaryOtherRoomArrangementDto
): Promise<PricingResult> {
  if (!quote.memberId || quote.memberContractId !== arrangement.memberContractId) {
    throw new DomainError("ENTITLEMENT_CONFLICT", "临时安排会员权益身份已变化", 409);
  }
  const unit = await loadInventoryUnit(db, quote.propertyId, quote.inventoryUnitId);
  const dates = enumerateServiceDates(quote.arrivalDate, quote.departureDate);
  const resolution = await resolveTemporaryOtherRoomCoverage(db, {
    propertyId: quote.propertyId,
    memberId: quote.memberId,
    actualInventoryUnitId: unit.id,
    actualInventoryKind: unit.kind,
    actualRoomTypeCode: unit.roomTypeCode,
    arrivalDate: quote.arrivalDate,
    departureDate: quote.departureDate,
    dates
  });
  if (!sameTemporaryOtherRoomArrangement(resolution.arrangement, arrangement)) {
    throw new DomainError("ENTITLEMENT_CONFLICT", "临时安排会员权益来源已变化", 409);
  }
  const policy = await loadPricingPolicy(db, quote.propertyId, quote.pricingPolicyVersionId);
  const pricing = calculatePricing({
    propertyId: quote.propertyId,
    inventoryUnitId: unit.id,
    inventoryUnitKind: unit.kind,
    inventoryProductCode: unit.pricingProductCode,
    arrivalDate: quote.arrivalDate,
    departureDate: quote.departureDate,
    stayType: quote.stayType,
    policy,
    memberCoverage: true,
    coverageCandidates: resolution.coverageCandidates,
    manualAdjustmentMinor: 0
  });
  if (pricing.coverageSet.length !== dates.length
    || pricing.cashLines.length !== 0
    || pricing.cashRemainder.minorUnits !== 0
    || pricing.currentContractAmount.minorUnits !== 0) {
    throw new DomainError("ENTITLEMENT_CONFLICT", "临时安排必须由同一原整房权益完整覆盖且不产生现金差额", 409);
  }
  return pricing;
}

function nextServiceDate(serviceDate: string): string {
  const date = parseLocalDate(serviceDate);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function timelineRuns(timeline: StayTimelineItem[]): Array<{ inventoryUnitId: string; arrivalDate: string; departureDate: string }> {
  const runs: Array<{ inventoryUnitId: string; arrivalDate: string; departureDate: string }> = [];
  for (const item of timeline) {
    const current = runs.at(-1);
    if (current && current.inventoryUnitId === item.inventoryUnitId && current.departureDate === item.serviceDate) {
      current.departureDate = nextServiceDate(item.serviceDate);
    } else {
      runs.push({ inventoryUnitId: item.inventoryUnitId, arrivalDate: item.serviceDate, departureDate: nextServiceDate(item.serviceDate) });
    }
  }
  return runs;
}

async function loadProjectedStayTimeline(db: DbExecutor, context: OrderContext, businessDate: string): Promise<StayTimelineItem[]> {
  if (context.order.status === "RESERVED" || context.order.status === "CHECKED_IN") {
    return loadActiveStayTimeline(db, context);
  }
  const [segments, amendments, revisions, facts] = await Promise.all([
    db.selectFrom("stay_segments").selectAll().where("stay_id", "=", context.stay.id).orderBy("sequence").execute(),
    db.selectFrom("amendments")
      .leftJoin("command_executions", "command_executions.id", "amendments.command_id")
      .leftJoin("subjects", "subjects.id", "command_executions.subject_id")
      .selectAll("amendments")
      .select([
        "command_executions.subject_id as actor_subject_id",
        "subjects.display_name as actor_display_name"
      ])
      .where("amendments.order_id", "=", context.order.id)
      .orderBy("amendments.sequence")
      .execute(),
    db.selectFrom("pricing_revisions").selectAll().where("order_id", "=", context.order.id).orderBy("revision_no").execute(),
    db.selectFrom("collection_facts")
      .select(["order_id", "net_effect_minor", "currency", "created_at"])
      .where("order_id", "=", context.order.id)
      .orderBy("created_at")
      .orderBy("fact_id")
      .execute()
  ]);
  const lifecycle = projectOrderLifecycle({
    order: context.order,
    stay: context.stay,
    businessDate,
    segments,
    amendments,
    revisions,
    facts,
    activeTimeline: []
  });
  return lifecycle.effectiveArrangement.intervals.flatMap((interval) =>
    enumerateServiceDates(interval.arrivalDate, interval.departureDate)
      .map((serviceDate) => ({ serviceDate, inventoryUnitId: interval.inventoryUnitId }))
  );
}

async function priceStayTimeline(db: DbExecutor, options: {
  propertyId: string;
  orderId: string;
  memberId: string | null;
  memberContractId: string | null;
  arrivalDate: string;
  departureDate: string;
  stayType: StayType;
  policyVersionId: string;
  timeline: StayTimelineItem[];
  manualAdjustmentMinor: number;
  coverageAllocationDates?: string[];
  reallocatableHeld?: CoverageCandidate[];
  preservedCoverageOnly?: boolean;
}): Promise<PricingResult> {
  if (options.stayType === "FREE" && (options.memberId || options.memberContractId)) {
    throw new DomainError("PRICING_POLICY_UNCONFIGURED", "Free stays cannot use member entitlement coverage", 409);
  }
  const expectedDates = enumerateServiceDates(options.arrivalDate, options.departureDate);
  if (expectedDates.length !== options.timeline.length || expectedDates.some((date, index) => options.timeline[index]?.serviceDate !== date)) {
    throw new DomainError("INTERNAL_ERROR", "Stay pricing timeline does not cover the order interval", 500);
  }

  const unitIds = [...new Set(options.timeline.map((item) => item.inventoryUnitId))];
  const units = new Map((await Promise.all(unitIds.map((unitId) => loadInventoryUnit(db, options.propertyId, unitId)))).map((unit) => [unit.id, unit]));
  const unitKinds = new Set([...units.values()].map((unit) => unit.kind));
  if ((options.memberId || options.memberContractId) && unitKinds.size !== 1) {
    throw new DomainError("ENTITLEMENT_CONFLICT", "Member coverage cannot span room and bed inventory without an approved business case", 409);
  }

  const preserved = await activeCoverageCandidates(db, options.orderId, expectedDates);
  const allocationDates = options.coverageAllocationDates ?? expectedDates;
  const firstUnit = units.get(options.timeline[0]!.inventoryUnitId)!;
  if (options.memberId && [...units.values()].some((unit) => unit.kind !== firstUnit.kind || unit.roomTypeCode !== firstUnit.roomTypeCode)) {
    throw new DomainError("ENTITLEMENT_CONFLICT", "会员住宿不能跨越不同会员产品对应的房型", 409);
  }
  const allocated = options.preservedCoverageOnly
    ? preserved
    : options.memberId
    ? (await resolveMemberCoverage(db, {
      propertyId: options.propertyId,
      memberId: options.memberId,
      inventoryUnitKind: firstUnit.kind,
      roomTypeCode: firstUnit.roomTypeCode,
      dates: allocationDates,
      // Preserve consumed history as eligibility evidence when an in-house
      // membership expires and newly added nights must fall back to cash.
      preserved,
      ...(options.reallocatableHeld ? { reallocatableHeld: options.reallocatableHeld } : {})
    })).coverageCandidates
    : await allocateCoverageCandidates(db, {
      propertyId: options.propertyId,
      inventoryUnitKind: firstUnit.kind,
      dates: allocationDates,
      preserved: preserved.filter((item) => allocationDates.includes(item.serviceDate)),
      ...(options.reallocatableHeld ? { reallocatableHeld: options.reallocatableHeld } : {}),
      ...(options.memberContractId ? { memberContractId: options.memberContractId } : {})
    });
  const candidates = [...preserved.filter((item) => !allocationDates.includes(item.serviceDate)), ...allocated]
    .sort((left, right) => left.serviceDate.localeCompare(right.serviceDate));
  const policy = await loadPricingPolicy(db, options.propertyId, options.policyVersionId, true);
  if (policy.calculationKind === "DURATION_BAND_TOTAL") {
    return calculateDurationTimelinePricing({
      propertyId: options.propertyId,
      arrivalDate: options.arrivalDate,
      departureDate: options.departureDate,
      stayType: options.stayType,
      policy,
      memberCoverage: Boolean(options.memberId || options.memberContractId),
      timeline: options.timeline.map((item) => {
        const unit = units.get(item.inventoryUnitId)!;
        return {
          serviceDate: item.serviceDate,
          inventoryUnitId: unit.id,
          inventoryUnitKind: unit.kind,
          inventoryProductCode: unit.pricingProductCode
        };
      }),
      coverageCandidates: candidates,
      manualAdjustmentMinor: options.manualAdjustmentMinor
    });
  }
  const pieces = timelineRuns(options.timeline).map((run) => {
    const unit = units.get(run.inventoryUnitId)!;
    return calculatePricing({
      propertyId: options.propertyId,
      inventoryUnitId: unit.id,
      inventoryUnitKind: unit.kind,
      inventoryProductCode: unit.pricingProductCode,
      arrivalDate: run.arrivalDate,
      departureDate: run.departureDate,
      stayType: options.stayType,
      policy,
      memberCoverage: Boolean(options.memberId || options.memberContractId),
      coverageCandidates: candidates.filter((candidate) => candidate.serviceDate >= run.arrivalDate && candidate.serviceDate < run.departureDate),
      manualAdjustmentMinor: 0
    });
  });
  const cashRemainderMinor = pieces.reduce((sum, piece) => sum + piece.cashRemainder.minorUnits, 0);
  const currentContractAmountMinor = cashRemainderMinor + options.manualAdjustmentMinor;
  if (!Number.isSafeInteger(cashRemainderMinor) || !Number.isSafeInteger(currentContractAmountMinor)
    || cashRemainderMinor > 2_147_483_647
    || currentContractAmountMinor < -2_147_483_648
    || currentContractAmountMinor > 2_147_483_647) {
    throw new DomainError("VALIDATION_ERROR", "Calculated amount exceeds the supported integer range");
  }
  return {
    coverageSet: pieces.flatMap((piece) => piece.coverageSet),
    cashLines: pieces.flatMap((piece) => piece.cashLines),
    cashRemainder: { currency: policy.currency, minorUnits: cashRemainderMinor },
    currentContractAmount: { currency: policy.currency, minorUnits: currentContractAmountMinor }
  };
}

async function activeRefundedAmount(db: DbExecutor, collectionFactId: string): Promise<number> {
  const refunds = await db.selectFrom("collection_facts as refund")
    .leftJoin("collection_facts as reversal", "reversal.reverses_fact_id", "refund.fact_id")
    .select(["refund.amount_minor", "reversal.fact_id as reversal_id"])
    .where("refund.references_fact_id", "=", collectionFactId)
    .where("refund.fact_type", "=", "REFUND")
    .execute();
  return refunds.filter((refund) => !refund.reversal_id).reduce((sum, refund) => sum + refund.amount_minor, 0);
}

async function loadOrderContextForProperty(db: DbExecutor, propertyId: string, orderId: string): Promise<OrderContext> {
  const scopedOrder = await db.selectFrom("orders")
    .select("id")
    .where("id", "=", orderId)
    .where("property_id", "=", propertyId)
    .executeTakeFirst();
  if (!scopedOrder) throw new DomainError("NOT_FOUND", "Order not found", 404);
  return loadOrderContext(db, orderId);
}

function finalize(propertyId: string, effect: Record<string, unknown>, basisVersions: Record<string, unknown>): BuiltCommandEffect {
  return { propertyId, effect, basisVersions, effectHash: stableHash({ effect, basisVersions }) };
}

function dateDiff(beforeDates: string[], afterDates: string[]) {
  const before = new Set(beforeDates);
  const after = new Set(afterDates);
  return {
    preservedDates: beforeDates.filter((date) => after.has(date)),
    releasedDates: beforeDates.filter((date) => !after.has(date)),
    addedDates: afterDates.filter((date) => !before.has(date))
  };
}

async function assertStayDateChangeLifecycle(
  db: DbExecutor,
  context: OrderContext,
  businessDate: string,
  activeTimeline: readonly StayTimelineItem[]
): Promise<void> {
  const [segments, amendments, revisions, facts] = await Promise.all([
    db.selectFrom("stay_segments")
      .selectAll()
      .where("stay_id", "=", context.stay.id)
      .orderBy("sequence")
      .execute(),
    db.selectFrom("amendments")
      .leftJoin("command_executions", "command_executions.id", "amendments.command_id")
      .leftJoin("subjects", "subjects.id", "command_executions.subject_id")
      .selectAll("amendments")
      .select([
        "command_executions.subject_id as actor_subject_id",
        "subjects.display_name as actor_display_name"
      ])
      .where("amendments.order_id", "=", context.order.id)
      .orderBy("amendments.sequence")
      .execute(),
    db.selectFrom("pricing_revisions")
      .selectAll()
      .where("order_id", "=", context.order.id)
      .orderBy("revision_no")
      .execute(),
    db.selectFrom("collection_facts")
      .selectAll()
      .where("order_id", "=", context.order.id)
      .orderBy("created_at")
      .orderBy("fact_id")
      .execute()
  ]);
  projectOrderLifecycle({
    order: context.order,
    stay: context.stay,
    businessDate,
    segments,
    amendments,
    revisions,
    facts,
    activeTimeline
  });
}

function pricingDecisionEffect(
  currency: string,
  decision: ReturnType<typeof stayChangePricingDecision>
) {
  return {
    pricingBasis: decision.pricingBasis,
    policyBaseAmount: money(currency, decision.policyBaseAmountMinor),
    targetCurrentContractAmount: money(currency, decision.currentContractAmountMinor),
    differenceFromPolicy: money(currency, decision.differenceFromPolicyMinor),
    manualAdjustmentMinor: decision.manualAdjustmentMinor,
    differenceExceedsThreshold: decision.differenceExceedsThreshold,
    reason: decision.reason
  };
}

export async function buildCommandEffect(db: DbExecutor, commandType: CommandType, rawInput: unknown, lockPayments = false): Promise<BuiltCommandEffect> {
  const built = await buildRawCommandEffect(db, commandType, rawInput);
  const { externalPaymentBasis } = await import("../external-payments.ts");
  const payments = await externalPaymentBasis(db, built.propertyId, commandType, built.effect, lockPayments);
  return payments.length ? finalize(built.propertyId, built.effect, { ...built.basisVersions, externalPayments: payments }) : built;
}

async function buildRawCommandEffect(db: DbExecutor, commandType: CommandType, rawInput: unknown): Promise<BuiltCommandEffect> {
  const input = requireObject(rawInput);
  const propertyId = requireString(input, "propertyId");
  if (commandType === "MANAGE_ROOM_CATALOG") return buildRoomCatalogEffect(db, input);

  if (commandType === HISTORICAL_STAY_ARRANGEMENT_CORRECTION_COMMAND) {
    return buildHistoricalStayArrangementCorrectionEffect(db, rawInput);
  }
  if (isMemberCorrectionCommandType(commandType)) {
    if (commandType === "CORRECT_MEMBERSHIP_EFFECTIVE_DATE") {
      await rejectTemporaryOtherRoomMemberChainChange(db, propertyId, {
        membershipOrderId: requireString(input, "membershipOrderId")
      });
    }
    if (commandType === "VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY") {
      await rejectTemporaryOtherRoomMemberChainChange(db, propertyId, {
        membershipOrderId: requireString(input, "erroneousMembershipOrderId"),
        sourceStayOrderId: requireString(input, "sourceStayOrderId")
      });
    }
    return buildMemberCorrectionEffect(db, commandType, rawInput);
  }

  if (commandType === "CREATE_MEMBER") {
    const member = {
      fullName: requireString(input, "fullName"),
      nickname: requireString(input, "nickname"),
      identityCardNumber: optionalIdentityCardNumber(input.identityCardNumber),
      phone: normalizePhoneNumber(input.phone),
      wechat: requireString(input, "wechat")
    };
    const existingMember = await db.selectFrom("members").selectAll()
      .where("deleted_at", "is", null)
      .where("phone", "=", member.phone)
      .executeTakeFirst();
    if (existingMember) {
      throw new DomainError("VALIDATION_ERROR", "该手机号已登记，不能重复创建会员档案", 409);
    }

    return finalize(propertyId, {
      operation: "CREATE_MEMBER_PROFILE",
      memberId: null,
      member,
      propertyLink: { operation: "CREATE" }
    }, {
      member: null
    });
  }

  if (commandType === "CREATE_MEMBERSHIP_ORDER") {
    const memberId = requireString(input, "memberId");
    const membershipProductId = requireString(input, "membershipProductId");
    const agreedPriceMinor = requireNonNegativeWholeYuanMinor(input, "agreedPriceMinor");
    const adjustmentReason = optionalString(input, "priceAdjustmentReason");
    const member = await db.selectFrom("members")
      .where("members.deleted_at", "is", null)
      .innerJoin("member_property_links", "member_property_links.member_id", "members.id")
      .select(["members.id", "members.full_name"])
      .where("members.id", "=", memberId)
      .where("member_property_links.property_id", "=", propertyId)
      .executeTakeFirst();
    if (!member) throw new DomainError("NOT_FOUND", "当前门店未找到该会员", 404);
    const product = await db.selectFrom("membership_products").selectAll()
      .where("id", "=", membershipProductId)
      .where("status", "=", "PUBLISHED")
      .executeTakeFirst();
    if (!product) throw new DomainError("NOT_FOUND", "会员产品不存在", 404);
    const property = await db.selectFrom("properties").select("currency").where("id", "=", propertyId).executeTakeFirst();
    if (!property) throw new DomainError("NOT_FOUND", "Property not found", 404);
    if (product.currency !== property.currency) throw new DomainError("VALIDATION_ERROR", "会员产品币种与门店不一致");
    if (agreedPriceMinor !== product.list_price_minor && !adjustmentReason) {
      throw new DomainError("VALIDATION_ERROR", "修改会员成交价时必须填写调价原因");
    }
    if (agreedPriceMinor === product.list_price_minor && adjustmentReason) {
      throw new DomainError("VALIDATION_ERROR", "未修改成交价时不需要填写调价原因");
    }
    return finalize(propertyId, {
      operation: "CREATE_MEMBERSHIP_ORDER",
      member: { memberId: member.id, fullName: member.full_name },
      product: {
        productId: product.id,
        code: product.code,
        version: product.version,
        name: product.name,
        entitlementUnitKind: product.entitlement_unit_kind,
        entitlementUnits: product.entitlement_units,
        allowedRoomTypeCode: product.allowed_room_type_code,
        allowedInventoryKind: product.allowed_inventory_kind
      },
      pricing: {
        listedPrice: money(product.currency, product.list_price_minor),
        agreedPrice: money(product.currency, agreedPriceMinor),
        adjustment: money(product.currency, agreedPriceMinor - product.list_price_minor),
        adjustmentReason: adjustmentReason ?? null
      },
      status: "DRAFT"
    }, {
      member: { id: member.id, fullName: member.full_name },
      product: { id: product.id, version: product.version, status: product.status }
    });
  }

  if (commandType === "RECORD_MEMBERSHIP_PAYMENT" || commandType === "CORRECT_MEMBERSHIP_PAYMENT" || commandType === "ACTIVATE_MEMBERSHIP_ORDER") {
    const membershipOrderId = requireString(input, "membershipOrderId");
    const order = await db.selectFrom("membership_orders")
      .innerJoin("members", "members.id", "membership_orders.member_id")
      .selectAll("membership_orders")
      .select("members.full_name as member_name")
      .where("membership_orders.id", "=", membershipOrderId)
      .where("membership_orders.property_id", "=", propertyId)
      .executeTakeFirst();
    if (!order) throw new DomainError("NOT_FOUND", "会员订单不存在", 404);
    if (order.status !== "DRAFT" && order.status !== "ACTIVE") {
      throw new DomainError("AGGREGATE_VERSION_CONFLICT", "已作废的会员订单不能再收款", 409);
    }
    const paymentState = await membershipPaymentState(db, order.id);

    if (commandType === "RECORD_MEMBERSHIP_PAYMENT") {
      if (order.status === "ACTIVE" && paymentState.total >= order.agreed_price_minor) {
        throw new DomainError("AGGREGATE_VERSION_CONFLICT", "该会员订单已经足额或多收，不能继续登记收款", 409);
      }
      const amountMinor = requireInteger(input, "amountMinor", { min: 1 });
      const transactionReference = requireTransactionReference(input.transactionReference);
      const note = optionalString(input, "note") ?? "";
      const businessDate = await propertyLocalToday(db, propertyId);
      const after = paymentState.total + amountMinor;
      if (!Number.isSafeInteger(after) || after > 2_147_483_647) throw new DomainError("VALIDATION_ERROR", "会员订单收款合计超出支持范围");
      return finalize(propertyId, {
        operation: "RECORD_MEMBERSHIP_PAYMENT",
        membershipOrderId: order.id,
        memberName: order.member_name,
        productName: order.product_name,
        payment: { amount: money(order.currency, amountMinor), businessDate, transactionReference, note },
        totals: {
          agreedPrice: money(order.currency, order.agreed_price_minor),
          previouslyCollected: money(order.currency, paymentState.total),
          currentCollection: money(order.currency, amountMinor),
          differenceAfter: money(order.currency, after - order.agreed_price_minor)
        },
        status: order.status
      }, { membershipOrderVersion: order.version, paymentFactsHash: paymentState.hash });
    }

    if (order.status !== "DRAFT") {
      throw new DomainError("AGGREGATE_VERSION_CONFLICT", "已生效的会员订单不能更正收款或重复激活", 409);
    }

    if (commandType === "CORRECT_MEMBERSHIP_PAYMENT") {
      const originalPaymentFactId = requireString(input, "originalPaymentFactId");
      const original = paymentState.facts.find((fact) => fact.fact_id === originalPaymentFactId);
      if (!original || original.fact_type !== "COLLECTION") throw new DomainError("NOT_FOUND", "待更正的企微收款不存在", 404);
      if (paymentState.facts.some((fact) => fact.reverses_fact_id === original.fact_id)) {
        throw new DomainError("FACT_ALREADY_REVERSED", "该企微收款已经更正", 409);
      }
      const correctedAmountMinor = requireInteger(input, "correctedAmountMinor", { min: 1 });
      const correctedTransactionReference = requireTransactionReference(input.correctedTransactionReference);
      const note = optionalString(input, "note") ?? "";
      const after = paymentState.total - original.amount_minor + correctedAmountMinor;
      if (!Number.isSafeInteger(after) || after < 0 || after > 2_147_483_647) throw new DomainError("VALIDATION_ERROR", "更正后的收款合计超出支持范围");
      return finalize(propertyId, {
        operation: "CORRECT_MEMBERSHIP_PAYMENT",
        membershipOrderId: order.id,
        memberName: order.member_name,
        productName: order.product_name,
        originalPaymentFactId: original.fact_id,
        original: {
          amount: money(order.currency, original.amount_minor),
          businessDate: original.business_date,
          transactionReference: requireTransactionReference(original.transaction_reference)
        },
        replacement: {
          amount: money(order.currency, correctedAmountMinor),
          businessDate: original.business_date,
          transactionReference: correctedTransactionReference,
          note
        },
        totals: {
          before: money(order.currency, paymentState.total),
          after: money(order.currency, after),
          agreedPrice: money(order.currency, order.agreed_price_minor),
          differenceAfter: money(order.currency, after - order.agreed_price_minor)
        },
        status: "DRAFT"
      }, { membershipOrderVersion: order.version, paymentFactsHash: paymentState.hash });
    }

    if (paymentState.total <= 0 || !paymentState.facts.some((fact) => fact.fact_type === "COLLECTION" && !paymentState.facts.some((candidate) => candidate.reverses_fact_id === fact.fact_id))) {
      throw new DomainError("VALIDATION_ERROR", "会员订单至少登记一笔有效企微收款后才能生效");
    }
    const [activeOrders, activeContracts, activeLots] = await Promise.all([
      db.selectFrom("membership_orders").select("id")
        .where("property_id", "=", propertyId)
        .where("member_id", "=", order.member_id)
        .where("status", "=", "ACTIVE")
        .orderBy("id")
        .execute(),
      db.selectFrom("member_contracts").select("id")
        .where("property_id", "=", propertyId)
        .where("member_id", "=", order.member_id)
        .where("status", "=", "ACTIVE")
        .orderBy("id")
        .execute(),
      db.selectFrom("entitlement_lots")
        .innerJoin("member_contracts", "member_contracts.id", "entitlement_lots.contract_id")
        .select("entitlement_lots.id")
        .where("member_contracts.property_id", "=", propertyId)
        .where("member_contracts.member_id", "=", order.member_id)
        .where("entitlement_lots.status", "=", "ACTIVE")
        .orderBy("entitlement_lots.id")
        .execute()
    ]);
    if (activeOrders.length > 0 || activeContracts.length > 0 || activeLots.length > 0) {
      throw new DomainError("ENTITLEMENT_CONFLICT", "该会员已有生效中的会员记录，不能再次激活会员订单", 409);
    }
    const validFrom = await propertyLocalToday(db, propertyId);
    const validUntil = addOneCalendarYear(validFrom);
    return finalize(propertyId, {
      operation: "ACTIVATE_MEMBERSHIP_ORDER",
      membershipOrderId: order.id,
      memberName: order.member_name,
      productName: order.product_name,
      paymentTotal: money(order.currency, paymentState.total),
      agreedPrice: money(order.currency, order.agreed_price_minor),
      paymentDifference: money(order.currency, paymentState.total - order.agreed_price_minor),
      validFrom,
      validUntil,
      entitlementUnitKind: order.entitlement_unit_kind,
      entitlementUnits: order.entitlement_units,
      fromStatus: "DRAFT",
      toStatus: "ACTIVE"
    }, { membershipOrderVersion: order.version, paymentFactsHash: paymentState.hash, validFrom });
  }

  if (commandType === "LOCK_MAINTENANCE") {
    const arrivalDate = requireString(input, "arrivalDate");
    const departureDate = requireString(input, "departureDate");
    enumerateServiceDates(arrivalDate, departureDate);
  }
  if (commandType === "EXTEND_STAY") {
    parseLocalDate(requireString(input, "newDepartureDate"));
  }

  if (commandType === "CREATE_ORDER") {
    const quoteId = requireString(input, "quoteId");
    const submittedGuest = requireObject(input.primaryGuest, "primaryGuest");
    const phone = optionalString(submittedGuest, "phone");
    const documentNumber = optionalString(submittedGuest, "documentNumber");
    const guest = {
      fullName: requireString(submittedGuest, "fullName"),
      nickname: requireString(submittedGuest, "nickname"),
      ...(phone ? { phone } : {}),
      ...(documentNumber ? { documentNumber } : {})
    };
    const additionalGuestInputs = input.additionalGuests ?? [];
    if (!Array.isArray(additionalGuestInputs)) {
      throw new DomainError("VALIDATION_ERROR", "additionalGuests must be an array");
    }
    const additionalGuests = additionalGuestInputs.map((value, index) => {
      const submitted = requireObject(value, `additionalGuests[${index}]`);
      const additionalPhone = optionalString(submitted, "phone");
      const additionalDocumentNumber = optionalString(submitted, "documentNumber");
      return {
        fullName: requireString(submitted, "fullName"),
        nickname: requireString(submitted, "nickname"),
        ...(additionalPhone ? { phone: additionalPhone } : {}),
        ...(additionalDocumentNumber ? { documentNumber: additionalDocumentNumber } : {})
      };
    });
    const quote = await loadStoredQuote(db, quoteId);
    if (quote.propertyId !== propertyId) throw new DomainError("RESOURCE_SCOPE_DENIED", "Quote belongs to another property", 403);
    if (quote.stayType !== "FREE") await assertCurrentCatalogQuote(db, propertyId, quote.pricingPolicyVersionId, quote.arrivalDate);
    const temporaryOtherRoomArrangement = quote.temporaryOtherRoomArrangement;
    const temporaryOtherRoomReason = temporaryOtherRoomArrangement
      ? requireTemporaryOtherRoomReason(input)
      : null;
    if (!temporaryOtherRoomArrangement
      && input.temporaryOtherRoomReason !== undefined
      && input.temporaryOtherRoomReason !== null) {
      throw new DomainError("VALIDATION_ERROR", "普通创建订单不应填写临时安排其他房型原因");
    }
    if (input.backfill !== undefined && input.backfill !== true) {
      throw new DomainError("VALIDATION_ERROR", "backfill must be true when submitted");
    }
    const backfill = input.backfill === true;
    if (!backfill && (input.backfillReason !== undefined || input.backfillCollection !== undefined)) {
      throw new DomainError("VALIDATION_ERROR", "普通创建订单不应填写补录原因或补录收款");
    }
    const businessDate = await propertyLocalToday(db, propertyId);
    if (backfill && quote.arrivalDate >= businessDate) {
      throw new DomainError("VALIDATION_ERROR", "补录住宿必须从今天以前开始", 409);
    }
    if (!backfill && quote.arrivalDate < businessDate) {
      throw new DomainError("VALIDATION_ERROR", "今天以前的住宿必须使用补录住宿入口", 409);
    }
    const backfillReason = backfill ? requireString(input, "backfillReason") : null;
    if (backfill && input.backfillCollection !== undefined && input.backfillCollection !== null && typeof input.backfillCollection !== "object") {
      throw new DomainError("VALIDATION_ERROR", "backfillCollection must be an object");
    }
    const memberStay = Boolean(quote.memberId || quote.memberContractId);
    const freeStay = quote.stayType === "FREE";
    if (backfill && memberStay) {
      throw new DomainError("VALIDATION_ERROR", "当前补录只支持普通住宿或免费入住，不支持会员权益住宿");
    }
    if (backfill && temporaryOtherRoomArrangement) {
      throw new DomainError("VALIDATION_ERROR", "临时安排其他房型不支持补录创建");
    }
    const channelSubmitted = (input.bookingChannelCode !== undefined && input.bookingChannelCode !== null)
      || (input.channelOrderReference !== undefined && input.channelOrderReference !== null && input.channelOrderReference !== "");
    if (memberStay && channelSubmitted) {
      throw new DomainError("VALIDATION_ERROR", "会员住宿不应填写订单来源渠道或渠道订单号");
    }
    if (freeStay && channelSubmitted) {
      throw new DomainError("VALIDATION_ERROR", "免费入住不应填写订单来源渠道或渠道订单号");
    }
    const { bookingChannelCode, channelOrderReference } = memberStay || freeStay
      ? { bookingChannelCode: null, channelOrderReference: null }
      : validateBookingChannel(input.bookingChannelCode, input.channelOrderReference);
    const externalChannel = Boolean(bookingChannelCode && externalChannelCodes.has(bookingChannelCode));
    let backfillCollection: Record<string, unknown> | null = null;
    if (backfill && !memberStay && !freeStay && !externalChannel) {
      const raw = input.backfillCollection;
      if (raw !== undefined && raw !== null) {
        const normalizedCollection = normalizeBackfillCollectionInput(raw);
        backfillCollection = normalizedCollection.amountMinor > 0 ? normalizedCollection : null;
      }
    } else if (backfill && input.backfillCollection !== undefined && input.backfillCollection !== null) {
      throw new DomainError("VALIDATION_ERROR", "会员、免费住宿和外部渠道补录不登记 PMS 住宿收款");
    }
    const freeStayReason = freeStay ? requireString(input, "freeStayReason") : null;
    if (!freeStay && input.freeStayReason !== undefined && input.freeStayReason !== null) {
      throw new DomainError("VALIDATION_ERROR", "freeStayReason is only allowed for FREE stays");
    }
    const freeStayCategoryCode = freeStay ? requireString(input, "freeStayCategoryCode") : null;
    if (!freeStay && input.freeStayCategoryCode !== undefined && input.freeStayCategoryCode !== null) {
      throw new DomainError("VALIDATION_ERROR", "freeStayCategoryCode is only allowed for FREE stays");
    }
    if (freeStay && !freeStayCategoryCodes.includes(freeStayCategoryCode as FreeStayCategoryCode)) {
      throw new DomainError("VALIDATION_ERROR", "免费入住类型必须是义工或接待");
    }
    const unit = await loadInventoryUnit(db, propertyId, quote.inventoryUnitId);
    if (backfill) {
      await assertNoCompletedStayOverlap(db, {
        propertyId,
        inventoryUnitId: unit.id,
        roomId: unit.roomId,
        inventoryKind: unit.kind,
        arrivalDate: quote.arrivalDate,
        departureDate: quote.departureDate
      });
    }
    const guestSnapshots = [guest, ...additionalGuests];
    if (guestSnapshots.length > unit.occupancyCapacity) {
      throw new DomainError(
        "VALIDATION_ERROR",
        `${unit.code} 最多登记 ${unit.occupancyCapacity} 位住宿人，本次提交了 ${guestSnapshots.length} 位`
      );
    }
    const frozenOccupantIds = input._occupantIds;
    if (!Array.isArray(frozenOccupantIds) || frozenOccupantIds.length !== guestSnapshots.length
      || frozenOccupantIds.some((id) => typeof id !== "string" || !id.trim())
      || new Set(frozenOccupantIds).size !== frozenOccupantIds.length) {
      throw new DomainError("VALIDATION_ERROR", "CREATE_ORDER requires a stable occupant ID for every submitted guest");
    }
    const occupants = guestSnapshots.map((snapshot, index) => ({
      id: frozenOccupantIds[index] as string,
      ordinal: index + 1,
      role: index === 0 ? "PRIMARY" as const : "ADDITIONAL" as const,
      ...snapshot
    }));
    const fingerprint = await inventoryFingerprint(db, propertyId, unit.id, quote.arrivalDate, quote.departureDate);
    if (fingerprint.length > 0) throw new DomainError("INVENTORY_CONFLICT", "Quoted inventory is no longer available", 409);
    const policyPricing = temporaryOtherRoomArrangement
      ? await priceTemporaryOtherRoomQuote(db, quote, temporaryOtherRoomArrangement)
      : await priceSingleUnit(db, {
        propertyId,
        memberId: quote.memberId ?? null,
        memberContractId: quote.memberContractId ?? null,
        unitId: quote.inventoryUnitId,
        arrivalDate: quote.arrivalDate,
        departureDate: quote.departureDate,
        stayType: quote.stayType,
        policyVersionId: quote.pricingPolicyVersionId,
        manualAdjustmentMinor: 0
      });
    const pricingDecision = createOrderPricingDecision({
      bookingChannelCode,
      stayType: quote.stayType,
      memberStay,
      policyBaseAmountMinor: policyPricing.currentContractAmount.minorUnits,
      targetCurrentContractAmountMinor: input.targetCurrentContractAmountMinor,
      channelPriceDifferenceReason: input.channelPriceDifferenceReason,
      manualPriceAdjustmentReason: input.manualPriceAdjustmentReason
    });
    if (externalChannel && pricingDecision.currentContractAmountMinor <= 0) {
      throw new DomainError("VALIDATION_ERROR", "普通付费渠道订单的本单渠道应结金额必须大于 0");
    }
    const pricing = {
      ...policyPricing,
      currentContractAmount: money(policyPricing.currentContractAmount.currency, pricingDecision.currentContractAmountMinor)
    };
    if (backfillCollection) {
      const amountMinor = requireInteger(backfillCollection, "amountMinor", { min: 0 });
      if (!Number.isSafeInteger(amountMinor) || amountMinor < 0 || amountMinor > pricing.currentContractAmount.minorUnits) {
        throw new DomainError("VALIDATION_ERROR", "补录实收金额不能超过本单应收金额");
      }
    }
    const pricingDecisionEffect = {
      pricingBasis: pricingDecision.pricingBasis,
      policyBaseAmount: money(pricing.currentContractAmount.currency, pricingDecision.policyBaseAmountMinor),
      targetCurrentContractAmount: money(pricing.currentContractAmount.currency, pricingDecision.currentContractAmountMinor),
      differenceFromPolicy: money(pricing.currentContractAmount.currency, pricingDecision.differenceFromPolicyMinor),
      manualAdjustmentMinor: pricingDecision.manualAdjustmentMinor,
      differenceExceedsThreshold: pricingDecision.differenceExceedsThreshold,
      reason: pricingDecision.reason
    };
    if (backfill && !currentReleaseFeatures.completedStayBackfillCreation) {
      throw new DomainError("VALIDATION_ERROR", "补录提交将在 8.3 开放", 409);
    }
    const backfillCollectedAmountMinor = backfillCollection
      ? requireInteger(backfillCollection, "amountMinor", { min: 0 })
      : 0;
    const backfillBalanceDueMinor = freeStay || externalChannel
      ? 0
      : pricing.currentContractAmount.minorUnits - backfillCollectedAmountMinor;
    const effect = {
      quoteId,
      primaryGuest: guest,
      occupants,
      occupancyCapacity: unit.occupancyCapacity,
      bookingChannelCode,
      channelOrderReference,
      freeStayReason,
      freeStayCategoryCode,
      inventoryUnit: unit,
      stayType: quote.stayType,
      arrivalDate: quote.arrivalDate,
      departureDate: quote.departureDate,
      pricingPolicyVersionId: quote.pricingPolicyVersionId,
      memberId: quote.memberId ?? null,
      memberContractId: quote.memberContractId ?? null,
      ...(temporaryOtherRoomArrangement ? {
        temporaryOtherRoomArrangement,
        temporaryOtherRoomReason
      } : {}),
      pricingDecision: pricingDecisionEffect,
      pricing,
      ...(backfill ? {
        backfill: {
          reason: backfillReason,
          businessDate,
          resultingOrderStatus: quote.departureDate <= businessDate ? "CHECKED_OUT" : "CHECKED_IN",
          resultingStayStatus: quote.departureDate <= businessDate ? "COMPLETED" : "IN_HOUSE",
          collection: backfillCollection,
          externalChannel,
          settlementStatus: backfillBalanceDueMinor > 0 ? "ARREARS" : "SETTLED",
          collectedAmountMinor: backfillCollectedAmountMinor,
          balanceDueMinor: backfillBalanceDueMinor
        }
      } : {})
    };
    return finalize(propertyId, effect, {
      quoteInputHash: quote.inputHash,
      businessDate,
      inventory: fingerprint,
      occupancyCapacity: unit.occupancyCapacity,
      membership: await memberBasis(db, propertyId, quote.memberContractId ?? null, quote.memberId)
    });
  }

  if (commandType === "LOCK_MAINTENANCE") {
    const unitId = requireString(input, "inventoryUnitId");
    const arrivalDate = requireString(input, "arrivalDate");
    const departureDate = requireString(input, "departureDate");
    const reason = requireString(input, "reason");
    const unit = await loadInventoryUnit(db, propertyId, unitId);
    const fingerprint = await inventoryFingerprint(db, propertyId, unitId, arrivalDate, departureDate);
    if (fingerprint.length > 0) throw new DomainError("INVENTORY_CONFLICT", "Inventory cannot be locked for maintenance", 409);
    return finalize(propertyId, { inventoryUnit: unit, arrivalDate, departureDate, reason }, { inventory: fingerprint });
  }

  if (commandType === "RELEASE_MAINTENANCE") {
    const maintenanceLockId = requireString(input, "maintenanceLockId");
    const lock = await db.selectFrom("maintenance_locks").selectAll().where("id", "=", maintenanceLockId).where("property_id", "=", propertyId).executeTakeFirst();
    if (!lock) throw new DomainError("NOT_FOUND", "Maintenance lock not found", 404);
    if (lock.status !== "ACTIVE") throw new DomainError("AGGREGATE_VERSION_CONFLICT", "Maintenance lock is already released", 409);
    const expectedDates = enumerateServiceDates(lock.arrival_date, lock.departure_date);
    const claims = await db.selectFrom("inventory_claims")
      .select(["id", "property_id", "room_id", "inventory_unit_id", "service_date", "active", "released_at"])
      .where("source_type", "=", "MAINTENANCE")
      .where("source_id", "=", maintenanceLockId)
      .orderBy("service_date")
      .orderBy("id")
      .execute();
    const expectedRoom = await db.selectFrom("inventory_units")
      .select(["id", "kind", "parent_room_id"])
      .where("id", "=", lock.inventory_unit_id)
      .where("property_id", "=", propertyId)
      .executeTakeFirst();
    const expectedRoomId = expectedRoom?.kind === "ROOM" ? expectedRoom.id : expectedRoom?.parent_room_id;
    const completeClaimSet = Boolean(expectedRoomId)
      && claims.length === expectedDates.length
      && claims.every((claim, index) => (
        claim.property_id === propertyId
        && claim.room_id === expectedRoomId
        && claim.inventory_unit_id === lock.inventory_unit_id
        && claim.service_date === expectedDates[index]
        && claim.active
        && claim.released_at === null
      ));
    if (!completeClaimSet) {
      throw new DomainError("AGGREGATE_VERSION_CONFLICT", "Maintenance lock Claim set is incomplete or already partially released", 409);
    }
    return finalize(
      propertyId,
      { maintenanceLockId, inventoryUnitId: lock.inventory_unit_id, arrivalDate: lock.arrival_date, departureDate: lock.departure_date },
      {
        maintenanceVersion: lock.version,
        status: lock.status,
        maintenanceClaims: claims.map((claim) => `${claim.service_date}:${claim.id}:ACTIVE`)
      }
    );
  }

  if (commandType === "COMPLETE_CLEANING") {
    if (!currentReleaseFeatures.cleaningWorkflow) {
      throw new DomainError("VALIDATION_ERROR", "Cleaning workflow is disabled in this release", 409);
    }
    const cleaningTaskId = requireString(input, "cleaningTaskId");
    const task = await db.selectFrom("cleaning_tasks").selectAll()
      .where("id", "=", cleaningTaskId)
      .where("property_id", "=", propertyId)
      .executeTakeFirst();
    if (!task) throw new DomainError("NOT_FOUND", "Cleaning task not found", 404);
    if (task.status !== "PENDING") throw new DomainError("AGGREGATE_VERSION_CONFLICT", "Cleaning task is already completed", 409);
    return finalize(propertyId, {
      cleaningTaskId,
      orderId: task.order_id,
      stayId: task.stay_id,
      inventoryUnitId: task.inventory_unit_id,
      roomId: task.room_id,
      serviceDate: task.service_date,
      fromStatus: task.status,
      toStatus: "COMPLETED"
    }, { cleaningTaskVersion: task.version, status: task.status });
  }

  if (commandType === "ADD_MEMBER_ENTITLEMENT_LOT") {
    const contractId = requireString(input, "memberContractId");
    const unitKind = requireString(input, "unitKind");
    if (unitKind !== "ROOM_NIGHT" && unitKind !== "BED_NIGHT") throw new DomainError("VALIDATION_ERROR", "unitKind must be ROOM_NIGHT or BED_NIGHT");
    const units = requireInteger(input, "units", { min: 1 });
    const expiresOn = requireString(input, "expiresOn");
    parseLocalDate(expiresOn);
    const propertyToday = await propertyLocalToday(db, propertyId);
    const contract = await db.selectFrom("member_contracts").selectAll()
      .where("id", "=", contractId).where("property_id", "=", propertyId).executeTakeFirst();
    if (!contract) throw new DomainError("NOT_FOUND", "Member contract not found", 404);
    await rejectTemporaryOtherRoomMemberChainChange(db, propertyId, { memberContractId: contractId });
    if (contract.status !== "ACTIVE") throw new DomainError("ENTITLEMENT_CONFLICT", "Member contract is not active", 409);
    if (expiresOn < propertyToday) {
      throw new DomainError("ENTITLEMENT_CONFLICT", "Entitlement lot is already naturally expired in the property timezone", 409, false, { expiresOn, propertyToday });
    }
    if (expiresOn < contract.valid_from || expiresOn > contract.valid_until) {
      throw new DomainError("VALIDATION_ERROR", "Entitlement lot expiry must be inside the member contract validity interval");
    }
    return finalize(propertyId, { contractId, unitKind, units, expiresOn }, { contractVersion: contract.version, propertyToday });
  }

  if (commandType === "ADJUST_MEMBER_ENTITLEMENT" || commandType === "CORRECT_MEMBER_ENTITLEMENT_BALANCE") {
    const lotId = requireString(input, "entitlementLotId");
    const adjustmentReason = requireString(input, "adjustmentReason");
    const propertyToday = await propertyLocalToday(db, propertyId);
    const lot = await db.selectFrom("entitlement_lots").innerJoin("member_contracts", "member_contracts.id", "entitlement_lots.contract_id")
      .select(["entitlement_lots.id", "entitlement_lots.version", "entitlement_lots.contract_id", "entitlement_lots.unit_kind", "entitlement_lots.total_units", "entitlement_lots.expires_on", "entitlement_lots.status", "member_contracts.property_id", "member_contracts.status as contract_status", "member_contracts.version as contract_version"])
      .where("entitlement_lots.id", "=", lotId).where("member_contracts.property_id", "=", propertyId).executeTakeFirst();
    if (!lot) throw new DomainError("NOT_FOUND", "Entitlement lot not found", 404);
    await rejectTemporaryOtherRoomMemberChainChange(db, propertyId, {
      memberContractId: lot.contract_id,
      entitlementLotId: lot.id
    });
    if (lot.contract_status !== "ACTIVE" || lot.status !== "ACTIVE") {
      throw new DomainError("ENTITLEMENT_CONFLICT", "Only an active member contract and active entitlement lot can be adjusted", 409);
    }
    const expiration = await db.selectFrom("entitlement_ledger").select("fact_id")
      .where("lot_id", "=", lotId).where("entry_type", "=", "EXPIRE").executeTakeFirst();
    if (expiration) throw new DomainError("ENTITLEMENT_CONFLICT", "An expired entitlement lot cannot be adjusted", 409, false, { expirationFactId: expiration.fact_id });
    if (lot.expires_on < propertyToday) {
      throw new DomainError("ENTITLEMENT_CONFLICT", "A naturally expired entitlement lot cannot be adjusted", 409, false, { expiresOn: lot.expires_on, propertyToday });
    }
    const ledger = await db.selectFrom("entitlement_ledger")
      .select(sql<string>`cast(coalesce(sum(quantity_delta), 0) as text)`.as("delta"))
      .where("lot_id", "=", lotId)
      .executeTakeFirstOrThrow();
    const availableBefore = entitlementAvailableBalance(lot.total_units, ledger.delta);
    const quantityDelta = commandType === "CORRECT_MEMBER_ENTITLEMENT_BALANCE"
      ? (() => {
        const expectedAvailableBalance = requireInteger(input, "expectedAvailableBalance", { min: 0 });
        if (expectedAvailableBalance !== availableBefore) {
          throw new DomainError("AGGREGATE_VERSION_CONFLICT", "会员余额已变化，请刷新后重新更正", 409, false, { expectedAvailableBalance, availableBefore });
        }
        const targetAvailableBalance = requireInteger(input, "targetAvailableBalance", { min: 0 });
        if (targetAvailableBalance === availableBefore) {
          throw new DomainError("VALIDATION_ERROR", "更正后余额必须与当前余额不同");
        }
        return targetAvailableBalance - availableBefore;
      })()
      : requireInteger(input, "quantityDelta", { allowZero: false });
    const availableAfter = adjustedEntitlementAvailableBalance(availableBefore, quantityDelta);
    return finalize(propertyId, {
      entitlementLotId: lot.id,
      contractId: lot.contract_id,
      unitKind: lot.unit_kind,
      quantityDelta,
      adjustmentReason,
      availableBefore,
      availableAfter
    }, {
      lotVersion: lot.version,
      contractVersion: lot.contract_version,
      availableBefore,
      propertyToday
    });
  }

  if (commandType === "EXPIRE_MEMBER_ENTITLEMENT") {
    const lotId = requireString(input, "entitlementLotId");
    const asOfDate = requireString(input, "asOfDate");
    const asOf = parseLocalDate(asOfDate);
    const propertyToday = await propertyLocalToday(db, propertyId);
    const lot = await db.selectFrom("entitlement_lots")
      .innerJoin("member_contracts", "member_contracts.id", "entitlement_lots.contract_id")
      .leftJoin("entitlement_ledger", "entitlement_ledger.lot_id", "entitlement_lots.id")
      .select([
        "entitlement_lots.id",
        "entitlement_lots.version",
        "entitlement_lots.contract_id",
        "entitlement_lots.unit_kind",
        "entitlement_lots.total_units",
        "entitlement_lots.expires_on",
        "entitlement_lots.status",
        "member_contracts.property_id",
        "member_contracts.status as contract_status",
        "member_contracts.version as contract_version",
        sql<string>`cast(coalesce(sum(entitlement_ledger.quantity_delta), 0) as text)`.as("ledger_delta"),
        sql<string>`cast(count(*) filter (where entitlement_ledger.entry_type = 'EXPIRE') as text)`.as("expire_count")
      ])
      .where("entitlement_lots.id", "=", lotId)
      .where("member_contracts.property_id", "=", propertyId)
      .groupBy([
        "entitlement_lots.id",
        "entitlement_lots.version",
        "entitlement_lots.contract_id",
        "entitlement_lots.unit_kind",
        "entitlement_lots.total_units",
        "entitlement_lots.expires_on",
        "entitlement_lots.status",
        "member_contracts.property_id",
        "member_contracts.status",
        "member_contracts.version"
    ])
      .executeTakeFirst();
    if (!lot) throw new DomainError("NOT_FOUND", "Entitlement lot not found", 404);
    await rejectTemporaryOtherRoomMemberChainChange(db, propertyId, {
      memberContractId: lot.contract_id,
      entitlementLotId: lot.id
    });
    if (lot.contract_status !== "ACTIVE" || lot.status !== "ACTIVE") {
      throw new DomainError("ENTITLEMENT_CONFLICT", "Only an active member contract and active entitlement lot can be expired", 409);
    }
    if (parsePostgresBigInt(lot.expire_count, "Entitlement expiration count") > 0n) {
      throw new DomainError("ENTITLEMENT_CONFLICT", "Entitlement lot is already expired", 409);
    }
    if (asOf.getTime() <= parseLocalDate(lot.expires_on).getTime()) {
      throw new DomainError("ENTITLEMENT_CONFLICT", "Entitlement lot is still valid on asOfDate", 409, false, { expiresOn: lot.expires_on, asOfDate });
    }
    if (asOfDate > propertyToday) {
      throw new DomainError("ENTITLEMENT_CONFLICT", "Entitlement lot cannot be expired using a future property date", 409, false, { asOfDate, propertyToday });
    }
    const remainingAvailable = entitlementAvailableBalance(lot.total_units, lot.ledger_delta);
    return finalize(propertyId, {
      entitlementLotId: lot.id,
      contractId: lot.contract_id,
      unitKind: lot.unit_kind,
      expiresOn: lot.expires_on,
      asOfDate,
      remainingAvailable,
      quantityDelta: -remainingAvailable,
      entryType: "EXPIRE"
    }, {
      lotVersion: lot.version,
      contractVersion: lot.contract_version,
      remainingAvailable,
      propertyToday
    });
  }

  if (commandType === "ISSUE_TOKEN") {
    const subjectId = requireString(input, "subjectId");
    const label = requireString(input, "label");
    const accessCeiling = requireString(input, "accessCeiling");
    if (accessCeiling !== "READ" && accessCeiling !== "WRITE") throw new DomainError("VALIDATION_ERROR", "accessCeiling must be READ or WRITE");
    const expiresAt = requireFutureDateTime(input, "expiresAt");
    const tokenSecretHash = optionalTokenSecretHash(input);
    const requestedCommandCeiling = requireCommandCeiling(input);
    const subject = await db.selectFrom("subjects")
      .innerJoin("subject_property_grants", "subject_property_grants.subject_id", "subjects.id")
      .select(["subjects.id", "subjects.display_name", "subjects.status", "subjects.auth_version", "subject_property_grants.access_level"])
      .where("subjects.id", "=", subjectId)
      .where("subject_property_grants.property_id", "=", propertyId)
      .executeTakeFirst();
    if (!subject) throw new DomainError("NOT_FOUND", "Subject not found", 404);
    if (subject.status !== "ACTIVE") throw new DomainError("SUBJECT_DISABLED", "Subject is not active for this property", 409);
    if (subject.access_level === "READ" && accessCeiling === "WRITE") throw new DomainError("INSUFFICIENT_ACCESS", "Token cannot exceed subject READ access", 403);
    const targetGrants = await targetSubjectCommandGrants(db, subjectId, propertyId);
    const commandCeiling = resolveTokenCommandCeiling({
      requested: requestedCommandCeiling,
      targetGrants,
      accessCeiling
    });
    const persistedCommandCeiling = persistedTokenCommandCeiling(accessCeiling, commandCeiling);
    return finalize(propertyId, {
      subjectId,
      subjectDisplayName: subject.display_name,
      label,
      accessCeiling,
      commandCeiling,
      persistedCommandCeiling,
      expiresAt
    }, {
      subjectAuthVersion: subject.auth_version,
      subjectAccess: subject.access_level,
      targetCommandGrants: commandGrantTypes(targetGrants),
      targetCommandGrantCatalog: commandGrantBasis(targetGrants),
      persistedCommandCeiling,
      ...(tokenSecretHash ? { tokenSecretHash } : {})
    });
  }

  if (commandType === "ROTATE_TOKEN" || commandType === "REVOKE_TOKEN") {
    const tokenId = requireString(input, "tokenId");
    const token = await db.selectFrom("api_tokens")
      .innerJoin("subjects", "subjects.id", "api_tokens.subject_id")
      .innerJoin("subject_property_grants", "subject_property_grants.subject_id", "subjects.id")
      .select(["api_tokens.id", "api_tokens.subject_id", "api_tokens.label", "api_tokens.access_ceiling", "api_tokens.property_scope", "api_tokens.expires_at", "api_tokens.revoked_at", "api_tokens.replaced_by_id", "subjects.display_name", "subjects.status", "subjects.auth_version", "subject_property_grants.access_level"])
      .where("api_tokens.id", "=", tokenId)
      .where("api_tokens.property_scope", "=", propertyId)
      .where("subject_property_grants.property_id", "=", propertyId)
      .executeTakeFirst();
    if (!token) throw new DomainError("NOT_FOUND", "Token not found", 404);
    if (token.status !== "ACTIVE") throw new DomainError("SUBJECT_DISABLED", "Subject is not active for this property", 409);
    if (commandType !== "REVOKE_TOKEN" && token.access_level === "READ" && token.access_ceiling === "WRITE") {
      throw new DomainError("INSUFFICIENT_ACCESS", "Token exceeds subject READ access", 403);
    }
    if (token.revoked_at) throw new DomainError("AGGREGATE_VERSION_CONFLICT", "Token is already revoked", 409);
    const requestedExpiresAt = optionalString(input, "expiresAt");
    const expiresAt = commandType === "ROTATE_TOKEN"
      ? (requestedExpiresAt ? requireFutureDateTime(input, "expiresAt") : new Date(token.expires_at).toISOString())
      : new Date(token.expires_at).toISOString();
    if (commandType === "ROTATE_TOKEN" && Date.parse(expiresAt) <= Date.now()) throw new DomainError("VALIDATION_ERROR", "Rotated token expiry must be in the future");
    const tokenSecretHash = commandType === "ROTATE_TOKEN" ? requireTokenSecretHash(input) : undefined;
    const targetGrants = await targetSubjectCommandGrants(db, token.subject_id, propertyId);
    const existingCeilingRows = await db.selectFrom("token_command_ceilings")
      .innerJoin("command_catalog", "command_catalog.command_type", "token_command_ceilings.command_type")
      .select(["token_command_ceilings.command_type", "command_catalog.command_class"])
      .where("token_id", "=", token.id)
      .where("subject_id", "=", token.subject_id)
      .where("property_id", "=", propertyId)
      .orderBy("token_command_ceilings.command_type")
      .execute();
    const previousPersistedCommandCeiling = commandGrantTypes(existingCeilingRows);
    const previousCommandCeiling = executableCommandCeilingFromGrants(existingCeilingRows);
    const commandCeiling = commandType === "ROTATE_TOKEN"
      ? resolveTokenCommandCeiling({
          requested: requireCommandCeiling(input),
          targetGrants,
          accessCeiling: token.access_ceiling
        })
      : previousCommandCeiling;
    const persistedCommandCeiling = commandType === "ROTATE_TOKEN"
      ? persistedTokenCommandCeiling(token.access_ceiling, commandCeiling)
      : previousPersistedCommandCeiling;
    const previousExpiresAt = new Date(token.expires_at).toISOString();
    const historicalReadCeilingPreserved = false;
    return finalize(propertyId, {
      tokenId: token.id, subjectId: token.subject_id, subjectDisplayName: token.display_name, label: token.label, accessCeiling: token.access_ceiling,
      commandCeiling,
      persistedCommandCeiling,
      ...(commandType === "ROTATE_TOKEN" ? { previousCommandCeiling, previousPersistedCommandCeiling, previousExpiresAt } : {}),
      expiresAt, operation: commandType === "ROTATE_TOKEN" ? "ROTATE" : "REVOKE",
      historicalReadCeilingPreserved: commandType === "ROTATE_TOKEN" ? historicalReadCeilingPreserved : false
    }, {
      tokenRevokedAt: token.revoked_at,
      replacedById: token.replaced_by_id,
      subjectAuthVersion: token.auth_version,
      previousExpiresAt,
      previousCommandCeiling,
      previousPersistedCommandCeiling,
      persistedCommandCeiling,
      ...(commandType === "ROTATE_TOKEN" ? {
        subjectAccess: token.access_level,
        targetCommandGrants: commandGrantTypes(targetGrants),
        targetCommandGrantCatalog: commandGrantBasis(targetGrants)
      } : {}),
      ...(tokenSecretHash ? { tokenSecretHash } : {})
    });
  }

  if ((commandType as string) === "BACKFILL_COMPLETED_STAY" && !currentReleaseFeatures.stayBackfillSubmission) {
    throw new DomainError("VALIDATION_ERROR", "补录已改为创建时一次完成，请使用“补录住宿”入口", 409);
  }

  const orderId = requireString(input, "orderId");
  const context = await loadOrderContextForProperty(db, propertyId, orderId);
  if (commandType === "REVOKE_CHECK_OUT") return buildCheckoutReversalEffect(db, context);
  if (commandType === "MANAGE_ORDER_OCCUPANTS") return buildCompanionEffect(db, context, input);
  const temporaryOtherRoomEvidence = await loadTemporaryOtherRoomCreateEvidence(db, orderId);
  if (temporaryOtherRoomEvidence && temporaryOtherRoomBlockedOrderCommands.has(commandType)) {
    rejectTemporaryOtherRoomLifecycleChange();
  }
  const temporaryOtherRoomEvidenceEffect = temporaryOtherRoomEffectEvidence(temporaryOtherRoomEvidence);
  const baseBasis: Record<string, unknown> = {
    orderVersion: context.order.version,
    orderStatus: context.order.status,
    policyVersionId: context.order.pricing_policy_version_id,
    membership: await memberBasis(db, propertyId, context.order.member_contract_id, context.order.member_id),
    ...(temporaryOtherRoomEvidence ? {
      temporaryOtherRoomCreateAmendmentId: temporaryOtherRoomEvidence.createAmendmentId
    } : {})
  };

  if (commandType === "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP") {
    const existingOrderConversion = await db.selectFrom("amendments")
      .select("id")
      .where("order_id", "=", orderId)
      .where("amendment_type", "=", "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP")
      .executeTakeFirst();
    if (existingOrderConversion) {
      throw new DomainError("AGGREGATE_VERSION_CONFLICT", "该住宿订单已经升级会员，不能重复办理", 409);
    }
    const conversionStateAllowed = context.order.status === "CHECKED_OUT" && context.stay.status === "COMPLETED"
      || context.order.status === "CHECKED_IN" && context.stay.status === "IN_HOUSE";
    if (!conversionStateAllowed) {
      throw new DomainError("INVALID_ORDER_STATE", "升级会员需在入住或退房完成后办理", 409);
    }
    if (context.order.stay_type === "FREE" || context.order.member_id || context.order.member_contract_id) {
      throw new DomainError("VALIDATION_ERROR", "只有企业微信来源的普通住宿订单可以升级会员");
    }
    if (context.order.booking_channel_code && externalChannelCodes.has(context.order.booking_channel_code)) {
      throw new DomainError("VALIDATION_ERROR", "外部渠道订单不登记单笔住宿收款，不能从本订单升级会员");
    }
    if (context.order.booking_channel_code !== "WECOM") {
      throw new DomainError("VALIDATION_ERROR", "只有企业微信来源的普通住宿订单可以升级会员");
    }

    const memberId = requireString(input, "memberId");
    const membershipProductId = requireString(input, "membershipProductId");
    const rawCollectionFactIds = input.collectionFactIds;
    if (!Array.isArray(rawCollectionFactIds)
      || rawCollectionFactIds.some((value) => typeof value !== "string" || value.trim() === "")) {
      throw new DomainError("VALIDATION_ERROR", "住宿收款列表无效");
    }
    const collectionFactIds = rawCollectionFactIds.map((value) => (value as string).trim());
    if (new Set(collectionFactIds).size !== collectionFactIds.length) {
      throw new DomainError("VALIDATION_ERROR", "同一笔住宿收款不能重复选择");
    }
    const agreedPriceMinor = requirePositiveWholeYuanMinor(input, "agreedPriceMinor");
    const adjustmentReason = optionalString(input, "priceAdjustmentReason");
    const remainingPaymentNote = optionalString(input, "remainingPaymentNote") ?? "";

    const [member, memberPropertyLinks, product] = await Promise.all([
      db.selectFrom("members")
        .where("members.deleted_at", "is", null)
        .innerJoin("member_property_links", "member_property_links.member_id", "members.id")
        .select(["members.id", "members.full_name", "members.phone"])
        .where("members.id", "=", memberId)
        .where("member_property_links.property_id", "=", propertyId)
        .executeTakeFirst(),
      db.selectFrom("member_property_links")
        .select("property_id")
        .where("member_id", "=", memberId)
        .orderBy("property_id")
        .execute(),
      db.selectFrom("membership_products").selectAll()
        .where("id", "=", membershipProductId)
        .where("status", "=", "PUBLISHED")
        .executeTakeFirst()
    ]);
    if (!member) throw new DomainError("NOT_FOUND", "当前门店未找到该会员", 404);
    if (memberPropertyLinks.length !== 1 || memberPropertyLinks[0]?.property_id !== propertyId) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "当前版本仅支持单门店会员；该会员已关联其他门店，不能升级会员"
      );
    }
    if (!product) throw new DomainError("NOT_FOUND", "会员产品不存在", 404);
    if (product.currency !== context.revision.currency) throw new DomainError("VALIDATION_ERROR", "会员产品币种与住宿订单不一致");
    if (agreedPriceMinor !== product.list_price_minor && !adjustmentReason) {
      throw new DomainError("VALIDATION_ERROR", "修改会员成交价时必须填写调价原因");
    }
    if (agreedPriceMinor === product.list_price_minor && adjustmentReason) {
      throw new DomainError("VALIDATION_ERROR", "未修改会员成交价时不需要填写调价原因");
    }

    const primaryOccupant = await db.selectFrom("order_occupants")
      .selectAll()
      .where("order_id", "=", orderId)
      .where("role", "=", "PRIMARY")
      .orderBy("ordinal")
      .executeTakeFirst();
    if (!primaryOccupant) throw new DomainError("VALIDATION_ERROR", "住宿订单缺少主要住宿人，不能升级会员");
    const latestCorrection = await db.selectFrom("order_occupant_corrections")
      .selectAll()
      .where("occupant_id", "=", primaryOccupant.id)
      .orderBy("sequence", "desc")
      .executeTakeFirst();
    const primaryFullName = latestCorrection?.corrected_full_name ?? primaryOccupant.full_name;
    const primaryNickname = latestCorrection?.corrected_nickname ?? primaryOccupant.nickname;
    const primaryPhone = latestCorrection ? latestCorrection.corrected_phone : primaryOccupant.phone;
    if (!primaryPhone || primaryPhone.trim() === "") throw new DomainError("VALIDATION_ERROR", "主要住宿人缺少手机号，不能升级会员");
    const normalizedPrimaryPhone = normalizePhoneNumber(primaryPhone);
    const normalizedMemberPhone = normalizePhoneNumber(member.phone);
    if (normalizedPrimaryPhone !== normalizedMemberPhone) {
      throw new DomainError("VALIDATION_ERROR", "目标会员手机号必须与主要住宿人一致");
    }

    const businessDate = await propertyLocalToday(db, propertyId);
    const stayTimeline = await loadProjectedStayTimeline(db, context, businessDate);
    const serviceDates = stayTimeline.map((item) => item.serviceDate);
    if (serviceDates.length === 0) throw new DomainError("VALIDATION_ERROR", "住宿订单没有可核销的服务日期");
    if (serviceDates.length > product.entitlement_units) {
      throw new DomainError("ENTITLEMENT_CONFLICT", "本次住宿夜数超过所选会员产品权益数量", 409);
    }
    const timelineUnits = await Promise.all([...new Set(stayTimeline.map((item) => item.inventoryUnitId))]
      .map((unitId) => loadInventoryUnit(db, propertyId, unitId)));
    const unitMismatch = timelineUnits.some((unit) => (
      unit.kind !== product.allowed_inventory_kind
      || unit.roomTypeCode !== product.allowed_room_type_code
      || entitlementKindFor(unit.kind) !== product.entitlement_unit_kind
    ));
    if (unitMismatch) {
      throw new DomainError("ENTITLEMENT_CONFLICT", "所选会员产品不适用于本次住宿房型", 409);
    }

    const [allOrderFunds, existingTransfers] = await Promise.all([
      db.selectFrom("collection_facts")
        .select(["fact_id", "fact_type", "amount_minor", "net_effect_minor", "currency", "method", "transaction_reference", "references_fact_id", "reverses_fact_id", "command_id", "pricing_revision_id", "created_at"])
        .where("order_id", "=", orderId)
        .orderBy("created_at")
        .orderBy("fact_id")
        .execute(),
      db.selectFrom("stay_collection_membership_transfers")
        .select(["id", "source_collection_fact_id"])
        .where("order_id", "=", orderId)
        .execute()
    ]);
    const sourceCollections = allOrderFunds.filter((fact) => fact.fact_type === "COLLECTION");
    const sourceCollectionIds = new Set(sourceCollections.map((fact) => fact.fact_id));
    const refundedBySource = new Map<string, number>();
    const invalidFundGraph = existingTransfers.length > 0
      || allOrderFunds.some((fact) => fact.fact_type !== "COLLECTION" && fact.fact_type !== "REFUND")
      || sourceCollections.some((fact) => fact.amount_minor <= 0
        || fact.net_effect_minor !== fact.amount_minor
        || fact.method !== "WECOM"
        || !fact.transaction_reference
        || fact.currency !== context.revision.currency
        || fact.references_fact_id !== null
        || fact.reverses_fact_id !== null)
      || allOrderFunds.some((fact) => {
        if (fact.fact_type !== "REFUND") return false;
        if (fact.amount_minor <= 0
          || fact.net_effect_minor !== -fact.amount_minor
          || fact.method !== "WECOM"
          || fact.transaction_reference !== null
          || fact.currency !== context.revision.currency
          || !fact.references_fact_id
          || fact.reverses_fact_id !== null
          || !sourceCollectionIds.has(fact.references_fact_id)) {
          return true;
        }
        refundedBySource.set(
          fact.references_fact_id,
          (refundedBySource.get(fact.references_fact_id) ?? 0) + fact.amount_minor
        );
        return false;
      });
    if (invalidFundGraph || sourceCollections.some((fact) => (refundedBySource.get(fact.fact_id) ?? 0) > fact.amount_minor)) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "住宿资金记录包含非企微、冲销或无法核对的收退款事实，不能直接升级会员；请先核对住宿收退款记录"
      );
    }
    const orderedCollections = sourceCollections.flatMap((fact) => {
      const residualMinor = fact.amount_minor - (refundedBySource.get(fact.fact_id) ?? 0);
      return residualMinor > 0 ? [{ ...fact, residualMinor }] : [];
    });
    const expectedCollectionIds = new Set(orderedCollections.map((fact) => fact.fact_id));
    if (collectionFactIds.length !== expectedCollectionIds.size
      || collectionFactIds.some((factId) => !expectedCollectionIds.has(factId))) {
      throw new DomainError("VALIDATION_ERROR", expectedCollectionIds.size === 0
        ? "本订单当前没有可转入的企微住宿净收款，请不要选择已全额退款的收款"
        : "升级会员必须一次转入全部当前可留存的企微住宿净收款");
    }
    const transferTotalMinor = orderedCollections.reduce((sum, fact) => sum + fact.residualMinor, 0);
    if (!Number.isSafeInteger(transferTotalMinor) || transferTotalMinor < 0) {
      throw new DomainError("VALIDATION_ERROR", "转入住宿收款合计无效");
    }
    const oldAmountSummary = await orderAmountSummary(db, context);
    if (oldAmountSummary.netRecordedCollection.minorUnits !== transferTotalMinor) {
      throw new DomainError("VALIDATION_ERROR", "升级会员必须一次转入当前全部企微住宿净收款；请先核对住宿收退款记录");
    }
    if (agreedPriceMinor < transferTotalMinor) {
      throw new DomainError("VALIDATION_ERROR", "会员成交价不能低于本次用于升级的住宿收款合计");
    }
    const remainingMinor = agreedPriceMinor - transferTotalMinor;
    const remainingPaymentTransactionReference = optionalString(input, "remainingPaymentTransactionReference");
    if (remainingMinor > 0 && !remainingPaymentTransactionReference) {
      throw new DomainError("VALIDATION_ERROR", "会员成交价高于转入住宿收款时，必须填写差额企业微信交易单号");
    }
    if (remainingMinor === 0 && remainingPaymentTransactionReference) {
      throw new DomainError("VALIDATION_ERROR", "没有差额收款时不需要填写差额企业微信交易单号");
    }
    const allOrderCollectionTransactionReferences = new Set(allOrderFunds
      .filter((fact) => fact.fact_type === "COLLECTION")
      .map((fact) => fact.transaction_reference)
      .filter((value): value is string => Boolean(value)));
    if (remainingPaymentTransactionReference
      && allOrderCollectionTransactionReferences.has(remainingPaymentTransactionReference)) {
      throw new DomainError("VALIDATION_ERROR", "差额企业微信交易单号必须是新收款单号，不能沿用原住宿收款交易单号");
    }
    const remainingPayment = remainingMinor > 0 ? {
      amount: money(context.revision.currency, remainingMinor),
      transactionReference: requireTransactionReference(remainingPaymentTransactionReference),
      note: remainingPaymentNote
    } : null;
    const validFrom = businessDate;
    const validUntil = addOneCalendarYear(validFrom);
    const entitlementUnits = product.entitlement_units;
    const remainingUnits = entitlementUnits - serviceDates.length;
    return finalize(propertyId, {
      operation: "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP",
      orderId,
      stayId: context.stay.id,
      primaryOccupant: {
        fullName: primaryFullName,
        nickname: primaryNickname,
        phone: normalizedPrimaryPhone
      },
      member: {
        memberId: member.id,
        fullName: member.full_name,
        phone: normalizedMemberPhone
      },
      product: {
        productId: product.id,
        code: product.code,
        version: product.version,
        name: product.name,
        entitlementUnitKind: product.entitlement_unit_kind,
        entitlementUnits,
        allowedRoomTypeCode: product.allowed_room_type_code,
        allowedInventoryKind: product.allowed_inventory_kind
      },
      transfer: {
        collections: orderedCollections.map((fact) => ({
          factId: fact.fact_id,
          amount: money(fact.currency, fact.residualMinor),
          transactionReference: requireTransactionReference(fact.transaction_reference),
          recordedAt: fact.created_at instanceof Date ? fact.created_at.toISOString() : new Date(fact.created_at).toISOString()
        })),
        total: money(context.revision.currency, transferTotalMinor)
      },
      membershipPricing: {
        listedPrice: money(product.currency, product.list_price_minor),
        agreedPrice: money(product.currency, agreedPriceMinor),
        adjustment: money(product.currency, agreedPriceMinor - product.list_price_minor),
        adjustmentReason: adjustmentReason ?? null
      },
      remainingPayment,
      entitlement: {
        entitlementUnitKind: product.entitlement_unit_kind,
        entitlementUnits,
        consumedUnits: serviceDates.length,
        remainingUnits,
        serviceDates,
        validFrom,
        validUntil
      },
      before: {
        currentContractAmount: oldAmountSummary.currentContractAmount,
        netRecordedCollection: oldAmountSummary.netRecordedCollection
      },
      pricingDecision: {
        pricingBasis: "MEMBER_ENTITLEMENT",
        policyBaseAmount: money(context.revision.currency, 0),
        targetCurrentContractAmount: money(context.revision.currency, 0),
        differenceFromPolicy: money(context.revision.currency, 0),
        manualAdjustmentMinor: 0,
        differenceExceedsThreshold: false,
        reason: {
          code: "STAY_COLLECTION_TO_MEMBERSHIP",
          note: "升级会员，住宿金额归零"
        }
      },
      pricing: {
        coverageSet: [],
        cashLines: [],
        cashRemainder: money(context.revision.currency, 0),
        currentContractAmount: money(context.revision.currency, 0)
      }
    }, {
      ...baseBasis,
      businessDate,
      member: { id: member.id, phone: normalizedMemberPhone },
      product: { id: product.id, version: product.version, status: product.status },
      stayTimeline,
      allOrderFunds: allOrderFunds.map((fact) => ({
        factId: fact.fact_id,
        factType: fact.fact_type,
        amountMinor: fact.amount_minor,
        netEffectMinor: fact.net_effect_minor,
        method: fact.method,
        transactionReference: fact.transaction_reference,
        referencesFactId: fact.references_fact_id,
        reversesFactId: fact.reverses_fact_id,
        commandId: fact.command_id,
        pricingRevisionId: fact.pricing_revision_id
      })),
      collectionFacts: orderedCollections.map((fact) => ({
        factId: fact.fact_id,
        amountMinor: fact.amount_minor,
        transferAmountMinor: fact.residualMinor,
        method: fact.method,
        transactionReference: fact.transaction_reference,
        commandId: fact.command_id,
        pricingRevisionId: fact.pricing_revision_id,
        activeRefunded: refundedBySource.get(fact.fact_id) ?? 0,
        reversed: false,
        transferred: false
      })),
      existingOrderConversion: null,
      membership: await memberBasis(db, propertyId, null, member.id)
    });
  }

  if (commandType === "CORRECT_ORDER_OCCUPANT") {
    const occupantId = requireString(input, "occupantId");
    const occupant = await db.selectFrom("active_order_occupants")
      .selectAll()
      .where("id", "=", occupantId)
      .where("order_id", "=", orderId)
      .executeTakeFirst();
    if (!occupant) throw new DomainError("NOT_FOUND", "Order occupant not found", 404);
    const latest = await db.selectFrom("order_occupant_corrections")
      .selectAll()
      .where("occupant_id", "=", occupantId)
      .orderBy("sequence", "desc")
      .executeTakeFirst();
    const before = latest ? {
      fullName: latest.corrected_full_name,
      nickname: latest.corrected_nickname,
      phone: latest.corrected_phone,
      documentNumber: latest.corrected_document_number
    } : {
      fullName: occupant.full_name,
      nickname: occupant.nickname,
      phone: occupant.phone,
      documentNumber: occupant.document_number
    };
    const expectedInput = requireObject(input.expectedPriorSnapshot, "expectedPriorSnapshot");
    const expectedNullableField = (field: "fullName" | "nickname" | "phone" | "documentNumber", maximum: number): string | null => {
      if (!Object.hasOwn(expectedInput, field)) throw new DomainError("VALIDATION_ERROR", `expectedPriorSnapshot.${field} is required`);
      if (expectedInput[field] === null) return null;
      const value = requireString(expectedInput, field);
      if (value.length > maximum) throw new DomainError("VALIDATION_ERROR", `expectedPriorSnapshot.${field} is too long`);
      return value;
    };
    const expectedPriorSnapshot = {
      fullName: expectedNullableField("fullName", 200),
      nickname: expectedNullableField("nickname", 200),
      phone: expectedNullableField("phone", 80),
      documentNumber: expectedNullableField("documentNumber", 120)
    };
    if (stableHash(expectedPriorSnapshot) !== stableHash(before)) {
      throw new DomainError("AGGREGATE_VERSION_CONFLICT", "Order occupant details changed; reload before correcting", 409);
    }
    const submitted = requireObject(input.correctedSnapshot, "correctedSnapshot");
    const nullableField = (field: "phone" | "documentNumber", maximum: number): string | null => {
      if (!Object.hasOwn(submitted, field)) throw new DomainError("VALIDATION_ERROR", `correctedSnapshot.${field} is required`);
      if (submitted[field] === null) return null;
      const value = requireString(submitted, field);
      if (value.length > maximum) throw new DomainError("VALIDATION_ERROR", `correctedSnapshot.${field} is too long`);
      return value;
    };
    const after = {
      fullName: requireString(submitted, "fullName"),
      nickname: requireString(submitted, "nickname"),
      phone: nullableField("phone", 80),
      documentNumber: nullableField("documentNumber", 120)
    };
    if (after.fullName.length > 200 || after.nickname.length > 200) {
      throw new DomainError("VALIDATION_ERROR", "Corrected occupant name is too long");
    }
    if (stableHash(before) === stableHash(after)) {
      throw new DomainError("VALIDATION_ERROR", "Corrected occupant snapshot must change at least one field");
    }
    return finalize(propertyId, {
      operation: "CORRECT_ORDER_OCCUPANT",
      orderId,
      occupantId,
      ordinal: occupant.ordinal,
      role: occupant.role,
      before,
      after,
      ...temporaryOtherRoomEvidenceEffect
    }, {
      ...baseBasis,
      latestCorrectionId: latest?.id ?? null,
      correctionSequence: (latest?.sequence ?? 0) + 1,
      occupantSnapshot: before
    });
  }

  if (commandType === "SHORTEN_STAY") {
    if (context.order.status !== "CHECKED_IN") {
      throw new DomainError(
        "INVALID_ORDER_STATE",
        context.order.status === "RESERVED"
          ? "未入住订单请使用调整住宿日期"
          : "只有在住订单可以缩短住宿",
        409
      );
    }
    const businessDate = await propertyLocalToday(db, propertyId);
    const currentTimeline = await loadActiveStayTimeline(db, context);
    await assertStayDateChangeLifecycle(db, context, businessDate, currentTimeline);
    if (context.order.arrival_date >= businessDate) {
      throw new DomainError(
        "INVALID_ORDER_STATE",
        "入住当天暂不办理缩短或提前退房；未实际使用房间时请使用后续的撤销入住流程",
        409
      );
    }
    if (businessDate >= context.order.departure_date) {
      throw new DomainError(
        "INVALID_ORDER_STATE",
        businessDate === context.order.departure_date
          ? "已到计划退房日，请使用普通退房"
          : "已超过计划退房日，请使用迟录退房",
        409
      );
    }
    const newDepartureDate = requireString(input, "newDepartureDate");
    parseLocalDate(newDepartureDate);
    if (newDepartureDate >= context.order.departure_date) {
      throw new DomainError("VALIDATION_ERROR", "新的退房日期必须早于原计划退房日期");
    }
    if (newDepartureDate < businessDate) {
      throw new DomainError("VALIDATION_ERROR", "新的退房日期不能早于当前营业日期");
    }
    if (newDepartureDate <= context.order.arrival_date) {
      throw new DomainError("VALIDATION_ERROR", "退房日期必须晚于入住日期");
    }
    if (temporaryOtherRoomEvidence) {
      assertNoTemporaryOtherRoomStayPricingInputs(input);
    }
    const completionMode = newDepartureDate === businessDate ? "EARLY_CHECK_OUT" : "SHORTEN_IN_HOUSE";
    const oldDates = currentTimeline.map((item) => item.serviceDate);
    const newDates = enumerateServiceDates(context.order.arrival_date, newDepartureDate);
    const inventoryChange = dateDiff(oldDates, newDates);
    const stayTimeline = currentTimeline.filter((item) => item.serviceDate < newDepartureDate);
    if (stayTimeline.length !== newDates.length
      || stayTimeline.some((item, index) => item.serviceDate !== newDates[index])) {
      throw new DomainError("INTERNAL_ERROR", "缩短后的住宿时间线不连续", 500);
    }
    const inventoryUnitId = stayTimeline.at(-1)!.inventoryUnitId;
    const [activeCoverage, activeCoverageRows, membershipConversion] = await Promise.all([
      activeCoverageCandidates(db, orderId),
      db.selectFrom("coverage_items")
        .select(["service_date", "status", "contract_id", "lot_id", "unit_kind"])
        .where("order_id", "=", orderId)
        .where("status", "in", ["HELD", "CONSUMED"])
        .orderBy("service_date")
        .execute(),
      loadOrderMembershipConversion(db, context)
    ]);
    if (activeCoverage.some((item) => item.status === "HELD")) {
      throw new DomainError("ENTITLEMENT_CONFLICT", "在住订单仍有未核销的原住宿权益，当前数据状态异常，不能缩短住宿", 409);
    }
    if (membershipConversion) {
      if (!isExactConvertedCoverageGraph(activeCoverageRows, oldDates, membershipConversion)) {
        throw new DomainError("ENTITLEMENT_CONFLICT", "升级会员后的已核销权益与当前住宿日期不一致，不能缩短住宿", 409);
      }
    }
    const timelineByDate = new Map(currentTimeline.map((item) => [item.serviceDate, item.inventoryUnitId]));
    const latestShortening = await db.selectFrom("amendments as shortening")
      .select("shortening.payload")
      .where("shortening.order_id", "=", orderId)
      .where("shortening.amendment_type", "=", "SHORTEN_STAY")
      .where(sql<boolean>`not exists (
        select 1 from amendments as checkout join amendments as reversal
          on reversal.payload ->> 'checkoutAmendmentId' = checkout.id
          and reversal.amendment_type = 'REVOKE_CHECK_OUT'
        where checkout.command_id = shortening.command_id and checkout.amendment_type = 'CHECK_OUT'
          and checkout.sequence = shortening.sequence + 1
      )`)
      .orderBy("shortening.sequence", "desc")
      .executeTakeFirst();
    const previousEntitlementSummary = latestShortening?.payload
      && typeof latestShortening.payload === "object"
      && !Array.isArray(latestShortening.payload)
      && "entitlementSummary" in latestShortening.payload
      && latestShortening.payload.entitlementSummary
      && typeof latestShortening.payload.entitlementSummary === "object"
      && !Array.isArray(latestShortening.payload.entitlementSummary)
      ? latestShortening.payload.entitlementSummary as Record<string, unknown>
      : undefined;
    const previousCurrentDates = previousEntitlementSummary?.currentConsumedCoverageDates;
    const previousHistoricalDates = previousEntitlementSummary?.retainedHistoricalConsumedCoverageDates;
    const previousCoverageDates = Array.isArray(previousCurrentDates) && Array.isArray(previousHistoricalDates)
      && [...previousCurrentDates, ...previousHistoricalDates].every((date) => typeof date === "string")
      ? [...previousCurrentDates, ...previousHistoricalDates] as string[]
      : undefined;
    const activeCoverageDates = activeCoverage.map((coverage) => coverage.serviceDate);
    if (latestShortening && (!previousCoverageDates
      || new Set(previousCoverageDates).size !== previousCoverageDates.length
      || previousCoverageDates.length !== activeCoverageDates.length
      || previousCoverageDates.some((date) => !activeCoverageDates.includes(date)))) {
      throw new DomainError("ENTITLEMENT_CONFLICT", "历史缩短记录与已核销会员权益不一致，不能再次缩短住宿", 409);
    }
    const allowedHistoricalDates = new Set(Array.isArray(previousHistoricalDates) ? previousHistoricalDates as string[] : []);
    const coverageUnitIds = activeCoverage.flatMap((coverage) => coverage.inventoryUnitId ? [coverage.inventoryUnitId] : []);
    const unitsById = new Map((await Promise.all(
      [...new Set([...currentTimeline.map((item) => item.inventoryUnitId), ...coverageUnitIds])]
        .map((unitId) => loadInventoryUnit(db, propertyId, unitId))
    )).map((unit) => [unit.id, unit]));
    for (const coverage of activeCoverage) {
      const timelineUnitId = timelineByDate.get(coverage.serviceDate);
      if (coverage.status !== "CONSUMED"
        || !coverage.inventoryUnitId
        || coverage.unitKind !== entitlementKindFor(unitsById.get(coverage.inventoryUnitId)!.kind)
        || (timelineUnitId
          ? coverage.unitKind !== entitlementKindFor(unitsById.get(timelineUnitId)!.kind)
          : !allowedHistoricalDates.has(coverage.serviceDate))) {
        throw new DomainError("ENTITLEMENT_CONFLICT", "已核销会员权益与当前住宿安排不一致，不能缩短住宿", 409);
      }
    }
    const policyPricing = await priceStayTimeline(db, {
      propertyId,
      orderId,
      memberId: context.order.member_id,
      memberContractId: context.order.member_contract_id,
      arrivalDate: context.order.arrival_date,
      departureDate: newDepartureDate,
      stayType: context.order.stay_type as StayType,
      policyVersionId: context.order.pricing_policy_version_id,
      timeline: stayTimeline,
      manualAdjustmentMinor: 0,
      preservedCoverageOnly: true
    });
    if (temporaryOtherRoomEvidence
      && (policyPricing.coverageSet.length !== newDates.length
        || policyPricing.cashLines.length !== 0
        || policyPricing.cashRemainder.minorUnits !== 0
        || policyPricing.currentContractAmount.minorUnits !== 0)) {
      throw new DomainError("ENTITLEMENT_CONFLICT", "临时安排缩短后必须保留原整房权益完整零元覆盖", 409);
    }
    const decision = stayChangePricingDecision({
      commandType,
      bookingChannelCode: context.order.booking_channel_code,
      stayType: context.order.stay_type,
      memberStay: Boolean(context.order.member_id || context.order.member_contract_id),
      policyBaseAmountMinor: policyPricing.currentContractAmount.minorUnits,
      targetCurrentContractAmountMinor: input.targetCurrentContractAmountMinor,
      channelPriceDifferenceReason: input.channelPriceDifferenceReason,
      manualPriceAdjustmentReason: input.manualPriceAdjustmentReason
    });
    const pricing: PricingResult = {
      ...policyPricing,
      currentContractAmount: money(policyPricing.currentContractAmount.currency, decision.currentContractAmountMinor)
    };
    const oldAmountSummary = await orderAmountSummary(db, context);
    const restoredFutureCoverageDates = temporaryOtherRoomEvidence
      ? []
      : membershipConversion
      ? activeCoverage
        .filter((item) => !newDates.includes(item.serviceDate) && item.serviceDate >= businessDate)
        .map((item) => item.serviceDate)
      : [];
    if (membershipConversion && (restoredFutureCoverageDates.length !== inventoryChange.releasedDates.length
      || restoredFutureCoverageDates.some((date, index) => date !== inventoryChange.releasedDates[index]))) {
      throw new DomainError("ENTITLEMENT_CONFLICT", "升级会员后的未来权益与缩短日期不一致，不能安全返还", 409);
    }
    const restoredFutureCoverageDateSet = new Set(restoredFutureCoverageDates);
    const currentConsumedCoverageDates = activeCoverage
      .filter((item) => newDates.includes(item.serviceDate))
      .map((item) => item.serviceDate);
    const retainedHistoricalConsumedCoverageDates = activeCoverage
      .filter((item) => !newDates.includes(item.serviceDate) && !restoredFutureCoverageDateSet.has(item.serviceDate))
      .map((item) => item.serviceDate);
    const collectionFacts = await db.selectFrom("collection_facts")
      .select([
        "fact_id", "fact_type", "amount_minor", "net_effect_minor", "currency",
        "references_fact_id", "reverses_fact_id", "pricing_revision_id", "command_id", "created_at"
      ])
      .where("order_id", "=", orderId)
      .orderBy("created_at")
      .orderBy("fact_id")
      .execute();
    const netRecordedCollectionMinor = oldAmountSummary.netRecordedCollection.minorUnits;
    const revisedAmountSummary = amountSummary(
      pricing.currentContractAmount.currency,
      pricing.currentContractAmount.minorUnits,
      [netRecordedCollectionMinor]
    );
    const fundsSummary = {
      netRecordedCollection: oldAmountSummary.netRecordedCollection,
      collectionDifference: revisedAmountSummary.collectionDifference,
      factCount: collectionFacts.length
    };
    const refundReferenceAmount = revisedAmountSummary.refundReferenceAmount;
    return finalize(propertyId, {
      operation: commandType,
      orderId,
      stayId: context.stay.id,
      inventoryUnitId,
      businessDate,
      completionMode,
      before: {
        arrivalDate: context.order.arrival_date,
        departureDate: context.order.departure_date,
        nights: oldDates.length,
        currentContractAmount: oldAmountSummary.currentContractAmount,
        stayTimeline: currentTimeline
      },
      after: {
        arrivalDate: context.order.arrival_date,
        departureDate: newDepartureDate,
        nights: newDates.length,
        stayTimeline,
        pricing
      },
      pricingDecision: pricingDecisionEffect(pricing.currentContractAmount.currency, decision),
      inventoryChange,
      entitlementSummary: {
        currentConsumedCoverageDates,
        retainedHistoricalConsumedCoverageDates,
        restoredFutureCoverageDates,
        ledgerWriteCount: restoredFutureCoverageDates.length
      },
      fundsSummary,
      refundReferenceAmount,
      ...temporaryOtherRoomEvidenceEffect
    }, {
      ...baseBasis,
      businessDate,
      stayTimeline: currentTimeline,
      activeCoverage,
      collectionFacts
    });
  }

  if (commandType === "RESCHEDULE_STAY" || commandType === "EXTEND_STAY") {
    const reschedule = commandType === "RESCHEDULE_STAY";
    if (reschedule && context.order.status !== "RESERVED") {
      throw new DomainError("INVALID_ORDER_STATE", "只有未入住订单可以调整住宿日期", 409);
    }
    if (!reschedule && context.order.status !== "CHECKED_IN") {
      throw new DomainError("INVALID_ORDER_STATE", "只有在住订单可以延长住宿", 409);
    }

    const businessDate = await propertyLocalToday(db, propertyId);
    const currentTimeline = await loadActiveStayTimeline(db, context);
    await assertStayDateChangeLifecycle(db, context, businessDate, currentTimeline);
    const newArrivalDate = reschedule ? requireString(input, "newArrivalDate") : context.order.arrival_date;
    const newDepartureDate = requireString(input, "newDepartureDate");
    const newDates = enumerateServiceDates(newArrivalDate, newDepartureDate);
    if (reschedule) {
      if (newArrivalDate < businessDate) {
        throw new DomainError("VALIDATION_ERROR", "新的入住日期不能早于当前营业日期");
      }
      if (newArrivalDate === context.order.arrival_date && newDepartureDate === context.order.departure_date) {
        throw new DomainError("VALIDATION_ERROR", "调整后的入住和退房日期必须发生变化");
      }
      if (temporaryOtherRoomEvidence) {
        if (context.stay.status !== "PLANNED") {
          throw new DomainError("INVALID_ORDER_STATE", "只有未入住订单可以调整临时安排日期", 409);
        }
        assertNoTemporaryOtherRoomStayPricingInputs(input);
      }
    } else {
      if (newDepartureDate <= context.order.departure_date) {
        throw new DomainError("VALIDATION_ERROR", "新的退房日期必须晚于原计划退房日期");
      }
      if (businessDate > context.order.departure_date && newDepartureDate <= businessDate) {
        throw new DomainError("VALIDATION_ERROR", "逾期续住后的退房日期必须晚于当前营业日期");
      }
    }

    const oldDates = currentTimeline.map((item) => item.serviceDate);
    const stayTimeline = planStayDateChangeTimeline({
      currentTimeline,
      oldArrivalDate: context.order.arrival_date,
      oldDepartureDate: context.order.departure_date,
      newArrivalDate,
      newDepartureDate
    });
    const pairDiff = timelinePairDiff(currentTimeline, stayTimeline);
    const inventoryChange = {
      preservedDates: pairDiff.preserved.map((item) => item.serviceDate),
      releasedDates: pairDiff.released.map((item) => item.serviceDate),
      addedDates: pairDiff.added.map((item) => item.serviceDate)
    };
    if (reschedule && temporaryOtherRoomEvidence) {
      assertTemporaryOtherRoomReservedSubset({
        oldDates,
        newDates,
        inventoryChange
      });
    }
    const inventoryUnitId = stayTimeline.at(-1)!.inventoryUnitId;
    const fingerprintParts = await Promise.all(pairDiff.added.map(async (item) => ({
      item,
      fingerprint: await inventoryFingerprint(
        db,
        propertyId,
        item.inventoryUnitId,
        item.serviceDate,
        nextServiceDate(item.serviceDate),
        context.segmentIds
      )
    })));
    const fingerprint = fingerprintParts.flatMap(({ item, fingerprint: entries }) =>
      entries.map((entry) => `${item.serviceDate}:${item.inventoryUnitId}:${entry}`)
    );
    if (fingerprint.length > 0) {
      throw new DomainError("INVENTORY_CONFLICT", reschedule ? "调整后的住宿日期存在库存冲突" : "延长日期的库存不可用", 409);
    }

    const [activeCoverage, activeCoverageRows, membershipConversion] = await Promise.all([
      activeCoverageCandidates(db, orderId),
      db.selectFrom("coverage_items")
        .select(["service_date", "inventory_unit_id", "contract_id", "lot_id", "unit_kind", "status"])
        .where("order_id", "=", orderId)
        .where("status", "in", ["HELD", "CONSUMED"])
        .orderBy("service_date")
        .execute(),
      !reschedule ? loadOrderMembershipConversion(db, context) : Promise.resolve(null)
    ]);
    if (reschedule && activeCoverage.some((item) => item.status === "CONSUMED")) {
      throw new DomainError("ENTITLEMENT_CONFLICT", "未入住订单存在已核销会员权益，当前数据状态异常，不能调整住宿日期", 409);
    }
    if (!reschedule && activeCoverage.some((item) => item.status === "HELD")) {
      throw new DomainError("ENTITLEMENT_CONFLICT", "在住订单仍有未核销的原住宿权益，当前数据状态异常，不能延长住宿", 409);
    }
    if (membershipConversion && (activeCoverageRows.length !== oldDates.length
      || activeCoverageRows.some((item, index) => item.service_date !== oldDates[index]
        || item.status !== "CONSUMED"
        || item.contract_id !== membershipConversion.contractId
        || item.lot_id !== membershipConversion.entitlementLotId
        || item.unit_kind !== membershipConversion.entitlementUnitKind))) {
      throw new DomainError("ENTITLEMENT_CONFLICT", "升级会员后的已核销权益与当前住宿日期不一致，不能延长住宿", 409);
    }
    const afterUnitByDate = new Map(stayTimeline.map((item) => [item.serviceDate, item.inventoryUnitId]));
    const reallocatableHeld = reschedule
      ? activeCoverage.filter((item) => {
        if (item.status !== "HELD") return false;
        const active = activeCoverageRows.find((row) => row.service_date === item.serviceDate && row.status === "HELD");
        return !active || afterUnitByDate.get(item.serviceDate) !== active.inventory_unit_id;
      })
      : [];
    const policyPricing = temporaryOtherRoomEvidence
      ? temporaryOtherRoomSubsetPricing({
        evidence: temporaryOtherRoomEvidence,
        coverageRows: activeCoverageRows,
        currentTimeline,
        newDates,
        currency: context.revision.currency
      })
      : await priceStayTimeline(db, {
        propertyId,
        orderId,
        memberId: context.order.member_id,
        memberContractId: context.order.member_contract_id,
        arrivalDate: newArrivalDate,
        departureDate: newDepartureDate,
        stayType: context.order.stay_type as StayType,
        policyVersionId: context.order.pricing_policy_version_id,
        timeline: stayTimeline,
        manualAdjustmentMinor: 0,
        coverageAllocationDates: reschedule ? newDates : pairDiff.added.map((item) => item.serviceDate),
        reallocatableHeld
      });
    if (membershipConversion) {
      const coverageByDate = new Map(policyPricing.coverageSet.map((item) => [item.serviceDate, item]));
      if (policyPricing.coverageSet.length !== newDates.length
        || coverageByDate.size !== newDates.length
        || newDates.some((date) => {
          const coverageItem = coverageByDate.get(date);
          return !coverageItem
            || coverageItem.entitlementLotId !== membershipConversion.entitlementLotId
            || coverageItem.unitKind !== membershipConversion.entitlementUnitKind;
        })
        || policyPricing.cashRemainder.minorUnits !== 0
        || policyPricing.currentContractAmount.minorUnits !== 0) {
        throw new DomainError("ENTITLEMENT_CONFLICT", "会员权益余额不足，不能延长住宿；请先补充会员权益或另建普通住宿订单", 409);
      }
    }
    const decision = stayChangePricingDecision({
      commandType,
      bookingChannelCode: context.order.booking_channel_code,
      stayType: context.order.stay_type,
      memberStay: Boolean(context.order.member_id || context.order.member_contract_id),
      policyBaseAmountMinor: policyPricing.currentContractAmount.minorUnits,
      targetCurrentContractAmountMinor: input.targetCurrentContractAmountMinor,
      channelPriceDifferenceReason: input.channelPriceDifferenceReason,
      manualPriceAdjustmentReason: input.manualPriceAdjustmentReason
    });
    const pricing: PricingResult = {
      ...policyPricing,
      currentContractAmount: money(policyPricing.currentContractAmount.currency, decision.currentContractAmountMinor)
    };
    const oldAmountSummary = await orderAmountSummary(db, context);
    const desiredCoverageKeys = new Set(pricing.coverageSet.map((item) => `${item.serviceDate}\u0000${item.inventoryUnitId}`));
    const activeCoverageKeys = new Set(activeCoverageRows.map((item) => `${item.service_date}\u0000${item.inventory_unit_id}`));
    const preservedCoverageDates = activeCoverageRows
      .filter((item) => desiredCoverageKeys.has(`${item.service_date}\u0000${item.inventory_unit_id}`))
      .map((item) => item.service_date);
    const releasedCoverageDates = activeCoverageRows
      .filter((item) => !desiredCoverageKeys.has(`${item.service_date}\u0000${item.inventory_unit_id}`))
      .map((item) => item.service_date);
    const addedCoverageDates = pricing.coverageSet
      .filter((item) => !activeCoverageKeys.has(`${item.serviceDate}\u0000${item.inventoryUnitId}`))
      .map((item) => item.serviceDate);
    const entitlementChange = {
      preservedCoverageDates,
      releasedCoverageDates,
      addedCoverageDates,
      consumedCoverageDates: reschedule ? [] : addedCoverageDates
    };
    const fundsSummary = {
      netRecordedCollection: oldAmountSummary.netRecordedCollection,
      collectionDifference: money(
        pricing.currentContractAmount.currency,
        pricing.currentContractAmount.minorUnits - oldAmountSummary.netRecordedCollection.minorUnits
      )
    };
    const effectDecision = pricingDecisionEffect(pricing.currentContractAmount.currency, decision);
    return finalize(propertyId, {
      operation: commandType,
      orderId,
      stayId: context.stay.id,
      inventoryUnitId,
      before: {
        arrivalDate: context.order.arrival_date,
        departureDate: context.order.departure_date,
        nights: oldDates.length,
        stayTimeline: currentTimeline,
        currentContractAmount: oldAmountSummary.currentContractAmount
      },
      after: {
        arrivalDate: newArrivalDate,
        departureDate: newDepartureDate,
        nights: newDates.length,
        stayTimeline,
        pricing
      },
      pricingDecision: effectDecision,
      inventoryChange,
      entitlementChange,
      fundsSummary,
      ...temporaryOtherRoomEvidenceEffect
    }, {
      ...baseBasis,
      businessDate,
      stayTimeline: currentTimeline,
      inventory: fingerprint,
      activeCoverage,
      membershipConversion
    });
  }

  if (commandType === "MOVE_UNIT") {
    const newInventoryUnitId = requireString(input, "newInventoryUnitId");
    const effectiveDate = requireString(input, "effectiveDate");
    parseLocalDate(effectiveDate);
    if (context.order.status !== "RESERVED" && context.order.status !== "CHECKED_IN") {
      throw new DomainError("INVALID_ORDER_STATE", "只有已预订或在住订单可以换房", 409);
    }
    const businessDate = await propertyLocalToday(db, propertyId);
    const currentTimeline = await loadActiveStayTimeline(db, context);
    await assertStayDateChangeLifecycle(db, context, businessDate, currentTimeline);
    if (context.order.status === "RESERVED" && businessDate > context.order.arrival_date) {
      throw new DomainError("INVALID_ORDER_STATE", "逾期未到订单暂不能换房，请先处理到店日期", 409);
    }
    if (context.order.status === "CHECKED_IN" && businessDate >= context.order.departure_date) {
      throw new DomainError("INVALID_ORDER_STATE", "已到或超过计划退房日，请先办理续住或退房", 409);
    }
    if (effectiveDate < context.order.arrival_date || effectiveDate >= context.order.departure_date) throw new DomainError("VALIDATION_ERROR", "effectiveDate must be within the stay");
    if (context.order.status === "CHECKED_IN" && effectiveDate < businessDate) {
      throw new DomainError("VALIDATION_ERROR", "换房生效日期不能早于当前营业日期");
    }
    const effectiveUnitId = currentTimeline.find((item) => item.serviceDate === effectiveDate)!.inventoryUnitId;
    const currentUnit = await loadInventoryUnit(db, propertyId, effectiveUnitId);
    const newUnit = await loadInventoryUnit(db, propertyId, newInventoryUnitId);
    const stayTimeline = currentTimeline.map((item) => item.serviceDate < effectiveDate ? item : { ...item, inventoryUnitId: newUnit.id });
    if (stayTimeline.every((item, index) => item.inventoryUnitId === currentTimeline[index]?.inventoryUnitId)) {
      throw new DomainError("VALIDATION_ERROR", "换房后的住宿安排必须发生变化");
    }
    const occupantCountRow = await db.selectFrom("active_order_occupants")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("order_id", "=", orderId)
      .executeTakeFirstOrThrow();
    const occupantCount = Number(occupantCountRow.count);
    if (!Number.isSafeInteger(occupantCount) || occupantCount < 1) {
      throw new DomainError("INTERNAL_ERROR", "Order has no valid frozen occupant list", 500);
    }
    if (occupantCount > newUnit.occupancyCapacity) {
      throw new DomainError(
        "VALIDATION_ERROR",
        `${newUnit.code} 最多登记 ${newUnit.occupancyCapacity} 位住宿人，当前订单有 ${occupantCount} 位`
      );
    }
    if (context.order.member_id || context.order.member_contract_id) {
      const currentUnits = await Promise.all([...new Set(currentTimeline.map((item) => item.inventoryUnitId))]
        .map((unitId) => loadInventoryUnit(db, propertyId, unitId)));
      if (currentUnits.some((unit) => unit.kind !== newUnit.kind || unit.roomTypeCode !== newUnit.roomTypeCode)) {
        throw new DomainError("ENTITLEMENT_CONFLICT", "会员住宿只能更换到同一会员产品适用的房型", 409);
      }
    }
    const [activeCoverage, membershipConversion] = await Promise.all([
      activeCoverageCandidates(db, orderId),
      loadOrderMembershipConversion(db, context)
    ]);
    if (context.order.status === "RESERVED" && activeCoverage.some((item) => item.status === "CONSUMED")) {
      throw new DomainError("ENTITLEMENT_CONFLICT", "未入住订单存在已核销会员权益，当前数据状态异常，不能换房", 409);
    }
    if (context.order.status === "CHECKED_IN" && activeCoverage.some((item) => item.status === "HELD")) {
      throw new DomainError("ENTITLEMENT_CONFLICT", "在住订单仍有未核销的原住宿权益，当前数据状态异常，不能换房", 409);
    }
    if (membershipConversion && (context.order.status !== "CHECKED_IN"
      || newUnit.kind !== membershipConversion.allowedInventoryKind
      || newUnit.roomTypeCode !== membershipConversion.allowedRoomTypeCode)) {
      throw new DomainError("ENTITLEMENT_CONFLICT", "升级会员后的住宿只能更换到会员产品适用的房型", 409);
    }
    const fingerprint = await inventoryFingerprint(db, propertyId, newUnit.id, effectiveDate, context.order.departure_date, context.segmentIds);
    if (fingerprint.length > 0) {
      throw new DomainError("INVENTORY_CONFLICT", "目标房源在所选换房日期内已有占用，请选择其他房源。", 409);
    }
    const policyPricing = await priceStayTimeline(db, {
      propertyId, orderId, memberId: context.order.member_id, memberContractId: context.order.member_contract_id,
      arrivalDate: context.order.arrival_date, departureDate: context.order.departure_date,
      stayType: context.order.stay_type as StayType, policyVersionId: context.order.pricing_policy_version_id,
      timeline: stayTimeline, manualAdjustmentMinor: 0
    });
    const decision = stayChangePricingDecision({
      commandType,
      bookingChannelCode: context.order.booking_channel_code,
      stayType: context.order.stay_type,
      memberStay: Boolean(context.order.member_id || context.order.member_contract_id),
      policyBaseAmountMinor: policyPricing.currentContractAmount.minorUnits,
      targetCurrentContractAmountMinor: input.targetCurrentContractAmountMinor,
      channelPriceDifferenceReason: input.channelPriceDifferenceReason,
      manualPriceAdjustmentReason: input.manualPriceAdjustmentReason
    });
    const pricing: PricingResult = {
      ...policyPricing,
      currentContractAmount: money(policyPricing.currentContractAmount.currency, decision.currentContractAmountMinor)
    };
    const oldAmountSummary = await orderAmountSummary(db, context);
    const collectionFacts = await db.selectFrom("collection_facts")
      .select([
        "fact_id", "fact_type", "amount_minor", "net_effect_minor", "currency",
        "references_fact_id", "reverses_fact_id", "pricing_revision_id", "command_id", "created_at"
      ])
      .where("order_id", "=", orderId)
      .orderBy("created_at")
      .orderBy("fact_id")
      .execute();
    const activeCoverageRows = await db.selectFrom("coverage_items")
      .select(["id", "service_date", "contract_id", "lot_id", "status", "inventory_unit_id", "unit_kind"])
      .where("order_id", "=", orderId)
      .where("status", "in", ["HELD", "CONSUMED"])
      .orderBy("service_date")
      .execute();
    if (membershipConversion) {
      const expectedDates = currentTimeline.map((item) => item.serviceDate);
      const pricingCoverage = new Map(policyPricing.coverageSet.map((item) => [item.serviceDate, item]));
      if (activeCoverageRows.length !== expectedDates.length
        || policyPricing.coverageSet.length !== expectedDates.length
        || pricingCoverage.size !== expectedDates.length
        || activeCoverageRows.some((coverage, index) => {
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
        })
        || policyPricing.cashRemainder.minorUnits !== 0
        || policyPricing.currentContractAmount.minorUnits !== 0) {
        throw new DomainError("ENTITLEMENT_CONFLICT", "升级会员后的已核销权益与换房计划不一致，不能安全换房", 409);
      }
    }
    const desiredCoverageByDate = new Map(pricing.coverageSet.map((item) => [item.serviceDate, item]));
    const preservedCoverageDates: string[] = [];
    const migratedHeldCoverageDates: string[] = [];
    const consumedCoverageDates: string[] = [];
    for (const coverage of activeCoverageRows) {
      const desired = desiredCoverageByDate.get(coverage.service_date);
      if (coverage.status === "CONSUMED") {
        consumedCoverageDates.push(coverage.service_date);
      } else if (desired
        && coverage.inventory_unit_id === desired.inventoryUnitId
        && coverage.unit_kind === desired.unitKind
        && coverage.lot_id === desired.entitlementLotId) {
        preservedCoverageDates.push(coverage.service_date);
      } else if (desired) {
        migratedHeldCoverageDates.push(coverage.service_date);
      }
    }
    const beforeClaims = currentTimeline.map((item) => ({
      serviceDate: item.serviceDate,
      inventoryUnitId: item.inventoryUnitId
    }));
    const afterClaims = stayTimeline.map((item) => ({
      serviceDate: item.serviceDate,
      inventoryUnitId: item.inventoryUnitId
    }));
    const preservedClaims = beforeClaims.filter((item, index) => item.inventoryUnitId === afterClaims[index]?.inventoryUnitId);
    const releasedClaims = beforeClaims.filter((item, index) => item.inventoryUnitId !== afterClaims[index]?.inventoryUnitId);
    const addedClaims = afterClaims.filter((item, index) => item.inventoryUnitId !== beforeClaims[index]?.inventoryUnitId);
    const actualCurrentUnitId = context.order.status === "CHECKED_IN"
      ? currentTimeline.find((item) => item.serviceDate === businessDate)?.inventoryUnitId
      : undefined;
    if (context.order.status === "CHECKED_IN" && !actualCurrentUnitId) {
      throw new DomainError("INTERNAL_ERROR", "在住订单的当前营业日不在有效住宿安排内", 500);
    }
    const actualCurrentInventoryUnit = actualCurrentUnitId
      ? await loadInventoryUnit(db, propertyId, actualCurrentUnitId)
      : null;
    const fundsSummary = {
      netRecordedCollection: oldAmountSummary.netRecordedCollection,
      collectionDifference: money(
        pricing.currentContractAmount.currency,
        pricing.currentContractAmount.minorUnits - oldAmountSummary.netRecordedCollection.minorUnits
      ),
      factCount: collectionFacts.length
    };
    return finalize(propertyId, {
      operation: "MOVE_UNIT",
      orderId,
      stayId: context.stay.id,
      businessDate,
      toInventoryUnit: newUnit,
      effectiveDate,
      occupantCount,
      occupancyCapacity: newUnit.occupancyCapacity,
      before: {
        arrivalDate: context.order.arrival_date,
        departureDate: context.order.departure_date,
        nights: currentTimeline.length,
        currentContractAmount: oldAmountSummary.currentContractAmount,
        stayTimeline: currentTimeline,
        actualCurrentInventoryUnit,
        effectiveDateInventoryUnit: currentUnit
      },
      after: {
        arrivalDate: context.order.arrival_date,
        departureDate: context.order.departure_date,
        nights: stayTimeline.length,
        stayTimeline,
        pricing
      },
      pricingDecision: pricingDecisionEffect(pricing.currentContractAmount.currency, decision),
      inventoryChange: { preservedClaims, releasedClaims, addedClaims },
      entitlementSummary: {
        preservedCoverageDates,
        migratedHeldCoverageDates,
        consumedCoverageDates,
        convertedMembershipCoveragePreserved: membershipConversion !== null,
        ledgerWriteCount: membershipConversion ? 0 : migratedHeldCoverageDates.length * 2
      },
      fundsSummary
    }, {
      ...baseBasis,
      businessDate,
      stayTimeline: currentTimeline,
      inventory: fingerprint,
      occupantCount,
      destinationInventoryUnit: newUnit,
      membershipConversion,
      activeCoverage: activeCoverageRows,
      collectionFacts
    });
  }

  if (commandType === "REPRICE_ORDER") {
    await assertOrderNotConvertedToMembership(db, orderId);
    assertOrderMutable(context.order.status);
    const targetCurrentContractAmountMinor = requireNonNegativeWholeYuanMinor(input, "targetCurrentContractAmountMinor");
    if (context.order.stay_type === "FREE" && targetCurrentContractAmountMinor !== 0) {
      throw new DomainError("VALIDATION_ERROR", "Free stays must keep a zero current contract amount");
    }
    const stayTimeline = await loadActiveStayTimeline(db, context);
    const policyPricing = await priceStayTimeline(db, {
      propertyId, orderId, memberId: context.order.member_id, memberContractId: context.order.member_contract_id,
      arrivalDate: context.order.arrival_date, departureDate: context.order.departure_date,
      stayType: context.order.stay_type as StayType, policyVersionId: context.order.pricing_policy_version_id,
      timeline: stayTimeline, manualAdjustmentMinor: 0
    });
    const manualAdjustmentMinor = targetCurrentContractAmountMinor - policyPricing.currentContractAmount.minorUnits;
    const pricing: PricingResult = {
      ...policyPricing,
      currentContractAmount: { currency: policyPricing.currentContractAmount.currency, minorUnits: targetCurrentContractAmountMinor }
    };
    return finalize(propertyId, {
      orderId, inventoryUnitId: stayTimeline.at(-1)!.inventoryUnitId, stayTimeline,
      before: { currentContractAmount: (await orderAmountSummary(db, context)).currentContractAmount },
      policyBaseAmount: policyPricing.currentContractAmount,
      targetCurrentContractAmount: pricing.currentContractAmount,
      pricing, manualAdjustmentMinor
    }, { ...baseBasis, stayTimeline });
  }

  if (commandType === "REFRESH_MEMBER_COVERAGE") {
    await assertOrderNotConvertedToMembership(db, orderId);
    assertOrderMutable(context.order.status);
    if (!context.order.member_id && !context.order.member_contract_id) throw new DomainError("ENTITLEMENT_CONFLICT", "订单未选择会员档案，不能刷新会员覆盖", 409);
    const stayTimeline = await loadActiveStayTimeline(db, context);
    const pricing = await priceStayTimeline(db, {
      propertyId, orderId, memberId: context.order.member_id, memberContractId: context.order.member_contract_id,
      arrivalDate: context.order.arrival_date, departureDate: context.order.departure_date,
      stayType: context.order.stay_type as StayType, policyVersionId: context.order.pricing_policy_version_id,
      timeline: stayTimeline, manualAdjustmentMinor: 0
    });
    return finalize(propertyId, {
      orderId, inventoryUnitId: stayTimeline.at(-1)!.inventoryUnitId, stayTimeline,
      before: { currentContractAmount: (await orderAmountSummary(db, context)).currentContractAmount },
      pricing
    }, { ...baseBasis, stayTimeline });
  }

  if (commandType === "RECORD_COLLECTION") {
    assertOperatorFundsAllowedForOrder(context);
    await assertLodgingFundsOpenForOrder(db, orderId);
    const amountMinor = requireInteger(input, "amountMinor", { min: 1 });
    const method = requireCollectionMethod(input);
    const { transactionReference, note } = fundsTransactionAndNote(input, method, false);
    if (!["RESERVED", "CHECKED_IN", "CHECKED_OUT"].includes(context.order.status)) throw new DomainError("INVALID_ORDER_STATE", "Cannot record a collection for this order", 409);
    return finalize(propertyId, { orderId, amountMinor, currency: context.revision.currency, method, transactionReference, note }, baseBasis);
  }

  if (commandType === "RECORD_REFUND") {
    assertOperatorFundsAllowedForOrder(context);
    await assertLodgingFundsOpenForOrder(db, orderId);
    const amountMinor = requireInteger(input, "amountMinor", { min: 1 });
    const referencesFactId = requireString(input, "referencesFactId");
    const method = requireCollectionMethod(input);
    const refundFunds = fundsTransactionAndNote(input, method, true);
    if (refundFunds.refundReference) {
      const recorded = await db.selectFrom("collection_facts").innerJoin("orders", "orders.id", "collection_facts.order_id")
        .select("collection_facts.fact_id").where("orders.property_id", "=", propertyId)
        .where("collection_facts.refund_reference", "=", refundFunds.refundReference).executeTakeFirst();
      if (recorded) throw new DomainError("AGGREGATE_VERSION_CONFLICT", "该企业微信退款单号已经登记，请核对原记录", 409);
    }
    const original = await db.selectFrom("collection_facts")
      .innerJoin("orders", "orders.id", "collection_facts.order_id")
      .selectAll("collection_facts")
      .where("collection_facts.fact_id", "=", referencesFactId)
      .where("orders.property_id", "=", propertyId)
      .executeTakeFirst();
    if (!original) throw new DomainError("NOT_FOUND", "Referenced collection fact not found", 404);
    if (original.order_id !== orderId) throw new DomainError("CROSS_ORDER_FACT_REFERENCE", "Refund must reference a collection in the same order", 409);
    if (original.fact_type !== "COLLECTION") throw new DomainError("VALIDATION_ERROR", "Refund must reference a collection fact");
    if ((original.method === "WECOM") !== (method === "WECOM")) {
      throw new DomainError("VALIDATION_ERROR", "企业微信收款必须通过企业微信原路退款");
    }
    const originalReversal = await db.selectFrom("collection_facts").select("fact_id").where("reverses_fact_id", "=", referencesFactId).executeTakeFirst();
    if (originalReversal) throw new DomainError("FACT_ALREADY_REVERSED", "Cannot refund a reversed collection", 409, false, { reversalFactId: originalReversal.fact_id });
    const activeRefunded = await activeRefundedAmount(db, referencesFactId);
    if (activeRefunded + amountMinor > original.amount_minor) {
      throw new DomainError("REFUND_LIMIT_EXCEEDED", "退款金额不能超过所选原收款的剩余可退金额", 409);
    }
    return finalize(propertyId, { orderId, amountMinor, currency: original.currency, referencesFactId, method, ...refundFunds }, { ...baseBasis, originalFact: original, activeRefunded });
  }

  if (commandType === "REVERSE_FACT") {
    await assertLodgingFundsOpenForOrder(db, orderId);
    const reversesFactId = requireString(input, "reversesFactId");
    const original = await db.selectFrom("collection_facts")
      .innerJoin("orders", "orders.id", "collection_facts.order_id")
      .selectAll("collection_facts")
      .where("collection_facts.fact_id", "=", reversesFactId)
      .where("orders.property_id", "=", propertyId)
      .executeTakeFirst();
    if (!original) throw new DomainError("NOT_FOUND", "Fact not found", 404);
    if (original.order_id !== orderId) throw new DomainError("CROSS_ORDER_FACT_REFERENCE", "Reversal must remain within the order", 409);
    if (original.fact_type === "REVERSAL") throw new DomainError("VALIDATION_ERROR", "A reversal fact cannot itself be reversed");
    const reversal = await db.selectFrom("collection_facts").select("fact_id").where("reverses_fact_id", "=", reversesFactId).executeTakeFirst();
    if (reversal) throw new DomainError("FACT_ALREADY_REVERSED", "Fact is already reversed", 409);
    const activeRefunded = original.fact_type === "COLLECTION" ? await activeRefundedAmount(db, reversesFactId) : 0;
    if (activeRefunded > 0) {
      throw new DomainError("REFUND_LIMIT_EXCEEDED", "Reverse active refunds before reversing their collection", 409, false, { activeRefunded });
    }
    return finalize(propertyId, { orderId, reversesFactId, amountMinor: original.amount_minor, netEffectMinor: -original.net_effect_minor, currency: original.currency, note: requireString(input, "note") }, { ...baseBasis, originalFact: original, activeRefunded });
  }

  if (commandType === "CHECK_IN") {
    if (context.order.status !== "RESERVED") throw new DomainError("INVALID_ORDER_STATE", "Only a reserved order can check in", 409);
    const businessDate = await propertyLocalToday(db, propertyId);
    if (businessDate < context.order.arrival_date) {
      throw new DomainError("INVALID_ORDER_STATE", "未到计划入住日，不能办理普通入住", 409, false, {
        businessDate,
        arrivalDate: context.order.arrival_date
      });
    }
    if (businessDate >= context.order.departure_date) {
      throw new DomainError("INVALID_ORDER_STATE", "已到或超过计划退房日，不能补办入住", 409, false, {
        businessDate,
        departureDate: context.order.departure_date
      });
    }
    const heldCoverage = await db.selectFrom("coverage_items").select("id")
      .where("order_id", "=", orderId).where("status", "=", "HELD").orderBy("id").execute();
    return finalize(propertyId, {
      orderId,
      fromStatus: context.order.status,
      toStatus: "CHECKED_IN",
      inventoryUnitId: context.currentSegment.inventoryUnitId,
      businessDate,
      effectiveDate: context.order.arrival_date,
      recordingMode: businessDate === context.order.arrival_date ? "ON_SCHEDULE" : "LATE_RECORDED",
      entitlementTransition: { from: "HELD", to: "CONSUMED", coverageCount: heldCoverage.length },
      ...temporaryOtherRoomEvidenceEffect
    }, {
      ...baseBasis,
      heldCoverageIds: heldCoverage.map((coverage) => coverage.id),
      businessDate
    });
  }

  if (commandType === "CHECK_OUT") {
    if (context.order.status !== "CHECKED_IN") throw new DomainError("INVALID_ORDER_STATE", "Only an in-house order can check out", 409);
    const businessDate = await propertyLocalToday(db, propertyId);
    if (businessDate < context.order.departure_date) {
      throw new DomainError("INVALID_ORDER_STATE", "未到计划退房日，不能办理普通退房；当前版本暂不支持提前退房", 409, false, {
        businessDate,
        departureDate: context.order.departure_date
      });
    }
    const heldCoverage = await db.selectFrom("coverage_items").select("id")
      .where("order_id", "=", orderId).where("status", "=", "HELD").orderBy("id").execute();
    if (heldCoverage.length > 0) throw new DomainError("ENTITLEMENT_CONFLICT", "In-house member coverage must be consumed before check-out", 409);
    if (currentReleaseFeatures.cleaningWorkflow) {
      const existingCleaningTask = await db.selectFrom("cleaning_tasks").select(["id", "status"])
        .where("order_id", "=", orderId).executeTakeFirst();
      if (existingCleaningTask) {
        throw new DomainError("AGGREGATE_VERSION_CONFLICT", "Check-out already has a cleaning task", 409, false, {
          cleaningTaskId: existingCleaningTask.id,
          status: existingCleaningTask.status
        });
      }
    }
    return finalize(propertyId, {
      orderId,
      fromStatus: context.order.status,
      toStatus: "CHECKED_OUT",
      inventoryUnitId: context.currentSegment.inventoryUnitId,
      businessDate,
      effectiveDate: context.order.departure_date,
      recordingMode: businessDate === context.order.departure_date ? "ON_SCHEDULE" : "LATE_RECORDED",
      amounts: await orderAmountSummary(db, context),
      ...(currentReleaseFeatures.cleaningWorkflow ? { cleaningTask: {
        inventoryUnitId: context.currentSegment.inventoryUnitId,
        serviceDate: businessDate,
        status: "PENDING"
      } } : {}),
      ...temporaryOtherRoomEvidenceEffect
    }, { ...baseBasis, heldCoverageIds: [], cleaningTask: null, businessDate });
  }

  if (commandType === "COMPLETE_STAY") {
    if (input.actualStayCompletedConfirmed !== true) {
      throw new DomainError("CONFIRMATION_REQUIRED", "必须确认客人的确实际入住且已经离店", 409);
    }
    const reasonNote = requireString(input, "reasonNote").trim();
    if (reasonNote === "") {
      throw new DomainError("REASON_REQUIRED", "完成住宿必须填写说明（例如实际入住与离店情况）", 409);
    }
    if (context.order.status !== "RESERVED" || context.stay.status !== "PLANNED") {
      throw new DomainError("INVALID_ORDER_STATE", "只有已预订且未办理入住的订单可以完成住宿", 409);
    }
    const businessDate = await propertyLocalToday(db, propertyId);
    if (businessDate < context.order.departure_date) {
      throw new DomainError("INVALID_ORDER_STATE", "订单未到计划退房日，请使用普通入住流程", 409, false, {
        businessDate,
        departureDate: context.order.departure_date
      });
    }
    const stayTimeline = await loadActiveStayTimeline(db, context);
    await assertStayDateChangeLifecycle(db, context, businessDate, stayTimeline);
    const fulfillmentAmendments = await db.selectFrom("amendments")
      .select("amendment_type")
      .where("order_id", "=", orderId)
      .where("amendment_type", "in", ["CHECK_IN", "CHECK_OUT"])
      .execute();
    if (fulfillmentAmendments.length > 0) {
      throw new DomainError("INVALID_ORDER_STATE", "订单已有入住或退房记录，不能再次完成住宿", 409, false, {
        existingFulfillmentAmendments: fulfillmentAmendments.map((amendment) => amendment.amendment_type)
      });
    }
    const activeClaims = await db.selectFrom("inventory_claims")
      .select(["id", "service_date", "inventory_unit_id", "source_id"])
      .where("source_type", "=", "ORDER_SEGMENT")
      .where("source_id", "in", context.segmentIds)
      .where("active", "=", true)
      .orderBy("service_date")
      .orderBy("id")
      .execute();
    if (activeClaims.length !== stayTimeline.length
      || activeClaims.some((claim, index) => claim.service_date !== stayTimeline[index]!.serviceDate
        || claim.inventory_unit_id !== stayTimeline[index]!.inventoryUnitId)) {
      throw new DomainError("INTERNAL_ERROR", "完成住宿的活动 Claim 与完整住宿时间线不一致", 500, false, {
        orderId,
        activeClaimIds: activeClaims.map((claim) => claim.id)
      });
    }
    const isMemberStay = Boolean(context.order.member_id || context.order.member_contract_id);
    const activeCoverage = await db.selectFrom("coverage_items")
      .select(["id", "service_date", "inventory_unit_id", "status"])
      .where("order_id", "=", orderId)
      .where("status", "in", ["HELD", "CONSUMED"])
      .orderBy("service_date")
      .orderBy("id")
      .execute();
    const heldCoverage = activeCoverage.filter((item) => item.status === "HELD");
    const consumedCoverage = activeCoverage.filter((item) => item.status === "CONSUMED");
    if (isMemberStay) {
      if (consumedCoverage.length > 0) {
        throw new DomainError("ENTITLEMENT_CONFLICT", "未入住订单存在已核销会员权益，当前数据状态异常，不能完成住宿", 409);
      }
      const heldByDate = new Map(heldCoverage.map((item) => [item.service_date, item.inventory_unit_id]));
      if (stayTimeline.length !== heldCoverage.length
        || stayTimeline.some((item) => heldByDate.get(item.serviceDate) !== item.inventoryUnitId)) {
        throw new DomainError(
          "ENTITLEMENT_CONFLICT",
          "会员权益冻结与完整住宿时间线不一致，不能完成住宿；请先核对会员覆盖或联系管理员",
          409,
          false,
          {
            orderId,
            timelineDates: stayTimeline.map((item) => item.serviceDate),
            heldCoverageDates: heldCoverage.map((item) => item.service_date)
          }
        );
      }
    } else if (activeCoverage.length > 0) {
      throw new DomainError(
        "ENTITLEMENT_CONFLICT",
        "非会员订单存在冻结或已核销会员权益，当前数据状态异常，不能完成住宿",
        409,
        false,
        { orderId, coverageIds: activeCoverage.map((item) => item.id) }
      );
    }
    // 完成住宿时按真实结算核清：免费/会员/渠道订单不登记住宿收款；
    // 普通订单可以补记不超过未结余额的真实收款；0 元不写事实。
    const freeStay = context.order.stay_type === "FREE";
    const memberStay = isMemberStay;
    const externalChannel = Boolean(context.order.booking_channel_code && externalChannelCodes.has(context.order.booking_channel_code));
    let channelPricingBasis: string | null = null;
    if (externalChannel) {
      const revisionBasis = await db.selectFrom("pricing_revisions")
        .select("pricing_basis")
        .where("id", "=", context.revision.id)
        .executeTakeFirstOrThrow();
      channelPricingBasis = revisionBasis.pricing_basis;
      if (revisionBasis.pricing_basis !== "CHANNEL_CONTRACT") {
        throw new DomainError(
          "VALIDATION_ERROR",
          "外部渠道订单缺少本单渠道应结金额的计价记录，不能完成住宿；请先核对渠道资料",
          409
        );
      }
    }
    if (externalChannel && (
      !context.order.channel_order_reference?.trim()
      || context.revision.currentContractAmountMinor <= 0
    )) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "外部渠道订单缺少渠道订单号或本单渠道应结金额，不能完成住宿；请先核对渠道资料",
        409,
        false,
        {
          currentContractAmountMinor: context.revision.currentContractAmountMinor
        }
      );
    }
    const rawCollection = input.collection;
    const collectionFacts = await db.selectFrom("collection_facts")
      .select(["fact_id", "fact_type", "net_effect_minor", "currency"])
      .where("order_id", "=", orderId)
      .orderBy("created_at")
      .orderBy("fact_id")
      .execute();
    if (collectionFacts.some((fact) => fact.currency !== context.revision.currency)) {
      throw new DomainError("VALIDATION_ERROR", "订单住宿收款币种与当前计价币种不一致，不能完成住宿", 409);
    }
    if ((freeStay || memberStay || externalChannel) && collectionFacts.length > 0) {
      throw new DomainError(
        "VALIDATION_ERROR",
        freeStay
          ? "免费住宿已存在住宿收款记录，不能完成住宿；请先核对资金事实"
          : memberStay
            ? "会员住宿已存在住宿收款记录，不能完成住宿；请先核对资金事实"
            : "外部渠道订单已存在 PMS 住宿收款记录，不能完成住宿；请先核对渠道资金事实",
        409,
        false,
        { orderId, collectionFactIds: collectionFacts.map((fact) => fact.fact_id) }
      );
    }
    const preCollectionAmounts = amountSummary(
      context.revision.currency,
      context.revision.currentContractAmountMinor,
      collectionFacts.map((fact) => fact.net_effect_minor)
    );
    const outstandingMinor = preCollectionAmounts.collectionDifference.minorUnits;
    let collection: ({
      amountMinor: number;
      currency: string;
      method: "WECOM" | "BANK_TRANSFER";
      transactionReference: string;
      note: string;
    } | {
      amountMinor: number;
      currency: string;
      method: "CASH";
      cashCollector: string;
      note: string;
    }) | null = null;
    if (freeStay || memberStay || externalChannel) {
      if (rawCollection !== undefined && rawCollection !== null) {
        throw new DomainError("VALIDATION_ERROR", freeStay
          ? "免费住宿不需要登记住宿收款"
          : memberStay
            ? "会员住宿通过会员权益核销结清，不需要登记住宿收款"
            : "外部渠道订单不在 PMS 登记单笔住宿收款；请核对渠道订单号和本单渠道应结金额");
      }
    } else if (outstandingMinor > 0 && rawCollection !== undefined && rawCollection !== null) {
      const normalizedCollection = normalizeBackfillCollectionInput(rawCollection, "collection", "完成住宿");
      if (normalizedCollection.amountMinor > outstandingMinor) {
        throw new DomainError("VALIDATION_ERROR", "完成住宿补记实收金额不能超过订单未结余额");
      }
      if (normalizedCollection.amountMinor > 0) {
        collection = normalizedCollection.method === "CASH"
          ? {
              amountMinor: normalizedCollection.amountMinor,
              currency: context.revision.currency,
              method: normalizedCollection.method,
              cashCollector: normalizedCollection.cashCollector!,
              note: normalizedCollection.note!
            }
          : {
              amountMinor: normalizedCollection.amountMinor,
              currency: context.revision.currency,
              method: normalizedCollection.method,
              transactionReference: normalizedCollection.transactionReference!,
              note: normalizedCollection.note
            };
      }
    } else if (rawCollection !== undefined && rawCollection !== null) {
      throw new DomainError("VALIDATION_ERROR", "订单已结清，不需要随完成住宿登记收款");
    }
    const effectiveCollectedMinor = preCollectionAmounts.netRecordedCollection.minorUnits + (collection?.amountMinor ?? 0);
    const settlementStatus = freeStay || memberStay || externalChannel
      || effectiveCollectedMinor >= context.revision.currentContractAmountMinor
      ? "SETTLED"
      : "ARREARS";
    const checkInInventoryUnitId = stayTimeline[0]!.inventoryUnitId;
    const checkOutInventoryUnitId = stayTimeline.at(-1)!.inventoryUnitId;
    return finalize(propertyId, {
      operation: "COMPLETE_STAY",
      orderId,
      stayId: context.stay.id,
      inventoryUnitId: checkOutInventoryUnitId,
      arrivalDate: context.order.arrival_date,
      departureDate: context.order.departure_date,
      businessDate,
      reasonNote,
      stayTimeline,
      settlementStatus,
      amounts: collection
        ? amountSummary(context.revision.currency, context.revision.currentContractAmountMinor, [preCollectionAmounts.netRecordedCollection.minorUnits + collection.amountMinor])
        : preCollectionAmounts,
      collection,
      inventoryRelease: {
        claimIds: activeClaims.map((claim) => claim.id),
        claimCount: activeClaims.length
      },
      checkIn: {
        orderId,
        fromStatus: "RESERVED",
        toStatus: "CHECKED_IN",
        inventoryUnitId: checkInInventoryUnitId,
        businessDate,
        effectiveDate: context.order.arrival_date,
        recordingMode: businessDate === context.order.arrival_date ? "ON_SCHEDULE" : "LATE_RECORDED",
        entitlementTransition: { from: "HELD", to: "CONSUMED", coverageCount: heldCoverage.length }
      },
      checkOut: {
        orderId,
        fromStatus: "CHECKED_IN",
        toStatus: "CHECKED_OUT",
        inventoryUnitId: checkOutInventoryUnitId,
        businessDate,
        effectiveDate: context.order.departure_date,
        recordingMode: businessDate === context.order.departure_date ? "ON_SCHEDULE" : "LATE_RECORDED"
      },
      entitlementTransition: {
        from: "HELD",
        to: "CONSUMED",
        coverageCount: heldCoverage.length,
        coverageIds: heldCoverage.map((coverage) => coverage.id)
      },
      ...temporaryOtherRoomEvidenceEffect
    }, {
      ...baseBasis,
      heldCoverageIds: heldCoverage.map((coverage) => coverage.id),
      activeCoverage: activeCoverage.map((coverage) => ({ id: coverage.id, status: coverage.status })),
      activeClaims: activeClaims.map((claim) => ({ id: claim.id, serviceDate: claim.service_date, sourceId: claim.source_id })),
      collectionFacts: collectionFacts.map((fact) => ({ id: fact.fact_id, type: fact.fact_type, netEffectMinor: fact.net_effect_minor })),
      channelPricingBasis,
      businessDate
    });
  }

  if ((commandType as string) === "BACKFILL_COMPLETED_STAY") {
    if (!currentReleaseFeatures.stayBackfillSubmission) {
      throw new DomainError("VALIDATION_ERROR", "补录已改为创建时一次完成，请使用“补录住宿”入口", 409);
    }
    if (context.order.status !== "RESERVED" || context.stay.status !== "PLANNED") {
      throw new DomainError("INVALID_ORDER_STATE", "只有已预订且未办理入住的订单可以补录完成住宿", 409);
    }
    const businessDate = await propertyLocalToday(db, propertyId);
    if (businessDate < context.order.departure_date) {
      throw new DomainError("INVALID_ORDER_STATE", "订单未到计划退房日，请使用普通入住流程", 409, false, {
        businessDate,
        departureDate: context.order.departure_date
      });
    }
    // 补录的是已经完全发生的住宿，结清方式必须在补录时一次性核清：
    // 免费住宿/会员住宿本身不需要收款；外部渠道订单的房款按渠道总账核对（渠道订单号创建时必填）；
    // 企微或无渠道普通住宿有未结余额时，必须随补录登记等额收款（企微/转账必填交易单号，现金必填收款人）。
    const freeStay = context.order.stay_type === "FREE";
    const memberStay = Boolean(context.order.member_id || context.order.member_contract_id);
    const externalChannel = Boolean(context.order.booking_channel_code && externalChannelCodes.has(context.order.booking_channel_code));
    const rawCollection = input.collection;
    const preCollectionAmounts = await orderAmountSummary(db, context);
    const outstandingMinor = preCollectionAmounts.collectionDifference.minorUnits;
    let collection: ({
      amountMinor: number;
      currency: string;
      method: "WECOM" | "BANK_TRANSFER";
      transactionReference: string;
      note: string;
    } | {
      amountMinor: number;
      currency: string;
      method: "CASH";
      cashCollector: string;
      note: string;
    }) | null = null;
    if (freeStay || memberStay || externalChannel) {
      if (rawCollection !== undefined && rawCollection !== null) {
        throw new DomainError("VALIDATION_ERROR", freeStay
          ? "免费住宿不需要登记住宿收款"
          : memberStay
            ? "会员住宿通过会员权益核销结清，不需要登记住宿收款"
            : "外部渠道订单不在 PMS 登记单笔住宿收款；请核对渠道订单号和本单渠道应结金额");
      }
    } else if (outstandingMinor > 0 && rawCollection !== undefined && rawCollection !== null) {
      const normalizedCollection = normalizeBackfillCollectionInput(rawCollection, "collection");
      if (normalizedCollection.amountMinor > outstandingMinor) {
        throw new DomainError("VALIDATION_ERROR", "补录实收金额不能超过订单未结余额");
      }
      if (normalizedCollection.amountMinor > 0) {
        collection = normalizedCollection.method === "CASH"
          ? {
              amountMinor: normalizedCollection.amountMinor,
              currency: context.revision.currency,
              method: normalizedCollection.method,
              cashCollector: normalizedCollection.cashCollector!,
              note: normalizedCollection.note!
            }
          : {
              amountMinor: normalizedCollection.amountMinor,
              currency: context.revision.currency,
              method: normalizedCollection.method,
              transactionReference: normalizedCollection.transactionReference!,
              note: normalizedCollection.note
            };
      }
    } else if (rawCollection !== undefined && rawCollection !== null) {
      throw new DomainError("VALIDATION_ERROR", "订单已结清，不需要随补录登记收款");
    }
    const heldCoverage = await db.selectFrom("coverage_items").select("id")
      .where("order_id", "=", orderId).where("status", "=", "HELD").orderBy("id").execute();
    return finalize(propertyId, {
      operation: "BACKFILL_COMPLETED_STAY",
      orderId,
      stayId: context.stay.id,
      inventoryUnitId: context.currentSegment.inventoryUnitId,
      arrivalDate: context.order.arrival_date,
      departureDate: context.order.departure_date,
      businessDate,
      amounts: collection
        ? amountSummary(context.revision.currency, context.revision.currentContractAmountMinor, [preCollectionAmounts.netRecordedCollection.minorUnits + collection.amountMinor])
        : preCollectionAmounts,
      collection,
      checkIn: {
        orderId,
        fromStatus: "RESERVED",
        toStatus: "CHECKED_IN",
        inventoryUnitId: context.currentSegment.inventoryUnitId,
        businessDate,
        effectiveDate: context.order.arrival_date,
        recordingMode: businessDate === context.order.arrival_date ? "ON_SCHEDULE" : "LATE_RECORDED",
        entitlementTransition: { from: "HELD", to: "CONSUMED", coverageCount: heldCoverage.length }
      },
      checkOut: {
        orderId,
        fromStatus: "CHECKED_IN",
        toStatus: "CHECKED_OUT",
        inventoryUnitId: context.currentSegment.inventoryUnitId,
        businessDate,
        effectiveDate: context.order.departure_date,
        recordingMode: businessDate === context.order.departure_date ? "ON_SCHEDULE" : "LATE_RECORDED"
      },
      entitlementTransition: { from: "HELD", to: "CONSUMED", coverageCount: heldCoverage.length }
    }, {
      ...baseBasis,
      heldCoverageIds: heldCoverage.map((coverage) => coverage.id),
      businessDate
    });
  }

  if (commandType === "CANCEL_ORDER" || commandType === "MARK_NO_SHOW") {
    if (context.order.status !== "RESERVED") throw new DomainError("INVALID_ORDER_STATE", `${commandType} requires a reserved order`, 409);
    const localClock = await propertyLocalClock(db, propertyId);
    if (commandType === "MARK_NO_SHOW"
      && (localClock.date < context.order.arrival_date
        || (localClock.date === context.order.arrival_date && localClock.time < "20:00"))) {
      throw new DomainError("INVALID_ORDER_STATE", "计划到店日 20:00 后才能标记未到", 409, false, {
        businessDate: localClock.date,
        arrivalDate: context.order.arrival_date
      });
    }
    const heldCoverage = await db.selectFrom("coverage_items").select("id")
      .where("order_id", "=", orderId).where("status", "=", "HELD").orderBy("id").execute();
    const collectionFacts = await db.selectFrom("collection_facts").select("net_effect_minor")
      .where("order_id", "=", orderId).execute();
    const amounts = amountSummary(context.revision.currency, 0, collectionFacts.map((fact) => fact.net_effect_minor));
    const pricingBasis = context.order.stay_type === "FREE"
      ? "FREE"
      : context.order.member_id || context.order.member_contract_id
        ? "MEMBER_ENTITLEMENT"
        : context.order.booking_channel_code && context.order.booking_channel_code !== "WECOM"
          ? "CHANNEL_CONTRACT"
          : "POLICY";
    return finalize(propertyId, {
      orderId,
      fromStatus: context.order.status,
      toStatus: commandType === "CANCEL_ORDER" ? "CANCELLED" : "NO_SHOW",
      inventoryUnitId: context.currentSegment.inventoryUnitId,
      businessDate: localClock.date,
      freeStayReason: context.order.free_stay_reason,
      freeStayCategoryCode: context.order.free_stay_category_code,
      currentContractAmount: { currency: context.revision.currency, minorUnits: 0 },
      amounts,
      pricingRevision: {
        currentContractAmount: { currency: context.revision.currency, minorUnits: 0 },
        pricingBasis
      },
      entitlementTransition: { from: "HELD", to: "RELEASED", coverageCount: heldCoverage.length },
      ...temporaryOtherRoomEvidenceEffect
    }, {
      ...baseBasis,
      heldCoverageIds: heldCoverage.map((coverage) => coverage.id),
      businessDate: localClock.date,
      ...(commandType === "MARK_NO_SHOW" ? { noShowThreshold: "20:00", noShowEligible: true } : {})
    });
  }

  if (commandType === "REVOKE_CHECK_IN") {
    await assertOrderNotConvertedToMembership(db, orderId);
    if (context.order.status !== "CHECKED_IN") {
      throw new DomainError("INVALID_ORDER_STATE", "只有在住订单可以撤销误办入住", 409);
    }
    if (input.unusedRoomConfirmed !== true) {
      throw new DomainError("VALIDATION_ERROR", "必须确认房间未被实际使用");
    }
    const businessDate = await propertyLocalToday(db, propertyId);
    if (businessDate !== context.order.arrival_date) {
      throw new DomainError("INVALID_ORDER_STATE", "只有计划入住当天可以撤销误办入住", 409, false, {
        businessDate,
        arrivalDate: context.order.arrival_date
      });
    }
    const [consumedCoverage, heldCoverage, collectionFacts] = await Promise.all([
      db.selectFrom("coverage_items").select("id")
        .where("order_id", "=", orderId).where("status", "=", "CONSUMED").orderBy("id").execute(),
      db.selectFrom("coverage_items").select("id")
        .where("order_id", "=", orderId).where("status", "=", "HELD").orderBy("id").execute(),
      db.selectFrom("collection_facts").select("net_effect_minor").where("order_id", "=", orderId).execute()
    ]);
    if (heldCoverage.length > 0) {
      throw new DomainError("ENTITLEMENT_CONFLICT", "在住订单仍有未核销会员权益，不能安全撤销入住", 409);
    }
    const pricingBasis = context.order.stay_type === "FREE"
      ? "FREE"
      : context.order.member_id || context.order.member_contract_id
        ? "MEMBER_ENTITLEMENT"
        : context.order.booking_channel_code && context.order.booking_channel_code !== "WECOM"
          ? "CHANNEL_CONTRACT"
          : "POLICY";
    return finalize(propertyId, {
      orderId,
      fromStatus: context.order.status,
      toStatus: "CHECK_IN_REVOKED",
      inventoryUnitId: context.currentSegment.inventoryUnitId,
      businessDate,
      effectiveDate: businessDate,
      recordingMode: "ON_SCHEDULE",
      unusedRoomConfirmed: true,
      currentContractAmount: { currency: context.revision.currency, minorUnits: 0 },
      amounts: amountSummary(context.revision.currency, 0, collectionFacts.map((fact) => fact.net_effect_minor)),
      pricingRevision: {
        currentContractAmount: { currency: context.revision.currency, minorUnits: 0 },
        pricingBasis
      },
      entitlementTransition: { from: "CONSUMED", to: "RESTORED", coverageCount: consumedCoverage.length },
      ...temporaryOtherRoomEvidenceEffect
    }, {
      ...baseBasis,
      businessDate,
      unusedRoomConfirmed: true,
      consumedCoverageIds: consumedCoverage.map((coverage) => coverage.id),
      heldCoverageIds: []
    });
  }

  throw new DomainError("VALIDATION_ERROR", `Unsupported command type: ${commandType}`);
}

export function coverageFromEffect(effect: Record<string, unknown>): CoverageItemDto[] {
  const pricing = requireObject(effect.pricing ?? requireObject(effect.after, "after").pricing, "pricing");
  const coverageSet = pricing.coverageSet;
  if (!Array.isArray(coverageSet)) throw new DomainError("INTERNAL_ERROR", "Effect pricing has no coverage set", 500);
  return coverageSet as CoverageItemDto[];
}

export function inventoryKindFromEffect(effect: Record<string, unknown>): InventoryUnitKind | undefined {
  const unit = effect.inventoryUnit ?? effect.toInventoryUnit;
  if (!unit || typeof unit !== "object") return undefined;
  const kind = (unit as Record<string, unknown>).kind;
  return kind === "ROOM" || kind === "BED" ? kind : undefined;
}

export function projectPrimaryGuestForRead(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return { ...(value as Record<string, unknown>) };
}

export function projectCommandEffectForRead(commandType: string, effect: Record<string, unknown>): Record<string, unknown> {
  if (commandType === "CREATE_ORDER") {
    return {
      ...effect,
      primaryGuest: projectPrimaryGuestForRead(effect.primaryGuest),
      ...(Object.hasOwn(effect, "occupants") ? { occupants: effect.occupants } : {}),
      bookingChannelCode: Object.hasOwn(effect, "bookingChannelCode") ? effect.bookingChannelCode : null,
      channelOrderReference: Object.hasOwn(effect, "channelOrderReference") ? effect.channelOrderReference : null,
      freeStayReason: Object.hasOwn(effect, "freeStayReason") ? effect.freeStayReason : null,
      freeStayCategoryCode: Object.hasOwn(effect, "freeStayCategoryCode") ? effect.freeStayCategoryCode : null,
      memberId: Object.hasOwn(effect, "memberId") ? effect.memberId : null
    };
  }
  if (commandType === "RECORD_COLLECTION" || commandType === "RECORD_REFUND") {
    return {
      ...effect,
      transactionReference: Object.hasOwn(effect, "transactionReference") ? effect.transactionReference : null
    };
  }
  return effect;
}
import { buildRoomCatalogEffect, assertCurrentCatalogQuote } from "../room-catalog.ts";
