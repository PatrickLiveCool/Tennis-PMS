import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertLocalTennisDatabaseUrl, localTennisTestDatabaseUrl } from "../../packages/db/src/tennis/local-config.ts";
import { migrateTennis } from "../../packages/db/src/tennis/migrate.ts";
import { createCourt, listVenues, setCourtPrice, updateVenue } from "../../packages/db/src/tennis/catalog.ts";
import { createCustomer, type CustomerActor } from "../../packages/db/src/tennis/customers.ts";
import { confirmQuote, createQuote, getOrder } from "../../packages/db/src/tennis/booking.ts";
import { beginOrderPayment, getOrderPayment } from "../../packages/db/src/tennis/payments.ts";
import { getWallet, recordOfflineTopup } from "../../packages/db/src/tennis/wallet.ts";
import { beginTopupPayment, createTopupQuote, getTopupPayment } from "../../packages/db/src/tennis/topups.ts";
import { getRefund, requestOrderRefund, requestOrderRefundGroup, retryFailedRefund } from "../../packages/db/src/tennis/refunds.ts";
import { LocalMockPaymentGateway } from "../../packages/db/src/tennis/mock-payments.ts";
import { postgresMockChannelStore } from "../../packages/db/src/tennis/mock-channel-store.ts";
import { saveMerchantBinding } from "../../packages/db/src/tennis/merchant-bindings.ts";
import {
  paymentEventSemanticHash,
  type PaymentPortInput,
  type RefundPortInput,
  type VerifiedPaymentEvent,
} from "../../packages/db/src/tennis/payment-port.ts";
import {
  acceptPaymentNotification,
  getPaymentChannel,
  processDueChannelOperations,
  reconcilePaymentChannel,
  simulatePaymentChannel,
  type ChannelSource,
} from "../../packages/db/src/tennis/payment-channel.ts";
import { beginAmendmentPayment, confirmOrderAmendment, previewOrderAmendment } from "../../packages/db/src/tennis/amendments.ts";
import { enqueueRefundChannel } from "../../packages/db/src/tennis/channel-intents.ts";
import { requestHash } from "../../packages/db/src/tennis/receipts.ts";
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
const secret = "synthetic-persistent-channel-test-signing-secret";
const key = () => randomUUID();
const mock = () => new LocalMockPaymentGateway(secret, "local-simulation", postgresMockChannelStore(db));
class RecordingGateway extends LocalMockPaymentGateway {
  paymentCreates: PaymentPortInput[] = [];
  paymentQueries: PaymentPortInput[] = [];
  refundCreates: RefundPortInput[] = [];
  loseNextCreateResponse = false;
  constructor() {
    super(secret, "local-simulation", postgresMockChannelStore(db));
  }
  override async createPayment(input: PaymentPortInput) {
    this.paymentCreates.push(input);
    const result = await super.createPayment(input);
    if (this.loseNextCreateResponse) {
      this.loseNextCreateResponse = false;
      throw new Error("Synthetic connection lost after channel accepted the original payment");
    }
    return result;
  }
  override async queryPayment(input: PaymentPortInput) {
    this.paymentQueries.push(input);
    return super.queryPayment(input);
  }
  override async createRefund(input: RefundPortInput) {
    this.refundCreates.push(input);
    return super.createRefund(input);
  }
}
let first: TenantFixture, second: TenantFixture;
let customer: CustomerActor;
let courtId: string;
const subjects: string[] = [];
async function booking(hour = 19) {
  const quote = await createQuote(db, customer, {
    venueId: first.venueId,
    customerId: customer.customerId,
    lines: [{ courtId, startAt: `2099-09-18T${hour}:00:00+08:00`, endAt: `2099-09-18T${hour + 1}:00:00+08:00` }],
  });
  return confirmQuote(db, customer, { quoteId: quote.id, commandKey: key() });
}
async function credit(principalCents = 10000, giftCents = 2000) {
  await recordOfflineTopup(db, first.actor, {
    venueId: first.venueId,
    customerId: customer.customerId,
    principalCents,
    giftCents,
    receiptReference: key(),
    reason: "合成线下充值凭据",
    commandKey: key(),
  });
}
async function onlineTopup(gateway = mock()) {
  const quote = await createTopupQuote(db, customer, {
    venueId: first.venueId,
    customerId: customer.customerId,
    principalCents: 10000,
  });
  return beginTopupPayment(db, customer, gateway, { quoteId: quote.id, commandKey: key() });
}
async function operation<T extends PaymentPortInput | RefundPortInput>(kind: ChannelSource, sourceId: string) {
  const row = (
    await db.query<{ id: string; request: T; state: string }>(
      "SELECT id,request,state FROM tennis.channel_operations WHERE tenant_id=$1 AND source_kind=$2 AND source_id=$3 ORDER BY generation DESC LIMIT 1",
      [first.actor.tenantId, kind, sourceId],
    )
  ).rows[0];
  expect(row).toBeDefined();
  return row!;
}
/** Persist the same authenticated facts that the coordinator writes, stopping at the crash boundary before application. */
async function persistUnappliedPaymentObservation(operationId: string, event: VerifiedPaymentEvent) {
  const id = key();
  await db.query(
    `INSERT INTO tennis.channel_observations(id,operation_id,tenant_id,provider,merchant_id,event_kind,event_id,semantic_hash,payload)
     VALUES($1,$2,$3,$4,$5,'PAYMENT',$6,$7,$8::jsonb)`,
    [
      id,
      operationId,
      first.actor.tenantId,
      event.provider,
      event.merchantId,
      event.eventId,
      paymentEventSemanticHash(event),
      JSON.stringify(event),
    ],
  );
  return id;
}
/** Model an F8 upgrade: keep business receipts and money history, remove only the later channel-layer records. */
async function removeChannelLayer(kind: ChannelSource, sourceId: string) {
  const tx = await db.connect();
  try {
    await tx.query("BEGIN");
    for (const table of ["mock_channel_records", "channel_observations"])
      await tx.query(
        `DELETE FROM tennis.${table} r USING tennis.channel_operations o WHERE r.operation_id=o.id AND o.tenant_id=$1 AND o.source_kind=$2 AND o.source_id=$3`,
        [first.actor.tenantId, kind, sourceId],
      );
    await tx.query("DELETE FROM tennis.channel_operations WHERE tenant_id=$1 AND source_kind=$2 AND source_id=$3", [
      first.actor.tenantId,
      kind,
      sourceId,
    ]);
    await tx.query("COMMIT");
  } catch (error) {
    await tx.query("ROLLBACK");
    throw error;
  } finally {
    tx.release();
  }
}
async function count(table: string) {
  // Every caller supplies a fixed test table name, never user input.
  return (
    await db.query<{ count: number }>(`SELECT count(*)::int AS count FROM tennis.${table} WHERE tenant_id=$1`, [
      first.actor.tenantId,
    ])
  ).rows[0]!.count;
}
async function fullRefund(orderId: string) {
  const paid = await getOrder(db, first.actor, orderId);
  return requestOrderRefund(db, first.actor, {
    orderId,
    expectedRevision: paid.revision,
    reason: "员工核准原路退回合成付款",
    commandKey: key(),
    lines: [{ lineId: paid.lines[0]!.id, refundCents: paid.totalCents, cancel: true }],
  });
}
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
  const venue = (await listVenues(db, first.actor)).find((row) => row.id === first.venueId)!;
  await updateVenue(db, first.actor, {
    ...venue,
    expectedRevision: venue.catalogRevision,
    minimumBookingMinutes: 15,
    openingHours: Array.from({ length: 7 }, (_, weekday) => ({ weekday, startMinute: 480, endMinute: 1320 })),
  });
  const court = await createCourt(db, first.actor, { venueId: first.venueId, name: "渠道测试球场", indoor: true });
  courtId = court.id;
  await setCourtPrice(db, first.actor, {
    venueId: first.venueId,
    courtId,
    expectedRevision: court.revision,
    hourlyPriceCents: 12000,
  });
  const profile = await createCustomer(db, first.actor, { nickname: "合成渠道测试客户" });
  const subjectId = key();
  subjects.push(subjectId);
  await db.query("INSERT INTO tennis.subjects(id,display_name) VALUES($1,'synthetic channel customer')", [subjectId]);
  await db.query("UPDATE tennis.customers SET subject_id=$1 WHERE tenant_id=$2 AND id=$3", [
    subjectId,
    first.actor.tenantId,
    profile.id,
  ]);
  customer = { tenantId: first.actor.tenantId, subjectId, customerId: profile.id, kind: "customer" };
});
afterEach(async () => {
  for (const fixture of [first, second]) {
    if (!fixture) continue;
    await db.query("DELETE FROM tennis.platform_operators WHERE subject_id=$1", [fixture.actor.subjectId]);
    await removeTenantFixture(db, fixture);
  }
  for (const id of subjects.splice(0)) await db.query("DELETE FROM tennis.subjects WHERE id=$1", [id]);
});
afterAll(async () => {
  await db.end();
});

describe("durable payment channel reconciliation", () => {
  it("settles pure wallet payments without creating a merchant or channel operation", async () => {
    await credit();
    const order = await booking();
    const gateway = new RecordingGateway();
    const payment = await beginOrderPayment(db, customer, gateway, {
      orderId: order.id,
      walletCents: 12000,
      commandKey: key(),
    });
    expect(payment).toMatchObject({ provider: "WALLET", status: "SUCCEEDED", externalCents: 0 });
    expect(await getPaymentChannel(db, customer, "ORDER", payment.id, gateway)).toMatchObject({
      state: "NOT_REQUIRED",
      operationId: null,
      canReconcile: false,
    });
    expect(await count("channel_operations")).toBe(0);
    expect(await count("payment_merchant_bindings")).toBe(0);
    expect(gateway.paymentCreates).toHaveLength(0);
    expect((await getWallet(db, customer, customer.customerId)).balance.totalCents).toBe(0);
  });

  it("creates one pending mixed-payment channel intent and reserves rather than consumes wallet funds", async () => {
    await credit();
    const order = await booking();
    const gateway = new RecordingGateway();
    const input = { orderId: order.id, walletCents: 6000, commandKey: key() };
    const payment = await beginOrderPayment(db, customer, gateway, input);
    expect(await beginOrderPayment(db, customer, gateway, input)).toEqual(payment);
    expect(gateway.paymentCreates).toHaveLength(0);
    expect(await getPaymentChannel(db, customer, "ORDER", payment.id, gateway)).toMatchObject({
      state: "READY",
      canReconcile: true,
    });
    const channel = await reconcilePaymentChannel(db, customer, "ORDER", payment.id, gateway);
    expect(channel).toMatchObject({
      state: "PENDING",
      simulation: true,
      checkout: { kind: "LOCAL_SIMULATION", operationId: channel.operationId },
    });
    expect(gateway.paymentCreates).toHaveLength(1);
    expect(await count("channel_operations")).toBe(1);
    expect(await count("mock_channel_records")).toBe(1);
    expect(await getOrder(db, customer, order.id)).toMatchObject({ status: "HELD", paymentStatus: "UNPAID" });
    const wallet = await getWallet(db, customer, customer.customerId);
    expect(wallet.balance).toMatchObject({ totalCents: 12000, availableCents: 6000, reservedCents: 6000 });
    expect(wallet.entries.filter((row) => row.kind === "CONSUME")).toHaveLength(0);
  });

  it("recovers a lost create response through the same durable payment after gateway restart", async () => {
    await credit();
    const order = await booking();
    const lost = new RecordingGateway();
    const payment = await beginOrderPayment(db, customer, lost, {
      orderId: order.id,
      walletCents: 6000,
      commandKey: key(),
    });
    lost.loseNextCreateResponse = true;
    expect(await reconcilePaymentChannel(db, customer, "ORDER", payment.id, lost)).toMatchObject({ state: "UNKNOWN" });
    expect(lost.paymentCreates).toHaveLength(1);
    expect((await getWallet(db, customer, customer.customerId)).balance).toMatchObject({
      totalCents: 12000,
      reservedCents: 6000,
    });
    const original = await operation<PaymentPortInput>("ORDER", payment.id);
    const restarted = new RecordingGateway();
    expect(await reconcilePaymentChannel(db, customer, "ORDER", payment.id, restarted)).toMatchObject({
      operationId: original.id,
      state: "PENDING",
    });
    expect(restarted.paymentCreates).toHaveLength(0);
    expect(restarted.paymentQueries).toHaveLength(1);
    expect(await mock().simulatePayment(original.request, "SUCCEEDED")).toMatchObject({ status: "SUCCEEDED" });
    const recovered = new RecordingGateway();
    expect(await reconcilePaymentChannel(db, customer, "ORDER", payment.id, recovered)).toMatchObject({
      operationId: original.id,
      state: "SUCCEEDED",
    });
    await reconcilePaymentChannel(db, customer, "ORDER", payment.id, recovered);
    expect(recovered.paymentCreates).toHaveLength(0);
    expect(recovered.paymentQueries).toHaveLength(1);
    expect(await count("orders")).toBe(1);
    expect(await count("payment_attempts")).toBe(1);
    expect(await count("channel_operations")).toBe(1);
    expect(await count("mock_channel_records")).toBe(1);
    expect(await count("external_payment_receipts")).toBe(1);
    expect(await getOrder(db, customer, order.id)).toMatchObject({ status: "CONFIRMED", paymentStatus: "PAID" });
    const wallet = await getWallet(db, customer, customer.customerId);
    expect(wallet.balance).toMatchObject({ totalCents: 6000, reservedCents: 0, principalCents: 5000, giftCents: 1000 });
    expect(wallet.entries.filter((row) => row.kind === "CONSUME")).toHaveLength(1);
  });

  it("credits a recovered online topup once across fresh gateway instances", async () => {
    const lost = new RecordingGateway();
    const payment = await onlineTopup(lost);
    lost.loseNextCreateResponse = true;
    expect(await reconcilePaymentChannel(db, customer, "TOPUP", payment.id, lost)).toMatchObject({ state: "UNKNOWN" });
    expect((await getWallet(db, customer, customer.customerId)).balance.totalCents).toBe(0);
    const original = await operation<PaymentPortInput>("TOPUP", payment.id);
    expect(await mock().simulatePayment(original.request, "SUCCEEDED")).toMatchObject({ status: "SUCCEEDED" });
    const restarted = new RecordingGateway();
    expect(await reconcilePaymentChannel(db, customer, "TOPUP", payment.id, restarted)).toMatchObject({
      state: "SUCCEEDED",
      operationId: original.id,
    });
    await reconcilePaymentChannel(db, customer, "TOPUP", payment.id, mock());
    expect(restarted.paymentCreates).toHaveLength(0);
    expect(restarted.paymentQueries).toHaveLength(1);
    expect(await getTopupPayment(db, customer, payment.id)).toMatchObject({ status: "SUCCEEDED" });
    expect(await count("topup_payments")).toBe(1);
    expect(await count("wallet_batches")).toBe(1);
    const wallet = await getWallet(db, customer, customer.customerId);
    expect(wallet.balance).toMatchObject({ totalCents: 10000, principalCents: 10000, giftCents: 0 });
    expect(wallet.entries.filter((row) => row.kind === "TOPUP")).toHaveLength(1);
  });

  it("projects historical successful payment and topup receipts without rebuilding channel operations", async () => {
    const gateway = mock();
    const order = await booking();
    const payment = await beginOrderPayment(db, customer, gateway, {
      orderId: order.id,
      walletCents: 0,
      commandKey: key(),
    });
    await simulatePaymentChannel(db, customer, "ORDER", payment.id, gateway, "SUCCEEDED");
    const topup = await onlineTopup(gateway);
    await simulatePaymentChannel(db, customer, "TOPUP", topup.id, gateway, "SUCCEEDED");
    const originalPayment = await getOrderPayment(db, customer, payment.id);
    const originalTopup = await getTopupPayment(db, customer, topup.id);
    await removeChannelLayer("ORDER", payment.id);
    await removeChannelLayer("TOPUP", topup.id);
    const restarted = new RecordingGateway();
    for (const [kind, id] of [
      ["ORDER", payment.id],
      ["TOPUP", topup.id],
    ] as const) {
      expect(await getPaymentChannel(db, customer, kind, id, restarted)).toMatchObject({
        sourceId: id,
        operationId: null,
        provider: "MOCK",
        simulation: true,
        state: "SUCCEEDED",
        canReconcile: false,
      });
      expect(await reconcilePaymentChannel(db, customer, kind, id, restarted)).toMatchObject({
        operationId: null,
        state: "SUCCEEDED",
      });
    }
    expect(restarted.paymentCreates).toHaveLength(0);
    expect(restarted.paymentQueries).toHaveLength(0);
    expect(await count("channel_operations")).toBe(0);
    expect(await count("mock_channel_records")).toBe(0);
    expect(await count("channel_observations")).toBe(0);
    expect(await getOrderPayment(db, customer, payment.id)).toEqual(originalPayment);
    expect(await getTopupPayment(db, customer, topup.id)).toEqual(originalTopup);
    expect(await count("payment_events")).toBe(1);
    expect(await count("topup_events")).toBe(1);
    expect(await count("channel_transactions")).toBe(2);
    const wallet = await getWallet(db, customer, customer.customerId);
    expect(wallet.balance.totalCents).toBe(10000);
    expect(wallet.entries.filter((row) => row.kind === "TOPUP")).toHaveLength(1);
  });

  it("recognizes a historical verified refund failure and restores a safe new retry generation", async () => {
    await credit();
    const gateway = mock();
    const order = await booking();
    const payment = await beginOrderPayment(db, customer, gateway, {
      orderId: order.id,
      walletCents: 6000,
      commandKey: key(),
    });
    await simulatePaymentChannel(db, customer, "ORDER", payment.id, gateway, "SUCCEEDED");
    const paid = await getOrderPayment(db, customer, payment.id);
    const refund = await fullRefund(order.id);
    await simulatePaymentChannel(db, first.actor, "REFUND", refund.id, gateway, "FAILED");
    await removeChannelLayer("REFUND", refund.id);
    await removeChannelLayer("ORDER", payment.id);
    expect(await count("channel_operations")).toBe(0);
    expect(await count("refund_events")).toBe(1);
    expect(await getPaymentChannel(db, first.actor, "REFUND", refund.id, gateway)).toMatchObject({
      sourceId: refund.id,
      operationId: null,
      provider: paid.provider,
      simulation: true,
      state: "FAILED",
      canReconcile: false,
    });
    const commandKey = key();
    expect(await retryFailedRefund(db, first.actor, refund.id, commandKey)).toMatchObject({
      id: refund.id,
      status: "REQUESTED",
    });
    await retryFailedRefund(db, first.actor, refund.id, commandKey);
    const restored = await operation<RefundPortInput>("REFUND", refund.id);
    expect(restored.request).toMatchObject({
      binding: { merchantId: paid.merchantId },
      sourceId: payment.id,
      refundId: refund.id,
      transactionId: paid.providerTransactionId,
    });
    expect(
      (
        await db.query(
          "SELECT generation,state FROM tennis.channel_operations WHERE tenant_id=$1 AND source_kind='REFUND' AND source_id=$2 ORDER BY generation",
          [first.actor.tenantId, refund.id],
        )
      ).rows,
    ).toEqual([
      { generation: 1, state: "FAILED" },
      { generation: 2, state: "READY" },
    ]);
    expect(await reconcilePaymentChannel(db, first.actor, "REFUND", refund.id, gateway)).toMatchObject({
      operationId: restored.id,
      state: "PENDING",
    });
    await simulatePaymentChannel(db, first.actor, "REFUND", refund.id, mock(), "SUCCEEDED");
    expect(await getRefund(db, customer, refund.id)).toMatchObject({ status: "SUCCEEDED" });
    expect(await count("refunds")).toBe(1);
    expect(await count("external_refund_receipts")).toBe(1);
    expect(await count("channel_operations")).toBe(2);
    const wallet = await getWallet(db, customer, customer.customerId);
    expect(wallet.balance).toMatchObject({ totalCents: 12000, principalCents: 10000, giftCents: 2000 });
    expect(wallet.entries.filter((row) => row.kind === "REFUND")).toHaveLength(1);
  });

  it("recovers a durable unapplied observation and repeats settlement safely after a second crash boundary", async () => {
    await credit();
    const order = await booking();
    const gateway = mock();
    const payment = await beginOrderPayment(db, customer, gateway, {
      orderId: order.id,
      walletCents: 6000,
      commandKey: key(),
    });
    const original = await operation<PaymentPortInput>("ORDER", payment.id);
    const accepted = await gateway.simulatePayment(original.request, "SUCCEEDED");
    if (accepted.status !== "SUCCEEDED") throw new Error("Synthetic channel success is missing");
    const observationId = await persistUnappliedPaymentObservation(original.id, accepted.event);
    expect(await getOrderPayment(db, customer, payment.id)).toMatchObject({ status: "PENDING" });
    expect((await getWallet(db, customer, customer.customerId)).balance).toMatchObject({
      totalCents: 12000,
      reservedCents: 6000,
    });
    const restarted = new RecordingGateway();
    await processDueChannelOperations(db, restarted);
    expect(await getOrderPayment(db, customer, payment.id)).toMatchObject({ status: "SUCCEEDED" });
    expect((await operation<PaymentPortInput>("ORDER", payment.id)).state).toBe("SUCCEEDED");
    expect(
      (await db.query("SELECT applied_at FROM tennis.channel_observations WHERE id=$1", [observationId])).rows[0]
        .applied_at,
    ).toBeInstanceOf(Date);
    expect(restarted.paymentCreates).toHaveLength(0);
    expect(restarted.paymentQueries).toHaveLength(0);
    // Now model a crash after the idempotent business commit but before its durable projection commit.
    await db.query("UPDATE tennis.channel_observations SET applied_at=NULL WHERE id=$1", [observationId]);
    await db.query("UPDATE tennis.channel_operations SET state='UNKNOWN',next_check_at=clock_timestamp() WHERE id=$1", [
      original.id,
    ]);
    await processDueChannelOperations(db, restarted);
    expect((await operation<PaymentPortInput>("ORDER", payment.id)).state).toBe("SUCCEEDED");
    expect(
      (await db.query("SELECT applied_at FROM tennis.channel_observations WHERE id=$1", [observationId])).rows[0]
        .applied_at,
    ).toBeInstanceOf(Date);
    expect(await count("external_payment_receipts")).toBe(1);
    const wallet = await getWallet(db, customer, customer.customerId);
    expect(wallet.balance).toMatchObject({ totalCents: 6000, reservedCents: 0 });
    expect(wallet.entries.filter((row) => row.kind === "CONSUME")).toHaveLength(1);
  });

  it("backs off a conflicting durable observation without blocking the following ready channel operation", async () => {
    const gateway = mock();
    const order = await booking();
    const captured = await beginOrderPayment(db, customer, gateway, {
      orderId: order.id,
      walletCents: 0,
      commandKey: key(),
    });
    await simulatePaymentChannel(db, customer, "ORDER", captured.id, gateway, "SUCCEEDED");
    const paid = await getOrderPayment(db, customer, captured.id);
    const one = await onlineTopup(gateway),
      two = await onlineTopup(gateway);
    const candidates = [
      { payment: one, operation: await operation<PaymentPortInput>("TOPUP", one.id) },
      { payment: two, operation: await operation<PaymentPortInput>("TOPUP", two.id) },
    ].sort((left, right) => (left.operation.id < right.operation.id ? -1 : 1));
    const [toxic, healthy] = candidates;
    // A genuinely authenticated but contradictory observation reuses an already captured transaction.
    const signed = gateway.signForLocalSimulator({
      provider: "MOCK",
      merchantId: toxic!.payment.merchantId,
      paymentId: toxic!.payment.id,
      eventId: `synthetic-conflicting-capture:${key()}`,
      transactionId: paid.providerTransactionId!,
      status: "SUCCEEDED",
      amountCents: toxic!.payment.principalCents,
      currency: "CNY",
      issuedAt: Date.now(),
    });
    const observationId = await persistUnappliedPaymentObservation(
      toxic!.operation.id,
      gateway.verify(signed.body, signed.signature),
    );
    const worker = new RecordingGateway();
    await expect(processDueChannelOperations(db, worker)).resolves.toBeUndefined();
    expect(worker.paymentCreates.map((input) => input.sourceId)).toEqual([healthy!.payment.id]);
    expect((await operation<PaymentPortInput>("TOPUP", healthy!.payment.id)).state).toBe("PENDING");
    const failed = (
      await db.query<{ state: string; last_error: string; next_check_at: Date; backed_off: boolean }>(
        "SELECT state,last_error,next_check_at,next_check_at>clock_timestamp()+interval '4 minutes' AS backed_off FROM tennis.channel_operations WHERE id=$1",
        [toxic!.operation.id],
      )
    ).rows[0]!;
    expect(failed).toMatchObject({ state: "UNKNOWN", last_error: "REQUIRES_RECONCILIATION", backed_off: true });
    expect(
      (await db.query("SELECT applied_at FROM tennis.channel_observations WHERE id=$1", [observationId])).rows[0]
        .applied_at,
    ).toBeNull();
    expect(await getTopupPayment(db, customer, toxic!.payment.id)).toMatchObject({
      status: "PENDING",
      walletBatchId: null,
    });
    expect((await getWallet(db, customer, customer.customerId)).balance.totalCents).toBe(0);
    expect(await count("channel_transactions")).toBe(1);
    await processDueChannelOperations(db, worker);
    expect(
      (
        await db.query<{ next_check_at: Date }>("SELECT next_check_at FROM tennis.channel_operations WHERE id=$1", [
          toxic!.operation.id,
        ])
      ).rows[0]!.next_check_at,
    ).toEqual(failed.next_check_at);
    expect(worker.paymentCreates).toHaveLength(1);
    expect(worker.paymentQueries).toHaveLength(0);
  });

  it("settles concurrent notification and query once, including replay with a new envelope timestamp", async () => {
    await credit();
    const order = await booking();
    const gateway = mock();
    const payment = await beginOrderPayment(db, customer, gateway, {
      orderId: order.id,
      walletCents: 6000,
      commandKey: key(),
    });
    await reconcilePaymentChannel(db, customer, "ORDER", payment.id, gateway);
    const original = await operation<PaymentPortInput>("ORDER", payment.id);
    const success = await gateway.simulatePayment(original.request, "SUCCEEDED");
    if (success.status !== "SUCCEEDED") throw new Error("Synthetic success was not persisted");
    const notificationPayload = {
      ...success.event,
      provider: "MOCK" as const,
      issuedAt: Date.now(),
      operationId: original.id,
    };
    const notification = gateway.signForLocalSimulator(notificationPayload);
    await Promise.all([
      acceptPaymentNotification(db, gateway, original.id, notification.body, {
        "x-mock-signature": notification.signature,
      }),
      reconcilePaymentChannel(db, customer, "ORDER", payment.id, mock()),
    ]);
    const replayPayload = { ...notificationPayload, issuedAt: Date.now() + 1000 };
    const replay = gateway.signForLocalSimulator(replayPayload);
    await acceptPaymentNotification(db, mock(), original.id, replay.body, { "x-mock-signature": replay.signature });
    expect(await getOrderPayment(db, customer, payment.id)).toMatchObject({
      status: "SUCCEEDED",
      providerTransactionId: success.event.transactionId,
    });
    expect(await count("channel_observations")).toBe(1);
    expect(await count("external_payment_receipts")).toBe(1);
    expect(
      (await getWallet(db, customer, customer.customerId)).entries.filter((row) => row.kind === "CONSUME"),
    ).toHaveLength(1);
  });

  it("keeps refunds on the original merchant snapshot after the active merchant rotates", async () => {
    const gateway = mock();
    const order = await booking();
    const payment = await beginOrderPayment(db, customer, gateway, {
      orderId: order.id,
      walletCents: 0,
      commandKey: key(),
    });
    await simulatePaymentChannel(db, customer, "ORDER", payment.id, gateway, "SUCCEEDED");
    const original = await operation<PaymentPortInput>("ORDER", payment.id);
    await db.query("INSERT INTO tennis.platform_operators(subject_id) VALUES($1)", [first.actor.subjectId]);
    const replacement = await saveMerchantBinding(db, first.actor.subjectId, {
      tenantId: first.actor.tenantId,
      provider: "MOCK",
      merchantId: `mock:rotated:${key()}`,
      expectedVersion: original.request.binding.version,
    });
    const newerOrder = await booking(20);
    const newer = await beginOrderPayment(db, customer, gateway, {
      orderId: newerOrder.id,
      walletCents: 0,
      commandKey: key(),
    });
    expect(newer.merchantId).toBe(replacement.merchantId);
    const refund = await fullRefund(order.id);
    const pendingRefund = await operation<RefundPortInput>("REFUND", refund.id);
    expect(pendingRefund.request.binding).toEqual(original.request.binding);
    expect(pendingRefund.request.merchantOrderNo).toBe(original.request.merchantOrderNo);
    const recording = new RecordingGateway();
    expect(await reconcilePaymentChannel(db, first.actor, "REFUND", refund.id, recording)).toMatchObject({
      state: "PENDING",
    });
    expect(recording.refundCreates[0]?.binding).toEqual(original.request.binding);
    await simulatePaymentChannel(db, first.actor, "REFUND", refund.id, mock(), "SUCCEEDED");
    expect(await getRefund(db, customer, refund.id)).toMatchObject({ status: "SUCCEEDED" });
    expect(await getOrderPayment(db, customer, payment.id)).toMatchObject({
      merchantId: original.request.binding.merchantId,
    });
  });

  it("retries a definitively failed refund as a new channel attempt while refunding the original allocation once", async () => {
    await credit();
    const gateway = mock();
    const order = await booking();
    const payment = await beginOrderPayment(db, customer, gateway, {
      orderId: order.id,
      walletCents: 6000,
      commandKey: key(),
    });
    await simulatePaymentChannel(db, customer, "ORDER", payment.id, gateway, "SUCCEEDED");
    const refund = await fullRefund(order.id);
    const firstAttempt = await operation<RefundPortInput>("REFUND", refund.id);
    await simulatePaymentChannel(db, first.actor, "REFUND", refund.id, gateway, "FAILED");
    expect(await getPaymentChannel(db, first.actor, "REFUND", refund.id, gateway)).toMatchObject({ state: "FAILED" });
    expect((await getWallet(db, customer, customer.customerId)).balance.totalCents).toBe(6000);
    await db.query("UPDATE tennis.channel_operations SET state='UNKNOWN' WHERE id=$1", [firstAttempt.id]);
    await expect(retryFailedRefund(db, first.actor, refund.id, key())).rejects.toMatchObject({
      code: "CHANNEL_RESULT_UNKNOWN",
    });
    expect((await operation<RefundPortInput>("REFUND", refund.id)).id).toBe(firstAttempt.id);
    expect(await reconcilePaymentChannel(db, first.actor, "REFUND", refund.id, gateway)).toMatchObject({
      state: "FAILED",
    });
    const commandKey = key();
    expect(await retryFailedRefund(db, first.actor, refund.id, commandKey)).toMatchObject({
      id: refund.id,
      status: "REQUESTED",
    });
    await retryFailedRefund(db, first.actor, refund.id, commandKey);
    const secondAttempt = await operation<RefundPortInput>("REFUND", refund.id);
    expect(secondAttempt.id).not.toBe(firstAttempt.id);
    expect(secondAttempt.request.merchantRefundNo).not.toBe(firstAttempt.request.merchantRefundNo);
    expect(secondAttempt.request).toMatchObject({
      binding: firstAttempt.request.binding,
      sourceId: payment.id,
      transactionId: firstAttempt.request.transactionId,
      refundId: refund.id,
      amountCents: firstAttempt.request.amountCents,
    });
    const previousFailure = await gateway.queryRefund(firstAttempt.request);
    if (previousFailure.status !== "DEFINITIVELY_FAILED") throw new Error("Original failed channel result is missing");
    const oldNotificationPayload = {
      ...previousFailure.event,
      provider: "MOCK" as const,
      issuedAt: Date.now(),
      operationId: firstAttempt.id,
    };
    const oldNotification = gateway.signForLocalSimulator(oldNotificationPayload);
    await expect(
      acceptPaymentNotification(db, gateway, secondAttempt.id, oldNotification.body, {
        "x-mock-signature": oldNotification.signature,
      }),
    ).rejects.toMatchObject({ code: "INVALID_CHANNEL_EVENT" });
    expect((await operation<RefundPortInput>("REFUND", refund.id)).state).toBe("READY");
    // A later failure notification for the old attempt is valid at its own URL but must not reset the new request.
    const lateFailurePayload = {
      ...oldNotificationPayload,
      eventId: `old-attempt-failure:${key()}`,
      issuedAt: Date.now(),
    };
    const lateFailure = gateway.signForLocalSimulator(lateFailurePayload);
    await acceptPaymentNotification(db, gateway, firstAttempt.id, lateFailure.body, {
      "x-mock-signature": lateFailure.signature,
    });
    expect(await getRefund(db, customer, refund.id)).toMatchObject({ id: refund.id, status: "REQUESTED" });
    expect(await getPaymentChannel(db, first.actor, "REFUND", refund.id, gateway)).toMatchObject({
      operationId: secondAttempt.id,
      state: "READY",
    });
    expect(await reconcilePaymentChannel(db, first.actor, "REFUND", refund.id, gateway)).toMatchObject({
      operationId: secondAttempt.id,
      state: "PENDING",
    });
    await simulatePaymentChannel(db, first.actor, "REFUND", refund.id, gateway, "SUCCEEDED");
    await reconcilePaymentChannel(db, first.actor, "REFUND", refund.id, mock());
    expect(await getRefund(db, customer, refund.id)).toMatchObject({ id: refund.id, status: "SUCCEEDED" });
    expect(await count("refunds")).toBe(1);
    expect(await count("external_refund_receipts")).toBe(1);
    expect(await count("channel_operations")).toBe(3);
    const wallet = await getWallet(db, customer, customer.customerId);
    expect(wallet.balance).toMatchObject({ totalCents: 12000, principalCents: 10000, giftCents: 2000 });
    expect(wallet.entries.filter((row) => row.kind === "REFUND")).toHaveLength(1);
  });

  it("queries an expired payment but never creates a missing channel order after expiry", async () => {
    await credit();
    const order = await booking();
    const gateway = new RecordingGateway();
    const payment = await beginOrderPayment(db, customer, gateway, {
      orderId: order.id,
      walletCents: 6000,
      commandKey: key(),
    });
    await db.query(
      "UPDATE tennis.orders SET hold_until=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND id=$2",
      [first.actor.tenantId, order.id],
    );
    expect(await reconcilePaymentChannel(db, customer, "ORDER", payment.id, gateway)).toMatchObject({
      state: "UNKNOWN",
      checkout: null,
    });
    expect(gateway.paymentQueries).toHaveLength(1);
    expect(gateway.paymentCreates).toHaveLength(0);
    expect(await count("mock_channel_records")).toBe(0);
    expect(await getOrderPayment(db, customer, payment.id)).toMatchObject({ status: "EXPIRED" });
    expect((await getWallet(db, customer, customer.customerId)).balance).toMatchObject({
      totalCents: 12000,
      reservedCents: 0,
    });
  });

  it("rejects cross-tenant reads and reconciliation for payments, topups and refunds", async () => {
    const gateway = mock();
    const order = await booking();
    const payment = await beginOrderPayment(db, customer, gateway, {
      orderId: order.id,
      walletCents: 0,
      commandKey: key(),
    });
    await simulatePaymentChannel(db, customer, "ORDER", payment.id, gateway, "SUCCEEDED");
    const refund = await fullRefund(order.id);
    const topup = await onlineTopup(gateway);
    for (const [kind, id] of [
      ["ORDER", payment.id],
      ["TOPUP", topup.id],
      ["REFUND", refund.id],
    ] as const) {
      await expect(getPaymentChannel(db, second.actor, kind, id, gateway)).rejects.toMatchObject({
        code: "RESOURCE_NOT_FOUND",
      });
      await expect(reconcilePaymentChannel(db, second.actor, kind, id, gateway)).rejects.toMatchObject({
        code: "RESOURCE_NOT_FOUND",
      });
    }
    expect((await operation("REFUND", refund.id)).state).toBe("READY");
    expect((await operation("TOPUP", topup.id)).state).toBe("READY");
  });

  it("permits read-only channel inspection but rejects writes and later venue-scope removal", async () => {
    const gateway = new RecordingGateway();
    const order = await booking();
    const payment = await beginOrderPayment(db, customer, gateway, {
      orderId: order.id,
      walletCents: 0,
      commandKey: key(),
    });
    await db.query(
      "UPDATE tennis.tenant_memberships SET role='VIEWER',all_venues=true,permissions=ARRAY['read'] WHERE tenant_id=$1 AND subject_id=$2",
      [first.actor.tenantId, first.actor.subjectId],
    );
    expect(await getPaymentChannel(db, first.actor, "ORDER", payment.id, gateway)).toMatchObject({
      state: "READY",
      canReconcile: false,
    });
    await expect(reconcilePaymentChannel(db, first.actor, "ORDER", payment.id, gateway)).rejects.toMatchObject({
      code: "TENANT_ACCESS_DENIED",
    });
    await db.query("UPDATE tennis.tenant_memberships SET all_venues=false WHERE tenant_id=$1 AND subject_id=$2", [
      first.actor.tenantId,
      first.actor.subjectId,
    ]);
    await expect(getPaymentChannel(db, first.actor, "ORDER", payment.id, gateway)).rejects.toMatchObject({
      code: "TENANT_ACCESS_DENIED",
    });
    await expect(reconcilePaymentChannel(db, first.actor, "ORDER", payment.id, gateway)).rejects.toMatchObject({
      code: "TENANT_ACCESS_DENIED",
    });
    expect(gateway.paymentCreates).toHaveLength(0);
    expect(gateway.paymentQueries).toHaveLength(0);
  });

  it("allows a customer to view their refund but never submit it, and excludes another customer", async () => {
    const gateway = mock();
    const order = await booking();
    const payment = await beginOrderPayment(db, customer, gateway, {
      orderId: order.id,
      walletCents: 0,
      commandKey: key(),
    });
    await simulatePaymentChannel(db, customer, "ORDER", payment.id, gateway, "SUCCEEDED");
    const refund = await fullRefund(order.id);
    expect(await getPaymentChannel(db, customer, "REFUND", refund.id, gateway)).toMatchObject({
      state: "READY",
      canReconcile: false,
    });
    await expect(reconcilePaymentChannel(db, customer, "REFUND", refund.id, gateway)).rejects.toMatchObject({
      code: "TENANT_ACCESS_DENIED",
    });
    const otherProfile = await createCustomer(db, first.actor, { nickname: "另一位合成客户" });
    const otherSubjectId = key();
    subjects.push(otherSubjectId);
    await db.query("INSERT INTO tennis.subjects(id,display_name) VALUES($1,'synthetic other channel customer')", [
      otherSubjectId,
    ]);
    await db.query("UPDATE tennis.customers SET subject_id=$1 WHERE tenant_id=$2 AND id=$3", [
      otherSubjectId,
      first.actor.tenantId,
      otherProfile.id,
    ]);
    const other: CustomerActor = { ...customer, subjectId: otherSubjectId, customerId: otherProfile.id };
    await expect(getPaymentChannel(db, other, "ORDER", payment.id, gateway)).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
    });
    await expect(reconcilePaymentChannel(db, other, "ORDER", payment.id, gateway)).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
    });
  });
});


describe("refund channel original totals", () => {
  async function paidMixedOrder() {
    await credit(5000, 1000);
    const order = await booking();
    const payment = await beginOrderPayment(db, customer, mock(), {
      orderId: order.id, walletCents: 6000, commandKey: key(),
    });
    await simulatePaymentChannel(db, customer, "ORDER", payment.id, mock(), "SUCCEEDED");
    return { order, payment };
  }
  async function partial(orderId: string, cents: number) {
    const paid = await getOrder(db, first.actor, orderId);
    return requestOrderRefund(db, first.actor, {
      orderId, expectedRevision: paid.revision, reason: "人工核准合成部分退款", commandKey: key(),
      lines: [{ lineId: paid.lines[0]!.id, refundCents: cents, cancel: false }],
    });
  }
  async function replaceFixtureRequest(refundId: string, input: RefundPortInput) {
    await removeChannelLayer("REFUND", refundId);
    await db.query(
      `INSERT INTO tennis.channel_operations(id,tenant_id,source_kind,source_id,binding_id,provider,request,request_hash)
       VALUES($1,$2,'REFUND',$3,$4,$5,$6::jsonb,$7)`,
      [input.operationId, first.actor.tenantId, refundId, input.binding.id, input.binding.provider, JSON.stringify(input), requestHash(input)],
    );
  }
  async function storedRequest(id: string) {
    return (await db.query("SELECT request,request_hash FROM tennis.channel_operations WHERE id=$1", [id])).rows[0];
  }
  it("keeps the original external total through repeated partial mixed-payment refunds", async () => {
    const { order, payment } = await paidMixedOrder();
    const recording = new RecordingGateway();
    for (const amount of [2400, 3600]) {
      const refund = await partial(order.id, amount);
      expect(refund.externalCents).toBe(amount / 2);
      await reconcilePaymentChannel(db, first.actor, "REFUND", refund.id, recording);
      expect(recording.refundCreates.at(-1)).toMatchObject({
        sourceId: payment.id, amountCents: amount / 2, originalPaymentCents: 6000,
      });
      await simulatePaymentChannel(db, first.actor, "REFUND", refund.id, mock(), "SUCCEEDED");
    }
    expect((await getWallet(db, first.actor, customer.customerId)).balance.totalCents).toBe(3000);
    expect(await count("external_refund_receipts")).toBe(2);
  });
  it("uses each captured payment total when an amendment adds a second receipt", async () => {
    const { order, payment } = await paidMixedOrder();
    const paid = await getOrder(db, first.actor, order.id);
    const preview = await previewOrderAmendment(db, first.actor, {
      orderId: order.id, expectedRevision: paid.revision, reason: "客户增加半小时",
      changes: [{ lineId: paid.lines[0]!.id, courtId, startAt: "2099-09-18T19:00:00+08:00", endAt: "2099-09-18T20:30:00+08:00" }],
    });
    await confirmOrderAmendment(db, first.actor, { amendmentId: preview.id, commandKey: key(), approvedRefundLines: [] });
    await credit(2000, 0);
    const added = await beginAmendmentPayment(db, customer, mock(), { amendmentId: preview.id, walletCents: 2000, commandKey: key() });
    expect(added.externalCents).toBe(4000);
    await simulatePaymentChannel(db, customer, "ORDER", added.id, mock(), "SUCCEEDED");
    const updated = await getOrder(db, first.actor, order.id);
    const group = await requestOrderRefundGroup(db, first.actor, {
      orderId: order.id, expectedRevision: updated.revision, reason: "人工核准整单取消", commandKey: key(),
      lines: [{ lineId: updated.lines[0]!.id, refundCents: updated.totalCents, cancel: true }],
    });
    expect(group.refunds).toHaveLength(2);
    const totals = new Map([[payment.id, 6000], [added.id, 4000]]);
    for (const refund of group.refunds) {
      const op = await operation<RefundPortInput>("REFUND", refund.id);
      expect(op.request).toMatchObject({ sourceId: refund.paymentId, originalPaymentCents: totals.get(refund.paymentId), amountCents: totals.get(refund.paymentId) });
      await simulatePaymentChannel(db, first.actor, "REFUND", refund.id, mock(), "SUCCEEDED");
    }
    expect((await getWallet(db, first.actor, customer.customerId)).balance.totalCents).toBe(8000);
  });
  it("leaves a historical request untouched on enqueue and enriches only its authorized retry", async () => {
    const { order } = await paidMixedOrder();
    const refund = await partial(order.id, 2400);
    const op = await operation<RefundPortInput>("REFUND", refund.id);
    const { originalPaymentCents: _total, ...legacy } = op.request;
    await replaceFixtureRequest(refund.id, legacy);
    const before = await storedRequest(op.id);
    const tx = await db.connect();
    try { await enqueueRefundChannel(tx, first.actor.tenantId, refund.id); } finally { tx.release(); }
    expect(await storedRequest(op.id)).toEqual(before);
    await simulatePaymentChannel(db, first.actor, "REFUND", refund.id, mock(), "FAILED");
    await retryFailedRefund(db, first.actor, refund.id, key());
    const retry = await operation<RefundPortInput>("REFUND", refund.id);
    expect(retry.id).not.toBe(op.id);
    expect(retry.request).toMatchObject({ originalPaymentCents: 6000, amountCents: 1200, transactionId: legacy.transactionId, binding: legacy.binding });
    expect(await storedRequest(op.id)).toEqual(before);
    await simulatePaymentChannel(db, first.actor, "REFUND", refund.id, mock(), "SUCCEEDED");
    expect(await count("external_refund_receipts")).toBe(1);
  });
  it("rejects a contradictory persisted total instead of correcting and sending a new refund", async () => {
    const { order } = await paidMixedOrder();
    const refund = await partial(order.id, 2400);
    const op = await operation<RefundPortInput>("REFUND", refund.id);
    await replaceFixtureRequest(refund.id, { ...op.request, originalPaymentCents: 5000 });
    await simulatePaymentChannel(db, first.actor, "REFUND", refund.id, mock(), "FAILED");
    const before = await storedRequest(op.id);
    await expect(retryFailedRefund(db, first.actor, refund.id, key())).rejects.toMatchObject({ code: "CHANNEL_REQUEST_CONFLICT" });
    expect((await operation("REFUND", refund.id)).id).toBe(op.id);
    expect(await storedRequest(op.id)).toEqual(before);
    expect((await getRefund(db, first.actor, refund.id)).status).toBe("FAILED");
    expect(await count("external_refund_receipts")).toBe(0);
  });
});
