import type { FormEvent, RefObject } from "react";
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

export function ChannelRenameDialog({
  value,
  currentName,
  saving,
  error,
  onValueChange,
  onSubmit,
  onClose,
  returnFocusRef,
}: {
  readonly value: string;
  readonly currentName: string;
  readonly saving: boolean;
  readonly error?: string;
  readonly onValueChange: (value: string) => void;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  readonly onClose: () => void;
  readonly returnFocusRef: RefObject<HTMLElement | null>;
}): JSX.Element {
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
        aria-label={t("Rename channel")}
        aria-labelledby={undefined}
        className="channel-rename-dialog"
        size="sm"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocusRef.current?.focus({ preventScroll: true });
        }}
      >
        <form className="channel-rename-form" onSubmit={onSubmit}>
          <DialogHeader
            closeLabel={t("Cancel")}
            title={(
              <span className="channel-rename-title">
                <PencilLine size={16} />
                <strong>{t("Rename channel")}</strong>
              </span>
            )}
          />
          <DialogBody className="channel-rename-body">
            <Field label={t("Channel name")}>
              <Input
                aria-label={t("Channel name")}
                value={value}
                onChange={(event) => onValueChange(event.target.value)}
                autoFocus
                disabled={saving}
              />
            </Field>
            {error ? (
              <InlineFeedback tone="danger" role="alert">
                {error}
              </InlineFeedback>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button type="button" onClick={onClose} disabled={saving} size="sm">
              {t("Cancel")}
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              leadingIcon={<FileCheck2 size={14} />}
              loading={saving}
              loadingLabel={t("Confirm")}
              disabled={submitDisabled}
            >
              {t("Confirm")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
