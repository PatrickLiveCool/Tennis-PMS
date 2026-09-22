import { useEffect, useRef, useState } from "react";
import { Copy, Plus } from "lucide-react";
import { InfoHint } from "./InfoHint";
import { TennisApiError, type TennisApi } from "./api";
import type { TenantRecord } from "./types";
import {
  dateTime,
  EmptyState,
  ErrorNotice,
  LoadingBlock,
  Modal,
  Panel,
  RefreshButton,
  useDraft,
  useLoad,
} from "./components";

interface GatewayIntegration {
  id: string;
  tenantId: string;
  name: string;
  active: boolean;
  createdAt: string;
  revokedAt: string | null;
  pausedAt: string | null;
  expiresAt: string | null;
  revision: number;
  rotatedAt: string | null;
}
const integrationExpired = (item: GatewayIntegration) => Boolean(item.expiresAt && Date.parse(item.expiresAt) <= Date.now());
const integrationEnabled = (item: GatewayIntegration) => item.active && !item.pausedAt && !integrationExpired(item);
function integrationStatus(item: GatewayIntegration) {
  if (!item.active) return "已撤销";
  if (integrationExpired(item)) return item.pausedAt ? "已暂停 · 已到期" : "已到期";
  return item.pausedAt ? "已暂停" : "启用";
}
interface GatewayBinding {
  id: string;
  integrationId: string;
  externalSubjectId: string;
  subjectId: string;
  customerId: string | null;
  actorKind: "staff" | "customer";
  active: boolean;
  reason: string;
  createdAt: string;
}
type BindingTarget =
  | { actorKind: "staff"; subjectId: string; customerId: null; name: string }
  | { actorKind: "customer"; subjectId: string | null; customerId: string; name: string };
const targetKey = (target: BindingTarget) =>
  target.actorKind === "customer" ? `customer:${target.customerId}` : `staff:${target.subjectId}`;
const targetId = (target: BindingTarget) => (target.actorKind === "customer" ? target.customerId : target.subjectId);
const shortAccountId = (value: string) => value.length > 16 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
interface BindingList {
  integrations: GatewayIntegration[];
  bindings: GatewayBinding[];
}

/** Only a human-readable operation description is persisted; never a gateway token. */
function useGatewayMutation(api: TennisApi, scope: string) {
  const [pending, setPending] = useDraft<string | null>(`tennis:gateway-pending:${scope}`, null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [checked, setChecked] = useState(false);
  const running = useRef(false);
  async function run<T>(description: string, path: string, payload: unknown): Promise<T | undefined> {
    if (running.current || pending) return;
    running.current = true;
    setBusy(true);
    setError(undefined);
    setChecked(false);
    setPending(description);
    try {
      const result = await api<T>(path, "POST", payload);
      setPending(null);
      return result;
    } catch (next) {
      setError(next);
      if (next instanceof TennisApiError && !next.uncertain) setPending(null);
      return undefined;
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  function doneChecking() {
    if (checked) {
      setPending(null);
      setChecked(false);
      setError(undefined);
    }
  }
  return { pending, busy, error, checked, run, doneChecking, setChecked };
}
function PendingGateway({
  mutation,
  refresh,
  recoveryDetail = "如果接入已创建，但没有拿到凭据，请撤销该接入后重新创建。",
}: {
  mutation: ReturnType<typeof useGatewayMutation>;
  refresh: () => Promise<unknown>;
  recoveryDetail?: string;
}) {
  if (!mutation.pending || mutation.busy) return null;
  return (
    <div className="tennis-note is-warning" role="status">
      <p>「{mutation.pending}」的结果还未确认。请先刷新列表，查看是否已完成。</p>
      <p>{recoveryDetail}</p>
      <div className="tennis-actions">
        <button
          type="button"
          className="button button-secondary"
          onClick={() =>
            void refresh().then((value) => {
              if (value !== undefined) mutation.setChecked(true);
            })
          }
        >
          刷新列表
        </button>
        <button
          type="button"
          className="button button-secondary"
          disabled={!mutation.checked}
          onClick={mutation.doneChecking}
        >
          已核对，结束本次操作
        </button>
      </div>
    </div>
  );
}
function GatewayRevokeDialog({
  title,
  scope,
  busy,
  onClose,
  onConfirm,
}: {
  title: string;
  scope: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => Promise<boolean>;
}) {
  const [reason, setReason] = useDraft(`tennis:gateway-revoke:${scope}`, "");
  return (
    <Modal title={`撤销${title}`} onClose={onClose} closeDisabled={busy}>
      <form
        className="tennis-form"
        onSubmit={(event) => {
          event.preventDefault();
          void onConfirm(reason).then((success) => {
            if (success) setReason("");
          });
        }}
      >
        <p>撤销后，该渠道将无法继续代办业务。已有订单和账目保留。</p>
        <label>
          撤销原因
          <textarea
            required
            maxLength={2000}
            disabled={busy}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        <button className="button button-danger" disabled={busy || !reason.trim()}>
          {busy ? "正在撤销…" : "确认撤销"}
        </button>
      </form>
    </Modal>
  );
}

export function PlatformGatewayPanel({
  api,
  tenants,
  scope,
}: {
  api: TennisApi;
  tenants: TenantRecord[];
  scope: string;
}) {
  const [tenantId, setTenantId] = useState("");
  const selected = tenants.find((tenant) => tenant.id === tenantId) ?? tenants[0];
  return (
    <Panel title="渠道接入" action={<InfoHint label="渠道接入说明">为商家连接微信等外部渠道。创建接入后，商家管理员还需核对并绑定客户或员工账号。</InfoHint>}>
      {selected ? (
        <>
          <label className="tennis-form">
            接入所属商家
            <select
              aria-label="渠道接入所属商家"
              value={selected.id}
              onChange={(event) => setTenantId(event.target.value)}
            >
              {tenants.map((tenant) => (
                <option key={tenant.id} value={tenant.id}>
                  {tenant.name}
                  {tenant.active ? "" : "（已停用）"}
                </option>
              ))}
            </select>
          </label>
          <GatewayIntegrations
            key={`${scope}:${selected.id}`}
            api={api}
            tenant={selected}
            scope={`${scope}:${selected.id}`}
          />
        </>
      ) : (
        <EmptyState title="请先开通商家" detail="开通后即可为商家添加渠道接入。" />
      )}
    </Panel>
  );
}
function GatewayIntegrations({ api, tenant, scope }: { api: TennisApi; tenant: TenantRecord; scope: string }) {
  const list = useLoad(
    () => api<GatewayIntegration[]>(`/platform/gateways?tenantId=${encodeURIComponent(tenant.id)}`),
    [api, tenant.id],
  );
  const mutation = useGatewayMutation(api, `platform:${scope}`);
  const [name, setName] = useDraft(`tennis:gateway-name:${scope}`, "");
  const [secret, setSecret] = useState<{ id: string; name: string; token: string } | null>(null);
  const [notice, setNotice] = useState("");
  const [revoke, setRevoke] = useState<GatewayIntegration | null>(null);
  async function create() {
    const result = await mutation.run<GatewayIntegration & { token: string }>(
      `为${tenant.name}创建接入：${name.trim()}`,
      "/platform/gateways",
      { tenantId: tenant.id, name: name.trim() },
    );
    if (result) {
      setSecret({ id: result.id, name: result.name, token: result.token });
      setName("");
      setNotice("接入已创建，请保存本次显示的凭据。");
      await list.refresh();
    }
  }
  async function revokeItem(reason: string) {
    if (!revoke) return false;
    const result = await mutation.run<GatewayIntegration>(
      `撤销接入：${revoke.name}（${revoke.id}）`,
      `/platform/gateways/${revoke.id}/revoke`,
      { reason },
    );
    setRevoke(null);
    if (result) {
      if (secret?.id === result.id) setSecret(null);
      setNotice("接入已撤销。");
      await list.refresh();
    }
    return Boolean(result);
  }
  return (
    <>
      <ErrorNotice error={list.error ?? mutation.error} retry={() => void list.refresh()} />
      <PendingGateway mutation={mutation} refresh={list.refresh} />
      {notice && (
        <p className="tennis-success" role="status">
          {notice}
        </p>
      )}
      {secret && (
        <div className="tennis-note">
          <h3>保存「{secret.name}」的接入凭据</h3>
          <p>凭据只显示一次，请复制保存后再离开本页。</p>
          <label className="tennis-form">
            接入凭据
            <input
              aria-label="一次性接入凭据"
              readOnly
              value={secret.token}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <div className="tennis-actions">
            <button
              type="button"
              className="button button-secondary"
              onClick={() =>
                void navigator.clipboard.writeText(secret.token).then(
                  () => setNotice("凭据已复制。"),
                  () => setNotice("未能自动复制，请手动选择并保存上方凭据。"),
                )
              }
            >
              <Copy size={15} />
              复制凭据
            </button>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => {
                setSecret(null);
                setNotice("凭据已隐藏。");
              }}
            >
              已保存，隐藏凭据
            </button>
          </div>
        </div>
      )}
      <form
        className="tennis-form"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <label>
          接入名称
          <input
            required
            maxLength={200}
            placeholder="例如：格林微信入口"
            value={name}
            disabled={mutation.busy || Boolean(mutation.pending) || Boolean(secret)}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <div className="tennis-actions">
          <button
            className="button button-primary"
            disabled={!tenant.active || mutation.busy || Boolean(mutation.pending) || Boolean(secret) || !name.trim()}
          >
            <Plus size={16} />
            {mutation.busy ? "正在处理…" : "创建接入凭据"}
          </button>
          <RefreshButton busy={list.busy || mutation.busy} onClick={() => void list.refresh()} />
        </div>
      </form>
      {!list.data && list.busy ? (
        <LoadingBlock />
      ) : !list.data?.length ? (
        <EmptyState title="暂无渠道接入" detail="创建接入后，由商家管理员绑定客户或员工账号。" />
      ) : (
        list.data.map((item) => (
          <div className="tennis-ledger-row" key={item.id}>
            <div>
              <strong>{item.name}</strong>
              <span>
                {integrationStatus(item)} · {dateTime(item.createdAt)}
              </span>
              <InfoHint label={`${item.name}接入编号`}>{item.id}</InfoHint>
            </div>
            {item.active && (
              <button
                type="button"
                className="button button-secondary button-small"
                disabled={mutation.busy || Boolean(mutation.pending)}
                onClick={() => setRevoke(item)}
              >
                撤销接入
              </button>
            )}
          </div>
        ))
      )}
      {revoke && (
        <GatewayRevokeDialog
          title={`接入 · ${revoke.name}`}
          scope={`platform:${scope}:${revoke.id}`}
          busy={mutation.busy}
          onClose={() => setRevoke(null)}
          onConfirm={revokeItem}
        />
      )}
    </>
  );
}

type IntegrationAction = "pause" | "resume" | "revoke" | "rotate";
const integrationActionLabels: Record<IntegrationAction, string> = {
  pause: "暂停接入", resume: "恢复接入", revoke: "撤销接入", rotate: "更换 API Key",
};
const integrationActionDetails: Record<IntegrationAction, string> = {
  pause: "暂停后，这个智能体将立即停止代办业务。以后可以恢复接入；已结束的办理授权不会恢复。未完成的办理需先核对原结果。",
  resume: "恢复后，这个智能体可以重新申请办理授权。员工身份绑定和实际权限继续生效。未完成的办理需先核对原结果。",
  revoke: "撤销后，这个接入将永久失效，无法恢复。已有订单和账目保留。",
  rotate: "更换后，旧 API Key 和正在使用的办理授权立即失效。请将新 Key 更新到智能体服务端；原有身份绑定和暂停状态保留。未完成的办理需先核对原结果。",
};
const validExpiry = (days: string) => Number.isInteger(Number(days)) && Number(days) >= 1 && Number(days) <= 365;

function IntegrationActionDialog({ item, action, scope, busy, onClose, onConfirm }: {
  item: GatewayIntegration;
  action: IntegrationAction;
  scope: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: (reason: string, expiresInDays: number) => Promise<boolean>;
}) {
  const [reason, setReason] = useDraft(`tennis:agent-access-reason:${scope}:${item.id}:${action}`, "");
  const [days, setDays] = useState("90");
  return <Modal title={`${integrationActionLabels[action]} · ${item.name}`} onClose={onClose} closeDisabled={busy}>
    <form className="tennis-form" onSubmit={(event) => {
      event.preventDefault();
      if (!reason.trim() || (action === "rotate" && !validExpiry(days))) return;
      void onConfirm(reason.trim(), Number(days)).then((success) => { if (success) setReason(""); });
    }}>
      <p>{integrationActionDetails[action]}</p>
      {action === "rotate" && <label>
        新 Key 有效期（天）
        <input type="number" required min={1} max={365} step={1} value={days} disabled={busy}
          onChange={(event) => setDays(event.target.value)} />
      </label>}
      <label>
        操作原因
        <textarea required maxLength={2000} value={reason} disabled={busy}
          onChange={(event) => setReason(event.target.value)} />
      </label>
      <button className={`button ${action === "revoke" ? "button-danger" : "button-primary"}`}
        disabled={busy || !reason.trim() || (action === "rotate" && !validExpiry(days))}>
        {busy ? "正在处理…" : `确认${integrationActionLabels[action]}`}
      </button>
    </form>
  </Modal>;
}

export function TenantAgentAccessPanel({ api, scope }: { api: TennisApi; scope: string }) {
  // A changed workspace must discard even a late response carrying a one-time secret.
  return <TenantAgentAccess key={scope} api={api} scope={scope} />;
}
function TenantAgentAccess({ api, scope }: { api: TennisApi; scope: string }) {
  const list = useLoad(() => api<GatewayIntegration[]>("/gateway-integrations"), [api]);
  const mutation = useGatewayMutation(api, `agent-access:${scope}`);
  const [draft, setDraft] = useDraft(`tennis:agent-access-create:${scope}`, { name: "", days: "90" });
  // API Keys are intentionally never written to drafts, browser storage or the list cache.
  const [secret, setSecret] = useState<{ name: string; token: string } | null>(null);
  const [notice, setNotice] = useState("");
  const [operation, setOperation] = useState<{ item: GatewayIntegration; action: IntegrationAction } | null>(null);
  const disabled = mutation.busy || Boolean(mutation.pending) || Boolean(secret);
  async function create() {
    if (!draft.name.trim() || !validExpiry(draft.days)) return;
    const result = await mutation.run<GatewayIntegration & { token: string }>(
      `创建智能体接入：${draft.name.trim()}`,
      "/gateway-integrations",
      { name: draft.name.trim(), expiresInDays: Number(draft.days) },
    );
    if (result) {
      setSecret({ name: result.name, token: result.token });
      setDraft({ name: "", days: draft.days });
      setNotice("接入已创建。保存 API Key 后，请到渠道账号绑定关联员工身份。");
      await list.refresh();
    }
  }
  async function applyOperation(reason: string, expiresInDays: number) {
    if (!operation) return false;
    const { item, action } = operation;
    const result = await mutation.run<GatewayIntegration & { token?: string }>(
      `${integrationActionLabels[action]}：${item.name}（${item.id}，版本 ${item.revision}）`,
      `/gateway-integrations/${item.id}/${action}`,
      { expectedRevision: item.revision, reason, ...(action === "rotate" ? { expiresInDays } : {}) },
    );
    setOperation(null);
    if (result) {
      if (action === "rotate" && result.token) setSecret({ name: result.name, token: result.token });
      setNotice(action === "rotate" ? "API Key 已更换，请保存并更新智能体服务端的配置。" : `${integrationActionLabels[action]}已完成。`);
      await list.refresh();
    }
    return Boolean(result);
  }
  return <Panel title="智能体接入" action={<InfoHint label="智能体接入说明">
    创建本商家的 API Key，复制到外部工作人员智能体或企业微信 Gateway 服务端的 PMS 连接配置。
    然后在「渠道账号绑定」中，将核验过的外部员工账号编号绑定到真实员工。
    智能体按该员工的实际权限办理业务，接入 Key 本身不授予管理员权限。
    此 Key 用于连接 PMS；调用模型的 API Key 在外部智能体服务端配置，PMS 内置 AI 助手由平台统一配置。
  </InfoHint>}>
    <ErrorNotice error={list.error ?? mutation.error} retry={() => void list.refresh()} />
    <PendingGateway mutation={mutation} refresh={list.refresh}
      recoveryDetail="请核对接入状态，并在接入详情中查看版本和最近更换时间。若创建或更换已完成但没有拿到 API Key，结束核对后可再次更换 Key；旧 Key 会失效。" />
    {notice && <p className="tennis-success" role="status">{notice}</p>}
    {secret && <div className="tennis-note">
      <h3>保存「{secret.name}」的 API Key</h3>
      <p>API Key 只显示一次，请复制到智能体服务端的 PMS 连接配置。离开此栏目后无法再次查看。</p>
      <label className="tennis-form">API Key
        <input aria-label="一次性 API Key" readOnly value={secret.token} autoComplete="off" spellCheck={false} />
      </label>
      <div className="tennis-actions">
        <button type="button" className="button button-secondary" onClick={() => {
          if (!navigator.clipboard?.writeText) {
            setNotice("未能自动复制，请手动选择并保存上方 API Key。");
            return;
          }
          void navigator.clipboard.writeText(secret.token).then(
            () => setNotice("API Key 已复制。"),
            () => setNotice("未能自动复制，请手动选择并保存上方 API Key。"),
          );
        }}><Copy size={15} />复制 API Key</button>
        <button type="button" className="button button-secondary" onClick={() => {
          setSecret(null);
          setNotice("API Key 已隐藏。");
        }}>已保存，隐藏 API Key</button>
      </div>
    </div>}
    <form className="tennis-form" onSubmit={(event) => { event.preventDefault(); void create(); }}>
      <label>接入名称
        <input required maxLength={200} placeholder="例如：工作人员助手" value={draft.name} disabled={disabled}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
      </label>
      <label>有效期（天）
        <input type="number" required min={1} max={365} step={1} value={draft.days} disabled={disabled}
          onChange={(event) => setDraft({ ...draft, days: event.target.value })} />
      </label>
      <div className="tennis-actions">
        <button className="button button-primary" disabled={disabled || !draft.name.trim() || !validExpiry(draft.days)}>
          <Plus size={16} />{mutation.busy ? "正在处理…" : "创建 API Key"}
        </button>
        <RefreshButton busy={list.busy || mutation.busy} onClick={() => void list.refresh()} />
      </div>
    </form>
    <h3 className="tennis-section-title">已有接入</h3>
    {!list.data && list.busy ? <LoadingBlock /> : !list.data?.length ?
      <EmptyState title="暂无智能体接入" detail="创建 API Key，将工作人员智能体连接到本商家。" /> :
      list.data.map((item) => <div className="tennis-ledger-row" key={item.id}>
        <div>
          <div className="tennis-heading-with-help">
            <strong>{item.name}</strong>
            <InfoHint label={`${item.name}接入详情`}>
              接入编号：{item.id}<br />版本：{item.revision}<br />
              创建时间：{dateTime(item.createdAt)}<br />
              最近更换：{item.rotatedAt ? dateTime(item.rotatedAt) : "尚未更换"}
            </InfoHint>
          </div>
          <span>{integrationStatus(item)} · {item.expiresAt ? `${dateTime(item.expiresAt)} 到期` : "未设置到期时间"}</span>
        </div>
        {item.active && <div className="tennis-actions">
          {!integrationExpired(item) && <button type="button" className="button button-secondary button-small" disabled={disabled}
            onClick={() => setOperation({ item, action: item.pausedAt ? "resume" : "pause" })}>
            {item.pausedAt ? "恢复接入" : "暂停接入"}
          </button>}
          <button type="button" className="button button-secondary button-small" disabled={disabled}
            onClick={() => setOperation({ item, action: "rotate" })}>更换 API Key</button>
          <button type="button" className="button button-secondary button-small" disabled={disabled}
            onClick={() => setOperation({ item, action: "revoke" })}>撤销接入</button>
        </div>}
      </div>)}
    {operation && <IntegrationActionDialog key={`${operation.item.id}:${operation.action}`}
      item={operation.item} action={operation.action} scope={scope} busy={mutation.busy}
      onClose={() => setOperation(null)} onConfirm={applyOperation} />}
  </Panel>;
}

export function TenantGatewayPanel({ api, scope }: { api: TennisApi; scope: string }) {
  const list = useLoad(() => api<BindingList>("/gateway-bindings"), [api]);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const targets = useLoad(
    () => api<BindingTarget[]>(`/gateway-binding-targets?q=${encodeURIComponent(query)}`),
    [api, query],
  );
  const [draft, setDraft] = useDraft(`tennis:gateway-binding:${scope}`, {
    integrationId: "",
    externalSubjectId: "",
    target: null as BindingTarget | null,
    reason: "",
  });
  const mutation = useGatewayMutation(api, `tenant:${scope}`);
  const [revoke, setRevoke] = useState<GatewayBinding | null>(null);
  const [notice, setNotice] = useState("");
  const integrations = list.data?.integrations ?? [];
  const disabled = mutation.busy || Boolean(mutation.pending);
  async function create() {
    if (!draft.target) return;
    const payload = {
      integrationId: draft.integrationId,
      externalSubjectId: draft.externalSubjectId.trim(),
      ...(draft.target.actorKind === "customer"
        ? { actorKind: "customer" as const, customerId: draft.target.customerId }
        : { actorKind: "staff" as const, subjectId: draft.target.subjectId }),
      reason: draft.reason.trim(),
    };
    const result = await mutation.run<GatewayBinding>(
      `绑定渠道账号 ${payload.externalSubjectId} 至${draft.target.name}`,
      "/gateway-bindings",
      payload,
    );
    if (result) {
      setDraft({ integrationId: draft.integrationId, externalSubjectId: "", target: null, reason: "" });
      setNotice("渠道账号已绑定。");
      await list.refresh();
    }
  }
  async function revokeItem(reason: string) {
    if (!revoke) return false;
    const result = await mutation.run<GatewayBinding>(
      `撤销渠道账号 ${revoke.externalSubjectId}（${revoke.id}）`,
      `/gateway-bindings/${revoke.id}/revoke`,
      { reason },
    );
    setRevoke(null);
    if (result) {
      setNotice("渠道账号绑定已撤销。");
      await list.refresh();
    }
    return Boolean(result);
  }
  return (
    <Panel
      title="渠道账号绑定"
      action={<div className="tennis-actions">
        <InfoHint label="渠道账号绑定说明">把微信等渠道账号关联到已有客户或员工。此处填写已核验的渠道账号编号；API Key 在「智能体接入」创建并配置到智能体服务端。新客户请先建档，手机号相同不会自动绑定。</InfoHint>
        <RefreshButton busy={list.busy || mutation.busy} onClick={() => void list.refresh()} />
      </div>}
    >
      <p className="tennis-muted">绑定前，请确认渠道账号属于所选本人。</p>
      <ErrorNotice error={list.error ?? mutation.error} retry={() => void list.refresh()} />
      <PendingGateway mutation={mutation} refresh={list.refresh} />
      {notice && (
        <p className="tennis-success" role="status">
          {notice}
        </p>
      )}
      {!integrations.some(integrationEnabled) ? (
        <EmptyState title="暂无启用的渠道接入" detail="请先到「智能体接入」创建或恢复接入；已到期的 Key 需要更换。" />
      ) : (
        <form
          className="tennis-form"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <label>
            渠道接入
            <select
              required
              value={draft.integrationId}
              disabled={disabled}
              onChange={(event) => setDraft({ ...draft, integrationId: event.target.value })}
            >
              <option value="">请选择接入</option>
              {integrations
                .filter(integrationEnabled)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
            </select>
          </label>
          <label>
            渠道账号编号
            <input
              required
              maxLength={200}
              value={draft.externalSubjectId}
              disabled={disabled}
              placeholder="由已核验的渠道账号提供"
              onChange={(event) => setDraft({ ...draft, externalSubjectId: event.target.value })}
            />
          </label>
          <label>
            查找客户或员工
            <input
              value={search}
              disabled={disabled}
              placeholder="输入姓名查找"
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <ErrorNotice error={targets.error} retry={() => void targets.refresh()} />
          {draft.target && (
            <p className="tennis-note">
              已选：{draft.target.name} · {draft.target.actorKind === "staff" ? "员工" : "客户"}
              <InfoHint label="所选账号编号">{draft.target.actorKind === "customer" ? "客户编号" : "员工编号"}：{targetId(draft.target)}</InfoHint>
            </p>
          )}
          <div className="tennis-customer-results">
            {targets.data?.map((target) => (
              <label className="tennis-check" key={targetKey(target)}>
                <input
                  type="radio"
                  name="gateway-target"
                  disabled={disabled}
                  checked={Boolean(draft.target && targetKey(draft.target) === targetKey(target))}
                  onChange={() => setDraft({ ...draft, target })}
                />
                {target.name} · {target.actorKind === "staff" ? "员工" : "客户"}
                <small> {targetId(target).slice(0, 8)}</small>
              </label>
            ))}
            {targets.data?.length === 0 && (
              <p className="tennis-muted">
                未找到客户或员工。新客户请先到客户页面建档。
              </p>
            )}
          </div>
          <label>
            核验说明
            <textarea
              required
              maxLength={2000}
              disabled={disabled}
              placeholder="如：已当面核对本人和微信账号"
              value={draft.reason}
              onChange={(event) => setDraft({ ...draft, reason: event.target.value })}
            />
          </label>
          <button
            className="button button-primary"
            disabled={
              disabled ||
              !draft.target ||
              !draft.externalSubjectId.trim() ||
              !draft.reason.trim() ||
              !integrations.some((item) => item.id === draft.integrationId && integrationEnabled(item))
            }
          >
            {mutation.busy ? "正在处理…" : "确认绑定"}
          </button>
        </form>
      )}
      <h3 className="tennis-section-title">已有绑定</h3>
      {!list.data && list.busy ? (
        <LoadingBlock />
      ) : !list.data?.bindings.length ? (
        <EmptyState title="暂无身份绑定" detail="选择渠道账号和对应客户或员工，即可添加绑定。" />
      ) : (
        list.data.bindings.map((binding) => {
          const integration = integrations.find((item) => item.id === binding.integrationId);
          const target = targets.data?.find(
            (item) =>
              item.actorKind === binding.actorKind &&
              (item.actorKind === "customer"
                ? item.customerId === binding.customerId
                : item.subjectId === binding.subjectId),
          );
          const actorLabel = binding.actorKind === "staff" ? "员工" : "客户";
          const accountId = binding.customerId ?? binding.subjectId;
          return (
            <div className="tennis-ledger-row" key={binding.id}>
              <div>
                <div className="tennis-heading-with-help">
                  <strong>{target?.name ?? `${actorLabel} ${accountId.slice(0, 8)}`}</strong>
                  <InfoHint label="查看绑定详情">
                    渠道账号：{binding.externalSubjectId}<br />
                    {actorLabel}编号：{accountId}<br />
                    核验说明：{binding.reason}
                  </InfoHint>
                </div>
                <span>
                  {integration?.name ?? "渠道接入"} · {actorLabel} ·{" "}
                  {binding.active ? (integration ? integrationStatus(integration) : "接入不可用") : "已撤销绑定"}
                </span>
                <small>渠道账号：{shortAccountId(binding.externalSubjectId)}</small>
              </div>
              {binding.active && (
                <button
                  type="button"
                  className="button button-secondary button-small"
                  disabled={disabled}
                  onClick={() => setRevoke(binding)}
                >
                  撤销绑定
                </button>
              )}
            </div>
          );
        })
      )}
      {revoke && (
        <GatewayRevokeDialog
          title={`绑定 · ${shortAccountId(revoke.externalSubjectId)}`}
          scope={`binding:${scope}:${revoke.id}`}
          busy={mutation.busy}
          onClose={() => setRevoke(null)}
          onConfirm={revokeItem}
        />
      )}
    </Panel>
  );
}
