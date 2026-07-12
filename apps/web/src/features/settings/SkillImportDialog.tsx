import { useEffect } from "react";
import { CheckCircle2, FileText, Loader2, Search, Upload, X } from "lucide-react";
import type {
  SkillImportPreview,
  SkillImportWarningCode,
  SkillSourceContextHealthFinding,
} from "../../types.js";
import { SkillStatePill } from "./SkillLibraryWidgets.js";
import { type SettingsTranslator, sourceHealthKindLabel } from "./skill-library-utils.js";
import {
  skillImportHasBlockingWarnings,
  skillImportProblemLabel,
  skillImportWarnings,
  type SkillImportForm,
} from "./skill-import-utils.js";
import type { SkillImportBusyState, SkillImportDialogMode } from "./useSkillImportController.js";

export function SkillImportDialog({
  mode,
  form,
  preview,
  contextFindings,
  blockingIssues,
  busy,
  error,
  onClose,
  onContentChange,
  onLoadFile,
  onCheck,
  onImport,
  onPublish,
  t,
}: {
  readonly mode: SkillImportDialogMode;
  readonly form: SkillImportForm;
  readonly preview: SkillImportPreview | undefined;
  readonly contextFindings: readonly SkillSourceContextHealthFinding[];
  readonly blockingIssues: readonly SkillImportWarningCode[];
  readonly busy: SkillImportBusyState;
  readonly error: string;
  readonly onClose: () => void;
  readonly onContentChange: (content: string) => void;
  readonly onLoadFile: (file: File | undefined) => void;
  readonly onCheck: () => void;
  readonly onImport: () => void;
  readonly onPublish: () => void;
  readonly t: SettingsTranslator;
}): JSX.Element {
  useEffect(() => {
    function handleEscape(event: KeyboardEvent): void {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }

    document.addEventListener("keydown", handleEscape, true);
    return () => document.removeEventListener("keydown", handleEscape, true);
  }, [onClose]);

  return (
    <div
      className="settings-skill-import-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section className={`settings-skill-import-panel settings-interaction-dialog settings-skill-import-panel--${mode}`} role="dialog" aria-modal="true" aria-labelledby="settings-skill-import-title">
        <header className="settings-skill-import-head">
          <span>
            <Upload size={16} />
            <h3 id="settings-skill-import-title">{t(mode === "file" ? "Import skill" : "New skill draft")}</h3>
          </span>
          <button className="icon-button" type="button" onClick={onClose} aria-label={t("Close import dialog")} title={t("Close")}>
            <X size={16} />
          </button>
        </header>

        {mode === "file" ? (
          <FileImportContent
            form={form}
            blockingIssues={blockingIssues}
            busy={busy}
            error={error}
            onClose={onClose}
            onLoadFile={onLoadFile}
            onImport={onImport}
            t={t}
          />
        ) : (
          <DraftImportContent
            form={form}
            preview={preview}
            contextFindings={contextFindings}
            busy={busy}
            error={error}
            onContentChange={onContentChange}
            onCheck={onCheck}
            onPublish={onPublish}
            t={t}
          />
        )}
      </section>
    </div>
  );
}

function FileImportContent({
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
  return (
    <>
      <p className="settings-skill-import-intro">{t("Choose one skill file. Ling will check it automatically before importing.")}</p>

      {error ? <div className="inline-error">{error}</div> : null}

      <div className={`settings-skill-file-picker${form.fileName ? " has-file" : ""}`}>
        {form.fileName ? (
          <div className="settings-skill-selected-file">
            <FileText size={18} />
            <strong>{form.fileName}</strong>
          </div>
        ) : (
          <span className="settings-skill-file-empty">
            <Upload size={20} />
            <strong>{t("Select a skill file")}</strong>
            <small>{t("Supports Markdown, JSON, and text files")}</small>
          </span>
        )}

        <label className="secondary-button compact-button settings-skill-file-button">
          {busy === "reading" ? <Loader2 className="spin" size={15} /> : <Upload size={15} />}
          {t(form.fileName ? "Choose another file" : "Choose skill file")}
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
      </div>

      {blockingIssues.length > 0 ? (
        <div className="settings-skill-import-problems" role="alert">
          <strong>{t("This skill cannot be imported yet")}</strong>
          <ul>
            {blockingIssues.map((code) => <li key={code}>{t(skillImportProblemLabel(code))}</li>)}
          </ul>
        </div>
      ) : null}

      <footer className="settings-skill-import-actions">
        <button className="secondary-button compact-button" type="button" onClick={onClose} disabled={Boolean(busy)}>{t("Cancel")}</button>
        <button className="primary-button compact-button" type="button" onClick={onImport} disabled={!form.fileName || Boolean(busy)} aria-busy={busy === "publishing"}>
          {busy === "publishing" ? <Loader2 className="spin" size={15} /> : <Upload size={15} />}
          {t("Import")}
        </button>
      </footer>
    </>
  );
}

function DraftImportContent({
  form,
  preview,
  contextFindings,
  busy,
  error,
  onContentChange,
  onCheck,
  onPublish,
  t,
}: {
  readonly form: SkillImportForm;
  readonly preview: SkillImportPreview | undefined;
  readonly contextFindings: readonly SkillSourceContextHealthFinding[];
  readonly busy: SkillImportBusyState;
  readonly error: string;
  readonly onContentChange: (content: string) => void;
  readonly onCheck: () => void;
  readonly onPublish: () => void;
  readonly t: SettingsTranslator;
}): JSX.Element {
  const publishDisabled = !preview || skillImportHasBlockingWarnings(preview) || Boolean(busy);

  return (
    <>
      <p className="settings-skill-import-intro">{t("Write or paste skill content, check it, then publish.")}</p>
      {error ? <div className="inline-error">{error}</div> : null}
      <label className="field settings-skill-import-content">
        <span>{t("Skill content")}</span>
        <textarea
          rows={10}
          value={form.content}
          onChange={(event) => onContentChange(event.currentTarget.value)}
          placeholder={t("Paste Markdown or JSON skill content")}
          disabled={Boolean(busy)}
        />
      </label>
      {preview ? <SkillImportCheckResult preview={preview} contextFindings={contextFindings} t={t} /> : null}
      <footer className="settings-skill-import-actions">
        <button className="secondary-button compact-button" type="button" onClick={onCheck} disabled={Boolean(busy) || !form.content.trim()}>
          {busy === "checking" ? <Loader2 className="spin" size={15} /> : <Search size={15} />}
          {t(busy === "checking" ? "Checking..." : preview ? "Check again" : "Check content")}
        </button>
        <button className="primary-button compact-button" type="button" onClick={onPublish} disabled={publishDisabled}>
          {busy === "publishing" ? <Loader2 className="spin" size={15} /> : <CheckCircle2 size={15} />}
          {t(busy === "publishing" ? "Publishing..." : "Publish")}
        </button>
      </footer>
    </>
  );
}

function SkillImportCheckResult({
  preview,
  contextFindings,
  t,
}: {
  readonly preview: SkillImportPreview;
  readonly contextFindings: readonly SkillSourceContextHealthFinding[];
  readonly t: SettingsTranslator;
}): JSX.Element {
  const warnings = skillImportWarnings(preview);
  const errorCount = warnings.filter((warning) => warning.severity === "error").length;
  const warningCount = warnings.length - errorCount;

  return (
    <div className="settings-skill-import-preview settings-interaction-preview">
      <div className="settings-interaction-summary" aria-label={t("Import check summary")}>
        <strong>{errorCount > 0 ? t("Content needs fixes") : t("Ready to publish")}</strong>
        <span>{t("{count} skills · {warnings} warnings · {errors} errors", { count: preview.definitions.length, warnings: warningCount, errors: errorCount })}</span>
      </div>
      <div className="settings-skill-import-preview-list">
        {preview.definitions.map((item) => {
          const blocked = item.warnings?.some((warning) => warning.severity === "error") ?? false;
          return (
            <article key={item.definition.id} className="settings-skill-draft-row">
              <strong>{item.definition.name}</strong>
              <SkillStatePill label={t(blocked ? "Needs fixes" : "Ready to publish")} tone={blocked ? "blocked" : "bindable"} />
            </article>
          );
        })}
      </div>
      {warnings.length > 0 || contextFindings.length > 0 ? (
        <details className="settings-compact-details settings-interaction-details">
          <summary>{t("Check details")}</summary>
          <div className="settings-skill-source-warning-list" aria-label={t("Check details")}>
            {warnings.map((warning, index) => <small key={`${warning.code}-${index}`} className={warning.severity}>{t(warning.code)}</small>)}
            {contextFindings.slice(0, 5).map((finding, index) => <small key={`${finding.kind}-${index}`} className={finding.severity}>{sourceHealthKindLabel(finding.kind, t)}</small>)}
          </div>
        </details>
      ) : null}
    </div>
  );
}
