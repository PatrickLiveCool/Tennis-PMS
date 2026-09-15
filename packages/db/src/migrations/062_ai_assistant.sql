CREATE TABLE ai_model_settings (
  scope_id text PRIMARY KEY CHECK (scope_id = 'installation'),
  management_property_id text NOT NULL REFERENCES properties(id),
  version integer NOT NULL CHECK (version > 0),
  enabled boolean NOT NULL,
  base_url text NOT NULL,
  model text NOT NULL,
  encrypted_key text NOT NULL,
  updated_by text NOT NULL REFERENCES subjects(id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE ai_settings_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  scope_id text NOT NULL,
  version integer NOT NULL,
  actor_subject_id text NOT NULL REFERENCES subjects(id),
  property_id text NOT NULL REFERENCES properties(id),
  enabled boolean NOT NULL,
  base_url text NOT NULL,
  model text NOT NULL,
  key_replaced boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER ai_settings_audit_append_only BEFORE UPDATE OR DELETE ON ai_settings_audit
FOR EACH ROW EXECUTE FUNCTION qintopia_prevent_fact_mutation();
REVOKE ALL ON ai_model_settings, ai_settings_audit FROM PUBLIC, qintopia_runtime;
GRANT SELECT ON ai_model_settings, ai_settings_audit TO qintopia_runtime;

CREATE FUNCTION qintopia_save_ai_settings(actor_id text, session_id text, property_id text, expected_version integer,
  new_enabled boolean, new_base_url text, new_model text, new_encrypted_key text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE current_settings ai_model_settings; next_version integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('qintopia:ai-settings:installation', 0));
  PERFORM 1 FROM subjects s JOIN web_sessions w ON w.subject_id = s.id
    JOIN subject_property_grants g ON g.subject_id = s.id
    JOIN staff_profile_assignments p ON p.subject_id = s.id AND p.property_id = g.property_id
    WHERE s.id = actor_id AND s.status = 'ACTIVE' AND w.id = session_id
      AND w.revoked_at IS NULL AND w.expires_at > clock_timestamp()
      AND g.property_id = qintopia_save_ai_settings.property_id AND g.access_level = 'WRITE' AND p.profile = 'ADMIN'
    FOR SHARE OF s, w, g, p;
  IF NOT FOUND THEN RAISE EXCEPTION 'AI_FORBIDDEN'; END IF;
  SELECT * INTO current_settings FROM ai_model_settings WHERE scope_id = 'installation' FOR UPDATE;
  IF current_settings.scope_id IS NOT NULL AND current_settings.management_property_id <> property_id THEN RAISE EXCEPTION 'AI_FORBIDDEN'; END IF;
  IF coalesce(current_settings.version, 0) <> expected_version THEN RAISE EXCEPTION 'AI_STALE'; END IF;
  IF new_base_url !~ '^https://' OR length(new_base_url) > 2048 OR length(new_model) NOT BETWEEN 1 AND 120
    OR new_encrypted_key IS NOT NULL AND length(new_encrypted_key) > 10000 THEN RAISE EXCEPTION 'AI_INVALID'; END IF;
  IF (current_settings.scope_id IS NULL OR current_settings.base_url <> new_base_url) AND new_encrypted_key IS NULL THEN RAISE EXCEPTION 'AI_KEY_REQUIRED'; END IF;
  next_version := expected_version + 1;
  INSERT INTO ai_model_settings VALUES ('installation', property_id, next_version, new_enabled, new_base_url, new_model,
    coalesce(new_encrypted_key, current_settings.encrypted_key), actor_id, clock_timestamp())
  ON CONFLICT (scope_id) DO UPDATE SET version = excluded.version, enabled = excluded.enabled, base_url = excluded.base_url,
    model = excluded.model, encrypted_key = excluded.encrypted_key, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  INSERT INTO ai_settings_audit(scope_id, version, actor_subject_id, property_id, enabled, base_url, model, key_replaced)
    VALUES ('installation', next_version, actor_id, property_id, new_enabled, new_base_url, new_model, new_encrypted_key IS NOT NULL);
  RETURN next_version;
END;
$$;
REVOKE ALL ON FUNCTION qintopia_save_ai_settings(text,text,text,integer,boolean,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION qintopia_save_ai_settings(text,text,text,integer,boolean,text,text,text) TO qintopia_runtime;
