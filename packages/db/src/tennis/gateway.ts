import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { recordTenantAudit, TenantAccessError, type TenantActor } from "./access.ts";
import { isCustomerActor, withBookingTransaction, type BookingActor } from "./customers.ts";
import { requireBookingVenue } from "./booking.ts";
import { issueDelegationInTransaction, type Conversation } from "./external-agent.ts";
import { bindGatewayIdentity, GatewayAccessError } from "./gateway-guard.ts";
import { lockTenantTransactions } from "./transaction-locks.ts";

const hash = (v: string) => createHash("sha256").update(v).digest("hex");
const text = (v: string, max = 200) => {
  if (typeof v !== "string" || !v.trim() || v.length > max) throw new GatewayAccessError("INVALID_GATEWAY_INPUT");
  return v.trim();
};
const integrationColumns = `id,tenant_id AS "tenantId",name,active,created_at AS "createdAt",revoked_at AS "revokedAt"`;
const bindingColumns = `id,integration_id AS "integrationId",external_subject AS "externalSubjectId",subject_id AS "subjectId",customer_id AS "customerId",actor_kind AS "actorKind",active,reason,created_at AS "createdAt"`;
const conversationColumns = `id,tenant_id AS "tenantId",venue_id AS "venueId",subject_id AS "subjectId",customer_id AS "customerId",actor_kind AS "actorKind",mode,generation,taken_by AS "takenBy",updated_at AS "updatedAt"`;
async function transaction<T>(db: pg.Pool, work: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const tx = await db.connect();
  try {
    await tx.query("BEGIN");
    const value = await work(tx);
    await tx.query("COMMIT");
    return value;
  } catch (error) {
    await tx.query("ROLLBACK");
    throw error;
  } finally {
    tx.release();
  }
}
async function platform(tx: pg.PoolClient, subjectId: string) {
  if (
    (
      await tx.query("SELECT subject_id FROM tennis.platform_operators WHERE subject_id=$1 AND active FOR SHARE", [
        subjectId,
      ])
    ).rowCount !== 1
  )
    throw new TenantAccessError("TENANT_ACCESS_DENIED");
}
async function admin(tx: pg.PoolClient, actor: BookingActor) {
  if (
    isCustomerActor(actor) ||
    (
      await tx.query(
        "SELECT subject_id FROM tennis.tenant_memberships WHERE tenant_id=$1 AND subject_id=$2 AND active AND role='ADMIN' FOR SHARE",
        [actor.tenantId, actor.subjectId],
      )
    ).rowCount !== 1
  )
    throw new TenantAccessError("TENANT_ACCESS_DENIED");
}
export async function listPlatformGateways(db: pg.Pool, subjectId: string, tenantId: string) {
  return transaction(db, async (tx) => {
    await platform(tx, subjectId);
    return (
      await tx.query(
        `SELECT ${integrationColumns} FROM tennis.gateway_integrations WHERE tenant_id=$1 ORDER BY created_at DESC,id`,
        [tenantId],
      )
    ).rows;
  });
}
export async function createGatewayIntegration(
  db: pg.Pool,
  subjectId: string,
  input: { tenantId: string; name: string },
) {
  const name = text(input.name);
  return transaction(db, async (tx) => {
    await lockTenantTransactions(tx, input.tenantId);
    await platform(tx, subjectId);
    if (
      (await tx.query("SELECT id FROM tennis.tenants WHERE id=$1 AND active FOR SHARE", [input.tenantId])).rowCount !==
      1
    )
      throw new TenantAccessError("RESOURCE_NOT_FOUND");
    const token = randomBytes(32).toString("base64url"),
      id = randomUUID();
    const item = (
      await tx.query(
        `INSERT INTO tennis.gateway_integrations(id,tenant_id,name,token_hash,created_by) VALUES($1,$2,$3,$4,$5) RETURNING ${integrationColumns}`,
        [id, input.tenantId, name, hash(token), subjectId],
      )
    ).rows[0];
    await tx.query(
      "INSERT INTO tennis.auth_audit_events(id,subject_id,tenant_id,action,resource_id,details) VALUES($1,$2,$3,'gateway.create',$4,$5)",
      [randomUUID(), subjectId, input.tenantId, id, JSON.stringify({ name })],
    );
    return { ...item, token };
  });
}
export async function revokeGatewayIntegration(db: pg.Pool, subjectId: string, id: string, reason: string) {
  text(reason, 2000);
  return transaction(db, async (tx) => {
    const row = (
      await tx.query<{ tenant_id: string }>("SELECT tenant_id FROM tennis.gateway_integrations WHERE id=$1", [id])
    ).rows[0];
    if (!row) throw new TenantAccessError("RESOURCE_NOT_FOUND");
    await lockTenantTransactions(tx, row.tenant_id);
    await platform(tx, subjectId);
    const item = (
      await tx.query(
        `UPDATE tennis.gateway_integrations SET active=false,revoked_at=coalesce(revoked_at,clock_timestamp()) WHERE id=$1 RETURNING ${integrationColumns}`,
        [id],
      )
    ).rows[0];
    await tx.query(
      "INSERT INTO tennis.auth_audit_events(id,subject_id,tenant_id,action,resource_id,details) VALUES($1,$2,$3,'gateway.revoke',$4,$5)",
      [randomUUID(), subjectId, row.tenant_id, id, JSON.stringify({ reason: reason.trim() })],
    );
    return item;
  });
}
export async function listGatewayBindings(db: pg.Pool, actor: BookingActor) {
  return withBookingTransaction(db, actor, async (tx) => {
    await admin(tx, actor);
    return {
      integrations: (
        await tx.query(
          `SELECT ${integrationColumns} FROM tennis.gateway_integrations WHERE tenant_id=$1 ORDER BY created_at DESC,id`,
          [actor.tenantId],
        )
      ).rows,
      bindings: (
        await tx.query(
          `SELECT ${bindingColumns} FROM tennis.gateway_bindings WHERE tenant_id=$1 ORDER BY created_at DESC,id`,
          [actor.tenantId],
        )
      ).rows,
    };
  });
}
export async function gatewayBindingTargets(db: pg.Pool, actor: BookingActor, q = "") {
  return withBookingTransaction(db, actor, async (tx) => {
    await admin(tx, actor);
    return (
      await tx.query(
        `SELECT * FROM (
 SELECT m.subject_id AS "subjectId",'staff'::text AS "actorKind",s.display_name AS name,NULL::text AS "customerId" FROM tennis.tenant_memberships m JOIN tennis.subjects s ON s.id=m.subject_id WHERE m.tenant_id=$1 AND m.active
 UNION ALL SELECT c.subject_id,'customer',c.nickname,c.id FROM tennis.customers c WHERE c.tenant_id=$1 AND c.active AND c.subject_id IS NOT NULL
 ) targets WHERE NOT EXISTS(SELECT 1 FROM tennis.local_accounts a WHERE a.subject_id=targets."subjectId" AND NOT a.active) AND ($2='' OR strpos(lower(name),lower($2))>0) ORDER BY name,"subjectId","actorKind" LIMIT 100`,
        [actor.tenantId, q.trim().slice(0, 200)],
      )
    ).rows;
  });
}
export async function createGatewayBinding(
  db: pg.Pool,
  actor: BookingActor,
  input: {
    integrationId: string;
    externalSubjectId: string;
    subjectId: string;
    actorKind: "staff" | "customer";
    reason: string;
  },
) {
  const externalSubject = text(input.externalSubjectId),
    reason = text(input.reason, 2000);
  return withBookingTransaction(db, actor, async (tx) => {
    await admin(tx, actor);
    if (
      (
        await tx.query("SELECT id FROM tennis.gateway_integrations WHERE tenant_id=$1 AND id=$2 AND active FOR SHARE", [
          actor.tenantId,
          input.integrationId,
        ])
      ).rowCount !== 1
    )
      throw new TenantAccessError("RESOURCE_NOT_FOUND");
    let customerId: string | null = null;
    if (input.actorKind === "customer") {
      const customer = (
        await tx.query<{ id: string }>(
          "SELECT id FROM tennis.customers WHERE tenant_id=$1 AND subject_id=$2 AND active FOR SHARE",
          [actor.tenantId, input.subjectId],
        )
      ).rows[0];
      if (!customer) throw new TenantAccessError("RESOURCE_NOT_FOUND");
      customerId = customer.id;
    } else if (
      input.actorKind !== "staff" ||
      (
        await tx.query(
          "SELECT subject_id FROM tennis.tenant_memberships WHERE tenant_id=$1 AND subject_id=$2 AND active FOR SHARE",
          [actor.tenantId, input.subjectId],
        )
      ).rowCount !== 1
    )
      throw new TenantAccessError("RESOURCE_NOT_FOUND");
    if (
      (
        await tx.query("SELECT subject_id FROM tennis.local_accounts WHERE subject_id=$1 AND NOT active", [
          input.subjectId,
        ])
      ).rowCount
    )
      throw new TenantAccessError("RESOURCE_NOT_FOUND");
    if (
      (
        await tx.query(
          "SELECT id FROM tennis.gateway_bindings WHERE integration_id=$1 AND external_subject=$2 AND active",
          [input.integrationId, externalSubject],
        )
      ).rowCount
    )
      throw new GatewayAccessError("GATEWAY_MESSAGE_CONFLICT");
    const id = randomUUID();
    const item = (
      await tx.query(
        `INSERT INTO tennis.gateway_bindings(id,tenant_id,integration_id,external_subject,subject_id,customer_id,actor_kind,created_by,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${bindingColumns}`,
        [
          id,
          actor.tenantId,
          input.integrationId,
          externalSubject,
          input.subjectId,
          customerId,
          input.actorKind,
          actor.subjectId,
          reason,
        ],
      )
    ).rows[0];
    await recordTenantAudit(tx, actor, "gateway.bind", id, {
      integrationId: input.integrationId,
      subjectId: input.subjectId,
      actorKind: input.actorKind,
      reason,
    });
    return item;
  });
}
export async function revokeGatewayBinding(db: pg.Pool, actor: BookingActor, id: string, reason: string) {
  text(reason, 2000);
  return withBookingTransaction(db, actor, async (tx) => {
    await admin(tx, actor);
    const item = (
      await tx.query(
        `UPDATE tennis.gateway_bindings SET active=false,revoked_at=coalesce(revoked_at,clock_timestamp()) WHERE tenant_id=$1 AND id=$2 RETURNING ${bindingColumns}`,
        [actor.tenantId, id],
      )
    ).rows[0];
    if (!item) throw new TenantAccessError("RESOURCE_NOT_FOUND");
    await recordTenantAudit(tx, actor, "gateway.unbind", id, { reason: reason.trim() });
    return item;
  });
}
export interface GatewayPrincipal {
  actor: BookingActor;
  integrationId: string;
  bindingId: string;
}
export async function resolveGatewayIdentity(
  db: pg.Pool,
  token: string,
  externalSubjectId: string,
): Promise<GatewayPrincipal> {
  if (!/^[a-zA-Z0-9_-]{43}$/.test(token)) throw new GatewayAccessError("GATEWAY_ACCESS_REVOKED");
  text(externalSubjectId);
  const row = (
    await db.query<{
      id: string;
      integrationId: string;
      tenantId: string;
      subjectId: string;
      customerId: string | null;
      actorKind: string;
    }>(
      `SELECT b.id,b.integration_id AS "integrationId",b.tenant_id AS "tenantId",b.subject_id AS "subjectId",b.customer_id AS "customerId",b.actor_kind AS "actorKind" FROM tennis.gateway_integrations i JOIN tennis.gateway_bindings b ON b.integration_id=i.id AND b.tenant_id=i.tenant_id WHERE i.token_hash=$1 AND i.active AND b.external_subject=$2 AND b.active`,
      [hash(token), externalSubjectId.trim()],
    )
  ).rows[0];
  if (!row) throw new GatewayAccessError("GATEWAY_IDENTITY_UNBOUND");
  const actor: BookingActor =
    row.actorKind === "customer"
      ? { subjectId: row.subjectId, tenantId: row.tenantId, kind: "customer", customerId: row.customerId! }
      : { subjectId: row.subjectId, tenantId: row.tenantId };
  bindGatewayIdentity(actor, { integrationId: row.integrationId, bindingId: row.id, tokenHash: hash(token) });
  await withBookingTransaction(db, actor, async () => {});
  return { actor, integrationId: row.integrationId, bindingId: row.id };
}
async function gatewayConversation(tx: pg.PoolClient, p: GatewayPrincipal, conversationId: string) {
  const row = (
    await tx.query<Conversation>(
      `SELECT ${conversationColumns} FROM tennis.agent_conversations WHERE tenant_id=$1 AND id=$2 AND EXISTS(SELECT 1 FROM tennis.gateway_conversations g WHERE g.tenant_id=$1 AND g.conversation_id=$2 AND g.binding_id=$3 AND g.integration_id=$4) FOR UPDATE`,
      [p.actor.tenantId, conversationId, p.bindingId, p.integrationId],
    )
  ).rows[0];
  if (!row || row.subjectId !== p.actor.subjectId) throw new TenantAccessError("RESOURCE_NOT_FOUND");
  await requireBookingVenue(tx, p.actor, row.venueId, isCustomerActor(p.actor) ? "read" : "book");
  return row;
}
export async function receiveGatewayMessage(
  db: pg.Pool,
  p: GatewayPrincipal,
  input: { externalConversationId: string; externalMessageId: string; venueId: string; content: string },
) {
  const externalConversation = text(input.externalConversationId),
    externalMessage = text(input.externalMessageId),
    content = text(input.content, 8000);
  return withBookingTransaction(db, p.actor, async (tx) => {
    await requireBookingVenue(tx, p.actor, input.venueId, isCustomerActor(p.actor) ? "read" : "book");
    const mapping = (
      await tx.query<{ conversationId: string }>(
        `SELECT conversation_id AS "conversationId" FROM tennis.gateway_conversations WHERE binding_id=$1 AND external_conversation=$2`,
        [p.bindingId, externalConversation],
      )
    ).rows[0];
    let conv: Conversation;
    if (mapping) {
      conv = await gatewayConversation(tx, p, mapping.conversationId);
      if (conv.venueId !== input.venueId) throw new GatewayAccessError("GATEWAY_SCOPE_CHANGED");
    } else {
      conv = (
        await tx.query<Conversation>(
          `INSERT INTO tennis.agent_conversations(id,tenant_id,venue_id,subject_id,customer_id,actor_kind) VALUES($1,$2,$3,$4,$5,$6) RETURNING ${conversationColumns}`,
          [
            randomUUID(),
            p.actor.tenantId,
            input.venueId,
            p.actor.subjectId,
            isCustomerActor(p.actor) ? p.actor.customerId : null,
            isCustomerActor(p.actor) ? "customer" : "staff",
          ],
        )
      ).rows[0]!;
      await tx.query(
        "INSERT INTO tennis.gateway_conversations(tenant_id,integration_id,binding_id,external_conversation,conversation_id) VALUES($1,$2,$3,$4,$5)",
        [p.actor.tenantId, p.integrationId, p.bindingId, externalConversation, conv.id],
      );
    }
    const existing = (
      await tx.query<{ id: string; binding_id: string; conversation_id: string; content_hash: string }>(
        "SELECT id,binding_id,conversation_id,content_hash FROM tennis.gateway_messages WHERE integration_id=$1 AND external_message=$2",
        [p.integrationId, externalMessage],
      )
    ).rows[0];
    if (existing) {
      if (
        existing.binding_id !== p.bindingId ||
        existing.conversation_id !== conv.id ||
        existing.content_hash !== hash(content)
      )
        throw new GatewayAccessError("GATEWAY_MESSAGE_CONFLICT");
      return { conversation: conv, messageId: existing.id, duplicate: true };
    }
    const messageId = randomUUID();
    await tx.query(
      "INSERT INTO tennis.agent_messages(id,tenant_id,conversation_id,role,subject_id,content) VALUES($1,$2,$3,'user',$4,$5)",
      [messageId, p.actor.tenantId, conv.id, p.actor.subjectId, content],
    );
    await tx.query(
      "INSERT INTO tennis.gateway_messages(id,tenant_id,integration_id,binding_id,conversation_id,external_message,generation,content_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        messageId,
        p.actor.tenantId,
        p.integrationId,
        p.bindingId,
        conv.id,
        externalMessage,
        conv.generation,
        hash(content),
      ],
    );
    await tx.query("UPDATE tennis.agent_conversations SET updated_at=clock_timestamp() WHERE id=$1", [conv.id]);
    return { conversation: conv, messageId, duplicate: false };
  });
}
function seal(value: string, key: Buffer, aad: string) {
  if (key.length !== 32) throw new GatewayAccessError("INVALID_GATEWAY_INPUT");
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((p) => p.toString("base64url")).join(".");
}
function unseal(value: string, key: Buffer, aad: string) {
  const [iv, tag, data] = value.split(".").map((p) => Buffer.from(p, "base64url"));
  const cipher = createDecipheriv("aes-256-gcm", key, iv!);
  cipher.setAAD(Buffer.from(aad));
  cipher.setAuthTag(tag!);
  return Buffer.concat([cipher.update(data!), cipher.final()]).toString("utf8");
}
export interface GatewayGrantSnapshot {
  requestId: string;
  expiresAt: string;
  conversation: Omit<Conversation, "updatedAt"> & { updatedAt: string };
  messages: { id: string; role: string; content: string; createdAt: string }[];
}
export async function grantGatewayMessage(
  db: pg.Pool,
  p: GatewayPrincipal,
  key: Buffer,
  conversationId: string,
  messageId: string,
  expectedGeneration: number,
) {
  return withBookingTransaction(db, p.actor, async (tx) => {
    const conv = await gatewayConversation(tx, p, conversationId),
      message = (
        await tx.query<{
          generation: number;
          encrypted_token: string | null;
          token_hash: string | null;
          grant_snapshot: GatewayGrantSnapshot | null;
        }>(
          "SELECT generation,encrypted_token,token_hash,grant_snapshot FROM tennis.gateway_messages WHERE tenant_id=$1 AND binding_id=$2 AND conversation_id=$3 AND id=$4 FOR UPDATE",
          [p.actor.tenantId, p.bindingId, conversationId, messageId],
        )
      ).rows[0];
    if (!message) throw new TenantAccessError("RESOURCE_NOT_FOUND");
    if (conv.mode !== "AGENT" || conv.generation !== expectedGeneration || message.generation !== conv.generation)
      throw new GatewayAccessError("GATEWAY_SCOPE_CHANGED");
    if (message.grant_snapshot) {
      if (
        !message.encrypted_token ||
        (
          await tx.query(
            "SELECT token_hash FROM tennis.agent_delegations WHERE token_hash=$1 AND tenant_id=$2 AND gateway_binding_id=$3 AND expires_at>clock_timestamp()",
            [message.token_hash, p.actor.tenantId, p.bindingId],
          )
        ).rowCount !== 1
      )
        throw new GatewayAccessError("GATEWAY_GRANT_CLOSED");
      return { ...message.grant_snapshot, token: unseal(message.encrypted_token, key, messageId), replayed: true };
    }
    const grant = await issueDelegationInTransaction(tx, p.actor, conversationId, messageId);
    const { token } = grant;
    const snapshot: GatewayGrantSnapshot = {
      requestId: grant.requestId,
      expiresAt: grant.expiresAt.toISOString(),
      conversation: { ...grant.conversation, updatedAt: grant.conversation.updatedAt.toISOString() },
      messages: grant.messages.map((message) => ({ ...message, createdAt: message.createdAt.toISOString() })),
    };
    await tx.query("UPDATE tennis.agent_delegations SET gateway_binding_id=$1 WHERE token_hash=$2", [
      p.bindingId,
      hash(token),
    ]);
    await tx.query(
      "UPDATE tennis.gateway_messages SET encrypted_token=$1,token_hash=$2,grant_snapshot=$3 WHERE id=$4",
      [seal(token, key, messageId), hash(token), JSON.stringify(snapshot), messageId],
    );
    return { ...snapshot, token, replayed: false };
  });
}
export async function completeGatewayMessage(
  db: pg.Pool,
  p: GatewayPrincipal,
  conversationId: string,
  messageId: string,
  input: { status: "SUCCEEDED" | "UNCERTAIN"; content?: string },
) {
  if (
    !["SUCCEEDED", "UNCERTAIN"].includes(input.status) ||
    (input.status === "SUCCEEDED" && !input.content?.trim()) ||
    (input.content?.length ?? 0) > 16000 ||
    (input.status === "UNCERTAIN" && input.content)
  )
    throw new GatewayAccessError("INVALID_GATEWAY_INPUT");
  const completionHash = hash(JSON.stringify({ status: input.status, content: input.content?.trim() ?? null }));
  return withBookingTransaction(db, p.actor, async (tx) => {
    const conv = await gatewayConversation(tx, p, conversationId),
      message = (
        await tx.query<{ generation: number; token_hash: string | null; completion_hash: string | null }>(
          "SELECT generation,token_hash,completion_hash FROM tennis.gateway_messages WHERE tenant_id=$1 AND binding_id=$2 AND conversation_id=$3 AND id=$4 FOR UPDATE",
          [p.actor.tenantId, p.bindingId, conversationId, messageId],
        )
      ).rows[0];
    if (!message) throw new TenantAccessError("RESOURCE_NOT_FOUND");
    if (message.completion_hash) {
      if (message.completion_hash !== completionHash) throw new GatewayAccessError("GATEWAY_MESSAGE_CONFLICT");
      return { messageId, status: input.status, duplicate: true };
    }
    if (!message.token_hash) throw new GatewayAccessError("GATEWAY_GRANT_CLOSED");
    if (input.status === "SUCCEEDED" && (conv.mode !== "AGENT" || conv.generation !== message.generation))
      throw new GatewayAccessError("GATEWAY_SCOPE_CHANGED");
    if (input.status === "SUCCEEDED")
      await tx.query(
        "INSERT INTO tennis.agent_messages(id,tenant_id,conversation_id,role,content) VALUES($1,$2,$3,'assistant',$4)",
        [`reply:${messageId}`, p.actor.tenantId, conversationId, input.content!.trim()],
      );
    await tx.query(
      "UPDATE tennis.agent_message_dispatches SET status=$1,updated_at=clock_timestamp() WHERE message_id=$2 AND tenant_id=$3",
      [input.status, messageId, p.actor.tenantId],
    );
    await tx.query("DELETE FROM tennis.agent_delegations WHERE token_hash=$1", [message.token_hash]);
    await tx.query("UPDATE tennis.gateway_messages SET completion_hash=$1,encrypted_token=NULL WHERE id=$2", [
      completionHash,
      messageId,
    ]);
    await tx.query("UPDATE tennis.agent_conversations SET updated_at=clock_timestamp() WHERE id=$1", [conversationId]);
    return { messageId, status: input.status, duplicate: false };
  });
}
export async function requireGatewayConversation(db: pg.Pool, p: GatewayPrincipal, id: string) {
  return withBookingTransaction(db, p.actor, (tx) => gatewayConversation(tx, p, id));
}
