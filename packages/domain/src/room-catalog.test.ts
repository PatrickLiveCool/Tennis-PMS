import { describe, expect, it } from "vitest";
import type { ManagedRoomType } from "@qintopia/contracts";
import { catalogAnchorsAt, trialRoomRate, validateRoomRateAnchors } from "./room-catalog.ts";
const anchors = { "1": 6800, "7": 38000, "14": 55000, "30": 90000 };
const type: ManagedRoomType = { code: "double", name: "两人间", bathroom: "SHARED", saleMode: "BED", bedCount: 2, capacity: 2, active: true,
  products: [{ code: "bed", kind: "BED", multiplier: 1 }, { code: "whole", kind: "ROOM", multiplier: 2 }] };
describe("room catalog prices", () => {
  it("uses duration bands and rounds the complete whole-room total once", () => {
    expect(trialRoomRate(anchors, "2026-10-01", "2026-10-14", 2)).toEqual({ nights: 13, anchorNights: 7, amountMinor: 141100 });
    expect(trialRoomRate(anchors, "2026-10-01", "2026-10-15")).toMatchObject({ anchorNights: 14, amountMinor: 55000 });
    expect(trialRoomRate(anchors, "2026-10-25", "2026-11-24")).toMatchObject({ anchorNights: 30, amountMinor: 90000 });
  });
  it("preserves separately scheduled changes and chooses the latest revision on the same effective date", () => {
    const second = { ...type, code: "single", products: [{ code: "single_room", kind: "ROOM" as const, multiplier: 1 }] };
    const rates = [{ id: "a", typeCode: "double", version: 1, effectiveFrom: "2026-12-01", anchors: { ...anchors, "1": 10000 } },
      { id: "b", typeCode: "single", version: 2, effectiveFrom: "2026-11-01", anchors: { ...anchors, "1": 20000 } },
      { id: "c", typeCode: "double", version: 3, effectiveFrom: "2026-12-01", anchors: { ...anchors, "1": 11000 } }];
    const prices = catalogAnchorsAt("2026-12-10", { bed: anchors, single_room: anchors }, [type, second], rates);
    expect(prices.bed![1]).toBe(11000);
    expect(prices.whole![1]).toBe(22000);
    expect(prices.single_room![1]).toBe(20000);
    expect(catalogAnchorsAt("2026-10-31", { bed: anchors }, [type], rates).bed).toEqual(anchors);
  });
  it.each([{ ...anchors, "1": 0 }, { ...anchors, "1": 0.1 }, { "1": 100 }, { ...anchors, extra: 1 }])("rejects invalid or incomplete anchors", (input) => {
    expect(() => validateRoomRateAnchors(input)).toThrow();
  });
});
