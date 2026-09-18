import { useEffect, useRef, useState } from "react";
import type { TennisApi } from "./api";
import {
  Badge,
  dateTime,
  ErrorNotice,
  forgetCommand,
  LoadingBlock,
  Modal,
  money,
  Panel,
  pendingCommands,
  RefreshButton,
  useCommand,
  useDraft,
  useLoad,
} from "./components";
import { PaymentChannelPanel } from "./PaymentChannelPanel";
import { permits, type CommandReceipt, type Session, type VenueRecord } from "./types";

interface ExceptionRefund {
  id: string;
  provider: "MOCK" | "WECHAT";
  amountCents: number;
  status: "REQUESTED" | "PROCESSING" | "SUCCEEDED" | "FAILED";
  reason: string;
  providerRefundId: string | null;
  createdAt: string;
  completedAt: string | null;
}
interface CashException {
  id: string;
  sourceKind: "ORDER" | "TOPUP";
  sourceId: string;
  orderId: string | null;
  tenantId: string;
  venueId: string;
  provider: "MOCK" | "WECHAT";
  merchantId: string;
  transactionId: string;
  amountCents: number;
  status: "OPEN" | "RESOLVED";
  createdAt: string;
  refund: ExceptionRefund | null;
}
interface Props {
  api: TennisApi;
  session: Session;
  venue: VenueRecord;
  scope: string;
  exceptionId: string;
  onClose: () => void;
  onChanged: () => void | Promise<void>;
  openOrder: (id: string) => void;
}
export function CashExceptionDialog(props: Props) {
  return <ExceptionDetails key={`${props.scope}:${props.session.contextVersion}:${props.exceptionId}`} {...props} />;
}
function ExceptionDetails({ api, session, venue, scope, exceptionId, onClose, onChanged, openOrder }: Props) {
  const operationScope = `${scope}:cash-exception:${exceptionId}`;
  const createIntent = `cash-exception.refund:${exceptionId}`;
  const command = useCommand(operationScope);
  const [reason, setReason] = useDraft(`tennis:exception-reason:${operationScope}`, "");
  const [pending, setPending] = useState(() => pendingCommands(operationScope));
  const [checkedKeys, setCheckedKeys] = useState<string[]>([]);
  const [recovering, setRecovering] = useState(false);
  const [error, setError] = useState<unknown>();
  const [notice, setNotice] = useState("");
  const mounted = useRef(true);
  const detail = useLoad(async () => {
    const result = await api<CashException>(`/cash-exceptions/${encodeURIComponent(exceptionId)}`);
    if (!result || result.id !== exceptionId || result.tenantId !== session.tenantId || result.venueId !== venue.id)
      throw new Error("实收记录尚未核实，请重新读取原记录。");
    return result;
  }, [api, exceptionId, session.tenantId, venue.id]);
  useEffect(() => {
    mounted.current = true;
    const sync = () => setPending(pendingCommands(operationScope));
    window.addEventListener("tennis-pending", sync);
    return () => {
      mounted.current = false;
      window.removeEventListener("tennis-pending", sync);
    };
  }, [operationScope]);
  const record = detail.data;
  const refund = record?.refund;
  const canRefund = permits(session, "refund");
  const busy = command.busy || recovering || detail.busy;
  const stale = Boolean(detail.error);
  const unchecked = pending.some((item) => !checkedKeys.includes(item.key));
  const simulationBlocked = (status: "SUCCEEDED" | "FAILED") =>
    pending.some(
      (item) =>
        item.intent.startsWith("exception-refund.simulate:") &&
        item.intent !== `exception-refund.simulate:${refund?.id}:${status}`,
    );

  // A lost response is recovered from the original exception before any retry.
  async function recover() {
    if (busy) return;
    setRecovering(true);
    setCheckedKeys([]);
    setError(undefined);
    try {
      const current = await detail.refresh();
      if (!current || !mounted.current) return;
      const checked: string[] = [];
      for (const item of pendingCommands(operationScope)) {
        let resolved = item.intent === createIntent && Boolean(current.refund);
        if (item.intent.startsWith("exception-refund.simulate:")) {
          resolved = current.refund?.status === "SUCCEEDED" || current.refund?.status === "FAILED";
        } else if (!resolved) {
          resolved = Boolean(await api<CommandReceipt | null>(`/receipts/${encodeURIComponent(item.key)}`));
        }
        if (!mounted.current) return;
        if (resolved) forgetCommand(operationScope, item.key);
        else checked.push(item.key);
      }
      if (!mounted.current) return;
      setCheckedKeys(checked);
      command.setError(undefined);
      setNotice(
        checked.length
          ? "已查询原记录，尚未确认提交完成。保留原输入，可使用原操作编号重试。"
          : "已重新核对原实收和退款记录，请以当前状态为准。",
      );
      await onChanged();
    } catch (next) {
      if (mounted.current) setError(next);
    } finally {
      if (mounted.current) setRecovering(false);
    }
  }
  async function changed(message?: string) {
    if (!mounted.current) return;
    if (message) setNotice(message);
    await detail.refresh();
    if (mounted.current) await onChanged();
  }
  async function requestRefund() {
    if (
      !record ||
      record.refund ||
      record.status !== "OPEN" ||
      !canRefund ||
      busy ||
      stale ||
      unchecked ||
      !reason.trim()
    )
      return;
    setCheckedKeys([]);
    const payload = { amountCents: record.amountCents, reason: reason.trim() };
    const result = await command.execute(createIntent, payload, (key) =>
      api<ExceptionRefund>(`/cash-exceptions/${encodeURIComponent(exceptionId)}/refund`, "POST", {
        ...payload,
        commandKey: key,
      }),
    );
    if (result && mounted.current) {
      setReason("");
      await changed("原额退款已申请，等待原支付渠道确认；申请成功不代表已退款。");
    }
  }
  async function retryRefund() {
    if (!refund || refund.status !== "FAILED" || !canRefund || busy || stale || unchecked) return;
    setCheckedKeys([]);
    const result = await command.execute(`exception-refund.retry:${refund.id}`, {}, (key) =>
      api<ExceptionRefund>(`/exception-refunds/${encodeURIComponent(refund.id)}/retry`, "POST", { commandKey: key }),
    );
    if (result) await changed("已重试原退款，请继续核对渠道结果。");
  }
  async function simulate(status: "SUCCEEDED" | "FAILED") {
    if (
      !refund ||
      !session.localSimulation ||
      refund.provider !== "MOCK" ||
      !canRefund ||
      busy ||
      stale ||
      unchecked ||
      simulationBlocked(status) ||
      !["REQUESTED", "PROCESSING"].includes(refund.status)
    )
      return;
    setCheckedKeys([]);
    const result = await command.execute(`exception-refund.simulate:${refund.id}:${status}`, { status }, () =>
      api<ExceptionRefund>(`/exception-refunds/${encodeURIComponent(refund.id)}/simulate`, "POST", { status }),
    );
    if (result) await changed("本地模拟退款结果已处理，请核对实收异常状态。");
  }
  return (
    <Modal title="实收核对与原路退款" onClose={onClose} closeDisabled={command.busy || recovering}>
      <div className="tennis-form">
        <div className="tennis-actions">
          <RefreshButton busy={busy} onClick={() => void recover()} />
          {pending.length > 0 && (
            <button type="button" className="button button-secondary" disabled={busy} onClick={() => void recover()}>
              核对原操作
            </button>
          )}
        </div>
        <ErrorNotice error={error ?? command.error ?? detail.error} />
        {notice && (
          <p className="tennis-note" role="status">
            {notice}
          </p>
        )}
        {pending.length > 0 && (
          <p className="tennis-note is-warning">
            有提交结果尚未核实，请先查询原实收和退款记录。原操作编号与输入已保留。
          </p>
        )}
        {stale && record && (
          <p className="tennis-note is-warning">读取未完成，以下为上次记录；重新核对成功后才能继续退款。</p>
        )}
        {!record ? (
          detail.busy ? (
            <LoadingBlock />
          ) : null
        ) : (
          <>
            <p className="tennis-note">
              这笔实收未用于完成预订或增加充值余额，仅按原到账金额退回原支付来源，不改变会员余额或球场占用。
            </p>
            {record.provider === "MOCK" && (
              <p className="tennis-note is-warning">当前为本地模拟记录，不会发生真实退款。</p>
            )}
            <Panel title="原实收记录">
              <div className="tennis-money-row">
                <span>原额退回</span>
                <strong>{money(record.amountCents)}</strong>
              </div>
              <p role="status">
                <strong>{record.status === "RESOLVED" ? "已处理 · 退款已完成" : "待处理 · 请核对退款进度"}</strong>
              </p>
              <p className="tennis-muted">
                来源：{record.sourceKind === "ORDER" ? "预订付款" : "会员充值"} ·{" "}
                {dateTime(record.createdAt, venue.timezone)}
              </p>
              <p className="tennis-muted" style={{ overflowWrap: "anywhere" }}>
                原付款编号：<code>{record.sourceId}</code>
              </p>
              <p className="tennis-muted" style={{ overflowWrap: "anywhere" }}>
                原商户：<code>{record.merchantId}</code>
              </p>
              <p className="tennis-muted" style={{ overflowWrap: "anywhere" }}>
                原渠道流水：<code>{record.transactionId}</code>
              </p>
              {record.orderId && (
                <button
                  type="button"
                  className="button button-secondary button-small"
                  disabled={busy}
                  onClick={() => openOrder(record.orderId!)}
                >
                  查看关联订单
                </button>
              )}
            </Panel>
            {refund ? (
              <Panel title="原路退款进度">
                <div className="tennis-money-row">
                  <span>退款金额</span>
                  <strong>{money(refund.amountCents)}</strong>
                </div>
                <Badge value={refund.status} />
                <p>{refund.reason}</p>
                <p className="tennis-muted" style={{ overflowWrap: "anywhere" }}>
                  退款编号：<code>{refund.id}</code>
                </p>
                <p className="tennis-muted">
                  发起于 {dateTime(refund.createdAt, venue.timezone)}
                  {refund.completedAt ? ` · 完成于 ${dateTime(refund.completedAt, venue.timezone)}` : ""}
                </p>
                {refund.providerRefundId && (
                  <p className="tennis-muted" style={{ overflowWrap: "anywhere" }}>
                    渠道退款流水：<code>{refund.providerRefundId}</code>
                  </p>
                )}
                <PaymentChannelPanel
                  api={api}
                  kind="exception-refund"
                  sourceId={refund.id}
                  scope={`${operationScope}:${session.contextVersion}`}
                  businessStatus={refund.status}
                  timezone={venue.timezone}
                  canOperate={canRefund && !stale && !unchecked}
                  businessBusy={busy}
                  onChanged={() => changed()}
                  onRetryRefund={retryRefund}
                />
                {session.localSimulation &&
                  refund.provider === "MOCK" &&
                  canRefund &&
                  ["REQUESTED", "PROCESSING"].includes(refund.status) && (
                    <div className="tennis-actions">
                      <button
                        type="button"
                        className="button button-secondary button-small"
                        disabled={busy || stale || unchecked || simulationBlocked("SUCCEEDED")}
                        onClick={() => void simulate("SUCCEEDED")}
                      >
                        模拟退款成功
                      </button>
                      <button
                        type="button"
                        className="button button-secondary button-small"
                        disabled={busy || stale || unchecked || simulationBlocked("FAILED")}
                        onClick={() => void simulate("FAILED")}
                      >
                        模拟退款失败
                      </button>
                    </div>
                  )}
              </Panel>
            ) : canRefund && record.status === "OPEN" ? (
              <>
                <label>
                  退款原因
                  <textarea
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    maxLength={500}
                    rows={3}
                    disabled={busy || pending.length > 0}
                    placeholder="填写核对结论及原路退款原因"
                  />
                </label>
                <button
                  type="button"
                  className="button button-primary"
                  disabled={busy || stale || unchecked || !reason.trim()}
                  onClick={() => void requestRefund()}
                >
                  {pending.length > 0 ? "使用原操作重试退款申请" : `按原额申请退款 ${money(record.amountCents)}`}
                </button>
              </>
            ) : null}
            {!canRefund && (
              <p className="tennis-muted">当前账号可查看核对记录；发起或重试退款需由有退款权限的员工办理。</p>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
