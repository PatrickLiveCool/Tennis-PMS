import { chromium, expect } from "@playwright/test";
import fs from "node:fs/promises";
import { reserveSyntheticPhone } from "./browser-fixtures.mjs";

// Explicit real-model acceptance: uses the local saved test provider. Never run
// from npm test. Only local synthetic courts/orders and non-sensitive prompts.
const out = ".local-workspace/clay-assistant-20260921";
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
const errors = [];
const courtName = "红土演示场（本地合成）";
async function login(account, viewport = { width: 1440, height: 900 }) {
  const context = await browser.newContext({ baseURL: "http://127.0.0.1:4273", viewport, ...(viewport.width < 500 ? { isMobile: true, hasTouch: true } : {}) });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByLabel("账号", { exact: true }).fill(account);
  await page.getByLabel("密码", { exact: true }).fill("TennisPMS123!");
  await page.getByRole("button", { name: "进入工作台", exact: true }).click();
  await page.locator(".tennis-grid-slot").first().waitFor({ state: "attached" });
  return { page, context };
}
try {
  const admin = await login("demo.green");
  const p = admin.page;
  await p.getByRole("navigation", { name: "主导航", exact: true }).getByRole("button", { name: "场地设置", exact: true }).click();
  const venueId = await p.getByLabel("切换校区", { exact: true }).inputValue();
  const courts = await (await p.request.get(`/api/tennis/venues/${venueId}/courts`)).json();
  if (!courts.some((court) => court.name === courtName)) {
    await p.getByRole("button", { name: "添加球场", exact: true }).click();
    await p.getByLabel("球场名称", { exact: true }).fill(courtName);
    await p.getByLabel("场地材质").selectOption("CLAY");
    await p.getByLabel("场地环境", { exact: true }).selectOption("INDOOR");
  } else {
    await p.locator(".tennis-ledger-row").filter({ hasText: courtName }).getByRole("button", { name: "编辑", exact: true }).click();
  }
  await expect(p.getByLabel("场地材质")).toHaveValue("CLAY");
  await expect(p.getByLabel("场地环境", { exact: true })).toHaveValue("INDOOR");
  await p.getByLabel("规格类型", { exact: true }).selectOption("STANDARD");
  await p.getByLabel("标准小时价（元 / 小时）").fill("100");
  const save = p.getByRole("dialog").getByRole("button", { name: "保存", exact: true });
  if (await save.isEnabled()) await save.click();
  else await p.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click();
  await expect(p.locator(".tennis-ledger-row").filter({ hasText: courtName })).toContainText("室内 · 红土场");
  await p.screenshot({ path: `${out}/clay-editor.png`, fullPage: true });
  await admin.context.close();
  console.log("PASS clay court creation, independent indoor attribute and hourly price");

  const staff = await login("demo.staff");
  const page = staff.page;
  const testDate = `${2450 + Math.floor(Math.random() * 40)}-09-22`;
  await page.getByLabel("排场日期", { exact: true }).fill(testDate);
  await page.getByLabel("筛选球场", { exact: true }).selectOption("clay");
  const day = page.locator(`[data-schedule-date="${testDate}"]`);
  await expect(day.locator(".tennis-grid-court")).toHaveCount(1);
  await day.getByRole("button", { name: `${courtName} 10:00 添加预订`, exact: true }).click();
  await page.getByLabel("姓名", { exact: true }).fill("红土预订合成客");
  await page.getByLabel("手机号", { exact: true }).fill(reserveSyntheticPhone());
  await page.getByRole("button", { name: "核对场地与报价", exact: true }).click();
  await page.getByRole("button", { name: "确认预订", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: /预订详情/ });
  await expect(dialog).toContainText(courtName);
  await dialog.getByRole("button", { name: "询问此订单", exact: true }).click();
  const assistant = page.getByRole("complementary", { name: "AI 助手", exact: true });
  await expect(assistant).toBeVisible();
  const paneBounds = async () => {
    const a = await assistant.boundingBox(), d = await dialog.boundingBox();
    expect(d.x + d.width).toBeLessThanOrEqual(a.x + 1);
  };
  await paneBounds();
  // Real model, real tool result; no customer identity/payment ledger is sent by tools.
  await assistant.getByRole("button", { name: "新建对话", exact: true }).click();
  await expect(assistant.getByRole("button", { name: "新建对话", exact: true })).toBeEnabled();
  await expect(assistant.getByRole("heading", { name: "需要帮你做什么？", exact: true })).toBeVisible();
  await assistant.getByLabel("后台助手消息", { exact: true }).fill("请调用工具查询当前场馆球场，用表格列出球场名、室内室外、场地材质和基础小时价，再说明基础价格与最终报价的区别。本项目会员身份是否另外打折？不要查询客户资料。");
  const [response] = await Promise.all([
    page.waitForResponse((response) => /backoffice-assistant.*\/messages$/.test(new URL(response.url()).pathname) && response.request().method() === "POST", { timeout: 150000 }),
    assistant.getByRole("button", { name: "发送", exact: true }).click(),
  ]);
  await expect(assistant.getByRole("button", { name: "停止生成", exact: true })).toBeVisible();
  expect(response.headers()["content-type"]).toContain("text/event-stream");
  await expect(assistant.locator(".assistant-markdown")).toContainText("红土", { timeout: 150000 });
  await expect(assistant.getByRole("button", { name: "发送", exact: true })).toBeVisible({ timeout: 150000 });
  await expect(assistant.locator(".assistant-markdown table").first()).toBeVisible();
  await expect(assistant.locator(".assistant-markdown")).not.toContainText("UNSPECIFIED");
  await expect(assistant.locator(".assistant-markdown")).not.toContainText("每分钟");
  await expect(assistant.locator(".assistant-markdown")).toContainText(/会员[\s\S]{0,80}(不|同一|相同|统一)|(不|没有)[\s\S]{0,40}会员/);
  await assistant.getByRole("button", { name: "已解决", exact: true }).click();
  await expect(assistant.getByText("反馈已记录", { exact: true })).toBeVisible();
  await page.screenshot({ path: `${out}/assistant-live-order.png`, fullPage: true });
  console.log("PASS actual deepseek_v4 streaming/tool query/Markdown table and persisted feedback");
  await assistant.getByLabel("后台助手消息", { exact: true }).fill("关闭订单也要保留的问题");
  await dialog.locator(".modal-header").getByRole("button", { name: "关闭", exact: true }).click();
  await expect(assistant).toBeVisible();
  await expect(assistant.getByLabel("后台助手消息", { exact: true })).toHaveValue("关闭订单也要保留的问题");
  await day.locator(".tennis-schedule-block").filter({ hasText: "红土预订合成客" }).click();
  await expect(dialog).toBeVisible();
  await paneBounds();
  await assistant.getByLabel("后台助手消息", { exact: true }).press("Escape");
  await expect(assistant).toBeHidden();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "询问此订单", exact: true }).click();
  await expect(assistant.getByLabel("后台助手消息", { exact: true })).toHaveValue("关闭订单也要保留的问题");
  console.log("PASS both opening orders, independent Escape/close and preserved input");
  // Start then stop one explicit real request; reconnect only reads the same receipt.
  await assistant.getByLabel("后台助手消息", { exact: true }).fill("请详细解释临时客户如何预订场地，分十步说明。");
  await assistant.getByRole("button", { name: "发送", exact: true }).click();
  await assistant.getByRole("button", { name: "停止生成", exact: true }).click();
  await expect(assistant.getByLabel("后台助手消息", { exact: true })).toHaveValue("请详细解释临时客户如何预订场地，分十步说明。");
  await expect(assistant.getByRole("button", { name: "停止生成", exact: true })).toBeHidden();
  await staff.context.close();
  console.log("PASS stop generation preserves the question");

  const phone = await login("demo.staff", { width: 390, height: 844 });
  const m = phone.page;
  await m.getByLabel("排场日期", { exact: true }).fill(testDate);
  await m.getByLabel("筛选球场", { exact: true }).selectOption("clay");
  await m.getByRole("button", { name: `${courtName} 10:00 查看占用`, exact: true }).tap();
  const mobileOrder = m.getByRole("dialog", { name: /预订详情/ });
  await mobileOrder.getByRole("button", { name: "询问此订单", exact: true }).tap();
  const ma = m.getByRole("complementary", { name: "AI 助手", exact: true });
  const orderBox = await mobileOrder.boundingBox(), assistantBox = await ma.boundingBox();
  expect(orderBox.y + orderBox.height).toBeLessThanOrEqual(assistantBox.y + 1);
  expect(assistantBox.y + assistantBox.height).toBeLessThanOrEqual(845);
  await ma.getByLabel("后台助手消息", { exact: true }).fill("手机第一行");
  await ma.getByLabel("后台助手消息", { exact: true }).press("Enter");
  await expect(ma.getByLabel("后台助手消息", { exact: true })).toHaveValue("手机第一行\n");
  expect(await m.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await m.screenshot({ path: `${out}/assistant-mobile.png`, fullPage: true });
  await phone.context.close();
  expect(errors).toEqual([]);
  console.log("PASS mobile order/assistant split, keyboard/newline/layout; no browser errors");
} finally { await browser.close(); }
