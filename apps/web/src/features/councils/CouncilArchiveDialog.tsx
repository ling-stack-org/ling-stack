import { Archive } from "lucide-react";
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
  StatusIndicator,
} from "../../shared/ui/index.js";
import type { CouncilSettingsArchiveController } from "./useCouncilSettingsArchiveController.js";

export function CouncilArchiveDialog({
  controller,
}: {
  readonly controller: CouncilSettingsArchiveController;
}): React.JSX.Element {
  const { t } = useI18n();
  const cancelRef = useRef<HTMLButtonElement>(null);

  return (
    <Dialog
      busy={controller.archiveBusy}
      open={controller.archiveOpen}
      onOpenChange={controller.setArchiveDialogOpen}
    >
      <DialogContent
        className="council-settings-archive-dialog"
        data-ui2-council-archive-dialog="true"
        size="sm"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          cancelRef.current?.focus({ preventScroll: true });
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          controller.restoreArchiveFocus();
        }}
      >
        <DialogHeader
          closeLabel={t("Close")}
          title={t("Archive council")}
          description={controller.authority.displayName}
        />
        <DialogBody className="council-settings-archive-dialog-body">
          <div className="council-settings-archive-confirmation">
            <Archive aria-hidden="true" />
            <span>
              <strong>{t("Archive council")}</strong>
              <small>{controller.authority.displayName}</small>
            </span>
            <StatusIndicator label={t("Archived")} tone="neutral" />
          </div>
          {controller.archiveError ? (
            <InlineFeedback tone="danger" title={t("Archive council")}>
              {controller.archiveError}
            </InlineFeedback>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button
            ref={cancelRef}
            disabled={controller.archiveBusy}
            size="sm"
            variant="secondary"
            onClick={() => controller.setArchiveDialogOpen(false)}
          >
            {t("Cancel")}
          </Button>
          <Button
            leadingIcon={<Archive aria-hidden="true" />}
            loading={controller.archiveBusy}
            loadingLabel={t("Archiving council...")}
            size="sm"
            variant="danger"
            onClick={() => void controller.confirmArchive()}
          >
            {t("Archive council")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
