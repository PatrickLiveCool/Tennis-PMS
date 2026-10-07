// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScheduleGrid } from "../../apps/web/src/tennis/ScheduleGrid";
import { OrdersPage } from "../../apps/web/src/tennis/OrdersPage";
import { emptyCourtProfile } from "../../packages/domain/src/tennis-court-profile";
import type { CourtRecord, Schedule, SelectionLine, VenueRecord } from "../../apps/web/src/tennis/types";

const { directory } = vi.hoisted(() => ({ directory: vi.fn() }));
vi.mock("../../apps/web/src/tennis/OrderDirectory", () => ({
  useOrderDirectory: directory,
  OrderPagination: () => null,
}));
const venue: VenueRecord = {
  id: "synthetic-venue", tenantId: "synthetic-tenant", name: "合成测试场馆", address: "", active: true,
  timezone: "Asia/Shanghai", minimumBookingMinutes: 15, catalogRevision: 1,
  openingHours: [{ weekday: 1, startMinute: 480, endMinute: 720 }],
};
const court: CourtRecord = {
  id: "synthetic-court", tenantId: venue.tenantId, venueId: venue.id, name: "中央球场",
  active: true, indoor: true, environment: "INDOOR", surface: "CLAY", revision: 1,
  hourlyPriceCents: 12000, profile: { ...emptyCourtProfile, specification: "STANDARD" },
};
const occupied: Schedule["occupancies"][number] = {
  id: "synthetic-occupancy", courtId: court.id, startAt: "2026-09-21T01:00:00.000Z",
  endAt: "2026-09-21T02:00:00.000Z", kind: "BOOKING", orderId: "synthetic-order",
  status: "CONFIRMED", customerName: "合成球友",
};
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-20T00:00:00Z"));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  sessionStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function renderSchedule(lines: SelectionLine[] = [], occupancies = [occupied], issues: string[] = []) {
  const callbacks = { onAdd: vi.fn(), onRemove: vi.fn(), onResize: vi.fn(), openOrder: vi.fn() };
  await act(async () => root.render(createElement(ScheduleGrid, {
    schedule: { venue, courts: [court], occupancies }, venue, date: "2026-09-21",
    ticks: Array.from({ length: 20 }, (_, i) => 480 + i * 15), lines, disabled: false,
    scrollRef: { current: container }, issues, ...callbacks,
  })));
  return callbacks;
}

describe("tennis workbench presentation", () => {
  it("keeps a complete accessible ticket and opens the same order on desktop and phone", async () => {
    const callbacks = await renderSchedule();
    const ticket = container.querySelector<HTMLButtonElement>(".tennis-schedule-block")!;
    expect(ticket.getAttribute("aria-label")).toBe("中央球场 · 合成球友 · 已预订 · 09:00–10:00");
    expect(ticket.querySelector("strong")?.textContent).toBe("合成球友");
    expect(ticket.querySelector(".tennis-occupancy-status")?.textContent).toBe("已预订");
    const mobile = container.querySelector<HTMLButtonElement>('.tennis-mobile-times button[aria-label="中央球场 09:00 查看占用"]')!;
    await act(async () => { ticket.click(); mobile.click(); });
    expect(callbacks.openOrder.mock.calls).toEqual([["synthetic-order"], ["synthetic-order"]]);
    expect(container.querySelector(".tennis-mobile-court-name")?.textContent).toBe("中央球场");
    expect(container.querySelector(".tennis-mobile-court-details")?.textContent).toContain("红土场");
    expect(container.querySelector(".tennis-mobile-court-price")?.textContent).toContain("120.00");
  });

  it("preserves one-hour selection, draft cancellation and unavailable hours", async () => {
    const callbacks = await renderSchedule();
    const free = container.querySelector<HTMLButtonElement>('.tennis-mobile-times button[aria-label="中央球场 08:00 选场"]')!;
    expect(free.textContent).toContain("空闲");
    await act(async () => free.click());
    expect(callbacks.onAdd).toHaveBeenCalledWith([{
      courtId: court.id, startAt: "2026-09-21T00:00:00.000Z", endAt: "2026-09-21T01:00:00.000Z",
    }]);
    expect(container.querySelector<HTMLButtonElement>('.tennis-mobile-times button[aria-label="中央球场 12:00 不可售"]')?.disabled).toBe(true);
    const cancel = await renderSchedule(callbacks.onAdd.mock.calls[0]![0]);
    const selected = container.querySelector<HTMLButtonElement>(".tennis-mobile-times .is-selected")!;
    expect(selected.textContent).toContain("已选");
    await act(async () => selected.click());
    expect(cancel.onRemove).toHaveBeenCalledWith(0);
  });

  it("keeps payment, maintenance and conflict states visible without relying on color", async () => {
    const held = { ...occupied, status: "HELD" };
    const maintenance = { ...occupied, id: "maintenance", startAt: "2026-09-21T03:00:00.000Z", endAt: "2026-09-21T04:00:00.000Z", kind: "MAINTENANCE", orderId: null };
    await renderSchedule([{ courtId: court.id, startAt: occupied.startAt, endAt: occupied.endAt }], [held, maintenance], ["该时段已被占用"]);
    expect(container.querySelector(".tennis-schedule-block.is-held")?.textContent).toContain("待付款");
    expect(container.querySelector<HTMLButtonElement>(".tennis-schedule-block.is-maintenance")?.disabled).toBe(true);
    expect(container.querySelector(".tennis-schedule-block.is-maintenance")?.textContent).toContain("维护");
    expect(container.querySelector(".tennis-draft-block.has-conflict")?.textContent).toContain("冲突");
    expect(container.querySelector(".tennis-mobile-times .has-conflict")?.textContent).toContain("冲突");
  });

  it("keeps order amounts, statuses, mobile labels and order actions together", async () => {
    directory.mockReturnValue({
      data: { orders: [{ id: "synthetic-order", customerName: "合成球友", totalCents: 12345,
        status: "HELD", paymentStatus: "UNPAID", matchingLines: [{ startAt: occupied.startAt }] }], nextCursor: null },
      busy: false, error: undefined, refresh: vi.fn(),
    });
    const openOrder = vi.fn();
    await act(async () => root.render(createElement(OrdersPage, { api: vi.fn(), venue, scope: "synthetic-orders", openOrder })));
    expect(container.querySelector('table[aria-label="预订订单"]')).not.toBeNull();
    expect(container.querySelector('[data-label="应付"]')?.textContent).toContain("123.45");
    expect(container.querySelector('[data-label="订单状态"]')?.textContent).toBe("待付款");
    expect(container.querySelector('[data-label="付款"]')?.textContent).toBe("未付款");
    await act(async () => container.querySelector<HTMLButtonElement>(".tennis-order-open button")!.click());
    expect(openOrder).toHaveBeenCalledWith("synthetic-order");
  });

  it("retains explicit error and empty-state messages", async () => {
    directory.mockReturnValue({ data: { orders: [], nextCursor: null }, busy: false,
      error: new Error("暂时无法读取订单"), refresh: vi.fn() });
    await act(async () => root.render(createElement(OrdersPage, { api: vi.fn(), venue, scope: "synthetic-empty", openOrder: vi.fn() })));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("暂时无法读取订单");
    expect(container.textContent).toContain("暂无符合条件的订单");
    expect(container.textContent).toContain("重试");
  });

  it("ships local variable-font binaries covering the workbench Chinese labels", () => {
    const cssPath = createRequire(import.meta.url).resolve("@fontsource-variable/noto-sans-sc/index.css");
    const css = readFileSync(cssPath, "utf8");
    const faces = [...css.matchAll(/@font-face\s*\{([^}]+)\}/g)].map((match) => {
      const face = match[1]!;
      const ranges = [...face.matchAll(/U\+([0-9a-f]+)(?:-([0-9a-f]+))?/gi)].map((range) => [parseInt(range[1]!, 16), parseInt(range[2] ?? range[1]!, 16)]);
      const file = /url\(([^)]+)\)/.exec(face)![1]!;
      return { ranges, file };
    });
    const required = new Set<string>();
    for (const character of "场地排期经营概览预订订单会员管理待付款已预订已选冲突维护中央球场空闲不可售智能助手¥0123456789") {
      const point = character.codePointAt(0)!;
      const face = faces.find(({ ranges }) => ranges.some(([start, end]) => point >= start! && point <= end!));
      expect(face, `Missing font range for ${character}`).toBeDefined();
      required.add(face!.file);
    }
    for (const file of required) expect(readFileSync(resolve(dirname(cssPath), file)).subarray(0, 4).toString()).toBe("wOF2");
    expect(css).toContain("font-display: swap");
    expect(css).toContain("font-weight: 100 900");
  });
});
