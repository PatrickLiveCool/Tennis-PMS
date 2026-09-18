import { describe, expect, it } from "vitest";
import { venueDayRange } from "../../packages/db/src/tennis/views.ts";

describe("venue calendar-day boundaries", () => {
  it("maps Shanghai and quarter-hour-offset local midnight to UTC", () => {
    expect(venueDayRange("2035-01-01", "Asia/Shanghai")).toEqual({
      startAt: "2034-12-31T16:00:00.000Z",
      endAt: "2035-01-01T16:00:00.000Z",
    });
    expect(venueDayRange("2035-01-01", "Asia/Kathmandu")).toEqual({
      startAt: "2034-12-31T18:15:00.000Z",
      endAt: "2035-01-01T18:15:00.000Z",
    });
  });
  it("includes exactly the 23-hour and 25-hour DST days without losing a repeated hour", () => {
    expect(venueDayRange("2026-03-08", "America/New_York")).toEqual({
      startAt: "2026-03-08T05:00:00.000Z",
      endAt: "2026-03-09T04:00:00.000Z",
    });
    expect(venueDayRange("2026-11-01", "America/New_York")).toEqual({
      startAt: "2026-11-01T04:00:00.000Z",
      endAt: "2026-11-02T05:00:00.000Z",
    });
  });
  it("rejects invalid calendar dates and a date skipped by a timezone change", () => {
    for (const invalid of ["2026-02-30", "2026-13-01", "01/02/2026", ""])
      expect(() => venueDayRange(invalid, "Asia/Shanghai")).toThrow("INVALID_DATE");
    expect(() => venueDayRange("2011-12-30", "Pacific/Apia")).toThrow("INVALID_DATE");
  });
});
