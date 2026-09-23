// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BookingPage } from "../../apps/web/src/tennis/BookingPage";
import type { TennisApi } from "../../apps/web/src/tennis/api";
import type { CourtRecord, Session, VenueRecord } from "../../apps/web/src/tennis/types";
import { emptyCourtProfile } from "../../packages/domain/src/tennis-court-profile";

vi.mock("../../apps/web/src/tennis/ScheduleBoard", async () => {
  const { createElement } = await import("react");
  return { ScheduleBoard: ({ ticks }: { ticks: number[] }) =>
    createElement("div", { "data-grid-start": ticks[0], "data-grid-end": ticks.at(-1) }) };
});
vi.mock("../../apps/web/src/tennis/BookingCustomer", () => ({ BookingCustomer: () => null }));
vi.mock("../../apps/web/src/tennis/OccupancyPanel", () => ({ OccupancyPanel: () => null }));

const scope = "manual-time:synthetic";
const session: Session = {
  subjectId: "synthetic-staff", displayName: "合成前台", csrfToken: "synthetic", tenantId: "synthetic-tenant",
  kind: "staff", platformOperator: false, contextVersion: 1, permissions: ["book"],
  allVenues: true, venueIds: [], customerId: null, expiresAt: "2099-01-01T00:00:00Z",
  tenants: [{ id: "synthetic-tenant", name: "合成商家", kind: "staff", role: "ADMIN" }],
};
const baseVenue: VenueRecord = {
  id: "synthetic-venue", tenantId: "synthetic-tenant", name: "合成场馆", address: "合成地址",
  timezone: "Asia/Shanghai", active: true, minimumBookingMinutes: 15, catalogRevision: 1,
  openingHours: [
    { weekday: 1, startMinute: 480, endMinute: 1320 },
    { weekday: 3, startMinute: 360, endMinute: 1440 },
  ],
};
const court: CourtRecord = {
  id: "synthetic-court", tenantId: "synthetic-tenant", venueId: baseVenue.id, name: "合成一号场",
  active: true, indoor: false, environment: "OUTDOOR", surface: "ACRYLIC",
  profile: { ...emptyCourtProfile, specification: "STANDARD" }, hourlyPriceCents: 10000, revision: 1,
};
const api = vi.fn();
let venue: VenueRecord;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-20T00:00:00Z"));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  sessionStorage.clear();
  sessionStorage.setItem(`tennis:booking:${scope}`, JSON.stringify({
    date: "2026-09-21", customer: null, lines: [], quote: null, staffHold: false, until: "", reason: "",
  }));
  sessionStorage.setItem(`tennis:view-days:${scope}`, "1");
  venue = { ...baseVenue };
  api.mockImplementation(async (path: string, method = "GET") => {
    if (method === "GET" && path.startsWith(`/venues/${venue.id}/schedule?`))
      return { venue, courts: [court], occupancies: [] };
    throw new Error(`Unexpected request: ${method} ${path}`);
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function click(text: string) {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.trim() === text)!;
  expect(button).toBeDefined();
  await act(async () => button.click());
}
async function render() {
  await act(async () => root.render(createElement(BookingPage, {
    api: api as TennisApi, session, venue, scope, openOrder: vi.fn(),
  })));
  await click("预订");
}
function control<T extends HTMLInputElement | HTMLSelectElement>(label: string): T {
  return [...container.querySelectorAll("label")]
    .find((element) => element.textContent?.trim().startsWith(label))!.querySelector<T>("input, select")!;
}
async function change(label: string, value: string) {
  const input = control(label);
  await act(async () => {
    const prototype = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function values(label: string) {
  return [...control<HTMLSelectElement>(label).options].map((option) => option.value);
}
function addButton() {
  return [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent?.trim() === "添加时段")!;
}

describe("manual date selection in BookingPage", () => {
  it("updates starts for a date outside the displayed calendar and adds its late hour", async () => {
    await render();
    expect(values("开始时间")).not.toContain("360");
    await change("预订日期", "2026-09-23");
    expect(values("开始时间")).toContain("360");
    expect(values("开始时间")).toContain("1380");
    expect(container.querySelector("[data-grid-start]")?.getAttribute("data-grid-start")).toBe("480");
    expect(container.querySelector("[data-grid-end]")?.getAttribute("data-grid-end")).toBe("1305");
    await change("开始时间", "1380");
    await click("添加时段");
    const draft = JSON.parse(sessionStorage.getItem(`tennis:booking:${scope}`)!);
    expect(draft.lines).toEqual([{
      courtId: court.id, startAt: "2026-09-23T15:00:00.000Z", endAt: "2026-09-23T16:00:00.000Z",
    }]);
    expect(api.mock.calls.every(([, method]) => method === undefined || method === "GET")).toBe(true);
  });

  it("disables addition on closed days and corrects a start invalidated by duration", async () => {
    await render();
    await change("预订日期", "2026-09-22");
    expect(values("开始时间")).toEqual([""]);
    expect(addButton().disabled).toBe(true);
    expect(container.textContent).toContain("当天不营业");
    await change("预订日期", "2026-09-23");
    await change("开始时间", "1380");
    await change("预订时长", "120");
    expect(values("开始时间")).not.toContain("1380");
    expect(control("开始时间").value).toBe("360");
    expect(addButton().disabled).toBe(false);
    await click("添加时段");
    const draft = JSON.parse(sessionStorage.getItem(`tennis:booking:${scope}`)!);
    expect(draft.lines[0]).toMatchObject({ startAt: "2026-09-22T22:00:00.000Z", endAt: "2026-09-23T00:00:00.000Z" });
  });

  it("normalizes the initial duration to a configured minimum absent from common choices", async () => {
    venue = { ...venue, minimumBookingMinutes: 75 };
    await render();
    expect(values("预订时长")).toEqual(["75", "90", "120", "180", "240"]);
    expect(control("预订时长").value).toBe("75");
    await click("添加时段");
    const draft = JSON.parse(sessionStorage.getItem(`tennis:booking:${scope}`)!);
    expect((Date.parse(draft.lines[0].endAt) - Date.parse(draft.lines[0].startAt)) / 60_000).toBe(75);
  });
});
