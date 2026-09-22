import { useRef, useState, type FormEvent } from "react";
import { Save } from "lucide-react";
import { InfoHint } from "./InfoHint";
import type { MerchantBinding, MerchantProvider } from "../../../../packages/db/src/tennis/merchant-bindings";
import { TennisApiError, type TennisApi } from "./api";
import type { TenantRecord } from "./types";
import {
  dateTime,
  EmptyState,
  ErrorNotice,
  LoadingBlock,
  Panel,
  RefreshButton,
  useDraft,
  useLoad,
  writeStored,
} from "./components";

interface MerchantDraft {
  provider: MerchantProvider;
  merchantId: string;
  appId: string;
  credentialRef: string;
}
type SaveIntent = {
  kind: "save";
  provider: MerchantProvider;
  merchantId: string;
  appId?: string;
  credentialRef?: string;
  expectedVersion: number;
};
type PendingIntent = SaveIntent | { kind: "disable"; bindingId: string; expectedVersion: number };
const emptyDraft: MerchantDraft = { provider: "MOCK", merchantId: "", appId: "", credentialRef: "" };
const providerName = (provider: MerchantProvider) => (provider === "MOCK" ? "本地模拟" : "微信支付 · 未接通");
const matches = (binding: MerchantBinding, intent: SaveIntent) =>
  binding.provider === intent.provider &&
  binding.version === intent.expectedVersion + 1 &&
  binding.merchantId === intent.merchantId &&
  binding.appId === (intent.appId ?? null) &&
  binding.credentialRef === (intent.credentialRef ?? null);

export function MerchantBindingsPanel({
  api,
  tenants,
  scope,
}: {
  api: TennisApi;
  tenants: TenantRecord[];
  scope: string;
}) {
  const [tenantId, setTenantId] = useState("");
  const tenant = tenants.find((item) => item.id === tenantId) ?? tenants[0];
  return (
    <Panel title="收款商户" action={<InfoHint label="收款商户说明">预订和充值款收至所选商家自己的商户账户。</InfoHint>}>
      <p className="tennis-note">当前仅支持模拟收款，微信支付尚未接通。</p>
      {tenant ? (
        <>
          <label className="tennis-form">
            商户所属商家
            <select aria-label="商户所属商家" value={tenant.id} onChange={(event) => setTenantId(event.target.value)}>
              {tenants.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                  {item.active ? "" : "（已停用）"}
                </option>
              ))}
            </select>
          </label>
          <TenantMerchants key={`${scope}:${tenant.id}`} api={api} tenant={tenant} scope={`${scope}:${tenant.id}`} />
        </>
      ) : (
        <EmptyState title="请先开通商家" detail="开通后即可设置收款商户。" />
      )}
    </Panel>
  );
}
function TenantMerchants({ api, tenant, scope }: { api: TennisApi; tenant: TenantRecord; scope: string }) {
  const path = `/platform/tenants/${encodeURIComponent(tenant.id)}/payment-merchants`;
  const list = useLoad(() => api<MerchantBinding[]>(path), [api, path]);
  const storageKey = `tennis:merchant-pending:${scope}`;
  const [pending, setStoredPending] = useDraft<PendingIntent | null>(storageKey, null);
  const [draft, setDraft] = useState<MerchantDraft>(emptyDraft);
  const [busy, setBusy] = useState(false),
    [checked, setChecked] = useState(false);
  const [error, setError] = useState<unknown>(),
    [notice, setNotice] = useState("");
  const running = useRef(false);
  function setPending(value: PendingIntent | null) {
    // The saved intent contains identifiers/references only, never secret material.
    writeStored(storageKey, value);
    setStoredPending(value);
  }
  function complete(message: string) {
    setPending(null);
    setChecked(false);
    setError(undefined);
    setNotice(message);
    setDraft((value) => ({ ...emptyDraft, provider: value.provider }));
  }
  function inspect(rows: MerchantBinding[], intent: PendingIntent): boolean {
    if (intent.kind === "disable") {
      const found = rows.find((row) => row.id === intent.bindingId && row.version === intent.expectedVersion);
      if (found && !found.active) {
        complete(`已核对：${providerName(found.provider)} 第 ${found.version} 版已停用新收款。`);
        return true;
      }
    } else {
      const found = rows.find((row) => matches(row, intent));
      if (found) {
        complete(
          `已核对：${providerName(found.provider)} 第 ${found.version} 版已保存${found.active ? "并启用" : "，当前已停用"}。`,
        );
        return true;
      }
      if (rows.some((row) => row.provider === intent.provider && row.version > intent.expectedVersion)) {
        complete("商户配置已被更新。请查看下方最新配置后重新填写。");
        return true;
      }
    }
    return false;
  }
  async function refresh(intent = pending) {
    const rows = await list.refresh();
    if (rows && intent) {
      if (!inspect(rows, intent)) setChecked(true);
    }
  }
  async function mutate(intent: PendingIntent) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(undefined);
    setNotice("");
    setChecked(false);
    setPending(intent);
    const { kind, ...body } = intent;
    try {
      const result = await api<MerchantBinding>(kind === "save" ? path : `${path}/disable`, "POST", body);
      if (
        result.tenantId !== tenant.id ||
        !result.id ||
        (intent.kind === "save"
          ? !matches(result, intent)
          : result.id !== intent.bindingId || result.version !== intent.expectedVersion || result.active)
      )
        throw new Error("尚未确认保存结果，请先刷新商户列表。");
      complete(
        kind === "save"
          ? `第 ${result.version} 版商户已保存。${result.provider === "WECHAT" ? "微信支付尚未接通。" : "仅用于本地模拟收款。"}`
          : `第 ${result.version} 版已停用新收款。`,
      );
      await list.refresh();
    } catch (next) {
      setError(next);
      if (next instanceof TennisApiError && !next.uncertain && next.code !== "STALE_MERCHANT_BINDING") setPending(null);
      // A fresh list may prove the write committed. If it cannot, any retry retains the original version.
      await refresh(intent);
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || pending || !list.data || list.error) return;
    const merchantId = draft.merchantId.trim(),
      appId = draft.appId.trim(),
      credentialRef = draft.credentialRef.trim();
    if (
      !merchantId ||
      (draft.provider === "WECHAT" && (!appId || !credentialRef)) ||
      [merchantId, appId, credentialRef].some((value) => /[\s\x00-\x1f\x7f]/u.test(value)) ||
      /-----BEGIN|-----END/.test(credentialRef)
    ) {
      setError(
        new Error("请填写完整商户信息。凭据位置只填保存路径或编号，不要粘贴密钥、证书或带空格的内容。"),
      );
      return;
    }
    const expectedVersion = Math.max(
      0,
      ...list.data.filter((row) => row.provider === draft.provider).map((row) => row.version),
    );
    await mutate({
      kind: "save",
      provider: draft.provider,
      merchantId,
      ...(appId ? { appId } : {}),
      ...(credentialRef ? { credentialRef } : {}),
      expectedVersion,
    });
  }
  const locked = busy || pending !== null;
  return (
    <>
      <div className="tennis-toolbar">
        <RefreshButton onClick={() => void refresh()} busy={busy || list.busy} />
      </div>
      <ErrorNotice error={error ?? list.error} retry={() => void refresh()} />
      {notice && (
        <div className="tennis-success" role="status">
          {notice}
        </div>
      )}
      {pending && (
        <div className="tennis-note is-warning" role="status">
          <p>
            {pending.kind === "save"
              ? `保存${providerName(pending.provider)}商户 ${pending.merchantId}（第 ${pending.expectedVersion + 1} 版）`
              : `停用商户第 ${pending.expectedVersion} 版`}
            的结果还未确认，请先刷新列表核对。
          </p>
          <div className="tennis-actions">
            <button
              type="button"
              className="button button-secondary"
              disabled={busy || list.busy}
              onClick={() => void refresh()}
            >
              刷新并核对
            </button>
            <button
              type="button"
              className="button button-secondary"
              disabled={busy || list.busy || !checked}
              onClick={() => void mutate(pending)}
            >
              重试上次操作
            </button>
          </div>
        </div>
      )}
      <form className="tennis-form" onSubmit={(event) => void save(event)}>
        <div className="tennis-two">
          <label>
            收款渠道
            <select
              aria-label="商户收款渠道"
              value={draft.provider}
              disabled={locked}
              onChange={(event) => setDraft({ ...emptyDraft, provider: event.target.value as MerchantProvider })}
            >
              <option value="MOCK">本地模拟</option>
              <option value="WECHAT">微信支付（尚未接通）</option>
            </select>
          </label>
          <label>
            商户号
            <input
              aria-label="收款商户号"
              required
              maxLength={200}
              value={draft.merchantId}
              disabled={locked}
              autoComplete="off"
              placeholder={draft.provider === "MOCK" ? `mock:${tenant.id}` : "商家的微信支付商户号"}
              onChange={(event) => setDraft({ ...draft, merchantId: event.target.value })}
            />
          </label>
          <label>
            App ID{draft.provider === "MOCK" ? "（选填）" : ""}
            <input
              aria-label="商户 App ID"
              required={draft.provider === "WECHAT"}
              maxLength={200}
              value={draft.appId}
              disabled={locked}
              autoComplete="off"
              onChange={(event) => setDraft({ ...draft, appId: event.target.value })}
            />
          </label>
          <label>
            凭据保存位置{draft.provider === "MOCK" ? "（选填）" : ""}
            <input
              aria-label="商户凭据引用"
              required={draft.provider === "WECHAT"}
              maxLength={500}
              value={draft.credentialRef}
              disabled={locked}
              autoComplete="off"
              placeholder="例如 secrets/tennis/merchant/v1"
              onChange={(event) => setDraft({ ...draft, credentialRef: event.target.value })}
            />
          </label>
        </div>
        <p className="tennis-muted">只填凭据保存路径，不要粘贴密钥或证书。</p>
        <p className="tennis-muted">{draft.provider === "WECHAT" ? "保存后仅保留微信支付配置，暂不能收款。" : "保存后，新的模拟收款使用这份配置。"}</p>
        <div className="tennis-actions">
          <button
            type="submit"
            className="button button-primary"
            disabled={locked || list.busy || !list.data || !!list.error}
          >
            <Save size={16} />
            {busy ? "处理中…" : "保存商户配置"}
          </button>
          <InfoHint label="商户配置保存说明">旧配置会保留，已有交易仍使用原商户信息核对和退款。</InfoHint>
        </div>
      </form>
      {!list.data && list.busy ? (
        <LoadingBlock />
      ) : !list.data?.length ? (
        <EmptyState title="尚无商户配置" detail="填写商户信息后保存即可。" />
      ) : (
        <div className="tennis-table-scroll">
          <table className="tennis-table">
            <thead>
              <tr>
                <th>渠道 / 版本</th>
                <th>商户号</th>
                <th>App ID / 凭据位置</th>
                <th>状态</th>
                <th>保存时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((binding) => (
                <tr key={binding.id}>
                  <td>
                    <strong>{providerName(binding.provider)}</strong>
                    <br />第 {binding.version} 版
                  </td>
                  <td style={{ overflowWrap: "anywhere" }}>{binding.merchantId}</td>
                  <td style={{ overflowWrap: "anywhere" }}>
                    {binding.appId ?? "未设置 App ID"}
                    <br />
                    <small>{binding.credentialRef ?? "未设置凭据位置"}</small>
                  </td>
                  <td>
                    <span
                      className={`status-badge ${binding.active ? "tennis-status-confirmed" : "tennis-status-cancelled"}`}
                    >
                      {binding.active
                        ? binding.provider === "WECHAT"
                          ? "尚未接通"
                          : "模拟收款启用"
                        : "已停用"}
                    </span>
                  </td>
                  <td>{dateTime(binding.createdAt)}</td>
                  <td>
                    {binding.active ? (
                      <button
                        type="button"
                        className="button button-secondary button-small"
                        disabled={locked || list.busy}
                        onClick={() =>
                          void mutate({ kind: "disable", bindingId: binding.id, expectedVersion: binding.version })
                        }
                      >
                        停用新收款
                      </button>
                    ) : (
                      <span className="tennis-muted">仅查看</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="tennis-muted">停用后不再接受新收款，已有交易仍可核对和退款。</p>
    </>
  );
}
