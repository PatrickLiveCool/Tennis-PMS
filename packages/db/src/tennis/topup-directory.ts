import type pg from "pg";
import { requireBookingVenue } from "./booking.ts";
import { isCustomerActor, requireCustomer, withBookingTransaction, type BookingActor } from "./customers.ts";
import type { TopupPayment } from "./topups.ts";

export class TopupQueryError extends Error {
  readonly statusCode = 400;
  constructor(readonly code: "INVALID_TOPUP_QUERY" | "INVALID_TOPUP_CURSOR" = "INVALID_TOPUP_QUERY") {
    super(code);
    this.name = "TopupQueryError";
  }
}
export interface TopupPage {
  items: TopupPayment[];
  nextCursor: string | null;
}
export async function listCustomerTopups(
  db: pg.Pool,
  actor: BookingActor,
  venueId: string,
  customerId: string,
  input: unknown = {},
): Promise<TopupPage> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TopupQueryError();
  const query = input as Record<string, unknown>;
  if (Object.keys(query).some((key) => !["status", "cursor", "pageSize"].includes(key))) throw new TopupQueryError();
  const status = query.status;
  if (status !== undefined && !["PENDING", "FAILED", "SUCCEEDED"].includes(status as string))
    throw new TopupQueryError();
  const cursor = query.cursor;
  if (cursor !== undefined && (typeof cursor !== "string" || !cursor.trim() || cursor.length > 200))
    throw new TopupQueryError();
  if (
    query.pageSize !== undefined &&
    typeof query.pageSize !== "number" &&
    !(typeof query.pageSize === "string" && /^[1-9]\d*$/.test(query.pageSize))
  )
    throw new TopupQueryError();
  const pageSize = query.pageSize === undefined ? 20 : Number(query.pageSize);
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new TopupQueryError();
  return withBookingTransaction(db, actor, async (tx) => {
    await requireBookingVenue(tx, actor, venueId, isCustomerActor(actor) ? "read" : "manage_members");
    await requireCustomer(tx, actor, customerId);
    if (
      cursor &&
      !(
        await tx.query(
          `SELECT 1 FROM tennis.topup_payments WHERE tenant_id=$1 AND venue_id=$2 AND customer_id=$3 AND id=$4`,
          [actor.tenantId, venueId, customerId, cursor],
        )
      ).rowCount
    )
      throw new TopupQueryError("INVALID_TOPUP_CURSOR");
    // created_at is fixed for a topup. Keep the SQL timestamp intact rather than round its cursor to milliseconds.
    const rows = (
      await tx.query<Omit<TopupPayment, "createdAt" | "settledAt"> & { createdAt: Date; settledAt: Date | null }>(
        `
      SELECT p.id,p.venue_id AS "venueId",p.customer_id AS "customerId",p.quote_id AS "quoteId",p.provider,p.merchant_id AS "merchantId",
        p.principal_cents::float8 AS "principalCents",p.gift_cents::float8 AS "giftCents",p.status,p.wallet_batch_id AS "walletBatchId",
        p.provider_transaction_id AS "providerTransactionId",p.created_at AS "createdAt",p.settled_at AS "settledAt"
      FROM tennis.topup_payments p WHERE p.tenant_id=$1 AND p.venue_id=$2 AND p.customer_id=$3
        AND ($4::text IS NULL OR p.status=$4)
        AND ($5::text IS NULL OR (p.created_at,p.id)<(SELECT created_at,id FROM tennis.topup_payments WHERE tenant_id=$1 AND venue_id=$2 AND customer_id=$3 AND id=$5))
      ORDER BY p.created_at DESC,p.id DESC LIMIT $6`,
        [actor.tenantId, venueId, customerId, status ?? null, cursor ?? null, pageSize + 1],
      )
    ).rows;
    return {
      items: rows
        .slice(0, pageSize)
        .map((row) => ({
          ...row,
          createdAt: row.createdAt.toISOString(),
          settledAt: row.settledAt?.toISOString() ?? null,
        })),
      nextCursor: rows.length > pageSize ? rows[pageSize - 1]!.id : null,
    };
  });
}
