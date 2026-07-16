import { useEffect, useState } from "react";
import { PackagePlus, X } from "lucide-react";
import { useI18n } from "../../i18n.js";
import type { ManagedPluginCreateRequest, ManagedPluginView } from "../../types.js";
import { SelectControl } from "../../shared/components/index.js";

type TransportChoice = "stdio" | "streamable-http";

export function PluginCreateDrawer({
  open,
  busy,
  onCreate,
  onClose,
}: {
  readonly open: boolean;
  readonly busy: boolean;
  readonly onCreate: (input: ManagedPluginCreateRequest) => Promise<ManagedPluginView | undefined>;
  readonly onClose: () => void;
}): JSX.Element | null {
  const { t } = useI18n();
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [transportType, setTransportType] = useState<TransportChoice>("stdio");
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");
  const [url, setUrl] = useState("");
  const [validation, setValidation] = useState("");

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    setDisplayName("");
    setDescription("");
    setTransportType("stdio");
    setCommand("");
    setArgsText("");
    setUrl("");
    setValidation("");
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape" && !busy) {
        onClose();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [busy, onClose, open]);

  if (!open) {
    return null;
  }

  async function submit(): Promise<void> {
    const name = displayName.trim();
    const summary = description.trim();
    if (!name) {
      setValidation(t("Plugin name is required."));
      return;
    }
    if (!summary) {
      setValidation(t("Plugin description is required."));
      return;
    }
    if (transportType === "stdio" && !command.trim()) {
      setValidation(t("Plugin command is required."));
      return;
    }
    if (transportType === "streamable-http" && !url.trim()) {
      setValidation(t("Plugin endpoint URL is required."));
      return;
    }
    setValidation("");
    const transport: ManagedPluginCreateRequest["transport"] = transportType === "stdio"
      ? {
          type: "stdio",
          command: command.trim(),
          args: argsText.split("\n").map((value) => value.trim()).filter(Boolean),
          env: {},
          secretEnvRefs: {},
        }
      : {
          type: "streamable-http",
          url: url.trim(),
          headers: {},
          secretHeaderRefs: {},
        };
    const plugin = await onCreate({ displayName: name, description: summary, transport });
    if (plugin) {
      onClose();
    }
  }

  return (
    <div className="plugin-detail-drawer plugin-create-drawer" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) {
        onClose();
      }
    }}>
      <aside className="plugin-detail-panel plugin-create-panel" role="dialog" aria-modal="true" aria-labelledby="plugin-create-title">
        <header className="plugin-detail-head">
          <div className="plugin-detail-title">
            <PackagePlus size={17} />
            <h2 id="plugin-create-title">{t("Add plugin")}</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} disabled={busy} aria-label={t("Close")}>
            <X size={16} />
          </button>
        </header>

        <form className="plugin-create-form" onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}>
          <div className="plugin-detail-body plugin-create-body">
            <label className="field">
              <span>{t("Plugin name")}</span>
              <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={80} autoFocus />
            </label>
            <label className="field">
              <span>{t("Plugin description")}</span>
              <textarea className="plugin-create-description-input" value={description} onChange={(event) => setDescription(event.target.value)} maxLength={180} rows={2} />
            </label>
            <label className="field">
              <span>{t("Connection type")}</span>
              <SelectControl value={transportType} onChange={(event) => setTransportType(event.target.value as TransportChoice)}>
                <option value="stdio">{t("Local command")}</option>
                <option value="streamable-http">{t("HTTP endpoint")}</option>
              </SelectControl>
            </label>
            {transportType === "stdio" ? (
              <>
                <label className="field">
                  <span>{t("Command")}</span>
                  <input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="npx" />
                </label>
                <label className="field">
                  <span>{t("Arguments (one per line)")}</span>
                  <textarea className="plugin-create-arguments-input" value={argsText} onChange={(event) => setArgsText(event.target.value)} rows={3} />
                </label>
              </>
            ) : (
              <label className="field">
                <span>{t("Endpoint URL")}</span>
                <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/mcp" />
              </label>
            )}
            {validation ? <div className="plugin-create-validation" role="alert">{validation}</div> : null}
          </div>

          <footer className="plugin-detail-footer">
            <button className="secondary-button compact-button" type="button" onClick={onClose} disabled={busy}>{t("Cancel")}</button>
            <button className="primary-button compact-button" type="submit" disabled={busy}>
              <PackagePlus size={14} />
              {t("Add plugin")}
            </button>
          </footer>
        </form>
      </aside>
    </div>
  );
}
