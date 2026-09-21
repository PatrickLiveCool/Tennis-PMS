import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { TenantAccessError, recordTenantAudit, requireTenantPermission, type TenantActor } from "./access.ts";
import { withBookingTransaction } from "./customers.ts";
import { lockTenantTransactions } from "./transaction-locks.ts";
import { settleVerifiedPayment } from "./payments.ts";
import { settleVerifiedTopup } from "./topups.ts";
import { TrustedPaymentProvider, type PaymentPortInput, type PaymentSettlementTransactionHook } from "./payment-port.ts";
import { idempotentCommand, requestHash } from "./receipts.ts";

export class WecomReconciliationError extends Error {
  constructor(readonly code: "INVALID_WECOM_RECEIPT" | "WECOM_RECEIPT_CONFLICT" | "WECOM_REFERENCE_MISMATCH" |
    "WECOM_RECEIPT_ALREADY_LINKED" | "WECOM_SIMULATION_DISABLED" | "WECOM_TARGET_MISMATCH") {
    super(code); this.name = "WecomReconciliationError";
  }
}
export interface WecomCollectionFacts {
  tenantId: string;
  corporationId: string;
  merchantId: string;
  transactionId: string;
  provider: "MOCK" | "WECHAT";
  amountCents: number;
  currency: "CNY";
  paidAt: string;
  simulation: boolean;
  /** Only an authenticated provider field or durable server-created mapping; never payer nickname, memo or chat. */
  trustedOperationId: string | null;
}
const authenticatedReceipts = new WeakSet<object>();
declare const trustedReceiptBrand: unique symbol;
export type TrustedWecomCollection = Readonly<WecomCollectionFacts> & { readonly [trustedReceiptBrand]: true };
const validId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 200 && !/[\s\x00-\x1f\x7f]/u.test(v);
export function validateWecomCollection(f: WecomCollectionFacts): void {
  if (!f || ![f.tenantId, f.corporationId, f.merchantId, f.transactionId].every(validId) ||
    !["MOCK", "WECHAT"].includes(f.provider) || f.currency !== "CNY" || !Number.isSafeInteger(f.amountCents) ||
    f.amountCents <= 0 || !Number.isFinite(Date.parse(f.paidAt)) || typeof f.simulation !== "boolean" ||
    (f.simulation ? f.provider !== "MOCK" : f.provider !== "WECHAT") ||
    (f.trustedOperationId !== null && !validId(f.trustedOperationId))) throw new WecomReconciliationError("INVALID_WECOM_RECEIPT");
}
/** Implement only in server adapters after verifying the collection source and tenant/merchant binding.
 * The demo source is local-only. This release does not ship a live WeCom network adapter. */
export abstract class TrustedWecomCollectionSource {
  protected certifyCollection(facts: WecomCollectionFacts): TrustedWecomCollection {
    validateWecomCollection(facts);
    const copy = Object.freeze({ ...facts, paidAt: new Date(facts.paidAt).toISOString() });
    authenticatedReceipts.add(copy);
    return copy as TrustedWecomCollection;
  }
}
function semanticHash(f: WecomCollectionFacts): string {
  return requestHash({ tenantId: f.tenantId, corporationId: f.corporationId, merchantId: f.merchantId,
    transactionId: f.transactionId, provider: f.provider, amountCents: f.amountCents, currency: f.currency,
    paidAt: new Date(f.paidAt).toISOString(), simulation: f.simulation, trustedOperationId: f.trustedOperationId });
}
export interface WecomReceipt extends WecomCollectionFacts {
  id: string;
  operationId: string | null;
  state: "UNMATCHED" | "REVIEW" | "LINKED" | "EXCEPTION";
  linkedBy: string | null;
  linkReason: string | null;
  linkedAt: string | null;
  lastError: string | null;
  createdAt: string;
  business?: { venueId: string; venueName: string; sourceKind: "ORDER" | "TOPUP"; sourceId: string; orderId: string | null };
}
type ReceiptRow = Omit<WecomReceipt, "paidAt" | "linkedAt" | "createdAt"> & {
  paidAt: Date; linkedAt: Date | null; createdAt: Date; semanticHash: string;
};
const columns = `id,tenant_id AS "tenantId",corporation_id AS "corporationId",merchant_id AS "merchantId",
 transaction_id AS "transactionId",provider,amount_cents::float8 AS "amountCents",currency,paid_at AS "paidAt",simulation,
 trusted_operation_id AS "trustedOperationId",operation_id AS "operationId",state,linked_by AS "linkedBy",
 link_reason AS "linkReason",linked_at AS "linkedAt",last_error AS "lastError",created_at AS "createdAt",semantic_hash AS "semanticHash"`;
function receiptRecord(row: ReceiptRow): WecomReceipt {
  const { semanticHash: _hash, ...record } = row;
  return { ...record, paidAt: row.paidAt.toISOString(), linkedAt: row.linkedAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString() };
}
async function receipt(tx: pg.PoolClient, tenantId: string, id: string): Promise<ReceiptRow> {
  const row = (await tx.query<ReceiptRow>(`SELECT ${columns} FROM tennis.wecom_receipts WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [tenantId, id])).rows[0];
  if (!row) throw new TenantAccessError("RESOURCE_NOT_FOUND");
  return row;
}
async function admin(tx: pg.PoolClient, actor: TenantActor): Promise<void> {
  await requireTenantPermission(tx, actor, "manage_members");
  const row = await tx.query(`SELECT 1 FROM tennis.tenant_memberships WHERE tenant_id=$1 AND subject_id=$2 AND role='ADMIN' AND active FOR SHARE`, [actor.tenantId, actor.subjectId]);
  if (!row.rowCount) throw new TenantAccessError("TENANT_ACCESS_DENIED");
}
type Operation = { id: string; tenantId: string; sourceKind: "ORDER" | "TOPUP"; sourceId: string; request: PaymentPortInput; state: string; venueId: string; orderId: string | null; customerName: string; createdAt: Date; requestHash: string };
const operationSql = `SELECT o.id,o.tenant_id AS "tenantId",o.source_kind AS "sourceKind",o.source_id AS "sourceId",o.request,o.request_hash AS "requestHash",o.state,o.created_at AS "createdAt",
 coalesce(p.venue_id,t.venue_id) AS "venueId",p.order_id AS "orderId",c.nickname AS "customerName"
 FROM tennis.channel_operations o
 LEFT JOIN tennis.payment_attempts p ON o.source_kind='ORDER' AND p.tenant_id=o.tenant_id AND p.id=o.source_id
 LEFT JOIN tennis.topup_payments t ON o.source_kind='TOPUP' AND t.tenant_id=o.tenant_id AND t.id=o.source_id
 JOIN tennis.customers c ON c.tenant_id=o.tenant_id AND c.id=coalesce(p.customer_id,t.customer_id)`;
async function operation(tx: pg.PoolClient, tenantId: string, operationId: string): Promise<Operation> {
  const row = (await tx.query<Operation>(operationSql + ` WHERE o.tenant_id=$1 AND o.id=$2 AND o.source_kind IN ('ORDER','TOPUP') FOR UPDATE OF o`, [tenantId, operationId])).rows[0];
  if (!row || row.requestHash !== requestHash(row.request) || row.request.operationId !== row.id ||
    row.request.sourceKind !== row.sourceKind || row.request.sourceId !== row.sourceId || row.request.binding.tenantId !== tenantId)
    throw new WecomReconciliationError("WECOM_TARGET_MISMATCH");
  return row;
}
export interface WecomPaymentTarget {
  operationId: string; sourceKind: "ORDER" | "TOPUP"; sourceId: string; orderId: string | null; venueId: string;
  customerName: string; amountCents: number; provider: "MOCK" | "WECHAT"; merchantId: string; state: string; createdAt: string;
}
export async function listWecomPaymentTargets(db: pg.Pool, actor: TenantActor, venueId: string, operationId?: string): Promise<WecomPaymentTarget[]> {
  return withBookingTransaction(db, actor, async tx => {
    await admin(tx, actor);
    await requireTenantPermission(tx, actor, "manage_members", venueId);
    return (await tx.query<Operation>(operationSql + ` WHERE o.tenant_id=$1 AND coalesce(p.venue_id,t.venue_id)=$2
      AND o.source_kind IN ('ORDER','TOPUP') AND (($3::text IS NULL AND o.state NOT IN ('SUCCEEDED','FAILED')) OR o.id=$3) ORDER BY o.created_at DESC,o.id LIMIT 100`, [actor.tenantId, venueId, operationId ?? null])).rows.map(row => ({
        operationId: row.id, sourceKind: row.sourceKind, sourceId: row.sourceId, orderId: row.orderId, venueId: row.venueId,
        customerName: row.customerName, amountCents: row.request.amountCents, provider: row.request.binding.provider,
        merchantId: row.request.binding.merchantId, state: row.state, createdAt: row.createdAt.toISOString(),
      }));
  });
}
export interface WecomReceiptPage { items: WecomReceipt[]; nextCursor: string | null }
export async function listWecomReceipts(db: pg.Pool, actor: TenantActor, input: { state?: string; q?: string; cursor?: string } = {}): Promise<WecomReceiptPage> {
  if ((input.state && !["UNMATCHED", "REVIEW", "LINKED", "EXCEPTION"].includes(input.state)) || (input.q?.length ?? 0) > 200)
    throw new WecomReconciliationError("INVALID_WECOM_RECEIPT");
  let cursor: { id: string } | null = null;
  if (input.cursor) {
    try {
      const decoded = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8"));
      if (!validId(decoded.id)) throw new Error();
      cursor = decoded;
    } catch { throw new WecomReconciliationError("INVALID_WECOM_RECEIPT"); }
  }
  return withBookingTransaction(db, actor, async tx => {
    await admin(tx, actor);
    const rows = (await tx.query<ReceiptRow>(`SELECT ${columns} FROM tennis.wecom_receipts WHERE tenant_id=$1
      AND ($2::text IS NULL OR state=$2) AND ($3='' OR strpos(lower(id),lower($3))>0 OR strpos(lower(transaction_id),lower($3))>0)
      AND ($4::text IS NULL OR (created_at,id)<(SELECT created_at,id FROM tennis.wecom_receipts WHERE tenant_id=$1 AND id=$4)) ORDER BY created_at DESC,id DESC LIMIT 51`,
      [actor.tenantId, input.state || null, input.q?.trim() ?? "", cursor?.id ?? null])).rows;
    const last = rows.length > 50 ? rows[49] : null;
    const items = rows.slice(0, 50).map(receiptRecord);
    const ids = items.flatMap(item => item.operationId ? [item.operationId] : []);
    const businesses = ids.length ? (await tx.query<{ operationId: string } & NonNullable<WecomReceipt["business"]>>(`SELECT o.id AS "operationId",o.source_kind AS "sourceKind",o.source_id AS "sourceId",p.order_id AS "orderId",v.id AS "venueId",v.name AS "venueName"
      FROM tennis.channel_operations o LEFT JOIN tennis.payment_attempts p ON p.tenant_id=o.tenant_id AND p.id=o.source_id AND o.source_kind='ORDER'
      LEFT JOIN tennis.topup_payments t ON t.tenant_id=o.tenant_id AND t.id=o.source_id AND o.source_kind='TOPUP'
      JOIN tennis.venues v ON v.tenant_id=o.tenant_id AND v.id=coalesce(p.venue_id,t.venue_id)
      WHERE o.tenant_id=$1 AND o.id=ANY($2::text[])`, [actor.tenantId, ids])).rows : [];
    const byId = new Map(businesses.map(({ operationId, ...business }) => [operationId, business]));
    for (const item of items) {
      const business = item.operationId ? byId.get(item.operationId) : undefined;
      if (business) item.business = business;
    }
    return { items, nextCursor: last ? Buffer.from(JSON.stringify({ id: last.id })).toString("base64url") : null };
  });
}

/** Certification bridge from an immutable authenticated receipt; never exposed to JSON callers. */
class ReceiptEventProvider extends TrustedPaymentProvider {
  readonly simulation: boolean;
  constructor(readonly provider: "MOCK" | "WECHAT", simulation: boolean) { super(); this.simulation = simulation; }
  async createPayment(): Promise<never> { throw new Error("Receipt adapter does not initiate a payment"); }
  async queryPayment(): Promise<never> { throw new Error("Receipt adapter requires an authenticated collection"); }
  async createRefund(): Promise<never> { throw new Error("Refund requires separate business authorization and channel adapter"); }
  async queryRefund(): Promise<never> { throw new Error("Refund observation is not a collection"); }
  async verifyNotification(): Promise<never> { throw new Error("No public notification verifier"); }
  event(row: ReceiptRow, op: Operation) {
    return this.certifyPaymentEvent({ provider: row.provider, merchantId: row.merchantId, paymentId: op.sourceId,
      eventId: `wecom:${row.id}`, transactionId: row.transactionId, status: "SUCCEEDED", amountCents: row.amountCents,
      currency: "CNY", issuedAt: Date.now() });
  }
}
function validateMatch(row: ReceiptRow, op: Operation): void {
  if (row.trustedOperationId && row.trustedOperationId !== op.id) throw new WecomReconciliationError("WECOM_REFERENCE_MISMATCH");
  if (row.operationId && row.operationId !== op.id) throw new WecomReconciliationError("WECOM_RECEIPT_ALREADY_LINKED");
  if (row.tenantId !== op.tenantId || row.provider !== op.request.binding.provider || row.merchantId !== op.request.binding.merchantId ||
    row.amountCents !== op.request.amountCents || row.currency !== op.request.currency)
    throw new WecomReconciliationError("WECOM_TARGET_MISMATCH");
}
async function applyReceipt(db: pg.Pool, tenantId: string, receiptId: string, operationId: string, manual?: { actor: TenantActor; reason: string }): Promise<WecomReceipt> {
  // A preflight obtains only durable immutable facts. All mutable permission/association checks repeat in settlement.
  const tx = await db.connect();
  let row: ReceiptRow, op: Operation;
  try {
    await tx.query("BEGIN"); await lockTenantTransactions(tx, tenantId);
    if (manual) await admin(tx, manual.actor);
    row = await receipt(tx, tenantId, receiptId); op = await operation(tx, tenantId, operationId);
    validateMatch(row, op);
    await tx.query("COMMIT");
  } catch (e) { await tx.query("ROLLBACK"); throw e; } finally { tx.release(); }
  const event = new ReceiptEventProvider(row.provider, row.simulation).event(row, op);
  const hook: PaymentSettlementTransactionHook = {
    async beforeSettlement(client, actualTenantId) {
      if (actualTenantId !== tenantId) throw new WecomReconciliationError("WECOM_TARGET_MISMATCH");
      if (manual) await admin(client, manual.actor);
      const current = await receipt(client, tenantId, receiptId);
      const currentOp = await operation(client, tenantId, operationId);
      if (current.semanticHash !== row.semanticHash) throw new WecomReconciliationError("WECOM_RECEIPT_CONFLICT");
      validateMatch(current, currentOp);
    },
    async beforeCommit(client) {
      const conflict = op.sourceKind === "ORDER"
        ? await client.query(`SELECT 1 FROM tennis.financial_exceptions WHERE tenant_id=$1 AND payment_id=$2 AND external_transaction_id=$3`, [tenantId, op.sourceId, row.transactionId])
        : await client.query(`SELECT 1 FROM tennis.topup_exceptions WHERE tenant_id=$1 AND topup_id=$2 AND external_transaction_id=$3`, [tenantId, op.sourceId, row.transactionId]);
      const actor = manual?.actor ?? { tenantId, subjectId: "system:tennis" };
      const updated = await client.query(`UPDATE tennis.wecom_receipts SET operation_id=$1,state=$2,linked_by=$3,link_reason=$4,linked_at=clock_timestamp(),last_error=NULL WHERE tenant_id=$5 AND id=$6 AND operation_id IS NULL`,
        [op.id, conflict.rowCount ? "EXCEPTION" : "LINKED", actor.subjectId, manual?.reason ?? "可信收款通道提供明确支付关联，自动核验", tenantId, row.id]);
      await client.query(`UPDATE tennis.channel_operations SET state='SUCCEEDED',last_checked_at=clock_timestamp(),last_error=NULL,lease_token=NULL,lease_until=NULL WHERE tenant_id=$1 AND id=$2`, [tenantId, op.id]);
      if (updated.rowCount) await recordTenantAudit(client, actor, "wecom.receipt.link", row.id, { operationId: op.id, simulation: row.simulation, automatic: !manual, source: "wecom-reconciliation", outcome: conflict.rowCount ? "EXCEPTION" : "LINKED", reason: manual?.reason ?? null });
    },
  };
  if (op.sourceKind === "ORDER") await settleVerifiedPayment(db, event, hook);
  else await settleVerifiedTopup(db, event, hook);
  const result = (await db.query<ReceiptRow>(`SELECT ${columns} FROM tennis.wecom_receipts WHERE tenant_id=$1 AND id=$2`, [tenantId, receiptId])).rows[0]!;
  return receiptRecord(result);
}
/** Import is callable only with an in-process authenticated observation, not a request-body cast. */
export async function ingestWecomCollection(db: pg.Pool, facts: TrustedWecomCollection): Promise<WecomReceipt> {
  if (!facts || !authenticatedReceipts.has(facts)) throw new WecomReconciliationError("INVALID_WECOM_RECEIPT");
  validateWecomCollection(facts);
  const tx = await db.connect(); let row: ReceiptRow;
  try {
    await tx.query("BEGIN"); await lockTenantTransactions(tx, facts.tenantId);
    const tenant = await tx.query(`SELECT id FROM tennis.tenants WHERE id=$1 FOR SHARE`, [facts.tenantId]);
    if (!tenant.rowCount) throw new TenantAccessError("RESOURCE_NOT_FOUND");
    await tx.query(`INSERT INTO tennis.wecom_receipts(id,tenant_id,corporation_id,merchant_id,transaction_id,provider,amount_cents,currency,paid_at,simulation,trusted_operation_id,semantic_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING`,
      [randomUUID(), facts.tenantId, facts.corporationId, facts.merchantId, facts.transactionId, facts.provider, facts.amountCents, facts.currency, facts.paidAt, facts.simulation, facts.trustedOperationId, semanticHash(facts)]);
    const stored = (await tx.query<ReceiptRow>(`SELECT ${columns} FROM tennis.wecom_receipts WHERE provider=$1 AND merchant_id=$2 AND transaction_id=$3 FOR UPDATE`, [facts.provider, facts.merchantId, facts.transactionId])).rows[0];
    if (!stored || stored.tenantId !== facts.tenantId || stored.semanticHash !== semanticHash(facts)) throw new WecomReconciliationError("WECOM_RECEIPT_CONFLICT");
    row = stored;
    await tx.query("COMMIT");
  } catch (e) { await tx.query("ROLLBACK"); throw e; } finally { tx.release(); }
  if (!facts.trustedOperationId || row.operationId) return receiptRecord(row);
  try { return await applyReceipt(db, facts.tenantId, row.id, facts.trustedOperationId); }
  catch (e) {
    // Preserve authenticated money even if an explicit reference is invalid; never redirect it by amount/name.
    const allowed = ["WecomReconciliationError", "TennisWalletError", "TenantAccessError"];
    if (!allowed.includes((e as Error).name)) throw e;
    const errorCode = (e as { code?: string }).code ?? "WECOM_TARGET_MISMATCH";
    const updated = (await db.query<ReceiptRow>(`UPDATE tennis.wecom_receipts SET state='REVIEW',last_error=$1 WHERE tenant_id=$2 AND id=$3 AND operation_id IS NULL RETURNING ${columns}`, [errorCode, facts.tenantId, row.id])).rows[0];
    return receiptRecord(updated ?? (await db.query<ReceiptRow>(`SELECT ${columns} FROM tennis.wecom_receipts WHERE tenant_id=$1 AND id=$2`, [facts.tenantId, row.id])).rows[0]!);
  }
}
export async function linkWecomReceipt(db: pg.Pool, actor: TenantActor, input: { receiptId: string; operationId: string; reason: string }): Promise<WecomReceipt> {
  if (!validId(input.receiptId) || !validId(input.operationId) || !input.reason?.trim() || input.reason.length > 2000) throw new WecomReconciliationError("INVALID_WECOM_RECEIPT");
  return applyReceipt(db, actor.tenantId, input.receiptId, input.operationId, { actor, reason: input.reason.trim() });
}
class LocalSyntheticCollectionSource extends TrustedWecomCollectionSource {
  create(facts: WecomCollectionFacts) { return this.certifyCollection(facts); }
}
/** Server derives all amounts/merchant/source fields. This endpoint cannot certify live money. */
export async function simulateWecomReceipt(db: pg.Pool, actor: TenantActor, input: { operationId: string; referenceMode: "EXACT" | "UNMATCHED"; commandKey: string }, options: { allowSimulation: boolean }): Promise<WecomReceipt> {
  if (!options.allowSimulation || process.env.NODE_ENV === "production") throw new WecomReconciliationError("WECOM_SIMULATION_DISABLED");
  if (!validId(input.operationId) || !validId(input.commandKey) || !["EXACT", "UNMATCHED"].includes(input.referenceMode)) throw new WecomReconciliationError("INVALID_WECOM_RECEIPT");
  const facts = await withBookingTransaction(db, actor, async tx => {
    await admin(tx, actor);
    const op = await operation(tx, actor.tenantId, input.operationId);
    if (op.request.binding.provider !== "MOCK") throw new WecomReconciliationError("WECOM_SIMULATION_DISABLED");
    const transactionId = `synthetic-wecom:${createHash("sha256").update(actor.tenantId + ":" + input.commandKey).digest("hex")}`;
    const { paidAt } = (await tx.query<{ paidAt: Date }>('SELECT clock_timestamp() AS "paidAt"')).rows[0]!;
    const stored = await idempotentCommand(tx, actor, op.venueId, input.commandKey, "wecom.demo_receipt",
      { operationId: op.id, referenceMode: input.referenceMode }, async () => ({ facts: {
        tenantId: actor.tenantId, corporationId: `synthetic:${actor.tenantId}`,
        merchantId: op.request.binding.merchantId, transactionId, provider: "MOCK" as const, amountCents: op.request.amountCents,
        currency: "CNY" as const, paidAt: paidAt.toISOString(), simulation: true,
        trustedOperationId: input.referenceMode === "EXACT" ? op.id : null,
      } }));
    return new LocalSyntheticCollectionSource().create(stored.facts);
  });
  return ingestWecomCollection(db, facts);
}
