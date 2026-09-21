-- Preserve explicitly verified order references across HUMAN handoff and device changes.
ALTER TABLE tennis.agent_messages
  ADD COLUMN context_page text CHECK(context_page IS NULL OR length(context_page)<=100),
  ADD COLUMN context_order_id text,
  ADD CONSTRAINT agent_message_context_page_required CHECK(context_order_id IS NULL OR context_page IS NOT NULL),
  ADD CONSTRAINT agent_message_context_order_fk FOREIGN KEY(tenant_id,context_order_id) REFERENCES tennis.orders(tenant_id,id);
CREATE INDEX agent_message_latest_order_context ON tennis.agent_messages(tenant_id,conversation_id,created_at DESC,id DESC)
  WHERE context_order_id IS NOT NULL;
CREATE INDEX agent_conversation_mode_directory ON tennis.agent_conversations(tenant_id,venue_id,mode,updated_at DESC,id DESC);
