/** Quarter-hour instants with an explicit UTC offset; intervals are [start, end). */
export interface CourtInterval {
  startAt: string;
  endAt: string;
}
export interface ParsedCourtInterval {
  start: number;
  end: number;
}

function minuteInstant(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::00(?:\.000)?)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) throw new Error("Time must be ISO 8601 with an explicit offset and whole-minute precision");
  const [, year, month, day, hour, minute, zone] = match;
  const instant = Date.parse(value);
  const offset =
    zone === "Z" ? 0 : (zone![0] === "+" ? 1 : -1) * (Number(zone!.slice(1, 3)) * 60 + Number(zone!.slice(4, 6)));
  if (!Number.isFinite(instant) || Math.abs(offset) > 14 * 60 || (zone !== "Z" && Number(zone!.slice(4, 6)) >= 60)) {
    throw new Error("Invalid time or UTC offset");
  }
  const local = new Date(instant + offset * 60_000);
  if (
    local.getUTCFullYear() !== Number(year) ||
    local.getUTCMonth() + 1 !== Number(month) ||
    local.getUTCDate() !== Number(day) ||
    local.getUTCHours() !== Number(hour) ||
    local.getUTCMinutes() !== Number(minute)
  )
    throw new Error("Invalid calendar time");
  return instant;
}

export function parseCourtInterval(interval: CourtInterval): ParsedCourtInterval {
  const start = minuteInstant(interval.startAt);
  const end = minuteInstant(interval.endAt);
  if (start >= end) throw new Error("endAt must be after startAt");
  // Check actual instants, so an alternative offset cannot bypass the database grid.
  // Venue opening/selling rules and its authoritative timezone are separate checks.
  if (start % 900_000 !== 0 || end % 900_000 !== 0) {
    throw new Error("Court interval boundaries must align to the 15-minute grid");
  }
  return { start, end };
}

export function courtIntervalsOverlap(a: CourtInterval, b: CourtInterval): boolean {
  const left = parseCourtInterval(a);
  const right = parseCourtInterval(b);
  return left.start < right.end && right.start < left.end;
}

/** Subtract occupancy from one opening window. Selling rules are checked separately. */
export function availableCourtIntervals(opening: CourtInterval, occupied: readonly CourtInterval[]): CourtInterval[] {
  const window = parseCourtInterval(opening);
  const blocks = occupied.map(parseCourtInterval).sort((a, b) => a.start - b.start);
  const result: CourtInterval[] = [];
  let cursor = window.start;
  const append = (start: number, end: number) =>
    result.push({
      startAt: new Date(start).toISOString(),
      endAt: new Date(end).toISOString(),
    });
  for (const block of blocks) {
    if (block.end <= cursor || block.start >= window.end) continue;
    if (block.start > cursor) append(cursor, block.start);
    cursor = Math.min(window.end, Math.max(cursor, block.end));
  }
  if (cursor < window.end) append(cursor, window.end);
  return result;
}
