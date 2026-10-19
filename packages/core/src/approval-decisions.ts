import { isAbsolute } from "node:path";
import type { ApprovalDecisionKind, ApprovalRequest, NativePermissionRequestPayload } from "./approval-types.js";

export class ApprovalDecisionUnavailableError extends Error {
  readonly code = "approval_decision_unavailable";
  constructor() { super("The requested approval decision is not available for this approval."); }
}

export function isApprovalGrantDecisionKind(value: unknown): value is Exclude<ApprovalDecisionKind, "deny"> {
  return value === "approve_once" || value === "approve_command_rule" || value === "approve_permission_scope";
}

export function assertApprovalDecisionAvailable(
  approval: Pick<ApprovalRequest, "actionType" | "payload" | "availableDecisions">,
  decision: unknown,
): asserts decision is Exclude<ApprovalDecisionKind, "deny"> {
  const offered = approval.availableDecisions ?? ["approve_once", "deny"];
  if (!isApprovalGrantDecisionKind(decision) || !offered.includes(decision)) throw new ApprovalDecisionUnavailableError();
  const nativeScope = approval.payload.type === "native_permission_request";
  if (nativeScope || decision === "approve_permission_scope") {
    if (decision !== "approve_permission_scope" || approval.actionType !== "runtime_permission_request"
      || !isNativePermissionRequestPayload(approval.payload)) throw new ApprovalDecisionUnavailableError();
  }
  if (decision === "approve_command_rule" && (approval.actionType !== "bash" || approval.payload.type !== "bash")) {
    throw new ApprovalDecisionUnavailableError();
  }
}

/** Validate identity/shape only. Adapters separately enforce policy and native scope intersection. */
export function isNativePermissionRequestPayload(value: unknown): value is NativePermissionRequestPayload {
  if (!record(value) || !keys(value, ["type", "version", "scope", "cwd", "reason", "resources", "fileSystemScanDepth"])
    || value.type !== "native_permission_request" || value.version !== 1 || value.scope !== "turn"
    || !path(value.cwd) || typeof value.reason !== "string" || value.reason.length > 8192 || value.reason.includes("\0")
    || !Array.isArray(value.resources) || !value.resources.length || value.resources.length > 256
    || !value.resources.every(resource)) return false;
  if (value.fileSystemScanDepth !== undefined && (typeof value.fileSystemScanDepth !== "number"
    || !Number.isSafeInteger(value.fileSystemScanDepth) || value.fileSystemScanDepth <= 0
    || !value.resources.some(entry => entry.kind === "filesystem"))) return false;
  return value.resources.some(entry => entry.access !== "deny");
}

function resource(value: unknown): boolean {
  if (!record(value)) return false;
  if (value.kind === "network") return keys(value, ["kind", "access"]) && value.access === "connect";
  return value.kind === "filesystem" && keys(value, ["kind", "access", "target"])
    && typeof value.access === "string" && ["read", "write", "deny"].includes(value.access) && target(value.target);
}

function target(value: unknown): boolean {
  if (!record(value)) return false;
  if (value.kind === "path") return keys(value, ["kind", "path"]) && path(value.path);
  if (value.kind === "glob") return keys(value, ["kind", "pattern"]) && path(value.pattern);
  if (value.kind !== "special" || !keys(value, ["kind", "name", "subpath"])
    || typeof value.name !== "string" || !["root", "minimal", "project_roots", "tmpdir", "slash_tmp"].includes(value.name)) return false;
  return value.subpath === undefined || (value.name === "project_roots" && text(value.subpath)
    && !isAbsolute(value.subpath) && !value.subpath.split(/[\\/]/).includes(".."));
}

function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean { return Object.keys(value).every(key => allowed.includes(key)); }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function text(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value); }
function path(value: unknown): value is string { return text(value) && isAbsolute(value); }
