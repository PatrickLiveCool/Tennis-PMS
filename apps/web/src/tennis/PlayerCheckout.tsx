import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, CalendarDays, ChevronRight, ClipboardList, LogOut, MapPin } from "lucide-react";
import { parsePlayerEntry, type BookingOption, type PlayerEntry } from "../../../../packages/domain/src/tennis-player-link";
import type { PlayerLine, PlayerOrder, PlayerOrderItem, PlayerPreview } from "../../../../packages/db/src/tennis/player-checkout";
import { createApi, TennisApiError, type TennisApi } from "./api";
import { Badge, clock, dateTime, dateValue, ErrorNotice, forgetCommand, label, LoadingBlock, money, pendingCommands, useCommand, useLoad } from "./components";
import type { Session } from "./types";
import "./player-checkout.css";

const mineUrl = "?booking=mine";
const orderUrl = (id: string) => "?booking=order&id=" + encodeURIComponent(id);
const policy = "如需退改，请在订场对话中联系场馆。场馆确认退款金额后，按原支付方式退回。";
const unavailable = "这个场次刚刚已不可订。请回到订场对话，和助手商量其他场次。";
type OpenOrder = (id: string, notice?: string) => void;
function customerError(error: unknown): unknown {
  if (!(error instanceof TennisApiError)) return error;
  if (["COURT_OCCUPANCY_CONFLICT", "INVENTORY_CONFLICT", "PAST_INTERVAL", "OUTSIDE_OPENING_HOURS",
    "RESOURCE_UNAVAILABLE", "PRICE_NOT_CONFIGURED", "COURT_DETAILS_INCOMPLETE"].includes(error.code)) return new Error(unavailable);
  if (error.code === "BOOKING_PHONE_REQUIRED") return new Error("请回到订场对话补充预订手机号，再打开此链接。");
  if (["RESOURCE_NOT_FOUND", "TENANT_ACCESS_DENIED", "VENUE_ACCESS_DENIED"].includes(error.code))
    return new Error("当前账号无法查看这条预订信息，请核对账号和链接。");
  if (["PAYMENT_ALREADY_PENDING", "ORDER_NOT_PAYABLE", "STALE_ORDER"].includes(error.code))
    return new Error("这笔订单的付款状态已有更新，请查看原订单。");
  if (error.code === "QUOTE_EXPIRED") return new Error("价格已过有效期，请重新核对这个场次后确认。");
  return error;
}
function day(value: string, timezone: string) {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "short", timeZone: timezone }).format(new Date(value));
}
function when(line: { startAt: string; endAt: string }, zone: string) {
  const crossesDay = dateValue(new Date(line.startAt), zone) !== dateValue(new Date(line.endAt), zone);
  return day(line.startAt, zone) + " " + clock(line.startAt, zone) + "–" +
    (crossesDay ? day(line.endAt, zone) + " " : "") + clock(line.endAt, zone);
}
function CourtCard({ venue, lines, order }: { venue: PlayerPreview["venue"]; lines: PlayerLine[]; order?: PlayerOrder }) {
  return <section className="player-card player-courts">
    <header><h2>{venue.name}</h2>{venue.address && <p><MapPin size={15} aria-hidden="true" />{venue.address}</p>}</header>
    {lines.map(line => <div className="player-slot" key={[line.courtId, line.startAt, line.endAt].join("/")}>
      <div><strong>{line.name}</strong><span>{line.description}</span></div>
      <p><CalendarDays size={16} aria-hidden="true" />{when(line, venue.timezone)}</p>
      {order && <div className="player-line-state"><span>{line.cancelled ? "已取消" :
        order.status === "EXPIRED" || order.status === "CANCELLED" ? "已释放" : "有效"}</span><b>{money(line.amountCents)}</b></div>}
    </div>)}
  </section>;
}
function Amounts({ total, wallet, simulated }: { total: number; wallet: number; simulated: boolean }) {
  return <div className="player-amounts">
    <div className="player-total"><span>合计</span><strong>{money(total)}</strong></div>
    {total > 0 && <div className="player-split">
      {wallet > 0 && <div><span>会员余额支付</span><b>{money(wallet)}</b></div>}
      {total > wallet && <div><span>{simulated ? "微信支付（模拟）" : "微信支付"}</span><b>{money(total - wallet)}</b></div>}
    </div>}
    {simulated && total > 0 && <p className="player-sim">本地模拟支付，不会产生真实扣款。</p>}
  </div>;
}
function PayButton({ busy, children, onClick }: { busy: boolean; children: React.ReactNode; onClick: () => void }) {
  return <button className="button button-primary player-pay" disabled={busy} onClick={onClick}>{busy ? "正在处理…" : children}</button>;
}
function paymentRequest(api: TennisApi, id: string, walletCents: number, commandKey: string) {
  return api<{ id: string; status: string }>(`/player/orders/${id}/payments`, "POST", { walletCents, commandKey });
}
type OfferEntry = Extract<PlayerEntry, { options: BookingOption[] }>;
function Offers({ api, entry, accountScope, simulated, openOrder }: {
  api: TennisApi; entry: OfferEntry; accountScope: string; simulated: boolean; openOrder: OpenOrder;
}) {
  const scope = accountScope + ":" + JSON.stringify(entry);
  const previews = useLoad(() => Promise.all(entry.options.map(async option => {
    try { return await api<PlayerPreview>("/player/preview", "POST", option); }
    catch (next) {
      if (next instanceof TennisApiError && next.code === "RESOURCE_NOT_FOUND") return null;
      throw next;
    }
  })), [api, entry]);
  const [picked, setPicked] = useState<number | null>(null);
  const [error, setError] = useState<unknown>();
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const command = useCommand(scope);
  const payment = useCommand(accountScope);
  const choices = previews.data?.flatMap((item, i) => item && item.state !== "unavailable" ? [{ item, i }] : []) ?? [];
  const booked = choices.flatMap(({ item }) => item.state === "booked" ? [item.orderId] : []);
  const choosing = entry.kind === "choose" && choices.length > 0;
  const chosen = choosing ? choices.find(row => row.i === picked) : choices[0];
  const existingId = booked.length === 1 ? booked[0] : chosen?.item.state === "booked" ? chosen.item.orderId : null;
  useEffect(() => { if (existingId) openOrder(existingId); }, [existingId]);
  const pending = pendingCommands(scope).find(c => c.intent.startsWith("quote.confirm:"));
  async function recover() {
    if (!pending || lock.current) return;
    lock.current = true; setBusy(true); setError(undefined);
    try {
      const id = pending.intent.slice("quote.confirm:".length);
      const order = await api<{ id: string }>(`/player/quotes/${id}/confirm`, "POST", { commandKey: pending.key });
      forgetCommand(scope, pending.key); openOrder(order.id);
    } catch (next) {
      if (next instanceof TennisApiError && !next.uncertain && next.status !== 401) {
        forgetCommand(scope, pending.key);
        await previews.refresh();
      }
      setError(customerError(next));
    } finally { lock.current = false; setBusy(false); }
  }
  async function confirm() {
    if (lock.current || !chosen || chosen.item.state !== "available") return;
    const shown = chosen.item;
    lock.current = true; setBusy(true); setError(undefined); setNotice(""); command.setError(undefined);
    try {
      const quote = await api<{ id: string; totalCents: number; lineCents: number[] }>("/player/quotes", "POST", entry.options[chosen.i]);
      if (quote.totalCents !== shown.totalCents || quote.lineCents.some((c, i) => c !== shown.lines[i]?.amountCents)) {
        await previews.refresh(); setNotice("场次价格已更新，请核对新金额后再确认。"); return;
      }
      const order = await command.execute(`quote.confirm:${quote.id}`, { quoteId: quote.id }, key =>
        api<Pick<PlayerOrder, "id" | "status" | "paymentStatus">>(`/player/quotes/${quote.id}/confirm`, "POST", { commandKey: key }));
      if (!order) { await previews.refresh(); return; }
      // A refresh or lost payment response must return to this same hold.
      window.history.replaceState(null, "", orderUrl(order.id));
      if (order.status === "HELD" && order.paymentStatus === "UNPAID") {
        let failure: unknown;
        const result = await payment.execute("order.payment:" + order.id, { walletCents: shown.walletCents },
          async key => {
            try { return await paymentRequest(api, order.id, shown.walletCents, key); }
            catch (next) { failure = customerError(next); throw next; }
          });
        if (!result) { openOrder(order.id, failure instanceof Error ? failure.message : "请核对本单的付款状态。"); return; }
      }
      openOrder(order.id);
    } catch (next) { setError(customerError(next)); await previews.refresh(); }
    finally { lock.current = false; setBusy(false); }
  }
  return <>
    <h1>{entry.kind === "choose" ? "选择场次" : "确认预订"}</h1>
    {previews.error ? <ErrorNotice error={customerError(previews.error)} retry={() => void previews.refresh()} /> :
      !previews.data ? <LoadingBlock label="正在核对场次" /> : <>
        {choosing && <fieldset className="player-choices" disabled={busy}><legend>选择聊天里谈好的一个方案</legend>
          {choices.map(({ item, i }) => <label key={i} className={picked === i ? "selected" : ""}>
            <input type="radio" name="booking-option" checked={picked === i} onChange={() => { setPicked(i); setError(undefined); }} />
            <span><strong>{item.venue.name}</strong>{item.lines.map(l => <small key={l.courtId + l.startAt}>{l.name} · {when(l, item.venue.timezone)}</small>)}</span>
            <b>{item.state === "available" ? money(item.totalCents) : "查看原单"}</b>
          </label>)}</fieldset>}
        {choices.length === 0 && <>
          <p className="player-notice" role="status">{entry.kind === "confirm" ? unavailable : "聊天里谈好的场次都已不可订，请回到订场对话再选。"}</p>
          {entry.kind === "confirm" && previews.data[0] && <CourtCard venue={previews.data[0].venue} lines={previews.data[0].lines} />}
        </>}
        {chosen?.item.state === "available" && <>
          <CourtCard venue={chosen.item.venue} lines={chosen.item.lines} />
          <section className="player-card player-check"><Amounts total={chosen.item.totalCents} wallet={chosen.item.walletCents} simulated={simulated} />
            <p className="player-policy">{policy}</p>
            {!pending && <PayButton busy={busy || previews.busy} onClick={() => void confirm()}>{chosen.item.totalCents ? "确认并支付 " + money(chosen.item.totalCents) : "确认预订"}</PayButton>}
          </section>
        </>}
      </>}
    {notice && <p className="player-notice" role="status">{notice}</p>}
    {choices.length > 0 && <ErrorNotice error={error ?? customerError(command.error)} />}
    {pending && !busy && <button className="button button-secondary" onClick={() => void recover()}>核对上次预订结果</button>}
  </>;
}
function PersonalOrder({ api, id, scope, simulated, notice }: {
  api: TennisApi; id: string; scope: string; simulated: boolean; notice: string;
}) {
  const detail = useLoad(() => api<PlayerOrder>(`/player/orders/${encodeURIComponent(id)}`), [api, id]);
  const order = detail.data;
  const command = useCommand(scope);
  const [now, setNow] = useState(Date.now);
  const [message, setMessage] = useState(notice);
  const held = order?.status === "HELD" && order.paymentStatus === "UNPAID";
  const paymentIntent = "order.payment:" + id;
  const previous = pendingCommands(scope).find(item => item.intent === paymentIntent);
  const previousWallet = previous ? (JSON.parse(previous.payload) as { walletCents: number }).walletCents : undefined;
  useEffect(() => {
    if (!previous || !order?.payments.length) return;
    let active = true;
    void api<{ commandType: string; result: { paymentId?: string } } | null>(`/receipts/${previous.key}`).then(receipt => {
      if (active && receipt?.commandType === "order.payment" && order.payments.some(p => p.id === receipt.result.paymentId))
        forgetCommand(scope, previous.key);
    }).catch(() => {});
    return () => { active = false; };
  }, [api, scope, previous?.key, order]);
  useEffect(() => {
    if (!held || !order?.holdUntil) return;
    const refresh = () => { setNow(Date.now()); void detail.refresh(); };
    const onFocus = () => { if (!document.hidden) refresh(); };
    const timer = window.setTimeout(refresh, Math.max(50, Date.parse(order.holdUntil) - Date.now() + 50));
    const polling = window.setInterval(refresh, 15000);
    document.addEventListener("visibilitychange", onFocus);
    return () => { clearTimeout(timer); clearInterval(polling); document.removeEventListener("visibilitychange", onFocus); };
  }, [held, order?.holdUntil, detail.refresh]);
  async function pay() {
    if (!order || !held) return;
    setMessage("");
    const walletCents = previousWallet ?? order.walletCents;
    await command.execute(paymentIntent, { walletCents }, async key => {
      try { return await paymentRequest(api, id, walletCents, key); }
      catch (next) {
        if (previous && next instanceof TennisApiError && next.status === 409 && !next.uncertain) forgetCommand(scope, key);
        throw next;
      }
    });
    await detail.refresh();
  }
  async function simulate(paymentId: string) {
    setMessage("");
    await command.execute("payment.simulate:" + paymentId, { status: "SUCCEEDED" }, () =>
      api(`/player/payments/${paymentId}/simulate`, "POST", { status: "SUCCEEDED" }));
    await detail.refresh();
  }
  const pending = order?.payments.find(p => p.status === "PENDING");
  const inTime = held && order.holdUntil && now < Date.parse(order.holdUntil);
  return <>
    <h1>预订详情 <small>· {id.slice(0, 8)}</small></h1>
    <ErrorNotice error={customerError(detail.error)} retry={() => void detail.refresh()} />
    {!order && !detail.error && <LoadingBlock label="正在读取预订" />}
    {order && <>
      <div className="player-state"><Badge value={order.status} /><Badge value={order.paymentStatus} /></div>
      {held && order.holdUntil && <p className="player-deadline">付款截止 {new Intl.DateTimeFormat("zh-CN", {
        timeZone: order.venue.timezone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
      }).format(new Date(order.holdUntil))}，到期未付将释放场地。</p>}
      <CourtCard venue={order.venue} lines={order.lines} order={order} />
      <section className="player-card player-check">
        {held ? <Amounts total={order.totalCents} wallet={pending?.walletCents ?? previousWallet ?? order.walletCents} simulated={simulated} /> :
          <div className="player-total"><span>订单金额</span><strong>{money(order.totalCents)}</strong></div>}
        {!held && simulated && !!order.payments.length && <p className="player-sim">本地模拟支付，不会产生真实扣款。</p>}
        {order.status === "CONFIRMED" && <p>到场后请到{order.venue.name}前台出示本订单。</p>}
        <p className="player-policy">{policy}</p>
        {inTime && !pending && <PayButton busy={command.busy || !!detail.error} onClick={() => void pay()}>{previous ? "核对原付款结果" : "确认并支付 " + money(order.totalCents)}</PayButton>}
        {inTime && pending?.provider === "MOCK" && simulated && <PayButton busy={command.busy || !!detail.error} onClick={() => void simulate(pending.id)}>完成模拟微信支付 {money(pending.externalCents)}</PayButton>}
        {inTime && pending && !(pending.provider === "MOCK" && simulated) && <p>正在等待付款结果，请刷新本订单查看。</p>}
        {held && <button className="player-text-button" disabled={command.busy || detail.busy} onClick={() => void detail.refresh()}>刷新付款状态</button>}
      </section>
      {message && <p role="status" className="player-notice">{message}</p>}
      <ErrorNotice error={customerError(command.error)} />
      <section className="player-card player-records"><h2>付款记录</h2>
        {!order.payments.length && <p>还没有付款记录。</p>}
        {order.payments.map(p => <div key={p.id}><strong>{label(p.status)}</strong>
          <span>{[p.walletCents ? "余额 " + money(p.walletCents) : "", p.externalCents ? (p.provider === "MOCK" ? "模拟微信 " : "微信 ") + money(p.externalCents) : ""].filter(Boolean).join(" ＋ ")}</span>
          <small>{dateTime(p.createdAt, order.venue.timezone)}</small></div>)}
      </section>
      {!!order.refunds.length && <section className="player-card player-records"><h2>退款记录</h2>{order.refunds.map(r =>
        <div key={r.id}><strong>{money(r.amountCents)} · {label(r.status)}</strong><span>退回余额 {money(r.walletCents)}，原支付渠道 {money(r.externalCents)}</span></div>)}</section>}
    </>}
  </>;
}
function MyBookings({ api }: { api: TennisApi }) {
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors.at(-1);
  const list = useLoad(() => api<{ orders: PlayerOrderItem[]; nextCursor: string | null }>("/player/orders" +
    (cursor ? "?cursor=" + encodeURIComponent(cursor) : "")), [api, cursor]);
  return <><h1>我的预订</h1><p className="player-intro">从订场对话打开已谈好的场次，即可确认付款。</p>
    <ErrorNotice error={customerError(list.error)} retry={() => void list.refresh()} />
    {!list.data && !list.error && <LoadingBlock label="正在读取我的预订" />}
    {list.data && <section className="player-card player-list">
      {!list.data.orders.length && <p>你还没有预订。</p>}
      {list.data.orders.map(order => <a key={order.id} href={orderUrl(order.id)}>
        <div><strong>{order.venueName} · {order.courtName}{order.lineCount > 1 ? " 等 " + order.lineCount + " 个时段" : ""}</strong>
          <small>{when(order, order.timezone)}</small></div>
        <div><span>{label(order.status)}</span><b>{money(order.totalCents)}</b></div><ChevronRight size={16} aria-hidden="true" />
      </a>)}
    </section>}
    {(cursors.length > 0 || list.data?.nextCursor) && <div className="player-pager">
      {cursors.length > 0 && <button className="button button-secondary" onClick={() => setCursors(c => c.slice(0, -1))}>上一页</button>}
      {list.data?.nextCursor && <button className="button button-secondary" onClick={() => setCursors([...cursors, list.data!.nextCursor!])}>下一页</button>}</div>}
  </>;
}
export function PlayerCheckout({ session, onSession, onLogout }: { session: Session; onSession: (session: Session) => void; onLogout: () => void }) {
  const api = useMemo(() => createApi(session), [session]);
  const [search, setSearch] = useState(location.search);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState<unknown>();
  const [switching, setSwitching] = useState(false);
  const entry = useMemo(() => parsePlayerEntry(search), [search]);
  const club = session.tenants.find(t => t.id === session.tenantId && t.kind === "customer");
  const own = session.kind === "customer" && session.contextValid !== false && !!session.customerId;
  const scope = `player:${session.subjectId}:${session.tenantId}:${session.customerId}`;
  useEffect(() => {
    const update = () => { setSearch(location.search); setNotice(""); };
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);
  function openOrder(id: string, msg = "") {
    const next = orderUrl(id); window.history.replaceState(null, "", next); setNotice(msg); setSearch(next);
  }
  async function change(action: () => Promise<void>) {
    setSwitching(true); setError(undefined);
    try { await action(); } catch (next) { setError(next); } finally { setSwitching(false); }
  }
  const contexts = session.tenants.filter(t => t.kind === "customer");
  return <div className="player-app"><header className="player-top"><div>
    <a href={mineUrl} className="player-brand"><span className="player-mark" aria-hidden="true"><CalendarDays size={21} /></span>{club?.name ?? "网球预订"}</a>
    <nav aria-label="球友导航">{own && entry.kind !== "mine" && <a href={mineUrl}><ClipboardList size={16} />我的预订</a>}
      <button aria-label="退出登录" title="退出登录" disabled={switching} onClick={() => void change(async () => { await api("/auth/logout", "POST"); onLogout(); })}><LogOut size={17} /></button></nav>
  </div></header><main className="player-main">
    <ErrorNotice error={customerError(error)} />
    {(!own || contexts.length > 1) && contexts.length > 0 && <label className="player-context">预订账号
      <select disabled={switching} value={own ? session.tenantId ?? "" : ""} onChange={e => { const tenantId = e.target.value; void change(async () =>
        onSession(await api<Session>("/session/context", "POST", { kind: "customer", tenantId }))); }}>
        <option value="" disabled>选择球友身份</option>{contexts.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select></label>}
    {!own ? <><h1>使用球友账号查看预订</h1><p>请切换到收到链接的球友账号。</p></> :
      entry.kind === "invalid" ? <><h1>预订链接不完整</h1><p>请回到订场对话，重新打开完整链接。</p></> :
      entry.kind === "order" ? <PersonalOrder key={entry.id} api={api} id={entry.id} scope={scope} simulated={!!session.localSimulation} notice={notice} /> :
      "options" in entry ? <Offers key={search} api={api} entry={entry} accountScope={scope} simulated={!!session.localSimulation} openOrder={openOrder} /> :
      <MyBookings api={api} />}
    {own && entry.kind === "order" && <a className="player-back" href={mineUrl}><ArrowLeft size={15} />返回我的预订</a>}
  </main></div>;
}
