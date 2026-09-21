import { expect, it } from "vitest";
import { appendSelection, rectangle } from "../../apps/web/src/tennis/selection";
const line = (courtId: string, start = "09", end = "10") => ({
  courtId,
  startAt: `2099-09-18T${start}:00:00Z`,
  endAt: `2099-09-18T${end}:00:00Z`,
});
it("normalizes reverse multi-court drag across an hour boundary", () => {
  expect(rectangle({ row: 3, slot: 8 }, { row: 1, slot: 3 })).toEqual({
    firstRow: 1,
    lastRow: 3,
    firstSlot: 3,
    lastSlot: 8,
  });
});
it("keeps simultaneous courts and disjoint periods without filling gaps", () => {
  expect(appendSelection([line("a")], [line("b"), line("c"), line("a", "12", "13")])).toHaveLength(4);
  expect(() => appendSelection([line("a")], [line("a")])).toThrow("重叠");
  expect(appendSelection([line("a")], [line("a", "10", "11")])).toHaveLength(2);
});
