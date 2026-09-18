import { useEffect, useState } from "react";
import { ArrowUpRight, CreditCard, ReceiptText, Search, Sparkles } from "lucide-react";
import type { RefundGroupRecord } from "../../../../packages/db/src/tennis/refunds";
import type { TennisApi } from "./api";
import type {
  CourtRecord,
  OrderDetail,
  OrderRecord,
  PaymentRecord,
  RefundRecord,
  Session,
  VenueRecord,
  Wallet,
} from "./types";
import { AssistantPanel } from "./AssistantPanel";
import { OrderPagination, useOrderDirectory } from "./OrderDirectory";
import { AmendmentPanel } from "./AmendmentPanel";
import { permits } from "./types";
import {
  Badge,
  cents,
  clock,
  dateTime,
  EmptyState,
  ErrorNotice,
  LoadingBlock,
  Modal,
  money,
  PageHeading,
  Panel,
  RefreshButton,
  useCommand,
  useDraft,
  useLoad,
} from "./components";

export function OrdersPage({
  api,
  venue,
  scope,
  openOrder,
}: {
  api: TennisApi;
  venue: VenueRecord;
  scope: string;
  openOrder: (id: string) => void;
}) {
  const [filters, setFilters] = useDraft(`tennis:orders:${scope}`, { query: "", status: "ALL" });
  const [query, setQuery] = useState(filters.query);
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(filters.query), 250);
    return () => window.clearTimeout(timer);
  }, [filters.query]);
  const searching = query.trim() !== filters.query.trim();
  const orders = useOrderDirectory(api, venue.id, `orders:${scope}`, {
    q: query.trim(),
    status: filters.status === "ALL" ? undefined : filters.status,
  });
  return (
    <>
      <PageHeading title="预订订单" description="查看组合预订、付款与退款进度。">
        <RefreshButton onClick={() => void orders.refresh()} busy={orders.busy} />
      </PageHeading>
      <ErrorNotice error={orders.error} retry={() => void orders.refresh()} />
      <Panel>
        <div className="tennis-toolbar">
          <div className="tennis-search">
            <Search size={17} />
            <input
              aria-label="搜索订单或客户"
              placeholder="订单号 / 客户姓名"
              maxLength={200}
              value={filters.query}
              onChange={(e) => setFilters({ ...filters, query: e.target.value })}
            />
          </div>
          <select
            aria-label="订单状态"
            value={filters.status}
            onChange={(e) => setFilters({ ...filters, status: e.target.value })}
          >
            <option value="ALL">全部状态</option>
            <option value="HELD">待付款</option>
            <option value="CONFIRMED">已预订</option>
            <option value="CANCELLED">已取消</option>
            <option value="EXPIRED">已到期</option>
            <option value="COMPLETED">已完成</option>
          </select>
        </div>
        {searching || (!orders.data && orders.busy) ? (
          <LoadingBlock />
        ) : !orders.data ? null : !orders.data.orders.length ? (
          <EmptyState title="暂无符合条件的订单" detail="从场地排期选择球场和时间，即可建立第一笔预订。" />
        ) : (
          <div className="tennis-table-scroll">
            <table className="tennis-table">
              <thead>
                <tr>
                  <th>订单 / 客户</th>
                  <th>预订时段</th>
                  <th>明细</th>
                  <th>应付</th>
                  <th>订单状态</th>
                  <th>付款</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {orders.data.orders.map((order) => (
                  <tr key={order.id}>
                    <td>
                      <strong>{order.customerName ?? "客户预订"}</strong>
                      <small>{order.id.slice(0, 8)}</small>
                    </td>
                    <td>
                      {order.matchingLines.length
                        ? dateTime(order.matchingLines[0]?.startAt, venue.timezone)
                        : "无有效时段"}
                      {order.matchingLines.length > 1 && <small>含其他 {order.matchingLines.length - 1} 条时段</small>}
                    </td>
                    <td>{order.matchingLines.length} 条</td>
                    <td className="tennis-numeric">{money(order.totalCents)}</td>
                    <td>
                      <Badge value={order.status} />
                    </td>
                    <td>
                      <Badge value={order.paymentStatus} />
                    </td>
                    <td>
                      <button className="button button-secondary button-small" onClick={() => openOrder(order.id)}>
                        查看
                        <ArrowUpRight size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!searching && <OrderPagination directory={orders} />}
      </Panel>
    </>
  );
}
export function OrderDialog({
  api,
  session,
  venue,
  scope,
  orderId,
  onClose,
  onChanged,
}: {
  api: TennisApi;
  session: Session;
  venue: VenueRecord;
  scope: string;
  orderId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const detail = useLoad(() => api<OrderDetail>(`/orders/${orderId}`), [api, orderId]);
  const courts = useLoad(() => api<CourtRecord[]>(`/venues/${venue.id}/courts`), [api, venue.id]);
  const [action, setAction] = useState<"pay" | "cancel" | "refund" | "free" | null>(null);
  const [reason, setReason] = useState("");
  const [notice, setNotice] = useState("");
  const [assistantOpen, setAssistantOpen] = useState(false);
  const command = useCommand(scope);
  async function changed() {
    setAction(null);
    await detail.refresh();
    onChanged();
  }
  async function cancel() {
    if (!detail.data) return;
    const payload = { expectedRevision: detail.data.revision, reason };
    const result = await command.execute(`order.cancel:${orderId}`, payload, (key) =>
      api<OrderRecord>(`/orders/${orderId}/cancel`, "POST", { ...payload, commandKey: key }),
    );
    if (result) {
      setNotice("未付款预约已取消，相关球场已释放。");
      await changed();
    }
  }
  async function simulatePayment(payment: PaymentRecord, status: "SUCCEEDED" | "FAILED") {
    const result = await command.execute(`payment.simulate:${payment.id}:${status}`, { status }, (key) =>
      api<PaymentRecord>(`/payments/${payment.id}/simulate`, "POST", { status }),
    );
    if (result) {
      setNotice(
        status === "SUCCEEDED"
          ? "本地模拟付款已处理。请核对订单与收款状态。"
          : "本地模拟失败已处理，预留余额按系统结果释放。",
      );
      await changed();
    }
  }
  async function retryRefund(refund: RefundRecord) {
    const result = await command.execute(`refund.retry:${refund.id}`, {}, (key) =>
      api<RefundRecord>(`/refunds/${refund.id}/retry`, "POST", { commandKey: key }),
    );
    if (result) {
      setNotice("已重新发起原退款，请等待渠道回执。");
      await changed();
    }
  }
  async function simulateRefund(refund: RefundRecord, status: "SUCCEEDED" | "FAILED") {
    const result = await command.execute(`refund.simulate:${refund.id}:${status}`, { status }, (key) =>
      api<RefundRecord>(`/refunds/${refund.id}/simulate`, "POST", { status }),
    );
    if (result) {
      setNotice("本地模拟退款回执已处理。");
      await changed();
    }
  }
  const order = detail.data;
  const canBook = session.kind === "customer" || permits(session, "book");
  return (
    <>
      <Modal title={`预订详情 · ${orderId.slice(0, 8)}`} size="wide" onClose={onClose} closeDisabled={command.busy}>
        <ErrorNotice error={detail.error ?? command.error} retry={() => void detail.refresh()} />
        {notice && (
          <div className="tennis-success" role="status">
            {notice}
          </div>
        )}
        {!order ? (
          <LoadingBlock />
        ) : (
          <div className="tennis-order-detail">
            <div className="tennis-detail-top">
              <div>
                <p className="eyebrow">{venue.name}</p>
                <h2>{order.customerName ?? "场地预订"}</h2>
                <p className="tennis-muted">创建于 {dateTime(order.createdAt, venue.timezone)}</p>
              </div>
              <div className="tennis-badges">
                <Badge value={order.status} />
                <Badge value={order.paymentStatus} />
              </div>
            </div>
            {order.holdUntil && (
              <div className="tennis-note">
                请在 {dateTime(order.holdUntil, venue.timezone)} 前完成付款；逾期自动释放。
                {order.holdReason && <p>保留原因：{order.holdReason}</p>}
              </div>
            )}
            <div className="tennis-table-scroll">
              <table className="tennis-table">
                <thead>
                  <tr>
                    <th>球场</th>
                    <th>实际预订时段</th>
                    <th>费用</th>
                    <th>状态</th>
                  </tr>
                </thead>
                <tbody>
                  {order.lines.map((line) => (
                    <tr key={line.id}>
                      <td>{courts.data?.find((c) => c.id === line.courtId)?.name ?? "球场"}</td>
                      <td>
                        {dateTime(line.startAt, venue.timezone)}–{clock(line.endAt, venue.timezone)}
                        <details>
                          <summary>查看费用依据</summary>
                          {line.price.segments.map((segment, i) => (
                            <p className="tennis-muted" key={i}>
                              {clock(segment.startAt, venue.timezone)}–{clock(segment.endAt, venue.timezone)} ·{" "}
                              {money(segment.hourlyPriceCents)}/时
                              {segment.discountBps !== 10000 ? ` × ${segment.discountBps / 1000}折` : ""} ·{" "}
                              {money(segment.amountCents)}
                            </p>
                          ))}
                        </details>
                      </td>
                      <td className="tennis-numeric">{money(line.amountCents)}</td>
                      <td>{line.cancelledAt ? "已取消" : "有效"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="tennis-money-row tennis-total">
              <span>订单价格合计</span>
              <strong>{money(order.totalCents)}</strong>
            </div>
            <div className="tennis-actions">
              {canBook && (
                <button type="button" className="button button-secondary" onClick={() => setAssistantOpen(true)}>
                  <Sparkles size={16} />
                  询问此订单
                </button>
              )}
              {canBook &&
                order.status === "HELD" &&
                order.paymentStatus === "UNPAID" &&
                !order.payments?.some((p) => p.status === "PENDING") && (
                  <button className="button button-primary" onClick={() => setAction("pay")}>
                    <CreditCard size={16} />
                    办理付款
                  </button>
                )}
              {canBook && order.status === "HELD" && (
                <button className="button button-secondary" onClick={() => setAction("cancel")}>
                  取消未付款预约
                </button>
              )}
              {permits(session, "refund") &&
                ["PAID", "PARTIALLY_REFUNDED", "REFUNDED"].includes(order.paymentStatus) && (
                  <button className="button button-secondary" onClick={() => setAction("refund")}>
                    按明细退款 / 取消
                  </button>
                )}
              {permits(session, "book") && order.totalCents === 0 && order.status === "CONFIRMED" && (
                <button className="button button-secondary" onClick={() => setAction("free")}>
                  取消免费时段
                </button>
              )}
              <RefreshButton busy={detail.busy} onClick={() => void detail.refresh()} />
            </div>
            {action === "cancel" && (
              <Panel title="取消未付款预约">
                <div className="tennis-form">
                  <label>
                    取消原因
                    <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} />
                  </label>
                  <p className="tennis-muted">整单未付款预约将释放全部时段。已经有付款事实的订单须办理退款。</p>
                  <div className="tennis-actions">
                    <button className="button button-secondary" onClick={() => setAction(null)}>
                      返回
                    </button>
                    <button
                      className="button button-danger"
                      disabled={!reason.trim() || command.busy}
                      onClick={() => void cancel()}
                    >
                      确认取消预约
                    </button>
                  </div>
                </div>
              </Panel>
            )}
            {action === "pay" && (
              <PaymentForm
                api={api}
                session={session}
                scope={scope}
                order={order}
                onDone={(payment) => {
                  setNotice(
                    payment.status === "SUCCEEDED"
                      ? "付款成功，订单已确认。"
                      : "付款单已建立，等待渠道回执。余额部分已预留。",
                  );
                  void changed();
                }}
                onClose={() => setAction(null)}
              />
            )}
            {action === "refund" && (
              <RefundForm
                api={api}
                scope={scope}
                venue={venue}
                courts={courts.data ?? []}
                order={order}
                onDone={(refund) => {
                  setNotice(
                    refund.status === "SUCCEEDED" ? "退款已按原支付来源退回。" : "退款已登记，正在等待渠道回执。",
                  );
                  void changed();
                }}
                onClose={() => setAction(null)}
              />
            )}
            {action === "free" && (
              <FreeCancelForm
                api={api}
                scope={scope}
                venue={venue}
                order={order}
                courts={courts.data ?? []}
                onClose={() => setAction(null)}
                onDone={() => {
                  setNotice("所选免费时段已取消，场地已释放。");
                  void changed();
                }}
              />
            )}
            <AmendmentPanel
              api={api}
              session={session}
              venue={venue}
              scope={scope}
              order={order}
              courts={courts.data ?? []}
              onChanged={() => {
                void detail.refresh();
                onChanged();
              }}
            />
            <section>
              <h3 className="tennis-section-title">
                <ReceiptText size={17} />
                付款记录
              </h3>
              {order.payments?.length ? (
                order.payments.map((payment) => (
                  <div className="tennis-ledger-row" key={payment.id}>
                    <div>
                      <strong>
                        余额 {money(payment.walletCents)} ＋ {payment.provider === "MOCK" ? "模拟微信" : "微信"}{" "}
                        {money(payment.externalCents)}
                      </strong>
                      <span>
                        {dateTime(payment.createdAt, venue.timezone)} ·{" "}
                        {payment.provider === "MOCK"
                          ? "本地模拟，未发生真实扣费"
                          : payment.provider === "WALLET"
                            ? "会员余额"
                            : "微信支付"}
                      </span>
                    </div>
                    <Badge value={payment.status} />
                    {session.localSimulation &&
                      canBook &&
                      payment.provider === "MOCK" &&
                      payment.status === "PENDING" && (
                        <div className="tennis-actions">
                          <button
                            className="button button-secondary button-small"
                            disabled={command.busy}
                            onClick={() => void simulatePayment(payment, "SUCCEEDED")}
                          >
                            模拟支付成功
                          </button>
                          <button
                            className="button button-secondary button-small"
                            disabled={command.busy}
                            onClick={() => void simulatePayment(payment, "FAILED")}
                          >
                            模拟失败
                          </button>
                        </div>
                      )}
                  </div>
                ))
              ) : (
                <p className="tennis-muted">还没有付款记录。</p>
              )}
            </section>
            <section>
              <h3 className="tennis-section-title">退款记录</h3>
              {order.refunds?.length ? (
                order.refunds.map((refund) => (
                  <div className="tennis-ledger-row" key={refund.id}>
                    <div>
                      <strong>
                        {money(refund.amountCents)} · 余额 {money(refund.walletCents)} / 原支付渠道{" "}
                        {money(refund.externalCents)}
                      </strong>
                      <span>
                        {refund.reason} · {dateTime(refund.createdAt, venue.timezone)}
                      </span>
                    </div>
                    <Badge value={refund.status} />
                    {permits(session, "refund") && refund.status === "FAILED" && (
                      <button
                        className="button button-secondary button-small"
                        disabled={command.busy}
                        onClick={() => void retryRefund(refund)}
                      >
                        重试原退款
                      </button>
                    )}
                    {session.localSimulation &&
                      permits(session, "refund") &&
                      ["REQUESTED", "PROCESSING"].includes(refund.status) &&
                      refund.externalCents > 0 && (
                        <div className="tennis-actions">
                          <button
                            className="button button-secondary button-small"
                            disabled={command.busy}
                            onClick={() => void simulateRefund(refund, "SUCCEEDED")}
                          >
                            模拟退款成功
                          </button>
                          <button
                            className="button button-secondary button-small"
                            disabled={command.busy}
                            onClick={() => void simulateRefund(refund, "FAILED")}
                          >
                            模拟失败
                          </button>
                        </div>
                      )}
                  </div>
                ))
              ) : (
                <p className="tennis-muted">还没有退款记录。</p>
              )}
            </section>
          </div>
        )}
      </Modal>
      {assistantOpen && canBook && (
        <AssistantPanel
          key={`${scope}:${session.contextVersion}:order:${orderId}`}
          api={api}
          session={session}
          venue={venue}
          scope={scope}
          context={{ page: "orders", orderId }}
          onClose={() => setAssistantOpen(false)}
        />
      )}
    </>
  );
}
export function PaymentForm({
  api,
  session,
  scope,
  order,
  onDone,
  onClose,
  amendmentId,
  amountCents,
}: {
  api: TennisApi;
  session: Session;
  scope: string;
  order: OrderRecord;
  amendmentId?: string;
  amountCents?: number;
  onDone: (payment: PaymentRecord) => void;
  onClose: () => void;
}) {
  const payable = amountCents ?? order.totalCents;
  const canWallet = session.kind === "customer" || permits(session, "manage_members");
  const wallet = useLoad(
    () => (canWallet ? api<Wallet>(`/customers/${order.customerId}/wallet`) : Promise.resolve(null)),
    [api, order.customerId, canWallet],
  );
  const [draft, setDraft] = useDraft(`tennis:pay:${scope}:${amendmentId ?? order.id}`, {
    walletAmount: "0",
    reason: "",
  });
  const command = useCommand(scope);
  const walletCents = /^\d+(\.\d{1,2})?$/.test(draft.walletAmount) ? Math.round(Number(draft.walletAmount) * 100) : NaN;
  const max = Math.min(payable, wallet.data?.balance.availableCents ?? 0);
  async function pay() {
    const payload = {
      walletCents: cents(draft.walletAmount),
      ...(session.kind === "staff" && walletCents > 0 ? { staffReason: draft.reason } : {}),
    };
    const result = await command.execute(
      `${amendmentId ? "amendment" : "order"}.payment:${amendmentId ?? order.id}`,
      payload,
      (key) =>
        api<PaymentRecord>(
          amendmentId ? `/amendments/${amendmentId}/payments` : `/orders/${order.id}/payments`,
          "POST",
          { ...payload, commandKey: key },
        ),
    );
    if (result) onDone(result);
  }
  return (
    <Panel title="核对付款">
      <div className="tennis-form">
        <ErrorNotice error={command.error ?? wallet.error} />
        <div className="tennis-money-row">
          <span>整单应付</span>
          <strong>{money(payable)}</strong>
        </div>
        {canWallet && (
          <>
            <p className="tennis-muted">
              可用余额 {money(wallet.data?.balance.availableCents)} · 预留中 {money(wallet.data?.balance.reservedCents)}
            </p>
            <label>
              使用余额（元）
              <div className="tennis-input-action">
                <input
                  type="number"
                  min="0"
                  max={max / 100}
                  step="0.01"
                  value={draft.walletAmount}
                  onChange={(e) => setDraft({ ...draft, walletAmount: e.target.value })}
                  disabled={command.busy}
                />
                <button
                  className="button button-secondary"
                  onClick={() => setDraft({ ...draft, walletAmount: (max / 100).toFixed(2) })}
                  disabled={!wallet.data || command.busy}
                >
                  尽量使用余额
                </button>
              </div>
            </label>
            {session.kind === "staff" && walletCents > 0 && (
              <label>
                代扣授权 / 办理原因
                <textarea
                  value={draft.reason}
                  onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
                  placeholder="填写客户授权使用余额的原因"
                  maxLength={2000}
                />
              </label>
            )}
          </>
        )}
        <div className="tennis-money-row tennis-total">
          <span>{session.localSimulation ? "模拟微信补差" : "微信补差"}</span>
          <strong>{money(Number.isFinite(walletCents) ? Math.max(0, payable - walletCents) : payable)}</strong>
        </div>
        <p className="tennis-note">
          余额不允许透支。余额与微信补差作为同一笔付款处理；渠道成功回执后才确认收款。
          {session.localSimulation ? "当前为本地演示，不会真实扣费。" : ""}
        </p>
        <div className="tennis-actions">
          <button className="button button-secondary" disabled={command.busy} onClick={onClose}>
            返回
          </button>
          <button
            className="button button-primary"
            disabled={
              command.busy ||
              !Number.isFinite(walletCents) ||
              walletCents < 0 ||
              walletCents > max ||
              (session.kind === "staff" && walletCents > 0 && !draft.reason.trim())
            }
            onClick={() => void pay()}
          >
            {command.busy ? "正在办理…" : "确认付款方案"}
          </button>
        </div>
      </div>
    </Panel>
  );
}
function RefundForm({
  api,
  scope,
  venue,
  courts,
  order,
  onDone,
  onClose,
}: {
  api: TennisApi;
  scope: string;
  venue: VenueRecord;
  courts: CourtRecord[];
  order: OrderDetail;
  onDone: (refund: RefundGroupRecord) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useDraft(`tennis:refund:${scope}:${order.id}`, {
    reason: "",
    lines: order.lines.map((line) => ({
      lineId: line.id,
      selected: false,
      amount: "0.00",
      cancel: order.paymentStatus === "REFUNDED",
    })),
  });
  const command = useCommand(scope);
  async function refund() {
    try {
      const payload = {
        expectedRevision: order.revision,
        reason: draft.reason,
        lines: draft.lines
          .filter((l) => l.selected)
          .map((l) => ({
            lineId: l.lineId,
            refundCents: cents(l.amount),
            cancel: order.paymentStatus === "REFUNDED" ? true : l.cancel,
          })),
      };
      const result = await command.execute(`order.refund:${order.id}`, payload, (key) =>
        api<RefundGroupRecord>(`/orders/${order.id}/refunds`, "POST", { ...payload, commandKey: key }),
      );
      if (result) {
        setDraft((current) => ({
          ...current,
          reason: "",
          lines: current.lines.map((line) => ({ ...line, selected: false, amount: "0.00", cancel: false })),
        }));
        onDone(result);
      }
    } catch (next) {
      command.setError(next);
    }
  }
  return (
    <Panel title="按明细确认退款">
      <div className="tennis-form">
        <ErrorNotice error={command.error} />
        <p className="tennis-note">
          请由授权员工确认退款金额和原因。余额按原本金 / 赠送构成恢复，微信部分退回原支付来源。
        </p>
        {draft.lines.map((line, i) => {
          const original = order.lines.find((l) => l.id === line.lineId);
          if (!original) return null;
          const update = (patch: Partial<typeof line>) =>
            setDraft({ ...draft, lines: draft.lines.map((l, index) => (index === i ? { ...l, ...patch } : l)) });
          return (
            <div className="tennis-refund-line" key={line.lineId}>
              <label className="tennis-check">
                <input
                  type="checkbox"
                  checked={line.selected}
                  disabled={Boolean(original.cancelledAt) && (original.remainingRefundCents ?? 0) === 0}
                  onChange={(e) => update({ selected: e.target.checked })}
                />
                {courts.find((c) => c.id === original.courtId)?.name ?? "球场"} ·{" "}
                {dateTime(original.startAt, venue.timezone)}–{clock(original.endAt, venue.timezone)} · 剩余可退{" "}
                {money(original.remainingRefundCents)}
              </label>
              {line.selected && (
                <div className="tennis-two">
                  <label>
                    本次退款（元）
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      max={(original.remainingRefundCents ?? 0) / 100}
                      value={line.amount}
                      onChange={(e) => update({ amount: e.target.value })}
                    />
                  </label>
                  <label className="tennis-check">
                    <input
                      type="checkbox"
                      checked={order.paymentStatus === "REFUNDED" || line.cancel}
                      disabled={Boolean(original.cancelledAt) || order.paymentStatus === "REFUNDED"}
                      onChange={(e) => update({ cancel: e.target.checked })}
                    />
                    同时取消该时段
                  </label>
                </div>
              )}
            </div>
          );
        })}
        <label>
          退款原因
          <textarea
            value={draft.reason}
            onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
            maxLength={2000}
          />
        </label>
        <p className="tennis-muted">默认金额为 0，请按双方确认的金额填写；系统会核对剩余可退额度。</p>
        <div className="tennis-actions">
          <button className="button button-secondary" disabled={command.busy} onClick={onClose}>
            返回
          </button>
          <button
            className="button button-danger"
            disabled={command.busy || !draft.reason.trim() || !draft.lines.some((l) => l.selected)}
            onClick={() => void refund()}
          >
            {command.busy ? "正在办理…" : "确认退款与取消明细"}
          </button>
        </div>
      </div>
    </Panel>
  );
}
function FreeCancelForm({
  api,
  scope,
  venue,
  order,
  courts,
  onClose,
  onDone,
}: {
  api: TennisApi;
  scope: string;
  venue: VenueRecord;
  order: OrderRecord;
  courts: CourtRecord[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [draft, setDraft] = useDraft(`tennis:free-cancel:${scope}:${order.id}`, {
    lineIds: [] as string[],
    reason: "",
  });
  const command = useCommand(scope);
  async function submit() {
    const payload = { expectedRevision: order.revision, lineIds: draft.lineIds, reason: draft.reason };
    const result = await command.execute(`order.cancel-free:${order.id}`, payload, (key) =>
      api<OrderRecord>(`/orders/${order.id}/cancel-free-lines`, "POST", { ...payload, commandKey: key }),
    );
    if (result) {
      setDraft({ lineIds: [], reason: "" });
      onDone();
    }
  }
  return (
    <Panel title="取消免费预约明细">
      <div className="tennis-form">
        <ErrorNotice error={command.error} />
        {order.lines
          .filter((line) => !line.cancelledAt)
          .map((line) => (
            <label className="tennis-check" key={line.id}>
              <input
                type="checkbox"
                checked={draft.lineIds.includes(line.id)}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    lineIds: e.target.checked
                      ? [...draft.lineIds, line.id]
                      : draft.lineIds.filter((id) => id !== line.id),
                  })
                }
              />
              {courts.find((c) => c.id === line.courtId)?.name ?? "球场"} · {dateTime(line.startAt, venue.timezone)}–
              {clock(line.endAt, venue.timezone)}
            </label>
          ))}
        <label>
          取消原因
          <textarea
            value={draft.reason}
            onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
            maxLength={2000}
          />
        </label>
        <p className="tennis-muted">只释放所选免费时段；此操作不产生收付款记录。</p>
        <div className="tennis-actions">
          <button className="button button-secondary" disabled={command.busy} onClick={onClose}>
            返回
          </button>
          <button
            className="button button-danger"
            disabled={command.busy || !draft.lineIds.length || !draft.reason.trim()}
            onClick={() => void submit()}
          >
            确认取消所选时段
          </button>
        </div>
      </div>
    </Panel>
  );
}
