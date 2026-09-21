ALTER TABLE tennis.order_lines ADD COLUMN initial_funding_cents bigint;
UPDATE tennis.order_lines SET initial_funding_cents=amount_cents;
ALTER TABLE tennis.order_lines ALTER COLUMN initial_funding_cents SET NOT NULL;
ALTER TABLE tennis.order_lines ADD CHECK (initial_funding_cents>=0 AND initial_funding_cents<=9007199254740991);

CREATE TABLE tennis.order_amendments (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  venue_id text NOT NULL,
  order_id text NOT NULL,
  customer_id text NOT NULL,
  created_by text NOT NULL REFERENCES tennis.subjects(id),
  base_revision integer NOT NULL CHECK (base_revision>0),
  status text NOT NULL CHECK (status IN ('QUOTED','AWAITING_PAYMENT','APPLIED','CANCELLED','EXPIRED')),
  reason text NOT NULL CHECK (length(btrim(reason))>0),
  expires_at timestamptz NOT NULL CHECK (isfinite(expires_at)),
  hold_until timestamptz CHECK (isfinite(hold_until)),
  supplemental_cents bigint NOT NULL CHECK (supplemental_cents>=0 AND supplemental_cents<=9007199254740991),
  suggested_refund_cents bigint NOT NULL CHECK (suggested_refund_cents>=0 AND suggested_refund_cents<=9007199254740991),
  approved_refund_cents bigint CHECK (approved_refund_cents>=0 AND approved_refund_cents<=suggested_refund_cents),
  confirmation_request jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  applied_at timestamptz,
  CHECK ((status='AWAITING_PAYMENT')=(hold_until IS NOT NULL)),
  CHECK ((status='APPLIED')=(applied_at IS NOT NULL)),
  FOREIGN KEY (tenant_id,venue_id,order_id) REFERENCES tennis.orders(tenant_id,venue_id,id),
  FOREIGN KEY (tenant_id,customer_id) REFERENCES tennis.customers(tenant_id,id),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,order_id,id),
  UNIQUE (tenant_id,venue_id,customer_id,order_id,id)
);
CREATE UNIQUE INDEX amendment_one_pending_order ON tennis.order_amendments(tenant_id,order_id) WHERE status='AWAITING_PAYMENT';
CREATE INDEX amendment_due_idx ON tennis.order_amendments(hold_until) WHERE status='AWAITING_PAYMENT';
CREATE TABLE tennis.order_amendment_lines (
  tenant_id text NOT NULL,
  amendment_id text NOT NULL,
  line_id text NOT NULL,
  old_snapshot jsonb NOT NULL,
  new_snapshot jsonb NOT NULL,
  original_occupancy_id text NOT NULL REFERENCES tennis.occupancies(id),
  funding_cap_delta_cents bigint NOT NULL,
  suggested_refund_cents bigint NOT NULL CHECK (suggested_refund_cents>=0),
  approved_refund_cents bigint CHECK (approved_refund_cents>=0 AND approved_refund_cents<=suggested_refund_cents),
  PRIMARY KEY (tenant_id,amendment_id,line_id),
  FOREIGN KEY (tenant_id,amendment_id) REFERENCES tennis.order_amendments(tenant_id,id),
  FOREIGN KEY (tenant_id,line_id) REFERENCES tennis.order_lines(tenant_id,id)
);
ALTER TABLE tennis.occupancies ADD COLUMN amendment_id text,
  ADD FOREIGN KEY (tenant_id,amendment_id) REFERENCES tennis.order_amendments(tenant_id,id),
  ADD CHECK (amendment_id IS NULL OR order_line_id IS NULL);
ALTER TABLE tennis.payment_attempts ADD COLUMN amendment_id text,
  ADD FOREIGN KEY (tenant_id,venue_id,customer_id,order_id,amendment_id)
    REFERENCES tennis.order_amendments(tenant_id,venue_id,customer_id,order_id,id);
DROP INDEX tennis.payment_one_success_order;
CREATE UNIQUE INDEX payment_one_success_initial ON tennis.payment_attempts(tenant_id,order_id) WHERE status='SUCCEEDED' AND amendment_id IS NULL;
CREATE UNIQUE INDEX payment_one_success_amendment ON tennis.payment_attempts(tenant_id,amendment_id) WHERE status='SUCCEEDED' AND amendment_id IS NOT NULL;

CREATE TABLE tennis.refund_groups (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  venue_id text NOT NULL,
  order_id text NOT NULL,
  customer_id text NOT NULL,
  amendment_id text,
  reason text NOT NULL,
  created_by text NOT NULL REFERENCES tennis.subjects(id),
  amount_cents bigint NOT NULL CHECK (amount_cents>=0 AND amount_cents<=9007199254740991),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,venue_id,order_id) REFERENCES tennis.orders(tenant_id,venue_id,id),
  FOREIGN KEY (tenant_id,customer_id) REFERENCES tennis.customers(tenant_id,id),
  FOREIGN KEY (tenant_id,order_id,amendment_id) REFERENCES tennis.order_amendments(tenant_id,order_id,id),
  UNIQUE (tenant_id,id)
);
INSERT INTO tennis.refund_groups(id,tenant_id,venue_id,order_id,customer_id,reason,created_by,amount_cents,created_at)
 SELECT id,tenant_id,venue_id,order_id,customer_id,reason,created_by,amount_cents,created_at FROM tennis.refunds;
ALTER TABLE tennis.refunds ADD COLUMN group_id text;
UPDATE tennis.refunds SET group_id=id;
ALTER TABLE tennis.refunds ALTER COLUMN group_id SET NOT NULL;
ALTER TABLE tennis.refunds ADD FOREIGN KEY (tenant_id,group_id) REFERENCES tennis.refund_groups(tenant_id,id);
