import { chromium, expect } from "@playwright/test";
import fs from "node:fs/promises";
// Local demo only: uses synthetic customers/orders and never calls a remote service.
const out = ".local-workspace/experience-2026-09-21";
await fs.mkdir(out, { recursive: true });
const baseDate = new Date(
  Date.UTC(
    2090 + Math.floor(Math.random() * 100),
    Math.floor(Math.random() * 12),
    1 + Math.floor(Math.random() * 20),
  ),
);
const testDate = (offset) => new Date(baseDate.getTime() + offset * 86400000).toISOString().slice(0, 10);
console.log("Synthetic scenario dates:", [0, 1, 2, 3].map(testDate));
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  baseURL: "http://127.0.0.1:4273",
  viewport: { width: 1440, height: 900 },
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const { password } = JSON.parse(await fs.readFile(".local-workspace/demo-credentials.json", "utf8"));
async function login(page) {
  await page.goto("http://127.0.0.1:4273");
  await page.getByLabel("账号", { exact: true }).fill("demo.staff");
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "进入工作台" }).click();
  await page.locator(".tennis-grid-slot").first().waitFor({ state: "attached" });
  await page.getByRole("button", { name: "1天", exact: true }).click();
}
await login(page);
async function day(d) {
  await page.getByLabel("排场日期", { exact: true }).fill(d);
  await page.waitForResponse((r) => r.url().includes(`schedule?date=${d}`) && r.status() === 200);
  await page.locator(".tennis-grid-slot").first().waitFor({ state: "attached" });
}
const slot = (row, t) => page.getByRole("button", { name: `${row} 号场 ${t} 添加预订`, exact: true });
async function drag(a, b) {
  const x = await a.boundingBox(),
    y = await b.boundingBox();
  await page.mouse.move(x.x + x.width / 2, x.y + x.height / 2);
  await page.mouse.down();
  await page.mouse.move(y.x + y.width / 2, y.y + y.height / 2, { steps: 12 });
  await page.mouse.up();
}
// The legacy overview memory migrates once; later navigation keeps the user's task.
const signedIn = await (await page.request.get("/api/tennis/session")).json();
const identityScope = `${signedIn.subjectId}:${signedIn.kind}:${signedIn.tenantId}:${signedIn.customerId ?? "staff"}`;
await page.evaluate((scope) => {
  sessionStorage.setItem(`tennis:page:${scope}`, JSON.stringify("today"));
  sessionStorage.removeItem(`tennis:schedule-entry-v1:${scope}`);
}, identityScope);
await page.reload();
await expect(page.getByRole("heading", { name: "场地排期", exact: true })).toBeVisible();
await page
  .getByRole("navigation", { name: "主导航", exact: true })
  .getByRole("button", { name: "经营概览", exact: true })
  .click();
await page.reload();
await expect(page.getByRole("heading", { name: "今日工作台", exact: true })).toBeVisible();
await page
  .getByRole("navigation", { name: "主导航", exact: true })
  .getByRole("button", { name: "场地排期", exact: true })
  .click();
await page.locator(".tennis-grid-slot").first().waitFor();
console.log("entry migration and return position");
await day(testDate(0));
// Reverse rectangle, direct cancel and Escape leave customer inputs intact.
await drag(slot(3, "10:45"), slot(1, "09:45"));
await expect(page.locator(".tennis-selection")).toHaveCount(3);
await page.getByLabel("称呼", { exact: true }).fill("草稿资料保留");
await page.getByRole("button", { name: "取消草稿 1 号场 09:45", exact: true }).click();
await expect(page.locator(".tennis-selection")).toHaveCount(2);
await page.getByRole("button", { name: "取消草稿 2 号场 09:45", exact: true }).focus();
await page.keyboard.press("Escape");
await expect(page.locator(".tennis-selection")).toHaveCount(1);
await expect(page.getByLabel("称呼", { exact: true })).toHaveValue("草稿资料保留");
await page.getByRole("button", { name: "清空全部", exact: true }).click();
const escA = await slot(1, "09:00").boundingBox(),
  escB = await slot(2, "10:00").boundingBox();
await page.mouse.move(escA.x + 13, escA.y + 30);
await page.mouse.down();
await page.mouse.move(escB.x + 13, escB.y + 30, { steps: 6 });
await page.keyboard.press("Escape");
await page.mouse.up();
await expect(page.locator(".tennis-selection")).toHaveCount(0);
console.log("reverse multi-court drag, cancellation and Escape");
await slot(1, "09:00").focus();
await page.keyboard.press("Enter");
await expect(page.locator(".tennis-selection")).toHaveCount(1);
console.log("keyboard selects one hour");
await page.getByLabel("称呼", { exact: true }).fill("超时恢复验收客");
let lost = false;
await page.route("**/booking-customers", async (route) => {
  if (route.request().method() === "POST" && !lost) {
    lost = true;
    await route.fetch();
    await route.abort("failed");
  } else await route.continue();
});
await page.getByRole("button", { name: "核对场地与报价", exact: true }).click();
await page.getByRole("button", { name: /查询原操作/ }).waitFor();
await page.getByRole("button", { name: /查询原操作/ }).click();
await expect(page.locator(".tennis-selected-customer")).toContainText("超时恢复验收客");
await page.getByRole("button", { name: "核对场地与报价", exact: true }).click();
await expect(page.getByText("整单应付", { exact: true })).toBeVisible();
console.log("unknown customer result recovered");
await page.getByRole("button", { name: "确认预订", exact: true }).click();
await page.getByRole("dialog").waitFor();
await expect(page.getByRole("dialog").locator("table.tennis-table").first().locator(":scope > tbody > tr")).toHaveCount(1);
await page.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click();
await expect(page.getByLabel("预订草稿", { exact: true })).toHaveCount(0);
console.log("one court one hour booked and draft closes");
await day(testDate(1));
await drag(slot(1, "09:00"), slot(3, "09:45"));
await expect(page.locator(".tennis-selection")).toHaveCount(3);
await page.getByRole("button", { name: "核对场地与报价", exact: true }).click();
await page.getByRole("button", { name: "确认预订", exact: true }).click();
await page.getByRole("dialog").waitFor();
await expect(page.getByRole("dialog").locator("table.tennis-table").first().locator(":scope > tbody > tr")).toHaveCount(3);
await page.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click();
console.log("three simultaneous courts booked");
await day(testDate(2));
await drag(slot(1, "09:00"), slot(3, "09:45"));
const session = await (await page.request.get("/api/tennis/session")).json();
const venueId = await page.getByLabel("切换场馆", { exact: true }).inputValue();
const draft = await page.evaluate(() => {
  const key = Object.keys(sessionStorage).find((k) => k.startsWith("tennis:booking:"));
  return JSON.parse(sessionStorage.getItem(key));
});
const headers = {
  origin: "http://127.0.0.1:4273",
  "x-csrf-token": session.csrfToken,
  "x-workspace-version": String(session.contextVersion),
};
const qr = await page.request.post("/api/tennis/quotes", {
  headers,
  data: { venueId, customerId: draft.customer.id, lines: [draft.lines[1]] },
});
expect(qr.status()).toBe(200);
const quote = await qr.json();
const booked = await page.request.post(`/api/tennis/quotes/${quote.id}/confirm`, {
  headers,
  data: { commandKey: crypto.randomUUID() },
});
expect(booked.status()).toBe(200);
await page.getByRole("button", { name: "核对场地与报价", exact: true }).click();
await expect(page.locator(".tennis-selection").filter({ hasText: "该时段已被占用" })).toHaveCount(1);
await expect(page.locator(".tennis-selection")).toHaveCount(3);
await expect(page.getByRole("button", { name: "核对场地与报价", exact: true })).toBeDisabled();
await page.screenshot({
  path: `out/conflict.png`.replace("out", out),
  fullPage: true,
});
console.log("racing occupancy retained and identified");
await page.getByRole("button", { name: "清空全部", exact: true }).click();
await slot(1, "11:00").click();
await page.getByRole("button", { name: "核对场地与报价", exact: true }).click();
await expect(page.getByText("整单应付", { exact: true })).toBeVisible();
await drag(page.getByLabel("拖动调整结束", { exact: true }), slot(1, "12:15"));
await expect(page.getByText("整单应付", { exact: true })).toHaveCount(0);
console.log("resize invalidates quote");
await page.getByRole("button", { name: "清空全部", exact: true }).click();
const start = await slot(1, "13:00").boundingBox();
const scroll = await page.locator(".tennis-grid-scroll").boundingBox();
await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
await page.mouse.down();
await page.mouse.move(scroll.x + scroll.width - 5, start.y + 30, { steps: 5 });
await page.waitForTimeout(450);
expect(await page.locator(".tennis-grid-scroll").evaluate((e) => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(1);
await page.mouse.move(1435, 800);
await page.mouse.up();
await expect(page.locator(".tennis-selection").first()).toBeVisible();
console.log("fitted time axis and pointer release outside grid");
await page.screenshot({ path: `${out}/desktop-final.png`, fullPage: true });
await context.close();
const mobile = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
const m = await mobile.newPage();
await login(m);
await m.getByLabel("排场日期", { exact: true }).fill(testDate(3));
await m.waitForResponse((r) => r.url().includes(`schedule?date=${testDate(3)}`) && r.status() === 200);
await m.locator(".tennis-mobile-schedule").waitFor();
const cdp = await mobile.newCDPSession(m);
await cdp.send("Input.dispatchTouchEvent", {
  type: "touchStart",
  touchPoints: [{ x: 180, y: 650 }],
});
await cdp.send("Input.dispatchTouchEvent", {
  type: "touchMove",
  touchPoints: [{ x: 180, y: 450 }],
});
await cdp.send("Input.dispatchTouchEvent", {
  type: "touchEnd",
  touchPoints: [],
});
await expect(m.locator(".tennis-selection")).toHaveCount(0);
console.log("touch scroll does not select");
await m.getByRole("button", { name: "1 号场 10:00 选场", exact: true }).tap();
await expect(m.locator(".tennis-selection")).toHaveCount(1);
await m.getByLabel("称呼", { exact: true }).fill("手机体验临时客");
await m.getByRole("button", { name: "核对场地与报价", exact: true }).tap();
await m.getByRole("button", { name: "确认预订", exact: true }).tap();
await m.getByRole("dialog").waitFor();
await expect(m.getByRole("dialog")).toContainText("手机体验临时客");
await m.screenshot({ path: `${out}/mobile-order.png`, fullPage: true });
expect(await m.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
console.log("mobile full booking");
await m.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).tap();
await m.screenshot({ path: `${out}/mobile-final.png`, fullPage: true });
console.log("errors", errors);
await browser.close();
