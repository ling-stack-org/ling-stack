import { useState } from "react";
import type { DesktopBrowserAnnotation } from "../../../../desktop/shared/browser-annotations.js";
import { Button, Checkbox, Textarea } from "../../shared/ui/index.js";
import { useI18n } from "../../i18n.js";
import { browserAnnotationSubmission, type BrowserAnnotationHandler } from "./browser-annotation-submission.js";

export function BrowserAnnotationEditor({ annotation, onSubmit, onClose, onLocate, status }: {
  readonly annotation: DesktopBrowserAnnotation; readonly onSubmit: BrowserAnnotationHandler; readonly onClose: () => void;
  readonly onLocate: () => void; readonly status?: "available" | "stale";
}): React.JSX.Element {
  const { t } = useI18n(); const [comment, setComment] = useState(""); const [image, setImage] = useState(true); const [busy, setBusy] = useState(false); const [failed, setFailed] = useState(false);
  return <div className="browser-annotation-editor" role="group" aria-label={t("Page annotation")}>
    <p>{annotation.url}</p>
    {annotation.anchor.excerpt ? <blockquote>{annotation.anchor.excerpt}</blockquote> : null}
    <Textarea aria-label={t("Annotation comment")} value={comment} maxLength={16000} onChange={event => setComment(event.currentTarget.value)} />
    {annotation.screenshot ? <Checkbox checked={image} label={t("Include selected screenshot")} onChange={event => setImage(event.currentTarget.checked)} /> : null}
    {status ? <p role="status">{status === "available" ? t("Annotation located") : t("Annotation is stale. Select the page again.")}</p> : null}
    {failed ? <p role="alert">{t("The annotation could not be added to the draft.")}</p> : null}
    <div className="browser-panel-actions">
      <Button size="sm" disabled={busy} onClick={onLocate}>{t("Locate annotation")}</Button>
      <Button size="sm" disabled={busy || !comment.trim()} onClick={() => {
        setBusy(true); setFailed(false); void onSubmit(browserAnnotationSubmission(annotation, comment, image)).then(onClose).catch(() => setFailed(true)).finally(() => setBusy(false));
      }}>{t("Add to message draft")}</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={onClose}>{t("Cancel")}</Button>
    </div>
  </div>;
}
