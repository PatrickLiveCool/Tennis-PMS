import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertLocalTennisDatabaseUrl, localTennisTestDatabaseUrl } from "../../packages/db/src/tennis/local-config.ts";
import { migrateTennis } from "../../packages/db/src/tennis/migrate.ts";
import {
  authenticate,
  authenticateForContextSelection,
  createLocalAccount,
  createTenantStaff,
  listPlatformTenants,
  listTenantStaff,
  login,
  logout,
  provisionTenant,
  selectSessionContext,
  setPlatformTenantStatus,
  updateTenantStaff,
  type AccountInput,
  type StaffInput,
} from "../../packages/db/src/tennis/auth.ts";
import { listVenues } from "../../packages/db/src/tennis/catalog.ts";
import { createConversation, issueDelegation, resolveDelegation } from "../../packages/db/src/tennis/external-agent.ts";
import { createCustomer } from "../../packages/db/src/tennis/customers.ts";
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
const password = "synthetic-only-passphrase-492!";
const newUsername = () => `test_${randomUUID()}`;
let first: TenantFixture;
let second: TenantFixture;
let subjects: string[] = [];
let extraTenants: TenantFixture[] = [];
async function account(input: Partial<AccountInput> = {}) {
  const credentials = { username: newUsername(), password, displayName: "合成员工", ...input };
  const created = await createLocalAccount(db, credentials);
  subjects.push(created.subjectId);
  return { ...created, password: credentials.password };
}
const staffGrant: StaffInput = {
  role: "STAFF",
  permissions: ["read", "book"],
  allVenues: false,
  venueIds: [],
  active: true,
};
beforeAll(async () => {
  const tx = await db.connect();
  try {
    await migrateTennis(tx);
    await migrateTennis(tx);
  } finally {
    tx.release();
  }
});
beforeEach(async () => {
  subjects = [];
  extraTenants = [];
  first = await seedTenantFixture(db);
  second = await seedTenantFixture(db);
});
afterEach(async () => {
  const tenants = [first, second, ...extraTenants].filter(Boolean);
  const ids = tenants.map((fixture) => fixture.actor.tenantId);
  await db.query("DELETE FROM tennis.auth_sessions WHERE subject_id=ANY($1::text[]) OR tenant_id=ANY($2::text[])", [
    subjects,
    ids,
  ]);
  await db.query("DELETE FROM tennis.auth_audit_events WHERE subject_id=ANY($1::text[]) OR tenant_id=ANY($2::text[])", [
    subjects,
    ids,
  ]);
  await db.query("DELETE FROM tennis.agent_conversations WHERE tenant_id=ANY($1::text[])", [ids]);
  await db.query("DELETE FROM tennis.platform_operators WHERE subject_id=ANY($1::text[])", [subjects]);
  await db.query("DELETE FROM tennis.local_accounts WHERE subject_id=ANY($1::text[])", [subjects]);
  for (const fixture of tenants) await removeTenantFixture(db, fixture);
  await db.query("DELETE FROM tennis.subjects WHERE id=ANY($1::text[])", [subjects]);
});
afterAll(async () => {
  await db.end();
});

describe("trusted Tennis authentication and tenant administration", () => {
  it("salts passwords and persists only hashed session tokens, returning a bounded public view", async () => {
    const one = await account({ tenantId: first.actor.tenantId, role: "ADMIN" });
    const two = await account({ tenantId: first.actor.tenantId, role: "ADMIN" });
    const stored = (
      await db.query("SELECT password_hash FROM tennis.local_accounts WHERE subject_id=ANY($1::text[])", [
        [one.subjectId, two.subjectId],
      ])
    ).rows;
    expect(stored).toHaveLength(2);
    expect(stored[0].password_hash).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(stored[0].password_hash).not.toBe(stored[1].password_hash);
    const result = await login(db, { username: one.username.toUpperCase(), password });
    expect(result.session).toMatchObject({
      subjectId: one.subjectId,
      tenantId: first.actor.tenantId,
      kind: "staff",
      contextVersion: 1,
      platformOperator: false,
    });
    expect(result.session).not.toHaveProperty("sessionId");
    expect(result.session).not.toHaveProperty("actor");
    expect(result.session).not.toHaveProperty("token");
    const context = await authenticate(db, result.token);
    expect(context.actor).toEqual({ subjectId: one.subjectId, tenantId: first.actor.tenantId });
    const row = (await db.query("SELECT * FROM tennis.auth_sessions WHERE id=$1", [context.sessionId])).rows[0];
    expect(row.token_hash).toBe(createHash("sha256").update(result.token).digest("hex"));
    expect(JSON.stringify(row)).not.toContain(result.token);
    const audit = (
      await db.query("SELECT action,details FROM tennis.auth_audit_events WHERE subject_id=$1", [one.subjectId])
    ).rows;
    expect(JSON.stringify(audit)).not.toContain(password);
    expect(JSON.stringify(audit)).not.toContain(result.token);
  });
  it("rejects invalid credentials uniformly and throttles repeated password attempts", async () => {
    const one = await account({ tenantId: first.actor.tenantId, role: "ADMIN" });
    await expect(login(db, { username: "does-not-exist", password })).rejects.toMatchObject({
      code: "INVALID_CREDENTIALS",
    });
    for (let attempt = 0; attempt < 10; attempt++)
      await expect(login(db, { username: one.username, password: "wrong" })).rejects.toMatchObject({
        code: "INVALID_CREDENTIALS",
      });
    await expect(login(db, { username: one.username, password })).rejects.toMatchObject({
      code: "INVALID_CREDENTIALS",
    });
    const row = (
      await db.query("SELECT failed_attempts,locked_until FROM tennis.local_accounts WHERE subject_id=$1", [
        one.subjectId,
      ])
    ).rows[0];
    expect(row.failed_attempts).toBe(10);
    expect(row.locked_until).toBeInstanceOf(Date);
    await db.query(
      "UPDATE tennis.local_accounts SET locked_until=clock_timestamp()-interval '1 second' WHERE subject_id=$1",
      [one.subjectId],
    );
    expect((await login(db, { username: one.username, password })).session.subjectId).toBe(one.subjectId);
  });
  it("changes only to verified contexts and rotates the CSRF and draft version", async () => {
    const one = await account({ tenantId: first.actor.tenantId, role: "ADMIN" });
    await db.query(
      "INSERT INTO tennis.tenant_memberships (tenant_id,subject_id,role,all_venues) VALUES ($1,$2,'VIEWER',true)",
      [second.actor.tenantId, one.subjectId],
    );
    const result = await login(db, { username: one.username, password });
    const before = await selectSessionContext(db, result.token, { tenantId: first.actor.tenantId, kind: "staff" });
    const switched = await selectSessionContext(db, result.token, { tenantId: second.actor.tenantId, kind: "staff" });
    expect(switched.tenantId).toBe(second.actor.tenantId);
    expect(switched.csrfToken).not.toBe(before.csrfToken);
    expect(switched.contextVersion).toBe(before.contextVersion + 1);
    expect(switched.permissions).toEqual(["read"]);
    await expect(
      selectSessionContext(db, result.token, { tenantId: randomUUID(), kind: "staff" }),
    ).rejects.toMatchObject({ code: "AUTH_CONTEXT_REVOKED" });
    await expect(selectSessionContext(db, result.token, { tenantId: null, kind: "platform" })).rejects.toMatchObject({
      code: "AUTH_CONTEXT_REVOKED",
    });
    expect((await authenticate(db, result.token)).contextVersion).toBe(switched.contextVersion);
    await db.query("UPDATE tennis.tenant_memberships SET active=false WHERE tenant_id=$1 AND subject_id=$2", [
      second.actor.tenantId,
      one.subjectId,
    ]);
    await expect(authenticate(db, result.token)).rejects.toMatchObject({ code: "AUTH_CONTEXT_REVOKED" });
    // Switching revalidates the destination without requiring a now-revoked source context.
    expect(
      (await selectSessionContext(db, result.token, { tenantId: first.actor.tenantId, kind: "staff" })).tenantId,
    ).toBe(first.actor.tenantId);
  });
  it("immediately rejects disabled account, tenant and membership access and supports explicit logout", async () => {
    const one = await account({
      tenantId: first.actor.tenantId,
      role: "STAFF",
      permissions: ["read"],
      venueIds: [first.venueId],
    });
    const result = await login(db, { username: one.username, password });
    await db.query("UPDATE tennis.local_accounts SET active=false WHERE subject_id=$1", [one.subjectId]);
    await expect(authenticate(db, result.token)).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
    await db.query("UPDATE tennis.local_accounts SET active=true WHERE subject_id=$1", [one.subjectId]);
    await db.query("UPDATE tennis.tenants SET active=false WHERE id=$1", [first.actor.tenantId]);
    await expect(authenticate(db, result.token)).rejects.toMatchObject({ code: "AUTH_CONTEXT_REVOKED" });
    await db.query("UPDATE tennis.tenants SET active=true WHERE id=$1", [first.actor.tenantId]);
    await db.query("UPDATE tennis.tenant_memberships SET active=false WHERE tenant_id=$1 AND subject_id=$2", [
      first.actor.tenantId,
      one.subjectId,
    ]);
    await expect(authenticate(db, result.token)).rejects.toMatchObject({ code: "AUTH_CONTEXT_REVOKED" });
    await db.query("UPDATE tennis.tenant_memberships SET active=true WHERE tenant_id=$1 AND subject_id=$2", [
      first.actor.tenantId,
      one.subjectId,
    ]);
    await logout(db, result.token);
    await logout(db, result.token);
    await expect(authenticate(db, result.token)).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
    expect(
      (
        await db.query("SELECT id FROM tennis.auth_audit_events WHERE action='auth.logout' AND subject_id=$1", [
          one.subjectId,
        ])
      ).rowCount,
    ).toBe(1);
  });
  it("rejects expired sessions based on database time", async () => {
    const one = await account({ tenantId: first.actor.tenantId, role: "ADMIN" });
    const result = await login(db, { username: one.username, password });
    await db.query(
      "UPDATE tennis.auth_sessions SET created_at=clock_timestamp()-interval '2 seconds',expires_at=clock_timestamp()-interval '1 second' WHERE subject_id=$1",
      [one.subjectId],
    );
    await expect(authenticate(db, result.token)).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
  });
  it("derives customer identity from a trusted binding and revokes it when that binding disappears", async () => {
    const customer = await createCustomer(db, first.actor, { nickname: "合成客户" });
    const one = await account({ tenantId: first.actor.tenantId, customerId: customer.id });
    const result = await login(db, { username: one.username, password });
    expect((await authenticate(db, result.token)).actor).toEqual({
      kind: "customer",
      subjectId: one.subjectId,
      tenantId: first.actor.tenantId,
      customerId: customer.id,
    });
    await expect(
      selectSessionContext(db, result.token, { tenantId: first.actor.tenantId, kind: "staff" }),
    ).rejects.toMatchObject({ code: "AUTH_CONTEXT_REVOKED" });
    await expect(
      selectSessionContext(db, result.token, { tenantId: second.actor.tenantId, kind: "customer" }),
    ).rejects.toMatchObject({ code: "AUTH_CONTEXT_REVOKED" });
    await db.query("UPDATE tennis.customers SET subject_id=NULL WHERE tenant_id=$1 AND id=$2", [
      first.actor.tenantId,
      customer.id,
    ]);
    await expect(authenticate(db, result.token)).rejects.toMatchObject({ code: "AUTH_CONTEXT_REVOKED" });
  });
  it("manually provisions a tenant without giving the platform operator tenant business powers", async () => {
    const operator = await account({ platformOperator: true });
    const session = await login(db, { username: operator.username, password });
    expect(session.session).toMatchObject({ tenantId: null, kind: "platform", platformOperator: true, tenants: [] });
    expect((await authenticate(db, session.token)).actor).toBeNull();
    const adminUsername = newUsername();
    const created = await provisionTenant(db, operator.subjectId, {
      name: "合成试点租户",
      adminUsername,
      adminDisplayName: "租户管理员",
      adminPassword: password,
    });
    subjects.push(created.adminSubjectId);
    extraTenants.push({ actor: { tenantId: created.id, subjectId: created.adminSubjectId }, venueId: "" });
    expect((await listPlatformTenants(db, operator.subjectId)).some((tenant) => tenant.id === created.id)).toBe(true);
    expect((await login(db, { username: adminUsername, password })).session).toMatchObject({
      tenantId: created.id,
      kind: "staff",
      platformOperator: false,
    });
    await expect(listVenues(db, { subjectId: operator.subjectId, tenantId: created.id })).rejects.toMatchObject({
      code: "TENANT_ACCESS_DENIED",
    });
    await expect(
      selectSessionContext(db, session.token, { tenantId: created.id, kind: "staff" }),
    ).rejects.toMatchObject({ code: "AUTH_CONTEXT_REVOKED" });
    await expect(listPlatformTenants(db, created.adminSubjectId)).rejects.toMatchObject({
      code: "PLATFORM_ACCESS_DENIED",
    });
    const count = (await db.query("SELECT count(*)::int AS n FROM tennis.tenants")).rows[0].n;
    await expect(
      provisionTenant(db, operator.subjectId, {
        name: "重复账号回滚",
        adminUsername,
        adminDisplayName: "管理员",
        adminPassword: password,
      }),
    ).rejects.toMatchObject({ code: "USERNAME_ALREADY_EXISTS" });
    expect((await db.query("SELECT count(*)::int AS n FROM tennis.tenants")).rows[0].n).toBe(count);
    await db.query("UPDATE tennis.platform_operators SET active=false WHERE subject_id=$1", [operator.subjectId]);
    await expect(authenticate(db, session.token)).rejects.toMatchObject({ code: "AUTH_CONTEXT_REVOKED" });
    await expect(listPlatformTenants(db, operator.subjectId)).rejects.toMatchObject({ code: "PLATFORM_ACCESS_DENIED" });
  });
  it("suspends tenant business sessions, restores selection and permanently revokes old agent authority", async () => {
    const operator = await account({ platformOperator: true });
    const employee = await account({ tenantId: first.actor.tenantId, role: "ADMIN" });
    const profile = await createCustomer(db, first.actor, { nickname: "停用恢复测试客户" });
    const customer = await account({ tenantId: first.actor.tenantId, customerId: profile.id });
    const staffLogin = await login(db, { username: employee.username, password });
    const customerLogin = await login(db, { username: customer.username, password });
    const staffActor = (await authenticate(db, staffLogin.token)).actor!;
    const customerActor = (await authenticate(db, customerLogin.token)).actor!;
    const conversation = await createConversation(db, customerActor, first.venueId);
    const delegation = await issueDelegation(db, customerActor, conversation.id);
    const resolved = await resolveDelegation(db, delegation.token);
    const foreignConversation = await createConversation(db, second.actor, second.venueId);
    const foreignDelegation = await issueDelegation(db, second.actor, foreignConversation.id);
    expect(
      await setPlatformTenantStatus(db, operator.subjectId, {
        tenantId: first.actor.tenantId,
        active: false,
        expectedActive: true,
        reason: " 暂停试点服务 ",
      }),
    ).toMatchObject({ id: first.actor.tenantId, active: false });
    for (const result of [staffLogin, customerLogin]) {
      await expect(authenticate(db, result.token)).rejects.toMatchObject({ code: "AUTH_CONTEXT_REVOKED" });
      const recovery = await authenticateForContextSelection(db, result.token);
      expect(recovery).toMatchObject({ contextValid: false, actor: null, permissions: [] });
      expect(recovery.tenants.some((tenant) => tenant.id === first.actor.tenantId)).toBe(false);
      await expect(
        selectSessionContext(db, result.token, { tenantId: first.actor.tenantId, kind: result.session.kind }),
      ).rejects.toMatchObject({ code: "AUTH_CONTEXT_REVOKED" });
    }
    await expect(listVenues(db, staffActor)).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
    await expect(resolveDelegation(db, delegation.token)).rejects.toMatchObject({ code: "AGENT_DELEGATION_REVOKED" });
    expect((await resolveDelegation(db, foreignDelegation.token)).actor.tenantId).toBe(second.actor.tenantId);
    expect(
      (await listPlatformTenants(db, operator.subjectId)).find((tenant) => tenant.id === first.actor.tenantId)?.active,
    ).toBe(false);
    const generation = (
      await db.query("SELECT generation FROM tennis.agent_conversations WHERE id=$1", [conversation.id])
    ).rows[0].generation;
    expect(generation).toBe(conversation.generation + 1);
    await setPlatformTenantStatus(db, operator.subjectId, {
      tenantId: first.actor.tenantId,
      active: true,
      expectedActive: false,
      reason: "恢复试点服务",
    });
    for (const result of [staffLogin, customerLogin]) {
      const restored = await selectSessionContext(db, result.token, {
        tenantId: first.actor.tenantId,
        kind: result.session.kind,
      });
      expect(restored).toMatchObject({ contextValid: true, tenantId: first.actor.tenantId });
      expect(restored.csrfToken).not.toBe(result.csrfToken);
      expect(restored.contextVersion).toBe(result.session.contextVersion + 1);
    }
    // Neither a saved bearer nor its already-resolved business actor can revive.
    await expect(resolveDelegation(db, delegation.token)).rejects.toMatchObject({ code: "AGENT_DELEGATION_REVOKED" });
    await expect(createConversation(db, resolved.actor, first.venueId)).rejects.toMatchObject({
      code: "AGENT_DELEGATION_REVOKED",
    });
    const fresh = await issueDelegation(db, customerActor, conversation.id);
    expect((await resolveDelegation(db, fresh.token)).actor.subjectId).toBe(customer.subjectId);
    await expect(
      listVenues(db, { tenantId: first.actor.tenantId, subjectId: operator.subjectId }),
    ).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
    const audit = (
      await db.query(
        "SELECT details FROM tennis.auth_audit_events WHERE tenant_id=$1 AND action='tenant.status' ORDER BY created_at",
        [first.actor.tenantId],
      )
    ).rows;
    expect(audit).toHaveLength(2);
    expect(audit[0].details).toMatchObject({
      previousActive: true,
      active: false,
      reason: "暂停试点服务",
      revokedDelegations: 1,
    });
    expect(audit[1].details).toMatchObject({ previousActive: false, active: true, reason: "恢复试点服务" });
  });
  it("requires active platform authority, a reason and the current tenant status before changing service", async () => {
    const operator = await account({ platformOperator: true });
    const input = { tenantId: first.actor.tenantId, active: false, expectedActive: true, reason: "停用测试" };
    await expect(setPlatformTenantStatus(db, first.actor.subjectId, input)).rejects.toMatchObject({
      code: "PLATFORM_ACCESS_DENIED",
    });
    await expect(setPlatformTenantStatus(db, operator.subjectId, { ...input, reason: "  " })).rejects.toMatchObject({
      code: "INVALID_TENANT_STATUS",
    });
    await expect(
      setPlatformTenantStatus(db, operator.subjectId, { ...input, tenantId: randomUUID() }),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    const attempts = await Promise.allSettled([
      setPlatformTenantStatus(db, operator.subjectId, input),
      setPlatformTenantStatus(db, operator.subjectId, { ...input, reason: "另一位操作员的旧页面" }),
    ]);
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "STALE_TENANT_STATUS" },
    });
    expect(
      (
        await db.query("SELECT id FROM tennis.auth_audit_events WHERE tenant_id=$1 AND action='tenant.status'", [
          first.actor.tenantId,
        ])
      ).rowCount,
    ).toBe(1);
    await db.query("UPDATE tennis.platform_operators SET active=false WHERE subject_id=$1", [operator.subjectId]);
    await expect(
      setPlatformTenantStatus(db, operator.subjectId, { ...input, active: true, expectedActive: false }),
    ).rejects.toMatchObject({ code: "PLATFORM_ACCESS_DENIED" });
    expect(
      (await db.query("SELECT active FROM tennis.tenants WHERE id=$1", [first.actor.tenantId])).rows[0].active,
    ).toBe(false);
  });
  it("requires tenant admin for staff maintenance and applies venue scope and role changes immediately", async () => {
    const staff = await createTenantStaff(db, first.actor, {
      username: newUsername(),
      password,
      displayName: "接待",
      role: "STAFF",
      permissions: ["read", "book"],
      allVenues: false,
      venueIds: [first.venueId],
    });
    subjects.push(staff.subjectId);
    const loginResult = await login(db, { username: staff.username!, password });
    const staffActor = { subjectId: staff.subjectId, tenantId: first.actor.tenantId };
    expect((await authenticate(db, loginResult.token)).venueIds).toEqual([first.venueId]);
    await expect(listTenantStaff(db, staffActor)).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
    await expect(
      updateTenantStaff(db, staffActor, staff.subjectId, { ...staffGrant, role: "ADMIN" }),
    ).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
    const updated = await updateTenantStaff(db, first.actor, staff.subjectId, {
      ...staffGrant,
      role: "VIEWER",
      permissions: ["read"],
      venueIds: [first.venueId],
    });
    expect(updated.role).toBe("VIEWER");
    const reloaded = await authenticate(db, loginResult.token);
    expect(reloaded.permissions).toEqual(["read"]);
    expect(reloaded.csrfToken).not.toBe(loginResult.csrfToken);
    expect(reloaded.contextVersion).toBe(loginResult.session.contextVersion + 1);
    await updateTenantStaff(db, first.actor, staff.subjectId, {
      ...staffGrant,
      active: false,
      venueIds: [first.venueId],
    });
    await expect(authenticate(db, loginResult.token)).rejects.toMatchObject({ code: "AUTH_CONTEXT_REVOKED" });
    await expect(updateTenantStaff(db, second.actor, staff.subjectId, staffGrant)).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
    });
  });
  it("rejects cross-tenant venue grants and prevents concurrent removal of the final live administrator", async () => {
    await expect(
      createTenantStaff(db, first.actor, {
        username: newUsername(),
        password,
        displayName: "越权场馆",
        ...staffGrant,
        venueIds: [second.venueId],
      }),
    ).rejects.toMatchObject({ code: "INVALID_STAFF_GRANT" });
    const firstAdmin = await account({ tenantId: first.actor.tenantId, role: "ADMIN" });
    const secondAdmin = await account({ tenantId: first.actor.tenantId, role: "ADMIN" });
    // The fixture's synthetic service principal has no login account and is not a recoverable human admin.
    await db.query("UPDATE tennis.tenant_memberships SET active=false WHERE tenant_id=$1 AND subject_id=$2", [
      first.actor.tenantId,
      first.actor.subjectId,
    ]);
    const one = { tenantId: first.actor.tenantId, subjectId: firstAdmin.subjectId };
    const two = { tenantId: first.actor.tenantId, subjectId: secondAdmin.subjectId };
    const settled = await Promise.allSettled([
      updateTenantStaff(db, one, one.subjectId, { ...staffGrant, active: false }),
      updateTenantStaff(db, two, two.subjectId, { ...staffGrant, active: false }),
    ]);
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((settled.find((result) => result.status === "rejected") as PromiseRejectedResult).reason.code).toBe(
      "LAST_TENANT_ADMIN",
    );
    expect(
      (
        await db.query(
          "SELECT subject_id FROM tennis.tenant_memberships WHERE tenant_id=$1 AND active AND role='ADMIN'",
          [first.actor.tenantId],
        )
      ).rowCount,
    ).toBe(1);
  });
  it("never leaks an account or partial membership when a customer binding or staff grant is invalid", async () => {
    const before = (await db.query("SELECT count(*)::int AS n FROM tennis.local_accounts")).rows[0].n;
    await expect(account({ tenantId: first.actor.tenantId, customerId: randomUUID() })).rejects.toMatchObject({
      code: "INVALID_ACCOUNT",
    });
    await expect(
      account({ tenantId: first.actor.tenantId, role: "VIEWER", permissions: ["read", "refund"] }),
    ).rejects.toMatchObject({ code: "INVALID_STAFF_GRANT" });
    await expect(account({ tenantId: first.actor.tenantId, password: "too short" })).rejects.toMatchObject({
      code: "INVALID_ACCOUNT",
    });
    expect((await db.query("SELECT count(*)::int AS n FROM tennis.local_accounts")).rows[0].n).toBe(before);
  });
});
