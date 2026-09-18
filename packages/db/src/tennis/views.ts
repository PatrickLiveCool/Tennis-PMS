import type pg from "pg";
import { TenantAccessError } from "./access.ts";
import { expireVenueHolds, locateOrder, orderInTransaction, requireBookingVenue } from "./booking.ts";
import { listVenues, venueInTransaction, type CourtRecord, type VenueRecord } from "./catalog.ts";
import { isCustomerActor, withBookingTransaction, type BookingActor } from "./customers.ts";
import { refundableLines } from "./refunds.ts";

/** Finds the real UTC extent of a local calendar date, including 23/25-hour days. */
export function venueDayRange(date: string, timezone: string): { startAt: string; endAt: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("INVALID_DATE");
  const anchor = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(anchor) || new Date(anchor).toISOString().slice(0, 10) !== date) throw new Error("INVALID_DATE");
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  let start: number | undefined, end: number | undefined;
  for (let value = anchor - 36 * 3600000; value <= anchor + 48 * 3600000; value += 15 * 60000) {
    const parts = formatter.formatToParts(new Date(value));
    const text = ["year", "month", "day"].map((name) => parts.find((part) => part.type === name)!.value).join("-");
    if (text === date) {
      start ??= value;
      end = value + 15 * 60000;
    }
  }
  if (start === undefined || end === undefined) throw new Error("INVALID_DATE");
  return { startAt: new Date(start).toISOString(), endAt: new Date(end).toISOString() };
}
export async function accessibleVenues(db: pg.Pool, actor: BookingActor): Promise<VenueRecord[]> {
  if (!isCustomerActor(actor)) return listVenues(db, actor);
  return withBookingTransaction(
    db,
    actor,
    async (tx) =>
      (
        await tx.query<VenueRecord>(
          `SELECT id,tenant_id AS "tenantId",name,address,timezone,active,
    opening_hours AS "openingHours",minimum_booking_minutes AS "minimumBookingMinutes",catalog_revision AS "catalogRevision"
    FROM tennis.venues WHERE tenant_id=$1 AND active ORDER BY name,id`,
          [actor.tenantId],
        )
      ).rows,
  );
}
export async function accessibleCourts(db: pg.Pool, actor: BookingActor, venueId: string): Promise<CourtRecord[]> {
  return withBookingTransaction(db, actor, async (tx) => {
    await requireBookingVenue(tx, actor, venueId, "read");
    return (
      await tx.query<CourtRecord>(
        `SELECT id,tenant_id AS "tenantId",venue_id AS "venueId",name,active,indoor,
      hourly_price_cents::float8 AS "hourlyPriceCents",revision FROM tennis.courts
      WHERE tenant_id=$1 AND venue_id=$2 AND ($3 OR active) ORDER BY name,id`,
        [actor.tenantId, venueId, !isCustomerActor(actor)],
      )
    ).rows;
  });
}
export async function venueSchedule(db: pg.Pool, actor: BookingActor, venueId: string, date: string) {
  return withBookingTransaction(db, actor, async (tx) => {
    await requireBookingVenue(tx, actor, venueId, "read");
    await expireVenueHolds(tx, actor.tenantId, venueId);
    const venue = await venueInTransaction(tx, actor, venueId);
    const range = venueDayRange(date, venue.timezone);
    const courts = (
      await tx.query<CourtRecord>(
        `SELECT id,tenant_id AS "tenantId",venue_id AS "venueId",name,active,indoor,hourly_price_cents::float8 AS "hourlyPriceCents",revision
      FROM tennis.courts WHERE tenant_id=$1 AND venue_id=$2 AND ($3 OR active) ORDER BY name,id`,
        [actor.tenantId, venueId, !isCustomerActor(actor)],
      )
    ).rows;
    const rows = (
      await tx.query<{
        id: string;
        courtId: string;
        startAt: Date;
        endAt: Date;
        kind: string;
        revision: number;
        sourceId: string;
        amendmentId: string | null;
        orderId: string | null;
        customerId: string | null;
        customerName: string | null;
        status: string | null;
      }>(
        `SELECT o.id,o.revision,o.source_id AS "sourceId",o.amendment_id AS "amendmentId",o.court_id AS "courtId",o.start_at AS "startAt",o.end_at AS "endAt",o.kind,
      b.id AS "orderId",b.customer_id AS "customerId",u.nickname AS "customerName",b.status
      FROM tennis.occupancies o JOIN tennis.courts c ON c.tenant_id=o.tenant_id AND c.id=o.court_id
      LEFT JOIN tennis.order_lines l ON l.tenant_id=o.tenant_id AND l.id=o.order_line_id
      LEFT JOIN tennis.orders b ON b.tenant_id=l.tenant_id AND b.id=l.order_id
      LEFT JOIN tennis.customers u ON u.tenant_id=b.tenant_id AND u.id=b.customer_id
      WHERE o.tenant_id=$1 AND c.venue_id=$2 AND o.released_at IS NULL AND o.start_at<$4 AND o.end_at>$3 ORDER BY o.start_at,o.id`,
        [actor.tenantId, venueId, range.startAt, range.endAt],
      )
    ).rows;
    const occupancies = rows.map((row, index) => {
      const own = !isCustomerActor(actor) || row.customerId === actor.customerId;
      return {
        id: own ? row.id : `busy:${index}`,
        courtId: row.courtId,
        startAt: row.startAt.toISOString(),
        endAt: row.endAt.toISOString(),
        kind: own ? row.kind : "OCCUPIED",
        orderId: own ? row.orderId : null,
        customerName: own ? row.customerName : null,
        status: own ? row.status : "OCCUPIED",
        ...(!isCustomerActor(actor)
          ? { revision: row.revision, sourceId: row.sourceId, amendmentId: row.amendmentId }
          : {}),
      };
    });
    return { venue, courts, occupancies, date, range };
  });
}
export async function orderDetail(db: pg.Pool, actor: BookingActor, id: string) {
  return withBookingTransaction(db, actor, async (tx) => {
    const venueId = await locateOrder(tx, actor, id);
    await requireBookingVenue(tx, actor, venueId, "read");
    await expireVenueHolds(tx, actor.tenantId, venueId);
    const order = await orderInTransaction(tx, actor, id);
    const payments = (
      await tx.query(
        `SELECT id,amendment_id AS "amendmentId",order_id AS "orderId",venue_id AS "venueId",customer_id AS "customerId",provider,merchant_id AS "merchantId",
      wallet_cents::float8 AS "walletCents",external_cents::float8 AS "externalCents",currency,status,provider_transaction_id AS "providerTransactionId",
      created_at AS "createdAt",settled_at AS "settledAt" FROM tennis.payment_attempts WHERE tenant_id=$1 AND order_id=$2 ORDER BY created_at,id`,
        [actor.tenantId, id],
      )
    ).rows;
    const refunds = (
      await tx.query(
        `SELECT id,order_id AS "orderId",payment_id AS "paymentId",venue_id AS "venueId",customer_id AS "customerId",amount_cents::float8 AS "amountCents",
      wallet_cents::float8 AS "walletCents",external_cents::float8 AS "externalCents",status,reason,provider_refund_id AS "providerRefundId",created_at AS "createdAt",completed_at AS "completedAt"
      FROM tennis.refunds WHERE tenant_id=$1 AND order_id=$2 ORDER BY created_at,id`,
        [actor.tenantId, id],
      )
    ).rows;
    const customer = (
      await tx.query<{ nickname: string }>("SELECT nickname FROM tennis.customers WHERE tenant_id=$1 AND id=$2", [
        actor.tenantId,
        order.customerId,
      ])
    ).rows[0];
    const remaining = await refundableLines(tx, actor.tenantId, id);
    return {
      ...order,
      lines: order.lines.map((line) => ({
        ...line,
        remainingRefundCents:
          order.paymentStatus === "UNPAID" || order.paymentStatus === "NOT_REQUIRED"
            ? 0
            : (remaining.get(line.id) ?? 0),
      })),
      customerName: customer?.nickname ?? "",
      payments,
      refunds,
    };
  });
}
export async function orderList(db: pg.Pool, actor: BookingActor, venueId: string) {
  return withBookingTransaction(db, actor, async (tx) => {
    await requireBookingVenue(tx, actor, venueId, "read");
    await expireVenueHolds(tx, actor.tenantId, venueId);
    const rows = (
      await tx.query<{ id: string; customerName: string }>(
        `SELECT o.id,c.nickname AS "customerName" FROM tennis.orders o JOIN tennis.customers c ON c.tenant_id=o.tenant_id AND c.id=o.customer_id WHERE o.tenant_id=$1 AND o.venue_id=$2 AND ($3::text IS NULL OR o.customer_id=$3) ORDER BY o.created_at DESC,o.id LIMIT 100`,
        [actor.tenantId, venueId, isCustomerActor(actor) ? actor.customerId : null],
      )
    ).rows;
    const result = [];
    for (const row of rows)
      result.push({ ...(await orderInTransaction(tx, actor, row.id)), customerName: row.customerName });
    return result;
  });
}
/** Booking permission needs customer selection, but does not grant wallet access. */
export async function bookingCustomers(db: pg.Pool, actor: BookingActor, venueId: string, search: string) {
  return withBookingTransaction(db, actor, async (tx) => {
    await requireBookingVenue(tx, actor, venueId, "book");
    const q = search.trim();
    return (
      await tx.query<{ id: string; tenantId: string; nickname: string; phone: null; active: boolean }>(
        `SELECT id,tenant_id AS "tenantId",nickname,NULL::text AS phone,active FROM tennis.customers WHERE tenant_id=$1 AND active AND ($2::text IS NULL OR id=$2) AND ($3='' OR strpos(lower(nickname),lower($3))>0 OR strpos(coalesce(phone,''),$3)>0) ORDER BY nickname,id LIMIT 100`,
        [actor.tenantId, isCustomerActor(actor) ? actor.customerId : null, q],
      )
    ).rows;
  });
}
export async function financeLedger(db: pg.Pool, actor: BookingActor, venueId: string, date: string) {
  if (isCustomerActor(actor)) throw new TenantAccessError("TENANT_ACCESS_DENIED");
  return withBookingTransaction(db, actor, async (tx) => {
    await requireBookingVenue(tx, actor, venueId, "manage_members");
    const venue = await venueInTransaction(tx, actor, venueId);
    const range = venueDayRange(date, venue.timezone);
    const entries = (
      await tx.query<{
        id: string;
        kind: string;
        cashCents: number;
        walletCents: number;
        giftCents: number;
        createdAt: Date;
        referenceId: string;
      }>(
        `SELECT * FROM (
      SELECT b.id,'OFFLINE_TOPUP' AS kind,b.principal_cents::float8 AS "cashCents",0::float8 AS "walletCents",b.gift_cents::float8 AS "giftCents",b.credited_at AS "createdAt",b.id AS "referenceId"
        FROM tennis.wallet_batches b WHERE b.tenant_id=$1 AND b.venue_id=$2 AND b.source_kind='OFFLINE'
      UNION ALL SELECT 'cash:'||r.transaction_id,'ORDER_RECEIPT',r.amount_cents::float8,0::float8,0::float8,r.received_at,p.order_id
        FROM tennis.external_payment_receipts r JOIN tennis.payment_attempts p ON p.tenant_id=r.tenant_id AND p.id=r.payment_id WHERE p.tenant_id=$1 AND p.venue_id=$2
      UNION ALL SELECT p.id,'ONLINE_TOPUP',p.principal_cents::float8,0::float8,p.gift_cents::float8,p.settled_at,p.id FROM tennis.topup_payments p WHERE p.tenant_id=$1 AND p.venue_id=$2 AND p.status='SUCCEEDED'
      UNION ALL SELECT x.id,'EXTRA_TOPUP_RECEIPT',(x.details->>'amountCents')::float8,0::float8,0::float8,x.created_at,p.id FROM tennis.topup_exceptions x JOIN tennis.topup_payments p ON p.tenant_id=x.tenant_id AND p.id=x.topup_id WHERE p.tenant_id=$1 AND p.venue_id=$2
      UNION ALL SELECT p.id,'WALLET_CONSUMPTION',0::float8,p.wallet_cents::float8,0::float8,p.settled_at,p.order_id FROM tennis.payment_attempts p WHERE p.tenant_id=$1 AND p.venue_id=$2 AND p.status='SUCCEEDED' AND p.wallet_cents>0
      UNION ALL SELECT r.id,'REFUND',-r.external_cents::float8,-r.wallet_cents::float8,0::float8,r.completed_at,r.order_id FROM tennis.refunds r WHERE r.tenant_id=$1 AND r.venue_id=$2 AND r.status='SUCCEEDED'
      ) ledger WHERE "createdAt">=$3 AND "createdAt"<$4 ORDER BY "createdAt" DESC,id`,
        [actor.tenantId, venueId, range.startAt, range.endAt],
      )
    ).rows;
    const pendingRefunds = (
      await tx.query(
        `SELECT id,order_id AS "orderId",amount_cents::float8 AS "amountCents",status,reason FROM tennis.refunds WHERE tenant_id=$1 AND venue_id=$2 AND status<>'SUCCEEDED' ORDER BY created_at`,
        [actor.tenantId, venueId],
      )
    ).rows;
    const exceptions = (
      await tx.query(
        `SELECT x.id,p.order_id AS "orderId",x.kind,x.status,x.details FROM tennis.financial_exceptions x JOIN tennis.payment_attempts p ON p.tenant_id=x.tenant_id AND p.id=x.payment_id WHERE p.tenant_id=$1 AND p.venue_id=$2 AND x.status='OPEN'
      UNION ALL SELECT x.id,NULL,'EXTRA_TOPUP_RECEIPT',x.status,x.details FROM tennis.topup_exceptions x JOIN tennis.topup_payments p ON p.tenant_id=x.tenant_id AND p.id=x.topup_id WHERE p.tenant_id=$1 AND p.venue_id=$2 AND x.status='OPEN'`,
        [actor.tenantId, venueId],
      )
    ).rows;
    const totals = entries.reduce(
      (sum, row) => ({
        cashInCents: sum.cashInCents + Math.max(0, row.cashCents),
        cashRefundCents: sum.cashRefundCents + Math.max(0, -row.cashCents),
        walletConsumedCents: sum.walletConsumedCents + Math.max(0, row.walletCents),
        walletRefundCents: sum.walletRefundCents + Math.max(0, -row.walletCents),
        giftCents: sum.giftCents + row.giftCents,
      }),
      { cashInCents: 0, cashRefundCents: 0, walletConsumedCents: 0, walletRefundCents: 0, giftCents: 0 },
    );
    return {
      date,
      totals,
      entries: entries.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
      pendingRefunds,
      exceptions,
    };
  });
}
