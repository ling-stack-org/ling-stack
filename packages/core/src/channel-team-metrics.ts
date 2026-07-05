import type {
  AvailabilityIncident,
  ChannelEvidenceSummaryProjection,
  ChannelTeamAgentMetric,
  ChannelTeamAttentionMetric,
  ChannelTeamEvidenceItem,
  ChannelTeamEvidenceKind,
  ChannelTeamEvidenceStatus,
  ChannelTeamHealthState,
  ChannelTeamLearningQueueMetric,
  ChannelTeamMetricsProjection,
  ChannelTeamMetricsSummary,
  ChannelTeamPattern,
  ChannelTeamRiskReviewMetric,
  ReliabilityIncident,
} from "./channel-team-types.js";
import { isActiveChannelTeamProvisionalRule } from "./channel-team-patterns.js";

export interface BuildChannelTeamMetricsProjectionInput {
  readonly channelId: string;
  readonly evidence: readonly ChannelTeamEvidenceItem[];
  readonly reliabilityIncidents?: readonly ReliabilityIncident[];
  readonly availabilityIncidents?: readonly AvailabilityIncident[];
  readonly patterns?: readonly ChannelTeamPattern[];
  readonly visibleEvidence?: ChannelEvidenceSummaryProjection;
  readonly now: string;
}

export function buildChannelTeamMetricsProjection(
  input: BuildChannelTeamMetricsProjectionInput,
): ChannelTeamMetricsProjection {
  const evidence = input.evidence.filter((item) => item.channelId === input.channelId);
  const patterns = (input.patterns ?? []).filter((pattern) => pattern.channelId === input.channelId);
  const reliabilityIncidents = (input.reliabilityIncidents ?? []).filter((incident) => !incident.recoveredAt);
  const availabilityIncidents = input.availabilityIncidents ?? [];
  const summary = buildSummary(evidence, reliabilityIncidents, availabilityIncidents);
  const agents = buildAgentMetrics(evidence, reliabilityIncidents);
  return {
    channelId: input.channelId,
    generatedAt: input.now,
    ...(input.visibleEvidence ? { visibleEvidence: input.visibleEvidence } : {}),
    summary,
    agents,
    attention: buildAttentionMetric(evidence),
    riskReview: buildRiskReviewMetric(evidence, reliabilityIncidents),
    learningQueue: buildLearningQueueMetric(evidence, patterns, input.now),
  };
}

function buildSummary(
  evidence: readonly ChannelTeamEvidenceItem[],
  reliabilityIncidents: readonly ReliabilityIncident[],
  availabilityIncidents: readonly AvailabilityIncident[],
): ChannelTeamMetricsSummary {
  const activeEvidenceCount = evidence.filter((item) => item.status === "pending").length;
  const delayedEvidenceCount = evidence.filter((item) => item.status === "timeout" || item.status === "expired").length;
  const unavailableEvidenceCount = evidence.filter((item) => item.status === "unavailable").length;
  const healthState = deriveHealthState({
    delayedEvidenceCount,
    unavailableEvidenceCount,
    reliabilityIncidents,
    availabilityIncidents,
  });
  return {
    healthState,
    totalEvidenceCount: evidence.length,
    activeEvidenceCount,
    delayedEvidenceCount,
    unavailableEvidenceCount,
    reliabilityIncidentCount: reliabilityIncidents.length,
    availabilityIncidentCount: availabilityIncidents.length,
    latestUpdatedAt: latestTimestamp([
      ...evidence.map((item) => item.updatedAt),
      ...reliabilityIncidents.map((item) => item.updatedAt ?? item.createdAt),
      ...availabilityIncidents.map((item) => item.updatedAt ?? item.observedAt),
    ]),
  };
}

function buildAgentMetrics(
  evidence: readonly ChannelTeamEvidenceItem[],
  reliabilityIncidents: readonly ReliabilityIncident[],
): readonly ChannelTeamAgentMetric[] {
  const byAgent = new Map<string, ChannelTeamEvidenceItem[]>();
  for (const item of evidence) {
    const agentId = item.agentId ?? "unassigned";
    byAgent.set(agentId, [...(byAgent.get(agentId) ?? []), item]);
  }
  for (const incident of reliabilityIncidents) {
    if (!byAgent.has(incident.agentId)) {
      byAgent.set(incident.agentId, []);
    }
  }
  return [...byAgent.entries()]
    .map(([agentId, items]) => {
      const sorted = [...items].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      return {
        agentId,
        evidenceCount: items.length,
        completedCount: countStatus(items, "completed"),
        delayedCount: items.filter((item) => item.status === "timeout" || item.status === "expired").length,
        unavailableCount: countStatus(items, "unavailable"),
        adoptedCount: countStatus(items, "adopted"),
        rejectedCount: countStatus(items, "rejected"),
        reliabilityIncidentCount: reliabilityIncidents.filter((incident) => incident.agentId === agentId).length,
        latestSummary: sorted[0]?.summary,
        latestUpdatedAt: latestTimestamp([
          ...items.map((item) => item.updatedAt),
          ...reliabilityIncidents
            .filter((incident) => incident.agentId === agentId)
            .map((incident) => incident.updatedAt ?? incident.createdAt),
        ]),
      };
    })
    .sort((left, right) =>
      right.reliabilityIncidentCount - left.reliabilityIncidentCount ||
      right.unavailableCount - left.unavailableCount ||
      right.delayedCount - left.delayedCount ||
      right.evidenceCount - left.evidenceCount ||
      left.agentId.localeCompare(right.agentId),
    );
}

function buildAttentionMetric(evidence: readonly ChannelTeamEvidenceItem[]): ChannelTeamAttentionMetric {
  return {
    activeAgentCount: new Set(evidence.map((item) => item.agentId).filter(Boolean)).size,
    evidenceKindCounts: countBy(evidence.map((item) => item.kind)),
    evidenceStatusCounts: countBy(evidence.map((item) => item.status)),
  };
}

function buildRiskReviewMetric(
  evidence: readonly ChannelTeamEvidenceItem[],
  reliabilityIncidents: readonly ReliabilityIncident[],
): ChannelTeamRiskReviewMetric {
  return {
    riskSignalCount: evidence.filter((item) => item.kind === "risk_signal").length,
    dissentSignalCount: evidence.filter((item) => item.kind === "dissent_signal").length,
    openReliabilityIncidentCount: reliabilityIncidents.length,
    openCriticalReliabilityIncidentCount: reliabilityIncidents.filter((incident) => incident.severity === "critical").length,
  };
}

function buildLearningQueueMetric(
  evidence: readonly ChannelTeamEvidenceItem[],
  patterns: readonly ChannelTeamPattern[],
  now: string,
): ChannelTeamLearningQueueMetric {
  return {
    recommendationEvidenceCount:
      evidence.filter((item) => item.recommendations.length > 0).length +
      patterns.filter((pattern) => pattern.status === "candidate").length,
    adoptedEvidenceCount:
      evidence.filter((item) => item.status === "adopted").length +
      patterns.filter((pattern) => pattern.status === "approved").length,
    rejectedEvidenceCount:
      evidence.filter((item) => item.status === "rejected").length +
      patterns.filter((pattern) => pattern.status === "rejected").length,
    provisionalRuleCount: patterns.filter((pattern) => isActiveChannelTeamProvisionalRule(pattern, now)).length,
    note: "Pattern Store is inspect-only here; provisional rules stay TTL-bound and do not promote to protocol or memory automatically.",
  };
}

function deriveHealthState(input: {
  readonly delayedEvidenceCount: number;
  readonly unavailableEvidenceCount: number;
  readonly reliabilityIncidents: readonly ReliabilityIncident[];
  readonly availabilityIncidents: readonly AvailabilityIncident[];
}): ChannelTeamHealthState {
  if (
    input.reliabilityIncidents.some((incident) => incident.severity === "critical" || incident.severity === "high") ||
    input.availabilityIncidents.some((incident) => incident.state === "offline" || incident.state === "overloaded") ||
    input.unavailableEvidenceCount > 0
  ) {
    return "degraded";
  }
  if (input.reliabilityIncidents.length > 0 || input.availabilityIncidents.length > 0 || input.delayedEvidenceCount > 0) {
    return "attention_needed";
  }
  return "healthy";
}

function countStatus(items: readonly ChannelTeamEvidenceItem[], status: ChannelTeamEvidenceStatus): number {
  return items.filter((item) => item.status === status).length;
}

function countBy<T extends ChannelTeamEvidenceKind | ChannelTeamEvidenceStatus>(values: readonly T[]): Partial<Record<T, number>> {
  const counts: Partial<Record<T, number>> = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function latestTimestamp(values: readonly (string | undefined)[]): string | undefined {
  return values.filter((value): value is string => Boolean(value)).sort().at(-1);
}
