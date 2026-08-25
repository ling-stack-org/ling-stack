import { Check, Copy, ExternalLink, Globe2, RefreshCw, Unplug } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ChromeBrowserPairingStartResponse, ManagedPluginView } from "../../types.js";
import { useI18n } from "../../i18n.js";
import {
  Button,
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  IconButton,
  InlineFeedback,
  useLingToast,
} from "../../shared/ui/index.js";
import type { PluginActionFailure } from "./plugin-manager-types.js";

export function ChromeBrowserConnectDrawer({
  actionFailure,
  busy,
  onClose,
  onRefresh,
  onRevoke,
  onStartPairing,
  open,
  plugin,
}: {
  readonly actionFailure?: PluginActionFailure;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onRefresh: () => void;
  readonly onRevoke: (pluginId: string) => Promise<void>;
  readonly onStartPairing: (pluginId: string) => Promise<ChromeBrowserPairingStartResponse | undefined>;
  readonly open: boolean;
  readonly plugin?: ManagedPluginView;
}): React.JSX.Element {
  const { t } = useI18n();
  const { showToast } = useLingToast();
  const [pairing, setPairing] = useState<ChromeBrowserPairingStartResponse>();
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const drawerRef = useRef<HTMLDivElement>(null);
  const connected = plugin?.setup?.connected === true;
  const paired = plugin?.setup?.paired === true;

  useEffect(() => {
    setPairing(undefined);
    setCopyState("idle");
    if (!open || !plugin || connected) return;
    void onStartPairing(plugin.id).then(setPairing);
  }, [open, plugin?.id]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(onRefresh, 1_000);
    return () => window.clearInterval(timer);
  }, [onRefresh, open]);

  async function copyPairingCode(): Promise<void> {
    if (!pairing) return;
    try {
      await navigator.clipboard.writeText(pairing.pairingCode);
      setCopyState("copied");
      showToast({ message: t("Pairing code copied"), scope: "plugin:chrome:pairing-copy", tone: "success" });
    } catch {
      setCopyState("failed");
    }
  }

  async function renewPairing(): Promise<void> {
    if (!plugin) return;
    const next = await onStartPairing(plugin.id);
    setPairing(next);
    setCopyState("idle");
  }

  return (
    <Drawer busy={busy} onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }} open={Boolean(open && plugin)}>
      <DrawerContent
        ref={drawerRef}
        className="chrome-connect-panel"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          drawerRef.current?.focus();
        }}
        size="md"
      >
        {plugin ? (
          <>
            <DrawerHeader
              closeLabel={t("Close")}
              description={connected ? t("Chrome is connected to this Ling workspace.") : t("Install or open the Ling extension, then enter this pairing code.")}
              title={t("Connect Chrome")}
            />
            <DrawerBody className="chrome-connect-body">
              {actionFailure ? (
                <InlineFeedback title={actionFailure.message} tone="danger">{actionFailure.detail}</InlineFeedback>
              ) : null}
              {connected ? (
                <InlineFeedback tone="success">
                  {t("Chrome is ready")}
                </InlineFeedback>
              ) : (
                <>
                  {plugin.setup?.storeUrl ? (
                    <Button asChild leadingIcon={<ExternalLink aria-hidden="true" />} size="sm">
                      <a href={plugin.setup.storeUrl} rel="noreferrer" target="_blank">{t("Open Chrome Web Store")}</a>
                    </Button>
                  ) : (
                    <InlineFeedback tone="neutral">
                      <Globe2 aria-hidden="true" size={15} />
                      {t("Chrome Web Store release is pending for this build.")}
                    </InlineFeedback>
                  )}
                  <section className="chrome-pairing-code" aria-label={t("Pairing code")}>
                    <span>
                      <small>{t("Pairing code")}</small>
                      <code>{pairing?.pairingCode ?? t("Generating code...")}</code>
                    </span>
                    <IconButton
                      icon={copyState === "copied" ? Check : Copy}
                      label={t("Copy pairing code")}
                      disabled={!pairing}
                      onClick={() => void copyPairingCode()}
                      size="sm"
                    />
                  </section>
                  {copyState === "failed" ? <InlineFeedback tone="danger">{t("Copy failed")}</InlineFeedback> : null}
                  <p className="chrome-pairing-expiry">
                    {pairing ? t("Code expires at {time}", { time: new Date(pairing.expiresAt).toLocaleTimeString() }) : ""}
                  </p>
                </>
              )}
              <InlineFeedback role="note" tone="neutral">
                {t("When connected, Ling may read HTTP(S) page URLs, visible text, interactive labels, and visible screenshots only for browser tasks you approve. It does not read Chrome passwords, cookies, history, or bookmarks.")}
              </InlineFeedback>
            </DrawerBody>
            <DrawerFooter>
              {paired ? (
                <Button
                  disabled={busy}
                  leadingIcon={<Unplug aria-hidden="true" />}
                  onClick={() => void onRevoke(plugin.id)}
                  variant="danger"
                >
                  {t("Remove Chrome access")}
                </Button>
              ) : null}
              <Button disabled={busy} onClick={onClose}>{t("Close")}</Button>
              {!connected ? (
                <Button
                  leadingIcon={<RefreshCw aria-hidden="true" />}
                  loading={busy}
                  loadingLabel={t("Loading")}
                  onClick={() => void renewPairing()}
                  variant="primary"
                >
                  {t("Generate new code")}
                </Button>
              ) : null}
            </DrawerFooter>
          </>
        ) : null}
      </DrawerContent>
    </Drawer>
  );
}
