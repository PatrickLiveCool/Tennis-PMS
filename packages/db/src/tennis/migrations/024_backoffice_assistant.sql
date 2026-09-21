-- The old platform_ai_config credential belongs to the external Runtime.
-- Never copy it into the independently configured model connection.
CREATE TABLE tennis.backoffice_ai_config (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  enabled boolean NOT NULL DEFAULT false,
  model text NOT NULL DEFAULT '',
  base_url text NOT NULL DEFAULT '',
  encrypted_key text,
  revision integer NOT NULL DEFAULT 1,
  updated_by text REFERENCES tennis.subjects(id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO tennis.backoffice_ai_config(singleton) VALUES(true);

CREATE TABLE tennis.backoffice_conversations (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tennis.tenants(id),
  venue_id text NOT NULL,
  subject_id text NOT NULL REFERENCES tennis.subjects(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(tenant_id,venue_id) REFERENCES tennis.venues(tenant_id,id),
  UNIQUE(tenant_id,id)
);
CREATE INDEX ON tennis.backoffice_conversations(tenant_id,subject_id,venue_id,updated_at DESC);
CREATE TABLE tennis.backoffice_requests (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  conversation_id text NOT NULL,
  message_id text NOT NULL,
  input_hash text NOT NULL,
  status text NOT NULL CHECK(status IN ('RUNNING','SUCCEEDED','FAILED')),
  error_code text,
  config_revision integer NOT NULL,
  context jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deadline_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '180 seconds',
  completed_at timestamptz,
  FOREIGN KEY(tenant_id,conversation_id) REFERENCES tennis.backoffice_conversations(tenant_id,id) ON DELETE CASCADE,
  UNIQUE(tenant_id,conversation_id,message_id),
  UNIQUE(tenant_id,id),
  CHECK((status='RUNNING')=(completed_at IS NULL))
);
CREATE UNIQUE INDEX ON tennis.backoffice_requests(tenant_id,conversation_id) WHERE status='RUNNING';
CREATE TABLE tennis.backoffice_messages (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  conversation_id text NOT NULL,
  request_id text NOT NULL,
  role text NOT NULL CHECK(role IN ('USER','ASSISTANT')),
  content text NOT NULL CHECK(length(content) BETWEEN 1 AND 12000),
  actions jsonb NOT NULL DEFAULT '[]',
  resolved boolean,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(tenant_id,conversation_id) REFERENCES tennis.backoffice_conversations(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY(tenant_id,request_id) REFERENCES tennis.backoffice_requests(tenant_id,id) ON DELETE CASCADE,
  UNIQUE(request_id,role),
  CHECK(role='ASSISTANT' OR resolved IS NULL)
);
CREATE INDEX ON tennis.backoffice_messages(tenant_id,conversation_id,created_at,id);
