import { sql, type Transaction } from "kysely";
import { DomainError, roomCatalogActions, type CatalogInventoryInsert, type CatalogPolicyInsert, type ManagedRoom,
  type ManagedRoomType, type RoomCatalogEffect, type RoomCatalogInput, type RoomCatalogSnapshot, type RoomCatalogView,
  type RoomRateAnchors } from "@qintopia/contracts";
import { catalogAnchorsAt, parseLocalDate, stableHash, validateRoomRateAnchors } from "@qintopia/domain";
import type { DbExecutor } from "./inventory.ts";
import type { Database } from "./schema.ts";
import { propertyLocalToday } from "./members.ts";

const managedPolicyCode = "MANAGED_ROOM_PRICES";

function object<T>(value: unknown): T { return (typeof value === "string" ? JSON.parse(value) : value) as T; }
function text(value: unknown, label: string, max = 100): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max || /[\u0000-\u001f]/.test(value)) {
    throw new DomainError("VALIDATION_ERROR", `${label}不能为空且不能超过 ${max} 个字符`);
  }
  return value.trim();
}
function count(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 100) throw new DomainError("VALIDATION_ERROR", `${label}须为 1 至 100 的整数`);
  return Number(value);
}
function flag(value: unknown): boolean {
  if (typeof value !== "boolean") throw new DomainError("VALIDATION_ERROR", "请选择启用或停用");
  return value;
}
async function inventoryRows(db: DbExecutor, propertyId: string) {
  return db.selectFrom("inventory_units").selectAll().where("property_id", "=", propertyId).orderBy("code").orderBy("id").execute();
}

export async function lockRoomCatalog(trx: Transaction<Database>, propertyId: string, exclusive = false) {
  const key = `qintopia:room-catalog:${propertyId}`;
  if (exclusive) await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0::bigint))`.execute(trx);
  else await sql`select pg_advisory_xact_lock_shared(hashtextextended(${key}, 0::bigint))`.execute(trx);
}

async function catalogBasis(db: DbExecutor, propertyId: string) {
  const property = await db.selectFrom("properties").selectAll().where("id", "=", propertyId).executeTakeFirst();
  if (!property) throw new DomainError("NOT_FOUND", "门店不存在", 404);
  const [units, stateRow, links, references, baselines] = await Promise.all([
    inventoryRows(db, propertyId),
    db.selectFrom("room_catalog_state").selectAll().where("property_id", "=", propertyId).executeTakeFirst(),
    db.selectFrom("room_catalog_links as link").innerJoin("inventory_units as unit", "unit.id", "link.unit_id")
      .select(["link.unit_id", "link.asset_id", "link.version"]).where("unit.property_id", "=", propertyId).execute(),
    db.selectFrom("inventory_catalog_entries as entry").innerJoin("catalog_import_batches as batch", "batch.id", "entry.import_batch_id")
      .select(["entry.type_code", "entry.type_name"]).where("batch.property_id", "=", propertyId).orderBy("batch.created_at").execute(),
    db.selectFrom("pricing_policy_versions").selectAll().where("property_id", "=", propertyId)
      .where("calculation_kind", "=", "DURATION_BAND_TOTAL").where("code", "!=", managedPolicyCode)
      .orderBy("effective_from").orderBy("version").orderBy("id").execute()
  ]);
  const latestByAsset = new Map<string, typeof links[number]>();
  for (const link of links) {
    if ((latestByAsset.get(link.asset_id)?.version ?? -1) < link.version) latestByAsset.set(link.asset_id, link);
  }
  const linkByUnit = new Map(links.map((link) => [link.unit_id, link]));
  const rooms: ManagedRoom[] = units.filter((unit) => unit.kind === "ROOM" && (!linkByUnit.has(unit.id)
    || latestByAsset.get(linkByUnit.get(unit.id)!.asset_id)?.unit_id === unit.id)).map((room) => ({
    assetId: linkByUnit.get(room.id)?.asset_id ?? room.id, unitId: room.id, code: room.code,
    buildingCode: room.building_code ?? "", typeCode: room.room_type_code ?? "", bedCount: room.physical_bed_count ?? 1,
    capacity: room.occupancy_capacity, active: room.active,
    beds: units.filter((unit) => unit.parent_room_id === room.id).map((bed) => ({ id: bed.id, code: bed.code, active: bed.active }))
  }));
  let snapshot: RoomCatalogSnapshot;
  if (stateRow) snapshot = object<RoomCatalogSnapshot>(stateRow.snapshot);
  else {
    const labels = new Map(references.map((entry) => [entry.type_code, entry.type_name]));
    const types: ManagedRoomType[] = [];
    for (const room of rooms) {
      if (!room.typeCode || types.some((type) => type.code === room.typeCode)) continue;
      const unit = units.find((item) => item.id === room.unitId)!;
      const saleMode = unit.inventory_basis === "WHOLE_ROOM_COMBINATION" ? "BED" : "ROOM";
      const name = labels.get(room.typeCode) ?? unit.name.replace(/^Room\s+/i, "").replace(room.code, "").trim();
      const members = units.filter((candidate) => candidate.room_type_code === room.typeCode);
      const products: ManagedRoomType["products"] = [];
      for (const item of members) {
        if (!item.pricing_product_code || products.some((product) => product.code === item.pricing_product_code)) continue;
        products.push({ code: item.pricing_product_code, kind: item.kind,
          multiplier: item.kind === "ROOM" && saleMode === "BED" ? item.physical_bed_count ?? room.bedCount : 1 });
      }
      types.push({ code: room.typeCode, name: name.replace(/^[·•]\s*/, "") || room.typeCode, bathroom: room.typeCode.includes("private") ? "PRIVATE" : "SHARED",
        saleMode, bedCount: room.bedCount, capacity: room.capacity, active: rooms.some((item) => item.typeCode === room.typeCode && item.active), products });
    }
    snapshot = { version: 0, types: types.sort((a, b) => a.code.localeCompare(b.code)), rates: [] };
  }
  return { property, units, rooms, snapshot, baselines };
}

function baselineAt(baselines: Awaited<ReturnType<typeof catalogBasis>>["baselines"], date: string) {
  const last = baselines.filter((policy) => policy.effective_from && policy.effective_from <= date
    && (!policy.effective_until || date < policy.effective_until)).at(-1);
  return last ? object<Record<string, RoomRateAnchors>>(last.product_anchor_rates_minor) : {};
}

export async function readRoomCatalog(db: DbExecutor, propertyId: string): Promise<RoomCatalogView> {
  if (!db.isTransaction) return db.transaction().execute(async (trx) => {
    await lockRoomCatalog(trx, propertyId);
    return readRoomCatalog(trx, propertyId);
  });
  const basis = await catalogBasis(db, propertyId);
  const businessDate = await propertyLocalToday(db, propertyId);
  const changes = await db.selectFrom("room_catalog_changes as change").innerJoin("command_executions as execution", "execution.id", "change.command_id")
    .innerJoin("subjects as subject", "subject.id", "execution.subject_id")
    .select(["change.id", "change.effect", "change.reason", "change.created_at", "subject.display_name"])
    .where("change.property_id", "=", propertyId).orderBy("change.created_at", "desc").limit(100).execute();
  const anchors = catalogAnchorsAt(businessDate, baselineAt(basis.baselines, businessDate), basis.snapshot.types, basis.snapshot.rates);
  const prices = basis.snapshot.types.flatMap((type) => {
    const product = type.products.find((item) => item.kind === type.saleMode && item.multiplier === 1);
    const value = product ? anchors[product.code] : undefined;
    const last = basis.snapshot.rates.filter((rate) => rate.typeCode === type.code && rate.effectiveFrom <= businessDate)
      .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom) || a.version - b.version).at(-1);
    return value ? [{ typeCode: type.code, anchors: value, effectiveFrom: last?.effectiveFrom
      ?? basis.baselines.filter((policy) => policy.effective_from && policy.effective_from <= businessDate).at(-1)?.effective_from ?? businessDate }] : [];
  });
  return { ...basis.snapshot, propertyId, businessDate, rooms: basis.rooms, prices, history: changes.map((row) => {
    const effect = object<RoomCatalogEffect>(row.effect);
    return { id: row.id, action: effect.action, title: effect.title, description: effect.description,
      operator: row.display_name, reason: row.reason, createdAt: row.created_at.toISOString() };
  }) };
}

async function assertRoomsUnused(db: DbExecutor, propertyId: string, rooms: ManagedRoom[]) {
  if (!rooms.length) return;
  const roomIds = rooms.map((room) => room.unitId);
  const unitIds = rooms.flatMap((room) => [room.unitId, ...room.beds.map((bed) => bed.id)]);
  const [claims, coverage, bookings, maintenance, internal] = await Promise.all([
    db.selectFrom("inventory_claims").select("id").where("property_id", "=", propertyId).where("room_id", "in", roomIds).where("active", "=", true).limit(1).execute(),
    db.selectFrom("coverage_items").select("id").where("inventory_unit_id", "in", unitIds).where("status", "=", "HELD").limit(1).execute(),
    db.selectFrom("stay_segments as segment").innerJoin("stays as stay", "stay.id", "segment.stay_id")
      .innerJoin("orders as booking", "booking.id", "stay.order_id").select("booking.id")
      .where("segment.inventory_unit_id", "in", unitIds).where("booking.status", "in", ["RESERVED", "CHECKED_IN"]).limit(1).execute(),
    db.selectFrom("maintenance_locks").select("id").where("inventory_unit_id", "in", unitIds).where("status", "=", "ACTIVE").limit(1).execute(),
    db.selectFrom("internal_use_blocks").select("id").where("room_id", "in", roomIds).where("status", "=", "ACTIVE").limit(1).execute()
  ]);
  if ([claims, coverage, bookings, maintenance, internal].some((rows) => rows.length)) {
    throw new DomainError("INVENTORY_CONFLICT", "有关联预订、在住、维修或权益占用，请先处理后再调整房型或床位", 409,
      false, { roomCodes: rooms.map((room) => room.code), orderIds: bookings.map((row) => row.id) });
  }
}

async function protectMembershipSupply(db: DbExecutor, propertyId: string, affected: ManagedRoom[], all: ManagedRoom[], replacementType?: string) {
  const removed = new Set(affected.map((room) => room.unitId));
  const today = await propertyLocalToday(db, propertyId);
  for (const code of new Set(affected.filter((room) => room.active).map((room) => room.typeCode))) {
    if (replacementType === code || all.some((room) => room.active && room.typeCode === code && !removed.has(room.unitId))) continue;
    const membership = await db.selectFrom("membership_orders").select("id").where("property_id", "=", propertyId)
      .where("allowed_room_type_code", "=", code).where("status", "=", "ACTIVE").where("valid_until", ">", today).limit(1).executeTakeFirst();
    if (membership) throw new DomainError("ENTITLEMENT_CONFLICT", "该房型仍有未到期会员合同，不能停用最后一间适用房源；请先明确会员权益安排", 409);
  }
}

function preparePolicies(basis: Awaited<ReturnType<typeof catalogBasis>>, next: RoomCatalogSnapshot): CatalogPolicyInsert[] {
  const dates = [...new Set([...basis.baselines.flatMap((policy) => policy.effective_from ? [policy.effective_from] : []),
    ...next.rates.map((rate) => rate.effectiveFrom)])].sort();
  return dates.flatMap((date) => {
    const anchors = catalogAnchorsAt(date, baselineAt(basis.baselines, date), next.types, next.rates);
    if (!Object.keys(anchors).length) return [];
    return [{ id: `policy_catalog_${stableHash({ property: basis.property.id, version: next.version, date, anchors }).slice(0, 40)}`,
      effectiveFrom: date, anchors }];
  });
}

export async function buildRoomCatalogEffect(db: DbExecutor, raw: Record<string, unknown>) {
  const propertyId = text(raw.propertyId, "门店");
  const basis = await catalogBasis(db, propertyId);
  if (!Number.isInteger(raw.expectedVersion) || raw.expectedVersion !== basis.snapshot.version) throw new DomainError("AGGREGATE_VERSION_CONFLICT", "设置已被修改，请刷新后重试", 409);
  if (!(roomCatalogActions as readonly unknown[]).includes(raw.action)) throw new DomainError("VALIDATION_ERROR", "不支持的房型管理操作");
  const input = raw as unknown as RoomCatalogInput;
  const next = structuredClone(basis.snapshot);
  next.version += 1;
  const suffix = stableHash({ propertyId, input, version: next.version }).slice(0, 24);
  const effect: RoomCatalogEffect = { operation: "MANAGE_ROOM_CATALOG", propertyId, action: input.action,
    title: "", description: [], beforeVersion: basis.snapshot.version, after: next, retireUnitIds: [], insertUnits: [], roomLink: null, policies: [] };
  const selectedType = input.typeCode ? next.types.find((type) => type.code === input.typeCode) : undefined;
  const selectedRoom = input.roomId ? basis.rooms.find((room) => room.unitId === input.roomId) : undefined;
  if (input.typeCode && !selectedType) throw new DomainError("NOT_FOUND", "房型不存在", 404);
  if (input.roomId && !selectedRoom) throw new DomainError("NOT_FOUND", "房间已调整，请刷新", 404);
  const requireType = () => { if (!selectedType) throw new DomainError("VALIDATION_ERROR", "请选择房型"); return selectedType; };
  const requireRoom = () => { if (!selectedRoom) throw new DomainError("VALIDATION_ERROR", "请选择房间"); return selectedRoom; };
  const retire = async (rooms: ManagedRoom[], replacementType?: string) => {
    await assertRoomsUnused(db, propertyId, rooms);
    await protectMembershipSupply(db, propertyId, rooms, basis.rooms, replacementType);
    effect.retireUnitIds = rooms.flatMap((room) => [room.unitId, ...room.beds.map((bed) => bed.id)]).sort();
  };

  if (input.action === "SAVE_TYPE") {
    const name = text(input.name, "房型名称", 60);
    if (!["PRIVATE", "SHARED"].includes(input.bathroom ?? "") || !["ROOM", "BED"].includes(input.saleMode ?? "")) throw new DomainError("VALIDATION_ERROR", "请选择卫浴类型和销售方式");
    if (next.types.some((type) => type.code !== selectedType?.code && type.name === name)) throw new DomainError("VALIDATION_ERROR", "已有同名房型");
    const bedCount = count(input.bedCount, "默认床数"), capacity = count(input.capacity, "默认可住人数");
    if (input.saleMode === "BED" && capacity !== bedCount) throw new DomainError("VALIDATION_ERROR", "按床售卖的房型每床住一人，可住人数须与床数相同");
    if (selectedType && selectedType.saleMode !== input.saleMode && (basis.units.some((unit) => unit.room_type_code === selectedType.code) || next.rates.some((rate) => rate.typeCode === selectedType.code))) {
      throw new DomainError("VALIDATION_ERROR", "已关联房间的房型不能改变销售方式；请新增目标房型，再给空房重新分配");
    }
    const code = selectedType?.code ?? `type_${suffix}`;
    const updated: ManagedRoomType = { code, name, bathroom: input.bathroom!, saleMode: input.saleMode!, bedCount, capacity,
      active: selectedType?.active ?? true, products: (selectedType && selectedType.saleMode === input.saleMode ? selectedType.products : undefined) ?? [{ code: `${code}_${input.saleMode!.toLowerCase()}`, kind: input.saleMode!, multiplier: 1 }] };
    if (selectedType) next.types[next.types.indexOf(selectedType)] = updated;
    else next.types.push(updated);
    effect.title = selectedType ? `修改房型：${name}` : `新增房型：${name}`;
    effect.description = [...(selectedType ? [`原房型：${selectedType.name} · ${selectedType.bathroom === "PRIVATE" ? "独卫" : "公卫"} · ${selectedType.saleMode === "ROOM" ? "整房" : "床位"}销售 · 默认 ${selectedType.bedCount} 床 / ${selectedType.capacity} 人`] : []), `${input.bathroom === "PRIVATE" ? "独卫" : "公卫"} · 按${input.saleMode === "ROOM" ? "整房" : "床位"}销售`,
      `默认 ${bedCount} 床 / ${capacity} 人；已有房间的床位结构保持原记录`];
  } else if (input.action === "DELETE_TYPE") {
    const type = requireType();
    const membership = await db.selectFrom("membership_products").select("id").where("allowed_room_type_code", "=", type.code).limit(1).executeTakeFirst();
    if (basis.units.some((unit) => unit.room_type_code === type.code) || next.rates.some((rate) => rate.typeCode === type.code) || membership) {
      throw new DomainError("VALIDATION_ERROR", "房型已有房间、价格或会员关联，不能删除；可停用并保留历史");
    }
    next.types = next.types.filter((item) => item.code !== type.code);
    effect.title = `删除误建房型：${type.name}`;
    effect.description = ["未关联房间、发布价格或会员产品；删除后保留本次操作记录"];
  } else if (input.action === "SET_TYPE_ACTIVE") {
    const type = requireType(), active = flag(input.active);
    if (type.active === active) throw new DomainError("VALIDATION_ERROR", "房型已经处于该状态");
    const rooms = basis.rooms.filter((room) => room.active && room.typeCode === type.code);
    if (!active) await retire(rooms);
    type.active = active;
    effect.title = `${active ? "启用" : "停用"}房型：${type.name}`;
    effect.description = active ? ["房型恢复可用；已停用房间须单独启用"] : [`同时停用 ${rooms.length} 间房及其床位；历史记录保留`];
  } else if (input.action === "SAVE_ROOM" || input.action === "SET_ROOM_ACTIVE") {
    const activate = input.action === "SET_ROOM_ACTIVE" ? flag(input.active) : true;
    const old = input.action === "SET_ROOM_ACTIVE" ? requireRoom() : selectedRoom;
    if (input.action === "SET_ROOM_ACTIVE" && old!.active === activate) throw new DomainError("VALIDATION_ERROR", "房间已经处于该状态");
    if (!activate) {
      await retire([old!]);
      effect.title = `停用房间：${old!.code}`;
      effect.description = ["该房间及子床不再参与销售，原订单和历史记录保留"];
    } else {
      const type = input.action === "SET_ROOM_ACTIVE" ? next.types.find((item) => item.code === old!.typeCode) : requireType();
      if (!type?.active) throw new DomainError("VALIDATION_ERROR", "请先启用目标房型");
      const code = text(input.action === "SET_ROOM_ACTIVE" ? old!.code : input.code, "房号", 40);
      const building = text(input.action === "SET_ROOM_ACTIVE" ? old!.buildingCode : input.buildingCode, "楼栋", 40);
      const bedCount = count(input.action === "SET_ROOM_ACTIVE" ? old!.bedCount : input.bedCount, "床数");
      const capacity = count(input.action === "SET_ROOM_ACTIVE" ? old!.capacity : input.capacity, "可住人数");
      if (type.saleMode === "BED" && capacity !== bedCount) throw new DomainError("VALIDATION_ERROR", "按床售卖时可住人数须与床数相同");
      if (basis.rooms.some((room) => room.unitId !== old?.unitId && room.code === code)) throw new DomainError("VALIDATION_ERROR", "房号已存在（包括停用房间），请使用其他房号");
      if (old) await retire([old], type.code);
      const roomId = `unit_catalog_${suffix}`;
      const kind = type.saleMode;
      let base = type.products.find((item) => item.kind === kind && item.multiplier === 1);
      if (!base) { base = { code: `${type.code}_${kind.toLowerCase()}`, kind, multiplier: 1 }; type.products.push(base); }
      let whole = kind === "ROOM" ? base : type.products.find((item) => item.kind === "ROOM" && item.multiplier === bedCount);
      if (!whole) { whole = { code: `${type.code}_whole_${bedCount}`, kind: "ROOM", multiplier: bedCount }; type.products.push(whole); }
      const common = { property_id: propertyId, active: true, catalog_version: `managed-${next.version}`, building_code: building,
        room_type_code: type.code, code_provenance: "PMS_GENERATED" as const };
      effect.insertUnits.push({ ...common, id: roomId, kind: "ROOM", parent_room_id: null, code, name: `${code} ${type.name}`,
        pricing_product_code: whole.code, inventory_basis: kind === "BED" ? "WHOLE_ROOM_COMBINATION" : "INDEPENDENT",
        physical_bed_count: bedCount, occupancy_capacity: capacity });
      if (kind === "BED") for (let i = 0; i < bedCount; i += 1) {
        const label = i < 26 ? String.fromCharCode(65 + i) : String(i + 1);
        effect.insertUnits.push({ ...common, id: `${roomId}_bed_${i + 1}`, kind: "BED", parent_room_id: roomId,
          code: `${code}-${label}`, name: `${code}-${label} ${type.name}`, pricing_product_code: base.code,
          inventory_basis: "INDEPENDENT", physical_bed_count: null, occupancy_capacity: 1 });
      }
      const newCodes = effect.insertUnits.map((unit) => unit.code);
      if (basis.units.some((unit) => unit.active && !effect.retireUnitIds.includes(unit.id) && newCodes.includes(unit.code))) throw new DomainError("VALIDATION_ERROR", "房号或床位编号与其他有效库存重复");
      effect.roomLink = { assetId: old?.assetId ?? roomId, oldUnitId: old?.unitId ?? null, newUnitId: roomId };
      effect.title = `${old ? "调整" : "新增"}房间：${code}`;
      effect.description = [`${building}栋 · ${type.name} · ${bedCount} 床 / ${capacity} 人`,
        old ? `原 ${old.code} / ${next.types.find((item) => item.code === old.typeCode)?.name ?? old.typeCode} / ${old.bedCount} 床，保留为历史版本` : "新增实体房间及对应销售库存",
        kind === "BED" ? "整间销售占用全部子床，床位与整间不能重复出售" : "只按整房出售，物理床不单独出售"];
    }
  } else {
    const type = requireType();
    if (!type.active) throw new DomainError("VALIDATION_ERROR", "停用房型不能发布新价");
    const effectiveFrom = text(input.effectiveFrom, "生效日期", 10);
    parseLocalDate(effectiveFrom);
    const today = await propertyLocalToday(db, propertyId);
    if (effectiveFrom < today) throw new DomainError("VALIDATION_ERROR", "新价格不能追溯发布到过去，请选择今天或未来日期");
    const anchors = validateRoomRateAnchors(input.anchors);
    next.rates.push({ id: `rate_${suffix}`, typeCode: type.code, effectiveFrom, anchors, version: next.version });
    effect.title = `发布价格：${type.name}`;
    const current = catalogAnchorsAt(effectiveFrom, baselineAt(basis.baselines, effectiveFrom), basis.snapshot.types, basis.snapshot.rates);
    const product = type.products.find((item) => item.kind === type.saleMode && item.multiplier === 1);
    const before = product ? current[product.code] : undefined;
    effect.description = [`${effectiveFrom} 起按新订单入住日生效，已建订单继续使用原价格版本`,
      ...(["1", "7", "14", "30"] as const).map((night) => `${night} 晚：${before ? `¥${(before[night] / 100).toFixed(2)}` : "未设置"} → ¥${(anchors[night] / 100).toFixed(2)}`)];
  }
  if (["PUBLISH_RATES", "SAVE_ROOM"].includes(input.action) || (input.action === "SET_ROOM_ACTIVE" && input.active)) effect.policies = preparePolicies(basis, next);
  const basisVersions = { version: basis.snapshot.version, inventory: basis.units, baselinePolicies: basis.baselines };
  return { propertyId, effect: effect as unknown as Record<string, unknown>, effectHash: stableHash({ effect, basisVersions }), basisVersions };
}

export async function applyRoomCatalogEffect(trx: Transaction<Database>, commandId: string, effect: Record<string, unknown>, reason: string) {
  const result = await sql<{ change_id: string }>`select qintopia_apply_room_catalog(${commandId}, ${JSON.stringify(effect)}::jsonb, ${reason}) as change_id`.execute(trx);
  const changeId = result.rows[0]!.change_id;
  return { persistedResult: { ...effect, changeId }, resourceRefs: [String(effect.propertyId), changeId], factRefs: [changeId] };
}

export async function resolveCatalogPolicyId(db: DbExecutor, propertyId: string, arrivalDate: string): Promise<string | undefined> {
  const head = await db.selectFrom("room_catalog_heads").select("policy_id").where("property_id", "=", propertyId)
    .where("effective_from", "<=", arrivalDate).orderBy("effective_from", "desc").executeTakeFirst();
  return head?.policy_id;
}

export async function assertCurrentCatalogQuote(db: DbExecutor, propertyId: string, policyId: string, arrivalDate: string) {
  const expected = await resolveCatalogPolicyId(db, propertyId, arrivalDate);
  if (expected && expected !== policyId) throw new DomainError("PREVIEW_STALE", "房型价格已更新，请重新报价", 409);
}
