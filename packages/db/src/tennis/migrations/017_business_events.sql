-- Business facts and their external event are committed or rolled back together.
-- A transactional per-tenant counter, not a database sequence, serializes publication.
CREATE TABLE tennis.business_event_counters (
  tenant_id text PRIMARY KEY REFERENCES tennis.tenants(id) ON DELETE CASCADE,
  last_sequence bigint NOT NULL CHECK (last_sequence>0)
);
CREATE TABLE tennis.business_events (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL REFERENCES tennis.tenants(id) ON DELETE CASCADE,
  venue_id text NOT NULL,
  customer_id text,
  subject_id text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN (
    'booking.held','booking.confirmed','booking.cancelled','booking.line_cancelled','booking.expired','booking.amended',
    'payment.result','topup.result','refund.result','conversation.handoff'
  )),
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version=1),
  resource_type text NOT NULL CHECK (resource_type IN ('order','order_line','amendment','payment','topup','wallet_batch','refund','conversation')),
  resource_id text NOT NULL CHECK (length(btrim(resource_id))>0),
  resource_version integer NOT NULL CHECK (resource_version>0),
  tenant_sequence bigint NOT NULL CHECK (tenant_sequence>0),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
  UNIQUE (tenant_id,tenant_sequence),
  UNIQUE (tenant_id,resource_type,resource_id,resource_version)
);
CREATE INDEX business_events_venue_poll ON tennis.business_events(tenant_id,venue_id,tenant_sequence);
CREATE INDEX business_events_customer_poll ON tennis.business_events(tenant_id,venue_id,customer_id,tenant_sequence);

CREATE FUNCTION tennis.append_business_event(
  p_tenant text, p_venue text, p_customer text, p_subject text, p_type text,
  p_resource_type text, p_resource_id text, p_payload jsonb
) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE
  sequence_value bigint;
  version_value integer;
BEGIN
  -- The row lock is retained until COMMIT. A later event in this tenant cannot
  -- become visible first, even if a caller did not take the application lock.
  INSERT INTO tennis.business_event_counters(tenant_id,last_sequence) VALUES(p_tenant,1)
    ON CONFLICT (tenant_id) DO UPDATE
    SET last_sequence=tennis.business_event_counters.last_sequence+1
    RETURNING last_sequence INTO sequence_value;
  SELECT coalesce(max(resource_version),0)+1 INTO version_value
    FROM tennis.business_events
    WHERE tenant_id=p_tenant AND resource_type=p_resource_type AND resource_id=p_resource_id;
  INSERT INTO tennis.business_events(tenant_id,venue_id,customer_id,subject_id,event_type,
    resource_type,resource_id,resource_version,tenant_sequence,payload)
    VALUES(p_tenant,p_venue,p_customer,p_subject,p_type,p_resource_type,p_resource_id,version_value,sequence_value,p_payload);
END;
$$;

CREATE FUNCTION tennis.capture_business_event() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE
  event_type text;
  source_order tennis.orders%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME='orders' THEN
    IF TG_OP='UPDATE' AND OLD.status IS NOT DISTINCT FROM NEW.status THEN RETURN NEW; END IF;
    event_type := CASE NEW.status
      WHEN 'HELD' THEN CASE WHEN TG_OP='INSERT' THEN 'booking.held' END
      WHEN 'CONFIRMED' THEN 'booking.confirmed'
      WHEN 'CANCELLED' THEN 'booking.cancelled'
      WHEN 'EXPIRED' THEN 'booking.expired'
    END;
    IF event_type IS NOT NULL THEN
      PERFORM tennis.append_business_event(NEW.tenant_id,NEW.venue_id,NEW.customer_id,NEW.created_by,
        event_type,'order',NEW.id,jsonb_build_object(
          'orderId',NEW.id,'status',NEW.status,'paymentStatus',NEW.payment_status,
          'totalCents',NEW.total_cents,'currency',NEW.currency,'holdKind',NEW.hold_kind,
          'holdUntil',NEW.hold_until,'orderRevision',NEW.revision));
    END IF;
  ELSIF TG_TABLE_NAME='order_lines' THEN
    IF OLD.cancelled_at IS NULL AND NEW.cancelled_at IS NOT NULL THEN
      SELECT * INTO STRICT source_order FROM tennis.orders WHERE tenant_id=NEW.tenant_id AND id=NEW.order_id;
      PERFORM tennis.append_business_event(NEW.tenant_id,NEW.venue_id,source_order.customer_id,source_order.created_by,
        'booking.line_cancelled','order_line',NEW.id,jsonb_build_object(
          'orderId',NEW.order_id,'lineId',NEW.id,'courtId',NEW.court_id,'startAt',NEW.start_at,
          'endAt',NEW.end_at,'cancelledAt',NEW.cancelled_at));
    END IF;
  ELSIF TG_TABLE_NAME='order_amendments' THEN
    IF NEW.status='APPLIED' AND OLD.status IS DISTINCT FROM NEW.status THEN
      PERFORM tennis.append_business_event(NEW.tenant_id,NEW.venue_id,NEW.customer_id,NEW.created_by,
        'booking.amended','amendment',NEW.id,jsonb_build_object(
          'orderId',NEW.order_id,'amendmentId',NEW.id,'status',NEW.status,'unpaid',NEW.unpaid,
          'supplementalCents',NEW.supplemental_cents,'approvedRefundCents',NEW.approved_refund_cents,
          'appliedAt',NEW.applied_at));
    END IF;
  ELSIF TG_TABLE_NAME='payment_attempts' THEN
    IF NEW.status<>'PENDING' AND (TG_OP='INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
      PERFORM tennis.append_business_event(NEW.tenant_id,NEW.venue_id,NEW.customer_id,NEW.created_by,
        'payment.result','payment',NEW.id,jsonb_build_object(
          'orderId',NEW.order_id,'paymentId',NEW.id,'amendmentId',NEW.amendment_id,'status',NEW.status,
          'walletCents',NEW.wallet_cents,'externalCents',NEW.external_cents,'currency',NEW.currency,
          'settledAt',NEW.settled_at));
    END IF;
  ELSIF TG_TABLE_NAME='topup_payments' THEN
    IF NEW.status IN ('SUCCEEDED','FAILED') AND (TG_OP='INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
      PERFORM tennis.append_business_event(NEW.tenant_id,NEW.venue_id,NEW.customer_id,NEW.created_by,
        'topup.result','topup',NEW.id,jsonb_build_object(
          'topupId',NEW.id,'status',NEW.status,'sourceKind',NEW.provider,
          'principalCents',NEW.principal_cents,'giftCents',NEW.gift_cents,'currency','CNY',
          'walletBatchId',NEW.wallet_batch_id,'settledAt',NEW.settled_at));
    END IF;
  ELSIF TG_TABLE_NAME='wallet_batches' THEN
    -- Online batches are covered by the topup payment's SUCCEEDED transition.
    IF NEW.source_kind='OFFLINE' THEN
      PERFORM tennis.append_business_event(NEW.tenant_id,NEW.venue_id,NEW.customer_id,NEW.created_by,
        'topup.result','wallet_batch',NEW.id,jsonb_build_object(
          'walletBatchId',NEW.id,'status','SUCCEEDED','sourceKind','OFFLINE',
          'principalCents',NEW.principal_cents,'giftCents',NEW.gift_cents,'currency','CNY',
          'settledAt',NEW.credited_at));
    END IF;
  ELSIF TG_TABLE_NAME='refunds' THEN
    IF NEW.status IN ('SUCCEEDED','FAILED') AND (TG_OP='INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
      PERFORM tennis.append_business_event(NEW.tenant_id,NEW.venue_id,NEW.customer_id,NEW.created_by,
        'refund.result','refund',NEW.id,jsonb_build_object(
          'orderId',NEW.order_id,'paymentId',NEW.payment_id,'refundId',NEW.id,'refundGroupId',NEW.group_id,
          'status',NEW.status,'amountCents',NEW.amount_cents,'walletCents',NEW.wallet_cents,
          'externalCents',NEW.external_cents,'currency','CNY','completedAt',NEW.completed_at));
    END IF;
  ELSIF TG_TABLE_NAME='agent_conversations' THEN
    IF OLD.generation IS DISTINCT FROM NEW.generation THEN
      PERFORM tennis.append_business_event(NEW.tenant_id,NEW.venue_id,NEW.customer_id,NEW.subject_id,
        'conversation.handoff','conversation',NEW.id,jsonb_build_object(
          'conversationId',NEW.id,'mode',NEW.mode,'generation',NEW.generation,'takenBy',NEW.taken_by));
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER business_event_order AFTER INSERT OR UPDATE OF status ON tennis.orders
  FOR EACH ROW EXECUTE FUNCTION tennis.capture_business_event();
CREATE TRIGGER business_event_line_cancel AFTER UPDATE OF cancelled_at ON tennis.order_lines
  FOR EACH ROW EXECUTE FUNCTION tennis.capture_business_event();
CREATE TRIGGER business_event_amendment AFTER UPDATE OF status ON tennis.order_amendments
  FOR EACH ROW EXECUTE FUNCTION tennis.capture_business_event();
CREATE TRIGGER business_event_payment AFTER INSERT OR UPDATE OF status ON tennis.payment_attempts
  FOR EACH ROW EXECUTE FUNCTION tennis.capture_business_event();
CREATE TRIGGER business_event_topup AFTER INSERT OR UPDATE OF status ON tennis.topup_payments
  FOR EACH ROW EXECUTE FUNCTION tennis.capture_business_event();
CREATE TRIGGER business_event_offline_topup AFTER INSERT ON tennis.wallet_batches
  FOR EACH ROW EXECUTE FUNCTION tennis.capture_business_event();
CREATE TRIGGER business_event_refund AFTER INSERT OR UPDATE OF status ON tennis.refunds
  FOR EACH ROW EXECUTE FUNCTION tennis.capture_business_event();
CREATE TRIGGER business_event_handoff AFTER UPDATE OF generation ON tennis.agent_conversations
  FOR EACH ROW EXECUTE FUNCTION tennis.capture_business_event();
