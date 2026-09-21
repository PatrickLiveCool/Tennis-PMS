import type pg from "pg";
import type { TenantActor } from "./access.ts";
import type { BookingActor } from "./customers.ts";
import { lockTenantTransactions } from "./transaction-locks.ts";

interface GatewayIdentity {
  integrationId: string;
  bindingId: string;
  tokenHash: string;
}
const bindings = new WeakMap<TenantActor, GatewayIdentity>();
export class GatewayAccessError extends Error {
  constructor(
    readonly code:
      | "GATEWAY_ACCESS_REVOKED"
      | "GATEWAY_IDENTITY_UNBOUND"
      | "GATEWAY_MESSAGE_CONFLICT"
      | "GATEWAY_SCOPE_CHANGED"
      | "GATEWAY_GRANT_CLOSED"
      | "INVALID_GATEWAY_INPUT",
  ) {
    super(code);
  }
}
/** Only call after resolving the hashed integration credential and manual binding. */
export function bindGatewayIdentity(actor: BookingActor, value: GatewayIdentity): void {
  bindings.set(actor, value);
}
async function assertBinding(
  tx: pg.PoolClient,
  actor: TenantActor,
  bindingId: string,
  integrationId?: string,
  tokenHash?: string,
) {
  await lockTenantTransactions(tx, actor.tenantId);
  const row = await tx.query(
    `SELECT b.id FROM tennis.gateway_bindings b
    JOIN tennis.gateway_integrations i ON i.tenant_id=b.tenant_id AND i.id=b.integration_id
    JOIN tennis.tenants t ON t.id=b.tenant_id
    WHERE b.tenant_id=$1 AND b.id=$2 AND b.subject_id=$3 AND b.active AND i.active AND t.active
      AND ($4::text IS NULL OR i.id=$4) AND ($5::text IS NULL OR i.token_hash=$5)
      AND b.actor_kind=$6 AND b.customer_id IS NOT DISTINCT FROM $7::text
      AND NOT EXISTS(SELECT 1 FROM tennis.local_accounts a WHERE a.subject_id=b.subject_id AND NOT a.active)
    FOR SHARE OF b,i,t`,
    [
      actor.tenantId,
      bindingId,
      actor.subjectId,
      integrationId ?? null,
      tokenHash ?? null,
      "kind" in actor && actor.kind === "customer" ? "customer" : "staff",
      "customerId" in actor ? actor.customerId : null,
    ],
  );
  if (row.rowCount !== 1) throw new GatewayAccessError("GATEWAY_ACCESS_REVOKED");
}
export async function assertGatewayIdentity(tx: pg.PoolClient, actor: TenantActor): Promise<void> {
  const value = bindings.get(actor);
  if (!value) return;
  await assertBinding(tx, actor, value.bindingId, value.integrationId, value.tokenHash);
}
export async function assertGatewayDelegation(tx: pg.PoolClient, actor: TenantActor, tokenHash: string): Promise<void> {
  const row = (
    await tx.query<{ bindingId: string | null }>(
      `SELECT gateway_binding_id AS "bindingId" FROM tennis.agent_delegations WHERE token_hash=$1 AND tenant_id=$2`,
      [tokenHash, actor.tenantId],
    )
  ).rows[0];
  if (row?.bindingId) await assertBinding(tx, actor, row.bindingId);
}
