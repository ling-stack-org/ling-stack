import { ArchiveX, Trash2 } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { Button, InlineFeedback } from "../../shared/ui/index.js";
import type { AiTeammate } from "../../types.js";
import "../../styles/teammate-management-danger.css";
import { TeammateHardDeleteDialog } from "./TeammateHardDeleteDialog.js";
import type { TeammateDangerController } from "./useTeammateDangerController.js";

export function TeammateDangerTab({
  controller,
  teammate,
}: {
  readonly controller: TeammateDangerController;
  readonly teammate: AiTeammate;
}): React.JSX.Element {
  const { t } = useI18n();
  const { viewModel } = controller;

  if (viewModel.protectedTeammate) return <></>;

  return (
    <section
      className="teammate-danger-panel"
      data-protected={viewModel.protectedTeammate || undefined}
      data-ui2-teammate-danger="true"
      aria-label={t("Manage teammate")}
    >
      <header className="teammate-danger-heading">
        <span>
          <Trash2 aria-hidden="true" />
          <h2>{t("Manage teammate")}</h2>
        </span>
      </header>

      <div className="teammate-danger-actions">
          <article className="teammate-danger-action">
            <span className="teammate-danger-action-copy">
              <strong>{t("Disable teammate")}</strong>
              <small>{t("Soft disable hides the teammate from normal use but keeps durable data recoverable.")}</small>
            </span>
            {controller.disableError ? (
              <InlineFeedback className="teammate-danger-action-feedback" tone="danger" title={t("Disable teammate")}>
                {controller.disableError}
              </InlineFeedback>
            ) : null}
            <Button
              className="teammate-danger-action-button"
              leadingIcon={<ArchiveX aria-hidden="true" />}
              loading={controller.disableBusy}
              loadingLabel={t("Loading")}
              size="sm"
              variant="secondary"
              onClick={() => void controller.disable()}
            >
              {t("Disable")}
            </Button>
          </article>

          <article className="teammate-danger-action">
            <span className="teammate-danger-action-copy">
              <strong>{t("Hard delete private data")}</strong>
              <small>{t("Deletes private chat, private attachments, avatar, teammate memory, and private bindings. Channel and run history keep a deleted teammate reference.")}</small>
            </span>
            {controller.hardDeleteError && !controller.hardDeleteOpen ? (
              <InlineFeedback className="teammate-danger-action-feedback" tone="danger" title={t("Hard delete private data")}>
                {controller.hardDeleteError}
              </InlineFeedback>
            ) : null}
            <Button
              ref={controller.hardDeleteTriggerRef}
              className="teammate-danger-action-button"
              leadingIcon={<Trash2 aria-hidden="true" />}
              size="sm"
              variant="secondary"
              onClick={controller.requestHardDelete}
            >
              {t("Hard delete")}
            </Button>
          </article>
      </div>

      <TeammateHardDeleteDialog controller={controller} teammate={teammate} />
    </section>
  );
}
