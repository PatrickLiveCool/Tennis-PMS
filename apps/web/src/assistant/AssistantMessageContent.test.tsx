import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AssistantMessageContent } from "./AssistantMessageContent";

describe("assistant answer formatting boundary", () => {
  it("formats the reported member guidance without exposing Markdown markers", () => {
    const html = renderToStaticMarkup(<AssistantMessageContent text={
      "已为你打开**会员管理页面**，请按以下步骤操作：\n\n1. **搜索会员**：输入姓名、昵称或手机号。\n2. **查看档案**：点击会员查看详细信息。\n3. **选择操作**：根据需求继续。\n\n如有需要，可以告诉我你想搜索哪位会员。"
    } />);
    expect(html).toContain("<strong>会员管理页面</strong>");
    expect(html).toContain("<ol>");
    expect(html.match(/<li>/g)).toHaveLength(3);
    expect(html).not.toContain("**");
    expect(html).toContain("<p>如有需要");
  });

  it("allows text formatting without model-supplied navigation, resources or HTML controls", () => {
    const html = renderToStaticMarkup(<AssistantMessageContent text={[
      "[会员入口](/members) [外部网站](https://example.com) [危险链接](javascript:alert%281%29)",
      "![跟踪图片](https://example.com/pixel.png)",
      '<script>alert("unsafe")</script>',
      '<img src="https://example.com/pixel2.png" onerror="alert(1)">',
      '<form><input autofocus><button>提交</button></form>',
      "安全的**操作说明**"
    ].join("\n\n")} />);
    expect(html).toContain("会员入口");
    expect(html).toContain("外部网站");
    expect(html).toContain("<strong>操作说明</strong>");
    expect(html).not.toMatch(/<(a|img|script|form|input|button|iframe)\b/);
    expect(html).not.toMatch(/href=|src=|onerror=|autofocus/);
  });

  it("preserves literal business text while laying out comparison tables", () => {
    const html = renderToStaticMarkup(<AssistantMessageContent text={
      "手机号 138****1234；2 * 3 = 6；余额 -100 元。\n\n| 项目 | 金额 |\n| --- | --- |\n| 房费 | 100 元 |"
    } />);
    expect(html).toContain("138****1234");
    expect(html).toContain("2 * 3 = 6");
    expect(html).toContain("-100 元");
    expect(html).toContain("<table>");
    expect(html).toContain("<td>100 元</td>");
  });
});
