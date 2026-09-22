import { describe, expect, it } from "vitest";
import { isCourtReadyForBooking, missingCourtPurchaseFields, type CourtPurchaseInfo } from "./tennis-court-profile.ts";

const ready: CourtPurchaseInfo = {
  name: "一号场", hourlyPriceCents: 10000, environment: "INDOOR", surface: "ACRYLIC", profile: { specification: "STANDARD" },
};

describe("minimum court purchase information", () => {
  it("accepts a free court and explicit other classifications without inventing optional details", () => {
    expect(isCourtReadyForBooking({ ...ready, hourlyPriceCents: 0, surface: "OTHER", profile: { specification: "OTHER" } })).toBe(true);
    expect(missingCourtPurchaseFields(ready)).toEqual([]);
  });
  it("reports precisely which required facts still need to be supplied", () => {
    expect(missingCourtPurchaseFields({ name: " ", hourlyPriceCents: null, surface: "UNSPECIFIED", profile: { specification: "UNSPECIFIED" } }))
      .toEqual(["name", "hourlyPriceCents", "environment", "surface", "specification"]);
    expect(missingCourtPurchaseFields({ ...ready, surface: "UNSPECIFIED" })).toEqual(["surface"]);
  });
  it.each([undefined, null, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects an absent or invalid integer-cent price: %s", (price) => {
    const { hourlyPriceCents: _price, ...withoutPrice } = ready;
    expect(missingCourtPurchaseFields({ ...withoutPrice, ...(price === undefined ? {} : { hourlyPriceCents: price }) })).toEqual(["hourlyPriceCents"]);
  });
  it("accepts explicitly recorded legacy indoor and outdoor facts, but never assumes an environment", () => {
    expect(isCourtReadyForBooking({ ...ready, environment: null, indoor: false })).toBe(true);
    expect(isCourtReadyForBooking({ ...ready, environment: null, indoor: true })).toBe(true);
    expect(missingCourtPurchaseFields({ ...ready, environment: null })).toEqual(["environment"]);
    expect(missingCourtPurchaseFields({ ...ready, environment: "", indoor: false })).toEqual(["environment"]);
  });
  it("does not consider unknown enum values or inherited property names explicit purchase facts", () => {
    expect(missingCourtPurchaseFields({ ...ready, environment: "toString", surface: "invented", profile: { specification: "constructor" } }))
      .toEqual(["environment", "surface", "specification"]);
  });
});
