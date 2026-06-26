import type {
  ChannelTeamEvidenceGrade,
  ChannelTeamEvidenceItem,
  ChannelTeamEvidenceSourceRef,
  ChannelTeamEvidenceStatus,
  CreateChannelTeamEvidenceItemInput,
  CreateSpecialistNoteEvidenceInput,
  FoldedExpertChip,
  FoldedExpertEvidenceEntry,
  FoldedExpertsReadModel,
} from "./channel-team-types.js";

export interface FoldChannelTeamEvidenceForTurnInput {
  readonly channelId: string;
  readonly turnId: string;
  readonly evidence: readonly ChannelTeamEvidenceItem[];
  readonly now?: string;
  readonly includeExpired?: boolean;
}

const DEFAULT_SPECIALIST_NOTE_RETENTION_DAYS = 30;
const EVIDENCE_GRADE_RANK: Record<ChannelTeamEvidenceGrade, number> = {
  inferred: 1,
  observed: 2,
  inspected: 3,
  verified: 4,
  reproduced: 5,
};

export function buildSpecialistNoteEvidenceInput(
  input: CreateSpecialistNoteEvidenceInput,
): CreateChannelTeamEvidenceItemInput {
  return {
    id: input.id,
    channelId: input.channelId,
    turnId: input.turnId,
    agentId: input.agentId,
    kind: "specialist_note",
    status: input.status ?? "completed",
    visibility: input.visibility ?? "folded_evidence",
    evidenceGrade: input.evidenceGrade,
    summary: input.summary,
    concerns: input.concerns ?? [],
    recommendations: input.recommendations ?? [],
    confidence: input.confidence,
    sourceRefs: input.sourceRefs ?? [],
    payload: {
      ...input.payload,
      noteType: "specialist_note",
      hiddenReasoningStored: false,
    },
    expiresAt: input.expiresAt === null ? null : input.expiresAt ?? defaultExpiresAt(input.now, input.retentionDays),
  };
}

export function foldChannelTeamEvidenceForTurn(
  input: FoldChannelTeamEvidenceForTurnInput,
): FoldedExpertsReadModel {
  const entries = input.evidence
    .filter((item) => item.channelId === input.channelId)
    .filter((item) => item.turnId === input.turnId)
    .filter((item) => input.includeExpired === true || !isExpired(item.expiresAt, input.now))
    .map(toFoldedExpertEvidenceEntry)
    .sort(compareEntries);

  return {
    channelId: input.channelId,
    turnId: input.turnId,
    totalCount: entries.length,
    activeCount: countStatuses(entries, ["pending"]),
    completedCount: countStatuses(entries, ["completed", "adopted"]),
    delayedCount: countStatuses(entries, ["timeout", "unavailable"]),
    unavailableCount: countStatuses(entries, ["unavailable"]),
    adoptedCount: countStatuses(entries, ["adopted"]),
    rejectedCount: countStatuses(entries, ["rejected"]),
    statusCounts: statusCounts(entries),
    chips: buildFoldedExpertChips(entries),
    entries,
    latestUpdatedAt: entries[0]?.updatedAt,
  };
}

function toFoldedExpertEvidenceEntry(item: ChannelTeamEvidenceItem): FoldedExpertEvidenceEntry {
  return {
    id: item.id,
    agentId: item.agentId,
    kind: item.kind,
    status: item.status,
    visibility: item.visibility,
    evidenceGrade: item.evidenceGrade,
    summary: item.summary,
    concerns: item.concerns,
    recommendations: item.recommendations,
    confidence: item.confidence,
    sourceRefs: item.sourceRefs,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function buildFoldedExpertChips(entries: readonly FoldedExpertEvidenceEntry[]): readonly FoldedExpertChip[] {
  const byAgent = new Map<string, FoldedExpertEvidenceEntry[]>();
  for (const entry of entries) {
    if (!entry.agentId) {
      continue;
    }
    byAgent.set(entry.agentId, [...(byAgent.get(entry.agentId) ?? []), entry]);
  }

  return [...byAgent.entries()]
    .map(([agentId, agentEntries]) => {
      const sorted = [...agentEntries].sort(compareEntries);
      const latest = sorted[0];
      return {
        agentId,
        status: strongestStatus(sorted),
        evidenceCount: sorted.length,
        evidenceGrade: strongestEvidenceGrade(sorted),
        latestSummary: latest.summary,
        updatedAt: latest.updatedAt,
      };
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.agentId.localeCompare(right.agentId));
}

function strongestStatus(entries: readonly FoldedExpertEvidenceEntry[]): ChannelTeamEvidenceStatus {
  const statuses = entries.map((entry) => entry.status);
  if (statuses.includes("adopted")) {
    return "adopted";
  }
  if (statuses.includes("rejected")) {
    return "rejected";
  }
  if (statuses.includes("completed")) {
    return "completed";
  }
  if (statuses.includes("pending")) {
    return "pending";
  }
  if (statuses.includes("timeout")) {
    return "timeout";
  }
  if (statuses.includes("unavailable")) {
    return "unavailable";
  }
  return statuses[0] ?? "skipped";
}

function strongestEvidenceGrade(entries: readonly FoldedExpertEvidenceEntry[]): ChannelTeamEvidenceGrade | undefined {
  return entries
    .map((entry) => entry.evidenceGrade)
    .filter((grade): grade is ChannelTeamEvidenceGrade => grade !== undefined)
    .sort((left, right) => EVIDENCE_GRADE_RANK[right] - EVIDENCE_GRADE_RANK[left])[0];
}

function statusCounts(entries: readonly FoldedExpertEvidenceEntry[]): Partial<Record<ChannelTeamEvidenceStatus, number>> {
  const counts: Partial<Record<ChannelTeamEvidenceStatus, number>> = {};
  for (const entry of entries) {
    counts[entry.status] = (counts[entry.status] ?? 0) + 1;
  }
  return counts;
}

function countStatuses(
  entries: readonly FoldedExpertEvidenceEntry[],
  statuses: readonly ChannelTeamEvidenceStatus[],
): number {
  return entries.filter((entry) => statuses.includes(entry.status)).length;
}

function compareEntries(left: FoldedExpertEvidenceEntry, right: FoldedExpertEvidenceEntry): number {
  return right.updatedAt.localeCompare(left.updatedAt) ||
    right.createdAt.localeCompare(left.createdAt) ||
    left.id.localeCompare(right.id);
}

function isExpired(expiresAt: string | undefined, now: string | undefined): boolean {
  return Boolean(expiresAt && now && expiresAt <= now);
}

function defaultExpiresAt(now: string | undefined, retentionDays: number | undefined): string | undefined {
  if (!now) {
    return undefined;
  }
  const date = new Date(now);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  date.setUTCDate(date.getUTCDate() + (retentionDays ?? DEFAULT_SPECIALIST_NOTE_RETENTION_DAYS));
  return date.toISOString();
}
