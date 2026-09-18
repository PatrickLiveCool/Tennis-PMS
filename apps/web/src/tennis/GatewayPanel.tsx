import { useEffect, useRef, useState } from "react";
import { Copy, Plus } from "lucide-react";
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
interface BindingTarget {
  subjectId: string;
  actorKind: "staff" | "customer";
  name: string;
  customerId: string | null;
}
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
}: {
  mutation: ReturnType<typeof useGatewayMutation>;
  refresh: () => Promise<unknown>;
}) {
  if (!mutation.pending || mutation.busy) return null;
  return (
    <div className="tennis-note is-warning" role="status">
      <p>「{mutation.pending}」的结果尚未确认。先刷新原列表，核对是否已经完成；不要直接重复创建。</p>
      <p>若接入已经创建但凭据未取得，请核对后撤销该接入，再创建新凭据。</p>
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
          刷新原列表
        </button>
        <button
          type="button"
          className="button button-secondary"
          disabled={!mutation.checked}
          onClick={mutation.doneChecking}
        >
          已人工核对列表，结束本次操作
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
        <p>撤销后，此接入或身份绑定不能继续取得业务授权。已有订单和资金记录保留。</p>
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
    <Panel title="渠道接入">
      <p className="tennis-muted">平台为每个租户独立创建 Gateway 接入凭据；租户管理员再核验并绑定客户或员工身份。</p>
      {selected ? (
        <>
          <label className="tennis-form">
            接入所属租户
            <select
              aria-label="渠道接入所属租户"
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
        <EmptyState title="先开通租户" detail="每项渠道接入固定归属一个租户。" />
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
          <p>凭据只在本次创建后显示。复制保存后再切换租户或离开本页；关闭后无法再次查看。</p>
          <label className="tennis-form">
            Gateway 凭据
            <input
              aria-label="一次性 Gateway 凭据"
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
                setNotice("凭据已隐藏。列表只显示接入状态。");
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
        <EmptyState title="暂无渠道接入" detail="创建接入后，由租户管理员完成渠道身份绑定。" />
      ) : (
        list.data.map((item) => (
          <div className="tennis-ledger-row" key={item.id}>
            <div>
              <strong>{item.name}</strong>
              <span>
                {item.active ? "启用" : "已撤销"} · {dateTime(item.createdAt)}
              </span>
              <small>接入编号 {item.id}</small>
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
      subjectId: draft.target.subjectId,
      actorKind: draft.target.actorKind,
      reason: draft.reason.trim(),
    };
    const result = await mutation.run<GatewayBinding>(
      `绑定渠道身份 ${payload.externalSubjectId} 至${draft.target.name}`,
      "/gateway-bindings",
      payload,
    );
    if (result) {
      setDraft({ integrationId: draft.integrationId, externalSubjectId: "", target: null, reason: "" });
      setNotice("渠道身份已绑定。");
      await list.refresh();
    }
  }
  async function revokeItem(reason: string) {
    if (!revoke) return false;
    const result = await mutation.run<GatewayBinding>(
      `撤销渠道身份 ${revoke.externalSubjectId}（${revoke.id}）`,
      `/gateway-bindings/${revoke.id}/revoke`,
      { reason },
    );
    setRevoke(null);
    if (result) {
      setNotice("渠道身份绑定已撤销。");
      await list.refresh();
    }
    return Boolean(result);
  }
  return (
    <Panel
      title="渠道身份绑定"
      action={<RefreshButton busy={list.busy || mutation.busy} onClick={() => void list.refresh()} />}
    >
      <p className="tennis-muted">
        仅租户管理员办理。先人工核对渠道账号与客户或员工本人身份，再选择已有的 PMS 身份；手机号不会自动建立绑定。
      </p>
      <ErrorNotice error={list.error ?? mutation.error} retry={() => void list.refresh()} />
      <PendingGateway mutation={mutation} refresh={list.refresh} />
      {notice && (
        <p className="tennis-success" role="status">
          {notice}
        </p>
      )}
      {!integrations.some((item) => item.active) ? (
        <EmptyState title="暂无启用的渠道接入" detail="请平台运营方先为当前租户创建接入。" />
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
                .filter((item) => item.active)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
            </select>
          </label>
          <label>
            渠道身份编号
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
            查找 PMS 客户或员工
            <input
              value={search}
              disabled={disabled}
              placeholder="输入姓名查询已有身份"
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <ErrorNotice error={targets.error} retry={() => void targets.refresh()} />
          {draft.target && (
            <p className="tennis-note">
              已选：{draft.target.name} · {draft.target.actorKind === "staff" ? "员工" : "客户"}
              <small> 身份编号 {draft.target.subjectId}</small>
            </p>
          )}
          <div className="tennis-customer-results">
            {targets.data?.map((target) => (
              <label className="tennis-check" key={`${target.subjectId}:${target.actorKind}`}>
                <input
                  type="radio"
                  name="gateway-target"
                  disabled={disabled}
                  checked={draft.target?.subjectId === target.subjectId && draft.target.actorKind === target.actorKind}
                  onChange={() => setDraft({ ...draft, target })}
                />
                {target.name} · {target.actorKind === "staff" ? "员工" : "客户"}
                <small> {target.subjectId.slice(0, 8)}</small>
              </label>
            ))}
            {targets.data?.length === 0 && (
              <p className="tennis-muted">未找到已关联登录身份的客户或员工。请先核实档案与本人身份，再办理绑定。</p>
            )}
          </div>
          <label>
            人工核验依据
            <textarea
              required
              maxLength={2000}
              disabled={disabled}
              placeholder="记录如何核对该渠道账号确属所选本人"
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
              !integrations.some((item) => item.id === draft.integrationId && item.active)
            }
          >
            {mutation.busy ? "正在处理…" : "确认身份并建立绑定"}
          </button>
        </form>
      )}
      <h3 className="tennis-section-title">已有绑定</h3>
      {!list.data && list.busy ? (
        <LoadingBlock />
      ) : !list.data?.bindings.length ? (
        <EmptyState title="暂无身份绑定" detail="绑定生效后，渠道才能以该客户或员工的实际权限办理业务。" />
      ) : (
        list.data.bindings.map((binding) => {
          const integration = integrations.find((item) => item.id === binding.integrationId);
          const target = targets.data?.find(
            (item) => item.subjectId === binding.subjectId && item.actorKind === binding.actorKind,
          );
          return (
            <div className="tennis-ledger-row" key={binding.id}>
              <div>
                <strong>
                  {binding.externalSubjectId} → {target?.name ?? binding.subjectId}
                </strong>
                <span>
                  {integration?.name ?? "渠道接入"} · {binding.actorKind === "staff" ? "员工" : "客户"} ·{" "}
                  {binding.active ? (integration?.active ? "启用" : "接入已撤销") : "已撤销绑定"}
                </span>
                <small>核验依据：{binding.reason}</small>
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
          title={`绑定 · ${revoke.externalSubjectId}`}
          scope={`binding:${scope}:${revoke.id}`}
          busy={mutation.busy}
          onClose={() => setRevoke(null)}
          onConfirm={revokeItem}
        />
      )}
    </Panel>
  );
}
