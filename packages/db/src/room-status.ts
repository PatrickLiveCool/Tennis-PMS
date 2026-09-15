import { projectCatalogUnitNames } from "./room-catalog-labels.ts";
import { sql, type Kysely, type Transaction } from "kysely";
import {
  currentReleaseFeatures,
  DomainError,
  freeStayCategoryCodes,
  inventoryUnitKinds,
  ROOM_STATUS_MAX_QUERY_NIGHTS,
  ROOM_STATUS_OPERATIONAL_TASK_LIMIT,
  roomStatusStatuses,
  type AccessLevel,
  type CommandCapability,
  type RoomStatusActionCode,
  type RoomStatusActionDto,
  type RoomStatusAttention,
  type RoomStatusAvailabilitySummaryDto,
  type RoomStatusBedOccupancyDto,
  type RoomStatusBedSlotStateDto,
  type RoomStatusBoardDto,
  type RoomStatusBoardQueryDto,
  type RoomStatusBlockingFactKind,
  type RoomStatusConflictDto,
  type RoomStatusFilterOptionsDto,
  type RoomStatusHistoryDto,
  type RoomStatusIntervalDto,
  type RoomStatusOperationalTaskDto,
  type RoomStatusOperationalTaskKind,
  type RoomStatusOperationalAttention,
  type RoomStatusOccupantDto,
  type RoomStatusReferenceDto,
  type RoomStatusSourceCategory,
  type RoomStatusSourceKind,
  type RoomStatusStatus,
  type RoomStatusUnitDto
} from "@qintopia/contracts";
import { enumerateServiceDates, stableHash } from "@qintopia/domain";
import {
  historicalProtocolEpochMigration,
  legacyEffectProtocol,
  ordinaryStayCashLineTotalMinor,
  pricingCashLineTotalMinor
} from "./historical-command-protocol.ts";
import { projectOrderLifecycle } from "./orders.ts";
import { propertyLocalClockAt } from "./members.ts";
import type { Database } from "./schema.ts";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

type RoomStatusTransaction = Transaction<Database>;

interface ProjectionEvent {
  actualInventoryUnitId: string;
  roomId: string;
  serviceDate: string;
  sourceStartDate: string;
  sourceEndDate: string;
  orderArrivalDate?: string;
  orderDepartureDate?: string;
  sourceKey: string;
  sourceKind: RoomStatusSourceKind;
  sourceCategory?: RoomStatusSourceCategory | null;
  freeStayCategoryCode?: (typeof freeStayCategoryCodes)[number] | null;
  freeStayReason?: string | null;
  status: RoomStatusStatus;
  attention: RoomStatusAttention | null;
  operationalAttention: RoomStatusOperationalAttention | null;
  label: string;
  primaryOccupantLabel: string | null;
  occupants?: RoomStatusOccupantDto[];
  reason: string | null;
  blocking: boolean;
  current: boolean;
  blockingFactKind: RoomStatusBlockingFactKind | null;
  claimId: string | null;
  references: RoomStatusReferenceDto[];
  histories: RoomStatusHistoryDto[];
  commandIds: string[];
  targetReference: RoomStatusReferenceDto | null;
  orderId?: string;
}

interface CommandProjection {
  history: RoomStatusHistoryDto;
  receiptReference: RoomStatusReferenceDto | null;
}

interface OperationalTaskSeed {
  taskKind: RoomStatusOperationalTaskKind;
  businessDate: string;
  startDate: string;
  endDate: string;
  event: ProjectionEvent;
}

interface IntervalBuilder {
  event: ProjectionEvent;
  displayInventoryUnitId: string;
  startDate: string;
  lastDate: string;
  claimIds: string[];
  claimIdsByServiceDate: Map<string, string[]>;
  references: RoomStatusReferenceDto[];
  histories: RoomStatusHistoryDto[];
}

interface BuiltIntervals {
  byUnit: Map<string, RoomStatusIntervalDto[]>;
  claimIdsByIntervalAndDate: Map<string, Map<string, string[]>>;
}

interface BuiltBedOccupancies {
  byRoom: Map<string, RoomStatusBedOccupancyDto[]>;
  partial: boolean;
}

interface BuiltBedSlotStates {
  byRoom: Map<string, RoomStatusBedSlotStateDto[]>;
  partial: boolean;
}

interface CompletedOrderRoomStatusProjection {
  timelineByDate: Map<string, string>;
  status: RoomStatusStatus;
  reason: string | null;
  damaged: boolean;
}

interface ActiveOrderArrearsProjection {
  attention: RoomStatusAttention | null;
  damaged: boolean;
  reason: string | null;
}

interface FilteredRoomSelection {
  room: RoomStatusUnitDto;
  childUnitIds: string[];
}

type RoomStatusFilters = Pick<RoomStatusBoardQueryDto,
  "search" | "roomType" | "salesMode" | "status" | "minCapacity" | "unitKind">;

const externalChannelCodes = new Set(["YOUMUDAO", "CTRIP", "MEITUAN"]);
const freeStayCategoryCodeSet = new Set<string>(freeStayCategoryCodes);

type LodgingSourceProjectionRow = {
  stay_type?: string | null;
  member_id?: string | null;
  member_contract_id?: string | null;
  booking_channel_code?: string | null;
  channel_order_reference?: string | null;
  free_stay_category_code?: string | null;
  free_stay_reason?: string | null;
};

type LodgingSourceFields = Pick<ProjectionEvent,
  "sourceCategory" | "freeStayCategoryCode" | "freeStayReason">;

const nullLodgingSourceFields: LodgingSourceFields = {
  sourceCategory: null,
  freeStayCategoryCode: null,
  freeStayReason: null
};

function normalizedOptionalText(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

function roomStatusSourceCategoryForOrder(row: LodgingSourceProjectionRow): RoomStatusSourceCategory | null {
  if (row.stay_type === "FREE") return "FREE_STAY";
  if (row.member_id || row.member_contract_id) return "MEMBER";
  if (row.booking_channel_code && externalChannelCodes.has(row.booking_channel_code)) {
    return row.channel_order_reference?.trim()
      ? row.booking_channel_code as RoomStatusSourceCategory
      : null;
  }
  if (row.booking_channel_code === null || row.booking_channel_code === undefined || row.booking_channel_code === "WECOM") return "DIRECT";
  return null;
}

function roomStatusFreeStayCategoryCode(value: string | null | undefined): (typeof freeStayCategoryCodes)[number] | null {
  return value && freeStayCategoryCodeSet.has(value)
    ? value as (typeof freeStayCategoryCodes)[number]
    : null;
}

function roomStatusOrderSourceFields(row: LodgingSourceProjectionRow): LodgingSourceFields {
  const freeStay = row.stay_type === "FREE";
  return {
    sourceCategory: roomStatusSourceCategoryForOrder(row),
    freeStayCategoryCode: freeStay ? roomStatusFreeStayCategoryCode(row.free_stay_category_code) : null,
    freeStayReason: freeStay ? row.free_stay_reason ?? null : null
  };
}

function roomStatusSourceMetadataDamageReason(
  sourceKind: RoomStatusSourceKind,
  row: LodgingSourceProjectionRow,
  options: { allowLegacyHistoricalFreeMetadata: boolean } = { allowLegacyHistoricalFreeMetadata: false }
): string | null {
  const sourceFields = roomStatusOrderSourceFields(row);
  const bookingChannelCode = row.booking_channel_code ?? null;
  const channelReference = normalizedOptionalText(row.channel_order_reference);
  const hasMemberLink = Boolean(row.member_id || row.member_contract_id);
  const hasExternalChannel = bookingChannelCode !== null && externalChannelCodes.has(bookingChannelCode);
  const hasUnknownChannel = bookingChannelCode !== null && bookingChannelCode !== "WECOM" && !hasExternalChannel;
  const hasFreeStayMetadata = row.free_stay_category_code !== null && row.free_stay_category_code !== undefined
    || normalizedOptionalText(row.free_stay_reason) !== null;

  if (sourceKind === "FREE_STAY") {
    if (hasMemberLink || bookingChannelCode !== null || channelReference !== null) {
      return "订单来源类型或免费入住信息无法核对";
    }
    if (sourceFields.sourceCategory !== "FREE_STAY") return "订单来源类型或免费入住信息无法核对";
    if (sourceFields.freeStayCategoryCode === null || !sourceFields.freeStayReason?.trim()) {
      const genuinelyLegacy = row.free_stay_category_code === null || row.free_stay_category_code === undefined;
      return options.allowLegacyHistoricalFreeMetadata && genuinelyLegacy
        ? null
        : "免费入住类型或原因无法核对";
    }
    return null;
  }

  if (hasFreeStayMetadata) return "非免费订单携带了免费入住信息";
  if (hasMemberLink) {
    if (hasExternalChannel || hasUnknownChannel || channelReference !== null) return "会员住宿来源与渠道来源互相矛盾";
    return sourceFields.sourceCategory === "MEMBER" ? null : "会员住宿来源无法核对";
  }
  if (hasExternalChannel) {
    return channelReference !== null ? null : "外部渠道住宿缺少渠道订单号";
  }
  if (hasUnknownChannel) return "订单渠道来源无法识别";
  if (channelReference !== null) return "直订住宿携带了渠道订单号";
  return sourceFields.sourceCategory === "DIRECT" ? null : "订单来源类型无法核对";
}

function roomStatusHistoricalOrderSourceFields(
  sourceKind: RoomStatusSourceKind,
  row: LodgingSourceProjectionRow
): LodgingSourceFields {
  const fields = roomStatusOrderSourceFields(row);
  if (sourceKind === "FREE_STAY"
    && (row.free_stay_category_code === null || row.free_stay_category_code === undefined)
    && roomStatusSourceMetadataDamageReason(sourceKind, row, { allowLegacyHistoricalFreeMetadata: true }) === null
    && fields.freeStayCategoryCode === null) {
    return nullLodgingSourceFields;
  }
  return fields;
}

function dateAfter(serviceDate: string): string {
  const date = new Date(`${serviceDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function isSyntheticInactiveUnitEvent(event: ProjectionEvent): boolean {
  return event.sourceKind === "UNIT_UNSELLABLE"
    && event.sourceKey === `unsellable:${event.actualInventoryUnitId}`;
}

function operationalAttentionForOrder(order: {
  orderStatus: string;
  stayStatus: string;
  arrivalDate: string;
  departureDate: string;
}, businessDate: string): RoomStatusOperationalAttention | null {
  if (order.orderStatus === "RESERVED" && order.stayStatus === "PLANNED" && order.arrivalDate < businessDate) {
    return "OVERDUE_RESERVED";
  }
  if (order.orderStatus === "CHECKED_IN" && order.stayStatus === "IN_HOUSE" && order.departureDate < businessDate) {
    return "OVERDUE_IN_HOUSE";
  }
  if (order.orderStatus === "CHECKED_IN" && order.stayStatus === "IN_HOUSE" && order.departureDate === businessDate) {
    return "DUE_OUT";
  }
  return null;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function primaryOccupantLabel(snapshot: unknown): string | null {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  const guest = snapshot as Record<string, unknown>;
  const nickname = guest.nickname;
  return typeof nickname === "string" && nickname.trim() ? nickname.trim() : null;
}

async function loadProjectedOccupants(
  trx: RoomStatusTransaction,
  orderIds: readonly string[]
): Promise<Map<string, RoomStatusOccupantDto[]>> {
  if (orderIds.length === 0) return new Map();
  const [rows, corrections] = await Promise.all([
    trx.selectFrom("active_order_occupants")
      .select(["id", "order_id", "nickname", "ordinal"])
      .where("order_id", "in", [...orderIds])
      .orderBy("order_id")
      .orderBy("ordinal")
      .execute(),
    trx.selectFrom("order_occupant_corrections")
      .select(["occupant_id", "corrected_nickname", "sequence"])
      .where("order_id", "in", [...orderIds])
      .orderBy("occupant_id")
      .orderBy("sequence")
      .execute()
  ]);
  const latestNickname = new Map<string, string>();
  for (const correction of corrections) latestNickname.set(correction.occupant_id, correction.corrected_nickname);
  const byOrder = new Map<string, RoomStatusOccupantDto[]>();
  for (const row of rows) {
    const occupants = byOrder.get(row.order_id) ?? [];
    occupants.push({ occupantId: row.id, nickname: latestNickname.get(row.id) ?? row.nickname });
    byOrder.set(row.order_id, occupants);
  }
  return byOrder;
}

function validatePageValue(value: number | undefined, fallback: number, field: string, maximum?: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0 || (maximum !== undefined && resolved > maximum)) {
    throw new DomainError("VALIDATION_ERROR", `${field} is outside the supported range`);
  }
  return resolved;
}

function validateFilterText(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > 200) {
    throw new DomainError("VALIDATION_ERROR", `${field} is outside the supported range`);
  }
  return normalized;
}

function validateFilters(options: RoomStatusFilters): RoomStatusFilters {
  const search = validateFilterText(options.search, "search");
  const roomType = validateFilterText(options.roomType, "roomType");
  if (options.salesMode !== undefined && !["WHOLE_ROOM", "BED_SPLIT", "UNAVAILABLE"].includes(options.salesMode)) {
    throw new DomainError("VALIDATION_ERROR", "salesMode is outside the supported vocabulary");
  }
  if (options.status !== undefined && !roomStatusStatuses.includes(options.status)) {
    throw new DomainError("VALIDATION_ERROR", "status is outside the supported vocabulary");
  }
  if (options.unitKind !== undefined && !inventoryUnitKinds.includes(options.unitKind)) {
    throw new DomainError("VALIDATION_ERROR", "unitKind is outside the supported vocabulary");
  }
  if (options.minCapacity !== undefined
    && (!Number.isSafeInteger(options.minCapacity) || options.minCapacity < 1 || options.minCapacity > 1000)) {
    throw new DomainError("VALIDATION_ERROR", "minCapacity is outside the supported range");
  }
  return {
    ...(search !== undefined ? { search } : {}),
    ...(roomType !== undefined ? { roomType } : {}),
    ...(options.salesMode !== undefined ? { salesMode: options.salesMode } : {}),
    ...(options.status !== undefined ? { status: options.status } : {}),
    ...(options.minCapacity !== undefined ? { minCapacity: options.minCapacity } : {}),
    ...(options.unitKind !== undefined ? { unitKind: options.unitKind } : {})
  };
}

function reference(type: RoomStatusReferenceDto["type"], id: string, label: string, href: string | null = null): RoomStatusReferenceDto {
  return { type, id, label, href };
}

function uniqueReferences(items: RoomStatusReferenceDto[]): RoomStatusReferenceDto[] {
  return [...new Map(items.map((item) => [`${item.type}:${item.id}`, item])).values()];
}

function uniqueHistories(items: RoomStatusHistoryDto[]): RoomStatusHistoryDto[] {
  return [...new Map(items.map((item) => [
    `${item.action}:${item.occurredAt}:${item.commandId ?? "none"}:${item.receiptId ?? "none"}`,
    item
  ])).values()];
}

function action(code: RoomStatusActionCode, targetReference: RoomStatusReferenceDto | null, requiresFullInterval = false): RoomStatusActionDto {
  return { code, enabled: true, disabledReason: null, requiresFullInterval, targetReference };
}

function uniqueActions(items: RoomStatusActionDto[]): RoomStatusActionDto[] {
  return [...new Map(items.map((item) => [
    `${item.code}:${item.targetReference?.type ?? "none"}:${item.targetReference?.id ?? "none"}`,
    item
  ])).values()];
}

function roomStatusActionGrant(actionCode: RoomStatusActionCode): CommandCapability | null {
  if (actionCode === "OPEN_ORDER") return null;
  if (actionCode === "CREATE_FREE_STAY" || actionCode === "BACKFILL_ORDER") return "CREATE_ORDER";
  return actionCode as CommandCapability;
}

export function roomStatusActionGranted(
  actionCode: RoomStatusActionCode,
  commandGrants: ReadonlySet<CommandCapability | string> | undefined
): boolean {
  if (actionCode === "COMPLETE_CLEANING" && !currentReleaseFeatures.cleaningWorkflow) return false;
  const grant = roomStatusActionGrant(actionCode);
  if (!grant) return true;
  return commandGrants ? commandGrants.has(grant) : false;
}

function createActions(
  unit: RoomStatusUnitDto,
  accessLevel: AccessLevel,
  availability: { currentOrFuture: boolean; historicalBlank: boolean },
  commandGrants: ReadonlySet<CommandCapability | string> = new Set()
): RoomStatusActionDto[] {
  if (accessLevel !== "WRITE" || !unit.active) return [];
  const target = reference("INVENTORY_UNIT", unit.id, unit.code);
  return [
    ...(availability.currentOrFuture ? [
      action("CREATE_ORDER", target),
      action("CREATE_FREE_STAY", target),
      action("LOCK_MAINTENANCE", target)
    ] : []),
    ...(availability.historicalBlank ? [action("BACKFILL_ORDER", target)] : [])
  ].filter((candidate) => roomStatusActionGranted(candidate.code, commandGrants));
}

function eventActions(
  event: ProjectionEvent,
  accessLevel: AccessLevel,
  commandGrants: ReadonlySet<CommandCapability | string> = new Set()
): RoomStatusActionDto[] {
  if (event.status === "UNKNOWN") return [];
  if ((event.sourceKind === "ORDER" || event.sourceKind === "FREE_STAY")) {
    const order = event.references.find((item) => item.type === "ORDER");
    return order ? [action("OPEN_ORDER", order)] : [];
  }
  if (accessLevel !== "WRITE" || !event.current || !event.targetReference) return [];
  if (event.sourceKind === "MAINTENANCE") return [action("RELEASE_MAINTENANCE", event.targetReference, true)]
    .filter((candidate) => roomStatusActionGranted(candidate.code, commandGrants));
  if (event.sourceKind === "CLEANING") return [action("COMPLETE_CLEANING", event.targetReference)]
    .filter((candidate) => roomStatusActionGranted(candidate.code, commandGrants));
  return [];
}

function intervalActions(
  event: ProjectionEvent,
  accessLevel: AccessLevel,
  startDate: string,
  endDate: string,
  commandGrants: ReadonlySet<CommandCapability | string> = new Set()
): RoomStatusActionDto[] {
  return eventActions(event, accessLevel, commandGrants).map((candidate) => candidate.requiresFullInterval
    && candidate.code !== "RELEASE_MAINTENANCE"
    && (startDate !== event.sourceStartDate || endDate !== event.sourceEndDate)
    ? {
        ...candidate,
        enabled: false,
        disabledReason: `当前窗口只包含来源完整区间 [${event.sourceStartDate}, ${event.sourceEndDate}) 的一部分`
      }
    : candidate);
}

function commandSource(credentialId: string): RoomStatusHistoryDto["source"] {
  if (credentialId.startsWith("session_")) return "WEB_SESSION";
  if (credentialId.startsWith("token_")) return "API_TOKEN";
  return "UNKNOWN";
}

async function loadCommandProjections(
  trx: RoomStatusTransaction,
  commandIds: string[],
  requestingSubjectId: string
): Promise<Map<string, CommandProjection>> {
  if (commandIds.length === 0) return new Map();
  const rows = await trx.selectFrom("command_executions as command")
    .leftJoin("command_receipts as receipt", "receipt.command_id", "command.id")
    .select([
      "command.id",
      "command.subject_id",
      "command.credential_id",
      "command.command_type",
      "command.correlation_id",
      "command.completed_at",
      "command.created_at",
      "receipt.id as receipt_id"
    ])
    .where("command.id", "in", commandIds)
    .execute();
  return new Map(rows.map((row) => {
    const receiptVisible = row.subject_id === requestingSubjectId && row.receipt_id !== null;
    return [row.id, {
      history: {
        action: row.command_type,
        actorId: row.subject_id,
        source: commandSource(row.credential_id),
        occurredAt: iso(row.completed_at ?? row.created_at),
        commandId: row.id,
        receiptId: receiptVisible ? row.receipt_id : null,
        correlationId: row.correlation_id
      },
      receiptReference: receiptVisible
        ? reference("RECEIPT", row.receipt_id!, `Receipt ${row.receipt_id}`, `/api/v1/receipts/${row.receipt_id}`)
        : null
    }];
  }));
}

function attachCommandProjection(event: ProjectionEvent, commands: Map<string, CommandProjection>): ProjectionEvent {
  const commandProjections = event.commandIds.map((id) => commands.get(id)).filter((item): item is CommandProjection => Boolean(item));
  return {
    ...event,
    references: uniqueReferences([
      ...event.references,
      ...commandProjections.flatMap((item) => item.receiptReference ? [item.receiptReference] : [])
    ]),
    histories: uniqueHistories([
      ...event.histories,
      ...commandProjections.map((item) => item.history)
    ])
  };
}

function operationalTaskFromSeed(
  seed: OperationalTaskSeed,
  commands: Map<string, CommandProjection>,
  accessLevel: AccessLevel,
  commandGrants: ReadonlySet<CommandCapability | string> = new Set()
): RoomStatusOperationalTaskDto {
  const event = attachCommandProjection(seed.event, commands);
  const task: RoomStatusOperationalTaskDto = {
    taskKind: seed.taskKind,
    businessDate: seed.businessDate,
    id: `task_${stableHash({ taskKind: seed.taskKind, sourceKey: event.sourceKey, businessDate: seed.businessDate }).slice(0, 24)}`,
    displayInventoryUnitId: event.actualInventoryUnitId,
    actualInventoryUnitId: event.actualInventoryUnitId,
    roomId: event.roomId,
    startDate: seed.startDate,
    endDate: seed.endDate,
    sourceStartDate: event.sourceStartDate,
    sourceEndDate: event.sourceEndDate,
    ...(event.orderArrivalDate ? { orderArrivalDate: event.orderArrivalDate } : {}),
    ...(event.orderDepartureDate ? { orderDepartureDate: event.orderDepartureDate } : {}),
    status: event.status,
    attention: event.attention,
    operationalAttention: event.operationalAttention,
    available: !event.blocking,
    blocking: event.blocking,
    sourceKind: event.sourceKind,
    sourceCategory: (event.sourceKind === "ORDER" || event.sourceKind === "FREE_STAY") && event.status !== "UNKNOWN"
      ? event.sourceCategory ?? null
      : null,
    freeStayCategoryCode: event.status !== "UNKNOWN" ? event.freeStayCategoryCode ?? null : null,
    freeStayReason: event.status !== "UNKNOWN" ? event.freeStayReason ?? null : null,
    label: event.label,
    primaryOccupantLabel: event.primaryOccupantLabel,
    occupantCount: event.occupants?.length ?? 0,
    occupants: event.occupants ?? [],
    reason: event.reason,
    claimIds: event.claimId ? [event.claimId] : [],
    references: uniqueReferences(event.references),
    conflicts: [],
    history: uniqueHistories(event.histories),
    allowedActions: eventActions(event, accessLevel, commandGrants)
  };
  const conflict = conflictFor(task, event.blockingFactKind, {
    startDate: seed.businessDate,
    endDate: dateAfter(seed.businessDate)
  });
  if (conflict) task.conflicts.push(conflict);
  return task;
}

function intervalGroupKey(event: ProjectionEvent, displayInventoryUnitId: string): string {
  return [
    displayInventoryUnitId,
    event.actualInventoryUnitId,
    event.sourceKind,
    event.sourceCategory ?? "no-source-category",
    event.freeStayCategoryCode ?? "no-free-stay-category",
    event.freeStayReason ?? "no-free-stay-reason",
    event.orderArrivalDate ?? "no-order-arrival",
    event.orderDepartureDate ?? "no-order-departure",
    event.sourceKey,
    event.status,
    event.attention ?? "no-attention",
    event.operationalAttention ?? "no-operational-attention",
    event.blocking ? "blocking" : "nonblocking",
    event.blockingFactKind ?? "no-blocking-fact",
    event.current ? "current" : "history"
  ].join(":");
}

function addBuilderItem(builder: IntervalBuilder, event: ProjectionEvent): void {
  builder.lastDate = event.serviceDate;
  if (event.claimId) {
    if (!builder.claimIds.includes(event.claimId)) builder.claimIds.push(event.claimId);
    const dayClaims = builder.claimIdsByServiceDate.get(event.serviceDate) ?? [];
    if (!dayClaims.includes(event.claimId)) dayClaims.push(event.claimId);
    builder.claimIdsByServiceDate.set(event.serviceDate, dayClaims);
  }
  builder.references.push(...event.references);
  builder.histories.push(...event.histories);
}

function conflictFor(
  interval: RoomStatusIntervalDto,
  blockingFactKind: RoomStatusBlockingFactKind | null,
  range: { startDate: string; endDate: string } = interval
): RoomStatusConflictDto | null {
  if (!interval.blocking) {
    if (blockingFactKind !== null) throw new DomainError("VALIDATION_ERROR", "nonblocking room-status event cannot expose a blocking fact");
    return null;
  }
  if (!blockingFactKind) throw new DomainError("VALIDATION_ERROR", "blocking room-status event is missing its explicit blocking fact kind");
  if (blockingFactKind === "CLAIM" && interval.claimIds.length === 0) {
    throw new DomainError("VALIDATION_ERROR", "Claim-backed room-status conflict is missing its Claim ID");
  }
  if (blockingFactKind !== "CLAIM" && interval.claimIds.length > 0) {
    throw new DomainError("VALIDATION_ERROR", "non-Claim room-status conflict cannot expose a Claim ID");
  }
  const sourceReference = blockingFactKind === "UNIT_UNSELLABLE"
    ? interval.references.find((item) => item.type === "INVENTORY_UNIT")
    : blockingFactKind === "DUE_OUT" || blockingFactKind === "LODGING_ORDER" || blockingFactKind === "OVERDUE_IN_HOUSE"
      ? interval.references.find((item) => item.type === "ORDER")
      : interval.references.find((item) => item.type !== "CLAIM")
        ?? interval.references.find((item) => item.type === "CLAIM");
  if (!sourceReference) throw new DomainError("VALIDATION_ERROR", "room-status conflict is missing its stable source reference");
  return {
    id: `conflict_${stableHash({
      intervalId: interval.id,
      requestedInventoryUnitId: interval.displayInventoryUnitId,
      actualInventoryUnitId: interval.actualInventoryUnitId,
      blockingFactKind
    }).slice(0, 24)}`,
    blockingFactKind,
    claimId: interval.claimIds[0] ?? null,
    claimIds: interval.claimIds,
    requestedInventoryUnitId: interval.displayInventoryUnitId,
    actualInventoryUnitId: interval.actualInventoryUnitId,
    roomId: interval.roomId,
    startDate: range.startDate,
    endDate: range.endDate,
    sourceKind: interval.sourceKind,
    sourceReference,
    reason: interval.reason ?? interval.label,
    blocking: true
  };
}

function conflictForDay(conflict: RoomStatusConflictDto, serviceDate: string, claimId: string | null): RoomStatusConflictDto {
  return {
    ...conflict,
    id: `conflict_${stableHash({ conflictId: conflict.id, serviceDate, blockingFactKind: conflict.blockingFactKind, claimId }).slice(0, 24)}`,
    claimId,
    claimIds: claimId ? [claimId] : [],
    startDate: serviceDate,
    endDate: dateAfter(serviceDate)
  };
}

function buildIntervals(
  events: ProjectionEvent[],
  unitsById: Map<string, RoomStatusUnitDto>,
  displayUnitsById: Map<string, RoomStatusUnitDto>,
  accessLevel: AccessLevel,
  commandGrants: ReadonlySet<CommandCapability | string> = new Set()
): BuiltIntervals {
  const expanded = events.flatMap((event) => {
    const actual = unitsById.get(event.actualInventoryUnitId);
    if (!actual || !displayUnitsById.has(actual.id)) return [];
    const displayIds = new Set([actual.id]);
    if (actual.kind === "BED" && actual.parentRoomId) displayIds.add(actual.parentRoomId);
    if (actual.kind === "ROOM") actual.childUnitIds.forEach((id) => displayIds.add(id));
    return [...displayIds].filter((id) => displayUnitsById.has(id))
      .map((displayInventoryUnitId) => ({ event, displayInventoryUnitId }));
  }).sort((left, right) => {
    const keyOrder = intervalGroupKey(left.event, left.displayInventoryUnitId)
      .localeCompare(intervalGroupKey(right.event, right.displayInventoryUnitId));
    return keyOrder || left.event.serviceDate.localeCompare(right.event.serviceDate);
  });

  const builders: IntervalBuilder[] = [];
  for (const item of expanded) {
    const key = intervalGroupKey(item.event, item.displayInventoryUnitId);
    const current = builders.at(-1);
    if (current
      && intervalGroupKey(current.event, current.displayInventoryUnitId) === key
      && (current.lastDate === item.event.serviceDate
        || dateAfter(current.lastDate) === item.event.serviceDate)) {
      addBuilderItem(current, item.event);
      continue;
    }
    builders.push({
      event: item.event,
      displayInventoryUnitId: item.displayInventoryUnitId,
      startDate: item.event.serviceDate,
      lastDate: item.event.serviceDate,
      claimIds: item.event.claimId ? [item.event.claimId] : [],
      claimIdsByServiceDate: new Map(item.event.claimId ? [[item.event.serviceDate, [item.event.claimId]]] : []),
      references: [...item.event.references],
      histories: [...item.event.histories]
    });
  }

  const byUnit = new Map<string, RoomStatusIntervalDto[]>();
  const claimIdsByIntervalAndDate = new Map<string, Map<string, string[]>>();
  for (const builder of builders) {
    const endDate = dateAfter(builder.lastDate);
    const id = `interval_${stableHash({
      displayInventoryUnitId: builder.displayInventoryUnitId,
      actualInventoryUnitId: builder.event.actualInventoryUnitId,
      sourceKey: builder.event.sourceKey,
      startDate: builder.startDate,
      endDate
    }).slice(0, 24)}`;
    const interval: RoomStatusIntervalDto = {
      id,
      displayInventoryUnitId: builder.displayInventoryUnitId,
      actualInventoryUnitId: builder.event.actualInventoryUnitId,
      roomId: builder.event.roomId,
      startDate: builder.startDate,
      endDate,
      sourceStartDate: builder.event.sourceStartDate,
      sourceEndDate: builder.event.sourceEndDate,
      ...(builder.event.orderArrivalDate ? { orderArrivalDate: builder.event.orderArrivalDate } : {}),
      ...(builder.event.orderDepartureDate ? { orderDepartureDate: builder.event.orderDepartureDate } : {}),
      status: builder.event.status,
      attention: builder.event.attention,
      operationalAttention: builder.event.operationalAttention,
      available: !builder.event.blocking,
      blocking: builder.event.blocking,
      sourceKind: builder.event.sourceKind,
      sourceCategory: (builder.event.sourceKind === "ORDER" || builder.event.sourceKind === "FREE_STAY") && builder.event.status !== "UNKNOWN"
        ? builder.event.sourceCategory ?? null
        : null,
      freeStayCategoryCode: builder.event.status !== "UNKNOWN" ? builder.event.freeStayCategoryCode ?? null : null,
      freeStayReason: builder.event.status !== "UNKNOWN" ? builder.event.freeStayReason ?? null : null,
      label: builder.event.label,
      primaryOccupantLabel: builder.event.primaryOccupantLabel,
      occupantCount: builder.event.occupants?.length ?? 0,
      occupants: builder.event.occupants ?? [],
      reason: builder.event.reason,
      claimIds: [...new Set(builder.claimIds)],
      references: uniqueReferences(builder.references),
      conflicts: [],
      history: uniqueHistories(builder.histories),
      allowedActions: intervalActions(builder.event, accessLevel, builder.startDate, endDate, commandGrants)
    };
    const conflict = conflictFor(interval, builder.event.blockingFactKind);
    if (conflict) interval.conflicts.push(conflict);
    claimIdsByIntervalAndDate.set(id, builder.claimIdsByServiceDate);
    const list = byUnit.get(builder.displayInventoryUnitId) ?? [];
    list.push(interval);
    byUnit.set(builder.displayInventoryUnitId, list);
  }
  return { byUnit, claimIdsByIntervalAndDate };
}

function buildBedOccupancies(
  events: ProjectionEvent[],
  unitsById: Map<string, RoomStatusUnitDto>,
  displayUnitsById: Map<string, RoomStatusUnitDto>,
  dates: string[]
): BuiltBedOccupancies {
  const dateSet = new Set(dates);
  const eventsByRoomAndDate = new Map<string, ProjectionEvent[]>();
  for (const event of events) {
    if (!dateSet.has(event.serviceDate)) continue;
    const actualUnit = unitsById.get(event.actualInventoryUnitId);
    if (actualUnit && !displayUnitsById.has(actualUnit.id)) continue;
    const roomId = actualUnit?.kind === "BED"
      ? actualUnit.parentRoomId
      : actualUnit?.kind === "ROOM"
        ? actualUnit.id
        : event.roomId;
    if (!roomId || !displayUnitsById.has(roomId)) continue;
    const key = `${roomId}:${event.serviceDate}`;
    const dayEvents = eventsByRoomAndDate.get(key) ?? [];
    dayEvents.push(event);
    eventsByRoomAndDate.set(key, dayEvents);
  }

  const byRoom = new Map<string, RoomStatusBedOccupancyDto[]>();
  let partial = false;
  for (const room of displayUnitsById.values()) {
    if (room.kind !== "ROOM" || room.salesMode !== "BED_SPLIT") continue;
    const uniqueChildIds = [...new Set(room.childUnitIds)];
    const children = uniqueChildIds.map((id) => displayUnitsById.get(id));
    const activeChildOccupancyCapacity = children.reduce((total, child) => total + (child?.occupancyCapacity ?? 0), 0);
    const catalogClosed = uniqueChildIds.length > 0
      && uniqueChildIds.length === room.childUnitIds.length
      && uniqueChildIds.length === room.capacity
      && room.occupancyCapacity === room.capacity
      && activeChildOccupancyCapacity === room.occupancyCapacity
      && children.every((child) => child?.kind === "BED"
        && child.parentRoomId === room.id
        && child.roomId === room.id);
    if (!catalogClosed) {
      partial = true;
      byRoom.set(room.id, []);
      continue;
    }

    const childIds = new Set(uniqueChildIds);
    const occupancies: RoomStatusBedOccupancyDto[] = [];
    for (const serviceDate of dates) {
      const dayEvents = eventsByRoomAndDate.get(`${room.id}:${serviceDate}`) ?? [];
      const childEvents = dayEvents.filter((event) => childIds.has(event.actualInventoryUnitId));
      const hasAmbiguousUnknownFact = dayEvents.some((event) => event.blocking
        && event.status === "UNKNOWN"
        && event.sourceKind !== "UNIT_UNSELLABLE");
      const parentLodgingEvents = dayEvents.filter((event) => event.actualInventoryUnitId === room.id
        && (event.blocking || event.status === "SETTLED" || event.status === "ARREARS")
        && (event.sourceKind === "ORDER" || event.sourceKind === "FREE_STAY")
        && (event.status === "RESERVED" || event.status === "IN_HOUSE" || event.status === "SETTLED" || event.status === "ARREARS"));
      const validChildLodgingEvents = childEvents.filter((event) => (event.blocking || event.status === "SETTLED" || event.status === "ARREARS")
        && (event.sourceKind === "ORDER" || event.sourceKind === "FREE_STAY")
        && (event.status === "RESERVED" || event.status === "IN_HOUSE" || event.status === "SETTLED" || event.status === "ARREARS"));

      if (hasAmbiguousUnknownFact) {
        partial = true;
        continue;
      }
      if (parentLodgingEvents.length > 0) {
        if (parentLodgingEvents.length > 1 || validChildLodgingEvents.length > 0) partial = true;
        continue;
      }

      const eventsByBed = new Map<string, ProjectionEvent[]>();
      for (const event of validChildLodgingEvents) {
        const bedEvents = eventsByBed.get(event.actualInventoryUnitId) ?? [];
        bedEvents.push(event);
        eventsByBed.set(event.actualInventoryUnitId, bedEvents);
      }
      if ([...eventsByBed.values()].some((bedEvents) => bedEvents.length !== 1)) {
        partial = true;
        continue;
      }

      let invalidReference = false;
      const occupants = [...eventsByBed.entries()].map(([inventoryUnitId, [event]]) => {
        const unit = displayUnitsById.get(inventoryUnitId)!;
        const projectedOccupant = event!.occupants?.[0];
        const sourceReference = event!.references.find(
          (item): item is RoomStatusReferenceDto & { type: "ORDER" } => item.type === "ORDER"
        );
        if (!sourceReference || !projectedOccupant || event!.occupants?.length !== 1) invalidReference = true;
        return sourceReference && projectedOccupant ? {
          occupantId: projectedOccupant.occupantId,
          inventoryUnitId,
          inventoryUnitCode: unit.code,
          primaryOccupantLabel: projectedOccupant.nickname,
          sourceReference
        } : null;
      }).filter((occupant): occupant is NonNullable<typeof occupant> => occupant !== null)
        .sort((left, right) => left.inventoryUnitCode.localeCompare(right.inventoryUnitCode)
          || left.inventoryUnitId.localeCompare(right.inventoryUnitId));
      if (invalidReference) {
        partial = true;
        continue;
      }
      const occupiedOrderIds = occupants.map((occupant) => occupant.sourceReference.id);
      if (new Set(occupiedOrderIds).size !== occupiedOrderIds.length) {
        partial = true;
        continue;
      }
      if (occupants.length > 0) {
        occupancies.push({
          serviceDate,
          occupiedBedCount: occupants.length,
          totalBedCount: uniqueChildIds.length,
          occupants
        });
      }
    }
    byRoom.set(room.id, occupancies);
  }
  return { byRoom, partial };
}

function buildBedSlotStates(
  events: ProjectionEvent[],
  displayUnitsById: Map<string, RoomStatusUnitDto>,
  dates: string[],
  businessDate: string
): BuiltBedSlotStates {
  const eventsByUnitAndDate = new Map<string, ProjectionEvent[]>();
  for (const event of events) {
    if (isSyntheticInactiveUnitEvent(event)) continue;
    const key = `${event.actualInventoryUnitId}:${event.serviceDate}`;
    const dayEvents = eventsByUnitAndDate.get(key) ?? [];
    dayEvents.push(event);
    eventsByUnitAndDate.set(key, dayEvents);
  }

  const byRoom = new Map<string, RoomStatusBedSlotStateDto[]>();
  let partial = false;
  for (const room of displayUnitsById.values()) {
    if (room.kind !== "ROOM" || room.salesMode !== "BED_SPLIT") continue;
    const childUnits = room.childUnitIds
      .map((childId) => displayUnitsById.get(childId))
      .filter((child): child is RoomStatusUnitDto => child?.kind === "BED" && child.parentRoomId === room.id)
      .sort((left, right) => left.code.localeCompare(right.code) || left.id.localeCompare(right.id));
    if (childUnits.length !== new Set(room.childUnitIds).size
      || (room.physicalBedCount !== null && childUnits.length !== room.physicalBedCount)) {
      partial = true;
    }

    const states: RoomStatusBedSlotStateDto[] = [];
    for (const serviceDate of dates) {
      const parentEvents = eventsByUnitAndDate.get(`${room.id}:${serviceDate}`) ?? [];
      for (const child of childUnits) {
        const candidates = [
          ...(eventsByUnitAndDate.get(`${child.id}:${serviceDate}`) ?? []),
          ...parentEvents
        ];
        const facts = [...new Map(candidates.map((event) => [
          `${event.sourceKind}:${event.sourceKey}:${event.status}:${event.blocking ? "blocking" : "nonblocking"}`,
          event
        ])).values()];

        let status: RoomStatusStatus;
        if (facts.some((event) => event.status === "UNKNOWN") || facts.length > 1) {
          status = "UNKNOWN";
          partial = true;
        } else if (!child.active && serviceDate >= businessDate && facts.some((event) => event.current)) {
          status = "UNKNOWN";
          partial = true;
        } else if (facts[0]) {
          status = facts[0].status;
        } else {
          status = child.active ? "AVAILABLE" : "UNAVAILABLE";
        }
        states.push({
          serviceDate,
          inventoryUnitId: child.id,
          inventoryUnitCode: child.code,
          status
        });
      }
    }
    byRoom.set(room.id, states);
  }
  return { byRoom, partial };
}

function dayStatus(intervals: RoomStatusIntervalDto[], unitActive: boolean): RoomStatusStatus {
  if (!unitActive) return "UNAVAILABLE";
  const current = intervals.filter((interval) => interval.blocking
    || interval.sourceKind === "CLEANING"
    || interval.status === "SETTLED"
    || interval.status === "ARREARS"
    || interval.status === "UNKNOWN");
  if (current.some((interval) => interval.status === "UNKNOWN")) return "UNKNOWN";
  const priority: RoomStatusStatus[] = ["UNAVAILABLE", "IN_HOUSE", "RESERVED", "ARREARS", "SETTLED", "MAINTENANCE", "CLEANING"];
  return priority.find((status) => current.some((interval) => interval.status === status)) ?? "AVAILABLE";
}

function buildUnitStatuses(
  unitsById: Map<string, RoomStatusUnitDto>,
  dates: string[],
  intervalsByUnit: Map<string, RoomStatusIntervalDto[]>,
  businessDate: string
): Map<string, Set<RoomStatusStatus>> {
  const statusesByUnit = new Map<string, Set<RoomStatusStatus>>();
  for (const unit of unitsById.values()) {
    const intervals = intervalsByUnit.get(unit.id) ?? [];
    const statuses = new Set<RoomStatusStatus>();
    for (const serviceDate of dates) {
      const dayIntervals = intervals.filter((interval) => interval.startDate <= serviceDate && serviceDate < interval.endDate);
      const status = dayStatus(dayIntervals, unit.active);
      if (serviceDate < businessDate && status === "AVAILABLE" && dayIntervals.length === 0) continue;
      statuses.add(status);
    }
    statusesByUnit.set(unit.id, statuses);
  }
  return statusesByUnit;
}

function unitAvailableOnDate(
  unit: RoomStatusUnitDto,
  serviceDate: string,
  intervalsByUnit: Map<string, RoomStatusIntervalDto[]>,
  businessDate: string
): boolean {
  if (serviceDate < businessDate) return false;
  if (!unit.active) return false;
  const intervals = intervalsByUnit.get(unit.id) ?? [];
  const dayIntervals = intervals.filter((interval) => interval.startDate <= serviceDate && serviceDate < interval.endDate);
  return !dayIntervals.some((interval) => interval.blocking || interval.status === "UNKNOWN");
}

function buildAvailabilitySummary(
  rooms: RoomStatusUnitDto[],
  unitsById: Map<string, RoomStatusUnitDto>,
  dates: string[],
  intervalsByUnit: Map<string, RoomStatusIntervalDto[]>,
  businessDate: string
): RoomStatusAvailabilitySummaryDto[] {
  let totalSellableUnits = 0;
  for (const room of rooms) {
    if (!room.active) continue;
    if (room.salesMode === "WHOLE_ROOM") {
      totalSellableUnits += 1;
      continue;
    }
    if (room.salesMode !== "BED_SPLIT") continue;
    totalSellableUnits += room.childUnitIds.filter((childId) => unitsById.get(childId)?.active).length;
  }
  return dates.map((serviceDate) => {
    let availableRooms = 0;
    let availableBeds = 0;
    const paidOccupiedSources = new Map<string, number>();
    const occupantIds = new Set<string>();
    for (const room of rooms) {
      if (room.salesMode === "WHOLE_ROOM") {
        if (unitAvailableOnDate(room, serviceDate, intervalsByUnit, businessDate)) availableRooms += 1;
        continue;
      }
      if (room.salesMode !== "BED_SPLIT" || !room.active) continue;
      for (const childId of room.childUnitIds) {
        const child = unitsById.get(childId);
        if (child && unitAvailableOnDate(child, serviceDate, intervalsByUnit, businessDate)) availableBeds += 1;
      }
    }
    for (const intervals of intervalsByUnit.values()) {
      for (const interval of intervals) {
        if (interval.startDate > serviceDate || serviceDate >= interval.endDate) continue;
        if (interval.sourceKind !== "ORDER") continue;
        if (interval.status !== "IN_HOUSE"
          && interval.status !== "RESERVED"
          && interval.status !== "SETTLED"
          && interval.status !== "ARREARS") continue;
        const orderReferenceId = interval.references.find((reference) => reference.type === "ORDER")?.id ?? interval.id;
        const stayReferenceId = interval.references.find((reference) => reference.type === "STAY")?.id ?? "none";
        const paidSourceKey = `${orderReferenceId}:${stayReferenceId}:${interval.actualInventoryUnitId}`;
        if (!paidOccupiedSources.has(paidSourceKey)) {
          const actualUnit = unitsById.get(interval.actualInventoryUnitId);
          const sellableUnitCount = actualUnit?.kind === "ROOM" && actualUnit.salesMode === "BED_SPLIT"
            ? Math.max(1, actualUnit.childUnitIds.filter((childId) => unitsById.get(childId)?.active).length)
            : 1;
          paidOccupiedSources.set(paidSourceKey, sellableUnitCount);
        }
        for (const occupant of interval.occupants) occupantIds.add(occupant.occupantId);
      }
    }
    return {
      serviceDate,
      availableRooms,
      availableBeds,
      paidOccupiedUnits: [...paidOccupiedSources.values()].reduce((total, count) => total + count, 0),
      totalSellableUnits,
      occupantCount: occupantIds.size
    };
  });
}

function assembleUnit(
  unit: RoomStatusUnitDto,
  dates: string[],
  intervals: RoomStatusIntervalDto[],
  claimIdsByIntervalAndDate: Map<string, Map<string, string[]>>,
  accessLevel: AccessLevel,
  businessDate: string,
  commandGrants?: ReadonlySet<CommandCapability | string>
): RoomStatusUnitDto {
  const unitConflicts = intervals.flatMap((interval) => interval.conflicts);
  const days = dates.map((serviceDate) => {
    const dayIntervals = intervals.filter((interval) => interval.startDate <= serviceDate && serviceDate < interval.endDate);
    const blocking = dayIntervals.some((interval) => interval.blocking);
    const unknown = dayIntervals.some((interval) => interval.status === "UNKNOWN");
    const available = unit.active && serviceDate >= businessDate && !blocking && !unknown;
    const conflicts = dayIntervals.flatMap((interval) => {
      const exactClaimIds = claimIdsByIntervalAndDate.get(interval.id)?.get(serviceDate) ?? [];
      return interval.conflicts.flatMap((conflict) => conflict.blockingFactKind === "CLAIM"
        ? exactClaimIds.map((claimId) => conflictForDay(conflict, serviceDate, claimId))
        : [conflictForDay(conflict, serviceDate, null)]);
    });
    return {
      serviceDate,
      status: dayStatus(dayIntervals, unit.active),
      available,
      intervalIds: dayIntervals.map((interval) => interval.id),
      conflicts
    };
  });
  return {
    ...unit,
    days,
    intervals,
    conflicts: unitConflicts,
    allowedActions: uniqueActions([
      ...createActions(unit, accessLevel, {
        currentOrFuture: days.some((day) => day.available),
        historicalBlank: days.some((day) => day.serviceDate < businessDate
          && day.status === "AVAILABLE"
          && day.intervalIds.length === 0
          && day.conflicts.length === 0)
      }, commandGrants),
      ...intervals.flatMap((interval) => interval.allowedActions)
    ])
  };
}

function normalizedSearchText(value: string): string {
  return value.toLocaleUpperCase("zh-CN");
}

function unitMatchesFilters(
  unit: RoomStatusUnitDto,
  room: RoomStatusUnitDto,
  filters: RoomStatusFilters,
  statusesByUnit: Map<string, Set<RoomStatusStatus>>
): boolean {
  if (filters.search) {
    const searchText = [
      room.code,
      room.name,
      room.buildingCode,
      room.roomTypeCode,
      room.pricingProductCode,
      unit.code,
      unit.name,
      unit.buildingCode,
      unit.roomTypeCode,
      unit.pricingProductCode
    ].filter((value): value is string => Boolean(value)).join(" ");
    if (!normalizedSearchText(searchText).includes(normalizedSearchText(filters.search))) return false;
  }
  if (filters.roomType && (unit.roomTypeCode ?? room.roomTypeCode) !== filters.roomType) return false;
  if (filters.salesMode && room.salesMode !== filters.salesMode) return false;
  if (filters.status && !statusesByUnit.get(unit.id)?.has(filters.status)) return false;
  if (filters.minCapacity !== undefined && room.capacity < filters.minCapacity) return false;
  if (filters.unitKind && unit.kind !== filters.unitKind) return false;
  return true;
}

function filterRoomSelections(
  rooms: RoomStatusUnitDto[],
  unitsById: Map<string, RoomStatusUnitDto>,
  filters: RoomStatusFilters,
  statusesByUnit: Map<string, Set<RoomStatusStatus>>
): FilteredRoomSelection[] {
  return rooms.flatMap((room) => {
    const childUnitIds = room.childUnitIds.filter((childId) => {
      const child = unitsById.get(childId);
      return child ? unitMatchesFilters(child, room, filters, statusesByUnit) : false;
    });
    if (!unitMatchesFilters(room, room, filters, statusesByUnit) && childUnitIds.length === 0) return [];
    return [{ room, childUnitIds }];
  });
}

function roomStatusFilterOptions(
  rooms: RoomStatusUnitDto[],
  unitsById: Map<string, RoomStatusUnitDto>,
  statusesByUnit: Map<string, Set<RoomStatusStatus>>
): RoomStatusFilterOptionsDto {
  const units = [...unitsById.values()];
  const salesModeOrder: RoomStatusUnitDto["salesMode"][] = ["WHOLE_ROOM", "BED_SPLIT", "UNAVAILABLE"];
  return {
    roomTypeCodes: [...new Set(rooms.flatMap((room) => room.roomTypeCode ? [room.roomTypeCode] : []))].sort(),
    salesModes: salesModeOrder.filter((salesMode) => rooms.some((room) => room.salesMode === salesMode)),
    statuses: roomStatusStatuses.filter((status) => units.some((unit) => statusesByUnit.get(unit.id)?.has(status))),
    capacities: [...new Set(rooms.map((room) => room.capacity).filter((capacity) => capacity > 0))]
      .sort((left, right) => left - right),
    unitKinds: inventoryUnitKinds.filter((kind) => units.some((unit) => unit.kind === kind))
  };
}

export async function bumpRoomStatusRevision(trx: RoomStatusTransaction, propertyId: string): Promise<string> {
  const row = await trx.insertInto("room_status_revisions")
    .values({ property_id: propertyId, revision: 1, updated_at: new Date() })
    .onConflict((conflict) => conflict.column("property_id").doUpdateSet({
      revision: sql`room_status_revisions.revision + 1`,
      updated_at: new Date()
    }))
    .returning("revision")
    .executeTakeFirstOrThrow();
  return String(row.revision);
}

export async function getRoomStatusBoard(db: Kysely<Database>, options: {
  propertyId: string;
  arrivalDate: string;
  departureDate: string;
  accessLevel: AccessLevel;
  commandGrants: ReadonlySet<CommandCapability | string>;
  requestingSubjectId: string;
  page?: number;
  pageSize?: number;
  search?: string;
  roomType?: string;
  salesMode?: RoomStatusUnitDto["salesMode"];
  status?: RoomStatusStatus;
  minCapacity?: number;
  unitKind?: RoomStatusUnitDto["kind"];
}): Promise<RoomStatusBoardDto> {
  const dates = enumerateServiceDates(options.arrivalDate, options.departureDate);
  if (dates.length > ROOM_STATUS_MAX_QUERY_NIGHTS) {
    throw new DomainError("VALIDATION_ERROR", `room-status supports at most ${ROOM_STATUS_MAX_QUERY_NIGHTS} nights`);
  }
  const page = validatePageValue(options.page, 0, "page");
  const pageSize = validatePageValue(options.pageSize, DEFAULT_PAGE_SIZE, "pageSize", MAX_PAGE_SIZE);
  if (pageSize === 0) throw new DomainError("VALIDATION_ERROR", "pageSize must be at least 1");
  const filters = validateFilters(options);

  return db.transaction().setIsolationLevel("repeatable read").execute(async (trx) => {
    await sql`set transaction read only`.execute(trx);
    const property = await trx.selectFrom("properties as property")
      .leftJoin("room_status_revisions as room_status_revision", "room_status_revision.property_id", "property.id")
      .select([
        "property.id",
        "property.timezone",
        "room_status_revision.revision",
        sql<Date>`transaction_timestamp()`.as("as_of")
      ])
      .where("property.id", "=", options.propertyId)
      .executeTakeFirst();
    if (!property) throw new DomainError("NOT_FOUND", "Property not found", 404);
    const asOf = iso(property.as_of);
    const freshUntil = new Date(new Date(asOf).getTime() + 5_000).toISOString();
    const businessDate = propertyLocalClockAt(property.timezone, new Date(asOf)).date;

    const inventoryRows = await projectCatalogUnitNames(trx, await trx.selectFrom("inventory_units")
      .selectAll()
      .where("property_id", "=", options.propertyId)
      .where("kind", "in", ["ROOM", "BED"])
      .orderBy("code")
      .execute());
    const roomRows = inventoryRows.filter((unit) => unit.kind === "ROOM");
    const bedRows = inventoryRows.filter((unit) => unit.kind === "BED");

    const operationalOrderCandidates = await trx.selectFrom("orders as order")
      .select("order.id")
      .where("order.property_id", "=", options.propertyId)
      .where((expression) => expression.or([
        expression.and([
          expression("order.status", "=", "RESERVED"),
          expression("order.arrival_date", "<=", businessDate)
        ]),
        expression.and([
          expression("order.status", "=", "CHECKED_IN"),
          expression("order.arrival_date", "<=", businessDate)
        ])
      ]))
      .orderBy("order.id")
      .limit(ROOM_STATUS_OPERATIONAL_TASK_LIMIT + 1)
      .execute();
    const operationalOrdersTruncated = operationalOrderCandidates.length > ROOM_STATUS_OPERATIONAL_TASK_LIMIT;
    const operationalOrderIds = operationalOrderCandidates
      .slice(0, ROOM_STATUS_OPERATIONAL_TASK_LIMIT)
      .map((row) => row.id);
    const operationalOrderRows = operationalOrderIds.length === 0 ? [] : await trx.selectFrom("orders as order")
      .innerJoin("stays as stay", "stay.order_id", "order.id")
      .innerJoin("stay_segments as segment", "segment.stay_id", "stay.id")
      .leftJoin("inventory_claims as operational_claim", (join) => join
        .on((expression) => expression("operational_claim.source_id", "in", expression
          .selectFrom("stay_segments as claim_segment")
          .select("claim_segment.id")
          .whereRef("claim_segment.stay_id", "=", "segment.stay_id")))
        .on("operational_claim.source_type", "=", "ORDER_SEGMENT")
        .on("operational_claim.service_date", "=", businessDate)
        .on("operational_claim.active", "=", true))
      .innerJoin("inventory_units as unit", "unit.id", "segment.inventory_unit_id")
      .leftJoin("amendments as amendment", "amendment.id", "segment.amendment_id")
      .select([
        "order.id as order_id", "order.status as order_status", "order.stay_type", "order.arrival_date as order_arrival_date",
        "order.departure_date as order_departure_date", "order.primary_guest_snapshot",
        "order.member_id", "order.member_contract_id", "order.booking_channel_code", "order.channel_order_reference",
        "order.free_stay_category_code", "order.free_stay_reason",
        "stay.id as stay_id", "stay.status as stay_status", "segment.id as segment_id", "segment.sequence as segment_sequence",
        "segment.arrival_date as segment_arrival_date", "segment.departure_date as segment_departure_date",
        "segment.inventory_unit_id", "segment.created_at as segment_created_at", "amendment.command_id as segment_command_id",
        "unit.parent_room_id", "unit.code as unit_code", "unit.name as unit_name",
        "operational_claim.id as operational_claim_id"
      ])
      .where("order.property_id", "=", options.propertyId)
      .where("order.id", "in", operationalOrderIds)
      .orderBy("order.id")
      .orderBy("segment.sequence")
      .execute();
    const claimRows = await trx.selectFrom("inventory_claims as claim")
      .leftJoin("stay_segments as segment", (join) => join
        .onRef("segment.id", "=", "claim.source_id")
        .on("claim.source_type", "=", "ORDER_SEGMENT"))
      .leftJoin("stays as stay", "stay.id", "segment.stay_id")
      .leftJoin("orders as order", "order.id", "stay.order_id")
      .leftJoin("amendments as amendment", "amendment.id", "segment.amendment_id")
      .leftJoin("maintenance_locks as maintenance", (join) => join
        .onRef("maintenance.id", "=", "claim.source_id")
        .on("claim.source_type", "=", "MAINTENANCE"))
      .leftJoin("internal_use_blocks as internal", (join) => join
        .onRef("internal.id", "=", "claim.source_id")
        .on("claim.source_type", "=", "INTERNAL_USE"))
      .select([
        "claim.id as claim_id", "claim.room_id", "claim.inventory_unit_id", "claim.service_date",
        "claim.source_type", "claim.source_id", "claim.active", "claim.created_at", "claim.released_at",
        "segment.id as segment_id", "segment.stay_id", "segment.segment_type",
        "segment.arrival_date as segment_arrival_date", "segment.departure_date as segment_departure_date",
        "segment.created_at as segment_created_at",
        "stay.status as stay_status", "order.id as order_id", "order.status as order_status", "order.stay_type",
        "order.arrival_date as order_arrival_date", "order.departure_date as order_departure_date", "order.primary_guest_snapshot",
        "order.member_id", "order.member_contract_id", "order.booking_channel_code", "order.channel_order_reference",
        "order.current_revision_id",
        sql<string | null>`to_jsonb("order") ->> 'free_stay_category_code'`.as("free_stay_category_code"),
        sql<string | null>`to_jsonb("order") ->> 'free_stay_reason'`.as("free_stay_reason"),
        "amendment.command_id as segment_command_id",
        "maintenance.id as maintenance_id", "maintenance.arrival_date as maintenance_arrival_date",
        "maintenance.departure_date as maintenance_departure_date", "maintenance.reason as maintenance_reason", "maintenance.status as maintenance_status",
        "maintenance.created_by_command_id as maintenance_created_command_id",
        "maintenance.released_by_command_id as maintenance_released_command_id",
        "internal.id as internal_id", "internal.arrival_date as internal_arrival_date",
        "internal.departure_date as internal_departure_date", "internal.reason as internal_reason", "internal.status as internal_status",
        "internal.created_by_command_id as internal_created_command_id",
        "internal.released_by_command_id as internal_released_command_id"
      ])
      .where("claim.property_id", "=", options.propertyId)
      .where((expression) => expression.or([
        expression("claim.service_date", "=", businessDate),
        expression.and([
          expression("claim.service_date", ">=", options.arrivalDate),
          expression("claim.service_date", "<", options.departureDate)
        ])
      ]))
      .orderBy("claim.service_date")
      .orderBy("claim.id")
      .execute();

    const occupantOrderIds = [...new Set([...operationalOrderIds, ...claimRows.flatMap((row) => row.order_id ? [row.order_id] : [])])];
    const occupantsByOrder = await loadProjectedOccupants(trx, occupantOrderIds);

    const operationalOrderGroups = new Map<string, typeof operationalOrderRows>();
    for (const row of operationalOrderRows) {
      const rows = operationalOrderGroups.get(row.order_id) ?? [];
      rows.push(row);
      operationalOrderGroups.set(row.order_id, rows);
    }
    const operationalTaskSeeds: OperationalTaskSeed[] = [];
    const syntheticOccupancyEvents: ProjectionEvent[] = [];
    let partial = false;
    let missingOperationalClaim = false;
    let inconsistentOperationalLifecycle = false;
    for (const rows of operationalOrderGroups.values()) {
      const order = rows[0]!;
      let taskKind: RoomStatusOperationalTaskKind | null = null;
      let exceptionReason: string | null = null;
      let blocking = false;
      if (order.order_status === "RESERVED" && order.order_arrival_date === businessDate) taskKind = "ARRIVAL";
      else if (order.order_status === "RESERVED" && order.order_arrival_date < businessDate) {
        taskKind = "EXCEPTION";
        exceptionReason = `计划到店日 ${order.order_arrival_date} 已早于营业日 ${businessDate}，订单仍处于已预订`;
      }
      else if (order.order_status === "CHECKED_IN" && order.order_departure_date === businessDate) taskKind = "DEPARTURE";
      else if (order.order_status === "CHECKED_IN" && order.order_departure_date < businessDate) {
        taskKind = "EXCEPTION";
        exceptionReason = `计划退房日 ${order.order_departure_date} 已早于营业日 ${businessDate}，订单仍处于在住`;
      }
      else if (order.order_status === "CHECKED_IN" && order.order_arrival_date <= businessDate && businessDate < order.order_departure_date) taskKind = "IN_HOUSE";
      if (!taskKind) continue;
      const lifecycleConsistent = order.order_status === "RESERVED" && order.stay_status === "PLANNED"
        || order.order_status === "CHECKED_IN" && order.stay_status === "IN_HOUSE";
      if (!lifecycleConsistent) {
        taskKind = "EXCEPTION";
        exceptionReason = "订单状态与住宿状态不一致";
        inconsistentOperationalLifecycle = true;
      }
      const segment = [...rows].reverse().find((row) => row.segment_arrival_date <= businessDate && businessDate < row.segment_departure_date)
        ?? rows.at(-1)!;
      const departureDayInHouse = order.order_status === "CHECKED_IN" && order.order_departure_date === businessDate;
      const dateCoveredByOrder = order.order_arrival_date <= businessDate && businessDate < order.order_departure_date;
      const claimId = segment.operational_claim_id;
      const missingCurrentClaim = dateCoveredByOrder && !claimId;
      if (missingCurrentClaim) {
        taskKind = "EXCEPTION";
        exceptionReason = `营业日 ${businessDate} 的住宿订单占用记录缺失`;
        missingOperationalClaim = true;
      }
      blocking = departureDayInHouse || dateCoveredByOrder;
      const orderRef = reference("ORDER", order.order_id, `Order ${order.order_id}`, `/orders/${order.order_id}`);
      const sourceKind: RoomStatusSourceKind = order.stay_type === "FREE" ? "FREE_STAY" : "ORDER";
      const orderSourceFields = roomStatusOrderSourceFields(order);
      const sourceMetadataDamageReason = roomStatusSourceMetadataDamageReason(sourceKind, order);
      const sourceMetadataDamaged = sourceMetadataDamageReason !== null;
      if (sourceMetadataDamaged) partial = true;
      const freeStayReason = sourceKind === "FREE_STAY" ? order.free_stay_reason : null;
      const taskReason = [
        exceptionReason,
        sourceMetadataDamageReason,
        departureDayInHouse ? `计划退房日 ${businessDate}，订单仍待办理退房` : null,
        freeStayReason ? `免费入住原因：${freeStayReason}` : null
      ].filter(Boolean).join("；") || null;
      const projectedOccupants = occupantsByOrder.get(order.order_id) ?? [];
      const taskEvent: ProjectionEvent = {
        actualInventoryUnitId: segment.inventory_unit_id,
        roomId: segment.parent_room_id ?? segment.inventory_unit_id,
        serviceDate: businessDate,
        sourceStartDate: order.order_arrival_date,
        sourceEndDate: order.order_departure_date,
        orderArrivalDate: order.order_arrival_date,
        orderDepartureDate: order.order_departure_date,
        sourceKey: `order-task:${order.order_id}:${taskKind}`,
        sourceKind,
        ...orderSourceFields,
        status: missingCurrentClaim || !lifecycleConsistent || sourceMetadataDamaged ? "UNKNOWN" : order.order_status === "RESERVED" ? "RESERVED" : "IN_HOUSE",
        attention: null,
        operationalAttention: !missingCurrentClaim && lifecycleConsistent && !sourceMetadataDamaged
          ? operationalAttentionForOrder({
            orderStatus: order.order_status,
            stayStatus: order.stay_status,
            arrivalDate: order.order_arrival_date,
            departureDate: order.order_departure_date
          }, businessDate)
          : null,
        label: `${sourceKind === "FREE_STAY" ? "免费入住" : "订单"} ${order.order_id}`,
        primaryOccupantLabel: lifecycleConsistent && !missingCurrentClaim && !sourceMetadataDamaged
          ? projectedOccupants[0]?.nickname ?? primaryOccupantLabel(order.primary_guest_snapshot)
          : null,
        occupants: lifecycleConsistent && !missingCurrentClaim && !sourceMetadataDamaged ? projectedOccupants : [],
        reason: taskReason,
        blocking,
        current: true,
        blockingFactKind: departureDayInHouse && lifecycleConsistent && !sourceMetadataDamaged
          ? "DUE_OUT"
          : claimId
            ? "CLAIM"
            : blocking
              ? "LODGING_ORDER"
              : null,
        claimId: departureDayInHouse ? null : claimId ?? null,
        references: [
          ...(!departureDayInHouse && claimId ? [reference("CLAIM", claimId, `Claim ${claimId}`)] : []),
          orderRef,
          reference("STAY", order.stay_id, `Stay ${order.stay_id}`),
          reference("INVENTORY_UNIT", segment.inventory_unit_id, `${segment.unit_code} · ${segment.unit_name}`)
        ],
        histories: [{
          action: "ORDER_TASK_SOURCE",
          actorId: null,
          source: "UNKNOWN",
          occurredAt: iso(segment.segment_created_at),
          commandId: null,
          receiptId: null,
          correlationId: null
        }],
        commandIds: segment.segment_command_id ? [segment.segment_command_id] : [],
        targetReference: orderRef,
        orderId: order.order_id
      };
      if (!missingCurrentClaim && lifecycleConsistent && !sourceMetadataDamaged) {
        operationalTaskSeeds.push({
          taskKind,
          businessDate,
          startDate: order.order_arrival_date,
          endDate: order.order_departure_date,
          event: taskEvent
        });
      }
      if (departureDayInHouse) {
        syntheticOccupancyEvents.push({
          ...taskEvent,
          sourceStartDate: businessDate,
          sourceEndDate: dateAfter(businessDate),
          sourceKey: `departure-day-in-house:${order.order_id}:${businessDate}`,
          blockingFactKind: lifecycleConsistent && !sourceMetadataDamaged ? "DUE_OUT" : "LODGING_ORDER",
          claimId: null,
          references: taskEvent.references.filter((item) => item.type !== "CLAIM")
        });
      }
      else if (missingCurrentClaim) {
        syntheticOccupancyEvents.push({
          ...taskEvent,
          sourceKey: `missing-order-claim:${order.order_id}:${businessDate}`
        });
      }
    }

    const inactiveTaskUnits = await trx.selectFrom("inventory_units")
      .select(["id", "kind", "parent_room_id", "code", "name"])
      .where("property_id", "=", options.propertyId)
      .where("active", "=", false)
      .orderBy("code")
      .orderBy("id")
      .limit(ROOM_STATUS_OPERATIONAL_TASK_LIMIT + 1)
      .execute();
    const inactiveUnitsTruncated = inactiveTaskUnits.length > ROOM_STATUS_OPERATIONAL_TASK_LIMIT;
    for (const unit of inactiveTaskUnits.slice(0, ROOM_STATUS_OPERATIONAL_TASK_LIMIT)) {
      const unitRef = reference("INVENTORY_UNIT", unit.id, `${unit.code} · ${unit.name}`);
      operationalTaskSeeds.push({
        taskKind: "EXCEPTION",
        businessDate,
        startDate: businessDate,
        endDate: dateAfter(businessDate),
        event: {
          actualInventoryUnitId: unit.id,
          roomId: unit.kind === "ROOM" ? unit.id : unit.parent_room_id!,
          serviceDate: businessDate,
          sourceStartDate: businessDate,
          sourceEndDate: dateAfter(businessDate),
          sourceKey: `unsellable:${unit.id}`,
          sourceKind: "UNIT_UNSELLABLE",
          status: "UNAVAILABLE",
          attention: null,
          operationalAttention: null,
          label: "Unit unavailable",
          primaryOccupantLabel: null,
          reason: "The inventory unit is inactive",
          blocking: true,
          current: true,
          blockingFactKind: "UNIT_UNSELLABLE",
          claimId: null,
          references: [unitRef],
          histories: [],
          commandIds: [],
          targetReference: unitRef
        }
      });
    }

    const childrenByRoom = new Map<string, typeof bedRows>();
    for (const bed of bedRows) {
      const children = childrenByRoom.get(bed.parent_room_id!) ?? [];
      children.push(bed);
      childrenByRoom.set(bed.parent_room_id!, children);
    }

    const unitsById = new Map<string, RoomStatusUnitDto>();
    const displayUnitsById = new Map<string, RoomStatusUnitDto>();
    for (const room of roomRows) {
      const children = childrenByRoom.get(room.id) ?? [];
      const roomUnit: RoomStatusUnitDto = {
        id: room.id,
        propertyId: room.property_id,
        roomId: room.id,
        parentRoomId: null,
        kind: "ROOM",
        code: room.code,
        name: room.name,
        active: room.active,
        salesMode: !room.active ? "UNAVAILABLE" : children.length > 0 ? "BED_SPLIT" : "WHOLE_ROOM",
        buildingCode: room.building_code,
        roomTypeCode: room.room_type_code,
        pricingProductCode: room.pricing_product_code,
        physicalBedCount: room.physical_bed_count,
        capacity: room.physical_bed_count ?? Math.max(children.length, 1),
        occupancyCapacity: room.occupancy_capacity,
        childUnitIds: children.map((bed) => bed.id),
        children: [],
        bedOccupancies: [],
        bedSlotStates: [],
        days: [],
        intervals: [],
        conflicts: [],
        allowedActions: []
      };
      unitsById.set(room.id, roomUnit);
      for (const bed of children) {
        unitsById.set(bed.id, {
          id: bed.id,
          propertyId: bed.property_id,
          roomId: room.id,
          parentRoomId: room.id,
          kind: "BED",
          code: bed.code,
          name: bed.name,
          active: bed.active,
          salesMode: bed.active ? "BED_SPLIT" : "UNAVAILABLE",
          buildingCode: bed.building_code,
          roomTypeCode: bed.room_type_code,
          pricingProductCode: bed.pricing_product_code,
          physicalBedCount: bed.physical_bed_count,
          capacity: 1,
          occupancyCapacity: bed.occupancy_capacity,
          childUnitIds: [],
          children: [],
          bedOccupancies: [],
          bedSlotStates: [],
          days: [],
          intervals: [],
          conflicts: [],
          allowedActions: []
        });
      }
      if (!room.active) continue;
      const activeChildren = children.filter((bed) => bed.active);
      const activeChildUnitIds = activeChildren.map((bed) => bed.id);
      displayUnitsById.set(room.id, {
        ...roomUnit,
        // The full map preserves historical children for audit, while this map is the sellable tree.
        salesMode: activeChildUnitIds.length > 0 ? "BED_SPLIT" : "WHOLE_ROOM",
        capacity: room.physical_bed_count ?? Math.max(activeChildUnitIds.length, 1),
        childUnitIds: activeChildUnitIds
      });
      for (const childId of activeChildUnitIds) {
        displayUnitsById.set(childId, unitsById.get(childId)!);
      }
    }


    const deferredUnavailableRows = await trx.selectFrom("internal_use_blocks")
      .select(["id", "inventory_unit_id", "room_id", "arrival_date", "departure_date", "status", "created_at"])
      .where("property_id", "=", options.propertyId)
      .where("status", "=", "ACTIVE")
      .where("arrival_date", "<", options.departureDate)
      .where("departure_date", ">", options.arrivalDate)
      .orderBy("id")
      .execute();

    const activeOrderIds = [...new Set(claimRows.flatMap((row) => row.source_type === "ORDER_SEGMENT"
      && row.active && row.order_id ? [row.order_id] : []))];
    const activePricingOrderIds = [...new Set([...activeOrderIds, ...operationalOrderIds])];
    const activeOrderTimelineRows = activePricingOrderIds.length === 0 ? [] : await trx
      .selectFrom("inventory_claims as claim")
      .innerJoin("stay_segments as segment", (join) => join
        .onRef("segment.id", "=", "claim.source_id")
        .on("claim.source_type", "=", "ORDER_SEGMENT"))
      .innerJoin("stays as stay", "stay.id", "segment.stay_id")
      .innerJoin("orders as timeline_order", "timeline_order.id", "stay.order_id")
      .select([
        "claim.id as claim_id", "claim.inventory_unit_id", "claim.service_date",
        "stay.order_id", "timeline_order.arrival_date as order_arrival_date",
        "timeline_order.departure_date as order_departure_date"
      ])
      .where("claim.property_id", "=", options.propertyId)
      .where("claim.active", "=", true)
      .where("stay.order_id", "in", activePricingOrderIds)
      .orderBy("stay.order_id")
      .orderBy("claim.service_date")
      .orderBy("claim.id")
      .execute();
    const activeOrderRunByClaimId = new Map<string, { sourceKey: string; startDate: string; endDate: string }>();
    const timelineByOrder = new Map<string, typeof activeOrderTimelineRows>();
    for (const row of activeOrderTimelineRows) {
      const rows = timelineByOrder.get(row.order_id) ?? [];
      rows.push(row);
      timelineByOrder.set(row.order_id, rows);
    }
    for (const [orderId, rows] of timelineByOrder) {
      let run: typeof rows = [];
      const flush = () => {
        if (run.length === 0) return;
        const startDate = run[0]!.service_date;
        const endDate = dateAfter(run.at(-1)!.service_date);
        const sourceKey = `order:${orderId}:unit:${run[0]!.inventory_unit_id}:run:${startDate}`;
        for (const item of run) activeOrderRunByClaimId.set(item.claim_id, { sourceKey, startDate, endDate });
        run = [];
      };
      for (const row of rows.filter((candidate) => candidate.order_arrival_date <= candidate.service_date
        && candidate.service_date < candidate.order_departure_date)) {
        const previous = run.at(-1);
        if (previous && (previous.inventory_unit_id !== row.inventory_unit_id
          || dateAfter(previous.service_date) !== row.service_date)) flush();
        run.push(row);
      }
      flush();
    }

    const protocolEpochRows = await trx.selectFrom("schema_migrations").select(["name", "applied_at"])
      .where("name", "in", [
        "028_stage11_move_unit_guards.sql",
        "044_inhouse_membership_fulfillment_guards.sql"
      ])
      .execute();
    const protocolEpochByMigration = new Map(protocolEpochRows.map((row) => [
      row.name,
      row.applied_at instanceof Date ? row.applied_at : new Date(row.applied_at)
    ]));
    const normalizeLifecycleAmendments = <T extends {
      amendment_type: string;
      payload: unknown;
      created_at: Date | string;
    }>(amendments: readonly T[]) => amendments.map((amendment) => {
      const protocolVersion = legacyEffectProtocol(amendment.amendment_type, amendment.payload);
      if (!protocolVersion) return amendment;
      const migrationName = historicalProtocolEpochMigration(protocolVersion);
      const protocolEpoch = protocolEpochByMigration.get(migrationName);
      if (!protocolEpoch) {
        throw new DomainError("INTERNAL_ERROR", `Historical protocol epoch ${migrationName} is unavailable`, 500);
      }
      const createdAt = amendment.created_at instanceof Date ? amendment.created_at : new Date(amendment.created_at);
      if (createdAt.getTime() >= protocolEpoch.getTime()) {
        throw new DomainError("INTERNAL_ERROR", "订单变更在历史协议分界后仍使用旧数据形状", 500);
      }
      return { ...amendment, protocolVersion };
    });

    const activeOrderContexts = activePricingOrderIds.length === 0 ? [] : await trx
      .selectFrom("orders as order")
      .innerJoin("stays as stay", "stay.order_id", "order.id")
      .select([
        "order.id as id",
        "order.status as status",
        "order.stay_type as stay_type",
        "order.arrival_date as arrival_date",
        "order.departure_date as departure_date",
        "order.current_revision_id as current_revision_id",
        "order.version as version",
        "order.member_id as member_id",
        "order.member_contract_id as member_contract_id",
        "order.booking_channel_code as booking_channel_code",
        "order.channel_order_reference as channel_order_reference",
        "order.free_stay_category_code as free_stay_category_code",
        "order.free_stay_reason as free_stay_reason",
        "order.pricing_policy_version_id as pricing_policy_version_id",
        "stay.id as stay_id",
        "stay.status as stay_status"
      ])
      .where("order.id", "in", activePricingOrderIds)
      .execute();
    const activeStayIds = activeOrderContexts.map((row) => row.stay_id);
    const activeSegments = activeStayIds.length === 0 ? [] : await trx.selectFrom("stay_segments")
      .select([
        "id",
        "stay_id",
        "sequence",
        "inventory_unit_id",
        "arrival_date",
        "departure_date",
        "segment_type",
        "supersedes_segment_id",
        "amendment_id"
      ])
      .where("stay_id", "in", activeStayIds)
      .orderBy("stay_id")
      .orderBy("sequence")
      .execute();
    const activeAmendments = activePricingOrderIds.length === 0 ? [] : await trx
      .selectFrom("amendments as amendment")
      .leftJoin("command_executions as command", "command.id", "amendment.command_id")
      .leftJoin("subjects as subject", "subject.id", "command.subject_id")
      .select([
        "amendment.id",
        "amendment.order_id",
        "amendment.sequence",
        "amendment.prior_version",
        "amendment.new_version",
        "amendment.amendment_type",
        "amendment.payload",
        "amendment.reason_code",
        "amendment.reason_note",
        "amendment.created_at",
        "amendment.command_id",
        "command.subject_id as actor_subject_id",
        "subject.display_name as actor_display_name"
      ])
      .where("amendment.order_id", "in", activePricingOrderIds)
      .orderBy("amendment.order_id")
      .orderBy("amendment.sequence")
      .execute();
    const activeRevisions = activePricingOrderIds.length === 0 ? [] : await trx
      .selectFrom("pricing_revisions")
      .select([
        "id",
        "order_id",
        "revision_no",
        "amendment_id",
        "arrival_date",
        "departure_date",
        "policy_base_amount_minor",
        "current_contract_amount_minor",
        "currency",
        "pricing_basis",
        "policy_version_id",
        "coverage_set",
        "cash_lines",
        "manual_adjustment_minor"
      ])
      .where("order_id", "in", activePricingOrderIds)
      .orderBy("order_id")
      .orderBy("revision_no")
      .execute();
    const activeFacts = activePricingOrderIds.length === 0 ? [] : await trx
      .selectFrom("collection_facts")
      .select([
        "fact_id",
        "order_id",
        "fact_type",
        "amount_minor",
        "net_effect_minor",
        "currency",
        "references_fact_id",
        "reverses_fact_id",
        "pricing_revision_id",
        "created_at"
      ])
      .where("order_id", "in", activePricingOrderIds)
      .orderBy("order_id")
      .orderBy("created_at")
      .orderBy("fact_id")
      .execute();
    const activeCoverageItems = activePricingOrderIds.length === 0 ? [] : await trx
      .selectFrom("coverage_items")
      .select(["id", "order_id", "contract_id", "status", "held_by_revision_id"])
      .where("order_id", "in", activePricingOrderIds)
      .execute();
    const activeSegmentsByStay = new Map<string, typeof activeSegments>();
    for (const segment of activeSegments) {
      const rows = activeSegmentsByStay.get(segment.stay_id) ?? [];
      rows.push(segment);
      activeSegmentsByStay.set(segment.stay_id, rows);
    }
    const activeAmendmentsByOrder = new Map<string, typeof activeAmendments>();
    for (const amendment of activeAmendments) {
      const rows = activeAmendmentsByOrder.get(amendment.order_id) ?? [];
      rows.push(amendment);
      activeAmendmentsByOrder.set(amendment.order_id, rows);
    }
    const activeRevisionsByOrder = new Map<string, typeof activeRevisions>();
    for (const revision of activeRevisions) {
      const rows = activeRevisionsByOrder.get(revision.order_id) ?? [];
      rows.push(revision);
      activeRevisionsByOrder.set(revision.order_id, rows);
    }
    const activeFactsByOrder = new Map<string, typeof activeFacts>();
    for (const fact of activeFacts) {
      const rows = activeFactsByOrder.get(fact.order_id) ?? [];
      rows.push(fact);
      activeFactsByOrder.set(fact.order_id, rows);
    }
    const activeCoverageByOrder = new Map<string, typeof activeCoverageItems>();
    for (const item of activeCoverageItems) {
      const rows = activeCoverageByOrder.get(item.order_id) ?? [];
      rows.push(item);
      activeCoverageByOrder.set(item.order_id, rows);
    }
    const activeArrearsByOrder = new Map<string, ActiveOrderArrearsProjection>();
    for (const row of activeOrderContexts) {
      const lifecycleEligible = row.status === "RESERVED" && row.stay_status === "PLANNED"
        || row.status === "CHECKED_IN" && row.stay_status === "IN_HOUSE";
      const potentiallyEligible = lifecycleEligible
        && row.stay_type !== "FREE"
        && (row.booking_channel_code === null || row.booking_channel_code === "WECOM");
      if (!potentiallyEligible) continue;
      const coverageItems = activeCoverageByOrder.get(row.id) ?? [];
      if (row.member_id || row.member_contract_id) continue;
      if (coverageItems.length > 0) {
        activeArrearsByOrder.set(row.id, {
          attention: null,
          damaged: true,
          reason: "当前住宿的会员覆盖关系无法核对"
        });
        continue;
      }
      try {
        const revisions = activeRevisionsByOrder.get(row.id) ?? [];
        const facts = activeFactsByOrder.get(row.id) ?? [];
        projectOrderLifecycle({
          order: {
            id: row.id,
            status: row.status,
            stay_type: row.stay_type,
            arrival_date: row.arrival_date,
            departure_date: row.departure_date,
            current_revision_id: row.current_revision_id,
            version: row.version
          },
          stay: { id: row.stay_id, status: row.stay_status },
          businessDate,
          segments: activeSegmentsByStay.get(row.stay_id) ?? [],
          amendments: normalizeLifecycleAmendments(activeAmendmentsByOrder.get(row.id) ?? []),
          revisions,
          facts,
          activeTimeline: (timelineByOrder.get(row.id) ?? []).map((item) => ({
            serviceDate: item.service_date,
            inventoryUnitId: item.inventory_unit_id
          }))
        });
        const revision = revisions.find((candidate) => candidate.id === row.current_revision_id);
        const currentTimeline = (timelineByOrder.get(row.id) ?? []).map((item) => ({
          serviceDate: item.service_date,
          inventoryUnitId: item.inventory_unit_id
        }));
        const revisionsAreConsistent = revisions.every((candidate) => {
          const coverageSet = candidate.coverage_set;
          if (!Array.isArray(coverageSet) || coverageSet.length !== 0) return false;
          const cashLineTotal = candidate.id === row.current_revision_id
            ? ordinaryStayCashLineTotalMinor(candidate.cash_lines, candidate.currency, currentTimeline)
            : pricingCashLineTotalMinor(candidate.cash_lines, candidate.currency);
          return candidate.policy_version_id === row.pricing_policy_version_id
            && (candidate.pricing_basis === "POLICY" || candidate.pricing_basis === "MANUAL_ADJUSTMENT")
            && Number.isSafeInteger(candidate.policy_base_amount_minor)
            && candidate.policy_base_amount_minor >= 0
            && Number.isSafeInteger(candidate.manual_adjustment_minor)
            && Number.isSafeInteger(candidate.current_contract_amount_minor)
            && candidate.current_contract_amount_minor >= 0
            && candidate.current_contract_amount_minor
              === candidate.policy_base_amount_minor + candidate.manual_adjustment_minor
            && (candidate.pricing_basis === "POLICY"
              ? candidate.manual_adjustment_minor === 0
              : candidate.manual_adjustment_minor !== 0)
            && cashLineTotal !== undefined
            && cashLineTotal === candidate.policy_base_amount_minor;
        });
        if (!revision || !revisionsAreConsistent) {
          throw new DomainError("INTERNAL_ERROR", "当前住宿的计价链无法核对", 500);
        }
        const revisionIds = new Set(revisions.map((candidate) => candidate.id));
        const factsById = new Map(facts.map((fact) => [fact.fact_id, fact]));
        const reversedFactIds = new Set<string>();
        const processedFactIds = new Set<string>();
        const activeRefundMinorByCollection = new Map<string, number>();
        let factsMatchRevisionCurrency = true;
        for (const fact of facts) {
          if (fact.currency !== revision.currency
            || !Number.isSafeInteger(fact.amount_minor)
            || fact.amount_minor <= 0
            || !Number.isSafeInteger(fact.net_effect_minor)
            || !fact.pricing_revision_id
            || !revisionIds.has(fact.pricing_revision_id)) {
            factsMatchRevisionCurrency = false;
            break;
          }
          if (fact.fact_type === "COLLECTION") {
            if (fact.net_effect_minor !== fact.amount_minor
              || fact.references_fact_id !== null
              || fact.reverses_fact_id !== null
              || activeRefundMinorByCollection.has(fact.fact_id)) {
              factsMatchRevisionCurrency = false;
              break;
            }
            activeRefundMinorByCollection.set(fact.fact_id, 0);
            processedFactIds.add(fact.fact_id);
            continue;
          }
          if (fact.fact_type === "REFUND") {
            const source = fact.references_fact_id ? factsById.get(fact.references_fact_id) : undefined;
            const activeRefundMinor = source ? activeRefundMinorByCollection.get(source.fact_id) : undefined;
            const nextActiveRefundMinor = activeRefundMinor !== undefined
              ? activeRefundMinor + fact.amount_minor
              : Number.NaN;
            if (fact.net_effect_minor !== -fact.amount_minor
              || fact.reverses_fact_id !== null
              || source?.fact_type !== "COLLECTION"
              || !processedFactIds.has(source.fact_id)
              || reversedFactIds.has(source.fact_id)
              || activeRefundMinor === undefined
              || !Number.isSafeInteger(nextActiveRefundMinor)
              || nextActiveRefundMinor > source.amount_minor) {
              factsMatchRevisionCurrency = false;
              break;
            }
            activeRefundMinorByCollection.set(source.fact_id, nextActiveRefundMinor);
            processedFactIds.add(fact.fact_id);
            continue;
          }
          const source = fact.reverses_fact_id ? factsById.get(fact.reverses_fact_id) : undefined;
          if (fact.references_fact_id !== null
            || !source
            || source.fact_type === "REVERSAL"
            || fact.amount_minor !== source.amount_minor
            || fact.net_effect_minor !== -source.net_effect_minor
            || reversedFactIds.has(source.fact_id)
            || !processedFactIds.has(source.fact_id)) {
            factsMatchRevisionCurrency = false;
            break;
          }
          if (source.fact_type === "REFUND") {
            const refundSource = source.references_fact_id ? factsById.get(source.references_fact_id) : undefined;
            const activeRefundMinor = refundSource ? activeRefundMinorByCollection.get(refundSource.fact_id) : undefined;
            const nextActiveRefundMinor = activeRefundMinor !== undefined
              ? activeRefundMinor - source.amount_minor
              : Number.NaN;
            if (refundSource?.fact_type !== "COLLECTION"
              || activeRefundMinor === undefined
              || !Number.isSafeInteger(nextActiveRefundMinor)
              || nextActiveRefundMinor < 0) {
              factsMatchRevisionCurrency = false;
              break;
            }
            activeRefundMinorByCollection.set(refundSource.fact_id, nextActiveRefundMinor);
          } else {
            const activeRefundMinor = activeRefundMinorByCollection.get(source.fact_id);
            if (activeRefundMinor !== 0) {
              factsMatchRevisionCurrency = false;
              break;
            }
          }
          reversedFactIds.add(source.fact_id);
          processedFactIds.add(fact.fact_id);
        }
        if (factsMatchRevisionCurrency) {
          for (const collection of facts.filter((fact) => fact.fact_type === "COLLECTION")) {
            const activeRefundTotal = activeRefundMinorByCollection.get(collection.fact_id);
            if (activeRefundTotal === undefined
              || !Number.isSafeInteger(activeRefundTotal)
              || activeRefundTotal > collection.amount_minor
              || (reversedFactIds.has(collection.fact_id) && activeRefundTotal !== 0)) {
              factsMatchRevisionCurrency = false;
              break;
            }
          }
        }
        const netRecordedCollectionMinor = facts.reduce((sum, fact) => sum + fact.net_effect_minor, 0);
        if (!factsMatchRevisionCurrency
          || !Number.isSafeInteger(netRecordedCollectionMinor)
          || netRecordedCollectionMinor < 0) {
          throw new DomainError("INTERNAL_ERROR", "当前住宿的资金链无法核对", 500);
        }
        activeArrearsByOrder.set(row.id, {
          attention: netRecordedCollectionMinor < revision.current_contract_amount_minor ? "ARREARS" : null,
          damaged: false,
          reason: null
        });
      } catch {
        activeArrearsByOrder.set(row.id, {
          attention: null,
          damaged: true,
          reason: "当前住宿的计价或资金链无法核对"
        });
      }
    }

    const completedOrderIds = [...new Set(claimRows.flatMap((row) => row.source_type === "ORDER_SEGMENT"
      && !row.active
      && row.order_status === "CHECKED_OUT"
      && row.stay_status === "COMPLETED"
      && row.order_id ? [row.order_id] : []))];
    const completedOrderClaimCandidates = completedOrderIds.length === 0 ? [] : await trx
      .selectFrom("inventory_claims as claim")
      .innerJoin("stay_segments as segment", (join) => join
        .onRef("segment.id", "=", "claim.source_id")
        .on("claim.source_type", "=", "ORDER_SEGMENT"))
      .innerJoin("stays as stay", "stay.id", "segment.stay_id")
      .select([
        "claim.id as claim_id", "claim.inventory_unit_id", "claim.service_date", "claim.created_at",
        "stay.order_id"
      ])
      .where("claim.property_id", "=", options.propertyId)
      .where("claim.active", "=", false)
      .where("stay.status", "=", "COMPLETED")
      .where("claim.service_date", "<", businessDate)
      .where("stay.order_id", "in", completedOrderIds)
      .orderBy("stay.order_id")
      .orderBy("claim.service_date")
      .orderBy("claim.created_at")
      .orderBy("claim.id")
      .execute();
    const completedLatestByOrderDate = new Map<string, typeof completedOrderClaimCandidates[number]>();
    for (const row of completedOrderClaimCandidates) {
      const key = `${row.order_id}:${row.service_date}`;
      const previous = completedLatestByOrderDate.get(key);
      if (!previous || iso(row.created_at) > iso(previous.created_at)
        || (iso(row.created_at) === iso(previous.created_at) && row.claim_id > previous.claim_id)) {
        completedLatestByOrderDate.set(key, row);
      }
    }
    const completedOrderContexts = completedOrderIds.length === 0 ? [] : await trx
      .selectFrom("orders as order")
      .innerJoin("stays as stay", "stay.order_id", "order.id")
      .select([
        "order.id as id",
        "order.status as status",
        "order.stay_type as stay_type",
        "order.arrival_date as arrival_date",
        "order.departure_date as departure_date",
        "order.current_revision_id as current_revision_id",
        "order.version as version",
        "order.member_id as member_id",
        "order.member_contract_id as member_contract_id",
        "order.booking_channel_code as booking_channel_code",
        "order.channel_order_reference as channel_order_reference",
        "order.free_stay_category_code as free_stay_category_code",
        "order.free_stay_reason as free_stay_reason",
        "stay.id as stay_id",
        "stay.status as stay_status"
      ])
      .where("order.id", "in", completedOrderIds)
      .execute();
    const completedStayIds = completedOrderContexts.map((row) => row.stay_id);
    const completedSegments = completedStayIds.length === 0 ? [] : await trx.selectFrom("stay_segments")
      .select([
        "id",
        "stay_id",
        "sequence",
        "inventory_unit_id",
        "arrival_date",
        "departure_date",
        "segment_type",
        "supersedes_segment_id",
        "amendment_id"
      ])
      .where("stay_id", "in", completedStayIds)
      .orderBy("stay_id")
      .orderBy("sequence")
      .execute();
    const completedAmendments = completedOrderIds.length === 0 ? [] : await trx
      .selectFrom("amendments as amendment")
      .leftJoin("command_executions as command", "command.id", "amendment.command_id")
      .leftJoin("subjects as subject", "subject.id", "command.subject_id")
      .select([
        "amendment.id",
        "amendment.order_id",
        "amendment.sequence",
        "amendment.prior_version",
        "amendment.new_version",
        "amendment.amendment_type",
        "amendment.payload",
        "amendment.reason_code",
        "amendment.reason_note",
        "amendment.created_at",
        "amendment.command_id",
        "command.subject_id as actor_subject_id",
        "subject.display_name as actor_display_name"
      ])
      .where("amendment.order_id", "in", completedOrderIds)
      .orderBy("amendment.order_id")
      .orderBy("amendment.sequence")
      .execute();
    const completedRevisions = completedOrderIds.length === 0 ? [] : await trx
      .selectFrom("pricing_revisions")
      .select([
        "id",
        "order_id",
        "revision_no",
        "amendment_id",
        "arrival_date",
        "departure_date",
        "policy_base_amount_minor",
        "current_contract_amount_minor",
        "currency",
        "pricing_basis"
      ])
      .where("order_id", "in", completedOrderIds)
      .orderBy("order_id")
      .orderBy("revision_no")
      .execute();
    const completedFacts = completedOrderIds.length === 0 ? [] : await trx
      .selectFrom("collection_facts")
      .select(["order_id", "net_effect_minor", "currency", "created_at"])
      .where("order_id", "in", completedOrderIds)
      .orderBy("order_id")
      .orderBy("created_at")
      .orderBy("fact_id")
      .execute();
    const completedSegmentsByStay = new Map<string, typeof completedSegments>();
    for (const segment of completedSegments) {
      const rows = completedSegmentsByStay.get(segment.stay_id) ?? [];
      rows.push(segment);
      completedSegmentsByStay.set(segment.stay_id, rows);
    }
    const completedAmendmentsByOrder = new Map<string, typeof completedAmendments>();
    for (const amendment of completedAmendments) {
      const rows = completedAmendmentsByOrder.get(amendment.order_id) ?? [];
      rows.push(amendment);
      completedAmendmentsByOrder.set(amendment.order_id, rows);
    }
    const completedRevisionsByOrder = new Map<string, typeof completedRevisions>();
    for (const revision of completedRevisions) {
      const rows = completedRevisionsByOrder.get(revision.order_id) ?? [];
      rows.push(revision);
      completedRevisionsByOrder.set(revision.order_id, rows);
    }
    const completedFactsByOrder = new Map<string, typeof completedFacts>();
    for (const fact of completedFacts) {
      const rows = completedFactsByOrder.get(fact.order_id) ?? [];
      rows.push(fact);
      completedFactsByOrder.set(fact.order_id, rows);
    }
    const completedProjectionByOrder = new Map<string, CompletedOrderRoomStatusProjection>();
    for (const row of completedOrderContexts) {
      try {
        const amendments = normalizeLifecycleAmendments(completedAmendmentsByOrder.get(row.id) ?? []);
        const revisions = completedRevisionsByOrder.get(row.id) ?? [];
        const facts = completedFactsByOrder.get(row.id) ?? [];
        const lifecycle = projectOrderLifecycle({
          order: {
            id: row.id,
            status: row.status,
            stay_type: row.stay_type,
            arrival_date: row.arrival_date,
            departure_date: row.departure_date,
            current_revision_id: row.current_revision_id,
            version: row.version
          },
          stay: { id: row.stay_id, status: row.stay_status },
          businessDate,
          segments: completedSegmentsByStay.get(row.stay_id) ?? [],
          amendments,
          revisions,
          facts,
          activeTimeline: []
        });
        const timelineByDate = new Map<string, string>();
        for (const interval of lifecycle.effectiveArrangement.intervals) {
          for (const serviceDate of enumerateServiceDates(interval.arrivalDate, interval.departureDate)) {
            if (serviceDate < businessDate) timelineByDate.set(serviceDate, interval.inventoryUnitId);
          }
        }
        const revision = revisions.find((item) => item.id === row.current_revision_id) ?? revisions.at(-1);
        const external = row.booking_channel_code !== null && externalChannelCodes.has(row.booking_channel_code);
        const sourceKind: RoomStatusSourceKind = row.stay_type === "FREE" ? "FREE_STAY" : "ORDER";
        const sourceMetadataDamageReason = roomStatusSourceMetadataDamageReason(sourceKind, row, {
          allowLegacyHistoricalFreeMetadata: true
        });
        const netCollected = facts.reduce((sum, fact) => sum + fact.net_effect_minor, 0);
        const externalUnknown = external && (!row.channel_order_reference?.trim()
          || revision?.pricing_basis !== "CHANNEL_CONTRACT"
          || !revision
          || revision.current_contract_amount_minor <= 0);
        const pricingUnknown = Boolean(sourceMetadataDamageReason)
          || row.stay_type !== "FREE" && (!revision || externalUnknown);
        const arrears = !pricingUnknown
          && !external
          && row.stay_type !== "FREE"
          && Boolean(revision && revision.current_contract_amount_minor > netCollected);
        const status: RoomStatusStatus = pricingUnknown ? "UNKNOWN" : arrears ? "ARREARS" : "SETTLED";
        completedProjectionByOrder.set(row.id, {
          timelineByDate,
          status,
          reason: sourceMetadataDamageReason ?? (pricingUnknown
            ? external
              ? "外部渠道住宿缺少完整渠道订单号或本单渠道应结金额"
              : "已退房住宿缺少可核对的结算金额"
            : arrears ? "住宿已退房，仍有未收余额" : null),
          damaged: false
        });
      } catch {
        completedProjectionByOrder.set(row.id, {
          timelineByDate: new Map(),
          status: "UNKNOWN",
          reason: "已退房住宿的最终安排或结算链无法核对",
          damaged: true
        });
      }
    }
    const completedProjectedLatestByOrderDate = new Map<string, typeof completedOrderClaimCandidates[number]>();
    for (const row of completedOrderClaimCandidates) {
      const projection = completedProjectionByOrder.get(row.order_id);
      if (!projection || projection.damaged) continue;
      if (projection.timelineByDate.get(row.service_date) !== row.inventory_unit_id) continue;
      const key = `${row.order_id}:${row.service_date}`;
      const previous = completedProjectedLatestByOrderDate.get(key);
      if (!previous || iso(row.created_at) > iso(previous.created_at)
        || (iso(row.created_at) === iso(previous.created_at) && row.claim_id > previous.claim_id)) {
        completedProjectedLatestByOrderDate.set(key, row);
      }
    }
    for (const row of completedLatestByOrderDate.values()) {
      if (!completedProjectionByOrder.get(row.order_id)?.damaged) continue;
      completedProjectedLatestByOrderDate.set(`${row.order_id}:${row.service_date}`, row);
    }
    const completedOrderRunByClaimId = new Map<string, { sourceKey: string; startDate: string; endDate: string }>();
    const completedTimelineByOrder = new Map<string, typeof completedOrderClaimCandidates>();
    for (const row of completedProjectedLatestByOrderDate.values()) {
      const rows = completedTimelineByOrder.get(row.order_id) ?? [];
      rows.push(row);
      completedTimelineByOrder.set(row.order_id, rows);
    }
    for (const [orderId, rows] of completedTimelineByOrder) {
      rows.sort((left, right) => left.service_date.localeCompare(right.service_date) || left.claim_id.localeCompare(right.claim_id));
      let run: typeof rows = [];
      const flush = () => {
        if (run.length === 0) return;
        const startDate = run[0]!.service_date;
        const endDate = dateAfter(run.at(-1)!.service_date);
        const sourceKey = `completed-order:${orderId}:unit:${run[0]!.inventory_unit_id}:run:${startDate}`;
        for (const item of run) completedOrderRunByClaimId.set(item.claim_id, { sourceKey, startDate, endDate });
        run = [];
      };
      for (const row of rows) {
        const previous = run.at(-1);
        if (previous && (previous.inventory_unit_id !== row.inventory_unit_id
          || dateAfter(previous.service_date) !== row.service_date)) flush();
        run.push(row);
      }
      flush();
    }

    const orderIdsForHistory = [...new Set([
      ...operationalOrderRows.map((row) => row.order_id),
      ...claimRows.flatMap((row) => row.order_id ? [row.order_id] : [])
    ])];
    const alreadyLoadedHistoryIds = new Set([...activePricingOrderIds, ...completedOrderIds]);
    const remainingHistoryIds = orderIdsForHistory.filter((id) => !alreadyLoadedHistoryIds.has(id));
    const remainingAmendmentRows = remainingHistoryIds.length === 0 ? [] : await trx.selectFrom("amendments")
      .select(["order_id", "amendment_type", "command_id", "created_at"])
      .where("order_id", "in", remainingHistoryIds)
      .orderBy("order_id")
      .orderBy("sequence")
      .execute();
    const amendmentRows = [...activeAmendments, ...completedAmendments, ...remainingAmendmentRows];
    const amendmentsByOrder = new Map<string, typeof amendmentRows>();
    for (const amendment of amendmentRows) {
      const rows = amendmentsByOrder.get(amendment.order_id) ?? [];
      rows.push(amendment);
      amendmentsByOrder.set(amendment.order_id, rows);
    }

    partial = partial || missingOperationalClaim || inconsistentOperationalLifecycle || operationalOrdersTruncated || inactiveUnitsTruncated;
    const projectActiveArrearsEvent = (
      event: ProjectionEvent,
      target: "CURRENT_GRID" | "CURRENT_OPERATIONAL_TASK" = "CURRENT_GRID"
    ): ProjectionEvent => {
      if (!event.orderId || (event.status !== "RESERVED" && event.status !== "IN_HOUSE")) return event;
      const projection = activeArrearsByOrder.get(event.orderId);
      if (!projection) return event;
      const withinStayInterval = event.serviceDate >= event.sourceStartDate
        && event.serviceDate < event.sourceEndDate;
      const inCurrentDamageScope = target === "CURRENT_OPERATIONAL_TASK"
        ? event.serviceDate === businessDate
        : event.serviceDate >= businessDate && withinStayInterval;
      if (!inCurrentDamageScope) return event;
      if (projection.damaged) {
        partial = true;
        return {
          ...event,
          status: "UNKNOWN",
          attention: null,
          operationalAttention: null,
          primaryOccupantLabel: null,
          occupants: [],
          reason: projection.reason ?? "当前住宿的计价或资金链无法核对"
        };
      }
      const inCurrentAttentionScope = target === "CURRENT_OPERATIONAL_TASK"
        ? event.serviceDate === businessDate
          && (withinStayInterval || event.status === "IN_HOUSE")
        : event.serviceDate >= businessDate
          && withinStayInterval;
      if (!inCurrentAttentionScope) return event;
      return { ...event, attention: projection.attention };
    };
    const events: ProjectionEvent[] = syntheticOccupancyEvents.map((event) => projectActiveArrearsEvent(event));
    for (const row of claimRows) {
      const claimRef = reference("CLAIM", row.claim_id, `Claim ${row.claim_id}`);
      const fallbackHistory: RoomStatusHistoryDto = {
        action: row.source_type === "INTERNAL_USE" ? "LEGACY_UNAVAILABLE" : row.source_type,
        actorId: null,
        source: "UNKNOWN",
        occurredAt: iso(row.created_at),
        commandId: null,
        receiptId: null,
        correlationId: null
      };
      if (row.source_type === "ORDER_SEGMENT") {
        const resolved = Boolean(row.segment_id && row.stay_id && row.order_id && row.order_status && row.stay_status);
        if (!resolved) {
          if (!row.active) continue;
          partial = true;
          events.push({
            actualInventoryUnitId: row.inventory_unit_id,
            roomId: row.room_id,
            serviceDate: row.service_date,
            sourceStartDate: row.service_date,
            sourceEndDate: dateAfter(row.service_date),
            sourceKey: `unknown:${row.claim_id}`,
            sourceKind: "ORDER",
            status: "UNKNOWN",
            attention: null,
            operationalAttention: null,
            label: "Unresolved order claim",
            primaryOccupantLabel: null,
            reason: "The order or Stay source could not be resolved",
            blocking: true,
            current: true,
            blockingFactKind: "CLAIM",
            claimId: row.claim_id,
            references: [claimRef],
            histories: [fallbackHistory],
            commandIds: [],
            targetReference: null
          });
          continue;
        }
        if (!row.active) {
          const historicalCompleted = completedProjectedLatestByOrderDate.get(`${row.order_id}:${row.service_date}`)?.claim_id === row.claim_id;
          if (!historicalCompleted) continue;
          const completedProjection = completedProjectionByOrder.get(row.order_id!);
          const completedStatus: RoomStatusStatus = completedProjection?.status ?? "UNKNOWN";
          const projectedOccupants = occupantsByOrder.get(row.order_id!) ?? [];
          const occupantLabel = projectedOccupants[0]?.nickname ?? primaryOccupantLabel(row.primary_guest_snapshot);
          const orderRef = reference("ORDER", row.order_id!, `Order ${row.order_id}`, `/orders/${row.order_id}`);
          const stayRef = reference("STAY", row.stay_id!, `Stay ${row.stay_id}`);
          const projectedRun = completedOrderRunByClaimId.get(row.claim_id);
          if (!projectedRun) partial = true;
          const sourceKind: RoomStatusSourceKind = row.stay_type === "FREE" ? "FREE_STAY" : "ORDER";
          const sourceMetadataDamageReason = roomStatusSourceMetadataDamageReason(
            sourceKind,
            row,
            { allowLegacyHistoricalFreeMetadata: true }
          );
          const historicalStatus: RoomStatusStatus = completedStatus === "UNKNOWN" || sourceMetadataDamageReason
            ? "UNKNOWN"
            : completedStatus;
          if (historicalStatus === "UNKNOWN") partial = true;
          const sourceFields = historicalStatus === "UNKNOWN"
            ? nullLodgingSourceFields
            : roomStatusHistoricalOrderSourceFields(sourceKind, row);
          events.push({
            actualInventoryUnitId: row.inventory_unit_id, roomId: row.room_id, serviceDate: row.service_date,
            sourceStartDate: projectedRun?.startDate ?? row.segment_arrival_date!,
            sourceEndDate: projectedRun?.endDate ?? row.segment_departure_date!,
            orderArrivalDate: row.order_arrival_date!,
            orderDepartureDate: row.order_departure_date!,
            sourceKey: projectedRun?.sourceKey ?? `completed:${row.order_id}:${row.segment_id}`,
            sourceKind,
            ...sourceFields,
            status: historicalStatus,
            attention: historicalStatus === "ARREARS" ? "ARREARS" : null,
            operationalAttention: null,
            label: historicalStatus === "UNKNOWN" ? `状态未知 ${row.order_id}` : `已结单 ${row.order_id}`,
            primaryOccupantLabel: historicalStatus === "UNKNOWN" ? null : occupantLabel,
            occupants: historicalStatus === "UNKNOWN" ? [] : projectedOccupants,
            reason: sourceMetadataDamageReason
              ?? completedProjection?.reason
              ?? "已退房住宿的最终安排或结算链无法核对",
            blocking: false, current: false,
            blockingFactKind: null, claimId: historicalStatus === "UNKNOWN" ? null : row.claim_id, references: [claimRef, orderRef, stayRef], histories: [fallbackHistory],
            commandIds: row.segment_command_id ? [row.segment_command_id] : [], targetReference: orderRef, orderId: row.order_id!
          });
          continue;
        }
        const activeLifecycleConsistent = !row.active
          || row.order_status === "RESERVED" && row.stay_status === "PLANNED"
          || row.order_status === "CHECKED_IN" && row.stay_status === "IN_HOUSE";
        if (!activeLifecycleConsistent) partial = true;
        const activeDateCoveredByOrder = row.order_arrival_date! <= row.service_date
          && row.service_date < row.order_departure_date!;
        if (!activeDateCoveredByOrder) {
          partial = true;
          events.push({
            actualInventoryUnitId: row.inventory_unit_id,
            roomId: row.room_id,
            serviceDate: row.service_date,
            sourceStartDate: row.service_date,
            sourceEndDate: dateAfter(row.service_date),
            sourceKey: `unknown:${row.claim_id}`,
            sourceKind: "ORDER",
            status: "UNKNOWN",
            attention: null,
            operationalAttention: null,
            label: "Invalid order claim date",
            primaryOccupantLabel: null,
            occupants: [],
            reason: "The active order Claim date falls outside the current order interval",
            blocking: true,
            current: true,
            blockingFactKind: "CLAIM",
            claimId: row.claim_id,
            references: [claimRef],
            histories: [fallbackHistory],
            commandIds: [],
            targetReference: null
          });
          continue;
        }
        const orderRef = reference("ORDER", row.order_id!, `Order ${row.order_id}`, `/orders/${row.order_id}`);
        const stayRef = reference("STAY", row.stay_id!, `Stay ${row.stay_id}`);
        const sourceKind: RoomStatusSourceKind = row.stay_type === "FREE" ? "FREE_STAY" : "ORDER";
        const orderSourceFields = roomStatusOrderSourceFields(row);
        const sourceMetadataDamageReason = roomStatusSourceMetadataDamageReason(sourceKind, row);
        const sourceMetadataDamaged = sourceMetadataDamageReason !== null;
        if (sourceMetadataDamaged) partial = true;
        const activeDisplayable = activeLifecycleConsistent && !sourceMetadataDamaged;
        const status: RoomStatusStatus = row.order_status === "CHECKED_IN" ? "IN_HOUSE" : "RESERVED";
        const projectedOccupants = occupantsByOrder.get(row.order_id!) ?? [];
        const occupantLabel = projectedOccupants[0]?.nickname ?? primaryOccupantLabel(row.primary_guest_snapshot);
        const projectedRun = activeOrderRunByClaimId.get(row.claim_id);
        if (!projectedRun) partial = true;
        const projectedOperationalAttention = activeDisplayable
          ? operationalAttentionForOrder({
            orderStatus: row.order_status!,
            stayStatus: row.stay_status!,
            arrivalDate: row.order_arrival_date!,
            departureDate: row.order_departure_date!
          }, businessDate)
          : null;
        const claimOperationalAttention = projectedOperationalAttention === "DUE_OUT"
          ? null
          : projectedOperationalAttention;
        events.push(projectActiveArrearsEvent({
          actualInventoryUnitId: row.inventory_unit_id,
          roomId: row.room_id,
          serviceDate: row.service_date,
          sourceStartDate: projectedRun?.startDate ?? row.segment_arrival_date!,
          sourceEndDate: projectedRun?.endDate ?? row.segment_departure_date!,
          orderArrivalDate: row.order_arrival_date!,
          orderDepartureDate: row.order_departure_date!,
          sourceKey: projectedRun?.sourceKey ?? `segment:${row.segment_id}`,
          sourceKind,
          ...orderSourceFields,
          status: activeDisplayable ? status : "UNKNOWN",
          attention: null,
          operationalAttention: claimOperationalAttention,
          label: `${sourceKind === "FREE_STAY" ? "免费入住" : "订单"} ${row.order_id}`,
          primaryOccupantLabel: activeDisplayable ? occupantLabel : null,
          occupants: activeDisplayable ? projectedOccupants : [],
          reason: activeDisplayable
            ? sourceKind === "FREE_STAY" ? row.free_stay_reason : null
            : sourceMetadataDamaged
              ? sourceMetadataDamageReason
              : `订单状态 ${row.order_status} 与 Stay 状态 ${row.stay_status} 不一致`,
          blocking: row.active,
          current: row.active,
          blockingFactKind: row.active ? "CLAIM" : null,
          claimId: row.claim_id,
          references: [claimRef, orderRef, stayRef],
          histories: [fallbackHistory],
          commandIds: row.segment_command_id ? [row.segment_command_id] : [],
          targetReference: orderRef,
          orderId: row.order_id!
        }));
        continue;
      }
      if (row.source_type === "MAINTENANCE") {
        if (!row.active) continue;
        if (!row.maintenance_id || !row.maintenance_status) {
          partial = true;
          events.push({
            actualInventoryUnitId: row.inventory_unit_id,
            roomId: row.room_id,
            serviceDate: row.service_date,
            sourceStartDate: row.service_date,
            sourceEndDate: dateAfter(row.service_date),
            sourceKey: `unknown:${row.claim_id}`,
            sourceKind: "MAINTENANCE",
            status: "UNKNOWN",
            attention: null,
            operationalAttention: null,
            label: "Unresolved maintenance claim",
            primaryOccupantLabel: null,
            reason: "The maintenance source could not be resolved",
            blocking: true,
            current: true,
            blockingFactKind: "CLAIM",
            claimId: row.claim_id,
            references: [claimRef],
            histories: [fallbackHistory],
            commandIds: [],
            targetReference: null
          });
          continue;
        }
        const blockRef = reference("BLOCK", row.maintenance_id, `Maintenance ${row.maintenance_id}`);
        const invalidActiveReleased = row.maintenance_status !== "ACTIVE";
        if (invalidActiveReleased) partial = true;
        events.push({
          actualInventoryUnitId: row.inventory_unit_id,
          roomId: row.room_id,
          serviceDate: row.service_date,
          sourceStartDate: row.maintenance_arrival_date!,
          sourceEndDate: row.maintenance_departure_date!,
          sourceKey: `maintenance:${row.maintenance_id}`,
          sourceKind: "MAINTENANCE",
          status: invalidActiveReleased ? "UNKNOWN" : "MAINTENANCE",
          attention: null,
          operationalAttention: null,
          label: invalidActiveReleased ? "Inconsistent maintenance lock" : "Maintenance lock",
          primaryOccupantLabel: null,
          reason: row.maintenance_reason,
          blocking: row.active,
          current: row.active,
          blockingFactKind: row.active ? "CLAIM" : null,
          claimId: row.claim_id,
          references: [claimRef, blockRef],
          histories: [fallbackHistory],
          commandIds: [row.maintenance_created_command_id, row.maintenance_released_command_id].filter((id): id is string => Boolean(id)),
          targetReference: blockRef
        });
        continue;
      }
      if (!row.active) continue;
      if (!row.internal_id || !row.internal_status) {
        partial = true;
        events.push({
          actualInventoryUnitId: row.inventory_unit_id,
          roomId: row.room_id,
          serviceDate: row.service_date,
          sourceStartDate: row.service_date,
          sourceEndDate: dateAfter(row.service_date),
          sourceKey: `unknown:${row.claim_id}`,
          sourceKind: "UNIT_UNSELLABLE",
          status: "UNKNOWN",
          attention: null,
          operationalAttention: null,
          label: "Unresolved unavailable inventory claim",
          primaryOccupantLabel: null,
          reason: "A legacy unavailable inventory source could not be resolved",
          blocking: true,
          current: true,
          blockingFactKind: "CLAIM",
          claimId: row.claim_id,
          references: [claimRef],
          histories: [fallbackHistory],
          commandIds: [],
          targetReference: null
        });
        continue;
      }
      const invalidActiveReleased = row.internal_status !== "ACTIVE";
      if (invalidActiveReleased) partial = true;
      const unavailableUnit = unitsById.get(row.inventory_unit_id);
      const unavailableUnitRef = reference("INVENTORY_UNIT", row.inventory_unit_id, unavailableUnit?.name ?? row.inventory_unit_id);
      events.push({
        actualInventoryUnitId: row.inventory_unit_id,
        roomId: row.room_id,
        serviceDate: row.service_date,
        sourceStartDate: row.internal_arrival_date!,
        sourceEndDate: row.internal_departure_date!,
        sourceKey: `legacy-unavailable:${row.internal_id}`,
        sourceKind: "UNIT_UNSELLABLE",
        status: "UNKNOWN",
        attention: null,
        operationalAttention: null,
        label: invalidActiveReleased ? "Inconsistent unavailable inventory history" : "Legacy unavailable inventory history",
        primaryOccupantLabel: null,
        reason: null,
        blocking: row.active,
        current: row.active,
        blockingFactKind: row.active ? "UNIT_UNSELLABLE" : null,
        claimId: null,
        references: [unavailableUnitRef],
        histories: [fallbackHistory],
        commandIds: [],
        targetReference: null
      });
    }

    const activeDeferredClaimDates = new Set(claimRows.flatMap((row) => (
      row.source_type === "INTERNAL_USE" && row.active
        ? [`${row.source_id}:${row.inventory_unit_id}:${row.service_date}`]
        : []
    )));
    for (const block of deferredUnavailableRows) {
      const unit = unitsById.get(block.inventory_unit_id);
      const unitRef = reference("INVENTORY_UNIT", block.inventory_unit_id, unit?.name ?? block.inventory_unit_id);
      for (const serviceDate of dates) {
        if (serviceDate < block.arrival_date || serviceDate >= block.departure_date) continue;
        if (activeDeferredClaimDates.has(`${block.id}:${block.inventory_unit_id}:${serviceDate}`)) continue;
        events.push({
          actualInventoryUnitId: block.inventory_unit_id,
          roomId: block.room_id,
          serviceDate,
          sourceStartDate: block.arrival_date,
          sourceEndDate: block.departure_date,
          sourceKey: `legacy-unavailable:${block.id}`,
          sourceKind: "UNIT_UNSELLABLE",
          status: "UNKNOWN",
          attention: null,
          operationalAttention: null,
          label: "Legacy unavailable inventory history",
          primaryOccupantLabel: null,
          reason: null,
          blocking: true,
          current: true,
          blockingFactKind: "UNIT_UNSELLABLE",
          claimId: null,
          references: [unitRef],
          histories: [{
            action: "LEGACY_UNAVAILABLE",
            actorId: null,
            source: "UNKNOWN",
            occurredAt: iso(block.created_at),
            commandId: null,
            receiptId: null,
            correlationId: null
          }],
          commandIds: [],
          targetReference: null
        });
      }
    }

    const cleaningCandidates = currentReleaseFeatures.cleaningWorkflow ? await trx.selectFrom("cleaning_tasks")
      .selectAll()
      .where("property_id", "=", options.propertyId)
      .where((expression) => expression.or([
        expression("service_date", "<=", businessDate),
        expression.and([
          expression("service_date", ">=", options.arrivalDate),
          expression("service_date", "<", options.departureDate)
        ])
      ]))
      .where("status", "=", "PENDING")
      .orderBy("service_date")
      .orderBy("id")
      .limit(ROOM_STATUS_OPERATIONAL_TASK_LIMIT + 1)
      .execute() : [];
    const cleaningRowsTruncated = cleaningCandidates.length > ROOM_STATUS_OPERATIONAL_TASK_LIMIT;
    if (cleaningRowsTruncated) partial = true;
    const cleaningRows = cleaningCandidates.slice(0, ROOM_STATUS_OPERATIONAL_TASK_LIMIT);
    for (const task of cleaningRows) {
      const taskRef = reference("OPERATIONS", task.id, `Cleaning ${task.id}`);
      const orderRef = reference("ORDER", task.order_id, `Order ${task.order_id}`, `/orders/${task.order_id}`);
      events.push({
        actualInventoryUnitId: task.inventory_unit_id,
        roomId: task.room_id,
        serviceDate: task.service_date,
        sourceStartDate: task.service_date,
        sourceEndDate: dateAfter(task.service_date),
        sourceKey: `cleaning:${task.id}`,
        sourceKind: "CLEANING",
        status: "CLEANING",
        attention: null,
        operationalAttention: null,
        label: "Cleaning pending",
        primaryOccupantLabel: null,
        reason: null,
        blocking: false,
        current: true,
        blockingFactKind: null,
        claimId: null,
        references: [taskRef, orderRef, reference("STAY", task.stay_id, `Stay ${task.stay_id}`)],
        histories: [],
        commandIds: [task.created_by_command_id],
        targetReference: taskRef
      });
    }

    for (const unit of unitsById.values()) {
      if (unit.active) continue;
      for (const serviceDate of dates) {
        const unitRef = reference("INVENTORY_UNIT", unit.id, unit.name);
        events.push({
          actualInventoryUnitId: unit.id,
          roomId: unit.roomId,
          serviceDate,
          sourceStartDate: options.arrivalDate,
          sourceEndDate: options.departureDate,
          sourceKey: `unsellable:${unit.id}`,
          sourceKind: "UNIT_UNSELLABLE",
          status: "UNAVAILABLE",
          attention: null,
          operationalAttention: null,
          label: "Unit unavailable",
          primaryOccupantLabel: null,
          reason: "The inventory unit is inactive",
          blocking: true,
          current: true,
          blockingFactKind: "UNIT_UNSELLABLE",
          claimId: null,
          references: [unitRef],
          histories: [],
          commandIds: [],
          targetReference: unitRef
        });
      }
    }

    const attachAmendments = (event: ProjectionEvent): ProjectionEvent => {
      if (!event.orderId) return event;
      const amendments = amendmentsByOrder.get(event.orderId) ?? [];
      return {
        ...event,
        histories: uniqueHistories([
          ...event.histories,
          ...amendments.map((amendment): RoomStatusHistoryDto => ({
            action: amendment.amendment_type,
            actorId: null,
            source: "UNKNOWN",
            occurredAt: iso(amendment.created_at),
            commandId: amendment.command_id,
            receiptId: null,
            correlationId: null
          }))
        ]),
        commandIds: [...new Set([
          ...event.commandIds,
          ...amendments.flatMap((amendment) => amendment.command_id ? [amendment.command_id] : [])
        ])]
      };
    };
    const eventsWithAmendments = events.map(attachAmendments);
    const projectedOperationalTaskSeeds = operationalTaskSeeds.map((seed) => ({
      ...seed,
      event: projectActiveArrearsEvent(seed.event, "CURRENT_OPERATIONAL_TASK")
    }));
    const taskSeedsWithAmendments = projectedOperationalTaskSeeds.map((seed) => ({ ...seed, event: attachAmendments(seed.event) }));
    const commandIds = [...new Set([
      ...eventsWithAmendments.flatMap((event) => event.commandIds),
      ...taskSeedsWithAmendments.flatMap((seed) => seed.event.commandIds)
    ])];
    const commandProjections = await loadCommandProjections(trx, commandIds, options.requestingSubjectId);
    const projectedEvents = eventsWithAmendments.map((event) => attachCommandProjection(event, commandProjections));
    const isHiddenCurrentBlockingFact = (event: ProjectionEvent) => event.current
      && event.blocking
      && !displayUnitsById.has(event.actualInventoryUnitId)
      && !isSyntheticInactiveUnitEvent(event);
    if (projectedEvents.some(isHiddenCurrentBlockingFact)) {
      partial = true;
    }
    const gridEvents = projectedEvents.filter((event) => options.arrivalDate <= event.serviceDate && event.serviceDate < options.departureDate);
    const taskExceptionEvents = projectedEvents.filter((event) => event.current
      && !isSyntheticInactiveUnitEvent(event)
      && (isHiddenCurrentBlockingFact(event)
        || ((event.serviceDate === businessDate || event.sourceKind === "CLEANING" && event.serviceDate < businessDate)
          && (event.sourceKind !== "ORDER" && event.sourceKind !== "FREE_STAY" || event.status === "UNKNOWN"))));
    const builtIntervals = buildIntervals(gridEvents, unitsById, displayUnitsById, options.accessLevel, options.commandGrants);
    const builtBedOccupancies = buildBedOccupancies(gridEvents, unitsById, displayUnitsById, dates);
    const builtBedSlotStates = buildBedSlotStates(gridEvents, displayUnitsById, dates, businessDate);
    if (builtBedOccupancies.partial) partial = true;
    if (builtBedSlotStates.partial) partial = true;
    const uniqueTaskExceptionEvents = [...new Map(taskExceptionEvents.map((event) => [
      `${event.sourceKey}:${event.actualInventoryUnitId}`,
      event
    ])).values()];
    const sortedOperationalTasks: RoomStatusOperationalTaskDto[] = [
      ...taskSeedsWithAmendments.map((seed) => operationalTaskFromSeed(seed, commandProjections, options.accessLevel, options.commandGrants)),
      ...uniqueTaskExceptionEvents.map((event) => operationalTaskFromSeed({
        taskKind: "EXCEPTION",
        businessDate,
        startDate: event.sourceStartDate,
        endDate: event.sourceEndDate,
        event
      }, new Map(), options.accessLevel, options.commandGrants))
    ].sort((left, right) => left.taskKind.localeCompare(right.taskKind)
      || left.startDate.localeCompare(right.startDate)
      || left.id.localeCompare(right.id));
    if (sortedOperationalTasks.length > ROOM_STATUS_OPERATIONAL_TASK_LIMIT) partial = true;
    const operationalTasks = sortedOperationalTasks.slice(0, ROOM_STATUS_OPERATIONAL_TASK_LIMIT);

    const baseRooms = roomRows.filter((roomRow) => roomRow.active)
      .map((roomRow) => displayUnitsById.get(roomRow.id)!);
    const statusesByUnit = buildUnitStatuses(displayUnitsById, dates, builtIntervals.byUnit, businessDate);
    const availabilitySummary = buildAvailabilitySummary(baseRooms, displayUnitsById, dates, builtIntervals.byUnit, businessDate);
    const filterOptions = roomStatusFilterOptions(baseRooms, displayUnitsById, statusesByUnit);
    const filteredRooms = filterRoomSelections(baseRooms, displayUnitsById, filters, statusesByUnit);
    const totalRooms = filteredRooms.length;
    const pageSelections = filteredRooms.slice(page * pageSize, (page + 1) * pageSize);
    const rooms = pageSelections.map(({ room: baseRoom, childUnitIds }) => {
      const children = childUnitIds.map((childId) => {
        const child = displayUnitsById.get(childId)!;
        return assembleUnit(child, dates, builtIntervals.byUnit.get(child.id) ?? [],
          builtIntervals.claimIdsByIntervalAndDate, options.accessLevel, businessDate, options.commandGrants);
      });
      return {
        ...assembleUnit(
          baseRoom,
          dates,
          builtIntervals.byUnit.get(baseRoom.id) ?? [],
          builtIntervals.claimIdsByIntervalAndDate,
          options.accessLevel,
          businessDate,
          options.commandGrants
        ),
        bedOccupancies: builtBedOccupancies.byRoom.get(baseRoom.id) ?? [],
        bedSlotStates: builtBedSlotStates.byRoom.get(baseRoom.id) ?? [],
        children
      };
    });

    return {
      propertyId: options.propertyId,
      businessDate,
      range: { arrivalDate: options.arrivalDate, departureDate: options.departureDate },
      dates,
      asOf,
      freshUntil,
      revision: String(property.revision ?? "0"),
      accessLevel: options.accessLevel,
      projectionState: partial ? "PARTIAL" : "READY",
      filterOptions,
      page: {
        index: page,
        size: pageSize,
        totalRooms,
        totalPages: totalRooms === 0 ? 0 : Math.ceil(totalRooms / pageSize)
      },
      operationalTasks,
      availabilitySummary,
      rooms
    };
  });
}
