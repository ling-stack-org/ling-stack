import { formatDateTime } from "../../lib/formatting.js";
import { Pencil } from "lucide-react";
import type {
  SkillOptimizationPreview,
  SkillRegistryEntry,
  SkillSourceArtifact,
  SkillSourceSnapshot,
} from "../../types.js";
import { approvalProfileText } from "../teammates/helpers.js";
import {
  SkillInspectorSection,
  SkillSourceInspector,
  SkillSourceStatus,
  SkillStatePill,
  SkillTokenList,
} from "./SkillLibraryWidgets.js";
import type { SettingsTranslator } from "./skill-library-utils.js";
import { skillRegistryState } from "./skill-library-utils.js";

export function SkillCompactInspector({
  skill,
  readOnly = false,
  sourceSnapshot,
  sourceHistory,
  artifacts,
  optimizationPreview,
  optimizationPreviewLoading,
  cwd,
  saving,
  boundTeammates,
  editable = false,
  onEdit,
  onPreviewOptimization,
  onArchiveSource,
  onRollbackSource,
  t,
}: {
  readonly skill: SkillRegistryEntry;
  readonly readOnly?: boolean;
  readonly sourceSnapshot: SkillSourceSnapshot | undefined;
  readonly sourceHistory: readonly SkillSourceSnapshot[];
  readonly artifacts: readonly SkillSourceArtifact[];
  readonly optimizationPreview: SkillOptimizationPreview | undefined;
  readonly optimizationPreviewLoading: boolean;
  readonly cwd: string;
  readonly saving: boolean;
  readonly boundTeammates: readonly string[];
  readonly editable?: boolean;
  readonly onEdit?: () => void;
  readonly onPreviewOptimization: () => void;
  readonly onArchiveSource: () => void;
  readonly onRollbackSource: (snapshotId: string) => void;
  readonly t: SettingsTranslator;
}): JSX.Element {
  const state = skillRegistryState(skill, t);
  const requiredToolCount = skill.definition.requiredTools.length;
  const providerCapabilityCount = skill.definition.requiredProviderCapabilities.length;
  const promptFragmentCount = skill.definition.promptFragments.length;
  const showState = skill.reviewStatus === "draft" || skill.reviewStatus === "disabled";

  return (
    <div className="settings-skill-compact-inspector">
      <div className="settings-skill-summary-card">
        {showState ? <div className="settings-skill-detail-state"><SkillStatePill label={state.label} tone={state.tone} /></div> : null}
        <p>{skill.definition.summary}</p>
        <div className="settings-skill-summary-strip" aria-label={t("Skill capability summary")}>
          <span>
            <small>{t("Source")}</small>
            <SkillSourceStatus source={skill.source} snapshot={sourceSnapshot} t={t} />
          </span>
          <span>
            <small>{t("Required tools")}</small>
            <strong>{requiredToolCount}</strong>
          </span>
          <span>
            <small>{t("Bound teammates")}</small>
            <strong>{boundTeammates.length}</strong>
          </span>
        </div>
        <div className="settings-skill-next-action">
          <span>
            <strong>{sourceSnapshot ? t("Source-backed") : t("Metadata only")}</strong>
            {!sourceSnapshot ? <small>{t("No published SKILL.md snapshot is attached yet.")}</small> : null}
          </span>
        </div>
        {editable && onEdit ? (
          <div className="settings-skill-summary-edit-action">
            <button className="secondary-button compact-button" type="button" onClick={onEdit} disabled={saving}>
              <Pencil size={14} />
              {t("Edit skill")}
            </button>
          </div>
        ) : null}
      </div>

      <details className="settings-compact-details settings-skill-inspector-details">
        <summary>{t("Requirements and policy")}</summary>
        <SkillInspectorSection title={t("Required tools")}>
          <SkillTokenList values={skill.definition.requiredTools} emptyLabel={t("No tools")} />
        </SkillInspectorSection>
        <SkillInspectorSection title={t("Approval profile")}>
          <p>{approvalProfileText(skill.definition.approvalProfile, t)}</p>
        </SkillInspectorSection>
        <SkillInspectorSection title={t("Provider capability")}>
          <SkillTokenList values={skill.definition.requiredProviderCapabilities} emptyLabel={t("No provider capability required")} />
          {providerCapabilityCount === 0 ? null : <small>{t("{count} provider capabilities required", { count: providerCapabilityCount })}</small>}
        </SkillInspectorSection>
        <SkillInspectorSection title={t("Bound teammates")}>
          <SkillTokenList values={boundTeammates} emptyLabel={t("Unbound")} />
        </SkillInspectorSection>
      </details>

      <details className="settings-compact-details settings-skill-inspector-details">
        <summary>{t("Prompt fragments")}: {promptFragmentCount}</summary>
        <SkillInspectorSection title={t("Prompt fragments")}>
          {promptFragmentCount > 0 ? (
            <pre>{skill.definition.promptFragments.slice(0, 3).join("\n\n")}</pre>
          ) : (
            <p>{t("No prompt fragments")}</p>
          )}
        </SkillInspectorSection>
      </details>

      <details className="settings-compact-details settings-skill-inspector-details">
        <summary>{t("Source and raw details")}</summary>
        <SkillSourceInspector
          snapshot={sourceSnapshot}
          history={sourceHistory}
          artifacts={artifacts}
          optimizationPreview={optimizationPreview}
          optimizationPreviewLoading={optimizationPreviewLoading}
          showPreviewAction={Boolean(sourceSnapshot)}
          cwd={cwd}
          saving={saving}
          onPreviewOptimization={onPreviewOptimization}
          onArchive={onArchiveSource}
          onRollback={onRollbackSource}
          allowSourceMutations={!readOnly}
          t={t}
        />
      </details>

      <small className="settings-skill-updated-line">{t("Updated {time}", { time: formatDateTime(skill.updatedAt) })}</small>
    </div>
  );
}
