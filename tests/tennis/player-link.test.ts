import { describe, expect, it } from "vitest";
import { parsePlayerEntry } from "../../packages/domain/src/tennis-player-link.ts";
const a = "venue~one,2099-11-20T06:00Z,2099-11-20T07:00Z";
const b = a.replace("one", "two");
const read = (mode: string, ...options: string[]) => {
  const search = new URLSearchParams({ booking: mode });
  options.forEach(option => search.append("option", option));
  return parsePlayerEntry(search.toString());
};
describe("player links from booking conversations", () => {
  it("enters personal bookings without a handoff and binds order links to an explicit id", () => {
    expect(parsePlayerEntry("")).toEqual({ kind: "mine" });
    expect(parsePlayerEntry("?booking=order&id=x")).toEqual({ kind: "order", id: "x" });
    expect(parsePlayerEntry("?booking=order&id=x&id=y")).toEqual({ kind: "invalid" });
  });
  it("requires explicit choice mode for alternatives and keeps multi-court bookings together", () => {
    expect(read("confirm", a, b)).toEqual({ kind: "invalid" });
    expect(read("choose", a, b)).toMatchObject({ kind: "choose", options: [{ venueId: "venue" }, { venueId: "venue" }] });
    expect(read("confirm", a + b.slice(b.indexOf("~")))).toMatchObject({ kind: "confirm", options: [
      { lines: [{ courtId: "one", startAt: "2099-11-20T06:00:00.000Z" }, { courtId: "two" }] }] });
  });
  it("rejects duplicated options, invalid dates, overlaps, damaged ranges and ambiguous modes", () => {
    for (const bad of [a.replace("11-20", "02-31"), a.replace("06:00Z", "07:01Z"), a.replace("06:00Z","06:00:01Z"),
      a.replace("~one", "~"), a + a.slice(a.indexOf("~"))]) expect(read("confirm", bad)).toEqual({ kind: "invalid" });
    expect(read("choose", a, a)).toEqual({ kind: "invalid" });
    expect(parsePlayerEntry("?booking=confirm&booking=choose&option=" + a)).toEqual({ kind: "invalid" });
  });
});
