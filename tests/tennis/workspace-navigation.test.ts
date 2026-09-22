// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TennisApp } from "../../apps/web/src/tennis/TennisApp";
import type { Session, VenueRecord } from "../../apps/web/src/tennis/types";

const { api, assistantLifecycle } = vi.hoisted(() => ({
  api: vi.fn(),
  assistantLifecycle: { mounts: 0, unmounts: 0 },
}));
vi.mock("../../apps/web/src/tennis/api", async (original) => ({
  ...await original<typeof import("../../apps/web/src/tennis/api")>(),
  createApi: () => api,
}));

// Keep the actual Workspace sibling tree and its keys. A stateful assistant
// catches navigation fixes that remove the duplicate DOM by resetting drafts.
vi.mock("../../apps/web/src/tennis/AssistantPanel", async () => {
  const { createElement, useEffect, useState } = await import("react");
  return {
    AssistantPanel: ({ open }: { open: boolean }) => {
      const [draft, setDraft] = useState(0);
      useEffect(() => {
        assistantLifecycle.mounts++;
        return () => { assistantLifecycle.unmounts++; };
      }, []);
      return createElement("aside", { id: "ai-assistant-panel", hidden: !open },
        createElement("button", { onClick: () => setDraft((value) => value + 1) }, `助手草稿 ${draft}`));
    },
    BusinessConversationPanel: () => null,
  };
});

// The affected settings, management and their panels remain real. Other pages
// only need a distinct DOM root to exercise all BusinessWorkspace branches.
vi.mock("../../apps/web/src/tennis/BookingPage", async () => {
  const { createElement } = await import("react");
  return { BookingPage: () => createElement("h1", null, "场地排期") };
});
vi.mock("../../apps/web/src/tennis/OrdersPage", async () => {
  const { createElement } = await import("react");
  return { OrdersPage: () => createElement("h1", null, "预订订单"), OrderDialog: () => null };
});
vi.mock("../../apps/web/src/tennis/MembersPage", async () => {
  const { createElement } = await import("react");
  return { MembersPage: () => createElement("h1", null, "会员管理") };
});
vi.mock("../../apps/web/src/tennis/OverviewPage", async () => {
  const { createElement } = await import("react");
  return { OverviewPage: () => createElement("h1", null, "经营概览") };
});

const session: Session = {
  subjectId: "synthetic-admin", displayName: "合成管理员", csrfToken: "synthetic",
  tenantId: "synthetic-tenant", kind: "staff", platformOperator: false,
  contextVersion: 1, permissions: [], allVenues: true, venueIds: [], customerId: null,
  expiresAt: "2099-01-01T00:00:00Z",
  tenants: [{ id: "synthetic-tenant", name: "合成商家", kind: "staff", role: "ADMIN" }],
};
const venue: VenueRecord = {
  id: "synthetic-venue", tenantId: "synthetic-tenant", name: "合成场馆", address: "合成地址",
  timezone: "Asia/Shanghai", active: true, openingHours: [], minimumBookingMinutes: 15, catalogRevision: 1,
};
const settingTabs = ["球场资料", "时段折扣", "预订期限", "充值方案"];
const managementTabs = ["员工权限", "智能体接入", "渠道账号绑定"];
const settingsCases = [
  ["球场资料", "场馆营业设置"],
  ["时段折扣", "分时折扣"],
  ["预订期限", "预订期限"],
  ["充值方案", "线上充值方案"],
] as const;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  assistantLifecycle.mounts = 0;
  assistantLifecycle.unmounts = 0;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    disconnect() {}
  });
  // Layout is not under test; prevent jsdom's unimplemented scroll operation.
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.spyOn(console, "error").mockImplementation(() => {});
  api.mockImplementation(async (path: string, method = "GET") => {
    if (method !== "GET") throw new Error(`Navigation must not write: ${method} ${path}`);
    if (path === "/session") return session;
    if (path === "/venues") return [venue];
    if (path === `/venues/${venue.id}/courts` || path === `/venues/${venue.id}/discounts` || path === "/topup-offers") return [];
    if (path === "/booking-policy") return { quoteMinutes: 5, paymentHoldMinutes: 10, revision: 1 };
    if (path === "/staff") return [{ subjectId: session.subjectId, displayName: session.displayName, role: "ADMIN", active: true, allVenues: true, venueIds: [], permissions: [] }];
    if (path === "/gateway-bindings") return { integrations: [], bindings: [] };
    if (path === "/gateway-integrations") return [];
    if (path.startsWith("/gateway-binding-targets?")) return [];
    throw new Error(`Unexpected navigation request: ${method} ${path}`);
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function main() {
  const element = container.querySelector<HTMLElement>("#tennis-main");
  expect(element).not.toBeNull();
  return element!;
}
async function click(scope: ParentNode, text: string) {
  const matches = [...scope.querySelectorAll<HTMLButtonElement>("button")].filter((button) => button.textContent?.trim() === text);
  expect(matches, `Exactly one clickable ${text}`).toHaveLength(1);
  await act(async () => matches[0]!.click());
}
async function navigate(name: string) {
  await click(container.querySelector('nav[aria-label="主导航"]')!, name);
}
function expectPage(title: string, tabs: readonly string[]) {
  expect([...main().querySelectorAll("h1")].map((heading) => heading.textContent)).toEqual([title]);
  expect([...main().querySelectorAll(".tennis-tabs button")].map((button) => button.textContent)).toEqual(tabs);
  expect([...container.querySelectorAll('nav[aria-label="主导航"] [aria-current="page"]')].map((button) => button.textContent)).toEqual([title]);
  expect(main().querySelector('[role="alert"]')).toBeNull();
}

describe("workspace navigation DOM lifecycle", () => {
  it.each(settingsCases)("removes %s when switching management and keeps subsequent clicks and assistant state working", async (tab, panelTitle) => {
    await act(async () => root.render(createElement(TennisApp)));
    expectPage("场地排期", []);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="打开 AI 助手"]')!.click());
    const assistant = main().querySelector("#ai-assistant-panel");
    expect(assistant).not.toBeNull();
    await click(assistant!, "助手草稿 0");

    for (let round = 0; round < 3; round++) {
      await navigate("场地设置");
      expectPage("场地设置", settingTabs);
      await click(main().querySelector(".tennis-tabs")!, tab);
      expect([...main().querySelectorAll("h2")].map((heading) => heading.textContent)).toContain(panelTitle);

      await navigate("系统管理");
      expectPage("系统管理", managementTabs);
      await click(main().querySelector(".tennis-tabs")!, "员工权限");
      expect([...main().querySelectorAll("h2")].map((heading) => heading.textContent)).toEqual(["员工与权限"]);
      expect(main().textContent).toContain("合成管理员");
      await click(main().querySelector(".tennis-tabs")!, "智能体接入");
      expect([...main().querySelectorAll("h2")].map((heading) => heading.textContent)).toEqual(["智能体接入"]);
      expect(main().textContent).toContain("暂无智能体接入");
      await click(main().querySelector(".tennis-tabs")!, "渠道账号绑定");
      expect([...main().querySelectorAll("h2")].map((heading) => heading.textContent)).toEqual(["渠道账号绑定"]);
      expect(main().textContent).toContain("暂无启用的渠道接入");
      expect(main().querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("渠道账号绑定");

      await navigate("场地设置");
      expectPage("场地设置", settingTabs);
      await click(main().querySelector(".tennis-tabs")!, "时段折扣");
      expect(main().textContent).toContain("尚未设置时段折扣");
      await click(main().querySelector(".tennis-tabs")!, "球场资料");
      expect(main().textContent).toContain("球场与小时价");

      for (const destination of ["场地排期", "预订订单", "会员管理", "经营概览"]) {
        await navigate(destination);
        expectPage(destination, []);
        await navigate("系统管理");
        expectPage("系统管理", managementTabs);
        expect(main().querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("渠道账号绑定");
      }
      expect(main().querySelectorAll("#ai-assistant-panel")).toHaveLength(1);
      expect(main().querySelector("#ai-assistant-panel")).toBe(assistant);
      expect(assistant?.textContent).toBe("助手草稿 1");
      expect(assistantLifecycle).toEqual({ mounts: 1, unmounts: 0 });
    }

    expect(api.mock.calls.every(([, method]) => method === undefined || method === "GET")).toBe(true);
    expect(console.error).not.toHaveBeenCalled();
  });
});
