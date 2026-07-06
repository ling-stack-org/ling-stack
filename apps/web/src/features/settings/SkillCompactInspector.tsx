import { BookOpen, Search } from "lucide-react";
import { formatDateTime } from "../../lib/formatting.js";
import type {
  SkillOptimizationPreview,
  SkillRegistryEntry,
  SkillSourceArtifact,
  SkillSourceSnapshot,
} from "../../types.js";
import { approvalProfileText, workflowPhaseLabel } from "../teammates/helpers.js";
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
  sourceSnapshot,
  sourceHistory,
  artifacts,
  optimizationPreview,
  optimizationPreviewLoading,
  cwd,
  saving,
  boundTeammates,
  onPreviewOptimization,
  onArchiveSource,
  onRollbackSource,
  t,
}: {
  readonly skill: SkillRegistryEntry;
  readonly sourceSnapshot: SkillSourceSnapshot | undefined;
  readonly sourceHistory: readonly SkillSourceSnapshot[];
  readonly artifacts: readonly SkillSourceArtifact[];
  readonly optimizationPreview: SkillOptimizationPreview | undefined;
  readonly optimizationPreviewLoading: boolean;
  readonly cwd: string;
  readonly saving: boolean;
  readonly boundTeammates: readonly string[];
  readonly onPreviewOptimization: () => void;
  readonly onArchiveSource: () => void;
  readonly onRollbackSource: (snapshotId: string) => void;
  readonly t: SettingsTranslator;
}): JSX.Element {
  const state = skillRegistryState(skill, t);
  const requiredToolCount = skill.definition.requiredTools.length;
  const providerCapabilityCount = skill.definition.requiredProviderCapabilities.length;
  const promptFragmentCount = skill.definition.promptFragments.length;

  return (
    <div className="settings-skill-compact-inspector">
      <div className="settings-skill-inspector-head">
        <span>
          <BookOpen size={15} />
          <strong>{skill.definition.name}</strong>
        </span>
        <SkillStatePill label={state.label} tone={state.tone} />
      </div>

      <div className="settings-skill-summary-card">
        <p>{skill.definition.summary}</p>
        <div className="settings-skill-summary-strip" aria-label={t("Skill capability summary")}>
          <span>
            <small>{t("Source")}</small>
            <SkillSourceStatus source={skill.source} snapshot={sourceSnapshot} t={t} />
          </span>
          <span>
            <small>{t("Stage")}</small>
            <strong>{workflowPhaseLabel(skill.definition.workflowPhase, t)}</strong>
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
            <small>
              {sourceSnapshot
                ? t("Source details are available below when you need them.")
                : t("No published SKILL.md snapshot is attached yet.")}
            </small>
          </span>
          <button className="secondary-button compact-button" type="button" onClick={onPreviewOptimization} disabled={saving || optimizationPreviewLoading}>
            <Search size={14} />
            {optimizationPreviewLoading ? t("Previewing...") : t("Preview optimization")}
          </button>
        </div>
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
          showPreviewAction={false}
          cwd={cwd}
          saving={saving}
          onPreviewOptimization={onPreviewOptimization}
          onArchive={onArchiveSource}
          onRollback={onRollbackSource}
          t={t}
        />
      </details>

      <small className="settings-skill-updated-line">{t("Updated {time}", { time: formatDateTime(skill.updatedAt) })}</small>
    </div>
  );
}
