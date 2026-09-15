import { useMemberChoices } from "../useMemberChoices";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useReducer, useRef, useState, type FormEvent } from "react";
import { AlertTriangle, FilePlus2, PanelRightOpen, RefreshCw, Trash2, UserPlus, X } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import type {
  CreateOrderAdditionalGuestInputDto,
  CreateOrderPrimaryGuestInputDto,
  RoomStatusActionDto,
  RoomStatusBoardDto,
  RoomStatusBoardQueryDto,
  RoomStatusConflictDto,
  RoomStatusDayDto,
  RoomStatusIntervalDto,
  RoomStatusUnitDto
} from "@qintopia/contracts";
import { currentReleaseFeatures } from "@qintopia/contracts";
import { api, ApiError, type ClientCommandMetadata } from "../api";
import { addLocalDateDays, localDateInTimeZone } from "../dates";
import { memberStayIntent } from "../memberStayIntent";
import { commandRecoveryAvailable, principalCan, propertyAllowedActions, useWorkspace } from "../session";
import { assertOrderViewAllowedActions } from "../orderViewValidation";
import type {
  BookingChannelCode,
  CommandCapability,
  CommandRequest,
  MemberContractDto,
  MemberDto,
  MemberViewDto,
  OrderViewDto,
  PricingPolicyVersionDto,
  QuoteDto,
  ReceiptDto,
  StayType
} from "../types";
import { correctionDraftMatchesOccupant, OrderOccupantCorrectionDialog } from "../components/OrderOccupantCorrectionDialog";
import { MoveUnitDrawer } from "../components/MoveUnitDrawer";
import {
  OrderLifecycleActionDrawer,
  type OrderLifecycleAction
} from "../components/OrderLifecycleActionDrawer";
import { StayDateChangeDrawer, type StayDateChangeAction, type StayDateChangeMode } from "../components/StayDateChangeDrawer";
import {
  browserCommandRecoveryStorage,
  CommandDialog,
  type CommandDialogCloseContext,
  CommandResultNotice,
  type CommandDialogProgress,
  type CommandRecoveryStorage,
  CommandRecoveryBar,
  DamagedCommandRecoveryNotice,
  EmptyState,
  formatDateTime,
  formatMoney,
  InfoHint,
  InlineError,
  isTerminalCommandRecovery,
  LoadingBlock,
  Modal,
  ModalNoticeProvider,
  propertyRecoveryCoordinationScope,
  quoteRecoveryStorageKey,
  readPersistedCommandRecovery,
  RECOVERY_STORAGE_SYNC_EVENT,
  recoveryCommandRequest,
  recoveryStorageEventMatchesScope,
  recoveryStorageSyncEventMatchesScope,
  usePersistentCommandRecovery,
  withRecoveryStorageLock
} from "../ui";
import {
  assertRoomStatusBoard,
  createRoomStatusOrderReturnState,
  createRoomStatusViewState,
  DEFAULT_ROOM_STATUS_FILTERS,
  dateWindowStartForFocus,
  filterRoomStatusRooms,
  hasActiveRoomStatusFilters,
  hasRoomStatusOrderReturnEnvelope,
  isIsoLocalDate,
  parseRoomStatusRestoration,
  parseRoomStatusOrderReturnTarget,
  reconcileRoomStatusRestoration,
  resolveRoomStatusOrderReturnTarget,
  roomStatusFactFingerprint,
  roomStatusGridFocusForSelection,
  roomStatusIntervalAttentionLabels,
  roomStatusOrderIdentityForDate,
  roomStatusOrderIdentityForInterval,
  roomStatusOrderOptionsForDate,
  roomStatusOrderOptionsForSelection,
  roomStatusUniqueOrderStayId,
  roomStatusUnitLabel,
  RoomStatusContext,
  RoomStatusGrid,
  RoomStatusMobileTasks,
  RoomStatusOrderContext,
  RoomStatusQuickPopover,
  RoomStatusToolbar,
  ROOM_STATUS_TIMELINE_DAYS,
  roomStatusViewReducer,
  selectionFromCells,
  serializeRoomStatusRestoration,
  useRoomStatusMobileViewport,
  type RoomStatusMobileGroups,
  type RoomStatusMobileFocusRequest,
  type RoomStatusMobileTab,
  type RoomStatusAttentionLabel,
  type RoomStatusOrderIdentity,
  type RoomStatusRange,
  type RoomStatusRestorationSnapshot,
  type RoomStatusSelection,
  type RoomStatusViewState
} from "../room-status";
import { roomStatusRoomTypeLabel, roomStatusUnitDescription } from "../room-status/roomStatusPresentation";

export function orderContextInventoryUnits<T extends { id: string }>(
  activeUnits: readonly T[],
  referencedUnits: readonly T[]
): T[] {
  const activeIds = new Set(activeUnits.map((unit) => unit.id));
  return [...activeUnits, ...referencedUnits.filter((unit) => !activeIds.has(unit.id))];
}

export function roomStatusQuickPopoverAttentionLabels(
  unit: Pick<RoomStatusUnitDto, "intervals"> | null | undefined,
  serviceDate: string | undefined,
  selection?: Pick<RoomStatusSelection, "arrivalDate" | "departureDate"> | null
): RoomStatusAttentionLabel[] {
  if (!unit || !serviceDate) return [];
  return [...new Set(unit.intervals
    .filter((interval) => selection
      ? interval.startDate < selection.departureDate && interval.endDate > selection.arrivalDate
      : interval.startDate <= serviceDate && serviceDate < interval.endDate)
    .flatMap(roomStatusIntervalAttentionLabels))];
}

const bookingChannelLabels: Record<BookingChannelCode, string> = {
  YOUMUDAO: "游牧岛",
  CTRIP: "携程",
  MEITUAN: "美团",
  WECOM: "企业微信"
};

const MAX_STAY_SELECTION_NIGHTS = 366;

export function roomStatusOrderContextMode(workspaceWidth: number, isMobile: boolean): "INLINE" | "DRAWER" {
  void workspaceWidth;
  void isMobile;
  return "DRAWER";
}

export function roomStatusOrderContextVisible(
  selectedOrder: Pick<RoomStatusOrderIdentity, "orderId" | "stayId"> | undefined,
  orderContextOpen: boolean
): boolean {
  return Boolean(selectedOrder && orderContextOpen);
}

export function roomStatusOrderIdentityKey(
  identity: Pick<RoomStatusOrderIdentity, "orderId" | "stayId"> | undefined
): string | undefined {
  return identity ? `${identity.orderId}:${identity.stayId}` : undefined;
}

export function inventoryRecoveryIsBusinessFacing(presentation: CommandRequest["presentation"]): boolean {
  return presentation === "MEMBER_STAY" || presentation === "BACKFILL_STAY" || presentation === "FULFILLMENT" || presentation === "STAY_DATES" || presentation === "MOVE_UNIT";
}

export function roomStatusGridSelectedStayId(
  quickPopoverOpen: boolean,
  quickPopoverStayId: string | null,
  selectedOrder?: Pick<RoomStatusOrderIdentity, "stayId">,
  stableSelectedStayId?: string
): string | null {
  return quickPopoverOpen
    ? quickPopoverStayId ?? null
    : selectedOrder?.stayId ?? stableSelectedStayId ?? null;
}

export function roomStatusQuickPopoverPreviewStayId(
  unit: Pick<RoomStatusUnitDto, "kind" | "salesMode"> | null | undefined,
  directStayId: string | null | undefined,
  uniqueOrderStayId: string | null
): string | null {
  if (directStayId) return directStayId;
  return unit?.kind === "ROOM" && unit.salesMode === "BED_SPLIT"
    ? null
    : uniqueOrderStayId;
}

export function roomStatusAnchorMatches(
  anchor: Pick<HTMLElement, "dataset">,
  unitId: string,
  serviceDate: string
): boolean {
  return anchor.dataset.unitId === unitId && anchor.dataset.serviceDate === serviceDate;
}

export function roomStatusQuickTargetMatches(
  target: { unitId: string; serviceDate: string } | undefined,
  unitId: string,
  serviceDate: string
): boolean {
  return target?.unitId === unitId && target.serviceDate === serviceDate;
}

const roomStatusFilterKeys = [
  "search",
  "roomTypeCode",
  "salesMode",
  "status",
  "kind",
  "minimumCapacity"
] as const satisfies readonly (keyof RoomStatusViewState["filters"])[];

export function roomStatusFiltersRevealingTarget(
  filters: RoomStatusViewState["filters"],
  targetVisible: (candidate: RoomStatusViewState["filters"]) => boolean
): RoomStatusViewState["filters"] {
  if (targetVisible(filters)) return filters;
  const activeKeys = roomStatusFilterKeys.filter((key) => filters[key] !== DEFAULT_ROOM_STATUS_FILTERS[key]);
  for (let clearedCount = 1; clearedCount <= activeKeys.length; clearedCount += 1) {
    for (let mask = 1; mask < 2 ** activeKeys.length; mask += 1) {
      if (mask.toString(2).replaceAll("0", "").length !== clearedCount) continue;
      const candidate = { ...filters };
      activeKeys.forEach((key, index) => {
        if (mask & (1 << index)) {
          (candidate as Record<keyof RoomStatusViewState["filters"], unknown>)[key] = DEFAULT_ROOM_STATUS_FILTERS[key];
        }
      });
      if (targetVisible(candidate)) return candidate;
    }
  }
  return { ...DEFAULT_ROOM_STATUS_FILTERS };
}

export function bookingChannelRequiredForStay(useMemberEntitlement: boolean, stayType?: string): boolean {
  return !useMemberEntitlement && stayType !== "FREE";
}

export function parseYuanAmountToMinor(value: string): number | undefined {
  const normalized = value.trim();
  const match = /^(\d+)(?:\.00)?$/.exec(normalized);
  if (!match) return undefined;
  const minor = BigInt(match[1]!) * 100n;
  return minor <= 2_147_483_600n ? Number(minor) : undefined;
}

export function parseBackfillCollectionYuanToMinor(value: string): number | undefined {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return undefined;
  const [yuanPart, fractionPart = ""] = normalized.split(".");
  const minor = BigInt(yuanPart!) * 100n + BigInt(fractionPart.padEnd(2, "0") || "0");
  return minor <= 2_147_483_600n ? Number(minor) : undefined;
}

interface BackfillReviewDetails {
  stayType: StayType;
  backfillReason: string;
  freeStayCategoryCode: "VOLUNTEER" | "RECEPTION" | "";
  freeStayReason: string;
  bookingChannelCode: BookingChannelCode | "";
  targetAmountYuan: string;
  contractAmountMinor: number | undefined;
  channelOrderReference: string;
  channelReasonRequired: boolean;
  channelPriceDifferenceReason: string;
  manualReasonRequired: boolean;
  manualPriceAdjustmentReason: string;
  collectionAmountYuan: string;
  collectionAmountMinor: number | undefined;
  collectionMethod: string;
  transactionReference: string;
  cashCollector: string;
  cashNote: string;
}

export function backfillReviewValidationError(input: BackfillReviewDetails): string | undefined {
  if (!input.backfillReason.trim()) return "请填写补录原因";
  if (input.stayType === "FREE") {
    if (!input.freeStayCategoryCode) return "请选择免费入住类型";
    if (!input.freeStayReason.trim()) return "请填写免费入住原因";
    return undefined;
  }
  if (!input.bookingChannelCode) return "请选择订单来源渠道";
  if (input.contractAmountMinor === undefined) return input.targetAmountYuan.trim()
    ? "本单金额格式不正确，请填写非负整数金额"
    : "请填写本单金额";
  const externalChannel = input.bookingChannelCode !== "WECOM";
  if (externalChannel && input.contractAmountMinor <= 0) return "外部渠道本单应结金额必须大于 0";
  if (externalChannel && !input.channelOrderReference.trim()) return "请填写渠道订单号";
  if (input.channelReasonRequired && !input.channelPriceDifferenceReason.trim()) return "请填写渠道价格差异说明";
  if (input.manualReasonRequired && !input.manualPriceAdjustmentReason.trim()) return "请填写人工调价原因";
  if (input.bookingChannelCode !== "WECOM") return undefined;
  if (input.collectionAmountMinor === undefined) return input.collectionAmountYuan.trim()
    ? "补录实收金额格式不正确，请填写不超过两位小数的非负金额"
    : "请填写补录实收金额；没有住宿收款时填写 0";
  if (input.collectionAmountMinor > input.contractAmountMinor) return "补录实收金额不能超过本单金额";
  if (input.collectionAmountMinor === 0) return undefined;
  if (input.collectionMethod === "WECOM" || input.collectionMethod === "BANK_TRANSFER") {
    return input.transactionReference.trim() ? undefined : "请填写本次实际收款对应的真实交易单号";
  }
  if (input.collectionMethod === "CASH") {
    if (!input.cashCollector.trim()) return "请填写现金收款人";
    if (!input.cashNote.trim()) return "请填写现金收款核对备注";
    return undefined;
  }
  return "请选择有效的收款方式";
}

export function backfillReviewDetailsComplete(input: BackfillReviewDetails): boolean {
  return backfillReviewValidationError(input) === undefined;
}

export function backfillSubmitBlockedReason(input: {
  commandsBlocked: boolean;
  quoteIsCurrent: boolean;
  guestCount: number;
  occupancyCapacity: number;
}): string | undefined {
  if (input.commandsBlocked) return "当前房态已变化、正在刷新、权限受限或有操作尚未收口，请按页面提示处理后重试";
  if (!input.quoteIsCurrent) return "房源或住宿日期的最新报价尚未载入，请稍候";
  if (input.guestCount > input.occupancyCapacity) return "住宿人数超过当前房源可入住人数";
  return undefined;
}

export function createOrderSubmitBlockedReason(input: {
  commandsBlocked: boolean;
  quoteIsCurrent: boolean;
  guestsComplete: boolean;
  guestCount: number;
  occupancyCapacity: number;
  temporaryOtherRoomConfirmed: boolean;
  temporaryOtherRoomReasonValid: boolean;
  channelRequired: boolean;
  pricingComplete: boolean;
  freeStayMissing: boolean;
}): string | undefined {
  if (input.commandsBlocked) return "当前房态或操作恢复记录尚未收口，请按页面提示处理后重试";
  if (!input.quoteIsCurrent) return "房源或住宿日期的最新报价尚未载入，请稍候";
  if (!input.guestsComplete) return "请补全每位住宿人的姓名和昵称";
  if (input.guestCount > input.occupancyCapacity) return "住宿人数超过当前房源可入住人数";
  if (input.temporaryOtherRoomConfirmed && !input.temporaryOtherRoomReasonValid) return "请填写临时安排其他房型的具体原因";
  if (input.channelRequired && !input.pricingComplete) return "请补全渠道订单号、成交金额和价格差异说明";
  if (input.freeStayMissing) return "请填写免费入住类型和具体原因";
  return undefined;
}

export function completedStayBackfillSubmissionError(
  arrivalDate: string,
  departureDate: string,
  businessDate: string | undefined
): string | undefined {
  if (!businessDate || !isIsoLocalDate(arrivalDate) || !isIsoLocalDate(departureDate) || !isIsoLocalDate(businessDate)) {
    return "当前营业日尚未载入，不能安全提交补录住宿";
  }
  if (arrivalDate >= departureDate) return "住宿日期不完整，请重新选择入住日和离店日";
  if (arrivalDate >= businessDate) return "今天及未来的住宿请使用“创建订单”";
  return undefined;
}

export function backfillCollectionCommandInput(input: {
  amountMinor: number;
  method: string;
  transactionReference: string;
  cashCollector: string;
  cashNote: string;
}): Record<string, unknown> | undefined {
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor < 0) return undefined;
  if (input.amountMinor === 0) return { amountMinor: 0, method: "WECOM" };
  if (input.method === "WECOM" || input.method === "BANK_TRANSFER") {
    const transactionReference = input.transactionReference.trim();
    return transactionReference
      ? { amountMinor: input.amountMinor, method: input.method, transactionReference }
      : undefined;
  }
  if (input.method === "CASH") {
    const cashCollector = input.cashCollector.trim();
    const note = input.cashNote.trim();
    return cashCollector && note
      ? { amountMinor: input.amountMinor, method: "CASH", cashCollector, note }
      : undefined;
  }
  return undefined;
}

export function completedStayBackfillCommandRequest(
  orderInput: Record<string, unknown>,
  backfillReason: string
): CommandRequest {
  const normalizedReason = backfillReason.trim();
  return {
    commandType: "CREATE_ORDER",
    title: "补录住宿",
    description: "请核对住宿补录、真实收款与补录原因。",
    presentation: "BACKFILL_STAY",
    initialReason: { code: "BACKFILL_STAY", note: normalizedReason },
    input: {
      ...orderInput,
      backfill: true,
      backfillReason: normalizedReason
    }
  };
}

export function formatMinorForYuanInput(minorUnits: number): string {
  return String(minorUnits / 100);
}

export function createOrderPricingDraft(input: {
  bookingChannelCode: BookingChannelCode | "";
  channelOrderReference: string;
  targetAmountYuan: string;
  policyBaseAmountMinor: number;
  channelPriceDifferenceReason: string;
  manualPriceAdjustmentReason: string;
}) {
  const targetCurrentContractAmountMinor = parseYuanAmountToMinor(input.targetAmountYuan);
  const externalChannel = input.bookingChannelCode !== "" && input.bookingChannelCode !== "WECOM";
  const differenceFromPolicyMinor = targetCurrentContractAmountMinor === undefined
    ? undefined
    : targetCurrentContractAmountMinor - input.policyBaseAmountMinor;
  const channelReasonRequired = externalChannel
    && differenceFromPolicyMinor !== undefined
    && (() => {
      const difference = BigInt(differenceFromPolicyMinor);
      const absoluteDifference = difference < 0n ? -difference : difference;
      return absoluteDifference * 100n > BigInt(input.policyBaseAmountMinor) * 15n;
    })();
  const manualReasonRequired = input.bookingChannelCode === "WECOM"
    && differenceFromPolicyMinor !== undefined
    && differenceFromPolicyMinor !== 0;
  return {
    targetCurrentContractAmountMinor,
    differenceFromPolicyMinor,
    channelReasonRequired,
    manualReasonRequired,
    complete: Boolean(input.bookingChannelCode)
      && targetCurrentContractAmountMinor !== undefined
      && (!externalChannel || targetCurrentContractAmountMinor > 0)
      && (!externalChannel || Boolean(input.channelOrderReference.trim()))
      && (!channelReasonRequired || Boolean(input.channelPriceDifferenceReason.trim()))
      && (!manualReasonRequired || Boolean(input.manualPriceAdjustmentReason.trim()))
  };
}

export const freeStayCategoryLabels: Record<string, string> = {
  VOLUNTEER: "义工",
  RECEPTION: "接待"
};

interface QuoteCommandInput {
  propertyId: string;
  inventoryUnitId: string;
  stayType?: StayType;
  arrivalDate: string;
  departureDate: string;
  pricingPolicyVersionId: string;
  memberId?: string;
  temporaryOtherRoom?: true;
}

export interface TemporaryOtherRoomOffer {
  temporaryOtherRoomAvailable: true;
  originalRoomTypeCode: string;
  actualRoomTypeCode: string;
  originalRoomTypeAvailable?: boolean;
}

export interface TemporaryOtherRoomDraft {
  offer?: TemporaryOtherRoomOffer;
  confirmed: boolean;
  reason: string;
}

export interface TemporaryOtherRoomContext {
  memberId: string;
  inventoryUnitId: string;
  arrivalDate: string;
  departureDate: string;
}

function temporaryOtherRoomOfferDetails(value: unknown): TemporaryOtherRoomOffer | undefined {
  const details = recordValue(value);
  if (!details
    || details.temporaryOtherRoomAvailable !== true
    || typeof details.originalRoomTypeCode !== "string"
    || !details.originalRoomTypeCode.trim()
    || typeof details.actualRoomTypeCode !== "string"
    || !details.actualRoomTypeCode.trim()
    || (details.originalRoomTypeAvailable !== undefined && typeof details.originalRoomTypeAvailable !== "boolean")) {
    return undefined;
  }
  return {
    temporaryOtherRoomAvailable: true,
    originalRoomTypeCode: details.originalRoomTypeCode,
    actualRoomTypeCode: details.actualRoomTypeCode,
    ...(typeof details.originalRoomTypeAvailable === "boolean" ? { originalRoomTypeAvailable: details.originalRoomTypeAvailable } : {})
  };
}

export function temporaryOtherRoomOfferFromQuoteError(error: unknown): TemporaryOtherRoomOffer | undefined {
  if (!(error instanceof ApiError) || error.status !== 409 || error.code !== "ENTITLEMENT_CONFLICT") return undefined;
  return temporaryOtherRoomOfferDetails(error.details);
}

export function temporaryOtherRoomQuoteInput<T extends QuoteCommandInput>(
  input: T,
  offer: TemporaryOtherRoomOffer | undefined,
  confirmed: boolean
): T | (T & { temporaryOtherRoom: true }) {
  return offer && confirmed ? { ...input, temporaryOtherRoom: true } : input;
}

export function quoteRecoveryInputForCurrentContext(
  current: QuoteCommandInput | undefined,
  recovery: QuoteCommandInput | undefined
): QuoteCommandInput | undefined {
  if (!current || !recovery) return undefined;
  const { temporaryOtherRoom: _temporaryOtherRoom, ...recoveryContext } = recovery;
  return quoteInputSignature(current) === quoteInputSignature(recoveryContext)
    ? recovery
    : undefined;
}

export function quoteRecoveryMemberSelectionForUnit(
  recovery: QuoteCommandInput | undefined,
  inventoryUnitId: string | undefined
): { useMemberEntitlement: boolean; memberId: string } | undefined {
  if (!recovery || !inventoryUnitId || recovery.inventoryUnitId !== inventoryUnitId) return undefined;
  return {
    useMemberEntitlement: Boolean(recovery.memberId),
    memberId: recovery.memberId ?? ""
  };
}

export function resetTemporaryOtherRoomDraftForContext(
  draft: TemporaryOtherRoomDraft,
  previous: TemporaryOtherRoomContext,
  next: TemporaryOtherRoomContext
): TemporaryOtherRoomDraft {
  return previous.memberId === next.memberId
    && previous.inventoryUnitId === next.inventoryUnitId
    && previous.arrivalDate === next.arrivalDate
    && previous.departureDate === next.departureDate
    ? draft
    : { confirmed: false, reason: "" };
}

export function temporaryOtherRoomCreateOrderCommand(
  input: Record<string, unknown>,
  reason: string
): CommandRequest | undefined {
  const temporaryOtherRoomReason = reason.trim();
  if (!temporaryOtherRoomReason || temporaryOtherRoomReason.length > 200) return undefined;
  return {
    commandType: "CREATE_ORDER",
    title: "创建订单",
    description: "核对本次临时安排、住宿人名单及会员权益。",
    presentation: "MEMBER_STAY",
    initialReason: { code: "TEMPORARY_OTHER_ROOM", note: temporaryOtherRoomReason },
    input: { ...input, temporaryOtherRoomReason }
  };
}

export function TemporaryOtherRoomFields({
  offer,
  confirmed,
  reason,
  disabled,
  onConfirmedChange,
  onReasonChange
}: {
  offer: TemporaryOtherRoomOffer;
  confirmed: boolean;
  reason: string;
  disabled: boolean;
  onConfirmedChange: (confirmed: boolean) => void;
  onReasonChange: (reason: string) => void;
}) {
  return <section className="temporary-other-room-fields" aria-label="临时安排其他房型">
    <label className="checkbox-label">
      <input
        type="checkbox"
        checked={confirmed}
        onChange={(event) => onConfirmedChange(event.target.checked)}
        disabled={disabled}
        data-testid="temporary-other-room-confirmed"
      />
      <span className="form-label-with-hint">本次临时安排其他房型<InfoHint label="临时安排说明" text="仅用于本次实际安排，会员原有房型与后续权益不会改变。" /></span>
    </label>
    {offer.originalRoomTypeAvailable ? <p className="temporary-other-room-warning">系统显示原会员房型仍可能有空房，请确认现场安排原因。</p> : null}
    {confirmed ? <>
      <dl className="temporary-other-room-summary">
        <div><dt>原适用房型</dt><dd>{roomStatusRoomTypeLabel(offer.originalRoomTypeCode)}</dd></div>
        <div><dt>实际安排房型</dt><dd>{roomStatusRoomTypeLabel(offer.actualRoomTypeCode)}</dd></div>
      </dl>
      <label>现场安排原因
        <textarea
          value={reason}
          onChange={(event) => onReasonChange(event.target.value)}
          required
          maxLength={200}
          rows={2}
          disabled={disabled}
          data-testid="temporary-other-room-reason"
        />
      </label>
    </> : null}
  </section>;
}

export type RoomStatusQuoteActionCode = "CREATE_ORDER" | "CREATE_FREE_STAY" | "BACKFILL_ORDER";

const roomStatusQuoteActionCodes = new Set<RoomStatusQuoteActionCode>([
  "CREATE_ORDER",
  "CREATE_FREE_STAY",
  "BACKFILL_ORDER"
]);

function isRoomStatusQuoteActionCode(value: unknown): value is RoomStatusQuoteActionCode {
  return typeof value === "string" && roomStatusQuoteActionCodes.has(value as RoomStatusQuoteActionCode);
}

export function eligibleMemberProfiles(
  members: MemberDto[],
  contracts: Pick<MemberContractDto, "property_id" | "member_id">[],
  propertyId: string,
  query: string
): MemberDto[] {
  const propertyMemberIds = new Set(contracts
    .filter((contract) => contract.property_id === propertyId && contract.member_id)
    .map((contract) => contract.member_id));
  const normalizedQuery = query.trim().toUpperCase();
  return members.filter((member) => propertyMemberIds.has(member.id) && (
    !normalizedQuery
    || member.full_name.toUpperCase().includes(normalizedQuery)
    || member.nickname.toUpperCase().includes(normalizedQuery)
    || member.phone.toUpperCase().includes(normalizedQuery)
    || member.wechat.toUpperCase().includes(normalizedQuery)
  ));
}

export function effectiveQuoteMemberId(members: MemberDto[], requestedMemberId: string): string {
  return members.some((member) => member.id === requestedMemberId) ? requestedMemberId : "";
}

export interface PendingQuoteCommand {
  version: 1;
  subjectId: string;
  propertyId: string;
  ownerTabId?: string;
  input: QuoteCommandInput;
  inputSignature: string;
  actionCode?: RoomStatusQuoteActionCode;
  metadata: ClientCommandMetadata;
  state: "SENDING" | "UNKNOWN";
}

export type QuoteRecoveryReadResult =
  | { kind: "ABSENT" }
  | { kind: "VALID"; pending: PendingQuoteCommand }
  | { kind: "CORRUPT"; error: Error }
  | { kind: "READ_ERROR"; error: Error };

export function roomStatusMaintenanceQuoteTargetClearMode(
  activeSubmissionIdentity: string | undefined
): "IMMEDIATE" | "AFTER_RECOVERY_CLEARS" {
  return activeSubmissionIdentity ? "AFTER_RECOVERY_CLEARS" : "IMMEDIATE";
}

export function roomStatusActiveOwnQuoteSubmissionMatches(input: {
  recovery: QuoteRecoveryReadResult;
  currentOwnerId: string | undefined;
  activeSubmissionIdentity: string | undefined;
  workbenchOpen: boolean;
}): boolean {
  return input.workbenchOpen
    && input.recovery.kind === "VALID"
    && input.recovery.pending.state === "SENDING"
    && Boolean(input.currentOwnerId)
    && input.recovery.pending.ownerTabId === input.currentOwnerId
    && input.recovery.pending.metadata.idempotencyKey === input.activeSubmissionIdentity;
}

export function roomStatusDeferredMaintenanceReady(input: {
  deferredSubmissionIdentity: string | undefined;
  activeSubmissionIdentity: string | undefined;
  quoteRecoveryKind: QuoteRecoveryReadResult["kind"];
}): boolean {
  return Boolean(input.deferredSubmissionIdentity)
    && !input.activeSubmissionIdentity
    && input.quoteRecoveryKind === "ABSENT";
}

export function roomStatusDesktopContextKind(
  quoteRecoveryContextOpen: boolean,
  hasSelectedOrder: boolean
): "QUOTE_RECOVERY" | "ORDER" | "SELECTION" {
  if (quoteRecoveryContextOpen) return "QUOTE_RECOVERY";
  return hasSelectedOrder ? "ORDER" : "SELECTION";
}

export function roomStatusQuoteRecoveryDrawerOpen(
  quoteRecoveryContextOpen: boolean,
  ownQuoteRecoveryVisible: boolean
): boolean {
  return quoteRecoveryContextOpen || ownQuoteRecoveryVisible;
}

export function quoteRecoveryContextIdentity(
  recoveryScope: string,
  recovery: QuoteRecoveryReadResult
): string | undefined {
  if (recovery.kind === "ABSENT") return undefined;
  if (recovery.kind === "VALID") {
    return `${recoveryScope}:${recovery.pending.metadata.idempotencyKey}`;
  }
  return `${recoveryScope}:${recovery.kind}`;
}

export function shouldAutoOpenQuoteRecoveryContext({
  recoveryIdentity,
  dismissedIdentity,
  autoOpenedIdentity,
  recoveryOwnerId,
  currentOwnerId,
  isMobile,
  hasSelectedOrder
}: {
  recoveryIdentity: string | undefined;
  dismissedIdentity: string | undefined;
  autoOpenedIdentity: string | undefined;
  recoveryOwnerId?: string | undefined;
  currentOwnerId?: string | undefined;
  isMobile: boolean;
  hasSelectedOrder: boolean;
}): boolean {
  return Boolean(recoveryIdentity
    && recoveryIdentity !== dismissedIdentity
    && recoveryIdentity !== autoOpenedIdentity
    && (!recoveryOwnerId || recoveryOwnerId !== currentOwnerId)
    && !isMobile
    && !hasSelectedOrder);
}

export function shouldAutoResolveOwnSendingQuoteRecovery({
  recoveryIdentity,
  attemptedIdentity,
  recoveryState,
  recoveryOwnerId,
  currentOwnerId,
  busy
}: {
  recoveryIdentity: string | undefined;
  attemptedIdentity: string | undefined;
  recoveryState?: PendingQuoteCommand["state"] | undefined;
  recoveryOwnerId?: string | undefined;
  currentOwnerId?: string | undefined;
  busy: boolean;
}): boolean {
  return Boolean(recoveryIdentity
    && recoveryIdentity !== attemptedIdentity
    && recoveryState === "SENDING"
    && recoveryOwnerId
    && recoveryOwnerId === currentOwnerId
    && !busy);
}

export function shouldOfferManualOwnSendingQuoteRecovery({
  recoveryIdentity,
  attemptedIdentity,
  recoveryState,
  recoveryOwnerId,
  currentOwnerId
}: {
  recoveryIdentity: string | undefined;
  attemptedIdentity: string | undefined;
  recoveryState?: PendingQuoteCommand["state"] | undefined;
  recoveryOwnerId?: string | undefined;
  currentOwnerId?: string | undefined;
}): boolean {
  return Boolean(recoveryIdentity
    && recoveryIdentity === attemptedIdentity
    && recoveryState === "SENDING"
    && recoveryOwnerId
    && recoveryOwnerId === currentOwnerId);
}

export function shouldRenderDetachedQuoteRecoveryWorkbench(
  hasRenderedBoard: boolean,
  recoveryContextOpen: boolean,
  recovery: QuoteRecoveryReadResult
): boolean {
  return !hasRenderedBoard && recoveryContextOpen && recovery.kind !== "ABSENT";
}

export function QuoteRecoveryPageEntry({ recovery, onOpen }: {
  recovery: QuoteRecoveryReadResult;
  onOpen: () => void;
}) {
  if (recovery.kind === "ABSENT") return null;
  const valid = recovery.kind === "VALID";
  return (
    <section className="recovery-bar" role="status" aria-live="polite" data-testid="inventory-quote-recovery-entry">
      <div>
        <strong>{valid && recovery.pending.state === "UNKNOWN" ? "报价结果需要核对" : "有一笔报价需要处理"}</strong>
        <p>{valid
          ? "新的报价和订单操作已暂停，请先处理原报价。"
          : "报价恢复记录需要核对，处理完成前不会开始新的写入。"}</p>
      </div>
      <button className="button button-secondary" type="button" onClick={onOpen}>打开处理入口</button>
    </section>
  );
}

let browserQuoteRecoveryDocumentOwnerId: string | undefined;
const browserDismissedQuoteRecoveryIdentities = new Set<string>();
const browserAutoOpenedQuoteRecoveryIdentities = new Set<string>();
const browserAutoResolvedQuoteRecoveryIdentities = new Set<string>();

export function browserQuoteRecoveryOwnerId(): string {
  // sessionStorage may be cloned when a browser tab is duplicated. A document
  // identity must never survive that operation or both tabs can claim ownership.
  // Keep the owner stable only for the current document so same-tab navigation
  // and component remounts can still recover their own in-flight Quote safely.
  browserQuoteRecoveryDocumentOwnerId ??= crypto.randomUUID();
  return browserQuoteRecoveryDocumentOwnerId;
}

export interface QuoteRequestLease {
  scope: string;
  generation: number;
}

export class QuoteRequestGuard {
  private mounted = false;
  private scope: string;
  private generation = 0;

  constructor(initialScope: string) {
    this.scope = initialScope;
  }

  mount() {
    this.mounted = true;
  }

  unmount() {
    this.mounted = false;
    this.generation += 1;
  }

  enterScope(scope: string) {
    if (scope === this.scope) return;
    this.scope = scope;
    this.generation += 1;
  }

  begin(scope: string): QuoteRequestLease {
    this.enterScope(scope);
    this.generation += 1;
    return { scope, generation: this.generation };
  }

  isActive(lease: QuoteRequestLease): boolean {
    return this.mounted && lease.scope === this.scope && lease.generation === this.generation;
  }
}

export class RoomStatusCommandAttemptGuard {
  private generation = 0;
  private activeAttemptId: number | null = null;

  begin(): number {
    const attemptId = ++this.generation;
    this.activeAttemptId = attemptId;
    return attemptId;
  }

  invalidate(): void {
    this.activeAttemptId = null;
  }

  runIfActive(attemptId: number, action: () => void): boolean {
    if (this.activeAttemptId !== attemptId) return false;
    action();
    return true;
  }
}

export interface SelectedMemberViewRequestLease {
  scope: string;
  generation: number;
}

export class SelectedMemberViewRequestGuard {
  private generation = 0;
  private activeScope: string | undefined;

  begin(scope: string): SelectedMemberViewRequestLease {
    this.generation += 1;
    this.activeScope = scope;
    return { scope, generation: this.generation };
  }

  invalidate(): void {
    this.generation += 1;
    this.activeScope = undefined;
  }

  runIfActive(lease: SelectedMemberViewRequestLease, action: () => void): boolean {
    if (this.activeScope !== lease.scope || this.generation !== lease.generation) return false;
    action();
    return true;
  }
}

export class RoomStatusQueryAttemptGuard {
  private generation = 0;
  private activeAttemptId: number | null = null;
  private activeController: AbortController | null = null;

  begin(controller?: AbortController): number {
    this.activeController?.abort();
    const attemptId = ++this.generation;
    this.activeAttemptId = attemptId;
    this.activeController = controller ?? null;
    return attemptId;
  }

  isInFlight(): boolean {
    return this.activeAttemptId !== null;
  }

  isActive(attemptId: number): boolean {
    return this.activeAttemptId === attemptId;
  }

  finish(attemptId: number): boolean {
    if (!this.isActive(attemptId)) return false;
    this.activeAttemptId = null;
    this.activeController = null;
    return true;
  }

  invalidate(attemptId: number): boolean {
    if (!this.isActive(attemptId)) return false;
    this.activeController?.abort();
    return this.finish(attemptId);
  }

  invalidateActive(): void {
    this.activeController?.abort();
    this.activeController = null;
    this.activeAttemptId = null;
  }
}

function validQuoteInput(value: unknown): value is QuoteCommandInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  const allowedKeys = new Set([
    "propertyId",
    "inventoryUnitId",
    "stayType",
    "arrivalDate",
    "departureDate",
    "pricingPolicyVersionId",
    "memberId",
    "temporaryOtherRoom"
  ]);
  return Object.keys(input).every((key) => allowedKeys.has(key))
    && typeof input.propertyId === "string" && input.propertyId === input.propertyId.trim() && Boolean(input.propertyId)
    && typeof input.inventoryUnitId === "string" && input.inventoryUnitId === input.inventoryUnitId.trim() && Boolean(input.inventoryUnitId)
    && (input.stayType === undefined || input.stayType === "FREE" || input.stayType === "TRANSIENT" || input.stayType === "CUSTOM")
    && typeof input.arrivalDate === "string" && isIsoLocalDate(input.arrivalDate)
    && typeof input.departureDate === "string" && isIsoLocalDate(input.departureDate)
    && input.arrivalDate < input.departureDate
    && rangeNights({ arrivalDate: input.arrivalDate, departureDate: input.departureDate }) <= MAX_STAY_SELECTION_NIGHTS
    && typeof input.pricingPolicyVersionId === "string"
    && input.pricingPolicyVersionId === input.pricingPolicyVersionId.trim()
    && Boolean(input.pricingPolicyVersionId)
    && !Object.hasOwn(input, "memberContractId")
    && (input.memberId === undefined
      || (typeof input.memberId === "string" && input.memberId === input.memberId.trim() && Boolean(input.memberId)))
    && (input.temporaryOtherRoom === undefined
      || (input.temporaryOtherRoom === true
        && input.stayType === undefined
        && typeof input.memberId === "string"
        && input.memberId === input.memberId.trim()
        && Boolean(input.memberId)));
}

export function readQuoteCommandRecovery(storage: CommandRecoveryStorage, subjectId: string, propertyId: string): QuoteRecoveryReadResult {
  let serialized: string | null;
  try {
    serialized = storage.getItem(quoteRecoveryStorageKey(subjectId, propertyId));
  } catch {
    return { kind: "READ_ERROR", error: new Error("无法读取本地报价恢复记录；已暂停新报价和订单写入") };
  }
  if (serialized === null) return { kind: "ABSENT" };
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    return { kind: "CORRUPT", error: new Error("本地报价恢复记录已损坏；无法确认原报价命令是否执行") };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { kind: "CORRUPT", error: new Error("本地报价恢复记录结构无效") };
  }
  const record = value as Record<string, unknown>;
  const metadata = record.metadata;
  const metadataRecord = metadata as Record<string, unknown> | undefined;
  if (record.version !== 1
    || record.subjectId !== subjectId
    || record.propertyId !== propertyId
    || (record.ownerTabId !== undefined && (typeof record.ownerTabId !== "string" || !record.ownerTabId))
    || !validQuoteInput(record.input)
    || record.input.propertyId !== propertyId
    || typeof record.inputSignature !== "string"
    || record.inputSignature !== quoteInputSignature(record.input)
    || (record.actionCode !== undefined && !isRoomStatusQuoteActionCode(record.actionCode))
    || !metadataRecord
    || typeof metadataRecord !== "object"
    || Array.isArray(metadata)
    || typeof metadataRecord.idempotencyKey !== "string"
    || !metadataRecord.idempotencyKey
    || metadataRecord.idempotencyKey !== metadataRecord.idempotencyKey.trim()
    || metadataRecord.idempotencyKey.length > 160
    || typeof metadataRecord.correlationId !== "string"
    || !metadataRecord.correlationId
    || metadataRecord.correlationId !== metadataRecord.correlationId.trim()
    || metadataRecord.correlationId.length > 160
    || (record.state !== "SENDING" && record.state !== "UNKNOWN")) {
    return { kind: "CORRUPT", error: new Error("本地报价恢复记录版本或字段无效；已暂停新报价和订单写入") };
  }
  return { kind: "VALID", pending: record as unknown as PendingQuoteCommand };
}

function notifyQuoteRecoveryStorageChange(subjectId: string, propertyId: string): void {
  if (typeof window === "undefined" || typeof CustomEvent === "undefined") return;
  window.dispatchEvent(new CustomEvent(RECOVERY_STORAGE_SYNC_EVENT, {
    detail: { storageKey: quoteRecoveryStorageKey(subjectId, propertyId) }
  }));
}

export function saveQuoteCommandRecovery(storage: CommandRecoveryStorage, pending: PendingQuoteCommand): boolean {
  try {
    storage.setItem(quoteRecoveryStorageKey(pending.subjectId, pending.propertyId), JSON.stringify(pending));
    notifyQuoteRecoveryStorageChange(pending.subjectId, pending.propertyId);
    return true;
  } catch {
    return false;
  }
}

function clearQuoteCommandRecovery(storage: CommandRecoveryStorage, subjectId: string, propertyId: string): boolean {
  try {
    storage.removeItem(quoteRecoveryStorageKey(subjectId, propertyId));
    notifyQuoteRecoveryStorageChange(subjectId, propertyId);
    return true;
  } catch {
    return false;
  }
}

export function clearCorruptQuoteCommandRecovery(
  storage: CommandRecoveryStorage,
  subjectId: string,
  propertyId: string
): boolean {
  const current = readQuoteCommandRecovery(storage, subjectId, propertyId);
  return current.kind === "CORRUPT"
    && clearQuoteCommandRecovery(storage, subjectId, propertyId);
}

function browserQuoteRecovery(subjectId: string, propertyId: string): { storage?: CommandRecoveryStorage; read: QuoteRecoveryReadResult } {
  const access = browserCommandRecoveryStorage();
  if (access.kind !== "AVAILABLE") {
    return { read: { kind: "READ_ERROR", error: new Error("无法访问浏览器恢复存储；已暂停新报价和订单写入") } };
  }
  return { storage: access.storage, read: readQuoteCommandRecovery(access.storage, subjectId, propertyId) };
}

function quoteInputSignature(input: QuoteCommandInput): string {
  return JSON.stringify(input);
}

export function paidStayTypeForDates(arrivalDate: string, departureDate: string): "TRANSIENT" | "CUSTOM" {
  const nights = rangeNights({ arrivalDate, departureDate });
  return nights < 7 ? "TRANSIENT" : "CUSTOM";
}

export function quotePricingSummary(quote: QuoteDto): {
  nights: number;
  pricingBasis: string;
  amount: QuoteDto["currentContractAmount"];
} {
  const nights = rangeNights(quote);
  const stayTotal = quote.cashLines.find((line) => line.lineKind === "STAY_TOTAL");
  const anchor = stayTotal?.lineKind === "STAY_TOTAL" ? stayTotal.pricingBandAnchorNights : 1;
  return {
    nights,
    pricingBasis: quote.stayType === "FREE" ? "免费入住" : anchor === 1 ? "按临住价格" : `按 ${anchor} 夜价格档`,
    amount: quote.currentContractAmount
  };
}

export function membershipCoverageSummary(quote: QuoteDto) {
  const totalNights = rangeNights(quote);
  const coveredNights = quote.coverageSet.length;
  return {
    totalNights,
    coveredNights,
    uncoveredNights: totalNights - coveredNights,
    uncoveredAmount: quote.cashRemainder
  };
}

export function staffQuoteError(error: ApiError, unitCode: string, arrivalDate: string, departureDate: string): Error {
  if (error.code === "PRICING_POLICY_UNCONFIGURED" || error.code === "POLICY_VERSION_NOT_FOUND") {
    return new Error(`${unitCode} 在 ${arrivalDate} 至 ${departureDate} 暂无已生效价格，请调整日期。`);
  }
  if (error.code === "INVENTORY_CONFLICT") return new Error(error.message);
  if (error.code === "VALIDATION_ERROR") return new Error(`入住和退房日期无效，请确认退房日期晚于入住日期。`);
  return new Error(error.message);
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function validQuoteMoney(value: unknown): boolean {
  const money = recordValue(value);
  return Boolean(money
    && typeof money.currency === "string"
    && /^[A-Z]{3}$/.test(money.currency)
    && Number.isSafeInteger(money.minorUnits));
}

function quoteFromReceipt(receipt: ReceiptDto, pending: PendingQuoteCommand): QuoteDto {
  if (receipt.executionStatus !== "EXECUTED"
    || receipt.businessCommitted !== true
    || !receipt.receiptId
    || !receipt.commandId
    || !receipt.correlationId
    || receipt.error !== undefined
    || !receipt.committedAt
    || Number.isNaN(Date.parse(receipt.committedAt))) {
    throw new Error("原报价结果缺少可核对的执行凭证；已继续暂停新报价。");
  }
  const quote = receipt.result?.quote;
  if (!quote || typeof quote !== "object" || Array.isArray(quote)) {
    throw new Error("原报价结果缺少报价明细；已继续暂停新报价。");
  }
  const record = quote as Record<string, unknown>;
  const expectedStayType = pending.input.stayType ?? paidStayTypeForDates(
    pending.input.arrivalDate,
    pending.input.departureDate
  );
  const memberMatches = pending.input.memberId === undefined
    ? record.memberId === undefined
    : record.memberId === pending.input.memberId;
  const arrangement = recordValue(record.temporaryOtherRoomArrangement);
  const temporaryOtherRoomMatches = pending.input.temporaryOtherRoom === true
    ? Boolean(arrangement
      && arrangement.kind === "TEMPORARY_OTHER_ROOM"
      && arrangement.originalInventoryKind === "ROOM"
      && arrangement.entitlementUnitKind === "ROOM_NIGHT"
      && arrangement.actualInventoryKind === "ROOM"
      && typeof arrangement.originalRoomTypeCode === "string"
      && typeof arrangement.actualRoomTypeCode === "string"
      && arrangement.originalRoomTypeCode !== arrangement.actualRoomTypeCode
      && arrangement.actualInventoryUnitId === pending.input.inventoryUnitId
      && arrangement.arrivalDate === pending.input.arrivalDate
      && arrangement.departureDate === pending.input.departureDate
      && arrangement.memberContractId === record.memberContractId)
    : record.temporaryOtherRoomArrangement === undefined;
  if (typeof record.quoteId !== "string" || !record.quoteId
    || record.propertyId !== pending.input.propertyId
    || record.inventoryUnitId !== pending.input.inventoryUnitId
    || record.arrivalDate !== pending.input.arrivalDate
    || record.departureDate !== pending.input.departureDate
    || record.pricingPolicyVersionId !== pending.input.pricingPolicyVersionId
    || record.stayType !== expectedStayType
    || !memberMatches
    || !temporaryOtherRoomMatches
    || !Array.isArray(record.coverageSet)
    || !Array.isArray(record.cashLines)
    || !validQuoteMoney(record.cashRemainder)
    || !validQuoteMoney(record.currentContractAmount)
    || typeof record.expiresAt !== "string"
    || Number.isNaN(Date.parse(record.expiresAt))
    || typeof record.inputHash !== "string"
    || !/^[a-f0-9]{64}$/.test(record.inputHash)
    || !Array.isArray(receipt.resourceRefs)
    || !receipt.resourceRefs.includes(record.quoteId)
    || !Array.isArray(receipt.factRefs)) {
    throw new Error("原报价结果与当时选择的房源、日期或价格政策不一致；已继续暂停新报价。");
  }
  return record as unknown as QuoteDto;
}

function quoteNotExecutedReceiptIsCoherent(receipt: ReceiptDto): boolean {
  return receipt.executionStatus === "NOT_EXECUTED"
    && receipt.businessCommitted === false
    && Boolean(receipt.receiptId && receipt.commandId && receipt.correlationId)
    && receipt.result === undefined
    && receipt.error?.code === "COMMAND_INTERRUPTED"
    && receipt.error.retryable === false
    && Array.isArray(receipt.resourceRefs)
    && receipt.resourceRefs.length === 0
    && Array.isArray(receipt.factRefs)
    && receipt.factRefs.length === 0
    && typeof receipt.committedAt === "string"
    && !Number.isNaN(Date.parse(receipt.committedAt));
}

interface InventoryActionUnit {
  id: string;
  kind: "ROOM" | "BED";
  code: string;
  name: string;
  buildingCode: string | null;
  occupancyCapacity: number;
  available: boolean;
}

function unitName(unit: InventoryActionUnit | undefined) {
  return unit ? roomStatusUnitLabel(unit) : "未选择库存单元";
}

export interface GuestFormValue {
  fullName: string;
  nickname: string;
  phone: string;
  documentNumber: string;
}

export const GUEST_FULL_NAME_MAX_LENGTH = 200;

interface AdditionalGuestDraft extends GuestFormValue {
  key: number;
}

export function guestFormComplete(guest: GuestFormValue): boolean {
  return Boolean(guest.fullName.trim() && guest.nickname.trim());
}

export function guestFormInput(guest: GuestFormValue): CreateOrderAdditionalGuestInputDto {
  const input: CreateOrderAdditionalGuestInputDto = {
    fullName: guest.fullName.trim(),
    nickname: guest.nickname.trim()
  };
  if (guest.phone.trim()) input.phone = guest.phone.trim();
  if (guest.documentNumber.trim()) input.documentNumber = guest.documentNumber.trim();
  return input;
}

export function applyMemberSelectionToGuestForms<T extends GuestFormValue>(
  additionalGuests: T[],
  member: Pick<MemberDto, "full_name" | "nickname" | "phone" | "identity_card_number">
): { primaryGuest: GuestFormValue; additionalGuests: T[] } {
  return {
    primaryGuest: {
      fullName: member.full_name,
      nickname: member.nickname,
      phone: member.phone,
      documentNumber: member.identity_card_number ?? ""
    },
    additionalGuests
  };
}

export function createOrderGuestInputs(
  primaryGuest: GuestFormValue,
  additionalGuests: readonly GuestFormValue[]
): { primaryGuest: CreateOrderPrimaryGuestInputDto; additionalGuests: CreateOrderAdditionalGuestInputDto[] } {
  return {
    primaryGuest: guestFormInput(primaryGuest),
    additionalGuests: additionalGuests.map(guestFormInput)
  };
}

export function canAddGuest(occupancyCapacity: number, additionalGuestCount: number): boolean {
  return 1 + additionalGuestCount < occupancyCapacity;
}

export function roomStatusBlockDraftWithinSelection(
  from: string,
  to: string,
  selectionArrivalDate: string,
  selectionDepartureDate: string
): boolean {
  return isIsoLocalDate(from)
    && isIsoLocalDate(to)
    && selectionArrivalDate <= from
    && from < to
    && to <= selectionDepartureDate;
}

function MaintenanceDialog({ unit, arrivalDate, departureDate, writeBlocked, draft, onClose, onSubmit }: {
  unit: InventoryActionUnit;
  arrivalDate: string;
  departureDate: string;
  writeBlocked: boolean;
  draft?: CommandRequest;
  onClose: () => void;
  onSubmit: (request: CommandRequest) => boolean;
}) {
  const { propertyId } = useWorkspace();
  const formId = useId();
  const [from, setFrom] = useState(() => typeof draft?.input.arrivalDate === "string" ? draft.input.arrivalDate : arrivalDate);
  const [to, setTo] = useState(() => typeof draft?.input.departureDate === "string" ? draft.input.departureDate : departureDate);
  const [reason, setReason] = useState(() => typeof draft?.input.reason === "string" ? draft.input.reason : "");
  const [validationError, setValidationError] = useState<Error>();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!roomStatusBlockDraftWithinSelection(from, to, arrivalDate, departureDate)) {
      setValidationError(new Error(`维修日期必须位于已验证选区 [${arrivalDate}, ${departureDate}) 内，且至少包含一晚。`));
      return;
    }
    setValidationError(undefined);
    onSubmit({
      commandType: "LOCK_MAINTENANCE",
      title: `维修锁房 · ${unit.code}`,
      description: "系统将重新核对房源、日期和维修原因，确认后设置维修锁房。",
      input: { propertyId, inventoryUnitId: unit.id, arrivalDate: from, departureDate: to, reason },
      initialReason: { code: "LOCK_MAINTENANCE", note: reason.trim() }
    });
  }

  return (
    <Modal
      title={`维修锁房 · ${unitName(unit)}`}
      onClose={onClose}
      size="drawer"
      className="room-status-write-drawer"
      footer={<><button type="button" className="button button-secondary" onClick={onClose}>取消</button><button type="submit" form={formId} className="button button-primary" disabled={writeBlocked}>继续核对</button></>}
    >
      <form id={formId} className="modal-form" onSubmit={submit}>
        <InlineError
          error={writeBlocked ? new Error("当前房态已陈旧、正在刷新、权限已收窄或命令恢复尚未收口。日期和原因草稿仍保留，重新取得可写房态后再继续。") : undefined}
          title="草稿已保留，写入已暂停"
        />
        <InlineError error={validationError} title="维修日期未通过房态校验" />
        <div className="form-grid form-grid-two">
          <label>开始日期<input type="date" value={from} min={arrivalDate} max={addLocalDateDays(departureDate, -1)} onChange={(event) => { setFrom(event.target.value); setValidationError(undefined); }} required /></label>
          <label>结束日期<input type="date" value={to} min={isIsoLocalDate(from) ? addLocalDateDays(from, 1) : arrivalDate} max={departureDate} onChange={(event) => { setTo(event.target.value); setValidationError(undefined); }} required /></label>
          <label className="span-two">维修原因<textarea rows={3} value={reason} onChange={(event) => setReason(event.target.value)} required maxLength={1000} /></label>
        </div>
      </form>
    </Modal>
  );
}

function QuoteWorkbench({
  unit,
  arrivalDate,
  departureDate,
  businessDate,
  policies,
  recoveryQuoteInput,
  initialStayType,
  initialMemberId,
  quoteActionCode,
  backfill = false,
  commandsBlocked,
  selectionDraftValid,
  resetToken,
  autoResolvedRecoveryIdentities,
  onClose,
  onRecoveryOutcome,
  onRecoveryStateChange,
  onQuoteSubmissionActivity,
  onCommand
}: {
  unit: InventoryActionUnit | undefined;
  arrivalDate: string;
  departureDate: string;
  businessDate?: string;
  policies: PricingPolicyVersionDto[];
  recoveryQuoteInput?: QuoteCommandInput;
  initialStayType?: StayType;
  initialMemberId?: string;
  quoteActionCode?: RoomStatusQuoteActionCode;
  backfill?: boolean;
  commandsBlocked: boolean;
  selectionDraftValid: boolean;
  resetToken: number;
  autoResolvedRecoveryIdentities: { current: Set<string> };
  onClose: () => void;
  onRecoveryOutcome: (outcome: Error | undefined) => void;
  onRecoveryStateChange: () => void;
  onQuoteSubmissionActivity: (idempotencyKey: string, active: boolean) => void;
  onCommand: (request: CommandRequest) => void;
}) {
  const { meta, principal, propertyId } = useWorkspace();
  const quoteRecoveryScope = quoteRecoveryStorageKey(principal.subjectId, propertyId);
  const recoveryCoordinationScope = propertyRecoveryCoordinationScope(principal.subjectId, propertyId);
  const [backfillStayKind, setBackfillStayKind] = useState<"PAID" | "FREE">(() => initialStayType === "FREE" ? "FREE" : "PAID");
  const stayType: StayType = backfill && backfillStayKind === "FREE"
    ? "FREE"
    : initialStayType === "FREE" && !backfill
      ? "FREE"
      : paidStayTypeForDates(arrivalDate, departureDate);
  const selectedPolicy = stayType === "FREE"
    ? policies.find((policy) => policy.calculation_kind === "FREE" && policy.stay_type === "FREE")
    : policies.filter((policy) => policy.calculation_kind === "DURATION_BAND_TOTAL" && policy.stay_type === null
      && policy.effective_from !== null && policy.effective_from <= arrivalDate
      && (policy.effective_until === null || arrivalDate < policy.effective_until))
      .sort((a, b) => (b.effective_from ?? "").localeCompare(a.effective_from ?? "")
        || Number(b.code === "MANAGED_ROOM_PRICES") - Number(a.code === "MANAGED_ROOM_PRICES") || b.version - a.version)[0];
  const policyId = selectedPolicy?.id ?? "";
  const initialMemberLookup = useMemberChoices(propertyId, "", initialMemberId ?? "", Boolean(initialMemberId), true);
  const initialMember = !backfill && initialStayType !== "FREE" && !recoveryQuoteInput
    ? initialMemberLookup.members.find((member) => member.id === initialMemberId)
    : undefined;
  const [useMemberEntitlement, setUseMemberEntitlement] = useState(() => Boolean(recoveryQuoteInput?.memberId || initialMemberId));
  const [memberId, setMemberId] = useState(() => recoveryQuoteInput?.memberId ?? initialMemberId ?? "");
  const [memberSearch, setMemberSearch] = useState("");
  const [temporaryOtherRoomDraft, setTemporaryOtherRoomDraft] = useState<TemporaryOtherRoomDraft>(() => ({
    confirmed: recoveryQuoteInput?.temporaryOtherRoom === true,
    reason: ""
  }));
  const [quote, setQuote] = useState<QuoteDto>();
  const [quoteSignature, setQuoteSignature] = useState("");
  const [orphanQuoteReviewConfirmed, setOrphanQuoteReviewConfirmed] = useState(false);
  const [quoteRecoverySnapshot, setQuoteRecoverySnapshot] = useState<{ scope: string; read: QuoteRecoveryReadResult }>(() => ({
    scope: quoteRecoveryScope,
    read: browserQuoteRecovery(principal.subjectId, propertyId).read
  }));
  const [guestName, setGuestName] = useState(() => initialMember?.full_name ?? "");
  const [guestNickname, setGuestNickname] = useState(() => initialMember?.nickname ?? "");
  const [guestPhone, setGuestPhone] = useState(() => initialMember?.phone ?? "");
  const [guestDocument, setGuestDocument] = useState(() => initialMember?.identity_card_number ?? "");
  const [additionalGuests, setAdditionalGuests] = useState<AdditionalGuestDraft[]>([]);
  const [bookingChannelCode, setBookingChannelCode] = useState<BookingChannelCode | "">("");
  const [channelOrderReference, setChannelOrderReference] = useState("");
  const [targetContractAmountYuan, setTargetContractAmountYuan] = useState("");
  const [channelPriceDifferenceReason, setChannelPriceDifferenceReason] = useState("");
  const [manualPriceAdjustmentReason, setManualPriceAdjustmentReason] = useState("");
  const [freeStayReason, setFreeStayReason] = useState("");
  const [freeStayCategoryCode, setFreeStayCategoryCode] = useState<"VOLUNTEER" | "RECEPTION" | "">("");
  const [backfillReason, setBackfillReason] = useState("");
  const [backfillAmountYuan, setBackfillAmountYuan] = useState("");
  const [backfillMethod, setBackfillMethod] = useState("WECOM");
  const [backfillTransactionReference, setBackfillTransactionReference] = useState("");
  const [backfillCashCollector, setBackfillCashCollector] = useState("");
  const [backfillCashNote, setBackfillCashNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [quoteRecoveryOwnerId] = useState(browserQuoteRecoveryOwnerId);
  const latestQuoteSignature = useRef("");
  const settledQuoteSignature = useRef("");
  const nextAdditionalGuestKey = useRef(0);
  const quoteRequestGuardRef = useRef<QuoteRequestGuard | null>(null);
  if (!quoteRequestGuardRef.current) quoteRequestGuardRef.current = new QuoteRequestGuard(quoteRecoveryScope);
  const quoteRequestGuard = quoteRequestGuardRef.current;
  const activeQuoteSubmissionKey = useRef<string | undefined>(undefined);
  const temporaryOtherRoomContextRef = useRef<TemporaryOtherRoomContext | undefined>(undefined);
  quoteRequestGuard.enterScope(quoteRecoveryScope);
  const quoteRecoveryReady = quoteRecoverySnapshot.scope === quoteRecoveryScope;
  const quoteRecoveryRead = quoteRecoveryReady
    ? quoteRecoverySnapshot.read
    : { kind: "READ_ERROR", error: new Error("正在核对本地报价恢复记录") } as const;
  const pendingQuote = quoteRecoveryRead.kind === "VALID" ? quoteRecoveryRead.pending : undefined;
  const currentQuoteRecoveryIdentity = quoteRecoveryContextIdentity(quoteRecoveryScope, quoteRecoveryRead);
  const attemptedQuoteRecoveryIdentity = currentQuoteRecoveryIdentity
    && autoResolvedRecoveryIdentities.current.has(currentQuoteRecoveryIdentity)
    ? currentQuoteRecoveryIdentity
    : undefined;
  const manualOwnSendingRecoveryAvailable = shouldOfferManualOwnSendingQuoteRecovery({
    recoveryIdentity: currentQuoteRecoveryIdentity,
    attemptedIdentity: attemptedQuoteRecoveryIdentity,
    recoveryState: pendingQuote?.state,
    recoveryOwnerId: pendingQuote?.ownerTabId,
    currentOwnerId: quoteRecoveryOwnerId
  });
  const ownQuoteSubmissionActive = Boolean(busy
    && pendingQuote?.state === "SENDING"
    && pendingQuote.ownerTabId === quoteRecoveryOwnerId
    && !attemptedQuoteRecoveryIdentity);
  const quoteRecoveryError = quoteRecoveryRead.kind === "CORRUPT" || quoteRecoveryRead.kind === "READ_ERROR" ? quoteRecoveryRead.error : undefined;
  const quoteCommandsBlocked = commandsBlocked || !quoteRecoveryReady || quoteRecoveryRead.kind !== "ABSENT";

  function updateQuoteRecoverySnapshot(read: QuoteRecoveryReadResult): void {
    setQuoteRecoverySnapshot({ scope: quoteRecoveryScope, read });
    onRecoveryStateChange();
  }

  function finishQuoteSubmission(idempotencyKey: string): void {
    if (activeQuoteSubmissionKey.current === idempotencyKey) activeQuoteSubmissionKey.current = undefined;
    onQuoteSubmissionActivity(idempotencyKey, false);
  }

  useEffect(() => () => {
    const idempotencyKey = activeQuoteSubmissionKey.current;
    if (idempotencyKey) onQuoteSubmissionActivity(idempotencyKey, false);
  }, []);

  async function transitionQuoteRecovery(
    expectedIdempotencyKey: string,
    nextState: "CLEAR" | "UNKNOWN"
  ): Promise<{ read: QuoteRecoveryReadResult; matched: boolean; changed: boolean }> {
    try {
      return await withRecoveryStorageLock(recoveryCoordinationScope, () => {
        const current = browserQuoteRecovery(principal.subjectId, propertyId);
        if (!current.storage
          || current.read.kind !== "VALID"
          || current.read.pending.metadata.idempotencyKey !== expectedIdempotencyKey) {
          return { read: current.read, matched: false, changed: false };
        }
        if (nextState === "CLEAR") {
          if (!clearQuoteCommandRecovery(current.storage, principal.subjectId, propertyId)) {
            return {
              read: { kind: "READ_ERROR", error: new Error("无法清除已核对的本地报价恢复记录；新报价和订单写入继续暂停") } as const,
              matched: true,
              changed: false
            };
          }
          return { read: { kind: "ABSENT" } as const, matched: true, changed: true };
        }
        const unknown = { ...current.read.pending, state: "UNKNOWN" as const };
        if (!saveQuoteCommandRecovery(current.storage, unknown)) {
          return {
            read: { kind: "READ_ERROR", error: new Error("无法更新本地报价恢复记录；新报价和订单写入继续暂停") } as const,
            matched: true,
            changed: false
          };
        }
        return { read: { kind: "VALID", pending: unknown } as const, matched: true, changed: true };
      });
    } catch {
      return {
        read: { kind: "READ_ERROR", error: new Error("无法取得跨标签报价协调锁；新报价和订单写入继续暂停") },
        matched: false,
        changed: false
      };
    }
  }

  useEffect(() => {
    quoteRequestGuard.mount();
    return () => quoteRequestGuard.unmount();
  }, [quoteRequestGuard]);

  useEffect(() => {
    setBusy(false);
    updateQuoteRecoverySnapshot(browserQuoteRecovery(principal.subjectId, propertyId).read);
  }, [principal.subjectId, propertyId, quoteRecoveryScope]);

  useEffect(() => {
    const access = browserCommandRecoveryStorage();
    if (access.kind !== "AVAILABLE") return;
    const handleStorage = (event: StorageEvent) => {
      if (!recoveryStorageEventMatchesScope(event, quoteRecoveryScope, access.authoritativeStorage)) return;
      updateQuoteRecoverySnapshot(browserQuoteRecovery(principal.subjectId, propertyId).read);
    };
    const handleSync = (event: Event) => {
      if (!recoveryStorageSyncEventMatchesScope(event as CustomEvent<unknown>, quoteRecoveryScope)) return;
      updateQuoteRecoverySnapshot(browserQuoteRecovery(principal.subjectId, propertyId).read);
    };
    window.addEventListener("storage", handleStorage);
    window.addEventListener(RECOVERY_STORAGE_SYNC_EVENT, handleSync);
    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener(RECOVERY_STORAGE_SYNC_EVENT, handleSync);
    };
  }, [principal.subjectId, propertyId, quoteRecoveryScope]);

  useEffect(() => {
    if (resetToken === 0) return;
    settledQuoteSignature.current = "";
    setQuote(undefined);
    setQuoteSignature("");
    setGuestName("");
    setGuestNickname("");
    setGuestPhone("");
    setGuestDocument("");
    setAdditionalGuests([]);
    setBookingChannelCode("");
    setChannelOrderReference("");
    setTargetContractAmountYuan("");
    setChannelPriceDifferenceReason("");
    setManualPriceAdjustmentReason("");
    setFreeStayReason("");
    setFreeStayCategoryCode("");
    setBackfillReason("");
    setBackfillAmountYuan("");
    setBackfillMethod("WECOM");
    setBackfillTransactionReference("");
    setBackfillCashCollector("");
    setBackfillCashNote("");
    setBackfillStayKind(initialStayType === "FREE" ? "FREE" : "PAID");
    setUseMemberEntitlement(false);
    setMemberId("");
    setMemberSearch("");
    setTemporaryOtherRoomDraft({ confirmed: false, reason: "" });
    setError(undefined);
  }, [initialStayType, resetToken]);

  useEffect(() => {
    if (stayType === "FREE") {
      setUseMemberEntitlement(false);
      setMemberId("");
      setMemberSearch("");
    }
  }, [stayType]);

  useEffect(() => {
    if (!backfill) return;
    setUseMemberEntitlement(false);
    setMemberId("");
    setMemberSearch("");
    setTemporaryOtherRoomDraft({ confirmed: false, reason: "" });
  }, [backfill]);

  useEffect(() => {
    const recoverySelection = quoteRecoveryMemberSelectionForUnit(recoveryQuoteInput, unit?.id);
    if (recoveryQuoteInput && !unit) return;
    if (recoverySelection) {
      setUseMemberEntitlement(recoverySelection.useMemberEntitlement);
      setMemberId(recoverySelection.memberId);
      setMemberSearch("");
      setTemporaryOtherRoomDraft({
        confirmed: recoveryQuoteInput?.temporaryOtherRoom === true,
        reason: ""
      });
      return;
    }
    setUseMemberEntitlement(Boolean(initialMember));
    setMemberId(initialMember?.id ?? "");
    setMemberSearch("");
    setGuestName(initialMember?.full_name ?? "");
    setGuestNickname(initialMember?.nickname ?? "");
    setGuestPhone(initialMember?.phone ?? "");
    setGuestDocument(initialMember?.identity_card_number ?? "");
    setAdditionalGuests([]);
    setBookingChannelCode("");
    setChannelOrderReference("");
    setTargetContractAmountYuan("");
    setChannelPriceDifferenceReason("");
    setManualPriceAdjustmentReason("");
    setFreeStayReason("");
    setFreeStayCategoryCode("");
    setBackfillReason("");
    setBackfillAmountYuan("");
    setBackfillMethod("WECOM");
    setBackfillTransactionReference("");
    setBackfillCashCollector("");
    setBackfillCashNote("");
    setError(undefined);
  }, [unit?.id, initialMember?.id]);

  useEffect(() => {
    settledQuoteSignature.current = "";
    setQuoteSignature("");
    setTargetContractAmountYuan("");
    setChannelPriceDifferenceReason("");
    setManualPriceAdjustmentReason("");
    setBackfillAmountYuan("");
    setBackfillMethod("WECOM");
    setBackfillTransactionReference("");
    setBackfillCashCollector("");
    setBackfillCashNote("");
    setError(undefined);
  }, [arrivalDate, departureDate]);

  useEffect(() => {
    setBookingChannelCode("");
    setChannelOrderReference("");
    setTargetContractAmountYuan("");
    setChannelPriceDifferenceReason("");
    setManualPriceAdjustmentReason("");
    setBackfillAmountYuan("");
    setBackfillMethod("WECOM");
    setBackfillTransactionReference("");
    setBackfillCashCollector("");
    setBackfillCashNote("");
  }, [stayType]);

  useEffect(() => {
    setError(undefined);
  }, [memberId, useMemberEntitlement]);

  useEffect(() => {
    if (!useMemberEntitlement) return;
    setBookingChannelCode("");
    setChannelOrderReference("");
    setTargetContractAmountYuan("");
    setChannelPriceDifferenceReason("");
    setManualPriceAdjustmentReason("");
  }, [useMemberEntitlement]);

  const memberChoices = useMemberChoices(propertyId, memberSearch, memberId, useMemberEntitlement);
  const memberProfiles = memberChoices.members;
  const quoteMemberId = memberChoices.error ? "" : effectiveQuoteMemberId(memberProfiles, memberId);

  const temporaryOtherRoomContext: TemporaryOtherRoomContext = {
    memberId: quoteMemberId,
    inventoryUnitId: unit?.id ?? "",
    arrivalDate,
    departureDate
  };

  useEffect(() => {
    const previous = temporaryOtherRoomContextRef.current;
    if (previous) {
      setTemporaryOtherRoomDraft((draft) => resetTemporaryOtherRoomDraftForContext(draft, previous, temporaryOtherRoomContext));
    }
    temporaryOtherRoomContextRef.current = temporaryOtherRoomContext;
  }, [temporaryOtherRoomContext.memberId, temporaryOtherRoomContext.inventoryUnitId, temporaryOtherRoomContext.arrivalDate, temporaryOtherRoomContext.departureDate]);

  const quoteNightCount = isIsoLocalDate(arrivalDate) && isIsoLocalDate(departureDate)
    ? rangeNights({ arrivalDate, departureDate })
    : 0;
  const quoteDatesValid = quoteNightCount >= 1 && quoteNightCount <= MAX_STAY_SELECTION_NIGHTS;
  const baseQuoteInput: QuoteCommandInput | undefined = unit && policyId && selectionDraftValid && quoteDatesValid && (!useMemberEntitlement || quoteMemberId) ? {
    propertyId,
    inventoryUnitId: unit.id,
    ...(stayType === "FREE" ? { stayType } : {}),
    arrivalDate,
    departureDate,
    pricingPolicyVersionId: policyId,
    ...(useMemberEntitlement && quoteMemberId ? { memberId: quoteMemberId } : {})
  } : undefined;
  const currentQuoteInput = quoteRecoveryInputForCurrentContext(baseQuoteInput, recoveryQuoteInput)
    ?? (baseQuoteInput
      ? temporaryOtherRoomQuoteInput(baseQuoteInput, temporaryOtherRoomDraft.offer, temporaryOtherRoomDraft.confirmed)
      : undefined);
  const currentQuoteSignature = currentQuoteInput ? quoteInputSignature(currentQuoteInput) : "";
  const quoteIsCurrent = Boolean(quote && quoteSignature === currentQuoteSignature);
  latestQuoteSignature.current = currentQuoteSignature;

  async function createQuote(signal?: AbortSignal) {
    if (!currentQuoteInput || quoteCommandsBlocked) return;
    onRecoveryOutcome(undefined);
    const input = currentQuoteInput;
    const inputSignature = quoteInputSignature(input);
    const metadata = api.commandMetadata("create-quote");
    const pending: PendingQuoteCommand = {
      version: 1,
      subjectId: principal.subjectId,
      propertyId,
      ownerTabId: quoteRecoveryOwnerId,
      input,
      inputSignature,
      ...(quoteActionCode ? { actionCode: quoteActionCode } : {}),
      metadata,
      state: "SENDING"
    };
    activeQuoteSubmissionKey.current = metadata.idempotencyKey;
    onQuoteSubmissionActivity(metadata.idempotencyKey, true);
    const requestLease = quoteRequestGuard.begin(quoteRecoveryScope);
    setBusy(true);
    setError(undefined);
    let claim:
      | { kind: "CLAIMED" }
      | { kind: "STALE" }
      | { kind: "BLOCKED"; read: QuoteRecoveryReadResult; error?: Error };
    try {
      claim = await withRecoveryStorageLock(recoveryCoordinationScope, () => {
        if (!quoteRequestGuard.isActive(requestLease) || signal?.aborted) return { kind: "STALE" as const };
        const beforeSend = browserQuoteRecovery(principal.subjectId, propertyId);
        if (!beforeSend.storage || beforeSend.read.kind !== "ABSENT") {
          return {
            kind: "BLOCKED" as const,
            read: beforeSend.read,
            ...(beforeSend.read.kind === "ABSENT" ? { error: new Error("无法访问本地报价恢复存储，报价命令尚未发送") } : {})
          };
        }
        const commandRead = readPersistedCommandRecovery(
          beforeSend.storage,
          principal.subjectId,
          `property:${propertyId}`
        );
        if (commandRead.kind !== "ABSENT") {
          return {
            kind: "BLOCKED" as const,
            read: beforeSend.read,
            error: new Error("本物业另有未收口的操作；请先核对原操作结果，报价命令尚未发送")
          };
        }
        if (!saveQuoteCommandRecovery(beforeSend.storage, pending)) {
          const error = new Error("无法保存本地报价恢复记录，报价命令尚未发送");
          return { kind: "BLOCKED" as const, read: { kind: "READ_ERROR" as const, error }, error };
        }
        return { kind: "CLAIMED" as const };
      });
    } catch {
      finishQuoteSubmission(metadata.idempotencyKey);
      if (quoteRequestGuard.isActive(requestLease)) {
        const error = new Error("无法取得跨标签报价协调锁，报价命令尚未发送");
        updateQuoteRecoverySnapshot({ kind: "READ_ERROR", error });
        setError(error);
        setBusy(false);
      }
      return;
    }
    if (!quoteRequestGuard.isActive(requestLease)) {
      finishQuoteSubmission(metadata.idempotencyKey);
      return;
    }
    if (claim.kind === "STALE") {
      finishQuoteSubmission(metadata.idempotencyKey);
      setBusy(false);
      return;
    }
    if (claim.kind === "BLOCKED") {
      finishQuoteSubmission(metadata.idempotencyKey);
      updateQuoteRecoverySnapshot(claim.read);
      setError(claim.error);
      setBusy(false);
      return;
    }
    updateQuoteRecoverySnapshot({ kind: "VALID", pending });
    try {
      const response = await api.quote(input, metadata, signal);
      if (!quoteRequestGuard.isActive(requestLease)) return;
      const completed = await transitionQuoteRecovery(metadata.idempotencyKey, "CLEAR");
      if (!quoteRequestGuard.isActive(requestLease)) return;
      updateQuoteRecoverySnapshot(completed.read);
      if (!completed.matched || !completed.changed) {
        setError(new Error("报价已返回，但另一笔报价恢复记录正在处理中；当前结果未应用。"));
        return;
      }
      if (latestQuoteSignature.current === inputSignature) {
        settledQuoteSignature.current = inputSignature;
        setQuoteSignature(inputSignature);
        setQuote(response.quote);
      } else {
        setError(undefined);
      }
    } catch (nextError) {
      if (!quoteRequestGuard.isActive(requestLease)) return;
      const definitive = nextError instanceof ApiError
        && nextError.status < 500
        && nextError.code !== "COMMAND_STATUS_UNKNOWN";
      if (definitive) {
        const completed = await transitionQuoteRecovery(metadata.idempotencyKey, "CLEAR");
        if (!quoteRequestGuard.isActive(requestLease)) return;
        updateQuoteRecoverySnapshot(completed.read);
        if (!completed.matched || !completed.changed) {
          setError(new Error("报价处理结果已返回，但本地恢复记录已经变化；当前结果未应用。"));
          return;
        }
        const temporaryOffer = temporaryOtherRoomOfferFromQuoteError(nextError);
        if (temporaryOffer) {
          setTemporaryOtherRoomDraft((draft) => ({ ...draft, offer: temporaryOffer }));
        } else if (nextError.code === "ENTITLEMENT_CONFLICT") {
          setTemporaryOtherRoomDraft({ confirmed: false, reason: "" });
        }
        settledQuoteSignature.current = inputSignature;
        setError(staffQuoteError(nextError, unit?.code ?? "所选房源", arrivalDate, departureDate));
        return;
      }
      setError(nextError);
      const unknown = await transitionQuoteRecovery(metadata.idempotencyKey, "UNKNOWN");
      if (!quoteRequestGuard.isActive(requestLease)) return;
      updateQuoteRecoverySnapshot(unknown.read);
      if (!unknown.matched || !unknown.changed) {
        setError(new Error("报价状态暂未确认，但本地恢复记录已经变化；请从当前恢复入口继续核对。"));
      }
    } finally {
      finishQuoteSubmission(metadata.idempotencyKey);
      if (quoteRequestGuard.isActive(requestLease)) setBusy(false);
    }
  }

  async function recoverQuote(options: { automatic?: boolean } = {}) {
    if (!pendingQuote) return;
    onRecoveryOutcome(undefined);
    const requestLease = quoteRequestGuard.begin(quoteRecoveryScope);
    setBusy(true);
    setError(undefined);
    try {
      const receipt = await api.resolveCommandResult(
        pendingQuote.input.propertyId,
        "CREATE_QUOTE",
        pendingQuote.metadata.idempotencyKey
      );
      if (!quoteRequestGuard.isActive(requestLease)) return;
      if (receipt.executionStatus === "UNKNOWN") {
        const unknown = await transitionQuoteRecovery(pendingQuote.metadata.idempotencyKey, "UNKNOWN");
        if (!quoteRequestGuard.isActive(requestLease)) return;
        updateQuoteRecoverySnapshot(unknown.read);
        setError(new Error("原报价仍在处理，请稍后再次核对；系统不会重复报价。"));
        return;
      }
      if (!receipt.businessCommitted) {
        if (!quoteNotExecutedReceiptIsCoherent(receipt)) {
          setError(new Error("原报价的未执行结果无法核对；已继续暂停新报价。"));
          return;
        }
        const completed = await transitionQuoteRecovery(pendingQuote.metadata.idempotencyKey, "CLEAR");
        if (!quoteRequestGuard.isActive(requestLease)) return;
        updateQuoteRecoverySnapshot(completed.read);
        if (!completed.matched || !completed.changed) {
          setError(new Error("原报价结果已返回，但本地恢复记录已经变化；请重新核对。"));
          return;
        }
        onRecoveryOutcome(new Error("服务端确认该报价命令未执行，可以重新报价。"));
        return;
      }
      const recoveredQuote = quoteFromReceipt(receipt, pendingQuote);
      const recoveredQuoteExpired = Date.parse(recoveredQuote.expiresAt) <= Date.now();
      if (recoveredQuoteWaitsForCurrentTarget(recoveredQuoteExpired, currentQuoteSignature)) {
        setError(new Error("已确认原报价结果，但当前房态与报价目标尚未载入；恢复记录继续保留，待房态恢复后再应用原结果。"));
        return;
      }
      if (!recoveredQuoteExpired && latestQuoteSignature.current !== pendingQuote.inputSignature) {
        setError(new Error("已确认原报价结果，但当前房态与原报价选择不一致；恢复记录继续保留，请重新打开原房源和日期。"));
        return;
      }
      if (!recoveredQuoteExpired) {
        setUseMemberEntitlement(Boolean(pendingQuote.input.memberId));
        setMemberId(pendingQuote.input.memberId ?? "");
        setMemberSearch("");
        setTemporaryOtherRoomDraft(pendingQuote.input.temporaryOtherRoom === true
          ? {
              offer: {
                temporaryOtherRoomAvailable: true,
                originalRoomTypeCode: recoveredQuote.temporaryOtherRoomArrangement!.originalRoomTypeCode,
                actualRoomTypeCode: recoveredQuote.temporaryOtherRoomArrangement!.actualRoomTypeCode
              },
              confirmed: true,
              reason: ""
            }
          : { confirmed: false, reason: "" });
      }
      const completed = await transitionQuoteRecovery(pendingQuote.metadata.idempotencyKey, "CLEAR");
      if (!quoteRequestGuard.isActive(requestLease)) return;
      updateQuoteRecoverySnapshot(completed.read);
      if (!completed.matched || !completed.changed) {
        setError(new Error("原报价结果已返回，但本地恢复记录已经变化；当前结果未应用。"));
        return;
      }
      if (recoveredQuoteExpired) {
        onRecoveryOutcome(new Error("原报价结果已确认，但报价已经过期；请重新报价。"));
        return;
      }
      settledQuoteSignature.current = pendingQuote.inputSignature;
      setQuoteSignature(pendingQuote.inputSignature);
      setQuote(recoveredQuote);
    } catch (nextError) {
      if (!quoteRequestGuard.isActive(requestLease)) return;
      setError(nextError);
      if (options.automatic && pendingQuote.state === "SENDING" && pendingQuote.ownerTabId === quoteRecoveryOwnerId) {
        const unknown = await transitionQuoteRecovery(pendingQuote.metadata.idempotencyKey, "UNKNOWN");
        if (!quoteRequestGuard.isActive(requestLease)) return;
        updateQuoteRecoverySnapshot(unknown.read);
        if (unknown.matched && unknown.changed) {
          setError(new Error("自动核对原报价结果失败，已改为人工核对；新的报价和订单写入继续暂停。"));
        }
        return;
      }
      const current = browserQuoteRecovery(principal.subjectId, propertyId);
      updateQuoteRecoverySnapshot(current.read);
    } finally {
      if (quoteRequestGuard.isActive(requestLease)) setBusy(false);
    }
  }

  async function discardCorruptQuoteAfterReview() {
    try {
      const read = await withRecoveryStorageLock(recoveryCoordinationScope, () => {
        const current = browserQuoteRecovery(principal.subjectId, propertyId);
        if (!current.storage || current.read.kind !== "CORRUPT") return current.read;
        if (!clearCorruptQuoteCommandRecovery(current.storage, principal.subjectId, propertyId)) {
          return { kind: "READ_ERROR", error: new Error("无法清除损坏的本地报价恢复记录；写入口继续暂停，请联系管理员处理浏览器存储权限") } as const;
        }
        return { kind: "ABSENT" } as const;
      });
      updateQuoteRecoverySnapshot(read);
      if (read.kind === "ABSENT") setError(undefined);
    } catch {
      updateQuoteRecoverySnapshot({ kind: "READ_ERROR", error: new Error("无法取得跨标签报价协调锁；写入口继续暂停") });
    }
  }

  useEffect(() => {
    setOrphanQuoteReviewConfirmed(false);
  }, [pendingQuote?.metadata.idempotencyKey, pendingQuote?.ownerTabId, pendingQuote?.state]);

  useEffect(() => {
    if (quoteRecoveryRead.kind === "ABSENT") return;
    if (!pendingQuote || !shouldAutoResolveOwnSendingQuoteRecovery({
      recoveryIdentity: currentQuoteRecoveryIdentity,
      attemptedIdentity: attemptedQuoteRecoveryIdentity,
      recoveryState: pendingQuote.state,
      recoveryOwnerId: pendingQuote.ownerTabId,
      currentOwnerId: quoteRecoveryOwnerId,
      busy
    })) return;
    const recoveryIdentity = currentQuoteRecoveryIdentity!;
    const timeout = window.setTimeout(() => {
      if (autoResolvedRecoveryIdentities.current.has(recoveryIdentity)) return;
      autoResolvedRecoveryIdentities.current.add(recoveryIdentity);
      void recoverQuote({ automatic: true });
    }, 500);
    return () => window.clearTimeout(timeout);
  }, [attemptedQuoteRecoveryIdentity, autoResolvedRecoveryIdentities, currentQuoteRecoveryIdentity, pendingQuote?.metadata.idempotencyKey, pendingQuote?.ownerTabId, pendingQuote?.state, quoteRecoveryOwnerId, busy, quoteRecoveryRead.kind]);

  useEffect(() => {
    if (!currentQuoteInput || quoteCommandsBlocked || settledQuoteSignature.current === currentQuoteSignature) return;
    const timeout = window.setTimeout(() => void createQuote(), 300);
    return () => window.clearTimeout(timeout);
  }, [currentQuoteSignature, quoteCommandsBlocked]);

  const primaryGuestForm: GuestFormValue = {
    fullName: guestName,
    nickname: guestNickname,
    phone: guestPhone,
    documentNumber: guestDocument
  };
  const guestsComplete = guestFormComplete(primaryGuestForm) && additionalGuests.every(guestFormComplete);
  const guestCount = 1 + additionalGuests.length;
  const paidPricingDraft = quote && !useMemberEntitlement && quote.stayType !== "FREE"
    ? createOrderPricingDraft({
        bookingChannelCode,
        channelOrderReference,
        targetAmountYuan: targetContractAmountYuan,
        policyBaseAmountMinor: quote.currentContractAmount.minorUnits,
        channelPriceDifferenceReason,
        manualPriceAdjustmentReason
      })
    : undefined;
  const backfillCollectionAmountMinor = parseBackfillCollectionYuanToMinor(backfillAmountYuan);
  const backfillSubmitBlockReason = backfill && unit
    ? backfillSubmitBlockedReason({
        commandsBlocked: quoteCommandsBlocked,
        quoteIsCurrent,
        guestCount,
        occupancyCapacity: unit.occupancyCapacity
      })
    : undefined;
  const createOrderSubmitBlockReason = !backfill && unit && quote
    ? createOrderSubmitBlockedReason({
        commandsBlocked: quoteCommandsBlocked,
        quoteIsCurrent,
        guestsComplete,
        guestCount,
        occupancyCapacity: unit.occupancyCapacity,
        temporaryOtherRoomConfirmed: temporaryOtherRoomDraft.confirmed,
        temporaryOtherRoomReasonValid: Boolean(temporaryOtherRoomCreateOrderCommand({}, temporaryOtherRoomDraft.reason)),
        channelRequired: bookingChannelRequiredForStay(useMemberEntitlement, quote.stayType),
        pricingComplete: Boolean(paidPricingDraft?.complete),
        freeStayMissing: quote.stayType === "FREE" && (!freeStayReason.trim() || !freeStayCategoryCode)
      })
    : undefined;

  function addAdditionalGuest() {
    if (!unit || !canAddGuest(unit.occupancyCapacity, additionalGuests.length)) return;
    nextAdditionalGuestKey.current += 1;
    setAdditionalGuests((current) => [...current, {
      key: nextAdditionalGuestKey.current,
      fullName: "",
      nickname: "",
      phone: "",
      documentNumber: ""
    }]);
  }

  function updateAdditionalGuest(key: number, field: keyof GuestFormValue, value: string) {
    setAdditionalGuests((current) => current.map((guest) => guest.key === key ? { ...guest, [field]: value } : guest));
  }

  function removeAdditionalGuest(key: number) {
    setAdditionalGuests((current) => current.filter((guest) => guest.key !== key));
  }

  function clearBackfillCollectionDraft() {
    setBackfillAmountYuan("");
    setBackfillMethod("WECOM");
    setBackfillTransactionReference("");
    setBackfillCashCollector("");
    setBackfillCashNote("");
  }

  function createOrder(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const channelRequired = bookingChannelRequiredForStay(useMemberEntitlement, quote?.stayType);
    if (quoteCommandsBlocked || !quote || !quoteIsCurrent || guestCount > (unit?.occupancyCapacity ?? 0)) return;
    if (!guestsComplete) {
      if (backfill) setError(new Error("请完整填写主要入住人及所有同行人的姓名和昵称"));
      return;
    }
    const temporaryOtherRoomCommand = temporaryOtherRoomDraft.confirmed
      ? temporaryOtherRoomCreateOrderCommand({}, temporaryOtherRoomDraft.reason)
      : undefined;
    if (temporaryOtherRoomDraft.confirmed && !temporaryOtherRoomCommand) {
      setError(new Error("请填写 1 至 200 个字符的现场安排原因"));
      return;
    }
    if (!backfill && ((channelRequired && !paidPricingDraft?.complete) || (quote.stayType === "FREE" && (!freeStayReason.trim() || !freeStayCategoryCode)))) return;
    const guestInputs = createOrderGuestInputs(primaryGuestForm, additionalGuests);
    const orderInput: Record<string, unknown> = {
      propertyId,
      quoteId: quote.quoteId,
      primaryGuest: guestInputs.primaryGuest,
      additionalGuests: guestInputs.additionalGuests,
      ...(!useMemberEntitlement && quote.stayType !== "FREE" && bookingChannelCode ? {
        bookingChannelCode,
        channelOrderReference: bookingChannelCode === "WECOM" ? null : channelOrderReference.trim(),
        targetCurrentContractAmountMinor: paidPricingDraft!.targetCurrentContractAmountMinor,
        ...(paidPricingDraft!.channelReasonRequired ? { channelPriceDifferenceReason: channelPriceDifferenceReason.trim() } : {}),
        ...(paidPricingDraft!.manualReasonRequired ? { manualPriceAdjustmentReason: manualPriceAdjustmentReason.trim() } : {})
      } : {}),
      ...(quote.stayType === "FREE" ? { freeStayReason: freeStayReason.trim(), freeStayCategoryCode } : {})
    };
    if (backfill) {
      const reviewError = backfillReviewValidationError({
        stayType: quote.stayType,
        backfillReason,
        freeStayCategoryCode,
        freeStayReason,
        bookingChannelCode,
        targetAmountYuan: targetContractAmountYuan,
        contractAmountMinor: paidPricingDraft?.targetCurrentContractAmountMinor,
        channelOrderReference,
        channelReasonRequired: Boolean(paidPricingDraft?.channelReasonRequired),
        channelPriceDifferenceReason,
        manualReasonRequired: Boolean(paidPricingDraft?.manualReasonRequired),
        manualPriceAdjustmentReason,
        collectionAmountYuan: backfillAmountYuan,
        collectionAmountMinor: backfillCollectionAmountMinor,
        collectionMethod: backfillMethod,
        transactionReference: backfillTransactionReference,
        cashCollector: backfillCashCollector,
        cashNote: backfillCashNote
      });
      if (reviewError) {
        setError(new Error(reviewError));
        return;
      }
      const submissionError = completedStayBackfillSubmissionError(arrivalDate, departureDate, businessDate);
      if (submissionError) {
        setError(new Error(submissionError));
        return;
      }
      const backfillCollection = bookingChannelCode === "WECOM" && backfillCollectionAmountMinor !== undefined
        ? backfillCollectionCommandInput({
            amountMinor: backfillCollectionAmountMinor,
            method: backfillMethod,
            transactionReference: backfillTransactionReference,
            cashCollector: backfillCashCollector,
            cashNote: backfillCashNote
          })
        : undefined;
      if (bookingChannelCode === "WECOM" && !backfillCollection) {
        setError(new Error("请核对补录实收金额及对应的真实收款凭据"));
        return;
      }
      setError(undefined);
      onCommand(completedStayBackfillCommandRequest({
        ...orderInput,
        ...(backfillCollection ? { backfillCollection } : {})
      }, backfillReason));
      return;
    }
    if (temporaryOtherRoomCommand) {
      onCommand(temporaryOtherRoomCreateOrderCommand(orderInput, temporaryOtherRoomDraft.reason)!);
      return;
    }
    onCommand({
      commandType: "CREATE_ORDER",
      title: "创建订单",
      description: "确认住宿人名单、锁定计价政策版本、库存及会员覆盖差异。",
      initialReason: { code: "CREATE_STANDARD_ORDER", note: "" },
      ...(useMemberEntitlement ? { presentation: "MEMBER_STAY" as const } : {}),
      input: orderInput
    });
  }

  return (
    <aside className="quote-workbench" aria-labelledby="quote-heading">
      <header className="panel-heading">
        <div><p className="eyebrow">{backfill ? "补录住宿" : "办理住宿"}</p><h2 id="quote-heading">{backfill ? "补录住宿" : "住宿金额"}</h2></div>
        <button className="icon-button" type="button" onClick={onClose} title="关闭办理区域" aria-label="关闭办理区域"><X aria-hidden="true" size={18} /></button>
      </header>
      {!backfill ? <InlineError error={error} title="报价失败" /> : null}
      {quoteRecoveryRead.kind === "CORRUPT" ? (
        <DamagedCommandRecoveryNotice
          error={quoteRecoveryError}
          onDiscard={discardCorruptQuoteAfterReview}
          testId="quote-damaged-command-recovery"
        />
      ) : <InlineError error={quoteRecoveryError} title="本地报价恢复记录不可用" />}
      {pendingQuote?.state === "SENDING" && !ownQuoteSubmissionActive ? (
        <div className="recovery-bar" data-testid="quote-recovery">
          <div>
            <strong>{pendingQuote.ownerTabId === quoteRecoveryOwnerId ? "报价正在提交" : "另一标签正在提交报价"}</strong>
            <p>{pendingQuote.ownerTabId === quoteRecoveryOwnerId
              ? "新的报价和订单写入已暂停；原提交返回或转为待查询状态后再继续。"
              : "新的报价和订单写入已暂停。请先回到原报价标签等待；如果原标签已经关闭，可核对原报价是否完成。"}</p>
          </div>
          {pendingQuote.ownerTabId !== quoteRecoveryOwnerId ? <div className="recovery-damaged-actions">
            <label>
              <input
                type="checkbox"
                checked={orphanQuoteReviewConfirmed}
                onChange={(event) => setOrphanQuoteReviewConfirmed(event.target.checked)}
              />
              <span>我已关闭原报价标签，需要核对原报价结果</span>
            </label>
            <button
              className="button button-secondary"
              type="button"
              disabled={!orphanQuoteReviewConfirmed || busy}
              onClick={() => void recoverQuote()}
            >核对原报价结果</button>
          </div> : manualOwnSendingRecoveryAvailable ? <button
            className="button button-secondary"
            type="button"
            disabled={busy}
            onClick={() => void recoverQuote()}
          ><RefreshCw aria-hidden="true" size={17} />核对原报价结果</button> : null}
        </div>
      ) : pendingQuote?.state === "UNKNOWN" ? (
        <div className="recovery-bar" data-testid="quote-recovery">
          <div><strong>报价结果尚未确认</strong><p>系统不会重复报价；网络恢复后可重新查询本次结果。</p></div>
          <button className="button button-secondary" type="button" onClick={() => void recoverQuote()} disabled={busy}>
            <RefreshCw aria-hidden="true" size={17} />核对原报价结果
          </button>
        </div>
      ) : null}
      {!unit ? <EmptyState title="选择可售库存" detail="在房态表中选择整房或床位后开始报价。" /> : (
        <>
          <div className="selected-unit"><strong>{unitName(unit)}</strong><span>{arrivalDate} 至 {departureDate}</span></div>
          {backfill ? <fieldset className="backfill-stay-kind" data-testid="backfill-stay-kind">
            <legend>住宿类型</legend>
            <div className="segmented-control">
              <label><input type="radio" name="backfill-stay-kind" value="PAID" checked={backfillStayKind === "PAID"} onChange={() => setBackfillStayKind("PAID")} /><span>普通住宿</span></label>
              <label><input type="radio" name="backfill-stay-kind" value="FREE" checked={backfillStayKind === "FREE"} onChange={() => { setBackfillStayKind("FREE"); setBookingChannelCode(""); setChannelOrderReference(""); clearBackfillCollectionDraft(); }} /><span>免费入住</span></label>
            </div>
          </fieldset> : null}
          {!backfill && stayType !== "FREE" ? <div className="member-benefit-controls">
            <label className="checkbox-label"><input
              type="checkbox"
              checked={useMemberEntitlement}
              onChange={(event) => {
                const enabled = event.target.checked;
                setUseMemberEntitlement(enabled);
                if (enabled) {
                  setBookingChannelCode("");
                  setChannelOrderReference("");
                } else {
                  setMemberId("");
                  setMemberSearch("");
                }
              }}
              disabled={busy || quoteRecoveryRead.kind !== "ABSENT"}
              data-testid="use-member-entitlement"
            />本次住宿使用会员权益</label>
            {useMemberEntitlement ? <div className="form-grid quote-form" data-testid="member-benefit-picker">
              <label>搜索会员
                <input value={memberSearch} onChange={(event) => setMemberSearch(event.target.value)} placeholder="昵称、姓名、手机号或微信号" disabled={busy || quoteRecoveryRead.kind !== "ABSENT"} data-testid="member-search" />
              </label>
              <label>会员档案
                <select
                  value={quoteMemberId}
                  onChange={(event) => {
                    const selectedMemberId = event.target.value;
                    setMemberId(selectedMemberId);
                    const selectedMember = memberProfiles.find((member) => member.id === selectedMemberId);
                    if (!selectedMember) return;
                    const nextGuests = applyMemberSelectionToGuestForms(additionalGuests, selectedMember);
                    setGuestNickname(nextGuests.primaryGuest.nickname);
                    setGuestName(nextGuests.primaryGuest.fullName);
                    setGuestPhone(nextGuests.primaryGuest.phone);
                    setGuestDocument(nextGuests.primaryGuest.documentNumber);
                    setAdditionalGuests(nextGuests.additionalGuests);
                  }}
                  disabled={busy || quoteRecoveryRead.kind !== "ABSENT"}
                  data-testid="member-profile-select"
                >
                  <option value="">请选择会员</option>
                  {memberProfiles.map((member) => <option key={member.id} value={member.id}>{member.nickname} · {member.full_name} · {member.phone}</option>)}
                </select>
              </label>
              {memberChoices.loading ? <p role="status">正在查找会员…</p> : null}
              <InlineError error={memberChoices.error} title="无法查找会员" />
              {memberChoices.error ? <button type="button" className="button button-secondary" onClick={memberChoices.retry}>重试查找</button> : null}
              {memberChoices.nextCursor ? <button type="button" className="button button-secondary" disabled={memberChoices.loading} onClick={memberChoices.loadMore}>加载更多会员</button> : null}
              {!memberChoices.loading && !memberChoices.error && !memberProfiles.length ? <p role="status">未找到有本店住宿合同的会员，请更换关键词或先办理会员订单。</p> : null}
            </div> : null}
            {temporaryOtherRoomDraft.offer ? <TemporaryOtherRoomFields
              offer={temporaryOtherRoomDraft.offer}
              confirmed={temporaryOtherRoomDraft.confirmed}
              reason={temporaryOtherRoomDraft.reason}
              disabled={busy || quoteRecoveryRead.kind !== "ABSENT"}
              onConfirmedChange={(confirmed) => {
                setTemporaryOtherRoomDraft((draft) => ({ ...draft, confirmed }));
                setError(undefined);
              }}
              onReasonChange={(reason) => setTemporaryOtherRoomDraft((draft) => ({ ...draft, reason }))}
            /> : null}
          </div> : null}
          <div
            className={`room-status-pricing-progress${busy ? "" : " is-idle"}`}
            {...(busy ? { role: "status" as const } : { "aria-hidden": true })}
          >{ownQuoteSubmissionActive ? "报价正在提交" : "正在计算住宿金额"}</div>
          {quote ? (
            <div
              className={`quote-result${quoteIsCurrent ? "" : " is-layout-placeholder"}`}
              {...(quoteIsCurrent ? { "data-testid": "quote-result" } : { "aria-hidden": true })}
            >
              {(() => {
                const summary = quotePricingSummary(quote);
                const memberSummary = membershipCoverageSummary(quote);
                return (
              <div className="quote-amounts">
                {useMemberEntitlement ? <>
                  <div><span>总住宿晚数</span><strong>{memberSummary.totalNights} 晚</strong></div>
                  <div><span>覆盖晚数</span><strong>{memberSummary.coveredNights} 晚</strong></div>
                  <div><span>未覆盖晚数</span><strong>{memberSummary.uncoveredNights} 晚</strong></div>
                  <div><span>未覆盖金额</span><strong>{formatMoney(memberSummary.uncoveredAmount)}</strong></div>
                  {temporaryOtherRoomDraft.confirmed && temporaryOtherRoomDraft.offer ? <>
                    <div><span>原适用房型</span><strong>{roomStatusRoomTypeLabel(temporaryOtherRoomDraft.offer.originalRoomTypeCode)}</strong></div>
                    <div><span>实际安排</span><strong>{unitName(unit)}</strong></div>
                    <div><span>本次覆盖晚数</span><strong>{memberSummary.coveredNights} 晚</strong></div>
                    <div><span>本次补差</span><strong>{formatMoney({ currency: quote.cashRemainder.currency, minorUnits: 0 })}</strong></div>
                  </> : null}
                </> : <>
                  <div><span>住宿晚数</span><strong>{summary.nights} 晚</strong></div>
                  <div><span>计价依据</span><strong>{summary.pricingBasis}</strong></div>
                  <div><span>{quote.stayType === "FREE" ? "住宿金额" : "政策基础金额"}</span><strong>{formatMoney(summary.amount)}</strong></div>
                </>}
              </div>
                );
              })()}
              <form className="guest-section" aria-labelledby="guest-heading" onSubmit={createOrder} onChange={backfill ? () => setError(undefined) : undefined} noValidate={backfill}>
                <div className="guest-section-heading">
                  <h3 id="guest-heading">住宿人</h3>
                  <span>{guestCount} / {unit.occupancyCapacity} 人</span>
                </div>
                <fieldset className="guest-entry" data-testid="primary-guest-entry">
                  <legend>主要入住人 <span>主要联系人</span></legend>
                  <div className="form-grid">
                    <label>昵称<input value={guestNickname} onChange={(event) => setGuestNickname(event.target.value)} required maxLength={200} data-testid="primary-guest-nickname" /></label>
                    <label>姓名<input value={guestName} onChange={(event) => setGuestName(event.target.value)} required maxLength={GUEST_FULL_NAME_MAX_LENGTH} data-testid="primary-guest-name" /></label>
                    <label>联系电话<input value={guestPhone} onChange={(event) => setGuestPhone(event.target.value)} inputMode="tel" maxLength={80} data-testid="primary-guest-phone" /></label>
                    <label>证件号码（选填）<input value={guestDocument} onChange={(event) => setGuestDocument(event.target.value)} maxLength={120} data-testid="primary-guest-document" /></label>
                  </div>
                </fieldset>
                {additionalGuests.map((guest, index) => (
                  <fieldset className="guest-entry" key={guest.key} data-testid="additional-guest-entry">
                    <legend>
                      同行人 {index + 1}
                      <button className="icon-button" type="button" onClick={() => removeAdditionalGuest(guest.key)} aria-label={`删除同行人 ${index + 1}`} title="删除同行人">
                        <Trash2 aria-hidden="true" size={16} />
                      </button>
                    </legend>
                    <div className="form-grid">
                      <label>昵称<input value={guest.nickname} onChange={(event) => updateAdditionalGuest(guest.key, "nickname", event.target.value)} required maxLength={200} data-testid={`additional-guest-${index}-nickname`} /></label>
                      <label>姓名<input value={guest.fullName} onChange={(event) => updateAdditionalGuest(guest.key, "fullName", event.target.value)} required maxLength={GUEST_FULL_NAME_MAX_LENGTH} data-testid={`additional-guest-${index}-name`} /></label>
                      <label>联系电话<input value={guest.phone} onChange={(event) => updateAdditionalGuest(guest.key, "phone", event.target.value)} inputMode="tel" maxLength={80} data-testid={`additional-guest-${index}-phone`} /></label>
                      <label>证件号码（选填）<input value={guest.documentNumber} onChange={(event) => updateAdditionalGuest(guest.key, "documentNumber", event.target.value)} maxLength={120} data-testid={`additional-guest-${index}-document`} /></label>
                    </div>
                  </fieldset>
                ))}
                <button className="button button-secondary guest-add-button" type="button" onClick={addAdditionalGuest} disabled={!canAddGuest(unit.occupancyCapacity, additionalGuests.length)} data-testid="add-additional-guest">
                  <UserPlus aria-hidden="true" size={17} />添加同行人
                </button>
                <div className="form-grid guest-order-fields">
                  {!useMemberEntitlement && quote.stayType !== "FREE" ? <label>订单来源渠道
                    <select
                      value={bookingChannelCode}
                      onChange={(event) => {
                        const code = event.target.value as BookingChannelCode | "";
                        setBookingChannelCode(code);
                        setChannelOrderReference("");
                        setTargetContractAmountYuan(code === "WECOM" ? formatMinorForYuanInput(quote.currentContractAmount.minorUnits) : "");
                        setChannelPriceDifferenceReason("");
                        setManualPriceAdjustmentReason("");
                        if (backfill) clearBackfillCollectionDraft();
                      }}
                      required
                      data-testid="booking-channel-code"
                    >
                      <option value="">请选择渠道</option>
                      {Object.entries(bookingChannelLabels).map(([code, label]) => <option key={code} value={code}>{label}</option>)}
                    </select>
                  </label> : null}
                  {!useMemberEntitlement && quote.stayType !== "FREE" && bookingChannelCode && bookingChannelCode !== "WECOM" ? <label>渠道订单号（必填）<input value={channelOrderReference} onChange={(event) => setChannelOrderReference(event.target.value)} maxLength={200} required data-testid="channel-order-reference" /></label> : null}
                  {!useMemberEntitlement && quote.stayType !== "FREE" && bookingChannelCode ? <>
                    <label>{bookingChannelCode === "WECOM" ? "本单金额" : "本单渠道应结金额（必填）"}
                      <input
                        value={targetContractAmountYuan}
                        onChange={(event) => setTargetContractAmountYuan(event.target.value)}
                        inputMode="numeric"
                        placeholder="0"
                        min={bookingChannelCode === "WECOM" ? 0 : 1}
                        pattern={bookingChannelCode === "WECOM" ? "[0-9]+(?:\\.00)?" : "[1-9][0-9]*(?:\\.00)?"}
                        required
                        data-testid="target-contract-amount"
                      />
                    </label>
                    {paidPricingDraft?.differenceFromPolicyMinor !== undefined ? <div className="span-two inline-summary" data-testid="create-order-price-difference">
                      <span>政策基础金额 {formatMoney(quote.currentContractAmount)}</span>
                      <strong>与政策基础金额差额 {formatMoney({ currency: quote.currentContractAmount.currency, minorUnits: paidPricingDraft.differenceFromPolicyMinor })}</strong>
                    </div> : null}
                    {paidPricingDraft?.channelReasonRequired ? <label className="span-two">渠道价格差异说明
                      <textarea value={channelPriceDifferenceReason} onChange={(event) => setChannelPriceDifferenceReason(event.target.value)} required maxLength={1000} rows={2} data-testid="channel-price-difference-reason" />
                    </label> : null}
                    {paidPricingDraft?.manualReasonRequired ? <label className="span-two">人工调价原因
                      <textarea value={manualPriceAdjustmentReason} onChange={(event) => setManualPriceAdjustmentReason(event.target.value)} required maxLength={1000} rows={2} data-testid="manual-price-adjustment-reason" />
                    </label> : null}
                  </> : null}
                  {backfill ? <>
                    <label className="span-two">补录原因<textarea rows={2} value={backfillReason} onChange={(event) => setBackfillReason(event.target.value)} required maxLength={1000} data-testid="backfill-reason" /></label>
                    {!useMemberEntitlement && quote.stayType !== "FREE" && bookingChannelCode === "WECOM" ? <>
                      <label>补录实收金额（元）<input inputMode="decimal" min="0" max={targetContractAmountYuan || undefined} step="0.01" pattern={"[0-9]+(?:\\.[0-9]{1,2})?"} value={backfillAmountYuan} onChange={(event) => { const value = event.target.value; setBackfillAmountYuan(value); const amountMinor = parseBackfillCollectionYuanToMinor(value); if (amountMinor === undefined || amountMinor === 0) { setBackfillMethod("WECOM"); setBackfillTransactionReference(""); setBackfillCashCollector(""); setBackfillCashNote(""); } }} placeholder="可填 0" required data-testid="backfill-amount" /></label>
                      {backfillCollectionAmountMinor !== undefined && backfillCollectionAmountMinor > 0 ? <>
                        <label>收款方式<select value={backfillMethod} onChange={(event) => { setBackfillMethod(event.target.value); setBackfillTransactionReference(""); setBackfillCashCollector(""); setBackfillCashNote(""); }} data-testid="backfill-method"><option value="WECOM">企业微信</option><option value="BANK_TRANSFER">银行转账</option><option value="CASH">现金</option></select></label>
                        {backfillMethod === "WECOM" ? <ExternalPaymentPicker propertyId={propertyId} value={backfillTransactionReference} amountMinor={backfillCollectionAmountMinor} testId="backfill-transaction-reference" onChange={(reference, item) => { setBackfillTransactionReference(reference); if (item?.amountMinor) setBackfillAmountYuan(String(item.amountMinor / 100)); }} /> : backfillMethod === "BANK_TRANSFER" ? <label>交易单号<input value={backfillTransactionReference} onChange={(event) => setBackfillTransactionReference(event.target.value)} required data-testid="backfill-transaction-reference" /></label> : null}
                        {backfillMethod === "CASH" ? <>
                          <label>收款人<input value={backfillCashCollector} onChange={(event) => setBackfillCashCollector(event.target.value)} required maxLength={200} data-testid="backfill-cash-collector" /></label>
                          <label className="span-two">现金收款备注<textarea rows={2} value={backfillCashNote} onChange={(event) => setBackfillCashNote(event.target.value)} required maxLength={1000} data-testid="backfill-cash-note" /></label>
                        </> : null}
                      </> : null}
                    </> : null}
                  </> : null}
                  {quote.stayType === "FREE" ? <>
                    <label>免费入住类型
                      <select value={freeStayCategoryCode} onChange={(event) => setFreeStayCategoryCode(event.target.value as "VOLUNTEER" | "RECEPTION")} required data-testid="free-stay-category-code">
                        <option value="">请选择类型</option>
                        {Object.entries(freeStayCategoryLabels).map(([code, label]) => <option key={code} value={code}>{label}</option>)}
                      </select>
                    </label>
                    <label className="span-two">免费入住原因<textarea rows={3} value={freeStayReason} onChange={(event) => setFreeStayReason(event.target.value)} required maxLength={1000} data-testid="free-stay-reason" /></label>
                  </> : null}
                </div>
                {backfill ? <InlineError error={error} title="无法进入补录核对" /> : null}
                {backfillSubmitBlockReason ? <InlineError error={new Error(backfillSubmitBlockReason)} title="暂时不能核对补录" /> : null}
                {createOrderSubmitBlockReason ? <InlineError error={new Error(createOrderSubmitBlockReason)} title="暂时不能核对订单" /> : null}
                <button className="button button-primary full-width" type="submit" disabled={backfill ? Boolean(backfillSubmitBlockReason) : Boolean(createOrderSubmitBlockReason)} data-testid={backfill ? "backfill-submit" : "create-order"}>
                  <FilePlus2 aria-hidden="true" size={17} />{backfill ? "核对并补录住宿" : "核对并创建订单"}
                </button>
              </form>
            </div>
          ) : null}
        </>
      )}
    </aside>
  );
}

const ROOM_STATUS_PAGE_SIZE = 50;
const ROOM_STATUS_REFRESH_START_LEAD_MS = 3_000;
const ROOM_STATUS_RESPONSE_INSTALL_HEADROOM_MS = ROOM_STATUS_REFRESH_START_LEAD_MS;
const ROOM_STATUS_RECOVERY_INSTALL_HEADROOM_MS = 4_000;
const ROOM_STATUS_WRITE_HEADROOM_MS = 750;
const ROOM_STATUS_REFRESH_RETRY_MS = 250;
const ROOM_STATUS_STALE_RESPONSE_RETRY_BASE_MS = 500;
const ROOM_STATUS_STALE_RESPONSE_RETRY_MAX_MS = 4_000;
const ROOM_STATUS_QUERY_FAILURE_RETRY_BASE_MS = 1_000;
const ROOM_STATUS_QUERY_FAILURE_RETRY_MAX_MS = 8_000;
const ROOM_STATUS_LOW_FRESHNESS_RESPONSE_LIMIT = 3;
const ROOM_STATUS_QUERY_TIMEOUT_MS = 15_000;
const ROOM_STATUS_RANGE_LOADING_NOTICE_DELAY_MS = 250;
const ROOM_STATUS_RESTORATION_PREFIX = "qintopia.room-status-view.v1";
const selectionActionCodes = new Set(["CREATE_ORDER", "CREATE_FREE_STAY", "BACKFILL_ORDER", "LOCK_MAINTENANCE"]);

function roomStatusBoardHasSelectionAction(board: RoomStatusBoardDto): boolean {
  return board.rooms.some((room) => [room, ...room.children].some((unit) => unit.allowedActions
    .some((action) => selectionActionCodes.has(action.code) && action.enabled)));
}

interface RoomStatusInteractionSnapshot {
  anchor: HTMLElement;
  selection: RoomStatusSelection | null;
  focusedCell: RoomStatusViewState["focusedCell"];
  windowX: number;
  windowY: number;
  grid: HTMLElement | null;
  gridLeft: number;
  gridTop: number;
}

export interface RoomStatusQuoteTarget {
  unitId: string;
  arrivalDate: string;
  departureDate: string;
  initialStayType: StayType;
  actionCode?: RoomStatusQuoteActionCode;
  backfill?: boolean;
}

export function roomStatusQuoteTargetsEqual(
  left: RoomStatusQuoteTarget | undefined,
  right: RoomStatusQuoteTarget | undefined
): boolean {
  return left?.unitId === right?.unitId
    && left?.arrivalDate === right?.arrivalDate
    && left?.departureDate === right?.departureDate
    && left?.initialStayType === right?.initialStayType
    && left?.actionCode === right?.actionCode
    && Boolean(left?.backfill) === Boolean(right?.backfill);
}

export function roomStatusOwnQuoteRecoveryMatchesTarget(input: {
  recoveryState?: PendingQuoteCommand["state"] | undefined;
  recoveryOwnerId?: string | undefined;
  currentOwnerId?: string | undefined;
  recoveryTarget: RoomStatusQuoteTarget | undefined;
  currentTarget: RoomStatusQuoteTarget | undefined;
}): boolean {
  return Boolean(input.recoveryOwnerId
    && input.recoveryOwnerId === input.currentOwnerId
    && roomStatusQuoteRecoveryMatchesTarget(input.recoveryState, input.recoveryTarget, input.currentTarget));
}

export function roomStatusQuoteRecoveryMatchesTarget(
  recoveryState: PendingQuoteCommand["state"] | undefined,
  recoveryTarget: RoomStatusQuoteTarget | undefined,
  currentTarget: RoomStatusQuoteTarget | undefined
): boolean {
  const normalizedRecoveryTarget = recoveryTarget ? {
    ...recoveryTarget,
    initialStayType: recoveryTarget.initialStayType === "FREE" ? "FREE" as const : "TRANSIENT" as const
  } : undefined;
  const normalizedCurrentTarget = currentTarget ? {
    ...currentTarget,
    initialStayType: currentTarget.initialStayType === "FREE" ? "FREE" as const : "TRANSIENT" as const
  } : undefined;
  return Boolean((recoveryState === "SENDING" || recoveryState === "UNKNOWN")
    && normalizedRecoveryTarget
    && normalizedCurrentTarget
    && roomStatusQuoteTargetsEqual(normalizedRecoveryTarget, normalizedCurrentTarget));
}

export function roomStatusOwnQuoteRecoveryVisible(
  matchesCurrentTarget: boolean,
  recoveryIdentity: string | undefined,
  dismissedIdentity: string | undefined
): boolean {
  return matchesCurrentTarget
    && Boolean(recoveryIdentity)
    && recoveryIdentity !== dismissedIdentity;
}

export function roomStatusRecoveryBlocksNewWrites(
  commandRecoveryBlocked: boolean,
  quoteRecovery: QuoteRecoveryReadResult
): boolean {
  return commandRecoveryBlocked || quoteRecovery.kind !== "ABSENT";
}

export function roomStatusQuoteRecoveryNeedsPagePresentation(input: {
  recovery: QuoteRecoveryReadResult;
  currentOwnerId: string | undefined;
  activeSubmissionIdentity?: string | undefined;
  recoveryTarget: RoomStatusQuoteTarget | undefined;
  currentTarget: RoomStatusQuoteTarget | undefined;
  workbenchOpen: boolean;
}): boolean {
  if (input.recovery.kind === "ABSENT") return false;
  if (input.recovery.kind !== "VALID") return true;
  const activeSubmissionMatches = input.recovery.pending.ownerTabId === input.currentOwnerId
    && input.recovery.pending.metadata.idempotencyKey === input.activeSubmissionIdentity;
  return !(input.workbenchOpen
    && input.recovery.pending.state === "SENDING"
    && (activeSubmissionMatches
      || roomStatusOwnQuoteRecoveryMatchesTarget({
        recoveryState: input.recovery.pending.state,
        recoveryOwnerId: input.recovery.pending.ownerTabId,
        currentOwnerId: input.currentOwnerId,
        recoveryTarget: input.recoveryTarget,
        currentTarget: input.currentTarget
      })));
}

export function recoveredQuoteWaitsForCurrentTarget(
  recoveredQuoteExpired: boolean,
  currentQuoteSignature: string
): boolean {
  return !recoveredQuoteExpired && !currentQuoteSignature;
}

export function roomStatusQuoteRequiresBackfill(arrivalDate: string, businessDate: string): boolean {
  return arrivalDate < businessDate;
}

export function roomStatusQuoteTargetForBusinessDate(
  target: RoomStatusQuoteTarget,
  businessDate: string
): RoomStatusQuoteTarget | undefined {
  if (!target.actionCode) return undefined;
  const historical = roomStatusQuoteRequiresBackfill(target.arrivalDate, businessDate);
  if (target.actionCode === "BACKFILL_ORDER") {
    return historical
      ? { ...target, backfill: true }
      : undefined;
  }
  if (historical) return undefined;
  const { backfill: _staleMode, ...normalTarget } = target;
  return normalTarget;
}

export function roomStatusQuoteActionCodeForUnit(
  action: RoomStatusActionDto,
  unitId: string
): RoomStatusQuoteActionCode | undefined {
  return action.enabled
    && isRoomStatusQuoteActionCode(action.code)
    && action.targetReference?.type === "INVENTORY_UNIT"
    && action.targetReference.id === unitId
    ? action.code
    : undefined;
}

export function roomStatusAuthorizedQuoteAction(
  unit: RoomStatusUnitDto | null,
  target: RoomStatusQuoteTarget | undefined,
  businessDate: string
): RoomStatusActionDto | undefined {
  if (!unit || !target || unit.id !== target.unitId) return undefined;
  const validTarget = roomStatusQuoteTargetForBusinessDate(target, businessDate);
  if (!validTarget?.actionCode) return undefined;
  const selection: RoomStatusSelection = {
    unitId: validTarget.unitId,
    anchorDate: validTarget.arrivalDate,
    focusDate: addLocalDateDays(validTarget.departureDate, -1),
    arrivalDate: validTarget.arrivalDate,
    departureDate: validTarget.departureDate
  };
  const nights = rangeNights(selection);
  if (!isIsoLocalDate(selection.arrivalDate)
    || !isIsoLocalDate(selection.departureDate)
    || nights < 1
    || nights > MAX_STAY_SELECTION_NIGHTS) return undefined;

  return selectionActions(unit, selection, businessDate).find((action) => (
    action.enabled
    && action.code === validTarget.actionCode
    && action.targetReference?.type === "INVENTORY_UNIT"
    && action.targetReference.id === unit.id
  ));
}

export function roomStatusQuoteTargetFromAction(
  action: RoomStatusActionDto,
  unit: RoomStatusUnitDto | null,
  selection: RoomStatusSelection | null,
  businessDate: string
): RoomStatusQuoteTarget | undefined {
  if (!unit || !selection || selection.unitId !== unit.id) return undefined;
  const actionCode = roomStatusQuoteActionCodeForUnit(action, unit.id);
  if (!actionCode) return undefined;
  const candidate: RoomStatusQuoteTarget = {
    unitId: unit.id,
    arrivalDate: selection.arrivalDate,
    departureDate: selection.departureDate,
    initialStayType: actionCode === "CREATE_FREE_STAY" ? "FREE" : "TRANSIENT",
    actionCode,
    ...(actionCode === "BACKFILL_ORDER" ? { backfill: true } : {})
  };
  return roomStatusAuthorizedQuoteAction(unit, candidate, businessDate) ? candidate : undefined;
}

export function updateRoomStatusQuoteTargetSelection(
  current: RoomStatusQuoteTarget | undefined,
  unit: RoomStatusUnitDto | null,
  selection: RoomStatusSelection,
  businessDate: string
): RoomStatusQuoteTarget | undefined {
  if (!current?.actionCode || !unit || unit.id !== selection.unitId) return undefined;
  const candidate = roomStatusQuoteTargetForBusinessDate({
    unitId: selection.unitId,
    arrivalDate: selection.arrivalDate,
    departureDate: selection.departureDate,
    initialStayType: current.initialStayType === "FREE" ? "FREE" : "TRANSIENT",
    actionCode: current.actionCode,
    ...(current.actionCode === "BACKFILL_ORDER" ? { backfill: true } : {})
  }, businessDate);
  return candidate && roomStatusAuthorizedQuoteAction(unit, candidate, businessDate)
    ? candidate
    : undefined;
}

export function roomStatusQuoteCommandMatchesTarget(
  request: CommandRequest,
  target: RoomStatusQuoteTarget | undefined
): boolean {
  if (request.commandType !== "CREATE_ORDER" || !target?.actionCode) return false;
  const input = request.input as Record<string, unknown>;
  const requestIsBackfill = request.presentation === "BACKFILL_STAY" || input.backfill === true;
  return target.actionCode === "BACKFILL_ORDER" ? requestIsBackfill : !requestIsBackfill;
}

type PendingMobileTaskFocus = Omit<RoomStatusMobileFocusRequest, "token">;

type RoomStatusCommandPhase = "IDLE" | "DRAFT" | "PREVIEW" | "CONFIRMING" | "SETTLED";

export function roomStatusProjectionRefreshAllowed(phase: RoomStatusCommandPhase): boolean {
  return phase !== "CONFIRMING";
}

export function roomStatusProjectionRefreshDecision(input: {
  visible: boolean;
  permissionDenied: boolean;
  phase: RoomStatusCommandPhase;
  queryInFlight: boolean;
}): "STOP" | "WAIT" | "REFRESH" {
  if (!input.visible || input.permissionDenied) return "STOP";
  if (!roomStatusProjectionRefreshAllowed(input.phase) || input.queryInFlight) return "WAIT";
  return "REFRESH";
}

export function roomStatusProjectionLocalFreshnessDeadline(
  projection: Pick<RoomStatusBoardDto, "asOf" | "freshUntil">,
  requestStartedAt: number
): number {
  const asOf = Date.parse(projection.asOf);
  const freshUntil = Date.parse(projection.freshUntil);
  const ttl = freshUntil - asOf;
  return Number.isFinite(requestStartedAt) && Number.isFinite(ttl) && ttl > 0
    ? requestStartedAt + ttl
    : Number.NaN;
}

interface RoomStatusFreshnessClockSample {
  monotonic: number;
  wall: number;
}

export function roomStatusConservativeElapsed(
  previous: RoomStatusFreshnessClockSample,
  current: RoomStatusFreshnessClockSample
): number {
  const monotonicElapsed = Number.isFinite(previous.monotonic) && Number.isFinite(current.monotonic)
    ? current.monotonic - previous.monotonic
    : 0;
  const wallElapsed = Number.isFinite(previous.wall) && Number.isFinite(current.wall)
    ? current.wall - previous.wall
    : 0;
  return Math.max(0, monotonicElapsed, wallElapsed);
}

let roomStatusFreshnessClockState: (RoomStatusFreshnessClockSample & { logical: number }) | undefined;

function roomStatusFreshnessNow(): number {
  const wall = Date.now();
  const monotonic = typeof globalThis.performance?.now === "function"
    ? globalThis.performance.now()
    : wall;
  const previous = roomStatusFreshnessClockState;
  if (!previous) {
    roomStatusFreshnessClockState = { monotonic, wall, logical: monotonic };
    return monotonic;
  }
  const logical = previous.logical + roomStatusConservativeElapsed(previous, { monotonic, wall });
  roomStatusFreshnessClockState = { monotonic, wall, logical };
  return logical;
}

function roomStatusFreshnessDeadline(value: string | number): number {
  return typeof value === "number" ? value : Date.parse(value);
}

export function roomStatusRefreshDelay(freshUntil: string | number, now = Date.now()): number {
  const deadline = roomStatusFreshnessDeadline(freshUntil);
  if (!Number.isFinite(deadline)) return 0;
  return Math.max(0, deadline - now - ROOM_STATUS_REFRESH_START_LEAD_MS);
}

export function roomStatusProjectionHasWriteHeadroom(freshUntil: string | number, now = Date.now()): boolean {
  const deadline = roomStatusFreshnessDeadline(freshUntil);
  return Number.isFinite(deadline) && deadline - now > ROOM_STATUS_WRITE_HEADROOM_MS;
}

export function roomStatusProjectionResponseCanEnableWrites(
  freshUntil: string | number,
  now = Date.now(),
  requiredHeadroomMs = ROOM_STATUS_RESPONSE_INSTALL_HEADROOM_MS
): boolean {
  const deadline = roomStatusFreshnessDeadline(freshUntil);
  return Number.isFinite(deadline)
    && Number.isFinite(requiredHeadroomMs)
    && requiredHeadroomMs >= ROOM_STATUS_RESPONSE_INSTALL_HEADROOM_MS
    && deadline - now > requiredHeadroomMs;
}

export function roomStatusStaleResponseRetryDelay(consecutiveLowFreshnessResponses: number): number {
  const exponent = Math.min(3, Math.max(0, Math.trunc(consecutiveLowFreshnessResponses) - 1));
  return Math.min(
    ROOM_STATUS_STALE_RESPONSE_RETRY_MAX_MS,
    ROOM_STATUS_STALE_RESPONSE_RETRY_BASE_MS * (2 ** exponent)
  );
}

export function roomStatusQueryFailureRetryDelay(consecutiveFailures: number): number {
  const exponent = Math.min(3, Math.max(0, Math.trunc(consecutiveFailures) - 1));
  return Math.min(
    ROOM_STATUS_QUERY_FAILURE_RETRY_MAX_MS,
    ROOM_STATUS_QUERY_FAILURE_RETRY_BASE_MS * (2 ** exponent)
  );
}

export function roomStatusLowFreshnessResponseRequiresManualRetry(
  consecutiveLowFreshnessResponses: number
): boolean {
  return consecutiveLowFreshnessResponses >= ROOM_STATUS_LOW_FRESHNESS_RESPONSE_LIMIT;
}

export function roomStatusCommittedRefreshScopeIsCurrent(input: {
  requestActive: boolean;
  requestAborted: boolean;
  capturedPropertyId: string;
  currentPropertyId: string;
  capturedPrincipalScope: string;
  currentPrincipalScope: string;
  capturedOrder?: Pick<RoomStatusOrderIdentity, "orderId" | "stayId">;
  currentOrder?: Pick<RoomStatusOrderIdentity, "orderId" | "stayId">;
}): boolean {
  return input.requestActive
    && !input.requestAborted
    && input.capturedPropertyId === input.currentPropertyId
    && input.capturedPrincipalScope === input.currentPrincipalScope
    && input.capturedOrder?.orderId === input.currentOrder?.orderId
    && input.capturedOrder?.stayId === input.currentOrder?.stayId;
}

export function roomStatusOrderContextNeedsReload(
  previous: Pick<RoomStatusBoardDto, "propertyId" | "revision" | "businessDate" | "accessLevel"> | undefined,
  next: Pick<RoomStatusBoardDto, "propertyId" | "revision" | "businessDate" | "accessLevel">
): boolean {
  return !previous
    || previous.propertyId !== next.propertyId
    || previous.revision !== next.revision
    || previous.businessDate !== next.businessDate
    || previous.accessLevel !== next.accessLevel;
}

export function roomStatusTimelineRangeFromStart(startDate: string): RoomStatusRange {
  return {
    arrivalDate: startDate,
    departureDate: addLocalDateDays(startDate, ROOM_STATUS_TIMELINE_DAYS)
  };
}

export function roomStatusRangeForOrderReturn(
  range: RoomStatusRange,
  triggerDate: string | undefined
): RoomStatusRange {
  if (!triggerDate
    || !isIsoLocalDate(triggerDate)
    || (range.arrivalDate <= triggerDate && triggerDate < range.departureDate)) return range;
  return roomStatusTimelineRangeFromStart(triggerDate);
}

function restoredOrDefaultRoomStatusRange(restored: RoomStatusRestorationSnapshot | undefined, timeZone: string): RoomStatusRange {
  return restored?.range.arrivalDate && isIsoLocalDate(restored.range.arrivalDate)
    ? roomStatusTimelineRangeFromStart(restored.range.arrivalDate)
    : defaultRoomStatusRange(timeZone);
}

function roomStatusQuery(
  range: RoomStatusRange,
  page: number,
  filters: RoomStatusViewState["filters"]
): RoomStatusBoardQueryDto {
  const search = filters.search.trim();
  return {
    arrivalDate: range.arrivalDate,
    departureDate: range.departureDate,
    page,
    pageSize: ROOM_STATUS_PAGE_SIZE,
    ...(search ? { search } : {}),
    ...(filters.roomTypeCode !== "ALL" ? { roomType: filters.roomTypeCode } : {}),
    ...(filters.salesMode !== "ALL" ? { salesMode: filters.salesMode } : {}),
    ...(filters.status !== "ALL" ? { status: filters.status } : {}),
    ...(filters.minimumCapacity !== null ? { minCapacity: filters.minimumCapacity } : {}),
    ...(filters.kind !== "ALL" ? { unitKind: filters.kind } : {})
  };
}

function roomStatusQueryKey(query: RoomStatusBoardQueryDto): string {
  return JSON.stringify([
    query.arrivalDate,
    query.departureDate,
    query.page ?? 0,
    query.pageSize ?? ROOM_STATUS_PAGE_SIZE,
    query.search ?? null,
    query.roomType ?? null,
    query.salesMode ?? null,
    query.status ?? null,
    query.minCapacity ?? null,
    query.unitKind ?? null
  ]);
}

function roomStatusRestorationKey(subjectId: string, propertyId: string): string {
  return `${ROOM_STATUS_RESTORATION_PREFIX}:${encodeURIComponent(subjectId)}:${encodeURIComponent(propertyId)}`;
}

function defaultRoomStatusRange(timeZone: string): RoomStatusRange {
  const today = localDateInTimeZone(timeZone);
  return roomStatusTimelineRangeFromStart(today);
}

function rangeNights(range: RoomStatusRange): number {
  if (!isIsoLocalDate(range.arrivalDate) || !isIsoLocalDate(range.departureDate)) return 0;
  return Math.round((Date.parse(`${range.departureDate}T00:00:00Z`) - Date.parse(`${range.arrivalDate}T00:00:00Z`)) / 86_400_000);
}

function readRoomStatusRestoration(subjectId: string, propertyId: string): RoomStatusRestorationSnapshot | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const serialized = window.sessionStorage.getItem(roomStatusRestorationKey(subjectId, propertyId));
    return serialized ? parseRoomStatusRestoration(serialized, propertyId) : undefined;
  } catch {
    return undefined;
  }
}

function writeRoomStatusRestoration(subjectId: string, snapshot: RoomStatusRestorationSnapshot): boolean {
  try {
    window.sessionStorage.setItem(roomStatusRestorationKey(subjectId, snapshot.propertyId), serializeRoomStatusRestoration(snapshot));
    return true;
  } catch {
    return false;
  }
}

function flattenRoomStatusUnits(board: RoomStatusBoardDto): RoomStatusUnitDto[] {
  return board.rooms.flatMap((room) => [room, ...room.children]);
}

function findRoomStatusUnit(board: RoomStatusBoardDto | undefined, unitId: string | undefined): RoomStatusUnitDto | null {
  if (!board || !unitId) return null;
  return flattenRoomStatusUnits(board).find((unit) => unit.id === unitId) ?? null;
}

function displayRoomStatusBoard(board: RoomStatusBoardDto, commandsBlocked: boolean): RoomStatusBoardDto {
  if (!commandsBlocked) return board;
  return {
    ...board,
    operationalTasks: board.operationalTasks.map((task) => ({
      ...task,
      allowedActions: task.allowedActions.filter((action) => action.code === "OPEN_ORDER")
    }))
  };
}

export interface RoomStatusActionPresentationBlock {
  kind: "REFRESH" | "RECOVERY" | "PERMISSION";
  reason: string;
  actionLabel?: string;
}

export function roomStatusActionPresentationBlock(input: {
  refreshFailed: boolean;
  accessLevel: RoomStatusBoardDto["accessLevel"];
  projectionWritable: boolean;
  projectionExpired: boolean;
  projectionReady: boolean;
  recoveryBlocked: boolean;
  recoveryReady: boolean;
  recoveryError: unknown;
  hasRecoveryEntry: boolean;
  recoveryActionLabel?: string;
}): RoomStatusActionPresentationBlock | undefined {
  if (input.refreshFailed) {
    return {
      kind: "REFRESH",
      reason: "房态刷新失败，当前仍显示上次成功结果。刷新成功前不能发起补录或其他写入。",
      actionLabel: "重试刷新"
    };
  }
  if (input.accessLevel !== "WRITE") {
    return { kind: "PERMISSION", reason: "当前账号只有查看权限，不能补录住宿或执行其他写入。" };
  }
  if (!input.projectionWritable) {
    return {
      kind: "REFRESH",
      reason: input.projectionExpired
        ? "正在更新房态，更新完成前暂不能写入。"
        : input.projectionReady
          ? "正在更新房态，更新完成前暂不能写入。"
          : "房态数据尚未完整载入。请刷新房态；载入完成前不能补录或进行其他操作。",
    };
  }
  if (!input.recoveryReady || input.recoveryError) {
    return {
      kind: "RECOVERY",
      reason: "命令恢复记录暂不可用。确认原操作结果前不能发起新的补录或其他写入。",
      ...(input.hasRecoveryEntry ? { actionLabel: input.recoveryActionLabel ?? "处理恢复记录" } : {})
    };
  }
  if (input.recoveryBlocked) {
    return {
      kind: "RECOVERY",
      reason: "上一笔操作结果尚未收口。请先查询原操作结果；处理完成前不能发起新的补录。",
      ...(input.hasRecoveryEntry ? { actionLabel: input.recoveryActionLabel ?? "查询原操作结果" } : {})
    };
  }
  return undefined;
}

export function roomStatusActionsForPresentation(
  actions: readonly RoomStatusActionDto[],
  block: RoomStatusActionPresentationBlock | undefined
): RoomStatusActionDto[] {
  if (!block) return [...actions];
  return actions.map((action) => action.code === "OPEN_ORDER" || !action.enabled
    ? action
    : { ...action, enabled: false, disabledReason: null });
}

export function roomStatusHistoricalSelectionNeedsRefresh(input: {
  boardExpired: boolean;
  historicalSelectionOpen: boolean;
  queryInFlight: boolean;
}): boolean {
  return input.boardExpired && input.historicalSelectionOpen && !input.queryInFlight;
}

function uniqueConflicts(conflicts: readonly RoomStatusConflictDto[]): RoomStatusConflictDto[] {
  return [...new Map(conflicts.map((conflict) => [conflict.id, conflict])).values()];
}

function selectionDays(unit: RoomStatusUnitDto | null, selection: RoomStatusSelection | null): RoomStatusDayDto[] {
  if (!unit || !selection || unit.id !== selection.unitId) return [];
  return unit.days.filter((day) => day.serviceDate >= selection.arrivalDate && day.serviceDate < selection.departureDate);
}

function selectionLoadedWindowIntersection(
  unit: RoomStatusUnitDto,
  selection: RoomStatusSelection
): RoomStatusDayDto[] | undefined {
  if (unit.days.length === 0) return [];
  const serviceDates = unit.days.map((day) => day.serviceDate).sort();
  const windowArrivalDate = serviceDates[0]!;
  const windowDepartureDate = addLocalDateDays(serviceDates.at(-1)!, 1);
  const arrivalDate = selection.arrivalDate > windowArrivalDate ? selection.arrivalDate : windowArrivalDate;
  const departureDate = selection.departureDate < windowDepartureDate ? selection.departureDate : windowDepartureDate;
  if (arrivalDate >= departureDate) return [];

  const expectedNights = rangeNights({ arrivalDate, departureDate });
  const days = unit.days.filter((day) => day.serviceDate >= arrivalDate && day.serviceDate < departureDate);
  if (days.length !== expectedNights || new Set(days.map((day) => day.serviceDate)).size !== expectedNights) return undefined;
  return days;
}

function selectionDaysEligible(
  days: readonly RoomStatusDayDto[],
  selection: RoomStatusSelection,
  businessDate?: string
): boolean {
  const historical = businessDate !== undefined && selection.arrivalDate < businessDate;
  return historical
    ? days.every((day) => day.conflicts.length === 0
      && day.intervalIds.length === 0
      && (day.serviceDate < businessDate! ? day.status === "AVAILABLE" : day.available))
    : days.every((day) => day.available && day.conflicts.length === 0);
}

export function selectionActions(unit: RoomStatusUnitDto | null, selection: RoomStatusSelection | null, businessDate?: string): RoomStatusActionDto[] {
  const days = selectionDays(unit, selection);
  const nights = selection ? rangeNights(selection) : 0;
  if (!unit || !selection || nights < 1 || nights > MAX_STAY_SELECTION_NIGHTS) return [];
  const completeRangeLoaded = days.length === nights;
  if (!completeRangeLoaded) {
    // The board is a bounded projection, not an availability assertion for
    // dates outside it. The Quote API validates the complete requested range.
    const loadedDays = selectionLoadedWindowIntersection(unit, selection);
    if (!loadedDays || !selectionDaysEligible(loadedDays, selection, businessDate)) return [];
  } else if (!selectionDaysEligible(days, selection, businessDate)) {
    return [];
  }
  const historical = businessDate !== undefined && selection.arrivalDate < businessDate;
  return unit.allowedActions.filter((candidate) => selectionActionCodes.has(candidate.code)
    && (completeRangeLoaded || isRoomStatusQuoteActionCode(candidate.code))
    && (historical ? candidate.code === "BACKFILL_ORDER" : candidate.code !== "BACKFILL_ORDER")) ?? [];
}

export function dayActions(unit: RoomStatusUnitDto | null, day: RoomStatusDayDto | null, businessDate?: string): RoomStatusActionDto[] {
  if (!unit || !day) return [];
  const historical = businessDate !== undefined && day.serviceDate < businessDate;
  const historicalBlank = historical && day.status === "AVAILABLE" && day.intervalIds.length === 0 && day.conflicts.length === 0;
  const canCreateFromDay = (historicalBlank || (!historical && day.available)) && day.conflicts.length === 0;
  const create = canCreateFromDay
    ? unit.allowedActions.filter((candidate) => selectionActionCodes.has(candidate.code)
      && (historical ? candidate.code === "BACKFILL_ORDER" : candidate.code !== "BACKFILL_ORDER"))
    : [];
  const sourceActions = unit.intervals
    .filter((interval) => day.intervalIds.includes(interval.id))
    .flatMap((interval) => interval.allowedActions);
  return [...new Map([...create, ...sourceActions].map((candidate) => [
    `${candidate.code}:${candidate.targetReference?.type ?? "none"}:${candidate.targetReference?.id ?? "none"}`,
    candidate
  ])).values()];
}

function intervalActions(interval: RoomStatusIntervalDto | null, selection: RoomStatusSelection | null): RoomStatusActionDto[] {
  if (!interval) return [];
  const fullIntervalSelected = Boolean(selection
    && selection.unitId === interval.displayInventoryUnitId
    && selection.arrivalDate === interval.sourceStartDate
    && selection.departureDate === interval.sourceEndDate);
  return interval.allowedActions.map((action) => action.requiresFullInterval
    && action.code !== "RELEASE_MAINTENANCE"
    && !fullIntervalSelected
    ? {
        ...action,
        enabled: false,
        disabledReason: action.disabledReason ?? `当前选区必须精确匹配来源完整区间 [${interval.sourceStartDate}, ${interval.sourceEndDate})`
      }
    : action);
}

function actionUnit(unit: RoomStatusUnitDto, available: boolean): InventoryActionUnit {
  return {
    id: unit.id,
    kind: unit.kind,
    code: unit.code,
    name: unit.name,
    buildingCode: unit.buildingCode,
    occupancyCapacity: unit.occupancyCapacity,
    available
  };
}

export function selectedOrderCommandScopeIsCurrent(
  selectedScope: string | undefined,
  principalScope: string,
  identity?: Pick<RoomStatusOrderIdentity, "orderId" | "stayId">
): boolean {
  if (!selectedScope) return false;
  return selectedScope === principalScope
    || selectedScope === roomStatusOrderCommandScope(principalScope, identity);
}

export function roomStatusOrderCommandScope(
  principalScope: string,
  identity?: Pick<RoomStatusOrderIdentity, "orderId" | "stayId">
): string {
  return identity
    ? JSON.stringify([principalScope, identity.orderId, identity.stayId])
    : principalScope;
}

export function selectedOrderMemberLookup(
  view: Pick<OrderViewDto, "order" | "stay">,
  propertyId: string,
  stayId: string
): { memberId: string; scope: string } | undefined {
  const memberId = view.order.member_id;
  if (!memberId || view.order.property_id !== propertyId || view.stay.id !== stayId) return undefined;
  return {
    memberId,
    scope: `${propertyId}:${view.order.id}:${view.stay.id}:${memberId}`
  };
}

export function selectedStayDateRequestIsCompatible(
  openedAction: StayDateChangeAction,
  mode: StayDateChangeMode,
  requestCommandType: CommandRequest["commandType"]
): boolean {
  return mode === "ADJUST_DEPARTURE"
    ? requestCommandType === "EXTEND_STAY" || requestCommandType === "SHORTEN_STAY"
    : requestCommandType === openedAction;
}

export function roomStatusCommandWriteGate(input: {
  projectionWritable: boolean;
  activeProjectionValid: boolean;
  recoveryBlocked: boolean;
  recoveryReady: boolean;
  recoveryError: unknown;
  contextInvalidated: boolean;
  targetScopeCurrent: boolean;
}): { startBlocked: boolean; activeBlocked: boolean } {
  return {
    startBlocked: input.recoveryBlocked || !input.projectionWritable,
    activeBlocked: !input.activeProjectionValid
      || !input.recoveryReady
      || Boolean(input.recoveryError)
      || input.contextInvalidated
      || !input.targetScopeCurrent
  };
}

export function roomStatusProjectionWritable(input: {
  projectionReady: boolean;
  projectionExpired: boolean;
  boardAccess: string | undefined;
  principalAccess: string | undefined;
}): boolean {
  return input.projectionReady
    && !input.projectionExpired
    && input.boardAccess === "WRITE"
    && input.principalAccess === "WRITE";
}

function buildMobileGroups(board: RoomStatusBoardDto): RoomStatusMobileGroups {
  const tasks = board.operationalTasks.filter((task) => task.businessDate === board.businessDate);
  return {
    arrivals: tasks.filter((task) => task.taskKind === "ARRIVAL"),
    inHouse: tasks.filter((task) => task.taskKind === "IN_HOUSE"),
    departures: tasks.filter((task) => task.taskKind === "DEPARTURE"),
    exceptions: tasks.filter((task) => task.taskKind === "EXCEPTION")
  };
}

export function InventoryPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const isMobile = useRoomStatusMobileViewport();
  const { meta, principal, propertyId } = useWorkspace();
  const property = meta.properties.find((item) => item.id === propertyId);
  const initialMemberId = memberStayIntent(location.search, propertyId);
  const requestedMemberLookup = useMemberChoices(propertyId, "", initialMemberId ?? "", Boolean(initialMemberId), true);
  const requestedMember = requestedMemberLookup.members.find((member) => member.id === initialMemberId);
  const requestedMemberHasContract = Boolean(requestedMember);
  const propertyTimezone = property?.timezone ?? "UTC";
  const principalPropertyAccess = principal.propertyAccess[propertyId];
  const currentPropertyAllowedActions = useMemo(() => propertyAllowedActions(principal, propertyId), [principal, propertyId]);
  const orderPrincipalScope = `${propertyId}:${principal.subjectId}:${principal.credentialType}:${principalPropertyAccess ?? "NONE"}:${[...currentPropertyAllowedActions].join("|")}`;
  const currentPropertyIdRef = useRef(propertyId);
  currentPropertyIdRef.current = propertyId;
  const currentOrderPrincipalScopeRef = useRef(orderPrincipalScope);
  currentOrderPrincipalScopeRef.current = orderPrincipalScope;
  const initialRestoration = useRef(readRoomStatusRestoration(principal.subjectId, propertyId));
  const orderReturnEnvelopePresent = useRef(hasRoomStatusOrderReturnEnvelope(location.state));
  const pendingOrderReturnTarget = useRef(parseRoomStatusOrderReturnTarget(location.state));
  const [range, setRange] = useState<RoomStatusRange>(() => roomStatusRangeForOrderReturn(
    restoredOrDefaultRoomStatusRange(initialRestoration.current, propertyTimezone),
    pendingOrderReturnTarget.current?.propertyId === propertyId
      ? pendingOrderReturnTarget.current.triggerDate
      : undefined
  ));
  const [viewState, dispatchView] = useReducer(
    roomStatusViewReducer,
    initialRestoration.current?.state ?? createRoomStatusViewState()
  );
  const pageQuoteRecoveryScope = quoteRecoveryStorageKey(principal.subjectId, propertyId);
  const [, setPageQuoteRecoveryRevision] = useState(0);
  useEffect(() => {
    const access = browserCommandRecoveryStorage();
    if (access.kind !== "AVAILABLE") return;
    const handleStorage = (event: StorageEvent) => {
      if (!recoveryStorageEventMatchesScope(event, pageQuoteRecoveryScope, access.authoritativeStorage)) return;
      setPageQuoteRecoveryRevision((revision) => revision + 1);
    };
    const handleSync = (event: Event) => {
      if (!recoveryStorageSyncEventMatchesScope(event as CustomEvent<unknown>, pageQuoteRecoveryScope)) return;
      setPageQuoteRecoveryRevision((revision) => revision + 1);
    };
    window.addEventListener("storage", handleStorage);
    window.addEventListener(RECOVERY_STORAGE_SYNC_EVENT, handleSync);
    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener(RECOVERY_STORAGE_SYNC_EVENT, handleSync);
    };
  }, [pageQuoteRecoveryScope]);
  const pageQuoteRecovery = browserQuoteRecovery(principal.subjectId, propertyId).read;
  const currentQuoteRecoveryIdentity = quoteRecoveryContextIdentity(pageQuoteRecoveryScope, pageQuoteRecovery);
  const currentQuoteRecoveryOwnerId = pageQuoteRecovery.kind === "VALID" ? pageQuoteRecovery.pending.ownerTabId : undefined;
  const currentBrowserQuoteRecoveryOwnerId = browserQuoteRecoveryOwnerId();
  const commandRecovery = usePersistentCommandRecovery({
    subjectId: principal.subjectId,
    scopeId: `property:${propertyId}`
  });
  const recoveryPendingAllowed = commandRecoveryAvailable(principal, propertyId, commandRecovery.pending?.commandType);
  const [board, setBoard] = useState<RoomStatusBoardDto>();
  const [boardFreshnessDeadline, setBoardFreshnessDeadline] = useState<number>();
  const [boardWriteAdmitted, setBoardWriteAdmitted] = useState(false);
  const boardRef = useRef<RoomStatusBoardDto | undefined>(undefined);
  const [boardQueryKey, setBoardQueryKey] = useState<string>();
  const boardQueryKeyRef = useRef<string | undefined>(undefined);
  const queryAttemptGuardRef = useRef<RoomStatusQueryAttemptGuard | null>(null);
  if (!queryAttemptGuardRef.current) queryAttemptGuardRef.current = new RoomStatusQueryAttemptGuard();
  const queryAttemptGuard = queryAttemptGuardRef.current;
  useEffect(() => () => queryAttemptGuard.invalidateActive(), [queryAttemptGuard]);
  const lowFreshnessResponseCountRef = useRef(0);
  const lowFreshnessQueryKeyRef = useRef<string | undefined>(undefined);
  const continuityLostQueryKeyRef = useRef<string | undefined>(undefined);
  const refreshReturnFocusRef = useRef<HTMLElement | undefined>(undefined);
  const rememberRefreshReturnFocus = useCallback((candidate: EventTarget | null) => {
    if (!(candidate instanceof HTMLElement)
      || !candidate.isConnected
      || candidate.closest(".room-status-stale-notice")) return;
    refreshReturnFocusRef.current = candidate;
  }, []);
  const restoreRefreshReturnFocus = useCallback(() => {
    const target = refreshReturnFocusRef.current;
    refreshReturnFocusRef.current = undefined;
    if (!target) return;
    window.requestAnimationFrame(() => {
      if (target.isConnected && !target.hasAttribute("disabled")) target.focus({ preventScroll: true });
    });
  }, []);
  const permissionDeniedRef = useRef(false);
  const pendingRestoration = useRef<RoomStatusRestorationSnapshot | undefined>(initialRestoration.current);
  const orderRestorationAttempted = useRef(false);
  const orderReturnResolutionStarted = useRef(false);
  const restorationPagesVisited = useRef(new Set<number>());
  const previousPropertyId = useRef(propertyId);
  const previousSubjectId = useRef(principal.subjectId);
  const [initializedPropertyId, setInitializedPropertyId] = useState(propertyId);
  const [queryPhase, setQueryPhase] = useState<"LOADING" | "RANGE_LOADING" | "READY" | "REFRESHING" | "ERROR" | "PERMISSION_DENIED">("LOADING");
  const [rangeLoadingNoticeReady, setRangeLoadingNoticeReady] = useState(false);
  const [queryError, setQueryError] = useState<unknown>();
  const [rangeError, setRangeError] = useState<unknown>();
  const [restorationError, setRestorationError] = useState<unknown>();
  const [restoreGridFocus, setRestoreGridFocus] = useState(Boolean(initialRestoration.current));
  const [returnNotice, setReturnNotice] = useState<string>();
  const [actionError, setActionError] = useState<unknown>();
  const [quoteRecoveryOutcome, setQuoteRecoveryOutcome] = useState<Error>();
  const [clock, setClock] = useState(roomStatusFreshnessNow);
  const [refreshToken, setRefreshToken] = useState(0);
  const requestRoomStatusRefresh = useCallback(() => {
    if (queryAttemptGuard.isInFlight()) return;
    setRefreshToken((value) => value + 1);
  }, [queryAttemptGuard]);
  const [querySettledToken, setQuerySettledToken] = useState(0);
  const [quoteResetToken, setQuoteResetToken] = useState(0);
  const [selectionDraftValid, setSelectionDraftValid] = useState(true);
  const [command, setCommand] = useState<CommandRequest>();
  const [commandDraft, setCommandDraft] = useState<CommandRequest>();
  const [commandAttemptId, setCommandAttemptId] = useState(0);
  const [recoveryDialogOpen, setRecoveryDialogOpen] = useState(false);
  const [quoteRecoveryContextOpen, setQuoteRecoveryContextOpen] = useState(false);
  const [activeQuoteSubmissionIdentity, setActiveQuoteSubmissionIdentity] = useState<string>();
  const activeQuoteSubmissionIdentityRef = useRef<string | undefined>(undefined);
  const deferredMaintenanceIntentRef = useRef<{
    submissionIdentity: string;
    unit: InventoryActionUnit;
    selection: RoomStatusSelection;
  } | undefined>(undefined);
  const [dismissedQuoteRecoveryIdentity, setDismissedQuoteRecoveryIdentity] = useState<string>();
  const [autoOpenedQuoteRecoveryIdentity, setAutoOpenedQuoteRecoveryIdentity] = useState<string>();
  const autoResolvedQuoteRecoveryIdentities = useRef(browserAutoResolvedQuoteRecoveryIdentities);
  const [recoveryError, setRecoveryError] = useState<unknown>();
  const [commandNotice, setCommandNotice] = useState<string>();
  const [selectedUnitId, setSelectedUnitId] = useState<string>();
  const [selectedDayDate, setSelectedDayDate] = useState<string>();
  const [selectedIntervalId, setSelectedIntervalId] = useState<string>();
  const [selectedGridStayId, setSelectedGridStayId] = useState<string>();
  const [selectedOrderIdentity, setSelectedOrderIdentity] = useState<RoomStatusOrderIdentity>();
  const currentSelectedOrderIdentityRef = useRef(selectedOrderIdentity);
  currentSelectedOrderIdentityRef.current = selectedOrderIdentity;
  const [selectedOrderView, setSelectedOrderView] = useState<OrderViewDto>();
  const [selectedMemberView, setSelectedMemberView] = useState<MemberViewDto>();
  const [selectedOrderLoadedScope, setSelectedOrderLoadedScope] = useState<string>();
  const [selectedOrderLoading, setSelectedOrderLoading] = useState(false);
  const [selectedOrderError, setSelectedOrderError] = useState<unknown>();
  const [selectedCorrectionOccupantId, setSelectedCorrectionOccupantId] = useState<string>();
  const [selectedCorrectionRevision, setSelectedCorrectionRevision] = useState<string>();
  const [selectedStayDateAction, setSelectedStayDateAction] = useState<StayDateChangeAction>();
  const [selectedStayDateMode, setSelectedStayDateMode] = useState<StayDateChangeMode>("DATE_CHANGE");
  const [selectedStayDateRevision, setSelectedStayDateRevision] = useState<string>();
  const [selectedMoveUnitOpen, setSelectedMoveUnitOpen] = useState(false);
  const [selectedMoveUnitRevision, setSelectedMoveUnitRevision] = useState<string>();
  const [selectedLifecycleAction, setSelectedLifecycleAction] = useState<OrderLifecycleAction>();
  const [selectedLifecycleRevision, setSelectedLifecycleRevision] = useState<string>();
  const [orderContextOpen, setOrderContextOpen] = useState(false);
  const [pendingOrderContextIdentity, setPendingOrderContextIdentity] = useState<string>();
  const [desktopContextCollapsed, setDesktopContextCollapsed] = useState(true);
  const effectiveDismissedQuoteRecoveryIdentity = currentQuoteRecoveryIdentity
    && browserDismissedQuoteRecoveryIdentities.has(currentQuoteRecoveryIdentity)
    ? currentQuoteRecoveryIdentity
    : dismissedQuoteRecoveryIdentity;
  const effectiveAutoOpenedQuoteRecoveryIdentity = currentQuoteRecoveryIdentity
    && browserAutoOpenedQuoteRecoveryIdentities.has(currentQuoteRecoveryIdentity)
    ? currentQuoteRecoveryIdentity
    : autoOpenedQuoteRecoveryIdentity;
  useLayoutEffect(() => {
    if (queryPhase === "PERMISSION_DENIED") {
      if (quoteRecoveryContextOpen) setQuoteRecoveryContextOpen(false);
      if (!isMobile) setDesktopContextCollapsed(true);
      return;
    }
    if (!currentQuoteRecoveryIdentity) {
      return;
    }
    if (shouldAutoOpenQuoteRecoveryContext({
      recoveryIdentity: currentQuoteRecoveryIdentity,
      dismissedIdentity: effectiveDismissedQuoteRecoveryIdentity,
      autoOpenedIdentity: effectiveAutoOpenedQuoteRecoveryIdentity,
      recoveryOwnerId: currentQuoteRecoveryOwnerId,
      currentOwnerId: currentBrowserQuoteRecoveryOwnerId,
      isMobile,
      hasSelectedOrder: roomStatusOrderContextVisible(selectedOrderIdentity, orderContextOpen)
    })) {
      browserAutoOpenedQuoteRecoveryIdentities.add(currentQuoteRecoveryIdentity);
      setAutoOpenedQuoteRecoveryIdentity(currentQuoteRecoveryIdentity);
      setQuoteRecoveryContextOpen(true);
      setDesktopContextCollapsed(false);
    }
  }, [currentBrowserQuoteRecoveryOwnerId, currentQuoteRecoveryIdentity, currentQuoteRecoveryOwnerId, effectiveAutoOpenedQuoteRecoveryIdentity, effectiveDismissedQuoteRecoveryIdentity, isMobile, orderContextOpen, queryPhase, quoteRecoveryContextOpen, selectedOrderIdentity]);
  const [quickPopoverTarget, setQuickPopoverTarget] = useState<{
    unitId: string;
    serviceDate: string;
    anchor: HTMLElement;
    intervalId?: string;
    selection?: RoomStatusSelection;
  }>();
  const [orderRefreshToken, setOrderRefreshToken] = useState(0);
  const [selectedOrderCommandScope, setSelectedOrderCommandScope] = useState<string>();
  const [workspaceWidth, setWorkspaceWidth] = useState(0);
  const [maintenanceTarget, setMaintenanceTarget] = useState<InventoryActionUnit>();
  const [quoteTarget, setQuoteTarget] = useState<RoomStatusQuoteTarget>();
  const [mobileTab, setMobileTab] = useState<RoomStatusMobileTab>("ARRIVALS");
  const [createSelectionOpen, setCreateSelectionOpen] = useState(false);
  const [mobileFocusRequest, setMobileFocusRequest] = useState<RoomStatusMobileFocusRequest>();
  const [commandContextInvalidated, setCommandContextInvalidated] = useState(false);
  const [focusRequestToken, setFocusRequestToken] = useState(0);
  const [todayResetToken, setTodayResetToken] = useState(0);
  const [filterFocusRequestToken, setFilterFocusRequestToken] = useState(0);
  const quoteSectionRef = useRef<HTMLDivElement>(null);
  const quoteSectionScrollPendingRef = useRef(false);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const boardColumnRef = useRef<HTMLDivElement>(null);
  const roomStatusInteractionSnapshotRef = useRef<RoomStatusInteractionSnapshot | undefined>(undefined);
  const commandPhaseRef = useRef<RoomStatusCommandPhase>("IDLE");
  const [commandPhaseScheduleToken, setCommandPhaseScheduleToken] = useState(0);
  const setCommandPhase = useCallback((nextPhase: RoomStatusCommandPhase) => {
    if (commandPhaseRef.current === nextPhase) return;
    commandPhaseRef.current = nextPhase;
    setCommandPhaseScheduleToken((value) => value + 1);
  }, []);
  const lowFreshnessRetryTimerRef = useRef<number | undefined>(undefined);
  const clearLowFreshnessRetry = useCallback(() => {
    if (lowFreshnessRetryTimerRef.current === undefined) return;
    window.clearTimeout(lowFreshnessRetryTimerRef.current);
    lowFreshnessRetryTimerRef.current = undefined;
  }, []);
  const scheduleLowFreshnessRetry = useCallback((delay: number) => {
    if (lowFreshnessRetryTimerRef.current !== undefined) return;
    const retryWhenSafe = () => {
      lowFreshnessRetryTimerRef.current = undefined;
      if (lowFreshnessResponseCountRef.current === 0) return;
      const decision = roomStatusProjectionRefreshDecision({
        visible: document.visibilityState === "visible",
        permissionDenied: permissionDeniedRef.current,
        phase: commandPhaseRef.current,
        queryInFlight: queryAttemptGuard.isInFlight()
      });
      if (decision === "STOP") return;
      if (decision === "WAIT") {
        lowFreshnessRetryTimerRef.current = window.setTimeout(
          retryWhenSafe,
          ROOM_STATUS_REFRESH_RETRY_MS
        );
        return;
      }
      setRefreshToken((value) => value + 1);
    };
    lowFreshnessRetryTimerRef.current = window.setTimeout(retryWhenSafe, delay);
  }, [queryAttemptGuard]);
  const queryFailureRetryTimerRef = useRef<number | undefined>(undefined);
  const queryFailureRetryAttemptRef = useRef(0);
  const clearQueryFailureRetry = useCallback(() => {
    if (queryFailureRetryTimerRef.current === undefined) return;
    window.clearTimeout(queryFailureRetryTimerRef.current);
    queryFailureRetryTimerRef.current = undefined;
  }, []);
  const resetQueryFailureRetry = useCallback(() => {
    clearQueryFailureRetry();
    queryFailureRetryAttemptRef.current = 0;
  }, [clearQueryFailureRetry]);
  const scheduleQueryFailureRetry = useCallback((delay: number) => {
    if (queryFailureRetryTimerRef.current !== undefined) return;
    const retryWhenSafe = () => {
      queryFailureRetryTimerRef.current = undefined;
      if (permissionDeniedRef.current) return;
      const decision = roomStatusProjectionRefreshDecision({
        visible: document.visibilityState === "visible",
        permissionDenied: permissionDeniedRef.current,
        phase: commandPhaseRef.current,
        queryInFlight: queryAttemptGuard.isInFlight()
      });
      if (decision === "STOP") return;
      if (decision === "WAIT") {
        queryFailureRetryTimerRef.current = window.setTimeout(retryWhenSafe, ROOM_STATUS_REFRESH_RETRY_MS);
        return;
      }
      setRefreshToken((value) => value + 1);
    };
    queryFailureRetryTimerRef.current = window.setTimeout(retryWhenSafe, delay);
  }, [queryAttemptGuard]);
  const commandAttemptGuardRef = useRef<RoomStatusCommandAttemptGuard | null>(null);
  if (!commandAttemptGuardRef.current) commandAttemptGuardRef.current = new RoomStatusCommandAttemptGuard();
  const commandAttemptGuard = commandAttemptGuardRef.current;
  const selectedMemberRequestGuardRef = useRef<SelectedMemberViewRequestGuard | null>(null);
  if (!selectedMemberRequestGuardRef.current) selectedMemberRequestGuardRef.current = new SelectedMemberViewRequestGuard();
  const selectedMemberRequestGuard = selectedMemberRequestGuardRef.current;
  const commandRevisionRef = useRef<string | undefined>(undefined);
  const commandQueryKeyRef = useRef<string | undefined>(undefined);
  const refreshedReceiptIdRef = useRef<string | undefined>(undefined);
  const historicalRefreshRequestRef = useRef<string | undefined>(undefined);
  const focusAfterNextBoard = useRef(false);
  const returnedOrderCellFocus = useRef<{ unitId: string; serviceDate: string } | undefined>(undefined);
  const pendingMobileTaskFocus = useRef<PendingMobileTaskFocus | undefined>(undefined);
  const mobileFocusSequence = useRef(0);
  const latestRestoration = useRef<{
    subjectId: string;
    snapshot: RoomStatusRestorationSnapshot;
  } | undefined>(undefined);
  const currentSelectedOrderCommandScope = roomStatusOrderCommandScope(orderPrincipalScope, selectedOrderIdentity);

  function cancelQuoteSectionScroll(): void {
    quoteSectionScrollPendingRef.current = false;
  }

  function scheduleQuoteSectionScroll(): void {
    quoteSectionScrollPendingRef.current = true;
  }

  function trackQuoteSubmissionActivity(idempotencyKey: string, active: boolean): void {
    if (active) activeQuoteSubmissionIdentityRef.current = idempotencyKey;
    else if (activeQuoteSubmissionIdentityRef.current === idempotencyKey) {
      activeQuoteSubmissionIdentityRef.current = undefined;
    }
    setActiveQuoteSubmissionIdentity((current) => active
      ? idempotencyKey
      : current === idempotencyKey ? undefined : current);
  }

  useEffect(() => () => cancelQuoteSectionScroll(), []);
  useEffect(() => () => {
    clearLowFreshnessRetry();
    clearQueryFailureRetry();
  }, [clearLowFreshnessRetry, clearQueryFailureRetry]);

  useLayoutEffect(() => {
    if (!quoteSectionScrollPendingRef.current) return;
    const quoteSection = quoteSectionRef.current;
    if (!quoteSection) return;
    quoteSectionScrollPendingRef.current = false;
    quoteSection.scrollIntoView({ block: "start", behavior: "auto" });
  });

  useEffect(() => {
    boardRef.current = board;
  }, [board]);

  useEffect(() => {
    const element = workspaceRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setWorkspaceWidth(entry?.contentRect.width ?? 0));
    observer.observe(element);
    setWorkspaceWidth(element.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, [boardQueryKey]);

  useEffect(() => {
    if (!selectedOrderIdentity) {
      setSelectedOrderView(undefined);
      setSelectedOrderLoadedScope(undefined);
      setSelectedOrderError(undefined);
      setSelectedOrderLoading(false);
      return;
    }
    let current = true;
    const controller = new AbortController();
    setSelectedOrderLoading(true);
    setSelectedOrderError(undefined);
    api.order(selectedOrderIdentity.orderId, controller.signal)
      .then((response) => {
        if (!current) return;
        if (response.order.property_id !== propertyId || response.stay.id !== selectedOrderIdentity.stayId) {
          throw new Error("订单详情与当前房态的住宿记录不一致，已停止显示");
        }
        assertOrderViewAllowedActions(response, currentPropertyAllowedActions);
        setSelectedOrderView(response);
        setSelectedOrderLoadedScope(orderPrincipalScope);
      })
      .catch((nextError) => {
        if (!current) return;
        if (nextError instanceof DOMException && nextError.name === "AbortError") return;
        setSelectedOrderView(undefined);
        setSelectedOrderError(nextError);
      })
      .finally(() => current && setSelectedOrderLoading(false));
    return () => {
      current = false;
      controller.abort();
    };
  }, [board?.businessDate, board?.revision, orderPrincipalScope, orderRefreshToken, propertyId, selectedOrderIdentity]);

  useEffect(() => {
    const memberLookup = selectedOrderIdentity
      && selectedOrderView
      && selectedOrderLoadedScope === orderPrincipalScope
      ? selectedOrderMemberLookup(selectedOrderView, propertyId, selectedOrderIdentity.stayId)
      : undefined;
    if (!memberLookup) {
      selectedMemberRequestGuard.invalidate();
      setSelectedMemberView(undefined);
      return;
    }

    const lease = selectedMemberRequestGuard.begin(memberLookup.scope);
    setSelectedMemberView(undefined);
    api.member(memberLookup.memberId, propertyId)
      .then((response) => {
        selectedMemberRequestGuard.runIfActive(lease, () => {
          if (response.member.id !== memberLookup.memberId) {
            setSelectedMemberView(undefined);
            return;
          }
          setSelectedMemberView(response);
        });
      })
      .catch(() => {
        selectedMemberRequestGuard.runIfActive(lease, () => setSelectedMemberView(undefined));
      });
    return () => selectedMemberRequestGuard.invalidate();
  }, [orderPrincipalScope, propertyId, selectedMemberRequestGuard, selectedOrderIdentity, selectedOrderLoadedScope, selectedOrderView]);

  useEffect(() => {
    setSelectedStayDateAction(undefined);
    setSelectedStayDateMode("DATE_CHANGE");
    setSelectedStayDateRevision(undefined);
    setSelectedMoveUnitOpen(false);
    setSelectedMoveUnitRevision(undefined);
    setSelectedLifecycleAction(undefined);
    setSelectedLifecycleRevision(undefined);
    setCommandDraft((current) => current?.presentation === "STAY_DATES"
      || current?.presentation === "MOVE_UNIT"
      || current?.presentation === "ORDER_LIFECYCLE" ? undefined : current);
  }, [selectedOrderIdentity?.orderId, selectedOrderIdentity?.stayId]);

  useEffect(() => {
    if (!command || selectedOrderCommandScopeIsCurrent(selectedOrderCommandScope, orderPrincipalScope, selectedOrderIdentity)) return;
    commandAttemptGuard.invalidate();
    setCommandPhase("IDLE");
    commandRevisionRef.current = undefined;
    commandQueryKeyRef.current = undefined;
    setCommand(undefined);
    setCommandDraft(undefined);
    setSelectedOrderCommandScope(undefined);
    setSelectedCorrectionOccupantId(undefined);
    setRecoveryDialogOpen(false);
    setActionError(new Error("当前命令绑定的门店、账号、订单或住宿已经变化，原操作已关闭；请重新选择后办理。"));
  }, [command, currentSelectedOrderCommandScope, selectedOrderCommandScope]);

  useEffect(() => {
    if (!selectedCorrectionOccupantId || !selectedCorrectionRevision || !board) return;
    if (board.revision === selectedCorrectionRevision) return;
    setSelectedCorrectionOccupantId(undefined);
    setSelectedCorrectionRevision(undefined);
    setActionError(new Error("订单资料已被其他操作刷新。为避免覆盖新值，原更正表单已关闭；请重新打开后核对。"));
  }, [board?.revision, selectedCorrectionOccupantId, selectedCorrectionRevision]);

  useEffect(() => {
    if (!selectedStayDateAction || !selectedStayDateRevision || !board) return;
    if (board.revision === selectedStayDateRevision) return;
    setSelectedStayDateAction(undefined);
    setSelectedStayDateMode("DATE_CHANGE");
    setSelectedStayDateRevision(undefined);
    setCommandDraft(undefined);
    setActionError(new Error("订单日期或房态已经变化。为避免使用旧数据，原日期表单已关闭；请重新打开后核对。"));
  }, [board?.revision, selectedStayDateAction, selectedStayDateRevision]);

  useEffect(() => {
    if (!selectedMoveUnitOpen || !selectedMoveUnitRevision || !board) return;
    if (board.revision === selectedMoveUnitRevision) return;
    setSelectedMoveUnitOpen(false);
    setSelectedMoveUnitRevision(undefined);
    setCommandDraft(undefined);
    setActionError(new Error("订单或房态已经变化。为避免使用旧数据，原换房表单已关闭；请重新打开后核对。"));
  }, [board?.revision, selectedMoveUnitOpen, selectedMoveUnitRevision]);

  useEffect(() => {
    if (!selectedLifecycleAction || !selectedLifecycleRevision || !board) return;
    if (board.revision === selectedLifecycleRevision) return;
    setSelectedLifecycleAction(undefined);
    setSelectedLifecycleRevision(undefined);
    setCommandDraft(undefined);
    setActionError(new Error("订单或房态已经变化。为避免处理错误订单，原操作表单已关闭；请重新选择后核对。"));
  }, [board?.revision, selectedLifecycleAction, selectedLifecycleRevision]);

  const boardMatchesCurrentProperty = Boolean(board && board.propertyId === propertyId);
  const currentBoardQueryKey = roomStatusQueryKey(roomStatusQuery(range, viewState.roomPageIndex, viewState.filters));
  const boardMatchesCurrentQuery = Boolean(board
    && board.propertyId === propertyId
    && boardQueryKey === currentBoardQueryKey);

  useEffect(() => {
    if (!board || !boardMatchesCurrentQuery || boardFreshnessDeadline === undefined) return;
    const delay = Number.isFinite(boardFreshnessDeadline)
      ? Math.max(0, boardFreshnessDeadline - roomStatusFreshnessNow() - ROOM_STATUS_WRITE_HEADROOM_MS)
      : 0;
    const timer = window.setTimeout(() => setClock(roomStatusFreshnessNow()), delay);
    return () => window.clearTimeout(timer);
  }, [board, boardFreshnessDeadline, boardMatchesCurrentQuery]);

  useEffect(() => {
    if (!board || !boardMatchesCurrentQuery || boardFreshnessDeadline === undefined
      || !boardWriteAdmitted || queryError || permissionDeniedRef.current) return;
    let timer = 0;
    const refreshWhenAllowed = () => {
      setClock(roomStatusFreshnessNow());
      const decision = roomStatusProjectionRefreshDecision({
        visible: document.visibilityState === "visible",
        permissionDenied: permissionDeniedRef.current,
        phase: commandPhaseRef.current,
        queryInFlight: queryAttemptGuard.isInFlight()
      });
      if (decision === "STOP") return;
      if (decision === "WAIT") {
        timer = window.setTimeout(refreshWhenAllowed, ROOM_STATUS_REFRESH_RETRY_MS);
        return;
      }
      setRefreshToken((value) => value + 1);
    };
    timer = window.setTimeout(
      refreshWhenAllowed,
      roomStatusRefreshDelay(boardFreshnessDeadline, roomStatusFreshnessNow())
    );
    return () => window.clearTimeout(timer);
  }, [board, boardFreshnessDeadline, boardWriteAdmitted, boardMatchesCurrentQuery, commandPhaseScheduleToken, propertyId, queryError, queryAttemptGuard]);

  useEffect(() => {
    const refreshVisible = () => {
      if (document.visibilityState !== "visible") return;
      setClock(roomStatusFreshnessNow());
      if (roomStatusProjectionRefreshDecision({
        visible: true,
        permissionDenied: permissionDeniedRef.current,
        phase: commandPhaseRef.current,
        queryInFlight: queryAttemptGuard.isInFlight()
      }) === "REFRESH") {
        setRefreshToken((value) => value + 1);
      }
    };
    document.addEventListener("visibilitychange", refreshVisible);
    window.addEventListener("focus", refreshVisible);
    return () => {
      document.removeEventListener("visibilitychange", refreshVisible);
      window.removeEventListener("focus", refreshVisible);
    };
  }, [propertyId, queryAttemptGuard]);

  useEffect(() => {
    if (previousPropertyId.current === propertyId && previousSubjectId.current === principal.subjectId) return;
    previousPropertyId.current = propertyId;
    previousSubjectId.current = principal.subjectId;
    permissionDeniedRef.current = false;
    lowFreshnessResponseCountRef.current = 0;
    lowFreshnessQueryKeyRef.current = undefined;
    continuityLostQueryKeyRef.current = undefined;
    clearLowFreshnessRetry();
    const restored = readRoomStatusRestoration(principal.subjectId, propertyId);
    initialRestoration.current = restored;
    pendingRestoration.current = restored;
    setRestoreGridFocus(Boolean(restored));
    orderRestorationAttempted.current = false;
    restorationPagesVisited.current.clear();
    setRange(roomStatusRangeForOrderReturn(
      restoredOrDefaultRoomStatusRange(restored, propertyTimezone),
      pendingOrderReturnTarget.current?.propertyId === propertyId
        ? pendingOrderReturnTarget.current.triggerDate
        : undefined
    ));
    dispatchView({ type: "RESTORE", state: restored?.state ?? createRoomStatusViewState() });
    setBoard(undefined);
    setBoardFreshnessDeadline(undefined);
    boardRef.current = undefined;
    setBoardQueryKey(undefined);
    boardQueryKeyRef.current = undefined;
    historicalRefreshRequestRef.current = undefined;
    setQuickPopoverTarget(undefined);
    roomStatusInteractionSnapshotRef.current = undefined;
    setSelectedUnitId(undefined);
    setSelectedDayDate(undefined);
    setSelectedIntervalId(undefined);
    setSelectedGridStayId(undefined);
    setSelectedOrderIdentity(undefined);
    setSelectedOrderView(undefined);
    setSelectedOrderLoadedScope(undefined);
    setSelectedCorrectionOccupantId(undefined);
    setSelectedOrderCommandScope(undefined);
    setOrderContextOpen(false);
    setQuoteRecoveryContextOpen(false);
    setDesktopContextCollapsed(browserQuoteRecovery(principal.subjectId, propertyId).read.kind !== "ABSENT");
    setQuoteTarget(undefined);
    activeQuoteSubmissionIdentityRef.current = undefined;
    deferredMaintenanceIntentRef.current = undefined;
    setActiveQuoteSubmissionIdentity(undefined);
    setMaintenanceTarget(undefined);
    setCreateSelectionOpen(false);
    setMobileFocusRequest(undefined);
    pendingMobileTaskFocus.current = undefined;
    setCommandPhase("IDLE");
    commandAttemptGuard.invalidate();
    commandRevisionRef.current = undefined;
    commandQueryKeyRef.current = undefined;
    focusAfterNextBoard.current = false;
    returnedOrderCellFocus.current = undefined;
    setCommandContextInvalidated(false);
    setCommand(undefined);
    setQueryError(undefined);
    setReturnNotice(undefined);
    setCommandNotice(undefined);
    setActionError(undefined);
    setQuoteRecoveryOutcome(undefined);
    setInitializedPropertyId(propertyId);
  }, [principal.subjectId, propertyId, propertyTimezone]);

  useEffect(() => {
    if (initializedPropertyId !== propertyId) return;
    const query = roomStatusQuery(range, viewState.roomPageIndex, viewState.filters);
    const requestQueryKey = roomStatusQueryKey(query);
    const controller = new AbortController();
    const requestId = queryAttemptGuard.begin(controller);
    const timeout = window.setTimeout(() => {
      controller.abort(new Error("房态查询超时，未把未知状态解释为可售"));
    }, ROOM_STATUS_QUERY_TIMEOUT_MS);
    const existing = boardRef.current;
    const sameQuery = existing?.propertyId === propertyId
      && boardQueryKeyRef.current === requestQueryKey;
    const requestStartedAt = roomStatusFreshnessNow();
    const existingFreshnessDeadline = boardFreshnessDeadline;
    const writeContinuityExpected = Boolean(sameQuery
      && existing
      && existingFreshnessDeadline !== undefined
      && roomStatusProjectionHasWriteHeadroom(existingFreshnessDeadline, requestStartedAt));
    const recoveryHeadroomRequired = Boolean(sameQuery
      && existing
      && (continuityLostQueryKeyRef.current === requestQueryKey || !writeContinuityExpected));
    if (lowFreshnessQueryKeyRef.current !== requestQueryKey) {
      lowFreshnessResponseCountRef.current = 0;
      lowFreshnessQueryKeyRef.current = requestQueryKey;
      continuityLostQueryKeyRef.current = undefined;
      clearLowFreshnessRetry();
      resetQueryFailureRetry();
    }
    const projectionRefreshPaused = !roomStatusProjectionRefreshAllowed(commandPhaseRef.current) && Boolean(existing);
    if (!sameQuery) {
      setQueryPhase(existing ? "RANGE_LOADING" : "LOADING");
      setQueryError(undefined);
    } else if (!projectionRefreshPaused) {
      setQueryPhase("REFRESHING");
    }
    api.roomStatus(propertyId, query, controller.signal)
      .then((response) => {
        if (!queryAttemptGuard.isActive(requestId)) return;
        permissionDeniedRef.current = false;
        assertRoomStatusBoard(response, { propertyId, range, pageIndex: viewState.roomPageIndex, allowedActions: currentPropertyAllowedActions });
        const responseReceivedAt = roomStatusFreshnessNow();
        const localFreshnessDeadline = roomStatusProjectionLocalFreshnessDeadline(response, requestStartedAt);
        const writeContinuityPreserved = !writeContinuityExpected
          || existingFreshnessDeadline !== undefined
            && roomStatusProjectionHasWriteHeadroom(existingFreshnessDeadline, responseReceivedAt);
        const admitWrites = writeContinuityPreserved && roomStatusProjectionResponseCanEnableWrites(
          localFreshnessDeadline,
          responseReceivedAt,
          recoveryHeadroomRequired ? ROOM_STATUS_RECOVERY_INSTALL_HEADROOM_MS : ROOM_STATUS_RESPONSE_INSTALL_HEADROOM_MS
        );
        setBoardWriteAdmitted(admitWrites);
        let slowReadError: Error | undefined;
        if (!admitWrites) {
          if (sameQuery && existing) continuityLostQueryKeyRef.current = requestQueryKey;
          lowFreshnessResponseCountRef.current += 1;
          if (roomStatusLowFreshnessResponseRequiresManualRetry(lowFreshnessResponseCountRef.current)) {
            clearLowFreshnessRetry();
            slowReadError = new Error("房态响应持续过慢，无法取得足够安全的写入时间。请在网络恢复后重试刷新。");
          } else {
            scheduleLowFreshnessRetry(roomStatusStaleResponseRetryDelay(lowFreshnessResponseCountRef.current));
          }
        } else {
          lowFreshnessResponseCountRef.current = 0;
          continuityLostQueryKeyRef.current = undefined;
          clearLowFreshnessRetry();
        }
        if (commandPhaseRef.current === "CONFIRMING" && existing) {
          resetQueryFailureRetry();
          setQueryError(undefined);
          setQueryPhase("READY");
          setClock(responseReceivedAt);
          return;
        }
        if (commandRevisionRef.current
          && commandPhaseRef.current !== "IDLE"
          && response.revision !== commandRevisionRef.current) {
          setCommandContextInvalidated(true);
        }
        const restored = pendingRestoration.current;
        if (restored && response.page.totalPages > 0 && response.page.index >= response.page.totalPages) {
          const pageIndex = response.page.totalPages - 1;
          pendingRestoration.current = {
            ...restored,
            state: { ...restored.state, roomPageIndex: pageIndex }
          };
          setBoard(undefined);
          setBoardFreshnessDeadline(undefined);
          boardRef.current = undefined;
          setBoardQueryKey(undefined);
          boardQueryKeyRef.current = undefined;
          setQueryPhase("LOADING");
          dispatchView({ type: "SET_ROOM_PAGE", index: pageIndex, totalPages: response.page.totalPages });
          return;
        }
        const restoredSelection = restored?.state.selection;
        if (restoredSelection && !findRoomStatusUnit(response, restoredSelection.unitId) && response.page.totalPages > 1) {
          restorationPagesVisited.current.add(response.page.index);
          const nextPage = Array.from({ length: response.page.totalPages }, (_, index) => index)
            .find((index) => !restorationPagesVisited.current.has(index));
          if (nextPage !== undefined) {
            pendingRestoration.current = {
              ...restored,
              state: { ...restored.state, roomPageIndex: nextPage }
            };
            setBoard(undefined);
            setBoardFreshnessDeadline(undefined);
            boardRef.current = undefined;
            setBoardQueryKey(undefined);
            boardQueryKeyRef.current = undefined;
            setQueryPhase("LOADING");
            dispatchView({ type: "SET_ROOM_PAGE", index: nextPage, totalPages: response.page.totalPages });
            return;
          }
        }
        restorationPagesVisited.current.clear();
        const reloadOrderContext = roomStatusOrderContextNeedsReload(existing, response);
        setBoard(response);
        setBoardFreshnessDeadline(localFreshnessDeadline);
        boardRef.current = response;
        setBoardQueryKey(requestQueryKey);
        boardQueryKeyRef.current = requestQueryKey;
        setQueryError(slowReadError);
        if (slowReadError) {
          queryFailureRetryAttemptRef.current += 1;
          scheduleQueryFailureRetry(roomStatusQueryFailureRetryDelay(queryFailureRetryAttemptRef.current));
        } else {
          resetQueryFailureRetry();
        }
        setQueryPhase(slowReadError ? "ERROR" : "READY");
        setClock(responseReceivedAt);
        restoreRefreshReturnFocus();
        if (reloadOrderContext) setOrderRefreshToken((value) => value + 1);
        if (focusAfterNextBoard.current) {
          focusAfterNextBoard.current = false;
          setFocusRequestToken((value) => value + 1);
        }
        if (restored) {
          pendingRestoration.current = undefined;
          restorationPagesVisited.current.clear();
          const resolution = reconcileRoomStatusRestoration(response.rooms, response.dates, {
            ...restored.state,
            roomPageIndex: response.page.index
          }, restored.factFingerprint);
          dispatchView({ type: "RESTORE", state: resolution.state });
          if (resolution.outcome === "FACT_CHANGED") {
            setReturnNotice(restored.revision === response.revision
              ? "已重新校验返回位置。原选区的可售、状态、来源、冲突或允许动作已经变化；已保留选区供核对并将焦点移至选区起点。旧 Preview 不会继续使用。"
              : "房态数据已变化，且原选区的可售、状态、来源、冲突或允许动作已经变化；已保留选区供核对并将焦点移至选区起点。旧核对结果不会继续使用。");
          } else if (resolution.outcome === "FALLBACK") {
            setReturnNotice("当前筛选或日期范围已变化，已切换为当前可用的房态内容。");
          } else if (resolution.outcome === "EMPTY") {
            setReturnNotice("上次查看的位置已失效，已回到当前可用的房态内容。");
          } else {
            setReturnNotice(undefined);
          }
        }
      })
      .catch((error) => {
        if (!queryAttemptGuard.isActive(requestId)) return;
        lowFreshnessResponseCountRef.current = 0;
        clearLowFreshnessRetry();
        setQueryError(error);
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
          resetQueryFailureRetry();
          permissionDeniedRef.current = true;
          latestRestoration.current = undefined;
          setBoard(undefined);
          setBoardFreshnessDeadline(undefined);
          boardRef.current = undefined;
          setBoardQueryKey(undefined);
          boardQueryKeyRef.current = undefined;
          pendingRestoration.current = undefined;
          try {
            window.sessionStorage.removeItem(roomStatusRestorationKey(principal.subjectId, propertyId));
          } catch {
            // Permission denial still clears all in-memory business state.
          }
          dispatchView({ type: "RESTORE", state: createRoomStatusViewState() });
          setSelectedUnitId(undefined);
          setSelectedDayDate(undefined);
          setSelectedIntervalId(undefined);
          setSelectedOrderIdentity(undefined);
          setSelectedOrderView(undefined);
          setSelectedOrderLoadedScope(undefined);
          setSelectedCorrectionOccupantId(undefined);
          setSelectedOrderCommandScope(undefined);
          setOrderContextOpen(false);
          setDesktopContextCollapsed(false);
          setQuoteTarget(undefined);
          setMaintenanceTarget(undefined);
          setCreateSelectionOpen(false);
          setCommandPhase("IDLE");
          commandAttemptGuard.invalidate();
          commandRevisionRef.current = undefined;
          commandQueryKeyRef.current = undefined;
          focusAfterNextBoard.current = false;
          setCommandContextInvalidated(false);
          setCommand(undefined);
          setRecoveryDialogOpen(false);
          setActionError(undefined);
          setReturnNotice(undefined);
          setRestorationError(undefined);
          setQueryPhase("PERMISSION_DENIED");
        } else {
          rememberRefreshReturnFocus(document.activeElement);
          queryFailureRetryAttemptRef.current += 1;
          scheduleQueryFailureRetry(roomStatusQueryFailureRetryDelay(queryFailureRetryAttemptRef.current));
          setQueryPhase("ERROR");
        }
      })
      .finally(() => {
        window.clearTimeout(timeout);
        if (queryAttemptGuard.finish(requestId)) {
          setQuerySettledToken((value) => value + 1);
        }
      });
    return () => {
      window.clearTimeout(timeout);
      queryAttemptGuard.invalidate(requestId);
      controller.abort();
    };
  }, [
    initializedPropertyId,
    clearLowFreshnessRetry,
    resetQueryFailureRetry,
    orderPrincipalScope,
    propertyId,
    range.arrivalDate,
    range.departureDate,
    rememberRefreshReturnFocus,
    refreshToken,
    restoreRefreshReturnFocus,
    scheduleLowFreshnessRetry,
    scheduleQueryFailureRetry,
    viewState.roomPageIndex,
    viewState.filters.search,
    viewState.filters.roomTypeCode,
    viewState.filters.salesMode,
    viewState.filters.status,
    viewState.filters.kind,
    viewState.filters.minimumCapacity
  ]);

  useEffect(() => {
    if (!board || !boardMatchesCurrentQuery) return;
    const snapshot: RoomStatusRestorationSnapshot = {
      version: 1,
      propertyId,
      revision: board.revision,
      range,
      savedAt: new Date().toISOString(),
      state: viewState,
      factFingerprint: roomStatusFactFingerprint(board.rooms, viewState)
    };
    latestRestoration.current = { subjectId: principal.subjectId, snapshot };
    const timer = window.setTimeout(() => {
      const saved = writeRoomStatusRestoration(principal.subjectId, snapshot);
      setRestorationError(saved ? undefined : new Error("浏览器无法保存房态返回位置；本次业务事实未受影响"));
    }, 150);
    return () => window.clearTimeout(timer);
  }, [board, boardMatchesCurrentQuery, principal.subjectId, propertyId, range, viewState]);

  useEffect(() => () => {
    const latest = latestRestoration.current;
    if (latest
      && latest.subjectId === principal.subjectId
      && latest.snapshot.propertyId === propertyId) {
      writeRoomStatusRestoration(latest.subjectId, latest.snapshot);
    }
  }, [principal.subjectId, propertyId]);

  const boardForCurrentProperty = boardMatchesCurrentProperty ? board : undefined;
  const boardExpired = Boolean(boardForCurrentProperty
    && (boardFreshnessDeadline === undefined || clock > boardFreshnessDeadline));
  const boardWriteWindowClosed = Boolean(boardForCurrentProperty
    && (boardFreshnessDeadline === undefined
      || !roomStatusProjectionHasWriteHeadroom(boardFreshnessDeadline, clock)));
  const boardRefreshFailed = Boolean(boardForCurrentProperty && queryError);
  const rangeLoading = queryPhase === "RANGE_LOADING"
    || Boolean(boardForCurrentProperty && !boardMatchesCurrentQuery);
  useEffect(() => {
    if (!rangeLoading) {
      setRangeLoadingNoticeReady(false);
      return;
    }
    const timer = window.setTimeout(
      () => setRangeLoadingNoticeReady(true),
      ROOM_STATUS_RANGE_LOADING_NOTICE_DELAY_MS
    );
    return () => window.clearTimeout(timer);
  }, [rangeLoading]);
  const rangeLoadingNoticeVisible = rangeLoading && rangeLoadingNoticeReady;
  const queryBusy = queryPhase === "LOADING"
    || queryPhase === "RANGE_LOADING"
    || Boolean(board && !boardMatchesCurrentQuery);
  const projectionReadyForWrite = Boolean(board
    && boardMatchesCurrentQuery
    && !queryError
    && !focusAfterNextBoard.current
    && board.projectionState === "READY"
    && (queryPhase === "READY" || queryPhase === "REFRESHING"));
  const activeProjectionValid = roomStatusProjectionWritable({
    projectionReady: projectionReadyForWrite,
    projectionExpired: false,
    boardAccess: boardForCurrentProperty?.accessLevel,
    principalAccess: principalPropertyAccess
  });
  const projectionWritable = roomStatusProjectionWritable({
    projectionReady: projectionReadyForWrite,
    projectionExpired: boardWriteWindowClosed || !boardWriteAdmitted,
    boardAccess: boardForCurrentProperty?.accessLevel,
    principalAccess: principalPropertyAccess
  });
  const recoveryQuoteTarget: RoomStatusQuoteTarget | undefined = pageQuoteRecovery.kind === "VALID" ? {
    unitId: pageQuoteRecovery.pending.input.inventoryUnitId,
    arrivalDate: pageQuoteRecovery.pending.input.arrivalDate,
    departureDate: pageQuoteRecovery.pending.input.departureDate,
    initialStayType: pageQuoteRecovery.pending.input.stayType
      ?? paidStayTypeForDates(
        pageQuoteRecovery.pending.input.arrivalDate,
        pageQuoteRecovery.pending.input.departureDate
      ),
    ...(pageQuoteRecovery.pending.actionCode ? {
      actionCode: pageQuoteRecovery.pending.actionCode,
      ...(pageQuoteRecovery.pending.actionCode === "BACKFILL_ORDER" ? { backfill: true } : {})
    } : {})
  } : undefined;
  const quoteWorkbenchOpenForCurrentTarget = Boolean(quoteTarget)
    && !quoteRecoveryContextOpen
    && (isMobile || !desktopContextCollapsed);
  const activeOwnQuoteSubmissionInWorkbench = roomStatusActiveOwnQuoteSubmissionMatches({
    recovery: pageQuoteRecovery,
    currentOwnerId: currentBrowserQuoteRecoveryOwnerId,
    activeSubmissionIdentity: activeQuoteSubmissionIdentity,
    workbenchOpen: quoteWorkbenchOpenForCurrentTarget
  });
  const quoteRecoveryNeedsPagePresentation = roomStatusQuoteRecoveryNeedsPagePresentation({
    recovery: pageQuoteRecovery,
    currentOwnerId: currentBrowserQuoteRecoveryOwnerId,
    activeSubmissionIdentity: activeQuoteSubmissionIdentity,
    recoveryTarget: recoveryQuoteTarget,
    currentTarget: quoteTarget,
    workbenchOpen: quoteWorkbenchOpenForCurrentTarget
  });
  const currentQuoteSubmittingInWorkbench = pageQuoteRecovery.kind === "VALID"
    && !quoteRecoveryNeedsPagePresentation;
  const pageQuoteRecoveryForPresentation: QuoteRecoveryReadResult = quoteRecoveryNeedsPagePresentation
    ? pageQuoteRecovery
    : { kind: "ABSENT" };
  const commandRecoveryBlockedForPresentation = commandRecovery.blocked
    && recoveryPendingAllowed
    && !(currentQuoteSubmittingInWorkbench
      && commandRecovery.ready
      && !commandRecovery.pending
      && !commandRecovery.error
      && !commandRecovery.canDiscardCorrupt
      && commandRecovery.conflict.kind === "PRESENT"
      && commandRecovery.conflict.storageKey === pageQuoteRecoveryScope);
  const commandTargetScopeCurrent = selectedOrderCommandScopeIsCurrent(
    selectedOrderCommandScope,
    orderPrincipalScope,
    selectedOrderIdentity
  );
  const commandWriteGate = roomStatusCommandWriteGate({
    projectionWritable,
    activeProjectionValid,
    recoveryBlocked: roomStatusRecoveryBlocksNewWrites(commandRecovery.blocked && recoveryPendingAllowed, pageQuoteRecovery),
    recoveryReady: commandRecovery.ready,
    recoveryError: commandRecovery.error,
    contextInvalidated: commandContextInvalidated,
    targetScopeCurrent: commandTargetScopeCurrent
  });
  const commandsBlocked = commandWriteGate.startBlocked;
  const activeCommandWriteBlocked = commandWriteGate.activeBlocked;
  const recoveryEntryAvailable = Boolean(commandRecovery.pending && recoveryPendingAllowed
    || pageQuoteRecoveryForPresentation.kind !== "ABSENT"
    || commandRecovery.canDiscardCorrupt);
  const actionPresentationBlock = roomStatusActionPresentationBlock({
    refreshFailed: boardRefreshFailed,
    accessLevel: boardForCurrentProperty?.accessLevel === "WRITE" && principalPropertyAccess === "WRITE"
      ? "WRITE"
      : "READ",
    projectionWritable,
    projectionExpired: boardExpired,
    projectionReady: activeProjectionValid,
    recoveryBlocked: roomStatusRecoveryBlocksNewWrites(commandRecoveryBlockedForPresentation, pageQuoteRecoveryForPresentation),
    recoveryReady: commandRecovery.ready,
    recoveryError: commandRecovery.error,
    hasRecoveryEntry: recoveryEntryAvailable,
    recoveryActionLabel: commandRecovery.pending || pageQuoteRecoveryForPresentation.kind === "VALID"
      ? "查询原操作结果"
      : "处理恢复记录"
  });
  const controlWriteBlock = actionPresentationBlock?.kind === "REFRESH" ? undefined : actionPresentationBlock;
  useEffect(() => {
    if (!command || commandPhaseRef.current === "IDLE" || !commandQueryKeyRef.current) return;
    if (commandQueryKeyRef.current !== currentBoardQueryKey) setCommandContextInvalidated(true);
  }, [command, currentBoardQueryKey]);
  const renderedBoard = useMemo(
    () => boardForCurrentProperty
      ? displayRoomStatusBoard(boardForCurrentProperty, commandsBlocked && !command)
      : undefined,
    [boardForCurrentProperty, command, commandsBlocked]
  );
  const filteredViewHasNoRooms = Boolean(renderedBoard
    && hasActiveRoomStatusFilters(viewState.filters)
    && filterRoomStatusRooms(renderedBoard.rooms, viewState.filters).length === 0);
  const selectedUnit = findRoomStatusUnit(renderedBoard, selectedUnitId ?? viewState.selection?.unitId);
  const selectedDay = selectedUnit?.days.find((day) => day.serviceDate === selectedDayDate) ?? null;
  const selectedInterval = selectedUnit?.intervals.find((interval) => interval.id === selectedIntervalId) ?? null;
  const quickPopoverUnit = findRoomStatusUnit(renderedBoard, quickPopoverTarget?.unitId);
  const quickPopoverDay = quickPopoverUnit?.days.find((day) => day.serviceDate === quickPopoverTarget?.serviceDate) ?? null;
  const quickPopoverInterval = quickPopoverUnit?.intervals.find((interval) => (
    quickPopoverTarget?.intervalId
      ? interval.id === quickPopoverTarget.intervalId
      : interval.actualInventoryUnitId === quickPopoverUnit.id
        && interval.startDate <= quickPopoverTarget!.serviceDate
        && quickPopoverTarget!.serviceDate < interval.endDate
  )) ?? null;
  const quickPopoverStatus = quickPopoverInterval?.status ?? quickPopoverDay?.status ?? "UNKNOWN";
  const quickPopoverAttentionLabels = roomStatusQuickPopoverAttentionLabels(
    quickPopoverUnit,
    quickPopoverTarget?.serviceDate,
    quickPopoverTarget?.selection
  );
  const quickPopoverSelection = quickPopoverTarget?.selection ?? null;
  const quickPopoverAuthorizedActions = (quickPopoverSelection
    ? selectionActions(quickPopoverUnit, quickPopoverSelection, renderedBoard?.businessDate)
    : quickPopoverInterval
      ? intervalActions(quickPopoverInterval, null)
      : dayActions(quickPopoverUnit, quickPopoverDay, renderedBoard?.businessDate))
    .filter((action) => currentReleaseFeatures.cleaningWorkflow || action.code !== "COMPLETE_CLEANING");
  const quickPopoverActions = roomStatusActionsForPresentation(quickPopoverAuthorizedActions, actionPresentationBlock);
  const quickPopoverOrders = quickPopoverUnit && quickPopoverTarget
    ? quickPopoverSelection
      ? roomStatusOrderOptionsForSelection(quickPopoverUnit, quickPopoverSelection)
      : roomStatusOrderOptionsForDate(quickPopoverUnit, quickPopoverTarget.serviceDate)
    : { kind: "READY" as const, orders: [] };
  // A split-bed parent cell is an occupancy summary, even when it happens to
  // contain one child order. Concrete bed and non-aggregate room rows may still
  // use their unique order as the Stay preview.
  const quickPopoverPreviewStayId = quickPopoverSelection
    ? null
    : roomStatusQuickPopoverPreviewStayId(
      quickPopoverUnit,
      quickPopoverInterval ? roomStatusOrderIdentityForInterval(quickPopoverInterval)?.stayId : null,
      roomStatusUniqueOrderStayId(quickPopoverOrders)
    );
  const selectedSelectionDays = selectionDays(selectedUnit, viewState.selection);
  const relatedIntervals = useMemo(() => {
    if (!selectedUnit) return [];
    const intervalIds = new Set(selectedInterval
      ? [selectedInterval.id]
      : viewState.selection
        ? selectedSelectionDays.flatMap((day) => day.intervalIds)
        : selectedDay?.intervalIds ?? []);
    return selectedUnit.intervals.filter((interval) => intervalIds.has(interval.id));
  }, [selectedDay?.intervalIds, selectedInterval, selectedSelectionDays, selectedUnit, viewState.selection]);
  const contextConflicts = uniqueConflicts(selectedInterval?.conflicts
    ?? (viewState.selection ? relatedIntervals.flatMap((interval) => interval.conflicts) : selectedDay?.conflicts ?? []));
  // A cell click always leaves a one-day selection behind; when that selection
  // covers unavailable days (locks, stays) selectionActions is empty by design,
  // so fall back to the clicked day's own interval actions (e.g. release lock).
  const selectionContextActions = viewState.selection ? selectionActions(selectedUnit, viewState.selection, renderedBoard?.businessDate) : [];
  const candidateContextActions = selectedInterval
      ? intervalActions(selectedInterval, viewState.selection)
      : viewState.selection && selectionContextActions.length > 0
        ? selectionContextActions
        : dayActions(selectedUnit, selectedDay, renderedBoard?.businessDate).filter((action) => action.enabled);
  const contextActions = currentQuoteSubmittingInWorkbench
    ? candidateContextActions.map((action) => action.code === "OPEN_ORDER"
      || !action.enabled
      || (activeOwnQuoteSubmissionInWorkbench && selectionActionCodes.has(action.code))
      ? action
      : { ...action, enabled: false })
    : roomStatusActionsForPresentation(candidateContextActions, actionPresentationBlock);
  const historicalSelectionOpen = Boolean(renderedBoard && (
    (quickPopoverTarget
      && (quickPopoverSelection?.arrivalDate ?? quickPopoverTarget.serviceDate) < renderedBoard.businessDate)
    || (!desktopContextCollapsed
      && viewState.selection
      && viewState.selection.arrivalDate < renderedBoard.businessDate)
  ));
  useEffect(() => {
    void querySettledToken;
    if (!renderedBoard || !roomStatusHistoricalSelectionNeedsRefresh({
      boardExpired,
      historicalSelectionOpen,
      queryInFlight: queryAttemptGuard.isInFlight()
    })) {
      if (!boardExpired) historicalRefreshRequestRef.current = undefined;
      return;
    }
    const requestKey = `${renderedBoard.revision}:${renderedBoard.freshUntil}`;
    if (historicalRefreshRequestRef.current === requestKey) return;
    historicalRefreshRequestRef.current = requestKey;
    setRefreshToken((value) => value + 1);
  }, [boardExpired, historicalSelectionOpen, querySettledToken, renderedBoard?.freshUntil, renderedBoard?.revision]);
  const useInlineOrderContext = roomStatusOrderContextMode(workspaceWidth, isMobile) === "INLINE";
  const authorizedSelectedOrderView = selectedOrderLoadedScope === orderPrincipalScope ? selectedOrderView : undefined;
  const selectedCorrectionOccupant = authorizedSelectedOrderView?.occupants.find((occupant) => occupant.id === selectedCorrectionOccupantId);

  useEffect(() => {
    if (!pendingOrderContextIdentity) return;
    if (roomStatusOrderIdentityKey(selectedOrderIdentity) !== pendingOrderContextIdentity) {
      setPendingOrderContextIdentity(undefined);
      return;
    }
    if (selectedOrderLoading || (!authorizedSelectedOrderView && !selectedOrderError)) return;
    setPendingOrderContextIdentity(undefined);
    setOrderContextOpen(true);
    setDesktopContextCollapsed(false);
  }, [authorizedSelectedOrderView, pendingOrderContextIdentity, selectedOrderError, selectedOrderIdentity, selectedOrderLoading]);

  useEffect(() => {
    if (!quickPopoverTarget) return;
    if (quickPopoverTarget.anchor.isConnected && quickPopoverUnit && (quickPopoverDay || quickPopoverInterval)) return;
    if (quickPopoverUnit && (quickPopoverDay || quickPopoverInterval)) {
      const detachedAnchor = quickPopoverTarget.anchor;
      const targetUnitId = quickPopoverTarget.unitId;
      const targetServiceDate = quickPopoverTarget.serviceDate;
      const replacementAnchor = [...(boardColumnRef.current?.querySelectorAll<HTMLElement>("[data-room-status-cell='true']") ?? [])]
        .find((anchor) => roomStatusAnchorMatches(anchor, targetUnitId, targetServiceDate));
      if (replacementAnchor) {
        const snapshot = roomStatusInteractionSnapshotRef.current;
        if (snapshot?.anchor === detachedAnchor) {
          roomStatusInteractionSnapshotRef.current = {
            ...snapshot,
            anchor: replacementAnchor,
            grid: replacementAnchor.closest<HTMLElement>(".room-status-grid-scroll")
          };
        }
        setQuickPopoverTarget((current) => (
          roomStatusQuickTargetMatches(current, targetUnitId, targetServiceDate)
            && current?.anchor === detachedAnchor
            ? { ...current, anchor: replacementAnchor }
            : current
        ));
        return;
      }
    }
    setQuickPopoverTarget(undefined);
    roomStatusInteractionSnapshotRef.current = undefined;
    dispatchView({ type: "SET_SELECTION", selection: null });
    if (renderedBoard) setReturnNotice("原房态格已不在当前页面，快捷操作已关闭。请重新选择房态格。");
  }, [quickPopoverDay, quickPopoverInterval, quickPopoverTarget, quickPopoverUnit, renderedBoard]);

  useEffect(() => {
    if (orderRestorationAttempted.current || !initialRestoration.current || !renderedBoard) return;
    orderRestorationAttempted.current = true;
    if (orderReturnEnvelopePresent.current) return;
    const restoredSelection = viewState.selection;
    if (!restoredSelection) return;
    const restoredUnit = findRoomStatusUnit(renderedBoard, restoredSelection.unitId);
    const identity = restoredUnit ? roomStatusOrderIdentityForDate(restoredUnit, restoredSelection.arrivalDate) : null;
    if (!identity) return;
    setSelectedUnitId(restoredUnit?.id);
    setSelectedDayDate(restoredSelection.arrivalDate);
    setSelectedIntervalId(identity.intervalId);
    setSelectedOrderIdentity(identity);
    setPendingOrderContextIdentity(roomStatusOrderIdentityKey(identity));
    setOrderContextOpen(false);
    setDesktopContextCollapsed(true);
    setFocusRequestToken((value) => value + 1);
  }, [renderedBoard, viewState.selection]);

  useEffect(() => {
    const target = returnedOrderCellFocus.current;
    if (!target || !orderContextOpen || selectedOrderIdentity?.unitId !== target.unitId) return;
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        const cell = [...document.querySelectorAll<HTMLElement>("[data-room-status-cell='true']")]
          .find((candidate) => candidate.dataset.unitId === target.unitId
            && candidate.dataset.serviceDate === target.serviceDate);
        if (!cell) return;
        dispatchView({ type: "SET_FOCUS", focus: target });
        cell.scrollIntoView({ behavior: "auto", block: "nearest", inline: "nearest" });
        cell.focus({ preventScroll: true });
        if (cell.ownerDocument.activeElement === cell) returnedOrderCellFocus.current = undefined;
      });
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      if (secondFrame) cancelAnimationFrame(secondFrame);
    };
  }, [
    boardQueryKey,
    orderContextOpen,
    renderedBoard?.page.index,
    renderedBoard?.revision,
    selectedOrderIdentity?.unitId,
    viewState.dateWindowSize,
    viewState.dateWindowStart
  ]);

  useEffect(() => {
    const target = pendingOrderReturnTarget.current;
    if (!renderedBoard || !boardMatchesCurrentQuery || orderReturnResolutionStarted.current) return;
    if (!target) {
      if (!orderReturnEnvelopePresent.current) return;
      returnedOrderCellFocus.current = undefined;
      orderReturnEnvelopePresent.current = false;
      navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
      dispatchView({ type: "SET_SELECTION", selection: null });
      setReturnNotice("订单返回信息已损坏，未恢复原订单详情。请按最新房态重新选择。");
      return;
    }
    if (target.propertyId !== propertyId) {
      returnedOrderCellFocus.current = undefined;
      pendingOrderReturnTarget.current = null;
      orderReturnEnvelopePresent.current = false;
      navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
      dispatchView({ type: "SET_SELECTION", selection: null });
      setReturnNotice("订单所属物业与当前房态不一致，未恢复订单详情。请切换到正确物业后重新选择。");
      return;
    }
    orderReturnResolutionStarted.current = true;
    let current = true;
    let activeController: AbortController | undefined;
    const clearReturnedContext = () => {
      returnedOrderCellFocus.current = undefined;
      setSelectedUnitId(undefined);
      setSelectedDayDate(undefined);
      setSelectedIntervalId(undefined);
      setSelectedOrderIdentity(undefined);
      setSelectedOrderView(undefined);
      setSelectedOrderLoadedScope(undefined);
      setSelectedCorrectionOccupantId(undefined);
      setOrderContextOpen(false);
      dispatchView({ type: "SET_SELECTION", selection: null });
    };
    const consumeReturnState = () => {
      orderReturnEnvelopePresent.current = false;
      navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
    };
    const applyReturnedIdentity = (identity: RoomStatusOrderIdentity, pageIndex: number, totalPages: number) => {
      pendingOrderReturnTarget.current = null;
      orderReturnResolutionStarted.current = false;
      consumeReturnState();
      const parentRoomId = meta.inventoryUnits.find((candidate) => candidate.id === identity.unitId)?.parent_room_id;
      if (parentRoomId && !viewState.expandedRoomIds.includes(parentRoomId)) {
        dispatchView({ type: "TOGGLE_ROOM", roomId: parentRoomId });
      }
      const pageChanges = pageIndex !== renderedBoard.page.index;
      if (pageChanges) {
        dispatchView({ type: "SET_ROOM_PAGE", index: pageIndex, totalPages });
      }
      dispatchView({ type: "SET_FOCUS", focus: { unitId: identity.unitId, serviceDate: target.triggerDate } });
      dispatchView({
        type: "SET_DATE_WINDOW",
        start: dateWindowStartForFocus(
          renderedBoard.dates,
          viewState.dateWindowStart,
          viewState.dateWindowSize,
          target.triggerDate
        ),
        totalDates: renderedBoard.dates.length
      });
      returnedOrderCellFocus.current = { unitId: identity.unitId, serviceDate: target.triggerDate };
      selectOrderContextIdentity(identity, target.triggerDate);
      if (pageChanges) focusAfterNextBoard.current = true;
      else setFocusRequestToken((value) => value + 1);
      setReturnNotice("订单处理完成，已按最新房态恢复原住宿选择。");
    };
    const loadReturnPage = async (pageIndex: number) => {
      const controller = new AbortController();
      activeController = controller;
      const timeout = window.setTimeout(() => {
        controller.abort(new Error("恢复订单位置的房态查询超时"));
      }, ROOM_STATUS_QUERY_TIMEOUT_MS);
      try {
        return await api.roomStatus(propertyId, roomStatusQuery(range, pageIndex, viewState.filters), controller.signal);
      } finally {
        window.clearTimeout(timeout);
        if (activeController === controller) activeController = undefined;
      }
    };
    const resolveReturnedStay = async () => {
      if (renderedBoard.projectionState !== "READY") {
        throw new Error("最新房态数据不完整，暂时不能恢复订单位置");
      }
      const boards = [renderedBoard];
      for (let pageIndex = 0; pageIndex < renderedBoard.page.totalPages; pageIndex += 1) {
        if (pageIndex === renderedBoard.page.index) continue;
        const response = await loadReturnPage(pageIndex);
        if (!current) return;
        assertRoomStatusBoard(response, { propertyId, range, pageIndex, allowedActions: currentPropertyAllowedActions });
        if (response.revision !== renderedBoard.revision
          || response.businessDate !== renderedBoard.businessDate
          || response.accessLevel !== renderedBoard.accessLevel
          || response.projectionState !== renderedBoard.projectionState
          || response.page.size !== renderedBoard.page.size
          || response.page.totalRooms !== renderedBoard.page.totalRooms
          || response.page.totalPages !== renderedBoard.page.totalPages) {
          throw new Error("恢复订单位置期间房态分页事实已变化");
        }
        boards.push(response);
      }
      if (!current) return;
      const resolution = resolveRoomStatusOrderReturnTarget(
        boards.flatMap((candidate) => candidate.rooms.flatMap((room) => [room, ...room.children])),
        target
      );
      if (resolution.kind === "MATCH") {
        const targetBoard = boards.find((candidate) => candidate.rooms.some((room) => (
          room.id === resolution.identity.unitId
          || room.children.some((child) => child.id === resolution.identity.unitId)
        )));
        if (!targetBoard) throw new Error("恢复订单位置时未找到匹配房源分页");
        applyReturnedIdentity(resolution.identity, targetBoard.page.index, targetBoard.page.totalPages);
        return;
      }
      if (resolution.kind === "NOT_FOUND" && hasActiveRoomStatusFilters(viewState.filters)) {
        orderReturnResolutionStarted.current = false;
        dispatchView({ type: "CLEAR_FILTERS" });
        dispatchView({ type: "SET_ROOM_PAGE", index: 0, totalPages: renderedBoard.page.totalPages });
        setReturnNotice("原住宿不在当前筛选结果中，已清除筛选并继续恢复订单位置。");
        return;
      }
      pendingOrderReturnTarget.current = null;
      orderReturnResolutionStarted.current = false;
      consumeReturnState();
      clearReturnedContext();
      setReturnNotice(resolution.kind === "AMBIGUOUS"
        ? "订单处理完成，但最新房态存在多个相互冲突的住宿位置。已安全关闭订单详情，请刷新后重新核对。"
        : "订单处理完成，但最新房态中找不到原住宿位置。已安全关闭订单详情，请按最新房态重新选择。");
    };
    void resolveReturnedStay().catch((error: unknown) => {
      if (!current) return;
      pendingOrderReturnTarget.current = null;
      orderReturnResolutionStarted.current = false;
      consumeReturnState();
      clearReturnedContext();
      setActionError(error);
      setReturnNotice("订单处理完成，但暂时无法核对最新住宿位置。订单详情已安全关闭，请按最新房态重新选择。");
    });
    return () => {
      current = false;
      activeController?.abort();
      orderReturnResolutionStarted.current = false;
    };
  }, [
    boardMatchesCurrentQuery,
    location.pathname,
    location.search,
    meta.inventoryUnits,
    navigate,
    propertyId,
    range.arrivalDate,
    range.departureDate,
    renderedBoard?.page.index,
    renderedBoard?.page.totalPages,
    renderedBoard?.revision,
    viewState.filters.kind,
    viewState.filters.minimumCapacity,
    viewState.filters.roomTypeCode,
    viewState.filters.salesMode,
    viewState.filters.search,
    viewState.filters.status,
    viewState.dateWindowSize,
    viewState.dateWindowStart,
    viewState.expandedRoomIds
  ]);

  useEffect(() => {
    if (command || !selectedOrderIdentity || !renderedBoard || !boardMatchesCurrentQuery) return;
    const identityOutsideCurrentRange = selectedOrderIdentity.departureDate <= renderedBoard.range.arrivalDate
      || selectedOrderIdentity.arrivalDate >= renderedBoard.range.departureDate;
    if (identityOutsideCurrentRange) return;
    const triggerDate = selectedDayDate
      && selectedOrderIdentity.arrivalDate <= selectedDayDate
      && selectedDayDate < selectedOrderIdentity.departureDate
      ? selectedDayDate
      : selectedOrderIdentity.arrivalDate;
    const target = {
      orderId: selectedOrderIdentity.orderId,
      stayId: selectedOrderIdentity.stayId,
      triggerDate
    };
    const currentResolution = resolveRoomStatusOrderReturnTarget(
      renderedBoard.rooms.flatMap((room) => [room, ...room.children]),
      target
    );
    if (currentResolution.kind === "MATCH") return;
    let current = true;
    const failClosed = (notice: string) => {
      setSelectedUnitId(undefined);
      setSelectedDayDate(undefined);
      setSelectedIntervalId(undefined);
      setSelectedGridStayId(undefined);
      setSelectedOrderIdentity(undefined);
      setSelectedOrderView(undefined);
      setSelectedOrderLoadedScope(undefined);
      setSelectedCorrectionOccupantId(undefined);
      setOrderContextOpen(false);
      roomStatusInteractionSnapshotRef.current = undefined;
      dispatchView({ type: "SET_SELECTION", selection: null });
      setReturnNotice(notice);
    };
    if (currentResolution.kind === "AMBIGUOUS") {
      failClosed("最新房态存在多个相互冲突的住宿位置，订单详情已安全关闭。请刷新后重新核对。");
      return;
    }
    const sameFilters = (
      left: RoomStatusViewState["filters"],
      right: RoomStatusViewState["filters"]
    ) => roomStatusFilterKeys.every((key) => left[key] === right[key]);
    const assertSamePageSet = (candidate: RoomStatusBoardDto, baseline: RoomStatusBoardDto) => {
      if (candidate.revision !== baseline.revision
        || candidate.businessDate !== baseline.businessDate
        || candidate.accessLevel !== baseline.accessLevel
        || candidate.projectionState !== baseline.projectionState
        || candidate.page.size !== baseline.page.size
        || candidate.page.totalRooms !== baseline.page.totalRooms
        || candidate.page.totalPages !== baseline.page.totalPages) {
        throw new Error("定位换房结果期间房态分页事实已变化");
      }
    };
    const loadPage = async (pageIndex: number, filters: RoomStatusViewState["filters"]) => {
      const response = await api.roomStatus(propertyId, roomStatusQuery(range, pageIndex, filters));
      if (!current) return undefined;
      assertRoomStatusBoard(response, { propertyId, range, pageIndex, allowedActions: currentPropertyAllowedActions });
      return response;
    };
    const loadPageSet = async (
      filters: RoomStatusViewState["filters"],
      seed?: RoomStatusBoardDto
    ) => {
      const baseline = seed ?? await loadPage(0, filters);
      if (!baseline || !current) return [];
      const boards = [baseline];
      for (let pageIndex = 0; pageIndex < baseline.page.totalPages; pageIndex += 1) {
        if (pageIndex === baseline.page.index) continue;
        const response = await loadPage(pageIndex, filters);
        if (!response || !current) return [];
        assertSamePageSet(response, baseline);
        boards.push(response);
      }
      return boards;
    };
    const resolveOnBoards = (boards: readonly RoomStatusBoardDto[]) => {
      const resolution = resolveRoomStatusOrderReturnTarget(
        boards.flatMap((candidate) => candidate.rooms.flatMap((room) => [room, ...room.children])),
        target
      );
      if (resolution.kind !== "MATCH") return { resolution } as const;
      const targetBoard = boards.find((candidate) => candidate.rooms.some((room) => (
        room.id === resolution.identity.unitId
        || room.children.some((child) => child.id === resolution.identity.unitId)
      )));
      return targetBoard
        ? { resolution, targetBoard } as const
        : { resolution: { kind: "NOT_FOUND" as const } } as const;
    };
    const applyMovedStay = (
      identity: RoomStatusOrderIdentity,
      targetBoard: RoomStatusBoardDto,
      filters: RoomStatusViewState["filters"]
    ) => {
      const filtersChanged = !sameFilters(filters, viewState.filters);
      const pageChanged = targetBoard.page.index !== renderedBoard.page.index;
      const parentRoomId = meta.inventoryUnits.find((candidate) => candidate.id === identity.unitId)?.parent_room_id;
      if (filtersChanged) dispatchView({ type: "SET_FILTERS", filters });
      if (parentRoomId && !viewState.expandedRoomIds.includes(parentRoomId)) {
        dispatchView({ type: "TOGGLE_ROOM", roomId: parentRoomId });
      }
      if (pageChanged || filtersChanged) {
        dispatchView({ type: "SET_ROOM_PAGE", index: targetBoard.page.index, totalPages: targetBoard.page.totalPages });
      }
      dispatchView({
        type: "SET_SELECTION",
        selection: {
          unitId: identity.unitId,
          anchorDate: triggerDate,
          focusDate: triggerDate,
          arrivalDate: identity.intervalStartDate,
          departureDate: identity.intervalEndDate
        }
      });
      dispatchView({ type: "SET_FOCUS", focus: { unitId: identity.unitId, serviceDate: triggerDate } });
      setSelectedUnitId(identity.unitId);
      setSelectedDayDate(triggerDate);
      setSelectedIntervalId(identity.intervalId);
      setSelectedGridStayId(identity.stayId);
      setSelectedOrderIdentity(identity);
      returnedOrderCellFocus.current = { unitId: identity.unitId, serviceDate: triggerDate };
      roomStatusInteractionSnapshotRef.current = undefined;
      if (pageChanged || filtersChanged) focusAfterNextBoard.current = true;
      else setFocusRequestToken((value) => value + 1);
      setReturnNotice(filtersChanged
        ? "住宿已移动到筛选外的房源；已仅清除遮挡目标的筛选条件，并保留订单详情定位到最新安排。"
        : "房态数据已变化，住宿已移动到其他房源页；已保留订单详情并定位到最新安排。");
    };
    const findMovedStay = async () => {
      const filteredBoards = await loadPageSet(viewState.filters, renderedBoard);
      if (!current) return;
      const filtered = resolveOnBoards(filteredBoards);
      if (filtered.resolution.kind === "MATCH" && filtered.targetBoard) {
        applyMovedStay(filtered.resolution.identity, filtered.targetBoard, viewState.filters);
        return;
      }
      if (filtered.resolution.kind === "AMBIGUOUS") {
        failClosed("最新房态存在多个相互冲突的住宿位置，订单详情已安全关闭。请刷新后重新核对。");
        return;
      }
      if (!hasActiveRoomStatusFilters(viewState.filters)) {
        failClosed("原先选中的住宿已不在最新房态中，订单详情已安全关闭。请按最新房态重新选择。");
        return;
      }
      const unfilteredBoards = await loadPageSet(DEFAULT_ROOM_STATUS_FILTERS);
      if (!current) return;
      const unfiltered = resolveOnBoards(unfilteredBoards);
      if (unfiltered.resolution.kind !== "MATCH" || !unfiltered.targetBoard) {
        failClosed(unfiltered.resolution.kind === "AMBIGUOUS"
          ? "最新房态存在多个相互冲突的住宿位置，订单详情已安全关闭。请刷新后重新核对。"
          : "原先选中的住宿已不在最新房态中，订单详情已安全关闭。请按最新房态重新选择。");
        return;
      }
      const targetRoom = unfiltered.targetBoard.rooms.find((room) => (
        room.id === unfiltered.resolution.identity.unitId
        || room.children.some((child) => child.id === unfiltered.resolution.identity.unitId)
      ));
      if (!targetRoom) throw new Error("定位换房结果时无法确认目标房源");
      const relaxedFilters = roomStatusFiltersRevealingTarget(viewState.filters, (candidate) => (
        filterRoomStatusRooms([targetRoom], candidate).some(({ room, children }) => (
          room.id === unfiltered.resolution.identity.unitId
          || children.some((child) => child.id === unfiltered.resolution.identity.unitId)
        ))
      ));
      const finalBoards = sameFilters(relaxedFilters, DEFAULT_ROOM_STATUS_FILTERS)
        ? unfilteredBoards
        : await loadPageSet(relaxedFilters);
      if (!current) return;
      const final = resolveOnBoards(finalBoards);
      if (final.resolution.kind !== "MATCH" || !final.targetBoard) {
        throw new Error("清除遮挡筛选后房态记录发生变化，未改写当前订单详情");
      }
      applyMovedStay(final.resolution.identity, final.targetBoard, relaxedFilters);
    };
    void findMovedStay().catch((error: unknown) => {
      if (!current) return;
      setActionError(error);
      setReturnNotice("房态数据已变化，但暂时无法核对该住宿是否移动到其他房源页；订单详情保持打开，请刷新后重试。");
    });
    return () => { current = false; };
  }, [
    boardMatchesCurrentQuery,
    command,
    meta.inventoryUnits,
    propertyId,
    range.arrivalDate,
    range.departureDate,
    renderedBoard,
    selectedDayDate,
    selectedOrderIdentity,
    viewState.expandedRoomIds,
    viewState.filters.kind,
    viewState.filters.minimumCapacity,
    viewState.filters.roomTypeCode,
    viewState.filters.salesMode,
    viewState.filters.search,
    viewState.filters.status
  ]);
  const policies = meta.pricingPolicyVersions.filter((policy) => policy.property_id === propertyId && policy.status === "PUBLISHED");
  const filterOptions = renderedBoard?.filterOptions ?? {
    roomTypeCodes: [],
    salesModes: [],
    statuses: [],
    capacities: []
  };
  const todayDate = localDateInTimeZone(propertyTimezone);
  const mobileGroups = useMemo(() => renderedBoard ? buildMobileGroups(renderedBoard) : { arrivals: [], inHouse: [], departures: [], exceptions: [] }, [renderedBoard]);
  const activeMobileTasks = mobileTab === "ARRIVALS"
    ? mobileGroups.arrivals
    : mobileTab === "IN_HOUSE"
      ? mobileGroups.inHouse
      : mobileTab === "DEPARTURES"
      ? mobileGroups.departures
      : mobileGroups.exceptions;
  const quoteRecoveryUiOpen = quoteRecoveryContextOpen;
  const activeQuoteTargetSource = quoteRecoveryUiOpen ? recoveryQuoteTarget ?? quoteTarget : quoteTarget;
  const activeQuoteTarget = activeQuoteTargetSource
    ? roomStatusQuoteTargetForBusinessDate(activeQuoteTargetSource, renderedBoard?.businessDate ?? todayDate)
    : undefined;
  const quoteUnit = findRoomStatusUnit(renderedBoard, activeQuoteTarget?.unitId);
  const showQuoteWorkbench = quoteRecoveryUiOpen || Boolean(activeQuoteTarget);
  const activeQuoteAuthorizedAction = activeQuoteTarget && renderedBoard
    ? roomStatusAuthorizedQuoteAction(quoteUnit, activeQuoteTarget, renderedBoard.businessDate)
    : undefined;
  const quoteWorkbenchBlocked = commandsBlocked || !activeQuoteAuthorizedAction;
  const quoteActionUnit = activeQuoteTarget && quoteUnit
    ? actionUnit(quoteUnit, projectionWritable && Boolean(activeQuoteAuthorizedAction))
    : undefined;
  const recoveryQuoteInputForWorkbench = pageQuoteRecovery.kind === "VALID"
    && roomStatusQuoteRecoveryMatchesTarget(
      pageQuoteRecovery.pending.state,
      recoveryQuoteTarget,
      activeQuoteTarget
    )
    ? pageQuoteRecovery.pending.input
    : undefined;
  const quoteRecoveryDrawerOpen = quoteRecoveryUiOpen;
  const desktopContextKind = roomStatusDesktopContextKind(quoteRecoveryDrawerOpen, Boolean(selectedOrderIdentity));
  const desktopDrawerModal = desktopContextKind === "QUOTE_RECOVERY"
    || (desktopContextKind === "SELECTION" && showQuoteWorkbench);
  const desktopDrawerInstanceKey = desktopDrawerModal ? "room-status-write" : "room-status-view";
  const desktopQuoteDrawerTitle = quoteRecoveryDrawerOpen
    ? "报价恢复"
    : activeQuoteTarget?.actionCode === "BACKFILL_ORDER"
      ? "补录住宿"
      : activeQuoteTarget?.actionCode === "CREATE_FREE_STAY" || activeQuoteTarget?.initialStayType === "FREE"
        ? "免费入住"
        : "创建订单";
  const desktopDrawerTitle = desktopContextKind === "QUOTE_RECOVERY" || (desktopContextKind === "SELECTION" && showQuoteWorkbench)
    ? desktopQuoteDrawerTitle
    : desktopContextKind === "ORDER"
      ? "订单详情"
      : "选中对象上下文";

  useEffect(() => {
    const deferred = deferredMaintenanceIntentRef.current;
    if (!deferred || !roomStatusDeferredMaintenanceReady({
      deferredSubmissionIdentity: deferred.submissionIdentity,
      activeSubmissionIdentity: activeQuoteSubmissionIdentityRef.current,
      quoteRecoveryKind: pageQuoteRecovery.kind
    })) return;
    deferredMaintenanceIntentRef.current = undefined;
    dispatchView({ type: "SET_SELECTION", selection: deferred.selection });
    setSelectedUnitId(deferred.unit.id);
    setSelectedDayDate(undefined);
    setSelectedIntervalId(undefined);
    setQuoteTarget(undefined);
    setMaintenanceTarget(deferred.unit);
  }, [activeQuoteSubmissionIdentity, pageQuoteRecovery.kind]);

  useEffect(() => {
    if (!quoteTarget || pageQuoteRecovery.kind !== "ABSENT" || !projectionWritable) return;
    if (activeQuoteTarget && activeQuoteAuthorizedAction) return;
    setQuoteTarget(undefined);
    setActionError(new Error("当前选区已被占用、超出本阶段补录范围，或服务端已撤销原办理动作；住宿表单已关闭，请重新选择。"));
  }, [activeQuoteAuthorizedAction, activeQuoteTarget, pageQuoteRecovery.kind, projectionWritable, quoteTarget]);

  function clearTransientRoomStatusContext() {
    cancelQuoteSectionScroll();
    deferredMaintenanceIntentRef.current = undefined;
    returnedOrderCellFocus.current = undefined;
    setQuickPopoverTarget(undefined);
    setSelectedUnitId(undefined);
    setSelectedDayDate(undefined);
    setSelectedIntervalId(undefined);
    setSelectedGridStayId(undefined);
    setSelectedOrderIdentity(undefined);
    setSelectedOrderView(undefined);
    setSelectedCorrectionOccupantId(undefined);
    setOrderContextOpen(false);
    setDesktopContextCollapsed(true);
    setQuoteRecoveryContextOpen(false);
    setQuoteTarget(undefined);
    setSelectionDraftValid(true);
    setMaintenanceTarget(undefined);
    setCreateSelectionOpen(false);
    setActionError(undefined);
    setQuoteRecoveryOutcome(undefined);
  }

  function applyFilters(filters: typeof viewState.filters) {
    dispatchView({ type: "SET_FILTERS", filters });
    dispatchView({ type: "SET_ROOM_PAGE", index: 0, totalPages: board?.page.totalPages ?? 1 });
    clearTransientRoomStatusContext();
  }

  function clearFilters() {
    dispatchView({ type: "CLEAR_FILTERS" });
    dispatchView({ type: "SET_ROOM_PAGE", index: 0, totalPages: board?.page.totalPages ?? 1 });
    clearTransientRoomStatusContext();
    setFilterFocusRequestToken((value) => value + 1);
  }

  function applyRange(next: RoomStatusRange) {
    if (!isIsoLocalDate(next.arrivalDate) || !isIsoLocalDate(next.departureDate)) {
      setRangeError(new Error("请输入有效的开始日期和结束日期。"));
      return;
    }
    const nights = rangeNights(next);
    if (nights < 1) {
      setRangeError(new Error("结束日期必须晚于开始日期。"));
      return;
    }
    if (nights > ROOM_STATUS_TIMELINE_DAYS) {
      setRangeError(new Error(`房态首页每次显示 ${ROOM_STATUS_TIMELINE_DAYS} 夜。要建立更长住宿，请在右侧日期选区里填写完整入住和退房日期。`));
      return;
    }
    setRangeError(undefined);
    setRange(next);
    dispatchView({ type: "SET_ROOM_PAGE", index: 0, totalPages: 1 });
    dispatchView({ type: "SET_DATE_WINDOW", start: 0, totalDates: nights });
    dispatchView({ type: "SET_FOCUS", focus: null });
    clearTransientRoomStatusContext();
  }

  function shiftRange(direction: -1 | 1) {
    const nights = ROOM_STATUS_TIMELINE_DAYS;
    applyRange({
      arrivalDate: addLocalDateDays(range.arrivalDate, direction * nights),
      departureDate: addLocalDateDays(range.departureDate, direction * nights)
    });
  }

  function changeRoomPage(index: number, totalPages: number) {
    dispatchView({ type: "SET_ROOM_PAGE", index, totalPages });
    dispatchView({ type: "SET_SELECTION", selection: null });
    dispatchView({ type: "SET_FOCUS", focus: null });
    clearTransientRoomStatusContext();
  }

  function changeDateWindow(start: number, totalDates: number) {
    dispatchView({ type: "SET_DATE_WINDOW", start, totalDates });
    dispatchView({ type: "SET_SELECTION", selection: null });
    dispatchView({ type: "SET_FOCUS", focus: null });
    clearTransientRoomStatusContext();
  }

  function persistViewNow() {
    if (!board || !boardMatchesCurrentQuery) return;
    writeRoomStatusRestoration(principal.subjectId, {
      version: 1,
      propertyId,
      revision: board.revision,
      range,
      savedAt: new Date().toISOString(),
      state: viewState,
      factFingerprint: roomStatusFactFingerprint(board.rooms, viewState)
    });
  }

  function captureRoomStatusInteraction(
    anchor: HTMLElement,
    selection: RoomStatusSelection | null = viewState.selection
  ) {
    const cell = anchor.closest<HTMLElement>("[data-room-status-cell='true']");
    const unitId = cell?.dataset.unitId;
    const serviceDate = cell?.dataset.serviceDate;
    const grid = anchor.closest<HTMLElement>(".room-status-grid-scroll");
    roomStatusInteractionSnapshotRef.current = {
      anchor,
      selection: selection ? { ...selection } : null,
      focusedCell: unitId && serviceDate
        ? { unitId, serviceDate }
        : viewState.focusedCell ? { ...viewState.focusedCell } : null,
      windowX: window.scrollX,
      windowY: window.scrollY,
      grid,
      gridLeft: grid?.scrollLeft ?? 0,
      gridTop: grid?.scrollTop ?? 0
    };
  }

  function restoreRoomStatusInteraction() {
    const snapshot = roomStatusInteractionSnapshotRef.current;
    roomStatusInteractionSnapshotRef.current = undefined;
    if (!snapshot) {
      setFocusRequestToken((value) => value + 1);
      return;
    }
    dispatchView({ type: "SET_SELECTION", selection: snapshot.selection });
    dispatchView({ type: "SET_FOCUS", focus: snapshot.focusedCell });
    requestAnimationFrame(() => {
      snapshot.grid?.scrollTo({ left: snapshot.gridLeft, top: snapshot.gridTop, behavior: "auto" });
      window.scrollTo({ left: snapshot.windowX, top: snapshot.windowY, behavior: "auto" });
      if (snapshot.anchor.isConnected) {
        snapshot.anchor.focus({ preventScroll: true });
      } else {
        setFocusRequestToken((value) => value + 1);
      }
      requestAnimationFrame(() => {
        snapshot.grid?.scrollTo({ left: snapshot.gridLeft, top: snapshot.gridTop, behavior: "auto" });
        window.scrollTo({ left: snapshot.windowX, top: snapshot.windowY, behavior: "auto" });
      });
    });
  }

  function invalidateSelectedOrderForRoomStatusInspection() {
    returnedOrderCellFocus.current = undefined;
    setSelectedOrderIdentity(undefined);
    setSelectedOrderView(undefined);
    selectedMemberRequestGuard.invalidate();
    setSelectedMemberView(undefined);
    setSelectedOrderLoadedScope(undefined);
    setSelectedOrderError(undefined);
    setSelectedOrderLoading(false);
    setSelectedCorrectionOccupantId(undefined);
    setSelectedCorrectionRevision(undefined);
    setSelectedStayDateAction(undefined);
    setSelectedStayDateMode("DATE_CHANGE");
    setSelectedStayDateRevision(undefined);
    setSelectedOrderCommandScope(undefined);
    setCommandDraft(undefined);
    setPendingOrderContextIdentity(undefined);
    setOrderContextOpen(false);
    setDesktopContextCollapsed(true);
  }

  function inspectUnit(unit: RoomStatusUnitDto) {
    setQuickPopoverTarget(undefined);
    setQuoteRecoveryOutcome(undefined);
    invalidateSelectedOrderForRoomStatusInspection();
    setSelectedUnitId(unit.id);
    setSelectedDayDate(undefined);
    setSelectedIntervalId(undefined);
    setSelectedGridStayId(undefined);
    setDesktopContextCollapsed(false);
  }

  function selectOrderContextIdentity(
    identity: RoomStatusOrderIdentity,
    serviceDate?: string,
    openContext = true
  ) {
    setQuickPopoverTarget(undefined);
    const sameOrder = selectedOrderIdentity?.orderId === identity.orderId
      && selectedOrderIdentity.stayId === identity.stayId;
    const identityKey = roomStatusOrderIdentityKey(identity);
    const canOpenFromLoadedView = sameOrder && Boolean(authorizedSelectedOrderView);
    const deferDrawerOpen = openContext && !isMobile && !useInlineOrderContext && !canOpenFromLoadedView;
    setActionError(undefined);
    setSelectedUnitId(identity.unitId);
    setSelectedDayDate(serviceDate);
    setSelectedIntervalId(identity.intervalId);
    setSelectedGridStayId(identity.stayId);
    setSelectedOrderIdentity(identity);
    if (!sameOrder) setSelectedOrderView(undefined);
    setSelectedCorrectionOccupantId(undefined);
    setQuoteTarget(undefined);
    setPendingOrderContextIdentity(deferDrawerOpen ? identityKey : undefined);
    setOrderContextOpen(openContext && !deferDrawerOpen);
    setDesktopContextCollapsed(deferDrawerOpen || !openContext);
    const parentRoomId = meta.inventoryUnits.find((unit) => unit.id === identity.unitId)?.parent_room_id;
    if (parentRoomId && !viewState.expandedRoomIds.includes(parentRoomId)) {
      dispatchView({ type: "TOGGLE_ROOM", roomId: parentRoomId });
    }
    const requestedTriggerDate = serviceDate && identity.arrivalDate <= serviceDate && serviceDate < identity.departureDate
      ? serviceDate
      : identity.arrivalDate;
    const visibleArrivalDate = identity.arrivalDate < range.arrivalDate ? range.arrivalDate : identity.arrivalDate;
    const visibleDepartureDate = identity.departureDate > range.departureDate ? range.departureDate : identity.departureDate;
    if (visibleArrivalDate >= visibleDepartureDate) {
      dispatchView({ type: "SET_SELECTION", selection: null });
      return;
    }
    const triggerDate = requestedTriggerDate < visibleArrivalDate
      ? visibleArrivalDate
      : requestedTriggerDate >= visibleDepartureDate
        ? addLocalDateDays(visibleDepartureDate, -1)
        : requestedTriggerDate;
    dispatchView({
      type: "SET_SELECTION",
      selection: {
        unitId: identity.unitId,
        anchorDate: triggerDate,
        focusDate: triggerDate,
        arrivalDate: visibleArrivalDate,
        departureDate: visibleDepartureDate
      }
    });
  }

  function inspectDay(unit: RoomStatusUnitDto, day: RoomStatusDayDto | null, anchor: HTMLElement) {
    setQuoteRecoveryOutcome(undefined);
    setActionError(undefined);
    setReturnNotice(undefined);
    const serviceDate = day?.serviceDate ?? anchor.dataset.serviceDate;
    if (!serviceDate) {
      setActionError(new Error("当前房态格缺少营业日期，未打开快捷操作。请刷新后重试。"));
      return;
    }
    const triggerSelection = selectionFromCells(unit.id, serviceDate, serviceDate);
    const identity = roomStatusOrderIdentityForDate(unit, serviceDate);
    captureRoomStatusInteraction(anchor, triggerSelection);
    dispatchView({ type: "SET_SELECTION", selection: triggerSelection });
    invalidateSelectedOrderForRoomStatusInspection();
    setSelectedUnitId(unit.id);
    setSelectedDayDate(serviceDate);
    setSelectedIntervalId(undefined);
    setSelectedGridStayId(identity?.stayId);
    setQuoteTarget(undefined);
    setQuickPopoverTarget({ unitId: unit.id, serviceDate, anchor });
  }

  function inspectInterval(unit: RoomStatusUnitDto, interval: RoomStatusIntervalDto, anchor: HTMLElement, serviceDate: string) {
    setQuoteRecoveryOutcome(undefined);
    setActionError(undefined);
    setReturnNotice(undefined);
    const triggerSelection = selectionFromCells(unit.id, serviceDate, serviceDate);
    captureRoomStatusInteraction(anchor, triggerSelection);
    dispatchView({ type: "SET_SELECTION", selection: triggerSelection });
    invalidateSelectedOrderForRoomStatusInspection();
    setSelectedUnitId(unit.id);
    setSelectedDayDate(serviceDate);
    setSelectedIntervalId(interval.id);
    setSelectedGridStayId(roomStatusOrderIdentityForInterval(interval)?.stayId);
    setQuoteTarget(undefined);
    setQuickPopoverTarget({ unitId: unit.id, serviceDate, anchor, intervalId: interval.id });
  }

  function inspectSelection(unit: RoomStatusUnitDto, selection: RoomStatusSelection, anchor: HTMLElement) {
    const serviceDate = anchor.dataset.serviceDate;
    if (selection.unitId !== unit.id
      || anchor.dataset.unitId !== unit.id
      || !serviceDate
      || serviceDate < selection.arrivalDate
      || serviceDate >= selection.departureDate) {
      setActionError(new Error("当前日期选区与触发房态格不一致，未打开快捷操作。请重新选择。"));
      return;
    }
    setQuoteRecoveryOutcome(undefined);
    setActionError(undefined);
    setReturnNotice(undefined);
    captureRoomStatusInteraction(anchor, selection);
    dispatchView({ type: "SET_SELECTION", selection });
    invalidateSelectedOrderForRoomStatusInspection();
    setSelectedUnitId(unit.id);
    setSelectedDayDate(undefined);
    setSelectedIntervalId(undefined);
    setSelectedGridStayId(undefined);
    setQuoteTarget(undefined);
    setQuickPopoverTarget({ unitId: unit.id, serviceDate, anchor, selection });
  }

  function previewSelection(selection: RoomStatusSelection | null) {
    setQuickPopoverTarget(undefined);
    setQuoteRecoveryOutcome(undefined);
    setActionError(undefined);
    invalidateSelectedOrderForRoomStatusInspection();
    setQuoteTarget(undefined);
    setSelectionDraftValid(true);
    setSelectedGridStayId(undefined);
    dispatchView({ type: "SET_SELECTION", selection });
    if (selection) {
      dispatchView({
        type: "SET_FOCUS",
        focus: roomStatusGridFocusForSelection(selection, renderedBoard?.dates ?? [])
      });
    }
    if (selection) {
      setSelectedUnitId(selection.unitId);
      setSelectedDayDate(undefined);
      setSelectedIntervalId(undefined);
    }
  }

  function selectRange(selection: RoomStatusSelection | null) {
    cancelQuoteSectionScroll();
    setQuickPopoverTarget(undefined);
    setQuoteRecoveryOutcome(undefined);
    invalidateSelectedOrderForRoomStatusInspection();
    setSelectedGridStayId(undefined);
    dispatchView({ type: "SET_SELECTION", selection });
    if (selection) {
      dispatchView({
        type: "SET_FOCUS",
        focus: roomStatusGridFocusForSelection(selection, renderedBoard?.dates ?? [])
      });
    }
    if (selection) {
      setSelectionDraftValid(true);
      setDesktopContextCollapsed(false);
      setSelectedUnitId(selection.unitId);
      const nextQuoteTarget = updateRoomStatusQuoteTargetSelection(
        quoteTarget,
        findRoomStatusUnit(renderedBoard, selection.unitId),
        selection,
        renderedBoard?.businessDate ?? todayDate
      );
      setQuoteTarget(nextQuoteTarget);
      if (quoteTarget && !nextQuoteTarget) {
        setActionError(new Error("修改后的房源或日期不再有服务端授权的住宿办理动作，原住宿表单已关闭。"));
      }
    } else if (quoteTarget) {
      setDesktopContextCollapsed(false);
    }
    setSelectedDayDate(undefined);
    setSelectedIntervalId(undefined);
  }

  function openReference(reference: { href: string | null }) {
    if (!reference.href) return;
    persistViewNow();
    if (reference.href.startsWith("/orders/")) {
      const state = selectedOrderIdentity && reference.href === `/orders/${selectedOrderIdentity.orderId}`
        ? createRoomStatusOrderReturnState(
            propertyId,
            selectedOrderIdentity,
            selectedDayDate ?? viewState.selection?.anchorDate
          )
        : { fromRoomStatus: true };
      navigate(reference.href, { state });
    }
    else window.open(reference.href, "_blank", "noopener,noreferrer");
  }

  function openSelectedOrder(actionCode?: string) {
    if (!selectedOrderIdentity) return;
    persistViewNow();
    const query = actionCode ? `?action=${encodeURIComponent(actionCode)}` : "";
    navigate(`/orders/${encodeURIComponent(selectedOrderIdentity.orderId)}${query}`, {
      state: createRoomStatusOrderReturnState(
        propertyId,
        selectedOrderIdentity,
        selectedDayDate ?? viewState.selection?.anchorDate
      )
    });
  }

  function startSelectedOrderFulfillment(commandType: "CHECK_IN" | "CHECK_OUT") {
    setActionError(undefined);
    const view = authorizedSelectedOrderView;
    const identity = selectedOrderIdentity;
    const action = view?.allowedActions.find((candidate) => candidate.code === commandType);
    if (!view || !identity || view.order.id !== identity.orderId || view.stay.id !== identity.stayId) {
      setActionError(new Error("当前订单详情与房态住宿记录不一致，未发送办理命令。请重新选择住宿后再试。"));
      return;
    }
    if (commandsBlocked || view.accessLevel !== "WRITE") {
      setActionError(new Error("当前房态或订单权限不允许写入，未发送办理命令。请刷新后重新核对。"));
      return;
    }
    if (!action?.enabled) {
      setActionError(new Error("服务端当前未允许这项办理操作，未发送命令。请刷新订单状态后重新核对。"));
      return;
    }
    const started = startCommand({
      commandType,
      title: commandType === "CHECK_IN" ? "办理入住" : "办理退房",
      description: commandType === "CHECK_IN"
        ? "核对后将住宿状态更新为在住；会员住宿会同时核销本次仍冻结的权益。"
        : "核对后将住宿状态更新为已退房并释放后续住宿库存；退房不会重复核销会员权益。",
      presentation: "FULFILLMENT",
      input: { propertyId: view.order.property_id, orderId: view.order.id }
    }, roomStatusOrderCommandScope(orderPrincipalScope, identity));
    if (!started) setSelectedOrderCommandScope(undefined);
  }

  function startSelectedOrderDateAction(commandType: StayDateChangeAction, mode: StayDateChangeMode = "DATE_CHANGE") {
    setActionError(undefined);
    const view = authorizedSelectedOrderView;
    const identity = selectedOrderIdentity;
    const action = view?.allowedActions.find((candidate) => candidate.code === commandType);
    if (!view || !identity || view.order.id !== identity.orderId || view.stay.id !== identity.stayId) {
      setActionError(new Error("当前订单详情与房态住宿记录不一致，未打开日期调整。请重新选择住宿后再试。"));
      return;
    }
    if (commandsBlocked || view.accessLevel !== "WRITE") {
      setActionError(new Error("当前房态或订单权限不允许写入，未打开日期调整。请刷新后重新核对。"));
      return;
    }
    if (!action?.enabled) {
      setActionError(new Error("服务端当前未允许这项日期调整，未发送命令。请刷新订单状态后重新核对。"));
      return;
    }
    setCommandDraft(undefined);
    setSelectedStayDateMode(mode);
    setSelectedStayDateAction(commandType);
    setSelectedStayDateRevision(boardRef.current?.revision);
    setSelectedOrderCommandScope(roomStatusOrderCommandScope(orderPrincipalScope, identity));
  }

  function startSelectedOrderMoveUnit() {
    setActionError(undefined);
    const view = authorizedSelectedOrderView;
    const identity = selectedOrderIdentity;
    const action = view?.allowedActions.find((candidate) => candidate.code === "MOVE_UNIT");
    if (!view || !identity || view.order.id !== identity.orderId || view.stay.id !== identity.stayId) {
      setActionError(new Error("当前订单详情与房态住宿记录不一致，未打开换房。请重新选择住宿后再试。"));
      return;
    }
    if (commandsBlocked || view.accessLevel !== "WRITE" || !action?.enabled) {
      setActionError(new Error("服务端当前未允许办理换房，未打开表单。请刷新订单状态后重新核对。"));
      return;
    }
    setCommandDraft(undefined);
    setSelectedMoveUnitOpen(true);
    setSelectedMoveUnitRevision(boardRef.current?.revision);
    setSelectedOrderCommandScope(roomStatusOrderCommandScope(orderPrincipalScope, identity));
  }

  function startSelectedOrderLifecycleAction(commandType: OrderLifecycleAction) {
    setActionError(undefined);
    const view = authorizedSelectedOrderView;
    const identity = selectedOrderIdentity;
    const action = view?.allowedActions.find((candidate) => candidate.code === commandType);
    if (!view || !identity || view.order.id !== identity.orderId || view.stay.id !== identity.stayId) {
      setActionError(new Error("当前订单详情与房态住宿记录不一致，未打开操作表单。请重新选择住宿后再试。"));
      return;
    }
    if (commandsBlocked || view.accessLevel !== "WRITE" || !action?.enabled) {
      setActionError(new Error("服务端当前未允许这项订单操作，未打开表单。请刷新订单状态后重新核对。"));
      return;
    }
    setCommandDraft(undefined);
    setSelectedLifecycleAction(commandType);
    setSelectedLifecycleRevision(boardRef.current?.revision);
    setSelectedOrderCommandScope(roomStatusOrderCommandScope(orderPrincipalScope, identity));
  }

  function closeSelectedOrderContext() {
    cancelQuoteSectionScroll();
    returnedOrderCellFocus.current = undefined;
    setSelectedCorrectionOccupantId(undefined);
    setPendingOrderContextIdentity(undefined);
    setOrderContextOpen(false);
    setDesktopContextCollapsed(true);
    restoreRoomStatusInteraction();
  }

  function closeDesktopContext() {
    cancelQuoteSectionScroll();
    deferredMaintenanceIntentRef.current = undefined;
    if (quoteRecoveryDrawerOpen) {
      if (currentQuoteRecoveryIdentity) browserDismissedQuoteRecoveryIdentities.add(currentQuoteRecoveryIdentity);
      setDismissedQuoteRecoveryIdentity(currentQuoteRecoveryIdentity);
      setQuoteRecoveryContextOpen(false);
      if (pageQuoteRecovery.kind === "ABSENT") setQuoteTarget(undefined);
      setDesktopContextCollapsed(true);
      restoreRoomStatusInteraction();
      return;
    }
    returnedOrderCellFocus.current = undefined;
    setDesktopContextCollapsed(true);
    if (selectedOrderIdentity) {
      setPendingOrderContextIdentity(undefined);
      setOrderContextOpen(false);
    }
    restoreRoomStatusInteraction();
  }

  function reopenDesktopContext() {
    if (pageQuoteRecovery.kind !== "ABSENT") {
      openQuoteRecoveryContext();
      return;
    }
    setDesktopContextCollapsed(false);
    if (selectedOrderIdentity) {
      dispatchView({ type: "SET_SELECTION", selection: null });
      setOrderContextOpen(true);
    }
  }

  function openQuoteRecoveryContext() {
    cancelQuoteSectionScroll();
    setQuickPopoverTarget(undefined);
    setCreateSelectionOpen(false);
    setPendingOrderContextIdentity(undefined);
    setOrderContextOpen(false);
    if (currentQuoteRecoveryIdentity) browserDismissedQuoteRecoveryIdentities.delete(currentQuoteRecoveryIdentity);
    setDismissedQuoteRecoveryIdentity(undefined);
    setQuoteRecoveryContextOpen(true);
    setDesktopContextCollapsed(false);
    scheduleQuoteSectionScroll();
  }

  function openRoomStatusRecoveryEntry() {
    if (commandRecovery.pending) {
      openRecoveryDialog();
      return;
    }
    if (pageQuoteRecovery.kind !== "ABSENT") {
      openQuoteRecoveryContext();
      return;
    }
    const notice = document.querySelector<HTMLElement>("[data-testid='inventory-damaged-command-recovery']");
    notice?.scrollIntoView({ block: "start", behavior: "smooth" });
    notice?.querySelector<HTMLElement>("input, button")?.focus({ preventScroll: true });
  }

  function closeQuoteWorkbench() {
    cancelQuoteSectionScroll();
    deferredMaintenanceIntentRef.current = undefined;
    if (quoteRecoveryContextOpen || pageQuoteRecovery.kind !== "ABSENT") {
      if (currentQuoteRecoveryIdentity) browserDismissedQuoteRecoveryIdentities.add(currentQuoteRecoveryIdentity);
      setDismissedQuoteRecoveryIdentity(currentQuoteRecoveryIdentity);
      setQuoteRecoveryContextOpen(false);
      if (pageQuoteRecovery.kind === "ABSENT") setQuoteTarget(undefined);
      setDesktopContextCollapsed(true);
      restoreRoomStatusInteraction();
      return;
    }
    setQuoteTarget(undefined);
  }

  async function locateOrderRange(target: { inventoryUnitId: string; arrivalDate: string; departureDate: string }) {
    if (!renderedBoard) return;
    const visibleArrivalDate = target.arrivalDate < range.arrivalDate ? range.arrivalDate : target.arrivalDate;
    const visibleDepartureDate = target.departureDate > range.departureDate ? range.departureDate : target.departureDate;
    if (visibleArrivalDate >= visibleDepartureDate) {
      setActionError(new Error(`该次变更位于当前日期范围之外（${target.arrivalDate} 至 ${target.departureDate}）。请先调整房态日期范围后再定位。`));
      return;
    }
    let targetPage = findRoomStatusUnit(renderedBoard, target.inventoryUnitId)
      ? renderedBoard.page.index
      : undefined;
    try {
      if (targetPage === undefined) {
        for (let pageIndex = 0; pageIndex < renderedBoard.page.totalPages; pageIndex += 1) {
          if (pageIndex === renderedBoard.page.index) continue;
          const response = await api.roomStatus(propertyId, roomStatusQuery(range, pageIndex, viewState.filters));
          assertRoomStatusBoard(response, { propertyId, range, pageIndex, allowedActions: currentPropertyAllowedActions });
          if (findRoomStatusUnit(response, target.inventoryUnitId)) {
            targetPage = pageIndex;
            break;
          }
        }
      }
      if (targetPage === undefined) {
        setActionError(new Error("该次变更对应的房源不在当前筛选结果中，未制造不可见选区。请清除筛选后重试定位。"));
        return;
      }
      if (targetPage !== renderedBoard.page.index) {
        dispatchView({ type: "SET_ROOM_PAGE", index: targetPage, totalPages: renderedBoard.page.totalPages });
      }
      const segmentUnit = meta.inventoryUnits.find((unit) => unit.id === target.inventoryUnitId);
      if (segmentUnit?.parent_room_id && !viewState.expandedRoomIds.includes(segmentUnit.parent_room_id)) {
        dispatchView({ type: "TOGGLE_ROOM", roomId: segmentUnit.parent_room_id });
      }
      dispatchView({
        type: "SET_SELECTION",
        selection: {
          unitId: target.inventoryUnitId,
          anchorDate: visibleArrivalDate,
          focusDate: visibleArrivalDate,
          arrivalDate: visibleArrivalDate,
          departureDate: visibleDepartureDate
        }
      });
      dispatchView({ type: "SET_FOCUS", focus: { unitId: target.inventoryUnitId, serviceDate: visibleArrivalDate } });
      dispatchView({
        type: "SET_DATE_WINDOW",
        start: dateWindowStartForFocus(renderedBoard.dates, viewState.dateWindowStart, viewState.dateWindowSize, visibleArrivalDate),
        totalDates: renderedBoard.dates.length
      });
      setSelectedUnitId(target.inventoryUnitId);
      setSelectedDayDate(visibleArrivalDate);
      if (!useInlineOrderContext) {
        setOrderContextOpen(false);
        setDesktopContextCollapsed(true);
      }
      setFocusRequestToken((value) => value + 1);
    } catch (error) {
      setActionError(error);
    }
  }

  function startQuoteCommand(request: CommandRequest): boolean {
    const currentBusinessDate = renderedBoard?.businessDate;
    const currentUnit = findRoomStatusUnit(renderedBoard, activeQuoteTarget?.unitId);
    const currentAuthorization = currentBusinessDate
      ? roomStatusAuthorizedQuoteAction(currentUnit, activeQuoteTarget, currentBusinessDate)
      : undefined;
    if (quoteWorkbenchBlocked
      || !principalCan(principal, propertyId, "CREATE_ORDER")
      || !currentAuthorization
      || !roomStatusQuoteCommandMatchesTarget(request, activeQuoteTarget)) {
      setActionError(new Error("当前住宿表单不再绑定有效的服务端动作，命令未发送。请刷新房态并重新选择日期。"));
      return false;
    }
    return startCommand(request);
  }

  function startCommand(request: CommandRequest, targetScope = orderPrincipalScope): boolean {
    if (!principalCan(principal, propertyId, request.commandType as CommandCapability)) {
      setActionError(new Error("当前账号已没有该命令授权；命令未发送，表单草稿保持不变。"));
      return false;
    }
    if (commandsBlocked) {
      setActionError(new Error("当前房态已陈旧、正在刷新、权限已收窄或命令恢复尚未收口；命令未发送，表单草稿保持不变。"));
      return false;
    }
    const attemptId = commandAttemptGuard.begin();
    setCommandAttemptId(attemptId);
    setCommandPhase("DRAFT");
    commandRevisionRef.current = boardRef.current?.revision;
    commandQueryKeyRef.current = boardQueryKeyRef.current;
    setCommandContextInvalidated(false);
    setRecoveryDialogOpen(false);
    setActionError(undefined);
    setCommandDraft(undefined);
    setSelectedOrderCommandScope(targetScope);
    setCommand(request);
    return true;
  }

  function handleAction(
    action: RoomStatusActionDto,
    unitOverride?: RoomStatusUnitDto | null,
    selectionOverride?: RoomStatusSelection | null,
    unitReferenceLabel?: string
  ): boolean {
    setActionError(undefined);
    if (action.code === "OPEN_ORDER") {
      if (!action.targetReference) return false;
      openReference(action.targetReference);
      return true;
    }
    const actionSelectedUnit = unitOverride === undefined ? selectedUnit : unitOverride;
    const activeQuoteIntentSwitch = activeOwnQuoteSubmissionInWorkbench
      && selectionActionCodes.has(action.code);
    if (pageQuoteRecovery.kind !== "ABSENT" && !activeQuoteIntentSwitch) {
      openQuoteRecoveryContext();
      setActionError(new Error("报价恢复记录尚未收口。请先查询原报价结果；处理完成前不能发起新的补录或其他写入。"));
      return false;
    }
    if (commandsBlocked && !activeQuoteIntentSwitch) {
      setActionError(new Error("当前房态不再满足安全写入条件。未发送命令，请刷新后重新核对选区。"));
      return false;
    }
    const selection = selectionOverride ?? viewState.selection;
    if (action.code === "CREATE_ORDER" || action.code === "CREATE_FREE_STAY" || action.code === "BACKFILL_ORDER" || action.code === "LOCK_MAINTENANCE") {
      if (!actionSelectedUnit || !selection || selection.unitId !== actionSelectedUnit.id) {
        setActionError(new Error("请选择一个完整的房源与半开日期区间"));
        return false;
      }
      const unit = actionUnit(actionSelectedUnit, true);
      if (action.code === "CREATE_ORDER" || action.code === "CREATE_FREE_STAY" || action.code === "BACKFILL_ORDER") {
        const authorizedTarget = roomStatusQuoteTargetFromAction(
          action,
          actionSelectedUnit,
          selection,
          renderedBoard?.businessDate ?? todayDate
        );
        if (!authorizedTarget) {
          setActionError(new Error("当前选区已被占用、越过本阶段允许的日期范围，或服务端已撤销该住宿办理动作；未打开表单。"));
          return false;
        }
        setQuoteRecoveryOutcome(undefined);
        deferredMaintenanceIntentRef.current = undefined;
        setQuoteTarget(authorizedTarget);
        scheduleQuoteSectionScroll();
      } else {
        const activeQuoteSubmission = activeQuoteSubmissionIdentityRef.current;
        const clearMode = roomStatusMaintenanceQuoteTargetClearMode(activeQuoteSubmission);
        if (clearMode === "IMMEDIATE") {
          deferredMaintenanceIntentRef.current = undefined;
          setQuoteTarget(undefined);
          setMaintenanceTarget(unit);
        } else if (activeQuoteSubmission) {
          deferredMaintenanceIntentRef.current = {
            submissionIdentity: activeQuoteSubmission,
            unit,
            selection: { ...selection }
          };
        }
      }
      return true;
    }
    const targetId = action.targetReference?.id;
    const unitLabel = actionSelectedUnit?.code ?? unitReferenceLabel;
    if (!targetId || !unitLabel) {
      setActionError(new Error("服务端动作缺少稳定目标引用，未发送命令"));
      return false;
    }
    if (action.code === "RELEASE_MAINTENANCE") {
      return startCommand({
        commandType: "RELEASE_MAINTENANCE",
        title: `释放维修锁 · ${unitLabel}`,
        description: "系统将重新核对完整维修锁房，确认后释放对应日期的房源库存。",
        input: { propertyId, maintenanceLockId: targetId }
      });
    } else if (currentReleaseFeatures.cleaningWorkflow && action.code === "COMPLETE_CLEANING") {
      return startCommand({
        commandType: "COMPLETE_CLEANING",
        title: `完成清洁 · ${unitLabel}`,
        description: "核对后将当前清洁任务更新为已完成；住宿历史和既有库存事实保持不变。",
        presentation: "FULFILLMENT",
        input: { propertyId, cleaningTaskId: targetId }
      });
    }
    return false;
  }

  function openRecoveryDialog() {
    if (!commandRecovery.pending || !recoveryPendingAllowed) return;
    const recoveryOrderId = commandRecovery.pending.targetRefs
      .find((reference) => reference.startsWith("orderId="))
      ?.slice("orderId=".length);
    const recoveryMatchesSelectedOrder = Boolean(
      recoveryOrderId
      && selectedOrderIdentity?.orderId === recoveryOrderId
    );
    if ((commandRecovery.pending.presentation === "FULFILLMENT" || commandRecovery.pending.presentation === "STAY_DATES" || commandRecovery.pending.presentation === "MOVE_UNIT") && !recoveryMatchesSelectedOrder) {
      setSelectedOrderIdentity(undefined);
      setSelectedOrderView(undefined);
      setSelectedOrderLoadedScope(undefined);
      setSelectedOrderError(undefined);
      setSelectedOrderLoading(false);
      setOrderContextOpen(false);
    }
    const attemptId = commandAttemptGuard.begin();
    setCommandAttemptId(attemptId);
    setCommandPhase("CONFIRMING");
    commandRevisionRef.current = boardRef.current?.revision;
    commandQueryKeyRef.current = boardQueryKeyRef.current;
    setCommandContextInvalidated(false);
    setRecoveryDialogOpen(true);
    setSelectedOrderCommandScope(recoveryMatchesSelectedOrder
      ? roomStatusOrderCommandScope(orderPrincipalScope, selectedOrderIdentity)
      : orderPrincipalScope);
    setCommand(recoveryCommandRequest(commandRecovery.pending));
  }

  async function closeCommandDialog(context?: CommandDialogCloseContext) {
    let refreshAfterClose = context?.receipt.businessCommitted === true;
    const pendingAtClose = commandRecovery.pending;
    const terminalAtClose = Boolean(context || (pendingAtClose && isTerminalCommandRecovery(pendingAtClose.state)));
    if (terminalAtClose) {
      refreshAfterClose ||= pendingAtClose?.state === "EXECUTED";
      if (refreshAfterClose && (pendingAtClose?.commandType === "CREATE_ORDER" || command?.commandType === "CREATE_ORDER")) {
        setQuoteResetToken((value) => value + 1);
        setQuoteTarget(undefined);
      }
      if (await commandRecovery.clearResolved()) setRecoveryError(undefined);
      else setRecoveryError(new Error("无法清除已收口的本地恢复记录；为避免重复库存写入，命令继续保持暂停"));
    }
    commandAttemptGuard.invalidate();
    setCommandPhase("IDLE");
    commandRevisionRef.current = undefined;
    commandQueryKeyRef.current = undefined;
    setCommand(undefined);
    setSelectedOrderCommandScope(undefined);
    setRecoveryDialogOpen(false);
    if (refreshAfterClose) {
      if (pendingMobileTaskFocus.current) {
        setMobileFocusRequest({
          ...pendingMobileTaskFocus.current,
          token: ++mobileFocusSequence.current
        });
      } else if (viewState.selection) {
        dispatchView({
          type: "SET_FOCUS",
          focus: { unitId: viewState.selection.unitId, serviceDate: viewState.selection.arrivalDate }
        });
      }
      focusAfterNextBoard.current = true;
      setRefreshToken((value) => value + 1);
    } else if (commandContextInvalidated) {
      setFocusRequestToken((value) => value + 1);
    }
    if (!pendingAtClose || terminalAtClose) pendingMobileTaskFocus.current = undefined;
    setCommandContextInvalidated(false);
  }

  function trackCommandProgress(request: CommandRequest, progress: CommandDialogProgress, attemptId: number): boolean | Promise<boolean> {
    commandAttemptGuard.runIfActive(attemptId, () => {
      if (progress.state === "PREVIEWING" || progress.state === "PREVIEWED") setCommandPhase("PREVIEW");
      else if (progress.state === "CONFIRMING" || progress.state === "UNKNOWN") setCommandPhase("CONFIRMING");
      else if (progress.state === "RESOLVED") setCommandPhase("SETTLED");
      else if (progress.state === "PREVIEW_FAILED" || progress.state === "PREVIEW_UNKNOWN" || progress.state === "FAILED_NOT_EXECUTED") setCommandPhase("DRAFT");
    });
    return commandRecovery.track(request, progress);
  }

  function returnCommandToEdit(request: CommandRequest) {
    setCommandDraft(request);
    if (request.commandType === "CANCEL_ORDER" || request.commandType === "MARK_NO_SHOW" || request.commandType === "REVOKE_CHECK_IN" || request.commandType === "REVOKE_CHECK_OUT") {
      if (authorizedSelectedOrderView) {
        setSelectedLifecycleAction(request.commandType);
        setSelectedLifecycleRevision(boardRef.current?.revision);
      }
      return;
    }
    if (request.commandType === "RESCHEDULE_STAY" || request.commandType === "EXTEND_STAY" || request.commandType === "SHORTEN_STAY") {
      if (authorizedSelectedOrderView) {
        setSelectedStayDateAction(request.commandType);
        setSelectedStayDateMode(
          authorizedSelectedOrderView.order.status === "CHECKED_IN"
            ? "ADJUST_DEPARTURE"
            : "DATE_CHANGE"
        );
        setSelectedStayDateRevision(boardRef.current?.revision);
      }
      return;
    }
    if (request.commandType === "MOVE_UNIT") {
      if (authorizedSelectedOrderView) {
        setSelectedMoveUnitOpen(true);
        setSelectedMoveUnitRevision(boardRef.current?.revision);
      }
      return;
    }
    if (request.commandType === "CORRECT_ORDER_OCCUPANT") {
      const occupantId = request.input.occupantId;
      if (typeof occupantId === "string" && authorizedSelectedOrderView?.occupants.some((occupant) => occupant.id === occupantId)) {
        setSelectedCorrectionOccupantId(occupantId);
        setSelectedCorrectionRevision(boardRef.current?.revision);
      }
    }
  }

  async function refreshCommittedRoomStatus(receipt: ReceiptDto) {
    if (!receipt.businessCommitted || refreshedReceiptIdRef.current === receipt.receiptId) return;
    setCommandPhase("SETTLED");
    const refreshPropertyId = propertyId;
    const refreshPrincipalScope = orderPrincipalScope;
    const refreshOrderIdentity = selectedOrderIdentity
      ? { ...selectedOrderIdentity }
      : undefined;
    const query = roomStatusQuery(range, viewState.roomPageIndex, viewState.filters);
    const queryKey = roomStatusQueryKey(query);
    const controller = new AbortController();
    const requestId = queryAttemptGuard.begin(controller);
    const timeout = window.setTimeout(() => {
      controller.abort(new Error("提交后的房态刷新超时"));
    }, ROOM_STATUS_QUERY_TIMEOUT_MS);
    const existing = boardRef.current;
    const sameQuery = existing?.propertyId === propertyId
      && boardQueryKeyRef.current === queryKey;
    const requestStartedAt = roomStatusFreshnessNow();
    const existingFreshnessDeadline = boardFreshnessDeadline;
    const writeContinuityExpected = Boolean(sameQuery
      && existing
      && existingFreshnessDeadline !== undefined
      && roomStatusProjectionHasWriteHeadroom(existingFreshnessDeadline, requestStartedAt));
    const recoveryHeadroomRequired = Boolean(sameQuery
      && existing
      && (continuityLostQueryKeyRef.current === queryKey || !writeContinuityExpected));
    if (lowFreshnessQueryKeyRef.current !== queryKey) {
      lowFreshnessResponseCountRef.current = 0;
      lowFreshnessQueryKeyRef.current = queryKey;
      continuityLostQueryKeyRef.current = undefined;
      clearLowFreshnessRetry();
    }
    try {
      const response = await api.roomStatus(propertyId, query, controller.signal);
      if (!roomStatusCommittedRefreshScopeIsCurrent({
        requestActive: queryAttemptGuard.isActive(requestId),
        requestAborted: controller.signal.aborted,
        capturedPropertyId: refreshPropertyId,
        currentPropertyId: currentPropertyIdRef.current,
        capturedPrincipalScope: refreshPrincipalScope,
        currentPrincipalScope: currentOrderPrincipalScopeRef.current,
        ...(refreshOrderIdentity ? { capturedOrder: refreshOrderIdentity } : {}),
        ...(currentSelectedOrderIdentityRef.current ? { currentOrder: currentSelectedOrderIdentityRef.current } : {})
      })) throw new Error("提交后的房态刷新已被新的权威查询或操作范围替代");
      assertRoomStatusBoard(response, { propertyId, range, pageIndex: viewState.roomPageIndex, allowedActions: currentPropertyAllowedActions });
      const responseReceivedAt = roomStatusFreshnessNow();
      const localFreshnessDeadline = roomStatusProjectionLocalFreshnessDeadline(response, requestStartedAt);
      const writeContinuityPreserved = !writeContinuityExpected
        || existingFreshnessDeadline !== undefined
          && roomStatusProjectionHasWriteHeadroom(existingFreshnessDeadline, responseReceivedAt);
      const admitWrites = writeContinuityPreserved && roomStatusProjectionResponseCanEnableWrites(
        localFreshnessDeadline,
        responseReceivedAt,
        recoveryHeadroomRequired ? ROOM_STATUS_RECOVERY_INSTALL_HEADROOM_MS : ROOM_STATUS_RESPONSE_INSTALL_HEADROOM_MS
      );
      setBoardWriteAdmitted(admitWrites);
      let slowReadError: Error | undefined;
      if (!admitWrites) {
        if (sameQuery && existing) continuityLostQueryKeyRef.current = queryKey;
        lowFreshnessResponseCountRef.current += 1;
        if (roomStatusLowFreshnessResponseRequiresManualRetry(lowFreshnessResponseCountRef.current)) {
          clearLowFreshnessRetry();
          slowReadError = new Error("房态响应持续过慢，无法取得足够安全的写入时间。请在网络恢复后重试刷新。");
        } else {
          scheduleLowFreshnessRetry(roomStatusStaleResponseRetryDelay(lowFreshnessResponseCountRef.current));
        }
      } else {
        lowFreshnessResponseCountRef.current = 0;
        continuityLostQueryKeyRef.current = undefined;
        clearLowFreshnessRetry();
      }
      setBoard(response);
      setBoardFreshnessDeadline(localFreshnessDeadline);
      boardRef.current = response;
      setBoardQueryKey(queryKey);
      boardQueryKeyRef.current = queryKey;
      setQueryError(slowReadError);
      setQueryPhase(slowReadError ? "ERROR" : "READY");
      setClock(responseReceivedAt);
      restoreRefreshReturnFocus();
      if (refreshOrderIdentity) {
        const orderResponse = await api.order(refreshOrderIdentity.orderId, controller.signal);
        assertOrderViewAllowedActions(orderResponse, currentPropertyAllowedActions);
        if (!roomStatusCommittedRefreshScopeIsCurrent({
          requestActive: queryAttemptGuard.isActive(requestId),
          requestAborted: controller.signal.aborted,
          capturedPropertyId: refreshPropertyId,
          currentPropertyId: currentPropertyIdRef.current,
          capturedPrincipalScope: refreshPrincipalScope,
          currentPrincipalScope: currentOrderPrincipalScopeRef.current,
          capturedOrder: refreshOrderIdentity,
          ...(currentSelectedOrderIdentityRef.current ? { currentOrder: currentSelectedOrderIdentityRef.current } : {})
        })) throw new Error("提交后的订单刷新已被新的权威查询或操作范围替代");
        if (orderResponse.order.id !== refreshOrderIdentity.orderId
          || orderResponse.order.property_id !== refreshPropertyId
          || orderResponse.stay.id !== refreshOrderIdentity.stayId) {
          throw new Error("刷新后的订单详情与当前房态记录不一致");
        }
        setSelectedOrderView(orderResponse);
        setSelectedOrderLoadedScope(orderPrincipalScope);
        const effective = orderResponse.effectiveArrangement;
        const triggerDate = selectedDayDate
          && effective.arrivalDate <= selectedDayDate
          && selectedDayDate < effective.departureDate
          ? selectedDayDate
          : effective.arrivalDate;
        const refreshedIdentity = resolveRoomStatusOrderReturnTarget(
          response.rooms.flatMap((room) => [room, ...room.children]),
          { orderId: refreshOrderIdentity.orderId, stayId: refreshOrderIdentity.stayId, triggerDate }
        );
        if (refreshedIdentity.kind === "AMBIGUOUS") {
          throw new Error("刷新后的房态存在多个相互冲突的住宿位置，无法安全恢复选择");
        }
        setSelectedDayDate(triggerDate);
        if (refreshedIdentity.kind === "MATCH") {
          selectOrderContextIdentity(refreshedIdentity.identity, triggerDate, orderContextOpen);
          returnedOrderCellFocus.current = { unitId: refreshedIdentity.identity.unitId, serviceDate: triggerDate };
          setFocusRequestToken((value) => value + 1);
        }
      }
      refreshedReceiptIdRef.current = receipt.receiptId;
    } finally {
      window.clearTimeout(timeout);
      if (queryAttemptGuard.finish(requestId)) setQuerySettledToken((value) => value + 1);
    }
  }

  const roomStatusToolbar = renderedBoard ? (
    <RoomStatusToolbar
      filters={viewState.filters}
      filterOptions={{ ...filterOptions, roomTypeLabels: Object.fromEntries([
        ...meta.inventoryUnits.filter((unit) => unit.property_id === propertyId && unit.kind === "ROOM" && unit.room_type_code)
          .map((unit) => [unit.room_type_code!, roomStatusUnitDescription({ ...unit, buildingCode: unit.building_code, roomTypeCode: unit.room_type_code })]),
        ...(renderedBoard?.rooms ?? []).filter((unit) => unit.roomTypeCode)
          .map((unit) => [unit.roomTypeCode!, roomStatusUnitDescription(unit)])
      ]) }}
      focusSearchRequestToken={filterFocusRequestToken}
      actions={!isMobile && currentPropertyAllowedActions.has("CREATE_ORDER") ? <>
        <button type="button" className="button button-primary" onClick={() => setCreateSelectionOpen(true)} disabled={!renderedBoard || commandsBlocked}>新建住宿</button>
        <button type="button" className="button button-secondary" onClick={requestRoomStatusRefresh} disabled={queryBusy}><RefreshCw aria-hidden="true" className={queryBusy ? "spin" : undefined} size={16} />{queryBusy ? "正在刷新" : "刷新房态"}</button>
      </> : null}
      onFiltersChange={applyFilters}
      onClearFilters={clearFilters}
    />
  ) : null;

  const selectedOrderContext = selectedOrderIdentity ? (
    authorizedSelectedOrderView ? (
      <RoomStatusOrderContext
        view={authorizedSelectedOrderView}
        units={orderContextInventoryUnits(meta.inventoryUnits, authorizedSelectedOrderView.referencedInventoryUnits)}
        {...(selectedMemberView ? { memberView: selectedMemberView } : {})}
        loading={false}
        writeBlocked={selectedOrderLoading || commandsBlocked || authorizedSelectedOrderView.accessLevel !== "WRITE"}
        primaryActionPlacement={isMobile || !useInlineOrderContext ? "DRAWER_FOOTER" : "CONTENT"}
        onClose={closeSelectedOrderContext}
        onOpenOrder={openSelectedOrder}
        onOpenMember={({ memberId, contractId }) => navigate(`/members?memberId=${encodeURIComponent(memberId)}&contractId=${encodeURIComponent(contractId)}`)}
        onFulfillmentAction={startSelectedOrderFulfillment}
        onLifecycleAction={startSelectedOrderLifecycleAction}
        onDateAction={startSelectedOrderDateAction}
        onMoveUnit={startSelectedOrderMoveUnit}
        onCorrectOccupant={(occupant) => {
          setCommandDraft(undefined);
          setSelectedCorrectionOccupantId(occupant.id);
          setSelectedCorrectionRevision(board?.revision);
        }}
        onLocateRange={(target) => { void locateOrderRange(target); }}
      />
    ) : (
      <aside className="room-status-context room-status-order-context" aria-label="订单详情">
        <header className="room-status-context-header"><div><span>订单概览</span><h2>订单详情</h2></div><button type="button" className="room-status-icon-button" onClick={closeSelectedOrderContext} aria-label="关闭订单详情" title="关闭订单详情"><X aria-hidden="true" size={17} /></button></header>
        {selectedOrderLoading || !selectedOrderError ? <LoadingBlock label="正在载入订单详情" /> : <InlineError error={selectedOrderError} title="订单详情不可用" />}
      </aside>
    )
  ) : null;

  const desktopQuoteContext = renderedBoard && showQuoteWorkbench ? (
    <div className="room-status-quote-section" ref={quoteSectionRef} key="quote-workbench">
      <QuoteWorkbench
        unit={quoteActionUnit}
        arrivalDate={activeQuoteTarget?.arrivalDate ?? range.arrivalDate}
        departureDate={activeQuoteTarget?.departureDate ?? range.departureDate}
        businessDate={renderedBoard.businessDate}
        policies={policies}
        {...(recoveryQuoteInputForWorkbench ? { recoveryQuoteInput: recoveryQuoteInputForWorkbench } : {})}
        {...(activeQuoteTarget ? { initialStayType: activeQuoteTarget.initialStayType } : {})}
        {...(initialMemberId ? { initialMemberId } : {})}
        {...(activeQuoteTarget?.actionCode ? { quoteActionCode: activeQuoteTarget.actionCode } : {})}
        backfill={activeQuoteTarget?.actionCode === "BACKFILL_ORDER"}
        commandsBlocked={quoteWorkbenchBlocked}
        selectionDraftValid={selectionDraftValid}
        resetToken={quoteResetToken}
        autoResolvedRecoveryIdentities={autoResolvedQuoteRecoveryIdentities}
        onClose={closeQuoteWorkbench}
        onRecoveryOutcome={setQuoteRecoveryOutcome}
        onRecoveryStateChange={() => {
          if (recoveryQuoteTarget) {
            setQuoteTarget((current) => roomStatusQuoteTargetsEqual(current, recoveryQuoteTarget) ? current : recoveryQuoteTarget);
          }
          setPageQuoteRecoveryRevision((revision) => revision + 1);
        }}
        onQuoteSubmissionActivity={trackQuoteSubmissionActivity}
        onCommand={startQuoteCommand}
      />
    </div>
  ) : null;

  const desktopSelectionContext = renderedBoard ? (
    <RoomStatusContext
      key="room-status-context"
      board={renderedBoard}
      selectedUnit={selectedUnit}
      selectedDay={selectedDay}
      selectedInterval={selectedInterval}
      relatedIntervals={relatedIntervals}
      selection={viewState.selection}
      conflicts={contextConflicts}
      allowedActions={contextActions}
      {...(controlWriteBlock ? { writeBlock: controlWriteBlock } : {})}
      onSelectedUnitChange={inspectUnit}
      onSelectionChange={selectRange}
      onDraftValidityChange={setSelectionDraftValid}
      onOpenReference={openReference}
      onOpenReceipt={(receiptId) => window.open(`/api/v1/receipts/${encodeURIComponent(receiptId)}`, "_blank", "noopener,noreferrer")}
      onAction={handleAction}
      onRefresh={requestRoomStatusRefresh}
      onOpenRecovery={openRoomStatusRecoveryEntry}
      {...(useInlineOrderContext ? { onClose: closeDesktopContext } : {})}
    />
  ) : null;

  const desktopContextDrawerOpen = Boolean(renderedBoard
    && !command
    && !isMobile
    && !desktopContextCollapsed
    && !useInlineOrderContext
    && (selectedUnit || selectedOrderIdentity || viewState.selection || showQuoteWorkbench)
    && (!selectedOrderIdentity || orderContextOpen || quoteRecoveryDrawerOpen));
  const detachedQuoteRecoveryWorkbenchOpen = queryPhase !== "PERMISSION_DENIED"
    && shouldRenderDetachedQuoteRecoveryWorkbench(Boolean(renderedBoard), quoteRecoveryContextOpen, pageQuoteRecovery);
  const createEntryHandled = useRef("");
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get("createStay") !== "1" || params.get("propertyId") !== propertyId || !renderedBoard || commandsBlocked) return;
    const key = `${location.key}:${propertyId}`;
    if (createEntryHandled.current === key) return;
    createEntryHandled.current = key;
    setCreateSelectionOpen(true);
    params.delete("createStay");
    navigate({ pathname: "/", search: params.toString() }, { replace: true });
  }, [location.key, location.search, propertyId, renderedBoard, commandsBlocked, navigate]);

  const roomStatusBlockingModalOpen = Boolean(
    (desktopContextDrawerOpen && desktopDrawerModal)
    || (isMobile && selectedOrderIdentity && orderContextOpen)
    || createSelectionOpen
    || detachedQuoteRecoveryWorkbenchOpen
    || (maintenanceTarget && viewState.selection && !command)
    || (authorizedSelectedOrderView && selectedCorrectionOccupant)
    || (authorizedSelectedOrderView && selectedStayDateAction)
    || (authorizedSelectedOrderView && selectedMoveUnitOpen)
    || (authorizedSelectedOrderView && selectedLifecycleAction)
    || (command && commandTargetScopeCurrent)
  );
  const roomStatusRefreshNotice = renderedBoard && (actionPresentationBlock?.kind === "REFRESH" || !boardWriteAdmitted || boardExpired) ? (
    <div className={`room-status-stale-notice${boardRefreshFailed ? " is-failed" : ""}`} role="status" aria-live="polite" data-testid="room-status-stale-notice">
      <AlertTriangle className="room-status-stale-icon" aria-hidden="true" size={16} />
      <span className="room-status-stale-copy">
        <strong>{boardRefreshFailed ? "房态暂时未更新" : "房态正在更新"}</strong>
        <span>
          当前显示 <time dateTime={renderedBoard.asOf}>{new Date(renderedBoard.asOf).toLocaleString("zh-CN", { hour12: false })}</time> 的结果。
          {boardRefreshFailed ? "正在自动重试，恢复前不能发起写入。" : "更新完成前不能发起写入。"}
        </span>
      </span>
      {actionPresentationBlock?.actionLabel
        ? <button
            type="button"
            className="icon-button room-status-stale-retry"
            onPointerDown={() => rememberRefreshReturnFocus(document.activeElement)}
            onFocus={(event) => rememberRefreshReturnFocus(event.relatedTarget)}
            onClick={requestRoomStatusRefresh}
            aria-label="立即重试房态"
            title="立即重试房态"
          ><RefreshCw aria-hidden="true" size={16} /></button>
        : null}
    </div>
  ) : null;

  return (
    <ModalNoticeProvider notice={roomStatusBlockingModalOpen ? roomStatusRefreshNotice : null}>
    <div className="inventory-page room-status-page">
      <h1 className="sr-only">房态运营</h1>
      {initialMemberId ? <div className="room-status-return-notice" role="status">
        {requestedMemberLookup.loading ? "正在核对会员资料…" : requestedMemberLookup.error ? "会员资料读取失败，请返回会员档案重试。" : requestedMember ? requestedMemberHasContract ? `正在为 ${requestedMember.nickname || requestedMember.full_name} 安排住宿。请选择日期与可用房间，系统将在核对时检查会员权益。` : "该会员尚无本店住宿合同，请先返回会员档案办理并生效会员订单。" : "该会员没有本店住宿合同，或档案已不可用，请返回会员页核对。"}
        <button type="button" className="button button-secondary button-small" onClick={() => navigate(`/members?memberId=${encodeURIComponent(initialMemberId)}`)}>返回会员档案</button>
      </div> : null}
      {queryPhase !== "PERMISSION_DENIED" ? <InlineError error={recoveryError} title="恢复记录未收口" /> : null}
      {queryPhase !== "PERMISSION_DENIED" && commandRecovery.canDiscardCorrupt
        ? <DamagedCommandRecoveryNotice error={commandRecovery.error} onDiscard={commandRecovery.discardCorruptAfterReview} testId="inventory-damaged-command-recovery" />
        : queryPhase !== "PERMISSION_DENIED"
          ? <InlineError error={commandRecovery.error} title="本地命令恢复记录不可用" />
          : null}
      <CommandResultNotice message={commandNotice} onDismiss={() => setCommandNotice(undefined)} />
      <InlineError error={restorationError} title="房态位置未保存" />
      <InlineError error={actionError} title="动作未开始" />
      <InlineError error={quoteRecoveryOutcome} title="报价恢复结果" />
      {queryPhase !== "PERMISSION_DENIED"
        ? <QuoteRecoveryPageEntry recovery={pageQuoteRecoveryForPresentation} onOpen={openQuoteRecoveryContext} />
        : null}
      {queryPhase !== "PERMISSION_DENIED" && commandRecovery.pending && recoveryPendingAllowed ? <CommandRecoveryBar recovery={commandRecovery.pending} onOpen={openRecoveryDialog} testId="inventory-command-recovery" businessFacing={inventoryRecoveryIsBusinessFacing(commandRecovery.pending.presentation)} /> : null}
      {queryPhase !== "PERMISSION_DENIED" && commandRecovery.pending && !recoveryPendingAllowed ? <section className="recovery-bar" role="status" data-testid="inventory-command-recovery-forbidden"><div><strong>原操作当前无权继续</strong><p>当前账号已没有该命令授权，恢复入口已隐藏；房态只按当前权限开放服务端动作。</p></div></section> : null}
      {returnNotice ? <div className="room-status-return-notice" role="status">{returnNotice}</div> : null}
      {!roomStatusBlockingModalOpen ? roomStatusRefreshNotice : null}

      {!renderedBoard ? (
        queryPhase === "LOADING" || (board !== undefined && !boardMatchesCurrentProperty)
          ? <LoadingBlock label="正在查询房间、床位与来源事实" />
          : queryPhase === "PERMISSION_DENIED"
            ? <section className="room-status-query-failure" role="alert"><strong>无权查看当前物业房态</strong><p>当前主体没有这项读取权限，页面未保留旧房态，也不会开放任何写入动作。</p></section>
          : <section className="room-status-query-failure" role="status"><strong>状态未知，未显示为可售</strong><p>重新查询成功前，页面不会开放房态写入。</p><button type="button" className="button button-secondary" onClick={requestRoomStatusRefresh}>重试查询</button></section>
      ) : (
        <>
          {!isMobile ? roomStatusToolbar : null}

          {rangeLoadingNoticeVisible ? (
            <div className="room-status-range-loading" role="status" aria-live="polite" data-testid="room-status-range-loading">
              <strong>正在载入新的日期范围或房间分页</strong>
              <span>工具栏保留上次获权的数据时点；下方仍是 [{renderedBoard.range.arrivalDate}, {renderedBoard.range.departureDate}) 的旧事实，已暂停全部交互和写入。</span>
            </div>
          ) : null}

          <div
            ref={workspaceRef}
            className={`room-status-workspace${!isMobile && (desktopContextCollapsed || !useInlineOrderContext) ? " is-context-overlay" : ""}`}
            aria-busy={rangeLoading}
            inert={rangeLoading && !filteredViewHasNoRooms}
          >
            <div className="room-status-board-column" ref={boardColumnRef}>
              <RoomStatusGrid
                board={renderedBoard}
                range={range}
                filters={viewState.filters}
                expandedRoomIds={viewState.expandedRoomIds}
                focusedCell={viewState.focusedCell}
                selection={viewState.selection}
                selectedStayId={roomStatusGridSelectedStayId(
                  Boolean(quickPopoverTarget),
                  quickPopoverPreviewStayId,
                  selectedOrderIdentity,
                  selectedGridStayId
                )}
                dateWindowStart={viewState.dateWindowStart}
                todayDate={todayDate}
                rangeError={rangeError instanceof Error ? rangeError.message : undefined}
                initialScrollAnchor={viewState.scrollAnchor}
                restoreFocus={restoreGridFocus}
                focusRequestToken={focusRequestToken}
                todayResetToken={todayResetToken}
                onRangeChange={applyRange}
                onPreviousRange={() => shiftRange(-1)}
                onNextRange={() => shiftRange(1)}
                onToday={() => {
                  setTodayResetToken((value) => value + 1);
                  applyRange(roomStatusTimelineRangeFromStart(todayDate));
                }}
                onToggleRoom={(roomId) => dispatchView({ type: "TOGGLE_ROOM", roomId })}
                onFocusedCellChange={(focus) => dispatchView({ type: "SET_FOCUS", focus })}
                onSelectionPreviewChange={previewSelection}
                onInspectSelection={inspectSelection}
                onPageChange={(index) => changeRoomPage(index, renderedBoard.page.totalPages)}
                onDateWindowChange={(start) => changeDateWindow(start, renderedBoard.dates.length)}
                onInspectUnit={inspectUnit}
                onInspectDay={inspectDay}
                onInspectInterval={inspectInterval}
                onClearFilters={clearFilters}
                onScrollAnchorChange={(anchor) => dispatchView({ type: "SET_SCROLL_ANCHOR", anchor })}
              />
              <RoomStatusMobileTasks
                board={renderedBoard}
                range={range}
                groups={mobileGroups}
                activeTab={mobileTab}
                canCreate={!commandsBlocked && roomStatusBoardHasSelectionAction(renderedBoard)}
                focusRequest={mobileFocusRequest}
                onTabChange={setMobileTab}
                onPageChange={(index) => changeRoomPage(index, renderedBoard.page.totalPages)}
                onRangeChange={applyRange}
                onToday={() => applyRange(roomStatusTimelineRangeFromStart(todayDate))}
                onCreate={() => setCreateSelectionOpen(true)}
                onOpenReference={openReference}
                onOpenReceipt={(receiptId) => window.open(`/api/v1/receipts/${encodeURIComponent(receiptId)}`, "_blank", "noopener,noreferrer")}
                onOpenOrderContext={(identity, serviceDate, trigger) => {
                  captureRoomStatusInteraction(trigger, null);
                  selectOrderContextIdentity(identity, serviceDate);
                }}
                onAction={(action, task, unit) => {
                  if (action.code === "OPEN_ORDER") {
                    const identity = roomStatusOrderIdentityForInterval(task);
                    if (!identity) {
                      setActionError(new Error("当前移动任务缺少唯一、稳定的订单引用，未打开订单。请刷新后重新核对。"));
                      return;
                    }
                    selectOrderContextIdentity(identity, task.businessDate);
                    return;
                  }
                  pendingMobileTaskFocus.current = {
                    tab: mobileTab,
                    completedTaskId: task.id,
                    taskIndex: Math.max(0, activeMobileTasks.findIndex((candidate) => candidate.id === task.id)),
                    sourceRevision: renderedBoard.revision
                  };
                  handleAction(action, unit, {
                    unitId: unit?.id ?? task.actualInventoryUnitId,
                    anchorDate: task.sourceStartDate,
                    focusDate: addLocalDateDays(task.sourceEndDate, -1),
                    arrivalDate: task.sourceStartDate,
                    departureDate: task.sourceEndDate
                  }, task.actualInventoryUnitId);
                }}
              />
            </div>
            {!isMobile && !desktopContextCollapsed && useInlineOrderContext && (!selectedOrderIdentity || orderContextOpen) ? <div className="room-status-side-column">
              {selectedOrderIdentity ? selectedOrderContext : <>{desktopSelectionContext}{desktopQuoteContext}</>}
            </div> : null}
          </div>

          {quickPopoverTarget && quickPopoverUnit ? (
            <RoomStatusQuickPopover
              anchor={quickPopoverTarget.anchor}
              unit={quickPopoverUnit}
              serviceDate={quickPopoverTarget.serviceDate}
              businessDate={renderedBoard?.businessDate}
              status={quickPopoverStatus}
              attentionLabels={quickPopoverAttentionLabels}
              actions={quickPopoverActions}
              {...(controlWriteBlock ? { writeBlock: controlWriteBlock } : {})}
              orderOptions={quickPopoverOrders}
              {...(quickPopoverSelection ? { selection: quickPopoverSelection } : {})}
              onClose={(reason) => {
                setQuickPopoverTarget(undefined);
                if (reason === "DISMISS") {
                  roomStatusInteractionSnapshotRef.current = undefined;
                  if (selectedOrderIdentity && orderContextOpen) {
                    dispatchView({ type: "SET_SELECTION", selection: null });
                  }
                }
              }}
              onCreate={(action) => {
                const selection = quickPopoverSelection
                  ?? selectionFromCells(quickPopoverUnit.id, quickPopoverTarget.serviceDate, quickPopoverTarget.serviceDate);
                setSelectedUnitId(quickPopoverUnit.id);
                setSelectedDayDate(quickPopoverSelection ? undefined : quickPopoverTarget.serviceDate);
                setSelectedIntervalId(undefined);
                selectRange(selection);
                handleAction(action, quickPopoverUnit, selection);
              }}
              onLockMaintenance={(action) => {
                const selection = quickPopoverSelection
                  ?? selectionFromCells(quickPopoverUnit.id, quickPopoverTarget.serviceDate, quickPopoverTarget.serviceDate);
                setSelectedUnitId(quickPopoverUnit.id);
                setSelectedDayDate(quickPopoverSelection ? undefined : quickPopoverTarget.serviceDate);
                setSelectedIntervalId(undefined);
                selectRange(selection);
                handleAction(action, quickPopoverUnit, selection);
                setQuoteTarget(undefined);
              }}
              onReleaseMaintenance={(action) => {
                setSelectedUnitId(quickPopoverUnit.id);
                setSelectedDayDate(quickPopoverSelection ? undefined : quickPopoverTarget.serviceDate);
                setSelectedIntervalId(quickPopoverTarget.intervalId);
                setQuoteTarget(undefined);
                handleAction(action, quickPopoverUnit);
              }}
              onViewStatus={() => {
                setSelectedOrderIdentity(undefined);
                setSelectedOrderView(undefined);
                setSelectedCorrectionOccupantId(undefined);
                setOrderContextOpen(false);
                setSelectedUnitId(quickPopoverUnit.id);
                setSelectedDayDate(quickPopoverSelection ? undefined : quickPopoverTarget.serviceDate);
                setSelectedIntervalId(quickPopoverTarget.intervalId);
                setQuoteTarget(undefined);
                dispatchView({
                  type: "SET_SELECTION",
                  selection: quickPopoverSelection
                    ?? selectionFromCells(quickPopoverUnit.id, quickPopoverTarget.serviceDate, quickPopoverTarget.serviceDate)
                });
                setDesktopContextCollapsed(false);
              }}
              onRefresh={requestRoomStatusRefresh}
              onOpenRecovery={() => {
                setQuickPopoverTarget(undefined);
                openRoomStatusRecoveryEntry();
              }}
              onOpenOrder={(option) => selectOrderContextIdentity(option.identity, quickPopoverTarget.serviceDate)}
            />
          ) : null}

          {desktopContextDrawerOpen ? (
            <Modal
              key={desktopDrawerInstanceKey}
              title={desktopDrawerTitle}
              size="drawer"
              modal={desktopDrawerModal}
              className={desktopDrawerModal ? "room-status-write-drawer" : "room-status-view-drawer"}
              onClose={closeDesktopContext}
              footer={<>
                <button type="button" className="button button-secondary" onClick={closeDesktopContext}>关闭</button>
                {desktopContextKind === "ORDER" ? <button type="button" className="button button-primary" onClick={() => openSelectedOrder()}>查看完整订单</button> : null}
              </>}
            >
              {desktopContextKind === "ORDER"
                ? selectedOrderContext
                : <>
                    {desktopContextKind === "SELECTION" ? desktopSelectionContext : null}
                    {desktopQuoteContext}
                  </>}
            </Modal>
          ) : null}

          {isMobile && selectedOrderIdentity && orderContextOpen ? (
            <Modal
              title="订单详情"
              size="mobile-fullscreen"
              modal
              onClose={closeSelectedOrderContext}
              footer={<><button type="button" className="button button-secondary" onClick={closeSelectedOrderContext}>关闭</button><button type="button" className="button button-primary" onClick={() => openSelectedOrder()}>查看完整订单</button></>}
            >
              {selectedOrderContext}
            </Modal>
          ) : null}

          {!isMobile && desktopContextCollapsed && !pendingOrderContextIdentity && !quickPopoverTarget && (selectedUnit || selectedOrderIdentity || viewState.selection || showQuoteWorkbench) ? (
            <button type="button" className="button button-primary room-status-context-reopen" onClick={reopenDesktopContext}>
              <PanelRightOpen aria-hidden="true" size={17} />打开{pageQuoteRecovery.kind !== "ABSENT" ? "报价恢复" : selectedOrderIdentity ? "订单详情" : "选中对象上下文"}
            </button>
          ) : null}

          {createSelectionOpen ? (
            <Modal title="新建住宿或锁房" size={isMobile ? "mobile-fullscreen" : "wide"} onClose={() => setCreateSelectionOpen(false)} footer={null}>
              <RoomStatusContext
                board={renderedBoard}
                selectedUnit={selectedUnit}
                selectedDay={selectedDay}
                selectedInterval={selectedInterval}
                relatedIntervals={relatedIntervals}
                selection={viewState.selection}
                conflicts={contextConflicts}
                allowedActions={contextActions}
                {...(controlWriteBlock ? { writeBlock: controlWriteBlock } : {})}
                onSelectedUnitChange={(unit) => {
                  inspectUnit(unit);
                }}
                onSelectionChange={selectRange}
                onDraftValidityChange={setSelectionDraftValid}
                onOpenReference={openReference}
                onOpenReceipt={(receiptId) => window.open(`/api/v1/receipts/${encodeURIComponent(receiptId)}`, "_blank", "noopener,noreferrer")}
                onAction={(action) => {
                  if (handleAction(action)) setCreateSelectionOpen(false);
                }}
                onRefresh={requestRoomStatusRefresh}
                onOpenRecovery={openRoomStatusRecoveryEntry}
              />
            </Modal>
          ) : null}

          {isMobile && showQuoteWorkbench ? (
            <div className="room-status-quote-section" ref={quoteSectionRef}>
              <QuoteWorkbench
                unit={quoteActionUnit}
                arrivalDate={activeQuoteTarget?.arrivalDate ?? range.arrivalDate}
                departureDate={activeQuoteTarget?.departureDate ?? range.departureDate}
                businessDate={renderedBoard.businessDate}
                policies={policies}
                {...(recoveryQuoteInputForWorkbench ? { recoveryQuoteInput: recoveryQuoteInputForWorkbench } : {})}
                {...(activeQuoteTarget ? { initialStayType: activeQuoteTarget.initialStayType } : {})}
                {...(initialMemberId ? { initialMemberId } : {})}
                {...(activeQuoteTarget?.actionCode ? { quoteActionCode: activeQuoteTarget.actionCode } : {})}
                backfill={activeQuoteTarget?.actionCode === "BACKFILL_ORDER"}
                commandsBlocked={quoteWorkbenchBlocked}
                selectionDraftValid={selectionDraftValid}
                resetToken={quoteResetToken}
                autoResolvedRecoveryIdentities={autoResolvedQuoteRecoveryIdentities}
                onClose={closeQuoteWorkbench}
                onRecoveryOutcome={setQuoteRecoveryOutcome}
                onRecoveryStateChange={() => {
                  if (recoveryQuoteTarget) {
                    setQuoteTarget((current) => roomStatusQuoteTargetsEqual(current, recoveryQuoteTarget) ? current : recoveryQuoteTarget);
                  }
                  setPageQuoteRecoveryRevision((revision) => revision + 1);
                }}
                onQuoteSubmissionActivity={trackQuoteSubmissionActivity}
                onCommand={startQuoteCommand}
              />
            </div>
          ) : null}
        </>
      )}

      {detachedQuoteRecoveryWorkbenchOpen ? (
        <Modal
          title="报价恢复"
          size={isMobile ? "mobile-fullscreen" : "drawer"}
          modal
          className="room-status-write-drawer"
          onClose={closeDesktopContext}
          footer={<button type="button" className="button button-secondary" onClick={closeDesktopContext}>关闭</button>}
        >
          <div className="room-status-quote-section" ref={quoteSectionRef}>
            <QuoteWorkbench
              unit={undefined}
              arrivalDate={activeQuoteTarget?.arrivalDate ?? range.arrivalDate}
              departureDate={activeQuoteTarget?.departureDate ?? range.departureDate}
              {...(renderedBoard?.businessDate ? { businessDate: renderedBoard.businessDate } : {})}
              policies={policies}
              {...(recoveryQuoteInputForWorkbench ? { recoveryQuoteInput: recoveryQuoteInputForWorkbench } : {})}
              {...(activeQuoteTarget ? { initialStayType: activeQuoteTarget.initialStayType } : {})}
              {...(initialMemberId ? { initialMemberId } : {})}
              {...(activeQuoteTarget?.actionCode ? { quoteActionCode: activeQuoteTarget.actionCode } : {})}
              backfill={activeQuoteTarget?.actionCode === "BACKFILL_ORDER"}
              commandsBlocked
              selectionDraftValid={selectionDraftValid}
              resetToken={quoteResetToken}
              autoResolvedRecoveryIdentities={autoResolvedQuoteRecoveryIdentities}
              onClose={closeQuoteWorkbench}
              onRecoveryOutcome={setQuoteRecoveryOutcome}
              onRecoveryStateChange={() => {
                if (recoveryQuoteTarget) {
                  setQuoteTarget((current) => roomStatusQuoteTargetsEqual(current, recoveryQuoteTarget) ? current : recoveryQuoteTarget);
                }
                setPageQuoteRecoveryRevision((revision) => revision + 1);
              }}
              onQuoteSubmissionActivity={trackQuoteSubmissionActivity}
              onCommand={startQuoteCommand}
            />
          </div>
        </Modal>
      ) : null}

      {maintenanceTarget && viewState.selection && !command ? <MaintenanceDialog unit={maintenanceTarget} arrivalDate={viewState.selection.arrivalDate} departureDate={viewState.selection.departureDate} writeBlocked={commandsBlocked} {...(commandDraft?.commandType === "LOCK_MAINTENANCE" ? { draft: commandDraft } : {})} onClose={() => { setMaintenanceTarget(undefined); setCommandDraft(undefined); restoreRoomStatusInteraction(); }} onSubmit={startCommand} /> : null}
      {authorizedSelectedOrderView && selectedCorrectionOccupant ? <OrderOccupantCorrectionDialog
        view={authorizedSelectedOrderView}
        occupant={selectedCorrectionOccupant}
        {...(correctionDraftMatchesOccupant(commandDraft, authorizedSelectedOrderView.order.id, selectedCorrectionOccupant.id)
          ? { draft: commandDraft }
          : {})}
        onClose={() => {
          setSelectedCorrectionOccupantId(undefined);
          setSelectedCorrectionRevision(undefined);
          setCommandDraft(undefined);
        }}
        onSubmit={(request) => {
          if (commandsBlocked) return;
          setSelectedCorrectionOccupantId(undefined);
          setSelectedCorrectionRevision(undefined);
          setRecoveryDialogOpen(false);
          startCommand(request, currentSelectedOrderCommandScope);
        }}
      /> : null}
      {authorizedSelectedOrderView && selectedStayDateAction ? <StayDateChangeDrawer
        action={selectedStayDateAction}
        mode={selectedStayDateMode}
        view={authorizedSelectedOrderView}
        inventoryUnitLabel={[...new Set(authorizedSelectedOrderView.effectiveArrangement.intervals.map((interval) => {
          const unit = meta.inventoryUnits.find((candidate) => candidate.id === interval.inventoryUnitId);
          return unit ? `${unit.code} · ${unit.name}` : "房源";
        }))].join(" → ")}
        inventoryUnits={meta.inventoryUnits}
        writeBlocked={commandsBlocked || selectedStayDateRevision !== board?.revision}
        runPreview={commandRecovery.runPreview}
        {...(commandDraft?.commandType === selectedStayDateAction ? { draft: commandDraft } : {})}
        onClose={() => {
          setSelectedStayDateAction(undefined);
          setSelectedStayDateMode("DATE_CHANGE");
          setSelectedStayDateRevision(undefined);
          setSelectedOrderCommandScope(undefined);
          setCommandDraft(undefined);
          restoreRoomStatusInteraction();
        }}
        onSubmit={(request) => {
          const identity = selectedOrderIdentity;
          if (!identity || commandsBlocked || !selectedStayDateRequestIsCompatible(
            selectedStayDateAction,
            selectedStayDateMode,
            request.commandType
          )) return;
          setSelectedStayDateAction(undefined);
          setSelectedStayDateMode("DATE_CHANGE");
          setSelectedStayDateRevision(undefined);
          setCommandDraft(undefined);
          setRecoveryDialogOpen(false);
          startCommand(request, roomStatusOrderCommandScope(orderPrincipalScope, identity));
        }}
      /> : null}
      {authorizedSelectedOrderView && selectedMoveUnitOpen ? <MoveUnitDrawer
        view={authorizedSelectedOrderView}
        units={meta.inventoryUnits}
        writeBlocked={commandsBlocked || selectedMoveUnitRevision !== board?.revision}
        runPreview={commandRecovery.runPreview}
        {...(commandDraft?.commandType === "MOVE_UNIT" ? { draft: commandDraft } : {})}
        onClose={() => {
          setSelectedMoveUnitOpen(false);
          setSelectedMoveUnitRevision(undefined);
          setSelectedOrderCommandScope(undefined);
          setCommandDraft(undefined);
          restoreRoomStatusInteraction();
        }}
        onSubmit={(request) => {
          const identity = selectedOrderIdentity;
          if (!identity || commandsBlocked || request.commandType !== "MOVE_UNIT") return;
          setSelectedMoveUnitOpen(false);
          setSelectedMoveUnitRevision(undefined);
          setCommandDraft(undefined);
          setRecoveryDialogOpen(false);
          startCommand(request, roomStatusOrderCommandScope(orderPrincipalScope, identity));
        }}
      /> : null}
      {authorizedSelectedOrderView && selectedLifecycleAction ? <OrderLifecycleActionDrawer
        action={selectedLifecycleAction}
        view={authorizedSelectedOrderView}
        inventoryUnitLabels={Object.fromEntries(meta.inventoryUnits.map((unit) => [unit.id, `${unit.code} · ${unit.name}`]))}
        writeBlocked={commandsBlocked || selectedLifecycleRevision !== board?.revision}
        {...(commandDraft?.commandType === selectedLifecycleAction ? { draft: commandDraft } : {})}
        onClose={() => {
          setSelectedLifecycleAction(undefined);
          setSelectedLifecycleRevision(undefined);
          setSelectedOrderCommandScope(undefined);
          setCommandDraft(undefined);
          restoreRoomStatusInteraction();
        }}
        onSubmit={(request) => {
          const identity = selectedOrderIdentity;
          const currentView = authorizedSelectedOrderView;
          const action = currentView?.allowedActions.find((candidate) => candidate.code === selectedLifecycleAction);
          if (!identity || commandsBlocked || selectedLifecycleRevision !== board?.revision
            || request.commandType !== selectedLifecycleAction
            || currentView.order.id !== identity.orderId || currentView.stay.id !== identity.stayId
            || !action?.enabled) return;
          setSelectedLifecycleAction(undefined);
          setSelectedLifecycleRevision(undefined);
          setCommandDraft(undefined);
          setRecoveryDialogOpen(false);
          startCommand(request, roomStatusOrderCommandScope(orderPrincipalScope, identity));
        }}
      /> : null}
      {command && commandTargetScopeCurrent ? <CommandDialog
        key={recoveryDialogOpen ? `recovery-${commandRecovery.pending?.confirmationKey ?? "missing"}-${commandAttemptId}` : `new-room-status-command-${commandAttemptId}`}
        request={command}
        onClose={closeCommandDialog}
        writeBlocked={!recoveryDialogOpen && activeCommandWriteBlocked}
        writeBlockedReason="当前命令绑定的门店、账号、订单、住宿、查询范围或业务版本已经变化，或者操作恢复状态异常。请关闭后重新核对。"
        onCommitted={refreshCommittedRoomStatus}
        onBusinessSuccess={() => {
          setCommandNotice(undefined);
          setCommandDraft(undefined);
          setSelectedStayDateAction(undefined);
          setSelectedStayDateMode("DATE_CHANGE");
          setSelectedStayDateRevision(undefined);
          setSelectedMoveUnitOpen(false);
          setSelectedMoveUnitRevision(undefined);
          setSelectedLifecycleAction(undefined);
          setSelectedLifecycleRevision(undefined);
          if (command.commandType === "CREATE_ORDER") {
            setQuoteTarget(undefined);
            setDesktopContextCollapsed(true);
            setCreateSelectionOpen(false);
          }
          if (command.commandType === "LOCK_MAINTENANCE") {
            setMaintenanceTarget(undefined);
            setDesktopContextCollapsed(true);
            setCreateSelectionOpen(false);
            roomStatusInteractionSnapshotRef.current = undefined;
          }
        }}
        onBusinessNotExecuted={(message) => setCommandNotice(message)}
        onReturnToEdit={returnCommandToEdit}
        {...(recoveryDialogOpen && commandRecovery.pending ? {
          initialConfirmationKey: commandRecovery.pending.confirmationKey
        } : {})}
        onProgress={(progress) => trackCommandProgress(command, progress, commandAttemptId)}
      /> : null}
    </div>
    </ModalNoticeProvider>
  );
}
import { ExternalPaymentPicker } from "../components/ExternalPaymentPicker";
