import { Trash2 } from "lucide-react";
import { useI18n } from "../../i18n.js";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  InlineFeedback,
} from "../../shared/ui/index.js";
import type { CouncilMemberRowView } from "./council-members-view-model.js";

export function CouncilMemberRemoveDialog({
  busy,
  error,
  lastEnabled,
  onConfirm,
  onOpenChange,
  onRestoreFocus,
  target,
}: {
  readonly busy: boolean;
  readonly error: string;
  readonly lastEnabled: boolean;
  readonly onConfirm: () => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly onRestoreFocus: () => void;
  readonly target?: CouncilMemberRowView;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <Dialog busy={busy} open={Boolean(target)} onOpenChange={onOpenChange}>
      <DialogContent
        aria-label={t("Remove council member")}
        className="council-members-remove-dialog"
        size="sm"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onRestoreFocus();
        }}
      >
        <DialogHeader
          closeLabel={t("Close")}
          title={t("Remove council member")}
          description={target?.displayName}
        />
        <DialogBody className="council-members-remove-body">
          <p>{t("Removing this member stops their participation through this council in every attached channel.")}</p>
          <p>{t("The AI teammate stays available and direct channel memberships stay unchanged.")}</p>
          {lastEnabled ? (
            <InlineFeedback tone="warning" title={t("Readiness warning")}>
              {t("This council will have no enabled members.")}
            </InlineFeedback>
          ) : null}
          {error ? <InlineFeedback tone="danger" title={t("Remove council member")}>{error}</InlineFeedback> : null}
        </DialogBody>
        <DialogFooter>
          <Button disabled={busy} onClick={() => onOpenChange(false)}>{t("Cancel")}</Button>
          <Button
            leadingIcon={<Trash2 />}
            loading={busy}
            loadingLabel={t("Saving...")}
            onClick={onConfirm}
            variant="danger"
          >
            {t("Remove")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
