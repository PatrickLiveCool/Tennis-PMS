import { chromium, expect } from "@playwright/test";
import fs from "node:fs/promises";

// Read-only local demo: operating hours and one occupancy are browser fixtures.
// Draft gestures do not create orders or alter the venue configuration.
const out = ".local-workspace/calendar-fit-2026-09-21";
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  baseURL: "http://127.0.0.1:4273",
  viewport: { width: 1440, height: 900 },
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const board = page.locator(".tennis-board");
const dateInput = page.getByLabel("排场日期", { exact: true });
const day = () => page.locator(".tennis-day-group").first();
const slot = (court, time) =>
  day().getByRole("button", {
    name: `${court} 号场 ${time} 添加预订`,
    exact: true,
  });
const shift = (date, days) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
async function drag(a, b) {
  const x = await a.boundingBox(),
    y = await b.boundingBox();
  await page.mouse.move(x.x + x.width / 2, x.y + x.height / 2);
  await page.mouse.down();
  await page.mouse.move(y.x + y.width / 2, y.y + y.height / 2, { steps: 10 });
  await page.mouse.up();
}
async function assertFit() {
  const geometry = await board.evaluate((el) => {
    const row = el.querySelector(".tennis-schedule-row");
    const cells = row.querySelectorAll(".tennis-grid-slot");
    const header = el.querySelectorAll(".tennis-grid-time");
    const rect = (node) => node.getBoundingClientRect();
    return {
      gap: rect(el).right - rect(cells[cells.length - 1]).right,
      overflow: el.scrollWidth - el.clientWidth,
      alignment: Math.max(
        ...Array.from(header, (label) =>
          Math.abs(
            rect(cells[Number(label.dataset.slotStart)]).left -
              rect(label).left,
          ),
        ),
      ),
      centering: Math.max(
        ...Array.from(header, (label) => {
          const text = label.querySelector("span");
          return text
            ? Math.abs(
                (rect(text).left + rect(text).right) / 2 -
                  (rect(label).left + rect(label).right) / 2,
              )
            : 0;
        }),
      ),
    };
  });
  expect(Math.abs(geometry.gap)).toBeLessThanOrEqual(1);
  expect(geometry.overflow).toBeLessThanOrEqual(1);
  expect(geometry.alignment).toBeLessThanOrEqual(1);
  expect(geometry.centering).toBeLessThanOrEqual(1);
  await expect
    .poll(() =>
      board
        .locator(".tennis-grid-time > span")
        .evaluateAll((els) =>
          els.every(
            (el, i) =>
              !i ||
              el.getBoundingClientRect().left >
                els[i - 1].getBoundingClientRect().right,
          ),
        ),
    )
    .toBe(true);
  const occupancy = await day()
    .locator(".tennis-schedule-block")
    .first()
    .boundingBox();
  const occupied = day()
    .locator(".tennis-schedule-row")
    .first()
    .locator(".tennis-grid-slot.is-blocked");
  const first = await occupied.first().boundingBox(),
    last = await occupied.last().boundingBox();
  expect(Math.abs(occupancy.x - first.x)).toBeLessThan(1);
  expect(
    Math.abs(occupancy.x + occupancy.width - last.x - last.width),
  ).toBeLessThan(1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
}
async function assertBlock(selector, start, end) {
  const block = await day().locator(selector).first().boundingBox();
  const a = await slot(1, start).boundingBox();
  const b = await slot(1, end).boundingBox();
  expect(Math.abs(block.x - a.x)).toBeLessThan(1);
  expect(Math.abs(block.x + block.width - b.x - b.width)).toBeLessThan(1);
}
try {
  await page.goto("/");
  await page.getByLabel("账号", { exact: true }).fill("demo.staff");
  await page.getByLabel("密码", { exact: true }).fill("TennisPMS123!");
  await page.getByRole("button", { name: "进入工作台", exact: true }).click();
  await page
    .locator(".tennis-grid-slot")
    .first()
    .waitFor({ state: "attached" });
  await expect(
    page.getByRole("button", { name: "3天", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".tennis-day-group")).toHaveCount(3);
  for (const days of [3, 7, 1]) {
    await page.getByRole("button", { name: `${days}天`, exact: true }).click();
    for (const start of ["2399-12-29", "2400-02-28"]) {
      await dateInput.fill(start);
      await page
        .getByRole("button", { name: `向后 ${days} 天`, exact: true })
        .click();
      const next = shift(start, days);
      await expect(dateInput).toHaveValue(next);
      await expect(
        page
          .locator(
            `[data-schedule-date="${shift(next, days - 1)}"] .tennis-grid-slot`,
          )
          .first(),
      ).toBeAttached();
      await expect(page.locator(".tennis-day-group")).toHaveCount(days);
      await page
        .getByRole("button", { name: `向前 ${days} 天`, exact: true })
        .click();
      await expect(dateInput).toHaveValue(start);
    }
  }
  await page.reload();
  await expect(
    page.getByRole("button", { name: "1天", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  console.log(
    "PASS fresh default three days, remembered explicit choice, ±1/3/7 paging across year/month/leap day",
  );

  let hours = [9 * 60 + 15, 12 * 60 + 45];
  const openingHours = () =>
    Array.from({ length: 7 }, (_, weekday) => ({
      weekday,
      startMinute: hours[0],
      endMinute: hours[1],
    }));
  await page.route("**/api/tennis/venues", async (route) => {
    const response = await route.fetch();
    const venues = await response.json();
    await route.fulfill({
      response,
      json: venues.map((v) => ({ ...v, openingHours: openingHours() })),
    });
  });
  await page.route("**/schedule?date=*", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    const date = new URL(route.request().url()).searchParams.get("date");
    await route.fulfill({
      response,
      json: {
        ...data,
        venue: { ...data.venue, openingHours: openingHours() },
        occupancies: [
          {
            id: "calendar-fit-fixture",
            courtId: data.courts[0].id,
            kind: "MAINTENANCE",
            startAt: new Date(`${date}T11:00:00+08:00`).toISOString(),
            endAt: new Date(`${date}T12:00:00+08:00`).toISOString(),
          },
        ],
      },
    });
  });
  await page.getByRole("button", { name: "3天", exact: true }).click();
  for (const [name, range] of [
    ["short", [555, 765]],
    ["normal", [480, 1320]],
    ["full-day", [0, 1440]],
  ]) {
    hours = range;
    await page.reload();
    await slot(1, "09:15").waitFor();
    for (const width of [1920, 1440, 1024, 768]) {
      await page.setViewportSize({ width, height: 900 });
      await assertFit();
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await drag(slot(1, "09:15"), slot(2, "09:45"));
    await expect(page.locator(".tennis-selection")).toHaveCount(2);
    await assertFit();
    await assertBlock(".tennis-draft-block", "09:15", "09:45");
    // Hit testing must use the resized board width after the side panel opens.
    await drag(
      page.getByLabel("拖动调整结束", { exact: true }).first(),
      slot(1, "10:15"),
    );
    await assertBlock(".tennis-draft-block", "09:15", "10:15");
    const draft = await page.evaluate(() =>
      JSON.parse(
        sessionStorage.getItem(
          Object.keys(sessionStorage).find((k) =>
            k.startsWith("tennis:booking:"),
          ),
        ),
      ),
    );
    expect(
      Date.parse(draft.lines[0].endAt) - Date.parse(draft.lines[0].startAt),
    ).toBe(75 * 60000);
    for (const width of [1920, 1280, 768]) {
      await page.setViewportSize({ width, height: 900 });
      await assertFit();
      await assertBlock(".tennis-draft-block", "09:15", "10:15");
      await page.screenshot({
        path: `${out}/${name}-${width}.png`,
        fullPage: true,
      });
    }
    await page.getByRole("button", { name: "清空全部", exact: true }).click();
    await page.getByRole("button", { name: "收起", exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
    console.log(
      `PASS ${name}: axis fills 768–1920px layouts; multicourt drag/resize and drafts stay aligned with side panel`,
    );
  }
  await page.clock.setFixedTime(new Date("2400-02-28T15:59:00Z"));
  await page.getByRole("button", { name: "现在", exact: true }).click();
  await expect(day().locator(".tennis-now-line")).toBeVisible();
  await assertFit();
  console.log(
    "PASS current-time marker near closing stays inside the fitted board",
  );
  expect(errors).toEqual([]);
  console.log("ALL CALENDAR FIT SCENARIOS PASSED");
} finally {
  await browser.close();
}
