import { ScheduleCourt } from "./ScheduleCourt";
import { SCHEDULE_COURT_WIDTH } from "./schedule-layout";
import { courtDescription, isCourtReadyForBooking } from "../../../../packages/domain/src/tennis-court-profile";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import type { Schedule, SelectionLine, VenueRecord } from "./types";
import {
  atVenueTime,
  clock,
  dateValue,
  minuteLabel,
  money,
} from "./components";
import { rectangle, type GridPoint } from "./selection";
import { isWithinOpeningHours } from "../../../../packages/domain/src/tennis-pricing";

interface Gesture {
  pointerId: number;
  origin: GridPoint;
  target: GridPoint;
  x: number;
  y: number;
  moved: boolean;
  resize?: { index: number; edge: "start" | "end" };
}
function occupancyDetails(occupancy: Schedule["occupancies"][number]) {
  const state = occupancy.kind === "COURSE" ? "course"
    : occupancy.kind === "MAINTENANCE" ? "maintenance"
      : occupancy.kind === "BOOKING" ? occupancy.status === "HELD" ? "held" : "booked"
        : "blocked";
  const status = state === "course" ? "课程" : state === "maintenance" ? "维护"
    : state === "held" ? "待付款" : state === "booked" ? "已预订" : "占用";
  const customerName = state === "held" || state === "booked" ? occupancy.customerName?.trim() : undefined;
  return { state, status, primary: customerName || status };
}
export function ScheduleGrid({
  schedule,
  venue,
  date,
  ticks,
  lines,
  disabled,
  scrollRef,
  onAdd,
  onRemove,
  onResize,
  openOrder,
  issues,
}: {
  schedule: Schedule;
  venue: VenueRecord;
  date: string;
  ticks: number[];
  lines: SelectionLine[];
  disabled: boolean;
  scrollRef: RefObject<HTMLDivElement | null>;
  onAdd: (lines: SelectionLine[]) => void;
  onRemove: (index: number) => void;
  onResize: (index: number, line: SelectionLine) => void;
  openOrder: (id: string) => void;
  issues: string[];
}) {
  const grid = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const [preview, setPreview] = useState<Gesture | null>(null);
  const suppressClick = useRef(false);
  const callbacks = useRef({ onAdd, onRemove, onResize, lines, disabled });
  callbacks.current = { onAdd, onRemove, onResize, lines, disabled };
  const from = ticks[0] ?? 0;
  const courts = schedule.courts;
  const boundaries = useMemo(
    () =>
      [...ticks, (ticks.at(-1) ?? 0) + 15].map((minute) =>
        atVenueTime(date, minute, venue.timezone),
      ),
    [date, ticks, venue.timezone],
  );
  // Percentages keep overlays aligned with fractional CSS tracks through any resize.
  const slotWidth = (count: number) =>
    `calc((100% - ${SCHEDULE_COURT_WIDTH}px) * ${count / ticks.length})`;
  const slotLeft = (index: number) =>
    `calc(${SCHEDULE_COURT_WIDTH}px + (100% - ${SCHEDULE_COURT_WIDTH}px) * ${index / ticks.length})`;
  function point(x: number, y: number): GridPoint {
    const bounds = grid.current!.getBoundingClientRect();
    return {
      slot: Math.max(
        0,
        Math.min(
          ticks.length - 1,
          Math.floor(
            (x - bounds.left - SCHEDULE_COURT_WIDTH) / ((bounds.width - SCHEDULE_COURT_WIDTH) / ticks.length),
          ),
        ),
      ),
      row: Math.max(
        0,
        Math.min(courts.length - 1, Array.from(grid.current!.querySelectorAll(".tennis-schedule-row")).filter((row) => y >= row.getBoundingClientRect().bottom).length),
      ),
    };
  }
  function line(row: number, first: number, end: number): SelectionLine {
    return {
      courtId: courts[row]!.id,
      startAt:
        boundaries[first] ??
        atVenueTime(date, from + first * 15, venue.timezone),
      endAt:
        boundaries[end] ?? atVenueTime(date, from + end * 15, venue.timezone),
    };
  }
  function projected(g: Gesture): SelectionLine[] {
    if (!courts[g.origin.row] || !courts[g.target.row]) return [];
    if (g.resize) {
      const original = callbacks.current.lines[g.resize.index]!;
      if (!original) return [];
      const boundary = atVenueTime(
        date,
        from + (g.target.slot + (g.resize.edge === "end" ? 1 : 0)) * 15,
        venue.timezone,
      );
      return [
        {
          ...original,
          ...(g.resize.edge === "start"
            ? {
                startAt:
                  boundary < original.endAt
                    ? boundary
                    : atVenueTime(
                        date,
                        minuteOf(original.endAt) - 15,
                        venue.timezone,
                      ),
              }
            : {
                endAt:
                  boundary > original.startAt
                    ? boundary
                    : atVenueTime(
                        date,
                        minuteOf(original.startAt) + 15,
                        venue.timezone,
                      ),
              }),
        },
      ];
    }
    const rect = rectangle(g.origin, g.target);
    return Array.from({ length: rect.lastRow - rect.firstRow + 1 }, (_, i) =>
      line(rect.firstRow + i, rect.firstSlot, rect.lastSlot + 1),
    );
  }
  function minuteOf(iso: string) {
    if (dateValue(new Date(iso), venue.timezone) > date) return 1440;
    if (dateValue(new Date(iso), venue.timezone) < date) return 0;
    const [h, m] = clock(iso, venue.timezone).split(":").map(Number);
    return h! * 60 + m!;
  }
  function start(
    event: ReactPointerEvent,
    origin: GridPoint,
    resize?: Gesture["resize"],
  ) {
    if (event.pointerType === "touch" || event.button !== 0 || disabled) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = {
      pointerId: event.pointerId,
      origin,
      target: origin,
      x: event.clientX,
      y: event.clientY,
      moved: false,
      ...(resize ? { resize } : {}),
    };
    suppressClick.current = false;
  }
  useEffect(() => {
    setPreview(null);
    let frame = 0;
    const move = (event: PointerEvent) => {
      const g = gesture.current;
      if (!g || g.pointerId !== event.pointerId) return;
      g.x = event.clientX;
      g.y = event.clientY;
      const next = point(g.x, g.y);
      g.moved ||= next.row !== g.origin.row || next.slot !== g.origin.slot;
      g.target = next;
      setPreview({ ...g });
    };
    const finish = (event: PointerEvent) => {
      const g = gesture.current;
      if (!g || event.pointerId !== g.pointerId) return;
      gesture.current = null;
      setPreview(null);
      if (callbacks.current.disabled) return;
      if (g.moved || g.resize) {
        suppressClick.current = true;
        const result = projected(g);
        if (!result.length) return;
        if (g.resize) callbacks.current.onResize(g.resize.index, result[0]!);
        else callbacks.current.onAdd(result);
      }
    };
    const cancel = () => {
      if (gesture.current) suppressClick.current = true;
      gesture.current = null;
      setPreview(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        (event.target instanceof Element &&
          event.target.closest("dialog,input,textarea,select"))
      )
        return;
      if (gesture.current) {
        event.preventDefault();
        cancel();
      }
    };
    const autoScroll = () => {
      const g = gesture.current,
        scroll = scrollRef.current;
      if (g && scroll) {
        const bounds = scroll.getBoundingClientRect();
        const headerHeight = scroll.querySelector(".tennis-schedule-header")?.getBoundingClientRect().height ?? 38;
        const dx =
          g.x > bounds.right - 36 ? 12 : g.x < bounds.left + 120 ? -12 : 0;
        const dy =
          g.y > bounds.bottom - 24 ? 9 : g.y < bounds.top + headerHeight + 38 ? -9 : 0;
        if (dx || dy) {
          scroll.scrollLeft += dx;
          scroll.scrollTop += dy;
          g.target = point(g.x, g.y);
          g.moved ||=
            g.target.slot !== g.origin.slot || g.target.row !== g.origin.row;
          setPreview({ ...g });
        }
      }
      frame = requestAnimationFrame(autoScroll);
    };
    frame = requestAnimationFrame(autoScroll);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", escape);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", escape);
      gesture.current = null;
    };
  }, [date, from, ticks.length, courts.map((c) => c.id).join(",")]);
  function click(row: number, slot: number) {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    // Click is one hour by default, clipped to the end of this opening window or the next occupancy.
    const start = from + slot * 15;
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    const window = venue.openingHours.find(
      (w) =>
        w.weekday === weekday && w.startMinute <= start && w.endMinute > start,
    );
    const conflict = schedule.occupancies
      .filter(
        (o) => o.courtId === courts[row]!.id && minuteOf(o.startAt) > start,
      )
      .map((o) => minuteOf(o.startAt));
    const end = Math.min(
      start + Math.max(60, venue.minimumBookingMinutes ?? 15),
      window?.endMinute ?? start + 60,
      ...conflict,
    );
    onAdd([line(row, slot, (end - from) / 15)]);
  }
  const previews =
    preview && (preview.moved || preview.resize) ? projected(preview) : [];
  function blocked(item: SelectionLine) {
    const court = courts.find((c) => c.id === item.courtId);
    const selectedIndex = lines.indexOf(item);
    const unavailable =
      !court?.active ||
      !venue.active ||
      (selectedIndex < 0 && !isCourtReadyForBooking(court)) ||
      Date.parse(item.startAt) <= Date.now() ||
      (Date.parse(item.endAt) - Date.parse(item.startAt)) / 60000 <
        (venue.minimumBookingMinutes ?? 15) ||
      !isWithinOpeningHours(item, venue.timezone, venue.openingHours);
    return (
      unavailable ||
      issues[selectedIndex] ||
      schedule.occupancies.some(
        (o) =>
          o.courtId === item.courtId &&
          o.startAt < item.endAt &&
          o.endAt > item.startAt,
      )
    );
  }
  const rect = preview && rectangle(preview.origin, preview.target);
  return (
    <>
      <div className="tennis-desktop-schedule">
        <div
          ref={grid}
          className="tennis-grid"
          style={{
            display: "block",
            position: "relative",
            width: "100%",
          }}
        >
          {courts.map((court, row) => (
            <div
              className="tennis-schedule-row"
              key={court.id}
              style={{
                gridTemplateColumns: `${SCHEDULE_COURT_WIDTH}px repeat(${ticks.length}, minmax(0, 1fr))`,
              }}
            >
              <ScheduleCourt court={court} />
              {ticks.map((t, slot) => {
                const current = line(row, slot, slot + 1);
                const occupancy = schedule.occupancies.find(
                  (o) =>
                    o.courtId === court.id &&
                    o.startAt < current.endAt &&
                    o.endAt > current.startAt,
                );
                const open =
                  court.active &&
                  venue.active &&
                  isCourtReadyForBooking(court) &&
                  Date.parse(current.startAt) > Date.now() &&
                  venue.openingHours.some(
                    (w) =>
                      w.weekday === new Date(`${date}T12:00:00Z`).getUTCDay() &&
                      w.startMinute <= t &&
                      w.endMinute >= t + 15,
                  );
                const state = occupancy
                  ? occupancyDetails(occupancy).state
                  : open
                    ? "free"
                    : "closed";
                return (
                  <button
                    key={t}
                    className={`tennis-grid-slot is-${state} ${t % 60 === 0 ? "is-hour" : ""}`}
                    aria-label={`${court.name} ${minuteLabel(t)} ${occupancy ? "查看占用" : open ? "添加预订" : "不可售"}`}
                    disabled={
                      !occupancy?.orderId &&
                      (!open || Boolean(occupancy) || disabled)
                    }
                    onPointerDown={(e) => !occupancy && start(e, { row, slot })}
                    onClick={() =>
                      occupancy?.orderId
                        ? openOrder(occupancy.orderId)
                        : click(row, slot)
                    }
                  />
                );
              })}
              {schedule.occupancies
                .filter((o) => o.courtId === court.id)
                .map((o) => {
                  const left = Math.max(from, minuteOf(o.startAt)),
                    end = Math.min(from + ticks.length * 15, minuteOf(o.endAt));
                  if (end <= left) return null;
                  const { state, status, primary } = occupancyDetails(o);
                  const time = `${clock(o.startAt, venue.timezone)}–${clock(o.endAt, venue.timezone)}`;
                  return (
                    <button
                      key={o.id}
                      className={`tennis-schedule-block is-${state}`}
                      style={{
                        left: slotLeft((left - from) / 15),
                        width: slotWidth((end - left) / 15),
                      }}
                      disabled={!o.orderId}
                      onClick={() => o.orderId && openOrder(o.orderId)}
                      title={[primary, primary !== status ? status : "", time].filter(Boolean).join(" · ")}
                    >
                      <strong>{primary}</strong>
                      {primary !== status && <span className="tennis-occupancy-status">{status}</span>}
                      <span className="tennis-occupancy-time">{time}</span>
                    </button>
                  );
                })}
              {lines.map((item, index) => {
                if (
                  item.courtId !== court.id ||
                  dateValue(new Date(item.startAt), venue.timezone) !== date
                )
                  return null;
                const left = (minuteOf(item.startAt) - from) / 15,
                  width = (minuteOf(item.endAt) - minuteOf(item.startAt)) / 15;
                const visibleLeft = Math.max(0, left);
                const visibleEnd = Math.min(ticks.length, left + width);
                if (visibleEnd <= visibleLeft) return null;
                return (
                  <div
                    key={index}
                    className={`tennis-draft-block ${blocked(item) ? "has-conflict" : ""}`}
                    style={{ left: slotLeft(visibleLeft), width: slotWidth(visibleEnd - visibleLeft) }}
                  >
                    <button
                      className="tennis-draft-hit"
                      aria-label={`取消草稿 ${court.name} ${clock(item.startAt, venue.timezone)}`}
                      disabled={disabled}
                      onKeyDown={(event) => {
                        if (event.key !== "Escape" || gesture.current || disabled) return;
                        event.preventDefault();
                        event.stopPropagation();
                        onRemove(index);
                      }}
                      onClick={() => onRemove(index)}
                    >
                      <strong>{blocked(item) ? "冲突" : "已选"} · ×</strong>
                      <span>
                        {clock(item.startAt, venue.timezone)}–
                        {clock(item.endAt, venue.timezone)}
                      </span>
                    </button>
                    {(["start", "end"] as const).map((edge) => (
                      <button
                        key={edge}
                        tabIndex={-1}
                        aria-label={`拖动调整${edge === "start" ? "开始" : "结束"}`}
                        className={`tennis-resize is-${edge}`}
                        disabled={disabled}
                        onClick={(e) => {
                          e.stopPropagation();
                          suppressClick.current = false;
                        }}
                        onPointerDown={(e) =>
                          start(
                            e,
                            {
                              row,
                              slot: edge === "start" ? left : left + width - 1,
                            },
                            { index, edge },
                          )
                        }
                      />
                    ))}
                  </div>
                );
              })}
              {previews
                .filter((p) => p.courtId === court.id)
                .map((p) => (
                  <div
                    key={p.courtId}
                    className={`tennis-drag-preview ${blocked(p) ? "has-conflict" : ""}`}
                    style={{
                      left: slotLeft((minuteOf(p.startAt) - from) / 15),
                      width: slotWidth(
                        (minuteOf(p.endAt) - minuteOf(p.startAt)) / 15,
                      ),
                    }}
                  >
                    {blocked(p)
                      ? "有占用冲突"
                      : `${clock(p.startAt, venue.timezone)}–${clock(p.endAt, venue.timezone)}`}
                  </div>
                ))}
            </div>
          ))}
          {date === dateValue(new Date(), venue.timezone) &&
            minuteOf(new Date().toISOString()) >= from &&
            minuteOf(new Date().toISOString()) < from + ticks.length * 15 && (
              <div
                className="tennis-now-line"
                style={{
                  left: slotLeft(
                    (minuteOf(new Date().toISOString()) - from) / 15,
                  ),
                }}
              >
                <span>现在</span>
              </div>
            )}
        </div>
      </div>
      <div className="tennis-mobile-schedule">
        {courts.map((court, row) => (
          <details key={court.id} open={row === 0}>
            <summary>
              {court.name} · {courtDescription(court)}
              {court.hourlyPriceCents !== null && <> · {money(court.hourlyPriceCents)}/时</>}
            </summary>
            <div className="tennis-mobile-times">
              {ticks
                .filter((t) => t % 60 === 0)
                .map((t) => {
                  const item = line(row, (t - from) / 15, (t - from) / 15 + 4);
                  const occupied = schedule.occupancies.find(
                    (o) =>
                      o.courtId === court.id &&
                      o.startAt < item.endAt &&
                      o.endAt > item.startAt,
                  );
                  const selected = lines.findIndex(
                    (l) =>
                      l.courtId === court.id &&
                      l.startAt < item.endAt &&
                      l.endAt > item.startAt,
                  );
                  const open =
                    court.active &&
                    venue.active &&
                    isCourtReadyForBooking(court) &&
                    Date.parse(item.startAt) > Date.now() &&
                    venue.openingHours.some(
                      (w) =>
                        w.weekday ===
                          new Date(`${date}T12:00:00Z`).getUTCDay() &&
                        w.startMinute <= t &&
                        w.endMinute > t,
                    );
                  const occupancy = occupied ? occupancyDetails(occupied) : undefined;
                  const state = occupancy?.state ?? (open ? "free" : "closed");
                  const selectedConflict = selected >= 0 && Boolean(blocked(lines[selected]!));
                  return (
                    <button
                      key={t}
                      className={`button is-${state}${selected >= 0 ? " is-selected" : ""}${selectedConflict ? " has-conflict" : ""}`}
                      aria-label={`${court.name} ${minuteLabel(t)} ${selected >= 0 ? "取消已选" : occupied ? "查看占用" : open ? "选场" : "不可售"}`}
                      disabled={selected >= 0 ? disabled :
                        !occupied?.orderId &&
                        (disabled || !open || Boolean(occupied))
                      }
                      onClick={() =>
                        selected >= 0
                          ? onRemove(selected)
                          : occupied?.orderId
                            ? openOrder(occupied.orderId)
                            : click(row, (t - from) / 15)
                      }
                    >
                      <span className="tennis-occupancy-time">{minuteLabel(t)}</span>{" "}
                      <span className="tennis-occupancy-status">{selected >= 0
                        ? selectedConflict ? "冲突 · 取消 ×" : "已选 ×"
                        : occupancy
                          ? [occupancy.primary, occupancy.primary !== occupancy.status ? occupancy.status : ""].filter(Boolean).join(" · ")
                          : open
                            ? "选场"
                            : "不可售"}</span>
                    </button>
                  );
                })}
            </div>
          </details>
        ))}
      </div>
      <p className="tennis-drag-status" aria-live="polite">
        {previews.length
          ? `${previews.length} 片 · ${clock(previews[0]!.startAt, venue.timezone)}–${clock(previews[0]!.endAt, venue.timezone)} · 共 ${previews.reduce((n, p) => n + (Date.parse(p.endAt) - Date.parse(p.startAt)) / 60000, 0)} 分钟${rect ? "，松开鼠标完成选区" : ""}`
          : ""}
      </p>
    </>
  );
}
