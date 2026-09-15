import { useAssistantOrderEntry } from "../assistant/context";
import { createReadPoller } from "../readPoller";
import { orderListBackHref } from "../orderListNavigation";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRightLeft,
  CalendarRange,
  CircleHelp,
  CircleDollarSign,
  ClipboardCheck,
  LogIn,
  LogOut,
  Pencil,
  Sparkles,
  Undo2,
  UserX,
  UserPlus,
  XCircle
} from "lucide-react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import {
  currentReleaseFeatures,
  type CommandType,
  type MoneyDto,
  type OrderActionCode,
  type OrderAllowedActionDto,
  type OrderArrangementDto,
  type OrderArrangementHistoryItemDto,
  type OrderEffectiveArrangementPresentation,
  type OrderFulfillmentRecordDto
} from "@qintopia/contracts";
import { api, ApiError } from "../api";
import { ExternalPaymentPicker } from "../components/ExternalPaymentPicker";
import { accommodationPositionItems, type AccommodationPositionItem } from "../components/AccommodationPositionSummary";
import { roomStatusRoomTypeLabel } from "../room-status/roomStatusPresentation";
import { OverdueInHouseAlert, overdueInHouseNotice } from "../components/OverdueInHouseAlert";
import { correctionDraftMatchesOccupant, OrderOccupantCorrectionDialog } from "../components/OrderOccupantCorrectionDialog";
import { OrderCompanionDialog } from "../components/OrderCompanionDialog";
import { MoveUnitDrawer } from "../components/MoveUnitDrawer";
import {
  OrderLifecycleActionDrawer,
  type OrderLifecycleAction
} from "../components/OrderLifecycleActionDrawer";
import {
  StayDateChangeDrawer,
  stayDateChangeActionState,
  type StayDateChangeAction,
  type StayDateChangeMode
} from "../components/StayDateChangeDrawer";
import { commandRecoveryAvailable, propertyAllowedActions, useWorkspace } from "../session";
import { assertOrderViewAllowedActions } from "../orderViewValidation";
import {
  membershipProductMatchesCurrentStay,
  normalizeStayUpgradePhone as normalizePhoneNumber,
  stayMembershipUpgradeActionVisible,
  stayMembershipUpgradeEntry,
  stayMembershipUpgradeResumeAfterOccupantCorrection,
  stayUpgradeMemberCreationHref,
  upgradedStayActionDisabledReason,
  type StayMembershipUpgradeIntent
} from "../stayMembershipUpgrade";
import type { AmendmentDto, CollectionFactDto, CommandRequest, InventoryUnitDto, MemberDto, MembershipProductDto, OrderViewDto, PricingRevisionDto } from "../types";
import {
  errorMessage,
  CommandDialog,
  type CommandDialogCloseContext,
  CommandResultNotice,
  CommandRecoveryBar,
  DamagedCommandRecoveryNotice,
  businessStatusLabel,
  EmptyState,
  formatDate,
  formatDateTime,
  formatMinor,
  formatMoney,
  guestName,
  InlineError,
  InfoHint,
  LoadingBlock,
  Modal,
  ModalNoticeProvider,
  QuoteRecoveryConflictNotice,
  isTerminalCommandRecovery,
  recoveryCommandRequest,
  stayDateFundsAreOperatorFacing,
  temporaryOtherRoomArrangementPresentation,
  usePersistentCommandRecovery,
  StatusBadge
} from "../ui";

export { OverdueInHouseAlert, overdueInHouseNotice } from "../components/OverdueInHouseAlert";

export {
  stayMembershipUpgradeEntry,
  stayMembershipUpgradeActionVisible,
  stayMembershipUpgradeResumeAfterOccupantCorrection,
  upgradedStayActionDisabledReason
} from "../stayMembershipUpgrade";

type FormAction = "RECORD_COLLECTION" | "RECORD_REFUND" | "REVERSE_FACT" | "SHORTEN_STAY" | "EXTEND_STAY" | "REPRICE_ORDER";
const completeStayExternalChannelCodes = new Set(["YOUMUDAO", "CTRIP", "MEITUAN"]);
const ORDER_DETAIL_POLL_MS = 4_000;

export const completeStayOperatorCopy = {
  contextTitle: "请确认实际住宿情况",
  contextDetail: "客人已经实际入住并离店。确认后订单会直接完成住宿：已收清显示“已结单”，未收清显示“欠款”。",
  confirmationLabel: "我已确认客人实际入住，且现在已经离店",
  reviewDescription: "确认实际住宿情况后，订单将直接完成；已收清显示“已结单”，未收清显示“欠款”。"
} as const;

export function orderViewPayloadChanged(previous: OrderViewDto, next: OrderViewDto): boolean {
  return JSON.stringify(previous) !== JSON.stringify(next);
}

export interface CompleteStayCorrectionRecord {
  commandId: string;
  actor: AmendmentDto["actor"];
  recordedAt: string;
  reasonNote: string;
}

function correctionActorsMatch(left: AmendmentDto["actor"], right: AmendmentDto["actor"]): boolean {
  if (!left || !right) return left === right;
  return left.subjectId === right.subjectId && left.displayName === right.displayName;
}

export function completeStayCorrectionRecords(amendments: readonly AmendmentDto[]): CompleteStayCorrectionRecord[] {
  const byCommand = new Map<string, AmendmentDto[]>();
  for (const amendment of amendments) {
    if (!amendment.command_id
      || amendment.reason_code !== "COMPLETE_STAY"
      || (amendment.amendment_type !== "CHECK_IN" && amendment.amendment_type !== "CHECK_OUT")) {
      continue;
    }
    const group = byCommand.get(amendment.command_id) ?? [];
    group.push(amendment);
    byCommand.set(amendment.command_id, group);
  }

  return [...byCommand.entries()].flatMap(([commandId, group]) => {
    if (group.length !== 2) return [];
    const checkIn = group.find((amendment) => amendment.amendment_type === "CHECK_IN");
    const checkOut = group.find((amendment) => amendment.amendment_type === "CHECK_OUT");
    if (!checkIn || !checkOut
      || checkIn.order_id !== checkOut.order_id
      || checkIn.sequence + 1 !== checkOut.sequence
      || checkIn.new_version !== checkOut.prior_version
      || checkIn.reason_note !== checkOut.reason_note
      || !correctionActorsMatch(checkIn.actor, checkOut.actor)) {
      return [];
    }
    return [{
      commandId,
      actor: checkOut.actor,
      recordedAt: checkOut.created_at,
      reasonNote: checkOut.reason_note
    }];
  });
}

export interface TemporaryOtherRoomOrderRecord {
  originalRoomTypeCode: string;
  actualInventoryUnitId: string;
  actualRoomTypeCode: string;
  arrivalDate: string;
  departureDate: string;
  reasonNote: string;
  actor: NonNullable<AmendmentDto["actor"]>;
  recordedAt: string;
}

function validRecordedAt(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

export function temporaryOtherRoomOrderRecord(amendments: readonly AmendmentDto[]): TemporaryOtherRoomOrderRecord | undefined {
  const creation = amendments
    .filter((amendment) => amendment.amendment_type === "CREATE_ORDER")
    .sort((left, right) => left.sequence - right.sequence)[0];
  if (!creation
    || creation.reason_code !== "TEMPORARY_OTHER_ROOM"
    || !creation.reason_note.trim()
    || creation.reason_note.trim().length > 200
    || !creation.actor?.subjectId.trim()
    || !creation.actor.displayName.trim()
    || !validRecordedAt(creation.created_at)
    || !creation.payload
    || typeof creation.payload !== "object"
    || Array.isArray(creation.payload)) return undefined;
  const arrangement = temporaryOtherRoomArrangementPresentation(
    (creation.payload as Record<string, unknown>).temporaryOtherRoomArrangement
  );
  if (!arrangement) return undefined;
  return {
    ...arrangement,
    reasonNote: creation.reason_note.trim(),
    actor: creation.actor,
    recordedAt: creation.created_at
  };
}

export function orderRefreshMustCloseEditor(
  previous: OrderViewDto,
  next: OrderViewDto,
  editorIsOpen: boolean
): boolean {
  return editorIsOpen && orderViewPayloadChanged(previous, next);
}

function shiftDate(value: string, days: number): string {
  const date = new Date(`${value}T12:00:00`);
  date.setDate(date.getDate() + days);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function initialRepriceTargetYuan(currentContractAmountMinor: number, draftTargetMinor: unknown): string {
  const validDraftTarget = typeof draftTargetMinor === "number"
    && Number.isSafeInteger(draftTargetMinor)
    && draftTargetMinor >= 0
    && draftTargetMinor % 100 === 0;
  return String((validDraftTarget ? draftTargetMinor : currentContractAmountMinor) / 100);
}

export function wholeYuanAmountMinor(value: string): number | undefined {
  const targetYuan = Number(value);
  return Number.isSafeInteger(targetYuan) && targetYuan >= 0
    ? targetYuan * 100
    : undefined;
}

export function formalMembershipAgreedPriceMinor(value: string): number | undefined {
  const amountMinor = wholeYuanAmountMinor(value);
  return amountMinor !== undefined && amountMinor > 0 && amountMinor <= 2_147_483_600 ? amountMinor : undefined;
}

export function orderStayDateRequestIsCompatible(
  openedAction: StayDateChangeAction,
  mode: StayDateChangeMode,
  requestCommandType: CommandRequest["commandType"]
): boolean {
  return mode === "ADJUST_DEPARTURE"
    ? requestCommandType === "EXTEND_STAY" || requestCommandType === "SHORTEN_STAY"
    : requestCommandType === openedAction;
}

const formTitles: Record<FormAction, string> = {
  RECORD_COLLECTION: "登记收款",
  RECORD_REFUND: "登记退款",
  REVERSE_FACT: "登记冲销",
  SHORTEN_STAY: "缩短住宿",
  EXTEND_STAY: "续住",
  REPRICE_ORDER: "调整订单金额"
};

const MAX_AMOUNT_MINOR = 2_147_483_647;

const bookingChannelLabels = {
  YOUMUDAO: "游牧岛",
  CTRIP: "携程",
  MEITUAN: "美团",
  WECOM: "企业微信"
} as const;
const externalBookingChannelCodes = new Set(["YOUMUDAO", "CTRIP", "MEITUAN"]);
const terminalOrderStatuses = new Set(["CHECKED_OUT", "CANCELLED", "NO_SHOW", "CHECK_IN_REVOKED"]);
const preArrivalTerminalActionCodes: readonly OrderActionCode[] = [
  "RECORD_COLLECTION",
  "RECORD_REFUND",
  "RESCHEDULE_STAY",
  "MOVE_UNIT",
  "REPRICE_ORDER",
  "CHECK_IN",
  "CANCEL_ORDER",
  "MARK_NO_SHOW"
];
const inHouseTerminalActionCodes: readonly OrderActionCode[] = [
  "RECORD_COLLECTION",
  "RECORD_REFUND",
  "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP",
  "EXTEND_STAY",
  "SHORTEN_STAY",
  "MOVE_UNIT",
  "REPRICE_ORDER",
  "CHECK_OUT",
  "REVOKE_CHECK_IN"
];

const occupantFieldLabels: Record<string, string> = {
  nickname: "昵称",
  fullName: "姓名",
  phone: "联系电话",
  documentNumber: "证件号码"
};

type OrderOccupant = OrderViewDto["occupants"][number];

export function enabledOrderActionCodes(actions: readonly OrderAllowedActionDto[]): OrderActionCode[] {
  return actions.filter((action) => action.enabled).map((action) => action.code);
}

export interface OrderFulfillmentNotice {
  action: "CHECK_IN" | "CHECK_OUT";
  title: string;
  body: string;
}

export function orderFulfillmentNotice(actions: readonly OrderAllowedActionDto[]): OrderFulfillmentNotice | undefined {
  const checkIn = actions.find((action) => action.code === "CHECK_IN");
  if (checkIn?.disabledReason === "ARRIVAL_DATE_NOT_REACHED") {
    return {
      action: "CHECK_IN",
      title: "暂不能办理入住",
      body: "尚未到计划到店日，请在计划到店日办理。"
    };
  }
  if (checkIn?.disabledReason === "ARRIVAL_DATE_PASSED") {
    return {
      action: "CHECK_IN",
      title: checkIn.enabled ? "已超过计划到店日" : "暂不能办理入住",
      body: checkIn.enabled
        ? "可办理迟录入住，也可办理改期或标记未到。"
        : "已超过计划到店日，可办理改期或标记未到。"
    };
  }
  const checkout = actions.find((action) => action.code === "CHECK_OUT");
  if (checkout?.disabledReason === "DEPARTURE_DATE_NOT_REACHED") {
    const shorten = actions.find((action) => action.code === "SHORTEN_STAY");
    if (shorten) return undefined;
    return {
      action: "CHECK_OUT",
      title: "暂不能办理退房",
      body: "尚未到计划退房日，暂不能办理退房。"
    };
  }
  return undefined;
}

export function orderRefundUnavailableReason(actions: readonly OrderAllowedActionDto[]): string | undefined {
  const refund = actions.find((action) => action.code === "RECORD_REFUND");
  if (refund?.disabledReason !== "NO_REFUNDABLE_COLLECTION") return undefined;
  return "当前没有可退款的收款记录。需要先有未被冲销、且仍有可退余额的原收款，才能登记退款。";
}

export function orderStatusIsTerminal(status: string): boolean {
  return terminalOrderStatuses.has(status);
}

export function terminalOrderActionCodes(status: string): readonly OrderActionCode[] {
  if (status === "CANCELLED" || status === "NO_SHOW") return preArrivalTerminalActionCodes;
  if (status === "CHECKED_OUT" || status === "CHECK_IN_REVOKED") return inHouseTerminalActionCodes;
  return [];
}

export function orderActionDisabledReasonText(action: OrderAllowedActionDto | undefined): string | undefined {
  if (!action || action.enabled) return undefined;
  const reason = action.disabledReason?.trim();
  if (!reason) return "当前操作不可用。";
  if (reason === "ORDER_STATE_NOT_ALLOWED") return "当前订单状态不允许执行此操作。";
  if (reason === "NO_REFUNDABLE_COLLECTION") return orderRefundUnavailableReason([action]);
  if (reason === "NO_TRANSFERABLE_COLLECTION") return "当前订单资金记录包含非企微、冲销或无法核对的收退款事实，不能升级会员。";
  if (reason === "ARRIVAL_DATE_NOT_REACHED") return "尚未到计划到店日，请在计划到店日办理。";
  if (reason === "ARRIVAL_DATE_PASSED") return "已超过计划到店日，可办理改期或标记未到。";
  if (reason === "DEPARTURE_DATE_NOT_REACHED") return "尚未到计划退房日，暂不能办理退房。";
  if (reason === "STAY_MEMBERSHIP_UPGRADE_REPRICE_CLOSED") return "升级会员后的住宿金额已冻结，不能再走普通调价。";
  if (reason === "STAY_MEMBERSHIP_UPGRADE_REVOKE_CHECK_IN_CLOSED") return "升级会员后的在住订单不能走普通撤销入住。";
  return reason;
}

export function orderActionWithUpgradeGuard(
  view: Pick<OrderViewDto, "amendments">,
  action: OrderAllowedActionDto | undefined
): OrderAllowedActionDto | undefined {
  if (!action) return undefined;
  const disabledReason = upgradedStayActionDisabledReason(view, action.code);
  return disabledReason ? { ...action, enabled: false, disabledReason } : action;
}

export function stayMembershipUpgradeAutoOpenBlockedNotice(
  requestedAction: OrderActionCode | undefined,
  orderActionsBlocked: boolean
): string | undefined {
  if (!orderActionsBlocked) return undefined;
  if (requestedAction !== "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP"
    && requestedAction !== "CORRECT_ORDER_OCCUPANT") return undefined;
  return "当前有未完成的命令恢复记录，已暂停自动打开升级会员流程；请先处理页面顶部的恢复提示。";
}

export function orderActionHelpRequired(
  actions: readonly OrderAllowedActionDto[],
  visibleActionCodes: readonly OrderActionCode[]
): boolean {
  const visibleCodes = new Set(visibleActionCodes);
  return actions.some((action) => visibleCodes.has(action.code) && !action.enabled);
}

export function itemCountLabel(count: number): string {
  return `${count} 条`;
}

export function OrderActionNotice({ title, body, testId, action }: {
  title: string;
  body: string;
  testId: string;
  action?: string;
}) {
  const helpId = useId();
  return <span className="action-notice-popover">
    <span className="action-notice" role="status" data-testid={testId} data-action={action}>
      <AlertTriangle aria-hidden="true" size={14} />
      {title}
      <span className="info-hint action-notice-help-trigger" tabIndex={0} role="note" aria-label={`说明：${body}`} aria-describedby={helpId}>
        <CircleHelp aria-hidden="true" size={14} />
      </span>
    </span>
    <span className="action-notice-bubble" id={helpId} role="tooltip">{body}</span>
  </span>;
}

export function orderDetailBackTarget(state: unknown): string {
  if (!state || typeof state !== "object") return "/orders";
  const source = state as Record<string, unknown>;
  return source.fromRoomStatus === true
    || source.source === "room-status"
    || source.returnTo === "/"
    ? "/"
    : orderListBackHref(state);
}

export function requestedOrderAction(search: string, actions: readonly OrderAllowedActionDto[]): OrderActionCode | undefined {
  const requested = new URLSearchParams(search).get("action");
  return actions.find((action) => action.enabled && action.code === requested)?.code;
}

export function remainingRefundableMinor(facts: readonly CollectionFactDto[], collection: CollectionFactDto): number {
  if (collection.fact_type !== "COLLECTION" || facts.some((fact) => fact.reverses_fact_id === collection.fact_id)) return 0;
  const activeRefunded = facts
    .filter((fact) => fact.fact_type === "REFUND" && fact.references_fact_id === collection.fact_id)
    .filter((refund) => !facts.some((fact) => fact.reverses_fact_id === refund.fact_id))
    .reduce((sum, refund) => sum + refund.amount_minor, 0);
  return Math.max(0, collection.amount_minor - activeRefunded);
}

export function collectionFactCanReverse(
  facts: readonly CollectionFactDto[],
  fact: CollectionFactDto,
  reverseActionEnabled: boolean
): boolean {
  if (!reverseActionEnabled || fact.fact_type === "REVERSAL") return false;
  const reversedFactIds = new Set(facts
    .filter((candidate) => candidate.fact_type === "REVERSAL" && candidate.reverses_fact_id)
    .map((candidate) => candidate.reverses_fact_id));
  if (reversedFactIds.has(fact.fact_id)) return false;
  if (fact.fact_type !== "COLLECTION") return true;
  return !facts.some((candidate) => candidate.fact_type === "REFUND"
    && candidate.references_fact_id === fact.fact_id
    && !reversedFactIds.has(candidate.fact_id));
}

export function buildReverseFactRequest(
  view: Pick<OrderViewDto, "order">,
  fact: CollectionFactDto,
  note: string
): CommandRequest {
  const trimmedNote = note.trim();
  return {
    commandType: "REVERSE_FACT",
    title: formTitles.REVERSE_FACT,
    description: "系统将追加一条反向冲销记录，用于抵销所选收退款事实；原记录不会被删除。",
    input: {
      propertyId: view.order.property_id,
      orderId: view.order.id,
      reversesFactId: fact.fact_id,
      note: trimmedNote
    },
    initialReason: { code: "REVERSE_FACT", note: trimmedNote }
  };
}

export function collectionFactTransactionReferenceLabel(facts: readonly CollectionFactDto[], fact: CollectionFactDto): string {
  if (fact.fact_type === "REVERSAL") return "不适用";
  if (fact.transaction_reference) return fact.transaction_reference;
  if (fact.fact_type === "REFUND" && fact.method === "WECOM") {
    const original = facts.find((item) => item.fact_id === fact.references_fact_id);
    return `${fact.refund_reference ? `退款 ${fact.refund_reference}` : "历史未记录退款单号"}${original?.transaction_reference ? ` · 原收款 ${original.transaction_reference}` : ""}`;
  }
  return fact.method === "CASH" || fact.method === "OTHER" ? "不适用" : "历史未记录";
}

export function orderViewMatchesPrincipalScope(loadedScope: string | undefined, currentScope: string): boolean {
  return loadedScope === currentScope;
}

export function orderedOrderOccupants(occupants: readonly OrderOccupant[]): OrderOccupant[] {
  return [...occupants].sort((left, right) => left.ordinal - right.ordinal);
}

export function primaryOrderOccupant(occupants: readonly OrderOccupant[]): OrderOccupant | undefined {
  return occupants.find((occupant) => occupant.role === "PRIMARY") ?? orderedOrderOccupants(occupants)[0];
}

export function occupantSnapshotEntries(snapshot: Pick<OrderOccupant, "nickname" | "fullName" | "phone" | "documentNumber">): Array<[string, unknown]> {
  const canonicalKeys = ["nickname", "fullName", "phone", "documentNumber"] as const;
  const canonical = canonicalKeys.map((key): [string, unknown] => [
    occupantFieldLabels[key]!,
    key === "nickname" && (typeof snapshot[key] !== "string" || !snapshot[key].trim())
      ? "历史未记录"
      : snapshot[key] ?? "-"
  ]);
  return canonical;
}

export function fulfillmentResultLabel(record: OrderFulfillmentRecordDto): string {
  if (record.recordingMode === "LEGACY_UNCLASSIFIED") return "历史记录未分类";
  if (record.recordingMode === "LATE_RECORDED") return record.type === "CHECK_IN" ? "迟录入住" : "迟录退房";
  if (record.type === "CHECK_IN") return "按计划办理入住";
  return record.type === "REVOKE_CHECK_IN" ? "撤销误办入住" : "按计划办理退房";
}

export function effectiveArrangementTitle(presentation: OrderEffectiveArrangementPresentation): string {
  switch (presentation) {
    case "CURRENT": return "当前住宿安排";
    case "LAST": return "最后住宿安排";
    case "BEFORE_CANCELLATION": return "取消前安排";
    case "NO_SHOW_ORDER": return "未到订单安排";
    case "BEFORE_CHECK_IN_REVOCATION": return "撤销入住前安排";
  }
}

export function arrangementChangeLabel(type: OrderArrangementHistoryItemDto["type"]): string {
  switch (type) {
    case "INITIAL_BOOKING": return "创建预订";
    case "RESCHEDULE": return "调整住宿日期";
    case "EXTENSION": return "延长住宿";
    case "SHORTENING": return "缩短住宿";
    case "MOVE": return "更换房源";
    case "EARLY_CHECK_OUT": return "提前退房";
    case "CHECK_OUT_REVOCATION": return "撤销退房";
    case "HISTORICAL_STAY_CORRECTION": return "历史住宿安排修改";
  }
}

export function collectionFactTypeLabel(type: CollectionFactDto["fact_type"]): string {
  if (type === "COLLECTION") return "收款";
  if (type === "REFUND") return "退款";
  return "冲销";
}

export function collectionMethodLabel(method: string): string {
  const labels: Record<string, string> = {
    CASH: "现金",
    BANK_TRANSFER: "银行转账",
    CARD: "银行卡",
    WECOM: "企业微信",
    WECHAT: "微信",
    ALIPAY: "支付宝",
    OTHER: "其他方式"
  };
  return labels[method] ?? "其他方式";
}

export function pricingBasisLabel(basis: PricingRevisionDto["pricing_basis"]): string {
  switch (basis) {
    case "CHANNEL_CONTRACT": return "本单渠道应结金额";
    case "MANUAL_ADJUSTMENT": return "人工调价";
    case "MEMBER_ENTITLEMENT": return "会员权益计价";
    case "FREE": return "免费入住";
    case "POLICY": return "政策价";
  }
}

export function collectionDifferencePresentation(amount: MoneyDto): {
  label: "收款差额";
  amount: MoneyDto;
} {
  return {
    label: "收款差额",
    amount
  };
}

export function collectionAmountYuanInputToMinor(value: string): number | undefined {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return undefined;
  const [yuanPart, fractionPart = ""] = normalized.split(".");
  const minor = BigInt(yuanPart!) * 100n + BigInt(fractionPart.padEnd(2, "0") || "0");
  if (minor <= 0n || minor > BigInt(MAX_AMOUNT_MINOR)) return undefined;
  return Number(minor);
}

export function collectionAmountMinorToYuanInput(minorUnits: number): string {
  if (!Number.isSafeInteger(minorUnits) || minorUnits <= 0) return "";
  const yuan = Math.trunc(minorUnits / 100);
  const cents = minorUnits % 100;
  return cents === 0 ? String(yuan) : `${yuan}.${String(cents).padStart(2, "0")}`;
}

export function arrangementUnitLabel(units: ReadonlyMap<string, Pick<InventoryUnitDto, "code" | "name" | "building_code">>, inventoryUnitId: string): string {
  const unit = units.get(inventoryUnitId);
  if (!unit) return "房源名称暂不可用";
  return [unit.building_code ? `${unit.building_code}栋` : null, unit.name].filter(Boolean).join(" ");
}

function ArrangementDetails({ arrangement, units, omitIntervals = false, positionItems }: {
  arrangement: OrderArrangementDto;
  units: ReadonlyMap<string, Pick<InventoryUnitDto, "code" | "name" | "building_code">>;
  omitIntervals?: boolean;
  positionItems?: AccommodationPositionItem[];
}) {
  const positions = positionItems ?? [];
  return <dl className="detail-list" {...(positions.length ? { "data-testid": "accommodation-position-summary" } : {})}>
    {positions.map((item) => <div key={`position:${item.label}:${item.effectiveDate}:${item.inventoryUnitId}`}>
      <dt>{item.label}</dt>
      <dd><strong>{arrangementUnitLabel(units, item.inventoryUnitId)}</strong>{item.label === "当前住宿位置" ? <small> · 营业日 {formatDate(item.effectiveDate)}</small> : positions.length > 1 ? <small> · {formatDate(item.effectiveDate)} 起</small> : null}</dd>
    </div>)}
    <div><dt>整体周期</dt><dd>{formatDate(arrangement.arrivalDate)} 至 {formatDate(arrangement.departureDate)}</dd></div>
    {omitIntervals ? null : arrangement.intervals.map((interval, index) => <div key={`${interval.inventoryUnitId}:${interval.arrivalDate}:${interval.departureDate}`}>
      <dt>{arrangement.intervals.length > 1 ? `第 ${index + 1} 段房源` : "住宿房源"}</dt>
      <dd><strong>{arrangementUnitLabel(units, interval.inventoryUnitId)}</strong>{arrangement.intervals.length > 1 ? <small> · {formatDate(interval.arrivalDate)} 至 {formatDate(interval.departureDate)}</small> : null}</dd>
    </div>)}
  </dl>;
}

function ArrangementHistoryAmounts({ item, showPerOrderFunds, isLatest = false }: {
  item: OrderArrangementHistoryItemDto;
  showPerOrderFunds: boolean;
  isLatest?: boolean;
}) {
  const difference = collectionDifferencePresentation(item.fundsSummary.collectionDifference);
  const contractAmountLabel = showPerOrderFunds ? "订单金额" : isLatest ? "本单渠道应结金额" : "当时应结金额";
  return <dl className="detail-list">
    <div><dt>政策基础金额</dt><dd>{formatMoney(item.pricingSummary.policyBaseAmount)}</dd></div>
    <div><dt>{contractAmountLabel}{!showPerOrderFunds && !isLatest ? <span className="superseded-tag">已被后续调整取代</span> : null}</dt><dd>{formatMoney(item.pricingSummary.currentContractAmount)}</dd></div>
    <div><dt>与政策基础金额差额</dt><dd>{formatMoney(item.pricingSummary.differenceFromPolicy)}</dd></div>
    {showPerOrderFunds ? <>
      <div><dt>已记录净收款</dt><dd>{formatMoney(item.fundsSummary.netRecordedCollection)}</dd></div>
      <div><dt>当时{difference.label}</dt><dd>{formatMoney(difference.amount)}<small>当时订单金额减已记录净收款</small></dd></div>
    </> : null}
    {showPerOrderFunds && item.fundsSummary.refundReferenceAmount.minorUnits > 0 ? <>
      <div><dt>退款参考</dt><dd><strong>{formatMoney(item.fundsSummary.refundReferenceAmount)}</strong></dd></div>
      <div><dt>退款状态</dt><dd>该金额仅供工作人员办理退款参考，目前尚未登记退款。</dd></div>
    </> : null}
  </dl>;
}

function HistoricalStayCorrectionGroup({ item, units }: {
  item: OrderArrangementHistoryItemDto;
  units: ReadonlyMap<string, Pick<InventoryUnitDto, "code" | "name" | "building_code">>;
}) {
  const group = item.correctionGroup;
  if (!group) return null;
  const reasonNote = group.reason.note.trim();
  return <div className="historical-correction-group" data-testid="historical-stay-correction-group">
    {group.evidenceNote?.trim() ? <p className="muted compact">凭据说明：{group.evidenceNote.trim()}</p> : null}
    <div className="amendment-list compact-list">{group.corrections.map((correction, index) => (
      <section key={`${correction.correctionId}:${correction.orderId}`} data-testid="historical-stay-correction-atom">
        <header className="amendment-head">
          <strong>第 {index + 1} 笔同批修改</strong>
          <Link className="inline-link" to={`/orders/${encodeURIComponent(correction.orderId)}`}>查看第 {index + 1} 笔关联订单</Link>
        </header>
        <dl className="detail-list">
          <div><dt>修改前日期</dt><dd>{formatDate(correction.before.arrivalDate)} 至 {formatDate(correction.before.departureDate)}</dd></div>
          <div><dt>修改前房源</dt><dd><strong>{arrangementUnitLabel(units, correction.before.inventoryUnitId)}</strong></dd></div>
          <div><dt>修改后日期</dt><dd>{formatDate(correction.after.arrivalDate)} 至 {formatDate(correction.after.departureDate)}</dd></div>
          <div><dt>修改后房源</dt><dd><strong>{arrangementUnitLabel(units, correction.after.inventoryUnitId)}</strong></dd></div>
          <div><dt>修改原因</dt><dd>{reasonNote || "未填写修改说明"}</dd></div>
          <div><dt>操作人</dt><dd>{group.actor.displayName}</dd></div>
          <div><dt>操作时间</dt><dd>{formatDateTime(group.recordedAt)}</dd></div>
        </dl>
      </section>
    ))}</div>
  </div>;
}

export function OrderLifecycleSections({ view, inventoryUnits, showPerOrderFunds = true, channelPriceDifferenceReason }: {
  view: Pick<OrderViewDto, "originalArrangement" | "effectiveArrangement" | "fulfillment" | "arrangementHistory">;
  inventoryUnits: Array<Pick<InventoryUnitDto, "id" | "code" | "name" | "building_code">>;
  showPerOrderFunds?: boolean;
  channelPriceDifferenceReason?: string | undefined;
}) {
  const units = new Map(inventoryUnits.map((unit) => [unit.id, unit]));
  return <>
    <div className="detail-grid" data-testid="order-arrangements">
      <section className="detail-section" aria-labelledby="effective-arrangement-heading">
        <div className="section-title-row"><h2 id="effective-arrangement-heading">{effectiveArrangementTitle(view.effectiveArrangement.presentation)}</h2></div>
        <ArrangementDetails
          arrangement={view.effectiveArrangement}
          units={units}
          omitIntervals={view.effectiveArrangement.intervals.length === 1 && accommodationPositionItems(view).length > 0}
          positionItems={accommodationPositionItems(view)}
        />
      </section>
    </div>

    <section className="detail-section full-detail" aria-labelledby="fulfillment-heading" data-testid="order-fulfillment">
      <div className="section-title-row">
        <div className="section-title-with-help">
          <h2 id="fulfillment-heading">入住与退房结果</h2>
          <InfoHint text="这里显示的是系统办理营业日和记录时间，不代表住客实际到店或离店的精确时刻。" />
        </div>
      </div>
      <div className="amendment-list">
        <FulfillmentResult type="CHECK_IN" record={view.fulfillment.checkIn} />
        <FulfillmentResult type="CHECK_OUT" record={view.fulfillment.checkOut} />
        {view.fulfillment.checkInRevocation
          ? <FulfillmentResult type="REVOKE_CHECK_IN" record={view.fulfillment.checkInRevocation} />
          : null}
      </div>
    </section>

    <details className="detail-disclosure" data-testid="arrangement-history"><summary>住宿安排变更历史 · {view.arrangementHistory.length} 条</summary>
      <section className="detail-section" aria-labelledby="original-arrangement-heading">
        <div className="section-title-row"><h2 id="original-arrangement-heading">原始预订安排</h2></div>
        <ArrangementDetails arrangement={view.originalArrangement} units={units} />
      </section>
    <section className="detail-section full-detail" aria-labelledby="arrangement-history-heading">
      <div className="section-title-row"><h2 id="arrangement-history-heading">住宿安排变更历史</h2><span>{itemCountLabel(view.arrangementHistory.length)}</span></div>
      {!showPerOrderFunds && channelPriceDifferenceReason?.trim() ? <p className="muted compact">渠道价格差异说明：{channelPriceDifferenceReason.trim()}</p> : null}
      <div className="amendment-list">{view.arrangementHistory.map((item, index) => {
        const isCreation = !item.before;
        const reasonNote = item.reason.note.trim();
        return <article key={`${item.type}:${item.recordedAt}:${index}`}>
          <header className="amendment-head">
            <strong>第 {index + 1} 条 · {arrangementChangeLabel(item.type)}</strong>
            <span>{item.actor?.displayName ?? "历史未记录操作人"} · {formatDateTime(item.recordedAt)}</span>
          </header>
          {!isCreation || reasonNote ? <p className="amendment-reason">{reasonNote || "未填写变更说明"}</p> : null}
          <div className="amendment-columns">
            <div className="amendment-arrangements">
              {isCreation ? (
                <div>
                  <span className="amendment-col-title">住宿安排</span>
                  <ArrangementDetails arrangement={item.after} units={units} />
                </div>
              ) : (
                <>
                  <div>
                    <span className="amendment-col-title">变更前</span>
                    <ArrangementDetails arrangement={item.before!} units={units} />
                  </div>
                  <div>
                    <span className="amendment-col-title">变更后</span>
                    <ArrangementDetails arrangement={item.after} units={units} />
                  </div>
                </>
              )}
            </div>
            <div className="amendment-amounts">
              <span className="amendment-col-title">{isCreation ? "创建时金额" : "变更时金额"}</span>
              <ArrangementHistoryAmounts item={item} showPerOrderFunds={showPerOrderFunds} isLatest={index === view.arrangementHistory.length - 1} />
            </div>
          </div>
          <HistoricalStayCorrectionGroup item={item} units={units} />
        </article>;
      })}</div>
    </section>
    </details>
  </>;
}

export function CompleteStayCorrectionHistory({ view }: {
  view: Pick<OrderViewDto, "order" | "effectiveArrangement" | "amendments" | "amounts">;
}) {
  const records = completeStayCorrectionRecords(view.amendments);
  if (records.length === 0) return null;
  const externalChannel = Boolean(view.order.booking_channel_code
    && completeStayExternalChannelCodes.has(view.order.booking_channel_code));
  const settledWithoutDirectCollection = view.order.stay_type === "FREE"
    || Boolean(view.order.member_id || view.order.member_contract_id)
    || externalChannel;
  const settlementResult = settledWithoutDirectCollection || view.amounts.collectionDifference.minorUnits <= 0
    ? "已结单"
    : `欠款 ${formatMoney(view.amounts.collectionDifference)}`;

  return <section className="detail-section full-detail" aria-labelledby="complete-stay-correction-history-heading" data-testid="complete-stay-correction-history">
    <div className="section-title-row">
      <h2 id="complete-stay-correction-history-heading">住宿补录记录</h2>
      <span>{records.length} 条</span>
    </div>
    <div className="amendment-list">{records.map((record) => (
      <article key={record.commandId} data-testid="complete-stay-correction-history-item">
        <header className="amendment-head">
          <strong>完成住宿补录</strong>
          <span>{record.actor?.displayName ?? "历史未记录操作人"} · {formatDateTime(record.recordedAt)}</span>
        </header>
        <p className="amendment-reason">{record.reasonNote.trim() || "未填写补录说明"}</p>
        <dl className="detail-list">
          <div><dt>处理方式</dt><dd>保留原订单，由已预订一次完成为已退房</dd></div>
          <div><dt>住宿日期</dt><dd>{formatDate(view.effectiveArrangement.arrivalDate)} 至 {formatDate(view.effectiveArrangement.departureDate)}</dd></div>
          <div><dt>订单金额</dt><dd>{formatMoney(view.amounts.currentContractAmount)}</dd></div>
          <div><dt>处理结果</dt><dd>{settlementResult}</dd></div>
        </dl>
      </article>
    ))}</div>
  </section>;
}

function temporaryOtherRoomActualUnitLabel(unit: Pick<InventoryUnitDto, "code" | "name" | "building_code"> | undefined): string | undefined {
  if (!unit) return undefined;
  const roomName = unit.name.trim();
  const roomCode = unit.code.trim();
  const location = unit.building_code?.trim() ? `${unit.building_code.trim()}栋` : "";
  return [roomCode, location, roomName].filter(Boolean).join(" · ") || undefined;
}

export function TemporaryOtherRoomArrangementHistory({ view, inventoryUnits }: {
  view: Pick<OrderViewDto, "amendments">;
  inventoryUnits: readonly Pick<InventoryUnitDto, "id" | "code" | "name" | "building_code">[];
}) {
  const record = temporaryOtherRoomOrderRecord(view.amendments);
  if (!record) return null;
  const actualRoom = temporaryOtherRoomActualUnitLabel(inventoryUnits.find((unit) => unit.id === record.actualInventoryUnitId))
    ?? record.actualInventoryUnitId;
  return <section className="detail-section full-detail" aria-labelledby="temporary-other-room-arrangement-heading" data-testid="temporary-other-room-arrangement-history">
    <div className="section-title-row"><h2 id="temporary-other-room-arrangement-heading">本次临时安排其他房型</h2></div>
    <dl className="detail-list">
      <div><dt>原适用房型</dt><dd>{roomStatusRoomTypeLabel(record.originalRoomTypeCode)}</dd></div>
      <div><dt>实际房型</dt><dd>{roomStatusRoomTypeLabel(record.actualRoomTypeCode)}</dd></div>
      <div><dt>实际安排房间</dt><dd>{actualRoom}</dd></div>
      <div><dt>住宿日期</dt><dd>{formatDate(record.arrivalDate)} 至 {formatDate(record.departureDate)}</dd></div>
      <div><dt>安排原因</dt><dd>{record.reasonNote}</dd></div>
      <div><dt>操作人</dt><dd>{record.actor.displayName}</dd></div>
      <div><dt>操作时间</dt><dd>{formatDateTime(record.recordedAt)}</dd></div>
    </dl>
  </section>;
}

export function OrderAmountStrip({ amounts, pricingRevision, bookingChannelCode }: {
  amounts: OrderViewDto["amounts"];
  pricingRevision?: PricingRevisionDto | undefined;
  bookingChannelCode?: string | null;
}) {
  const showPerOrderFunds = stayDateFundsAreOperatorFacing(bookingChannelCode, pricingRevision?.pricing_basis);
  const difference = collectionDifferencePresentation(amounts.collectionDifference);
  if (!showPerOrderFunds && pricingRevision) {
    return <section className="amount-strip amount-strip-channel" aria-label="订单可复算金额" data-testid="order-amounts">
      <div><span>政策基础金额</span><strong>{formatMinor(pricingRevision.policy_base_amount_minor, pricingRevision.currency)}</strong></div>
      <div><span>本单渠道应结金额</span><strong>{formatMoney(amounts.currentContractAmount)}</strong></div>
      <div><span>与政策基础金额差额</span><strong>{formatMinor(pricingRevision.difference_from_policy_minor, pricingRevision.currency)}</strong></div>
      <div><span>渠道价格差异说明</span><strong className="amount-strip-note">{pricingRevision.reason.note.trim() || "无"}</strong></div>
    </section>;
  }
  return <section className="amount-strip" aria-label="订单可复算金额" data-testid="order-amounts">
    <div><span>住宿金额</span><strong>{formatMoney(amounts.currentContractAmount)}</strong></div>
    <div><span>已记录净收款</span><strong>{formatMoney(amounts.netRecordedCollection)}</strong></div>
    <div><span>{difference.label}</span><strong>{formatMoney(difference.amount)}</strong><small>{difference.amount.minorUnits > 0 ? "住宿金额减净收款，正数为尚差金额" : difference.amount.minorUnits < 0 ? "住宿金额减净收款，负数为多收；退款需核对原收款" : "住宿金额与已记录净收款一致"}</small></div>
    {amounts.refundReferenceAmount.minorUnits > 0 ? <div><span>退款参考</span><strong>{formatMoney(amounts.refundReferenceAmount)}</strong><small>尚未登记退款</small></div> : null}
  </section>;
}

function FulfillmentResult({ type, record }: {
  type: "CHECK_IN" | "CHECK_OUT" | "REVOKE_CHECK_IN";
  record: OrderFulfillmentRecordDto | null;
}) {
  const isCheckIn = type === "CHECK_IN";
  const isRevocation = type === "REVOKE_CHECK_IN";
  const heading = isCheckIn ? "入住结果" : isRevocation ? "撤销入住结果" : "退房结果";
  return (
    <article data-testid={isCheckIn ? "check-in-result" : isRevocation ? "check-in-revocation-result" : "check-out-result"}>
      <div>
        <strong>{heading}</strong>
        <span>{record ? fulfillmentResultLabel(record) : `未办理${isCheckIn ? "入住" : isRevocation ? "撤销入住" : "退房"}`}</span>
      </div>
      {record ? <dl className="detail-list">
        <div><dt>{isCheckIn || isRevocation ? "计划入住日" : "计划退房日"}</dt><dd>{formatDate(record.plannedBusinessDate)}</dd></div>
        <div><dt>办理营业日</dt><dd>{record.recordedBusinessDate ? formatDate(record.recordedBusinessDate) : "历史未记录"}</dd></div>
        <div><dt>记录时间</dt><dd>{formatDateTime(record.recordedAt)}</dd></div>
        <div><dt>操作人</dt><dd>{record.actor?.displayName ?? "历史未记录"}</dd></div>
        <div><dt>办理备注</dt><dd>{record.reason.note.trim() || fulfillmentResultLabel(record)}</dd></div>
      </dl> : null}
    </article>
  );
}

interface StayConversionTransferCollection extends CollectionFactDto {
  transferAmountMinor: number;
}

export interface StayConversionFundsState {
  transferableCollections: StayConversionTransferCollection[];
  transferTotalMinor: number;
  zeroCollectionOrder: boolean;
  refundedToZero: boolean;
  disabledReason?: string;
}

export function stayConversionFundsState(
  facts: readonly CollectionFactDto[],
  netRecordedMinor: number,
  expectedCurrency?: string
): StayConversionFundsState {
  const sourceCollections = facts.filter((fact) => fact.fact_type === "COLLECTION");
  const sourceCollectionIds = new Set(sourceCollections.map((fact) => fact.fact_id));
  const refundedBySource = new Map<string, number>();
  const invalidFundGraph = facts.some((fact) => fact.fact_type !== "COLLECTION" && fact.fact_type !== "REFUND")
    || sourceCollections.some((fact) => fact.amount_minor <= 0
      || fact.net_effect_minor !== fact.amount_minor
      || (expectedCurrency !== undefined && fact.currency !== expectedCurrency)
      || fact.method !== "WECOM"
      || !fact.transaction_reference
      || fact.references_fact_id !== null
      || fact.reverses_fact_id !== null
      || fact.transfer)
    || facts.some((fact) => {
      if (fact.fact_type !== "REFUND") return false;
      if (fact.amount_minor <= 0
        || fact.net_effect_minor !== -fact.amount_minor
        || (expectedCurrency !== undefined && fact.currency !== expectedCurrency)
        || fact.method !== "WECOM"
        || fact.transaction_reference !== null
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
  const residualsAreValid = sourceCollections.every((fact) => (refundedBySource.get(fact.fact_id) ?? 0) <= fact.amount_minor);
  const transferableCollections = !invalidFundGraph && residualsAreValid
    ? sourceCollections.flatMap((fact) => {
      const transferAmountMinor = fact.amount_minor - (refundedBySource.get(fact.fact_id) ?? 0);
      return transferAmountMinor > 0 ? [{ ...fact, transferAmountMinor }] : [];
    })
    : [];
  const transferTotalMinor = transferableCollections.reduce((sum, fact) => sum + fact.transferAmountMinor, 0);
  const zeroCollectionOrder = facts.length === 0 && netRecordedMinor === 0;
  const refundedToZero = facts.length > 0 && transferTotalMinor === 0 && !invalidFundGraph && residualsAreValid;
  const disabledReason = facts.length === 0
    ? netRecordedMinor === 0 ? undefined : "住宿资金汇总与明细不一致，请先核对住宿收款记录。"
    : invalidFundGraph || !residualsAreValid
      ? "订单存在非企微、冲销或无法核对的住宿收退款记录，不能升级会员。"
      : transferTotalMinor !== netRecordedMinor
        ? "当前可转入企微收款无法覆盖全部已记录净收款，请先核对住宿收退款记录。"
        : undefined;
  return {
    transferableCollections,
    transferTotalMinor,
    zeroCollectionOrder,
    refundedToZero,
    ...(disabledReason ? { disabledReason } : {})
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export interface StayConversionEntitlementDisplay {
  serviceStart: string;
  serviceEnd: string;
  consumedUnits: number;
  unitLabel: "间夜" | "床夜";
  memberName?: string;
  productName?: string;
  memberId?: string;
  membershipOrderId?: string;
}

export function stayConversionEntitlementDisplay(view: OrderViewDto): StayConversionEntitlementDisplay | undefined {
  const conversion = [...view.amendments].reverse().find((amendment) =>
    amendment.amendment_type === "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP"
      || amendment.amendment_type === "VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY");
  if (!conversion || !isRecord(conversion.payload)) return undefined;
  const entitlement = isRecord(conversion.payload.entitlement) ? conversion.payload.entitlement : undefined;
  const serviceDates = Array.isArray(entitlement?.serviceDates)
    ? entitlement.serviceDates.filter((value): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)).sort()
    : [];
  const consumedUnits = typeof entitlement?.consumedUnits === "number" && Number.isSafeInteger(entitlement.consumedUnits) && entitlement.consumedUnits > 0
    ? entitlement.consumedUnits
    : serviceDates.length;
  if (consumedUnits <= 0) return undefined;
  const serviceStart = serviceDates[0] ?? view.order.arrival_date;
  const serviceEnd = serviceDates.length ? shiftDate(serviceDates[serviceDates.length - 1]!, 1) : view.order.departure_date;
  const member = isRecord(conversion.payload.member) ? conversion.payload.member : undefined;
  const product = isRecord(conversion.payload.product) ? conversion.payload.product : undefined;
  const newMembership = isRecord(conversion.payload.newMembership) ? conversion.payload.newMembership : undefined;
  const transferredFact = view.collectionFacts.find((fact) => fact.transfer);
  const memberId = view.membershipConversion?.memberId
    ?? (typeof member?.memberId === "string" ? member.memberId : transferredFact?.transfer?.memberId);
  const membershipOrderId = view.membershipConversion?.membershipOrderId ?? transferredFact?.transfer?.membershipOrderId;
  return {
    serviceStart,
    serviceEnd,
    consumedUnits,
    unitLabel: entitlement?.entitlementUnitKind === "BED_NIGHT" || entitlement?.unitKind === "BED_NIGHT" ? "床夜" : "间夜",
    ...(typeof member?.fullName === "string" && member.fullName.trim() ? { memberName: member.fullName } : {}),
    ...(typeof product?.name === "string" && product.name.trim()
      ? { productName: product.name }
      : typeof newMembership?.productName === "string" && newMembership.productName.trim()
        ? { productName: newMembership.productName }
        : {}),
    ...(memberId ? { memberId } : {}),
    ...(membershipOrderId ? { membershipOrderId } : {})
  };
}

export function OrderMembershipCoverageSection({ view, unitMap }: {
  view: OrderViewDto;
  unitMap: ReadonlyMap<string, InventoryUnitDto>;
}) {
  const conversionEntitlement = stayConversionEntitlementDisplay(view);
  const coverageDisplayCount = view.coverageSet.length ? view.coverageSet.length : conversionEntitlement ? 1 : 0;
  return (
    <section className="detail-section full-detail" aria-labelledby="coverage-table-heading">
      <div className="section-title-row"><h2 id="coverage-table-heading">会员权益覆盖</h2><span>{itemCountLabel(coverageDisplayCount)}</span></div>
      {view.coverageSet.length ? (
        <>
          <div className="table-region" role="region" aria-label="会员覆盖" tabIndex={0}>
            <table className="data-table compact-table">
              <thead><tr><th scope="col">服务日期</th><th scope="col">住宿位置</th><th scope="col">权益类型</th><th scope="col">状态</th></tr></thead>
              <tbody>{view.coverageSet.map((coverage) => <tr key={coverage.id}><td>{coverage.service_date}</td><td>{unitMap.get(coverage.inventory_unit_id)?.code ?? "房源"}</td><td>{coverage.unit_kind === "ROOM_NIGHT" ? "间夜" : "床夜"}</td><td><StatusBadge value={coverage.status} label={businessStatusLabel(coverage.status)} /></td></tr>)}</tbody>
            </table>
          </div>
          {conversionEntitlement ? <div className="coverage-conversion-trace" data-testid="stay-membership-conversion-trace">
            <div>
              <strong>升级会员核销</strong>
              <span>{formatDate(conversionEntitlement.serviceStart)} 至 {formatDate(conversionEntitlement.serviceEnd)} · {conversionEntitlement.consumedUnits} {conversionEntitlement.unitLabel}</span>
              <small>{conversionEntitlement.productName ?? "会员产品"}{conversionEntitlement.memberName ? ` · ${conversionEntitlement.memberName}` : ""}</small>
            </div>
            {conversionEntitlement.memberId && conversionEntitlement.membershipOrderId
              ? <Link className="inline-link" to={`/members?memberId=${encodeURIComponent(conversionEntitlement.memberId)}&membershipOrderId=${encodeURIComponent(conversionEntitlement.membershipOrderId)}`}>查看会员订单</Link>
              : null}
          </div> : null}
        </>
      ) : conversionEntitlement ? (
        <div className="table-region" role="region" aria-label="升级会员核销" tabIndex={0}>
          <table className="data-table compact-table">
            <thead><tr><th scope="col">来源</th><th scope="col">住宿期间</th><th scope="col">核销权益</th><th scope="col">会员产品</th><th scope="col">状态</th><th scope="col">操作</th></tr></thead>
            <tbody>
              <tr>
                <th scope="row">升级会员核销</th>
                <td>{formatDate(conversionEntitlement.serviceStart)} 至 {formatDate(conversionEntitlement.serviceEnd)}</td>
                <td>{conversionEntitlement.consumedUnits} {conversionEntitlement.unitLabel}</td>
                <td>
                  {conversionEntitlement.productName ?? "会员产品"}
                  {conversionEntitlement.memberName ? <small>{conversionEntitlement.memberName}</small> : null}
                </td>
                <td><StatusBadge value="CONSUMED" label="已核销" /></td>
                <td>{conversionEntitlement.memberId && conversionEntitlement.membershipOrderId
                  ? <Link className="inline-link" to={`/members?memberId=${encodeURIComponent(conversionEntitlement.memberId)}&membershipOrderId=${encodeURIComponent(conversionEntitlement.membershipOrderId)}`}>查看会员订单</Link>
                  : "—"}</td>
              </tr>
            </tbody>
          </table>
        </div>
      ) : <EmptyState title="没有会员覆盖" detail="此订单未使用会员住宿权益。" />}
    </section>
  );
}

export function CollectionFactNote({ fact }: { fact: CollectionFactDto }) {
  if (fact.transfer) {
    return <span className="fact-transfer-note">
      已用于升级会员
      <Link className="inline-link" to={`/members?memberId=${encodeURIComponent(fact.transfer.memberId)}&membershipOrderId=${encodeURIComponent(fact.transfer.membershipOrderId)}`}>查看会员订单</Link>
    </span>;
  }
  if (fact.method === "CASH") {
    const collector = fact.cash_collector?.trim();
    if (!collector) {
      return <span className="fact-cash-note">收款人：{fact.note?.trim() || "历史未记录"}</span>;
    }
    return <span className="fact-cash-note">
      <span>收款人：{collector}</span>
      <span>备注：{fact.note || "未填写"}</span>
    </span>;
  }
  return <>{fact.note || "未填写"}</>;
}

function membershipProductOptionLabel(product: MembershipProductDto): string {
  const unit = product.entitlement_unit_kind === "ROOM_NIGHT" ? "间夜" : "床夜";
  return `${product.name} · ${product.entitlement_units} ${unit} · ${formatMinor(product.list_price_minor, product.currency)}`;
}

function memberOptionLabel(member: MemberDto): string {
  return `${member.full_name} · ${member.phone}`;
}

function conversionCollectionTimeLabel(value: string): string {
  return formatDateTime(value).replace(/\s+/g, " ");
}

function StayCollectionConversionDialog({ view, members, membershipProducts, unitMap, draft, onClose, onSubmit }: {
  view: OrderViewDto;
  members: readonly MemberDto[];
  membershipProducts: readonly MembershipProductDto[];
  unitMap: ReadonlyMap<string, InventoryUnitDto>;
  draft?: CommandRequest;
  onClose: () => void;
  onSubmit: (request: CommandRequest) => void;
}) {
  const primary = primaryOrderOccupant(orderedOrderOccupants(view.occupants));
  const primaryPhone = normalizePhoneNumber(primary?.phone);
  const matchedMembers = primaryPhone
    ? members.filter((member) => normalizePhoneNumber(member.phone) === primaryPhone)
    : [];
  const eligibleProducts = membershipProducts.filter((product) => membershipProductMatchesCurrentStay(product, view, unitMap));
  const fundsState = stayConversionFundsState(
    view.collectionFacts,
    view.amounts.netRecordedCollection.minorUnits,
    view.amounts.netRecordedCollection.currency
  );
  const { transferableCollections, transferTotalMinor, zeroCollectionOrder, refundedToZero } = fundsState;
  const draftInput = draft?.input ?? {};
  const draftMemberId = typeof draftInput.memberId === "string" ? draftInput.memberId : undefined;
  const draftProductId = typeof draftInput.membershipProductId === "string" ? draftInput.membershipProductId : undefined;
  const initialProduct = eligibleProducts.find((product) => product.id === draftProductId) ?? eligibleProducts[0];
  const [memberId, setMemberId] = useState(draftMemberId && matchedMembers.some((member) => member.id === draftMemberId) ? draftMemberId : matchedMembers[0]?.id ?? "");
  const [productId, setProductId] = useState(initialProduct?.id ?? "");
  const selectedProduct = eligibleProducts.find((product) => product.id === productId);
  const [agreedPriceYuan, setAgreedPriceYuan] = useState(() => {
    const draftPrice = typeof draftInput.agreedPriceMinor === "number" ? draftInput.agreedPriceMinor : undefined;
    return String((draftPrice ?? initialProduct?.list_price_minor ?? 0) / 100);
  });
  const [priceAdjustmentReason, setPriceAdjustmentReason] = useState(typeof draftInput.priceAdjustmentReason === "string" ? draftInput.priceAdjustmentReason : "");
  const [remainingPaymentTransactionReference, setRemainingPaymentTransactionReference] = useState(typeof draftInput.remainingPaymentTransactionReference === "string" ? draftInput.remainingPaymentTransactionReference : "");
  const [remainingPaymentNote, setRemainingPaymentNote] = useState(typeof draftInput.remainingPaymentNote === "string" ? draftInput.remainingPaymentNote : "");
  const [validationError, setValidationError] = useState<unknown>();
  const agreedPriceMinor = formalMembershipAgreedPriceMinor(agreedPriceYuan);
  const remainingMinor = agreedPriceMinor === undefined ? undefined : agreedPriceMinor - transferTotalMinor;
  const sourceTransactionReferences = new Set(view.collectionFacts
    .filter((fact) => fact.fact_type === "COLLECTION")
    .map((fact) => fact.transaction_reference)
    .filter((value): value is string => Boolean(value)));
  const disabledReason = !primaryPhone ? "主要住宿人缺少手机号，不能升级会员。"
    : matchedMembers.length === 0 ? "没有找到手机号一致的会员，请先创建或核对会员档案。"
      : eligibleProducts.length === 0 ? "当前住宿房型没有匹配的会员产品。"
        : fundsState.disabledReason;

  useEffect(() => {
    if (!selectedProduct) return;
    if (draft?.commandType === "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP") return;
    setAgreedPriceYuan(String(selectedProduct.list_price_minor / 100));
    setPriceAdjustmentReason("");
    setRemainingPaymentTransactionReference("");
    setRemainingPaymentNote("");
    setValidationError(undefined);
  }, [selectedProduct?.id]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setValidationError(undefined);
    if (disabledReason) {
      setValidationError(new Error(disabledReason));
      return;
    }
    if (!memberId) {
      setValidationError(new Error("请选择手机号一致的会员"));
      return;
    }
    if (!selectedProduct) {
      setValidationError(new Error("请选择匹配的会员产品"));
      return;
    }
    if (agreedPriceMinor === undefined || agreedPriceMinor <= 0) {
      setValidationError(new Error("正式会员成交价必须是大于零的整元金额"));
      return;
    }
    if (agreedPriceMinor < transferTotalMinor) {
      setValidationError(new Error("会员成交价不能低于本次用于升级的住宿收款合计"));
      return;
    }
    if (agreedPriceMinor !== selectedProduct.list_price_minor && !priceAdjustmentReason.trim()) {
      setValidationError(new Error("修改会员成交价时必须填写调价原因"));
      return;
    }
    if (agreedPriceMinor === selectedProduct.list_price_minor && priceAdjustmentReason.trim()) {
      setValidationError(new Error("未修改会员成交价时不需要填写调价原因"));
      return;
    }
    const remaining = agreedPriceMinor - transferTotalMinor;
    if (remaining > 0 && !remainingPaymentTransactionReference.trim()) {
      setValidationError(new Error("会员成交价高于转入住宿收款时，必须填写差额企业微信交易单号"));
      return;
    }
    if (remaining === 0 && remainingPaymentTransactionReference.trim()) {
      setValidationError(new Error("没有差额收款时不需要填写差额企业微信交易单号"));
      return;
    }
    if (remainingPaymentTransactionReference.trim() && sourceTransactionReferences.has(remainingPaymentTransactionReference.trim())) {
      setValidationError(new Error("差额收款必须填写新的企业微信交易单号，不能重复使用住宿收款的交易单号"));
      return;
    }
    onSubmit({
      commandType: "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP",
      title: "升级会员",
      description: "",
      input: {
        propertyId: view.order.property_id,
        orderId: view.order.id,
        memberId,
        membershipProductId: selectedProduct.id,
        collectionFactIds: transferableCollections.map((fact) => fact.fact_id),
        agreedPriceMinor,
        ...(priceAdjustmentReason.trim() ? { priceAdjustmentReason: priceAdjustmentReason.trim() } : {}),
        ...(remaining > 0 ? { remainingPaymentTransactionReference: remainingPaymentTransactionReference.trim() } : {}),
        ...(remaining > 0 && remainingPaymentNote.trim() ? { remainingPaymentNote: remainingPaymentNote.trim() } : {})
      },
      initialReason: { code: "STAY_COLLECTION_TO_MEMBERSHIP", note: "升级会员" }
    });
  }

  return <Modal title="升级会员" onClose={onClose} footer={null}>
    <form className="modal-form" onSubmit={submit} noValidate>
      <InlineError error={validationError} title="无法继续" />
      {disabledReason ? <div className="form-field-note" role="status"><strong>当前暂不能升级会员</strong><span>{disabledReason}</span></div> : null}
      <div className="form-grid form-grid-two">
        <label className="span-two">目标会员
          <select value={memberId} onChange={(event) => { setMemberId(event.target.value); setValidationError(undefined); }} disabled={Boolean(disabledReason) || matchedMembers.length === 0} required>
            {matchedMembers.map((member) => <option key={member.id} value={member.id}>{memberOptionLabel(member)}</option>)}
          </select>
        </label>
        <label className="span-two">会员产品
          <select value={productId} onChange={(event) => { setProductId(event.target.value); setValidationError(undefined); }} disabled={Boolean(disabledReason) || eligibleProducts.length === 0} required>
            {eligibleProducts.map((product) => <option key={product.id} value={product.id}>{membershipProductOptionLabel(product)}</option>)}
          </select>
        </label>
        <div className="span-two conversion-transfer-card">
          <div className="conversion-transfer-heading">
            <div>
              <strong>用于升级的住宿收款</strong>
              <span>以下住宿收款的当前留存净额将作为会员订单已收款，住宿订单不再重复计入。</span>
            </div>
            <strong>{formatMinor(transferTotalMinor, view.amounts.netRecordedCollection.currency)}</strong>
          </div>
          {transferableCollections.length ? <ol className="conversion-transfer-list">
            {transferableCollections.map((fact, index) => <li key={fact.fact_id}>
              <span>第 {index + 1} 笔</span>
              <strong>{formatMinor(fact.transferAmountMinor, fact.currency)}</strong>
              <small>企业微信交易单号：{collectionFactTransactionReferenceLabel(view.collectionFacts, fact)}</small>
              <small>登记时间：{conversionCollectionTimeLabel(fact.created_at)}</small>
            </li>)}
          </ol> : <span className="muted">{zeroCollectionOrder
            ? "本订单没有已登记收款，升级会员将按会员成交价全额收取差额。"
            : refundedToZero
              ? "本订单企业微信住宿收款均已退款，升级会员将按会员成交价全额收取差额。"
            : "没有可用于升级会员的企业微信住宿收款。"}</span>}
        </div>
        <label>会员成交价（元）<input type="number" min="1" max="21474836" step="1" inputMode="numeric" value={agreedPriceYuan} onChange={(event) => { setAgreedPriceYuan(event.target.value); setValidationError(undefined); }} required disabled={Boolean(disabledReason)} /></label>
        <div className="form-calculated-field"><span>差额企微收款</span><strong>{remainingMinor === undefined ? "-" : formatMinor(Math.max(0, remainingMinor), view.amounts.netRecordedCollection.currency)}</strong></div>
        {selectedProduct && agreedPriceMinor !== undefined && agreedPriceMinor !== selectedProduct.list_price_minor ? <label className="span-two">调价原因<textarea rows={2} value={priceAdjustmentReason} onChange={(event) => { setPriceAdjustmentReason(event.target.value); setValidationError(undefined); }} required maxLength={1000} /></label> : null}
        {remainingMinor !== undefined && remainingMinor > 0 ? <>
          <ExternalPaymentPicker propertyId={view.order.property_id} value={remainingPaymentTransactionReference} amountMinor={remainingMinor} label="选择差额企业微信收款" testId="conversion-remaining-payment-reference" onChange={reference => { setRemainingPaymentTransactionReference(reference); setValidationError(undefined); }} />
          <label className="span-two">差额收款备注（选填）<textarea rows={2} value={remainingPaymentNote} onChange={(event) => setRemainingPaymentNote(event.target.value)} maxLength={1000} /></label>
        </> : null}
      </div>
      <div className="form-actions"><button type="button" className="button button-secondary" onClick={onClose}>取消</button><button type="submit" className="button button-primary" disabled={Boolean(disabledReason)}>下一步</button></div>
    </form>
  </Modal>;
}

function completeStayDraftCollection(draft: CommandRequest | undefined): Record<string, unknown> | undefined {
  const value = draft?.input.collection;
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function CompleteStayDialog({ view, draft, onClose, onSubmit }: {
  view: OrderViewDto;
  draft?: CommandRequest;
  onClose: () => void;
  onSubmit: (request: CommandRequest) => void;
}) {
  const operatorFacingDirectOrder = view.order.stay_type !== "FREE"
    && !view.order.member_id
    && !view.order.member_contract_id
    && !(view.order.booking_channel_code && completeStayExternalChannelCodes.has(view.order.booking_channel_code));
  const outstandingMinor = view.amounts.collectionDifference.minorUnits;
  const canRecordCollection = operatorFacingDirectOrder && outstandingMinor > 0;
  const draftCollection = completeStayDraftCollection(draft);
  const [confirmed, setConfirmed] = useState(draft?.input.actualStayCompletedConfirmed === true);
  const [reasonNote, setReasonNote] = useState(typeof draft?.initialReason?.note === "string" ? draft.initialReason.note : "");
  const [recordCollection, setRecordCollection] = useState(Boolean(draftCollection));
  const [amountYuan, setAmountYuan] = useState(
    draftCollection && typeof draftCollection.amountMinor === "number"
      ? collectionAmountMinorToYuanInput(draftCollection.amountMinor)
      : ""
  );
  const [method, setMethod] = useState(
    draftCollection && typeof draftCollection.method === "string" ? draftCollection.method : "WECOM"
  );
  const [transactionReference, setTransactionReference] = useState(
    draftCollection && typeof draftCollection.transactionReference === "string" ? draftCollection.transactionReference : ""
  );
  const [cashCollector, setCashCollector] = useState(
    draftCollection && typeof draftCollection.cashCollector === "string" ? draftCollection.cashCollector : ""
  );
  const [note, setNote] = useState(
    draftCollection && typeof draftCollection.note === "string" ? draftCollection.note : ""
  );
  const [validationError, setValidationError] = useState<unknown>();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setValidationError(undefined);
    if (!confirmed) {
      setValidationError(new Error("请先确认客人实际入住且已经离店"));
      return;
    }
    const trimmedReason = reasonNote.trim();
    if (!trimmedReason) {
      setValidationError(new Error("请填写完成住宿的说明"));
      return;
    }
    let collection: Record<string, unknown> | undefined;
    if (canRecordCollection && recordCollection) {
      const amountMinor = collectionAmountYuanInputToMinor(amountYuan);
      if (!amountMinor) {
        setValidationError(new Error("请填写有效的实收金额"));
        return;
      }
      if (amountMinor > outstandingMinor) {
        setValidationError(new Error("实收金额不能超过订单未结余额"));
        return;
      }
      if (method === "CASH") {
        if (!cashCollector.trim()) {
          setValidationError(new Error("现金收款必须填写收款人"));
          return;
        }
        if (!note.trim()) {
          setValidationError(new Error("现金收款必须填写备注"));
          return;
        }
        collection = {
          amountMinor,
          method,
          cashCollector: cashCollector.trim(),
          note: note.trim()
        };
      } else {
        if (!transactionReference.trim()) {
          setValidationError(new Error(method === "WECOM" ? "请填写企业微信交易单号" : "请填写银行转账交易单号或流水号"));
          return;
        }
        collection = {
          amountMinor,
          method,
          transactionReference: transactionReference.trim(),
          ...(note.trim() ? { note: note.trim() } : {})
        };
      }
    }
    onSubmit({
      commandType: "COMPLETE_STAY",
      title: "完成住宿",
      description: completeStayOperatorCopy.reviewDescription,
      presentation: "COMPLETE_STAY",
      input: {
        propertyId: view.order.property_id,
        orderId: view.order.id,
        actualStayCompletedConfirmed: true,
        reasonNote: trimmedReason,
        ...(collection ? { collection } : {})
      },
      initialReason: { code: "COMPLETE_STAY", note: trimmedReason }
    });
  }

  return <Modal title="完成住宿" onClose={onClose} footer={null}>
    <form className="modal-form" onSubmit={submit} noValidate>
      <InlineError error={validationError} title="无法继续" />
      <div className="form-grid">
        <div className="span-two form-field-note" role="status">
          <strong>{completeStayOperatorCopy.contextTitle}</strong>
          <span>{completeStayOperatorCopy.contextDetail}</span>
        </div>
        <label className="span-two check-row">
          <input type="checkbox" checked={confirmed} onChange={(event) => { setConfirmed(event.target.checked); setValidationError(undefined); }} required data-testid="complete-stay-confirmed" />
          <span>{completeStayOperatorCopy.confirmationLabel}</span>
        </label>
        <label className="span-two">说明
          <textarea value={reasonNote} onChange={(event) => { setReasonNote(event.target.value); setValidationError(undefined); }} required maxLength={1000} rows={3} placeholder="例如：客人实际入住 8/6–8/11，8/11 已离店，当时忘记办理退房。" data-testid="complete-stay-reason" />
        </label>
        {canRecordCollection ? (
          <label className="span-two check-row">
            <input type="checkbox" checked={recordCollection} onChange={(event) => { setRecordCollection(event.target.checked); setValidationError(undefined); }} data-testid="complete-stay-record-collection" />
            <span>同时登记本次实际收到的款项（可跳过；未收清将显示“欠款”）</span>
          </label>
        ) : null}
        {canRecordCollection && recordCollection ? (
          <div className="form-grid span-two">
            <label>实收金额（元）<input type="text" value={amountYuan} onChange={(event) => { setAmountYuan(event.target.value); setValidationError(undefined); }} required inputMode="decimal" placeholder="例如 1280.50" data-testid="complete-stay-amount" /></label>
            <label>收款方式<select value={method} onChange={(event) => { setMethod(event.target.value); setTransactionReference(""); setValidationError(undefined); }}><option value="WECOM">企业微信</option><option value="BANK_TRANSFER">银行转账</option><option value="CASH">现金</option></select></label>
            {method === "CASH" ? <>
              <label>收款人<input value={cashCollector} onChange={(event) => { setCashCollector(event.target.value); setValidationError(undefined); }} required maxLength={200} data-testid="complete-stay-cash-collector" /></label>
              <label className="span-two">现金备注<textarea rows={2} value={note} onChange={(event) => { setNote(event.target.value); setValidationError(undefined); }} required maxLength={1000} data-testid="complete-stay-cash-note" /></label>
            </> : <>
              method === "WECOM" ? <ExternalPaymentPicker propertyId={view.order.property_id} value={transactionReference} amountMinor={Math.round(Number(amountYuan) * 100) || outstandingMinor} testId="complete-stay-transaction-reference" onChange={(reference, item) => { setTransactionReference(reference); if (item?.amountMinor) setAmountYuan(collectionAmountMinorToYuanInput(item.amountMinor)); setValidationError(undefined); }} /> : <label className="span-two">银行转账单号 / 流水号<input value={transactionReference} onChange={(event) => { setTransactionReference(event.target.value); setValidationError(undefined); }} required maxLength={200} data-testid="complete-stay-transaction-reference" /></label>
              <label className="span-two">备注（选填）<textarea rows={2} value={note} onChange={(event) => { setNote(event.target.value); setValidationError(undefined); }} maxLength={1000} /></label>
            </>}
          </div>
        ) : null}
        {canRecordCollection && !recordCollection && outstandingMinor > 0 ? <div className="span-two form-field-note" role="status">
          <strong>未收清将显示“欠款”</strong>
          <span>本次不登记收款；订单完成住宿后仍保留欠款，可在订单详情后续补收。</span>
        </div> : null}
      </div>
      <div className="form-actions"><button type="button" className="button button-secondary" onClick={onClose}>取消</button><button type="submit" className="button button-primary" data-testid="complete-stay-submit">核对并完成住宿</button></div>
    </form>
  </Modal>;
}

function ActionFormDialog({ action, view, initialFactId, draft, writeBlocked = false, onClose, onSubmit }: {
  action: FormAction;
  view: OrderViewDto;
  initialFactId?: string;
  draft?: CommandRequest;
  writeBlocked?: boolean;
  onClose: () => void;
  onSubmit: (request: CommandRequest) => void;
}) {
  const collections = view.collectionFacts.filter((fact) => fact.fact_type === "COLLECTION");
  const refundableCollections = collections.filter((fact) => remainingRefundableMinor(view.collectionFacts, fact) > 0);
  const initialSelectedFactId = initialFactId ?? refundableCollections[0]?.fact_id ?? "";
  const reversibleFacts = view.collectionFacts.filter((fact) => collectionFactCanReverse(view.collectionFacts, fact, true));
  const draftReverseFactId = typeof draft?.input.reversesFactId === "string" ? draft.input.reversesFactId : undefined;
  const initialReverseFactId = action === "REVERSE_FACT"
    ? (initialFactId && reversibleFacts.some((fact) => fact.fact_id === initialFactId)
      ? initialFactId
      : draftReverseFactId && reversibleFacts.some((fact) => fact.fact_id === draftReverseFactId)
        ? draftReverseFactId
        : reversibleFacts[0]?.fact_id ?? "")
    : "";
  const recordedExcessMinor = view.amounts.refundReferenceAmount.minorUnits;
  function selectedRefundCollectionFor(collectionFactId: string): CollectionFactDto | undefined {
    return collections.find((fact) => fact.fact_id === collectionFactId);
  }
  function suggestedRefundFor(collectionFactId: string): number {
    const collection = selectedRefundCollectionFor(collectionFactId);
    if (!collection) return 0;
    return Math.min(recordedExcessMinor, remainingRefundableMinor(view.collectionFacts, collection));
  }
  const initialSuggestedRefund = action === "RECORD_REFUND" ? suggestedRefundFor(initialSelectedFactId) : 0;
  const initialRefundMethod = action === "RECORD_REFUND" ? selectedRefundCollectionFor(initialSelectedFactId)?.method ?? "WECOM" : "WECOM";
  const initialReverseNote = typeof draft?.input.note === "string"
    ? draft.input.note
    : draft?.initialReason?.note ?? "";
  const [amountYuan, setAmountYuan] = useState(initialSuggestedRefund > 0 ? collectionAmountMinorToYuanInput(initialSuggestedRefund) : "");
  const [method, setMethod] = useState(initialRefundMethod);
  const [note, setNote] = useState(action === "REVERSE_FACT" ? initialReverseNote : "");
  const [transactionReference, setTransactionReference] = useState("");
  const [refundReference, setRefundReference] = useState("");
  const [factId, setFactId] = useState(initialSelectedFactId);
  const [reverseFactId, setReverseFactId] = useState(initialReverseFactId);
  const selectedRefundCollection = action === "RECORD_REFUND" ? selectedRefundCollectionFor(factId) : undefined;
  const selectedReverseFact = action === "REVERSE_FACT"
    ? reversibleFacts.find((fact) => fact.fact_id === reverseFactId)
    : undefined;
  const selectedRefundRemainingMinor = selectedRefundCollection ? remainingRefundableMinor(view.collectionFacts, selectedRefundCollection) : 0;
  const transactionReferenceRequired = action === "RECORD_COLLECTION"
    ? method === "WECOM" || method === "BANK_TRANSFER"
    : method === "BANK_TRANSFER";
  const [newDepartureDate, setNewDepartureDate] = useState(action === "SHORTEN_STAY" ? shiftDate(view.order.departure_date, -1) : shiftDate(view.order.departure_date, 1));
  const [targetContractYuan, setTargetContractYuan] = useState(() => initialRepriceTargetYuan(
    view.amounts.currentContractAmount.minorUnits,
    draft?.input.targetCurrentContractAmountMinor
  ));
  const [repriceReason, setRepriceReason] = useState(draft?.initialReason?.note ?? "");
  const [validationError, setValidationError] = useState<unknown>();

  useEffect(() => {
    if (action !== "RECORD_REFUND") return;
    const suggested = suggestedRefundFor(factId);
    setAmountYuan(suggested > 0 ? collectionAmountMinorToYuanInput(suggested) : "");
  }, [action, factId, recordedExcessMinor]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (writeBlocked) return;
    setValidationError(undefined);
    const base: Record<string, unknown> = { propertyId: view.order.property_id, orderId: view.order.id };
    let description = "请核对本次操作信息。";
    if (action === "REVERSE_FACT") {
      const trimmedNote = note.trim();
      if (reversibleFacts.length === 0) {
        setValidationError(new Error("该订单当前没有可冲销的收退款记录"));
        return;
      }
      if (!selectedReverseFact) {
        setValidationError(new Error("请选择要冲销的收退款记录"));
        return;
      }
      if (!trimmedNote) {
        setValidationError(new Error("必须填写冲销原因"));
        return;
      }
      onSubmit(buildReverseFactRequest(view, selectedReverseFact, trimmedNote));
      return;
    }
    if (action === "RECORD_COLLECTION" || action === "RECORD_REFUND") {
      if (action === "RECORD_REFUND" && refundableCollections.length === 0) {
        setValidationError(new Error("该订单当前没有可退款的收款记录，不能登记退款"));
        return;
      }
      if (action === "RECORD_REFUND" && !factId) {
        setValidationError(new Error("请选择要退款的原收款"));
        return;
      }
      const trimmedNote = note.trim();
      if (action === "RECORD_REFUND" && !trimmedNote) {
        setValidationError(new Error("必须填写退款原因"));
        return;
      }
      if (action === "RECORD_COLLECTION" && !trimmedNote && (method === "CASH" || method === "OTHER")) {
        setValidationError(new Error(method === "CASH" ? "必须填写收款人" : "必须填写其他收款说明"));
        return;
      }
      const parsedAmount = collectionAmountYuanInputToMinor(amountYuan);
      if (parsedAmount === undefined) {
        setValidationError(new Error("金额必须按人民币元填写，大于 0 且最多保留两位小数"));
        return;
      }
      if (action === "RECORD_REFUND" && parsedAmount > selectedRefundRemainingMinor) {
        setValidationError(new Error(`退款金额不能超过所选原收款的剩余可退金额（最多可退 ${formatMinor(selectedRefundRemainingMinor, selectedRefundCollection?.currency ?? "CNY")}）。如需退多笔原收款，请分多次办理。`));
        return;
      }
      if (transactionReferenceRequired && !transactionReference.trim()) {
        setValidationError(new Error(method === "WECOM" ? "必须填写企业微信交易单号" : "必须填写交易单号或流水号"));
        return;
      }
      if (action === "RECORD_REFUND" && method === "WECOM" && !refundReference.trim()) {
        setValidationError(new Error("必须填写本次企业微信退款单号"));
        return;
      }
      Object.assign(base, { amountMinor: parsedAmount, method, note: trimmedNote });
      if (transactionReference.trim()) Object.assign(base, { transactionReference: transactionReference.trim() });
      if (action === "RECORD_REFUND") {
        Object.assign(base, { referencesFactId: factId });
        if (method === "WECOM") Object.assign(base, { refundReference: refundReference.trim() });
      }
      description = "";
    }
    if (action === "SHORTEN_STAY" || action === "EXTEND_STAY") {
      Object.assign(base, { newDepartureDate });
      description = "订单金额将按原房价标准重新计算，并保留调整记录。";
    }
    if (action === "REPRICE_ORDER") {
      const targetCurrentContractAmountMinor = wholeYuanAmountMinor(targetContractYuan);
      if (targetCurrentContractAmountMinor === undefined) {
        setValidationError(new Error("指定最终总价必须是大于或等于零的整元金额"));
        return;
      }
      if (!repriceReason.trim()) {
        setValidationError(new Error("必须填写订单金额更正原因"));
        return;
      }
      Object.assign(base, { targetCurrentContractAmountMinor });
      description = "订单金额将更新为指定总价，并保留更正记录。";
    }
    onSubmit({
      commandType: action,
      title: formTitles[action],
      description,
      input: base,
      ...(action === "REPRICE_ORDER" ? { initialReason: { code: "REPRICE_ORDER", note: repriceReason.trim() } } : {}),
      ...((action === "RECORD_COLLECTION" || action === "RECORD_REFUND") ? {
        initialReason: {
          code: action,
          note: action === "RECORD_REFUND" ? note.trim() : note.trim() || "登记收款"
        }
      } : {})
    });
  }

  return (
    <Modal title={formTitles[action]} onClose={onClose} footer={null}>
      <form className="modal-form" onSubmit={submit} noValidate>
        <InlineError error={validationError} title="无法继续" />
        {(action === "RECORD_COLLECTION" || action === "RECORD_REFUND") ? (
          <div className="form-grid form-grid-two">
            {action === "RECORD_REFUND" && refundableCollections.length === 0 ? (
              <div className="span-two form-field-note" role="status">
                <strong>该订单当前没有可退款的收款记录</strong>
                <span>需要先有未被冲销、且仍有可退余额的原收款，才能登记退款。</span>
              </div>
            ) : null}
            {action === "RECORD_REFUND" && refundableCollections.length > 0 ? <label className="span-two">选择原收款<select value={factId} onChange={(event) => {
              const nextFactId = event.target.value;
              const nextFact = selectedRefundCollectionFor(nextFactId);
              setFactId(nextFactId);
              if (nextFact?.method) setMethod(nextFact.method);
              setTransactionReference("");
              setRefundReference("");
              setValidationError(undefined);
            }} required>{refundableCollections.map((fact) => <option key={fact.fact_id} value={fact.fact_id}>{formatDateTime(fact.created_at)} · {collectionFactTransactionReferenceLabel(view.collectionFacts, fact)} · 可退 {formatMinor(remainingRefundableMinor(view.collectionFacts, fact), fact.currency)} · {collectionMethodLabel(fact.method)}</option>)}</select></label> : null}
            <label>金额（元）<input type="text" value={amountYuan} onChange={(event) => { setAmountYuan(event.target.value); setValidationError(undefined); }} required inputMode="decimal" placeholder="例如 1280.50" data-testid="fact-amount-yuan" disabled={action === "RECORD_REFUND" && refundableCollections.length === 0} /></label>
            <label>{action === "RECORD_REFUND" ? "退款方式" : "收款方式"}<select value={method} onChange={(event) => { setMethod(event.target.value); setTransactionReference(""); setValidationError(undefined); }} disabled={(action === "RECORD_REFUND" && refundableCollections.length === 0) || selectedRefundCollection?.method === "WECOM"}><option value="WECOM">企业微信</option><option value="BANK_TRANSFER">银行转账</option><option value="CASH">现金</option><option value="OTHER">其他</option></select></label>
            {action === "RECORD_REFUND" && method === "WECOM" ? <div className="span-two form-field-note" role="status">
              <strong>企业微信原路退回</strong>
              <span>对应所选原收款；本次退款需记录独立退款单号。</span>
            </div> : null}
            {action === "RECORD_REFUND" && method === "WECOM" ? <ExternalPaymentPicker key={factId} propertyId={view.order.property_id} kind="REFUND" originalCollectionFactId={factId} value={refundReference} amountMinor={Math.round(Number(amountYuan) * 100)} testId="refund-reference" disabled={refundableCollections.length === 0} onChange={(reference, item) => { setRefundReference(reference); if (item?.amountMinor) setAmountYuan(collectionAmountMinorToYuanInput(item.amountMinor)); setValidationError(undefined); }} /> : null}
            {transactionReferenceRequired ? method === "WECOM" ? <ExternalPaymentPicker propertyId={view.order.property_id} value={transactionReference} amountMinor={Math.round(Number(amountYuan) * 100) || Math.max(0, view.amounts.collectionDifference.minorUnits)} testId="transaction-reference" onChange={(reference, item) => { setTransactionReference(reference); if (item?.amountMinor) setAmountYuan(collectionAmountMinorToYuanInput(item.amountMinor)); setValidationError(undefined); }} /> : <label className="span-two">交易单号 / 流水号<input value={transactionReference} onChange={(event) => { setTransactionReference(event.target.value); setValidationError(undefined); }} required maxLength={200} data-testid="transaction-reference" disabled={action === "RECORD_REFUND" && refundableCollections.length === 0} /></label> : null}
            <label className="span-two">{action === "RECORD_REFUND" ? "退款原因" : method === "CASH" ? "收款人" : method === "OTHER" ? "其他收款说明" : "备注（选填）"}<textarea rows={3} value={note} onChange={(event) => { setNote(event.target.value); setValidationError(undefined); }} required={action === "RECORD_REFUND" || method === "CASH" || method === "OTHER"} maxLength={1000} data-testid={action === "RECORD_REFUND" ? "refund-reason" : "collection-note"} /></label>
          </div>
        ) : null}
        {action === "REVERSE_FACT" ? (
          <div className="form-grid form-grid-two">
            {reversibleFacts.length === 0 ? (
              <div className="span-two form-field-note" role="status">
                <strong>该订单当前没有可冲销的收退款记录</strong>
                <span>只能冲销尚未被冲销、且没有有效退款占用的收款或退款记录。</span>
              </div>
            ) : <>
              <label className="span-two">选择要冲销的记录<select value={reverseFactId} onChange={(event) => { setReverseFactId(event.target.value); setValidationError(undefined); }} required data-testid="reverse-fact-id">{reversibleFacts.map((fact) => <option key={fact.fact_id} value={fact.fact_id}>{collectionFactTypeLabel(fact.fact_type)} · {formatDateTime(fact.created_at)} · 净影响 {formatMinor(fact.net_effect_minor, fact.currency)} · {collectionFactTransactionReferenceLabel(view.collectionFacts, fact)}</option>)}</select></label>
              {selectedReverseFact ? <div className="span-two form-field-note" role="status" data-testid="reverse-fact-summary">
                <strong>追加反向冲销记录</strong>
                <span>原{collectionFactTypeLabel(selectedReverseFact.fact_type)}记录不会被删除；冲销后抵销净影响 {formatMinor(selectedReverseFact.net_effect_minor, selectedReverseFact.currency)}。</span>
              </div> : null}
              <label className="span-two">冲销原因<textarea rows={3} value={note} onChange={(event) => { setNote(event.target.value); setValidationError(undefined); }} required maxLength={1000} data-testid="reverse-fact-note" /></label>
            </>}
          </div>
        ) : null}
        {(action === "SHORTEN_STAY" || action === "EXTEND_STAY") ? (
          <div className="form-grid">
            <label>新离店日期<input type="date" value={newDepartureDate} min={view.order.arrival_date} onChange={(event) => setNewDepartureDate(event.target.value)} required data-testid="new-departure-date" /></label>
          </div>
        ) : null}
        {action === "REPRICE_ORDER" ? (
          <div className="form-grid">
            <label>指定最终总价（元）<input type="number" min="0" step="1" value={targetContractYuan} onChange={(event) => { setTargetContractYuan(event.target.value); setValidationError(undefined); }} required inputMode="numeric" data-testid="reprice-target-yuan" /></label>
            <label>金额更正原因<textarea value={repriceReason} onChange={(event) => { setRepriceReason(event.target.value); setValidationError(undefined); }} required maxLength={1000} rows={3} data-testid="reprice-reason" /></label>
          </div>
        ) : null}
        <div className="form-actions"><button type="button" className="button button-secondary" onClick={onClose}>取消</button><button type="submit" className="button button-primary" disabled={writeBlocked || (action === "RECORD_REFUND" && refundableCollections.length === 0) || (action === "REVERSE_FACT" && reversibleFacts.length === 0)}>{action === "RECORD_COLLECTION" || action === "RECORD_REFUND" ? "下一步" : "继续核对"}</button></div>
      </form>
    </Modal>
  );
}

function countArray(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

export interface ReverseFactHelpPosition {
  left: number;
  bottom: number;
  width: number;
}

export function reverseFactHelpPosition(
  button: Pick<DOMRect, "right" | "top">,
  viewportWidth: number,
  viewportHeight: number
): ReverseFactHelpPosition {
  const viewportInset = 12;
  const width = Math.max(0, Math.min(280, viewportWidth - viewportInset * 2));
  return {
    left: Math.min(
      Math.max(viewportInset, button.right - width - 4),
      Math.max(viewportInset, viewportWidth - width - viewportInset)
    ),
    bottom: Math.max(viewportInset, viewportHeight - button.top + 8),
    width
  };
}

export function FactActions({ fact, facts, canRefund, canReverse, disabled, onRefund, onReverse }: {
  fact: CollectionFactDto;
  facts: readonly CollectionFactDto[];
  canRefund: boolean;
  canReverse: boolean;
  disabled: boolean;
  onRefund: () => void;
  onReverse: () => void;
}) {
  const reverseHelpId = useId();
  const reverseButtonRef = useRef<HTMLButtonElement>(null);
  const [reverseHelpPosition, setReverseHelpPosition] = useState<ReverseFactHelpPosition>();
  const reverseHelpText = "仅用于撤销录错的收款或退款。系统会新增一笔反向记录抵消原记录，并保留原记录和操作痕迹；如果确实把钱退给客人，请使用“退款”。";
  const showReverseHelp = () => {
    const button = reverseButtonRef.current;
    if (!button) return;
    setReverseHelpPosition(reverseFactHelpPosition(button.getBoundingClientRect(), window.innerWidth, window.innerHeight));
  };

  useEffect(() => {
    if (!reverseHelpPosition) return undefined;
    const hide = () => setReverseHelpPosition(undefined);
    window.addEventListener("resize", hide);
    window.addEventListener("scroll", hide, true);
    return () => {
      window.removeEventListener("resize", hide);
      window.removeEventListener("scroll", hide, true);
    };
  }, [reverseHelpPosition]);

  return (
    <div className="row-actions">
      {canRefund && fact.fact_type === "COLLECTION" ? <button className="button button-secondary fact-action-button fact-refund-button" type="button" onClick={onRefund} disabled={disabled} aria-label={`为 ${fact.transaction_reference ?? "这笔收款"} 记录退款`} data-order-action="RECORD_REFUND">退款</button> : null}
      {canReverse ? <span className="fact-reverse-action">
        <button ref={reverseButtonRef} className="button button-secondary fact-action-button fact-reverse-button" type="button" onClick={onReverse} onMouseEnter={showReverseHelp} onMouseLeave={() => setReverseHelpPosition(undefined)} onFocus={showReverseHelp} onBlur={() => setReverseHelpPosition(undefined)} disabled={disabled} aria-label={`冲销${collectionFactTypeLabel(fact.fact_type)} ${collectionFactTransactionReferenceLabel(facts, fact)}`} aria-describedby={reverseHelpId} data-order-action="REVERSE_FACT">冲销</button>
        <span className="sr-only" id={reverseHelpId}>{reverseHelpText}</span>
        {reverseHelpPosition && typeof document !== "undefined" ? createPortal(
          <span className="fact-reverse-help" role="tooltip" style={reverseHelpPosition}>{reverseHelpText}</span>,
          document.body
        ) : null}
      </span> : null}
    </div>
  );
}

export function OrderActionButton({ action, blocked, showWhenDisabled = false, className = "button button-secondary", dataOrderAction, testId, onClick, children }: {
  action?: OrderAllowedActionDto | undefined;
  blocked: boolean;
  showWhenDisabled?: boolean;
  className?: string;
  dataOrderAction?: string;
  testId?: string;
  onClick?: () => void;
  children: ReactNode;
}) {
  if (!action || (!action.enabled && !showWhenDisabled)) return null;
  return (
    <button
      className={className}
      type="button"
      onClick={onClick}
      disabled={blocked || !action.enabled}
      title={!action.enabled ? orderActionDisabledReasonText(action) : undefined}
      data-order-action={dataOrderAction ?? action.code}
      {...(testId ? { "data-testid": testId } : {})}
    >
      {children}
    </button>
  );
}

export function OrderDetailPage() {
  const { orderId } = useParams<{ orderId: string }>();
  const { principal, propertyId } = useWorkspace();
  const scope = JSON.stringify([orderId, propertyId, principal]);
  return <ScopedOrderDetailPage key={scope} />;
}

function ScopedOrderDetailPage() {
  const { orderId } = useParams<{ orderId: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const { meta, principal, propertyId } = useWorkspace();
  const recoveryScope = propertyId ? `property:${propertyId}` : "";
  const currentPropertyAllowedActions = useMemo(() => propertyAllowedActions(principal, propertyId), [principal, propertyId]);
  const principalOrderScope = `${principal.subjectId}:${principal.credentialType}:${principal.propertyAccess[propertyId] ?? "NONE"}:${[...currentPropertyAllowedActions].join("|")}`;
  const commandRecovery = usePersistentCommandRecovery({ subjectId: principal.subjectId, scopeId: recoveryScope });
  const [view, setView] = useState<OrderViewDto>();
  const [loadedPrincipalOrderScope, setLoadedPrincipalOrderScope] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();
  const [recoveryError, setRecoveryError] = useState<unknown>();
  const [formAction, setFormAction] = useState<FormAction>();
  const [completeStayAction, setCompleteStayAction] = useState(false);
  const [stayDateAction, setStayDateAction] = useState<StayDateChangeAction>();
  const [movingUnit, setMovingUnit] = useState(false);
  const [convertingToMembership, setConvertingToMembership] = useState(false);
  const [upgradeMembers, setUpgradeMembers] = useState<import("../types").MemberDto[]>([]);
  const upgradeLookupRef = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => { upgradeLookupRef.current?.abort(); }, [orderId, propertyId]);
  const [lifecycleAction, setLifecycleAction] = useState<OrderLifecycleAction>();
  const [stayDateMode, setStayDateMode] = useState<StayDateChangeMode>("DATE_CHANGE");
  const [correctingOccupant, setCorrectingOccupant] = useState<OrderOccupant>();
  const [companionAction, setCompanionAction] = useState<{ occupantId?: string }>();
  const [pendingStayMembershipUpgrade, setPendingStayMembershipUpgrade] = useState<StayMembershipUpgradeIntent>();
  const [initialFactId, setInitialFactId] = useState<string>();
  const [command, setCommand] = useState<CommandRequest>();
  const [commandDraft, setCommandDraft] = useState<CommandRequest>();
  const [recoveryDialogOpen, setRecoveryDialogOpen] = useState(false);
  const refreshOrderRef = useRef<() => void>(() => {});
  const [refreshNotice, setRefreshNotice] = useState<string>();
  const [commandNotice, setCommandNotice] = useState<string>();
  const viewRef = useRef<OrderViewDto | undefined>(undefined);
  const editorIsOpenRef = useRef(false);
  const focusedActionKeyRef = useRef<string | undefined>(undefined);

  editorIsOpenRef.current = Boolean(formAction || completeStayAction || stayDateAction || movingUnit || convertingToMembership || correctingOccupant || companionAction || lifecycleAction);

  const pendingRecovery = commandRecovery.pending;
  const recoveryPendingAllowed = commandRecoveryAvailable(principal, propertyId, pendingRecovery?.commandType);
  const orderActionsBlocked = Boolean(error) || (commandRecovery.blocked && recoveryPendingAllowed);
  const enabledActions = useMemo(() => new Set(enabledOrderActionCodes(view?.allowedActions ?? [])), [view]);
  const actionByCode = useMemo(() => new Map((view?.allowedActions ?? []).map((action) => [action.code, action])), [view]);
  const fulfillmentNotice = useMemo(() => orderFulfillmentNotice(view?.allowedActions ?? []), [view]);
  const requestedAction = useMemo(() => requestedOrderAction(location.search, view?.allowedActions ?? []), [location.search, view]);
  const requestedRawAction = useMemo(() => new URLSearchParams(location.search).get("action"), [location.search]);
  const backTarget = orderDetailBackTarget(location.state);

  useEffect(() => {
    setRecoveryError(undefined);
    setFormAction(undefined);
    setCompleteStayAction(false);
    setStayDateAction(undefined);
    setMovingUnit(false);
    setConvertingToMembership(false);
    setLifecycleAction(undefined);
    setStayDateMode("DATE_CHANGE");
    setCorrectingOccupant(undefined);
    setCompanionAction(undefined);
    setPendingStayMembershipUpgrade(undefined);
    setInitialFactId(undefined);
    setCommand(undefined);
    setCommandDraft(undefined);
    setLoadedPrincipalOrderScope(undefined);
    setRecoveryDialogOpen(false);
    setRefreshNotice(undefined);
    setCommandNotice(undefined);
  }, [orderId, principalOrderScope, recoveryScope]);

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  useEffect(() => {
    if (!orderId) return;
    const poller = createReadPoller({
      intervalMs: ORDER_DETAIL_POLL_MS,
      timeoutMs: 20_000,
      visible: () => document.visibilityState === "visible",
      read: (signal) => api.order(orderId, signal),
      onValue: (response) => {
        const prior = viewRef.current;
        if (response.order.id !== orderId || response.order.property_id !== propertyId) throw new Error("订单响应与当前订单或门店不一致，已停止更新");
        assertOrderViewAllowedActions(response, currentPropertyAllowedActions);
        // A read begun before a committed command must not roll back its refreshed view.
        if (prior && response.order.version < prior.order.version) return;
        const payloadChanged = !prior || orderViewPayloadChanged(prior, response);
        if (prior && orderRefreshMustCloseEditor(prior, response, editorIsOpenRef.current)) {
          editorIsOpenRef.current = false;
          setFormAction(undefined);
          setCompleteStayAction(false);
          setStayDateAction(undefined);
          setMovingUnit(false);
          setConvertingToMembership(false);
          setLifecycleAction(undefined);
          setCorrectingOccupant(undefined);
          setCompanionAction(undefined);
          setPendingStayMembershipUpgrade(undefined);
          setInitialFactId(undefined);
          setCommandDraft(undefined);
          setRefreshNotice("订单已被其他操作刷新。为避免使用旧数据，原编辑表单已关闭；请重新打开后核对。");
        }
        if (payloadChanged) {
          setView(response);
          viewRef.current = response;
        }
        setLoadedPrincipalOrderScope(principalOrderScope);
        setError(undefined);
        setLoading(false);
      },
      onError: (nextError) => {
        setError(nextError);
        setLoading(false);
        if (nextError instanceof ApiError && (nextError.status === 401 || nextError.status === 403 || nextError.status === 404)) {
          setView(undefined);
          viewRef.current = undefined;
          setFormAction(undefined);
          setStayDateAction(undefined);
          setMovingUnit(false);
          setCompleteStayAction(false);
          setConvertingToMembership(false);
          setCorrectingOccupant(undefined);
          setCompanionAction(undefined);
          setLifecycleAction(undefined);
          setCommandDraft(undefined);
        }
      }
    });
    refreshOrderRef.current = poller.refresh;
    const refreshVisible = () => {
      if (document.visibilityState === "visible") poller.refresh();
    };
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      poller.dispose();
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, [currentPropertyAllowedActions, orderId, principalOrderScope, propertyId]);

  useEffect(() => {
    if (view && view.order.property_id !== propertyId) navigate("/orders", { replace: true });
  }, [navigate, propertyId, view]);

  useEffect(() => {
    if (!view || requestedRawAction !== "CHECK_OUT") return;
    const checkoutEnabled = view.allowedActions.some((action) => action.code === "CHECK_OUT" && action.enabled);
    const shortenEnabled = view.allowedActions.some((action) => action.code === "SHORTEN_STAY" && action.enabled);
    const focusKey = `${orderId}:EARLY_CHECK_OUT`;
    if (checkoutEnabled || !shortenEnabled || focusedActionKeyRef.current === focusKey) return;
    focusedActionKeyRef.current = focusKey;
    setCommandDraft(undefined);
    setStayDateMode("EARLY_CHECK_OUT");
    setStayDateAction("SHORTEN_STAY");
  }, [orderId, requestedRawAction, view]);

  useEffect(() => {
    if (!requestedAction) return;
    const focusKey = `${orderId}:${requestedAction}`;
    if (focusedActionKeyRef.current === focusKey) return;
    const frame = window.requestAnimationFrame(() => {
      const target = document.querySelector<HTMLElement>(`[data-order-action="${requestedAction}"]`);
      if (!target) return;
      target.scrollIntoView({ block: "center", inline: "nearest" });
      target.focus({ preventScroll: true });
      focusedActionKeyRef.current = focusKey;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [orderId, requestedAction, view]);

  useEffect(() => {
    if (!requestedAction || requestedAction !== "COMPLETE_STAY") return;
    const focusKey = `${orderId}:COMPLETE_STAY:OPEN`;
    if (focusedActionKeyRef.current === focusKey) return;
    focusedActionKeyRef.current = focusKey;
    setCompleteStayAction(true);
    setCommandDraft(undefined);
  }, [orderId, requestedAction, view]);

  const orderInventoryUnits = useMemo(() => {
    const units = new Map(meta.inventoryUnits.map((unit) => [unit.id, unit]));
    for (const unit of view?.referencedInventoryUnits ?? []) units.set(unit.id, unit);
    return [...units.values()];
  }, [meta.inventoryUnits, view?.referencedInventoryUnits]);
  const unitMap = useMemo(() => new Map(orderInventoryUnits.map((unit) => [unit.id, unit])), [orderInventoryUnits]);

  function openForm(action: FormAction, factId?: string) {
    if (!view || orderActionsBlocked || !orderActionWithUpgradeGuard(view, actionByCode.get(action))?.enabled) return;
    setInitialFactId(factId);
    setFormAction(action);
    setCommandDraft(undefined);
  }

  function directCommand(commandType: CommandType, title: string, description: string) {
    if (!view || orderActionsBlocked || !enabledActions.has(commandType as OrderActionCode)) return;
    setRecoveryDialogOpen(false);
    setCommand({
      commandType,
      title,
      description,
      ...((commandType === "CHECK_IN" || commandType === "CHECK_OUT") ? { presentation: "FULFILLMENT" as const } : {}),
      input: { propertyId: view.order.property_id, orderId: view.order.id }
    });
  }

  function openLifecycleAction(action: OrderLifecycleAction) {
    if (orderActionsBlocked || !enabledActions.has(action)) return;
    if (view && upgradedStayActionDisabledReason(view, action)) return;
    setCommandDraft(undefined);
    setLifecycleAction(action);
  }

  async function beginStayMembershipUpgrade(currentView: OrderViewDto) {
    upgradeLookupRef.current?.abort();
    const controller = new AbortController();
    upgradeLookupRef.current = controller;
    const timeout = window.setTimeout(() => controller.abort(new Error("会员查找超时，请再次点击升级会员")), 12_000);
    let members: import("../types").MemberDto[] = [];
    const phone = currentView.occupants.find((occupant) => occupant.role === "PRIMARY")?.phone?.replace(/\s+/g, "");
    try {
      if (phone) {
        setCommandNotice("正在核对会员档案…");
        const response = await api.members(currentView.order.property_id, undefined, { phone, pageSize: 2, signal: controller.signal });
        members = response.members.map((row) => row.member);
      }
      if (upgradeLookupRef.current !== controller || controller.signal.aborted || viewRef.current?.order.id !== currentView.order.id) return;
      setUpgradeMembers(members);
      setCommandNotice(undefined);
    } catch (error) {
      if (upgradeLookupRef.current === controller) setCommandNotice(`无法核对会员档案：${errorMessage(controller.signal.reason ?? error)}。请再次点击升级会员重试。`);
      return;
    } finally { window.clearTimeout(timeout); }
    const entry = stayMembershipUpgradeEntry(currentView, members, meta.membershipProducts, unitMap);
    if (entry.state === "CORRECT_PRIMARY_OCCUPANT") {
      const occupant = currentView.occupants.find((candidate) => candidate.id === entry.primaryOccupantId);
      if (!occupant || !enabledActions.has("CORRECT_ORDER_OCCUPANT")) {
        setCommandNotice("主要住宿人缺少手机号，请先在住宿人区域更正资料。");
        return;
      }
      setPendingStayMembershipUpgrade({
        action: "STAY_MEMBERSHIP_UPGRADE",
        orderId: entry.orderId,
        primaryOccupantId: entry.primaryOccupantId
      });
      setCommandDraft(undefined);
      setCorrectingOccupant(occupant);
      return;
    }
    if (entry.state === "CREATE_MEMBER") {
      setPendingStayMembershipUpgrade(undefined);
      navigate(stayUpgradeMemberCreationHref(entry));
      return;
    }
    if (entry.state === "READY") {
      setPendingStayMembershipUpgrade(undefined);
      setCommandDraft(undefined);
      setConvertingToMembership(true);
      return;
    }
    setCommandNotice(entry.reason === "MEMBER_PHONE_AMBIGUOUS"
      ? "该手机号匹配到多个会员档案，请先核对会员资料后再升级。"
      : entry.reason === "MEMBERSHIP_PRODUCT_NOT_APPLICABLE"
        ? "当前住宿房型没有匹配的正式会员产品，不能升级会员。"
        : "当前订单暂不能升级会员。");
  }

  function openRecoveryDialog() {
    if (!pendingRecovery || !recoveryPendingAllowed) return;
    setRecoveryDialogOpen(true);
    setCommand(recoveryCommandRequest(pendingRecovery));
  }

  async function closeCommandDialog(context?: CommandDialogCloseContext) {
    if (context || (pendingRecovery && isTerminalCommandRecovery(pendingRecovery.state))) {
      if (await commandRecovery.clearResolved()) {
        setRecoveryError(undefined);
      } else {
        setRecoveryError(new Error("无法清除已收口的本地恢复记录；为避免重复写入，订单命令继续保持暂停"));
      }
    }
    setCommand(undefined);
    setRecoveryDialogOpen(false);
    refreshOrderRef.current();
  }

  function returnCommandToEdit(request: CommandRequest) {
    setCommandDraft(request);
    if (request.commandType === "MANAGE_ORDER_OCCUPANTS") {
      setCompanionAction(typeof request.input.occupantId === "string" ? { occupantId: request.input.occupantId } : {});
      return;
    }
    if (request.commandType === "CANCEL_ORDER" || request.commandType === "MARK_NO_SHOW" || request.commandType === "REVOKE_CHECK_IN" || request.commandType === "REVOKE_CHECK_OUT") {
      setLifecycleAction(request.commandType);
      return;
    }
    if (request.commandType === "RESCHEDULE_STAY" || request.commandType === "EXTEND_STAY" || request.commandType === "SHORTEN_STAY") {
      setStayDateAction(request.commandType);
      setStayDateMode(viewRef.current?.order.status === "CHECKED_IN" ? "ADJUST_DEPARTURE" : "DATE_CHANGE");
      return;
    }
    if (request.commandType === "MOVE_UNIT") {
      setMovingUnit(true);
      return;
    }
    if (request.commandType === "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP") {
      setConvertingToMembership(true);
      return;
    }
    if (request.commandType === "COMPLETE_STAY") {
      setCompleteStayAction(true);
      return;
    }
    if (request.commandType === "REVERSE_FACT") {
      const reversesFactId = request.input.reversesFactId;
      if (typeof reversesFactId === "string") setInitialFactId(reversesFactId);
      setFormAction("REVERSE_FACT");
      return;
    }
    if (request.commandType === "REPRICE_ORDER") {
      setFormAction("REPRICE_ORDER");
      return;
    }
    if (request.commandType === "CORRECT_ORDER_OCCUPANT") {
      const occupantId = request.input.occupantId;
      const occupant = typeof occupantId === "string" ? viewRef.current?.occupants.find((item) => item.id === occupantId) : undefined;
      if (occupant) setCorrectingOccupant(occupant);
    }
  }

  useEffect(() => {
    if (!view || orderActionsBlocked || requestedAction !== "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP") return;
    const requestedMemberId = new URLSearchParams(location.search).get("memberId") ?? "";
    const focusKey = `${orderId}:CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP:OPEN:${requestedMemberId}`;
    if (focusedActionKeyRef.current === focusKey) return;
    focusedActionKeyRef.current = focusKey;
    beginStayMembershipUpgrade(view);
  }, [location.search, orderActionsBlocked, orderId, requestedAction, view]);

  useEffect(() => {
    const notice = stayMembershipUpgradeAutoOpenBlockedNotice(requestedAction, orderActionsBlocked);
    if (notice) setCommandNotice(notice);
  }, [orderActionsBlocked, requestedAction]);

  useEffect(() => {
    if (!view || orderActionsBlocked || requestedAction !== "CORRECT_ORDER_OCCUPANT") return;
    const params = new URLSearchParams(location.search);
    if (params.get("resumeAction") !== "STAY_MEMBERSHIP_UPGRADE") return;
    const occupantId = params.get("occupantId") ?? "";
    const occupant = view.occupants.find((candidate) => candidate.id === occupantId && candidate.role === "PRIMARY");
    const focusKey = `${orderId}:CORRECT_ORDER_OCCUPANT:STAY_MEMBERSHIP_UPGRADE:${occupantId}`;
    if (!occupant || focusedActionKeyRef.current === focusKey) return;
    focusedActionKeyRef.current = focusKey;
    setPendingStayMembershipUpgrade({
      action: "STAY_MEMBERSHIP_UPGRADE",
      orderId: view.order.id,
      primaryOccupantId: occupant.id
    });
    setCommandDraft(undefined);
    setCorrectingOccupant(occupant);
  }, [location.search, orderActionsBlocked, orderId, requestedAction, view]);

  useAssistantOrderEntry(orderId, !loading && Boolean(view), orderActionsBlocked);

  if (loading) return <LoadingBlock label="正在载入订单详情" />;
  if (view && !orderViewMatchesPrincipalScope(loadedPrincipalOrderScope, principalOrderScope)) return <LoadingBlock label="正在切换订单访问权限" />;
  if (!view) return <div><Link className="back-link" to={backTarget} state={location.state}><ArrowLeft aria-hidden="true" size={17} />{backTarget === "/" ? "返回房态" : "返回订单"}</Link><InlineError error={error ?? new Error("Order not found")} title="无法载入订单" /></div>;

  const occupants = orderedOrderOccupants(view.occupants);
  const primaryOccupant = primaryOrderOccupant(occupants);
  const visibleArrangementUnits = [...new Set(view.effectiveArrangement.intervals.map((interval) => arrangementUnitLabel(unitMap, interval.inventoryUnitId)))];
  const currentPricingRevision = view.pricingRevisions.find((revision) => revision.id === view.order.current_revision_id)
    ?? view.pricingRevisions[view.pricingRevisions.length - 1];
  const showPerOrderFunds = stayDateFundsAreOperatorFacing(view.order.booking_channel_code, currentPricingRevision?.pricing_basis);
  const rescheduleState = stayDateChangeActionState(view, "RESCHEDULE_STAY");
  const extendState = stayDateChangeActionState(view, "EXTEND_STAY");
  const shortenState = stayDateChangeActionState(view, "SHORTEN_STAY");
  const departureAdjustmentAction = view.order.status === "CHECKED_IN"
    ? extendState?.enabled ? "EXTEND_STAY" : shortenState?.enabled ? "SHORTEN_STAY" : undefined
    : undefined;
  const blockedStayDateState = view.order.status === "RESERVED" ? rescheduleState : shortenState;
  const refundUnavailableReason = orderRefundUnavailableReason(view.allowedActions);
  const externalChannelFunds = Boolean(view.order.booking_channel_code && externalBookingChannelCodes.has(view.order.booking_channel_code));
  const terminalActions = terminalOrderActionCodes(view.order.status);
  const showDisabledTerminalActions = terminalActions.length > 0 && view.allowedActions.length > 0;
  const terminalActionVisible = (code: OrderActionCode): boolean => showDisabledTerminalActions && terminalActions.includes(code);
  const actionVisible = (code: OrderActionCode): boolean => Boolean(actionByCode.get(code)?.enabled || terminalActionVisible(code));
  const refundActionVisible = actionVisible("RECORD_REFUND") || Boolean(refundUnavailableReason);
  const convertAction = actionByCode.get("CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP");
  const convertActionVisible = stayMembershipUpgradeActionVisible(view, convertAction);
  const convertActionDisabledReason = convertActionVisible && convertAction && !convertAction.enabled
    ? orderActionDisabledReasonText(convertAction)
    : undefined;
  const departureAdjustmentDisabledAction = terminalActionVisible("EXTEND_STAY")
    ? actionByCode.get("EXTEND_STAY")
    : terminalActionVisible("SHORTEN_STAY")
      ? actionByCode.get("SHORTEN_STAY")
      : undefined;
  const visibleDepartureAdjustmentAction = departureAdjustmentAction
    ? actionByCode.get(departureAdjustmentAction)
    : departureAdjustmentDisabledAction;
  const showDepartureAdjustmentButton = Boolean(departureAdjustmentAction || departureAdjustmentDisabledAction);
  const repriceAction = orderActionWithUpgradeGuard(view, actionByCode.get("REPRICE_ORDER"));
  const repriceClosedByUpgrade = Boolean(repriceAction && !repriceAction.enabled
    && repriceAction.disabledReason === "STAY_MEMBERSHIP_UPGRADE_REPRICE_CLOSED");
  const showLifecycleSeparator = actionVisible("CANCEL_ORDER") || actionVisible("MARK_NO_SHOW") || actionVisible("REVOKE_CHECK_IN") || actionVisible("REVOKE_CHECK_OUT");
  const visibleActionCodes: OrderActionCode[] = ([
    "RECORD_COLLECTION",
    "RECORD_REFUND",
    "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP",
    "RESCHEDULE_STAY",
    "MOVE_UNIT",
    "REPRICE_ORDER",
    "CHECK_IN",
    "CHECK_OUT",
    "COMPLETE_STAY",
    "CANCEL_ORDER",
    "MARK_NO_SHOW",
    "REVOKE_CHECK_IN",
    "REVOKE_CHECK_OUT"
  ] as const).filter((code) => actionVisible(code)
    || (code === "RECORD_REFUND" && refundActionVisible)
    || (code === "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP" && convertActionVisible));
  const showOrderActionHelp = orderActionHelpRequired(view.allowedActions, visibleActionCodes);
  const overdueNotice = overdueInHouseNotice(view);

  const readFailureNotice = error ? <InlineError error={error} title="订单刷新失败，草稿已保留；读取恢复前暂不能提交" /> : null;
  return (
    <ModalNoticeProvider notice={readFailureNotice}>
    <div className="order-detail-page">
      <Link className="back-link" to={backTarget} state={location.state}><ArrowLeft aria-hidden="true" size={17} />{backTarget === "/" ? "返回房态" : "返回订单"}</Link>
      <header className="order-heading">
        <div><div className="order-title-row"><h1>{guestName(view.order.current_primary_guest ?? (primaryOccupant ? { nickname: primaryOccupant.nickname, fullName: primaryOccupant.fullName } : view.order.primary_guest_snapshot))}</h1><StatusBadge value={view.order.status} label={businessStatusLabel(view.order.status)} /></div></div>
        <div className="order-unit"><span>{effectiveArrangementTitle(view.effectiveArrangement.presentation)}</span><strong>{visibleArrangementUnits.join("、")}</strong><small>{formatDate(view.effectiveArrangement.arrivalDate)} 至 {formatDate(view.effectiveArrangement.departureDate)}</small></div>
      </header>

      {overdueNotice ? <OverdueInHouseAlert notice={overdueNotice} /> : null}

      <OrderAmountStrip amounts={view.amounts} pricingRevision={currentPricingRevision} bookingChannelCode={view.order.booking_channel_code} />

      {!editorIsOpenRef.current && !command ? readFailureNotice : null}
      <InlineError error={recoveryError} title="恢复记录未收口" />
      {commandRecovery.canDiscardCorrupt
        ? <DamagedCommandRecoveryNotice error={commandRecovery.error} onDiscard={commandRecovery.discardCorruptAfterReview} testId="order-damaged-command-recovery" />
        : <InlineError error={commandRecovery.error} title="本地命令恢复记录不可用" />}
      <QuoteRecoveryConflictNotice conflict={commandRecovery.conflict} testId="order-quote-recovery-conflict" />
      <CommandResultNotice message={commandNotice} onDismiss={() => setCommandNotice(undefined)} />
      {refreshNotice ? <div className="room-status-return-notice" role="alert">{refreshNotice}</div> : null}
      {pendingRecovery && recoveryPendingAllowed ? <CommandRecoveryBar recovery={pendingRecovery} onOpen={openRecoveryDialog} testId="order-command-recovery" /> : null}
      {pendingRecovery && !recoveryPendingAllowed ? <section className="recovery-bar" role="status" data-testid="order-command-recovery-forbidden"><div><strong>原操作当前无权继续</strong><p>当前账号已没有该命令授权，恢复入口已隐藏；订单仍可按当前权限查看。</p></div></section> : null}

      <section className="action-band" aria-labelledby="order-actions-heading">
        <h2 id="order-actions-heading">订单操作</h2>
        <div className="action-band-content">
          {externalChannelFunds ? (
            <div className="channel-funds-notice" role="status" data-testid="external-channel-funds-notice">
              <strong>渠道订单不登记单笔收退款</strong>
              <span>请核对渠道订单号和本单渠道应结金额；后续由财务按渠道总账核对。</span>
            </div>
          ) : null}
          <div className="action-toolbar">
            {fulfillmentNotice ? <OrderActionNotice title={fulfillmentNotice.title} body={fulfillmentNotice.body} testId="fulfillment-date-notice" action={fulfillmentNotice.action} /> : null}
            {blockedStayDateState && !blockedStayDateState.enabled && blockedStayDateState.reason ? (
              <OrderActionNotice
                title={view.order.status === "RESERVED" ? "暂不能调整住宿日期" : "暂不能缩短住宿或提前退房"}
                body={blockedStayDateState.reason}
                testId="stay-date-action-notice"
              />
            ) : null}
            {convertActionDisabledReason ? (
              <span className="action-notice action-notice-detailed" role="status" data-testid="stay-membership-upgrade-action-notice">
                <AlertTriangle aria-hidden="true" size={14} />
                暂不能升级会员：{convertActionDisabledReason}
              </span>
            ) : null}
            <OrderActionButton action={actionByCode.get("RECORD_COLLECTION")} blocked={orderActionsBlocked} showWhenDisabled={terminalActionVisible("RECORD_COLLECTION")} onClick={() => openForm("RECORD_COLLECTION")} testId="record-collection"><CircleDollarSign aria-hidden="true" size={17} />收款</OrderActionButton>
            <OrderActionButton action={actionByCode.get("RECORD_REFUND")} blocked={orderActionsBlocked} showWhenDisabled={refundActionVisible} onClick={() => openForm("RECORD_REFUND")}><Undo2 aria-hidden="true" size={17} />退款</OrderActionButton>
            <OrderActionButton action={actionByCode.get("CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP")} blocked={orderActionsBlocked} showWhenDisabled={convertActionVisible} onClick={() => { if (!enabledActions.has("CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP")) return; beginStayMembershipUpgrade(view); }} testId="convert-stay-collections-to-membership"><Sparkles aria-hidden="true" size={17} />升级会员</OrderActionButton>
            <OrderActionButton action={actionByCode.get("RESCHEDULE_STAY")} blocked={orderActionsBlocked} showWhenDisabled={terminalActionVisible("RESCHEDULE_STAY")} onClick={() => { setCommandDraft(undefined); setStayDateMode("DATE_CHANGE"); setStayDateAction("RESCHEDULE_STAY"); }}><CalendarRange aria-hidden="true" size={17} />调整住宿日期</OrderActionButton>
            {showDepartureAdjustmentButton ? <OrderActionButton action={visibleDepartureAdjustmentAction} blocked={orderActionsBlocked} showWhenDisabled={Boolean(departureAdjustmentDisabledAction)} dataOrderAction="ADJUST_DEPARTURE" onClick={() => { if (!departureAdjustmentAction) return; setCommandDraft(undefined); setStayDateMode("ADJUST_DEPARTURE"); setStayDateAction(departureAdjustmentAction); }}><CalendarRange aria-hidden="true" size={17} />调整退房日期</OrderActionButton> : null}
            <OrderActionButton action={actionByCode.get("MOVE_UNIT")} blocked={orderActionsBlocked} showWhenDisabled={terminalActionVisible("MOVE_UNIT")} onClick={() => { setCommandDraft(undefined); setMovingUnit(true); }}><ArrowRightLeft aria-hidden="true" size={17} />换房</OrderActionButton>
            <OrderActionButton action={repriceAction} blocked={orderActionsBlocked} showWhenDisabled={repriceClosedByUpgrade || terminalActionVisible("REPRICE_ORDER")} onClick={() => openForm("REPRICE_ORDER")} testId="reprice-order"><CircleDollarSign aria-hidden="true" size={17} />调整金额</OrderActionButton>
            <OrderActionButton action={actionByCode.get("CHECK_IN")} blocked={orderActionsBlocked} showWhenDisabled={terminalActionVisible("CHECK_IN")} className="button button-primary" onClick={() => directCommand("CHECK_IN", "办理入住", "核对后将住宿状态更新为在住；会员住宿会同时核销本次仍冻结的权益。")} testId="check-in"><LogIn aria-hidden="true" size={17} />入住</OrderActionButton>
            <OrderActionButton action={actionByCode.get("CHECK_OUT")} blocked={orderActionsBlocked} showWhenDisabled={terminalActionVisible("CHECK_OUT")} className="button button-primary" onClick={() => directCommand("CHECK_OUT", "办理退房", "核对后将住宿状态更新为已退房并释放后续住宿库存；退房不会重复核销会员权益。")} testId="check-out"><LogOut aria-hidden="true" size={17} />退房</OrderActionButton>
            <OrderActionButton action={actionByCode.get("COMPLETE_STAY")} blocked={orderActionsBlocked} showWhenDisabled={terminalActionVisible("COMPLETE_STAY")} className="button button-primary" onClick={() => { setCommandDraft(undefined); setCompleteStayAction(true); }} testId="complete-stay"><ClipboardCheck aria-hidden="true" size={17} />完成住宿</OrderActionButton>
            {showLifecycleSeparator ? <div className="action-separator" aria-hidden="true" /> : null}
            <OrderActionButton action={actionByCode.get("CANCEL_ORDER")} blocked={orderActionsBlocked} showWhenDisabled={terminalActionVisible("CANCEL_ORDER")} className="button button-secondary danger-button" onClick={() => openLifecycleAction("CANCEL_ORDER")}><XCircle aria-hidden="true" size={18} />取消订单</OrderActionButton>
            <OrderActionButton action={actionByCode.get("MARK_NO_SHOW")} blocked={orderActionsBlocked} showWhenDisabled={terminalActionVisible("MARK_NO_SHOW")} className="button button-secondary danger-button" onClick={() => openLifecycleAction("MARK_NO_SHOW")}><UserX aria-hidden="true" size={18} />标记未到</OrderActionButton>
            <OrderActionButton action={actionByCode.get("REVOKE_CHECK_IN")} blocked={orderActionsBlocked} showWhenDisabled={terminalActionVisible("REVOKE_CHECK_IN")} className="button button-secondary danger-button" onClick={() => openLifecycleAction("REVOKE_CHECK_IN")}><Undo2 aria-hidden="true" size={18} />撤销入住</OrderActionButton>
            <OrderActionButton action={actionByCode.get("REVOKE_CHECK_OUT")} blocked={orderActionsBlocked} className="button button-secondary danger-button" onClick={() => openLifecycleAction("REVOKE_CHECK_OUT")} testId="revoke-check-out"><Undo2 aria-hidden="true" size={18} />撤销退房</OrderActionButton>
            {showOrderActionHelp ? <span className="action-help-hint"><InfoHint text="灰色按钮表示当前条件下暂不可用。" label="订单操作说明" /></span> : null}
            {enabledActions.size === 0 ? <span>当前没有可执行操作</span> : null}
          </div>
        </div>
      </section>

      <nav className="detail-jump-links" aria-label="订单详情导航"><a href="#stay-heading">住宿资料</a><a href="#effective-arrangement-heading">住宿安排</a><a href="#order-funds">收退款记录</a></nav>

      <div className="detail-grid">
        <section className="detail-section order-occupants-section" aria-labelledby="guest-snapshot-heading">
          <div className="section-title-row"><h2 id="guest-snapshot-heading">住宿人</h2><span>{occupants.length} 人</span>{enabledActions.has("MANAGE_ORDER_OCCUPANTS") ? <button type="button" className="button button-secondary" disabled={orderActionsBlocked} data-order-action="MANAGE_ORDER_OCCUPANTS" onClick={() => setCompanionAction({})}><UserPlus aria-hidden="true" size={16} />添加同住人</button> : null}</div>
          <ol className="order-occupant-list">
            {occupants.map((occupant) => (
              <li key={occupant.id} data-occupant-id={occupant.id} data-testid="order-occupant">
                <div className="order-occupant-heading">
                  <span className="order-occupant-role">{occupant.role === "PRIMARY" ? "主要联系人" : `同行人 ${occupant.ordinal - 1}`}</span>
                  <strong>{occupant.nickname?.trim() || "历史未记录"}</strong>
                  {enabledActions.has("CORRECT_ORDER_OCCUPANT") ? <button className="button button-secondary" type="button" onClick={() => setCorrectingOccupant(occupant)} disabled={orderActionsBlocked} data-order-action="CORRECT_ORDER_OCCUPANT" data-testid={`correct-occupant-${occupant.id}`}><Pencil aria-hidden="true" size={16} />更正资料</button> : null}
                  {occupant.role === "ADDITIONAL" && enabledActions.has("MANAGE_ORDER_OCCUPANTS") ? <button className="button button-secondary" type="button" disabled={orderActionsBlocked} onClick={() => setCompanionAction({ occupantId: occupant.id })}><UserX aria-hidden="true" size={16} />撤销登记</button> : null}
                </div>
                <dl className="detail-list">{occupantSnapshotEntries(occupant).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{String(value)}</dd></div>)}</dl>
              </li>
            ))}
          </ol>
        </section>
        <section className="detail-section" aria-labelledby="stay-heading"><div className="section-title-row"><h2 id="stay-heading">住宿状态</h2><StatusBadge value={view.order.status} label={businessStatusLabel(view.order.status)} /></div><dl className="detail-list"><div><dt>{effectiveArrangementTitle(view.effectiveArrangement.presentation)}</dt><dd>{formatDate(view.effectiveArrangement.arrivalDate)} 至 {formatDate(view.effectiveArrangement.departureDate)}</dd></div><div><dt>住宿类型</dt><dd>{view.order.stay_type === "FREE" ? "免费住宿" : view.order.member_id || view.order.member_contract_id ? "会员住宿" : "普通住宿"}</dd></div>{view.order.stay_type === "FREE" ? <><div><dt>免费入住类型</dt><dd>{view.order.free_stay_category_code === "VOLUNTEER" ? "义工" : view.order.free_stay_category_code === "RECEPTION" ? "接待" : "历史未记录"}</dd></div><div><dt>免费入住原因</dt><dd>{view.order.free_stay_reason}</dd></div></> : view.order.member_id || view.order.member_contract_id ? <div><dt>住宿来源</dt><dd>会员权益</dd></div> : <><div><dt>订单来源渠道</dt><dd>{view.order.booking_channel_code ? bookingChannelLabels[view.order.booking_channel_code] : "历史未记录"}</dd></div><div><dt>渠道订单号</dt><dd>{view.order.booking_channel_code === "WECOM" ? "不适用" : view.order.channel_order_reference ?? (view.order.booking_channel_code ? "未填写" : "历史未记录")}</dd></div></>}</dl></section>
      </div>

      <OrderLifecycleSections
        view={view}
        inventoryUnits={orderInventoryUnits}
        showPerOrderFunds={showPerOrderFunds}
        channelPriceDifferenceReason={currentPricingRevision?.reason.note}
      />

      <section id="order-funds" className="detail-section full-detail" aria-labelledby="facts-heading"><div className="section-title-row"><h2 id="facts-heading">收退款与冲销记录</h2><span>{itemCountLabel(view.collectionFacts.length)}</span></div>{view.collectionFacts.length ? <div className="table-region" role="region" aria-label="收退款与冲销记录表格" tabIndex={0}><table className="data-table compact-table"><thead><tr><th scope="col">序号</th><th scope="col">类型</th><th scope="col">金额</th><th scope="col">净影响</th><th scope="col">外部交易单号</th><th scope="col">收退款方式</th><th scope="col">备注 / 退款原因</th><th scope="col">记录时间</th><th scope="col" className="fact-actions-col">操作</th></tr></thead><tbody>{view.collectionFacts.map((fact, index) => <tr key={fact.fact_id}><td><span className="fact-sequence">{index + 1}</span></td><th scope="row"><StatusBadge value={fact.fact_type} label={collectionFactTypeLabel(fact.fact_type)} /></th><td>{formatMinor(fact.amount_minor, fact.currency)}</td><td>{formatMinor(fact.net_effect_minor, fact.currency)}</td><td>{collectionFactTransactionReferenceLabel(view.collectionFacts, fact)}</td><td>{collectionMethodLabel(fact.method)}</td><td><CollectionFactNote fact={fact} /></td><td>{formatDateTime(fact.created_at)}</td><td><FactActions fact={fact} facts={view.collectionFacts} canRefund={enabledActions.has("RECORD_REFUND") && remainingRefundableMinor(view.collectionFacts, fact) > 0} canReverse={collectionFactCanReverse(view.collectionFacts, fact, enabledActions.has("REVERSE_FACT"))} disabled={orderActionsBlocked} onRefund={() => openForm("RECORD_REFUND", fact.fact_id)} onReverse={() => openForm("REVERSE_FACT", fact.fact_id)} /></td></tr>)}</tbody></table></div> : <EmptyState title="尚无收退款记录" detail={externalChannelFunds ? "渠道订单不在 PMS 登记单笔收退款。" : "使用订单操作记录第一笔独立收款。"} />}</section>

      {view.amendments.some((amendment) => amendment.amendment_type === "MANAGE_ORDER_OCCUPANTS") ? <details className="detail-disclosure"><summary>同住人登记记录</summary><section className="detail-section full-detail" aria-labelledby="companion-history-heading">
        <div className="section-title-row"><h2 id="companion-history-heading">同住人登记记录</h2></div>
        <div className="amendment-list">{view.amendments.filter((amendment) => amendment.amendment_type === "MANAGE_ORDER_OCCUPANTS").map((amendment) => {
          const payload = amendment.payload as Record<string, unknown>;
          const person = payload.guest as { nickname?: string; fullName?: string } | undefined;
          return <article key={amendment.id}><div><strong>{payload.action === "ADD" ? "添加同住人" : "撤销登记"} · {person?.nickname || person?.fullName}</strong><span>{amendment.actor?.displayName ?? "工作人员"} · {formatDateTime(amendment.created_at)}</span><p>{amendment.reason_note}</p></div><div className="companion-history-summary"><span>{String(payload.beforeCount)} 人 → {String(payload.afterCount)} 人</span><span>{formatDate(String(payload.arrivalDate))} 至 {formatDate(String(payload.departureDate))}</span></div></article>;
        })}</div>
      </section></details> : null}

      <TemporaryOtherRoomArrangementHistory view={view} inventoryUnits={orderInventoryUnits} />

      <CompleteStayCorrectionHistory view={view} />

      {currentReleaseFeatures.cleaningWorkflow && view.cleaningTasks.length ? <section className="detail-section full-detail" aria-labelledby="cleaning-heading" data-testid="order-cleaning-tasks">
        <div className="section-title-row"><h2 id="cleaning-heading"><Sparkles aria-hidden="true" size={18} />清洁任务</h2><span>{view.cleaningTasks.length}</span></div>
        <ol className="amendment-list">{view.cleaningTasks.map((task) => {
          const unit = unitMap.get(task.inventoryUnitId);
          return <li key={task.id} data-testid="order-cleaning-task">
            <div><strong>{unit ? `${unit.code} · ${unit.name}` : "退房房源"}</strong><StatusBadge value={task.status} label={businessStatusLabel(task.status)} /></div>
            <div><span>清洁日期：{formatDate(task.serviceDate)}</span><small>生成：{task.createdBy?.displayName ?? "系统记录"} · {formatDateTime(task.createdAt)}</small></div>
            {task.status === "COMPLETED" ? <div><span>清洁已完成</span><small>{task.completedBy?.displayName ?? "系统记录"} · {formatDateTime(task.completedAt ?? undefined)}</small></div> : <p>等待工作人员完成清洁。</p>}
          </li>;
        })}</ol>
      </section> : null}

      <details className="detail-disclosure"><summary>住宿人资料更正记录</summary>
      <section className="detail-section full-detail" aria-labelledby="occupant-corrections-heading">
        <div className="section-title-row"><h2 id="occupant-corrections-heading">住宿人资料更正记录</h2><span>{itemCountLabel(view.occupantCorrections.length)}</span></div>
        {view.occupantCorrections.length ? <div className="amendment-list" data-testid="occupant-correction-history">{view.occupantCorrections.map((correction) => {
          const occupant = occupants.find((candidate) => candidate.id === correction.occupantId);
          return <article key={correction.id} data-testid="occupant-correction-history-item">
            <div><strong>第 {correction.sequence} 次 · {correction.correctedSnapshot.nickname || `住宿人 ${occupant?.ordinal ?? "资料"}`}</strong><span>{correction.actor.displayName} · {formatDateTime(correction.createdAt)}</span><p>{correction.reason.note.trim() || "未填写更正说明"}</p></div>
            <div><span>更正前</span><dl className="detail-list">{occupantSnapshotEntries(correction.priorSnapshot).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{String(value)}</dd></div>)}</dl></div>
            <div><span>更正后</span><dl className="detail-list">{occupantSnapshotEntries(correction.correctedSnapshot).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{String(value)}</dd></div>)}</dl></div>
          </article>;
        })}</div> : <EmptyState title="尚无资料更正" detail="住宿人创建时的原始资料保持不变；人工更正会在此追加审计记录。" />}
      </section>
      </details>

      <details className="detail-disclosure"><summary>计价记录</summary>
      <section className="detail-section full-detail" aria-labelledby="revisions-heading">
        <div className="section-title-row"><h2 id="revisions-heading">计价记录</h2><span>{itemCountLabel(view.pricingRevisions.length)}</span></div>
        <div className="table-region" role="region" aria-label="计价记录表格" tabIndex={0}>
          <table className="data-table compact-table">
            <thead><tr><th scope="col">计价记录</th><th scope="col">锁定政策</th><th scope="col">周期</th><th scope="col">权益覆盖</th><th scope="col">政策基础金额</th><th scope="col">与政策基础金额差额</th><th scope="col">订单金额</th><th scope="col">计价方式与说明</th></tr></thead>
            <tbody>{view.pricingRevisions.map((revision) => {
              return <tr key={revision.id}>
                <th scope="row">第 {revision.revision_no} 次计价</th>
                <td>{meta.pricingPolicyVersions.some((policy) => policy.id === revision.policy_version_id) ? "已锁定政策" : "历史锁定政策"}</td>
                <td>{formatDate(revision.arrival_date)} 至 {formatDate(revision.departure_date)}</td>
                <td>{countArray(revision.coverage_set)}</td>
                <td>{formatMinor(revision.policy_base_amount_minor, revision.currency)}</td>
                <td><strong>{formatMinor(revision.difference_from_policy_minor, revision.currency)}</strong></td>
                <td><strong>{formatMinor(revision.current_contract_amount_minor, revision.currency)}</strong></td>
                <td><strong>{pricingBasisLabel(revision.pricing_basis)}</strong><small>{revision.reason.note || "无需说明"}</small></td>
              </tr>;
            })}</tbody>
          </table>
        </div>
      </section>
      </details>

      <OrderMembershipCoverageSection view={view} unitMap={unitMap} />



      {formAction ? <ActionFormDialog action={formAction} view={view} writeBlocked={orderActionsBlocked} {...(initialFactId ? { initialFactId } : {})} {...(commandDraft?.commandType === formAction ? { draft: commandDraft } : {})} onClose={() => { setFormAction(undefined); setInitialFactId(undefined); setCommandDraft(undefined); }} onSubmit={(request) => { if (orderActionsBlocked || !enabledActions.has(formAction)) return; setFormAction(undefined); setInitialFactId(undefined); setCommandDraft(undefined); setRecoveryDialogOpen(false); setCommand(request); }} /> : null}
      {completeStayAction ? <CompleteStayDialog view={view} {...(commandDraft?.commandType === "COMPLETE_STAY" ? { draft: commandDraft } : {})} onClose={() => { setCompleteStayAction(false); setCommandDraft(undefined); }} onSubmit={(request) => { if (orderActionsBlocked || !enabledActions.has("COMPLETE_STAY")) return; setCompleteStayAction(false); setCommandDraft(undefined); setRecoveryDialogOpen(false); setCommand(request); }} /> : null}
      {convertingToMembership ? <StayCollectionConversionDialog
        view={view}
        members={upgradeMembers}
        membershipProducts={meta.membershipProducts}
        unitMap={unitMap}
        {...(commandDraft?.commandType === "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP" ? { draft: commandDraft } : {})}
        onClose={() => { setConvertingToMembership(false); setCommandDraft(undefined); }}
        onSubmit={(request) => {
          if (orderActionsBlocked || !enabledActions.has("CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP")) return;
          setConvertingToMembership(false);
          setCommandDraft(undefined);
          setRecoveryDialogOpen(false);
          setCommand(request);
        }}
      /> : null}
      {stayDateAction ? <StayDateChangeDrawer
        action={stayDateAction}
        mode={stayDateMode}
        view={view}
        inventoryUnitLabel={visibleArrangementUnits.join(" → ")}
        inventoryUnits={meta.inventoryUnits}
        writeBlocked={orderActionsBlocked}
        {...(error ? { writeBlockedReason: "订单刷新失败，草稿已保留；读取恢复后可继续核对。" } : {})}
        runPreview={commandRecovery.runPreview}
        {...(commandDraft?.commandType === stayDateAction ? { draft: commandDraft } : {})}
        onClose={() => { setStayDateAction(undefined); setStayDateMode("DATE_CHANGE"); setCommandDraft(undefined); }}
        onSubmit={(request) => {
          if (orderActionsBlocked
            || !orderStayDateRequestIsCompatible(stayDateAction, stayDateMode, request.commandType)
            || !enabledActions.has(request.commandType as OrderActionCode)) return;
          setStayDateAction(undefined);
          setStayDateMode("DATE_CHANGE");
          setCommandDraft(undefined);
          setRecoveryDialogOpen(false);
          setCommand(request);
        }}
      /> : null}
      {movingUnit ? <MoveUnitDrawer
        view={view}
        units={meta.inventoryUnits}
        writeBlocked={orderActionsBlocked}
        {...(error ? { writeBlockedReason: "订单刷新失败，草稿已保留；读取恢复后可继续核对。" } : {})}
        runPreview={commandRecovery.runPreview}
        {...(commandDraft?.commandType === "MOVE_UNIT" ? { draft: commandDraft } : {})}
        onClose={() => { setMovingUnit(false); setCommandDraft(undefined); }}
        onSubmit={(request) => {
          if (orderActionsBlocked || !enabledActions.has("MOVE_UNIT")) return;
          setMovingUnit(false);
          setCommandDraft(undefined);
          setRecoveryDialogOpen(false);
          setCommand(request);
        }}
      /> : null}
      {companionAction ? <OrderCompanionDialog
        view={view}
        {...companionAction}
        {...(commandDraft?.commandType === "MANAGE_ORDER_OCCUPANTS" ? { draft: commandDraft } : {})}
        onClose={() => { setCompanionAction(undefined); setCommandDraft(undefined); }}
        onSubmit={(request) => {
          if (orderActionsBlocked || !enabledActions.has("MANAGE_ORDER_OCCUPANTS")) return;
          setCompanionAction(undefined);
          setCommandDraft(undefined);
          setRecoveryDialogOpen(false);
          setCommand(request);
        }}
      /> : null}
      {correctingOccupant ? <OrderOccupantCorrectionDialog
        view={view}
        occupant={correctingOccupant}
        phoneRequiredForStayMembershipUpgrade={pendingStayMembershipUpgrade?.primaryOccupantId === correctingOccupant.id}
        {...(correctionDraftMatchesOccupant(commandDraft, view.order.id, correctingOccupant.id) ? { draft: commandDraft } : {})}
        onClose={() => {
          setCorrectingOccupant(undefined);
          setCommandDraft(undefined);
          if (pendingStayMembershipUpgrade?.primaryOccupantId === correctingOccupant.id) setPendingStayMembershipUpgrade(undefined);
        }}
        onSubmit={(request) => {
          if (orderActionsBlocked || !enabledActions.has("CORRECT_ORDER_OCCUPANT")) return;
          setCorrectingOccupant(undefined);
          setCommandDraft(undefined);
          setRecoveryDialogOpen(false);
          setCommand(request);
        }}
      /> : null}
      {lifecycleAction ? <OrderLifecycleActionDrawer
        action={lifecycleAction}
        view={view}
        inventoryUnitLabels={Object.fromEntries(orderInventoryUnits.map((unit) => [unit.id, [unit.building_code ? `${unit.building_code}栋` : null, unit.name].filter(Boolean).join(" ")]))}
        writeBlocked={orderActionsBlocked}
        {...(commandDraft?.commandType === lifecycleAction ? { draft: commandDraft } : {})}
        onClose={() => { setLifecycleAction(undefined); setCommandDraft(undefined); }}
        onSubmit={(request) => {
          if (orderActionsBlocked || request.commandType !== lifecycleAction || !enabledActions.has(lifecycleAction)) return;
          setLifecycleAction(undefined);
          setCommandDraft(undefined);
          setRecoveryDialogOpen(false);
          setCommand(request);
        }}
      /> : null}
      {command ? <CommandDialog
        key={recoveryDialogOpen ? `recovery-${pendingRecovery?.confirmationKey ?? "missing"}` : "new-order-command"}
        request={command}
        onClose={closeCommandDialog}
        onCommitted={async () => {
          if (!orderId) throw new Error("当前订单引用缺失，无法刷新订单详情");
          const response = await api.order(orderId);
          assertOrderViewAllowedActions(response, currentPropertyAllowedActions);
          setView(response);
          setLoadedPrincipalOrderScope(principalOrderScope);
          viewRef.current = response;
          if (command.commandType === "CORRECT_ORDER_OCCUPANT" && pendingStayMembershipUpgrade) {
            const corrected = response.occupants.find((occupant) => occupant.id === pendingStayMembershipUpgrade.primaryOccupantId);
            const resumed = corrected
              ? stayMembershipUpgradeResumeAfterOccupantCorrection(pendingStayMembershipUpgrade, corrected)
              : undefined;
            setPendingStayMembershipUpgrade(undefined);
            if (resumed) beginStayMembershipUpgrade(response);
          }
        }}
        onBusinessSuccess={(message) => setCommandNotice(message)}
        onBusinessNotExecuted={(message) => setCommandNotice(message)}
        onReturnToEdit={returnCommandToEdit}
        {...(recoveryDialogOpen && pendingRecovery ? {
          initialConfirmationKey: pendingRecovery.confirmationKey
        } : {})}
        onProgress={(progress) => commandRecovery.track(command, progress)}
      /> : null}
    </div>
    </ModalNoticeProvider>
  );
}
