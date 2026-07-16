import { useEffect } from "react";
import { FileText, Loader2, Upload, X } from "lucide-react";
import type { SkillImportWarningCode } from "../../types.js";
import type { SettingsTranslator } from "./skill-library-utils.js";
import { skillImportProblemLabel, type SkillImportForm } from "./skill-import-utils.js";
import type { SkillImportBusyState } from "./useSkillImportController.js";

export function SkillImportDialog({
  form,
  blockingIssues,
  busy,
  error,
  onClose,
  onLoadFile,
  onImport,
  t,
}: {
  readonly form: SkillImportForm;
  readonly blockingIssues: readonly SkillImportWarningCode[];
  readonly busy: SkillImportBusyState;
  readonly error: string;
  readonly onClose: () => void;
  readonly onLoadFile: (file: File | undefined) => void;
  readonly onImport: () => void;
  readonly t: SettingsTranslator;
}): JSX.Element {
  useEffect(() => {
    function handleEscape(event: KeyboardEvent): void {
      if (event.key !== "Escape" || busy) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
    document.addEventListener("keydown", handleEscape, true);
    return () => document.removeEventListener("keydown", handleEscape, true);
  }, [busy, onClose]);

  return (
    <div
      className="settings-skill-import-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <section className="settings-skill-import-panel settings-skill-import-panel--file settings-interaction-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-skill-import-title">
        <header className="settings-skill-import-head">
          <span>
            <Upload size={16} />
            <h3 id="settings-skill-import-title">{t("Import skill")}</h3>
          </span>
          <button className="icon-button" type="button" onClick={onClose} disabled={Boolean(busy)} aria-label={t("Close import dialog")} title={t("Close")}>
            <X size={16} />
          </button>
        </header>

        {error ? <div className="inline-error">{error}</div> : null}

        <label className={`settings-skill-file-picker${form.fileName ? " has-file" : ""}${busy ? " is-busy" : ""}`}>
          {form.fileName ? (
            <div className="settings-skill-selected-file">
              <FileText size={18} />
              <span>
                <strong>{form.fileName}</strong>
                <small>{t("Choose another file")}</small>
              </span>
            </div>
          ) : (
            <span className="settings-skill-file-empty">
              <Upload size={20} />
              <strong>{t("Select a skill file")}</strong>
              <small>{t("Supports Markdown, JSON, and text files")}</small>
            </span>
          )}
          {busy === "reading" ? <Loader2 className="settings-skill-file-picker-loading spin" size={16} aria-label={t("Reading file...")} /> : null}
          <input
            type="file"
            accept=".md,.markdown,.json,.txt,text/markdown,text/plain,application/json"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              onLoadFile(file);
            }}
            disabled={Boolean(busy)}
          />
        </label>

        {blockingIssues.length > 0 ? (
          <div className="settings-skill-import-problems" role="alert">
            <strong>{t("This skill cannot be imported yet")}</strong>
            <ul>{blockingIssues.map((code) => <li key={code}>{t(skillImportProblemLabel(code))}</li>)}</ul>
          </div>
        ) : null}

        <footer className="settings-skill-import-actions">
          <button className="secondary-button compact-button" type="button" onClick={onClose} disabled={Boolean(busy)}>{t("Cancel")}</button>
          <button className="primary-button compact-button" type="button" onClick={onImport} disabled={!form.fileName || Boolean(busy)} aria-busy={busy === "publishing"}>
            {busy === "publishing" ? <Loader2 className="spin" size={15} /> : <Upload size={15} />}
            {t(busy === "publishing" ? "Importing..." : "Import")}
          </button>
        </footer>
      </section>
    </div>
  );
}
