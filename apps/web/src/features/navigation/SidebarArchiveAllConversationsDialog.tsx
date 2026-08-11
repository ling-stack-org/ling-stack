import { Archive } from "lucide-react";
import { useRef, useState, type RefObject } from "react";
import { useI18n } from "../../i18n.js";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
} from "../../shared/ui/index.js";

export function SidebarArchiveAllConversationsDialog({
  open,
  returnFocusRef,
  onConfirm,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly returnFocusRef: RefObject<HTMLButtonElement | null>;
  readonly onConfirm: () => void | Promise<void>;
  readonly onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const [busy, setBusy] = useState(false);

  const confirm = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      busy={busy}
      open={open}
      onOpenChange={(nextOpen) => {
        if (!busy) onOpenChange(nextOpen);
      }}
    >
      <DialogContent
        data-ui2-sidebar-archive-all-dialog=""
        size="sm"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          cancelRef.current?.focus({ preventScroll: true });
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocusRef.current?.focus({ preventScroll: true });
        }}
      >
        <DialogHeader
          closeLabel={t("Close")}
          description={t("Archive all conversations? You can restore archived conversations from Settings.")}
          title={t("Archive all conversations")}
        />
        <DialogFooter>
          <Button ref={cancelRef} disabled={busy} size="sm" variant="secondary" onClick={() => onOpenChange(false)}>
            {t("Cancel")}
          </Button>
          <Button
            leadingIcon={<Archive aria-hidden="true" />}
            loading={busy}
            loadingLabel={t("Archiving...")}
            size="sm"
            variant="danger"
            onClick={() => void confirm()}
          >
            {t("Archive all conversations")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
