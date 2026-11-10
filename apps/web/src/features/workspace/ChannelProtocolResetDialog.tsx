import { RotateCcw } from "lucide-react";
import { useRef, type RefObject } from "react";
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

export function ChannelProtocolResetDialog({
  busy,
  error,
  open,
  returnFocusRef,
  onConfirm,
  onOpenChange,
}: {
  readonly busy: boolean;
  readonly error: string;
  readonly open: boolean;
  readonly returnFocusRef: RefObject<HTMLButtonElement | null>;
  readonly onConfirm: () => void;
  readonly onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  return (
    <Dialog busy={busy} open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-ui2-channel-protocol-reset-dialog=""
        size="sm"
        onKeyDown={(event) => {
          // Radix installs its document-level Escape listener in an effect. The
          // dialog can receive focus before that listener is attached, so keep
          // the focused surface able to dismiss itself in that short window.
          if (event.key === "Escape" && !busy && !event.defaultPrevented) {
            event.preventDefault();
            onOpenChange(false);
          }
        }}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          cancelRef.current?.focus({ preventScroll: true });
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const target = returnFocusRef.current;
          if (target?.isConnected) target.focus({ preventScroll: true });
        }}
        onEscapeKeyDown={(event) => {
          if (!busy) onOpenChange(false);
          event.stopPropagation();
        }}
      >
        <DialogHeader closeLabel={t("Close")} title={t("Reset channel protocol?")} />
        {error ? (
          <DialogBody>
            <InlineFeedback role="alert" tone="danger">{error}</InlineFeedback>
          </DialogBody>
        ) : null}
        <DialogFooter>
          <Button ref={cancelRef} disabled={busy} size="sm" variant="secondary" onClick={() => onOpenChange(false)}>
            {t("Cancel")}
          </Button>
          <Button
            leadingIcon={<RotateCcw aria-hidden="true" size={14} />}
            loading={busy}
            loadingLabel={t("Loading")}
            size="sm"
            variant="danger"
            onClick={onConfirm}
          >
            {t("Reset")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
