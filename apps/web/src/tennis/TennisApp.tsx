import { useEffect, useLayoutEffect, useMemo, useState, type FormEvent } from "react";
import {
  Building2,
  CalendarDays,
  ClipboardList,
  LayoutDashboard,
  LogOut,
  MessagesSquare,
  Settings,
  ShieldCheck,
  Sparkles,
  UserRound,
  Users,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { createApi, TennisApiError, type TennisApi } from "./api";
import type { Session, VenueRecord } from "./types";
import { permits } from "./types";
import { BookingPage } from "./BookingPage";
import { OrdersPage, OrderDialog } from "./OrdersPage";
import { OverviewPage } from "./OverviewPage";
import { PlatformPage } from "./PlatformPage";
import { SettingsPage, NewVenue } from "./SettingsPage";
import { canManageTenant, ManagementPage } from "./ManagementPage";
import { AssistantPanel, BusinessConversationPanel } from "./AssistantPanel";
import { MembersPage } from "./MembersPage";
import { TopupRecordDialog } from "./TopupHistoryPanel";
import {
  EmptyState,
  ErrorNotice,
  LoadingBlock,
  Panel,
  RecoveryNotice,
  useDraft,
  useLoad,
  writeStored,
} from "./components";

export function TennisApp() {
  const [session, setSession] = useState<Session | null>();
  const [error, setError] = useState<unknown>();
  async function restore() {
    setError(undefined);
    try {
      setSession(await createApi()<Session>("/session"));
    } catch (next) {
      if (next instanceof TennisApiError && next.status === 401) setSession(null);
      else setError(next);
    }
  }
  useEffect(() => {
    void restore();
    const expired = () => setSession(null);
    window.addEventListener("tennis-session-expired", expired);
    return () => window.removeEventListener("tennis-session-expired", expired);
  }, []);
  if (session === undefined)
    return (
      <main className="startup-state">
        <ErrorNotice error={error} retry={() => void restore()} />
        {!error && <LoadingBlock label="正在恢复工作空间" />}
      </main>
    );
  return session ? (
    <Workspace
      key={`${session.subjectId}:${session.kind}:${session.tenantId}:${session.contextVersion}`}
      session={session}
      onSession={setSession}
      onLogout={() => setSession(null)}
    />
  ) : (
    <Login onLogin={setSession} />
  );
}
function Login({ onLogin }: { onLogin: (session: Session) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      onLogin(await createApi()<Session>("/auth/login", "POST", { username, password }));
    } catch (next) {
      setError(next);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login-page">
      <section className="login-panel">
        <div className="login-brand">
          <span className="brand-word">Tennis</span>
          <span>PMS</span>
        </div>
        <div>
          <p className="eyebrow">网球运营工作台</p>
          <h1>登录</h1>
        </div>
        <ErrorNotice error={error} />
        <form className="login-form" onSubmit={(e) => void submit(e)}>
          <label htmlFor="username">账号</label>
          <input
            id="username"
            autoComplete="username"
            autoFocus
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          <label htmlFor="password">密码</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button className="button button-primary login-submit" disabled={busy}>
            {busy ? "正在登录…" : "进入工作台"}
          </button>
        </form>
      </section>
    </main>
  );
}
const navigation = [
  { id: "booking", name: "场地排期", icon: CalendarDays },
  { id: "today", name: "经营概览", icon: LayoutDashboard },
  { id: "orders", name: "预订订单", icon: ClipboardList },
  { id: "members", name: "会员储值", icon: Users },
  { id: "settings", name: "场地与定价", icon: Settings },
  { id: "management", name: "系统管理", icon: ShieldCheck },
];
function Workspace({
  session,
  onSession,
  onLogout,
}: {
  session: Session;
  onSession: (session: Session) => void;
  onLogout: () => void;
}) {
  const api = useMemo(() => createApi(session), [session]);
  const identityScope = `${session.subjectId}:${session.kind}:${session.tenantId}:${session.customerId ?? "staff"}`;
  const venues = useLoad(
    () => (session.kind === "platform" || session.contextValid === false ? Promise.resolve([]) : api<VenueRecord[]>("/venues")),
    [api],
  );
  const [selectedVenue, setSelectedVenue] = useDraft(`tennis:venue:${identityScope}`, "");
  const [page, setPage] = useDraft(`tennis:page:${identityScope}`, "booking");
  const [scheduleEntryMigrated, setScheduleEntryMigrated] = useDraft(`tennis:schedule-entry-v1:${identityScope}`, false);
  useLayoutEffect(() => {
    if (!scheduleEntryMigrated) {
      if (page === "today") setPage("booking");
      setScheduleEntryMigrated(true);
    }
  }, [scheduleEntryMigrated]);
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantOrderId, setAssistantOrderId] = useState<string | null>(null);
  const [businessConversationsOpen, setBusinessConversationsOpen] = useState(false);
  const [creatingVenue, setCreatingVenue] = useState(false);
  const venue = venues.data?.find((v) => v.id === selectedVenue) ?? venues.data?.[0];
  const tenant = session.tenants.find((item) => item.id === session.tenantId && item.kind === session.kind);
  const workspaceName = session.kind === "platform" ? "平台运营" : tenant?.name ?? "工作空间";
  const assistantScope = `${identityScope}:${session.contextVersion}:${venue?.id}`;
  useEffect(() => {
    setAssistantOrderId(null); setAssistantOpen(false);
    const show = (event: Event) => { if ((event as CustomEvent).detail.scope === assistantScope) setAssistantOpen(true); };
    const focus = (event: Event) => { const data = (event as CustomEvent).detail; if (data.scope === assistantScope) setAssistantOrderId(data.orderId); };
    window.addEventListener("tennis-assistant-open", show);
    window.addEventListener("tennis-assistant-order-context", focus);
    return () => { window.removeEventListener("tennis-assistant-open", show); window.removeEventListener("tennis-assistant-order-context", focus); };
  }, [assistantScope]);
  async function context(value: string) {
    const [kind, tenantId] = value.split(":");
    setBusy(true);
    setError(undefined);
    try {
      onSession(
        await api<Session>("/session/context", "POST", { kind, tenantId: kind === "platform" ? null : tenantId }),
      );
    } catch (next) {
      setError(next);
    } finally {
      setBusy(false);
    }
  }
  async function logout() {
    setBusy(true);
    try {
      await api("/auth/logout", "POST");
      onLogout();
    } catch (next) {
      setError(next);
    } finally {
      setBusy(false);
    }
  }
  async function refreshSession() {
    setBusy(true);
    setError(undefined);
    try {
      onSession(await api<Session>("/session"));
    } catch (next) {
      setError(next);
    } finally {
      setBusy(false);
    }
  }
  const entries = navigation
    .filter((item) => item.id !== "members" || session.kind === "customer" || permits(session, "manage_members"))
    .filter((item) => item.id !== "settings" || session.kind === "staff")
    .filter((item) => item.id !== "management" || canManageTenant(session));
  const currentPage = entries.some((e) => e.id === page) ? page : "booking";
  const nav = (mobile = false) => (
    <nav className={mobile ? "tennis-bottom-nav" : "primary-navigation"} aria-label={mobile ? "手机导航" : "主导航"}>
      {entries.filter((item) => !mobile || item.id !== "management").map((item) => (
        <button
          key={item.id}
          type="button"
          className={`nav-link ${currentPage === item.id ? "active" : ""}`}
          onClick={() => setPage(item.id)}
          aria-current={currentPage === item.id ? "page" : undefined}
          title={item.name}
        >
          <item.icon size={19} aria-hidden="true" />
          <span>{item.name}</span>
        </button>
      ))}
      {mobile && session.platformOperator && session.kind !== "platform" && session.contextValid !== false && (
        <button className="nav-link" disabled={busy} onClick={() => void context("platform:")}>
          <Building2 size={19} aria-hidden="true" />
          <span>平台运营</span>
        </button>
      )}
    </nav>
  );
  return (
    <div className={`app-shell tennis-app ${collapsed ? "sidebar-is-collapsed" : ""}`}>
      <a className="skip-link" href="#tennis-main">
        跳至主要内容
      </a>
      <aside className="sidebar">
        <div className="sidebar-brand-row">
          <div className="sidebar-brand">
            <div className="sidebar-brand-identity">
              <strong className="brand-word sidebar-brand-full">Tennis</strong>
              <span className="sidebar-brand-product">运营工作台</span>
              <strong className="sidebar-brand-compact">T</strong>
            </div>
          </div>
          <button
            className="icon-button sidebar-toggle"
            onClick={() => setCollapsed(!collapsed)}
            aria-label={collapsed ? "展开导航" : "收起导航"}
          >
            {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
          </button>
        </div>
        {session.kind !== "platform" ? (
          nav()
        ) : (
          <div className="nav-link active">
            <Building2 size={18} />
            <span>平台运营</span>
          </div>
        )}
        <div className="sidebar-utilities">
          {session.platformOperator && session.kind !== "platform" && session.contextValid !== false && (
            <div className="tennis-sidebar-utility-slot">
              <button className="tennis-sidebar-utility-trigger" aria-label="平台运营" title="平台运营" disabled={busy} onClick={() => void context("platform:")}>
                <Building2 size={18} aria-hidden="true" />
                <span>平台运营</span>
              </button>
            </div>
          )}
          {session.kind === "staff" && permits(session, "book") && (
            <div className="tennis-sidebar-utility-slot">
              <button className="tennis-sidebar-utility-trigger" aria-label="咨询与协助" title="咨询与协助" onClick={() => setBusinessConversationsOpen(true)}>
                <MessagesSquare size={18} aria-hidden="true" />
                <span>咨询与协助</span>
              </button>
            </div>
          )}
          <div className="tennis-sidebar-utility-slot">
            <button
              disabled={session.kind !== "customer" && !permits(session, "read")}
              className="tennis-sidebar-utility-trigger"
              aria-label="AI 助手" title="AI 助手"
              aria-controls="ai-assistant-panel" aria-expanded={assistantOpen}
              onClick={() => setAssistantOpen(!assistantOpen)}
            >
              <Sparkles size={18} aria-hidden="true" />
              <span>AI 助手</span>
            </button>
          </div>
          <div className="sidebar-user">
            <UserRound size={18} aria-hidden="true" />
            <div title={session.displayName}>
              <strong>{session.displayName}</strong>
              <span>
                {session.kind === "platform" ? "平台运营方" : session.kind === "customer" ? "客户" : "工作人员"}
              </span>
            </div>
            <button
              className="icon-button"
              title={`退出登录 · ${session.displayName}`}
              aria-label="退出登录"
              disabled={busy}
              onClick={() => void logout()}
            >
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </aside>
      <div className="tennis-main-shell">
        <header className="tennis-workspace-header">
          <div className="tennis-workspace-select">
            <div className="tennis-tenant-name">
              <Building2 size={18} aria-hidden="true" />
              <strong>{workspaceName}</strong>
            </div>
            {session.kind !== "platform" && session.contextValid !== false && (
              <label className="tennis-campus-switch">
                <select
                  aria-label="切换校区"
                  value={venue?.id ?? ""}
                  onChange={(e) => {
                    setSelectedVenue(e.target.value);
                    setAssistantOpen(false);
                    setBusinessConversationsOpen(false);
                  }}
                  disabled={busy || venues.busy || !venues.data?.length}
                >
                  {!venue && <option value="">{venues.busy ? "正在加载校区…" : "暂无可访问校区"}</option>}
                  {venues.data?.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <div className="tennis-header-tools">
            {session.localSimulation && <span className="tennis-demo-badge">本地模拟</span>}
            {canManageTenant(session) && <button
              className={`icon-button tennis-mobile-management${currentPage === "management" ? " is-active" : ""}`}
              aria-label="系统管理" title="系统管理" aria-current={currentPage === "management" ? "page" : undefined}
              onClick={() => setPage("management")}>
              <ShieldCheck size={19} aria-hidden="true" />
            </button>}
            {session.kind === "staff" && permits(session, "book") && (
              <button className="icon-button" aria-label="打开咨询与协助" title="咨询与协助" onClick={() => setBusinessConversationsOpen(true)}>
                <MessagesSquare size={19} />
              </button>
            )}
            <button
              disabled={session.kind !== "customer" && !permits(session, "read")}
              className="icon-button"
              aria-label="打开 AI 助手"
              aria-controls="ai-assistant-panel" aria-expanded={assistantOpen}
            onClick={() => setAssistantOpen(!assistantOpen)}
            >
              <Sparkles size={19} />
            </button>
            <button className="icon-button tennis-mobile-logout" aria-label="退出登录" onClick={() => void logout()}>
              <LogOut size={17} />
            </button>
          </div>
        </header>
        <main className="main-content" id="tennis-main">
          <ErrorNotice error={error} />
          {session.contextValid === false ? (
            <Panel>
              <EmptyState title="当前工作空间暂不可用" detail={session.platformOperator || session.tenants.length ? "请选择可访问的工作空间继续。" : "请联系管理员恢复权限，或退出后使用其他账号登录。"} />
              <div className="tennis-workspace-recovery">
                {(session.platformOperator || session.tenants.length > 0) && (
                  <WorkspaceChoice session={session} busy={busy} includePlatform onChange={(value) => void context(value)} />
                )}
                <button className="button button-secondary" disabled={busy} onClick={() => void refreshSession()}>重新读取登录信息</button>
                <button className="button button-secondary" disabled={busy} onClick={() => void logout()}>退出登录</button>
              </div>
            </Panel>
          ) : session.kind === "platform" ? (
            <>
              {session.tenants.length > 0 && (
                <Panel title="进入业务工作台">
                  <WorkspaceChoice session={session} busy={busy} onChange={(value) => void context(value)} />
                </Panel>
              )}
              <PlatformPage api={api} scope={session.subjectId} />
            </>
          ) : currentPage === "management" && canManageTenant(session) ? (
            <ManagementPage api={api} session={session} />
          ) : !venue ? (
            <Panel>
              <ErrorNotice error={venues.error} retry={() => void venues.refresh()} />
              {venues.busy ? (
                <LoadingBlock />
              ) : (
                <EmptyState title="暂无可访问场馆" detail="请联系管理员添加场馆或开通访问权限。" />
              )}
              {!venues.busy && permits(session, "manage_assets") && (
                <button className="button button-primary" onClick={() => setCreatingVenue(true)}>
                  创建第一个场馆
                </button>
              )}
            </Panel>
          ) : (
            <BusinessWorkspace
              key={`${identityScope}:${session.contextVersion}:${venue.id}`}
              api={api}
              session={session}
              venue={venue}
              scope={`${identityScope}:${session.contextVersion}:${venue.id}`}
              page={currentPage}
              onVenueChange={() => void venues.refresh()}
            />
          )}
          {(assistantOpen || session.kind === "staff") &&
            venue &&
            session.contextValid !== false &&
            (session.kind === "customer" || permits(session, "read")) && (
              <AssistantPanel
                key={`${identityScope}:${session.contextVersion}:${venue.id}`}
                api={api}
                session={session}
                venue={venue}
                scope={`${identityScope}:${session.contextVersion}:${venue.id}`}
                open={assistantOpen}
                context={assistantOrderId ? { page: "orders", orderId: assistantOrderId } : { page: currentPage }}
                onPrepare={(entry) => window.dispatchEvent(new CustomEvent("tennis-assistant-prepare-order", { detail: { scope: assistantScope, entry } }))}
                onNavigate={(destination) => setPage(destination)}
                onClose={() => setAssistantOpen(false)}
              />
            )}
          {businessConversationsOpen && venue && session.contextValid !== false && permits(session, "book") && (
            <BusinessConversationPanel
              key={`${identityScope}:${session.contextVersion}:${venue.id}:business`}
              api={api}
              session={session}
              venue={venue}
              scope={`${identityScope}:${session.contextVersion}:${venue.id}`}
              context={{ page: currentPage }}
              onClose={() => setBusinessConversationsOpen(false)}
            />
          )}
          {creatingVenue && (
            <NewVenue
              api={api}
              onClose={() => setCreatingVenue(false)}
              onSaved={() => {
                setCreatingVenue(false);
                void venues.refresh();
              }}
            />
          )}
        </main>
        {session.kind !== "platform" && nav(true)}
      </div>
    </div>
  );
}

function WorkspaceChoice({ session, busy, includePlatform = false, onChange }: {
  session: Session;
  busy: boolean;
  includePlatform?: boolean;
  onChange: (value: string) => void;
}) {
  return <label className="tennis-workspace-choice">
    <span>工作空间</span>
    <select aria-label="选择工作空间" value="" disabled={busy} onChange={(event) => onChange(event.target.value)}>
      <option value="" disabled>请选择工作空间</option>
      {includePlatform && session.platformOperator && <option value="platform:">平台运营</option>}
      {session.tenants.map((item) => <option value={`${item.kind}:${item.id}`} key={`${item.kind}:${item.id}`}>
        {item.name}{item.kind === "customer" ? " · 客户" : " · 工作人员"}
      </option>)}
    </select>
  </label>;
}

function BusinessWorkspace({
  api,
  session,
  venue,
  scope,
  page,
  onVenueChange,
}: {
  api: TennisApi;
  session: Session;
  venue: VenueRecord;
  scope: string;
  page: string;
  onVenueChange: () => void;
}) {
  useLayoutEffect(() => {
    const key = `tennis:scroll:${scope}:${page}`;
    let saved = 0;
    try {
      const value = Number(sessionStorage.getItem(key) ?? "0");
      if (Number.isFinite(value) && value >= 0) saved = value;
    } catch {
      /* position is optional */
    }
    const main = document.getElementById("tennis-main");
    let waiting = true;
    let lastTop = saved;
    let frame = 0;
    const restore = () => {
      if (!waiting) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!waiting || !main || [...main.querySelectorAll(".loading-block")].some((item) => !item.closest("dialog")))
          return;
        window.scrollTo({ top: saved, behavior: "instant" });
        lastTop = window.scrollY;
        waiting = false;
      });
    };
    const capture = () => {
      if (!waiting) lastTop = window.scrollY;
    };
    const stopRestoring = (event: Event) => {
      if (
        event instanceof KeyboardEvent &&
        !["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End", " "].includes(event.key)
      )
        return;
      if (event.target instanceof Element && event.target.closest("dialog, input, textarea, select")) return;
      waiting = false;
      lastTop = window.scrollY;
      cancelAnimationFrame(frame);
    };
    // The first render may contain only loaders. Restore after real page content is mounted.
    const mutations = new MutationObserver(restore);
    const dimensions = new ResizeObserver(restore);
    if (main) {
      mutations.observe(main, { childList: true, subtree: true });
      dimensions.observe(main);
    }
    window.addEventListener("scroll", capture, { passive: true });
    window.addEventListener("wheel", stopRestoring, { passive: true });
    window.addEventListener("touchmove", stopRestoring, { passive: true });
    window.addEventListener("keydown", stopRestoring);
    restore();
    return () => {
      mutations.disconnect();
      dimensions.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", capture);
      window.removeEventListener("wheel", stopRestoring);
      window.removeEventListener("touchmove", stopRestoring);
      window.removeEventListener("keydown", stopRestoring);
      writeStored(key, lastTop);
    };
  }, [scope, page]);
  const [orderId, setOrderId] = useState<string | null>(null);
  const [assistantPreparation, setAssistantPreparation] = useState<import("../../../../packages/db/src/tennis/backoffice-assistant").BackofficeAction | undefined>();
  useEffect(() => {
    const show = (event: Event) => { const data = (event as CustomEvent).detail; if (data.scope === scope) { setAssistantPreparation(data.preparation); setOrderId(data.orderId); } };
    window.addEventListener("tennis-open-order", show); return () => window.removeEventListener("tennis-open-order", show);
  }, [scope]);
  const [topupId, setTopupId] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  return (
    <>
      <RecoveryNotice scope={scope} api={api} openOrder={setOrderId} openTopup={setTopupId} />
      {page === "booking" ? (
        <BookingPage
          key={`booking:${revision}`}
          api={api}
          session={session}
          venue={venue}
          scope={scope}
          openOrder={setOrderId}
        />
      ) : page === "orders" ? (
        <OrdersPage key={`orders:${revision}`} api={api} venue={venue} scope={scope} openOrder={setOrderId} />
      ) : page === "members" ? (
        <MembersPage api={api} session={session} venue={venue} scope={scope} />
      ) : page === "settings" ? (
        <SettingsPage api={api} session={session} venue={venue} onVenueChange={onVenueChange} />
      ) : (
        <OverviewPage
          key={`today:${revision}`}
          api={api}
          session={session}
          venue={venue}
          scope={scope}
          openOrder={setOrderId}
        />
      )}
      {topupId && (
        <TopupRecordDialog
          key={topupId}
          api={api}
          session={session}
          venue={venue}
          scope={scope}
          topupId={topupId}
          onClose={() => setTopupId(null)}
          onChanged={() => setRevision((value) => value + 1)}
        />
      )}
      {orderId && (
        <OrderDialog
          key={orderId}
          api={api}
          session={session}
          venue={venue}
          scope={scope}
          orderId={orderId}
          initialPreparation={assistantPreparation}
          onClose={() => { setOrderId(null); setAssistantPreparation(undefined); }}
          onChanged={() => setRevision((value) => value + 1)}
        />
      )}
    </>
  );
}
