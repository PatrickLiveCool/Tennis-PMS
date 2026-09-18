import { describe, expect, it } from "vitest";
import {
  allocateCents,
  discountsOverlap,
  isWithinOpeningHours,
  openingIntervals,
  priceCourtInterval,
  validateDiscountSet,
  validateOpeningHours,
  type DiscountRule,
  type OpeningWindow,
} from "../../packages/domain/src/tennis-pricing.ts";

const hours: OpeningWindow[] = Array.from({ length: 7 }, (_, weekday) => ({
  weekday,
  startMinute: 0,
  endMinute: 1440,
}));
const interval = (start: string, end: string) => ({
  startAt: `2026-09-18T${start}:00+08:00`,
  endAt: `2026-09-18T${end}:00+08:00`,
});
const rule = (overrides: Partial<DiscountRule> = {}): DiscountRule => ({
  id: "daytime",
  name: "日间八折",
  venueId: "venue",
  courtIds: ["court"],
  dateFrom: "2026-09-01",
  dateTo: "2026-09-30",
  weekdays: [0, 1, 2, 3, 4, 5, 6],
  startMinute: 600,
  endMinute: 1080,
  discountBps: 8000,
  ...overrides,
});
const quote = (overrides: Partial<Parameters<typeof priceCourtInterval>[0]> = {}) =>
  priceCourtInterval({
    courtId: "court",
    venueId: "venue",
    timezone: "Asia/Shanghai",
    hourlyPriceCents: 10000,
    minimumBookingMinutes: 15,
    openingHours: hours,
    interval: interval("17:30", "18:30"),
    discounts: [rule()],
    ...overrides,
  });

describe("tennis deterministic pricing", () => {
  it("prices both sides of a discount boundary and preserves the evidence", () => {
    const result = quote();
    expect(result.totalCents).toBe(9000);
    expect(
      result.segments.map((segment) => [segment.discountBps, segment.amountCents, segment.discountRuleId]),
    ).toEqual([
      [8000, 4000, "daytime"],
      [10000, 5000, null],
    ]);
    expect(result.segments[0]?.endAt).toBe(result.segments[1]?.startAt);
  });
  it("uses venue-local dates and weekdays when UTC belongs to the previous day", () => {
    const midnightRule = rule({
      dateFrom: "2026-09-19",
      dateTo: "2026-09-19",
      weekdays: [6],
      startMinute: 0,
      endMinute: 60,
      discountBps: 5000,
    });
    const result = quote({
      interval: { startAt: "2026-09-18T15:30Z", endAt: "2026-09-18T16:30Z" },
      discounts: [midnightRule],
    });
    expect(result.totalCents).toBe(7500);
    expect(result.segments.map((segment) => segment.amountCents)).toEqual([5000, 2500]);
  });
  it("counts real time through daylight-saving transitions", () => {
    expect(
      quote({
        timezone: "America/New_York",
        discounts: [],
        interval: {
          startAt: "2026-11-01T01:00-04:00",
          endAt: "2026-11-01T02:00-05:00",
        },
      }).totalCents,
    ).toBe(20000);
    expect(
      quote({
        timezone: "America/New_York",
        discounts: [],
        interval: {
          startAt: "2026-03-08T01:30-05:00",
          endAt: "2026-03-08T03:30-04:00",
        },
      }).totalCents,
    ).toBe(10000);
  });
  it("rounds each line once and allocates fractional cents without losing money in the displayed segments", () => {
    const result = quote({
      hourlyPriceCents: 1,
      interval: interval("17:45", "18:15"),
      discounts: [rule({ discountBps: 10000 })],
    });
    expect(result.totalCents).toBe(1);
    expect(result.segments.map((segment) => segment.amountCents)).toEqual([1, 0]);
    expect(result.segments.reduce((total, segment) => total + segment.amountCents, 0)).toBe(result.totalCents);
    expect(quote({ hourlyPriceCents: 5, interval: interval("19:00", "19:45"), discounts: [] }).totalCents).toBe(4);
  });
  it("separates the configured sale minimum from quarter-hour precision", () => {
    expect(quote({ minimumBookingMinutes: 45, interval: interval("19:00", "19:45") }).totalCents).toBe(7500);
    expect(() => quote({ minimumBookingMinutes: 60, interval: interval("19:00", "19:45") })).toThrow(
      "BELOW_MINIMUM_DURATION",
    );
    expect(() => quote({ interval: interval("19:07", "20:07") })).toThrow("15-minute grid");
  });
  it("does not sell an unconfigured or closed resource", () => {
    expect(() => quote({ hourlyPriceCents: null })).toThrow("PRICE_NOT_CONFIGURED");
    expect(() => quote({ minimumBookingMinutes: null })).toThrow("PRICE_NOT_CONFIGURED");
    expect(() => quote({ openingHours: [] })).toThrow("OUTSIDE_OPENING_HOURS");
    expect(() => quote({ timezone: "Not/AZone" })).toThrow("INVALID_CONFIGURATION");
  });
  it("rejects ambiguous pricing even if it is fed a conflicting rule set", () => {
    expect(() => quote({ discounts: [rule(), rule({ id: "another" })] })).toThrow("DISCOUNT_OVERLAP");
  });
  it("rejects unsafe or fractional money inputs", () => {
    for (const hourlyPriceCents of [-1, 0.1, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) {
      expect(() => quote({ hourlyPriceCents })).toThrow("INVALID_CONFIGURATION");
    }
    expect(() =>
      quote({ hourlyPriceCents: Number.MAX_SAFE_INTEGER, interval: interval("18:00", "20:00"), discounts: [] }),
    ).toThrow("INVALID_CONFIGURATION");
  });
});

describe("discount configuration", () => {
  it("accepts adjacent time/date windows and disjoint courts or weekdays", () => {
    for (const other of [
      rule({ id: "b", startMinute: 1080, endMinute: 1320 }),
      rule({ id: "b", dateFrom: "2026-10-01", dateTo: "2026-10-31" }),
      rule({ id: "b", courtIds: ["another"] }),
      rule({ id: "b", venueId: "another" }),
    ]) {
      expect(discountsOverlap(rule(), other)).toBe(false);
      expect(() => validateDiscountSet([rule(), other])).not.toThrow();
    }
    expect(discountsOverlap(rule({ weekdays: [1, 2, 3] }), rule({ weekdays: [4, 5, 6] }))).toBe(false);
  });
  it("only detects a weekday conflict when that weekday exists in the intersecting date range", () => {
    expect(discountsOverlap(rule({ weekdays: [5] }), rule({ dateFrom: "2026-09-19", dateTo: "2026-09-20" }))).toBe(
      false,
    );
    expect(discountsOverlap(rule({ weekdays: [5] }), rule({ dateFrom: "2026-09-18", dateTo: "2026-09-18" }))).toBe(
      true,
    );
  });
  it("rejects invalid calendars, duplicate IDs and unaligned times", () => {
    for (const bad of [
      rule({ dateFrom: "2026-02-30" }),
      rule({ courtIds: [] }),
      rule({ weekdays: [] }),
      rule({ weekdays: [7] }),
      rule({ discountBps: -1 }),
      rule({ discountBps: 10001 }),
      rule({ startMinute: 601 }),
    ]) {
      expect(() => validateDiscountSet([bad])).toThrow("INVALID_CONFIGURATION");
    }
    expect(() => validateDiscountSet([rule(), rule()])).toThrow("INVALID_CONFIGURATION");
  });
});

describe("opening hours and integer allocation", () => {
  it("generates windows and preserves midday closures", () => {
    const windows = [
      { weekday: 5, startMinute: 480, endMinute: 720 },
      { weekday: 5, startMinute: 780, endMinute: 1320 },
    ];
    const result = openingIntervals(interval("11:00", "14:00"), "Asia/Shanghai", windows);
    expect(result).toEqual([
      { startAt: "2026-09-18T03:00:00.000Z", endAt: "2026-09-18T04:00:00.000Z" },
      { startAt: "2026-09-18T05:00:00.000Z", endAt: "2026-09-18T06:00:00.000Z" },
    ]);
    expect(isWithinOpeningHours(interval("11:00", "14:00"), "Asia/Shanghai", windows)).toBe(false);
    expect(() => validateOpeningHours([...windows, { weekday: 5, startMinute: 600, endMinute: 900 }])).toThrow(
      "INVALID_CONFIGURATION",
    );
  });
  it("allocates exactly, including uneven cents and large safe integers", () => {
    expect(allocateCents(12000, [10000, 2000])).toEqual([10000, 2000]);
    expect(allocateCents(1, [1, 1])).toEqual([1, 0]);
    expect(allocateCents(10, [0, 3, 2])).toEqual([0, 6, 4]);
    expect(allocateCents(0, [0, 0])).toEqual([0, 0]);
    const portions = allocateCents(Number.MAX_SAFE_INTEGER, [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]);
    expect(portions.reduce((a, b) => a + b, 0)).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => allocateCents(1, [0])).toThrow("INVALID_CONFIGURATION");
  });
});
