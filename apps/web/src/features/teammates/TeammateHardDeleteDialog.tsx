import { Trash2 } from "lucide-react";
import { useRef } from "react";
import { useI18n } from "../../i18n.js";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Field,
  InlineFeedback,
  Input,
} from "../../shared/ui/index.js";
import type { AiTeammate } from "../../types.js";
import type { TeammateDangerController } from "./useTeammateDangerController.js";

export function TeammateHardDeleteDialog({
  controller,
  teammate,
}: {
  readonly controller: TeammateDangerController;
  readonly teammate: AiTeammate;
}): React.JSX.Element {
  const { t } = useI18n();
  const cancelRef = useRef<HTMLButtonElement>(null);

  return (
    <Dialog
      busy={controller.hardDeleteBusy}
      open={controller.hardDeleteOpen}
      onOpenChange={controller.setHardDeleteDialogOpen}
    >
      <DialogContent
        className="teammate-danger-delete-dialog"
        data-ui2-teammate-danger-dialog="true"
        size="sm"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          cancelRef.current?.focus({ preventScroll: true });
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          controller.restoreHardDeleteFocus();
        }}
      >
        <DialogHeader
          closeLabel={t("Close")}
          title={t("Hard delete private data")}
          description={teammate.displayName}
        />
        <DialogBody className="teammate-danger-delete-body">
          <p>
            {t("Deletes private chat, private attachments, avatar, teammate memory, and private bindings. Channel and run history keep a deleted teammate reference.")}
          </p>
          <InlineFeedback tone="warning">{t("This cannot be undone")}</InlineFeedback>
          <Field label={t("Reason")}>
            <Input
              autoComplete="off"
              value={controller.hardDeleteReason}
              onChange={(event) => controller.setHardDeleteReason(event.currentTarget.value)}
            />
          </Field>
          {controller.hardDeleteError ? (
            <InlineFeedback tone="danger" title={t("Hard delete private data")}>
              {controller.hardDeleteError}
            </InlineFeedback>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button
            ref={cancelRef}
            disabled={controller.hardDeleteBusy}
            size="sm"
            variant="secondary"
            onClick={() => controller.setHardDeleteDialogOpen(false)}
          >
            {t("Cancel")}
          </Button>
          <Button
            leadingIcon={<Trash2 aria-hidden="true" />}
            loading={controller.hardDeleteBusy}
            loadingLabel={t("Deleting...")}
            size="sm"
            variant="danger"
            onClick={() => void controller.confirmHardDelete()}
          >
            {t("Hard delete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
