-- Channel-independent trusted gateway identity. No automatic phone/name binding.
CREATE TABLE tennis.gateway_integrations (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tennis.tenants(id),
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
  token_hash text NOT NULL UNIQUE,
  active boolean NOT NULL DEFAULT true,
  created_by text NOT NULL REFERENCES tennis.subjects(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  UNIQUE(tenant_id,id)
);
CREATE TABLE tennis.gateway_bindings (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  integration_id text NOT NULL,
  external_subject text NOT NULL CHECK(length(external_subject) BETWEEN 1 AND 200),
  subject_id text NOT NULL REFERENCES tennis.subjects(id),
  customer_id text,
  actor_kind text NOT NULL CHECK(actor_kind IN ('staff','customer')),
  active boolean NOT NULL DEFAULT true,
  created_by text NOT NULL REFERENCES tennis.subjects(id),
  reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  CHECK((actor_kind='customer')=(customer_id IS NOT NULL)),
  FOREIGN KEY(tenant_id,integration_id) REFERENCES tennis.gateway_integrations(tenant_id,id),
  FOREIGN KEY(tenant_id,customer_id) REFERENCES tennis.customers(tenant_id,id),
  UNIQUE(tenant_id,id),
  UNIQUE(tenant_id,integration_id,id)
);
CREATE UNIQUE INDEX gateway_binding_active_identity ON tennis.gateway_bindings(integration_id,external_subject) WHERE active;
ALTER TABLE tennis.agent_delegations ADD COLUMN gateway_binding_id text;
ALTER TABLE tennis.agent_delegations ADD FOREIGN KEY(tenant_id,gateway_binding_id) REFERENCES tennis.gateway_bindings(tenant_id,id);
CREATE TABLE tennis.gateway_conversations (
  tenant_id text NOT NULL,
  integration_id text NOT NULL,
  binding_id text NOT NULL,
  external_conversation text NOT NULL CHECK(length(external_conversation) BETWEEN 1 AND 200),
  conversation_id text NOT NULL,
  PRIMARY KEY(binding_id,external_conversation),
  FOREIGN KEY(tenant_id,integration_id,binding_id) REFERENCES tennis.gateway_bindings(tenant_id,integration_id,id),
  FOREIGN KEY(tenant_id,conversation_id) REFERENCES tennis.agent_conversations(tenant_id,id),
  UNIQUE(tenant_id,integration_id,binding_id,conversation_id)
);
CREATE TABLE tennis.gateway_messages (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  integration_id text NOT NULL,
  binding_id text NOT NULL,
  conversation_id text NOT NULL,
  external_message text NOT NULL CHECK(length(external_message) BETWEEN 1 AND 200),
  generation integer NOT NULL,
  content_hash text NOT NULL,
  grant_snapshot jsonb,
  encrypted_token text,
  token_hash text,
  completion_hash text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(id) REFERENCES tennis.agent_messages(id),
  FOREIGN KEY(tenant_id,integration_id,binding_id,conversation_id) REFERENCES tennis.gateway_conversations(tenant_id,integration_id,binding_id,conversation_id),
  UNIQUE(integration_id,external_message)
);
CREATE INDEX gateway_message_conversation ON tennis.gateway_messages(tenant_id,conversation_id,created_at,id);
