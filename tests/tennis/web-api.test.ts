import { afterEach, describe, expect, it, vi } from "vitest";
import { createApi, TennisApiError } from "../../apps/web/src/tennis/api.ts";

afterEach(() => vi.unstubAllGlobals());

describe("browser API transaction response recovery", () => {
  it("treats a committed POST with truncated JSON as unknown, preserving the command key on retry", async () => {
    const body = { commandKey: "topup-command-original" };
    const committed = new Map<string, { id: string; status: string }>();
    let requests = 0;
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body)) as typeof body;
      committed.set(
        request.commandKey,
        committed.get(request.commandKey) ?? { id: "topup-original", status: "PENDING" },
      );
      requests++;
      return requests === 1
        ? new Response('{"id":"topup-original",', { status: 200, headers: { "Content-Type": "application/json" } })
        : Response.json(committed.get(request.commandKey));
    });
    vi.stubGlobal("fetch", fetch);
    const api = createApi();
    const first = await api("/topup-quotes/quote-original/confirm", "POST", body).catch((error) => error);
    expect(first).toBeInstanceOf(TennisApiError);
    expect(first).toMatchObject({ code: "RESULT_UNKNOWN", uncertain: true });
    expect(committed.size).toBe(1);
    expect(await api("/topup-quotes/quote-original/confirm", "POST", body)).toEqual({
      id: "topup-original",
      status: "PENDING",
    });
    expect(committed.size).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(["", "null"])("does not accept an empty write acknowledgement (%j)", async (responseBody) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(responseBody, { status: 200 })),
    );
    await expect(createApi()("/orders/order/refunds", "POST", { commandKey: "refund-command" })).rejects.toMatchObject({
      code: "RESULT_UNKNOWN",
      uncertain: true,
    });
  });

  it("preserves a legitimate missing receipt and a definitive business rejection", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json(null))
        .mockResolvedValueOnce(Response.json({ error: { code: "INSUFFICIENT_BALANCE" } }, { status: 409 })),
    );
    expect(await createApi()("/receipts/missing")).toBeNull();
    await expect(
      createApi()("/orders/order/payments", "POST", { walletCents: 100, commandKey: "payment-command" }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_BALANCE", uncertain: false });
  });
});
