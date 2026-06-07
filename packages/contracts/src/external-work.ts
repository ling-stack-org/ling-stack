import type { RunThinkingLevel, RunTool } from "./shared.js";
import type { ApprovalRequest } from "./approvals.js";
import type { RunArtifact } from "./artifacts.js";
import type { RunSession } from "./runtime.js";
import type { Task } from "./tasks.js";
import type { ChannelWorkflow, ChannelWorkflowStep } from "./workflows.js";

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
