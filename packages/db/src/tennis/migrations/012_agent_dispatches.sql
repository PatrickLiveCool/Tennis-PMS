-- Claim an external request once. An unknown result must be reconciled by a
-- human; blindly re-running a potentially stateful external runtime is unsafe.
CREATE TABLE tennis.agent_message_dispatches (
  message_id text PRIMARY KEY REFERENCES tennis.agent_messages(id) ON DELETE CASCADE,
  tenant_id text NOT NULL,
  conversation_id text NOT NULL,
  generation integer NOT NULL,
  status text NOT NULL CHECK(status IN ('IN_FLIGHT','SUCCEEDED','UNCERTAIN')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(tenant_id,conversation_id) REFERENCES tennis.agent_conversations(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX ON tennis.agent_message_dispatches(tenant_id,conversation_id,generation,status);
