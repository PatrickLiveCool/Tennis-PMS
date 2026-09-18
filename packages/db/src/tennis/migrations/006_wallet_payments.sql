CREATE TABLE tennis.wallet_accounts (
  tenant_id text NOT NULL,
  customer_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,customer_id),
  FOREIGN KEY (tenant_id,customer_id) REFERENCES tennis.customers(tenant_id,id)
);
CREATE TABLE tennis.wallet_batches (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  customer_id text NOT NULL,
  venue_id text NOT NULL,
  principal_cents bigint NOT NULL CHECK (principal_cents>=0 AND principal_cents<=9007199254740991),
  gift_cents bigint NOT NULL CHECK (gift_cents>=0 AND gift_cents<=9007199254740991),
  available_principal_cents bigint NOT NULL CHECK (available_principal_cents>=0),
  available_gift_cents bigint NOT NULL CHECK (available_gift_cents>=0),
  reserved_principal_cents bigint NOT NULL DEFAULT 0 CHECK (reserved_principal_cents>=0),
  reserved_gift_cents bigint NOT NULL DEFAULT 0 CHECK (reserved_gift_cents>=0),
  source_kind text NOT NULL CHECK (source_kind IN ('OFFLINE','MOCK','WECHAT')),
  source_reference text NOT NULL CHECK (length(btrim(source_reference))>0),
  reason text NOT NULL CHECK (length(btrim(reason))>0),
  created_by text NOT NULL REFERENCES tennis.subjects(id),
  credit_sequence bigint GENERATED ALWAYS AS IDENTITY,
  credited_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (principal_cents+gift_cents>0 AND principal_cents+gift_cents<=9007199254740991),
  CHECK (available_principal_cents+reserved_principal_cents<=principal_cents),
  CHECK (available_gift_cents+reserved_gift_cents<=gift_cents),
  FOREIGN KEY (tenant_id,customer_id) REFERENCES tennis.wallet_accounts(tenant_id,customer_id),
  FOREIGN KEY (tenant_id,venue_id) REFERENCES tennis.venues(tenant_id,id),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,customer_id,id),
  UNIQUE (tenant_id,source_kind,source_reference)
);
CREATE INDEX wallet_fifo_idx ON tennis.wallet_batches(tenant_id,customer_id,credit_sequence);

CREATE TABLE tennis.payment_attempts (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  venue_id text NOT NULL,
  customer_id text NOT NULL,
  order_id text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('MOCK','WECHAT','WALLET')),
  merchant_id text NOT NULL,
  external_cents bigint NOT NULL CHECK (external_cents>=0 AND external_cents<=9007199254740991),
  wallet_cents bigint NOT NULL CHECK (wallet_cents>=0 AND wallet_cents<=9007199254740991),
  currency text NOT NULL DEFAULT 'CNY' CHECK (currency='CNY'),
  status text NOT NULL CHECK (status IN ('PENDING','SUCCEEDED','FAILED','EXPIRED','CANCELLED','REFUND_REQUIRED')),
  provider_transaction_id text,
  created_by text NOT NULL REFERENCES tennis.subjects(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  settled_at timestamptz,
  CHECK (wallet_cents+external_cents>0 AND wallet_cents+external_cents<=9007199254740991),
  CHECK ((provider='WALLET')=(external_cents=0)),
  FOREIGN KEY (tenant_id,venue_id,order_id) REFERENCES tennis.orders(tenant_id,venue_id,id),
  FOREIGN KEY (tenant_id,customer_id) REFERENCES tennis.customers(tenant_id,id),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,customer_id,id),
  UNIQUE (provider,merchant_id,provider_transaction_id)
);
CREATE UNIQUE INDEX payment_one_pending_order ON tennis.payment_attempts(tenant_id,order_id) WHERE status='PENDING';
CREATE UNIQUE INDEX payment_one_success_order ON tennis.payment_attempts(tenant_id,order_id) WHERE status='SUCCEEDED';

CREATE TABLE tennis.wallet_allocations (
  tenant_id text NOT NULL,
  customer_id text NOT NULL,
  payment_id text NOT NULL,
  batch_id text NOT NULL,
  principal_cents bigint NOT NULL CHECK (principal_cents>=0),
  gift_cents bigint NOT NULL CHECK (gift_cents>=0),
  status text NOT NULL CHECK (status IN ('RESERVED','CONSUMED','RELEASED')),
  CHECK (principal_cents+gift_cents>0),
  PRIMARY KEY (tenant_id,payment_id,batch_id),
  FOREIGN KEY (tenant_id,customer_id,payment_id) REFERENCES tennis.payment_attempts(tenant_id,customer_id,id),
  FOREIGN KEY (tenant_id,customer_id,batch_id) REFERENCES tennis.wallet_batches(tenant_id,customer_id,id)
);
CREATE TABLE tennis.wallet_entries (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  customer_id text NOT NULL,
  batch_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('TOPUP','RESERVE','RELEASE','CONSUME','REFUND')),
  principal_cents bigint NOT NULL CHECK (principal_cents>=0),
  gift_cents bigint NOT NULL CHECK (gift_cents>=0),
  source_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (principal_cents+gift_cents>0),
  FOREIGN KEY (tenant_id,customer_id,batch_id) REFERENCES tennis.wallet_batches(tenant_id,customer_id,id),
  UNIQUE (tenant_id,kind,source_id,batch_id)
);
CREATE TABLE tennis.payment_events (
  provider text NOT NULL,
  merchant_id text NOT NULL,
  event_id text NOT NULL,
  tenant_id text NOT NULL,
  payment_id text NOT NULL,
  request_hash text NOT NULL,
  payload jsonb NOT NULL,
  outcome text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (provider,merchant_id,event_id),
  FOREIGN KEY (tenant_id,payment_id) REFERENCES tennis.payment_attempts(tenant_id,id)
);
CREATE TABLE tennis.external_payment_receipts (
  provider text NOT NULL,
  merchant_id text NOT NULL,
  transaction_id text NOT NULL,
  tenant_id text NOT NULL,
  payment_id text NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents>0),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (provider,merchant_id,transaction_id),
  FOREIGN KEY (tenant_id,payment_id) REFERENCES tennis.payment_attempts(tenant_id,id)
);
CREATE TABLE tennis.financial_exceptions (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  payment_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('LATE_PAYMENT','DUPLICATE_PAYMENT')),
  external_transaction_id text NOT NULL,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED')),
  details jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,payment_id) REFERENCES tennis.payment_attempts(tenant_id,id),
  UNIQUE (tenant_id,payment_id,kind,external_transaction_id)
);
