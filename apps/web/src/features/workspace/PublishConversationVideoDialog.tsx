import { useState } from "react";
import { publishRunVideo } from "../../api/media.js";
import { useI18n } from "../../i18n.js";
import { Button, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, Field, InlineFeedback, Input } from "../../shared/ui/index.js";

export function PublishConversationVideoDialog({ cwd, runId, onPublished, onClose }: {
  readonly cwd: string;
  readonly runId: string;
  readonly onPublished: () => Promise<void>;
  readonly onClose: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function publish(): Promise<void> {
    if (busy || !path.trim()) return;
    setBusy(true);
    setError("");
    try {
      await publishRunVideo(cwd, runId, path.trim());
      await onPublished();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("Could not publish video."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open busy={busy} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent size="sm">
        <form onSubmit={(event) => { event.preventDefault(); void publish(); }}>
          <DialogHeader title={t("Add video to response")} closeLabel={t("Close")} />
          <DialogBody>
            <Field label={t("Workspace MP4 path")}>
              <Input value={path} disabled={busy} onChange={(event) => setPath(event.target.value)} />
            </Field>
            {error ? <InlineFeedback tone="danger">{error}</InlineFeedback> : null}
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" disabled={busy} onClick={onClose}>{t("Cancel")}</Button>
            <Button variant="primary" type="submit" loading={busy} disabled={!path.trim()}>{t("Publish")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
