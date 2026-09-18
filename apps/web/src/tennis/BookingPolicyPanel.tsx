import { useState } from "react";
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
    if (result) { setReload((v) => v + 1); setMessage("已重新读取当前设置。"); }
  }
  return (
    <Panel title="预订期限" action={
      <button className="button button-secondary" disabled={saving || policy.busy} onClick={() => void refresh()}>
        重新读取当前设置
      </button>
    }>
      <p className="tennis-muted">适用于本租户全部场馆的新订场报价和改期报价。已有报价及订单保留原期限。</p>
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
          <label>报价有效期（分钟）
            <input type="number" min="1" max="1440" step="1" required value={quote} onChange={(e) => setQuote(e.target.value)} />
          </label>
          <label>待付款占位期（分钟）
            <input type="number" min="1" max="1440" step="1" required value={hold} onChange={(e) => setHold(e.target.value)} />
          </label>
        </div>
      </fieldset>
      <p className="tennis-muted">默认报价 5 分钟、待付款占位 10 分钟，可设置 1–1440 整分钟。待付款占位从确认报价开始计时。员工注明原因的保留预约沿用单独填写的截止时间；未付款订单改期不延长原截止时间。</p>
      <button type="submit" className="button button-primary" disabled={busy}>{busy ? "正在保存…" : "保存预订期限"}</button>
    </form>
  );
}
