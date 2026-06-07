import type { ToolName } from "./shared.js";
import type { MediaJob } from "./media.js";

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
  | "mcp_tool_call"
  | "runtime_permission_request";

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

export type SkillApprovalMode = "none" | "standard" | "strict";

export interface SkillApprovalProfile {
  readonly mode: SkillApprovalMode;
  readonly risk?: ApprovalRisk;
  readonly requiredForTools?: readonly ToolName[];
  readonly requiredForActions?: readonly ApprovalActionType[];
}

export interface ListApprovalsRequest {
  readonly status?: ApprovalStatus | string;
  readonly runId?: string;
  readonly mediaJobId?: string;
  readonly externalWorkActionId?: string;
  readonly limit?: number;
}
