import { InfoHint } from "./InfoHint";
import { useEffect, useState } from "react";
import type { TennisApi } from "./api";
import { CashExceptionDialog } from "./CashExceptionDialog";
import {
  Badge,
  dateTime,
  dateValue,
  EmptyState,
  ErrorNotice,
  LoadingBlock,
  money,
  Panel,
  RefreshButton,
  useDraft,
} from "./components";
import { permits, type Session, type VenueRecord } from "./types";

export interface FinanceData {
  date: string;
  totals: {
    cashInCents: number;
    cashRefundCents: number;
    walletConsumedCents: number;
    walletRefundCents: number;
    giftCents: number;
  };
  entries: {
    id: string;
    kind: string;
    cashCents: number;
    walletCents: number;
    giftCents: number;
    createdAt: string;
    referenceId: string;
  }[];
  pendingRefunds: { id: string; orderId: string; amountCents: number; status: string; reason: string }[];
  exceptions: { id: string; orderId: string | null; kind: string; status: string; details: Record<string, unknown> }[];
}
export interface FinanceProps {
  api: TennisApi;
  venue: VenueRecord;
  session: Session;
  openOrder: (id: string) => void;
  onChanged?: () => Promise<unknown>;
  view: "history" | "attention";
  date: string;
  onDateChange: (value: string) => void;
  data: FinanceData | undefined;
  busy: boolean;
  error: unknown;
  onRefresh: () => Promise<unknown>;
}
const entryNames: Record<string, string> = {
  OFFLINE_TOPUP: "线下充值实收",
  ONLINE_TOPUP: "线上充值实收",
  EXTRA_TOPUP_RECEIPT: "充值额外实收",
  ORDER_RECEIPT: "订单现金实收",
  WALLET_CONSUMPTION: "余额消费",
  REFUND: "已完成退款",
  EXCEPTION_REFUND: "异常实收原路退款",
};
const exceptionDescriptions: Record<string, { title: string; detail: string }> = {
  LATE_PAYMENT: { title: "未用于成交的实收", detail: "该笔付款未用于完成预订或改期，需核对退款。" },
  DUPLICATE_PAYMENT: { title: "订单额外实收", detail: "同一付款记录收到额外到账，需核对后处理。" },
  EXTRA_TOPUP_RECEIPT: { title: "充值额外实收", detail: "已收到额外充值款，未重复增加余额，需核对处理。" },
};
const orderEntryKinds = new Set(["ORDER_RECEIPT", "WALLET_CONSUMPTION", "REFUND"]);
const entryFilters = [
  { value: "all", label: "全部" },
  { value: "receipts", label: "收款" },
  { value: "wallet", label: "余额消费" },
  { value: "refunds", label: "退款" },
] as const;
type EntryFilter = (typeof entryFilters)[number]["value"];
const PAGE_SIZE = 20;
function amountClass(value: number) {
  return value > 0 ? "overview-amount-positive" : value < 0 ? "overview-amount-negative" : "";
}
function exceptionAmount(details: Record<string, unknown>): number | null {
  for (const value of [details.externalCents, details.amountCents]) {
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  }
  return null;
}

export function FinancePanel(props: FinanceProps) {
  if (!permits(props.session, "manage_members")) return null;
  return (
    <VenueFinance
      key={`${props.session.subjectId}:${props.session.kind}:${props.session.tenantId}:${props.session.contextVersion}:${props.venue.id}`}
      {...props}
    />
  );
}
function VenueFinance({
  api,
  venue,
  session,
  openOrder,
  onChanged,
  view,
  date,
  onDateChange,
  data,
  busy,
  error,
  onRefresh,
}: FinanceProps) {
  const scope = `${session.subjectId}:${session.kind}:${session.tenantId}:${session.customerId ?? "staff"}:${venue.id}`;
  const cacheScope = `${scope}:${session.contextVersion}`;
  const [exceptionId, setExceptionId] = useState<string | null>(null);
  const [filter, setFilter] = useDraft<EntryFilter>(`tennis:finance-filter:${cacheScope}`, "all");
  const [search, setSearch] = useDraft(`tennis:finance-search:${cacheScope}`, "");
  const filterKey = JSON.stringify([date, filter, search]);
  const [pagination, setPagination] = useDraft(`tennis:finance-page:${cacheScope}`, { key: filterKey, page: 1 });
  const searchText = search.trim().toLocaleLowerCase();
  const entries = (data?.entries ?? []).filter((entry) => {
    const matchesKind = filter === "all"
      || (filter === "receipts" && entry.cashCents > 0)
      || (filter === "wallet" && entry.kind === "WALLET_CONSUMPTION")
      || (filter === "refunds" && (entry.kind === "REFUND" || entry.kind === "EXCEPTION_REFUND"));
    return matchesKind && (!searchText || [entryNames[entry.kind] ?? "资金记录", entry.id, entry.referenceId]
      .some((value) => value.toLocaleLowerCase().includes(searchText)));
  });
  const pageCount = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
  const page = pagination.key === filterKey ? Math.min(pagination.page, pageCount) : 1;
  useEffect(() => {
    if (view !== "history" || data?.date !== date) return;
    setPagination((current) => {
      const nextPage = current.key === filterKey ? Math.min(current.page, pageCount) : 1;
      return current.key === filterKey && current.page === nextPage ? current : { key: filterKey, page: nextPage };
    });
  }, [filterKey, pageCount, view, data?.date, date]);
  const visibleEntries = entries.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  async function refreshBusiness() {
    await Promise.all([onRefresh(), onChanged?.()]);
  }
  return (
    <>
      {view === "history" ? <Panel
        title="收款历史"
        action={
          <div className="tennis-overview-toolbar">
            <label className="tennis-date-switch">
              日期
              <input
                type="date"
                value={date}
                onChange={(event) => {
                  if (event.target.value) onDateChange(event.target.value);
                }}
              />
            </label>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => onDateChange(dateValue(new Date(), venue.timezone))}
            >
              今天
            </button>
            <RefreshButton onClick={() => void onRefresh()} busy={busy} />
          </div>
        }
      >
        <p className="tennis-muted">
          {venue.name} <InfoHint label="统计日期说明">按场馆所在时区（{venue.timezone}）统计当天的收款和余额变动。</InfoHint>
        </p>
        <ErrorNotice error={error} retry={() => void onRefresh()} />
        {Boolean(error) && data && (
          <p className="tennis-muted" role="status">
            刷新失败，以下为上次结果。
          </p>
        )}
        {busy && data && <p className="tennis-muted" role="status">正在刷新收款记录…</p>}
        {!data && busy ? (
          <LoadingBlock />
        ) : data ? (
          <>
            <div className="tennis-finance-summary">
              <div>
                <span>入账收款 <InfoHint label="收款统计说明">包含订单收款、充值和已确认归属的额外到账。待核对的企微收款暂不计入，余额消费与充值赠送也不计入。</InfoHint></span>
                <strong className="tennis-numeric overview-amount-positive">{money(data.totals.cashInCents)}</strong>
              </div>
              <div>
                <span>现金退款 <InfoHint label="退款统计说明">只统计已经退回的款项，正在处理或失败的退款请看“退款与异常”。</InfoHint></span>
                <strong className="tennis-numeric overview-amount-negative">{money(data.totals.cashRefundCents)}</strong>
              </div>
              <div>
                <span>余额消费</span>
                <strong className="tennis-numeric">{money(data.totals.walletConsumedCents)}</strong>
              </div>
              <div>
                <span>余额退回</span>
                <strong className="tennis-numeric">{money(data.totals.walletRefundCents)}</strong>
              </div>
              <div>
                <span>充值赠送</span>
                <strong className="tennis-numeric">{money(data.totals.giftCents)}</strong>
              </div>
            </div>
            <div className="tennis-overview-toolbar">
              <div className="tennis-overview-filters" role="group" aria-label="资金流水分类">
                {entryFilters.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    className={`button button-small ${filter === item.value ? "button-primary" : "button-secondary"}`}
                    aria-pressed={filter === item.value}
                    onClick={() => setFilter(item.value)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              <label className="tennis-overview-search">
                <span className="sr-only">搜索资金流水</span>
                <input type="search" aria-label="搜索资金流水" placeholder="搜索事项、流水或关联记录号" value={search} onChange={(event) => setSearch(event.target.value)} />
              </label>
            </div>
            <p className="tennis-muted" role="status">
              {filter !== "all" || searchText ? `已筛选 ${entries.length} 条 / 当日共 ${data.entries.length} 条 · 上方金额为当日合计` : `当日共 ${data.entries.length} 条流水`}
            </p>
            {data.entries.length === 0 ? (
              <div className="tennis-overview-empty"><EmptyState title="当日暂无资金流水" detail="收款、余额消费和已完成退款会在这里列出。" /></div>
            ) : entries.length === 0 ? (
              <div className="tennis-overview-empty"><EmptyState title="没有符合条件的流水" detail="试试其他分类或搜索内容。" /></div>
            ) : (
              <div className="tennis-table-scroll">
                <table className="tennis-table tennis-overview-table">
                  <thead>
                    <tr>
                      <th scope="col">时间</th>
                      <th scope="col">事项</th>
                      <th scope="col">现金变动 <InfoHint label="现金变动说明">正数是收款，负数是退款。</InfoHint></th>
                      <th scope="col">余额消费 / 退回 <InfoHint label="余额变动说明">正数是消费扣款，负数是退款退回。余额消费已在充值时收过款，不再计作现金收入。</InfoHint></th>
                      <th scope="col">充值赠送</th>
                      <th scope="col">关联记录</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleEntries.map((entry) => (
                      <tr key={entry.id}>
                        <td>{dateTime(entry.createdAt, venue.timezone)}</td>
                        <td>
                          {entryNames[entry.kind] ?? "资金记录"}
                          <small title={entry.id}>流水 {entry.id.slice(0, 12)}</small>
                        </td>
                        <td className={`tennis-numeric ${amountClass(entry.cashCents)}`}>{money(entry.cashCents)}</td>
                        <td className="tennis-numeric">{money(entry.walletCents)}</td>
                        <td className="tennis-numeric">{money(entry.giftCents)}</td>
                        <td>
                          {entry.kind === "EXCEPTION_REFUND" ? (
                            <button
                              type="button"
                              className="button button-secondary button-small"
                              onClick={() => setExceptionId(entry.referenceId)}
                            >
                              查看退款核对
                            </button>
                          ) : orderEntryKinds.has(entry.kind) ? (
                            <button
                              type="button"
                              className="button button-secondary button-small"
                              onClick={() => openOrder(entry.referenceId)}
                            >
                              查看订单
                            </button>
                          ) : (
                            <small title={entry.referenceId}>充值 {entry.referenceId.slice(0, 12)}</small>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {entries.length > 0 && (
              <nav className="tennis-overview-toolbar tennis-overview-pagination" aria-label="资金流水分页">
                <span className="tennis-muted">第 {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, entries.length)} 条 · 第 {page} / {pageCount} 页</span>
                <div className="tennis-actions">
                  <button type="button" className="button button-secondary button-small" disabled={page <= 1} onClick={() => setPagination({ key: filterKey, page: page - 1 })}>上一页</button>
                  <button type="button" className="button button-secondary button-small" disabled={page >= pageCount} onClick={() => setPagination({ key: filterKey, page: page + 1 })}>下一页</button>
                </div>
              </nav>
            )}
          </>
        ) : !error ? (
          <p className="tennis-muted">尚未读取资金记录，请刷新。</p>
        ) : null}
      </Panel> : <>
        <div className="tennis-overview-toolbar">
          <p className="tennis-muted">全部日期 · 当前场馆</p>
          <RefreshButton onClick={() => void onRefresh()} busy={busy} />
        </div>
        <ErrorNotice error={error} retry={() => void onRefresh()} />
        {Boolean(error) && data && <p className="tennis-muted" role="status">刷新失败，以下为上次结果。</p>}
        {busy && data && <p className="tennis-muted" role="status">正在刷新待处理事项…</p>}
        {!data && busy ? <LoadingBlock /> : !data && !error ? <p className="tennis-muted">尚未读取待处理事项，请刷新。</p> : null}
        {data && <div className="tennis-overview-attention">
          <Panel title={`待退付款明细 · ${data.pendingRefunds.length} 项`} action={<InfoHint label="退款明细说明">一笔订单分多次付款时，退款也可能分为多笔。</InfoHint>}>
            <p className="tennis-muted">
              退款成功后会自动移出此列表。
            </p>
            {data.pendingRefunds.length === 0 ? (
              <div className="tennis-overview-empty"><EmptyState title="暂无待处理退款" detail="退款申请、处理中或失败的明细会在这里列出。" /></div>
            ) : (
              <div className="tennis-table-scroll">
                <table className="tennis-table tennis-overview-table">
                  <thead>
                    <tr>
                      <th scope="col">退款明细</th>
                      <th scope="col">金额</th>
                      <th scope="col">状态</th>
                      <th scope="col">原因</th>
                      <th scope="col">订单</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.pendingRefunds.map((refund) => (
                      <tr key={refund.id}>
                        <td title={refund.id}>{refund.id.slice(0, 12)}</td>
                        <td className="tennis-numeric overview-amount-negative">{money(refund.amountCents)}</td>
                        <td>
                          <Badge value={refund.status} />
                        </td>
                        <td>{refund.reason}</td>
                        <td>
                          <button
                            type="button"
                            className="button button-secondary button-small"
                            onClick={() => openOrder(refund.orderId)}
                          >
                            查看订单
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
          <Panel title={`实收待核对 · ${data.exceptions.length} 项`}>
            <p className="tennis-muted">
              待核对收款，退款到账后才算处理完成。
            </p>
            {data.exceptions.length === 0 ? (
              <div className="tennis-overview-empty"><EmptyState title="暂无实收异常" detail="迟到付款、重复到账等需要人工核对的款项会在这里列出。" /></div>
            ) : (
              <div className="tennis-table-scroll">
                <table className="tennis-table tennis-overview-table">
                  <thead>
                    <tr>
                      <th scope="col">事项</th>
                      <th scope="col">实收金额</th>
                      <th scope="col">核对说明</th>
                      <th scope="col">关联记录</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.exceptions.map((exception) => {
                      const description = exceptionDescriptions[exception.kind];
                      const amount = exceptionAmount(exception.details);
                      return (
                        <tr key={exception.id}>
                          <td>
                            {description?.title ?? "实收待核对"}
                            <small title={exception.id}>记录 {exception.id.slice(0, 12)}</small>
                          </td>
                          <td className="tennis-numeric">{amount == null ? "待核实" : money(amount)}</td>
                          <td>{description?.detail ?? "请按原付款记录核对款项及处理结果。"}</td>
                          <td>
                            <button
                              type="button"
                              className="button button-secondary button-small"
                              onClick={() => setExceptionId(exception.id)}
                            >
                              核对与退款
                            </button>
                            {exception.orderId ? (
                              <button
                                type="button"
                                className="button button-secondary button-small"
                                onClick={() => openOrder(exception.orderId!)}
                              >
                                查看订单
                              </button>
                            ) : (
                              <span className="tennis-muted">请核对原充值付款</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </div>}
      </>}
      {exceptionId && (
        <CashExceptionDialog
          api={api}
          session={session}
          venue={venue}
          scope={scope}
          exceptionId={exceptionId}
          onClose={() => setExceptionId(null)}
          onChanged={refreshBusiness}
          openOrder={(id) => {
            setExceptionId(null);
            openOrder(id);
          }}
        />
      )}
    </>
  );
}
