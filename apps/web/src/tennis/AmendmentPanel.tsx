import { useEffect, useRef, useState } from "react";
import type { AmendmentRecord } from "../../../../packages/db/src/tennis/amendments";
import type { TennisApi } from "./api";
import type { CourtRecord, OrderDetail, OrderRecord, Session, VenueRecord } from "./types";
import { permits } from "./types";
import {
  atVenueTime,
  cents,
  clock,
  dateTime,
  dateValue,
  ErrorNotice,
  LoadingBlock,
  money,
  Panel,
  useCommand,
  useDraft,
  useLoad,
} from "./components";
import { PaymentForm } from "./OrdersPage";

const statusLabels = {
  QUOTED: "待确认方案",
  AWAITING_PAYMENT: "等待补款",
  APPLIED: "已改期",
  CANCELLED: "已取消改期",
  EXPIRED: "改期已到期",
};
export function AmendmentPanel({
  api,
  session,
  venue,
  scope,
  order,
  courts,
  onChanged,
  initiallyEditing = false,
}: {
  api: TennisApi;
  session: Session;
  venue: VenueRecord;
  scope: string;
  order: OrderDetail;
  courts: CourtRecord[];
  onChanged: () => void;
  initiallyEditing?: boolean;
}) {
  const amendments = useLoad(
    () => api<AmendmentRecord[]>(`/orders/${order.id}/amendments`),
    [api, order.id, order.revision],
  );
  const [editing, setEditing] = useState(initiallyEditing);
  const [cancellingUnpaid, setCancellingUnpaid] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const command = useCommand(scope);
  const current = amendments.data?.find((item) => item.id === selected);
  const pending = amendments.data?.find((item) => item.status === "AWAITING_PAYMENT");
  const canEdit = permits(session, "book");
  const canPay = session.kind === "customer" || canEdit;
  const unpaid = order.status === "HELD" && order.paymentStatus === "UNPAID";
  const paymentUnresolved =
    order.payments?.some((item) => ["PENDING", "REFUND_REQUIRED"].includes(item.status)) ?? false;
  const canAmend = canEdit && (order.status === "CONFIRMED" || unpaid) && !pending && !paymentUnresolved;
  async function changed() {
    await amendments.refresh();
    onChanged();
  }
  async function cancel(item: AmendmentRecord) {
    const reason = "员工取消本次改期方案，保留原预约";
    const result = await command.execute(`amendment.cancel:${item.id}`, { reason }, (key) =>
      api<AmendmentRecord>(`/amendments/${item.id}/cancel`, "POST", {
        commandKey: key,
        reason,
      }),
    );
    if (result) {
      setPaying(false);
      await changed();
    }
  }
  return (
    <section>
      <div className="panel-heading">
        <h3>改期记录</h3>
        {canAmend && (
          <button
            className="button button-secondary button-small"
            onClick={() => {
              setEditing(!editing);
              setCancellingUnpaid(false);
              setSelected(null);
            }}
          >
            调整球场 / 时段
          </button>
        )}
      </div>
      <ErrorNotice error={amendments.error ?? command.error} />
      {unpaid && (
        <>
          <p className="tennis-muted">调整时段不会延长付款期限。</p>
          {paymentUnresolved && (
            <p className="tennis-note">付款结果尚未确认，请先刷新核对，再调整时段。</p>
          )}
          {canEdit && (
            <button
              className="button button-secondary button-small"
              disabled={paymentUnresolved}
              onClick={() => {
                setCancellingUnpaid(!cancellingUnpaid);
                setEditing(false);
              }}
            >
              取消部分未付款时段
            </button>
          )}
        </>
      )}
      {cancellingUnpaid && unpaid && canEdit && (
        <UnpaidCancelEditor
          api={api}
          scope={scope}
          order={order}
          venue={venue}
          courts={courts}
          onClose={() => setCancellingUnpaid(false)}
          onChanged={async () => {
            setCancellingUnpaid(false);
            await changed();
          }}
        />
      )}
      {editing && canAmend && (
        <AmendmentEditor
          api={api}
          venue={venue}
          scope={scope}
          order={order}
          courts={courts}
          onClose={() => setEditing(false)}
          onConfirmed={async (result) => {
            setEditing(false);
            setSelected(result.id);
            await changed();
          }}
        />
      )}
      {amendments.data?.length === 0 && !editing && (
        <p className="tennis-muted">暂无改期记录。</p>
      )}
      {amendments.data?.map((item) => (
        <div className="tennis-ledger-row" key={item.id}>
          <div>
            <strong>{statusLabels[item.status]}</strong>
            <span>
              {item.reason} ·{" "}
              {item.unpaid
                ? "未付款预约调整"
                : `补款 ${money(item.supplementalCents)} · 核准退款 ${money(item.approvedRefundCents)}`}
            </span>
            {item.holdUntil && (
              <span>
                新时段保留至 {dateTime(item.holdUntil, venue.timezone)}
                ；补款成功前原预约仍有效。
              </span>
            )}
          </div>
          <button
            className="button button-secondary button-small"
            onClick={() => {
              setSelected(selected === item.id ? null : item.id);
              setPaying(false);
            }}
          >
            核对明细
          </button>
        </div>
      ))}
      {current && (
        <Panel title="改期前后对照">
          <AmendmentComparison item={current} venue={venue} courts={courts} />
          {current.status === "AWAITING_PAYMENT" && canPay && (
            <div className="tennis-actions">
              <button className="button button-primary" onClick={() => setPaying(true)}>
                支付补款 {money(current.supplementalCents)}
              </button>
              {canEdit && (
                <button
                  className="button button-secondary"
                  disabled={command.busy}
                  onClick={() => void cancel(current)}
                >
                  取消本次改期
                </button>
              )}
            </div>
          )}
          {paying && canPay && current.status === "AWAITING_PAYMENT" && (
            <PaymentForm
              api={api}
              session={session}
              scope={scope}
              order={order}
              amendmentId={current.id}
              amountCents={current.supplementalCents}
              onClose={() => setPaying(false)}
              onDone={() => {
                setPaying(false);
                void changed();
              }}
            />
          )}
        </Panel>
      )}
    </section>
  );
}
function AmendmentComparison({
  item,
  venue,
  courts,
}: {
  item: AmendmentRecord;
  venue: VenueRecord;
  courts: CourtRecord[];
}) {
  const name = (id: string) => courts.find((c) => c.id === id)?.name ?? "球场";
  return (
    <div className="tennis-table-scroll">
      <table className="tennis-table">
        <thead>
          <tr>
            <th>原预订</th>
            <th>新预订</th>
            <th>费用参考</th>
          </tr>
        </thead>
        <tbody>
          {item.lines.map((line) => (
            <tr key={line.lineId}>
              <td>
                <strong>{name(line.old.courtId)}</strong>
                <small>
                  {dateTime(line.old.startAt, venue.timezone)}–{clock(line.old.endAt, venue.timezone)}
                </small>
                {money(line.old.amountCents)}
              </td>
              <td>
                <strong>{name(line.new.courtId)}</strong>
                <small>
                  {dateTime(line.new.startAt, venue.timezone)}–{clock(line.new.endAt, venue.timezone)}
                </small>
                {money(line.new.totalCents)}
              </td>
              <td>
                {item.unpaid ? (
                  <>
                    待付费用更新<small>不产生补款或退款</small>
                  </>
                ) : (
                  <>
                    补款 {money(Math.max(0, line.fundingCapDeltaCents))}
                    <small>建议可退 {money(line.suggestedRefundCents)}</small>
                    {line.approvedRefundCents !== null && <small>已核准退 {money(line.approvedRefundCents)}</small>}
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function AmendmentEditor({
  api,
  venue,
  scope,
  order,
  courts,
  onClose,
  onConfirmed,
}: {
  api: TennisApi;
  venue: VenueRecord;
  scope: string;
  order: OrderRecord;
  courts: CourtRecord[];
  onClose: () => void;
  onConfirmed: (item: AmendmentRecord) => void;
}) {
  const [draft, setDraft] = useDraft(`tennis:amend:${scope}:${order.id}`, {
    baseRevision: order.revision,
    reason: "",
    rows: order.lines
      .filter((line) => !line.cancelledAt)
      .map((line) => ({
        lineId: line.id,
        selected: false,
        courtId: line.courtId,
        date: dateValue(new Date(line.startAt), venue.timezone),
        time: clock(line.startAt, venue.timezone),
        duration: (Date.parse(line.endAt) - Date.parse(line.startAt)) / 60_000,
      })),
    preview: null as AmendmentRecord | null,
    refunds: {} as Record<string, string>,
  });
  const draftIsCurrent = draft.baseRevision === order.revision;
  const previewIsCurrent =
    draftIsCurrent &&
    (!draft.preview || (draft.preview.status === "QUOTED" && draft.preview.baseRevision === order.revision));
  useEffect(() => {
    if (!draftIsCurrent || (draft.preview && !previewIsCurrent))
      setDraft((current) => ({
        ...current,
        baseRevision: order.revision,
        preview: null,
        refunds: {},
        rows: order.lines
          .filter((line) => !line.cancelledAt)
          .map((line) => ({
            lineId: line.id,
            selected: false,
            courtId: line.courtId,
            date: dateValue(new Date(line.startAt), venue.timezone),
            time: clock(line.startAt, venue.timezone),
            duration: (Date.parse(line.endAt) - Date.parse(line.startAt)) / 60_000,
          })),
      }));
  }, [order.revision, draft.preview?.id, previewIsCurrent, draftIsCurrent]);
  const version = useRef(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const command = useCommand(scope);
  function update(patch: Partial<typeof draft>) {
    version.current++;
    setDraft((current) => ({ ...current, ...patch, preview: null }));
  }
  async function preview() {
    setBusy(true);
    setError(undefined);
    const started = version.current;
    try {
      const changes = draft.rows
        .filter((row) => row.selected)
        .map((row) => {
          const [h = 0, m = 0] = row.time.split(":").map(Number);
          return {
            lineId: row.lineId,
            courtId: row.courtId,
            startAt: atVenueTime(row.date, h * 60 + m, venue.timezone),
            endAt: atVenueTime(row.date, h * 60 + m + row.duration, venue.timezone),
          };
        });
      const result = await api<AmendmentRecord>(`/orders/${order.id}/amendments`, "POST", {
        expectedRevision: order.revision,
        changes,
        reason: draft.reason,
      });
      if (version.current === started)
        setDraft((current) => ({
          ...current,
          preview: result,
          refunds: Object.fromEntries(result.lines.map((line) => [line.lineId, "0.00"])),
        }));
    } catch (next) {
      setError(next);
    } finally {
      setBusy(false);
    }
  }
  async function confirm() {
    if (!draft.preview || !previewIsCurrent) return;
    try {
      const approvedRefundLines = draft.preview.lines
        .filter((line) => line.suggestedRefundCents > 0)
        .map((line) => ({
          lineId: line.lineId,
          refundCents: cents(draft.refunds[line.lineId] ?? "0"),
        }));
      const payload = { approvedRefundLines };
      const result = await command.execute(`amendment.confirm:${draft.preview.id}`, payload, (key) =>
        api<AmendmentRecord>(`/amendments/${draft.preview!.id}/confirm`, "POST", { ...payload, commandKey: key }),
      );
      if (result) {
        setDraft((current) => ({
          ...current,
          preview: null,
          reason: "",
          rows: current.rows.map((row) => ({ ...row, selected: false })),
        }));
        onConfirmed(result);
      }
    } catch (next) {
      setError(next);
    }
  }
  return (
    <Panel title="按明细调整预订">
      <ErrorNotice error={error ?? command.error} />
      {draft.preview && previewIsCurrent ? (
        <div className="tennis-form">
          <AmendmentComparison item={draft.preview} venue={venue} courts={courts} />
          <div className="tennis-money-row tennis-total">
            <span>{draft.preview.unpaid ? "调整后整单待付" : "本次需补款"}</span>
            <strong>
              {money(
                draft.preview.unpaid
                  ? order.totalCents +
                      draft.preview.lines.reduce((sum, line) => sum + line.new.totalCents - line.old.amountCents, 0)
                  : draft.preview.supplementalCents,
              )}
            </strong>
          </div>
          {draft.preview.lines
            .filter((line) => line.suggestedRefundCents > 0)
            .map((line) => (
              <label key={line.lineId}>
                {courts.find((c) => c.id === line.old.courtId)?.name ?? "球场"} · 核准退款（元）
                <input
                  type="number"
                  min="0"
                  max={line.suggestedRefundCents / 100}
                  step="0.01"
                  value={draft.refunds[line.lineId] ?? "0"}
                  onChange={(e) =>
                    setDraft((current) => ({
                      ...current,
                      refunds: {
                        ...current.refunds,
                        [line.lineId]: e.target.value,
                      },
                    }))
                  }
                />
                <small>
                  建议最多 {money(line.suggestedRefundCents)}
                  ，请填写与客户确认的退款金额。
                </small>
              </label>
            ))}
          <p className="tennis-note">
            方案有效至 {dateTime(draft.preview.expiresAt, venue.timezone)}
            {draft.preview.unpaid
              ? `。仍需在 ${dateTime(order.holdUntil, venue.timezone)} 前付款。调整失败会保留原预约；应付为零时直接确认。`
              : "。补款付清后才完成改期，此前保留原预约和新时段。退款原路退回。"}
          </p>
          <div className="tennis-actions">
            <button className="button button-secondary" disabled={command.busy} onClick={() => update({})}>
              返回修改
            </button>
            <button className="button button-primary" disabled={command.busy} onClick={() => void confirm()}>
              {command.busy ? "正在确认…" : draft.preview.unpaid ? "确认调整未付款预约" : "确认改期及补退差额"}
            </button>
          </div>
        </div>
      ) : (
        <div className="tennis-form">
          {draft.rows.map((row, i) => {
            const old = order.lines.find((line) => line.id === row.lineId);
            if (!old || old.cancelledAt) return null;
            const change = (patch: Partial<typeof row>) =>
              update({
                rows: draft.rows.map((item, index) => (index === i ? { ...item, ...patch } : item)),
              });
            return (
              <div className="tennis-refund-line" key={row.lineId}>
                <label className="tennis-check">
                  <input
                    type="checkbox"
                    checked={row.selected}
                    onChange={(e) => change({ selected: e.target.checked })}
                  />
                  {courts.find((c) => c.id === old.courtId)?.name ?? "球场"} · {dateTime(old.startAt, venue.timezone)}–
                  {clock(old.endAt, venue.timezone)}
                </label>
                {row.selected && (
                  <>
                    <label>
                      新球场
                      <select value={row.courtId} onChange={(e) => change({ courtId: e.target.value })}>
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
                        新日期
                        <input type="date" value={row.date} onChange={(e) => change({ date: e.target.value })} />
                      </label>
                      <label>
                        新开始时间
                        <input
                          type="time"
                          step="900"
                          value={row.time}
                          onChange={(e) => change({ time: e.target.value })}
                        />
                      </label>
                    </div>
                    <label>
                      时长（分钟）
                      <input
                        type="number"
                        min="15"
                        max="1440"
                        step="15"
                        value={row.duration}
                        onChange={(e) => change({ duration: Number(e.target.value) })}
                      />
                    </label>
                  </>
                )}
              </div>
            );
          })}
          <label>
            改期原因
            <textarea value={draft.reason} onChange={(e) => update({ reason: e.target.value })} maxLength={2000} />
          </label>
          <div className="tennis-actions">
            <button className="button button-secondary" disabled={busy} onClick={onClose}>
              返回
            </button>
            <button
              className="button button-primary"
              disabled={busy || !draft.reason.trim() || !draft.rows.some((row) => row.selected)}
              onClick={() => void preview()}
            >
              {busy ? "正在核对…" : "核对新时段及价格"}
            </button>
          </div>
        </div>
      )}
    </Panel>
  );
}

function UnpaidCancelEditor({
  api,
  scope,
  order,
  venue,
  courts,
  onClose,
  onChanged,
}: {
  api: TennisApi;
  scope: string;
  order: OrderDetail;
  venue: VenueRecord;
  courts: CourtRecord[];
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [draft, setDraft] = useDraft(`tennis:cancel-unpaid:${scope}:${order.id}:${order.revision}`, {
    lineIds: [] as string[],
    reason: "",
  });
  const command = useCommand(scope);
  const active = order.lines.filter((line) => !line.cancelledAt);
  const selected = active.filter((line) => draft.lineIds.includes(line.id));
  const remaining = active.filter((line) => !draft.lineIds.includes(line.id));
  const total = remaining.reduce((sum, line) => sum + line.amountCents, 0);
  async function confirm() {
    const payload = {
      expectedRevision: order.revision,
      lineIds: selected.map((line) => line.id),
      reason: draft.reason,
    };
    const result = await command.execute(`order.cancel-unpaid-lines:${order.id}`, payload, (key) =>
      api<OrderRecord>(`/orders/${order.id}/cancel-unpaid-lines`, "POST", {
        ...payload,
        commandKey: key,
      }),
    );
    if (result) {
      setDraft({ lineIds: [], reason: "" });
      await onChanged();
    }
  }
  return (
    <Panel title="按明细取消未付款时段">
      <div className="tennis-form">
        <ErrorNotice error={command.error} />
        {active.map((line) => (
          <label className="tennis-check" key={line.id}>
            <input
              type="checkbox"
              disabled={command.busy}
              checked={draft.lineIds.includes(line.id)}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  lineIds: event.target.checked
                    ? [...draft.lineIds, line.id]
                    : draft.lineIds.filter((id) => id !== line.id),
                })
              }
            />
            {courts.find((court) => court.id === line.courtId)?.name ?? "球场"} ·{" "}
            {dateTime(line.startAt, venue.timezone)}–{clock(line.endAt, venue.timezone)} · {money(line.amountCents)}
          </label>
        ))}
        <label>
          取消原因
          <textarea
            disabled={command.busy}
            value={draft.reason}
            maxLength={2000}
            onChange={(event) => setDraft({ ...draft, reason: event.target.value })}
          />
        </label>
        <p className="tennis-note">
          {remaining.length
            ? `保留 ${remaining.length} 条时段，整单待付由 ${money(order.totalCents)} 调整为 ${money(total)}。`
            : "所选为全部有效时段，确认后整单取消。"}
          {remaining.length && total > 0
            ? `付款截止仍为 ${dateTime(order.holdUntil, venue.timezone)}。`
            : remaining.length
              ? "剩余免费时段会直接确认。"
              : ""}
          本次无需收款或退款。
        </p>
        <div className="tennis-actions">
          <button className="button button-secondary" disabled={command.busy} onClick={onClose}>
            返回
          </button>
          <button
            className="button button-danger"
            disabled={command.busy || !selected.length || !draft.reason.trim()}
            onClick={() => void confirm()}
          >
            {command.busy ? "正在确认…" : "确认取消所选未付款时段"}
          </button>
        </div>
      </div>
    </Panel>
  );
}
