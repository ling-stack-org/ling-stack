import type { ApprovalRequest } from "./approvals.js";
import type { RunArtifact } from "./artifacts.js";
import type { RunEventEnvelope, RunSession, RuntimeEvent } from "./runtime.js";
import type { ExecutionAction } from "./execution-actions.js";
import type { StateTransitionEvent } from "./workflows.js";
import type { LingTurn } from "./turns.js";

export type LingThreadKind = "task" | "channel_discussion" | "teammate_direct" | "workflow_step" | "external_work" | "automation";

export type LingThreadStatus = "open" | "running" | "waiting_for_approval" | "blocked" | "succeeded" | "failed" | "cancelled" | "archived";
export type LingThreadArchivedFilter = "exclude" | "include" | "only";
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

export interface LingThreadPinRequest {
  readonly idempotencyKey?: string;
}

export interface LingThreadMutationResponse {
  readonly cwd: string;
  readonly thread: LingThread;
}
