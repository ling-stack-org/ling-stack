import type { ApprovalRequest, SkillApprovalProfile } from "./approvals.js";
import type { RunSession, RunnerFallbackReason, RunnerRequestSource } from "./runtime.js";
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

export interface ChannelWorkflowStepContextPacket {
  readonly schemaVersion: 1;
  readonly workflowId: string;
  readonly workflowStepId: string;
  readonly objective: string;
  readonly stepTitle: string;
  readonly stepPrompt: string;
  readonly dependencies: readonly WorkflowStepOutputRef[];
  readonly priorOutputArtifactIds: readonly string[];
  readonly requestedRunnerId?: string;
  readonly effectiveRunnerId?: string;
  readonly providerPresetId?: string;
  readonly approvalGate?: SkillApprovalProfile;
  readonly generatedAt: string;
}

export interface ChannelWorkflowStepOutputPacket {
  readonly schemaVersion: 1;
  readonly workflowId: string;
  readonly workflowStepId: string;
  readonly runId?: string;
  readonly status: ChannelWorkflowStepStatus;
  readonly resultSummary?: string;
  readonly artifactIds: readonly string[];
  readonly runnerAudit?: RunnerResolutionAudit;
  readonly generatedAt: string;
}

export interface ChannelWorkflowStepMetadata {
  readonly workflowTemplateId?: string;
  readonly templateVersion?: string;
  readonly templateStepId?: string;
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
  readonly autoStart?: boolean;
  readonly approvalGate?: SkillApprovalProfile;
  readonly preStepApprovalId?: string;
  readonly policy?: WorkflowStepPolicy;
  readonly gates?: readonly WorkflowStepGate[];
  readonly activeGateStage?: "pre" | "post";
  readonly postStepApprovalId?: string;
  readonly contextArtifactId?: string;
  readonly outputArtifactId?: string;
  readonly outputArtifactIds?: readonly string[];
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

export type CreateChannelWorkflowTemplateCompileRequest =
  | CreateChannelWorkflowFromTemplateRequest
  | CreateChannelWorkflowFromCustomTemplateRequest
  | CreateChannelWorkflowFromCustomTemplateIdRequest;

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
