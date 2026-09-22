import { SCHEDULE_COURT_WIDTH } from "./schedule-layout";
import { matchesCourtFilter } from "../../../../packages/domain/src/tennis-court-profile";
import { useLayoutEffect, useState, type ReactNode, type RefObject } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { ScheduleGrid } from "./ScheduleGrid";
import {
  dateValue,
  LoadingBlock,
  minuteLabel,
  useDraft,
  writeStored,
} from "./components";
import type { Schedule, SelectionLine } from "./types";

export function ScheduleBoard({
  dates,
  days,
  ticks,
  filter,
  lines,
  disabled,
  scrollRef,
  storageKey,
  onAdd,
  onRemove,
  onResize,
  openOrder,
  issues,
  timezone,
  dateNavigation,
  emptyState,
}: {
  dates: string[];
  days: Record<string, Schedule>;
  ticks: number[];
  filter: string;
  lines: SelectionLine[];
  disabled: boolean;
  scrollRef: RefObject<HTMLDivElement | null>;
  storageKey: string;
  onAdd: (lines: SelectionLine[]) => void;
  onRemove: (index: number) => void;
  onResize: (index: number, line: SelectionLine) => void;
  openOrder: (id: string) => void;
  issues: string[];
  timezone: string;
  dateNavigation: ReactNode;
  emptyState?: ReactNode;
}) {
  const [collapsed, setCollapsed] = useDraft<string[]>(
    `${storageKey}:collapsed`,
    [],
  );
  const today = dateValue(new Date(), timezone);
  const [boardWidth, setBoardWidth] = useState(0);
  useLayoutEffect(() => {
    const board = scrollRef.current;
    if (!board) return;
    const measure = () => setBoardWidth(board.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(board);
    return () => observer.disconnect();
  }, [scrollRef]);
  // Keep complete clock labels readable on narrow boards and long operating days.
  const labelEvery = Math.max(
    1,
    Math.ceil(((ticks.length / 4) * 40) / Math.max(1, boardWidth - SCHEDULE_COURT_WIDTH)),
  );
  return (
    <div
      ref={scrollRef}
      className="tennis-grid-scroll tennis-board"
      aria-label="排场表，滚动查看日期与时段"
      onScroll={(e) => {
        if (emptyState) return;
        writeStored(storageKey, {
          left: e.currentTarget.scrollLeft,
          top: e.currentTarget.scrollTop,
        });
      }}
    >
      <div
        className="tennis-schedule-header"
        style={{
          gridTemplateColumns: `${SCHEDULE_COURT_WIDTH}px repeat(${ticks.length}, minmax(0, 1fr))`,
          width: "100%",
        }}
      >
        <div className="tennis-grid-corner">{dateNavigation}</div>
        {ticks.map(
          (t, index) =>
            index % (4 * labelEvery) === 0 && (
              <div
                key={t}
                className="tennis-grid-time is-hour"
                data-slot-start={index}
                style={{
                  gridColumn: `span ${Math.min(4 * labelEvery, ticks.length - index)}`,
                }}
              >
                {((ticks.length - index) / ticks.length) * (boardWidth - SCHEDULE_COURT_WIDTH) >=
                34 ? (
                  <span>{minuteLabel(t)}</span>
                ) : (
                  ""
                )}
              </div>
            ),
        )}
      </div>
      {emptyState ?? dates.map((date) => {
        const schedule = days[date];
        const courts =
          schedule?.courts.filter(
            (c) =>
              c.active && matchesCourtFilter(c, filter),
          ) ?? [];
        const weekday = new Intl.DateTimeFormat("zh-CN", {
          weekday: "short",
          timeZone: "UTC",
        }).format(new Date(`${date}T12:00:00Z`));
        const caption = `${Number(date.slice(5, 7))}月${Number(date.slice(8))}日 · ${weekday}`;
        const selected = lines.filter(
          (line) => dateValue(new Date(line.startAt), timezone) === date,
        ).length;
        return (
          <section
            key={date}
            data-schedule-date={date}
            aria-label={`${date} 排场`}
            className="tennis-day-group"
          >
            <h2 className="tennis-day-heading">
              <button
                type="button"
                aria-expanded={!collapsed.includes(date)}
                aria-label={`${collapsed.includes(date) ? "展开" : "折叠"} ${date}`}
                onClick={() =>
                  setCollapsed((old) =>
                    old.includes(date)
                      ? old.filter((item) => item !== date)
                      : [...old, date],
                  )
                }
              >
                <span>
                  {collapsed.includes(date) ? (
                    <ChevronRight size={14} />
                  ) : (
                    <ChevronDown size={14} />
                  )}
                  {caption}
                  {date === today && <em>今天</em>}
                  {selected > 0 && <small>已选 {selected} 条</small>}
                </span>
              </button>
            </h2>
            {!collapsed.includes(date) &&
              (schedule ? (
                <ScheduleGrid
                  schedule={{ ...schedule, courts }}
                  venue={schedule.venue}
                  date={date}
                  ticks={ticks}
                  lines={lines}
                  disabled={disabled}
                  scrollRef={scrollRef}
                  onAdd={onAdd}
                  onRemove={onRemove}
                  onResize={onResize}
                  openOrder={openOrder}
                  issues={issues}
                />
              ) : (
                <LoadingBlock />
              ))}
          </section>
        );
      })}
    </div>
  );
}
