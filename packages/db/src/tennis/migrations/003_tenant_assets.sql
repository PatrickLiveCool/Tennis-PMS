-- The F0 bootstrap did not assign tenants. Refuse to invent ownership for old data.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM tennis.courts) THEN
    RAISE EXCEPTION 'Explicit tenant mapping is required for existing F0 courts before migration 003';
  END IF;
END $$;

CREATE TABLE tennis.subjects (
  id text PRIMARY KEY CHECK (length(btrim(id)) > 0),
  display_name text NOT NULL CHECK (length(btrim(display_name)) > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tennis.platform_operators (
  subject_id text PRIMARY KEY REFERENCES tennis.subjects(id),
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE tennis.tenants (
  id text PRIMARY KEY CHECK (length(btrim(id)) > 0),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tennis.tenant_memberships (
  tenant_id text NOT NULL REFERENCES tennis.tenants(id),
  subject_id text NOT NULL REFERENCES tennis.subjects(id),
  role text NOT NULL CHECK (role IN ('ADMIN', 'STAFF', 'VIEWER')),
  active boolean NOT NULL DEFAULT true,
  all_venues boolean NOT NULL DEFAULT false,
  permissions text[] NOT NULL DEFAULT ARRAY['read']::text[] CHECK (
    permissions <@ ARRAY['read','book','manage_assets','manage_prices','refund','hold_unpaid','manage_members']::text[]
  ),
  PRIMARY KEY (tenant_id, subject_id)
);

CREATE TABLE tennis.venues (
  id text PRIMARY KEY CHECK (length(btrim(id)) > 0),
  tenant_id text NOT NULL REFERENCES tennis.tenants(id),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  address text NOT NULL DEFAULT '',
  timezone text NOT NULL DEFAULT 'Asia/Shanghai' CHECK (length(btrim(timezone)) > 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE tennis.membership_venues (
  tenant_id text NOT NULL,
  subject_id text NOT NULL,
  venue_id text NOT NULL,
  PRIMARY KEY (tenant_id, subject_id, venue_id),
  FOREIGN KEY (tenant_id, subject_id) REFERENCES tennis.tenant_memberships(tenant_id, subject_id),
  FOREIGN KEY (tenant_id, venue_id) REFERENCES tennis.venues(tenant_id, id)
);

ALTER TABLE tennis.courts
  ADD COLUMN tenant_id text NOT NULL REFERENCES tennis.tenants(id),
  ADD COLUMN active boolean NOT NULL DEFAULT true,
  ADD COLUMN indoor boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT court_tenant_identity UNIQUE (tenant_id, id),
  ADD CONSTRAINT court_tenant_venue FOREIGN KEY (tenant_id, venue_id) REFERENCES tennis.venues(tenant_id, id);

ALTER TABLE tennis.occupancies
  ADD COLUMN tenant_id text NOT NULL REFERENCES tennis.tenants(id),
  ADD CONSTRAINT occupancy_tenant_court FOREIGN KEY (tenant_id, court_id) REFERENCES tennis.courts(tenant_id, id);

CREATE INDEX court_tenant_venue_idx ON tennis.courts(tenant_id, venue_id);
CREATE INDEX occupancy_tenant_start_idx ON tennis.occupancies(tenant_id, start_at) WHERE released_at IS NULL;

CREATE TABLE tennis.audit_events (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tennis.tenants(id),
  subject_id text NOT NULL REFERENCES tennis.subjects(id),
  action text NOT NULL,
  resource_id text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_tenant_time_idx ON tennis.audit_events(tenant_id, created_at);
