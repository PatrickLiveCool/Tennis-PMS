import type pg from "pg";
import type { TenantActor } from "./access.ts";
import { lockTenantTransactions } from "./transaction-locks.ts";

interface Delegation {
  tokenHash: string;
  conversationId: string;
  venueId: string;
  generation: number;
}
const bindings = new WeakMap<TenantActor, Delegation>();
export class AgentAccessError extends Error {
  constructor(
    readonly code:
      | "AGENT_DELEGATION_REVOKED"
      | "AGENT_SCOPE_DENIED"
      | "ASSISTANT_NOT_CONFIGURED"
      | "ASSISTANT_UNAVAILABLE"
      | "ASSISTANT_RESULT_UNKNOWN"
      | "ASSISTANT_BUSY"
      | "INVALID_AGENT_CONFIG"
      | "HUMAN_HANDOFF_ACTIVE"
      | "STALE_CONFIGURATION"
      | "INVALID_AGENT_MESSAGE",
  ) {
    super(code);
  }
}
/** Called only by the verified bearer-token resolver, never on request-body actors. */
export function bindDelegation(actor: TenantActor, delegation: Delegation): void {
  bindings.set(actor, delegation);
}
/** Handoff and business writes serialize on the same tenant transaction lock. */
export async function assertDelegation(tx: pg.PoolClient, actor: TenantActor, venueId?: string): Promise<void> {
  const bound = bindings.get(actor);
  if (!bound) return;
  if (venueId && venueId !== bound.venueId) throw new AgentAccessError("AGENT_SCOPE_DENIED");
  await lockTenantTransactions(tx, actor.tenantId);
  const valid = await tx.query(
    `SELECT c.id FROM tennis.agent_delegations d
    JOIN tennis.agent_conversations c ON c.tenant_id=d.tenant_id AND c.id=d.conversation_id
    WHERE d.token_hash=$1 AND d.tenant_id=$2 AND c.id=$3 AND c.subject_id=$4 AND c.venue_id=$5
    AND d.generation=$6 AND c.generation=d.generation AND c.mode='AGENT' AND d.expires_at>clock_timestamp()
    AND NOT EXISTS (SELECT 1 FROM tennis.local_accounts a WHERE a.subject_id=c.subject_id AND NOT a.active)
    FOR SHARE OF d,c`,
    [bound.tokenHash, actor.tenantId, bound.conversationId, actor.subjectId, bound.venueId, bound.generation],
  );
  if (valid.rowCount !== 1) throw new AgentAccessError("AGENT_DELEGATION_REVOKED");
}
