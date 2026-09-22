import type { Session } from "./types";

const messages: Record<string, string> = {
  PHONE_ALREADY_EXISTS: "这个手机号已有客户档案，请选择已有客户。",
  INVALID_CUSTOMER: "请填写可辨认的姓名，并检查手机号格式。",
  BOOKING_PHONE_REQUIRED: "请补充有效的 11 位手机号，再核对报价。",
  BOOKING_PHONE_ALREADY_SET: "这位客户已留手机号，请重新选择；如需改号，请联系管理员。",
  INVALID_CREDENTIALS: "账号或密码不正确，请重新输入。",
  UNAUTHENTICATED: "登录已过期，请重新登录后核对原操作结果。",
  SESSION_EXPIRED: "登录已过期，请重新登录。",
  INVALID_CSRF: "页面登录信息已变化，请刷新后继续。",
  TENANT_ACCESS_DENIED: "你没有这家商家的操作权限，请联系管理员。",
  VENUE_ACCESS_DENIED: "当前账号没有该场馆的操作权限。",
  RESOURCE_NOT_FOUND: "记录不存在或当前账号无权访问。",
  RESOURCE_UNAVAILABLE: "场馆或客户已停用，请重新核对。",
  COURT_OCCUPANCY_CONFLICT: "所选球场或时段已被占用，请刷新排场后重新选择。",
  INVENTORY_CONFLICT: "所选球场或时段已被占用，请刷新排场后重新选择。",
  QUOTE_EXPIRED: "报价已过期，请重新获取报价。",
  QUOTE_ALREADY_USED: "该报价已用于预订，请查询原订单。",
  PAST_INTERVAL: "不能预订已经开始的时段，请调整开始时间。",
  OUTSIDE_OPENING_HOURS: "所选时段超出场馆营业时间。",
  BELOW_MINIMUM_DURATION: "预订时间太短，请增加时长。",
  PRICE_NOT_CONFIGURED: "这片球场还没设置价格，请联系管理员。",
  COURT_DETAILS_INCOMPLETE: "请补齐球场名称、小时价格、场地环境、材质和规格后再保存或预订。",
  STALE_ORDER: "订单有更新，请刷新后再操作。",
  STALE_CONFIGURATION: "设置已被修改，请刷新后重新编辑。",
  DISCOUNT_OVERLAP: "这个时段已有折扣，请调整时间或球场后再保存。",
  AFFECTED_OCCUPANCIES: "此调整会影响现有预订或占场，请先处理相关预约。",
  INSUFFICIENT_BALANCE: "可用余额不足，请减少余额支付金额或充值。",
  WALLET_INSUFFICIENT: "可用余额不足，不能透支。",
  ORDER_REQUIRES_REFUND: "该订单已有付款，请使用退款办理取消。",
  ORDER_NOT_CANCELLABLE: "当前订单状态不能直接取消，请刷新详情核对。",
  REFUND_EXCEEDS_PAYMENT: "退款金额超过剩余可退金额，请核对历史退款。",
  ORDER_NOT_REFUNDABLE: "当前订单不能退款，请核对付款和退款状态。",
  IDEMPOTENCY_KEY_REUSED: "上一次提交还需要核对，请先查看办理结果。",
  TOPUP_REFERENCE_REUSED: "该收款凭证已经登记过，请核对原充值记录。",
  ASSISTANT_NOT_CONFIGURED: "AI 助手尚未启用，请联系管理员。",
  BACKOFFICE_MODEL_CONNECTION_NOT_ENABLED: "AI 助手暂时无法回答，可以查看历史对话。",
  BACKOFFICE_ASSISTANT_NOT_CONFIGURED: "AI 助手尚未启用，请联系管理员。",
  ASSISTANT_BUSY: "助手还在回答，请稍后刷新对话。",
  ASSISTANT_UNAVAILABLE: "助手暂时无法回答，请刷新对话后再试。",
  INVALID_MODEL_ENDPOINT: "模型服务地址无效，请填写可访问的 HTTPS 服务地址。",
  CONTEXT_CHANGED: "当前场馆或账号已切换，请刷新页面。",
  WORKSPACE_CHANGED: "当前商家已切换，请刷新后重试。",
  SELECT_TENANT: "请先选择商家。",
  AUTH_CONTEXT_REVOKED: "当前账号权限有变化，请重新选择商家或登录。",
  INVALID_TENANT_STATUS: "请核对商家状态，并填写原因。",
  STALE_TENANT_STATUS: "商家状态有更新，请刷新后重试。",
  LAST_TENANT_ADMIN: "至少要保留一名可用的商家管理员。",
  GATEWAY_ACCESS_REVOKED: "渠道接入或账号绑定已失效，请联系管理员。",
  GATEWAY_SCOPE_CHANGED: "这段会话已转人工或更换场馆，请先查看办理结果。",
  GATEWAY_GRANT_CLOSED: "这次办理授权已结束，请查看已有结果，不要另建一笔。",
  AGENT_DELEGATION_REVOKED: "助手的办理授权已结束，请刷新会话。",
  AGENT_SCOPE_DENIED: "助手没有这个场馆的办理权限。",
  ASSISTANT_RESULT_UNKNOWN: "助手还没确认办理结果，请先核对订单和付款，避免重复办理。",
  REFUND_EVENT_REUSED: "这笔退款结果已用于其他记录，请核对原退款。",
  WECOM_TARGET_MISMATCH: "收款的商家、金额或收款账户与所选付款不一致，请重新核对。",
  WECOM_REFERENCE_MISMATCH: "收款附带的付款编号与所选记录不一致。",
  UNPAID_ORDER_PAYMENT_UNRESOLVED: "这笔订单的付款还需要核对，请先查看付款结果。",
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
              ? "暂时连不上服务，请先查看上次办理结果，避免重复提交。"
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
      throw new Error("网络断开了。请联网后先查看上次办理结果，避免重复提交。");
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
