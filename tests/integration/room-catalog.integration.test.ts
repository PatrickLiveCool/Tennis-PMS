import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import { databaseReady, createDatabase, createCommandPreview, confirmCommandPreview, getOrderView, type Database } from "@qintopia/db";
import { sha256 } from "@qintopia/domain";
import type { AuthPrincipal, RoomCatalogInput, RoomCatalogEffect } from "@qintopia/contracts";
import { resetDatabase } from "../helpers/database.ts";
import { runtimeDatabaseUrlForTesting } from "../helpers/runtime-database.ts";
import { authScope } from "../helpers/auth-principals.ts";
import { demo } from "../../packages/db/src/seed.ts";
import { readRoomCatalog, resolveCatalogPolicyId } from "../../packages/db/src/room-catalog.ts";
import { createQuoteForTesting } from "../../packages/db/src/pricing-service.ts";
import { loadInventoryUnit } from "../../packages/db/src/inventory.ts";
import { getRoomStatusBoard } from "../../packages/db/src/room-status.ts";
import { buildServer } from "../../apps/api/src/server.ts";

const url = process.env.ROOM_CATALOG_TEST_DATABASE_URL ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_room_catalog_test";
let owner: Kysely<Database>, db: Kysely<Database>;
let sequence = 0;
let lockedOrderId: string;
const metadata = () => ({ idempotencyKey: `catalog-${++sequence}`, correlationId: `catalog-${sequence}` });
const admin: AuthPrincipal = { subjectId: demo.administratorSubjectId, credentialId: "session_catalog_admin", credentialType: "SESSION",
  displayName: "房型管理员", ...authScope({ credentialType: "SESSION", profile: "administrator" }) };
const anchors = { "1": 8000, "7": 40000, "14": 60000, "30": 100000 };
async function preview(input: Omit<RoomCatalogInput, "propertyId" | "expectedVersion"> & { expectedVersion?: number }) {
  const current = await readRoomCatalog(db, demo.propertyId);
  return createCommandPreview(db, admin, { commandType: "MANAGE_ROOM_CATALOG", input: {
    propertyId: demo.propertyId, expectedVersion: current.version, ...input } }, metadata());
}
async function commit(prepared: Awaited<ReturnType<typeof preview>>, key = metadata()) {
  const result = await confirmCommandPreview(db, admin, prepared.preview.previewId, { propertyId: demo.propertyId,
    commandType: "MANAGE_ROOM_CATALOG", expectedEffectHash: prepared.preview.effectHash, confirmation: true,
    reason: { code: "ROOM_CATALOG_CHANGE", note: "本地合成验收" } }, key);
  expect(result.businessCommitted, JSON.stringify(result.error)).toBe(true);
  return result;
}
async function change(input: Parameters<typeof preview>[0]) { return commit(await preview(input)); }
async function newType(name: string, saleMode: "ROOM" | "BED" = "ROOM") {
  const prepared = await preview({ action: "SAVE_TYPE", name, bathroom: "PRIVATE", saleMode, bedCount: 2, capacity: 2 });
  const type = (prepared.preview.effect as unknown as RoomCatalogEffect).after.types.at(-1)!;
  await commit(prepared);
  return type;
}

describe.sequential("administrator room catalog with the restricted runtime role", () => {
  beforeAll(async () => {
    owner = await resetDatabase(url);
    await owner.insertInto("web_sessions").values({ id: admin.credentialId, subject_id: admin.subjectId,
      secret_hash: sha256("synthetic-catalog-session"), expires_at: new Date("2030-01-01"), revoked_at: null }).execute();
    db = createDatabase(runtimeDatabaseUrlForTesting(url));
  }, 120000);
  afterAll(async () => { if (db) await db.destroy(); if (owner) await owner.destroy(); });

  it("passes complete runtime readiness", async () => {
    expect(await databaseReady(db, { staffProfileManifestName: "demo" })).toBe(true);
  });
  it("reads the existing catalog without rewriting it", async () => {
    const catalog = await readRoomCatalog(db, demo.propertyId);
    expect(catalog.rooms.filter((room) => room.active)).toHaveLength(44);
    expect(catalog.types).toHaveLength(8);
    expect(catalog.prices).toHaveLength(8);
    expect(catalog.version).toBe(0);
  });
  it("creates and deletes an unused room type with receipt, audit and replay", async () => {
    const prepared = await preview({ action: "SAVE_TYPE", name: "误建测试房型", bathroom: "PRIVATE", saleMode: "ROOM", bedCount: 1, capacity: 2 });
    const key = metadata();
    const first = await commit(prepared, key);
    expect((await commit(prepared, key)).receiptId).toBe(first.receiptId);
    const type = (await readRoomCatalog(db, demo.propertyId)).types.find((item) => item.name === "误建测试房型")!;
    await change({ action: "DELETE_TYPE", typeCode: type.code });
    expect((await readRoomCatalog(db, demo.propertyId)).types.some((item) => item.code === type.code)).toBe(false);
    expect((await readRoomCatalog(db, demo.propertyId)).history).toHaveLength(2);
  });
  it("reclassifies a room by retaining the old inventory identity and retiring its entire bed set", async () => {
    const catalog = await readRoomCatalog(db, demo.propertyId);
    const old = catalog.rooms.find((room) => room.code === "101")!;
    const target = catalog.types.find((type) => type.code === "shared_bath_double")!;
    await change({ action: "SAVE_ROOM", roomId: old.unitId, code: old.code, buildingCode: old.buildingCode, typeCode: target.code, bedCount: 2, capacity: 2 });
    const room = (await readRoomCatalog(db, demo.propertyId)).rooms.find((item) => item.code === old.code)!;
    expect(room.unitId).not.toBe(old.unitId);
    expect(room.assetId).toBe(old.assetId);
    expect(room.beds).toHaveLength(2);
    expect(await owner.selectFrom("inventory_units").select(["active", "room_type_code"]).where("id", "=", old.unitId).executeTakeFirst()).toEqual({ active: false, room_type_code: "shared_bath_quad" });
    expect(await owner.selectFrom("inventory_units").select("id").where("parent_room_id", "=", old.unitId).where("active", "=", true).execute()).toHaveLength(0);
    await expect(loadInventoryUnit(db, demo.propertyId, old.beds[0]!.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(preview({ action: "DELETE_TYPE", typeCode: target.code })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
  it("publishes scheduled prices, selects by arrival and preserves other room-type schedules", async () => {
    await change({ action: "PUBLISH_RATES", typeCode: "shared_bath_double", effectiveFrom: "2028-11-01", anchors });
    await change({ action: "PUBLISH_RATES", typeCode: "shared_bath_single", effectiveFrom: "2028-10-01", anchors: { ...anchors, "1": 16000 } });
    const november = await resolveCatalogPolicyId(db, demo.propertyId, "2028-11-10");
    const policy = await db.selectFrom("pricing_policy_versions").selectAll().where("id", "=", november!).executeTakeFirstOrThrow();
    expect(policy.product_anchor_rates_minor).toMatchObject({ shared_bath_double_bed: { "1": 8000 }, shared_bath_single_room: { "1": 16000 } });
    const room = (await readRoomCatalog(db, demo.propertyId)).rooms.find((item) => item.code === "101")!;
    const quote = await createQuoteForTesting(db, { propertyId: demo.propertyId, inventoryUnitId: room.beds[0]!.id,
      arrivalDate: "2028-11-10", departureDate: "2028-11-11", pricingPolicyVersionId: november! });
    expect(quote.currentContractAmount.minorUnits).toBe(8000);
    await expect(createQuoteForTesting(db, { propertyId: demo.propertyId, inventoryUnitId: room.beds[0]!.id,
      arrivalDate: "2028-11-10", departureDate: "2028-11-11", pricingPolicyVersionId: demo.publicPricingPolicyId })).rejects.toMatchObject({ code: "PREVIEW_STALE" });
  });
  it("locks the original price on an existing booking and blocks structural changes until its booking is handled", async () => {
    const room = (await readRoomCatalog(db, demo.propertyId)).rooms.find((item) => item.code === "101")!;
    const policyId = (await resolveCatalogPolicyId(db, demo.propertyId, "2028-11-15"))!;
    const quote = await createQuoteForTesting(db, { propertyId: demo.propertyId, inventoryUnitId: room.beds[0]!.id,
      arrivalDate: "2028-11-15", departureDate: "2028-11-16", pricingPolicyVersionId: policyId });
    const prepared = await createCommandPreview(db, admin, { commandType: "CREATE_ORDER", input: { propertyId: demo.propertyId,
      quoteId: quote.quoteId, primaryGuest: { fullName: "价格验收", nickname: "价格验收" }, bookingChannelCode: "WECOM" } }, metadata());
    const receipt = await confirmCommandPreview(db, admin, prepared.preview.previewId, { propertyId: demo.propertyId, commandType: "CREATE_ORDER",
      expectedEffectHash: prepared.preview.effectHash, confirmation: true, reason: { code: "CREATE_STANDARD_ORDER", note: "" } }, metadata());
    expect(receipt.businessCommitted, JSON.stringify(receipt.error)).toBe(true);
    const orderId = String(receipt.result!.orderId);
    lockedOrderId = orderId;
    await change({ action: "PUBLISH_RATES", typeCode: "shared_bath_double", effectiveFrom: "2028-11-01", anchors: { ...anchors, "1": 9000 } });
    const order = await db.selectFrom("orders").select("pricing_policy_version_id").where("id", "=", orderId).executeTakeFirstOrThrow();
    expect(order.pricing_policy_version_id).toBe(policyId);
    await expect(preview({ action: "SET_ROOM_ACTIVE", roomId: room.unitId, active: false })).rejects.toMatchObject({ code: "INVENTORY_CONFLICT" });
    const rescheduled = await createCommandPreview(db, admin, { commandType: "RESCHEDULE_STAY", input: { propertyId: demo.propertyId, orderId,
      newArrivalDate: "2028-11-15", newDepartureDate: "2028-11-17" } }, metadata());
    expect(rescheduled.preview.effect).toMatchObject({ after: { pricing: { currentContractAmount: { minorUnits: 16000 } } } });
    expect(await getOrderView(db, orderId, "WRITE")).toBeDefined();
  });
  it("rejects a stale maintenance preview without partial changes", async () => {
    const stale = await preview({ action: "SAVE_TYPE", name: "并发原稿", bathroom: "PRIVATE", saleMode: "ROOM", bedCount: 1, capacity: 1 });
    await newType("并发先完成");
    const result = await confirmCommandPreview(db, admin, stale.preview.previewId, { propertyId: demo.propertyId, commandType: "MANAGE_ROOM_CATALOG",
      expectedEffectHash: stale.preview.effectHash, confirmation: true, reason: { code: "ROOM_CATALOG_CHANGE", note: "过期稿" } }, metadata());
    expect(result.businessCommitted).toBe(false);
    expect(result.error?.code).toBe("PREVIEW_STALE");
    expect((await readRoomCatalog(db, demo.propertyId)).types.some((type) => type.name === "并发原稿")).toBe(false);
  });
  it("allows a new bed structure and retires and restores it without losing versions", async () => {
    const type = await newType("六床测试房", "BED");
    await change({ action: "SAVE_ROOM", code: "TEST-601", buildingCode: "测试", typeCode: type.code, bedCount: 6, capacity: 6 });
    let room = (await readRoomCatalog(db, demo.propertyId)).rooms.find((item) => item.code === "TEST-601")!;
    expect(room.beds).toHaveLength(6);
    await change({ action: "SET_ROOM_ACTIVE", roomId: room.unitId, active: false });
    expect((await readRoomCatalog(db, demo.propertyId)).rooms.find((item) => item.code === room.code)?.active).toBe(false);
    await change({ action: "SET_ROOM_ACTIVE", roomId: room.unitId, active: true });
    const restored = (await readRoomCatalog(db, demo.propertyId)).rooms.find((item) => item.code === room.code)!;
    expect(restored.active).toBe(true);
    expect(restored.unitId).not.toBe(room.unitId);
    expect(restored.assetId).toBe(room.assetId);
  });
  it("serializes simultaneous settings confirmations", async () => {
    const drafts = await Promise.all(["竞争甲", "竞争乙"].map((name) => preview({ action: "SAVE_TYPE", name, bathroom: "PRIVATE", saleMode: "ROOM", bedCount: 1, capacity: 1 })));
    const results = await Promise.all(drafts.map((draft) => confirmCommandPreview(db, admin, draft.preview.previewId, {
      propertyId: demo.propertyId, commandType: "MANAGE_ROOM_CATALOG", expectedEffectHash: draft.preview.effectHash,
      confirmation: true, reason: { code: "ROOM_CATALOG_CHANGE", note: "同时修改" } }, metadata())));
    expect(results.filter((result) => result.businessCommitted)).toHaveLength(1);
    expect(results.find((result) => !result.businessCommitted)?.error?.code).toBe("PREVIEW_STALE");
    expect((await readRoomCatalog(db, demo.propertyId)).types.filter((type) => ["竞争甲", "竞争乙"].includes(type.name))).toHaveLength(1);
  });
  it("prices six beds and prevents simultaneous whole-room and single-bed sales", async () => {
    const room = (await readRoomCatalog(db, demo.propertyId)).rooms.find((item) => item.code === "TEST-601")!;
    await change({ action: "PUBLISH_RATES", typeCode: room.typeCode, effectiveFrom: "2028-10-01", anchors });
    const policy = (await resolveCatalogPolicyId(db, demo.propertyId, "2028-12-01"))!;
    const quotes = await Promise.all([room.unitId, room.beds[0]!.id].map((inventoryUnitId) => createQuoteForTesting(db, {
      propertyId: demo.propertyId, inventoryUnitId, arrivalDate: "2028-12-01", departureDate: "2028-12-02", pricingPolicyVersionId: policy })));
    expect(quotes.map((quote) => quote.currentContractAmount.minorUnits)).toEqual([48000, 8000]);
    const drafts = await Promise.all(quotes.map((quote) => createCommandPreview(db, admin, { commandType: "CREATE_ORDER", input: {
      propertyId: demo.propertyId, quoteId: quote.quoteId, primaryGuest: { fullName: "并发房客", nickname: "并发房客" }, bookingChannelCode: "WECOM"
    } }, metadata())));
    const results = await Promise.all(drafts.map((draft) => confirmCommandPreview(db, admin, draft.preview.previewId, {
      propertyId: demo.propertyId, commandType: "CREATE_ORDER", expectedEffectHash: draft.preview.effectHash, confirmation: true,
      reason: { code: "CREATE_STANDARD_ORDER", note: "" }
    }, metadata())));
    expect(results.filter((result) => result.businessCommitted)).toHaveLength(1);
    await expect(preview({ action: "SET_TYPE_ACTIVE", typeCode: room.typeCode, active: false })).rejects.toMatchObject({ code: "INVENTORY_CONFLICT" });
  });
  it("arbitrates new booking against concurrent room retirement", async () => {
    const room = (await readRoomCatalog(db, demo.propertyId)).rooms.find((item) => item.code === "102")!;
    const quote = await createQuoteForTesting(db, { propertyId: demo.propertyId, inventoryUnitId: room.beds[0]!.id,
      arrivalDate: "2028-12-05", departureDate: "2028-12-06", pricingPolicyVersionId: (await resolveCatalogPolicyId(db, demo.propertyId, "2028-12-05"))! });
    const booking = await createCommandPreview(db, admin, { commandType: "CREATE_ORDER", input: { propertyId: demo.propertyId,
      quoteId: quote.quoteId, primaryGuest: { fullName: "竞争预订", nickname: "竞争预订" }, bookingChannelCode: "WECOM" } }, metadata());
    const retirement = await preview({ action: "SET_ROOM_ACTIVE", roomId: room.unitId, active: false });
    const results = await Promise.all([
      confirmCommandPreview(db, admin, booking.preview.previewId, { propertyId: demo.propertyId, commandType: "CREATE_ORDER",
        expectedEffectHash: booking.preview.effectHash, confirmation: true, reason: { code: "CREATE_STANDARD_ORDER", note: "" } }, metadata()),
      confirmCommandPreview(db, admin, retirement.preview.previewId, { propertyId: demo.propertyId, commandType: "MANAGE_ROOM_CATALOG",
        expectedEffectHash: retirement.preview.effectHash, confirmation: true, reason: { code: "ROOM_CATALOG_CHANGE", note: "竞争停用" } }, metadata())
    ]);
    expect(results.filter((result) => result.businessCommitted)).toHaveLength(1);
    const final = (await readRoomCatalog(db, demo.propertyId)).rooms.find((item) => item.code === room.code)!;
    const claims = await db.selectFrom("inventory_claims").select("id").where("room_id", "=", room.unitId).where("active", "=", true).execute();
    expect(final.active ? claims.length > 0 : claims.length === 0).toBe(true);
  });
  it("rechecks revoked administrator sessions", async () => {
    const draft = await preview({ action: "SAVE_TYPE", name: "失效会话", bathroom: "PRIVATE", saleMode: "ROOM", bedCount: 1, capacity: 1 });
    await owner.updateTable("web_sessions").set({ revoked_at: new Date() }).where("id", "=", admin.credentialId).execute();
    try {
      await expect(confirmCommandPreview(db, admin, draft.preview.previewId, { propertyId: demo.propertyId, commandType: "MANAGE_ROOM_CATALOG",
        expectedEffectHash: draft.preview.effectHash, confirmation: true, reason: { code: "ROOM_CATALOG_CHANGE", note: "已撤销" } }, metadata())).rejects.toMatchObject({ code: "AUTHENTICATION_REQUIRED" });
    } finally {
      await owner.updateTable("web_sessions").set({ revoked_at: null }).where("id", "=", admin.credentialId).execute();
    }
    expect((await readRoomCatalog(db, demo.propertyId)).types.some((type) => type.name === "失效会话")).toBe(false);
  });
  it("serves HTTP catalog and trial contracts and rejects cross-property reads", async () => {
    const app = await buildServer(createDatabase(runtimeDatabaseUrlForTesting(url)));
    try {
      const cookies = { qintopia_session: "synthetic-catalog-session" };
      const current = await app.inject({ method: "GET", url: `/api/v1/properties/${demo.propertyId}/room-catalog`, cookies });
      expect(current.statusCode, current.body).toBe(200);
      expect(current.json().rooms.length).toBeGreaterThan(0);
      const denied = await app.inject({ method: "GET", url: "/api/v1/properties/ungranted/room-catalog", cookies });
      expect(denied.statusCode).toBe(403);
      const trial = await app.inject({ method: "POST", url: `/api/v1/properties/${demo.propertyId}/room-rate-trial`, cookies,
        payload: { anchors, arrivalDate: "2028-12-01", departureDate: "2028-12-14", multiplier: 6 } });
      expect(trial.statusCode, trial.body).toBe(200);
      expect(trial.json()).toEqual({ nights: 13, anchorNights: 7, amountMinor: 445700 });
      const postPreview = async (input: Record<string, unknown>) => {
        const response = await app.inject({ method: "POST", url: "/api/v1/command-previews", cookies,
          headers: { "idempotency-key": `http-${++sequence}`, "x-correlation-id": `http-${sequence}` },
          payload: { commandType: "MANAGE_ROOM_CATALOG", input: { propertyId: demo.propertyId,
            expectedVersion: (await readRoomCatalog(db, demo.propertyId)).version, ...input } } });
        expect(response.statusCode, response.body).toBe(200);
        return response.json().preview;
      };
      const postConfirm = async (draft: { previewId: string; effectHash: string }) => {
        const response = await app.inject({ method: "POST", url: `/api/v1/command-previews/${draft.previewId}/confirm`, cookies,
          headers: { "idempotency-key": `http-${++sequence}`, "x-correlation-id": `http-${sequence}` },
          payload: { propertyId: demo.propertyId, commandType: "MANAGE_ROOM_CATALOG", expectedEffectHash: draft.effectHash,
            confirmation: true, reason: { code: "ROOM_CATALOG_CHANGE", note: "HTTP 验收" } } });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json()).toMatchObject({ businessCommitted: true, result: { changeId: expect.any(String) } });
      };
      const created = await postPreview({ action: "SAVE_TYPE", name: "HTTP 双床房", bathroom: "PRIVATE", saleMode: "ROOM", bedCount: 2, capacity: 2 });
      await postConfirm(created);
      const typeCode = created.effect.after.types.at(-1).code;
      await postPreview({ action: "DELETE_TYPE", typeCode });
      await postPreview({ action: "SET_TYPE_ACTIVE", typeCode, active: false });
      const published = await postPreview({ action: "PUBLISH_RATES", typeCode, effectiveFrom: "2028-10-01", anchors });
      expect(published.effect.after.rates.at(-1).anchors).toEqual(anchors);
      await postConfirm(published);
      const roomDraft = await postPreview({ action: "SAVE_ROOM", typeCode, code: "HTTP-1", buildingCode: "测试", bedCount: 2, capacity: 2 });
      await postConfirm(roomDraft);
      await postPreview({ action: "SET_ROOM_ACTIVE", roomId: roomDraft.effect.roomLink.newUnitId, active: false });
    } finally { await app.close(); }
  });
  it("keeps the last supply for a live membership and rolls back incomplete catalog commands", async () => {
    await expect(preview({ action: "SET_TYPE_ACTIVE", typeCode: "shared_bath_single", active: false })).rejects.toMatchObject({ code: "ENTITLEMENT_CONFLICT" });
    const before = await readRoomCatalog(db, demo.propertyId);
    const draft = await preview({ action: "SAVE_TYPE", name: "必须回滚", bathroom: "PRIVATE", saleMode: "ROOM", bedCount: 1, capacity: 1 });
    await expect(db.transaction().execute(async (trx) => {
      await trx.insertInto("command_executions").values({ id: "catalog_incomplete", subject_id: admin.subjectId,
        credential_id: admin.credentialId, property_id: demo.propertyId, command_type: "MANAGE_ROOM_CATALOG",
        idempotency_key: "catalog_incomplete", request_hash: sha256("incomplete"), correlation_id: "catalog_incomplete",
        state: "EXECUTING", completed_at: null }).execute();
      await sql`select qintopia_apply_room_catalog('catalog_incomplete', ${JSON.stringify(draft.preview.effect)}::jsonb, '缺少回执')`.execute(trx);
    })).rejects.toThrow("catalog command requires matching change, receipt and audit");
    const after = await readRoomCatalog(db, demo.propertyId);
    expect(after.version).toBe(before.version);
    expect(after.history).toEqual(before.history);
    expect(after.types.some((type) => type.name === "必须回滚")).toBe(false);
  });
  it("fails readiness if a catalog guard is disabled and recovers after rollback", async () => {
    const rollback = new Error("rollback catalog guard probe");
    await expect(owner.transaction().execute(async (trx) => {
      await sql`alter table room_catalog_changes disable trigger room_catalog_changes_commit_guard`.execute(trx);
      expect(await databaseReady(trx, { identity: "maintenance-owner", staffProfileManifestName: "demo" })).toBe(false);
      throw rollback;
    })).rejects.toBe(rollback);
    expect(await databaseReady(db, { staffProfileManifestName: "demo" })).toBe(true);
  });
  it("denies ordinary staff, tokens and direct runtime projection mutation", async () => {
    const input = { propertyId: demo.propertyId, expectedVersion: (await readRoomCatalog(db, demo.propertyId)).version,
      action: "SAVE_TYPE", name: "越权", bathroom: "PRIVATE", saleMode: "ROOM", bedCount: 1, capacity: 1 };
    const token: AuthPrincipal = { ...admin, credentialType: "TOKEN", credentialId: "token_demo_admin_write", ...authScope({ profile: "administrator" }) };
    await expect(createCommandPreview(db, token, { commandType: "MANAGE_ROOM_CATALOG", input }, metadata())).rejects.toMatchObject({ code: "INSUFFICIENT_ACCESS" });
    const staff = { ...admin, subjectId: demo.agentSubjectId, ...authScope({ credentialType: "SESSION" }) };
    await expect(createCommandPreview(db, staff, { commandType: "MANAGE_ROOM_CATALOG", input }, metadata())).rejects.toMatchObject({ code: "INSUFFICIENT_ACCESS" });
    await expect(sql`update room_catalog_state set version=999 where property_id=${demo.propertyId}`.execute(db)).rejects.toThrow();
    await expect(sql`update inventory_units set active=false where code='A01'`.execute(db)).rejects.toThrow();
  });
  it("keeps historical room identity after a handled booking and subsequent reclassification", async () => {
    const draft = await createCommandPreview(db, admin, { commandType: "CANCEL_ORDER", input: {
      propertyId: demo.propertyId, orderId: lockedOrderId } }, metadata());
    const result = await confirmCommandPreview(db, admin, draft.preview.previewId, { propertyId: demo.propertyId,
      commandType: "CANCEL_ORDER", expectedEffectHash: draft.preview.effectHash, confirmation: true,
      reason: { code: "CANCEL_ORDER", note: "先处理订单再调整房型" } }, metadata());
    expect(result.businessCommitted, JSON.stringify(result.error)).toBe(true);
    const before = await getOrderView(db, lockedOrderId, "WRITE");
    const room = (await readRoomCatalog(db, demo.propertyId)).rooms.find((item) => item.code === "101")!;
    await change({ action: "SAVE_ROOM", roomId: room.unitId, typeCode: "private_bath_standard", code: room.code,
      buildingCode: room.buildingCode, bedCount: 2, capacity: 2 });
    const after = await getOrderView(db, lockedOrderId, "WRITE");
    expect(after.referencedInventoryUnits).toEqual(before.referencedInventoryUnits.map((unit) => ({ ...unit, active: false })));
    expect(after.currentSegment).toEqual(before.currentSegment);
    expect(after.order.pricing_policy_version_id).toBe(before.order.pricing_policy_version_id);
  });
  it("persists building order before pagination, appends new buildings and preserves business facts", async () => {
    const beforeNew = await readRoomCatalog(db, demo.propertyId);
    await change({ action: "SAVE_ROOM", code: "000-F", buildingCode: "F", typeCode: "private_bath_standard", bedCount: 2, capacity: 2 });
    const current = await readRoomCatalog(db, demo.propertyId);
    expect(current.buildingOrder).toEqual([...beforeNew.buildingOrder!, "F"]);
    const order = current.buildingOrder!.filter((code) => code !== "F");
    order.splice(order.indexOf("E") + 1, 0, "F");
    const units = await owner.selectFrom("inventory_units").selectAll().orderBy("id").execute();
    const policies = await owner.selectFrom("pricing_policy_versions").selectAll().orderBy("id").execute();
    const claims = await owner.selectFrom("inventory_claims").selectAll().orderBy("id").execute();
    const draft = await preview({ action: "SET_BUILDING_ORDER", buildingOrder: order });
    const key = metadata();
    const result = await commit(draft, key);
    expect((await commit(draft, key)).receiptId).toBe(result.receiptId);
    const reloaded = await readRoomCatalog(db, demo.propertyId);
    expect(reloaded.buildingOrder).toEqual(order);
    expect(reloaded.history[0]?.title).toBe("调整楼栋顺序");
    expect(await owner.selectFrom("inventory_units").selectAll().orderBy("id").execute()).toEqual(units);
    expect(await owner.selectFrom("pricing_policy_versions").selectAll().orderBy("id").execute()).toEqual(policies);
    expect(await owner.selectFrom("inventory_claims").selectAll().orderBy("id").execute()).toEqual(claims);
    const options = { propertyId: demo.propertyId, arrivalDate: "2028-12-01", departureDate: "2028-12-02",
      accessLevel: "READ" as const, commandGrants: new Set<string>(), requestingSubjectId: admin.subjectId };
    const all = await getRoomStatusBoard(db, { ...options, pageSize: 200 });
    const visibleOrder = [...new Set(all.rooms.map((room) => room.buildingCode))];
    expect(visibleOrder.indexOf("F")).toBe(visibleOrder.indexOf("E") + 1);
    const firstPage = await getRoomStatusBoard(db, { ...options, pageSize: 3 });
    expect(firstPage.rooms.map((room) => room.id)).toEqual(all.rooms.slice(0, 3).map((room) => room.id));
    await change({ action: "SAVE_ROOM", code: "000-G", buildingCode: "新楼栋", typeCode: "private_bath_standard", bedCount: 2, capacity: 2 });
    expect((await readRoomCatalog(db, demo.propertyId)).buildingOrder).toEqual([...order, "新楼栋"]);
  });
  it("rejects incomplete, duplicate, unknown, stale and unauthorized building order changes", async () => {
    const current = await readRoomCatalog(db, demo.propertyId);
    const order = current.buildingOrder!;
    for (const invalid of [order.slice(1), [...order.slice(1), order[1]!], [...order.slice(1), "不存在"]]) {
      await expect(preview({ action: "SET_BUILDING_ORDER", buildingOrder: invalid })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }
    const reversed = [...order].reverse();
    const stale = await preview({ action: "SET_BUILDING_ORDER", buildingOrder: reversed });
    await newType("排序并发测试房型");
    const rejected = await confirmCommandPreview(db, admin, stale.preview.previewId, { propertyId: demo.propertyId,
      commandType: "MANAGE_ROOM_CATALOG", expectedEffectHash: stale.preview.effectHash, confirmation: true,
      reason: { code: "ROOM_CATALOG_CHANGE", note: "过期排序" } }, metadata());
    expect(rejected.businessCommitted).toBe(false);
    expect(rejected.error?.code).toBe("PREVIEW_STALE");
    expect((await readRoomCatalog(db, demo.propertyId)).buildingOrder).toEqual(order);
    const input = { propertyId: demo.propertyId, expectedVersion: current.version, action: "SET_BUILDING_ORDER", buildingOrder: reversed };
    const staff = { ...admin, subjectId: demo.agentSubjectId, ...authScope({ credentialType: "SESSION" }) };
    await expect(createCommandPreview(db, staff, { commandType: "MANAGE_ROOM_CATALOG", input }, metadata())).rejects.toMatchObject({ code: "INSUFFICIENT_ACCESS" });
    await expect(createCommandPreview(db, admin, { commandType: "MANAGE_ROOM_CATALOG", input: { ...input, propertyId: "ungranted" } }, metadata())).rejects.toMatchObject({ code: "INSUFFICIENT_ACCESS" });
  });

  it("rejects forged ordering effects at the database boundary and rolls back", async () => {
    const current = await readRoomCatalog(db, demo.propertyId);
    const draft = await preview({ action: "SET_BUILDING_ORDER", buildingOrder: [...current.buildingOrder!].reverse() });
    const invalidOrder = structuredClone(draft.preview.effect) as unknown as RoomCatalogEffect;
    invalidOrder.after.buildingOrder = ["other-property-building"];
    const invalidPricing = structuredClone(draft.preview.effect) as unknown as RoomCatalogEffect;
    invalidPricing.after.types[0]!.name = "cannot change types while sorting";
    for (const [effect, message] of [[invalidOrder, "building order must contain each property building exactly once"],
      [invalidPricing, "building order cannot change inventory or pricing"]] as const) {
      await expect(owner.transaction().execute(async (trx) => {
        const source = await trx.selectFrom("command_previews").selectAll().where("id", "=", draft.preview.previewId).executeTakeFirstOrThrow();
        await trx.insertInto("command_previews").values({ ...source, id: `forged_order_preview_${++sequence}`,
          effect: effect as unknown as Record<string, unknown> }).execute();
        await sql`set local role qintopia_runtime`.execute(trx);
        const id = `catalog_bad_order_${++sequence}`;
        await trx.insertInto("command_executions").values({ id, subject_id: admin.subjectId,
          credential_id: admin.credentialId, property_id: demo.propertyId, command_type: "MANAGE_ROOM_CATALOG",
          idempotency_key: id, request_hash: sha256(id), correlation_id: id, state: "EXECUTING", completed_at: null }).execute();
        await sql`select qintopia_apply_room_catalog(${id}, ${JSON.stringify(effect)}::jsonb, 'database boundary probe')`.execute(trx);
      })).rejects.toThrow(message);
    }
    expect(await readRoomCatalog(db, demo.propertyId)).toEqual(current);
  });

});
