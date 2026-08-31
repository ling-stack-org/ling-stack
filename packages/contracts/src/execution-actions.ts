import type { ApprovalActionType, ApprovalRisk } from "./approvals.js";

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

/**
 * Stable, redacted references used by projections and UI inspectors.
 * This is deliberately separate from targetRefs: targetRefs describe what an
 * action touched, while sourceRefs describe where the fact came from.
 */
export interface ExecutionActionSourceRef {
  readonly kind: string;
  readonly id: string;
  readonly label?: string;
  readonly path?: string;
}

export type ExecutionActionDiagnosticCode =
  | "late_event"
  | "stale_event"
  | "source_conflict";

/** Non-authoritative evidence rejected from the visible action state. */
export interface ExecutionActionDiagnostic {
  readonly code: ExecutionActionDiagnosticCode;
  readonly message: string;
  readonly sourceRefs: readonly ExecutionActionSourceRef[];
}

export interface ExecutionActionCommandOutputChunk {
  readonly eventSeq: number;
  readonly stream: "stdout" | "stderr";
  readonly text: string;
  readonly byteCount: number;
  readonly redacted: boolean;
  readonly ts: string;
}

export interface ExecutionActionCommandEvidence {
  readonly command: string;
  readonly outcome?: "succeeded" | "failed" | "timed_out" | "cancelled" | "unknown";
  readonly cwd?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly durationMs?: number;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly timedOut?: boolean;
  readonly cancelled?: boolean;
  readonly latestEventSeq: number;
  readonly outputTail: readonly ExecutionActionCommandOutputChunk[];
  readonly outputByteCount: number;
  readonly outputLineCount?: number;
  readonly outputTruncated: boolean;
  readonly stdoutArtifactId?: string;
  readonly stderrArtifactId?: string;
  readonly resultArtifactId?: string;
}

export interface ExecutionAction {
  readonly id: string;
  /** Monotonic event/approval revision for in-place transcript replacement. */
  readonly revision: number;
  readonly workspaceId: string;
  readonly threadId?: string;
  readonly runId?: string;
  readonly attemptId?: string;
  readonly workUnitId?: string;
  readonly participantId?: string;
  readonly workflowStepId?: string;
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
  readonly sourceRefs: readonly ExecutionActionSourceRef[];
  readonly diagnostics?: readonly ExecutionActionDiagnostic[];
  readonly scopes?: readonly ExecutionScope[];
  readonly scopeSummary?: string;
  readonly policySnapshot?: unknown;
  readonly commandEvidence?: ExecutionActionCommandEvidence;
  readonly createdAt: string;
  readonly updatedAt?: string;
  readonly resolvedAt?: string;
  readonly executedAt?: string;
  readonly completedAt?: string;
}

export interface ExecutionActionListResponse {
  readonly cwd: string;
  readonly actions: readonly ExecutionAction[];
  readonly revision?: string;
}
