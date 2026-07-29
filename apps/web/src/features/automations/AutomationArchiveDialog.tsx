import { Archive } from "lucide-react";
import { Button, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, InlineFeedback } from "../../shared/ui/index.js";
import type { AutomationDefinition } from "../../types.js";
import type { AutomationTranslate } from "./automation-view-models.js";

export function AutomationArchiveDialog({
  automation,
  busy,
  error,
  t,
  onConfirm,
  onOpenChange,
}: {
  readonly automation?: AutomationDefinition;
  readonly busy: boolean;
  readonly error: string;
  readonly t: AutomationTranslate;
  readonly onConfirm: () => void;
  readonly onOpenChange: (open: boolean) => void;
}): JSX.Element {
  return (
    <Dialog busy={busy} open={Boolean(automation)} onOpenChange={onOpenChange}>
      <DialogContent className="automation-ui2-confirm-dialog" size="sm">
        <DialogHeader closeLabel={t("Close")} title={t("Archive")} />
        <DialogBody>
          <p>{automation?.title}</p>
          {error ? <InlineFeedback title={t("Setup needs attention")} tone="danger">{error}</InlineFeedback> : null}
        </DialogBody>
        <DialogFooter>
          <Button disabled={busy} onClick={() => onOpenChange(false)} variant="ghost">{t("Cancel")}</Button>
          <Button leadingIcon={<Archive size={15} />} loading={busy} loadingLabel={t("Archive")} onClick={onConfirm} variant="danger">
            {t("Archive")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
