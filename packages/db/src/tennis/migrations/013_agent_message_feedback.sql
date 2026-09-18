-- Feedback belongs to one verified person and one assistant message. The
-- composite reference also prevents crossing a tenant or conversation boundary.
ALTER TABLE tennis.agent_messages
  ADD CONSTRAINT agent_messages_feedback_identity UNIQUE (tenant_id,conversation_id,id,role);
CREATE TABLE tennis.agent_message_feedback (
  tenant_id text NOT NULL,
  conversation_id text NOT NULL,
  message_id text NOT NULL,
  message_role text NOT NULL DEFAULT 'assistant' CHECK (message_role='assistant'),
  subject_id text NOT NULL REFERENCES tennis.subjects(id),
  resolved boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,conversation_id,message_id,subject_id),
  FOREIGN KEY (tenant_id,conversation_id,message_id,message_role)
    REFERENCES tennis.agent_messages(tenant_id,conversation_id,id,role) ON DELETE CASCADE
);
