-- Booking deadlines are tenant configuration; existing quotes retain the former ten-minute promise.
CREATE TABLE tennis.booking_policies (
  tenant_id text PRIMARY KEY REFERENCES tennis.tenants(id) ON DELETE CASCADE,
  quote_minutes integer NOT NULL DEFAULT 5 CHECK (quote_minutes BETWEEN 1 AND 1440),
  payment_hold_minutes integer NOT NULL DEFAULT 10 CHECK (payment_hold_minutes BETWEEN 1 AND 1440),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0)
);
ALTER TABLE tennis.quotes ADD COLUMN payment_hold_minutes integer NOT NULL DEFAULT 10
  CHECK (payment_hold_minutes BETWEEN 1 AND 1440);
ALTER TABLE tennis.order_amendments ADD COLUMN payment_hold_minutes integer NOT NULL DEFAULT 10
  CHECK (payment_hold_minutes BETWEEN 1 AND 1440);
