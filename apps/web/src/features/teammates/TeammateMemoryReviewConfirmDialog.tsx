import { useI18n } from "../../i18n.js";
import { Button, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, InlineFeedback } from "../../shared/ui/index.js";
import { memoryReviewActionConfirmation, memoryReviewActionLabel } from "./teammate-memory-view-models.js";
import type { TeammateMemoryController } from "./useTeammateMemoryController.js";

export function TeammateMemoryReviewConfirmDialog({ controller }: { readonly controller: TeammateMemoryController }): React.JSX.Element {
  const { t } = useI18n();
  const pending = controller.pendingReview;
  const busy = Boolean(pending && controller.reviewingId === pending.item.memory.id);
  return (
    <Dialog open={Boolean(pending)} busy={busy} onOpenChange={(open) => { if (!open) controller.cancelPendingReview(); }}>
      <DialogContent size="sm">
        <DialogHeader title={t(pending ? memoryReviewActionConfirmation(pending.action) : "Review this memory?")} closeLabel={t("Close")} />
        <DialogBody>
          {controller.reviewError ? <InlineFeedback tone="danger">{controller.reviewError}</InlineFeedback> : null}
          <p>{t("This preserves an auditable memory lifecycle. It does not permanently delete the memory.")}</p>
          {pending ? <strong>{pending.item.memory.title}</strong> : null}
        </DialogBody>
        <DialogFooter>
          <Button size="sm" variant="secondary" disabled={busy} onClick={controller.cancelPendingReview}>{t("Cancel")}</Button>
          <Button size="sm" variant="danger" loading={busy} onClick={() => void controller.confirmReview()}>
            {t(pending ? memoryReviewActionLabel(pending.action) : "Confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
