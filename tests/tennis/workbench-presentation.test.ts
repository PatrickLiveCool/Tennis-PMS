// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as uiBasic from "../../apps/web/src/uiBasic";
import { ScheduleGrid } from "../../apps/web/src/tennis/ScheduleGrid";
import { OrderDialog, OrdersPage } from "../../apps/web/src/tennis/OrdersPage";
import { emptyCourtProfile } from "../../packages/domain/src/tennis-court-profile";
import type { CourtRecord, Schedule, SelectionLine, Session, VenueRecord } from "../../apps/web/src/tennis/types";

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
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function renderSchedule(lines: SelectionLine[] = [], occupancies = [occupied], issues: string[] = [],
  options: { venue?: VenueRecord; date?: string } = {}) {
  const callbacks = { onAdd: vi.fn(), onRemove: vi.fn(), onResize: vi.fn(), openOrder: vi.fn() };
  const scheduleVenue = options.venue ?? venue;
  await act(async () => root.render(createElement(ScheduleGrid, {
    schedule: { venue: scheduleVenue, courts: [court], occupancies }, venue: scheduleVenue, date: options.date ?? "2026-09-21",
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
    const mobile = container.querySelector<HTMLButtonElement>('.tennis-mobile-times button[aria-label="中央球场 · 合成球友 · 已预订 · 09:00–10:00"]')!;
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

  it("shows a course and the following booking within the same hour with their actual times", async () => {
    const course = { ...occupied, id: "course", kind: "COURSE", orderId: null,
      endAt: "2026-09-21T01:30:00.000Z" };
    const booking = { ...occupied, startAt: course.endAt };
    const callbacks = await renderSchedule([], [course, booking]);
    const mobile = container.querySelector(".tennis-mobile-times")!;
    const courseButton = [...mobile.querySelectorAll("button")].find((button) => button.textContent?.includes("课程"))!;
    const bookingButton = [...mobile.querySelectorAll("button")].find((button) => button.textContent?.includes("合成球友"));
    expect(courseButton.textContent).toContain("09:00–09:30");
    expect(courseButton.disabled).toBe(true);
    expect(bookingButton?.textContent).toContain("09:30–10:00");
    await act(async () => bookingButton!.click());
    expect(callbacks.openOrder).toHaveBeenCalledWith("synthetic-order");
  });

  it("opens each adjacent booking within one hour independently", async () => {
    const first = { ...occupied, endAt: "2026-09-21T01:30:00.000Z" };
    const second = { ...occupied, id: "second-occupancy", orderId: "second-order", customerName: "另一位球友",
      startAt: first.endAt };
    const callbacks = await renderSchedule([], [second, first]);
    const buttons = [...container.querySelectorAll<HTMLButtonElement>(".tennis-mobile-times button")]
      .filter((button) => button.textContent?.includes("球友"));
    expect(buttons.map((button) => button.textContent)).toEqual([
      expect.stringContaining("09:00–09:30"), expect.stringContaining("09:30–10:00"),
    ]);
    await act(async () => buttons.forEach((button) => button.click()));
    expect(callbacks.openOrder.mock.calls).toEqual([["synthetic-order"], ["second-order"]]);
  });

  it("shows a booking spanning several hours only once on the phone", async () => {
    await renderSchedule([], [{ ...occupied, startAt: "2026-09-21T00:30:00.000Z", endAt: "2026-09-21T03:30:00.000Z" }]);
    const tickets = [...container.querySelectorAll(".tennis-mobile-times button")]
      .filter((button) => button.textContent?.includes("合成球友"));
    expect(tickets).toHaveLength(1);
    expect(tickets[0]?.textContent).toContain("08:30–11:30");
  });

  it("keeps the real order accessible alongside a conflicting draft cancellation", async () => {
    const draft = { courtId: court.id, startAt: occupied.startAt, endAt: occupied.endAt };
    const callbacks = await renderSchedule([draft], [occupied], ["该时段已被占用"]);
    const cancel = container.querySelector<HTMLButtonElement>(".tennis-mobile-times .has-conflict")!;
    const ticket = [...container.querySelectorAll<HTMLButtonElement>(".tennis-mobile-times button")]
      .find((button) => button.textContent?.includes("合成球友"));
    expect(ticket).toBeDefined();
    expect(cancel.getAttribute("aria-label")).toBe("中央球场 · 冲突 · 取消已选 · 09:00–10:00");
    await act(async () => ticket!.click());
    expect(callbacks.openOrder).toHaveBeenCalledWith("synthetic-order");
    expect(callbacks.onRemove).not.toHaveBeenCalled();
    await act(async () => cancel.click());
    expect(callbacks.onRemove).toHaveBeenCalledWith(0);
    expect(callbacks.openOrder).toHaveBeenCalledTimes(1);
  });

  it("renders a valid daytime schedule when DST skips the local midnight", async () => {
    vi.setSystemTime(new Date("2026-09-05T00:00:00Z"));
    const santiago = { ...venue, timezone: "America/Santiago",
      openingHours: [{ weekday: 0, startMinute: 480, endMinute: 720 }] };
    const booking = { ...occupied, startAt: "2026-09-06T12:00:00.000Z", endAt: "2026-09-06T13:00:00.000Z" };
    const callbacks = await renderSchedule([], [booking], [], { venue: santiago, date: "2026-09-06" });
    const ticket = container.querySelector<HTMLButtonElement>('.tennis-mobile-times button[aria-label="中央球场 · 合成球友 · 已预订 · 09:00–10:00"]')!;
    expect(ticket).not.toBeNull();
    await act(async () => ticket.click());
    expect(callbacks.openOrder).toHaveBeenCalledWith("synthetic-order");
  });

  it.each(["COURSE", "MAINTENANCE"])("shows dates on both remote endpoints of a multi-day %s occupancy", async (kind) => {
    await renderSchedule([], [{ ...occupied, kind, orderId: null,
      startAt: "2026-09-20T14:00:00.000Z", endAt: "2026-09-22T02:00:00.000Z" }]);
    const ticket = container.querySelector<HTMLButtonElement>(`.tennis-mobile-times .is-${kind === "COURSE" ? "course" : "maintenance"}`)!;
    const interval = "2026-09-20 22:00–2026-09-22 10:00";
    expect(ticket.textContent).toContain(interval);
    expect(ticket.getAttribute("aria-label")).toContain(interval);
    expect(ticket.title).toContain(interval);
    expect(ticket.disabled).toBe(true);
  });

  it("excludes an occupancy ending exactly at the start of this local date", async () => {
    await renderSchedule([], [{ ...occupied, startAt: "2026-09-20T14:00:00.000Z", endAt: "2026-09-20T16:00:00.000Z" }]);
    expect(container.querySelector(".tennis-mobile-times")?.textContent).not.toContain("合成球友");
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

  it.each([["HELD", "有效"], ["EXPIRED", "已释放"]])(
    "shows the remaining slot of a %s order separately from its previously cancelled slot",
    async (status, remainingStatus) => {
      vi.spyOn(uiBasic, "Modal").mockImplementation(({ children }) => createElement("dialog", { open: true }, children));
      const session: Session = {
        subjectId: "player", displayName: "合成球友", csrfToken: "synthetic", tenantId: venue.tenantId,
        kind: "customer", platformOperator: false, contextVersion: 1, permissions: [], allVenues: false,
        venueIds: [venue.id], customerId: "player", expiresAt: "2099-01-01T00:00:00Z", tenants: [],
      };
      const line = { courtId: court.id, startAt: occupied.startAt, endAt: occupied.endAt, amountCents: 12000, price: { segments: [] } };
      const api = vi.fn().mockImplementation(async (path: string) => {
        if (path === "/orders/booking") return {
          id: "booking", customerId: "player", status, revision: 2, paymentStatus: "UNPAID",
          totalCents: 12000, createdAt: "2026-09-19T08:00:00Z", lines: [
            { ...line, id: "remaining", cancelledAt: null },
            { ...line, id: "cancelled", startAt: occupied.endAt, endAt: "2026-09-21T03:00:00Z", cancelledAt: "2026-09-19T08:02:00Z" },
          ],
        };
        if (path === `/venues/${venue.id}/courts`) return [court];
        if (path === "/orders/booking/amendments") return [];
        throw new Error(`Unexpected request: ${path}`);
      });
      await act(async () => root.render(createElement(OrderDialog, {
        api, session, venue, scope: "order-detail", orderId: "booking", onClose: vi.fn(), onChanged: vi.fn(),
      })));
      const states = [...container.querySelectorAll("dialog .tennis-table tbody tr")].map(row => row.lastElementChild?.textContent);
      expect(states).toEqual([remainingStatus, "已取消"]);
    },
  );

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
