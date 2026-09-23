import { describe, expect, it } from "vitest";
import { manualBookingDurations, manualBookingStartMinutes } from "../../apps/web/src/tennis/manualBookingTime";
import type { OpeningWindow } from "../../packages/domain/src/tennis-pricing";

const monday = "2026-09-21";
const starts = (hours: OpeningWindow[], duration = 60, minimum: number | null = 15, date = monday) =>
  manualBookingStartMinutes(date, duration, minimum, "Asia/Shanghai", hours);

describe("manual booking time choices", () => {
  it("uses the selected day's opening hours, including hours outside another day's calendar axis", () => {
    const hours = [
      { weekday: 1, startMinute: 480, endMinute: 1320 },
      { weekday: 3, startMinute: 360, endMinute: 1440 },
    ];
    expect(starts(hours)).not.toContain(360);
    expect(starts(hours)).not.toContain(1380);
    const wednesday = starts(hours, 60, 15, "2026-09-23");
    expect(wednesday[0]).toBe(360);
    expect(wednesday.at(-1)).toBe(1380);
  });

  it("excludes intervals that overlap a midday closure or exceed the closing time", () => {
    const options = starts([
      { weekday: 1, startMinute: 480, endMinute: 720 },
      { weekday: 1, startMinute: 840, endMinute: 1080 },
    ], 90);
    expect(options).toContain(630);
    expect(options).not.toContain(645);
    expect(options).not.toContain(720);
    expect(options).toContain(840);
    expect(options.at(-1)).toBe(990);
  });

  it("allows a reservation across adjacent opening windows", () => {
    expect(starts([
      { weekday: 1, startMinute: 480, endMinute: 720 },
      { weekday: 1, startMinute: 720, endMinute: 1080 },
    ], 90)).toContain(690);
  });

  it("offers midnight through the last full interval on an all-day opening", () => {
    const hours = [{ weekday: 1, startMinute: 0, endMinute: 1440 }];
    expect(starts(hours)[0]).toBe(0);
    expect(starts(hours).at(-1)).toBe(1380);
    expect(starts(hours, 15).at(-1)).toBe(1425);
    expect(starts(hours, 15)).not.toContain(1440);
  });

  it("preserves cross-midnight booking only when the next day remains open", () => {
    const mondayHours = { weekday: 1, startMinute: 1320, endMinute: 1440 };
    expect(starts([mondayHours], 120)).toEqual([1320]);
    expect(starts([mondayHours, { weekday: 2, startMinute: 0, endMinute: 120 }], 120))
      .toContain(1425);
  });

  it("shows no fabricated choices for a closed day or missing minimum", () => {
    const hours = [{ weekday: 1, startMinute: 480, endMinute: 1320 }];
    expect(starts(hours, 60, 15, "2026-09-22")).toEqual([]);
    expect(starts(hours, 60, null)).toEqual([]);
    expect(manualBookingDurations(null)).toEqual([]);
  });

  it("includes the exact configured minimum and removes shorter common durations", () => {
    expect(manualBookingDurations(75)).toEqual([75, 90, 120, 180, 240]);
    expect(manualBookingDurations(300)).toEqual([300]);
    const hours = [{ weekday: 1, startMinute: 480, endMinute: 555 }];
    expect(starts(hours, 60, 75)).toEqual([]);
    expect(starts(hours, 75, 75)).toEqual([480]);
    expect(starts(hours, 90, 75)).toEqual([]);
  });

  it("does not turn an invalid date or interval into a selectable start", () => {
    const hours = [{ weekday: 1, startMinute: 0, endMinute: 1440 }];
    for (const date of ["", "2026-02-30", "invalid"])
      expect(starts(hours, 60, 15, date)).toEqual([]);
    expect(starts(hours, 20)).toEqual([]);
  });

  it("rejects nonexistent local starts and intervals shorter than the minimum during DST", () => {
    const hours = [{ weekday: 0, startMinute: 0, endMinute: 1440 }];
    const choices = manualBookingStartMinutes("2026-03-08", 180, 180, "America/New_York", hours);
    expect(choices).not.toContain(60);
    expect(choices).not.toContain(120);
    expect(choices).toContain(180);
  });
});
