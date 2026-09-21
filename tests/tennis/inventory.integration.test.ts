import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertLocalTennisDatabaseUrl, localTennisTestDatabaseUrl } from "../../packages/db/src/tennis/local-config.ts";
import { migrateTennis } from "../../packages/db/src/tennis/migrate.ts";
import {
  findCourtConflicts,
  occupyCourt,
  releaseCourtOccupancy,
  rescheduleCourtOccupancy,
} from "../../packages/db/src/tennis/inventory.ts";

import { seedTenantFixture, removeTenantFixture, type TenantFixture } from "./tenant-fixture.ts";

const connectionString = assertLocalTennisDatabaseUrl(
  process.env.TENNIS_TEST_DATABASE_URL ?? localTennisTestDatabaseUrl,
  "test",
);
let fixture: TenantFixture;
const venue = `test-${randomUUID()}`;
const db = new pg.Pool({
  connectionString,
  max: 5,
  connectionTimeoutMillis: 5000,
  statement_timeout: 10000,
  application_name: venue,
});
const time = (start: string, end: string) => ({
  startAt: `2026-09-18T${start}:00+08:00`,
  endAt: `2026-09-18T${end}:00+08:00`,
});
async function court() {
  const id = randomUUID();
  await db.query(
    "INSERT INTO tennis.courts (id, venue_id, tenant_id, name) VALUES ($1, $2, $3, 'synthetic test court')",
    [id, fixture.venueId, fixture.actor.tenantId],
  );
  return id;
}
const booking = (courtId: string, start = "19:00", end = "20:00") => ({
  id: randomUUID(),
  courtId,
  sourceId: randomUUID(),
  kind: "BOOKING" as const,
  ...time(start, end),
});

beforeAll(async () => {
  const client = await db.connect();
  try {
    await migrateTennis(client);
    await migrateTennis(client);
  } finally {
    client.release();
  }
  fixture = await seedTenantFixture(db);
});
afterAll(async () => {
  try {
    if (fixture) await removeTenantFixture(db, fixture);
  } finally {
    await db.end();
  }
});

describe("PostgreSQL court inventory", () => {
  it("admits exactly one simultaneous overlapping booking", async () => {
    const id = await court();
    const requests = [booking(id), booking(id, "19:30", "20:30")];
    const results = await Promise.allSettled(requests.map((input) => occupyCourt(db, fixture.actor, input)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason.code).toBe("INVENTORY_CONFLICT");
    expect(await findCourtConflicts(db, fixture.actor, id, time("18:00", "21:00"))).toHaveLength(1);
  });
  it("serializes a conflicting writer behind an uncommitted transaction", async () => {
    const id = await court();
    const client = await db.connect();
    let competing: Promise<string> | undefined;
    try {
      await client.query("BEGIN");
      const first = booking(id);
      await client.query(
        `INSERT INTO tennis.occupancies (id, court_id, kind, source_id, start_at, end_at, tenant_id)
        VALUES ($1, $2, 'BOOKING', $3, $4, $5, $6)`,
        [first.id, id, first.sourceId, first.startAt, first.endAt, fixture.actor.tenantId],
      );
      competing = occupyCourt(db, fixture.actor, booking(id)).then(
        () => "unexpected-success",
        (error) => error.code as string,
      );
      const deadline = Date.now() + 5000;
      let waiting = false;
      while (Date.now() < deadline) {
        const locks = await db.query<{ waiting: boolean }>(
          `SELECT EXISTS (
          SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
          WHERE a.application_name = $1 AND a.datname = current_database()
            AND l.locktype = 'transactionid' AND NOT l.granted
        ) AS waiting`,
          [venue],
        );
        if (locks.rows[0]?.waiting) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await client.query("COMMIT");
      expect(await competing).toBe("INVENTORY_CONFLICT");
    } finally {
      await client.query("ROLLBACK");
      client.release();
      if (competing) await competing;
    }
  });
  it("allows adjacency, 45 minute courses and different courts", async () => {
    const id = await court();
    await occupyCourt(db, fixture.actor, { ...booking(id, "19:00", "19:45"), kind: "COURSE" });
    await occupyCourt(db, fixture.actor, booking(id, "19:45", "20:30"));
    await occupyCourt(db, fixture.actor, booking(await court(), "19:00", "20:00"));
    expect(await findCourtConflicts(db, fixture.actor, id, time("19:30", "19:45"))).toHaveLength(1);
    expect(await findCourtConflicts(db, fixture.actor, id, time("20:30", "21:00"))).toEqual([]);
  });
  it("shares conflict rules between maintenance, courses and bookings", async () => {
    const id = await court();
    await occupyCourt(db, fixture.actor, { ...booking(id), kind: "MAINTENANCE" });
    await expect(occupyCourt(db, fixture.actor, { ...booking(id), kind: "COURSE" })).rejects.toMatchObject({
      code: "INVENTORY_CONFLICT",
    });
  });
  it("preserves the original occupancy and revision when moving into a conflict", async () => {
    const id = await court();
    const original = booking(id);
    await occupyCourt(db, fixture.actor, original);
    await occupyCourt(db, fixture.actor, booking(id, "20:00", "21:00"));
    await expect(
      rescheduleCourtOccupancy(db, fixture.actor, original.id, 1, id, time("20:30", "21:30")),
    ).rejects.toMatchObject({ code: "INVENTORY_CONFLICT" });
    expect(await findCourtConflicts(db, fixture.actor, id, time("19:00", "20:00"))).toEqual([original.id]);
    await rescheduleCourtOccupancy(db, fixture.actor, original.id, 1, id, time("18:00", "19:00"));
    expect(await findCourtConflicts(db, fixture.actor, id, time("19:00", "20:00"))).toEqual([]);
    await expect(releaseCourtOccupancy(db, fixture.actor, original.id, 1)).rejects.toMatchObject({
      code: "STALE_OCCUPANCY",
    });
    await releaseCourtOccupancy(db, fixture.actor, original.id, 2);
    expect(await findCourtConflicts(db, fixture.actor, id, time("18:00", "19:00"))).toEqual([]);
  });
  it("preserves released history while allowing the same interval to be booked", async () => {
    const input = booking(await court());
    await occupyCourt(db, fixture.actor, input);
    await releaseCourtOccupancy(db, fixture.actor, input.id, 1);
    await occupyCourt(db, fixture.actor, { ...input, id: randomUUID() });
    expect(
      (await db.query("SELECT released_at FROM tennis.occupancies WHERE id = $1", [input.id])).rows[0].released_at,
    ).not.toBeNull();
    await expect(
      rescheduleCourtOccupancy(db, fixture.actor, input.id, 2, input.courtId, time("21:00", "22:00")),
    ).rejects.toMatchObject({ code: "STALE_OCCUPANCY" });
  });
  it("rejects duplicate IDs without creating a second occupancy", async () => {
    const input = booking(await court());
    await occupyCourt(db, fixture.actor, input);
    await expect(occupyCourt(db, fixture.actor, { ...input, ...time("21:00", "22:00") })).rejects.toMatchObject({
      code: "DUPLICATE_OCCUPANCY",
    });
    expect(await findCourtConflicts(db, fixture.actor, input.courtId, time("18:00", "23:00"))).toEqual([input.id]);
  });
  it("rejects off-grid creation and rescheduling without changing the original occupancy", async () => {
    const input = booking(await court());
    await expect(occupyCourt(db, fixture.actor, { ...input, ...time("19:07", "20:07") })).rejects.toThrow(
      "15-minute grid",
    );
    expect(await findCourtConflicts(db, fixture.actor, input.courtId, time("19:00", "20:30"))).toEqual([]);
    await occupyCourt(db, fixture.actor, input);
    await expect(
      rescheduleCourtOccupancy(db, fixture.actor, input.id, 1, input.courtId, time("20:07", "21:07")),
    ).rejects.toThrow("15-minute grid");
    const result = await db.query("SELECT start_at, end_at, revision FROM tennis.occupancies WHERE id = $1", [
      input.id,
    ]);
    expect(result.rows[0]).toEqual({ start_at: new Date(input.startAt), end_at: new Date(input.endAt), revision: 1 });
  });
  it("enforces the grid on direct updates even when the SQL session uses another timezone", async () => {
    const input = booking(await court());
    await occupyCourt(db, fixture.actor, input);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL TIME ZONE 'Asia/Kathmandu'");
      await expect(
        client.query("UPDATE tennis.occupancies SET start_at = $1 WHERE id = $2", ["2026-09-18T19:07+08:00", input.id]),
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    expect(await findCourtConflicts(db, fixture.actor, input.courtId, time("19:00", "20:00"))).toEqual([input.id]);
  });
  it("enforces quarter-hour boundaries and duration even for direct SQL", async () => {
    const id = await court();
    for (const [start, end] of [
      ["2026-09-18T19:00:01+08:00", "2026-09-18T20:00:00+08:00"],
      ["2026-09-18T19:07:00+08:00", "2026-09-18T20:00:00+08:00"],
      ["2026-09-18T19:00:00+08:00", "2026-09-18T20:07:00+08:00"],
      ["2026-09-18T19:00:00+08:01", "2026-09-18T20:00:00+08:01"],
      ["2026-09-18T19:00:00+08:00", "2026-09-18T19:00:00+08:00"],
      ["2026-09-18T20:00:00+08:00", "2026-09-18T19:00:00+08:00"],
      ["-infinity", "infinity"],
    ]) {
      await expect(
        db.query(
          `INSERT INTO tennis.occupancies (id, court_id, kind, source_id, start_at, end_at, tenant_id)
        VALUES ($1, $2, 'BOOKING', $1, $3, $4, $5)`,
          [randomUUID(), id, start, end, fixture.actor.tenantId],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    }
  });
});
