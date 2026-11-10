import { formatKnownDateTime } from "../../lib/formatting.js";
import { Pencil } from "lucide-react";
import { Button, InspectorSection, StatusIndicator } from "../../shared/ui/index.js";
import type {
  SkillOptimizationPreview,
  SkillRegistryEntry,
  SkillSourceArtifact,
  SkillSourceSnapshot,
} from "../../types.js";
import { approvalProfileText } from "../teammates/helpers.js";
import { SkillSourceStatus, SkillTokenList } from "./SkillLibraryPrimitives.js";
import { SkillSourceInspector } from "./SkillSourceInspector.js";
import type { SettingsTranslator } from "./skill-library-utils.js";
import { skillRegistryState } from "./skill-library-utils.js";
import { SkillDefinitionHistory } from "../../shared/components/learning/SkillDefinitionHistory.js";

export function SkillCompactInspector({
  skill,
  readOnly = false,
  sourceSnapshot,
  sourceHistory,
  artifacts,
  sourceArtifactsLoading,
  sourceError,
  optimizationPreview,
  cwd,
  busyAction,
  boundTeammates,
  editable = false,
  onEdit,
  onPreviewOptimization,
  onArchiveSource,
  onRollbackSource,
  onDefinitionChanged,
  t,
}: {
  readonly skill: SkillRegistryEntry;
  readonly readOnly?: boolean;
  readonly sourceSnapshot: SkillSourceSnapshot | undefined;
  readonly sourceHistory: readonly SkillSourceSnapshot[];
  readonly artifacts: readonly SkillSourceArtifact[];
  readonly sourceArtifactsLoading: boolean;
  readonly sourceError: string;
  readonly optimizationPreview: SkillOptimizationPreview | undefined;
  readonly cwd: string;
  readonly busyAction: string;
  readonly boundTeammates: readonly string[];
  readonly editable?: boolean;
  readonly onEdit?: () => void;
  readonly onPreviewOptimization: () => void;
  readonly onArchiveSource: () => void;
  readonly onRollbackSource: (snapshotId: string) => void;
  readonly onDefinitionChanged?: () => Promise<void>;
  readonly t: SettingsTranslator;
}): React.JSX.Element {
  const state = skillRegistryState(skill, t);
  const requiredToolCount = skill.definition.requiredTools.length;
  const providerCapabilityCount = skill.definition.requiredProviderCapabilities.length;
  const promptFragmentCount = skill.definition.promptFragments.length;
  const showState = skill.reviewStatus === "draft" || skill.reviewStatus === "disabled";

  return (
    <div className="settings-skill-compact-inspector">
      <div className="settings-skill-summary-card">
        {showState ? (
          <div className="settings-skill-detail-state">
            <StatusIndicator compact label={state.label} tone={state.tone === "blocked" ? "danger" : "warning"} />
          </div>
        ) : null}
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
            <Button size="sm" variant="secondary" leadingIcon={<Pencil size={14} />} onClick={onEdit} disabled={Boolean(busyAction)}>
              {t("Edit skill")}
            </Button>
          </div>
        ) : null}
      </div>

      <InspectorSection
        className="settings-skill-inspector-details"
        title={t("Requirements and policy")}
        summary={t("{count} requirements", { count: requiredToolCount + providerCapabilityCount })}
      >
        <section className="settings-skill-inspector-section">
          <h3>{t("Required tools")}</h3>
          <SkillTokenList values={skill.definition.requiredTools} emptyLabel={t("No tools")} />
        </section>
        <section className="settings-skill-inspector-section">
          <h3>{t("Approval profile")}</h3>
          <p>{approvalProfileText(skill.definition.approvalProfile, t)}</p>
        </section>
        <section className="settings-skill-inspector-section">
          <h3>{t("Provider capability")}</h3>
          <SkillTokenList values={skill.definition.requiredProviderCapabilities} emptyLabel={t("No provider capability required")} />
          {providerCapabilityCount === 0 ? null : <small>{t("{count} provider capabilities required", { count: providerCapabilityCount })}</small>}
        </section>
        <section className="settings-skill-inspector-section">
          <h3>{t("Bound teammates")}</h3>
          <SkillTokenList values={boundTeammates} emptyLabel={t("Unbound")} />
        </section>
      </InspectorSection>

      <InspectorSection className="settings-skill-inspector-details" title={t("Prompt fragments")} summary={String(promptFragmentCount)}>
        {promptFragmentCount > 0 ? (
          <pre>{skill.definition.promptFragments.slice(0, 3).join("\n\n")}</pre>
        ) : (
          <p>{t("No prompt fragments")}</p>
        )}
      </InspectorSection>

      <InspectorSection
        className="settings-skill-inspector-details"
        title={t("Source and raw details")}
        summary={sourceSnapshot ? t("Source-backed") : t("Metadata only")}
      >
        <SkillSourceInspector
          skillId={skill.id}
          snapshot={sourceSnapshot}
          history={sourceHistory}
          artifacts={artifacts}
          sourceArtifactsLoading={sourceArtifactsLoading}
          sourceError={sourceError}
          optimizationPreview={optimizationPreview}
          showPreviewAction={Boolean(sourceSnapshot)}
          cwd={cwd}
          busyAction={busyAction}
          onPreviewOptimization={onPreviewOptimization}
          onArchive={onArchiveSource}
          onRollback={onRollbackSource}
          allowSourceMutations={!readOnly}
          t={t}
        />
      </InspectorSection>

      <SkillDefinitionHistory cwd={cwd} skill={skill} editable={editable && !readOnly} onChanged={onDefinitionChanged} />
      <small className="settings-skill-updated-line">{t("Updated {time}", { time: formatKnownDateTime(skill.updatedAt, t("Unknown")) })}</small>
    </div>
  );
}
