import { roomStatusUnitDescription } from "./roomStatusPresentation";
import {
  ROOM_STATUS_MAX_QUERY_NIGHTS,
  roomStatusStatuses,
  type FreeStayCategoryCode,
  type RoomStatusIntervalDto,
  type RoomStatusSourceCategory,
  type RoomStatusSourceKind,
  type RoomStatusStatus,
  type RoomStatusUnitDto
} from "@qintopia/contracts";

export const ROOM_STATUS_TIMELINE_DAYS = 30;
export const MAX_VISIBLE_DAYS = ROOM_STATUS_TIMELINE_DAYS;
export const DEFAULT_VISIBLE_DAYS = ROOM_STATUS_TIMELINE_DAYS;
const MAX_RESTORABLE_STAY_NIGHTS = 366;
/** Legacy values remain readable so saved pre-stage-14 views can be migrated once. */
export type RoomStatusDateWindowMode = "30" | "AUTO" | "7" | "14" | "21";

export type RoomStatusKindFilter = "ALL" | RoomStatusUnitDto["kind"];
export type RoomStatusSalesModeFilter = "ALL" | RoomStatusUnitDto["salesMode"];
export type RoomStatusStatusFilter = "ALL" | RoomStatusStatus;

export interface RoomStatusFilters {
  search: string;
  roomTypeCode: string;
  salesMode: RoomStatusSalesModeFilter;
  status: RoomStatusStatusFilter;
  kind: RoomStatusKindFilter;
  minimumCapacity: number | null;
}

export interface RoomStatusSelection {
  unitId: string;
  anchorDate: string;
  focusDate: string;
  arrivalDate: string;
  departureDate: string;
}

export interface RoomStatusCellFocus {
  unitId: string;
  serviceDate: string;
}

export interface RoomStatusScrollAnchor {
  unitId: string | null;
  left: number;
  top: number;
}

export interface RoomStatusViewState {
  filters: RoomStatusFilters;
  expandedRoomIds: string[];
  roomPageIndex: number;
  dateWindowStart: number;
  dateWindowSize: number;
  dateWindowMode: RoomStatusDateWindowMode;
  focusedCell: RoomStatusCellFocus | null;
  selection: RoomStatusSelection | null;
  scrollAnchor: RoomStatusScrollAnchor;
}

export type RoomStatusViewAction =
  | { type: "SET_FILTERS"; filters: RoomStatusFilters }
  | { type: "CLEAR_FILTERS" }
  | { type: "TOGGLE_ROOM"; roomId: string }
  | { type: "SET_ROOM_PAGE"; index: number; totalPages: number }
  | { type: "SET_DATE_WINDOW"; start: number; size?: number; totalDates: number }
  | { type: "SET_DATE_WINDOW_MODE"; mode: RoomStatusDateWindowMode; autoSize: number; totalDates: number }
  | { type: "SHIFT_DATE_WINDOW"; direction: -1 | 1; totalDates: number }
  | { type: "SET_FOCUS"; focus: RoomStatusCellFocus | null }
  | { type: "MOVE_FOCUS"; unitIds: string[]; dates: string[]; rowDelta: number; columnDelta: number; extendSelection: boolean }
  | { type: "SELECT_CELL"; unitId: string; serviceDate: string; extend: boolean }
  | { type: "SET_SELECTION"; selection: RoomStatusSelection | null }
  | { type: "SET_SCROLL_ANCHOR"; anchor: RoomStatusScrollAnchor }
  | { type: "RESTORE"; state: RoomStatusViewState };

export interface FilteredRoomStatusRoom {
  room: RoomStatusUnitDto;
  children: RoomStatusUnitDto[];
}

export interface RoomStatusOrderIdentity {
  orderId: string;
  stayId: string;
  intervalId: string;
  unitId: string;
  intervalStartDate: string;
  intervalEndDate: string;
  arrivalDate: string;
  departureDate: string;
}

export interface RoomStatusOrderReturnTarget {
  version: 1;
  propertyId: string;
  orderId: string;
  stayId: string;
  triggerDate: string;
}

export interface RoomStatusOrderReturnState {
  fromRoomStatus: true;
  roomStatusOrderReturn: RoomStatusOrderReturnTarget;
}

export type RoomStatusOrderReturnResolution =
  | { kind: "MATCH"; identity: RoomStatusOrderIdentity }
  | { kind: "NOT_FOUND" }
  | { kind: "AMBIGUOUS" };

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === allowedKeys.length && keys.every((key) => allowedKeys.includes(key));
}

function stableReferenceId(interval: RoomStatusIntervalDto, type: "ORDER" | "STAY"): string | null {
  const ids = [...new Set(interval.references.filter((reference) => reference.type === type).map((reference) => reference.id))];
  return ids.length === 1 ? ids[0]! : null;
}

const lodgingStatuses = new Set<RoomStatusStatus>(["RESERVED", "IN_HOUSE", "SETTLED", "ARREARS", "UNKNOWN"]);

function isLodgingInterval(interval: RoomStatusIntervalDto): boolean {
  return (interval.sourceKind === "ORDER" || interval.sourceKind === "FREE_STAY")
    && lodgingStatuses.has(interval.status);
}

export function roomStatusIntervalBusinessPeriod(
  interval: Pick<RoomStatusIntervalDto,
    "sourceKind" | "sourceStartDate" | "sourceEndDate" | "orderArrivalDate" | "orderDepartureDate">
): { arrivalDate: string; departureDate: string } {
  const lodging = interval.sourceKind === "ORDER" || interval.sourceKind === "FREE_STAY";
  return {
    arrivalDate: lodging ? interval.orderArrivalDate ?? interval.sourceStartDate : interval.sourceStartDate,
    departureDate: lodging ? interval.orderDepartureDate ?? interval.sourceEndDate : interval.sourceEndDate
  };
}

export function roomStatusOrderIdentityForInterval(interval: RoomStatusIntervalDto): RoomStatusOrderIdentity | null {
  if (!isLodgingInterval(interval)) return null;
  const orderId = stableReferenceId(interval, "ORDER");
  const stayId = stableReferenceId(interval, "STAY");
  const businessPeriod = roomStatusIntervalBusinessPeriod(interval);
  return orderId && stayId ? {
    orderId,
    stayId,
    intervalId: interval.id,
    unitId: interval.actualInventoryUnitId,
    intervalStartDate: interval.startDate,
    intervalEndDate: interval.endDate,
    arrivalDate: businessPeriod.arrivalDate,
    departureDate: businessPeriod.departureDate
  } : null;
}

export function roomStatusOrderIdentityForDate(
  unit: RoomStatusUnitDto,
  serviceDate: string
): RoomStatusOrderIdentity | null {
  const matches = unit.intervals.filter((interval) => (
    interval.actualInventoryUnitId === unit.id
    && interval.startDate <= serviceDate
    && serviceDate < interval.endDate
    && isLodgingInterval(interval)
  )).flatMap((interval) => roomStatusOrderIdentityForInterval(interval) ?? []);
  const identities = new Set(matches.map((match) => `${match.orderId}:${match.stayId}`));
  return identities.size === 1 ? matches[0]! : null;
}

export interface RoomStatusOrderOption {
  identity: RoomStatusOrderIdentity;
  label: string;
  operationalAttention: RoomStatusIntervalDto["operationalAttention"];
  source: {
    sourceKind: Extract<RoomStatusSourceKind, "ORDER" | "FREE_STAY">;
    sourceCategory: RoomStatusSourceCategory | null;
    freeStayCategoryCode: FreeStayCategoryCode | null;
    freeStayReason: string | null;
  };
}

export type RoomStatusOrderOptionsResult =
  | { kind: "READY"; orders: RoomStatusOrderOption[] }
  | { kind: "INVALID_REFERENCE" };

export function roomStatusUniqueOrderStayId(options: RoomStatusOrderOptionsResult): string | null {
  return options.kind === "READY" && options.orders.length === 1
    ? options.orders[0]!.identity.stayId
    : null;
}

function roomStatusOrderOptions(
  unit: RoomStatusUnitDto,
  includesInterval: (interval: RoomStatusIntervalDto) => boolean
): RoomStatusOrderOptionsResult {
  const candidates = unit.kind === "ROOM" && unit.salesMode === "BED_SPLIT"
    ? [unit, ...unit.children]
    : [unit];
  const intervals = candidates.flatMap((candidate) => candidate.intervals)
    .filter((interval) => includesInterval(interval) && isLodgingInterval(interval));
  const options: RoomStatusOrderOption[] = [];
  for (const interval of intervals) {
    const identity = roomStatusOrderIdentityForInterval(interval);
    if (!identity) return { kind: "INVALID_REFERENCE" };
    const occupantLabel = interval.primaryOccupantLabel?.trim()
      || interval.occupants.find((occupant) => occupant.nickname?.trim())?.nickname?.trim()
      || "住宿订单";
    options.push({
      identity,
      label: occupantLabel,
      operationalAttention: interval.operationalAttention,
      source: {
        sourceKind: interval.sourceKind as Extract<RoomStatusSourceKind, "ORDER" | "FREE_STAY">,
        sourceCategory: interval.sourceCategory,
        freeStayCategoryCode: interval.freeStayCategoryCode,
        freeStayReason: interval.freeStayReason
      }
    });
  }
  const unique = new Map<string, RoomStatusOrderOption>();
  const stayByOrder = new Map<string, string>();
  const orderByStay = new Map<string, string>();
  for (const option of options) {
    const { orderId, stayId } = option.identity;
    if ((stayByOrder.has(orderId) && stayByOrder.get(orderId) !== stayId)
      || (orderByStay.has(stayId) && orderByStay.get(stayId) !== orderId)) {
      return { kind: "INVALID_REFERENCE" };
    }
    stayByOrder.set(orderId, stayId);
    orderByStay.set(stayId, orderId);
    const key = JSON.stringify([option.identity.orderId, option.identity.stayId]);
    const existing = unique.get(key);
    if (existing && (existing.identity.unitId !== option.identity.unitId
      || existing.identity.arrivalDate !== option.identity.arrivalDate
      || existing.identity.departureDate !== option.identity.departureDate)) {
      return { kind: "INVALID_REFERENCE" };
    }
    if (!existing) unique.set(key, option);
  }
  return { kind: "READY", orders: [...unique.values()] };
}

export function roomStatusOrderOptionsForDate(
  unit: RoomStatusUnitDto,
  serviceDate: string
): RoomStatusOrderOptionsResult {
  return roomStatusOrderOptions(unit, (interval) => (
    interval.startDate <= serviceDate && serviceDate < interval.endDate
  ));
}

export function roomStatusOrderOptionsForSelection(
  unit: RoomStatusUnitDto,
  selection: Pick<RoomStatusSelection, "unitId" | "arrivalDate" | "departureDate">
): RoomStatusOrderOptionsResult {
  if (selection.unitId !== unit.id || selection.arrivalDate >= selection.departureDate) {
    return { kind: "READY", orders: [] };
  }
  return roomStatusOrderOptions(unit, (interval) => (
    interval.startDate < selection.departureDate && selection.arrivalDate < interval.endDate
  ));
}

export function createRoomStatusOrderReturnState(
  propertyId: string,
  identity: Pick<RoomStatusOrderIdentity, "orderId" | "stayId" | "arrivalDate" | "departureDate">,
  triggerDate?: string
): RoomStatusOrderReturnState {
  const requestedTriggerDate = triggerDate && isIsoLocalDate(triggerDate) ? triggerDate : identity.arrivalDate;
  const triggerDateInStay = isIsoLocalDate(identity.arrivalDate)
    && isIsoLocalDate(identity.departureDate)
    && identity.arrivalDate < identity.departureDate
    ? requestedTriggerDate < identity.arrivalDate
      ? identity.arrivalDate
      : requestedTriggerDate >= identity.departureDate
        ? addLocalDateDays(identity.departureDate, -1)
        : requestedTriggerDate
    : requestedTriggerDate;
  return {
    fromRoomStatus: true,
    roomStatusOrderReturn: {
      version: 1,
      propertyId,
      orderId: identity.orderId,
      stayId: identity.stayId,
      triggerDate: triggerDateInStay
    }
  };
}

export function hasRoomStatusOrderReturnEnvelope(state: unknown): boolean {
  return Boolean(state
    && typeof state === "object"
    && !Array.isArray(state)
    && Object.prototype.hasOwnProperty.call(state, "roomStatusOrderReturn"));
}

export function parseRoomStatusOrderReturnTarget(
  state: unknown
): RoomStatusOrderReturnTarget | null {
  if (!state || typeof state !== "object" || Array.isArray(state)) return null;
  const routeState = state as Record<string, unknown>;
  if (!hasOnlyKeys(routeState, ["fromRoomStatus", "roomStatusOrderReturn"])
    || routeState.fromRoomStatus !== true) return null;
  const target = routeState.roomStatusOrderReturn;
  if (!target || typeof target !== "object" || Array.isArray(target)) return null;
  const value = target as Record<string, unknown>;
  if (!hasOnlyKeys(value, ["version", "propertyId", "orderId", "stayId", "triggerDate"])
    || value.version !== 1
    || typeof value.propertyId !== "string" || value.propertyId !== value.propertyId.trim() || !value.propertyId || value.propertyId.length > 200
    || typeof value.orderId !== "string" || value.orderId !== value.orderId.trim() || !value.orderId || value.orderId.length > 200
    || typeof value.stayId !== "string" || value.stayId !== value.stayId.trim() || !value.stayId || value.stayId.length > 200
    || typeof value.triggerDate !== "string" || !isIsoLocalDate(value.triggerDate)) return null;
  return {
    version: 1,
    propertyId: value.propertyId,
    orderId: value.orderId,
    stayId: value.stayId,
    triggerDate: value.triggerDate
  };
}

export function resolveRoomStatusOrderReturnTarget(
  units: readonly RoomStatusUnitDto[],
  target: Pick<RoomStatusOrderReturnTarget, "orderId" | "stayId" | "triggerDate">
): RoomStatusOrderReturnResolution {
  const matches = units.flatMap((unit) => unit.intervals.flatMap((interval) => {
    const identity = roomStatusOrderIdentityForInterval(interval);
    return identity?.orderId === target.orderId && identity.stayId === target.stayId
      ? [{ identity, direct: unit.id === identity.unitId }]
      : [];
  }));
  const matchesByPlacement = new Map<string, Array<{ identity: RoomStatusOrderIdentity; direct: boolean }>>();
  for (const match of matches) {
    const key = JSON.stringify([
      match.identity.orderId,
      match.identity.stayId,
      match.identity.unitId,
      match.identity.intervalStartDate,
      match.identity.intervalEndDate
    ]);
    const placement = matchesByPlacement.get(key) ?? [];
    placement.push(match);
    matchesByPlacement.set(key, placement);
  }
  const uniqueMatches = [...matchesByPlacement.values()].flatMap((placement) => {
    const directMatches = placement.filter((match) => match.direct);
    const canonicalMatches = directMatches.length > 0 ? directMatches : placement;
    const uniqueIntervals = new Map(canonicalMatches.map((match) => [match.identity.intervalId, match.identity]));
    return [...uniqueIntervals.values()];
  }).sort((left, right) => (
    left.intervalStartDate.localeCompare(right.intervalStartDate)
    || left.intervalEndDate.localeCompare(right.intervalEndDate)
    || left.unitId.localeCompare(right.unitId)
  ));
  const triggerMatches = uniqueMatches.filter((identity) => (
    identity.intervalStartDate <= target.triggerDate && target.triggerDate < identity.intervalEndDate
  ));
  if (triggerMatches.length === 0) return { kind: "NOT_FOUND" };
  if (triggerMatches.length > 1) return { kind: "AMBIGUOUS" };
  return { kind: "MATCH", identity: triggerMatches[0]! };
}

export function roomStatusOrderIdentityForReturnTarget(
  units: readonly RoomStatusUnitDto[],
  target: Pick<RoomStatusOrderReturnTarget, "orderId" | "stayId" | "triggerDate">
): RoomStatusOrderIdentity | null {
  const resolution = resolveRoomStatusOrderReturnTarget(units, target);
  return resolution.kind === "MATCH" ? resolution.identity : null;
}

export function roomStatusCellBelongsToStay(
  unit: RoomStatusUnitDto,
  serviceDate: string,
  stayId: string
): boolean {
  return roomStatusOrderIdentityForDate(unit, serviceDate)?.stayId === stayId;
}

export function intervalsRenderedOnRoomStatusGrid(
  unit: RoomStatusUnitDto,
  serviceDates: readonly string[] = unit.days.map((day) => day.serviceDate)
): readonly RoomStatusIntervalDto[] {
  void serviceDates;
  // Lodging belongs exclusively in its daily cells. Only operational blocks keep timeline bars.
  return unit.intervals.filter((interval) => (
    interval.sourceKind !== "ORDER" && interval.sourceKind !== "FREE_STAY"
  ));
}

export interface RoomStatusFilterOptions {
  roomTypeCodes: string[];
  roomTypeLabels?: Record<string, string>;
  salesModes: RoomStatusUnitDto["salesMode"][];
  statuses: RoomStatusStatus[];
  capacities: number[];
}

export interface RoomStatusRestorationSnapshot {
  version: 1;
  propertyId: string;
  range: {
    arrivalDate: string;
    departureDate: string;
  };
  revision: string;
  savedAt: string;
  state: RoomStatusViewState;
  factFingerprint?: string | null;
}

export interface RoomStatusRestorationResolution {
  state: RoomStatusViewState;
  outcome: "RESTORED" | "FACT_CHANGED" | "FALLBACK" | "EMPTY";
  filtersCleared: boolean;
  dateWindowAdjusted: boolean;
  scrollAnchorAdjusted: boolean;
}

function actionFingerprint(actions: readonly RoomStatusUnitDto["allowedActions"][number][]) {
  return actions.map((action) => ({
    code: action.code,
    enabled: action.enabled,
    disabledReason: action.disabledReason,
    requiresFullInterval: action.requiresFullInterval,
    target: action.targetReference ? `${action.targetReference.type}:${action.targetReference.id}` : null
  })).sort((left, right) => `${left.code}:${left.target ?? ""}`.localeCompare(`${right.code}:${right.target ?? ""}`));
}

export function roomStatusFactFingerprint(
  rooms: readonly RoomStatusUnitDto[],
  state: Pick<RoomStatusViewState, "focusedCell" | "selection">
): string | null {
  const target = state.selection
    ? {
        unitId: state.selection.unitId,
        arrivalDate: state.selection.arrivalDate,
        departureDate: state.selection.departureDate
      }
    : state.focusedCell
      ? {
          unitId: state.focusedCell.unitId,
          arrivalDate: state.focusedCell.serviceDate,
          departureDate: addLocalDateDays(state.focusedCell.serviceDate, 1)
        }
      : null;
  if (!target) return null;
  const unit = rooms.flatMap((room) => [room, ...room.children]).find((candidate) => candidate.id === target.unitId);
  if (!unit) return `missing:${target.unitId}:${target.arrivalDate}:${target.departureDate}`;
  const days = unit.days
    .filter((day) => day.serviceDate >= target.arrivalDate && day.serviceDate < target.departureDate)
    .map((day) => ({
      serviceDate: day.serviceDate,
      status: day.status,
      available: day.available,
      intervalIds: [...day.intervalIds].sort(),
      conflicts: day.conflicts.map((conflict) => ({
        id: conflict.id,
        claimId: conflict.claimId,
        claimIds: [...conflict.claimIds].sort(),
        requestedInventoryUnitId: conflict.requestedInventoryUnitId,
        actualInventoryUnitId: conflict.actualInventoryUnitId,
        startDate: conflict.startDate,
        endDate: conflict.endDate,
        sourceKind: conflict.sourceKind,
        sourceId: conflict.sourceReference.id,
        reason: conflict.reason
      })).sort((left, right) => left.id.localeCompare(right.id))
    }));
  const intervals = unit.intervals
    .filter((interval) => interval.endDate > target.arrivalDate && interval.startDate < target.departureDate)
    .map((interval) => ({
      id: interval.id,
      actualInventoryUnitId: interval.actualInventoryUnitId,
      startDate: interval.startDate,
      endDate: interval.endDate,
      sourceStartDate: interval.sourceStartDate,
      sourceEndDate: interval.sourceEndDate,
      orderArrivalDate: interval.orderArrivalDate ?? null,
      orderDepartureDate: interval.orderDepartureDate ?? null,
      status: interval.status,
      attention: interval.attention,
      operationalAttention: interval.operationalAttention,
      available: interval.available,
      blocking: interval.blocking,
      sourceKind: interval.sourceKind,
      label: interval.label,
      primaryOccupantLabel: interval.primaryOccupantLabel,
      reason: interval.reason,
      claimIds: [...interval.claimIds].sort(),
      references: interval.references.map((reference) => `${reference.type}:${reference.id}`).sort(),
      conflicts: interval.conflicts.map((conflict) => `${conflict.id}:${conflict.claimId}`).sort(),
      history: interval.history.map((item) => `${item.occurredAt}:${item.action}:${item.commandId ?? ""}:${item.receiptId ?? ""}`).sort(),
      allowedActions: actionFingerprint(interval.allowedActions)
    })).sort((left, right) => left.id.localeCompare(right.id));
  const bedOccupancies = unit.bedOccupancies
    .filter((occupancy) => occupancy.serviceDate >= target.arrivalDate && occupancy.serviceDate < target.departureDate)
    .map((occupancy) => ({
      serviceDate: occupancy.serviceDate,
      occupiedBedCount: occupancy.occupiedBedCount,
      totalBedCount: occupancy.totalBedCount,
      occupants: occupancy.occupants.map((occupant) => ({
        inventoryUnitId: occupant.inventoryUnitId,
        primaryOccupantLabel: occupant.primaryOccupantLabel,
        sourceReference: `${occupant.sourceReference.type}:${occupant.sourceReference.id}`
      })).sort((left, right) => left.inventoryUnitId.localeCompare(right.inventoryUnitId))
    }));
  const bedSlotStates = unit.bedSlotStates
    .filter((slot) => slot.serviceDate >= target.arrivalDate && slot.serviceDate < target.departureDate)
    .map((slot) => ({
      serviceDate: slot.serviceDate,
      inventoryUnitId: slot.inventoryUnitId,
      inventoryUnitCode: slot.inventoryUnitCode,
      status: slot.status
    }))
    .sort((left, right) => left.serviceDate.localeCompare(right.serviceDate)
      || left.inventoryUnitId.localeCompare(right.inventoryUnitId));
  return JSON.stringify({
    unitId: unit.id,
    active: unit.active,
    salesMode: unit.salesMode,
    physicalBedCount: unit.physicalBedCount,
    childUnitIds: [...unit.childUnitIds].sort(),
    targetRange: [target.arrivalDate, target.departureDate],
    allowedActions: actionFingerprint(unit.allowedActions),
    days,
    intervals,
    bedOccupancies,
    bedSlotStates
  });
}

export const DEFAULT_ROOM_STATUS_FILTERS: RoomStatusFilters = {
  search: "",
  roomTypeCode: "ALL",
  salesMode: "ALL",
  status: "ALL",
  kind: "ALL",
  minimumCapacity: null
};

export function createRoomStatusViewState(overrides: Partial<RoomStatusViewState> = {}): RoomStatusViewState {
  return {
    filters: DEFAULT_ROOM_STATUS_FILTERS,
    expandedRoomIds: [],
    roomPageIndex: 0,
    dateWindowStart: 0,
    dateWindowSize: ROOM_STATUS_TIMELINE_DAYS,
    dateWindowMode: "30",
    focusedCell: null,
    selection: null,
    scrollAnchor: { unitId: null, left: 0, top: 0 },
    ...overrides
  };
}

export function isIsoLocalDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function addLocalDateDays(value: string, days: number): string {
  if (!isIsoLocalDate(value)) throw new Error(`Invalid local date: ${value}`);
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

export function clampDateWindowStart(totalDates: number, requestedStart: number, requestedSize: number): number {
  const size = Math.min(MAX_VISIBLE_DAYS, Math.max(1, Math.trunc(requestedSize)));
  const maximum = Math.max(0, Math.trunc(totalDates) - size);
  return Math.min(maximum, Math.max(0, Math.trunc(requestedStart)));
}

export function visibleDateWindow(dates: readonly string[], requestedStart: number, requestedSize = DEFAULT_VISIBLE_DAYS): string[] {
  const size = Math.min(MAX_VISIBLE_DAYS, Math.max(1, Math.trunc(requestedSize)));
  const start = clampDateWindowStart(dates.length, requestedStart, size);
  return dates.slice(start, start + size);
}

export function shiftDateWindowStart(totalDates: number, currentStart: number, size: number, direction: -1 | 1): number {
  const boundedSize = Math.min(MAX_VISIBLE_DAYS, Math.max(1, Math.trunc(size)));
  return clampDateWindowStart(totalDates, currentStart + direction * boundedSize, boundedSize);
}

export function dateWindowStartForFocus(
  dates: readonly string[],
  currentStart: number,
  size: number,
  focusDate: string
): number {
  const boundedSize = Math.min(MAX_VISIBLE_DAYS, Math.max(1, Math.trunc(size)));
  const start = clampDateWindowStart(dates.length, currentStart, boundedSize);
  const focusIndex = dates.indexOf(focusDate);
  if (focusIndex < 0) return start;
  if (focusIndex < start) return clampDateWindowStart(dates.length, focusIndex, boundedSize);
  if (focusIndex >= start + boundedSize) {
    return clampDateWindowStart(dates.length, focusIndex - boundedSize + 1, boundedSize);
  }
  return start;
}

export function selectionFromCells(unitId: string, anchorDate: string, focusDate: string): RoomStatusSelection {
  if (!unitId || !isIsoLocalDate(anchorDate) || !isIsoLocalDate(focusDate)) throw new Error("Selection requires a unit and valid service dates");
  const arrivalDate = anchorDate <= focusDate ? anchorDate : focusDate;
  const finalServiceDate = anchorDate <= focusDate ? focusDate : anchorDate;
  return {
    unitId,
    anchorDate,
    focusDate,
    arrivalDate,
    departureDate: addLocalDateDays(finalServiceDate, 1)
  };
}

export function selectionFromInputs(unitId: string, arrivalDate: string, departureDate: string): RoomStatusSelection | null {
  if (!unitId || !isIsoLocalDate(arrivalDate) || !isIsoLocalDate(departureDate) || departureDate <= arrivalDate) return null;
  return {
    unitId,
    anchorDate: arrivalDate,
    focusDate: addLocalDateDays(departureDate, -1),
    arrivalDate,
    departureDate
  };
}

export function moveRoomStatusFocus(
  unitIds: readonly string[],
  dates: readonly string[],
  current: RoomStatusCellFocus | null,
  rowDelta: number,
  columnDelta: number
): RoomStatusCellFocus | null {
  if (!unitIds.length || !dates.length) return null;
  const currentRow = current ? unitIds.indexOf(current.unitId) : -1;
  const currentColumn = current ? dates.indexOf(current.serviceDate) : -1;
  const row = Math.min(unitIds.length - 1, Math.max(0, (currentRow < 0 ? 0 : currentRow) + rowDelta));
  const column = Math.min(dates.length - 1, Math.max(0, (currentColumn < 0 ? 0 : currentColumn) + columnDelta));
  return { unitId: unitIds[row]!, serviceDate: dates[column]! };
}

function normalizedSearch(value: string): string {
  return value.trim().toLocaleUpperCase("zh-CN");
}

function effectiveUnitValues(unit: RoomStatusUnitDto, room: RoomStatusUnitDto) {
  return {
    roomTypeCode: unit.roomTypeCode ?? room.roomTypeCode,
    salesMode: room.salesMode,
    capacity: room.capacity,
    searchText: [
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
    ].filter((value): value is string => Boolean(value)).join(" ").toLocaleUpperCase("zh-CN")
  };
}

function unitMatchesFilters(unit: RoomStatusUnitDto, room: RoomStatusUnitDto, filters: RoomStatusFilters): boolean {
  const effective = effectiveUnitValues(unit, room);
  const search = normalizedSearch(filters.search);
  if (search && !effective.searchText.includes(search)) return false;
  if (filters.roomTypeCode !== "ALL" && effective.roomTypeCode !== filters.roomTypeCode) return false;
  if (filters.salesMode !== "ALL" && effective.salesMode !== filters.salesMode) return false;
  if (filters.kind !== "ALL" && unit.kind !== filters.kind) return false;
  if (filters.minimumCapacity !== null && effective.capacity < filters.minimumCapacity) return false;
  if (filters.status !== "ALL" && !unit.days.some((day) => filters.status === "AVAILABLE"
    ? day.status === "AVAILABLE" && day.available
    : day.status === filters.status)) return false;
  return true;
}

export function filterRoomStatusRooms(rooms: readonly RoomStatusUnitDto[], filters: RoomStatusFilters): FilteredRoomStatusRoom[] {
  return rooms.flatMap((room) => {
    const children = room.salesMode === "BED_SPLIT"
      ? room.children.filter((child) => unitMatchesFilters(child, room, filters))
      : [];
    const roomMatches = unitMatchesFilters(room, room, filters);
    if (!roomMatches && children.length === 0) return [];
    return [{ room, children }];
  });
}

function renderedRoomStatusUnitIds(
  rooms: readonly RoomStatusUnitDto[],
  filters: RoomStatusFilters,
  expandedRoomIds: readonly string[]
): string[] {
  return filterRoomStatusRooms(rooms, filters).flatMap(({ room, children }) => [
    room.id,
    ...(room.salesMode === "BED_SPLIT" && expandedRoomIds.includes(room.id)
      ? children.map((child) => child.id)
      : [])
  ]);
}

function selectionIsRestorable(
  selection: RoomStatusSelection,
  visibleUnitIds: ReadonlySet<string>
): boolean {
  if (!visibleUnitIds.has(selection.unitId)) return false;
  if (selection.anchorDate < selection.arrivalDate
    || selection.anchorDate >= selection.departureDate
    || selection.focusDate < selection.arrivalDate
    || selection.focusDate >= selection.departureDate) return false;
  const nightCount = (Date.parse(`${selection.departureDate}T00:00:00Z`)
    - Date.parse(`${selection.arrivalDate}T00:00:00Z`)) / 86_400_000;
  return Number.isSafeInteger(nightCount)
    && nightCount > 0
    && nightCount <= MAX_RESTORABLE_STAY_NIGHTS;
}

export function roomStatusGridFocusForSelection(
  selection: RoomStatusSelection,
  visibleDates: readonly string[]
): RoomStatusCellFocus | null {
  if (visibleDates.includes(selection.focusDate)) {
    return { unitId: selection.unitId, serviceDate: selection.focusDate };
  }
  const visibleSelectedDate = visibleDates.find((date) => (
    date >= selection.arrivalDate && date < selection.departureDate
  ));
  return visibleSelectedDate
    ? { unitId: selection.unitId, serviceDate: visibleSelectedDate }
    : null;
}

export function reconcileRoomStatusRestoration(
  rooms: readonly RoomStatusUnitDto[],
  dates: readonly string[],
  state: RoomStatusViewState,
  expectedFactFingerprint?: string | null
): RoomStatusRestorationResolution {
  const timelineState = state.dateWindowSize === ROOM_STATUS_TIMELINE_DAYS && state.dateWindowMode === "30"
    ? state
    : { ...state, dateWindowSize: ROOM_STATUS_TIMELINE_DAYS, dateWindowMode: "30" as const };
  let clampedWindowStart = clampDateWindowStart(dates.length, timelineState.dateWindowStart, ROOM_STATUS_TIMELINE_DAYS);
  const restoredFocusDate = state.focusedCell?.serviceDate ?? state.selection?.focusDate;
  if (restoredFocusDate && dates.includes(restoredFocusDate)) {
    const tentativeWindow = visibleDateWindow(dates, clampedWindowStart, ROOM_STATUS_TIMELINE_DAYS);
    if (!tentativeWindow.includes(restoredFocusDate)) {
      clampedWindowStart = clampDateWindowStart(dates.length, dates.indexOf(restoredFocusDate), ROOM_STATUS_TIMELINE_DAYS);
    }
  }
  const dateWindowAdjusted = clampedWindowStart !== state.dateWindowStart
    || timelineState !== state;
  let nextState: RoomStatusViewState = dateWindowAdjusted
    ? { ...timelineState, dateWindowStart: clampedWindowStart }
    : timelineState;
  const visibleDates = visibleDateWindow(dates, clampedWindowStart, ROOM_STATUS_TIMELINE_DAYS);
  const visibleDateSet = new Set(visibleDates);
  let visibleUnitIds = renderedRoomStatusUnitIds(rooms, nextState.filters, nextState.expandedRoomIds);
  let filtersCleared = false;

  const focusVisible = !nextState.focusedCell || (visibleUnitIds.includes(nextState.focusedCell.unitId)
    && visibleDateSet.has(nextState.focusedCell.serviceDate));
  const selectionVisible = !nextState.selection
    || selectionIsRestorable(nextState.selection, new Set(visibleUnitIds));

  if (selectionVisible && (focusVisible || nextState.selection)) {
    const focusedCell = focusVisible && nextState.focusedCell
      ? nextState.focusedCell
      : nextState.selection
        ? roomStatusGridFocusForSelection(nextState.selection, visibleDates)
        : nextState.focusedCell;
    const scrollAnchorAdjusted = Boolean(nextState.scrollAnchor.unitId && !visibleUnitIds.includes(nextState.scrollAnchor.unitId));
    if (!sameFocus(focusedCell, nextState.focusedCell) || scrollAnchorAdjusted) {
      nextState = {
        ...nextState,
        focusedCell,
        ...(scrollAnchorAdjusted ? { scrollAnchor: { unitId: focusedCell?.unitId ?? visibleUnitIds[0] ?? null, left: 0, top: 0 } } : {})
      };
    }
    if (expectedFactFingerprint !== undefined
      && roomStatusFactFingerprint(rooms, nextState) !== expectedFactFingerprint) {
      const factFocus = nextState.selection
        ? (visibleDateSet.has(nextState.selection.arrivalDate)
            ? { unitId: nextState.selection.unitId, serviceDate: nextState.selection.arrivalDate }
            : roomStatusGridFocusForSelection(nextState.selection, visibleDates))
        : nextState.focusedCell;
      nextState = {
        ...nextState,
        focusedCell: factFocus,
        scrollAnchor: {
          ...nextState.scrollAnchor,
          unitId: nextState.selection?.unitId ?? factFocus?.unitId ?? nextState.scrollAnchor.unitId
        }
      };
      return { state: nextState, outcome: "FACT_CHANGED", filtersCleared, dateWindowAdjusted, scrollAnchorAdjusted };
    }
    return { state: nextState, outcome: "RESTORED", filtersCleared, dateWindowAdjusted, scrollAnchorAdjusted };
  }

  if (!visibleUnitIds.length && rooms.length) {
    filtersCleared = true;
    nextState = { ...nextState, filters: { ...DEFAULT_ROOM_STATUS_FILTERS } };
    visibleUnitIds = renderedRoomStatusUnitIds(rooms, nextState.filters, nextState.expandedRoomIds);
  }

  const fallbackUnitId = visibleUnitIds[0];
  const fallbackDate = visibleDates[0];
  if (!fallbackUnitId || !fallbackDate) {
    return {
      state: {
        ...nextState,
        focusedCell: null,
        selection: null,
        scrollAnchor: { unitId: null, left: 0, top: 0 }
      },
      outcome: "EMPTY",
      filtersCleared,
      dateWindowAdjusted,
      scrollAnchorAdjusted: true
    };
  }

  return {
    state: {
      ...nextState,
      focusedCell: { unitId: fallbackUnitId, serviceDate: fallbackDate },
      selection: null,
      scrollAnchor: { unitId: fallbackUnitId, left: 0, top: 0 }
    },
    outcome: "FALLBACK",
    filtersCleared,
    dateWindowAdjusted,
    scrollAnchorAdjusted: true
  };
}

export function hasActiveRoomStatusFilters(filters: RoomStatusFilters): boolean {
  return filters.search.trim() !== ""
    || filters.roomTypeCode !== "ALL"
    || filters.salesMode !== "ALL"
    || filters.status !== "ALL"
    || filters.kind !== "ALL"
    || filters.minimumCapacity !== null;
}

export function collectRoomStatusFilterOptions(rooms: readonly RoomStatusUnitDto[]): RoomStatusFilterOptions {
  const units = rooms.flatMap((room) => [room, ...room.children]);
  return {
    roomTypeLabels: Object.fromEntries(rooms.flatMap((room) => room.roomTypeCode ? [[room.roomTypeCode, roomStatusUnitDescription(room)]] : [])),
    roomTypeCodes: [...new Set(rooms.flatMap((room) => room.roomTypeCode ? [room.roomTypeCode] : []))].sort(),
    salesModes: [...new Set(rooms.map((room) => room.salesMode))].sort(),
    statuses: roomStatusStatuses.filter((status) => units.some((unit) => unit.days.some((day) => day.status === status))),
    capacities: [...new Set(rooms.map((room) => room.capacity).filter((capacity) => capacity > 0))].sort((left, right) => left - right)
  };
}

function sameSelectionUnit(selection: RoomStatusSelection | null, unitId: string): boolean {
  return Boolean(selection && selection.unitId === unitId);
}

function sameFocus(left: RoomStatusCellFocus | null, right: RoomStatusCellFocus | null): boolean {
  return left === right || Boolean(left && right
    && left.unitId === right.unitId
    && left.serviceDate === right.serviceDate);
}

function sameSelection(left: RoomStatusSelection | null, right: RoomStatusSelection | null): boolean {
  return left === right || Boolean(left && right
    && left.unitId === right.unitId
    && left.anchorDate === right.anchorDate
    && left.focusDate === right.focusDate
    && left.arrivalDate === right.arrivalDate
    && left.departureDate === right.departureDate);
}

export function roomStatusViewReducer(state: RoomStatusViewState, action: RoomStatusViewAction): RoomStatusViewState {
  if (action.type === "SET_FILTERS") {
    return {
      ...state,
      filters: action.filters,
      roomPageIndex: 0,
      focusedCell: null,
      selection: null
    };
  }
  if (action.type === "CLEAR_FILTERS") {
    return {
      ...state,
      filters: DEFAULT_ROOM_STATUS_FILTERS,
      roomPageIndex: 0,
      focusedCell: null,
      selection: null
    };
  }
  if (action.type === "TOGGLE_ROOM") {
    const expanded = state.expandedRoomIds.includes(action.roomId)
      ? state.expandedRoomIds.filter((id) => id !== action.roomId)
      : [...state.expandedRoomIds, action.roomId];
    return { ...state, expandedRoomIds: expanded };
  }
  if (action.type === "SET_ROOM_PAGE") {
    const maximum = Math.max(0, action.totalPages - 1);
    return { ...state, roomPageIndex: Math.min(maximum, Math.max(0, Math.trunc(action.index))) };
  }
  if (action.type === "SET_DATE_WINDOW") {
    return {
      ...state,
      dateWindowMode: "30",
      dateWindowSize: ROOM_STATUS_TIMELINE_DAYS,
      dateWindowStart: clampDateWindowStart(action.totalDates, action.start, ROOM_STATUS_TIMELINE_DAYS)
    };
  }
  if (action.type === "SET_DATE_WINDOW_MODE") {
    return {
      ...state,
      dateWindowMode: "30",
      dateWindowSize: ROOM_STATUS_TIMELINE_DAYS,
      dateWindowStart: clampDateWindowStart(action.totalDates, state.dateWindowStart, ROOM_STATUS_TIMELINE_DAYS)
    };
  }
  if (action.type === "SHIFT_DATE_WINDOW") {
    return { ...state, dateWindowStart: shiftDateWindowStart(action.totalDates, state.dateWindowStart, state.dateWindowSize, action.direction) };
  }
  if (action.type === "SET_FOCUS") {
    return sameFocus(state.focusedCell, action.focus) ? state : { ...state, focusedCell: action.focus };
  }
  if (action.type === "MOVE_FOCUS") {
    const nextFocus = moveRoomStatusFocus(action.unitIds, action.dates, state.focusedCell, action.rowDelta, action.columnDelta);
    if (!nextFocus) return state;
    const selection = action.extendSelection
      ? selectionFromCells(
        nextFocus.unitId,
        sameSelectionUnit(state.selection, nextFocus.unitId) ? state.selection!.anchorDate : (state.focusedCell?.serviceDate ?? nextFocus.serviceDate),
        nextFocus.serviceDate
      )
      : state.selection;
    return { ...state, focusedCell: nextFocus, selection };
  }
  if (action.type === "SELECT_CELL") {
    const anchorDate = action.extend && sameSelectionUnit(state.selection, action.unitId)
      ? state.selection!.anchorDate
      : action.serviceDate;
    return {
      ...state,
      focusedCell: { unitId: action.unitId, serviceDate: action.serviceDate },
      selection: selectionFromCells(action.unitId, anchorDate, action.serviceDate)
    };
  }
  if (action.type === "SET_SELECTION") {
    const nextFocus = action.selection
      ? { unitId: action.selection.unitId, serviceDate: action.selection.focusDate }
      : state.focusedCell;
    if (sameSelection(state.selection, action.selection) && sameFocus(state.focusedCell, nextFocus)) return state;
    return {
      ...state,
      selection: action.selection,
      focusedCell: nextFocus
    };
  }
  if (action.type === "SET_SCROLL_ANCHOR") {
    return state.scrollAnchor.unitId === action.anchor.unitId
      && state.scrollAnchor.left === action.anchor.left
      && state.scrollAnchor.top === action.anchor.top
      ? state
      : { ...state, scrollAnchor: action.anchor };
  }
  return action.type === "RESTORE"
    ? { ...action.state, dateWindowMode: "30", dateWindowSize: ROOM_STATUS_TIMELINE_DAYS }
    : state;
}

function validFilters(value: unknown): value is RoomStatusFilters {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const filters = value as Record<string, unknown>;
  return typeof filters.search === "string"
    && typeof filters.roomTypeCode === "string"
    && (filters.salesMode === "ALL" || filters.salesMode === "WHOLE_ROOM" || filters.salesMode === "BED_SPLIT" || filters.salesMode === "UNAVAILABLE")
    && (filters.status === "ALL" || roomStatusStatuses.includes(filters.status as RoomStatusStatus))
    && (filters.kind === "ALL" || filters.kind === "ROOM" || filters.kind === "BED")
    && (filters.minimumCapacity === null || (typeof filters.minimumCapacity === "number" && Number.isSafeInteger(filters.minimumCapacity) && filters.minimumCapacity > 0));
}

function validFocus(value: unknown): value is RoomStatusCellFocus | null {
  if (value === null) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const focus = value as Record<string, unknown>;
  return typeof focus.unitId === "string" && Boolean(focus.unitId) && typeof focus.serviceDate === "string" && isIsoLocalDate(focus.serviceDate);
}

function validSelection(value: unknown): value is RoomStatusSelection | null {
  if (value === null) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const selection = value as Record<string, unknown>;
  const structurallyValid = typeof selection.unitId === "string"
    && Boolean(selection.unitId)
    && typeof selection.anchorDate === "string"
    && typeof selection.focusDate === "string"
    && typeof selection.arrivalDate === "string"
    && typeof selection.departureDate === "string"
    && isIsoLocalDate(selection.anchorDate)
    && isIsoLocalDate(selection.focusDate)
    && isIsoLocalDate(selection.arrivalDate)
    && isIsoLocalDate(selection.departureDate)
    && selection.departureDate > selection.arrivalDate;
  if (!structurallyValid) return false;
  const anchorDate = selection.anchorDate as string;
  const focusDate = selection.focusDate as string;
  const arrivalDate = selection.arrivalDate as string;
  const departureDate = selection.departureDate as string;
  return anchorDate >= arrivalDate
    && anchorDate < departureDate
    && focusDate >= arrivalDate
    && focusDate < departureDate
    && localDateNightCount(arrivalDate, departureDate) <= MAX_RESTORABLE_STAY_NIGHTS;
}

function validViewState(value: unknown): value is RoomStatusViewState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  const anchor = state.scrollAnchor;
  return validFilters(state.filters)
    && Array.isArray(state.expandedRoomIds)
    && state.expandedRoomIds.every((id) => typeof id === "string")
    && typeof state.roomPageIndex === "number"
    && Number.isSafeInteger(state.roomPageIndex)
    && state.roomPageIndex >= 0
    && typeof state.dateWindowStart === "number"
    && Number.isSafeInteger(state.dateWindowStart)
    && state.dateWindowStart >= 0
    && typeof state.dateWindowSize === "number"
    && Number.isSafeInteger(state.dateWindowSize)
    && state.dateWindowSize >= 1
    && state.dateWindowSize <= MAX_VISIBLE_DAYS
    && (state.dateWindowMode === "30" || state.dateWindowMode === "AUTO" || state.dateWindowMode === "7" || state.dateWindowMode === "14" || state.dateWindowMode === "21")
    && validFocus(state.focusedCell)
    && validSelection(state.selection)
    && Boolean(anchor)
    && typeof anchor === "object"
    && !Array.isArray(anchor)
    && (((anchor as Record<string, unknown>).unitId === null) || typeof (anchor as Record<string, unknown>).unitId === "string")
    && typeof (anchor as Record<string, unknown>).left === "number"
    && Number.isFinite((anchor as Record<string, unknown>).left)
    && ((anchor as Record<string, unknown>).left as number) >= 0
    && typeof (anchor as Record<string, unknown>).top === "number"
    && Number.isFinite((anchor as Record<string, unknown>).top)
    && ((anchor as Record<string, unknown>).top as number) >= 0;
}

export function serializeRoomStatusRestoration(snapshot: RoomStatusRestorationSnapshot): string {
  return JSON.stringify(snapshot);
}

function localDateNightCount(arrivalDate: string, departureDate: string): number {
  return Math.round((Date.parse(`${departureDate}T00:00:00.000Z`) - Date.parse(`${arrivalDate}T00:00:00.000Z`)) / 86_400_000);
}

export function parseRoomStatusRestoration(serialized: string, expectedPropertyId: string): RoomStatusRestorationSnapshot | undefined {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const snapshot = value as Record<string, unknown>;
  if (snapshot.state && typeof snapshot.state === "object" && !Array.isArray(snapshot.state)) {
    const state = snapshot.state as Record<string, unknown>;
    if (state.dateWindowMode === undefined) snapshot.state = { ...state, dateWindowMode: "30" };
  }
  const range = snapshot.range;
  if (snapshot.version !== 1
    || snapshot.propertyId !== expectedPropertyId
    || !range
    || typeof range !== "object"
    || Array.isArray(range)
    || typeof (range as Record<string, unknown>).arrivalDate !== "string"
    || typeof (range as Record<string, unknown>).departureDate !== "string"
    || !isIsoLocalDate((range as Record<string, unknown>).arrivalDate as string)
    || !isIsoLocalDate((range as Record<string, unknown>).departureDate as string)
    || ((range as Record<string, unknown>).departureDate as string) <= ((range as Record<string, unknown>).arrivalDate as string)
    || localDateNightCount(
      (range as Record<string, unknown>).arrivalDate as string,
      (range as Record<string, unknown>).departureDate as string
    ) > ROOM_STATUS_MAX_QUERY_NIGHTS
    || typeof snapshot.revision !== "string"
    || !snapshot.revision
    || typeof snapshot.savedAt !== "string"
    || Number.isNaN(new Date(snapshot.savedAt).getTime())
    || (snapshot.factFingerprint !== undefined
      && snapshot.factFingerprint !== null
      && typeof snapshot.factFingerprint !== "string")
    || !validViewState(snapshot.state)) return undefined;
  const restored = snapshot as unknown as RoomStatusRestorationSnapshot;
  if (restored.state.focusedCell
    && (restored.state.focusedCell.serviceDate < restored.range.arrivalDate
      || restored.state.focusedCell.serviceDate >= restored.range.departureDate)
    && (!restored.state.selection
      || restored.state.selection.unitId !== restored.state.focusedCell.unitId
      || restored.state.selection.focusDate !== restored.state.focusedCell.serviceDate)) return undefined;
  return restored;
}
