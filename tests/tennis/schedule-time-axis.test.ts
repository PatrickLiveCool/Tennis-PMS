import { describe, expect, it } from "vitest";
import { scheduleTimeAxis, SCHEDULE_TIME_LABEL_WIDTH } from "../../apps/web/src/tennis/schedule-time-axis";

const ticks = (from: number, to: number) => Array.from({ length: (to - from) / 15 }, (_, slot) => from + slot * 15);

describe("schedule time axis", () => {
  it("places 07:00 at the first slot boundary and includes the final 23:00 boundary", () => {
    const points = scheduleTimeAxis(ticks(7 * 60, 23 * 60), 1200);
    expect(points).toHaveLength(65);
    expect(points[0]).toMatchObject({ minute: 420, slot: 0, fraction: 0, hour: true, label: true, edge: "start" });
    expect(points.find((point) => point.minute === 480)).toMatchObject({ slot: 4, fraction: 1 / 16, hour: true });
    expect(points.at(-1)).toMatchObject({ minute: 1380, slot: 64, fraction: 1, hour: true, label: true, edge: "end" });
  });

  it("preserves 24:00 as the endpoint of an all-day schedule", () => {
    const points = scheduleTimeAxis(ticks(0, 1440), 1000);
    expect(points).toHaveLength(97);
    expect(points.at(-1)).toMatchObject({ minute: 1440, fraction: 1, label: true, edge: "end" });
    expect(points.filter((point) => point.hour)).toHaveLength(25);
  });

  it("uses actual integer-hour boundaries when operating hours start on a quarter hour", () => {
    const points = scheduleTimeAxis(ticks(555, 765), 600);
    expect(points[0]).toMatchObject({ minute: 555, hour: false, label: true });
    expect(points.find((point) => point.minute === 600)).toMatchObject({ slot: 3, fraction: 3 / 14, hour: true, label: true });
    expect(points.find((point) => point.minute === 615)).toMatchObject({ hour: false, label: false });
    expect(points.at(-1)).toMatchObject({ minute: 765, label: true, edge: "end" });
  });

  it("reserves complete endpoint labels and prevents label overlap as the board narrows", () => {
    for (const width of [96, 148, 250, 420, 800, 1200, 1920]) {
      const points = scheduleTimeAxis(ticks(0, 1440), width);
      const labels = points.filter((point) => point.label);
      expect(labels[0]?.minute).toBe(0);
      expect(labels.at(-1)?.minute).toBe(1440);
      const boxes = labels.map((point) => {
        const left = point.edge === "start" ? 0 : point.edge === "end" ? width - SCHEDULE_TIME_LABEL_WIDTH
          : point.fraction * width - SCHEDULE_TIME_LABEL_WIDTH / 2;
        return { left, right: left + SCHEDULE_TIME_LABEL_WIDTH };
      });
      for (const [index, box] of boxes.entries()) {
        expect(box.left).toBeGreaterThanOrEqual(0);
        expect(box.right).toBeLessThanOrEqual(width);
        if (index) expect(box.left - boxes[index - 1]!.right).toBeGreaterThanOrEqual(8);
      }
    }
    const narrow = scheduleTimeAxis(ticks(420, 1380), 250);
    const wide = scheduleTimeAxis(ticks(420, 1380), 1600);
    expect(narrow.filter((point) => point.label).length).toBeLessThan(wide.filter((point) => point.label).length);
    expect(narrow.map((point) => point.fraction)).toEqual(wide.map((point) => point.fraction));
  });

  it("handles an empty schedule and a single quarter-hour slot without inventing another slot", () => {
    expect(scheduleTimeAxis([], 500)).toEqual([]);
    expect(scheduleTimeAxis([555], 96)).toEqual([
      { minute: 555, slot: 0, fraction: 0, hour: false, label: true, edge: "start" },
      { minute: 570, slot: 1, fraction: 1, hour: false, label: true, edge: "end" },
    ]);
  });
});
