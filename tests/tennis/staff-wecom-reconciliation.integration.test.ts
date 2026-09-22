import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertLocalTennisDatabaseUrl, localTennisTestDatabaseUrl } from "../../packages/db/src/tennis/local-config.ts";
import { migrateTennis } from "../../packages/db/src/tennis/migrate.ts";
import { createCourt, createVenue, listVenues, setCourtPrice, updateVenue } from "../../packages/db/src/tennis/catalog.ts";
import { createCustomer, type BookingActor, type CustomerActor } from "../../packages/db/src/tennis/customers.ts";
import type { TenantActor, TenantPermission } from "../../packages/db/src/tennis/access.ts";
import { confirmQuote, createQuote, getCommandReceipt, getOrder } from "../../packages/db/src/tennis/booking.ts";
import { beginOrderPayment, getOrderPayment } from "../../packages/db/src/tennis/payments.ts";
import { beginTopupPayment, createTopupQuote, getTopupPayment } from "../../packages/db/src/tennis/topups.ts";
import { getWallet } from "../../packages/db/src/tennis/wallet.ts";
import { createConversation, getConversationRequest, handoffConversation, issueDelegation, resolveDelegation } from "../../packages/db/src/tennis/external-agent.ts";
import { LocalMockPaymentGateway } from "../../packages/db/src/tennis/mock-payments.ts";
import {
  TrustedWecomCollectionSource,
  ingestWecomCollection,
  linkStaffWecomReceipt,
  listStaffWecomPaymentTargets,
  listStaffWecomReceipts,
  simulateWecomReceipt,
  type WecomCollectionFacts,
} from "../../packages/db/src/tennis/wecom-reconciliation.ts";
import { buildTennisServer } from "../../apps/api/src/tennis/server.ts";
import { removeTenantFixture, seedTenantFixture, syntheticPhone, type TenantFixture } from "./tenant-fixture.ts";

const db = new pg.Pool({
  connectionString: assertLocalTennisDatabaseUrl(process.env.TENNIS_TEST_DATABASE_URL ?? localTennisTestDatabaseUrl, "test"),
  max: 8,
  connectionTimeoutMillis: 5000,
  statement_timeout: 10000,
});
const gateway = new LocalMockPaymentGateway("staff-wecom-reconciliation-synthetic-secret", "local-simulation");
const key = () => randomUUID();
const allPermissions: TenantPermission[] = ["read", "book", "manage_members", "reconcile_payments"];
let first: TenantFixture, second: TenantFixture, staff: TenantActor, customer: CustomerActor, courtId: string;
let extraSubjects: string[];
class FixtureSource extends TrustedWecomCollectionSource {
  certify(facts: WecomCollectionFacts) { return this.certifyCollection(facts); }
}

async function prepareCourt(venueId: string) {
  const venue = (await listVenues(db, first.actor)).find(v => v.id === venueId)!;
  await updateVenue(db, first.actor, {
    ...venue, expectedRevision: venue.catalogRevision, minimumBookingMinutes: 15,
    openingHours: Array.from({ length: 7 }, (_, weekday) => ({ weekday, startMinute: 480, endMinute: 1320 })),
  });
  const court = await createCourt(db, first.actor, {
    venueId, name: "员工收款验收球场", indoor: true, surface: "ACRYLIC",
    profile: { specification: "STANDARD" }, hourlyPriceCents: 12000,
  });
  await setCourtPrice(db, first.actor, { venueId, courtId: court.id, expectedRevision: court.revision, hourlyPriceCents: 12000 });
  return court.id;
}
async function permissions(values: TenantPermission[]) {
  await db.query("UPDATE tennis.tenant_memberships SET permissions=$3::text[] WHERE tenant_id=$1 AND subject_id=$2", [staff.tenantId, staff.subjectId, values]);
}
async function delegate(actor: BookingActor = staff, venueId = first.venueId, conversationId?: string) {
  const conversation = conversationId ?? (await createConversation(db, actor, venueId)).id;
  const grant = await issueDelegation(db, actor, conversation);
  const resolved = await resolveDelegation(db, grant.token);
  return { ...grant, actor: resolved.actor };
}
async function booking(hour = 19, venueId = first.venueId, targetCourtId = courtId, durationHours = 1) {
  const q = await createQuote(db, first.actor, {
    venueId, customerId: customer.customerId,
    lines: [{ courtId: targetCourtId, startAt: `2099-09-18T${hour}:00:00+08:00`, endAt: `2099-09-18T${hour + durationHours}:00:00+08:00` }],
  });
  return confirmQuote(db, first.actor, { quoteId: q.id, commandKey: key() });
}
async function payment(hour = 19, venueId = first.venueId, targetCourtId = courtId, durationHours = 1) {
  const order = await booking(hour, venueId, targetCourtId, durationHours);
  const pay = await beginOrderPayment(db, first.actor, gateway, { orderId: order.id, walletCents: 0, commandKey: key(), staffReason: "客户确认的合成收款" });
  const operationId = (await db.query<{ id: string }>("SELECT id FROM tennis.channel_operations WHERE tenant_id=$1 AND source_kind='ORDER' AND source_id=$2", [first.actor.tenantId, pay.id])).rows[0]!.id;
  return { order, pay, operationId };
}
async function topup() {
  const q = await createTopupQuote(db, first.actor, { venueId: first.venueId, customerId: customer.customerId, principalCents: 12000 });
  const pay = await beginTopupPayment(db, first.actor, gateway, { quoteId: q.id, commandKey: key() });
  const operationId = (await db.query<{ id: string }>("SELECT id FROM tennis.channel_operations WHERE tenant_id=$1 AND source_kind='TOPUP' AND source_id=$2", [first.actor.tenantId, pay.id])).rows[0]!.id;
  return { pay, operationId };
}
async function received(operationId: string) {
  return simulateWecomReceipt(db, first.actor, { operationId, referenceMode: "UNMATCHED", commandKey: key() }, { allowSimulation: true });
}
function linkInput(receiptId: string, operationId: string, commandKey = key()) {
  return { venueId: first.venueId, receiptId, operationId, reason: "工作人员已确认这笔流水归属此预约", commandKey };
}
async function commandRows(commandKey: string) {
  return (await db.query("SELECT command_type,result,completed_at FROM tennis.command_receipts WHERE tenant_id=$1 AND command_key=$2", [first.actor.tenantId, commandKey])).rows;
}
async function requestLinks(commandKey: string) {
  return (await db.query<{ request_id: string }>("SELECT request_id FROM tennis.agent_command_links WHERE tenant_id=$1 AND command_key=$2 ORDER BY request_id", [first.actor.tenantId, commandKey])).rows.map(r => r.request_id);
}

beforeAll(async () => {
  const tx = await db.connect();
  try { await migrateTennis(tx); } finally { tx.release(); }
});
beforeEach(async () => {
  extraSubjects = [];
  first = await seedTenantFixture(db);
  second = await seedTenantFixture(db);
  courtId = await prepareCourt(first.venueId);
  const profile = await createCustomer(db, first.actor, { nickname: "张先生合成收款客户", phone: syntheticPhone() });
  customer = { tenantId: first.actor.tenantId, subjectId: key(), kind: "customer", customerId: profile.id };
  staff = { tenantId: first.actor.tenantId, subjectId: key() };
  for (const actor of [customer, staff]) {
    await db.query("INSERT INTO tennis.subjects(id,display_name) VALUES($1,'synthetic reconciliation subject')", [actor.subjectId]);
    extraSubjects.push(actor.subjectId);
  }
  await db.query("UPDATE tennis.customers SET subject_id=$1 WHERE tenant_id=$2 AND id=$3", [customer.subjectId, customer.tenantId, customer.customerId]);
  await db.query("INSERT INTO tennis.tenant_memberships(tenant_id,subject_id,role,all_venues,permissions) VALUES($1,$2,'STAFF',true,$3::text[])", [staff.tenantId, staff.subjectId, allPermissions]);
});
afterEach(async () => {
  await removeTenantFixture(db, first);
  await removeTenantFixture(db, second);
  await db.query("DELETE FROM tennis.subjects WHERE id=ANY($1::text[])", [extraSubjects]);
});
afterAll(() => db.end());

describe("staff Agent WeCom reconciliation", () => {
  it("settles one authorized association once under concurrent retries and recovers it in a new Agent request", async () => {
    const p = await payment(), receipt = await received(p.operationId), grant = await delegate();
    const input = linkInput(receipt.id, p.operationId);
    const results = await Promise.all([linkStaffWecomReceipt(db, grant.actor, input), linkStaffWecomReceipt(db, grant.actor, input)]);
    expect(results.map(r => r.state)).toEqual(["LINKED", "LINKED"]);
    expect(results.every(r => r.id === receipt.id && r.linkedBy === staff.subjectId)).toBe(true);
    expect((await getOrder(db, first.actor, p.order.id)).status).toBe("CONFIRMED");
    expect((await getOrderPayment(db, first.actor, p.pay.id)).status).toBe("SUCCEEDED");
    const before = await commandRows(input.commandKey);
    expect(before).toEqual([expect.objectContaining({ command_type: "wecom.receipt.link", result: expect.objectContaining({ wecomReceiptId: receipt.id, orderId: p.order.id, paymentId: p.pay.id }) })]);
    expect(await requestLinks(input.commandKey)).toEqual([grant.requestId]);
    const retry = await delegate(staff, first.venueId, grant.conversation.id);
    expect((await linkStaffWecomReceipt(db, retry.actor, input)).id).toBe(receipt.id);
    expect(await commandRows(input.commandKey)).toEqual(before);
    expect(await requestLinks(input.commandKey)).toEqual([grant.requestId, retry.requestId].sort());
    expect((await db.query("SELECT 1 FROM tennis.channel_transactions WHERE tenant_id=$1", [first.actor.tenantId])).rowCount).toBe(1);
    expect((await db.query("SELECT 1 FROM tennis.audit_events WHERE tenant_id=$1 AND action='wecom.receipt.link' AND resource_id=$2", [first.actor.tenantId, receipt.id])).rowCount).toBe(1);
  });

  it("keeps two equal-amount receipts as candidates without guessing their owner", async () => {
    const a = await payment(18), b = await payment(19), grant = await delegate();
    const receipts = [await received(a.operationId), await received(b.operationId)];
    const page = await listStaffWecomReceipts(db, grant.actor, { venueId: first.venueId, amountCents: 12000, paidFrom: "2020-01-01T00:00:00Z", paidTo: "2100-01-01T00:00:00Z" });
    expect(page.items.map(r => r.id).sort()).toEqual(receipts.map(r => r.id).sort());
    expect(page.items.every(r => r.state === "UNMATCHED" && r.operationId === null)).toBe(true);
    expect((await listStaffWecomReceipts(db, grant.actor, { venueId: first.venueId, q: receipts[0]!.transactionId })).items.map(r => r.id)).toEqual([receipts[0]!.id]);
    expect((await listStaffWecomReceipts(db, grant.actor, { venueId: first.venueId, amountCents: 1 })).items).toEqual([]);
    const targets = await listStaffWecomPaymentTargets(db, grant.actor, { venueId: first.venueId, sourceKind: "ORDER", customerId: customer.customerId });
    expect(targets.items.map(t => t.operationId).sort()).toEqual([a.operationId, b.operationId].sort());
    expect((await listStaffWecomPaymentTargets(db, grant.actor, { venueId: first.venueId, sourceKind: "ORDER", orderId: a.order.id })).items.map(t => t.operationId)).toEqual([a.operationId]);
    expect((await db.query("SELECT 1 FROM tennis.channel_transactions WHERE tenant_id=$1", [first.actor.tenantId])).rowCount).toBe(0);
  });

  it("limits trusted REVIEW references to the current venue and business permission while retaining the unallocated pool", async () => {
    const otherVenue = await createVenue(db, first.actor, { name: "可信流水另一场馆", timezone: "Asia/Shanghai" });
    const otherCourt = await prepareCourt(otherVenue.id);
    const own = await payment(), elsewhere = await payment(19, otherVenue.id, otherCourt), member = await topup();
    const pool = await received(own.operationId), grant = await delegate();
    const reviewed = [];
    for (const target of [own, elsewhere, member]) {
      reviewed.push(await ingestWecomCollection(db, new FixtureSource().certify({
        tenantId: first.actor.tenantId, corporationId: `synthetic:${first.actor.tenantId}`,
        merchantId: target.pay.merchantId, transactionId: key(), provider: "MOCK", amountCents: 1,
        currency: "CNY", paidAt: "2026-09-20T12:00:00Z", simulation: true, trustedOperationId: target.operationId,
      })));
    }
    expect(reviewed.every(r => r.state === "REVIEW" && r.lastError === "WECOM_TARGET_MISMATCH")).toBe(true);
    const visible = async () => (await listStaffWecomReceipts(db, grant.actor, { venueId: first.venueId })).items.map(r => r.id).sort();
    expect(await visible()).toEqual([pool.id, reviewed[0]!.id, reviewed[2]!.id].sort());
    expect((await listStaffWecomReceipts(db, grant.actor, { venueId: first.venueId, q: reviewed[1]!.transactionId })).items).toEqual([]);
    await permissions(["read", "book", "reconcile_payments"]);
    expect(await visible()).toEqual([pool.id, reviewed[0]!.id].sort());
    await permissions(["read", "manage_members", "reconcile_payments"]);
    expect(await visible()).toEqual([pool.id, reviewed[2]!.id].sort());
    await permissions(["read", "reconcile_payments"]);
    expect(await visible()).toEqual([pool.id]);
    expect((await getOrderPayment(db, first.actor, own.pay.id)).status).toBe("PENDING");
    expect((await getOrderPayment(db, first.actor, elsewhere.pay.id)).status).toBe("PENDING");
    expect((await getTopupPayment(db, first.actor, member.pay.id)).status).toBe("PENDING");
    expect((await db.query("SELECT 1 FROM tennis.channel_transactions WHERE tenant_id=$1", [first.actor.tenantId])).rowCount).toBe(0);
  });

  it("paginates 51 authenticated receipts exactly once without skipping the second page", async () => {
    const p = await payment(), grant = await delegate(), ids: string[] = [];
    for (let i = 0; i < 51; i++) {
      ids.push((await ingestWecomCollection(db, new FixtureSource().certify({
        tenantId: first.actor.tenantId, corporationId: `synthetic:${first.actor.tenantId}`,
        merchantId: p.pay.merchantId, transactionId: key(), provider: "MOCK", amountCents: 12000,
        currency: "CNY", paidAt: "2026-09-20T12:00:00Z", simulation: true, trustedOperationId: null,
      }))).id);
    }
    const page1 = await listStaffWecomReceipts(db, grant.actor, { venueId: first.venueId, amountCents: 12000 });
    expect(page1.items).toHaveLength(50);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await listStaffWecomReceipts(db, grant.actor, { venueId: first.venueId, amountCents: 12000, cursor: page1.nextCursor! });
    expect(page2.items).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();
    const items = [...page1.items, ...page2.items];
    expect(items.map(r => r.id)).toEqual([...ids].reverse());
    expect(new Set(items.map(r => r.id)).size).toBe(51);
  });

  it("allows only one business to claim a receipt concurrently and rolls back the losing command", async () => {
    const p = await payment(), t = await topup(), receipt = await received(p.operationId), grant = await delegate();
    const inputs = [linkInput(receipt.id, p.operationId), linkInput(receipt.id, t.operationId)];
    const results = await Promise.allSettled(inputs.map(input => linkStaffWecomReceipt(db, grant.actor, input)));
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
    const loser = inputs[results.findIndex(r => r.status === "rejected")]!;
    expect(await commandRows(loser.commandKey)).toEqual([]);
    expect(await requestLinks(loser.commandKey)).toEqual([]);
    const orderPaid = (await getOrderPayment(db, first.actor, p.pay.id)).status === "SUCCEEDED";
    const walletPaid = (await getTopupPayment(db, first.actor, t.pay.id)).status === "SUCCEEDED";
    expect(orderPaid !== walletPaid).toBe(true);
    expect((await db.query("SELECT 1 FROM tennis.channel_transactions WHERE tenant_id=$1", [first.actor.tenantId])).rowCount).toBe(1);
  });

  it("rejects a reused command key with a different association before another settlement", async () => {
    const p = await payment(18), other = await payment(19), grant = await delegate();
    const a = await received(p.operationId), b = await received(other.operationId), commandKey = key();
    await linkStaffWecomReceipt(db, grant.actor, linkInput(a.id, p.operationId, commandKey));
    await expect(linkStaffWecomReceipt(db, grant.actor, linkInput(b.id, other.operationId, commandKey))).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    expect((await getOrderPayment(db, first.actor, other.pay.id)).status).toBe("PENDING");
    expect((await listStaffWecomReceipts(db, grant.actor, { venueId: first.venueId })).items.map(r => r.id)).toEqual([b.id]);
    expect(await commandRows(commandKey)).toHaveLength(1);
  });

  it("denies customers and employees without reconcile permission and requires book for order access", async () => {
    const p = await payment(), receipt = await received(p.operationId), input = linkInput(receipt.id, p.operationId);
    const customerGrant = await delegate(customer);
    for (const actor of [customer, customerGrant.actor]) {
      await expect(listStaffWecomReceipts(db, actor, { venueId: first.venueId })).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
      await expect(linkStaffWecomReceipt(db, actor, input)).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
    }
    const grant = await delegate();
    await permissions(["read", "book"]);
    await expect(listStaffWecomReceipts(db, grant.actor, { venueId: first.venueId })).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
    await expect(linkStaffWecomReceipt(db, grant.actor, input)).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
    await permissions(["read", "reconcile_payments"]);
    expect((await listStaffWecomReceipts(db, grant.actor, { venueId: first.venueId })).items).toHaveLength(1);
    await expect(listStaffWecomPaymentTargets(db, grant.actor, { venueId: first.venueId, sourceKind: "ORDER" })).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
    await expect(linkStaffWecomReceipt(db, grant.actor, input)).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
    expect(await commandRows(input.commandKey)).toEqual([]);
    expect((await getOrderPayment(db, first.actor, p.pay.id)).status).toBe("PENDING");
    await permissions(["book", "reconcile_payments"]);
    await expect(listStaffWecomReceipts(db, grant.actor, { venueId: first.venueId })).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
    await permissions(allPermissions);
    await linkStaffWecomReceipt(db, grant.actor, input);
    expect(await getCommandReceipt(db, grant.actor, input.commandKey)).toMatchObject({ result: { wecomReceiptId: receipt.id } });
    expect(await getConversationRequest(db, grant.actor, grant.conversation.id, grant.requestId)).toMatchObject({ commandCount: 1, restrictedCommandCount: 0 });
    await permissions(["read", "book"]);
    await expect(getCommandReceipt(db, grant.actor, input.commandKey)).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
    const restricted = await getConversationRequest(db, grant.actor, grant.conversation.id, grant.requestId);
    expect(restricted).toMatchObject({ commandCount: 1, restrictedCommandCount: 1, commands: [] });
    expect(JSON.stringify(restricted)).not.toContain(receipt.id);
    expect(JSON.stringify(restricted)).not.toContain(input.commandKey);
  });

  it("requires manage_members for top-up targets and credits the principal exactly once", async () => {
    const t = await topup(), receipt = await received(t.operationId), grant = await delegate();
    const input = linkInput(receipt.id, t.operationId);
    await permissions(["read", "book", "reconcile_payments"]);
    await expect(listStaffWecomPaymentTargets(db, grant.actor, { venueId: first.venueId, sourceKind: "TOPUP" })).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
    await expect(linkStaffWecomReceipt(db, grant.actor, input)).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
    await permissions(["read", "manage_members", "reconcile_payments"]);
    expect((await listStaffWecomPaymentTargets(db, grant.actor, { venueId: first.venueId, sourceKind: "TOPUP", operationId: t.operationId })).items.map(v => v.operationId)).toEqual([t.operationId]);
    await linkStaffWecomReceipt(db, grant.actor, input);
    await linkStaffWecomReceipt(db, grant.actor, input);
    expect((await getWallet(db, first.actor, customer.customerId)).balance.totalCents).toBe(12000);
    expect((await getTopupPayment(db, first.actor, t.pay.id)).status).toBe("SUCCEEDED");
    expect(await commandRows(input.commandKey)).toEqual([expect.objectContaining({ result: expect.objectContaining({ wecomReceiptId: receipt.id, topupId: t.pay.id }) })]);
  });

  it("isolates tenants and preserves the delegated venue even for staff with access to all venues", async () => {
    const otherVenue = await createVenue(db, first.actor, { name: "另一场馆", timezone: "Asia/Shanghai" });
    const otherCourt = await prepareCourt(otherVenue.id);
    const p = await payment(), other = await payment(19, otherVenue.id, otherCourt), receipt = await received(p.operationId), grant = await delegate();
    expect((await listStaffWecomReceipts(db, second.actor, { venueId: second.venueId })).items).toEqual([]);
    await expect(linkStaffWecomReceipt(db, second.actor, { ...linkInput(receipt.id, p.operationId), venueId: second.venueId })).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    await expect(listStaffWecomPaymentTargets(db, grant.actor, { venueId: otherVenue.id, sourceKind: "ORDER" })).rejects.toMatchObject({ code: "AGENT_SCOPE_DENIED" });
    await expect(linkStaffWecomReceipt(db, grant.actor, { ...linkInput(receipt.id, other.operationId), venueId: otherVenue.id })).rejects.toMatchObject({ code: "AGENT_SCOPE_DENIED" });
    await expect(linkStaffWecomReceipt(db, grant.actor, linkInput(receipt.id, other.operationId))).rejects.toBeInstanceOf(Error);
    expect((await getOrderPayment(db, first.actor, other.pay.id)).status).toBe("PENDING");
    await db.query("UPDATE tennis.tenant_memberships SET all_venues=false WHERE tenant_id=$1 AND subject_id=$2", [staff.tenantId, staff.subjectId]);
    await db.query("INSERT INTO tennis.membership_venues(tenant_id,subject_id,venue_id) VALUES($1,$2,$3)", [staff.tenantId, staff.subjectId, otherVenue.id]);
    await expect(listStaffWecomReceipts(db, grant.actor, { venueId: first.venueId })).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
  });

  it.each(["permissions", "handoff"])("rechecks %s changed after preflight inside the settlement transaction", async kind => {
    const p = await payment(), receipt = await received(p.operationId), grant = await delegate();
    const input = linkInput(receipt.id, p.operationId);
    // Change authority after preflight commits but before settlement obtains its client.
    // No mock payment facts or wall-clock delays are involved in this race.
    let connections = 0;
    const racedDb = new Proxy(db, {
      get(target, property) {
        if (property === "connect") return async () => {
          if (++connections === 2) {
            if (kind === "permissions") await permissions(["read", "book"]);
            else await handoffConversation(db, first.actor, grant.conversation.id, { mode: "HUMAN", reason: "人工接管收款核对" });
          }
          return target.connect();
        };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const code = kind === "permissions" ? "TENANT_ACCESS_DENIED" : "AGENT_DELEGATION_REVOKED";
    await expect(linkStaffWecomReceipt(racedDb, grant.actor, input)).rejects.toMatchObject({ code });
    expect(connections).toBe(2);
    expect((await getOrderPayment(db, first.actor, p.pay.id)).status).toBe("PENDING");
    expect(await commandRows(input.commandKey)).toEqual([]);
    expect(await requestLinks(input.commandKey)).toEqual([]);
  });

  it("does not manufacture paid money or command history when the selected amount is wrong", async () => {
    const small = await payment(17), large = await payment(19, first.venueId, courtId, 2);
    const receipt = await received(small.operationId), grant = await delegate(), input = linkInput(receipt.id, large.operationId);
    await expect(linkStaffWecomReceipt(db, grant.actor, input)).rejects.toMatchObject({ code: "WECOM_TARGET_MISMATCH" });
    expect((await getOrderPayment(db, first.actor, large.pay.id)).status).toBe("PENDING");
    expect((await listStaffWecomReceipts(db, grant.actor, { venueId: first.venueId })).items[0]).toMatchObject({ id: receipt.id, state: "UNMATCHED", operationId: null });
    expect(await commandRows(input.commandKey)).toEqual([]);
    expect(await requestLinks(input.commandKey)).toEqual([]);
    expect((await db.query("SELECT 1 FROM tennis.channel_transactions WHERE tenant_id=$1", [first.actor.tenantId])).rowCount).toBe(0);
  });

  it("records a late receipt as an exception without reclaiming the replacement booking", async () => {
    const p = await payment(), receipt = await received(p.operationId), grant = await delegate();
    await db.query("UPDATE tennis.orders SET hold_until=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND id=$2", [first.actor.tenantId, p.order.id]);
    const replacement = await booking();
    const input = linkInput(receipt.id, p.operationId);
    expect((await linkStaffWecomReceipt(db, grant.actor, input)).state).toBe("EXCEPTION");
    expect((await getOrderPayment(db, first.actor, p.pay.id)).status).toBe("REFUND_REQUIRED");
    expect((await getOrder(db, first.actor, replacement.id)).status).toBe("HELD");
    expect((await db.query("SELECT 1 FROM tennis.financial_exceptions WHERE tenant_id=$1 AND payment_id=$2", [first.actor.tenantId, p.pay.id])).rowCount).toBe(1);
    expect(await commandRows(input.commandKey)).toHaveLength(1);
  });

  it("exposes scoped Bearer tools and rejects customer access, forged scope and self-reported money", async () => {
    const p = await payment(), receipt = await received(p.operationId), grant = await delegate(), customerGrant = await delegate(customer);
    const foreign = await delegate(second.actor, second.venueId);
    const app = await buildTennisServer({ db, gateway, allowSimulation: true, aiEncryptionKey: Buffer.alloc(32, 9), runExpiryWorker: false });
    const headers = { authorization: `Bearer ${grant.token}` };
    const linkUrl = `/api/tennis/agent/wecom/receipts/${receipt.id}/link`;
    const payload = { operationId: p.operationId, reason: "工作人员已核实付款人和预约", commandKey: key() };
    try {
      for (const url of ["/api/tennis/agent/wecom/receipts", "/api/tennis/agent/wecom/payment-targets?sourceKind=ORDER"]) {
        const response = await app.inject({ url, headers });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json().items).toHaveLength(1);
        expect((await app.inject({ url, headers: { authorization: `Bearer ${customerGrant.token}` } })).statusCode).toBe(403);
        expect((await app.inject({ url: `${url}${url.includes("?") ? "&" : "?"}tenantId=${second.actor.tenantId}`, headers })).statusCode).toBe(400);
        expect((await app.inject({ url: `${url}${url.includes("?") ? "&" : "?"}venueId=${second.venueId}`, headers })).statusCode).toBe(400);
      }
      expect((await app.inject({ method: "POST", url: linkUrl, payload })).statusCode).toBeGreaterThanOrEqual(400);
      expect((await app.inject({ method: "POST", url: linkUrl, headers: { authorization: `Bearer ${customerGrant.token}` }, payload })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url: linkUrl, headers: { authorization: `Bearer ${foreign.token}` }, payload })).statusCode).toBe(404);
      for (const extra of [{ tenantId: second.actor.tenantId }, { venueId: second.venueId }, { amountCents: 12000 }, { state: "SUCCEEDED" }]) {
        expect((await app.inject({ method: "POST", url: linkUrl, headers, payload: { ...payload, ...extra } })).statusCode).toBe(400);
      }
      expect((await getOrderPayment(db, first.actor, p.pay.id)).status).toBe("PENDING");
      const linked = await app.inject({ method: "POST", url: linkUrl, headers, payload });
      expect(linked.statusCode, linked.body).toBe(200);
      expect(linked.json()).toMatchObject({ id: receipt.id, state: "LINKED" });
      expect((await app.inject({ url: "/api/tennis/agent/wecom/receipts", headers })).json().items).toEqual([]);
    } finally { await app.close(); }
  });
});
