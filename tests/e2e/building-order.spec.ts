import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import type { RoomCatalogView } from "@qintopia/contracts";

const propertyId = "prop_qintopia_demo";
async function catalog(page: Page): Promise<RoomCatalogView> {
  const response = await page.request.get(`/api/v1/properties/${propertyId}/room-catalog`);
  expect(response.ok()).toBe(true);
  return response.json();
}
async function change(page: Page, input: Record<string, unknown>) {
  const current = await catalog(page);
  const preview = await page.request.post("/api/v1/command-previews", {
    headers: { "idempotency-key": randomUUID(), "x-correlation-id": randomUUID() },
    data: { commandType: "MANAGE_ROOM_CATALOG", input: { propertyId, expectedVersion: current.version, ...input } }
  });
  expect(preview.ok(), await preview.text()).toBe(true);
  const { preview: draft } = await preview.json();
  const response = await page.request.post(`/api/v1/command-previews/${draft.previewId}/confirm`, {
    headers: { "idempotency-key": randomUUID(), "x-correlation-id": randomUUID() },
    data: { propertyId, commandType: "MANAGE_ROOM_CATALOG", expectedEffectHash: draft.effectHash, confirmation: true,
      reason: { code: "ROOM_CATALOG_CHANGE", note: "楼栋排序浏览器合成验收" } }
  });
  expect(response.ok(), await response.text()).toBe(true);
  expect((await response.json()).businessCommitted).toBe(true);
}

test("administrator can move F below E, cancel a draft, and retain the saved order after reload", async ({ page, isMobile }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.request.post("/api/v1/auth/login", { data: { username: "admin", password: "demo-pass-2026" } });
  let current = await catalog(page);
  if (!current.buildingOrder?.includes("F")) {
    await change(page, { action: "SAVE_ROOM", code: "000-F", buildingCode: "F", typeCode: "private_bath_standard", bedCount: 2, capacity: 2 });
    current = await catalog(page);
  }
  const initial = current.buildingOrder!.filter((code) => code !== "F");
  initial.splice(initial.indexOf("E"), 0, "F");
  if (JSON.stringify(initial) !== JSON.stringify(current.buildingOrder)) await change(page, { action: "SET_BUILDING_ORDER", buildingOrder: initial });
  await page.goto("/settings/rooms");
  await page.getByRole("button", { name: "房间与床位", exact: true }).click();
  await page.getByRole("button", { name: "调整楼栋顺序", exact: true }).click();
  let editor = page.getByRole("dialog", { name: "调整楼栋顺序", exact: true });
  await expect(editor.getByRole("button", { name: "核对并保存", exact: true })).toBeDisabled();
  await editor.getByRole("button", { name: "下移 F 栋", exact: true }).click();
  await editor.getByRole("button", { name: "取消", exact: true }).click();
  expect((await catalog(page)).buildingOrder).toEqual(initial);
  await page.getByRole("button", { name: "调整楼栋顺序", exact: true }).click();
  editor = page.getByRole("dialog", { name: "调整楼栋顺序", exact: true });
  await editor.getByRole("button", { name: "下移 F 栋", exact: true }).click();
  const expected = [...initial];
  const index = expected.indexOf("F");
  [expected[index], expected[index + 1]] = [expected[index + 1]!, expected[index]!];
  await expect(editor.locator(".catalog-building-name strong")).toHaveText(expected.map((code) => `${code} 栋`));
  await page.screenshot({ path: testInfo.outputPath("building-order.png"), fullPage: false });
  const bounds = await editor.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  await editor.getByRole("button", { name: "核对并保存", exact: true }).click();
  await expect(page.getByTestId("command-effect")).toContainText("调整楼栋顺序");
  await page.getByTestId("confirm-command").click();
  await expect(page.getByRole("status").filter({ hasText: "设置已保存" })).toBeVisible({ timeout: 30000 });
  expect((await catalog(page)).buildingOrder).toEqual(expected);
  await page.reload();
  await page.getByRole("button", { name: "房间与床位", exact: true }).click();
  await page.getByRole("button", { name: "调整楼栋顺序", exact: true }).click();
  await expect(page.locator(".catalog-building-name strong")).toHaveText(expected.map((code) => `${code} 栋`));
  await page.getByRole("dialog").getByRole("button", { name: "取消", exact: true }).click();
  const boardResponse = page.waitForResponse((response) => response.url().includes("/room-status?") && response.ok());
  await page.goto("/");
  const board = await (await boardResponse).json();
  const buildings = [...new Set(board.rooms.map((room: { buildingCode: string }) => room.buildingCode))];
  expect(buildings.indexOf("F")).toBe(buildings.indexOf("E") + 1);
  if (!isMobile) {
    await expect(page.locator(".room-status-building-cell strong").last()).toHaveText("F栋", { timeout: 30000 });
    const labels = await page.locator(".room-status-building-cell strong").allTextContents();
    expect(labels.indexOf("F栋")).toBe(labels.indexOf("E栋") + 1);
  } else {
    await expect(page.getByRole("heading", { name: "房态任务", exact: true })).toBeVisible();
  }
  await page.screenshot({ path: testInfo.outputPath("calendar-building-order.png"), fullPage: false });
  expect(errors).toEqual([]);
});
