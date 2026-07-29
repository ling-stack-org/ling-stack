import type {
  Channel,
  ChannelPlaybookCandidate,
  ProcedureObservationCluster,
  SkillCandidate,
} from "../../types.js";
import { isOpenSkillCandidateStatus, isTerminalSkillCandidateStatus } from "./skill-library-utils.js";

export type SkillReviewQueueFilter = "all" | "skill_candidates" | "clusters" | "playbooks";
export type SkillReviewQueueSortMode = "updated" | "name";
export type SkillEvolutionQueueView = "pending" | "generated" | "ignored";

interface SkillReviewQueueItemBase {
  readonly id: string;
  readonly kind: Exclude<SkillReviewQueueFilter, "all">;
  readonly updatedAt: string;
}

export interface SkillCandidateQueueItem extends SkillReviewQueueItemBase {
  readonly kind: "skill_candidates";
  readonly candidate: SkillCandidate;
}

export interface ProcedureClusterQueueItem extends SkillReviewQueueItemBase {
  readonly kind: "clusters";
  readonly cluster: ProcedureObservationCluster;
}

export interface PlaybookCandidateQueueItem extends SkillReviewQueueItemBase {
  readonly kind: "playbooks";
  readonly candidate: ChannelPlaybookCandidate;
}

export type SkillReviewQueueListItem = SkillCandidateQueueItem | ProcedureClusterQueueItem | PlaybookCandidateQueueItem;

export interface SkillReviewQueueProjection {
  readonly channelNames: ReadonlyMap<string, string>;
  readonly counts: Readonly<Record<SkillReviewQueueFilter, number>>;
  readonly queueItems: readonly SkillReviewQueueListItem[];
  readonly visibleItems: readonly SkillReviewQueueListItem[];
}

export function projectSkillReviewQueue({
  view,
  skillCandidates,
  clusters,
  playbookCandidates,
  channels,
  activeFilter,
  searchQuery,
  sortMode,
}: {
  readonly view: SkillEvolutionQueueView;
  readonly skillCandidates: readonly SkillCandidate[];
  readonly clusters: readonly ProcedureObservationCluster[];
  readonly playbookCandidates: readonly ChannelPlaybookCandidate[];
  readonly channels: readonly Channel[];
  readonly activeFilter: SkillReviewQueueFilter;
  readonly searchQuery: string;
  readonly sortMode: SkillReviewQueueSortMode;
}): SkillReviewQueueProjection {
  const channelNames = new Map(channels.map((channel) => [channel.id, channel.name]));
  const visibleSkillCandidates = skillCandidates.filter((candidate) => {
    if (view === "pending") return isOpenSkillCandidateStatus(candidate.status);
    if (view === "ignored") return isTerminalSkillCandidateStatus(candidate.status) && candidate.status !== "published";
    return false;
  });
  const visibleClusters = clusters.filter((cluster) => {
    if (view === "pending") return cluster.status === "ready_for_review";
    if (view === "ignored") return cluster.status === "blocked" || cluster.status === "routed_elsewhere";
    return false;
  }).sort(compareClusters);
  const visiblePlaybooks = sortPlaybookCandidates(playbookCandidates.filter((candidate) => {
    if (view === "pending") return candidate.status === "draft";
    if (view === "generated") return candidate.status === "active";
    return candidate.status === "cancelled" || candidate.status === "stale";
  }));

  const queueItems: SkillReviewQueueListItem[] = [
    ...visibleSkillCandidates.map((candidate): SkillCandidateQueueItem => ({
      id: `skill:${candidate.id}`,
      kind: "skill_candidates",
      updatedAt: candidate.updatedAt,
      candidate,
    })),
    ...visibleClusters.map((cluster): ProcedureClusterQueueItem => ({
      id: `cluster:${cluster.id}`,
      kind: "clusters",
      updatedAt: cluster.lastObservedAt,
      cluster,
    })),
    ...visiblePlaybooks.map((candidate): PlaybookCandidateQueueItem => ({
      id: `playbook:${candidate.id}`,
      kind: "playbooks",
      updatedAt: candidate.updatedAt,
      candidate,
    })),
  ];
  queueItems.sort((left, right) => sortMode === "name"
    ? skillReviewQueueItemTitle(left).localeCompare(skillReviewQueueItemTitle(right), undefined, { sensitivity: "base" })
    : right.updatedAt.localeCompare(left.updatedAt));

  const counts: Record<SkillReviewQueueFilter, number> = {
    all: queueItems.length,
    skill_candidates: visibleSkillCandidates.length,
    clusters: visibleClusters.length,
    playbooks: visiblePlaybooks.length,
  };
  const filteredItems = activeFilter === "all" ? queueItems : queueItems.filter((item) => item.kind === activeFilter);
  const normalizedQuery = searchQuery.trim().toLocaleLowerCase();
  const visibleItems = normalizedQuery
    ? filteredItems.filter((item) => skillReviewQueueSearchText(item, channelNames).includes(normalizedQuery))
    : filteredItems;
  return { channelNames, counts, queueItems, visibleItems };
}

function skillReviewQueueItemTitle(item: SkillReviewQueueListItem): string {
  if (item.kind === "clusters") return item.cluster.title;
  return item.candidate.title;
}

function skillReviewQueueSearchText(item: SkillReviewQueueListItem, channelNames: ReadonlyMap<string, string>): string {
  if (item.kind === "skill_candidates") return `${item.candidate.title} ${item.candidate.summary}`.toLocaleLowerCase();
  if (item.kind === "clusters") return `${item.cluster.title} ${item.cluster.summary}`.toLocaleLowerCase();
  return `${item.candidate.title} ${item.candidate.summary} ${channelNames.get(item.candidate.channelId) ?? ""}`.toLocaleLowerCase();
}

function compareClusters(left: ProcedureObservationCluster, right: ProcedureObservationCluster): number {
  const statusRank: Record<ProcedureObservationCluster["status"], number> = {
    ready_for_review: 0,
    blocked: 1,
    collecting: 2,
    routed_elsewhere: 3,
  };
  const rank = statusRank[left.status] - statusRank[right.status];
  return rank !== 0 ? rank : right.lastObservedAt.localeCompare(left.lastObservedAt);
}

function sortPlaybookCandidates(candidates: readonly ChannelPlaybookCandidate[]): readonly ChannelPlaybookCandidate[] {
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
}
