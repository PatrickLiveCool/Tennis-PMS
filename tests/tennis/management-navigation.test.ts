import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canManageTenant, ManagementPage } from "../../apps/web/src/tennis/ManagementPage";
import type { Session } from "../../apps/web/src/tennis/types";

const { staffPanel, gatewayPanel, agentAccessPanel } = vi.hoisted(() => ({
  staffPanel: vi.fn((_props: unknown) => null),
  gatewayPanel: vi.fn((_props: unknown) => null),
  agentAccessPanel: vi.fn((_props: unknown) => null),
}));
vi.mock("../../apps/web/src/tennis/StaffPanel", () => ({ StaffPanel: staffPanel }));
vi.mock("../../apps/web/src/tennis/GatewayPanel", () => ({ TenantGatewayPanel: gatewayPanel, TenantAgentAccessPanel: agentAccessPanel }));

const admin: Session = {
  subjectId: "operator", displayName: "合成管理员", csrfToken: "synthetic", tenantId: "current-tenant",
  kind: "staff", platformOperator: false, contextVersion: 7, permissions: [], allVenues: true,
  venueIds: [], customerId: null, expiresAt: "2099-01-01T00:00:00Z",
  tenants: [{ id: "current-tenant", name: "当前商家", kind: "staff", role: "ADMIN" }],
};
const legacyScope = "operator:staff:current-tenant:7";
let stored: Map<string, string>;
beforeEach(() => {
  vi.clearAllMocks();
  stored = new Map();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("tenant management access and restored navigation", () => {
  it.each<[string, Session]>([
    ["ordinary staff with business-management permissions", {
      ...admin, permissions: ["read", "manage_assets", "manage_members"],
      tenants: [{ id: "current-tenant", name: "当前商家", kind: "staff", role: "STAFF" }],
    }],
    ["customer context even with a staff-admin membership", { ...admin, kind: "customer", customerId: "customer" }],
    ["platform context", { ...admin, kind: "platform", platformOperator: true }],
    ["revoked workspace context", { ...admin, contextValid: false }],
    ["admin of another tenant", {
      ...admin,
      tenants: [
        { id: "current-tenant", name: "当前商家", kind: "staff", role: "VIEWER" },
        { id: "other-tenant", name: "其他商家", kind: "staff", role: "ADMIN" },
      ],
    }],
    ["customer-only membership in the current tenant", {
      ...admin, tenants: [{ id: "current-tenant", name: "当前商家", kind: "customer", role: "ADMIN" }],
    }],
    ["no selected tenant", { ...admin, tenantId: null }],
  ])("does not mount either management panel for %s", (_label, session) => {
    // A remembered administrator tab must not bypass the new page's own gate.
    stored.set(`tennis:management-tab:${legacyScope}`, JSON.stringify("gateway"));
    expect(canManageTenant(session)).toBe(false);
    const html = renderToStaticMarkup(createElement(ManagementPage, { api: vi.fn(), session }));
    expect(html).toContain("仅管理员可访问系统管理");
    expect(staffPanel).not.toHaveBeenCalled();
    expect(gatewayPanel).not.toHaveBeenCalled();
    expect(agentAccessPanel).not.toHaveBeenCalled();
  });

  it("opens staff management for the current tenant admin without requiring a venue", () => {
    expect(canManageTenant(admin)).toBe(true);
    const html = renderToStaticMarkup(createElement(ManagementPage, { api: vi.fn(), session: admin }));
    expect(html).toContain("系统管理");
    expect(staffPanel).toHaveBeenCalledOnce();
    expect(gatewayPanel).not.toHaveBeenCalled();
  });

  it("restores the binding tab and preserves the existing tenant draft and pending scope", () => {
    const api = vi.fn();
    stored.set(`tennis:management-tab:${legacyScope}`, JSON.stringify("gateway"));
    renderToStaticMarkup(createElement(ManagementPage, { api, session: admin }));
    expect(staffPanel).not.toHaveBeenCalled();
    expect(gatewayPanel).toHaveBeenCalledOnce();
    expect(gatewayPanel.mock.calls[0]?.[0]).toEqual({ api, scope: legacyScope });
  });

  it("restores the agent access tab within the current administrator workspace", () => {
    const api = vi.fn();
    stored.set(`tennis:management-tab:${legacyScope}`, JSON.stringify("agent-access"));
    renderToStaticMarkup(createElement(ManagementPage, { api, session: admin }));
    expect(staffPanel).not.toHaveBeenCalled();
    expect(gatewayPanel).not.toHaveBeenCalled();
    expect(agentAccessPanel).toHaveBeenCalledOnce();
    expect(agentAccessPanel.mock.calls[0]?.[0]).toEqual({ api, scope: legacyScope });
  });
});
