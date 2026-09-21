import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import type pg from "pg";
import { recordTenantAudit, TenantAccessError, type TenantActor, type TenantPermission } from "./access.ts";
import type { BookingActor } from "./customers.ts";
import { lockTenantTransactions } from "./transaction-locks.ts";

export type SessionKind = "staff" | "customer" | "platform";
export type StaffRole = "ADMIN" | "STAFF" | "VIEWER";
const permissions: TenantPermission[] = [
  "read",
  "book",
  "manage_assets",
  "manage_prices",
  "refund",
  "hold_unpaid",
  "manage_members",
];
export interface SessionTenant {
  id: string;
  name: string;
  kind: "staff" | "customer";
  role?: StaffRole;
}
export interface SessionView {
  subjectId: string;
  displayName: string;
  csrfToken: string;
  tenantId: string | null;
  kind: SessionKind;
  platformOperator: boolean;
  tenants: SessionTenant[];
  contextVersion: number;
  contextValid: boolean;
  expiresAt: string;
  permissions: TenantPermission[];
  allVenues: boolean;
  venueIds: string[];
  customerId: string | null;
}
export interface AuthContext extends SessionView {
  sessionId: string;
  actor: BookingActor | null;
}
export interface AccountInput {
  username: string;
  password: string;
  displayName: string;
  platformOperator?: boolean;
  tenantId?: string;
  role?: StaffRole;
  permissions?: TenantPermission[];
  venueIds?: string[];
  allVenues?: boolean;
  customerId?: string;
}
export interface StaffInput {
  role: StaffRole;
  permissions: TenantPermission[];
  allVenues: boolean;
  venueIds: string[];
  active: boolean;
}
export interface StaffView extends StaffInput {
  subjectId: string;
  username: string | null;
  displayName: string;
  accountActive: boolean;
}
export class TennisAuthError extends Error {
  constructor(
    readonly code:
      | "INVALID_CREDENTIALS"
      | "SESSION_EXPIRED"
      | "AUTH_CONTEXT_REVOKED"
      | "INVALID_ACCOUNT"
      | "USERNAME_ALREADY_EXISTS"
      | "INVALID_STAFF_GRANT"
      | "LAST_TENANT_ADMIN"
      | "PLATFORM_ACCESS_DENIED"
      | "INVALID_TENANT_STATUS"
      | "STALE_TENANT_STATUS",
  ) {
    super(code);
    this.name = "TennisAuthError";
  }
}
interface SessionRow {
  id: string;
  subject_id: string;
  tenant_id: string | null;
  kind: SessionKind;
  csrf_token: string;
  context_version: number;
  expires_at: Date;
  display_name: string;
}
interface GrantRow {
  id: string;
  name: string;
  role: StaffRole;
  permissions: TenantPermission[];
  all_venues: boolean;
}
function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
function secret(): string {
  return randomBytes(32).toString("base64url");
}
function username(value: string): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._@+\-]{2,99}$/.test(value.trim()))
    throw new TennisAuthError("INVALID_ACCOUNT");
  return value.trim().toLowerCase();
}
function validatePassword(password: string): void {
  if (typeof password !== "string" || password.length < 12 || password.length > 256)
    throw new TennisAuthError("INVALID_ACCOUNT");
}
function validateDisplayName(value: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200) throw new TennisAuthError("INVALID_ACCOUNT");
  return value.trim();
}
async function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCallback(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, result) =>
      error ? reject(error) : resolve(result),
    ),
  );
}
async function passwordHash(password: string): Promise<string> {
  validatePassword(password);
  const salt = randomBytes(16);
  return `scrypt$32768$8$1$${salt.toString("hex")}$${(await derive(password, salt)).toString("hex")}`;
}
const dummyHash = `scrypt$32768$8$1$${"00".repeat(16)}$${"00".repeat(64)}`;
async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const fields = stored.split("$");
  if (
    fields.length !== 6 ||
    fields.slice(0, 4).join("$") !== "scrypt$32768$8$1" ||
    !/^[0-9a-f]{32}$/.test(fields[4]!) ||
    !/^[0-9a-f]{128}$/.test(fields[5]!)
  )
    return false;
  const actual = await derive(password, Buffer.from(fields[4]!, "hex"));
  return timingSafeEqual(actual, Buffer.from(fields[5]!, "hex"));
}
async function transaction<T>(pool: pg.Pool, work: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    const value = await work(tx);
    await tx.query("COMMIT");
    return value;
  } catch (error) {
    await tx.query("ROLLBACK");
    throw error;
  } finally {
    tx.release();
  }
}
async function audit(
  tx: pg.PoolClient,
  subjectId: string | null,
  tenantId: string | null,
  action: string,
  resourceId: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  await tx.query(
    "INSERT INTO tennis.auth_audit_events (id,subject_id,tenant_id,action,resource_id,details) VALUES ($1,$2,$3,$4,$5,$6::jsonb)",
    [randomUUID(), subjectId, tenantId, action, resourceId, JSON.stringify(details)],
  );
}
function sessionView(context: AuthContext): SessionView {
  const { sessionId: _sessionId, actor: _actor, ...view } = context;
  return view;
}
async function sessionRow(tx: pg.PoolClient, token: string, update = false): Promise<SessionRow> {
  if (typeof token !== "string" || !/^[a-zA-Z0-9_-]{43}$/.test(token)) throw new TennisAuthError("SESSION_EXPIRED");
  const result = await tx.query<SessionRow>(
    `SELECT s.*,p.display_name FROM tennis.auth_sessions s
    JOIN tennis.local_accounts a ON a.subject_id=s.subject_id JOIN tennis.subjects p ON p.id=s.subject_id
    WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND a.active
    FOR ${update ? "UPDATE" : "SHARE"} OF s FOR SHARE OF a`,
    [tokenHash(token)],
  );
  if (!result.rows[0]) throw new TennisAuthError("SESSION_EXPIRED");
  return result.rows[0];
}
/** Read a fresh permission snapshot; business commands revalidate grants in their own transaction. */
async function context(tx: pg.PoolClient, row: SessionRow, permitRevokedContext = false): Promise<AuthContext> {
  const platformOperator =
    (
      await tx.query("SELECT subject_id FROM tennis.platform_operators WHERE subject_id=$1 AND active", [
        row.subject_id,
      ])
    ).rowCount === 1;
  const grants = (
    await tx.query<GrantRow>(
      `SELECT t.id,t.name,m.role,m.permissions,m.all_venues FROM tennis.tenant_memberships m
    JOIN tennis.tenants t ON t.id=m.tenant_id WHERE m.subject_id=$1 AND m.active AND t.active
    AND (m.role='ADMIN' OR 'read'=ANY(m.permissions)) ORDER BY t.name,t.id`,
      [row.subject_id],
    )
  ).rows;
  const customers = (
    await tx.query<{ id: string; name: string; customer_id: string }>(
      `SELECT t.id,t.name,c.id AS customer_id
    FROM tennis.customers c JOIN tennis.tenants t ON t.id=c.tenant_id WHERE c.subject_id=$1 AND c.active AND t.active
    ORDER BY t.name,t.id`,
      [row.subject_id],
    )
  ).rows;
  const tenants: SessionTenant[] = [
    ...grants.map((grant) => ({ id: grant.id, name: grant.name, kind: "staff" as const, role: grant.role })),
    ...customers.map((customer) => ({ id: customer.id, name: customer.name, kind: "customer" as const })),
  ];
  const currentGrant = grants.find((grant) => grant.id === row.tenant_id);
  const currentCustomer = customers.find((customer) => customer.id === row.tenant_id);
  const contextValid =
    row.kind === "platform" ? platformOperator : row.kind === "staff" ? !!currentGrant : !!currentCustomer;
  if (!contextValid && !permitRevokedContext) throw new TennisAuthError("AUTH_CONTEXT_REVOKED");
  const actor: BookingActor | null =
    !contextValid || row.kind === "platform"
      ? null
      : row.kind === "customer"
        ? {
            subjectId: row.subject_id,
            tenantId: row.tenant_id!,
            kind: "customer",
            customerId: currentCustomer!.customer_id,
          }
        : { subjectId: row.subject_id, tenantId: row.tenant_id! };
  const scopedVenues =
    contextValid && row.kind === "staff"
      ? (
          await tx.query<{ venue_id: string }>(
            `SELECT venue_id FROM tennis.membership_venues
    WHERE tenant_id=$1 AND subject_id=$2 ORDER BY venue_id`,
            [row.tenant_id, row.subject_id],
          )
        ).rows.map((item) => item.venue_id)
      : [];
  return {
    sessionId: row.id,
    subjectId: row.subject_id,
    displayName: row.display_name,
    csrfToken: row.csrf_token,
    tenantId: row.tenant_id,
    kind: row.kind,
    platformOperator,
    tenants,
    contextVersion: row.context_version,
    contextValid,
    expiresAt: row.expires_at.toISOString(),
    actor,
    permissions:
      contextValid && row.kind === "staff"
        ? currentGrant!.role === "ADMIN"
          ? [...permissions]
          : currentGrant!.role === "VIEWER"
            ? ["read"]
            : currentGrant!.permissions
        : [],
    allVenues:
      contextValid &&
      (row.kind === "customer" ||
        (row.kind === "staff" && (currentGrant!.role === "ADMIN" || currentGrant!.all_venues))),
    venueIds: scopedVenues,
    customerId: contextValid && row.kind === "customer" ? currentCustomer!.customer_id : null,
  };
}

/** Http callers must also rate limit by source IP. All credential failures use one response. */
export async function login(
  pool: pg.Pool,
  input: { username: string; password: string },
): Promise<{ token: string; csrfToken: string; session: SessionView }> {
  let normalized: string;
  try {
    normalized = username(input.username);
  } catch {
    normalized = "";
  }
  const safePassword = typeof input.password === "string" && input.password.length <= 256 ? input.password : "";
  const result = await transaction(pool, async (tx) => {
    const account = (
      await tx.query<{ subject_id: string; password_hash: string; active: boolean; blocked: boolean }>(
        `SELECT subject_id,password_hash,active,
      coalesce(locked_until>clock_timestamp(),false) AS blocked FROM tennis.local_accounts WHERE username=$1 FOR UPDATE`,
        [normalized],
      )
    ).rows[0];
    const valid = await verifyPassword(safePassword, account?.password_hash ?? dummyHash);
    if (!account || !account.active || account.blocked || !valid) {
      if (account && !account.blocked) {
        await tx.query(
          `UPDATE tennis.local_accounts SET
          failed_attempts=CASE WHEN failure_started_at IS NULL OR failure_started_at<clock_timestamp()-interval '15 minutes' THEN 1 ELSE failed_attempts+1 END,
          locked_until=CASE WHEN failure_started_at>=clock_timestamp()-interval '15 minutes' AND failed_attempts>=9 THEN clock_timestamp()+interval '5 minutes' ELSE NULL END,
          failure_started_at=CASE WHEN failure_started_at IS NULL OR failure_started_at<clock_timestamp()-interval '15 minutes' THEN clock_timestamp() ELSE failure_started_at END
          WHERE subject_id=$1`,
          [account.subject_id],
        );
        await audit(tx, account.subject_id, null, "auth.login.failed", account.subject_id);
      }
      return null;
    }
    const choices = (
      await tx.query<{ tenant_id: string | null; kind: SessionKind }>(
        `SELECT NULL::text AS tenant_id,'platform'::text AS kind,0 AS priority
      FROM tennis.platform_operators WHERE subject_id=$1 AND active UNION ALL
      SELECT m.tenant_id,'staff',1 FROM tennis.tenant_memberships m JOIN tennis.tenants t ON t.id=m.tenant_id
      WHERE m.subject_id=$1 AND m.active AND t.active AND (m.role='ADMIN' OR 'read'=ANY(m.permissions)) UNION ALL
      SELECT c.tenant_id,'customer',2 FROM tennis.customers c JOIN tennis.tenants t ON t.id=c.tenant_id
      WHERE c.subject_id=$1 AND c.active AND t.active ORDER BY priority,tenant_id LIMIT 1`,
        [account.subject_id],
      )
    ).rows;
    if (!choices[0]) return null;
    await tx.query(
      "UPDATE tennis.local_accounts SET failed_attempts=0,failure_started_at=NULL,locked_until=NULL WHERE subject_id=$1",
      [account.subject_id],
    );
    const token = secret();
    const csrfToken = secret();
    const id = randomUUID();
    await tx.query(
      `INSERT INTO tennis.auth_sessions (id,token_hash,subject_id,tenant_id,kind,csrf_token,expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,clock_timestamp()+interval '12 hours')`,
      [id, tokenHash(token), account.subject_id, choices[0].tenant_id, choices[0].kind, csrfToken],
    );
    const session = sessionView(await context(tx, await sessionRow(tx, token)));
    await audit(tx, account.subject_id, choices[0].tenant_id, "auth.login", id);
    return { token, csrfToken, session };
  });
  if (!result) throw new TennisAuthError("INVALID_CREDENTIALS");
  return result;
}
export async function authenticate(pool: pg.Pool, token: string): Promise<AuthContext> {
  return transaction(pool, async (tx) => context(tx, await sessionRow(tx, token)));
}
/** Only use for session display, context switching and logout; a revoked context has no business actor. */
export async function authenticateForContextSelection(pool: pg.Pool, token: string): Promise<AuthContext> {
  return transaction(pool, async (tx) => context(tx, await sessionRow(tx, token), true));
}
export async function selectSessionContext(
  pool: pg.Pool,
  token: string,
  selection: { tenantId: string | null; kind: SessionKind },
): Promise<SessionView> {
  if (
    !["staff", "customer", "platform"].includes(selection.kind) ||
    (selection.kind === "platform") !== (selection.tenantId === null)
  )
    throw new TennisAuthError("AUTH_CONTEXT_REVOKED");
  return transaction(pool, async (tx) => {
    const row = await sessionRow(tx, token, true);
    const target = {
      ...row,
      tenant_id: selection.tenantId,
      kind: selection.kind,
      csrf_token: secret(),
      context_version: row.context_version + 1,
    };
    const verified = await context(tx, target);
    await tx.query(
      "UPDATE tennis.auth_sessions SET tenant_id=$2,kind=$3,csrf_token=$4,context_version=$5 WHERE id=$1",
      [row.id, target.tenant_id, target.kind, target.csrf_token, target.context_version],
    );
    await audit(tx, row.subject_id, target.tenant_id, "auth.context.select", row.id, {
      kind: target.kind,
      contextVersion: target.context_version,
    });
    return sessionView(verified);
  });
}
export async function logout(pool: pg.Pool, token: string): Promise<void> {
  if (typeof token !== "string" || !/^[a-zA-Z0-9_-]{43}$/.test(token)) return;
  await transaction(pool, async (tx) => {
    const rows = (
      await tx.query<{ id: string; subject_id: string; tenant_id: string | null }>(
        `UPDATE tennis.auth_sessions SET revoked_at=clock_timestamp()
      WHERE token_hash=$1 AND revoked_at IS NULL RETURNING id,subject_id,tenant_id`,
        [tokenHash(token)],
      )
    ).rows;
    if (rows[0]) await audit(tx, rows[0].subject_id, rows[0].tenant_id, "auth.logout", rows[0].id);
  });
}
async function requirePlatform(tx: pg.PoolClient, subjectId: string): Promise<void> {
  const found = await tx.query(
    `SELECT o.subject_id FROM tennis.platform_operators o JOIN tennis.local_accounts a ON a.subject_id=o.subject_id
    WHERE o.subject_id=$1 AND o.active AND a.active FOR SHARE OF o,a`,
    [subjectId],
  );
  if (found.rowCount !== 1) throw new TennisAuthError("PLATFORM_ACCESS_DENIED");
}
async function requireAdmin(tx: pg.PoolClient, actor: TenantActor): Promise<void> {
  await lockTenantTransactions(tx, actor.tenantId);
  const found = await tx.query(
    `SELECT m.subject_id FROM tennis.tenant_memberships m JOIN tennis.tenants t ON t.id=m.tenant_id
    WHERE m.tenant_id=$1 AND m.subject_id=$2 AND m.active AND t.active AND m.role='ADMIN' FOR SHARE OF m,t`,
    [actor.tenantId, actor.subjectId],
  );
  if (found.rowCount !== 1) throw new TenantAccessError("TENANT_ACCESS_DENIED");
}
function normalizedGrant(input: {
  role?: StaffRole;
  permissions?: TenantPermission[];
  allVenues?: boolean;
  venueIds?: string[];
  active?: boolean;
}): StaffInput {
  const role = input.role ?? "VIEWER";
  const granted = [...new Set<TenantPermission>(input.permissions ?? ["read"])];
  const venues = [...new Set(input.venueIds ?? [])].sort();
  if (
    !["ADMIN", "STAFF", "VIEWER"].includes(role) ||
    granted.some((permission) => !permissions.includes(permission)) ||
    !granted.includes("read") ||
    (role === "VIEWER" && granted.some((permission) => permission !== "read")) ||
    venues.length > 1000 ||
    venues.some((value) => typeof value !== "string" || !value) ||
    (input.allVenues !== undefined && typeof input.allVenues !== "boolean") ||
    (input.active !== undefined && typeof input.active !== "boolean")
  )
    throw new TennisAuthError("INVALID_STAFF_GRANT");
  return {
    role,
    permissions: role === "ADMIN" ? [...permissions] : granted,
    allVenues: role === "ADMIN" || (input.allVenues ?? false),
    venueIds: role === "ADMIN" || input.allVenues ? [] : venues,
    active: input.active ?? true,
  };
}
async function checkVenues(tx: pg.PoolClient, tenantId: string, venueIds: string[]): Promise<void> {
  if (!venueIds.length) return;
  const rows = await tx.query("SELECT id FROM tennis.venues WHERE tenant_id=$1 AND id=ANY($2::text[]) FOR SHARE", [
    tenantId,
    venueIds,
  ]);
  if (rows.rowCount !== venueIds.length) throw new TennisAuthError("INVALID_STAFF_GRANT");
}
async function insertAccount(
  tx: pg.PoolClient,
  input: { username: string; displayName: string },
  hash: string,
): Promise<string> {
  const subjectId = randomUUID();
  await tx.query("INSERT INTO tennis.subjects (id,display_name) VALUES ($1,$2)", [
    subjectId,
    validateDisplayName(input.displayName),
  ]);
  await tx.query("INSERT INTO tennis.local_accounts (subject_id,username,password_hash) VALUES ($1,$2,$3)", [
    subjectId,
    username(input.username),
    hash,
  ]);
  return subjectId;
}
async function setGrant(tx: pg.PoolClient, tenantId: string, subjectId: string, grant: StaffInput): Promise<void> {
  await checkVenues(tx, tenantId, grant.venueIds);
  await tx.query(
    `INSERT INTO tennis.tenant_memberships (tenant_id,subject_id,role,permissions,all_venues,active) VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (tenant_id,subject_id) DO UPDATE SET role=EXCLUDED.role,permissions=EXCLUDED.permissions,all_venues=EXCLUDED.all_venues,active=EXCLUDED.active`,
    [tenantId, subjectId, grant.role, grant.permissions, grant.allVenues, grant.active],
  );
  await tx.query("DELETE FROM tennis.membership_venues WHERE tenant_id=$1 AND subject_id=$2", [tenantId, subjectId]);
  for (const venueId of grant.venueIds)
    await tx.query("INSERT INTO tennis.membership_venues (tenant_id,subject_id,venue_id) VALUES ($1,$2,$3)", [
      tenantId,
      subjectId,
      venueId,
    ]);
}
function accountError(error: unknown): never {
  if ((error as { code?: string }).code === "23505") throw new TennisAuthError("USERNAME_ALREADY_EXISTS");
  throw error;
}
/** Internal bootstrap only: never expose this privilege-bearing function as an anonymous endpoint. */
export async function createLocalAccount(
  pool: pg.Pool,
  input: AccountInput,
): Promise<{ subjectId: string; username: string; displayName: string }> {
  const normalized = username(input.username);
  const displayName = validateDisplayName(input.displayName);
  if (input.customerId && (!input.tenantId || input.role)) throw new TennisAuthError("INVALID_ACCOUNT");
  const grant = normalizedGrant(input);
  const hash = await passwordHash(input.password);
  try {
    return await transaction(pool, async (tx) => {
      if (input.tenantId) {
        await lockTenantTransactions(tx, input.tenantId);
        if (
          (await tx.query("SELECT id FROM tennis.tenants WHERE id=$1 AND active FOR SHARE", [input.tenantId]))
            .rowCount !== 1
        )
          throw new TennisAuthError("INVALID_ACCOUNT");
      }
      const subjectId = await insertAccount(tx, { username: normalized, displayName }, hash);
      if (input.platformOperator)
        await tx.query("INSERT INTO tennis.platform_operators (subject_id) VALUES ($1)", [subjectId]);
      if (input.customerId) {
        const bound = await tx.query(
          "UPDATE tennis.customers SET subject_id=$3 WHERE tenant_id=$1 AND id=$2 AND active AND subject_id IS NULL",
          [input.tenantId, input.customerId, subjectId],
        );
        if (bound.rowCount !== 1) throw new TennisAuthError("INVALID_ACCOUNT");
      } else if (input.tenantId) await setGrant(tx, input.tenantId, subjectId, grant);
      await audit(tx, subjectId, input.tenantId ?? null, "account.bootstrap", subjectId, {
        platformOperator: input.platformOperator === true,
        customer: !!input.customerId,
      });
      return { subjectId, username: normalized, displayName };
    });
  } catch (error) {
    return accountError(error);
  }
}
export async function listPlatformTenants(
  pool: pg.Pool,
  subjectId: string,
): Promise<Array<{ id: string; name: string; active: boolean; createdAt: string }>> {
  return transaction(pool, async (tx) => {
    await requirePlatform(tx, subjectId);
    return (
      await tx.query<{ id: string; name: string; active: boolean; created_at: Date }>(
        "SELECT id,name,active,created_at FROM tennis.tenants ORDER BY created_at DESC,id",
      )
    ).rows.map((row) => ({ id: row.id, name: row.name, active: row.active, createdAt: row.created_at.toISOString() }));
  });
}
/** Service suspension preserves tenant records and payment/expiry processing. */
export async function setPlatformTenantStatus(
  pool: pg.Pool,
  platformSubjectId: string,
  input: { tenantId: string; active: boolean; expectedActive: boolean; reason: string },
): Promise<{ id: string; name: string; active: boolean; createdAt: string }> {
  return transaction(pool, async (tx) => {
    await requirePlatform(tx, platformSubjectId);
    if (
      typeof input.tenantId !== "string" ||
      !input.tenantId.trim() ||
      input.tenantId.length > 200 ||
      typeof input.active !== "boolean" ||
      typeof input.expectedActive !== "boolean" ||
      typeof input.reason !== "string" ||
      !input.reason.trim() ||
      input.reason.length > 2000
    )
      throw new TennisAuthError("INVALID_TENANT_STATUS");
    await lockTenantTransactions(tx, input.tenantId);
    const tenant = (
      await tx.query<{ id: string; name: string; active: boolean; created_at: Date }>(
        "SELECT id,name,active,created_at FROM tennis.tenants WHERE id=$1 FOR UPDATE",
        [input.tenantId],
      )
    ).rows[0];
    if (!tenant) throw new TenantAccessError("RESOURCE_NOT_FOUND");
    if (tenant.active !== input.expectedActive) throw new TennisAuthError("STALE_TENANT_STATUS");
    if (tenant.active !== input.active) {
      await tx.query("UPDATE tennis.tenants SET active=$2 WHERE id=$1", [input.tenantId, input.active]);
      let revokedDelegations = 0;
      if (!input.active) {
        revokedDelegations =
          (await tx.query("DELETE FROM tennis.agent_delegations WHERE tenant_id=$1", [input.tenantId])).rowCount ?? 0;
        // A delayed external reply must not reappear after the tenant is restored.
        await tx.query(
          "UPDATE tennis.agent_conversations SET generation=generation+1,updated_at=clock_timestamp() WHERE tenant_id=$1",
          [input.tenantId],
        );
      }
      await audit(tx, platformSubjectId, input.tenantId, "tenant.status", input.tenantId, {
        previousActive: tenant.active,
        active: input.active,
        reason: input.reason.trim(),
        revokedDelegations,
      });
    }
    return { id: tenant.id, name: tenant.name, active: input.active, createdAt: tenant.created_at.toISOString() };
  });
}
export async function provisionTenant(
  pool: pg.Pool,
  operatorSubjectId: string,
  input: { name: string; adminUsername: string; adminDisplayName: string; adminPassword: string },
): Promise<{ id: string; name: string; adminSubjectId: string }> {
  const name = validateDisplayName(input.name);
  const adminUsername = username(input.adminUsername);
  const adminDisplayName = validateDisplayName(input.adminDisplayName);
  const hash = await passwordHash(input.adminPassword);
  try {
    return await transaction(pool, async (tx) => {
      await requirePlatform(tx, operatorSubjectId);
      const id = randomUUID();
      await tx.query("INSERT INTO tennis.tenants (id,name) VALUES ($1,$2)", [id, name]);
      const adminSubjectId = await insertAccount(tx, { username: adminUsername, displayName: adminDisplayName }, hash);
      await setGrant(tx, id, adminSubjectId, normalizedGrant({ role: "ADMIN" }));
      await audit(tx, operatorSubjectId, id, "tenant.provision", id, { adminSubjectId });
      await recordTenantAudit(tx, { subjectId: operatorSubjectId, tenantId: id }, "tenant.provision", id, {
        adminSubjectId,
      });
      return { id, name, adminSubjectId };
    });
  } catch (error) {
    return accountError(error);
  }
}
async function staffRows(tx: pg.PoolClient, tenantId: string): Promise<StaffView[]> {
  const rows = (
    await tx.query<StaffView>(
      `SELECT m.subject_id AS "subjectId",a.username,p.display_name AS "displayName",
    coalesce(a.active,false) AS "accountActive",m.role,m.permissions,m.all_venues AS "allVenues",m.active,
    ARRAY(SELECT v.venue_id FROM tennis.membership_venues v WHERE v.tenant_id=m.tenant_id AND v.subject_id=m.subject_id ORDER BY v.venue_id) AS "venueIds"
    FROM tennis.tenant_memberships m JOIN tennis.subjects p ON p.id=m.subject_id LEFT JOIN tennis.local_accounts a ON a.subject_id=m.subject_id
    WHERE m.tenant_id=$1 ORDER BY p.display_name,m.subject_id`,
      [tenantId],
    )
  ).rows;
  return rows;
}
export async function listTenantStaff(pool: pg.Pool, actor: TenantActor): Promise<StaffView[]> {
  return transaction(pool, async (tx) => {
    await requireAdmin(tx, actor);
    return staffRows(tx, actor.tenantId);
  });
}
export async function createTenantStaff(
  pool: pg.Pool,
  actor: TenantActor,
  input: {
    username: string;
    password: string;
    displayName: string;
    role: StaffRole;
    permissions: TenantPermission[];
    allVenues: boolean;
    venueIds: string[];
  },
): Promise<StaffView> {
  const grant = normalizedGrant(input);
  const normalized = username(input.username);
  const displayName = validateDisplayName(input.displayName);
  const hash = await passwordHash(input.password);
  try {
    return await transaction(pool, async (tx) => {
      await requireAdmin(tx, actor);
      const subjectId = await insertAccount(tx, { username: normalized, displayName }, hash);
      await setGrant(tx, actor.tenantId, subjectId, grant);
      await recordTenantAudit(tx, actor, "staff.create", subjectId, {
        role: grant.role,
        permissions: grant.permissions,
        allVenues: grant.allVenues,
        venueIds: grant.venueIds,
      });
      return (await staffRows(tx, actor.tenantId)).find((row) => row.subjectId === subjectId)!;
    });
  } catch (error) {
    return accountError(error);
  }
}
export async function updateTenantStaff(
  pool: pg.Pool,
  actor: TenantActor,
  subjectId: string,
  input: StaffInput,
): Promise<StaffView> {
  const grant = normalizedGrant(input);
  return transaction(pool, async (tx) => {
    await requireAdmin(tx, actor);
    const existing = (
      await tx.query<{ role: StaffRole; active: boolean }>(
        "SELECT role,active FROM tennis.tenant_memberships WHERE tenant_id=$1 AND subject_id=$2 FOR UPDATE",
        [actor.tenantId, subjectId],
      )
    ).rows[0];
    if (!existing) throw new TenantAccessError("RESOURCE_NOT_FOUND");
    if (existing.role === "ADMIN" && existing.active && (grant.role !== "ADMIN" || !grant.active)) {
      const another = await tx.query(
        `SELECT m.subject_id FROM tennis.tenant_memberships m JOIN tennis.local_accounts a ON a.subject_id=m.subject_id
        WHERE m.tenant_id=$1 AND m.subject_id<>$2 AND m.role='ADMIN' AND m.active AND a.active FOR SHARE OF m,a`,
        [actor.tenantId, subjectId],
      );
      if (!another.rowCount) throw new TennisAuthError("LAST_TENANT_ADMIN");
    }
    await setGrant(tx, actor.tenantId, subjectId, grant);
    // A grant edit also invalidates UI drafts/CSRF in every affected staff session.
    await tx.query(
      `UPDATE tennis.auth_sessions SET context_version=context_version+1,csrf_token=$3
      WHERE tenant_id=$1 AND subject_id=$2 AND kind='staff' AND revoked_at IS NULL`,
      [actor.tenantId, subjectId, secret()],
    );
    await recordTenantAudit(tx, actor, "staff.update", subjectId, { ...grant });
    return (await staffRows(tx, actor.tenantId)).find((row) => row.subjectId === subjectId)!;
  });
}
