import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Archive,
  BookOpen,
  CheckCircle2,
  Eye,
  Gauge,
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
  skillSourceArtifactContentUrl,
  updateSkillSourceUpgradePolicy,
} from "../../api.js";
import { useI18n } from "../../i18n.js";
import { formatDateTime } from "../../lib/formatting.js";
import type {
  AiTeammate,
  Channel,
  ChannelPlaybookCandidate,
  ChannelPlaybookCandidateReviewAction,
  ProcedureObservationCluster,
  SkillCandidate,
  SkillCandidateReviewAction,
  SkillHealthFinding,
  SkillHealthReport,
  SkillHealthSeverity,
  SkillImportDraft,
  SkillPackSource,
  SkillRegistryEntry,
  SkillSourceArtifact,
  SkillSourceHealthReport,
  SkillSourceSnapshot,
  SkillSourceSemanticDiffItem,
  SkillSourceSyncDiffItem,
  SkillSourceSyncPreviewRecord,
  SkillSourceSyncPreviewReport,
  SkillSourceSyncRecordState,
  SkillSourceSyncRequest,
  SkillSourceUpgradePolicy,
  TeammateSkillBinding,
} from "../../types.js";
import { approvalProfileText, workflowPhaseLabel } from "../teammates/helpers.js";

type SkillLibraryFilter = "all" | "builtin" | "custom" | "draft" | "archived";

interface SkillImportForm {
  readonly name: string;
  readonly sourcePath: string;
  readonly source: SkillPackSource;
  readonly content: string;
}

interface TeammateSkillBindingSummary {
  readonly teammate: AiTeammate;
  readonly bindings: readonly TeammateSkillBinding[];
}

type SettingsTranslator = (key: string, values?: Readonly<Record<string, string | number>>) => string;

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
  const [syncOpen, setSyncOpen] = useState(false);
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
      setSyncOpen(true);
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
      setSyncOpen(true);
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
    <section className="settings-skill-library" aria-labelledby="settings-skill-library-title">
      <header className="settings-skill-library-head">
        <div>
          <h2 id="settings-skill-library-title">{t("Skill Library")}</h2>
          <p>{t("Workspace Skill Library manages Skill definitions and teammate binding visibility.")}</p>
        </div>
        <div className="settings-skill-library-actions">
          <button className="secondary-button compact-button" type="button" onClick={() => setSyncOpen((open) => !open)} aria-expanded={syncOpen}>
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

      <SkillHealthPanel report={skillHealth} loading={loading} t={t} />
      <SkillSourceHealthPanel report={skillSourceHealth} snapshots={skillSourceSnapshots} loading={loading} t={t} />
      {syncOpen ? (
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
      ) : null}

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

      {importOpen ? (
        <div className="settings-skill-import-panel">
          <div className="panel-title split">
            <span>
              <Upload size={15} />
              <h3>{t("Import skill draft")}</h3>
            </span>
            <button className="ghost-button compact-button" type="button" onClick={() => setImportOpen(false)}>
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
        </div>
      ) : null}

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

      <footer className="settings-skill-audit-note">
        {message ? <span>{message}</span> : null}
        <span>{t("Persona cannot grant tools, approvals, or secrets; Skill permissions are enforced by binding and policy checks.")}</span>
      </footer>
    </section>
  );
}

function SkillSourceSyncPanel({
  preview,
  policy,
  rootPath,
  includeDetectedRoots,
  allowNewSkills,
  selectedSkillIds,
  loading,
  syncing,
  onRootPathChange,
  onIncludeDetectedRootsChange,
  onAllowNewSkillsChange,
  onPreview,
  onRefresh,
  onCheckUpdates,
  onPolicyModeChange,
  onPublish,
  onToggleRecord,
  t,
}: {
  readonly preview: SkillSourceSyncPreviewReport | undefined;
  readonly policy: SkillSourceUpgradePolicy | undefined;
  readonly rootPath: string;
  readonly includeDetectedRoots: boolean;
  readonly allowNewSkills: boolean;
  readonly selectedSkillIds: readonly string[];
  readonly loading: boolean;
  readonly syncing: boolean;
  readonly onRootPathChange: (value: string) => void;
  readonly onIncludeDetectedRootsChange: (value: boolean) => void;
  readonly onAllowNewSkillsChange: (value: boolean) => void;
  readonly onPreview: () => void;
  readonly onRefresh: () => void;
  readonly onCheckUpdates: () => void;
  readonly onPolicyModeChange: (mode: SkillSourceUpgradePolicy["mode"]) => void;
  readonly onPublish: () => void;
  readonly onToggleRecord: (record: SkillSourceSyncPreviewRecord) => void;
  readonly t: SettingsTranslator;
}): JSX.Element {
  const records = preview?.records ?? [];
  const selectedSet = new Set(selectedSkillIds);
  const disabled = loading || syncing;
  return (
    <section className="settings-skill-source-sync" aria-label={t("gstack source sync")}>
      <header className="settings-skill-source-sync-head">
        <span>
          <RefreshCw size={15} className={syncing ? "spin" : undefined} />
          <strong>{t("gstack source sync")}</strong>
        </span>
        <small>
          {policy?.lastCheckedAt ? t("Checked {time}", { time: formatDateTime(policy.lastCheckedAt) }) : preview ? t("{count} records", { count: preview.summary.totalRecords }) : t("Preview before publishing")}
        </small>
      </header>
      <div className="settings-skill-source-sync-controls">
        <label className="field">
          <span>{t("Upgrade policy")}</span>
          <select
            value={policy?.mode ?? "prompt"}
            onChange={(event) => onPolicyModeChange(event.target.value as SkillSourceUpgradePolicy["mode"])}
            disabled={disabled || !policy}
          >
            <option value="manual">{t("Manual")}</option>
            <option value="prompt">{t("Prompt")}</option>
            <option value="auto-safe">{t("Auto-safe")}</option>
          </select>
        </label>
        <label className="field">
          <span>{t("Skill root paths")}</span>
          <textarea
            rows={2}
            value={rootPath}
            onChange={(event) => onRootPathChange(event.target.value)}
            placeholder="~/.gstack/repos/gstack/.agents/skills"
          />
        </label>
        <div className="settings-skill-source-sync-switches">
          <label className="settings-toggle">
            <input type="checkbox" checked={includeDetectedRoots} onChange={(event) => onIncludeDetectedRootsChange(event.target.checked)} />
            {t("Include detected roots")}
          </label>
          <label className="settings-toggle">
            <input type="checkbox" checked={allowNewSkills} onChange={(event) => onAllowNewSkillsChange(event.target.checked)} />
            {t("Allow new skills")}
          </label>
        </div>
        <div className="settings-skill-source-sync-actions">
          <button className="secondary-button compact-button" type="button" onClick={onPreview} disabled={disabled || (!includeDetectedRoots && !rootPath.trim())}>
            <Search size={14} />
            {t("Preview")}
          </button>
          <button className="secondary-button compact-button" type="button" onClick={onRefresh} disabled={disabled || (!includeDetectedRoots && !rootPath.trim())}>
            <RefreshCw size={14} />
            {t("Refresh")}
          </button>
          <button className="secondary-button compact-button" type="button" onClick={onCheckUpdates} disabled={disabled || (!includeDetectedRoots && !rootPath.trim())}>
            <Gauge size={14} />
            {t("Check updates")}
          </button>
          <button className="primary-button compact-button" type="button" onClick={onPublish} disabled={disabled || selectedSkillIds.length === 0}>
            <CheckCircle2 size={14} />
            {t("Publish selected")}
          </button>
        </div>
      </div>
      {preview ? (
        <div className="settings-skill-source-sync-summary" aria-label={t("gstack source sync summary")}>
          <span><small>{t("Attachable")}</small><strong>{preview.summary.attachable}</strong></span>
          <span><small>{t("Drifted")}</small><strong>{preview.summary.drifted}</strong></span>
          <span><small>{t("New")}</small><strong>{preview.summary.new}</strong></span>
          <span><small>{t("Blocked")}</small><strong>{preview.summary.blocked}</strong></span>
          <span><small>{t("Selected")}</small><strong>{selectedSkillIds.length}</strong></span>
        </div>
      ) : null}
      {records.length === 0 ? (
        <div className="compact-empty">{syncing ? t("Scanning source roots...") : t("No source preview loaded")}</div>
      ) : (
        <div className="settings-skill-source-sync-records">
          {records.map((record) => {
            const selectable = isSelectableSyncRecord(record, allowNewSkills);
            const selected = selectedSet.has(record.skillId);
            const title = syncRecordTitle(record);
            const path = record.upstreamSkillPath ?? record.sourcePath ?? "-";
            const diff = record.diff ?? [];
            const semanticDiff = record.semanticDiff ?? [];
            const artifactReviewCount = record.referencedFiles.filter((file) => file.kind === "script" || file.kind === "asset").length;
            return (
              <article key={`${record.skillId}:${record.sourcePath ?? record.upstreamSkillPath ?? record.state}`} className={`settings-skill-source-sync-record ${record.state}`}>
                <label className="settings-skill-source-sync-select">
                  <input
                    type="checkbox"
                    checked={selected}
                    disabled={!selectable || disabled}
                    onChange={() => onToggleRecord(record)}
                    aria-label={t("Select {skill}", { skill: record.skillId })}
                  />
                </label>
                <div className="settings-skill-source-sync-main">
                  <div className="settings-skill-source-sync-title">
                    <span>
                      <strong>{title}</strong>
                      <small>{record.skillId} · {path}</small>
                    </span>
                    <span className={`settings-skill-sync-state ${record.state}`}>{skillSourceSyncStateLabel(record.state, t)}</span>
                  </div>
                  <div className="settings-skill-source-sync-meta">
                    <span>{record.sourceKind ?? "-"}</span>
                    {record.sourceRootId ? <span>{t("Root")}: {record.sourceRootId}</span> : null}
                    <span>{t("Files")}: {record.referencedFiles.length}</span>
                    <span>{t("Warnings")}: {record.warnings.length}</span>
                    <span>{t("Semantic")}: {semanticDiff.length}</span>
                    {artifactReviewCount > 0 ? <span>{t("Artifact review")}: {artifactReviewCount}</span> : null}
                    {record.sourceChecksum ? <span>{record.sourceChecksum}</span> : null}
                  </div>
                  {record.warnings.length > 0 ? (
                    <div className="settings-skill-source-sync-warnings">
                      {record.warnings.slice(0, 2).map((warning, index) => (
                        <small key={`${warning.code}:${warning.location ?? index}`} className={warning.severity}>
                          {warning.severity}: {warning.code}
                        </small>
                      ))}
                    </div>
                  ) : null}
                  {diff.length > 0 ? (
                    <div className="settings-skill-source-sync-diff" aria-label={t("Drift diff for {skill}", { skill: record.skillId })}>
                      <span className="settings-skill-source-sync-diff-title">{t("Drift diff")} · {diff.length}</span>
                      <div className="settings-skill-source-sync-diff-items">
                        {diff.slice(0, 5).map((item) => (
                          <div key={item.field} className={`settings-skill-source-sync-diff-item ${item.severity}`}>
                            <small>{skillSourceSyncDiffLabel(item, t)}</small>
                            <code>{item.before ?? "-"}</code>
                            <span>→</span>
                            <code>{item.after ?? "-"}</code>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  {semanticDiff.length > 0 ? (
                    <div className="settings-skill-source-sync-diff" aria-label={t("Semantic diff for {skill}", { skill: record.skillId })}>
                      <span className="settings-skill-source-sync-diff-title">{t("Semantic diff")} · {semanticDiff.length}</span>
                      <div className="settings-skill-source-sync-diff-items">
                        {semanticDiff.slice(0, 5).map((item, index) => (
                          <div key={`${item.kind}:${index}`} className={`settings-skill-source-sync-diff-item ${item.severity}`}>
                            <small>{skillSourceSemanticDiffLabel(item, t)}</small>
                            <code>{item.before ?? "-"}</code>
                            <span>→</span>
                            <code>{item.after ?? "-"}</code>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function SkillHealthPanel({
  report,
  loading,
  t,
}: {
  readonly report: SkillHealthReport | undefined;
  readonly loading: boolean;
  readonly t: (key: string, values?: Readonly<Record<string, string | number>>) => string;
}): JSX.Element {
  const findings = report?.findings ?? [];
  const summary = report?.summary;
  return (
    <section className="settings-skill-health" aria-label={t("Skill Health")}>
      <header className="settings-skill-health-head">
        <span>
          <Gauge size={15} />
          <strong>{t("Skill Health")}</strong>
        </span>
        <small>
          {report ? t("Generated {time}", { time: formatDateTime(report.generatedAt) }) : loading ? t("Loading skill health...") : t("No health report loaded")}
        </small>
      </header>
      <div className="settings-skill-health-summary" aria-label={t("Skill health summary")}>
        <span><small>{t("Critical")}</small><strong>{summary?.findings.critical ?? 0}</strong></span>
        <span><small>{t("Warnings")}</small><strong>{summary?.findings.warning ?? 0}</strong></span>
        <span><small>{t("Duplicate clusters")}</small><strong>{summary?.duplicateClusters ?? 0}</strong></span>
        <span><small>{t("Conflicts")}</small><strong>{summary?.conflictCount ?? 0}</strong></span>
      </div>
      {findings.length === 0 ? (
        <div className="compact-empty">{loading ? t("Loading skill health...") : t("No skill health findings")}</div>
      ) : (
        <div className="settings-skill-health-findings">
          {findings.map((finding) => (
            <SkillHealthFindingRow key={finding.id} finding={finding} t={t} />
          ))}
        </div>
      )}
    </section>
  );
}

function SkillHealthFindingRow({
  finding,
  t,
}: {
  readonly finding: SkillHealthFinding;
  readonly t: (key: string, values?: Readonly<Record<string, string | number>>) => string;
}): JSX.Element {
  const relatedIds = [...finding.skillIds, ...finding.candidateIds].slice(0, 4);
  return (
    <article className={`settings-skill-health-finding ${finding.severity}`}>
      <div className="settings-skill-health-finding-main">
        <span className="settings-skill-health-title">
          <AlertTriangle size={14} />
          <strong>{finding.title}</strong>
        </span>
        <p>{finding.message}</p>
        <small>{skillHealthKindLabel(finding.kind, t)} · {t("Action")}: {skillHealthActionLabel(finding.recommendedAction, t)}</small>
      </div>
      <div className="settings-skill-health-finding-meta">
        <SkillHealthSeverityPill severity={finding.severity} t={t} />
        <SkillTokenList values={relatedIds} emptyLabel={t("No related ids")} />
      </div>
    </article>
  );
}

function SkillSourceHealthPanel({
  report,
  snapshots,
  loading,
  t,
}: {
  readonly report: SkillSourceHealthReport | undefined;
  readonly snapshots: readonly SkillSourceSnapshot[];
  readonly loading: boolean;
  readonly t: SettingsTranslator;
}): JSX.Element {
  const findings = report?.findings ?? [];
  const summary = report?.summary;
  return (
    <section className="settings-skill-health settings-skill-source-health" aria-label={t("Skill Source Health")}>
      <header className="settings-skill-health-head">
        <span>
          <BookOpen size={15} />
          <strong>{t("Skill Source Health")}</strong>
        </span>
        <small>
          {report ? t("Generated {time}", { time: formatDateTime(report.generatedAt) }) : loading ? t("Loading skill source health...") : t("No source health report loaded")}
        </small>
      </header>
      <div className="settings-skill-health-summary" aria-label={t("Skill source summary")}>
        <span><small>{t("Source-backed")}</small><strong>{summary?.sourceBackedSkills ?? snapshots.length}</strong></span>
        <span><small>{t("Missing source")}</small><strong>{summary?.missingSourceSnapshots ?? 0}</strong></span>
        <span><small>{t("Warning snapshots")}</small><strong>{summary?.warningSnapshots ?? 0}</strong></span>
        <span><small>{t("Orphaned")}</small><strong>{summary?.orphanedSnapshots ?? 0}</strong></span>
      </div>
      {findings.length === 0 ? (
        <div className="compact-empty">{loading ? t("Loading skill source health...") : t("No skill source findings")}</div>
      ) : (
        <div className="settings-skill-health-findings">
          {findings.map((finding) => (
            <article key={`${finding.kind}:${finding.skillId ?? finding.snapshotId ?? finding.title}`} className={`settings-skill-health-finding ${finding.severity}`}>
              <div className="settings-skill-health-finding-main">
                <span className="settings-skill-health-title">
                  <AlertTriangle size={14} />
                  <strong>{sourceHealthTitle(finding, t)}</strong>
                </span>
                <p>{sourceHealthMessage(finding, t)}</p>
                <small>{sourceHealthKindLabel(finding.kind, t)}</small>
              </div>
              <div className="settings-skill-health-finding-meta">
                <SkillHealthSeverityPill severity={finding.severity} t={t} />
                <SkillTokenList values={[finding.skillId, finding.snapshotId].filter((value): value is string => Boolean(value))} emptyLabel={t("No related ids")} />
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function SkillSourceStatus({
  source,
  snapshot,
  t,
}: {
  readonly source: SkillPackSource;
  readonly snapshot: SkillSourceSnapshot | undefined;
  readonly t: SettingsTranslator;
}): JSX.Element {
  const sourceState = skillSourceSnapshotState(snapshot, t);
  return (
    <span className="settings-skill-source-status">
      <span>{skillSourceLabel(source, t)}</span>
      <small className={sourceState.tone}>{sourceState.label}</small>
    </span>
  );
}

function SkillSourceInspector({
  snapshot,
  history,
  artifacts,
  cwd,
  saving,
  onArchive,
  onRollback,
  t,
}: {
  readonly snapshot: SkillSourceSnapshot | undefined;
  readonly history: readonly SkillSourceSnapshot[];
  readonly artifacts: readonly SkillSourceArtifact[];
  readonly cwd: string;
  readonly saving: boolean;
  readonly onArchive: () => void;
  readonly onRollback: (snapshotId: string) => void;
  readonly t: SettingsTranslator;
}): JSX.Element {
  if (!snapshot) {
    return (
      <SkillInspectorSection title={t("Source snapshot")}>
        <p>{t("Metadata only. No published SKILL.md snapshot is attached yet.")}</p>
      </SkillInspectorSection>
    );
  }

  return (
    <SkillInspectorSection title={t("Source snapshot")}>
      <div className="settings-skill-source-detail">
        <span><small>{t("Snapshot")}</small><code>{snapshot.id}</code></span>
        <span><small>{t("Checksum")}</small><code>{snapshot.sourceChecksum}</code></span>
        <span><small>{t("Upstream")}</small><code>{[snapshot.upstreamName, snapshot.upstreamVersion].filter(Boolean).join(" ") || "-"}</code></span>
        <span><small>{t("Path")}</small><code>{snapshot.upstreamSkillPath ?? snapshot.sourcePath ?? "-"}</code></span>
      </div>
      <div className="settings-skill-source-tags">
        <span>{t("Files")}: {snapshot.referencedFiles.length}</span>
        <span>{t("Warnings")}: {snapshot.warnings.length}</span>
        <span>{t("Review")}: {snapshot.reviewStatus}</span>
        <span>{t("Artifacts")}: {artifacts.length}</span>
      </div>
      <div className="settings-skill-source-actions">
        <button className="secondary-button danger compact-button" type="button" onClick={onArchive} disabled={saving}>
          <Archive size={14} />
          {t("Archive source snapshot")}
        </button>
      </div>
      {snapshot.warnings.length > 0 ? (
        <div className="settings-skill-source-warning-list">
          {snapshot.warnings.slice(0, 4).map((warning, index) => (
            <small key={`${warning.code}:${warning.location ?? index}`} className={warning.severity}>
              {warning.severity}: {warning.code} · {warning.message}
            </small>
          ))}
        </div>
      ) : null}
      {artifacts.length > 0 ? (
        <div className="settings-skill-source-warning-list">
          {artifacts.slice(0, 6).map((artifact) => (
            <small key={artifact.id} className={artifact.reviewStatus === "published" ? "info" : "warning"}>
              {artifact.kind}: <a href={skillSourceArtifactContentUrl(artifact.id, cwd)} target="_blank" rel="noreferrer">{artifact.path}</a> · {artifact.reviewStatus} · {artifact.sizeBytes} bytes
            </small>
          ))}
        </div>
      ) : null}
      {snapshot.rawSkillMarkdownArtifactId ? (
        <p>
          <a href={skillSourceArtifactContentUrl(snapshot.rawSkillMarkdownArtifactId, cwd)} target="_blank" rel="noreferrer">
            {t("Open full SKILL.md artifact")}
          </a>
        </p>
      ) : null}
      {history.length > 0 ? (
        <div className="settings-skill-source-warning-list">
          {history.slice(0, 4).map((archived) => (
            <small key={archived.id} className="info">
              {formatDateTime(archived.updatedAt)} · {archived.sourceChecksum}
              <button className="ghost-button compact-button" type="button" onClick={() => onRollback(archived.id)} disabled={saving}>
                {t("Rollback")}
              </button>
            </small>
          ))}
        </div>
      ) : null}
      <details className="settings-skill-source-preview">
        <summary>{t("View SKILL.md")}</summary>
        <pre>{snapshot.rawSkillMarkdown}</pre>
      </details>
    </SkillInspectorSection>
  );
}

function SkillHealthSeverityPill({
  severity,
  t,
}: {
  readonly severity: SkillHealthSeverity;
  readonly t: (key: string) => string;
}): JSX.Element {
  return <span className={`settings-skill-health-severity ${severity}`}>{skillHealthSeverityLabel(severity, t)}</span>;
}

function ProcedureObservationClusterPanel({
  clusters,
  loading,
  saving,
  onCreateProtocolCandidate,
  onCreatePlaybookCandidate,
  t,
}: {
  readonly clusters: readonly ProcedureObservationCluster[];
  readonly loading: boolean;
  readonly saving: boolean;
  readonly onCreateProtocolCandidate: (cluster: ProcedureObservationCluster) => void;
  readonly onCreatePlaybookCandidate: (cluster: ProcedureObservationCluster) => void;
  readonly t: SettingsTranslator;
}): JSX.Element {
  const reviewable = clusters.filter((cluster) => cluster.status === "ready_for_review");
  const blocked = clusters.filter((cluster) => cluster.status === "blocked");
  return (
    <section className="settings-skill-candidate-review settings-skill-clusters" aria-label={t("Candidate Clusters")}>
      <header className="settings-skill-candidate-head">
        <span>
          <CheckCircle2 size={15} />
          <strong>{t("Candidate Clusters")}</strong>
        </span>
        <small>{t("{review} review · {blocked} blocked · {total} total", { review: reviewable.length, blocked: blocked.length, total: clusters.length })}</small>
      </header>
      {clusters.length === 0 ? (
        <div className="compact-empty">{loading ? t("Loading candidate clusters...") : t("No candidate clusters yet")}</div>
      ) : (
        <div className="settings-skill-candidate-list">
          {clusters.slice(0, 6).map((cluster) => {
            const canCreateProtocolCandidate = cluster.channelId &&
              cluster.routeKind === "channel_protocol" &&
              cluster.status === "ready_for_review" &&
              cluster.recommendedAction === "create_channel_protocol_candidate" &&
              cluster.routeBlockers.length === 0;
            const canCreatePlaybookCandidate = cluster.channelId &&
              cluster.routeKind === "playbook" &&
              cluster.status === "ready_for_review" &&
              cluster.recommendedAction === "create_playbook_candidate" &&
              cluster.routeBlockers.length === 0;
            return (
              <article key={cluster.id} className="settings-skill-candidate-card">
                <div className="settings-skill-candidate-main">
                  <div className="settings-skill-candidate-title">
                    <span>
                      <strong>{cluster.title}</strong>
                      <small>{cluster.id} · {candidateRouteKindLabel(cluster.routeKind, t)}</small>
                    </span>
                    <span className={`settings-skill-candidate-status ${cluster.status}`}>{procedureObservationClusterStatusLabel(cluster.status, t)}</span>
                  </div>
                  <p>{cluster.summary}</p>
                  <div className="settings-skill-candidate-meta">
                    <span>{t("Recommended")}: {procedureObservationClusterActionLabel(cluster.recommendedAction, t)}</span>
                    <span>{t("Evidence")}: {cluster.observationCount}</span>
                    <span>{t("Reusable")}: {cluster.reusableScore}</span>
                    <span>{t("Updated {time}", { time: formatDateTime(cluster.lastObservedAt) })}</span>
                  </div>
                  <div className="settings-skill-candidate-gates">
                    <span>
                      <small>{t("Triggers")}</small>
                      <SkillTokenList values={cluster.positiveTriggers} emptyLabel={t("No positive triggers")} />
                    </span>
                    <span>
                      <small>{t("Blockers")}</small>
                      <SkillTokenList values={cluster.routeBlockers.map((blocker) => candidateRouteBlockerLabel(blocker, t))} emptyLabel={t("No blockers")} />
                    </span>
                  </div>
                </div>
                {canCreateProtocolCandidate ? (
                  <div className="settings-skill-candidate-actions">
                    <button className="primary-button compact-button" type="button" onClick={() => onCreateProtocolCandidate(cluster)} disabled={saving}>
                      <BookOpen size={14} />
                      {t("Create protocol candidate")}
                    </button>
                  </div>
                ) : null}
                {canCreatePlaybookCandidate ? (
                  <div className="settings-skill-candidate-actions">
                    <button className="primary-button compact-button" type="button" onClick={() => onCreatePlaybookCandidate(cluster)} disabled={saving}>
                      <BookOpen size={14} />
                      {t("Create playbook candidate")}
                    </button>
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function PlaybookCandidateReviewPanel({
  candidates,
  channels,
  loading,
  saving,
  onReview,
  t,
}: {
  readonly candidates: readonly ChannelPlaybookCandidate[];
  readonly channels: readonly Channel[];
  readonly loading: boolean;
  readonly saving: boolean;
  readonly onReview: (candidate: ChannelPlaybookCandidate, action: ChannelPlaybookCandidateReviewAction) => void;
  readonly t: SettingsTranslator;
}): JSX.Element {
  const channelNames = useMemo(() => new Map(channels.map((channel) => [channel.id, channel.name])), [channels]);
  const draftCount = candidates.filter((candidate) => candidate.status === "draft").length;
  const activeCount = candidates.filter((candidate) => candidate.status === "active").length;
  const rows = useMemo(() => {
    const statusRank: Record<ChannelPlaybookCandidate["status"], number> = {
      draft: 0,
      active: 1,
      stale: 2,
      cancelled: 3,
    };
    return [...candidates].sort((left, right) => {
      const rank = statusRank[left.status] - statusRank[right.status];
      return rank !== 0 ? rank : right.updatedAt.localeCompare(left.updatedAt);
    });
  }, [candidates]);

  return (
    <section className="settings-skill-candidate-review settings-playbook-candidate-review" aria-label={t("Playbook Candidate Review")}>
      <header className="settings-skill-candidate-head">
        <span>
          <BookOpen size={15} />
          <strong>{t("Playbook Candidate Review")}</strong>
        </span>
        <small>{t("{draft} draft · {active} active · {total} total", { draft: draftCount, active: activeCount, total: candidates.length })}</small>
      </header>
      {rows.length === 0 ? (
        <div className="compact-empty">{loading ? t("Loading playbook candidates...") : t("No playbook candidates")}</div>
      ) : (
        <div className="settings-skill-candidate-list">
          {rows.slice(0, 8).map((candidate) => {
            const canReview = candidate.status === "draft";
            const channelName = channelNames.get(candidate.channelId) ?? candidate.channelId;
            return (
              <article key={candidate.id} className="settings-skill-candidate-card">
                <div className="settings-skill-candidate-main">
                  <div className="settings-skill-candidate-title">
                    <span>
                      <strong>{candidate.title}</strong>
                      <small>{channelName} · {candidate.id}</small>
                    </span>
                    <span className={`settings-skill-candidate-status ${candidate.status}`}>{playbookCandidateStatusLabel(candidate.status, t)}</span>
                  </div>
                  <p>{candidate.summary}</p>
                  <div className="settings-skill-candidate-meta">
                    <span>{t("Goal")}: {candidate.normalizedGoal}</span>
                    <span>{t("Reason")}: {candidate.reason}</span>
                    <span>{t("Updated {time}", { time: formatDateTime(candidate.updatedAt) })}</span>
                  </div>
                  <div className="settings-skill-candidate-gates">
                    <span>
                      <small>{t("Steps")}</small>
                      <SkillTokenList values={candidate.procedureSteps.map((step) => step.title)} emptyLabel={t("No procedure steps")} />
                    </span>
                    <span>
                      <small>{t("Validation")}</small>
                      <SkillTokenList values={candidate.validationSteps.map((step) => step.title)} emptyLabel={t("No validation steps")} />
                    </span>
                    <span>
                      <small>{t("Triggers")}</small>
                      <SkillTokenList values={candidate.positiveTriggers} emptyLabel={t("No positive triggers")} />
                    </span>
                    <span>
                      <small>{t("Avoid triggers")}</small>
                      <SkillTokenList values={candidate.negativeTriggers} emptyLabel={t("No avoid triggers")} />
                    </span>
                    <span>
                      <small>{t("Source refs")}</small>
                      <SkillTokenList values={candidate.sourceRefs.map((ref) => `${ref.label ?? ref.type}:${ref.id}`)} emptyLabel={t("No source refs")} />
                    </span>
                  </div>
                </div>
                <div className="settings-skill-candidate-actions">
                  <button className="primary-button compact-button" type="button" onClick={() => onReview(candidate, "approve")} disabled={saving || !canReview}>
                    <CheckCircle2 size={14} />
                    {t("Approve playbook")}
                  </button>
                  <button className="secondary-button danger compact-button" type="button" onClick={() => onReview(candidate, "reject")} disabled={saving || !canReview}>
                    <Archive size={14} />
                    {t("Reject playbook")}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function SkillCandidateReviewPanel({
  candidates,
  loading,
  saving,
  onReview,
  onCreateDraft,
  t,
}: {
  readonly candidates: readonly SkillCandidate[];
  readonly loading: boolean;
  readonly saving: boolean;
  readonly onReview: (candidateId: string, action: SkillCandidateReviewAction) => void;
  readonly onCreateDraft: (candidateId: string) => void;
  readonly t: SettingsTranslator;
}): JSX.Element {
  const openCandidates = candidates.filter((candidate) => isOpenSkillCandidateStatus(candidate.status));
  return (
    <section className="settings-skill-candidate-review" aria-label={t("Skill Candidate Review")}>
      <header className="settings-skill-candidate-head">
        <span>
          <CheckCircle2 size={15} />
          <strong>{t("Skill Candidate Review")}</strong>
        </span>
        <small>{t("{open} open · {total} total", { open: openCandidates.length, total: candidates.length })}</small>
      </header>
      {openCandidates.length === 0 ? (
        <div className="compact-empty">{loading ? t("Loading skill candidates...") : t("No open skill candidates")}</div>
      ) : (
        <div className="settings-skill-candidate-list">
          {openCandidates.map((candidate) => {
            const gate = skillCandidateGate(candidate, t);
            const canApprove = (candidate.status === "pending" || candidate.status === "needs_edit") && !gate.approvalBlocked;
            const canReject = !isTerminalSkillCandidateStatus(candidate.status);
            const canCreateDraft = candidate.status === "approved_for_draft" && !gate.draftBlocked;
            return (
              <article key={candidate.id} className="settings-skill-candidate-card">
                <div className="settings-skill-candidate-main">
                  <div className="settings-skill-candidate-title">
                    <span>
                      <strong>{candidate.title}</strong>
                      <small>{candidate.id} · {skillCandidateOriginLabel(candidate.origin, t)}</small>
                    </span>
                    <SkillCandidateStatusPill candidate={candidate} t={t} />
                  </div>
                  <p>{candidate.summary}</p>
                  <div className="settings-skill-candidate-meta">
                    <span>{t("Duplicate")}: {skillDuplicateDecisionLabel(candidate.duplicateAnalysis.decision, t)}</span>
                    <span>{t("Similarity")}: {Math.round(candidate.duplicateAnalysis.similarityScore * 100)}%</span>
                    <span>{t("Updated {time}", { time: formatDateTime(candidate.updatedAt) })}</span>
                  </div>
                  <div className="settings-skill-candidate-gates">
                    <span>
                      <small>{t("Gates")}</small>
                      <SkillTokenList values={gate.labels} emptyLabel={t("Draft gates clear")} />
                    </span>
                    <span>
                      <small>{t("Source refs")}</small>
                      <SkillTokenList values={candidate.sourceRefs.map((ref) => `${ref.label ?? ref.type}:${ref.id}`)} emptyLabel={t("No source refs")} />
                    </span>
                  </div>
                </div>
                <div className="settings-skill-candidate-actions">
                  {candidate.status === "approved_for_draft" ? (
                    <button className="primary-button compact-button" type="button" onClick={() => onCreateDraft(candidate.id)} disabled={saving || !canCreateDraft}>
                      <Upload size={14} />
                      {t("Create registry draft")}
                    </button>
                  ) : (
                    <button className="secondary-button compact-button" type="button" onClick={() => onReview(candidate.id, "approve_for_draft")} disabled={saving || !canApprove}>
                      <CheckCircle2 size={14} />
                      {t("Approve for draft")}
                    </button>
                  )}
                  {canReject ? (
                    <button className="secondary-button danger compact-button" type="button" onClick={() => onReview(candidate.id, "reject")} disabled={saving}>
                      <Archive size={14} />
                      {t("Reject candidate")}
                    </button>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function SkillCandidateStatusPill({
  candidate,
  t,
}: {
  readonly candidate: SkillCandidate;
  readonly t: SettingsTranslator;
}): JSX.Element {
  return <span className={`settings-skill-candidate-status ${candidate.status}`}>{skillCandidateStatusLabel(candidate.status, t)}</span>;
}

function SkillTokenList({ values, emptyLabel }: { readonly values: readonly string[]; readonly emptyLabel: string }): JSX.Element {
  if (values.length === 0) {
    return <span className="settings-skill-empty-token">{emptyLabel}</span>;
  }
  return (
    <span className="settings-skill-token-list">
      {values.slice(0, 4).map((value) => <code key={value}>{value}</code>)}
      {values.length > 4 ? <small>+{values.length - 4}</small> : null}
    </span>
  );
}

function SkillInspectorSection({ title, children }: { readonly title: string; readonly children: ReactNode }): JSX.Element {
  return (
    <section className="settings-skill-inspector-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function SkillStatePill({ label, tone }: { readonly label: string; readonly tone: "bindable" | "draft" | "blocked" | "archived" }): JSX.Element {
  return <span className={`settings-skill-state ${tone}`}>{label}</span>;
}

function skillRegistryState(entry: SkillRegistryEntry, t: (key: string, values?: Readonly<Record<string, string | number>>) => string): { readonly label: string; readonly tone: "bindable" | "draft" | "blocked" | "archived" } {
  if (entry.reviewStatus === "archived") {
    return { label: t("Archived"), tone: "archived" };
  }
  if (entry.reviewStatus === "draft") {
    return { label: t("Draft"), tone: "draft" };
  }
  if (entry.reviewStatus === "disabled") {
    return { label: t("Blocked"), tone: "blocked" };
  }
  return { label: t("Bindable"), tone: "bindable" };
}

function skillLibraryFilterLabel(filter: SkillLibraryFilter, t: (key: string) => string): string {
  if (filter === "builtin") {
    return t("Built-in");
  }
  if (filter === "custom") {
    return t("Custom");
  }
  if (filter === "draft") {
    return t("Draft");
  }
  if (filter === "archived") {
    return t("Archived");
  }
  return t("All");
}

function skillSourceLabel(source: SkillPackSource, t: (key: string) => string): string {
  if (source === "builtin") {
    return t("Built-in");
  }
  if (source === "agents-md") {
    return "AGENTS.md";
  }
  if (source === "skill-directory") {
    return t("skill-directory");
  }
  if (source === "workspace") {
    return t("Workspace");
  }
  if (source === "gstack") {
    return "gstack";
  }
  return t("Custom");
}

function skillSourceSnapshotState(
  snapshot: SkillSourceSnapshot | undefined,
  t: SettingsTranslator,
): { readonly label: string; readonly tone: "backed" | "warning" | "missing" } {
  if (!snapshot) {
    return { label: t("Metadata only"), tone: "missing" };
  }
  const warningCodes = new Set(snapshot.warnings.map((warning) => warning.code));
  if (warningCodes.has("drifted_upstream")) {
    return { label: t("Drifted source"), tone: "warning" };
  }
  if (warningCodes.has("missing_upstream")) {
    return { label: t("Missing upstream"), tone: "warning" };
  }
  if (warningCodes.has("orphaned_snapshot")) {
    return { label: t("Orphaned source"), tone: "warning" };
  }
  if (snapshot.warnings.length > 0) {
    return { label: t("{count} warnings", { count: snapshot.warnings.length }), tone: "warning" };
  }
  return { label: t("Source-backed"), tone: "backed" };
}

function defaultSelectedSyncSkillIds(records: readonly SkillSourceSyncPreviewRecord[], allowNewSkills: boolean): readonly string[] {
  return records
    .filter((record) => record.state === "attachable" || record.state === "drifted" || (allowNewSkills && record.state === "new"))
    .filter((record) => isSelectableSyncRecord(record, allowNewSkills))
    .map((record) => record.skillId);
}

function isSelectableSyncRecord(record: SkillSourceSyncPreviewRecord, allowNewSkills: boolean): boolean {
  if (record.semanticDiff.some((item) => item.severity === "error")) {
    return false;
  }
  if (record.state === "new") {
    return allowNewSkills && !record.warnings.some((warning) => warning.severity === "error");
  }
  if (record.state === "attachable" || record.state === "drifted" || record.state === "unchanged") {
    return !record.warnings.some((warning) => warning.severity === "error");
  }
  return false;
}

function syncRecordTitle(record: SkillSourceSyncPreviewRecord): string {
  return record.definitionPreview?.name ?? record.frontMatter?.name ?? record.agentMetadata?.displayName ?? record.skillId;
}

function skillSourceSyncStateLabel(state: SkillSourceSyncRecordState, t: (key: string) => string): string {
  switch (state) {
    case "attachable":
      return t("Attachable");
    case "unchanged":
      return t("Unchanged");
    case "drifted":
      return t("Drifted");
    case "new":
      return t("New");
    case "missing":
      return t("Missing");
    case "blocked":
      return t("Blocked");
    case "orphaned":
      return t("Orphaned");
  }
}

function skillSourceSyncDiffLabel(item: SkillSourceSyncDiffItem, t: (key: string) => string): string {
  switch (item.field) {
    case "sourceChecksum":
      return t("Checksum");
    case "upstreamVersion":
      return t("Upstream version");
    case "upstreamSkillPath":
      return t("Skill path");
    case "sourceLengthChars":
      return t("Source length");
    case "referencedFiles":
      return t("Referenced files");
    case "warnings":
      return t("Warnings");
    case "frontMatterName":
      return t("Front matter name");
    case "frontMatterDescription":
      return t("Front matter description");
    case "agentDisplayName":
      return t("Agent display name");
    case "agentShortDescription":
      return t("Agent short description");
    case "agentAllowImplicitInvocation":
      return t("Implicit invocation");
  }
}

function skillSourceSemanticDiffLabel(item: SkillSourceSemanticDiffItem, t: (key: string) => string): string {
  switch (item.kind) {
    case "copy_change":
      return t("Copy");
    case "workflow_change":
      return t("Workflow");
    case "gate_change":
      return t("Gate");
    case "tool_claim_change":
      return t("Tool claim");
    case "host_claim_change":
      return t("Host claim");
    case "external_action_change":
      return t("External action");
    case "destructive_claim_change":
      return t("Destructive claim");
    case "secret_claim_change":
      return t("Secret claim");
    case "referenced_file_change":
      return t("Referenced files");
  }
}

function sourceHealthKindLabel(kind: string, t: (key: string) => string): string {
  if (kind === "missing_source_snapshot") {
    return t("Missing source snapshot");
  }
  if (kind === "source_warning") {
    return t("Source warning");
  }
  if (kind === "orphaned_source_snapshot") {
    return t("Orphaned source snapshot");
  }
  return kind;
}

function sourceHealthTitle(finding: SkillSourceHealthReport["findings"][number], t: SettingsTranslator): string {
  if (finding.kind === "missing_source_snapshot") {
    return t("Skill source snapshot missing");
  }
  if (finding.kind === "source_warning") {
    return t("Skill source warning");
  }
  if (finding.kind === "orphaned_source_snapshot") {
    return t("Orphaned skill source snapshot");
  }
  return t(finding.title);
}

function sourceHealthMessage(finding: SkillSourceHealthReport["findings"][number], t: SettingsTranslator): string {
  if (finding.kind === "missing_source_snapshot" && finding.skillId) {
    return t("{skill} has registry metadata but no published source snapshot.", { skill: finding.skillId });
  }
  if (finding.kind === "source_warning" && finding.snapshotId) {
    return t("{snapshot} has source warnings.", { snapshot: finding.snapshotId });
  }
  if (finding.kind === "orphaned_source_snapshot" && finding.snapshotId) {
    return t("{snapshot} points at a missing or archived skill.", { snapshot: finding.snapshotId });
  }
  return t(finding.message);
}

function skillHealthSeverityLabel(severity: SkillHealthSeverity, t: (key: string) => string): string {
  if (severity === "critical") {
    return t("Critical");
  }
  if (severity === "warning") {
    return t("Warning");
  }
  return t("Info");
}

function skillHealthKindLabel(kind: SkillHealthFinding["kind"], t: (key: string) => string): string {
  switch (kind) {
    case "duplicate_clusters":
      return t("Duplicate skill cluster");
    case "conflicting_triggers":
      return t("Conflicting triggers");
    case "shadowed_skill":
      return t("Shadowed skill");
    case "never_used_skill":
      return t("Never used skill");
    case "stale_candidate":
      return t("Stale candidate");
    case "high_failure_rate_skill":
      return t("High failure rate");
    case "high_user_correction_skill":
      return t("High correction rate");
    case "external_overlap_generated_skill":
      return t("External overlap");
    case "superseded_but_active":
      return t("Superseded but active");
    case "missing_validation_steps":
      return t("Missing validation");
    case "missing_negative_triggers":
      return t("Missing negative triggers");
  }
}

function skillHealthActionLabel(action: SkillHealthFinding["recommendedAction"], t: (key: string) => string): string {
  switch (action) {
    case "review":
      return t("Review");
    case "merge":
      return t("Merge");
    case "supersede":
      return t("Supersede");
    case "disable":
      return t("Disable");
    case "archive":
      return t("Archive");
    case "add_validation":
      return t("Add validation");
    case "add_negative_triggers":
      return t("Add negative triggers");
    case "reject_candidate":
      return t("Reject candidate");
  }
}

function isOpenSkillCandidateStatus(status: SkillCandidate["status"]): boolean {
  return status === "pending" || status === "needs_edit" || status === "approved_for_draft";
}

function isTerminalSkillCandidateStatus(status: SkillCandidate["status"]): boolean {
  return status === "published" || status === "rejected" || status === "quarantined" || status === "superseded" || status === "expired";
}

function skillCandidateGate(candidate: SkillCandidate, t: SettingsTranslator): {
  readonly labels: readonly string[];
  readonly approvalBlocked: boolean;
  readonly draftBlocked: boolean;
} {
  const labels: string[] = [];
  if (candidate.definition.negativeTriggers.length === 0) {
    labels.push(t("Missing negative triggers"));
  }
  if (candidate.definition.validationSteps.length === 0) {
    labels.push(t("Missing validation"));
  }
  if (candidate.safetyFindings.some((finding) => finding.severity === "critical")) {
    labels.push(t("Critical safety finding"));
  }
  const duplicateBlocking = candidate.duplicateAnalysis.decision === "update_existing" ||
    candidate.duplicateAnalysis.decision === "conflict_review" ||
    candidate.duplicateAnalysis.decision === "reject_duplicate";
  if (duplicateBlocking) {
    labels.push(t("Duplicate review required"));
  }
  return {
    labels: labels.length > 0 ? labels : [t("Draft gates clear")],
    approvalBlocked: candidate.definition.negativeTriggers.length === 0 ||
      candidate.definition.validationSteps.length === 0 ||
      candidate.safetyFindings.some((finding) => finding.severity === "critical"),
    draftBlocked: duplicateBlocking,
  };
}

function skillCandidateStatusLabel(status: SkillCandidate["status"], t: (key: string) => string): string {
  switch (status) {
    case "pending":
      return t("Pending");
    case "needs_edit":
      return t("Needs edit");
    case "approved_for_draft":
      return t("Approved for draft");
    case "published":
      return t("Published");
    case "rejected":
      return t("Rejected");
    case "quarantined":
      return t("Quarantined");
    case "superseded":
      return t("Superseded");
    case "expired":
      return t("Expired");
  }
}

function playbookCandidateStatusLabel(status: ChannelPlaybookCandidate["status"], t: (key: string) => string): string {
  switch (status) {
    case "draft":
      return t("Draft");
    case "active":
      return t("Active");
    case "cancelled":
      return t("Cancelled");
    case "stale":
      return t("Stale");
  }
}

function procedureObservationClusterStatusLabel(status: ProcedureObservationCluster["status"], t: (key: string) => string): string {
  switch (status) {
    case "collecting":
      return t("Collecting");
    case "ready_for_review":
      return t("Ready for review");
    case "blocked":
      return t("Blocked");
    case "routed_elsewhere":
      return t("Routed elsewhere");
  }
}

function procedureObservationClusterActionLabel(action: ProcedureObservationCluster["recommendedAction"], t: (key: string) => string): string {
  switch (action) {
    case "append_evidence":
      return t("Append evidence");
    case "create_skill_candidate":
      return t("Create skill candidate");
    case "create_channel_protocol_candidate":
      return t("Create channel protocol candidate");
    case "create_playbook_candidate":
      return t("Create playbook candidate");
    case "create_memory_candidate":
      return t("Create memory candidate");
    case "create_automation_candidate":
      return t("Create automation candidate");
    case "policy_review":
      return t("Policy review");
    case "dismiss":
      return t("Dismiss");
  }
}

function candidateRouteKindLabel(routeKind: ProcedureObservationCluster["routeKind"], t: (key: string) => string): string {
  switch (routeKind) {
    case "memory":
      return t("Memory");
    case "channel_protocol":
      return t("Channel protocol");
    case "playbook":
      return t("Playbook");
    case "automation":
      return t("Automation");
    case "skill":
      return t("Skill");
    case "approval_policy_review":
      return t("Approval policy review");
    case "reject":
      return t("Reject");
  }
}

function candidateRouteBlockerLabel(blocker: ProcedureObservationCluster["routeBlockers"][number], t: (key: string) => string): string {
  switch (blocker) {
    case "insufficient_evidence":
      return t("Insufficient evidence");
    case "one_off_preference":
      return t("One-off preference");
    case "missing_validation":
      return t("Missing validation");
    case "missing_negative_trigger":
      return t("Missing negative trigger");
    case "duplicate_existing_skill":
      return t("Duplicate existing skill");
    case "conflicts_with_pending_candidate":
      return t("Conflicts with pending candidate");
    case "permission_expansion":
      return t("Permission expansion");
    case "unsafe_or_secret_adjacent":
      return t("Secret-adjacent");
  }
}

function skillCandidateOriginLabel(origin: SkillCandidate["origin"], t: (key: string) => string): string {
  switch (origin) {
    case "ling-generated":
      return t("Ling generated");
    case "recording":
      return t("Recording");
    case "manual-draft":
      return t("Manual draft");
    case "import-overlay":
      return t("Import overlay");
  }
}

function skillDuplicateDecisionLabel(decision: SkillCandidate["duplicateAnalysis"]["decision"], t: (key: string) => string): string {
  switch (decision) {
    case "no_overlap":
      return t("No overlap");
    case "append_evidence":
      return t("Append evidence");
    case "update_existing":
      return t("Update existing");
    case "conflict_review":
      return t("Conflict review");
    case "reject_duplicate":
      return t("Reject duplicate");
  }
}

function skillCandidateReviewReason(action: SkillCandidateReviewAction, t: (key: string) => string): string {
  if (action === "approve_for_draft") {
    return t("Approved from Skill Candidate Review panel.");
  }
  if (action === "reject") {
    return t("Rejected from Skill Candidate Review panel.");
  }
  if (action === "request_changes") {
    return t("Changes requested from Skill Candidate Review panel.");
  }
  return t("Reviewed from Skill Candidate Review panel.");
}

function skillCandidateReviewMessage(action: SkillCandidateReviewAction, t: (key: string) => string): string {
  if (action === "approve_for_draft") {
    return t("Candidate approved for draft");
  }
  if (action === "reject") {
    return t("Candidate rejected");
  }
  if (action === "request_changes") {
    return t("Candidate marked needs edit");
  }
  return t("Candidate reviewed");
}

function playbookCandidateReviewReason(action: ChannelPlaybookCandidateReviewAction, t: (key: string) => string): string {
  return action === "approve"
    ? t("Approved from Playbook Candidate Review panel.")
    : t("Rejected from Playbook Candidate Review panel.");
}

function playbookCandidateReviewMessage(action: ChannelPlaybookCandidateReviewAction, t: (key: string) => string): string {
  return action === "approve" ? t("Playbook activated") : t("Playbook candidate rejected");
}

function boundTeammateNames(skillId: string, summaries: readonly TeammateSkillBindingSummary[]): readonly string[] {
  return summaries
    .filter((summary) => summary.bindings.some((binding) => binding.skillId === skillId && binding.enabled))
    .map((summary) => summary.teammate.displayName);
}
