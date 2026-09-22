import { chromium, expect } from "@playwright/test";
import fs from "node:fs/promises";
import { reserveSyntheticPhone } from "./browser-fixtures.mjs";

// Model replies are synthetic browser fixtures. The calendar, guest booking and
// order reads use the isolated local demo API. No model provider/payment is called.
const out = ".local-workspace/assistant-workbench-2026-09-21";
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
const baseURL = "http://127.0.0.1:4273";
const date = `${2350 + Math.floor(Math.random() * 50)}-10-05`;
const failures = [];
async function setup(viewport) {
  const context = await browser.newContext({ baseURL, viewport });
  const page = await context.newPage();
  page.on("pageerror", (error) => failures.push(error.message));
  const state = { created: 0, messages: [], requests: [], sent: [], preparation: null };
  const conversation = { id: "synthetic-assistant-conversation", tenantId: "browser-fixture", venueId: "browser-fixture", subjectId: "browser-fixture", updatedAt: new Date().toISOString() };
  await page.route("**/backoffice-assistant/**", async (route) => {
    const req = route.request(), path = new URL(req.url()).pathname;
    let body;
    if (path.endsWith("/status")) body = { configured: true, enabled: true, configReady: true, connectionAvailable: true };
    else if (path.endsWith("/conversations")) {
      if (req.method() === "POST") { state.created++; body = conversation; }
      else body = state.created ? [conversation] : [];
    } else {
      if (req.method() === "POST" && path.endsWith("/messages")) {
        const input = req.postDataJSON(); state.sent.push(input);
        const action = state.preparation ?? { page: "schedule", label: "带入预订草稿", preparation: { kind: "booking", lines: input.context.selection } };
        state.messages.push({ id: crypto.randomUUID(), role: "USER", content: input.content, createdAt: new Date().toISOString(), resolved: null });
        state.messages.push({ id: crypto.randomUUID(), role: "ASSISTANT", content: "已准备办理内容，尚未提交。请带入表单后核对确认。", actions: [action], createdAt: new Date().toISOString(), resolved: null });
        state.requests.push({ id: crypto.randomUUID(), messageId: input.messageId, status: "SUCCEEDED", createdAt: new Date().toISOString() });
      }
      body = { conversation, messages: state.messages, requests: state.requests };
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto("/");
  await page.getByLabel("账号", { exact: true }).fill("demo.staff");
  await page.getByLabel("密码", { exact: true }).fill("TennisPMS123!");
  await page.getByRole("button", { name: "进入工作台", exact: true }).click();
  await page.locator(".tennis-grid-slot").first().waitFor({ state: "attached" });
  await page.getByLabel("排场日期", { exact: true }).fill(date);
  return { context, page, state };
}
try {
  const { context, page, state } = await setup({ width: 1440, height: 900 });
  const day = page.locator(`[data-schedule-date="${date}"]`);
  await day.getByRole("button", { name: "1 号场 09:00 添加预订", exact: true }).click();
  await page.getByLabel("姓名", { exact: true }).fill("助手流程合成客户");
  await page.getByLabel("手机号", { exact: true }).fill(reserveSyntheticPhone());
  await page.getByRole("button", { name: "打开 AI 助手", exact: true }).click();
  const assistant = page.getByRole("complementary", { name: "AI 助手", exact: true });
  await expect(assistant.getByText(/已选 1 条时段/)).toBeVisible();
  await expect.poll(() => state.created).toBe(1);
  await assistant.getByLabel("后台助手消息", { exact: true }).fill("请帮我准备已选时段的预订");
  await assistant.getByRole("button", { name: "发送", exact: true }).click();
  await assistant.getByRole("button", { name: "带入预订草稿", exact: true }).click();
  expect(state.sent[0].context).toMatchObject({ page: "booking", date, viewDays: 3 });
  expect(state.sent[0].context.selection).toHaveLength(1);
  await expect(page.locator(".tennis-selection")).toHaveCount(1);
  await expect(page.getByLabel("姓名", { exact: true })).toHaveValue("助手流程合成客户");
  console.log("PASS automatic conversation, live calendar context, preparation preserves customer and does not duplicate slots");

  await expect(assistant).toBeVisible();
  await assistant.getByLabel("后台助手消息", { exact: true }).fill("还没写完的问题");
  await page.keyboard.press("Escape");
  await expect(assistant).toBeHidden();
  await page.getByRole("button", { name: "打开 AI 助手", exact: true }).click();
  await expect(assistant.getByLabel("后台助手消息", { exact: true })).toHaveValue("还没写完的问题");
  await page.screenshot({ path: `${out}/assistant-desktop.png`, fullPage: true });
  await assistant.getByRole("button", { name: "关闭 AI 助手", exact: true }).click();

  await page.getByRole("button", { name: "核对场地与报价", exact: true }).click();
  const response = page.waitForResponse((r) => /\/quotes\/[^/]+\/confirm$/.test(new URL(r.url()).pathname) && r.request().method() === "POST");
  await page.getByRole("button", { name: "确认预订", exact: true }).click();
  const order = await (await response).json();
  const dialog = page.getByRole("dialog", { name: /预订详情/ });
  const line = order.lines[0];
  const target = { courtId: line.courtId, startAt: new Date(Date.parse(line.startAt) + 86400000).toISOString(), endAt: new Date(Date.parse(line.endAt) + 86400000).toISOString() };
  state.preparation = { page: "orders", orderId: order.id, label: "准备改期 / 改场", preparation: { kind: "amend", reason: "客户希望顺延一天", lineId: line.id, lines: [target] } };
  await dialog.getByRole("button", { name: "询问此订单", exact: true }).click();
  await assistant.getByLabel("后台助手消息", { exact: true }).fill("把第一条明细顺延一天，客户希望顺延一天");
  await assistant.getByRole("button", { name: "发送", exact: true }).click();
  await assistant.getByRole("button", { name: "准备改期 / 改场", exact: true }).click();
  await expect(dialog.getByText("助手已填好，尚未提交。请核对后确认。", { exact: true })).toBeVisible();
  await expect(dialog.locator('input[type="date"]').first()).toHaveValue(`${date.slice(0, 8)}06`);
  const after = await (await page.request.get(`/api/tennis/orders/${order.id}`)).json();
  expect(after.revision).toBe(order.revision);
  expect(after.lines[0].startAt).toBe(order.lines[0].startAt);
  await page.screenshot({ path: `${out}/assistant-amendment.png`, fullPage: true });
  console.log("PASS Esc keeps input; order action prefills amendment without changing order or funds");
  await context.close();

  const mobile = await setup({ width: 390, height: 844 });
  await mobile.page.getByRole("button", { name: "打开 AI 助手", exact: true }).click();
  const ma = mobile.page.getByRole("complementary", { name: "AI 助手", exact: true });
  await ma.getByLabel("后台助手消息", { exact: true }).fill("手机上写到一半的问题");
  await ma.getByRole("button", { name: "关闭 AI 助手", exact: true }).click();
  await mobile.page.getByRole("button", { name: "打开 AI 助手", exact: true }).click();
  await expect(ma.getByLabel("后台助手消息", { exact: true })).toHaveValue("手机上写到一半的问题");
  expect(await mobile.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await mobile.page.screenshot({ path: `${out}/assistant-mobile.png`, fullPage: true });
  await mobile.context.close();
  expect(failures).toEqual([]);
  console.log("PASS phone entry/composer/history and close/reopen draft recovery; no browser errors");
} finally { await browser.close(); }
