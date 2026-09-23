import type pg from "pg";
import { version } from "../../../../package.json";
import { assistantQuestionPage, assistantQuestionTopic, redactAssistantQuestion } from "./assistant-question-redaction.ts";

export type QuestionSource = "USER" | "SUGGESTION" | "UNKNOWN";
export type QuestionDiagnostic = "AI_QUESTION_RECORD_FAILED" | "AI_QUESTION_FINISH_FAILED" | "AI_QUESTION_FEEDBACK_FAILED" | "AI_QUESTION_MAINTENANCE_FAILED";
export type QuestionLogger = (code: QuestionDiagnostic) => void;
export const questionToolNames = new Set(["get_work_context", "get_discounts", "prepare_booking", "prepare_order_action", "get_courts", "get_schedule", "get_current_order", "open_page"]);
const errorCodes = new Set(["ASSISTANT_UNAVAILABLE", "REQUEST_INTERRUPTED", "ASSISTANT_TIMEOUT", "TENANT_ACCESS_DENIED", "RESOURCE_NOT_FOUND", "BACKOFFICE_ASSISTANT_NOT_CONFIGURED", "BACKOFFICE_MODEL_CONNECTION_NOT_ENABLED"]);

function diagnose(code: QuestionDiagnostic, log?: QuestionLogger) {
  // Never log SQL errors, question text, model responses or connection strings.
  try { if (log) log(code); else console.warn(code); } catch { /* Diagnostics cannot fail a chat. */ }
}

/** Each caller is already inside the authorized chat transaction. */
async function bestEffort(tx: pg.PoolClient, code: QuestionDiagnostic, work: () => Promise<unknown>, log?: QuestionLogger) {
  await tx.query("SAVEPOINT tennis_ai_question_write");
  try {
    const limits = (await tx.query<{ name: string; setting: string }>("SELECT name,setting FROM pg_settings WHERE name IN ('lock_timeout','statement_timeout')")).rows;
    const prior = Object.fromEntries(limits.map(({ name, setting }) => [name, setting]));
    const bound = (name: string, max: number) => `${Math.min(Number(prior[name]) || max, max)}ms`;
    await tx.query("SELECT set_config('lock_timeout',$1,true),set_config('statement_timeout',$2,true)", [bound("lock_timeout", 500), bound("statement_timeout", 1500)]);
    await work();
    await tx.query("SELECT set_config('lock_timeout',$1,true),set_config('statement_timeout',$2,true)", [`${prior.lock_timeout}ms`, `${prior.statement_timeout}ms`]);
  } catch {
    // A caught SQL exception still aborts PostgreSQL transactions unless rolled back.
    await tx.query("ROLLBACK TO SAVEPOINT tennis_ai_question_write");
    diagnose(code, log);
  } finally {
    await tx.query("RELEASE SAVEPOINT tennis_ai_question_write");
  }
}

export async function beginAssistantQuestion(tx: pg.PoolClient, input: {
  id: string; tenantId: string; venueId: string; conversationId: string;
  content: string; page: string; source?: QuestionSource; secrets: readonly string[];
}, log?: QuestionLogger) {
  return bestEffort(tx, "AI_QUESTION_RECORD_FAILED", async () => {
    const redacted = redactAssistantQuestion(input.content, input.secrets);
    const release = process.env.TENNIS_RELEASE_VERSION;
    const applicationVersion = release && /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,79}$/.test(release) ? release : version;
    await tx.query(`INSERT INTO tennis.ai_question_records
      (id,tenant_id,venue_id,conversation_id,question_redacted,source,page,topic,application_version)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [input.id, input.tenantId, input.venueId, input.conversationId, redacted, input.source ?? "UNKNOWN", assistantQuestionPage(input.page), assistantQuestionTopic(redacted), applicationVersion]);
  }, log);
}

export function assistantQuestionError(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return typeof code === "string" && errorCodes.has(code) ? code : "ASSISTANT_UNAVAILABLE";
}

export async function finishAssistantQuestion(tx: pg.PoolClient, input: {
  id: string; tenantId: string; outcome: "ANSWERED" | "FAILED" | "INTERRUPTED";
  errorCode: string | null; tools: Set<string>; startedAt: number;
}, log?: QuestionLogger) {
  return bestEffort(tx, "AI_QUESTION_FINISH_FAILED", () => tx.query(`UPDATE tennis.ai_question_records
    SET outcome=$3,error_code=$4,tools_used=$5::text[],duration_ms=$6,updated_at=clock_timestamp()
    WHERE id=$1 AND tenant_id=$2 AND outcome='PENDING'`,
  [input.id, input.tenantId, input.outcome, input.errorCode === null ? null : assistantQuestionError({ code: input.errorCode }),
    [...input.tools].filter((name) => questionToolNames.has(name)), Math.min(600000, Math.max(0, Date.now() - input.startedAt))]), log);
}

export async function feedbackAssistantQuestion(tx: pg.PoolClient, tenantId: string, requestId: string, resolved: boolean, log?: QuestionLogger) {
  return bestEffort(tx, "AI_QUESTION_FEEDBACK_FAILED", () => tx.query(`UPDATE tennis.ai_question_records
    SET feedback=$3,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND outcome='ANSWERED'
    AND created_at>clock_timestamp()-interval '90 days' AND feedback<>$3`,
  [tenantId, requestId, resolved ? "RESOLVED" : "UNRESOLVED"]), log);
}

export async function maintainAssistantQuestions(db: pg.Pool, log?: QuestionLogger) {
  let tx: pg.PoolClient | undefined;
  try {
    tx = await db.connect();
    await tx.query("BEGIN");
    await tx.query("SET LOCAL lock_timeout='500ms'");
    await tx.query("SET LOCAL statement_timeout='5s'");
    await tx.query("SELECT tennis.maintain_ai_questions()");
    await tx.query("COMMIT");
  } catch {
    await tx?.query("ROLLBACK").catch(() => {});
    diagnose("AI_QUESTION_MAINTENANCE_FAILED", log);
  } finally { tx?.release(); }
}
