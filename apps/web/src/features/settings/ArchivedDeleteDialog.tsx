import { Trash2 } from "lucide-react";
import { useRef, type RefObject } from "react";
import { useI18n } from "../../i18n.js";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
} from "../../shared/ui/index.js";
import { ArchivedErrorFeedback } from "./ArchivedErrorFeedback.js";
import type { ArchivedSettingsActionError } from "./useArchivedSettingsController.js";
import type { ArchivedDeleteTarget } from "./archived-items-view-models.js";

export function ArchivedDeleteDialog({
  busy,
  error,
  fallbackFocusRef,
  returnFocusRef,
  target,
  onClose,
  onConfirm,
}: {
  readonly busy: boolean;
  readonly error?: ArchivedSettingsActionError;
  readonly fallbackFocusRef: RefObject<HTMLInputElement | null>;
  readonly returnFocusRef: RefObject<HTMLButtonElement | null>;
  readonly target?: ArchivedDeleteTarget;
  readonly onClose: () => void;
  readonly onConfirm: () => Promise<boolean>;
}): JSX.Element {
  const { t } = useI18n();
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const displayName = target?.displayName || (target?.displayNameFallbackKey ? t(target.displayNameFallbackKey) : "");

  const confirm = async (): Promise<void> => {
    await onConfirm();
  };

  return (
    <Dialog
      busy={busy}
      open={Boolean(target)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="archived-delete-dialog"
        data-ui2-archived-delete-dialog=""
        size="sm"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          cancelRef.current?.focus({ preventScroll: true });
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const returnTarget = returnFocusRef.current;
          if (returnTarget?.isConnected) {
            returnTarget.focus({ preventScroll: true });
            return;
          }
          fallbackFocusRef.current?.focus({ preventScroll: true });
        }}
      >
        <DialogHeader
          closeLabel={t("Close")}
          title={target ? deleteTitle(target, displayName, t) : t("Delete archived item")}
          description={target ? deleteDescription(target, t) : undefined}
        />
        <DialogBody className="archived-delete-dialog-body">
          {error ? <ArchivedErrorFeedback feedback={error} /> : null}
        </DialogBody>
        <DialogFooter>
          <Button ref={cancelRef} disabled={busy} size="sm" variant="secondary" onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button
            leadingIcon={<Trash2 aria-hidden="true" />}
            loading={busy}
            loadingLabel={t("Deleting...")}
            size="sm"
            variant="danger"
            onClick={() => void confirm()}
          >
            {target ? deleteActionLabel(target, t) : t("Delete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type Translator = (key: string, values?: Readonly<Record<string, string | number>>) => string;

function deleteTitle(target: ArchivedDeleteTarget, displayName: string, t: Translator): string {
  switch (target.kind) {
    case "conversation": return t("Delete conversation {title}?", { title: displayName });
    case "teammate": return t("Delete AI teammate {name}?", { name: displayName });
    case "channel": return t("Delete channel {name}?", { name: displayName });
    case "branch": return t("Delete branch {name}?", { name: displayName });
  }
}

function deleteDescription(target: ArchivedDeleteTarget, t: Translator): string {
  switch (target.kind) {
    case "conversation":
      return t("This permanently deletes messages, attachments, goals, and plans. Historical runs remain but will no longer be linked to this conversation.");
    case "teammate":
      return t("This permanently deletes private chat, attachments, avatar, memory, and private bindings. Channel and run history keep a deleted teammate reference.");
    case "channel":
    case "branch":
      return t("This cannot be undone");
  }
}

function deleteActionLabel(target: ArchivedDeleteTarget, t: Translator): string {
  switch (target.kind) {
    case "conversation": return t("Delete conversation");
    case "teammate": return t("Delete AI teammate");
    case "channel": return t("Delete channel");
    case "branch": return t("Delete branch");
  }
}
