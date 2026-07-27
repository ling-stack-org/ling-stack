import { RefreshCw, Trash2, X } from "lucide-react";
import { useRef } from "react";
import { useI18n } from "../../i18n.js";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  InlineFeedback,
  InspectorSection,
  StatusIndicator,
} from "../../shared/ui/index.js";
import type { MediaScene } from "../../types.js";
import type { MediaProductionFailure, MediaProductionMutationOutcome } from "./media-production-types.js";

export function SceneDeleteDialog({
  failure,
  isDeleting,
  onClearFailure,
  onClose,
  onConfirm,
  onDeleted,
  onRestoreFocus,
  scene,
}: {
  readonly failure?: MediaProductionFailure;
  readonly isDeleting: boolean;
  readonly onClearFailure: () => void;
  readonly onClose: () => void;
  readonly onConfirm: () => Promise<MediaProductionMutationOutcome>;
  readonly onDeleted: () => void;
  readonly onRestoreFocus: () => void;
  readonly scene: MediaScene;
}): JSX.Element {
  const { t } = useI18n();
  const cancelRef = useRef<HTMLButtonElement>(null);

  async function confirm(): Promise<void> {
    const outcome = await onConfirm();
    if (outcome.ok) onDeleted();
  }

  return (
    <Dialog busy={isDeleting} open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        className="scene-delete-dialog"
        data-media-production-dialog="delete-scene"
        overlayClassName="scene-delete-overlay"
        size="sm"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          cancelRef.current?.focus({ preventScroll: true });
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onRestoreFocus();
        }}
      >
        <DialogHeader
          closeLabel={t("Close")}
          description={t("The scene leaves this project. Existing generated clips and task history remain available.")}
          title={t("Delete scene {name}?", { name: scene.title })}
        />
        <DialogBody className="scene-delete-body">
          <div className="scene-delete-summary">
            <Trash2 aria-hidden="true" size={18} />
            <span><strong>{scene.title}</strong><small>{t("Scene {number}", { number: scene.sortOrder + 1 })}</small></span>
            <StatusIndicator label={t("Permanent action")} tone="danger" />
          </div>
          {failure ? (
            <InlineFeedback role="alert" title={t(failure.productMessageKey)} tone="danger">
              <div className="media-production-delete-failure-actions">
                <Button disabled={isDeleting} leadingIcon={<RefreshCw size={14} />} size="sm" variant="secondary" onClick={() => void confirm()}>{t("Retry")}</Button>
                <Button disabled={isDeleting} leadingIcon={<X size={14} />} size="sm" variant="ghost" onClick={onClearFailure}>{t("Clear")}</Button>
              </div>
              {failure.technicalMessage ? (
                <InspectorSection title={t("Technical details")} summary={t("Error details")}>
                  <code>{failure.technicalMessage}</code>
                </InspectorSection>
              ) : null}
            </InlineFeedback>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button ref={cancelRef} disabled={isDeleting} size="sm" variant="secondary" onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button
            leadingIcon={<Trash2 aria-hidden="true" size={15} />}
            loading={isDeleting}
            loadingLabel={t("Deleting scene")}
            size="sm"
            variant="danger"
            onClick={() => void confirm()}
          >
            {t("Delete scene")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
