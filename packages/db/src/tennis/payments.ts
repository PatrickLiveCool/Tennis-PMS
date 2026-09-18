import { randomUUID } from "node:crypto";
import type pg from "pg";
import { assertCents } from "../../../domain/src/tennis-pricing.ts";
import { TennisWalletError } from "../../../domain/src/tennis-wallet.ts";
import { recordTenantAudit, TenantAccessError } from "./access.ts";
import {
  expireVenueHolds,
  locateOrder,
  orderInTransaction,
  releaseOrderInventory,
  requireBookingVenue,
} from "./booking.ts";
import { isCustomerActor, requireCustomer, withBookingTransaction, type BookingActor } from "./customers.ts";
import { isVerifiedPaymentEvent, type LocalMockPaymentGateway, type VerifiedPaymentEvent } from "./mock-payments.ts";
import { idempotentCommand, requestHash } from "./receipts.ts";
import { lockTenantTransactions } from "./transaction-locks.ts";
import { reserveWallet, settleWalletReservation } from "./wallet-store.ts";
import {
  amendmentInTransaction,
  applyAmendmentInTransaction,
  expireVenueAmendments,
  releaseAmendmentInTransaction,
} from "./amendments.ts";
import { claimChannelTransaction } from "./channel-transactions.ts";

export interface PaymentRecord {
  id: string;
  amendmentId: string | null;
  orderId: string;
  customerId: string;
  venueId: string;
  provider: "MOCK" | "WECHAT" | "WALLET";
  merchantId: string;
  externalCents: number;
  walletCents: number;
  currency: "CNY";
  status: "PENDING" | "SUCCEEDED" | "FAILED" | "EXPIRED" | "CANCELLED" | "REFUND_REQUIRED";
  providerTransactionId: string | null;
  createdAt: string;
  settledAt: string | null;
}
type PaymentRow = Omit<PaymentRecord, "createdAt" | "settledAt"> & { createdAt: Date; settledAt: Date | null };
const paymentColumns = `id,amendment_id AS "amendmentId",order_id AS "orderId",customer_id AS "customerId",venue_id AS "venueId",provider,merchant_id AS "merchantId",
  external_cents::float8 AS "externalCents",wallet_cents::float8 AS "walletCents",currency,status,provider_transaction_id AS "providerTransactionId",
  created_at AS "createdAt",settled_at AS "settledAt"`;
export async function paymentInTransaction(tx: pg.PoolClient, tenantId: string, id: string): Promise<PaymentRecord> {
  const row = (
    await tx.query<PaymentRow>(
      `SELECT ${paymentColumns} FROM tennis.payment_attempts WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
      [tenantId, id],
    )
  ).rows[0];
  if (!row) throw new TenantAccessError("RESOURCE_NOT_FOUND");
  return { ...row, createdAt: row.createdAt.toISOString(), settledAt: row.settledAt?.toISOString() ?? null };
}
export async function beginOrderPayment(
  db: pg.Pool,
  actor: BookingActor,
  gateway: LocalMockPaymentGateway,
  input: {
    orderId: string;
    walletCents: number;
    commandKey: string;
    staffReason?: string;
  },
): Promise<PaymentRecord> {
  assertCents(input.walletCents);
  return withBookingTransaction(db, actor, async (tx) => {
    const venueId = await locateOrder(tx, actor, input.orderId);
    await requireBookingVenue(tx, actor, venueId, "book");
    if (!isCustomerActor(actor) && input.walletCents > 0) {
      await requireBookingVenue(tx, actor, venueId, "manage_members");
      if (!input.staffReason?.trim() || input.staffReason.length > 2000)
        throw new TennisWalletError("INVALID_WALLET_AMOUNT");
    }
    await expireVenueHolds(tx, actor.tenantId, venueId);
    const { commandKey, ...request } = input;
    const result = await idempotentCommand(tx, actor, venueId, commandKey, "order.payment", request, async () => {
      const order = await orderInTransaction(tx, actor, input.orderId);
      await requireCustomer(tx, actor, order.customerId);
      if (order.status !== "HELD" || order.paymentStatus !== "UNPAID") throw new TennisWalletError("ORDER_NOT_PAYABLE");
      if (input.walletCents > order.totalCents) throw new TennisWalletError("INVALID_WALLET_AMOUNT");
      const pending = await tx.query(
        "SELECT id FROM tennis.payment_attempts WHERE tenant_id=$1 AND order_id=$2 AND status='PENDING'",
        [actor.tenantId, order.id],
      );
      if (pending.rowCount) throw new TennisWalletError("PAYMENT_ALREADY_PENDING");
      const paymentId = randomUUID();
      const externalCents = order.totalCents - input.walletCents;
      await tx.query(
        `INSERT INTO tennis.payment_attempts (id,tenant_id,venue_id,customer_id,order_id,provider,merchant_id,external_cents,wallet_cents,status,created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'PENDING',$10)`,
        [
          paymentId,
          actor.tenantId,
          venueId,
          order.customerId,
          order.id,
          externalCents ? gateway.provider : "WALLET",
          externalCents ? gateway.merchantForTenant(actor.tenantId) : `wallet:${actor.tenantId}`,
          externalCents,
          input.walletCents,
          actor.subjectId,
        ],
      );
      await reserveWallet(tx, actor.tenantId, order.customerId, paymentId, input.walletCents);
      const live = await tx.query(
        "SELECT id FROM tennis.orders WHERE tenant_id=$1 AND id=$2 AND hold_until>clock_timestamp()",
        [actor.tenantId, order.id],
      );
      if (!live.rowCount) throw new TennisWalletError("ORDER_NOT_PAYABLE");
      if (externalCents === 0) {
        await settleWalletReservation(tx, actor.tenantId, order.customerId, paymentId, true);
        await tx.query(
          "UPDATE tennis.payment_attempts SET status='SUCCEEDED',settled_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",
          [actor.tenantId, paymentId],
        );
        await tx.query(
          "UPDATE tennis.orders SET status='CONFIRMED',payment_status='PAID',hold_until=NULL,revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",
          [actor.tenantId, order.id],
        );
      }
      await recordTenantAudit(tx, actor, "payment.begin", paymentId, {
        orderId: order.id,
        walletCents: input.walletCents,
        externalCents,
        provider: externalCents ? gateway.provider : "WALLET",
        staffReason: input.staffReason ?? null,
      });
      return { paymentId };
    });
    return paymentInTransaction(tx, actor.tenantId, result.paymentId);
  });
}
export async function getOrderPayment(db: pg.Pool, actor: BookingActor, paymentId: string): Promise<PaymentRecord> {
  return withBookingTransaction(db, actor, async (tx) => {
    const located = (
      await tx.query<{ order_id: string }>(
        "SELECT order_id FROM tennis.payment_attempts WHERE tenant_id=$1 AND id=$2",
        [actor.tenantId, paymentId],
      )
    ).rows[0];
    if (!located) throw new TenantAccessError("RESOURCE_NOT_FOUND");
    const venueId = await locateOrder(tx, actor, located.order_id);
    await requireBookingVenue(tx, actor, venueId, "read");
    await expireVenueHolds(tx, actor.tenantId, venueId);
    return paymentInTransaction(tx, actor.tenantId, paymentId);
  });
}
async function financialException(
  tx: pg.PoolClient,
  tenantId: string,
  payment: PaymentRecord,
  event: VerifiedPaymentEvent,
  kind: "LATE_PAYMENT" | "DUPLICATE_PAYMENT",
): Promise<void> {
  await tx.query(
    `INSERT INTO tennis.financial_exceptions (id,tenant_id,payment_id,kind,external_transaction_id,details)
    VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT (tenant_id,payment_id,kind,external_transaction_id) DO NOTHING`,
    [
      randomUUID(),
      tenantId,
      payment.id,
      kind,
      event.transactionId,
      JSON.stringify({
        orderId: payment.orderId,
        externalCents: event.amountCents,
        merchantId: event.merchantId,
        provider: event.provider,
        requiredAction: "REFUND_EXTERNAL_PAYMENT",
      }),
    ],
  );
}
/** Only accepts an event authenticated by a payment gateway, never a request-body cast. */
export async function settleVerifiedPayment(db: pg.Pool, event: VerifiedPaymentEvent): Promise<PaymentRecord> {
  if (!isVerifiedPaymentEvent(event)) throw new TennisWalletError("INVALID_PAYMENT_EVENT");
  const located = (
    await db.query<{ tenant_id: string; venue_id: string; order_id: string }>(
      "SELECT tenant_id,venue_id,order_id FROM tennis.payment_attempts WHERE id=$1",
      [event.paymentId],
    )
  ).rows[0];
  if (!located) throw new TennisWalletError("INVALID_PAYMENT_EVENT");
  const tenantId = located.tenant_id;
  const actor = { tenantId, subjectId: "system:tennis" };
  const tx = await db.connect();
  try {
    await tx.query("BEGIN");
    await lockTenantTransactions(tx, tenantId);
    await tx.query("SELECT id FROM tennis.venues WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [
      tenantId,
      located.venue_id,
    ]);
    await expireVenueHolds(tx, tenantId, located.venue_id);
    await expireVenueAmendments(tx, tenantId, located.venue_id);
    let order = await orderInTransaction(tx, actor, located.order_id);
    let payment = await paymentInTransaction(tx, tenantId, event.paymentId);
    if (
      payment.provider !== event.provider ||
      payment.merchantId !== event.merchantId ||
      payment.externalCents !== event.amountCents ||
      payment.currency !== event.currency
    )
      throw new TennisWalletError("INVALID_PAYMENT_EVENT");
    const hash = requestHash(event);
    const oldEvent = (
      await tx.query<{ request_hash: string; payment_id: string }>(
        "SELECT request_hash,payment_id FROM tennis.payment_events WHERE provider=$1 AND merchant_id=$2 AND event_id=$3",
        [event.provider, event.merchantId, event.eventId],
      )
    ).rows[0];
    if (oldEvent) {
      if (oldEvent.request_hash !== hash || oldEvent.payment_id !== payment.id)
        throw new TennisWalletError("PAYMENT_EVENT_REUSED");
      await tx.query("COMMIT");
      return payment;
    }
    let outcome: string = "IGNORED";
    if (order.status === "HELD") {
      await expireVenueHolds(tx, tenantId, located.venue_id);
      order = await orderInTransaction(tx, actor, located.order_id);
      payment = await paymentInTransaction(tx, tenantId, event.paymentId);
    }
    if (event.status === "SUCCEEDED") {
      await claimChannelTransaction(tx, { ...event, tenantId, sourceType: "ORDER", sourceId: payment.id });
      await tx.query(
        `INSERT INTO tennis.external_payment_receipts (provider,merchant_id,transaction_id,tenant_id,payment_id,amount_cents)
        VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
        [event.provider, event.merchantId, event.transactionId, tenantId, payment.id, event.amountCents],
      );
      const claimed = (
        await tx.query<{ payment_id: string }>(
          "SELECT payment_id FROM tennis.external_payment_receipts WHERE provider=$1 AND merchant_id=$2 AND transaction_id=$3",
          [event.provider, event.merchantId, event.transactionId],
        )
      ).rows[0]!;
      if (claimed.payment_id !== payment.id) throw new TennisWalletError("PAYMENT_TRANSACTION_REUSED");
      if (payment.providerTransactionId) {
        if (payment.providerTransactionId === event.transactionId) outcome = "DUPLICATE_EVENT";
        else {
          await financialException(tx, tenantId, payment, event, "DUPLICATE_PAYMENT");
          outcome = "REFUND_REQUIRED";
        }
      } else if (payment.amendmentId) {
        const amendment = await amendmentInTransaction(tx, tenantId, payment.amendmentId);
        let applied = false;
        if (
          payment.status === "PENDING" &&
          amendment.status === "AWAITING_PAYMENT" &&
          order.status === "CONFIRMED" &&
          order.revision === amendment.baseRevision
        ) {
          await tx.query("SAVEPOINT apply_paid_amendment");
          try {
            await settleWalletReservation(tx, tenantId, payment.customerId, payment.id, true);
            await tx.query(
              "UPDATE tennis.payment_attempts SET status='SUCCEEDED',provider_transaction_id=$1,settled_at=clock_timestamp() WHERE tenant_id=$2 AND id=$3",
              [event.transactionId, tenantId, payment.id],
            );
            await applyAmendmentInTransaction(tx, tenantId, payment.amendmentId);
            applied = true;
          } catch (error) {
            // Known business rejection after cash arrived must preserve the original booking and create a refund task.
            if (
              ![
                "TennisAmendmentError",
                "TennisCatalogError",
                "TennisPricingError",
                "TenantAccessError",
                "CourtInventoryError",
              ].includes((error as Error).name)
            )
              throw error;
            await tx.query("ROLLBACK TO SAVEPOINT apply_paid_amendment");
          }
          await tx.query("RELEASE SAVEPOINT apply_paid_amendment");
        }
        if (applied) outcome = "SUCCEEDED";
        else {
          await releaseAmendmentInTransaction(tx, tenantId, payment.amendmentId, "CANCELLED");
          await settleWalletReservation(tx, tenantId, payment.customerId, payment.id, false);
          await tx.query(
            "UPDATE tennis.payment_attempts SET status='REFUND_REQUIRED',provider_transaction_id=$1,settled_at=clock_timestamp() WHERE tenant_id=$2 AND id=$3",
            [event.transactionId, tenantId, payment.id],
          );
          await financialException(tx, tenantId, payment, event, "LATE_PAYMENT");
          outcome = "REFUND_REQUIRED";
        }
      } else if (payment.status === "PENDING" && order.status === "HELD" && order.paymentStatus === "UNPAID") {
        await settleWalletReservation(tx, tenantId, payment.customerId, payment.id, true);
        await tx.query(
          "UPDATE tennis.payment_attempts SET status='SUCCEEDED',provider_transaction_id=$1,settled_at=clock_timestamp() WHERE tenant_id=$2 AND id=$3",
          [event.transactionId, tenantId, payment.id],
        );
        await tx.query(
          "UPDATE tennis.orders SET status='CONFIRMED',payment_status='PAID',hold_until=NULL,revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",
          [tenantId, order.id],
        );
        outcome = "SUCCEEDED";
      } else {
        await settleWalletReservation(tx, tenantId, payment.customerId, payment.id, false);
        await tx.query(
          "UPDATE tennis.payment_attempts SET status='REFUND_REQUIRED',provider_transaction_id=$1,settled_at=clock_timestamp() WHERE tenant_id=$2 AND id=$3",
          [event.transactionId, tenantId, payment.id],
        );
        await financialException(tx, tenantId, payment, event, "LATE_PAYMENT");
        outcome = "REFUND_REQUIRED";
      }
    } else if (payment.status === "PENDING") {
      await settleWalletReservation(tx, tenantId, payment.customerId, payment.id, false);
      await tx.query(
        "UPDATE tennis.payment_attempts SET status='FAILED',settled_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",
        [tenantId, payment.id],
      );
      if (payment.amendmentId) await releaseAmendmentInTransaction(tx, tenantId, payment.amendmentId, "CANCELLED");
      else {
        await releaseOrderInventory(tx, tenantId, order.id);
        await tx.query(
          "UPDATE tennis.order_lines SET cancelled_at=clock_timestamp() WHERE tenant_id=$1 AND order_id=$2 AND cancelled_at IS NULL",
          [tenantId, order.id],
        );
        await tx.query(
          "UPDATE tennis.orders SET status='CANCELLED',hold_until=NULL,revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",
          [tenantId, order.id],
        );
      }
      outcome = "FAILED";
    }
    await tx.query(
      "INSERT INTO tennis.payment_events (provider,merchant_id,event_id,tenant_id,payment_id,request_hash,payload,outcome) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)",
      [event.provider, event.merchantId, event.eventId, tenantId, payment.id, hash, JSON.stringify(event), outcome],
    );
    await recordTenantAudit(tx, actor, "payment.event", payment.id, { eventId: event.eventId, outcome });
    const result = await paymentInTransaction(tx, tenantId, payment.id);
    await tx.query("COMMIT");
    return result;
  } catch (error) {
    await tx.query("ROLLBACK");
    if ((error as { code?: string }).code === "23505") throw new TennisWalletError("PAYMENT_TRANSACTION_REUSED");
    throw error;
  } finally {
    tx.release();
  }
}
