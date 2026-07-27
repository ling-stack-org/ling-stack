import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getSkillSourceHealth,
  listAiTeammates,
  listChannelPlaybookCandidates,
  listChannels,
  listProcedureObservationClusters,
  listSkillCandidates,
  listSkillSourceArtifacts,
  listSkills,
  listTeammateSkills,
} from "../../api.js";
import type {
  Channel,
  ChannelPlaybookCandidate,
  ProcedureObservationCluster,
  SkillCandidate,
  SkillOptimizationPreview,
  SkillRegistryEntry,
  SkillSourceArtifact,
  SkillSourceSnapshot,
} from "../../types.js";
import type { SettingsTranslator, TeammateSkillBindingSummary } from "./skill-library-utils.js";
import {
  currentUserSkillCount,
  partitionSkillRegistry,
  type SkillEvolutionViewId,
  type SkillLibrarySectionId,
} from "./skill-library-view-models.js";

export function useSkillLibraryDataController({
  cwd,
  refreshToken,
  t,
}: {
  readonly cwd: string;
  readonly refreshToken: number;
  readonly t: SettingsTranslator;
}) {
  const [skills, setSkills] = useState<readonly SkillRegistryEntry[]>([]);
  const [skillSourceSnapshots, setSkillSourceSnapshots] = useState<readonly SkillSourceSnapshot[]>([]);
  const [skillSourceArtifacts, setSkillSourceArtifacts] = useState<readonly SkillSourceArtifact[]>([]);
  const [skillCandidates, setSkillCandidates] = useState<readonly SkillCandidate[]>([]);
  const [playbookCandidates, setPlaybookCandidates] = useState<readonly ChannelPlaybookCandidate[]>([]);
  const [channels, setChannels] = useState<readonly Channel[]>([]);
  const [observationClusters, setObservationClusters] = useState<readonly ProcedureObservationCluster[]>([]);
  const [bindingSummaries, setBindingSummaries] = useState<readonly TeammateSkillBindingSummary[]>([]);
  const [selectedSkillId, setSelectedSkillId] = useState("");
  const [activeSubsection, setActiveSubsection] = useState<SkillLibrarySectionId>("mine");
  const [evolutionView, setEvolutionView] = useState<SkillEvolutionViewId>("pending");
  const [skillOptimizationPreview, setSkillOptimizationPreview] = useState<SkillOptimizationPreview | undefined>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [sourceArtifactsLoading, setSourceArtifactsLoading] = useState(false);
  const [sourceArtifactError, setSourceArtifactError] = useState("");

  const refresh = useCallback(async (): Promise<boolean> => {
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd) {
      setLoadError(t("Workspace path is required."));
      setLoading(false);
      return false;
    }
    setLoading(true);
    try {
      const [skillsResponse, sourceHealth, clusters, candidates, channelResponse, teammateResponse] = await Promise.all([
        listSkills(workspaceCwd),
        getSkillSourceHealth(workspaceCwd, { limit: 100 }),
        listProcedureObservationClusters(workspaceCwd, { limit: 100 }),
        listSkillCandidates(workspaceCwd, { limit: 100 }),
        listChannels(workspaceCwd),
        listAiTeammates(workspaceCwd),
      ]);
      const visibleTeammates = teammateResponse.teammates.filter((teammate) => teammate.status !== "disabled" && !teammate.hidden);
      const [teammateSkills, playbooks] = await Promise.all([
        Promise.all(visibleTeammates.map(async (teammate) => ({
          teammate,
          bindings: (await listTeammateSkills(workspaceCwd, teammate.id)).bindings,
        }))),
        Promise.all(channelResponse.channels.map((channel) => listChannelPlaybookCandidates(workspaceCwd, channel.id, { limit: 100 }))),
      ]);
      setSkills(skillsResponse.skills);
      setSkillSourceSnapshots(sourceHealth.snapshots);
      setObservationClusters(clusters.clusters);
      setSkillCandidates(candidates.candidates);
      setPlaybookCandidates(playbooks.flatMap((response) => response.candidates));
      setChannels(channelResponse.channels);
      setBindingSummaries(teammateSkills);
      setLoadError("");
      return true;
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setLoading(false);
    }
  }, [cwd, t]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshToken]);

  const sourceSnapshotBySkillId = useMemo(() => new Map(
    skillSourceSnapshots
      .filter((snapshot) => snapshot.reviewStatus === "published")
      .map((snapshot) => [snapshot.skillId, snapshot]),
  ), [skillSourceSnapshots]);

  const sourceSnapshotHistoryBySkillId = useMemo(() => {
    const history = new Map<string, SkillSourceSnapshot[]>();
    for (const snapshot of skillSourceSnapshots.filter((item) => item.reviewStatus === "archived")) {
      history.set(snapshot.skillId, [...(history.get(snapshot.skillId) ?? []), snapshot]);
    }
    return history;
  }, [skillSourceSnapshots]);

  const ownershipPartition = useMemo(() => partitionSkillRegistry(skills), [skills]);
  const evolutionCount = useMemo(() => {
    const candidateCount = skillCandidates.filter((candidate) => candidate.status !== "published").length;
    const clusterCount = observationClusters.filter((cluster) => cluster.status !== "collecting").length;
    return ownershipPartition.evolved.filter((skill) => skill.reviewStatus !== "archived").length +
      candidateCount + clusterCount + playbookCandidates.length;
  }, [observationClusters, ownershipPartition.evolved, playbookCandidates, skillCandidates]);
  const selectedSkill = useMemo(
    () => selectedSkillId ? skills.find((entry) => entry.id === selectedSkillId) : undefined,
    [selectedSkillId, skills],
  );

  useEffect(() => {
    if (!selectedSkill && selectedSkillId) setSelectedSkillId("");
  }, [selectedSkill, selectedSkillId]);

  useEffect(() => {
    setSkillOptimizationPreview(undefined);
    setSourceArtifactError("");
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd || !selectedSkill?.id) {
      setSkillSourceArtifacts([]);
      setSourceArtifactsLoading(false);
      return undefined;
    }
    let cancelled = false;
    setSourceArtifactsLoading(true);
    void listSkillSourceArtifacts(workspaceCwd, selectedSkill.id)
      .then((response) => {
        if (!cancelled) setSkillSourceArtifacts(response.artifacts);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setSkillSourceArtifacts([]);
          setSourceArtifactError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!cancelled) setSourceArtifactsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, selectedSkill?.id, skillSourceSnapshots]);

  function changeSection(section: SkillLibrarySectionId): void {
    setActiveSubsection(section);
    setSelectedSkillId("");
  }

  function changeEvolutionView(view: SkillEvolutionViewId): void {
    setEvolutionView(view);
    setSelectedSkillId("");
  }

  return {
    cwd: cwd.trim(),
    skills,
    setSkills,
    skillCandidates,
    setSkillCandidates,
    playbookCandidates,
    setPlaybookCandidates,
    channels,
    observationClusters,
    bindingSummaries,
    selectedSkillId,
    selectedSkill,
    setSelectedSkillId,
    activeSubsection,
    changeSection,
    evolutionView,
    setEvolutionView,
    changeEvolutionView,
    ownershipPartition,
    currentUserCount: currentUserSkillCount(skills),
    evolutionCount,
    sourceSnapshotBySkillId,
    sourceSnapshotHistoryBySkillId,
    skillSourceArtifacts,
    sourceArtifactsLoading,
    sourceArtifactError,
    skillOptimizationPreview,
    setSkillOptimizationPreview,
    loading,
    loadError,
    setLoadError,
    refresh,
  } as const;
}

export type SkillLibraryDataController = ReturnType<typeof useSkillLibraryDataController>;
