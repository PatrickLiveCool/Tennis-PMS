// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MembersPage } from "../../apps/web/src/tennis/MembersPage";
import { TennisApiError, type TennisApi } from "../../apps/web/src/tennis/api";
import { pendingCommands, forgetCommand } from "../../apps/web/src/tennis/components";
import type { CustomerRecord, Session, VenueRecord } from "../../apps/web/src/tennis/types";

vi.mock("../../apps/web/src/tennis/TopupHistoryPanel", () => ({ TopupHistoryPanel: () => null }));
const scope = "contact:staff:tenant:venue";
const session: Session = { subjectId: "staff", displayName: "合成员工", csrfToken: "synthetic", tenantId: "tenant", kind: "staff",
  platformOperator: false, contextVersion: 1, permissions: ["manage_members"], allVenues: true, venueIds: [], customerId: null,
  expiresAt: "2099-01-01T00:00:00Z", tenants: [{ id: "tenant", name: "合成商家", kind: "staff", role: "STAFF" }] };
const venue: VenueRecord = { id: "venue", tenantId: "tenant", name: "合成场馆", address: "合成", timezone: "Asia/Shanghai", active: true,
  openingHours: [], minimumBookingMinutes: 15, catalogRevision: 1 };
let member: CustomerRecord;
let container: HTMLDivElement, root: Root;
let correction: (payload: Record<string, unknown>) => unknown;
let receipt: () => unknown;
let profile: () => CustomerRecord;
const api = vi.fn();
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); sessionStorage.clear();
  member = { id: "member", tenantId: "tenant", nickname: "合成会员", phone: "+8613800000001", active: true };
  correction = (payload) => { member = { ...member, phone: payload.phone as string }; return { customerId: member.id, customer: member }; };
  profile = () => member;
  receipt = () => null;
  api.mockImplementation(async (path: string, method = "GET", payload?: Record<string, unknown>) => {
    if (path === "/customers/member/contact-corrections" && method === "POST") return correction(payload!);
    if (path.startsWith("/customers/directory?")) return { customers: [member], nextCursor: null };
    if (path.startsWith("/customers/member/wallet?")) return { balance: { totalCents: 12000, availableCents: 12000, reservedCents: 0,
      principalCents: 10000, giftCents: 2000 }, entries: [], nextCursor: null };
    if (path === "/customers/member") return profile();
    if (path.startsWith("/receipts/")) return receipt();
    throw new Error(`Unexpected request ${method} ${path}`);
  });
  const matches = Element.prototype.matches;
  vi.spyOn(Element.prototype, "matches").mockImplementation(function (this: Element, selector) {
    return selector === ":modal" ? this.hasAttribute("open") : matches.call(this, selector);
  });
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal"); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
async function render(nextSession = session, key = "one") {
  await act(async () => root.render(createElement(MembersPage, { key, api: api as TennisApi, session: nextSession, venue, scope })));
}
async function button(text: string) {
  const target = [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === text);
  expect(target, text).toBeDefined(); await act(async () => target!.click());
}
async function field(selector: string, value: string) {
  const target = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
  const prototype = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(target, value);
    target.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function fill(phone = "13900000001") {
  await field('dialog input[type="tel"]', phone); await field("dialog textarea", "客户当面确认录入有误");
}
function writes() { return api.mock.calls.filter(([, method]) => method === "POST"); }

it("updates the member detail and directory with a normalized phone and the original contact guard", async () => {
  await render(); await button("修改手机号"); await fill("+86 139-0000-0001"); await button("保存手机号");
  expect(writes()).toHaveLength(1);
  expect(writes()[0]![2]).toMatchObject({ venueId: "venue", expectedPhone: "+8613800000001", phone: "+8613900000001", reason: "客户当面确认录入有误", commandKey: expect.any(String) });
  expect(container.querySelector("dialog")).toBeNull();
  expect(container.querySelector('[aria-label="会员详情"]')?.textContent).toContain("+8613900000001");
  expect(container.querySelector(".tennis-member-list")?.textContent).toContain("+8613900000001");
  expect(container.textContent).toContain("手机号已更新"); expect(pendingCommands(scope)).toEqual([]);
});

it("hides correction from booking-only staff and customer identities", async () => {
  await render({ ...session, permissions: ["book"] });
  expect(container.textContent).not.toContain("修改手机号");
  await render({ ...session, kind: "customer", customerId: member.id }, "customer");
  expect(container.textContent).not.toContain("修改手机号");
});

it("requires a reason and validates the mainland number before writing", async () => {
  await render(); await button("修改手机号");
  const save = [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === "保存手机号")!;
  await field('dialog input[type="tel"]', "13900000001"); expect(save.disabled).toBe(true);
  await fill("+12025550123"); await button("保存手机号");
  expect(container.textContent).toContain("有效的 11 位中国大陆手机号"); expect(writes()).toEqual([]);
});

it("restores an unknown request after remount, keeps inputs locked and retries the original key and payload", async () => {
  correction = () => { throw new Error("synthetic response lost"); };
  await render(); await button("修改手机号"); await fill(); await button("保存手机号");
  expect(pendingCommands(scope)).toHaveLength(1);
  const original = writes()[0]![2];
  await render(session, "remounted");
  expect(container.querySelector<HTMLInputElement>('dialog input[type="tel"]')?.disabled).toBe(true);
  expect(container.querySelector<HTMLInputElement>('dialog input[type="tel"]')?.value).toBe("13900000001");
  await button("查询修改结果"); expect(container.textContent).toContain("暂时查不到结果");
  correction = (payload) => { member = { ...member, phone: payload.phone as string }; return { customerId: member.id, customer: member }; };
  await button("按原内容重试");
  expect(writes()[1]![2]).toEqual(original); expect(pendingCommands(scope)).toEqual([]);
  expect(container.querySelector("dialog")).toBeNull();
});

it("refreshes after stale rejection and lets a rejected original request be corrected", async () => {
  correction = () => { throw new Error("synthetic request did not arrive"); };
  await render(); await button("修改手机号"); await fill(); await button("保存手机号");
  correction = () => { throw new TennisApiError("STALE_CUSTOMER_CONTACT", 409); };
  member = { ...member, phone: "+8613700000001" };
  await button("按原内容重试");
  expect(pendingCommands(scope)).toEqual([]);
  expect(container.querySelector<HTMLInputElement>('dialog input[type="tel"]')?.disabled).toBe(false);
  await button("刷新当前手机号");
  expect(container.querySelector("dialog")?.textContent).toContain("+8613700000001");
  correction = (payload) => { member = { ...member, phone: payload.phone as string }; return { customerId: member.id, customer: member }; };
  await button("保存手机号"); expect(writes()[2]![2]).toMatchObject({ expectedPhone: "+8613700000001" });
});

it("retains recovery when a saved contact cannot be refreshed and reads the current profile on recovery", async () => {
  profile = () => { throw new Error("synthetic profile unavailable"); };
  await render(); await button("修改手机号"); await fill(); await button("保存手机号");
  expect(container.textContent).toContain("手机号已保存，但暂时无法刷新会员资料");
  expect(pendingCommands(scope)).toHaveLength(1);
  receipt = () => ({ commandType: "customer.contact.correct", result: { customerId: "member", customer: { ...member, phone: "+8613900000001" } } });
  member = { ...member, phone: "+8613700000001" }; profile = () => member;
  await button("查询修改结果");
  expect(container.querySelector("dialog")).toBeNull();
  expect(container.querySelector('[aria-label="会员详情"]')?.textContent).toContain("+8613700000001");
  expect(writes()).toHaveLength(1);
});

it("closes the matching dialog and clears its draft after global receipt recovery", async () => {
  correction = () => { throw new Error("synthetic response lost"); };
  await render(); await button("修改手机号"); await fill(); await button("保存手机号");
  member = { ...member, phone: "+8613900000001" };
  await act(async () => {
    window.dispatchEvent(new CustomEvent("tennis-customer-contact-recovered", { detail: { scope, customer: member } }));
    forgetCommand(scope, pendingCommands(scope)[0]!.key);
  });
  expect(container.querySelector("dialog")).toBeNull();
  expect(container.querySelector('[aria-label="会员详情"]')?.textContent).toContain(member.phone);
  await button("修改手机号");
  expect(container.querySelector<HTMLInputElement>('dialog input[type="tel"]')?.value).toBe("");
  expect(container.querySelector<HTMLTextAreaElement>("dialog textarea")?.value).toBe("");
});
