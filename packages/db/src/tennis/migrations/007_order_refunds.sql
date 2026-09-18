CREATE TABLE tennis.refunds (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  venue_id text NOT NULL,
  order_id text NOT NULL,
  customer_id text NOT NULL,
  payment_id text NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents>=0 AND amount_cents<=9007199254740991),
  wallet_cents bigint NOT NULL CHECK (wallet_cents>=0),
  external_cents bigint NOT NULL CHECK (external_cents>=0),
  status text NOT NULL CHECK (status IN ('REQUESTED','PROCESSING','SUCCEEDED','FAILED')),
  reason text NOT NULL CHECK (length(btrim(reason))>0),
  created_by text NOT NULL REFERENCES tennis.subjects(id),
  provider_refund_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  CHECK (wallet_cents+external_cents=amount_cents),
  CHECK ((status='SUCCEEDED')=(completed_at IS NOT NULL)),
  FOREIGN KEY (tenant_id,venue_id,order_id) REFERENCES tennis.orders(tenant_id,venue_id,id),
  FOREIGN KEY (tenant_id,customer_id,payment_id) REFERENCES tennis.payment_attempts(tenant_id,customer_id,id),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,customer_id,id)
);
CREATE TABLE tennis.refund_lines (
  tenant_id text NOT NULL,
  refund_id text NOT NULL,
  order_line_id text NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents>=0),
  cancel_line boolean NOT NULL,
  PRIMARY KEY (tenant_id,refund_id,order_line_id),
  FOREIGN KEY (tenant_id,refund_id) REFERENCES tennis.refunds(tenant_id,id),
  FOREIGN KEY (tenant_id,order_line_id) REFERENCES tennis.order_lines(tenant_id,id)
);
CREATE TABLE tennis.refund_wallet_allocations (
  tenant_id text NOT NULL,
  customer_id text NOT NULL,
  refund_id text NOT NULL,
  batch_id text NOT NULL,
  principal_cents bigint NOT NULL CHECK (principal_cents>=0),
  gift_cents bigint NOT NULL CHECK (gift_cents>=0),
  CHECK (principal_cents+gift_cents>0),
  PRIMARY KEY (tenant_id,refund_id,batch_id),
  FOREIGN KEY (tenant_id,customer_id,refund_id) REFERENCES tennis.refunds(tenant_id,customer_id,id),
  FOREIGN KEY (tenant_id,customer_id,batch_id) REFERENCES tennis.wallet_batches(tenant_id,customer_id,id)
);
CREATE TABLE tennis.refund_events (
  provider text NOT NULL,
  merchant_id text NOT NULL,
  event_id text NOT NULL,
  tenant_id text NOT NULL,
  refund_id text NOT NULL,
  request_hash text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (provider,merchant_id,event_id),
  FOREIGN KEY (tenant_id,refund_id) REFERENCES tennis.refunds(tenant_id,id)
);
CREATE TABLE tennis.external_refund_receipts (
  provider text NOT NULL,
  merchant_id text NOT NULL,
  provider_refund_id text NOT NULL,
  tenant_id text NOT NULL,
  refund_id text NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents>0),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (provider,merchant_id,provider_refund_id),
  FOREIGN KEY (tenant_id,refund_id) REFERENCES tennis.refunds(tenant_id,id)
);
