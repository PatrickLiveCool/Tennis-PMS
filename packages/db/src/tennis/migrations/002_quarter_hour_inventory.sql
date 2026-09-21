-- Append-only upgrade: never round, delete or silently rewrite an existing booking.
-- Existing off-grid rows cause this migration to roll back for explicit reconciliation.
ALTER TABLE tennis.occupancies
  ADD CONSTRAINT court_occupancy_quarter_hour CHECK (
    mod(extract(epoch FROM start_at), 900) = 0
    AND mod(extract(epoch FROM end_at), 900) = 0
  );
