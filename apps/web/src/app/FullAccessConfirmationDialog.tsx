import { FolderOpen, Globe2, ShieldAlert, ShieldCheck, SquareTerminal } from "lucide-react";
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
          <p className="full-access-confirmation-intro">{t("Full access lets Ling act without asking for routine local approvals in this conversation.")}</p>
          <ul className="full-access-confirmation-capabilities">
            <li>
              <FolderOpen aria-hidden="true" size={18} />
              <span><strong>{t("Files and folders")}</strong><small>{t("Read, modify, create, and delete files inside or outside the current workspace.")}</small></span>
            </li>
            <li>
              <SquareTerminal aria-hidden="true" size={18} />
              <span><strong>{t("Terminal commands")}</strong><small>{t("Run local commands without asking for each routine operation.")}</small></span>
            </li>
            <li>
              <Globe2 aria-hidden="true" size={18} />
              <span><strong>{t("Internet and connected apps")}</strong><small>{t("Use allowed network services and connected tools when the task needs them.")}</small></span>
            </li>
          </ul>
          <div className="full-access-confirmation-warning">
            <ShieldAlert aria-hidden="true" size={18} />
            <p>{t("Only enable this for work you trust. Files, websites, or tool output can contain instructions that try to misuse these permissions.")}</p>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button ref={cancelButtonRef} onClick={onCancel}>{t("Cancel")}</Button>
          <Button variant="danger" onClick={onConfirm}>{t("Enable full access")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function restoreFocusWhenReady(target: HTMLElement | null | undefined, attempt = 0): void {
  const focusTarget = resolveFullAccessReturnFocusTarget(target);
  if (!focusTarget?.isConnected) return;
  if (!focusTarget.matches(":disabled")) {
    focusTarget.focus();
    if (document.activeElement === focusTarget) return;
  }
  if (attempt >= 4) return;
  globalThis.requestAnimationFrame(() => restoreFocusWhenReady(target, attempt + 1));
}

function resolveFullAccessReturnFocusTarget(target: HTMLElement | null | undefined): HTMLElement | null | undefined {
  if (!target?.matches(".ling-ui-segmented-control-item[data-state='off']")) return target;
  return target.closest(".ling-ui-segmented-control")
    ?.querySelector<HTMLElement>(".ling-ui-segmented-control-item[data-state='on']")
    ?? target;
}
