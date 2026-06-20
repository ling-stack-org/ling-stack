import type { ToolName } from "./shared.js";
import type { SkillApprovalProfile } from "./approvals.js";
import type { ProviderCapability } from "./providers.js";
import type { AiTeammateRoleKey } from "./teammates.js";

export type TeammateSkillBindingSource = "template" | "user";

export interface TeammateSkillBinding {
  readonly teammateId: string;
  readonly skillId: string;
  readonly source: TeammateSkillBindingSource;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type SkillWorkflowPhase =
  | "discover"
  | "plan"
  | "design"
  | "implement"
  | "review"
  | "test"
  | "secure"
  | "ship"
  | "document"
  | "operate";

export type SkillStateEffect =
  | "creates_plan"
  | "updates_plan"
  | "creates_task"
  | "updates_task"
  | "starts_run"
  | "requests_approval"
  | "creates_artifact"
  | "updates_docs"
  | "prepares_release";

export interface SkillDefinition {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly roleAffinity: readonly AiTeammateRoleKey[];
  readonly workflowPhase: SkillWorkflowPhase;
  readonly promptFragments: readonly string[];
  readonly requiredTools: readonly ToolName[];
  readonly requiredProviderCapabilities: readonly ProviderCapability[];
  readonly approvalProfile: SkillApprovalProfile;
  readonly stateEffects: readonly SkillStateEffect[];
}

export type SkillPackSource = "builtin" | "gstack" | "workspace" | "skill-directory" | "agents-md" | "custom";

export type SkillRegistryReviewStatus = "builtin" | "draft" | "published" | "disabled" | "archived";

export type SkillImportWarningSeverity = "info" | "warning" | "error";

export type SkillImportWarningCode =
  | "permission_like_instruction"
  | "secret_reference"
  | "external_send_claim"
  | "unknown_tool"
  | "unknown_provider_capability"
  | "unsupported_section"
  | "missing_metadata"
  | "duplicate_skill_id";

export interface SkillVisibility {
  readonly workspaceVisible: boolean;
  readonly ownerTeammateId?: string;
  readonly promotableToWorkspace: boolean;
}

export interface SkillRegistryEntry {
  readonly id: string;
  readonly workspaceId: string;
  readonly packId: string;
  readonly source: SkillPackSource;
  readonly sourcePath?: string;
  readonly version?: string;
  readonly checksum?: string;
  readonly definition: SkillDefinition;
  readonly visibility: SkillVisibility;
  readonly reviewStatus: SkillRegistryReviewStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type SkillHealthSeverity = "info" | "warning" | "critical";

export type SkillDuplicateDecision =
  | "no_overlap"
  | "append_evidence"
  | "update_existing"
  | "conflict_review"
  | "reject_duplicate";

export type SkillHealthFindingKind =
  | "duplicate_clusters"
  | "conflicting_triggers"
  | "shadowed_skill"
  | "never_used_skill"
  | "stale_candidate"
  | "high_failure_rate_skill"
  | "high_user_correction_skill"
  | "external_overlap_generated_skill"
  | "superseded_but_active"
  | "missing_validation_steps"
  | "missing_negative_triggers";

export type SkillHealthRecommendedAction =
  | "review"
  | "merge"
  | "supersede"
  | "disable"
  | "archive"
  | "add_validation"
  | "add_negative_triggers"
  | "reject_candidate";

export type SkillCandidateHealthStatus =
  | "pending"
  | "needs_edit"
  | "approved_for_draft"
  | "published"
  | "rejected"
  | "quarantined"
  | "superseded"
  | "expired";

export type SkillCandidateHealthOrigin =
  | "ling-generated"
  | "recording"
  | "manual-draft"
  | "import-overlay";

export type SkillCandidateOrigin = SkillCandidateHealthOrigin;
export type SkillCandidateStatus = SkillCandidateHealthStatus;

export type SkillCandidateProposedAction =
  | "create"
  | "update_existing"
  | "wrap_external"
  | "supersede";

export type SkillCandidateReviewAction =
  | "keep_pending"
  | "request_changes"
  | "approve_for_draft"
  | "reject"
  | "quarantine"
  | "supersede";

export type SkillCandidateReviewActor = "user" | "system";

export type SkillCandidateSourceRefType =
  | "skill"
  | "manual"
  | "message"
  | "decision"
  | "run"
  | "run-event"
  | "artifact"
  | "import"
  | "observation-job";

export interface SkillCandidateSourceRef {
  readonly type: SkillCandidateSourceRefType;
  readonly id: string;
  readonly label?: string;
  readonly url?: string;
}

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

export interface ProcedureObservationRequest {
  readonly id?: string;
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
}

export type ProcedureObservationJobTerminalStatus = "succeeded" | "failed" | "cancelled";

export interface ProcedureObservationJobRequest {
  readonly id?: string;
  readonly workspaceId?: string;
  readonly source: ProcedureObservationSource;
  readonly signals: readonly ProcedureObservationSignal[];
  readonly runId?: string;
  readonly messageId?: string;
  readonly reviewActionId?: string;
  readonly channelId?: string;
  readonly teammateId?: string;
  readonly taskId?: string;
  readonly selectedSkillId?: string;
  readonly terminalStatus?: ProcedureObservationJobTerminalStatus;
  readonly toolLabels?: readonly string[];
  readonly validationLabels?: readonly string[];
  readonly artifactRefs?: readonly string[];
  readonly userConfirmed: boolean;
  readonly destinationHint?: "skill" | "channel_protocol" | "playbook" | "automation" | "memory";
  readonly title: string;
  readonly summary: string;
  readonly normalizedGoal: string;
  readonly positiveTriggers?: readonly string[];
  readonly negativeTriggers?: readonly string[];
  readonly procedureSteps?: readonly ProcedureObservationStep[];
  readonly validationSteps?: readonly ProcedureObservationValidationStep[];
  readonly confidence?: ProcedureObservationConfidence;
  readonly reusableScore?: number;
}

export interface ProcedureObservationListResponse {
  readonly cwd: string;
  readonly observations: readonly ProcedureObservation[];
}

export interface ProcedureObservationClusterListResponse {
  readonly cwd: string;
  readonly clusters: readonly ProcedureObservationCluster[];
}

export interface ProcedureObservationClusterResponse {
  readonly cwd: string;
  readonly cluster: ProcedureObservationCluster;
  readonly observations: readonly ProcedureObservation[];
}

export interface CandidateGenerationDecisionListResponse {
  readonly cwd: string;
  readonly decisions: readonly CandidateGenerationDecision[];
}

export interface ProcedureObservationResponse {
  readonly cwd: string;
  readonly observation: ProcedureObservation;
  readonly route: CandidateRoute;
}

export type SkillCandidateObserveAction =
  | "candidate_created"
  | "evidence_recorded"
  | "routed_elsewhere"
  | "blocked";

export interface SkillCandidateObserveResponse {
  readonly cwd: string;
  readonly observation: ProcedureObservation;
  readonly route: CandidateRoute;
  readonly action: SkillCandidateObserveAction;
  readonly candidate?: SkillCandidate;
  readonly duplicateAnalysis?: SkillDuplicateAnalysis;
  readonly generationDecision?: CandidateGenerationDecision;
}

export interface ProcedureObservationJobResponse extends SkillCandidateObserveResponse {
  readonly jobKey: string;
  readonly reusedObservation: boolean;
}

export type SkillInvocationSuggestionBlocker =
  | "disabled_binding"
  | "missing_tools"
  | "missing_provider_capability"
  | "channel_policy"
  | "approval_mismatch"
  | SkillHealthFindingKind;

export interface SkillInvocationSuggestion {
  readonly skillId: string;
  readonly reason: string;
  readonly confidence: ProcedureObservationConfidence;
  readonly blockers: readonly SkillInvocationSuggestionBlocker[];
  readonly sourceRefs: readonly SkillCandidateSourceRef[];
}

export interface SkillInvocationSuggestionRequest {
  readonly teammateId: string;
  readonly channelId?: string;
  readonly providerPresetId?: string;
  readonly taskId?: string;
  readonly title?: string;
  readonly prompt?: string;
  readonly requestedSkillId?: string;
  readonly limit?: number;
}

export interface SkillInvocationSuggestionResponse {
  readonly cwd: string;
  readonly suggestions: readonly SkillInvocationSuggestion[];
}

export interface SkillCandidateProcedureStep {
  readonly title: string;
  readonly instruction?: string;
  readonly requiredTools?: readonly string[];
}

export interface SkillCandidateValidationStep {
  readonly title: string;
  readonly commandOrCheck?: string;
  readonly expectedResult?: string;
}

export interface SkillCandidateDraftDefinition {
  readonly workflowPhase: SkillWorkflowPhase | string;
  readonly positiveTriggers: readonly string[];
  readonly negativeTriggers: readonly string[];
  readonly procedureSteps: readonly SkillCandidateProcedureStep[];
  readonly validationSteps: readonly SkillCandidateValidationStep[];
  readonly requiredTools: readonly (ToolName | string)[];
  readonly requiredProviderCapabilities: readonly (ProviderCapability | string)[];
  readonly skillDefinition?: SkillDefinition;
}

export interface SkillCandidate {
  readonly id: string;
  readonly workspaceId: string;
  readonly origin: SkillCandidateOrigin;
  readonly targetSkillId?: string;
  readonly proposedAction: SkillCandidateProposedAction;
  readonly status: SkillCandidateStatus;
  readonly title: string;
  readonly summary: string;
  readonly definition: SkillCandidateDraftDefinition;
  readonly duplicateAnalysis: SkillDuplicateAnalysis;
  readonly safetyFindings: readonly SkillHealthFinding[];
  readonly sourceRefs: readonly SkillCandidateSourceRef[];
  readonly reviewNotes: readonly string[];
  readonly expiresAt?: string;
  readonly supersededBy?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateSkillCandidateRequest {
  readonly id?: string;
  readonly origin?: SkillCandidateOrigin;
  readonly targetSkillId?: string;
  readonly proposedAction?: SkillCandidateProposedAction;
  readonly status?: SkillCandidateStatus;
  readonly title: string;
  readonly summary: string;
  readonly definition: SkillCandidateDraftDefinition;
  readonly duplicateAnalysis?: SkillDuplicateAnalysis;
  readonly safetyFindings?: readonly SkillHealthFinding[];
  readonly sourceRefs: readonly SkillCandidateSourceRef[];
  readonly reviewNotes?: readonly string[];
  readonly expiresAt?: string;
  readonly supersededBy?: string;
}

export interface SkillCandidateReviewRequest {
  readonly action: SkillCandidateReviewAction;
  readonly reason?: string;
  readonly supersededBy?: string;
}

export interface SkillCandidateReviewRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly candidateId: string;
  readonly action: SkillCandidateReviewAction;
  readonly actor: SkillCandidateReviewActor;
  readonly previousStatus: SkillCandidateStatus;
  readonly nextStatus: SkillCandidateStatus;
  readonly reason?: string;
  readonly createdAt: string;
}

export interface SkillCandidateListResponse {
  readonly cwd: string;
  readonly candidates: readonly SkillCandidate[];
}

export interface SkillCandidateResponse {
  readonly cwd: string;
  readonly candidate: SkillCandidate;
  readonly reviewRecords?: readonly SkillCandidateReviewRecord[];
}

export interface SkillCandidateReviewResponse {
  readonly cwd: string;
  readonly candidate: SkillCandidate;
  readonly action: SkillCandidateReviewRecord;
}

export interface SkillCandidateDraftResponse {
  readonly cwd: string;
  readonly candidate: SkillCandidate;
  readonly draft: SkillImportDraft;
}

export interface SkillCandidateHealthInput {
  readonly id: string;
  readonly workspaceId: string;
  readonly origin: SkillCandidateHealthOrigin;
  readonly status: SkillCandidateHealthStatus;
  readonly targetSkillId?: string;
  readonly title: string;
  readonly summary: string;
  readonly workflowPhase: SkillWorkflowPhase | string;
  readonly positiveTriggers: readonly string[];
  readonly negativeTriggers: readonly string[];
  readonly procedureSteps?: readonly {
    readonly title: string;
    readonly instruction?: string;
    readonly requiredTools?: readonly string[];
  }[];
  readonly validationSteps?: readonly {
    readonly title: string;
    readonly commandOrCheck?: string;
    readonly expectedResult?: string;
  }[];
  readonly requiredTools?: readonly (ToolName | string)[];
  readonly requiredProviderCapabilities?: readonly (ProviderCapability | string)[];
  readonly createdAt: string;
  readonly updatedAt?: string;
  readonly expiresAt?: string;
  readonly supersededBy?: string;
}

export interface SkillDuplicateAnalysis {
  readonly decision: SkillDuplicateDecision;
  readonly similarityScore: number;
  readonly matchedSkillIds: readonly string[];
  readonly matchedCandidateIds: readonly string[];
  readonly triggerOverlap: readonly string[];
  readonly conflictingFields: readonly string[];
  readonly rationale: string;
}

export interface SkillHealthFinding {
  readonly id: string;
  readonly kind: SkillHealthFindingKind;
  readonly severity: SkillHealthSeverity;
  readonly skillIds: readonly string[];
  readonly candidateIds: readonly string[];
  readonly title: string;
  readonly message: string;
  readonly recommendation: string;
  readonly recommendedAction: SkillHealthRecommendedAction;
}

export interface SkillHealthSummary {
  readonly totalSkills: number;
  readonly activeSkills: number;
  readonly generatedSkills: number;
  readonly pendingCandidates: number;
  readonly duplicateClusters: number;
  readonly conflictCount: number;
  readonly staleCandidates: number;
  readonly highFailureRateSkills: number;
  readonly findings: {
    readonly critical: number;
    readonly warning: number;
    readonly info: number;
  };
}

export interface SkillHealthReport {
  readonly workspaceId: string;
  readonly generatedAt: string;
  readonly staleCandidateDays: number;
  readonly summary: SkillHealthSummary;
  readonly findings: readonly SkillHealthFinding[];
}

export interface SkillHealthResponse {
  readonly cwd: string;
  readonly report: SkillHealthReport;
}

export type SkillUsageEventKind =
  | "selected"
  | "started"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "user_corrected"
  | "draft_created"
  | "published"
  | "superseded";

export interface SkillUsageEvent {
  readonly id: string;
  readonly workspaceId: string;
  readonly skillId?: string;
  readonly candidateId?: string;
  readonly runId?: string;
  readonly teammateId?: string;
  readonly channelId?: string;
  readonly kind: SkillUsageEventKind;
  readonly reason?: string;
  readonly createdAt: string;
}

export interface SkillUsageStats {
  readonly skillId: string;
  readonly useCount: number;
  readonly successCount: number;
  readonly failureCount: number;
  readonly cancelledCount: number;
  readonly correctionCount: number;
  readonly lastUsedAt?: string;
  readonly lastFailureAt?: string;
  readonly lastUserCorrectionAt?: string;
}

export interface SkillUsageEventListResponse {
  readonly cwd: string;
  readonly events: readonly SkillUsageEvent[];
}

export interface SkillUsageStatsListResponse {
  readonly cwd: string;
  readonly stats: readonly SkillUsageStats[];
}

export interface SkillCorrectionRequest {
  readonly reason?: string;
  readonly candidateId?: string;
  readonly runId?: string;
  readonly teammateId?: string;
  readonly channelId?: string;
}

export interface SkillCorrectionResponse {
  readonly cwd: string;
  readonly event: SkillUsageEvent;
}

export interface SkillImportWarning {
  readonly code: SkillImportWarningCode;
  readonly severity: SkillImportWarningSeverity;
  readonly message: string;
  readonly location?: string;
}

export interface SkillImportDraftDefinition {
  readonly definition: SkillDefinition;
  readonly visibility?: SkillVisibility;
  readonly warnings?: readonly SkillImportWarning[];
}

export interface SkillImportDraft {
  readonly id: string;
  readonly workspaceId: string;
  readonly source: SkillPackSource;
  readonly sourcePath?: string;
  readonly packId?: string;
  readonly name: string;
  readonly version?: string;
  readonly description: string;
  readonly definitions: readonly SkillImportDraftDefinition[];
  readonly warnings: readonly SkillImportWarning[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SkillRegistryListResponse {
  readonly cwd: string;
  readonly skills: readonly SkillRegistryEntry[];
}

export interface SkillRegistryRefreshResponse {
  readonly cwd: string;
  readonly refreshedAt: string;
  readonly registryGeneration: number;
  readonly skills: readonly SkillRegistryEntry[];
}

export interface SkillImportDraftRequest {
  readonly content: string;
  readonly source?: SkillPackSource;
  readonly sourcePath?: string;
  readonly name?: string;
}

export interface SkillImportDraftResponse {
  readonly cwd: string;
  readonly draft: SkillImportDraft;
}

export interface SkillImportPublishResponse {
  readonly cwd: string;
  readonly draftId: string;
  readonly skills: readonly SkillRegistryEntry[];
}

export interface SkillRegistryMutationResponse {
  readonly cwd: string;
  readonly skill: SkillRegistryEntry;
}

export type EffectiveSkillBlockedReasonCode =
  | "disabled_binding"
  | "missing_tools"
  | "missing_provider_capability"
  | "channel_policy"
  | "approval_mismatch";

export interface EffectiveSkillBlockedReason {
  readonly code: EffectiveSkillBlockedReasonCode;
  readonly message: string;
  readonly missing?: readonly string[];
}

export interface EffectiveTeammateSkill {
  readonly teammateId: string;
  readonly skillId: string;
  readonly skill: SkillDefinition;
  readonly binding: TeammateSkillBinding;
  readonly executable: boolean;
  readonly blockedReasons: readonly EffectiveSkillBlockedReason[];
  readonly promptFragments: readonly string[];
  readonly requiredTools: readonly ToolName[];
  readonly requiredProviderCapabilities: readonly ProviderCapability[];
}

export interface ReplaceTeammateSkillBindingsRequest {
  readonly bindings: readonly {
    readonly skillId: string;
    readonly source?: TeammateSkillBindingSource;
    readonly enabled?: boolean;
  }[];
}

export interface TeammateSkillBindingListResponse {
  readonly cwd: string;
  readonly teammateId: string;
  readonly bindings: readonly TeammateSkillBinding[];
  readonly effectiveSkills?: readonly EffectiveTeammateSkill[];
}
