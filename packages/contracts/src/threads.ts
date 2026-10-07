import type { ApprovalRequest, LingApprovalCheckpoint } from "./approvals.js";
import type { RunArtifact } from "./artifacts.js";
import type { RunEventEnvelope, RunSession, RuntimeEvent } from "./runtime.js";
import type { ExecutionAction } from "./execution-actions.js";
import type { RetentionTombstone } from "./retention.js";
import type { StateTransitionEvent } from "./workflows.js";
import type { LingTurn } from "./turns.js";

export const lingThreadKinds = [
  "task",
  "channel_discussion",
  "teammate_direct",
  "workflow_step",
  "external_work",
  "automation",
  "conversation",
] as const;
export type LingThreadKind = (typeof lingThreadKinds)[number];

export type LingThreadStatus = "open" | "running" | "waiting_for_approval" | "waiting_for_input" | "blocked" | "succeeded" | "failed" | "cancelled" | "archived";
export type LingThreadArchivedFilter = "exclude" | "include" | "only";
export const conversationModeKinds = ["default", "plan"] as const;
export type ConversationModeKind = (typeof conversationModeKinds)[number];
export type LingThreadGoalStatus = "active" | "paused" | "blocked" | "usage_limited" | "budget_limited" | "complete" | "cleared" | "replaced";
export type LingThreadGoalCompletionActor = "local-user" | "ling-agent";
export type GoalUsageSource = "provider" | "estimated" | "mixed";
export type GoalContinuationStopReason =
  | "max_depth"
  | "no_evidence_threshold"
  | "same_blocker_threshold"
  | "plan_mode_active"
  | "pending_approval"
  | "active_run_exists"
  | "latest_run_not_terminal"
  | "goal_not_active"
  | "budget_limited"
  | "usage_limited"
  | "manual_stop"
  | "unknown";
export type GoalContinuationDecision = "started" | "stopped";
export type ProposedPlanArtifactStatus = "draft" | "accepted" | "superseded" | "archived";
export type ProposedPlanSourceMessageState = "available" | "deleted" | "unknown";
export type LingThreadSearchField =
  | "thread_title"
  | "thread_objective"
  | "turn_title"
  | "turn_instruction"
  | "task_id"
  | "task_title"
  | "task_prompt"
  | "metadata_summary";

export interface LingThreadMetadata {
  readonly schemaVersion: 1;
  readonly summary?: string;
  readonly pinnedAt?: string;
  readonly lastTurnId?: string;
  readonly lastActivityAt?: string;
  readonly pendingApprovalCount: number;
  readonly blockedCount: number;
  readonly failedAttemptCount: number;
  readonly artifactCount: number;
  readonly latestFailureRunId?: string;
  readonly latestEvidenceArtifactId?: string;
  readonly rebuiltAt: string;
}

export interface ConversationModeState {
  readonly mode: ConversationModeKind;
  readonly updatedAt?: string;
}

export type GoalEvidenceRef =
  | { readonly kind: "run"; readonly id: string }
  | { readonly kind: "turn"; readonly id: string }
  | { readonly kind: "artifact"; readonly id: string }
  | { readonly kind: "approval"; readonly id: string }
  | { readonly kind: "workflow"; readonly id: string };

export interface GoalContinuationEvidenceDelta {
  readonly newEvidenceRefs: number;
  readonly changedFiles: number;
  readonly acceptedPlans: number;
  readonly artifacts: number;
  readonly statusChanged: boolean;
}

export interface GoalContinuationEvent {
  readonly id: string;
  readonly goalId: string;
  readonly chainId: string;
  readonly sourceRunId: string;
  readonly continuationRunId?: string;
  readonly decision: GoalContinuationDecision;
  readonly stopReason?: GoalContinuationStopReason;
  readonly continuationDepth: number;
  readonly noEvidenceContinuationCount: number;
  readonly sameBlockerCount: number;
  readonly blockerFingerprint?: string;
  readonly evidenceDelta: GoalContinuationEvidenceDelta;
  readonly createdAt: string;
}

export interface LingThreadGoal {
  readonly id: string;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly objective: string;
  readonly status: LingThreadGoalStatus;
  readonly tokenBudget?: number;
  readonly tokensUsed: number;
  readonly timeUsedSeconds: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
  readonly clearedAt?: string;
  readonly replacedByGoalId?: string;
  readonly lastRunId?: string;
  readonly blockedReason?: string;
  readonly completionEvidenceRefs: readonly GoalEvidenceRef[];
  readonly completedBy?: LingThreadGoalCompletionActor;
  readonly completedReason?: string;
  readonly completionVerificationSummary?: string;
  readonly usageSource?: GoalUsageSource;
  readonly continuationChainId?: string;
  readonly continuationDepth: number;
  readonly noEvidenceContinuationCount: number;
  readonly lastBlockerFingerprint?: string;
  readonly sameBlockerCount: number;
  readonly lastContinuationStopReason?: GoalContinuationStopReason;
  readonly lastContinuationStoppedAt?: string;
  readonly lastContinuationEvidenceDelta?: GoalContinuationEvidenceDelta;
}

export interface LingThreadGoalPutRequest {
  readonly objective: string;
  readonly tokenBudget?: number | null;
  readonly replaceExisting?: boolean;
}

export interface LingThreadGoalPatchRequest {
  readonly objective?: string;
  readonly status?: LingThreadGoalStatus;
  readonly tokenBudget?: number | null;
  readonly tokensUsed?: number;
  readonly timeUsedSeconds?: number;
  readonly lastRunId?: string | null;
  readonly blockedReason?: string | null;
  readonly completionEvidenceRefs?: readonly GoalEvidenceRef[];
}

export interface LingThreadGoalCompleteRequest {
  readonly actor?: LingThreadGoalCompletionActor;
  readonly reason?: string;
  readonly evidenceRefs?: readonly GoalEvidenceRef[];
  readonly completionVerificationSummary?: string;
}

export interface ProposedPlanArtifact {
  readonly id: string;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly channelId?: string;
  readonly goalId?: string;
  readonly sourceAgentId?: string;
  readonly ownerAgentId?: string;
  readonly sourceTurnId?: string;
  readonly sourceMessageId?: string;
  readonly sourceMessageState?: ProposedPlanSourceMessageState;
  readonly sourceRunId?: string;
  readonly parentPlanId?: string;
  readonly supersededByPlanId?: string;
  readonly planGroupId?: string;
  readonly version?: number;
  readonly title: string;
  readonly bodyMarkdown: string;
  readonly status: ProposedPlanArtifactStatus;
  readonly savedAt?: string;
  readonly acceptedAt?: string;
  readonly convertedAt?: string;
  readonly archivedAt?: string;
  readonly archivedReason?: string;
  readonly acceptedTaskId?: string;
  readonly acceptedWorkflowId?: string;
  readonly acceptedWorkflowStepId?: string;
  readonly acceptedRunId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProposedPlanArtifactPutRequest {
  readonly id?: string;
  readonly channelId?: string | null;
  readonly goalId?: string | null;
  readonly sourceAgentId?: string | null;
  readonly ownerAgentId?: string | null;
  readonly sourceTurnId?: string | null;
  readonly sourceMessageId?: string | null;
  readonly sourceRunId?: string | null;
  readonly parentPlanId?: string | null;
  readonly supersededByPlanId?: string | null;
  readonly planGroupId?: string | null;
  readonly version?: number | null;
  readonly title: string;
  readonly bodyMarkdown: string;
  readonly status?: ProposedPlanArtifactStatus;
}

export interface ProposedPlanArtifactPatchRequest {
  readonly channelId?: string | null;
  readonly goalId?: string | null;
  readonly sourceAgentId?: string | null;
  readonly ownerAgentId?: string | null;
  readonly sourceTurnId?: string | null;
  readonly sourceMessageId?: string | null;
  readonly sourceRunId?: string | null;
  readonly parentPlanId?: string | null;
  readonly supersededByPlanId?: string | null;
  readonly planGroupId?: string | null;
  readonly version?: number | null;
  readonly title?: string;
  readonly bodyMarkdown?: string;
  readonly status?: ProposedPlanArtifactStatus;
  readonly savedAt?: string | null;
  readonly acceptedAt?: string | null;
  readonly convertedAt?: string | null;
  readonly archivedAt?: string | null;
  readonly archivedReason?: string | null;
  readonly acceptedTaskId?: string | null;
  readonly acceptedWorkflowId?: string | null;
  readonly acceptedWorkflowStepId?: string | null;
  readonly acceptedRunId?: string | null;
}

export interface ProposedPlanActionRequest {
  readonly plan?: ProposedPlanArtifactPutRequest;
  readonly createdBy?: string;
  readonly toParticipantId?: string;
  readonly toParticipantLabel?: string;
  readonly workflowTitle?: string;
  readonly workflowSteps?: readonly string[];
  readonly workflowStepPreviews?: readonly ProposedPlanWorkflowStepPreview[];
}

export interface ProposedPlanWorkflowStepPreview {
  readonly title: string;
  readonly ownerId?: string;
  readonly ownerLabel?: string;
  readonly ownerConfidence?: "high" | "medium" | "low" | "none";
  readonly ownerReason?: string;
  readonly sourceSignals?: readonly string[];
}

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
  readonly parentThreadId?: string;
  readonly parentTurnId?: string;
  readonly forkedFromRunId?: string;
  readonly metadata?: LingThreadMetadata;
  readonly conversationMode: ConversationModeState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly pinnedAt?: string;
  readonly archivedAt?: string;
  readonly archivedReason?: string;
}

export interface LingThreadListResponse {
  readonly cwd: string;
  readonly threads: readonly LingThread[];
  readonly matches?: readonly LingThreadSearchMatch[];
}

export interface LingThreadListRequest {
  readonly q?: string;
  readonly kind?: LingThreadKind;
  readonly channelId?: string;
  readonly taskId?: string;
  readonly teammateId?: string;
  readonly workflowStepId?: string;
  readonly externalWorkId?: string;
  readonly status?: LingThreadStatus;
  readonly includeArchived?: boolean;
  readonly archived?: LingThreadArchivedFilter;
  readonly limit?: number;
}

export interface CreateLingThreadRequest {
  readonly kind?: "channel_discussion";
  readonly channelId: string;
  readonly title?: string;
  readonly objective?: string;
  readonly idempotencyKey?: string;
}

export interface LingThreadSearchMatch {
  readonly threadId: string;
  readonly turnId?: string;
  readonly runId?: string;
  readonly field: LingThreadSearchField;
  readonly snippet: string;
}

export interface LingThreadDetailResponse {
  readonly cwd: string;
  readonly thread: LingThread;
}

export interface LingThreadModeUpdateRequest {
  readonly mode: ConversationModeKind;
}

export interface LingThreadModeResponse {
  readonly cwd: string;
  readonly threadId: string;
  readonly mode: ConversationModeState;
}

export interface LingThreadGoalResponse {
  readonly cwd: string;
  readonly threadId: string;
  readonly goal: LingThreadGoal | null;
}

export interface ProposedPlanArtifactListResponse {
  readonly cwd: string;
  readonly threadId?: string;
  readonly channelId?: string;
  readonly plans: readonly ProposedPlanArtifact[];
}

export interface ProposedPlanArtifactResponse {
  readonly cwd: string;
  readonly threadId: string;
  readonly plan: ProposedPlanArtifact;
}

export interface ProposedPlanActionResponse {
  readonly cwd: string;
  readonly threadId: string;
  readonly plan: ProposedPlanArtifact;
  readonly taskId?: string;
  readonly workflowId?: string;
  readonly workflowStepId?: string;
  readonly runId?: string;
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
  readonly approvalCheckpoints: readonly LingApprovalCheckpoint[];
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
  readonly turnId?: string;
  readonly includeArtifacts?: boolean;
}

export interface ResumeContextPreview {
  readonly title: string;
  readonly instruction: string;
  readonly sourceRunId: string;
  readonly sourceTurnId?: string;
  readonly priorRunIds: readonly string[];
  readonly priorTurnIds?: readonly string[];
  readonly includedTurnCount?: number;
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

export interface LingThreadForkRequest {
  readonly turnId?: string;
  readonly sourceRunId?: string;
  readonly title?: string;
  readonly objective?: string;
  readonly idempotencyKey?: string;
}

export interface LingThreadForkResponse {
  readonly cwd: string;
  readonly sourceThread: LingThread;
  readonly sourceTurn?: LingTurn;
  readonly sourceRun?: RunSession;
  readonly childThread: LingThread;
  readonly lineage: {
    readonly parentThreadId: string;
    readonly parentTurnId?: string;
    readonly forkedFromRunId?: string;
  };
}

export interface LingThreadForkRunRequest {
  readonly turnId?: string;
  readonly sourceRunId?: string;
  readonly title?: string;
  readonly objective?: string;
  readonly instruction: string;
  readonly providerPresetId?: string;
  readonly runnerId?: string;
  readonly idempotencyKey: string;
}

export type LingThreadForkRunStatus = "fork_created" | "fork_reused" | "run_started" | "run_failed";

export interface LingThreadForkRunResponse {
  readonly cwd: string;
  readonly sourceThread: LingThread;
  readonly sourceTurn?: LingTurn;
  readonly sourceRun?: RunSession;
  readonly childThread: LingThread;
  readonly childTurn?: LingTurn;
  readonly childRun?: RunSession;
  readonly runId?: string;
  readonly status: LingThreadForkRunStatus;
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}

export interface LingThreadArchiveRequest {
  readonly reason?: string;
  readonly idempotencyKey?: string;
}

export interface HardDeleteLingThreadRequest {
  readonly reason?: string;
}

export interface HardDeleteLingThreadResponse {
  readonly tombstone: RetentionTombstone;
}

export interface LingThreadPinRequest {
  readonly idempotencyKey?: string;
}

export interface LingThreadMutationResponse {
  readonly cwd: string;
  readonly thread: LingThread;
}
