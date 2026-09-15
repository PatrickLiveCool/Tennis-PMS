export const assistantOrderActions = ["EXTEND_STAY", "MOVE_UNIT", "RECORD_COLLECTION", "REPRICE_ORDER", "CANCEL_ORDER"] as const;
export type AssistantOrderAction = typeof assistantOrderActions[number];
export const assistantGuides: Record<AssistantOrderAction, { label: string; steps: string[] }> = {
  EXTEND_STAY: { label: "续住", steps: ["选择新的离店日期，核对房间与住宿范围。", "查看系统计算的可用性、费用和会员权益变化。", "核对变更摘要后，由你确认提交；不办理时点击取消。"] },
  MOVE_UNIT: { label: "换房", steps: ["选择换房日期和目标房间或床位。", "核对库存、住宿安排与价格变化。", "查看系统预览，确认无误后提交。"] },
  RECORD_COLLECTION: { label: "记录收款", steps: ["核对订单、实际已收到的款项及收款方式。", "填写金额、需要的交易参考号与备注。", "核对确认页再提交；这里记录收款事实，不代客人付款。"] },
  REPRICE_ORDER: { label: "调整金额", steps: ["填写实际约定的订单金额和调整原因。", "核对原金额、新金额与已收款差额。", "确认后提交；调整订单金额不等于办理收退款。"] },
  CANCEL_ORDER: { label: "取消订单", steps: ["核对客人、订单和取消原因。", "阅读系统展示的库存、会员权益及款项处理提示。", "核对后由你确认取消；需要退款时按正式退款流程办理。"] }
};
export type AssistantEntry = { page: "inventory" | "orders" | "members" | "today" | "settings" | "order"; label: string; steps: string[]; orderId?: string; memberId?: string; action?: AssistantOrderAction };
export interface AssistantSettings { version: number; enabled: boolean; baseUrl: string; model: string; hasKey: boolean; keyReady: boolean; canManage: boolean; managementPropertyId: string | null; updatedAt: string | null }
export interface AssistantSettingsInput { propertyId: string; expectedVersion: number; enabled: boolean; baseUrl: string; model: string; apiKey?: string }
export type AssistantQuestionFeedback = "RESOLVED" | "UNRESOLVED";
export interface AssistantChatRequest { propertyId: string; message: string; conversationId?: string; page: string; orderId?: string; source?: "USER" | "SUGGESTION" | "UNKNOWN" }
export interface AssistantChatReply { conversationId: string; text: string; entries: AssistantEntry[]; questionId?: string }
