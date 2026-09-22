import { randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { createLocalAccount, provisionTenant } from "../../packages/db/src/tennis/auth.ts";
import { createCourt, createVenue, updateVenue } from "../../packages/db/src/tennis/catalog.ts";
import { createCustomer } from "../../packages/db/src/tennis/customers.ts";
import { recordOfflineTopup } from "../../packages/db/src/tennis/wallet.ts";
import { saveTopupOffer } from "../../packages/db/src/tennis/topups.ts";
import { confirmQuote, createQuote } from "../../packages/db/src/tennis/booking.ts";
import { beginOrderPayment } from "../../packages/db/src/tennis/payments.ts";
import { LocalMockPaymentGateway } from "../../packages/db/src/tennis/mock-payments.ts";
import { occupyCourt } from "../../packages/db/src/tennis/inventory.ts";

export const cloudDemoAccounts = ["demo.platform", "demo.green", "demo.staff", "demo.customer"] as const;
export type CloudDemoPasswords = Record<(typeof cloudDemoAccounts)[number], string>;
export interface CloudDemoConfig { databaseUrl: string; passwords: CloudDemoPasswords }
export interface CloudDemoManifest {
  version: 1;
  initializedAt: string;
  bookingDate: string;
  tenantId: string;
  tenantName: string;
  accounts: Record<(typeof cloudDemoAccounts)[number], string>;
  customerIds: string[];
  venues: Array<{ id: string; name: string; courtIds: string[]; orderId: string; occupancyIds: string[] }>;
}
const initializationKey = "green-cloud-demo-v1";

/** No local fallback, URL options, shared credentials or production payment mode. */
export function readCloudDemoConfig(env: NodeJS.ProcessEnv = process.env): CloudDemoConfig {
  if (env.TENNIS_DEMO_MODE !== "true" || env.TENNIS_ALLOW_SIMULATION !== "true" || env.NODE_ENV !== "development")
    throw new Error("Cloud demo initialization requires TENNIS_DEMO_MODE=true, TENNIS_ALLOW_SIMULATION=true and NODE_ENV=development");
  let url: URL;
  try { url = new URL(env.TENNIS_DATABASE_URL ?? ""); } catch { throw new Error("Cloud demo requires an explicit tennis_demo database URL"); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || url.pathname !== "/tennis_demo" ||
    url.username !== "tennis_demo" || !url.password || url.search || url.hash)
    throw new Error("Cloud demo requires database tennis_demo as tennis_demo, without URL options");
  const passwordVariables = ["TENNIS_DEMO_PLATFORM_PASSWORD", "TENNIS_DEMO_ADMIN_PASSWORD", "TENNIS_DEMO_STAFF_PASSWORD", "TENNIS_DEMO_CUSTOMER_PASSWORD"];
  const passwords = {} as CloudDemoPasswords;
  for (const [index, username] of cloudDemoAccounts.entries()) {
    const variable = passwordVariables[index]!;
    const password = env[variable];
    if (!password || password.length < 20 || password.length > 256 || password.trim() !== password ||
      password.includes("TennisPMS123!") || password.includes("tennis_local_only") || password === decodeURIComponent(url.password))
      throw new Error(`${variable} requires a private password of 20–256 characters, separate from the database password`);
    passwords[username] = password;
  }
  if (new Set(Object.values(passwords)).size !== cloudDemoAccounts.length)
    throw new Error("Cloud demo accounts require four different private passwords");
  return { databaseUrl: url.toString(), passwords };
}

/**
 * Seed APIs normally own their transaction. Give each sequential API a savepoint
 * on the bootstrap connection so no internal COMMIT can publish a partial demo.
 * Parallel/nested leases are rejected; this adapter is only for this seed script.
 */
export function cloudDemoTransactionPool(tx: pg.PoolClient): pg.Pool {
  let leased = false;
  let sequence = 0;
  const directQuery: pg.Pool["query"] = tx.query.bind(tx);
  return {
    query: directQuery,
    async connect() {
      if (leased) throw new Error("Cloud demo bootstrap does not support concurrent database leases");
      leased = true;
      const savepoint = `cloud_demo_step_${++sequence}`;
      let started = false;
      let finished = false;
      return {
        async query(sql: string, values?: unknown[]) {
          if (finished) throw new Error("Cloud demo database lease was already finished");
          if (sql === "BEGIN") {
            if (started) throw new Error("Cloud demo database lease already started");
            started = true;
            return tx.query(`SAVEPOINT ${savepoint}`);
          }
          if (sql === "COMMIT") {
            if (!started) throw new Error("Cloud demo database lease has no transaction");
            const result = await tx.query(`RELEASE SAVEPOINT ${savepoint}`);
            finished = true;
            return result;
          }
          if (sql === "ROLLBACK") {
            if (!started) throw new Error("Cloud demo database lease has no transaction");
            await tx.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
            const result = await tx.query(`RELEASE SAVEPOINT ${savepoint}`);
            finished = true;
            return result;
          }
          return tx.query(sql, values);
        },
        release() { leased = false; },
      };
    },
  } as unknown as pg.Pool;
}

async function verifyManifest(db: pg.Pool, manifest: CloudDemoManifest): Promise<void> {
  if (manifest.version !== 1 || manifest.tenantName !== "格林网球" || manifest.venues.length !== 2)
    throw new Error("Cloud demo initialization manifest is incompatible; manual review required");
  const tenant = await db.query("SELECT id FROM tennis.tenants WHERE id=$1", [manifest.tenantId]);
  const accounts = await db.query<{ username: string; subject_id: string }>(
    "SELECT username,subject_id FROM tennis.local_accounts WHERE username=ANY($1::text[])", [cloudDemoAccounts]);
  if (tenant.rowCount !== 1 || accounts.rowCount !== cloudDemoAccounts.length ||
    accounts.rows.some((row) => manifest.accounts[row.username as keyof CloudDemoPasswords] !== row.subject_id))
    throw new Error("Cloud demo account/tenant records differ from the initialization manifest; no data was changed");
  for (const venue of manifest.venues) {
    const result = await db.query(
      `SELECT id FROM tennis.courts WHERE tenant_id=$1 AND venue_id=$2 AND id=ANY($3::text[])`,
      [manifest.tenantId, venue.id, venue.courtIds]);
    if (result.rowCount !== 4) throw new Error("Cloud demo court records differ from the initialization manifest; no data was changed");
  }
}

/** Internal seed fixture; caller owns a transaction. Public entry guards DB identity first. */
export async function buildCloudDemoData(db: pg.Pool, passwords: CloudDemoPasswords, now = new Date()): Promise<{
  created: boolean; manifest: CloudDemoManifest;
}> {
  await db.query(`CREATE TABLE IF NOT EXISTS tennis.cloud_demo_initializations (
    id text PRIMARY KEY, manifest jsonb NOT NULL, initialized_at timestamptz NOT NULL DEFAULT clock_timestamp()
  )`);
  const previous = (await db.query<{ manifest: CloudDemoManifest }>(
    "SELECT manifest FROM tennis.cloud_demo_initializations WHERE id=$1", [initializationKey])).rows[0];
  if (previous) {
    await verifyManifest(db, previous.manifest);
    return { created: false, manifest: previous.manifest };
  }
  // Migration 005 creates this system principal even in a freshly migrated DB.
  // Only that exact migration-owned subject is compatible with an empty demo.
  const existing = await db.query<{ occupied: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM tennis.tenants) OR EXISTS(SELECT 1 FROM tennis.subjects
      WHERE id <> 'system:tennis' OR display_name <> '网球系统任务')
      OR EXISTS(SELECT 1 FROM tennis.local_accounts) AS occupied`);
  if (existing.rows[0]?.occupied)
    throw new Error("First cloud demo initialization requires an empty tennis database; existing records were left untouched");
  const platform = await createLocalAccount(db, {
    username: "demo.platform", password: passwords["demo.platform"], displayName: "演示平台运营（模拟）", platformOperator: true,
  });
  const tenant = await provisionTenant(db, platform.subjectId, {
    name: "格林网球", adminUsername: "demo.green", adminDisplayName: "格林网球管理员", adminPassword: passwords["demo.green"],
  });
  const actor = { tenantId: tenant.id, subjectId: tenant.adminSubjectId };
  const customerSpecs = [
    { nickname: "演示球友（模拟）", phone: "19900000001", principalCents: 1000000, giftCents: 200000 },
    { nickname: "体验会员小林（模拟）", phone: "19900000002", principalCents: 300000, giftCents: 30000 },
    { nickname: "体验会员小陈（模拟）", phone: "19900000003", principalCents: 200000, giftCents: 10000 },
  ];
  const customers = [];
  for (const spec of customerSpecs) customers.push(await createCustomer(db, actor, spec));
  const staff = await createLocalAccount(db, {
    username: "demo.staff", password: passwords["demo.staff"], displayName: "演示前台", tenantId: tenant.id, role: "STAFF",
    allVenues: true, permissions: ["read", "book", "manage_members", "hold_unpaid", "refund"],
  });
  const customerAccount = await createLocalAccount(db, {
    username: "demo.customer", password: passwords["demo.customer"], displayName: "演示球友（模拟）",
    tenantId: tenant.id, customerId: customers[0]!.id,
  });
  const bookingDate = new Date(now.getTime() + 86400000).toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
  const manifest: CloudDemoManifest = {
    version: 1, initializedAt: now.toISOString(), bookingDate, tenantId: tenant.id, tenantName: tenant.name,
    accounts: { "demo.platform": platform.subjectId, "demo.green": tenant.adminSubjectId, "demo.staff": staff.subjectId, "demo.customer": customerAccount.subjectId },
    customerIds: customers.map((customer) => customer.id), venues: [],
  };
  const gateway = new LocalMockPaymentGateway(randomBytes(32).toString("hex"), "local-simulation");
  for (const [venueIndex, name] of ["省体校区", "高新校区"].entries()) {
    const draft = await createVenue(db, actor, { name, address: "演示地址（合成）", timezone: "Asia/Shanghai" });
    const venue = await updateVenue(db, actor, {
      ...draft, expectedRevision: draft.catalogRevision, active: true,
      openingHours: Array.from({ length: 7 }, (_, weekday) => ({ weekday, startMinute: 420, endMinute: 1380 })), minimumBookingMinutes: 30,
    });
    const courts = [];
    for (let index = 1; index <= 4; index++) courts.push(await createCourt(db, actor, {
      venueId: venue.id, name: `${index} 号场`, indoor: index <= 2, surface: "ACRYLIC", profile: { specification: "STANDARD" },
      hourlyPriceCents: index <= 2 ? 12000 : 8000,
    }));
    if (venueIndex === 0) for (const [index, customer] of customers.entries()) {
      const spec = customerSpecs[index]!;
      await recordOfflineTopup(db, actor, {
        venueId: venue.id, customerId: customer.id, principalCents: spec.principalCents, giftCents: spec.giftCents,
        receiptReference: `SYNTHETIC-CLOUD-DEMO-TOPUP-${index + 1}`,
        reason: "合成演示余额；无真实收款，仅用于客户 Demo", commandKey: `cloud-demo-wallet-v1-${index + 1}`,
      });
    }
    const customer = customers[venueIndex]!;
    const quote = await createQuote(db, actor, {
      venueId: venue.id, customerId: customer.id,
      lines: [{ courtId: courts[0]!.id, startAt: `${bookingDate}T18:00:00+08:00`, endAt: `${bookingDate}T19:00:00+08:00` }],
    });
    const order = await confirmQuote(db, actor, { quoteId: quote.id, commandKey: `cloud-demo-order-v1-${venueIndex}` });
    const payment = await beginOrderPayment(db, actor, gateway, {
      orderId: order.id, walletCents: order.totalCents, commandKey: `cloud-demo-payment-v1-${venueIndex}`,
      staffReason: "合成演示订单，使用模拟初始余额支付；无真实款项",
    });
    if (payment.status !== "SUCCEEDED") throw new Error("Cloud demo simulated wallet payment did not settle");
    const occupancyIds = [randomUUID(), randomUUID()];
    await occupyCourt(db, actor, {
      id: occupancyIds[0]!, courtId: courts[2]!.id, kind: "COURSE", sourceId: "演示青少年课程（模拟）",
      startAt: `${bookingDate}T17:00:00+08:00`, endAt: `${bookingDate}T19:00:00+08:00`,
    });
    await occupyCourt(db, actor, {
      id: occupancyIds[1]!, courtId: courts[3]!.id, kind: "MAINTENANCE", sourceId: "演示场地维护（模拟）",
      startAt: `${bookingDate}T12:00:00+08:00`, endAt: `${bookingDate}T13:00:00+08:00`,
    });
    manifest.venues.push({ id: venue.id, name, courtIds: courts.map((court) => court.id), orderId: order.id, occupancyIds });
  }
  await saveTopupOffer(db, actor, { name: "充 1 万送 2 千（模拟）", principalCents: 1000000, giftCents: 200000, active: true });
  await db.query("INSERT INTO tennis.cloud_demo_initializations(id,manifest) VALUES($1,$2::jsonb)", [initializationKey, JSON.stringify(manifest)]);
  return { created: true, manifest };
}

export async function initializeCloudDemo(db: pg.Pool, config: CloudDemoConfig) {
  const tx = await db.connect();
  try {
    const identity = (await tx.query<{ database: string; username: string }>(
      "SELECT current_database() AS database,current_user AS username")).rows[0];
    if (identity?.database !== "tennis_demo" || identity.username !== "tennis_demo")
      throw new Error("Cloud demo initialization refuses a database or role other than tennis_demo");
    await tx.query("BEGIN");
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('tennis:cloud-demo-init',0))");
    const result = await buildCloudDemoData(cloudDemoTransactionPool(tx), config.passwords);
    await tx.query("COMMIT");
    return result;
  } catch (error) {
    await tx.query("ROLLBACK");
    throw error;
  } finally { tx.release(); }
}
