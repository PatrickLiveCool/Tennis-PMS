-- Existing platform-issued keys retain their original lifetime. New tenant keys expire.
ALTER TABLE tennis.gateway_integrations
  ADD COLUMN paused_at timestamptz,
  ADD COLUMN expires_at timestamptz,
  ADD COLUMN rotated_at timestamptz,
  ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK(revision > 0);
