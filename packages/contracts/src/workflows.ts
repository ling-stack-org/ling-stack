import type { ApprovalRequest, SkillApprovalProfile } from "./approvals.js";
import type { RunArtifact } from "./artifacts.js";
import type { ChannelExecutionProposal, ChannelHandoff } from "./channels.js";
import type { MemoryObject } from "./memory.js";
import type { RunSession, RunnerFallbackReason, RunnerRequestSource } from "./runtime.js";
import type { ResponseLanguage } from "./settings.js";
import type { RunTool } from "./shared.js";
import type { Task } from "./tasks.js";

export type ChannelWorkflowStatus =
  | "draft"
  | "ready"
  | "running"
  | "waiting_for_approval"
  | "blocked"
  | "succeeded"
  | "failed"
  | "cancelled";

export type ChannelWorkflowStepStatus =
  | "queued"
  | "claimed"
  | "running"
  | "waiting_for_approval"
  | "blocked"
  | "succeeded"
  | "failed"
  | "skipped"
  | "cancelled";

export type ChannelWorkflowStepStartMode = "create_task" | "create_and_run_task";

export type WorkflowStepFailurePolicy =
  | "block_for_user"
  | "fail_workflow"
  | "cancel_workflow"
  | "skip_if_optional";

export interface WorkflowStepPolicy {
  readonly onRunFailed: WorkflowStepFailurePolicy;
  readonly onRunCancelled: WorkflowStepFailurePolicy;
  readonly onApprovalDenied: WorkflowStepFailurePolicy;
  readonly retryable: boolean;
  readonly maxRetries?: number;
}

export interface WorkflowStepGate {
  readonly stage: "pre" | "post";
  readonly approvalProfile: SkillApprovalProfile;
  readonly title: string;
  readonly reason: string;
  readonly requiredForStatuses?: readonly ChannelWorkflowStepStatus[];
}

export type WorkflowFanInMode =
  | "summarize_outputs"
  | "compare_outputs"
  | "collect_checks"
  | "memory_candidates";

export interface WorkflowFanInPolicy {
  readonly mode: WorkflowFanInMode;
  readonly requireAllBranchesTerminal: boolean;
  readonly includeFailedBranches: boolean;
  readonly createSummaryArtifact: boolean;
  readonly createMemoryCandidates: boolean;
  readonly memoryCandidateScope: "run" | "task" | "channel";
  readonly maxInputArtifacts: number;
}

export interface RunnerResolutionAudit {
  readonly requestedRunnerId: string;
  readonly effectiveRunnerId: string;
  readonly requestSource?: RunnerRequestSource;
  readonly fallbackAllowed?: boolean;
  readonly fallbackReason?: RunnerFallbackReason;
}

export interface WorkflowStepOutputRef {
  readonly workflowStepId: string;
  readonly runId?: string;
  readonly status: ChannelWorkflowStepStatus;
  readonly resultSummary?: string;
  readonly outputArtifactId?: string;
  readonly artifactIds: readonly string[];
  readonly branchGroupId?: string;
}

export type WorkflowPacketSourceRefType =
  | "channel_message"
  | "channel_brief"
  | "channel_decision"
  | "context_summary"
  | "task"
  | "run"
  | "workflow"
  | "workflow_step"
  | "workflow_handoff_intent"
  | "workflow_selector_decision"
  | "artifact"
  | "approval"
  | "memory";

export interface WorkflowPacketSourceRef {
  readonly type: WorkflowPacketSourceRefType;
  readonly id: string;
  readonly label?: string;
}

export type WorkflowHandoffIntentStatus =
  | "proposed"
  | "validated"
  | "accepted"
  | "declined"
  | "converted"
  | "failed";

export type WorkflowHandoffIntentCreatedBy = "local-user" | "ai-teammate" | "orchestrator";

export interface WorkflowHandoffValidation {
  readonly targetTeammateExists: boolean;
  readonly targetTeammateActive: boolean;
  readonly skillExecutable: boolean;
  readonly providerRunnable: boolean;
  readonly approvalProfileCompatible: boolean;
  readonly resourceLeaseAvailable: boolean;
  readonly blockers: readonly string[];
}

export interface WorkflowHandoffIntent {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly workflowId?: string;
  readonly sourceWorkflowStepId?: string;
  readonly sourceRunId?: string;
  readonly sourceMessageId?: string;
  readonly channelHandoffId?: string;
  readonly fromParticipantId: string;
  readonly fromParticipantLabel: string;
  readonly toParticipantId: string;
  readonly toParticipantLabel?: string;
  readonly reason: string;
  readonly requiredInput: string;
  readonly expectedOutput: string;
  readonly riskSummary?: string;
  readonly sourceRefs: readonly WorkflowPacketSourceRef[];
  readonly status: WorkflowHandoffIntentStatus;
  readonly validation?: WorkflowHandoffValidation;
  readonly createdBy: WorkflowHandoffIntentCreatedBy;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type WorkflowSelectorDecisionStatus =
  | "proposed"
  | "accepted"
  | "rejected"
  | "blocked"
  | "superseded";

export type WorkflowSelectorTargetKind =
  | "workflow_step"
  | "graph_node"
  | "teammate"
  | "skill"
  | "handoff"
  | "wait";

export type WorkflowSelectorDecisionCreatedBy = "deterministic" | "model" | "local-user";

export interface WorkflowSelectorAlternative {
  readonly targetKind: WorkflowSelectorTargetKind;
  readonly targetId: string;
  readonly label: string;
  readonly reason: string;
}

export interface WorkflowSelectorDecision {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly workflowId: string;
  readonly sourceWorkflowStepId?: string;
  readonly selectorNodeId?: string;
  readonly targetKind: WorkflowSelectorTargetKind;
  readonly selectedWorkflowStepId?: string;
  readonly selectedGraphNodeId?: string;
  readonly selectedTeammateId?: string;
  readonly selectedSkillId?: string;
  readonly selectedHandoffIntentId?: string;
  readonly reason: string;
  readonly alternativesConsidered: readonly WorkflowSelectorAlternative[];
  readonly confidence: "low" | "medium" | "high";
  readonly requiresUserConfirmation: boolean;
  readonly status: WorkflowSelectorDecisionStatus;
  readonly sourceRefs: readonly WorkflowPacketSourceRef[];
  readonly createdBy: WorkflowSelectorDecisionCreatedBy;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ChannelWorkflowStepContextPacket {
  readonly schemaVersion: 1;
  readonly workflowId: string;
  readonly workflowStepId: string;
  readonly graphId?: string;
  readonly graphNodeId?: string;
  readonly teammateId?: string;
  readonly skillId?: string;
  readonly objective: string;
  readonly stepTitle: string;
  readonly stepPrompt: string;
  readonly dependencies: readonly WorkflowStepOutputRef[];
  readonly priorOutputArtifactIds: readonly string[];
  readonly sourceRefs?: readonly WorkflowPacketSourceRef[];
  readonly selectorDecisionIds?: readonly string[];
  readonly handoffIntentIds?: readonly string[];
  readonly requestedRunnerId?: string;
  readonly effectiveRunnerId?: string;
  readonly providerPresetId?: string;
  readonly approvalGate?: SkillApprovalProfile;
  readonly contextPack?: WorkflowStepContextPackSnapshot;
  readonly generatedAt: string;
}

export interface WorkflowStepContextPackSnapshot {
  readonly kind: string;
  readonly providerPresetId?: string;
  readonly modelId?: string;
  readonly budget: {
    readonly mode: string;
    readonly contextWindowTokens: number;
    readonly reservedOutputTokens: number;
    readonly reservedRuntimeOverheadTokens: number;
    readonly inputBudgetTokens: number;
    readonly tokenizer?: string;
  };
  readonly estimatedInputTokens: number;
  readonly overBudget: boolean;
  readonly droppedSectionIds: readonly string[];
  readonly compactionIds: readonly string[];
  readonly sections: readonly {
    readonly id: string;
    readonly role: string;
    readonly priority: string;
    readonly estimatedTokens?: number;
    readonly sourceRefIds?: readonly string[];
    readonly metadata?: Record<string, unknown>;
  }[];
  readonly sourceRefs: readonly {
    readonly type: string;
    readonly id: string;
    readonly label?: string;
  }[];
}

export interface ChannelWorkflowStepOutputPacket {
  readonly schemaVersion: 1;
  readonly workflowId: string;
  readonly workflowStepId: string;
  readonly runId?: string;
  readonly graphId?: string;
  readonly graphNodeId?: string;
  readonly teammateId?: string;
  readonly skillId?: string;
  readonly status: ChannelWorkflowStepStatus;
  readonly resultSummary?: string;
  readonly artifactIds: readonly string[];
  readonly decisions?: readonly string[];
  readonly blockers?: readonly string[];
  readonly changedPaths?: readonly string[];
  readonly sourceRefs?: readonly WorkflowPacketSourceRef[];
  readonly selectorDecisionIds?: readonly string[];
  readonly handoffIntentIds?: readonly string[];
  readonly runnerAudit?: RunnerResolutionAudit;
  readonly generatedAt: string;
}

export interface ChannelWorkflowStepMetadata {
  readonly workflowTemplateId?: string;
  readonly templateVersion?: string;
  readonly templateStepId?: string;
  readonly graphId?: string;
  readonly graphNodeId?: string;
  readonly dependsOnStepIds?: readonly string[];
  readonly branchGroupId?: string;
  readonly joinGroupId?: string;
  readonly dependencyMode?: "all_succeeded" | "all_terminal" | "any_succeeded";
  readonly maxParallelSiblings?: number;
  readonly teammateTemplateId?: string;
  readonly skillId?: string;
  readonly requestedRunnerId?: string;
  readonly effectiveRunnerId?: string;
  readonly providerPresetId?: string;
  readonly requiredTools?: readonly RunTool[];
  readonly autoStart?: boolean;
  readonly approvalGate?: SkillApprovalProfile;
  readonly preStepApprovalId?: string;
  readonly policy?: WorkflowStepPolicy;
  readonly gates?: readonly WorkflowStepGate[];
  readonly fanInPolicy?: WorkflowFanInPolicy;
  readonly activeGateStage?: "pre" | "post";
  readonly postStepApprovalId?: string;
  readonly contextArtifactId?: string;
  readonly outputArtifactId?: string;
  readonly outputArtifactIds?: readonly string[];
  readonly selectorDecisionIds?: readonly string[];
  readonly handoffIntentIds?: readonly string[];
  readonly sourceProposalId?: string;
  readonly sourceMessageId?: string;
  readonly fanInSummaryArtifactId?: string;
  readonly memoryCandidateIds?: readonly string[];
}

export type WorkflowGraphNodeKind = "step" | "join";

export type WorkflowEdgeConditionKind =
  | "always"
  | "all_succeeded"
  | "all_terminal"
  | "any_succeeded";

export interface WorkflowEdgeCondition {
  readonly kind: WorkflowEdgeConditionKind;
}

export interface WorkflowGraphEdge {
  readonly id: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly condition: WorkflowEdgeCondition;
}

export type WorkflowTerminationSuccessPolicy = "all_terminal" | "all_required_succeeded";
export type WorkflowTerminationFailurePolicy = "block_for_user" | "fail_workflow";

export interface WorkflowTerminationPolicy {
  readonly success: WorkflowTerminationSuccessPolicy;
  readonly onFailedRequiredNode: WorkflowTerminationFailurePolicy;
  readonly onApprovalDenied: WorkflowTerminationFailurePolicy;
  readonly maxTicks?: number;
}

export interface WorkflowGraphNode {
  readonly id: string;
  readonly kind: WorkflowGraphNodeKind;
  readonly name: string;
  readonly prompt: string;
  readonly teammateTemplateId?: string;
  readonly teammateId?: string;
  readonly skillId?: string;
  readonly providerPresetId?: string;
  readonly requestedRunnerId?: string;
  readonly branchGroupId?: string;
  readonly joinGroupId?: string;
  readonly policy?: WorkflowStepPolicy;
  readonly gates?: readonly WorkflowStepGate[];
  readonly requiredTools?: readonly RunTool[];
  readonly autoStart?: boolean;
}

export interface WorkflowGraph {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly summary?: string;
  readonly entryNodeId: string;
  readonly nodes: readonly WorkflowGraphNode[];
  readonly edges: readonly WorkflowGraphEdge[];
  readonly termination: WorkflowTerminationPolicy;
  readonly maxParallelSteps?: number;
}

export interface ChannelWorkflowMetadata {
  readonly workflowGraphId?: string;
  readonly workflowGraphSchemaVersion?: number;
  readonly workflowGraphArtifactId?: string;
  readonly termination?: WorkflowTerminationPolicy;
  readonly maxParallelSteps?: number;
  readonly sourceProposalId?: string;
  readonly sourceMessageId?: string;
  readonly responseLanguage?: ResponseLanguage;
}

export interface ChannelWorkflow {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly sourceHandoffId?: string;
  readonly title: string;
  readonly objective: string;
  readonly status: ChannelWorkflowStatus;
  readonly createdBy: string;
  readonly metadata?: ChannelWorkflowMetadata;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ChannelWorkflowStep {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly workflowId: string;
  readonly sourceHandoffId?: string;
  readonly contextSummaryId?: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly position: number;
  readonly title: string;
  readonly prompt: string;
  readonly toParticipantId: string;
  readonly toParticipantLabel: string;
  readonly status: ChannelWorkflowStepStatus;
  readonly blocker?: string;
  readonly resultSummary?: string;
  readonly metadata?: ChannelWorkflowStepMetadata;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkflowEvidenceDiagnostic {
  readonly kind:
    | "missing_context_packet"
    | "missing_output_packet"
    | "missing_run"
    | "bad_packet"
    | "missing_teammate"
    | "blocked"
    | "failed";
  readonly severity: "info" | "warning" | "critical";
  readonly message: string;
}

export interface WorkflowMemoryCandidateSummary {
  readonly memory: MemoryObject;
  readonly sourceWorkflowId: string;
  readonly sourceWorkflowStepIds: readonly string[];
}

export interface WorkflowEvidenceStep {
  readonly step: ChannelWorkflowStep;
  readonly contextPacket?: ChannelWorkflowStepContextPacket;
  readonly outputPacket?: ChannelWorkflowStepOutputPacket;
  readonly linkedRun?: RunSession;
  readonly packetArtifacts: readonly RunArtifact[];
  readonly linkedArtifacts: readonly RunArtifact[];
  readonly diagnostics: readonly WorkflowEvidenceDiagnostic[];
}

export interface WorkflowEvidenceResponse {
  readonly workflow: ChannelWorkflow;
  readonly steps: readonly WorkflowEvidenceStep[];
  readonly selectorDecisions: readonly WorkflowSelectorDecision[];
  readonly handoffIntents: readonly WorkflowHandoffIntent[];
  readonly handoffs: readonly ChannelHandoff[];
  readonly approvals: readonly ApprovalRequest[];
  readonly artifacts: readonly RunArtifact[];
  readonly memoryCandidates: readonly WorkflowMemoryCandidateSummary[];
}

export interface WorkflowStepEvidenceResponse {
  readonly workflow: ChannelWorkflow;
  readonly workflowStep: WorkflowEvidenceStep;
  readonly selectorDecisions: readonly WorkflowSelectorDecision[];
  readonly handoffIntents: readonly WorkflowHandoffIntent[];
  readonly handoffs: readonly ChannelHandoff[];
  readonly approvals: readonly ApprovalRequest[];
  readonly memoryCandidates: readonly WorkflowMemoryCandidateSummary[];
}

export interface CreateChannelWorkflowRequest {
  readonly sourceHandoffId?: string;
  readonly title: string;
  readonly objective: string;
  readonly status?: ChannelWorkflowStatus;
  readonly createdBy: string;
}

export interface CreateChannelWorkflowFromTemplateRequest {
  readonly templateId: string;
  readonly title?: string;
  readonly objective: string;
  readonly createdBy?: string;
  readonly providerPresetId?: string;
  readonly runnerId?: string;
  readonly autoStart?: boolean;
}

export interface CreateChannelWorkflowFromCustomTemplateRequest {
  readonly customTemplate: CustomWorkflowTemplate;
  readonly title?: string;
  readonly objective: string;
  readonly createdBy?: string;
  readonly providerPresetId?: string;
  readonly runnerId?: string;
  readonly autoStart?: boolean;
  readonly confirmUnsafeAutoStart?: boolean;
}

export interface CreateChannelWorkflowFromCustomTemplateIdRequest {
  readonly customTemplateId: string;
  readonly title?: string;
  readonly objective: string;
  readonly createdBy?: string;
  readonly providerPresetId?: string;
  readonly runnerId?: string;
  readonly autoStart?: boolean;
  readonly confirmUnsafeAutoStart?: boolean;
}

export interface CreateChannelWorkflowFromGraphRequest {
  readonly workflowGraph: WorkflowGraph;
  readonly title?: string;
  readonly objective: string;
  readonly createdBy?: string;
  readonly providerPresetId?: string;
  readonly runnerId?: string;
  readonly autoStart?: boolean;
  readonly confirmUnsafeAutoStart?: boolean;
}

export type CreateChannelWorkflowTemplateCompileRequest =
  | CreateChannelWorkflowFromTemplateRequest
  | CreateChannelWorkflowFromCustomTemplateRequest
  | CreateChannelWorkflowFromCustomTemplateIdRequest
  | CreateChannelWorkflowFromGraphRequest;

export interface CustomWorkflowTemplate {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly maxParallelSteps?: number;
  readonly autoStartDefault?: boolean;
  readonly steps: readonly CustomWorkflowTemplateStep[];
}

export interface CustomWorkflowTemplateStep {
  readonly id: string;
  readonly name: string;
  readonly prompt: string;
  readonly teammateTemplateId?: string;
  readonly teammateId?: string;
  readonly skillId?: string;
  readonly providerPresetId?: string;
  readonly requestedRunnerId?: string;
  readonly dependsOn?: readonly string[];
  readonly branchGroupId?: string;
  readonly joinGroupId?: string;
  readonly dependencyMode?: ChannelWorkflowStepMetadata["dependencyMode"];
  readonly maxParallelSiblings?: number;
  readonly policy?: WorkflowStepPolicy;
  readonly gates?: readonly WorkflowStepGate[];
  readonly autoStart?: boolean;
}

export interface CreateChannelWorkflowFromHandoffRequest {
  readonly title?: string;
  readonly objective?: string;
  readonly contextSummaryId?: string;
  readonly createdBy: string;
}

export interface UpdateChannelWorkflowRequest {
  readonly title?: string;
  readonly objective?: string;
  readonly status?: ChannelWorkflowStatus;
}

export interface ChannelWorkflowCancelResponse {
  readonly workflow: ChannelWorkflow;
  readonly workflowSteps: readonly ChannelWorkflowStep[];
  readonly cancelledRunIds: readonly string[];
  readonly cancelledApprovalIds: readonly string[];
}

export interface CreateChannelWorkflowStepRequest {
  readonly sourceHandoffId?: string;
  readonly contextSummaryId?: string;
  readonly position?: number;
  readonly title: string;
  readonly prompt: string;
  readonly toParticipantId: string;
  readonly toParticipantLabel: string;
  readonly status?: ChannelWorkflowStepStatus;
}

export interface UpdateChannelWorkflowStepRequest {
  readonly sourceHandoffId?: string | null;
  readonly contextSummaryId?: string | null;
  readonly taskId?: string | null;
  readonly runId?: string | null;
  readonly position?: number;
  readonly title?: string;
  readonly prompt?: string;
  readonly toParticipantId?: string;
  readonly toParticipantLabel?: string;
  readonly status?: ChannelWorkflowStepStatus;
  readonly blocker?: string | null;
  readonly resultSummary?: string | null;
}

export interface StartChannelWorkflowStepRequest {
  readonly mode: ChannelWorkflowStepStartMode;
  readonly taskTitle?: string;
  readonly taskPrompt?: string;
  readonly providerPresetId?: string;
  readonly assigneeTeammateId?: string;
  readonly idempotencyKey?: string;
  readonly skipProviderPreflight?: boolean;
}

export interface ChannelWorkflowListResponse {
  readonly cwd: string;
  readonly channelId: string;
  readonly workflows: readonly ChannelWorkflow[];
}

export interface ChannelWorkflowMutationResponse {
  readonly workflow: ChannelWorkflow;
  readonly workflowStep?: ChannelWorkflowStep;
}

export interface ChannelWorkflowTemplateMutationResponse {
  readonly workflow: ChannelWorkflow;
  readonly workflowSteps: readonly ChannelWorkflowStep[];
}

export interface ChannelExecutionProposalWorkflowConfirmResponse {
  readonly proposal: ChannelExecutionProposal;
  readonly workflow: ChannelWorkflow;
  readonly workflowSteps: readonly ChannelWorkflowStep[];
  readonly orchestration?: ChannelWorkflowOrchestrationResponse;
}

export interface ChannelWorkflowStepListResponse {
  readonly cwd: string;
  readonly workflowId: string;
  readonly workflowSteps: readonly ChannelWorkflowStep[];
}

export interface ChannelWorkflowStepMutationResponse {
  readonly workflowStep: ChannelWorkflowStep;
  readonly workflow?: ChannelWorkflow;
}

export interface ChannelWorkflowStepStartResponse {
  readonly workflowStep: ChannelWorkflowStep;
  readonly workflow?: ChannelWorkflow;
  readonly task?: Task;
  readonly run?: RunSession;
  readonly blocker?: string;
}

export type ChannelWorkflowStepRetryResponse = ChannelWorkflowOrchestrationResponse;

export type ChannelWorkflowOrchestrationResponse =
  | {
      readonly status: "started";
      readonly workflow: ChannelWorkflow;
      readonly workflowStep: ChannelWorkflowStep;
      readonly taskId: string;
      readonly runId?: string;
      readonly startedSteps?: readonly {
        readonly workflowStep: ChannelWorkflowStep;
        readonly taskId: string;
        readonly runId?: string;
      }[];
    }
  | {
      readonly status: "waiting_for_approval";
      readonly workflow: ChannelWorkflow;
      readonly workflowStep: ChannelWorkflowStep;
      readonly approval: ApprovalRequest;
      readonly waitingApprovals?: readonly {
        readonly workflowStep: ChannelWorkflowStep;
        readonly approval: ApprovalRequest;
      }[];
    }
  | {
      readonly status: "idle";
      readonly workflow: ChannelWorkflow;
      readonly reason: string;
    }
  | {
      readonly status: "blocked";
      readonly workflow: ChannelWorkflow;
      readonly workflowStep?: ChannelWorkflowStep;
      readonly blocker: string;
    }
  | {
      readonly status: "failed";
      readonly workflow: ChannelWorkflow;
      readonly workflowStep?: ChannelWorkflowStep;
      readonly blocker: string;
    }
  | {
      readonly status: "completed";
      readonly workflow: ChannelWorkflow;
    };

export type ResourceType =
  | "channel"
  | "bound_path"
  | "workspace"
  | "provider"
  | "task"
  | "workflow_step"
  | "external_source"
  | "external_subject"
  | "external_workspace";

export type ResourceLeaseStatus = "active" | "released" | "expired";

export interface ResourceLease {
  readonly id: string;
  readonly workspaceId: string;
  readonly resourceType: ResourceType;
  readonly resourceKey: string;
  readonly ownerType: "run" | "workflow_step" | "work_unit_attempt" | "system";
  readonly ownerId: string;
  readonly status: ResourceLeaseStatus;
  readonly acquiredAt: string;
  readonly expiresAt: string;
  readonly lastRenewedAt?: string;
  readonly releasedAt?: string;
  readonly releaseReason?: string;
  readonly workUnitId?: string;
  readonly attemptId?: string;
}

export type StateEntityType = "task" | "run" | "approval" | "media_job" | "workflow" | "workflow_step" | "work_unit";

export interface StateTransitionEvent {
  readonly id: string;
  readonly workspaceId: string;
  readonly entityType: StateEntityType;
  readonly entityId: string;
  readonly fromStatus: string;
  readonly toStatus: string;
  readonly event: string;
  readonly actor: "system" | "local-user" | "ai-teammate" | "runner" | "provider";
  readonly reason?: string;
  readonly idempotencyKey?: string;
  readonly createdAt: string;
}

export interface StateTransitionListResponse {
  readonly cwd: string;
  readonly transitions: readonly StateTransitionEvent[];
}

export interface ResourceLeaseListResponse {
  readonly cwd: string;
  readonly leases: readonly ResourceLease[];
}

export interface ListStateTransitionsRequest {
  readonly entityType?: StateEntityType;
  readonly entityId?: string;
  readonly limit?: number;
}

export interface ListResourceLeasesRequest {
  readonly status?: ResourceLeaseStatus;
  readonly ownerId?: string;
  readonly ownerType?: ResourceLease["ownerType"];
  readonly resourceType?: ResourceType;
  readonly resourceKey?: string;
  readonly workUnitId?: string;
  readonly attemptId?: string;
  readonly limit?: number;
}
