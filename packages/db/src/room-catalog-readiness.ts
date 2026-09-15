import { sql, type Kysely } from "kysely";
import type { Database } from "./schema.ts";

/** Fail closed if the catalog's privileged write boundary or immutable history is altered. */
export async function roomCatalogReady(db: Kysely<Database>): Promise<boolean> {
  const result = await sql<{ ready: boolean }>`
    WITH expected(signature, body_hash, definer) AS (VALUES
      ('qintopia_apply_room_catalog(text,jsonb,text)', '23cec734e2202a964ffbfbcad1955a5cc49248fad515fc7da38badbc2f13405a', true),
      ('qintopia_catalog_claim_guard()', '1033b51a86b2c9b4e0993d4beff320b52673fb0024586e31e6884117d37abc4c', false),
      ('qintopia_catalog_commit_guard()', 'e6c37d102859981effd43d6fde238fe864c9826f50982fc34f3c6320bdb7af46', false)
    ) SELECT NOT EXISTS (
      SELECT 1 FROM expected LEFT JOIN pg_proc ON pg_proc.oid = to_regprocedure(signature)
      WHERE pg_proc.oid IS NULL OR encode(sha256(convert_to(prosrc, 'UTF8')), 'hex') <> body_hash
        OR prosecdef IS DISTINCT FROM definer OR provolatile <> 'v' OR prokind <> 'f'
        OR proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']::text[]
        OR proowner <> (SELECT datdba FROM pg_database WHERE datname = current_database())
        OR has_function_privilege('public', pg_proc.oid, 'EXECUTE')
    ) AND NOT EXISTS (
      SELECT 1 FROM (VALUES ('room_catalog_state'), ('room_catalog_links'), ('room_catalog_heads'), ('room_catalog_changes')) AS tables(name)
      WHERE NOT has_table_privilege('qintopia_runtime', name, 'SELECT')
        OR has_table_privilege('qintopia_runtime', name, 'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES')
    ) AND has_function_privilege('qintopia_runtime', 'qintopia_apply_room_catalog(text,jsonb,text)', 'EXECUTE')
    AND NOT EXISTS (
      SELECT 1 FROM (VALUES
        ('room_catalog_changes', 'room_catalog_changes_append_only', 'CREATE TRIGGER room_catalog_changes_append_only BEFORE DELETE OR UPDATE ON public.room_catalog_changes FOR EACH ROW EXECUTE FUNCTION qintopia_prevent_fact_mutation()'),
        ('room_catalog_links', 'room_catalog_links_append_only', 'CREATE TRIGGER room_catalog_links_append_only BEFORE DELETE OR UPDATE ON public.room_catalog_links FOR EACH ROW EXECUTE FUNCTION qintopia_prevent_fact_mutation()'),
        ('inventory_claims', 'inventory_claims_catalog_guard', 'CREATE TRIGGER inventory_claims_catalog_guard BEFORE INSERT OR UPDATE ON public.inventory_claims FOR EACH ROW EXECUTE FUNCTION qintopia_catalog_claim_guard()'),
        ('command_executions', 'command_executions_catalog_guard', 'CREATE CONSTRAINT TRIGGER command_executions_catalog_guard AFTER INSERT OR UPDATE ON public.command_executions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_catalog_commit_guard()'),
        ('room_catalog_changes', 'room_catalog_changes_commit_guard', 'CREATE CONSTRAINT TRIGGER room_catalog_changes_commit_guard AFTER INSERT ON public.room_catalog_changes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_catalog_commit_guard()')
      ) AS guards(relation, name, definition)
      WHERE NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass(relation) AND tgname = name
        AND tgenabled IN ('O', 'A') AND pg_get_triggerdef(oid) = definition)
    ) AND EXISTS (SELECT 1 FROM pg_index WHERE indexrelid = to_regclass('inventory_units_active_code')
      AND indisvalid AND indisready AND indisunique
      AND pg_get_indexdef(indexrelid) = 'CREATE UNIQUE INDEX inventory_units_active_code ON public.inventory_units USING btree (property_id, code) WHERE active')
    AS ready
  `.execute(db);
  return result.rows[0]?.ready === true;
}
