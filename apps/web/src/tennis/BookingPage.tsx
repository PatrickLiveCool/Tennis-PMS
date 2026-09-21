import type { BackofficeAction } from "../../../../packages/db/src/tennis/backoffice-assistant";
import { useEffect, useMemo, useRef, useState, useLayoutEffect } from "react";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Plus,
  Trash2,
  RefreshCw,
  HelpCircle,
} from "lucide-react";
import type { TennisApi } from "./api";
import { isWithinOpeningHours } from "../../../../packages/domain/src/tennis-pricing";
import { OccupancyPanel } from "./OccupancyPanel";
import { BookingCustomer, type GuestDraft } from "./BookingCustomer";
import { ScheduleBoard } from "./ScheduleBoard";
import { shiftDate, useScheduleRange } from "./useScheduleRange";
import { appendSelection } from "./selection";
import type {
  CustomerRecord,
  OrderRecord,
  QuoteRecord,
  SelectionLine,
  Session,
  VenueRecord,
} from "./types";
import { permits } from "./types";
import {
  atVenueTime,
  clock,
  dateTime,
  dateValue,
  EmptyState,
  ErrorNotice,
  LoadingBlock,
  minuteLabel,
  money,
  Panel,
  pendingCommands,
  forgetCommand,
  readStored,
  writeStored,
  useCommand,
  useDraft,
} from "./components";

interface BookingDraft {
  date: string;
  customer: CustomerRecord | null;
  guest?: GuestDraft;
  lines: SelectionLine[];
  quote: QuoteRecord | null;
  staffHold: boolean;
  until: string;
  reason: string;
}
export function BookingPage({
  api,
  session,
  venue,
  scope,
  openOrder,
}: {
  api: TennisApi;
  session: Session;
  venue: VenueRecord;
  scope: string;
  openOrder: (id: string) => void;
}) {
  const [draft, setDraft] = useDraft<BookingDraft>(`tennis:booking:${scope}`, {
    date: dateValue(new Date(), venue.timezone),
    customer: null,
    guest: { nickname: "", phone: "" },
    lines: [],
    quote: null,
    staffHold: false,
    until: "",
    reason: "",
  });
  const [sideOpen, setSideOpen] = useState(draft.lines.length > 0);
  const [filter, setFilter] = useDraft(`tennis:court-filter:${scope}`, "all");
  const [manualOpen, setManualOpen] = useState(false);
  const [manualDate, setManualDate] = useState(draft.date);
  const [savedDays, setViewDays] = useDraft(`tennis:view-days:${scope}`, 3);
  const viewDays = [1, 3, 7].includes(savedDays) ? savedDays : 3;
  const visibleDates = useMemo(
    () => Array.from({ length: viewDays }, (_, i) => shiftDate(draft.date, i)),
    [draft.date, viewDays],
  );
  const gridStorageKey = `tennis:grid:${scope}:${draft.date}:${viewDays}`;
  const guest = draft.guest ?? { nickname: "", phone: "" };
  const [duration, setDuration] = useState(60);
  const [courtId, setCourtId] = useState("");
  const [startMinute, setStartMinute] = useState(18 * 60);
  const [quoteBusy, setQuoteBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [now, setNow] = useState(Date.now());
  const selectionVersion = useRef(0);
  const gridRef = useRef<HTMLDivElement>(null);
  const command = useCommand(scope);
  useEffect(() => {
    const recover = (event: Event) => {
      const detail = (
        event as CustomEvent<{ scope: string; customer: CustomerRecord }>
      ).detail;
      if (detail.scope === scope) update({ customer: detail.customer });
    };
    window.addEventListener("tennis-booking-customer-recovered", recover);
    return () =>
      window.removeEventListener("tennis-booking-customer-recovered", recover);
  }, [scope]);
  const selectionDates = [
    ...new Set(
      draft.lines.flatMap((line) => [
        dateValue(new Date(line.startAt), venue.timezone),
        dateValue(new Date(Date.parse(line.endAt) - 1), venue.timezone),
      ]),
    ),
  ]
    .sort()
    .join(",");
  const requiredDates = [
    ...new Set([...visibleDates, ...selectionDates.split(",").filter(Boolean)]),
  ];
  const range = useScheduleRange(api, venue.id, requiredDates);
  const schedule = { ...range, data: range.days[draft.date] };
  const selectedSchedules = useMemo(
    () => Object.values(range.days),
    [range.days],
  );
  const stale =
    Boolean(range.error) ||
    requiredDates.some((date) => !range.days[date]) ||
    now - range.updatedAt > 60_000;
  const selectionIssues = useMemo(() => {
    if (!selectedSchedules.length) return draft.lines.map(() => "");
    return draft.lines.map((line) => {
      const snapshot =
        range.days[dateValue(new Date(line.startAt), venue.timezone)];
      if (!snapshot) return "";
      const court = snapshot.courts.find((item) => item.id === line.courtId);
      if (!court || !court.active || !snapshot?.venue.active)
        return "球场或场馆已停用，请移除此时段或更换球场。";
      if (court.hourlyPriceCents === null)
        return "球场尚未配置价格，请先核对价目。";
      if (Date.parse(line.startAt) <= now) return "开始时间已到，请调整时段。";
      if (
        selectedSchedules.some((item) =>
          item.occupancies.some(
            (occupancy) =>
              occupancy.courtId === line.courtId &&
              occupancy.startAt < line.endAt &&
              occupancy.endAt > line.startAt,
          ),
        )
      )
        return "该时段已被占用，请移除后重新选择空场。";
      try {
        if (
          !isWithinOpeningHours(
            line,
            snapshot.venue.timezone,
            snapshot.venue.openingHours,
          )
        )
          return "该时段超出当前营业时间，请调整。";
      } catch {
        return "该时段不能出售，请重新选择。";
      }
      if (
        snapshot.venue.minimumBookingMinutes !== null &&
        (Date.parse(line.endAt) - Date.parse(line.startAt)) / 60_000 <
          snapshot.venue.minimumBookingMinutes
      )
        return "该时长低于当前最短可售时长，请调整。";
      return "";
    });
  }, [selectedSchedules, range.days, draft.lines, now, venue.timezone]);
  const issuesKey = selectionIssues.join("|");
  const hasSelectionIssues = selectionIssues.some(Boolean);
  const pendingConfirmation = pendingCommands(scope).some((item) =>
    item.intent.startsWith("quote.confirm:"),
  );
  useEffect(() => {
    if (!hasSelectionIssues || pendingConfirmation) return;
    selectionVersion.current++;
    if (draft.quote) setDraft((current) => ({ ...current, quote: null }));
  }, [issuesKey, draft.quote?.id, pendingConfirmation]);
  useEffect(() => {
    const timer = setInterval(
      () => setNow(Date.now()),
      draft.quote ? 1000 : 15_000,
    );
    return () => clearInterval(timer);
  }, [draft.quote?.id]);
  useEffect(() => {
    if (schedule.data && !schedule.data.courts.some((c) => c.id === courtId))
      setCourtId(schedule.data.courts.find((c) => c.active)?.id ?? "");
  }, [schedule.data, courtId]);
  useLayoutEffect(() => {
    try {
      const saved = JSON.parse(
        sessionStorage.getItem(gridStorageKey) ?? "null",
      ) as {
        left: number;
        top: number;
      } | null;
      if (saved && gridRef.current) {
        gridRef.current.scrollLeft = saved.left;
        gridRef.current.scrollTop = saved.top;
      }
    } catch {
      /* position is optional */
    }
  }, [gridStorageKey, schedule.data?.courts.length]);
  const canBook = session.kind === "customer" || permits(session, "book");
  const courts = schedule.data?.courts ?? [];
  const visibleCourts = courts.filter(
    (c) => filter === "all" || (filter === "clay" ? c.surface === "CLAY" : filter === "indoor" ? c.indoor : !c.indoor),
  );
  const windows = venue.openingHours.filter((w) =>
    visibleDates.some(
      (date) => w.weekday === new Date(`${date}T12:00:00Z`).getUTCDay(),
    ),
  );
  const fromMinute = windows.length
    ? Math.floor(Math.min(...windows.map((w) => w.startMinute)) / 60) * 60
    : 8 * 60;
  const toMinute = windows.length
    ? Math.ceil(Math.max(...windows.map((w) => w.endMinute)) / 60) * 60
    : 22 * 60;
  const ticks = useMemo(
    () =>
      Array.from(
        { length: (toMinute - fromMinute) / 15 },
        (_, i) => fromMinute + i * 15,
      ),
    [fromMinute, toMinute],
  );
  function update(patch: Partial<BookingDraft>) {
    if (patch.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(patch.date))
      return;
    selectionVersion.current++;
    setDraft((current) => ({ ...current, ...patch, quote: null }));
    setError(undefined);
  }
  function navigate(date: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    setDraft((current) => ({ ...current, date }));
    setManualDate(date);
  }
  function addLines(lines: SelectionLine[]) {
    try {
      update({ lines: appendSelection(draft.lines, lines) });
      if (lines[0])
        setManualDate(dateValue(new Date(lines[0].startAt), venue.timezone));
      setSideOpen(true);
    } catch (next) {
      setError(next);
      setSideOpen(true);
    }
  }
  function resizeLine(index: number, line: SelectionLine) {
    try {
      appendSelection(
        draft.lines.filter((_, i) => i !== index),
        [line],
      );
      update({
        lines: draft.lines.map((old, i) => (i === index ? line : old)),
      });
    } catch (next) {
      setError(next);
    }
  }
  function addLine(id: string, minute: number) {
    try {
      const line = {
        courtId: id,
        startAt: atVenueTime(manualDate, minute, venue.timezone),
        endAt: atVenueTime(manualDate, minute + duration, venue.timezone),
      };
      if (
        draft.lines.some(
          (l) =>
            l.courtId === id &&
            l.startAt < line.endAt &&
            l.endAt > line.startAt,
        )
      )
        throw new Error("这片球场已在所选明细中，请调整时间或移除原明细。");
      addLines([line]);
    } catch (next) {
      setError(next);
    }
  }
  function moveDate(days: number) {
    navigate(shiftDate(draft.date, days));
  }
  const pendingNow = useRef(false);
  function goNow() {
    pendingNow.current = true;
    navigate(dateValue(new Date(), venue.timezone));
  }
  useLayoutEffect(() => {
    if (!pendingNow.current || !schedule.data || !gridRef.current) return;
    gridRef.current.scrollLeft = 0;
    gridRef.current.scrollTop = 0;
    pendingNow.current = false;
  });
  useEffect(() => {
    const apply = (event?: Event) => {
      if (event && (event as CustomEvent<{ scope: string }>).detail.scope !== scope) return;
      const entry = readStored<BackofficeAction | null>(`tennis:assistant-preparation:${scope}`, null);
      if (entry?.preparation?.kind !== "booking" || !entry.preparation.lines?.length) return;
      if (!canBook || command.busy || pendingConfirmation) { setError(new Error("请先处理当前操作，再带入助手准备的时段。")); return; }
      const lines = entry.preparation.lines;
      try {
        const additions = lines.filter((line) => !draft.lines.some((old) => old.courtId === line.courtId && old.startAt === line.startAt && old.endAt === line.endAt));
        const combined = appendSelection(draft.lines, additions);
        update({ lines: combined, date: dateValue(new Date(lines[0]!.startAt), venue.timezone) });
        setSideOpen(true);
        writeStored(`tennis:assistant-preparation:${scope}`, null);
      } catch (next) { setError(next); writeStored(`tennis:assistant-preparation:${scope}`, null); }
    };
    apply();
    window.addEventListener("tennis-assistant-preparation", apply);
    return () => window.removeEventListener("tennis-assistant-preparation", apply);
  }, [scope, draft.lines, canBook, command.busy, pendingConfirmation]);
  async function quote() {
    if (hasSelectionIssues || stale) return;
    if (
      pendingCommands(scope).some((p) => p.intent.startsWith("quote.confirm:"))
    ) {
      setError(
        new Error(
          "有一笔预订提交结果待核实，请先查询原操作结果，再建立新报价。",
        ),
      );
      return;
    }
    const requestedVersion = selectionVersion.current;
    setQuoteBusy(true);
    setError(undefined);
    try {
      let customer = draft.customer;
      if (!customer && !session.customerId) {
        if (!guest.nickname.trim())
          throw new Error("请填写预订人称呼，或选择已有客户。");
        const payload = { nickname: guest.nickname, phone: guest.phone };
        const pending = pendingCommands(scope).find(
          (p) => p.intent === "booking.customer",
        );
        // Read the original result before retrying a write whose outcome is unknown.
        const receipt = pending
          ? await api<{ result: { customer: CustomerRecord } } | null>(
              `/receipts/${encodeURIComponent(pending.key)}`,
            )
          : null;
        const registered =
          receipt?.result ??
          (await command.execute("booking.customer", payload, (key) =>
            api<{ customer: CustomerRecord }>(
              `/venues/${venue.id}/booking-customers`,
              "POST",
              {
                ...payload,
                commandKey: key,
              },
            ),
          ));
        if (!registered) return;
        customer = registered.customer;
        setDraft((current) => ({ ...current, customer }));
        if (pending && receipt) forgetCommand(scope, pending.key);
      }
      const result = await api<QuoteRecord>("/quotes", "POST", {
        venueId: venue.id,
        customerId: session.customerId ?? customer?.id,
        lines: draft.lines,
      });
      if (selectionVersion.current === requestedVersion)
        setDraft((current) => ({ ...current, quote: result }));
    } catch (next) {
      setError(next);
      void schedule.refresh(true);
    } finally {
      setQuoteBusy(false);
    }
  }
  async function confirm() {
    if (!draft.quote || hasSelectionIssues || stale) return;
    try {
      const [holdDate = "", holdTime = ""] = draft.until.split("T");
      const [holdHour = 0, holdMinute = 0] = holdTime.split(":").map(Number);
      const staffHold = draft.staffHold
        ? {
            until: atVenueTime(
              holdDate,
              holdHour * 60 + holdMinute,
              venue.timezone,
            ),
            reason: draft.reason,
          }
        : undefined;
      const payload = {
        quoteId: draft.quote.id,
        ...(staffHold ? { staffHold } : {}),
      };
      const result = await command.execute(
        `quote.confirm:${draft.quote.id}`,
        payload,
        (key) =>
          api<OrderRecord>(`/quotes/${draft.quote!.id}/confirm`, "POST", {
            commandKey: key,
            ...(staffHold ? { staffHold } : {}),
          }),
      );
      if (result) {
        setDraft((current) => ({
          ...current,
          lines: [],
          quote: null,
          staffHold: false,
          until: "",
          reason: "",
        }));
        setSideOpen(false);
        void schedule.refresh(true);
        openOrder(result.id);
      } else void schedule.refresh(true);
    } catch (next) {
      setError(next);
      void schedule.refresh(true);
    }
  }
  const quoteExpired = draft.quote && Date.parse(draft.quote.expiresAt) <= now;
  return (
    <>
      <h1 className="sr-only" tabIndex={-1}>
        场地排期
      </h1>
      <div className="tennis-schedule-toolbar">
        <div className="tennis-date-switch">
          <button
            className="icon-button"
            aria-label={`向前 ${viewDays} 天`}
            title={`向前 ${viewDays} 天`}
            onClick={() => moveDate(-viewDays)}
          >
            <ChevronLeft size={17} />
          </button>
          <label>
            <span className="sr-only">排场日期</span>
            <input
              type="date"
              value={draft.date}
              onChange={(e) => navigate(e.target.value)}
            />
          </label>
          <button
            className="icon-button"
            aria-label={`向后 ${viewDays} 天`}
            title={`向后 ${viewDays} 天`}
            onClick={() => moveDate(viewDays)}
          >
            <ChevronRight size={17} />
          </button>
          <button
            className="button button-secondary"
            onClick={() => navigate(dateValue(new Date(), venue.timezone))}
          >
            今天
          </button>
          <button className="button button-secondary" onClick={goNow}>
            现在
          </button>
        </div>
        <div className="tennis-schedule-controls">
          <div
            className="tennis-view-switch"
            role="group"
            aria-label="显示天数"
          >
            {[1, 3, 7].map((days) => (
              <button
                key={days}
                type="button"
                aria-pressed={viewDays === days}
                onClick={() => setViewDays(days)}
              >
                {days}天
              </button>
            ))}
          </div>
          <label className="tennis-court-filter">
            <span className="sr-only">筛选球场</span>
            <select
              aria-label="筛选球场"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            >
              <option value="all">全部球场</option>
              <option value="indoor">室内球场</option>
              <option value="outdoor">室外球场</option>
              <option value="clay">红土场</option>
            </select>
          </label>
          <button
            className="icon-button"
            aria-label="刷新排场"
            title="刷新排场"
            onClick={() => void schedule.refresh(true)}
          >
            <RefreshCw size={16} />
          </button>
          <button
            className="button button-primary"
            disabled={!canBook}
            onClick={() => {
              setSideOpen(true);
              setManualOpen(true);
            }}
          >
            <Plus size={16} />
            预订
          </button>
        </div>
      </div>
      <div className="tennis-schedule-meta">
        <span>
          {visibleCourts.length} 片球场 ·{" "}
          {
            new Set(
              visibleDates.flatMap(
                (date) =>
                  range.days[date]?.occupancies
                    .filter((o) => o.status === "HELD")
                    .map((o) => o.orderId) ?? [],
              ),
            ).size
          }{" "}
          笔待付款
          <span
            className={`tennis-sync-status ${range.error ? "is-error" : ""}`}
            role="status"
          >
            {range.error
              ? "更新失败"
              : !range.updatedAt
                ? "正在读取"
                : stale
                  ? "待更新"
                  : "已同步"}
          </span>
        </span>
        <div className="tennis-legend">
          <span className="is-free">可预订</span>
          <span className="is-held">待付款</span>
          <span className="is-booked">已预订</span>
          <span className="is-course">课程 / 维护</span>
          <details className="tennis-schedule-help">
            <summary aria-label="排场操作帮助" title="排场操作帮助">
              <HelpCircle size={14} />
            </summary>
            <p>
              点击空场选 1
              小时，拖动可选同日多片。点击已选块取消，拖边缘调整，Esc
              放弃拖动。跨日请分别选择，草稿不会占场。
            </p>
          </details>
        </div>
      </div>
      <ErrorNotice
        error={range.error}
        retry={() => void schedule.refresh(true)}
      />
      {hasSelectionIssues && (
        <p className="tennis-note is-warning" role="status">
          {pendingConfirmation
            ? "原预订提交结果尚待核实，请先查询原操作。"
            : "已选时段需要调整，原报价已失效。"}
          预订人和明细已保留，请按下方提示核对。
        </p>
      )}
      <div className={`tennis-booking-layout ${sideOpen ? "has-draft" : ""}`}>
        <section className="tennis-panel tennis-schedule-panel">
          {!schedule.data && schedule.busy ? (
            <LoadingBlock />
          ) : !schedule.data ? (
            <EmptyState
              title="排场暂时不可用"
              detail="请重新读取当前场馆排期。"
            />
          ) : courts.length === 0 ? (
            <EmptyState
              title="还没有球场"
              detail="请先在场地与定价中添加球场、营业时间和小时价格。"
            />
          ) : (
            <>
              <ScheduleBoard
                dates={visibleDates}
                days={range.days}
                ticks={ticks}
                filter={filter}
                lines={draft.lines}
                disabled={!canBook || command.busy || pendingConfirmation}
                scrollRef={gridRef}
                storageKey={gridStorageKey}
                timezone={venue.timezone}
                onAdd={addLines}
                onRemove={(index) =>
                  update({ lines: draft.lines.filter((_, i) => i !== index) })
                }
                onResize={resizeLine}
                openOrder={openOrder}
                issues={selectionIssues}
              />
            </>
          )}
        </section>
        {sideOpen && (
          <aside className="tennis-booking-side" aria-label="预订草稿">
            <Panel
              title="新建预订"
              action={
                <button
                  className="button button-secondary button-small"
                  onClick={() => setSideOpen(false)}
                >
                  收起
                </button>
              }
            >
              <ErrorNotice error={error ?? command.error} />
              {stale && schedule.data && (
                <p className="tennis-note">
                  排场状态待更新，已保留输入；更新成功后可继续提交。
                </p>
              )}
              {session.kind !== "customer" && (
                <BookingCustomer
                  api={api}
                  venueId={venue.id}
                  customer={draft.customer}
                  guest={guest}
                  onCustomer={(customer) => update({ customer })}
                  onGuest={(guest) => update({ guest })}
                  disabled={
                    command.busy ||
                    quoteBusy ||
                    pendingConfirmation ||
                    pendingCommands(scope).some(
                      (p) => p.intent === "booking.customer",
                    )
                  }
                />
              )}
              {!draft.quote && (
                <>
                  <details
                    className="tennis-manual-selection"
                    open={manualOpen}
                    onToggle={(e) => setManualOpen(e.currentTarget.open)}
                  >
                    <summary>添加时段</summary>
                    <div className="tennis-form tennis-add-line">
                      <label>
                        预订日期
                        <input
                          type="date"
                          value={manualDate}
                          onChange={(e) => setManualDate(e.target.value)}
                        />
                      </label>
                      <label>
                        球场
                        <select
                          value={courtId}
                          onChange={(e) => setCourtId(e.target.value)}
                          disabled={!canBook}
                        >
                          {courts
                            .filter((c) => c.active)
                            .map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                        </select>
                      </label>
                      <div className="tennis-two">
                        <label>
                          开始时间
                          <select
                            value={startMinute}
                            onChange={(e) =>
                              setStartMinute(Number(e.target.value))
                            }
                          >
                            {ticks.map((t) => (
                              <option key={t} value={t}>
                                {minuteLabel(t)}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          预订时长
                          <select
                            value={duration}
                            onChange={(e) =>
                              setDuration(Number(e.target.value))
                            }
                          >
                            {[15, 30, 45, 60, 90, 120, 180, 240].map((m) => (
                              <option key={m} value={m}>
                                {m === 60 ? "1 小时（常用）" : `${m} 分钟`}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                      <button
                        type="button"
                        className="button button-secondary"
                        disabled={
                          !courtId || !manualDate || !canBook || command.busy
                        }
                        onClick={() => addLine(courtId, startMinute)}
                      >
                        <Plus size={16} />
                        添加时段
                      </button>
                    </div>
                    <p className="tennis-muted">
                      最短可售 {venue.minimumBookingMinutes ?? "未设置"}{" "}
                      分钟。增加明细可预订其他时间，空档不会占用。
                    </p>
                  </details>
                </>
              )}
              <div className="tennis-selection-list">
                {draft.lines.length ? (
                  draft.lines.map((line, i) => (
                    <div
                      key={`${line.courtId}:${line.startAt}`}
                      className="tennis-selection"
                    >
                      <CalendarDays size={17} aria-hidden="true" />
                      <div>
                        <strong>
                          {courts.find((c) => c.id === line.courtId)?.name ??
                            "球场"}
                        </strong>
                        <span>
                          {dateTime(line.startAt, venue.timezone)}–
                          {clock(line.endAt, venue.timezone)}
                        </span>
                        {selectionIssues[i] && (
                          <span className="tennis-note is-warning">
                            {selectionIssues[i]}
                          </span>
                        )}
                      </div>
                      {!command.busy && !pendingConfirmation && (
                        <button
                          className="icon-button"
                          aria-label={`移除第 ${i + 1} 条时段`}
                          onClick={() =>
                            update({
                              lines: draft.lines.filter(
                                (_, index) => index !== i,
                              ),
                            })
                          }
                        >
                          <Trash2 size={15} />
                        </button>
                      )}
                    </div>
                  ))
                ) : (
                  <div className="tennis-selection-empty">
                    从排场表点击或框选，也可展开按时间添加。
                  </div>
                )}
              </div>
              {draft.lines.length > 0 && (
                <div className="tennis-selection-summary">
                  <strong>
                    {draft.lines.length} 条时段 ·{" "}
                    {new Set(draft.lines.map((l) => l.courtId)).size} 片 · 共{" "}
                    {draft.lines.reduce(
                      (n, l) =>
                        n +
                        (Date.parse(l.endAt) - Date.parse(l.startAt)) / 60000,
                      0,
                    )}{" "}
                    分钟
                  </strong>
                  <button
                    className="button button-secondary button-small"
                    disabled={command.busy || pendingConfirmation}
                    onClick={() => update({ lines: [] })}
                  >
                    清空全部
                  </button>
                </div>
              )}
              {draft.quote ? (
                <>
                  <div className="tennis-quote-summary">
                    {draft.quote.price.lines.map((line, i) => (
                      <div key={`${line.courtId}:${line.startAt}`}>
                        <div className="tennis-money-row">
                          <span>明细 {i + 1}</span>
                          <strong>{money(line.totalCents)}</strong>
                        </div>
                        {line.segments.map((segment, index) => (
                          <p className="tennis-muted" key={index}>
                            {clock(segment.startAt, venue.timezone)}–
                            {clock(segment.endAt, venue.timezone)} ·{" "}
                            {money(segment.hourlyPriceCents)}/小时
                            {segment.discountBps < 10000
                              ? ` × ${segment.discountBps / 1000}折`
                              : ""}{" "}
                            = {money(segment.amountCents)}
                          </p>
                        ))}
                      </div>
                    ))}
                    <div className="tennis-money-row tennis-total">
                      <span>整单应付</span>
                      <strong>{money(draft.quote.price.totalCents)}</strong>
                    </div>
                  </div>
                  <p
                    className={`tennis-note ${quoteExpired ? "is-warning" : ""}`}
                  >
                    {quoteExpired
                      ? "报价已过期，请重新获取。"
                      : `报价保留至 ${clock(draft.quote.expiresAt, venue.timezone)}；确认后锁场待付款 ${draft.quote.paymentHoldMinutes ?? 10} 分钟。`}
                  </p>
                  {permits(session, "hold_unpaid") && (
                    <details className="tennis-advanced">
                      <summary>保留未付款预约</summary>
                      <label className="tennis-check">
                        <input
                          type="checkbox"
                          checked={draft.staffHold}
                          onChange={(e) =>
                            setDraft((current) => ({
                              ...current,
                              staffHold: e.target.checked,
                            }))
                          }
                        />
                        指定付款截止时间
                      </label>
                      {draft.staffHold && (
                        <div className="tennis-form">
                          <label>
                            付款截止（场馆时间）
                            <input
                              type="datetime-local"
                              value={draft.until}
                              onChange={(e) =>
                                setDraft((current) => ({
                                  ...current,
                                  until: e.target.value,
                                }))
                              }
                            />
                          </label>
                          <label>
                            保留原因
                            <textarea
                              value={draft.reason}
                              onChange={(e) =>
                                setDraft((current) => ({
                                  ...current,
                                  reason: e.target.value,
                                }))
                              }
                              maxLength={2000}
                            />
                          </label>
                          <p className="tennis-muted">
                            保留预约仍为未付款，不会登记收款。
                          </p>
                        </div>
                      )}
                    </details>
                  )}
                  <div className="tennis-actions">
                    <button
                      className="button button-secondary"
                      onClick={() => update({})}
                      disabled={command.busy}
                    >
                      返回修改
                    </button>
                    <button
                      className="button button-primary"
                      onClick={() => void confirm()}
                      disabled={
                        !canBook ||
                        (draft.staffHold && !permits(session, "hold_unpaid")) ||
                        command.busy ||
                        Boolean(quoteExpired) ||
                        hasSelectionIssues ||
                        stale ||
                        (draft.staffHold &&
                          (!draft.until || !draft.reason.trim()))
                      }
                    >
                      {command.busy ? "正在确认…" : "确认预订"}
                    </button>
                  </div>
                </>
              ) : (
                <button
                  className="button button-primary tennis-full"
                  type="button"
                  onClick={() => void quote()}
                  disabled={
                    quoteBusy ||
                    command.busy ||
                    stale ||
                    hasSelectionIssues ||
                    !canBook ||
                    !draft.lines.length ||
                    (!draft.customer &&
                      !session.customerId &&
                      !guest.nickname.trim())
                  }
                >
                  {quoteBusy ? "正在核对场地与价格…" : "核对场地与报价"}
                </button>
              )}
            </Panel>
          </aside>
        )}
      </div>
      {!sideOpen && draft.lines.length > 0 && (
        <button
          className="button button-primary tennis-resume-draft"
          onClick={() => setSideOpen(true)}
        >
          继续预订 · {draft.lines.length} 条时段
        </button>
      )}
      <details className="tennis-occupancy-tools">
        <summary>课程与维护占场管理</summary>
        <OccupancyPanel
          session={session}
          api={api}
          venue={venue}
          courts={courts}
          date={draft.date}
          onChanged={() => void schedule.refresh(true)}
        />
      </details>
    </>
  );
}
