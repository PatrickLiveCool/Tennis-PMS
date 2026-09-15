import { createContext, useContext, useEffect } from "react";
import { assistantOrderActions, type AssistantEntry, type AssistantSettings } from "../../../../packages/contracts/src/assistant.ts";

export interface AssistantContextValue {
  open: boolean; toggle: () => void; settings: AssistantSettings | undefined; refreshSettings: () => void;
  guide: AssistantEntry | undefined; pending: AssistantEntry | undefined;
  finishEntry: (error?: string) => void;
}
export const AssistantContext = createContext<AssistantContextValue | null>(null);
export const useAssistant = () => useContext(AssistantContext);
export function AssistantGuide() {
  const assistant = useAssistant();
  if (!assistant?.guide?.action) return null;
  return <details className="assistant-operation-guide" open><summary>操作说明 · {assistant.guide.label}</summary><ol>{assistant.guide.steps.map(step => <li key={step}>{step}</li>)}</ol></details>;
}
export function useAssistantOrderEntry(orderId: string | undefined, ready: boolean, blocked: boolean) {
  const assistant = useAssistant(), entry = assistant?.pending;
  useEffect(() => {
    if (!entry?.action || !entry.orderId || entry.orderId !== orderId || !ready || !assistant) return;
    if (blocked) { assistant.finishEntry("订单正在刷新或当前不可操作，请稍后再打开入口。"); return; }
    if (!assistantOrderActions.includes(entry.action)) { assistant.finishEntry("此操作尚未接入助手。"); return; }
    if (document.querySelector("dialog[open]")) { assistant.finishEntry("请先完成或取消当前表单，再打开另一个操作入口。"); return; }
    // Reuse the exact enabled user control; never locate Confirm/submit buttons.
    const code = entry.action === "EXTEND_STAY" ? "ADJUST_DEPARTURE" : entry.action;
    const button = document.querySelector<HTMLButtonElement>(`.order-detail-page [data-order-action="${code}"]`);
    if (!button || button.disabled || button.getClientRects().length === 0) {
      assistant.finishEntry("当前订单已不能执行此操作，请核对页面中的状态和权限提示。"); return;
    }
    assistant.finishEntry(); button.click();
  }, [entry, orderId, ready, blocked, assistant]);
}
