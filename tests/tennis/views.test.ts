import { describe, expect, it } from "vitest";
import { parseOrderListQuery, venueDayRange } from "../../packages/db/src/tennis/views.ts";

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

describe("order query validation", () => {
  it("accepts bounded pages, literal search and an explicit active-day filter", () => {
    expect(
      parseOrderListQuery({
        q: " 100%_场 ",
        date: "2028-02-29",
        status: "ACTIVE",
        pageSize: "100",
        cursor: "last-order",
      }),
    ).toMatchObject({ q: "100%_场", date: "2028-02-29", status: "ACTIVE", pageSize: 100, cursor: "last-order" });
    expect(parseOrderListQuery().pageSize).toBe(25);
  });
  it.each([
    null,
    [],
    { q: ["one", "two"] },
    { status: ["HELD", "CONFIRMED"] },
    { status: "UNKNOWN" },
    { date: "2026-02-30" },
    { date: "" },
    { date: ["2026-01-01"] },
    { q: "a".repeat(201) },
    { pageSize: "0" },
    { pageSize: "101" },
    { pageSize: "1.5" },
    { pageSize: "1e1" },
    { pageSize: " 5" },
    { pageSize: ["5", "10"] },
    { pageSize: false },
    { pageSize: NaN },
    { pageSize: -1 },
    { cursor: "" },
    { cursor: ["one"] },
    { cursor: "x".repeat(201) },
    { tenantId: "override" },
  ])("rejects malformed or repeated query values: %j", (query) => {
    expect(() => parseOrderListQuery(query)).toThrow("INVALID_ORDER_QUERY");
  });
});
