import { useEffect, useRef, useState } from "react";
import type { TennisApi } from "./api";
import { dateTime, ErrorNotice, LoadingBlock, RefreshButton, useLoad } from "./components";

export interface PaymentChannelSnapshot {
  sourceId: string;
  operationId: string | null;
  provider: "MOCK" | "WECHAT" | "WALLET";
  simulation: boolean;
  state: "NOT_REQUIRED" | "READY" | "IN_FLIGHT" | "UNKNOWN" | "PENDING" | "SUCCEEDED" | "FAILED";
  checkout: { kind: "LOCAL_SIMULATION"; operationId: string; expiresAt: string } | null;
  lastCheckedAt: string | null;
  message: string;
  canReconcile: boolean;
}
interface PaymentChannelPanelProps {
  api: TennisApi;
  kind: "payment" | "topup" | "refund" | "exception-refund";
  sourceId: string;
  scope: string;
  businessStatus: string;
  timezone: string;
  canOperate: boolean;
  onChanged: () => void | Promise<void>;
  onRetryRefund?: () => Promise<void>;
  businessBusy?: boolean;
}
const stateLabels: Record<PaymentChannelSnapshot["state"], string> = {
  NOT_REQUIRED: "无需线上支付",
  READY: "尚未提交",
  IN_FLIGHT: "正在处理，结果待确认",
  UNKNOWN: "渠道结果待核对",
  PENDING: "等待支付平台确认",
  SUCCEEDED: "渠道已确认成功",
  FAILED: "渠道已确认失败",
};
const paths = {
  payment: "payments",
  topup: "topups",
  refund: "refunds",
  "exception-refund": "exception-refunds",
} as const;

/** Remount on identity/source changes so a late result cannot update another transaction. */
export function PaymentChannelPanel(props: PaymentChannelPanelProps) {
  return <ChannelDetails key={`${props.scope}:${props.kind}:${props.sourceId}`} {...props} />;
}
function ChannelDetails({
  api,
  kind,
  sourceId,
  businessStatus,
  timezone,
  canOperate,
  onChanged,
  onRetryRefund,
  businessBusy = false,
}: PaymentChannelPanelProps) {
  const path = `/${paths[kind]}/${encodeURIComponent(sourceId)}/channel`;
  function validate(value: PaymentChannelSnapshot) {
    if (!value || value.sourceId !== sourceId || !Object.hasOwn(stateLabels, value.state))
      throw new Error("未能核实支付结果，请刷新后重试。");
    return value;
  }
  const channel = useLoad(async () => validate(await api<PaymentChannelSnapshot>(path)), [api, path, businessStatus]);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<unknown>();
  const running = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const current = channel.data?.sourceId === sourceId ? channel.data : null;
  const busy = working || channel.busy || businessBusy;
  async function readSnapshot() {
    if (running.current) return;
    const result = await channel.refresh();
    if (result && mounted.current) setError(undefined);
  }
  async function retryRefund() {
    if (
      running.current ||
      busy ||
      !canOperate ||
      !onRetryRefund ||
      businessStatus !== "FAILED" ||
      current?.state !== "FAILED" ||
      error ||
      channel.error
    )
      return;
    running.current = true;
    setWorking(true);
    setError(undefined);
    try {
      await onRetryRefund();
    } catch (next) {
      if (mounted.current) setError(next);
    } finally {
      // The original retry may have lost its response. Re-read before exposing it again.
      if (mounted.current) await channel.refresh();
      running.current = false;
      if (mounted.current) setWorking(false);
    }
  }
  async function reconcile() {
    if (running.current || !canOperate || !current?.canReconcile || busy) return;
    running.current = true;
    setWorking(true);
    setError(undefined);
    try {
      validate(await api<PaymentChannelSnapshot>(`${path}/reconcile`, "POST", {}));
      if (!mounted.current) return;
      await channel.refresh();
      if (mounted.current) await onChanged();
    } catch (next) {
      if (mounted.current) {
        setError(next);
        // The operation is persisted by the server; read it without issuing another channel action.
        await channel.refresh();
      }
    } finally {
      running.current = false;
      if (mounted.current) setWorking(false);
    }
  }
  if (current?.state === "NOT_REQUIRED" && !channel.error && !error) return null;
  const startsSubmission = current?.state === "READY" && !error && !channel.error;
  const isRefund = kind === "refund" || kind === "exception-refund";
  const submitLabel = isRefund ? "提交原退款单" : kind === "topup" ? "提交原充值单" : "提交原付款单";
  const canRetry =
    isRefund &&
    canOperate &&
    !!onRetryRefund &&
    businessStatus === "FAILED" &&
    current?.state === "FAILED" &&
    !error &&
    !channel.error;
  return (
    <section aria-label="支付渠道核对" style={{ width: "100%", padding: "12px 0 0" }}>
      <div className="panel-heading">
        <h4 style={{ margin: 0 }}>支付渠道核对</h4>
        <RefreshButton busy={busy} onClick={() => void readSnapshot()} />
      </div>
      <ErrorNotice error={error ?? channel.error} retry={() => void readSnapshot()} />
      {channel.busy && !current ? <LoadingBlock /> : null}
      {!!channel.error && current && (
        <p className="tennis-note">刷新失败，以下为上次结果。请重新核对。</p>
      )}
      {current && (
        <>
          <p role="status">
            <strong>{stateLabels[current.state]}</strong>
          </p>
          {current.simulation && <p className="tennis-note">本地模拟渠道，不会发生真实扣费或退款。</p>}
          <details>
            <summary>查看支付编号</summary>
            <p className="tennis-muted" style={{ overflowWrap: "anywhere" }}>
              付款或退款编号：<code>{sourceId}</code>
            </p>
            {current.operationId && (
              <p className="tennis-muted" style={{ overflowWrap: "anywhere" }}>
                办理编号：<code>{current.operationId}</code>
              </p>
            )}
          </details>
          <p className="tennis-muted">
            上次核对：{current.lastCheckedAt ? dateTime(current.lastCheckedAt, timezone) : "尚未查询"}
          </p>
          {current.checkout?.kind === "LOCAL_SIMULATION" &&
            current.simulation &&
            current.checkout.operationId === current.operationId &&
            current.state === "PENDING" && (
              <p className="tennis-note">
                模拟付款有效至 {dateTime(current.checkout.expiresAt, timezone)}。
              </p>
            )}
          {(current.state === "UNKNOWN" || current.state === "IN_FLIGHT") && (
            <p className="tennis-note">结果尚未确认，请先查询，勿重复付款或退款。</p>
          )}
          <div className="tennis-actions">
            {canOperate && current.canReconcile && (
              <button
                type="button"
                className="button button-secondary button-small"
                disabled={busy}
                onClick={() => void reconcile()}
              >
                {working ? "正在核对…" : startsSubmission ? submitLabel : "查询结果"}
              </button>
            )}
            {canRetry && (
              <button
                type="button"
                className="button button-secondary button-small"
                disabled={busy}
                onClick={() => void retryRefund()}
              >
                重试这笔退款
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
