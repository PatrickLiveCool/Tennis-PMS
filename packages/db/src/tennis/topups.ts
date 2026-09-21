import { randomUUID } from "node:crypto";
import type pg from "pg";
import { assertCents } from "../../../domain/src/tennis-pricing.ts";
import { TennisWalletError } from "../../../domain/src/tennis-wallet.ts";
import { recordTenantAudit, requireTenantPermission, TenantAccessError, type TenantActor } from "./access.ts";
import { requireBookingVenue } from "./booking.ts";
import { venueInTransaction } from "./catalog.ts";
import { claimChannelTransaction } from "./channel-transactions.ts";
import { isCustomerActor, requireCustomer, withBookingTransaction, type BookingActor } from "./customers.ts";
import {
  isVerifiedPaymentEvent,
  paymentEventSemanticHash,
  type PaymentProviderPort,
  type VerifiedPaymentEvent,
  type PaymentSettlementTransactionHook,
} from "./payment-port.ts";
import { resolvePaymentMerchant, enqueuePaymentChannel } from "./channel-intents.ts";
import { idempotentCommand, requestHash } from "./receipts.ts";
import { lockTenantTransactions } from "./transaction-locks.ts";
import { creditWalletBatch } from "./wallet-store.ts";

export interface TopupOffer {
  id: string;
  name: string;
  principalCents: number;
  giftCents: number;
  active: boolean;
  revision: number;
}
export interface TopupQuote {
  id: string;
  venueId: string;
  customerId: string;
  principalCents: number;
  giftCents: number;
  offerId: string | null;
  expiresAt: string;
}
export interface TopupPayment {
  id: string;
  venueId: string;
  customerId: string;
  quoteId: string;
  provider: "MOCK" | "WECHAT";
  merchantId: string;
  principalCents: number;
  giftCents: number;
  status: "PENDING" | "FAILED" | "SUCCEEDED";
  walletBatchId: string | null;
  providerTransactionId: string | null;
  createdAt: string;
  settledAt: string | null;
}
type QuoteRow = Omit<TopupQuote, "expiresAt"> & { expiresAt: Date; createdBy: string };
type TopupRow = Omit<TopupPayment, "createdAt" | "settledAt"> & { createdAt: Date; settledAt: Date | null };
const offerColumns = `id,name,principal_cents::float8 AS "principalCents",gift_cents::float8 AS "giftCents",active,revision`;
const quoteColumns = `id,venue_id AS "venueId",customer_id AS "customerId",created_by AS "createdBy",principal_cents::float8 AS "principalCents",gift_cents::float8 AS "giftCents",offer_id AS "offerId",expires_at AS "expiresAt"`;
const paymentColumns = `id,venue_id AS "venueId",customer_id AS "customerId",quote_id AS "quoteId",provider,merchant_id AS "merchantId",
  principal_cents::float8 AS "principalCents",gift_cents::float8 AS "giftCents",status,wallet_batch_id AS "walletBatchId",provider_transaction_id AS "providerTransactionId",created_at AS "createdAt",settled_at AS "settledAt"`;
async function authorizeTopup(
  tx: pg.PoolClient,
  actor: BookingActor,
  venueId: string,
  customerId: string,
): Promise<void> {
  await requireBookingVenue(tx, actor, venueId, isCustomerActor(actor) ? "read" : "manage_members");
  await requireCustomer(tx, actor, customerId);
}
async function paymentInTransaction(tx: pg.PoolClient, tenantId: string, id: string): Promise<TopupPayment> {
  const row = (
    await tx.query<TopupRow>(
      `SELECT ${paymentColumns} FROM tennis.topup_payments WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
      [tenantId, id],
    )
  ).rows[0];
  if (!row) throw new TenantAccessError("RESOURCE_NOT_FOUND");
  return { ...row, createdAt: row.createdAt.toISOString(), settledAt: row.settledAt?.toISOString() ?? null };
}
export async function saveTopupOffer(
  db: pg.Pool,
  actor: TenantActor,
  input: {
    id?: string;
    expectedRevision?: number;
    name: string;
    principalCents: number;
    giftCents: number;
    active: boolean;
  },
): Promise<TopupOffer> {
  [input.principalCents, input.giftCents, input.principalCents + input.giftCents].forEach(assertCents);
  if (input.principalCents === 0 || !input.name.trim() || input.name.length > 200)
    throw new TennisWalletError("INVALID_TOPUP");
  return withBookingTransaction(db, actor, async (tx) => {
    await requireTenantPermission(tx, actor, "manage_members");
    const admin = await tx.query(
      "SELECT 1 FROM tennis.tenant_memberships WHERE tenant_id=$1 AND subject_id=$2 AND role='ADMIN'",
      [actor.tenantId, actor.subjectId],
    );
    if (!admin.rowCount) throw new TenantAccessError("TENANT_ACCESS_DENIED");
    const id = input.id ?? randomUUID();
    if (input.id) {
      const updated = await tx.query(
        `UPDATE tennis.topup_offers SET name=$1,principal_cents=$2,gift_cents=$3,active=$4,revision=revision+1
        WHERE tenant_id=$5 AND id=$6 AND revision=$7`,
        [
          input.name.trim(),
          input.principalCents,
          input.giftCents,
          input.active,
          actor.tenantId,
          id,
          input.expectedRevision,
        ],
      );
      if (!updated.rowCount) throw new TennisWalletError("INVALID_TOPUP");
    } else
      await tx.query(
        "INSERT INTO tennis.topup_offers (id,tenant_id,name,principal_cents,gift_cents,active) VALUES ($1,$2,$3,$4,$5,$6)",
        [id, actor.tenantId, input.name.trim(), input.principalCents, input.giftCents, input.active],
      );
    await recordTenantAudit(tx, actor, "topup_offer.save", id, input);
    return (
      await tx.query<TopupOffer>(`SELECT ${offerColumns} FROM tennis.topup_offers WHERE tenant_id=$1 AND id=$2`, [
        actor.tenantId,
        id,
      ])
    ).rows[0]!;
  });
}
export async function listTopupOffers(db: pg.Pool, actor: BookingActor): Promise<TopupOffer[]> {
  return withBookingTransaction(db, actor, async (tx) => {
    if (!isCustomerActor(actor)) await requireTenantPermission(tx, actor, "manage_members");
    return (
      await tx.query<TopupOffer>(
        `SELECT ${offerColumns} FROM tennis.topup_offers WHERE tenant_id=$1 AND ($2 OR active) ORDER BY principal_cents,id`,
        [actor.tenantId, !isCustomerActor(actor)],
      )
    ).rows;
  });
}
export async function createTopupQuote(
  db: pg.Pool,
  actor: BookingActor,
  input: {
    venueId: string;
    customerId: string;
    principalCents?: number;
    offerId?: string;
  },
): Promise<TopupQuote> {
  if ((input.principalCents === undefined) === (input.offerId === undefined))
    throw new TennisWalletError("INVALID_TOPUP");
  return withBookingTransaction(db, actor, async (tx) => {
    await authorizeTopup(tx, actor, input.venueId, input.customerId);
    if (!(await venueInTransaction(tx, actor, input.venueId)).active)
      throw new TenantAccessError("RESOURCE_UNAVAILABLE");
    let principalCents = input.principalCents ?? 0,
      giftCents = 0;
    if (input.offerId !== undefined) {
      const offer = (
        await tx.query<TopupOffer>(
          `SELECT ${offerColumns} FROM tennis.topup_offers WHERE tenant_id=$1 AND id=$2 AND active`,
          [actor.tenantId, input.offerId],
        )
      ).rows[0];
      if (!offer) throw new TenantAccessError("RESOURCE_NOT_FOUND");
      principalCents = offer.principalCents;
      giftCents = offer.giftCents;
    }
    assertCents(principalCents);
    if (principalCents === 0) throw new TennisWalletError("INVALID_TOPUP");
    const row = (
      await tx.query<QuoteRow>(
        `INSERT INTO tennis.topup_quotes (id,tenant_id,venue_id,customer_id,created_by,principal_cents,gift_cents,offer_id,expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp()+interval '5 minutes') RETURNING ${quoteColumns}`,
        [
          randomUUID(),
          actor.tenantId,
          input.venueId,
          input.customerId,
          actor.subjectId,
          principalCents,
          giftCents,
          input.offerId ?? null,
        ],
      )
    ).rows[0]!;
    await recordTenantAudit(tx, actor, "topup.quote", row.id, {
      customerId: input.customerId,
      principalCents,
      giftCents,
    });
    return { ...row, expiresAt: row.expiresAt.toISOString() };
  });
}
export async function beginTopupPayment(
  db: pg.Pool,
  actor: BookingActor,
  gateway: PaymentProviderPort,
  input: { quoteId: string; commandKey: string },
): Promise<TopupPayment> {
  return withBookingTransaction(db, actor, async (tx) => {
    const quote = (
      await tx.query<QuoteRow>(`SELECT ${quoteColumns} FROM tennis.topup_quotes WHERE tenant_id=$1 AND id=$2`, [
        actor.tenantId,
        input.quoteId,
      ])
    ).rows[0];
    if (!quote || quote.createdBy !== actor.subjectId) throw new TenantAccessError("RESOURCE_NOT_FOUND");
    await authorizeTopup(tx, actor, quote.venueId, quote.customerId);
    const result = await idempotentCommand(
      tx,
      actor,
      quote.venueId,
      input.commandKey,
      "topup.begin",
      { quoteId: quote.id },
      async () => {
        const existing = (
          await tx.query<{ id: string }>("SELECT id FROM tennis.topup_payments WHERE tenant_id=$1 AND quote_id=$2", [
            actor.tenantId,
            quote.id,
          ])
        ).rows[0];
        if (existing) return { topupId: existing.id };
        if (!(await venueInTransaction(tx, actor, quote.venueId)).active)
          throw new TenantAccessError("RESOURCE_UNAVAILABLE");
        const clock = (await tx.query<{ time: Date }>("SELECT clock_timestamp() AS time")).rows[0]!.time;
        if (quote.expiresAt <= clock) throw new TennisWalletError("INVALID_TOPUP");
        const id = randomUUID();
        const binding = await resolvePaymentMerchant(tx, actor.tenantId, gateway);
        await tx.query(
          `INSERT INTO tennis.topup_payments (id,tenant_id,venue_id,customer_id,quote_id,provider,merchant_id,principal_cents,gift_cents,status,created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'PENDING',$10)`,
          [
            id,
            actor.tenantId,
            quote.venueId,
            quote.customerId,
            quote.id,
            binding.provider,
            binding.merchantId,
            quote.principalCents,
            quote.giftCents,
            actor.subjectId,
          ],
        );
        await enqueuePaymentChannel(tx, {
          tenantId: actor.tenantId,
          sourceKind: "TOPUP",
          sourceId: id,
          binding,
          amountCents: quote.principalCents,
          expiresAt: new Date(clock.getTime() + 10 * 60_000).toISOString(),
        });
        await recordTenantAudit(tx, actor, "topup.begin", id, {
          quoteId: quote.id,
          principalCents: quote.principalCents,
          giftCents: quote.giftCents,
          provider: binding.provider,
        });
        return { topupId: id };
      },
    );
    return paymentInTransaction(tx, actor.tenantId, result.topupId);
  });
}
export async function getTopupPayment(db: pg.Pool, actor: BookingActor, id: string): Promise<TopupPayment> {
  return withBookingTransaction(db, actor, async (tx) => {
    const located = (
      await tx.query<{ venue_id: string; customer_id: string }>(
        "SELECT venue_id,customer_id FROM tennis.topup_payments WHERE tenant_id=$1 AND id=$2",
        [actor.tenantId, id],
      )
    ).rows[0];
    if (!located) throw new TenantAccessError("RESOURCE_NOT_FOUND");
    await authorizeTopup(tx, actor, located.venue_id, located.customer_id);
    return paymentInTransaction(tx, actor.tenantId, id);
  });
}
export async function settleVerifiedTopup(db: pg.Pool, event: VerifiedPaymentEvent, hook?: PaymentSettlementTransactionHook): Promise<TopupPayment> {
  if (!isVerifiedPaymentEvent(event)) throw new TennisWalletError("INVALID_PAYMENT_EVENT");
  const location = (
    await db.query<{ tenant_id: string; venue_id: string }>(
      "SELECT tenant_id,venue_id FROM tennis.topup_payments WHERE id=$1",
      [event.paymentId],
    )
  ).rows[0];
  if (!location) throw new TennisWalletError("INVALID_PAYMENT_EVENT");
  const tenantId = location.tenant_id;
  const actor = { tenantId, subjectId: "system:tennis" };
  const tx = await db.connect();
  try {
    await tx.query("BEGIN");
    await lockTenantTransactions(tx, tenantId);
    await hook?.beforeSettlement(tx, tenantId);
    await tx.query("SELECT id FROM tennis.venues WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [
      tenantId,
      location.venue_id,
    ]);
    const payment = await paymentInTransaction(tx, tenantId, event.paymentId);
    if (
      payment.provider !== event.provider ||
      payment.merchantId !== event.merchantId ||
      payment.principalCents !== event.amountCents ||
      event.currency !== "CNY"
    )
      throw new TennisWalletError("INVALID_PAYMENT_EVENT");
    const hash = paymentEventSemanticHash(event);
    const previous = (
      await tx.query<{ request_hash: string }>(
        "SELECT request_hash FROM tennis.topup_events WHERE provider=$1 AND merchant_id=$2 AND event_id=$3",
        [event.provider, event.merchantId, event.eventId],
      )
    ).rows[0];
    if (previous) {
      // Pre-port receipts only support exact replay; new receipts ignore envelope timestamp changes.
      if (previous.request_hash !== hash && previous.request_hash !== requestHash(event))
        throw new TennisWalletError("PAYMENT_EVENT_REUSED");
      await hook?.beforeCommit(tx, tenantId);
      await tx.query("COMMIT");
      return payment;
    }
    let outcome = "IGNORED";
    if (event.status === "SUCCEEDED") {
      await claimChannelTransaction(tx, { ...event, tenantId, sourceType: "TOPUP", sourceId: payment.id });
      if (payment.status === "SUCCEEDED") {
        if (payment.providerTransactionId === event.transactionId) outcome = "DUPLICATE_EVENT";
        else {
          await tx.query(
            `INSERT INTO tennis.topup_exceptions (id,tenant_id,topup_id,external_transaction_id,details) VALUES ($1,$2,$3,$4,$5::jsonb)
            ON CONFLICT (tenant_id,topup_id,external_transaction_id) DO NOTHING`,
            [
              randomUUID(),
              tenantId,
              payment.id,
              event.transactionId,
              JSON.stringify({
                amountCents: event.amountCents,
                merchantId: event.merchantId,
                requiredAction: "REFUND_EXTERNAL_PAYMENT",
              }),
            ],
          );
          outcome = "REFUND_REQUIRED";
        }
      } else {
        const batchId = await creditWalletBatch(tx, actor, {
          venueId: payment.venueId,
          customerId: payment.customerId,
          principalCents: payment.principalCents,
          giftCents: payment.giftCents,
          sourceKind: event.provider,
          sourceReference: `${event.merchantId}:${event.transactionId}`,
          reason: event.provider === "MOCK" ? "线上充值到账（本地模拟）" : "线上充值到账",
        });
        await tx.query(
          "UPDATE tennis.topup_payments SET status='SUCCEEDED',wallet_batch_id=$1,provider_transaction_id=$2,settled_at=clock_timestamp() WHERE tenant_id=$3 AND id=$4",
          [batchId, event.transactionId, tenantId, payment.id],
        );
        outcome = "SUCCEEDED";
      }
    } else if (payment.status !== "SUCCEEDED") {
      await tx.query("UPDATE tennis.topup_payments SET status='FAILED' WHERE tenant_id=$1 AND id=$2", [
        tenantId,
        payment.id,
      ]);
      outcome = "FAILED";
    }
    await tx.query(
      "INSERT INTO tennis.topup_events (provider,merchant_id,event_id,tenant_id,topup_id,request_hash,payload,outcome) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)",
      [event.provider, event.merchantId, event.eventId, tenantId, payment.id, hash, JSON.stringify(event), outcome],
    );
    await recordTenantAudit(tx, actor, "topup.event", payment.id, { eventId: event.eventId, outcome });
    const result = await paymentInTransaction(tx, tenantId, payment.id);
    await hook?.beforeCommit(tx, tenantId);
    await tx.query("COMMIT");
    return result;
  } catch (error) {
    await tx.query("ROLLBACK");
    throw error;
  } finally {
    tx.release();
  }
}
