import type pg from "pg";
import { requireBookingVenue } from "./booking.ts";
import { isCustomerActor, withBookingTransaction, type BookingActor } from "./customers.ts";

export type BusinessEventType =
  | "booking.held"
  | "booking.confirmed"
  | "booking.cancelled"
  | "booking.line_cancelled"
  | "booking.expired"
  | "booking.amended"
  | "payment.result"
  | "topup.result"
  | "refund.result"
  | "conversation.handoff";
export interface BusinessEvent {
  eventId: string;
  type: BusinessEventType;
  schemaVersion: 1;
  tenantId: string;
  venueId: string;
  customerId: string | null;
  /** Initiating subject of the source resource; not the payment callback's executor. */
  subjectId: string;
  resource: {
    type:
      | "order"
      | "order_line"
      | "amendment"
      | "payment"
      | "topup"
      | "wallet_batch"
      | "refund"
      | "exception_refund"
      | "conversation";
    id: string;
    /** Increasing event version for this resource, not an inferred entity revision. */
    version: number;
  };
  occurredAt: string;
  payload: Record<string, unknown>;
}
export interface BusinessEventPage {
  events: BusinessEvent[];
  /** Retain even at the current end of the feed, then use it for the next poll. */
  nextCursor: string | null;
  hasMore: boolean;
}
export class BusinessEventQueryError extends Error {
  readonly statusCode = 400;
  constructor(readonly code: "INVALID_EVENT_QUERY" | "INVALID_EVENT_CURSOR" = "INVALID_EVENT_QUERY") {
    super(code);
    this.name = "BusinessEventQueryError";
  }
}
export function parseBusinessEventQuery(input: unknown = {}): { pageSize: number; cursor: string | null } {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new BusinessEventQueryError();
  const query = input as Record<string, unknown>;
  if (Object.keys(query).some((key) => key !== "cursor" && key !== "pageSize")) throw new BusinessEventQueryError();
  if (
    query.pageSize !== undefined &&
    typeof query.pageSize !== "number" &&
    !(typeof query.pageSize === "string" && /^[1-9]\d*$/.test(query.pageSize))
  )
    throw new BusinessEventQueryError();
  const pageSize = query.pageSize === undefined ? 50 : Number(query.pageSize);
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new BusinessEventQueryError();
  if (
    query.cursor !== undefined &&
    (typeof query.cursor !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(query.cursor))
  )
    throw new BusinessEventQueryError();
  return { pageSize, cursor: typeof query.cursor === "string" ? query.cursor : null };
}

/** Only call with a trusted session/gateway actor. The caller may not self-declare an identity. */
export async function pollBusinessEvents(
  db: pg.Pool,
  actor: BookingActor,
  venueId: string,
  input: unknown = {},
): Promise<BusinessEventPage> {
  const { pageSize, cursor } = parseBusinessEventQuery(input);
  return withBookingTransaction(db, actor, async (tx) => {
    await requireBookingVenue(tx, actor, venueId, "read");
    const customer = isCustomerActor(actor);
    // Keep the same additional visibility as wallet and conversation readers.
    const grants = customer
      ? { topups: true, conversations: true }
      : (
          await tx.query<{
            topups: boolean;
            conversations: boolean;
          }>(
            `SELECT (role='ADMIN' OR (role<>'VIEWER' AND 'manage_members'=ANY(permissions))) AS topups,
      (role='ADMIN' OR (role<>'VIEWER' AND 'book'=ANY(permissions))) AS conversations
      FROM tennis.tenant_memberships WHERE tenant_id=$1 AND subject_id=$2`,
            [actor.tenantId, actor.subjectId],
          )
        ).rows[0]!;
    const scope = [
      actor.tenantId,
      venueId,
      customer ? actor.customerId : null,
      grants.topups,
      grants.conversations,
      actor.subjectId,
    ];
    const visible = `tenant_id=$1 AND venue_id=$2 AND ($3::text IS NULL OR customer_id=$3)
      AND ($4::boolean OR (event_type<>'topup.result' AND resource_type<>'exception_refund'))
      AND ($5::boolean OR event_type<>'conversation.handoff')
      AND (event_type<>'conversation.handoff' OR $3::text IS NULL OR subject_id=$6)`;
    let after = "0";
    if (cursor) {
      const pivot = (
        await tx.query<{ tenantSequence: string }>(
          `SELECT tenant_sequence::text AS "tenantSequence" FROM tennis.business_events
         WHERE ${visible} AND event_id=$7::uuid`,
          [...scope, cursor],
        )
      ).rows[0];
      if (!pivot) throw new BusinessEventQueryError("INVALID_EVENT_CURSOR");
      after = pivot.tenantSequence;
    }
    const rows = (
      await tx.query<{
        eventId: string;
        type: BusinessEventType;
        schemaVersion: 1;
        tenantId: string;
        venueId: string;
        customerId: string | null;
        subjectId: string;
        resource: BusinessEvent["resource"];
        occurredAt: Date;
        payload: Record<string, unknown>;
      }>(
        `SELECT event_id AS "eventId",event_type AS type,schema_version AS "schemaVersion",
      tenant_id AS "tenantId",venue_id AS "venueId",customer_id AS "customerId",subject_id AS "subjectId",
      jsonb_build_object('type',resource_type,'id',resource_id,'version',resource_version) AS resource,
      occurred_at AS "occurredAt",payload
      FROM tennis.business_events WHERE ${visible} AND tenant_sequence>$7::bigint
      ORDER BY tenant_sequence LIMIT $8`,
        [...scope, after, pageSize + 1],
      )
    ).rows;
    const events = rows.slice(0, pageSize).map((row) => ({ ...row, occurredAt: row.occurredAt.toISOString() }));
    return { events, nextCursor: events.at(-1)?.eventId ?? cursor, hasMore: rows.length > pageSize };
  });
}
