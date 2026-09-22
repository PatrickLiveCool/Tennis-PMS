-- Independent, redacted analytics. No raw actor, order, context or tool payloads.
-- Request IDs provide idempotency, without coupling retention to chat records.
CREATE TABLE tennis.ai_question_records (
  id text PRIMARY KEY CHECK (length(btrim(id)) BETWEEN 1 AND 200),
  tenant_id text NOT NULL REFERENCES tennis.tenants(id) ON DELETE CASCADE,
  venue_id text NOT NULL,
  conversation_id text NOT NULL CHECK (length(btrim(conversation_id)) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(created_at)),
  recorded_day date GENERATED ALWAYS AS ((created_at AT TIME ZONE 'UTC')::date) STORED,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(updated_at)),
  question_redacted text NOT NULL CHECK (length(question_redacted) BETWEEN 1 AND 8000 AND length(btrim(question_redacted)) > 0),
  redaction_version integer NOT NULL DEFAULT 1 CHECK (redaction_version = 1),
  source text NOT NULL CHECK (source IN ('USER','SUGGESTION','UNKNOWN')),
  page text NOT NULL CHECK (page IN ('schedule','orders','members','settings','unknown')),
  topic text NOT NULL CHECK (topic IN ('BOOKING','RESCHEDULING','CANCELLATION','REFUND','PAYMENT','MEMBERSHIP','PRICING','AVAILABILITY','ORDER_QUERY','SYSTEM_HELP','OTHER')),
  application_version text NOT NULL CHECK (length(btrim(application_version)) BETWEEN 1 AND 80),
  outcome text NOT NULL DEFAULT 'PENDING' CHECK (outcome IN ('PENDING','ANSWERED','FAILED','INTERRUPTED')),
  error_code text CHECK (error_code IN ('ASSISTANT_UNAVAILABLE','REQUEST_INTERRUPTED','ASSISTANT_TIMEOUT','TENANT_ACCESS_DENIED','RESOURCE_NOT_FOUND','BACKOFFICE_ASSISTANT_NOT_CONFIGURED','BACKOFFICE_MODEL_CONNECTION_NOT_ENABLED')),
  tools_used text[] NOT NULL DEFAULT '{}' CHECK (
    cardinality(tools_used) <= 8 AND
    array_position(tools_used, NULL) IS NULL AND
    tools_used <@ ARRAY['get_work_context','get_discounts','prepare_booking','prepare_order_action','get_courts','get_schedule','get_current_order','open_page']::text[]
  ),
  duration_ms integer CHECK (duration_ms BETWEEN 0 AND 600000),
  feedback text NOT NULL DEFAULT 'UNKNOWN' CHECK (feedback IN ('UNKNOWN','RESOLVED','UNRESOLVED')),
  CHECK (feedback = 'UNKNOWN' OR outcome = 'ANSWERED'),
  FOREIGN KEY (tenant_id,venue_id) REFERENCES tennis.venues(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX ai_question_records_expiry ON tennis.ai_question_records(created_at);
CREATE INDEX ai_question_records_scope_export ON tennis.ai_question_records(tenant_id,venue_id,recorded_day,id);

CREATE TABLE tennis.ai_question_daily (
  tenant_id text NOT NULL REFERENCES tennis.tenants(id) ON DELETE CASCADE,
  venue_id text NOT NULL,
  recorded_day date NOT NULL,
  topic text NOT NULL,
  source text NOT NULL,
  question_count bigint NOT NULL DEFAULT 0,
  answered_count bigint NOT NULL DEFAULT 0,
  failed_count bigint NOT NULL DEFAULT 0,
  interrupted_count bigint NOT NULL DEFAULT 0,
  pending_count bigint NOT NULL DEFAULT 0,
  resolved_count bigint NOT NULL DEFAULT 0,
  unresolved_count bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,venue_id,recorded_day,topic,source),
  FOREIGN KEY (tenant_id,venue_id) REFERENCES tennis.venues(tenant_id,id) ON DELETE CASCADE,
  CHECK (question_count = answered_count + failed_count + interrupted_count + pending_count),
  CHECK (answered_count >= 0 AND failed_count >= 0 AND interrupted_count >= 0 AND pending_count >= 0),
  CHECK (resolved_count >= 0 AND unresolved_count >= 0 AND resolved_count + unresolved_count <= answered_count)
);

CREATE FUNCTION tennis.ai_question_rollup() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, tennis AS $$
DECLARE old_outcome text := ''; old_feedback text := ''; added integer := 1;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.id,NEW.tenant_id,NEW.venue_id,NEW.conversation_id,NEW.created_at,NEW.question_redacted,
        NEW.redaction_version,NEW.source,NEW.page,NEW.topic,NEW.application_version)
      IS DISTINCT FROM
       (OLD.id,OLD.tenant_id,OLD.venue_id,OLD.conversation_id,OLD.created_at,OLD.question_redacted,
        OLD.redaction_version,OLD.source,OLD.page,OLD.topic,OLD.application_version)
      THEN RAISE EXCEPTION 'AI_QUESTION_IMMUTABLE'; END IF;
    old_outcome := OLD.outcome; old_feedback := OLD.feedback; added := 0;
  END IF;
  INSERT INTO tennis.ai_question_daily(tenant_id,venue_id,recorded_day,topic,source,
    question_count,answered_count,failed_count,interrupted_count,pending_count,resolved_count,unresolved_count)
  VALUES (NEW.tenant_id,NEW.venue_id,NEW.recorded_day,NEW.topic,NEW.source,1,
    (NEW.outcome='ANSWERED')::int,(NEW.outcome='FAILED')::int,(NEW.outcome='INTERRUPTED')::int,(NEW.outcome='PENDING')::int,
    (NEW.feedback='RESOLVED')::int,(NEW.feedback='UNRESOLVED')::int)
  ON CONFLICT (tenant_id,venue_id,recorded_day,topic,source) DO UPDATE SET
    question_count = ai_question_daily.question_count + added,
    answered_count = ai_question_daily.answered_count + (NEW.outcome='ANSWERED')::int - (old_outcome='ANSWERED')::int,
    failed_count = ai_question_daily.failed_count + (NEW.outcome='FAILED')::int - (old_outcome='FAILED')::int,
    interrupted_count = ai_question_daily.interrupted_count + (NEW.outcome='INTERRUPTED')::int - (old_outcome='INTERRUPTED')::int,
    pending_count = ai_question_daily.pending_count + (NEW.outcome='PENDING')::int - (old_outcome='PENDING')::int,
    resolved_count = ai_question_daily.resolved_count + (NEW.feedback='RESOLVED')::int - (old_feedback='RESOLVED')::int,
    unresolved_count = ai_question_daily.unresolved_count + (NEW.feedback='UNRESOLVED')::int - (old_feedback='UNRESOLVED')::int,
    updated_at = clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER ai_question_rollup AFTER INSERT OR UPDATE ON tennis.ai_question_records
FOR EACH ROW EXECUTE FUNCTION tennis.ai_question_rollup();

CREATE TABLE tennis.ai_question_reader_grants (
  login_role name NOT NULL CHECK (length(btrim(login_role::text)) > 0),
  tenant_id text NOT NULL REFERENCES tennis.tenants(id) ON DELETE CASCADE,
  venue_id text NOT NULL,
  PRIMARY KEY (login_role,tenant_id,venue_id),
  FOREIGN KEY (tenant_id,venue_id) REFERENCES tennis.venues(tenant_id,id) ON DELETE CASCADE
);

-- View-owner access is intentional: readers cannot read either base table or
-- the grants. session_user preserves the login identity across SET ROLE.
CREATE VIEW tennis.ai_question_export WITH (security_barrier=true) AS
SELECT q.id,q.tenant_id,q.venue_id,q.conversation_id,q.created_at,q.recorded_day,q.updated_at,
  q.question_redacted,q.redaction_version,q.source,q.page,q.topic,q.application_version,
  q.outcome,q.error_code,q.tools_used,q.duration_ms,q.feedback
FROM tennis.ai_question_records q
WHERE q.created_at > CURRENT_TIMESTAMP - interval '90 days'
  AND EXISTS (SELECT 1 FROM tennis.ai_question_reader_grants g
    WHERE g.login_role = session_user AND g.tenant_id=q.tenant_id AND g.venue_id=q.venue_id);

CREATE VIEW tennis.ai_question_daily_export WITH (security_barrier=true) AS
SELECT q.tenant_id,q.venue_id,q.recorded_day,q.topic,q.source,q.question_count,q.answered_count,
  q.failed_count,q.interrupted_count,q.pending_count,q.resolved_count,q.unresolved_count,q.updated_at
FROM tennis.ai_question_daily q
WHERE EXISTS (SELECT 1 FROM tennis.ai_question_reader_grants g
  WHERE g.login_role = session_user AND g.tenant_id=q.tenant_id AND g.venue_id=q.venue_id);

CREATE FUNCTION tennis.maintain_ai_questions() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, tennis AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('tennis:ai-questions-maintenance',0));
  UPDATE tennis.ai_question_records SET outcome='INTERRUPTED',error_code='REQUEST_INTERRUPTED',updated_at=clock_timestamp()
    WHERE outcome='PENDING' AND created_at <= clock_timestamp() - interval '10 minutes';
  -- No DELETE trigger: lifetime rollups survive expiry of redacted details.
  DELETE FROM tennis.ai_question_records WHERE created_at <= clock_timestamp() - interval '90 days';
END;
$$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='tennis_ai_analytics_reader') THEN
    CREATE ROLE tennis_ai_analytics_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  ELSIF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='tennis_ai_analytics_reader'
    AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN
    RAISE EXCEPTION 'AI_ANALYTICS_ROLE_UNSAFE';
  END IF;
END $$;
REVOKE ALL ON tennis.ai_question_records,tennis.ai_question_daily,tennis.ai_question_reader_grants,
  tennis.ai_question_export,tennis.ai_question_daily_export FROM PUBLIC,tennis_ai_analytics_reader;
REVOKE ALL ON FUNCTION tennis.ai_question_rollup(),tennis.maintain_ai_questions() FROM PUBLIC,tennis_ai_analytics_reader;
GRANT USAGE ON SCHEMA tennis TO tennis_ai_analytics_reader;
GRANT SELECT ON tennis.ai_question_export,tennis.ai_question_daily_export TO tennis_ai_analytics_reader;
-- No LOGIN, password or membership is provisioned by this migration.
