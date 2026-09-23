import { TennisApiError, type TennisApi } from "./api";
import type { PendingCommand } from "./components";
import type { CommandReceipt, OrderRecord } from "./types";

export type BookingConfirmationRecovery =
  | { kind: "confirmed"; quoteId: string; orderId: string }
  | { kind: "expired"; quoteId: string };

/** Replay only the saved confirmation, never the current form or a new key. */
export async function recoverBookingConfirmation(
  api: TennisApi,
  pending: PendingCommand,
): Promise<BookingConfirmationRecovery> {
  const quoteId = pending.intent.slice("quote.confirm:".length);
  if (!pending.intent.startsWith("quote.confirm:") || !quoteId)
    throw new Error("原预订记录不完整，请联系管理员核对。");
  const receipt = await api<CommandReceipt | null>(`/receipts/${encodeURIComponent(pending.key)}`);
  if (receipt) {
    if (receipt.commandType !== "quote.confirm" || typeof receipt.result.orderId !== "string" || !receipt.result.orderId)
      throw new Error("办理结果与原预订不一致，请联系管理员核对。");
    return { kind: "confirmed", quoteId, orderId: receipt.result.orderId };
  }

  let saved: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(pending.payload);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    saved = value as Record<string, unknown>;
    if (saved.quoteId !== quoteId || Object.keys(saved).some((key) => !["quoteId", "staffHold"].includes(key)))
      throw new Error();
    if (saved.staffHold !== undefined) {
      const hold = saved.staffHold as Record<string, unknown>;
      if (!hold || typeof hold !== "object" || Array.isArray(hold) ||
        Object.keys(hold).some((key) => !["until", "reason"].includes(key)) ||
        typeof hold.until !== "string" || typeof hold.reason !== "string") throw new Error();
    }
  } catch {
    throw new Error("原预订内容不完整，请联系管理员核对。");
  }
  try {
    const order = await api<OrderRecord>(`/quotes/${encodeURIComponent(quoteId)}/confirm`, "POST", {
      commandKey: pending.key,
      ...(saved.staffHold !== undefined ? { staffHold: saved.staffHold } : {}),
    });
    if (!order || typeof order.id !== "string" || !order.id)
      throw new Error("暂时无法核对原预订，请保留当前记录并重试。");
    return { kind: "confirmed", quoteId, orderId: order.id };
  } catch (error) {
    // confirmQuote checks the original receipt and order in its transaction
    // before returning this rejection. A missing read receipt alone is not proof.
    if (error instanceof TennisApiError && error.status === 409 && error.code === "QUOTE_EXPIRED")
      return { kind: "expired", quoteId };
    throw error;
  }
}
