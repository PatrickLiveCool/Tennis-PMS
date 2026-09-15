import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Copy, KeyRound, RefreshCw, ShieldOff, Trash2 } from "lucide-react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { canManageTokens, commandRecoveryAvailable, principalCan, propertyAllowedActions, useWorkspace } from "../session";
import type { ClientCommandMetadata, CommandCapability, CommandRequest, PendingTokenCommand, RetainedTokenSecret, TokenDto, TokenTargetDto, TrackedCommandState } from "../types";
import { commandCapabilityBusinessLabel, CommandDialog, EmptyState, formatDateTime, InlineError, LoadingBlock, Modal, StatusBadge, tokenAccessCeilingLabel, tokenPermissionScopeLabel, usePersistentCommandRecovery, type CommandDialogProgress } from "../ui";

export const TOKEN_SECRET_BYTES = 32;
export type TokenLifecycleStatus = "ACTIVE" | "EXPIRED" | "REVOKED" | "ROTATED";

export function generateTokenSecret(fillRandomBytes: (bytes: Uint8Array) => Uint8Array = (bytes) => crypto.getRandomValues(bytes)): string {
  const bytes = fillRandomBytes(new Uint8Array(TOKEN_SECRET_BYTES));
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== TOKEN_SECRET_BYTES) {
    throw new RangeError(`Token secret entropy must contain exactly ${TOKEN_SECRET_BYTES} bytes`);
  }
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `qtp_${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
}

export function tokenLifecycleStatus(token: TokenDto, now = new Date()): TokenLifecycleStatus {
  if (token.replaced_by_id) return "ROTATED";
  if (token.revoked_at) return "REVOKED";
  if (new Date(token.expires_at).getTime() <= now.getTime()) return "EXPIRED";
  return "ACTIVE";
}

export function tokenLifecycleStatusLabel(status: TokenLifecycleStatus): string {
  if (status === "ACTIVE") return "有效";
  if (status === "EXPIRED") return "已过期";
  if (status === "REVOKED") return "已撤销";
  return "已轮换";
}

export function tokenRotationRelationshipLabel(token: Pick<TokenDto, "rotated_from_id" | "replaced_by_id">): string {
  if (token.rotated_from_id && token.replaced_by_id) return "由旧 Token 轮换生成，现已由新 Token 替换";
  if (token.replaced_by_id) return "已由新 Token 替换";
  if (token.rotated_from_id) return "由旧 Token 轮换生成";
  return "初始签发";
}

export function tokenCommandCeilingOptions(
  targetCommandGrants: readonly CommandCapability[],
  callerAllowedActions: ReadonlySet<CommandCapability>,
  currentCommandCeiling?: readonly CommandCapability[]
): CommandCapability[] {
  const current = currentCommandCeiling ? new Set(currentCommandCeiling) : undefined;
  return targetCommandGrants.filter((commandType, index) => targetCommandGrants.indexOf(commandType) === index
    && callerAllowedActions.has(commandType)
    && (!current || current.has(commandType)));
}

export function tokenCommandCeilingForSubmit(
  accessCeiling: "READ" | "WRITE",
  selectedCommands: readonly CommandCapability[]
): CommandCapability[] {
  if (accessCeiling === "READ") return [];
  return [...new Set(selectedCommands)];
}

export function tokenHistoricalReadCeilingHint(token: Pick<TokenDto, "historicalReadCeilingPreserved">): string | null {
  return token.historicalReadCeilingPreserved ? "系统保留历史结果查询与恢复范围" : null;
}

type NewRetainedTokenSecret = Pick<RetainedTokenSecret, "propertyId" | "operation" | "label" | "value">;

export function updateMatchingRetainedSecret(
  current: RetainedTokenSecret | undefined,
  operationId: string,
  patch: Partial<Omit<RetainedTokenSecret, "operationId">>
): RetainedTokenSecret | undefined {
  return current?.operationId === operationId ? { ...current, ...patch } : current;
}

export function updateMatchingRetainedSecretForAttempt(
  current: RetainedTokenSecret | undefined,
  operationId: string,
  activeAttemptId: string | undefined,
  progressAttemptId: string,
  patch: Partial<Omit<RetainedTokenSecret, "operationId">>
): RetainedTokenSecret | undefined {
  if (activeAttemptId !== progressAttemptId) return current;
  return updateMatchingRetainedSecret(current, operationId, patch);
}

export function retainedTokenCommandUnresolved(secret: RetainedTokenSecret): boolean {
  return trackedCommandUnresolved(secret.state);
}

function trackedCommandUnresolved(state: TrackedCommandState): boolean {
  return state === "PREVIEWING" || state === "PREVIEW_UNKNOWN" || state === "PREVIEWED" || state === "CONFIRMING" || state === "UNKNOWN";
}

interface TrackedCommandPatch {
  state: TrackedCommandState;
  previewMetadata?: ClientCommandMetadata;
  previewId?: string;
  confirmationKey?: string;
}

interface TokenCommandDialogState {
  request: CommandRequest;
  operationId: string;
  attemptId: string;
  initialPreviewMetadata?: ClientCommandMetadata;
  initialConfirmationKey?: string;
}

function trackedPatch(progress: CommandDialogProgress): TrackedCommandPatch {
  if (progress.state === "PREVIEWING") return { state: "PREVIEWING", previewMetadata: progress.previewMetadata };
  if (progress.state === "PREVIEW_UNKNOWN") return { state: "PREVIEW_UNKNOWN", previewMetadata: progress.previewMetadata };
  if (progress.state === "PREVIEW_FAILED") return { state: "NOT_EXECUTED", previewMetadata: progress.previewMetadata };
  if (progress.state === "PREVIEWED") {
    return { state: "PREVIEWED", previewMetadata: progress.previewMetadata, previewId: progress.previewId };
  }
  if (progress.state === "CONFIRMING") {
    return { state: "CONFIRMING", previewId: progress.previewId, confirmationKey: progress.confirmationKey };
  }
  if (progress.state === "FAILED_NOT_EXECUTED") return { state: "NOT_EXECUTED", confirmationKey: progress.confirmationKey };
  if (progress.state === "UNKNOWN") return { state: "UNKNOWN", confirmationKey: progress.confirmationKey };
  return {
    state: progress.receipt.businessCommitted ? "EXECUTED" : "NOT_EXECUTED",
    confirmationKey: progress.confirmationKey
  };
}

export async function coordinateTokenPreviewProgress(
  request: CommandRequest,
  progress: CommandDialogProgress,
  coordinate: (request: CommandRequest, progress: CommandDialogProgress) => boolean | Promise<boolean>
): Promise<boolean> {
  if (progress.state !== "PREVIEWING") return true;
  return coordinate(request, progress);
}

function toLocalDateTimeInput(value: Date | string): string {
  const date = typeof value === "string" ? new Date(value) : value;
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function defaultExpiration(): string {
  return toLocalDateTimeInput(new Date(Date.now() + 90 * 24 * 60 * 60 * 1000));
}

function SecretValue({ value }: { value: string }) {
  const [copyStatus, setCopyStatus] = useState("");

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopyStatus("已复制");
    } catch {
      setCopyStatus("复制失败，请手动保存");
    }
  }

  return (
    <div className="token-secret-value">
      <label>一次性 Token secret
        <input value={value} readOnly spellCheck={false} autoComplete="off" />
      </label>
      <button className="button button-secondary" type="button" onClick={() => void copy()}><Copy aria-hidden="true" size={16} />复制</button>
      <span className="sr-status" aria-live="polite">{copyStatus}</span>
    </div>
  );
}

function tokenOperationLabel(operation: "ISSUE" | "ROTATE"): string {
  return operation === "ISSUE" ? "签发 Token" : "轮换 Token";
}

function tokenCommandStateText(state: TrackedCommandState): string {
  if (state === "LOCAL_ONLY") return "待提交";
  if (state === "PREVIEWING") return "正在核对";
  if (state === "PREVIEW_UNKNOWN") return "核对中断，请继续处理";
  if (state === "PREVIEWED") return "待确认";
  if (state === "CONFIRMING") return "正在提交";
  if (state === "UNKNOWN") return "提交结果待查询";
  if (state === "EXECUTED") return "已完成";
  return "未写入";
}

function tokenRequestLabel(request: CommandRequest): string {
  if (request.commandType === "ISSUE_TOKEN") return "签发 Token";
  if (request.commandType === "ROTATE_TOKEN") return "轮换 Token";
  if (request.commandType === "REVOKE_TOKEN") return "撤销 Token";
  return request.title;
}

function TokenSecretDialog({ operation, token, accessGrant, targets, callerAllowedActions, onClose, onSubmit }: {
  operation: "ISSUE" | "ROTATE";
  token?: TokenDto;
  accessGrant: "READ" | "WRITE";
  targets: readonly TokenTargetDto[];
  callerAllowedActions: ReadonlySet<CommandCapability>;
  onClose: () => void;
  onSubmit: (request: CommandRequest, retained: NewRetainedTokenSecret) => void;
}) {
  const { principal, propertyId } = useWorkspace();
  const [label, setLabel] = useState(token?.label ?? "External agent");
  const [subjectId, setSubjectId] = useState(() => token?.subjectId ?? targets.find((target) => target.subjectId === principal.subjectId)?.subjectId ?? targets[0]?.subjectId ?? "");
  const [accessCeiling, setAccessCeiling] = useState<"READ" | "WRITE">(token?.access_ceiling ?? "READ");
  const [expiresAt, setExpiresAt] = useState(() => token ? toLocalDateTimeInput(token.expires_at) : defaultExpiration());
  const [secret] = useState(() => generateTokenSecret());
  const [selectedCommandCeiling, setSelectedCommandCeiling] = useState<CommandCapability[]>(() => token?.commandCeiling ?? []);
  const [saved, setSaved] = useState(false);
  const [validationError, setValidationError] = useState<unknown>();
  const isIssue = operation === "ISSUE";
  const selectedTarget = targets.find((target) => target.subjectId === subjectId);
  const canGrantWriteAccess = accessGrant === "WRITE" && selectedTarget?.accessLevel === "WRITE";
  const commandOptions = tokenCommandCeilingOptions(
    token ? token.commandCeiling : selectedTarget?.commandGrants ?? [],
    callerAllowedActions,
    token?.commandCeiling
  );
  const commandOptionKey = commandOptions.join("|");

  useEffect(() => {
    if (accessCeiling === "WRITE" && !canGrantWriteAccess) setAccessCeiling("READ");
  }, [accessCeiling, canGrantWriteAccess]);

  useEffect(() => {
    const allowed = new Set(commandOptions);
    setSelectedCommandCeiling((current) => {
      const filtered = current.filter((commandType) => allowed.has(commandType));
      return isIssue || current.length > 0 ? filtered : commandOptions;
    });
  }, [commandOptionKey, isIssue]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setValidationError(undefined);
    if (!saved) {
      setValidationError(new Error("请先确认已安全保存一次性 secret"));
      return;
    }
    if (isIssue && !label.trim()) {
      setValidationError(new Error("请填写 Token 标签"));
      return;
    }
    if (!isIssue && !token) {
      setValidationError(new Error("轮换目标 Token 不存在"));
      return;
    }
    if (isIssue && !selectedTarget) {
      setValidationError(new Error("请选择要签发 Token 的目标主体"));
      return;
    }
    const expiration = new Date(expiresAt);
    if (Number.isNaN(expiration.getTime()) || expiration.getTime() <= Date.now()) {
      setValidationError(new Error("Token 过期时间必须晚于当前时间"));
      return;
    }
    const request: CommandRequest = isIssue ? {
      commandType: "ISSUE_TOKEN",
      title: "签发 Token",
      description: "确认后，这个 Token 可以用于外围客户端访问本物业数据。",
      input: {
        propertyId,
        subjectId,
        label: label.trim(),
        accessCeiling,
        commandCeiling: tokenCommandCeilingForSubmit(accessCeiling, selectedCommandCeiling),
        expiresAt: expiration.toISOString(),
        tokenSecret: secret
      }
    } : {
      commandType: "ROTATE_TOKEN",
      title: "轮换 Token",
      description: "确认后，旧 Token 立即失效，新 Token 生效。",
      input: {
        propertyId,
        tokenId: token!.id,
        commandCeiling: tokenCommandCeilingForSubmit(token!.access_ceiling, selectedCommandCeiling),
        expiresAt: expiration.toISOString(),
        tokenSecret: secret
      }
    };
    onSubmit(request, {
      propertyId,
      operation,
      label: isIssue ? label.trim() : token!.label,
      value: secret
    });
  }

  return (
    <Modal title={isIssue ? "签发 Token" : "轮换 Token"} onClose={onClose} footer={null}>
      <form className="modal-form" onSubmit={submit}>
        <InlineError error={validationError} title="无法继续" />
        <div className="form-grid">
          {isIssue ? <label htmlFor="token-subject">目标主体
            <select id="token-subject" value={subjectId} onChange={(event) => setSubjectId(event.target.value)} required>
              {targets.map((target) => <option key={target.subjectId} value={target.subjectId}>{target.displayName} · {tokenAccessCeilingLabel(target.accessLevel)}</option>)}
            </select>
          </label> : (
            <dl className="token-operation-context"><div><dt>目标主体</dt><dd>{token?.displayName}</dd></div></dl>
          )}
          {isIssue ? <label htmlFor="token-label">标签<input id="token-label" value={label} onChange={(event) => setLabel(event.target.value)} required maxLength={200} /></label> : (
            <dl className="token-operation-context"><div><dt>Token 标签</dt><dd>{token?.label}</dd></div><div><dt>当前权限</dt><dd>{tokenPermissionScopeLabel(token?.access_ceiling, token?.commandCeiling)}</dd></div></dl>
          )}
          {isIssue ? <label htmlFor="token-access-ceiling">权限上限
            <select id="token-access-ceiling" value={accessCeiling} onChange={(event) => setAccessCeiling(event.target.value as "READ" | "WRITE")}>
              <option value="READ">只读</option>
              {canGrantWriteAccess ? <option value="WRITE">可写</option> : null}
            </select>
          </label> : null}
          {(isIssue ? accessCeiling : token?.access_ceiling) === "WRITE" ? (
            <fieldset className="span-two token-command-ceiling">
              <legend>命令上限</legend>
              {!commandOptions.length ? <p>当前没有可授予的写命令；Token 将不能执行写命令。</p> : commandOptions.map((commandType) => (
                <label key={commandType}>
                  <input
                    type="checkbox"
                    checked={selectedCommandCeiling.includes(commandType)}
                    onChange={(event) => setSelectedCommandCeiling((current) => event.target.checked
                      ? [...current, commandType]
                      : current.filter((candidate) => candidate !== commandType))}
                  />
                  <span>{commandCapabilityBusinessLabel(commandType)}</span>
                </label>
              ))}
            </fieldset>
          ) : null}
          <label htmlFor="token-expires-at">过期时间<input id="token-expires-at" type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} required /></label>
          <SecretValue value={secret} />
          <label className="token-saved-confirmation"><input type="checkbox" checked={saved} onChange={(event) => setSaved(event.target.checked)} required /><span>我已将一次性 secret 安全保存；关闭后服务端无法找回。</span></label>
        </div>
        <div className="form-actions"><button type="button" className="button button-secondary" onClick={onClose}>取消</button><button type="submit" className="button button-primary" disabled={!saved}>下一步</button></div>
      </form>
    </Modal>
  );
}

function RetainedSecretPanel({ secret, onClear, onRecover }: {
  secret: RetainedTokenSecret;
  onClear: () => void;
  onRecover?: () => void;
}) {
  const unresolved = retainedTokenCommandUnresolved(secret);
  const stateText: Record<RetainedTokenSecret["state"], string> = {
    LOCAL_ONLY: "这串 secret 还没有提交。请继续完成操作，或关闭后重新开始。",
    PREVIEWING: "正在核对本次 Token 操作。",
    PREVIEW_UNKNOWN: "核对过程中断，请继续处理；系统不会重复生成 secret。",
    PREVIEWED: "已完成核对，等待最终确认。",
    CONFIRMING: "正在提交本次 Token 操作。",
    UNKNOWN: "提交结果暂时不确定，请查询刚才的结果。",
    EXECUTED: "Token 操作已完成。确认外围客户端已保存 secret 后，可以清除本机显示。",
    NOT_EXECUTED: "本次 Token 操作没有写入，可以清除本机显示后重新开始。"
  };
  return (
    <section className="retained-secret-panel" aria-labelledby="retained-secret-heading">
      <div className="retained-secret-heading"><KeyRound aria-hidden="true" size={20} /><div><h2 id="retained-secret-heading">一次性密钥待清除</h2><p>{stateText[secret.state]}</p></div></div>
      <dl className="retained-secret-meta"><div><dt>操作</dt><dd>{tokenOperationLabel(secret.operation)}</dd></div><div><dt>处理状态</dt><dd>{tokenCommandStateText(secret.state)}</dd></div><div><dt>Token 标签</dt><dd>{secret.label}</dd></div></dl>
      <SecretValue value={secret.value} />
      <div className="retained-secret-actions">
        {unresolved && onRecover && (secret.confirmationKey || secret.previewMetadata) ? <button className="button button-secondary" type="button" onClick={onRecover}><RefreshCw aria-hidden="true" size={16} />继续处理</button> : null}
        <button className="button button-danger" type="button" onClick={onClear} disabled={unresolved}><Trash2 aria-hidden="true" size={16} />已保存，清除本机显示</button>
      </div>
    </section>
  );
}

function PendingTokenCommandPanel({ pending, onRecover, onClear }: {
  pending: PendingTokenCommand;
  onRecover?: () => void;
  onClear: () => void;
}) {
  const unresolved = trackedCommandUnresolved(pending.state);
  return (
    <section className="retained-secret-panel" aria-labelledby="pending-token-command-heading">
      <div className="retained-secret-heading"><ShieldOff aria-hidden="true" size={20} /><div><h2 id="pending-token-command-heading">Token 操作待完成</h2><p>有一项 Token 操作还需要继续处理。系统会查询原操作结果，不会重复提交。</p></div></div>
      <dl className="retained-secret-meta"><div><dt>操作</dt><dd>{tokenRequestLabel(pending.request)}</dd></div><div><dt>处理状态</dt><dd>{tokenCommandStateText(pending.state)}</dd></div></dl>
      <div className="retained-secret-actions">
        {unresolved && onRecover && (pending.confirmationKey || pending.previewMetadata) ? <button className="button button-secondary" type="button" onClick={onRecover}><RefreshCw aria-hidden="true" size={16} />继续处理</button> : null}
        <button className="button button-secondary" type="button" onClick={onClear} disabled={unresolved}>清除记录</button>
      </div>
    </section>
  );
}

export function TokensPage() {
  const {
    principal,
    propertyId,
    retainedTokenSecret,
    setRetainedTokenSecret,
    pendingTokenCommand,
    setPendingTokenCommand
  } = useWorkspace();
  const [tokens, setTokens] = useState<TokenDto[]>([]);
  const [targets, setTargets] = useState<TokenTargetDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();
  const [refreshToken, setRefreshToken] = useState(0);
  const [secretAction, setSecretAction] = useState<{ operation: "ISSUE" | "ROTATE"; token?: TokenDto }>();
  const [command, setCommand] = useState<TokenCommandDialogState>();
  const activeCommandAttemptRef = useRef<string | undefined>(undefined);
  const accessGrant = principal.propertyAccess[propertyId] ?? "READ";
  const callerAllowedActions = propertyAllowedActions(principal, propertyId);
  const canManage = canManageTokens(principal, propertyId);
  const canIssue = principalCan(principal, propertyId, "ISSUE_TOKEN");
  const canRotate = principalCan(principal, propertyId, "ROTATE_TOKEN");
  const canRevoke = principalCan(principal, propertyId, "REVOKE_TOKEN");
  const retainedRecoverable = commandRecoveryAvailable(principal, propertyId, retainedTokenSecret?.command.commandType);
  const pendingRecoverable = commandRecoveryAvailable(principal, propertyId, pendingTokenCommand?.request.commandType);
  const commandRecovery = usePersistentCommandRecovery({
    subjectId: principal.subjectId,
    scopeId: `property:${propertyId}`
  });

  useEffect(() => {
    let current = true;
    if (!canManage) {
      setLoading(false);
      setError(undefined);
      setTokens([]);
      setTargets([]);
      return () => { current = false; };
    }
    setLoading(true);
    setError(undefined);
    setTokens([]);
    setTargets([]);
    Promise.all([
      api.tokens(propertyId),
      canIssue ? api.tokenTargets(propertyId) : Promise.resolve({ subjects: [] })
    ])
      .then(([tokensResponse, targetsResponse]) => {
        if (!current) return;
        setTokens(tokensResponse.tokens);
        setTargets(targetsResponse.subjects);
      })
      .catch((nextError) => current && setError(nextError))
      .finally(() => current && setLoading(false));
    return () => { current = false; };
  }, [canIssue, canManage, propertyId, refreshToken]);

  useEffect(() => () => {
    activeCommandAttemptRef.current = undefined;
  }, []);

  const counts = useMemo(() => tokens.reduce<Record<TokenLifecycleStatus, number>>((result, token) => {
    result[tokenLifecycleStatus(token)] += 1;
    return result;
  }, { ACTIVE: 0, EXPIRED: 0, REVOKED: 0, ROTATED: 0 }), [tokens]);

  function openCommand(nextCommand: Omit<TokenCommandDialogState, "attemptId">) {
    const attemptId = crypto.randomUUID();
    activeCommandAttemptRef.current = attemptId;
    setCommand({ ...nextCommand, attemptId });
  }

  function closeCommand(attemptId: string) {
    if (activeCommandAttemptRef.current !== attemptId) return;
    activeCommandAttemptRef.current = undefined;
    setCommand(undefined);
  }

  function submitSecretCommand(request: CommandRequest, retained: NewRetainedTokenSecret) {
    if (!principalCan(principal, propertyId, request.commandType as CommandCapability)) return;
    const operationId = crypto.randomUUID();
    setRetainedTokenSecret({ ...retained, operationId, command: request, state: "LOCAL_ONLY" });
    setSecretAction(undefined);
    openCommand({ request, operationId });
  }

  function applySecretProgress(operationId: string, attemptId: string, progress: CommandDialogProgress) {
    if (activeCommandAttemptRef.current !== attemptId) return;
    const patch = trackedPatch(progress);
    setRetainedTokenSecret((current) => updateMatchingRetainedSecretForAttempt(
      current,
      operationId,
      activeCommandAttemptRef.current,
      attemptId,
      patch
    ));
    setPendingTokenCommand((current) => (
      activeCommandAttemptRef.current === attemptId && current?.operationId === operationId ? { ...current, ...patch } : current
    ));
    if (progress.state === "RESOLVED" && progress.receipt.businessCommitted) {
      setRefreshToken((value) => value + 1);
    }
  }

  async function trackTokenProgress(
    activeCommand: TokenCommandDialogState,
    progress: CommandDialogProgress
  ): Promise<boolean> {
    applySecretProgress(activeCommand.operationId, activeCommand.attemptId, progress);
    return coordinateTokenPreviewProgress(activeCommand.request, progress, commandRecovery.track);
  }

  function recoverRetainedSecret() {
    if (!retainedRecoverable || !retainedTokenSecret || (!retainedTokenSecret.confirmationKey && !retainedTokenSecret.previewMetadata)) return;
    openCommand({
      request: retainedTokenSecret.command,
      operationId: retainedTokenSecret.operationId,
      ...(retainedTokenSecret.previewMetadata ? { initialPreviewMetadata: retainedTokenSecret.previewMetadata } : {}),
      ...(retainedTokenSecret.confirmationKey ? { initialConfirmationKey: retainedTokenSecret.confirmationKey } : {})
    });
  }

  function recoverPendingTokenCommand() {
    if (!pendingRecoverable || !pendingTokenCommand || (!pendingTokenCommand.confirmationKey && !pendingTokenCommand.previewMetadata)) return;
    openCommand({
      request: pendingTokenCommand.request,
      operationId: pendingTokenCommand.operationId,
      ...(pendingTokenCommand.previewMetadata ? { initialPreviewMetadata: pendingTokenCommand.previewMetadata } : {}),
      ...(pendingTokenCommand.confirmationKey ? { initialConfirmationKey: pendingTokenCommand.confirmationKey } : {})
    });
  }

  function revoke(token: TokenDto) {
    if (!canRevoke) return;
    const operationId = crypto.randomUUID();
    const request: CommandRequest = {
      commandType: "REVOKE_TOKEN",
      title: "撤销 Token",
      description: "确认后，这个 Token 立即失效，外围客户端不能再用它访问系统。",
      input: { propertyId, tokenId: token.id }
    };
    setPendingTokenCommand({ operationId, request, state: "LOCAL_ONLY" });
    openCommand({ request, operationId });
  }

  return (
    <div className="tokens-page">
      <header className="page-heading page-heading-actions">
        <div><p className="eyebrow">外部系统接入</p><h1>智能体与外部访问</h1><p>管理外部系统的访问密钥（Token）、可用权限与有效期</p></div>
        <div className="token-page-actions"><button className="button button-secondary" type="button" onClick={() => setRefreshToken((value) => value + 1)} disabled={loading || !canManage}><RefreshCw className={loading ? "spin" : ""} aria-hidden="true" size={17} />刷新</button><button className="button button-primary" type="button" onClick={() => setSecretAction({ operation: "ISSUE" })} disabled={!canIssue || loading || Boolean(error) || commandRecovery.blocked || Boolean(retainedTokenSecret) || Boolean(pendingTokenCommand) || targets.length === 0}><KeyRound aria-hidden="true" size={17} />签发 Token</button></div>
      </header>

      <InlineError error={commandRecovery.error} title="本物业有操作需要先处理" />
      {commandRecovery.blocked ? <section className="recovery-bar" role="status" aria-live="polite" data-testid="token-property-recovery-blocked">
        <div><strong>请先处理本物业未完成的操作</strong><p>Token 操作尚未发送。处理完原操作或报价后，再返回这里继续。</p></div>
        <Link className="button button-secondary" to="/">前往房态处理</Link>
      </section> : null}
      {retainedTokenSecret && !command ? <RetainedSecretPanel secret={retainedTokenSecret} onClear={() => setRetainedTokenSecret(undefined)} {...(retainedRecoverable ? { onRecover: recoverRetainedSecret } : {})} /> : null}
      {pendingTokenCommand && !command ? <PendingTokenCommandPanel pending={pendingTokenCommand} {...(pendingRecoverable ? { onRecover: recoverPendingTokenCommand } : {})} onClear={() => setPendingTokenCommand(undefined)} /> : null}
      {!canManage ? <div className="token-readonly-notice"><ShieldOff aria-hidden="true" size={18} /><p>当前主体没有本物业 Token 管理命令授权；普通员工可继续处理一线业务，Token 由管理员维护。</p></div> : null}

      <section className="token-principal-band" aria-label="Token 主体与状态汇总">
        <div><span>当前工作人员</span><strong>{principal.displayName}</strong></div>
        <div><span>物业授权</span><StatusBadge value={tokenAccessCeilingLabel(accessGrant)} /></div>
        <div><span>命令授权</span><strong>{canManage ? "可管理 Token" : "无 Token 管理"}</strong></div>
        <div className="token-counts"><span>有效 {counts.ACTIVE}</span><span>已过期 {counts.EXPIRED}</span><span>已撤销 {counts.REVOKED}</span><span>已轮换 {counts.ROTATED}</span></div>
      </section>

      <InlineError error={error} title="无法载入 Token" />
      {loading ? <LoadingBlock label="正在载入 Token" /> : error ? null : tokens.length ? (
        <div className="table-region token-table-region" role="region" aria-label="本物业主体 Token" tabIndex={0}>
          <table className="data-table token-table">
            <thead><tr><th scope="col">Token 标签</th><th scope="col">目标主体</th><th scope="col">权限上限</th><th scope="col">可执行命令</th><th scope="col">状态</th><th scope="col">过期时间</th><th scope="col">轮换状态</th><th scope="col" className="token-actions-heading">操作</th></tr></thead>
            <tbody>{tokens.map((token) => {
              const status = tokenLifecycleStatus(token);
              const revoked = status === "REVOKED" || status === "ROTATED";
              const historicalReadCeilingHint = tokenHistoricalReadCeilingHint(token);
              return <tr key={token.id}>
                <th scope="row"><strong>{token.label}</strong><small>签发于 {formatDateTime(token.created_at)}</small></th>
                <td><strong>{token.displayName}</strong></td>
                <td><StatusBadge value={tokenAccessCeilingLabel(token.access_ceiling)} /></td>
                <td>{token.commandCeiling.length ? <details className="token-permissions"><summary>查看 {token.commandCeiling.length} 项操作权限</summary><small>{token.commandCeiling.map(commandCapabilityBusinessLabel).join(" / ")}</small></details> : <small>无写入能力</small>}{historicalReadCeilingHint ? <small>{historicalReadCeilingHint}</small> : null}</td>
                <td><StatusBadge value={tokenLifecycleStatusLabel(status)} />{token.revoked_at ? <small>{formatDateTime(token.revoked_at)}</small> : null}</td>
                <td>{formatDateTime(token.expires_at)}</td>
                <td className="token-chain"><span>{tokenRotationRelationshipLabel(token)}</span></td>
                <td className="token-actions-cell"><div className="row-actions token-row-actions"><button className="button button-compact button-secondary" type="button" onClick={() => setSecretAction({ operation: "ROTATE", token })} disabled={!canRotate || revoked || commandRecovery.blocked || Boolean(retainedTokenSecret) || Boolean(pendingTokenCommand)}>轮换</button><button className="button button-compact button-secondary danger-text-button" type="button" onClick={() => revoke(token)} disabled={!canRevoke || revoked || commandRecovery.blocked || Boolean(retainedTokenSecret) || Boolean(pendingTokenCommand)} aria-label={`撤销 Token ${token.label}`}>撤销</button></div></td>
              </tr>;
            })}</tbody>
          </table>
        </div>
      ) : canManage ? <EmptyState title="本物业没有 Token" detail="签发第一个受物业、目标主体和命令上限共同收窄的外围客户端 Token。" /> : null}

      {secretAction ? <TokenSecretDialog operation={secretAction.operation} {...(secretAction.token ? { token: secretAction.token } : {})} accessGrant={accessGrant} targets={targets} callerAllowedActions={callerAllowedActions} onClose={() => setSecretAction(undefined)} onSubmit={submitSecretCommand} /> : null}
      {command ? <CommandDialog
        request={command.request}
        onClose={() => closeCommand(command.attemptId)}
        {...(command.initialPreviewMetadata ? { initialPreviewMetadata: command.initialPreviewMetadata } : {})}
        {...(command.initialConfirmationKey ? { initialConfirmationKey: command.initialConfirmationKey } : {})}
        writeBlocked={commandRecovery.blocked}
        writeBlockedReason="本物业还有未完成的操作或报价，请先前往房态处理。"
        onProgress={(progress: CommandDialogProgress) => trackTokenProgress(command, progress)}
      /> : null}
    </div>
  );
}
