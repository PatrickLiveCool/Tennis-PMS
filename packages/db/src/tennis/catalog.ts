import { randomUUID } from "node:crypto";
import type pg from "pg";
import {
  availableCourtIntervals,
  courtIntervalsOverlap,
  parseCourtInterval,
  type CourtInterval,
} from "../../../domain/src/court-interval.ts";
import {
  assertCents,
  assertTimezone,
  discountsOverlap,
  isWithinOpeningHours,
  openingIntervals,
  priceCourtInterval,
  validateDiscountRule,
  validateMinimumMinutes,
  validateOpeningHours,
  TennisPricingError,
  type CourtPrice,
  type DiscountRule,
  type OpeningWindow,
} from "../../../domain/src/tennis-pricing.ts";
import {
  recordTenantAudit,
  requireTenantPermission,
  requireVenuePermission,
  TenantAccessError,
  withTenantTransaction,
  type TenantActor,
} from "./access.ts";

export class TennisCatalogError extends Error {
  constructor(
    readonly code: "STALE_CONFIGURATION" | "AFFECTED_OCCUPANCIES" | "INVALID_CONFIGURATION" | "INVALID_SELECTION",
    readonly details: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = "TennisCatalogError";
  }
}
export interface VenueRecord {
  id: string;
  tenantId: string;
  name: string;
  address: string;
  timezone: string;
  active: boolean;
  openingHours: OpeningWindow[];
  minimumBookingMinutes: number | null;
  catalogRevision: number;
}
export interface CourtRecord {
  id: string;
  tenantId: string;
  venueId: string;
  name: string;
  active: boolean;
  indoor: boolean;
  hourlyPriceCents: number | null;
  revision: number;
}
export interface SavedDiscount extends DiscountRule {
  active: boolean;
  revision: number;
}
const venueColumns = `id, tenant_id AS "tenantId", name, address, timezone, active, opening_hours AS "openingHours",
  minimum_booking_minutes AS "minimumBookingMinutes", catalog_revision AS "catalogRevision"`;
const courtColumns = `id, tenant_id AS "tenantId", venue_id AS "venueId", name, active, indoor,
  hourly_price_cents::float8 AS "hourlyPriceCents", revision`;

function requiredName(name: string): void {
  if (!name.trim() || name.length > 200) throw new TennisCatalogError("INVALID_CONFIGURATION", { field: "name" });
}
export async function venueInTransaction(tx: pg.PoolClient, actor: TenantActor, id: string): Promise<VenueRecord> {
  const result = await tx.query<VenueRecord>(
    `SELECT ${venueColumns} FROM tennis.venues WHERE tenant_id = $1 AND id = $2`,
    [actor.tenantId, id],
  );
  if (!result.rows[0]) throw new TenantAccessError("RESOURCE_NOT_FOUND");
  return result.rows[0];
}
export async function courtInTransaction(
  tx: pg.PoolClient,
  actor: TenantActor,
  venueId: string,
  id: string,
): Promise<CourtRecord> {
  const result = await tx.query<CourtRecord>(
    `SELECT ${courtColumns} FROM tennis.courts WHERE tenant_id = $1 AND venue_id = $2 AND id = $3`,
    [actor.tenantId, venueId, id],
  );
  if (!result.rows[0]) throw new TenantAccessError("RESOURCE_NOT_FOUND");
  return result.rows[0];
}
async function bumpCatalog(tx: pg.PoolClient, actor: TenantActor, venueId: string): Promise<void> {
  await tx.query("UPDATE tennis.venues SET catalog_revision = catalog_revision + 1 WHERE tenant_id = $1 AND id = $2", [
    actor.tenantId,
    venueId,
  ]);
}
async function requireTenantAdmin(tx: pg.PoolClient, actor: TenantActor): Promise<void> {
  await requireTenantPermission(tx, actor, "manage_assets");
  const result = await tx.query(
    "SELECT 1 FROM tennis.tenant_memberships WHERE tenant_id = $1 AND subject_id = $2 AND role = 'ADMIN'",
    [actor.tenantId, actor.subjectId],
  );
  if (result.rowCount !== 1) throw new TenantAccessError("TENANT_ACCESS_DENIED");
}

export async function createVenue(
  db: pg.Pool,
  actor: TenantActor,
  input: { name: string; address?: string; timezone: string },
): Promise<VenueRecord> {
  requiredName(input.name);
  assertTimezone(input.timezone);
  return withTenantTransaction(db, actor, async (tx) => {
    await requireTenantAdmin(tx, actor);
    const id = randomUUID();
    await tx.query("INSERT INTO tennis.venues (id, tenant_id, name, address, timezone) VALUES ($1,$2,$3,$4,$5)", [
      id,
      actor.tenantId,
      input.name.trim(),
      input.address ?? "",
      input.timezone,
    ]);
    await recordTenantAudit(tx, actor, "venue.create", id, { name: input.name.trim(), timezone: input.timezone });
    return venueInTransaction(tx, actor, id);
  });
}
export async function listVenues(db: pg.Pool, actor: TenantActor): Promise<VenueRecord[]> {
  return withTenantTransaction(db, actor, async (tx) => {
    const result = await tx.query<VenueRecord>(
      `SELECT ${venueColumns} FROM tennis.venues v WHERE v.tenant_id = $1
      AND EXISTS (SELECT 1 FROM tennis.tenant_memberships m WHERE m.tenant_id = v.tenant_id AND m.subject_id = $2
        AND (m.role = 'ADMIN' OR m.all_venues OR EXISTS (SELECT 1 FROM tennis.membership_venues s
          WHERE s.tenant_id = m.tenant_id AND s.subject_id = m.subject_id AND s.venue_id = v.id))) ORDER BY name, id`,
      [actor.tenantId, actor.subjectId],
    );
    return result.rows;
  });
}

export async function updateVenue(
  db: pg.Pool,
  actor: TenantActor,
  input: {
    id: string;
    expectedRevision: number;
    name: string;
    address: string;
    timezone: string;
    active: boolean;
    openingHours: OpeningWindow[];
    minimumBookingMinutes: number;
  },
): Promise<VenueRecord> {
  requiredName(input.name);
  assertTimezone(input.timezone);
  validateOpeningHours(input.openingHours);
  validateMinimumMinutes(input.minimumBookingMinutes);
  return withTenantTransaction(db, actor, async (tx) => {
    await requireVenuePermission(tx, actor, input.id, "manage_assets", "update");
    const current = await venueInTransaction(tx, actor, input.id);
    if (current.catalogRevision !== input.expectedRevision) throw new TennisCatalogError("STALE_CONFIGURATION");
    const active = await tx.query<{ id: string; start_at: Date; end_at: Date }>(
      `SELECT o.id, o.start_at, o.end_at FROM tennis.occupancies o
      JOIN tennis.courts c ON c.id = o.court_id AND c.tenant_id = o.tenant_id
      WHERE o.tenant_id = $1 AND c.venue_id = $2 AND o.released_at IS NULL AND o.end_at > now() AND o.kind != 'MAINTENANCE'`,
      [actor.tenantId, input.id],
    );
    const affected = active.rows
      .filter(
        (row) =>
          !input.active ||
          input.timezone !== current.timezone ||
          !isWithinOpeningHours(
            {
              startAt: row.start_at.toISOString(),
              endAt: row.end_at.toISOString(),
            },
            input.timezone,
            input.openingHours,
          ),
      )
      .map((row) => row.id);
    if (affected.length) throw new TennisCatalogError("AFFECTED_OCCUPANCIES", { occupancyIds: affected });
    await tx.query(
      `UPDATE tennis.venues SET name=$1, address=$2, timezone=$3, active=$4, opening_hours=$5::jsonb,
      minimum_booking_minutes=$6, catalog_revision=catalog_revision+1 WHERE tenant_id=$7 AND id=$8`,
      [
        input.name.trim(),
        input.address,
        input.timezone,
        input.active,
        JSON.stringify(input.openingHours),
        input.minimumBookingMinutes,
        actor.tenantId,
        input.id,
      ],
    );
    await recordTenantAudit(tx, actor, "venue.update", input.id, { before: current, after: input });
    return venueInTransaction(tx, actor, input.id);
  });
}

export async function createCourt(
  db: pg.Pool,
  actor: TenantActor,
  input: { venueId: string; name: string; indoor: boolean },
): Promise<CourtRecord> {
  requiredName(input.name);
  return withTenantTransaction(db, actor, async (tx) => {
    await requireVenuePermission(tx, actor, input.venueId, "manage_assets", "update");
    const id = randomUUID();
    await tx.query("INSERT INTO tennis.courts (id, tenant_id, venue_id, name, indoor) VALUES ($1,$2,$3,$4,$5)", [
      id,
      actor.tenantId,
      input.venueId,
      input.name.trim(),
      input.indoor,
    ]);
    await bumpCatalog(tx, actor, input.venueId);
    await recordTenantAudit(tx, actor, "court.create", id, input);
    return courtInTransaction(tx, actor, input.venueId, id);
  });
}
export async function listCourts(db: pg.Pool, actor: TenantActor, venueId: string): Promise<CourtRecord[]> {
  return withTenantTransaction(db, actor, async (tx) => {
    await requireVenuePermission(tx, actor, venueId, "read");
    return (
      await tx.query<CourtRecord>(
        `SELECT ${courtColumns} FROM tennis.courts WHERE tenant_id=$1 AND venue_id=$2 ORDER BY name, id`,
        [actor.tenantId, venueId],
      )
    ).rows;
  });
}
export async function updateCourt(
  db: pg.Pool,
  actor: TenantActor,
  input: {
    id: string;
    venueId: string;
    expectedRevision: number;
    name: string;
    indoor: boolean;
    active: boolean;
  },
): Promise<CourtRecord> {
  requiredName(input.name);
  return withTenantTransaction(db, actor, async (tx) => {
    await requireVenuePermission(tx, actor, input.venueId, "manage_assets", "update");
    const current = await courtInTransaction(tx, actor, input.venueId, input.id);
    if (current.revision !== input.expectedRevision) throw new TennisCatalogError("STALE_CONFIGURATION");
    if (!input.active) {
      const affected = await tx.query<{ id: string }>(
        `SELECT id FROM tennis.occupancies WHERE tenant_id=$1 AND court_id=$2
        AND released_at IS NULL AND end_at > now() AND kind != 'MAINTENANCE'`,
        [actor.tenantId, input.id],
      );
      if (affected.rowCount)
        throw new TennisCatalogError("AFFECTED_OCCUPANCIES", { occupancyIds: affected.rows.map((row) => row.id) });
    }
    await tx.query(
      "UPDATE tennis.courts SET name=$1, indoor=$2, active=$3, revision=revision+1 WHERE tenant_id=$4 AND id=$5",
      [input.name.trim(), input.indoor, input.active, actor.tenantId, input.id],
    );
    await bumpCatalog(tx, actor, input.venueId);
    await recordTenantAudit(tx, actor, "court.update", input.id, { before: current, after: input });
    return courtInTransaction(tx, actor, input.venueId, input.id);
  });
}
export async function setCourtPrice(
  db: pg.Pool,
  actor: TenantActor,
  input: {
    courtId: string;
    venueId: string;
    expectedRevision: number;
    hourlyPriceCents: number;
  },
): Promise<CourtRecord> {
  assertCents(input.hourlyPriceCents);
  return withTenantTransaction(db, actor, async (tx) => {
    await requireVenuePermission(tx, actor, input.venueId, "manage_prices", "update");
    const current = await courtInTransaction(tx, actor, input.venueId, input.courtId);
    if (current.revision !== input.expectedRevision) throw new TennisCatalogError("STALE_CONFIGURATION");
    await tx.query("UPDATE tennis.courts SET hourly_price_cents=$1, revision=revision+1 WHERE tenant_id=$2 AND id=$3", [
      input.hourlyPriceCents,
      actor.tenantId,
      input.courtId,
    ]);
    await bumpCatalog(tx, actor, input.venueId);
    await recordTenantAudit(tx, actor, "court.price", input.courtId, {
      beforeCents: current.hourlyPriceCents,
      afterCents: input.hourlyPriceCents,
    });
    return courtInTransaction(tx, actor, input.venueId, input.courtId);
  });
}

async function discountsInTransaction(
  tx: pg.PoolClient,
  actor: TenantActor,
  venueId: string,
): Promise<SavedDiscount[]> {
  const result = await tx.query<SavedDiscount>(
    `SELECT r.id, r.name, r.venue_id AS "venueId", r.date_from::text AS "dateFrom", r.date_to::text AS "dateTo",
    r.weekdays, r.start_minute AS "startMinute", r.end_minute AS "endMinute", r.discount_bps AS "discountBps", r.active, r.revision,
    ARRAY(SELECT c.court_id FROM tennis.discount_rule_courts c WHERE c.tenant_id=r.tenant_id AND c.rule_id=r.id ORDER BY c.court_id) AS "courtIds"
    FROM tennis.discount_rules r WHERE r.tenant_id=$1 AND r.venue_id=$2 ORDER BY r.created_at, r.id`,
    [actor.tenantId, venueId],
  );
  return result.rows;
}
export async function listDiscounts(db: pg.Pool, actor: TenantActor, venueId: string): Promise<SavedDiscount[]> {
  return withTenantTransaction(db, actor, async (tx) => {
    await requireVenuePermission(tx, actor, venueId, "read");
    return discountsInTransaction(tx, actor, venueId);
  });
}
export async function saveDiscount(
  db: pg.Pool,
  actor: TenantActor,
  input: {
    rule: Omit<DiscountRule, "id"> & { id?: string };
    expectedRevision?: number;
    active: boolean;
  },
): Promise<SavedDiscount> {
  const rule: DiscountRule = { ...input.rule, id: input.rule.id ?? randomUUID() };
  validateDiscountRule(rule);
  return withTenantTransaction(db, actor, async (tx) => {
    await requireVenuePermission(tx, actor, rule.venueId, "manage_prices", "update");
    const existing = await discountsInTransaction(tx, actor, rule.venueId);
    const current = existing.find((item) => item.id === rule.id);
    if (input.rule.id && !current) throw new TenantAccessError("RESOURCE_NOT_FOUND");
    if (current && input.expectedRevision !== current.revision) throw new TennisCatalogError("STALE_CONFIGURATION");
    for (const id of rule.courtIds) await courtInTransaction(tx, actor, rule.venueId, id);
    if (input.active) {
      const overlap = existing.find((other) => other.active && other.id !== rule.id && discountsOverlap(rule, other));
      if (overlap) throw new TennisPricingError("DISCOUNT_OVERLAP", { ruleIds: [overlap.id, rule.id] });
    }
    if (current) {
      await tx.query(
        `UPDATE tennis.discount_rules SET name=$1,date_from=$2,date_to=$3,weekdays=$4,start_minute=$5,end_minute=$6,
        discount_bps=$7,active=$8,revision=revision+1 WHERE tenant_id=$9 AND id=$10`,
        [
          rule.name.trim(),
          rule.dateFrom,
          rule.dateTo,
          rule.weekdays,
          rule.startMinute,
          rule.endMinute,
          rule.discountBps,
          input.active,
          actor.tenantId,
          rule.id,
        ],
      );
      await tx.query("DELETE FROM tennis.discount_rule_courts WHERE tenant_id=$1 AND rule_id=$2", [
        actor.tenantId,
        rule.id,
      ]);
    } else {
      await tx.query(
        `INSERT INTO tennis.discount_rules (id,tenant_id,venue_id,name,date_from,date_to,weekdays,start_minute,end_minute,discount_bps,active)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          rule.id,
          actor.tenantId,
          rule.venueId,
          rule.name.trim(),
          rule.dateFrom,
          rule.dateTo,
          rule.weekdays,
          rule.startMinute,
          rule.endMinute,
          rule.discountBps,
          input.active,
        ],
      );
    }
    for (const courtId of rule.courtIds)
      await tx.query(
        "INSERT INTO tennis.discount_rule_courts (tenant_id,venue_id,rule_id,court_id) VALUES ($1,$2,$3,$4)",
        [actor.tenantId, rule.venueId, rule.id, courtId],
      );
    await bumpCatalog(tx, actor, rule.venueId);
    await recordTenantAudit(tx, actor, "discount.save", rule.id, {
      before: current ?? null,
      after: { ...rule, active: input.active },
    });
    return { ...rule, name: rule.name.trim(), active: input.active, revision: (current?.revision ?? 0) + 1 };
  });
}

export interface CourtAvailability {
  court: CourtRecord;
  intervals: CourtInterval[];
}
export async function findAvailableCourts(
  db: pg.Pool,
  actor: TenantActor,
  venueId: string,
  range: CourtInterval,
): Promise<{
  venue: VenueRecord;
  courts: CourtAvailability[];
}> {
  parseCourtInterval(range);
  return withTenantTransaction(db, actor, async (tx) => {
    await requireVenuePermission(tx, actor, venueId, "read");
    const venue = await venueInTransaction(tx, actor, venueId);
    if (!venue.active || venue.minimumBookingMinutes === null) return { venue, courts: [] };
    const openings = openingIntervals(range, venue.timezone, venue.openingHours);
    const courts = (
      await tx.query<CourtRecord>(
        `SELECT ${courtColumns} FROM tennis.courts WHERE tenant_id=$1 AND venue_id=$2 AND active AND hourly_price_cents IS NOT NULL ORDER BY name,id`,
        [actor.tenantId, venueId],
      )
    ).rows;
    const occupied = await tx.query<{ court_id: string; start_at: Date; end_at: Date }>(
      `SELECT o.court_id,o.start_at,o.end_at
      FROM tennis.occupancies o JOIN tennis.courts c ON c.id=o.court_id AND c.tenant_id=o.tenant_id
      WHERE o.tenant_id=$1 AND c.venue_id=$2 AND o.released_at IS NULL AND o.start_at<$4 AND o.end_at>$3`,
      [actor.tenantId, venueId, range.startAt, range.endAt],
    );
    return {
      venue,
      courts: courts.map((court) => ({
        court,
        intervals: openings
          .flatMap((opening) =>
            availableCourtIntervals(
              opening,
              occupied.rows
                .filter((row) => row.court_id === court.id)
                .map((row) => ({ startAt: row.start_at.toISOString(), endAt: row.end_at.toISOString() })),
            ),
          )
          .filter(
            (interval) =>
              Date.parse(interval.endAt) - Date.parse(interval.startAt) >= venue.minimumBookingMinutes! * 60_000,
          ),
      })),
    };
  });
}

export interface PricedSelection {
  venueId: string;
  catalogRevision: number;
  currency: "CNY";
  totalCents: number;
  lines: CourtPrice[];
}
export async function findMatchingCourts(
  db: pg.Pool,
  actor: TenantActor,
  venueId: string,
  interval: CourtInterval,
  requestedCount: number,
): Promise<{
  sufficient: boolean;
  requestedCount: number;
  availableCount: number;
  candidates: CourtRecord[];
}> {
  if (!Number.isSafeInteger(requestedCount) || requestedCount < 1 || requestedCount > 100)
    throw new TennisCatalogError("INVALID_SELECTION");
  const range = parseCourtInterval(interval);
  const availability = await findAvailableCourts(db, actor, venueId, interval);
  const candidates = availability.courts
    .filter((item) =>
      item.intervals.some((free) => Date.parse(free.startAt) <= range.start && Date.parse(free.endAt) >= range.end),
    )
    .map((item) => item.court);
  return {
    sufficient: candidates.length >= requestedCount,
    requestedCount,
    availableCount: candidates.length,
    candidates,
  };
}
/** Caller must authorize and lock the venue in the same transaction. */
export async function priceSelectionInTransaction(
  tx: pg.PoolClient,
  actor: TenantActor,
  venueId: string,
  lines: readonly (CourtInterval & { courtId: string })[],
): Promise<PricedSelection> {
  if (lines.length === 0 || lines.length > 100) throw new TennisCatalogError("INVALID_SELECTION", { field: "lines" });
  lines.forEach(parseCourtInterval);
  for (let i = 0; i < lines.length; i++)
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[i]!.courtId === lines[j]!.courtId && courtIntervalsOverlap(lines[i]!, lines[j]!)) {
        throw new TennisCatalogError("INVALID_SELECTION", { reason: "overlappingCourtLines", lineIndices: [i, j] });
      }
    }
  const venue = await venueInTransaction(tx, actor, venueId);
  if (!venue.active) throw new TenantAccessError("RESOURCE_UNAVAILABLE");
  const discounts = (await discountsInTransaction(tx, actor, venueId)).filter((rule) => rule.active);
  const priced: CourtPrice[] = [];
  for (const line of lines) {
    const court = await courtInTransaction(tx, actor, venueId, line.courtId);
    if (!court.active) throw new TenantAccessError("RESOURCE_UNAVAILABLE");
    priced.push(
      priceCourtInterval({
        courtId: court.id,
        venueId,
        timezone: venue.timezone,
        hourlyPriceCents: court.hourlyPriceCents,
        minimumBookingMinutes: venue.minimumBookingMinutes,
        openingHours: venue.openingHours,
        interval: line,
        discounts,
      }),
    );
  }
  const totalCents = priced.reduce((sum, line) => sum + line.totalCents, 0);
  assertCents(totalCents);
  return { venueId, catalogRevision: venue.catalogRevision, currency: "CNY", totalCents, lines: priced };
}
/** Deterministic estimate only: no hold or confirmed quote/booking is created here. */
export async function priceSelection(
  db: pg.Pool,
  actor: TenantActor,
  venueId: string,
  lines: readonly (CourtInterval & { courtId: string })[],
): Promise<PricedSelection> {
  return withTenantTransaction(db, actor, async (tx) => {
    await requireVenuePermission(tx, actor, venueId, "read");
    return priceSelectionInTransaction(tx, actor, venueId, lines);
  });
}
