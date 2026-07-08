import { useEffect } from "react";
import { CheckCircle2, Loader2, Search, Upload } from "lucide-react";
import type {
  SkillImportDraft,
  SkillOptimizationPreview,
  SkillPackSource,
  SkillSourceContextHealthFinding,
} from "../../types.js";
import { SkillStatePill } from "./SkillLibraryWidgets.js";
import { type SettingsTranslator, sourceHealthKindLabel } from "./skill-library-utils.js";

export interface SkillImportForm {
  readonly name: string;
  readonly sourcePath: string;
  readonly source: SkillPackSource;
  readonly content: string;
}

export const initialSkillImportForm: SkillImportForm = {
  name: "",
  sourcePath: "",
  source: "custom",
  content: "",
};

export function SkillImportDialog({
  form,
  draft,
  contextFindings,
  optimizationPreview,
  saving,
  optimizationPreviewLoading,
  onClose,
  onFormChange,
  onPreviewDraft,
  onPreviewOptimization,
  onPublish,
  t,
}: {
  readonly form: SkillImportForm;
  readonly draft: SkillImportDraft | undefined;
  readonly contextFindings: readonly SkillSourceContextHealthFinding[];
  readonly optimizationPreview: SkillOptimizationPreview | undefined;
  readonly saving: boolean;
  readonly optimizationPreviewLoading: boolean;
  readonly onClose: () => void;
  readonly onFormChange: (form: SkillImportForm) => void;
  readonly onPreviewDraft: () => void;
  readonly onPreviewOptimization: () => void;
  readonly onPublish: () => void;
  readonly t: SettingsTranslator;
}): JSX.Element {
  const draftWarnings = draft ? [...draft.warnings, ...draft.definitions.flatMap((item) => item.warnings ?? [])] : [];
  const hasBlockingWarnings = draftWarnings.some((warning) => warning.severity === "error");
  const publishDisabled = saving || !draft || hasBlockingWarnings || draft.definitions.some((item) => item.warnings?.some((warning) => warning.severity === "error"));

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
      <section className="settings-skill-import-panel settings-interaction-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-skill-import-title">
        <div className="panel-title split">
          <span>
            <Upload size={15} />
            <h3 id="settings-skill-import-title">{t("Import skill draft")}</h3>
          </span>
          <button className="ghost-button compact-button" type="button" onClick={onClose} aria-label={t("Close import dialog")}>
            {t("Close")}
          </button>
        </div>

        <div className="settings-interaction-summary" aria-label={t("Import summary")}>
          <strong>{draft ? t("Draft ready to review") : t("Paste skill content and preview the draft")}</strong>
          <span>{draft ? t("{count} skills ready to publish", { count: draft.definitions.length }) : t("Preview keeps the registry unchanged until you publish.")}</span>
        </div>

        <div className="settings-skill-import-grid">
          <label className="field">
            <span>{t("Source")}</span>
            <select value={form.source} onChange={(event) => onFormChange({ ...form, source: event.target.value as SkillPackSource })}>
              <option value="custom">{t("custom")}</option>
              <option value="skill-directory">{t("skill-directory")}</option>
              <option value="agents-md">{t("agents-md")}</option>
              <option value="workspace">{t("workspace")}</option>
            </select>
          </label>
          <label className="field">
            <span>{t("Draft name")}</span>
            <input value={form.name} onChange={(event) => onFormChange({ ...form, name: event.target.value })} />
          </label>
          <label className="field">
            <span>{t("Source path")}</span>
            <input value={form.sourcePath} onChange={(event) => onFormChange({ ...form, sourcePath: event.target.value })} placeholder="SKILL.md / AGENTS.md" />
          </label>
          <label className="field wide">
            <span>{t("Skill content")}</span>
            <textarea rows={5} value={form.content} onChange={(event) => onFormChange({ ...form, content: event.target.value })} />
          </label>
        </div>

        {draft ? (
          <SkillImportPreview
            draft={draft}
            contextFindings={contextFindings}
            optimizationPreview={optimizationPreview}
            t={t}
          />
        ) : null}

        <div className="settings-skill-import-actions">
          <button className="secondary-button compact-button" type="button" onClick={onPreviewDraft} disabled={saving || !form.content.trim()}>
            {saving ? <Loader2 className="spin" size={15} /> : <Search size={15} />}
            {t("Preview draft")}
          </button>
          <button
            className="secondary-button compact-button"
            type="button"
            onClick={onPreviewOptimization}
            disabled={saving || optimizationPreviewLoading || !draft}
          >
            {optimizationPreviewLoading ? <Loader2 className="spin" size={15} /> : <Search size={15} />}
            {t("Preview optimization")}
          </button>
          <button className="primary-button compact-button" type="button" onClick={onPublish} disabled={publishDisabled}>
            <CheckCircle2 size={15} />
            {t("Publish to registry")}
          </button>
        </div>
      </section>
    </div>
  );
}

function SkillImportPreview({
  draft,
  contextFindings,
  optimizationPreview,
  t,
}: {
  readonly draft: SkillImportDraft;
  readonly contextFindings: readonly SkillSourceContextHealthFinding[];
  readonly optimizationPreview: SkillOptimizationPreview | undefined;
  readonly t: SettingsTranslator;
}): JSX.Element {
  const draftWarnings = [...draft.warnings, ...draft.definitions.flatMap((item) => item.warnings ?? [])];
  const errorCount = draftWarnings.filter((warning) => warning.severity === "error").length;
  const warningCount = draftWarnings.length - errorCount;

  return (
    <div className="settings-skill-import-preview settings-interaction-preview">
      <div className="settings-interaction-summary" aria-label={t("Draft preview summary")}>
        <strong>{errorCount > 0 ? t("Draft needs fixes") : t("Draft can be published")}</strong>
        <span>{t("{count} skills · {warnings} warnings · {errors} errors", { count: draft.definitions.length, warnings: warningCount, errors: errorCount })}</span>
      </div>

      <div className="settings-skill-import-preview-list">
        {draft.definitions.map((item) => (
          <article key={item.definition.id} className="settings-skill-draft-row">
            <span>
              <strong>{item.definition.name}</strong>
              <small>{item.warnings?.length ? t("{count} warnings", { count: item.warnings.length }) : t("Ready to publish")}</small>
            </span>
            <SkillStatePill label={item.warnings?.some((warning) => warning.severity === "error") ? t("Blocked") : t("Draft")} tone={item.warnings?.some((warning) => warning.severity === "error") ? "blocked" : "draft"} />
          </article>
        ))}
      </div>

      {draftWarnings.length > 0 || contextFindings.length > 0 ? (
        <details className="settings-compact-details settings-interaction-details">
          <summary>{t("Import evidence")}</summary>
          <div className="settings-skill-source-warning-list" aria-label={t("Import evidence")}>
            {draft.definitions.map((item) => (
              <small key={item.definition.id} className="info">
                {item.definition.id}: {item.definition.summary}
              </small>
            ))}
            {draftWarnings.map((warning, index) => (
              <small key={`${warning.code}-${index}`} className={warning.severity}>
                {t(warning.code)}: {warning.message}
              </small>
            ))}
            {contextFindings.slice(0, 5).map((finding, index) => (
              <small key={`${finding.kind}-${index}`} className={finding.severity}>
                {sourceHealthKindLabel(finding.kind, t)} · {t(finding.message)}
              </small>
            ))}
          </div>
        </details>
      ) : null}

      {optimizationPreview ? (
        <details className="settings-compact-details settings-interaction-details">
          <summary>{t("Optimization preview")}</summary>
          <div className="settings-skill-optimization-preview" aria-label={t("Skill optimization preview")}>
            <div className="settings-skill-source-detail">
              <span><small>{t("Mode")}</small><code>{optimizationPreview.mode}</code></span>
              <span><small>{t("Status")}</small><code>{optimizationPreview.status}</code></span>
              <span><small>{t("Original tokens")}</small><code>{optimizationPreview.originalTokenEstimate}</code></span>
              <span><small>{t("Compiled tokens")}</small><code>{optimizationPreview.compiledTokenEstimate}</code></span>
            </div>
            <div className="settings-skill-source-tags">
              <span>{t("Risks")}: {optimizationPreview.risks.length}</span>
              <span>{t("Lazy references")}: {optimizationPreview.compiledView?.lazyReferences.length ?? 0}</span>
              <span>{t("Authority unchanged")}</span>
            </div>
            {optimizationPreview.routingDescription?.suggested ? (
              <small>{t("Suggested routing")}: {optimizationPreview.routingDescription.suggested}</small>
            ) : null}
          </div>
        </details>
      ) : null}
    </div>
  );
}
