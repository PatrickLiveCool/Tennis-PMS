import { useCallback, useEffect, useRef, useState, type ReactNode, type Dispatch, type SetStateAction } from "react";
import { AlertCircle, RefreshCw } from "lucide-react";
import { TennisApiError, errorText, type TennisApi } from "./api";
import type { CommandReceipt } from "./types";
export { Modal, LoadingBlock, EmptyState } from "../uiBasic";

export const money = (cents: number | null | undefined) =>
  cents == null ? "未设置" : new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY" }).format(cents / 100);
export const cents = (value: string) => {
  if (!/^\d+(\.\d{1,2})?$/.test(value)) throw new Error("请输入有效人民币金额，最多两位小数。");
  const [whole = "0", fraction = ""] = value.split(".");
  const result = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("金额过大。");
  return Number(result);
};
export function dateValue(value = new Date(), timezone = "Asia/Shanghai") {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}
export function dateTime(value: string | null | undefined, timezone = "Asia/Shanghai") {
  return value
    ? new Intl.DateTimeFormat("zh-CN", {
        timeZone: timezone,
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date(value))
    : "—";
}
export function clock(value: string, timezone = "Asia/Shanghai") {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(value));
}
export const minuteLabel = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
/** Resolve a venue wall clock to UTC, rejecting nonexistent local times. */
export function atVenueTime(date: string, minute: number, timezone: string): string {
  const target = Date.parse(`${date}T00:00:00Z`) + minute * 60_000;
  let guess = target;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  for (let i = 0; i < 3; i++) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(guess)).map((p) => [p.type, p.value]));
    const seen = Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`);
    if (seen === target) return new Date(guess).toISOString();
    guess += target - seen;
  }
  throw new Error("该日期在场馆时区中不存在所选时间，请调整时间。");
}
const labels: Record<string, string> = {
  HELD: "待付款",
  CONFIRMED: "已预订",
  CANCELLED: "已取消",
  EXPIRED: "已到期",
  COMPLETED: "已完成",
  UNPAID: "未付款",
  PAID: "已付款",
  PARTIALLY_REFUNDED: "部分退款",
  REFUNDED: "已退款",
  NOT_REQUIRED: "无需付款",
  PENDING: "待处理",
  PROCESSING: "处理中",
  REQUESTED: "待退款",
  SUCCEEDED: "已完成",
  FAILED: "失败",
  REFUND_REQUIRED: "待处理迟付退款",
  TOPUP: "充值入账",
  RESERVE: "付款预留",
  RELEASE: "预留释放",
  CONSUME: "消费扣款",
  REFUND: "退款退回",
  BOOKING: "预订",
  COURSE: "课程占场",
  MAINTENANCE: "维护停场",
};
export function label(value: string) {
  return labels[value] ?? value;
}
export function Badge({ value }: { value: string }) {
  return <span className={`status-badge tennis-status-${value.toLowerCase()}`}>{label(value)}</span>;
}
export function ErrorNotice({ error, retry }: { error: unknown; retry?: () => void }) {
  return error ? (
    <div className="inline-error" role="alert">
      <AlertCircle size={18} aria-hidden="true" />
      <div>
        <strong>需要核对</strong>
        <p>{errorText(error)}</p>
        {retry && (
          <button className="button button-secondary button-small" onClick={retry}>
            重新读取
          </button>
        )}
      </div>
    </div>
  ) : null;
}
export function PageHeading({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <header className="page-heading page-heading-actions">
      <div>
        <h1 tabIndex={-1}>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      <div className="page-heading-buttons">{children}</div>
    </header>
  );
}
export function Panel({ title, children, action }: { title?: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="tennis-panel">
      {title && (
        <div className="panel-heading">
          <h2>{title}</h2>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}
export function RefreshButton({ onClick, busy = false }: { onClick: () => void; busy?: boolean }) {
  return (
    <button type="button" className="button button-secondary" onClick={onClick} disabled={busy}>
      <RefreshCw size={16} aria-hidden="true" />
      刷新
    </button>
  );
}
export function useLoad<T>(load: () => Promise<T>, dependencies: readonly unknown[]) {
  const [snapshot, setSnapshot] = useState<{ dependencies: readonly unknown[]; value: T }>();
  const dependencyRef = useRef(dependencies);
  dependencyRef.current = dependencies;
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(true);
  const serial = useRef(0);
  const loader = useRef(load);
  loader.current = load;
  const refresh = useCallback(async () => {
    const id = ++serial.current;
    const startedFor = dependencyRef.current;
    setBusy(true);
    try {
      const result = await loader.current();
      if (id === serial.current) {
        setSnapshot({ dependencies: startedFor, value: result });
        setError(undefined);
      }
      return result;
    } catch (next) {
      if (id === serial.current) setError(next);
      return undefined;
    } finally {
      if (id === serial.current) setBusy(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    return () => {
      serial.current++;
    };
  }, dependencies);
  const data =
    snapshot?.dependencies.length === dependencies.length &&
    snapshot.dependencies.every((value, index) => Object.is(value, dependencies[index]))
      ? snapshot.value
      : undefined;
  return { data, error, busy, refresh };
}
function readStored<T>(key: string, fallback: T): T {
  try {
    return (JSON.parse(sessionStorage.getItem(key) ?? "null") as T) ?? fallback;
  } catch {
    return fallback;
  }
}
export function writeStored(key: string, value: unknown) {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Memory state remains usable when storage is disabled. */
  }
}
export function useDraft<T>(key: string, initial: T) {
  const [stored, setStored] = useState(() => ({ key, value: readStored(key, initial) }));
  const value = stored.key === key ? stored.value : readStored(key, initial);
  const latest = useRef({ key, value });
  latest.current = { key, value };
  useEffect(() => {
    if (stored.key !== key) setStored(latest.current);
  }, [key, stored.key]);
  // Persist before a successful operation closes its form; an effect may never run after unmount.
  const setValue: Dispatch<SetStateAction<T>> = (next) => {
    const current = latest.current.key === key ? latest.current.value : readStored(key, initial);
    const updated = typeof next === "function" ? (next as (value: T) => T)(current) : next;
    const snapshot = { key, value: updated };
    latest.current = snapshot;
    writeStored(key, updated);
    setStored(snapshot);
  };
  return [value, setValue] as const;
}
export interface PendingCommand {
  key: string;
  intent: string;
  payload: string;
  createdAt: string;
}
export function pendingCommands(scope: string): PendingCommand[] {
  return readStored(`tennis:pending:${scope}`, []);
}
export function forgetCommand(scope: string, key: string) {
  writeStored(
    `tennis:pending:${scope}`,
    pendingCommands(scope).filter((p) => p.key !== key),
  );
  window.dispatchEvent(new Event("tennis-pending"));
}
/** The same intent and payload reuse the same command key until a definitive result. */
export function useCommand(scope: string) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const running = useRef(false);
  async function execute<T>(
    intent: string,
    payload: unknown,
    work: (key: string) => Promise<T>,
  ): Promise<T | undefined> {
    if (running.current) return undefined;
    const serialized = JSON.stringify(payload);
    const existing = pendingCommands(scope).find((p) => p.intent === intent);
    if (existing && existing.payload !== serialized) {
      setError(new Error("这项操作还有待核实的提交结果。请先查询原操作，保留原输入后可安全重试。"));
      return undefined;
    }
    const command = existing ?? {
      key: crypto.randomUUID(),
      intent,
      payload: serialized,
      createdAt: new Date().toISOString(),
    };
    if (!existing) writeStored(`tennis:pending:${scope}`, [...pendingCommands(scope), command]);
    window.dispatchEvent(new Event("tennis-pending"));
    running.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const result = await work(command.key);
      forgetCommand(scope, command.key);
      return result;
    } catch (next) {
      if (!existing && next instanceof TennisApiError && !next.uncertain) forgetCommand(scope, command.key);
      setError(next);
      return undefined;
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return { busy, error, execute, setError };
}
export function RecoveryNotice({
  scope,
  api,
  openOrder,
  openTopup,
}: {
  scope: string;
  api: TennisApi;
  openOrder: (id: string) => void;
  openTopup?: (id: string) => void;
}) {
  const [pending, setPending] = useState(() => pendingCommands(scope));
  const [error, setError] = useState<unknown>();
  const [message, setMessage] = useState("");
  useEffect(() => {
    const sync = () => setPending(pendingCommands(scope));
    window.addEventListener("tennis-pending", sync);
    return () => window.removeEventListener("tennis-pending", sync);
  }, [scope]);
  async function recover(item: PendingCommand) {
    try {
      if (/^(payment|refund|topup)\.simulate:/.test(item.intent)) {
        const [kind, id] = item.intent.split(":");
        const path = kind === "payment.simulate" ? "payments" : kind === "refund.simulate" ? "refunds" : "topups";
        const result = await api<{ status: string; orderId?: string }>(`/${path}/${id}`);
        if (kind === "topup.simulate" && id && openTopup) openTopup(id);
        if (["PENDING", "REQUESTED", "PROCESSING"].includes(result.status)) {
          setMessage("原付款 / 退款仍在处理中，请从原记录刷新或使用同一模拟操作重试。");
          return;
        }
        forgetCommand(scope, item.key);
        setMessage("已查询原资金记录，请核对最新状态。");
        if (result.orderId) openOrder(result.orderId);
        return;
      }
      const receipt = await api<CommandReceipt | null>(`/receipts/${encodeURIComponent(item.key)}`);
      if (!receipt) {
        setMessage("尚未查到已完成回执。请保留原输入，在原入口重试；系统会复用同一个操作编号。");
        return;
      }
      if (typeof receipt.result.topupId === "string" && openTopup) {
        const payment = await api<{ id: string }>(`/topups/${encodeURIComponent(receipt.result.topupId)}`);
        openTopup(payment.id);
      }
      forgetCommand(scope, item.key);
      setMessage("已查到原操作成功回执，请刷新相关订单或余额核对最新状态。");
      if (typeof receipt.result.orderId === "string") {
        openOrder(receipt.result.orderId);
        return;
      }
      for (const [field, path] of [
        ["paymentId", "payments"],
        ["refundId", "refunds"],
        ["refundGroupId", "refund-groups"],
        ["amendmentId", "amendments"],
      ]) {
        const id = receipt.result[field!];
        if (typeof id !== "string") continue;
        const result = await api<{ orderId?: string }>(`/${path}/${id}`);
        if (result.orderId) openOrder(result.orderId);
        break;
      }
    } catch (next) {
      setError(next);
    }
  }
  if (!pending.length && !message && !error) return null;
  return (
    <div className="tennis-recovery" role="status">
      {pending.length > 0 && (
        <>
          <strong>{pending.length} 项操作正在提交或等待结果核实</strong>
          {pending.map((p) => (
            <button key={p.key} className="button button-secondary button-small" onClick={() => void recover(p)}>
              查询原操作 · {dateTime(p.createdAt)}
            </button>
          ))}
        </>
      )}
      {message && <span>{message}</span>}
      <ErrorNotice error={error} />
    </div>
  );
}
