import { AssistantGuide } from "./assistant/context";
import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { AlertCircle, Check, CircleHelp, LoaderCircle, X } from "lucide-react";
import type { MoneyDto } from "@qintopia/contracts";
import { ApiError } from "./api";

export function formatMoney(value: MoneyDto | undefined): string {
  if (!value) return "-";
  try {
    return new Intl.NumberFormat("zh-CN", {
      style: "currency",
      currency: value.currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(value.minorUnits / 100);
  } catch {
    return `${value.currency} ${value.minorUnits}`;
  }
}

export function formatMinor(minorUnits: number, currency: string): string {
  return formatMoney({ minorUnits, currency });
}

const externalBookingChannels = new Set(["YOUMUDAO", "CTRIP", "MEITUAN"]);

export function stayDateFundsAreOperatorFacing(
  bookingChannelCode: string | null | undefined,
  pricingBasis?: string
): boolean {
  if (bookingChannelCode && externalBookingChannels.has(bookingChannelCode)) return false;
  return pricingBasis !== "CHANNEL_CONTRACT";
}

export function formatDate(value: string | undefined): string {
  if (!value) return "-";
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return value;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

export function nextLocalDate(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return value;
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

export function formatDateTime(value: string | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

export function guestName(snapshot: Record<string, unknown>): string {
  const nickname = snapshot.nickname;
  if (typeof nickname === "string" && nickname.trim()) return nickname;
  const fullName = snapshot.fullName;
  return typeof fullName === "string" && fullName.trim() ? fullName : "未命名住客";
}

export function guestSearchText(snapshot: Record<string, unknown>): string {
  return [snapshot.nickname, snapshot.fullName, snapshot.phone, snapshot.documentNumber]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 401) return error.code === "INVALID_CREDENTIALS" ? "账号或密码不正确" : "登录已过期，请重新登录";
  if (error instanceof ApiError && error.status === 403) return "当前账号权限不足，无法访问此内容或执行此操作";
  if (error instanceof ApiError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return "请求失败，请稍后重试";
}

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }

export function businessErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "RESOURCE_SCOPE_DENIED" && /Cross-origin session write/i.test(error.message)) {
      return "当前页面地址与系统登录地址不一致，本次没有写入。请从系统提供的地址重新打开并登录。";
    }
    if (error.code === "INVENTORY_CONFLICT") {
      return /[\u3400-\u9fff]/.test(error.message)
        ? error.message
        : "所选房源在目标日期区间已有占用，请重新选择房源或日期。";
    }
    if (error.code === "REFUND_LIMIT_EXCEEDED") {
      return /[\u3400-\u9fff]/.test(error.message)
        ? error.message
        : "退款金额不能超过所选原收款的剩余可退金额，请返回修改退款金额。";
    }
    if (error.code === "PREVIEW_STALE" && isRecord(error.details) && error.details.causeCode === "INVENTORY_CONFLICT") {
      return "目标房间在所选日期已被占用，请重新选择房间或日期。";
    }
    if (error.code === "PREVIEW_STALE" && isRecord(error.details) && error.details.causeCode === "REFUND_LIMIT_EXCEEDED") {
      return "退款金额不能超过所选原收款的剩余可退金额，请返回修改退款金额。";
    }
    if (/[\u3400-\u9fff]/.test(error.message) && !/Preview|Confirm|Receipt|Command|effectHash|idempoten/i.test(error.message)) {
      return error.message;
    }
    if (error.status === 401) return "登录已过期，请重新登录后查询原操作结果。";
    if (error.status === 403) return "当前账号权限不足，本次没有写入。";
    if (error.status === 409 || error.code === "PREVIEW_STALE" || error.code === "INVALID_ORDER_STATE") {
      return "当前业务状态已经变化，本次没有写入。请刷新后重新核对。";
    }
    if (error.status >= 500 || error.retryable) return "服务暂时不可用，当前结果尚未确认。请按页面提示查询原操作结果。";
    return "本次操作未完成，服务端没有接受这次提交。请返回修改后重新核对。";
  }
  if (error instanceof Error && /[\u3400-\u9fff]/.test(error.message) && !/Preview|Confirm|Receipt|Command|effectHash|idempoten/i.test(error.message)) {
    return error.message;
  }
  return "本次操作未完成，请返回修改后重新核对。";
}

export function InfoHint({ text, label = "说明" }: { text: string; label?: string }) {
  return <span className="info-hint" tabIndex={0} role="note" aria-label={`${label}：${text}`}>
    <CircleHelp aria-hidden="true" size={14} />
    <span className="info-hint-bubble" role="tooltip">{text}</span>
  </span>;
}

export const membershipStartDateHelp = "会员合同和权益从该日期开始计算。会员开始日期与企业微信收款日期分别记录，二者无需相同，也没有先后顺序限制。";
export const membershipPaymentDateHelp = "填写企业微信账单显示的实际收款日期，只记录到日。该日期仅用于核对收款，不影响会员权益的开始日期。";

export function StatusBadge({ value, label }: { value: string; label?: string }) {
  const normalized = value.toLowerCase().replaceAll("_", "-");
  return <span className={`status-badge status-${normalized}`}>{label ?? value.replaceAll("_", " ")}</span>;
}

const businessStatusLabels: Record<string, string> = {
  RESERVED: "已预订",
  PLANNED: "已预订",
  CHECKED_IN: "在住",
  IN_HOUSE: "在住",
  CHECKED_OUT: "已退房",
  COMPLETED: "已完成",
  CANCELLED: "已取消",
  NO_SHOW: "未到",
  PENDING: "待清洁",
  HELD: "已冻结",
  CONSUMED: "已核销",
  RELEASED: "已释放",
  DRAFT: "待生效",
  ACTIVE: "有效",
  EXPIRED: "已过期",
  VOIDED: "已作废",
  CHECK_IN_REVOKED: "入住已撤销",
  RESTORED: "已补偿恢复"
};

export function businessStatusLabel(value: string): string {
  return businessStatusLabels[value] ?? value;
}

export function InlineError({ error, title = "操作未完成", hideTechnicalDetails = true }: {
  error: unknown;
  title?: string;
  hideTechnicalDetails?: boolean;
}) {
  if (!error) return null;
  const apiError = error instanceof ApiError ? error : undefined;
  const originMismatch = apiError?.code === "RESOURCE_SCOPE_DENIED" && /Cross-origin session write/i.test(apiError.message);
  const message = !hideTechnicalDetails || apiError && (apiError.status === 401 || apiError.status === 403) && !originMismatch
    ? errorMessage(error)
    : businessErrorMessage(error);
  return (
    <div className="inline-error" role="alert" tabIndex={-1}>
      <AlertCircle aria-hidden="true" size={18} />
      <div>
        <strong>{title}</strong>
        <p>{message}</p>
        {apiError?.correlationId ? (
          hideTechnicalDetails
            ? <details className="error-technical-details"><summary>技术信息（提供给支持人员）</summary><small>关联编号：{apiError.correlationId}</small></details>
            : <small>关联编号：{apiError.correlationId}</small>
        ) : null}
      </div>
    </div>
  );
}

export function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="empty-state">
      <strong>{title}</strong>
      <p>{detail}</p>
    </div>
  );
}

export function LoadingBlock({ label = "正在加载" }: { label?: string }) {
  return (
    <div className="loading-block" role="status">
      <LoaderCircle className="spin" aria-hidden="true" size={20} />
      <span>{label}</span>
    </div>
  );
}

export function CommandResultNotice({ message, onDismiss }: { message: string | undefined; onDismiss: () => void }) {
  if (!message) return null;
  const warning = message.includes("未写入") || message.includes("未执行") || message.includes("刷新失败");
  return (
    <div className={`command-result-notice${warning ? " is-warning" : ""}`} role="status" aria-live="polite" tabIndex={-1} data-testid="command-result-notice">
      {warning ? <AlertCircle aria-hidden="true" size={18} /> : <Check aria-hidden="true" size={18} />}
      <span>{message}</span>
      <button type="button" className="icon-button" onClick={onDismiss} aria-label="关闭操作结果提示" title="关闭">
        <X aria-hidden="true" size={16} />
      </button>
    </div>
  );
}

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: "default" | "wide" | "drawer" | "mobile-fullscreen";
  closeDisabled?: boolean;
  modal?: boolean;
  className?: string;
}

const ModalNoticeContext = createContext<ReactNode>(null);

export function ModalNoticeProvider({ notice, children }: { notice?: ReactNode; children: ReactNode }) {
  return <ModalNoticeContext.Provider value={notice ?? null}>{children}</ModalNoticeContext.Provider>;
}

const useDialogVisibilityEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export function Modal({ title, onClose, children, footer, size = "default", closeDisabled = false, modal = true, className }: ModalProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const edited = useRef(false);
  const outsidePress = useRef(false);
  const modalNotice = useContext(ModalNoticeContext);

  function dismissDrawer() {
    if (size !== "drawer" || closeDisabled) return;
    if (edited.current && !window.confirm("有尚未提交的编辑，确定收起并放弃这些修改吗？")) return;
    onClose();
  }

  useEffect(() => {
    if (size !== "drawer" || modal) return;
    const pointerDown = (event: PointerEvent) => {
      outsidePress.current = event.target instanceof Node && !dialogRef.current?.contains(event.target);
    };
    const outside = (event: MouseEvent) => {
      const dialog = dialogRef.current;
      if (!outsidePress.current) return;
      outsidePress.current = false;
      if (!dialog || !(event.target instanceof Element) || dialog.contains(event.target)) return;
      if (document.querySelector("dialog:modal") || event.target.closest("dialog, #ai-assistant-panel")) return;
      dismissDrawer();
    };
    document.addEventListener("pointerdown", pointerDown, true);
    document.addEventListener("click", outside);
    return () => { document.removeEventListener("pointerdown", pointerDown, true); document.removeEventListener("click", outside); };
  }, [size, modal, closeDisabled, onClose]);

  useDialogVisibilityEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (dialog) {
      const currentlyModal = dialog.matches(":modal");
      if (modal && !currentlyModal) {
        if (dialog.open) dialog.close();
        dialog.showModal();
      } else if (!modal && currentlyModal) {
        dialog.close();
        dialog.show();
      } else if (!modal && !dialog.open) {
        dialog.show();
      }
    }
    if (!modal && dialog) {
      requestAnimationFrame(() => {
        const firstControl = dialog.querySelector<HTMLElement>(
          "button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])"
        );
        (firstControl ?? dialog).focus({ preventScroll: true });
      });
    }
    return () => {
      if (previousFocus?.isConnected) previousFocus.focus();
      else {
        const fallback = document.querySelector<HTMLElement>("[data-testid='command-result-notice'], main h1, h1");
        if (fallback) {
          if (!fallback.hasAttribute("tabindex")) fallback.setAttribute("tabindex", "-1");
          fallback.focus();
        }
      }
    };
  }, [modal]);

  function trapFocus(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key === "Escape") {
      if (event.defaultPrevented || event.nativeEvent.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      dismissDrawer();
      return;
    }
    if (!modal) return;
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = [...dialog.querySelectorAll<HTMLElement>(
      "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])"
    )].filter((element) => !element.hidden
      && element.getAttribute("aria-hidden") !== "true"
      && element.getClientRects().length > 0);
    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !dialog.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <dialog
      className={`modal modal-${size}${className ? ` ${className}` : ""}`}
      ref={dialogRef}
      open={modal ? undefined : true}
      tabIndex={-1}
      aria-labelledby={titleId}
      onKeyDown={trapFocus}
      onChangeCapture={() => { edited.current = true; }}
      onClickCapture={(event) => {
        // Some form choices (for example a room picker) are buttons, not inputs.
        if (event.target instanceof Element && event.target.closest("form button")) edited.current = true;
      }}
      onPointerDown={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        outsidePress.current = event.target === event.currentTarget && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom);
      }}
      onClick={(event) => {
        if (size !== "drawer" || !outsidePress.current || event.target !== event.currentTarget) return;
        outsidePress.current = false;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dismissDrawer();
      }}
      onCancel={(event) => {
        event.preventDefault();
        dismissDrawer();
      }}
    >
      <div className="modal-shell">
        <header className="modal-header">
          <h2 id={titleId}>{title}</h2>
          <button className="icon-button" type="button" onClick={onClose} disabled={closeDisabled} aria-label="关闭" title="关闭">
            <X aria-hidden="true" size={20} />
          </button>
        </header>
        {modal && modalNotice ? <div className="modal-notice">{modalNotice}</div> : null}
        <div className="modal-body" tabIndex={0}><AssistantGuide />{children}</div>
        {footer ? <footer className="modal-footer">{footer}</footer> : null}
      </div>
    </dialog>
  );
}
