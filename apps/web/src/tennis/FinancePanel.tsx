import { useState } from "react";
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
  useLoad,
} from "./components";
import { permits, type Session, type VenueRecord } from "./types";

interface FinanceData {
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
interface FinanceProps {
  api: TennisApi;
  venue: VenueRecord;
  session: Session;
  openOrder: (id: string) => void;
}
const entryNames: Record<string, string> = {
  OFFLINE_TOPUP: "线下充值实收",
  ONLINE_TOPUP: "线上充值实收",
  EXTRA_TOPUP_RECEIPT: "充值额外实收",
  ORDER_RECEIPT: "订单外部实收",
  WALLET_CONSUMPTION: "储值消费",
  REFUND: "已完成退款",
  EXCEPTION_REFUND: "异常实收原路退款",
};
const exceptionDescriptions: Record<string, { title: string; detail: string }> = {
  LATE_PAYMENT: { title: "未用于成交的实收", detail: "该笔付款未用于完成预订或改期，需核对退款。" },
  DUPLICATE_PAYMENT: { title: "订单额外实收", detail: "同一付款记录收到额外到账，需核对后处理。" },
  EXTRA_TOPUP_RECEIPT: { title: "充值额外实收", detail: "已收到额外充值款，未重复增加余额，需核对处理。" },
};
const orderEntryKinds = new Set(["ORDER_RECEIPT", "WALLET_CONSUMPTION", "REFUND"]);
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
function VenueFinance({ api, venue, session, openOrder }: FinanceProps) {
  const [date, setDate] = useState(() => dateValue(new Date(), venue.timezone));
  const [exceptionId, setExceptionId] = useState<string | null>(null);
  const scope = `${session.subjectId}:${session.kind}:${session.tenantId}:${session.customerId ?? "staff"}:${venue.id}`;
  const finance = useLoad(
    () => api<FinanceData>(`/venues/${venue.id}/finance?date=${encodeURIComponent(date)}`),
    [api, venue.id, date],
  );
  const data = finance.data;
  return (
    <>
      <Panel
        title="资金核对"
        action={
          <div className="tennis-actions">
            <label className="tennis-date-switch">
              日期
              <input
                type="date"
                value={date}
                onChange={(event) => {
                  if (event.target.value) setDate(event.target.value);
                }}
              />
            </label>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => setDate(dateValue(new Date(), venue.timezone))}
            >
              今天
            </button>
            <RefreshButton onClick={() => void finance.refresh()} busy={finance.busy} />
          </div>
        }
      >
        <p className="tennis-muted">
          {venue.name} · 按场馆时区 {venue.timezone} 核对所选日期的收款和余额变动。
        </p>
        {session.localSimulation && (
          <p className="tennis-note is-warning">当前为本地模拟资金记录，不代表真实到账或退款。</p>
        )}
        <ErrorNotice error={finance.error} retry={() => void finance.refresh()} />
        {Boolean(finance.error) && data && (
          <p className="tennis-muted" role="status">
            刷新未完成，仍显示本次页面上次读取的结果。
          </p>
        )}
        {!data && finance.busy ? (
          <LoadingBlock />
        ) : data ? (
          <>
            <div className="tennis-stats">
              <div>
                <span>现金收款（含充值）</span>
                <strong>{money(data.totals.cashInCents)}</strong>
              </div>
              <div>
                <span>现金退款</span>
                <strong>{money(data.totals.cashRefundCents)}</strong>
              </div>
              <div>
                <span>余额消费</span>
                <strong>{money(data.totals.walletConsumedCents)}</strong>
              </div>
              <div>
                <span>余额退回</span>
                <strong>{money(data.totals.walletRefundCents)}</strong>
              </div>
              <div>
                <span>充值赠送</span>
                <strong>{money(data.totals.giftCents)}</strong>
              </div>
            </div>
            <p className="tennis-note">
              现金收款包含订单实收、充值及待核对的额外到账；余额消费单独统计，不再计入现金收入。充值赠送不属于现金收款。退款完成后才计入退款汇总。
            </p>
            {data.entries.length === 0 ? (
              <EmptyState title="当日暂无资金流水" detail="收款、储值消费和已完成退款会按发生时间列在这里。" />
            ) : (
              <div className="tennis-table-scroll">
                <table className="tennis-table">
                  <thead>
                    <tr>
                      <th scope="col">时间</th>
                      <th scope="col">事项</th>
                      <th scope="col">现金变动</th>
                      <th scope="col">余额消费 / 退回</th>
                      <th scope="col">充值赠送</th>
                      <th scope="col">关联记录</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.entries.map((entry) => (
                      <tr key={entry.id}>
                        <td>{dateTime(entry.createdAt, venue.timezone)}</td>
                        <td>
                          {entryNames[entry.kind] ?? "资金记录"}
                          <small title={entry.id}>流水 {entry.id.slice(0, 12)}</small>
                        </td>
                        <td className="tennis-numeric">{money(entry.cashCents)}</td>
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
            <p className="tennis-muted">
              现金正数为收款、负数为退款；余额正数为消费扣款、负数为退款退回。各列分别核对，不相加作为营业收入。
            </p>
          </>
        ) : !finance.error ? (
          <p className="tennis-muted">尚未读取资金记录，请刷新。</p>
        ) : null}
      </Panel>
      {data && (
        <>
          <Panel title={`待退付款明细 · ${data.pendingRefunds.length} 项`}>
            <p className="tennis-muted">
              当前场馆全部未完成退款，不受上方日期筛选影响。一笔订单按原付款拆分时，可能有多条退款明细。
            </p>
            {data.pendingRefunds.length === 0 ? (
              <EmptyState title="暂无待处理退款" detail="退款申请、处理中或失败的明细会在这里列出。" />
            ) : (
              <div className="tennis-table-scroll">
                <table className="tennis-table">
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
                        <td className="tennis-numeric">{money(refund.amountCents)}</td>
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
              当前场馆全部未结实收异常，不受日期筛选影响。核对后可按原额申请原路退款，退款完成后才算已处理。
            </p>
            {data.exceptions.length === 0 ? (
              <EmptyState title="暂无实收异常" detail="迟到付款、重复到账等需要人工核对的款项会在这里列出。" />
            ) : (
              <div className="tennis-table-scroll">
                <table className="tennis-table">
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
        </>
      )}
      {exceptionId && (
        <CashExceptionDialog
          api={api}
          session={session}
          venue={venue}
          scope={scope}
          exceptionId={exceptionId}
          onClose={() => setExceptionId(null)}
          onChanged={async () => {
            await finance.refresh();
          }}
          openOrder={(id) => {
            setExceptionId(null);
            openOrder(id);
          }}
        />
      )}
    </>
  );
}
