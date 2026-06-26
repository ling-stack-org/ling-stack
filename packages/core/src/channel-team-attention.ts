import { randomUUID } from "node:crypto";
import type {
  AgentAvailabilityState,
  AgentCapabilityManifest,
  AgentObserverPlan,
  AgentQualityState,
  AttentionPlan,
  ChannelParticipationMode,
  ChannelTeamFeatureFlags,
  ChannelTeamTurnMode,
  ChannelTeamTurnSignal,
  ChannelTeamEvidenceSourceRef,
  CreateChannelTeamEvidenceItemInput,
} from "./channel-team-types.js";

export interface ChannelTeamAttentionCandidate {
  readonly agentId: string;
  readonly participationMode?: ChannelParticipationMode;
  readonly capabilityManifest?: AgentCapabilityManifest;
  readonly availabilityState?: AgentAvailabilityState;
  readonly qualityState?: AgentQualityState;
  readonly isDefault?: boolean;
}

export interface BuildChannelTeamAttentionPlanInput {
  readonly id?: string;
  readonly channelId: string;
  readonly turnId: string;
  readonly turnMode: ChannelTeamTurnMode;
  readonly candidates: readonly ChannelTeamAttentionCandidate[];
  readonly signals?: readonly ChannelTeamTurnSignal[];
  readonly maxObservers?: number;
  readonly now: string;
  readonly flags?: ChannelTeamFeatureFlags;
}

export interface BuildAgentRelevanceCardEvidenceInput {
  readonly attentionPlan: AttentionPlan;
  readonly flags?: ChannelTeamFeatureFlags;
  readonly now: string;
}

interface ScoredCandidate {
  readonly candidate: ChannelTeamAttentionCandidate;
  readonly matchedScopes: readonly string[];
  readonly sourceRefs: readonly ChannelTeamEvidenceSourceRef[];
  readonly score: number;
  readonly reason: string;
}

const DEFAULT_MAX_OBSERVERS = 4;
const MAX_MAX_OBSERVERS = 8;
const PASSIVE_PARTICIPATION_MODES: readonly ChannelParticipationMode[] = ["observer", "specialist", "reviewer"];
const UNAVAILABLE_STATES: readonly AgentAvailabilityState[] = ["offline", "overloaded"];
const LOW_TRUST_STATES: readonly AgentQualityState[] = ["quarantined", "retired", "manual_only"];

export function buildChannelTeamAttentionPlan(input: BuildChannelTeamAttentionPlanInput): AttentionPlan {
  if (input.flags?.attentionPlanEnabled !== true) {
    return emptyAttentionPlan(input);
  }

  const signals = normalizeSignals(input.signals ?? []);
  const observers = input.candidates
    .map((candidate) => scoreCandidate(candidate, input.turnMode, signals))
    .filter((scored): scored is ScoredCandidate => scored !== undefined)
    .sort((left, right) => right.score - left.score || left.candidate.agentId.localeCompare(right.candidate.agentId))
    .slice(0, clampObserverLimit(input.maxObservers))
    .map((scored): AgentObserverPlan => ({
      agentId: scored.candidate.agentId,
      participationMode: safeParticipationMode(scored.candidate.participationMode),
      reason: scored.reason,
      sourceRefs: scored.sourceRefs,
      maxLevel: scored.candidate.capabilityManifest?.maxLeaseLevel ?? "L0",
      matchedScopes: scored.matchedScopes,
      availabilityState: scored.candidate.availabilityState,
      qualityState: scored.candidate.qualityState,
    }));

  return {
    id: input.id ?? `attention_plan_${randomUUID()}`,
    channelId: input.channelId,
    turnId: input.turnId,
    turnMode: input.turnMode,
    observers,
    riskSignals: signals.filter((signal) => signal.kind === "risk").map((signal) => signal.scope),
    createdAt: input.now,
  };
}

export function buildAgentRelevanceCardEvidenceInputs(
  input: BuildAgentRelevanceCardEvidenceInput,
): CreateChannelTeamEvidenceItemInput[] {
  if (input.flags?.agentRelevanceCardsEnabled !== true) {
    return [];
  }
  return input.attentionPlan.observers.map((observer) => ({
    id: `channel_team_evidence_relevance_${randomUUID()}`,
    channelId: input.attentionPlan.channelId,
    turnId: input.attentionPlan.turnId,
    agentId: observer.agentId,
    kind: "agent_relevance_card",
    status: observer.availabilityState && UNAVAILABLE_STATES.includes(observer.availabilityState) ? "unavailable" : "completed",
    visibility: "internal",
    evidenceGrade: "inferred",
    summary: observer.reason,
    confidence: confidenceForObserver(observer),
    sourceRefs: observer.sourceRefs,
    payload: {
      attentionPlanId: input.attentionPlan.id,
      participationMode: observer.participationMode,
      maxLevel: observer.maxLevel,
      matchedScopes: observer.matchedScopes ?? [],
      availabilityState: observer.availabilityState,
      qualityState: observer.qualityState,
    },
  }));
}

function emptyAttentionPlan(input: BuildChannelTeamAttentionPlanInput): AttentionPlan {
  return {
    id: input.id ?? `attention_plan_${randomUUID()}`,
    channelId: input.channelId,
    turnId: input.turnId,
    turnMode: input.turnMode,
    observers: [],
    riskSignals: [],
    createdAt: input.now,
  };
}

function scoreCandidate(
  candidate: ChannelTeamAttentionCandidate,
  turnMode: ChannelTeamTurnMode,
  signals: readonly ChannelTeamTurnSignal[],
): ScoredCandidate | undefined {
  const participationMode = safeParticipationMode(candidate.participationMode);
  if (!PASSIVE_PARTICIPATION_MODES.includes(participationMode)) {
    return undefined;
  }
  if (candidate.availabilityState && UNAVAILABLE_STATES.includes(candidate.availabilityState)) {
    return undefined;
  }
  if (candidate.qualityState && LOW_TRUST_STATES.includes(candidate.qualityState)) {
    return undefined;
  }

  const manifest = candidate.capabilityManifest;
  const scopes = new Set(manifest?.capabilityScopes ?? []);
  const preferredTurnModes = new Set(manifest?.preferredTurnModes ?? []);
  const matchedSignals = signals.filter((signal) => scopes.has(signal.scope));
  const matchedScopes = [...new Set(matchedSignals.map((signal) => signal.scope))];
  const turnModeMatch = preferredTurnModes.has(turnMode);
  const defaultBoost = candidate.isDefault === true ? 0.25 : 0;
  const signalScore = matchedSignals.reduce((total, signal) => total + clampWeight(signal.weight), 0);
  const turnModeScore = turnModeMatch ? 0.75 : 0;
  const score = signalScore + turnModeScore + defaultBoost;

  if (score <= 0) {
    return undefined;
  }

  const sourceRefs = uniqueSourceRefs(matchedSignals.flatMap((signal) => signal.sourceRefs ?? []));
  return {
    candidate,
    matchedScopes,
    sourceRefs,
    score,
    reason: buildReason(candidate, matchedScopes, turnModeMatch, defaultBoost > 0),
  };
}

function buildReason(
  candidate: ChannelTeamAttentionCandidate,
  matchedScopes: readonly string[],
  turnModeMatch: boolean,
  isDefault: boolean,
): string {
  const fragments: string[] = [];
  if (matchedScopes.length > 0) {
    fragments.push(`matched ${matchedScopes.join(", ")}`);
  }
  if (turnModeMatch) {
    fragments.push("matches turn mode");
  }
  if (isDefault) {
    fragments.push("default channel specialist");
  }
  const summary = candidate.capabilityManifest?.summary;
  return summary ? `${summary}: ${fragments.join("; ")}` : fragments.join("; ");
}

function normalizeSignals(signals: readonly ChannelTeamTurnSignal[]): readonly ChannelTeamTurnSignal[] {
  if (signals.length > 0) {
    return signals.filter((signal) => signal.scope.trim().length > 0);
  }
  return [{ kind: "default", scope: "general", weight: 0.25 }];
}

function safeParticipationMode(mode: ChannelParticipationMode | undefined): ChannelParticipationMode {
  return mode ?? "observer";
}

function clampObserverLimit(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? DEFAULT_MAX_OBSERVERS, 0), MAX_MAX_OBSERVERS);
}

function clampWeight(weight: number | undefined): number {
  if (weight === undefined) {
    return 1;
  }
  if (!Number.isFinite(weight)) {
    return 0;
  }
  return Math.min(Math.max(weight, 0), 3);
}

function confidenceForObserver(observer: AgentObserverPlan): number {
  const matched = observer.matchedScopes?.length ?? 0;
  const base = matched > 0 ? 0.7 : 0.45;
  const availabilityPenalty = observer.availabilityState === "slow" || observer.availabilityState === "rate_limited" ? 0.15 : 0;
  const qualityPenalty = observer.qualityState === "watchlisted" || observer.qualityState === "degraded" ? 0.2 : 0;
  return Math.max(0.1, Math.min(0.95, base - availabilityPenalty - qualityPenalty));
}

function uniqueSourceRefs(sourceRefs: readonly ChannelTeamEvidenceSourceRef[]): readonly ChannelTeamEvidenceSourceRef[] {
  const selected: ChannelTeamEvidenceSourceRef[] = [];
  const seen = new Set<string>();
  for (const sourceRef of sourceRefs) {
    const key = `${sourceRef.type}:${sourceRef.id}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    selected.push(sourceRef);
  }
  return selected;
}
