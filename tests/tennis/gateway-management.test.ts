// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TenantAgentAccessPanel, TenantGatewayPanel } from "../../apps/web/src/tennis/GatewayPanel";
import { TennisApiError } from "../../apps/web/src/tennis/api";

const original = {
  id: "synthetic-integration", tenantId: "tenant-a", name: "工作人员助手", active: true,
  createdAt: "2026-01-01T00:00:00Z", revokedAt: null, pausedAt: null,
  expiresAt: "2099-01-01T00:00:00Z", revision: 3, rotatedAt: null as string | null,
};
const secret = "synthetic-one-time-access-key-never-persist";
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true, value(this: HTMLDialogElement) { this.open = true; },
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  Reflect.deleteProperty(navigator, "clipboard");
});

function button(text: string) {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>("button")].filter((item) => item.textContent?.trim() === text);
  expect(buttons, `Exactly one button named ${text}`).toHaveLength(1);
  return buttons[0]!;
}
async function click(text: string) {
  await act(async () => button(text).click());
}
function field(text: string) {
  const labels = [...document.querySelectorAll("label")].filter((item) => item.firstChild?.textContent?.trim() === text);
  expect(labels, `Exactly one field named ${text}`).toHaveLength(1);
  return labels[0]!.querySelector<HTMLInputElement | HTMLTextAreaElement>("input,textarea")!;
}
async function fill(text: string, value: string) {
  const input = field(text);
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function storedValues() {
  return [sessionStorage, localStorage].flatMap((storage) =>
    Array.from({ length: storage.length }, (_, index) => storage.getItem(storage.key(index)!))).join(" ");
}
async function render(api: ReturnType<typeof vi.fn>, scope = "admin:tenant-a:1") {
  await act(async () => root.render(createElement(TenantAgentAccessPanel, { api, scope })));
}

describe("tenant agent access credential handling", () => {
  it("shows and copies a created key once without persisting it, and clears it across workspace changes", async () => {
    const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
    const api = vi.fn(async (_path: string, method = "GET") => method === "POST" ? { ...original, token: secret } : []);
    await render(api);
    await fill("接入名称", "工作人员助手");
    await fill("有效期（天）", "30");
    await click("创建 API Key");
    expect(api).toHaveBeenCalledWith("/gateway-integrations", "POST", { name: "工作人员助手", expiresInDays: 30 });
    expect(document.querySelector<HTMLInputElement>('[aria-label="一次性 API Key"]')?.value).toBe(secret);
    expect(button("创建 API Key").disabled).toBe(true);
    await click("复制 API Key");
    expect(clipboard.writeText).toHaveBeenCalledWith(secret);
    expect(storedValues()).not.toContain(secret);

    await render(api, "admin:tenant-b:2");
    expect(document.querySelector('[aria-label="一次性 API Key"]')).toBeNull();
    await render(api);
    expect(document.querySelector('[aria-label="一次性 API Key"]')).toBeNull();
    expect(storedValues()).not.toContain(secret);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("does not expose a delayed credential response in the next workspace", async () => {
    let resolveCreate!: (value: typeof original & { token: string }) => void;
    const pending = new Promise<typeof original & { token: string }>((resolve) => { resolveCreate = resolve; });
    const api = vi.fn((_path: string, method = "GET") => method === "POST" ? pending : Promise.resolve([]));
    await render(api);
    await fill("接入名称", "工作人员助手");
    await click("创建 API Key");
    await render(api, "admin:tenant-b:2");
    await act(async () => resolveCreate({ ...original, token: secret }));
    expect(document.querySelector('[aria-label="一次性 API Key"]')).toBeNull();
    expect(container.textContent).not.toContain("接入已创建");
    expect(storedValues()).not.toContain(secret);
    expect(api.mock.calls.filter(([, method]) => method === "POST")).toHaveLength(1);
  });

  it("requires checking an uncertain rotation and uses the refreshed revision for a replacement key", async () => {
    let current = { ...original };
    let rotations = 0;
    const api = vi.fn(async (path: string, method = "GET") => {
      if (method === "GET") return [{ ...current }];
      if (path.endsWith("/rotate")) {
        rotations++;
        current = { ...current, revision: current.revision + 1, rotatedAt: "2026-09-22T01:23:00Z" };
        if (rotations === 1) throw new TennisApiError("RESULT_UNKNOWN", 502);
        return { ...current, token: secret };
      }
      throw new Error("Unexpected mutation");
    });
    await render(api);
    await click("更换 API Key");
    await fill("操作原因", "定期更换凭据");
    await click("确认更换 API Key");
    expect(button("更换 API Key").disabled).toBe(true);
    expect(button("已核对，结束本次操作").disabled).toBe(true);
    expect(container.textContent).toContain("结果还未确认");
    expect(container.textContent).toContain("再次更换 Key");
    expect(rotations).toBe(1);
    expect(storedValues()).toContain("版本 3");
    await click("刷新列表");
    expect(button("更换 API Key").disabled).toBe(true);
    await click("已核对，结束本次操作");
    await click("更换 API Key");
    await click("确认更换 API Key");
    expect(api.mock.calls.filter(([, method]) => method === "POST")).toEqual([
      [`/gateway-integrations/${original.id}/rotate`, "POST", { expectedRevision: 3, reason: "定期更换凭据", expiresInDays: 90 }],
      [`/gateway-integrations/${original.id}/rotate`, "POST", { expectedRevision: 4, reason: "定期更换凭据", expiresInDays: 90 }],
    ]);
    expect(document.querySelector<HTMLInputElement>('[aria-label="一次性 API Key"]')?.value).toBe(secret);
    expect(storedValues()).not.toContain(secret);
    await click("已保存，隐藏 API Key");
    expect(document.querySelector('[aria-label="一次性 API Key"]')).toBeNull();
  });

  it("does not unblock an uncertain operation when refreshing the list fails", async () => {
    let reads = 0;
    const api = vi.fn(async (_path: string, method = "GET") => {
      if (method === "POST") throw new Error("Connection lost");
      if (++reads > 1) throw new Error("Refresh unavailable");
      return [original];
    });
    await render(api);
    await click("暂停接入");
    await fill("操作原因", "暂时停用助手");
    await click("确认暂停接入");
    await click("刷新列表");
    expect(button("已核对，结束本次操作").disabled).toBe(true);
    expect(button("暂停接入").disabled).toBe(true);
    expect(api.mock.calls.filter(([, method]) => method === "POST")).toHaveLength(1);
  });

  it("keeps paused and expired integrations out of new identity binding choices", async () => {
    const api = vi.fn();
    api.mockImplementation(async (path: string) => path === "/gateway-bindings" ? {
      integrations: [
        { ...original, pausedAt: "2026-09-22T01:23:00Z" },
        { ...original, id: "expired-integration", expiresAt: "2020-01-01T00:00:00Z" },
      ],
      bindings: [{
        id: "binding", integrationId: original.id, externalSubjectId: "wecom-staff", subjectId: "employee",
        actorKind: "staff", customerId: null, active: true, reason: "已核验", createdAt: original.createdAt,
      }],
    } : []);
    await act(async () => root.render(createElement(TenantGatewayPanel, { api, scope: "admin:tenant-a:1" })));
    expect(container.textContent).toContain("暂无启用的渠道接入");
    expect(container.textContent).toContain("工作人员助手 · 员工 · 已暂停");
    expect(container.querySelector("select")).toBeNull();
  });
});
