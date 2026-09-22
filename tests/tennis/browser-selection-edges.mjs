import { chromium, expect } from "@playwright/test";
import fs from "node:fs/promises";
import { reserveSyntheticPhone } from "./browser-fixtures.mjs";

// Local synthetic booking only; no remote channels, payment or database reset.
const out = ".local-workspace/workbench-continuation-20260921";
await fs.mkdir(out, { recursive: true });
const { password } = JSON.parse(await fs.readFile(".local-workspace/demo-credentials.json", "utf8"));
const browser = await chromium.launch({ headless: true });
const errors = [], failures = [];
const date = `${2200 + Math.floor(Math.random() * 100)}-10-${String(1 + Math.floor(Math.random() * 27)).padStart(2, "0")}`;
async function login(options = {}) {
  const context = await browser.newContext({ baseURL: "http://127.0.0.1:4273", viewport: { width: 1440, height: 900 }, ...options });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByLabel("账号", { exact: true }).fill("demo.staff");
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "进入工作台" }).click();
  await page.locator(".tennis-grid-slot").first().waitFor({ state: "attached" });
  await page.getByRole("button", { name: "1天", exact: true }).click();
  await page.getByLabel("排场日期", { exact: true }).fill(date);
  await page.locator(`[data-schedule-date="${date}"] .tennis-grid-slot`).first().waitFor({ state: "attached" });
  return { context, page };
}
async function check(name, run) {
  try { await run(); console.log("PASS", name); }
  catch (error) { failures.push(name); console.error("FAIL", name, error.message); }
}
try {
  const { context, page } = await login();
  const slot = (time) => page.getByRole("button", { name: `1 号场 ${time} 添加预订`, exact: true });
  await slot("09:00").click();
  await page.getByLabel("姓名", { exact: true }).fill("取消边界草稿");
  await page.getByRole("button", { name: "取消草稿 1 号场 09:00", exact: true }).focus();
  await slot("11:00").focus();
  await page.keyboard.press("Escape");
  await check("Escape on an empty cell preserves the unfocused draft", async () => {
    await expect(page.locator(".tennis-selection")).toHaveCount(1);
  });
  if (!await page.locator(".tennis-selection").count()) await slot("09:00").click();
  await page.getByRole("button", { name: "取消草稿 1 号场 09:00", exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(page.locator(".tennis-selection")).toHaveCount(0);
  await expect(page.getByLabel("姓名", { exact: true })).toHaveValue("取消边界草稿");
  console.log("PASS Escape on the focused draft removes only that selection");
  // An invalid manual time remains editable in the side panel and must not
  // paint across the fixed court labels or beyond the time axis.
  await page.getByRole("button", { name: "预订", exact: true }).click();
  if (await page.locator(".tennis-manual-selection").getAttribute("open") === null) {
    await page.locator(".tennis-manual-selection summary").click();
  }
  await page.locator(".tennis-manual-selection").getByLabel("开始时间").selectOption("1320");
  await page.locator(".tennis-manual-selection").getByLabel("预订时长").selectOption("240");
  await page.getByRole("button", { name: "添加时段", exact: true }).click();
  await check("An out-of-hours draft is clipped to the calendar without losing its details", async () => {
    await expect(page.locator(".tennis-selection")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "核对场地与报价", exact: true })).toBeDisabled();
    const bounds = await page.locator(".tennis-draft-block").evaluate((el) => {
      const block = el.getBoundingClientRect(), row = el.parentElement.getBoundingClientRect();
      return { left: block.left - row.left, right: block.right - row.right };
    });
    expect(bounds.left).toBeGreaterThanOrEqual(103);
    expect(bounds.right).toBeLessThanOrEqual(1);
  });
  await page.screenshot({ path: `${out}/out-of-hours-draft.png`, fullPage: true });
  await context.close();

  const mobile = await login({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const m = mobile.page;
  await m.getByRole("button", { name: "1 号场 10:00 选场", exact: true }).tap();
  await m.getByLabel("姓名", { exact: true }).fill("手机冲突草稿保留");
  const session = await (await m.request.get("/api/tennis/session")).json();
  const venueId = await m.getByLabel("切换场馆", { exact: true }).inputValue();
  const headers = { origin: "http://127.0.0.1:4273", "x-csrf-token": session.csrfToken, "x-workspace-version": String(session.contextVersion) };
  const lines = await m.evaluate(() => JSON.parse(sessionStorage.getItem(Object.keys(sessionStorage).find((k) => k.startsWith("tennis:booking:")))).lines);
  const competingCustomer = { commandKey: crypto.randomUUID(), nickname: "手机竞争占用合成客", phone: reserveSyntheticPhone() };
  const customerResponse = await m.request.post(`/api/tennis/venues/${venueId}/booking-customers`, {
    headers, data: competingCustomer,
  });
  expect(customerResponse.status()).toBe(200);
  const customer = (await customerResponse.json()).customer;
  const quoteResponse = await m.request.post("/api/tennis/quotes", { headers, data: { venueId, customerId: customer.id, lines } });
  expect(quoteResponse.status()).toBe(200);
  const quote = await quoteResponse.json();
  const orderResponse = await m.request.post(`/api/tennis/quotes/${quote.id}/confirm`, { headers, data: { commandKey: crypto.randomUUID() } });
  expect(orderResponse.status()).toBe(200);
  const order = await orderResponse.json();
  await m.getByRole("button", { name: "刷新排场", exact: true }).tap();
  await expect(m.locator(".tennis-selection")).toContainText("该时段已被占用");
  await m.getByRole("button", { name: "收起", exact: true }).tap();
  await m.screenshot({ path: `${out}/mobile-conflict-before-cancel.png`, fullPage: true });
  await m.getByRole("button", { name: "1 号场 10:00 取消已选", exact: true }).tap();
  await check("Mobile conflict cancellation removes the draft and preserves the established order", async () => {
    await expect(m.getByRole("dialog")).toHaveCount(0);
    await expect(m.getByRole("button", { name: "继续预订 · 1 条时段", exact: true })).toHaveCount(0);
    const current = await (await m.request.get(`/api/tennis/orders/${order.id}`)).json();
    expect(current.status).toBe("HELD");
    expect(current.lines).toHaveLength(1);
    expect(current.lines[0].cancelledAt).toBeNull();
    await m.getByRole("button", { name: "预订", exact: true }).tap();
    await expect(m.getByLabel("姓名", { exact: true })).toHaveValue("手机冲突草稿保留");
    await expect(m.locator(".tennis-selection")).toHaveCount(0);
    await m.getByRole("button", { name: "收起", exact: true }).tap();
    await m.getByRole("button", { name: "1 号场 10:00 查看占用", exact: true }).tap();
    await expect(m.getByRole("dialog")).toContainText("手机竞争占用合成客");
    await m.screenshot({ path: `${out}/mobile-existing-order.png`, fullPage: true });
  });
  expect(errors).toEqual([]);
  expect(failures).toEqual([]);
} finally { await browser.close(); }
