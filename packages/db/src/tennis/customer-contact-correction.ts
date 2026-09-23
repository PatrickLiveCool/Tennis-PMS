import type pg from "pg";
import { parseBookingPhone, parseCustomerPhone } from "../../../domain/src/customer-contact.ts";
import { recordTenantAudit, requireVenuePermission, TenantAccessError, type TenantActor } from "./access.ts";
import { isCustomerActor, TennisCustomerError, withBookingTransaction, type CustomerRecord } from "./customers.ts";
import { idempotentCommand } from "./receipts.ts";

export class CustomerContactCorrectionError extends Error {
  constructor(readonly code: "INVALID_CONTACT_CORRECTION" | "STALE_CUSTOMER_CONTACT" | "CUSTOMER_CONTACT_UNCHANGED") {
    super(code);
    this.name = "CustomerContactCorrectionError";
  }
}
export interface CustomerContactCorrectionInput {
  venueId: string;
  customerId: string;
  commandKey: string;
  expectedPhone: string | null;
  phone: string;
  reason: string;
}
/** Contact correction cannot change customer, account, wallet or channel identity. */
export async function correctCustomerContact(db: pg.Pool, actor: TenantActor, input: CustomerContactCorrectionInput) {
  if (isCustomerActor(actor)) throw new TenantAccessError("TENANT_ACCESS_DENIED");
  const phone = parseBookingPhone(input.phone);
  const expectedPhone = parseCustomerPhone(input.expectedPhone);
  const reason = input.reason.trim();
  if (!phone || expectedPhone === undefined || !reason || reason.length > 2000)
    throw new CustomerContactCorrectionError("INVALID_CONTACT_CORRECTION");
  return withBookingTransaction(db, actor, async (tx) => {
    await requireVenuePermission(tx, actor, input.venueId, "manage_members");
    return idempotentCommand(tx, actor, input.venueId, input.commandKey, "customer.contact.correct",
      { customerId: input.customerId, expectedPhone, phone, reason }, async () => {
        const customer = (await tx.query<CustomerRecord>(
          `SELECT id,tenant_id AS "tenantId",nickname,phone,active FROM tennis.customers
           WHERE tenant_id=$1 AND id=$2 AND active FOR UPDATE`,
          [actor.tenantId, input.customerId],
        )).rows[0];
        if (!customer) throw new TenantAccessError("RESOURCE_NOT_FOUND");
        if (customer.phone !== expectedPhone) throw new CustomerContactCorrectionError("STALE_CUSTOMER_CONTACT");
        if (customer.phone === phone) throw new CustomerContactCorrectionError("CUSTOMER_CONTACT_UNCHANGED");
        const existing = await tx.query("SELECT id FROM tennis.customers WHERE tenant_id=$1 AND phone=$2 AND id<>$3",
          [actor.tenantId, phone, customer.id]);
        if (existing.rowCount) throw new TennisCustomerError("PHONE_ALREADY_EXISTS");
        await tx.query("UPDATE tennis.customers SET phone=$3 WHERE tenant_id=$1 AND id=$2", [actor.tenantId, customer.id, phone]);
        await recordTenantAudit(tx, actor, "customer.contact.correct", customer.id,
          { venueId: input.venueId, previousPhone: customer.phone, phone, reason });
        return { customerId: customer.id, customer: { ...customer, phone } };
      });
  }).catch((error: unknown) => {
    if ((error as { code?: string }).code === "23505") throw new TennisCustomerError("PHONE_ALREADY_EXISTS");
    throw error;
  });
}
