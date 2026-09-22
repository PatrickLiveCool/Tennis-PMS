import type { RefundGroupRecord } from "../../../../packages/db/src/tennis/refunds";
import { cents } from "./components";
import type { OrderDetail } from "./types";

type RefundOrder = {
  paymentStatus: OrderDetail["paymentStatus"];
  lines: Pick<OrderDetail["lines"][number], "id" | "cancelledAt" | "remainingRefundCents">[];
};
export interface RefundDraftLine {
  lineId: string;
  selected: boolean;
  amount: string;
  cancel: boolean | null;
}
export interface SubmittedRefundLine {
  lineId: string;
  refundCents: number;
  cancel: boolean;
}
export interface RefundInventorySummary {
  cancelled: string[];
  retained: string[];
  alreadyCancelled: string[];
}

export function newRefundDraftLines(order: RefundOrder): RefundDraftLine[] {
  return order.lines.map((line) => ({
    lineId: line.id, selected: false, amount: "0.00",
    cancel: line.cancelledAt ? false : order.paymentStatus === "REFUNDED" ? true : null,
  }));
}

/** Existing boolean drafts retain their original choice; an absent choice never cancels a booking. */
export function refundLineCancellation(order: RefundOrder, draft: RefundDraftLine): boolean | null {
  const original = order.lines.find((line) => line.id === draft.lineId);
  if (!original) return null;
  if (original.cancelledAt) return false;
  if (order.paymentStatus === "REFUNDED") return true;
  return typeof draft.cancel === "boolean" ? draft.cancel : null;
}

export function prepareRefundLines(order: RefundOrder, drafts: RefundDraftLine[]): SubmittedRefundLine[] {
  const selected = drafts.filter((line) => line.selected);
  if (!selected.length) throw new Error("请选择需要办理的时段。");
  return selected.map((line) => {
    const original = order.lines.find((item) => item.id === line.lineId);
    if (!original) throw new Error("订单时段已更新，请重新打开订单。");
    const cancel = refundLineCancellation(order, line);
    if (cancel === null) throw new Error("请为所选时段选择处理方式。");
    const refundCents = cents(line.amount);
    if (refundCents > (original.remainingRefundCents ?? 0)) throw new Error("退款金额不能超过该时段的剩余可退金额。");
    if (!cancel && refundCents === 0) throw new Error(original.cancelledAt
      ? "已取消的时段请输入大于 0 的退款金额。"
      : "仅退款时，退款金额须大于 0；如需释放场地，请选择取消时段。");
    return { lineId: line.lineId, refundCents, cancel };
  });
}

export function refundInventorySummary(order: RefundOrder, lines: readonly SubmittedRefundLine[]): RefundInventorySummary {
  const result: RefundInventorySummary = { cancelled: [], retained: [], alreadyCancelled: [] };
  for (const line of lines) {
    const original = order.lines.find((item) => item.id === line.lineId);
    if (!original) continue;
    if (original.cancelledAt) result.alreadyCancelled.push(line.lineId);
    else if (line.cancel) result.cancelled.push(line.lineId);
    else result.retained.push(line.lineId);
  }
  return result;
}

export function refundSubmitLabel(amountCents: number, summary: RefundInventorySummary): string {
  if (summary.cancelled.length) {
    if (amountCents === 0) return "确认取消时段";
    return summary.retained.length ? "确认退款并取消部分时段" : "确认取消时段并退款";
  }
  return summary.retained.length ? "确认退款，保留预订" : "确认退款";
}

export function refundResultNotice(refund: Pick<RefundGroupRecord, "amountCents" | "status">, summary: RefundInventorySummary): string {
  const parts = [refund.amountCents === 0 ? "本次无需退款。"
    : refund.status === "SUCCEEDED" ? "退款已按原支付来源退回。"
      : refund.status === "FAILED" ? "退款失败，请核对退款记录。" : "退款已申请，正在等待到账结果。"];
  if (summary.cancelled.length) parts.push(`已取消 ${summary.cancelled.length} 个时段，场地已释放。`);
  if (summary.retained.length) parts.push(`${summary.retained.length} 个时段仍保留预订。`);
  if (summary.alreadyCancelled.length) parts.push(`${summary.alreadyCancelled.length} 个时段此前已取消。`);
  return parts.join("");
}
