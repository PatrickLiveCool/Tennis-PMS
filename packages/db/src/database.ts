import { roomCatalogReady } from "./room-catalog-readiness.ts";
import { Kysely, PostgresDialect, sql, type Transaction } from "kysely";
import pg from "pg";
import {
  administratorCommandGrants,
  commandFeatureEnabled,
  ordinaryStaffCommandGrants
} from "@qintopia/domain";
import type { Database } from "./schema.ts";
import { resolveStaffProfileManifest } from "./staff-profile-manifest.ts";
import { accountManagementReady } from "./account-management-readiness.ts";
import { checkoutReversalReady } from "./checkout-reversal-readiness.ts";
import { integrationReady } from "./integration-readiness.ts";
import { wecomRefundReady } from "./wecom-refund-readiness.ts";
import { externalPaymentsReady } from "./external-payments-readiness.ts";
import { companionReady } from "./companion-readiness.ts";

pg.types.setTypeParser(1082, (value) => value);

export const currentMigrationNames = [
  "001_initial.sql",
  "002_immutability.sql",
  "003_active_coverage_uniqueness.sql",
  "004_security_identity_guards.sql",
  "005_core_identity_and_entitlement_guards.sql",
  "006_property_scoped_idempotency.sql",
  "007_reference_catalog.sql",
  "008_reference_catalog_sealing.sql",
  "009_booking_channels_and_transaction_references.sql",
  "010_qintopia_2026_catalog_pricing_and_free_stays.sql",
  "011_core_fact_shape_guards.sql",
  "012_legacy_demo_inventory_catalog_backfill.sql",
  "013_room_status_operations.sql",
  "014_new_order_primary_guest_nickname.sql",
  "015_generated_room_operational_codes.sql",
  "016_member_property_links.sql",
  "017_membership_orders.sql",
  "018_member_stay_identity_and_coverage_guards.sql",
  "019_member_stay_booking_channel_rules.sql",
  "020_whole_room_occupants.sql",
  "021_defer_internal_use.sql",
  "022_order_occupant_corrections.sql",
  "023_collection_fact_pricing_revision.sql",
  "024_free_stay_category_code.sql",
  "025_channel_order_atomic_pricing.sql",
  "026_stage9_stay_change_guards.sql",
  "027_stage10_stay_shortening_guards.sql",
  "028_stage11_move_unit_guards.sql",
  "029_stage12_terminal_order_guards.sql",
  "030_collection_fact_historical_pricing_revision.sql",
  "031_collection_fact_method_transaction_rules.sql",
  "032_wecom_refund_original_route.sql",
  "033_stay_collection_membership_conversion.sql",
  "034_stay_conversion_reversal_bridge_guard.sql",
  "035_stage13_conversion_execution_state_guards.sql",
  "036_qintopia_prelaunch_room_catalog_corrections.sql",
  "037_member_phone_identity_and_nickname.sql",
  "038_backfill_completed_stay_checkout_guard.sql",
  "039_inhouse_zero_collection_conversion.sql",
  "040_conversion_order_membership_link.sql",
  "041_completed_stay_backfill_atomicity.sql",
  "042_complete_overdue_reserved_stay.sql",
  "043_complete_stay_guard_hardening.sql",
  "044_inhouse_membership_fulfillment_guards.sql",
  "045_stay_membership_net_wecom_transfer.sql",
  "046_command_authorization.sql",
  "047_runtime_database_role.sql",
  "048_runtime_isolation_guards.sql",
  "049_historical_stay_arrangement_corrections.sql",
  "050_admin_membership_corrections.sql",
  "051_runtime_role_command_compatibility.sql",
  "052_temporary_other_room_member_stays.sql",
  "053_account_management.sql",
  "054_unused_member_deletion.sql",
  "055_checkout_reversal.sql",
  "056_whole_room_companions.sql",
  "057_order_directory_read_indexes.sql",
  "058_integration_events.sql",
  "059_wecom_refund_reference.sql",
  "060_external_payments.sql",
  "061_room_catalog_management.sql"
] as const;

export function databaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  const url = new URL("postgres://127.0.0.1");
  url.username = process.env.PGUSER ?? "qintopia";
  url.password = process.env.PGPASSWORD ?? "qintopia";
  url.hostname = process.env.PGHOST ?? "127.0.0.1";
  url.port = process.env.PGPORT ?? "55432";
  url.pathname = `/${process.env.PGDATABASE ?? "qintopia"}`;
  return url.toString();
}

export function createDatabase(url = databaseUrl(), options: Pick<pg.PoolConfig, "max" | "connectionTimeoutMillis" | "statement_timeout"> = {}): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString: url, max: 20, ...options })
    })
  });
}

type DatabaseReadyExecutor = Kysely<Database> | Transaction<Database>;

export interface DatabaseReadyOptions {
  identity?: "runtime" | "maintenance-owner";
  staffProfileManifestName?: string;
}

function compareStaffProfileCatalogRows(
  left: { profile: string; command_type: string },
  right: { profile: string; command_type: string }
): number {
  if (left.profile !== right.profile) return left.profile < right.profile ? -1 : 1;
  if (left.command_type === right.command_type) return 0;
  return left.command_type < right.command_type ? -1 : 1;
}

const expectedStaffProfileCatalog = [
  ...ordinaryStaffCommandGrants.map((commandType) => ({
    profile: "STAFF" as const,
    command_type: commandType,
    token_default: true
  })),
  ...administratorCommandGrants.map((commandType) => ({
    profile: "ADMIN" as const,
    command_type: commandType,
    token_default: commandType !== "MANAGE_ROOM_CATALOG" && commandFeatureEnabled(commandType)
  }))
].sort(compareStaffProfileCatalogRows);

export async function databaseReady(
  db: DatabaseReadyExecutor,
  options: DatabaseReadyOptions = {}
): Promise<boolean> {
  if (!db.isTransaction) {
    try {
      return await db.transaction().execute(async (trx) => databaseReady(trx, options));
    } catch {
      return false;
    }
  }

  try {
    await sql`
      SELECT pg_advisory_xact_lock_shared(
        hashtextextended('qintopia:migrate', 0::bigint)
      )
    `.execute(db);

    const rows = await db.selectFrom("schema_migrations").select("name").orderBy("name").execute();
    const migrationsReady = rows.length === currentMigrationNames.length
      && rows.every((row, index) => row.name === currentMigrationNames[index]);
    if (!migrationsReady) return false;

    const expectedStaffProfileManifest = resolveStaffProfileManifest(
      options.staffProfileManifestName ?? process.env.STAFF_PROFILE_MANIFEST_NAME
    );

    const reconciliationStates = await db.selectFrom("staff_profile_reconciliation_state")
      .select("singleton")
      .execute();
    if (reconciliationStates.length !== 1) return false;

    const profileCatalog = (await db.selectFrom("staff_command_profile_catalog")
      .select(["profile", "command_type", "token_default"])
      .execute())
      .sort(compareStaffProfileCatalogRows);
    const profileCatalogReady = profileCatalog.length === expectedStaffProfileCatalog.length
      && profileCatalog.every((row, index) => {
        const expected = expectedStaffProfileCatalog[index];
        return row.profile === expected?.profile
          && row.command_type === expected.command_type
          && row.token_default === expected.token_default;
      });
    if (!profileCatalogReady) return false;

    const runtimeIsolation = await sql<{
      identity_ready: boolean;
      role_ready: boolean;
      memberships_ready: boolean;
      ownership_ready: boolean;
      capabilities_ready: boolean;
      update_privileges_ready: boolean;
      destructive_privileges_ready: boolean;
      profile_assignments_ready: boolean;
      profile_grants_ready: boolean;
      reviewed_manifest_ready: boolean;
      token_policy_ready: boolean;
      reconciliation_state_ready: boolean;
      isolation_objects_ready: boolean;
    }>`
      WITH RECURSIVE
      runtime_role AS (
        SELECT *
        FROM pg_roles
        WHERE rolname = 'qintopia_runtime'
      ),
      database_owner AS (
        SELECT database_row.oid,
          database_row.datdba,
          pg_get_userbyid(database_row.datdba) AS owner_name
        FROM pg_database AS database_row
        WHERE database_row.datname = current_database()
      ),
      inherited_roles(roleid) AS (
        SELECT membership.roleid
        FROM pg_auth_members AS membership
        JOIN runtime_role ON runtime_role.oid = membership.member
        UNION
        SELECT membership.roleid
        FROM pg_auth_members AS membership
        JOIN inherited_roles ON inherited_roles.roleid = membership.member
      ),
      expected_update_columns(table_name, column_name) AS (
        VALUES
          ('web_sessions', 'revoked_at'),
          ('command_executions', 'state'),
          ('command_executions', 'completed_at'),
          ('command_previews', 'status'),
          ('command_previews', 'used_at'),
          ('api_tokens', 'revoked_at'),
          ('api_tokens', 'replaced_by_id'),
          ('subjects', 'created_at'),
          ('subject_property_grants', 'created_at'),
          ('subject_command_grants', 'created_at'),
          ('token_command_ceilings', 'created_at'),
          ('order_occupants', 'created_at'),
          ('inventory_units', 'created_at'),
          ('members', 'full_name'),
          ('members', 'nickname'),
          ('members', 'identity_card_number'),
          ('members', 'phone'),
          ('members', 'wechat'),
          ('membership_payment_facts', 'created_at'),
          ('stay_collection_membership_transfers', 'created_at'),
          ('stay_segments', 'created_at'),
          ('pricing_revisions', 'created_at'),
          ('collection_facts', 'created_at'),
          ('external_payment_bills', 'id'),
          ('entitlement_ledger', 'created_at'),
          ('membership_orders', 'status'),
          ('membership_orders', 'activated_at'),
          ('membership_orders', 'valid_from'),
          ('membership_orders', 'valid_until'),
          ('membership_orders', 'contract_id'),
          ('membership_orders', 'entitlement_lot_id'),
          ('membership_orders', 'version'),
          ('membership_orders', 'activated_by_command_id'),
          ('membership_orders', 'updated_at'),
          ('member_contracts', 'status'),
          ('member_contracts', 'valid_from'),
          ('member_contracts', 'valid_until'),
          ('member_contracts', 'version'),
          ('entitlement_lots', 'status'),
          ('entitlement_lots', 'expires_on'),
          ('entitlement_lots', 'version'),
          ('orders', 'status'),
          ('orders', 'arrival_date'),
          ('orders', 'departure_date'),
          ('orders', 'current_revision_id'),
          ('orders', 'member_id'),
          ('orders', 'member_contract_id'),
          ('orders', 'version'),
          ('orders', 'updated_at'),
          ('stays', 'status'),
          ('coverage_items', 'status'),
          ('coverage_items', 'updated_at'),
          ('inventory_room_days', 'whole_claim_id'),
          ('inventory_room_days', 'version'),
          ('inventory_room_days', 'updated_at'),
          ('inventory_bed_days', 'bed_claim_id'),
          ('inventory_bed_days', 'version'),
          ('inventory_bed_days', 'updated_at'),
          ('inventory_claims', 'active'),
          ('inventory_claims', 'released_at'),
          ('maintenance_locks', 'status'),
          ('maintenance_locks', 'version'),
          ('maintenance_locks', 'released_by_command_id'),
          ('maintenance_locks', 'released_at'),
          ('cleaning_tasks', 'status'),
          ('cleaning_tasks', 'version'),
          ('cleaning_tasks', 'completed_by_command_id'),
          ('cleaning_tasks', 'completed_at'),
          ('room_status_revisions', 'revision'),
          ('room_status_revisions', 'updated_at')
      ),
      actual_update_columns AS (
        SELECT relation.relname::text AS table_name,
          attribute.attname::text AS column_name
        FROM runtime_role
        JOIN pg_class AS relation
          ON relation.relkind IN ('r', 'p')
        JOIN pg_namespace AS namespace
          ON namespace.oid = relation.relnamespace
          AND namespace.nspname = 'public'
        JOIN pg_attribute AS attribute
          ON attribute.attrelid = relation.oid
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
        WHERE has_column_privilege(
          runtime_role.oid,
          relation.oid,
          attribute.attnum,
          'UPDATE'
        )
      ),
      reviewed_manifest AS (
        SELECT item."subjectId" AS subject_id,
          item."propertyId" AS property_id,
          item.profile
        FROM jsonb_to_recordset(${JSON.stringify(expectedStaffProfileManifest.entries)}::jsonb)
          AS item("subjectId" text, "propertyId" text, profile text)
      ),
      canonical_manifest AS (
        SELECT COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'subjectId', subject_id,
              'propertyId', property_id,
              'profile', profile
            )
            ORDER BY subject_id, property_id
          ),
          '[]'::jsonb
        ) AS value
        FROM reviewed_manifest
      ),
      expected_assignments AS (
        SELECT property_grant.subject_id,
          property_grant.property_id,
          COALESCE(reviewed_manifest.profile, 'STAFF') AS profile
        FROM subject_property_grants AS property_grant
        LEFT JOIN reviewed_manifest
          ON reviewed_manifest.subject_id = property_grant.subject_id
          AND reviewed_manifest.property_id = property_grant.property_id
        WHERE property_grant.access_level = 'WRITE'
      ),
      expected_profile_grants AS (
        SELECT assignment.subject_id,
          assignment.property_id,
          profile_command.command_type
        FROM expected_assignments AS assignment
        JOIN staff_command_profile_catalog AS profile_command
          ON profile_command.profile = assignment.profile
      ),
      expected_historical_grants AS (
        SELECT DISTINCT execution.subject_id,
          execution.property_id,
          regexp_replace(execution.command_type, '^PREVIEW:', '') AS command_type
        FROM command_executions AS execution
        JOIN expected_assignments AS assignment
          ON assignment.subject_id = execution.subject_id
          AND assignment.property_id = execution.property_id
        JOIN command_catalog AS catalog
          ON catalog.command_type = regexp_replace(execution.command_type, '^PREVIEW:', '')
          AND catalog.command_class = 'HISTORICAL_READ'
      ),
      expected_grants AS (
        SELECT * FROM expected_profile_grants
        UNION
        SELECT * FROM expected_historical_grants
      ),
      actual_projection AS (
        SELECT format('A|%s|%s|%s', subject_id, property_id, profile) AS row_value
        FROM staff_profile_assignments
        UNION ALL
        SELECT format('G|%s|%s|%s', subject_id, property_id, command_type)
        FROM subject_command_grants
      ),
      actual_projection_hash AS (
        SELECT encode(
          sha256(convert_to(COALESCE(string_agg(row_value, E'\\n' ORDER BY row_value), ''), 'UTF8')),
          'hex'
        ) AS value
        FROM actual_projection
      )
      SELECT
        CASE ${options.identity ?? "runtime"}
          WHEN 'runtime' THEN current_user = 'qintopia_runtime'
            AND session_user = 'qintopia_runtime'
            AND current_setting('search_path') = 'public'
          WHEN 'maintenance-owner' THEN current_user = session_user
            AND current_user = (SELECT owner_name FROM database_owner)
            AND current_user <> 'qintopia_runtime'
          ELSE false
        END AS identity_ready,
        COALESCE((
          SELECT NOT runtime_role.rolsuper
            AND NOT runtime_role.rolinherit
            AND NOT runtime_role.rolcreaterole
            AND NOT runtime_role.rolcreatedb
            AND runtime_role.rolcanlogin
            AND NOT runtime_role.rolreplication
            AND NOT runtime_role.rolbypassrls
            AND COALESCE(runtime_role.rolconfig, ARRAY[]::text[]) = ARRAY['search_path=public']::text[]
            AND NOT EXISTS (
              SELECT 1
              FROM pg_db_role_setting AS role_setting
              JOIN database_owner ON database_owner.oid = role_setting.setdatabase
              WHERE role_setting.setrole = runtime_role.oid
            )
          FROM runtime_role
        ), false) AS role_ready,
        NOT EXISTS (SELECT 1 FROM inherited_roles) AS memberships_ready,
        COALESCE((
          SELECT NOT EXISTS (
            SELECT 1
            FROM pg_shdepend AS dependency
            JOIN database_owner
              ON dependency.dbid = database_owner.oid
              OR (
                dependency.dbid = 0
                AND dependency.classid = 'pg_database'::regclass
                AND dependency.objid = database_owner.oid
              )
            WHERE dependency.refclassid = 'pg_authid'::regclass
              AND dependency.refobjid = runtime_role.oid
              AND dependency.deptype = 'o'
          )
          FROM runtime_role
        ), false) AS ownership_ready,
        COALESCE((
          SELECT has_database_privilege(runtime_role.oid, current_database(), 'CONNECT')
            AND NOT has_database_privilege(runtime_role.oid, current_database(), 'CREATE')
            AND NOT has_database_privilege(runtime_role.oid, current_database(), 'TEMPORARY')
            AND has_schema_privilege(runtime_role.oid, 'public', 'USAGE')
            AND NOT has_schema_privilege(runtime_role.oid, 'public', 'CREATE')
            AND NOT has_parameter_privilege(runtime_role.oid, 'session_replication_role', 'SET')
            AND NOT has_parameter_privilege(runtime_role.oid, 'session_replication_role', 'ALTER SYSTEM')
            AND NOT has_function_privilege(
              runtime_role.oid,
              'qintopia_reconcile_staff_profile_manifest(text,jsonb)'::regprocedure,
              'EXECUTE'
            )
            AND NOT has_function_privilege(
              runtime_role.oid,
              'qintopia_guard_runtime_order_projection_update()'::regprocedure,
              'EXECUTE'
            )
            AND NOT has_function_privilege(
              runtime_role.oid,
              'qintopia_guard_runtime_mutable_projection_update()'::regprocedure,
              'EXECUTE'
            )
            AND NOT has_function_privilege(
              runtime_role.oid,
              'qintopia_guard_runtime_inventory_unit_update()'::regprocedure,
              'EXECUTE'
            )
            AND NOT has_function_privilege(
              runtime_role.oid,
              'qintopia_guard_runtime_token_mutation()'::regprocedure,
              'EXECUTE'
            )
            AND has_function_privilege(
              runtime_role.oid,
              'qintopia_has_typed_runtime_command_evidence(text,text,text)'::regprocedure,
              'EXECUTE'
            )
            AND NOT has_function_privilege(
              runtime_role.oid,
              'qintopia_guard_runtime_membership_projection_update_050()'::regprocedure,
              'EXECUTE'
            )
          FROM runtime_role
        ), false) AS capabilities_ready,
        NOT EXISTS (
          SELECT * FROM actual_update_columns
          EXCEPT
          SELECT * FROM expected_update_columns
        ) AND NOT EXISTS (
          SELECT * FROM expected_update_columns
          EXCEPT
          SELECT * FROM actual_update_columns
        ) AS update_privileges_ready,
        COALESCE((
          SELECT NOT EXISTS (
            SELECT 1
            FROM pg_class AS relation
            JOIN pg_namespace AS namespace
              ON namespace.oid = relation.relnamespace
              AND namespace.nspname = 'public'
            WHERE relation.relkind IN ('r', 'p')
              AND (
                has_table_privilege(runtime_role.oid, relation.oid, 'DELETE')
                OR has_table_privilege(runtime_role.oid, relation.oid, 'TRUNCATE')
                OR has_table_privilege(runtime_role.oid, relation.oid, 'TRIGGER')
                OR has_table_privilege(runtime_role.oid, relation.oid, 'REFERENCES')
              )
          )
          FROM runtime_role
        ), false) AS destructive_privileges_ready,
        NOT EXISTS (
          SELECT subject_id, property_id, profile FROM staff_profile_assignments
          EXCEPT
          SELECT subject_id, property_id, profile FROM expected_assignments
        ) AND NOT EXISTS (
          SELECT subject_id, property_id, profile FROM expected_assignments
          EXCEPT
          SELECT subject_id, property_id, profile FROM staff_profile_assignments
        ) AS profile_assignments_ready,
        NOT EXISTS (
          SELECT subject_id, property_id, command_type FROM subject_command_grants
          EXCEPT
          SELECT subject_id, property_id, command_type FROM expected_grants
        ) AND NOT EXISTS (
          SELECT subject_id, property_id, command_type FROM expected_grants
          EXCEPT
          SELECT subject_id, property_id, command_type FROM subject_command_grants
        ) AS profile_grants_ready,
        NOT EXISTS (
          SELECT 1
          FROM reviewed_manifest
          LEFT JOIN expected_assignments
            ON expected_assignments.subject_id = reviewed_manifest.subject_id
            AND expected_assignments.property_id = reviewed_manifest.property_id
            AND expected_assignments.profile = reviewed_manifest.profile
          WHERE expected_assignments.subject_id IS NULL
        ) AS reviewed_manifest_ready,
        NOT EXISTS (
          SELECT 1
          FROM token_command_ceilings AS ceiling
          LEFT JOIN api_tokens AS token
            ON token.id = ceiling.token_id
            AND token.subject_id = ceiling.subject_id
            AND token.property_scope = ceiling.property_id
          LEFT JOIN subjects AS subject_row
            ON subject_row.id = ceiling.subject_id
          LEFT JOIN subject_property_grants AS property_grant
            ON property_grant.subject_id = ceiling.subject_id
            AND property_grant.property_id = ceiling.property_id
          LEFT JOIN command_catalog AS catalog
            ON catalog.command_type = ceiling.command_type
          WHERE token.id IS NULL
            OR subject_row.id IS NULL
            OR property_grant.subject_id IS NULL
            OR property_grant.access_level <> 'WRITE'
            OR catalog.command_type IS NULL
            OR token.access_ceiling <> 'WRITE'
            OR NOT (
              catalog.command_class = 'HISTORICAL_READ'
              OR (
                catalog.command_class = 'HUMAN_COMMAND'
                AND EXISTS (
                  SELECT 1
                  FROM staff_profile_assignments AS assignment
                  JOIN staff_command_profile_catalog AS profile_command
                    ON profile_command.profile = assignment.profile
                    AND profile_command.command_type = ceiling.command_type
                    AND profile_command.token_default
                  WHERE assignment.subject_id = ceiling.subject_id
                    AND assignment.property_id = ceiling.property_id
                )
              )
            )
            OR NOT EXISTS (
              SELECT 1
              FROM expected_grants
              WHERE expected_grants.subject_id = ceiling.subject_id
                AND expected_grants.property_id = ceiling.property_id
                AND expected_grants.command_type = ceiling.command_type
            )
        ) AS token_policy_ready,
        EXISTS (
          SELECT 1
          FROM staff_profile_reconciliation_state AS state
          CROSS JOIN canonical_manifest
          CROSS JOIN actual_projection_hash
          CROSS JOIN database_owner
          WHERE state.singleton
            AND state.manifest_name = ${expectedStaffProfileManifest.name}
            AND state.manifest_hash = encode(
              sha256(convert_to(canonical_manifest.value::text, 'UTF8')),
              'hex'
            )
            AND state.projection_hash = actual_projection_hash.value
            AND state.reconciled_by = database_owner.owner_name
        ) AS reconciliation_state_ready,
        (
          COALESCE((
            SELECT encode(sha256(convert_to(procedure_row.prosrc, 'UTF8')), 'hex') =
                'fe886ce2bf56de9b4b36b4931bded39e6fac66b89b3fe51d82d6150356fd52ee'
              AND procedure_row.proowner = database_owner.datdba
              AND procedure_row.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')
              AND NOT procedure_row.prosecdef
              AND procedure_row.provolatile = 'v'
              AND procedure_row.prokind = 'f'
              AND procedure_row.proconfig = ARRAY['search_path=pg_catalog, public']::text[]
            FROM pg_proc AS procedure_row
            CROSS JOIN database_owner
            WHERE procedure_row.oid = to_regprocedure('qintopia_reconcile_staff_profile_manifest(text,jsonb)')
          ), false)
          AND COALESCE((
            SELECT encode(sha256(convert_to(procedure_row.prosrc, 'UTF8')), 'hex') =
                'df28beb16b7f39b71d7430c193fe9272056e402442d74ba4c43a18641209b46b'
              AND procedure_row.proowner = database_owner.datdba
              AND procedure_row.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')
              AND NOT procedure_row.prosecdef
              AND procedure_row.provolatile = 'v'
              AND procedure_row.prokind = 'f'
              AND procedure_row.proconfig = ARRAY['search_path=pg_catalog, public']::text[]
            FROM pg_proc AS procedure_row
            CROSS JOIN database_owner
            WHERE procedure_row.oid = to_regprocedure('qintopia_guard_runtime_order_projection_update()')
          ), false)
          AND COALESCE((
            SELECT NOT trigger.tgisinternal
              AND trigger.tgenabled IN ('O', 'A')
              AND trigger.tgdeferrable
              AND trigger.tginitdeferred
              AND trigger.tgnargs = 0
              AND trigger.tgfoid = to_regprocedure('qintopia_guard_runtime_order_projection_update()')
              AND pg_get_triggerdef(trigger.oid, false) =
                'CREATE CONSTRAINT TRIGGER orders_runtime_projection_guard AFTER UPDATE ON public.orders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_guard_runtime_order_projection_update()'
            FROM pg_trigger AS trigger
            WHERE trigger.tgrelid = to_regclass('orders')
              AND trigger.tgname = 'orders_runtime_projection_guard'
          ), false)
          AND COALESCE((
            SELECT encode(sha256(convert_to(procedure_row.prosrc, 'UTF8')), 'hex') =
                '092ae1bb31ab8cd2b854e26f76fd58ab896d29a8dfb3393bc73a43d80038d5fe'
              AND procedure_row.proowner = database_owner.datdba
              AND procedure_row.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')
              AND NOT procedure_row.prosecdef
              AND procedure_row.provolatile = 'v'
              AND procedure_row.prokind = 'f'
              AND procedure_row.proconfig = ARRAY['search_path=pg_catalog, public']::text[]
            FROM pg_proc AS procedure_row
            CROSS JOIN database_owner
            WHERE procedure_row.oid = to_regprocedure('qintopia_guard_runtime_token_mutation()')
          ), false)
          AND COALESCE((
            SELECT NOT trigger.tgisinternal
              AND trigger.tgenabled IN ('O', 'A')
              AND trigger.tgdeferrable
              AND trigger.tginitdeferred
              AND trigger.tgnargs = 0
              AND trigger.tgfoid = to_regprocedure('qintopia_guard_runtime_token_mutation()')
              AND pg_get_triggerdef(trigger.oid, false) =
                'CREATE CONSTRAINT TRIGGER api_tokens_runtime_token_mutation_guard AFTER INSERT OR UPDATE ON public.api_tokens DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_guard_runtime_token_mutation()'
            FROM pg_trigger AS trigger
            WHERE trigger.tgrelid = to_regclass('api_tokens')
              AND trigger.tgname = 'api_tokens_runtime_token_mutation_guard'
          ), false)
          AND COALESCE((
            SELECT NOT trigger.tgisinternal
              AND trigger.tgenabled IN ('O', 'A')
              AND trigger.tgdeferrable
              AND trigger.tginitdeferred
              AND trigger.tgnargs = 0
              AND trigger.tgfoid = to_regprocedure('qintopia_guard_runtime_token_mutation()')
              AND pg_get_triggerdef(trigger.oid, false) =
                'CREATE CONSTRAINT TRIGGER token_command_ceilings_runtime_token_mutation_guard AFTER INSERT ON public.token_command_ceilings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_guard_runtime_token_mutation()'
            FROM pg_trigger AS trigger
            WHERE trigger.tgrelid = to_regclass('token_command_ceilings')
              AND trigger.tgname = 'token_command_ceilings_runtime_token_mutation_guard'
          ), false)
          AND COALESCE((
            SELECT encode(sha256(convert_to(procedure_row.prosrc, 'UTF8')), 'hex') =
                '3c31744fcbe0d1e2c41723a2074f3815800de7e5b3883d87f3475812d8a9c4fc'
              AND procedure_row.proowner = database_owner.datdba
              AND procedure_row.prolang = (SELECT oid FROM pg_language WHERE lanname = 'sql')
              AND NOT procedure_row.prosecdef
              AND procedure_row.provolatile = 's'
              AND procedure_row.prokind = 'f'
              AND procedure_row.proconfig = ARRAY['search_path=pg_catalog, public']::text[]
            FROM pg_proc AS procedure_row
            CROSS JOIN database_owner
            WHERE procedure_row.oid = to_regprocedure('qintopia_has_typed_runtime_command_evidence(text,text,text)')
          ), false)
          AND COALESCE((
            SELECT encode(sha256(convert_to(procedure_row.prosrc, 'UTF8')), 'hex') =
                'aec354b10b26d5ad696976098992bea0d6f6e10a8a8f363fa97cc125ff56404f'
              AND procedure_row.proowner = database_owner.datdba
              AND procedure_row.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')
              AND NOT procedure_row.prosecdef
              AND procedure_row.provolatile = 'v'
              AND procedure_row.prokind = 'f'
              AND procedure_row.proconfig = ARRAY['search_path=pg_catalog, public']::text[]
            FROM pg_proc AS procedure_row
            CROSS JOIN database_owner
            WHERE procedure_row.oid = to_regprocedure('qintopia_guard_runtime_membership_projection_update_050()')
          ), false)
          AND COALESCE((
            SELECT count(*) = 3
              AND bool_and(
                NOT trigger.tgisinternal
                AND trigger.tgenabled IN ('O', 'A')
                AND trigger.tgdeferrable
                AND trigger.tginitdeferred
                AND trigger.tgnargs = 0
                AND trigger.tgfoid = to_regprocedure('qintopia_guard_runtime_membership_projection_update_050()')
                AND pg_get_triggerdef(trigger.oid, false) = format(
                  'CREATE CONSTRAINT TRIGGER %s AFTER UPDATE ON public.%s DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_guard_runtime_membership_projection_update_050()',
                  expected.trigger_name,
                  expected.table_name
                )
              )
            FROM (VALUES
              ('membership_orders', 'membership_orders_runtime_projection_guard'),
              ('member_contracts', 'member_contracts_runtime_projection_guard'),
              ('entitlement_lots', 'entitlement_lots_runtime_projection_guard')
            ) AS expected(table_name, trigger_name)
            JOIN pg_trigger AS trigger
              ON trigger.tgrelid = to_regclass(expected.table_name)
              AND trigger.tgname = expected.trigger_name
          ), false)
          AND COALESCE((
            SELECT encode(sha256(convert_to(procedure_row.prosrc, 'UTF8')), 'hex') =
                'fa752d37272a7baf8a435b8175fb98849a6d28cab61b1229b3b58d50b90f2430'
              AND procedure_row.proowner = database_owner.datdba
              AND procedure_row.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')
              AND NOT procedure_row.prosecdef
              AND procedure_row.provolatile = 'v'
              AND procedure_row.prokind = 'f'
              AND procedure_row.proconfig = ARRAY['search_path=pg_catalog, public']::text[]
            FROM pg_proc AS procedure_row
            CROSS JOIN database_owner
            WHERE procedure_row.oid = to_regprocedure('qintopia_guard_runtime_inventory_unit_update()')
          ), false)
          AND COALESCE((
            SELECT count(*) = 1
              AND bool_and(
                NOT trigger.tgisinternal
                AND trigger.tgenabled IN ('O', 'A')
                AND NOT trigger.tgdeferrable
                AND NOT trigger.tginitdeferred
                AND trigger.tgnargs = 0
                AND trigger.tgrelid = to_regclass('inventory_units')
                AND trigger.tgname = 'inventory_units_runtime_update_guard'
                AND pg_get_triggerdef(trigger.oid, false) =
                  'CREATE TRIGGER inventory_units_runtime_update_guard BEFORE UPDATE ON public.inventory_units FOR EACH ROW EXECUTE FUNCTION qintopia_guard_runtime_inventory_unit_update()'
              )
            FROM pg_trigger AS trigger
            WHERE trigger.tgfoid = to_regprocedure('qintopia_guard_runtime_inventory_unit_update()')
          ), false)
          AND COALESCE((
            SELECT encode(sha256(convert_to(procedure_row.prosrc, 'UTF8')), 'hex') =
                '6e1b524d8743b8a109add35436be2347a337b08c3821b715c59c56a273bd9639'
              AND procedure_row.proowner = database_owner.datdba
              AND procedure_row.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')
              AND NOT procedure_row.prosecdef
              AND procedure_row.provolatile = 'v'
              AND procedure_row.prokind = 'f'
              AND procedure_row.proconfig = ARRAY['search_path=pg_catalog, public']::text[]
            FROM pg_proc AS procedure_row
            CROSS JOIN database_owner
            WHERE procedure_row.oid = to_regprocedure('qintopia_guard_runtime_mutable_projection_update()')
          ), false)
          AND COALESCE((
            SELECT count(*) = 8
              AND bool_and(
                NOT trigger.tgisinternal
                AND trigger.tgenabled IN ('O', 'A')
                AND trigger.tgdeferrable
                AND trigger.tginitdeferred
                AND trigger.tgnargs = 0
                AND trigger.tgfoid = to_regprocedure('qintopia_guard_runtime_mutable_projection_update()')
                AND pg_get_triggerdef(trigger.oid, false) = format(
                  'CREATE CONSTRAINT TRIGGER %s AFTER UPDATE ON public.%s DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_guard_runtime_mutable_projection_update()',
                  expected.trigger_name,
                  expected.table_name
                )
              )
            FROM (VALUES
              ('stays', 'stays_runtime_projection_guard'),
              ('coverage_items', 'coverage_items_runtime_projection_guard'),
              ('inventory_room_days', 'inventory_room_days_runtime_projection_guard'),
              ('inventory_bed_days', 'inventory_bed_days_runtime_projection_guard'),
              ('inventory_claims', 'inventory_claims_runtime_projection_guard'),
              ('maintenance_locks', 'maintenance_locks_runtime_projection_guard'),
              ('cleaning_tasks', 'cleaning_tasks_runtime_projection_guard'),
              ('room_status_revisions', 'room_status_revisions_runtime_projection_guard')
            ) AS expected(table_name, trigger_name)
            JOIN pg_trigger AS trigger
              ON trigger.tgrelid = to_regclass(expected.table_name)
              AND trigger.tgname = expected.trigger_name
          ), false)
        ) AS isolation_objects_ready
    `.execute(db);

    const runtimeIsolationReady = runtimeIsolation.rows[0];
    if (!runtimeIsolationReady
      || !runtimeIsolationReady.identity_ready
      || !runtimeIsolationReady.role_ready
      || !runtimeIsolationReady.memberships_ready
      || !runtimeIsolationReady.ownership_ready
      || !runtimeIsolationReady.capabilities_ready
      || !runtimeIsolationReady.update_privileges_ready
      || !runtimeIsolationReady.destructive_privileges_ready
      || !runtimeIsolationReady.profile_assignments_ready
      || !runtimeIsolationReady.profile_grants_ready
      || !runtimeIsolationReady.reviewed_manifest_ready
      || !runtimeIsolationReady.token_policy_ready
      || !runtimeIsolationReady.reconciliation_state_ready
      || !runtimeIsolationReady.isolation_objects_ready) {
      return false;
    }

    const memberProfileObjects = await sql<{
      columns_ready: boolean;
      constraints_ready: boolean;
      trigger_ready: boolean;
      function_body_ready: boolean;
    }>`
      SELECT
        (
          COALESCE((
            SELECT NOT attribute.attnotnull
              AND attribute.atttypid = 'text'::regtype
              AND NOT attribute.attisdropped
            FROM pg_attribute AS attribute
            WHERE attribute.attrelid = to_regclass('members')
              AND attribute.attname = 'identity_card_number'
          ), false)
          AND COALESCE((
            SELECT attribute.attnotnull
              AND attribute.atttypid = 'text'::regtype
              AND NOT attribute.attisdropped
            FROM pg_attribute AS attribute
            WHERE attribute.attrelid = to_regclass('members')
              AND attribute.attname = 'nickname'
          ), false)
          AND COALESCE((
            SELECT attribute.attnotnull
              AND attribute.atttypid = 'text'::regtype
              AND NOT attribute.attisdropped
            FROM pg_attribute AS attribute
            WHERE attribute.attrelid = to_regclass('members')
              AND attribute.attname = 'phone'
          ), false)
        ) AS columns_ready,
        (
          COALESCE((
            SELECT index_row.indisunique AND index_row.indisvalid
              AND index_row.indkey::smallint[] @> ARRAY[
                (SELECT attnum FROM pg_attribute
                  WHERE attrelid = to_regclass('members') AND attname = 'phone')
              ]::smallint[]
              AND index_row.indnkeyatts = 1
              AND pg_get_expr(index_row.indpred, index_row.indrelid) = '(deleted_at IS NULL)'
            FROM pg_index AS index_row
            WHERE index_row.indrelid = to_regclass('members')
              AND index_row.indexrelid = to_regclass('members_phone_unique')
          ), false)
          AND NOT EXISTS (
            SELECT 1
            FROM pg_constraint AS constraint_row
            WHERE constraint_row.conrelid = to_regclass('members')
              AND constraint_row.contype = 'u'
              AND constraint_row.conkey = ARRAY[
                (SELECT attnum FROM pg_attribute
                  WHERE attrelid = to_regclass('members') AND attname = 'identity_card_number')
              ]::smallint[]
          )
          AND COALESCE((
            SELECT constraint_row.contype = 'c'
              AND constraint_row.convalidated
              AND position('identity_card_number IS NULL' IN pg_get_constraintdef(constraint_row.oid, false)) > 0
              AND position('identity_card_number !~' IN pg_get_constraintdef(constraint_row.oid, false)) > 0
            FROM pg_constraint AS constraint_row
            WHERE constraint_row.conrelid = to_regclass('members')
              AND constraint_row.conname = 'members_identity_card_number_nonblank'
          ), false)
          AND COALESCE((
            SELECT constraint_row.contype = 'c'
              AND constraint_row.convalidated
              AND position('nickname !~' IN pg_get_constraintdef(constraint_row.oid, false)) > 0
            FROM pg_constraint AS constraint_row
            WHERE constraint_row.conrelid = to_regclass('members')
              AND constraint_row.conname = 'members_nickname_nonblank'
          ), false)
        ) AS constraints_ready,
        COALESCE((
          SELECT NOT trigger.tgisinternal
            AND trigger.tgenabled IN ('O','A')
            AND NOT trigger.tgdeferrable
            AND NOT trigger.tginitdeferred
            AND trigger.tgnargs = 0
            AND trigger.tgfoid = to_regprocedure('qintopia_normalize_new_member_identity()')
            AND pg_get_triggerdef(trigger.oid, false) =
              'CREATE TRIGGER members_normalize_new_identity BEFORE INSERT OR UPDATE OF identity_card_number, phone, nickname ON public.members FOR EACH ROW EXECUTE FUNCTION qintopia_normalize_new_member_identity()'
          FROM pg_trigger AS trigger
          WHERE trigger.tgrelid = to_regclass('members')
            AND trigger.tgname = 'members_normalize_new_identity'
        ), false) AS trigger_ready,
        COALESCE((
          SELECT regexp_replace(
              btrim(procedure_row.prosrc),
              '[[:space:]]+',
              ' ',
              'g'
            ) = regexp_replace(
              btrim($readiness$
                BEGIN
                  IF NEW.identity_card_number IS NOT NULL THEN
                    NEW.identity_card_number := upper(btrim(NEW.identity_card_number));
                  END IF;
                  NEW.phone := regexp_replace(NEW.phone, '[[:space:]]+', '', 'g');
                  NEW.nickname := btrim(NEW.nickname);
                  RETURN NEW;
                END;
              $readiness$),
              '[[:space:]]+',
              ' ',
              'g'
            )
            AND procedure_row.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')
            AND NOT procedure_row.prosecdef
            AND procedure_row.provolatile = 'v'
            AND procedure_row.proconfig IS NULL
            AND procedure_row.prokind = 'f'
          FROM pg_proc AS procedure_row
          WHERE procedure_row.oid = to_regprocedure('qintopia_normalize_new_member_identity()')
        ), false) AS function_body_ready
    `.execute(db);

    const foundationalObjects = await sql<{
      function_count: string;
      trigger_count: string;
      function_bodies_ready: boolean;
      membership_order_identity_body_ready: boolean;
      idempotency_constraint_ready: boolean;
      membership_payment_append_only_trigger_ready: boolean;
      membership_order_identity_trigger_ready: boolean;
    }>`
      SELECT
        (
          (to_regprocedure('qintopia_prevent_fact_mutation()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_protect_order_identity()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_protect_command_execution_identity()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_protect_api_token_identity()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_protect_membership_order_identity()') IS NOT NULL)::integer
        )::text AS function_count,
        count(*) FILTER (
          WHERE NOT trigger.tgisinternal
            AND NOT trigger.tgdeferrable
            AND NOT trigger.tginitdeferred
            AND trigger.tgenabled IN ('O','A')
            AND (
              (trigger.tgtype = 27
                AND trigger.tgfoid = to_regprocedure('qintopia_prevent_fact_mutation()')
                AND (trigger.tgrelid, trigger.tgname) IN (
                  (to_regclass('pricing_policy_versions'), 'pricing_policy_versions_append_only'),
                  (to_regclass('stay_segments'), 'stay_segments_append_only'),
                  (to_regclass('amendments'), 'amendments_append_only'),
                  (to_regclass('pricing_revisions'), 'pricing_revisions_append_only'),
                  (to_regclass('entitlement_ledger'), 'entitlement_ledger_append_only'),
                  (to_regclass('collection_facts'), 'collection_facts_append_only'),
                  (to_regclass('membership_payment_facts'), 'membership_payment_facts_append_only'),
                  (to_regclass('command_receipts'), 'command_receipts_append_only'),
                  (to_regclass('audit_entries'), 'audit_entries_append_only')
                ))
              OR (trigger.tgrelid = to_regclass('orders')
                AND trigger.tgname = 'orders_protect_identity'
                AND trigger.tgtype = 19
                AND trigger.tgfoid = to_regprocedure('qintopia_protect_order_identity()'))
              OR (trigger.tgrelid = to_regclass('command_executions')
                AND trigger.tgname = 'command_executions_protect_identity'
                AND trigger.tgtype = 27
                AND trigger.tgfoid = to_regprocedure('qintopia_protect_command_execution_identity()'))
              OR (trigger.tgrelid = to_regclass('api_tokens')
                AND trigger.tgname = 'api_tokens_protect_identity'
                AND trigger.tgtype = 27
                AND trigger.tgfoid = to_regprocedure('qintopia_protect_api_token_identity()'))
              OR (trigger.tgrelid = to_regclass('membership_orders')
                AND trigger.tgname = 'membership_orders_protect_identity'
                AND trigger.tgtype = 19
                AND trigger.tgfoid = to_regprocedure('qintopia_protect_membership_order_identity()'))
            )
        )::text AS trigger_count,
        (
          COALESCE((
            SELECT
              regexp_replace(
                btrim(procedure_row.prosrc),
                '[[:space:]]+',
                ' ',
                'g'
              ) = regexp_replace(
                btrim($readiness$
                  BEGIN
                    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
                  END;
                $readiness$),
                '[[:space:]]+',
                ' ',
                'g'
              )
            FROM pg_proc AS procedure_row
            WHERE procedure_row.oid = to_regprocedure('qintopia_prevent_fact_mutation()')
          ), false)
          AND COALESCE(position('NEW.pricing_policy_version_id IS DISTINCT FROM OLD.pricing_policy_version_id'
            IN pg_get_functiondef(to_regprocedure('qintopia_protect_order_identity()'))) > 0, false)
          AND COALESCE(position('command execution state may only advance from EXECUTING to a completed state'
            IN pg_get_functiondef(to_regprocedure('qintopia_protect_command_execution_identity()'))) > 0, false)
          AND COALESCE(position('api token state may only advance once from active to revoked or rotated'
            IN pg_get_functiondef(to_regprocedure('qintopia_protect_api_token_identity()'))) > 0, false)
        ) AS function_bodies_ready,
        COALESCE((
          SELECT encode(sha256(convert_to(procedure_row.prosrc, 'UTF8')), 'hex') =
              '56ce58874289275ab7c1a3ae05b58109e9e9903caf480520db67e831392e49d5'
            AND procedure_row.proowner = (
              SELECT database_row.datdba
              FROM pg_database AS database_row
              WHERE database_row.datname = current_database()
            )
            AND procedure_row.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')
            AND NOT procedure_row.prosecdef
            AND procedure_row.provolatile = 'v'
            AND procedure_row.proconfig = ARRAY['search_path=pg_catalog, public']::text[]
            AND procedure_row.prokind = 'f'
          FROM pg_proc AS procedure_row
          WHERE procedure_row.oid = to_regprocedure('qintopia_protect_membership_order_identity()')
        ), false) AS membership_order_identity_body_ready,
        EXISTS (
          SELECT 1
          FROM pg_constraint AS constraint_row
          WHERE constraint_row.conrelid = to_regclass('command_executions')
            AND constraint_row.conname = 'command_executions_idempotency_scope_key'
            AND constraint_row.contype = 'u'
            AND constraint_row.convalidated
            AND regexp_replace(
              btrim(pg_get_constraintdef(constraint_row.oid, false)),
              '[[:space:]]+',
              ' ',
              'g'
            ) = 'UNIQUE (subject_id, property_id, command_type, idempotency_key)'
        ) AS idempotency_constraint_ready,
        EXISTS (
          SELECT 1
          FROM pg_trigger AS exact_trigger
          WHERE exact_trigger.tgrelid = to_regclass('membership_payment_facts')
            AND exact_trigger.tgname = 'membership_payment_facts_append_only'
            AND NOT exact_trigger.tgisinternal
            AND NOT exact_trigger.tgdeferrable
            AND NOT exact_trigger.tginitdeferred
            AND exact_trigger.tgenabled IN ('O','A')
            AND exact_trigger.tgtype = 27
            AND exact_trigger.tgfoid = to_regprocedure('qintopia_prevent_fact_mutation()')
            AND exact_trigger.tgnargs = 0
            AND exact_trigger.tgattr::text = ''
            AND exact_trigger.tgqual IS NULL
        ) AS membership_payment_append_only_trigger_ready,
        EXISTS (
          SELECT 1
          FROM pg_trigger AS exact_trigger
          WHERE exact_trigger.tgrelid = to_regclass('membership_orders')
            AND exact_trigger.tgname = 'membership_orders_protect_identity'
            AND NOT exact_trigger.tgisinternal
            AND NOT exact_trigger.tgdeferrable
            AND NOT exact_trigger.tginitdeferred
            AND exact_trigger.tgenabled IN ('O','A')
            AND exact_trigger.tgtype = 19
            AND exact_trigger.tgfoid = to_regprocedure('qintopia_protect_membership_order_identity()')
            AND exact_trigger.tgnargs = 0
            AND exact_trigger.tgattr::text = ''
            AND exact_trigger.tgqual IS NULL
        ) AS membership_order_identity_trigger_ready
      FROM pg_trigger AS trigger
    `.execute(db);

    const stage10Objects = await sql<{
      function_count: string;
      deferred_trigger_count: string;
      immediate_trigger_count: string;
    }>`
      SELECT
        (
          (to_regprocedure('qintopia_assert_stage10_shorten_combination(text)') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_validate_stage10_shorten_combination()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_validate_stage10_pricing_revision()') IS NOT NULL)::integer
        )::text AS function_count,
        count(*) FILTER (
          WHERE NOT trigger.tgisinternal
            AND trigger.tgdeferrable
            AND trigger.tginitdeferred
            AND trigger.tgenabled IN ('O','A')
            AND (
              (relation.relname = 'amendments'
                AND trigger.tgname = 'amendments_stage10_validate_combination'
                AND handler.proname = 'qintopia_validate_stage10_shorten_combination')
              OR (relation.relname = 'command_executions'
                AND trigger.tgname = 'command_executions_stage10_validate_combination'
                AND handler.proname = 'qintopia_validate_stage10_shorten_execution')
            )
        )::text AS deferred_trigger_count,
        count(*) FILTER (
          WHERE NOT trigger.tgisinternal
            AND NOT trigger.tgdeferrable
            AND NOT trigger.tginitdeferred
            AND trigger.tgenabled IN ('O','A')
            AND trigger.tgtype = 7
            AND (
              (trigger.tgrelid = to_regclass('pricing_revisions')
                AND trigger.tgname = 'pricing_revisions_stage10_validate'
                AND handler.proname = 'qintopia_validate_stage10_pricing_revision')
              OR (trigger.tgrelid = to_regclass('amendments')
                AND trigger.tgname = 'amendments_stage10_reject_checkout_bypass'
                AND handler.proname = 'qintopia_reject_stage10_checkout_bypass')
              OR (trigger.tgrelid = to_regclass('entitlement_ledger')
                AND trigger.tgname = 'entitlement_ledger_stage10_reject_write'
                AND handler.proname = 'qintopia_reject_stage10_entitlement_write')
            )
        )::text AS immediate_trigger_count
      FROM pg_trigger AS trigger
      JOIN pg_class AS relation ON relation.oid = trigger.tgrelid
      JOIN pg_proc AS handler ON handler.oid = trigger.tgfoid
    `.execute(db);
    const stage11Objects = await sql<{
      function_count: string;
      replacement_count: string;
      body_marker_count: string;
      deferred_trigger_count: string;
      immediate_trigger_count: string;
    }>`
      SELECT
        (
          (to_regprocedure('qintopia_assert_stage11_shorten_before_timeline(text)') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_validate_stage11_shorten_before_timeline()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_validate_inventory_claim_source()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_assert_stage11_move_combination(text)') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_assert_stage11_date_change_combination(text)') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_validate_stage11_move_combination()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_validate_stage11_move_execution()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_validate_stage11_move_revision()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_validate_stage11_move_amendment()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_preserve_stage11_consumed_coverage()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_validate_stage11_move_ledger()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_reject_stage11_move_collection()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_preserve_stage11_preview_evidence()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_assert_stage11_protocol_evidence(text,text)') IS NOT NULL)::integer
        )::text AS function_count,
        (
          COALESCE(
            position(
              'stage10_shorten_future_move_boundary'
              IN pg_get_functiondef(to_regprocedure('qintopia_assert_stage10_shorten_combination(text)'))
            ) = 0,
            false
          )::integer
          + COALESCE(
            position(
              'reschedule_pair_valid'
              IN pg_get_functiondef(to_regprocedure('qintopia_validate_inventory_claim_source()'))
            ) > 0,
            false
          )::integer
        )::text AS replacement_count,
        (
          COALESCE(position('stage11_move_order_command_chain'
            IN pg_get_functiondef(to_regprocedure('qintopia_assert_stage11_move_combination(text)'))) > 0, false)::integer
          + COALESCE(position('stage11_move_inventory_diff'
            IN pg_get_functiondef(to_regprocedure('qintopia_assert_stage11_move_combination(text)'))) > 0, false)::integer
          + COALESCE(position('ledger.service_date < effective_date'
            IN pg_get_functiondef(to_regprocedure('qintopia_assert_stage11_move_combination(text)'))) > 0, false)::integer
          + COALESCE(position('stage11_date_change_order_command_chain'
            IN pg_get_functiondef(to_regprocedure('qintopia_assert_stage11_date_change_combination(text)'))) > 0, false)::integer
          + COALESCE(position('stage11_date_change_plan_b'
            IN pg_get_functiondef(to_regprocedure('qintopia_assert_stage11_date_change_combination(text)'))) > 0, false)::integer
          + COALESCE(position('target_preview.effect IS DISTINCT FROM target_amendment.payload'
            IN pg_get_functiondef(to_regprocedure('qintopia_assert_stage11_protocol_evidence(text,text)'))) > 0, false)::integer
          + COALESCE(position('target_receipt.result ->> ''effectHash'' IS DISTINCT FROM target_preview.effect_hash'
            IN pg_get_functiondef(to_regprocedure('qintopia_assert_stage11_protocol_evidence(text,text)'))) > 0, false)::integer
          + COALESCE(position('stage11_preview_evidence_immutable'
            IN pg_get_functiondef(to_regprocedure('qintopia_preserve_stage11_preview_evidence()'))) > 0, false)::integer
        )::text AS body_marker_count,
        count(*) FILTER (
          WHERE NOT trigger.tgisinternal
            AND trigger.tgenabled IN ('O','A')
            AND trigger.tgdeferrable
            AND trigger.tginitdeferred
            AND (
              (relation.relname = 'amendments'
                AND trigger.tgname = 'amendments_stage11_validate_shorten_before_timeline'
                AND trigger.tgtype = 5
                AND handler.proname = 'qintopia_validate_stage11_shorten_before_timeline')
              OR (relation.relname = 'command_executions'
                AND trigger.tgname = 'command_executions_stage11_validate_shorten_before_timeline'
                AND trigger.tgtype = 21
                AND handler.proname = 'qintopia_validate_stage11_shorten_before_timeline')
              OR (relation.relname = 'amendments'
                AND trigger.tgname = 'amendments_stage11_validate_move_combination'
                AND trigger.tgtype = 5
                AND handler.proname = 'qintopia_validate_stage11_move_combination')
              OR (relation.relname = 'command_executions'
                AND trigger.tgname = 'command_executions_stage11_validate_move_combination'
                AND trigger.tgtype = 21
                AND handler.proname = 'qintopia_validate_stage11_move_execution')
            )
        )::text AS deferred_trigger_count,
        count(*) FILTER (
          WHERE NOT trigger.tgisinternal
            AND trigger.tgenabled IN ('O','A')
            AND NOT trigger.tgdeferrable
            AND NOT trigger.tginitdeferred
            AND (
              (relation.relname = 'pricing_revisions'
                AND trigger.tgname = 'pricing_revisions_stage11_validate_move'
                AND trigger.tgtype = 7
                AND handler.proname = 'qintopia_validate_stage11_move_revision')
              OR (relation.relname = 'amendments'
                AND trigger.tgname = 'amendments_stage11_validate_move'
                AND trigger.tgtype = 7
                AND handler.proname = 'qintopia_validate_stage11_move_amendment')
              OR (relation.relname = 'coverage_items'
                AND trigger.tgname = 'coverage_items_stage11_preserve_consumed_update'
                AND trigger.tgtype = 19
                AND handler.proname = 'qintopia_preserve_stage11_consumed_coverage')
              OR (relation.relname = 'coverage_items'
                AND trigger.tgname = 'coverage_items_stage11_preserve_consumed_delete'
                AND trigger.tgtype = 11
                AND handler.proname = 'qintopia_preserve_stage11_consumed_coverage')
              OR (relation.relname = 'entitlement_ledger'
                AND trigger.tgname = 'entitlement_ledger_stage11_validate_move'
                AND trigger.tgtype = 7
                AND handler.proname = 'qintopia_validate_stage11_move_ledger')
              OR (relation.relname = 'collection_facts'
                AND trigger.tgname = 'collection_facts_stage11_reject_move'
                AND trigger.tgtype = 7
                AND handler.proname = 'qintopia_reject_stage11_move_collection')
              OR (relation.relname = 'inventory_claims'
                AND trigger.tgname = 'inventory_claims_validate_source'
                AND trigger.tgtype = 23
                AND handler.proname = 'qintopia_validate_inventory_claim_source')
              OR (relation.relname = 'command_previews'
                AND trigger.tgname = 'command_previews_stage11_preserve_evidence'
                AND trigger.tgtype = 19
                AND handler.proname = 'qintopia_preserve_stage11_preview_evidence')
            )
        )::text AS immediate_trigger_count
      FROM pg_trigger AS trigger
      JOIN pg_class AS relation ON relation.oid = trigger.tgrelid
      JOIN pg_proc AS handler ON handler.oid = trigger.tgfoid
    `.execute(db);
    const collectionFactObjects = await sql<{
      function_count: string;
      trigger_count: string;
      historical_column_count: string;
      body_marker_count: string;
      trigger_bindings_ready: boolean;
      function_bodies_ready: boolean;
    }>`
      SELECT
        (to_regprocedure('qintopia_validate_new_collection_fact_transaction_reference()') IS NOT NULL)::integer::text
          AS function_count,
        count(*) FILTER (
          WHERE NOT trigger.tgisinternal
            AND trigger.tgenabled IN ('O','A')
            AND NOT trigger.tgdeferrable
            AND NOT trigger.tginitdeferred
            AND trigger.tgtype = 7
            AND trigger.tgrelid = to_regclass('collection_facts')
            AND trigger.tgname = 'collection_facts_validate_new_transaction_reference'
            AND trigger.tgfoid = to_regprocedure('qintopia_validate_new_collection_fact_transaction_reference()')
            AND trigger.tgnargs = 0
            AND trigger.tgqual IS NULL
        )::text AS trigger_count,
        (
          SELECT count(*)::text
          FROM pg_attribute AS attribute
          WHERE attribute.attrelid = to_regclass('collection_facts')
            AND attribute.attname = 'pricing_revision_id'
            AND NOT attribute.attnotnull
            AND NOT attribute.attisdropped
        ) AS historical_column_count,
        (
          COALESCE(position('collection_facts_new_pricing_revision_required'
            IN pg_get_functiondef(to_regprocedure('qintopia_validate_new_collection_fact_transaction_reference()'))) > 0, false)::integer
          + COALESCE(position('collection_facts_method_transaction_reference_required'
            IN pg_get_functiondef(to_regprocedure('qintopia_validate_new_collection_fact_transaction_reference()'))) > 0, false)::integer
          + COALESCE(position('(NEW.fact_type = ''COLLECTION'' AND NEW.method = ''WECOM'')'
            IN pg_get_functiondef(to_regprocedure('qintopia_validate_new_collection_fact_transaction_reference()'))) > 0, false)::integer
          + COALESCE(position('collection_facts_cash_other_transaction_reference_null'
            IN pg_get_functiondef(to_regprocedure('qintopia_validate_new_collection_fact_transaction_reference()'))) > 0, false)::integer
          + COALESCE(position('collection_facts_wecom_refund_transaction_reference_null'
            IN pg_get_functiondef(to_regprocedure('qintopia_validate_new_collection_fact_transaction_reference()'))) > 0, false)::integer
          + COALESCE(position('collection_facts_wecom_refund_original_route'
            IN pg_get_functiondef(to_regprocedure('qintopia_validate_new_collection_fact_transaction_reference()'))) > 0, false)::integer
        )::text AS body_marker_count,
        (
          SELECT NOT EXISTS (
            SELECT 1
            FROM (
              VALUES (
                'collection_facts',
                'collection_facts_validate_new_transaction_reference',
                'CREATE TRIGGER collection_facts_validate_new_transaction_reference BEFORE INSERT ON public.collection_facts FOR EACH ROW EXECUTE FUNCTION qintopia_validate_new_collection_fact_transaction_reference()'
              )
            ) AS expected(table_name, trigger_name, definition)
            WHERE NOT EXISTS (
              SELECT 1
              FROM pg_trigger AS exact_trigger
              WHERE exact_trigger.tgrelid = to_regclass(expected.table_name)
                AND exact_trigger.tgname = expected.trigger_name
                AND NOT exact_trigger.tgisinternal
                AND exact_trigger.tgenabled IN ('O','A')
                AND exact_trigger.tgnargs = 0
                AND pg_get_triggerdef(exact_trigger.oid, false) = expected.definition
            )
          )
        ) AS trigger_bindings_ready,
        (
          SELECT NOT EXISTS (
            SELECT 1
            FROM (
              VALUES
                ('qintopia_validate_new_collection_fact_transaction_reference()', '424dd22174300cf686be9422dd8b9b42ef4e7f48fa0266f504bf6f4316dabbe3')
            ) AS expected(signature, body_hash)
            WHERE NOT COALESCE((
              SELECT encode(
                sha256(convert_to(procedure_row.prosrc, 'UTF8')),
                'hex'
              ) = expected.body_hash
                AND procedure_row.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')
                AND NOT procedure_row.prosecdef
                AND procedure_row.provolatile = 'v'
                AND procedure_row.proconfig IS NULL
                AND procedure_row.prokind = 'f'
              FROM pg_proc AS procedure_row
              WHERE procedure_row.oid = to_regprocedure(expected.signature)
            ), false)
          )
        ) AS function_bodies_ready
      FROM pg_trigger AS trigger
    `.execute(db);
    const completedStayBackfillObjects = await sql<{
      cash_column_count: string;
      cash_constraint_count: string;
      cash_function_count: string;
      cash_trigger_count: string;
      cash_body_marker_count: string;
      checkout_body_marker_count: string;
    }>`
      SELECT
        (
          SELECT count(*)::text
          FROM pg_attribute AS attribute
          WHERE attribute.attrelid = to_regclass('collection_facts')
            AND attribute.attname = 'cash_collector'
            AND attribute.atttypid = 'text'::regtype
            AND NOT attribute.attnotnull
            AND NOT attribute.attisdropped
        ) AS cash_column_count,
        (
          SELECT count(*)::text
          FROM pg_constraint AS constraint_row
          WHERE constraint_row.conrelid = to_regclass('collection_facts')
            AND constraint_row.conname = 'collection_facts_cash_collector_nonblank'
            AND constraint_row.contype = 'c'
            AND pg_get_constraintdef(constraint_row.oid, false)
              = 'CHECK (((cash_collector IS NULL) OR (btrim(cash_collector) <> ''''::text)))'
        ) AS cash_constraint_count,
        (to_regprocedure('qintopia_validate_backfill_cash_collection()') IS NOT NULL)::integer::text
          AS cash_function_count,
        count(*) FILTER (
          WHERE NOT trigger.tgisinternal
            AND trigger.tgenabled IN ('O','A')
            AND NOT trigger.tgdeferrable
            AND NOT trigger.tginitdeferred
            AND trigger.tgtype = 7
            AND trigger.tgrelid = to_regclass('collection_facts')
            AND trigger.tgname = 'collection_facts_validate_backfill_cash'
            AND trigger.tgfoid = to_regprocedure('qintopia_validate_backfill_cash_collection()')
        )::text AS cash_trigger_count,
        (
          COALESCE(position('collection_facts_backfill_cash_collector_required'
            IN pg_get_functiondef(to_regprocedure('qintopia_validate_backfill_cash_collection()'))) > 0, false)::integer
          + COALESCE(position('collection_facts_backfill_cash_note_required'
            IN pg_get_functiondef(to_regprocedure('qintopia_validate_backfill_cash_collection()'))) > 0, false)::integer
        )::text AS cash_body_marker_count,
        (
          COALESCE(position('amendments_backfill_create_order_checkout_chain'
            IN pg_get_functiondef(to_regprocedure('qintopia_reject_stage10_checkout_bypass()'))) > 0, false)::integer
          + COALESCE(position('execution_type = ''CREATE_ORDER'''
            IN pg_get_functiondef(to_regprocedure('qintopia_reject_stage10_checkout_bypass()'))) > 0, false)::integer
          + COALESCE(position('created.reason_code = ''BACKFILL_STAY'''
            IN pg_get_functiondef(to_regprocedure('qintopia_reject_stage10_checkout_bypass()'))) > 0, false)::integer
          + COALESCE(position('checked_in.amendment_type = ''CHECK_IN'''
            IN pg_get_functiondef(to_regprocedure('qintopia_reject_stage10_checkout_bypass()'))) > 0, false)::integer
        )::text AS checkout_body_marker_count
      FROM pg_trigger AS trigger
    `.execute(db);
    const completeStayGuardObjects = await sql<{
      function_bodies_ready: boolean;
      fulfillment_index_ready: boolean;
      trigger_bindings_ready: boolean;
    }>`
      SELECT
        (
          SELECT NOT EXISTS (
            SELECT 1
            FROM (
              VALUES
                ('qintopia_reject_stage10_checkout_bypass()', '620a6560ed68e60617bd70e1a8581c65c94ce2ce098397f9af0110cecd086b33'),
                ('qintopia_validate_complete_stay_execution_chain()', '6e56cb43654dada83fa420d23370558fd22e877b868178d227630bd36640b639'),
                ('qintopia_validate_backfill_cash_collection()', '1c3ccea500c20ba6837d7222a7558a1d83fb65a85f56fcaa17a38e0c48e8dd5f')
            ) AS expected(signature, body_hash)
            WHERE NOT COALESCE((
              SELECT encode(
                  sha256(convert_to(procedure_row.prosrc, 'UTF8')),
                  'hex'
                ) = expected.body_hash
                AND procedure_row.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')
                AND NOT procedure_row.prosecdef
                AND procedure_row.provolatile = 'v'
                AND procedure_row.proconfig IS NULL
                AND procedure_row.prokind = 'f'
              FROM pg_proc AS procedure_row
              WHERE procedure_row.oid = to_regprocedure(expected.signature)
            ), false)
          )
        ) AS function_bodies_ready,
        EXISTS (
          SELECT 1
          FROM pg_index AS index_row
          WHERE index_row.indexrelid = to_regclass('amendments_one_fulfillment_type_per_command')
            AND index_row.indrelid = to_regclass('amendments')
            AND index_row.indisunique
            AND index_row.indimmediate
            AND index_row.indisvalid
            AND index_row.indisready
            AND pg_get_indexdef(index_row.indexrelid, 0, false)
              = 'CREATE UNIQUE INDEX amendments_one_fulfillment_type_per_command ON public.amendments USING btree (command_id, amendment_type) WHERE ((command_id IS NOT NULL) AND (amendment_type = ANY (ARRAY[''CHECK_IN''::text, ''CHECK_OUT''::text])))'
        ) AS fulfillment_index_ready,
        (
          SELECT NOT EXISTS (
            SELECT 1
            FROM (
              VALUES
                ('amendments', 'amendments_complete_stay_exact_pair',
                  'CREATE CONSTRAINT TRIGGER amendments_complete_stay_exact_pair AFTER INSERT ON public.amendments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_validate_complete_stay_execution_chain()'),
                ('command_executions', 'command_executions_complete_stay_exact_pair',
                  'CREATE CONSTRAINT TRIGGER command_executions_complete_stay_exact_pair AFTER INSERT OR UPDATE ON public.command_executions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_validate_complete_stay_execution_chain()')
            ) AS expected(table_name, trigger_name, definition)
            WHERE NOT EXISTS (
              SELECT 1
              FROM pg_trigger AS exact_trigger
              WHERE exact_trigger.tgrelid = to_regclass(expected.table_name)
                AND exact_trigger.tgname = expected.trigger_name
                AND NOT exact_trigger.tgisinternal
                AND exact_trigger.tgenabled IN ('O','A')
                AND exact_trigger.tgnargs = 0
                AND pg_get_triggerdef(exact_trigger.oid, false) = expected.definition
            )
          )
        ) AS trigger_bindings_ready
    `.execute(db);
    const stage12Objects = await sql<{
      function_count: string;
      deferred_trigger_count: string;
      immediate_trigger_count: string;
      status_constraint_count: string;
      restore_index_count: string;
      body_marker_count: string;
    }>`
      SELECT
        (
          (to_regprocedure('qintopia_validate_entitlement_lifecycle_fact()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_validate_stage12_terminal_amendment()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_validate_stage12_terminal_revision()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_assert_stage12_terminal_command(text)') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_validate_stage12_terminal_execution()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_validate_stage12_terminal_child()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_protect_stage12_terminal_status()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_validate_stage12_order_terminal_transition()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_validate_stage12_stay_terminal_transition()') IS NOT NULL)::integer
        )::text AS function_count,
        count(*) FILTER (
          WHERE NOT trigger.tgisinternal
            AND trigger.tgdeferrable
            AND trigger.tginitdeferred
            AND trigger.tgenabled IN ('O','A')
            AND (
              (trigger.tgrelid = to_regclass('command_executions')
                AND trigger.tgname = 'command_executions_stage12_validate_terminal'
                AND trigger.tgtype = 21
                AND trigger.tgfoid = to_regprocedure('qintopia_validate_stage12_terminal_execution()')
                AND position('UPDATE OF state' IN pg_get_triggerdef(trigger.oid)) > 0)
              OR (trigger.tgrelid = to_regclass('entitlement_ledger')
                AND trigger.tgname = 'entitlement_ledger_stage12_validate_terminal'
                AND trigger.tgtype = 5
                AND trigger.tgfoid = to_regprocedure('qintopia_validate_stage12_terminal_child()'))
              OR (trigger.tgrelid = to_regclass('orders')
                AND trigger.tgname = 'orders_stage12_validate_terminal_transition'
                AND trigger.tgtype = 17
                AND trigger.tgfoid = to_regprocedure('qintopia_validate_stage12_order_terminal_transition()')
                AND position('UPDATE OF status' IN pg_get_triggerdef(trigger.oid)) > 0)
              OR (trigger.tgrelid = to_regclass('stays')
                AND trigger.tgname = 'stays_stage12_validate_terminal_transition'
                AND trigger.tgtype = 17
                AND trigger.tgfoid = to_regprocedure('qintopia_validate_stage12_stay_terminal_transition()')
                AND position('UPDATE OF status' IN pg_get_triggerdef(trigger.oid)) > 0)
            )
        )::text AS deferred_trigger_count,
        count(*) FILTER (
          WHERE NOT trigger.tgisinternal
            AND NOT trigger.tgdeferrable
            AND NOT trigger.tginitdeferred
            AND trigger.tgenabled IN ('O','A')
            AND (
              (trigger.tgrelid = to_regclass('amendments')
                AND trigger.tgname = 'amendments_stage12_validate_terminal'
                AND trigger.tgtype = 7
                AND trigger.tgfoid = to_regprocedure('qintopia_validate_stage12_terminal_amendment()'))
              OR (trigger.tgrelid = to_regclass('pricing_revisions')
                AND trigger.tgname = 'pricing_revisions_stage12_validate_terminal'
                AND trigger.tgtype = 7
                AND trigger.tgfoid = to_regprocedure('qintopia_validate_stage12_terminal_revision()'))
              OR (trigger.tgrelid = to_regclass('orders')
                AND trigger.tgname = 'orders_stage12_protect_terminal_status'
                AND trigger.tgtype = 19
                AND trigger.tgfoid = to_regprocedure('qintopia_protect_stage12_terminal_status()')
                AND position('UPDATE OF status' IN pg_get_triggerdef(trigger.oid)) > 0)
              OR (trigger.tgrelid = to_regclass('stays')
                AND trigger.tgname = 'stays_stage12_protect_terminal_status'
                AND trigger.tgtype = 19
                AND trigger.tgfoid = to_regprocedure('qintopia_protect_stage12_terminal_status()')
                AND position('UPDATE OF status' IN pg_get_triggerdef(trigger.oid)) > 0)
              OR (trigger.tgrelid = to_regclass('entitlement_ledger')
                AND trigger.tgname = 'entitlement_ledger_validate_lifecycle_fact'
                AND trigger.tgtype = 7
                AND trigger.tgfoid = to_regprocedure('qintopia_validate_entitlement_lifecycle_fact()'))
            )
        )::text AS immediate_trigger_count,
        (
          SELECT count(*)::text
          FROM pg_constraint AS constraint_row
          WHERE constraint_row.contype = 'c'
            AND constraint_row.convalidated
            AND (
              (constraint_row.conrelid = to_regclass('orders')
                AND constraint_row.conname = 'orders_status_check'
                AND position('CHECK_IN_REVOKED' IN pg_get_constraintdef(constraint_row.oid)) > 0
                AND position('NO_SHOW' IN pg_get_constraintdef(constraint_row.oid)) > 0
                AND position('CANCELLED' IN pg_get_constraintdef(constraint_row.oid)) > 0)
              OR (constraint_row.conrelid = to_regclass('stays')
                AND constraint_row.conname = 'stays_status_check'
                AND position('CHECK_IN_REVOKED' IN pg_get_constraintdef(constraint_row.oid)) > 0
                AND position('NO_SHOW' IN pg_get_constraintdef(constraint_row.oid)) > 0
                AND position('CANCELLED' IN pg_get_constraintdef(constraint_row.oid)) > 0)
            )
        ) AS status_constraint_count,
        (
          SELECT count(*)::text
          FROM pg_index AS index
          JOIN pg_class AS index_relation ON index_relation.oid = index.indexrelid
          WHERE index.indrelid = to_regclass('entitlement_ledger')
            AND index_relation.relname = 'entitlement_ledger_one_restore_per_coverage_idx'
            AND index.indisunique
            AND index.indisvalid
            AND index.indisready
            AND position('(coverage_id)' IN pg_get_indexdef(index.indexrelid)) > 0
            AND position('RESTORE' IN pg_get_expr(index.indpred, index.indrelid)) > 0
        ) AS restore_index_count,
        (
          COALESCE(position('entitlement_ledger_restore_command'
            IN pg_get_functiondef(to_regprocedure('qintopia_validate_entitlement_lifecycle_fact()'))) > 0, false)::integer
          + COALESCE(position('stage12_terminal_zero_revision'
            IN pg_get_functiondef(to_regprocedure('qintopia_validate_stage12_terminal_revision()'))) > 0, false)::integer
          + COALESCE(position('stage12_terminal_inventory_entitlement'
            IN pg_get_functiondef(to_regprocedure('qintopia_assert_stage12_terminal_command(text)'))) > 0, false)::integer
          + COALESCE(position('stage12_terminal_funds'
            IN pg_get_functiondef(to_regprocedure('qintopia_assert_stage12_terminal_command(text)'))) > 0, false)::integer
          + COALESCE(position('stage12_terminal_status_typed'
            IN pg_get_functiondef(to_regprocedure('qintopia_validate_stage12_order_terminal_transition()'))) > 0, false)::integer
          + COALESCE(position('stage12_terminal_status_typed'
            IN pg_get_functiondef(to_regprocedure('qintopia_validate_stage12_stay_terminal_transition()'))) > 0, false)::integer
        )::text AS body_marker_count
      FROM pg_trigger AS trigger
    `.execute(db);
    const stage13Objects = await sql<{
      function_count: string;
      deferred_trigger_count: string;
      immediate_trigger_count: string;
      table_count: string;
      source_column_count: string;
      critical_constraints_ready: boolean;
      index_count: string;
      body_marker_count: string;
      execution_wrapper_body_ready: boolean;
      child_wrapper_body_ready: boolean;
      membership_order_wrapper_body_ready: boolean;
      trigger_bindings_ready: boolean;
      function_bodies_ready: boolean;
    }>`
      SELECT
        (
          (to_regprocedure('qintopia_validate_membership_payment_fact()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_validate_stay_collection_membership_transfer()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_require_transfer_membership_payment_bridge()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_reject_lodging_funds_after_membership_transfer()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_reject_membership_funds_after_stay_transfer()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_validate_conversion_consume_entitlement_fact()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_assert_stage13_stay_conversion_command(text)') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_validate_stage13_stay_conversion_execution()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_validate_stage13_stay_conversion_child()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_require_stage13_conversion_reversal_bridge()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_assert_stage13_stay_conversion_command_v033(text)') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_validate_stage13_stay_conversion_membership_order()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_validate_new_collection_fact_shape()') IS NOT NULL)::integer
        )::text AS function_count,
        count(*) FILTER (
          WHERE NOT trigger.tgisinternal
            AND trigger.tgdeferrable
            AND trigger.tginitdeferred
            AND trigger.tgenabled IN ('O','A')
            AND (
              (trigger.tgrelid = to_regclass('membership_payment_facts')
                AND trigger.tgname = 'membership_payment_transfer_bridge_required'
                AND trigger.tgtype = 5
                AND trigger.tgfoid = to_regprocedure('qintopia_require_transfer_membership_payment_bridge()'))
              OR (trigger.tgrelid = to_regclass('command_executions')
                AND trigger.tgname = 'command_executions_stage13_validate_stay_conversion'
                AND trigger.tgtype = 21
                AND trigger.tgfoid = to_regprocedure('qintopia_validate_stage13_stay_conversion_execution()')
                AND position('UPDATE OF state' IN pg_get_triggerdef(trigger.oid)) > 0)
              OR (trigger.tgrelid = to_regclass('stay_collection_membership_transfers')
                AND trigger.tgname = 'transfers_stage13_validate_stay_conversion'
                AND trigger.tgtype = 5
                AND trigger.tgfoid = to_regprocedure('qintopia_validate_stage13_stay_conversion_child()'))
              OR (trigger.tgrelid = to_regclass('collection_facts')
                AND trigger.tgname = 'collection_facts_stage13_validate_stay_conversion'
                AND trigger.tgtype = 5
                AND trigger.tgfoid = to_regprocedure('qintopia_validate_stage13_stay_conversion_child()'))
              OR (trigger.tgrelid = to_regclass('membership_payment_facts')
                AND trigger.tgname = 'membership_payment_facts_stage13_validate_stay_conversion'
                AND trigger.tgtype = 5
                AND trigger.tgfoid = to_regprocedure('qintopia_validate_stage13_stay_conversion_child()'))
              OR (trigger.tgrelid = to_regclass('entitlement_ledger')
                AND trigger.tgname = 'entitlement_ledger_stage13_validate_stay_conversion'
                AND trigger.tgtype = 5
                AND trigger.tgfoid = to_regprocedure('qintopia_validate_stage13_stay_conversion_child()')
                AND trigger.tgqual IS NULL)
              OR (trigger.tgrelid = to_regclass('collection_facts')
                AND trigger.tgname = 'collection_facts_stage13_require_conversion_reversal_bridge'
                AND trigger.tgtype = 5
                AND trigger.tgfoid = to_regprocedure('qintopia_require_stage13_conversion_reversal_bridge()')
                AND position('REVERSAL' IN pg_get_triggerdef(trigger.oid)) > 0)
              OR (trigger.tgrelid = to_regclass('amendments')
                AND trigger.tgname = 'amendments_stage13_validate_stay_conversion'
                AND trigger.tgtype = 5
                AND trigger.tgfoid = to_regprocedure('qintopia_validate_stage13_stay_conversion_child()')
                AND position('command_id IS NOT NULL' IN pg_get_triggerdef(trigger.oid)) > 0)
              OR (trigger.tgrelid = to_regclass('membership_orders')
                AND trigger.tgname = 'membership_orders_stage13_validate_stay_conversion'
                AND trigger.tgtype = 21
                AND trigger.tgfoid = to_regprocedure('qintopia_validate_stage13_stay_conversion_membership_order()')
                AND position('UPDATE OF activated_by_command_id' IN pg_get_triggerdef(trigger.oid)) > 0)
            )
        )::text AS deferred_trigger_count,
        count(*) FILTER (
          WHERE NOT trigger.tgisinternal
            AND NOT trigger.tgdeferrable
            AND NOT trigger.tginitdeferred
            AND trigger.tgenabled IN ('O','A')
            AND (
              (trigger.tgrelid = to_regclass('membership_payment_facts')
                AND trigger.tgname = 'membership_payment_validate_insert'
                AND trigger.tgtype = 7
                AND trigger.tgfoid = to_regprocedure('qintopia_validate_membership_payment_fact()'))
              OR (trigger.tgrelid = to_regclass('stay_collection_membership_transfers')
                AND trigger.tgname = 'stay_collection_membership_transfers_validate_insert'
                AND trigger.tgtype = 7
                AND trigger.tgfoid = to_regprocedure('qintopia_validate_stay_collection_membership_transfer()'))
              OR (trigger.tgrelid = to_regclass('stay_collection_membership_transfers')
                AND trigger.tgname = 'stay_collection_membership_transfers_append_only'
                AND trigger.tgtype = 27
                AND trigger.tgfoid = to_regprocedure('qintopia_prevent_fact_mutation()'))
              OR (trigger.tgrelid = to_regclass('collection_facts')
                AND trigger.tgname = 'collection_facts_stage13_reject_after_transfer'
                AND trigger.tgtype = 7
                AND trigger.tgfoid = to_regprocedure('qintopia_reject_lodging_funds_after_membership_transfer()'))
              OR (trigger.tgrelid = to_regclass('membership_payment_facts')
                AND trigger.tgname = 'membership_payment_stage13_reject_after_transfer'
                AND trigger.tgtype = 7
                AND trigger.tgfoid = to_regprocedure('qintopia_reject_membership_funds_after_stay_transfer()'))
              OR (trigger.tgrelid = to_regclass('entitlement_ledger')
                AND trigger.tgname = 'entitlement_ledger_validate_conversion_consume'
                AND trigger.tgtype = 7
                AND trigger.tgfoid = to_regprocedure('qintopia_validate_conversion_consume_entitlement_fact()'))
              OR (trigger.tgrelid = to_regclass('collection_facts')
                AND trigger.tgname = 'collection_facts_validate_new_write_shape'
                AND trigger.tgtype = 7
                AND trigger.tgfoid = to_regprocedure('qintopia_validate_new_collection_fact_shape()'))
            )
        )::text AS immediate_trigger_count,
        (
          SELECT count(*)::text
          FROM pg_class AS relation
          WHERE relation.oid = to_regclass('stay_collection_membership_transfers')
            AND relation.relkind = 'r'
        ) AS table_count,
        (
          SELECT count(*)::text
          FROM pg_attribute AS attribute
          JOIN pg_attrdef AS default_value
            ON default_value.adrelid = attribute.attrelid
            AND default_value.adnum = attribute.attnum
          WHERE attribute.attrelid = to_regclass('membership_payment_facts')
            AND attribute.attname = 'source_type'
            AND attribute.attnotnull
            AND NOT attribute.attisdropped
            AND position('DIRECT_WECOM' IN pg_get_expr(default_value.adbin, default_value.adrelid)) > 0
        ) AS source_column_count,
        (
          SELECT NOT EXISTS (
            SELECT 1
            FROM (
              VALUES
                ('membership_payment_facts', 'membership_payment_facts_source_order_id_fkey', 'f',
                  'FOREIGN KEY (source_order_id) REFERENCES orders(id)'),
                ('membership_payment_facts', 'membership_payment_facts_source_collection_fact_id_fkey', 'f',
                  'FOREIGN KEY (source_collection_fact_id) REFERENCES collection_facts(fact_id)'),
                ('membership_payment_facts', 'membership_payment_source_type_check', 'c',
                  'CHECK ((source_type = ANY (ARRAY[''DIRECT_WECOM''::text, ''STAY_COLLECTION_TRANSFER''::text])))'),
                ('membership_payment_facts', 'membership_payment_direct_source_null', 'c',
                  'CHECK (((source_type <> ''DIRECT_WECOM''::text) OR ((source_order_id IS NULL) AND (source_collection_fact_id IS NULL))))'),
                ('membership_payment_facts', 'membership_payment_transfer_source_required', 'c',
                  'CHECK (((source_type <> ''STAY_COLLECTION_TRANSFER''::text) OR ((source_order_id IS NOT NULL) AND (source_collection_fact_id IS NOT NULL))))'),
                ('collection_facts', 'collection_facts_fact_id_order_id_unique', 'u',
                  'UNIQUE (fact_id, order_id)'),
                ('stay_collection_membership_transfers', 'stay_collection_membership_transfers_pkey', 'p',
                  'PRIMARY KEY (id)'),
                ('stay_collection_membership_transfers', 'stay_collection_membership_transfers_property_id_fkey', 'f',
                  'FOREIGN KEY (property_id) REFERENCES properties(id)'),
                ('stay_collection_membership_transfers', 'stay_collection_membership_transfers_order_id_fkey', 'f',
                  'FOREIGN KEY (order_id) REFERENCES orders(id)'),
                ('stay_collection_membership_transfers', 'stay_collection_membership_trans_source_collection_fact_id_fkey', 'f',
                  'FOREIGN KEY (source_collection_fact_id) REFERENCES collection_facts(fact_id)'),
                ('stay_collection_membership_transfers', 'stay_collection_membership_transfe_source_reversal_fact_id_fkey', 'f',
                  'FOREIGN KEY (source_reversal_fact_id) REFERENCES collection_facts(fact_id)'),
                ('stay_collection_membership_transfers', 'stay_collection_membership_transfers_membership_order_id_fkey', 'f',
                  'FOREIGN KEY (membership_order_id) REFERENCES membership_orders(id)'),
                ('stay_collection_membership_transfers', 'stay_collection_membership_tran_membership_payment_fact_id_fkey', 'f',
                  'FOREIGN KEY (membership_payment_fact_id) REFERENCES membership_payment_facts(fact_id)'),
                ('stay_collection_membership_transfers', 'stay_collection_membership_transfers_command_id_fkey', 'f',
                  'FOREIGN KEY (command_id) REFERENCES command_executions(id)'),
                ('stay_collection_membership_transfers', 'stay_collection_membership_transf_source_collection_fact_id_key', 'u',
                  'UNIQUE (source_collection_fact_id)'),
                ('stay_collection_membership_transfers', 'stay_collection_membership_transfer_source_reversal_fact_id_key', 'u',
                  'UNIQUE (source_reversal_fact_id)'),
                ('stay_collection_membership_transfers', 'stay_collection_membership_trans_membership_payment_fact_id_key', 'u',
                  'UNIQUE (membership_payment_fact_id)'),
                ('stay_collection_membership_transfers', 'stay_collection_membership_tr_source_collection_fact_id_or_fkey', 'f',
                  'FOREIGN KEY (source_collection_fact_id, order_id) REFERENCES collection_facts(fact_id, order_id)'),
                ('entitlement_ledger', 'entitlement_ledger_entry_type_check', 'c',
                  'CHECK ((entry_type = ANY (ARRAY[''ADJUST''::text, ''HOLD''::text, ''RELEASE''::text, ''CONSUME''::text, ''RESTORE''::text, ''EXPIRE''::text, ''CONVERSION_CONSUME''::text, ''VOID''::text])))')
            ) AS expected(table_name, constraint_name, constraint_type, definition)
            WHERE NOT EXISTS (
              SELECT 1
              FROM pg_constraint AS constraint_row
              WHERE constraint_row.conrelid = to_regclass(expected.table_name)
                AND constraint_row.conname = expected.constraint_name
                AND constraint_row.contype::text = expected.constraint_type
                AND constraint_row.convalidated
                AND regexp_replace(
                  btrim(pg_get_constraintdef(constraint_row.oid, false)),
                  '[[:space:]]+',
                  ' ',
                  'g'
                ) = expected.definition
            )
          )
        ) AS critical_constraints_ready,
        (
          SELECT count(*)::text
          FROM pg_index AS index
          JOIN pg_class AS index_relation ON index_relation.oid = index.indexrelid
          WHERE index.indisvalid
            AND index.indisready
            AND (
              (index.indrelid = to_regclass('membership_payment_facts')
                AND index_relation.relname = 'membership_payment_source_collection_idx'
                AND NOT index.indisunique
                AND position('(source_order_id, source_collection_fact_id)'
                  IN pg_get_indexdef(index.indexrelid)) > 0
                AND position('STAY_COLLECTION_TRANSFER'
                  IN pg_get_expr(index.indpred, index.indrelid)) > 0)
              OR (index.indrelid = to_regclass('stay_collection_membership_transfers')
                AND index_relation.relname = 'stay_collection_membership_transfers_order_idx'
                AND NOT index.indisunique
                AND position('(order_id, created_at, id)' IN pg_get_indexdef(index.indexrelid)) > 0)
              OR (index.indrelid = to_regclass('stay_collection_membership_transfers')
                AND index_relation.relname = 'stay_collection_membership_transfers_membership_order_idx'
                AND NOT index.indisunique
                AND position('(membership_order_id, created_at, id)' IN pg_get_indexdef(index.indexrelid)) > 0)
              OR (index.indrelid = to_regclass('entitlement_ledger')
                AND index.indexrelid = to_regclass('entitlement_ledger_one_conversion_consume_per_lot_order_date_idx')
                AND index.indisunique
                AND position('(lot_id, order_id, service_date)' IN pg_get_indexdef(index.indexrelid)) > 0
                AND regexp_replace(
                  pg_get_expr(index.indpred, index.indrelid),
                  '[[:space:]()]',
                  '',
                  'g'
                ) = 'entry_type=''CONVERSION_CONSUME''::text')
            )
        ) AS index_count,
        (
          COALESCE(position('stage13_conversion_funds_conserved'
            IN pg_get_functiondef(to_regprocedure('qintopia_assert_stage13_stay_conversion_command_v033(text)'))) > 0, false)::integer
          + COALESCE(position('stage13_conversion_direct_reference_new'
            IN pg_get_functiondef(to_regprocedure('qintopia_assert_stage13_stay_conversion_command_v033(text)'))) > 0, false)::integer
          + COALESCE(position('stage13_conversion_one_per_order'
            IN pg_get_functiondef(to_regprocedure('qintopia_assert_stage13_stay_conversion_command_v033(text)'))) > 0, false)::integer
          + COALESCE(position('stage13_conversion_entitlement'
            IN pg_get_functiondef(to_regprocedure('qintopia_assert_stage13_stay_conversion_command_v033(text)'))) > 0, false)::integer
          + COALESCE(position('stage13_conversion_lodging_funds_closed'
            IN pg_get_functiondef(to_regprocedure('qintopia_reject_lodging_funds_after_membership_transfer()'))) > 0, false)::integer
          + COALESCE(position('stage13_conversion_membership_funds_closed'
            IN pg_get_functiondef(to_regprocedure('qintopia_reject_membership_funds_after_stay_transfer()'))) > 0, false)::integer
          + COALESCE(position('stage13_conversion_reversal_bridge_exact'
            IN pg_get_functiondef(to_regprocedure('qintopia_require_stage13_conversion_reversal_bridge()'))) > 0, false)::integer
          + COALESCE(position('stage13_conversion_execution_state'
            IN pg_get_functiondef(to_regprocedure('qintopia_assert_stage13_stay_conversion_command(text)'))) > 0, false)::integer
          + COALESCE(position('stage13_conversion_remaining_payment_binding'
            IN pg_get_functiondef(to_regprocedure('qintopia_assert_stage13_stay_conversion_command(text)'))) > 0, false)::integer
          + COALESCE(position('qintopia_assert_stage13_stay_conversion_command_v033'
            IN pg_get_functiondef(to_regprocedure('qintopia_assert_stage13_stay_conversion_command(text)'))) > 0, false)::integer
          + COALESCE(position('target_membership_order.created_by_command_id = NEW.command_id'
            IN pg_get_functiondef(to_regprocedure('qintopia_reject_membership_funds_after_stay_transfer()'))) > 0, false)::integer
          + COALESCE(position('membership_payment_transfer_shape'
            IN pg_get_functiondef(to_regprocedure('qintopia_validate_membership_payment_fact()'))) > 0, false)::integer
          + COALESCE(position('stay_membership_transfer_payment'
            IN pg_get_functiondef(to_regprocedure('qintopia_validate_stay_collection_membership_transfer()'))) > 0, false)::integer
        )::text AS body_marker_count,
        COALESCE(position(
          'PERFORM qintopia_assert_stage13_stay_conversion_command(NEW.id);'
          IN pg_get_functiondef(to_regprocedure('qintopia_validate_stage13_stay_conversion_execution()'))
        ) > 0, false) AS execution_wrapper_body_ready,
        COALESCE(position(
          'PERFORM qintopia_assert_stage13_stay_conversion_command(NEW.command_id);'
          IN pg_get_functiondef(to_regprocedure('qintopia_validate_stage13_stay_conversion_child()'))
        ) > 0, false) AS child_wrapper_body_ready,
        (
          COALESCE(position(
            'PERFORM qintopia_assert_stage13_stay_conversion_command(NEW.created_by_command_id);'
            IN pg_get_functiondef(to_regprocedure('qintopia_validate_stage13_stay_conversion_membership_order()'))
          ) > 0, false)
          AND COALESCE(position(
            'NEW.activated_by_command_id IS DISTINCT FROM NEW.created_by_command_id'
            IN pg_get_functiondef(to_regprocedure('qintopia_validate_stage13_stay_conversion_membership_order()'))
          ) > 0, false)
          AND COALESCE(position(
            'PERFORM qintopia_assert_stage13_stay_conversion_command(NEW.activated_by_command_id);'
            IN pg_get_functiondef(to_regprocedure('qintopia_validate_stage13_stay_conversion_membership_order()'))
          ) > 0, false)
        ) AS membership_order_wrapper_body_ready,
        (
          SELECT NOT EXISTS (
            SELECT 1
            FROM (
              VALUES
                ('membership_payment_facts', 'membership_payment_transfer_bridge_required',
                  'CREATE CONSTRAINT TRIGGER membership_payment_transfer_bridge_required AFTER INSERT ON public.membership_payment_facts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.source_type = ''STAY_COLLECTION_TRANSFER''::text)) EXECUTE FUNCTION qintopia_require_transfer_membership_payment_bridge()'),
                ('command_executions', 'command_executions_stage13_validate_stay_conversion',
                  'CREATE CONSTRAINT TRIGGER command_executions_stage13_validate_stay_conversion AFTER INSERT OR UPDATE OF state ON public.command_executions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_validate_stage13_stay_conversion_execution()'),
                ('stay_collection_membership_transfers', 'transfers_stage13_validate_stay_conversion',
                  'CREATE CONSTRAINT TRIGGER transfers_stage13_validate_stay_conversion AFTER INSERT ON public.stay_collection_membership_transfers DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_validate_stage13_stay_conversion_child()'),
                ('collection_facts', 'collection_facts_stage13_validate_stay_conversion',
                  'CREATE CONSTRAINT TRIGGER collection_facts_stage13_validate_stay_conversion AFTER INSERT ON public.collection_facts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_validate_stage13_stay_conversion_child()'),
                ('membership_payment_facts', 'membership_payment_facts_stage13_validate_stay_conversion',
                  'CREATE CONSTRAINT TRIGGER membership_payment_facts_stage13_validate_stay_conversion AFTER INSERT ON public.membership_payment_facts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_validate_stage13_stay_conversion_child()'),
                ('entitlement_ledger', 'entitlement_ledger_stage13_validate_stay_conversion',
                  'CREATE CONSTRAINT TRIGGER entitlement_ledger_stage13_validate_stay_conversion AFTER INSERT ON public.entitlement_ledger DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_validate_stage13_stay_conversion_child()'),
                ('collection_facts', 'collection_facts_stage13_require_conversion_reversal_bridge',
                  'CREATE CONSTRAINT TRIGGER collection_facts_stage13_require_conversion_reversal_bridge AFTER INSERT ON public.collection_facts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.fact_type = ''REVERSAL''::text)) EXECUTE FUNCTION qintopia_require_stage13_conversion_reversal_bridge()'),
                ('amendments', 'amendments_stage13_validate_stay_conversion',
                  'CREATE CONSTRAINT TRIGGER amendments_stage13_validate_stay_conversion AFTER INSERT ON public.amendments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.command_id IS NOT NULL)) EXECUTE FUNCTION qintopia_validate_stage13_stay_conversion_child()'),
                ('membership_orders', 'membership_orders_stage13_validate_stay_conversion',
                  'CREATE CONSTRAINT TRIGGER membership_orders_stage13_validate_stay_conversion AFTER INSERT OR UPDATE OF activated_by_command_id ON public.membership_orders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_validate_stage13_stay_conversion_membership_order()'),
                ('membership_payment_facts', 'membership_payment_validate_insert',
                  'CREATE TRIGGER membership_payment_validate_insert BEFORE INSERT ON public.membership_payment_facts FOR EACH ROW EXECUTE FUNCTION qintopia_validate_membership_payment_fact()'),
                ('stay_collection_membership_transfers', 'stay_collection_membership_transfers_validate_insert',
                  'CREATE TRIGGER stay_collection_membership_transfers_validate_insert BEFORE INSERT ON public.stay_collection_membership_transfers FOR EACH ROW EXECUTE FUNCTION qintopia_validate_stay_collection_membership_transfer()'),
                ('stay_collection_membership_transfers', 'stay_collection_membership_transfers_append_only',
                  'CREATE TRIGGER stay_collection_membership_transfers_append_only BEFORE DELETE OR UPDATE ON public.stay_collection_membership_transfers FOR EACH ROW EXECUTE FUNCTION qintopia_prevent_fact_mutation()'),
                ('collection_facts', 'collection_facts_stage13_reject_after_transfer',
                  'CREATE TRIGGER collection_facts_stage13_reject_after_transfer BEFORE INSERT ON public.collection_facts FOR EACH ROW EXECUTE FUNCTION qintopia_reject_lodging_funds_after_membership_transfer()'),
                ('membership_payment_facts', 'membership_payment_stage13_reject_after_transfer',
                  'CREATE TRIGGER membership_payment_stage13_reject_after_transfer BEFORE INSERT ON public.membership_payment_facts FOR EACH ROW EXECUTE FUNCTION qintopia_reject_membership_funds_after_stay_transfer()'),
                ('entitlement_ledger', 'entitlement_ledger_validate_conversion_consume',
                  'CREATE TRIGGER entitlement_ledger_validate_conversion_consume BEFORE INSERT ON public.entitlement_ledger FOR EACH ROW EXECUTE FUNCTION qintopia_validate_conversion_consume_entitlement_fact()'),
                ('collection_facts', 'collection_facts_validate_new_write_shape',
                  'CREATE TRIGGER collection_facts_validate_new_write_shape BEFORE INSERT ON public.collection_facts FOR EACH ROW EXECUTE FUNCTION qintopia_validate_new_collection_fact_shape()')
            ) AS expected(table_name, trigger_name, definition)
            WHERE NOT EXISTS (
              SELECT 1
              FROM pg_trigger AS exact_trigger
              WHERE exact_trigger.tgrelid = to_regclass(expected.table_name)
                AND exact_trigger.tgname = expected.trigger_name
                AND NOT exact_trigger.tgisinternal
                AND exact_trigger.tgenabled IN ('O','A')
                AND exact_trigger.tgnargs = 0
                AND pg_get_triggerdef(exact_trigger.oid, false) = expected.definition
            )
          )
        ) AS trigger_bindings_ready,
        (
          -- Hash complete stored bodies: marker-only checks can be satisfied from dead branches.
          SELECT NOT EXISTS (
            SELECT 1
            FROM (
              VALUES
                ('qintopia_assert_stage13_stay_conversion_command(text)', '9f9d7311054a9c99b68999dcd799cd662996d0496573cdd783fc747ca1466459'),
                ('qintopia_assert_stage13_stay_conversion_command_v033(text)', '09f38934bca14e5b4e1f2f902b63b5db8d5aa82e409fc86f41365b81bb53ddfe'),
                ('qintopia_reject_lodging_funds_after_membership_transfer()', 'db65662dcfcffcde84fb0abc91d54a7a1b2b720b4cd42a8b34375f9499943d5e'),
                ('qintopia_reject_membership_funds_after_stay_transfer()', '94efb540ae902ad6edf664b72ec170e1ea54fc3459a5e70af01783b0e484ebb6'),
                ('qintopia_require_stage13_conversion_reversal_bridge()', '5f73c20a3019cdc3810ae4484eec1a898e700e954c20d6c6a65fe8493b8f5c2e'),
                ('qintopia_require_transfer_membership_payment_bridge()', '1993430b9a865fa9ab62a4c88dab76e30dc0defc753016726bb1e21ed4920af2'),
                ('qintopia_validate_conversion_consume_entitlement_fact()', '10918d3fca13eb15e2b05cf3c661ad8289808589f1698ef04589099194e19b52'),
                ('qintopia_validate_membership_payment_fact()', 'cce1edb6109475403047b936d164c8cb18b6577b9078c6c398c25ce0f22a41c1'),
                ('qintopia_validate_stage13_stay_conversion_child()', '4d0ef7b2821a7286c2e6bb87fa936b1e6c6fc194e759acf09afe0645d36095b0'),
                ('qintopia_validate_stage13_stay_conversion_execution()', '2b83d1f0c739a4bdc65e3114d0f6ddbcca1ac80a02ede73d687705da946d3f56'),
                ('qintopia_validate_stage13_stay_conversion_membership_order()', '1baf9a5240b34e396eed0aca2da6165adec38227ee672e63623d33a3ad1ecae2'),
                ('qintopia_validate_stay_collection_membership_transfer()', 'c9787c3223d8e3a41fe6c9111be52c6711fae94a212c5fcf4d10fd3f791f6c43'),
                ('qintopia_validate_new_collection_fact_shape()', '0922bb880a362c3fa315ef44c9cb20f8edc855263bcc03d4fb537bad3e2d8977')
            ) AS expected(signature, body_hash)
            WHERE NOT COALESCE((
              SELECT encode(
                  sha256(convert_to(procedure_row.prosrc, 'UTF8')),
                  'hex'
                ) = expected.body_hash
                AND procedure_row.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')
                AND NOT procedure_row.prosecdef
                AND procedure_row.provolatile = 'v'
                AND (
                  (expected.signature IN (
                    'qintopia_reject_lodging_funds_after_membership_transfer()',
                    'qintopia_reject_membership_funds_after_stay_transfer()',
                    'qintopia_validate_conversion_consume_entitlement_fact()',
                    'qintopia_validate_stay_collection_membership_transfer()'
                  ) AND procedure_row.proconfig = ARRAY['search_path=pg_catalog, public']::text[])
                  OR
                  (expected.signature NOT IN (
                    'qintopia_reject_lodging_funds_after_membership_transfer()',
                    'qintopia_reject_membership_funds_after_stay_transfer()',
                    'qintopia_validate_conversion_consume_entitlement_fact()',
                    'qintopia_validate_stay_collection_membership_transfer()'
                  ) AND procedure_row.proconfig IS NULL)
                )
                AND procedure_row.prokind = 'f'
              FROM pg_proc AS procedure_row
              WHERE procedure_row.oid = to_regprocedure(expected.signature)
            ), false)
          )
        ) AS function_bodies_ready
      FROM pg_trigger AS trigger
    `.execute(db);
    const historicalStayArrangementCorrectionObjects = await sql<{
      table_count: string;
      function_count: string;
      function_bodies_ready: boolean;
      runtime_privileges_ready: boolean;
      trigger_bindings_ready: boolean;
    }>`
      SELECT
        (
          SELECT count(*)::text
          FROM pg_class AS relation
          WHERE relation.oid = to_regclass('historical_stay_arrangement_corrections')
            AND relation.relkind = 'r'
        ) AS table_count,
        (
          (to_regprocedure('qintopia_validate_historical_stay_arrangement_correction_amendment()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_assert_historical_stay_arrangement_correction_command(text)') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_validate_historical_stay_arrangement_correction_execution()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_validate_historical_stay_arrangement_correction_child()') IS NOT NULL)::integer
        )::text AS function_count,
        (
          SELECT NOT EXISTS (
            SELECT 1
            FROM (
              VALUES
                ('qintopia_validate_historical_stay_arrangement_correction_amendment()',
                  '3151c105776c9dd9de7a04f027af96853d7deb6f9e38a7e6fc12075ca2b8d798'),
                ('qintopia_assert_historical_stay_arrangement_correction_command(text)',
                  'b96ed779b1b92b4866872874cc2ee46f148212d4abebda139a3e2eedc84c71b7'),
                ('qintopia_validate_historical_stay_arrangement_correction_execution()',
                  'f174a2a75479defba13a8d6222f18e742d5c73391638365171869e15858c74ab'),
                ('qintopia_validate_historical_stay_arrangement_correction_child()',
                  '10ed1071d18d4d611271fc299a2a6a32877312a3d30bc43c9da52a2cc6f070bc')
            ) AS expected(signature, body_hash)
            WHERE NOT COALESCE((
              SELECT encode(sha256(convert_to(procedure_row.prosrc, 'UTF8')), 'hex') = expected.body_hash
                AND procedure_row.proowner = database_owner.datdba
                AND procedure_row.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')
                AND NOT procedure_row.prosecdef
                AND procedure_row.provolatile = 'v'
                AND procedure_row.prokind = 'f'
                AND procedure_row.proconfig = ARRAY['search_path=pg_catalog, public']::text[]
              FROM pg_proc AS procedure_row
              CROSS JOIN (
                SELECT database_row.datdba
                FROM pg_database AS database_row
                WHERE database_row.datname = current_database()
              ) AS database_owner
              WHERE procedure_row.oid = to_regprocedure(expected.signature)
            ), false)
          )
        ) AS function_bodies_ready,
        COALESCE((
          SELECT has_table_privilege(runtime_role.oid, 'historical_stay_arrangement_corrections', 'SELECT')
            AND has_table_privilege(runtime_role.oid, 'historical_stay_arrangement_corrections', 'INSERT')
            AND NOT has_table_privilege(runtime_role.oid, 'historical_stay_arrangement_corrections', 'UPDATE')
            AND NOT has_table_privilege(runtime_role.oid, 'historical_stay_arrangement_corrections', 'DELETE')
            AND NOT has_table_privilege(runtime_role.oid, 'historical_stay_arrangement_corrections', 'TRUNCATE')
            AND NOT has_table_privilege(runtime_role.oid, 'historical_stay_arrangement_corrections', 'TRIGGER')
            AND NOT has_table_privilege(runtime_role.oid, 'historical_stay_arrangement_corrections', 'REFERENCES')
          FROM pg_roles AS runtime_role
          WHERE runtime_role.rolname = 'qintopia_runtime'
        ), false) AS runtime_privileges_ready,
        (
          SELECT NOT EXISTS (
            SELECT 1
            FROM (
              VALUES
                ('amendments', 'amendments_validate_historical_stay_arrangement_correction',
                  'CREATE TRIGGER amendments_validate_historical_stay_arrangement_correction BEFORE INSERT ON public.amendments FOR EACH ROW EXECUTE FUNCTION qintopia_validate_historical_stay_arrangement_correction_amendm()'),
                ('amendments', 'amendments_validate_historical_stay_arrangement_correction_chai',
                  'CREATE CONSTRAINT TRIGGER amendments_validate_historical_stay_arrangement_correction_chai AFTER INSERT ON public.amendments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.command_id IS NOT NULL)) EXECUTE FUNCTION qintopia_validate_historical_stay_arrangement_correction_child()'),
                ('command_executions', 'command_executions_validate_historical_stay_arrangement_correct',
                  'CREATE CONSTRAINT TRIGGER command_executions_validate_historical_stay_arrangement_correct AFTER INSERT OR UPDATE OF state ON public.command_executions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_validate_historical_stay_arrangement_correction_execut()'),
                ('historical_stay_arrangement_corrections', 'historical_stay_arrangement_corrections_append_only',
                  'CREATE TRIGGER historical_stay_arrangement_corrections_append_only BEFORE DELETE OR UPDATE ON public.historical_stay_arrangement_corrections FOR EACH ROW EXECUTE FUNCTION qintopia_prevent_fact_mutation()'),
                ('historical_stay_arrangement_corrections', 'historical_stay_arrangement_corrections_validate_chain',
                  'CREATE CONSTRAINT TRIGGER historical_stay_arrangement_corrections_validate_chain AFTER INSERT ON public.historical_stay_arrangement_corrections DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_validate_historical_stay_arrangement_correction_child()'),
                ('pricing_revisions', 'pricing_revisions_validate_historical_stay_arrangement_correcti',
                  'CREATE CONSTRAINT TRIGGER pricing_revisions_validate_historical_stay_arrangement_correcti AFTER INSERT ON public.pricing_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_validate_historical_stay_arrangement_correction_child()'),
                ('stay_segments', 'stay_segments_validate_historical_stay_arrangement_correction_c',
                  'CREATE CONSTRAINT TRIGGER stay_segments_validate_historical_stay_arrangement_correction_c AFTER INSERT ON public.stay_segments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_validate_historical_stay_arrangement_correction_child()')
            ) AS expected(table_name, trigger_name, definition)
            WHERE NOT EXISTS (
              SELECT 1
              FROM pg_trigger AS exact_trigger
              WHERE exact_trigger.tgrelid = to_regclass(expected.table_name)
                AND exact_trigger.tgname = expected.trigger_name
                AND NOT exact_trigger.tgisinternal
                AND exact_trigger.tgenabled IN ('O','A')
                AND exact_trigger.tgnargs = 0
                AND pg_get_triggerdef(exact_trigger.oid, false) = expected.definition
            )
          )
        ) AS trigger_bindings_ready
    `.execute(db);
    const adminMembershipCorrectionObjects = await sql<{
      table_count: string;
      index_bindings_ready: boolean;
      function_bodies_ready: boolean;
      security_function_privileges_ready: boolean;
      runtime_table_privileges_ready: boolean;
      trigger_bindings_ready: boolean;
    }>`
      WITH
      expected_table_shapes(table_name, expected_columns, expected_constraint_count) AS (
        VALUES
          ('admin_membership_payment_evidence_claims',
            ARRAY[
              'normalized_reference',
              'membership_payment_fact_id',
              'command_id',
              'correction_type',
              'created_at'
            ]::text[],
            7),
          ('member_profile_corrections',
            ARRAY[
              'id',
              'property_id',
              'member_id',
              'sequence',
              'prior_full_name',
              'prior_nickname',
              'prior_identity_card_number',
              'prior_phone',
              'prior_wechat',
              'corrected_full_name',
              'corrected_nickname',
              'corrected_identity_card_number',
              'corrected_phone',
              'corrected_wechat',
              'changed_fields',
              'evidence_note',
              'command_id',
              'created_at'
            ]::text[],
            11),
          ('membership_effective_date_corrections',
            ARRAY[
              'id',
              'property_id',
              'member_id',
              'membership_order_id',
              'contract_id',
              'entitlement_lot_id',
              'sequence',
              'prior_valid_from',
              'prior_valid_until',
              'corrected_valid_from',
              'corrected_valid_until',
              'prior_order_version',
              'prior_contract_version',
              'prior_lot_version',
              'evidence_note',
              'command_id',
              'created_at'
            ]::text[],
            16),
          ('historical_membership_backfills',
            ARRAY[
              'id',
              'property_id',
              'member_id',
              'membership_order_id',
              'contract_id',
              'entitlement_lot_id',
              'payment_fact_id',
              'product_id',
              'product_code',
              'product_version',
              'product_name',
              'listed_price_minor',
              'agreed_price_minor',
              'currency',
              'entitlement_unit_kind',
              'entitlement_units',
              'validity_period',
              'allowed_room_type_code',
              'allowed_inventory_kind',
              'actual_membership_date',
              'valid_until',
              'business_date',
              'transaction_reference',
              'evidence_note',
              'command_id',
              'created_at'
            ]::text[],
            25),
          ('membership_payment_reclassifications',
            ARRAY[
              'id',
              'property_id',
              'member_id',
              'old_membership_order_id',
              'old_payment_fact_id',
              'old_reversal_fact_id',
              'new_membership_order_id',
              'new_payment_fact_id',
              'amount_minor',
              'currency',
              'evidence_note',
              'command_id',
              'created_at'
            ]::text[],
            15),
          ('membership_void_reconversions',
            ARRAY[
              'id',
              'property_id',
              'member_id',
              'old_membership_order_id',
              'old_contract_id',
              'old_entitlement_lot_id',
              'prior_old_order_version',
              'prior_old_contract_version',
              'prior_old_lot_version',
              'source_order_id',
              'source_stay_id',
              'prior_source_order_version',
              'new_membership_order_id',
              'new_contract_id',
              'new_entitlement_lot_id',
              'replacement_payment_fact_id',
              'replacement_business_date',
              'replacement_transaction_reference',
              'actual_membership_date',
              'valid_until',
              'old_direct_collection_total_minor',
              'stay_transfer_total_minor',
              'membership_agreed_price_minor',
              'service_dates',
              'evidence_note',
              'command_id',
              'created_at'
            ]::text[],
            36)
      ),
      expected_critical_constraints(table_name, constraint_name, constraint_type, definition) AS (
        VALUES
          ('admin_membership_payment_evidence_claims', 'admin_membership_payment_evidence_claims_pkey', 'p',
            'PRIMARY KEY (normalized_reference)'),
          ('admin_membership_payment_evidence_claims', 'admin_membership_payment_evidenc_membership_payment_fact_id_key', 'u',
            'UNIQUE (membership_payment_fact_id)'),
          ('admin_membership_payment_evidence_claims', 'admin_membership_payment_evidence_claims_command_id_key', 'u',
            'UNIQUE (command_id)'),
          ('admin_membership_payment_evidence_claims', 'admin_membership_payment_evidence_claims_correction_type_check', 'c',
            'CHECK ((correction_type = ANY (ARRAY[''BACKFILL_HISTORICAL_MEMBERSHIP''::text, ''VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY''::text])))'),
          ('admin_membership_payment_evidence_claims', 'admin_membership_payment_evidence_claims_reference_trimmed', 'c',
            'CHECK (((NULLIF(regexp_replace(btrim(normalized_reference), ''^[[:space:]]+|[[:space:]]+$''::text, ''''::text, ''g''::text), ''''::text) IS NOT NULL) AND (normalized_reference = regexp_replace(btrim(normalized_reference), ''^[[:space:]]+|[[:space:]]+$''::text, ''''::text, ''g''::text))))'),
          ('member_profile_corrections', 'member_profile_corrections_changed_fields_check', 'c',
            'CHECK (((cardinality(changed_fields) >= 1) AND (cardinality(changed_fields) <= 5)))'),
          ('member_profile_corrections', 'member_profile_corrections_changed_fields_check1', 'c',
            'CHECK ((changed_fields <@ ARRAY[''fullName''::text, ''nickname''::text, ''identityCardNumber''::text, ''phone''::text, ''wechat''::text]))'),
          ('member_profile_corrections', 'member_profile_corrections_evidence_note_check', 'c',
            'CHECK ((NULLIF(btrim(evidence_note), ''''::text) IS NOT NULL))'),
          ('member_profile_corrections', 'member_profile_corrections_member_id_sequence_key', 'u',
            'UNIQUE (member_id, sequence)'),
          ('membership_effective_date_corrections', 'membership_effective_date_corr_membership_order_id_sequence_key', 'u',
            'UNIQUE (membership_order_id, sequence)'),
          ('membership_effective_date_corrections', 'membership_effective_date_corrections_check', 'c',
            'CHECK ((corrected_valid_until >= corrected_valid_from))'),
          ('membership_effective_date_corrections', 'membership_effective_date_corrections_check1', 'c',
            'CHECK (((prior_valid_from IS DISTINCT FROM corrected_valid_from) OR (prior_valid_until IS DISTINCT FROM corrected_valid_until)))'),
          ('historical_membership_backfills', 'historical_membership_backfills_membership_order_id_key', 'u',
            'UNIQUE (membership_order_id)'),
          ('historical_membership_backfills', 'historical_membership_backfills_contract_id_key', 'u',
            'UNIQUE (contract_id)'),
          ('historical_membership_backfills', 'historical_membership_backfills_entitlement_lot_id_key', 'u',
            'UNIQUE (entitlement_lot_id)'),
          ('historical_membership_backfills', 'historical_membership_backfills_payment_fact_id_key', 'u',
            'UNIQUE (payment_fact_id)'),
          ('historical_membership_backfills', 'historical_membership_backfills_transaction_reference_check', 'c',
            'CHECK (((NULLIF(regexp_replace(btrim(transaction_reference), ''^[[:space:]]+|[[:space:]]+$''::text, ''''::text, ''g''::text), ''''::text) IS NOT NULL) AND (transaction_reference = regexp_replace(btrim(transaction_reference), ''^[[:space:]]+|[[:space:]]+$''::text, ''''::text, ''g''::text))))'),
          ('historical_membership_backfills', 'historical_membership_backfills_validity_period_check', 'c',
            'CHECK ((validity_period = ''P1Y''::text))'),
          ('membership_payment_reclassifications', 'membership_payment_reclassifications_old_payment_fact_id_key', 'u',
            'UNIQUE (old_payment_fact_id)'),
          ('membership_payment_reclassifications', 'membership_payment_reclassifications_old_reversal_fact_id_key', 'u',
            'UNIQUE (old_reversal_fact_id)'),
          ('membership_payment_reclassifications', 'membership_payment_reclassifications_void_command_fk', 'f',
            'FOREIGN KEY (command_id) REFERENCES membership_void_reconversions(command_id) DEFERRABLE INITIALLY DEFERRED'),
          ('membership_void_reconversions', 'membership_void_reconversions_old_membership_order_id_key', 'u',
            'UNIQUE (old_membership_order_id)'),
          ('membership_void_reconversions', 'membership_void_reconversions_source_order_id_key', 'u',
            'UNIQUE (source_order_id)'),
          ('membership_void_reconversions', 'membership_void_reconversions_source_stay_id_key', 'u',
            'UNIQUE (source_stay_id)'),
          ('membership_void_reconversions', 'membership_void_reconversions_check1', 'c',
            'CHECK ((stay_transfer_total_minor <= membership_agreed_price_minor))'),
          ('membership_void_reconversions', 'membership_void_reconversions_check2', 'c',
            'CHECK ((((replacement_payment_fact_id IS NULL) AND (replacement_business_date IS NULL) AND (replacement_transaction_reference IS NULL)) OR ((replacement_payment_fact_id IS NOT NULL) AND (replacement_business_date IS NOT NULL) AND (replacement_transaction_reference IS NOT NULL))))'),
          ('membership_void_reconversions', 'membership_void_reconversions_service_dates_check', 'c',
            'CHECK ((cardinality(service_dates) > 0))')
      ),
      expected_indexes(table_name, index_name, is_unique, definition) AS (
        VALUES
          ('audit_entries', 'audit_entries_allowed_preview_id_unique_idx', true,
            'CREATE UNIQUE INDEX audit_entries_allowed_preview_id_unique_idx ON public.audit_entries USING btree (((metadata ->> ''previewId''::text))) WHERE ((decision = ''ALLOWED''::text) AND (NULLIF(btrim((metadata ->> ''previewId''::text)), ''''::text) IS NOT NULL))'),
          ('collection_facts', 'collection_facts_transaction_reference_lookup_idx', false,
            'CREATE INDEX collection_facts_transaction_reference_lookup_idx ON public.collection_facts USING btree (regexp_replace(btrim(transaction_reference), ''^[[:space:]]+|[[:space:]]+$''::text, ''''::text, ''g''::text)) WHERE (transaction_reference IS NOT NULL)'),
          ('membership_payment_facts', 'membership_payment_facts_transaction_reference_lookup_idx', false,
            'CREATE INDEX membership_payment_facts_transaction_reference_lookup_idx ON public.membership_payment_facts USING btree (regexp_replace(btrim(transaction_reference), ''^[[:space:]]+|[[:space:]]+$''::text, ''''::text, ''g''::text)) WHERE (transaction_reference IS NOT NULL)'),
          ('member_profile_corrections', 'member_profile_corrections_member_idx', false,
            'CREATE INDEX member_profile_corrections_member_idx ON public.member_profile_corrections USING btree (member_id, sequence)'),
          ('membership_effective_date_corrections', 'membership_effective_date_corrections_member_idx', false,
            'CREATE INDEX membership_effective_date_corrections_member_idx ON public.membership_effective_date_corrections USING btree (member_id, created_at, id)'),
          ('historical_membership_backfills', 'historical_membership_backfills_member_idx', false,
            'CREATE INDEX historical_membership_backfills_member_idx ON public.historical_membership_backfills USING btree (member_id, created_at, id)'),
          ('membership_payment_reclassifications', 'membership_payment_reclassifications_member_idx', false,
            'CREATE INDEX membership_payment_reclassifications_member_idx ON public.membership_payment_reclassifications USING btree (member_id, created_at, id)'),
          ('membership_void_reconversions', 'membership_void_reconversions_member_idx', false,
            'CREATE INDEX membership_void_reconversions_member_idx ON public.membership_void_reconversions USING btree (member_id, created_at, id)')
      ),
      expected_functions(signature, body_hash, language_name, volatility, security_definer) AS (
        VALUES
          ('qintopia_guard_admin_membership_payment_evidence()', 'c599e3983a8e85dfcfe5341c07e9e3472811c6c3cf6c9b2e882c6ba558cab652', 'plpgsql', 'v', true),
          ('qintopia_claim_admin_membership_payment_evidence()', '69f642bfd116c617121b38036489c43b367db117953ddabb9a6d4eb7422d6b35', 'plpgsql', 'v', true),
          ('qintopia_validate_admin_membership_payment_evidence_scope()', '948c8577619342599b5f87c6687ebbfa5ccefa01e568ad70852ad646f85ff712', 'plpgsql', 'v', true),
          ('qintopia_lock_historical_membership_backfill()', '6d2ed33d96583e0cd404932166f6de4085f81aaa41dd899b05151886777ea4fb', 'plpgsql', 'v', false),
          ('qintopia_lock_membership_void_reconversion()', 'ec597339f2565e36d3ba4821edbbf2c013cd8a494fee9b304fc9a6bf6362c11c', 'plpgsql', 'v', false),
          ('qintopia_has_historical_command_fact_evidence(text,text,text,text,text)', 'd7fde4c9df35af9e9a3bf1d87e2eb70db2e79c0e8cc3ad773bca088d22e5712e', 'sql', 's', false),
          ('qintopia_has_exact_source_amendment_set(text,text,text)', '7bc120ec02f86adc183062354e7c6fd9d93bcd25fef482738b328a5a50c282a8', 'sql', 's', false),
          ('qintopia_validate_member_profile_correction()', '51908a84980ff376295b9c283cfc2a55a34ce35716639551b7bed882d9b64fca', 'plpgsql', 'v', false),
          ('qintopia_validate_membership_effective_date_correction()', '2a934ecfb22c081fbf886b07f624858e20ccde7a291c80ab982a5596bf829c63', 'plpgsql', 'v', false),
          ('qintopia_validate_historical_membership_backfill()', '723b39cd35d1f92ee5e88d82548f0df7c3fccafd6db2ac9f68ee4ae8c9ba4285', 'plpgsql', 'v', false),
          ('qintopia_validate_membership_void_entitlement_fact()', 'a60cae95369c47eaf90f24937d927913a73f6207b318de0977d65460f20ad300', 'plpgsql', 'v', false),
          ('qintopia_validate_membership_void_reconversion()', '028e6a3435a8c1b049f17b8f5235b663a87aaba0fba515277ea1586a0e07011e', 'plpgsql', 'v', false),
          ('qintopia_assert_admin_membership_correction_child(text)', 'd6600cf5ff86052d542c0e1ed6a8b34e2bc10c0c7a4a4d76035873a7b8a72d76', 'plpgsql', 'v', false),
          ('qintopia_validate_admin_membership_direct_child()', 'fc83255e1e4977f18acd21a3bb3484e90abd55612ec167fcef1baccc50d85307', 'plpgsql', 'v', false),
          ('qintopia_validate_admin_membership_order_child()', 'c61c4258b25c87cd1b6646b55340d88c6c0faf540d71711e214b46e979a3ef16', 'plpgsql', 'v', false),
          ('qintopia_validate_admin_membership_contract_child()', 'a20ac82a98c3987ce86ddd304dde389ab41d0bc91674ccea3a7dbb8c601742ed', 'plpgsql', 'v', false),
          ('qintopia_validate_admin_membership_lot_child()', '8ba79ebd971c03661399357ddfa15808fd8ad33305292aa2b015f29a75f68003', 'plpgsql', 'v', false),
          ('qintopia_validate_admin_membership_revision_child()', '58a217a4eb30feffb736fead84256e37de4d210b39348b6390f46abf49dd26d7', 'plpgsql', 'v', false),
          ('qintopia_require_admin_membership_correction_fact()', 'c7484c911d850ac81555ad14c1d242f9ac623a940b895923a2a3bc1dbf92aac8', 'plpgsql', 'v', false),
          ('qintopia_protect_member_identity()', 'a2ea59a8607705290117afd133d0fe02dcb871235b692ec0ae7c007af8f0e042', 'plpgsql', 'v', false),
          ('qintopia_protect_order_identity()', '4d4499b14cc8c2aa14f4c8e85b18ddcb8b22e90ad7bae6a001b2f97d658cc0e9', 'plpgsql', 'v', false)
      ),
      expected_runtime_table_privileges(table_name, can_select, can_insert) AS (
        VALUES
          ('admin_membership_payment_evidence_claims', false, false),
          ('member_profile_corrections', true, true),
          ('membership_effective_date_corrections', true, true),
          ('historical_membership_backfills', true, true),
          ('membership_payment_reclassifications', true, true),
          ('membership_void_reconversions', true, true)
      ),
      expected_triggers(table_name, trigger_name, definition) AS (
        VALUES
          ('admin_membership_payment_evidence_claims', 'admin_membership_payment_evidence_claims_append_only',
            'CREATE TRIGGER admin_membership_payment_evidence_claims_append_only BEFORE DELETE OR UPDATE ON public.admin_membership_payment_evidence_claims FOR EACH ROW EXECUTE FUNCTION qintopia_prevent_fact_mutation()'),
          ('member_property_links', 'member_property_links_validate_profile_correction_scope',
            'CREATE CONSTRAINT TRIGGER member_property_links_validate_profile_correction_scope AFTER INSERT ON public.member_property_links DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_validate_member_profile_correction()'),
          ('member_profile_corrections', 'member_profile_corrections_append_only',
            'CREATE TRIGGER member_profile_corrections_append_only BEFORE DELETE OR UPDATE ON public.member_profile_corrections FOR EACH ROW EXECUTE FUNCTION qintopia_prevent_fact_mutation()'),
          ('member_profile_corrections', 'member_profile_corrections_validate_graph',
            'CREATE CONSTRAINT TRIGGER member_profile_corrections_validate_graph AFTER INSERT ON public.member_profile_corrections DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_validate_member_profile_correction()'),
          ('member_profile_corrections', 'member_profile_corrections_validate_payment_evidence_scope',
            'CREATE CONSTRAINT TRIGGER member_profile_corrections_validate_payment_evidence_scope AFTER INSERT ON public.member_profile_corrections DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_validate_admin_membership_payment_evidence_scope()'),
          ('membership_effective_date_corrections', 'membership_effective_date_corrections_append_only',
            'CREATE TRIGGER membership_effective_date_corrections_append_only BEFORE DELETE OR UPDATE ON public.membership_effective_date_corrections FOR EACH ROW EXECUTE FUNCTION qintopia_prevent_fact_mutation()'),
          ('membership_effective_date_corrections', 'membership_effective_date_corrections_validate_graph',
            'CREATE CONSTRAINT TRIGGER membership_effective_date_corrections_validate_graph AFTER INSERT ON public.membership_effective_date_corrections DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_validate_membership_effective_date_correction()'),
          ('membership_effective_date_corrections', 'membership_effective_date_validate_payment_evidence_scope',
            'CREATE CONSTRAINT TRIGGER membership_effective_date_validate_payment_evidence_scope AFTER INSERT ON public.membership_effective_date_corrections DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_validate_admin_membership_payment_evidence_scope()'),
          ('historical_membership_backfills', 'historical_membership_backfills_append_only',
            'CREATE TRIGGER historical_membership_backfills_append_only BEFORE DELETE OR UPDATE ON public.historical_membership_backfills FOR EACH ROW EXECUTE FUNCTION qintopia_prevent_fact_mutation()'),
          ('historical_membership_backfills', 'historical_membership_backfills_serialize',
            'CREATE TRIGGER historical_membership_backfills_serialize BEFORE INSERT ON public.historical_membership_backfills FOR EACH ROW EXECUTE FUNCTION qintopia_lock_historical_membership_backfill()'),
          ('historical_membership_backfills', 'historical_membership_backfills_claim_payment_evidence',
            'CREATE TRIGGER historical_membership_backfills_claim_payment_evidence AFTER INSERT ON public.historical_membership_backfills FOR EACH ROW EXECUTE FUNCTION qintopia_claim_admin_membership_payment_evidence()'),
          ('historical_membership_backfills', 'historical_membership_backfills_validate_graph',
            'CREATE CONSTRAINT TRIGGER historical_membership_backfills_validate_graph AFTER INSERT ON public.historical_membership_backfills DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_validate_historical_membership_backfill()'),
          ('historical_membership_backfills', 'historical_membership_backfills_validate_payment_evidence_scope',
            'CREATE CONSTRAINT TRIGGER historical_membership_backfills_validate_payment_evidence_scope AFTER INSERT ON public.historical_membership_backfills DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_validate_admin_membership_payment_evidence_scope()'),
          ('membership_payment_reclassifications', 'membership_payment_reclassifications_append_only',
            'CREATE TRIGGER membership_payment_reclassifications_append_only BEFORE DELETE OR UPDATE ON public.membership_payment_reclassifications FOR EACH ROW EXECUTE FUNCTION qintopia_prevent_fact_mutation()'),
          ('membership_payment_reclassifications', 'membership_payment_reclassifications_validate_admin_child',
            'CREATE CONSTRAINT TRIGGER membership_payment_reclassifications_validate_admin_child AFTER INSERT ON public.membership_payment_reclassifications DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_validate_admin_membership_direct_child()'),
          ('membership_void_reconversions', 'membership_void_reconversions_append_only',
            'CREATE TRIGGER membership_void_reconversions_append_only BEFORE DELETE OR UPDATE ON public.membership_void_reconversions FOR EACH ROW EXECUTE FUNCTION qintopia_prevent_fact_mutation()'),
          ('membership_void_reconversions', 'membership_void_reconversions_serialize',
            'CREATE TRIGGER membership_void_reconversions_serialize BEFORE INSERT ON public.membership_void_reconversions FOR EACH ROW EXECUTE FUNCTION qintopia_lock_membership_void_reconversion()'),
          ('membership_void_reconversions', 'membership_void_reconversions_claim_payment_evidence',
            'CREATE TRIGGER membership_void_reconversions_claim_payment_evidence AFTER INSERT ON public.membership_void_reconversions FOR EACH ROW EXECUTE FUNCTION qintopia_claim_admin_membership_payment_evidence()'),
          ('membership_void_reconversions', 'membership_void_reconversions_validate_graph',
            'CREATE CONSTRAINT TRIGGER membership_void_reconversions_validate_graph AFTER INSERT ON public.membership_void_reconversions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_validate_membership_void_reconversion()'),
          ('membership_void_reconversions', 'membership_void_reconversions_validate_payment_evidence_scope',
            'CREATE CONSTRAINT TRIGGER membership_void_reconversions_validate_payment_evidence_scope AFTER INSERT ON public.membership_void_reconversions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_validate_admin_membership_payment_evidence_scope()'),
          ('collection_facts', 'collection_facts_guard_admin_membership_payment_evidence',
            'CREATE TRIGGER collection_facts_guard_admin_membership_payment_evidence BEFORE INSERT ON public.collection_facts FOR EACH ROW EXECUTE FUNCTION qintopia_guard_admin_membership_payment_evidence()'),
          ('membership_payment_facts', 'membership_payment_facts_guard_admin_membership_payment_evidenc',
            'CREATE TRIGGER membership_payment_facts_guard_admin_membership_payment_evidenc BEFORE INSERT ON public.membership_payment_facts FOR EACH ROW EXECUTE FUNCTION qintopia_guard_admin_membership_payment_evidence()'),
          ('entitlement_ledger', 'entitlement_ledger_validate_membership_void',
            'CREATE TRIGGER entitlement_ledger_validate_membership_void BEFORE INSERT ON public.entitlement_ledger FOR EACH ROW EXECUTE FUNCTION qintopia_validate_membership_void_entitlement_fact()'),
          ('collection_facts', 'collection_facts_validate_admin_child',
            'CREATE CONSTRAINT TRIGGER collection_facts_validate_admin_child AFTER INSERT ON public.collection_facts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_validate_admin_membership_direct_child()'),
          ('membership_payment_facts', 'membership_payment_facts_validate_admin_child',
            'CREATE CONSTRAINT TRIGGER membership_payment_facts_validate_admin_child AFTER INSERT ON public.membership_payment_facts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_validate_admin_membership_direct_child()'),
          ('stay_collection_membership_transfers', 'stay_collection_membership_transfers_validate_admin_child',
            'CREATE CONSTRAINT TRIGGER stay_collection_membership_transfers_validate_admin_child AFTER INSERT ON public.stay_collection_membership_transfers DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_validate_admin_membership_direct_child()'),
          ('entitlement_ledger', 'entitlement_ledger_validate_admin_child',
            'CREATE CONSTRAINT TRIGGER entitlement_ledger_validate_admin_child AFTER INSERT ON public.entitlement_ledger DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.command_id IS NOT NULL)) EXECUTE FUNCTION qintopia_validate_admin_membership_direct_child()'),
          ('amendments', 'amendments_validate_admin_membership_child',
            'CREATE CONSTRAINT TRIGGER amendments_validate_admin_membership_child AFTER INSERT ON public.amendments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.command_id IS NOT NULL)) EXECUTE FUNCTION qintopia_validate_admin_membership_direct_child()'),
          ('membership_orders', 'membership_orders_validate_admin_child',
            'CREATE CONSTRAINT TRIGGER membership_orders_validate_admin_child AFTER INSERT ON public.membership_orders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_validate_admin_membership_order_child()'),
          ('member_contracts', 'member_contracts_validate_admin_membership_child',
            'CREATE CONSTRAINT TRIGGER member_contracts_validate_admin_membership_child AFTER INSERT ON public.member_contracts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_validate_admin_membership_contract_child()'),
          ('entitlement_lots', 'entitlement_lots_validate_admin_membership_child',
            'CREATE CONSTRAINT TRIGGER entitlement_lots_validate_admin_membership_child AFTER INSERT ON public.entitlement_lots DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_validate_admin_membership_lot_child()'),
          ('pricing_revisions', 'pricing_revisions_validate_admin_membership_child',
            'CREATE CONSTRAINT TRIGGER pricing_revisions_validate_admin_membership_child AFTER INSERT ON public.pricing_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_validate_admin_membership_revision_child()'),
          ('command_executions', 'command_executions_require_admin_membership_correction_fact',
            'CREATE CONSTRAINT TRIGGER command_executions_require_admin_membership_correction_fact AFTER INSERT OR UPDATE OF state ON public.command_executions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_require_admin_membership_correction_fact()')
      )
      SELECT
        (
          SELECT count(*)::text
          FROM expected_table_shapes AS expected
          JOIN pg_class AS relation
            ON relation.oid = to_regclass(expected.table_name)
            AND relation.relkind = 'r'
        ) AS table_count,
        (
          SELECT NOT EXISTS (
            SELECT 1
            FROM expected_indexes AS expected
            WHERE NOT EXISTS (
              SELECT 1
              FROM pg_index AS index_row
              JOIN pg_class AS index_relation ON index_relation.oid = index_row.indexrelid
              WHERE index_row.indrelid = to_regclass(expected.table_name)
                AND index_relation.relname = expected.index_name
                AND index_row.indisvalid
                AND index_row.indisready
                AND index_row.indisunique = expected.is_unique
                AND pg_get_indexdef(index_row.indexrelid, 0, false) = expected.definition
            )
          )
        ) AS index_bindings_ready,
        (
          SELECT NOT EXISTS (
            SELECT 1
            FROM expected_functions AS expected
            WHERE NOT COALESCE((
              SELECT encode(sha256(convert_to(procedure_row.prosrc, 'UTF8')), 'hex') = expected.body_hash
                AND procedure_row.proowner = database_owner.datdba
                AND procedure_row.prolang = (
                  SELECT oid FROM pg_language WHERE lanname = expected.language_name
                )
                AND procedure_row.prosecdef = expected.security_definer
                AND procedure_row.provolatile::text = expected.volatility
                AND procedure_row.prokind = 'f'
                AND procedure_row.proconfig = ARRAY['search_path=pg_catalog, public']::text[]
              FROM pg_proc AS procedure_row
              CROSS JOIN (
                SELECT database_row.datdba
                FROM pg_database AS database_row
                WHERE database_row.datname = current_database()
              ) AS database_owner
              WHERE procedure_row.oid = to_regprocedure(expected.signature)
            ), false)
          )
        ) AS function_bodies_ready,
        COALESCE((
          SELECT NOT has_function_privilege(runtime_role.oid, 'qintopia_guard_admin_membership_payment_evidence()'::regprocedure, 'EXECUTE')
            AND NOT has_function_privilege(runtime_role.oid, 'qintopia_claim_admin_membership_payment_evidence()'::regprocedure, 'EXECUTE')
            AND NOT has_function_privilege(runtime_role.oid, 'qintopia_validate_admin_membership_payment_evidence_scope()'::regprocedure, 'EXECUTE')
            AND has_function_privilege(runtime_role.oid, 'qintopia_assert_admin_membership_correction_child(text)'::regprocedure, 'EXECUTE')
            AND has_function_privilege(runtime_role.oid, 'qintopia_has_historical_command_fact_evidence(text,text,text,text,text)'::regprocedure, 'EXECUTE')
            AND has_function_privilege(runtime_role.oid, 'qintopia_has_exact_source_amendment_set(text,text,text)'::regprocedure, 'EXECUTE')
            AND NOT has_function_privilege('public', 'qintopia_guard_admin_membership_payment_evidence()'::regprocedure, 'EXECUTE')
            AND NOT has_function_privilege('public', 'qintopia_claim_admin_membership_payment_evidence()'::regprocedure, 'EXECUTE')
            AND NOT has_function_privilege('public', 'qintopia_validate_admin_membership_payment_evidence_scope()'::regprocedure, 'EXECUTE')
            AND NOT has_function_privilege('public', 'qintopia_assert_admin_membership_correction_child(text)'::regprocedure, 'EXECUTE')
            AND NOT has_function_privilege('public', 'qintopia_has_historical_command_fact_evidence(text,text,text,text,text)'::regprocedure, 'EXECUTE')
            AND NOT has_function_privilege('public', 'qintopia_has_exact_source_amendment_set(text,text,text)'::regprocedure, 'EXECUTE')
          FROM pg_roles AS runtime_role
          WHERE runtime_role.rolname = 'qintopia_runtime'
        ), false) AS security_function_privileges_ready,
        (
          SELECT NOT EXISTS (
            SELECT 1
            FROM expected_runtime_table_privileges AS expected
            WHERE NOT COALESCE((
              SELECT has_table_privilege(runtime_role.oid, relation.oid, 'SELECT') = expected.can_select
                AND has_table_privilege(runtime_role.oid, relation.oid, 'INSERT') = expected.can_insert
                AND NOT has_table_privilege(runtime_role.oid, relation.oid, 'UPDATE')
                AND NOT has_table_privilege(runtime_role.oid, relation.oid, 'DELETE')
                AND NOT has_table_privilege(runtime_role.oid, relation.oid, 'TRUNCATE')
                AND NOT has_table_privilege(runtime_role.oid, relation.oid, 'TRIGGER')
                AND NOT has_table_privilege(runtime_role.oid, relation.oid, 'REFERENCES')
              FROM pg_roles AS runtime_role
              JOIN pg_class AS relation ON relation.oid = to_regclass(expected.table_name)
              WHERE runtime_role.rolname = 'qintopia_runtime'
            ), false)
          )
        ) AS runtime_table_privileges_ready,
        (
          SELECT NOT EXISTS (
            SELECT 1
            FROM expected_triggers AS expected
            WHERE NOT EXISTS (
              SELECT 1
              FROM pg_trigger AS exact_trigger
              WHERE exact_trigger.tgrelid = to_regclass(expected.table_name)
                AND exact_trigger.tgname = expected.trigger_name
                AND NOT exact_trigger.tgisinternal
                AND exact_trigger.tgenabled IN ('O','A')
                AND exact_trigger.tgnargs = 0
                AND pg_get_triggerdef(exact_trigger.oid, false) = expected.definition
            )
          )
        ) AS trigger_bindings_ready
    `.execute(db);
    const step9CatalogIntegrity = await sql<{
      new_table_catalog_ready: boolean;
      altered_columns_ready: boolean;
      altered_constraints_ready: boolean;
    }>`
      WITH
      database_owner AS (
        SELECT database_row.datdba
        FROM pg_database AS database_row
        WHERE database_row.datname = current_database()
      ),
      -- Each digest covers the ordered relation, column, constraint, index, and trigger catalog.
      -- now() and transaction_timestamp() are canonicalized because both use transaction-start time.
      expected_new_table_catalog(table_name, catalog_hash) AS (
        VALUES
          ('historical_stay_arrangement_corrections', '93a1126288413ed253a07c173368206c92ca49d37dbb437c14d1a0fbba218da7'),
          ('admin_membership_payment_evidence_claims', '0674f8d9d3c380e5ddf15012c8d093628e38e86b1f107060b2a132f73133f4a5'),
          ('member_profile_corrections', 'b0ef6f22805398e05e7ad02b7fbbcd2b7acfb03181e481c3d3deb044f7aa52f8'),
          ('membership_effective_date_corrections', '53266d3722b9d963823ae45ce920c1eb8220c5a2d7dfa1812f8ee245b39f5dbb'),
          ('historical_membership_backfills', '59b33fa3d9a627bc0447d2ad9ec28dd18898bfa00471c46fdfe1ff8f1bed9997'),
          ('membership_payment_reclassifications', '7e39a365047f705c961d4296f6f4b9ba5e99817592f16f168dd9150ad775febb'),
          ('membership_void_reconversions', '0cf03ec66fad96a3ed4a7a1f3a6f42ee40ac056feded30455932766a7268a0e3')
      ),
      actual_new_table_catalog AS (
        SELECT expected.table_name,
          expected.catalog_hash,
          encode(sha256(convert_to(jsonb_build_object(
            'relation', jsonb_build_array(
              relation_namespace.nspname,
              relation.relkind,
              relation.relpersistence,
              relation.relrowsecurity,
              relation.relforcerowsecurity,
              relation.relowner = database_owner.datdba
            ),
            'columns', COALESCE((
              SELECT jsonb_agg(jsonb_build_array(
                attribute.attnum,
                attribute.attname,
                type_namespace.nspname,
                type_row.typname,
                format_type(attribute.atttypid, attribute.atttypmod),
                attribute.attnotnull,
                CASE
                  WHEN pg_get_expr(default_value.adbin, default_value.adrelid)
                    IN ('now()', 'transaction_timestamp()')
                    THEN '<transaction_timestamp>'
                  ELSE COALESCE(
                    pg_get_expr(default_value.adbin, default_value.adrelid),
                    '<none>'
                  )
                END,
                attribute.attidentity,
                attribute.attgenerated
              ) ORDER BY attribute.attnum)
              FROM pg_attribute AS attribute
              JOIN pg_type AS type_row ON type_row.oid = attribute.atttypid
              JOIN pg_namespace AS type_namespace ON type_namespace.oid = type_row.typnamespace
              LEFT JOIN pg_attrdef AS default_value
                ON default_value.adrelid = attribute.attrelid
                AND default_value.adnum = attribute.attnum
              WHERE attribute.attrelid = relation.oid
                AND attribute.attnum > 0
                AND NOT attribute.attisdropped
            ), '[]'::jsonb),
            'constraints', COALESCE((
              SELECT jsonb_agg(jsonb_build_array(
                constraint_row.conname,
                constraint_row.contype,
                constraint_row.condeferrable,
                constraint_row.condeferred,
                constraint_row.convalidated,
                pg_get_constraintdef(constraint_row.oid, false)
              ) ORDER BY constraint_row.conname)
              FROM pg_constraint AS constraint_row
              WHERE constraint_row.conrelid = relation.oid
                AND constraint_row.contype IN ('p','u','f','c')
            ), '[]'::jsonb),
            'indexes', COALESCE((
              SELECT jsonb_agg(jsonb_build_array(
                index_relation.relname,
                index_row.indisunique,
                index_row.indisprimary,
                index_row.indimmediate,
                index_row.indisvalid,
                index_row.indisready,
                index_row.indisreplident,
                index_row.indisclustered,
                pg_get_indexdef(index_row.indexrelid, 0, false)
              ) ORDER BY index_relation.relname)
              FROM pg_index AS index_row
              JOIN pg_class AS index_relation ON index_relation.oid = index_row.indexrelid
              WHERE index_row.indrelid = relation.oid
            ), '[]'::jsonb),
            'triggers', COALESCE((
              SELECT jsonb_agg(jsonb_build_array(
                trigger_row.tgname,
                trigger_row.tgenabled,
                trigger_row.tgdeferrable,
                trigger_row.tginitdeferred,
                trigger_row.tgnargs,
                trigger_row.tgtype,
                trigger_row.tgfoid::regprocedure::text,
                pg_get_triggerdef(trigger_row.oid, false)
              ) ORDER BY trigger_row.tgname)
              FROM pg_trigger AS trigger_row
              WHERE trigger_row.tgrelid = relation.oid
                AND NOT trigger_row.tgisinternal
            ), '[]'::jsonb)
          )::text, 'UTF8')), 'hex') AS actual_catalog_hash
        FROM expected_new_table_catalog AS expected
        CROSS JOIN database_owner
        LEFT JOIN pg_class AS relation
          ON relation.oid = to_regclass('public.' || quote_ident(expected.table_name))
        LEFT JOIN pg_namespace AS relation_namespace
          ON relation_namespace.oid = relation.relnamespace
      ),
      expected_altered_columns(
        table_name,
        column_name,
        type_schema,
        type_name,
        formatted_type,
        not_null,
        default_expression
      ) AS (
        VALUES
          ('entitlement_lots', 'status', 'pg_catalog', 'text', 'text', true, '''ACTIVE''::text'),
          ('membership_payment_facts', 'business_date', 'pg_catalog', 'date',
            'date', true, '<none>')
      ),
      expected_altered_constraints(table_name, constraint_name, constraint_type, definition) AS (
        VALUES
          ('command_catalog', 'command_catalog_feature_key_check', 'c',
            'CHECK (((feature_key IS NULL) OR (command_type = ANY (ARRAY[''COMPLETE_CLEANING''::text, ''CORRECT_HISTORICAL_STAY_ARRANGEMENTS''::text, ''VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY''::text]))))'),
          ('subject_command_grants', 'subject_command_grants_human_exact_check', 'c',
            'CHECK ((command_type = ANY (ARRAY[''CREATE_MEMBER''::text, ''CREATE_MEMBERSHIP_ORDER''::text, ''RECORD_MEMBERSHIP_PAYMENT''::text, ''CORRECT_MEMBERSHIP_PAYMENT''::text, ''ACTIVATE_MEMBERSHIP_ORDER''::text, ''CREATE_ORDER''::text, ''CORRECT_ORDER_OCCUPANT''::text, ''MANAGE_ROOM_CATALOG''::text, ''MANAGE_ORDER_OCCUPANTS''::text, ''CORRECT_HISTORICAL_STAY_ARRANGEMENTS''::text, ''CORRECT_MEMBER_PROFILE''::text, ''CORRECT_MEMBERSHIP_EFFECTIVE_DATE''::text, ''BACKFILL_HISTORICAL_MEMBERSHIP''::text, ''VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY''::text, ''RESCHEDULE_STAY''::text, ''EXTEND_STAY''::text, ''SHORTEN_STAY''::text, ''MOVE_UNIT''::text, ''REPRICE_ORDER''::text, ''CANCEL_ORDER''::text, ''MARK_NO_SHOW''::text, ''REVOKE_CHECK_IN''::text, ''LOCK_MAINTENANCE''::text, ''RELEASE_MAINTENANCE''::text, ''COMPLETE_CLEANING''::text, ''RECORD_COLLECTION''::text, ''RECORD_REFUND''::text, ''REVERSE_FACT''::text, ''CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP''::text, ''CHECK_IN''::text, ''CHECK_OUT''::text, ''REVOKE_CHECK_OUT''::text, ''COMPLETE_STAY''::text, ''CORRECT_MEMBER_ENTITLEMENT_BALANCE''::text, ''ISSUE_TOKEN''::text, ''ROTATE_TOKEN''::text, ''REVOKE_TOKEN''::text, ''PLACE_INTERNAL_USE''::text, ''RELEASE_INTERNAL_USE''::text, ''BACKFILL_COMPLETED_STAY''::text])))'),
          ('membership_orders', 'membership_orders_status_check', 'c',
            'CHECK ((status = ANY (ARRAY[''DRAFT''::text, ''ACTIVE''::text, ''VOIDED''::text])))'),
          ('membership_orders', 'membership_orders_lifecycle_state_check', 'c',
            'CHECK ((((status = ANY (ARRAY[''DRAFT''::text, ''VOIDED''::text])) AND (activated_at IS NULL) AND (valid_from IS NULL) AND (valid_until IS NULL) AND (contract_id IS NULL) AND (entitlement_lot_id IS NULL) AND (activated_by_command_id IS NULL)) OR ((status = ANY (ARRAY[''ACTIVE''::text, ''VOIDED''::text])) AND (activated_at IS NOT NULL) AND (valid_from IS NOT NULL) AND (valid_until IS NOT NULL) AND (contract_id IS NOT NULL) AND (entitlement_lot_id IS NOT NULL) AND (activated_by_command_id IS NOT NULL))))'),
          ('member_contracts', 'member_contracts_status_check', 'c',
            'CHECK ((status = ANY (ARRAY[''ACTIVE''::text, ''EXPIRED''::text, ''VOIDED''::text])))'),
          ('entitlement_lots', 'entitlement_lots_status_check', 'c',
            'CHECK ((status = ANY (ARRAY[''ACTIVE''::text, ''VOIDED''::text])))'),
          ('entitlement_ledger', 'entitlement_ledger_entry_type_check', 'c',
            'CHECK ((entry_type = ANY (ARRAY[''ADJUST''::text, ''HOLD''::text, ''RELEASE''::text, ''CONSUME''::text, ''RESTORE''::text, ''EXPIRE''::text, ''CONVERSION_CONSUME''::text, ''VOID''::text])))')
      )
      SELECT
        NOT EXISTS (
          SELECT 1
          FROM actual_new_table_catalog AS actual
          WHERE actual.actual_catalog_hash IS DISTINCT FROM actual.catalog_hash
        ) AS new_table_catalog_ready,
        NOT EXISTS (
          SELECT 1
          FROM expected_altered_columns AS expected
          WHERE NOT EXISTS (
            SELECT 1
            FROM pg_attribute AS attribute
            JOIN pg_type AS type_row ON type_row.oid = attribute.atttypid
            JOIN pg_namespace AS type_namespace ON type_namespace.oid = type_row.typnamespace
            LEFT JOIN pg_attrdef AS default_value
              ON default_value.adrelid = attribute.attrelid
              AND default_value.adnum = attribute.attnum
            WHERE attribute.attrelid = to_regclass('public.' || quote_ident(expected.table_name))
              AND attribute.attname = expected.column_name
              AND attribute.attnum > 0
              AND NOT attribute.attisdropped
              AND type_namespace.nspname = expected.type_schema
              AND type_row.typname = expected.type_name
              AND format_type(attribute.atttypid, attribute.atttypmod) = expected.formatted_type
              AND attribute.attnotnull = expected.not_null
              AND CASE
                WHEN pg_get_expr(default_value.adbin, default_value.adrelid)
                  IN ('now()', 'transaction_timestamp()')
                  THEN '<transaction_timestamp>'
                ELSE COALESCE(pg_get_expr(default_value.adbin, default_value.adrelid), '<none>')
              END = expected.default_expression
              AND attribute.attidentity = ''
              AND attribute.attgenerated = ''
          )
        ) AS altered_columns_ready,
        NOT EXISTS (
          SELECT 1
          FROM expected_altered_constraints AS expected
          WHERE NOT EXISTS (
            SELECT 1
            FROM pg_constraint AS constraint_row
            WHERE constraint_row.conrelid = to_regclass('public.' || quote_ident(expected.table_name))
              AND constraint_row.conname = expected.constraint_name
              AND constraint_row.contype::text = expected.constraint_type
              AND NOT constraint_row.condeferrable
              AND NOT constraint_row.condeferred
              AND constraint_row.convalidated
              AND pg_get_constraintdef(constraint_row.oid, false) = expected.definition
          )
        ) AS altered_constraints_ready
    `.execute(db);
    const inHouseMembershipFulfillmentObjects = await sql<{
      function_count: string;
      index_ready: boolean;
      coverage_trigger_count: string;
      deferred_trigger_count: string;
      trigger_bindings_ready: boolean;
      body_marker_count: string;
      function_bodies_ready: boolean;
    }>`
      SELECT
        (
          (to_regprocedure('qintopia_assert_stage10_shorten_combination(text)') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_validate_coverage_ownership()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_protect_coverage_identity()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_reject_stage10_entitlement_write()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_validate_entitlement_lifecycle_fact()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_validate_coverage_lifecycle_state()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_assert_stage11_move_combination(text)') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_preserve_stage11_consumed_coverage()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_validate_conversion_consume_entitlement_fact()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_reject_lodging_funds_after_membership_transfer()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_reject_membership_funds_after_stay_transfer()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_assert_stage13_stay_conversion_command_v033(text)') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_assert_converted_stay_fulfillment_command(text)') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_validate_converted_stay_fulfillment_execution()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_validate_converted_stay_fulfillment_child()') IS NOT NULL)::integer
        )::text AS function_count,
        EXISTS (
          SELECT 1
          FROM pg_index AS index_row
          WHERE index_row.indexrelid = to_regclass('amendments_one_membership_conversion_per_order_idx')
            AND index_row.indrelid = to_regclass('amendments')
            AND index_row.indisunique
            AND index_row.indimmediate
            AND index_row.indisvalid
            AND index_row.indisready
            AND index_row.indexprs IS NULL
            AND index_row.indnkeyatts = 1
            AND index_row.indnatts = 1
            AND position('(order_id)' IN pg_get_indexdef(index_row.indexrelid)) > 0
            AND regexp_replace(
              pg_get_expr(index_row.indpred, index_row.indrelid),
              '[[:space:]()]',
              '',
              'g'
            ) = 'amendment_type=''CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP''::text'
        ) AS index_ready,
        count(*) FILTER (
          WHERE NOT trigger.tgisinternal
            AND NOT trigger.tgdeferrable
            AND NOT trigger.tginitdeferred
            AND trigger.tgenabled IN ('O','A')
            AND trigger.tgnargs = 0
            AND trigger.tgqual IS NULL
            AND (
              (trigger.tgrelid = to_regclass('coverage_items')
                AND trigger.tgname = 'coverage_items_protect_identity'
                AND trigger.tgtype = 31
                AND trigger.tgfoid = to_regprocedure('qintopia_protect_coverage_identity()'))
              OR (trigger.tgrelid = to_regclass('coverage_items')
                AND trigger.tgname = 'coverage_items_validate_ownership'
                AND trigger.tgtype = 7
                AND trigger.tgfoid = to_regprocedure('qintopia_validate_coverage_ownership()'))
            )
        )::text AS coverage_trigger_count,
        count(*) FILTER (
          WHERE NOT trigger.tgisinternal
            AND trigger.tgdeferrable
            AND trigger.tginitdeferred
            AND trigger.tgenabled IN ('O','A')
            AND trigger.tgnargs = 0
            AND (
              (trigger.tgrelid = to_regclass('command_executions')
                AND trigger.tgname = 'command_executions_validate_converted_stay_fulfillment'
                AND trigger.tgtype = 21
                AND trigger.tgfoid = to_regprocedure('qintopia_validate_converted_stay_fulfillment_execution()'))
              OR (trigger.tgrelid = to_regclass('coverage_items')
                AND trigger.tgname = 'coverage_items_validate_lifecycle_state'
                AND trigger.tgtype = 21
                AND trigger.tgfoid = to_regprocedure('qintopia_validate_coverage_lifecycle_state()'))
              OR (trigger.tgrelid = to_regclass('amendments')
                AND trigger.tgname = 'amendments_validate_converted_stay_fulfillment'
                AND trigger.tgtype = 5
                AND trigger.tgfoid = to_regprocedure('qintopia_validate_converted_stay_fulfillment_child()'))
              OR (trigger.tgrelid = to_regclass('entitlement_ledger')
                AND trigger.tgname = 'entitlement_ledger_validate_converted_stay_fulfillment'
                AND trigger.tgtype = 5
                AND trigger.tgfoid = to_regprocedure('qintopia_validate_converted_stay_fulfillment_child()'))
            )
        )::text AS deferred_trigger_count,
        (
          SELECT NOT EXISTS (
            SELECT 1
            FROM (
              VALUES
                ('command_executions', 'command_executions_validate_converted_stay_fulfillment',
                  'CREATE CONSTRAINT TRIGGER command_executions_validate_converted_stay_fulfillment AFTER INSERT OR UPDATE OF state ON public.command_executions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_validate_converted_stay_fulfillment_execution()'),
                ('coverage_items', 'coverage_items_validate_lifecycle_state',
                  'CREATE CONSTRAINT TRIGGER coverage_items_validate_lifecycle_state AFTER INSERT OR UPDATE OF status ON public.coverage_items DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_validate_coverage_lifecycle_state()'),
                ('amendments', 'amendments_validate_converted_stay_fulfillment',
                  'CREATE CONSTRAINT TRIGGER amendments_validate_converted_stay_fulfillment AFTER INSERT ON public.amendments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.command_id IS NOT NULL)) EXECUTE FUNCTION qintopia_validate_converted_stay_fulfillment_child()'),
                ('entitlement_ledger', 'entitlement_ledger_validate_converted_stay_fulfillment',
                  'CREATE CONSTRAINT TRIGGER entitlement_ledger_validate_converted_stay_fulfillment AFTER INSERT ON public.entitlement_ledger DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.command_id IS NOT NULL)) EXECUTE FUNCTION qintopia_validate_converted_stay_fulfillment_child()')
            ) AS expected(table_name, trigger_name, definition)
            WHERE NOT EXISTS (
              SELECT 1
              FROM pg_trigger AS exact_trigger
              WHERE exact_trigger.tgrelid = to_regclass(expected.table_name)
                AND exact_trigger.tgname = expected.trigger_name
                AND NOT exact_trigger.tgisinternal
                AND exact_trigger.tgenabled IN ('O','A')
                AND exact_trigger.tgnargs = 0
                AND pg_get_triggerdef(exact_trigger.oid, false) = expected.definition
            )
          )
        ) AS trigger_bindings_ready,
        (
          COALESCE(position('restoredFutureCoverageDates'
            IN pg_get_functiondef(to_regprocedure('qintopia_assert_stage10_shorten_combination(text)'))) > 0, false)::integer
          + COALESCE(position('booking.current_revision_id = revision.id'
            IN pg_get_functiondef(to_regprocedure('qintopia_validate_coverage_ownership()'))) > 0, false)::integer
          + COALESCE(position('coverage_conversion_consumed_insert'
            IN pg_get_functiondef(to_regprocedure('qintopia_protect_coverage_identity()'))) > 0, false)::integer
          + COALESCE(position('coverage_status_typed_transition'
            IN pg_get_functiondef(to_regprocedure('qintopia_protect_coverage_identity()'))) > 0, false)::integer
          + COALESCE(position('convertedMembershipCoveragePreserved'
            IN pg_get_functiondef(to_regprocedure('qintopia_assert_stage11_move_combination(text)'))) > 0, false)::integer
          + COALESCE(position('SHORTEN_STAY_FUTURE_ENTITLEMENT_RESTORED'
            IN pg_get_functiondef(to_regprocedure('qintopia_reject_stage10_entitlement_write()'))) > 0, false)::integer
          + COALESCE(position('entitlement_ledger_restore_command'
            IN pg_get_functiondef(to_regprocedure('qintopia_validate_entitlement_lifecycle_fact()'))) > 0, false)::integer
          + COALESCE(position('coverage_items_lifecycle_conserved'
            IN pg_get_functiondef(to_regprocedure('qintopia_validate_coverage_lifecycle_state()'))) > 0, false)::integer
          + COALESCE(position('typed future-stay restoration'
            IN pg_get_functiondef(to_regprocedure('qintopia_preserve_stage11_consumed_coverage()'))) > 0, false)::integer
          + COALESCE(position('entitlement_ledger_conversion_consume_shape'
            IN pg_get_functiondef(to_regprocedure('qintopia_validate_conversion_consume_entitlement_fact()'))) > 0, false)::integer
          + COALESCE(position('stage13_conversion_initial_lodging_fund_shape'
            IN pg_get_functiondef(to_regprocedure('qintopia_reject_lodging_funds_after_membership_transfer()'))) > 0, false)::integer
          + COALESCE(position('stage13_conversion_membership_funds_closed'
            IN pg_get_functiondef(to_regprocedure('qintopia_reject_membership_funds_after_stay_transfer()'))) > 0, false)::integer
          + COALESCE(position('target_membership_order.agreed_price_minor <= 0'
            IN pg_get_functiondef(to_regprocedure('qintopia_assert_stage13_stay_conversion_command_v033(text)'))) > 0, false)::integer
          + COALESCE(position('stage13_conversion_zero_transfer_funds'
            IN pg_get_functiondef(to_regprocedure('qintopia_assert_stage13_stay_conversion_command_v033(text)'))) > 0, false)::integer
          + COALESCE(position('stage13_conversion_inhouse_coverage'
            IN pg_get_functiondef(to_regprocedure('qintopia_assert_stage13_stay_conversion_command_v033(text)'))) > 0, false)::integer
          + COALESCE(position('converted_stay_membership_binding'
            IN pg_get_functiondef(to_regprocedure('qintopia_assert_converted_stay_fulfillment_command(text)'))) > 0, false)::integer
          + COALESCE(position('converted_stay_entitlement_balance'
            IN pg_get_functiondef(to_regprocedure('qintopia_assert_converted_stay_fulfillment_command(text)'))) > 0, false)::integer
          + COALESCE(position('converted_stay_extend_entitlement_graph'
            IN pg_get_functiondef(to_regprocedure('qintopia_assert_converted_stay_fulfillment_command(text)'))) > 0, false)::integer
          + COALESCE(position('converted_stay_shorten_entitlement_graph'
            IN pg_get_functiondef(to_regprocedure('qintopia_assert_converted_stay_fulfillment_command(text)'))) > 0, false)::integer
          + COALESCE(position('converted_stay_move_entitlement_graph'
            IN pg_get_functiondef(to_regprocedure('qintopia_assert_converted_stay_fulfillment_command(text)'))) > 0, false)::integer
          + COALESCE(position('converted_stay_current_coverage'
            IN pg_get_functiondef(to_regprocedure('qintopia_assert_converted_stay_fulfillment_command(text)'))) > 0, false)::integer
          + COALESCE(position('converted_stay_move_marker'
            IN pg_get_functiondef(to_regprocedure('qintopia_assert_converted_stay_fulfillment_command(text)'))) > 0, false)::integer
          + COALESCE(position('converted_stay_shorten_marker'
            IN pg_get_functiondef(to_regprocedure('qintopia_assert_converted_stay_fulfillment_command(text)'))) > 0, false)::integer
          + COALESCE(position('converted_stay_ordinary_action_closed'
            IN pg_get_functiondef(to_regprocedure('qintopia_assert_converted_stay_fulfillment_command(text)'))) > 0, false)::integer
          + COALESCE(position('coverage.status = ''HELD'''
            IN pg_get_functiondef(to_regprocedure('qintopia_assert_converted_stay_fulfillment_command(text)'))) > 0, false)::integer
        )::text AS body_marker_count,
        (
          SELECT NOT EXISTS (
            SELECT 1
            FROM (
              VALUES
                ('qintopia_assert_stage10_shorten_combination(text)', 'a9ea4fc40b6f4e204db8b9c9ec05869b493f5220c389bbd6443ee355cc30db4b'),
                ('qintopia_validate_coverage_ownership()', 'eceea85cdea1d5a9e591684a9f94dc66f492477cc8e303da8e28d0194a1e0669'),
                ('qintopia_protect_coverage_identity()', 'b8eb365fa29712bfe2c26b9c8dfe17a87bdcd0091b012af88a5bb328b5af0750'),
                ('qintopia_reject_stage10_entitlement_write()', 'd3450f298724fa9df85d09cc89175acf4d4cccb837963839b61dddbaac22756f'),
                ('qintopia_validate_entitlement_lifecycle_fact()', 'c03dac8f3f8571b9908fb95929f91fa7ea6386b78af1e19aa7127c54ca65ab35'),
                ('qintopia_validate_coverage_lifecycle_state()', '5442a3840f8204eefb8a465ed5297634add72877de279ff371a8800bbd421596'),
                ('qintopia_assert_stage11_move_combination(text)', 'a20dda3b5c1103f9daa577dd09edcf4a8544a7f66c9f292d9d72d4eb172b12cf'),
                ('qintopia_preserve_stage11_consumed_coverage()', '7152466eed2e839a9be9e38464e0fef91d5e615246f21dd372c7d487295dde58'),
                ('qintopia_validate_conversion_consume_entitlement_fact()', '10918d3fca13eb15e2b05cf3c661ad8289808589f1698ef04589099194e19b52'),
                ('qintopia_reject_lodging_funds_after_membership_transfer()', 'db65662dcfcffcde84fb0abc91d54a7a1b2b720b4cd42a8b34375f9499943d5e'),
                ('qintopia_reject_membership_funds_after_stay_transfer()', '94efb540ae902ad6edf664b72ec170e1ea54fc3459a5e70af01783b0e484ebb6'),
                ('qintopia_assert_stage13_stay_conversion_command_v033(text)', '09f38934bca14e5b4e1f2f902b63b5db8d5aa82e409fc86f41365b81bb53ddfe'),
                ('qintopia_assert_converted_stay_fulfillment_command(text)', '7b22fe62a3610462c82a4a54f95d62e478996454dfc312ff8e90c189dfa222a0'),
                ('qintopia_validate_converted_stay_fulfillment_execution()', 'ed58ceb0d44795151d23b34912bf90809ca7f2e370b41d9f07b564a71c8404ce'),
                ('qintopia_validate_converted_stay_fulfillment_child()', 'a4a789b5bbb5ad99fd7b6fd8aa38528f6bcc6f4851ea0e7f550f7d28d965733c')
            ) AS expected(signature, body_hash)
            WHERE NOT COALESCE((
              SELECT encode(
                  sha256(convert_to(procedure_row.prosrc, 'UTF8')),
                  'hex'
                ) = expected.body_hash
                AND procedure_row.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')
                AND NOT procedure_row.prosecdef
                AND procedure_row.provolatile = 'v'
                AND (
                  (expected.signature IN (
                    'qintopia_validate_conversion_consume_entitlement_fact()',
                    'qintopia_reject_lodging_funds_after_membership_transfer()',
                    'qintopia_reject_membership_funds_after_stay_transfer()'
                  ) AND procedure_row.proconfig = ARRAY['search_path=pg_catalog, public']::text[])
                  OR
                  (expected.signature NOT IN (
                    'qintopia_validate_conversion_consume_entitlement_fact()',
                    'qintopia_reject_lodging_funds_after_membership_transfer()',
                    'qintopia_reject_membership_funds_after_stay_transfer()'
                  ) AND procedure_row.proconfig IS NULL)
                )
                AND procedure_row.prokind = 'f'
              FROM pg_proc AS procedure_row
              WHERE procedure_row.oid = to_regprocedure(expected.signature)
            ), false)
          )
        ) AS function_bodies_ready
      FROM pg_trigger AS trigger
    `.execute(db);
    const temporaryOtherRoomObjects = await sql<{
      quote_column_ready: boolean;
      quote_constraint_ready: boolean;
      function_count: string;
      trigger_binding_ready: boolean;
      body_marker_count: string;
      function_bodies_ready: boolean;
      runtime_privileges_ready: boolean;
    }>`
      WITH
      database_owner AS (
        SELECT database_row.datdba
        FROM pg_database AS database_row
        WHERE database_row.datname = current_database()
      ),
      runtime_role AS (
        SELECT oid
        FROM pg_roles
        WHERE rolname = 'qintopia_runtime'
      )
      SELECT
        EXISTS (
          SELECT 1
          FROM pg_attribute AS attribute
          WHERE attribute.attrelid = to_regclass('quotes')
            AND attribute.attname = 'temporary_other_room_arrangement'
            AND attribute.atttypid = 'jsonb'::regtype
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
            AND NOT attribute.attnotnull
        ) AS quote_column_ready,
        EXISTS (
          SELECT 1
          FROM pg_constraint AS constraint_row
          WHERE constraint_row.conrelid = to_regclass('quotes')
            AND constraint_row.conname = 'quotes_temporary_other_room_arrangement_shape'
            AND constraint_row.contype = 'c'
            AND NOT constraint_row.condeferrable
            AND NOT constraint_row.condeferred
            AND constraint_row.convalidated
            AND pg_get_constraintdef(constraint_row.oid, false) = 'CHECK (((temporary_other_room_arrangement IS NULL) OR ((jsonb_typeof(temporary_other_room_arrangement) = ''object''::text) AND ((temporary_other_room_arrangement ->> ''kind''::text) = ''TEMPORARY_OTHER_ROOM''::text) AND ((temporary_other_room_arrangement ->> ''originalInventoryKind''::text) = ''ROOM''::text) AND ((temporary_other_room_arrangement ->> ''entitlementUnitKind''::text) = ''ROOM_NIGHT''::text) AND ((temporary_other_room_arrangement ->> ''actualInventoryKind''::text) = ''ROOM''::text) AND ((temporary_other_room_arrangement ->> ''originalRoomTypeCode''::text) IS DISTINCT FROM (temporary_other_room_arrangement ->> ''actualRoomTypeCode''::text)) AND (temporary_other_room_arrangement ? ''membershipOrderId''::text) AND (temporary_other_room_arrangement ? ''memberContractId''::text) AND (temporary_other_room_arrangement ? ''entitlementLotId''::text) AND (temporary_other_room_arrangement ? ''actualInventoryUnitId''::text) AND (temporary_other_room_arrangement ? ''originalRoomTypeCode''::text) AND (temporary_other_room_arrangement ? ''actualRoomTypeCode''::text) AND (temporary_other_room_arrangement ? ''arrivalDate''::text) AND (temporary_other_room_arrangement ? ''departureDate''::text) AND ((temporary_other_room_arrangement ->> ''arrivalDate''::text) ~ ''^\\d{4}-\\d{2}-\\d{2}$''::text) AND ((temporary_other_room_arrangement ->> ''departureDate''::text) ~ ''^\\d{4}-\\d{2}-\\d{2}$''::text) AND (((temporary_other_room_arrangement ->> ''arrivalDate''::text))::date < ((temporary_other_room_arrangement ->> ''departureDate''::text))::date))))'
        ) AS quote_constraint_ready,
        (
          (to_regprocedure('qintopia_validate_coverage_ownership()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_validate_temporary_other_room_create_order()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_reject_temporary_other_room_lifecycle_amendment()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_protect_temporary_other_room_member_chain()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_reject_temporary_other_room_funds()') IS NOT NULL)::integer
        )::text AS function_count,
        (EXISTS (
          SELECT 1
          FROM pg_trigger AS trigger
          WHERE trigger.tgrelid = to_regclass('amendments')
            AND trigger.tgname = 'amendments_validate_temporary_other_room_create'
            AND NOT trigger.tgisinternal
            AND trigger.tgenabled IN ('O','A')
            AND trigger.tgdeferrable
            AND trigger.tginitdeferred
            AND trigger.tgnargs = 0
            AND trigger.tgfoid = to_regprocedure('qintopia_validate_temporary_other_room_create_order()')
            AND pg_get_triggerdef(trigger.oid, false) = 'CREATE CONSTRAINT TRIGGER amendments_validate_temporary_other_room_create AFTER INSERT ON public.amendments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (((new.amendment_type = ''CREATE_ORDER''::text) AND ((new.reason_code = ''TEMPORARY_OTHER_ROOM''::text) OR (new.payload ? ''temporaryOtherRoomArrangement''::text)))) EXECUTE FUNCTION qintopia_validate_temporary_other_room_create_order()'
        ) AND EXISTS (
          SELECT 1
          FROM pg_trigger AS trigger
          WHERE trigger.tgrelid = to_regclass('amendments')
            AND trigger.tgname = 'amendments_reject_temporary_other_room_lifecycle'
            AND NOT trigger.tgisinternal
            AND trigger.tgenabled IN ('O','A')
            AND NOT trigger.tgdeferrable
            AND NOT trigger.tginitdeferred
            AND trigger.tgnargs = 0
            AND trigger.tgfoid = to_regprocedure('qintopia_reject_temporary_other_room_lifecycle_amendment()')
            AND pg_get_triggerdef(trigger.oid, false) = 'CREATE TRIGGER amendments_reject_temporary_other_room_lifecycle BEFORE INSERT ON public.amendments FOR EACH ROW EXECUTE FUNCTION qintopia_reject_temporary_other_room_lifecycle_amendment()'
        ) AND EXISTS (
          SELECT 1
          FROM pg_trigger AS trigger
          WHERE trigger.tgrelid = to_regclass('member_contracts')
            AND trigger.tgname = 'member_contracts_protect_temporary_other_room_source'
            AND NOT trigger.tgisinternal
            AND trigger.tgenabled IN ('O','A')
            AND NOT trigger.tgdeferrable
            AND NOT trigger.tginitdeferred
            AND trigger.tgnargs = 0
            AND trigger.tgfoid = to_regprocedure('qintopia_protect_temporary_other_room_member_chain()')
            AND pg_get_triggerdef(trigger.oid, false) = 'CREATE TRIGGER member_contracts_protect_temporary_other_room_source BEFORE DELETE OR UPDATE ON public.member_contracts FOR EACH ROW EXECUTE FUNCTION qintopia_protect_temporary_other_room_member_chain()'
        ) AND EXISTS (
          SELECT 1
          FROM pg_trigger AS trigger
          WHERE trigger.tgrelid = to_regclass('entitlement_lots')
            AND trigger.tgname = 'entitlement_lots_protect_temporary_other_room_source'
            AND NOT trigger.tgisinternal
            AND trigger.tgenabled IN ('O','A')
            AND NOT trigger.tgdeferrable
            AND NOT trigger.tginitdeferred
            AND trigger.tgnargs = 0
            AND trigger.tgfoid = to_regprocedure('qintopia_protect_temporary_other_room_member_chain()')
            AND pg_get_triggerdef(trigger.oid, false) = 'CREATE TRIGGER entitlement_lots_protect_temporary_other_room_source BEFORE INSERT OR DELETE OR UPDATE ON public.entitlement_lots FOR EACH ROW EXECUTE FUNCTION qintopia_protect_temporary_other_room_member_chain()'
        ) AND EXISTS (
          SELECT 1
          FROM pg_trigger AS trigger
          WHERE trigger.tgrelid = to_regclass('entitlement_ledger')
            AND trigger.tgname = 'entitlement_ledger_protect_temporary_other_room_source'
            AND NOT trigger.tgisinternal
            AND trigger.tgenabled IN ('O','A')
            AND NOT trigger.tgdeferrable
            AND NOT trigger.tginitdeferred
            AND trigger.tgnargs = 0
            AND trigger.tgfoid = to_regprocedure('qintopia_protect_temporary_other_room_member_chain()')
            AND pg_get_triggerdef(trigger.oid, false) = 'CREATE TRIGGER entitlement_ledger_protect_temporary_other_room_source BEFORE INSERT ON public.entitlement_ledger FOR EACH ROW EXECUTE FUNCTION qintopia_protect_temporary_other_room_member_chain()'
        ) AND EXISTS (
          SELECT 1
          FROM pg_trigger AS trigger
          WHERE trigger.tgrelid = to_regclass('collection_facts')
            AND trigger.tgname = 'collection_facts_reject_temporary_other_room_funds'
            AND NOT trigger.tgisinternal
            AND trigger.tgenabled IN ('O','A')
            AND trigger.tgdeferrable
            AND trigger.tginitdeferred
            AND trigger.tgnargs = 0
            AND trigger.tgfoid = to_regprocedure('qintopia_reject_temporary_other_room_funds()')
            AND pg_get_triggerdef(trigger.oid, false) = 'CREATE CONSTRAINT TRIGGER collection_facts_reject_temporary_other_room_funds AFTER INSERT ON public.collection_facts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_reject_temporary_other_room_funds()'
        )) AS trigger_binding_ready,
        (
          COALESCE(position('created.reason_code = ''TEMPORARY_OTHER_ROOM'''
            IN pg_get_functiondef(to_regprocedure('qintopia_validate_coverage_ownership()'))) > 0, false)::integer
          + COALESCE(position('temporaryOtherRoomArrangement'
            IN pg_get_functiondef(to_regprocedure('qintopia_validate_coverage_ownership()'))) > 0, false)::integer
          + COALESCE(position('membership_room_type_code IS DISTINCT FROM inventory_room_type_code'
            IN pg_get_functiondef(to_regprocedure('qintopia_validate_coverage_ownership()'))) > 0, false)::integer
          + COALESCE(position('coverage_items_membership_product_match'
            IN pg_get_functiondef(to_regprocedure('qintopia_validate_coverage_ownership()'))) > 0, false)::integer
          + COALESCE(position('temporary_other_room_zero_pricing'
            IN pg_get_functiondef(to_regprocedure('qintopia_validate_temporary_other_room_create_order()'))) > 0, false)::integer
          + COALESCE(position('temporary_other_room_command_evidence'
            IN pg_get_functiondef(to_regprocedure('qintopia_validate_temporary_other_room_create_order()'))) > 0, false)::integer
          + COALESCE(position('claim.source_type = ''ORDER_SEGMENT'''
            IN pg_get_functiondef(to_regprocedure('qintopia_validate_temporary_other_room_create_order()'))) > 0, false)::integer
          + COALESCE(position('ledger.entry_type = ''HOLD'''
            IN pg_get_functiondef(to_regprocedure('qintopia_validate_temporary_other_room_create_order()'))) > 0, false)::integer
          + COALESCE(position('temporary_other_room_exact_initial_segment'
            IN pg_get_functiondef(to_regprocedure('qintopia_validate_temporary_other_room_create_order()'))) > 0, false)::integer
          + COALESCE(position('temporary_other_room_exact_source_priority'
            IN pg_get_functiondef(to_regprocedure('qintopia_validate_temporary_other_room_create_order()'))) > 0, false)::integer
          + COALESCE(position('temporary_other_room_post_hold_balance'
            IN pg_get_functiondef(to_regprocedure('qintopia_validate_temporary_other_room_create_order()'))) > 0, false)::integer
          + COALESCE(position('temporary_other_room_exact_claim_set'
            IN pg_get_functiondef(to_regprocedure('qintopia_validate_temporary_other_room_create_order()'))) > 0, false)::integer
          + COALESCE(position('temporary_other_room_quote_evidence'
            IN pg_get_functiondef(to_regprocedure('qintopia_validate_temporary_other_room_create_order()'))) > 0, false)::integer
          + COALESCE(position('temporary_other_room_preview_evidence'
            IN pg_get_functiondef(to_regprocedure('qintopia_validate_temporary_other_room_create_order()'))) > 0, false)::integer
          + COALESCE(position('temporary_other_room_current_transaction'
            IN pg_get_functiondef(to_regprocedure('qintopia_validate_temporary_other_room_create_order()'))) > 0, false)::integer
          + COALESCE(position('temporary_other_room_lifecycle_closed'
            IN pg_get_functiondef(to_regprocedure('qintopia_reject_temporary_other_room_lifecycle_amendment()'))) > 0, false)::integer
          + COALESCE(position('''REFRESH_MEMBER_COVERAGE'''
            IN pg_get_functiondef(to_regprocedure('qintopia_reject_temporary_other_room_lifecycle_amendment()'))) > 0, false)::integer
          + COALESCE(position('''CORRECT_HISTORICAL_STAY_ARRANGEMENT'''
            IN pg_get_functiondef(to_regprocedure('qintopia_reject_temporary_other_room_lifecycle_amendment()'))) > 0, false)::integer
          + COALESCE(position('temporary_other_room_reschedule_subset'
            IN pg_get_functiondef(to_regprocedure('qintopia_reject_temporary_other_room_lifecycle_amendment()'))) > 0, false)::integer
          + COALESCE(position('temporary_other_room_member_chain_closed'
            IN pg_get_functiondef(to_regprocedure('qintopia_protect_temporary_other_room_member_chain()'))) > 0, false)::integer
          + COALESCE(position('temporary_other_room_no_funds'
            IN pg_get_functiondef(to_regprocedure('qintopia_reject_temporary_other_room_funds()'))) > 0, false)::integer
          + COALESCE(position('created.payload ? ''temporaryOtherRoomArrangement'''
            IN pg_get_functiondef(to_regprocedure('qintopia_reject_temporary_other_room_funds()'))) > 0, false)::integer
        )::text AS body_marker_count,
        (
          SELECT NOT EXISTS (
            SELECT 1
            FROM (
              VALUES
                ('qintopia_validate_coverage_ownership()', 'eceea85cdea1d5a9e591684a9f94dc66f492477cc8e303da8e28d0194a1e0669'),
                ('qintopia_validate_temporary_other_room_create_order()', '7591e6b8e9d6cac8f3625807ab56ec2f743b3d4f96accd8c7d759a9c435c72b8'),
                ('qintopia_reject_temporary_other_room_lifecycle_amendment()', 'f48371f00b8377485122ef26f988ace3a1cf6a54711e94937f9c74d45c1f6a54'),
                ('qintopia_protect_temporary_other_room_member_chain()', 'b26f75a93c4f5e0580847d61c267c72db734f1a4dc2ed7fe3590c43ff0798004'),
                ('qintopia_reject_temporary_other_room_funds()', '31abb8a611888eb8364029b30dea6050df13da1df75d6615f923238fb912957f')
            ) AS expected(signature, body_hash)
            WHERE NOT COALESCE((
              SELECT encode(sha256(convert_to(procedure_row.prosrc, 'UTF8')), 'hex') = expected.body_hash
                AND procedure_row.proowner = database_owner.datdba
                AND procedure_row.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')
                AND NOT procedure_row.prosecdef
                AND procedure_row.provolatile = 'v'
                AND procedure_row.prokind = 'f'
                AND procedure_row.proconfig IS NULL
              FROM pg_proc AS procedure_row
              CROSS JOIN database_owner
              WHERE procedure_row.oid = to_regprocedure(expected.signature)
            ), false)
          )
        ) AS function_bodies_ready,
        COALESCE((
          SELECT has_table_privilege(runtime_role.oid, 'quotes', 'SELECT')
            AND has_table_privilege(runtime_role.oid, 'quotes', 'INSERT')
            AND NOT has_table_privilege(runtime_role.oid, 'quotes', 'UPDATE')
            AND NOT has_table_privilege(runtime_role.oid, 'quotes', 'DELETE')
            AND NOT has_table_privilege(runtime_role.oid, 'quotes', 'TRUNCATE')
            AND NOT has_table_privilege(runtime_role.oid, 'quotes', 'TRIGGER')
            AND NOT has_table_privilege(runtime_role.oid, 'quotes', 'REFERENCES')
            AND NOT has_function_privilege(runtime_role.oid, 'qintopia_validate_coverage_ownership()'::regprocedure, 'EXECUTE')
            AND NOT has_function_privilege('public', 'qintopia_validate_coverage_ownership()'::regprocedure, 'EXECUTE')
            AND NOT has_function_privilege(runtime_role.oid, 'qintopia_validate_temporary_other_room_create_order()'::regprocedure, 'EXECUTE')
            AND NOT has_function_privilege('public', 'qintopia_validate_temporary_other_room_create_order()'::regprocedure, 'EXECUTE')
            AND NOT has_function_privilege(runtime_role.oid, 'qintopia_reject_temporary_other_room_lifecycle_amendment()'::regprocedure, 'EXECUTE')
            AND NOT has_function_privilege('public', 'qintopia_reject_temporary_other_room_lifecycle_amendment()'::regprocedure, 'EXECUTE')
            AND NOT has_function_privilege(runtime_role.oid, 'qintopia_protect_temporary_other_room_member_chain()'::regprocedure, 'EXECUTE')
            AND NOT has_function_privilege('public', 'qintopia_protect_temporary_other_room_member_chain()'::regprocedure, 'EXECUTE')
            AND NOT has_function_privilege(runtime_role.oid, 'qintopia_reject_temporary_other_room_funds()'::regprocedure, 'EXECUTE')
            AND NOT has_function_privilege('public', 'qintopia_reject_temporary_other_room_funds()'::regprocedure, 'EXECUTE')
          FROM runtime_role
        ), false) AS runtime_privileges_ready
    `.execute(db);
    const finalReady = memberProfileObjects.rows[0]?.columns_ready === true
      && memberProfileObjects.rows[0]?.constraints_ready === true
      && memberProfileObjects.rows[0]?.trigger_ready === true
      && memberProfileObjects.rows[0]?.function_body_ready === true
      && foundationalObjects.rows[0]?.function_count === "5"
      && foundationalObjects.rows[0]?.trigger_count === "13"
      && foundationalObjects.rows[0]?.function_bodies_ready === true
      && foundationalObjects.rows[0]?.membership_order_identity_body_ready === true
      && foundationalObjects.rows[0]?.idempotency_constraint_ready === true
      && foundationalObjects.rows[0]?.membership_payment_append_only_trigger_ready === true
      && foundationalObjects.rows[0]?.membership_order_identity_trigger_ready === true
      && stage10Objects.rows[0]?.function_count === "3"
      && stage10Objects.rows[0]?.deferred_trigger_count === "2"
      && stage10Objects.rows[0]?.immediate_trigger_count === "3"
      && stage11Objects.rows[0]?.function_count === "14"
      && stage11Objects.rows[0]?.replacement_count === "2"
      && stage11Objects.rows[0]?.body_marker_count === "8"
      && stage11Objects.rows[0]?.deferred_trigger_count === "4"
      && stage11Objects.rows[0]?.immediate_trigger_count === "8"
      && collectionFactObjects.rows[0]?.function_count === "1"
      && collectionFactObjects.rows[0]?.trigger_count === "1"
      && collectionFactObjects.rows[0]?.historical_column_count === "1"
      && collectionFactObjects.rows[0]?.body_marker_count === "6"
      && collectionFactObjects.rows[0]?.trigger_bindings_ready === true
      && collectionFactObjects.rows[0]?.function_bodies_ready === true
      && completedStayBackfillObjects.rows[0]?.cash_column_count === "1"
      && completedStayBackfillObjects.rows[0]?.cash_constraint_count === "1"
      && completedStayBackfillObjects.rows[0]?.cash_function_count === "1"
      && completedStayBackfillObjects.rows[0]?.cash_trigger_count === "1"
      && completedStayBackfillObjects.rows[0]?.cash_body_marker_count === "2"
      && completedStayBackfillObjects.rows[0]?.checkout_body_marker_count === "4"
      && completeStayGuardObjects.rows[0]?.function_bodies_ready === true
      && completeStayGuardObjects.rows[0]?.fulfillment_index_ready === true
      && completeStayGuardObjects.rows[0]?.trigger_bindings_ready === true
      && stage12Objects.rows[0]?.function_count === "9"
      && stage12Objects.rows[0]?.deferred_trigger_count === "4"
      && stage12Objects.rows[0]?.immediate_trigger_count === "5"
      && stage12Objects.rows[0]?.status_constraint_count === "2"
      && stage12Objects.rows[0]?.restore_index_count === "1"
      && stage12Objects.rows[0]?.body_marker_count === "6"
      && stage13Objects.rows[0]?.function_count === "13"
      && stage13Objects.rows[0]?.deferred_trigger_count === "9"
      && stage13Objects.rows[0]?.immediate_trigger_count === "7"
      && stage13Objects.rows[0]?.table_count === "1"
      && stage13Objects.rows[0]?.source_column_count === "1"
      && stage13Objects.rows[0]?.critical_constraints_ready === true
      && stage13Objects.rows[0]?.index_count === "4"
      && stage13Objects.rows[0]?.body_marker_count === "13"
      && stage13Objects.rows[0]?.execution_wrapper_body_ready === true
      && stage13Objects.rows[0]?.child_wrapper_body_ready === true
      && stage13Objects.rows[0]?.membership_order_wrapper_body_ready === true
      && stage13Objects.rows[0]?.trigger_bindings_ready === true
      && stage13Objects.rows[0]?.function_bodies_ready === true
      && historicalStayArrangementCorrectionObjects.rows[0]?.table_count === "1"
      && historicalStayArrangementCorrectionObjects.rows[0]?.function_count === "4"
      && historicalStayArrangementCorrectionObjects.rows[0]?.function_bodies_ready === true
      && historicalStayArrangementCorrectionObjects.rows[0]?.runtime_privileges_ready === true
      && historicalStayArrangementCorrectionObjects.rows[0]?.trigger_bindings_ready === true
      && adminMembershipCorrectionObjects.rows[0]?.table_count === "6"
      && adminMembershipCorrectionObjects.rows[0]?.index_bindings_ready === true
      && adminMembershipCorrectionObjects.rows[0]?.function_bodies_ready === true
      && adminMembershipCorrectionObjects.rows[0]?.security_function_privileges_ready === true
      && adminMembershipCorrectionObjects.rows[0]?.runtime_table_privileges_ready === true
      && adminMembershipCorrectionObjects.rows[0]?.trigger_bindings_ready === true
      && step9CatalogIntegrity.rows[0]?.new_table_catalog_ready === true
      && step9CatalogIntegrity.rows[0]?.altered_columns_ready === true
      && step9CatalogIntegrity.rows[0]?.altered_constraints_ready === true
      && inHouseMembershipFulfillmentObjects.rows[0]?.function_count === "15"
      && inHouseMembershipFulfillmentObjects.rows[0]?.index_ready === true
      && inHouseMembershipFulfillmentObjects.rows[0]?.coverage_trigger_count === "2"
      && inHouseMembershipFulfillmentObjects.rows[0]?.deferred_trigger_count === "4"
      && inHouseMembershipFulfillmentObjects.rows[0]?.trigger_bindings_ready === true
      && inHouseMembershipFulfillmentObjects.rows[0]?.body_marker_count === "25"
      && inHouseMembershipFulfillmentObjects.rows[0]?.function_bodies_ready === true
      && temporaryOtherRoomObjects.rows[0]?.quote_column_ready === true
      && temporaryOtherRoomObjects.rows[0]?.quote_constraint_ready === true
      && temporaryOtherRoomObjects.rows[0]?.function_count === "5"
      && temporaryOtherRoomObjects.rows[0]?.trigger_binding_ready === true
      && temporaryOtherRoomObjects.rows[0]?.body_marker_count === "22"
      && temporaryOtherRoomObjects.rows[0]?.function_bodies_ready === true
      && temporaryOtherRoomObjects.rows[0]?.runtime_privileges_ready === true;
    return finalReady && await roomCatalogReady(db) && await accountManagementReady(db) && await checkoutReversalReady(db) && await companionReady(db) && await integrationReady(db) && await wecomRefundReady(db) && await externalPaymentsReady(db);
  } catch {
    return false;
  }
}
