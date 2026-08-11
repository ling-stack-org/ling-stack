import { useI18n } from "../../../i18n.js";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
} from "../../../shared/ui/index.js";

export function ThemeStudioLeaveDialog({ open, onCancel, onDiscard }: {
  readonly open: boolean;
  readonly onCancel: () => void;
  readonly onDiscard: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onCancel(); }}>
      <DialogContent size="sm">
        <DialogHeader closeLabel={t("Close")} title={t("Leave theme editor?")} />
        <DialogBody>
          <p>{t("Your local draft is saved. You can continue editing it later.")}</p>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>{t("Continue editing")}</Button>
          <Button variant="primary" onClick={onDiscard}>{t("Back to themes")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
