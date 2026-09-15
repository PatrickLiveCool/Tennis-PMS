import { describe, expect, it } from "vitest";
import { resolveBuildingOrder, sortRoomsByBuilding } from "./building-order.ts";

describe("building display order", () => {
  it("preserves legacy first appearance and appends new buildings without treating E as 1", () => {
    const rooms = [{ building_code: "1" }, { building_code: "E" }, { building_code: "E" }, { building_code: "F" }, { building_code: null }];
    expect(resolveBuildingOrder(rooms)).toEqual(["1", "E", "F"]);
    expect(resolveBuildingOrder(rooms, ["E", "1"])).toEqual(["E", "1", "F"]);
  });
  it("groups buildings while keeping room order stable and unassigned rooms last", () => {
    const rooms = [
      { code: "001", buildingCode: "F" }, { code: "002", buildingCode: null },
      { code: "101", buildingCode: "1" }, { code: "E01", buildingCode: "E" }, { code: "E02", buildingCode: "E" }
    ];
    expect(sortRoomsByBuilding(rooms, ["1", "E", "F"]).map((room) => room.code)).toEqual(["101", "E01", "E02", "001", "002"]);
    expect(rooms[0]?.code).toBe("001");
  });
});
