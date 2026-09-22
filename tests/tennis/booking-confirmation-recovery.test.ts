// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TennisApiError, type TennisApi } from "../../apps/web/src/tennis/api";
import { RecoveryNotice, pendingCommands, type PendingCommand } from "../../apps/web/src/tennis/components";

const scope = "confirmation-recovery:staff:tenant:venue";
const pending: PendingCommand = {
  key: "original-confirmation-key", intent: "quote.confirm:original-quote",
  payload: JSON.stringify({ quoteId: "original-quote", staffHold: { until: "2099-09-23T15:00:00Z", reason: "原保留条件" } }),
  createdAt: "2026-09-23T00:00:00Z",
};
const draft = {
  customer: { id: "original-customer", nickname: "合成预订人" },
  lines: [{ courtId: "court-a", startAt: "2099-09-23T10:00:00Z", endAt: "2099-09-23T11:00:00Z" }],
  quote: { id: "original-quote", expiresAt: "2026-09-22T00:00:00Z" },
  staffHold: false, until: "2099-12-31T12:00", reason: "后来修改但不能重放的保留条件",
};
let container: HTMLDivElement;
let root: Root;
const api = vi.fn();
const openOrder = vi.fn();
const recovered = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  sessionStorage.clear();
  sessionStorage.setItem(`tennis:pending:${scope}`, JSON.stringify([pending]));
  sessionStorage.setItem(`tennis:booking:${scope}`, JSON.stringify(draft));
  window.addEventListener("tennis-booking-confirmation-recovered", recovered);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  window.removeEventListener("tennis-booking-confirmation-recovered", recovered);
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () => root.render(createElement(RecoveryNotice, { scope, api: api as TennisApi, openOrder })));
}
async function recover() {
  const button = [...container.querySelectorAll("button")].find((item) => item.textContent?.includes("核对并恢复预订"));
  expect(button).toBeDefined();
  await act(async () => button!.click());
}
function savedDraft() { return JSON.parse(sessionStorage.getItem(`tennis:booking:${scope}`)!); }
function missingReceiptThen(result: () => unknown) {
  api.mockImplementation(async (path: string, method = "GET") => {
    if (path === "/receipts/original-confirmation-key" && method === "GET") return null;
    if (path === "/quotes/original-quote/confirm" && method === "POST") return result();
    throw new Error(`Unexpected request ${method} ${path}`);
  });
}

describe("recovering an uncertain booking confirmation after reload", () => {
  it("replays the saved key and hold conditions before releasing an expired, unsubmitted booking", async () => {
    const unrelated = { ...pending, key: "payment-key", intent: "payment.create:order" };
    sessionStorage.setItem(`tennis:pending:${scope}`, JSON.stringify([pending, unrelated]));
    missingReceiptThen(() => { throw new TennisApiError("QUOTE_EXPIRED", 409); });
    await render();
    await recover();
    expect(api.mock.calls).toEqual([
      ["/receipts/original-confirmation-key"],
      ["/quotes/original-quote/confirm", "POST", {
        commandKey: pending.key,
        staffHold: { until: "2099-09-23T15:00:00Z", reason: "原保留条件" },
      }],
    ]);
    expect(pendingCommands(scope)).toEqual([unrelated]);
    expect(savedDraft()).toEqual({ ...draft, quote: null });
    expect(openOrder).not.toHaveBeenCalled();
    expect(container.textContent).toContain("原预订未建立，报价已过期");
    expect(recovered.mock.calls[0]![0].detail).toEqual({ scope, kind: "expired", quoteId: "original-quote" });
  });

  it("opens the original order from its receipt without confirming a second time", async () => {
    api.mockResolvedValue({ commandType: "quote.confirm", result: { orderId: "original-order" } });
    await render();
    await recover();
    expect(api).toHaveBeenCalledTimes(1);
    expect(openOrder).toHaveBeenCalledExactlyOnceWith("original-order");
    expect(pendingCommands(scope)).toEqual([]);
    expect(savedDraft()).toEqual({ ...draft, quote: null, lines: [], staffHold: false, until: "", reason: "" });
  });

  it("recovers a committed or still valid confirmation through the original request", async () => {
    missingReceiptThen(() => ({ id: "original-order" }));
    await render();
    await recover();
    expect(openOrder).toHaveBeenCalledExactlyOnceWith("original-order");
    expect(pendingCommands(scope)).toEqual([]);
  });

  it.each([
    new Error("Connection lost"),
    new TennisApiError("RESULT_UNKNOWN", 502),
    new TennisApiError("QUOTE_EXPIRED", 503),
    new TennisApiError("QUOTE_EXPIRED", 401),
    new TennisApiError("VENUE_ACCESS_DENIED", 403),
    new TennisApiError("IDEMPOTENCY_KEY_REUSED", 409),
    new TennisApiError("INVENTORY_CONFLICT", 409),
  ])("retains the pending booking and draft on inconclusive rejection %s", async (error) => {
    missingReceiptThen(() => { throw error; });
    await render();
    await recover();
    expect(pendingCommands(scope)).toEqual([pending]);
    expect(savedDraft()).toEqual(draft);
    expect(openOrder).not.toHaveBeenCalled();
    expect(recovered).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });

  it.each(["confirmed", "expired"])("preserves a later draft when the original result is %s", async (kind) => {
    const changed = { ...draft, quote: { id: "another-quote" } };
    sessionStorage.setItem(`tennis:booking:${scope}`, JSON.stringify(changed));
    missingReceiptThen(() => {
      if (kind === "expired") throw new TennisApiError("QUOTE_EXPIRED", 409);
      return { id: "original-order" };
    });
    await render();
    await recover();
    expect(savedDraft()).toEqual(changed);
    expect(pendingCommands(scope)).toEqual([]);
  });

  it.each(["{bad", JSON.stringify({ quoteId: "different-quote" }), JSON.stringify({ quoteId: "original-quote", staffHold: null })])(
    "does not replay or discard an incomplete stored request %s", async (payload) => {
      sessionStorage.setItem(`tennis:pending:${scope}`, JSON.stringify([{ ...pending, payload }]));
      api.mockResolvedValue(null);
      await render();
      await recover();
      expect(api).toHaveBeenCalledTimes(1);
      expect(pendingCommands(scope)).toHaveLength(1);
      expect(container.textContent).toContain("原预订内容不完整");
    },
  );

  it("keeps the command when the returned receipt belongs to a different operation", async () => {
    api.mockResolvedValue({ commandType: "payment.create", result: { orderId: "other-order" } });
    await render();
    await recover();
    expect(pendingCommands(scope)).toEqual([pending]);
    expect(openOrder).not.toHaveBeenCalled();
  });

  it("allows only one recovery while the original receipt query is pending", async () => {
    let finish!: (value: unknown) => void;
    api.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await render();
    const button = container.querySelector("button")!;
    await act(async () => { button.click(); button.click(); });
    expect(api).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);
    await act(async () => finish({ commandType: "quote.confirm", result: { orderId: "original-order" } }));
    expect(openOrder).toHaveBeenCalledExactlyOnceWith("original-order");
  });

  it("does not discard the command if the confirmation response lacks an order", async () => {
    missingReceiptThen(() => ({}));
    await render();
    await recover();
    expect(pendingCommands(scope)).toEqual([pending]);
    expect(openOrder).not.toHaveBeenCalled();
  });

  it("loads the latest corrected customer before clearing their pending operation", async () => {
    const correction = { ...pending, intent: "customer.contact.correct:customer-a" };
    const customer = { id: "customer-a", nickname: "合成客户", phone: "+8613900000001" };
    sessionStorage.setItem(`tennis:pending:${scope}`, JSON.stringify([correction]));
    api.mockImplementation(async (path: string) => path.startsWith("/receipts/")
      ? { commandType: "customer.contact.correct", result: { customerId: "customer-a" } }
      : customer);
    const listener = vi.fn();
    window.addEventListener("tennis-customer-contact-recovered", listener);
    try {
      await render();
      await act(async () => container.querySelector("button")!.click());
      expect(api.mock.calls).toEqual([["/receipts/original-confirmation-key"], ["/customers/customer-a"]]);
      expect(listener.mock.calls[0]![0].detail).toEqual({ scope, customer });
      expect(pendingCommands(scope)).toEqual([]);
      expect(container.textContent).toContain("手机号修改已完成");
    } finally {
      window.removeEventListener("tennis-customer-contact-recovered", listener);
    }
  });
});
