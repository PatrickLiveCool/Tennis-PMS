-- Request identities survive short-lived delegation revocation. Command links
-- commit in the same transaction as their receipts and business mutations.
CREATE TABLE tennis.agent_requests (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  conversation_id text NOT NULL,
  subject_id text NOT NULL REFERENCES tennis.subjects(id),
  venue_id text NOT NULL,
  generation integer NOT NULL CHECK (generation > 0),
  message_id text REFERENCES tennis.agent_messages(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,conversation_id) REFERENCES tennis.agent_conversations(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,venue_id) REFERENCES tennis.venues(tenant_id,id),
  UNIQUE (tenant_id,conversation_id,id),
  UNIQUE (tenant_id,conversation_id,id,subject_id)
);
CREATE INDEX ON tennis.agent_requests(tenant_id,conversation_id,created_at DESC,id DESC);
ALTER TABLE tennis.agent_delegations ADD COLUMN request_id text;
INSERT INTO tennis.agent_requests(id,tenant_id,conversation_id,subject_id,venue_id,generation)
  SELECT 'legacy:'||d.token_hash,d.tenant_id,d.conversation_id,c.subject_id,c.venue_id,d.generation
  FROM tennis.agent_delegations d JOIN tennis.agent_conversations c ON c.tenant_id=d.tenant_id AND c.id=d.conversation_id;
UPDATE tennis.agent_delegations SET request_id='legacy:'||token_hash;
ALTER TABLE tennis.agent_delegations ALTER COLUMN request_id SET NOT NULL;
ALTER TABLE tennis.agent_delegations ADD CONSTRAINT agent_delegation_request
  FOREIGN KEY (tenant_id,conversation_id,request_id) REFERENCES tennis.agent_requests(tenant_id,conversation_id,id) ON DELETE CASCADE;
CREATE TABLE tennis.agent_command_links (
  tenant_id text NOT NULL,
  conversation_id text NOT NULL,
  request_id text NOT NULL,
  subject_id text NOT NULL,
  command_key text NOT NULL,
  linked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,request_id,subject_id,command_key),
  FOREIGN KEY (tenant_id,conversation_id,request_id,subject_id)
    REFERENCES tennis.agent_requests(tenant_id,conversation_id,id,subject_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,subject_id,command_key)
    REFERENCES tennis.command_receipts(tenant_id,subject_id,command_key) ON DELETE CASCADE
);
