import type pg from "pg";
import type { MockChannelKey, MockChannelRecord, MockChannelStore, MockStoredOutcome } from "./mock-payments.ts";
import { requestHash } from "./receipts.ts";
import { PaymentChannelError } from "./channel-intents.ts";

/** Deliberately local-only channel ledger; survives gateway/server restarts. */
export function postgresMockChannelStore(db: pg.Pool): MockChannelStore {
  const keyParams = (key: MockChannelKey) => [key.kind, key.merchantId, key.merchantReference];
  return {
    async get(key) {
      return (
        (
          await db.query<{ record: MockChannelRecord }>(
            `SELECT record FROM tennis.mock_channel_records WHERE kind=$1 AND merchant_id=$2 AND merchant_reference=$3`,
            keyParams(key),
          )
        ).rows[0]?.record ?? null
      );
    },
    async putIfAbsent(record) {
      const op = (
        await db.query<{ request: unknown; source_kind: string }>(
          `SELECT request,source_kind FROM tennis.channel_operations WHERE id=$1 AND tenant_id=$2`,
          [record.input.operationId, record.input.binding.tenantId],
        )
      ).rows[0];
      if (!op) throw new PaymentChannelError("CHANNEL_NOT_READY");
      if (
        requestHash(op.request) !== requestHash(record.input) ||
        record.kind !== (op.source_kind === "REFUND" ? "REFUND" : "PAYMENT") ||
        record.merchantId !== record.input.binding.merchantId ||
        record.merchantReference !==
          ("refundId" in record.input ? record.input.merchantRefundNo : record.input.merchantOrderNo)
      )
        throw new PaymentChannelError("CHANNEL_REQUEST_CONFLICT");
      await db.query(
        `INSERT INTO tennis.mock_channel_records(operation_id,tenant_id,kind,merchant_id,merchant_reference,record) VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(kind,merchant_id,merchant_reference) DO NOTHING`,
        [record.input.operationId, record.input.binding.tenantId, ...keyParams(record), JSON.stringify(record)],
      );
      return (
        await db.query<{ record: MockChannelRecord }>(
          `SELECT record FROM tennis.mock_channel_records WHERE kind=$1 AND merchant_id=$2 AND merchant_reference=$3`,
          keyParams(record),
        )
      ).rows[0]!.record;
    },
    async recordOutcome(key, expectedRequestHash, outcome: MockStoredOutcome) {
      const tx = await db.connect();
      try {
        await tx.query("BEGIN");
        const old = (
          await tx.query<{ record: MockChannelRecord }>(
            `SELECT record FROM tennis.mock_channel_records WHERE kind=$1 AND merchant_id=$2 AND merchant_reference=$3 FOR UPDATE`,
            keyParams(key),
          )
        ).rows[0]?.record;
        if (!old || old.requestHash !== expectedRequestHash) throw new PaymentChannelError("CHANNEL_REQUEST_CONFLICT");
        if (outcome.kind !== old.kind || old.kind !== key.kind) throw new PaymentChannelError("INVALID_CHANNEL_EVENT");
        if (
          !old.outcome ||
          (old.kind === "PAYMENT" && old.outcome.event.status === "FAILED" && outcome.event.status === "SUCCEEDED")
        ) {
          old.outcome = outcome;
          await tx.query(
            `UPDATE tennis.mock_channel_records SET record=$4::jsonb WHERE kind=$1 AND merchant_id=$2 AND merchant_reference=$3`,
            [...keyParams(key), JSON.stringify(old)],
          );
        }
        await tx.query("COMMIT");
        return old;
      } catch (error) {
        await tx.query("ROLLBACK");
        throw error;
      } finally {
        tx.release();
      }
    },
  };
}
