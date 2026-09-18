CREATE TABLE tennis.payment_merchant_bindings (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tennis.tenants(id),
  version integer NOT NULL CHECK (version > 0),
  provider text NOT NULL CHECK (provider IN ('MOCK', 'WECHAT')),
  merchant_id text NOT NULL CHECK (length(merchant_id) BETWEEN 1 AND 200 AND merchant_id ~ '^[^[:space:][:cntrl:]]+$'),
  app_id text CHECK (app_id IS NULL OR (length(app_id) BETWEEN 1 AND 200 AND app_id ~ '^[^[:space:][:cntrl:]]+$')),
  credential_ref text CHECK (credential_ref IS NULL OR (length(credential_ref) BETWEEN 1 AND 500 AND credential_ref ~ '^[^[:space:][:cntrl:]]+$')),
  active boolean NOT NULL DEFAULT true,
  created_by text REFERENCES tennis.subjects(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (provider <> 'WECHAT' OR (app_id IS NOT NULL AND credential_ref IS NOT NULL)),
  UNIQUE (tenant_id, provider, version),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX payment_merchant_active_idx ON tennis.payment_merchant_bindings(tenant_id, provider) WHERE active;

-- Payment and refund rows retain this immutable identity even after accepting new
-- payments is disabled. Rotation creates a new row instead of rewriting history.
CREATE FUNCTION tennis.protect_payment_merchant_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'active') IS DISTINCT FROM (to_jsonb(OLD) - 'active')
     OR (NOT OLD.active AND NEW.active) THEN
    RAISE EXCEPTION 'Payment merchant snapshots are immutable; create a new version'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payment_merchant_snapshot_immutable BEFORE UPDATE ON tennis.payment_merchant_bindings
  FOR EACH ROW EXECUTE FUNCTION tennis.protect_payment_merchant_snapshot();
