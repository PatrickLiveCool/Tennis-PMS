import { useEffect, useLayoutEffect, useMemo, useState, type FormEvent } from "react";
import {
  Building2,
  CalendarDays,
  ClipboardList,
  LayoutDashboard,
  LogOut,
  Settings,
  Sparkles,
  Users,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { createApi, TennisApiError, type TennisApi } from "./api";
import type { Session, VenueRecord } from "./types";
import { permits } from "./types";
import { BookingPage } from "./BookingPage";
import { OrdersPage, OrderDialog } from "./OrdersPage";
import { OrderPagination, useOrderDirectory } from "./OrderDirectory";
import { FinancePanel } from "./FinancePanel";
import { PlatformPage } from "./PlatformPage";
import { SettingsPage, NewVenue } from "./SettingsPage";
import { AssistantPanel } from "./AssistantPanel";
import { MembersPage } from "./MembersPage";
import {
  Badge,
  dateTime,
  dateValue,
  EmptyState,
  ErrorNotice,
  LoadingBlock,
  money,
  PageHeading,
  Panel,
  RecoveryNotice,
  RefreshButton,
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
        <p className="tennis-muted">使用平台分配的账号。演示账号与随机密码见本地启动凭据。</p>
      </section>
    </main>
  );
}
const navigation = [
  { id: "today", name: "工作台", icon: LayoutDashboard },
  { id: "booking", name: "场地排期", icon: CalendarDays },
  { id: "orders", name: "预订订单", icon: ClipboardList },
  { id: "members", name: "客户与余额", icon: Users },
  { id: "settings", name: "场地与定价", icon: Settings },
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
    () => (session.kind === "platform" ? Promise.resolve([]) : api<VenueRecord[]>("/venues")),
    [api],
  );
  const [selectedVenue, setSelectedVenue] = useDraft(`tennis:venue:${identityScope}`, "");
  const [page, setPage] = useDraft(`tennis:page:${identityScope}`, "booking");
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [creatingVenue, setCreatingVenue] = useState(false);
  const venue = venues.data?.find((v) => v.id === selectedVenue) ?? venues.data?.[0];
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
  const entries = navigation
    .filter((item) => item.id !== "members" || session.kind === "customer" || permits(session, "manage_members"))
    .filter((item) => item.id !== "settings" || session.kind === "staff");
  const currentPage = entries.some((e) => e.id === page) ? page : "booking";
  const nav = (mobile = false) => (
    <nav className={mobile ? "tennis-bottom-nav" : "primary-navigation"} aria-label={mobile ? "手机导航" : "主导航"}>
      {entries.map((item) => (
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
          <button
            disabled={session.kind !== "customer" && !permits(session, "book")}
            className="nav-link tennis-assistant-trigger"
            onClick={() => setAssistantOpen(!assistantOpen)}
          >
            <Sparkles size={19} />
            <span>AI 助手</span>
          </button>
          <div className="sidebar-user">
            <div>
              <strong>{session.displayName}</strong>
              <span>
                {session.kind === "platform" ? "平台运营方" : session.kind === "customer" ? "客户" : "工作人员"}
              </span>
            </div>
            <button
              className="icon-button"
              title="退出登录"
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
            <Building2 size={18} />
            <select
              aria-label="切换租户与身份"
              value={session.contextValid === false ? "" : `${session.kind}:${session.tenantId ?? ""}`}
              onChange={(e) => void context(e.target.value)}
              disabled={busy}
            >
              {session.contextValid === false && (
                <option value="" disabled>
                  请选择工作空间
                </option>
              )}
              {session.platformOperator && <option value="platform:">平台运营</option>}
              {session.tenants.map((t) => (
                <option value={`${t.kind}:${t.id}`} key={`${t.kind}:${t.id}`}>
                  {t.name}
                  {t.kind === "customer" ? " · 客户" : ""}
                </option>
              ))}
            </select>
            {session.kind !== "platform" && (
              <select
                aria-label="切换场馆"
                value={venue?.id ?? ""}
                onChange={(e) => {
                  setSelectedVenue(e.target.value);
                  setAssistantOpen(false);
                }}
                disabled={busy || venues.busy}
              >
                {venues.data?.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div className="tennis-header-tools">
            <button
              className="icon-button"
              title="刷新登录与工作空间"
              aria-label="刷新登录与工作空间"
              onClick={() => void api<Session>("/session").then(onSession).catch(setError)}
            >
              ↻
            </button>
            {session.localSimulation && <span className="tennis-demo-badge">本地模拟</span>}
            <button
              disabled={session.kind !== "customer" && !permits(session, "book")}
              className="icon-button"
              aria-label="打开 AI 助手"
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
              <EmptyState title="当前身份权限已变更" detail="请从顶部选择仍可访问的租户或身份，或退出后重新登录。" />
            </Panel>
          ) : session.kind === "platform" ? (
            <PlatformPage api={api} scope={session.subjectId} />
          ) : !venue ? (
            <Panel>
              <ErrorNotice error={venues.error} retry={() => void venues.refresh()} />
              {venues.busy ? (
                <LoadingBlock />
              ) : (
                <EmptyState title="暂无可访问场馆" detail="请联系租户管理员创建场馆或为此账号分配场馆权限。" />
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
              scope={`${identityScope}:${venue.id}`}
              page={currentPage}
              onVenueChange={() => void venues.refresh()}
            />
          )}
          {assistantOpen &&
            venue &&
            session.contextValid !== false &&
            (session.kind === "customer" || permits(session, "book")) && (
              <AssistantPanel
                key={`${identityScope}:${session.contextVersion}:${venue.id}`}
                api={api}
                session={session}
                venue={venue}
                scope={`${identityScope}:${venue.id}`}
                context={{ page: currentPage }}
                onClose={() => setAssistantOpen(false)}
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
    let top = 0;
    try {
      top = Number(sessionStorage.getItem(`tennis:scroll:${scope}:${page}`) ?? "0");
    } catch {
      /* optional */
    }
    window.scrollTo({ top, behavior: "instant" });
    return () => writeStored(`tennis:scroll:${scope}:${page}`, window.scrollY);
  }, [scope, page]);
  const [orderId, setOrderId] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  return (
    <>
      <RecoveryNotice scope={scope} api={api} openOrder={setOrderId} />
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
        <TodayPage
          key={`today:${revision}`}
          api={api}
          session={session}
          venue={venue}
          scope={scope}
          openOrder={setOrderId}
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
          onClose={() => setOrderId(null)}
          onChanged={() => setRevision((value) => value + 1)}
        />
      )}
    </>
  );
}
function TodayPage({
  api,
  session,
  venue,
  scope,
  openOrder,
}: {
  api: TennisApi;
  session: Session;
  venue: VenueRecord;
  scope: string;
  openOrder: (id: string) => void;
}) {
  const [today, setToday] = useState(() => dateValue(new Date(), venue.timezone));
  useEffect(() => {
    const update = () => setToday(dateValue(new Date(), venue.timezone));
    update();
    const timer = window.setInterval(update, 60_000);
    return () => window.clearInterval(timer);
  }, [venue.timezone]);
  const orders = useOrderDirectory(api, venue.id, `today:${scope}`, { date: today, status: "ACTIVE" });
  return (
    <>
      <PageHeading title="今日工作台" description={`${venue.name} · ${today}`}>
        <RefreshButton onClick={() => void orders.refresh()} busy={orders.busy} />
      </PageHeading>
      <ErrorNotice error={orders.error} retry={() => void orders.refresh()} />
      <Panel title="今日预约与待付款">
        {!orders.data && orders.busy ? (
          <LoadingBlock />
        ) : !orders.data ? null : !orders.data.orders.length ? (
          <EmptyState title="今天暂无有效预约" detail="新预约确认后会显示在这里。" />
        ) : (
          orders.data.orders.map((order) => (
            <div className="tennis-ledger-row" key={order.id}>
              <div>
                <strong>
                  {order.customerName || "客户预订"} · 整单应付 {money(order.totalCents)}
                </strong>
                <span>今日 {order.matchingLines.length} 条有效明细</span>
                {order.matchingLines.map((line) => (
                  <span key={line.id}>
                    {line.courtName} · {dateTime(line.startAt, venue.timezone)} — {dateTime(line.endAt, venue.timezone)}
                  </span>
                ))}
              </div>
              <Badge value={order.status} />
              <button className="button button-secondary" onClick={() => openOrder(order.id)}>
                办理
              </button>
            </div>
          ))
        )}
        <OrderPagination directory={orders} />
      </Panel>
      <FinancePanel api={api} session={session} venue={venue} openOrder={openOrder} />
    </>
  );
}
