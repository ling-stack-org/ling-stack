import type { ToolName } from "./shared.js";
import type { SkillApprovalProfile } from "./approvals.js";
import type { ProviderCapability } from "./providers.js";
import type { AiTeammateRoleKey } from "./teammates.js";
import type { SkillGovernanceGenerationMode, SkillGovernanceRecordingMode } from "./settings.js";

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

export type SkillSourceKind =
  | "gstack-skill-directory"
  | "codex-skill-directory"
  | "workspace-skill-directory"
  | "manual-markdown";

export type SkillSourceSnapshotReviewStatus = "draft" | "reviewed" | "published" | "archived";

export type SkillSourceFileKind = "script" | "asset" | "reference" | "agent-metadata" | "other";

export type SkillSourceWarningSeverity = "info" | "warning" | "error";

export type SkillSourceArtifactReviewStatus = "draft" | "reviewed" | "published" | "archived";

export type SkillSourceUpgradeMode = "manual" | "prompt" | "auto-safe";

export type SkillSourceContextHealthSeverity = "info" | "warning" | "critical";

export type SkillSourceContextHealthFindingKind =
  | "token_bloat"
  | "missing_or_weak_routing_description"
  | "reference_duplication"
  | "body_taxonomy_risk"
  | "source_snapshot_gap"
  | "optimization_unsafe";

export type SkillOptimizationMode =
  | "no_operation"
  | "report_only"
  | "preview_on_demand"
  | "auto_safe"
  | "auto_runtime_experimental";

export type SkillRuntimeViewKind =
  | "metadata_only"
  | "original_source"
  | "compiled_view"
  | "disabled_for_runner"
  | "fallback_original";

export type SkillOptimizationPreviewStatus =
  | "not_run"
  | "preview_ready"
  | "safe_for_auto_runtime"
  | "manual_review_required"
  | "blocked";

export type SkillLazyReferenceKind = "background" | "example" | "template" | "reference" | "script_note" | "asset_note";

export type SkillLazyReferenceLoadPolicy = "on_request" | "on_retry" | "never_auto";

export type SkillOptimizationRiskKind =
  | "context_health"
  | "unsafe_source"
  | "authority_boundary"
  | "manual_review";

export type SkillSourceWarningCode =
  | "permission_like_instruction"
  | "secret_reference"
  | "external_send_claim"
  | "destructive_command"
  | "host_specific_tool"
  | "unsupported_tool"
  | "large_source"
  | "source_truncated"
  | "missing_metadata"
  | "drifted_upstream"
  | "missing_upstream"
  | "orphaned_snapshot";

export type SkillSourceSyncRecordState =
  | "attachable"
  | "unchanged"
  | "drifted"
  | "new"
  | "missing"
  | "blocked"
  | "orphaned";

export type SkillSourceSyncDiffField =
  | "sourceChecksum"
  | "upstreamVersion"
  | "upstreamSkillPath"
  | "sourceLengthChars"
  | "referencedFiles"
  | "warnings"
  | "frontMatterName"
  | "frontMatterDescription"
  | "agentDisplayName"
  | "agentShortDescription"
  | "agentAllowImplicitInvocation";

export interface SkillSourceSyncDiffItem {
  readonly field: SkillSourceSyncDiffField;
  readonly label: string;
  readonly before?: string;
  readonly after?: string;
  readonly severity: SkillSourceWarningSeverity;
}

export interface SkillSourceSemanticSection {
  readonly heading: string;
  readonly level: number;
  readonly line: number;
}

export type SkillSourceSemanticDiffKind =
  | "copy_change"
  | "workflow_change"
  | "gate_change"
  | "tool_claim_change"
  | "host_claim_change"
  | "external_action_change"
  | "destructive_claim_change"
  | "secret_claim_change"
  | "referenced_file_change";

export interface SkillSourceSemanticProfile {
  readonly sourceChecksum: string;
  readonly title?: string;
  readonly description?: string;
  readonly sections: readonly SkillSourceSemanticSection[];
  readonly workflowVerbs: readonly string[];
  readonly stopGateCount: number;
  readonly approvalGateClaims: readonly string[];
  readonly toolClaims: readonly string[];
  readonly hostClaims: readonly string[];
  readonly externalActionClaims: readonly string[];
  readonly destructiveClaims: readonly string[];
  readonly secretClaims: readonly string[];
  readonly referencedFileKinds: Readonly<Record<SkillSourceFileKind, number>>;
}

export interface SkillSourceSemanticDiffItem {
  readonly kind: SkillSourceSemanticDiffKind;
  readonly severity: SkillSourceWarningSeverity;
  readonly before?: string;
  readonly after?: string;
  readonly message: string;
}

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

export interface SkillAgentMetadata {
  readonly displayName?: string;
  readonly shortDescription?: string;
  readonly defaultPrompt?: string;
  readonly allowImplicitInvocation?: boolean;
}

export interface SkillSourceFileRef {
  readonly path: string;
  readonly kind: SkillSourceFileKind;
  readonly checksum?: string;
  readonly sizeBytes?: number;
  readonly includedInSnapshot: boolean;
  readonly artifactId?: string;
  readonly artifactReviewStatus?: SkillSourceArtifactReviewStatus;
}

export interface SkillSourceWarning {
  readonly code: SkillSourceWarningCode;
  readonly severity: SkillSourceWarningSeverity;
  readonly message: string;
  readonly location?: string;
}

export interface SkillSourceContextFindingEvidence {
  readonly sourceRef: string;
  readonly byteStart?: number;
  readonly byteEnd?: number;
  readonly tokenEstimate?: number;
  readonly message: string;
}

export interface SkillSourceContextHealthFinding {
  readonly kind: SkillSourceContextHealthFindingKind;
  readonly severity: SkillSourceContextHealthSeverity;
  readonly skillId: string;
  readonly snapshotId?: string;
  readonly title: string;
  readonly message: string;
  readonly evidence: readonly SkillSourceContextFindingEvidence[];
  readonly tokenEstimate?: number;
  readonly recommendation: string;
}

export interface SkillDescriptionOptimization {
  readonly original?: string;
  readonly suggested?: string;
  readonly reason: string;
}

export interface SkillLazyReference {
  readonly id: string;
  readonly title: string;
  readonly kind: SkillLazyReferenceKind;
  readonly sourceRef: string;
  readonly summary: string;
  readonly tokenEstimate: number;
  readonly loadPolicy: SkillLazyReferenceLoadPolicy;
}

export interface SkillCompiledSourceMapEntry {
  readonly compiledRef: string;
  readonly sourceRef: string;
  readonly sourceStartLine?: number;
  readonly sourceEndLine?: number;
  readonly rationale: string;
}

export interface SkillCompiledRuntimeView {
  readonly id: string;
  readonly skillId: string;
  readonly sourceSnapshotId: string;
  readonly createdAt: string;
  readonly compilerVersion: string;
  readonly coreRulesMarkdown: string;
  readonly lazyReferences: readonly SkillLazyReference[];
  readonly sourceMap: readonly SkillCompiledSourceMapEntry[];
  readonly tokenEstimate: number;
  readonly fallbackPolicy: "original_on_error" | "manual_only";
}

export type SkillCompiledRuntimeViewReviewStatus = "active" | "archived";

export interface SkillCompiledRuntimeViewRecord extends SkillCompiledRuntimeView {
  readonly workspaceId: string;
  readonly authorityBoundary: SkillOptimizationAuthorityBoundary;
  readonly reviewStatus: SkillCompiledRuntimeViewReviewStatus;
  readonly updatedAt: string;
}

export interface SkillOptimizationRisk {
  readonly kind: SkillOptimizationRiskKind;
  readonly severity: SkillSourceContextHealthSeverity;
  readonly title: string;
  readonly message: string;
  readonly sourceRefs: readonly string[];
  readonly blocksAutoRuntime: boolean;
}

export interface SkillOptimizationAuthorityBoundary {
  readonly requiredToolsChanged: false;
  readonly requiredProviderCapabilitiesChanged: false;
  readonly approvalProfileChanged: false;
  readonly teammateBindingsChanged: false;
}

export interface SkillOptimizationPreview {
  readonly skillId: string;
  readonly sourceSnapshotId: string;
  readonly generatedAt: string;
  readonly mode: SkillOptimizationMode;
  readonly status: SkillOptimizationPreviewStatus;
  readonly originalTokenEstimate: number;
  readonly compiledTokenEstimate: number;
  readonly routingDescription?: SkillDescriptionOptimization;
  readonly compiledView?: SkillCompiledRuntimeView;
  readonly risks: readonly SkillOptimizationRisk[];
  readonly authorityBoundary: SkillOptimizationAuthorityBoundary;
}

export interface SkillSourceSnapshot {
  readonly id: string;
  readonly workspaceId: string;
  readonly skillId: string;
  readonly sourceKind: SkillSourceKind;
  readonly sourcePath?: string;
  readonly upstreamName?: string;
  readonly upstreamVersion?: string;
  readonly upstreamSkillPath?: string;
  readonly sourceChecksum: string;
  readonly rawSkillMarkdown: string;
  readonly rawSkillMarkdownArtifactId?: string;
  readonly agentMetadata?: SkillAgentMetadata;
  readonly referencedFiles: readonly SkillSourceFileRef[];
  readonly warnings: readonly SkillSourceWarning[];
  readonly reviewStatus: SkillSourceSnapshotReviewStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SkillSourceScanRoot {
  readonly id?: string;
  readonly rootPath: string;
  readonly sourceKind: SkillSourceKind;
  readonly label?: string;
  readonly upstreamName?: string;
  readonly upstreamVersion?: string;
}

export interface SkillSourceFrontMatter {
  readonly name?: string;
  readonly description?: string;
}

export interface SkillSourceSyncPreviewRecord {
  readonly state: SkillSourceSyncRecordState;
  readonly skillId: string;
  readonly sourceRootId?: string;
  readonly sourceKind?: SkillSourceKind;
  readonly sourcePath?: string;
  readonly upstreamName?: string;
  readonly upstreamVersion?: string;
  readonly upstreamSkillPath?: string;
  readonly sourceChecksum?: string;
  readonly sourceSizeBytes?: number;
  readonly frontMatter?: SkillSourceFrontMatter;
  readonly agentMetadata?: SkillAgentMetadata;
  readonly referencedFiles: readonly SkillSourceFileRef[];
  readonly warnings: readonly SkillSourceWarning[];
  readonly definitionPreview?: SkillDefinition;
  readonly snapshotPreview?: Omit<SkillSourceSnapshot, "id" | "workspaceId" | "createdAt" | "updatedAt">;
  readonly existingSnapshotId?: string;
  readonly diff: readonly SkillSourceSyncDiffItem[];
  readonly semanticProfile?: SkillSourceSemanticProfile;
  readonly semanticDiff: readonly SkillSourceSemanticDiffItem[];
  readonly contextFindings: readonly SkillSourceContextHealthFinding[];
}

export interface SkillSourceSyncPreviewSummary {
  readonly totalRecords: number;
  readonly attachable: number;
  readonly unchanged: number;
  readonly drifted: number;
  readonly new: number;
  readonly missing: number;
  readonly blocked: number;
  readonly orphaned: number;
}

export interface SkillSourceSyncPreviewReport {
  readonly generatedAt: string;
  readonly roots: readonly SkillSourceScanRoot[];
  readonly upstreamVersions: readonly string[];
  readonly summary: SkillSourceSyncPreviewSummary;
  readonly records: readonly SkillSourceSyncPreviewRecord[];
}

export interface SkillSourceArtifact {
  readonly id: string;
  readonly workspaceId: string;
  readonly snapshotId: string;
  readonly path: string;
  readonly kind: SkillSourceFileKind;
  readonly checksum: string;
  readonly sizeBytes: number;
  readonly storageRef: string;
  readonly mediaType?: string;
  readonly reviewStatus: SkillSourceArtifactReviewStatus;
  readonly includedInRuntime: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SkillSourceUpgradePolicy {
  readonly workspaceId: string;
  readonly mode: SkillSourceUpgradeMode;
  readonly approvedRootIds: readonly string[];
  readonly allowNewSkills: boolean;
  readonly allowGlobalGstackUpgrade: false;
  readonly lastCheckedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SkillSourceRuntimeReference {
  readonly id: string;
  readonly title: string;
  readonly kind: SkillLazyReferenceKind;
  readonly sourceRef: string;
  readonly summary?: string;
  readonly tokenEstimate?: number;
  readonly loadPolicy?: SkillLazyReferenceLoadPolicy;
  readonly reason?: string;
}

export type SkillSourceRuntimeFallbackReasonCode =
  | "compiled_missing_reference"
  | "compiled_view_failed";

export interface SkillSourceRuntimeFallbackPlan {
  readonly reasonCode: SkillSourceRuntimeFallbackReasonCode;
  readonly fromRuntimeViewKind: SkillRuntimeViewKind;
  readonly retryRuntimeViewKind: "original_source";
  readonly message: string;
  readonly matchedRefIds: readonly string[];
}

export interface SkillSourceRuntimeContext {
  readonly loaded: boolean;
  readonly runtimeViewKind: SkillRuntimeViewKind;
  readonly skillId: string;
  readonly optimizationMode?: SkillOptimizationMode;
  readonly snapshotId?: string;
  readonly compiledViewId?: string;
  readonly sourceKind?: SkillSourceKind;
  readonly sourcePath?: string;
  readonly upstreamName?: string;
  readonly upstreamVersion?: string;
  readonly upstreamSkillPath?: string;
  readonly sourceChecksum?: string;
  readonly sourceLengthChars?: number;
  readonly loadedChars?: number;
  readonly maxLoadedChars?: number;
  readonly truncated?: boolean;
  readonly tokenEstimate?: number;
  readonly warningCount?: number;
  readonly warningSeverities?: readonly SkillSourceWarningSeverity[];
  readonly referencedFiles?: readonly SkillSourceFileRef[];
  readonly includedRefs?: readonly SkillSourceRuntimeReference[];
  readonly deferredRefs?: readonly SkillSourceRuntimeReference[];
  readonly materializedRefs?: readonly SkillSourceRuntimeReference[];
  readonly blockedReason?: string;
  readonly fallbackReason?: string;
}

export type SkillSourceHealthFindingKind =
  | "missing_source_snapshot"
  | "source_warning"
  | "orphaned_source_snapshot"
  | SkillSourceContextHealthFindingKind;

export interface SkillSourceHealthFinding {
  readonly kind: SkillSourceHealthFindingKind;
  readonly severity: SkillHealthSeverity;
  readonly skillId?: string;
  readonly snapshotId?: string;
  readonly title: string;
  readonly message: string;
  readonly evidence?: readonly SkillSourceContextFindingEvidence[];
  readonly tokenEstimate?: number;
  readonly recommendation?: string;
}

export interface SkillSourceHealthSummary {
  readonly totalSkills: number;
  readonly sourceBackedSkills: number;
  readonly missingSourceSnapshots: number;
  readonly warningSnapshots: number;
  readonly orphanedSnapshots: number;
}

export interface SkillSourceHealthReport {
  readonly workspaceId: string;
  readonly generatedAt: string;
  readonly summary: SkillSourceHealthSummary;
  readonly findings: readonly SkillSourceHealthFinding[];
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

export interface SkillRecordingObservationRequest {
  readonly id?: string;
  readonly workspaceId?: string;
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

export interface SkillRecordingObservationResponse extends ProcedureObservationJobResponse {
  readonly generationMode: SkillGovernanceGenerationMode;
  readonly recordingMode: SkillGovernanceRecordingMode;
}

export type SkillRecordingEligibilityReasonCode =
  | "available"
  | "not_terminal"
  | "missing_run"
  | "missing_evidence"
  | "recording_disabled"
  | "permission_expansion"
  | "duplicate_existing"
  | "duplicate_analysis"
  | "routed_elsewhere"
  | "missing_validation";

export type SkillRecordingEligibilityActionHint =
  | "create_candidate"
  | "append_evidence"
  | "policy_review"
  | "record_evidence_only"
  | "disabled"
  | "wait_for_terminal";

export interface SkillRecordingEligibilityResponse {
  readonly cwd: string;
  readonly runId: string;
  readonly visible: boolean;
  readonly recommended: boolean;
  readonly reasonCode: SkillRecordingEligibilityReasonCode;
  readonly actionHint: SkillRecordingEligibilityActionHint;
  readonly generationMode: SkillGovernanceGenerationMode;
  readonly recordingMode: SkillGovernanceRecordingMode;
  readonly jobKey?: string;
  readonly route?: CandidateRoute;
  readonly duplicateAnalysis?: SkillDuplicateAnalysis;
  readonly selectedSkillId?: string;
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
  readonly contextFindings: readonly SkillSourceContextHealthFinding[];
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

export type SkillImportPreview = Omit<SkillImportDraft, "id" | "workspaceId" | "createdAt" | "updatedAt">;

export interface SkillRegistryListResponse {
  readonly cwd: string;
  readonly skills: readonly SkillRegistryEntry[];
}

export interface SkillSourceSnapshotResponse {
  readonly cwd: string;
  readonly snapshot: SkillSourceSnapshot;
}

export interface SkillSourceSnapshotArchiveResponse {
  readonly cwd: string;
  readonly snapshot: SkillSourceSnapshot;
}

export interface SkillSourceHealthResponse {
  readonly cwd: string;
  readonly report: SkillSourceHealthReport;
  readonly snapshots: readonly SkillSourceSnapshot[];
}

export interface SkillSourceSyncRequest {
  readonly roots?: readonly SkillSourceScanRoot[];
  readonly skillRoots?: readonly string[];
  readonly gstackRepoRoots?: readonly string[];
  readonly codexSkillRoots?: readonly string[];
  readonly includeDetectedRoots?: boolean;
  readonly includeSkillIds?: readonly string[];
  readonly excludeSkillIds?: readonly string[];
  readonly maxSourceBytes?: number;
}

export interface SkillSourceSyncPublishRequest extends SkillSourceSyncRequest {
  readonly selectedSkillIds: readonly string[];
  readonly allowNewSkills?: boolean;
  readonly publishArtifacts?: boolean;
}

export interface SkillSourceSyncPreviewResponse {
  readonly cwd: string;
  readonly preview: SkillSourceSyncPreviewReport;
}

export interface SkillSourceSyncRefreshResponse {
  readonly cwd: string;
  readonly refreshedAt: string;
  readonly preview: SkillSourceSyncPreviewReport;
}

export interface SkillSourceSyncPublishResponse {
  readonly cwd: string;
  readonly publishedAt: string;
  readonly preview: SkillSourceSyncPreviewReport;
  readonly skills: readonly SkillRegistryEntry[];
  readonly snapshots: readonly SkillSourceSnapshot[];
  readonly artifacts: readonly SkillSourceArtifact[];
}

export interface SkillSourceUpgradePolicyUpdateRequest {
  readonly mode?: SkillSourceUpgradeMode;
  readonly approvedRootIds?: readonly string[];
  readonly allowNewSkills?: boolean;
}

export interface SkillSourceUpgradePolicyResponse {
  readonly cwd: string;
  readonly policy: SkillSourceUpgradePolicy;
}

export interface SkillSourceSyncCheckUpdatesResponse {
  readonly cwd: string;
  readonly checkedAt: string;
  readonly policy: SkillSourceUpgradePolicy;
  readonly preview: SkillSourceSyncPreviewReport;
  readonly globalUpgrade: {
    readonly available: boolean;
    readonly currentVersion?: string;
    readonly latestVersion?: string;
    readonly source: "local-only" | "unknown";
  };
}

export interface SkillSourceSnapshotRollbackRequest {
  readonly snapshotId: string;
}

export interface SkillSourceSnapshotRollbackResponse {
  readonly cwd: string;
  readonly rolledBackAt: string;
  readonly snapshot: SkillSourceSnapshot;
}

export interface SkillSourceArtifactListResponse {
  readonly cwd: string;
  readonly artifacts: readonly SkillSourceArtifact[];
}

export interface SkillOptimizationPreviewRequest {
  readonly mode?: SkillOptimizationMode;
}

export interface SkillImportDraftOptimizationPreviewRequest extends SkillImportDraftRequest {
  readonly mode?: SkillOptimizationMode;
}

export interface SkillOptimizationPreviewResponse {
  readonly cwd: string;
  readonly preview: SkillOptimizationPreview;
}

export interface SkillCompiledRuntimeViewCreateRequest {
  readonly mode?: SkillOptimizationMode;
}

export interface SkillCompiledRuntimeViewListResponse {
  readonly cwd: string;
  readonly views: readonly SkillCompiledRuntimeViewRecord[];
}

export interface SkillCompiledRuntimeViewMutationResponse {
  readonly cwd: string;
  readonly view: SkillCompiledRuntimeViewRecord;
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
  readonly contextFindings: readonly SkillSourceContextHealthFinding[];
}

export interface SkillImportPreviewResponse {
  readonly cwd: string;
  readonly preview: SkillImportPreview;
  readonly contextFindings: readonly SkillSourceContextHealthFinding[];
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
