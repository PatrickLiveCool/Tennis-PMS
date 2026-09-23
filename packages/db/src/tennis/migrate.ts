import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type pg from "pg";

/** Dedicated migration history: never invokes the upstream housing migrations. */
export async function migrateTennis(client: pg.PoolClient): Promise<void> {
  const migrations = await Promise.all(
    [
      "001_court_inventory.sql",
      "002_quarter_hour_inventory.sql",
      "003_tenant_assets.sql",
      "004_catalog_pricing.sql",
      "005_quotes_orders.sql",
      "006_wallet_payments.sql",
      "007_order_refunds.sql",
      "008_online_topups.sql",
      "009_auth_sessions.sql",
      "010_external_agent.sql",
      "011_order_amendments.sql",
      "012_agent_dispatches.sql",
      "013_agent_message_feedback.sql",
      "014_unpaid_order_amendments.sql",
      "015_agent_command_links.sql",
      "016_gateway_identity.sql",
      "017_business_events.sql",
      "018_payment_merchants.sql",
      "019_channel_operations.sql",
      "020_exception_refunds.sql",
      "021_operator_context.sql",
      "022_topup_directory.sql",
      "023_booking_policy.sql",
      "024_backoffice_assistant.sql",
      "025_wecom_reconciliation.sql",
      "026_court_surface.sql",
      "027_court_profile.sql",
      "028_reconcile_payments_permission.sql",
      "029_gateway_management.sql",
      "030_ai_question_records.sql",
    ].map(async (name) => {
      const sql = await readFile(new URL(`./migrations/${name}`, import.meta.url), "utf8");
      return {
        name,
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
      };
    }),
  );
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('tennis:migrate', 0))");
    await client.query(`CREATE TABLE IF NOT EXISTS public.tennis_schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied = await client.query<{ name: string; checksum: string }>(
      "SELECT name, checksum FROM public.tennis_schema_migrations ORDER BY name",
    );
    if (
      applied.rows.length > migrations.length ||
      applied.rows.some((row, index) => {
        const expected = migrations[index];
        return !expected || row.name !== expected.name || row.checksum !== expected.checksum;
      })
    ) {
      throw new Error("Tennis migration history or checksum mismatch");
    }
    for (const migration of migrations.slice(applied.rows.length)) {
      await client.query(migration.sql);
      await client.query("INSERT INTO public.tennis_schema_migrations (name, checksum) VALUES ($1, $2)", [
        migration.name,
        migration.checksum,
      ]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
