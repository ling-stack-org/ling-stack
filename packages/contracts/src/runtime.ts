import type { RunStatus, RunTool } from "./shared.js";
import type { ResourceLease } from "./workflows.js";

export type RuntimePermissionRequestKind =
  | "core_tool"
  | "write_scope"
  | "mcp_tool"
  | "runner_capability";

export type RuntimePermissionScope =
  | {
      readonly kind: "core_tool";
      readonly tools: readonly RunTool[];
    }
  | {
      readonly kind: "write_scope";
      readonly paths: readonly string[];
      readonly operation: "read_write" | "create" | "update" | "delete";
    }
  | {
      readonly kind: "mcp_tool";
      readonly serverId: string;
      readonly toolName: string;
      readonly sideEffectLevel: string;
      readonly defaultApproval: string;
    }
  | {
      readonly kind: "runner_capability";
      readonly runnerId: string;
      readonly capability: string;
    };

export interface RuntimePermissionScopeSnapshot {
  readonly tools: readonly RunTool[];
  readonly allowedWritePaths: readonly string[];
  readonly mcpToolRefs: readonly string[];
  readonly runnerId: string;
  readonly runnerCapabilities?: readonly string[];
}

export interface RuntimePermissionContinuationPlan {
  readonly mode: "same_run_if_supported" | "queue_followup" | "interrupt_redirect";
  readonly toolDelta?: readonly RunTool[];
  readonly writePathDelta?: readonly string[];
  readonly mcpToolDelta?: readonly string[];
  readonly runnerCapabilityDelta?: readonly string[];
  readonly reason: string;
}

export interface RuntimePermissionRequestPayload {
  readonly type: "runtime_permission_request";
  readonly requestKind: RuntimePermissionRequestKind;
  readonly requestedByRunId: string;
  readonly requestedByToolCallId?: string;
  readonly reason: string;
  readonly requestedScope: RuntimePermissionScope;
  readonly currentScope: RuntimePermissionScopeSnapshot;
  readonly proposedContinuation: RuntimePermissionContinuationPlan;
}

export interface RuntimePermissionGrant {
  readonly id: string;
  readonly approvalId: string;
  readonly runId: string;
  readonly scope: RuntimePermissionScope;
  readonly mode: "same_run" | "continuation";
  readonly createdAt: string;
  readonly expiresAt?: string;
}

export interface DaemonHealthResponse {
  readonly ok: boolean;
  readonly service?: string;
  readonly defaultWorkspaceCwd?: string;
  readonly features?: DaemonFeatureFlags;
}

export interface DaemonFeatureFlags {
  readonly channels: {
    readonly autoRoute: boolean;
    readonly intentSelector?: boolean;
  };
  readonly transports?: {
    readonly providerWebSocketFallback: boolean;
    readonly localWebSocketRpc: boolean;
  };
}

export type RuntimeInstanceStatus = "healthy" | "starting" | "stopping" | "recovering";

export interface RuntimeInstance {
  readonly workspaceId: string;
  readonly runtimeInstanceId: string;
  readonly pid: number;
  readonly host: string;
  readonly port: number;
  readonly startedAt: string;
  readonly version: string;
  readonly schemaVersion: number;
  readonly status: RuntimeInstanceStatus;
}

export type WorkUnitKind =
  | "task_run"
  | "channel_ai_reply"
  | "teammate_direct_reply"
  | "external_work_step"
  | "external_work_action"
  | "media_job";

export type WorkUnitStatus =
  | "queued"
  | "claimed"
  | "running"
  | "waiting_for_approval"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "stale";

export type WorkUnitAttemptStatus =
  | "created"
  | "started"
  | "waiting_for_approval"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "lost";

export type RuntimeEventType =
  | "work_unit_created"
  | "work_unit_queued"
  | "work_unit_claimed"
  | "work_unit_started"
  | "work_unit_heartbeat"
  | "work_unit_progress"
  | "work_unit_approval_requested"
  | "work_unit_cancelling"
  | "work_unit_succeeded"
  | "work_unit_failed"
  | "work_unit_cancelled"
  | "work_unit_stale"
  | "lease_acquired"
  | "lease_renewed"
  | "lease_released"
  | "semaphore_acquired"
  | "semaphore_released"
  | "artifact_created"
  | "stale_runner_completion_ignored"
  | "diagnostic_stuck_detected";

export interface RuntimeTimeoutPolicy {
  readonly heartbeatIntervalMs: number;
  readonly heartbeatTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly hardTimeoutMs: number;
  readonly cancelGraceMs: number;
}

export interface RunnerFallbackReason {
  readonly code:
    | "missing_requested_runner"
    | "disabled_requested_runner"
    | "unsupported_provider_api"
    | "unsupported_tool";
  readonly message: string;
}

export type RunnerFallbackPolicy = "disabled" | "allow_to_default";

export type RunnerRequestSource =
  | "product_default"
  | "workspace_default"
  | "teammate_default"
  | "workflow_step"
  | "run_request"
  | "user_explicit";

export interface WorkspaceRuntimeSettings {
  readonly workspaceId: string;
  readonly defaultRunnerId: string;
  readonly allowedRunnerIds: readonly string[];
  readonly explicitRunnerFallback: RunnerFallbackPolicy;
  readonly implicitRunnerFallback: RunnerFallbackPolicy;
  readonly updatedAt: string;
}

export interface WorkspaceRuntimeSettingsPatch {
  readonly defaultRunnerId?: string;
  readonly allowedRunnerIds?: readonly string[];
  readonly explicitRunnerFallback?: RunnerFallbackPolicy;
  readonly implicitRunnerFallback?: RunnerFallbackPolicy;
}

export interface RunnerListItem {
  readonly id: string;
  readonly displayName: string;
  readonly status: "enabled" | "disabled";
  readonly aliases?: readonly string[];
  readonly supportedProviderApis?: readonly string[];
  readonly supportedTools?: readonly string[];
  readonly capabilities?: readonly string[];
  readonly featureFlag?: string;
  readonly disabledReason?: string;
}

export interface RunnerListResponse {
  readonly cwd: string;
  readonly runners: readonly RunnerListItem[];
}

export type RuntimeExtensionKind =
  | "provider"
  | "runner"
  | "channel-source"
  | "skill-pack"
  | "tool"
  | "memory"
  | "automation";

export type RuntimeExtensionTrustLevel = "internal" | "internal-isolated";

export interface RuntimeExtensionView {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly kind: RuntimeExtensionKind;
  readonly trustLevel: RuntimeExtensionTrustLevel;
  readonly capabilities: readonly string[];
  readonly defaultApproval?: "allow" | "ask" | "deny";
  readonly sideEffectLevel?: "none" | "read" | "write" | "write-network" | "external" | "credential" | "deploy";
}

export interface RuntimeExtensionListResponse {
  readonly cwd: string;
  readonly extensions: readonly RuntimeExtensionView[];
}

export interface RuntimeSettingsResponse {
  readonly cwd: string;
  readonly settings: WorkspaceRuntimeSettings;
}

export interface WorkUnit {
  readonly id: string;
  readonly workspaceId: string;
  readonly kind: WorkUnitKind;
  readonly ownerType: string;
  readonly ownerId: string;
  readonly channelId?: string;
  readonly taskId?: string;
  readonly teammateId?: string;
  readonly providerPresetId?: string;
  readonly runnerId?: string;
  readonly requestedRunnerId?: string;
  readonly effectiveRunnerId?: string;
  readonly fallbackReason?: RunnerFallbackReason;
  readonly idempotencyKey: string;
  readonly status: WorkUnitStatus;
  readonly priority: number;
  readonly attemptCount: number;
  readonly activeAttemptId?: string;
  readonly createdByClientId?: string;
  readonly createdByActor: "user" | "system" | "scheduler";
  readonly request: unknown;
  readonly timeoutPolicy: RuntimeTimeoutPolicy;
  readonly linkedRunId?: string;
  readonly linkedMessageId?: string;
  readonly linkedMediaJobId?: string;
  readonly linkedExternalWorkId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly lastEventAt?: string;
  readonly lastHeartbeatAt?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

export interface WorkUnitAttempt {
  readonly id: string;
  readonly workUnitId: string;
  readonly attemptNumber: number;
  readonly runtimeInstanceId: string;
  readonly runnerId: string;
  readonly requestedRunnerId?: string;
  readonly effectiveRunnerId: string;
  readonly fallbackReason?: RunnerFallbackReason;
  readonly providerPresetId?: string;
  readonly status: WorkUnitAttemptStatus;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly lastEventAt?: string;
  readonly lastHeartbeatAt?: string;
  readonly abortRequestedAt?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

export interface RuntimeEvent {
  readonly id: string;
  readonly workUnitId: string;
  readonly attemptId?: string;
  readonly seq: number;
  readonly ts: string;
  readonly type: RuntimeEventType;
  readonly actor: "system" | "runner" | "provider" | "local-user";
  readonly data: unknown;
}

export type RuntimeSemaphoreResourceType = "provider" | "channel_parallel" | "runner" | "media_provider";

export type RuntimeSemaphoreSlotStatus = "active" | "released" | "expired";

export interface RuntimeSemaphoreSlot {
  readonly id: string;
  readonly workspaceId: string;
  readonly resourceType: RuntimeSemaphoreResourceType;
  readonly resourceKey: string;
  readonly ownerType: "work_unit_attempt" | "system";
  readonly ownerId: string;
  readonly workUnitId: string;
  readonly attemptId: string;
  readonly status: RuntimeSemaphoreSlotStatus;
  readonly acquiredAt: string;
  readonly lastRenewedAt: string;
  readonly expiresAt: string;
  readonly releasedAt?: string;
  readonly releaseReason?: string;
}

export interface RuntimeResponse {
  readonly cwd: string;
  readonly runtime: RuntimeInstance;
}

export interface RuntimeDiagnosticsResponse {
  readonly cwd: string;
  readonly runtime: RuntimeInstance;
  readonly active: readonly WorkUnit[];
  readonly stuck: readonly WorkUnit[];
  readonly queued: readonly WorkUnit[];
  readonly stale: readonly WorkUnit[];
  readonly leases: readonly ResourceLease[];
  readonly semaphoreSlots: readonly RuntimeSemaphoreSlot[];
}

export interface WorkUnitListResponse {
  readonly cwd: string;
  readonly workUnits: readonly WorkUnit[];
}

export interface WorkUnitDetailResponse {
  readonly cwd: string;
  readonly workUnit: WorkUnit;
  readonly attempts: readonly WorkUnitAttempt[];
  readonly events: readonly RuntimeEvent[];
  readonly leases: readonly ResourceLease[];
  readonly semaphoreSlots: readonly RuntimeSemaphoreSlot[];
  readonly run?: RunSession;
}

export interface WorkUnitEventsResponse {
  readonly cwd: string;
  readonly workUnitId: string;
  readonly events: readonly RuntimeEvent[];
  readonly nextSeq: number;
}

export interface WorkUnitMutationResponse {
  readonly cwd: string;
  readonly workUnit: WorkUnit;
  readonly event?: RuntimeEvent;
}

export interface RuntimeSemaphoreListResponse {
  readonly cwd: string;
  readonly semaphoreSlots: readonly RuntimeSemaphoreSlot[];
}

export type RunEventType =
  | "run_created"
  | "run_start"
  | "turn_start"
  | "turn_end"
  | "assistant_text_delta"
  | "assistant_thinking_delta"
  | "message_end"
  | "tool_start"
  | "tool_update"
  | "tool_end"
  | "run_end"
  | "run_error"
  | "run_cancelled"
  | "approval_requested"
  | "approval_approved"
  | "approval_denied"
  | "approval_expired"
  | "approval_cancelled"
  | "artifact_created"
  | "run_intervention_created"
  | "run_followup_queued"
  | "run_interrupt_requested"
  | "run_continuation_starting"
  | "run_continuation_started"
  | "run_intervention_failed"
  | "stale_runner_completion_ignored"
  | "result";

export interface RunEventEnvelope {
  readonly id: string;
  readonly runId: string;
  readonly seq: number;
  readonly ts: string;
  readonly type: RunEventType;
  readonly data: unknown;
}

export interface RunSession {
  readonly id: string;
  readonly status: RunStatus;
  readonly cwd: string;
  readonly taskId: string;
  readonly channelId?: string;
  readonly teammateId?: string;
  readonly workflowStepId?: string;
  readonly selectedSkillId?: string;
  readonly providerPresetId?: string;
  readonly providerName: string;
  readonly providerModel: string;
  readonly taskSnapshot: unknown;
  readonly providerSnapshot: unknown;
  readonly requestSnapshot: unknown;
  readonly eventLogPath: string;
  readonly threadId?: string;
  readonly workUnitId?: string;
  readonly parentRunId?: string;
  readonly interventionId?: string;
  readonly continuationReason?: RunContinuationReason;
  readonly summaryPath?: string;
  readonly errorMessage?: string;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly updatedAt: string;
}

export interface RunEventsResponse {
  readonly runId: string;
  readonly events: readonly RunEventEnvelope[];
  readonly nextSeq: number;
}

export interface RunListResponse {
  readonly cwd: string;
  readonly runs: readonly RunSession[];
}

export interface RunListRequest {
  readonly status?: RunStatus;
  readonly teammateId?: string;
  readonly workflowStepId?: string;
  readonly threadId?: string;
  readonly limit?: number;
}

export interface RunCancelResponse {
  readonly cancelled: boolean;
  readonly active: boolean;
  readonly run?: RunSession;
  readonly event?: RunEventEnvelope;
}

export type RunInterventionMode = "queue_followup" | "interrupt_redirect";

export type RunContinuationReason = RunInterventionMode | "manual_resume";

export type RunInterventionStatus =
  | "queued"
  | "cancelling_source"
  | "starting_continuation"
  | "started"
  | "failed"
  | "cancelled";

export interface RunInterventionMessagePayload {
  readonly body: string;
  readonly attachmentIds: readonly string[];
  readonly linkPreviewIds: readonly string[];
  readonly attachments?: readonly RunInterventionAttachmentPayload[];
  readonly linkPreviews?: readonly RunInterventionLinkPreviewPayload[];
  readonly fileRefs?: readonly RunInterventionWorkspaceFilePayload[];
}

export type RunInterventionMaterializationStatus = "available" | "metadata_only" | "not_loaded" | "unsupported" | "blocked";

export interface RunInterventionAttachmentPayload {
  readonly id: string;
  readonly fileName: string;
  readonly kind: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly materializationStatus: RunInterventionMaterializationStatus;
  readonly previewStatus?: string;
  readonly previewText?: string;
  readonly reason?: string;
}

export interface RunInterventionLinkPreviewPayload {
  readonly id: string;
  readonly url: string;
  readonly normalizedUrl: string;
  readonly title?: string;
  readonly description?: string;
  readonly siteName?: string;
  readonly status: string;
  readonly materializationStatus: RunInterventionMaterializationStatus;
  readonly previewText?: string;
  readonly reason?: string;
}

export interface RunInterventionWorkspaceFilePayload {
  readonly path: string;
  readonly label?: string;
  readonly rootRelation: "inside_workspace" | "outside_workspace" | "unknown";
  readonly kind: "file" | "directory" | "glob" | "unknown";
  readonly materializationStatus: RunInterventionMaterializationStatus;
  readonly previewText?: string;
  readonly blockedReason?: string;
}

export interface RunIntervention {
  readonly id: string;
  readonly workspaceId: string;
  readonly sourceRunId: string;
  readonly sourceWorkUnitId?: string;
  readonly sourceAttemptId?: string;
  readonly continuationRunId?: string;
  readonly continuationWorkUnitId?: string;
  readonly mode: RunInterventionMode;
  readonly status: RunInterventionStatus;
  readonly instruction: string;
  readonly messagePayload?: RunInterventionMessagePayload;
  readonly requestedBy: "local-user" | "system";
  readonly idempotencyKey: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly failureReason?: string;
}

export interface CreateRunInterventionRequest {
  readonly mode: RunInterventionMode;
  readonly instruction: string;
  readonly messagePayload?: RunInterventionMessagePayload;
  readonly idempotencyKey?: string;
}

export interface RunInterventionListResponse {
  readonly cwd: string;
  readonly interventions: readonly RunIntervention[];
}

export interface RunInterventionResponse {
  readonly cwd: string;
  readonly intervention: RunIntervention;
  readonly run?: RunSession;
  readonly event?: RunEventEnvelope;
}
