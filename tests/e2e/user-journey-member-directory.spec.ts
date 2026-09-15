import { expect, test } from "@playwright/test";

const propertyId = "prop_qintopia_demo";
const memberId = "member_demo_profile";
test("member directory keeps search and page while opening details, retrying, and returning", async ({ page }, testInfo) => {
  await page.request.post("/api/v1/auth/login", { data: { username: "admin", password: "demo-pass-2026" } });
  const meta = await (await page.request.get("/api/v1/meta")).json();
  expect(meta.members).toEqual([]);
  expect(meta.memberContracts).toEqual([]);
  const { member } = await (await page.request.get(`/api/v1/members/${memberId}?propertyId=${propertyId}`)).json();
  const members = Array.from({ length: 53 }, (_, index) => ({ member: { ...member, id: index === 52 ? memberId : `member_page_${index}`, nickname: `目录分页 ${index}` } }));
  let failNext = false;
  await page.route("**/api/v1/members?**", async (route) => {
    const query = new URL(route.request().url()).searchParams;
    if (query.get("memberId") || query.get("hasContract")) { await route.continue(); return; }
    expect(query.get("query")).toBe("目录分页");
    if (failNext) { failNext = false; await route.fulfill({ status: 503, json: { code: "INTERNAL_ERROR", message: "目录读取暂不可用" } }); return; }
    const offset = query.get("beforeId") ? 50 : 0;
    await route.fulfill({ json: { members: members.slice(offset, offset + 50), nextCursor: offset ? null : members[49]!.member.id } });
  });
  await page.goto(`/members?q=${encodeURIComponent("目录分页")}&propertyId=${propertyId}`);
  await expect(page.getByTestId("member-list-item")).toHaveCount(50);
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page.getByTestId("member-list-item")).toHaveCount(3);
  await page.getByTestId("member-list-item").filter({ hasText: "目录分页 52" }).click();
  await expect(page.getByRole("heading", { name: member.full_name, exact: true })).toBeVisible();
  await expect(page.getByTestId("arrange-member-stay")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("member-detail.png"), fullPage: true });
  await page.screenshot({ path: testInfo.outputPath("member-detail-viewport.png") });
  if (testInfo.project.name === "mobile") {
    await expect(page.getByTestId("member-list-item").first()).not.toBeVisible();
    await page.getByRole("button", { name: "返回会员列表", exact: true }).click();
  }
  await expect(page.getByTestId("member-search-query")).toHaveValue("目录分页");
  await expect(page.getByTestId("member-list-item")).toHaveCount(3);
  failNext = true;
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(page.getByRole("button", { name: "重新载入", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "重新载入", exact: true }).click();
  await expect(page.getByTestId("member-list-item")).toHaveCount(3);
  await page.getByRole("button", { name: "上一页", exact: true }).click();
  await expect(page.getByTestId("member-list-item")).toHaveCount(50);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("settings retain old deep links and hide external access from ungranted staff", async ({ page }, testInfo) => {
  await page.request.post("/api/v1/auth/login", { data: { username: "admin", password: "demo-pass-2026" } });
  await page.goto("/tokens?from=legacy");
  await expect(page).toHaveURL(/\/settings\/tokens\?from=legacy$/);
  await expect(page.getByRole("heading", { name: "智能体与外部访问", exact: true })).toBeVisible();
  const permissions = page.locator(".token-permissions").first();
  await expect(permissions.locator("summary")).toBeVisible();
  await permissions.locator("summary").click();
  await expect(permissions.locator("small")).toBeVisible();
  await permissions.locator("summary").click();
  await page.screenshot({ path: testInfo.outputPath("external-access.png"), fullPage: true });
  await page.goto("/settings");
  await expect(page.getByRole("navigation", { name: "设置入口", exact: true }).getByRole("link", { name: /外部访问/ })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("settings.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.request.post("/api/v1/auth/logout");
  await page.request.post("/api/v1/auth/login", { data: { username: "operator", password: "demo-pass-2026" } });
  await page.goto("/settings");
  await expect(page.getByRole("navigation", { name: "设置入口", exact: true }).getByRole("link", { name: /外部访问/ })).toHaveCount(0);
});

test("workbench read failure stays distinct from an empty queue and can retry", async ({ page }) => {
  await page.request.post("/api/v1/auth/login", { data: { username: "operator", password: "demo-pass-2026" } });
  await page.route("**/api/v1/orders?**", (route) => route.fulfill({ status: 503, json: { code: "UNAVAILABLE", message: "工作台读取暂不可用" } }));
  await page.goto("/today");
  await expect(page.getByRole("button", { name: "重新载入工作台", exact: true })).toBeVisible();
  await expect(page.getByText("当前队列为空", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "今日到店 —", exact: true })).toBeVisible();
  await page.unroute("**/api/v1/orders?**");
  await page.getByRole("button", { name: "重新载入工作台", exact: true }).click();
  await expect(page.getByRole("button", { name: "重新载入工作台", exact: true })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: /^今日到店 \d+$/ })).toBeVisible();
});


test("order creation opens the shared room and date selector", async ({ page }) => {
  await page.request.post("/api/v1/auth/login", { data: { username: "operator", password: "demo-pass-2026" } });
  await page.goto("/orders");
  await page.getByRole("link", { name: "新建住宿", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "新建住宿或锁房", exact: true })).toBeVisible();
  await expect(page.getByTestId("room-status-unit-select")).toBeVisible();
  await page.getByRole("dialog", { name: "新建住宿或锁房", exact: true }).getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "新建住宿或锁房", exact: true })).toHaveCount(0);
});
