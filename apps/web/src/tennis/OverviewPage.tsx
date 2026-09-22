import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { ArrowRight, CalendarDays, Clock3, ListChecks, ReceiptText, RotateCcw, Wallet } from "lucide-react";
import type { TennisApi } from "./api";
import { permits, type Session, type VenueRecord } from "./types";
import { Badge, clock, dateTime, dateValue, EmptyState, ErrorNotice, LoadingBlock, money, PageHeading, Panel, RefreshButton, useDraft, useLoad } from "./components";
import { OrderPagination, useOrderDirectory } from "./OrderDirectory";
import { FinancePanel, type FinanceData } from "./FinancePanel";
import { InfoHint } from "./InfoHint";
import { WecomReconciliationPanel } from "./WecomReconciliationPanel";
import "./overview.css";

type OverviewTab = "workbench" | "history" | "reconciliation" | "attention";
const tabDefinitions = [
  { id: "workbench", label: "工作台", icon: CalendarDays },
  { id: "history", label: "收款历史", icon: ReceiptText },
  { id: "reconciliation", label: "收款核对", icon: ListChecks },
  { id: "attention", label: "退款与异常", icon: RotateCcw },
] as const;

export function OverviewPage({ api, session, venue, scope, openOrder }: {
  api: TennisApi; session: Session; venue: VenueRecord; scope: string; openOrder: (id: string) => void;
}) {
  const canFinance = permits(session, "manage_members");
  const canReconcile = canFinance && session.kind === "staff" && session.tenants.some(
    (tenant) => tenant.id === session.tenantId && tenant.kind === "staff" && tenant.role === "ADMIN",
  );
  const tabs = tabDefinitions.filter((tab) => tab.id === "workbench" || (tab.id === "reconciliation" ? canReconcile : canFinance));
  const [savedTab, setTab] = useDraft<OverviewTab>(`tennis:overview-tab:${scope}`, "workbench");
  const tab = tabs.some((item) => item.id === savedTab) ? savedTab : "workbench";
  const [today, setToday] = useState(() => dateValue(new Date(), venue.timezone));
  useEffect(() => {
    const update = () => setToday(dateValue(new Date(), venue.timezone));
    const timer = window.setInterval(update, 60_000);
    return () => window.clearInterval(timer);
  }, [venue.timezone]);
  const [historyDate, setHistoryDate] = useDraft(`tennis:overview-date:${scope}`, today);
  const [savedFilter, setOrderFilter] = useDraft(`tennis:overview-orders:${scope}`, "ACTIVE");
  const orderFilter = ["ACTIVE", "HELD", "CONFIRMED"].includes(savedFilter) ? savedFilter : "ACTIVE";
  const orders = useOrderDirectory(api, venue.id, `today:${scope}`, { date: today, status: orderFilter });
  const financeDate = tab === "history" ? historyDate : today;
  const finance = useLoad(() => canFinance
    ? api<FinanceData>(`/venues/${venue.id}/finance?date=${encodeURIComponent(financeDate)}`)
    : Promise.resolve(undefined), [api, canFinance, venue.id, financeDate]);
  const [pendingReconciliation, setPendingReconciliation] = useState(false);
  const id = useId();
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const attentionCount = finance.data ? finance.data.pendingRefunds.length + finance.data.exceptions.length : undefined;
  async function refresh() { await Promise.all([orders.refresh(), finance.refresh()]); }
  function tabKeys(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else return;
    event.preventDefault();
    setTab(tabs[next]!.id);
    tabRefs.current[next]?.focus();
  }
  return <div className="tennis-overview">
    <PageHeading title="经营概览" description={`${venue.name} · ${today}`}>
      {tab === "workbench" && <RefreshButton busy={orders.busy || finance.busy} onClick={() => void refresh()} />}
    </PageHeading>
    <div className="tennis-overview-tabs" role="tablist" aria-label="经营概览栏目">
      {tabs.map((item, index) => <button key={item.id} type="button" role="tab"
        id={`${id}-${item.id}-tab`} aria-controls={`${id}-${item.id}-panel`} aria-selected={tab === item.id}
        tabIndex={tab === item.id ? 0 : -1} ref={(element) => { tabRefs.current[index] = element; }}
        onKeyDown={(event) => tabKeys(event, index)} onClick={() => setTab(item.id)}>
        <item.icon size={17} aria-hidden="true" /><span>{item.label}</span>
        {item.id === "attention" && attentionCount !== undefined && attentionCount > 0 && <span className="tennis-overview-count">{attentionCount}</span>}
        {item.id === "reconciliation" && pendingReconciliation && <span className="tennis-overview-count">待核对</span>}
      </button>)}
    </div>
    {pendingReconciliation && tab !== "reconciliation" && <div className="tennis-note is-warning tennis-overview-pending" role="status">
      <span>有一笔收款提交结果尚未确认。</span>
      <button className="button button-secondary button-small" onClick={() => setTab("reconciliation")}>核对上次提交</button>
    </div>}
    {canFinance && session.localSimulation && tab !== "reconciliation" && <p className="tennis-overview-simulation">本地模拟资金记录，不代表真实到账或退款。</p>}
    <section role="tabpanel" id={`${id}-workbench-panel`} aria-labelledby={`${id}-workbench-tab`} hidden={tab !== "workbench"} tabIndex={0}>
      {canFinance && <>
        <ErrorNotice error={finance.error} retry={() => void finance.refresh()} />
        {Boolean(finance.error) && finance.data && <p role="status" className="tennis-muted">资金数据刷新失败，以下为上次结果。</p>}
        <div className="tennis-overview-metrics" aria-label="今日资金摘要" aria-busy={finance.busy}>
          <div><span><ReceiptText size={16} aria-hidden="true" />今日入账收款 <InfoHint label="今日收款口径">含订单实收和充值；余额消费、赠送及未确认归属的收款不重复计入。</InfoHint></span><strong>{finance.data ? money(finance.data.totals.cashInCents) : "—"}</strong><small>含充值实收</small></div>
          <div><span><Wallet size={16} aria-hidden="true" />今日余额消费</span><strong>{finance.data ? money(finance.data.totals.walletConsumedCents) : "—"}</strong><small>会员使用储值余额</small></div>
          <div><span><RotateCcw size={16} aria-hidden="true" />今日现金退款</span><strong>{finance.data ? money(finance.data.totals.cashRefundCents) : "—"}</strong><small>已完成的原渠道退款</small></div>
          <div><span><Wallet size={16} aria-hidden="true" />今日余额退回</span><strong>{finance.data ? money(finance.data.totals.walletRefundCents) : "—"}</strong><small>已退回会员余额</small></div>
        </div>
      </>}
      <div className={`tennis-overview-workbench${canFinance ? "" : " is-single"}`}>
        <Panel title="今日预约" action={<span className="tennis-muted">{today}</span>}>
          <div className="tennis-overview-filters" aria-label="今日预约筛选">
            {[["ACTIVE", "全部预约"], ["HELD", "待付款"], ["CONFIRMED", "已确认"]].map(([value, label]) => <button key={value} type="button" aria-pressed={orderFilter === value} onClick={() => setOrderFilter(value!)}>{label}</button>)}
          </div>
          <ErrorNotice error={orders.error} retry={() => void orders.refresh()} />
          {Boolean(orders.error) && orders.data && <p className="tennis-muted" role="status">刷新失败，以下为上次预约结果。</p>}
          {!orders.data && orders.busy ? <LoadingBlock /> : orders.data && !orders.data.orders.length ? <EmptyState
            title={orderFilter === "HELD" ? "今天没有待付款预约" : orderFilter === "CONFIRMED" ? "今天暂无已确认预约" : "今天暂无有效预约"}
            detail={orderFilter === "ACTIVE" ? "确认的新预约会显示在这里。" : "可切换到全部预约查看其他记录。"} /> : orders.data && <div className="tennis-overview-appointments">
            {orders.data.orders.map((order) => <article className="tennis-overview-appointment" key={order.id}>
              <div className="tennis-overview-appointment-main">
                <div className="tennis-overview-appointment-heading"><strong>{order.customerName || "客户预订"}</strong><Badge value={order.status} /><Badge value={order.paymentStatus} /></div>
                <div className="tennis-overview-slots">{order.matchingLines.map((line) => {
                  const sameDay = dateValue(new Date(line.startAt), venue.timezone) === dateValue(new Date(line.endAt), venue.timezone);
                  const format = sameDay ? clock : dateTime;
                  return <span key={line.id}><CalendarDays size={14} aria-hidden="true" />{line.courtName}<span>{format(line.startAt, venue.timezone)}–{format(line.endAt, venue.timezone)}</span></span>;
                })}</div>
                {order.holdUntil && <p className="tennis-overview-deadline"><Clock3 size={14} aria-hidden="true" />付款截止 {dateTime(order.holdUntil, venue.timezone)}</p>}
              </div>
              <div className="tennis-overview-appointment-action"><span>整单应付 <strong>{money(order.totalCents)}</strong></span><button className="button button-secondary button-small" onClick={() => openOrder(order.id)}>办理订单<ArrowRight size={14} aria-hidden="true" /></button></div>
            </article>)}
          </div>}
          {orders.data && <div className="tennis-overview-pagination"><span className="tennis-muted">本页 {orders.data.orders.length} 笔预约</span><OrderPagination directory={orders} /></div>}
        </Panel>
        {canFinance && <aside className="tennis-overview-side">
          <Panel title="待处理事项" action={<span className="tennis-muted">全部日期</span>}>
            <p className="tennis-muted tennis-overview-side-intro">当前场馆需要跟进的款项</p>
            <button className="tennis-overview-task" onClick={() => setTab("attention")}><span><RotateCcw size={18} aria-hidden="true" /><span><strong>待处理退款</strong><small>查看进度与失败明细</small></span></span><span><b>{finance.data?.pendingRefunds.length ?? "—"}</b><ArrowRight size={16} aria-hidden="true" /></span></button>
            <button className="tennis-overview-task" onClick={() => setTab("attention")}><span><ListChecks size={18} aria-hidden="true" /><span><strong>实收异常</strong><small>核对多收、迟到付款</small></span></span><span><b>{finance.data?.exceptions.length ?? "—"}</b><ArrowRight size={16} aria-hidden="true" /></span></button>
            {attentionCount === 0 && !finance.error && <p className="tennis-overview-clear">当前没有待处理退款或实收异常</p>}
          </Panel>
          <Panel title="资金查询">
            <button className="tennis-overview-shortcut" onClick={() => setTab("history")}><ReceiptText size={18} aria-hidden="true" /><span><strong>查看收款历史</strong><small>按日期核对收款、余额与退款</small></span><ArrowRight size={16} aria-hidden="true" /></button>
            {canReconcile && <button className="tennis-overview-shortcut" onClick={() => setTab("reconciliation")}><ListChecks size={18} aria-hidden="true" /><span><strong>核对渠道收款</strong><small>确认未匹配流水的归属</small></span><ArrowRight size={16} aria-hidden="true" /></button>}
          </Panel>
        </aside>}
      </div>
    </section>
    {canFinance && (["history", "attention"] as const).map((view) => <section key={view} role="tabpanel" id={`${id}-${view}-panel`} aria-labelledby={`${id}-${view}-tab`} hidden={tab !== view} tabIndex={0}>
      {tab === view && <FinancePanel api={api} session={session} venue={venue} openOrder={openOrder}
        view={view} date={historyDate} onDateChange={setHistoryDate} data={finance.data} busy={finance.busy} error={finance.error}
        onRefresh={finance.refresh} onChanged={orders.refresh} />}
    </section>)}
    {canReconcile && <section role="tabpanel" id={`${id}-reconciliation-panel`} aria-labelledby={`${id}-reconciliation-tab`} hidden={tab !== "reconciliation"} tabIndex={0}>
      <WecomReconciliationPanel api={api} session={session} venue={venue} openOrder={openOrder} onChanged={refresh}
        onPendingChange={setPendingReconciliation} onOpenExceptions={() => setTab("attention")} />
    </section>}
  </div>;
}
