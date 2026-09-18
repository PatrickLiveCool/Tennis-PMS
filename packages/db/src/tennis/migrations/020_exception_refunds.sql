-- Exceptional cash receipts are refunded separately from order/wallet allocations.
ALTER TABLE tennis.financial_exceptions ADD CONSTRAINT financial_exceptions_tenant_id_id_key UNIQUE(tenant_id,id);
ALTER TABLE tennis.topup_exceptions ADD CONSTRAINT topup_exceptions_tenant_id_id_key UNIQUE(tenant_id,id);
CREATE TABLE tennis.exception_refunds (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  venue_id text NOT NULL,
  customer_id text NOT NULL,
  source_kind text NOT NULL CHECK(source_kind IN ('ORDER','TOPUP')),
  source_id text NOT NULL,
  exception_id text NOT NULL,
  order_exception_id text,
  topup_exception_id text,
  provider text NOT NULL CHECK(provider IN ('MOCK','WECHAT')),
  merchant_id text NOT NULL CHECK(length(btrim(merchant_id))>0),
  transaction_id text NOT NULL CHECK(length(btrim(transaction_id))>0),
  amount_cents bigint NOT NULL CHECK(amount_cents>0 AND amount_cents<=9007199254740991),
  status text NOT NULL CHECK(status IN ('REQUESTED','PROCESSING','SUCCEEDED','FAILED')),
  reason text NOT NULL CHECK(length(btrim(reason))>0 AND length(reason)<=2000),
  created_by text NOT NULL REFERENCES tennis.subjects(id),
  provider_refund_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  CHECK((status='SUCCEEDED')=(completed_at IS NOT NULL)),
  CHECK((status='SUCCEEDED')=(provider_refund_id IS NOT NULL)),
  CHECK((source_kind='ORDER' AND order_exception_id IS NOT NULL AND order_exception_id=exception_id AND topup_exception_id IS NULL)
     OR (source_kind='TOPUP' AND topup_exception_id IS NOT NULL AND topup_exception_id=exception_id AND order_exception_id IS NULL)),
  FOREIGN KEY(tenant_id,venue_id) REFERENCES tennis.venues(tenant_id,id),
  FOREIGN KEY(tenant_id,customer_id) REFERENCES tennis.customers(tenant_id,id),
  FOREIGN KEY(tenant_id,order_exception_id) REFERENCES tennis.financial_exceptions(tenant_id,id),
  FOREIGN KEY(tenant_id,topup_exception_id) REFERENCES tennis.topup_exceptions(tenant_id,id),
  FOREIGN KEY(provider,merchant_id,transaction_id) REFERENCES tennis.channel_transactions(provider,merchant_id,transaction_id),
  UNIQUE(tenant_id,id),
  UNIQUE(tenant_id,exception_id),
  UNIQUE(provider,merchant_id,transaction_id)
);
CREATE INDEX exception_refunds_tenant_status ON tennis.exception_refunds(tenant_id,status,created_at);
CREATE TABLE tennis.exception_refund_events (
  provider text NOT NULL,
  merchant_id text NOT NULL,
  event_id text NOT NULL,
  tenant_id text NOT NULL,
  refund_id text NOT NULL,
  request_hash text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(provider,merchant_id,event_id),
  FOREIGN KEY(tenant_id,refund_id) REFERENCES tennis.exception_refunds(tenant_id,id)
);
-- One provider refund number cannot settle both an order and an exceptional receipt.
CREATE TABLE tennis.cash_refund_transactions (
  provider text NOT NULL CHECK(provider IN ('MOCK','WECHAT')),
  merchant_id text NOT NULL,
  provider_refund_id text NOT NULL,
  tenant_id text NOT NULL REFERENCES tennis.tenants(id),
  source_kind text NOT NULL CHECK(source_kind IN ('ORDER','EXCEPTION')),
  source_id text NOT NULL,
  amount_cents bigint NOT NULL CHECK(amount_cents>0 AND amount_cents<=9007199254740991),
  transaction_id text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(provider,merchant_id,provider_refund_id)
);
INSERT INTO tennis.cash_refund_transactions(provider,merchant_id,provider_refund_id,tenant_id,source_kind,source_id,amount_cents,transaction_id,received_at)
  SELECT r.provider,r.merchant_id,r.provider_refund_id,r.tenant_id,'ORDER',r.refund_id,r.amount_cents,p.provider_transaction_id,r.received_at
  FROM tennis.external_refund_receipts r
  JOIN tennis.refunds f ON f.tenant_id=r.tenant_id AND f.id=r.refund_id
  JOIN tennis.payment_attempts p ON p.tenant_id=f.tenant_id AND p.id=f.payment_id;

CREATE FUNCTION tennis.guard_exception_refund_facts() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF ROW(NEW.id,NEW.tenant_id,NEW.venue_id,NEW.customer_id,NEW.source_kind,NEW.source_id,NEW.exception_id,
         NEW.order_exception_id,NEW.topup_exception_id,NEW.provider,NEW.merchant_id,NEW.transaction_id,
         NEW.amount_cents,NEW.reason,NEW.created_by,NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id,OLD.tenant_id,OLD.venue_id,OLD.customer_id,OLD.source_kind,OLD.source_id,OLD.exception_id,
         OLD.order_exception_id,OLD.topup_exception_id,OLD.provider,OLD.merchant_id,OLD.transaction_id,
         OLD.amount_cents,OLD.reason,OLD.created_by,OLD.created_at) THEN
    RAISE EXCEPTION 'exception refund facts are immutable';
  END IF;
  IF OLD.status='SUCCEEDED' AND ROW(NEW.status,NEW.provider_refund_id,NEW.completed_at)
    IS DISTINCT FROM ROW(OLD.status,OLD.provider_refund_id,OLD.completed_at) THEN
    RAISE EXCEPTION 'a successful exception refund cannot change';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER exception_refund_facts BEFORE UPDATE ON tennis.exception_refunds
  FOR EACH ROW EXECUTE FUNCTION tennis.guard_exception_refund_facts();

ALTER TABLE tennis.channel_operations DROP CONSTRAINT channel_operations_source_kind_check;
ALTER TABLE tennis.channel_operations ADD CONSTRAINT channel_operations_source_kind_check
  CHECK(source_kind IN ('ORDER','TOPUP','REFUND','EXCEPTION_REFUND'));
ALTER TABLE tennis.business_events DROP CONSTRAINT business_events_resource_type_check;
ALTER TABLE tennis.business_events ADD CONSTRAINT business_events_resource_type_check
  CHECK(resource_type IN ('order','order_line','amendment','payment','topup','wallet_batch','refund','conversation','exception_refund'));
CREATE FUNCTION tennis.capture_exception_refund_business_event() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.status IN ('SUCCEEDED','FAILED') AND (TG_OP='INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
    PERFORM tennis.append_business_event(NEW.tenant_id,NEW.venue_id,NEW.customer_id,NEW.created_by,
      'refund.result','exception_refund',NEW.id,jsonb_build_object(
        'exceptionId',NEW.exception_id,'refundId',NEW.id,'sourceKind',NEW.source_kind,'sourceId',NEW.source_id,
        'status',NEW.status,'amountCents',NEW.amount_cents,'walletCents',0,'externalCents',NEW.amount_cents,
        'currency','CNY','completedAt',NEW.completed_at));
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER business_event_exception_refund AFTER INSERT OR UPDATE OF status ON tennis.exception_refunds
  FOR EACH ROW EXECUTE FUNCTION tennis.capture_exception_refund_business_event();
