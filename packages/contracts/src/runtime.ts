import type { RunStatus, RunTool } from "./shared.js";
import type { ResourceLease } from "./workflows.js";
import type { RunnerReadinessSummary } from "./runner-readiness.js";
import type { RunnerToolHydrationCapability } from "./tool-surfaces.js";

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
  readonly readiness?: "starting" | "ready" | "degraded" | "failed";
  readonly features?: DaemonFeatureFlags;
}

export interface DaemonFeatureFlags {
  readonly channels: {
    readonly autoRoute: boolean;
    readonly intentSelector?: boolean;
    readonly teamObserverBus?: boolean;
    readonly terminalReports?: boolean;
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
  | "conversation_run"
  | "channel_turn_dispatch"
  | "channel_ai_reply"
  | "channel_terminal_report"
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

export interface RuntimeAttemptFenceV1 {
  readonly workUnitId: string;
  readonly attemptId: string;
  readonly runtimeInstanceId: string;
  /** Opaque decimal generation. Consumers must not coerce this value to Number. */
  readonly fencingToken: string;
}

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
  | "tool_namespace_materialized"
  | "tool_hydration_rejected"
  | "web_evidence_recorded"
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
  readonly toolHydration?: RunnerToolHydrationCapability;
  readonly featureFlag?: string;
  readonly disabledReason?: string;
  readonly readiness?: RunnerReadinessSummary;
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
  readonly fencingToken: string;
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
  readonly runtimeInstanceId?: string;
  readonly fencingToken?: string;
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
  readonly runtimeInstanceId: string;
  readonly fencingToken: string;
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
  | "tool_hydration_request"
  | "tool_hydration_end"
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
  | "workspace_change_recovery_started"
  | "workspace_changes_undone"
  | "workspace_changes_reapplied"
  | "run_intervention_created"
  | "run_followup_queued"
  | "run_interrupt_requested"
  | "run_continuation_starting"
  | "run_continuation_started"
  | "run_intervention_failed"
  | "stale_runner_completion_ignored"
  | "result"
  /** Legacy generic progress rows retained for old event logs. */
  | "progress";

/**
 * Typed payloads for durable run events.
 *
 * The index signature on each payload is intentional for forward-compatible
 * provider metadata. The envelope itself remains a discriminated union on
 * `type`, so consumers can narrow the payload before reading event-specific
 * fields instead of treating the entire event as arbitrary JSON.
 */
export interface RunEventDataByType {
  readonly run_created: {
    readonly taskId?: string;
    readonly workUnitId?: string;
    readonly threadId?: string;
    readonly cwd?: string;
    readonly providerName?: string;
    readonly providerModel?: string;
    readonly queued?: boolean;
    readonly [key: string]: unknown;
  };
  readonly run_start: {
    readonly taskId?: string;
    readonly cwd?: string;
    readonly provider?: string;
    readonly model?: string;
    readonly [key: string]: unknown;
  };
  readonly turn_start: { readonly [key: string]: unknown };
  readonly turn_end: { readonly [key: string]: unknown };
  readonly assistant_text_delta: {
    readonly text: string;
    readonly [key: string]: unknown;
  };
  readonly assistant_thinking_delta: {
    readonly text: string;
    readonly [key: string]: unknown;
  };
  readonly tool_hydration_request: {
    readonly runId?: string;
    readonly runnerAttemptId?: string;
    readonly scope?: unknown;
    readonly [key: string]: unknown;
  };
  readonly tool_hydration_end: {
    readonly runId?: string;
    readonly runnerAttemptId?: string;
    readonly rejected?: boolean;
    readonly code?: string;
    readonly [key: string]: unknown;
  };
  readonly message_end: {
    readonly role?: string;
    readonly text?: string;
    readonly stopReason?: string;
    readonly errorMessage?: string;
    readonly contentKinds?: readonly string[];
    readonly [key: string]: unknown;
  };
  readonly tool_start: {
    readonly toolCallId?: string;
    readonly toolName: string;
    readonly args?: unknown;
    readonly [key: string]: unknown;
  };
  readonly tool_update: {
    readonly toolCallId?: string;
    readonly toolName: string;
    readonly partialResult?: unknown;
    readonly [key: string]: unknown;
  };
  readonly tool_end: {
    readonly toolCallId?: string;
    readonly toolName: string;
    readonly result?: unknown;
    readonly isError: boolean;
    readonly [key: string]: unknown;
  };
  readonly run_end: {
    readonly taskId?: string;
    readonly messageCount?: number;
    readonly [key: string]: unknown;
  };
  readonly run_error: {
    readonly message: string;
    readonly [key: string]: unknown;
  };
  readonly run_cancelled: {
    readonly reason?: string;
    readonly active?: boolean;
    readonly [key: string]: unknown;
  };
  readonly approval_requested: {
    readonly approvalId: string;
    readonly toolCallId?: string;
    readonly title?: string;
    readonly description?: string;
    readonly expiresAt?: string;
    readonly [key: string]: unknown;
  };
  readonly approval_approved: {
    readonly approvalId: string;
    readonly decisionReason?: string;
    readonly [key: string]: unknown;
  };
  readonly approval_denied: {
    readonly approvalId: string;
    readonly decisionReason?: string;
    readonly [key: string]: unknown;
  };
  readonly approval_expired: {
    readonly approvalId: string;
    readonly decisionReason?: string;
    readonly [key: string]: unknown;
  };
  readonly approval_cancelled: {
    readonly approvalId: string;
    readonly decisionReason?: string;
    readonly [key: string]: unknown;
  };
  readonly artifact_created: {
    readonly artifactId?: string;
    readonly toolCallId?: string;
    readonly toolName?: string;
    readonly artifact?: unknown;
    readonly [key: string]: unknown;
  };
  readonly workspace_change_recovery_started: {
    readonly [key: string]: unknown;
  };
  readonly workspace_changes_undone: {
    readonly [key: string]: unknown;
  };
  readonly workspace_changes_reapplied: {
    readonly [key: string]: unknown;
  };
  readonly run_intervention_created: {
    readonly interventionId?: string;
    readonly mode?: string;
    readonly [key: string]: unknown;
  };
  readonly run_followup_queued: {
    readonly interventionId?: string;
    readonly [key: string]: unknown;
  };
  readonly run_interrupt_requested: {
    readonly interventionId?: string;
    readonly [key: string]: unknown;
  };
  readonly run_continuation_starting: {
    readonly interventionId?: string;
    readonly [key: string]: unknown;
  };
  readonly run_continuation_started: {
    readonly interventionId?: string;
    readonly continuationRunId?: string;
    readonly [key: string]: unknown;
  };
  readonly run_intervention_failed: {
    readonly interventionId?: string;
    readonly reason?: string;
    readonly [key: string]: unknown;
  };
  readonly stale_runner_completion_ignored: {
    readonly reason?: string;
    readonly reportedStatus?: string;
    readonly [key: string]: unknown;
  };
  readonly result: {
    readonly text?: string;
    readonly [key: string]: unknown;
  };
  readonly progress: {
    readonly message?: string;
    readonly [key: string]: unknown;
  };
}

export type RunEventData = RunEventDataByType[RunEventType];

export type RunEventEnvelope = {
  readonly [K in RunEventType]: {
    readonly id: string;
    readonly runId: string;
    readonly seq: number;
    readonly ts: string;
    readonly type: K;
    readonly data: RunEventDataByType[K];
  };
}[RunEventType];

export type ConversationActiveReplyStatus = "queued" | "running" | "waiting_for_approval";

export interface ConversationActiveReplyTarget {
  readonly runId: string;
  readonly sourceRunId: string;
  readonly workUnitId?: string;
  readonly channelId?: string;
  readonly threadId?: string;
  readonly sourceMessageId?: string;
  readonly teammateId?: string;
  readonly status: ConversationActiveReplyStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
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
  readonly contextViewId?: string;
  readonly contextViewCreatedAt?: string;
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
  readonly sourceMessageId?: string;
  readonly targetTeammateId?: string;
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
