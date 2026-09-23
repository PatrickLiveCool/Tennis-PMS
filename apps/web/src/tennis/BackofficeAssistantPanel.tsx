import type { BackofficeAction, BackofficeContext } from "../../../../packages/db/src/tennis/backoffice-assistant";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { ChevronRight, MessageSquare, Plus, Send, Sparkles, Square, X } from "lucide-react";
import { TennisApiError, streamAssistant } from "./api";
import { AssistantDock } from "./AssistantDock";
import { InfoHint } from "./InfoHint";
const LazyMessageContent = lazy(() => import("../assistant/AssistantMessageContent").then((module) => ({ default: module.AssistantMessageContent })));
function AssistantMessageContent({ text }: { text: string }) {
  return <Suspense fallback={<div className="assistant-message-text">{text}</div>}><LazyMessageContent text={text} /></Suspense>;
}
import "./assistant.css";
import type { AssistantPanelProps } from "./AssistantPanel";
import { permits, type AssistantStatus } from "./types";
import { dateTime, ErrorNotice, LoadingBlock, Modal, useDraft, useLoad, readStored, writeStored } from "./components";

interface Conversation {
  id: string;
  tenantId: string;
  venueId: string;
  subjectId: string;
  updatedAt: string;
}
type Entry = BackofficeAction;
interface ConversationView {
  conversation: Conversation;
  messages: {
    id: string;
    role: "USER" | "ASSISTANT";
    content: string;
    createdAt: string;
    resolved: boolean | null;
    actions?: Entry[];
  }[];
  requests: {
    id: string;
    messageId: string;
    status: "RUNNING" | "SUCCEEDED" | "FAILED";
    errorCode?: string;
    createdAt: string;
    completedAt?: string;
  }[];
}
interface MessageDraft {
  content: string;
  pending: { messageId: string; content: string; context: BackofficeContext; source?: "USER" | "SUGGESTION" } | null;
}
const base = "/backoffice-assistant";

export function BackofficeAssistantPanel(props: AssistantPanelProps) {
  return <Workspace key={`${props.scope}:${props.session.contextVersion}:${props.venue.id}`} {...props} />;
}
function Workspace({ api, session, venue, scope, context, onClose, onNavigate, onPrepare, open = true }: AssistantPanelProps) {
  function workContext(): BackofficeContext {
    if (context.page !== "booking" && context.page !== "schedule") return context;
    const booking = readStored<{ date?: string; lines?: NonNullable<BackofficeContext["selection"]> }>(`tennis:booking:${scope}`, {});
    return { ...context, ...(booking.date ? { date: booking.date } : {}), viewDays: readStored(`tennis:view-days:${scope}`, 3), selection: booking.lines ?? [] };
  }
  const activeContext = workContext();
  const status = useLoad(() => api<AssistantStatus>(`${base}/status`), [api]);
  const conversations = useLoad(
    () => api<Conversation[]>(`${base}/conversations?${new URLSearchParams({ venueId: venue.id })}`),
    [api, venue.id],
  );
  const [selected, setSelected] = useDraft(`tennis:backoffice-selected:${scope}:${session.contextVersion}`, "");
  const details = useLoad(
    () => selected ? api<ConversationView>(`${base}/conversations/${encodeURIComponent(selected)}`) : Promise.resolve(null),
    [api, selected],
  );
  const current = details.data?.conversation.id === selected ? details.data : undefined;
  const [draft, setDraft] = useDraft<MessageDraft>(`tennis:backoffice-message:${scope}:${session.contextVersion}:${selected}`, { content: "", pending: null });
  const latestDraft = useRef(draft);
  latestDraft.current = draft;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [notice, setNotice] = useState("");
  const [partial, setPartial] = useState("");
  const [progress, setProgress] = useState("正在思考…");
  const [mobile, setMobile] = useState(() => window.matchMedia("(max-width: 720px)").matches);
  const controller = useRef<AbortController | null>(null);
  const messagesRef = useRef<HTMLDivElement>(null), readingPosition = useRef(0), followResponse = useRef(true), composing = useRef(false);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 720px)");
    const change = () => setMobile(query.matches);
    query.addEventListener("change", change); return () => query.removeEventListener("change", change);
  }, []);
  useEffect(() => { if (open && followResponse.current && messagesRef.current) messagesRef.current.scrollTop = messagesRef.current.scrollHeight; }, [current, partial, busy, open]);
  const [feedbackBusy, setFeedbackBusy] = useState<string | null>(null);
  const running = useRef(false);
  const feedbackRunning = useRef(false);
  const mounted = useRef(true);
  const active = useRef(selected);
  active.current = selected;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; controller.current?.abort(); };
  }, []);
  useEffect(() => {
    if (!selected && conversations.data?.length) setSelected(conversations.data[0]!.id);
  }, [conversations.data, selected]);
  useEffect(() => {
    setError(undefined);
    setNotice("");
  }, [selected]);

  const autoStarted = useRef(false);
  useEffect(() => {
    if (open && !selected && conversations.data?.length === 0 && status.data?.configured && !autoStarted.current) {
      autoStarted.current = true;
      void create(true);
    }
  }, [open, selected, conversations.data, status.data?.configured]);

  // Read an existing request after reconnecting. A model call is never repeated by polling.
  const pendingRequest = current?.requests.find((request) => request.messageId === draft.pending?.messageId);
  const generating = current?.requests.some((request) => request.status === "RUNNING") ?? false;
  useEffect(() => {
    if (!draft.pending || !pendingRequest || pendingRequest.status === "RUNNING") return;
    if (pendingRequest.status === "SUCCEEDED") {
      setDraft((value) => ({ ...value, pending: null }));
      setNotice("已找回原消息的回答。");
    } else {
      setDraft((value) => ({ ...value, pending: null }));
      setNotice("上次回答未完成，原问题已保留。可以重新发送。");
    }
  }, [pendingRequest?.id, pendingRequest?.status, draft.pending?.messageId]);
  useEffect(() => {
    if (!generating || busy) return;
    const timer = window.setTimeout(() => void details.refresh(), 3000);
    return () => window.clearTimeout(timer);
  }, [generating, busy, current, details.refresh]);

  async function refresh() {
    await Promise.allSettled([details.refresh(), conversations.refresh(), status.refresh()]);
  }
  async function create(carryInput = false) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(undefined);
    const startedFor = selected;
    try {
      const result = await api<Conversation>(`${base}/conversations`, "POST", { venueId: venue.id });
      if (carryInput) writeStored(`tennis:backoffice-message:${scope}:${session.contextVersion}:${result.id}`, { content: latestDraft.current.content, pending: null });
      if (!mounted.current || active.current !== startedFor) return;
      setSelected(result.id);
      await conversations.refresh();
    } catch (next) {
      if (mounted.current && active.current === startedFor) setError(next);
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function send(prompt?: string) {
    if (running.current || !current || (!(prompt ?? draft.content).trim() && !draft.pending) || !status.data?.configured || details.busy || details.error || generating) return;
    running.current = true;
    setBusy(true);
    setError(undefined);
    setNotice("");
    const conversationId = selected;
    const request = draft.pending ?? { messageId: crypto.randomUUID(), content: (prompt ?? draft.content).trim(), context: workContext(), source: prompt === undefined ? "USER" as const : "SUGGESTION" as const };
    const isCurrent = () => mounted.current && active.current === conversationId;
    setDraft({ content: "", pending: request });
    setPartial(""); setProgress("正在思考…"); followResponse.current = true;
    const activeController = new AbortController(); controller.current = activeController;
    try {
      const result = await streamAssistant<ConversationView>(session, `${base}/conversations/${encodeURIComponent(conversationId)}/messages`, request, activeController.signal, (event) => {
        if (!isCurrent() || activeController.signal.aborted) return;
        if (event.type === "status") { setPartial(""); setProgress(event.phase === "tool" ? "正在查询资料…" : "正在思考…"); }
        else { setPartial((text) => text + event.text); setProgress("正在回答…"); }
      });
      if (!isCurrent()) return;
      const receipt = result.requests.find((item) => item.messageId === request.messageId);
      if (receipt?.status === "SUCCEEDED") setDraft((value) => ({ ...value, pending: null }));
      else if (receipt?.status === "FAILED") {
        setDraft((value) => ({ content: value.content || request.content, pending: null }));
        setNotice("本次回答未完成，问题已保留。可以重新发送。");
      }
    } catch (next) {
      if (isCurrent()) {
        setDraft((value) => ({ ...value, content: value.content || request.content }));
        if (activeController.signal.aborted) setNotice("已停止生成，问题已保留。");
        else setError(next);
        if (next instanceof TennisApiError && !next.uncertain && !draft.pending) {
          setDraft((value) => ({ ...value, pending: null }));
        }
      }
    } finally {
      if (isCurrent()) { setPartial(""); controller.current = null; }
      if (isCurrent()) await Promise.allSettled([details.refresh(), conversations.refresh()]);
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function feedback(messageId: string, resolved: boolean) {
    if (feedbackRunning.current) return;
    feedbackRunning.current = true;
    setFeedbackBusy(messageId);
    setError(undefined);
    const conversationId = selected;
    try {
      await api(`${base}/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/feedback`, "POST", { resolved });
      if (mounted.current && active.current === conversationId) await details.refresh();
    } catch (next) {
      if (mounted.current && active.current === conversationId) setError(next);
    } finally {
      feedbackRunning.current = false;
      if (mounted.current) setFeedbackBusy(null);
    }
  }
  const canSend = !!current && !busy && !details.busy && !details.error && !generating && !!status.data?.configured && (!!draft.content.trim() || !!draft.pending);
  const suggestions = context.orderId ? [
    "请帮我核对这笔订单的球场、时段和付款状态。",
    "这笔订单如需改期或退款，下一步该怎么办？",
  ] : [
    activeContext.selection?.length ? "帮我核对已选时段，准备预订。" : "帮我查看当前日期有哪些空场。",
    "如何查询场地价格和时段折扣？",
    "客户说已经付款，应该怎样核对收款记录？",
  ];
  function apply(entry: Entry) {
    if (!entry.preparation) return;
    if (entry.orderId) {
      if (entry.orderId === context.orderId && onPrepare) onPrepare(entry);
      else window.dispatchEvent(new CustomEvent("tennis-open-order", { detail: { scope, orderId: entry.orderId, preparation: entry } }));
      return;
    }
    writeStored(`tennis:assistant-preparation:${scope}`, entry);
    window.dispatchEvent(new CustomEvent("tennis-assistant-preparation", { detail: { scope } }));
    onNavigate?.("booking");
  }
  const displayedOrderId = draft.pending ? draft.pending.context.orderId : context.orderId;
  const directory = conversations.data ?? [];
  const selectedInDirectory = directory.some((item) => item.id === selected);
  return (
    <AssistantDock open={open} onClose={onClose} messagesRef={messagesRef} readingPosition={readingPosition}>
      <header className="assistant-header">
        <div><Sparkles size={18} aria-hidden="true" /><strong>AI 助手</strong><InfoHint label="助手使用说明">可以查空场、核对订单、准备预订和退改。办理前仍需你确认。</InfoHint></div>
        <div>
          <button type="button" className="icon-button" aria-label="新建对话" title="新建对话" disabled={busy || generating} onClick={() => void create()}><Plus size={18} /></button>
          <button type="button" className="icon-button" aria-label="关闭 AI 助手" onClick={onClose}><X size={19} /></button>
        </div>
      </header>
      <div className="assistant-context">{venue.name} · {displayedOrderId ? "当前订单" : "场地排期"}
        {activeContext.date && <> · {activeContext.date} 起 {activeContext.viewDays} 天 · 已选 {activeContext.selection?.length ?? 0} 条时段</>}
      </div>
      <details className="assistant-history"><summary>历史对话</summary>
        <select aria-label="选择后台助手会话" value={selected} disabled={busy} onChange={(event) => { readingPosition.current = 0; followResponse.current = true; setSelected(event.target.value); }}>
          <option value="">选择会话</option>
          {selected && !selectedInDirectory && <option value={selected}>当前会话</option>}
          {directory.map((item, index) => <option key={item.id} value={item.id}>{dateTime(item.updatedAt, venue.timezone)} · 对话 {index + 1}</option>)}
        </select>
        <button className="button button-secondary button-small" disabled={busy || details.busy} onClick={() => void refresh()}>刷新会话</button>
      </details>
      <div className="assistant-messages" ref={messagesRef} role="log" aria-label="后台助手会话" aria-live="polite" aria-busy={busy || generating}
        onScroll={(event) => { const el = event.currentTarget; if (!el.isConnected || !el.getClientRects().length) return; readingPosition.current = el.scrollTop; followResponse.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60; }}>
        {!current?.messages.length && !draft.pending && <div className="assistant-welcome">
          <MessageSquare size={27} aria-hidden="true" /><h2>需要帮你做什么？</h2>
          <p>查空场、看订单，或告诉我你想做什么。</p>
          {!status.busy && !status.data?.configured && !status.error && <p className="assistant-notice">助手尚未启用，请联系平台管理员。</p>}
          <div className="assistant-suggestions">{suggestions.map((question, index) => <button key={question} type="button" disabled={busy || !current || !status.data?.configured} onClick={() => void send(question)}>
            <span><strong>{context.orderId ? ["核对这笔订单", "办理改期与退款"][index] : [activeContext.selection?.length ? "准备已选时段的预订" : "查找可预订空场", "核对场地价格", "核对订单与收款"][index]}</strong></span><ChevronRight size={16} aria-hidden="true" />
          </button>)}</div>
        </div>}
        {selected && details.busy && !current && <LoadingBlock label="正在读取助手会话" />}
        {current?.messages.map((message) => <article key={message.id} className={`assistant-message assistant-message-${message.role === "USER" ? "user" : "assistant"}`}>
          <span className="assistant-message-author">{message.role === "USER" ? "你" : "AI 助手"}</span>
          {message.role === "ASSISTANT" ? <AssistantMessageContent text={message.content} /> : <div className="assistant-message-text">{message.content}</div>}
          {message.actions?.map((entry, index) => {
            const destination = entry.page === "schedule" ? "booking" : entry.page;
            if ((entry.page === "members" && !permits(session, "manage_members")) || !["schedule", "orders", "members", "settings"].includes(entry.page)) return null;
            return <div className="assistant-entry" key={index}>
              <button type="button" className="button button-secondary" disabled={!!entry.preparation && (busy || !permits(session, entry.preparation.kind === "refund" ? "refund" : "book"))} onClick={() => {
                if (entry.preparation) apply(entry);
                else if (entry.orderId) window.dispatchEvent(new CustomEvent("tennis-open-order", { detail: { scope, orderId: entry.orderId } }));
                else onNavigate?.(destination);
              }}>{entry.label}</button>
              {entry.preparation && <InfoHint label="办理前确认">点击后打开表单，核对并确认后才会办理。</InfoHint>}
            </div>;
          })}
          {message.role === "ASSISTANT" && <div className="assistant-feedback">
            <div role="group" aria-label="这条回答是否解决了问题"><span>是否解决了问题？</span>
              <button type="button" aria-pressed={message.resolved === true} disabled={feedbackBusy !== null} onClick={() => void feedback(message.id, true)}>已解决</button>
              <button type="button" aria-pressed={message.resolved === false} disabled={feedbackBusy !== null} onClick={() => void feedback(message.id, false)}>未解决</button>
            </div><span className="assistant-feedback-status" role="status">{feedbackBusy === message.id ? "正在保存…" : message.resolved !== null ? "反馈已记录" : ""}</span>
          </div>}
        </article>)}
        {draft.pending && !current?.requests.some((request) => request.messageId === draft.pending?.messageId) && <article className="assistant-message assistant-message-user"><span className="assistant-message-author">你</span><div className="assistant-message-text">{draft.pending.content}</div></article>}
        {busy && partial && <article className="assistant-message assistant-message-assistant"><span className="assistant-message-author">AI 助手 · 回答中</span><AssistantMessageContent text={partial} /></article>}
        {(busy || generating) && <p className="assistant-wait" role="status">{busy ? progress : "正在找回回答…"}</p>}
        {notice && <p className="assistant-notice" role="status">{notice}</p>}
        {draft.pending && !busy && !generating && <p className="assistant-notice">上一条回答尚未确认，请刷新查看或重试。</p>}
        <ErrorNotice error={error ?? details.error ?? conversations.error ?? status.error} retry={() => void refresh()} />
      </div>
      <form className="assistant-composer" onSubmit={(event) => { event.preventDefault(); void send(); }}>
        <label className="sr-only" htmlFor="assistant-question">后台助手消息</label>
        <textarea id="assistant-question" rows={3} maxLength={8000} value={draft.content} placeholder="描述你想完成的事情…"
          onChange={(event) => setDraft((value) => ({ ...value, content: event.target.value }))}
          onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
          onKeyDown={(event) => {
            if (mobile || event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
            event.preventDefault(); if (!event.repeat && canSend) void send();
          }} />
        <div><div className="assistant-composer-help"><InfoHint label="发送快捷键">{mobile ? "回车换行，点击发送。" : "回车发送，Shift + 回车换行。"}</InfoHint></div>
          {busy ? <button className="button button-secondary" type="button" onClick={() => controller.current?.abort()}><Square size={14} />停止生成</button>
            : <button className="button button-primary" type="submit" disabled={!canSend}><Send size={16} />{draft.pending ? "重试上一条" : "发送"}</button>}
        </div>
      </form>
    </AssistantDock>
  );
}
