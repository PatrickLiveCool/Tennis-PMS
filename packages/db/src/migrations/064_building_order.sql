-- Building display order is stored in the existing per-property catalog snapshot.
-- 062/063 are reserved by the parallel AI assistant branch.
DO $migration$
DECLARE definition text;
BEGIN
  IF (SELECT encode(sha256(convert_to(prosrc, 'UTF8')), 'hex') FROM pg_proc
      WHERE oid = 'qintopia_apply_room_catalog(text,jsonb,text)'::regprocedure)
      <> '23cec734e2202a964ffbfbcad1955a5cc49248fad515fc7da38badbc2f13405a' THEN
    RAISE EXCEPTION 'unrecognized room catalog boundary';
  END IF;
  SELECT pg_get_functiondef('qintopia_apply_room_catalog(text,jsonb,text)'::regprocedure) INTO definition;
  definition := replace(definition, $old$action_name NOT IN ('SAVE_TYPE','DELETE_TYPE','SET_TYPE_ACTIVE','SAVE_ROOM','SET_ROOM_ACTIVE','PUBLISH_RATES') THEN$old$, $new$action_name NOT IN ('SAVE_TYPE','DELETE_TYPE','SET_TYPE_ACTIVE','SAVE_ROOM','SET_ROOM_ACTIVE','PUBLISH_RATES','SET_BUILDING_ORDER') THEN$new$);
  definition := replace(definition, $old$  IF EXISTS (SELECT 1 FROM inventory_units AS unit WHERE unit.property_id = execution.property_id AND unit.room_type_code IS NOT NULL$old$, $new$  IF action_name = 'SET_BUILDING_ORDER' THEN
    IF jsonb_typeof(approved_effect#>'{after,buildingOrder}') IS DISTINCT FROM 'array'
      OR approved_effect->'retireUnitIds' IS DISTINCT FROM '[]'::jsonb
      OR approved_effect->'insertUnits' IS DISTINCT FROM '[]'::jsonb
      OR approved_effect->'policies' IS DISTINCT FROM '[]'::jsonb
      OR approved_effect->'roomLink' IS DISTINCT FROM 'null'::jsonb
      OR (state.version IS NOT NULL AND (approved_effect#>'{after,types}' IS DISTINCT FROM state.snapshot->'types'
        OR approved_effect#>'{after,rates}' IS DISTINCT FROM state.snapshot->'rates')) THEN
      RAISE EXCEPTION 'building order cannot change inventory or pricing' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(approved_effect#>'{after,buildingOrder}') AS code
        WHERE jsonb_typeof(code) <> 'string' OR btrim(code#>>'{}') = '')
      OR (SELECT count(*) <> count(DISTINCT code) FROM jsonb_array_elements_text(approved_effect#>'{after,buildingOrder}') AS code)
      OR EXISTS (SELECT 1 FROM inventory_units AS unit
        WHERE unit.property_id = execution.property_id AND unit.kind = 'ROOM' AND COALESCE(unit.building_code, '') <> ''
          AND NOT (approved_effect#>'{after,buildingOrder}') ? unit.building_code)
      OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(approved_effect#>'{after,buildingOrder}') AS ordered(code)
        WHERE NOT EXISTS (SELECT 1 FROM inventory_units AS unit
          WHERE unit.property_id = execution.property_id AND unit.kind = 'ROOM' AND unit.building_code = ordered.code)) THEN
      RAISE EXCEPTION 'building order must contain each property building exactly once' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM inventory_units AS unit WHERE unit.property_id = execution.property_id AND unit.room_type_code IS NOT NULL$new$);
  EXECUTE definition;
END $migration$;
