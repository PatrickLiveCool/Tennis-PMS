import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

/** GreenPMS v1.7.2 stable portal: order and assistant remain independently usable. */
export function AssistantDock({ open, onClose, children, messagesRef, readingPosition }: {
  open: boolean; onClose: () => void; children: ReactNode;
  messagesRef: RefObject<HTMLDivElement | null>; readingPosition: RefObject<number>;
}) {
  const [host] = useState(() => document.createElement("div"));
  const [dialog, setDialog] = useState<HTMLDialogElement | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const inspect = () => setDialog([...document.querySelectorAll<HTMLDialogElement>("dialog:modal")].at(-1)
      ?? [...document.querySelectorAll<HTMLDialogElement>("dialog[open]")].at(-1) ?? null);
    const observer = new MutationObserver(inspect);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["open"] });
    inspect(); return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (!open) return;
    document.body.classList.add("assistant-is-open");
    if (dialog) dialog.dataset.assistantOpen = "true";
    return () => { document.body.classList.remove("assistant-is-open"); if (dialog) delete dialog.dataset.assistantOpen; };
  }, [open, dialog]);
  useLayoutEffect(() => {
    host.className = "assistant-portal";
    const focus = host.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
    const list = messagesRef.current;
    const position = list?.isConnected && list.getClientRects().length ? list.scrollTop : readingPosition.current;
    (dialog ?? document.body).appendChild(host);
    if (list?.getClientRects().length) list.scrollTop = position;
    readingPosition.current = position;
    focus?.focus({ preventScroll: true });
  }, [dialog, host]);
  useLayoutEffect(() => () => host.remove(), [host]);
  useLayoutEffect(() => {
    if (open) {
      returnFocus.current = document.activeElement as HTMLElement | null;
      if (messagesRef.current) messagesRef.current.scrollTop = readingPosition.current;
      host.querySelector<HTMLElement>("textarea")?.focus({ preventScroll: true });
    } else if (returnFocus.current?.isConnected) returnFocus.current.focus({ preventScroll: true });
  }, [open]);
  return createPortal(<aside id="ai-assistant-panel" data-testid="ai-assistant-panel" className="assistant-panel tennis-ai-panel"
    hidden={!open} aria-label="AI 助手" onKeyDown={(event) => {
      if (event.key === "Escape" && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); onClose(); }
      if (event.key === "Tab" && dialog?.matches(":modal")) {
        const controls = [...dialog.querySelectorAll<HTMLElement>("button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])")].filter((e) => e.getClientRects().length);
        if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus(); }
        if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus(); }
      }
    }}>{children}</aside>, host);
}
