import { useState } from "react";
import { InfoHint } from "./InfoHint";
import type { BookingPolicy } from "../../../../packages/db/src/tennis/booking-policy";
import type { TennisApi } from "./api";
import { ErrorNotice, LoadingBlock, Panel, useLoad } from "./components";

export function BookingPolicyPanel({ api }: { api: TennisApi }) {
  const policy = useLoad(() => api<BookingPolicy>("/booking-policy"), [api]);
  const [reload, setReload] = useState(0);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  async function refresh() {
    const result = await policy.refresh();
    if (result) { setReload((v) => v + 1); setMessage("设置已刷新。"); }
  }
  return (
    <Panel title="预订期限" action={
      <div className="tennis-actions">
        <InfoHint label="预订期限说明">用于所有场馆的新预订和改期报价，已有报价和订单的期限不变。</InfoHint>
        <button className="button button-secondary" disabled={saving || policy.busy} onClick={() => void refresh()}>
          刷新设置
        </button>
      </div>
    }>
      <ErrorNotice error={policy.error} retry={() => void refresh()} />
      {message && <p className="tennis-success" role="status">{message}</p>}
      {policy.data ? (
        <PolicyForm key={`${policy.data.revision}:${reload}`} api={api} source={policy.data}
          onBusy={(value) => { setSaving(value); if (value) setMessage(""); }} onSaved={async () => { await policy.refresh(); setMessage("预订期限已保存，将用于新报价。"); }} />
      ) : <LoadingBlock />}
    </Panel>
  );
}
function PolicyForm({ api, source, onBusy, onSaved }: {
  api: TennisApi; source: BookingPolicy; onBusy: (value: boolean) => void; onSaved: () => Promise<void>;
}) {
  const [quote, setQuote] = useState(String(source.quoteMinutes));
  const [hold, setHold] = useState(String(source.paymentHoldMinutes));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  async function save() {
    setBusy(true); onBusy(true); setError(undefined);
    try {
      await api<BookingPolicy>("/booking-policy", "PATCH", {
        quoteMinutes: Number(quote), paymentHoldMinutes: Number(hold), expectedRevision: source.revision,
      });
      await onSaved();
    } catch (next) { setError(next); }
    finally { setBusy(false); onBusy(false); }
  }
  return (
    <form className="tennis-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <ErrorNotice error={error} />
      <fieldset disabled={busy}>
        <div className="tennis-two">
          <div className="tennis-label">
            <div className="tennis-field-heading"><label htmlFor="booking-quote-minutes">报价有效期（分钟）</label><InfoHint label="报价有效期说明">客户需要在这段时间内确认报价，过期后需重新核价。可填 1–1440 分钟。</InfoHint></div>
            <input id="booking-quote-minutes" type="number" min="1" max="1440" step="1" required value={quote} onChange={(e) => setQuote(e.target.value)} />
          </div>
          <div className="tennis-label">
            <div className="tennis-field-heading"><label htmlFor="booking-hold-minutes">待付款保留时间（分钟）</label><InfoHint label="待付款保留时间说明">从确认报价开始计时。未付款订单改期不延长原付款期限；人工保留预约按单独填写的截止时间处理。可填 1–1440 分钟。</InfoHint></div>
            <input id="booking-hold-minutes" type="number" min="1" max="1440" step="1" required value={hold} onChange={(e) => setHold(e.target.value)} />
          </div>
        </div>
      </fieldset>
      <button type="submit" className="button button-primary" disabled={busy}>{busy ? "正在保存…" : "保存预订期限"}</button>
    </form>
  );
}
