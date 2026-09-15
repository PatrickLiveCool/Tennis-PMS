import { Component, Suspense, type ReactNode } from "react";
import { ArrowLeft, BedDouble, KeyRound, Users } from "lucide-react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { canManageTokens, principalCan, useWorkspace } from "../session";
import { LoadingBlock } from "../uiBasic";

class SettingsContentBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override render() {
    if (this.state.failed) return <section className="empty-state" role="alert">
      <h2>设置内容暂时无法显示</h2><p>可以通过上方导航返回设置或切换页面，也可以重新加载。</p>
      <button className="button button-secondary" onClick={() => window.location.reload()}>重新加载页面</button>
    </section>;
    return this.props.children;
  }
}

export function SettingsPage() {
  const { principal, propertyId } = useWorkspace();
  const { pathname } = useLocation();
  const index = pathname === "/settings" || pathname === "/settings/";
  const entries = [
    { to: "/settings/rooms", label: "房型与价格", detail: "新增或停用房型、配置房间床位，调整住宿价格", icon: BedDouble,
      visible: principalCan(principal, propertyId, "MANAGE_ROOM_CATALOG") },
    { to: "/settings/accounts", label: "账号管理", detail: "管理工作人员账号、登录与操作权限", icon: Users, visible: true },
    { to: "/settings/tokens", label: "智能体与外部访问", detail: "管理 API Key（Token）、权限范围与有效期", icon: KeyRound,
      visible: canManageTokens(principal, propertyId) }
  ].filter((entry) => entry.visible);
  const current = entries.find((entry) => pathname === entry.to || pathname.startsWith(entry.to + "/"));
  return <div className="settings-page">
    {index ? <>
      <header className="page-heading settings-page-heading"><div><p className="eyebrow">系统管理</p><h1>设置</h1><p className="muted">选择需要管理的设置。</p></div></header>
      <nav className="settings-cards" aria-label="设置入口">
        {entries.map(({ to, label, detail, icon: Icon }) => <Link key={to} to={to} className="settings-card">
          <Icon size={24} aria-hidden="true" /><span><strong>{label}</strong><small>{detail}</small></span>
        </Link>)}
      </nav>
    </> : <>
      <div className="settings-navigation">
        <nav className="settings-breadcrumb" aria-label="设置位置">
          <Link to="/settings"><ArrowLeft size={16} aria-hidden="true" />返回设置</Link>
          <span aria-hidden="true">/</span><span aria-current="page">{current?.label ?? "设置详情"}</span>
        </nav>
        <nav className="settings-tabs" aria-label="设置导航">
          {entries.map(({ to, label, icon: Icon }) => <NavLink key={to} to={to} className="settings-link">
            <Icon size={18} aria-hidden="true" /><span>{label}</span>
          </NavLink>)}
        </nav>
      </div>
      <SettingsContentBoundary key={`${propertyId}:${pathname}`}>
        <Suspense fallback={<LoadingBlock label="正在载入设置内容" />}><Outlet /></Suspense>
      </SettingsContentBoundary>
    </>}
  </div>;
}
