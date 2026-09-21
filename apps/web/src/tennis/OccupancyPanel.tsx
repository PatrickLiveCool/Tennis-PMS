import { useRef, useState } from "react";
import { CalendarClock, Plus, Wrench } from "lucide-react";
import { TennisApiError, type TennisApi } from "./api";
import {
  atVenueTime,
  Badge,
  clock,
  dateTime,
  dateValue,
  EmptyState,
  ErrorNotice,
  LoadingBlock,
  Modal,
  Panel,
  RefreshButton,
  useDraft,
  useLoad,
  writeStored,
} from "./components";
import { permits, type CourtRecord, type Session, type VenueRecord } from "./types";

type OccupancyKind = "COURSE" | "MAINTENANCE";
interface Occupancy {
  id: string;
  courtId: string;
  startAt: string;
  endAt: string;
  kind: string;
  revision?: number;
  sourceId?: string | null;
  orderId?: string | null;
  amendmentId?: string | null;
}
interface OccupancySchedule {
  occupancies: Occupancy[];
}
interface OccupancyDraft {
  action: "create" | "reschedule" | "release";
  id: string;
  kind: OccupancyKind;
  sourceId: string;
  courtId: string;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  original?: Occupancy;
  pending?: { startAt: string; endAt: string; courtId: string; sourceId: string; kind: OccupancyKind };
}
export interface OccupancyPanelProps {
  session: Session;
  api: TennisApi;
  venue: VenueRecord;
  courts: CourtRecord[];
  date: string;
  onChanged: () => void;
}
function timeMinutes(value: string): number {
  if (!/^\d{2}:\d{2}$/.test(value)) throw new Error("请输入完整的开始与结束时间。");
  const [hour, minute] = value.split(":").map(Number);
  if (hour! > 23 || minute! > 59 || minute! % 15 !== 0) throw new Error("请选择整点、15 分、30 分或 45 分。");
  return hour! * 60 + minute!;
}
function editable(row: Occupancy): boolean {
  return (
    ["COURSE", "MAINTENANCE"].includes(row.kind) &&
    !row.orderId &&
    !row.amendmentId &&
    Number.isInteger(row.revision) &&
    row.revision! > 0
  );
}
function occupancyError(error: unknown): unknown {
  if (!(error instanceof TennisApiError)) return error;
  if (error.code === "STALE_OCCUPANCY") return new Error("这条占场已更新或释放，请刷新排场后核对。");
  if (error.code === "ORDER_MANAGED_OCCUPANCY") return new Error("这条占用属于预订或改期，请从订单详情办理。");
  if (error.code === "DUPLICATE_OCCUPANCY") return new Error("这条占场已登记，请先查询原登记结果。");
  return error;
}
export function OccupancyPanel(props: OccupancyPanelProps) {
  if (props.session.kind !== "staff") return null;
  return (
    <StaffOccupancyPanel
      key={`${props.session.subjectId}:${props.session.tenantId}:${props.venue.id}:${props.date}`}
      {...props}
    />
  );
}
function StaffOccupancyPanel({ session, api, venue, courts, date, onChanged }: OccupancyPanelProps) {
  const storageKey = `tennis:occupancy:${session.subjectId}:${session.kind}:${session.tenantId}:${venue.id}:${date}`;
  const [draft, setDraft] = useDraft<OccupancyDraft | null>(storageKey, null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [notice, setNotice] = useState("");
  const running = useRef(false);
  const schedule = useLoad(
    () => api<OccupancySchedule>(`/venues/${encodeURIComponent(venue.id)}/schedule?date=${encodeURIComponent(date)}`),
    [api, venue.id, date],
  );
  const canCourse = permits(session, "book"),
    canMaintain = permits(session, "manage_assets");
  const rows = (schedule.data?.occupancies ?? []).filter(
    (row) => ["COURSE", "MAINTENANCE"].includes(row.kind) && !row.orderId && !row.amendmentId,
  );
  const canOperate = (kind: string) => (kind === "MAINTENANCE" ? canMaintain : kind === "COURSE" && canCourse);
  const saveDraft = (value: OccupancyDraft | null) => {
    writeStored(storageKey, value);
    setDraft(value);
  };
  function update(patch: Partial<OccupancyDraft>) {
    if (draft && !draft.pending) {
      saveDraft({ ...draft, ...patch });
      setError(undefined);
    }
  }
  function start(kind: OccupancyKind) {
    if (draft) {
      setOpen(true);
      return;
    }
    saveDraft({
      action: "create",
      id: crypto.randomUUID(),
      kind,
      sourceId: "",
      courtId: courts.find((c) => c.active)?.id ?? courts[0]?.id ?? "",
      startDate: date,
      startTime: "18:00",
      endDate: date,
      endTime: "19:00",
    });
    setError(undefined);
    setNotice("");
    setOpen(true);
  }
  function edit(row: Occupancy, action: "reschedule" | "release") {
    if (draft) {
      setOpen(true);
      return;
    }
    saveDraft({
      action,
      id: row.id,
      kind: row.kind as OccupancyKind,
      sourceId: row.sourceId ?? "",
      courtId: row.courtId,
      startDate: dateValue(new Date(row.startAt), venue.timezone),
      startTime: clock(row.startAt, venue.timezone),
      endDate: dateValue(new Date(row.endAt), venue.timezone),
      endTime: clock(row.endAt, venue.timezone),
      original: row,
    });
    setError(undefined);
    setNotice("");
    setOpen(true);
  }
  async function completed(message: string) {
    saveDraft(null);
    setOpen(false);
    setError(undefined);
    setNotice(message);
    await schedule.refresh();
    onChanged();
  }
  /** Read the original ID before deciding whether a timed-out operation can be retried. */
  async function recover(value: OccupancyDraft): Promise<"completed" | "retry" | "unknown"> {
    if (!value.pending) return "unknown";
    const dates = [
      ...new Set([
        value.startDate,
        value.original ? dateValue(new Date(value.original.startAt), venue.timezone) : value.startDate,
      ]),
    ];
    const snapshots = await Promise.all(
      dates.map((day) =>
        api<OccupancySchedule>(`/venues/${encodeURIComponent(venue.id)}/schedule?date=${encodeURIComponent(day)}`),
      ),
    );
    const row = snapshots.flatMap((snapshot) => snapshot.occupancies).find((item) => item.id === value.id);
    const wanted = value.pending;
    if (value.action === "release") {
      if (!row) {
        await completed("原日期已无这条占场，排场已刷新。若其他人员调整过日期，可到对应日期核对。");
        return "completed";
      }
      if (row.revision !== value.original?.revision) {
        await completed("这条占场已被更新，本次没有再次释放。请核对最新记录后办理。");
        return "completed";
      }
      setNotice("原占场仍在，尚未确认释放。可重试原操作，或暂存后再核对。");
      return "retry";
    }
    if (
      row &&
      row.courtId === wanted.courtId &&
      Date.parse(row.startAt) === Date.parse(wanted.startAt) &&
      Date.parse(row.endAt) === Date.parse(wanted.endAt) &&
      row.kind === wanted.kind &&
      (value.action !== "create" || row.sourceId === wanted.sourceId)
    ) {
      await completed(
        value.action === "create" ? "已查到原占场登记，未重复创建。" : "已查到目标场地和时段，改期结果已恢复。",
      );
      return "completed";
    }
    if (row && (value.action === "create" || row.revision !== value.original?.revision)) {
      await completed("原记录已有其他更新，未覆盖最新排场。请从列表重新核对。");
      return "completed";
    }
    if (value.action === "reschedule" && !row) {
      setNotice("未在原日期或目标日期找到这条占场。已保留输入，请核对其他日期的排场后再处理。");
      return "unknown";
    }
    setNotice("尚未查到原操作完成，可以使用原记录编号重试；不会另建一条占场。");
    return "retry";
  }
  async function send(value: OccupancyDraft) {
    if (!value.pending) return;
    let confirmed = false;
    if (value.action === "create")
      confirmed =
        (await api<{ id?: string } | null>("/occupancies", "POST", { id: value.id, ...value.pending }))?.id ===
        value.id;
    else if (value.action === "reschedule")
      confirmed =
        (
          await api<{ ok?: boolean } | null>(`/occupancies/${encodeURIComponent(value.id)}`, "PATCH", {
            expectedRevision: value.original!.revision,
            courtId: value.pending.courtId,
            startAt: value.pending.startAt,
            endAt: value.pending.endAt,
          })
        )?.ok === true;
    else
      confirmed =
        (
          await api<{ ok?: boolean } | null>(`/occupancies/${encodeURIComponent(value.id)}/release`, "POST", {
            expectedRevision: value.original!.revision,
          })
        )?.ok === true;
    if (!confirmed) throw new Error("尚未收到明确的办理结果，已保留输入，请先查询原操作。");
    await completed(
      value.action === "create"
        ? "占场已登记，可售排场已更新。"
        : value.action === "reschedule"
          ? "占场已调整，原时段已释放。"
          : "占场已释放，可售排场已更新。",
    );
  }
  async function submit() {
    if (!draft || running.current || !canOperate(draft.kind)) return;
    running.current = true;
    setBusy(true);
    setError(undefined);
    setNotice("");
    let submitted = draft;
    try {
      if (draft.pending) {
        if ((await recover(draft)) === "retry") await send(draft);
        return;
      }
      const startAt = atVenueTime(draft.startDate, timeMinutes(draft.startTime), venue.timezone),
        endAt = atVenueTime(draft.endDate, timeMinutes(draft.endTime), venue.timezone);
      if (Date.parse(endAt) <= Date.parse(startAt)) throw new Error("结束时间必须晚于开始时间。");
      if (!draft.courtId || !courts.some((c) => c.id === draft.courtId)) throw new Error("请选择当前场馆的一片球场。");
      if (draft.action === "create" && !draft.sourceId.trim())
        throw new Error("请填写课程名称或维护事项，方便工作人员识别。");
      submitted = {
        ...draft,
        pending: { startAt, endAt, courtId: draft.courtId, sourceId: draft.sourceId.trim(), kind: draft.kind },
      };
      saveDraft(submitted);
      await send(submitted);
    } catch (next) {
      if (
        submitted.pending &&
        next instanceof TennisApiError &&
        ["STALE_OCCUPANCY", "DUPLICATE_OCCUPANCY"].includes(next.code)
      ) {
        try {
          await recover(submitted);
        } catch (recoveryError) {
          setError(recoveryError);
        }
      } else {
        if (submitted.pending && next instanceof TennisApiError && !next.uncertain) {
          const { pending: _pending, ...editableDraft } = submitted;
          saveDraft(editableDraft);
        }
        setError(occupancyError(next));
      }
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  async function checkResult() {
    if (!draft?.pending || running.current) return;
    running.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await recover(draft);
    } catch (next) {
      setError(next);
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  const waiting = Boolean(draft?.pending);
  const selectableCourts = courts.filter((c) => c.active || draft?.kind === "MAINTENANCE" || c.id === draft?.courtId);
  return (
    <Panel
      title="课程与维护占场"
      action={
        <div className="tennis-actions">
          <RefreshButton onClick={() => void schedule.refresh()} busy={schedule.busy || busy} />
          {draft ? (
            <button type="button" className="button button-secondary" onClick={() => setOpen(true)}>
              {waiting ? "核对上次操作" : "继续编辑"}
            </button>
          ) : (
            <>
              {canCourse && (
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={!courts.some((c) => c.active)}
                  onClick={() => start("COURSE")}
                >
                  <CalendarClock size={16} aria-hidden="true" />
                  课程占场
                </button>
              )}
              {canMaintain && (
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={!courts.length}
                  onClick={() => start("MAINTENANCE")}
                >
                  <Wrench size={16} aria-hidden="true" />
                  维护停场
                </button>
              )}
            </>
          )}
        </div>
      }
    >
      <ErrorNotice error={schedule.error} retry={() => void schedule.refresh()} />
      {notice && (
        <p className="tennis-note" role="status">
          {notice}
        </p>
      )}
      {waiting && !open && (
        <p className="tennis-note">上次操作的结果待核对，输入和记录编号已保留。请先查询，再继续办理。</p>
      )}
      {!schedule.data && schedule.busy ? (
        <LoadingBlock />
      ) : !rows.length ? (
        <EmptyState title="当日没有课程或维护占场" detail="登记课程使用或维护时间后，相应场地会从可售空档中扣除。" />
      ) : (
        <div className="tennis-table-scroll">
          <table className="tennis-table">
            <thead>
              <tr>
                <th>事项</th>
                <th>球场</th>
                <th>时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <Badge value={row.kind} />
                    <small>{row.sourceId ?? "占场记录"}</small>
                  </td>
                  <td>{courts.find((c) => c.id === row.courtId)?.name ?? "球场"}</td>
                  <td>
                    {dateTime(row.startAt, venue.timezone)}
                    <br />至 {dateTime(row.endAt, venue.timezone)}
                  </td>
                  <td>
                    {canOperate(row.kind) && editable(row) ? (
                      <div className="tennis-actions">
                        <button
                          type="button"
                          className="button button-secondary button-small"
                          disabled={busy || schedule.busy || Boolean(schedule.error) || Boolean(draft)}
                          onClick={() => edit(row, "reschedule")}
                        >
                          调整时段
                        </button>
                        <button
                          type="button"
                          className="button button-secondary button-small"
                          disabled={busy || schedule.busy || Boolean(schedule.error) || Boolean(draft)}
                          onClick={() => edit(row, "release")}
                        >
                          释放占场
                        </button>
                      </div>
                    ) : (
                      <span className="tennis-muted">仅查看</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="tennis-muted">每次登记一段场地使用时间，支持 15 分钟间隔。课程排课与维护不会登记客户付款。</p>
      {open && draft && (
        <Modal
          title={
            draft.action === "release"
              ? "释放占场"
              : draft.action === "reschedule"
                ? "调整占场时段"
                : draft.kind === "COURSE"
                  ? "登记课程占场"
                  : "登记维护停场"
          }
          onClose={() => setOpen(false)}
          closeDisabled={busy}
        >
          <form
            className="tennis-form"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <ErrorNotice error={error} />
            {notice && (
              <p className="tennis-note" role="status">
                {notice}
              </p>
            )}
            {draft.action === "release" ? (
              <>
                <p>确认释放「{draft.sourceId || "这条占场"}」？</p>
                <p>
                  {courts.find((c) => c.id === draft.courtId)?.name} ·{" "}
                  {dateTime(draft.original?.startAt, venue.timezone)} 至{" "}
                  {dateTime(draft.original?.endAt, venue.timezone)}
                </p>
                <p className="tennis-muted">释放后，原时段可重新用于预订。</p>
              </>
            ) : (
              <>
                <label>
                  {draft.kind === "COURSE" ? "课程名称 / 排课标识" : "维护事项"}
                  <input
                    required
                    maxLength={200}
                    value={draft.sourceId}
                    disabled={busy || waiting || draft.action !== "create"}
                    placeholder={draft.kind === "COURSE" ? "例如：周末成人小班" : "例如：更换球网"}
                    onChange={(event) => update({ sourceId: event.target.value })}
                  />
                </label>
                <label>
                  球场
                  <select
                    required
                    value={draft.courtId}
                    disabled={busy || waiting}
                    onChange={(event) => update({ courtId: event.target.value })}
                  >
                    {!draft.courtId && <option value="">请选择球场</option>}
                    {selectableCourts.map((court) => (
                      <option key={court.id} value={court.id}>
                        {court.name}
                        {!court.active ? "（已停用）" : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="tennis-two">
                  <label>
                    开始日期
                    <input
                      required
                      type="date"
                      value={draft.startDate}
                      disabled={busy || waiting}
                      onChange={(event) => update({ startDate: event.target.value })}
                    />
                  </label>
                  <label>
                    开始时间
                    <input
                      required
                      type="time"
                      step={900}
                      value={draft.startTime}
                      disabled={busy || waiting}
                      onChange={(event) => update({ startTime: event.target.value })}
                    />
                  </label>
                </div>
                <div className="tennis-two">
                  <label>
                    结束日期
                    <input
                      required
                      type="date"
                      value={draft.endDate}
                      disabled={busy || waiting}
                      onChange={(event) => update({ endDate: event.target.value })}
                    />
                  </label>
                  <label>
                    结束时间
                    <input
                      required
                      type="time"
                      step={900}
                      value={draft.endTime}
                      disabled={busy || waiting}
                      onChange={(event) => update({ endTime: event.target.value })}
                    />
                  </label>
                </div>
                <p className="tennis-muted">时间使用场馆时区 {venue.timezone}。改期发生冲突时，原占场会保留。</p>
              </>
            )}
            {waiting && <p className="tennis-note">正在核对上次提交，期间保留原输入。先查询结果，再按原编号重试。</p>}
            {!canOperate(draft.kind) && <p className="tennis-note">当前账号没有办理这类占场的权限，已保留原输入。</p>}
            <div className="tennis-actions">
              <button type="button" className="button button-secondary" disabled={busy} onClick={() => setOpen(false)}>
                暂存并关闭
              </button>
              {waiting ? (
                <>
                  <button
                    type="button"
                    className="button button-secondary"
                    disabled={busy}
                    onClick={() => void checkResult()}
                  >
                    查询结果
                  </button>
                  <button
                    type="button"
                    className="button button-secondary"
                    disabled={busy}
                    onClick={() => {
                      saveDraft(null);
                      setOpen(false);
                      setError(undefined);
                      setNotice("已结束本次人工核对，请以最新排场为准。");
                      void schedule.refresh();
                      onChanged();
                    }}
                  >
                    已人工核对，结束本次操作
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={busy}
                  onClick={() => {
                    saveDraft(null);
                    setOpen(false);
                    setError(undefined);
                  }}
                >
                  放弃编辑
                </button>
              )}
              <button type="submit" className="button button-primary" disabled={busy || !canOperate(draft.kind)}>
                {busy ? (
                  "正在处理…"
                ) : waiting ? (
                  "核对并重试原操作"
                ) : draft.action === "release" ? (
                  "确认释放"
                ) : draft.action === "reschedule" ? (
                  "确认调整"
                ) : (
                  <>
                    <Plus size={16} aria-hidden="true" />
                    确认登记
                  </>
                )}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </Panel>
  );
}
