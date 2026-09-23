import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { recordTenantAudit, requireTenantPermission, requireVenuePermission, TenantAccessError } from "./access.ts";
import { isCustomerActor, withBookingTransaction, type BookingActor } from "./customers.ts";
import { AgentAccessError } from "./agent-guard.ts";
import { assistantQuestionError, beginAssistantQuestion, feedbackAssistantQuestion, finishAssistantQuestion, questionToolNames, type QuestionLogger, type QuestionSource } from "./assistant-question-records.ts";

export interface BackofficeAIConfig {
  enabled: boolean;
  model: string;
  baseUrl: string;
  hasApiKey: boolean;
  revision: number;
}
export class BackofficeAssistantError extends Error {
  readonly code = "BACKOFFICE_ASSISTANT_NOT_CONFIGURED";
  constructor() { super("BACKOFFICE_ASSISTANT_NOT_CONFIGURED"); }
}
interface StoredConfig extends BackofficeAIConfig { encryptedKey: string | null }
export interface BackofficeConfigInput {
  enabled: boolean;
  model: string;
  baseUrl: string;
  apiKey?: string;
  expectedRevision: number;
}
export interface BackofficeConversation {
  id: string;
  tenantId: string;
  venueId: string;
  subjectId: string;
  updatedAt: Date;
}
export interface AssistantSelection { courtId: string; startAt: string; endAt: string }
export interface BackofficeContext { page: string; orderId?: string; date?: string; viewDays?: number; selection?: AssistantSelection[] }
export interface AssistantPreparation {
  kind: "booking" | "pay" | "amend" | "cancel" | "refund";
  reason?: string;
  lines?: AssistantSelection[];
  lineId?: string;
}
export interface BackofficeAction {
  page: "schedule" | "orders" | "members" | "settings";
  orderId?: string;
  label: string;
  preparation?: AssistantPreparation;
}
export interface BackofficeMessage {
  id: string;
  role: "USER" | "ASSISTANT";
  content: string;
  actions: BackofficeAction[];
  resolved: boolean | null;
  createdAt: Date;
}
export interface BackofficeRequest {
  id: string;
  messageId: string;
  status: "RUNNING" | "SUCCEEDED" | "FAILED";
  errorCode: string | null;
  createdAt: Date;
  completedAt: Date | null;
}
export interface BackofficeDetail {
  conversation: BackofficeConversation;
  messages: BackofficeMessage[];
  requests: BackofficeRequest[];
}
export interface BackofficeRun {
  config: { model: string; baseUrl: string; apiKey: string };
  history: { role: "user" | "assistant"; content: string }[];
  context: BackofficeContext;
  venue: { id: string; name: string; timezone: string };
  /** Revalidates the employee, conversation, request lease and configuration before each external call/tool. */
  authorize: () => Promise<void>;
  signal: AbortSignal;
  onEvent?: (event: BackofficeStreamEvent) => void;
  onTool?: (name: string) => void;
}
export type BackofficeStreamEvent = { type: "status"; phase: "thinking" | "tool" } | { type: "delta"; text: string };
export type BackofficeExecutor = (run: BackofficeRun) => Promise<{ content: string; actions: BackofficeAction[] }>;
const configColumns = `enabled,model,base_url AS "baseUrl",encrypted_key AS "encryptedKey",(encrypted_key IS NOT NULL) AS "hasApiKey",revision`;
const conversationColumns = `id,tenant_id AS "tenantId",venue_id AS "venueId",subject_id AS "subjectId",updated_at AS "updatedAt"`;
const credentialScope = Buffer.from("tennis:backoffice:model:v1");

export function encryptBackofficeKey(value: string, key: Buffer): string {
  if (key.length !== 32) throw new AgentAccessError("INVALID_AGENT_CONFIG");
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(credentialScope);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}
export function decryptBackofficeKey(value: string, key: Buffer): string {
  try {
    const [version, iv, tag, data, extra] = value.split(".");
    if (key.length !== 32 || version !== "v1" || !iv || !tag || !data || extra !== undefined) throw new Error();
    const cipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    cipher.setAAD(credentialScope);
    cipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([cipher.update(Buffer.from(data, "base64url")), cipher.final()]).toString("utf8");
  } catch { throw new AgentAccessError("INVALID_AGENT_CONFIG"); }
}
export function normalizeBackofficeBaseUrl(value: string): string {
  if (!value.trim()) return "";
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || value.length > 2000 || url.pathname.replace(/\/+$/, "").endsWith("/chat/completions")) throw new Error();
    return url.toString().replace(/\/+$/, "");
  } catch { throw new AgentAccessError("INVALID_AGENT_CONFIG"); }
}
async function platform(tx: pg.PoolClient, subjectId: string) {
  const result = await tx.query("SELECT subject_id FROM tennis.platform_operators WHERE subject_id=$1 AND active FOR SHARE", [subjectId]);
  if (result.rowCount !== 1) throw new TenantAccessError("TENANT_ACCESS_DENIED");
}
async function transaction<T>(db: pg.Pool, work: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const tx = await db.connect();
  try { await tx.query("BEGIN"); const result = await work(tx); await tx.query("COMMIT"); return result; }
  catch (error) { await tx.query("ROLLBACK"); throw error; }
  finally { tx.release(); }
}
async function storedConfig(tx: pg.PoolClient, lock = ""): Promise<StoredConfig> {
  return (await tx.query<StoredConfig>(`SELECT ${configColumns} FROM tennis.backoffice_ai_config WHERE singleton ${lock}`)).rows[0]!;
}
function publicConfig(row: StoredConfig): BackofficeAIConfig {
  const { encryptedKey: _secret, ...config } = row;
  return config;
}
function configured(row: StoredConfig) { return row.enabled && !!row.model && !!row.baseUrl && !!row.encryptedKey; }
export async function getBackofficeAIConfig(db: pg.Pool, subjectId: string) {
  return transaction(db, async (tx) => { await platform(tx, subjectId); return publicConfig(await storedConfig(tx)); });
}
export async function saveBackofficeAIConfig(db: pg.Pool, subjectId: string, key: Buffer, input: BackofficeConfigInput) {
  const baseUrl = normalizeBackofficeBaseUrl(input.baseUrl);
  if (typeof input.enabled !== "boolean" || input.model.length > 200 || (input.apiKey?.length ?? 0) > 4096 || !Number.isSafeInteger(input.expectedRevision)) throw new AgentAccessError("INVALID_AGENT_CONFIG");
  return transaction(db, async (tx) => {
    await platform(tx, subjectId);
    const before = await storedConfig(tx, "FOR UPDATE");
    if (before.revision !== input.expectedRevision) throw new AgentAccessError("STALE_CONFIGURATION");
    // A different origin must not inherit a credential intended for the old provider.
    if (before.hasApiKey && input.apiKey === undefined &&
      (!baseUrl || !before.baseUrl || new URL(baseUrl).origin !== new URL(before.baseUrl).origin))
      throw new AgentAccessError("INVALID_AGENT_CONFIG");
    const encrypted = input.apiKey === undefined ? before.encryptedKey : input.apiKey.trim() ? encryptBackofficeKey(input.apiKey.trim(), key) : null;
    if (input.enabled && (!input.model.trim() || !baseUrl || !encrypted)) throw new AgentAccessError("INVALID_AGENT_CONFIG");
    const row = (await tx.query<StoredConfig>(`UPDATE tennis.backoffice_ai_config SET enabled=$1,model=$2,base_url=$3,encrypted_key=$4,revision=revision+1,updated_by=$5,updated_at=clock_timestamp() WHERE singleton RETURNING ${configColumns}`,
      [input.enabled, input.model.trim(), baseUrl, encrypted, subjectId])).rows[0]!;
    await tx.query("INSERT INTO tennis.auth_audit_events(id,subject_id,action,resource_id,details) VALUES($1,$2,'platform.backoffice_ai_config','platform',$3::jsonb)",
      [randomUUID(), subjectId, JSON.stringify({ revision: row.revision, enabled: row.enabled, secretChanged: input.apiKey !== undefined })]);
    return publicConfig(row);
  });
}
export async function backofficeAssistantStatus(db: pg.Pool, actor: BookingActor) {
  if (isCustomerActor(actor)) throw new TenantAccessError("TENANT_ACCESS_DENIED");
  return withBookingTransaction(db, actor, async (tx) => { const row = await storedConfig(tx); return { enabled: row.enabled, configured: configured(row) }; });
}
export async function testBackofficeAIConfig(db: pg.Pool, subjectId: string, key: Buffer, expectedRevision: number, test: (config: BackofficeRun["config"]) => Promise<void>) {
  const config = await transaction(db, async (tx) => {
    await platform(tx, subjectId);
    const row = await storedConfig(tx);
    if (row.revision !== expectedRevision) throw new AgentAccessError("STALE_CONFIGURATION");
    // Disabled configurations may be tested before enabling them.
    if (!row.model || !row.baseUrl || !row.encryptedKey) throw new BackofficeAssistantError();
    return { model: row.model, baseUrl: row.baseUrl, apiKey: decryptBackofficeKey(row.encryptedKey, key) };
  });
  try { await test(config); } catch { throw new AgentAccessError("ASSISTANT_UNAVAILABLE"); }
  await transaction(db, async (tx) => {
    await platform(tx, subjectId);
    if ((await storedConfig(tx)).revision !== expectedRevision) throw new AgentAccessError("STALE_CONFIGURATION");
    await tx.query("INSERT INTO tennis.auth_audit_events(id,subject_id,action,resource_id,details) VALUES($1,$2,'platform.backoffice_ai_test','platform',$3::jsonb)", [randomUUID(), subjectId, JSON.stringify({ revision: expectedRevision, ok: true })]);
  });
  return { ok: true as const, message: "模型连接成功" };
}
async function staffVenue(tx: pg.PoolClient, actor: BookingActor, venueId: string) {
  if (isCustomerActor(actor)) throw new TenantAccessError("TENANT_ACCESS_DENIED");
  await requireVenuePermission(tx, actor, venueId, "read");
  // Revoking a local account also revokes an in-flight model request.
  if ((await tx.query("SELECT 1 FROM tennis.local_accounts WHERE subject_id=$1 AND NOT active", [actor.subjectId])).rowCount) throw new TenantAccessError("TENANT_ACCESS_DENIED");
}
async function ownedConversation(tx: pg.PoolClient, actor: BookingActor, id: string) {
  if (isCustomerActor(actor)) throw new TenantAccessError("TENANT_ACCESS_DENIED");
  const row = (await tx.query<BackofficeConversation>(`SELECT ${conversationColumns} FROM tennis.backoffice_conversations WHERE tenant_id=$1 AND id=$2 AND subject_id=$3 FOR UPDATE`, [actor.tenantId, id, actor.subjectId])).rows[0];
  if (!row) throw new TenantAccessError("RESOURCE_NOT_FOUND");
  await staffVenue(tx, actor, row.venueId);
  return row;
}
async function expireRequests(tx: pg.PoolClient, actor: BookingActor) {
  await tx.query(`UPDATE tennis.backoffice_requests r SET status='FAILED',error_code='ASSISTANT_UNAVAILABLE',completed_at=clock_timestamp()
    FROM tennis.backoffice_conversations c WHERE c.tenant_id=$1 AND c.subject_id=$2 AND c.id=r.conversation_id AND r.tenant_id=c.tenant_id AND r.status='RUNNING' AND r.deadline_at<=clock_timestamp()`, [actor.tenantId, actor.subjectId]);
}
export async function createBackofficeConversation(db: pg.Pool, actor: BookingActor, venueId: string) {
  return withBookingTransaction(db, actor, async (tx) => {
    await staffVenue(tx, actor, venueId);
    return (await tx.query<BackofficeConversation>(`INSERT INTO tennis.backoffice_conversations(id,tenant_id,venue_id,subject_id) VALUES($1,$2,$3,$4) RETURNING ${conversationColumns}`, [randomUUID(), actor.tenantId, venueId, actor.subjectId])).rows[0]!;
  });
}
export async function listBackofficeConversations(db: pg.Pool, actor: BookingActor, venueId: string) {
  return withBookingTransaction(db, actor, async (tx) => {
    await staffVenue(tx, actor, venueId);
    return (await tx.query<BackofficeConversation>(`SELECT ${conversationColumns} FROM tennis.backoffice_conversations WHERE tenant_id=$1 AND subject_id=$2 AND venue_id=$3 ORDER BY updated_at DESC,id LIMIT 100`, [actor.tenantId, actor.subjectId, venueId])).rows;
  });
}
async function detail(tx: pg.PoolClient, conversation: BackofficeConversation): Promise<BackofficeDetail> {
  const messages = (await tx.query<BackofficeMessage>(`SELECT * FROM (SELECT id,role,content,actions,resolved,created_at AS "createdAt" FROM tennis.backoffice_messages WHERE tenant_id=$1 AND conversation_id=$2 ORDER BY created_at DESC,id DESC LIMIT 100) m ORDER BY "createdAt",id`, [conversation.tenantId, conversation.id])).rows;
  const requests = (await tx.query<BackofficeRequest>(`SELECT id,message_id AS "messageId",status,error_code AS "errorCode",created_at AS "createdAt",completed_at AS "completedAt" FROM tennis.backoffice_requests WHERE tenant_id=$1 AND conversation_id=$2 ORDER BY created_at DESC,id DESC LIMIT 100`, [conversation.tenantId, conversation.id])).rows;
  return { conversation, messages, requests };
}
export async function getBackofficeConversation(db: pg.Pool, actor: BookingActor, id: string) {
  return withBookingTransaction(db, actor, async (tx) => {
    const conversation = await ownedConversation(tx, actor, id);
    await expireRequests(tx, actor);
    return detail(tx, conversation);
  });
}
async function contextInTransaction(tx: pg.PoolClient, actor: BookingActor, venueId: string, context?: BackofficeContext): Promise<BackofficeContext> {
  const value = context ?? { page: "schedule" };
  if (typeof value.page !== "string" || value.page.length > 100 || Object.keys(value).some((name) => !["page", "orderId", "date", "viewDays", "selection"].includes(name))) throw new AgentAccessError("INVALID_AGENT_MESSAGE");
  if (value.orderId !== undefined) {
    if (typeof value.orderId !== "string" || !value.orderId.trim() || value.orderId.length > 200) throw new AgentAccessError("INVALID_AGENT_MESSAGE");
    const found = await tx.query("SELECT 1 FROM tennis.orders WHERE tenant_id=$1 AND venue_id=$2 AND id=$3", [actor.tenantId, venueId, value.orderId]);
    if (found.rowCount !== 1) throw new TenantAccessError("RESOURCE_NOT_FOUND");
  }
  if (value.date !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(value.date) || !Number.isFinite(Date.parse(value.date)) || new Date(value.date).toISOString().slice(0, 10) !== value.date)) throw new AgentAccessError("INVALID_AGENT_MESSAGE");
  if (value.viewDays !== undefined && ![1, 3, 7].includes(value.viewDays)) throw new AgentAccessError("INVALID_AGENT_MESSAGE");
  if (value.selection !== undefined) await validateAssistantSelection(tx, actor, venueId, value.selection);
  return { page: value.page, ...(value.orderId === undefined ? {} : { orderId: value.orderId }),
    ...(value.date === undefined ? {} : { date: value.date }), ...(value.viewDays === undefined ? {} : { viewDays: value.viewDays }),
    ...(value.selection === undefined ? {} : { selection: value.selection }) };
}
export async function validateAssistantSelection(tx: pg.PoolClient, actor: BookingActor, venueId: string, lines: AssistantSelection[]) {
  if (!Array.isArray(lines) || lines.length > 32) throw new AgentAccessError("INVALID_AGENT_MESSAGE");
  for (const line of lines) {
    if (!line || Object.keys(line).some((key) => !["courtId", "startAt", "endAt"].includes(key)) || typeof line.courtId !== "string" ||
      ![line.startAt, line.endAt].every((t) => typeof t === "string" && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(t) && Number.isFinite(Date.parse(t))) ||
      Date.parse(line.startAt) >= Date.parse(line.endAt) || Date.parse(line.endAt) - Date.parse(line.startAt) > 86400000) throw new AgentAccessError("INVALID_AGENT_MESSAGE");
    const found = await tx.query("SELECT 1 FROM tennis.courts WHERE tenant_id=$1 AND venue_id=$2 AND id=$3", [actor.tenantId, venueId, line.courtId]);
    if (found.rowCount !== 1) throw new TenantAccessError("RESOURCE_NOT_FOUND");
  }
}
export async function setBackofficeMessageFeedback(db: pg.Pool, actor: BookingActor, conversationId: string, id: string, resolved: boolean, log?: QuestionLogger) {
  return withBookingTransaction(db, actor, async (tx) => {
    await ownedConversation(tx, actor, conversationId);
    const row = (await tx.query<{ id: string; resolved: boolean; request_id: string }>(`UPDATE tennis.backoffice_messages SET resolved=$1 WHERE tenant_id=$2 AND conversation_id=$3 AND id=$4 AND role='ASSISTANT' RETURNING id,resolved,request_id`, [resolved, actor.tenantId, conversationId, id])).rows[0];
    if (!row) throw new TenantAccessError("RESOURCE_NOT_FOUND");
    await feedbackAssistantQuestion(tx, actor.tenantId, row.request_id, resolved, log);
    return { id: row.id, resolved: row.resolved };
  });
}

export async function sendBackofficeMessage(db: pg.Pool, actor: BookingActor, key: Buffer, conversationId: string,
  input: { messageId: string; content: string; context?: BackofficeContext; source?: QuestionSource }, execute: BackofficeExecutor,
  options: { timeoutMs?: number; signal?: AbortSignal; onEvent?: (event: BackofficeStreamEvent) => void; questionLogger?: QuestionLogger } = {}): Promise<BackofficeDetail> {
  options.signal?.throwIfAborted();
  if (!input.messageId.trim() || input.messageId.length > 200 || !input.content.trim() || input.content.length > 8000) throw new AgentAccessError("INVALID_AGENT_MESSAGE");
  if (input.source !== undefined && !["USER", "SUGGESTION", "UNKNOWN"].includes(input.source)) throw new AgentAccessError("INVALID_AGENT_MESSAGE");
  const startedAt = Date.now();
  const claimed = await withBookingTransaction(db, actor, async (tx) => {
    const conversation = await ownedConversation(tx, actor, conversationId);
    const context = await contextInTransaction(tx, actor, conversation.venueId, input.context);
    const hash = createHash("sha256").update(JSON.stringify({ content: input.content, context })).digest("hex");
    await expireRequests(tx, actor);
    const prior = (await tx.query<{ input_hash: string }>("SELECT input_hash FROM tennis.backoffice_requests WHERE tenant_id=$1 AND conversation_id=$2 AND message_id=$3", [actor.tenantId, conversationId, input.messageId])).rows[0];
    if (prior) {
      if (prior.input_hash !== hash) throw new AgentAccessError("INVALID_AGENT_MESSAGE");
      return { replay: await detail(tx, conversation) };
    }
    const busy = await tx.query(`SELECT 1 FROM tennis.backoffice_requests r JOIN tennis.backoffice_conversations c ON c.id=r.conversation_id AND c.tenant_id=r.tenant_id WHERE c.tenant_id=$1 AND c.subject_id=$2 AND r.status='RUNNING'`, [actor.tenantId, actor.subjectId]);
    if (busy.rowCount) throw new AgentAccessError("ASSISTANT_BUSY");
    const config = await storedConfig(tx);
    if (!configured(config)) throw new BackofficeAssistantError();
    const modelConfig = { model: config.model, baseUrl: config.baseUrl, apiKey: decryptBackofficeKey(config.encryptedKey!, key) };
    const requestId = randomUUID();
    const history = (await tx.query<{ role: "USER" | "ASSISTANT"; content: string }>(`SELECT m.role,m.content FROM tennis.backoffice_messages m JOIN tennis.backoffice_requests r ON r.id=m.request_id AND r.tenant_id=m.tenant_id WHERE m.tenant_id=$1 AND m.conversation_id=$2 AND r.status='SUCCEEDED' ORDER BY m.created_at DESC,m.id DESC LIMIT 20`, [actor.tenantId, conversationId])).rows.reverse().map((message) => ({ role: message.role === "USER" ? "user" as const : "assistant" as const, content: message.content }));
    history.push({ role: "user", content: input.content });
    await tx.query("INSERT INTO tennis.backoffice_requests(id,tenant_id,conversation_id,message_id,input_hash,status,config_revision,context) VALUES($1,$2,$3,$4,$5,'RUNNING',$6,$7::jsonb)", [requestId, actor.tenantId, conversationId, input.messageId, hash, config.revision, JSON.stringify(context)]);
    await tx.query("INSERT INTO tennis.backoffice_messages(id,tenant_id,conversation_id,request_id,role,content) VALUES($1,$2,$3,$4,'USER',$5)", [randomUUID(), actor.tenantId, conversationId, requestId, input.content]);
    await beginAssistantQuestion(tx, { id: requestId, tenantId: actor.tenantId, venueId: conversation.venueId, conversationId,
      content: input.content, page: context.page, ...(input.source === undefined ? {} : { source: input.source }), secrets: [modelConfig.apiKey] }, options.questionLogger);
    await tx.query("UPDATE tennis.backoffice_conversations SET updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2", [actor.tenantId, conversationId]);
    const venue = (await tx.query<{ id: string; name: string; timezone: string }>("SELECT id,name,timezone FROM tennis.venues WHERE tenant_id=$1 AND id=$2", [actor.tenantId, conversation.venueId])).rows[0]!;
    await recordTenantAudit(tx, actor, "backoffice_assistant.request", requestId, { conversationId });
    return { requestId, configRevision: config.revision, config: modelConfig, history, context, venue };
  });
  if (claimed.replay) return claimed.replay;
  const requestId = claimed.requestId!;
  const controller = new AbortController();
  const toolsUsed = new Set<string>();
  let interruption: "ASSISTANT_TIMEOUT" | "REQUEST_INTERRUPTED" | undefined;
  let buffered = "";
  // Retain a suffix so a provider cannot leak a credential split across chunks.
  const onEvent = options.onEvent ? (event: BackofficeStreamEvent) => {
    if (controller.signal.aborted) return;
    if (event.type === "status") { buffered = ""; options.onEvent!(event); return; }
    buffered = (buffered + event.text).split(claimed.config!.apiKey).join("[已隐藏凭证]");
    const safeLength = Math.max(0, buffered.length - claimed.config!.apiKey.length + 1);
    if (safeLength) options.onEvent!({ type: "delta", text: buffered.slice(0, safeLength) });
    buffered = buffered.slice(safeLength);
  } : undefined;
  const timeoutMs = Math.max(1, Math.min(150000, options.timeoutMs ?? 150000));
  const assertActive = async (tx: pg.PoolClient) => {
    await ownedConversation(tx, actor, conversationId);
    const current = await storedConfig(tx, "FOR SHARE");
    if (!configured(current) || current.revision !== claimed.configRevision) throw new BackofficeAssistantError();
    const valid = await tx.query("SELECT 1 FROM tennis.backoffice_requests WHERE tenant_id=$1 AND id=$2 AND status='RUNNING' AND deadline_at>clock_timestamp() FOR UPDATE", [actor.tenantId, requestId]);
    if (valid.rowCount !== 1) throw new AgentAccessError("ASSISTANT_UNAVAILABLE");
  };
  const authorize = async () => {
    if (controller.signal.aborted) throw new AgentAccessError("ASSISTANT_UNAVAILABLE");
    await withBookingTransaction(db, actor, assertActive);
    if (controller.signal.aborted) throw new AgentAccessError("ASSISTANT_UNAVAILABLE");
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  try {
    const result = await Promise.race([
      execute({ config: claimed.config!, history: claimed.history!, context: claimed.context!, venue: claimed.venue!, authorize, signal: controller.signal,
        onTool: (name) => { if (!controller.signal.aborted && questionToolNames.has(name)) toolsUsed.add(name); }, ...(onEvent ? { onEvent } : {}) }),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { interruption = "ASSISTANT_TIMEOUT"; controller.abort(); reject(new AgentAccessError("ASSISTANT_UNAVAILABLE")); }, timeoutMs); }),
      new Promise<never>((_resolve, reject) => {
        cancel = () => { interruption = "REQUEST_INTERRUPTED"; controller.abort(); reject(new AgentAccessError("ASSISTANT_UNAVAILABLE")); };
        if (options.signal?.aborted) cancel(); else options.signal?.addEventListener("abort", cancel, { once: true });
      }),
    ]);
    clearTimeout(timer);
    if (typeof result.content !== "string" || !result.content.trim() || result.content.length > 12000 || !Array.isArray(result.actions) || result.actions.length > 6) throw new AgentAccessError("ASSISTANT_UNAVAILABLE");
    // Credentials are never echoed to an employee even if a compatible model provider does so.
    const content = result.content.split(claimed.config!.apiKey).join("[已隐藏凭证]");
    await withBookingTransaction(db, actor, async (tx) => {
      await assertActive(tx);
      if (controller.signal.aborted) throw new AgentAccessError("ASSISTANT_UNAVAILABLE");
      const actions: BackofficeAction[] = [];
      for (const action of result.actions) {
        if (!action || typeof action !== "object" || Array.isArray(action) || Object.keys(action).some((field) => !["page", "orderId", "label", "preparation"].includes(field)) ||
          !["schedule", "orders", "members", "settings"].includes(action.page) || typeof action.label !== "string" || !action.label.trim() || action.label.length > 100 || action.label.includes(claimed.config!.apiKey) ||
          (action.orderId !== undefined && (typeof action.orderId !== "string" || action.page !== "orders" || action.orderId.includes(claimed.config!.apiKey)))) throw new AgentAccessError("ASSISTANT_UNAVAILABLE");
        await contextInTransaction(tx, actor, claimed.venue!.id, { page: action.page, ...(action.orderId === undefined ? {} : { orderId: action.orderId }) });
        // A model-generated action cannot widen access even if its target page would reject it later.
        if (action.page === "members" || action.page === "settings") {
          await requireTenantPermission(tx, actor, action.page === "members" ? "manage_members" : "manage_assets", action.page === "settings" ? claimed.venue!.id : undefined);
        }
        if (action.preparation) {
          const prep = action.preparation;
          if (Object.keys(prep).some((k) => !["kind", "reason", "lines", "lineId"].includes(k)) || !["booking", "pay", "amend", "cancel", "refund"].includes(prep.kind) ||
            (prep.reason !== undefined && (typeof prep.reason !== "string" || prep.reason.length > 2000)) || JSON.stringify(prep).includes(claimed.config!.apiKey)) throw new AgentAccessError("ASSISTANT_UNAVAILABLE");
          await requireVenuePermission(tx, actor, claimed.venue!.id, prep.kind === "refund" ? "refund" : "book");
          if (prep.kind === "booking" ? action.page !== "schedule" || !!action.orderId : action.page !== "orders" || action.orderId !== claimed.context!.orderId || !action.orderId) throw new AgentAccessError("ASSISTANT_UNAVAILABLE");
          if (prep.lines) await validateAssistantSelection(tx, actor, claimed.venue!.id, prep.lines);
          if (prep.kind === "booking" && !prep.lines?.length) throw new AgentAccessError("ASSISTANT_UNAVAILABLE");
          if (prep.lineId !== undefined) {
            const found = await tx.query("SELECT 1 FROM tennis.order_lines WHERE tenant_id=$1 AND order_id=$2 AND id=$3 AND cancelled_at IS NULL", [actor.tenantId, action.orderId, prep.lineId]);
            if (prep.kind !== "amend" || found.rowCount !== 1) throw new AgentAccessError("ASSISTANT_UNAVAILABLE");
          }
        }
        actions.push({ page: action.page, label: action.label, ...(action.orderId === undefined ? {} : { orderId: action.orderId }), ...(action.preparation ? { preparation: action.preparation } : {}) });
      }
      await tx.query("INSERT INTO tennis.backoffice_messages(id,tenant_id,conversation_id,request_id,role,content,actions) VALUES($1,$2,$3,$4,'ASSISTANT',$5,$6::jsonb)", [randomUUID(), actor.tenantId, conversationId, requestId, content, JSON.stringify(actions)]);
      await tx.query("UPDATE tennis.backoffice_requests SET status='SUCCEEDED',completed_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2", [actor.tenantId, requestId]);
      await finishAssistantQuestion(tx, { id: requestId, tenantId: actor.tenantId, outcome: "ANSWERED", errorCode: null, tools: toolsUsed, startedAt }, options.questionLogger);
      await tx.query("UPDATE tennis.backoffice_conversations SET updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2", [actor.tenantId, conversationId]);
    });
  } catch (error) {
    // An access/config revocation must still terminate the claimed request; no sensitive error text is persisted.
    await db.query("UPDATE tennis.backoffice_requests SET status='FAILED',error_code='ASSISTANT_UNAVAILABLE',completed_at=clock_timestamp() WHERE tenant_id=$1 AND conversation_id=$2 AND id=$3 AND status='RUNNING'", [actor.tenantId, conversationId, requestId]);
    // Authorization may have been revoked. Only close this already-claimed event; no text is returned.
    await transaction(db, (tx) => finishAssistantQuestion(tx, { id: requestId, tenantId: actor.tenantId,
      outcome: interruption === "REQUEST_INTERRUPTED" ? "INTERRUPTED" : "FAILED", errorCode: interruption ?? assistantQuestionError(error), tools: toolsUsed, startedAt }, options.questionLogger));
  } finally {
    clearTimeout(timer);
    if (cancel) options.signal?.removeEventListener("abort", cancel);
    controller.abort();
  }
  return getBackofficeConversation(db, actor, conversationId);
}
