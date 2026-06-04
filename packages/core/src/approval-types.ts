import { randomUUID } from "node:crypto";

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
  | "mcp_tool_call";

export type ApprovalRisk = "low" | "medium" | "high" | "critical";

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "cancelled";

export type ApprovalPayload =
  | {
      readonly type: "file_write";
      readonly path: string;
      readonly bytes: number;
      readonly preview?: string;
    }
  | {
      readonly type: "file_edit";
      readonly path: string;
      readonly diffPreview: string;
    }
  | {
      readonly type: "bash";
      readonly cwd: string;
      readonly command: string;
      readonly riskFlags: readonly string[];
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
      readonly type: "external_action";
      readonly sourceKind: "github" | "linear";
      readonly actionKind: string;
      readonly target: unknown;
      readonly preview: string;
    };

export interface ApprovalRequest {
  readonly id: string;
  readonly runId?: string;
  readonly taskId?: string;
  readonly mediaJobId?: string;
  readonly externalWorkActionId?: string;
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
  readonly channelId?: string;
  readonly toolCallId?: string;
  readonly actionType: ApprovalActionType;
  readonly risk: ApprovalRisk;
  readonly title: string;
  readonly description: string;
  readonly payload: ApprovalPayload;
  readonly expiresAt?: string;
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
  "mcp_tool_call",
];

export function createApprovalRequestId(): string {
  return `approval_${randomUUID()}`;
}
