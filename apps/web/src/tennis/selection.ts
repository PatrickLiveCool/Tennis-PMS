import type { SelectionLine } from "./types";

export interface GridPoint {
  row: number;
  slot: number;
}
export function rectangle(from: GridPoint, to: GridPoint) {
  return {
    firstRow: Math.min(from.row, to.row),
    lastRow: Math.max(from.row, to.row),
    firstSlot: Math.min(from.slot, to.slot),
    lastSlot: Math.max(from.slot, to.slot),
  };
}
export function overlaps(a: SelectionLine, b: SelectionLine) {
  return (
    a.courtId === b.courtId &&
    Date.parse(a.startAt) < Date.parse(b.endAt) &&
    Date.parse(a.endAt) > Date.parse(b.startAt)
  );
}
export function appendSelection(existing: SelectionLine[], added: SelectionLine[]) {
  const result = [...existing, ...added];
  if (result.length > 100) throw new Error("一单最多选择 100 条时段。");
  if (result.some((line, i) => result.slice(i + 1).some((other) => overlaps(line, other))))
    throw new Error("选区与已有草稿重叠，请先取消原时段或拖动其边缘调整。");
  return result;
}
