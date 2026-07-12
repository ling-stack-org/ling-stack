import { randomUUID } from "node:crypto";
import type { ApprovalActionType, ApprovalRisk } from "./approval-types.js";
import type { RunTool } from "./approval-policy.js";
import type { ProviderCapability } from "./provider-types.js";

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
export type SkillImportWarningCode =
  | "permission_like_instruction"
  | "secret_reference"
  | "external_send_claim"
  | "unknown_tool"
  | "unknown_provider_capability"
  | "unsupported_section"
  | "missing_metadata"
  | "duplicate_skill_id";

export type AiTeammateRoleKey =
  | "product"
  | "architect"
  | "engineer"
  | "designer"
  | "qa"
  | "security"
  | "release"
  | "docs"
  | "custom";

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

export type SkillApprovalMode = "none" | "standard" | "strict";

export interface SkillApprovalProfile {
  readonly mode: SkillApprovalMode;
  readonly risk?: ApprovalRisk;
  readonly requiredForTools?: readonly RunTool[];
  readonly requiredForActions?: readonly ApprovalActionType[];
}

export interface SkillDefinition {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly roleAffinity: readonly AiTeammateRoleKey[];
  readonly workflowPhase: SkillWorkflowPhase;
  readonly promptFragments: readonly string[];
  readonly requiredTools: readonly RunTool[];
  readonly requiredProviderCapabilities: readonly ProviderCapability[];
  readonly approvalProfile: SkillApprovalProfile;
  readonly stateEffects: readonly SkillStateEffect[];
}

export interface AiTeammateTemplate {
  readonly id: string;
  readonly name: string;
  readonly roleKey: AiTeammateRoleKey;
  readonly summary: string;
  readonly defaultSkillIds: readonly string[];
  readonly allowedTools: readonly RunTool[];
  readonly requiredProviderCapabilities: readonly ProviderCapability[];
  readonly approvalProfile: SkillApprovalProfile;
  readonly systemPrompt: string;
}

export interface WorkflowStepTemplate {
  readonly id: string;
  readonly name: string;
  readonly phase: SkillWorkflowPhase;
  readonly teammateTemplateId: string;
  readonly councilSlotKey?: string;
  readonly skillId: string;
  readonly dependsOn?: readonly string[];
  readonly approvalGate?: SkillApprovalProfile;
}

export interface WorkflowTemplate {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly steps: readonly WorkflowStepTemplate[];
}

export interface SkillPack {
  readonly id: string;
  readonly source: SkillPackSource;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly skills: readonly SkillDefinition[];
  readonly teammateTemplates: readonly AiTeammateTemplate[];
  readonly workflowTemplates: readonly WorkflowTemplate[];
}

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

export interface CreateSkillCompiledRuntimeViewInput {
  readonly view: SkillCompiledRuntimeView;
  readonly authorityBoundary: SkillOptimizationAuthorityBoundary;
  readonly reviewStatus?: SkillCompiledRuntimeViewReviewStatus;
}

export interface ListSkillCompiledRuntimeViewOptions {
  readonly skillId?: string;
  readonly sourceSnapshotId?: string;
  readonly reviewStatus?: SkillCompiledRuntimeViewReviewStatus;
  readonly includeArchived?: boolean;
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
  readonly snapshotPreview?: CreateSkillSourceSnapshotInput;
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

export interface CreateSkillSourceArtifactInput {
  readonly id?: string;
  readonly snapshotId: string;
  readonly path: string;
  readonly kind: SkillSourceFileKind;
  readonly checksum: string;
  readonly sizeBytes: number;
  readonly storageRef: string;
  readonly mediaType?: string;
  readonly reviewStatus?: SkillSourceArtifactReviewStatus;
  readonly includedInRuntime?: boolean;
}

export interface ListSkillSourceArtifactOptions {
  readonly snapshotId?: string;
  readonly reviewStatus?: SkillSourceArtifactReviewStatus;
  readonly includeArchived?: boolean;
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

export interface UpdateSkillSourceUpgradePolicyInput {
  readonly mode?: SkillSourceUpgradeMode;
  readonly approvedRootIds?: readonly string[];
  readonly allowNewSkills?: boolean;
  readonly lastCheckedAt?: string;
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
export type SkillRegressionMode =
  | "original_source"
  | "compiled_view"
  | "compressed_routing_compiled_view";
export type SkillRegressionLifecycleVerdict =
  | "safe_to_keep_full"
  | "safe_for_core_lazy"
  | "needs_manual_review"
  | "obsolete_or_low_value"
  | "black_box_runtime_only";
export type SkillRegressionFindingKind =
  | "routing_regression"
  | "task_success_regression"
  | "approval_risk_regression"
  | "missing_reference_regression"
  | "fallback_regression"
  | "baseline_failure"
  | "low_value";

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

export interface SkillSourceRuntimePrompt {
  readonly context: SkillSourceRuntimeContext;
  readonly promptFragment?: string;
}

export interface SkillRegressionGuardrails {
  readonly authority: "shadow";
  readonly canMutateSkillDefinition: false;
  readonly canMutateSourceSnapshot: false;
  readonly canMutateCompiledView: false;
  readonly canChangeRuntimeAuthority: false;
  readonly requiresPassingGateForAutoSafe: true;
}

export interface SkillRegressionFixture {
  readonly id: string;
  readonly skillId: string;
  readonly sourceSnapshotId?: string;
  readonly prompt: string;
  readonly source: "real_task" | "real_run" | "synthetic_task";
  readonly expectedSelectedSkillId: string;
  readonly expectedSuccessMarkers?: readonly string[];
  readonly forbiddenOutputMarkers?: readonly string[];
  readonly maxApprovalCount?: number;
  readonly maxApprovalRisk?: ApprovalRisk;
  readonly allowFallback?: boolean;
  readonly expectedLazyReferenceIds?: readonly string[];
}

export interface SkillRegressionObservation {
  readonly fixtureId: string;
  readonly mode: SkillRegressionMode;
  readonly selectedSkillId?: string;
  readonly runtimeContext?: SkillSourceRuntimeContext;
  readonly outputText?: string;
  readonly completed?: boolean;
  readonly approvalCount?: number;
  readonly maxApprovalRisk?: ApprovalRisk;
  readonly fallbackPlan?: SkillSourceRuntimeFallbackPlan;
  readonly clarificationCount?: number;
  readonly latencyMs?: number;
  readonly tokenEstimate?: number;
  readonly loadedLazyReferenceIds?: readonly string[];
  readonly errorMessage?: string;
}

export interface SkillRegressionFinding {
  readonly kind: SkillRegressionFindingKind;
  readonly severity: SkillSourceContextHealthSeverity;
  readonly fixtureId: string;
  readonly mode: SkillRegressionMode;
  readonly message: string;
  readonly sourceRefs: readonly string[];
}

export interface SkillRegressionCaseResult {
  readonly fixtureId: string;
  readonly mode: SkillRegressionMode;
  readonly passed: boolean;
  readonly routingPreserved: boolean;
  readonly taskSucceeded: boolean;
  readonly approvalSafe: boolean;
  readonly fallbackUsed: boolean;
  readonly fallbackSafe: boolean;
  readonly missingReferenceRegression: boolean;
  readonly clarificationCount: number;
  readonly tokenEstimate: number;
  readonly latencyMs?: number;
  readonly loadedLazyReferenceCount: number;
  readonly reasons: readonly string[];
  readonly findings: readonly SkillRegressionFinding[];
}

export interface SkillRegressionModeSummary {
  readonly mode: SkillRegressionMode;
  readonly passedCount: number;
  readonly failedCount: number;
  readonly totalCount: number;
  readonly fallbackCount: number;
  readonly missingReferenceRegressionCount: number;
  readonly clarificationCount: number;
  readonly averageTokenEstimate: number;
  readonly averageLatencyMs?: number;
}

export interface SkillRegressionSummary {
  readonly passedCount: number;
  readonly failedCount: number;
  readonly totalCount: number;
  readonly originalAverageTokenEstimate: number;
  readonly compiledAverageTokenEstimate: number;
  readonly tokenReductionRatio: number;
  readonly fallbackRate: number;
  readonly missingReferenceRegressionCount: number;
  readonly approvalRegressionCount: number;
  readonly routingRegressionCount: number;
  readonly taskSuccessRegressionCount: number;
  readonly modeSummaries: readonly SkillRegressionModeSummary[];
}

export interface SkillRegressionRun {
  readonly id: string;
  readonly workspaceId: string;
  readonly skillId: string;
  readonly sourceSnapshotId?: string;
  readonly compiledViewId?: string;
  readonly suiteId?: string;
  readonly guardrails: SkillRegressionGuardrails;
  readonly fixtures: readonly SkillRegressionFixture[];
  readonly observations: readonly SkillRegressionObservation[];
  readonly results: readonly SkillRegressionCaseResult[];
  readonly summary: SkillRegressionSummary;
  readonly lifecycleVerdict: SkillRegressionLifecycleVerdict;
  readonly autoSafeEligible: boolean;
  readonly createdAt: string;
}

export interface CreateSkillRegressionRunInput {
  readonly id?: string;
  readonly skillId: string;
  readonly sourceSnapshotId?: string;
  readonly compiledViewId?: string;
  readonly suiteId?: string;
  readonly fixtures: readonly SkillRegressionFixture[];
  readonly observations: readonly SkillRegressionObservation[];
  readonly results: readonly SkillRegressionCaseResult[];
  readonly summary: SkillRegressionSummary;
  readonly lifecycleVerdict: SkillRegressionLifecycleVerdict;
  readonly autoSafeEligible: boolean;
}

export interface ListSkillRegressionRunsOptions {
  readonly skillId?: string;
  readonly sourceSnapshotId?: string;
  readonly compiledViewId?: string;
  readonly suiteId?: string;
  readonly lifecycleVerdict?: SkillRegressionLifecycleVerdict;
  readonly autoSafeEligible?: boolean;
  readonly limit?: number;
}

export interface CreateSkillSourceSnapshotInput {
  readonly id?: string;
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
  readonly referencedFiles?: readonly SkillSourceFileRef[];
  readonly warnings?: readonly SkillSourceWarning[];
  readonly reviewStatus?: SkillSourceSnapshotReviewStatus;
}

export interface ListSkillSourceSnapshotOptions {
  readonly skillId?: string;
  readonly sourceKind?: SkillSourceKind;
  readonly reviewStatus?: SkillSourceSnapshotReviewStatus;
  readonly includeArchived?: boolean;
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

export interface CreateSkillImportDraftInput {
  readonly id?: string;
  readonly source: SkillPackSource;
  readonly sourcePath?: string;
  readonly packId?: string;
  readonly name: string;
  readonly version?: string;
  readonly description: string;
  readonly definitions: readonly SkillImportDraftDefinition[];
  readonly warnings?: readonly SkillImportWarning[];
}

export interface ListSkillRegistryOptions {
  readonly includeArchived?: boolean;
  readonly includeDisabled?: boolean;
}

export function createSkillPackId(): string {
  return `skill_pack_${cryptoRandomId()}`;
}

export function createSkillImportDraftId(): string {
  return `skill_draft_${cryptoRandomId()}`;
}

export function createSkillSourceSnapshotId(): string {
  return `skill_source_${cryptoRandomId()}`;
}

export function createSkillSourceArtifactId(): string {
  return `skill_source_artifact_${cryptoRandomId()}`;
}

export function createSkillRegressionRunId(): string {
  return `skill_regression_${cryptoRandomId()}`;
}

function cryptoRandomId(): string {
  return randomUUID().replaceAll("-", "");
}
