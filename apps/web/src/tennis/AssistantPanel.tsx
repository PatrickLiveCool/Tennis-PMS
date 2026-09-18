import { useEffect, useRef, useState } from "react";
import { MessageCircle, Plus, Send } from "lucide-react";
import type { TennisApi } from "./api";
import type { Session, VenueRecord, AssistantStatus } from "./types";
import { dateTime, ErrorNotice, LoadingBlock, Modal, useLoad } from "./components";

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
