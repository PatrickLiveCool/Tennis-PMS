import { randomUUID } from "node:crypto";
import type pg from "pg";
import { TenantAccessError } from "./access.ts";
import { lockTenantTransactions } from "./transaction-locks.ts";

export type MerchantProvider = "MOCK" | "WECHAT";
/** Credential references identify server-managed secrets; they never contain certificate/key contents. */
export interface MerchantBinding {
  readonly id: string;
  readonly tenantId: string;
  readonly version: number;
  readonly provider: MerchantProvider;
  readonly merchantId: string;
  readonly appId: string | null;
  readonly credentialRef: string | null;
  readonly active: boolean;
  readonly createdBy: string | null;
  readonly createdAt: string;
}
export type MerchantBindingSnapshot = Pick<
  MerchantBinding,
  "id" | "tenantId" | "version" | "provider" | "merchantId" | "appId" | "credentialRef"
>;
export interface MerchantBindingInput {
  tenantId: string;
  provider: MerchantProvider;
  merchantId: string;
  appId?: string | null;
  credentialRef?: string | null;
  expectedVersion: number;
}
export class MerchantBindingError extends Error {
  constructor(
    readonly code: "INVALID_MERCHANT_BINDING" | "MERCHANT_BINDING_NOT_CONFIGURED" | "STALE_MERCHANT_BINDING",
  ) {
    super(code);
    this.name = "MerchantBindingError";
  }
}
type BindingRow = Omit<MerchantBinding, "createdAt"> & { createdAt: Date };
const columns = `id,tenant_id AS "tenantId",version,provider,merchant_id AS "merchantId",app_id AS "appId",credential_ref AS "credentialRef",active,created_by AS "createdBy",created_at AS "createdAt"`;
const snapshot = (row: BindingRow): MerchantBinding =>
  Object.freeze({ ...row, createdAt: row.createdAt.toISOString() });
const invalid = () => {
  throw new MerchantBindingError("INVALID_MERCHANT_BINDING");
};
function validText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\s\x00-\x1f\x7f]/u.test(value);
}
function providerValue(value: unknown): asserts value is MerchantProvider {
  if (value !== "MOCK" && value !== "WECHAT") invalid();
}
async function platform(tx: pg.PoolClient, subjectId: string): Promise<void> {
  if (
    (
      await tx.query("SELECT subject_id FROM tennis.platform_operators WHERE subject_id=$1 AND active FOR SHARE", [
        subjectId,
      ])
    ).rowCount !== 1
  )
    throw new TenantAccessError("TENANT_ACCESS_DENIED");
}
async function tenant(tx: pg.PoolClient, tenantId: string, requireActive = false): Promise<void> {
  if (!validText(tenantId, 200)) invalid();
  const row = (
    await tx.query<{ active: boolean }>("SELECT active FROM tennis.tenants WHERE id=$1 FOR SHARE", [tenantId])
  ).rows[0];
  if (!row) throw new TenantAccessError("RESOURCE_NOT_FOUND");
  if (requireActive && !row.active) throw new TenantAccessError("RESOURCE_UNAVAILABLE");
}
async function platformTransaction<T>(
  db: pg.Pool,
  subjectId: string,
  work: (tx: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const tx = await db.connect();
  try {
    await tx.query("BEGIN");
    await platform(tx, subjectId);
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
async function audit(tx: pg.PoolClient, subjectId: string, binding: MerchantBinding, action: string): Promise<void> {
  await tx.query(
    `INSERT INTO tennis.auth_audit_events(id,subject_id,tenant_id,action,resource_id,details) VALUES($1,$2,$3,$4,$5,$6::jsonb)`,
    [
      randomUUID(),
      subjectId,
      binding.tenantId,
      action,
      binding.id,
      JSON.stringify({ provider: binding.provider, version: binding.version, active: binding.active }),
    ],
  );
}
/** Platform-only configuration view. Tenant-facing payment records should expose no credential reference. */
export async function listMerchantBindings(
  db: pg.Pool,
  platformSubjectId: string,
  tenantId: string,
): Promise<MerchantBinding[]> {
  return platformTransaction(db, platformSubjectId, async (tx) => {
    await tenant(tx, tenantId);
    return (
      await tx.query<BindingRow>(
        `SELECT ${columns} FROM tennis.payment_merchant_bindings WHERE tenant_id=$1 ORDER BY provider,version DESC`,
        [tenantId],
      )
    ).rows.map(snapshot);
  });
}
/** expectedVersion is the latest version for this tenant/provider, or zero before the first binding. */
export async function saveMerchantBinding(
  db: pg.Pool,
  platformSubjectId: string,
  input: MerchantBindingInput,
): Promise<MerchantBinding> {
  providerValue(input.provider);
  if (
    !validText(input.merchantId, 200) ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 0 ||
    input.expectedVersion >= 2147483647 ||
    (input.appId != null && !validText(input.appId, 200)) ||
    (input.credentialRef != null && !validText(input.credentialRef, 500)) ||
    (input.provider === "WECHAT" && (input.appId == null || input.credentialRef == null))
  )
    invalid();
  return platformTransaction(db, platformSubjectId, async (tx) => {
    await lockTenantTransactions(tx, input.tenantId);
    await tenant(tx, input.tenantId);
    const latest =
      (
        await tx.query<{ version: number }>(
          `SELECT version FROM tennis.payment_merchant_bindings WHERE tenant_id=$1 AND provider=$2 ORDER BY version DESC LIMIT 1 FOR UPDATE`,
          [input.tenantId, input.provider],
        )
      ).rows[0]?.version ?? 0;
    if (latest !== input.expectedVersion) throw new MerchantBindingError("STALE_MERCHANT_BINDING");
    await tx.query(
      "UPDATE tennis.payment_merchant_bindings SET active=false WHERE tenant_id=$1 AND provider=$2 AND active",
      [input.tenantId, input.provider],
    );
    const result = snapshot(
      (
        await tx.query<BindingRow>(
          `INSERT INTO tennis.payment_merchant_bindings(id,tenant_id,version,provider,merchant_id,app_id,credential_ref,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${columns}`,
          [
            randomUUID(),
            input.tenantId,
            latest + 1,
            input.provider,
            input.merchantId,
            input.appId ?? null,
            input.credentialRef ?? null,
            platformSubjectId,
          ],
        )
      ).rows[0]!,
    );
    await audit(tx, platformSubjectId, result, "platform.merchant.create_version");
    return result;
  });
}
/** Disabling blocks new collection only. Historical transactions keep using their original binding. */
export async function disableMerchantBinding(
  db: pg.Pool,
  platformSubjectId: string,
  input: { tenantId: string; bindingId: string; expectedVersion: number },
): Promise<MerchantBinding> {
  if (!validText(input.bindingId, 200) || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1)
    invalid();
  return platformTransaction(db, platformSubjectId, async (tx) => {
    await lockTenantTransactions(tx, input.tenantId);
    await tenant(tx, input.tenantId);
    const existing = await getMerchantBinding(tx, input.tenantId, input.bindingId);
    if (existing.version !== input.expectedVersion) throw new MerchantBindingError("STALE_MERCHANT_BINDING");
    if (!existing.active) return existing;
    const result = snapshot(
      (
        await tx.query<BindingRow>(
          `UPDATE tennis.payment_merchant_bindings SET active=false WHERE tenant_id=$1 AND id=$2 RETURNING ${columns}`,
          [input.tenantId, input.bindingId],
        )
      ).rows[0]!,
    );
    await audit(tx, platformSubjectId, result, "platform.merchant.disable");
    return result;
  });
}
/** Internal historical lookup: authorization belongs to the transaction owning the referenced payment/refund. */
export async function getMerchantBinding(
  tx: pg.PoolClient,
  tenantId: string,
  bindingId: string,
): Promise<MerchantBinding> {
  const row = (
    await tx.query<BindingRow>(
      `SELECT ${columns} FROM tennis.payment_merchant_bindings WHERE tenant_id=$1 AND id=$2 FOR SHARE`,
      [tenantId, bindingId],
    )
  ).rows[0];
  if (!row) throw new TenantAccessError("RESOURCE_NOT_FOUND");
  return snapshot(row);
}
/** Call inside the payment transaction. Local defaults are persisted once; disabled bindings are never resurrected. */
export async function getActiveMerchantBinding(
  tx: pg.PoolClient,
  tenantId: string,
  provider: MerchantProvider,
  options: { allowLocalMockDefault: boolean },
): Promise<MerchantBinding> {
  providerValue(provider);
  await lockTenantTransactions(tx, tenantId);
  await tenant(tx, tenantId, true);
  const latest = (
    await tx.query<BindingRow>(
      `SELECT ${columns} FROM tennis.payment_merchant_bindings WHERE tenant_id=$1 AND provider=$2 ORDER BY active DESC,version DESC LIMIT 1 FOR SHARE`,
      [tenantId, provider],
    )
  ).rows[0];
  if (latest?.active) return snapshot(latest);
  if (latest || provider !== "MOCK" || options.allowLocalMockDefault !== true || process.env.NODE_ENV === "production")
    throw new MerchantBindingError("MERCHANT_BINDING_NOT_CONFIGURED");
  return snapshot(
    (
      await tx.query<BindingRow>(
        `INSERT INTO tennis.payment_merchant_bindings(id,tenant_id,version,provider,merchant_id)
    VALUES($1,$2,1,'MOCK',$3) RETURNING ${columns}`,
        [randomUUID(), tenantId, `mock:${tenantId}`],
      )
    ).rows[0]!,
  );
}
