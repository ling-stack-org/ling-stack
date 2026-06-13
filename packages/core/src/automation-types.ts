import { randomUUID } from "node:crypto";
import type { RunTool } from "./approval-policy.js";
import type { SessionPermissionMode } from "./session-permissions.js";
import type { SkillApprovalProfile } from "./skill-types.js";

export type AutomationStatus = "enabled" | "disabled" | "paused" | "archived" | "error";
export type AutomationKind = "daily_brief" | "weekly_review" | "project_monitor" | "custom_prompt";
export type AutomationMode = "cron" | "heartbeat";
export type AutomationExecutionEnvironment = "local" | "worktree";
export type AutomationReasoningEffort = "low" | "medium" | "high" | "xhigh";
export type P0CreateAutomationKind = Exclude<AutomationKind, "project_monitor">;
export type AutomationRunStatus =
  | "queued"
  | "skipped"
  | "running"
  | "waiting_for_approval"
  | "succeeded"
  | "failed"
  | "cancelled";

export type AutomationTrigger =
  | ManualAutomationTrigger
  | ScheduledAutomationTrigger
  | MonitorAutomationTrigger;

export interface ManualAutomationTrigger {
  readonly type: "manual";
}

export interface ScheduledAutomationTrigger {
  readonly type: "schedule";
  readonly timezone: string;
  readonly schedule: AutomationSchedule;
  readonly missedRunPolicy: "skip" | "run_one";
}

export interface MonitorAutomationTrigger {
  readonly type: "monitor";
  readonly pollIntervalMs: number;
  readonly source: AutomationMonitorSource;
  readonly condition: AutomationMonitorCondition;
  readonly unchangedPolicy: "skip" | "record_noop";
}

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

export type AutomationDraftSource = "template" | "manual" | "chat";
export type AutomationDraftStatus = "draft" | "needs_user_input" | "ready_for_confirmation" | "confirmed" | "discarded";
export type AutomationDraftField =
  | "title"
  | "kind"
  | "trigger"
  | "target"
  | "promptTemplate"
  | "outputPolicy";

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

export interface CreateAutomationDraftInput {
  readonly id?: string;
  readonly source: AutomationDraftSource;
  readonly status?: AutomationDraftStatus;
  readonly workspaceId?: string;
  readonly channelId?: string;
  readonly title?: string;
  readonly description?: string;
  readonly kind?: AutomationKind;
  readonly trigger?: AutomationTrigger;
  readonly target?: AutomationTarget;
  readonly promptTemplate?: AutomationPromptTemplate;
  readonly executionPolicy?: AutomationExecutionPolicy;
  readonly outputPolicy?: AutomationOutputPolicy;
  readonly proposedByRunId?: string;
  readonly proposedByThreadId?: string;
}

export interface UpdateAutomationDraftInput {
  readonly channelId?: string | null;
  readonly title?: string | null;
  readonly description?: string | null;
  readonly kind?: AutomationKind | null;
  readonly trigger?: AutomationTrigger | null;
  readonly target?: AutomationTarget | null;
  readonly promptTemplate?: AutomationPromptTemplate | null;
  readonly executionPolicy?: AutomationExecutionPolicy | null;
  readonly outputPolicy?: AutomationOutputPolicy | null;
  readonly proposedByRunId?: string | null;
  readonly proposedByThreadId?: string | null;
}

export interface ListAutomationDraftsOptions {
  readonly status?: AutomationDraftStatus;
  readonly source?: AutomationDraftSource;
  readonly channelId?: string;
  readonly includeTerminal?: boolean;
  readonly limit?: number;
}

export type AutomationDraftConfirmInput = Omit<CreateAutomationDefinitionInput, "threadId">;

export interface CreateAutomationDefinitionInput {
  readonly id?: string;
  readonly workspaceId?: string;
  readonly channelId?: string;
  readonly threadId: string;
  readonly automationMode?: AutomationMode;
  readonly title: string;
  readonly description?: string;
  readonly kind: AutomationKind;
  readonly status?: AutomationStatus;
  readonly trigger: AutomationTrigger;
  readonly rrule?: string;
  readonly cwds?: readonly string[];
  readonly targetThreadId?: string;
  readonly executionEnvironment?: AutomationExecutionEnvironment;
  readonly reasoningEffort?: AutomationReasoningEffort;
  readonly model?: string;
  readonly target: AutomationTarget;
  readonly promptTemplate: AutomationPromptTemplate;
  readonly executionPolicy: AutomationExecutionPolicy;
  readonly outputPolicy: AutomationOutputPolicy;
  readonly nextRunAt?: string;
}

export interface UpdateAutomationDefinitionInput {
  readonly channelId?: string | null;
  readonly threadId?: string;
  readonly automationMode?: AutomationMode;
  readonly title?: string;
  readonly description?: string | null;
  readonly kind?: AutomationKind;
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
  readonly lastRunId?: string | null;
  readonly nextRunAt?: string | null;
  readonly lastErrorMessage?: string | null;
}

export interface ListAutomationDefinitionsOptions {
  readonly status?: AutomationStatus;
  readonly kind?: AutomationKind;
  readonly channelId?: string;
  readonly includeArchived?: boolean;
  readonly scheduledOnly?: boolean;
  readonly limit?: number;
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

export interface CreateAutomationRunInput {
  readonly id?: string;
  readonly automationId: string;
  readonly workspaceId?: string;
  readonly channelId?: string;
  readonly threadId: string;
  readonly runId?: string;
  readonly triggerType: AutomationTrigger["type"];
  readonly scheduledFor?: string;
  readonly firedAt?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly status?: AutomationRunStatus;
  readonly idempotencyKey: string;
  readonly contextPreviewArtifactId?: string;
  readonly outputArtifactIds?: readonly string[];
  readonly skipReason?: string;
  readonly errorMessage?: string;
}

export interface UpdateAutomationRunInput {
  readonly runId?: string | null;
  readonly startedAt?: string | null;
  readonly completedAt?: string | null;
  readonly status?: AutomationRunStatus;
  readonly contextPreviewArtifactId?: string | null;
  readonly outputArtifactIds?: readonly string[];
  readonly skipReason?: string | null;
  readonly errorMessage?: string | null;
}

export interface ListAutomationRunsOptions {
  readonly automationId?: string;
  readonly runId?: string;
  readonly status?: AutomationRunStatus;
  readonly limit?: number;
}

export function createAutomationId(): string {
  return `automation_${randomUUID()}`;
}

export function createAutomationRunId(): string {
  return `automation_run_${randomUUID()}`;
}

export function createAutomationDraftId(): string {
  return `automation_draft_${randomUUID()}`;
}
