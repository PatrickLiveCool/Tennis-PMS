import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertLocalTennisDatabaseUrl, localTennisTestDatabaseUrl } from "../../packages/db/src/tennis/local-config.ts";
import { migrateTennis } from "../../packages/db/src/tennis/migrate.ts";
import { createCourt, listVenues, setCourtPrice, updateVenue } from "../../packages/db/src/tennis/catalog.ts";
import { createCustomer, withBookingTransaction, type CustomerActor } from "../../packages/db/src/tennis/customers.ts";
import { confirmQuote, createQuote, listOrders } from "../../packages/db/src/tennis/booking.ts";
import { recordTenantAudit, type TenantActor } from "../../packages/db/src/tennis/access.ts";
import {
  createConversation,
  getConversationRequest,
  handoffConversation,
  issueDelegation,
  listConversationRequests,
  resolveDelegation,
} from "../../packages/db/src/tennis/external-agent.ts";
import { idempotentCommand } from "../../packages/db/src/tennis/receipts.ts";
import { beginTopupPayment, createTopupQuote } from "../../packages/db/src/tennis/topups.ts";
import { LocalMockPaymentGateway } from "../../packages/db/src/tennis/mock-payments.ts";
import { removeTenantFixture, seedTenantFixture, type TenantFixture } from "./tenant-fixture.ts";

const db = new pg.Pool({
  connectionString: assertLocalTennisDatabaseUrl(localTennisTestDatabaseUrl, "test"),
  max: 8,
  connectionTimeoutMillis: 5000,
  statement_timeout: 10000,
});
const gateway = new LocalMockPaymentGateway(randomBytes(32).toString("hex"), "local-simulation");
let first: TenantFixture, second: TenantFixture, customer: CustomerActor, otherCustomer: CustomerActor;
let staff: TenantActor, courtId: string;
let extraSubjects: string[];
const selection = () => ({
  venueId: first.venueId,
  customerId: customer.customerId,
  lines: [{ courtId, startAt: "2099-09-18T19:00:00+08:00", endAt: "2099-09-18T20:00:00+08:00" }],
});
async function addCustomer(nickname: string): Promise<CustomerActor> {
  const profile = await createCustomer(db, first.actor, { nickname });
  const subjectId = randomUUID();
  await db.query("INSERT INTO tennis.subjects(id,display_name) VALUES($1,$2)", [subjectId, nickname]);
  extraSubjects.push(subjectId);
  await db.query("UPDATE tennis.customers SET subject_id=$1 WHERE tenant_id=$2 AND id=$3", [
    subjectId, first.actor.tenantId, profile.id,
  ]);
  return { tenantId: first.actor.tenantId, subjectId, kind: "customer", customerId: profile.id };
}
async function delegate(conversationId?: string) {
  const id = conversationId ?? (await createConversation(db, customer, first.venueId)).id;
  const grant = await issueDelegation(db, customer, id);
  const resolved = await resolveDelegation(db, grant.token);
  return { ...grant, actor: resolved.actor };
}
async function book(grant: Awaited<ReturnType<typeof delegate>>) {
  const quote = await createQuote(db, grant.actor, selection());
  const input = { quoteId: quote.id, commandKey: randomUUID() };
  const order = await confirmQuote(db, grant.actor, input);
  return { input, order };
}
async function receipts(commandKey: string) {
  return (await db.query(
    "SELECT subject_id,command_key,result,completed_at FROM tennis.command_receipts WHERE tenant_id=$1 AND command_key=$2",
    [first.actor.tenantId, commandKey],
  )).rows;
}
async function links(commandKey: string) {
  return (await db.query<{ request_id: string; conversation_id: string; subject_id: string }>(
    "SELECT request_id,conversation_id,subject_id FROM tennis.agent_command_links WHERE tenant_id=$1 AND command_key=$2 ORDER BY request_id",
    [first.actor.tenantId, commandKey],
  )).rows;
}
beforeAll(async () => {
  const tx = await db.connect();
  try { await migrateTennis(tx); } finally { tx.release(); }
});
beforeEach(async () => {
  extraSubjects = [];
  first = await seedTenantFixture(db);
  second = await seedTenantFixture(db);
  const venue = (await listVenues(db, first.actor))[0]!;
  await updateVenue(db, first.actor, {
    ...venue,
    expectedRevision: venue.catalogRevision,
    minimumBookingMinutes: 15,
    openingHours: Array.from({ length: 7 }, (_, weekday) => ({ weekday, startMinute: 480, endMinute: 1320 })),
  });
  const court = await createCourt(db, first.actor, { venueId: first.venueId, name: "request history court", indoor: true });
  courtId = court.id;
  await setCourtPrice(db, first.actor, {
    venueId: first.venueId, courtId, expectedRevision: court.revision, hourlyPriceCents: 10000,
  });
  customer = await addCustomer("合成请求客户");
  otherCustomer = await addCustomer("另一合成客户");
  staff = { tenantId: first.actor.tenantId, subjectId: randomUUID() };
  await db.query("INSERT INTO tennis.subjects(id,display_name) VALUES($1,'合成预订员工')", [staff.subjectId]);
  extraSubjects.push(staff.subjectId);
  await db.query(
    "INSERT INTO tennis.tenant_memberships(tenant_id,subject_id,role,all_venues,permissions) VALUES($1,$2,'STAFF',true,ARRAY['read','book']::text[])",
    [staff.tenantId, staff.subjectId],
  );
});
afterEach(async () => {
  // Conversation-owned requests, messages, delegations and links cascade first.
  await db.query("DELETE FROM tennis.agent_conversations WHERE tenant_id=ANY($1::text[])", [
    [first.actor.tenantId, second.actor.tenantId],
  ]);
  await removeTenantFixture(db, first);
  await removeTenantFixture(db, second);
  await db.query("DELETE FROM tennis.subjects WHERE id=ANY($1::text[])", [extraSubjects]);
});
afterAll(() => db.end());

describe("durable Agent request to command history", () => {
  it("links a new command and repeated requests to the same committed business receipt", async () => {
    const original = await delegate();
    const { input, order } = await book(original);
    const originalReceipt = await receipts(input.commandKey);
    expect(originalReceipt).toHaveLength(1);
    expect(originalReceipt[0].result).toEqual({ orderId: order.id });
    expect((await confirmQuote(db, original.actor, input)).id).toBe(order.id);
    expect(await links(input.commandKey)).toEqual([
      { request_id: original.requestId, conversation_id: original.conversation.id, subject_id: customer.subjectId },
    ]);

    const retry = await delegate(original.conversation.id);
    expect(retry.requestId).not.toBe(original.requestId);
    expect((await confirmQuote(db, retry.actor, input)).id).toBe(order.id);
    expect(await receipts(input.commandKey)).toEqual(originalReceipt);
    expect((await links(input.commandKey)).map((link) => link.request_id).sort()).toEqual(
      [original.requestId, retry.requestId].sort(),
    );
    expect(await listOrders(db, customer, first.venueId)).toHaveLength(1);
    for (const grant of [original, retry]) {
      const detail = await getConversationRequest(db, customer, grant.conversation.id, grant.requestId);
      expect(detail).toMatchObject({ requestId: grant.requestId, commandCount: 1, restrictedCommandCount: 0 });
      expect(detail.commands).toEqual([
        {
          commandKey: input.commandKey,
          commandType: "quote.confirm",
          completedAt: originalReceipt[0].completed_at.toISOString(),
          resources: [{ type: "order", id: order.id, status: "HELD", paymentStatus: "UNPAID" }],
        },
      ]);
      expect(JSON.stringify(detail)).not.toContain(grant.token);
      expect(JSON.stringify(detail)).not.toContain("request_hash");
    }
  });

  it("attaches an existing ordinary-session receipt on an Agent idempotency hit without rebooking", async () => {
    const quote = await createQuote(db, customer, selection());
    const input = { quoteId: quote.id, commandKey: randomUUID() };
    const order = await confirmQuote(db, customer, input);
    const before = await receipts(input.commandKey);
    expect(await links(input.commandKey)).toEqual([]);
    const grant = await delegate();
    expect((await confirmQuote(db, grant.actor, input)).id).toBe(order.id);
    expect(await receipts(input.commandKey)).toEqual(before);
    expect(await links(input.commandKey)).toEqual([
      { request_id: grant.requestId, conversation_id: grant.conversation.id, subject_id: customer.subjectId },
    ]);
    expect((await getConversationRequest(db, customer, grant.conversation.id, grant.requestId)).commands[0]?.resources)
      .toEqual([{ type: "order", id: order.id, status: "HELD", paymentStatus: "UNPAID" }]);
    expect(await listOrders(db, customer, first.venueId)).toHaveLength(1);
  });

  it("leaves neither a receipt nor a request link when inventory rejects the command", async () => {
    const grant = await delegate();
    const losingQuote = await createQuote(db, grant.actor, selection());
    const winningQuote = await createQuote(db, customer, selection());
    const winner = await confirmQuote(db, customer, { quoteId: winningQuote.id, commandKey: randomUUID() });
    const commandKey = randomUUID();
    await expect(confirmQuote(db, grant.actor, { quoteId: losingQuote.id, commandKey }))
      .rejects.toMatchObject({ code: "INVENTORY_CONFLICT" });
    expect(await receipts(commandKey)).toEqual([]);
    expect(await links(commandKey)).toEqual([]);
    expect((await listOrders(db, customer, first.venueId)).map((order) => order.id)).toEqual([winner.id]);
    expect(await getConversationRequest(db, customer, grant.conversation.id, grant.requestId))
      .toMatchObject({ commandCount: 0, commands: [], restrictedCommandCount: 0 });
  });

  it("rolls back an already-linked receipt with the enclosing business transaction", async () => {
    const grant = await delegate();
    const commandKey = randomUUID(), resourceId = randomUUID(), failure = new Error("synthetic commit-path failure");
    await expect(withBookingTransaction(db, grant.actor, async (tx) => {
      await idempotentCommand(tx, grant.actor, first.venueId, commandKey, "test.rollback", { resourceId }, async () => {
        await recordTenantAudit(tx, grant.actor, "test.rollback", resourceId);
        return { resourceId };
      });
      expect((await tx.query("SELECT 1 FROM tennis.agent_command_links WHERE tenant_id=$1 AND request_id=$2 AND command_key=$3", [
        first.actor.tenantId, grant.requestId, commandKey,
      ])).rowCount).toBe(1);
      throw failure;
    })).rejects.toBe(failure);
    expect(await receipts(commandKey)).toEqual([]);
    expect(await links(commandKey)).toEqual([]);
    expect((await db.query("SELECT id FROM tennis.audit_events WHERE tenant_id=$1 AND resource_id=$2", [
      first.actor.tenantId, resourceId,
    ])).rowCount).toBe(0);
    expect((await getConversationRequest(db, customer, grant.conversation.id, grant.requestId)).commandCount).toBe(0);
  });

  it("keeps request details scoped to the requested conversation, tenant and customer", async () => {
    const grant = await delegate();
    await book(grant);
    const ownOther = await createConversation(db, customer, first.venueId);
    const anotherCustomer = await createConversation(db, otherCustomer, first.venueId);
    const foreign = await createConversation(db, second.actor, second.venueId);
    await expect(getConversationRequest(db, customer, ownOther.id, grant.requestId))
      .rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    await expect(getConversationRequest(db, second.actor, grant.conversation.id, grant.requestId))
      .rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    await expect(getConversationRequest(db, second.actor, foreign.id, grant.requestId))
      .rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    await expect(getConversationRequest(db, otherCustomer, grant.conversation.id, grant.requestId))
      .rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    await expect(listConversationRequests(db, otherCustomer, grant.conversation.id))
      .rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    await expect(listConversationRequests(db, customer, anotherCustomer.id))
      .rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    await expect(listConversationRequests(db, second.actor, grant.conversation.id))
      .rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    expect((await getConversationRequest(db, staff, grant.conversation.id, grant.requestId)).commands).toHaveLength(1);
  });

  it("hides topup command details from staff without manage_members while keeping customer and admin history", async () => {
    const grant = await delegate();
    const quote = await createTopupQuote(db, grant.actor, {
      venueId: first.venueId, customerId: customer.customerId, principalCents: 1000000,
    });
    const commandKey = randomUUID();
    const topup = await beginTopupPayment(db, grant.actor, gateway, { quoteId: quote.id, commandKey });
    for (const actor of [customer, first.actor]) {
      const detail = await getConversationRequest(db, actor, grant.conversation.id, grant.requestId);
      expect(detail).toMatchObject({ commandCount: 1, restrictedCommandCount: 0 });
      expect(detail.commands).toEqual([expect.objectContaining({
        commandKey, commandType: "topup.begin", resources: [{ type: "topup", id: topup.id, status: "PENDING" }],
      })]);
    }
    const limited = await getConversationRequest(db, staff, grant.conversation.id, grant.requestId);
    expect(limited).toMatchObject({ commandCount: 1, restrictedCommandCount: 1, commands: [] });
    expect(JSON.stringify(limited)).not.toContain(topup.id);
    expect(JSON.stringify(limited)).not.toContain(commandKey);
    expect(JSON.stringify(limited)).not.toContain("principalCents");
  });

  it("paginates more than forty requests exactly once across sub-millisecond timestamps and equal-time ties", async () => {
    const conv = await createConversation(db, customer, first.venueId);
    const prefix = randomUUID();
    const expected = Array.from({ length: 45 }, (_, index) => `${prefix}-${String(index).padStart(3, "0")}`).reverse();
    // Pairs share an exact timestamp; every row also shares the same JS millisecond.
    await db.query(`INSERT INTO tennis.agent_requests(id,tenant_id,conversation_id,subject_id,venue_id,generation,created_at)
      SELECT $1||'-'||lpad(i::text,3,'0'),$2,$3,$4,$5,1,
        '2040-01-01T00:00:00Z'::timestamptz + (i/2)*interval '1 microsecond'
      FROM generate_series(0,44) AS rows(i)`, [prefix, first.actor.tenantId, conv.id, customer.subjectId, first.venueId]);
    const page1 = await listConversationRequests(db, customer, conv.id);
    expect(page1.items).toHaveLength(20);
    expect(page1.nextCursor).toBe(expected[19]);
    const page2 = await listConversationRequests(db, customer, conv.id, page1.nextCursor!);
    expect(page2.items).toHaveLength(20);
    expect(page2.nextCursor).toBe(expected[39]);
    const page3 = await listConversationRequests(db, customer, conv.id, page2.nextCursor!);
    expect(page3.items).toHaveLength(5);
    expect(page3.nextCursor).toBeNull();
    const all = [...page1.items, ...page2.items, ...page3.items];
    expect(all.map((row) => row.requestId)).toEqual(expected);
    expect(new Set(all.map((row) => row.createdAt)).size).toBe(1);
    expect(all.every((row) => row.dispatchStatus === "ISSUED" && row.commandCount === 0)).toBe(true);
    expect(await listConversationRequests(db, customer, conv.id, expected.at(-1)!))
      .toEqual({ items: [], nextCursor: null });
  });

  it("rejects cursors from another conversation or tenant instead of silently returning an empty page", async () => {
    const grant = await delegate();
    const other = await delegate();
    const foreign = await createConversation(db, second.actor, second.venueId);
    const foreignGrant = await issueDelegation(db, second.actor, foreign.id);
    await expect(listConversationRequests(db, customer, grant.conversation.id, other.requestId))
      .rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    await expect(listConversationRequests(db, customer, grant.conversation.id, foreignGrant.requestId))
      .rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    await expect(listConversationRequests(db, customer, grant.conversation.id, randomUUID()))
      .rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    expect((await listConversationRequests(db, customer, grant.conversation.id)).items.map((row) => row.requestId))
      .toEqual([grant.requestId]);
  });

  it("preserves staff-readable request history after handoff revokes the original write delegation", async () => {
    const grant = await delegate();
    const { input, order } = await book(grant);
    const taken = await handoffConversation(db, staff, grant.conversation.id, { mode: "HUMAN", reason: "员工核对原预订结果" });
    expect(taken).toMatchObject({ mode: "HUMAN", generation: grant.conversation.generation + 1, takenBy: staff.subjectId });
    await expect(resolveDelegation(db, grant.token)).rejects.toMatchObject({ code: "AGENT_DELEGATION_REVOKED" });
    await expect(confirmQuote(db, grant.actor, input)).rejects.toMatchObject({ code: "AGENT_DELEGATION_REVOKED" });
    await expect(getConversationRequest(db, grant.actor, grant.conversation.id, grant.requestId))
      .rejects.toMatchObject({ code: "AGENT_DELEGATION_REVOKED" });
    const history = await listConversationRequests(db, staff, grant.conversation.id);
    expect(history.items).toEqual([expect.objectContaining({ requestId: grant.requestId, generation: 1, commandCount: 1 })]);
    const detail = await getConversationRequest(db, staff, grant.conversation.id, grant.requestId);
    expect(detail.commands).toEqual([expect.objectContaining({
      commandKey: input.commandKey,
      resources: [{ type: "order", id: order.id, status: "HELD", paymentStatus: "UNPAID" }],
    })]);
    expect(await receipts(input.commandKey)).toHaveLength(1);
    expect(await links(input.commandKey)).toHaveLength(1);
  });
});
