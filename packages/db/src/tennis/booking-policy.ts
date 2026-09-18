import type pg from "pg";
import { recordTenantAudit, requireTenantPermission, TenantAccessError, withTenantTransaction, type TenantActor } from "./access.ts";
import { TennisCatalogError } from "./catalog.ts";
import { isCustomerActor, withBookingTransaction } from "./customers.ts";

export interface BookingPolicy {
  quoteMinutes: number;
  paymentHoldMinutes: number;
  revision: number;
}
/** Internal reader: caller has authenticated the tenant in its transaction. No lazy writes on reads. */
export async function bookingPolicyInTransaction(tx: pg.PoolClient, tenantId: string): Promise<BookingPolicy> {
  const row = (await tx.query<BookingPolicy>(
    `SELECT quote_minutes AS "quoteMinutes",payment_hold_minutes AS "paymentHoldMinutes",revision
     FROM tennis.booking_policies WHERE tenant_id=$1`, [tenantId],
  )).rows[0];
  return row ?? { quoteMinutes: 5, paymentHoldMinutes: 10, revision: 1 };
}
async function requireAdmin(tx: pg.PoolClient, actor: TenantActor): Promise<void> {
  if (isCustomerActor(actor)) throw new TenantAccessError("TENANT_ACCESS_DENIED");
  await requireTenantPermission(tx, actor, "manage_assets");
  if (!(await tx.query(
    "SELECT 1 FROM tennis.tenant_memberships WHERE tenant_id=$1 AND subject_id=$2 AND role='ADMIN'",
    [actor.tenantId, actor.subjectId],
  )).rowCount) throw new TenantAccessError("TENANT_ACCESS_DENIED");
}
export async function getBookingPolicy(db: pg.Pool, actor: TenantActor): Promise<BookingPolicy> {
  return withTenantTransaction(db, actor, async (tx) => {
    await requireAdmin(tx, actor);
    return bookingPolicyInTransaction(tx, actor.tenantId);
  });
}
export async function saveBookingPolicy(
  db: pg.Pool, actor: TenantActor,
  input: { quoteMinutes: number; paymentHoldMinutes: number; expectedRevision: number },
): Promise<BookingPolicy> {
  if (![input.quoteMinutes, input.paymentHoldMinutes].every((n) => Number.isInteger(n) && n >= 1 && n <= 1440) ||
    !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)
    throw new TennisCatalogError("INVALID_CONFIGURATION");
  // Same tenant lock order as quote/order/amendment creation; never upgrade a shared tenant row lock.
  return withBookingTransaction(db, actor, async (tx) => {
    await requireAdmin(tx, actor);
    const before = await bookingPolicyInTransaction(tx, actor.tenantId);
    if (before.revision !== input.expectedRevision) throw new TennisCatalogError("STALE_CONFIGURATION");
    const after = (await tx.query<BookingPolicy>(
      `INSERT INTO tennis.booking_policies(tenant_id,quote_minutes,payment_hold_minutes,revision) VALUES($1,$2,$3,$4)
       ON CONFLICT(tenant_id) DO UPDATE SET quote_minutes=excluded.quote_minutes,
         payment_hold_minutes=excluded.payment_hold_minutes,revision=excluded.revision
       RETURNING quote_minutes AS "quoteMinutes",payment_hold_minutes AS "paymentHoldMinutes",revision`,
      [actor.tenantId, input.quoteMinutes, input.paymentHoldMinutes, before.revision + 1],
    )).rows[0]!;
    await recordTenantAudit(tx, actor, "booking-policy.save", actor.tenantId, { before, after });
    return after;
  });
}
