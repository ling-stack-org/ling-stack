import { useRef, useState } from "react";
import { Play } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { providerCompactModelLabel } from "../../lib/providers.js";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  InlineFeedback,
  StatusIndicator,
} from "../../shared/ui/index.js";
import type { MediaProductionFailure } from "./media-production-types.js";
import type { ProjectRunReview } from "./media-production-view-models.js";

export function ProjectRunReviewDialog({
  failure,
  review,
  onClose,
  onConfirm,
  onRestoreFocus,
  isSubmitting,
}: {
  readonly failure?: MediaProductionFailure;
  readonly review: ProjectRunReview;
  readonly onClose: () => void;
  readonly onConfirm: () => Promise<void>;
  readonly onRestoreFocus: () => void;
  readonly isSubmitting: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const confirmInFlight = useRef(false);
  const [confirmPending, setConfirmPending] = useState(false);
  const busy = isSubmitting || confirmPending;
  const hasReadyScenes = review.ready.length > 0;
  const title = `${t(hasReadyScenes ? "Run" : "Check")} · ${t("{count} scenes", { count: review.ready.length })}`;

  async function confirm(): Promise<void> {
    if (!hasReadyScenes || confirmInFlight.current) return;
    confirmInFlight.current = true;
    setConfirmPending(true);
    try {
      await onConfirm();
    } finally {
      confirmInFlight.current = false;
      setConfirmPending(false);
    }
  }

  return (
    <Dialog open busy={busy} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        className="project-run-review-dialog"
        overlayClassName="project-run-review-overlay"
        size="md"
        data-media-production-dialog="project-run-review"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onRestoreFocus();
        }}
      >
        <DialogHeader
          closeLabel={t("Close")}
          title={title}
          description={t("Create independent video clips from ordered scenes. Generation tasks and results stay available in the task view.")}
        />
        <DialogBody className="project-run-review-body">
          {failure ? (
            <InlineFeedback tone="danger" title={t(failure.productMessageKey)} />
          ) : null}
          <section className="project-run-review-section" data-project-run-ready-count={review.ready.length}>
            <div className="project-run-review-section-head">
              <StatusIndicator
                label={`${t("Ready")} · ${t("{count} scenes", { count: review.ready.length })}`}
                tone={hasReadyScenes ? "success" : "neutral"}
              />
            </div>
            {review.ready.length ? (
              <ol className="project-run-review-list ready">
                {review.ready.map((item) => (
                  <li key={item.sceneId}>
                    <span>{String(item.sortOrder + 1).padStart(2, "0")}</span>
                    <strong title={item.sceneTitle}>{item.sceneTitle}</strong>
                    <small>{item.workflow?.definition.name ?? (item.provider ? providerCompactModelLabel(item.provider) : t("Default video model"))}</small>
                  </li>
                ))}
              </ol>
            ) : (
              <InlineFeedback tone="warning" title={t("Needs attention")}>
                {t("Add a scene, then define its visual and generation source.")}
              </InlineFeedback>
            )}
          </section>
          {review.skipped.length ? (
            <section className="project-run-review-section skipped" data-project-run-skipped-count={review.skipped.length}>
              <div className="project-run-review-section-head">
                <StatusIndicator
                  label={`${t("Skipped")} · ${t("{count} scenes", { count: review.skipped.length })}`}
                  tone="warning"
                />
              </div>
              <ul className="project-run-review-list">
                {review.skipped.map((item) => (
                  <li key={item.sceneId}>
                    <span>{String(item.sortOrder + 1).padStart(2, "0")}</span>
                    <strong title={item.sceneTitle}>{item.sceneTitle}</strong>
                    <small>{t(item.reasonKey, item.reasonValues)}</small>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button disabled={busy} variant="secondary" onClick={onClose}>
            {t(hasReadyScenes ? "Cancel" : "Close")}
          </Button>
          {hasReadyScenes ? (
            <Button
              leadingIcon={<Play size={16} />}
              loading={busy}
              loadingLabel={t("Loading")}
              variant="primary"
              onClick={() => void confirm()}
            >
              {t("Run")} · {t("{count} scenes", { count: review.ready.length })}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
