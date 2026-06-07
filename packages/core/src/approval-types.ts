import { randomUUID } from "node:crypto";
import type { ApplyPatchFormat, PatchPlan, PatchSummary } from "./patch/index.js";
import type { RunTool } from "./approval-policy.js";
import type { UnifiedExecEnvironmentSummary } from "./exec/unified-exec-types.js";

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

export type RuntimePermissionRequestKind =
  | "core_tool"
  | "write_scope"
  | "mcp_tool"
  | "runner_capability";

export type RuntimePermissionScope =
  | {
      readonly kind: "core_tool";
      readonly tools: readonly RunTool[];
    }
  | {
      readonly kind: "write_scope";
      readonly paths: readonly string[];
      readonly operation: "read_write" | "create" | "update" | "delete";
    }
  | {
      readonly kind: "mcp_tool";
      readonly serverId: string;
      readonly toolName: string;
      readonly sideEffectLevel: string;
      readonly defaultApproval: string;
    }
  | {
      readonly kind: "runner_capability";
      readonly runnerId: string;
      readonly capability: string;
    };

export interface RuntimePermissionScopeSnapshot {
  readonly tools: readonly RunTool[];
  readonly allowedWritePaths: readonly string[];
  readonly mcpToolRefs: readonly string[];
  readonly runnerId: string;
  readonly runnerCapabilities?: readonly string[];
}

export interface RuntimePermissionContinuationPlan {
  readonly mode: "same_run_if_supported" | "queue_followup" | "interrupt_redirect";
  readonly toolDelta?: readonly RunTool[];
  readonly writePathDelta?: readonly string[];
  readonly mcpToolDelta?: readonly string[];
  readonly runnerCapabilityDelta?: readonly string[];
  readonly reason: string;
}

export interface RuntimePermissionRequestPayload {
  readonly type: "runtime_permission_request";
  readonly requestKind: RuntimePermissionRequestKind;
  readonly requestedByRunId: string;
  readonly requestedByToolCallId?: string;
  readonly reason: string;
  readonly requestedScope: RuntimePermissionScope;
  readonly currentScope: RuntimePermissionScopeSnapshot;
  readonly proposedContinuation: RuntimePermissionContinuationPlan;
}

export interface RuntimePermissionGrant {
  readonly id: string;
  readonly approvalId: string;
  readonly runId: string;
  readonly scope: RuntimePermissionScope;
  readonly mode: "same_run" | "continuation";
  readonly createdAt: string;
  readonly expiresAt?: string;
}

export type ApprovalPayload =
  | {
      readonly type: "file_write";
      readonly path: string;
      readonly bytes: number;
      readonly preview?: string;
      readonly patchFormat?: ApplyPatchFormat;
      readonly touchedPaths?: readonly string[];
      readonly summary?: PatchSummary;
      readonly rawPatchSha256?: string;
      readonly patchPlan?: PatchPlan;
    }
  | {
      readonly type: "file_edit";
      readonly path: string;
      readonly diffPreview: string;
      readonly patchFormat?: ApplyPatchFormat;
      readonly touchedPaths?: readonly string[];
      readonly summary?: PatchSummary;
      readonly rawPatchSha256?: string;
      readonly patchPlan?: PatchPlan;
    }
  | {
      readonly type: "bash";
      readonly cwd: string;
      readonly command: string;
      readonly riskFlags: readonly string[];
      readonly exec?: {
        readonly commandKind: "shell" | "argv";
        readonly timeoutMs?: number;
        readonly idleTimeoutMs?: number;
        readonly pty?: boolean;
        readonly environmentSummary?: UnifiedExecEnvironmentSummary;
      };
    }
  | {
      readonly type: "tool_call";
      readonly toolName: "read" | "grep" | "find" | "ls";
      readonly cwd: string;
      readonly input: unknown;
    }
  | {
      readonly type: "mcp_tool_call";
      readonly toolName: string;
      readonly cwd: string;
      readonly input: unknown;
    }
  | {
      readonly type: "external_send";
      readonly destination: string;
      readonly subject?: string;
      readonly preview: string;
    }
  | {
      readonly type: "deploy";
      readonly target: string;
      readonly command?: string;
      readonly environment?: string;
    }
  | {
      readonly type: "media_cost";
      readonly providerPresetId: string;
      readonly model: string;
      readonly operation: "image_generate" | "image_edit" | "video_generate";
      readonly estimatedCost?: number;
      readonly promptPreview: string;
    }
  | {
      readonly type: "provider_change";
      readonly providerPresetId: string;
      readonly changedFields: readonly string[];
    }
  | {
      readonly type: "workflow_step";
      readonly gateStage?: "pre" | "post";
      readonly workflowId: string;
      readonly workflowStepId: string;
      readonly templateStepId?: string;
      readonly contextArtifactId?: string;
      readonly outputArtifactId?: string;
      readonly runId?: string;
      readonly title: string;
      readonly approvalMode: string;
      readonly requiredForTools: readonly string[];
      readonly requiredForActions: readonly string[];
    }
  | {
      readonly type: "external_action";
      readonly sourceKind: "github" | "linear";
      readonly actionKind: string;
      readonly target: unknown;
      readonly preview: string;
    }
  | RuntimePermissionRequestPayload;

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
  readonly payload: ApprovalPayload;
  readonly status: ApprovalStatus;
  readonly createdAt: string;
  readonly expiresAt?: string;
  readonly resolvedAt?: string;
  readonly resolvedBy?: "local-user";
  readonly decisionReason?: string;
}

export interface CreateApprovalRequestInput {
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
  readonly payload: ApprovalPayload;
  readonly expiresAt?: string;
  readonly extraSecrets?: readonly (string | undefined)[];
}

export interface ResolveApprovalRequestInput {
  readonly reason?: string;
  readonly resolvedBy?: "local-user";
}

export interface ListApprovalRequestsOptions {
  readonly status?: ApprovalStatus;
  readonly runId?: string;
  readonly mediaJobId?: string;
  readonly externalWorkActionId?: string;
  readonly workflowStepId?: string;
  readonly limit?: number;
}

export const approvalStatuses: readonly ApprovalStatus[] = ["pending", "approved", "denied", "expired", "cancelled"];

export const approvalActionTypes: readonly ApprovalActionType[] = [
  "read",
  "grep",
  "find",
  "ls",
  "write",
  "edit",
  "bash",
  "git_commit",
  "git_push",
  "external_send",
  "deploy",
  "media_cost",
  "credential_change",
  "provider_change",
  "workflow_step",
  "mcp_tool_call",
  "runtime_permission_request",
];

export function createApprovalRequestId(): string {
  return `approval_${randomUUID()}`;
}
