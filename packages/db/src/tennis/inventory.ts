import type pg from "pg";
import { parseCourtInterval, type CourtInterval } from "../../../domain/src/court-interval.ts";
import { recordTenantAudit, requireCourtPermission, withTenantTransaction, type TenantActor } from "./access.ts";

// Internal employee persistence only. Public session/Agent/customer APIs come later.
export interface CourtOccupancyInput extends CourtInterval {
  id: string;
  courtId: string;
  kind: "BOOKING" | "COURSE" | "MAINTENANCE";
  sourceId: string;
}

export class CourtInventoryError extends Error {
  constructor(
    readonly code: "INVENTORY_CONFLICT" | "STALE_OCCUPANCY" | "DUPLICATE_OCCUPANCY" | "ORDER_MANAGED_OCCUPANCY",
  ) {
    super(code);
    this.name = "CourtInventoryError";
  }
}

function rethrowInventoryError(error: unknown): never {
  const code = (error as { code?: string } | null)?.code;
  if (code === "23P01") throw new CourtInventoryError("INVENTORY_CONFLICT");
  if (code === "23505") throw new CourtInventoryError("DUPLICATE_OCCUPANCY");
  throw error;
}

export async function occupyCourt(db: pg.Pool, actor: TenantActor, input: CourtOccupancyInput): Promise<void> {
  parseCourtInterval(input);
  try {
    await withTenantTransaction(db, actor, async (tx) => {
      await requireCourtPermission(
        tx,
        actor,
        input.courtId,
        input.kind === "MAINTENANCE" ? "manage_assets" : "book",
        input.kind !== "MAINTENANCE",
      );
      await tx.query(
        `INSERT INTO tennis.occupancies (id, tenant_id, court_id, kind, source_id, start_at, end_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [input.id, actor.tenantId, input.courtId, input.kind, input.sourceId, input.startAt, input.endAt],
      );
      await recordTenantAudit(tx, actor, "occupancy.create", input.id, {
        courtId: input.courtId,
        kind: input.kind,
        sourceId: input.sourceId,
        startAt: input.startAt,
        endAt: input.endAt,
      });
    });
  } catch (error) {
    rethrowInventoryError(error);
  }
}

interface ExistingOccupancy {
  court_id: string;
  kind: CourtOccupancyInput["kind"];
  order_line_id: string | null;
  amendment_id: string | null;
}
async function lockOccupancy(
  tx: pg.PoolClient,
  actor: TenantActor,
  id: string,
  revision: number,
  targetCourtId?: string,
): Promise<ExistingOccupancy> {
  const located = await tx.query<ExistingOccupancy>(
    `SELECT court_id,kind,order_line_id,amendment_id FROM tennis.occupancies
    WHERE tenant_id=$1 AND id=$2 AND revision=$3 AND released_at IS NULL`,
    [actor.tenantId, id, revision],
  );
  const original = located.rows[0];
  if (!original) throw new CourtInventoryError("STALE_OCCUPANCY");
  const courts = await tx.query<{ id: string }>(
    "SELECT id FROM tennis.courts WHERE tenant_id=$1 AND id=ANY($2::text[]) ORDER BY venue_id,id",
    [actor.tenantId, [...new Set([original.court_id, ...(targetCourtId ? [targetCourtId] : [])])]],
  );
  // Authorize/lock venues before touching inventory, matching order and catalog writers.
  for (const court of courts.rows)
    await requireCourtPermission(tx, actor, court.id, original.kind === "MAINTENANCE" ? "manage_assets" : "book");
  const result = await tx.query<ExistingOccupancy>(
    `SELECT court_id, kind, order_line_id, amendment_id FROM tennis.occupancies
    WHERE tenant_id = $1 AND id = $2 AND revision = $3 AND released_at IS NULL FOR UPDATE`,
    [actor.tenantId, id, revision],
  );
  if (!result.rows[0]) throw new CourtInventoryError("STALE_OCCUPANCY");
  if (result.rows[0].order_line_id || result.rows[0].amendment_id)
    throw new CourtInventoryError("ORDER_MANAGED_OCCUPANCY");
  return result.rows[0];
}

export async function rescheduleCourtOccupancy(
  db: pg.Pool,
  actor: TenantActor,
  id: string,
  expectedRevision: number,
  courtId: string,
  interval: CourtInterval,
): Promise<void> {
  parseCourtInterval(interval);
  try {
    await withTenantTransaction(db, actor, async (tx) => {
      const original = await lockOccupancy(tx, actor, id, expectedRevision, courtId);
      const permission = original.kind === "MAINTENANCE" ? "manage_assets" : "book";
      await requireCourtPermission(tx, actor, original.court_id, permission);
      await requireCourtPermission(tx, actor, courtId, permission, original.kind !== "MAINTENANCE");
      await tx.query(
        `UPDATE tennis.occupancies SET court_id = $1, start_at = $2, end_at = $3, revision = revision + 1
        WHERE tenant_id = $4 AND id = $5 AND revision = $6 AND released_at IS NULL`,
        [courtId, interval.startAt, interval.endAt, actor.tenantId, id, expectedRevision],
      );
      await recordTenantAudit(tx, actor, "occupancy.reschedule", id, {
        fromCourtId: original.court_id,
        courtId,
        startAt: interval.startAt,
        endAt: interval.endAt,
        revision: expectedRevision + 1,
      });
    });
  } catch (error) {
    rethrowInventoryError(error);
  }
}

export async function releaseCourtOccupancy(
  db: pg.Pool,
  actor: TenantActor,
  id: string,
  expectedRevision: number,
): Promise<void> {
  await withTenantTransaction(db, actor, async (tx) => {
    const original = await lockOccupancy(tx, actor, id, expectedRevision);
    await requireCourtPermission(
      tx,
      actor,
      original.court_id,
      original.kind === "MAINTENANCE" ? "manage_assets" : "book",
    );
    await tx.query(
      `UPDATE tennis.occupancies SET released_at = now(), revision = revision + 1
      WHERE tenant_id = $1 AND id = $2 AND revision = $3 AND released_at IS NULL`,
      [actor.tenantId, id, expectedRevision],
    );
    await recordTenantAudit(tx, actor, "occupancy.release", id, {
      courtId: original.court_id,
      revision: expectedRevision + 1,
    });
  });
}

export async function findCourtConflicts(
  db: pg.Pool,
  actor: TenantActor,
  courtId: string,
  interval: CourtInterval,
): Promise<string[]> {
  parseCourtInterval(interval);
  return withTenantTransaction(db, actor, async (tx) => {
    await requireCourtPermission(tx, actor, courtId, "read");
    const result = await tx.query<{ id: string }>(
      `SELECT id FROM tennis.occupancies
      WHERE tenant_id = $1 AND court_id = $2 AND released_at IS NULL AND start_at < $4 AND end_at > $3 ORDER BY start_at, id`,
      [actor.tenantId, courtId, interval.startAt, interval.endAt],
    );
    return result.rows.map((row) => row.id);
  });
}
