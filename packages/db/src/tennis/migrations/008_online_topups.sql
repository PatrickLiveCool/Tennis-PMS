CREATE TABLE tennis.channel_transactions (
  provider text NOT NULL,
  merchant_id text NOT NULL,
  transaction_id text NOT NULL,
  tenant_id text NOT NULL REFERENCES tennis.tenants(id),
  source_type text NOT NULL CHECK (source_type IN ('ORDER','TOPUP')),
  source_id text NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents>0),
  PRIMARY KEY (provider,merchant_id,transaction_id)
);
INSERT INTO tennis.channel_transactions (provider,merchant_id,transaction_id,tenant_id,source_type,source_id,amount_cents)
  SELECT provider,merchant_id,transaction_id,tenant_id,'ORDER',payment_id,amount_cents FROM tennis.external_payment_receipts;
CREATE TABLE tennis.topup_offers (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tennis.tenants(id),
  name text NOT NULL CHECK (length(btrim(name))>0),
  principal_cents bigint NOT NULL CHECK (principal_cents>0 AND principal_cents<=9007199254740991),
  gift_cents bigint NOT NULL CHECK (gift_cents>=0 AND gift_cents<=9007199254740991),
  active boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  CHECK (principal_cents+gift_cents<=9007199254740991),
  UNIQUE (tenant_id,id)
);
CREATE TABLE tennis.topup_quotes (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  venue_id text NOT NULL,
  customer_id text NOT NULL,
  created_by text NOT NULL REFERENCES tennis.subjects(id),
  principal_cents bigint NOT NULL CHECK (principal_cents>0),
  gift_cents bigint NOT NULL CHECK (gift_cents>=0),
  offer_id text,
  expires_at timestamptz NOT NULL CHECK (isfinite(expires_at)),
  CHECK (principal_cents+gift_cents<=9007199254740991),
  FOREIGN KEY (tenant_id,venue_id) REFERENCES tennis.venues(tenant_id,id),
  FOREIGN KEY (tenant_id,customer_id) REFERENCES tennis.customers(tenant_id,id),
  FOREIGN KEY (tenant_id,offer_id) REFERENCES tennis.topup_offers(tenant_id,id),
  UNIQUE (tenant_id,customer_id,id)
);
CREATE TABLE tennis.topup_payments (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  venue_id text NOT NULL,
  customer_id text NOT NULL,
  quote_id text NOT NULL UNIQUE,
  provider text NOT NULL CHECK (provider IN ('MOCK','WECHAT')),
  merchant_id text NOT NULL,
  principal_cents bigint NOT NULL CHECK (principal_cents>0),
  gift_cents bigint NOT NULL CHECK (gift_cents>=0),
  status text NOT NULL CHECK (status IN ('PENDING','FAILED','SUCCEEDED')),
  wallet_batch_id text,
  provider_transaction_id text,
  created_by text NOT NULL REFERENCES tennis.subjects(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  settled_at timestamptz,
  CHECK (principal_cents+gift_cents<=9007199254740991),
  CHECK ((status='SUCCEEDED')=(wallet_batch_id IS NOT NULL AND provider_transaction_id IS NOT NULL AND settled_at IS NOT NULL)),
  FOREIGN KEY (tenant_id,venue_id) REFERENCES tennis.venues(tenant_id,id),
  FOREIGN KEY (tenant_id,customer_id,quote_id) REFERENCES tennis.topup_quotes(tenant_id,customer_id,id),
  FOREIGN KEY (tenant_id,customer_id,wallet_batch_id) REFERENCES tennis.wallet_batches(tenant_id,customer_id,id),
  UNIQUE (tenant_id,id),
  UNIQUE (provider,merchant_id,provider_transaction_id)
);
CREATE TABLE tennis.topup_events (
  provider text NOT NULL,
  merchant_id text NOT NULL,
  event_id text NOT NULL,
  tenant_id text NOT NULL,
  topup_id text NOT NULL,
  request_hash text NOT NULL,
  payload jsonb NOT NULL,
  outcome text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (provider,merchant_id,event_id),
  FOREIGN KEY (tenant_id,topup_id) REFERENCES tennis.topup_payments(tenant_id,id)
);
CREATE TABLE tennis.topup_exceptions (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  topup_id text NOT NULL,
  external_transaction_id text NOT NULL,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED')),
  details jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,topup_id) REFERENCES tennis.topup_payments(tenant_id,id),
  UNIQUE (tenant_id,topup_id,external_transaction_id)
);
