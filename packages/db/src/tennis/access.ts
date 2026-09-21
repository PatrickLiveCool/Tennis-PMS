import { randomUUID } from "node:crypto";
import type pg from "pg";
import { assertDelegation } from "./agent-guard.ts";

/** Only construct from a verified session/integration identity at the API boundary. */
export interface TenantActor {
  subjectId: string;
  tenantId: string;
}
export type TenantPermission =
  | "read"
  | "book"
  | "manage_assets"
  | "manage_prices"
  | "refund"
  | "hold_unpaid"
  | "manage_members";
interface Membership {
  role: "ADMIN" | "STAFF" | "VIEWER";
  all_venues: boolean;
  permissions: TenantPermission[];
}

export class TenantAccessError extends Error {
  constructor(readonly code: "TENANT_ACCESS_DENIED" | "RESOURCE_NOT_FOUND" | "RESOURCE_UNAVAILABLE") {
    super(code);
    this.name = "TenantAccessError";
  }
}

export async function withTenantTransaction<T>(
  pool: pg.Pool,
  actor: TenantActor,
  work: (db: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await requireTenantPermission(db, actor, "read");
    const result = await work(db);
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}

/** Run inside the operation's transaction, holding grants stable until its commit. */
export async function requireTenantPermission(
  db: pg.PoolClient,
  actor: TenantActor,
  permission: TenantPermission,
  venueId?: string,
): Promise<void> {
  await assertDelegation(db, actor, venueId);
  const result = await db.query<Membership>(
    `SELECT m.role, m.all_venues, m.permissions
    FROM tennis.tenant_memberships m JOIN tennis.tenants t ON t.id = m.tenant_id
    WHERE m.tenant_id = $1 AND m.subject_id = $2 AND m.active AND t.active
    FOR SHARE OF m, t`,
    [actor.tenantId, actor.subjectId],
  );
  const membership = result.rows[0];
  if (
    !membership ||
    (membership.role !== "ADMIN" &&
      (!membership.permissions.includes(permission) || (membership.role === "VIEWER" && permission !== "read")))
  )
    throw new TenantAccessError("TENANT_ACCESS_DENIED");
  if (venueId && membership.role !== "ADMIN" && !membership.all_venues) {
    const scope = await db.query(
      `SELECT venue_id FROM tennis.membership_venues
      WHERE tenant_id = $1 AND subject_id = $2 AND venue_id = $3 FOR SHARE`,
      [actor.tenantId, actor.subjectId, venueId],
    );
    if (scope.rowCount !== 1) throw new TenantAccessError("TENANT_ACCESS_DENIED");
  }
}

export async function requireCourtPermission(
  db: pg.PoolClient,
  actor: TenantActor,
  courtId: string,
  permission: TenantPermission,
  requireActive = false,
): Promise<{ venueId: string }> {
  await requireTenantPermission(db, actor, permission);
  const location = await db.query<{ venue_id: string }>(
    "SELECT venue_id FROM tennis.courts WHERE tenant_id = $1 AND id = $2",
    [actor.tenantId, courtId],
  );
  if (!location.rows[0]) throw new TenantAccessError("RESOURCE_NOT_FOUND");
  // Every catalog/inventory writer locks venue before court, preventing lock upgrades
  // from deadlocking when a configuration change races with a booking.
  await requireVenuePermission(db, actor, location.rows[0].venue_id, permission);
  const result = await db.query<{ venue_id: string; active: boolean }>(
    `SELECT c.venue_id, (c.active AND v.active) AS active
    FROM tennis.courts c JOIN tennis.venues v ON v.id = c.venue_id AND v.tenant_id = c.tenant_id
    WHERE c.tenant_id = $1 AND c.id = $2 AND c.venue_id = $3 FOR SHARE OF c`,
    [actor.tenantId, courtId, location.rows[0].venue_id],
  );
  const court = result.rows[0];
  if (!court) throw new TenantAccessError("RESOURCE_NOT_FOUND");
  await requireTenantPermission(db, actor, permission, court.venue_id);
  if (requireActive && !court.active) throw new TenantAccessError("RESOURCE_UNAVAILABLE");
  return { venueId: court.venue_id };
}

export async function requireVenuePermission(
  db: pg.PoolClient,
  actor: TenantActor,
  venueId: string,
  permission: TenantPermission,
  lock: "share" | "update" = "share",
): Promise<void> {
  await requireTenantPermission(db, actor, permission, venueId);
  const result = await db.query(
    `SELECT id FROM tennis.venues WHERE tenant_id = $1 AND id = $2 FOR ${lock === "update" ? "UPDATE" : "SHARE"}`,
    [actor.tenantId, venueId],
  );
  if (result.rowCount !== 1) throw new TenantAccessError("RESOURCE_NOT_FOUND");
}

export async function recordTenantAudit(
  db: pg.PoolClient,
  actor: TenantActor,
  action: string,
  resourceId: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  await db.query(
    `INSERT INTO tennis.audit_events (id, tenant_id, subject_id, action, resource_id, details)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [randomUUID(), actor.tenantId, actor.subjectId, action, resourceId, JSON.stringify(details)],
  );
}
