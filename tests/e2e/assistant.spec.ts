import { expect, test, type Page, type APIRequestContext } from "@playwright/test";
import { assistantGuides } from "../../packages/contracts/src/assistant.ts";
const propertyId = "prop_qintopia_demo";
async function login(page: Page) {
  await page.goto("/");
  await page.getByTestId("login-username").fill("admin");
  await page.getByTestId("login-password").fill("demo-pass-2026");
  await page.getByTestId("login-submit").click();
  await expect(page.locator(".room-status-grid").or(page.getByRole("heading", { name: "房态任务", exact: true }))).toBeVisible();
}
async function command(request: APIRequestContext, commandType: string, input: object) {
  const headers = () => ({ "idempotency-key": crypto.randomUUID(), "x-correlation-id": crypto.randomUUID() });
  const response = await request.post("/api/v1/command-previews", { headers: headers(), data: { commandType, input: { propertyId, ...input } } });
  expect(response.status(), await response.text()).toBe(200); const { preview } = await response.json();
  const confirmed = await request.post(`/api/v1/command-previews/${preview.previewId}/confirm`, { headers: headers(), data: { propertyId, commandType, confirmation: true, expectedEffectHash: preview.effectHash, reason: commandType === "CREATE_ORDER" ? { code: "CREATE_STANDARD_ORDER", note: "" } : { code: commandType, note: "助手合成回归" } } });
  expect(confirmed.status(), await confirmed.text()).toBe(200); expect((await confirmed.json()).businessCommitted).toBe(true); return (await confirmed.json()).result;
}
async function order(request: APIRequestContext) {
  const arrivalDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
  const end = new Date(arrivalDate); end.setUTCDate(end.getUTCDate() + 2); const departureDate = end.toISOString().slice(0, 10);
  const available = await request.get(`/api/v1/properties/${propertyId}/availability?arrivalDate=${arrivalDate}&departureDate=${departureDate}&unitKind=ROOM`);
  expect(available.status(), await available.text()).toBe(200);
  const unit = (await available.json()).units.find((u: { available: boolean }) => u.available); expect(unit).toBeTruthy();
  const quoted = await request.post("/api/v1/quotes", { headers: { "idempotency-key": crypto.randomUUID(), "x-correlation-id": crypto.randomUUID() }, data: { propertyId, inventoryUnitId: unit.id, arrivalDate, departureDate, stayType: "TRANSIENT", pricingPolicyVersionId: "policy_qintopia_public_2026_rev561_v1" } });
  expect(quoted.status(), await quoted.text()).toBe(200);
  const created = await command(request, "CREATE_ORDER", { quoteId: (await quoted.json()).quote.quoteId, primaryGuest: { fullName: "助手回归客人", nickname: "助手回归" }, bookingChannelCode: "WECOM" });
  await command(request, "CHECK_IN", { orderId: created.orderId }); return created.orderId as string;
}
async function enabledUi(page: Page) {
  // Only the model-facing UI response is simulated. Business data and form gates stay real.
  await page.route("**/api/v1/assistant/settings?*", async route => { const response = await route.fetch(); await route.fulfill({ response, json: { ...await response.json(), enabled: true } }); });
}
test("assistant overlay preserves calendar geometry and scroll; settings fit the viewport", async ({ page }) => {
  await login(page);
  const hasCalendar = await page.locator(".room-status-grid-scroll").count() > 0;
  const before = await page.locator(".main-content").boundingBox();
  const scroller = page.locator(".room-status-grid-scroll");
  if (hasCalendar) await scroller.evaluate(el => { el.scrollLeft = 120; el.scrollTop = 80; });
  const position = hasCalendar ? await scroller.evaluate(el => [el.scrollLeft, el.scrollTop]) : [];
  await page.getByRole("button", { name: "AI 助手", exact: true }).filter({ visible: true }).click();
  await expect(page.getByTestId("ai-assistant-panel")).toBeVisible();
  const after = await page.locator(".main-content").boundingBox();
  expect(after?.width).toBe(before?.width); expect(after?.x).toBe(before?.x);
  if (hasCalendar) expect(await scroller.evaluate(el => [el.scrollLeft, el.scrollTop])).toEqual(position);
  await page.getByRole("button", { name: "关闭 AI 助手", exact: true }).click();
  await expect(page.getByRole("button", { name: "AI 助手", exact: true }).filter({ visible: true })).toBeFocused();
  if (hasCalendar) expect(await scroller.evaluate(el => [el.scrollLeft, el.scrollTop])).toEqual(position);
  await page.goto("/settings/ai"); await expect(page.getByLabel("Base URL", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test("assistant composer separates sending, line breaks and IME confirmation", async ({ page }) => {
  await enabledUi(page);
  const received: string[] = [];
  let release!: () => void;
  const responseReady = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/v1/assistant/chat", async route => {
    received.push(route.request().postDataJSON().message);
    await responseReady;
    await route.fulfill({ json: { conversationId: "synthetic-keyboard", text: "已收到完整问题。", entries: [] } });
  });
  await login(page);
  await page.getByRole("button", { name: "AI 助手", exact: true }).filter({ visible: true }).click();
  await expect(page.locator(".assistant-suggestions button")).toHaveCount(5);
  const input = page.getByLabel("向 AI 助手提问");
  await input.fill("核对房态");
  await input.press("Shift+Enter");
  await expect(input).toHaveValue("核对房态\n");
  await input.fill("核对房态\n再办理续住");
  await input.dispatchEvent("compositionstart");
  await input.dispatchEvent("keydown", { key: "Enter", code: "Enter" });
  await input.dispatchEvent("compositionend");
  await input.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
  await input.dispatchEvent("keydown", { key: "Enter", code: "Enter", keyCode: 229 });
  await input.dispatchEvent("keydown", { key: "Enter", code: "Enter", repeat: true });
  expect(received).toEqual([]);
  await expect(input).toHaveValue("核对房态\n再办理续住");
  const mobile = await page.evaluate(() => matchMedia("(max-width: 720px)").matches);
  await input.press("Enter");
  if (mobile) {
    await expect(input).toHaveValue("核对房态\n再办理续住\n");
    expect(received).toEqual([]);
    await page.getByRole("button", { name: "发送", exact: true }).click();
  }
  await expect.poll(() => received.length).toBe(1);
  expect(received[0]).toBe("核对房态\n再办理续住");
  await input.fill("上一条仍在处理中");
  await input.press("Enter");
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeDisabled();
  expect(received).toHaveLength(1);
  release();
  await expect(page.locator(".assistant-markdown")).toHaveText("已收到完整问题。");
});
test("assistant distinguishes suggested questions and saves explicit feedback with retry", async ({ page }) => {
  await enabledUi(page);
  const sources: string[] = [], feedbacks: string[] = [];
  await page.route("**/api/v1/assistant/chat", route => {
    sources.push(route.request().postDataJSON().source);
    return route.fulfill({ json: { conversationId: "synthetic-feedback", questionId: `synthetic-question-${sources.length}`, text: "请先核对房态，再进入正式操作页面。", entries: [] } });
  });
  await page.route("**/api/v1/assistant/questions/*/feedback", route => {
    feedbacks.push(route.request().postDataJSON().feedback);
    return feedbacks.length === 1
      ? route.fulfill({ status: 500, json: { error: { code: "INTERNAL_ERROR", message: "反馈未能保存，请稍后重试。", retryable: true } } })
      : route.fulfill({ json: { saved: true } });
  });
  await login(page);
  await page.getByRole("button", { name: "AI 助手", exact: true }).filter({ visible: true }).click();
  await page.locator(".assistant-suggestions button").first().click();
  await expect(page.locator(".assistant-feedback")).toBeVisible(); expect(sources).toEqual(["SUGGESTION"]);
  const unresolved = page.getByRole("button", { name: "未解决", exact: true });
  await unresolved.click(); await expect(page.locator(".assistant-feedback [role=alert]")).toBeVisible();
  await expect(unresolved).toHaveAttribute("aria-pressed", "false");
  await unresolved.click(); await expect(unresolved).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".assistant-feedback-status")).toHaveText("反馈已记录");
  await unresolved.click(); expect(feedbacks).toEqual(["UNRESOLVED", "UNRESOLVED"]);
  await page.getByRole("button", { name: "已解决", exact: true }).click();
  await expect(page.getByRole("button", { name: "已解决", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(feedbacks).toEqual(["UNRESOLVED", "UNRESOLVED", "RESOLVED"]);
  await page.getByRole("button", { name: "关闭 AI 助手", exact: true }).click();
  await page.getByRole("button", { name: "AI 助手", exact: true }).filter({ visible: true }).click();
  await expect(page.getByRole("button", { name: "已解决", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByLabel("向 AI 助手提问").fill("帮我打开会员页面");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.locator(".assistant-feedback")).toHaveCount(2); expect(sources).toEqual(["SUGGESTION", "USER"]);
});
test("assistant opens the real stay-date form with durable guidance and no business submission", async ({ page }) => {
  await login(page); const orderId = await order(page.request);
  await enabledUi(page);
  await page.route("**/api/v1/assistant/chat", route => route.fulfill({ json: { conversationId: "synthetic-ui", text: "请在已打开的表单核对新离店日期。", entries: [{ page: "order", orderId, action: "EXTEND_STAY", ...assistantGuides.EXTEND_STAY }] } }));
  await page.goto(`/orders/${orderId}`); await expect(page.locator('[data-order-action="ADJUST_DEPARTURE"]')).toBeEnabled();
  let writes = 0; page.on("request", request => { if (request.method() === "POST" && /command-previews|\/quotes/.test(request.url())) writes++; });
  await page.getByRole("button", { name: "AI 助手", exact: true }).filter({ visible: true }).click();
  await page.getByLabel("向 AI 助手提问").fill("打开这个订单的续住入口"); await page.getByRole("button", { name: "发送", exact: true }).click();
  const dialog = page.locator("dialog[open]"); await expect(dialog.locator(".assistant-operation-guide")).toBeVisible();
  await page.screenshot(); // flush rendering; catches StrictMode cleanup hiding the guide immediately after mount
  await expect(dialog.locator(".assistant-operation-guide")).toBeVisible();
  await expect(page.getByTestId("ai-assistant-panel")).toHaveCount(0); expect(writes).toBe(0);
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await page.locator('[data-order-action="MOVE_UNIT"]').click();
  await expect(page.locator("dialog[open] .assistant-operation-guide")).toHaveCount(0);
  await page.locator("dialog[open]").getByRole("button", { name: "关闭", exact: true }).click();
});
