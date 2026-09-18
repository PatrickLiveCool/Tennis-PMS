import { createHash } from "node:crypto";
import type pg from "pg";
import type { TenantActor } from "./access.ts";

export class TennisCommandError extends Error {
  constructor(readonly code: "INVALID_COMMAND_KEY" | "IDEMPOTENCY_KEY_REUSED" | "INCOMPLETE_RECEIPT") {
    super(code);
    this.name = "TennisCommandError";
  }
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
export function requestHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
/** Caller authorizes and owns the transaction. Commit the business result and receipt together. */
export async function idempotentCommand<T extends Record<string, unknown>>(
  tx: pg.PoolClient,
  actor: TenantActor,
  venueId: string,
  commandKey: string,
  commandType: string,
  request: unknown,
  perform: () => Promise<T>,
): Promise<T> {
  if (typeof commandKey !== "string" || commandKey.length < 8 || commandKey.length > 128)
    throw new TennisCommandError("INVALID_COMMAND_KEY");
  const hash = requestHash(request);
  const inserted = await tx.query(
    `INSERT INTO tennis.command_receipts (tenant_id,subject_id,command_key,venue_id,command_type,request_hash)
    VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (tenant_id,subject_id,command_key) DO NOTHING`,
    [actor.tenantId, actor.subjectId, commandKey, venueId, commandType, hash],
  );
  if (inserted.rowCount === 0) {
    const stored = await tx.query<{ request_hash: string; command_type: string; venue_id: string; result: T | null }>(
      `SELECT request_hash,command_type,venue_id,result
      FROM tennis.command_receipts WHERE tenant_id=$1 AND subject_id=$2 AND command_key=$3 FOR UPDATE`,
      [actor.tenantId, actor.subjectId, commandKey],
    );
    const receipt = stored.rows[0]!;
    if (receipt.request_hash !== hash || receipt.command_type !== commandType || receipt.venue_id !== venueId)
      throw new TennisCommandError("IDEMPOTENCY_KEY_REUSED");
    if (receipt.result === null) throw new TennisCommandError("INCOMPLETE_RECEIPT");
    return receipt.result;
  }
  const result = await perform();
  await tx.query(
    "UPDATE tennis.command_receipts SET result=$1::jsonb,completed_at=clock_timestamp() WHERE tenant_id=$2 AND subject_id=$3 AND command_key=$4",
    [JSON.stringify(result), actor.tenantId, actor.subjectId, commandKey],
  );
  return result;
}
