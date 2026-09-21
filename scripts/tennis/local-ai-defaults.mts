import { readFile } from "node:fs/promises";
import type pg from "pg";
import { decryptBackofficeKey, getBackofficeAIConfig, saveBackofficeAIConfig } from "../../packages/db/src/tennis/backoffice-assistant.ts";

/** Opt-in machine-local defaults, never read by integration tests or production. */
export async function applyLocalAIDefaults(db: pg.Pool, key: Buffer) {
  if (process.env.NODE_ENV === "production") throw new Error("Local AI defaults cannot run in production");
  let saved: { baseUrl: string; model: string; encryptedKey: string };
  try { saved = JSON.parse(await readFile(".local-workspace/ai-test-defaults.json", "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  const operator = (await db.query<{ subject_id: string }>(`SELECT a.subject_id FROM tennis.local_accounts a
    JOIN tennis.platform_operators p ON p.subject_id=a.subject_id WHERE a.username='demo.platform' AND a.active AND p.active`)).rows[0];
  if (!operator) return;
  const current = await getBackofficeAIConfig(db, operator.subject_id);
  // Reapply the user-selected local test profile without bumping identical revisions.
  const stored = (await db.query<{ encrypted_key: string | null }>("SELECT encrypted_key FROM tennis.backoffice_ai_config WHERE singleton")).rows[0];
  const apiKey = decryptBackofficeKey(saved.encryptedKey, key);
  if (current.enabled && current.model === saved.model && current.baseUrl === saved.baseUrl && stored?.encrypted_key && decryptBackofficeKey(stored.encrypted_key, key) === apiKey) return;
  await saveBackofficeAIConfig(db, operator.subject_id, key, { enabled: true, model: saved.model, baseUrl: saved.baseUrl, apiKey, expectedRevision: current.revision });
}
