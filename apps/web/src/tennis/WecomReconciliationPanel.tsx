import { useRef, useState } from "react";
import { TennisApiError, type TennisApi } from "./api";
import { dateTime, EmptyState, ErrorNotice, LoadingBlock, money, Panel, RefreshButton, useDraft, useLoad } from "./components";
import type { Session, VenueRecord } from "./types";
import type { WecomReceipt, WecomPaymentTarget } from "../../../../packages/db/src/tennis/wecom-reconciliation";

type ReceiptPage = { items: WecomReceipt[]; nextCursor: string | null };
type DemoCommand = { operationId: string; referenceMode: "EXACT" | "UNMATCHED"; commandKey: string };
type LinkCommand = { receiptId: string; operationId: string; reason: string };
const channelStates: Record<string, string> = { READY: "尚未发起", IN_FLIGHT: "处理中", UNKNOWN: "结果待核对", PENDING: "待确认", SUCCEEDED: "已成功", FAILED: "已失败" };
const states = { UNMATCHED: "待确认归属", REVIEW: "关联需核对", LINKED: "已关联入账", EXCEPTION: "已记录实收异常" };
const uncertain = (error: unknown) => !(error instanceof TennisApiError) || error.uncertain;
const errorLabels: Record<string, string> = {
  WECOM_TARGET_MISMATCH: "业务记录与流水不一致，请核对商户、金额及原支付记录。",
  WECOM_REFERENCE_MISMATCH: "流水中的业务引用不一致，请核对原支付记录。",
  CHANNEL_TRANSACTION_REUSED: "该渠道交易已被使用，请核对原关联。",
};
const resultText = (value: WecomReceipt) => value.state === "EXCEPTION"
  ? "实收已记录，但未用于正常成交。请在资金核对中处理迟付或额外实收。"
  : value.state === "LINKED" ? "流水已关联，业务资金记录已更新。"
  : value.state === "REVIEW" ? "流水已保存，需要核对关联信息。" : "流水已保存，等待确认业务归属。";

export function WecomReconciliationPanel(props: { api: TennisApi; session: Session; venue: VenueRecord; onChanged: () => Promise<unknown>; openOrder: (id: string) => void }) {
  const { session, venue } = props;
  if (session.kind !== "staff" || !session.tenants.some(t => t.id === session.tenantId && t.kind === "staff" && t.role === "ADMIN")) return null;
  return <Reconciliation key={`${session.subjectId}:${session.tenantId}:${session.contextVersion}:${venue.id}`} {...props} />;
}
function Reconciliation({ api, session, venue, onChanged, openOrder }: Parameters<typeof WecomReconciliationPanel>[0]) {
  const scope = `${session.subjectId}:${session.tenantId}:${session.contextVersion}:${venue.id}`;
  const [filter, setFilter] = useState("");
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors.at(-1);
  const params = new URLSearchParams({ ...(filter ? { state: filter } : {}), ...(q ? { q } : {}), ...(cursor ? { cursor } : {}) });
  const receipts = useLoad(() => api<ReceiptPage>(`/wecom/receipts?${params}`), [api, filter, q, cursor]);
  const [targetSearch, setTargetSearch] = useState("");
  const [targetId, setTargetId] = useState("");
  const targets = useLoad(() => api<WecomPaymentTarget[]>(`/wecom/payment-targets?${new URLSearchParams({ venueId: venue.id, ...(targetId ? { operationId: targetId } : {}) })}`), [api, venue.id, targetId]);
  const [selected, setSelected] = useState<WecomReceipt | null>(null);
  const [operationId, setOperationId] = useState("");
  const [reason, setReason] = useState("");
  const [mode, setMode] = useState<DemoCommand["referenceMode"]>("EXACT");
  const [pendingDemo, setPendingDemo] = useDraft<DemoCommand | null>(`tennis:wecom:demo:${scope}`, null);
  const [pendingLink, setPendingLink] = useDraft<LinkCommand | null>(`tennis:wecom:link:${scope}`, null);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [error, setError] = useState<unknown>();
  const [notice, setNotice] = useState("");
  const pending = pendingLink || pendingDemo;
  const target = targets.data?.find(t => t.operationId === operationId);
  function clearSelection() { if (!pendingLink) { setSelected(null); setOperationId(""); setReason(""); } }
  function resetPage() { setCursors([null]); clearSelection(); }
  async function refresh() {
    await Promise.all([receipts.refresh(), targets.refresh(), onChanged()]);
  }
  async function perform(kind: "demo" | "link") {
    if (running.current) return;
    const command: DemoCommand | LinkCommand | null = kind === "demo"
      ? pendingDemo ?? (operationId ? { operationId, referenceMode: mode, commandKey: crypto.randomUUID() } : null)
      : pendingLink ?? (selected && operationId && reason.trim() ? { receiptId: selected.id, operationId, reason: reason.trim() } : null);
    if (!command) return;
    running.current = true; setBusy(true); setError(undefined); setNotice("");
    if (kind === "demo") setPendingDemo(command as DemoCommand); else setPendingLink(command as LinkCommand);
    try {
      const result = kind === "demo"
        ? await api<WecomReceipt>("/wecom/demo-receipts", "POST", command)
        : await api<WecomReceipt>(`/wecom/receipts/${encodeURIComponent((command as LinkCommand).receiptId)}/link`, "POST", { operationId: command.operationId, reason: (command as LinkCommand).reason });
      if (kind === "demo") setPendingDemo(null); else setPendingLink(null);
      setNotice(resultText(result)); setSelected(null); setReason(""); setOperationId("");
      setQ(result.id); setSearch(result.id); setFilter(""); resetPage();
      await refresh();
    } catch (next) {
      setError(next);
      if (!uncertain(next)) { if (kind === "demo") setPendingDemo(null); else setPendingLink(null); }
    } finally { running.current = false; setBusy(false); }
  }
  return <Panel title="企微收款对照" action={<RefreshButton busy={busy || receipts.busy} onClick={() => void refresh()} />}>
    <p className="tennis-muted">本租户全部场馆的收款流水。准确关联的可信流水自动办理；其余由租户管理员核对。下方可选业务限定在 {venue.name}。</p>
    {session.localSimulation && <p className="tennis-note is-warning">演示使用合成收款流水，未连接真实企业微信。此处的关联和入账仅用于本地验收。</p>}
    {notice && <p className="tennis-success" role="status">{notice}</p>}
    <ErrorNotice error={error ?? receipts.error ?? targets.error} retry={() => void refresh()} />
    {pending && <div className="tennis-note is-warning" role="status">
      <p>上一笔操作结果待核对，已保留原业务编号及提交内容。恢复前不能改换另一笔业务。</p>
      <p>原业务编号：<code>{pending.operationId}</code>{pendingLink && <> · 原流水：<code>{pendingLink.receiptId}</code></>}</p>
      <button className="button button-secondary" disabled={busy} onClick={() => void perform(pendingLink ? "link" : "demo")}>核对并恢复原操作</button>
    </div>}
    <form className="tennis-actions" onSubmit={event => { event.preventDefault(); setQ(search.trim()); resetPage(); }}>
      <label>流水状态<select value={filter} onChange={event => { setFilter(event.target.value); resetPage(); }}>
        <option value="">全部状态</option>{Object.entries(states).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      <label>查找流水<input value={search} maxLength={200} placeholder="流水编号或渠道交易号" onChange={event => setSearch(event.target.value)} /></label>
      <button className="button button-secondary" type="submit">查询</button>
      {q && <button className="button button-secondary" type="button" onClick={() => { setSearch(""); setQ(""); resetPage(); }}>清除查询</button>}
    </form>
    {receipts.busy && !receipts.data ? <LoadingBlock /> : receipts.data?.items.length === 0 ? <EmptyState title="暂无符合条件的收款流水" detail="可信渠道流水接入后会显示在这里；本地演示可在下方生成合成流水。" /> : receipts.data && <>
      <div className="tennis-table-scroll"><table className="tennis-table"><thead><tr><th>收款时间</th><th>实收</th><th>渠道交易</th><th>状态</th><th>关联依据</th><th>操作</th></tr></thead><tbody>
        {receipts.data.items.map(receipt => <tr key={receipt.id}>
          <td>{dateTime(receipt.paidAt, venue.timezone)}<small>{receipt.simulation ? "合成流水" : "渠道实收"}</small></td>
          <td className="tennis-numeric">{money(receipt.amountCents)}</td>
          <td><span title={receipt.transactionId}>{receipt.transactionId.slice(0, 20)}</span><small title={receipt.id}>流水 {receipt.id.slice(0, 12)}</small><small>商户 {receipt.merchantId}</small></td>
          <td>{states[receipt.state]}{receipt.business && <small>{receipt.business.venueName} · {receipt.business.sourceKind === "ORDER" ? "预订" : "充值"}</small>}</td>
          <td>{receipt.operationId ? <span title={receipt.operationId}>业务 {receipt.operationId.slice(0, 12)}</span> : "尚未关联"}<small>{receipt.linkReason ?? (receipt.trustedOperationId ? "渠道携带明确业务引用" : "需核对业务凭据")}</small>{receipt.lastError && <small>{errorLabels[receipt.lastError] ?? "关联未完成，请核对原业务记录。"}</small>}</td>
          <td>{["UNMATCHED", "REVIEW"].includes(receipt.state) ? <button type="button" className="button button-secondary button-small" disabled={busy || !!pending} onClick={() => { setSelected(receipt); setOperationId(""); setReason(""); setError(undefined); setNotice(""); }}>核对归属</button> : <><span className="tennis-muted">{receipt.state === "EXCEPTION" ? (receipt.business?.venueId === venue.id ? "在下方实收异常中处理" : `切换至 ${receipt.business?.venueName ?? "原业务场馆"} 的资金核对处理`) : "已完成"}</span>{receipt.business?.venueId === venue.id && receipt.business.orderId && <button type="button" className="button button-secondary button-small" onClick={() => openOrder(receipt.business!.orderId!)}>查看订单</button>}</>}</td>
        </tr>)}
      </tbody></table></div>
      <div className="tennis-actions">
        <button className="button button-secondary" disabled={receipts.busy || cursors.length <= 1} onClick={() => { clearSelection(); setCursors(value => value.slice(0, -1)); }}>上一页</button>
        <span>第 {cursors.length} 页</span>
        <button className="button button-secondary" disabled={receipts.busy || !receipts.data.nextCursor} onClick={() => { clearSelection(); setCursors(value => [...value, receipts.data!.nextCursor]); }}>下一页</button>
      </div>
    </>}
    {(selected || session.localSimulation || pending) && <details open={!!selected || !!pending}>
      <summary>{selected ? `核对 ${money(selected.amountCents)} 收款归属` : "本地收款演示与业务查找"}</summary>
      {selected && <div className="tennis-note" style={{ overflowWrap: "anywhere" }}><strong>当前核对的原始收款</strong><p>流水编号：<code>{selected.id}</code><br />渠道交易号：<code>{selected.transactionId}</code><br />收款商户：{selected.merchantId}<br />收款时间：{dateTime(selected.paidAt, venue.timezone)} · 实收 {money(selected.amountCents)}</p></div>}
      <form className="tennis-actions" onSubmit={event => { event.preventDefault(); setTargetId(targetSearch.trim()); setOperationId(""); }}>
        <label>原业务编号<input value={targetSearch} maxLength={200} disabled={busy || !!pending} placeholder="可按支付渠道操作编号查找旧记录" onChange={event => setTargetSearch(event.target.value)} /></label>
        <button type="submit" className="button button-secondary" disabled={busy || !!pending}>查找业务</button>
        {targetId && <button type="button" className="button button-secondary" disabled={busy || !!pending} onClick={() => { setTargetSearch(""); setTargetId(""); setOperationId(""); }}>返回待收款记录</button>}
      </form>
      <label>选择 {venue.name} 的业务记录<select value={operationId} disabled={busy || !!pending || targets.busy} onChange={event => setOperationId(event.target.value)}>
        <option value="">请核对后选择</option>{targets.data?.map(value => <option key={value.operationId} value={value.operationId}>{value.sourceKind === "ORDER" ? "订单" : "充值"} · {value.customerName} · {money(value.amountCents)} · {value.operationId.slice(0, 12)}</option>)}
      </select></label>
      {targets.data?.length === 0 && <p className="tennis-muted">未找到可选记录。先在订单或会员页发起付款，或输入原支付渠道操作编号查询。</p>}
      {target && <p className="tennis-note">原外部支付金额 {money(target.amountCents)} · {channelStates[target.state] ?? "待核对"} · 创建于 {dateTime(target.createdAt, venue.timezone)} · 商户 {target.merchantId} · 业务编号 <code>{target.operationId}</code>{target.orderId && <button type="button" className="button button-secondary button-small" onClick={() => openOrder(target.orderId!)}>查看订单</button>}</p>}
      {target && ["SUCCEEDED", "FAILED"].includes(target.state) && <p className="tennis-note is-warning">这是已处理过的支付记录。新发现的实收可能进入额外实收或迟付异常，原金额不代表当前欠款。</p>}
      {selected ? <div className="tennis-form">
        <p>请核对交易凭据与业务归属。相同金额或客户昵称不能单独证明归属。</p>
        <label>核对依据<textarea value={reason} maxLength={2000} disabled={busy || !!pending} onChange={event => setReason(event.target.value)} placeholder="记录已核实的订单、收款凭据及关联原因" /></label>
        {target && (target.amountCents !== selected.amountCents || target.merchantId !== selected.merchantId || target.provider !== selected.provider) && <p className="inline-error">所选业务的金额或收款商户与该流水不一致，请重新核对。</p>}
        <div className="tennis-actions"><button className="button button-primary" disabled={busy || !!pending || !target || !reason.trim() || target.amountCents !== selected.amountCents || target.merchantId !== selected.merchantId || target.provider !== selected.provider} onClick={() => void perform("link")}>确认关联并核对入账</button><button className="button button-secondary" disabled={busy || !!pending} onClick={() => setSelected(null)}>取消核对</button></div>
      </div> : session.localSimulation && <div className="tennis-form">
        <label>合成流水类型<select value={mode} disabled={busy || !!pending} onChange={event => setMode(event.target.value as DemoCommand["referenceMode"])}><option value="EXACT">带明确业务引用，验证自动归单</option><option value="UNMATCHED">无业务引用，验证待核对流程</option></select></label>
        <button className="button button-secondary" disabled={busy || !!pending || !target || target.provider !== "MOCK"} onClick={() => void perform("demo")}>生成一笔合成收款流水</button>
      </div>}
    </details>}
  </Panel>;
}
