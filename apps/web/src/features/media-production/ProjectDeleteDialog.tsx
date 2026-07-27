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
import type { MediaProject } from "../../types.js";
import type { MediaProductionFailure, MediaProductionMutationOutcome } from "./media-production-types.js";

export function ProjectDeleteDialog({
  failure,
  isDeleting,
  onClearFailure,
  onClose,
  onConfirm,
  onDeleted,
  onRestoreFocus,
  project,
  sceneCount,
}: {
  readonly failure?: MediaProductionFailure;
  readonly isDeleting: boolean;
  readonly onClearFailure: () => void;
  readonly onClose: () => void;
  readonly onConfirm: () => Promise<MediaProductionMutationOutcome>;
  readonly onDeleted: () => void;
  readonly onRestoreFocus: () => void;
  readonly project: MediaProject;
  readonly sceneCount: number;
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
        className="project-delete-dialog"
        data-media-production-dialog="delete-project"
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
          description={t("Deleting a project removes its scenes. Existing generation tasks and artifacts remain available.")}
          title={t("Delete project {name}?", { name: project.name })}
        />
        <DialogBody className="project-delete-body">
          <div className="project-delete-summary">
            <Trash2 aria-hidden="true" size={18} />
            <span><strong>{project.name}</strong><small>{t("{count} scenes", { count: sceneCount })}</small></span>
            <StatusIndicator label={t("Permanent action")} tone="danger" />
          </div>
          {failure ? (
            <DeleteFailure
              failure={failure}
              isDeleting={isDeleting}
              onClear={onClearFailure}
              onRetry={() => void confirm()}
            />
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button ref={cancelRef} disabled={isDeleting} size="sm" variant="secondary" onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button
            leadingIcon={<Trash2 aria-hidden="true" size={15} />}
            loading={isDeleting}
            loadingLabel={t("Deleting media project")}
            size="sm"
            variant="danger"
            onClick={() => void confirm()}
          >
            {t("Delete project")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteFailure({
  failure,
  isDeleting,
  onClear,
  onRetry,
}: {
  readonly failure: MediaProductionFailure;
  readonly isDeleting: boolean;
  readonly onClear: () => void;
  readonly onRetry: () => void;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <InlineFeedback role="alert" title={t(failure.productMessageKey)} tone="danger">
      <div className="media-production-delete-failure-actions">
        <Button disabled={isDeleting} leadingIcon={<RefreshCw size={14} />} size="sm" variant="secondary" onClick={onRetry}>{t("Retry")}</Button>
        <Button disabled={isDeleting} leadingIcon={<X size={14} />} size="sm" variant="ghost" onClick={onClear}>{t("Clear")}</Button>
      </div>
      {failure.technicalMessage ? (
        <InspectorSection title={t("Technical details")} summary={t("Error details")}>
          <code>{failure.technicalMessage}</code>
        </InspectorSection>
      ) : null}
    </InlineFeedback>
  );
}
