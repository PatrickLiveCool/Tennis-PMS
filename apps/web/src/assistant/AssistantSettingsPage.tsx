import { useEffect, useState } from "react";
import { RefreshCw, Save, PlugZap } from "lucide-react";
import { api } from "../api";
import { useWorkspace } from "../session";
import { errorMessage, LoadingBlock } from "../uiBasic";
import { useAssistant } from "./context";
import type { AssistantSettings, AssistantSettingsInput } from "../../../../packages/contracts/src/assistant.ts";

export function AssistantSettingsPage() {
  const { propertyId } = useWorkspace();
  return <ScopedAssistantSettings key={propertyId} propertyId={propertyId} />;
}
function ScopedAssistantSettings({ propertyId }: { propertyId: string }) {
  const assistant = useAssistant();
  const [saved, setSaved] = useState<AssistantSettings>(), [baseUrl, setBaseUrl] = useState(""), [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState(""), [enabled, setEnabled] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>(), [notice, setNotice] = useState("");
  const load = async () => {
    setBusy(true); setError(undefined); setNotice("");
    try { const value = await api.assistantSettings(propertyId); setSaved(value); setBaseUrl(value.baseUrl); setModel(value.model); setEnabled(value.enabled); setApiKey(""); }
    catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  useEffect(() => { void load(); }, [propertyId]);
  const payload = (): AssistantSettingsInput => ({ propertyId, expectedVersion: saved?.version ?? 0, baseUrl: baseUrl.trim(), model: model.trim(), enabled, ...(apiKey ? { apiKey } : {}) });
  const perform = async (test: boolean) => {
    setBusy(true); setError(undefined); setNotice("");
    try {
      if (test) setNotice((await api.assistantTest(payload())).message);
      else { const result = await api.assistantSave(payload()); setSaved(result); setBaseUrl(result.baseUrl); setModel(result.model); setApiKey(""); setNotice("配置已保存，新对话使用最新配置。旧对话需要重新开始。"); assistant?.refreshSettings(); }
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  return <div className="assistant-settings-page"><header className="page-heading"><div><p className="eyebrow">系统管理</p><h1>AI 助手</h1><p>管理模型连接，随时调整服务地址和模型。</p></div><button type="button" className="button button-secondary" onClick={() => void load()} disabled={busy}><RefreshCw size={16} />重新载入</button></header>
    {error ? <div className="assistant-error" role="alert">{error}</div> : null}
    {!saved && busy ? <LoadingBlock label="正在读取模型配置" /> : null}
    {saved && !saved.canManage ? <section className="detail-section"><h2>仅管理员可配置</h2><p>请联系模型配置所属门店的管理员调整连接。你可以使用已启用的 AI 助手。</p></section> : saved ? <form onSubmit={e => { e.preventDefault(); void perform(false); }} className="assistant-settings-form">
      <section className="detail-section"><div className="section-title-row"><h2>模型服务连接</h2><span>{saved.enabled ? "已启用" : "未启用"}</span></div>
        {!saved.keyReady ? <div className="assistant-notice" role="status">服务端尚未配置密钥保护，请部署人员设置 AI_SETTINGS_ENCRYPTION_KEY 后再保存。其他系统功能可以正常使用。</div> : null}
        <fieldset disabled={busy}><label className="assistant-enable"><input type="checkbox" checked={enabled} onChange={e => { setEnabled(e.target.checked); setNotice(""); }} />启用 AI 助手</label>
          <label>接口协议<input value="OpenAI 兼容 · Chat Completions" readOnly /><small>模型需支持工具调用（function tools）。</small></label>
          <label>Base URL<input aria-label="Base URL" type="url" required value={baseUrl} onChange={e => { setBaseUrl(e.target.value); setNotice(""); }} placeholder="https://api.example.com/v1" autoComplete="off" /><small>填写 HTTPS API 根地址，通常以 /v1 结尾。</small></label>
          <label>API Key<input aria-label="API Key" type="password" value={apiKey} onChange={e => { setApiKey(e.target.value); setNotice(""); }} placeholder={saved.hasKey ? "已保存密钥；留空保留原密钥" : "填写服务商提供的 API Key 或访问 Token"} autoComplete="new-password" maxLength={4096} /><small>{baseUrl.trim().replace(/\/+$/, "") !== saved.baseUrl && saved.hasKey ? "服务地址已改变，需要填写新服务对应的 Key。" : "密钥加密保存在服务端，保存后不显示原文。"}</small></label>
          <label>模型名称<input aria-label="模型名称" required value={model} onChange={e => { setModel(e.target.value); setNotice(""); }} placeholder="填写服务商提供的模型标识" maxLength={120} autoComplete="off" /></label>
        </fieldset>
        <div className="assistant-settings-actions"><button type="button" className="button button-secondary" disabled={busy || !saved.keyReady || !baseUrl.trim() || !model.trim()} onClick={() => void perform(true)}><PlugZap size={17} />{busy ? "处理中…" : "测试连接"}</button><button type="submit" className="button button-primary" disabled={busy || (!saved.keyReady && (enabled || Boolean(apiKey)))}><Save size={17} />保存配置</button></div><p className="assistant-setting-hint">测试会发送一条简短模型请求，不发送业务资料；费用按服务商规则计算。测试成功后仍需保存。</p>
      </section>
      {notice ? <div className="assistant-save-notice" role="status">{notice}</div> : null}
      <p className="assistant-setting-hint">配置适用于当前系统。{saved.updatedAt ? `上次保存：${new Date(saved.updatedAt).toLocaleString("zh-CN")}` : "首次保存后建立配置。"}</p>
    </form> : null}
  </div>;
}
