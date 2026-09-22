import { useId, useRef, type KeyboardEvent } from "react";
import type { TennisApi } from "./api";
import type { Session } from "./types";
import { EmptyState, PageHeading, useDraft } from "./components";
import { StaffPanel } from "./StaffPanel";
import { TenantGatewayPanel } from "./GatewayPanel";

export function canManageTenant(session: Session) {
  return session.kind === "staff" && session.contextValid !== false && session.tenants.some(
    (tenant) => tenant.id === session.tenantId && tenant.kind === "staff" && tenant.role === "ADMIN",
  );
}

export function ManagementPage({ api, session }: { api: TennisApi; session: Session }) {
  if (!canManageTenant(session)) return <EmptyState title="仅管理员可访问系统管理" detail="请联系商家管理员处理员工权限或渠道账号绑定。" />;
  // Keep the existing gateway draft and pending-operation scope across the move.
  const scope = `${session.subjectId}:${session.kind}:${session.tenantId}:${session.contextVersion}`;
  return <TenantManagement key={scope} api={api} scope={scope} />;
}

const tabs = [{ id: "staff", name: "员工权限" }, { id: "gateway", name: "渠道账号绑定" }] as const;
function TenantManagement({ api, scope }: { api: TennisApi; scope: string }) {
  const [savedTab, setTab] = useDraft(`tennis:management-tab:${scope}`, "staff");
  const tab = savedTab === "gateway" ? "gateway" : "staff";
  const id = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  function navigateTab(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else return;
    event.preventDefault();
    setTab(tabs[next]!.id);
    refs.current[next]?.focus();
  }
  return <>
    <PageHeading title="系统管理" />
    <div className="tennis-tabs" role="tablist" aria-label="系统管理栏目">
      {tabs.map((item, index) => <button key={item.id} type="button" role="tab"
        id={`${id}-${item.id}-tab`} aria-controls={`${id}-${item.id}-panel`}
        aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1}
        className={tab === item.id ? "active" : ""}
        ref={(element) => { refs.current[index] = element; }}
        onKeyDown={(event) => navigateTab(event, index)} onClick={() => setTab(item.id)}>
        {item.name}
      </button>)}
    </div>
    {tabs.map((item) => <section key={item.id} role="tabpanel" hidden={tab !== item.id} tabIndex={0}
      id={`${id}-${item.id}-panel`} aria-labelledby={`${id}-${item.id}-tab`}>
      {tab === item.id && (item.id === "staff" ? <StaffPanel api={api} /> : <TenantGatewayPanel api={api} scope={scope} />)}
    </section>)}
  </>;
}
