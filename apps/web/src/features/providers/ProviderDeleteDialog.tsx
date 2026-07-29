import { Trash2 } from "lucide-react";
import { useI18n } from "../../i18n.js";
import type { ProviderPreset } from "../../types.js";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  InlineFeedback,
} from "../../shared/ui/index.js";

export function ProviderDeleteDialog({
  busy,
  errorMessage,
  target,
  onCancel,
  onConfirm,
}: {
  readonly busy: boolean;
  readonly errorMessage: string;
  readonly target: ProviderPreset | undefined;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}): JSX.Element | null {
  const { t } = useI18n();
  if (!target) return null;
  const name = target.model.trim() || target.displayName.trim();

  return (
    <Dialog busy={busy} dismissible open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent className="provider-delete-dialog" size="sm" aria-label={`${t("Delete")} ${name}`}>
        <DialogHeader title={`${t("Delete")} ${name}`} closeLabel={t("Close")} />
        <DialogBody>
          <p>{t("This cannot be undone")}</p>
          {errorMessage ? (
            <InlineFeedback tone="danger" title={t("Error")}>
              {errorMessage}
            </InlineFeedback>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button disabled={busy} onClick={onCancel}>{t("Cancel")}</Button>
          <Button
            loading={busy}
            loadingLabel={t("Loading")}
            leadingIcon={<Trash2 />}
            variant="danger"
            onClick={onConfirm}
          >
            {t("Delete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
