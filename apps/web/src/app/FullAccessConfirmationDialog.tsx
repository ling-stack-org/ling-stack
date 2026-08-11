import { ShieldCheck } from "lucide-react";
import { useRef } from "react";
import { useI18n } from "../i18n.js";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
} from "../shared/ui/index.js";

export function FullAccessConfirmationDialog({
  onCancel,
  onConfirm,
  open,
  returnFocusTarget,
}: {
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  readonly open: boolean;
  readonly returnFocusTarget?: HTMLElement | null;
}): React.JSX.Element {
  const { t } = useI18n();
  const cancelButtonRef = useRef<HTMLButtonElement>(null);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onCancel();
      }}
    >
      <DialogContent
        className="full-access-confirmation-dialog"
        size="sm"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          cancelButtonRef.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreFocusWhenReady(returnFocusTarget);
        }}
      >
        <DialogHeader
          closeLabel={t("Cancel")}
          title={(
            <span className="full-access-confirmation-title">
              <ShieldCheck aria-hidden="true" size={18} />
              {t("Confirm full access")}
            </span>
          )}
        />
        <DialogBody className="full-access-confirmation-body">
          <p>{t("Full access can read and write outside the workspace and use network or tool actions allowed by this session.")}</p>
          <p>{t("This confirmation applies only to the current conversation. New conversations and permission changes require confirmation again.")}</p>
          <p>{t("Use it only for trusted workspaces. Denied tools in workspace policy still stay blocked.")}</p>
        </DialogBody>
        <DialogFooter>
          <Button ref={cancelButtonRef} onClick={onCancel}>{t("Cancel")}</Button>
          <Button variant="danger" onClick={onConfirm}>{t("Start with full access")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function restoreFocusWhenReady(target: HTMLElement | null | undefined, attempt = 0): void {
  if (!target?.isConnected) return;
  if (!target.matches(":disabled")) {
    target.focus();
    if (document.activeElement === target) return;
  }
  if (attempt >= 4) return;
  globalThis.requestAnimationFrame(() => restoreFocusWhenReady(target, attempt + 1));
}
