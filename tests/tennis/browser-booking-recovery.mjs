import { chromium, expect } from "@playwright/test";
import fs from "node:fs/promises";

// Real compiled UI with synthetic API responses only. No database, login,
// payment, model or external channel is contacted by these scenarios.
// Start the current local preview, then: node tests/tennis/browser-booking-recovery.mjs
const baseURL = process.env.TENNIS_BROWSER_BASE_URL ?? "http://127.0.0.1:4273";
const out = ".local-workspace/booking-fixes-20260923";
const today = "2026-10-05"; // Monday; displayed Monday–Wednesday opens 08:00–22:00.
const extendedDate = "2026-10-08"; // Thursday is outside that view, opens 06:00–24:00.
const closedDate = "2026-10-09";
const now = new Date(`${today}T04:00:00Z`);
const afterExpiry = new Date(`${today}T04:06:00Z`);
const session = {
  subjectId: "booking-browser-staff", displayName: "预订回归测试", csrfToken: "synthetic",
  tenantId: "booking-browser-tenant", kind: "staff", platformOperator: false, contextVersion: 1,
  permissions: ["read", "book", "hold_unpaid"], allVenues: true, venueIds: [], customerId: null,
  expiresAt: "2099-01-01T00:00:00Z", localSimulation: true,
  tenants: [{ id: "booking-browser-tenant", name: "合成预订回归", kind: "staff", role: "STAFF" }],
};
const venue = {
  id: "booking-browser-venue", tenantId: session.tenantId, name: "合成测试场馆", address: "",
  timezone: "Asia/Shanghai", active: true, minimumBookingMinutes: 45, catalogRevision: 1,
  openingHours: [
    ...[0, 1, 2, 3].map((weekday) => ({ weekday, startMinute: 480, endMinute: 1320 })),
    { weekday: 4, startMinute: 360, endMinute: 1440 },
    { weekday: 6, startMinute: 360, endMinute: 600 },
    { weekday: 6, startMinute: 720, endMinute: 1440 },
  ],
};
const court = {
  id: "booking-browser-court", tenantId: session.tenantId, venueId: venue.id,
  name: "一号场", active: true, indoor: true, environment: "INDOOR", surface: "ACRYLIC",
  hourlyPriceCents: 12000, revision: 1,
  profile: {
    specification: "STANDARD", lighting: "AVAILABLE", climate: "VENTILATED", surfaceNote: "", description: "",
    playingLengthM: null, playingWidthM: null, totalLengthM: null, totalWidthM: null,
  },
};
const customer = {
  id: "booking-browser-customer", tenantId: session.tenantId, nickname: "恢复验收球友",
  phone: null, hasContact: true, active: true,
};
const identityScope = `${session.subjectId}:staff:${session.tenantId}:staff`;
const scope = `${identityScope}:1:${venue.id}`;
const draftKey = `tennis:booking:${scope}`;
const pendingKey = `tennis:pending:${scope}`;
const results = [];
await fs.mkdir(out, { recursive: true });

function price(lines) {
  const priced = lines.map((line) => {
    const totalCents = (Date.parse(line.endAt) - Date.parse(line.startAt)) / 3_600_000 * court.hourlyPriceCents;
    return { ...line, venueId: venue.id, currency: "CNY", totalCents, segments: [{
      startAt: line.startAt, endAt: line.endAt, hourlyPriceCents: court.hourlyPriceCents,
      discountBps: 10000, discountRuleId: null, amountCents: totalCents,
    }] };
  });
  return { venueId: venue.id, catalogRevision: 1, currency: "CNY", lines: priced,
    totalCents: priced.reduce((total, line) => total + line.totalCents, 0) };
}
async function stored(page, key) {
  return page.evaluate((storageKey) => JSON.parse(sessionStorage.getItem(storageKey) ?? "null"), key);
}
async function geometry(page) {
  const sizes = await page.evaluate(() => ({
    viewport: innerWidth, document: document.documentElement.scrollWidth,
    draft: (() => { const el = document.querySelector(".tennis-booking-side");
      return el ? { width: el.clientWidth, scrollWidth: el.scrollWidth } : null; })(),
  }));
  expect(sizes.document).toBeLessThanOrEqual(sizes.viewport);
  if (sizes.draft) expect(sizes.draft.scrollWidth).toBeLessThanOrEqual(sizes.draft.width);
  return sizes;
}
async function runScenario(browser, width, outcome) {
  const name = `${width}-${outcome}`;
  const context = await browser.newContext({
    baseURL, viewport: { width, height: width === 390 ? 844 : 1000 },
    ...(width === 390 ? { isMobile: true, hasTouch: true } : {}),
  });
  const page = await context.newPage();
  const pageErrors = [], consoleMessages = [], unexpectedRequests = [], calls = [];
  const confirmations = [], quotes = [];
  let receiptReads = 0;
  let customerWrites = 0;
  let detailReads = 0;
  let order;
  let simulatedNow = now;
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) consoleMessages.push({
      type: message.type(), text: message.text(), url: message.location().url,
    });
  });
  await page.clock.setFixedTime(now);
  // Catch all API and off-origin requests. Only this preview's static assets
  // may reach the network; an unhandled business request fails the scenario.
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== new URL(baseURL).origin) {
      unexpectedRequests.push(`${request.method()} ${url.origin}${url.pathname}`);
      return route.abort("blockedbyclient");
    }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const path = url.pathname.replace("/api/tennis", "");
    calls.push(`${request.method()} ${path}`);
    let value;
    if (request.method() === "GET") {
      if (path === "/session") value = session;
      else if (path === "/venues") value = [venue];
      else if (path === `/venues/${venue.id}/schedule`) value = { venue, courts: [court], occupancies: [] };
      else if (path === `/venues/${venue.id}/courts`) value = [court];
      else if (path === `/venues/${venue.id}/booking-customers`) value = [];
      else if (path.startsWith("/receipts/")) {
        receiptReads++;
        expect(decodeURIComponent(path.slice("/receipts/".length))).toBe(confirmations[0].body.commandKey);
        value = outcome === "receipt" ? {
          commandType: "quote.confirm", result: { orderId: order.id }, completedAt: now.toISOString(),
        } : null;
      } else if (order && path === `/orders/${order.id}`) { value = order; detailReads++; }
      else if (order && path === `/orders/${order.id}/amendments`) value = [];
      else if (path === "/backoffice-assistant/status") value = {
        configured: false, enabled: false, configReady: false, connectionAvailable: false,
      };
      else if (path === "/backoffice-assistant/conversations") value = [];
    } else if (request.method() === "POST") {
      const body = request.postDataJSON();
      if (path === `/venues/${venue.id}/booking-customers`) {
        customerWrites++;
        expect(body.nickname).toBe(customer.nickname);
        expect(body.phone).toBe("19900000001");
        value = { customerId: customer.id, customer };
      } else if (path === "/quotes") {
        expect(body.customerId).toBe(customer.id);
        const quote = {
          id: `booking-browser-quote-${quotes.length + 1}`, venueId: venue.id, customerId: customer.id,
          createdBy: session.subjectId, price: price(body.lines), createdAt: simulatedNow.toISOString(),
          expiresAt: new Date(simulatedNow.getTime() + 300_000).toISOString(), paymentHoldMinutes: 10,
        };
        quotes.push({ body, quote });
        value = quote;
      } else if (/^\/quotes\/[^/]+\/confirm$/.test(path)) {
        confirmations.push({ path, body });
        if (confirmations.length === 1) {
          const quote = quotes[0].quote;
          order = {
            id: "booking-browser-original-order", venueId: venue.id, customerId: customer.id,
            customerName: customer.nickname, quoteId: quote.id, createdBy: session.subjectId,
            status: "HELD", paymentStatus: "UNPAID", totalCents: quote.price.totalCents,
            currency: "CNY", holdKind: "STAFF", holdUntil: `${today}T05:00:00Z`,
            holdReason: "合成浏览器验收", revision: 1, price: quote.price, createdAt: now.toISOString(),
            lines: quote.price.lines.map((line, i) => ({ ...line, id: `booking-browser-line-${i}`,
              amountCents: line.totalCents, price: line, cancelledAt: null })), payments: [], refunds: [],
          };
          // Expired case: request never reached the server. Receipt case:
          // response was lost after the synthetic server committed the order.
          return route.abort("failed");
        }
        expect(outcome).toBe("expired");
        expect(confirmations[1]).toEqual(confirmations[0]);
        return route.fulfill({ status: 409, json: { error: { code: "QUOTE_EXPIRED" } } });
      }
    }
    if (value === undefined) {
      unexpectedRequests.push(`${request.method()} ${path}`);
      return route.abort("blockedbyclient");
    }
    return route.fulfill({ json: value });
  });

  try {
    await page.goto("/");
    await expect(page.getByLabel("排场日期", { exact: true })).toHaveValue(today);
    await expect(page.locator(".tennis-sync-status")).toHaveText("已同步");
    await page.getByRole("button", { name: "预订", exact: true }).click();
    const manual = page.locator(".tennis-manual-selection");
    const start = manual.getByRole("combobox", { name: /^开始时间/ });
    const duration = manual.getByRole("combobox", { name: /^预订时长/ });
    const add = manual.getByRole("button", { name: "添加时段", exact: true });
    await manual.getByLabel("预订日期", { exact: true }).fill(extendedDate);
    await manual.getByLabel("预订日期", { exact: true }).press("Tab");
    await expect(start.locator("option[value='360']")).toHaveCount(1);
    await expect(start.locator("option[value='1380']")).toHaveCount(1);
    await expect(duration.locator("option[value='15'],option[value='30']")).toHaveCount(0);
    await expect(duration.locator("option[value='45']")).toHaveCount(1);
    await duration.selectOption("120");
    await expect(start.locator("option[value='1380']")).toHaveCount(0);
    await expect(start.locator("option[value='1320']")).toHaveCount(1);
    await manual.getByLabel("预订日期", { exact: true }).fill(closedDate);
    await expect(start).toBeDisabled();
    await expect(add).toBeDisabled();
    await expect(manual).toContainText("当天不营业");
    await manual.getByLabel("预订日期", { exact: true }).fill("2026-10-10");
    await duration.selectOption("60");
    await expect(start.locator("option[value='570'],option[value='600'],option[value='660']")).toHaveCount(0);
    await expect(start.locator("option[value='540'],option[value='720']")).toHaveCount(2);
    await manual.getByLabel("预订日期", { exact: true }).fill(extendedDate);
    await start.selectOption("360");
    await add.click();
    await start.selectOption("1380");
    await add.click();
    await expect(page.locator(".tennis-selection")).toHaveCount(2);
    await expect(page.getByLabel("排场日期", { exact: true })).toHaveValue(today);
    await page.getByLabel("姓名", { exact: true }).fill(customer.nickname);
    await page.getByLabel("手机号", { exact: true }).fill("19900000001");
    const initialGeometry = await geometry(page);
    await page.screenshot({ path: `${out}/${name}-manual.png`, fullPage: true });

    await page.getByRole("button", { name: "核对场地与报价", exact: true }).click();
    await expect(page.getByRole("button", { name: "确认预订", exact: true })).toBeEnabled();
    await page.getByText("保留未付款预约", { exact: true }).click();
    await page.getByLabel("指定付款截止时间", { exact: true }).check();
    await page.getByLabel("付款截止（场馆时间）", { exact: true }).fill(`${today}T13:00`);
    await page.getByLabel("保留原因", { exact: true }).fill("合成浏览器验收");
    await page.getByRole("button", { name: "确认预订", exact: true }).click();
    await expect(page.getByText("网络断开了。请联网后先查看上次办理结果，避免重复提交。", { exact: true })).toBeVisible();
    const originalPending = await stored(page, pendingKey);
    const originalDraft = await stored(page, draftKey);
    expect(originalPending).toHaveLength(1);
    expect(JSON.parse(originalPending[0].payload)).toEqual({
      quoteId: quotes[0].quote.id, staffHold: confirmations[0].body.staffHold,
    });
    expect(originalPending[0].key).toBe(confirmations[0].body.commandKey);
    simulatedNow = afterExpiry;
    await page.clock.setFixedTime(afterExpiry);
    await page.reload();
    await expect(page.getByRole("button", { name: "确认预订", exact: true })).toBeDisabled();
    expect(await stored(page, pendingKey)).toEqual(originalPending);
    await page.getByRole("button", { name: /^核对并恢复预订/ }).click();
    await expect.poll(() => receiptReads).toBe(1);
    await expect.poll(() => stored(page, pendingKey)).toEqual([]);

    if (outcome === "expired") {
      await expect(page.getByText("原预订未建立，报价已过期。已保留客户和时段，请重新核价。", { exact: true })).toBeVisible();
      expect(confirmations).toHaveLength(2);
      expect(confirmations[1]).toEqual(confirmations[0]);
      const recovered = await stored(page, draftKey);
      expect(recovered.quote).toBeNull();
      expect(recovered.customer).toEqual(originalDraft.customer);
      expect(recovered.guest).toEqual(originalDraft.guest);
      expect(recovered.lines).toEqual(originalDraft.lines);
      await expect(page.locator(".tennis-selected-customer")).toContainText(customer.nickname);
      await expect(page.locator(".tennis-selection")).toHaveCount(2);
      const reQuote = page.getByRole("button", { name: "核对场地与报价", exact: true });
      await expect(reQuote).toBeEnabled();
      await page.screenshot({ path: `${out}/${name}-recovered.png`, fullPage: true });
      await reQuote.click();
      await expect(page.getByRole("button", { name: "确认预订", exact: true })).toBeEnabled();
      expect(quotes).toHaveLength(2);
      expect(quotes[1].body).toEqual(quotes[0].body);
      expect(customerWrites).toBe(1);
      expect(detailReads).toBe(0);
    } else {
      await expect(page.getByRole("dialog")).toContainText(customer.nickname);
      await expect(page.getByRole("dialog").locator("tbody tr")).toHaveCount(2);
      expect(confirmations).toHaveLength(1);
      expect(quotes).toHaveLength(1);
      expect(detailReads).toBe(1);
      expect((await stored(page, draftKey)).lines).toEqual([]);
      await page.screenshot({ path: `${out}/${name}-original-order.png`, fullPage: true });
    }
    const finalGeometry = await geometry(page);
    expect(pageErrors).toEqual([]);
    expect(unexpectedRequests).toEqual([]);
    // These are Chromium's expected resource diagnostics for the deliberate
    // aborted confirmation and authoritative 409; all app warnings/errors fail.
    const unexpectedConsole = consoleMessages.filter((message) => !(
      /\/api\/tennis\/quotes\/[^/]+\/confirm$/.test(message.url) &&
      (message.text === "Failed to load resource: net::ERR_FAILED" ||
        message.text === "Failed to load resource: the server responded with a status of 409 (Conflict)")
    ));
    expect(unexpectedConsole).toEqual([]);
    results.push({ name, status: "passed", initialGeometry, finalGeometry, confirmationRequests: confirmations,
      quoteRequests: quotes.map(({ body }) => body), receiptReads, customerWrites, detailReads, calls,
      pageErrors, consoleMessages, unexpectedRequests });
    console.log(`PASS ${name}: manual hours/minimum/closed day, persisted recovery, ${outcome === "expired" ? "original payload replay and requote" : "original order without confirmation replay"}, no layout/app errors`);
  } catch (error) {
    await page.screenshot({ path: `${out}/${name}-failure.png`, fullPage: true }).catch(() => {});
    const controls = await page.locator(".tennis-manual-selection").evaluateAll((elements) => elements.map((el) => el.outerHTML));
    results.push({ name, status: "failed", error: String(error), controls, calls, confirmations, pageErrors, consoleMessages, unexpectedRequests });
    throw error;
  } finally {
    await fs.writeFile(`${out}/browser-booking-recovery.json`, JSON.stringify(results, null, 2));
    await context.close();
  }
}

const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1440, 390]) {
    for (const outcome of ["expired", "receipt"]) await runScenario(browser, width, outcome);
  }
  console.log("ALL BOOKING RECOVERY SCENARIOS PASSED (synthetic API; desktop and emulated mobile only)");
} finally {
  await browser.close();
}
