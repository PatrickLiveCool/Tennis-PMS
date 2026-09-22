import { chromium, expect } from "@playwright/test";
import fs from "node:fs/promises";
import { reserveSyntheticPhone } from "./browser-fixtures.mjs";

// Only synthetic local demo records. No payment or external-service calls.
const baseURL = "http://127.0.0.1:4273";
const out = ".local-workspace/multiday-2026-09-21";
await fs.mkdir(out, { recursive: true });
const start = new Date(
  Date.UTC(
    2200 + Math.floor(Math.random() * 100),
    Math.floor(Math.random() * 12),
    5,
  ),
);
const date = (n) =>
  new Date(start.getTime() + n * 86400000).toISOString().slice(0, 10);
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  baseURL,
  viewport: { width: 1440, height: 900 },
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
async function login(p) {
  await p.goto(baseURL);
  await p.getByLabel("账号", { exact: true }).fill("demo.staff");
  await p.getByLabel("密码", { exact: true }).fill("TennisPMS123!");
  await p.getByRole("button", { name: "进入工作台", exact: true }).click();
  await p.locator(".tennis-grid-slot").first().waitFor({ state: "attached" });
}
const group = (n) => page.locator(`[data-schedule-date="${date(n)}"]`);
const slot = (n, court, time) =>
  group(n).getByRole("button", {
    name: `${court} 号场 ${time} 添加预订`,
    exact: true,
  });
const board = page.locator(".tennis-board");
const quoteButton = page.getByRole("button", {
  name: "核对场地与报价",
  exact: true,
});
async function drag(a, b) {
  const x = await a.boundingBox(),
    y = await b.boundingBox();
  await page.mouse.move(x.x + x.width / 2, x.y + x.height / 2);
  await page.mouse.down();
  await page.mouse.move(y.x + y.width / 2, y.y + y.height / 2, { steps: 10 });
  await page.mouse.up();
}
async function draft() {
  return page.evaluate(() =>
    JSON.parse(
      sessionStorage.getItem(
        Object.keys(sessionStorage).find((key) =>
          key.startsWith("tennis:booking:"),
        ),
      ),
    ),
  );
}
try {
  await login(page);
  expect((await board.boundingBox()).y).toBeLessThan(170);
  await expect(page.getByText(/按 15 分钟调度/)).toHaveCount(0);
  await page.getByLabel("排场日期", { exact: true }).fill(date(0));
  await slot(0, 1, "09:00").waitFor();
  await page.getByRole("button", { name: "3天", exact: true }).click();
  await slot(2, 1, "09:00").waitFor({ state: "attached" });
  await expect(page.locator(".tennis-schedule-header")).toHaveCount(1);
  await drag(slot(0, 3, "09:45"), slot(0, 1, "09:00"));
  await expect(page.locator(".tennis-selection")).toHaveCount(3);
  await page.getByLabel("姓名", { exact: true }).fill("多日排场验收客");
  await page.getByLabel("手机号", { exact: true }).fill(reserveSyntheticPhone());
  await group(0)
    .getByRole("button", { name: "取消草稿 1 号场 09:00", exact: true })
    .click();
  await expect(page.locator(".tennis-selection")).toHaveCount(2);
  await slot(1, 1, "10:00").click();
  await expect(page.locator(".tennis-selection")).toHaveCount(3);
  expect(
    new Set((await draft()).lines.map((l) => l.startAt.slice(0, 10))).size,
  ).toBe(2);
  await expect(page.getByLabel("姓名", { exact: true })).toHaveValue(
    "多日排场验收客",
  );
  console.log(
    "PASS reverse rectangle, per-day cancellation and cross-day same-customer draft",
  );

  // A refresh that overlaps a real pointer gesture must not disable or remount the grid.
  const releases = [];
  let completed = 0;
  await page.route("**/schedule?date=*", async (route) => {
    const response = await route.fetch();
    await new Promise((resolve) => releases.push(resolve));
    await route.fulfill({ response });
    completed++;
  });
  await page.getByRole("button", { name: "刷新排场", exact: true }).click();
  await expect.poll(() => releases.length).toBe(3);
  await expect(slot(1, 2, "10:00")).toBeEnabled();
  await expect(quoteButton).toBeEnabled();
  const before = await board.evaluate((el) => ({
    top: el.getBoundingClientRect().top,
    x: el.scrollLeft,
    y: el.scrollTop,
  }));
  await page.getByLabel("姓名", { exact: true }).fill("刷新中继续填写");
  await drag(slot(1, 2, "10:00"), slot(1, 3, "10:45"));
  await expect(page.locator(".tennis-selection")).toHaveCount(5);
  releases.forEach((resolve) => resolve());
  await expect.poll(() => completed).toBe(3);
  await page.unroute("**/schedule?date=*");
  await expect(page.getByLabel("姓名", { exact: true })).toHaveValue(
    "刷新中继续填写",
  );
  expect(
    await board.evaluate((el) => ({
      top: el.getBoundingClientRect().top,
      x: el.scrollLeft,
      y: el.scrollTop,
    })),
  ).toEqual(before);
  console.log(
    "PASS delayed background refresh preserves input, selection, geometry and scroll",
  );

  // Every day owns its Escape handler; a focused block in another day must survive.
  await group(0)
    .getByRole("button", { name: "取消草稿 2 号场 09:00", exact: true })
    .focus();
  await group(1)
    .getByRole("button", { name: "取消草稿 1 号场 10:00", exact: true })
    .focus();
  await page.keyboard.press("Escape");
  await expect(page.locator(".tennis-selection")).toHaveCount(4);
  expect(
    (await draft()).lines.filter((l) => l.startAt.startsWith(date(0))).length,
  ).toBe(2);
  console.log("PASS Escape removes only the focused day's selection");

  await page.route("**/schedule?date=*", (route) => route.abort("failed"));
  await page.getByRole("button", { name: "刷新排场", exact: true }).click();
  await expect(page.getByText("更新失败", { exact: true })).toBeVisible();
  await expect(quoteButton).toBeDisabled();
  await expect(page.locator(".tennis-selection")).toHaveCount(4);
  await expect(page.getByLabel("姓名", { exact: true })).toHaveValue(
    "刷新中继续填写",
  );
  await page.unroute("**/schedule?date=*");
  await page.getByRole("button", { name: "刷新排场", exact: true }).click();
  await expect(quoteButton).toBeEnabled();
  console.log(
    "PASS failed refresh blocks submit but keeps drafts; recovery re-enables quote",
  );

  await quoteButton.click();
  await page.getByRole("button", { name: "确认预订", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator("tbody tr")).toHaveCount(4);
  await page.screenshot({ path: `${out}/cross-day-order.png`, fullPage: true });
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  console.log("PASS actual local cross-day four-line order and order drawer");

  await page.getByRole("button", { name: "7天", exact: true }).click();
  await group(6)
    .locator(".tennis-grid-slot")
    .first()
    .waitFor({ state: "attached" });
  await expect(page.locator(".tennis-day-group")).toHaveCount(7);
  await page.getByLabel("筛选球场", { exact: true }).selectOption("indoor");
  await expect(group(6).locator(".tennis-schedule-row")).toHaveCount(2);
  await page
    .getByRole("button", { name: `折叠 ${date(1)}`, exact: true })
    .click();
  await expect(group(1).locator(".tennis-schedule-row")).toHaveCount(0);
  await board.evaluate((el) => {
    el.scrollLeft = 400;
    el.scrollTop = 420;
  });
  const savedPosition = await board.evaluate((el) => ({
    x: el.scrollLeft,
    y: el.scrollTop,
  }));
  await page.reload();
  await expect(
    page.getByRole("button", { name: "7天", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("筛选球场", { exact: true })).toHaveValue(
    "indoor",
  );
  await expect
    .poll(() => board.evaluate((el) => ({ x: el.scrollLeft, y: el.scrollTop })))
    .toEqual(savedPosition);
  await expect(group(1).locator(".tennis-schedule-row")).toHaveCount(0);
  console.log(
    "PASS seven-day view, shared horizontal axis, filtering, collapse and return position",
  );

  // Observe two real polling cycles, including response latency, without user interaction.
  let reads = 0;
  await page.route("**/schedule?date=*", async (route) => {
    reads++;
    const response = await route.fetch();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await route.fulfill({ response });
  });
  await page.evaluate(() => {
    const board = document.querySelector(".tennis-board");
    window.__scheduleStability = { removals: 0, disabled: 0 };
    window.__scheduleObserver = new MutationObserver((records) => {
      for (const r of records) {
        if (
          r.type === "attributes" &&
          r.target.matches(".tennis-grid-slot.is-free,.tennis-draft-hit")
        )
          window.__scheduleStability.disabled++;
        for (const el of r.removedNodes)
          if (
            el instanceof Element &&
            (el.matches(".tennis-grid") || el.querySelector(".tennis-grid"))
          )
            window.__scheduleStability.removals++;
      }
    });
    window.__scheduleObserver.observe(board, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["disabled"],
    });
  });
  await expect
    .poll(() => reads, { timeout: 35000, intervals: [500] })
    .toBeGreaterThanOrEqual(14);
  await page.waitForTimeout(400);
  expect(
    await page.evaluate(() => {
      window.__scheduleObserver.disconnect();
      return window.__scheduleStability;
    }),
  ).toEqual({ removals: 0, disabled: 0 });
  expect(
    await board.evaluate((el) => ({ x: el.scrollLeft, y: el.scrollTop })),
  ).toEqual(savedPosition);
  await page.unroute("**/schedule?date=*");
  console.log(
    "PASS two real polling cycles: no grid removal, disabled flash or scroll movement",
  );

  await page.getByLabel("筛选球场", { exact: true }).selectOption("all");
  await page.getByRole("button", { name: "3天", exact: true }).click();
  await board.evaluate((el) => {
    el.scrollTop = 0;
    el.scrollLeft = 0;
  });
  await page.screenshot({
    path: `${out}/desktop-three-days.png`,
    fullPage: true,
  });
  for (const viewport of [
    { width: 1280, height: 720 },
    { width: 768, height: 1024 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await expect(
      page.getByRole("button", { name: "预订", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: `${out}/layout-${viewport.width}.png`,
      fullPage: true,
    });
  }
  console.log(
    "PASS compact desktop/tablet/mobile layouts without page overflow",
  );
  let releaseOld;
  let oldDone = false;
  await page.route(`**/schedule?date=${date(20)}`, async (route) => {
    const response = await route.fetch();
    await new Promise((resolve) => {
      releaseOld = resolve;
    });
    await route.fulfill({ response });
    oldDone = true;
  });
  await page.getByLabel("排场日期", { exact: true }).fill(date(20));
  await expect.poll(() => Boolean(releaseOld)).toBe(true);
  await page.getByLabel("排场日期", { exact: true }).fill(date(23));
  await group(23)
    .locator(".tennis-grid-slot")
    .first()
    .waitFor({ state: "attached" });
  releaseOld();
  await expect.poll(() => oldDone).toBe(true);
  await page.unroute(`**/schedule?date=${date(20)}`);
  await expect(group(23)).toHaveCount(1);
  await expect(group(20)).toHaveCount(0);
  await page.route("**/schedule?date=*", (route) =>
    route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "VENUE_ACCESS_DENIED" } }),
    }),
  );
  await page.getByRole("button", { name: "刷新排场", exact: true }).click();
  await expect(
    page.getByText("当前账号没有该场馆的操作权限。", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".tennis-grid-slot")).toHaveCount(0);
  await page.unroute("**/schedule?date=*");
  await page.getByRole("button", { name: "刷新排场", exact: true }).click();
  await group(23)
    .locator(".tennis-grid-slot")
    .first()
    .waitFor({ state: "attached" });
  console.log(
    "PASS delayed old range cannot overwrite current dates; denied access removes cached facts",
  );
  await context.close();

  const mobile = await browser.newContext({
    baseURL,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const mp = await mobile.newPage();
  await login(mp);
  await expect(
    mp.getByRole("button", { name: "3天", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await mp.getByLabel("排场日期", { exact: true }).fill(date(10));
  await mp.getByRole("button", { name: "3天", exact: true }).click();
  const md = mp.locator(`[data-schedule-date="${date(11)}"]`);
  await md
    .getByRole("button", { name: "1 号场 09:00 选场", exact: true })
    .tap();
  await mp.getByLabel("姓名", { exact: true }).fill("手机跨日验收客");
  await expect(mp.locator(".tennis-selection")).toHaveCount(1);
  await mp.getByRole("button", { name: "收起", exact: true }).tap();
  await mp
    .locator(`[data-schedule-date="${date(12)}"]`)
    .getByRole("button", { name: "1 号场 10:00 选场", exact: true })
    .tap();
  await expect(mp.locator(".tennis-selection")).toHaveCount(2);
  await expect(mp.getByLabel("姓名", { exact: true })).toHaveValue(
    "手机跨日验收客",
  );
  await mp.screenshot({ path: `${out}/mobile-cross-day.png`, fullPage: true });
  await mobile.close();
  expect(errors).toEqual([]);
  console.log(
    "PASS mobile defaults to three days and supports multi-day selection with retained customer",
  );
  console.log("ALL MULTIDAY SCENARIOS PASSED", date(0));
} finally {
  await browser.close();
}
