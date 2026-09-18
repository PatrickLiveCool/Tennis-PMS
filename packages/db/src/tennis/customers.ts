import { randomUUID } from "node:crypto";
import type pg from "pg";
import {
  recordTenantAudit,
  requireTenantPermission,
  TenantAccessError,
  withTenantTransaction,
  type TenantActor,
} from "./access.ts";
import { lockTenantTransactions } from "./transaction-locks.ts";
import { assertDelegation } from "./agent-guard.ts";

export interface CustomerRecord {
  id: string;
  tenantId: string;
  nickname: string;
  phone: string | null;
  active: boolean;
}
export interface CustomerActor extends TenantActor {
  kind: "customer";
  customerId: string;
}
export type BookingActor = TenantActor | CustomerActor;
export function isCustomerActor(actor: BookingActor): actor is CustomerActor {
  return "kind" in actor && actor.kind === "customer";
}
export class TennisCustomerError extends Error {
  constructor(readonly code: "INVALID_CUSTOMER" | "PHONE_ALREADY_EXISTS") {
    super(code);
    this.name = "TennisCustomerError";
  }
}
function normalizedPhone(value?: string | null): string | null {
  if (!value?.trim()) return null;
  const compact = value.replace(/[\s()-]/g, "");
  const phone = /^1[3-9]\d{9}$/.test(compact) ? `+86${compact}` : compact;
  if (!/^\+[1-9]\d{6,14}$/.test(phone)) throw new TennisCustomerError("INVALID_CUSTOMER");
  return phone;
}
export async function createCustomer(
  db: pg.Pool,
  actor: TenantActor,
  input: { nickname: string; phone?: string | null },
): Promise<CustomerRecord> {
  if (!input.nickname.trim() || input.nickname.length > 200) throw new TennisCustomerError("INVALID_CUSTOMER");
  const phone = normalizedPhone(input.phone);
  try {
    return await withTenantTransaction(db, actor, async (tx) => {
      await requireTenantPermission(tx, actor, "manage_members");
      const id = randomUUID();
      await tx.query("INSERT INTO tennis.customers (id,tenant_id,nickname,phone) VALUES ($1,$2,$3,$4)", [
        id,
        actor.tenantId,
        input.nickname.trim(),
        phone,
      ]);
      await recordTenantAudit(tx, actor, "customer.create", id, { nickname: input.nickname.trim() });
      return { id, tenantId: actor.tenantId, nickname: input.nickname.trim(), phone, active: true };
    });
  } catch (error) {
    if ((error as { code?: string }).code === "23505") throw new TennisCustomerError("PHONE_ALREADY_EXISTS");
    throw error;
  }
}
export async function searchCustomers(db: pg.Pool, actor: TenantActor, query = ""): Promise<CustomerRecord[]> {
  return withTenantTransaction(db, actor, async (tx) => {
    // Customer profiles and money are tenant-wide; venue-only read grants are insufficient.
    await requireTenantPermission(tx, actor, "manage_members");
    const text = query.trim();
    return (
      await tx.query<CustomerRecord>(
        `SELECT id,tenant_id AS "tenantId",nickname,phone,active FROM tennis.customers
      WHERE tenant_id=$1 AND ($2='' OR strpos(lower(nickname),lower($2))>0 OR strpos(coalesce(phone,''),$2)>0)
      ORDER BY nickname,id LIMIT 100`,
        [actor.tenantId, text],
      )
    ).rows;
  });
}
export async function requireCustomer(
  tx: pg.PoolClient,
  actor: BookingActor,
  customerId: string,
): Promise<CustomerRecord> {
  if (isCustomerActor(actor) && actor.customerId !== customerId) throw new TenantAccessError("RESOURCE_NOT_FOUND");
  const result = await tx.query<CustomerRecord & { subjectId: string | null }>(
    `SELECT id,tenant_id AS "tenantId",nickname,phone,active,subject_id AS "subjectId"
    FROM tennis.customers WHERE tenant_id=$1 AND id=$2 AND active FOR SHARE`,
    [actor.tenantId, customerId],
  );
  const customer = result.rows[0];
  if (!customer || (isCustomerActor(actor) && customer.subjectId !== actor.subjectId))
    throw new TenantAccessError("RESOURCE_NOT_FOUND");
  return {
    id: customer.id,
    tenantId: customer.tenantId,
    nickname: customer.nickname,
    phone: customer.phone,
    active: customer.active,
  };
}
/** CustomerActor is built only after external/session authentication, never from request JSON. */
export async function withBookingTransaction<T>(
  pool: pg.Pool,
  actor: BookingActor,
  work: (tx: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    await lockTenantTransactions(tx, actor.tenantId);
    await assertDelegation(tx, actor);
    if (isCustomerActor(actor)) {
      const tenant = await tx.query("SELECT id FROM tennis.tenants WHERE id=$1 AND active FOR SHARE", [actor.tenantId]);
      if (tenant.rowCount !== 1) throw new TenantAccessError("TENANT_ACCESS_DENIED");
      await requireCustomer(tx, actor, actor.customerId);
    } else await requireTenantPermission(tx, actor, "read");
    const result = await work(tx);
    await tx.query("COMMIT");
    return result;
  } catch (error) {
    await tx.query("ROLLBACK");
    throw error;
  } finally {
    tx.release();
  }
}
