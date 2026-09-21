CREATE TABLE tennis.wecom_receipts (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tennis.tenants(id),
  corporation_id text NOT NULL,
  merchant_id text NOT NULL,
  transaction_id text NOT NULL,
  provider text NOT NULL CHECK(provider IN ('MOCK','WECHAT')),
  amount_cents bigint NOT NULL CHECK(amount_cents > 0 AND amount_cents <= 9007199254740991),
  currency text NOT NULL CHECK(currency='CNY'),
  paid_at timestamptz NOT NULL,
  simulation boolean NOT NULL,
  trusted_operation_id text,
  semantic_hash text NOT NULL,
  operation_id text,
  state text NOT NULL DEFAULT 'UNMATCHED' CHECK(state IN ('UNMATCHED','REVIEW','LINKED','EXCEPTION')),
  linked_by text,
  link_reason text,
  linked_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(tenant_id,corporation_id,merchant_id,transaction_id),
  UNIQUE(provider,merchant_id,transaction_id),
  FOREIGN KEY(tenant_id,operation_id) REFERENCES tennis.channel_operations(tenant_id,id),
  CHECK((operation_id IS NULL AND linked_at IS NULL AND state IN ('UNMATCHED','REVIEW')) OR
        (operation_id IS NOT NULL AND linked_at IS NOT NULL AND state IN ('LINKED','EXCEPTION'))),
  CHECK((simulation AND provider='MOCK') OR (NOT simulation AND provider='WECHAT'))
);
CREATE INDEX wecom_receipts_tenant_created_idx ON tennis.wecom_receipts(tenant_id,created_at DESC,id);
CREATE FUNCTION tennis.protect_wecom_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id,NEW.tenant_id,NEW.corporation_id,NEW.merchant_id,NEW.transaction_id,NEW.provider,NEW.amount_cents,
      NEW.currency,NEW.paid_at,NEW.simulation,NEW.trusted_operation_id,NEW.semantic_hash,NEW.created_at)
     IS DISTINCT FROM
     (OLD.id,OLD.tenant_id,OLD.corporation_id,OLD.merchant_id,OLD.transaction_id,OLD.provider,OLD.amount_cents,
      OLD.currency,OLD.paid_at,OLD.simulation,OLD.trusted_operation_id,OLD.semantic_hash,OLD.created_at) THEN
    RAISE EXCEPTION 'WeCom collection facts are immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.operation_id IS NOT NULL AND (NEW.operation_id,NEW.linked_by,NEW.link_reason,NEW.linked_at)
     IS DISTINCT FROM (OLD.operation_id,OLD.linked_by,OLD.link_reason,OLD.linked_at) THEN
    RAISE EXCEPTION 'WeCom receipt association is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER wecom_receipt_immutable BEFORE UPDATE ON tennis.wecom_receipts
FOR EACH ROW EXECUTE FUNCTION tennis.protect_wecom_receipt();
