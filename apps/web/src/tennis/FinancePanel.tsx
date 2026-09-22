import { InfoHint } from "./InfoHint";
import { useState } from "react";
import type { TennisApi } from "./api";
import { WecomReconciliationPanel } from "./WecomReconciliationPanel";
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
  onChanged?: () => Promise<unknown>;
}
const entryNames: Record<string, string> = {
  OFFLINE_TOPUP: "线下充值实收",
  ONLINE_TOPUP: "线上充值实收",
  EXTRA_TOPUP_RECEIPT: "充值额外实收",
  ORDER_RECEIPT: "订单现金实收",
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
function VenueFinance({ api, venue, session, openOrder, onChanged }: FinanceProps) {
  const [date, setDate] = useState(() => dateValue(new Date(), venue.timezone));
  const [exceptionId, setExceptionId] = useState<string | null>(null);
  const scope = `${session.subjectId}:${session.kind}:${session.tenantId}:${session.customerId ?? "staff"}:${venue.id}`;
  const finance = useLoad(
    () => api<FinanceData>(`/venues/${venue.id}/finance?date=${encodeURIComponent(date)}`),
    [api, venue.id, date],
  );
  const data = finance.data;
  async function refreshBusiness() {
    await Promise.all([finance.refresh(), onChanged?.()]);
  }
  return (
    <>
      <WecomReconciliationPanel api={api} session={session} venue={venue} onChanged={refreshBusiness} openOrder={openOrder} />
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
          {venue.name} <InfoHint label="统计日期说明">按场馆所在时区（{venue.timezone}）统计当天的收款和余额变动。</InfoHint>
        </p>
        {session.localSimulation && (
          <p className="tennis-note is-warning">当前为本地模拟资金记录，不代表真实到账或退款。</p>
        )}
        <ErrorNotice error={finance.error} retry={() => void finance.refresh()} />
        {Boolean(finance.error) && data && (
          <p className="tennis-muted" role="status">
            刷新失败，以下为上次结果。
          </p>
        )}
        {!data && finance.busy ? (
          <LoadingBlock />
        ) : data ? (
          <>
            <div className="tennis-stats">
              <div>
                <span>已入账收款（含充值） <InfoHint label="收款统计说明">包含订单收款、充值和已确认归属的额外到账。待核对的企微收款暂不计入，余额消费与充值赠送也不计入。</InfoHint></span>
                <strong>{money(data.totals.cashInCents)}</strong>
              </div>
              <div>
                <span>已退现金 <InfoHint label="退款统计说明">只统计已经退回的款项，正在处理或失败的退款请看下方待退明细。</InfoHint></span>
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
            {data.entries.length === 0 ? (
              <EmptyState title="当日暂无资金流水" detail="收款、储值消费和已完成退款会按发生时间列在这里。" />
            ) : (
              <div className="tennis-table-scroll">
                <table className="tennis-table">
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
          </>
        ) : !finance.error ? (
          <p className="tennis-muted">尚未读取资金记录，请刷新。</p>
        ) : null}
      </Panel>
      {data && (
        <>
          <Panel title={`待退付款明细 · ${data.pendingRefunds.length} 项`} action={<InfoHint label="退款明细说明">一笔订单分多次付款时，退款也可能分为多笔。</InfoHint>}>
            <p className="tennis-muted">
              全部日期 · 当前场馆尚未完成的退款
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
              全部日期 · 待核对收款，退款到账后才算处理完成。
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
