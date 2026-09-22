import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, afterEach, beforeEach, expect, it } from "vitest";
import {
  assertLocalTennisDatabaseUrl,
  localTennisTestDatabaseUrl,
} from "../../packages/db/src/tennis/local-config.ts";
import { migrateTennis } from "../../packages/db/src/tennis/migrate.ts";
import {
  registerBookingCustomer,
  completeBookingCustomerContact,
  searchCustomers,
  createCustomer,
} from "../../packages/db/src/tennis/customers.ts";
import { getCommandReceipt } from "../../packages/db/src/tennis/booking.ts";
import { bookingCustomers } from "../../packages/db/src/tennis/views.ts";
import { seedTenantFixture, removeTenantFixture, type TenantFixture } from "./tenant-fixture.ts";
const db = new pg.Pool({
  connectionString: assertLocalTennisDatabaseUrl(localTennisTestDatabaseUrl, "test"),
  max: 8,
});
let fixture: TenantFixture, other: TenantFixture;
beforeAll(async () => {
  const tx = await db.connect();
  try {
    await migrateTennis(tx);
  } finally {
    tx.release();
  }
});
beforeEach(async () => {
  fixture = await seedTenantFixture(db);
  other = await seedTenantFixture(db);
  await db.query(
    "UPDATE tennis.tenant_memberships SET role='STAFF',permissions=ARRAY['read','book'],all_venues=false WHERE tenant_id=$1",
    [fixture.actor.tenantId],
  );
  await db.query("INSERT INTO tennis.membership_venues(tenant_id,subject_id,venue_id) VALUES($1,$2,$3)", [
    fixture.actor.tenantId,
    fixture.actor.subjectId,
    fixture.venueId,
  ]);
});
afterEach(async () => {
  await removeTenantFixture(db, fixture);
  await removeTenantFixture(db, other);
});
afterAll(() => db.end());
let phoneSerial = 0;
const input = (nickname = "临时客") => ({
  nickname,
  phone: `139${String(++phoneSerial).padStart(8, "0")}`,
  venueId: fixture.venueId,
  commandKey: randomUUID(),
});
async function legacyCustomer(tenant = fixture) {
  const id = randomUUID();
  await db.query("INSERT INTO tennis.customers(id,tenant_id,nickname) VALUES($1,$2,'待补手机号客户')", [id, tenant.actor.tenantId]);
  return id;
}
it("requires a mainland phone for new booking identities without leaving customers or receipts on failure", async () => {
  const request = input();
  const { phone: _phone, ...withoutPhone } = request;
  await expect(registerBookingCustomer(db, fixture.actor, withoutPhone)).rejects.toMatchObject({ code: "BOOKING_PHONE_REQUIRED" });
  for (const phone of [null, "", "   "])
    await expect(registerBookingCustomer(db, fixture.actor, { ...request, phone })).rejects.toMatchObject({ code: "BOOKING_PHONE_REQUIRED" });
  for (const phone of ["123", "1390000000", "139000000001", "+12025550123"])
    await expect(registerBookingCustomer(db, fixture.actor, { ...request, phone })).rejects.toMatchObject({ code: "INVALID_CUSTOMER" });
  expect(await getCommandReceipt(db, fixture.actor, request.commandKey)).toBeNull();
  expect((await db.query("SELECT id FROM tennis.customers WHERE tenant_id=$1", [fixture.actor.tenantId])).rowCount).toBe(0);
});
it("adds one missing phone with booking permission and atomically recovers concurrent identical requests", async () => {
  const customerId = await legacyCustomer();
  const request = { ...input(), customerId };
  const [one, two] = await Promise.all([
    completeBookingCustomerContact(db, fixture.actor, request),
    completeBookingCustomerContact(db, fixture.actor, request),
  ]);
  expect(one).toEqual(two);
  expect(one.customer).toMatchObject({ id: customerId, phone: null, hasContact: true });
  expect((await getCommandReceipt(db, fixture.actor, request.commandKey))?.result).toEqual(one);
  expect((await db.query("SELECT phone,nickname FROM tennis.customers WHERE id=$1", [customerId])).rows[0]).toEqual({ phone: `+86${request.phone}`, nickname: "待补手机号客户" });
  expect((await db.query("SELECT id FROM tennis.audit_events WHERE tenant_id=$1 AND action='booking.customer.contact'", [fixture.actor.tenantId])).rowCount).toBe(1);
  expect((await db.query("SELECT customer_id FROM tennis.wallet_accounts WHERE tenant_id=$1", [fixture.actor.tenantId])).rowCount).toBe(0);
  await expect(completeBookingCustomerContact(db, fixture.actor, { ...request, commandKey: randomUUID(), phone: "13700000001" })).rejects.toMatchObject({ code: "BOOKING_PHONE_ALREADY_SET" });
  await expect(registerBookingCustomer(db, fixture.actor, request)).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
});
it("does not merge duplicate contacts, replace numbers, or cross tenant and venue permissions", async () => {
  const owner = await registerBookingCustomer(db, fixture.actor, input());
  const customerId = await legacyCustomer();
  const foreignId = await legacyCustomer(other);
  const request = { ...input(), customerId };
  const phone = (await db.query("SELECT phone FROM tennis.customers WHERE id=$1", [owner.customerId])).rows[0].phone;
  await expect(completeBookingCustomerContact(db, fixture.actor, { ...request, phone })).rejects.toMatchObject({ code: "PHONE_ALREADY_EXISTS" });
  await expect(completeBookingCustomerContact(db, fixture.actor, { ...request, phone: "" })).rejects.toMatchObject({ code: "BOOKING_PHONE_REQUIRED" });
  await expect(completeBookingCustomerContact(db, fixture.actor, { ...request, phone: "+12025550123" })).rejects.toMatchObject({ code: "INVALID_CUSTOMER" });
  await expect(completeBookingCustomerContact(db, fixture.actor, { ...request, customerId: foreignId })).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
  await expect(completeBookingCustomerContact(db, fixture.actor, { ...request, venueId: other.venueId })).rejects.toBeTruthy();
  expect((await db.query("SELECT phone FROM tennis.customers WHERE id=$1", [customerId])).rows[0].phone).toBeNull();
  expect(await getCommandReceipt(db, fixture.actor, request.commandKey)).toBeNull();
  await db.query("UPDATE tennis.tenant_memberships SET permissions=ARRAY['read'] WHERE tenant_id=$1", [fixture.actor.tenantId]);
  await expect(completeBookingCustomerContact(db, fixture.actor, request)).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
});
it("books a minimal identity under venue book permission, with concurrent retry and receipt recovery", async () => {
  const request = input();
  const [one, two] = await Promise.all([
    registerBookingCustomer(db, fixture.actor, request),
    registerBookingCustomer(db, fixture.actor, request),
  ]);
  expect(one).toEqual(two);
  expect((await getCommandReceipt(db, fixture.actor, request.commandKey))?.result).toEqual(one);
  expect(
    (
      await db.query("SELECT count(*)::int AS count FROM tennis.customers WHERE tenant_id=$1", [
        fixture.actor.tenantId,
      ])
    ).rows[0].count,
  ).toBe(1);
  expect(
    (
      await db.query("SELECT count(*)::int AS count FROM tennis.wallet_accounts WHERE tenant_id=$1", [
        fixture.actor.tenantId,
      ])
    ).rows[0].count,
  ).toBe(0);
  await expect(searchCustomers(db, fixture.actor)).rejects.toMatchObject({
    code: "TENANT_ACCESS_DENIED",
  });
  await expect(createCustomer(db, fixture.actor, { nickname: "不能放宽权限" })).rejects.toMatchObject({
    code: "TENANT_ACCESS_DENIED",
  });
  await expect(
    registerBookingCustomer(db, fixture.actor, {
      ...request,
      nickname: "改变输入",
    }),
  ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
});
it("requires explicit reuse for same-tenant normalized phone, never merges names or tenants and hides contact", async () => {
  const one = await registerBookingCustomer(db, fixture.actor, {
    ...input(),
    phone: "13800138000",
  });
  await expect(
    registerBookingCustomer(db, fixture.actor, {
      ...input("另一称呼"),
      phone: "+86 13800138000",
    }),
  ).rejects.toMatchObject({ code: "PHONE_ALREADY_EXISTS" });
  const sameName = await registerBookingCustomer(db, fixture.actor, input());
  expect(sameName.customerId).not.toBe(one.customerId);
  const foreign = await registerBookingCustomer(db, other.actor, {
    ...input(),
    venueId: other.venueId,
    phone: "13800138000",
  });
  expect(foreign.customerId).not.toBe(one.customerId);
  expect(await bookingCustomers(db, fixture.actor, fixture.venueId, "13800138000")).toEqual([
    expect.objectContaining({
      id: one.customerId,
      phone: null,
      hasContact: true,
    }),
  ]);
});
it("enforces venue, tenant, current permission and customer context on creation and recovery", async () => {
  const request = input();
  await registerBookingCustomer(db, fixture.actor, request);
  await expect(
    registerBookingCustomer(db, fixture.actor, {
      ...input(),
      venueId: other.venueId,
    }),
  ).rejects.toBeTruthy();
  await expect(registerBookingCustomer(db, other.actor, input())).rejects.toBeTruthy();
  await db.query("UPDATE tennis.tenant_memberships SET permissions=ARRAY['read'] WHERE tenant_id=$1", [
    fixture.actor.tenantId,
  ]);
  await expect(registerBookingCustomer(db, fixture.actor, input())).rejects.toMatchObject({
    code: "TENANT_ACCESS_DENIED",
  });
  await expect(getCommandReceipt(db, fixture.actor, request.commandKey)).rejects.toMatchObject({
    code: "TENANT_ACCESS_DENIED",
  });
});
