export type RunStatus = "queued" | "running" | "waiting_for_approval" | "succeeded" | "failed" | "cancelled";
export type LingThreadKind = "task" | "channel_discussion" | "teammate_direct" | "workflow_step" | "external_work" | "automation";
export type LingThreadStatus = "open" | "running" | "waiting_for_approval" | "blocked" | "succeeded" | "failed" | "cancelled" | "archived";

export interface LingThread {
  readonly id: string;
  readonly workspaceId: string;
  readonly kind: LingThreadKind;
  readonly channelId?: string;
  readonly taskId?: string;
  readonly teammateId?: string;
  readonly workflowId?: string;
  readonly workflowStepId?: string;
  readonly externalWorkId?: string;
  readonly title: string;
  readonly objective: string;
  readonly status: LingThreadStatus;
  readonly activeRunId?: string;
  readonly lastRunId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt?: string;
}

export interface LingThreadListResponse {
  readonly cwd: string;
  readonly threads: readonly LingThread[];
}

export interface LingThreadListRequest {
  readonly kind?: LingThreadKind;
  readonly channelId?: string;
  readonly taskId?: string;
  readonly teammateId?: string;
  readonly workflowStepId?: string;
  readonly externalWorkId?: string;
  readonly status?: LingThreadStatus;
  readonly includeArchived?: boolean;
  readonly limit?: number;
}

export interface LingThreadDetailResponse {
  readonly cwd: string;
  readonly thread: LingThread;
}

export interface LingThreadEvidenceRun {
  readonly run: RunSession;
  readonly events: readonly RunEventEnvelope[];
  readonly approvals: readonly ApprovalRequest[];
  readonly artifacts: readonly RunArtifact[];
  readonly runtimeEvents: readonly RuntimeEvent[];
}

export interface LingThreadEvidenceResponse {
  readonly cwd: string;
  readonly thread: LingThread;
  readonly generatedAt: string;
  readonly runs: readonly LingThreadEvidenceRun[];
  readonly actions: readonly ExecutionAction[];
  readonly transitions: readonly StateTransitionEvent[];
}

export interface LingThreadResumeResponse {
  readonly cwd: string;
  readonly thread: LingThread;
  readonly sourceRun: RunSession;
  readonly runId?: string;
  readonly continuationReason: "manual_resume";
}

export interface LingThreadResumeRequest {
  readonly instruction?: string;
  readonly idempotencyKey?: string;
  readonly sourceRunId?: string;
  readonly includeArtifacts?: boolean;
}

export interface ResumeContextPreview {
  readonly title: string;
  readonly instruction: string;
  readonly sourceRunId: string;
  readonly priorRunIds: readonly string[];
  readonly includedEventCount: number;
  readonly includedApprovalCount: number;
  readonly includedArtifactIds: readonly string[];
  readonly pendingActionIds: readonly string[];
  readonly contextText: string;
  readonly redactionNotes: readonly string[];
  readonly warnings: readonly string[];
}

export interface LingThreadResumePreviewResponse {
  readonly cwd: string;
  readonly thread: LingThread;
  readonly sourceRun: RunSession;
  readonly context: ResumeContextPreview;
}

export type AutomationStatus = "enabled" | "disabled" | "paused" | "archived" | "error";
export type AutomationKind = "daily_brief" | "weekly_review" | "project_monitor" | "custom_prompt";
export type AutomationDraftSource = "template" | "manual" | "chat";
export type AutomationDraftStatus = "draft" | "needs_user_input" | "ready_for_confirmation" | "confirmed" | "discarded";
export type AutomationDraftField =
  | "title"
  | "kind"
  | "trigger"
  | "target"
  | "promptTemplate"
  | "outputPolicy";
export type AutomationRunStatus =
  | "queued"
  | "skipped"
  | "running"
  | "waiting_for_approval"
  | "succeeded"
  | "failed"
  | "cancelled";

export type AutomationTrigger =
  | { readonly type: "manual" }
  | {
      readonly type: "schedule";
      readonly timezone: string;
      readonly schedule: AutomationSchedule;
      readonly missedRunPolicy: "skip" | "run_one";
    }
  | {
      readonly type: "monitor";
      readonly pollIntervalMs: number;
      readonly source: AutomationMonitorSource;
      readonly condition: AutomationMonitorCondition;
      readonly unchangedPolicy: "skip" | "record_noop";
    };

export type AutomationSchedule =
  | { readonly cadence: "daily"; readonly timeOfDay: string }
  | { readonly cadence: "weekly"; readonly weekday: 0 | 1 | 2 | 3 | 4 | 5 | 6; readonly timeOfDay: string }
  | { readonly cadence: "interval"; readonly everyMs: number };

export type AutomationMonitorSource =
  | { readonly kind: "doctor_summary" }
  | { readonly kind: "runtime_stuck_work" }
  | { readonly kind: "pending_approvals"; readonly olderThanMs?: number }
  | { readonly kind: "external_work"; readonly channelId?: string }
  | { readonly kind: "github_ci"; readonly channelId: string };

export type AutomationMonitorCondition =
  | { readonly kind: "any_change" }
  | { readonly kind: "count_above"; readonly field: string; readonly threshold: number }
  | { readonly kind: "status_matches"; readonly statuses: readonly string[] }
  | { readonly kind: "error_present" };

export interface AutomationTarget {
  readonly scope: "workspace" | "channel" | "task" | "thread" | "external_work";
  readonly workspaceId: string;
  readonly channelId?: string;
  readonly taskId?: string;
  readonly threadId?: string;
  readonly externalWorkId?: string;
  readonly cwd?: string;
}

export interface AutomationPromptTemplate {
  readonly templateVersion: number;
  readonly systemPurpose?: string;
  readonly promptMarkdown: string;
  readonly contextSelectors: readonly AutomationContextSelector[];
  readonly maxContextItems?: number;
}

export type AutomationContextSelector =
  | { readonly kind: "channel_brief"; readonly channelId?: string }
  | { readonly kind: "recent_runs"; readonly limit: number }
  | { readonly kind: "pending_approvals"; readonly limit: number }
  | { readonly kind: "recent_artifacts"; readonly limit: number }
  | { readonly kind: "state_transitions"; readonly limit: number }
  | { readonly kind: "external_work"; readonly status?: string; readonly limit: number }
  | { readonly kind: "doctor_summary" }
  | { readonly kind: "mcp_status" };

export interface AutomationExecutionPolicy {
  readonly providerPresetId?: string;
  readonly teammateId?: string;
  readonly requestedSkillId?: string;
  readonly runnerId?: string;
  readonly allowedTools?: readonly RunTool[];
  readonly approvalProfile?: SkillApprovalProfile;
  readonly permissionMode?: SessionPermissionMode;
  readonly skipProviderPreflight?: boolean;
}

export interface AutomationOutputPolicy {
  readonly destinations: readonly AutomationOutputDestination[];
  readonly artifactFormat: "markdown";
}

export type AutomationOutputDestination =
  | { readonly type: "automation_thread" }
  | { readonly type: "markdown_artifact" };

export interface AutomationDefinition {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId?: string;
  readonly threadId: string;
  readonly title: string;
  readonly description?: string;
  readonly kind: AutomationKind;
  readonly status: AutomationStatus;
  readonly trigger: AutomationTrigger;
  readonly target: AutomationTarget;
  readonly promptTemplate: AutomationPromptTemplate;
  readonly executionPolicy: AutomationExecutionPolicy;
  readonly outputPolicy: AutomationOutputPolicy;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastRunId?: string;
  readonly nextRunAt?: string;
  readonly lastErrorMessage?: string;
}

export interface AutomationRun {
  readonly id: string;
  readonly automationId: string;
  readonly workspaceId: string;
  readonly channelId?: string;
  readonly threadId: string;
  readonly runId?: string;
  readonly triggerType: AutomationTrigger["type"];
  readonly scheduledFor?: string;
  readonly firedAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly status: AutomationRunStatus;
  readonly idempotencyKey: string;
  readonly contextPreviewArtifactId?: string;
  readonly outputArtifactIds: readonly string[];
  readonly skipReason?: string;
  readonly errorMessage?: string;
}

export interface AutomationDraftWarning {
  readonly code: string;
  readonly message: string;
  readonly field?: AutomationDraftField;
}

export interface AutomationDraft {
  readonly id: string;
  readonly source: AutomationDraftSource;
  readonly status: AutomationDraftStatus;
  readonly workspaceId: string;
  readonly channelId?: string;
  readonly title?: string;
  readonly description?: string;
  readonly kind?: AutomationKind;
  readonly trigger?: AutomationTrigger;
  readonly target?: AutomationTarget;
  readonly promptTemplate?: AutomationPromptTemplate;
  readonly executionPolicy?: AutomationExecutionPolicy;
  readonly outputPolicy?: AutomationOutputPolicy;
  readonly missingFields: readonly AutomationDraftField[];
  readonly warnings: readonly AutomationDraftWarning[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly proposedByRunId?: string;
  readonly proposedByThreadId?: string;
  readonly confirmedAutomationId?: string;
  readonly discardedAt?: string;
}

export type BuiltinAutomationTemplateId =
  | "daily_brief"
  | "weekly_review"
  | "ci_failure_summary"
  | "release_note_draft"
  | "bug_scan"
  | "pr_risk_summary"
  | "ownership_suggestion"
  | "dependency_check";

export interface AutomationTemplateRequirement {
  readonly field: AutomationDraftField;
  readonly label: string;
  readonly required: boolean;
}

export interface BuiltinAutomationTemplate {
  readonly id: BuiltinAutomationTemplateId;
  readonly kind: AutomationKind;
  readonly title: string;
  readonly description: string;
  readonly category: "briefing" | "engineering" | "release" | "ownership";
  readonly tags: readonly string[];
  readonly requirements: readonly AutomationTemplateRequirement[];
  readonly defaultTrigger: AutomationTrigger;
  readonly defaultPromptTemplate: AutomationPromptTemplate;
  readonly defaultExecutionPolicy: AutomationExecutionPolicy;
  readonly defaultOutputPolicy: AutomationOutputPolicy;
}

export interface AutomationContextRef {
  readonly kind: string;
  readonly id?: string;
  readonly label?: string;
}

export interface AutomationContextPreview {
  readonly renderedPrompt: string;
  readonly contextMarkdown: string;
  readonly selectedRefs: readonly AutomationContextRef[];
  readonly warnings: readonly string[];
}

export interface CreateAutomationRequest {
  readonly kind: AutomationKind;
  readonly title: string;
  readonly channelId?: string;
  readonly description?: string;
  readonly target?: AutomationTarget;
  readonly trigger?: AutomationTrigger;
  readonly promptTemplate?: AutomationPromptTemplate;
  readonly executionPolicy?: AutomationExecutionPolicy;
  readonly outputPolicy?: AutomationOutputPolicy;
  readonly status?: AutomationStatus;
}

export interface UpdateAutomationRequest {
  readonly title?: string;
  readonly description?: string | null;
  readonly status?: AutomationStatus;
  readonly trigger?: AutomationTrigger;
  readonly target?: AutomationTarget;
  readonly promptTemplate?: AutomationPromptTemplate;
  readonly executionPolicy?: AutomationExecutionPolicy;
  readonly outputPolicy?: AutomationOutputPolicy;
  readonly nextRunAt?: string | null;
}

export interface CreateAutomationDraftRequest {
  readonly source: AutomationDraftSource;
  readonly templateId?: BuiltinAutomationTemplateId;
  readonly prompt?: string;
  readonly partialAutomation?: Partial<CreateAutomationRequest>;
  readonly proposedByRunId?: string;
  readonly proposedByThreadId?: string;
}

export interface UpdateAutomationDraftRequest {
  readonly partialAutomation?: Partial<CreateAutomationRequest>;
  readonly proposedByRunId?: string | null;
  readonly proposedByThreadId?: string | null;
}

export interface AutomationRunRequest {
  readonly idempotencyKey?: string;
  readonly triggerType?: AutomationTrigger["type"];
  readonly scheduledFor?: string;
}

export interface AutomationRunCancelRequest {
  readonly reason?: string;
}

export interface AutomationListRequest {
  readonly status?: AutomationStatus;
  readonly kind?: AutomationKind;
  readonly channelId?: string;
  readonly includeArchived?: boolean;
  readonly scheduledOnly?: boolean;
  readonly limit?: number;
}

export interface AutomationRunListRequest {
  readonly automationId?: string;
  readonly runId?: string;
  readonly status?: AutomationRunStatus;
  readonly limit?: number;
}

export interface AutomationDraftListRequest {
  readonly status?: AutomationDraftStatus;
  readonly source?: AutomationDraftSource;
  readonly channelId?: string;
  readonly includeTerminal?: boolean;
  readonly limit?: number;
}

export interface AutomationListResponse {
  readonly cwd: string;
  readonly automations: readonly AutomationDefinition[];
  readonly templates: readonly BuiltinAutomationTemplate[];
}

export interface AutomationDraftListResponse {
  readonly cwd: string;
  readonly drafts: readonly AutomationDraft[];
  readonly templates?: readonly BuiltinAutomationTemplate[];
}

export interface AutomationDraftMutationResponse {
  readonly cwd: string;
  readonly draft: AutomationDraft;
}

export interface AutomationDraftDetailResponse {
  readonly cwd: string;
  readonly draft: AutomationDraft;
}

export interface AutomationDraftPreviewResponse {
  readonly cwd: string;
  readonly draft: AutomationDraft;
  readonly context: AutomationContextPreview;
}

export interface ConfirmAutomationDraftResponse {
  readonly cwd: string;
  readonly draft: AutomationDraft;
  readonly automation: AutomationDefinition;
  readonly thread?: LingThread;
}

export interface AutomationMutationResponse {
  readonly cwd: string;
  readonly automation: AutomationDefinition;
  readonly thread?: LingThread;
}

export interface AutomationDetailResponse {
  readonly cwd: string;
  readonly automation: AutomationDefinition;
  readonly thread?: LingThread;
  readonly runs?: readonly AutomationRun[];
}

export interface AutomationPreviewResponse {
  readonly cwd: string;
  readonly automation: AutomationDefinition;
  readonly context: AutomationContextPreview;
}

export interface AutomationRunListResponse {
  readonly cwd: string;
  readonly automationRuns: readonly AutomationRun[];
}

export interface AutomationRunDetailResponse {
  readonly cwd: string;
  readonly automationRun: AutomationRun;
  readonly automation?: AutomationDefinition;
  readonly thread?: LingThread;
  readonly run?: RunSession;
}

export interface AutomationRunMutationResponse {
  readonly cwd: string;
  readonly automation?: AutomationDefinition;
  readonly automationRun: AutomationRun;
  readonly thread?: LingThread;
  readonly run?: RunSession;
  readonly context?: AutomationContextPreview;
}

export type AutomationSchedulerStatus = "running" | "stopped" | "error";

export interface AutomationSchedulerItem {
  readonly automationId: string;
  readonly title: string;
  readonly nextRunAt?: string;
  readonly lastRunAt?: string;
  readonly lastAutomationRunId?: string;
  readonly lastErrorMessage?: string;
}

export interface AutomationSchedulerState {
  readonly id: string;
  readonly cwd: string;
  readonly status: AutomationSchedulerStatus;
  readonly startedAt: string;
  readonly stoppedAt?: string;
  readonly automationCount: number;
  readonly tickCount: number;
  readonly nextRunAt?: string;
  readonly lastRunAt?: string;
  readonly lastErrorMessage?: string;
  readonly items: readonly AutomationSchedulerItem[];
}

export interface AutomationSchedulerListResponse {
  readonly cwd: string;
  readonly schedulers: readonly AutomationSchedulerState[];
}

export interface AutomationSchedulerMutationResponse {
  readonly cwd: string;
  readonly scheduler: AutomationSchedulerState;
  readonly duplicate?: boolean;
}

export type ExecutionActionStatus =
  | "proposed"
  | "waiting_for_approval"
  | "approved"
  | "denied"
  | "expired"
  | "cancelled"
  | "executing"
  | "succeeded"
  | "failed";

export type ExecutionScope =
  | "read_only"
  | "workspace_write"
  | "git_history"
  | "network"
  | "credential"
  | "provider_config"
  | "deployment"
  | "external_system";

export interface ExecutionActionTargetRef {
  readonly type:
    | "run"
    | "task"
    | "channel"
    | "workflow"
    | "workflow_step"
    | "work_unit"
    | "media_job"
    | "external_work_action"
    | "file"
    | "command"
    | "mcp_tool";
  readonly id?: string;
  readonly label?: string;
  readonly path?: string;
}

export interface ExecutionAction {
  readonly id: string;
  readonly workspaceId: string;
  readonly threadId?: string;
  readonly runId?: string;
  readonly workUnitId?: string;
  readonly approvalId?: string;
  readonly toolCallId?: string;
  readonly actionType: ApprovalActionType;
  readonly risk: ApprovalRisk;
  readonly status: ExecutionActionStatus;
  readonly title: string;
  readonly summary: string;
  readonly targetRefs: readonly ExecutionActionTargetRef[];
  readonly previewArtifactIds: readonly string[];
  readonly resultArtifactIds: readonly string[];
  readonly scopes?: readonly ExecutionScope[];
  readonly scopeSummary?: string;
  readonly policySnapshot?: unknown;
  readonly createdAt: string;
  readonly resolvedAt?: string;
  readonly executedAt?: string;
  readonly completedAt?: string;
}

export interface ExecutionActionListResponse {
  readonly cwd: string;
  readonly actions: readonly ExecutionAction[];
}

export type RunTool = "read" | "grep" | "find" | "ls" | "bash" | "edit" | "write";

export type RunThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type SessionPermissionMode = "ask_everything" | "balanced" | "workspace_write" | "full_access" | "custom";

export interface PermissionConfirmation {
  readonly mode: "full_access";
  readonly confirmed: true;
  readonly confirmedAt: string;
  readonly reason: string;
}

export interface EffectiveRunPolicyRiskNote {
  readonly code: string;
  readonly message: string;
  readonly tool?: RunTool;
}

export interface EffectiveRunPolicySnapshot {
  readonly mode: SessionPermissionMode;
  readonly toolDecisions: Record<RunTool, ApprovalToolDecision>;
  readonly allowedWritePaths: readonly string[];
  readonly workspacePolicyUpdatedAt?: string;
  readonly riskNotes: readonly EffectiveRunPolicyRiskNote[];
}

export interface DaemonHealthResponse {
  readonly ok: boolean;
  readonly service?: string;
  readonly defaultWorkspaceCwd?: string;
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

export type ArtifactType = "file" | "diff" | "log" | "json" | "markdown" | "image" | "video";

export interface RunArtifact {
  readonly id: string;
  readonly runId?: string;
  readonly mediaJobId?: string;
  readonly externalWorkId?: string;
  readonly type: ArtifactType;
  readonly path: string;
  readonly title?: string;
  readonly contentType?: string;
  readonly sizeBytes?: number;
  readonly createdAt: string;
}

export type PreviewContentKind =
  | "markdown_text"
  | "plain_text"
  | "code"
  | "json"
  | "log"
  | "diff"
  | "image"
  | "pdf"
  | "office"
  | "unsupported";

export interface PreviewFileRef {
  readonly id: string;
  readonly source: "attachment" | "artifact";
  readonly scope: "channel" | "teammate_private" | "run" | "external_work";
  readonly label: string;
  readonly displayPath?: string;
  readonly contentType?: string;
  readonly sizeBytes?: number;
  readonly previewable: boolean;
  readonly redacted?: boolean;
}

export interface PreviewContentResponse {
  readonly ref: PreviewFileRef;
  readonly kind: PreviewContentKind;
  readonly text?: string;
  readonly imageUrl?: string;
  readonly truncated: boolean;
  readonly sizeBytes?: number;
  readonly redactionNotes: readonly string[];
}

export type ExternalSourceKind = "github" | "linear";

export type ExternalWorkItemKind = "github_pull_request" | "github_issue" | "linear_issue";

export interface ExternalWorkflowSourceConfig {
  readonly kind: ExternalSourceKind;
  readonly repository?: string;
  readonly projectSlug?: string;
  readonly events: readonly string[];
  readonly activeStates: readonly string[];
  readonly terminalStates: readonly string[];
  readonly secretRef?: string;
}

export interface ExternalWorkflowSchedulerConfig {
  readonly pollIntervalMs: number;
  readonly maxConcurrentWorkItems: number;
  readonly maxConcurrentByKind: Readonly<Record<string, number>>;
  readonly maxRetryBackoffMs: number;
  readonly staleRunTimeoutMs?: number;
  readonly reconcileOnStartup: boolean;
}

export type ExternalWorkspaceMode = "per_subject" | "per_attempt";

export interface ExternalWorkspaceConfig {
  readonly root?: string;
  readonly mode: ExternalWorkspaceMode;
  readonly cleanupTerminalWorkItems: boolean;
}

export interface ExternalWorkspaceHooks {
  readonly afterCreate?: string;
  readonly beforeRun?: string;
  readonly afterRun?: string;
  readonly beforeRemove?: string;
  readonly timeoutMs: number;
}

export interface ExternalWorkflowAgentConfig {
  readonly teammateId?: string;
  readonly requestedSkillId?: string;
  readonly maxTurns: number;
}

export interface ExternalWorkflowActionsConfig {
  readonly defaultExternalMutationApproval: "standard" | "strict";
}

export interface ExternalWorkflowConfig {
  readonly source: ExternalWorkflowSourceConfig;
  readonly scheduler: ExternalWorkflowSchedulerConfig;
  readonly workspace: ExternalWorkspaceConfig;
  readonly hooks: ExternalWorkspaceHooks;
  readonly agent: ExternalWorkflowAgentConfig;
  readonly actions: ExternalWorkflowActionsConfig;
}

export interface ExternalWorkflowDefinition {
  readonly config: ExternalWorkflowConfig;
  readonly promptTemplate: string;
}

export interface ExternalWorkRepositoryRef {
  readonly owner: string;
  readonly name: string;
  readonly fullName: string;
  readonly defaultBranch: string;
}

export interface ExternalWorkItemBlocker {
  readonly id?: string;
  readonly identifier?: string;
  readonly state?: string;
}

export interface ExternalWorkItem {
  readonly id: string;
  readonly sourceKind: ExternalSourceKind;
  readonly kind: ExternalWorkItemKind;
  readonly identifier: string;
  readonly title: string;
  readonly description?: string;
  readonly url?: string;
  readonly state: string;
  readonly priority?: number;
  readonly labels: readonly string[];
  readonly repository?: ExternalWorkRepositoryRef;
  readonly branchName?: string;
  readonly baseSha?: string;
  readonly headSha?: string;
  readonly blockedBy?: readonly ExternalWorkItemBlocker[];
  readonly updatedAt?: string;
  readonly payloadRef: string;
  readonly idempotencyKey: string;
}

export interface ExternalWorkRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly sourceKind: ExternalSourceKind;
  readonly workItemKind: ExternalWorkItemKind;
  readonly externalId: string;
  readonly identifier: string;
  readonly idempotencyKey: string;
  readonly workflowId: string;
  readonly workflowStepId: string;
  readonly artifactIds: readonly string[];
  readonly item: ExternalWorkItem;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ExternalGitHubImportRequest {
  readonly channelId: string;
  readonly eventType: string;
  readonly payload: unknown;
  readonly workflowMarkdown?: string;
  readonly workflowPath?: string;
}

export interface ExternalLinearImportRequest {
  readonly channelId: string;
  readonly eventType: string;
  readonly payload: unknown;
  readonly workflowMarkdown?: string;
  readonly workflowPath?: string;
}

export type ExternalWorkSchedulerStatus =
  | "discovered"
  | "claimed"
  | "workspace_preparing"
  | "ready"
  | "blocked"
  | "retry_wait"
  | "terminal";

export interface ExternalWorkSchedulerState {
  readonly externalWorkId: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly subjectKey: string;
  readonly sourceKey: string;
  readonly workflowId: string;
  readonly workflowStepId: string;
  readonly schedulerStatus: ExternalWorkSchedulerStatus;
  readonly attemptCount: number;
  readonly lastAttemptAt?: string;
  readonly nextAttemptAt?: string;
  readonly maxRetryBackoffMs: number;
  readonly lastErrorCode?: string;
  readonly lastErrorMessage?: string;
  readonly workspacePath?: string;
  readonly workspaceMode?: ExternalWorkspaceMode;
  readonly hookArtifactIds: readonly string[];
  readonly lastReconciledAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ExternalWorkView {
  readonly externalWork: ExternalWorkRecord;
  readonly workflow?: ChannelWorkflow;
  readonly workflowStep?: ChannelWorkflowStep;
  readonly schedulerState?: ExternalWorkSchedulerState;
  readonly artifacts: readonly RunArtifact[];
}

export interface ExternalWorkListRequest {
  readonly channelId?: string;
  readonly sourceKind?: ExternalSourceKind;
  readonly workItemKind?: ExternalWorkItemKind;
  readonly schedulerStatus?: ExternalWorkSchedulerStatus;
  readonly limit?: number;
}

export interface ExternalWorkListResponse {
  readonly cwd: string;
  readonly externalWork: readonly ExternalWorkView[];
}

export interface ExternalWorkDetailResponse {
  readonly cwd: string;
  readonly externalWork: ExternalWorkView;
}

export type ExternalWorkActionKind = "github_comment" | "github_label" | "github_pr_review";

export type ExternalWorkActionStatus =
  | "proposed"
  | "waiting_for_approval"
  | "approved"
  | "executing"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "denied"
  | "expired"
  | "stale_target";

export type ExternalWorkActionApprovalRequirement = "standard" | "strict";

export interface ExternalWorkActionTarget {
  readonly sourceKind: ExternalSourceKind;
  readonly repository: string;
  readonly subjectKind: "github_pull_request" | "github_issue";
  readonly number: number;
  readonly url?: string;
  readonly expectedState: string;
  readonly expectedHeadSha?: string;
  readonly expectedUpdatedAt?: string;
  readonly expectedLabels: readonly string[];
}

export type ExternalWorkActionPayload =
  | {
      readonly type: "github_comment";
      readonly body: string;
    }
  | {
      readonly type: "github_label";
      readonly labels: readonly string[];
    }
  | {
      readonly type: "github_pr_review";
      readonly event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
      readonly body: string;
    };

export interface ExternalWorkAction {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly externalWorkId: string;
  readonly sourceKind: ExternalSourceKind;
  readonly actionKind: ExternalWorkActionKind;
  readonly status: ExternalWorkActionStatus;
  readonly approvalId?: string;
  readonly idempotencyKey: string;
  readonly target: ExternalWorkActionTarget;
  readonly payload: ExternalWorkActionPayload;
  readonly approvalRequirement: ExternalWorkActionApprovalRequirement;
  readonly artifactIds: readonly string[];
  readonly executionAttemptCount: number;
  readonly lastAttemptAt?: string;
  readonly nextAttemptAt?: string;
  readonly lastErrorCode?: string;
  readonly lastErrorMessage?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly executedAt?: string;
}

export interface ExternalWorkActionView {
  readonly action: ExternalWorkAction;
  readonly externalWork?: ExternalWorkRecord;
  readonly approval?: ApprovalRequest;
  readonly artifacts: readonly RunArtifact[];
}

export interface ExternalWorkActionProposeRequest {
  readonly externalWorkId: string;
  readonly actionKind: ExternalWorkActionKind;
  readonly payload: ExternalWorkActionPayload;
  readonly approvalRequirement?: ExternalWorkActionApprovalRequirement;
  readonly expiresAt?: string;
}

export interface ExternalWorkActionCancelRequest {
  readonly reason?: string;
}

export interface ExternalWorkActionExecuteRequest {
  readonly workflowPath?: string;
}

export interface ExternalWorkActionListRequest {
  readonly externalWorkId?: string;
  readonly channelId?: string;
  readonly status?: ExternalWorkActionStatus;
  readonly actionKind?: ExternalWorkActionKind;
  readonly limit?: number;
}

export interface ExternalWorkActionMutationResponse {
  readonly cwd: string;
  readonly action: ExternalWorkAction;
  readonly approval?: ApprovalRequest;
  readonly artifacts: readonly RunArtifact[];
  readonly duplicate?: boolean;
}

export interface ExternalWorkActionListResponse {
  readonly cwd: string;
  readonly actions: readonly ExternalWorkActionView[];
}

export interface ExternalWorkActionDetailResponse {
  readonly cwd: string;
  readonly action: ExternalWorkActionView;
}

export type ExternalWorkCiTriageStatus =
  | "triaged"
  | "task_created"
  | "run_requested"
  | "blocked"
  | "stale"
  | "failed";

export type GitHubCiFailureConclusion = "failure" | "cancelled" | "timed_out" | "action_required" | string;

export interface GitHubCiFailure {
  readonly repository: string;
  readonly subjectKind: "github_pull_request";
  readonly subjectNumber: number;
  readonly headSha: string;
  readonly checkName: string;
  readonly workflowName?: string;
  readonly jobName?: string;
  readonly conclusion: GitHubCiFailureConclusion;
  readonly htmlUrl?: string;
  readonly failureKey: string;
  readonly firstFailingCommand?: string;
  readonly reproductionCommand?: string;
  readonly suspectedSourcePath?: string;
  readonly logExcerptArtifactId?: string;
  readonly logErrorMessage?: string;
}

export interface ExternalWorkCiTriageRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly externalWorkId: string;
  readonly sourceKind: ExternalSourceKind;
  readonly repository: string;
  readonly subjectKind: "github_pull_request";
  readonly subjectNumber: number;
  readonly headSha: string;
  readonly failureKey: string;
  readonly status: ExternalWorkCiTriageStatus;
  readonly checkName: string;
  readonly workflowName?: string;
  readonly jobName?: string;
  readonly conclusion: GitHubCiFailureConclusion;
  readonly htmlUrl?: string;
  readonly firstFailingCommand?: string;
  readonly reproductionCommand?: string;
  readonly suspectedSourcePath?: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly artifactIds: readonly string[];
  readonly failure: GitHubCiFailure;
  readonly lastErrorCode?: string;
  readonly lastErrorMessage?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ExternalWorkCiTriageView {
  readonly triage: ExternalWorkCiTriageRecord;
  readonly externalWork?: ExternalWorkRecord;
  readonly task?: Task;
  readonly run?: RunSession;
  readonly artifacts: readonly RunArtifact[];
}

export interface ExternalWorkCiTriageRequest {
  readonly externalWorkId: string;
  readonly workflowPath?: string;
  readonly limit?: number;
  readonly createTask?: boolean;
  readonly startRun?: boolean;
}

export interface ExternalWorkCiTriageRunRequest {
  readonly providerPresetId: string;
  readonly skipProviderPreflight?: boolean;
  readonly idempotencyKey?: string;
  readonly tools?: readonly RunTool[];
  readonly thinkingLevel?: RunThinkingLevel;
  readonly systemPrompt?: string;
  readonly appendSystemPrompt?: readonly string[];
  readonly agentDir?: string;
}

export interface ExternalWorkCiTriageListRequest {
  readonly externalWorkId?: string;
  readonly channelId?: string;
  readonly status?: ExternalWorkCiTriageStatus;
  readonly limit?: number;
}

export interface ExternalWorkCiTriageListResponse {
  readonly cwd: string;
  readonly records: readonly ExternalWorkCiTriageView[];
}

export interface ExternalWorkCiTriageDetailResponse {
  readonly cwd: string;
  readonly record: ExternalWorkCiTriageView;
}

export interface ExternalWorkCiTriageResponse {
  readonly cwd: string;
  readonly triaged: number;
  readonly taskCreated: number;
  readonly duplicates: number;
  readonly blocked: number;
  readonly stale: number;
  readonly failed: number;
  readonly records: readonly ExternalWorkCiTriageView[];
}

export interface ExternalWorkPollRequest {
  readonly channelId: string;
  readonly workflowPath?: string;
  readonly limit?: number;
  readonly executeHooks?: boolean;
}

export interface ExternalWorkPollResultItem {
  readonly subjectKey?: string;
  readonly identifier?: string;
  readonly action: "claimed" | "duplicate" | "blocked" | "retry_scheduled" | "terminal_ignored";
  readonly externalWorkId?: string;
  readonly workflowId?: string;
  readonly workflowStepId?: string;
  readonly schedulerStatus?: ExternalWorkSchedulerStatus;
  readonly message?: string;
}

export interface ExternalWorkPollResponse {
  readonly candidates: number;
  readonly claimed: number;
  readonly duplicates: number;
  readonly blocked: number;
  readonly retryScheduled: number;
  readonly terminalIgnored: number;
  readonly artifacts: readonly RunArtifact[];
  readonly results: readonly ExternalWorkPollResultItem[];
  readonly schedulerStates: readonly ExternalWorkSchedulerState[];
}

export interface ExternalWorkReconcileRequest {
  readonly channelId?: string;
  readonly workflowPath?: string;
}

export interface ExternalWorkReconcileResponse {
  readonly expiredLeases: number;
  readonly checked: number;
  readonly blocked: number;
  readonly retryReady: number;
  readonly terminal: number;
  readonly schedulerStates: readonly ExternalWorkSchedulerState[];
}

export type ExternalWorkBackgroundSchedulerStatus = "running" | "stopped" | "failed";

export interface ExternalWorkBackgroundScheduler {
  readonly id: string;
  readonly cwd: string;
  readonly sourceKind: "github";
  readonly channelId: string;
  readonly workflowPath?: string;
  readonly repository?: string;
  readonly pollIntervalMs: number;
  readonly limit?: number;
  readonly executeHooks: boolean;
  readonly status: ExternalWorkBackgroundSchedulerStatus;
  readonly startedAt: string;
  readonly stoppedAt?: string;
  readonly lastPollAt?: string;
  readonly nextPollAt?: string;
  readonly lastReconcileAt?: string;
  readonly tickCount: number;
  readonly lastErrorCode?: string;
  readonly lastErrorMessage?: string;
  readonly lastPoll?: ExternalWorkPollResponse;
  readonly lastReconcile?: ExternalWorkReconcileResponse;
}

export interface ExternalWorkGitHubBackgroundStartRequest {
  readonly channelId: string;
  readonly workflowPath?: string;
  readonly limit?: number;
  readonly executeHooks?: boolean;
  readonly runImmediately?: boolean;
}

export interface ExternalWorkBackgroundListResponse {
  readonly cwd: string;
  readonly schedulers: readonly ExternalWorkBackgroundScheduler[];
}

export interface ExternalWorkBackgroundMutationResponse {
  readonly cwd: string;
  readonly scheduler: ExternalWorkBackgroundScheduler;
  readonly duplicate?: boolean;
  readonly startupReconcile?: ExternalWorkReconcileResponse;
}

export type ExternalWorkWorkflowStatusSourceKind = ExternalSourceKind | "unknown";

export type ExternalWorkSecretStatusKind =
  | "configured"
  | "missing"
  | "unavailable"
  | "invalid"
  | "not_required";

export type ExternalWorkStatusBackgroundStatus =
  | "not_configured"
  | "running"
  | "stopped"
  | "failed"
  | "unsupported";

export interface ExternalWorkStatusChannelSummary {
  readonly id: string;
  readonly name: string;
  readonly boundPath?: string;
}

export interface ExternalWorkStatusWorkflowSummary {
  readonly path: string;
  readonly exists: boolean;
  readonly valid: boolean;
  readonly error?: string;
  readonly sourceKind: ExternalWorkWorkflowStatusSourceKind;
  readonly repository?: string;
  readonly projectSlug?: string;
  readonly events: readonly string[];
  readonly secretRef?: string;
}

export interface ExternalWorkStatusSecretSummary {
  readonly ref?: string;
  readonly purpose?: "github_token" | "linear_token";
  readonly status: ExternalWorkSecretStatusKind;
  readonly message?: string;
}

export interface ExternalWorkStatusCounts {
  readonly externalWork: {
    readonly total: number;
    readonly ready: number;
    readonly blocked: number;
    readonly retryWait: number;
    readonly terminal: number;
  };
  readonly ciTriage: {
    readonly total: number;
    readonly triaged: number;
    readonly taskCreated: number;
    readonly runRequested: number;
    readonly blocked: number;
    readonly stale: number;
    readonly failed: number;
  };
  readonly actions: {
    readonly total: number;
    readonly waitingForApproval: number;
    readonly approved: number;
    readonly failed: number;
    readonly succeeded: number;
    readonly cancelled: number;
    readonly staleTarget: number;
  };
}

export interface ExternalWorkStatusBackgroundSummary {
  readonly supported: boolean;
  readonly running: boolean;
  readonly schedulerId?: string;
  readonly status: ExternalWorkStatusBackgroundStatus;
  readonly lastTickAt?: string;
  readonly nextPollAt?: string;
  readonly lastError?: string;
}

export interface ExternalWorkStatusLastErrors {
  readonly poll?: string;
  readonly reconcile?: string;
  readonly background?: string;
}

export interface ExternalWorkStatusResponse {
  readonly cwd: string;
  readonly channel: ExternalWorkStatusChannelSummary;
  readonly workflow: ExternalWorkStatusWorkflowSummary;
  readonly secret: ExternalWorkStatusSecretSummary;
  readonly records: ExternalWorkStatusCounts;
  readonly background: ExternalWorkStatusBackgroundSummary;
  readonly lastErrors: ExternalWorkStatusLastErrors;
}

export interface ExternalWorkSecretConfigureRequest {
  readonly channelId: string;
  readonly workflowPath?: string;
  readonly token: string;
  readonly secretRef?: string;
  readonly updateWorkflow?: boolean;
}

export interface ExternalWorkSecretDeleteRequest {
  readonly channelId: string;
  readonly workflowPath?: string;
  readonly secretRef?: string;
}

export interface ExternalWorkSecretMutationResponse {
  readonly cwd: string;
  readonly channelId: string;
  readonly sourceKind: ExternalSourceKind;
  readonly secretRef: string;
  readonly secret: ExternalWorkStatusSecretSummary;
  readonly workflow: ExternalWorkStatusWorkflowSummary;
  readonly workflowUpdated: boolean;
}

export interface ExternalWorkWorkflowConfigureRequest {
  readonly channelId: string;
  readonly workflowPath?: string;
  readonly sourceKind: ExternalSourceKind;
  readonly repository?: string;
  readonly projectSlug?: string;
}

export interface ExternalWorkWorkflowMutationResponse {
  readonly cwd: string;
  readonly channelId: string;
  readonly sourceKind: ExternalSourceKind;
  readonly workflow: ExternalWorkStatusWorkflowSummary;
  readonly workflowCreated: boolean;
  readonly workflowUpdated: boolean;
}

export interface ExternalWorkImportResponse {
  readonly externalWorkItem: ExternalWorkItem;
  readonly workflow: ChannelWorkflow;
  readonly workflowStep: ChannelWorkflowStep;
  readonly artifacts: readonly RunArtifact[];
  readonly duplicate: boolean;
}

export interface RunArtifactListResponse {
  readonly runId: string;
  readonly artifacts: readonly RunArtifact[];
}

export interface MediaJobArtifactListResponse {
  readonly mediaJobId: string;
  readonly artifacts: readonly RunArtifact[];
}

export interface RunArtifactResponse {
  readonly artifact: RunArtifact;
}

export type MediaJobStatus = "queued" | "running" | "waiting_for_approval" | "succeeded" | "failed" | "cancelled";

export type MediaOperation = "image_generate" | "image_edit" | "video_generate";

export interface MediaJob {
  readonly id: string;
  readonly workspaceId: string;
  readonly providerPresetId: string;
  readonly operation: MediaOperation;
  readonly prompt: string;
  readonly input: Record<string, unknown>;
  readonly artifactIds: readonly string[];
  readonly status: MediaJobStatus;
  readonly errorMessage?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MediaJobListResponse {
  readonly cwd: string;
  readonly mediaJobs: readonly MediaJob[];
}

export interface MediaJobMutationResponse {
  readonly mediaJob: MediaJob;
  readonly artifacts?: readonly RunArtifact[];
  readonly approval?: ApprovalRequest;
}

export interface CreateMediaJobRequest {
  readonly providerPresetId: string;
  readonly operation: MediaOperation;
  readonly prompt: string;
  readonly input?: Record<string, unknown>;
}

export type TaskStatus = "todo" | "claimed" | "running" | "blocked" | "review" | "done" | "failed" | "cancelled";

export type ChannelStatus = "active" | "paused" | "archived";

export type ChannelExecutionMode = "serial" | "parallel";

export type ChannelWriteLockScope = "channel" | "boundPath" | "workspace";

export interface ChannelRuntimePolicy {
  readonly maxConcurrentRuns: number;
  readonly executionMode: ChannelExecutionMode;
  readonly writeLockScope: ChannelWriteLockScope;
  readonly allowReadOnlyParallel: boolean;
  readonly queueOnConflict: boolean;
}

export interface Channel {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly status: ChannelStatus;
  readonly boundPath?: string;
  readonly defaultProviderPresetId?: string;
  readonly defaultTeammateId?: string;
  readonly allowedTools: readonly ToolName[];
  readonly runtimePolicy: ChannelRuntimePolicy;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ChannelListResponse {
  readonly cwd: string;
  readonly channels: readonly Channel[];
}

export interface ChannelMutationResponse {
  readonly channel: Channel;
}

export interface CreateChannelRequest {
  readonly name: string;
  readonly status: ChannelStatus;
  readonly boundPath?: string;
  readonly defaultProviderPresetId?: string;
  readonly defaultTeammateId?: string;
  readonly allowedTools: readonly ToolName[];
  readonly runtimePolicy: ChannelRuntimePolicy;
}

export interface UpdateChannelRequest {
  readonly name?: string;
  readonly status?: ChannelStatus;
  readonly boundPath?: string | null;
  readonly defaultProviderPresetId?: string | null;
  readonly defaultTeammateId?: string | null;
  readonly allowedTools?: readonly ToolName[];
  readonly runtimePolicy?: ChannelRuntimePolicy;
}

export interface Task {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly title: string;
  readonly prompt: string;
  readonly status: TaskStatus;
  readonly assigneeTeammateId?: string;
  readonly requestedSkillId?: string;
  readonly currentRunId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TaskListResponse {
  readonly cwd: string;
  readonly tasks: readonly Task[];
}

export interface TaskMutationResponse {
  readonly task: Task;
}

export interface CreateTaskRequest {
  readonly channelId: string;
  readonly title: string;
  readonly prompt: string;
  readonly assigneeTeammateId?: string;
  readonly requestedSkillId?: string;
}

export interface UpdateTaskRequest {
  readonly channelId?: string;
  readonly title?: string;
  readonly prompt?: string;
  readonly status?: TaskStatus;
  readonly assigneeTeammateId?: string | null;
  readonly requestedSkillId?: string | null;
}

export type MemoryScopeType = "workspace" | "channel" | "teammate" | "task" | "run";

export type MemorySourceType =
  | "manual"
  | "message"
  | "decision"
  | "doc"
  | "attachment"
  | "run-event"
  | "artifact"
  | "import";

export type MemoryReviewState = "candidate" | "active" | "disabled" | "archived" | "rejected";

export type MemorySensitivity = "normal" | "private" | "secret-adjacent";

export type MemoryReviewMode = "conservative" | "balanced" | "fast";

export type MemoryReviewOutcome = "auto-active" | "auto-candidate" | "manual-review" | "quarantine";

export type MemoryReviewConfidence = "low" | "medium" | "high";

export type MemoryCandidateSourceKind =
  | "manual_user"
  | "private_chat"
  | "channel_decision"
  | "task_run_summary"
  | "reflection_job"
  | "persona_source"
  | "import";

export type MemoryReviewAction = "approve" | "edit_and_approve" | "keep_candidate" | "reject" | "archive" | "quarantine";

export type MemoryConsolidationJobKind =
  | "private_chat_summary"
  | "channel_decision_summary"
  | "task_run_lesson"
  | "workspace_consolidation";

export type MemoryConsolidationJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface MemorySourceRef {
  readonly type: MemorySourceType;
  readonly id: string;
  readonly label?: string;
  readonly url?: string;
}

export interface MemoryReviewPolicy {
  readonly workspaceId: string;
  readonly mode: MemoryReviewMode;
  readonly autoActiveSameScope: boolean;
  readonly autoActiveUserExplicit: boolean;
  readonly requireManualForWorkspace: boolean;
  readonly requireManualForPersona: boolean;
  readonly requireManualForCrossScope: boolean;
  readonly quarantineSecretAdjacent: boolean;
  readonly updatedAt: string;
}

export interface MemoryReviewPolicyUpdateRequest {
  readonly mode?: MemoryReviewMode;
  readonly autoActiveSameScope?: boolean;
  readonly autoActiveUserExplicit?: boolean;
  readonly requireManualForWorkspace?: boolean;
  readonly requireManualForPersona?: boolean;
  readonly requireManualForCrossScope?: boolean;
  readonly quarantineSecretAdjacent?: boolean;
}

export interface MemoryObject {
  readonly id: string;
  readonly workspaceId: string;
  readonly scopeType: MemoryScopeType;
  readonly ownerId: string;
  readonly title: string;
  readonly body: string;
  readonly tags: readonly string[];
  readonly sourceRefs: readonly MemorySourceRef[];
  readonly reviewState: MemoryReviewState;
  readonly enabled: boolean;
  readonly sensitivity: MemorySensitivity;
  readonly retrievalProviderId?: string;
  readonly retrievalHandle?: string;
  readonly createdBy?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastUsedAt?: string;
}

export interface CreateMemoryObjectRequest {
  readonly scopeType: MemoryScopeType;
  readonly ownerId: string;
  readonly title: string;
  readonly body: string;
  readonly tags?: readonly string[];
  readonly sourceRefs?: readonly MemorySourceRef[];
  readonly reviewState?: MemoryReviewState;
  readonly enabled?: boolean;
  readonly sensitivity?: MemorySensitivity;
  readonly retrievalProviderId?: string;
  readonly retrievalHandle?: string;
  readonly createdBy?: string;
}

export interface UpdateMemoryObjectRequest {
  readonly scopeType?: MemoryScopeType;
  readonly ownerId?: string;
  readonly title?: string;
  readonly body?: string;
  readonly tags?: readonly string[];
  readonly sourceRefs?: readonly MemorySourceRef[];
  readonly reviewState?: MemoryReviewState;
  readonly enabled?: boolean;
  readonly sensitivity?: MemorySensitivity;
  readonly retrievalProviderId?: string | null;
  readonly retrievalHandle?: string | null;
  readonly createdBy?: string | null;
  readonly lastUsedAt?: string | null;
}

export interface MemoryReviewDecision {
  readonly id: string;
  readonly workspaceId: string;
  readonly memoryId: string;
  readonly outcome: MemoryReviewOutcome;
  readonly mode: MemoryReviewMode;
  readonly reasonCode: string;
  readonly reason: string;
  readonly confidence: MemoryReviewConfidence;
  readonly requiresManualReview: boolean;
  readonly quarantineReason?: string;
  readonly targetReviewState: MemoryReviewState;
  readonly targetSensitivity: MemorySensitivity;
  readonly sourceRefs: readonly MemorySourceRef[];
  readonly decidedBy: "policy" | "local-user" | "system";
  readonly createdAt: string;
}

export interface MemoryReviewActionRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly memoryId: string;
  readonly action: MemoryReviewAction;
  readonly previousReviewState: MemoryReviewState;
  readonly nextReviewState: MemoryReviewState;
  readonly sourceRefs: readonly MemorySourceRef[];
  readonly editedMemory?: UpdateMemoryObjectRequest;
  readonly reason?: string;
  readonly actor: "local-user" | "system";
  readonly createdAt: string;
}

export interface MemoryPromotionInboxItem {
  readonly memory: MemoryObject;
  readonly decision?: MemoryReviewDecision;
  readonly sourceSummary: string;
  readonly recommendedAction: MemoryReviewAction;
}

export interface ApplyMemoryReviewActionRequest {
  readonly action: MemoryReviewAction;
  readonly editedMemory?: UpdateMemoryObjectRequest;
  readonly reason?: string;
  readonly actor?: "local-user" | "system";
}

export interface MemoryConsolidationJob {
  readonly id: string;
  readonly workspaceId: string;
  readonly kind: MemoryConsolidationJobKind;
  readonly sourceRefs: readonly MemorySourceRef[];
  readonly status: MemoryConsolidationJobStatus;
  readonly createdCandidateIds: readonly string[];
  readonly errorMessage?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateMemoryConsolidationJobRequest {
  readonly kind: MemoryConsolidationJobKind;
  readonly sourceKind?: MemoryCandidateSourceKind;
  readonly sourceScopeType?: MemoryScopeType;
  readonly crossesScopeBoundary?: boolean;
  readonly userExplicitRemember?: boolean;
  readonly confidence?: MemoryReviewConfidence;
  readonly candidate: {
    readonly scopeType: MemoryScopeType;
    readonly ownerId: string;
    readonly title: string;
    readonly body: string;
    readonly tags?: readonly string[];
    readonly sourceRefs?: readonly MemorySourceRef[];
    readonly sensitivity?: MemorySensitivity;
    readonly createdBy?: string;
  };
}

export interface MemoryListResponse {
  readonly cwd: string;
  readonly memories: readonly MemoryObject[];
  readonly vectorRetrieval: {
    readonly status: "not_installed";
    readonly optional: true;
  };
}

export interface MemoryMutationResponse {
  readonly memory: MemoryObject;
}

export interface MemoryReviewPolicyResponse {
  readonly cwd: string;
  readonly policy: MemoryReviewPolicy;
}

export interface MemoryPromotionInboxResponse {
  readonly cwd: string;
  readonly items: readonly MemoryPromotionInboxItem[];
}

export interface MemoryReviewMutationResponse {
  readonly memory: MemoryObject;
  readonly action: MemoryReviewActionRecord;
}

export interface MemoryConsolidationJobListResponse {
  readonly cwd: string;
  readonly jobs: readonly MemoryConsolidationJob[];
}

export interface MemoryConsolidationJobMutationResponse {
  readonly cwd: string;
  readonly job: MemoryConsolidationJob;
  readonly candidates: readonly MemoryObject[];
  readonly decisions: readonly MemoryReviewDecision[];
}

export type MemoryRecallIntent = "private-chat" | "channel-reply" | "task-run" | "review" | "search";

export interface MemoryRecallRequest {
  readonly teammateId?: string;
  readonly channelId?: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly intent: MemoryRecallIntent;
  readonly query: string;
  readonly tags?: readonly string[];
  readonly maxResults?: number;
  readonly includePrivate?: boolean;
  readonly includeDisabled?: boolean;
  readonly includeSecretAdjacent?: boolean;
}

export interface RecalledMemory {
  readonly memory: MemoryObject;
  readonly score: number;
  readonly matchedTerms: readonly string[];
  readonly excerpt: string;
}

export interface MemoryRecallResponse {
  readonly cwd: string;
  readonly memories: readonly RecalledMemory[];
  readonly policyVersion: string;
}

export interface UsedMemoryEvent {
  readonly id: string;
  readonly workspaceId: string;
  readonly memoryIds: readonly string[];
  readonly intent: MemoryRecallIntent;
  readonly recallQuery: string;
  readonly teammateId?: string;
  readonly channelId?: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly responseId?: string;
  readonly policyVersion: string;
  readonly createdAt: string;
}

export interface UsedMemoryListResponse {
  readonly cwd: string;
  readonly events: readonly UsedMemoryEvent[];
}

export interface TeammatePersonaDraftRequest {
  readonly content: string;
  readonly sourcePath?: string;
}

export interface TeammatePersonaDraft {
  readonly teammateId: string;
  readonly sourceKind: "agents-md" | "persona-md" | "markdown";
  readonly sourcePath?: string;
  readonly displayName: string;
  readonly description: string;
  readonly systemPrompt: string;
  readonly appendSystemPrompt: readonly string[];
  readonly warnings: readonly string[];
}

export interface TeammatePersonaDraftResponse {
  readonly cwd: string;
  readonly teammateId: string;
  readonly draft: TeammatePersonaDraft;
}

export type ChannelMessageKind = "message" | "ai_reply" | "system" | "task_link";

export type ChannelMessageIntent = "discuss" | "task";

export type ChannelMessageAuthorType = "local-user" | "ai-teammate" | "system";

export interface ChannelMention {
  readonly id: string;
  readonly label: string;
  readonly kind: "ai-teammate" | "local-user" | "channel";
}

export interface ChannelMessage {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly threadId?: string;
  readonly kind: ChannelMessageKind;
  readonly intent: ChannelMessageIntent;
  readonly authorType: ChannelMessageAuthorType;
  readonly authorId?: string;
  readonly body: string;
  readonly mentions: readonly ChannelMention[];
  readonly attachmentIds: readonly string[];
  readonly linkPreviewIds: readonly string[];
  readonly linkedTaskId?: string;
  readonly linkedRunId?: string;
  readonly status: "pending" | "ready" | "blocked" | "failed";
  readonly errorMessage?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateChannelMessageRequest {
  readonly threadId?: string;
  readonly kind?: ChannelMessageKind;
  readonly intent?: ChannelMessageIntent;
  readonly authorType?: ChannelMessageAuthorType;
  readonly authorId?: string;
  readonly body: string;
  readonly mentions?: readonly ChannelMention[];
  readonly attachmentIds?: readonly string[];
  readonly linkPreviewIds?: readonly string[];
  readonly linkedTaskId?: string;
  readonly linkedRunId?: string;
  readonly requestAiReply?: boolean;
  readonly providerPresetId?: string;
  readonly teammateId?: string;
}

export interface ChannelMessageListResponse {
  readonly cwd: string;
  readonly channelId: string;
  readonly messages: readonly ChannelMessage[];
  readonly hasMore?: boolean;
  readonly nextBeforeMessageId?: string;
}

export interface ChannelMessageMutationResponse {
  readonly message: ChannelMessage;
  readonly aiReply?: ChannelMessage;
}

export type ChannelExecutionProposalStatus = "draft" | "accepted" | "cancelled" | "superseded" | "blocked" | "run_failed";

export type ChannelExecutionProposalStepAction = "coordinated" | "consulted" | "reviewed" | "flagged_risk";

export interface ChannelExecutionProposalStep {
  readonly teammateId: string;
  readonly action: ChannelExecutionProposalStepAction;
  readonly summary: string;
}

export interface ChannelExecutionProposal {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly sourceMessageId: string;
  readonly proposedByTeammateId: string;
  readonly title: string;
  readonly prompt: string;
  readonly assigneeTeammateId: string;
  readonly acceptanceCriteria: readonly string[];
  readonly collaborationSteps: readonly ChannelExecutionProposalStep[];
  readonly requiredTools: readonly RunTool[];
  readonly riskSummary?: string;
  readonly status: ChannelExecutionProposalStatus;
  readonly linkedTaskId?: string;
  readonly linkedRunId?: string;
  readonly errorMessage?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateChannelExecutionProposalRequest {
  readonly sourceMessageId: string;
  readonly proposedByTeammateId: string;
  readonly title: string;
  readonly prompt: string;
  readonly assigneeTeammateId: string;
  readonly acceptanceCriteria?: readonly string[];
  readonly collaborationSteps?: readonly ChannelExecutionProposalStep[];
  readonly requiredTools?: readonly RunTool[];
  readonly riskSummary?: string;
}

export interface UpdateChannelExecutionProposalRequest {
  readonly title?: string;
  readonly prompt?: string;
  readonly assigneeTeammateId?: string;
  readonly acceptanceCriteria?: readonly string[];
  readonly collaborationSteps?: readonly ChannelExecutionProposalStep[];
  readonly requiredTools?: readonly RunTool[];
  readonly riskSummary?: string | null;
  readonly status?: ChannelExecutionProposalStatus;
  readonly linkedTaskId?: string | null;
  readonly linkedRunId?: string | null;
  readonly errorMessage?: string | null;
}

export interface ChannelExecutionProposalListResponse {
  readonly cwd: string;
  readonly channelId: string;
  readonly proposals: readonly ChannelExecutionProposal[];
}

export interface ChannelExecutionProposalMutationResponse {
  readonly proposal: ChannelExecutionProposal;
}

export type ChannelAttachmentKind = "image" | "pdf" | "office" | "text";

export interface ChannelAttachment {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly messageId?: string;
  readonly kind: ChannelAttachmentKind;
  readonly fileName: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly path: string;
  readonly createdAt: string;
}

export interface CreateChannelAttachmentRequest {
  readonly fileName: string;
  readonly contentType?: string;
  readonly contentBase64: string;
  readonly messageId?: string;
}

export interface ChannelAttachmentListResponse {
  readonly cwd: string;
  readonly channelId: string;
  readonly attachments: readonly ChannelAttachment[];
}

export interface ChannelAttachmentMutationResponse {
  readonly attachment: ChannelAttachment;
}

export type ChannelLinkPreviewStatus = "ready" | "blocked" | "failed";

export interface ChannelLinkPreview {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly messageId?: string;
  readonly url: string;
  readonly normalizedUrl: string;
  readonly title?: string;
  readonly description?: string;
  readonly imageUrl?: string;
  readonly siteName?: string;
  readonly status: ChannelLinkPreviewStatus;
  readonly errorMessage?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateChannelLinkPreviewRequest {
  readonly url: string;
  readonly messageId?: string;
}

export interface ChannelLinkPreviewListResponse {
  readonly cwd: string;
  readonly channelId: string;
  readonly linkPreviews: readonly ChannelLinkPreview[];
}

export interface ChannelLinkPreviewMutationResponse {
  readonly linkPreview: ChannelLinkPreview;
}

export interface ChannelBrief {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly objective: string;
  readonly scope: string;
  readonly acceptanceCriteria: readonly string[];
  readonly openQuestions: readonly string[];
  readonly risks: readonly string[];
  readonly decisionIds: readonly string[];
  readonly attachmentIds: readonly string[];
  readonly linkPreviewIds: readonly string[];
  readonly updatedBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UpdateChannelBriefRequest {
  readonly objective: string;
  readonly scope: string;
  readonly acceptanceCriteria?: readonly string[];
  readonly openQuestions?: readonly string[];
  readonly risks?: readonly string[];
  readonly decisionIds?: readonly string[];
  readonly attachmentIds?: readonly string[];
  readonly linkPreviewIds?: readonly string[];
  readonly updatedBy: string;
}

export interface ChannelBriefResponse {
  readonly cwd: string;
  readonly channelId: string;
  readonly brief: ChannelBrief;
}

export interface ChannelBriefMutationResponse {
  readonly brief: ChannelBrief;
}

export type ChannelDecisionStatus = "active" | "superseded" | "rejected";

export interface ChannelDecision {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly sourceMessageId?: string;
  readonly sourceTaskId?: string;
  readonly sourceRunId?: string;
  readonly title: string;
  readonly decision: string;
  readonly rationale: string;
  readonly alternatives: readonly string[];
  readonly status: ChannelDecisionStatus;
  readonly supersedesDecisionId?: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateChannelDecisionRequest {
  readonly sourceMessageId?: string;
  readonly sourceTaskId?: string;
  readonly sourceRunId?: string;
  readonly title: string;
  readonly decision: string;
  readonly rationale?: string;
  readonly alternatives?: readonly string[];
  readonly status?: ChannelDecisionStatus;
  readonly supersedesDecisionId?: string;
  readonly createdBy: string;
}

export interface UpdateChannelDecisionRequest {
  readonly title?: string;
  readonly decision?: string;
  readonly rationale?: string;
  readonly alternatives?: readonly string[];
  readonly status?: ChannelDecisionStatus;
}

export interface ChannelDecisionListResponse {
  readonly cwd: string;
  readonly channelId: string;
  readonly decisions: readonly ChannelDecision[];
}

export interface ChannelDecisionMutationResponse {
  readonly decision: ChannelDecision;
}

export type ChannelHandoffStatus = "proposed" | "accepted" | "declined" | "completed" | "cancelled";

export interface ChannelHandoff {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly sourceMessageId?: string;
  readonly sourceTaskId?: string;
  readonly sourceRunId?: string;
  readonly fromParticipantId: string;
  readonly fromParticipantLabel: string;
  readonly toParticipantId: string;
  readonly toParticipantLabel: string;
  readonly reason: string;
  readonly requiredInput: string;
  readonly expectedOutput: string;
  readonly status: ChannelHandoffStatus;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateChannelHandoffRequest {
  readonly sourceMessageId?: string;
  readonly sourceTaskId?: string;
  readonly sourceRunId?: string;
  readonly fromParticipantId: string;
  readonly fromParticipantLabel: string;
  readonly toParticipantId: string;
  readonly toParticipantLabel: string;
  readonly reason: string;
  readonly requiredInput: string;
  readonly expectedOutput: string;
  readonly status?: ChannelHandoffStatus;
  readonly createdBy: string;
}

export interface UpdateChannelHandoffRequest {
  readonly fromParticipantId?: string;
  readonly fromParticipantLabel?: string;
  readonly toParticipantId?: string;
  readonly toParticipantLabel?: string;
  readonly reason?: string;
  readonly requiredInput?: string;
  readonly expectedOutput?: string;
  readonly status?: ChannelHandoffStatus;
}

export interface ChannelHandoffListResponse {
  readonly cwd: string;
  readonly channelId: string;
  readonly handoffs: readonly ChannelHandoff[];
}

export interface ChannelHandoffMutationResponse {
  readonly handoff: ChannelHandoff;
}

export type ChannelContextSummaryTargetType = "thread" | "task";
export type ChannelContextSummaryAuthorType = "local-user" | "ai-teammate" | "system";

export interface ChannelContextSummary {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly targetType: ChannelContextSummaryTargetType;
  readonly targetId: string;
  readonly sourceMessageIds: readonly string[];
  readonly decisionIds: readonly string[];
  readonly summary: string;
  readonly acceptanceCriteria: readonly string[];
  readonly openQuestions: readonly string[];
  readonly authorType: ChannelContextSummaryAuthorType;
  readonly authorId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateChannelContextSummaryRequest {
  readonly targetType: ChannelContextSummaryTargetType;
  readonly targetId: string;
  readonly sourceMessageIds?: readonly string[];
  readonly decisionIds?: readonly string[];
  readonly summary: string;
  readonly acceptanceCriteria?: readonly string[];
  readonly openQuestions?: readonly string[];
  readonly authorType: ChannelContextSummaryAuthorType;
  readonly authorId?: string;
}

export interface UpdateChannelContextSummaryRequest {
  readonly targetType?: ChannelContextSummaryTargetType;
  readonly targetId?: string;
  readonly sourceMessageIds?: readonly string[];
  readonly decisionIds?: readonly string[];
  readonly summary?: string;
  readonly acceptanceCriteria?: readonly string[];
  readonly openQuestions?: readonly string[];
  readonly authorType?: ChannelContextSummaryAuthorType;
  readonly authorId?: string | null;
}

export interface ChannelContextSummaryListResponse {
  readonly cwd: string;
  readonly channelId: string;
  readonly contextSummaries: readonly ChannelContextSummary[];
}

export interface ChannelContextSummaryMutationResponse {
  readonly contextSummary: ChannelContextSummary;
}

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

export type SecretRefKind = "env" | "keychain";
export type SecretStatusKind = SecretRefKind | "local";

export type SecretPurpose =
  | "provider_api_key"
  | "github_token"
  | "linear_token"
  | "webhook_secret"
  | "custom_header"
  | "automation_token";

export type SecretStatusErrorCode =
  | "secret_missing"
  | "secret_access_denied"
  | "secret_store_unavailable"
  | "invalid_secret_ref";

export interface SecretStatus {
  readonly ref: string;
  readonly kind: SecretStatusKind;
  readonly configured: boolean;
  readonly errorCode?: SecretStatusErrorCode;
  readonly message?: string;
}

export interface SecretStatusResponse {
  readonly status: SecretStatus;
}

export type ProviderKind =
  | "openai"
  | "anthropic"
  | "openai-compatible"
  | "doubao"
  | "deepseek"
  | "minimax"
  | "glm"
  | "jimeng"
  | "seedream"
  | "seedance";

export type ProviderCapability =
  | "chat"
  | "tool_call"
  | "reasoning"
  | "vision"
  | "embedding"
  | "image_generate"
  | "image_edit"
  | "video_generate"
  | "tts"
  | "asr";

export type ProviderApi =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai"
  | "mistral-conversations"
  | "media-job";

export interface ProviderPreset {
  readonly id: string;
  readonly kind: ProviderKind;
  readonly displayName: string;
  readonly providerId: string;
  readonly model: string;
  readonly api: ProviderApi;
  readonly baseUrl?: string;
  readonly apiKeyRef?: string;
  readonly apiKeyConfigured: boolean;
  readonly apiKeyStatus?: SecretStatus;
  readonly headers: Record<string, string>;
  readonly authHeader?: boolean;
  readonly reasoning?: boolean;
  readonly input: readonly ("text" | "image")[];
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly compat: Record<string, unknown>;
  readonly capabilities: readonly ProviderCapability[];
  readonly enabled: boolean;
  readonly lastCheck?: ProviderCheckResult;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProviderListResponse {
  readonly cwd: string;
  readonly providers: readonly ProviderPreset[];
}

export interface ProviderMutationResponse {
  readonly provider: ProviderPreset;
}

export interface ProviderSecretResponse {
  readonly providerId: string;
  readonly apiKey: string;
  readonly apiKeyRef?: string;
  readonly configured: boolean;
}

export interface ProviderTemplate {
  readonly templateId: string;
  readonly description: string;
  readonly kind: ProviderKind;
  readonly displayName: string;
  readonly providerId: string;
  readonly model: string;
  readonly api: ProviderApi;
  readonly baseUrl?: string;
  readonly apiKeyRef?: string;
  readonly headers?: Record<string, string>;
  readonly authHeader?: boolean;
  readonly reasoning?: boolean;
  readonly input?: readonly ("text" | "image")[];
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly compat?: Record<string, unknown>;
  readonly capabilities: readonly ProviderCapability[];
  readonly enabled?: boolean;
}

export interface ProviderTemplateListResponse {
  readonly templates: readonly ProviderTemplate[];
}

export interface ProviderModelOption {
  readonly id: string;
  readonly displayName?: string;
  readonly ownedBy?: string;
  readonly createdAt?: string;
}

export interface ProviderModelListRequest {
  readonly kind: ProviderKind;
  readonly providerId: string;
  readonly api: ProviderApi;
  readonly baseUrl?: string;
  readonly apiKeyRef?: string;
  readonly apiKey?: string;
  readonly headers?: Record<string, string>;
  readonly authHeader?: boolean;
}

export interface ProviderModelListResponse {
  readonly source: string;
  readonly models: readonly ProviderModelOption[];
}

export interface ProviderCheckResult {
  readonly ok: boolean;
  readonly code?: string;
  readonly message: string;
  readonly checkedAt: string;
}

export interface ProviderDraftCheckRequest extends ProviderMutationRequest {}

export interface ProviderMutationRequest {
  readonly kind: ProviderKind;
  readonly displayName: string;
  readonly providerId: string;
  readonly model: string;
  readonly api: ProviderApi;
  readonly baseUrl?: string;
  readonly apiKeyRef?: string;
  readonly apiKey?: string;
  readonly clearApiKey?: boolean;
  readonly headers?: Record<string, string>;
  readonly authHeader?: boolean;
  readonly reasoning?: boolean;
  readonly input?: readonly string[];
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly compat?: Record<string, unknown>;
  readonly capabilities?: readonly string[];
  readonly enabled?: boolean;
}

export type McpServerTransportType = "stdio" | "streamable-http";

export interface McpStdioTransport {
  readonly type: "stdio";
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Record<string, string>;
  readonly cwd?: string;
  readonly secretEnvRefs: Record<string, string>;
  readonly secretEnvNames?: readonly string[];
}

export interface McpStreamableHttpTransport {
  readonly type: "streamable-http";
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly secretHeaderRefs: Record<string, string>;
  readonly bearerTokenRef?: string;
  readonly bearerTokenEnvVar?: string;
  readonly envHeaders?: Record<string, string>;
  readonly secretHeaderNames?: readonly string[];
  readonly oauthClientId?: string;
  readonly oauthResource?: string;
}

export type McpServerTransport = McpStdioTransport | McpStreamableHttpTransport;
export type McpServerStatusKind = "unknown" | "checking" | "ready" | "failed" | "disabled";

export interface McpServerStatus {
  readonly kind: McpServerStatusKind;
  readonly message?: string;
  readonly checkedAt?: string;
}

export type McpRuntimeStatusKind = "unknown" | "ready" | "failed" | "disabled" | "expired" | "migration_required";
export type McpAuthStatusKind =
  | "not_required"
  | "configured"
  | "missing"
  | "access_denied"
  | "store_unavailable"
  | "invalid_ref"
  | "migration_required";

export interface McpAuthStatus {
  readonly kind: McpAuthStatusKind;
  readonly refs: readonly string[];
  readonly missingRefs: readonly string[];
  readonly message?: string;
}

export interface McpRuntimeStatusSnapshot {
  readonly serverId: string;
  readonly checkedAt: string;
  readonly expiresAt: string;
  readonly status: McpRuntimeStatusKind;
  readonly serverInfo?: {
    readonly name?: string;
    readonly version?: string;
  };
  readonly protocolVersion?: string;
  readonly toolCount?: number;
  readonly missingSecretRefs: readonly string[];
  readonly authStatus: McpAuthStatus;
  readonly latencyMs?: number;
  readonly errorCode?: string;
  readonly message?: string;
}

export interface McpServer {
  readonly id: string;
  readonly workspaceId: string;
  readonly displayName: string;
  readonly transport: McpServerTransport;
  readonly enabled: boolean;
  readonly required: boolean;
  readonly status: McpServerStatus;
  readonly startupTimeoutSec?: number;
  readonly toolTimeoutSec?: number;
  readonly enabledTools?: readonly string[];
  readonly disabledTools: readonly string[];
  readonly secretConfigured: Readonly<Record<string, boolean>>;
  readonly secretStatuses: readonly SecretStatus[];
  readonly statusSnapshot?: McpRuntimeStatusSnapshot;
  readonly legacySecretMigrationRequired: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type McpToolSideEffectLevel = "none" | "read" | "write" | "write-network" | "external" | "credential" | "deploy";
export type McpToolDefaultApproval = "allow" | "ask" | "deny";

export interface McpTool {
  readonly serverId: string;
  readonly rawName: string;
  readonly displayName: string;
  readonly description?: string;
  readonly inputSchema: unknown;
  readonly callableNamespace: string;
  readonly callableName: string;
  readonly sideEffectLevel: McpToolSideEffectLevel;
  readonly defaultApproval: McpToolDefaultApproval;
  readonly enabled: boolean;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly updatedAt: string;
}

export interface McpServerListResponse {
  readonly cwd: string;
  readonly servers: readonly McpServer[];
}

export interface McpServerMutationRequest {
  readonly id?: string;
  readonly displayName?: string;
  readonly transport?: McpServerTransport;
  readonly enabled?: boolean;
  readonly required?: boolean;
  readonly startupTimeoutSec?: number | null;
  readonly toolTimeoutSec?: number | null;
  readonly enabledTools?: readonly string[] | null;
  readonly disabledTools?: readonly string[];
}

export interface McpServerMutationResponse {
  readonly server: McpServer;
}

export interface McpServerCheckResponse {
  readonly server: McpServer;
  readonly statusSnapshot: McpRuntimeStatusSnapshot;
}

export interface McpServerStatusResponse {
  readonly server: McpServer;
  readonly statusSnapshot: McpRuntimeStatusSnapshot | null;
}

export interface McpToolListResponse {
  readonly cwd: string;
  readonly tools: readonly McpTool[];
}

export interface McpServerToolSyncResponse {
  readonly server: McpServer;
  readonly statusSnapshot: McpRuntimeStatusSnapshot;
  readonly tools: readonly McpTool[];
}

export type ManagedPluginSourceKind = "built-in" | "bundled" | "trusted-local-preset";
export type ManagedPluginStatus = "available" | "enabled" | "disabled" | "blocked";
export type ManagedPluginHealthStatus = "unknown" | "ready" | "failed" | "disabled" | "expired";
export type ManagedPluginContributionKind =
  | "mcp-server"
  | "tool"
  | "skill-pack"
  | "runner"
  | "provider"
  | "channel-source"
  | "memory"
  | "automation"
  | "ui-feature";
export type ManagedPluginSideEffectLevel = "none" | "read" | "write" | "write-network" | "external" | "credential" | "deploy";
export type ManagedPluginDefaultApproval = "allow" | "ask" | "deny";

export interface ManagedPluginSecretRequirement {
  readonly ref: string;
  readonly label: string;
  readonly purpose?: string;
  readonly required?: boolean;
}

export interface ManagedPluginApprovalDefault {
  readonly contributionId: string;
  readonly decision: ManagedPluginDefaultApproval;
  readonly reason?: string;
}

export interface ManagedPluginContributionView {
  readonly kind: ManagedPluginContributionKind;
  readonly id: string;
  readonly label: string;
  readonly capabilities: readonly string[];
  readonly sideEffectLevel?: ManagedPluginSideEffectLevel;
  readonly defaultApproval?: ManagedPluginDefaultApproval;
  readonly linkedResourceId?: string;
  readonly linkedResourcePresent?: boolean;
  readonly enabled: boolean;
}

export interface ManagedPluginHealthSnapshot {
  readonly pluginId: string;
  readonly checkedAt: string;
  readonly expiresAt: string;
  readonly status: ManagedPluginHealthStatus;
  readonly message?: string;
  readonly details?: unknown;
}

export interface ManagedPluginEvent {
  readonly id: string;
  readonly pluginId: string;
  readonly type:
    | "enabled"
    | "disabled"
    | "preset_applied"
    | "checked"
    | "contribution_linked"
    | "contribution_disabled";
  readonly actor: "local-user" | "system";
  readonly message?: string;
  readonly data?: unknown;
  readonly createdAt: string;
}

export interface ManagedPluginLinkedResource {
  readonly kind: ManagedPluginContributionKind;
  readonly id: string;
  readonly present: boolean;
  readonly enabled?: boolean;
  readonly displayName?: string;
}

export interface ManagedPluginView {
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
  readonly sourceKind: ManagedPluginSourceKind;
  readonly status: ManagedPluginStatus;
  readonly description?: string;
  readonly homepageUrl?: string;
  readonly trustSummary: string;
  readonly contributions: readonly ManagedPluginContributionView[];
  readonly requiredSecrets?: readonly ManagedPluginSecretRequirement[];
  readonly defaultApprovals?: readonly ManagedPluginApprovalDefault[];
  readonly health?: ManagedPluginHealthSnapshot;
  readonly linkedResources: readonly ManagedPluginLinkedResource[];
  readonly events?: readonly ManagedPluginEvent[];
  readonly disabledReason?: string;
  readonly actions: {
    readonly canEnable: boolean;
    readonly canDisable: boolean;
    readonly canCheck: boolean;
    readonly canApplyPreset: boolean;
  };
}

export interface ManagedPluginListResponse {
  readonly cwd: string;
  readonly plugins: readonly ManagedPluginView[];
}

export interface ManagedPluginDetailResponse {
  readonly plugin: ManagedPluginView;
}

export interface ManagedPluginMutationResponse {
  readonly plugin: ManagedPluginView;
}

export interface ManagedPluginCheckResponse {
  readonly plugin: ManagedPluginView;
  readonly health: ManagedPluginHealthSnapshot;
}

export interface ManagedPluginApplyPresetRequest {
  readonly options?: Record<string, unknown>;
}

export interface ManagedPluginDisableRequest {
  readonly reason?: string;
}

export interface ManagedPluginApplyPresetResponse {
  readonly plugin: ManagedPluginView;
  readonly linkedMcpServer?: McpServer;
  readonly statusSnapshot?: McpRuntimeStatusSnapshot;
  readonly tools: readonly McpTool[];
}

export type ApprovalActionType =
  | "read"
  | "grep"
  | "find"
  | "ls"
  | "write"
  | "edit"
  | "bash"
  | "git_commit"
  | "git_push"
  | "external_send"
  | "deploy"
  | "media_cost"
  | "credential_change"
  | "provider_change"
  | "workflow_step"
  | "mcp_tool_call";

export type ApprovalRisk = "low" | "medium" | "high" | "critical";

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "cancelled";

export interface ApprovalRequest {
  readonly id: string;
  readonly runId?: string;
  readonly taskId?: string;
  readonly mediaJobId?: string;
  readonly externalWorkActionId?: string;
  readonly workflowStepId?: string;
  readonly channelId?: string;
  readonly toolCallId?: string;
  readonly actionType: ApprovalActionType;
  readonly risk: ApprovalRisk;
  readonly title: string;
  readonly description: string;
  readonly payload: unknown;
  readonly status: ApprovalStatus;
  readonly createdAt: string;
  readonly expiresAt?: string;
  readonly resolvedAt?: string;
  readonly resolvedBy?: "local-user";
  readonly decisionReason?: string;
}

export interface ApprovalListResponse {
  readonly cwd: string;
  readonly approvals: readonly ApprovalRequest[];
}

export interface ApprovalMutationResponse {
  readonly approval: ApprovalRequest;
  readonly mediaJob?: MediaJob;
}

export interface ResolveApprovalRequest {
  readonly reason?: string;
}

export type ApprovalToolDecision = "allow" | "ask" | "deny";

export interface ApprovalPolicy {
  readonly workspaceId: string;
  readonly toolDecisions: Record<ToolName, ApprovalToolDecision>;
  readonly allowedWritePaths: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ApprovalPolicyResponse {
  readonly cwd: string;
  readonly policy: ApprovalPolicy;
}

export interface UpdateApprovalPolicyRequest {
  readonly toolDecisions: Record<ToolName, ApprovalToolDecision>;
  readonly allowedWritePaths: readonly string[];
}

export type ToolName = "read" | "grep" | "find" | "ls" | "bash" | "edit" | "write";

export interface ListTasksRequest {
  readonly channelId?: string;
  readonly assigneeTeammateId?: string;
  readonly status?: TaskStatus;
  readonly limit?: number;
}

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

export type SkillApprovalMode = "none" | "standard" | "strict";

export interface SkillApprovalProfile {
  readonly mode: SkillApprovalMode;
  readonly risk?: ApprovalRisk;
  readonly requiredForTools?: readonly ToolName[];
  readonly requiredForActions?: readonly ApprovalActionType[];
}

export type AiTeammateStatus = "active" | "paused" | "disabled";

export interface AiTeammate {
  readonly id: string;
  readonly workspaceId: string;
  readonly templateId?: string;
  readonly roleKey: AiTeammateRoleKey;
  readonly displayName: string;
  readonly description: string;
  readonly avatarTone?: string;
  readonly avatarImageAttachmentId?: string;
  readonly providerPresetId?: string;
  readonly systemPrompt?: string;
  readonly appendSystemPrompt: readonly string[];
  readonly allowedTools: readonly ToolName[];
  readonly approvalProfile: SkillApprovalProfile;
  readonly status: AiTeammateStatus;
  readonly pinned: boolean;
  readonly hidden: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateAiTeammateRequest {
  readonly templateId?: string;
  readonly roleKey: AiTeammateRoleKey;
  readonly displayName: string;
  readonly description: string;
  readonly avatarTone?: string;
  readonly avatarImageAttachmentId?: string;
  readonly providerPresetId?: string;
  readonly systemPrompt?: string;
  readonly appendSystemPrompt?: readonly string[];
  readonly allowedTools?: readonly ToolName[];
  readonly approvalProfile: SkillApprovalProfile;
  readonly status?: AiTeammateStatus;
  readonly pinned?: boolean;
  readonly hidden?: boolean;
}

export interface UpdateAiTeammateRequest {
  readonly templateId?: string | null;
  readonly roleKey?: AiTeammateRoleKey;
  readonly displayName?: string;
  readonly description?: string;
  readonly avatarTone?: string | null;
  readonly avatarImageAttachmentId?: string | null;
  readonly providerPresetId?: string | null;
  readonly systemPrompt?: string | null;
  readonly appendSystemPrompt?: readonly string[];
  readonly allowedTools?: readonly ToolName[];
  readonly approvalProfile?: SkillApprovalProfile;
  readonly status?: AiTeammateStatus;
  readonly pinned?: boolean;
  readonly hidden?: boolean;
}

export interface AiTeammateListResponse {
  readonly cwd: string;
  readonly teammates: readonly AiTeammate[];
}

export interface AiTeammateMutationResponse {
  readonly teammate: AiTeammate;
}

export interface RetentionTombstone {
  readonly id: string;
  readonly workspaceId: string;
  readonly entityType: "ai-teammate";
  readonly entityId: string;
  readonly reason?: string;
  readonly deletedCounts: Readonly<Record<string, number>>;
  readonly createdAt: string;
}

export interface HardDeleteAiTeammateRequest {
  readonly reason?: string;
}

export interface HardDeleteAiTeammateResponse {
  readonly tombstone: RetentionTombstone;
}

export interface TeammateChannelMembership {
  readonly teammateId: string;
  readonly channelId: string;
  readonly isDefault: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ReplaceTeammateChannelMembershipRequest {
  readonly memberships: readonly {
    readonly channelId: string;
    readonly isDefault?: boolean;
  }[];
}

export interface TeammateChannelMembershipListResponse {
  readonly cwd: string;
  readonly teammateId: string;
  readonly memberships: readonly TeammateChannelMembership[];
}

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

export type TeammateMcpBindingMode = "selected" | "all_current_tools";

export interface TeammateMcpBinding {
  readonly teammateId: string;
  readonly serverId: string;
  readonly mode: TeammateMcpBindingMode;
  readonly selectedToolNames: readonly string[];
  readonly approvalOverrides: Readonly<Record<string, McpToolDefaultApproval>>;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ReplaceTeammateMcpBindingsRequest {
  readonly bindings: readonly {
    readonly serverId: string;
    readonly mode: TeammateMcpBindingMode;
    readonly selectedToolNames?: readonly string[];
    readonly approvalOverrides?: Readonly<Record<string, McpToolDefaultApproval>>;
    readonly enabled?: boolean;
  }[];
}

export interface TeammateMcpBindingListResponse {
  readonly cwd: string;
  readonly teammateId: string;
  readonly bindings: readonly TeammateMcpBinding[];
}

export type TeammateMemoryScopeKind = "channel-brief" | "channel-decisions" | "private-chat-summary" | "private-notes";

export interface TeammateMemoryScope {
  readonly id: string;
  readonly teammateId: string;
  readonly kind: TeammateMemoryScopeKind;
  readonly channelId?: string;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ReplaceTeammateMemoryScopesRequest {
  readonly scopes: readonly {
    readonly id?: string;
    readonly kind: TeammateMemoryScopeKind;
    readonly channelId?: string;
    readonly enabled?: boolean;
  }[];
}

export interface TeammateMemoryScopeListResponse {
  readonly cwd: string;
  readonly teammateId: string;
  readonly scopes: readonly TeammateMemoryScope[];
}

export interface TeammateDirectThread {
  readonly id: string;
  readonly workspaceId: string;
  readonly teammateId: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type TeammateDirectMessageAuthorType = "local-user" | "ai-teammate" | "system";

export type TeammateDirectMessageStatus = "pending" | "ready" | "blocked" | "failed";

export interface TeammateDirectMessage {
  readonly id: string;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly teammateId: string;
  readonly authorType: TeammateDirectMessageAuthorType;
  readonly authorId?: string;
  readonly body: string;
  readonly attachmentIds: readonly string[];
  readonly status: TeammateDirectMessageStatus;
  readonly errorMessage?: string;
  readonly linkedTaskId?: string;
  readonly linkedRunId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateTeammateDirectMessageRequest {
  readonly body: string;
  readonly attachmentIds?: readonly string[];
  readonly requestAiReply?: boolean;
  readonly providerPresetId?: string;
}

export type TeammatePrivateAttachmentScope = "teammate_direct_thread" | "teammate_profile_avatar";

export interface TeammatePrivateAttachment {
  readonly id: string;
  readonly workspaceId: string;
  readonly teammateId: string;
  readonly threadId?: string;
  readonly messageId?: string;
  readonly scope: TeammatePrivateAttachmentScope;
  readonly kind: ChannelAttachmentKind;
  readonly fileName: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly path: string;
  readonly createdAt: string;
}

export interface CreateTeammatePrivateAttachmentRequest {
  readonly fileName: string;
  readonly contentType?: string;
  readonly contentBase64: string;
  readonly scope?: TeammatePrivateAttachmentScope;
  readonly messageId?: string;
}

export interface TeammatePrivateAttachmentListResponse {
  readonly cwd: string;
  readonly teammateId: string;
  readonly thread: TeammateDirectThread;
  readonly attachments: readonly TeammatePrivateAttachment[];
}

export interface TeammatePrivateAttachmentMutationResponse {
  readonly attachment: TeammatePrivateAttachment;
}

export interface TeammateDirectMessageStreamReadyEvent {
  readonly message: TeammateDirectMessage;
  readonly aiReply: TeammateDirectMessage;
}

export interface TeammateDirectMessageStreamDeltaEvent {
  readonly messageId: string;
  readonly delta: string;
  readonly body: string;
}

export interface TeammateDirectMessageStreamDoneEvent {
  readonly message: TeammateDirectMessage;
  readonly aiReply: TeammateDirectMessage;
}

export interface TeammateDirectMessageStreamBlockedEvent {
  readonly message: TeammateDirectMessage;
  readonly aiReply: TeammateDirectMessage;
}

export interface TeammateDirectMessageStreamErrorEvent {
  readonly message?: TeammateDirectMessage;
  readonly aiReply?: TeammateDirectMessage;
  readonly error: string;
}

export interface TeammateDirectThreadResponse {
  readonly cwd: string;
  readonly teammateId: string;
  readonly thread: TeammateDirectThread;
}

export interface TeammateDirectMessageListResponse {
  readonly cwd: string;
  readonly teammateId: string;
  readonly thread: TeammateDirectThread;
  readonly messages: readonly TeammateDirectMessage[];
}

export interface TeammateDirectMessageMutationResponse {
  readonly message: TeammateDirectMessage;
  readonly aiReply?: TeammateDirectMessage;
}

export interface TeammateActivityItem {
  readonly id: string;
  readonly kind: "direct-message" | "task" | "run" | "approval" | "channel-message";
  readonly title: string;
  readonly subtitle?: string;
  readonly status?: string;
  readonly createdAt: string;
  readonly sourceId: string;
}

export interface TeammateActivityListResponse {
  readonly cwd: string;
  readonly teammateId: string;
  readonly items: readonly TeammateActivityItem[];
}

export interface ListApprovalsRequest {
  readonly status?: ApprovalStatus | string;
  readonly runId?: string;
  readonly mediaJobId?: string;
  readonly externalWorkActionId?: string;
  readonly limit?: number;
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
