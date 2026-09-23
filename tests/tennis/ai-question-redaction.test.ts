import { describe, expect, it } from "vitest";
import { assistantQuestionPage, assistantQuestionPages, assistantQuestionTopic, assistantQuestionTopics,
  redactAssistantQuestion } from "../../packages/db/src/tennis/assistant-question-redaction.ts";

describe("local deterministic Tennis assistant question redaction", () => {
  it("masks full-width / invisible mainland phones, international phones, emails, URLs and document numbers", () => {
    const output = redactAssistantQuestion("１３８０００００００１ 139\u200b00000002 +86 137-0000-0003 +1 (202) 555-0123 010-12345678 alice@example.com https://example.com/?phone=13600000004 11010519900101001X");
    for (const sensitive of ["13800000001", "13900000002", "137", "202", "12345678", "alice", "example.com", "13600000004", "110105"])
      expect(output).not.toContain(sensitive);
    expect(output.match(/\[电话\]/g)).toHaveLength(5);
    expect(output).toContain("[邮箱]"); expect(output).toContain("[链接]"); expect(output).toContain("[证件]");
  });

  it("redacts credential formats and quoted labels without exposing values after whitespace", () => {
    const output = redactAssistantQuestion('Bearer abc.def_GHI-123 sk-privateValue123 ghp_GitHubPrivateToken123 密码: "two word password" api_key=vendorPrivateKey token:opaqueSecret secret_key:anotherSecret 验证码:827361');
    for (const sensitive of ["abc.def", "privateValue", "GitHub", "two", "word", "vendorPrivateKey", "opaqueSecret", "anotherSecret", "827361"])
      expect(output).not.toContain(sensitive);
    expect(output).toContain("[凭据]");
  });

  it("redacts literal known API keys, including punctuation and normalized copies, without regex interpretation", () => {
    const key = "vendor.a+$[secret](demo)";
    const output = redactAssistantQuestion(`问题中是 ${key} 和 vendor.a+$[secret](demo)Tail，另一个是 ＫＥＹ\u200b１２３。`,
      ["", "  ", key, `${key}Tail`, "KEY123"]);
    expect(output).toBe("问题中是 [凭据] 和 [凭据],另一个是 [凭据]。");
    expect(redactAssistantQuestion("多少钱", [])).toBe("多少钱");
  });

  it("redacts every Tennis identifier prefix, UUIDs and long opaque identifiers while retaining ordinary court numbers", () => {
    const prefixes = ["customer", "order", "quote", "subject", "session", "payment", "receipt", "tenant", "venue", "court"];
    const output = redactAssistantQuestion(prefixes.map((prefix) => `${prefix}_private-123`).join(" ") +
      " customerId=private123 550e8400-e29b-41d4-a716-446655440000 abcdefghijklmnopqrstuvwxyz0123456789 场地 3 号 Court 2");
    expect(output).not.toContain("private"); expect(output).not.toContain("550e8400");
    expect(output).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(output).toContain("场地 3 号 Court 2");
    expect(output).toContain("customerId=[标识]");
  });

  it("redacts labelled customer names, contacts and identity handles including quoted multiword names", () => {
    const output = redactAssistantQuestion('姓名：张三，昵称=小张；联系人:李四 客户:王五 会员昵称:赵六 微信号:wx-private 证件号:AB123456 护照号:P1234567 客户姓名:"Alice Smith" 张三先生');
    for (const sensitive of ["张三", "小张", "李四", "王五", "赵六", "wx-private", "AB123456", "P1234567", "Alice", "Smith"])
      expect(output).not.toContain(sensitive);
    expect(output).toContain("客户姓名:[已隐去]"); expect(output).toContain("[姓名]先生");
  });

  it("preserves useful booking date, time, court and pricing facts", () => {
    const input = "2026-09-23 18:00–19:00 3号球场报价 120.00元，充值本金1000元赠送200元，折扣8折，2026/09/24 改到2号场。";
    expect(redactAssistantQuestion(input)).toBe(input.normalize("NFKC"));
    expect(redactAssistantQuestion("预订 2099-09-23T18:00:00+08:00 到 2099-09-23T19:00:00+08:00")).toContain("2099-09-23T18:00:00+08:00");
    expect(redactAssistantQuestion("电话 +1 (202) 555-0123 2026-09-23 120元")).toBe("电话 [电话] 2026-09-23 120元");
    expect(redactAssistantQuestion("电话 +1 (202) 555-0123 120元")).toBe("电话 [电话] 120元");
  });

  it("is stable on already-redacted prose, bounds stored text and never returns invisible-only content", () => {
    const once = redactAssistantQuestion("电话13800000001，客户:张三，日期2026-09-23，报价120元。");
    expect(redactAssistantQuestion(once)).toBe(once);
    expect(redactAssistantQuestion("预订".repeat(5000))).toHaveLength(8000);
    expect(redactAssistantQuestion(" \u200b\u2060\ufeff ")).toBe("[空白问题]");
  });
});

describe("bounded Tennis question dimensions", () => {
  it.each([
    ["我要取消这个预订", "CANCELLATION"], ["取消订单并把支付款退款", "REFUND"],
    ["把明天的预订改期到后天", "RESCHEDULING"], ["已经付款的预订要换场", "RESCHEDULING"],
    ["这个订单的支付如何退款", "REFUND"], ["会员充值款如何退回本金", "REFUND"],
    ["预订报价有多少折扣", "PRICING"], ["会员支付价格怎么算", "PRICING"],
    ["核对这个预约的付款流水", "PAYMENT"], ["会员余额和赠送金额", "MEMBERSHIP"],
    ["查询明天的空场再预订", "AVAILABILITY"], ["查看我的预订记录", "ORDER_QUERY"],
    ["给我订一个球场", "BOOKING"], ["怎么登录设置页面", "SYSTEM_HELP"], ["早上好", "OTHER"],
    ["ｒｅｆｕｎｄ payment", "REFUND"], ["预\u200b订", "BOOKING"],
  ])("classifies %s as %s", (input, expected) => {
    const topic = assistantQuestionTopic(input); expect(topic).toBe(expected); expect(assistantQuestionTopics).toContain(topic);
  });

  it.each([
    ["schedule", "schedule"], ["booking", "schedule"], ["排场", "schedule"],
    [" orders ", "orders"], ["订单详情", "orders"], ["members", "members"], ["会员管理", "members"],
    ["ＳＥＴＴＩＮＧＳ", "settings"], ["设置", "settings"],
    ["__proto__", "unknown"], ["toString", "unknown"], ["constructor", "unknown"],
    ["姓名:张三", "unknown"], ["orders?phone=13800000001", "unknown"], ["unknown", "unknown"], ["", "unknown"],
  ])("maps only allowlisted page %s to %s", (input, expected) => {
    const page = assistantQuestionPage(input); expect(page).toBe(expected); expect(assistantQuestionPages).toContain(page);
  });
});
