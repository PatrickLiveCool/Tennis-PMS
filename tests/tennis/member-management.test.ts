// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MembersPage } from "../../apps/web/src/tennis/MembersPage";
import { money } from "../../apps/web/src/tennis/components";
import type { TennisApi } from "../../apps/web/src/tennis/api";
import type { CustomerRecord, Session, VenueRecord, Wallet } from "../../apps/web/src/tennis/types";
import type { MemberDirectoryPage } from "../../packages/db/src/tennis/member-directory";

// Wallet loading remains real; recharge history has its own API and tests.
vi.mock("../../apps/web/src/tennis/TopupHistoryPanel", async () => {
  const { createElement } = await import("react");
  return { TopupHistoryPanel: ({ customerId }: { customerId: string }) =>
    createElement("section", { "aria-label": "充值记录" }, `充值记录 ${customerId}`) };
});

const scope = "staff-a:tenant-a:venue-a";
const session: Session = {
  subjectId: "staff-a", displayName: "合成前台", csrfToken: "synthetic", tenantId: "tenant-a",
  kind: "staff", platformOperator: false, contextVersion: 1, permissions: ["manage_members"],
  allVenues: true, venueIds: [], customerId: null, expiresAt: "2099-01-01T00:00:00Z",
  tenants: [{ id: "tenant-a", name: "合成商家", kind: "staff", role: "ADMIN" }],
};
const venue: VenueRecord = {
  id: "venue-a", tenantId: "tenant-a", name: "合成场馆", address: "合成地址", timezone: "Asia/Shanghai",
  active: true, openingHours: [], minimumBookingMinutes: 15, catalogRevision: 1,
};
function member(id: string, nickname = `会员 ${id}`): CustomerRecord {
  return { id, nickname, tenantId: "tenant-a", phone: "13800000000", active: true };
}
const alice = member("alice", "甲会员");
const bob = member("bob", "乙会员");
const recent = member("recent", "最近办理会员");
function wallet(amount: number): Wallet {
  return {
    balance: { availableCents: amount, totalCents: amount, reservedCents: 0, principalCents: amount, giftCents: 0 },
    entries: [], nextCursor: null,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
let container: HTMLDivElement;
let root: Root;
let directory: (params: URLSearchParams) => MemberDirectoryPage | Promise<MemberDirectoryPage>;
let createMember: () => CustomerRecord;
let profiles: Map<string, CustomerRecord>;
let wallets: Map<string, Wallet | Promise<Wallet>>;
const api = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  sessionStorage.clear();
  directory = () => ({ customers: [alice, bob], nextCursor: null });
  createMember = () => { throw new Error("Unexpected member creation"); };
  profiles = new Map([alice, bob, recent].map((customer) => [customer.id, customer]));
  wallets = new Map([[alice.id, wallet(11100)], [bob.id, wallet(22200)], [recent.id, wallet(33300)]]);
  api.mockImplementation(async (path: string, method = "GET") => {
    if (path === "/customers" && method === "POST") return createMember();
    if (method !== "GET") throw new Error(`Unexpected write: ${method} ${path}`);
    const url = new URL(path, "http://synthetic.local");
    if (url.pathname === "/customers/directory") return directory(url.searchParams);
    const match = /^\/customers\/([^/]+)(\/wallet)?$/.exec(url.pathname);
    if (match) {
      const id = decodeURIComponent(match[1]!);
      if (match[2]) return wallets.get(id) ?? wallet(0);
      if (profiles.has(id)) return profiles.get(id);
    }
    throw new Error(`Unexpected member request: ${path}`);
  });
  // jsdom has no native modal implementation; preserve the real form and dialog.
  const matches = Element.prototype.matches;
  vi.spyOn(Element.prototype, "matches").mockImplementation(function (this: Element, selector) {
    return selector === ":modal" ? this.hasAttribute("open") : matches.call(this, selector);
  });
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true, value(this: HTMLDialogElement) { this.open = true; },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render(nextScope = scope) {
  await act(async () => root.render(createElement(MembersPage, {
    api: api as TennisApi, session, venue, scope: nextScope,
  })));
}
function detail() {
  return container.querySelector<HTMLElement>('[aria-label="会员详情"]')!;
}
function rows() {
  return [...container.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")];
}
function selectedName() {
  return container.querySelector('button[aria-pressed="true"] strong')?.textContent;
}
async function clickButton(text: string, parent: ParentNode = container) {
  const buttons = [...parent.querySelectorAll<HTMLButtonElement>("button")]
    .filter((button) => button.textContent?.trim() === text);
  expect(buttons, `Exactly one button ${text}`).toHaveLength(1);
  await act(async () => buttons[0]!.click());
}
async function select(customer: CustomerRecord) {
  const button = rows().find((item) => item.querySelector("strong")?.textContent === customer.nickname);
  expect(button).toBeDefined();
  await act(async () => button!.click());
}
async function setInput(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function search(value: string) {
  await setInput(container.querySelector<HTMLInputElement>('input[type="search"]')!, value);
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
}

describe("member management selection and directory", () => {
  it("opens the first member and appends the next directory page when scrolling", async () => {
    const first = Array.from({ length: 18 }, (_, index) => member(`first-${index}`));
    const second = Array.from({ length: 7 }, (_, index) => member(`second-${index}`));
    directory = (params) => params.has("cursor")
      ? { customers: second, nextCursor: null }
      : { customers: first, nextCursor: "page two / token" };
    await render();
    expect(container.querySelector("h1")?.textContent).toBe("会员管理");
    expect(rows()).toHaveLength(18);
    expect(selectedName()).toBe(first[0]!.nickname);
    expect(detail().querySelector("h2")?.textContent).toBe(first[0]!.nickname);
    const list = container.querySelector<HTMLElement>(".tennis-member-list-scroll")!;
    Object.defineProperties(list, { scrollHeight: { value: 1000 }, clientHeight: { value: 400 } });
    list.scrollTop = 550;
    await act(async () => list.dispatchEvent(new Event("scroll", { bubbles: true })));
    expect(rows()).toHaveLength(25);
    expect(rows().map((button) => button.querySelector("strong")?.textContent))
      .toEqual([...first, ...second].map((customer) => customer.nickname));
    expect(api).toHaveBeenCalledWith("/customers/directory?pageSize=50&q=&cursor=page%20two%20%2F%20token");
    await select(second[6]!);
    expect(selectedName()).toBe(second[6]!.nickname);
    expect(detail().querySelector("h2")?.textContent).toBe(second[6]!.nickname);
  });

  it("prioritizes recent business context outside the first page and consumes it once", async () => {
    sessionStorage.setItem(`tennis:member:${scope}`, JSON.stringify(bob));
    sessionStorage.setItem(`tennis:member-context:${scope}`, JSON.stringify(recent.id));
    await render();
    expect(selectedName()).toBe(recent.nickname);
    expect(detail().textContent).toContain(money(33300));
    expect(rows()).toHaveLength(3);
    expect(JSON.parse(sessionStorage.getItem(`tennis:member-context:${scope}`)!)).toBeNull();
    expect(api).toHaveBeenCalledWith(`/customers/${recent.id}`);
    expect(api).not.toHaveBeenCalledWith(`/customers/${bob.id}`);

    await select(alice);
    await act(async () => root.render(null));
    api.mockClear();
    await render();
    expect(selectedName()).toBe(alice.nickname);
    expect(api).toHaveBeenCalledWith(`/customers/${alice.id}`);
    expect(api).not.toHaveBeenCalledWith(`/customers/${recent.id}`);
  });

  it("restores a saved member outside the first page without business context", async () => {
    sessionStorage.setItem(`tennis:member:${scope}`, JSON.stringify(recent));
    await render();
    expect(selectedName()).toBe(recent.nickname);
    expect(detail().querySelector("h2")?.textContent).toBe(recent.nickname);
    expect(api).toHaveBeenCalledWith(`/customers/${recent.id}`);
  });

  it("isolates member context when the staff, tenant or venue scope changes", async () => {
    const otherScope = "staff-b:tenant-b:venue-b";
    sessionStorage.setItem(`tennis:member-context:${scope}`, JSON.stringify(recent.id));
    sessionStorage.setItem(`tennis:member:${otherScope}`, JSON.stringify(bob));
    await render();
    expect(selectedName()).toBe(recent.nickname);
    await render(otherScope);
    expect(selectedName()).toBe(bob.nickname);
    expect(detail().textContent).toContain(money(22200));
    expect(detail().textContent).not.toContain(recent.nickname);
    expect(JSON.parse(sessionStorage.getItem(`tennis:member:${scope}`)!)).toEqual(recent);
  });

  it("shows empty search results and ignores an older response arriving afterwards", async () => {
    const slow = deferred<MemberDirectoryPage>();
    directory = (params) => params.get("q") === "旧查询" ? slow.promise
      : { customers: params.get("q") === "无人匹配" ? [] : [alice, bob], nextCursor: null };
    await render();
    await search("旧查询");
    await search("无人匹配");
    expect(rows()).toHaveLength(0);
    expect(container.textContent).toContain("未找到会员");
    expect(detail().textContent).not.toContain(money(11100));
    await act(async () => slow.resolve({ customers: [bob], nextCursor: "old-page" }));
    expect(rows()).toHaveLength(0);
    expect(container.textContent).toContain("未找到会员");
    expect(container.textContent).not.toContain("加载更多会员");
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="清除会员搜索"]')!.click());
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(selectedName()).toBe(alice.nickname);
    expect(rows()).toHaveLength(2);
  });

  it("selects a matching member after a failed search is retried", async () => {
    let attempts = 0;
    directory = (params) => {
      if (params.get("q") !== "乙") return { customers: [alice, bob], nextCursor: null };
      if (attempts++ === 0) return Promise.reject(new Error("搜索暂时失败"));
      return { customers: [bob], nextCursor: null };
    };
    await render();
    await search("乙");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("搜索暂时失败");
    await clickButton("重试");
    expect(selectedName()).toBe(bob.nickname);
    expect(detail().querySelector("h2")?.textContent).toBe(bob.nickname);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("keeps a newly registered member selected after clearing the previous search", async () => {
    const created = member("created", "新登记会员");
    directory = (params) => ({ customers: params.get("q") ? [bob] : [alice, bob], nextCursor: null });
    createMember = () => created;
    await render();
    await search("乙");
    await clickButton("新增会员");
    const dialog = container.querySelector("dialog")!;
    const inputs = [...dialog.querySelectorAll<HTMLInputElement>("input")];
    await setInput(inputs[0]!, created.nickname);
    await setInput(inputs[1]!, created.phone!);
    await clickButton("登记并选择", dialog);
    expect(api).toHaveBeenCalledWith("/customers", "POST", { nickname: created.nickname, phone: created.phone });
    expect(container.querySelector("dialog")).toBeNull();
    expect(container.querySelector<HTMLInputElement>('input[type="search"]')?.value).toBe("");
    expect(selectedName()).toBe(created.nickname);
    expect(detail().querySelector("h2")?.textContent).toBe(created.nickname);
    expect(rows().map((button) => button.querySelector("strong")?.textContent)).toContain(alice.nickname);
  });

  it("keeps a newly registered member selected when the initial business context arrives late", async () => {
    const initialPage = deferred<MemberDirectoryPage>();
    const created = member("created", "新登记会员");
    let requests = 0;
    directory = () => requests++ === 0 ? initialPage.promise : { customers: [alice, bob], nextCursor: null };
    createMember = () => created;
    sessionStorage.setItem(`tennis:member-context:${scope}`, JSON.stringify(recent.id));
    await render();
    await clickButton("新增会员");
    const dialog = container.querySelector("dialog")!;
    const inputs = [...dialog.querySelectorAll<HTMLInputElement>("input")];
    await setInput(inputs[0]!, created.nickname);
    await setInput(inputs[1]!, created.phone!);
    await clickButton("登记并选择", dialog);
    expect(selectedName()).toBe(created.nickname);
    await act(async () => initialPage.resolve({ customers: [alice, bob], nextCursor: null }));
    expect(selectedName()).toBe(created.nickname);
    expect(detail().querySelector("h2")?.textContent).toBe(created.nickname);
    expect(detail().textContent).not.toContain(recent.nickname);
  });

  it("selects an active member from a later page and replaces them if a refresh shows they are disabled", async () => {
    directory = (params) => params.has("cursor")
      ? { customers: [bob], nextCursor: null }
      : { customers: [{ ...alice, active: false }], nextCursor: "active-page" };
    await render();
    expect(selectedName()).toBeUndefined();
    expect(rows()[0]!.disabled).toBe(true);
    await clickButton("加载更多会员");
    expect(selectedName()).toBe(bob.nickname);
    directory = () => ({ customers: [{ ...alice, active: false }, { ...bob, active: false }, recent], nextCursor: null });
    await clickButton("刷新");
    expect(selectedName()).toBe(recent.nickname);
    expect(rows().find((button) => button.querySelector("strong")?.textContent === bob.nickname)?.disabled).toBe(true);
    expect(detail().querySelector("h2")?.textContent).toBe(recent.nickname);
    expect(detail().textContent).not.toContain(money(22200));
  });

  it("clears the previous member's wallet while switching and ignores its late refresh", async () => {
    await render();
    expect(detail().textContent).toContain(money(11100));
    const oldRefresh = deferred<Wallet>();
    const nextWallet = deferred<Wallet>();
    wallets.set(alice.id, oldRefresh.promise);
    wallets.set(bob.id, nextWallet.promise);
    await clickButton("刷新");
    await select(bob);
    expect(selectedName()).toBe(bob.nickname);
    expect(detail().textContent).not.toContain(money(11100));
    expect(detail().textContent).not.toContain(`充值记录 ${alice.id}`);
    await act(async () => nextWallet.resolve(wallet(22200)));
    expect(detail().querySelector("h2")?.textContent).toBe(bob.nickname);
    expect(detail().textContent).toContain(money(22200));
    expect(detail().textContent).toContain(`充值记录 ${bob.id}`);
    await act(async () => oldRefresh.resolve(wallet(99900)));
    expect(detail().textContent).toContain(money(22200));
    expect(detail().textContent).not.toContain(money(99900));
    expect(detail().textContent).not.toContain(alice.nickname);
  });
});
