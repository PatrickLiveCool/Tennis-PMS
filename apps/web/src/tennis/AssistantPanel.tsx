import { useCallback, useEffect, useRef, useState } from "react";
import { MessageCircle, Plus, Send } from "lucide-react";
import { TennisApiError, type TennisApi } from "./api";
import { OrderDialog } from "./OrdersPage";
import type { AgentRequestDetail, AgentRequestSummary } from "../../../../packages/db/src/tennis/external-agent";
import type { Session, VenueRecord, AssistantStatus } from "./types";
import {
  Badge,
  dateTime,
  ErrorNotice,
  LoadingBlock,
  Modal,
  Panel,
  RefreshButton,
  useDraft,
  useLoad,
} from "./components";

interface Conversation {
  id: string;
  subjectId: string;
  customerId: string | null;
  actorKind: "customer" | "staff";
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
interface MessageContext {
  page: string;
  orderId?: string;
}
interface ConversationSummary extends Conversation {
  displayName: string;
  latestOrderId: string | null;
}
interface ConversationPage {
  items: ConversationSummary[];
  nextCursor: string | null;
}
interface ConversationView {
  conversation: Conversation;
  messages: {
    id: string;
    role: string;
    content: string;
    createdAt: string;
    feedback?: boolean | null;
    context?: MessageContext | null;
  }[];
  latestOrderContext?: { messageId: string; page: string; orderId: string; createdAt: string } | null;
}
interface MessageDraft {
  content: string;
  pending: { messageId: string; content: string; conversationId: string; context: MessageContext } | null;
}
function useConversationDirectory(api: TennisApi, venueId: string, mode: string, q: string) {
  const params = new URLSearchParams({ venueId, pageSize: "20" });
  if (mode) params.set("mode", mode);
  if (q) params.set("q", q);
  const path = `/assistant/conversation-directory?${params}`;
  const [snapshot, setSnapshot] = useState<{ path: string; data: ConversationPage }>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<unknown>();
  const serial = useRef(0);
  const activePath = useRef(path);
  activePath.current = path;
  const load = useCallback(
    async (cursor?: string) => {
      const request = ++serial.current;
      setBusy(true);
      try {
        const next = await api<ConversationPage>(`${path}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
        if (request !== serial.current || activePath.current !== path) return;
        setSnapshot((previous) => ({
          path,
          data: {
            items:
              cursor && previous?.path === path
                ? [...new Map([...previous.data.items, ...next.items].map((item) => [item.id, item])).values()]
                : next.items,
            nextCursor: next.nextCursor,
          },
        }));
        setError(undefined);
      } catch (next) {
        if (request === serial.current && activePath.current === path) setError(next);
      } finally {
        if (request === serial.current && activePath.current === path) setBusy(false);
      }
    },
    [api, path],
  );
  useEffect(() => {
    setError(undefined);
    void load();
    return () => {
      serial.current++;
    };
  }, [load]);
  return { data: snapshot?.path === path ? snapshot.data : undefined, busy, error, refresh: load };
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
  openResource,
}: {
  api: TennisApi;
  conversationId: string;
  timezone: string;
  refreshVersion: string;
  openResource: (type: string, id: string) => void;
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
                          {["order", "payment", "refund", "refund-group", "amendment"].includes(resource.type) && (
                            <button
                              type="button"
                              className="button button-secondary button-small"
                              onClick={() => openResource(resource.type, resource.id)}
                            >
                              查看关联订单
                            </button>
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
export function AssistantPanel(props: AssistantPanelProps) {
  return <AssistantWorkspace key={`${props.scope}:${props.session.contextVersion}:${props.venue.id}`} {...props} />;
}
function AssistantWorkspace({ api, session, venue, scope, context, onClose }: AssistantPanelProps) {
  const status = useLoad(() => api<AssistantStatus>("/assistant/status"), [api]);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);
  const conversations = useConversationDirectory(api, venue.id, mode, query);
  const [selected, setSelected] = useDraft(`tennis:assistant-selected:${scope}:${session.contextVersion}`, "");
  const [selectedSummary, setSelectedSummary] = useState<ConversationSummary | null>(null);
  const details = useLoad(
    () =>
      selected
        ? api<ConversationView>(`/assistant/conversations/${encodeURIComponent(selected)}`)
        : Promise.resolve(null),
    [api, selected],
  );
  const listedSelected = conversations.data?.items.some((item) => item.id === selected) ?? false;
  const pinnedSummary = useLoad(
    () =>
      selected && !listedSelected
        ? api<ConversationPage>(
            `/assistant/conversation-directory?${new URLSearchParams({ venueId: venue.id, q: selected, pageSize: "20" })}`,
          )
        : Promise.resolve(null),
    [api, venue.id, selected, listedSelected],
  );
  const contextOrder = useLoad(
    () =>
      context.orderId
        ? api<{ id: string; venueId: string; customerId: string }>(`/orders/${encodeURIComponent(context.orderId)}`)
        : Promise.resolve(null),
    [api, context.orderId],
  );
  const [messageDraft, setMessageDraft] = useDraft<MessageDraft>(
    `tennis:assistant-message:${scope}:${session.contextVersion}:${selected}`,
    { content: "", pending: null },
  );
  const content = messageDraft.content;
  const setContent = (next: string | ((previous: string) => string)) =>
    setMessageDraft((value) => ({
      ...value,
      content: typeof next === "function" ? next(value.content) : next,
    }));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>();
  const [openedOrder, setOpenedOrder] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Record<string, FeedbackState>>({});
  const feedbackRunning = useRef(new Set<string>());
  const mounted = useRef(true);
  const actionSerial = useRef(0);
  const viewKey = JSON.stringify([scope, session.contextVersion, venue.id, selected, mode, query]);
  const activeView = useRef(viewKey);
  activeView.current = viewKey;
  const running = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      actionSerial.current++;
    };
  }, []);
  useEffect(() => {
    actionSerial.current++;
    running.current = false;
    setBusy(false);
    setError(undefined);
    setReason("");
    setOpenedOrder(null);
  }, [selected, mode, query]);
  useEffect(() => {
    const items = conversations.data?.items ?? [];
    const found = items.find((value) => value.id === selected);
    if (found) setSelectedSummary(found);
    if (!selected && items.length) {
      const initial = items.find((value) => value.subjectId === session.subjectId) ?? items[0]!;
      setSelected(initial.id);
      setSelectedSummary(initial);
    }
  }, [conversations.data, selected, session.subjectId]);
  const current = details.data?.conversation.id === selected ? details.data : null;
  const own = current?.conversation.subjectId === session.subjectId;
  const canAttachOrder =
    !!context.orderId &&
    contextOrder.data?.id === context.orderId &&
    contextOrder.data.venueId === venue.id &&
    (own ||
      (current?.conversation.actorKind === "customer" &&
        current.conversation.customerId === contextOrder.data.customerId));
  const messageContext: MessageContext = {
    page: context.page,
    ...(canAttachOrder ? { orderId: context.orderId! } : {}),
  };
  const contextReady =
    !!messageDraft.pending || !context.orderId || (!contextOrder.busy && !contextOrder.error && !!contextOrder.data);
  const selectedBase =
    conversations.data?.items.find((item) => item.id === selected) ??
    pinnedSummary.data?.items.find((item) => item.id === selected) ??
    (selectedSummary?.id === selected
      ? selectedSummary
      : current
        ? {
            ...current.conversation,
            displayName: own ? session.displayName : "当前已打开会话",
            latestOrderId: current.latestOrderContext?.orderId ?? null,
          }
        : null);
  const selectedItem = selectedBase && current ? { ...selectedBase, ...current.conversation } : selectedBase;
  const directoryItems = (
    selectedItem && !conversations.data?.items.some((item) => item.id === selectedItem.id)
      ? [selectedItem, ...(conversations.data?.items ?? [])]
      : (conversations.data?.items ?? [])
  ).map((item) => (item.id === selected && selectedItem ? selectedItem : item));
  async function run(work: (isCurrent: () => boolean) => Promise<void>) {
    if (running.current) return;
    running.current = true;
    const token = ++actionSerial.current;
    const isCurrent = () => mounted.current && actionSerial.current === token && activeView.current === viewKey;
    setBusy(true);
    setError(undefined);
    try {
      await work(isCurrent);
    } catch (next) {
      if (isCurrent()) setError(next);
    } finally {
      if (isCurrent()) {
        running.current = false;
        setBusy(false);
      }
    }
  }
  async function create() {
    await run(async (isCurrent) => {
      const item = await api<Conversation>("/assistant/conversations", "POST", { venueId: venue.id });
      if (!isCurrent()) return;
      setSelectedSummary({ ...item, displayName: session.displayName, latestOrderId: null });
      setSelected(item.id);
      await conversations.refresh();
    });
  }
  async function send() {
    if (!current || !content.trim() || !contextReady || details.busy || details.error) return;
    await run(async (isCurrent) => {
      const original = messageDraft.pending;
      if (original && (original.conversationId !== selected || original.content !== content.trim()))
        throw new Error("上一条消息的处理结果尚未确认，请保留原文并查询原会话。");
      const request = original ?? {
        messageId: crypto.randomUUID(),
        content: content.trim(),
        conversationId: selected,
        context: { ...messageContext },
      };
      setMessageDraft((value) => ({ ...value, pending: request }));
      try {
        await api<ConversationView>(
          `/assistant/conversations/${encodeURIComponent(request.conversationId)}/messages`,
          "POST",
          {
            messageId: request.messageId,
            content: request.content,
            context: request.context,
          },
        );
        if (isCurrent()) setMessageDraft({ content: "", pending: null });
      } catch (next) {
        if (isCurrent() && !original && next instanceof TennisApiError && !next.uncertain)
          setMessageDraft((value) => ({ ...value, pending: null }));
        throw next;
      } finally {
        if (isCurrent()) {
          await details.refresh();
          await conversations.refresh();
        }
      }
    });
  }
  async function handoff(nextMode: "AGENT" | "HUMAN") {
    if (!selected || !current || !reason.trim() || !contextReady || details.busy || details.error) return;
    await run(async (isCurrent) => {
      await api(`/assistant/conversations/${encodeURIComponent(selected)}/handoff`, "POST", {
        mode: nextMode,
        reason: reason.trim(),
        context: messageDraft.pending?.context ?? messageContext,
      });
      if (!isCurrent()) return;
      setMessageDraft({ content: "", pending: null });
      setReason("");
      await details.refresh();
      await conversations.refresh();
    });
  }
  async function openResource(type: string, id: string) {
    if (type === "order") {
      setOpenedOrder(id);
      return;
    }
    const paths: Record<string, string> = {
      payment: "payments",
      refund: "refunds",
      "refund-group": "refund-groups",
      amendment: "amendments",
    };
    const path = paths[type];
    if (!path) return;
    await run(async (isCurrent) => {
      const record = await api<{ orderId?: string }>(`/${path}/${encodeURIComponent(id)}`);
      if (isCurrent() && record.orderId) setOpenedOrder(record.orderId);
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
  const suggestions = canAttachOrder
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
  const canSend =
    !!current &&
    (current.conversation.mode === "HUMAN" || own) &&
    !busy &&
    !details.busy &&
    !details.error &&
    contextReady;
  return (
    <>
      <Modal title="AI 助手" size="wide" onClose={onClose} closeDisabled={busy}>
        <div className="tennis-assistant">
          <p className="tennis-muted">
            {venue.name} · {session.kind === "customer" ? "订场咨询与工作人员协助" : "当前工作区的咨询、预订与人工协作"}
          </p>
          {messageDraft.pending ? (
            <p className="tennis-note">
              {messageDraft.pending.context.orderId
                ? `待核实消息关联订单 ${messageDraft.pending.context.orderId.slice(0, 8)}。`
                : "待核实消息未关联订单。"}
              请继续核对原消息，重试时保留原上下文。
            </p>
          ) : canAttachOrder ? (
            <p className="tennis-note">
              本次消息关联订单 {context.orderId!.slice(0, 8)}。关闭助手后可继续填写原订单表单。
            </p>
          ) : null}
          {!messageDraft.pending && context.orderId && current && contextReady && !canAttachOrder && (
            <p className="tennis-note">
              当前会话与正在查看的订单不匹配，发送消息不会附带该订单。可从本会话的历史关联订单继续核对。
            </p>
          )}
          {!status.data?.configured && !status.busy && (
            <div className="tennis-note">
              AI 助手尚未连接外部服务。可以查看会话、留言并转人工协助；平台运营方配置后即可启用。
            </div>
          )}
          <ErrorNotice
            error={error ?? details.error ?? conversations.error ?? status.error ?? contextOrder.error}
            retry={() => {
              void details.refresh();
              void conversations.refresh();
              void contextOrder.refresh();
            }}
          />
          <div className="tennis-toolbar">
            <label>
              搜索会话
              <input
                aria-label="搜索会话"
                value={search}
                maxLength={200}
                disabled={busy}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="客户 / 员工姓名、会话或订单编号"
              />
            </label>
            <label>
              处理状态
              <select
                aria-label="筛选会话处理状态"
                value={mode}
                disabled={busy}
                onChange={(event) => setMode(event.target.value)}
              >
                <option value="">全部</option>
                <option value="HUMAN">人工处理中</option>
                <option value="AGENT">AI 协作</option>
              </select>
            </label>
          </div>
          {conversations.busy && !conversations.data && <LoadingBlock label="正在读取会话目录" />}
          {!!conversations.error && conversations.data && (
            <p className="tennis-note">目录刷新未成功，仍显示上次结果，请重新读取后核对。</p>
          )}
          {!conversations.busy && !conversations.error && conversations.data?.items.length === 0 && (
            <p className="tennis-muted">
              {query
                ? "没有找到符合条件的会话，请调整姓名或编号。"
                : mode
                  ? "当前筛选条件下暂无会话。"
                  : "暂无会话，可以新建一次咨询。"}
              {selected ? "当前已打开的会话仍保留。" : ""}
            </p>
          )}
          <div className="tennis-toolbar">
            <label>
              会话
              <select
                aria-label="选择助手会话"
                value={selected}
                disabled={busy}
                onChange={(event) => {
                  setSelected(event.target.value);
                  setSelectedSummary(directoryItems.find((item) => item.id === event.target.value) ?? null);
                  setReason("");
                  setError(undefined);
                }}
              >
                <option value="">选择会话</option>
                {directoryItems.map((item) => (
                  <option value={item.id} key={item.id} title={`${item.displayName} · ${item.id}`}>
                    {item.displayName} · {item.actorKind === "customer" ? "客户" : "员工"}
                    {item.subjectId === session.subjectId ? "（我）" : ""} ·{" "}
                    {item.mode === "HUMAN" ? "人工处理中" : "AI 协作"} · {dateTime(item.updatedAt, venue.timezone)} ·{" "}
                    {item.id.slice(0, 8)}
                  </option>
                ))}
              </select>
            </label>
            {conversations.data?.nextCursor && (
              <button
                type="button"
                className="button button-secondary"
                disabled={busy || conversations.busy}
                onClick={() => void conversations.refresh(conversations.data!.nextCursor!)}
              >
                {conversations.busy ? "读取中…" : "加载更多会话"}
              </button>
            )}
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
          {current?.latestOrderContext && (
            <div className="tennis-note">
              最近关联订单 · {dateTime(current.latestOrderContext.createdAt, venue.timezone)} ·{" "}
              <button
                type="button"
                className="button button-secondary button-small"
                onClick={() => setOpenedOrder(current.latestOrderContext!.orderId)}
              >
                查看订单 {current.latestOrderContext.orderId.slice(0, 8)}
              </button>
              <p className="tennis-muted">此关联来自历史消息；新留言不一定仍在讨论这笔订单。</p>
            </div>
          )}
          {selected && !current ? (
            details.busy ? (
              <LoadingBlock />
            ) : null
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
                      background:
                        message.role === "user" ? "var(--tennis-tint, #edf5ef)" : "var(--tennis-surface, #fff)",
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
                    {message.context?.orderId && (
                      <button
                        type="button"
                        className="button button-secondary button-small"
                        style={{ marginTop: 8 }}
                        onClick={() => setOpenedOrder(message.context!.orderId!)}
                      >
                        查看此消息关联订单 {message.context.orderId.slice(0, 8)}
                      </button>
                    )}
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
                openResource={(type, id) => void openResource(type, id)}
              />
              <div className="tennis-note">
                {current.conversation.mode === "HUMAN"
                  ? "当前由工作人员处理，AI 操作已停止。"
                  : own
                    ? "确认预订、付款或退改时，请以订单中的最新记录为准。"
                    : "先接管此会话，再以工作人员身份回复。"}
              </div>
              {messageDraft.pending && (
                <p className="tennis-note is-warning" role="status">
                  上一条消息的结果尚待核实。原文、会话和
                  {messageDraft.pending.context.orderId
                    ? `订单 ${messageDraft.pending.context.orderId.slice(0, 8)} 的`
                    : "页面"}
                  上下文已保留；重试仍使用原消息编号，不会改为当前页面的另一笔订单。
                </p>
              )}
              <div style={{ marginBottom: 12 }}>
                <p className="tennis-muted">常用提问 · 点击填入后可编辑，不会自动发送</p>
                <div className="tennis-actions" style={{ marginTop: 8 }}>
                  {suggestions.map((question) => (
                    <button
                      key={question}
                      type="button"
                      className="button button-secondary button-small"
                      disabled={busy || !!messageDraft.pending}
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
                    disabled={busy || !!messageDraft.pending}
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
                    {busy ? "处理中…" : messageDraft.pending ? "重试原消息" : "发送"}
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
                    disabled={busy || details.busy || !!details.error || !contextReady || !reason.trim()}
                    onClick={() => void handoff("HUMAN")}
                  >
                    {session.kind === "customer" ? "转人工协助" : "人工接管"}
                  </button>
                )}
                {session.kind === "staff" && current.conversation.mode === "HUMAN" && (
                  <button
                    className="button button-secondary"
                    disabled={busy || details.busy || !!details.error || !contextReady || !reason.trim()}
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
      {openedOrder && (
        <OrderDialog
          key={openedOrder}
          api={api}
          session={session}
          venue={venue}
          scope={scope}
          orderId={openedOrder}
          onClose={() => setOpenedOrder(null)}
          onChanged={() => {
            void details.refresh();
            void conversations.refresh();
          }}
        />
      )}
    </>
  );
}
