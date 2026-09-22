import { useEffect, useRef, useState, type FormEvent } from "react";
import { Plus, Save } from "lucide-react";
import { TennisApiError, type TennisApi } from "./api";
import type { TenantRecord, BackofficeAIConfiguration } from "./types";
import { PlatformGatewayPanel } from "./GatewayPanel";
import { MerchantBindingsPanel } from "./MerchantBindingsPanel";
import { InfoHint } from "./InfoHint";
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
      setNotice(`「${result.name}」已开通，商家管理员可使用所设账号登录。`);
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
        description="管理商家和平台服务。"
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
        title="商家"
        action={
          <div className="tennis-actions">
            <InfoHint label="商家管理说明">平台账号负责开通和维护服务。进入场馆办理业务，还需对应商家的员工权限。</InfoHint>
            <RefreshButton onClick={() => void refreshTenants()} busy={tenants.busy || busy} />
            <button className="button button-primary" type="button" onClick={() => setOpen(true)}>
              <Plus size={16} />
              {uncertain ? "核对上次开通" : "开通商家"}
            </button>
          </div>
        }
      >
        <ErrorNotice error={tenants.error} retry={() => void refreshTenants()} />
        {!tenants.data && tenants.busy ? (
          <LoadingBlock />
        ) : !tenants.data?.length ? (
          <EmptyState title="还没有商家" detail="点击“开通商家”添加首位管理员。" />
        ) : (
          <div className="tennis-table-scroll">
            <table className="tennis-table">
              <thead>
                <tr>
                  <th>商家名称</th>
                  <th>状态</th>
                  <th>开通时间</th>
                  <th>服务管理</th>
                </tr>
              </thead>
              <tbody>
                {tenants.data.map((tenant) => (
                  <tr key={tenant.id}>
                    <td>
                      <strong>{tenant.name}</strong>{" "}<InfoHint label={`${tenant.name}的商家编号`}><span style={{ overflowWrap: "anywhere" }}>{tenant.id}</span></InfoHint>
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
      </Panel>
      <PlatformGatewayPanel api={api} tenants={tenants.data ?? []} scope={scope} />
      <MerchantBindingsPanel api={api} tenants={tenants.data ?? []} scope={scope} />
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
          title={uncertain ? "核对商家开通结果" : "人工开通商家"}
          onClose={() => setOpen(false)}
          closeDisabled={busy}
        >
          <form className="tennis-form" onSubmit={(event) => void provision(event)}>
            <ErrorNotice error={error} />
            {uncertain && (
              <div className="tennis-note is-warning" role="status">
                「{draft.name}」是否开通还未确认，请先刷新列表核对。需要重试时，请使用账号「{draft.adminUsername}」，避免重复开通。
                <InfoHint label="重试开通说明">密码不会保存在草稿中，重新打开后需要再次填写。</InfoHint>
              </div>
            )}
            <label>
              商家名称
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
              管理员初始密码（至少 12 位）
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
            {uncertain && (
              <>
                <RefreshButton onClick={() => void refreshTenants()} busy={tenants.busy || busy} />
                <ErrorNotice error={tenants.error} />
                {checked && (
                  <div className="tennis-note">
                    列表中同名商家：
                    {tenants.data
                      ?.filter((tenant) => tenant.name === draft.name.trim())
                      .map((tenant) => `${tenant.name}（${tenant.id}）`)
                      .join("；") || "暂未查到"}
                    。请再核实管理员是否能登录。
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
                    setNotice("已结束核对，请确认管理员能正常登录。");
                  }}
                >
                  核对完毕
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
                {busy ? "正在开通…" : uncertain ? "重试同一账号" : "开通商家及管理员"}
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
      if (!found) throw new Error("未找到原商家，请关闭后刷新列表核对。");
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
    <Modal title={`${desired ? "恢复" : "停用"}商家服务`} onClose={onClose} closeDisabled={busy}>
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
                ? "恢复后，该商家的员工和客户可以继续使用。"
                : "停用后，该商家的员工、客户和已授权的智能体将无法继续使用。预约和资金记录保留，到期处理照常进行。"}
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
                结果还未确认，请先核对当前状态。
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
  const config = useLoad(() => api<BackofficeAIConfiguration>("/platform/ai-config"), [api]);
  const [draft, setDraft] = useState<BackofficeAIConfiguration | null>(null);
  const [keyMode, setKeyMode] = useState<"keep" | "replace" | "clear">("keep"),
    [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false),
    [needsReview, setNeedsReview] = useState(false),
    [review, setReview] = useState<BackofficeAIConfiguration | null>(null);
  const [error, setError] = useState<unknown>(),
    [notice, setNotice] = useState("");
  const [testing, setTesting] = useState(false);
  const running = useRef(false);
  const dirty = !!draft && (
    !config.data ||
    draft.enabled !== config.data.enabled ||
    draft.model !== config.data.model ||
    draft.baseUrl !== config.data.baseUrl ||
    keyMode !== "keep"
  );
  useEffect(() => {
    if (!draft && config.data) setDraft(config.data);
  }, [config.data, draft]);
  function update(patch: Partial<BackofficeAIConfiguration>) {
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
    setNotice("已核对，可以继续编辑。");
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
      const result = await api<BackofficeAIConfiguration>("/platform/ai-config", "PUT", {
        enabled: draft.enabled,
        model: draft.model.trim(),
        baseUrl: draft.baseUrl.trim(),
        expectedRevision: draft.revision,
        ...(keyMode === "replace" ? { apiKey } : keyMode === "clear" ? { apiKey: "" } : {}),
      });
      setDraft(result);
      setApiKey("");
      setKeyMode("keep");
      setNeedsReview(false);
      setReview(null);
      setNotice("AI 配置已保存。");
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
  async function testConnection() {
    if (!draft || running.current || dirty || needsReview) return;
    running.current = true;
    setBusy(true);
    setTesting(true);
    setError(undefined);
    setNotice("");
    try {
      const result = await api<{ ok: true; message: string }>("/platform/ai-config/test", "POST", {
        expectedRevision: draft.revision,
      });
      if (result.ok !== true) throw new Error("未收到有效的连接测试结果，请重试测试。");
      setNotice(result.message || "模型连接成功。");
    } catch (next) {
      setError(next);
      if (next instanceof TennisApiError && next.code === "STALE_CONFIGURATION") {
        setNeedsReview(true);
        setReview(null);
      }
    } finally {
      running.current = false;
      setBusy(false);
      setTesting(false);
    }
  }
  return (
    <Panel title="AI 助手配置" action={<div className="tennis-actions"><InfoHint label="AI 配置说明">此配置供各场馆的后台助手使用，由平台管理员统一维护。</InfoHint><RefreshButton onClick={() => void reload()} busy={config.busy || busy} /></div>}>
      <ErrorNotice error={error ?? config.error} retry={() => void reload()} />
      {!draft ? (
        config.busy ? (
          <LoadingBlock />
        ) : (
          <p className="tennis-muted">读取配置后即可编辑。</p>
        )
      ) : (
        <form className="tennis-form" onSubmit={(event) => void save(event)}>
          {draft.connectionAvailable === false && <p className="tennis-note">当前未连接真实模型，助手暂时无法回答。</p>}
          {notice && (
            <div className="tennis-success" role="status">
              {notice}
            </div>
          )}
          <label className="tennis-check">
            <input
              type="checkbox"
              checked={draft.enabled}
              disabled={busy}
              onChange={(event) => update({ enabled: event.target.checked })}
            />
            启用后台 AI 助手
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
            模型 API Key
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
              {draft.hasApiKey && <option value="clear">清除已保存密钥</option>}
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
          {keyMode === "clear" && <p className="tennis-note is-warning">保存后将清除密钥，助手可能无法使用。</p>}
          {needsReview && (
            <div className="tennis-note is-warning">
              <p>配置需要重新核对。你的输入已保留，请先查看最新配置。</p>
              <button
                className="button button-secondary"
                type="button"
                disabled={busy || config.busy}
                onClick={() => void reload()}
              >
                查看最新配置
              </button>
              {review && (
                <>
                  <dl>
                    <dt>当前状态</dt>
                    <dd>
                      {review.enabled ? "启用" : "停用"}
                    </dd>
                    <dt>模型</dt>
                    <dd>{review.model || "未设置"}</dd>
                    <dt>Base URL</dt>
                    <dd style={{ overflowWrap: "anywhere" }}>{review.baseUrl || "未设置"}</dd>
                    <dt>密钥</dt>
                    <dd>{review.hasApiKey ? "已保存，原值不显示" : "未设置"}</dd>
                  </dl>
                  <div className="tennis-actions">
                    <button className="button button-secondary" type="button" onClick={() => adoptLatest(false)}>
                      使用最新配置
                    </button>
                    <button className="button button-secondary" type="button" onClick={() => adoptLatest(true)}>
                      保留我的输入继续编辑
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
              {busy && !testing ? "正在保存…" : "保存配置"}
            </button>
            <button
              className="button button-secondary"
              type="button"
              disabled={busy || needsReview || config.busy || dirty || !draft.model || !draft.baseUrl}
              onClick={() => void testConnection()}
            >
              {testing ? "正在测试…" : "测试模型连接"}
            </button>
            {dirty && <span className="tennis-muted">保存后可测试连接。</span>}
          </div>
        </form>
      )}
    </Panel>
  );
}
