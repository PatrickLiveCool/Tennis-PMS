import { describe, expect, it } from "vitest";
import { assistantQuestionPage, assistantQuestionTopic, redactAssistantQuestion } from "./assistant-question-records.ts";

describe("assistant question minimization", () => {
  it("redacts labeled identities, contact numbers, credentials and resource identifiers", () => {
    const input = '姓名：张三，手机号 138 0000 0000，证件 11010119900101123X，邮箱 guest@example.com，API key: "private-key"，Bearer sensitive-token，https://example.com?q=private，订单 order_private123';
    const output = redactAssistantQuestion(input);
    for (const value of ["张三", "138", "110101", "guest@example", "private-key", "sensitive-token", "example.com", "order_private123"]) expect(output).not.toContain(value);
    expect(output).toContain("[电话]"); expect(output).toContain("[凭据]");
  });
  it("normalizes full-width input and hides common long identifiers", () => {
    const output = redactAssistantQuestion("１３８００００００００ 6222 0200 0000 0000 000 550e8400-e29b-41d4-a716-446655440000 sk-privatevalue123 张三先生");
    expect(output).not.toContain("13800000000"); expect(output).not.toContain("6222"); expect(output).not.toContain("550e8400"); expect(output).not.toContain("privatevalue"); expect(output).not.toContain("张三");
  });
  it("retains operational dates, amounts, room numbers, masked phones and genuine help questions", () => {
    const input = "101 房 2026-09-15 至 2026-09-17，续住 2 晚，费用 180.50 元，手机号 138****1234；密码怎么修改？";
    expect(redactAssistantQuestion(input)).toBe(input.normalize("NFKC"));
    expect(assistantQuestionTopic(input)).toBe("STAY_EXTENSION");
    expect(assistantQuestionTopic("需要取消这个订单")).toBe("CANCELLATION");
    expect(assistantQuestionTopic("早上好")).toBe("OTHER");
  });
  it("stores only recognized page labels and bounds text size", () => {
    expect(assistantQuestionPage("订单详情")).toBe("order");
    expect(assistantQuestionPage("__proto__")).toBe("unknown");
    expect(assistantQuestionPage("toString")).toBe("unknown");
    expect(assistantQuestionPage("姓名：张三")).toBe("unknown");
    expect(redactAssistantQuestion("续住".repeat(5000)).length).toBe(8000);
  });
});
