import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { assertLocalTennisDatabaseUrl, localTennisDatabaseUrl } from "../../packages/db/src/tennis/local-config.ts";
import { migrateTennis } from "../../packages/db/src/tennis/migrate.ts";
import { createLocalAccount, provisionTenant } from "../../packages/db/src/tennis/auth.ts";
import {
  createCourt,
  createVenue,
  listCourts,
  listVenues,
  setCourtPrice,
  updateVenue,
} from "../../packages/db/src/tennis/catalog.ts";
import { createCustomer, searchCustomers } from "../../packages/db/src/tennis/customers.ts";
import { recordOfflineTopup } from "../../packages/db/src/tennis/wallet.ts";
import { saveTopupOffer, listTopupOffers } from "../../packages/db/src/tennis/topups.ts";
import { confirmQuote, createQuote, listOrders } from "../../packages/db/src/tennis/booking.ts";
import { beginOrderPayment } from "../../packages/db/src/tennis/payments.ts";
import { LocalMockPaymentGateway } from "../../packages/db/src/tennis/mock-payments.ts";
import { occupyCourt } from "../../packages/db/src/tennis/inventory.ts";

if (process.env.NODE_ENV === "production") throw new Error("Synthetic demo is local-only");
const db = new pg.Pool({
  connectionString: assertLocalTennisDatabaseUrl(
    process.env.TENNIS_DATABASE_URL ?? localTennisDatabaseUrl,
    "development",
  ),
  connectionTimeoutMillis: 5000,
});
const credentialsPath = ".local-workspace/demo-credentials.json";
await mkdir(".local-workspace", { recursive: true });
try {
  await writeFile(
    credentialsPath,
    JSON.stringify(
      {
        password: randomBytes(18).toString("base64url"),
        accounts: ["demo.platform", "demo.green", "demo.staff", "demo.customer", "demo.second"],
      },
      null,
      2,
    ),
    { flag: "wx", mode: 0o600 },
  );
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
}
const { password } = JSON.parse(await readFile(credentialsPath, "utf8")) as { password: string };
async function account(username: string) {
  return (
    await db.query<{ subjectId: string; displayName: string }>(
      `SELECT a.subject_id AS "subjectId",s.display_name AS "displayName" FROM tennis.local_accounts a JOIN tennis.subjects s ON s.id=a.subject_id WHERE a.username=$1`,
      [username],
    )
  ).rows[0];
}
try {
  const tx = await db.connect();
  try {
    await migrateTennis(tx);
  } finally {
    tx.release();
  }
  let operator = await account("demo.platform");
  if (!operator)
    operator = await createLocalAccount(db, {
      username: "demo.platform",
      password,
      displayName: "演示平台运营（模拟）",
      platformOperator: true,
    });
  if (operator.displayName !== "演示平台运营（模拟）")
    throw new Error("Demo account collides with an unrelated account");
  const report: Record<string, unknown> = { credentialsPath, tenants: [] };
  for (const spec of [
    { username: "demo.green", name: "格林网球（模拟租户）", courtCount: 4 },
    { username: "demo.second", name: "第二租户（隔离演示）", courtCount: 2 },
  ]) {
    let admin = await account(spec.username);
    if (!admin) {
      await provisionTenant(db, operator.subjectId, {
        name: spec.name,
        adminUsername: spec.username,
        adminDisplayName: spec.name + "管理员",
        adminPassword: password,
      });
      admin = await account(spec.username);
    }
    const tenant = (
      await db.query<{ id: string; name: string }>(
        "SELECT t.id,t.name FROM tennis.tenants t JOIN tennis.tenant_memberships m ON m.tenant_id=t.id WHERE m.subject_id=$1 AND m.role='ADMIN'",
        [admin!.subjectId],
      )
    ).rows[0]!;
    if (tenant.name !== spec.name) throw new Error("Synthetic tenant mismatch");
    const actor = { tenantId: tenant.id, subjectId: admin!.subjectId };
    let venue = (await listVenues(db, actor)).find((value) => value.name === "省体校区（模拟）");
    if (!venue)
      venue = await createVenue(db, actor, {
        name: "省体校区（模拟）",
        address: "模拟地址 · 仅用于本地验收",
        timezone: "Asia/Shanghai",
      });
    if (venue.minimumBookingMinutes === null)
      venue = await updateVenue(db, actor, {
        id: venue.id,
        expectedRevision: venue.catalogRevision,
        name: venue.name,
        address: venue.address,
        timezone: venue.timezone,
        active: true,
        openingHours: Array.from({ length: 7 }, (_, weekday) => ({ weekday, startMinute: 420, endMinute: 1380 })),
        minimumBookingMinutes: 30,
      });
    let courts = await listCourts(db, actor, venue.id);
    for (let index = 1; index <= spec.courtCount; index++) {
      let court = courts.find((value) => value.name === `${index} 号场`);
      if (!court)
        court = await createCourt(db, actor, { venueId: venue.id, name: `${index} 号场`, indoor: index <= 2 });
      if (court.hourlyPriceCents === null)
        await setCourtPrice(db, actor, {
          venueId: venue.id,
          courtId: court.id,
          expectedRevision: court.revision,
          hourlyPriceCents: index <= 2 ? 12000 : 8000,
        });
    }
    courts = await listCourts(db, actor, venue.id);
    let customer = (await searchCustomers(db, actor, "演示球友")).find((value) => value.nickname === "演示球友");
    if (!customer) customer = await createCustomer(db, actor, { nickname: "演示球友" });
    await recordOfflineTopup(db, actor, {
      venueId: venue.id,
      customerId: customer.id,
      principalCents: 1000000,
      giftCents: 200000,
      receiptReference: "LOCAL-DEMO-10000-2000",
      reason: "合成初始充值，仅用于本地演示",
      commandKey: "demo-wallet-initial-v1",
    });
    if (!(await listTopupOffers(db, actor)).some((value) => value.name === "充 1 万送 2 千（模拟）"))
      await saveTopupOffer(db, actor, {
        name: "充 1 万送 2 千（模拟）",
        principalCents: 1000000,
        giftCents: 200000,
        active: true,
      });
    if (spec.username === "demo.green") {
      if (!(await account("demo.staff")))
        await createLocalAccount(db, {
          username: "demo.staff",
          password,
          displayName: "演示前台（模拟）",
          tenantId: tenant.id,
          role: "STAFF",
          allVenues: true,
          permissions: ["read", "book", "manage_members", "hold_unpaid", "refund"],
        });
      if (!(await account("demo.customer")))
        await createLocalAccount(db, {
          username: "demo.customer",
          password,
          displayName: "演示球友（模拟）",
          tenantId: tenant.id,
          customerId: customer.id,
        });
      if ((await listOrders(db, actor, venue.id)).length === 0) {
        const tomorrow = new Date(Date.now() + 86400000).toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
        const quote = await createQuote(db, actor, {
          venueId: venue.id,
          customerId: customer.id,
          lines: courts
            .slice(0, 2)
            .map((court) => ({
              courtId: court.id,
              startAt: `${tomorrow}T18:00:00+08:00`,
              endAt: `${tomorrow}T19:00:00+08:00`,
            })),
        });
        const order = await confirmQuote(db, actor, { quoteId: quote.id, commandKey: "demo-order-confirm-v1" });
        await beginOrderPayment(
          db,
          actor,
          new LocalMockPaymentGateway(randomBytes(32).toString("hex"), "local-simulation"),
          {
            orderId: order.id,
            walletCents: order.totalCents,
            commandKey: "demo-order-pay-v1",
            staffReason: "本地模拟代订及余额支付",
          },
        );
        await occupyCourt(db, actor, {
          id: randomUUID(),
          courtId: courts[2]!.id,
          kind: "COURSE",
          sourceId: "DEMO-COURSE",
          startAt: `${tomorrow}T17:00:00+08:00`,
          endAt: `${tomorrow}T19:00:00+08:00`,
        });
      }
    }
    (report.tenants as unknown[]).push({
      id: tenant.id,
      name: tenant.name,
      venueId: venue.id,
      customerId: customer.id,
    });
  }
  await writeFile(".local-workspace/demo-data.json", JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(
    "合成演示数据就绪；账号与随机密码保存在 .local-workspace/demo-credentials.json。未使用真实客户、商户或款项。",
  );
} finally {
  await db.end();
}
