import { administratorCommandGrants, enabledAdministratorTokenCommandGrants, hashPassword, ordinaryStaffCommandGrants, sha256 } from "@qintopia/domain";
import { pathToFileURL } from "node:url";
import { sql, type Insertable, type Kysely } from "kysely";
import type { CommandCatalogType } from "@qintopia/contracts";
import { createDatabase } from "./database.ts";
import { loadBundledQintopia2026Catalog } from "./reference-catalog.ts";
import type { Database } from "./schema.ts";
import { reconcileStaffProfileManifest } from "./staff-profile-manifest.ts";

export const demo = {
  propertyId: "prop_qintopia_demo",
  roomId: "unit_room_101",
  secondRoomId: "unit_room_102",
  bedAId: "unit_room_101_bed_a",
  bedBId: "unit_room_101_bed_b",
  bedCId: "unit_room_101_bed_c",
  bedDId: "unit_room_101_bed_d",
  transientPolicyId: "policy_transient_v1",
  publicPricingPolicyId: "policy_qintopia_public_2026_rev561_v1",
  freePolicyId: "policy_free_v1",
  memberId: "member_demo_profile",
  memberContractId: "member_demo_contract",
  roomLotId: "lot_demo_room_nights",
  membershipOrderId: "membership_order_demo_shared_single",
  membershipPaymentFactId: "membership_payment_demo_shared_single",
  operatorSubjectId: "subject_demo_operator",
  agentSubjectId: "subject_demo_agent",
  administratorSubjectId: "subject_demo_administrator",
  readToken: "qtp_demo_read_token_2026",
  writeToken: "qtp_demo_write_token_2026",
  administratorWriteToken: "qtp_demo_admin_write_token_2026"
} as const;

function slug(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9]+/g, "_").replaceAll(/^_+|_+$/g, "");
}

function roomUnitId(operationalCode: string): string {
  const generatedAlias = /^([DE])(0[1-5])$/.exec(operationalCode);
  const stableCode = generatedAlias
    ? `${generatedAlias[1]}-GEN-${generatedAlias[2]}`
    : operationalCode;
  return `unit_room_${slug(stableCode)}`;
}

export function publicPricingPolicyId(): string {
  return demo.publicPricingPolicyId;
}

function roomPricingProduct(roomTypeKey: string, saleMode: "INDEPENDENT_ROOM" | "BED_WITH_WHOLE_ROOM_COMBINATION"): string {
  return saleMode === "INDEPENDENT_ROOM" ? `${roomTypeKey}_room` : `${roomTypeKey}_whole_room`;
}

const roomOccupancyCapacities: Readonly<Record<string, number>> = {
  private_bath_standard: 2,
  private_bath_king: 2,
  private_bath_single: 1,
  private_bath_suite: 2,
  shared_bath_standard: 2,
  shared_bath_single: 1,
  shared_bath_double: 2,
  shared_bath_quad: 4
};

function roomOccupancyCapacity(roomTypeKey: string): number {
  const capacity = roomOccupancyCapacities[roomTypeKey];
  if (capacity === undefined) throw new Error(`Unknown room type occupancy capacity: ${roomTypeKey}`);
  return capacity;
}

async function relationExists(db: Kysely<Database>, tableName: string): Promise<boolean> {
  const result = await sql<{ present: boolean }>`
    select to_regclass(${`public.${tableName}`}) is not null as present
  `.execute(db);
  return result.rows[0]?.present === true;
}

async function seedCommandGrants(
  db: Kysely<Database>,
  subjectId: string,
  propertyId: string,
  commandTypes: readonly CommandCatalogType[]
): Promise<void> {
  if (commandTypes.length === 0) return;
  await db.insertInto("subject_command_grants")
    .values(commandTypes.map((commandType) => ({ subject_id: subjectId, property_id: propertyId, command_type: commandType })))
    .onConflict((oc) => oc.columns(["subject_id", "property_id", "command_type"]).doNothing())
    .execute();
}

async function seedTokenCommandCeiling(
  db: Kysely<Database>,
  tokenId: string,
  subjectId: string,
  propertyId: string,
  commandTypes: readonly CommandCatalogType[]
): Promise<void> {
  if (commandTypes.length === 0) return;
  await db.insertInto("token_command_ceilings")
    .values(commandTypes.map((commandType) => ({ token_id: tokenId, subject_id: subjectId, property_id: propertyId, command_type: commandType })))
    .onConflict((oc) => oc.columns(["token_id", "command_type"]).doNothing())
    .execute();
}

export async function buildQintopia2026OperationalCatalogRows(propertyId = demo.propertyId) {
  const snapshot = await loadBundledQintopia2026Catalog();
  const categoryNames = new Map(snapshot.inventory.categories.map((category) => [category.roomTypeKey, category.sourceName]));
  const rooms = snapshot.inventory.rooms.map((room) => ({
    id: roomUnitId(room.operationalCode),
    property_id: propertyId,
    kind: "ROOM" as const,
    parent_room_id: null,
    code: room.operationalCode,
    name: `${room.operationalCode} · ${categoryNames.get(room.roomTypeKey)}`,
    active: true,
    catalog_version: snapshot.importId,
    building_code: room.buildingCode,
    room_type_code: room.roomTypeKey,
    pricing_product_code: roomPricingProduct(room.roomTypeKey, room.saleMode),
    inventory_basis: room.saleMode === "INDEPENDENT_ROOM" ? "INDEPENDENT" as const : "WHOLE_ROOM_COMBINATION" as const,
    code_provenance: room.codeProvenance,
    physical_bed_count: room.physicalBedCount,
    occupancy_capacity: roomOccupancyCapacity(room.roomTypeKey)
  }));
  const beds = snapshot.inventory.rooms.flatMap((room) => room.saleMode === "BED_WITH_WHOLE_ROOM_COMBINATION"
    ? (room.physicalBedCodes ?? []).map((bedCode) => ({
      id: `${roomUnitId(room.operationalCode)}_bed_${bedCode.toLowerCase()}`,
      property_id: propertyId,
      kind: "BED" as const,
      parent_room_id: roomUnitId(room.operationalCode),
      code: `${room.operationalCode}-${bedCode}`,
      name: `${room.operationalCode} · 床位 ${bedCode}`,
      active: true,
      catalog_version: snapshot.importId,
      building_code: room.buildingCode,
      room_type_code: room.roomTypeKey,
      pricing_product_code: `${room.roomTypeKey}_bed`,
      inventory_basis: "INDEPENDENT" as const,
      code_provenance: room.codeProvenance,
      physical_bed_count: null,
      occupancy_capacity: 1
    }))
    : []);
  return { snapshot, rooms, beds };
}

function publicPricingPolicyRow(snapshot: Awaited<ReturnType<typeof loadBundledQintopia2026Catalog>>) {
  return {
    id: publicPricingPolicyId(),
    property_id: demo.propertyId,
    code: snapshot.pricingRule.code,
    version: snapshot.pricingRule.version,
    stay_type: null,
    calculation_kind: "DURATION_BAND_TOTAL" as const,
    nightly_rate_minor: null,
    product_anchor_rates_minor: Object.fromEntries(snapshot.publicRates.products.map((product) => [product.productCode, product.anchorsMinor])),
    effective_from: snapshot.pricingRule.effectiveFrom,
    effective_until: snapshot.pricingRule.effectiveUntil,
    rounding_rule: "FINAL_TOTAL_WHOLE_YUAN_HALF_UP" as const,
    currency: snapshot.publicRates.currency,
    status: "PUBLISHED" as const
  };
}

export async function seedDemo(db: Kysely<Database>, options: { includeProtocolFixturePolicy?: boolean } = {}): Promise<void> {
  const profileReconciliationReady = await relationExists(db, "staff_profile_reconciliation_state");
  const catalog = await buildQintopia2026OperationalCatalogRows();
  const occupancyColumn = await sql<{ present: boolean }>`
    select exists (
      select 1 from information_schema.columns
      where table_schema = current_schema()
        and table_name = 'inventory_units'
        and column_name = 'occupancy_capacity'
    ) as present
  `.execute(db);
  const inventoryRows = occupancyColumn.rows[0]?.present
    ? { rooms: catalog.rooms, beds: catalog.beds }
    : {
        rooms: catalog.rooms.map(({ occupancy_capacity: _discarded, ...room }) => room),
        beds: catalog.beds.map(({ occupancy_capacity: _discarded, ...bed }) => bed)
      };
  await db.insertInto("properties").values({ id: demo.propertyId, code: "QTP-XA", name: "QinTopia", timezone: "Asia/Shanghai", currency: "CNY" }).onConflict((oc) => oc.column("id").doNothing()).execute();
  await db.insertInto("inventory_units").values(inventoryRows.rooms).onConflict((oc) => oc.column("id").doNothing()).execute();
  await db.insertInto("inventory_units").values(inventoryRows.beds).onConflict((oc) => oc.column("id").doNothing()).execute();
  const pricingPolicies: Insertable<Database["pricing_policy_versions"]>[] = [
    { id: demo.freePolicyId, property_id: demo.propertyId, code: "FREE", version: 1, stay_type: "FREE", calculation_kind: "FREE", nightly_rate_minor: 0, currency: "CNY", status: "PUBLISHED" },
    publicPricingPolicyRow(catalog.snapshot)
  ];
  if (options.includeProtocolFixturePolicy) {
    pricingPolicies.push({
      id: demo.transientPolicyId,
      property_id: demo.propertyId,
      code: "DEMO-ONLY-TRANSIENT-FLAT",
      version: 1,
      stay_type: "TRANSIENT",
      calculation_kind: "FLAT_NIGHTLY",
      nightly_rate_minor: 12_000,
      product_anchor_rates_minor: null,
      effective_from: null,
      effective_until: null,
      rounding_rule: null,
      currency: "CNY",
      status: "PUBLISHED"
    });
  }
  await db.insertInto("pricing_policy_versions").values(pricingPolicies).onConflict((oc) => oc.column("id").doNothing()).execute();

  const passwordSalt = "qintopia-demo-v1";
  const passwordHash = hashPassword("demo-pass-2026", passwordSalt);
  await db.insertInto("subjects").values([
    { id: demo.operatorSubjectId, username: "operator", display_name: "Demo Operator", password_salt: passwordSalt, password_hash: passwordHash, status: "ACTIVE", auth_version: 1 },
    { id: demo.agentSubjectId, username: "agent-demo", display_name: "Demo Agent", password_salt: passwordSalt, password_hash: passwordHash, status: "ACTIVE", auth_version: 1 },
    { id: demo.administratorSubjectId, username: "admin", display_name: "Demo Administrator", password_salt: passwordSalt, password_hash: passwordHash, status: "ACTIVE", auth_version: 1 }
  ]).onConflict((oc) => oc.column("id").doNothing()).execute();
  await db.insertInto("subject_property_grants").values([
    { subject_id: demo.operatorSubjectId, property_id: demo.propertyId, access_level: "WRITE" },
    { subject_id: demo.agentSubjectId, property_id: demo.propertyId, access_level: "WRITE" },
    { subject_id: demo.administratorSubjectId, property_id: demo.propertyId, access_level: "WRITE" }
  ]).onConflict((oc) => oc.columns(["subject_id", "property_id"]).doNothing()).execute();
  await db.insertInto("api_tokens").values([
    { id: "token_demo_read", subject_id: demo.agentSubjectId, label: "Demo read-only agent", secret_hash: sha256(demo.readToken), access_ceiling: "READ", property_scope: demo.propertyId, expires_at: "2030-01-01T00:00:00.000Z", revoked_at: null, rotated_from_id: null, replaced_by_id: null },
    { id: "token_demo_write", subject_id: demo.agentSubjectId, label: "Demo write agent", secret_hash: sha256(demo.writeToken), access_ceiling: "WRITE", property_scope: demo.propertyId, expires_at: "2030-01-01T00:00:00.000Z", revoked_at: null, rotated_from_id: null, replaced_by_id: null },
    { id: "token_demo_admin_write", subject_id: demo.administratorSubjectId, label: "Demo administrator", secret_hash: sha256(demo.administratorWriteToken), access_ceiling: "WRITE", property_scope: demo.propertyId, expires_at: "2030-01-01T00:00:00.000Z", revoked_at: null, rotated_from_id: null, replaced_by_id: null }
  ]).onConflict((oc) => oc.column("id").doNothing()).execute();
  if (!profileReconciliationReady && await relationExists(db, "subject_command_grants")) {
    await seedCommandGrants(db, demo.operatorSubjectId, demo.propertyId, ordinaryStaffCommandGrants);
    await seedCommandGrants(db, demo.agentSubjectId, demo.propertyId, ordinaryStaffCommandGrants);
    await seedCommandGrants(db, demo.administratorSubjectId, demo.propertyId, administratorCommandGrants);
  }
  if (!profileReconciliationReady && await relationExists(db, "token_command_ceilings")) {
    await seedTokenCommandCeiling(db, "token_demo_write", demo.agentSubjectId, demo.propertyId, ordinaryStaffCommandGrants);
    await seedTokenCommandCeiling(db, "token_demo_admin_write", demo.administratorSubjectId, demo.propertyId, enabledAdministratorTokenCommandGrants);
  }
  const nicknameColumn = await sql<{ present: boolean }>`
    select exists (
      select 1 from information_schema.columns
      where table_schema = current_schema()
        and table_name = 'members'
        and column_name = 'nickname'
    ) as present
  `.execute(db);
  const demoMemberRow = nicknameColumn.rows[0]?.present
    ? {
        id: demo.memberId,
        identity_card_number: null as string | null,
        nickname: "演示会员",
        full_name: "Demo Member",
        phone: "13800000000",
        wechat: "qintopia-demo-member"
      }
    : {
        id: demo.memberId,
        identity_card_number: "DEMO-ID-310000199001010001" as string | null,
        full_name: "Demo Member",
        phone: "13800000000",
        wechat: "qintopia-demo-member"
      };
  await db.insertInto("members").values(demoMemberRow as Insertable<Database["members"]>).onConflict((oc) => oc.column("id").doNothing()).execute();
  await db.insertInto("member_contracts").values({
    id: demo.memberContractId,
    property_id: demo.propertyId,
    member_id: demo.memberId,
    member_name: "Demo Member",
    status: "ACTIVE",
    valid_from: "2026-01-01",
    valid_until: "2029-12-31",
    version: 1
  }).onConflict((oc) => oc.column("id").doUpdateSet({ member_id: demo.memberId })).execute();
  const memberPropertyLinksTable = await sql<{ table_name: string | null }>`
    select to_regclass('public.member_property_links')::text as table_name
  `.execute(db);
  if (memberPropertyLinksTable.rows[0]?.table_name) {
    await db.insertInto("member_property_links").values({
      member_id: demo.memberId,
      property_id: demo.propertyId
    }).onConflict((oc) => oc.columns(["member_id", "property_id"]).doNothing()).execute();
  }
  await db.insertInto("entitlement_lots").values({
    id: demo.roomLotId,
    contract_id: demo.memberContractId,
    unit_kind: "ROOM_NIGHT",
    total_units: 2,
    expires_on: "2029-12-31",
    version: 1
  }).onConflict((oc) => oc.column("id").doNothing()).execute();
  const membershipOrdersTable = await sql<{ table_name: string | null }>`
    select to_regclass('public.membership_orders')::text as table_name
  `.execute(db);
  if (membershipOrdersTable.rows[0]?.table_name) {
    await db.insertInto("membership_orders").values({
      id: demo.membershipOrderId,
      property_id: demo.propertyId,
      member_id: demo.memberId,
      product_id: "membership_product_shared_bath_single_v1",
      product_code: "SHARED_BATH_SINGLE_30",
      product_version: 1,
      product_name: "公卫单人间会员",
      listed_price_minor: 162_000,
      agreed_price_minor: 162_000,
      price_adjustment_minor: 0,
      price_adjustment_reason: null,
      currency: "CNY",
      entitlement_unit_kind: "ROOM_NIGHT",
      entitlement_units: 2,
      allowed_room_type_code: "shared_bath_single",
      allowed_inventory_kind: "ROOM",
      status: "ACTIVE",
      activated_at: new Date("2026-01-01T00:00:00.000Z"),
      valid_from: "2026-01-01",
      valid_until: "2029-12-31",
      contract_id: demo.memberContractId,
      entitlement_lot_id: demo.roomLotId,
      version: 1,
      created_by_command_id: "seed_demo_membership_order",
      activated_by_command_id: "seed_demo_membership_order"
    }).onConflict((oc) => oc.column("id").doNothing()).execute();
    const existingPaymentFact = await db.selectFrom("membership_payment_facts")
      .select("fact_id")
      .where("membership_order_id", "=", demo.membershipOrderId)
      .limit(1)
      .executeTakeFirst();
    if (!existingPaymentFact) {
      const paymentBusinessDateColumn = await sql<{ present: boolean }>`
        select exists (
          select 1 from information_schema.columns
          where table_schema = current_schema()
            and table_name = 'membership_payment_facts'
            and column_name = 'business_date'
        ) as present
      `.execute(db);
      const paymentFactRow = {
        fact_id: demo.membershipPaymentFactId,
        membership_order_id: demo.membershipOrderId,
        fact_type: "COLLECTION",
        amount_minor: 162_000,
        net_effect_minor: 162_000,
        currency: "CNY",
        transaction_reference: "DEMO-WECOM-20260101-001",
        corrects_fact_id: null,
        reverses_fact_id: null,
        note: "Demo 会员订单企微收款",
        command_id: "seed_demo_membership_payment",
        ...(paymentBusinessDateColumn.rows[0]?.present ? { business_date: "2026-01-01" } : {})
      } as Insertable<Database["membership_payment_facts"]>;
      await db.insertInto("membership_payment_facts").values(paymentFactRow)
        .onConflict((oc) => oc.column("fact_id").doNothing()).execute();
    }
    await db.updateTable("member_contracts").set({ membership_order_id: demo.membershipOrderId })
      .where("id", "=", demo.memberContractId)
      .where("membership_order_id", "is", null)
      .execute();
  }
  if (profileReconciliationReady) {
    await reconcileStaffProfileManifest(db, "demo");
    await seedTokenCommandCeiling(
      db,
      "token_demo_write",
      demo.agentSubjectId,
      demo.propertyId,
      ordinaryStaffCommandGrants
    );
    await seedTokenCommandCeiling(
      db,
      "token_demo_admin_write",
      demo.administratorSubjectId,
      demo.propertyId,
      enabledAdministratorTokenCommandGrants
    );
    await reconcileStaffProfileManifest(db, "demo");
  }
}

async function runSeed() {
  const db = createDatabase();
  try {
    await seedDemo(db);
    process.stdout.write("Seeded demo property, operator account, and scoped agent credentials.\n");
  } finally {
    await db.destroy();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runSeed().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
