import type { HistoricalCommandType } from "@qintopia/contracts";

export const u1CommandTypes = [
  "MANAGE_ROOM_CATALOG",
  "CREATE_ORDER",
  "CREATE_MEMBER",
  "CREATE_MEMBERSHIP_ORDER",
  "RECORD_MEMBERSHIP_PAYMENT",
  "CORRECT_MEMBERSHIP_PAYMENT",
  "ACTIVATE_MEMBERSHIP_ORDER",
  "CORRECT_MEMBER_ENTITLEMENT_BALANCE",
  "LOCK_MAINTENANCE",
  "RELEASE_MAINTENANCE",
  "CORRECT_ORDER_OCCUPANT",
  "MANAGE_ORDER_OCCUPANTS",
  "REPRICE_ORDER",
  "CHECK_IN",
  "CHECK_OUT",
  "REVOKE_CHECK_OUT",
  "RESCHEDULE_STAY",
  "EXTEND_STAY",
  "SHORTEN_STAY",
  "MOVE_UNIT",
  "CANCEL_ORDER",
  "MARK_NO_SHOW",
  "REVOKE_CHECK_IN",
  "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP"
] as const satisfies readonly HistoricalCommandType[];

export type U1CommandType = (typeof u1CommandTypes)[number];
export type CommandShellPhase =
  | "AUTO_PREVIEWING"
  | "READY_TO_CONFIRM"
  | "EDITING"
  | "PREVIEW_EXPIRED"
  | "CONFIRMING"
  | "RESULT_UNKNOWN"
  | "NOT_EXECUTED"
  | "SUCCEEDED";

export interface CommandShellState {
  phase: CommandShellPhase;
  attemptId: number;
  previewId?: string;
  confirmationKey?: string;
}

export type CommandShellEvent =
  | { type: "PREVIEW_STARTED"; attemptId: number }
  | { type: "PREVIEW_READY"; attemptId: number; previewId: string }
  | { type: "RETURN_TO_EDIT"; attemptId: number }
  | { type: "PREVIEW_EXPIRED"; attemptId: number }
  | { type: "CONFIRM_STARTED"; attemptId: number; confirmationKey: string }
  | { type: "RESULT_UNKNOWN"; attemptId: number; confirmationKey: string }
  | { type: "NOT_EXECUTED"; attemptId: number; confirmationKey?: string }
  | { type: "SUCCEEDED"; attemptId: number; confirmationKey: string };

const allowedTransitions: Record<CommandShellPhase, readonly CommandShellEvent["type"][]> = {
  AUTO_PREVIEWING: ["PREVIEW_STARTED", "PREVIEW_READY", "NOT_EXECUTED", "RETURN_TO_EDIT"],
  READY_TO_CONFIRM: ["RETURN_TO_EDIT", "PREVIEW_EXPIRED", "CONFIRM_STARTED"],
  EDITING: ["PREVIEW_STARTED"],
  PREVIEW_EXPIRED: ["PREVIEW_STARTED", "RETURN_TO_EDIT"],
  CONFIRMING: ["RESULT_UNKNOWN", "NOT_EXECUTED", "SUCCEEDED"],
  RESULT_UNKNOWN: ["RESULT_UNKNOWN", "NOT_EXECUTED", "SUCCEEDED"],
  NOT_EXECUTED: ["PREVIEW_STARTED", "RETURN_TO_EDIT"],
  SUCCEEDED: []
};

const u1CommandTypeSet = new Set<HistoricalCommandType>(u1CommandTypes);

export function isU1CommandType(commandType: HistoricalCommandType): commandType is U1CommandType {
  return u1CommandTypeSet.has(commandType);
}

export function initialCommandShellState(input?: {
  attemptId?: number;
  confirmationKey?: string;
  succeeded?: boolean;
  notExecuted?: boolean;
}): CommandShellState {
  const attemptId = input?.attemptId ?? 1;
  if (input?.succeeded && input.confirmationKey) {
    return { phase: "SUCCEEDED", attemptId, confirmationKey: input.confirmationKey };
  }
  if (input?.notExecuted) {
    return {
      phase: "NOT_EXECUTED",
      attemptId,
      ...(input.confirmationKey ? { confirmationKey: input.confirmationKey } : {})
    };
  }
  if (input?.confirmationKey) {
    return { phase: "RESULT_UNKNOWN", attemptId, confirmationKey: input.confirmationKey };
  }
  return { phase: "AUTO_PREVIEWING", attemptId };
}

export function transitionCommandShell(
  current: CommandShellState,
  event: CommandShellEvent
): { accepted: boolean; state: CommandShellState } {
  if (event.attemptId !== current.attemptId || !allowedTransitions[current.phase].includes(event.type)) {
    return { accepted: false, state: current };
  }
  if ((event.type === "RESULT_UNKNOWN" || event.type === "SUCCEEDED" || (event.type === "NOT_EXECUTED" && event.confirmationKey !== undefined))
    && current.confirmationKey !== event.confirmationKey) {
    return { accepted: false, state: current };
  }
  switch (event.type) {
    case "PREVIEW_STARTED":
      return { accepted: true, state: { phase: "AUTO_PREVIEWING", attemptId: current.attemptId } };
    case "PREVIEW_READY":
      return { accepted: true, state: { phase: "READY_TO_CONFIRM", attemptId: current.attemptId, previewId: event.previewId } };
    case "RETURN_TO_EDIT":
      return { accepted: true, state: { phase: "EDITING", attemptId: current.attemptId } };
    case "PREVIEW_EXPIRED":
      return { accepted: true, state: { ...current, phase: "PREVIEW_EXPIRED" } };
    case "CONFIRM_STARTED":
      return {
        accepted: true,
        state: { ...current, phase: "CONFIRMING", confirmationKey: event.confirmationKey }
      };
    case "RESULT_UNKNOWN":
      return { accepted: true, state: { ...current, phase: "RESULT_UNKNOWN" } };
    case "NOT_EXECUTED":
      return {
        accepted: true,
        state: { phase: "NOT_EXECUTED", attemptId: current.attemptId, ...(event.confirmationKey ? { confirmationKey: event.confirmationKey } : {}) }
      };
    case "SUCCEEDED":
      return { accepted: true, state: { ...current, phase: "SUCCEEDED" } };
  }
}

export function commandShellSuccessMessage(commandType: U1CommandType): string {
  switch (commandType) {
    case "MANAGE_ROOM_CATALOG": return "房型与价格设置已保存，页面已刷新。";
    case "CREATE_ORDER": return "住宿订单已创建，页面已刷新。";
    case "CREATE_MEMBER": return "会员档案已创建，会员列表已刷新。";
    case "CREATE_MEMBERSHIP_ORDER": return "会员订单已创建，会员资料已刷新。";
    case "RECORD_MEMBERSHIP_PAYMENT": return "企微收款已登记，会员订单已刷新。";
    case "CORRECT_MEMBERSHIP_PAYMENT": return "企微收款已更正，会员订单已刷新。";
    case "ACTIVATE_MEMBERSHIP_ORDER": return "会员订单已生效，权益余额已刷新。";
    case "CORRECT_MEMBER_ENTITLEMENT_BALANCE": return "会员余额已更正，权益记录已刷新。";
    case "LOCK_MAINTENANCE": return "维修锁房已设置，房态已刷新。";
    case "RELEASE_MAINTENANCE": return "维修锁房已释放，房态已刷新。";
    case "CORRECT_ORDER_OCCUPANT": return "住宿人资料已更正，订单信息已刷新。";
    case "MANAGE_ORDER_OCCUPANTS": return "同住人登记已更新，订单人数已刷新。";
    case "REPRICE_ORDER": return "订单金额已调整，订单信息已刷新。";
    case "CHECK_IN": return "办理入住已完成，住宿状态已刷新。";
    case "CHECK_OUT": return "办理退房已完成，住宿状态已刷新。";
    case "REVOKE_CHECK_OUT": return "退房已撤销，原住宿安排已恢复。";
    case "RESCHEDULE_STAY": return "住宿日期已调整，订单和房态已刷新。";
    case "EXTEND_STAY": return "住宿已延长，订单和房态已刷新。";
    case "SHORTEN_STAY": return "住宿已缩短，订单和房态已刷新。";
    case "MOVE_UNIT": return "换房已完成，订单和房态已刷新。";
    case "CANCEL_ORDER": return "订单已取消，订单和房态已刷新。";
    case "MARK_NO_SHOW": return "订单已标记未到，订单和房态已刷新。";
    case "REVOKE_CHECK_IN": return "入住已撤销，订单、房态和会员权益已刷新。";
    case "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP": return "升级会员已完成，订单和会员权益已刷新。";
  }
}

export function commandShellLabel(commandType: U1CommandType): string {
  switch (commandType) {
    case "MANAGE_ROOM_CATALOG": return "修改房型与价格";
    case "CREATE_ORDER": return "创建住宿订单";
    case "CREATE_MEMBER": return "创建会员档案";
    case "CREATE_MEMBERSHIP_ORDER": return "创建会员订单";
    case "RECORD_MEMBERSHIP_PAYMENT": return "收款";
    case "CORRECT_MEMBERSHIP_PAYMENT": return "更正企微收款";
    case "ACTIVATE_MEMBERSHIP_ORDER": return "生效会员订单";
    case "CORRECT_MEMBER_ENTITLEMENT_BALANCE": return "更正会员余额";
    case "LOCK_MAINTENANCE": return "设置维修锁房";
    case "RELEASE_MAINTENANCE": return "释放维修锁房";
    case "CORRECT_ORDER_OCCUPANT": return "更正住宿人资料";
    case "MANAGE_ORDER_OCCUPANTS": return "管理同住人";
    case "REPRICE_ORDER": return "调整订单金额";
    case "CHECK_IN": return "办理入住";
    case "CHECK_OUT": return "办理退房";
    case "REVOKE_CHECK_OUT": return "撤销退房";
    case "RESCHEDULE_STAY": return "调整住宿日期";
    case "EXTEND_STAY": return "延长住宿";
    case "SHORTEN_STAY": return "缩短住宿或提前退房";
    case "MOVE_UNIT": return "办理换房";
    case "CANCEL_ORDER": return "取消订单";
    case "MARK_NO_SHOW": return "标记未到";
    case "REVOKE_CHECK_IN": return "撤销入住";
    case "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP": return "升级会员";
  }
}

export function commandShellNotExecutedMessage(commandType: U1CommandType): string {
  const noun = commandType === "CREATE_ORDER" ? "住宿订单"
    : commandType === "CREATE_MEMBER" ? "会员档案"
      : commandType === "LOCK_MAINTENANCE" ? "维修锁房"
        : "本次操作";
  return `${noun}未写入；原草稿已保留，可以返回修改后重新核对。`;
}

export function commandShellRefreshFailedMessage(commandType: U1CommandType): string {
  return `${commandShellLabel(commandType)}已完成，但页面刷新失败。请点击页面上的刷新按钮查看最新结果。`;
}
