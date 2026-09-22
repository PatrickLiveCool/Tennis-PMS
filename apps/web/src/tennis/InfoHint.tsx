import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Info } from "lucide-react";

/** Optional help only. Errors and action consequences belong beside the action. */
export function InfoHint({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const pinned = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  function show() { clearTimeout(timer.current); setOpen(true); }
  function close() { clearTimeout(timer.current); pinned.current = false; setOpen(false); }
  function leave() {
    clearTimeout(timer.current);
    if (!pinned.current) timer.current = setTimeout(() => {
      if (!trigger.current?.matches(":focus-visible")) setOpen(false);
    }, 150);
  }
  useEffect(() => () => clearTimeout(timer.current), []);
  useLayoutEffect(() => {
    if (!open || !trigger.current || !popup.current) return;
    const anchor = trigger.current.getBoundingClientRect();
    const tip = popup.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - tip.width - 8));
    const below = anchor.bottom + 8;
    const top = below + tip.height <= window.innerHeight - 8 ? below : Math.max(8, anchor.top - tip.height - 8);
    setPosition({ left, top });
  }, [open, children]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !trigger.current?.contains(event.target) && !popup.current?.contains(event.target)) close();
    };
    const scroll = (event: Event) => {
      if (!(event.target instanceof Node) || !popup.current?.contains(event.target)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
    };
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", escape, true);
    return () => {
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", escape, true);
    };
  }, [open]);
  return <span className="tennis-info-hint">
    <button ref={trigger} type="button" className="tennis-info-trigger" data-ui-help="true" aria-label={label}
      aria-expanded={open} aria-describedby={open ? id : undefined}
      onPointerEnter={(event) => { if (event.pointerType !== "touch") show(); }} onPointerLeave={leave}
      onFocus={(event) => { if (event.currentTarget.matches(":focus-visible")) show(); }}
      onBlur={(event) => { if (event.relatedTarget && !popup.current?.contains(event.relatedTarget)) close(); }}
      onClick={() => { if (pinned.current) close(); else { pinned.current = true; show(); } }}>
      <Info size={16} aria-hidden="true" />
    </button>
    {open && createPortal(<div ref={popup} id={id} role="tooltip" className="tennis-info-popup" style={position}
      onPointerEnter={show} onPointerLeave={leave}>{children}</div>, trigger.current?.closest("dialog") ?? document.body)}
  </span>;
}
