import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { recordTenantAudit, TenantAccessError } from "./access.ts";
import { isCustomerActor, withBookingTransaction, type BookingActor } from "./customers.ts";
import { requireBookingVenue } from "./booking.ts";
import { bindDelegation, AgentAccessError } from "./agent-guard.ts";

export interface AIConfig {
  enabled: boolean;
  model: string;
  baseUrl: string;
  externalAgentUrl: string;
  hasApiKey: boolean;
  revision: number;
}
interface StoredConfig extends AIConfig {
  encryptedKey: string | null;
}
export interface Conversation {
  id: string;
  tenantId: string;
  venueId: string;
  subjectId: string;
  customerId: string | null;
  actorKind: "staff" | "customer";
  mode: "AGENT" | "HUMAN";
  generation: number;
  takenBy: string | null;
  updatedAt: Date;
}
export interface AssistantContext {
  page: string;
  orderId?: string;
}
export interface LatestOrderContext {
  messageId: string;
  page: string;
  orderId: string;
  createdAt: Date;
}
/** Context is a reference, never an identity or grant of access. Caller owns the conversation transaction. */
export async function validateConversationContext(
  tx: pg.PoolClient,
  actor: BookingActor,
  conv: Conversation,
  input?: AssistantContext,
): Promise<AssistantContext | null> {
  if (input === undefined) return null;
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => key !== "page" && key !== "orderId") ||
    typeof input.page !== "string" ||
    input.page.length > 100 ||
    (input.orderId !== undefined &&
      (typeof input.orderId !== "string" || !input.orderId.trim() || input.orderId.length > 200))
  )
    throw new AgentAccessError("INVALID_AGENT_MESSAGE");
  if (conv.tenantId !== actor.tenantId) throw new TenantAccessError("RESOURCE_NOT_FOUND");
  const context: AssistantContext = {
    page: input.page.trim(),
    ...(input.orderId === undefined ? {} : { orderId: input.orderId.trim() }),
  };
  if (context.orderId) {
    const order = (
      await tx.query<{ customer_id: string; venue_id: string }>(
        "SELECT customer_id,venue_id FROM tennis.orders WHERE tenant_id=$1 AND id=$2",
        [actor.tenantId, context.orderId],
      )
    ).rows[0];
    if (
      !order ||
      order.venue_id !== conv.venueId ||
      (isCustomerActor(actor) && order.customer_id !== actor.customerId) ||
      (conv.actorKind === "customer" && order.customer_id !== conv.customerId)
    )
      throw new TenantAccessError("RESOURCE_NOT_FOUND");
  }
  return context;
}
const conversationColumns = `id,tenant_id AS "tenantId",venue_id AS "venueId",subject_id AS "subjectId",customer_id AS "customerId",actor_kind AS "actorKind",mode,generation,taken_by AS "takenBy",updated_at AS "updatedAt"`;
const configColumns = `enabled,model,base_url AS "baseUrl",external_agent_url AS "externalAgentUrl",encrypted_key AS "encryptedKey",(encrypted_key IS NOT NULL) AS "hasApiKey",revision`;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
async function platform(tx: pg.PoolClient, subjectId: string): Promise<void> {
  if (
    (
      await tx.query("SELECT subject_id FROM tennis.platform_operators WHERE subject_id=$1 AND active FOR SHARE", [
        subjectId,
      ])
    ).rowCount !== 1
  )
    throw new TenantAccessError("TENANT_ACCESS_DENIED");
}
function safeConfig(value: StoredConfig): AIConfig {
  const { encryptedKey: _key, ...config } = value;
  return config;
}
export async function getAIConfig(db: pg.Pool, subjectId: string): Promise<AIConfig> {
  const tx = await db.connect();
  try {
    await tx.query("BEGIN");
    await platform(tx, subjectId);
    const row = (await tx.query<StoredConfig>(`SELECT ${configColumns} FROM tennis.platform_ai_config WHERE singleton`))
      .rows[0]!;
    await tx.query("COMMIT");
    return safeConfig(row);
  } catch (error) {
    await tx.query("ROLLBACK");
    throw error;
  } finally {
    tx.release();
  }
}
function endpoint(value: string): string {
  if (!value) return "";
  try {
    const url = new URL(value);
    if (
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      !["https:", "http:"].includes(url.protocol) ||
      (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
      throw new Error();
    return url.toString();
  } catch {
    throw new AgentAccessError("INVALID_AGENT_CONFIG");
  }
}
function encrypt(value: string, key: Buffer): string {
  if (key.length !== 32) throw new AgentAccessError("INVALID_AGENT_CONFIG");
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((part) => part.toString("base64url")).join(".");
}
function decrypt(value: string, key: Buffer): string {
  const [iv, tag, data] = value.split(".").map((part) => Buffer.from(part, "base64url"));
  const cipher = createDecipheriv("aes-256-gcm", key, iv!);
  cipher.setAuthTag(tag!);
  return Buffer.concat([cipher.update(data!), cipher.final()]).toString("utf8");
}
export async function saveAIConfig(
  db: pg.Pool,
  subjectId: string,
  key: Buffer,
  input: {
    enabled: boolean;
    model: string;
    baseUrl: string;
    externalAgentUrl: string;
    apiKey?: string;
    expectedRevision: number;
  },
): Promise<AIConfig> {
  if (input.model.length > 200 || (input.apiKey?.length ?? 0) > 4096)
    throw new AgentAccessError("INVALID_AGENT_CONFIG");
  const baseUrl = endpoint(input.baseUrl.trim()),
    externalAgentUrl = endpoint(input.externalAgentUrl.trim());
  const tx = await db.connect();
  try {
    await tx.query("BEGIN");
    await platform(tx, subjectId);
    const row = (
      await tx.query<StoredConfig>(`SELECT ${configColumns} FROM tennis.platform_ai_config WHERE singleton FOR UPDATE`)
    ).rows[0]!;
    if (row.revision !== input.expectedRevision) throw new AgentAccessError("STALE_CONFIGURATION");
    const encryptedKey =
      input.apiKey === undefined ? row.encryptedKey : input.apiKey ? encrypt(input.apiKey, key) : null;
    const result = (
      await tx.query<StoredConfig>(
        `UPDATE tennis.platform_ai_config SET enabled=$1,model=$2,base_url=$3,external_agent_url=$4,encrypted_key=$5,revision=revision+1,updated_by=$6,updated_at=clock_timestamp() WHERE singleton RETURNING ${configColumns}`,
        [input.enabled, input.model.trim(), baseUrl, externalAgentUrl, encryptedKey, subjectId],
      )
    ).rows[0]!;
    await tx.query(
      `INSERT INTO tennis.auth_audit_events(id,subject_id,action,resource_id,details) VALUES($1,$2,'platform.ai_config','platform',$3::jsonb)`,
      [
        randomUUID(),
        subjectId,
        JSON.stringify({
          revision: result.revision,
          enabled: result.enabled,
          secretChanged: input.apiKey !== undefined,
        }),
      ],
    );
    await tx.query("COMMIT");
    return safeConfig(result);
  } catch (error) {
    await tx.query("ROLLBACK");
    throw error;
  } finally {
    tx.release();
  }
}
export async function assistantStatus(db: pg.Pool) {
  const row = (
    await db.query<{ enabled: boolean; configured: boolean }>(
      "SELECT enabled,(enabled AND external_agent_url<>'') AS configured FROM tennis.platform_ai_config WHERE singleton",
    )
  ).rows[0]!;
  return row;
}
async function conversation(tx: pg.PoolClient, actor: BookingActor, id: string): Promise<Conversation> {
  const row = (
    await tx.query<Conversation>(
      `SELECT ${conversationColumns} FROM tennis.agent_conversations WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
      [actor.tenantId, id],
    )
  ).rows[0];
  if (!row || (isCustomerActor(actor) && (row.subjectId !== actor.subjectId || row.customerId !== actor.customerId)))
    throw new TenantAccessError("RESOURCE_NOT_FOUND");
  await requireBookingVenue(tx, actor, row.venueId, isCustomerActor(actor) ? "read" : "book");
  return row;
}
export async function createConversation(db: pg.Pool, actor: BookingActor, venueId: string): Promise<Conversation> {
  return withBookingTransaction(db, actor, async (tx) => {
    await requireBookingVenue(tx, actor, venueId, isCustomerActor(actor) ? "read" : "book");
    return (
      await tx.query<Conversation>(
        `INSERT INTO tennis.agent_conversations(id,tenant_id,venue_id,subject_id,customer_id,actor_kind) VALUES($1,$2,$3,$4,$5,$6) RETURNING ${conversationColumns}`,
        [
          randomUUID(),
          actor.tenantId,
          venueId,
          actor.subjectId,
          isCustomerActor(actor) ? actor.customerId : null,
          isCustomerActor(actor) ? "customer" : "staff",
        ],
      )
    ).rows[0]!;
  });
}
export async function listConversations(db: pg.Pool, actor: BookingActor, venueId: string): Promise<Conversation[]> {
  return withBookingTransaction(db, actor, async (tx) => {
    await requireBookingVenue(tx, actor, venueId, isCustomerActor(actor) ? "read" : "book");
    return (
      await tx.query<Conversation>(
        `SELECT ${conversationColumns} FROM tennis.agent_conversations WHERE tenant_id=$1 AND venue_id=$2 AND ($3::boolean=false OR (subject_id=$4 AND customer_id=$5)) ORDER BY updated_at DESC,id LIMIT 100`,
        [
          actor.tenantId,
          venueId,
          isCustomerActor(actor),
          actor.subjectId,
          isCustomerActor(actor) ? actor.customerId : null,
        ],
      )
    ).rows;
  });
}
export interface ConversationSummary extends Conversation {
  displayName: string;
  latestOrderId: string | null;
}
export interface ConversationPage {
  items: ConversationSummary[];
  nextCursor: string | null;
}
export class ConversationQueryError extends Error {
  readonly statusCode = 400;
  constructor(
    readonly code: "INVALID_CONVERSATION_QUERY" | "INVALID_CONVERSATION_CURSOR" = "INVALID_CONVERSATION_QUERY",
  ) {
    super(code);
    this.name = "ConversationQueryError";
  }
}
/** A live inbox uses the original timestamp boundary, never a later reread of the pivot conversation. */
export async function listConversationPage(
  db: pg.Pool,
  actor: BookingActor,
  venueId: string,
  input: unknown = {},
): Promise<ConversationPage> {
  if (typeof venueId !== "string" || !venueId.trim() || venueId.length > 200) throw new ConversationQueryError();
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ConversationQueryError();
  const query = input as Record<string, unknown>;
  if (
    Object.keys(query).some((k) => !["mode", "q", "cursor", "pageSize"].includes(k)) ||
    (query.mode !== undefined && query.mode !== "AGENT" && query.mode !== "HUMAN") ||
    (query.q !== undefined && (typeof query.q !== "string" || query.q.length > 200)) ||
    (query.pageSize !== undefined &&
      typeof query.pageSize !== "number" &&
      !(typeof query.pageSize === "string" && /^[1-9]\d*$/.test(query.pageSize)))
  )
    throw new ConversationQueryError();
  const pageSize = query.pageSize === undefined ? 20 : Number(query.pageSize);
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new ConversationQueryError();
  const mode = query.mode as "AGENT" | "HUMAN" | undefined;
  const q = (typeof query.q === "string" ? query.q : "").trim();
  const scope = hash(
    JSON.stringify([
      actor.tenantId,
      actor.subjectId,
      isCustomerActor(actor) ? actor.customerId : null,
      venueId,
      mode ?? null,
      q,
    ]),
  );
  let pivot: { at: string; id: string } | null = null;
  if (query.cursor !== undefined) {
    if (typeof query.cursor !== "string" || query.cursor.length > 2000 || !/^[A-Za-z0-9_-]+$/.test(query.cursor))
      throw new ConversationQueryError("INVALID_CONVERSATION_CURSOR");
    try {
      const value: unknown = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      const cursor = value as Record<string, unknown>;
      if (
        Object.keys(cursor).sort().join(",") !== "at,id,scope,v" ||
        cursor.v !== 1 ||
        cursor.scope !== scope ||
        typeof cursor.at !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(cursor.at) ||
        !Number.isFinite(Date.parse(cursor.at)) ||
        new Date(cursor.at).toISOString().slice(0, 19) !== cursor.at.slice(0, 19) ||
        typeof cursor.id !== "string" ||
        !cursor.id ||
        cursor.id.length > 200
      )
        throw new Error();
      pivot = { at: cursor.at, id: cursor.id };
    } catch {
      throw new ConversationQueryError("INVALID_CONVERSATION_CURSOR");
    }
  }
  return withBookingTransaction(db, actor, async (tx) => {
    await requireBookingVenue(tx, actor, venueId, isCustomerActor(actor) ? "read" : "book");
    const rows = (
      await tx.query<ConversationSummary & { cursorAt: string }>(
        `SELECT c.id,c.tenant_id AS "tenantId",c.venue_id AS "venueId",c.subject_id AS "subjectId",c.customer_id AS "customerId",
        c.actor_kind AS "actorKind",c.mode,c.generation,c.taken_by AS "takenBy",c.updated_at AS "updatedAt",
        coalesce(customer.nickname,s.display_name) AS "displayName",
        (SELECT context_order_id FROM tennis.agent_messages WHERE tenant_id=c.tenant_id AND conversation_id=c.id
          AND context_order_id IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT 1) AS "latestOrderId",
        to_char(c.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorAt"
      FROM tennis.agent_conversations c JOIN tennis.subjects s ON s.id=c.subject_id
      LEFT JOIN tennis.customers customer ON customer.tenant_id=c.tenant_id AND customer.id=c.customer_id
      WHERE c.tenant_id=$1 AND c.venue_id=$2 AND ($3::text IS NULL OR (c.customer_id=$3 AND c.subject_id=$4))
        AND ($5::text IS NULL OR c.mode=$5)
        AND ($6='' OR strpos(lower(coalesce(customer.nickname,s.display_name)),lower($6))>0 OR strpos(lower(c.id),lower($6))>0
          OR EXISTS(SELECT 1 FROM tennis.agent_messages m WHERE m.tenant_id=c.tenant_id AND m.conversation_id=c.id AND strpos(lower(m.context_order_id),lower($6))>0))
        AND ($7::timestamptz IS NULL OR (c.updated_at,c.id)<($7::timestamptz,$8::text))
      ORDER BY c.updated_at DESC,c.id DESC LIMIT $9`,
        [
          actor.tenantId,
          venueId,
          isCustomerActor(actor) ? actor.customerId : null,
          actor.subjectId,
          mode ?? null,
          q,
          pivot?.at ?? null,
          pivot?.id ?? null,
          pageSize + 1,
        ],
      )
    ).rows;
    const page = rows.slice(0, pageSize);
    const last = page.at(-1);
    return {
      items: page.map(({ cursorAt: _cursorAt, ...item }) => item),
      nextCursor:
        rows.length > pageSize && last
          ? Buffer.from(JSON.stringify({ v: 1, scope, at: last.cursorAt, id: last.id })).toString("base64url")
          : null,
    };
  });
}
export interface AssistantMessageFeedback {
  conversationId: string;
  messageId: string;
  resolved: boolean;
  updatedAt: string;
}
export async function getConversation(db: pg.Pool, actor: BookingActor, id: string) {
  return withBookingTransaction(db, actor, async (tx) => {
    const item = await conversation(tx, actor, id);
    const messages = (
      await tx.query<{
        id: string;
        role: string;
        content: string;
        createdAt: Date;
        feedback: boolean | null;
        context: AssistantContext | null;
      }>(
        `SELECT m.id,m.role,m.content,m.created_at AS "createdAt",f.resolved AS feedback,
        CASE WHEN m.context_page IS NULL THEN NULL ELSE jsonb_strip_nulls(jsonb_build_object('page',m.context_page,'orderId',m.context_order_id)) END AS context
      FROM (SELECT * FROM tennis.agent_messages WHERE tenant_id=$1 AND conversation_id=$2 ORDER BY created_at DESC,id DESC LIMIT 200) m
      LEFT JOIN tennis.agent_message_feedback f ON f.tenant_id=m.tenant_id AND f.conversation_id=m.conversation_id AND f.message_id=m.id AND f.subject_id=$3
      ORDER BY m.created_at,m.id`,
        [actor.tenantId, id, actor.subjectId],
      )
    ).rows;
    const latestOrderContext =
      (
        await tx.query<LatestOrderContext>(
          `SELECT id AS "messageId",context_page AS page,context_order_id AS "orderId",created_at AS "createdAt"
        FROM tennis.agent_messages WHERE tenant_id=$1 AND conversation_id=$2 AND context_order_id IS NOT NULL
        ORDER BY created_at DESC,id DESC LIMIT 1`,
          [actor.tenantId, id],
        )
      ).rows[0] ?? null;
    return { conversation: item, messages, latestOrderContext };
  });
}
export interface AgentRequestSummary {
  requestId: string;
  messageId: string | null;
  generation: number;
  createdAt: string;
  dispatchStatus: "IN_FLIGHT" | "SUCCEEDED" | "UNCERTAIN" | "ISSUED";
  commandCount: number;
}
export interface AgentCommandResource {
  type: string;
  id: string;
  status: string;
  paymentStatus?: string;
}
export interface AgentCommandSummary {
  commandKey: string;
  commandType: string;
  completedAt: string;
  resources: AgentCommandResource[];
}
export interface AgentRequestDetail extends AgentRequestSummary {
  commands: AgentCommandSummary[];
  restrictedCommandCount: number;
}
interface RequestSummaryRow extends Omit<AgentRequestSummary, "createdAt"> {
  createdAt: Date;
}
const requestSummaryColumns = `r.id AS "requestId",r.message_id AS "messageId",r.generation,r.created_at AS "createdAt",
  coalesce(d.status,'ISSUED') AS "dispatchStatus",(SELECT count(*)::int FROM tennis.agent_command_links l WHERE l.tenant_id=r.tenant_id AND l.request_id=r.id) AS "commandCount"`;
const requestSummary = (row: RequestSummaryRow): AgentRequestSummary => ({
  ...row,
  createdAt: row.createdAt.toISOString(),
});
/** A regular authorized identity can inspect history after the original write token is revoked. */
export async function listConversationRequests(
  db: pg.Pool,
  actor: BookingActor,
  id: string,
  cursor?: string,
): Promise<{ items: AgentRequestSummary[]; nextCursor: string | null }> {
  return withBookingTransaction(db, actor, async (tx) => {
    await conversation(tx, actor, id);
    if (
      cursor &&
      !(
        await tx.query("SELECT id FROM tennis.agent_requests WHERE tenant_id=$1 AND conversation_id=$2 AND id=$3", [
          actor.tenantId,
          id,
          cursor,
        ])
      ).rowCount
    )
      throw new TenantAccessError("RESOURCE_NOT_FOUND");
    const rows = (
      await tx.query<RequestSummaryRow>(
        `SELECT ${requestSummaryColumns} FROM tennis.agent_requests r
      LEFT JOIN tennis.agent_message_dispatches d ON d.tenant_id=r.tenant_id AND d.conversation_id=r.conversation_id AND d.message_id=r.message_id
      WHERE r.tenant_id=$1 AND r.conversation_id=$2 AND ($3::text IS NULL OR (r.created_at,r.id)<(SELECT created_at,id FROM tennis.agent_requests WHERE tenant_id=$1 AND conversation_id=$2 AND id=$3))
      ORDER BY r.created_at DESC,r.id DESC LIMIT 21`,
        [actor.tenantId, id, cursor ?? null],
      )
    ).rows;
    return { items: rows.slice(0, 20).map(requestSummary), nextCursor: rows.length > 20 ? rows[19]!.requestId : null };
  });
}
async function commandResources(
  tx: pg.PoolClient,
  actor: BookingActor,
  venueId: string,
  result: Record<string, unknown>,
): Promise<AgentCommandResource[] | null> {
  // Static table/field identifiers only. Never return request payloads or arbitrary receipt JSON.
  const specs = [
    ["orderId", "order", "orders"],
    ["paymentId", "payment", "payment_attempts"],
    ["topupId", "topup", "topup_payments"],
    ["refundId", "refund", "refunds"],
    ["refundGroupId", "refund-group", "refund_groups"],
    ["amendmentId", "amendment", "order_amendments"],
    ["batchId", "wallet-batch", "wallet_batches"],
  ] as const;
  const resources: AgentCommandResource[] = [];
  for (const [field, type, table] of specs) {
    const resourceId = result[field];
    if (typeof resourceId !== "string") continue;
    const status = table === "wallet_batches" ? "'CREDITED'" : table === "refund_groups" ? "'RECORDED'" : "status";
    const row = (
      await tx.query<{ status: string; paymentStatus?: string }>(
        `SELECT ${status} AS status${table === "orders" ? ',payment_status AS "paymentStatus"' : ""} FROM tennis.${table}
      WHERE tenant_id=$1 AND venue_id=$2 AND id=$3 AND ($4::text IS NULL OR customer_id=$4)`,
        [actor.tenantId, venueId, resourceId, isCustomerActor(actor) ? actor.customerId : null],
      )
    ).rows[0];
    if (!row) return null;
    resources.push({ type, id: resourceId, ...row });
  }
  return resources;
}
export async function getConversationRequest(
  db: pg.Pool,
  actor: BookingActor,
  id: string,
  requestId: string,
): Promise<AgentRequestDetail> {
  return withBookingTransaction(db, actor, async (tx) => {
    const conv = await conversation(tx, actor, id);
    const row = (
      await tx.query<RequestSummaryRow>(
        `SELECT ${requestSummaryColumns} FROM tennis.agent_requests r
      LEFT JOIN tennis.agent_message_dispatches d ON d.tenant_id=r.tenant_id AND d.conversation_id=r.conversation_id AND d.message_id=r.message_id
      WHERE r.tenant_id=$1 AND r.conversation_id=$2 AND r.id=$3`,
        [actor.tenantId, id, requestId],
      )
    ).rows[0];
    if (!row) throw new TenantAccessError("RESOURCE_NOT_FOUND");
    const receipts = (
      await tx.query<{ commandKey: string; commandType: string; completedAt: Date; result: Record<string, unknown> }>(
        `SELECT c.command_key AS "commandKey",c.command_type AS "commandType",c.completed_at AS "completedAt",c.result
      FROM tennis.agent_command_links l JOIN tennis.command_receipts c ON c.tenant_id=l.tenant_id AND c.subject_id=l.subject_id AND c.command_key=l.command_key
      WHERE l.tenant_id=$1 AND l.conversation_id=$2 AND l.request_id=$3 AND c.venue_id=$4 AND c.completed_at IS NOT NULL ORDER BY c.completed_at,c.command_key`,
        [actor.tenantId, id, requestId, conv.venueId],
      )
    ).rows;
    const commands: AgentCommandSummary[] = [];
    let restrictedCommandCount = 0;
    for (const receipt of receipts) {
      if (!isCustomerActor(actor) && /^(topup|wallet)\./.test(receipt.commandType)) {
        try {
          await requireBookingVenue(tx, actor, conv.venueId, "manage_members");
        } catch (error) {
          if (!(error instanceof TenantAccessError)) throw error;
          restrictedCommandCount++;
          continue;
        }
      }
      const resources = await commandResources(tx, actor, conv.venueId, receipt.result);
      if (resources === null) {
        restrictedCommandCount++;
        continue;
      }
      commands.push({
        commandKey: receipt.commandKey,
        commandType: receipt.commandType,
        completedAt: receipt.completedAt.toISOString(),
        resources,
      });
    }
    return { ...requestSummary(row), commands, restrictedCommandCount };
  });
}
export async function setAssistantMessageFeedback(
  db: pg.Pool,
  actor: BookingActor,
  id: string,
  messageId: string,
  resolved: boolean,
): Promise<AssistantMessageFeedback> {
  if (typeof resolved !== "boolean") throw new AgentAccessError("INVALID_AGENT_MESSAGE");
  return withBookingTransaction(db, actor, async (tx) => {
    await conversation(tx, actor, id);
    const message = (
      await tx.query<{ role: string }>(
        "SELECT role FROM tennis.agent_messages WHERE tenant_id=$1 AND conversation_id=$2 AND id=$3 FOR SHARE",
        [actor.tenantId, id, messageId],
      )
    ).rows[0];
    if (!message || message.role !== "assistant") throw new TenantAccessError("RESOURCE_NOT_FOUND");
    const result = (
      await tx.query<{ conversationId: string; messageId: string; resolved: boolean; updatedAt: Date }>(
        `INSERT INTO tennis.agent_message_feedback(tenant_id,conversation_id,message_id,subject_id,resolved)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,conversation_id,message_id,subject_id) DO UPDATE
      SET resolved=EXCLUDED.resolved,updated_at=CASE WHEN tennis.agent_message_feedback.resolved IS DISTINCT FROM EXCLUDED.resolved THEN clock_timestamp() ELSE tennis.agent_message_feedback.updated_at END
      RETURNING conversation_id AS "conversationId",message_id AS "messageId",resolved,updated_at AS "updatedAt"`,
        [actor.tenantId, id, messageId, actor.subjectId, resolved],
      )
    ).rows[0]!;
    return { ...result, updatedAt: result.updatedAt.toISOString() };
  });
}
export async function handoffConversation(
  db: pg.Pool,
  actor: BookingActor,
  id: string,
  input: { mode: "AGENT" | "HUMAN"; reason: string; context?: AssistantContext },
): Promise<Conversation> {
  if (!input.reason.trim() || input.reason.length > 2000) throw new AgentAccessError("INVALID_AGENT_MESSAGE");
  if (isCustomerActor(actor) && input.mode !== "HUMAN") throw new TenantAccessError("TENANT_ACCESS_DENIED");
  return withBookingTransaction(db, actor, async (tx) => {
    const existing = await conversation(tx, actor, id);
    const context = await validateConversationContext(tx, actor, existing, input.context);
    const row = (
      await tx.query<Conversation>(
        `UPDATE tennis.agent_conversations SET mode=$3,generation=generation+1,taken_by=$4,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 RETURNING ${conversationColumns}`,
        [actor.tenantId, id, input.mode, input.mode === "HUMAN" && !isCustomerActor(actor) ? actor.subjectId : null],
      )
    ).rows[0]!;
    await tx.query("DELETE FROM tennis.agent_delegations WHERE tenant_id=$1 AND conversation_id=$2", [
      actor.tenantId,
      id,
    ]);
    await tx.query(
      `INSERT INTO tennis.agent_messages(id,tenant_id,conversation_id,role,subject_id,content,context_page,context_order_id) VALUES($1,$2,$3,'system',$4,$5,$6,$7)`,
      [
        randomUUID(),
        actor.tenantId,
        id,
        actor.subjectId,
        `${input.mode === "HUMAN" ? "转人工处理" : "恢复智能体协作"}：${input.reason.trim()}`,
        context?.page ?? null,
        context?.orderId ?? null,
      ],
    );
    await recordTenantAudit(tx, actor, "agent.handoff", id, {
      mode: input.mode,
      reason: input.reason.trim(),
      generation: row.generation,
    });
    return row;
  });
}
export async function issueDelegation(db: pg.Pool, actor: BookingActor, id: string, messageId?: string) {
  return withBookingTransaction(db, actor, (tx) => issueDelegationInTransaction(tx, actor, id, messageId));
}
/** Caller owns the transaction; Gateway can bind its identity before this transaction commits. */
export async function issueDelegationInTransaction(
  tx: pg.PoolClient,
  actor: BookingActor,
  id: string,
  messageId?: string,
) {
  const row = await conversation(tx, actor, id);
  if (row.subjectId !== actor.subjectId) throw new TenantAccessError("TENANT_ACCESS_DENIED");
  if (row.mode !== "AGENT") throw new AgentAccessError("HUMAN_HANDOFF_ACTIVE");
  if (messageId) {
    const message = await tx.query(
      `SELECT id FROM tennis.agent_messages WHERE tenant_id=$1 AND conversation_id=$2 AND id=$3 AND subject_id=$4 AND role='user'`,
      [actor.tenantId, id, messageId, actor.subjectId],
    );
    if (message.rowCount !== 1) throw new AgentAccessError("INVALID_AGENT_MESSAGE");
    const pending = (
      await tx.query<{ status: string }>(
        `SELECT status FROM tennis.agent_message_dispatches WHERE message_id=$1 OR (tenant_id=$2 AND conversation_id=$3 AND generation=$4 AND status<>'SUCCEEDED') ORDER BY created_at LIMIT 1`,
        [messageId, actor.tenantId, id, row.generation],
      )
    ).rows[0];
    if (pending)
      throw new AgentAccessError(pending.status === "IN_FLIGHT" ? "ASSISTANT_BUSY" : "ASSISTANT_RESULT_UNKNOWN");
    await tx.query(
      "INSERT INTO tennis.agent_message_dispatches(message_id,tenant_id,conversation_id,generation,status) VALUES($1,$2,$3,$4,'IN_FLIGHT')",
      [messageId, actor.tenantId, id, row.generation],
    );
  }
  const requestId = messageId ?? `delegation:${randomUUID()}`;
  await tx.query(
    `INSERT INTO tennis.agent_requests(id,tenant_id,conversation_id,subject_id,venue_id,generation,message_id)
    VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [requestId, actor.tenantId, id, actor.subjectId, row.venueId, row.generation, messageId ?? null],
  );
  const token = randomBytes(32).toString("base64url");
  const expiresAt = (
    await tx.query<{ expiresAt: Date }>(
      `INSERT INTO tennis.agent_delegations(token_hash,tenant_id,conversation_id,generation,request_id,expires_at)
    VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '15 minutes') RETURNING expires_at AS "expiresAt"`,
      [hash(token), actor.tenantId, id, row.generation, requestId],
    )
  ).rows[0]!.expiresAt;
  // Anchor queued requests to their own message. Later user instructions must not
  // become the context of an earlier request, even with more than 200 queued messages.
  const messages = (
    await tx.query<{ id: string; role: string; content: string; createdAt: Date; context: AssistantContext | null }>(
      `
    SELECT id,role,content,created_at AS "createdAt",
      CASE WHEN context_page IS NULL THEN NULL ELSE jsonb_strip_nulls(jsonb_build_object('page',context_page,'orderId',context_order_id)) END AS context FROM (
      SELECT * FROM tennis.agent_messages WHERE tenant_id=$1 AND conversation_id=$2
      AND ($3::text IS NULL OR (created_at,id)<=(SELECT created_at,id FROM tennis.agent_messages
        WHERE tenant_id=$1 AND conversation_id=$2 AND id=$3))
      ORDER BY created_at DESC,id DESC LIMIT 200
    ) m ORDER BY created_at,id`,
      [actor.tenantId, id, messageId ?? null],
    )
  ).rows;
  const context = messageId ? (messages.find((message) => message.id === messageId)?.context ?? null) : null;
  return { token, expiresAt, conversation: row, messages, requestId, context };
}
export async function resolveDelegation(
  db: pg.Pool,
  token: string,
): Promise<{ actor: BookingActor; conversation: Conversation; requestId: string; context: AssistantContext | null }> {
  if (!/^[a-zA-Z0-9_-]{43}$/.test(token)) throw new AgentAccessError("AGENT_DELEGATION_REVOKED");
  const row = (
    await db.query<Conversation & { requestId: string }>(
      `SELECT d.request_id AS "requestId",c.id,c.tenant_id AS "tenantId",c.venue_id AS "venueId",c.subject_id AS "subjectId",c.customer_id AS "customerId",c.actor_kind AS "actorKind",c.mode,c.generation,c.taken_by AS "takenBy",c.updated_at AS "updatedAt" FROM tennis.agent_delegations d JOIN tennis.agent_conversations c ON c.tenant_id=d.tenant_id AND c.id=d.conversation_id WHERE d.token_hash=$1 AND d.expires_at>clock_timestamp() AND c.mode='AGENT' AND c.generation=d.generation`,
      [hash(token)],
    )
  ).rows[0];
  if (!row) throw new AgentAccessError("AGENT_DELEGATION_REVOKED");
  const actor: BookingActor =
    row.actorKind === "customer"
      ? { tenantId: row.tenantId, subjectId: row.subjectId, kind: "customer", customerId: row.customerId! }
      : { tenantId: row.tenantId, subjectId: row.subjectId };
  bindDelegation(actor, {
    tokenHash: hash(token),
    conversationId: row.id,
    requestId: row.requestId,
    venueId: row.venueId,
    generation: row.generation,
  });
  const context = await withBookingTransaction(db, actor, async (tx) => {
    await requireBookingVenue(tx, actor, row.venueId, "read");
    return (
      (
        await tx.query<{ context: AssistantContext | null }>(
          `SELECT CASE WHEN m.context_page IS NULL THEN NULL ELSE jsonb_strip_nulls(jsonb_build_object('page',m.context_page,'orderId',m.context_order_id)) END AS context
        FROM tennis.agent_requests r LEFT JOIN tennis.agent_messages m ON m.tenant_id=r.tenant_id AND m.id=r.message_id
        WHERE r.tenant_id=$1 AND r.conversation_id=$2 AND r.id=$3`,
          [actor.tenantId, row.id, row.requestId],
        )
      ).rows[0]?.context ?? null
    );
  });
  const { requestId, ...item } = row;
  return { actor, conversation: item, requestId, context };
}
export interface AgentTransport {
  (
    url: string,
    input: { headers: Record<string, string>; body: string; signal: AbortSignal },
  ): Promise<{ ok: boolean; json(): Promise<unknown> }>;
}
export async function sendAssistantMessage(
  db: pg.Pool,
  actor: BookingActor,
  key: Buffer,
  id: string,
  input: { messageId: string; content: string; context?: AssistantContext },
  transport: AgentTransport = async (url, input) => fetch(url, { method: "POST", ...input, redirect: "error" }),
) {
  if (!input.content.trim() || input.content.length > 8000 || !input.messageId || input.messageId.length > 128)
    throw new AgentAccessError("INVALID_AGENT_MESSAGE");
  const existing = await withBookingTransaction(db, actor, async (tx) => {
    const conv = await conversation(tx, actor, id);
    if (conv.mode === "AGENT" && conv.subjectId !== actor.subjectId)
      throw new TenantAccessError("TENANT_ACCESS_DENIED");
    const context = await validateConversationContext(tx, actor, conv, input.context);
    const found = (
      await tx.query<{
        content: string;
        subject_id: string;
        conversation_id: string;
        context_page: string | null;
        context_order_id: string | null;
      }>(
        "SELECT content,subject_id,conversation_id,context_page,context_order_id FROM tennis.agent_messages WHERE id=$1",
        [input.messageId],
      )
    ).rows[0];
    if (
      found &&
      (found.subject_id !== actor.subjectId ||
        found.conversation_id !== id ||
        found.content !== input.content.trim() ||
        found.context_page !== (context?.page ?? null) ||
        found.context_order_id !== (context?.orderId ?? null))
    )
      throw new AgentAccessError("INVALID_AGENT_MESSAGE");
    if (!found)
      await tx.query(
        "INSERT INTO tennis.agent_messages(id,tenant_id,conversation_id,role,subject_id,content,context_page,context_order_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          input.messageId,
          actor.tenantId,
          id,
          conv.mode === "HUMAN" && !isCustomerActor(actor) ? "staff" : "user",
          actor.subjectId,
          input.content.trim(),
          context?.page ?? null,
          context?.orderId ?? null,
        ],
      );
    const answered =
      (
        await tx.query("SELECT id FROM tennis.agent_messages WHERE id=$1 AND tenant_id=$2 AND conversation_id=$3", [
          `reply:${input.messageId}`,
          actor.tenantId,
          id,
        ])
      ).rowCount === 1;
    await tx.query("UPDATE tennis.agent_conversations SET updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2", [
      actor.tenantId,
      id,
    ]);
    return { conv, answered };
  });
  if (existing.conv.mode === "HUMAN" || existing.answered) return getConversation(db, actor, id);
  const config = (
    await db.query<StoredConfig>(`SELECT ${configColumns} FROM tennis.platform_ai_config WHERE singleton`)
  ).rows[0]!;
  if (!config.enabled || !config.externalAgentUrl) throw new AgentAccessError("ASSISTANT_NOT_CONFIGURED");
  const delegation = await issueDelegation(db, actor, id, input.messageId);
  let content: string;
  try {
    // Recheck before dispatch, and only send the snapshot captured when the
    // delegation was issued. Later HUMAN messages never enter this payload.
    await resolveDelegation(db, delegation.token);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (config.encryptedKey) headers.Authorization = `Bearer ${decrypt(config.encryptedKey, key)}`;
    const response = await transport(config.externalAgentUrl, {
      headers,
      body: JSON.stringify({
        protocol: "tennis-agent/v1",
        requestId: input.messageId,
        conversationId: id,
        generation: delegation.conversation.generation,
        model: config.model,
        baseUrl: config.baseUrl,
        context: delegation.context ?? {},
        workspace: {
          tenantId: actor.tenantId,
          venueId: delegation.conversation.venueId,
          actorKind: delegation.conversation.actorKind,
        },
        delegation: { token: delegation.token, expiresAt: delegation.expiresAt },
        messages: delegation.messages,
      }),
      signal: AbortSignal.timeout(30000),
    });
    const result = response.ok ? await response.json() : null;
    if (
      !result ||
      typeof result !== "object" ||
      !("content" in result) ||
      typeof result.content !== "string" ||
      !result.content.trim() ||
      result.content.length > 16000
    )
      throw new Error();
    content = result.content;
    await withBookingTransaction(db, actor, async (tx) => {
      const conv = await conversation(tx, actor, id);
      if (conv.mode !== "AGENT" || conv.generation !== delegation.conversation.generation)
        throw new AgentAccessError("HUMAN_HANDOFF_ACTIVE");
      await tx.query(
        "INSERT INTO tennis.agent_messages(id,tenant_id,conversation_id,role,content) VALUES($1,$2,$3,'assistant',$4) ON CONFLICT(id) DO NOTHING",
        [`reply:${input.messageId}`, actor.tenantId, id, content],
      );
      await tx.query(
        "UPDATE tennis.agent_message_dispatches SET status='SUCCEEDED',updated_at=clock_timestamp() WHERE message_id=$1 AND tenant_id=$2",
        [input.messageId, actor.tenantId],
      );
    });
  } catch (error) {
    await db.query(
      "UPDATE tennis.agent_message_dispatches SET status='UNCERTAIN',updated_at=clock_timestamp() WHERE message_id=$1 AND tenant_id=$2",
      [input.messageId, actor.tenantId],
    );
    if (error instanceof AgentAccessError && ["HUMAN_HANDOFF_ACTIVE", "AGENT_DELEGATION_REVOKED"].includes(error.code))
      throw error;
    throw new AgentAccessError("ASSISTANT_RESULT_UNKNOWN");
  } finally {
    await db.query("DELETE FROM tennis.agent_delegations WHERE token_hash=$1", [hash(delegation.token)]);
  }
  return getConversation(db, actor, id);
}
