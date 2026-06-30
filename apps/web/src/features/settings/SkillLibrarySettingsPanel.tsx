import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Archive,
  BookOpen,
  CheckCircle2,
  Eye,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Upload,
} from "lucide-react";
import {
  archiveSkill,
  archiveSkillSourceSnapshot,
  checkGstackSkillSourceUpdates,
  createChannelPlaybookCandidateFromCluster,
  createChannelProtocolCandidateFromCluster,
  createSkillCandidateDraft,
  createSkillImportDraft,
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
  publishGstackSkillSourceSync,
  publishSkillImportDraft,
  refreshGstackSkillSourceSync,
  reviewChannelPlaybookCandidate,
  reviewSkillCandidate,
  rollbackSkillSourceSnapshot,
  updateSkillSourceUpgradePolicy,
} from "../../api.js";
import { useI18n } from "../../i18n.js";
import { formatDateTime } from "../../lib/formatting.js";
import type {
  Channel,
  ChannelPlaybookCandidate,
  ChannelPlaybookCandidateReviewAction,
  ProcedureObservationCluster,
  SkillCandidate,
  SkillCandidateReviewAction,
  SkillHealthReport,
  SkillImportDraft,
  SkillPackSource,
  SkillRegistryEntry,
  SkillSourceArtifact,
  SkillSourceHealthReport,
  SkillSourceSnapshot,
  SkillSourceSyncPreviewRecord,
  SkillSourceSyncPreviewReport,
  SkillSourceSyncRequest,
  SkillSourceUpgradePolicy,
} from "../../types.js";
import { approvalProfileText, workflowPhaseLabel } from "../teammates/helpers.js";
import {
  PlaybookCandidateReviewPanel,
  ProcedureObservationClusterPanel,
  SkillCandidateReviewPanel,
  SkillHealthPanel,
  SkillInspectorSection,
  SkillSourceHealthPanel,
  SkillSourceInspector,
  SkillSourceStatus,
  SkillSourceSyncPanel,
  SkillStatePill,
  SkillTokenList,
  boundTeammateNames,
  defaultSelectedSyncSkillIds,
  isOpenSkillCandidateStatus,
  isSelectableSyncRecord,
  playbookCandidateReviewMessage,
  playbookCandidateReviewReason,
  skillCandidateReviewMessage,
  skillCandidateReviewReason,
  skillLibraryFilterLabel,
  skillRegistryState,
  type SkillLibraryFilter,
  type TeammateSkillBindingSummary,
} from "./SkillLibraryWidgets.js";
import { SettingsSubnav } from "./SettingsSubnav.js";

type SkillLibrarySubsectionId = "skills" | "review" | "source";

interface SkillImportForm {
  readonly name: string;
  readonly sourcePath: string;
  readonly source: SkillPackSource;
  readonly content: string;
}

const initialSkillImportForm: SkillImportForm = {
  name: "",
  sourcePath: "",
  source: "custom",
  content: "",
};

export function SkillLibrarySettingsPanel({ cwd, refreshToken = 0 }: { readonly cwd: string; readonly refreshToken?: number }): JSX.Element {
  const { t } = useI18n();
  const [skills, setSkills] = useState<readonly SkillRegistryEntry[]>([]);
  const [skillHealth, setSkillHealth] = useState<SkillHealthReport | undefined>();
  const [skillSourceHealth, setSkillSourceHealth] = useState<SkillSourceHealthReport | undefined>();
  const [skillSourceSnapshots, setSkillSourceSnapshots] = useState<readonly SkillSourceSnapshot[]>([]);
  const [skillSourceUpgradePolicy, setSkillSourceUpgradePolicy] = useState<SkillSourceUpgradePolicy | undefined>();
  const [skillSourceArtifacts, setSkillSourceArtifacts] = useState<readonly SkillSourceArtifact[]>([]);
  const [skillCandidates, setSkillCandidates] = useState<readonly SkillCandidate[]>([]);
  const [playbookCandidates, setPlaybookCandidates] = useState<readonly ChannelPlaybookCandidate[]>([]);
  const [channels, setChannels] = useState<readonly Channel[]>([]);
  const [observationClusters, setObservationClusters] = useState<readonly ProcedureObservationCluster[]>([]);
  const [bindingSummaries, setBindingSummaries] = useState<readonly TeammateSkillBindingSummary[]>([]);
  const [selectedSkillId, setSelectedSkillId] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [filter, setFilter] = useState<SkillLibraryFilter>("all");
  const [sortMode, setSortMode] = useState<"updated" | "name">("updated");
  const [importOpen, setImportOpen] = useState(false);
  const [importForm, setImportForm] = useState<SkillImportForm>(initialSkillImportForm);
  const [importDraft, setImportDraft] = useState<SkillImportDraft | undefined>();
  const [activeSubsection, setActiveSubsection] = useState<SkillLibrarySubsectionId>("skills");
  const [syncRootPath, setSyncRootPath] = useState("");
  const [syncIncludeDetectedRoots, setSyncIncludeDetectedRoots] = useState(true);
  const [syncAllowNewSkills, setSyncAllowNewSkills] = useState(false);
  const [syncPreview, setSyncPreview] = useState<SkillSourceSyncPreviewReport | undefined>();
  const [selectedSyncSkillIds, setSelectedSyncSkillIds] = useState<readonly string[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [checkingSourceUpdates, setCheckingSourceUpdates] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

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

  const stats = useMemo(() => {
    const bindable = skills.filter((entry) => entry.reviewStatus === "builtin" || entry.reviewStatus === "published").length;
    const draft = skills.filter((entry) => entry.reviewStatus === "draft").length;
    const blocked = skills.filter((entry) => entry.reviewStatus === "disabled").length;
    return {
      total: skills.length,
      bindable,
      draft,
      blocked,
      sourceBacked: skillSourceHealth?.summary.sourceBackedSkills ?? skillSourceSnapshots.length,
      missingSource: skillSourceHealth?.summary.missingSourceSnapshots ?? 0,
    };
  }, [skillSourceHealth, skillSourceSnapshots.length, skills]);

  const reviewQueueCount = useMemo(() => {
    const healthFindings = skillHealth?.findings.length ?? 0;
    const openSkillCandidates = skillCandidates.filter((candidate) => isOpenSkillCandidateStatus(candidate.status)).length;
    const reviewableClusters = observationClusters.filter((cluster) => cluster.status === "ready_for_review").length;
    const draftPlaybooks = playbookCandidates.filter((candidate) => candidate.status === "draft").length;
    return healthFindings + openSkillCandidates + reviewableClusters + draftPlaybooks;
  }, [observationClusters, playbookCandidates, skillCandidates, skillHealth]);

  const sourceAttentionCount = useMemo(() => {
    return (skillSourceHealth?.findings.length ?? 0) + stats.missingSource;
  }, [skillSourceHealth, stats.missingSource]);

  const filteredSkills = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const rows = skills.filter((entry) => {
      if (filter === "builtin" && entry.source !== "builtin" && entry.reviewStatus !== "builtin") {
        return false;
      }
      if (filter === "custom" && (entry.source === "builtin" || entry.reviewStatus === "builtin")) {
        return false;
      }
      if (filter === "draft" && entry.reviewStatus !== "draft") {
        return false;
      }
      if (filter === "archived" && entry.reviewStatus !== "archived") {
        return false;
      }
      if (!query) {
        return true;
      }
      const haystack = [
        entry.id,
        entry.definition.name,
        entry.definition.summary,
        entry.source,
        entry.sourcePath ?? "",
        sourceSnapshotBySkillId.get(entry.id)?.sourcePath ?? "",
        sourceSnapshotBySkillId.get(entry.id)?.upstreamSkillPath ?? "",
        sourceSnapshotBySkillId.get(entry.id)?.sourceChecksum ?? "",
        entry.definition.workflowPhase,
        ...entry.definition.requiredTools,
        ...entry.definition.requiredProviderCapabilities,
      ].join(" ").toLowerCase();
      return haystack.includes(query);
    });
    return [...rows].sort((left, right) => {
      if (sortMode === "name") {
        return left.definition.name.localeCompare(right.definition.name);
      }
      return right.updatedAt.localeCompare(left.updatedAt);
    });
  }, [filter, searchQuery, skills, sortMode, sourceSnapshotBySkillId]);

  const selectedSkill = useMemo(() => {
    return skills.find((entry) => entry.id === selectedSkillId) ?? filteredSkills[0] ?? skills[0];
  }, [filteredSkills, selectedSkillId, skills]);

  useEffect(() => {
    if (!selectedSkill && selectedSkillId) {
      setSelectedSkillId("");
      return;
    }
    if (selectedSkill && selectedSkill.id !== selectedSkillId) {
      setSelectedSkillId(selectedSkill.id);
    }
  }, [selectedSkill, selectedSkillId]);

  useEffect(() => {
    void loadSelectedSkillSourceArtifacts();
  }, [cwd, selectedSkill?.id, skillSourceSnapshots]);

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
      setMessage(t("Skill library refreshed"));
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

  async function previewImportDraft(): Promise<void> {
    if (!importForm.content.trim() || saving) {
      setMessage(t("Paste skill content first"));
      return;
    }
    setSaving(true);
    try {
      setError("");
      setMessage("");
      const response = await createSkillImportDraft(cwd.trim(), {
        content: importForm.content,
        source: importForm.source,
        sourcePath: importForm.sourcePath.trim() || undefined,
        name: importForm.name.trim() || undefined,
      });
      setImportDraft(response.draft);
      setMessage(t("Draft ready"));
    } catch (draftError) {
      setError(draftError instanceof Error ? draftError.message : String(draftError));
    } finally {
      setSaving(false);
    }
  }

  async function publishImportDraft(): Promise<void> {
    if (!importDraft || saving) {
      return;
    }
    setSaving(true);
    try {
      setError("");
      const response = await publishSkillImportDraft(cwd.trim(), importDraft.id);
      setImportDraft(undefined);
      setImportForm(initialSkillImportForm);
      setImportOpen(false);
      await refresh();
      setActiveSubsection("skills");
      setMessage(t("Published {count} skills", { count: response.skills.length }));
    } catch (publishError) {
      setError(publishError instanceof Error ? publishError.message : String(publishError));
    } finally {
      setSaving(false);
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
      setImportDraft(response.draft);
      setImportOpen(true);
      setMessage(t("Draft ready"));
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
      className={activeSubsection === "skills" ? "settings-skill-library settings-skill-library--skills" : "settings-skill-library"}
      aria-labelledby="settings-skill-library-title"
    >
      <header className="settings-skill-library-head">
        <div>
          <h2 id="settings-skill-library-title">{t("Skill Library")}</h2>
          <p>{t("Workspace Skill Library manages Skill definitions and teammate binding visibility.")}</p>
        </div>
        <div className="settings-skill-library-actions">
          <button
            className="secondary-button compact-button"
            type="button"
            onClick={() => setActiveSubsection("source")}
            aria-pressed={activeSubsection === "source"}
          >
            <RefreshCw size={15} />
            {t("Sync gstack source")}
          </button>
          <button className="primary-button compact-button" type="button" onClick={() => setImportOpen(true)}>
            <Upload size={15} />
            {t("Import skill")}
          </button>
          <button
            className="secondary-button compact-button"
            type="button"
            onClick={() => {
              setImportOpen(true);
              setImportDraft(undefined);
              setImportForm(initialSkillImportForm);
            }}
          >
            <Plus size={15} />
            {t("New draft")}
          </button>
          <button className="icon-button" type="button" onClick={() => void refresh()} disabled={loading} aria-label={t("Refresh")}>
            <RefreshCw size={15} className={loading ? "spin" : undefined} />
          </button>
        </div>
      </header>

      {error ? <div className="inline-error">{error}</div> : null}

      <div className="settings-skill-library-stats" aria-label={t("Skill library stats")}>
        <span><small>{t("Total skills")}</small><strong>{stats.total}</strong></span>
        <span><small>{t("Bindable")}</small><strong>{stats.bindable}</strong></span>
        <span><small>{t("Drafts")}</small><strong>{stats.draft}</strong></span>
        <span><small>{t("Blocked")}</small><strong>{stats.blocked}</strong></span>
        <span><small>{t("Source-backed")}</small><strong>{stats.sourceBacked}</strong></span>
        <span><small>{t("Missing source")}</small><strong>{stats.missingSource}</strong></span>
      </div>

      <SettingsSubnav
        label="Skill library sections"
        activeId={activeSubsection}
        onChange={(id) => setActiveSubsection(id as SkillLibrarySubsectionId)}
        options={[
          {
            id: "skills",
            label: "Skills list",
            description: "Search registry definitions, inspect requirements, and archive custom skills.",
            badge: `${filteredSkills.length}`,
          },
          {
            id: "review",
            label: "Review queue",
            description: "Resolve health findings, skill candidates, candidate clusters, and playbook proposals.",
            badge: `${reviewQueueCount}`,
          },
          {
            id: "source",
            label: "Source sync",
            description: "Check source snapshots, preview gstack updates, and publish selected source records.",
            badge: `${sourceAttentionCount}`,
          },
        ]}
      />

      {activeSubsection === "skills" ? (
        <>
          {reviewQueueCount > 0 || sourceAttentionCount > 0 ? (
            <div className="settings-skill-attention-line">
              {reviewQueueCount > 0 ? (
                <button type="button" className="ghost-button compact-button" onClick={() => setActiveSubsection("review")}>
                  <AlertTriangle size={14} />
                  {t("{count} skill review items", { count: reviewQueueCount })}
                </button>
              ) : null}
              {sourceAttentionCount > 0 ? (
                <button type="button" className="ghost-button compact-button" onClick={() => setActiveSubsection("source")}>
                  <BookOpen size={14} />
                  {t("{count} skill source items", { count: sourceAttentionCount })}
                </button>
              ) : null}
            </div>
          ) : null}

          <div className="settings-skill-library-toolbar">
            <label className="settings-skill-search">
              <Search size={15} />
              <input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder={t("Search Skill, source, or tool")} />
            </label>
            <div className="settings-skill-filters" role="tablist" aria-label={t("Skill filters")}>
              {(["all", "builtin", "custom", "draft", "archived"] as const).map((item) => (
                <button key={item} type="button" className={filter === item ? "active" : ""} onClick={() => setFilter(item)}>
                  {skillLibraryFilterLabel(item, t)}
                </button>
              ))}
            </div>
            <select value={sortMode} onChange={(event) => setSortMode(event.target.value === "name" ? "name" : "updated")} aria-label={t("Sort skills")}>
              <option value="updated">{t("Sort by updated")}</option>
              <option value="name">{t("Sort by name")}</option>
            </select>
          </div>
        </>
      ) : null}

      {importOpen ? (
        <div className="settings-skill-import-overlay" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) {
            setImportOpen(false);
          }
        }}>
        <section className="settings-skill-import-panel" role="dialog" aria-modal="true" aria-labelledby="settings-skill-import-title">
          <div className="panel-title split">
            <span>
              <Upload size={15} />
              <h3 id="settings-skill-import-title">{t("Import skill draft")}</h3>
            </span>
            <button className="ghost-button compact-button" type="button" onClick={() => setImportOpen(false)} aria-label={t("Close import dialog")}>
              {t("Close")}
            </button>
          </div>
          <div className="settings-skill-import-grid">
            <label className="field">
              <span>{t("Source")}</span>
              <select value={importForm.source} onChange={(event) => setImportForm({ ...importForm, source: event.target.value as SkillPackSource })}>
                <option value="custom">{t("custom")}</option>
                <option value="skill-directory">{t("skill-directory")}</option>
                <option value="agents-md">{t("agents-md")}</option>
                <option value="workspace">{t("workspace")}</option>
              </select>
            </label>
            <label className="field">
              <span>{t("Draft name")}</span>
              <input value={importForm.name} onChange={(event) => setImportForm({ ...importForm, name: event.target.value })} />
            </label>
            <label className="field">
              <span>{t("Source path")}</span>
              <input value={importForm.sourcePath} onChange={(event) => setImportForm({ ...importForm, sourcePath: event.target.value })} placeholder="SKILL.md / AGENTS.md" />
            </label>
            <label className="field wide">
              <span>{t("Skill content")}</span>
              <textarea rows={5} value={importForm.content} onChange={(event) => setImportForm({ ...importForm, content: event.target.value })} />
            </label>
          </div>
          {importDraft ? (
            <div className="settings-skill-import-preview">
              {importDraft.definitions.map((item) => (
                <article key={item.definition.id} className="settings-skill-draft-row">
                  <span>
                    <strong>{item.definition.name}</strong>
                    <small>{item.definition.id} · {item.definition.summary}</small>
                  </span>
                  <SkillStatePill label={item.warnings?.some((warning) => warning.severity === "error") ? t("Blocked") : t("Draft")} tone={item.warnings?.some((warning) => warning.severity === "error") ? "blocked" : "draft"} />
                </article>
              ))}
              {[...importDraft.warnings, ...importDraft.definitions.flatMap((item) => item.warnings ?? [])].map((warning, index) => (
                <small key={`${warning.code}-${index}`} className={`teammate-warning ${warning.severity}`}>{t(warning.code)}: {warning.message}</small>
              ))}
            </div>
          ) : null}
          <div className="settings-skill-import-actions">
            <button className="secondary-button compact-button" type="button" onClick={() => void previewImportDraft()} disabled={saving || !importForm.content.trim()}>
              {saving ? <Loader2 className="spin" size={15} /> : <Search size={15} />}
              {t("Preview draft")}
            </button>
            <button
              className="primary-button compact-button"
              type="button"
              onClick={() => void publishImportDraft()}
              disabled={saving || !importDraft || importDraft.warnings.some((warning) => warning.severity === "error") || importDraft.definitions.some((item) => item.warnings?.some((warning) => warning.severity === "error"))}
            >
              <CheckCircle2 size={15} />
              {t("Publish to registry")}
            </button>
          </div>
        </section>
        </div>
      ) : null}

      {activeSubsection === "review" ? (
        <div className="settings-skill-review-stack">
          <SkillHealthPanel report={skillHealth} loading={loading} t={t} />
          <SkillCandidateReviewPanel
            candidates={skillCandidates}
            loading={loading}
            saving={saving}
            onReview={(candidateId, action) => void reviewCandidate(candidateId, action)}
            onCreateDraft={(candidateId) => void createDraftFromCandidate(candidateId)}
            t={t}
          />
          <ProcedureObservationClusterPanel
            clusters={observationClusters}
            loading={loading}
            saving={saving}
            onCreateProtocolCandidate={(cluster) => void createProtocolCandidateFromCluster(cluster)}
            onCreatePlaybookCandidate={(cluster) => void createPlaybookCandidateFromCluster(cluster)}
            t={t}
          />
          <PlaybookCandidateReviewPanel
            candidates={playbookCandidates}
            channels={channels}
            loading={loading}
            saving={saving}
            onReview={(candidate, action) => void reviewPlaybookCandidate(candidate, action)}
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
          <SkillSourceHealthPanel report={skillSourceHealth} snapshots={skillSourceSnapshots} loading={loading} t={t} />
        </div>
      ) : null}

      {activeSubsection === "skills" ? (
      <div className="settings-skill-library-body">
        <div className="settings-skill-table-wrap">
          <table className="settings-skill-table">
            <thead>
              <tr>
                <th>{t("Status")}</th>
                <th>{t("Skill")}</th>
                <th>{t("Source")}</th>
                <th>{t("Stage")}</th>
                <th>{t("Required tools")}</th>
                <th>{t("Approval")}</th>
                <th>{t("Bound teammates")}</th>
                <th>{t("Actions")}</th>
              </tr>
            </thead>
            <tbody>
              {filteredSkills.length === 0 ? (
                <tr>
                  <td colSpan={8}>
                    <div className="compact-empty">{loading ? t("Loading skills...") : t("No skills match these filters")}</div>
                  </td>
                </tr>
              ) : filteredSkills.map((entry) => {
                const boundTeammates = boundTeammateNames(entry.id, bindingSummaries);
                const state = skillRegistryState(entry, t);
                const selected = selectedSkill?.id === entry.id;
                const canArchive = entry.source !== "builtin" && entry.reviewStatus !== "archived";
                const sourceSnapshot = sourceSnapshotBySkillId.get(entry.id);
                return (
                  <tr key={entry.id} className={selected ? "selected" : ""}>
                    <td><SkillStatePill label={state.label} tone={state.tone} /></td>
                    <td>
                      <button className="settings-skill-name-button" type="button" onClick={() => setSelectedSkillId(entry.id)}>
                        <strong>{entry.definition.name}</strong>
                        <small>{entry.id}</small>
                      </button>
                    </td>
                    <td><SkillSourceStatus source={entry.source} snapshot={sourceSnapshot} t={t} /></td>
                    <td><span className={`phase-token ${entry.definition.workflowPhase}`}>{workflowPhaseLabel(entry.definition.workflowPhase, t)}</span></td>
                    <td><SkillTokenList values={entry.definition.requiredTools} emptyLabel={t("No tools")} /></td>
                    <td>{approvalProfileText(entry.definition.approvalProfile, t)}</td>
                    <td>{boundTeammates.length > 0 ? boundTeammates.join(", ") : t("Unbound")}</td>
                    <td>
                      <span className="settings-skill-row-actions">
                        <button className="secondary-button compact-button" type="button" onClick={() => setSelectedSkillId(entry.id)}>
                          <Eye size={14} />
                          {t("Details")}
                        </button>
                        {canArchive ? (
                          <button className="secondary-button danger compact-button" type="button" onClick={() => void archiveRegistrySkill(entry.id)} disabled={saving}>
                            <Archive size={14} />
                            {t("Archive")}
                          </button>
                        ) : null}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <aside className="settings-skill-inspector" aria-label={t("Skill detail")}>
          {selectedSkill ? (
            <>
              <div className="settings-skill-inspector-head">
                <span>
                  <BookOpen size={15} />
                  <strong>{selectedSkill.definition.name}</strong>
                </span>
                <SkillStatePill label={skillRegistryState(selectedSkill, t).label} tone={skillRegistryState(selectedSkill, t).tone} />
              </div>
              <SkillInspectorSection title={t("Description")}>
                <p>{selectedSkill.definition.summary}</p>
              </SkillInspectorSection>
              <SkillInspectorSection title={t("Prompt fragments")}>
                {selectedSkill.definition.promptFragments.length > 0 ? (
                  <pre>{selectedSkill.definition.promptFragments.slice(0, 3).join("\n\n")}</pre>
                ) : (
                  <p>{t("No prompt fragments")}</p>
                )}
              </SkillInspectorSection>
              <SkillInspectorSection title={t("Required tools")}>
                <SkillTokenList values={selectedSkill.definition.requiredTools} emptyLabel={t("No tools")} />
              </SkillInspectorSection>
              <SkillInspectorSection title={t("Approval profile")}>
                <p>{approvalProfileText(selectedSkill.definition.approvalProfile, t)}</p>
              </SkillInspectorSection>
              <SkillInspectorSection title={t("Provider capability")}>
                <SkillTokenList values={selectedSkill.definition.requiredProviderCapabilities} emptyLabel={t("No provider capability required")} />
              </SkillInspectorSection>
              <SkillInspectorSection title={t("Bound teammates")}>
                <SkillTokenList values={boundTeammateNames(selectedSkill.id, bindingSummaries)} emptyLabel={t("Unbound")} />
              </SkillInspectorSection>
              <SkillSourceInspector
                snapshot={sourceSnapshotBySkillId.get(selectedSkill.id)}
                history={sourceSnapshotHistoryBySkillId.get(selectedSkill.id) ?? []}
                artifacts={skillSourceArtifacts}
                cwd={cwd.trim()}
                saving={saving}
                onArchive={() => void archiveSourceSnapshot(selectedSkill.id)}
                onRollback={(snapshotId) => void rollbackSelectedSkillSource(snapshotId)}
                t={t}
              />
              <small>{t("Updated {time}", { time: formatDateTime(selectedSkill.updatedAt) })}</small>
            </>
          ) : (
            <div className="compact-empty">{t("Select a skill to inspect")}</div>
          )}
        </aside>
      </div>
      ) : null}

      <footer className="settings-skill-audit-note">
        {message ? <span>{message}</span> : null}
        <span>{t("Persona cannot grant tools, approvals, or secrets; Skill permissions are enforced by binding and policy checks.")}</span>
      </footer>
    </section>
  );
}
