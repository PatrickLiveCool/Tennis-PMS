import { describe, expect, it } from "vitest";
import { parseBusinessEventQuery } from "../../packages/db/src/tennis/business-events.ts";

describe("business event poll query", () => {
  it("uses bounded pages and opaque event UUID cursors", () => {
    expect(parseBusinessEventQuery()).toEqual({ pageSize: 50, cursor: null });
    expect(parseBusinessEventQuery({ pageSize: "100", cursor: "71ad5d38-015d-43a6-999c-c195f95969b4" })).toEqual({
      pageSize: 100,
      cursor: "71ad5d38-015d-43a6-999c-c195f95969b4",
    });
  });
  it.each([
    null,
    [],
    { cursor: "" },
    { cursor: "1" },
    { cursor: ["71ad5d38-015d-43a6-999c-c195f95969b4"] },
    { pageSize: 0 },
    { pageSize: "101" },
    { pageSize: 1.5 },
    { pageSize: "1e1" },
    { pageSize: ["1", "2"] },
    { tenantId: "caller-override" },
    { venueId: "caller-override" },
    { customerId: "caller-override" },
  ])("rejects invalid or scope-changing query %j", (query) => {
    expect(() => parseBusinessEventQuery(query)).toThrow("INVALID_EVENT_QUERY");
  });
});
