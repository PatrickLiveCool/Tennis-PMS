import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { courtSurfaces, courtEnvironments } from "../../../../packages/domain/src/tennis-court-profile";
import type { CourtRecord } from "./types";
import { money } from "./components";
import { scheduleCourtDetails, scheduleCourtSpecification, type ScheduleCourtDetail } from "./schedule-court-presentation";

export function ScheduleCourt({ court }: { court: CourtRecord }) {
  const environment = court.environment ?? (court.indoor ? "INDOOR" : "OUTDOOR");
  const specification = scheduleCourtSpecification(court.profile?.specification);
  const details = scheduleCourtDetails(court.profile);
  const summary = <>
    <strong className="tennis-court-name">{court.name}</strong>
    {court.hourlyPriceCents !== null && <span className="tennis-court-price">{money(court.hourlyPriceCents)} / 时</span>}
    <span className="tennis-court-tags">
      <span>{environment === "COVERED" ? "有顶棚" : courtEnvironments[environment]}</span>
      {court.surface !== "UNSPECIFIED" && <span>{courtSurfaces[court.surface]}</span>}
      {specification && <span>{specification}</span>}
    </span>
  </>;
  if (!details.length) return <div className="tennis-grid-court">{summary}</div>;
  return <ScheduleCourtWithDetails court={court} details={details}>{summary}</ScheduleCourtWithDetails>;
}

function ScheduleCourtWithDetails({ court, details, children }: {
  court: CourtRecord;
  details: ScheduleCourtDetail[];
  children: ReactNode;
}) {
  const id = useId(), trigger = useRef<HTMLButtonElement>(null), popup = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  function show() { clearTimeout(timer.current); setOpen(true); }
  function hideSoon() { clearTimeout(timer.current); timer.current = setTimeout(() => setOpen(false), 120); }
  useEffect(() => () => clearTimeout(timer.current), []);
  useLayoutEffect(() => {
    if (!open || !trigger.current || !popup.current) return;
    const rect = trigger.current.getBoundingClientRect(), tip = popup.current.getBoundingClientRect();
    const left = rect.right + 8 + tip.width <= innerWidth - 8 ? rect.right + 8 : Math.max(8, rect.left - tip.width - 8);
    setPosition({ left, top: Math.max(8, Math.min(rect.top, innerHeight - tip.height - 8)) });
  }, [open, court]);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const scroll = (event: Event) => { if (!(event.target instanceof Node) || !popup.current?.contains(event.target)) close(); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); } };
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", escape, true);
    return () => { window.removeEventListener("scroll", scroll, true); window.removeEventListener("resize", close); window.removeEventListener("keydown", escape, true); };
  }, [open]);
  return <>
    <button ref={trigger} type="button" className="tennis-grid-court has-details" aria-label={`${court.name} 球场详情`}
      aria-describedby={open ? id : undefined} onMouseEnter={show} onMouseLeave={hideSoon} onFocus={show} onBlur={hideSoon} onClick={show}>
      {children}
    </button>
    {open && createPortal(<div ref={popup} id={id} role="tooltip" className="tennis-court-tooltip" style={position}
      onMouseEnter={show} onMouseLeave={hideSoon}>
      <dl>
        {details.map((detail) => <Fragment key={detail.label}><dt>{detail.label}</dt><dd>{detail.value}</dd></Fragment>)}
      </dl>
    </div>, document.body)}
  </>;
}
