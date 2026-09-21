import { describe, expect, it } from "vitest";
import {
  availableCourtIntervals,
  courtIntervalsOverlap,
  parseCourtInterval,
} from "../../packages/domain/src/court-interval.ts";

const interval = (start: string, end: string) => ({
  startAt: `2026-09-18T${start}:00+08:00`,
  endAt: `2026-09-18T${end}:00+08:00`,
});

describe("court time intervals", () => {
  it.each(["00", "15", "30", "45"])("accepts quarter-hour boundary %s and a common one-hour booking", (minute) => {
    const parsed = parseCourtInterval(interval(`19:${minute}`, `20:${minute}`));
    expect(parsed.end - parsed.start).toBe(60 * 60000);
  });
  it.each([
    ["19:07", "20:00"],
    ["19:00", "20:07"],
    ["19:07", "20:07"],
    ["19:01", "19:16"],
    ["19:00", "19:10"],
  ])("rejects off-grid boundaries without rounding: %s to %s", (start, end) => {
    expect(() => parseCourtInterval(interval(start, end))).toThrow("15-minute grid");
  });
  it("validates the actual instant consistently across alternate offsets", () => {
    expect(
      parseCourtInterval({
        startAt: "2026-09-18T16:45+05:45",
        endAt: "2026-09-18T17:45+05:45",
      }),
    ).toEqual(parseCourtInterval(interval("19:00", "20:00")));
    expect(() =>
      parseCourtInterval({
        startAt: "2026-09-18T19:00+08:01",
        endAt: "2026-09-18T20:00+08:01",
      }),
    ).toThrow("15-minute grid");
  });
  it("supports a 45 minute course and adjacent bookings", () => {
    const course = interval("19:00", "19:45");
    const parsed = parseCourtInterval(course);
    expect(parsed.end - parsed.start).toBe(45 * 60000);
    expect(courtIntervalsOverlap(course, interval("19:45", "20:30"))).toBe(false);
    expect(courtIntervalsOverlap(course, interval("19:30", "20:00"))).toBe(true);
    expect(courtIntervalsOverlap(course, interval("19:15", "19:30"))).toBe(true);
  });
  it("compares actual instants across offsets and midnight", () => {
    expect(
      courtIntervalsOverlap(interval("19:00", "20:00"), {
        startAt: "2026-09-18T11:30:00Z",
        endAt: "2026-09-18T12:30:00Z",
      }),
    ).toBe(true);
    const value = parseCourtInterval({ startAt: "2026-09-18T23:45+08:00", endAt: "2026-09-19T00:30+08:00" });
    expect(value.end - value.start).toBe(45 * 60000);
  });
  it.each([
    ["2026-02-30T19:00+08:00", "2026-03-01T20:00+08:00"],
    ["2026-09-18T24:00+08:00", "2026-09-19T01:00+08:00"],
    ["2026-09-18T19:00", "2026-09-18T20:00"],
    ["2026-09-18T19:00:01Z", "2026-09-18T20:00:00Z"],
    ["2026-09-18T19:00:00.001Z", "2026-09-18T20:00:00Z"],
    ["2026-09-18T19:00+14:01", "2026-09-18T20:00+14:01"],
    ["2026-09-18T19:00+08:60", "2026-09-18T20:00+08:60"],
    ["2026-09-18T19:00Z", "2026-09-18T19:00Z"],
    ["2026-09-18T20:00Z", "2026-09-18T19:00Z"],
  ])("rejects invalid or imprecise intervals %s", (startAt, endAt) => {
    expect(() => parseCourtInterval({ startAt, endAt })).toThrow();
  });
  it("subtracts unordered, overlapping and clipped blocks while preserving quarter-hour boundaries", () => {
    const result = availableCourtIntervals(interval("18:00", "22:00"), [
      interval("21:15", "23:00"),
      interval("19:15", "20:00"),
      interval("17:00", "18:30"),
      interval("19:00", "19:45"),
    ]);
    expect(result).toEqual([
      { startAt: "2026-09-18T10:30:00.000Z", endAt: "2026-09-18T11:00:00.000Z" },
      { startAt: "2026-09-18T12:00:00.000Z", endAt: "2026-09-18T13:15:00.000Z" },
    ]);
    expect(availableCourtIntervals(interval("18:00", "22:00"), [interval("17:00", "23:00")])).toEqual([]);
  });
});
