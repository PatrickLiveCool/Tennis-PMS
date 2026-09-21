-- Persistent customer topup lookup must remain useful after browser drafts are lost.
CREATE INDEX topup_payments_customer_directory ON tennis.topup_payments(tenant_id,venue_id,customer_id,created_at DESC,id DESC);
