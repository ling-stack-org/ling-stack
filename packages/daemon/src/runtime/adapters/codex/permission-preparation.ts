import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { isNativePermissionRequestPayload, type NativePermissionRequestPayload, type NativePermissionResource,
  type NativePermissionTarget, type RunTool } from "@ling-stack/core";
import { evaluateApprovalActionPolicy } from "../../../features/runs/approval-action-policy.js";
import { assertNoInternalPatchPaths, assertPatchPathsWithinAllowedWritePaths } from "../../../features/runs/patch-actions.js";
import type { CodexApprovalPolicyContext, CodexPreparedAction } from "./action-preparation.js";
import type { PermissionsRequestApprovalResponse } from "./protocol/v2/PermissionsRequestApprovalResponse.js";
import type { FileSystemSandboxEntry } from "./protocol/v2/FileSystemSandboxEntry.js";

/** Wire parsing and policy proof are separate: a valid resource is not automatically grantable. */
export function prepareCodexPermissionAction(params: Record<string, unknown>, cwd: string,
  context: CodexApprovalPolicyContext): CodexPreparedAction {
  const payload = readPermissionPayload(params, cwd);
  if (!payload) return { kind: "unsupported", reason: "invalid_native_permissions" };
  const tools = new Set<RunTool>();
  let mutationCapable = false;
  for (const resource of payload.resources) {
    if (resource.access === "deny") continue;
    if (resource.kind === "network") { tools.add("bash"); mutationCapable = true; }
    else {
      for (const tool of ["read", "grep", "find", "ls"] as const) tools.add(tool);
      if (resource.access === "write") {
        mutationCapable = true;
        for (const tool of ["write", "edit", "bash"] as const) tools.add(tool);
        if (resource.target.kind !== "path") return { kind: "unsupported", reason: "unproven_native_write_scope" };
      }
    }
  }
  const approval = { actionType: "runtime_permission_request" as const, risk: "high" as const,
    toolCallId: params.itemId as string, title: "Approve turn permissions", description: payload.reason, payload };
  let prepared: Extract<CodexPreparedAction, { kind: "action" }> = { kind: "action", approval,
    policyDecision: { decision: "ask", reason: "The native engine requires explicit approval for this turn's resources." }, denialDecision: "decline" };
  for (const toolName of tools) {
    const evaluation = evaluateApprovalActionPolicy({ ...context, request: { toolName, cwd }, approvalInput: approval });
    prepared = { ...prepared, approval: evaluation.approvalInput };
    if (evaluation.policyDecision.decision === "deny" || (prepared.policyDecision.decision !== "deny" && evaluation.policyDecision.decision === "ask")) {
      prepared = { ...prepared, policyDecision: evaluation.policyDecision };
    }
    if (context.effectivePolicySnapshot?.toolDecisions?.[toolName] === "deny") {
      prepared = deny(prepared, "The effective run policy denies a tool affected by this resource grant.");
    }
  }
  const profile = context.approvalProfile;
  if (profile && profile.mode !== "none" && ((mutationCapable && profile.mode === "strict")
    || profile.requiredForTools?.some(tool => tools.has(tool))
    || profile.requiredForActions?.some(action => action !== "runtime_permission_request"))) {
    prepared = deny(prepared, "A turn resource grant cannot replace required per-action approval.");
  }
  if (mutationCapable && (context.effectivePolicySnapshot?.conversationMode === "plan"
    || context.effectivePolicySnapshot?.workspaceAccessMode === "read_only")) {
    prepared = deny(prepared, "Plan Mode or read-only access denies mutation-capable turn permissions.");
  }
  try {
    for (const resource of payload.resources) {
      if (resource.kind === "filesystem" && resource.access === "write" && resource.target.kind === "path") {
        assertWriteScope(resource.target.path, cwd, context.policy.allowedWritePaths, payload.resources);
        if (context.effectivePolicySnapshot?.allowedWritePaths) {
          assertWriteScope(resource.target.path, cwd, context.effectivePolicySnapshot.allowedWritePaths, payload.resources);
        }
      }
    }
  } catch { prepared = deny(prepared, "Native permission resources exceed the permitted write scope."); }
  return prepared;
}

export function codexPermissionResponse(payload: NativePermissionRequestPayload, approved: boolean): PermissionsRequestApprovalResponse {
  if (!isNativePermissionRequestPayload(payload)) throw new Error("invalid_native_permissions");
  if (!approved) return { permissions: {}, scope: "turn" };
  const entries: FileSystemSandboxEntry[] = [];
  let network = false;
  for (const resource of payload.resources) {
    if (resource.kind === "network") { network = true; continue; }
    const target = resource.target;
    entries.push({ access: resource.access, path: target.kind === "path" ? { type: "path", path: target.path }
      : target.kind === "glob" ? { type: "glob_pattern", pattern: target.pattern }
        : { type: "special", value: target.name === "project_roots"
          ? { kind: "project_roots", subpath: target.subpath ?? null } : { kind: target.name } } });
  }
  return { permissions: { ...(network ? { network: { enabled: true } } : {}),
    ...(entries.length ? { fileSystem: { read: null, write: null, entries,
      ...(payload.fileSystemScanDepth === undefined ? {} : { globScanMaxDepth: payload.fileSystemScanDepth }) } } : {}) }, scope: "turn" };
}

function readPermissionPayload(params: Record<string, unknown>, cwd: string): NativePermissionRequestPayload | undefined {
  if (!keys(params, ["threadId", "turnId", "itemId", "environmentId", "startedAtMs", "cwd", "reason", "permissions"])
    || params.environmentId != null || typeof params.startedAtMs !== "number" || !Number.isSafeInteger(params.startedAtMs)
    || params.startedAtMs < 0 || typeof params.cwd !== "string" || !isAbsolute(params.cwd)
    || (params.reason != null && typeof params.reason !== "string")) return;
  try { if (realpathSync(params.cwd) !== realpathSync(cwd)) return; } catch { return; }
  const permissions = params.permissions;
  if (!record(permissions) || !keys(permissions, ["network", "fileSystem"])) return;
  const resources: NativePermissionResource[] = [];
  if (permissions.network != null) {
    const network = permissions.network;
    if (!record(network) || !keys(network, ["enabled"]) || (network.enabled != null && typeof network.enabled !== "boolean")) return;
    if (network.enabled === true) resources.push({ kind: "network", access: "connect" });
  }
  const fs = permissions.fileSystem;
  if (fs != null) {
    if (!record(fs) || !keys(fs, ["read", "write", "entries", "globScanMaxDepth"])) return;
    for (const access of ["read", "write"] as const) {
      if (fs[access] != null && (!Array.isArray(fs[access]) || !fs[access].every(value => typeof value === "string"))) return;
    }
    // The pinned app-server conversion uses entries instead of both legacy projections.
    if (fs.entries != null) {
      if (!Array.isArray(fs.entries) || fs.entries.length > 256) return;
      for (const entry of fs.entries) {
        if (!record(entry) || !keys(entry, ["access", "path"]) || typeof entry.access !== "string" || !["read", "write", "deny"].includes(entry.access)) return;
        const target = readTarget(entry.path);
        if (!target) return;
        resources.push({ kind: "filesystem", access: entry.access as "read" | "write" | "deny", target });
      }
    } else {
      for (const access of ["read", "write"] as const) {
        const paths = fs[access] as string[] | null | undefined;
        if (paths && paths.length > 256) return;
        for (const path of paths ?? []) resources.push({ kind: "filesystem", access, target: { kind: "path", path } });
      }
    }
  }
  const payload = { type: "native_permission_request", version: 1, scope: "turn", cwd: params.cwd,
    reason: params.reason ?? "", resources,
    ...(record(fs) && fs.globScanMaxDepth !== undefined ? { fileSystemScanDepth: fs.globScanMaxDepth } : {}) };
  return isNativePermissionRequestPayload(payload) ? payload : undefined;
}

function readTarget(value: unknown): NativePermissionTarget | undefined {
  if (!record(value)) return;
  if (value.type === "path" && keys(value, ["type", "path"]) && typeof value.path === "string") return { kind: "path", path: value.path };
  if (value.type === "glob_pattern" && keys(value, ["type", "pattern"]) && typeof value.pattern === "string") return { kind: "glob", pattern: value.pattern };
  if (value.type !== "special" || !keys(value, ["type", "value"]) || !record(value.value)) return;
  const special = value.value;
  if (special.kind === "project_roots" && keys(special, ["kind", "subpath"])) {
    if (special.subpath != null && typeof special.subpath !== "string") return;
    return { kind: "special", name: "project_roots", ...(special.subpath == null ? {} : { subpath: special.subpath }) };
  }
  if (keys(special, ["kind"]) && typeof special.kind === "string" && ["root", "minimal", "tmpdir", "slash_tmp"].includes(special.kind)) {
    return { kind: "special", name: special.kind as "root" | "minimal" | "tmpdir" | "slash_tmp" };
  }
  return;
}

function assertWriteScope(path: string, cwd: string, allowed: readonly string[], resources: readonly NativePermissionResource[]): void {
  assertPatchPathsWithinAllowedWritePaths([path], cwd, allowed);
  const canonicalCwd = realpathSync(cwd);
  const canonicalPath = canonical(path);
  assertPatchPathsWithinAllowedWritePaths([canonicalPath], canonicalCwd, allowed.map(root => canonical(resolve(cwd, root))));
  assertNoInternalPatchPaths([relative(canonicalCwd, canonicalPath).split(sep).join("/")]);
  const internal = resolve(canonicalCwd, ".ling-stack");
  if (contains(canonicalPath, internal) && !resources.some(resource => resource.kind === "filesystem" && resource.access === "deny"
    && resource.target.kind === "path" && contains(canonical(resource.target.path), internal))) {
    throw new Error("internal_state_in_permission_scope");
  }
}
function canonical(path: string): string {
  let ancestor = resolve(path);
  while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
  return resolve(realpathSync(ancestor), relative(ancestor, resolve(path)));
}
function contains(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}
function deny(prepared: Extract<CodexPreparedAction, { kind: "action" }>, reason: string): typeof prepared {
  return { ...prepared, policyDecision: { decision: "deny", reason } };
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean { return Object.keys(value).every(key => allowed.includes(key)); }
