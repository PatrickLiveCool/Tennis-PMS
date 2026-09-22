import { createHash } from "node:crypto";
import type pg from "pg";
import { requireTenantPermission, TenantAccessError, withTenantTransaction, type TenantActor } from "./access.ts";
import { isCustomerActor, type CustomerRecord } from "./customers.ts";

export interface MemberDirectoryPage {
  customers: CustomerRecord[];
  nextCursor: string | null;
}
export class MemberDirectoryQueryError extends Error {
  readonly statusCode = 400;
  constructor(readonly code: "INVALID_MEMBER_QUERY" | "INVALID_MEMBER_CURSOR" = "INVALID_MEMBER_QUERY") {
    super(code);
    this.name = "MemberDirectoryQueryError";
  }
}

/** The full member directory requires the same tenant-wide grant as profile management. */
export async function listMemberDirectory(
  db: pg.Pool,
  actor: TenantActor,
  input: unknown = {},
): Promise<MemberDirectoryPage> {
  if (isCustomerActor(actor)) throw new TenantAccessError("TENANT_ACCESS_DENIED");
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new MemberDirectoryQueryError();
  const query = input as Record<string, unknown>;
  if (
    Object.keys(query).some((key) => !["q", "pageSize", "cursor"].includes(key)) ||
    (query.q !== undefined && (typeof query.q !== "string" || query.q.length > 200)) ||
    (query.pageSize !== undefined && typeof query.pageSize !== "number" &&
      !(typeof query.pageSize === "string" && /^[1-9]\d*$/.test(query.pageSize)))
  ) throw new MemberDirectoryQueryError();
  const pageSize = query.pageSize === undefined ? 50 : Number(query.pageSize);
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new MemberDirectoryQueryError();
  const q = (typeof query.q === "string" ? query.q : "").trim();
  const scope = createHash("sha256").update(JSON.stringify([actor.tenantId, q])).digest("hex");
  let pivot: { nickname: string; id: string } | null = null;
  if (query.cursor !== undefined) {
    if (typeof query.cursor !== "string" || query.cursor.length > 3000 || !/^[A-Za-z0-9_-]+$/.test(query.cursor))
      throw new MemberDirectoryQueryError("INVALID_MEMBER_CURSOR");
    try {
      const decoded: unknown = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8"));
      if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error();
      const cursor = decoded as Record<string, unknown>;
      if (
        Object.keys(cursor).sort().join(",") !== "id,nickname,scope,v" || cursor.v !== 1 || cursor.scope !== scope ||
        typeof cursor.nickname !== "string" || !cursor.nickname || cursor.nickname.length > 200 ||
        typeof cursor.id !== "string" || !cursor.id || cursor.id.length > 200
      ) throw new Error();
      pivot = { nickname: cursor.nickname, id: cursor.id };
    } catch {
      throw new MemberDirectoryQueryError("INVALID_MEMBER_CURSOR");
    }
  }
  return withTenantTransaction(db, actor, async (tx) => {
    await requireTenantPermission(tx, actor, "manage_members");
    const rows = (await tx.query<CustomerRecord>(
      `SELECT id,tenant_id AS "tenantId",nickname,phone,active FROM tennis.customers
       WHERE tenant_id=$1 AND ($2='' OR strpos(lower(nickname),lower($2))>0 OR strpos(coalesce(phone,''),$2)>0)
         AND ($3::text IS NULL OR (nickname,id)>($3,$4::text))
       ORDER BY nickname,id LIMIT $5`,
      [actor.tenantId, q, pivot?.nickname ?? null, pivot?.id ?? null, pageSize + 1],
    )).rows;
    const customers = rows.slice(0, pageSize);
    const last = customers.at(-1);
    return {
      customers,
      nextCursor: rows.length > pageSize && last
        ? Buffer.from(JSON.stringify({ v: 1, scope, nickname: last.nickname, id: last.id })).toString("base64url")
        : null,
    };
  });
}

/** Resolve a recently handled member even when their name falls beyond the first directory page. */
export async function getMemberProfile(db: pg.Pool, actor: TenantActor, customerId: string): Promise<CustomerRecord> {
  if (isCustomerActor(actor)) throw new TenantAccessError("TENANT_ACCESS_DENIED");
  return withTenantTransaction(db, actor, async (tx) => {
    await requireTenantPermission(tx, actor, "manage_members");
    const customer = (await tx.query<CustomerRecord>(
      `SELECT id,tenant_id AS "tenantId",nickname,phone,active FROM tennis.customers WHERE tenant_id=$1 AND id=$2`,
      [actor.tenantId, customerId],
    )).rows[0];
    if (!customer) throw new TenantAccessError("RESOURCE_NOT_FOUND");
    return customer;
  });
}
