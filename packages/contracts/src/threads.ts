import type { ApprovalRequest } from "./approvals.js";
import type { RunArtifact } from "./artifacts.js";
import type { RunEventEnvelope, RunSession, RuntimeEvent } from "./runtime.js";
import type { ExecutionAction } from "./execution-actions.js";
import type { StateTransitionEvent } from "./workflows.js";

export type LingThreadKind = "task" | "channel_discussion" | "teammate_direct" | "workflow_step" | "external_work" | "automation";

export type LingThreadStatus = "open" | "running" | "waiting_for_approval" | "blocked" | "succeeded" | "failed" | "cancelled" | "archived";

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
  readonly metadata?: LingThreadMetadata;
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
