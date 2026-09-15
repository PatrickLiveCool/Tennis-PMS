import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import type { FastifyBaseLogger } from "fastify";
import type { AuthPrincipal } from "@qintopia/contracts";
import type { Database } from "@qintopia/db";
import { version as applicationVersion } from "../../../package.json";
import type { AssistantChatRequest } from "../../../packages/contracts/src/assistant.ts";

/** Best-effort deterministic redaction, not a guarantee of anonymity for arbitrary prose. */
export function redactAssistantQuestion(input: string): string {
  return input.normalize("NFKC")
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, "")
    .replace(/(?:https?:\/\/|www\.)[^\s<>，。；！]+/gi, "[链接]")
    .replace(/\b(?:Bearer\s+|sk[-_]|sess[-_]|gh[pousr]_)[A-Za-z0-9._~+/=-]+/gi, "[凭据]")
    .replace(/((?:api[ _-]?key|access[ _-]?token|token|password|secret|密码|密钥|令牌|验证码)(?:\s*[：:=是为]\s*|\s+))["']?[^\s,，;；。"']+["']?/gi, "$1[凭据]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[邮箱]")
    .replace(/\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/gi, "[标识]")
    .replace(/\b(?:order|member|session|subject|contract|payment)_[A-Za-z0-9_-]+\b/g, "[标识]")
    .replace(/\b\d{17}[\dXx]\b/g, "[证件]")
    .replace(/(?:\+?86[ -]?)?1[3-9](?:[ -]?\d){9}(?!\d)/g, "[电话]")
    .replace(/(?:\+\d[\d ()-]{7,}\d|\b0\d{2,3}[- ]?\d{7,8}\b)/g, "[电话]")
    .replace(/\b(?:\d{12,}|\d{4}(?:[ -]\d{4}){2,4})\b/g, "[号码]")
    .replace(/((?:姓名|昵称|联系人|住客|客人|会员|微信号|证件号|护照号)\s*[：:=]\s*)[^\s,，;；。\n]+/g, "$1[已隐去]")
    .replace(/([\p{Script=Han}]{2,4})(?=先生|女士|小姐)/gu, "[姓名]")
    .replace(/\b[A-Za-z0-9_+/=-]{24,}\b/g, "[长标识]")
    .slice(0, 8000).trim() || "[空白问题]";
}

export function assistantQuestionTopic(input: string): string {
  for (const [pattern, topic] of [
    [/续住|延住|延长住宿|延长入住|推迟离店/, "STAY_EXTENSION"],
    [/换房|换床|调房/, "MOVE_ROOM"],
    [/取消|退订/, "CANCELLATION"],
    [/收款|付款|支付|退款|金额|费用|欠款/, "PAYMENT"],
    [/会员|权益|合同|核销/, "MEMBERSHIP"],
    [/房态|空房|可用|房间|床位/, "AVAILABILITY"],
    [/订单|预订/, "ORDER_QUERY"],
    [/设置|怎么操作|如何操作|入口|登录/, "SYSTEM_HELP"]
  ] as const) if (pattern.test(input)) return topic;
  return "OTHER";
}

export function assistantQuestionPage(page: string): string {
  const pages: Record<string, string> = { 房态: "inventory", 订单: "orders", 订单详情: "order", 会员: "members", 工作台: "today", 设置: "settings" };
  return Object.hasOwn(pages, page) ? pages[page]! : "unknown";
}

export async function beginAssistantQuestion(db: Kysely<Database>, logger: FastifyBaseLogger, principal: AuthPrincipal, body: AssistantChatRequest, conversationId: string): Promise<string | undefined> {
  const id = randomUUID();
  try {
    const redacted = redactAssistantQuestion(body.message);
    await sql`SELECT qintopia_begin_ai_question(${id}, ${principal.subjectId}, ${principal.credentialId}, ${body.propertyId},
      ${conversationId}, ${redacted}, ${body.source ?? "UNKNOWN"}, ${assistantQuestionPage(body.page)}, ${assistantQuestionTopic(redacted)}, ${applicationVersion})`.execute(db);
    return id;
  } catch {
    logger.warn({ code: "AI_QUESTION_RECORD_FAILED" }, "Assistant question telemetry unavailable");
    return undefined;
  }
}

export async function finishAssistantQuestion(db: Kysely<Database>, logger: FastifyBaseLogger, questionId: string | undefined, principal: AuthPrincipal,
  outcome: "ANSWERED" | "FAILED", errorCode: string | null, tools: Set<string>, startedAt: number) {
  if (!questionId) return;
  try {
    await sql`SELECT qintopia_finish_ai_question(${questionId}, ${principal.subjectId}, ${principal.credentialId}, ${outcome},
      ${errorCode}, ${[...tools]}::text[], ${Math.min(600000, Math.max(0, Date.now() - startedAt))})`.execute(db);
  } catch { logger.warn({ code: "AI_QUESTION_FINISH_FAILED" }, "Assistant question telemetry unavailable"); }
}

export async function maintainAssistantQuestions(db: Kysely<Database>, logger: FastifyBaseLogger) {
  try { await sql`SELECT qintopia_maintain_ai_questions()`.execute(db); }
  catch { logger.warn({ code: "AI_QUESTION_MAINTENANCE_FAILED" }, "Assistant question retention maintenance unavailable"); }
}
