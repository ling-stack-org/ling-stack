import { useEffect, useState } from "react";
import type { CodeAssessmentComment, CodeAssessmentFinding } from "@ling-stack/contracts";
import { Button, Field, InlineFeedback, Textarea } from "../../shared/ui/index.js";
import { useI18n } from "../../i18n.js";
import { createCodeAssessmentComment, listCodeAssessmentComments } from "../../api/code-assessments.js";

export function FindingComments({ cwd, finding }: { readonly cwd: string; readonly finding: CodeAssessmentFinding }): React.JSX.Element {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [comments, setComments] = useState<readonly CodeAssessmentComment[]>([]);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setBusy(true); setError(undefined);
    void listCodeAssessmentComments(cwd, finding.assessmentId, finding.id).then(result => { if (!cancelled) setComments(result.comments); })
      .catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [cwd, finding.assessmentId, finding.id, open, revision]);
  async function submit(): Promise<void> {
    if (busy || !body.trim()) return;
    setBusy(true); setError(undefined);
    try {
      await createCodeAssessmentComment(cwd, finding.assessmentId, finding.id, { snapshotDigest: finding.snapshotDigest, path: finding.path,
        side: finding.side, startLine: finding.startLine, endLine: finding.endLine, body });
      setBody(""); setRevision(current => current + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  return <div className="code-assessment-comments">
    <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen(current => !current)}>{t("Comments")}</Button>
    {open ? <div>
      {error ? <InlineFeedback tone="danger" title={t("Comment unavailable")}>{error}<Button size="sm" onClick={() => setRevision(current => current + 1)}>{t("Retry")}</Button></InlineFeedback> : null}
      <ol>{comments.map(comment => <li key={comment.id}><p>{comment.body}</p><small>{new Date(comment.createdAt).toLocaleString()}</small></li>)}</ol>
      <form onSubmit={event => { event.preventDefault(); void submit(); }}>
        <Field label={t("Finding comment")}><Textarea aria-label={t("Finding comment")} maxLength={4000} required value={body} onChange={event => setBody(event.target.value)} /></Field>
        <Button size="sm" type="submit" loading={busy} disabled={!body.trim() || busy || comments.length >= 100}>{t("Add comment")}</Button>
      </form>
    </div> : null}
  </div>;
}
