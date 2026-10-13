import type { RunTool, SessionPermissionMode } from "./shared.js";
import type { SkillApprovalProfile } from "./approvals.js";
import type { RunSession } from "./runtime.js";
import type { LingThread } from "./threads.js";

export type AutomationStatus = "enabled" | "disabled" | "paused" | "archived" | "error";

export type AutomationKind = "daily_brief" | "weekly_review" | "project_monitor" | "custom_prompt";

export type AutomationMode = "cron" | "heartbeat";

export type AutomationExecutionEnvironment = "local" | "worktree";

export type AutomationReasoningEffort = "low" | "medium" | "high" | "xhigh";

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
  readonly automationMode: AutomationMode;
  readonly title: string;
  readonly description?: string;
  readonly kind: AutomationKind;
  readonly status: AutomationStatus;
  readonly trigger: AutomationTrigger;
  readonly rrule?: string;
  readonly cwds: readonly string[];
  readonly targetThreadId?: string;
  readonly executionEnvironment?: AutomationExecutionEnvironment;
  readonly reasoningEffort?: AutomationReasoningEffort;
  readonly model?: string;
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
  readonly automationMode?: AutomationMode;
  readonly channelId?: string;
  readonly description?: string;
  readonly target?: AutomationTarget;
  readonly trigger?: AutomationTrigger;
  readonly rrule?: string;
  readonly cwds?: readonly string[];
  readonly targetThreadId?: string;
  readonly executionEnvironment?: AutomationExecutionEnvironment;
  readonly reasoningEffort?: AutomationReasoningEffort;
  readonly model?: string;
  readonly promptTemplate?: AutomationPromptTemplate;
  readonly executionPolicy?: AutomationExecutionPolicy;
  readonly outputPolicy?: AutomationOutputPolicy;
  readonly status?: AutomationStatus;
}

export interface UpdateAutomationRequest {
  readonly title?: string;
  readonly description?: string | null;
  readonly automationMode?: AutomationMode;
  readonly status?: AutomationStatus;
  readonly trigger?: AutomationTrigger;
  readonly rrule?: string | null;
  readonly cwds?: readonly string[];
  readonly targetThreadId?: string | null;
  readonly executionEnvironment?: AutomationExecutionEnvironment | null;
  readonly reasoningEffort?: AutomationReasoningEffort | null;
  readonly model?: string | null;
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
  /** Confirmation is committed; scheduler registration must be retried separately. */
  readonly schedulerRefreshPending?: boolean;
  readonly schedulerMessage?: string;
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
