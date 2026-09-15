-- Only redacted question text is persisted. Internal actor/session identifiers are never exported.
CREATE TABLE ai_question_records (
  id text PRIMARY KEY,
  property_id text NOT NULL REFERENCES properties(id),
  actor_subject_id text NOT NULL,
  actor_session_id text NOT NULL,
  conversation_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  recorded_day date GENERATED ALWAYS AS ((created_at AT TIME ZONE 'UTC')::date) STORED,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  question_redacted text NOT NULL CHECK (length(question_redacted) BETWEEN 1 AND 8000),
  redaction_version integer NOT NULL DEFAULT 1 CHECK (redaction_version = 1),
  source text NOT NULL CHECK (source IN ('USER', 'SUGGESTION', 'UNKNOWN')),
  page text NOT NULL CHECK (page IN ('inventory', 'orders', 'order', 'members', 'today', 'settings', 'unknown')),
  topic text NOT NULL CHECK (topic IN ('STAY_EXTENSION', 'MOVE_ROOM', 'MEMBERSHIP', 'PAYMENT', 'CANCELLATION', 'AVAILABILITY', 'ORDER_QUERY', 'SYSTEM_HELP', 'OTHER')),
  application_version text NOT NULL CHECK (length(application_version) BETWEEN 1 AND 80),
  outcome text NOT NULL DEFAULT 'PENDING' CHECK (outcome IN ('PENDING', 'ANSWERED', 'FAILED', 'INTERRUPTED')),
  error_code text CHECK (error_code ~ '^[A-Z0-9_]{1,80}$'),
  tools_used text[] NOT NULL DEFAULT '{}',
  duration_ms integer CHECK (duration_ms BETWEEN 0 AND 600000),
  feedback text NOT NULL DEFAULT 'UNKNOWN' CHECK (feedback IN ('UNKNOWN', 'RESOLVED', 'UNRESOLVED')),
  CHECK (feedback = 'UNKNOWN' OR outcome = 'ANSWERED'),
  CHECK (tools_used <@ ARRAY['search_orders', 'search_members', 'availability', 'order_details', 'open_entry']::text[])
);
CREATE INDEX ai_question_records_expiry ON ai_question_records(created_at);
CREATE INDEX ai_question_records_property_export ON ai_question_records(property_id, recorded_day, id);

CREATE TABLE ai_question_daily (
  property_id text NOT NULL REFERENCES properties(id),
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
  PRIMARY KEY (property_id, recorded_day, topic, source),
  CHECK (question_count = answered_count + failed_count + interrupted_count + pending_count),
  CHECK (answered_count >= 0 AND failed_count >= 0 AND interrupted_count >= 0 AND pending_count >= 0),
  CHECK (resolved_count >= 0 AND unresolved_count >= 0 AND resolved_count + unresolved_count <= answered_count)
);

CREATE FUNCTION qintopia_ai_question_rollup() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE old_outcome text := ''; old_feedback text := ''; added integer := 1;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.id, NEW.property_id, NEW.actor_subject_id, NEW.actor_session_id, NEW.conversation_id, NEW.created_at, NEW.topic, NEW.source, NEW.question_redacted, NEW.page, NEW.application_version, NEW.redaction_version)
      IS DISTINCT FROM (OLD.id, OLD.property_id, OLD.actor_subject_id, OLD.actor_session_id, OLD.conversation_id, OLD.created_at, OLD.topic, OLD.source, OLD.question_redacted, OLD.page, OLD.application_version, OLD.redaction_version)
      THEN RAISE EXCEPTION 'AI_QUESTION_IMMUTABLE'; END IF;
    old_outcome := OLD.outcome; old_feedback := OLD.feedback; added := 0;
  END IF;
  INSERT INTO ai_question_daily(property_id, recorded_day, topic, source, question_count, answered_count, failed_count, interrupted_count, pending_count, resolved_count, unresolved_count)
  VALUES (NEW.property_id, NEW.recorded_day, NEW.topic, NEW.source, 1,
    (NEW.outcome = 'ANSWERED')::int, (NEW.outcome = 'FAILED')::int, (NEW.outcome = 'INTERRUPTED')::int, (NEW.outcome = 'PENDING')::int,
    (NEW.feedback = 'RESOLVED')::int, (NEW.feedback = 'UNRESOLVED')::int)
  ON CONFLICT (property_id, recorded_day, topic, source) DO UPDATE SET
    question_count = ai_question_daily.question_count + added,
    answered_count = ai_question_daily.answered_count + (NEW.outcome = 'ANSWERED')::int - (old_outcome = 'ANSWERED')::int,
    failed_count = ai_question_daily.failed_count + (NEW.outcome = 'FAILED')::int - (old_outcome = 'FAILED')::int,
    interrupted_count = ai_question_daily.interrupted_count + (NEW.outcome = 'INTERRUPTED')::int - (old_outcome = 'INTERRUPTED')::int,
    pending_count = ai_question_daily.pending_count + (NEW.outcome = 'PENDING')::int - (old_outcome = 'PENDING')::int,
    resolved_count = ai_question_daily.resolved_count + (NEW.feedback = 'RESOLVED')::int - (old_feedback = 'RESOLVED')::int,
    unresolved_count = ai_question_daily.unresolved_count + (NEW.feedback = 'UNRESOLVED')::int - (old_feedback = 'UNRESOLVED')::int,
    updated_at = clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER ai_question_rollup AFTER INSERT OR UPDATE ON ai_question_records
FOR EACH ROW EXECUTE FUNCTION qintopia_ai_question_rollup();

CREATE FUNCTION qintopia_begin_ai_question(question_id text, actor_id text, session_id text, property_id text,
  conversation_id text, question_text text, question_source text, question_page text, question_topic text, app_version text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('qintopia:ai-questions', 0));
  PERFORM 1 FROM subjects s JOIN web_sessions w ON w.subject_id = s.id JOIN subject_property_grants g ON g.subject_id = s.id
    WHERE s.id = actor_id AND s.status = 'ACTIVE' AND w.id = session_id AND w.revoked_at IS NULL AND w.expires_at > clock_timestamp()
      AND g.property_id = qintopia_begin_ai_question.property_id
    FOR SHARE OF s, w, g;
  IF NOT FOUND THEN RAISE EXCEPTION 'AI_QUESTION_FORBIDDEN'; END IF;
  INSERT INTO ai_question_records(id, actor_subject_id, actor_session_id, property_id, conversation_id,
    question_redacted, source, page, topic, application_version)
  VALUES (question_id, actor_id, session_id, property_id, conversation_id, question_text, question_source, question_page, question_topic, app_version);
END;
$$;

-- Finish is allowed after revocation: it only closes the already-authorized event, and never returns its text.
CREATE FUNCTION qintopia_finish_ai_question(question_id text, actor_id text, session_id text, result text,
  failure_code text, used_tools text[], elapsed_ms integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('qintopia:ai-questions', 0));
  IF result NOT IN ('ANSWERED', 'FAILED') THEN RAISE EXCEPTION 'AI_QUESTION_INVALID'; END IF;
  UPDATE ai_question_records SET outcome = result, error_code = failure_code, tools_used = used_tools,
    duration_ms = elapsed_ms, updated_at = clock_timestamp()
    WHERE id = question_id AND actor_subject_id = actor_id AND actor_session_id = session_id AND outcome = 'PENDING'
      AND created_at > clock_timestamp() - interval '10 minutes';
END;
$$;

CREATE FUNCTION qintopia_feedback_ai_question(question_id text, actor_id text, session_id text, property_id text, new_feedback text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('qintopia:ai-questions', 0));
  IF new_feedback NOT IN ('RESOLVED', 'UNRESOLVED') THEN RAISE EXCEPTION 'AI_QUESTION_INVALID'; END IF;
  PERFORM 1 FROM subjects s JOIN web_sessions w ON w.subject_id = s.id JOIN subject_property_grants g ON g.subject_id = s.id
    WHERE s.id = actor_id AND s.status = 'ACTIVE' AND w.id = session_id AND w.revoked_at IS NULL AND w.expires_at > clock_timestamp()
      AND g.property_id = qintopia_feedback_ai_question.property_id
    FOR SHARE OF s, w, g;
  IF NOT FOUND THEN RAISE EXCEPTION 'AI_QUESTION_FORBIDDEN'; END IF;
  PERFORM 1 FROM ai_question_records WHERE id = question_id AND actor_subject_id = actor_id
    AND ai_question_records.property_id = qintopia_feedback_ai_question.property_id AND outcome = 'ANSWERED'
    AND created_at > clock_timestamp() - interval '90 days' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AI_QUESTION_NOT_FOUND'; END IF;
  UPDATE ai_question_records SET feedback = new_feedback, updated_at = clock_timestamp()
    WHERE id = question_id AND feedback <> new_feedback;
END;
$$;

CREATE FUNCTION qintopia_maintain_ai_questions() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('qintopia:ai-questions', 0));
  UPDATE ai_question_records SET outcome = 'INTERRUPTED', error_code = 'REQUEST_INTERRUPTED', updated_at = clock_timestamp()
    WHERE outcome = 'PENDING' AND created_at <= clock_timestamp() - interval '10 minutes';
  -- No DELETE trigger: lifetime rollups intentionally survive detail retention.
  DELETE FROM ai_question_records WHERE created_at <= clock_timestamp() - interval '90 days';
END;
$$;

CREATE VIEW ai_question_export AS SELECT id, property_id, conversation_id, created_at, recorded_day, updated_at,
  question_redacted, redaction_version, source, page, topic, application_version, outcome, error_code, tools_used, duration_ms, feedback
  FROM ai_question_records WHERE created_at > CURRENT_TIMESTAMP - interval '90 days';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qintopia_ai_analytics_reader') THEN
    CREATE ROLE qintopia_ai_analytics_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END $$;
REVOKE ALL ON ai_question_records, ai_question_daily, ai_question_export FROM PUBLIC, qintopia_runtime;
GRANT USAGE ON SCHEMA public TO qintopia_ai_analytics_reader;
GRANT SELECT ON ai_question_export, ai_question_daily TO qintopia_ai_analytics_reader;
REVOKE ALL ON FUNCTION qintopia_ai_question_rollup(), qintopia_begin_ai_question(text,text,text,text,text,text,text,text,text,text),
  qintopia_finish_ai_question(text,text,text,text,text,text[],integer), qintopia_feedback_ai_question(text,text,text,text,text), qintopia_maintain_ai_questions() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION qintopia_begin_ai_question(text,text,text,text,text,text,text,text,text,text),
  qintopia_finish_ai_question(text,text,text,text,text,text[],integer), qintopia_feedback_ai_question(text,text,text,text,text), qintopia_maintain_ai_questions() TO qintopia_runtime;
