import { useEffect, useState } from "react";
import { Check, Copy, ExternalLink, Loader2, RefreshCw, X } from "lucide-react";
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
}): JSX.Element | null {
  const { t } = useI18n();
  const [customCommand, setCustomCommand] = useState("");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [validationMessage, setValidationMessage] = useState("");
  const guide = plugin?.setup?.guide;

  useEffect(() => {
    if (!open) {
      return;
    }
    setCustomCommand("");
    setCopyState("idle");
    setValidationMessage("");
  }, [open, plugin?.id]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape" && !busy) {
        onClose();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [busy, onClose, open]);

  useEffect(() => {
    if (open && plugin && plugin.setup?.state !== "missing") {
      onClose();
    }
  }, [onClose, open, plugin]);

  if (!open || !plugin || plugin.setup?.state !== "missing" || !guide) {
    return null;
  }
  const activePlugin = plugin;
  const activeGuide = guide;

  async function copyInstallCommand(): Promise<void> {
    try {
      await copyText(activeGuide.installCommand);
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1800);
    } catch {
      setCopyState("failed");
    }
  }

  async function recheck(): Promise<void> {
    const command = customCommand.trim();
    if (command && !command.startsWith("/")) {
      setValidationMessage(t("Enter an absolute executable path."));
      return;
    }
    setValidationMessage("");
    const connected = await onConnect(activePlugin.id, command || undefined);
    if (connected?.setup?.state === "connected" || connected?.setup?.state === "ready") {
      onClose();
    }
  }

  return (
    <div className="cua-install-drawer" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) {
        onClose();
      }
    }}>
      <aside className="cua-install-panel" role="dialog" aria-modal="true" aria-labelledby="cua-install-title">
        <header className="cua-install-head">
          <div>
            <h2 id="cua-install-title">{t("Install Cua Driver")}</h2>
            <p>{t("Ling did not detect Cua Driver on this Mac.")}</p>
          </div>
          <button className="icon-button" type="button" onClick={onClose} disabled={busy} aria-label={t("Close")}>
            <X size={16} />
          </button>
        </header>

        <div className="cua-install-body">
          <section className="cua-install-section">
            <div className="cua-install-section-head">
              <div>
                <strong>{t("Official installation")}</strong>
                <span>{t("Review the official guide, then run the command yourself in Terminal.")}</span>
              </div>
              <a className="secondary-button compact-button" href={activeGuide.documentationUrl} target="_blank" rel="noreferrer">
                <ExternalLink size={14} />
                {t("Open official guide")}
              </a>
            </div>
            <div className="cua-install-command">
              <code>{activeGuide.installCommand}</code>
              <button className="icon-button" type="button" onClick={() => void copyInstallCommand()} aria-label={t("Copy install command")}>
                {copyState === "copied" ? <Check size={15} /> : <Copy size={15} />}
              </button>
            </div>
            <span className={`cua-install-copy-status ${copyState}`} role="status" aria-live="polite">
              {copyState === "copied" ? t("Command copied") : copyState === "failed" ? t("Copy failed") : ""}
            </span>
          </section>

          {activeGuide.supportsCustomCommand ? (
            <details className="cua-install-custom-path">
              <summary>{t("Use a custom executable path")}</summary>
              <label className="field">
                <span>{t("Executable path")}</span>
                <input
                  value={customCommand}
                  onChange={(event) => setCustomCommand(event.target.value)}
                  placeholder="/opt/homebrew/bin/cua-driver"
                  spellCheck={false}
                  autoComplete="off"
                />
              </label>
              {validationMessage ? <span className="cua-install-validation" role="alert">{validationMessage}</span> : null}
            </details>
          ) : null}

          <div className="cua-install-safety-note">
            {t("Ling will only detect and connect the local driver. It will not run the installation command for you.")}
          </div>
        </div>

        <footer className="cua-install-footer">
          <button className="ghost-button compact-button" type="button" onClick={onClose} disabled={busy}>
            {t("Cancel")}
          </button>
          <button className="primary-button compact-button" type="button" onClick={() => void recheck()} disabled={busy}>
            {busy ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
            {t("Recheck")}
          </button>
        </footer>
      </aside>
    </div>
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
    if (!copied) {
      throw new Error("Clipboard is unavailable.");
    }
  }
}
