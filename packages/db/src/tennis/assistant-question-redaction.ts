/** Local, deterministic best-effort redaction; arbitrary prose is not guaranteed anonymous. */
function normalized(input: string): string {
  return input.normalize("NFKC").replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, "");
}

export function redactAssistantQuestion(input: string, secrets: readonly string[] = []): string {
  let output = normalized(input);
  // Literal replacement handles punctuation in keys and masks longer overlapping
  // keys first. Normalize both sides so full-width / invisible copies also match.
  for (const secret of [...new Set(secrets.map((value) => normalized(value).trim()).filter(Boolean))]
    .sort((left, right) => right.length - left.length))
    output = output.split(secret).join("[凭据]");
  return output
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[邮箱]")
    .replace(/(?:https?:\/\/|ftp:\/\/|wss?:\/\/|www\.)[^\s<>，。；！]+/gi, "[链接]")
    .replace(/\b(?:Bearer\s+|sk[-_]|sess[-_]|gh[pousr]_)[A-Za-z0-9._~+/=-]+/gi, "[凭据]")
    .replace(/((?:api[ _-]?key|access[ _-]?token|refresh[ _-]?token|token|password|passwd|secret(?:[ _-]?key)?|authorization|密码|口令|密钥|令牌|验证码)(?:\s*[:=是为]\s*|\s+))(?:"[^"\n]*"|'[^'\n]*'|[^\s,，;；。"'<>]+)/gi, "$1[凭据]")
    .replace(/\b(?:customer|order|quote|subject|session|payment|receipt|tenant|venue|court|member|contract|refund|topup|booking)[_:-][A-Za-z0-9][A-Za-z0-9_.:-]*/gi, "[标识]")
    .replace(/((?:customer|order|quote|subject|session|payment|receipt|tenant|venue|court)[ _-]?id\s*[:=]\s*)["']?[A-Za-z0-9][A-Za-z0-9_.:-]*["']?/gi, "$1[标识]")
    .replace(/\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/gi, "[标识]")
    .replace(/(?<!\d)\d{17}[\dXx](?!\d)/g, "[证件]")
    .replace(/(?<!\d)(?:\+?86[ ()-]?)?1[3-9](?:[ ()-]?\d){9}(?!\d)/g, "[电话]")
    .replace(/(?<!\d)0\d{2,3}[- ]?\d{7,8}(?!\d)/g, "[电话]")
    // Stop before a following business date / amount instead of absorbing it as
    // another space-separated phone group.
    .replace(/\+\d(?:(?!\s+(?:\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d+(?:\.\d+)?\s*(?:元|块|CNY|RMB|号|点|折)))[ ()-]*\d){6,14}(?!\d)/gi, "[电话]")
    .replace(/\b(?:\d{12,}|\d{4}(?:[ -]\d{4}){2,4})\b/g, "[号码]")
    .replace(/((?:姓名|昵称|联系人|客户(?:姓名|名称|昵称)?|会员(?:姓名|名称|昵称)?|微信号|证件号|身份证号|护照号)\s*[:=是为]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,，;；。\n]+)/g, "$1[已隐去]")
    .replace(/[\p{Script=Han}]{2,4}(?=先生|女士|小姐)/gu, "[姓名]")
    .replace(/(?<![A-Za-z0-9_+/=-])[A-Za-z0-9_+/=-]{24,}(?![A-Za-z0-9_+/=-])/g, "[长标识]")
    .slice(0, 8000).trim() || "[空白问题]";
}

export const assistantQuestionTopics = ["BOOKING", "RESCHEDULING", "CANCELLATION", "REFUND", "PAYMENT", "MEMBERSHIP",
  "PRICING", "AVAILABILITY", "ORDER_QUERY", "SYSTEM_HELP", "OTHER"] as const;

export function assistantQuestionTopic(input: string): string {
  const question = normalized(input);
  // Prefer the requested change / financial outcome over its shared booking nouns.
  for (const [pattern, topic] of [
    [/退款|退费|退回(?:本金|赠送|余额|款项)|\brefund\b/i, "REFUND"],
    [/取消|退订|撤销(?:订单|预约|预订)|\bcancel(?:lation)?\b/i, "CANCELLATION"],
    [/改期|改约|换场|调场|换球场|更换球场|改(?:一下)?(?:时间|日期)|调整(?:预约|预订|订单)?(?:时间|日期)|\breschedul(?:e|ing)\b/i, "RESCHEDULING"],
    [/折扣|报价|价格|单价|定价|计价|多少钱|收费标准|\bpric(?:e|ing)\b|\bdiscount\b/i, "PRICING"],
    [/收款|付款|支付|补款|欠款|收钱|转账|流水|核对(?:款项|实收)|\bpayment\b/i, "PAYMENT"],
    [/会员|充值|储值|本金|赠送|余额|\bmembership\b|\btop[ -]?up\b/i, "MEMBERSHIP"],
    [/排场|空场|空闲|可用(?:时段|球场)|还有(?:场|时段)|有(?:没有|哪些)(?:场|球场)|场地占用|\bavailability\b/i, "AVAILABILITY"],
    [/(?:查询|查看|核对|找|查)(?:一下|我的|这笔|这个|原)?(?:订单|预约|预订)|(?:订单|预约|预订)(?:列表|记录|详情|状态)|\border\s+(?:status|query)\b/i, "ORDER_QUERY"],
    [/预订|预约|订场|订(?:个|一个)?(?:球场|场地)|约球|\bbook(?:ing)?\b/i, "BOOKING"],
    [/订单|\border\b/i, "ORDER_QUERY"],
    [/设置|怎么操作|如何操作|入口|登录|权限|账号|系统|帮助|\b(?:settings|login|help)\b/i, "SYSTEM_HELP"],
  ] as const) if (pattern.test(question)) return topic;
  return "OTHER";
}

export const assistantQuestionPages = ["schedule", "orders", "members", "settings", "unknown"] as const;
export function assistantQuestionPage(input: string): string {
  const pages: Record<string, string> = {
    schedule: "schedule", booking: "schedule", 排场: "schedule", 球场排场: "schedule", 预订: "schedule", 订场: "schedule",
    orders: "orders", order: "orders", 订单: "orders", 订单详情: "orders",
    members: "members", 会员: "members", 会员管理: "members", 会员储值: "members",
    settings: "settings", 设置: "settings", 系统设置: "settings",
  };
  const page = normalized(input).trim().toLowerCase();
  return Object.hasOwn(pages, page) ? pages[page]! : "unknown";
}
