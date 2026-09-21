import type pg from "pg";
import { parseCourtInterval } from "../../../domain/src/court-interval.ts";
import { assertCents, TennisPricingError, type CourtPrice } from "../../../domain/src/tennis-pricing.ts";
import { assertDelegation } from "./agent-guard.ts";
import { requireBookingVenue } from "./booking.ts";
import { priceSelectionInTransaction } from "./catalog.ts";
import { isCustomerActor, withBookingTransaction } from "./customers.ts";
import { resolveDelegation } from "./external-agent.ts";

export interface AgentVenueDiscoveryInput {
  startAt: string;
  endAt: string;
  courtCount: number;
}
export class AgentDiscoveryError extends Error {
  readonly statusCode = 400;
  constructor(readonly code: "INVALID_DISCOVERY_QUERY" | "PAST_INTERVAL") {
    super(code);
    this.name = "AgentDiscoveryError";
  }
}
export interface AgentVenueCandidate {
  venueId: string;
  name: string;
  address: string;
  timezone: string;
  catalogRevision: number;
  isCurrentVenue: boolean;
  availableCourtCount: number;
  courts: { courtId: string; name: string; indoor: boolean; price: CourtPrice }[];
  suggestedSelection: { courtIds: string[]; totalCents: number; currency: "CNY" };
}
export interface AgentVenueDiscovery {
  query: AgentVenueDiscoveryInput;
  checkedAt: string;
  inventoryHeld: false;
  quoteRequired: true;
  switchVenueRequiresNewConversation: true;
  venues: AgentVenueCandidate[];
}

/**
 * The only cross-venue agent surface is this read projection. It accepts a bearer,
 * never returns an actor, and keeps the original delegation bound throughout.
 * Candidate authorization is explicit here; write entry points retain their venue guard.
 */
export async function discoverAgentVenues(
  db: pg.Pool,
  bearerToken: string,
  input: AgentVenueDiscoveryInput,
): Promise<AgentVenueDiscovery> {
  const { actor, conversation } = await resolveDelegation(db, bearerToken);
  if (
    typeof input.startAt !== "string" ||
    typeof input.endAt !== "string" ||
    !Number.isSafeInteger(input.courtCount) ||
    input.courtCount < 1 ||
    input.courtCount > 100
  )
    throw new AgentDiscoveryError("INVALID_DISCOVERY_QUERY");
  let interval: ReturnType<typeof parseCourtInterval>;
  try {
    interval = parseCourtInterval(input);
  } catch {
    throw new AgentDiscoveryError("INVALID_DISCOVERY_QUERY");
  }
  const query = {
    startAt: new Date(interval.start).toISOString(),
    endAt: new Date(interval.end).toISOString(),
    courtCount: input.courtCount,
  };
  return withBookingTransaction(db, actor, async (tx) => {
    // Rechecks the original bearer and its generation inside the same tenant lock
    // used by handoff and booking. No actor is copied or detached from the guard.
    await requireBookingVenue(tx, actor, conversation.venueId, isCustomerActor(actor) ? "read" : "book");
    const checkedAt = (await tx.query<{ instant: Date }>("SELECT clock_timestamp() AS instant")).rows[0]!.instant;
    if (interval.start <= checkedAt.getTime()) throw new AgentDiscoveryError("PAST_INTERVAL");
    // withBookingTransaction already locks the active membership. Lock its scope
    // rows too, so a supported grant change cannot race the candidate projection.
    if (!isCustomerActor(actor))
      await tx.query("SELECT venue_id FROM tennis.membership_venues WHERE tenant_id=$1 AND subject_id=$2 FOR SHARE", [
        actor.tenantId,
        actor.subjectId,
      ]);
    const venues = (
      await tx.query<{
        id: string;
        name: string;
        address: string;
        timezone: string;
        catalogRevision: number;
      }>(
        `SELECT v.id,v.name,v.address,v.timezone,v.catalog_revision AS "catalogRevision"
        FROM tennis.venues v WHERE v.tenant_id=$1 AND v.active AND v.minimum_booking_minutes IS NOT NULL
        AND ($3 OR EXISTS (
          SELECT 1 FROM tennis.tenant_memberships m WHERE m.tenant_id=v.tenant_id AND m.subject_id=$2 AND m.active
          AND (m.role='ADMIN' OR (m.role='STAFF' AND 'read'=ANY(m.permissions) AND 'book'=ANY(m.permissions)))
          AND (m.role='ADMIN' OR m.all_venues OR EXISTS (
            SELECT 1 FROM tennis.membership_venues s WHERE s.tenant_id=m.tenant_id AND s.subject_id=m.subject_id AND s.venue_id=v.id
          ))
        )) ORDER BY v.id FOR SHARE OF v`,
        [actor.tenantId, actor.subjectId, isCustomerActor(actor)],
      )
    ).rows;
    const candidates: AgentVenueCandidate[] = [];
    for (const venue of venues) {
      const courts = (
        await tx.query<{ id: string; name: string; indoor: boolean }>(
          `SELECT c.id,c.name,c.indoor FROM tennis.courts c
          WHERE c.tenant_id=$1 AND c.venue_id=$2 AND c.active AND c.hourly_price_cents IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM tennis.occupancies o
            LEFT JOIN tennis.order_lines l ON l.tenant_id=o.tenant_id AND l.id=o.order_line_id
            LEFT JOIN tennis.orders b ON b.tenant_id=l.tenant_id AND b.id=l.order_id
            LEFT JOIN tennis.order_amendments a ON a.tenant_id=o.tenant_id AND a.id=o.amendment_id
            WHERE o.tenant_id=c.tenant_id AND o.court_id=c.id AND o.released_at IS NULL
              AND o.start_at<$4 AND o.end_at>$3
              AND NOT (coalesce(b.status='HELD' AND b.hold_until<=$5,false) OR coalesce(a.status='AWAITING_PAYMENT' AND a.hold_until<=$5,false))
          ) ORDER BY c.name,c.id FOR SHARE OF c`,
          [actor.tenantId, venue.id, query.startAt, query.endAt, checkedAt],
        )
      ).rows;
      if (courts.length < query.courtCount) continue;
      const priced: AgentVenueCandidate["courts"] = [];
      for (const court of courts) {
        try {
          // The target venue and true subject scope have been checked and locked
          // above. This internal function only reads catalog/pricing facts.
          const estimate = await priceSelectionInTransaction(tx, actor, venue.id, [
            { courtId: court.id, startAt: query.startAt, endAt: query.endAt },
          ]);
          priced.push({ courtId: court.id, name: court.name, indoor: court.indoor, price: estimate.lines[0]! });
        } catch (error) {
          if (
            error instanceof TennisPricingError &&
            ["OUTSIDE_OPENING_HOURS", "BELOW_MINIMUM_DURATION", "PRICE_NOT_CONFIGURED"].includes(error.code)
          )
            continue;
          throw error;
        }
      }
      if (priced.length < query.courtCount) continue;
      priced.sort((a, b) => a.price.totalCents - b.price.totalCents || a.courtId.localeCompare(b.courtId));
      const suggested = priced.slice(0, query.courtCount);
      const totalCents = suggested.reduce((sum, court) => sum + court.price.totalCents, 0);
      assertCents(totalCents);
      candidates.push({
        venueId: venue.id,
        name: venue.name,
        address: venue.address,
        timezone: venue.timezone,
        catalogRevision: venue.catalogRevision,
        isCurrentVenue: venue.id === conversation.venueId,
        availableCourtCount: priced.length,
        courts: priced,
        suggestedSelection: {
          courtIds: suggested.map((court) => court.courtId),
          totalCents,
          currency: "CNY",
        },
      });
    }
    // A long pricing read must not return under an expired/revoked delegation.
    await assertDelegation(tx, actor, conversation.venueId);
    candidates.sort(
      (a, b) => a.suggestedSelection.totalCents - b.suggestedSelection.totalCents || a.venueId.localeCompare(b.venueId),
    );
    return {
      query,
      checkedAt: checkedAt.toISOString(),
      inventoryHeld: false,
      quoteRequired: true,
      switchVenueRequiresNewConversation: true,
      venues: candidates,
    };
  });
}
