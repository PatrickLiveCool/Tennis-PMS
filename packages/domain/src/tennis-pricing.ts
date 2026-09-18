import { parseCourtInterval, type CourtInterval } from "./court-interval.ts";

const STEP = 15 * 60_000;
const DENOMINATOR = 40_000n;
export interface OpeningWindow {
  weekday: number;
  startMinute: number;
  endMinute: number;
}
export interface DiscountRule {
  id: string;
  name: string;
  venueId: string;
  courtIds: string[];
  dateFrom: string;
  dateTo: string;
  weekdays: number[];
  startMinute: number;
  endMinute: number;
  discountBps: number;
}
export interface PriceSegment extends CourtInterval {
  hourlyPriceCents: number;
  discountBps: number;
  discountRuleId: string | null;
  amountCents: number;
}
export interface CourtPrice extends CourtInterval {
  courtId: string;
  venueId: string;
  currency: "CNY";
  totalCents: number;
  segments: PriceSegment[];
}
export class TennisPricingError extends Error {
  constructor(
    readonly code:
      | "INVALID_CONFIGURATION"
      | "DISCOUNT_OVERLAP"
      | "OUTSIDE_OPENING_HOURS"
      | "BELOW_MINIMUM_DURATION"
      | "PRICE_NOT_CONFIGURED",
    readonly details: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = "TennisPricingError";
  }
}

export function assertCents(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new TennisPricingError("INVALID_CONFIGURATION", { field: "amountCents" });
}
function safeNumber(value: bigint): number {
  const result = Number(value);
  assertCents(result);
  return result;
}
/** Preserve the exact integer total, breaking equal remainders in input order. */
export function allocateCents(total: number, weights: readonly number[]): number[] {
  assertCents(total);
  weights.forEach(assertCents);
  const sum = weights.reduce((value, weight) => value + BigInt(weight), 0n);
  if (sum === 0n) {
    if (total !== 0) throw new TennisPricingError("INVALID_CONFIGURATION", { field: "weights" });
    return weights.map(() => 0);
  }
  const portions = weights.map((weight, index) => {
    const numerator = BigInt(total) * BigInt(weight);
    return { index, amount: numerator / sum, remainder: numerator % sum };
  });
  let extra = BigInt(total) - portions.reduce((sum, item) => sum + item.amount, 0n);
  const ordered = [...portions].sort((a, b) =>
    a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
  );
  for (const item of ordered) {
    if (extra === 0n) break;
    item.amount++;
    extra--;
  }
  return portions.map((item) => safeNumber(item.amount));
}

export function assertDate(value: string): number {
  const time = /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T00:00:00Z`) : NaN;
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) {
    throw new TennisPricingError("INVALID_CONFIGURATION", { field: "date" });
  }
  return time;
}
function assertMinutes(start: number, end: number): void {
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end > 1440 ||
    start >= end ||
    start % 15 ||
    end % 15
  ) {
    throw new TennisPricingError("INVALID_CONFIGURATION", { field: "timeWindow" });
  }
}
function assertWeekday(day: number): void {
  if (!Number.isInteger(day) || day < 0 || day > 6)
    throw new TennisPricingError("INVALID_CONFIGURATION", { field: "weekday" });
}
export function assertTimezone(timezone: string): void {
  if (typeof timezone !== "string" || !timezone.trim())
    throw new TennisPricingError("INVALID_CONFIGURATION", { field: "timezone" });
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone });
  } catch {
    throw new TennisPricingError("INVALID_CONFIGURATION", { field: "timezone" });
  }
}
export function validateOpeningHours(windows: readonly OpeningWindow[]): void {
  for (const window of windows) {
    assertWeekday(window.weekday);
    assertMinutes(window.startMinute, window.endMinute);
  }
  for (let i = 0; i < windows.length; i++)
    for (const other of windows.slice(i + 1)) {
      const window = windows[i]!;
      if (
        window.weekday === other.weekday &&
        window.startMinute < other.endMinute &&
        window.endMinute > other.startMinute
      ) {
        throw new TennisPricingError("INVALID_CONFIGURATION", { field: "openingHours", reason: "overlap" });
      }
    }
}
export function validateMinimumMinutes(minutes: number): void {
  if (!Number.isSafeInteger(minutes) || minutes < 15 || minutes % 15)
    throw new TennisPricingError("INVALID_CONFIGURATION", { field: "minimumBookingMinutes" });
}
export function validateDiscountRule(rule: DiscountRule): void {
  if (
    !rule.id.trim() ||
    !rule.name.trim() ||
    !rule.venueId.trim() ||
    rule.courtIds.length === 0 ||
    rule.courtIds.some((id) => !id.trim()) ||
    new Set(rule.courtIds).size !== rule.courtIds.length ||
    rule.weekdays.length === 0 ||
    new Set(rule.weekdays).size !== rule.weekdays.length ||
    !Number.isInteger(rule.discountBps) ||
    rule.discountBps < 0 ||
    rule.discountBps > 10000
  ) {
    throw new TennisPricingError("INVALID_CONFIGURATION", { field: "discount" });
  }
  rule.weekdays.forEach(assertWeekday);
  assertMinutes(rule.startMinute, rule.endMinute);
  if (assertDate(rule.dateFrom) > assertDate(rule.dateTo))
    throw new TennisPricingError("INVALID_CONFIGURATION", { field: "dateRange" });
}
export function discountsOverlap(a: DiscountRule, b: DiscountRule): boolean {
  validateDiscountRule(a);
  validateDiscountRule(b);
  if (
    a.venueId !== b.venueId ||
    !a.courtIds.some((id) => b.courtIds.includes(id)) ||
    a.startMinute >= b.endMinute ||
    b.startMinute >= a.endMinute
  )
    return false;
  const first = Math.max(assertDate(a.dateFrom), assertDate(b.dateFrom));
  const last = Math.min(assertDate(a.dateTo), assertDate(b.dateTo));
  if (first > last) return false;
  const weekday = new Date(first).getUTCDay();
  return a.weekdays.some((day) => b.weekdays.includes(day) && first + ((day - weekday + 7) % 7) * 86_400_000 <= last);
}
export function validateDiscountSet(rules: readonly DiscountRule[]): void {
  const ids = new Set<string>();
  for (const rule of rules) {
    validateDiscountRule(rule);
    if (ids.has(rule.id)) throw new TennisPricingError("INVALID_CONFIGURATION", { field: "duplicateRuleId" });
    ids.add(rule.id);
  }
  for (let i = 0; i < rules.length; i++)
    for (const other of rules.slice(i + 1)) {
      if (discountsOverlap(rules[i]!, other))
        throw new TennisPricingError("DISCOUNT_OVERLAP", { ruleIds: [rules[i]!.id, other.id] });
    }
}

function calendar(timezone: string): (instant: number) => { date: string; weekday: number; minute: number } {
  assertTimezone(timezone);
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return (instant) => {
    const parts = Object.fromEntries(format.formatToParts(instant).map((part) => [part.type, part.value]));
    return {
      date: `${parts.year!.padStart(4, "0")}-${parts.month}-${parts.day}`,
      weekday: weekdays.indexOf(parts.weekday!),
      minute: Number(parts.hour) * 60 + Number(parts.minute),
    };
  };
}
export function isWithinOpeningHours(
  interval: CourtInterval,
  timezone: string,
  windows: readonly OpeningWindow[],
): boolean {
  validateOpeningHours(windows);
  const { start, end } = parseCourtInterval(interval);
  const local = calendar(timezone);
  for (let instant = start; instant < end; instant += STEP) {
    const slot = local(instant);
    if (
      !windows.some(
        (window) =>
          window.weekday === slot.weekday && slot.minute >= window.startMinute && slot.minute + 15 <= window.endMinute,
      )
    )
      return false;
  }
  return true;
}
export function openingIntervals(
  range: CourtInterval,
  timezone: string,
  windows: readonly OpeningWindow[],
): CourtInterval[] {
  validateOpeningHours(windows);
  const { start, end } = parseCourtInterval(range);
  const local = calendar(timezone);
  const result: CourtInterval[] = [];
  for (let instant = start; instant < end; instant += STEP) {
    const slot = local(instant);
    if (
      !windows.some(
        (window) =>
          window.weekday === slot.weekday && slot.minute >= window.startMinute && slot.minute + 15 <= window.endMinute,
      )
    )
      continue;
    const startAt = new Date(instant).toISOString();
    const endAt = new Date(instant + STEP).toISOString();
    const previous = result.at(-1);
    if (previous?.endAt === startAt) previous.endAt = endAt;
    else result.push({ startAt, endAt });
  }
  return result;
}

export function priceCourtInterval(input: {
  courtId: string;
  venueId: string;
  timezone: string;
  hourlyPriceCents: number | null;
  minimumBookingMinutes: number | null;
  openingHours: readonly OpeningWindow[];
  interval: CourtInterval;
  discounts: readonly DiscountRule[];
}): CourtPrice {
  const { start, end } = parseCourtInterval(input.interval);
  if (input.hourlyPriceCents === null || input.minimumBookingMinutes === null)
    throw new TennisPricingError("PRICE_NOT_CONFIGURED");
  assertCents(input.hourlyPriceCents);
  validateMinimumMinutes(input.minimumBookingMinutes);
  if (end - start < input.minimumBookingMinutes * 60_000) throw new TennisPricingError("BELOW_MINIMUM_DURATION");
  if (!isWithinOpeningHours(input.interval, input.timezone, input.openingHours))
    throw new TennisPricingError("OUTSIDE_OPENING_HOURS");
  const discounts = input.discounts.filter(
    (rule) => rule.venueId === input.venueId && rule.courtIds.includes(input.courtId),
  );
  validateDiscountSet(discounts);
  const local = calendar(input.timezone);
  const parts: { segment: PriceSegment; numerator: bigint }[] = [];
  for (let instant = start; instant < end; instant += STEP) {
    const slot = local(instant);
    const rule = discounts.find(
      (rule) =>
        slot.date >= rule.dateFrom &&
        slot.date <= rule.dateTo &&
        rule.weekdays.includes(slot.weekday) &&
        slot.minute >= rule.startMinute &&
        slot.minute + 15 <= rule.endMinute,
    );
    const bps = rule?.discountBps ?? 10000;
    const numerator = BigInt(input.hourlyPriceCents) * BigInt(bps);
    const endAt = new Date(instant + STEP).toISOString();
    const previous = parts.at(-1);
    if (previous && previous.segment.discountRuleId === (rule?.id ?? null) && previous.segment.discountBps === bps) {
      previous.numerator += numerator;
      previous.segment.endAt = endAt;
    } else
      parts.push({
        numerator,
        segment: {
          startAt: new Date(instant).toISOString(),
          endAt,
          hourlyPriceCents: input.hourlyPriceCents,
          discountBps: bps,
          discountRuleId: rule?.id ?? null,
          amountCents: 0,
        },
      });
  }
  const exact = parts.reduce((sum, part) => sum + part.numerator, 0n);
  const total = (exact + DENOMINATOR / 2n) / DENOMINATOR;
  const amounts = parts.map((part, index) => ({
    index,
    amount: part.numerator / DENOMINATOR,
    remainder: part.numerator % DENOMINATOR,
  }));
  let extra = total - amounts.reduce((sum, part) => sum + part.amount, 0n);
  for (const part of [...amounts].sort((a, b) =>
    a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
  )) {
    if (extra === 0n) break;
    part.amount++;
    extra--;
  }
  return {
    courtId: input.courtId,
    venueId: input.venueId,
    startAt: new Date(start).toISOString(),
    endAt: new Date(end).toISOString(),
    currency: "CNY",
    totalCents: safeNumber(total),
    segments: parts.map((part, index) => ({ ...part.segment, amountCents: safeNumber(amounts[index]!.amount) })),
  };
}
