import { Trash2 } from "lucide-react";
import { useRef, type RefObject } from "react";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  InlineFeedback,
} from "../../../shared/ui/index.js";
import { useI18n } from "../../../i18n.js";
import type { ThemeDeleteDialogState } from "./useThemePackageController.js";
import { themePackageIssueLabel } from "./theme-package-view-models.js";

export function ThemeDeleteDialog({
  fallbackFocusRef,
  returnFocusRef,
  state,
  onClose,
  onConfirm,
}: {
  readonly fallbackFocusRef: RefObject<HTMLButtonElement | null>;
  readonly returnFocusRef: RefObject<HTMLButtonElement | null>;
  readonly state: ThemeDeleteDialogState;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  return (
    <Dialog busy={state.busy} open={Boolean(state.target)} onOpenChange={(open) => {
      if (!open) onClose();
    }}>
      <DialogContent
        data-ui2-theme-delete-dialog=""
        size="sm"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          cancelRef.current?.focus({ preventScroll: true });
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (returnFocusRef.current?.isConnected) {
            returnFocusRef.current.focus({ preventScroll: true });
          } else {
            fallbackFocusRef.current?.focus({ preventScroll: true });
          }
        }}
      >
        <DialogHeader
          closeLabel={t("Close")}
          description={t("The theme and its local preview will be permanently removed. If it is active, Ling switches to the matching built-in theme first.")}
          title={state.target ? t("Delete theme {name}?", { name: state.target.name }) : t("Delete theme")}
        />
        <DialogBody>
          {state.error ? (
            <InlineFeedback tone="danger">{themePackageIssueLabel(state.error, t)}</InlineFeedback>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button ref={cancelRef} disabled={state.busy} size="sm" variant="secondary" onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button
            leadingIcon={<Trash2 aria-hidden="true" />}
            loading={state.busy}
            loadingLabel={t("Deleting theme...")}
            size="sm"
            variant="danger"
            onClick={onConfirm}
          >
            {t("Delete theme")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
