import { useEffect, useRef, useState, type FormEvent } from "react";
import { History, KeyRound, LogOut, Plus, RefreshCw, Trash2, UserCheck, UserRound, UserX, Users } from "lucide-react";
import type { AccountManagementAction, AccountManagementContext, AccountManagementRequest, StaffAccountDto } from "@qintopia/contracts";
import { api, ApiError } from "../api";
import { useWorkspace } from "../session";
import { errorMessage, LoadingBlock, Modal } from "../ui";

export const accountActionLabels: Record<AccountManagementAction, string> = {
  CREATE_STAFF: "创建员工账号", RESET_PASSWORD: "重设密码", CHANGE_PASSWORD: "修改我的密码",
  DISABLE_STAFF: "停用账号", ENABLE_STAFF: "启用账号", REVOKE_SESSIONS: "撤销全部会话",
  DELETE_STAFF: "删除误建账号", DELETE_MEMBER: "删除误建会员"
};

type AccountActionTarget = AccountManagementContext["self"] & Partial<Pick<StaffAccountDto, "status">>;

function AccountActionDialog({ action, target, propertyId, onClose, onDone }: {
  action: AccountManagementAction;
  target?: AccountActionTarget;
  propertyId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [password, setPassword] = useState("");
  const [passwordAgain, setPasswordAgain] = useState("");
  const [reason, setReason] = useState("");
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const pending = useRef<AccountManagementRequest | undefined>(undefined);
  const inFlight = useRef(false);
  const passwordAction = ["CREATE_STAFF", "RESET_PASSWORD", "CHANGE_PASSWORD"].includes(action);
  const resettingDisabledAccount = action === "RESET_PASSWORD" && target?.status === "DISABLED";

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (inFlight.current) return;
    setError(undefined);
    if (!checking) {
      if (passwordAction && password !== passwordAgain) { setError(new Error("两次输入的新密码不一致")); return; }
      setChecking(true);
      return;
    }
    pending.current ??= {
      propertyId, requestId: crypto.randomUUID(), action, confirmation: true,
      reason: action === "CHANGE_PASSWORD" ? "本人修改密码" : reason.trim(),
      ...(action === "CREATE_STAFF" ? { username, displayName: displayName.trim() } : { targetId: target!.id, expectedVersion: target!.version }),
      ...(passwordAction ? { newPassword: password } : {}),
      ...(action === "CHANGE_PASSWORD" ? { currentPassword } : {})
    };
    inFlight.current = true;
    setBusy(true);
    try {
      await api.manageAccount(pending.current);
      setPassword(""); setPasswordAgain(""); setCurrentPassword("");
      pending.current = undefined;
      onDone();
    } catch (nextError) {
      setError(nextError);
      if (nextError instanceof ApiError && nextError.status < 500) pending.current = undefined;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const consequence = action === "DISABLE_STAFF" ? "停用后，该员工的全部登录和 API Token 立即失效。"
    : action === "ENABLE_STAFF" ? "该员工可重新登录；原有会话和已撤销的 API Token 不会恢复。"
    : action === "DELETE_STAFF" ? "仅删除本页新建且从未登录、无 Token 和操作记录的误建账号。删除审计会保留。"
    : action === "REVOKE_SESSIONS" ? "该员工的全部网页登录将失效，需要重新登录。"
    : resettingDisabledAccount ? "密码重设后，账号仍为停用状态；启用账号后才能使用新密码登录。"
    : passwordAction && action !== "CREATE_STAFF" ? "保存后全部网页登录失效，需要使用新密码重新登录。" : "账号角色：普通员工";
  return <Modal title={checking ? `确认${accountActionLabels[action]}` : accountActionLabels[action]} onClose={onClose} closeDisabled={busy} footer={null}>
    <form className="account-form" onSubmit={(event) => void submit(event)}>
      {error ? <div role="alert" className="inline-error">{errorMessage(error)}</div> : null}
      {checking ? <>
        <dl className="account-confirmation"><div><dt>账号</dt><dd>{target?.username ?? username}</dd></div><div><dt>姓名</dt><dd>{target?.displayName ?? displayName}</dd></div>{resettingDisabledAccount ? <div><dt>账号状态</dt><dd>已停用</dd></div> : null}</dl>
        <p>{consequence}</p>
        {action !== "CHANGE_PASSWORD" ? <p>操作原因：{reason}</p> : null}
      </> : <>
        {target ? <p>{target.displayName} · {target.username}</p> : null}
        {resettingDisabledAccount ? <p>{consequence}</p> : null}
        {action === "CREATE_STAFF" ? <><label>账号<input value={username} onChange={(event) => setUsername(event.target.value)} pattern="[a-zA-Z0-9_][a-zA-Z0-9_.\-]{2,63}" minLength={3} maxLength={64} autoComplete="off" required /></label><label>姓名<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={80} required /></label></> : null}
        {action === "CHANGE_PASSWORD" ? <label>当前密码<input type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoComplete="current-password" maxLength={256} required /></label> : null}
        {passwordAction ? <><label>{action === "CREATE_STAFF" ? "初始密码" : "新密码"}<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={12} maxLength={128} placeholder="至少 12 位" autoComplete="new-password" required /></label><label>再次输入密码<input type="password" value={passwordAgain} onChange={(event) => setPasswordAgain(event.target.value)} minLength={12} maxLength={128} autoComplete="new-password" required /></label></> : null}
        {action !== "CHANGE_PASSWORD" ? <label>操作原因<textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} required /></label> : null}
      </>}
      <div className="form-actions">
        <button type="button" className="button button-secondary" disabled={busy} onClick={onClose}>取消</button>
        {checking && !pending.current ? <button type="button" className="button button-secondary" disabled={busy} onClick={() => setChecking(false)}>返回修改</button> : null}
        <button type="submit" className={`button ${action === "DELETE_STAFF" || action === "DISABLE_STAFF" ? "button-danger" : "button-primary"}`} disabled={busy}>
          {busy ? "正在处理..." : pending.current ? "核对并重试" : checking ? "确认执行" : "核对信息"}
        </button>
      </div>
    </form>
  </Modal>;
}

export function AccountsPage() {
  const { propertyId } = useWorkspace();
  const [context, setContext] = useState<AccountManagementContext>();
  const [error, setError] = useState<unknown>();
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);
  const [dialog, setDialog] = useState<{ action: AccountManagementAction; target?: AccountActionTarget }>();
  const [passwordChanged, setPasswordChanged] = useState(false);
  useEffect(() => {
    let active = true;
    setContext(undefined); setError(undefined); setDialog(undefined);
    api.accountManagement(propertyId).then((value) => { if (active) setContext(value); }).catch((value) => { if (active) setError(value); });
    return () => { active = false; };
  }, [propertyId, revision]);

  function open(action: AccountManagementAction, target?: StaffAccountDto | AccountManagementContext["self"]) {
    setDialog({ action, ...(target ? { target } : {}) }); setNotice("");
  }
  return <div className="accounts-page">
    <header className="page-header"><div><h1>账号管理</h1></div><button className="button button-secondary" title="刷新账号" onClick={() => setRevision((value) => value + 1)} disabled={passwordChanged}><RefreshCw size={17} aria-hidden="true" />刷新</button></header>
    {passwordChanged ? <section role="status"><p>密码已修改，请使用新密码重新登录。</p><button className="button button-primary" onClick={() => window.location.assign("/accounts")}>重新登录</button></section> : <>
      {notice ? <p role="status" className="account-notice">{notice}</p> : null}
      {error ? <div role="alert" className="inline-error">{errorMessage(error)}</div> : !context ? <LoadingBlock label="正在读取账号" /> : <>
        <section className="account-self"><div><h2><UserRound aria-hidden="true" size={18} />我的账号</h2><p>{context.self.displayName} · {context.self.username}</p></div><button className="button button-secondary" onClick={() => open("CHANGE_PASSWORD", context.self)}><KeyRound size={17} aria-hidden="true" />修改密码</button></section>
        {context.canManageStaff ? (["ACTIVE", "DISABLED"] as const).map((status) => {
          const accounts = context.accounts.filter((account) => account.status === status);
          const title = status === "ACTIVE" ? "在用员工" : "已停用员工";
          const sectionBody = accounts.length === 0 ? <p className="muted">{status === "ACTIVE" ? "暂无在用员工" : "暂无已停用员工"}</p> : <div className="account-table-scroll"><table className="account-table"><thead><tr><th>员工 / 账号</th><th>状态</th><th>最近登录</th><th>有效会话</th><th>操作</th></tr></thead><tbody>{accounts.map((account) => <tr key={account.id}>
            <td><strong>{account.displayName}</strong><span className="account-username">{account.username}</span></td><td><span className={account.status === "ACTIVE" ? "account-active" : "muted"}>{account.status === "ACTIVE" ? "已启用" : "已停用"}</span></td><td>{account.lastLoginAt ? new Date(account.lastLoginAt).toLocaleString("zh-CN") : "从未登录"}</td><td>{account.activeSessions}</td>
            <td><div className="account-actions"><button className="icon-button" title="重设密码" aria-label={`重设 ${account.username} 的密码`} onClick={() => open("RESET_PASSWORD", account)}><KeyRound size={17} /></button><button className="icon-button" title="撤销全部会话" aria-label={`撤销 ${account.username} 的全部会话`} onClick={() => open("REVOKE_SESSIONS", account)}><LogOut size={17} /></button><button className="icon-button" title={account.status === "ACTIVE" ? "停用账号" : "启用账号"} aria-label={`${account.status === "ACTIVE" ? "停用" : "启用"} ${account.username}`} onClick={() => open(account.status === "ACTIVE" ? "DISABLE_STAFF" : "ENABLE_STAFF", account)}>{account.status === "ACTIVE" ? <UserX size={17} /> : <UserCheck size={17} />}</button><button className="icon-button account-danger" title={account.canDelete ? "删除误建账号" : "仅可删除本页新建且从未使用的误建账号"} aria-label={`删除 ${account.username}`} disabled={!account.canDelete} onClick={() => open("DELETE_STAFF", account)}><Trash2 size={17} /></button></div></td>
          </tr>)}</tbody></table></div>;
          if (status === "DISABLED") {
            return <details className="account-staff account-staff-collapsible" aria-label={title} key={status}>
              <summary><h2><UserX aria-hidden="true" size={18} />{title}</h2><span className="muted">{accounts.length} 个</span></summary>
              {sectionBody}
            </details>;
          }
          return <section className="account-staff" aria-label={title} key={status}><div className="section-title-row"><h2><Users aria-hidden="true" size={18} />{title}</h2><button className="button button-primary" onClick={() => open("CREATE_STAFF")}><Plus size={17} aria-hidden="true" />创建员工</button></div>{sectionBody}</section>;
        }) : null}
        <details className="account-history"><summary><h2><History aria-hidden="true" size={18} />最近操作</h2><span className="muted">{context.history.length} 条</span></summary>{context.history.length ? <ol>{context.history.map((item) => <li key={item.operationId}><div><strong>{accountActionLabels[item.action]}</strong><span>{item.displayName}</span></div><p>{item.reason}</p><small>{item.actorName} · {new Date(item.completedAt).toLocaleString("zh-CN")}</small></li>)}</ol> : <p className="muted">暂无账号操作记录</p>}</details>
      </>}
    </>}
    {dialog ? <AccountActionDialog {...dialog} propertyId={propertyId} onClose={() => setDialog(undefined)} onDone={() => {
      if (dialog.action === "CHANGE_PASSWORD") setPasswordChanged(true);
      else {
        setNotice(dialog.action === "RESET_PASSWORD" && dialog.target?.status === "DISABLED"
          ? "密码已重设，账号仍为停用状态；启用后才能使用新密码登录。"
          : `${accountActionLabels[dialog.action]}已完成`);
        setRevision((value) => value + 1);
      }
      setDialog(undefined);
    }} /> : null}
  </div>;
}
