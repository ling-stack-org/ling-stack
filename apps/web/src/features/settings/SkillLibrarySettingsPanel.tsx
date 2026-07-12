import { useEffect, useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";
import {
  archiveSkill,
  archiveSkillSourceSnapshot,
  hardDeleteSkill,
  checkGstackSkillSourceUpdates,
  createChannelPlaybookCandidateFromCluster,
  createChannelProtocolCandidateFromCluster,
  createSkillCandidateDraft,
  getSkillHealth,
  getSkillSourceHealth,
  getSkillSourceUpgradePolicy,
  listSkillSourceArtifacts,
  listChannelPlaybookCandidates,
  listChannels,
  listAiTeammates,
  listProcedureObservationClusters,
  listSkillCandidates,
  listSkills,
  listTeammateSkills,
  previewGstackSkillSourceSync,
  previewSkillOptimization,
  publishGstackSkillSourceSync,
  refreshGstackSkillSourceSync,
  reviewChannelPlaybookCandidate,
  reviewSkillCandidate,
  rollbackSkillSourceSnapshot,
  updateSkillSourceUpgradePolicy,
} from "../../api.js";
import { useI18n } from "../../i18n.js";
import type {
  Channel,
  ChannelPlaybookCandidate,
  ChannelPlaybookCandidateReviewAction,
  ProcedureObservationCluster,
  SkillCandidate,
  SkillCandidateReviewAction,
  SkillHealthReport,
  SkillOptimizationPreview,
  SkillRegistryEntry,
  SkillSourceArtifact,
  SkillSourceHealthReport,
  SkillSourceSnapshot,
  SkillSourceSyncPreviewRecord,
  SkillSourceSyncPreviewReport,
  SkillSourceSyncRequest,
  SkillSourceUpgradePolicy,
} from "../../types.js";
import {
  SkillHealthPanel,
  SkillSourceHealthPanel,
  SkillSourceSyncPanel,
  defaultSelectedSyncSkillIds,
  isOpenSkillCandidateStatus,
  isSelectableSyncRecord,
  playbookCandidateReviewMessage,
  playbookCandidateReviewReason,
  skillCandidateReviewMessage,
  skillCandidateReviewReason,
  type TeammateSkillBindingSummary,
} from "./SkillLibraryWidgets.js";
import { SkillImportDialog } from "./SkillImportDialog.js";
import { SkillLibraryNavigation } from "./SkillLibraryNavigation.js";
import { SkillLibraryRegistrySection } from "./SkillLibraryRegistrySection.js";
import { SkillReviewQueuePanel } from "./SkillReviewQueuePanels.js";
import {
  currentUserSkillCount,
  partitionSkillRegistry,
  type SkillLibrarySectionId,
} from "./skill-library-view-models.js";
import { useSkillImportController } from "./useSkillImportController.js";

export function SkillLibrarySettingsPanel({ cwd, refreshToken = 0 }: { readonly cwd: string; readonly refreshToken?: number }): JSX.Element {
  const { t } = useI18n();
  const [skills, setSkills] = useState<readonly SkillRegistryEntry[]>([]);
  const [skillHealth, setSkillHealth] = useState<SkillHealthReport | undefined>();
  const [skillSourceHealth, setSkillSourceHealth] = useState<SkillSourceHealthReport | undefined>();
  const [skillSourceSnapshots, setSkillSourceSnapshots] = useState<readonly SkillSourceSnapshot[]>([]);
  const [skillSourceUpgradePolicy, setSkillSourceUpgradePolicy] = useState<SkillSourceUpgradePolicy | undefined>();
  const [skillSourceArtifacts, setSkillSourceArtifacts] = useState<readonly SkillSourceArtifact[]>([]);
  const [skillOptimizationPreview, setSkillOptimizationPreview] = useState<SkillOptimizationPreview | undefined>();
  const [skillCandidates, setSkillCandidates] = useState<readonly SkillCandidate[]>([]);
  const [playbookCandidates, setPlaybookCandidates] = useState<readonly ChannelPlaybookCandidate[]>([]);
  const [channels, setChannels] = useState<readonly Channel[]>([]);
  const [observationClusters, setObservationClusters] = useState<readonly ProcedureObservationCluster[]>([]);
  const [bindingSummaries, setBindingSummaries] = useState<readonly TeammateSkillBindingSummary[]>([]);
  const [selectedSkillId, setSelectedSkillId] = useState("");
  const [activeSubsection, setActiveSubsection] = useState<SkillLibrarySectionId>("mine");
  const [syncRootPath, setSyncRootPath] = useState("");
  const [syncIncludeDetectedRoots, setSyncIncludeDetectedRoots] = useState(true);
  const [syncAllowNewSkills, setSyncAllowNewSkills] = useState(false);
  const [syncPreview, setSyncPreview] = useState<SkillSourceSyncPreviewReport | undefined>();
  const [selectedSyncSkillIds, setSelectedSyncSkillIds] = useState<readonly string[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [checkingSourceUpdates, setCheckingSourceUpdates] = useState(false);
  const [optimizationPreviewLoading, setOptimizationPreviewLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const skillImport = useSkillImportController({
    cwd,
    t,
    onPublished: async () => {
      await refresh();
      setActiveSubsection("mine");
      setSelectedSkillId("");
    },
  });

  useEffect(() => {
    void refresh();
  }, [cwd, refreshToken]);

  const sourceSnapshotBySkillId = useMemo(() => {
    return new Map(skillSourceSnapshots.filter((snapshot) => snapshot.reviewStatus === "published").map((snapshot) => [snapshot.skillId, snapshot]));
  }, [skillSourceSnapshots]);

  const sourceSnapshotHistoryBySkillId = useMemo(() => {
    const history = new Map<string, SkillSourceSnapshot[]>();
    for (const snapshot of skillSourceSnapshots.filter((item) => item.reviewStatus === "archived")) {
      history.set(snapshot.skillId, [...(history.get(snapshot.skillId) ?? []), snapshot]);
    }
    return history;
  }, [skillSourceSnapshots]);

  const ownershipPartition = useMemo(() => partitionSkillRegistry(skills), [skills]);

  const reviewQueueCount = useMemo(() => {
    const healthFindings = skillHealth?.findings.length ?? 0;
    const openSkillCandidates = skillCandidates.filter((candidate) => isOpenSkillCandidateStatus(candidate.status)).length;
    const reviewableClusters = observationClusters.filter((cluster) => cluster.status === "ready_for_review").length;
    const draftPlaybooks = playbookCandidates.filter((candidate) => candidate.status === "draft").length;
    return healthFindings + openSkillCandidates + reviewableClusters + draftPlaybooks;
  }, [observationClusters, playbookCandidates, skillCandidates, skillHealth]);

  const sourceAttentionCount = useMemo(() => {
    return (skillSourceHealth?.findings.length ?? 0) + (skillSourceHealth?.summary.missingSourceSnapshots ?? 0);
  }, [skillSourceHealth]);

  const selectedSkill = useMemo(() => {
    return selectedSkillId ? skills.find((entry) => entry.id === selectedSkillId) : undefined;
  }, [selectedSkillId, skills]);

  useEffect(() => {
    if (!selectedSkill && selectedSkillId) {
      setSelectedSkillId("");
    }
  }, [selectedSkill, selectedSkillId]);

  useEffect(() => {
    void loadSelectedSkillSourceArtifacts();
  }, [cwd, selectedSkill?.id, skillSourceSnapshots]);

  useEffect(() => {
    setSkillOptimizationPreview(undefined);
  }, [selectedSkill?.id]);

  async function refresh(): Promise<void> {
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd) {
      setError(t("Workspace path is required."));
      return;
    }
    setLoading(true);
    try {
      setError("");
      const [skillsResponse, skillHealthResponse, skillSourceHealthResponse, skillSourcePolicyResponse, clustersResponse, candidatesResponse, channelsResponse, teammatesResponse] = await Promise.all([
        listSkills(workspaceCwd),
        getSkillHealth(workspaceCwd, { limit: 6 }),
        getSkillSourceHealth(workspaceCwd, { limit: 6 }),
        getSkillSourceUpgradePolicy(workspaceCwd),
        listProcedureObservationClusters(workspaceCwd, { limit: 8 }),
        listSkillCandidates(workspaceCwd, { limit: 8 }),
        listChannels(workspaceCwd),
        listAiTeammates(workspaceCwd),
      ]);
      const visibleTeammates = teammatesResponse.teammates.filter((teammate) => teammate.status !== "disabled" && !teammate.hidden);
      const [teammateSkillResponses, playbookCandidateResponses] = await Promise.all([
        Promise.all(
          visibleTeammates.map(async (teammate) => ({
            teammate,
            bindings: (await listTeammateSkills(workspaceCwd, teammate.id)).bindings,
          })),
        ),
        Promise.all(channelsResponse.channels.map((channel) => listChannelPlaybookCandidates(workspaceCwd, channel.id, { limit: 8 }))),
      ]);
      setSkills(skillsResponse.skills);
      setSkillHealth(skillHealthResponse.report);
      setSkillSourceHealth(skillSourceHealthResponse.report);
      setSkillSourceSnapshots(skillSourceHealthResponse.snapshots);
      setSkillSourceUpgradePolicy(skillSourcePolicyResponse.policy);
      setObservationClusters(clustersResponse.clusters);
      setSkillCandidates(candidatesResponse.candidates);
      setPlaybookCandidates(playbookCandidateResponses.flatMap((response) => response.candidates));
      setChannels(channelsResponse.channels);
      setBindingSummaries(teammateSkillResponses);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }

  async function loadSelectedSkillSourceArtifacts(): Promise<void> {
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd || !selectedSkill?.id) {
      setSkillSourceArtifacts([]);
      return;
    }
    try {
      const response = await listSkillSourceArtifacts(workspaceCwd, selectedSkill.id);
      setSkillSourceArtifacts(response.artifacts);
    } catch {
      setSkillSourceArtifacts([]);
    }
  }

  function buildSkillSourceSyncRequest(): SkillSourceSyncRequest {
    const skillRoots = syncRootPath
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean);
    return {
      skillRoots: skillRoots.length > 0 ? skillRoots : undefined,
      includeDetectedRoots: syncIncludeDetectedRoots,
    };
  }

  async function previewSkillSourceSync(mode: "preview" | "refresh"): Promise<void> {
    if (syncing) {
      return;
    }
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd) {
      setError(t("Workspace path is required."));
      return;
    }
    if (!syncIncludeDetectedRoots && !syncRootPath.trim()) {
      setMessage(t("Add a skill root path or enable detected roots"));
      return;
    }
    setSyncing(true);
    try {
      setError("");
      const input = buildSkillSourceSyncRequest();
      const response = mode === "refresh"
        ? await refreshGstackSkillSourceSync(workspaceCwd, input)
        : await previewGstackSkillSourceSync(workspaceCwd, input);
      setSyncPreview(response.preview);
      setSelectedSyncSkillIds(defaultSelectedSyncSkillIds(response.preview.records, syncAllowNewSkills));
      setMessage(mode === "refresh" ? t("Source scan refreshed") : t("Source preview ready"));
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : String(syncError));
    } finally {
      setSyncing(false);
    }
  }

  async function checkSkillSourceUpdates(): Promise<void> {
    if (checkingSourceUpdates || syncing) {
      return;
    }
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd) {
      setError(t("Workspace path is required."));
      return;
    }
    setCheckingSourceUpdates(true);
    try {
      setError("");
      const response = await checkGstackSkillSourceUpdates(workspaceCwd, buildSkillSourceSyncRequest());
      setSkillSourceUpgradePolicy(response.policy);
      setSyncPreview(response.preview);
      setSelectedSyncSkillIds(defaultSelectedSyncSkillIds(response.preview.records, syncAllowNewSkills));
      setActiveSubsection("source");
      setMessage(t("Source update check complete"));
    } catch (checkError) {
      setError(checkError instanceof Error ? checkError.message : String(checkError));
    } finally {
      setCheckingSourceUpdates(false);
    }
  }

  async function changeSkillSourceUpgradeMode(mode: SkillSourceUpgradePolicy["mode"]): Promise<void> {
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd || !skillSourceUpgradePolicy) {
      return;
    }
    setSaving(true);
    try {
      setError("");
      const response = await updateSkillSourceUpgradePolicy(workspaceCwd, {
        mode,
        approvedRootIds: skillSourceUpgradePolicy.approvedRootIds,
        allowNewSkills: skillSourceUpgradePolicy.allowNewSkills,
      });
      setSkillSourceUpgradePolicy(response.policy);
      setMessage(t("Source upgrade policy updated"));
    } catch (policyError) {
      setError(policyError instanceof Error ? policyError.message : String(policyError));
    } finally {
      setSaving(false);
    }
  }

  async function publishSkillSourceSync(): Promise<void> {
    if (syncing || selectedSyncSkillIds.length === 0) {
      setMessage(t("Select skill source records first"));
      return;
    }
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd) {
      setError(t("Workspace path is required."));
      return;
    }
    setSyncing(true);
    try {
      setError("");
      const response = await publishGstackSkillSourceSync(workspaceCwd, {
        ...buildSkillSourceSyncRequest(),
        selectedSkillIds: selectedSyncSkillIds,
        allowNewSkills: syncAllowNewSkills,
        publishArtifacts: true,
      });
      setSyncPreview(response.preview);
      setSelectedSyncSkillIds([]);
      await refresh();
      setActiveSubsection("source");
      setMessage(t("Published {count} skill sources", { count: response.snapshots.length }));
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : String(syncError));
    } finally {
      setSyncing(false);
    }
  }

  async function rollbackSelectedSkillSource(snapshotId: string): Promise<void> {
    if (!selectedSkill?.id || saving) {
      return;
    }
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd) {
      setError(t("Workspace path is required."));
      return;
    }
    setSaving(true);
    try {
      setError("");
      await rollbackSkillSourceSnapshot(workspaceCwd, selectedSkill.id, { snapshotId });
      await refresh();
      setMessage(t("Source snapshot rolled back"));
    } catch (rollbackError) {
      setError(rollbackError instanceof Error ? rollbackError.message : String(rollbackError));
    } finally {
      setSaving(false);
    }
  }

  async function previewSelectedSkillOptimization(): Promise<void> {
    if (!selectedSkill?.id || optimizationPreviewLoading) {
      return;
    }
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd) {
      setError(t("Workspace path is required."));
      return;
    }
    setOptimizationPreviewLoading(true);
    try {
      setError("");
      const response = await previewSkillOptimization(workspaceCwd, selectedSkill.id, { mode: "preview_on_demand" });
      setSkillOptimizationPreview(response.preview);
      setMessage(t("Optimization preview ready"));
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : String(previewError));
    } finally {
      setOptimizationPreviewLoading(false);
    }
  }

  function toggleSyncSkillId(record: SkillSourceSyncPreviewRecord): void {
    if (!isSelectableSyncRecord(record, syncAllowNewSkills)) {
      return;
    }
    setSelectedSyncSkillIds((current) => current.includes(record.skillId)
      ? current.filter((skillId) => skillId !== record.skillId)
      : [...current, record.skillId]);
  }

  async function reviewCandidate(candidateId: string, action: SkillCandidateReviewAction): Promise<void> {
    if (saving) {
      return;
    }
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd) {
      setError(t("Workspace path is required."));
      return;
    }
    setSaving(true);
    try {
      setError("");
      const response = await reviewSkillCandidate(workspaceCwd, candidateId, {
        action,
        reason: skillCandidateReviewReason(action, t),
      });
      setSkillCandidates((current) => current.map((candidate) => candidate.id === candidateId ? response.candidate : candidate));
      await refresh();
      setMessage(skillCandidateReviewMessage(action, t));
    } catch (reviewError) {
      setError(reviewError instanceof Error ? reviewError.message : String(reviewError));
    } finally {
      setSaving(false);
    }
  }

  async function createDraftFromCandidate(candidateId: string): Promise<void> {
    if (saving) {
      return;
    }
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd) {
      setError(t("Workspace path is required."));
      return;
    }
    setSaving(true);
    try {
      setError("");
      const response = await createSkillCandidateDraft(workspaceCwd, candidateId);
      skillImport.openExistingDraft(response.draft, response.contextFindings ?? []);
    } catch (draftError) {
      setError(draftError instanceof Error ? draftError.message : String(draftError));
    } finally {
      setSaving(false);
    }
  }

  async function createProtocolCandidateFromCluster(cluster: ProcedureObservationCluster): Promise<void> {
    if (saving) {
      return;
    }
    if (!cluster.channelId) {
      setError(t("Candidate cluster is not bound to a channel."));
      return;
    }
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd) {
      setError(t("Workspace path is required."));
      return;
    }
    setSaving(true);
    try {
      setError("");
      await createChannelProtocolCandidateFromCluster(workspaceCwd, cluster.channelId, cluster.id);
      await refresh();
      setMessage(t("Protocol candidate created"));
    } catch (draftError) {
      setError(draftError instanceof Error ? draftError.message : String(draftError));
    } finally {
      setSaving(false);
    }
  }

  async function createPlaybookCandidateFromCluster(cluster: ProcedureObservationCluster): Promise<void> {
    if (saving) {
      return;
    }
    if (!cluster.channelId) {
      setError(t("Candidate cluster is not bound to a channel."));
      return;
    }
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd) {
      setError(t("Workspace path is required."));
      return;
    }
    setSaving(true);
    try {
      setError("");
      await createChannelPlaybookCandidateFromCluster(workspaceCwd, cluster.channelId, cluster.id);
      await refresh();
      setMessage(t("Playbook candidate created"));
    } catch (draftError) {
      setError(draftError instanceof Error ? draftError.message : String(draftError));
    } finally {
      setSaving(false);
    }
  }

  async function reviewPlaybookCandidate(candidate: ChannelPlaybookCandidate, action: ChannelPlaybookCandidateReviewAction): Promise<void> {
    if (saving) {
      return;
    }
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd) {
      setError(t("Workspace path is required."));
      return;
    }
    setSaving(true);
    try {
      setError("");
      const response = await reviewChannelPlaybookCandidate(workspaceCwd, candidate.channelId, candidate.id, {
        action,
        reason: playbookCandidateReviewReason(action, t),
      });
      setPlaybookCandidates((current) => current.map((item) => item.id === candidate.id ? response.candidate : item));
      await refresh();
      setMessage(playbookCandidateReviewMessage(action, t));
    } catch (reviewError) {
      setError(reviewError instanceof Error ? reviewError.message : String(reviewError));
    } finally {
      setSaving(false);
    }
  }

  async function archiveRegistrySkill(skillId: string): Promise<void> {
    if (saving) {
      return;
    }
    setSaving(true);
    try {
      setError("");
      await archiveSkill(cwd.trim(), skillId);
      await refresh();
      setMessage(t("Skill archived"));
    } catch (archiveError) {
      setError(archiveError instanceof Error ? archiveError.message : String(archiveError));
    } finally {
      setSaving(false);
    }
  }

  async function hardDeleteRegistrySkill(skill: SkillRegistryEntry): Promise<void> {
    if (saving) {
      return;
    }
    const confirmation = [
      t("Delete skill {name}?", { name: skill.definition.name }),
      t("This cannot be undone. Remove teammate bindings and active work references before deleting this skill."),
    ].join("\n");
    if (!window.confirm(confirmation)) {
      return;
    }
    setSaving(true);
    try {
      setError("");
      await hardDeleteSkill(cwd.trim(), skill.id);
      setSelectedSkillId((current) => current === skill.id ? "" : current);
      await refresh();
      setMessage(t("Skill deleted"));
    } catch (deleteError) {
      setError(hardDeleteSkillErrorMessage(deleteError, t));
    } finally {
      setSaving(false);
    }
  }

  async function archiveSourceSnapshot(skillId: string): Promise<void> {
    if (saving) {
      return;
    }
    setSaving(true);
    try {
      setError("");
      await archiveSkillSourceSnapshot(cwd.trim(), skillId);
      await refresh();
      setMessage(t("Source snapshot archived"));
    } catch (archiveError) {
      setError(archiveError instanceof Error ? archiveError.message : String(archiveError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section
      className={activeSubsection === "mine" || activeSubsection === "builtin" ? "settings-skill-library settings-skill-library--skills" : "settings-skill-library"}
      aria-label={t("Skill library")}
    >
      <SkillLibraryNavigation
        activeSection={activeSubsection}
        currentUserCount={currentUserSkillCount(skills)}
        builtinCount={ownershipPartition.builtin.length}
        reviewCount={reviewQueueCount}
        sourceAttentionCount={sourceAttentionCount}
        onSectionChange={(section) => {
          setActiveSubsection(section);
          setSelectedSkillId("");
        }}
      />

      {error ? <div className="inline-error">{error}</div> : null}
      {skillImport.notice ? <div className="settings-inline-tip" role="status" aria-live="polite">{skillImport.notice}</div> : null}

      {activeSubsection === "mine" && reviewQueueCount > 0 ? (
        <div className="settings-skill-attention-line">
          <button type="button" className="ghost-button compact-button" onClick={() => {
            setActiveSubsection("review");
            setSelectedSkillId("");
          }}>
            <AlertTriangle size={14} />
            {t("{count} skill review items", { count: reviewQueueCount })}
          </button>
        </div>
      ) : null}

      {skillImport.open ? (
        <SkillImportDialog
          mode={skillImport.mode}
          form={skillImport.form}
          preview={skillImport.preview}
          contextFindings={skillImport.contextFindings}
          busy={skillImport.busy}
          error={skillImport.error}
          blockingIssues={skillImport.blockingIssues}
          onClose={skillImport.closeImport}
          onContentChange={skillImport.updateContent}
          onLoadFile={(file) => void skillImport.loadFile(file)}
          onCheck={() => void skillImport.checkContent()}
          onImport={() => void skillImport.importFile()}
          onPublish={() => void skillImport.publish()}
          t={t}
        />
      ) : null}

      {activeSubsection === "review" ? (
        <div className="settings-skill-review-stack">
          <details className="settings-compact-details settings-skill-review-diagnostics">
            <summary>{t("Skill health diagnostics")}</summary>
            <SkillHealthPanel report={skillHealth} loading={loading} t={t} />
          </details>
          <SkillReviewQueuePanel
            skillCandidates={skillCandidates}
            clusters={observationClusters}
            playbookCandidates={playbookCandidates}
            channels={channels}
            loading={loading}
            saving={saving}
            onReviewSkillCandidate={(candidateId, action) => void reviewCandidate(candidateId, action)}
            onCreateDraft={(candidateId) => void createDraftFromCandidate(candidateId)}
            onCreateProtocolCandidate={(cluster) => void createProtocolCandidateFromCluster(cluster)}
            onCreatePlaybookCandidate={(cluster) => void createPlaybookCandidateFromCluster(cluster)}
            onReviewPlaybookCandidate={(candidate, action) => void reviewPlaybookCandidate(candidate, action)}
            t={t}
          />
        </div>
      ) : null}

      {activeSubsection === "source" ? (
        <div className="settings-skill-source-stack">
          <SkillSourceSyncPanel
            preview={syncPreview}
            policy={skillSourceUpgradePolicy}
            rootPath={syncRootPath}
            includeDetectedRoots={syncIncludeDetectedRoots}
            allowNewSkills={syncAllowNewSkills}
            selectedSkillIds={selectedSyncSkillIds}
            loading={loading}
            syncing={syncing || checkingSourceUpdates}
            onRootPathChange={setSyncRootPath}
            onIncludeDetectedRootsChange={setSyncIncludeDetectedRoots}
            onAllowNewSkillsChange={(allow) => {
              setSyncAllowNewSkills(allow);
              if (!allow && syncPreview) {
                const newSkillIds = new Set(syncPreview.records.filter((record) => record.state === "new").map((record) => record.skillId));
                setSelectedSyncSkillIds((current) => current.filter((skillId) => !newSkillIds.has(skillId)));
              }
            }}
            onPreview={() => void previewSkillSourceSync("preview")}
            onRefresh={() => void previewSkillSourceSync("refresh")}
            onCheckUpdates={() => void checkSkillSourceUpdates()}
            onPolicyModeChange={(mode) => void changeSkillSourceUpgradeMode(mode)}
            onPublish={() => void publishSkillSourceSync()}
            onToggleRecord={toggleSyncSkillId}
            t={t}
          />
          <details className="settings-compact-details settings-skill-review-diagnostics settings-skill-source-diagnostics">
            <summary>{t("Skill source health diagnostics")}</summary>
            <SkillSourceHealthPanel report={skillSourceHealth} snapshots={skillSourceSnapshots} loading={loading} t={t} />
          </details>
        </div>
      ) : null}

      {activeSubsection === "mine" || activeSubsection === "builtin" ? (
        <SkillLibraryRegistrySection
          mode={activeSubsection === "mine" ? "user" : "builtin"}
          skills={skills}
          loading={loading}
          saving={saving}
          selectedSkillId={selectedSkill?.id}
          bindingSummaries={bindingSummaries}
          sourceSnapshotBySkillId={sourceSnapshotBySkillId}
          sourceHistoryBySkillId={sourceSnapshotHistoryBySkillId}
          artifacts={skillSourceArtifacts}
          optimizationPreview={skillOptimizationPreview}
          optimizationPreviewLoading={optimizationPreviewLoading}
          cwd={cwd.trim()}
          onSelectSkill={setSelectedSkillId}
          onArchiveSkill={(skillId) => void archiveRegistrySkill(skillId)}
          onDeleteSkill={(skill) => void hardDeleteRegistrySkill(skill)}
          onPreviewOptimization={() => void previewSelectedSkillOptimization()}
          onArchiveSource={(skillId) => void archiveSourceSnapshot(skillId)}
          onRollbackSource={(snapshotId) => void rollbackSelectedSkillSource(snapshotId)}
          onImport={skillImport.openImport}
          onNewDraft={skillImport.openDraft}
          t={t}
        />
      ) : null}

      {message ? (
        <footer className="settings-skill-audit-note">
          <span>{message}</span>
        </footer>
      ) : null}
    </section>
  );
}

function hardDeleteSkillErrorMessage(error: unknown, t: (key: string) => string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("skill_delete_not_imported")) {
    return t("Only manually imported skills can be deleted.");
  }
  if (message.includes("skill_delete_blocked")) {
    return t("This skill is still in use. Remove its teammate bindings or active work references first.");
  }
  return message;
}
