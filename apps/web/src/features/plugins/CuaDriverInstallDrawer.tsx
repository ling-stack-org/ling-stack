import { Check, Copy, ExternalLink, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  Button,
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  Field,
  IconButton,
  InlineFeedback,
  Input,
  InspectorSection,
  useLingToast,
} from "../../shared/ui/index.js";
import { useI18n } from "../../i18n.js";
import type { ManagedPluginView } from "../../types.js";

export function CuaDriverInstallDrawer({
  open,
  plugin,
  busy,
  onConnect,
  onClose,
}: {
  readonly open: boolean;
  readonly plugin?: ManagedPluginView;
  readonly busy: boolean;
  readonly onConnect: (pluginId: string, command?: string) => Promise<ManagedPluginView | undefined>;
  readonly onClose: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const { showToast } = useLingToast();
  const [customCommand, setCustomCommand] = useState("");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [validationMessage, setValidationMessage] = useState("");
  const drawerRef = useRef<HTMLDivElement>(null);
  const guide = plugin?.setup?.guide;
  const available = Boolean(open && plugin && plugin.setup?.state === "missing" && guide);

  useEffect(() => {
    setCustomCommand("");
    setCopyState("idle");
    setValidationMessage("");
  }, [guide?.installCommand, open, plugin?.id]);

  useEffect(() => {
    if (open && plugin && plugin.setup?.state !== "missing") onClose();
  }, [onClose, open, plugin]);

  async function copyInstallCommand(): Promise<void> {
    if (!guide) return;
    try {
      await copyText(guide.installCommand);
      setCopyState("copied");
      showToast({ message: t("Command copied"), scope: `plugin:cua:${plugin?.id ?? "unknown"}:copy`, tone: "success" });
    } catch {
      setCopyState("failed");
    }
  }

  async function recheck(): Promise<void> {
    if (!plugin) return;
    const command = customCommand.trim();
    if (command && !command.startsWith("/")) {
      setValidationMessage(t("Enter an absolute executable path."));
      return;
    }
    setValidationMessage("");
    const connected = await onConnect(plugin.id, command || undefined);
    if (connected?.setup?.state === "connected" || connected?.setup?.state === "ready") onClose();
    else setValidationMessage(t("Unknown error"));
  }

  const CopyStateIcon = copyState === "copied" ? Check : Copy;

  return (
    <Drawer busy={busy} onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }} open={available}>
      <DrawerContent
        ref={drawerRef}
        className="cua-install-panel"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          drawerRef.current?.focus();
        }}
        size="lg"
      >
        {plugin && guide ? (
          <>
            <DrawerHeader
              closeLabel={t("Close")}
              description={t("Ling did not detect Cua Driver on this Mac.")}
              title={t("Install Cua Driver")}
            />
            <DrawerBody className="cua-install-body">
              <section className="cua-install-section">
                <div className="cua-install-section-head">
                  <span>
                    <strong>{t("Official installation")}</strong>
                    <small>{t("Review the official guide, then run the command yourself in Terminal.")}</small>
                  </span>
                  <Button asChild leadingIcon={<ExternalLink aria-hidden="true" />} size="sm">
                    <a href={guide.documentationUrl} rel="noreferrer" target="_blank">{t("Open official guide")}</a>
                  </Button>
                </div>
                <div className="cua-install-command">
                  <code>{guide.installCommand}</code>
                  <IconButton
                    data-cua-copy-state={copyState}
                    icon={CopyStateIcon}
                    label={t("Copy install command")}
                    onClick={() => void copyInstallCommand()}
                    size="sm"
                  />
                </div>
                {copyState === "failed" ? (
                  <InlineFeedback data-cua-copy-feedback="failure" tone="danger">
                    {t("Copy failed")}
                  </InlineFeedback>
                ) : null}
              </section>
              {guide.supportsCustomCommand ? (
                <InspectorSection className="cua-install-custom-path" title={t("Use a custom executable path")}>
                  <Field error={validationMessage ? <span role="alert">{validationMessage}</span> : undefined} label={t("Executable path")}>
                    <Input
                      autoComplete="off"
                      onChange={(event) => {
                        setCustomCommand(event.target.value);
                        setCopyState("idle");
                      }}
                      placeholder="/opt/homebrew/bin/cua-driver"
                      spellCheck={false}
                      value={customCommand}
                    />
                  </Field>
                </InspectorSection>
              ) : null}
              <InlineFeedback className="cua-install-safety-note" role="note" tone="neutral">
                {t("Ling will only detect and connect the local driver. It will not run the installation command for you.")}
              </InlineFeedback>
            </DrawerBody>
            <DrawerFooter className="cua-install-footer">
              <Button disabled={busy} onClick={onClose}>{t("Cancel")}</Button>
              <Button
                leadingIcon={<RefreshCw aria-hidden="true" />}
                loading={busy}
                loadingLabel={t("Loading")}
                onClick={() => void recheck()}
                variant="primary"
              >
                {t("Recheck")}
              </Button>
            </DrawerFooter>
          </>
        ) : null}
      </DrawerContent>
    </Drawer>
  );
}

async function copyText(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    return;
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    if (!copied) throw new Error("Clipboard is unavailable.");
  }
}
