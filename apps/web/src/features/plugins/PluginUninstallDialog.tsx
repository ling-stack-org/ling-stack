import { useEffect, useRef, useState } from "react";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  InlineFeedback,
} from "../../shared/ui/index.js";
import { useI18n } from "../../i18n.js";
import type { ManagedPluginView } from "../../types.js";
import type { PluginManagerCopy } from "./plugin-manager-copy.js";
import type { PluginActionFailure } from "./plugin-manager-types.js";

export function PluginUninstallDialog({
  plugin,
  busy,
  actionFailure,
  copy,
  onCancel,
  onComplete,
  onUninstall,
}: {
  readonly plugin?: ManagedPluginView;
  readonly busy: boolean;
  readonly actionFailure?: PluginActionFailure;
  readonly copy: PluginManagerCopy;
  readonly onCancel: () => void;
  readonly onComplete: () => void;
  readonly onUninstall: (pluginId: string) => void;
}): JSX.Element {
  const { t } = useI18n();
  const [submitted, setSubmitted] = useState(false);
  const [sawBusy, setSawBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const cancelRef = useRef<HTMLButtonElement>(null);
  const open = Boolean(plugin);

  useEffect(() => {
    if (!open) {
      setSubmitted(false);
      setSawBusy(false);
      setFailure("");
      return;
    }
    if (submitted && busy) setSawBusy(true);
    if (!submitted || !sawBusy || busy || !plugin) return;
    if (plugin.package?.status === "uninstalled" || !plugin.actions.canUninstall) onComplete();
    else if (!actionFailure) setFailure(t("Unknown error"));
  }, [actionFailure, busy, onComplete, open, plugin, sawBusy, submitted, t]);

  return (
    <Dialog busy={busy} onOpenChange={(nextOpen) => { if (!nextOpen) onCancel(); }} open={open}>
      <DialogContent
        className="plugin-uninstall-dialog"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          cancelRef.current?.focus();
        }}
        size="sm"
      >
        <DialogHeader closeLabel={t("Close")} title={plugin ? copy.uninstallTitle(plugin.displayName) : t("Uninstall")} />
        <DialogBody className="plugin-uninstall-body">
          <p>{copy.uninstallConsequence}</p>
          <p>{copy.uninstallRetained}</p>
          {actionFailure || failure ? (
            <InlineFeedback
              data-plugin-action-failure={actionFailure?.action}
              title={actionFailure?.message}
              tone="danger"
            >
              {actionFailure?.detail ?? failure}
            </InlineFeedback>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button ref={cancelRef} disabled={busy} onClick={onCancel}>{t("Cancel")}</Button>
          <Button
            loading={busy}
            loadingLabel={t("Loading")}
            onClick={() => {
              if (!plugin) return;
              setSubmitted(true);
              setFailure("");
              onUninstall(plugin.id);
            }}
            variant="danger"
          >
            {t("Uninstall")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
