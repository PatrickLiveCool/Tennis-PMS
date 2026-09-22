import { useEffect, useState } from "react";
import { parseBookingPhone } from "../../../../packages/domain/src/customer-contact";
import { TennisApiError, type TennisApi } from "./api";
import { ErrorNotice, Modal, forgetCommand, pendingCommands, useCommand, useDraft } from "./components";
import type { CommandReceipt, CustomerRecord } from "./types";

interface ContactDraft { expectedPhone: string | null; phone: string; reason: string }
export function CustomerContactCorrection({ api, scope, venueId, customer, onClose, onCorrected }: {
  api: TennisApi; scope: string; venueId: string; customer: CustomerRecord;
  onClose: () => void; onCorrected: (customer: CustomerRecord) => void;
}) {
  const intent = `customer.contact.correct:${customer.id}`;
  const [pending, setPending] = useState(() => pendingCommands(scope).find((item) => item.intent === intent));
  const initial = pending ? JSON.parse(pending.payload) as ContactDraft : { expectedPhone: customer.phone, phone: "", reason: "" };
  const [draft, setDraft] = useDraft<ContactDraft>(`tennis:contact-correction:${scope}:${customer.id}`, initial);
  const command = useCommand(scope);
  const [recovering, setRecovering] = useState(false);
  const [error, setError] = useState<unknown>();
  const [message, setMessage] = useState("");
  const busy = command.busy || recovering;
  const locked = busy || Boolean(pending);
  useEffect(() => {
    const sync = () => setPending(pendingCommands(scope).find((item) => item.intent === intent));
    window.addEventListener("tennis-pending", sync);
    return () => window.removeEventListener("tennis-pending", sync);
  }, [scope, intent]);
  useEffect(() => {
    const recovered = (event: Event) => {
      const detail = (event as CustomEvent<{ scope: string; customer: CustomerRecord }>).detail;
      if (detail?.scope === scope && detail.customer.id === customer.id) {
        setDraft({ expectedPhone: detail.customer.phone, phone: "", reason: "" });
        onClose();
      }
    };
    window.addEventListener("tennis-customer-contact-recovered", recovered);
    return () => window.removeEventListener("tennis-customer-contact-recovered", recovered);
  }, [scope, customer.id, onClose]);
  function completed(latest: CustomerRecord) {
    setDraft({ expectedPhone: latest.phone, phone: "", reason: "" });
    onCorrected(latest);
  }
  async function submit() {
    setError(undefined); setMessage("");
    const phone = parseBookingPhone(draft.phone);
    if (!pending && (!phone || !draft.reason.trim())) {
      setError(new Error("请填写有效的 11 位中国大陆手机号，并填写修改原因。"));
      return;
    }
    const payload = pending ? JSON.parse(pending.payload) as ContactDraft & { venueId: string } :
      { venueId, expectedPhone: draft.expectedPhone, phone: phone!, reason: draft.reason.trim() };
    const result = await command.execute(intent, payload, async (key) => {
      try {
        await api<{ customer: CustomerRecord }>(`/customers/${customer.id}/contact-corrections`, "POST", { ...payload, commandKey: key });
      } catch (next) {
        // These rejections occur only after looking up the original receipt.
        // An authorization failure cannot establish whether an earlier write committed.
        if (next instanceof TennisApiError && next.status === 409 &&
          ["PHONE_ALREADY_EXISTS", "STALE_CUSTOMER_CONTACT", "CUSTOMER_CONTACT_UNCHANGED", "INVALID_CONTACT_CORRECTION"].includes(next.code))
          forgetCommand(scope, key);
        throw next;
      }
      // Preserve the original pending request until the displayed profile is fresh.
      // A later correction may already supersede the original command receipt.
      try { return await api<CustomerRecord>(`/customers/${customer.id}`); }
      catch { throw new Error("手机号已保存，但暂时无法刷新会员资料。请查询修改结果。"); }
    });
    if (result) completed(result);
  }
  async function recover() {
    if (!pending) return;
    setRecovering(true); setError(undefined);
    try {
      const receipt = await api<CommandReceipt | null>(`/receipts/${encodeURIComponent(pending.key)}`);
      if (!receipt) { setMessage("暂时查不到结果，可按原内容重试。确认前请保留这次修改。"); return; }
      if (receipt.commandType !== "customer.contact.correct" || receipt.result.customerId !== customer.id || !receipt.result.customer)
        throw new Error("办理结果与这位会员不一致，请联系管理员核对。");
      const latest = await api<CustomerRecord>(`/customers/${customer.id}`);
      forgetCommand(scope, pending.key);
      completed(latest);
    } catch (next) { setError(next); }
    finally { setRecovering(false); }
  }
  async function refreshCurrent() {
    setRecovering(true); setError(undefined);
    try {
      const latest = await api<CustomerRecord>(`/customers/${customer.id}`);
      setDraft((current) => ({ ...current, expectedPhone: latest.phone }));
      command.setError(undefined);
      setMessage("已刷新当前手机号，请核对后再保存。");
    } catch (next) { setError(next); }
    finally { setRecovering(false); }
  }
  return <Modal title="修改手机号" onClose={onClose} closeDisabled={busy}>
    <form className="tennis-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <ErrorNotice error={error ?? command.error} />
      <p>{customer.nickname} · 当前手机号 <strong>{draft.expectedPhone ?? "未登记"}</strong></p>
      <label>新手机号<input type="tel" autoComplete="tel" required maxLength={30} disabled={locked}
        value={draft.phone} onChange={(event) => setDraft((current) => ({ ...current, phone: event.target.value }))} /></label>
      <label>修改原因<textarea required maxLength={2000} disabled={locked} value={draft.reason}
        placeholder="例如：客户确认原号码录入有误"
        onChange={(event) => setDraft((current) => ({ ...current, reason: event.target.value }))} /></label>
      {pending && <p className="tennis-note" role="status">这次修改还没确认结果，请先查询或按原内容重试。</p>}
      {message && <p className="tennis-note" role="status">{message}</p>}
      <div className="tennis-actions">
        {pending ? <>
          <button type="button" className="button button-secondary" disabled={busy} onClick={() => void recover()}>查询修改结果</button>
          <button type="submit" className="button button-primary" disabled={busy}>{busy ? "正在核对…" : "按原内容重试"}</button>
        </> : <>
          {command.error instanceof TennisApiError && command.error.code === "STALE_CUSTOMER_CONTACT" &&
            <button type="button" className="button button-secondary" disabled={busy} onClick={() => void refreshCurrent()}>刷新当前手机号</button>}
          <button type="submit" className="button button-primary" disabled={busy || !draft.phone.trim() || !draft.reason.trim()}>
            {busy ? "正在保存…" : "保存手机号"}
          </button>
        </>}
      </div>
    </form>
  </Modal>;
}
