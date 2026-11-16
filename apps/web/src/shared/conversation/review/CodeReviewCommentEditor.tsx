import { useI18n } from "../../../i18n.js";
import { Button, InlineFeedback, Textarea } from "../../ui/index.js";
import { useReviewDraft } from "./ReviewDraftContext.js";
import type { CodeReviewSelection } from "./code-review-draft.js";
export function CodeReviewCommentEditor({ path, selection, revision, diffHunk, text, storageError, onTextChange, onClose }: {
  readonly path: string; readonly selection: CodeReviewSelection; readonly revision?: string; readonly diffHunk: string;
  readonly text: string; readonly storageError: boolean; readonly onTextChange: (text: string) => void; readonly onClose: () => void;
}): React.JSX.Element {
  const { t } = useI18n(); const review = useReviewDraft();
  return <div className="code-review-comment-editor">
    <strong>{t(selection.side === "left" ? "Original" : "Modified")} · {selection.startLine === selection.line ? selection.line : `${selection.startLine}-${selection.line}`}</strong>
    <Textarea autoFocus aria-label={t("Review comment")} placeholder={t("Describe the change you want...")} rows={3} maxLength={8000} value={text} onChange={event => onTextChange(event.target.value)} />
    {storageError ? <InlineFeedback tone="danger">{t("Review draft could not be saved on this device.")}</InlineFeedback> : null}
    <div><Button variant="ghost" size="sm" onClick={onClose}>{t("Cancel")}</Button><Button size="sm" disabled={!text.trim() || !review || review.refs.length >= 12} onClick={() => {
      if (review?.save({ path, line: selection.line, source: "composer", annotation: { kind: "code", id: crypto.randomUUID(), side: selection.side, startLine: selection.startLine, text: text.trim(), ...(revision ? { revision } : {}), ...(diffHunk.trim() ? { diffHunk } : {}) } })) onClose();
    }}>{t("Add comment")}</Button></div>
  </div>;
}
