import type { Session } from "./types";

const messages: Record<string, string> = {
  PHONE_ALREADY_EXISTS: "本租户已有此手机号的客户，请在预订人下方选择已有档案；已填资料和选场已保留。",
  INVALID_CUSTOMER: "请填写可辨认的称呼；手机号可留空，填写时请使用有效手机号或带国家区号的号码。",
  INVALID_CREDENTIALS: "账号或密码不正确，请重新输入。",
  UNAUTHENTICATED: "登录已过期，请重新登录后核对原操作结果。",
  SESSION_EXPIRED: "登录已过期，请重新登录。",
  INVALID_CSRF: "页面登录信息已变化，请刷新后继续。",
  TENANT_ACCESS_DENIED: "当前账号没有该租户的操作权限。",
  VENUE_ACCESS_DENIED: "当前账号没有该场馆的操作权限。",
  RESOURCE_NOT_FOUND: "记录不存在或当前账号无权访问。",
  RESOURCE_UNAVAILABLE: "场馆或客户已停用，请重新核对。",
  COURT_OCCUPANCY_CONFLICT: "所选球场或时段已被占用，请刷新排场后重新选择。",
  INVENTORY_CONFLICT: "所选球场或时段已被占用，请刷新排场后重新选择。",
  QUOTE_EXPIRED: "报价已过期，请重新获取报价。",
  QUOTE_ALREADY_USED: "该报价已用于预订，请查询原订单。",
  PAST_INTERVAL: "不能预订已经开始的时段，请调整开始时间。",
  OUTSIDE_OPENING_HOURS: "所选时段超出场馆营业时间。",
  BELOW_MINIMUM_DURATION: "所选时长低于场馆设置的最短可售时长。",
  PRICE_NOT_CONFIGURED: "该球场尚未配置价格，请先设置价目。",
  STALE_ORDER: "订单已被其他操作更新，请刷新详情后重新核对。",
  STALE_CONFIGURATION: "设置已被修改，请刷新后重新编辑。",
  DISCOUNT_OVERLAP: "该折扣与已有规则在同片球场、同一时段重叠，请调整后再保存。",
  AFFECTED_OCCUPANCIES: "此调整会影响现有预订或占场，请先处理相关预约。",
  INSUFFICIENT_BALANCE: "可用余额不足，请减少余额支付金额或充值。",
  WALLET_INSUFFICIENT: "可用余额不足，不能透支。",
  ORDER_REQUIRES_REFUND: "该订单已有付款，请使用退款办理取消。",
  ORDER_NOT_CANCELLABLE: "当前订单状态不能直接取消，请刷新详情核对。",
  REFUND_EXCEEDS_PAYMENT: "退款金额超过剩余可退金额，请核对历史退款。",
  ORDER_NOT_REFUNDABLE: "当前订单不能退款，请核对付款和退款状态。",
  IDEMPOTENCY_KEY_REUSED: "此操作的提交内容已经变化，请先查询原操作结果。",
  TOPUP_REFERENCE_REUSED: "该收款凭证已经登记过，请核对原充值记录。",
  ASSISTANT_NOT_CONFIGURED: "AI 服务尚未配置完成，请联系平台运营管理员。",
  BACKOFFICE_MODEL_CONNECTION_NOT_ENABLED: "真实模型连接尚未启用，当前可保存配置并查看历史会话。",
  BACKOFFICE_ASSISTANT_NOT_CONFIGURED: "后台 AI 助手尚未配置，请联系平台运营管理员。",
  ASSISTANT_BUSY: "当前会话仍在生成回答，请先刷新会话核对。",
  ASSISTANT_UNAVAILABLE: "模型暂时无法完成回答，请核对会话记录后再试。",
  INVALID_MODEL_ENDPOINT: "模型服务地址无效，请填写可访问的 HTTPS 服务地址。",
  CONTEXT_CHANGED: "工作区已变化，请刷新当前页面。",
};
export class TennisApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message?: string,
  ) {
    super(
      messages[code] ??
        (message && /[\u3400-\u9fff]/.test(message)
          ? message
          : status === 403
            ? "当前账号没有执行此操作的权限。"
            : status >= 500
              ? "服务暂时不可用，提交结果需要核对。请查询原操作，勿另建重复交易。"
              : "本次操作未完成，请核对输入或刷新后重试。"),
    );
    this.name = "TennisApiError";
  }
  get uncertain() {
    return this.status >= 500 || this.status === 401;
  }
}
export type TennisApi = ReturnType<typeof createApi>;
export function createApi(session?: Session) {
  return async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (method !== "GET" && session) {
      headers["X-CSRF-Token"] = session.csrfToken;
      if (session.contextVersion !== undefined) headers["X-Workspace-Version"] = String(session.contextVersion);
    }
    let response: Response;
    try {
      response = await fetch(`/api/tennis${path}`, {
        method,
        headers,
        credentials: "same-origin",
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new Error("网络连接中断，提交结果尚未确认。请恢复网络后查询原操作，不要重复建立交易。");
    }
    let result: unknown;
    try {
      result = await response.json();
    } catch {
      // A committed write may have lost only its response body. Preserve its
      // original command key so recovery never becomes a second transaction.
      if (response.ok) throw new TennisApiError("RESULT_UNKNOWN", 502);
      result = null;
    }
    if (response.ok && method !== "GET" && (result === null || result === undefined)) {
      throw new TennisApiError("RESULT_UNKNOWN", 502);
    }
    if (!response.ok) {
      if (response.status === 401 && session) window.dispatchEvent(new Event("tennis-session-expired"));
      const error = (result as { error?: { code?: string; message?: string } } | null)?.error;
      throw new TennisApiError(error?.code ?? "REQUEST_FAILED", response.status, error?.message);
    }
    return result as T;
  };
}
export function errorText(error: unknown) {
  return error instanceof Error ? error.message : "操作未完成，请重试。";
}

export async function streamAssistant<T>(session: Session, path: string, body: unknown, signal: AbortSignal,
  onEvent: (event: { type: "status"; phase: "thinking" | "tool" } | { type: "delta"; text: string }) => void): Promise<T> {
  const response = await fetch(`/api/tennis${path}`, { method: "POST", credentials: "same-origin", signal,
    headers: { Accept: "text/event-stream", "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken, "X-Workspace-Version": String(session.contextVersion) }, body: JSON.stringify(body) });
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event("tennis-session-expired"));
    const error = await response.json().catch(() => ({})) as { error?: { code?: string } };
    throw new TennisApiError(error.error?.code ?? "ASSISTANT_UNAVAILABLE", response.status);
  }
  if (response.headers.get("content-type")?.includes("application/json")) return response.json() as Promise<T>;
  const reader = response.body?.getReader();
  if (!reader) throw new TennisApiError("RESULT_UNKNOWN", 502);
  let pending = "", size = 0;
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      size += value?.length ?? 0;
      if (size > 1_000_000) throw new TennisApiError("ASSISTANT_UNAVAILABLE", 502);
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, end).trim(); pending = pending.slice(end + 1);
        if (!line.startsWith("data:")) continue;
        const event = JSON.parse(line.slice(5));
        if (event.type === "result") return event.result as T;
        if (event.type === "error") throw new TennisApiError(event.code, 409);
        if (event.type === "status" || event.type === "delta") onEvent(event);
      }
      if (done) throw new TennisApiError("RESULT_UNKNOWN", 502);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
