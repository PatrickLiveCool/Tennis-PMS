import { randomUUID } from "node:crypto";
import { parseBookingPhone, parseCustomerPhone } from "../../../domain/src/customer-contact.ts";
import type pg from "pg";
import {
  recordTenantAudit,
  requireTenantPermission,
  requireVenuePermission,
  TenantAccessError,
  withTenantTransaction,
  type TenantActor,
} from "./access.ts";
import { lockTenantTransactions } from "./transaction-locks.ts";
import { assertDelegation } from "./agent-guard.ts";
import { idempotentCommand } from "./receipts.ts";

export interface CustomerRecord {
  id: string;
  tenantId: string;
  nickname: string;
  phone: string | null;
  active: boolean;
  hasContact?: boolean;
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
  constructor(readonly code: "INVALID_CUSTOMER" | "PHONE_ALREADY_EXISTS" | "BOOKING_PHONE_REQUIRED" | "BOOKING_PHONE_ALREADY_SET") {
    super(code);
    this.name = "TennisCustomerError";
  }
}
export function normalizedPhone(value?: string | null): string | null {
  const phone = parseCustomerPhone(value);
  if (phone === undefined) throw new TennisCustomerError("INVALID_CUSTOMER");
  return phone;
}
/** Minimal booking identity only. No wallet, channel binding or profile-edit authority. */
export async function registerBookingCustomer(
  db: pg.Pool,
  actor: TenantActor,
  input: { venueId: string; commandKey: string; nickname: string; phone?: string | null },
) {
  if (!input.nickname.trim() || input.nickname.length > 200) throw new TennisCustomerError("INVALID_CUSTOMER");
  const phone = parseBookingPhone(input.phone);
  if (phone === undefined) throw new TennisCustomerError("INVALID_CUSTOMER");
  if (phone === null) throw new TennisCustomerError("BOOKING_PHONE_REQUIRED");
  return withBookingTransaction(db, actor, async (tx) => {
    if (isCustomerActor(actor)) throw new TenantAccessError("TENANT_ACCESS_DENIED");
    await requireVenuePermission(tx, actor, input.venueId, "book");
    return idempotentCommand(tx, actor, input.venueId, input.commandKey, "booking.customer",
      { nickname: input.nickname.trim(), phone }, async () => {
        const existing = phone ? (await tx.query<CustomerRecord>(
          `SELECT id,tenant_id AS "tenantId",nickname,phone,active FROM tennis.customers WHERE tenant_id=$1 AND phone=$2`,
          [actor.tenantId, phone],
        )).rows[0] : undefined;
        // Reuse requires an explicit selection in the UI, never merge by name or overwrite the profile.
        if (existing) throw new TennisCustomerError("PHONE_ALREADY_EXISTS");
        const id = randomUUID();
        await tx.query("INSERT INTO tennis.customers(id,tenant_id,nickname,phone) VALUES($1,$2,$3,$4)",
          [id, actor.tenantId, input.nickname.trim(), phone]);
        await recordTenantAudit(tx, actor, "booking.customer", id, { venueId: input.venueId });
        return { customerId: id, customer: { id, tenantId: actor.tenantId, nickname: input.nickname.trim(), phone: null, hasContact: Boolean(phone), active: true } };
      });
  }).catch((error: unknown) => {
    if ((error as { code?: string }).code === "23505") throw new TennisCustomerError("PHONE_ALREADY_EXISTS");
    throw error;
  });
}
/** Booking staff may supply a missing contact, never replace a contact or merge identities. */
export async function completeBookingCustomerContact(
  db: pg.Pool,
  actor: TenantActor,
  input: { venueId: string; customerId: string; commandKey: string; phone: string },
) {
  const phone = parseBookingPhone(input.phone);
  if (phone === undefined) throw new TennisCustomerError("INVALID_CUSTOMER");
  if (phone === null) throw new TennisCustomerError("BOOKING_PHONE_REQUIRED");
  return withBookingTransaction(db, actor, async (tx) => {
    if (isCustomerActor(actor)) throw new TenantAccessError("TENANT_ACCESS_DENIED");
    await requireVenuePermission(tx, actor, input.venueId, "book");
    const customer = await requireCustomer(tx, actor, input.customerId);
    return idempotentCommand(tx, actor, input.venueId, input.commandKey, "booking.customer",
      { customerId: input.customerId, phone }, async () => {
        if (customer.phone !== null) throw new TennisCustomerError("BOOKING_PHONE_ALREADY_SET");
        const existing = await tx.query(
          "SELECT id FROM tennis.customers WHERE tenant_id=$1 AND phone=$2",
          [actor.tenantId, phone],
        );
        if (existing.rowCount) throw new TennisCustomerError("PHONE_ALREADY_EXISTS");
        await tx.query("UPDATE tennis.customers SET phone=$3 WHERE tenant_id=$1 AND id=$2 AND phone IS NULL",
          [actor.tenantId, customer.id, phone]);
        await recordTenantAudit(tx, actor, "booking.customer.contact", customer.id, { venueId: input.venueId });
        return { customerId: customer.id, customer: { ...customer, phone: null, hasContact: true } };
      });
  }).catch((error: unknown) => {
    if ((error as { code?: string }).code === "23505") throw new TennisCustomerError("PHONE_ALREADY_EXISTS");
    throw error;
  });
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
