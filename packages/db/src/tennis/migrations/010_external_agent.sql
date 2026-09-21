CREATE TABLE tennis.platform_ai_config (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  enabled boolean NOT NULL DEFAULT false,
  model text NOT NULL DEFAULT '',
  base_url text NOT NULL DEFAULT '',
  external_agent_url text NOT NULL DEFAULT '',
  encrypted_key text,
  revision integer NOT NULL DEFAULT 1,
  updated_by text REFERENCES tennis.subjects(id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO tennis.platform_ai_config(singleton) VALUES(true);

CREATE TABLE tennis.agent_conversations (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tennis.tenants(id),
  venue_id text NOT NULL,
  subject_id text NOT NULL REFERENCES tennis.subjects(id),
  customer_id text,
  actor_kind text NOT NULL CHECK(actor_kind IN ('staff','customer')),
  mode text NOT NULL DEFAULT 'AGENT' CHECK(mode IN ('AGENT','HUMAN')),
  generation integer NOT NULL DEFAULT 1,
  taken_by text REFERENCES tennis.subjects(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(tenant_id,venue_id) REFERENCES tennis.venues(tenant_id,id),
  FOREIGN KEY(tenant_id,customer_id) REFERENCES tennis.customers(tenant_id,id),
  UNIQUE(tenant_id,id)
);
CREATE TABLE tennis.agent_delegations (
  token_hash text PRIMARY KEY,
  tenant_id text NOT NULL,
  conversation_id text NOT NULL,
  generation integer NOT NULL,
  expires_at timestamptz NOT NULL,
  FOREIGN KEY(tenant_id,conversation_id) REFERENCES tennis.agent_conversations(tenant_id,id) ON DELETE CASCADE
);
CREATE TABLE tennis.agent_messages (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  conversation_id text NOT NULL,
  role text NOT NULL CHECK(role IN ('user','assistant','staff','system')),
  subject_id text REFERENCES tennis.subjects(id),
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(tenant_id,conversation_id) REFERENCES tennis.agent_conversations(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX ON tennis.agent_conversations(tenant_id,venue_id,updated_at DESC);
CREATE INDEX ON tennis.agent_messages(conversation_id,created_at,id);
