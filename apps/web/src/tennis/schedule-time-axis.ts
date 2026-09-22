// Keep this width in sync with .tennis-time-label so collision checks match the text boxes.
export const SCHEDULE_TIME_LABEL_WIDTH = 40;
const LABEL_GAP = 8;

export interface ScheduleTimePoint {
  minute: number;
  slot: number;
  fraction: number;
  hour: boolean;
  label: boolean;
  edge: "start" | "end" | null;
}

/** Slot starts plus the final slot end, with labels placed on clock boundaries. */
export function scheduleTimeAxis(ticks: readonly number[], width: number): ScheduleTimePoint[] {
  if (!ticks.length) return [];
  const minutes = [...ticks, ticks[ticks.length - 1]! + 15];
  const span = minutes[minutes.length - 1]! - minutes[0]!;
  const availableWidth = Math.max(0, width);
  const hourStep = Math.max(1, Math.ceil((span / 60) * (SCHEDULE_TIME_LABEL_WIDTH + LABEL_GAP) / Math.max(1, availableWidth)));
  const firstHour = Math.ceil(minutes[0]! / 60);
  const lastLabelLeft = availableWidth - SCHEDULE_TIME_LABEL_WIDTH;
  let previousLabelRight = SCHEDULE_TIME_LABEL_WIDTH;

  return minutes.map((minute, slot) => {
    const fraction = slot / ticks.length;
    const edge = slot === 0 ? "start" : slot === ticks.length ? "end" : null;
    const hour = minute % 60 === 0;
    let label = edge !== null;
    if (!edge && hour && (minute / 60 - firstHour) % hourStep === 0) {
      const left = fraction * availableWidth - SCHEDULE_TIME_LABEL_WIDTH / 2;
      const right = left + SCHEDULE_TIME_LABEL_WIDTH;
      if (left >= previousLabelRight + LABEL_GAP && right + LABEL_GAP <= lastLabelLeft) {
        label = true;
        previousLabelRight = right;
      }
    }
    return { minute, slot, fraction, hour, label, edge };
  });
}
