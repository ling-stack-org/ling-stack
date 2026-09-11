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
  | "host_capability"
  | "runtime_permission_request";

export type ApprovalRisk = "low" | "medium" | "high" | "critical";

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "cancelled";
export type LingApprovalCheckpointStatus = ApprovalStatus | "resume_pending" | "resumed" | "resume_failed";
export type ApprovalDecisionKind = "approve_once" | "approve_command_rule" | "deny";

export interface ApprovalCommandRuleProposal {
  readonly prefix: readonly string[];
  readonly display: string;
  readonly fingerprint: string;
  readonly version: 1;
}

export interface ApprovalCommandRule extends ApprovalCommandRuleProposal {
  readonly id: string;
  readonly workspaceId: string;
  readonly toolName: "bash";
  readonly sourceApprovalId?: string;
  readonly createdBy: "local-user";
  readonly createdAt: string;
  readonly revokedAt?: string;
}

export interface RunnerResumeHandle {
  readonly kind: "ling_continuation" | "runner_native";
  readonly runnerId?: string;
  readonly runId?: string;
  readonly attemptId?: string;
  readonly handleRef?: string;
  readonly payload?: Record<string, unknown>;
  readonly verified?: boolean;
}

export interface ApprovalResumeBasisV1 {
  readonly schemaVersion: 1;
  readonly approvalId: string;
  readonly runId: string;
  readonly workUnitId: string;
  readonly priorAttemptId: string;
  readonly workflowStepId?: string;
  readonly toolCallId: string;
  readonly actionType: ApprovalActionType;
  readonly sideEffectFingerprint: string;
  readonly delegatedRequirementFingerprint?: string;
  readonly fingerprint: string;
}

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
  readonly resolvedBy?: "local-user" | "system-reviewer";
  readonly decisionReason?: string;
  readonly availableDecisions?: readonly ApprovalDecisionKind[];
  readonly proposedCommandRule?: ApprovalCommandRuleProposal;
  readonly decisionKind?: ApprovalDecisionKind;
  readonly decisionRuleId?: string;
}

export interface LingApprovalCheckpoint {
  readonly id: string;
  readonly approvalId: string;
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
  readonly status: LingApprovalCheckpointStatus;
  readonly sideEffect: unknown;
  readonly previewArtifactIds: readonly string[];
  readonly resultArtifactIds: readonly string[];
  readonly revision: number;
  readonly resumeBasis?: ApprovalResumeBasisV1;
  readonly runnerResumeHandle?: RunnerResumeHandle;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly resolvedAt?: string;
  readonly resumedAt?: string;
  readonly resumeFailureReason?: string;
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
  readonly decisionKind?: "approve_once" | "approve_command_rule";
  readonly proposedRuleFingerprint?: string;
}

export interface ApprovalCommandRuleListResponse {
  readonly cwd: string;
  readonly rules: readonly ApprovalCommandRule[];
}

export interface ApprovalCommandRuleMutationResponse {
  readonly rule: ApprovalCommandRule;
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
