import { parseCourtInterval, type CourtInterval } from "./court-interval.ts";

export interface BookingOption { venueId: string; lines: (CourtInterval & { courtId: string })[] }
export type PlayerEntry =
  | { kind: "mine" | "invalid" }
  | { kind: "order"; id: string }
  | { kind: "confirm" | "choose"; options: BookingOption[] };

const identifier = /^[a-zA-Z0-9_-]{1,200}$/;

// One option is an indivisible booking, possibly spanning several courts or times.
function parseOption(value: string): BookingOption | null {
  const [venueId, ...slots] = value.split("~");
  if (!venueId || !identifier.test(venueId) || !slots.length || slots.length > 100) return null;
  const lines: BookingOption["lines"] = [];
  for (const slot of slots) {
    const [courtId, start, end, extra] = slot.split(",");
    if (!courtId || !identifier.test(courtId) || !start || !end || extra !== undefined) return null;
    try {
      const range = parseCourtInterval({ startAt: start, endAt: end });
      const startAt = new Date(range.start).toISOString(), endAt = new Date(range.end).toISOString();
      if (lines.some(l => l.courtId === courtId && l.startAt < endAt && startAt < l.endAt)) return null;
      lines.push({ courtId, startAt, endAt });
    } catch { return null; }
  }
  return { venueId, lines };
}
export function parsePlayerEntry(search: string): PlayerEntry {
  const params = new URLSearchParams(search);
  const modes = params.getAll("booking");
  if (!modes.length) return { kind: "mine" };
  const mode = modes[0];
  if (modes.length !== 1) return { kind: "invalid" };
  if (mode === "mine") return { kind: "mine" };
  if (mode === "order") {
    const ids = params.getAll("id");
    return ids.length === 1 && identifier.test(ids[0]!) ? { kind: "order", id: ids[0]! } : { kind: "invalid" };
  }
  const raw = params.getAll("option");
  if ((mode !== "choose" && mode !== "confirm") ||
      (mode === "confirm" && raw.length !== 1) || (mode === "choose" && raw.length < 2) || raw.length > 8)
    return { kind: "invalid" };
  const options: BookingOption[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const option = parseOption(item);
    if (!option) return { kind: "invalid" };
    const key = JSON.stringify([option.venueId, option.lines.map(l => [l.courtId, l.startAt, l.endAt].join(",")).sort()]);
    if (seen.has(key)) return { kind: "invalid" };
    seen.add(key);
    options.push(option);
  }
  return { kind: mode, options };
}
