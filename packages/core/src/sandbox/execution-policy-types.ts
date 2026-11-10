import type { RuntimeAttemptFenceV1 } from "@ling-stack/contracts";
import type { ApprovalStatus } from "../approval-types.js";
import type { RunTool } from "../approval-policy.js";
import type { AuthorizationMode, EffectiveRunPolicySnapshot, PermissionConfirmation, WorkspaceAccessMode } from "../session-permissions.js";

/** Host-captured identity. operationHash must cover the exact tool payload and cwd. */
export interface ExecutionSandboxBinding extends RuntimeAttemptFenceV1 {
  readonly workspaceId: string;
  readonly runId: string;
  readonly toolCallId: string;
  readonly operationHash: string;
}

export interface ExecutionSandboxBackendIdentity {
  readonly kind: "macos_seatbelt" | "windows_restricted";
  readonly helperVersion: string;
  readonly protocolVersion: 1;
  readonly executableSha256: string;
}

export type ExecutionSandboxGrantScope =
  | { readonly kind: "read_roots" | "write_roots"; readonly roots: readonly string[] }
  | { readonly kind: "command_network" };

/** Projection of existing approval records, NOT another grant store or a public request. */
export interface ExecutionSandboxGrantFact {
  readonly id: string;
  readonly approvalId: string;
  readonly binding: ExecutionSandboxBinding;
  readonly cwd: string;
  readonly scope: ExecutionSandboxGrantScope;
  readonly status: ApprovalStatus | "revoked";
  readonly createdAt: string;
  readonly expiresAt: string;
}

/** Trusted Host inputs. Host must resolve real paths and recheck authority before execution. */
export interface CompileExecutionSandboxPolicyInput {
  readonly now: string;
  readonly platform: "darwin" | "win32";
  readonly binding: ExecutionSandboxBinding;
  readonly tool: RunTool;
  readonly policy: EffectiveRunPolicySnapshot;
  readonly workspaceRoot: string;
  readonly cwd: string;
  readonly temporaryRoot: string;
  readonly runtimeReadRoots: readonly string[];
  readonly deniedReadRoots: readonly string[];
  readonly protectedWriteRoots: readonly string[];
  readonly backend?: ExecutionSandboxBackendIdentity;
  readonly grants?: readonly ExecutionSandboxGrantFact[];
  /** Already authenticated and scoped by the existing full-access confirmation handler. */
  readonly permissionConfirmation?: PermissionConfirmation;
}

export interface ExecutionSandboxFilesystemPolicy {
  readonly workspaceRoot: string;
  readonly temporaryRoot: string;
  readonly readRoots: readonly string[];
  readonly writeRoots: readonly string[];
  readonly deniedReadRoots: readonly string[];
  readonly deniedWriteRoots: readonly string[];
}

export interface ExecutionSandboxPolicyV1 {
  readonly schemaVersion: 1;
  readonly policyVersion: 1;
  readonly policyHash: string;
  readonly issuedAt: string;
  readonly workspacePolicyUpdatedAt: string;
  readonly platform: "darwin" | "win32";
  readonly binding: ExecutionSandboxBinding;
  readonly cwd: string;
  readonly tool: RunTool;
  readonly authorizationMode: AuthorizationMode;
  readonly workspaceAccessMode: WorkspaceAccessMode;
  readonly approvalDecision: "allow" | "ask";
  readonly executionMode: "native_required" | "full_access";
  readonly networkMode: "disabled" | "single_call_allowed" | "unrestricted";
  readonly backend: ExecutionSandboxBackendIdentity | null;
  readonly filesystem: ExecutionSandboxFilesystemPolicy | null;
  readonly grants: readonly ExecutionSandboxGrantFact[];
  readonly fullAccessConfirmedAt: string | null;
}

/** Codes deliberately contain no input paths, command text, grant text or credentials. */
export class ExecutionSandboxPolicyError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ExecutionSandboxPolicyError";
  }
}
