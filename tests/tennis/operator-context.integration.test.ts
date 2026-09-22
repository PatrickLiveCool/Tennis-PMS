import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertLocalTennisDatabaseUrl, localTennisTestDatabaseUrl } from "../../packages/db/src/tennis/local-config.ts";
import { migrateTennis } from "../../packages/db/src/tennis/migrate.ts";
import {
  createCourt,
  createVenue,
  listVenues,
  setCourtPrice,
  updateVenue,
} from "../../packages/db/src/tennis/catalog.ts";
import { createCustomer, type CustomerActor } from "../../packages/db/src/tennis/customers.ts";
import { confirmQuote, createQuote } from "../../packages/db/src/tennis/booking.ts";
import {
  createConversation,
  getConversation,
  handoffConversation,
  issueDelegation,
  listConversationPage,
  resolveDelegation,
  sendAssistantMessage,
  type AssistantContext,
} from "../../packages/db/src/tennis/external-agent.ts";
import { buildTennisServer } from "../../apps/api/src/tennis/server.ts";
import { LocalMockPaymentGateway } from "../../packages/db/src/tennis/mock-payments.ts";
import { removeTenantFixture, seedTenantFixture, syntheticPhone, type TenantFixture } from "./tenant-fixture.ts";

const db = new pg.Pool({
  connectionString: assertLocalTennisDatabaseUrl(localTennisTestDatabaseUrl, "test"),
  max: 8,
  connectionTimeoutMillis: 5000,
  statement_timeout: 10000,
});
const key = randomBytes(32);
let first: TenantFixture, second: TenantFixture, customer: CustomerActor;
let extraSubjects: string[];
let previousConfig: { enabled: boolean; external_agent_url: string; encrypted_key: string | null };
let orderCounter = 0;
const courts = new Map<string, string>();

beforeAll(async () => {
  const tx = await db.connect();
  try {
    await migrateTennis(tx);
  } finally {
    tx.release();
  }
});
beforeEach(async () => {
  previousConfig = (
    await db.query("SELECT enabled,external_agent_url,encrypted_key FROM tennis.platform_ai_config WHERE singleton")
  ).rows[0];
  await db.query("UPDATE tennis.platform_ai_config SET enabled=false WHERE singleton");
  first = await seedTenantFixture(db);
  second = await seedTenantFixture(db);
  extraSubjects = [];
  courts.clear();
  orderCounter = 0;
  const profile = await createCustomer(db, first.actor, { nickname: "人工协作新客户", phone: syntheticPhone() });
  const subjectId = randomUUID();
  extraSubjects.push(subjectId);
  await db.query("INSERT INTO tennis.subjects(id,display_name) VALUES($1,'人工协作新客户')", [subjectId]);
  await db.query("UPDATE tennis.customers SET subject_id=$1 WHERE tenant_id=$2 AND id=$3", [
    subjectId,
    first.actor.tenantId,
    profile.id,
  ]);
  customer = { kind: "customer", subjectId, tenantId: first.actor.tenantId, customerId: profile.id };
});
afterEach(async () => {
  await db.query(
    "UPDATE tennis.platform_ai_config SET enabled=$1,external_agent_url=$2,encrypted_key=$3 WHERE singleton",
    [previousConfig.enabled, previousConfig.external_agent_url, previousConfig.encrypted_key],
  );
  await db.query("DELETE FROM tennis.agent_conversations WHERE tenant_id=ANY($1::text[])", [
    [first.actor.tenantId, second.actor.tenantId],
  ]);
  await removeTenantFixture(db, first);
  await removeTenantFixture(db, second);
  await db.query("DELETE FROM tennis.subjects WHERE id=ANY($1::text[])", [extraSubjects]);
});
afterAll(() => db.end());

async function booked(fixture = first, customerId = customer.customerId, venueId = fixture.venueId) {
  let courtId = courts.get(venueId);
  if (!courtId) {
    const venue = (await listVenues(db, fixture.actor)).find((v) => v.id === venueId)!;
    await updateVenue(db, fixture.actor, {
      ...venue,
      expectedRevision: venue.catalogRevision,
      minimumBookingMinutes: 15,
      openingHours: Array.from({ length: 7 }, (_, weekday) => ({ weekday, startMinute: 0, endMinute: 1440 })),
    });
    const court = await createCourt(db, fixture.actor, { venueId, name: "context court", indoor: true, surface: "ACRYLIC", profile: { specification: "STANDARD" }, hourlyPriceCents: 0 });
    await setCourtPrice(db, fixture.actor, {
      venueId,
      courtId: court.id,
      expectedRevision: court.revision,
      hourlyPriceCents: 0,
    });
    courtId = court.id;
    courts.set(venueId, courtId);
  }
  const start = String(9 + orderCounter++).padStart(2, "0");
  const end = String(Number(start) + 1).padStart(2, "0");
  const quote = await createQuote(db, fixture.actor, {
    venueId,
    customerId,
    lines: [{ courtId, startAt: `2099-09-18T${start}:00:00+08:00`, endAt: `2099-09-18T${end}:00:00+08:00` }],
  });
  return confirmQuote(db, fixture.actor, { quoteId: quote.id, commandKey: randomUUID() });
}
async function queueMessage(conversationId: string, context: AssistantContext, content = "这笔订单请协助核对") {
  const messageId = randomUUID();
  await expect(
    sendAssistantMessage(db, customer, key, conversationId, { messageId, content, context }),
  ).rejects.toMatchObject({ code: "ASSISTANT_NOT_CONFIGURED" });
  return messageId;
}
async function seedConversations(count: number, mode: "HUMAN" | "AGENT" = "HUMAN") {
  const ids = Array.from({ length: count }, () => randomUUID());
  await db.query(
    `INSERT INTO tennis.agent_conversations(id,tenant_id,venue_id,subject_id,customer_id,actor_kind,mode,updated_at)
    SELECT id,$2,$3,$4,$5,'customer',$6,'2026-01-01T12:00:00.123456Z'::timestamptz FROM unnest($1::text[]) id`,
    [ids, first.actor.tenantId, first.venueId, customer.subjectId, customer.customerId, mode],
  );
  return ids;
}

describe("operator order context and recoverable conversation directory", () => {
  it("persists a direct handoff order before any text and preserves it beyond the recent message window", async () => {
    const order = await booked();
    const conv = await createConversation(db, customer, first.venueId);
    await handoffConversation(db, customer, conv.id, {
      mode: "HUMAN",
      reason: "请工作人员看这单",
      context: { page: "orders", orderId: order.id },
    });
    let view = await getConversation(db, first.actor, conv.id);
    expect(view.latestOrderContext).toMatchObject({ page: "orders", orderId: order.id });
    expect(view.messages).toHaveLength(1);
    expect(view.messages[0]).toMatchObject({ role: "system", context: { page: "orders", orderId: order.id } });
    await db.query(
      `INSERT INTO tennis.agent_messages(id,tenant_id,conversation_id,role,subject_id,content)
      SELECT gen_random_uuid()::text,$1,$2,'user',$3,'后续普通留言' FROM generate_series(1,205)`,
      [first.actor.tenantId, conv.id, customer.subjectId],
    );
    view = await getConversation(db, customer, conv.id);
    expect(view.messages).toHaveLength(200);
    expect(view.messages.every((m) => m.context === null)).toBe(true);
    expect(view.latestOrderContext?.orderId).toBe(order.id);
    const directory = await listConversationPage(db, first.actor, first.venueId, { q: order.id, mode: "HUMAN" });
    expect(directory.items.map((c) => c.id)).toEqual([conv.id]);
    expect(directory.items[0]).toMatchObject({ displayName: "人工协作新客户", latestOrderId: order.id });
  });

  it("stores HUMAN context without invoking runtime and rejects changed context under an existing message id", async () => {
    const order = await booked(),
      other = await booked();
    const conv = await createConversation(db, customer, first.venueId);
    await handoffConversation(db, first.actor, conv.id, { mode: "HUMAN", reason: "人工核对" });
    let called = 0;
    const transport = async () => {
      called++;
      throw new Error("runtime must not be invoked");
    };
    const message = { messageId: randomUUID(), content: "这单", context: { page: "orders", orderId: order.id } };
    await sendAssistantMessage(db, customer, key, conv.id, message, transport);
    const replay = await sendAssistantMessage(db, customer, key, conv.id, message, transport);
    expect(called).toBe(0);
    expect(replay.messages.filter((m) => m.id === message.messageId)).toHaveLength(1);
    for (const context of [
      { page: "orders", orderId: other.id },
      { page: "schedule", orderId: order.id },
    ])
      await expect(
        sendAssistantMessage(db, customer, key, conv.id, { ...message, context }, transport),
      ).rejects.toMatchObject({ code: "INVALID_AGENT_MESSAGE" });
    const final = await getConversation(db, first.actor, conv.id);
    expect(final.latestOrderContext?.orderId).toBe(order.id);
    expect(final.messages.find((m) => m.id === message.messageId)?.context).toEqual(message.context);
  });

  it("denies foreign customer, venue and tenant orders even when staff can read the customer's HUMAN conversation", async () => {
    const otherCustomer = await createCustomer(db, first.actor, { nickname: "另一客户", phone: syntheticPhone() });
    const otherCustomerOrder = await booked(first, otherCustomer.id);
    const otherVenue = await createVenue(db, first.actor, { name: "other context venue", timezone: "Asia/Shanghai" });
    const otherVenueOrder = await booked(first, customer.customerId, otherVenue.id);
    const foreignCustomer = await createCustomer(db, second.actor, { nickname: "外租户客户", phone: syntheticPhone() });
    const foreignOrder = await booked(second, foreignCustomer.id);
    const conv = await createConversation(db, customer, first.venueId);
    for (const actor of [customer, first.actor]) {
      for (const order of [otherCustomerOrder, otherVenueOrder, foreignOrder]) {
        await expect(
          handoffConversation(db, actor, conv.id, {
            mode: "HUMAN",
            reason: "不得串单",
            context: { page: "orders", orderId: order.id },
          }),
        ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
      }
    }
    expect((await getConversation(db, customer, conv.id)).conversation).toMatchObject({ mode: "AGENT", generation: 1 });
    expect((await getConversation(db, customer, conv.id)).messages).toHaveLength(0);
    await handoffConversation(db, first.actor, conv.id, { mode: "HUMAN", reason: "接管" });
    for (const actor of [customer, first.actor])
      await expect(
        sendAssistantMessage(db, actor, key, conv.id, {
          messageId: randomUUID(),
          content: "错单",
          context: { page: "orders", orderId: otherCustomerOrder.id },
        }),
      ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    expect((await getConversation(db, customer, conv.id)).latestOrderContext).toBeNull();
  });

  it("anchors delayed grants and the agent context endpoint to the original stored message", async () => {
    const firstOrder = await booked(),
      laterOrder = await booked();
    const conv = await createConversation(db, customer, first.venueId);
    const messageId = await queueMessage(conv.id, { page: "orders", orderId: firstOrder.id });
    await db.query(
      `INSERT INTO tennis.agent_messages(id,tenant_id,conversation_id,role,subject_id,content,context_page,context_order_id)
      SELECT gen_random_uuid()::text,$1,$2,'user',$3,'后来改谈另一单','orders',$4 FROM generate_series(1,205)`,
      [first.actor.tenantId, conv.id, customer.subjectId, laterOrder.id],
    );
    const grant = await issueDelegation(db, customer, conv.id, messageId);
    expect(grant.context).toEqual({ page: "orders", orderId: firstOrder.id });
    expect(grant.messages.map((m) => m.id)).toEqual([messageId]);
    expect(grant.messages[0]?.context).toEqual(grant.context);
    expect((await resolveDelegation(db, grant.token)).context).toEqual(grant.context);
    const app = await buildTennisServer({
      db,
      gateway: new LocalMockPaymentGateway(randomBytes(32).toString("hex"), "local-simulation"),
      allowSimulation: true,
      aiEncryptionKey: key,
    });
    try {
      const response = await app.inject({
        url: "/api/tennis/agent/context",
        headers: { authorization: `Bearer ${grant.token}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().context).toEqual(grant.context);
    } finally {
      await app.close();
    }
  });

  it("dispatches normalized persisted context once and rejects a changed retry after the reply", async () => {
    await db.query(
      "UPDATE tennis.platform_ai_config SET enabled=true,external_agent_url='https://runtime.example.test/messages',encrypted_key=NULL WHERE singleton",
    );
    const order = await booked();
    const conv = await createConversation(db, customer, first.venueId);
    const message = { messageId: randomUUID(), content: "核对这单", context: { page: " orders ", orderId: order.id } };
    const requests: Record<string, unknown>[] = [];
    const transport = async (_url: string, input: { body: string }) => {
      requests.push(JSON.parse(input.body));
      return { ok: true, json: async () => ({ content: "已收到请求，请以订单实际状态为准。" }) };
    };
    await sendAssistantMessage(db, customer, key, conv.id, message, transport);
    await sendAssistantMessage(db, customer, key, conv.id, message, transport);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.context).toEqual({ page: "orders", orderId: order.id });
    expect((requests[0]?.messages as { context: AssistantContext }[])[0]?.context).toEqual({
      page: "orders",
      orderId: order.id,
    });
    await expect(
      sendAssistantMessage(db, customer, key, conv.id, { ...message, context: { page: "schedule" } }, transport),
    ).rejects.toMatchObject({ code: "INVALID_AGENT_MESSAGE" });
  });

  it("paginates more than 100 HUMAN conversations with tied timestamps and searchable identities", async () => {
    const ids = await seedConversations(121);
    await seedConversations(2, "AGENT");
    const found: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listConversationPage(db, first.actor, first.venueId, {
        mode: "HUMAN",
        q: "人工协作",
        pageSize: 17,
        ...(cursor ? { cursor } : {}),
      });
      expect(page.items.every((i) => i.mode === "HUMAN" && i.displayName === "人工协作新客户")).toBe(true);
      found.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(found).toEqual([...ids].sort().reverse());
    expect(new Set(found).size).toBe(121);
    expect((await listConversationPage(db, customer, first.venueId, { q: ids[50] })).items.map((c) => c.id)).toEqual([
      ids[50],
    ]);
    expect((await listConversationPage(db, first.actor, first.venueId, { q: "%' OR 1=1 --" })).items).toEqual([]);
  });

  it("keeps a microsecond cursor boundary fixed after the pivot receives another message", async () => {
    const ids = await seedConversations(3);
    for (let i = 0; i < 3; i++)
      await db.query("UPDATE tennis.agent_conversations SET updated_at=$2 WHERE id=$1", [
        ids[i],
        `2026-01-01T12:00:00.00000${3 - i}Z`,
      ]);
    const page = await listConversationPage(db, first.actor, first.venueId, { pageSize: 1 });
    expect(page.items[0]?.id).toBe(ids[0]);
    const cursor = page.nextCursor!;
    await db.query("UPDATE tennis.agent_conversations SET updated_at=clock_timestamp() WHERE id=$1", [ids[0]]);
    const next = await listConversationPage(db, first.actor, first.venueId, { pageSize: 1, cursor });
    expect(next.items[0]?.id).toBe(ids[1]);
    const last = await listConversationPage(db, first.actor, first.venueId, { pageSize: 1, cursor: next.nextCursor! });
    expect(last.items[0]?.id).toBe(ids[2]);
    expect(last.nextCursor).toBeNull();
    for (const filters of [{ cursor, mode: "HUMAN" }, { cursor, q: "人工" }, { cursor: "not-json" }])
      await expect(listConversationPage(db, first.actor, first.venueId, filters)).rejects.toMatchObject({
        code: "INVALID_CONVERSATION_CURSOR",
      });
    const invalidDate = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    invalidDate.at = "2026-02-31T12:00:00.000001Z";
    await expect(
      listConversationPage(db, first.actor, first.venueId, {
        cursor: Buffer.from(JSON.stringify(invalidDate)).toString("base64url"),
      }),
    ).rejects.toMatchObject({ code: "INVALID_CONVERSATION_CURSOR" });
    await expect(listConversationPage(db, customer, first.venueId, { cursor })).rejects.toMatchObject({
      code: "INVALID_CONVERSATION_CURSOR",
    });
    await expect(listConversationPage(db, second.actor, second.venueId, { cursor })).rejects.toMatchObject({
      code: "INVALID_CONVERSATION_CURSOR",
    });
  });

  it("keeps directory visibility on the customer and current employee venue grants", async () => {
    await seedConversations(3);
    const staffConversation = await createConversation(db, first.actor, first.venueId);
    const own = await listConversationPage(db, customer, first.venueId, {});
    expect(own.items).toHaveLength(3);
    expect(own.items.some((i) => i.id === staffConversation.id)).toBe(false);
    const subjectId = randomUUID();
    extraSubjects.push(subjectId);
    await db.query("INSERT INTO tennis.subjects(id,display_name) VALUES($1,'有限授权员工')", [subjectId]);
    await db.query(
      "INSERT INTO tennis.tenant_memberships(tenant_id,subject_id,role,permissions,all_venues) VALUES($1,$2,'STAFF',ARRAY['read','book'],false)",
      [first.actor.tenantId, subjectId],
    );
    const staff = { tenantId: first.actor.tenantId, subjectId };
    await expect(listConversationPage(db, staff, first.venueId)).rejects.toMatchObject({
      code: "TENANT_ACCESS_DENIED",
    });
    await db.query("INSERT INTO tennis.membership_venues(tenant_id,subject_id,venue_id) VALUES($1,$2,$3)", [
      first.actor.tenantId,
      subjectId,
      first.venueId,
    ]);
    const page = await listConversationPage(db, staff, first.venueId, { pageSize: 1 });
    expect(page.nextCursor).not.toBeNull();
    await db.query(
      "UPDATE tennis.tenant_memberships SET permissions=ARRAY['read'] WHERE tenant_id=$1 AND subject_id=$2",
      [first.actor.tenantId, subjectId],
    );
    await expect(listConversationPage(db, staff, first.venueId, { cursor: page.nextCursor! })).rejects.toMatchObject({
      code: "TENANT_ACCESS_DENIED",
    });
  });
});
