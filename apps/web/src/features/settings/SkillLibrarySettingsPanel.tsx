import { useEffect, useMemo, useState } from "react";
import {
  archiveSkill,
  archiveSkillSourceSnapshot,
  createChannelPlaybookCandidateFromCluster,
  createChannelProtocolCandidateFromCluster,
  createSkillCandidateDraft,
  getSkillSourceHealth,
  hardDeleteSkill,
  listChannelPlaybookCandidates,
  listChannels,
  listAiTeammates,
  listProcedureObservationClusters,
  listSkillCandidates,
  listSkillSourceArtifacts,
  listSkills,
  listTeammateSkills,
  previewSkillOptimization,
  reviewChannelPlaybookCandidate,
  reviewSkillCandidate,
  rollbackSkillSourceSnapshot,
} from "../../api.js";
import { useI18n } from "../../i18n.js";
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
import { SkillImportDialog } from "./SkillImportDialog.js";
import { SkillEditorDialog } from "./SkillEditorDialog.js";
import { SkillEvolutionSection } from "./SkillEvolutionSection.js";
import { SkillLibraryNavigation } from "./SkillLibraryNavigation.js";
import { SkillLibraryRegistrySection } from "./SkillLibraryRegistrySection.js";
import {
  playbookCandidateReviewMessage,
  playbookCandidateReviewReason,
  skillCandidateReviewMessage,
  skillCandidateReviewReason,
  type TeammateSkillBindingSummary,
} from "./SkillLibraryWidgets.js";
import {
  currentUserSkillCount,
  partitionSkillRegistry,
  type SkillEvolutionViewId,
  type SkillLibrarySectionId,
} from "./skill-library-view-models.js";
import { useSkillImportController } from "./useSkillImportController.js";
import { useSkillEditorController } from "./useSkillEditorController.js";

export function SkillLibrarySettingsPanel({ cwd, refreshToken = 0 }: { readonly cwd: string; readonly refreshToken?: number }): JSX.Element {
  const { t } = useI18n();
  const [skills, setSkills] = useState<readonly SkillRegistryEntry[]>([]);
  const [skillSourceSnapshots, setSkillSourceSnapshots] = useState<readonly SkillSourceSnapshot[]>([]);
  const [skillSourceArtifacts, setSkillSourceArtifacts] = useState<readonly SkillSourceArtifact[]>([]);
  const [skillOptimizationPreview, setSkillOptimizationPreview] = useState<SkillOptimizationPreview | undefined>();
  const [skillCandidates, setSkillCandidates] = useState<readonly SkillCandidate[]>([]);
  const [playbookCandidates, setPlaybookCandidates] = useState<readonly ChannelPlaybookCandidate[]>([]);
  const [channels, setChannels] = useState<readonly Channel[]>([]);
  const [observationClusters, setObservationClusters] = useState<readonly ProcedureObservationCluster[]>([]);
  const [bindingSummaries, setBindingSummaries] = useState<readonly TeammateSkillBindingSummary[]>([]);
  const [selectedSkillId, setSelectedSkillId] = useState("");
  const [activeSubsection, setActiveSubsection] = useState<SkillLibrarySectionId>("mine");
  const [evolutionView, setEvolutionView] = useState<SkillEvolutionViewId>("pending");
  const [optimizationPreviewLoading, setOptimizationPreviewLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const skillImport = useSkillImportController({
    cwd,
    t,
    onPublished: async (publishedSkills) => {
      await refresh();
      setActiveSubsection("mine");
      setSelectedSkillId(publishedSkills[0]?.id ?? "");
    },
  });
  const skillEditor = useSkillEditorController({
    cwd,
    t,
    onCompleted: async ({ skills: completedSkills, candidateId, mode }) => {
      await refresh();
      if (candidateId || mode === "candidate") {
        setActiveSubsection("evolution");
        setEvolutionView("generated");
        setSelectedSkillId(completedSkills[0]?.id ?? "");
        return;
      }
      if (mode === "revision" && completedSkills[0]) {
        setSelectedSkillId(completedSkills[0].id);
        return;
      }
      setActiveSubsection("mine");
      setSelectedSkillId(completedSkills[0]?.id ?? "");
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
  const evolutionCount = useMemo(() => {
    const managedSkillCandidates = skillCandidates.filter((candidate) => candidate.status !== "published").length;
    const managedClusters = observationClusters.filter((cluster) => cluster.status !== "collecting").length;
    return ownershipPartition.evolved.filter((skill) => skill.reviewStatus !== "archived").length +
      managedSkillCandidates + managedClusters + playbookCandidates.length;
  }, [observationClusters, ownershipPartition.evolved, playbookCandidates, skillCandidates]);
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
      const [skillsResponse, skillSourceHealthResponse, clustersResponse, candidatesResponse, channelsResponse, teammatesResponse] = await Promise.all([
        listSkills(workspaceCwd),
        getSkillSourceHealth(workspaceCwd, { limit: 100 }),
        listProcedureObservationClusters(workspaceCwd, { limit: 100 }),
        listSkillCandidates(workspaceCwd, { limit: 100 }),
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
        Promise.all(channelsResponse.channels.map((channel) => listChannelPlaybookCandidates(workspaceCwd, channel.id, { limit: 100 }))),
      ]);
      setSkills(skillsResponse.skills);
      setSkillSourceSnapshots(skillSourceHealthResponse.snapshots);
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

  async function reloadSkillEditorRevision(): Promise<void> {
    const skillId = skillEditor.skill?.id;
    if (!skillId) return;
    try {
      const response = await listSkills(cwd.trim());
      setSkills(response.skills);
      const latest = response.skills.find((entry) => entry.id === skillId);
      if (!latest) {
        setError(t("Skill not found."));
        return;
      }
      skillEditor.reloadRevision(latest);
    } catch (reloadError) {
      setError(reloadError instanceof Error ? reloadError.message : String(reloadError));
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
      if (action === "reject") {
        setEvolutionView("ignored");
      }
      setMessage(skillCandidateReviewMessage(action, t));
    } catch (reviewError) {
      setError(reviewError instanceof Error ? reviewError.message : String(reviewError));
    } finally {
      setSaving(false);
    }
  }

  async function adoptCandidate(candidateId: string): Promise<void> {
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
      const candidate = skillCandidates.find((item) => item.id === candidateId);
      if (!candidate) {
        throw new Error(t("Skill candidate not found."));
      }
      if (candidate.status !== "approved_for_draft") {
        const review = await reviewSkillCandidate(workspaceCwd, candidateId, {
          action: "approve_for_draft",
          reason: skillCandidateReviewReason("approve_for_draft", t),
        });
        setSkillCandidates((current) => current.map((item) => item.id === candidateId ? review.candidate : item));
      }
      const response = await createSkillCandidateDraft(workspaceCwd, candidateId);
      skillEditor.openCandidate(response.draft, candidateId);
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

  async function reviewPlaybook(candidate: ChannelPlaybookCandidate, action: ChannelPlaybookCandidateReviewAction): Promise<void> {
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
      if (action === "reject") {
        setEvolutionView("ignored");
      } else if (action === "approve") {
        setEvolutionView("generated");
      }
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
      className={activeSubsection === "evolution"
        ? "settings-skill-library settings-skill-library--evolution"
        : "settings-skill-library settings-skill-library--skills"}
      aria-label={t("Skill library")}
    >
      <SkillLibraryNavigation
        activeSection={activeSubsection}
        currentUserCount={currentUserSkillCount(skills)}
        evolutionCount={evolutionCount}
        builtinCount={ownershipPartition.builtin.length}
        onSectionChange={(section) => {
          setActiveSubsection(section);
          setSelectedSkillId("");
        }}
      />

      {error ? <div className="inline-error">{error}</div> : null}
      {skillImport.notice ? <div className="settings-inline-tip" role="status" aria-live="polite">{skillImport.notice}</div> : null}
      {skillEditor.notice ? <div className="settings-inline-tip" role="status" aria-live="polite">{skillEditor.notice}</div> : null}

      {skillImport.open ? (
        <SkillImportDialog
          form={skillImport.form}
          busy={skillImport.busy}
          error={skillImport.error}
          blockingIssues={skillImport.blockingIssues}
          onClose={skillImport.closeImport}
          onLoadFile={(file) => void skillImport.loadFile(file)}
          onImport={() => void skillImport.importFile()}
          t={t}
        />
      ) : null}

      {skillEditor.open ? (
        <SkillEditorDialog
          mode={skillEditor.mode}
          sourceKind={skillEditor.sourceKind}
          form={skillEditor.form}
          dirty={skillEditor.dirty}
          busy={skillEditor.busy}
          error={skillEditor.error}
          conflict={skillEditor.conflict}
          preview={skillEditor.preview}
          authorityConfirmation={skillEditor.authorityConfirmation}
          discardConfirmation={skillEditor.discardConfirmation}
          onFormChange={skillEditor.setForm}
          onClose={skillEditor.requestClose}
          onDiscard={skillEditor.discardChanges}
          onContinueEditing={skillEditor.continueEditing}
          onSave={() => void skillEditor.save()}
          onConfirmAuthorityChanges={() => void skillEditor.confirmAuthorityChanges()}
          onReload={() => void reloadSkillEditorRevision()}
          t={t}
        />
      ) : null}

      {activeSubsection === "evolution" ? (
        <SkillEvolutionSection
          view={evolutionView}
          skills={skills}
          skillCandidates={skillCandidates}
          clusters={observationClusters}
          playbookCandidates={playbookCandidates}
          channels={channels}
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
          onViewChange={(view) => {
            setEvolutionView(view);
            setSelectedSkillId("");
          }}
          onSelectSkill={setSelectedSkillId}
          onArchiveSkill={(skillId) => void archiveRegistrySkill(skillId)}
          onDeleteSkill={(skill) => void hardDeleteRegistrySkill(skill)}
          onEditSkill={skillEditor.openRevision}
          onPreviewOptimization={() => void previewSelectedSkillOptimization()}
          onArchiveSource={(skillId) => void archiveSourceSnapshot(skillId)}
          onRollbackSource={(snapshotId) => void rollbackSelectedSkillSource(snapshotId)}
          onAdoptSkillCandidate={(candidateId) => void adoptCandidate(candidateId)}
          onReviewSkillCandidate={(candidateId, action) => void reviewCandidate(candidateId, action)}
          onCreateProtocolCandidate={(cluster) => void createProtocolCandidateFromCluster(cluster)}
          onCreatePlaybookCandidate={(cluster) => void createPlaybookCandidateFromCluster(cluster)}
          onReviewPlaybookCandidate={(candidate, action) => void reviewPlaybook(candidate, action)}
          t={t}
        />
      ) : (
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
          onEditSkill={skillEditor.openRevision}
          onPreviewOptimization={() => void previewSelectedSkillOptimization()}
          onArchiveSource={(skillId) => void archiveSourceSnapshot(skillId)}
          onRollbackSource={(snapshotId) => void rollbackSelectedSkillSource(snapshotId)}
          onImport={skillImport.openImport}
          onNewDraft={skillEditor.openCreate}
          t={t}
        />
      )}

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
