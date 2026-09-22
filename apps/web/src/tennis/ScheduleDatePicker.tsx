import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { isScheduleDate, scheduleMonthDays, scheduleWeekStart, shiftScheduleDate, shiftScheduleMonth } from "./schedule-date-picker";
import "./schedule-date-picker.css";

const weekdays = ["一", "二", "三", "四", "五", "六", "日"];
const monthStart = (date: string) => `${date.slice(0, 7)}-01`;
const monthLabel = (date: string) => `${Number(date.slice(0, 4))} 年 ${Number(date.slice(5, 7))} 月`;
const dateLabel = (date: string) => `${Number(date.slice(0, 4))}年${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;
const tabbableSelector = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

export function ScheduleDatePicker({ value, onChange, today }: {
  value: string;
  onChange: (date: string) => void;
  today: string;
}) {
  const id = useId();
  const anchor = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const focusDay = useRef(false);
  const selected = isScheduleDate(value) ? value : today;
  const [text, setText] = useState(value);
  const [invalid, setInvalid] = useState(false);
  const [open, setOpen] = useState(false);
  const [activeDay, setActiveDay] = useState(selected);
  const [month, setMonth] = useState(monthStart(selected));
  const [position, setPosition] = useState({ left: 4, top: 4 });

  useEffect(() => { setText(value); setInvalid(false); }, [value]);

  function show(moveFocus = false) {
    if (!open) {
      setActiveDay(selected);
      setMonth(monthStart(selected));
    }
    focusDay.current = moveFocus;
    setOpen(true);
    if (open && moveFocus) {
      const button = popup.current?.querySelector<HTMLButtonElement>(`[data-schedule-date="${activeDay}"]`);
      if (button) { focusDay.current = false; button.focus({ preventScroll: true }); }
    }
  }

  function commit(next: string) {
    if (!isScheduleDate(next)) { setInvalid(true); show(); return; }
    setText(next);
    setInvalid(false);
    setOpen(false);
    if (next !== value) onChange(next);
  }

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      if (!anchor.current || !popup.current) return;
      const viewport = window.visualViewport;
      const left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? document.documentElement.clientWidth;
      const height = viewport?.height ?? window.innerHeight;
      popup.current.style.maxWidth = `${Math.max(0, width - 8)}px`;
      popup.current.style.maxHeight = `${Math.max(0, height - 8)}px`;
      const rect = anchor.current.getBoundingClientRect(), panel = popup.current.getBoundingClientRect();
      setPosition({
        left: Math.max(left + 4, Math.min(rect.left, left + width - panel.width - 4)),
        top: Math.max(top + 4, Math.min(rect.bottom + 6, top + height - panel.height - 4)),
      });
    };
    place();
    window.addEventListener("resize", place);
    window.visualViewport?.addEventListener("resize", place);
    return () => {
      window.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("resize", place);
    };
  }, [open, invalid]);

  useLayoutEffect(() => {
    if (!open || !focusDay.current) return;
    const button = popup.current?.querySelector<HTMLButtonElement>(`[data-schedule-date="${activeDay}"]`);
    if (button) { focusDay.current = false; button.focus({ preventScroll: true }); }
  }, [open, activeDay, month]);

  useEffect(() => {
    if (!open) return;
    const inside = (target: EventTarget | null) => target instanceof Node
      && (anchor.current?.contains(target) || popup.current?.contains(target));
    const close = () => { setOpen(false); setText(value); setInvalid(false); };
    const pointer = (event: PointerEvent) => { if (!inside(event.target)) close(); };
    const focus = (event: FocusEvent) => { if (!inside(event.target)) close(); };
    const blur = (event: FocusEvent) => {
      if (inside(event.target) && !event.relatedTarget) queueMicrotask(() => { if (!inside(document.activeElement)) close(); });
    };
    const scroll = (event: Event) => { if (!(event.target instanceof Node) || !popup.current?.contains(event.target)) close(); };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      event.stopPropagation();
      close();
      input.current?.focus({ preventScroll: true });
    };
    document.addEventListener("pointerdown", pointer, true);
    document.addEventListener("focusin", focus, true);
    document.addEventListener("focusout", blur, true);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", pointer, true);
      document.removeEventListener("focusin", focus, true);
      document.removeEventListener("focusout", blur, true);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("keydown", escape, true);
    };
  }, [open, value]);

  function moveMonth(amount: number) {
    focusDay.current = false;
    const next = shiftScheduleMonth(activeDay, amount);
    setActiveDay(next);
    setMonth(monthStart(next));
  }

  function dayKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, day: string) {
    let next: string;
    switch (event.key) {
      case "ArrowLeft": next = shiftScheduleDate(day, -1); break;
      case "ArrowRight": next = shiftScheduleDate(day, 1); break;
      case "ArrowUp": next = shiftScheduleDate(day, -7); break;
      case "ArrowDown": next = shiftScheduleDate(day, 7); break;
      case "Home": next = scheduleWeekStart(day); break;
      case "End": next = shiftScheduleDate(scheduleWeekStart(day), 6); break;
      case "PageUp": next = shiftScheduleMonth(day, -1); break;
      case "PageDown": next = shiftScheduleMonth(day, 1); break;
      default: return;
    }
    event.preventDefault();
    event.stopPropagation();
    focusDay.current = true;
    setActiveDay(next);
    setMonth(monthStart(next));
  }

  function panelTab(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Tab") return;
    const stops = Array.from(popup.current?.querySelectorAll<HTMLElement>(tabbableSelector) ?? []).filter((node) => node.tabIndex >= 0);
    if (event.shiftKey && event.target === stops[0]) {
      event.preventDefault();
      trigger.current?.focus({ preventScroll: true });
    } else if (!event.shiftKey && event.target === stops.at(-1)) {
      const outside = Array.from(document.querySelectorAll<HTMLElement>(tabbableSelector)).filter((node) =>
        node.tabIndex >= 0 && !popup.current?.contains(node) && node.getClientRects().length > 0 && !node.closest("[inert]"));
      const next = outside[outside.indexOf(trigger.current!) + 1];
      if (next) { event.preventDefault(); setOpen(false); next.focus(); }
    }
  }

  const days = scheduleMonthDays(month);
  return <>
    <div ref={anchor} className="tennis-grid-date-picker tennis-schedule-date-control">
      <input ref={input} className="tennis-schedule-date-input" type="text"
        aria-label="排场日期" value={text} placeholder="YYYY-MM-DD" autoComplete="off" spellCheck={false}
        aria-invalid={invalid || undefined} aria-describedby={invalid && open ? `${id}-error` : undefined}
        aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
        title="点击选择日期，也可输入 YYYY-MM-DD" onClick={() => show()}
        onBlur={() => {
          if (!open) { setText(value); setInvalid(false); }
        }}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          setInvalid(next.length >= 10 && !isScheduleDate(next));
          if (isScheduleDate(next)) commit(next);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") { event.preventDefault(); show(true); }
          if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); commit(text); }
        }} />
      <button ref={trigger} type="button" className="tennis-schedule-date-trigger" aria-label="选择排场日期"
        aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => show(true)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") { event.preventDefault(); show(true); }
          if (event.key === "Tab" && !event.shiftKey && open) {
            event.preventDefault();
            popup.current?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus({ preventScroll: true });
          }
        }}><CalendarDays size={15} aria-hidden="true" /></button>
    </div>
    {open && createPortal(<div ref={popup} id={id} role="dialog" aria-label="选择排场日期"
      className="tennis-schedule-calendar" style={position} onKeyDown={panelTab}>
      <div className="tennis-schedule-calendar-heading">
        <button type="button" aria-label="上个月" onClick={() => moveMonth(-1)}
          disabled={monthStart(shiftScheduleMonth(month, -1)) === month}><ChevronLeft size={17} aria-hidden="true" /></button>
        <strong id={`${id}-month`} aria-live="polite">{monthLabel(month)}</strong>
        <button type="button" aria-label="下个月" onClick={() => moveMonth(1)}
          disabled={monthStart(shiftScheduleMonth(month, 1)) === month}><ChevronRight size={17} aria-hidden="true" /></button>
      </div>
      {invalid && <p id={`${id}-error`} role="alert" className="tennis-schedule-calendar-error">请输入有效日期，如 {today}</p>}
      <table role="grid" aria-labelledby={`${id}-month`} className="tennis-schedule-calendar-grid">
        <thead><tr>{weekdays.map((day) => <th key={day} scope="col" aria-label={`星期${day}`}>{day}</th>)}</tr></thead>
        <tbody>{Array.from({ length: 6 }, (_, week) => <tr key={week}>
          {days.slice(week * 7, week * 7 + 7).map((day, column) => <td key={day ?? `empty-${column}`}
            role="gridcell" aria-selected={day === value}>
            {day && <button type="button" data-schedule-date={day} tabIndex={day === activeDay ? 0 : -1}
              className={`tennis-schedule-calendar-day${monthStart(day) !== month ? " is-outside" : ""}${day === value ? " is-selected" : ""}${day === today ? " is-today" : ""}`}
              aria-label={`${dateLabel(day)}，星期${weekdays[column]}${day === today ? "，今天" : ""}${day === value ? "，已选中" : ""}`}
              aria-current={day === today ? "date" : undefined}
              onFocus={() => setActiveDay(day)} onKeyDown={(event) => dayKeyDown(event, day)}
              onClick={() => { commit(day); input.current?.focus({ preventScroll: true }); }}>
              <span>{Number(day.slice(8))}</span>
            </button>}
          </td>)}
        </tr>)}</tbody>
      </table>
    </div>, document.body)}
  </>;
}
