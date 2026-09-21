import type pg from "pg";

/** MVP tenant-wide transaction lock prevents cross-venue expiry/wallet lock inversions. */
export async function lockTenantTransactions(tx: pg.PoolClient, tenantId: string): Promise<void> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`tennis:transactions:${tenantId}`]);
}
