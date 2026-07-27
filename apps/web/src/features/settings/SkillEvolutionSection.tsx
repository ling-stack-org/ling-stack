import type {
  Channel,
  ChannelPlaybookCandidate,
  ChannelPlaybookCandidateReviewAction,
  ProcedureObservationCluster,
  SkillCandidate,
  SkillCandidateReviewAction,
  SkillOptimizationPreview,
  SkillRegistryEntry,
  SkillSourceArtifact,
  SkillSourceSnapshot,
} from "../../types.js";
import { Select } from "../../shared/ui/index.js";
import { SkillLibraryRegistrySection } from "./SkillLibraryRegistrySection.js";
import { SkillReviewQueuePanel } from "./SkillReviewQueuePanel.js";
import type { SettingsTranslator, TeammateSkillBindingSummary } from "./skill-library-utils.js";
import { isOpenSkillCandidateStatus, isTerminalSkillCandidateStatus } from "./skill-library-utils.js";
import { partitionSkillRegistry, type SkillEvolutionViewId } from "./skill-library-view-models.js";

export function SkillEvolutionSection({
  view,
  skills,
  skillCandidates,
  clusters,
  playbookCandidates,
  channels,
  loading,
  busyAction,
  selectedSkillId,
  bindingSummaries,
  sourceSnapshotBySkillId,
  sourceHistoryBySkillId,
  artifacts,
  sourceArtifactsLoading,
  sourceError,
  optimizationPreview,
  reviewError,
  cwd,
  onViewChange,
  onSelectSkill,
  onArchiveSkill,
  onDeleteSkill,
  onEditSkill,
  onPreviewOptimization,
  onArchiveSource,
  onRollbackSource,
  onAdoptSkillCandidate,
  onReviewSkillCandidate,
  onCreateProtocolCandidate,
  onCreatePlaybookCandidate,
  onReviewPlaybookCandidate,
  t,
}: {
  readonly view: SkillEvolutionViewId;
  readonly skills: readonly SkillRegistryEntry[];
  readonly skillCandidates: readonly SkillCandidate[];
  readonly clusters: readonly ProcedureObservationCluster[];
  readonly playbookCandidates: readonly ChannelPlaybookCandidate[];
  readonly channels: readonly Channel[];
  readonly loading: boolean;
  readonly busyAction: string;
  readonly selectedSkillId: string | undefined;
  readonly bindingSummaries: readonly TeammateSkillBindingSummary[];
  readonly sourceSnapshotBySkillId: ReadonlyMap<string, SkillSourceSnapshot>;
  readonly sourceHistoryBySkillId: ReadonlyMap<string, readonly SkillSourceSnapshot[]>;
  readonly artifacts: readonly SkillSourceArtifact[];
  readonly sourceArtifactsLoading: boolean;
  readonly sourceError: string;
  readonly optimizationPreview: SkillOptimizationPreview | undefined;
  readonly reviewError: string;
  readonly cwd: string;
  readonly onViewChange: (view: SkillEvolutionViewId) => void;
  readonly onSelectSkill: (skillId: string) => void;
  readonly onArchiveSkill: (skillId: string) => void;
  readonly onDeleteSkill: (skill: SkillRegistryEntry, trigger: HTMLButtonElement) => void;
  readonly onEditSkill: (skill: SkillRegistryEntry) => void;
  readonly onPreviewOptimization: () => void;
  readonly onArchiveSource: (skillId: string) => void;
  readonly onRollbackSource: (snapshotId: string) => void;
  readonly onAdoptSkillCandidate: (candidateId: string) => void;
  readonly onReviewSkillCandidate: (candidateId: string, action: SkillCandidateReviewAction) => void;
  readonly onCreateProtocolCandidate: (cluster: ProcedureObservationCluster) => void;
  readonly onCreatePlaybookCandidate: (cluster: ProcedureObservationCluster) => void;
  readonly onReviewPlaybookCandidate: (candidate: ChannelPlaybookCandidate, action: ChannelPlaybookCandidateReviewAction) => void;
  readonly t: SettingsTranslator;
}): JSX.Element {
  const partition = partitionSkillRegistry(skills);
  const pendingCount = skillCandidates.filter((candidate) => isOpenSkillCandidateStatus(candidate.status)).length +
    clusters.filter((cluster) => cluster.status === "ready_for_review").length +
    playbookCandidates.filter((candidate) => candidate.status === "draft").length;
  const generatedCount = partition.evolved.filter((skill) => skill.reviewStatus !== "archived").length +
    playbookCandidates.filter((candidate) => candidate.status === "active").length;
  const ignoredCount = skillCandidates.filter((candidate) => isTerminalSkillCandidateStatus(candidate.status) && candidate.status !== "published").length +
    clusters.filter((cluster) => cluster.status === "blocked" || cluster.status === "routed_elsewhere").length +
    playbookCandidates.filter((candidate) => candidate.status === "cancelled" || candidate.status === "stale").length;
  const activePlaybooks = playbookCandidates.filter((candidate) => candidate.status === "active");
  const viewControl = (
    <Select
      size="sm"
      containerClassName="settings-skill-evolution-view-select"
      value={view}
      onChange={(event) => {
        const nextView = event.currentTarget.value;
        onViewChange(nextView === "generated" || nextView === "ignored" ? nextView : "pending");
      }}
      aria-label={t("AI evolution views")}
    >
      <option value="pending">{t("Needs review")} ({pendingCount})</option>
      <option value="generated">{t("Generated")} ({generatedCount})</option>
      <option value="ignored">{t("Ignored")} ({ignoredCount})</option>
    </Select>
  );

  return (
    <div className="settings-skill-evolution-section" role="region" aria-label={t("AI evolution")}>
      {view === "generated" ? (
        <div className="settings-skill-evolution-content settings-skill-evolution-generated">
          <SkillLibraryRegistrySection
            mode="evolved"
            skills={skills}
            loading={loading}
            busyAction={busyAction}
            selectedSkillId={selectedSkillId}
            bindingSummaries={bindingSummaries}
            sourceSnapshotBySkillId={sourceSnapshotBySkillId}
            sourceHistoryBySkillId={sourceHistoryBySkillId}
            artifacts={artifacts}
            sourceArtifactsLoading={sourceArtifactsLoading}
            sourceError={sourceError}
            optimizationPreview={optimizationPreview}
            cwd={cwd}
            onSelectSkill={onSelectSkill}
            onArchiveSkill={onArchiveSkill}
            onDeleteSkill={onDeleteSkill}
            onEditSkill={onEditSkill}
            onPreviewOptimization={onPreviewOptimization}
            onArchiveSource={onArchiveSource}
            onRollbackSource={onRollbackSource}
            onImport={() => undefined}
            onNewDraft={() => undefined}
            toolbarAfterSearch={viewControl}
            t={t}
          />
          {activePlaybooks.length > 0 ? (
            <SkillReviewQueuePanel
              view="generated"
              skillCandidates={skillCandidates}
              clusters={clusters}
              playbookCandidates={playbookCandidates}
              channels={channels}
              loading={loading}
              busyAction={busyAction}
              error={reviewError}
              onAdoptSkillCandidate={onAdoptSkillCandidate}
              onReviewSkillCandidate={onReviewSkillCandidate}
              onCreateProtocolCandidate={onCreateProtocolCandidate}
              onCreatePlaybookCandidate={onCreatePlaybookCandidate}
              onReviewPlaybookCandidate={onReviewPlaybookCandidate}
              t={t}
            />
          ) : null}
        </div>
      ) : (
        <div className="settings-skill-evolution-content">
          <SkillReviewQueuePanel
            view={view}
            skillCandidates={skillCandidates}
            clusters={clusters}
            playbookCandidates={playbookCandidates}
            channels={channels}
            loading={loading}
            busyAction={busyAction}
            error={reviewError}
            onAdoptSkillCandidate={onAdoptSkillCandidate}
            onReviewSkillCandidate={onReviewSkillCandidate}
            onCreateProtocolCandidate={onCreateProtocolCandidate}
            onCreatePlaybookCandidate={onCreatePlaybookCandidate}
            onReviewPlaybookCandidate={onReviewPlaybookCandidate}
            toolbarAfterSearch={viewControl}
            t={t}
          />
        </div>
      )}
    </div>
  );
}
