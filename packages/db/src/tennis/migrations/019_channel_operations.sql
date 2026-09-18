CREATE TABLE tennis.channel_operations (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tennis.tenants(id),
  source_kind text NOT NULL CHECK(source_kind IN ('ORDER','TOPUP','REFUND')),
  source_id text NOT NULL,
  generation integer NOT NULL DEFAULT 1 CHECK(generation > 0),
  binding_id text NOT NULL,
  provider text NOT NULL CHECK(provider IN ('MOCK','WECHAT')),
  request jsonb NOT NULL,
  request_hash text NOT NULL,
  state text NOT NULL DEFAULT 'READY' CHECK(state IN ('READY','IN_FLIGHT','UNKNOWN','PENDING','SUCCEEDED','FAILED')),
  lease_token text,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  checkout jsonb,
  last_checked_at timestamptz,
  next_check_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(tenant_id,source_kind,source_id,generation),
  UNIQUE(tenant_id,id),
  FOREIGN KEY(tenant_id,binding_id) REFERENCES tennis.payment_merchant_bindings(tenant_id,id)
);
CREATE INDEX channel_operations_due_idx ON tennis.channel_operations(next_check_at) WHERE state NOT IN ('SUCCEEDED','FAILED');
CREATE FUNCTION tennis.protect_channel_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id,NEW.tenant_id,NEW.source_kind,NEW.source_id,NEW.generation,NEW.binding_id,NEW.provider,NEW.request,NEW.request_hash,NEW.created_at)
     IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.source_kind,OLD.source_id,OLD.generation,OLD.binding_id,OLD.provider,OLD.request,OLD.request_hash,OLD.created_at) THEN
    RAISE EXCEPTION 'Channel request identity is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER channel_request_immutable BEFORE UPDATE ON tennis.channel_operations
FOR EACH ROW EXECUTE FUNCTION tennis.protect_channel_request();
CREATE TABLE tennis.channel_observations (
  id text PRIMARY KEY,
  operation_id text NOT NULL REFERENCES tennis.channel_operations(id),
  tenant_id text NOT NULL,
  provider text NOT NULL,
  merchant_id text NOT NULL,
  event_kind text NOT NULL CHECK(event_kind IN ('PAYMENT','REFUND')),
  event_id text NOT NULL,
  semantic_hash text NOT NULL,
  payload jsonb NOT NULL,
  applied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(tenant_id,operation_id) REFERENCES tennis.channel_operations(tenant_id,id),
  UNIQUE(provider,merchant_id,event_kind,event_id)
);
CREATE TABLE tennis.mock_channel_records (
  operation_id text PRIMARY KEY REFERENCES tennis.channel_operations(id),
  tenant_id text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('PAYMENT','REFUND')),
  merchant_id text NOT NULL,
  merchant_reference text NOT NULL,
  record jsonb NOT NULL,
  FOREIGN KEY(tenant_id,operation_id) REFERENCES tennis.channel_operations(tenant_id,id),
  UNIQUE(kind,merchant_id,merchant_reference)
);
