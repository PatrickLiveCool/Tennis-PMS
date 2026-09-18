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
      await tx.query<{ id: string; role: string; content: string; createdAt: Date; feedback: boolean | null }>(
        `SELECT m.id,m.role,m.content,m.created_at AS "createdAt",f.resolved AS feedback
      FROM (SELECT * FROM tennis.agent_messages WHERE tenant_id=$1 AND conversation_id=$2 ORDER BY created_at DESC,id DESC LIMIT 200) m
      LEFT JOIN tennis.agent_message_feedback f ON f.tenant_id=m.tenant_id AND f.conversation_id=m.conversation_id AND f.message_id=m.id AND f.subject_id=$3
      ORDER BY m.created_at,m.id`,
        [actor.tenantId, id, actor.subjectId],
      )
    ).rows;
    return { conversation: item, messages };
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
  input: { mode: "AGENT" | "HUMAN"; reason: string },
): Promise<Conversation> {
  if (!input.reason.trim() || input.reason.length > 2000) throw new AgentAccessError("INVALID_AGENT_MESSAGE");
  if (isCustomerActor(actor) && input.mode !== "HUMAN") throw new TenantAccessError("TENANT_ACCESS_DENIED");
  return withBookingTransaction(db, actor, async (tx) => {
    await conversation(tx, actor, id);
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
      `INSERT INTO tennis.agent_messages(id,tenant_id,conversation_id,role,subject_id,content) VALUES($1,$2,$3,'system',$4,$5)`,
      [
        randomUUID(),
        actor.tenantId,
        id,
        actor.subjectId,
        `${input.mode === "HUMAN" ? "转人工处理" : "恢复智能体协作"}：${input.reason.trim()}`,
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
  return withBookingTransaction(db, actor, async (tx) => {
    const row = await conversation(tx, actor, id);
    // A staff member taking over another person's conversation cannot mint their credentials.
    if (row.subjectId !== actor.subjectId) throw new TenantAccessError("TENANT_ACCESS_DENIED");
    if (row.mode !== "AGENT") throw new AgentAccessError("HUMAN_HANDOFF_ACTIVE");
    if (messageId) {
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
    const token = randomBytes(32).toString("base64url");
    const expiresAt = (
      await tx.query<{ expiresAt: Date }>(
        `INSERT INTO tennis.agent_delegations(token_hash,tenant_id,conversation_id,generation,expires_at) VALUES($1,$2,$3,$4,clock_timestamp()+interval '15 minutes') RETURNING expires_at AS "expiresAt"`,
        [hash(token), actor.tenantId, id, row.generation],
      )
    ).rows[0]!.expiresAt;
    const messages = (
      await tx.query<{ id: string; role: string; content: string; createdAt: Date }>(
        `SELECT id,role,content,created_at AS "createdAt" FROM (SELECT * FROM tennis.agent_messages WHERE tenant_id=$1 AND conversation_id=$2 ORDER BY created_at DESC,id DESC LIMIT 200) m ORDER BY created_at,id`,
        [actor.tenantId, id],
      )
    ).rows;
    return { token, expiresAt, conversation: row, messages };
  });
}
export async function resolveDelegation(
  db: pg.Pool,
  token: string,
): Promise<{ actor: BookingActor; conversation: Conversation }> {
  if (!/^[a-zA-Z0-9_-]{43}$/.test(token)) throw new AgentAccessError("AGENT_DELEGATION_REVOKED");
  const row = (
    await db.query<Conversation>(
      `SELECT c.id,c.tenant_id AS "tenantId",c.venue_id AS "venueId",c.subject_id AS "subjectId",c.customer_id AS "customerId",c.actor_kind AS "actorKind",c.mode,c.generation,c.taken_by AS "takenBy",c.updated_at AS "updatedAt" FROM tennis.agent_delegations d JOIN tennis.agent_conversations c ON c.tenant_id=d.tenant_id AND c.id=d.conversation_id WHERE d.token_hash=$1 AND d.expires_at>clock_timestamp() AND c.mode='AGENT' AND c.generation=d.generation`,
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
    venueId: row.venueId,
    generation: row.generation,
  });
  await withBookingTransaction(db, actor, async (tx) => requireBookingVenue(tx, actor, row.venueId, "read"));
  return { actor, conversation: row };
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
  input: { messageId: string; content: string; context?: { page: string; orderId?: string } },
  transport: AgentTransport = async (url, input) => fetch(url, { method: "POST", ...input, redirect: "error" }),
) {
  if (!input.content.trim() || input.content.length > 8000 || !input.messageId || input.messageId.length > 128)
    throw new AgentAccessError("INVALID_AGENT_MESSAGE");
  const existing = await withBookingTransaction(db, actor, async (tx) => {
    const conv = await conversation(tx, actor, id);
    if (conv.mode === "AGENT" && conv.subjectId !== actor.subjectId)
      throw new TenantAccessError("TENANT_ACCESS_DENIED");
    if (input.context?.orderId) {
      const order = (
        await tx.query<{ customer_id: string; venue_id: string }>(
          "SELECT customer_id,venue_id FROM tennis.orders WHERE tenant_id=$1 AND id=$2",
          [actor.tenantId, input.context.orderId],
        )
      ).rows[0];
      if (
        !order ||
        order.venue_id !== conv.venueId ||
        (isCustomerActor(actor) && order.customer_id !== actor.customerId)
      )
        throw new TenantAccessError("RESOURCE_NOT_FOUND");
    }
    const found = (
      await tx.query<{ content: string; subject_id: string; conversation_id: string }>(
        "SELECT content,subject_id,conversation_id FROM tennis.agent_messages WHERE id=$1",
        [input.messageId],
      )
    ).rows[0];
    if (
      found &&
      (found.subject_id !== actor.subjectId || found.conversation_id !== id || found.content !== input.content.trim())
    )
      throw new AgentAccessError("INVALID_AGENT_MESSAGE");
    if (!found)
      await tx.query(
        "INSERT INTO tennis.agent_messages(id,tenant_id,conversation_id,role,subject_id,content) VALUES($1,$2,$3,$4,$5,$6)",
        [
          input.messageId,
          actor.tenantId,
          id,
          conv.mode === "HUMAN" && !isCustomerActor(actor) ? "staff" : "user",
          actor.subjectId,
          input.content.trim(),
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
        context: input.context ?? {},
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
