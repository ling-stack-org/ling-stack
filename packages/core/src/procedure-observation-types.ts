import { createHash, randomUUID } from "node:crypto";
import type { SkillDuplicateDecision } from "./skill-health.js";
import type { SkillCandidateSourceRef } from "./skill-candidate-types.js";

export type ProcedureObservationSource =
  | "explicit_user_request"
  | "user_correction"
  | "successful_tool_chain"
  | "repeated_pattern"
  | "workflow_step_output"
  | "multi_agent_handoff"
  | "manual_recording";

export type ProcedureObservationSignal =
  | "save_as_skill"
  | "next_time_instruction"
  | "correction_phrase"
  | "long_successful_sequence"
  | "same_sequence_repeated"
  | "handoff_stabilized"
  | "user_approved_recording";

export type ProcedureObservationConfidence = "low" | "medium" | "high";

export interface ProcedureObservationStep {
  readonly title: string;
  readonly instruction?: string;
  readonly requiredTools?: readonly string[];
  readonly expectedEvidence?: string;
}

export interface ProcedureObservationValidationStep {
  readonly title: string;
  readonly commandOrCheck?: string;
  readonly expectedResult?: string;
}

export type CandidateRouteKind =
  | "memory"
  | "channel_protocol"
  | "playbook"
  | "automation"
  | "skill"
  | "approval_policy_review"
  | "reject";

export type CandidateRouteBlocker =
  | "insufficient_evidence"
  | "one_off_preference"
  | "missing_validation"
  | "missing_negative_trigger"
  | "duplicate_existing_skill"
  | "conflicts_with_pending_candidate"
  | "permission_expansion"
  | "unsafe_or_secret_adjacent";

export interface CandidateRoute {
  readonly kind: CandidateRouteKind;
  readonly reasonCode: string;
  readonly confidence: ProcedureObservationConfidence;
  readonly blockers: readonly CandidateRouteBlocker[];
}

export interface ProcedureObservation {
  readonly id: string;
  readonly workspaceId: string;
  readonly clusterId: string;
  readonly channelId?: string;
  readonly teammateId?: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly source: ProcedureObservationSource;
  readonly signals: readonly ProcedureObservationSignal[];
  readonly title: string;
  readonly summary: string;
  readonly normalizedGoal: string;
  readonly positiveTriggers: readonly string[];
  readonly negativeTriggers: readonly string[];
  readonly procedureSteps: readonly ProcedureObservationStep[];
  readonly validationSteps: readonly ProcedureObservationValidationStep[];
  readonly sourceRefs: readonly SkillCandidateSourceRef[];
  readonly confidence: ProcedureObservationConfidence;
  readonly reusableScore: number;
  readonly routeKind?: CandidateRouteKind;
  readonly routeReasonCode?: string;
  readonly routeBlockers: readonly CandidateRouteBlocker[];
  readonly createdAt: string;
}

export type ProcedureObservationClusterStatus =
  | "collecting"
  | "ready_for_review"
  | "blocked"
  | "routed_elsewhere";

export type ProcedureObservationClusterRecommendedAction =
  | "append_evidence"
  | "create_skill_candidate"
  | "create_channel_protocol_candidate"
  | "create_playbook_candidate"
  | "create_memory_candidate"
  | "create_automation_candidate"
  | "policy_review"
  | "dismiss";

export interface ProcedureObservationCluster {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId?: string;
  readonly routeKind: CandidateRouteKind;
  readonly routeReasonCode?: string;
  readonly status: ProcedureObservationClusterStatus;
  readonly recommendedAction: ProcedureObservationClusterRecommendedAction;
  readonly title: string;
  readonly summary: string;
  readonly normalizedGoal: string;
  readonly observationCount: number;
  readonly confidence: ProcedureObservationConfidence;
  readonly reusableScore: number;
  readonly positiveTriggers: readonly string[];
  readonly negativeTriggers: readonly string[];
  readonly routeBlockers: readonly CandidateRouteBlocker[];
  readonly sourceRefs: readonly SkillCandidateSourceRef[];
  readonly firstObservedAt: string;
  readonly lastObservedAt: string;
}

export type CandidateGenerationDecisionSource =
  | "explicit_user_save"
  | "approved_recording"
  | "post_run_terminal"
  | "selected_transcript_snippet"
  | "workflow_fanin"
  | "correction_health";

export type CandidateGenerationDecisionAction =
  | "append_evidence"
  | "create_skill_candidate"
  | "create_channel_protocol_candidate"
  | "create_playbook_candidate"
  | "create_memory_candidate"
  | "create_automation_candidate"
  | "policy_review"
  | "reject";

export interface CandidateGenerationDecision {
  readonly id: string;
  readonly workspaceId: string;
  readonly observationId: string;
  readonly clusterId: string;
  readonly source: CandidateGenerationDecisionSource;
  readonly route: CandidateRoute;
  readonly decision: CandidateGenerationDecisionAction;
  readonly blockers: readonly CandidateRouteBlocker[];
  readonly duplicateDecision?: SkillDuplicateDecision;
  readonly reason: string;
  readonly createdCandidateId?: string;
  readonly createdAt: string;
}

export interface CreateCandidateGenerationDecisionInput {
  readonly id?: string;
  readonly workspaceId?: string;
  readonly observationId: string;
  readonly clusterId: string;
  readonly source: CandidateGenerationDecisionSource;
  readonly route: CandidateRoute;
  readonly decision: CandidateGenerationDecisionAction;
  readonly blockers?: readonly CandidateRouteBlocker[];
  readonly duplicateDecision?: SkillDuplicateDecision;
  readonly reason: string;
  readonly createdCandidateId?: string;
}

export interface ListCandidateGenerationDecisionsOptions {
  readonly workspaceId?: string;
  readonly observationId?: string;
  readonly clusterId?: string;
  readonly decision?: CandidateGenerationDecisionAction;
  readonly limit?: number;
}

export interface CreateProcedureObservationInput {
  readonly id?: string;
  readonly workspaceId?: string;
  readonly clusterId?: string;
  readonly channelId?: string;
  readonly teammateId?: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly source: ProcedureObservationSource;
  readonly signals: readonly ProcedureObservationSignal[];
  readonly title: string;
  readonly summary: string;
  readonly normalizedGoal: string;
  readonly positiveTriggers?: readonly string[];
  readonly negativeTriggers?: readonly string[];
  readonly procedureSteps?: readonly ProcedureObservationStep[];
  readonly validationSteps?: readonly ProcedureObservationValidationStep[];
  readonly sourceRefs: readonly SkillCandidateSourceRef[];
  readonly confidence?: ProcedureObservationConfidence;
  readonly reusableScore?: number;
  readonly route?: CandidateRoute;
}

export interface ListProcedureObservationsOptions {
  readonly workspaceId?: string;
  readonly clusterId?: string;
  readonly channelId?: string;
  readonly routeKind?: CandidateRouteKind;
  readonly limit?: number;
}

export interface ListProcedureObservationClustersOptions {
  readonly workspaceId?: string;
  readonly channelId?: string;
  readonly routeKind?: CandidateRouteKind;
  readonly status?: ProcedureObservationClusterStatus;
  readonly limit?: number;
}

export function createProcedureObservationId(): string {
  return `procedure_observation_${randomUUID()}`;
}

export function createCandidateGenerationDecisionId(): string {
  return `candidate_generation_decision_${randomUUID()}`;
}

export function createProcedureObservationClusterId(input: {
  readonly workspaceId: string;
  readonly routeHint?: string;
  readonly scopeHint?: string;
  readonly normalizedGoal: string;
  readonly positiveTriggers?: readonly string[];
  readonly procedureSteps?: readonly ProcedureObservationStep[];
}): string {
  const payload = [
    normalizeSignaturePart(input.workspaceId),
    normalizeSignaturePart(input.routeHint ?? "unknown"),
    normalizeSignaturePart(input.scopeHint ?? "workspace"),
    normalizeSignaturePart(input.normalizedGoal),
    signatureForStrings(input.positiveTriggers ?? []),
    signatureForStrings((input.procedureSteps ?? []).map((step) => step.title)),
    signatureForStrings((input.procedureSteps ?? []).flatMap((step) => step.requiredTools ?? [])),
  ].join("|");
  return `procedure_cluster_${createHash("sha256").update(payload).digest("hex").slice(0, 24)}`;
}

function signatureForStrings(values: readonly string[]): string {
  return [...new Set(values.map(normalizeSignaturePart).filter(Boolean))].sort().join(",");
}

function normalizeSignaturePart(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}
