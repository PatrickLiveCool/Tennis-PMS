ALTER TABLE tennis.order_amendments ADD COLUMN unpaid boolean NOT NULL DEFAULT false;
ALTER TABLE tennis.order_amendments ADD CHECK (NOT unpaid OR (supplemental_cents=0 AND suggested_refund_cents=0 AND status<>'AWAITING_PAYMENT'));

-- Preserve cancelled line prices for history without funding them in the later payment.
ALTER TABLE tennis.order_lines ADD COLUMN cancelled_before_payment boolean NOT NULL DEFAULT false;
ALTER TABLE tennis.order_lines ADD CHECK (NOT cancelled_before_payment OR (cancelled_at IS NOT NULL AND initial_funding_cents=0));
