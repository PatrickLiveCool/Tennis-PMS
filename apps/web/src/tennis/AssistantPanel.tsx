import { useCallback, useEffect, useRef, useState } from "react";
import { MessageCircle, Plus, Send } from "lucide-react";
import type { TennisApi } from "./api";
import type { AgentRequestDetail, AgentRequestSummary } from "../../../../packages/db/src/tennis/external-agent";
import type { Session, VenueRecord, AssistantStatus } from "./types";
import { Badge, dateTime, ErrorNotice, LoadingBlock, Modal, Panel, RefreshButton, useLoad } from "./components";

interface Conversation {
  id: string;
  subjectId: string;
  mode: "AGENT" | "HUMAN";
  generation: number;
  takenBy: string | null;
  updatedAt: string;
}
interface FeedbackResult {
  conversationId: string;
  messageId: string;
  resolved: boolean;
  updatedAt: string;
}
interface FeedbackState {
  resolved?: boolean;
  busy: boolean;
  error?: unknown;
}
interface ConversationView {
  conversation: Conversation;
  messages: { id: string; role: string; content: string; createdAt: string; feedback?: boolean | null }[];
}
const requestStatusLabels: Record<AgentRequestSummary["dispatchStatus"], string> = {
  IN_FLIGHT: "未收到处理结束回报",
  SUCCEEDED: "已收到处理结束回报",
  UNCERTAIN: "结果待核对",
  ISSUED: "请求已签发",
};
const commandLabels: Record<string, string> = {
  "quote.confirm": "确认预订并占位",
  "order.payment": "订单付款",
  "order.cancel_unpaid": "取消未付款预订",
  "order.cancel_unpaid_lines": "取消未付款明细",
  "order.cancel_free_lines": "取消无需付款明细",
  "order.refund": "订单退款",
  "order.refund_group": "订单退款",
  "amendment.confirm": "确认改期",
  "amendment.cancel": "取消改期",
  "amendment.payment": "改期补款",
  "topup.begin": "线上充值",
  "wallet.offline_topup": "登记线下充值",
  "refund.retry": "重试退款",
};
const resourceLabels: Record<string, string> = {
  order: "订单",
  payment: "付款",
  topup: "充值",
  refund: "退款",
  "refund-group": "退款申请",
  amendment: "改期",
  "wallet-batch": "充值批次",
};
function ConversationRequests({
  api,
  conversationId,
  timezone,
  refreshVersion,
}: {
  api: TennisApi;
  conversationId: string;
  timezone: string;
  refreshVersion: string;
}) {
  const [page, setPage] = useState<{ items: AgentRequestSummary[]; nextCursor: string | null }>();
  const [selected, setSelected] = useState<AgentRequestSummary | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<unknown>();
  const serial = useRef(0);
  const path = `/assistant/conversations/${encodeURIComponent(conversationId)}/requests`;
  const loadPage = useCallback(
    async (cursor?: string) => {
      const current = ++serial.current;
      setBusy(true);
      try {
        const next = await api<{ items: AgentRequestSummary[]; nextCursor: string | null }>(
          `${path}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
        );
        if (current !== serial.current) return;
        setPage((previous) => ({
          items: cursor
            ? [...new Map([...(previous?.items ?? []), ...next.items].map((item) => [item.requestId, item])).values()]
            : next.items,
          nextCursor: next.nextCursor,
        }));
        setSelected((previous) =>
          previous
            ? (next.items.find((item) => item.requestId === previous.requestId) ?? previous)
            : (next.items[0] ?? null),
        );
        setError(undefined);
      } catch (next) {
        if (current === serial.current) setError(next);
      } finally {
        if (current === serial.current) setBusy(false);
      }
    },
    [api, path],
  );
  useEffect(() => {
    void loadPage();
    return () => {
      serial.current++;
    };
  }, [loadPage, refreshVersion]);
  const detail = useLoad(
    () =>
      selected ? api<AgentRequestDetail>(`${path}/${encodeURIComponent(selected.requestId)}`) : Promise.resolve(null),
    [api, path, selected?.requestId, refreshVersion],
  );
  const current = detail.data?.requestId === selected?.requestId ? detail.data : null;
  const items =
    selected && !page?.items.some((item) => item.requestId === selected.requestId)
      ? [selected, ...(page?.items ?? [])]
      : (page?.items ?? []);
  function refresh() {
    void loadPage();
    void detail.refresh();
  }
  return (
    <Panel title="办理记录" action={<RefreshButton busy={busy || detail.busy} onClick={refresh} />}>
      <p className="tennis-muted">按本次会话核对已登记的业务操作和最新状态。刷新仅查询记录，不会重新办理。</p>
      <ErrorNotice error={error} retry={refresh} />
      {!!error && page && <p className="tennis-muted">列表刷新未成功，以下仍为上次读取的记录。</p>}
      {busy && !page ? (
        <LoadingBlock />
      ) : !page?.items.length && !selected && !error ? (
        <p className="tennis-muted">此会话暂无办理记录。</p>
      ) : null}
      {items.length > 0 && (
        <>
          <div className="tennis-toolbar">
            <label>
              选择办理请求
              <select
                aria-label="选择办理请求"
                value={selected?.requestId ?? ""}
                onChange={(event) => setSelected(items.find((item) => item.requestId === event.target.value) ?? null)}
              >
                {items.map((item) => (
                  <option value={item.requestId} key={item.requestId}>
                    {dateTime(item.createdAt, timezone)} · {requestStatusLabels[item.dispatchStatus]} ·{" "}
                    {item.commandCount} 项操作 · {item.requestId.slice(0, 8)}
                  </option>
                ))}
              </select>
            </label>
            {page?.nextCursor && (
              <button
                type="button"
                className="button button-secondary"
                disabled={busy}
                onClick={() => void loadPage(page.nextCursor!)}
              >
                {busy ? "读取中…" : "加载更早记录"}
              </button>
            )}
          </div>
          <ErrorNotice error={detail.error} retry={() => void detail.refresh()} />
          {detail.busy ? (
            <LoadingBlock />
          ) : current ? (
            <>
              {!!detail.error && (
                <p className="tennis-note">本次核对未成功，以下为上次读取的状态，请重新读取后再判断。</p>
              )}
              <p style={{ overflowWrap: "anywhere" }}>
                请求编号：<code>{current.requestId}</code>
              </p>
              <p>
                回报状态：{requestStatusLabels[current.dispatchStatus]} · 已登记 {current.commandCount} 项操作
              </p>
              {(current.dispatchStatus === "UNCERTAIN" || current.dispatchStatus === "IN_FLIGHT") && (
                <p className="tennis-note">
                  回报未确认，不代表业务没有执行。请核对下方业务编号及当前状态，必要时交由工作人员处理。
                </p>
              )}
              <p className="tennis-muted">
                处理回报与付款结果分别核对；订单是否成立、款项是否到账，以业务记录的当前状态为准。
              </p>
              {current.commands.map((command) => (
                <article key={command.commandKey} style={{ marginTop: 12 }}>
                  <strong>{commandLabels[command.commandType] ?? command.commandType}</strong>
                  <span className="tennis-muted"> · {dateTime(command.completedAt, timezone)}</span>
                  <p style={{ overflowWrap: "anywhere" }}>
                    操作编号：<code>{command.commandKey}</code>
                  </p>
                  {command.resources.length ? (
                    <ul>
                      {command.resources.map((resource) => (
                        <li
                          key={`${resource.type}:${resource.id}`}
                          style={{ marginBottom: 8, overflowWrap: "anywhere" }}
                        >
                          {resourceLabels[resource.type] ?? resource.type}：<code>{resource.id}</code>{" "}
                          {resource.status === "CREDITED" ? (
                            "已入账"
                          ) : resource.status === "RECORDED" ? (
                            "已登记"
                          ) : (
                            <Badge value={resource.status} />
                          )}
                          {resource.paymentStatus && (
                            <>
                              {" "}
                              · 付款：
                              <Badge value={resource.paymentStatus} />
                            </>
                          )}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="tennis-muted">操作已登记；没有可展示的关联业务记录。</p>
                  )}
                </article>
              ))}
              {current.restrictedCommandCount > 0 && (
                <p className="tennis-note">
                  有 {current.restrictedCommandCount} 项操作当前无权查看，请由有权限的工作人员核对。
                </p>
              )}
              {!current.commandCount && (
                <p className="tennis-muted">尚未查询到已登记的业务操作。仅凭此信息不能判断原请求是否执行。</p>
              )}
            </>
          ) : null}
        </>
      )}
    </Panel>
  );
}

export interface AssistantPanelProps {
  api: TennisApi;
  session: Session;
  venue: VenueRecord;
  scope: string;
  context: { page: string; orderId?: string };
  onClose: () => void;
}
export function AssistantPanel({ api, session, venue, context, onClose }: AssistantPanelProps) {
  const status = useLoad(() => api<AssistantStatus>("/assistant/status"), [api]);
  const conversations = useLoad(
    () => api<Conversation[]>(`/assistant/conversations?venueId=${encodeURIComponent(venue.id)}`),
    [api, venue.id],
  );
  const [selected, setSelected] = useState("");
  const details = useLoad(
    () => (selected ? api<ConversationView>(`/assistant/conversations/${selected}`) : Promise.resolve(null)),
    [api, selected],
  );
  const [content, setContent] = useState(""),
    [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>();
  const [feedback, setFeedback] = useState<Record<string, FeedbackState>>({});
  const feedbackRunning = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const running = useRef(false),
    pending = useRef<{ id: string; content: string; conversationId: string } | null>(null);
  useEffect(() => {
    if (!selected && conversations.data?.length)
      setSelected(
        (conversations.data.find((value) => value.subjectId === session.subjectId) ?? conversations.data[0])!.id,
      );
  }, [conversations.data, selected, session.subjectId]);
  const current = details.data?.conversation.id === selected ? details.data : null;
  async function run(work: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await work();
    } catch (next) {
      setError(next);
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  async function create() {
    await run(async () => {
      const item = await api<Conversation>("/assistant/conversations", "POST", { venueId: venue.id });
      pending.current = null;
      setContent("");
      setSelected(item.id);
      await conversations.refresh();
    });
  }
  async function send() {
    if (!current || !content.trim()) return;
    await run(async () => {
      if (
        pending.current &&
        (pending.current.conversationId !== selected || pending.current.content !== content.trim())
      )
        throw new Error("上一条消息的处理结果尚未确认，请先刷新会话或转人工核对。");
      pending.current ??= { id: crypto.randomUUID(), content: content.trim(), conversationId: selected };
      const request = pending.current;
      try {
        await api<ConversationView>(`/assistant/conversations/${selected}/messages`, "POST", {
          messageId: request.id,
          content: request.content,
          context,
        });
        pending.current = null;
        setContent("");
      } finally {
        await details.refresh();
        await conversations.refresh();
      }
    });
  }
  async function handoff(mode: "AGENT" | "HUMAN") {
    if (!selected || !reason.trim()) return;
    await run(async () => {
      await api(`/assistant/conversations/${selected}/handoff`, "POST", { mode, reason: reason.trim() });
      pending.current = null;
      setContent("");
      setReason("");
      await details.refresh();
      await conversations.refresh();
    });
  }
  async function submitFeedback(conversationId: string, messageId: string, resolved: boolean) {
    const key = `${conversationId}:${messageId}`;
    if (feedbackRunning.current.has(key)) return;
    feedbackRunning.current.add(key);
    setFeedback((previous) => ({ ...previous, [key]: { ...previous[key], busy: true, error: undefined } }));
    try {
      const result = await api<FeedbackResult>(
        `/assistant/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/feedback`,
        "POST",
        { resolved },
      );
      if (
        result.conversationId !== conversationId ||
        result.messageId !== messageId ||
        typeof result.resolved !== "boolean"
      )
        throw new Error("反馈结果尚未核实，请刷新会话后检查。");
      if (mounted.current)
        setFeedback((previous) => ({ ...previous, [key]: { resolved: result.resolved, busy: false } }));
    } catch (next) {
      if (mounted.current)
        setFeedback((previous) => ({ ...previous, [key]: { ...previous[key], busy: false, error: next } }));
    } finally {
      feedbackRunning.current.delete(key);
    }
  }
  const suggestions = context.orderId
    ? [
        "请帮我核对这笔订单的球场、时段和付款状态。",
        "这笔订单的费用是怎样计算的？",
        "这笔订单如需改期或退款，下一步该怎么办？",
      ]
    : [
        "帮我查询今天还有哪些可预订的球场和时段。",
        "订场费用怎样计算，当前有哪些时段折扣？",
        "我需要工作人员协助处理预订，请告诉我下一步。",
      ];
  const own = current?.conversation.subjectId === session.subjectId;
  const canSend = !!current && (current.conversation.mode === "HUMAN" || own) && !busy;
  return (
    <Modal title="AI 助手" size="wide" onClose={onClose} closeDisabled={busy}>
      <div className="tennis-assistant">
        <p className="tennis-muted">
          {venue.name} · {session.kind === "customer" ? "订场咨询与工作人员协助" : "当前工作区的咨询、预订与人工协作"}
        </p>
        {context.orderId && (
          <p className="tennis-note">
            正在询问订单 {context.orderId.slice(0, 8)}。关闭助手后可继续填写原订单表单；发送时会携带此订单上下文。
          </p>
        )}
        {!status.data?.configured && !status.busy && (
          <div className="tennis-note">
            AI 助手尚未连接外部服务。可以查看会话、留言并转人工协助；平台运营方配置后即可启用。
          </div>
        )}
        <ErrorNotice
          error={error ?? details.error ?? conversations.error ?? status.error}
          retry={() => {
            void details.refresh();
            void conversations.refresh();
          }}
        />
        <div className="tennis-toolbar">
          <label>
            会话
            <select
              aria-label="选择助手会话"
              value={selected}
              disabled={busy}
              onChange={(event) => {
                setSelected(event.target.value);
                setContent("");
                setReason("");
                setError(undefined);
                pending.current = null;
              }}
            >
              <option value="">选择会话</option>
              {conversations.data?.map((item) => (
                <option value={item.id} key={item.id}>
                  {item.subjectId === session.subjectId ? "我的会话" : "客户 / 同事会话"} ·{" "}
                  {item.mode === "HUMAN" ? "人工处理中" : "AI 协作"} · {dateTime(item.updatedAt, venue.timezone)}
                </option>
              ))}
            </select>
          </label>
          <button className="button button-secondary" disabled={busy} onClick={() => void create()}>
            <Plus size={16} />
            新建会话
          </button>
          <button
            className="button button-secondary"
            disabled={busy}
            onClick={() => {
              void details.refresh();
              void conversations.refresh();
            }}
          >
            刷新会话
          </button>
        </div>
        {selected && !current ? (
          <LoadingBlock />
        ) : (
          <div
            className="tennis-assistant-messages"
            role="log"
            aria-label="助手与人工协作会话"
            style={{ maxHeight: "42vh", overflowY: "auto", display: "grid", gap: 12, padding: "12px 0" }}
          >
            {!current?.messages.length && (
              <p className="tennis-muted">
                <MessageCircle size={18} />
                从场地咨询开始，也可以请求工作人员协助。
              </p>
            )}
            {current?.messages.map((message) => {
              const feedbackKey = `${current.conversation.id}:${message.id}`;
              const localFeedback = feedback[feedbackKey];
              const resolved = localFeedback?.resolved ?? message.feedback;
              return (
                <article
                  key={message.id}
                  className={`tennis-assistant-message is-${message.role}`}
                  style={{
                    padding: 12,
                    borderRadius: 10,
                    background: message.role === "user" ? "var(--tennis-tint, #edf5ef)" : "var(--tennis-surface, #fff)",
                    border: "1px solid var(--tennis-border, #dce5dc)",
                  }}
                >
                  <div className="tennis-muted">
                    {message.role === "assistant"
                      ? "AI 助手"
                      : message.role === "staff"
                        ? "工作人员"
                        : message.role === "system"
                          ? "处理记录"
                          : "提问"}{" "}
                    · {dateTime(message.createdAt, venue.timezone)}
                  </div>
                  <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: "8px 0 0" }}>
                    {message.content}
                  </p>
                  {message.role === "assistant" && (
                    <div style={{ marginTop: 12 }}>
                      <div className="tennis-actions" aria-label="回答反馈">
                        <button
                          type="button"
                          className="button button-secondary button-small"
                          aria-pressed={resolved === true}
                          disabled={localFeedback?.busy === true}
                          onClick={() => void submitFeedback(current.conversation.id, message.id, true)}
                        >
                          已解决
                        </button>
                        <button
                          type="button"
                          className="button button-secondary button-small"
                          aria-pressed={resolved === false}
                          disabled={localFeedback?.busy === true}
                          onClick={() => void submitFeedback(current.conversation.id, message.id, false)}
                        >
                          未解决
                        </button>
                        {localFeedback?.busy ? (
                          <span className="tennis-muted" role="status">
                            正在记录反馈…
                          </span>
                        ) : typeof resolved === "boolean" && !localFeedback?.error ? (
                          <span className="tennis-muted" role="status">
                            已记录：{resolved ? "已解决" : "未解决"}
                          </span>
                        ) : null}
                      </div>
                      <ErrorNotice error={localFeedback?.error} />
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
        {current && (
          <>
            <ConversationRequests
              key={`${session.tenantId}:${session.subjectId}:${session.contextVersion}:${venue.id}:${current.conversation.id}`}
              api={api}
              conversationId={current.conversation.id}
              timezone={venue.timezone}
              refreshVersion={current.conversation.updatedAt}
            />
            <div className="tennis-note">
              {current.conversation.mode === "HUMAN"
                ? "当前由工作人员处理，AI 操作已停止。"
                : own
                  ? "确认预订、付款或退改时，请以订单中的最新记录为准。"
                  : "先接管此会话，再以工作人员身份回复。"}
            </div>
            <div style={{ marginBottom: 12 }}>
              <p className="tennis-muted">常用提问 · 点击填入后可编辑，不会自动发送</p>
              <div className="tennis-actions" style={{ marginTop: 8 }}>
                {suggestions.map((question) => (
                  <button
                    key={question}
                    type="button"
                    className="button button-secondary button-small"
                    disabled={busy}
                    onClick={() => setContent((value) => (value.trim() ? `${value}\n${question}` : question))}
                  >
                    {question}
                  </button>
                ))}
              </div>
            </div>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void send();
              }}
            >
              <label>
                消息
                <textarea
                  aria-label="助手消息"
                  rows={3}
                  maxLength={8000}
                  value={content}
                  disabled={busy}
                  onChange={(event) => setContent(event.target.value)}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing &&
                      event.nativeEvent.keyCode !== 229 &&
                      canSend &&
                      content.trim() &&
                      (current.conversation.mode === "HUMAN" || status.data?.configured)
                    ) {
                      event.preventDefault();
                      void send();
                    }
                  }}
                  placeholder={
                    current.conversation.mode === "HUMAN" ? "给工作人员留言或回复客户" : "输入需要协助的事项"
                  }
                />
              </label>
              <div className="tennis-actions">
                <button
                  className="button button-primary"
                  type="submit"
                  disabled={
                    !canSend || !content.trim() || (current.conversation.mode === "AGENT" && !status.data?.configured)
                  }
                >
                  <Send size={16} />
                  {busy ? "处理中…" : "发送"}
                </button>
              </div>
            </form>
            <div className="tennis-toolbar">
              <label>
                处理原因
                <input
                  aria-label="人工协作原因"
                  maxLength={2000}
                  value={reason}
                  disabled={busy}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="说明需要协助或交回的原因"
                />
              </label>
              {(current.conversation.mode === "AGENT" || session.kind === "staff") && (
                <button
                  className="button button-secondary"
                  disabled={busy || !reason.trim()}
                  onClick={() => void handoff("HUMAN")}
                >
                  {session.kind === "customer" ? "转人工协助" : "人工接管"}
                </button>
              )}
              {session.kind === "staff" && current.conversation.mode === "HUMAN" && (
                <button
                  className="button button-secondary"
                  disabled={busy || !reason.trim()}
                  onClick={() => void handoff("AGENT")}
                >
                  核对后恢复 AI
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
