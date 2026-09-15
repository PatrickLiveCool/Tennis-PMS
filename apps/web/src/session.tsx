import { AssistantProvider, AssistantTrigger } from "./assistant/Assistant";
import { Suspense, createContext, useContext, useEffect, useMemo, useRef, useState, type Dispatch, type FormEvent, type ReactNode, type SetStateAction } from "react";
import { AlertCircle, BadgeCheck, BedDouble, Building2, ChevronDown, ClipboardList, KeyRound, LogOut, PanelLeftClose, PanelLeftOpen, RefreshCw, Smartphone, Settings, UserRound } from "lucide-react";
import { NavLink, Outlet } from "react-router-dom";
import { version as applicationVersion } from "../../../package.json";
import { api, ApiError } from "./api";
import type { CommandCapability, CommandCatalogType, MetaDto, PendingTokenCommand, PrincipalDto, RetainedTokenSecret } from "./types";
import { errorMessage, LoadingBlock } from "./uiBasic";

function propertyDisplayName(property: MetaDto["properties"][number] | undefined) {
  if (!property) return "";
  if (property.code === "QTP-XA") return "QinTopia·西安";
  return property.name;
}

export function ServiceFailureState({ error, title, onRetry, testId }: {
  error: unknown;
  title: string;
  onRetry: () => void;
  testId: string;
}) {
  const errorRef = useRef<HTMLElement>(null);

  useEffect(() => {
    errorRef.current?.focus();
  }, [error]);

  return (
    <main className="startup-state">
      <section className="service-failure" role="alert" tabIndex={-1} ref={errorRef} data-testid={testId}>
        <AlertCircle aria-hidden="true" size={20} />
        <div><h1>{title}</h1><p>{errorMessage(error)}</p></div>
      </section>
      <button className="button button-secondary" type="button" onClick={onRetry} data-testid={`${testId}-retry`}>
        <RefreshCw aria-hidden="true" size={17} />重试
      </button>
    </main>
  );
}

export function NoPropertyAccessState({ onRetry }: { onRetry: () => void }) {
  return (
    <main className="startup-state">
      <section className="service-failure" role="status" data-testid="no-property-access">
        <Building2 aria-hidden="true" size={20} />
        <div><h1>尚未分配门店</h1><p>当前账号没有可访问的门店，请联系管理员分配权限后重新检查。</p></div>
      </section>
      <button className="button button-secondary" type="button" onClick={onRetry} data-testid="no-property-access-retry">
        <RefreshCw aria-hidden="true" size={17} />重新检查授权
      </button>
    </main>
  );
}

interface WorkspaceContextValue {
  principal: PrincipalDto;
  meta: MetaDto;
  propertyId: string;
  setPropertyId: (propertyId: string) => void;
  refreshMeta: () => Promise<void>;
  retainedTokenSecret: RetainedTokenSecret | undefined;
  setRetainedTokenSecret: Dispatch<SetStateAction<RetainedTokenSecret | undefined>>;
  pendingTokenCommand: PendingTokenCommand | undefined;
  setPendingTokenCommand: Dispatch<SetStateAction<PendingTokenCommand | undefined>>;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function useWorkspace() {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("Workspace context is unavailable");
  return value;
}

export function LoginPage({ onLogin, expired = false }: { onLogin: (principal: PrincipalDto) => void; expired?: boolean }) {
  const demoLoginEnabled = import.meta.env.DEV || import.meta.env.VITE_DEMO_LOGIN === "true";
  const [username, setUsername] = useState(demoLoginEnabled ? "operator" : "");
  const [password, setPassword] = useState(demoLoginEnabled ? "demo-pass-2026" : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const errorRef = useRef<HTMLDivElement>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      onLogin(await api.login(username, password));
    } catch (nextError) {
      setError(nextError);
      requestAnimationFrame(() => errorRef.current?.focus());
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-page">
      <section className="login-panel" aria-labelledby="login-title">
        <div className="login-brand">
          <span className="brand-word">QinTopia</span>
          <span>PMS v{applicationVersion}</span>
        </div>
        <div>
          <p className="eyebrow">运营工作台</p>
          <h1 id="login-title">登录</h1>
        </div>
        {expired ? <p role="alert" data-testid="session-expired">登录已过期，请重新登录。未确认结果的操作将在登录后按原记录查询，请勿重复提交。</p> : null}
        {error ? (
          <div className="inline-error" role="alert" tabIndex={-1} ref={errorRef}>
            <div><strong>登录失败</strong><p>{errorMessage(error)}</p></div>
          </div>
        ) : null}
        <form className="login-form" onSubmit={(event) => void submit(event)}>
          <label htmlFor="username">账号</label>
          <input id="username" name="username" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required autoFocus data-testid="login-username" />
          <label htmlFor="password">密码</label>
          <input id="password" name="password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required data-testid="login-password" />
          <button className="button button-primary login-submit" type="submit" disabled={busy} data-testid="login-submit">{busy ? "正在登录..." : expired ? "重新登录" : "进入工作台"}</button>
        </form>
        {demoLoginEnabled ? (
          <div className="demo-account" aria-label="演示账号">
            <span>演示账号</span>
            <code>operator</code>
            <code>demo-pass-2026</code>
          </div>
        ) : null}
      </section>
    </main>
  );
}

export function WorkspaceProvider({ principal, children }: {
  principal: PrincipalDto;
  children: ReactNode;
}) {
  const [meta, setMeta] = useState<MetaDto>();
  const [propertyId, setPropertyIdState] = useState("");
  const [error, setError] = useState<unknown>();
  const [retainedTokenSecret, setRetainedTokenSecret] = useState<RetainedTokenSecret>();
  const [pendingTokenCommand, setPendingTokenCommand] = useState<PendingTokenCommand>();
  const metaRequestId = useRef(0);

  async function refreshMeta() {
    const requestId = ++metaRequestId.current;
    let nextMeta: MetaDto;
    try {
      nextMeta = await api.meta();
    } catch (nextError) {
      if (requestId !== metaRequestId.current) return;
      throw nextError;
    }
    if (requestId !== metaRequestId.current) return;
    setError(undefined);
    setMeta(nextMeta);
    setPropertyIdState((current) => {
      if (current && nextMeta.properties.some((property) => property.id === current)) return current;
      const saved = storedLocalValue("qintopia.propertyId");
      if (saved && nextMeta.properties.some((property) => property.id === saved)) return saved;
      return nextMeta.properties[0]?.id ?? "";
    });
  }

  useEffect(() => {
    void refreshMeta().catch(setError);
    return () => { metaRequestId.current += 1; };
  }, []);

  function retryMeta() {
    setError(undefined);
    void refreshMeta().catch(setError);
  }

  function setPropertyId(nextPropertyId: string) {
    persistLocalValue("qintopia.propertyId", nextPropertyId);
    setPropertyIdState(nextPropertyId);
  }

  const value = useMemo<WorkspaceContextValue | undefined>(() => meta && propertyId ? ({
    principal,
    meta,
    propertyId,
    setPropertyId,
    refreshMeta,
    retainedTokenSecret,
    setRetainedTokenSecret,
    pendingTokenCommand,
    setPendingTokenCommand
  }) : undefined, [meta, pendingTokenCommand, principal, propertyId, retainedTokenSecret]);

  if (error) {
    return <ServiceFailureState error={error} title="无法载入工作区" onRetry={retryMeta} testId="workspace-startup-error" />;
  }
  if (meta && meta.properties.length === 0) return <NoPropertyAccessState onRetry={retryMeta} />;
  if (!value) return <main className="startup-state"><LoadingBlock label="正在载入运营数据" /></main>;

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

const navigation = [
  { to: "/", label: "房态", icon: BedDouble, end: true },
  { to: "/orders", label: "订单", icon: ClipboardList, end: false },
  { to: "/members", label: "会员", icon: BadgeCheck, end: false },
  { to: "/today", label: "工作台", icon: Smartphone, end: false },
  { to: "/settings", label: "设置", icon: Settings, end: false }
] as const;

const tokenManagementCommands = new Set<CommandCapability>(["ISSUE_TOKEN", "ROTATE_TOKEN", "REVOKE_TOKEN"]);
const historicalRecoveryCommandGrants = new Set<CommandCatalogType>([
  "PLACE_INTERNAL_USE",
  "RELEASE_INTERNAL_USE",
  "BACKFILL_COMPLETED_STAY"
]);

export function propertyAllowedActions(principal: PrincipalDto, propertyId: string): ReadonlySet<CommandCapability> {
  return new Set(principal.allowedActions[propertyId] ?? []);
}

export function principalCan(principal: PrincipalDto, propertyId: string, commandType: CommandCapability): boolean {
  return propertyAllowedActions(principal, propertyId).has(commandType);
}

export function propertyCommandGrants(principal: PrincipalDto, propertyId: string): ReadonlySet<CommandCatalogType> {
  return new Set(principal.propertyCommandGrants[propertyId] ?? []);
}

export function canManageTokens(principal: PrincipalDto, propertyId: string): boolean {
  const actions = propertyAllowedActions(principal, propertyId);
  return [...tokenManagementCommands].some((commandType) => actions.has(commandType));
}

export function commandRecoveryAvailable(principal: PrincipalDto, propertyId: string, commandType: string | undefined): boolean {
  if (!commandType) return false;
  if (commandType === "CREATE_QUOTE") return principal.propertyAccess[propertyId] === "READ" || principal.propertyAccess[propertyId] === "WRITE";
  if (historicalRecoveryCommandGrants.has(commandType as CommandCatalogType)) {
    return propertyCommandGrants(principal, propertyId).has(commandType as CommandCatalogType);
  }
  return propertyAllowedActions(principal, propertyId).has(commandType as CommandCapability);
}

export function navigationItemsForAccess(principal: PrincipalDto, propertyId: string) {
  return navigation;
}

const sidebarStoragePrefix = "qintopia:pms:sidebar-collapsed:v1";

export function sidebarStorageKey(subjectId: string): string {
  return `${sidebarStoragePrefix}:${encodeURIComponent(subjectId)}`;
}

export function availableLocalStorage(owner: { readonly localStorage: Storage } | undefined): Storage | undefined {
  if (!owner) return undefined;
  try {
    return owner.localStorage;
  } catch {
    return undefined;
  }
}

function storedLocalValue(key: string): string | null {
  try {
    return availableLocalStorage(typeof window === "undefined" ? undefined : window)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function persistLocalValue(key: string, value: string): void {
  try {
    availableLocalStorage(typeof window === "undefined" ? undefined : window)?.setItem(key, value);
  } catch {
    // The workspace remains usable when browser storage is unavailable.
  }
}

export function storedSidebarCollapsed(storage: Pick<Storage, "getItem"> | undefined, subjectId: string): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(sidebarStorageKey(subjectId)) === "true";
  } catch {
    return false;
  }
}

export function persistSidebarCollapsed(storage: Pick<Storage, "setItem"> | undefined, subjectId: string, collapsed: boolean): void {
  if (!storage) return;
  try {
    storage.setItem(sidebarStorageKey(subjectId), String(collapsed));
  } catch {
    // The navigation remains usable when browser storage is unavailable.
  }
}

function Navigation({ principal, propertyId, mobile = false, collapsed = false }: { principal: PrincipalDto; propertyId: string; mobile?: boolean; collapsed?: boolean }) {
  return (
    <nav className={mobile ? "mobile-navigation" : "primary-navigation"} aria-label={mobile ? "移动主导航" : "主导航"}>
      {navigationItemsForAccess(principal, propertyId).map((item) => {
        const Icon = item.icon;
        return (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) => isActive ? "nav-link active" : "nav-link"}
            title={!mobile && collapsed ? item.label : undefined}
            aria-label={!mobile && collapsed ? item.label : undefined}
          >
            <Icon aria-hidden="true" size={mobile ? 20 : 18} />
            <span>{item.label}</span>
          </NavLink>
        );
      })}
    </nav>
  );
}

export function AppShell({ onLogout }: { onLogout: () => void }) {
  const { principal, meta, propertyId, setPropertyId } = useWorkspace();
  const property = meta.properties.find((item) => item.id === propertyId);
  const propertyLabel = propertyDisplayName(property);
  const propertyAccess = principal.propertyAccess[propertyId] ?? "READ";
  const [logoutFailure, setLogoutFailure] = useState<{ error: unknown; sessionState: "ACTIVE" | "UNKNOWN" }>();
  const [loggingOut, setLoggingOut] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => storedSidebarCollapsed(
    availableLocalStorage(typeof window === "undefined" ? undefined : window),
    principal.subjectId
  ));
  const logoutErrorRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (logoutFailure) logoutErrorRef.current?.focus();
  }, [logoutFailure]);

  async function logout() {
    if (loggingOut) return;
    setLoggingOut(true);
    setLogoutFailure(undefined);
    try {
      await api.logout();
      onLogout();
    } catch (nextError) {
      let sessionState: "ACTIVE" | "UNKNOWN" = "UNKNOWN";
      try {
        await api.me();
        sessionState = "ACTIVE";
      } catch (verificationError) {
        if (verificationError instanceof ApiError && verificationError.status === 401) {
          onLogout();
          return;
        }
      }
      setLogoutFailure({ error: nextError, sessionState });
      setLoggingOut(false);
    }
  }

  function toggleSidebar() {
    setSidebarCollapsed((current) => {
      const next = !current;
      persistSidebarCollapsed(availableLocalStorage(typeof window === "undefined" ? undefined : window), principal.subjectId, next);
      return next;
    });
  }

  return (
    <AssistantProvider key={`${principal.subjectId}:${propertyId}`}><div className={`app-shell${sidebarCollapsed ? " sidebar-is-collapsed" : ""}`}>
      <a className="skip-link" href="#main-content">跳至主要内容</a>
      <aside className="sidebar">
          <div className="sidebar-brand-row">
            <div className="sidebar-brand-identity">
              <div className="sidebar-brand" aria-label="QinTopia PMS">
                <span className="brand-word"><span className="sidebar-brand-full">QinTopia</span><span className="sidebar-brand-compact" aria-hidden="true">Q</span></span>
                <span className="sidebar-brand-product">PMS</span>
              </div>
            <a className="application-version" href={`https://github.com/qintopia-agent-studio/GreenPMS/releases/tag/v${applicationVersion}`} target="_blank" rel="noopener noreferrer" title={`QinTopia PMS v${applicationVersion} · 更新说明`} aria-label={`版本 v${applicationVersion}，查看更新说明`}>
              v{applicationVersion}
            </a>
          </div>
          <button
            className="icon-button sidebar-toggle"
            type="button"
            onClick={toggleSidebar}
            aria-label={sidebarCollapsed ? "展开左侧导航" : "收起左侧导航"}
            title={sidebarCollapsed ? "展开左侧导航" : "收起左侧导航"}
            aria-expanded={!sidebarCollapsed}
            data-testid="sidebar-toggle"
          >
            {sidebarCollapsed ? <PanelLeftOpen aria-hidden="true" size={18} /> : <PanelLeftClose aria-hidden="true" size={18} />}
          </button>
          <AssistantTrigger mobile />
          <button className="mobile-logout icon-button" type="button" onClick={() => void logout()} disabled={loggingOut} aria-label="退出登录" title="退出登录"><LogOut aria-hidden="true" size={19} /></button>
        </div>
        <Navigation principal={principal} propertyId={propertyId} collapsed={sidebarCollapsed} />
        <div className="sidebar-utilities">
          <div className="assistant-sidebar-slot"><AssistantTrigger /></div>
          <div className="sidebar-property" title={propertyLabel}>
            <Building2 aria-hidden="true" size={18} />
            <label className="sr-only" htmlFor="property-select">门店</label>
            <select id="property-select" value={propertyId} onChange={(event) => setPropertyId(event.target.value)} data-testid="property-select" aria-label="门店">
              {meta.properties.map((item) => <option key={item.id} value={item.id}>{propertyDisplayName(item)}</option>)}
            </select>
            <ChevronDown className="sidebar-property-chevron" aria-hidden="true" size={14} />
          </div>
          <div className="sidebar-user">
            <UserRound aria-hidden="true" size={18} />
            <div title={principal.displayName}><strong>{principal.displayName}</strong><span>{principal.propertyAccess[propertyId] === "WRITE" ? "可写" : "只读"}</span></div>
            <button className="icon-button" type="button" onClick={() => void logout()} disabled={loggingOut} aria-label="退出登录" title={`退出登录 · ${principal.displayName}`}><LogOut aria-hidden="true" size={16} /></button>
          </div>
        </div>
      </aside>
      <div className="workspace">
        {logoutFailure ? (
          <section className="session-action-error" role="alert" tabIndex={-1} ref={logoutErrorRef} data-testid="logout-error">
            <AlertCircle aria-hidden="true" size={20} />
            <div>
              <strong>{logoutFailure.sessionState === "ACTIVE" ? "退出未完成，会话仍保持登录" : "退出结果暂未确认，本页面保持当前工作区"}</strong>
              <p>{errorMessage(logoutFailure.error)}</p>
            </div>
            <button className="button button-secondary" type="button" onClick={() => void logout()} disabled={loggingOut} data-testid="retry-logout">
              <RefreshCw aria-hidden="true" size={17} />重试退出
            </button>
          </section>
        ) : null}
        <main id="main-content" className="main-content" tabIndex={-1}>
          <Suspense fallback={<LoadingBlock label="正在载入页面" />}><Outlet /></Suspense>
        </main>
      </div>
      <Navigation principal={principal} propertyId={propertyId} mobile />
    </div></AssistantProvider>
  );
}
