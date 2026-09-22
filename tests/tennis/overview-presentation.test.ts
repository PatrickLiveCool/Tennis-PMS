import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OverviewPage } from "../../apps/web/src/tennis/OverviewPage";
import type { Session, VenueRecord } from "../../apps/web/src/tennis/types";

const { directory } = vi.hoisted(() => ({ directory: vi.fn() }));
vi.mock("../../apps/web/src/tennis/OrderDirectory", () => ({
  useOrderDirectory: directory,
  OrderPagination: () => null,
}));
const venue: VenueRecord = {
  id: "venue", tenantId: "tenant", name: "合成测试场馆", address: "", active: true,
  timezone: "Asia/Shanghai", openingHours: [], minimumBookingMinutes: 15, catalogRevision: 1,
};
const session: Session = {
  subjectId: "staff", displayName: "测试员工", tenantId: "tenant", kind: "staff", csrfToken: "synthetic",
  customerId: null, platformOperator: false, contextVersion: 1, permissions: ["read"], allVenues: true,
  venueIds: [], expiresAt: "2099-01-01T00:00:00Z", tenants: [{ id: "tenant", name: "测试商家", kind: "staff", role: "STAFF" }],
};
afterEach(() => vi.useRealTimers());

describe("overview appointment presentation", () => {
  it.each([
    ["2026-09-21T15:30:00Z", "2026-09-21T17:00:00Z", "09/21 23:30–09/22 01:00"],
    ["2026-09-22T15:30:00Z", "2026-09-22T17:00:00Z", "09/22 23:30–09/23 01:00"],
  ])("preserves the dates for a slot from %s to %s", (startAt, endAt, visibleInterval) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-22T04:00:00Z"));
    directory.mockReturnValue({
      data: {
        orders: [{
          id: "overnight-order", customerName: "跨日球友", status: "CONFIRMED", paymentStatus: "PAID",
          totalCents: 12000, holdUntil: null,
          matchingLines: [{ id: "overnight-line", courtName: "一号场", startAt, endAt }],
        }],
        nextCursor: null,
      },
      busy: false, error: undefined, refresh: vi.fn(), page: 1,
    });
    const html = renderToStaticMarkup(createElement(OverviewPage, {
      api: vi.fn(), session, venue, scope: "synthetic-overview", openOrder: vi.fn(),
    }));
    expect(html).toContain(visibleInterval);
  });
});
