import { useEffect, useMemo, useRef, useState, useLayoutEffect } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, Plus, Trash2 } from "lucide-react";
import type { TennisApi } from "./api";
import { OccupancyPanel } from "./OccupancyPanel";
import { CustomerPicker } from "./CustomerPicker";
import type { CustomerRecord, OrderRecord, QuoteRecord, Schedule, SelectionLine, Session, VenueRecord } from "./types";
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
  PageHeading,
  Panel,
  pendingCommands,
  RefreshButton,
  useCommand,
  useDraft,
  useLoad,
  writeStored,
} from "./components";

interface BookingDraft {
  date: string;
  customer: CustomerRecord | null;
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
    lines: [],
    quote: null,
    staffHold: false,
    until: "",
    reason: "",
  });
  const [duration, setDuration] = useState(60);
  const [courtId, setCourtId] = useState("");
  const [startMinute, setStartMinute] = useState(18 * 60);
  const [quoteBusy, setQuoteBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [now, setNow] = useState(Date.now());
  const selectionVersion = useRef(0);
  const gridRef = useRef<HTMLDivElement>(null);
  const command = useCommand(scope);
  const schedule = useLoad(
    () => api<Schedule>(`/venues/${venue.id}/schedule?date=${draft.date}`),
    [api, venue.id, draft.date],
  );
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (schedule.data && !schedule.data.courts.some((c) => c.id === courtId))
      setCourtId(schedule.data.courts.find((c) => c.active)?.id ?? "");
  }, [schedule.data, courtId]);
  useLayoutEffect(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(`tennis:grid:${scope}:${draft.date}`) ?? "null") as {
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
  }, [scope, draft.date, schedule.data?.courts.length]);
  const canBook = session.kind === "customer" || permits(session, "book");
  const courts = schedule.data?.courts ?? [];
  const weekday = new Date(`${draft.date}T12:00:00Z`).getUTCDay();
  const windows = venue.openingHours.filter((w) => w.weekday === weekday);
  const fromMinute = windows.length ? Math.floor(Math.min(...windows.map((w) => w.startMinute)) / 60) * 60 : 8 * 60;
  const toMinute = windows.length ? Math.ceil(Math.max(...windows.map((w) => w.endMinute)) / 60) * 60 : 22 * 60;
  const ticks = useMemo(
    () => Array.from({ length: (toMinute - fromMinute) / 15 }, (_, i) => fromMinute + i * 15),
    [fromMinute, toMinute],
  );
  function update(patch: Partial<BookingDraft>) {
    if (patch.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(patch.date)) return;
    selectionVersion.current++;
    setDraft((current) => ({ ...current, ...patch, quote: null }));
    setError(undefined);
  }
  function addLine(id: string, minute: number) {
    try {
      const line = {
        courtId: id,
        startAt: atVenueTime(draft.date, minute, venue.timezone),
        endAt: atVenueTime(draft.date, minute + duration, venue.timezone),
      };
      if (draft.lines.some((l) => l.courtId === id && l.startAt < line.endAt && l.endAt > line.startAt))
        throw new Error("这片球场已在所选明细中，请调整时间或移除原明细。");
      update({ lines: [...draft.lines, line] });
    } catch (next) {
      setError(next);
    }
  }
  function moveDate(days: number) {
    const date = new Date(`${draft.date}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    update({ date: date.toISOString().slice(0, 10) });
  }
  async function quote() {
    if (pendingCommands(scope).some((p) => p.intent.startsWith("quote.confirm:"))) {
      setError(new Error("有一笔预订提交结果待核实，请先查询原操作结果，再建立新报价。"));
      return;
    }
    const requestedVersion = selectionVersion.current;
    setQuoteBusy(true);
    setError(undefined);
    try {
      if (!draft.customer && !session.customerId) throw new Error("请先选择预订人。");
      const result = await api<QuoteRecord>("/quotes", "POST", {
        venueId: venue.id,
        customerId: session.customerId ?? draft.customer?.id,
        lines: draft.lines,
      });
      if (selectionVersion.current === requestedVersion) setDraft((current) => ({ ...current, quote: result }));
    } catch (next) {
      setError(next);
      void schedule.refresh();
    } finally {
      setQuoteBusy(false);
    }
  }
  async function confirm() {
    if (!draft.quote) return;
    try {
      const [holdDate = "", holdTime = ""] = draft.until.split("T");
      const [holdHour = 0, holdMinute = 0] = holdTime.split(":").map(Number);
      const staffHold = draft.staffHold
        ? { until: atVenueTime(holdDate, holdHour * 60 + holdMinute, venue.timezone), reason: draft.reason }
        : undefined;
      const payload = { quoteId: draft.quote.id, ...(staffHold ? { staffHold } : {}) };
      const result = await command.execute(`quote.confirm:${draft.quote.id}`, payload, (key) =>
        api<OrderRecord>(`/quotes/${draft.quote!.id}/confirm`, "POST", {
          commandKey: key,
          ...(staffHold ? { staffHold } : {}),
        }),
      );
      if (result) {
        setDraft((current) => ({ ...current, lines: [], quote: null, staffHold: false, until: "", reason: "" }));
        void schedule.refresh();
        openOrder(result.id);
      }
    } catch (next) {
      setError(next);
    }
  }
  const quoteExpired = draft.quote && Date.parse(draft.quote.expiresAt) <= now;
  const stale = Boolean(schedule.error) || schedule.busy;
  return (
    <>
      <PageHeading title="场地排期" description={`${venue.name} · 按 15 分钟调度，常用预订 1 小时`}>
        <RefreshButton onClick={() => void schedule.refresh()} busy={schedule.busy} />
      </PageHeading>
      <div className="tennis-toolbar">
        <div className="tennis-date-switch">
          <button className="icon-button" aria-label="前一天" onClick={() => moveDate(-1)}>
            <ChevronLeft size={18} />
          </button>
          <label>
            <span className="sr-only">排场日期</span>
            <input type="date" value={draft.date} onChange={(e) => update({ date: e.target.value })} />
          </label>
          <button className="icon-button" aria-label="后一天" onClick={() => moveDate(1)}>
            <ChevronRight size={18} />
          </button>
          <button
            className="button button-secondary"
            onClick={() => update({ date: dateValue(new Date(), venue.timezone) })}
          >
            今天
          </button>
        </div>
        <div className="tennis-legend">
          <span className="is-free">可预订</span>
          <span className="is-held">待付款</span>
          <span className="is-booked">已预订</span>
          <span className="is-course">课程 / 维护</span>
        </div>
      </div>
      <ErrorNotice error={schedule.error} retry={() => void schedule.refresh()} />
      <div className="tennis-booking-layout">
        <section className="tennis-panel tennis-schedule-panel">
          <div className="panel-heading">
            <h2>当日排场</h2>
            <span>
              {courts.length} 片球场 · {venue.timezone}
            </span>
          </div>
          {!schedule.data && schedule.busy ? (
            <LoadingBlock />
          ) : courts.length === 0 ? (
            <EmptyState title="还没有球场" detail="请先在场地与定价中添加球场、营业时间和小时价格。" />
          ) : (
            <>
              <div
                ref={gridRef}
                onScroll={(event) =>
                  writeStored(`tennis:grid:${scope}:${draft.date}`, {
                    left: event.currentTarget.scrollLeft,
                    top: event.currentTarget.scrollTop,
                  })
                }
                className="tennis-grid-scroll"
                aria-label="排场表，横向滚动查看全部时段"
              >
                <div className="tennis-grid" style={{ gridTemplateColumns: `104px repeat(${ticks.length}, 26px)` }}>
                  <div className="tennis-grid-corner">球场 / 时间</div>
                  {ticks.map((t) => (
                    <div key={t} className={`tennis-grid-time ${t % 60 === 0 ? "is-hour" : ""}`}>
                      {t % 60 === 0 ? minuteLabel(t) : ""}
                    </div>
                  ))}
                  {courts.map((court) => (
                    <div className="tennis-grid-row" key={court.id}>
                      <div className="tennis-grid-court">
                        <strong>{court.name}</strong>
                        <span>
                          {court.indoor ? "室内" : "室外"} · {money(court.hourlyPriceCents)}/时
                        </span>
                      </div>
                      {ticks.map((t) => {
                        const start = atVenueTime(draft.date, t, venue.timezone),
                          end = atVenueTime(draft.date, t + 15, venue.timezone);
                        const occupied = schedule.data?.occupancies.find(
                          (o) => o.courtId === court.id && o.startAt < end && o.endAt > start,
                        );
                        const selected = draft.lines.some(
                          (l) => l.courtId === court.id && l.startAt < end && l.endAt > start,
                        );
                        const open =
                          court.active &&
                          court.hourlyPriceCents !== null &&
                          windows.some((w) => w.startMinute <= t && w.endMinute >= t + 15) &&
                          Date.parse(start) > now;
                        const first = occupied && (occupied.startAt >= start || t === fromMinute);
                        const state = occupied
                          ? occupied.kind !== "BOOKING"
                            ? "blocked"
                            : occupied.status === "HELD"
                              ? "held"
                              : "booked"
                          : selected
                            ? "selected"
                            : !open
                              ? "closed"
                              : "free";
                        return (
                          <button
                            key={t}
                            type="button"
                            className={`tennis-grid-slot is-${state} ${t % 60 === 0 ? "is-hour" : ""}`}
                            disabled={Boolean(
                              !occupied?.orderId &&
                                (Boolean(occupied) || !open || !canBook || stale || command.busy || draft.quote),
                            )}
                            title={`${court.name} ${minuteLabel(t)} · ${occupied ? `${occupied.customerName ?? ""} ${occupied.kind === "BOOKING" ? "已占用" : occupied.kind === "COURSE" ? "课程占场" : "维护停场"}` : selected ? "已选" : open ? "点击选择" : "不可售"}`}
                            aria-label={`${court.name} ${minuteLabel(t)} ${occupied ? "查看占用" : selected ? "已选" : open ? "添加预订" : "不可售"}`}
                            onClick={() => (occupied?.orderId ? openOrder(occupied.orderId) : addLine(court.id, t))}
                          >
                            {first ? (
                              <span>
                                {occupied.customerName ??
                                  (occupied.kind === "COURSE"
                                    ? "课程"
                                    : occupied.kind === "MAINTENANCE"
                                      ? "维护"
                                      : "预订")}
                              </span>
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </div>
              <p className="tennis-muted tennis-grid-help">
                点击空白格选择 {duration} 分钟；点击已有预订查看详情。同一订单可添加多片或不同时段。
              </p>
            </>
          )}
        </section>
        <aside className="tennis-booking-side">
          <Panel title="新建预订">
            <ErrorNotice error={error ?? command.error} />
            {stale && schedule.data && (
              <p className="tennis-note">排场正在刷新或读取失败，已保留输入；获取最新状态后再提交。</p>
            )}
            {session.kind !== "customer" && (
              <CustomerPicker
                venueId={venue.id}
                api={api}
                value={
                  draft.customer && !permits(session, "manage_members")
                    ? { ...draft.customer, phone: null }
                    : draft.customer
                }
                onChange={(customer) => update({ customer })}
                disabled={Boolean(draft.quote) || command.busy}
                canCreate={permits(session, "manage_members")}
              />
            )}
            {!draft.quote && (
              <>
                <div className="tennis-form tennis-add-line">
                  <label>
                    球场
                    <select value={courtId} onChange={(e) => setCourtId(e.target.value)} disabled={!canBook}>
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
                      <select value={startMinute} onChange={(e) => setStartMinute(Number(e.target.value))}>
                        {ticks.map((t) => (
                          <option key={t} value={t}>
                            {minuteLabel(t)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      预订时长
                      <select value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
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
                    disabled={!courtId || !canBook || command.busy}
                    onClick={() => addLine(courtId, startMinute)}
                  >
                    <Plus size={16} />
                    添加时段
                  </button>
                </div>
                <p className="tennis-muted">
                  最短可售 {venue.minimumBookingMinutes ?? "未设置"} 分钟。增加明细可预订其他时间，空档不会占用。
                </p>
              </>
            )}
            <div className="tennis-selection-list">
              {draft.lines.length ? (
                draft.lines.map((line, i) => (
                  <div key={`${line.courtId}:${line.startAt}`} className="tennis-selection">
                    <CalendarDays size={17} aria-hidden="true" />
                    <div>
                      <strong>{courts.find((c) => c.id === line.courtId)?.name ?? "球场"}</strong>
                      <span>
                        {dateTime(line.startAt, venue.timezone)}–{clock(line.endAt, venue.timezone)}
                      </span>
                    </div>
                    {!draft.quote && (
                      <button
                        className="icon-button"
                        aria-label={`移除第 ${i + 1} 条时段`}
                        onClick={() => update({ lines: draft.lines.filter((_, index) => index !== i) })}
                      >
                        <Trash2 size={15} />
                      </button>
                    )}
                  </div>
                ))
              ) : (
                <div className="tennis-selection-empty">从排场表点击空场，或在上方添加时段。</div>
              )}
            </div>
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
                          {clock(segment.startAt, venue.timezone)}–{clock(segment.endAt, venue.timezone)} ·{" "}
                          {money(segment.hourlyPriceCents)}/小时
                          {segment.discountBps < 10000 ? ` × ${segment.discountBps / 1000}折` : ""} ={" "}
                          {money(segment.amountCents)}
                        </p>
                      ))}
                    </div>
                  ))}
                  <div className="tennis-money-row tennis-total">
                    <span>整单应付</span>
                    <strong>{money(draft.quote.price.totalCents)}</strong>
                  </div>
                </div>
                <p className={`tennis-note ${quoteExpired ? "is-warning" : ""}`}>
                  {quoteExpired
                    ? "报价已过期，请重新获取。"
                    : `报价保留至 ${clock(draft.quote.expiresAt, venue.timezone)}；确认后锁场待付款 10 分钟。`}
                </p>
                {permits(session, "hold_unpaid") && (
                  <details className="tennis-advanced">
                    <summary>保留未付款预约</summary>
                    <label className="tennis-check">
                      <input
                        type="checkbox"
                        checked={draft.staffHold}
                        onChange={(e) => setDraft((current) => ({ ...current, staffHold: e.target.checked }))}
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
                            onChange={(e) => setDraft((current) => ({ ...current, until: e.target.value }))}
                          />
                        </label>
                        <label>
                          保留原因
                          <textarea
                            value={draft.reason}
                            onChange={(e) => setDraft((current) => ({ ...current, reason: e.target.value }))}
                            maxLength={2000}
                          />
                        </label>
                        <p className="tennis-muted">保留预约仍为未付款，不会登记收款。</p>
                      </div>
                    )}
                  </details>
                )}
                <div className="tennis-actions">
                  <button className="button button-secondary" onClick={() => update({})} disabled={command.busy}>
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
                      stale ||
                      (draft.staffHold && (!draft.until || !draft.reason.trim()))
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
                  quoteBusy || stale || !canBook || !draft.lines.length || (!draft.customer && !session.customerId)
                }
              >
                {quoteBusy ? "正在核对场地与价格…" : "核对场地与报价"}
              </button>
            )}
          </Panel>
        </aside>
      </div>
      <OccupancyPanel
        session={session}
        api={api}
        venue={venue}
        courts={courts}
        date={draft.date}
        onChanged={() => void schedule.refresh()}
      />
    </>
  );
}
