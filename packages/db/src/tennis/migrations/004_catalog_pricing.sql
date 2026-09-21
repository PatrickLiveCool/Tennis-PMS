ALTER TABLE tennis.venues
  ADD COLUMN opening_hours jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(opening_hours) = 'array'),
  ADD COLUMN minimum_booking_minutes integer CHECK (minimum_booking_minutes >= 15 AND minimum_booking_minutes % 15 = 0),
  ADD COLUMN catalog_revision integer NOT NULL DEFAULT 1 CHECK (catalog_revision > 0);

ALTER TABLE tennis.courts
  ADD COLUMN hourly_price_cents bigint CHECK (hourly_price_cents >= 0 AND hourly_price_cents <= 9007199254740991),
  ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  ADD CONSTRAINT court_tenant_venue_identity UNIQUE (tenant_id, venue_id, id);

CREATE TABLE tennis.discount_rules (
  id text PRIMARY KEY CHECK (length(btrim(id)) > 0),
  tenant_id text NOT NULL,
  venue_id text NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  date_from date NOT NULL,
  date_to date NOT NULL CHECK (date_to >= date_from),
  weekdays smallint[] NOT NULL CHECK (cardinality(weekdays) > 0 AND weekdays <@ ARRAY[0,1,2,3,4,5,6]::smallint[]),
  start_minute integer NOT NULL CHECK (start_minute >= 0 AND start_minute % 15 = 0),
  end_minute integer NOT NULL CHECK (end_minute <= 1440 AND end_minute > start_minute AND end_minute % 15 = 0),
  discount_bps integer NOT NULL CHECK (discount_bps BETWEEN 0 AND 10000),
  active boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, venue_id) REFERENCES tennis.venues(tenant_id, id),
  UNIQUE (tenant_id, venue_id, id)
);

CREATE TABLE tennis.discount_rule_courts (
  tenant_id text NOT NULL,
  venue_id text NOT NULL,
  rule_id text NOT NULL,
  court_id text NOT NULL,
  PRIMARY KEY (rule_id, court_id),
  FOREIGN KEY (tenant_id, venue_id, rule_id) REFERENCES tennis.discount_rules(tenant_id, venue_id, id),
  FOREIGN KEY (tenant_id, venue_id, court_id) REFERENCES tennis.courts(tenant_id, venue_id, id)
);
CREATE INDEX discount_rules_venue_idx ON tennis.discount_rules(tenant_id, venue_id) WHERE active;
