import type { RefObject } from "react";
import { FileCheck2, PencilLine } from "lucide-react";
import { useI18n } from "../../i18n.js";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Field,
  Input,
  InlineFeedback,
} from "../../shared/ui/index.js";

export function TeammateRenameDialog({
  currentName,
  error,
  returnFocusRef,
  saving,
  value,
  onClose,
  onSubmit,
  onValueChange,
}: {
  readonly currentName: string;
  readonly error?: string;
  readonly returnFocusRef: RefObject<HTMLElement | null>;
  readonly saving: boolean;
  readonly value: string;
  readonly onClose: () => void;
  readonly onSubmit: () => void;
  readonly onValueChange: (value: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const trimmedValue = value.trim();
  const submitDisabled = saving || !trimmedValue || trimmedValue === currentName;
  return (
    <Dialog
      busy={saving}
      dismissible
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        aria-label={t("Rename teammate")}
        aria-labelledby={undefined}
        className="teammate-rename-dialog"
        size="sm"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocusRef.current?.focus({ preventScroll: true });
        }}
      >
        <form
          className="teammate-rename-form"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <DialogHeader
            closeLabel={t("Cancel")}
            title={(
              <span className="teammate-rename-title">
                <PencilLine size={16} />
                <strong>{t("Rename teammate")}</strong>
              </span>
            )}
          />
          <DialogBody className="teammate-rename-body">
            <Field label={t("Teammate name")}>
              <Input
                aria-label={t("Teammate name")}
                autoFocus
                disabled={saving}
                value={value}
                onChange={(event) => onValueChange(event.target.value)}
              />
            </Field>
            {error ? <InlineFeedback role="alert" tone="danger">{error}</InlineFeedback> : null}
          </DialogBody>
          <DialogFooter>
            <Button type="button" disabled={saving} size="sm" onClick={onClose}>
              {t("Cancel")}
            </Button>
            <Button
              type="submit"
              disabled={submitDisabled}
              leadingIcon={<FileCheck2 size={14} />}
              loading={saving}
              loadingLabel={t("Confirm")}
              size="sm"
              variant="primary"
            >
              {t("Confirm")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
