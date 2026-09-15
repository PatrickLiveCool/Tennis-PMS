import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

// Model output may format text, but cannot create links, images, or controls.
// Navigation remains exclusively in the server-validated entry buttons.
const allowedElements = [
  "p", "br", "strong", "em", "del", "ul", "ol", "li",
  "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "hr", "pre", "code",
  "table", "thead", "tbody", "tr", "th", "td"
];
const components: Components = {
  table: ({ children }) => <div className="assistant-table-scroll" role="region" aria-label="回答中的表格" tabIndex={0}><table>{children}</table></div>
};

export function AssistantMessageContent({ text }: { text: string }) {
  return <div className="assistant-message-text assistant-markdown">
    <Markdown remarkPlugins={[remarkGfm]} allowedElements={allowedElements} unwrapDisallowed skipHtml components={components}>{text}</Markdown>
  </div>;
}
