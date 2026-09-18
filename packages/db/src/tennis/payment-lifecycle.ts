import type pg from "pg";
import { recordTenantAudit } from "./access.ts";
import { settleWalletReservation } from "./wallet-store.ts";

/** Called only after tenant, venue and order locks; never claims external funds were refunded. */
export async function releasePendingPayments(
  tx: pg.PoolClient,
  tenantId: string,
  orderId: string,
  status: "EXPIRED" | "CANCELLED",
): Promise<void> {
  const pending = await tx.query<{ id: string; customer_id: string }>(
    "SELECT id,customer_id FROM tennis.payment_attempts WHERE tenant_id=$1 AND order_id=$2 AND status='PENDING' ORDER BY id FOR UPDATE",
    [tenantId, orderId],
  );
  for (const payment of pending.rows) {
    await settleWalletReservation(tx, tenantId, payment.customer_id, payment.id, false);
    await tx.query("UPDATE tennis.payment_attempts SET status=$1 WHERE tenant_id=$2 AND id=$3", [
      status,
      tenantId,
      payment.id,
    ]);
    await recordTenantAudit(tx, { tenantId, subjectId: "system:tennis" }, "payment.release", payment.id, {
      orderId,
      status,
    });
  }
}
