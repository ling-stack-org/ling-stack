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
