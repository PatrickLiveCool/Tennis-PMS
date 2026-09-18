import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assertLocalTennisDatabaseUrl, localTennisTestDatabaseUrl } from "../../packages/db/src/tennis/local-config.ts";
import { migrateTennis } from "../../packages/db/src/tennis/migrate.ts";
import {
  disableMerchantBinding,
  getActiveMerchantBinding,
  getMerchantBinding,
  listMerchantBindings,
  saveMerchantBinding,
  type MerchantBindingInput,
  type MerchantProvider,
} from "../../packages/db/src/tennis/merchant-bindings.ts";
import { removeTenantFixture, seedTenantFixture, type TenantFixture } from "./tenant-fixture.ts";

const db = new pg.Pool({
  connectionString: assertLocalTennisDatabaseUrl(
    process.env.TENNIS_TEST_DATABASE_URL ?? localTennisTestDatabaseUrl,
    "test",
  ),
  max: 8,
  connectionTimeoutMillis: 5000,
  statement_timeout: 10000,
});
let first: TenantFixture, second: TenantFixture;
async function transaction<T>(work: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const tx = await db.connect();
  try {
    await tx.query("BEGIN");
    const result = await work(tx);
    await tx.query("COMMIT");
    return result;
  } catch (error) {
    await tx.query("ROLLBACK");
    throw error;
  } finally {
    tx.release();
  }
}
const input = (overrides: Partial<MerchantBindingInput> = {}): MerchantBindingInput => ({
  tenantId: first.actor.tenantId,
  provider: "WECHAT",
  merchantId: "test-merchant-a",
  appId: "test-app-a",
  credentialRef: "secrets/tennis/merchant-a/v1",
  expectedVersion: 0,
  ...overrides,
});
const save = (overrides: Partial<MerchantBindingInput> = {}) =>
  saveMerchantBinding(db, first.actor.subjectId, input(overrides));
const active = (provider: MerchantProvider = "MOCK", allowLocalMockDefault = true, tenantId = first.actor.tenantId) =>
  transaction((tx) => getActiveMerchantBinding(tx, tenantId, provider, { allowLocalMockDefault }));
const historical = (bindingId: string, tenantId = first.actor.tenantId) =>
  transaction((tx) => getMerchantBinding(tx, tenantId, bindingId));
beforeAll(async () => {
  const tx = await db.connect();
  try {
    await migrateTennis(tx);
  } finally {
    tx.release();
  }
});
beforeEach(async () => {
  first = await seedTenantFixture(db);
  second = await seedTenantFixture(db);
  await db.query("INSERT INTO tennis.platform_operators(subject_id) VALUES($1)", [first.actor.subjectId]);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  const tenants = [first.actor.tenantId, second.actor.tenantId];
  await db.query("DELETE FROM tennis.auth_audit_events WHERE tenant_id=ANY($1::text[])", [tenants]);
  await db.query("DELETE FROM tennis.payment_merchant_bindings WHERE tenant_id=ANY($1::text[])", [tenants]);
  await db.query("DELETE FROM tennis.platform_operators WHERE subject_id=$1", [first.actor.subjectId]);
  await removeTenantFixture(db, first);
  await removeTenantFixture(db, second);
});
afterAll(() => db.end());

describe("immutable tenant payment merchant bindings", () => {
  it("allows platform operators but denies tenant administrators configuration access", async () => {
    const binding = await save();
    await expect(listMerchantBindings(db, second.actor.subjectId, first.actor.tenantId)).rejects.toMatchObject({
      code: "TENANT_ACCESS_DENIED",
    });
    await expect(
      saveMerchantBinding(db, second.actor.subjectId, input({ tenantId: second.actor.tenantId })),
    ).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
    await expect(
      disableMerchantBinding(db, second.actor.subjectId, {
        tenantId: first.actor.tenantId,
        bindingId: binding.id,
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
    expect(await active("WECHAT", false)).toEqual(binding);
  });
  it("rechecks platform operator status on every configuration transaction", async () => {
    await save();
    await db.query("UPDATE tennis.platform_operators SET active=false WHERE subject_id=$1", [first.actor.subjectId]);
    await expect(listMerchantBindings(db, first.actor.subjectId, first.actor.tenantId)).rejects.toMatchObject({
      code: "TENANT_ACCESS_DENIED",
    });
    await expect(save({ expectedVersion: 1 })).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
  });
  it("persists one local default only when explicitly enabled", async () => {
    await expect(active("MOCK", false)).rejects.toMatchObject({ code: "MERCHANT_BINDING_NOT_CONFIGURED" });
    const binding = await active();
    expect(binding).toMatchObject({
      tenantId: first.actor.tenantId,
      provider: "MOCK",
      merchantId: `mock:${first.actor.tenantId}`,
      version: 1,
      active: true,
      appId: null,
      credentialRef: null,
      createdBy: null,
    });
    expect(Object.isFrozen(binding)).toBe(true);
    expect(await active("MOCK", false)).toEqual(binding);
    expect(await listMerchantBindings(db, first.actor.subjectId, first.actor.tenantId)).toHaveLength(1);
  });
  it("never synthesizes a real WeChat merchant", async () => {
    await expect(active("WECHAT", true)).rejects.toMatchObject({ code: "MERCHANT_BINDING_NOT_CONFIGURED" });
    expect(await listMerchantBindings(db, first.actor.subjectId, first.actor.tenantId)).toEqual([]);
  });
  it("does not create local defaults in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await expect(active()).rejects.toMatchObject({ code: "MERCHANT_BINDING_NOT_CONFIGURED" });
    expect(await listMerchantBindings(db, first.actor.subjectId, first.actor.tenantId)).toEqual([]);
  });
  it("disables new collection without reviving defaults or hiding historical bindings", async () => {
    const binding = await active();
    const disabled = await disableMerchantBinding(db, first.actor.subjectId, {
      tenantId: first.actor.tenantId,
      bindingId: binding.id,
      expectedVersion: 1,
    });
    expect(disabled.active).toBe(false);
    await expect(active()).rejects.toMatchObject({ code: "MERCHANT_BINDING_NOT_CONFIGURED" });
    expect(await historical(binding.id)).toEqual({ ...binding, active: false });
    expect(
      await disableMerchantBinding(db, first.actor.subjectId, {
        tenantId: first.actor.tenantId,
        bindingId: binding.id,
        expectedVersion: 1,
      }),
    ).toEqual(disabled);
    expect(await listMerchantBindings(db, first.actor.subjectId, first.actor.tenantId)).toHaveLength(1);
  });
  it("rotates the complete merchant snapshot while keeping old identity readable", async () => {
    const old = await save();
    const replacement = await save({
      expectedVersion: 1,
      merchantId: "test-merchant-b",
      appId: "test-app-b",
      credentialRef: "secrets/tennis/merchant-b/v2",
    });
    expect(replacement).toMatchObject({
      version: 2,
      merchantId: "test-merchant-b",
      appId: "test-app-b",
      credentialRef: "secrets/tennis/merchant-b/v2",
      active: true,
    });
    expect(replacement.id).not.toBe(old.id);
    expect(await historical(old.id)).toEqual({ ...old, active: false });
    expect(await active("WECHAT", false)).toEqual(replacement);
    expect(
      (await listMerchantBindings(db, first.actor.subjectId, first.actor.tenantId)).map((row) => row.version),
    ).toEqual([2, 1]);
  });
  it("serializes concurrent rotations and rejects stale configuration without a partial disable", async () => {
    const old = await save();
    const results = await Promise.allSettled([
      save({ expectedVersion: 1, merchantId: "test-merchant-b" }),
      save({ expectedVersion: 1, merchantId: "test-merchant-c" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ status: "rejected", reason: { code: "STALE_MERCHANT_BINDING" } });
    const all = await listMerchantBindings(db, first.actor.subjectId, first.actor.tenantId);
    expect(all).toHaveLength(2);
    expect(all.filter((row) => row.active)).toHaveLength(1);
    expect(await historical(old.id)).toMatchObject({ active: false, merchantId: "test-merchant-a" });
  });
  it("creates a single persistent default under concurrent first payments", async () => {
    const results = await Promise.all([active(), active(), active()]);
    expect(new Set(results.map((row) => row.id)).size).toBe(1);
    expect(await listMerchantBindings(db, first.actor.subjectId, first.actor.tenantId)).toHaveLength(1);
  });
  it("isolates merchant reads and disable actions by tenant and versions by provider", async () => {
    const mock = await active(),
      wechat = await save(),
      other = await active("MOCK", true, second.actor.tenantId);
    expect(mock.version).toBe(1);
    expect(wechat.version).toBe(1);
    expect(other.id).not.toBe(mock.id);
    expect(other.merchantId).not.toBe(mock.merchantId);
    await expect(historical(mock.id, second.actor.tenantId)).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    await expect(
      disableMerchantBinding(db, first.actor.subjectId, {
        tenantId: second.actor.tenantId,
        bindingId: mock.id,
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    expect((await active()).active).toBe(true);
  });
  it("enforces snapshot immutability and prohibits reactivation at the database boundary", async () => {
    const binding = await save();
    await expect(
      db.query("UPDATE tennis.payment_merchant_bindings SET merchant_id='changed' WHERE id=$1", [binding.id]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      db.query("UPDATE tennis.payment_merchant_bindings SET credential_ref='changed' WHERE id=$1", [binding.id]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      db.query("UPDATE tennis.payment_merchant_bindings SET version=2 WHERE id=$1", [binding.id]),
    ).rejects.toMatchObject({ code: "23514" });
    await disableMerchantBinding(db, first.actor.subjectId, {
      tenantId: first.actor.tenantId,
      bindingId: binding.id,
      expectedVersion: 1,
    });
    await expect(
      db.query("UPDATE tennis.payment_merchant_bindings SET active=true WHERE id=$1", [binding.id]),
    ).rejects.toMatchObject({ code: "23514" });
    expect(await historical(binding.id)).toEqual({ ...binding, active: false });
  });
  it("keeps the active merchant when a later inactive legacy snapshot is appended", async () => {
    const binding = await active();
    await db.query(
      `INSERT INTO tennis.payment_merchant_bindings(id,tenant_id,version,provider,merchant_id,active)
      VALUES($1,$2,2,'MOCK','mock:historical-only',false)`,
      [`legacy:${binding.id}`, first.actor.tenantId],
    );
    expect(await active()).toEqual(binding);
    expect(await historical(`legacy:${binding.id}`)).toMatchObject({
      active: false,
      version: 2,
      merchantId: "mock:historical-only",
    });
  });
  it("rolls local default creation back with its owning payment transaction", async () => {
    await expect(
      transaction(async (tx) => {
        await getActiveMerchantBinding(tx, first.actor.tenantId, "MOCK", { allowLocalMockDefault: true });
        throw new Error("synthetic payment rollback");
      }),
    ).rejects.toThrow("synthetic payment rollback");
    expect(await listMerchantBindings(db, first.actor.subjectId, first.actor.tenantId)).toEqual([]);
  });
  it("requires complete real merchant references and rejects accidental certificate content", async () => {
    for (const invalid of [
      { appId: null },
      { credentialRef: null },
      { credentialRef: "-----BEGIN PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----" },
      { merchantId: "test merchant" },
      { expectedVersion: -1 },
    ]) {
      await expect(save(invalid)).rejects.toMatchObject({ code: "INVALID_MERCHANT_BINDING" });
    }
    expect(await listMerchantBindings(db, first.actor.subjectId, first.actor.tenantId)).toEqual([]);
  });
  it("blocks new collection for a suspended tenant while preserving historical settlement lookup", async () => {
    const binding = await save();
    await db.query("UPDATE tennis.tenants SET active=false WHERE id=$1", [first.actor.tenantId]);
    await expect(active("WECHAT", false)).rejects.toMatchObject({ code: "RESOURCE_UNAVAILABLE" });
    expect(await historical(binding.id)).toEqual(binding);
  });
  it("refuses stale disable commands and records only non-secret configuration audit facts", async () => {
    const binding = await save();
    await expect(
      disableMerchantBinding(db, first.actor.subjectId, {
        tenantId: first.actor.tenantId,
        bindingId: binding.id,
        expectedVersion: 2,
      }),
    ).rejects.toMatchObject({ code: "STALE_MERCHANT_BINDING" });
    expect((await active("WECHAT", false)).active).toBe(true);
    const audits = (
      await db.query(
        "SELECT action,resource_id,details FROM tennis.auth_audit_events WHERE tenant_id=$1 ORDER BY created_at",
        [first.actor.tenantId],
      )
    ).rows;
    expect(audits).toEqual([
      {
        action: "platform.merchant.create_version",
        resource_id: binding.id,
        details: { provider: "WECHAT", version: 1, active: true },
      },
    ]);
  });
});
