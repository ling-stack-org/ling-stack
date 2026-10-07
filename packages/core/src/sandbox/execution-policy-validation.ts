import { authorizationAndAccessFromLegacyPermission, isAuthorizationMode, isSessionPermissionMode, isWorkspaceAccessMode, type EffectiveRunPolicySnapshot } from "../session-permissions.js";
import { ExecutionSandboxPolicyError, type ExecutionSandboxBackendIdentity, type ExecutionSandboxBinding } from "./execution-policy-types.js";

export function requirePolicy(condition: unknown, code: string): asserts condition {
  if (!condition) throw new ExecutionSandboxPolicyError(code);
}

export function strictPolicyRecord(value: unknown, keys: readonly string[], code: string): asserts value is Record<string, unknown> {
  requirePolicy(value && typeof value === "object" && !Array.isArray(value), code);
  const prototype = Object.getPrototypeOf(value);
  requirePolicy(prototype === null || prototype === Object.prototype, code);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    requirePolicy(typeof key === "string" && keys.includes(key) && descriptor && "value" in descriptor && descriptor.enumerable, code);
  }
}

export function policyIdentifier(value: unknown, code: string): asserts value is string {
  requirePolicy(typeof value === "string" && value.trim() && Buffer.byteLength(value) <= 256 && !/[\u0000-\u001f\u007f]/u.test(value), code);
}

export function policyTimestamp(value: unknown, code: string): number {
  requirePolicy(typeof value === "string", code);
  const stamp = Date.parse(value);
  requirePolicy(Number.isFinite(stamp) && new Date(stamp).toISOString() === value, code);
  return stamp;
}

const bindingKeys = ["workspaceId", "runId", "workUnitId", "attemptId", "runtimeInstanceId", "fencingToken", "toolCallId", "operationHash"] as const;
export function copyExecutionBinding(value: ExecutionSandboxBinding): ExecutionSandboxBinding {
  strictPolicyRecord(value, bindingKeys, "invalid_execution_binding");
  for (const key of bindingKeys) policyIdentifier(value[key], "invalid_execution_binding");
  requirePolicy(/^(0|[1-9][0-9]*)$/u.test(value.fencingToken) && /^[a-f0-9]{64}$/u.test(value.operationHash), "invalid_execution_binding");
  return { workspaceId: value.workspaceId, runId: value.runId, workUnitId: value.workUnitId, attemptId: value.attemptId,
    runtimeInstanceId: value.runtimeInstanceId, fencingToken: value.fencingToken, toolCallId: value.toolCallId, operationHash: value.operationHash };
}

export function copyBackendIdentity(value: ExecutionSandboxBackendIdentity | undefined, platform: "darwin" | "win32"): ExecutionSandboxBackendIdentity {
  requirePolicy(value, "backend_identity_required");
  strictPolicyRecord(value, ["kind", "helperVersion", "protocolVersion", "executableSha256"], "invalid_backend_identity");
  requirePolicy(value.kind === (platform === "darwin" ? "macos_seatbelt" : "windows_restricted") && value.protocolVersion === 1
    && typeof value.executableSha256 === "string" && /^[a-f0-9]{64}$/u.test(value.executableSha256), "invalid_backend_identity");
  policyIdentifier(value.helperVersion, "invalid_backend_identity");
  return { kind: value.kind, helperVersion: value.helperVersion, protocolVersion: 1, executableSha256: value.executableSha256 };
}

export function policySelection(policy: EffectiveRunPolicySnapshot) {
  requirePolicy(policy && isSessionPermissionMode(policy.mode), "invalid_effective_policy");
  if (policy.authorizationMode !== undefined && policy.workspaceAccessMode !== undefined) {
    requirePolicy(isAuthorizationMode(policy.authorizationMode) && isWorkspaceAccessMode(policy.workspaceAccessMode), "invalid_effective_policy");
    return { authorizationMode: policy.authorizationMode, workspaceAccessMode: policy.workspaceAccessMode };
  }
  requirePolicy(policy.authorizationMode === undefined && policy.workspaceAccessMode === undefined && policy.mode !== "custom", "ambiguous_legacy_policy");
  return authorizationAndAccessFromLegacyPermission(policy.mode, undefined);
}

/** Constructed output owns every object; no input reference is frozen or mutated. */
export function freezeExecutionPolicy<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeExecutionPolicy(child);
    Object.freeze(value);
  }
  return value;
}
