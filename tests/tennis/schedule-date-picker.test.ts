import { describe, expect, it } from "vitest";
import {
  isScheduleDate, scheduleMonthDays, scheduleWeekStart, shiftScheduleDate, shiftScheduleMonth,
} from "../../apps/web/src/tennis/schedule-date-picker";

describe("schedule date picker", () => {
  it("accepts only existing, padded calendar dates in years 0001 through 9999", () => {
    for (const value of ["0001-01-01", "0099-12-31", "1900-02-28", "2000-02-29", "2024-02-29", "2025-02-28", "9999-12-31"]) {
      expect(isScheduleDate(value), value).toBe(true);
    }
    for (const value of ["", "0000-01-01", "10000-01-01", "2025-2-01", "2025-02-1", "2025-02-01 ", "2025-02-01T00:00:00Z", "1900-02-29", "2025-02-29", "2024-02-30", "2025-04-31", "2025-00-01", "2025-13-01", "2025-01-00"]) {
      expect(isScheduleDate(value), value).toBe(false);
    }
  });

  it("moves across leap days, year boundaries and daylight-saving dates as calendar days", () => {
    expect(shiftScheduleDate("1900-02-28", 1)).toBe("1900-03-01");
    expect(shiftScheduleDate("2000-02-28", 1)).toBe("2000-02-29");
    expect(shiftScheduleDate("2024-03-01", -1)).toBe("2024-02-29");
    expect(shiftScheduleDate("2025-02-28", 1)).toBe("2025-03-01");
    expect(shiftScheduleDate("2025-12-31", 1)).toBe("2026-01-01");
    expect(shiftScheduleDate("2026-01-01", -1)).toBe("2025-12-31");
    expect(shiftScheduleDate("2025-03-09", 1)).toBe("2025-03-10");
    expect(shiftScheduleDate("2025-11-02", 1)).toBe("2025-11-03");
    expect(shiftScheduleDate("0099-12-31", 1)).toBe("0100-01-01");
  });

  it("retains the day where possible and clamps to the destination month end", () => {
    expect(shiftScheduleMonth("1900-01-31", 1)).toBe("1900-02-28");
    expect(shiftScheduleMonth("2000-01-31", 1)).toBe("2000-02-29");
    expect(shiftScheduleMonth("2024-03-31", -1)).toBe("2024-02-29");
    expect(shiftScheduleMonth("2025-03-31", -1)).toBe("2025-02-28");
    expect(shiftScheduleMonth("2024-02-29", 12)).toBe("2025-02-28");
    expect(shiftScheduleMonth("2025-12-31", 1)).toBe("2026-01-31");
    expect(shiftScheduleMonth("2026-01-15", -13)).toBe("2024-12-15");
    expect(shiftScheduleMonth("0099-12-31", 1)).toBe("0100-01-31");
  });

  it("finds Monday for every weekday, including Sunday and a preceding year", () => {
    for (const value of ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27"]) {
      expect(scheduleWeekStart(value), value).toBe("2026-09-21");
    }
    expect(scheduleWeekStart("2026-01-01")).toBe("2025-12-29");
  });

  it("builds six Monday-first weeks with adjacent-month dates even when the month starts on Sunday", () => {
    const days = scheduleMonthDays("2025-06-18");
    expect(days).toHaveLength(42);
    expect(days.slice(0, 7)).toEqual(["2025-05-26", "2025-05-27", "2025-05-28", "2025-05-29", "2025-05-30", "2025-05-31", "2025-06-01"]);
    expect(days.slice(-7)).toEqual(["2025-06-30", "2025-07-01", "2025-07-02", "2025-07-03", "2025-07-04", "2025-07-05", "2025-07-06"]);
    expect(new Set(days).size).toBe(42);
    expect(scheduleMonthDays("2024-02-10")).toContain("2024-02-29");
    expect(scheduleMonthDays("1900-02-10")).not.toContain("1900-02-29");
    expect(scheduleMonthDays("2000-02-10")).toContain("2000-02-29");
    expect(scheduleMonthDays("2025-02-10")).not.toContain("2025-02-29");
  });

  it("clamps movement to supported year boundaries without applying the JavaScript 1900 offset", () => {
    expect(shiftScheduleDate("0001-01-01", -1)).toBe("0001-01-01");
    expect(shiftScheduleDate("9999-12-31", 1)).toBe("9999-12-31");
    expect(shiftScheduleDate("0001-01-15", -100)).toBe("0001-01-01");
    expect(shiftScheduleDate("9999-12-15", 100)).toBe("9999-12-31");
    expect(shiftScheduleMonth("0001-01-15", -1)).toBe("0001-01-01");
    expect(shiftScheduleMonth("9999-12-15", 1)).toBe("9999-12-31");
    expect(shiftScheduleMonth("0001-02-28", -1)).toBe("0001-01-28");
    expect(shiftScheduleMonth("9999-11-30", 1)).toBe("9999-12-30");
    expect(scheduleWeekStart("0001-01-01")).toBe("0001-01-01");
    expect(scheduleWeekStart("9999-12-31")).toBe("9999-12-27");
  });

  it("keeps boundary month grids aligned and represents unsupported dates as null", () => {
    const first = scheduleMonthDays("0001-01-01");
    expect(first).toHaveLength(42);
    expect(first[0]).toBe("0001-01-01");
    expect(first.at(-1)).toBe("0001-02-11");
    const last = scheduleMonthDays("9999-12-31");
    expect(last).toHaveLength(42);
    expect(last[0]).toBe("9999-11-29");
    expect(last[32]).toBe("9999-12-31");
    expect(last.slice(33)).toEqual(Array(9).fill(null));
  });
});
