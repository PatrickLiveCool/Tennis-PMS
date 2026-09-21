-- Authentication identities never inherit access merely by being platform operators.
CREATE TABLE tennis.local_accounts (
  subject_id text PRIMARY KEY REFERENCES tennis.subjects(id),
  username text NOT NULL UNIQUE CHECK (username = lower(username) AND length(username) BETWEEN 3 AND 100),
  password_hash text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  failure_started_at timestamptz,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE tennis.auth_sessions (
  id text PRIMARY KEY,
  token_hash text NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  subject_id text NOT NULL REFERENCES tennis.local_accounts(subject_id),
  tenant_id text REFERENCES tennis.tenants(id),
  kind text NOT NULL CHECK (kind IN ('staff','customer','platform')),
  csrf_token text NOT NULL,
  context_version integer NOT NULL DEFAULT 1 CHECK (context_version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK ((kind = 'platform') = (tenant_id IS NULL)),
  CHECK (expires_at > created_at)
);
CREATE INDEX auth_session_subject_idx ON tennis.auth_sessions(subject_id);

CREATE TABLE tennis.auth_audit_events (
  id text PRIMARY KEY,
  subject_id text REFERENCES tennis.subjects(id),
  tenant_id text REFERENCES tennis.tenants(id),
  action text NOT NULL,
  resource_id text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX auth_audit_time_idx ON tennis.auth_audit_events(created_at);
