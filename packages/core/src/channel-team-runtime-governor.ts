import { randomUUID } from "node:crypto";
import type {
  AgentObserverPlan,
  AttentionPlan,
  ChannelTeamRiskReviewDecision,
  ChannelTeamTurnMode,
  TeamRuntimePlan,
} from "./channel-team-types.js";

export interface ChannelTeamFallbackProviderRuntimeState {
  readonly available: boolean;
  readonly capabilityScopes?: readonly string[];
  readonly highRiskAllowed?: boolean;
  readonly reason?: string;
}

export interface BuildChannelTeamRuntimePlanInput {
  readonly id?: string;
  readonly attentionPlan: AttentionPlan;
  readonly riskReviewDecision?: ChannelTeamRiskReviewDecision;
  readonly fallbackProvider?: ChannelTeamFallbackProviderRuntimeState;
  readonly maxObservers?: number;
  readonly totalTimeoutMs?: number;
  readonly perAgentTimeoutMs?: number;
  readonly allowLateNotes?: boolean;
  readonly allowFallbackProvider?: boolean;
  readonly maxReadLeases?: number;
  readonly budgetClass?: TeamRuntimePlan["budgetClass"];
  readonly now: string;
}

interface RuntimeDefaults {
  readonly maxObservers: number;
  readonly totalTimeoutMs: number;
  readonly perAgentTimeoutMs: number;
  readonly allowLateNotes: boolean;
  readonly allowFallbackProvider: boolean;
  readonly maxReadLeases: number;
  readonly budgetClass: TeamRuntimePlan["budgetClass"];
}

const MAX_OBSERVERS = 8;
const MAX_TOTAL_TIMEOUT_MS = 30_000;
const MAX_PER_AGENT_TIMEOUT_MS = 10_000;
const MAX_READ_LEASES = 8;
const SKIPPED_AVAILABILITY_STATES = new Set(["offline", "overloaded", "rate_limited"]);

export function buildChannelTeamRuntimePlan(input: BuildChannelTeamRuntimePlanInput): TeamRuntimePlan {
  const defaults = runtimeDefaultsForTurnMode(input.attentionPlan.turnMode);
  const riskReviewStatus = input.riskReviewDecision?.status ?? "not_required";
  const riskReviewRequired = riskReviewStatus !== "not_required";
  const maxObservers = clampInteger(input.maxObservers ?? defaults.maxObservers, 0, MAX_OBSERVERS);
  const totalTimeoutMs = clampInteger(input.totalTimeoutMs ?? defaults.totalTimeoutMs, 0, MAX_TOTAL_TIMEOUT_MS);
  const perAgentTimeoutMs = clampInteger(input.perAgentTimeoutMs ?? defaults.perAgentTimeoutMs, 0, MAX_PER_AGENT_TIMEOUT_MS);
  const allowLateNotes = input.allowLateNotes ?? defaults.allowLateNotes;
  const maxReadLeases = clampInteger(input.maxReadLeases ?? defaults.maxReadLeases, 0, MAX_READ_LEASES);
  const budgetClass = input.budgetClass ?? (riskReviewRequired ? "high" : defaults.budgetClass);
  const constraints: string[] = [];

  if (riskReviewRequired) {
    constraints.push(`risk_review_${riskReviewStatus}`);
    if (riskReviewStatus === "blocked") {
      constraints.push("risk_review_blocks_side_effects");
    }
  }

  const observerCandidates = orderObserversForRuntime(input.attentionPlan.observers, riskReviewRequired);
  const selectedObservers: AgentObserverPlan[] = [];
  const lateObserverIds: string[] = [];
  const skippedObserverIds: string[] = [];
  for (const observer of observerCandidates) {
    const availabilityState = observer.availabilityState;
    if (availabilityState && SKIPPED_AVAILABILITY_STATES.has(availabilityState)) {
      skippedObserverIds.push(observer.agentId);
      constraints.push(`observer_skipped_${availabilityState}:${observer.agentId}`);
      continue;
    }
    if (availabilityState === "slow" && !allowLateNotes) {
      skippedObserverIds.push(observer.agentId);
      constraints.push(`observer_skipped_slow:${observer.agentId}`);
      continue;
    }
    if (availabilityState === "slow") {
      lateObserverIds.push(observer.agentId);
      constraints.push(`observer_late_note_candidate:${observer.agentId}`);
    }
    if (selectedObservers.length >= maxObservers) {
      skippedObserverIds.push(observer.agentId);
      constraints.push(`observer_skipped_budget:${observer.agentId}`);
      continue;
    }
    selectedObservers.push(observer);
  }

  if (riskReviewRequired && !selectedObservers.some((observer) => observer.participationMode === "reviewer")) {
    constraints.push("risk_review_required_without_reviewer");
  }

  const allowFallbackProvider = resolveFallbackProviderAllowance({
    requested: input.allowFallbackProvider ?? defaults.allowFallbackProvider,
    fallbackProvider: input.fallbackProvider,
    observers: selectedObservers,
    riskReviewRequired,
    constraints,
  });

  return {
    id: input.id ?? `team_runtime_plan_${randomUUID()}`,
    channelId: input.attentionPlan.channelId,
    turnId: input.attentionPlan.turnId,
    turnMode: input.attentionPlan.turnMode,
    attentionPlanId: input.attentionPlan.id,
    maxObservers,
    totalTimeoutMs,
    perAgentTimeoutMs,
    allowLateNotes,
    allowFallbackProvider,
    maxReadLeases,
    budgetClass,
    observers: selectedObservers,
    lateObserverIds,
    skippedObserverIds,
    constraints: uniqueStrings(constraints),
    createdAt: input.now,
  };
}

function runtimeDefaultsForTurnMode(turnMode: ChannelTeamTurnMode): RuntimeDefaults {
  switch (turnMode) {
    case "quick_answer":
      return {
        maxObservers: 1,
        totalTimeoutMs: 900,
        perAgentTimeoutMs: 700,
        allowLateNotes: false,
        allowFallbackProvider: false,
        maxReadLeases: 0,
        budgetClass: "low",
      };
    case "safe_action":
      return {
        maxObservers: 3,
        totalTimeoutMs: 5_000,
        perAgentTimeoutMs: 1_500,
        allowLateNotes: false,
        allowFallbackProvider: false,
        maxReadLeases: 2,
        budgetClass: "high",
      };
    case "background_work":
      return {
        maxObservers: 4,
        totalTimeoutMs: 8_000,
        perAgentTimeoutMs: 2_000,
        allowLateNotes: true,
        allowFallbackProvider: true,
        maxReadLeases: 4,
        budgetClass: "high",
      };
    case "deep_review":
    default:
      return {
        maxObservers: 4,
        totalTimeoutMs: 6_000,
        perAgentTimeoutMs: 1_500,
        allowLateNotes: true,
        allowFallbackProvider: true,
        maxReadLeases: 3,
        budgetClass: "normal",
      };
  }
}

function orderObserversForRuntime(
  observers: readonly AgentObserverPlan[],
  riskReviewRequired: boolean,
): readonly AgentObserverPlan[] {
  return [...observers].sort((left, right) => {
    const priorityDelta = observerPriority(right, riskReviewRequired) - observerPriority(left, riskReviewRequired);
    return priorityDelta || observers.indexOf(left) - observers.indexOf(right);
  });
}

function observerPriority(observer: AgentObserverPlan, riskReviewRequired: boolean): number {
  if (riskReviewRequired && observer.participationMode === "reviewer") {
    return 3;
  }
  if (observer.participationMode === "specialist") {
    return 2;
  }
  return 1;
}

function resolveFallbackProviderAllowance(input: {
  readonly requested: boolean;
  readonly fallbackProvider?: ChannelTeamFallbackProviderRuntimeState;
  readonly observers: readonly AgentObserverPlan[];
  readonly riskReviewRequired: boolean;
  readonly constraints: string[];
}): boolean {
  if (!input.requested) {
    return false;
  }
  if (!input.fallbackProvider) {
    input.constraints.push("fallback_provider_unverified");
    return false;
  }
  if (!input.fallbackProvider.available) {
    input.constraints.push(input.fallbackProvider.reason ? `fallback_provider_unavailable:${input.fallbackProvider.reason}` : "fallback_provider_unavailable");
    return false;
  }
  if (input.riskReviewRequired && input.fallbackProvider.highRiskAllowed !== true) {
    input.constraints.push("fallback_provider_high_risk_scope_denied");
    return false;
  }
  const capabilityScopes = new Set(input.fallbackProvider.capabilityScopes ?? []);
  if (capabilityScopes.size > 0) {
    const missingScope = input.observers
      .flatMap((observer) => observer.matchedScopes ?? [])
      .find((scope) => !capabilityScopes.has(scope));
    if (missingScope) {
      input.constraints.push(`fallback_provider_capability_mismatch:${missingScope}`);
      return false;
    }
  }
  return true;
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}
