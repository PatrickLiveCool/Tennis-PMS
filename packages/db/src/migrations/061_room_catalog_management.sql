LOCK TABLE command_catalog, staff_command_profile_catalog, subject_command_grants,
  inventory_units, inventory_claims, coverage_items IN SHARE ROW EXCLUSIVE MODE;

INSERT INTO command_catalog(command_type, command_class) VALUES ('MANAGE_ROOM_CATALOG', 'HUMAN_COMMAND');
DO $$ DECLARE definition text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO STRICT definition FROM pg_constraint
  WHERE conrelid = 'subject_command_grants'::regclass AND conname = 'subject_command_grants_human_exact_check';
  IF position('''CORRECT_ORDER_OCCUPANT''::text' IN definition) = 0 THEN RAISE EXCEPTION 'catalog grant constraint not recognized'; END IF;
  definition := replace(definition, '''CORRECT_ORDER_OCCUPANT''::text', '''CORRECT_ORDER_OCCUPANT''::text, ''MANAGE_ROOM_CATALOG''::text');
  ALTER TABLE subject_command_grants DROP CONSTRAINT subject_command_grants_human_exact_check;
  EXECUTE 'ALTER TABLE subject_command_grants ADD CONSTRAINT subject_command_grants_human_exact_check ' || definition;
END $$;
INSERT INTO staff_command_profile_catalog(profile, command_type, token_default) VALUES ('ADMIN', 'MANAGE_ROOM_CATALOG', false);
INSERT INTO subject_command_grants(subject_id, property_id, command_type)
SELECT subject_id, property_id, 'MANAGE_ROOM_CATALOG' FROM staff_profile_assignments WHERE profile = 'ADMIN';
UPDATE staff_profile_reconciliation_state SET projection_hash = (
  SELECT encode(sha256(convert_to(COALESCE(string_agg(row_value, E'\n' ORDER BY row_value), ''), 'UTF8')), 'hex')
  FROM (
    SELECT format('A|%s|%s|%s', subject_id, property_id, profile) AS row_value FROM staff_profile_assignments
    UNION ALL SELECT format('G|%s|%s|%s', subject_id, property_id, command_type) FROM subject_command_grants
  ) AS projection
), reconciled_by = current_user, reconciled_at = now() WHERE singleton;

CREATE TABLE room_catalog_state (
  property_id text PRIMARY KEY REFERENCES properties(id),
  version integer NOT NULL CHECK (version > 0),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object' AND jsonb_typeof(snapshot->'types') = 'array'
    AND jsonb_typeof(snapshot->'rates') = 'array' AND (snapshot->>'version')::integer = version)
);
CREATE TABLE room_catalog_links (
  unit_id text PRIMARY KEY REFERENCES inventory_units(id),
  asset_id text NOT NULL REFERENCES inventory_units(id),
  version integer NOT NULL CHECK (version >= 0),
  UNIQUE(asset_id, version)
);
CREATE TABLE room_catalog_heads (
  property_id text NOT NULL REFERENCES properties(id),
  effective_from date NOT NULL,
  policy_id text NOT NULL UNIQUE REFERENCES pricing_policy_versions(id),
  PRIMARY KEY(property_id, effective_from)
);
CREATE TABLE room_catalog_changes (
  id text PRIMARY KEY,
  property_id text NOT NULL REFERENCES properties(id),
  command_id text NOT NULL UNIQUE REFERENCES command_executions(id),
  effect jsonb NOT NULL,
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX room_catalog_changes_history ON room_catalog_changes(property_id, created_at DESC);
CREATE TRIGGER room_catalog_changes_append_only BEFORE UPDATE OR DELETE ON room_catalog_changes
FOR EACH ROW EXECUTE FUNCTION qintopia_prevent_fact_mutation();
CREATE TRIGGER room_catalog_links_append_only BEFORE UPDATE OR DELETE ON room_catalog_links
FOR EACH ROW EXECUTE FUNCTION qintopia_prevent_fact_mutation();
GRANT SELECT ON room_catalog_state, room_catalog_links, room_catalog_heads, room_catalog_changes TO qintopia_runtime;

-- Operational codes identify the currently sellable version. Old IDs and codes remain available to historical orders.
ALTER TABLE inventory_units DROP CONSTRAINT inventory_units_property_id_code_key;
CREATE UNIQUE INDEX inventory_units_active_code ON inventory_units(property_id, code) WHERE active;
ALTER TABLE inventory_units DROP CONSTRAINT inventory_units_physical_bed_count_shape;
ALTER TABLE inventory_units ADD CONSTRAINT inventory_units_physical_bed_count_shape CHECK (
  (kind = 'ROOM' AND (physical_bed_count IS NULL OR physical_bed_count BETWEEN 1 AND 100))
  OR (kind = 'BED' AND physical_bed_count IS NULL)
);

CREATE FUNCTION qintopia_catalog_claim_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT NEW.active THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('qintopia:room-catalog:' || NEW.property_id, 0::bigint));
  IF NOT EXISTS (SELECT 1 FROM inventory_units AS unit JOIN inventory_units AS room ON room.id = NEW.room_id
    WHERE unit.id = NEW.inventory_unit_id AND unit.property_id = NEW.property_id
      AND room.property_id = NEW.property_id AND room.active AND unit.active
      AND (unit.id = room.id OR unit.parent_room_id = room.id)) THEN
    RAISE EXCEPTION 'inventory version is inactive; refresh room catalog' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inventory_claims_catalog_guard BEFORE INSERT OR UPDATE ON inventory_claims
FOR EACH ROW EXECUTE FUNCTION qintopia_catalog_claim_guard();
REVOKE ALL ON FUNCTION qintopia_catalog_claim_guard() FROM PUBLIC;

CREATE FUNCTION qintopia_apply_room_catalog(target_command text, approved_effect jsonb, reason_note text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  execution command_executions%ROWTYPE;
  state room_catalog_state%ROWTYPE;
  item jsonb;
  room_type jsonb;
  policy jsonb;
  property_currency text;
  change_id text := 'catalog_change_' || target_command;
  before_version integer;
  after_version integer;
  retiring text[];
  room_ids text[];
  affected_types text[];
  target_room text;
  next_policy_version integer;
  action_name text;
BEGIN
  SELECT * INTO execution FROM command_executions WHERE id = target_command FOR UPDATE;
  IF execution.command_type IS DISTINCT FROM 'MANAGE_ROOM_CATALOG' OR execution.state IS DISTINCT FROM 'EXECUTING'
    OR approved_effect->>'operation' IS DISTINCT FROM execution.command_type
    OR NOT EXISTS (SELECT 1 FROM web_sessions WHERE id = execution.credential_id
      AND subject_id = execution.subject_id AND revoked_at IS NULL AND expires_at > clock_timestamp())
    OR approved_effect->>'propertyId' IS DISTINCT FROM execution.property_id OR COALESCE(btrim(reason_note), '') = '' THEN
    RAISE EXCEPTION 'catalog requires an executing typed command and reason' USING ERRCODE = '23514';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('qintopia:room-catalog:' || execution.property_id, 0::bigint));
  IF NOT EXISTS (SELECT 1 FROM staff_profile_assignments AS assignment
    JOIN subjects AS subject ON subject.id = assignment.subject_id
    JOIN subject_property_grants AS access ON access.subject_id = subject.id AND access.property_id = assignment.property_id
    JOIN subject_command_grants AS grant_row ON grant_row.subject_id = subject.id AND grant_row.property_id = assignment.property_id
    JOIN web_sessions AS session ON session.subject_id = subject.id AND session.id = execution.credential_id
    WHERE assignment.subject_id = execution.subject_id AND assignment.property_id = execution.property_id
      AND assignment.profile = 'ADMIN' AND subject.status = 'ACTIVE' AND access.access_level = 'WRITE'
      AND grant_row.command_type = execution.command_type AND session.revoked_at IS NULL AND session.expires_at > clock_timestamp()) THEN
    RAISE EXCEPTION 'catalog maintenance requires an active administrator session' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM command_previews WHERE subject_id = execution.subject_id AND property_id = execution.property_id
    AND command_type = execution.command_type AND status = 'OPEN' AND effect = approved_effect AND expires_at > clock_timestamp()) THEN
    RAISE EXCEPTION 'catalog changes must match an open approved preview' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO state FROM room_catalog_state WHERE property_id = execution.property_id FOR UPDATE;
  before_version := (approved_effect->>'beforeVersion')::integer;
  after_version := (approved_effect#>>'{after,version}')::integer;
  IF before_version IS DISTINCT FROM COALESCE(state.version, 0) OR after_version IS DISTINCT FROM before_version + 1 THEN
    RAISE EXCEPTION 'catalog version conflict' USING ERRCODE = '40001';
  END IF;
  action_name := approved_effect->>'action';
  IF action_name IS NULL OR action_name NOT IN ('SAVE_TYPE','DELETE_TYPE','SET_TYPE_ACTIVE','SAVE_ROOM','SET_ROOM_ACTIVE','PUBLISH_RATES') THEN
    RAISE EXCEPTION 'unsupported catalog action' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM inventory_units AS unit WHERE unit.property_id = execution.property_id AND unit.room_type_code IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(approved_effect#>'{after,types}') AS type WHERE type->>'code' = unit.room_type_code)) THEN
    RAISE EXCEPTION 'referenced room types must be retained' USING ERRCODE = '23514';
  END IF;
  IF state.version IS NOT NULL AND EXISTS (SELECT 1 FROM jsonb_array_elements(state.snapshot->'rates') AS old_rate
    WHERE NOT (approved_effect#>'{after,rates}') @> jsonb_build_array(old_rate)) THEN
    RAISE EXCEPTION 'published rate history is immutable' USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(array_agg(value), '{}'::text[]) INTO retiring FROM jsonb_array_elements_text(approved_effect->'retireUnitIds');
  IF (SELECT count(*) FROM inventory_units WHERE id = ANY(retiring) AND property_id = execution.property_id) <> cardinality(retiring) THEN
    RAISE EXCEPTION 'retiring inventory outside property' USING ERRCODE = '23514';
  END IF;
  SELECT array_agg(DISTINCT COALESCE(parent_room_id, id)), array_agg(DISTINCT room_type_code)
  INTO room_ids, affected_types FROM inventory_units WHERE id = ANY(retiring);
  PERFORM id FROM inventory_units WHERE id = ANY(room_ids) OR parent_room_id = ANY(room_ids) ORDER BY id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM inventory_claims WHERE room_id = ANY(room_ids) AND active)
    OR EXISTS (SELECT 1 FROM coverage_items WHERE inventory_unit_id = ANY(retiring) AND status = 'HELD')
    OR EXISTS (SELECT 1 FROM stay_segments AS segment JOIN stays AS stay ON stay.id = segment.stay_id
      JOIN orders AS booking ON booking.id = stay.order_id WHERE segment.inventory_unit_id = ANY(retiring) AND booking.status IN ('RESERVED','CHECKED_IN'))
    OR EXISTS (SELECT 1 FROM maintenance_locks WHERE inventory_unit_id = ANY(retiring) AND status = 'ACTIVE')
    OR EXISTS (SELECT 1 FROM internal_use_blocks WHERE room_id = ANY(room_ids) AND status = 'ACTIVE') THEN
    RAISE EXCEPTION 'catalog change conflicts with active bookings, claims or entitlements' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM inventory_units WHERE (id = ANY(room_ids) OR parent_room_id = ANY(room_ids)) AND NOT (id = ANY(retiring))) THEN
    RAISE EXCEPTION 'catalog retirement must include the whole room and all its children' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM membership_orders AS membership JOIN properties AS property ON property.id = membership.property_id
    WHERE membership.property_id = execution.property_id AND membership.allowed_room_type_code = ANY(affected_types)
      AND membership.status = 'ACTIVE' AND membership.valid_until > (clock_timestamp() AT TIME ZONE property.timezone)::date
      AND NOT EXISTS (SELECT 1 FROM inventory_units WHERE property_id = execution.property_id AND active AND kind = 'ROOM'
        AND room_type_code = membership.allowed_room_type_code AND NOT (id = ANY(retiring)))
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(approved_effect->'insertUnits') AS replacement
        WHERE replacement->>'kind' = 'ROOM' AND replacement->>'room_type_code' = membership.allowed_room_type_code)) THEN
    RAISE EXCEPTION 'cannot remove the last room available to a live membership contract' USING ERRCODE = '23514';
  END IF;
  IF action_name NOT IN ('SAVE_ROOM','SET_ROOM_ACTIVE','SET_TYPE_ACTIVE') AND cardinality(retiring) > 0 THEN
    RAISE EXCEPTION 'action cannot retire inventory' USING ERRCODE = '23514';
  END IF;
  UPDATE inventory_units SET active = false WHERE id = ANY(retiring);
  FOR item IN SELECT value FROM jsonb_array_elements(approved_effect->'insertUnits') LOOP
    IF action_name NOT IN ('SAVE_ROOM','SET_ROOM_ACTIVE') OR item->>'property_id' IS DISTINCT FROM execution.property_id
      OR item->>'active' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'invalid catalog inventory insertion' USING ERRCODE = '23514'; END IF;
    SELECT value INTO room_type FROM jsonb_array_elements(approved_effect#>'{after,types}') WHERE value->>'code' = item->>'room_type_code';
    IF room_type IS NULL OR room_type->>'active' IS DISTINCT FROM 'true'
      OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(room_type->'products') AS product
        WHERE product->>'code' = item->>'pricing_product_code' AND product->>'kind' = item->>'kind') THEN
      RAISE EXCEPTION 'inventory must use an active room type and its declared price product' USING ERRCODE = '23514';
    END IF;
    IF item->>'kind' = 'ROOM' THEN
      IF target_room IS NOT NULL OR item->>'parent_room_id' IS NOT NULL THEN RAISE EXCEPTION 'one room per structure change' USING ERRCODE = '23514'; END IF;
      target_room := item->>'id';
      IF room_type->>'saleMode' = 'BED' AND (
        (item->>'physical_bed_count')::integer IS DISTINCT FROM (item->>'occupancy_capacity')::integer
        OR item->>'inventory_basis' IS DISTINCT FROM 'WHOLE_ROOM_COMBINATION'
        OR (SELECT count(*) FROM jsonb_array_elements(approved_effect->'insertUnits') AS bed WHERE bed->>'kind' = 'BED')
           IS DISTINCT FROM (item->>'physical_bed_count')::bigint) THEN
        RAISE EXCEPTION 'bed-sale room must include its complete bed set' USING ERRCODE = '23514';
      END IF;
      IF room_type->>'saleMode' = 'ROOM' AND (item->>'inventory_basis' IS DISTINCT FROM 'INDEPENDENT'
        OR jsonb_array_length(approved_effect->'insertUnits') <> 1) THEN RAISE EXCEPTION 'whole-room sale cannot add sellable beds' USING ERRCODE = '23514'; END IF;
    ELSIF item->>'parent_room_id' IS DISTINCT FROM target_room OR (item->>'occupancy_capacity')::integer <> 1 THEN
      RAISE EXCEPTION 'bed must belong to the new room' USING ERRCODE = '23514';
    END IF;
    INSERT INTO inventory_units(id, property_id, kind, parent_room_id, code, name, active, catalog_version, building_code,
      room_type_code, pricing_product_code, inventory_basis, code_provenance, physical_bed_count, occupancy_capacity)
    VALUES(item->>'id', execution.property_id, item->>'kind', item->>'parent_room_id', item->>'code', item->>'name', true,
      item->>'catalog_version', item->>'building_code', item->>'room_type_code', item->>'pricing_product_code', item->>'inventory_basis',
      'PMS_GENERATED', (item->>'physical_bed_count')::integer, (item->>'occupancy_capacity')::integer);
  END LOOP;
  IF target_room IS NOT NULL THEN
    IF approved_effect#>>'{roomLink,newUnitId}' IS DISTINCT FROM target_room THEN RAISE EXCEPTION 'room link mismatch' USING ERRCODE = '23514'; END IF;
    IF NOT EXISTS (SELECT 1 FROM inventory_units WHERE id = approved_effect#>>'{roomLink,assetId}'
      AND property_id = execution.property_id AND kind = 'ROOM')
      OR (approved_effect#>>'{roomLink,oldUnitId}' IS NULL AND approved_effect#>>'{roomLink,assetId}' IS DISTINCT FROM target_room)
      OR (approved_effect#>>'{roomLink,oldUnitId}' IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM inventory_units AS old_unit LEFT JOIN room_catalog_links AS link ON link.unit_id = old_unit.id
        WHERE old_unit.id = approved_effect#>>'{roomLink,oldUnitId}' AND old_unit.kind = 'ROOM'
          AND COALESCE(link.asset_id, old_unit.id) = approved_effect#>>'{roomLink,assetId}')) THEN
      RAISE EXCEPTION 'physical room identity cannot be reassigned' USING ERRCODE = '23514';
    END IF;
    IF approved_effect#>>'{roomLink,oldUnitId}' IS NOT NULL THEN
      IF NOT (approved_effect#>>'{roomLink,oldUnitId}' = ANY(retiring)) THEN RAISE EXCEPTION 'old room must be retired' USING ERRCODE = '23514'; END IF;
      INSERT INTO room_catalog_links(unit_id, asset_id, version)
      VALUES(approved_effect#>>'{roomLink,oldUnitId}', approved_effect#>>'{roomLink,assetId}', 0) ON CONFLICT(unit_id) DO NOTHING;
    END IF;
    INSERT INTO room_catalog_links(unit_id, asset_id, version)
    VALUES(target_room, approved_effect#>>'{roomLink,assetId}', after_version);
  END IF;
  SELECT currency INTO property_currency FROM properties WHERE id = execution.property_id;
  SELECT COALESCE(max(version), 0) INTO next_policy_version FROM pricing_policy_versions
  WHERE property_id = execution.property_id AND code = 'MANAGED_ROOM_PRICES';
  FOR policy IN SELECT value FROM jsonb_array_elements(approved_effect->'policies') LOOP
    IF action_name NOT IN ('SAVE_ROOM','SET_ROOM_ACTIVE','PUBLISH_RATES') THEN RAISE EXCEPTION 'action cannot publish policies' USING ERRCODE = '23514'; END IF;
    next_policy_version := next_policy_version + 1;
    INSERT INTO pricing_policy_versions(id, property_id, code, version, stay_type, calculation_kind, nightly_rate_minor,
      currency, status, product_anchor_rates_minor, effective_from, effective_until, rounding_rule)
    VALUES(policy->>'id', execution.property_id, 'MANAGED_ROOM_PRICES', next_policy_version, NULL, 'DURATION_BAND_TOTAL', NULL,
      property_currency, 'PUBLISHED', policy->'anchors', (policy->>'effectiveFrom')::date, NULL, 'FINAL_TOTAL_WHOLE_YUAN_HALF_UP');
    INSERT INTO room_catalog_heads(property_id, effective_from, policy_id)
    VALUES(execution.property_id, (policy->>'effectiveFrom')::date, policy->>'id')
    ON CONFLICT(property_id, effective_from) DO UPDATE SET policy_id = EXCLUDED.policy_id;
  END LOOP;
  INSERT INTO room_catalog_state(property_id, version, snapshot) VALUES(execution.property_id, after_version, approved_effect->'after')
  ON CONFLICT(property_id) DO UPDATE SET version = EXCLUDED.version, snapshot = EXCLUDED.snapshot;
  INSERT INTO room_catalog_changes(id, property_id, command_id, effect, reason) VALUES(change_id, execution.property_id, target_command, approved_effect, reason_note);
  RETURN change_id;
END $$;
REVOKE ALL ON FUNCTION qintopia_apply_room_catalog(text,jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION qintopia_apply_room_catalog(text,jsonb,text) TO qintopia_runtime;

CREATE FUNCTION qintopia_catalog_commit_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE command_row command_executions%ROWTYPE; change room_catalog_changes%ROWTYPE;
BEGIN
  SELECT * INTO command_row FROM command_executions WHERE id = CASE WHEN TG_TABLE_NAME = 'command_executions' THEN NEW.id ELSE to_jsonb(NEW)->>'command_id' END;
  IF command_row.command_type <> 'MANAGE_ROOM_CATALOG' THEN RETURN NEW; END IF;
  SELECT * INTO change FROM room_catalog_changes WHERE command_id = command_row.id;
  IF command_row.state <> 'APPLIED' AND change.id IS NULL THEN RETURN NEW; END IF;
  IF command_row.state IS DISTINCT FROM 'APPLIED' OR change.id IS NULL
    OR NOT EXISTS (SELECT 1 FROM command_receipts WHERE command_id = command_row.id AND business_committed
      AND execution_status = 'EXECUTED' AND result = change.effect || jsonb_build_object('changeId', change.id))
    OR NOT EXISTS (SELECT 1 FROM audit_entries WHERE command_id = command_row.id AND decision = 'ALLOWED'
      AND action = command_row.command_type AND reason->>'note' = change.reason
      AND EXISTS (SELECT 1 FROM command_previews WHERE id = metadata->>'previewId' AND status = 'USED' AND effect = change.effect)) THEN
    RAISE EXCEPTION 'catalog command requires matching change, receipt and audit' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER command_executions_catalog_guard AFTER INSERT OR UPDATE ON command_executions
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_catalog_commit_guard();
CREATE CONSTRAINT TRIGGER room_catalog_changes_commit_guard AFTER INSERT ON room_catalog_changes
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_catalog_commit_guard();
REVOKE ALL ON FUNCTION qintopia_catalog_commit_guard() FROM PUBLIC;

DO $$ DECLARE definition text;
BEGIN
  SELECT pg_get_functiondef('qintopia_guard_runtime_mutable_projection_update()'::regprocedure) INTO definition;
  IF position('''CREATE_ORDER'', ''CORRECT_ORDER_OCCUPANT'',' IN definition) = 0 THEN RAISE EXCEPTION 'catalog room-status allowlist not recognized'; END IF;
  EXECUTE replace(definition, '''CREATE_ORDER'', ''CORRECT_ORDER_OCCUPANT'',', '''CREATE_ORDER'', ''CORRECT_ORDER_OCCUPANT'', ''MANAGE_ROOM_CATALOG'',');
END $$;
