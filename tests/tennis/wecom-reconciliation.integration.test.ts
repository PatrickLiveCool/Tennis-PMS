import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertLocalTennisDatabaseUrl, localTennisTestDatabaseUrl } from "../../packages/db/src/tennis/local-config.ts";
import { migrateTennis } from "../../packages/db/src/tennis/migrate.ts";
import { createCourt, listVenues, setCourtPrice, updateVenue } from "../../packages/db/src/tennis/catalog.ts";
import { createCustomer } from "../../packages/db/src/tennis/customers.ts";
import { confirmQuote, createQuote, getOrder } from "../../packages/db/src/tennis/booking.ts";
import { beginOrderPayment, getOrderPayment, settleVerifiedPayment } from "../../packages/db/src/tennis/payments.ts";
import { getWallet, recordOfflineTopup } from "../../packages/db/src/tennis/wallet.ts";
import { beginTopupPayment, createTopupQuote, getTopupPayment } from "../../packages/db/src/tennis/topups.ts";
import { LocalMockPaymentGateway } from "../../packages/db/src/tennis/mock-payments.ts";
import { TrustedWecomCollectionSource, ingestWecomCollection, linkWecomReceipt, listWecomPaymentTargets, listWecomReceipts, simulateWecomReceipt, type WecomCollectionFacts } from "../../packages/db/src/tennis/wecom-reconciliation.ts";
import { buildTennisServer } from "../../apps/api/src/tennis/server.ts";
import { createLocalAccount, type SessionView } from "../../packages/db/src/tennis/auth.ts";
import { removeTenantFixture, seedTenantFixture, syntheticPhone, type TenantFixture } from "./tenant-fixture.ts";
const db = new pg.Pool({ connectionString: assertLocalTennisDatabaseUrl(process.env.TENNIS_TEST_DATABASE_URL ?? localTennisTestDatabaseUrl, "test"), max: 8, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
const gateway = new LocalMockPaymentGateway("wecom-synthetic-reconciliation-test-secret", "local-simulation");
const key = () => randomUUID();
const simulation = { allowSimulation: true };
const accountSubjects: string[] = [];
let first: TenantFixture, second: TenantFixture, courtId: string, customerId: string;
class FixtureSource extends TrustedWecomCollectionSource { certify(f: WecomCollectionFacts) { return this.certifyCollection(f); } }
async function booking(hour = 19) {
  const q = await createQuote(db, first.actor, { venueId: first.venueId, customerId, lines: [{ courtId, startAt: `2099-09-18T${hour}:00:00+08:00`, endAt: `2099-09-18T${hour + 1}:00:00+08:00` }] });
  return confirmQuote(db, first.actor, { quoteId: q.id, commandKey: key() });
}
async function payment(hour = 19, walletCents = 0) {
  const order = await booking(hour);
  const pay = await beginOrderPayment(db, first.actor, gateway, { orderId: order.id, walletCents, commandKey: key(), staffReason: "客户确认的合成交易" });
  const operationId = (await db.query<{ id: string }>(`SELECT id FROM tennis.channel_operations WHERE tenant_id=$1 AND source_kind='ORDER' AND source_id=$2`, [first.actor.tenantId, pay.id])).rows[0]!.id;
  return { pay, order, operationId };
}
async function topup() {
  const q = await createTopupQuote(db, first.actor, { venueId: first.venueId, customerId, principalCents: 12000 });
  const pay = await beginTopupPayment(db, first.actor, gateway, { quoteId: q.id, commandKey: key() });
  const operationId = (await db.query<{ id: string }>(`SELECT id FROM tennis.channel_operations WHERE tenant_id=$1 AND source_kind='TOPUP' AND source_id=$2`, [first.actor.tenantId, pay.id])).rows[0]!.id;
  return { pay, operationId };
}
async function credit() { return recordOfflineTopup(db, first.actor, { venueId: first.venueId, customerId, principalCents: 10000, giftCents: 2000, receiptReference: key(), reason: "合成线下充值", commandKey: key() }); }
function syntheticFacts(op: { pay: { merchantId: string; externalCents: number }; operationId: string }, overrides: Partial<WecomCollectionFacts> = {}) {
  return new FixtureSource().certify({ tenantId: first.actor.tenantId, corporationId: "synthetic-corporation", merchantId: op.pay.merchantId, transactionId: key(), provider: "MOCK", amountCents: op.pay.externalCents, currency: "CNY", paidAt: "2026-09-20T12:00:00Z", simulation: true, trustedOperationId: op.operationId, ...overrides });
}
beforeAll(async () => { const tx = await db.connect(); try { await migrateTennis(tx); } finally { tx.release(); } });
beforeEach(async () => {
  first = await seedTenantFixture(db); second = await seedTenantFixture(db);
  const venue = (await listVenues(db, first.actor))[0]!;
  await updateVenue(db, first.actor, { ...venue, expectedRevision: venue.catalogRevision, minimumBookingMinutes: 15,
    openingHours: Array.from({ length: 7 }, (_, weekday) => ({ weekday, startMinute: 480, endMinute: 1320 })) });
  const court = await createCourt(db, first.actor, { venueId: first.venueId, name: "企微合成验收球场", indoor: true, surface: "ACRYLIC", profile: { specification: "STANDARD" }, hourlyPriceCents: 12000 });
  courtId = court.id;
  await setCourtPrice(db, first.actor, { venueId: first.venueId, courtId, expectedRevision: court.revision, hourlyPriceCents: 12000 });
  customerId = (await createCustomer(db, first.actor, { nickname: "合成收款客户", phone: syntheticPhone() })).id;
});
afterEach(async () => {
  await db.query("DELETE FROM tennis.auth_sessions WHERE subject_id=ANY($1::text[])", [accountSubjects]);
  await db.query("DELETE FROM tennis.auth_audit_events WHERE subject_id=ANY($1::text[])", [accountSubjects]);
  await db.query("DELETE FROM tennis.local_accounts WHERE subject_id=ANY($1::text[])", [accountSubjects]);
  for (const f of [first, second]) if (f) {
    await db.query(`DELETE FROM tennis.wecom_receipts WHERE tenant_id=$1`, [f.actor.tenantId]);
    await removeTenantFixture(db, f);
  }
  await db.query("DELETE FROM tennis.subjects WHERE id=ANY($1::text[])", [accountSubjects.splice(0)]);
});
afterAll(async () => { await db.end(); });

describe("authenticated WeCom collection reconciliation", () => {
  it("automatically confirms an exact collection and settles a mixed wallet payment once after response-loss retries", async () => {
    await credit(); const p = await payment(19, 6000);
    const request = { operationId: p.operationId, referenceMode: "EXACT" as const, commandKey: key() };
    const [a, b] = await Promise.all([simulateWecomReceipt(db, first.actor, request, simulation), simulateWecomReceipt(db, first.actor, request, simulation)]);
    expect(a.id).toBe(b.id); expect(a.state).toBe("LINKED");
    expect((await getOrder(db, first.actor, p.order.id)).status).toBe("CONFIRMED");
    expect((await getOrderPayment(db, first.actor, p.pay.id)).status).toBe("SUCCEEDED");
    expect((await getWallet(db, first.actor, customerId)).balance.totalCents).toBe(6000);
    expect((await listWecomReceipts(db, first.actor)).items).toHaveLength(1);
    const audit = (await db.query<{ subject_id: string; details: { automatic: boolean; source: string } }>(`SELECT subject_id,details FROM tennis.audit_events WHERE tenant_id=$1 AND action='wecom.receipt.link' AND resource_id=$2`, [first.actor.tenantId, a.id])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ subject_id: "system:tennis", details: { automatic: true, source: "wecom-reconciliation" } });
    expect((await db.query(`SELECT 1 FROM tennis.channel_transactions WHERE tenant_id=$1`, [first.actor.tenantId])).rowCount).toBe(1);
  });
  it("leaves matching amounts unallocated without a trusted reference, then atomically confirms an authorized manual association", async () => {
    const p = await payment(); const receipt = await simulateWecomReceipt(db, first.actor, { operationId: p.operationId, referenceMode: "UNMATCHED", commandKey: key() }, simulation);
    expect(receipt.state).toBe("UNMATCHED"); expect(receipt.operationId).toBeNull();
    expect((await getOrder(db, first.actor, p.order.id)).paymentStatus).toBe("UNPAID");
    const linked = await linkWecomReceipt(db, first.actor, { receiptId: receipt.id, operationId: p.operationId, reason: "已独立核验付款归属" });
    expect(linked.state).toBe("LINKED"); expect(linked.linkedBy).toBe(first.actor.subjectId);
    expect((await linkWecomReceipt(db, first.actor, { receiptId: receipt.id, operationId: p.operationId, reason: "已独立核验付款归属" })).id).toBe(linked.id);
    expect((await getOrderPayment(db, first.actor, p.pay.id)).status).toBe("SUCCEEDED");
  });
  it("automatically credits an explicitly referenced top-up once, without an employee confirming each payment", async () => {
    const t = await topup(), request = { operationId: t.operationId, referenceMode: "EXACT" as const, commandKey: key() };
    const firstReceipt = await simulateWecomReceipt(db, first.actor, request, simulation);
    expect(firstReceipt.state).toBe("LINKED");
    await simulateWecomReceipt(db, first.actor, request, simulation);
    expect((await getTopupPayment(db, first.actor, t.pay.id)).status).toBe("SUCCEEDED");
    expect((await getWallet(db, first.actor, customerId)).balance.totalCents).toBe(12000);
    const listed = (await listWecomReceipts(db, first.actor)).items[0]!;
    expect(listed.business).toMatchObject({ sourceKind: "TOPUP", sourceId: t.pay.id, venueId: first.venueId });
  });
  it("allows only one winner when an order and a top-up concurrently claim the same receipt", async () => {
    const p = await payment(), t = await topup();
    const receipt = await simulateWecomReceipt(db, first.actor, { operationId: p.operationId, referenceMode: "UNMATCHED", commandKey: key() }, simulation);
    const results = await Promise.allSettled([p.operationId, t.operationId].map(operationId => linkWecomReceipt(db, first.actor, { receiptId: receipt.id, operationId, reason: "核验归属" })));
    expect(results.filter(x => x.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(x => x.status === "rejected")).toHaveLength(1);
    expect((await db.query(`SELECT 1 FROM tennis.channel_transactions WHERE tenant_id=$1`, [first.actor.tenantId])).rowCount).toBe(1);
    const paid = (await getOrderPayment(db, first.actor, p.pay.id)).status === "SUCCEEDED";
    const topped = (await getTopupPayment(db, first.actor, t.pay.id)).status === "SUCCEEDED";
    expect(paid !== topped).toBe(true);
  });
  it("does not regain expired inventory when the trusted collection arrives after another booking", async () => {
    await credit(); const p = await payment(19, 6000);
    await db.query(`UPDATE tennis.orders SET hold_until=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND id=$2`, [first.actor.tenantId, p.order.id]);
    const replacement = await booking();
    const receipt = await simulateWecomReceipt(db, first.actor, { operationId: p.operationId, referenceMode: "EXACT", commandKey: key() }, simulation);
    expect(receipt.state).toBe("EXCEPTION");
    expect((await getOrderPayment(db, first.actor, p.pay.id)).status).toBe("REFUND_REQUIRED");
    expect((await getOrder(db, first.actor, replacement.id)).status).toBe("HELD");
    expect((await getWallet(db, first.actor, customerId)).balance.totalCents).toBe(12000);
    expect((await db.query(`SELECT 1 FROM tennis.financial_exceptions WHERE tenant_id=$1 AND payment_id=$2`, [first.actor.tenantId, p.pay.id])).rowCount).toBe(1);
  });
  it.each(["amount", "merchant"])("preserves a trusted %s mismatch for review without marking payment successful", async kind => {
    const p = await payment();
    const facts = syntheticFacts(p, kind === "amount" ? { amountCents: 1 } : { merchantId: "different-authenticated-merchant" });
    const receipt = await ingestWecomCollection(db, facts);
    expect(receipt.state).toBe("REVIEW"); expect(receipt.lastError).toBe("WECOM_TARGET_MISMATCH");
    expect((await getOrderPayment(db, first.actor, p.pay.id)).status).toBe("PENDING");
  });
  it("rejects changes to an immutable transaction or replay under a different tenant/corporation", async () => {
    const p = await payment(); const f = syntheticFacts(p, { trustedOperationId: null });
    await ingestWecomCollection(db, f);
    for (const override of [{ amountCents: 1 }, { tenantId: second.actor.tenantId }, { corporationId: "different-corporation" }]) {
      await expect(ingestWecomCollection(db, new FixtureSource().certify({ ...f, ...override }))).rejects.toMatchObject({ code: "WECOM_RECEIPT_CONFLICT" });
    }
    expect((await listWecomReceipts(db, second.actor)).items).toHaveLength(0);
  });
  it("never redirects a receipt carrying a different explicit trusted reference", async () => {
    const p = await payment(), t = await topup();
    const receipt = await ingestWecomCollection(db, syntheticFacts(p, { amountCents: 1 }));
    await expect(linkWecomReceipt(db, first.actor, { receiptId: receipt.id, operationId: t.operationId, reason: "同金额不是依据" })).rejects.toMatchObject({ code: "WECOM_REFERENCE_MISMATCH" });
  });
  it("rechecks administrator authority and isolates tenant receipt reads and mutations", async () => {
    const p = await payment(); const receipt = await simulateWecomReceipt(db, first.actor, { operationId: p.operationId, referenceMode: "UNMATCHED", commandKey: key() }, simulation);
    await expect(linkWecomReceipt(db, second.actor, { receiptId: receipt.id, operationId: p.operationId, reason: "跨租户禁止" })).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    await db.query(`UPDATE tennis.tenant_memberships SET role='STAFF',permissions=ARRAY['read','manage_members'] WHERE tenant_id=$1 AND subject_id=$2`, [first.actor.tenantId, first.actor.subjectId]);
    await expect(listWecomReceipts(db, first.actor)).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
    await expect(linkWecomReceipt(db, first.actor, { receiptId: receipt.id, operationId: p.operationId, reason: "普通员工禁止" })).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
  });
  it("rolls back payment, wallet and external receipt facts when the same-transaction adapter callback fails", async () => {
    await credit(); const p = await payment(19, 6000);
    const payload = { provider: "MOCK" as const, merchantId: p.pay.merchantId, paymentId: p.pay.id, eventId: key(), transactionId: key(), status: "SUCCEEDED" as const, amountCents: p.pay.externalCents, currency: "CNY" as const, issuedAt: Date.now() };
    const signed = gateway.signForLocalSimulator(payload); const event = gateway.verify(signed.body, signed.signature);
    await expect(settleVerifiedPayment(db, event, { async beforeSettlement() {}, async beforeCommit() { throw new Error("synthetic association write failed"); } })).rejects.toThrow("synthetic association write failed");
    expect((await getOrderPayment(db, first.actor, p.pay.id)).status).toBe("PENDING");
    expect((await getOrder(db, first.actor, p.order.id)).paymentStatus).toBe("UNPAID");
    expect((await db.query(`SELECT 1 FROM tennis.channel_transactions WHERE tenant_id=$1`, [first.actor.tenantId])).rowCount).toBe(0);
    expect((await getWallet(db, first.actor, customerId)).balance.totalCents).toBe(12000);
  });
  it("keeps a demo command tied to its original operation and never creates a second collection on conflicting retry", async () => {
    const p = await payment(), t = await topup(), commandKey = key();
    await simulateWecomReceipt(db, first.actor, { operationId: p.operationId, referenceMode: "UNMATCHED", commandKey }, simulation);
    await expect(simulateWecomReceipt(db, first.actor, { operationId: t.operationId, referenceMode: "UNMATCHED", commandKey }, simulation)).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    expect((await listWecomReceipts(db, first.actor)).items).toHaveLength(1);
  });
  it("pages old unmatched receipts using the database timestamp without losing sub-millisecond rows", async () => {
    const p = await payment();
    for (let i = 0; i < 52; i++) await ingestWecomCollection(db, syntheticFacts(p, { trustedOperationId: null }));
    const page1 = await listWecomReceipts(db, first.actor, { state: "UNMATCHED" });
    expect(page1.items).toHaveLength(50); expect(page1.nextCursor).not.toBeNull();
    const page2 = await listWecomReceipts(db, first.actor, { state: "UNMATCHED", cursor: page1.nextCursor! });
    expect(page2.items).toHaveLength(2); expect(page2.nextCursor).toBeNull();
    expect(new Set([...page1.items, ...page2.items].map(row => row.id)).size).toBe(52);
  });
  it("enforces HTTP staff sessions, tenant isolation, CSRF and rejects body-supplied money facts", async () => {
    const p = await payment();
    const app = await buildTennisServer({ db, gateway, allowSimulation: true, runExpiryWorker: false, aiEncryptionKey: Buffer.alloc(32, 9) });
    const origin = "http://127.0.0.1:4273", password = "synthetic-wecom-http-password-408!";
    async function login(kind: "ADMIN" | "CUSTOMER" | "FOREIGN") {
      const username = `wecom_${key()}`;
      const created = await createLocalAccount(db, { username, password, displayName: "企微合成HTTP账号", tenantId: kind === "FOREIGN" ? second.actor.tenantId : first.actor.tenantId,
        ...(kind === "CUSTOMER" ? { customerId } : { role: "ADMIN" as const }) });
      accountSubjects.push(created.subjectId);
      const response = await app.inject({ method: "POST", url: "/api/tennis/auth/login", headers: { origin }, payload: { username, password } });
      expect(response.statusCode, response.body).toBe(200);
      const view = response.json<SessionView>();
      const cookies = response.headers["set-cookie"];
      return { origin, cookie: (Array.isArray(cookies) ? cookies[0]! : String(cookies)).split(";")[0]!, "x-csrf-token": view.csrfToken, "x-workspace-version": String(view.contextVersion) };
    }
    try {
      const adminHeaders = await login("ADMIN"), customerHeaders = await login("CUSTOMER"), foreignHeaders = await login("FOREIGN");
      const payload = { operationId: p.operationId, referenceMode: "UNMATCHED", commandKey: key() };
      const url = "/api/tennis/wecom/demo-receipts";
      expect((await app.inject({ method: "POST", url, payload })).statusCode).toBe(401);
      expect((await app.inject({ method: "POST", url, headers: customerHeaders, payload })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url, headers: { ...adminHeaders, "x-csrf-token": "invalid" }, payload })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url, headers: adminHeaders, payload: { ...payload, amountCents: 1, merchantId: "fake" } })).statusCode).toBe(400);
      expect((await app.inject({ method: "POST", url, headers: foreignHeaders, payload })).statusCode).toBe(409);
      const created = await app.inject({ method: "POST", url, headers: adminHeaders, payload });
      expect(created.statusCode, created.body).toBe(200);
      const receiptId = created.json<{ id: string }>().id;
      const link = { operationId: p.operationId, reason: "员工独立核验合成归属" };
      expect((await app.inject({ method: "POST", url: `/api/tennis/wecom/receipts/${receiptId}/link`, headers: customerHeaders, payload: link })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url: `/api/tennis/wecom/receipts/${receiptId}/link`, headers: foreignHeaders, payload: link })).statusCode).toBe(404);
      const foreignList = await app.inject({ url: "/api/tennis/wecom/receipts", headers: foreignHeaders });
      expect(foreignList.json<{ items: unknown[] }>().items).toEqual([]);
      const linked = await app.inject({ method: "POST", url: `/api/tennis/wecom/receipts/${receiptId}/link`, headers: adminHeaders, payload: link });
      expect(linked.statusCode, linked.body).toBe(200);
      expect(linked.json<{ state: string }>().state).toBe("LINKED");
    } finally { await app.close(); }
  });
  it("provides scoped payment targets and searchable receipts without exposing another tenant", async () => {
    const p = await payment(); const receipt = await simulateWecomReceipt(db, first.actor, { operationId: p.operationId, referenceMode: "UNMATCHED", commandKey: key() }, simulation);
    expect((await listWecomPaymentTargets(db, first.actor, first.venueId))[0]!.operationId).toBe(p.operationId);
    expect(await listWecomPaymentTargets(db, second.actor, first.venueId)).toEqual([]);
    expect((await listWecomReceipts(db, first.actor, { q: receipt.transactionId, state: "UNMATCHED" })).items[0]!.id).toBe(receipt.id);
    expect((await listWecomReceipts(db, first.actor, { state: "EXCEPTION" })).items).toEqual([]);
  });
});
