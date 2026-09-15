import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ChevronRight, MessageSquare, Plus, Send, Settings, Sparkles, X } from "lucide-react";
import { api } from "../api";
import { useWorkspace } from "../session";
import { errorMessage } from "../uiBasic";
import { assistantOrderActions, type AssistantChatReply, type AssistantEntry, type AssistantSettings, type AssistantQuestionFeedback } from "../../../../packages/contracts/src/assistant.ts";
import { AssistantContext, useAssistant } from "./context";
import { AssistantMessageContent } from "./AssistantMessageContent";
import { AssistantFeedback } from "./AssistantFeedback";
import "./assistant.css";

export function entryPath(entry: AssistantEntry): string | undefined {
  const paths = { inventory: "/", orders: "/orders", members: "/members", today: "/today", settings: "/settings/ai", order: "/orders" };
  if (!Object.hasOwn(paths, entry.page)) return undefined;
  if (entry.action && (entry.page !== "order" || !assistantOrderActions.includes(entry.action))) return undefined;
  if (entry.page === "order") return entry.orderId ? `/orders/${encodeURIComponent(entry.orderId)}` : undefined;
  if (entry.page === "members" && entry.memberId) return `/members?memberId=${encodeURIComponent(entry.memberId)}`;
  return paths[entry.page];
}
export function AssistantTrigger({ mobile = false }: { mobile?: boolean }) {
  const assistant = useAssistant();
  if (!assistant) return null;
  return <button type="button" className={`assistant-trigger${mobile ? " assistant-trigger-mobile" : ""}`} onClick={assistant.toggle} aria-expanded={assistant.open} aria-controls="ai-assistant-panel" aria-label="AI 助手" title="AI 助手"><Sparkles size={18} aria-hidden="true" /><span>AI 助手</span></button>;
}
interface Message { role: "user" | "assistant"; text: string; entries?: AssistantEntry[]; questionId?: string; feedback?: AssistantQuestionFeedback }
export function AssistantProvider({ children }: { children: ReactNode }) {
  const { propertyId } = useWorkspace(), location = useLocation(), navigate = useNavigate();
  const [open, setOpen] = useState(false), [settings, setSettings] = useState<AssistantSettings>();
  const [messages, setMessages] = useState<Message[]>([]), [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>();
  const [conversationId, setConversationId] = useState<string>();
  const [guide, setGuide] = useState<AssistantEntry>(), [pending, setPending] = useState<AssistantEntry>();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [mobile, setMobile] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 720px)").matches);
  const generation = useRef(0), controller = useRef<AbortController | undefined>(undefined), inputRef = useRef<HTMLTextAreaElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null), returnFocus = useRef<HTMLElement | null>(null);
  const composing = useRef(false), sending = useRef(false);
  const currentPath = useRef(location.pathname); currentPath.current = location.pathname;
  const orderId = /^\/orders\/([^/]+)$/.exec(location.pathname)?.[1];
  const pageName = orderId ? "订单详情" : location.pathname === "/" ? "房态" : location.pathname.startsWith("/members") ? "会员" : location.pathname.startsWith("/settings") ? "设置" : location.pathname.startsWith("/today") ? "工作台" : "订单";
  const suggestions = [
    { title: "续住前核对房态", prompt: orderId ? "这个订单想续住两晚，帮我核对后续房态，打开续住入口并说明费用如何确认。" : "客人想续住两晚，如何核对后续房态、费用并找到续住入口？" },
    { title: "安排在住客人换房", prompt: "客人入住后想换房，要先核对哪些房态和费用信息？帮我找到办理入口。" },
    { title: "核对会员入住权益", prompt: "办理会员入住前，怎样查找会员档案、核对合同与可用权益，并查看关联订单？" },
    { title: "核对订单与收款", prompt: "客人说已经付款，但订单还有待收款，我该核对哪些记录，再如何打开收款入口？" },
    { title: "处理取消预订", prompt: "客人要取消预订，库存、会员权益和已收款分别要核对什么？帮我找到取消入口。" }
  ];
  const refreshSettings = () => {
    const ticket = generation.current;
    void api.assistantSettings(propertyId).then(value => { if (generation.current === ticket) setSettings(value); }).catch(e => { if (generation.current === ticket) setError(errorMessage(e)); });
  };
  useEffect(() => { refreshSettings(); return () => { generation.current++; controller.current?.abort(); }; }, [propertyId]);
  useEffect(() => {
    let previouslyOpen = false;
    const inspect = () => {
      const next = Boolean(document.querySelector("dialog[open]"));
      if (previouslyOpen && !next) setGuide(undefined);
      previouslyOpen = next; setDialogOpen(next);
    };
    const observer = new MutationObserver(inspect); observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["open"] }); inspect();
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 720px)");
    const change = () => setMobile(query.matches); query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    if (!mobile || !open || dialogOpen) return;
    const shell = document.querySelector<HTMLElement>(".app-shell");
    if (!shell) return;
    const previous = shell.inert; shell.inert = true;
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const controls = [...document.querySelectorAll<HTMLElement>("#ai-assistant-panel button:not(:disabled), #ai-assistant-panel textarea")];
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", trap);
    return () => { shell.inert = previous; document.removeEventListener("keydown", trap); };
  }, [mobile, open, dialogOpen]);
  useEffect(() => {
    if (open && !dialogOpen) inputRef.current?.focus({ preventScroll: true });
    else if (!open) returnFocus.current?.focus({ preventScroll: true });
  }, [open, dialogOpen]);
  useEffect(() => { const el = messagesRef.current; if (el) el.scrollTop = el.scrollHeight; }, [messages, busy, error]);
  useEffect(() => { if (guide && guide.orderId && location.pathname !== `/orders/${encodeURIComponent(guide.orderId)}`) { setGuide(undefined); setPending(undefined); } }, [location.pathname, guide]);
  const close = () => { setOpen(false); };
  const toggle = () => { if (open) close(); else { returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setOpen(true); } };
  const openEntry = (entry: AssistantEntry) => {
    const path = entryPath(entry);
    if (!path) { setError("助手返回的入口不可用。"); return; }
    if (document.querySelector("dialog[open]")) { setError("请先完成或取消当前表单，再打开新的入口。"); return; }
    setGuide(entry); setPending(entry.action ? entry : undefined); setError(undefined);
    if (entry.action || window.matchMedia("(max-width: 720px)").matches) setOpen(false);
    navigate(path);
  };
  const finishEntry = (failure?: string) => {
    setPending(undefined);
    if (failure) { setGuide(undefined); setError(failure); setOpen(true); }
  };
  useEffect(() => {
    if (!pending) return;
    const timer = window.setTimeout(() => finishEntry("操作页面未能及时载入，请检查连接后重新打开。"), 15_000);
    return () => window.clearTimeout(timer);
  }, [pending]);
  const newConversation = () => { generation.current++; controller.current?.abort(); sending.current = false; setBusy(false); setConversationId(undefined); setMessages([]); setError(undefined); setGuide(undefined); setPending(undefined); refreshSettings(); };
  function questionKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (mobile || event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
    // IME confirmation is not a send command; keyCode 229 covers Safari's composition boundary.
    if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    event.preventDefault();
    if (!event.repeat) void send();
  }
  async function send(event?: FormEvent, prompt?: string) {
    event?.preventDefault(); const message = (prompt ?? draft).trim();
    if (!message || busy || sending.current || !settings?.enabled) return;
    sending.current = true;
    const ticket = generation.current, path = location.pathname;
    controller.current = new AbortController(); setBusy(true); setError(undefined); setDraft("");
    setMessages(current => [...current, { role: "user", text: message }]);
    try {
      const result: AssistantChatReply = await api.assistantChat({ propertyId, message, source: prompt === undefined ? "USER" : "SUGGESTION", page: pageName, ...(orderId ? { orderId: decodeURIComponent(orderId) } : {}), ...(conversationId ? { conversationId } : {}) }, controller.current.signal);
      if (ticket !== generation.current) return;
      setConversationId(result.conversationId);
      setMessages(current => [...current, { role: "assistant", text: result.text, entries: result.entries, ...(result.questionId ? { questionId: result.questionId } : {}) }]);
      const entry = result.entries[0];
      if (entry && currentPath.current === path) openEntry(entry);
      else if (entry) setError("你已切换页面，助手没有自动跳转。可点击回答中的入口继续。");
    } catch (e) { if (ticket === generation.current) { setError(errorMessage(e)); setDraft(message); } }
    finally { if (ticket === generation.current) { sending.current = false; setBusy(false); } }
  }
  return <AssistantContext.Provider value={{ open, toggle, settings, refreshSettings, guide, pending, finishEntry }}>
    {children}
    {open && !dialogOpen ? <aside id="ai-assistant-panel" className="assistant-panel" role={mobile ? "dialog" : "complementary"} aria-modal={mobile ? true : undefined} aria-label="AI 助手" data-testid="ai-assistant-panel">
      <header className="assistant-header"><div><Sparkles size={18} aria-hidden="true" /><strong>AI 助手</strong></div><div><button type="button" className="icon-button" aria-label="新建对话" title="新建对话" onClick={newConversation}><Plus size={18} /></button>{settings?.canManage ? <button type="button" className="icon-button" aria-label="模型设置" title="模型设置" onClick={() => { close(); navigate("/settings/ai"); }}><Settings size={18} /></button> : null}<button type="button" className="icon-button" aria-label="关闭 AI 助手" onClick={close}><X size={19} /></button></div></header>
      <div className="assistant-messages" ref={messagesRef} aria-live="polite" aria-busy={busy}>
        {!messages.length ? <div className="assistant-welcome"><MessageSquare size={27} aria-hidden="true" /><h2>需要帮你做什么？</h2><p>问我怎么操作，或让我查找房态、订单与会员资料。</p>{settings && !settings.enabled ? <p className="assistant-notice">助手尚未启用，请管理员在设置中配置模型连接。</p> : null}<div className="assistant-suggestions">{suggestions.map(({ title, prompt }) => <button type="button" key={title} onClick={() => void send(undefined, prompt)} disabled={busy || !settings?.enabled}><span><strong>{title}</strong><small>{prompt}</small></span><ChevronRight size={16} aria-hidden="true" /></button>)}</div></div> : messages.map((m, i) => <article className={`assistant-message assistant-message-${m.role}`} key={i}><span className="assistant-message-author">{m.role === "user" ? "你" : "AI 助手"}</span>{m.role === "assistant" ? <AssistantMessageContent text={m.text} /> : <div className="assistant-message-text">{m.text}</div>}{m.entries?.map((entry, index) => <div className="assistant-entry" key={index}><button type="button" className="button button-secondary" onClick={() => openEntry(entry)}>打开{entry.label}</button><ol>{entry.steps.map(step => <li key={step}>{step}</li>)}</ol></div>)}{m.questionId ? <AssistantFeedback questionId={m.questionId} propertyId={propertyId} selected={m.feedback} onSaved={feedback => setMessages(current => current.map(message => message.questionId === m.questionId ? { ...message, feedback } : message))} /> : null}</article>)}
        {busy ? <p className="assistant-wait">正在查询和整理…</p> : null}
        {error ? <div className="assistant-error" role="alert">{error}</div> : null}
      </div>
      <form className="assistant-composer" onSubmit={event => void send(event)}>
        <label className="sr-only" htmlFor="assistant-question">向 AI 助手提问</label>
        <textarea id="assistant-question" ref={inputRef} value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={questionKeyDown}
          onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
          aria-describedby="assistant-input-hint" maxLength={4000} placeholder="描述你想完成的事情…" rows={3} />
        <div><div className="assistant-composer-help"><small>业务操作由你确认</small><small id="assistant-input-hint">{mobile ? "回车换行，点击发送" : "回车发送 · Shift + 回车换行"}</small></div>
          <button className="button button-primary" type="submit" disabled={busy || !draft.trim() || !settings?.enabled}><Send size={16} aria-hidden="true" />发送</button>
        </div>
      </form>
    </aside> : null}
    {!open && guide && !dialogOpen ? <button type="button" className="assistant-resume button button-secondary" onClick={() => setOpen(true)}><MessageSquare size={16} />返回 AI 对话</button> : null}
  </AssistantContext.Provider>;
}
