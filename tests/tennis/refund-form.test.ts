import { describe, expect, it } from "vitest";
import {
  newRefundDraftLines,
  prepareRefundLines,
  refundInventorySummary,
  refundLineCancellation,
  refundResultNotice,
  refundSubmitLabel,
  type RefundDraftLine,
} from "../../apps/web/src/tennis/refund-form";

const order = {
  paymentStatus: "PAID" as const,
  lines: [
    { id: "first", cancelledAt: null, remainingRefundCents: 12000 },
    { id: "second", cancelledAt: null, remainingRefundCents: 8000 },
  ],
};
const draft = (lineId = "first", cancel: boolean | null = null, amount = "120.00"): RefundDraftLine =>
  ({ lineId, selected: true, amount, cancel });

describe("refund form decisions", () => {
  it("requires an explicit choice for a fresh selected line and preserves existing boolean drafts", () => {
    expect(newRefundDraftLines(order).every((line) => line.cancel === null && !line.selected)).toBe(true);
    expect(() => prepareRefundLines(order, [draft()])).toThrow("选择处理方式");
    for (const cancel of [true, false]) {
      const lines = prepareRefundLines(order, [draft("first", cancel)]);
      expect(lines).toEqual([{ lineId: "first", refundCents: 12000, cancel }]);
    }
    expect(refundLineCancellation(order, { ...draft(), cancel: undefined } as unknown as RefundDraftLine)).toBeNull();
  });

  it("permits zero-refund cancellation for a fully refunded line while the other line remains paid", () => {
    const partial = { ...order, paymentStatus: "PARTIALLY_REFUNDED" as const,
      lines: order.lines.map((line) => ({ ...line, remainingRefundCents: line.id === "first" ? 0 : 8000 })) };
    const lines = prepareRefundLines(partial, [draft("first", true, "0.00")]);
    expect(lines).toEqual([{ lineId: "first", refundCents: 0, cancel: true }]);
    expect(refundSubmitLabel(0, refundInventorySummary(partial, lines))).toBe("确认取消时段");
    expect(() => prepareRefundLines(partial, [draft("first", false, "0")])).toThrow("仅退款时");
    expect(() => prepareRefundLines(partial, [draft("first", true, "0.01")])).toThrow("剩余可退金额");
  });

  it("uses the existing zero-refund release path after the entire order was refunded", () => {
    const refunded = { ...order, paymentStatus: "REFUNDED" as const,
      lines: order.lines.map((line) => ({ ...line, remainingRefundCents: 0 })) };
    const lines = prepareRefundLines(refunded, [draft("first", false, "0")]);
    expect(lines[0]?.cancel).toBe(true);
    expect(newRefundDraftLines(refunded).every((line) => line.cancel === true)).toBe(true);
    expect(refundResultNotice({ amountCents: 0, status: "SUCCEEDED" }, refundInventorySummary(refunded, lines)))
      .toBe("本次无需退款。已取消 1 个时段，场地已释放。");
  });

  it("never tries to cancel an already-cancelled line again, even when a saved draft requested cancellation", () => {
    const cancelled = { ...order, lines: [{ ...order.lines[0]!, cancelledAt: "2026-09-22T00:00:00Z" }] };
    const lines = prepareRefundLines(cancelled, [draft("first", true)]);
    expect(lines[0]?.cancel).toBe(false);
    const summary = refundInventorySummary(cancelled, lines);
    expect(summary).toEqual({ cancelled: [], retained: [], alreadyCancelled: ["first"] });
    expect(refundSubmitLabel(12000, summary)).toBe("确认退款");
    expect(refundResultNotice({ amountCents: 12000, status: "SUCCEEDED" }, summary))
      .toBe("退款已按原支付来源退回。1 个时段此前已取消。");
  });

  it("describes the submitted cancellation and retained booking separately from an unfinished refund", () => {
    const drafts = [draft("first", true), draft("second", false, "80.00")];
    const submitted = prepareRefundLines(order, drafts);
    const summary = refundInventorySummary(order, submitted);
    // A cleared or edited form cannot change the facts reported for the successful request.
    drafts[0]!.cancel = false;
    drafts[1]!.selected = false;
    expect(refundSubmitLabel(20000, summary)).toBe("确认退款并取消部分时段");
    expect(refundResultNotice({ amountCents: 20000, status: "REQUESTED" }, summary))
      .toBe("退款已申请，正在等待到账结果。已取消 1 个时段，场地已释放。1 个时段仍保留预订。");
    const retained = refundInventorySummary(order, [{ ...submitted[0]!, cancel: false }]);
    expect(refundSubmitLabel(12000, retained)).toBe("确认退款，保留预订");
    expect(refundResultNotice({ amountCents: 12000, status: "SUCCEEDED" }, retained))
      .toBe("退款已按原支付来源退回。1 个时段仍保留预订。");
  });

  it("keeps amount validation and unselected lines out of the submitted refund", () => {
    expect(() => prepareRefundLines(order, [draft("first", true, "1.001")])).toThrow("最多两位小数");
    expect(() => prepareRefundLines(order, [draft("first", true, "120.01")])).toThrow("剩余可退金额");
    expect(prepareRefundLines(order, [draft("first", true), { ...draft("second"), selected: false }])).toHaveLength(1);
  });
});
