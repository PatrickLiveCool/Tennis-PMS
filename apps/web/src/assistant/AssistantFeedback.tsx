import { useRef, useState } from "react";
import type { AssistantQuestionFeedback } from "../../../../packages/contracts/src/assistant.ts";
import { api } from "../api";
import { errorMessage } from "../uiBasic";

export function AssistantFeedback({ questionId, propertyId, selected, onSaved }: {
  questionId: string; propertyId: string; selected: AssistantQuestionFeedback | undefined; onSaved: (feedback: AssistantQuestionFeedback) => void
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>();
  const pending = useRef(false);
  async function save(feedback: AssistantQuestionFeedback) {
    if (pending.current || selected === feedback) return;
    pending.current = true; setBusy(true); setError(undefined);
    try { await api.assistantFeedback(questionId, propertyId, feedback); onSaved(feedback); }
    catch (e) { setError(errorMessage(e)); }
    finally { pending.current = false; setBusy(false); }
  }
  return <div className="assistant-feedback">
    <div role="group" aria-label="这条回答是否解决了问题">
      <span>是否解决了问题？</span>
      <button type="button" disabled={busy} aria-pressed={selected === "RESOLVED"} onClick={() => void save("RESOLVED")}>已解决</button>
      <button type="button" disabled={busy} aria-pressed={selected === "UNRESOLVED"} onClick={() => void save("UNRESOLVED")}>未解决</button>
    </div>
    <span className="assistant-feedback-status" role="status">{busy ? "正在保存…" : selected ? "反馈已记录" : ""}</span>
    {error ? <p role="alert">{error}</p> : null}
  </div>;
}
