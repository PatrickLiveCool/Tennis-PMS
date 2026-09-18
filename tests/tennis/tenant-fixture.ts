import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { TenantActor } from "../../packages/db/src/tennis/access.ts";

export interface TenantFixture {
  actor: TenantActor;
  venueId: string;
}
export async function seedTenantFixture(db: pg.Pool): Promise<TenantFixture> {
  const actor = { tenantId: randomUUID(), subjectId: randomUUID() };
  const venueId = randomUUID();
  const tx = await db.connect();
  try {
    await tx.query("BEGIN");
    await tx.query("INSERT INTO tennis.subjects (id, display_name) VALUES ($1, 'synthetic operator')", [
      actor.subjectId,
    ]);
    await tx.query("INSERT INTO tennis.tenants (id, name) VALUES ($1, 'synthetic tenant')", [actor.tenantId]);
    await tx.query("INSERT INTO tennis.tenant_memberships (tenant_id, subject_id, role) VALUES ($1, $2, 'ADMIN')", [
      actor.tenantId,
      actor.subjectId,
    ]);
    await tx.query("INSERT INTO tennis.venues (id, tenant_id, name) VALUES ($1, $2, 'synthetic venue')", [
      venueId,
      actor.tenantId,
    ]);
    await tx.query("COMMIT");
  } catch (error) {
    await tx.query("ROLLBACK");
    throw error;
  } finally {
    tx.release();
  }
  return { actor, venueId };
}

export async function removeTenantFixture(db: pg.Pool, fixture: TenantFixture): Promise<void> {
  const tx = await db.connect();
  try {
    await tx.query("BEGIN");
    for (const table of [
      "cash_refund_transactions",
      "exception_refund_events",
      "mock_channel_records",
      "channel_observations",
      "channel_operations",
      "exception_refunds",
      "auth_audit_events",
      "payment_merchant_bindings",
      "gateway_messages",
      "gateway_conversations",
      "agent_delegations",
      "gateway_bindings",
      "gateway_integrations",
      "agent_command_links",
      "agent_requests",
      "command_receipts",
      "audit_events",
      "topup_events",
      "topup_exceptions",
      "topup_payments",
      "topup_quotes",
      "topup_offers",
      "channel_transactions",
      "refund_events",
      "external_refund_receipts",
      "refund_wallet_allocations",
      "refund_lines",
      "refunds",
      "refund_groups",
      "wallet_entries",
      "wallet_allocations",
      "payment_events",
      "external_payment_receipts",
      "financial_exceptions",
      "payment_attempts",
      "wallet_batches",
      "wallet_accounts",
      "order_amendment_lines",
      "occupancies",
      "order_amendments",
      "order_lines",
      "orders",
      "quotes",
      "customers",
      "discount_rule_courts",
      "discount_rules",
      "courts",
      "membership_venues",
      "venues",
      "tenant_memberships",
    ]) {
      // The table names are static internal constants; values remain parameterized.
      await tx.query(`DELETE FROM tennis.${table} WHERE tenant_id = $1`, [fixture.actor.tenantId]);
    }
    await tx.query("DELETE FROM tennis.tenants WHERE id = $1", [fixture.actor.tenantId]);
    await tx.query("DELETE FROM tennis.subjects WHERE id = $1", [fixture.actor.subjectId]);
    await tx.query("COMMIT");
  } catch (error) {
    await tx.query("ROLLBACK");
    throw error;
  } finally {
    tx.release();
  }
}
