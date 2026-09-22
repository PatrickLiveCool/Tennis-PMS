import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { TennisApiError } from "../../apps/web/src/tennis/api.ts";
import { pendingCommands, useCommand } from "../../apps/web/src/tennis/components.tsx";

const scope = "synthetic-command-recovery";
const contact = { customerId: "synthetic-original-customer", phone: "13900000001" };

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  vi.stubGlobal("window", new EventTarget());
});
afterEach(() => vi.unstubAllGlobals());

// Capture the real hook without mounting a browser; assertions cover its command
// key, persisted pending state and work callback, independent of React rendering.
function command() {
  let captured: ReturnType<typeof useCommand> | undefined;
  function Capture() {
    captured = useCommand(scope);
    return null;
  }
  renderToStaticMarkup(createElement(Capture));
  return captured!;
}

describe("booking customer command recovery", () => {
  it.each(["PHONE_ALREADY_EXISTS", "BOOKING_PHONE_ALREADY_SET"])(
    "unlocks a failed contact draft when its original retry definitively returns %s",
    async (code) => {
      const recovery = command();
      const first = vi.fn(async () => { throw new Error("Connection lost before submission"); });
      await recovery.execute("booking.customer", contact, first);
      const original = pendingCommands(scope)[0]!;
      expect(original.payload).toBe(JSON.stringify(contact));

      const retry = vi.fn(async () => { throw new TennisApiError(code, 409); });
      await recovery.execute("booking.customer", contact, retry);
      expect(first).toHaveBeenCalledWith(original.key);
      expect(retry).toHaveBeenCalledWith(original.key);
      expect(pendingCommands(scope)).toEqual([]);

      const corrected = vi.fn(async (_key: string) => ({ customerId: contact.customerId }));
      await recovery.execute("booking.customer", { ...contact, phone: "13900000002" }, corrected);
      expect(corrected).toHaveBeenCalledTimes(1);
      expect(corrected.mock.calls[0]?.[0]).not.toBe(original.key);
    },
  );

  it("keeps the original key after a committed response is lost and recovers the original customer", async () => {
    const recovery = command();
    const committed = new Map<string, { customerId: string }>();
    const create = vi.fn(async (key: string) => {
      committed.set(key, { customerId: contact.customerId });
      throw new TennisApiError("RESULT_UNKNOWN", 502);
    });
    await recovery.execute("booking.customer", contact, create);
    const original = pendingCommands(scope)[0]!;

    // A changed input cannot replace the original uncertain operation.
    const changed = vi.fn(async () => ({ customerId: "unexpected" }));
    await recovery.execute("booking.customer", { ...contact, phone: "13900000002" }, changed);
    expect(changed).not.toHaveBeenCalled();
    expect(pendingCommands(scope)).toEqual([original]);

    const recovered = await recovery.execute("booking.customer", contact, async (key) => committed.get(key));
    expect(recovered).toEqual({ customerId: contact.customerId });
    expect(committed.size).toBe(1);
    expect(pendingCommands(scope)).toEqual([]);
  });

  it.each([
    new Error("Connection interrupted"),
    new TennisApiError("RESULT_UNKNOWN", 502),
    new TennisApiError("PHONE_ALREADY_EXISTS", 503),
    new TennisApiError("PHONE_ALREADY_EXISTS", 401),
    new TennisApiError("TENANT_ACCESS_DENIED", 403),
    new TennisApiError("INVALID_CUSTOMER", 409),
    new TennisApiError("IDEMPOTENCY_KEY_REUSED", 409),
  ])("retains pending contact recovery for an inconclusive or unrelated rejection: %s", async (error) => {
    const recovery = command();
    await recovery.execute("booking.customer", contact, async () => { throw new Error("Connection lost"); });
    const original = pendingCommands(scope)[0]!;
    await recovery.execute("booking.customer", contact, async () => { throw error; });
    expect(pendingCommands(scope)).toEqual([original]);
  });

  it.each(["quote.confirm:original", "payment.create:original", "refund.create:original", "topup.confirm:original"])(
    "does not release an uncertain %s command on a phone-related rejection",
    async (intent) => {
      const recovery = command();
      const payload = { recordId: "synthetic-original" };
      await recovery.execute(intent, payload, async () => { throw new TennisApiError("RESULT_UNKNOWN", 502); });
      const original = pendingCommands(scope)[0]!;
      await recovery.execute(intent, payload, async () => { throw new TennisApiError("PHONE_ALREADY_EXISTS", 409); });
      expect(pendingCommands(scope)).toEqual([original]);
    },
  );
});
