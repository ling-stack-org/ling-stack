import type {
  AgentAvailabilityState,
  AgentLifecycleScopeState,
  AgentQualityState,
  AvailabilityIncident,
  ChannelTeamIncidentSeverity,
  ModelSignature,
  ReliabilityIncident,
} from "./channel-team-types.js";

export interface DeriveAgentLifecycleStateInput {
  readonly agentId: string;
  readonly capabilityScope: string;
  readonly reliabilityIncidents?: readonly ReliabilityIncident[];
  readonly availabilityIncidents?: readonly AvailabilityIncident[];
  readonly currentModelSignature?: ModelSignature;
  readonly previousModelSignature?: ModelSignature;
  readonly now: string;
}

const QUALITY_BLOCKING_STATES: readonly AgentQualityState[] = [
  "new",
  "warming_up",
  "watchlisted",
  "degraded",
  "quarantined",
  "manual_only",
  "retired",
];
const REVIEWER_BLOCKING_STATES: readonly AgentQualityState[] = ["quarantined", "manual_only", "retired"];
const AVAILABILITY_BLOCKING_STATES: readonly AgentAvailabilityState[] = ["offline", "overloaded"];
const AVAILABILITY_RANK: Record<AgentAvailabilityState, number> = {
  healthy: 0,
  unknown: 1,
  slow: 2,
  rate_limited: 3,
  overloaded: 4,
  offline: 5,
};

export function deriveAgentLifecycleState(input: DeriveAgentLifecycleStateInput): AgentLifecycleScopeState {
  const activeReliability = (input.reliabilityIncidents ?? [])
    .filter((incident) => incident.agentId === input.agentId)
    .filter((incident) => incident.capabilityScope === input.capabilityScope)
    .filter((incident) => !incident.recoveredAt)
    .filter((incident) => !isExpired(incident.expiresAt, input.now));
  const activeAvailability = (input.availabilityIncidents ?? [])
    .filter((incident) => !incident.agentId || incident.agentId === input.agentId)
    .filter((incident) => !isExpired(incident.expiresAt, input.now));
  const modelSignatureChanged = hasModelSignatureChanged(input.previousModelSignature, input.currentModelSignature);
  const qualityState = deriveQualityState(activeReliability, modelSignatureChanged);
  const availabilityState = deriveAvailabilityState(activeAvailability);
  const recoveryRequired = activeReliability.some((incident) => incident.recoveryRequired === true);
  const reviewerEligible = !REVIEWER_BLOCKING_STATES.includes(qualityState) && !AVAILABILITY_BLOCKING_STATES.includes(availabilityState);
  const highRiskReviewerEligible =
    reviewerEligible &&
    !QUALITY_BLOCKING_STATES.includes(qualityState) &&
    recoveryRequired !== true;

  return {
    agentId: input.agentId,
    capabilityScope: input.capabilityScope,
    qualityState,
    availabilityState,
    reviewerEligible,
    highRiskReviewerEligible,
    recoveryRequired,
    modelSignatureChanged,
    activeReliabilityIncidentIds: activeReliability.map((incident) => incident.id),
    activeAvailabilityIncidentIds: activeAvailability.map((incident) => incident.id),
    reasons: buildLifecycleReasons(activeReliability, activeAvailability, modelSignatureChanged),
    updatedAt: input.now,
  };
}

function deriveQualityState(
  incidents: readonly ReliabilityIncident[],
  modelSignatureChanged: boolean,
): AgentQualityState {
  if (incidents.some((incident) => incident.kind === "unsafe_suggestion" && severityRank(incident.severity) >= 4)) {
    return "quarantined";
  }
  if (incidents.some((incident) => severityRank(incident.severity) >= 3)) {
    return "degraded";
  }
  if (incidents.length > 0) {
    return "watchlisted";
  }
  return modelSignatureChanged ? "warming_up" : "active";
}

function deriveAvailabilityState(incidents: readonly AvailabilityIncident[]): AgentAvailabilityState {
  return incidents
    .map((incident) => incident.state)
    .sort((left, right) => AVAILABILITY_RANK[right] - AVAILABILITY_RANK[left])[0] ?? "healthy";
}

function buildLifecycleReasons(
  reliabilityIncidents: readonly ReliabilityIncident[],
  availabilityIncidents: readonly AvailabilityIncident[],
  modelSignatureChanged: boolean,
): readonly string[] {
  const reasons: string[] = [];
  if (modelSignatureChanged) {
    reasons.push("model_signature_changed");
  }
  for (const incident of reliabilityIncidents) {
    reasons.push(`reliability:${incident.kind}:${incident.severity ?? "medium"}`);
  }
  for (const incident of availabilityIncidents) {
    reasons.push(`availability:${incident.kind}:${incident.state}`);
  }
  return reasons;
}

function severityRank(severity: ChannelTeamIncidentSeverity | undefined): number {
  if (severity === "critical") {
    return 4;
  }
  if (severity === "high") {
    return 3;
  }
  if (severity === "medium" || severity === undefined) {
    return 2;
  }
  return 1;
}

function hasModelSignatureChanged(
  previous: ModelSignature | undefined,
  current: ModelSignature | undefined,
): boolean {
  if (!previous || !current) {
    return false;
  }
  return previous.providerPresetId !== current.providerPresetId ||
    previous.providerId !== current.providerId ||
    previous.model !== current.model ||
    previous.api !== current.api ||
    previous.promptHash !== current.promptHash ||
    previous.capabilityHash !== current.capabilityHash;
}

function isExpired(expiresAt: string | undefined, now: string): boolean {
  return Boolean(expiresAt && expiresAt <= now);
}
