import { Trash2 } from "lucide-react";
import { Button, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, InlineFeedback } from "../../shared/ui/index.js";
import type { AutomationDraft } from "../../types.js";
import type { AutomationTranslate } from "./automation-view-models.js";

export function AutomationDiscardDraftDialog({
  busy,
  draft,
  error,
  t,
  onConfirm,
  onOpenChange,
}: {
  readonly busy: boolean;
  readonly draft?: AutomationDraft;
  readonly error: string;
  readonly t: AutomationTranslate;
  readonly onConfirm: () => void;
  readonly onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  return (
    <Dialog busy={busy} open={Boolean(draft)} onOpenChange={onOpenChange}>
      <DialogContent className="automation-ui2-confirm-dialog" size="sm">
        <DialogHeader closeLabel={t("Close")} title={t("Discard draft")} />
        <DialogBody>
          <p>{draft?.title ?? t("Untitled draft")}</p>
          {error ? <InlineFeedback title={t("Setup needs attention")} tone="danger">{error}</InlineFeedback> : null}
        </DialogBody>
        <DialogFooter>
          <Button disabled={busy} onClick={() => onOpenChange(false)} variant="ghost">{t("Cancel")}</Button>
          <Button leadingIcon={<Trash2 size={15} />} loading={busy} loadingLabel={t("Discard")} onClick={onConfirm} variant="danger">
            {t("Discard")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
