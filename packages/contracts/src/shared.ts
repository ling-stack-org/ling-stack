import type { ApprovalToolDecision } from "./approvals.js";
import type { ConversationModeKind } from "./threads.js";

export type RunStatus = "queued" | "running" | "waiting_for_approval" | "succeeded" | "failed" | "cancelled";

export type RunTool = "read" | "grep" | "find" | "ls" | "bash" | "edit" | "write";

export type RunThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type SessionPermissionMode = "ask_everything" | "balanced" | "workspace_write" | "full_access" | "custom";

export type PermissionPreset = "read_only" | "workspace_collaboration" | "full_access" | "custom";

export type AuthorizationMode = "ask" | "smart" | "always";

export type WorkspaceAccessMode = "read_only" | "workspace_write" | "full_access";

export interface ConversationPendingReplacement {
  readonly supersessionId: string;
  readonly idempotencyKey: string;
  readonly failureReason?: string;
}

export type WorkMode = "coding" | "daily";

export interface PermissionPresetDefinition {
  readonly preset: PermissionPreset;
  readonly permissionMode: SessionPermissionMode;
  readonly requiresConfirmation: boolean;
}

export interface PermissionConfirmation {
  readonly mode: "full_access";
  readonly confirmed: true;
  readonly confirmedAt: string;
  readonly reason: string;
}

export interface EffectiveRunPolicyRiskNote {
  readonly code: string;
  readonly message: string;
  readonly tool?: RunTool;
}

export interface EffectiveRunPolicySnapshot {
  readonly mode: SessionPermissionMode;
  readonly authorizationMode?: AuthorizationMode;
  readonly workspaceAccessMode?: WorkspaceAccessMode;
  readonly conversationMode?: ConversationModeKind;
  readonly planModeMutationPolicy?: "deny_repo_tracked_mutation";
  readonly toolDecisions: Record<RunTool, ApprovalToolDecision>;
  readonly allowedWritePaths: readonly string[];
  readonly workspacePolicyUpdatedAt?: string;
  readonly riskNotes: readonly EffectiveRunPolicyRiskNote[];
}

export type SecretRefKind = "env" | "keychain";

export type SecretStatusKind = SecretRefKind | "local";

export type SecretPurpose =
  | "provider_api_key"
  | "github_token"
  | "linear_token"
  | "webhook_secret"
  | "custom_header"
  | "automation_token";

export type SecretStatusErrorCode =
  | "secret_missing"
  | "secret_access_denied"
  | "secret_store_unavailable"
  | "invalid_secret_ref";

export interface SecretStatus {
  readonly ref: string;
  readonly kind: SecretStatusKind;
  readonly configured: boolean;
  readonly errorCode?: SecretStatusErrorCode;
  readonly message?: string;
}

export interface SecretStatusResponse {
  readonly status: SecretStatus;
}

export type ToolName = "read" | "grep" | "find" | "ls" | "bash" | "edit" | "write";
