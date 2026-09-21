INSERT INTO tennis.subjects (id, display_name) VALUES ('system:tennis', '网球系统任务');

CREATE TABLE tennis.customers (
  id text PRIMARY KEY CHECK (length(btrim(id)) > 0),
  tenant_id text NOT NULL REFERENCES tennis.tenants(id),
  nickname text NOT NULL CHECK (length(btrim(nickname)) > 0),
  phone text CHECK (phone ~ '^\+[1-9][0-9]{6,14}$'),
  subject_id text REFERENCES tennis.subjects(id),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, phone),
  UNIQUE (tenant_id, subject_id)
);

CREATE TABLE tennis.quotes (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  venue_id text NOT NULL,
  customer_id text NOT NULL,
  created_by text NOT NULL REFERENCES tennis.subjects(id),
  price_snapshot jsonb NOT NULL CHECK (jsonb_typeof(price_snapshot) = 'object'),
  expires_at timestamptz NOT NULL CHECK (isfinite(expires_at)),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, venue_id) REFERENCES tennis.venues(tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES tennis.customers(tenant_id, id),
  UNIQUE (tenant_id, venue_id, customer_id, id)
);

CREATE TABLE tennis.orders (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  venue_id text NOT NULL,
  customer_id text NOT NULL,
  quote_id text NOT NULL UNIQUE,
  created_by text NOT NULL REFERENCES tennis.subjects(id),
  status text NOT NULL CHECK (status IN ('HELD','CONFIRMED','EXPIRED','CANCELLED','COMPLETED')),
  payment_status text NOT NULL CHECK (payment_status IN ('UNPAID','PAID','PARTIALLY_REFUNDED','REFUNDED','NOT_REQUIRED')),
  total_cents bigint NOT NULL CHECK (total_cents >= 0 AND total_cents <= 9007199254740991),
  currency text NOT NULL DEFAULT 'CNY' CHECK (currency = 'CNY'),
  hold_kind text NOT NULL CHECK (hold_kind IN ('PAYMENT','STAFF')),
  hold_until timestamptz CHECK (isfinite(hold_until)),
  hold_reason text,
  confirmation_request jsonb NOT NULL,
  price_snapshot jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((status = 'HELD') = (hold_until IS NOT NULL)),
  CHECK (hold_kind != 'STAFF' OR (hold_reason IS NOT NULL AND length(btrim(hold_reason)) > 0)),
  CHECK (payment_status != 'NOT_REQUIRED' OR total_cents = 0),
  FOREIGN KEY (tenant_id, venue_id, customer_id, quote_id) REFERENCES tennis.quotes(tenant_id, venue_id, customer_id, id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, venue_id, id)
);
CREATE INDEX order_tenant_customer_idx ON tennis.orders(tenant_id, customer_id, created_at);
CREATE INDEX order_due_idx ON tennis.orders(hold_until) WHERE status = 'HELD';

CREATE TABLE tennis.order_lines (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  venue_id text NOT NULL,
  order_id text NOT NULL,
  court_id text NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents >= 0 AND amount_cents <= 9007199254740991),
  price_snapshot jsonb NOT NULL,
  cancelled_at timestamptz,
  CHECK (isfinite(start_at) AND isfinite(end_at) AND start_at < end_at),
  CHECK (mod(extract(epoch FROM start_at),900)=0 AND mod(extract(epoch FROM end_at),900)=0),
  FOREIGN KEY (tenant_id, venue_id, order_id) REFERENCES tennis.orders(tenant_id, venue_id, id),
  FOREIGN KEY (tenant_id, venue_id, court_id) REFERENCES tennis.courts(tenant_id, venue_id, id),
  UNIQUE (order_id, position),
  UNIQUE (tenant_id, id)
);

ALTER TABLE tennis.occupancies
  ADD COLUMN order_line_id text,
  ADD CONSTRAINT occupancy_order_line FOREIGN KEY (tenant_id, order_line_id) REFERENCES tennis.order_lines(tenant_id, id);
CREATE UNIQUE INDEX occupancy_one_active_line ON tennis.occupancies(tenant_id, order_line_id)
  WHERE released_at IS NULL AND order_line_id IS NOT NULL;

CREATE TABLE tennis.command_receipts (
  tenant_id text NOT NULL,
  subject_id text NOT NULL REFERENCES tennis.subjects(id),
  command_key text NOT NULL CHECK (length(command_key) BETWEEN 8 AND 128),
  venue_id text NOT NULL,
  command_type text NOT NULL,
  request_hash text NOT NULL,
  result jsonb,
  completed_at timestamptz,
  CHECK ((result IS NULL) = (completed_at IS NULL)),
  PRIMARY KEY (tenant_id, subject_id, command_key),
  FOREIGN KEY (tenant_id, venue_id) REFERENCES tennis.venues(tenant_id, id)
);
