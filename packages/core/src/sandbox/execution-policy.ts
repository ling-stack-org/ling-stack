import { createHash } from "node:crypto";
import { readOnlyRunTools, riskyRunTools } from "../approval-policy.js";
import { executionSandboxPaths } from "./execution-policy-paths.js";
import { copyBackendIdentity, copyExecutionBinding, freezeExecutionPolicy, policyIdentifier, policySelection, policyTimestamp, requirePolicy, strictPolicyRecord } from "./execution-policy-validation.js";
import type { CompileExecutionSandboxPolicyInput, ExecutionSandboxGrantFact, ExecutionSandboxGrantScope, ExecutionSandboxPolicyV1 } from "./execution-policy-types.js";

/** Compile policy content only. Never proves approval consumption, fresh DB state or OS readiness. */
export function compileExecutionSandboxPolicy(input: CompileExecutionSandboxPolicyInput): ExecutionSandboxPolicyV1 {
  strictPolicyRecord(input, ["now", "platform", "binding", "tool", "policy", "workspaceRoot", "cwd", "temporaryRoot", "runtimeReadRoots", "deniedReadRoots", "protectedWriteRoots", "backend", "grants", "permissionConfirmation"], "invalid_policy_input");
  const now = policyTimestamp(input.now, "invalid_policy_timestamp");
  const binding = copyExecutionBinding(input.binding);
  const selection = policySelection(input.policy);
  requirePolicy(policyTimestamp(input.policy.workspacePolicyUpdatedAt, "invalid_effective_policy") <= now, "invalid_effective_policy");
  const tools: readonly string[] = [...readOnlyRunTools, ...riskyRunTools];
  requirePolicy(tools.includes(input.tool), "unsupported_sandbox_tool");
  const decision = input.policy.toolDecisions?.[input.tool];
  requirePolicy(decision === "allow" || decision === "ask" || decision === "deny", "invalid_effective_policy");
  const mutation = (riskyRunTools as readonly string[]).includes(input.tool);
  const planMode = input.policy.conversationMode === "plan" || input.policy.planModeMutationPolicy === "deny_repo_tracked_mutation";
  requirePolicy(decision !== "deny" && !(mutation && (planMode || selection.workspaceAccessMode === "read_only")), "operation_denied");
  const paths = executionSandboxPaths(input.platform);
  const workspace = paths.absolute(input.workspaceRoot);
  const cwd = paths.absolute(input.cwd);
  const temporaryRoot = paths.absolute(input.temporaryRoot);
  const runtimeRoots = paths.roots(input.runtimeReadRoots);
  const inputDeniedReadRoots = paths.roots(input.deniedReadRoots);
  const inputProtectedWriteRoots = paths.roots(input.protectedWriteRoots);
  const deniedReadRoots = paths.roots([...inputDeniedReadRoots, paths.join(workspace, ".ling")]);
  const deniedWriteRoots = paths.roots([...inputProtectedWriteRoots, ...deniedReadRoots,
    ...[".git", ".agents", ".codex", ".ling"].map(name => paths.join(workspace, name))]);
  requirePolicy(!paths.overlap(temporaryRoot, workspace)
    && ![...deniedWriteRoots, ...runtimeRoots].some(root => paths.overlap(temporaryRoot, root)), "temporary_scope_overlap");
  requirePolicy(!runtimeRoots.some(root => deniedReadRoots.some(denied => paths.inside(root, denied))), "protected_scope");
  const fullAccess = selection.workspaceAccessMode === "full_access";
  let confirmedAt: string | null = null;
  if (fullAccess) {
    const confirmation = input.permissionConfirmation;
    requirePolicy(confirmation?.mode === "full_access" && confirmation.confirmed === true && typeof confirmation.reason === "string" && confirmation.reason.trim(), "full_access_confirmation_required");
    requirePolicy(policyTimestamp(confirmation.confirmedAt, "full_access_confirmation_required") <= now, "full_access_confirmation_required");
    confirmedAt = confirmation.confirmedAt;
  }
  const backend = fullAccess ? null : copyBackendIdentity(input.backend, input.platform);
  requirePolicy(Array.isArray(input.policy.allowedWritePaths) && input.policy.allowedWritePaths.length <= 128, "invalid_effective_policy");
  const writes = fullAccess || selection.workspaceAccessMode === "read_only" || planMode || !mutation ? []
    : paths.roots(input.policy.allowedWritePaths.map(root => paths.workspaceWriteRoot(root, workspace)));
  requirePolicy(!writes.some(root => deniedWriteRoots.some(denied => paths.inside(root, denied))), "protected_scope");
  const grants = compileGrants(input, binding, cwd, now, paths);
  const extraReadRoots: string[] = [];
  const extraWriteRoots: string[] = [];
  let networkMode: ExecutionSandboxPolicyV1["networkMode"] = fullAccess ? "unrestricted" : "disabled";
  for (const grant of grants) {
    requirePolicy(!fullAccess, "grant_scope_incompatible");
    if (grant.scope.kind === "command_network") {
      requirePolicy(input.tool === "bash", "grant_scope_incompatible");
      networkMode = "single_call_allowed";
    } else {
      const denied = grant.scope.kind === "write_roots" ? deniedWriteRoots : deniedReadRoots;
      requirePolicy(!grant.scope.roots.some(root => denied.some(protectedRoot => paths.inside(root, protectedRoot))), "protected_scope");
      extraReadRoots.push(...grant.scope.roots);
      if (grant.scope.kind === "write_roots") {
        requirePolicy(mutation && !planMode && selection.workspaceAccessMode === "workspace_write", "grant_scope_incompatible");
        extraWriteRoots.push(...grant.scope.roots);
      }
    }
  }
  const readRoots = paths.roots([workspace, ...runtimeRoots, ...extraReadRoots]);
  requirePolicy(fullAccess || readRoots.some(root => paths.inside(cwd, root)), "cwd_outside_scope");
  requirePolicy(fullAccess || !deniedReadRoots.some(root => paths.inside(cwd, root)), "protected_scope");
  const body: Omit<ExecutionSandboxPolicyV1, "policyHash"> = {
    schemaVersion: 1, policyVersion: 1, issuedAt: input.now, workspacePolicyUpdatedAt: input.policy.workspacePolicyUpdatedAt,
    platform: input.platform, binding, cwd, tool: input.tool, ...selection, approvalDecision: decision,
    executionMode: fullAccess ? "full_access" : "native_required", networkMode, backend,
    filesystem: fullAccess ? null : { workspaceRoot: workspace, temporaryRoot, readRoots, writeRoots: paths.roots([...writes, ...extraWriteRoots]), deniedReadRoots, deniedWriteRoots },
    grants, fullAccessConfirmedAt: confirmedAt,
  };
  const policyHash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  return freezeExecutionPolicy({ ...body, policyHash });
}

function compileGrants(
  input: CompileExecutionSandboxPolicyInput,
  binding: ExecutionSandboxPolicyV1["binding"], cwd: string, now: number,
  paths: ReturnType<typeof executionSandboxPaths>,
): ExecutionSandboxGrantFact[] {
  const values = input.grants ?? [];
  requirePolicy(Array.isArray(values) && values.length <= 64, "invalid_grant");
  const seen = new Set<string>();
  return values.map((value: ExecutionSandboxGrantFact): ExecutionSandboxGrantFact => {
    strictPolicyRecord(value, ["id", "approvalId", "binding", "cwd", "scope", "status", "createdAt", "expiresAt"], "invalid_grant");
    policyIdentifier(value.id, "invalid_grant");
    policyIdentifier(value.approvalId, "invalid_grant");
    requirePolicy(!seen.has(value.id), "invalid_grant");
    seen.add(value.id);
    requirePolicy(value.status === "approved" && policyTimestamp(value.createdAt, "grant_not_current") <= now && policyTimestamp(value.expiresAt, "grant_not_current") > now, "grant_not_current");
    const sourceBinding = copyExecutionBinding(value.binding);
    const grantCwd = paths.absolute(value.cwd);
    requirePolicy(JSON.stringify(sourceBinding) === JSON.stringify(binding) && grantCwd === cwd, "grant_binding_mismatch");
    strictPolicyRecord(value.scope, ["kind", "roots"], "invalid_grant");
    requirePolicy(["command_network", "read_roots", "write_roots"].includes(value.scope.kind), "invalid_grant");
    const scope: ExecutionSandboxGrantScope = value.scope.kind === "command_network" ? { kind: "command_network" }
      : { kind: value.scope.kind, roots: paths.roots(value.scope.roots) };
    requirePolicy(scope.kind === "command_network" ? !Object.hasOwn(value.scope, "roots") : scope.roots.length > 0, "invalid_grant");
    return { id: value.id, approvalId: value.approvalId, binding: sourceBinding, cwd: grantCwd, scope,
      status: "approved" as const, createdAt: value.createdAt, expiresAt: value.expiresAt };
  }).sort((first, second) => first.id < second.id ? -1 : first.id > second.id ? 1 : 0);
}
