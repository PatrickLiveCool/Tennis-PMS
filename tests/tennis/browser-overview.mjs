import { chromium, expect } from "@playwright/test";

// Start the local web preview, then run: node tests/tennis/browser-overview.mjs
// All business requests are intercepted; this test does not log in or write to a database.
const baseURL = "http://127.0.0.1:4273";
const today = "2026-09-22";
const historyDate = "2026-09-21";
const session = {
  subjectId: "overview-staff", displayName: "概览回归测试", csrfToken: "synthetic",
  tenantId: "overview-tenant", kind: "staff", platformOperator: false, contextVersion: 1,
  permissions: ["read", "manage_members"], allVenues: true, venueIds: [], customerId: null,
  expiresAt: "2099-01-01T00:00:00Z", localSimulation: true,
  tenants: [{ id: "overview-tenant", name: "测试商家", kind: "staff", role: "ADMIN" }],
};
const venue = {
  id: "overview-venue", tenantId: session.tenantId, name: "合成测试场馆", address: "",
  timezone: "Asia/Shanghai", active: true, openingHours: [], minimumBookingMinutes: 15, catalogRevision: 1,
};
const orders = [
  { id: "previous-night", customerName: "昨晚跨日预约", startAt: "2026-09-21T15:30:00Z", endAt: "2026-09-21T17:00:00Z" },
  { id: "next-night", customerName: "今晚跨日预约", startAt: "2026-09-22T15:30:00Z", endAt: "2026-09-22T17:00:00Z" },
].map(({ startAt, endAt, ...order }) => ({
  ...order, tenantId: session.tenantId, venueId: venue.id, customerId: `customer-${order.id}`,
  status: "CONFIRMED", paymentStatus: "PAID", totalCents: 12000, holdUntil: null,
  matchingLines: [{ id: `line-${order.id}`, courtId: "court-1", courtName: "一号场", startAt, endAt }],
}));
function ledger(date) {
  const entries = date === historyDate ? Array.from({ length: 45 }, (_, index) => ({
    id: `receipt-${String(index + 1).padStart(3, "0")}`, kind: "ORDER_RECEIPT",
    cashCents: 100, walletCents: 0, giftCents: 0,
    createdAt: `${historyDate}T02:00:00Z`, referenceId: `order-${index + 1}`,
  })) : [];
  return {
    date, entries, pendingRefunds: [], exceptions: [],
    totals: { cashInCents: entries.length * 100, cashRefundCents: 0, walletConsumedCents: 0, walletRefundCents: 0, giftCents: 0 },
  };
}

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  const unexpectedRequests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.clock.setFixedTime(new Date(`${today}T04:00:00Z`));
  const identityScope = `${session.subjectId}:staff:${session.tenantId}:staff`;
  await context.addInitScript((scope) => {
    sessionStorage.setItem(`tennis:page:${scope}`, JSON.stringify("today"));
    sessionStorage.setItem(`tennis:schedule-entry-v1:${scope}`, "true");
  }, identityScope);
  await page.route("**/api/tennis/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace("/api/tennis", "");
    let value;
    if (request.method() === "GET") {
      if (path === "/session") value = session;
      else if (path === "/venues") value = [venue];
      else if (path === `/venues/${venue.id}/orders`) value = { orders, nextCursor: null };
      else if (path === `/venues/${venue.id}/finance`) value = ledger(url.searchParams.get("date"));
      else if (path === "/wecom/receipts") value = { items: [], nextCursor: null };
      else if (path === "/wecom/payment-targets") value = [];
      else if (path === "/backoffice-assistant/status") value = {
        configured: false, enabled: false, configReady: false, connectionAvailable: false,
      };
      else if (path === "/backoffice-assistant/conversations") value = [];
    }
    if (value === undefined) {
      unexpectedRequests.push(`${request.method()} ${path}`);
      await route.abort("blockedbyclient");
    } else await route.fulfill({ json: value });
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "经营概览", exact: true })).toBeVisible();
  const workbench = page.getByRole("tabpanel", { name: "工作台", exact: true });
  await expect(workbench.locator("article").filter({ hasText: "昨晚跨日预约" }))
    .toContainText(/09\/21\s+23:30\s*–\s*09\/22\s+01:00/);
  await expect(workbench.locator("article").filter({ hasText: "今晚跨日预约" }))
    .toContainText(/09\/22\s+23:30\s*–\s*09\/23\s+01:00/);
  console.log("PASS overnight appointments show their actual dates");

  await page.getByRole("tab", { name: "收款历史", exact: true }).click();
  const history = page.getByRole("tabpanel", { name: "收款历史", exact: true });
  await history.getByLabel("日期", { exact: true }).fill(historyDate);
  await expect(history).toContainText("当日共 45 条流水");
  await history.getByRole("button", { name: "下一页", exact: true }).click();
  await history.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(history).toContainText("第 41–45 条 · 第 3 / 3 页");
  await page.getByRole("tab", { name: "退款与异常", exact: true }).click();
  await expect(page.getByRole("tabpanel", { name: "退款与异常", exact: true }))
    .toContainText("暂无待处理退款");
  await page.getByRole("tab", { name: "收款历史", exact: true }).click();
  await expect(history.getByLabel("日期", { exact: true })).toHaveValue(historyDate);
  await expect(history).toContainText("第 41–45 条 · 第 3 / 3 页");
  await expect(history.locator("tbody tr")).toHaveCount(5);
  console.log("PASS switching to all-date exceptions preserves the historical ledger page");

  await page.reload();
  await expect(page.getByRole("tab", { name: "收款历史", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(history.getByLabel("日期", { exact: true })).toHaveValue(historyDate);
  await expect(history).toContainText("第 41–45 条 · 第 3 / 3 页");
  expect(errors).toEqual([]);
  expect(unexpectedRequests).toEqual([]);
  console.log("PASS reload restores the selected tab, date and ledger page without browser errors");
} finally {
  await browser.close();
}
