import type {
  ChannelTeamEvidenceItem,
  ChannelTeamPattern,
  CreateChannelTeamPatternInput,
} from "./channel-team-types.js";

export interface BuildChannelTeamPatternCandidateInput {
  readonly channelId: string;
  readonly pattern: string;
  readonly summary: string;
  readonly evidence: readonly ChannelTeamEvidenceItem[];
  readonly now: string;
  readonly expiresAt?: string;
}

const FAILURE_STATUSES = new Set(["timeout", "unavailable", "rejected"]);

export function buildChannelTeamPatternCandidateFromEvidence(
  input: BuildChannelTeamPatternCandidateInput,
): CreateChannelTeamPatternInput | undefined {
  const evidence = input.evidence.filter((item) => item.channelId === input.channelId);
  if (evidence.length === 0) {
    return undefined;
  }
  return {
    channelId: input.channelId,
    pattern: input.pattern,
    summary: input.summary,
    evidenceCount: evidence.length,
    adoptedCount: evidence.filter((item) => item.status === "adopted").length,
    failureCount: evidence.filter((item) => FAILURE_STATUSES.has(item.status)).length,
    sourceRefs: evidence.flatMap((item) => item.sourceRefs),
    status: "candidate",
    createdBy: "system",
    verifyBeforeUse: evidence.some((item) => item.sourceRefs.length === 0),
    lastSeenAt: latestTimestamp(evidence.map((item) => item.updatedAt)) ?? input.now,
    expiresAt: input.expiresAt,
  };
}

export function isActiveChannelTeamProvisionalRule(pattern: ChannelTeamPattern, now: string): boolean {
  return pattern.status === "provisional" &&
    Boolean(pattern.provisionalEffect) &&
    (!pattern.expiresAt || pattern.expiresAt > now);
}

function latestTimestamp(values: readonly string[]): string | undefined {
  return [...values].sort().at(-1);
}
