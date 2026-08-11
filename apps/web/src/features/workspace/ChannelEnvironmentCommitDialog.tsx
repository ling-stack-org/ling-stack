import { SquareTerminal } from "lucide-react";
import { useI18n } from "../../i18n.js";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Field,
  InlineFeedback,
  Switch,
  Textarea,
} from "../../shared/ui/index.js";

export function ChannelEnvironmentCommitDialog({
  message,
  includeUnstaged,
  disabledReason,
  onMessageChange,
  onIncludeUnstagedChange,
  onClose,
}: {
  readonly message: string;
  readonly includeUnstaged: boolean;
  readonly disabledReason: string;
  readonly onMessageChange: (message: string) => void;
  readonly onIncludeUnstagedChange: (include: boolean) => void;
  readonly onClose: () => void;
}): React.JSX.Element {
  const { t } = useI18n();

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="channel-environment-commit-dialog" size="sm">
        <DialogHeader
          title={t("Commit or push")}
          description={t("Read-only shell")}
          closeLabel={t("Close")}
        />
        <DialogBody className="channel-environment-commit-body">
          <InlineFeedback tone="warning" title={t("Commit shell is disabled")}>
            {disabledReason}
          </InlineFeedback>
          <Field label={t("Commit message")}>
            <Textarea
              className="environment-commit-message"
              value={message}
              rows={4}
              onChange={(event) => onMessageChange(event.target.value)}
              placeholder={t("Describe the change")}
            />
          </Field>
          <div className="channel-environment-switch-row">
            <span>
              <strong>{t("Include unstaged changes")}</strong>
              <small>{t("This option will apply when commit actions become available.")}</small>
            </span>
            <Switch
              checked={includeUnstaged}
              onCheckedChange={onIncludeUnstagedChange}
              aria-label={t("Include unstaged changes")}
            />
          </div>
        </DialogBody>
        <DialogFooter>
          <Button size="sm" variant="secondary" leadingIcon={<SquareTerminal size={14} />} disabled title={disabledReason}>
            {t("Commit")}
          </Button>
          <Button size="sm" variant="secondary" disabled title={disabledReason}>{t("Commit and push")}</Button>
          <Button size="sm" variant="secondary" disabled title={disabledReason}>{t("Push")}</Button>
          <Button autoFocus size="sm" variant="ghost" onClick={onClose}>{t("Cancel")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
