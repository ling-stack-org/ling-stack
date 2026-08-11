import { useRef, type MutableRefObject } from "react";
import { Trash2 } from "lucide-react";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  InlineFeedback,
} from "../../shared/ui/index.js";
import type { SkillRegistryEntry } from "../../types.js";
import type { SettingsTranslator } from "./skill-library-utils.js";

export function SkillDeleteDialog({
  target,
  busy,
  error,
  returnFocusRef,
  onClose,
  onConfirm,
  t,
}: {
  readonly target: SkillRegistryEntry | undefined;
  readonly busy: boolean;
  readonly error: string;
  readonly returnFocusRef: MutableRefObject<HTMLButtonElement | null>;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
  readonly t: SettingsTranslator;
}): React.JSX.Element {
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      open={Boolean(target)}
      busy={busy}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="settings-skill-delete-dialog"
        data-ui2-skill-delete-dialog=""
        size="sm"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          cancelRef.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const returnFocusTarget = returnFocusRef.current;
          if (returnFocusTarget?.isConnected) returnFocusTarget.focus({ preventScroll: true });
        }}
      >
        <DialogHeader
          title={target ? t("Delete skill {name}?", { name: target.definition.name }) : t("Delete skill")}
          description={t("This cannot be undone. Remove teammate bindings and active work references before deleting this skill.")}
        />
        <DialogBody>
          {error ? <InlineFeedback tone="danger">{error}</InlineFeedback> : null}
        </DialogBody>
        <DialogFooter>
          <Button ref={cancelRef} size="sm" variant="secondary" disabled={busy} onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button
            size="sm"
            variant="danger"
            leadingIcon={<Trash2 size={14} />}
            loading={busy}
            loadingLabel={t("Deleting...")}
            onClick={onConfirm}
          >
            {t("Delete skill")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
