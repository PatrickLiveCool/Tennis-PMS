import { useEffect, useRef, useState, type FormEvent } from "react";
import { Plus, Save } from "lucide-react";
import { TennisApiError, type TennisApi } from "./api";
import type { AIConfig } from "../../../../packages/db/src/tennis/external-agent";
import type { TenantRecord } from "./types";
import { PlatformGatewayPanel } from "./GatewayPanel";
import {
  dateTime,
  EmptyState,
  ErrorNotice,
  LoadingBlock,
  Modal,
  PageHeading,
  Panel,
  RefreshButton,
  useLoad,
  writeStored,
} from "./components";

interface TenantDraft {
  name: string;
  adminUsername: string;
  adminDisplayName: string;
  adminPassword: string;
}
const emptyTenant: TenantDraft = { name: "", adminUsername: "", adminDisplayName: "", adminPassword: "" };
function unknownResult(error: unknown): boolean {
  return !(error instanceof TennisApiError) || error.uncertain;
}
interface PendingTenantProvision {
  name: string;
  adminUsername: string;
  adminDisplayName: string;
  pending: true;
}
function savedProvision(key: string): PendingTenantProvision | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? "null") as Partial<PendingTenantProvision> | null;
    return value?.pending === true &&
      typeof value.name === "string" &&
      typeof value.adminUsername === "string" &&
      typeof value.adminDisplayName === "string"
      ? {
          name: value.name,
          adminUsername: value.adminUsername,
          adminDisplayName: value.adminDisplayName,
          pending: true,
        }
      : null;
  } catch {
    return null;
  }
}

export function PlatformPage({ api, scope }: { api: TennisApi; scope: string }) {
  const tenants = useLoad(() => api<TenantRecord[]>("/platform/tenants"), [api]);
  const [open, setOpen] = useState(false);
  const [statusTenant, setStatusTenant] = useState<TenantRecord | null>(null);
  const pendingKey = `tennis:platform-provision:${scope}`;
  const [restored] = useState(() => savedProvision(pendingKey));
  // Only the intended tenant/account identity survives navigation; passwords never do.
  const [draft, setDraft] = useState<TenantDraft>(() =>
    restored
      ? {
          name: restored.name,
          adminUsername: restored.adminUsername,
          adminDisplayName: restored.adminDisplayName,
          adminPassword: "",
        }
      : emptyTenant,
  );
  const [busy, setBusy] = useState(false),
    [uncertain, setUncertain] = useState(Boolean(restored)),
    [checked, setChecked] = useState(false);
  const [error, setError] = useState<unknown>(),
    [notice, setNotice] = useState("");
  const running = useRef(false);
  async function refreshTenants() {
    const result = await tenants.refresh();
    if (result && uncertain) setChecked(true);
  }
  function update(patch: Partial<TenantDraft>) {
    if (!busy && !uncertain) {
      setDraft((value) => ({ ...value, ...patch }));
      setError(undefined);
    }
  }
  async function provision(event: FormEvent) {
    event.preventDefault();
    if (running.current || (uncertain && !checked)) return;
    if (draft.adminPassword.length < 12) {
      setError(new Error("管理员密码至少需要 12 位。"));
      return;
    }
    running.current = true;
    setBusy(true);
    setError(undefined);
    setNotice("");
    writeStored(pendingKey, {
      name: draft.name.trim(),
      adminUsername: draft.adminUsername.trim(),
      adminDisplayName: draft.adminDisplayName.trim(),
      pending: true,
    } satisfies PendingTenantProvision);
    try {
      const result = await api<{ id: string; name: string; adminSubjectId: string }>("/platform/tenants", "POST", {
        name: draft.name.trim(),
        adminUsername: draft.adminUsername.trim(),
        adminDisplayName: draft.adminDisplayName.trim(),
        adminPassword: draft.adminPassword,
      });
      setNotice(`「${result.name}」已开通，租户管理员可使用所设账号登录。`);
      writeStored(pendingKey, null);
      setDraft(emptyTenant);
      setUncertain(false);
      setChecked(false);
      setOpen(false);
      await tenants.refresh();
    } catch (next) {
      setError(next);
      if (unknownResult(next) || uncertain) {
        setUncertain(true);
        setChecked(false);
      } else writeStored(pendingKey, null);
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeading
        title="平台运营"
        description="人工开通租户，统一维护 AI 服务。租户独立管理自己的场馆、价格与资金。"
      />
      {notice && (
        <div className="tennis-success" role="status">
          {notice}
        </div>
      )}
      {uncertain && !open && (
        <div className="tennis-note is-warning" role="status">
          「{draft.name}」的开通结果仍需核对，请点击“核对上次开通”继续处理。
        </div>
      )}
      <Panel
        title="租户"
        action={
          <div className="tennis-actions">
            <RefreshButton onClick={() => void refreshTenants()} busy={tenants.busy || busy} />
            <button className="button button-primary" type="button" onClick={() => setOpen(true)}>
              <Plus size={16} />
              {uncertain ? "核对上次开通" : "开通租户"}
            </button>
          </div>
        }
      >
        <ErrorNotice error={tenants.error} retry={() => void refreshTenants()} />
        {!tenants.data && tenants.busy ? (
          <LoadingBlock />
        ) : !tenants.data?.length ? (
          <EmptyState title="还没有租户" detail="开通租户及首位管理员后，由租户配置场馆和球场。" />
        ) : (
          <div className="tennis-table-scroll">
            <table className="tennis-table">
              <thead>
                <tr>
                  <th>租户名称</th>
                  <th>状态</th>
                  <th>开通时间</th>
                  <th>租户编号</th>
                  <th>服务管理</th>
                </tr>
              </thead>
              <tbody>
                {tenants.data.map((tenant) => (
                  <tr key={tenant.id}>
                    <td>
                      <strong>{tenant.name}</strong>
                    </td>
                    <td>
                      <span
                        className={`status-badge ${tenant.active ? "tennis-status-confirmed" : "tennis-status-cancelled"}`}
                      >
                        {tenant.active ? "使用中" : "已停用"}
                      </span>
                    </td>
                    <td>{dateTime(tenant.createdAt)}</td>
                    <td>
                      <small>{tenant.id}</small>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="button button-secondary button-small"
                        onClick={() => setStatusTenant(tenant)}
                      >
                        {tenant.active ? "停用服务" : "恢复服务"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="tennis-muted">平台账号负责开通和维护服务；进入租户业务需要相应租户的员工权限。</p>
      </Panel>
      <PlatformGatewayPanel api={api} tenants={tenants.data ?? []} scope={scope} />
      <AISettings api={api} />
      {statusTenant && (
        <TenantStatusEditor
          api={api}
          tenant={statusTenant}
          onClose={() => setStatusTenant(null)}
          onChanged={() => void tenants.refresh()}
        />
      )}
      {open && (
        <Modal
          title={uncertain ? "核对租户开通结果" : "人工开通租户"}
          onClose={() => setOpen(false)}
          closeDisabled={busy}
        >
          <form className="tennis-form" onSubmit={(event) => void provision(event)}>
            <ErrorNotice error={error} />
            {uncertain && (
              <div className="tennis-note is-warning" role="status">
                上次提交的结果尚未确认。请先刷新租户列表核对「{draft.name}」，保留管理员账号「{draft.adminUsername}
                」。重试会沿用同一账号；不要改用新账号重复开通。密码不会保存，返回此页面后如需重试，请重新填写密码。
              </div>
            )}
            <label>
              租户名称
              <input
                required
                maxLength={200}
                value={draft.name}
                disabled={busy || uncertain}
                onChange={(event) => update({ name: event.target.value })}
                placeholder="例如：格林网球"
              />
            </label>
            <label>
              管理员姓名
              <input
                required
                maxLength={200}
                value={draft.adminDisplayName}
                disabled={busy || uncertain}
                onChange={(event) => update({ adminDisplayName: event.target.value })}
              />
            </label>
            <label>
              管理员登录账号
              <input
                required
                minLength={3}
                maxLength={100}
                pattern="[a-zA-Z0-9][a-zA-Z0-9._@+\-]{2,99}"
                title="3–100 位字母、数字或 . _ @ + -，以字母或数字开头"
                autoComplete="off"
                value={draft.adminUsername}
                disabled={busy || uncertain}
                onChange={(event) => update({ adminUsername: event.target.value })}
              />
            </label>
            <label>
              管理员初始密码
              <input
                required
                type="password"
                minLength={12}
                maxLength={256}
                autoComplete="new-password"
                value={draft.adminPassword}
                disabled={busy}
                onChange={(event) => {
                  if (!busy) setDraft((value) => ({ ...value, adminPassword: event.target.value }));
                }}
              />
            </label>
            <p className="tennis-muted">密码至少 12 位，请通过约定方式交给租户管理员。系统不会在列表中展示密码。</p>
            {uncertain && (
              <>
                <RefreshButton onClick={() => void refreshTenants()} busy={tenants.busy || busy} />
                <ErrorNotice error={tenants.error} />
                {checked && (
                  <div className="tennis-note">
                    已重新读取列表。相同名称的记录：
                    {tenants.data
                      ?.filter((tenant) => tenant.name === draft.name.trim())
                      .map((tenant) => `${tenant.name}（${tenant.id}）`)
                      .join("；") || "暂未查到"}
                    。名称相同仍需核实，不能仅凭名称判定开通成功。
                  </div>
                )}
              </>
            )}
            <div className="tennis-actions">
              <button className="button button-secondary" type="button" disabled={busy} onClick={() => setOpen(false)}>
                暂存并关闭
              </button>
              {uncertain && checked && (
                <button
                  className="button button-secondary"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    writeStored(pendingKey, null);
                    setDraft(emptyTenant);
                    setUncertain(false);
                    setChecked(false);
                    setOpen(false);
                    setError(undefined);
                    setNotice("已结束本次开通核对，请以租户列表和管理员实际登录结果为准。");
                  }}
                >
                  已人工核对，结束本次操作
                </button>
              )}
              <button
                className="button button-primary"
                type="submit"
                disabled={
                  busy ||
                  (uncertain && !checked) ||
                  !draft.name.trim() ||
                  !draft.adminUsername.trim() ||
                  !draft.adminDisplayName.trim() ||
                  draft.adminPassword.length < 12
                }
              >
                {busy ? "正在开通…" : uncertain ? "重试同一账号" : "开通租户及管理员"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}

function TenantStatusEditor({
  api,
  tenant,
  onClose,
  onChanged,
}: {
  api: TennisApi;
  tenant: TenantRecord;
  onClose: () => void;
  onChanged: () => void;
}) {
  const desired = !tenant.active;
  const [current, setCurrent] = useState(tenant),
    [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false),
    [uncertain, setUncertain] = useState(false),
    [done, setDone] = useState(false);
  const [error, setError] = useState<unknown>();
  async function verify() {
    setBusy(true);
    setError(undefined);
    try {
      const tenants = await api<TenantRecord[]>("/platform/tenants");
      const found = tenants.find((item) => item.id === tenant.id);
      if (!found) throw new Error("未找到原租户，请关闭后刷新列表核对。");
      setCurrent(found);
      setUncertain(false);
      setDone(found.active === desired);
      onChanged();
    } catch (next) {
      setError(next);
    } finally {
      setBusy(false);
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || uncertain || done) return;
    setBusy(true);
    setError(undefined);
    try {
      await api(`/platform/tenants/${tenant.id}/status`, "POST", {
        active: desired,
        expectedActive: current.active,
        reason: reason.trim(),
      });
      setDone(true);
      onChanged();
    } catch (next) {
      setError(next);
      setUncertain(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={`${desired ? "恢复" : "停用"}租户服务`} onClose={onClose} closeDisabled={busy}>
      <form className="tennis-form" onSubmit={(event) => void save(event)}>
        <strong>{tenant.name}</strong>
        <ErrorNotice error={error} />
        {done ? (
          <div className="tennis-success" role="status">
            当前服务已{desired ? "恢复" : "停用"}。
          </div>
        ) : (
          <>
            <p className="tennis-muted">
              {desired
                ? "恢复后，租户原有授权账号可以继续使用业务。"
                : "停用后，该租户的客户和员工将无法访问业务，外部智能体的现有授权会撤销。预约与资金记录保留，到期处理仍继续执行。"}
            </p>
            <label>
              处理原因
              <textarea
                required
                maxLength={2000}
                value={reason}
                disabled={busy || uncertain}
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
            {uncertain && (
              <div className="tennis-note is-warning">
                提交结果需要核对，请先读取当前服务状态。
                <button type="button" className="button button-secondary" disabled={busy} onClick={() => void verify()}>
                  核对当前状态
                </button>
              </div>
            )}
          </>
        )}
        <div className="tennis-actions">
          <button type="button" className="button button-secondary" disabled={busy} onClick={onClose}>
            关闭
          </button>
          {!done && (
            <button type="submit" className="button button-primary" disabled={busy || uncertain || !reason.trim()}>
              {busy ? "正在处理…" : `确认${desired ? "恢复" : "停用"}`}
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}

function AISettings({ api }: { api: TennisApi }) {
  const config = useLoad(() => api<AIConfig>("/platform/ai-config"), [api]);
  const [draft, setDraft] = useState<AIConfig | null>(null);
  const [keyMode, setKeyMode] = useState<"keep" | "replace" | "clear">("keep"),
    [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false),
    [needsReview, setNeedsReview] = useState(false),
    [review, setReview] = useState<AIConfig | null>(null);
  const [error, setError] = useState<unknown>(),
    [notice, setNotice] = useState("");
  const running = useRef(false);
  useEffect(() => {
    if (!draft && config.data) setDraft(config.data);
  }, [config.data, draft]);
  function update(patch: Partial<AIConfig>) {
    if (!busy) {
      setDraft((value) => (value ? { ...value, ...patch } : value));
      setNotice("");
    }
  }
  async function reload() {
    const latest = await config.refresh();
    if (latest) {
      setReview(latest);
      setNeedsReview(true);
      setNotice("");
    }
  }
  function adoptLatest(keepInput: boolean) {
    if (!review) return;
    setDraft((value) =>
      keepInput && value ? { ...value, hasApiKey: review.hasApiKey, revision: review.revision } : review,
    );
    if (!keepInput) {
      setApiKey("");
      setKeyMode("keep");
    }
    setReview(null);
    setNeedsReview(false);
    setError(undefined);
    setNotice("已核对当前配置，可继续编辑后保存。");
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft || running.current || needsReview) return;
    if (keyMode === "replace" && !apiKey.trim()) {
      setError(new Error("请选择保留密钥，或填写要替换的新密钥。"));
      return;
    }
    running.current = true;
    setBusy(true);
    setError(undefined);
    setNotice("");
    try {
      const result = await api<AIConfig>("/platform/ai-config", "PUT", {
        enabled: draft.enabled,
        model: draft.model.trim(),
        baseUrl: draft.baseUrl.trim(),
        externalAgentUrl: draft.externalAgentUrl.trim(),
        expectedRevision: draft.revision,
        ...(keyMode === "replace" ? { apiKey } : keyMode === "clear" ? { apiKey: "" } : {}),
      });
      setDraft(result);
      setApiKey("");
      setKeyMode("keep");
      setNeedsReview(false);
      setReview(null);
      setNotice("统一 AI 配置已保存。服务是否可用，以实际会话结果为准。");
      await config.refresh();
    } catch (next) {
      setError(next);
      if (unknownResult(next) || (next instanceof TennisApiError && next.code === "STALE_CONFIGURATION")) {
        setNeedsReview(true);
        setReview(null);
      }
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return (
    <Panel title="统一 AI 配置" action={<RefreshButton onClick={() => void reload()} busy={config.busy || busy} />}>
      <ErrorNotice error={error ?? config.error} retry={() => void reload()} />
      {!draft ? (
        config.busy ? (
          <LoadingBlock />
        ) : (
          <p className="tennis-muted">读取配置后即可编辑。</p>
        )
      ) : (
        <form className="tennis-form" onSubmit={(event) => void save(event)}>
          {notice && (
            <div className="tennis-success" role="status">
              {notice}
            </div>
          )}
          <p className="tennis-muted">由平台运营方统一维护。后台助手连接外部智能体服务，租户不配置模型和密钥。</p>
          <label className="tennis-check">
            <input
              type="checkbox"
              checked={draft.enabled}
              disabled={busy}
              onChange={(event) => update({ enabled: event.target.checked })}
            />
            启用外部 AI 助手
          </label>
          <div className="tennis-two">
            <label>
              模型名称
              <input
                maxLength={200}
                value={draft.model}
                disabled={busy}
                onChange={(event) => update({ model: event.target.value })}
                placeholder="填写指定模型名称"
              />
            </label>
            <label>
              模型服务地址（Base URL）
              <input
                type="url"
                maxLength={2000}
                value={draft.baseUrl}
                disabled={busy}
                onChange={(event) => update({ baseUrl: event.target.value })}
                placeholder="https://…"
              />
            </label>
          </div>
          <label>
            外部智能体服务地址
            <input
              type="url"
              maxLength={2000}
              value={draft.externalAgentUrl}
              disabled={busy}
              onChange={(event) => update({ externalAgentUrl: event.target.value })}
              placeholder="https://…"
            />
          </label>
          <label>
            服务密钥
            <select
              value={keyMode}
              disabled={busy}
              onChange={(event) => {
                setKeyMode(event.target.value as typeof keyMode);
                setApiKey("");
                setNotice("");
              }}
            >
              <option value="keep">{draft.hasApiKey ? "保留已保存密钥" : "保持未设置密钥"}</option>
              <option value="replace">设置或替换密钥</option>
              {draft.hasApiKey && <option value="clear">明确清除已保存密钥</option>}
            </select>
          </label>
          {keyMode === "replace" && (
            <label>
              新密钥
              <input
                type="password"
                required
                maxLength={4096}
                autoComplete="new-password"
                value={apiKey}
                disabled={busy}
                onChange={(event) => setApiKey(event.target.value)}
              />
            </label>
          )}
          <p className="tennis-muted">
            {draft.hasApiKey ? "服务器已保存密钥，原值不会回填。" : "当前未设置密钥。"}
            {keyMode === "clear"
              ? "本次保存将清除服务器中的密钥。"
              : keyMode === "keep"
                ? "保持此选项将保留当前密钥状态。"
                : "新密钥仅在本次保存时提交。"}
          </p>
          {needsReview && (
            <div className="tennis-note is-warning">
              <p>请先读取服务器当前配置核对；你的输入仍保留，尚未覆盖新版本。</p>
              <button
                className="button button-secondary"
                type="button"
                disabled={busy || config.busy}
                onClick={() => void reload()}
              >
                读取当前配置核对
              </button>
              {review && (
                <>
                  <dl>
                    <dt>当前状态</dt>
                    <dd>
                      {review.enabled ? "启用" : "停用"} · 配置版本 {review.revision}
                    </dd>
                    <dt>模型</dt>
                    <dd>{review.model || "未设置"}</dd>
                    <dt>Base URL</dt>
                    <dd style={{ overflowWrap: "anywhere" }}>{review.baseUrl || "未设置"}</dd>
                    <dt>外部智能体地址</dt>
                    <dd style={{ overflowWrap: "anywhere" }}>{review.externalAgentUrl || "未设置"}</dd>
                    <dt>密钥</dt>
                    <dd>{review.hasApiKey ? "已保存，原值不显示" : "未设置"}</dd>
                  </dl>
                  <div className="tennis-actions">
                    <button className="button button-secondary" type="button" onClick={() => adoptLatest(false)}>
                      采用服务器配置
                    </button>
                    <button className="button button-secondary" type="button" onClick={() => adoptLatest(true)}>
                      保留输入，按当前版本继续编辑
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
          <div className="tennis-actions">
            <button
              className="button button-primary"
              type="submit"
              disabled={busy || needsReview || config.busy || (keyMode === "replace" && !apiKey.trim())}
            >
              <Save size={16} />
              {busy ? "正在保存…" : "保存统一配置"}
            </button>
          </div>
        </form>
      )}
    </Panel>
  );
}
