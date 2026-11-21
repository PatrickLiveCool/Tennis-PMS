import type pg from "pg";
import { courtDescription } from "../../../domain/src/tennis-court-profile.ts";
import { parseBookingPhone } from "../../../domain/src/customer-contact.ts";
import { parseCourtInterval, type CourtInterval } from "../../../domain/src/court-interval.ts";
import type { BookingOption } from "../../../domain/src/tennis-player-link.ts";
import { TenantAccessError } from "./access.ts";
import { assertBookingAvailability, expireVenueHolds, locateOrder, orderInTransaction, requireBookingVenue, TennisBookingError, type OrderRecord } from "./booking.ts";
import { courtColumns, priceSelectionInTransaction, venueInTransaction, TennisCatalogError, type CourtRecord } from "./catalog.ts";
import { requireCustomer, withBookingTransaction, type CustomerActor } from "./customers.ts";
import type { PaymentRecord } from "./payments.ts";
import type { RefundRecord } from "./refunds.ts";
import { walletBalanceInTransaction } from "./wallet-store.ts";

type Slot = CourtInterval & { courtId: string };
export interface PlayerLine extends Slot { name: string; description: string; amountCents?: number; cancelled?: boolean }
type Place = { name: string; address: string; timezone: string };
export type PlayerPreview = { venue: Place; lines: PlayerLine[] } & (
  | { state: "available"; totalCents: number; walletCents: number }
  | { state: "booked"; orderId: string }
  | { state: "unavailable" }
);
export type PlayerPayment = Pick<PaymentRecord, "id" | "provider" | "walletCents" | "externalCents" | "status" | "createdAt">;
export type PlayerRefund = Pick<RefundRecord, "id" | "walletCents" | "externalCents" | "amountCents" | "status">;
export interface PlayerOrder extends Pick<OrderRecord, "id" | "status" | "paymentStatus" | "totalCents" | "holdUntil"> {
  venue: Place; lines: PlayerLine[]; payments: PlayerPayment[]; refunds: PlayerRefund[]; walletCents: number;
}
export interface PlayerOrderItem extends Pick<PlayerOrder, "id" | "status" | "paymentStatus" | "totalCents"> {
  venueName: string; timezone: string; courtName: string; startAt: string; endAt: string; lineCount: number;
}

async function describeSelection(tx: pg.PoolClient, actor: CustomerActor, venueId: string, slots: readonly Slot[]) {
  const { name, address, timezone } = await venueInTransaction(tx, actor, venueId);
  const courts = (await tx.query<CourtRecord>(
    `SELECT ${courtColumns} FROM tennis.courts WHERE tenant_id=$1 AND venue_id=$2 AND id=ANY($3::text[])`,
    [actor.tenantId, venueId, slots.map(s => s.courtId)],
  )).rows;
  const lines = slots.map(({ courtId, startAt, endAt }) => {
    const court = courts.find(c => c.id === courtId);
    if (!court) throw new TenantAccessError("RESOURCE_NOT_FOUND");
    return { courtId, startAt, endAt, name: court.name, description: courtDescription(court) };
  });
  return { venue: { name, address, timezone }, lines };
}
function sameSelection(a: readonly Slot[], b: readonly Slot[]) {
  const keys = (lines: readonly Slot[]) => lines.map(l => [l.courtId, Date.parse(l.startAt), Date.parse(l.endAt)].join("/")).sort();
  const left = keys(a), right = keys(b);
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

// A hold created by the front desk belongs to the player too. Only match an entire active order.
export function previewPlayerOption(db: pg.Pool, actor: CustomerActor, input: BookingOption): Promise<PlayerPreview> {
  return withBookingTransaction(db, actor, async (tx) => {
    await requireBookingVenue(tx, actor, input.venueId, "book");
    if (!input.lines.length || input.lines.length > 100) throw new TennisCatalogError("INVALID_SELECTION");
    try { input.lines.forEach(parseCourtInterval); }
    catch { throw new TennisCatalogError("INVALID_SELECTION"); }
    const customer = await requireCustomer(tx, actor, actor.customerId);
    await expireVenueHolds(tx, actor.tenantId, input.venueId);
    const place = await describeSelection(tx, actor, input.venueId, input.lines);
    const first = input.lines[0]!;
    const own = (await tx.query<{ id: string }>(
      `SELECT o.id FROM tennis.orders o JOIN tennis.order_lines l ON l.tenant_id=o.tenant_id AND l.order_id=o.id
       WHERE o.tenant_id=$1 AND o.venue_id=$2 AND o.customer_id=$3 AND o.status IN ('HELD','CONFIRMED')
       AND l.cancelled_at IS NULL AND l.court_id=$4 AND l.start_at=$5 AND l.end_at=$6`,
      [actor.tenantId, input.venueId, actor.customerId, first.courtId, first.startAt, first.endAt],
    )).rows;
    for (const row of own) {
      const order = await orderInTransaction(tx, actor, row.id);
      if (sameSelection(order.lines.filter(l => !l.cancelledAt), input.lines))
        return { ...place, state: "booked", orderId: order.id };
    }
    try {
      if (!parseBookingPhone(customer.phone)) throw new TennisBookingError("BOOKING_PHONE_REQUIRED");
      const price = await priceSelectionInTransaction(tx, actor, input.venueId, input.lines);
      await assertBookingAvailability(tx, actor, price.lines);
      const wallet = await walletBalanceInTransaction(tx, actor.tenantId, actor.customerId);
      return { ...place, state: "available", totalCents: price.totalCents,
        walletCents: Math.min(price.totalCents, wallet.availableCents),
        lines: place.lines.map((line, index) => ({ ...line, amountCents: price.lines[index]!.totalCents })) };
    } catch (error) {
      const code = (error as { code?: string }).code ?? "";
      if (["INVENTORY_CONFLICT", "PAST_INTERVAL", "RESOURCE_UNAVAILABLE", "OUTSIDE_OPENING_HOURS",
        "BELOW_MINIMUM_DURATION", "PRICE_NOT_CONFIGURED", "COURT_DETAILS_INCOMPLETE"].includes(code))
        return { ...place, state: "unavailable" };
      throw error;
    }
  });
}

export function playerOrder(db: pg.Pool, actor: CustomerActor, id: string): Promise<PlayerOrder> {
  return withBookingTransaction(db, actor, async (tx) => {
    const venueId = await locateOrder(tx, actor, id);
    await requireBookingVenue(tx, actor, venueId, "read");
    await expireVenueHolds(tx, actor.tenantId, venueId);
    const order = await orderInTransaction(tx, actor, id);
    const place = await describeSelection(tx, actor, venueId, order.lines);
    const payments = (await tx.query<PlayerPayment>(
      `SELECT id,provider,wallet_cents::float8 AS "walletCents",external_cents::float8 AS "externalCents",status,created_at AS "createdAt"
       FROM tennis.payment_attempts WHERE tenant_id=$1 AND order_id=$2 ORDER BY created_at,id`, [actor.tenantId, id],
    )).rows;
    const refunds = (await tx.query<PlayerRefund>(
      `SELECT id,wallet_cents::float8 AS "walletCents",external_cents::float8 AS "externalCents",amount_cents::float8 AS "amountCents",status
       FROM tennis.refunds WHERE tenant_id=$1 AND order_id=$2 ORDER BY created_at,id`, [actor.tenantId, id],
    )).rows;
    const wallet = await walletBalanceInTransaction(tx, actor.tenantId, actor.customerId);
    return { id, status: order.status, paymentStatus: order.paymentStatus, totalCents: order.totalCents,
      holdUntil: order.holdUntil, venue: place.venue, payments, refunds,
      walletCents: Math.min(order.totalCents, wallet.availableCents),
      lines: place.lines.map((line, i) => ({ ...line, amountCents: order.lines[i]!.amountCents, cancelled: !!order.lines[i]!.cancelledAt })) };
  });
}

export function playerOrders(db: pg.Pool, actor: CustomerActor, cursor?: string) {
  return withBookingTransaction(db, actor, async tx => {
    await requireCustomer(tx, actor, actor.customerId);
    const due = await tx.query<{ venue_id: string }>(
      "SELECT DISTINCT venue_id FROM tennis.orders WHERE tenant_id=$1 AND customer_id=$2 AND status='HELD' AND hold_until<=clock_timestamp() ORDER BY venue_id",
      [actor.tenantId, actor.customerId]);
    for (const row of due.rows) {
      await requireBookingVenue(tx, actor, row.venue_id, "read");
      await expireVenueHolds(tx, actor.tenantId, row.venue_id);
    }
    const result = await tx.query<PlayerOrderItem>(
      `SELECT o.id,o.status,o.payment_status AS "paymentStatus",o.total_cents::float8 AS "totalCents",v.name AS "venueName",v.timezone,
         l.name AS "courtName",l.start_at AS "startAt",l.end_at AS "endAt",l.count AS "lineCount"
       FROM tennis.orders o JOIN tennis.venues v ON v.tenant_id=o.tenant_id AND v.id=o.venue_id
       JOIN LATERAL (SELECT c.name,l.start_at,l.end_at,count(*) OVER()::int AS count FROM tennis.order_lines l
         JOIN tennis.courts c ON c.tenant_id=l.tenant_id AND c.id=l.court_id WHERE l.tenant_id=o.tenant_id AND l.order_id=o.id
         ORDER BY (l.cancelled_at IS NOT NULL),l.position LIMIT 1) l ON TRUE
       WHERE o.tenant_id=$1 AND o.customer_id=$2 AND ($3::text IS NULL OR (o.created_at,o.id) <
         (SELECT p.created_at,p.id FROM tennis.orders p WHERE p.tenant_id=$1 AND p.customer_id=$2 AND p.id=$3))
       ORDER BY o.created_at DESC,o.id DESC LIMIT 21`, [actor.tenantId, actor.customerId, cursor ?? null]);
    return { orders: result.rows.slice(0, 20), nextCursor: result.rows.length > 20 ? result.rows[19]!.id : null };
  });
}
