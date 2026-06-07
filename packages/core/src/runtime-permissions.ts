import { isAbsolute, relative, resolve as resolvePath } from "node:path";
import {
  defaultApprovalToolDecisions,
  type ApprovalPolicy,
  type RunTool,
} from "./approval-policy.js";
import type {
  ApprovalRequest,
  RuntimePermissionGrant,
  RuntimePermissionRequestKind,
  RuntimePermissionRequestPayload,
  RuntimePermissionScope,
  RuntimePermissionScopeSnapshot,
} from "./approval-types.js";

export const RUNTIME_REQUEST_PERMISSIONS_CAPABILITY = "runtime:request-permissions";

export const runtimePermissionRequestKinds: readonly RuntimePermissionRequestKind[] = [
  "core_tool",
  "write_scope",
  "mcp_tool",
  "runner_capability",
];

export interface RuntimePermissionEvaluationInput {
  readonly payload: RuntimePermissionRequestPayload;
  readonly cwd: string;
  readonly approvalPolicy: ApprovalPolicy;
  readonly supportedTools?: readonly string[];
  readonly mcpToolRefs?: readonly string[];
  readonly runnerCapabilities?: readonly string[];
}

export interface RuntimePermissionEvaluationResult {
  readonly decision: "ask" | "deny";
  readonly reason: string;
}

export function evaluateRuntimePermissionRequest(input: RuntimePermissionEvaluationInput): RuntimePermissionEvaluationResult {
  const shape = validateRuntimePermissionRequestPayload(input.payload);
  if (!shape.ok) {
    return { decision: "deny", reason: shape.reason };
  }

  switch (input.payload.requestedScope.kind) {
    case "core_tool":
      return evaluateCoreToolRequest(input);
    case "write_scope":
      return evaluateWriteScopeRequest(input);
    case "mcp_tool":
      return evaluateMcpToolRequest(input);
    case "runner_capability":
      return evaluateRunnerCapabilityRequest(input);
  }
}

export function validateRuntimePermissionRequestPayload(
  payload: RuntimePermissionRequestPayload,
): RuntimePermissionEvaluationResult & { readonly ok: boolean } {
  if (payload.type !== "runtime_permission_request") {
    return { ok: false, decision: "deny", reason: "Permission request payload has the wrong type." };
  }
  if (!runtimePermissionRequestKinds.includes(payload.requestKind)) {
    return { ok: false, decision: "deny", reason: `Unsupported permission request kind: ${String(payload.requestKind)}.` };
  }
  if (payload.requestKind !== payload.requestedScope.kind) {
    return {
      ok: false,
      decision: "deny",
      reason: `Permission request kind ${payload.requestKind} does not match scope kind ${payload.requestedScope.kind}.`,
    };
  }
  if (!payload.requestedByRunId.trim()) {
    return { ok: false, decision: "deny", reason: "Permission request is missing requestedByRunId." };
  }
  if (!payload.reason.trim()) {
    return { ok: false, decision: "deny", reason: "Permission request reason is required." };
  }
  if (!payload.currentScope.runnerId.trim()) {
    return { ok: false, decision: "deny", reason: "Permission request current scope is missing runnerId." };
  }
  if (!payload.proposedContinuation.reason.trim()) {
    return { ok: false, decision: "deny", reason: "Permission request continuation reason is required." };
  }
  const scope = validateRuntimePermissionScope(payload.requestedScope);
  if (!scope.ok) {
    return scope;
  }
  return { ok: true, decision: "ask", reason: "Permission request is valid." };
}

export function validateRuntimePermissionScope(
  scope: RuntimePermissionScope,
): RuntimePermissionEvaluationResult & { readonly ok: boolean } {
  switch (scope.kind) {
    case "core_tool": {
      if (scope.tools.length === 0) {
        return { ok: false, decision: "deny", reason: "Core tool permission request must include at least one tool." };
      }
      const unsupported = scope.tools.find((tool) => !isRunTool(tool));
      if (unsupported) {
        return { ok: false, decision: "deny", reason: `Unsupported core tool: ${unsupported}.` };
      }
      return { ok: true, decision: "ask", reason: "Core tool permission scope is valid." };
    }
    case "write_scope": {
      if (scope.paths.length === 0) {
        return { ok: false, decision: "deny", reason: "Write-scope permission request must include at least one path." };
      }
      const invalid = scope.paths.find((path) => !isSafeRequestedPath(path));
      if (invalid) {
        return { ok: false, decision: "deny", reason: `Unsafe write-scope path: ${invalid}.` };
      }
      if (!["read_write", "create", "update", "delete"].includes(scope.operation)) {
        return { ok: false, decision: "deny", reason: `Unsupported write-scope operation: ${scope.operation}.` };
      }
      return { ok: true, decision: "ask", reason: "Write-scope permission scope is valid." };
    }
    case "mcp_tool":
      if (!scope.serverId.trim() || !scope.toolName.trim()) {
        return { ok: false, decision: "deny", reason: "MCP tool permission request requires serverId and toolName." };
      }
      if (!scope.sideEffectLevel.trim() || !scope.defaultApproval.trim()) {
        return { ok: false, decision: "deny", reason: "MCP tool permission request requires sideEffectLevel and defaultApproval." };
      }
      return { ok: true, decision: "ask", reason: "MCP tool permission scope is valid." };
    case "runner_capability":
      if (!scope.runnerId.trim() || !scope.capability.trim()) {
        return { ok: false, decision: "deny", reason: "Runner capability permission request requires runnerId and capability." };
      }
      return { ok: true, decision: "ask", reason: "Runner capability permission scope is valid." };
  }
}

export function buildRuntimePermissionGrant(
  approval: ApprovalRequest,
  now: string,
  mode: RuntimePermissionGrant["mode"] = "continuation",
): RuntimePermissionGrant | undefined {
  if (
    approval.status !== "approved" ||
    approval.actionType !== "runtime_permission_request" ||
    !isRuntimePermissionRequestPayload(approval.payload) ||
    !approval.runId
  ) {
    return undefined;
  }
  return {
    id: `runtime_permission_grant:${approval.id}`,
    approvalId: approval.id,
    runId: approval.runId,
    scope: approval.payload.requestedScope,
    mode,
    createdAt: now,
    expiresAt: approval.expiresAt,
  };
}

export function isRuntimePermissionRequestPayload(value: unknown): value is RuntimePermissionRequestPayload {
  return typeof value === "object" && value !== null && (value as { type?: unknown }).type === "runtime_permission_request";
}

export function summarizeRuntimePermissionScope(scope: RuntimePermissionScope): string {
  switch (scope.kind) {
    case "core_tool":
      return `tools: ${scope.tools.join(", ")}`;
    case "write_scope":
      return `${scope.operation}: ${scope.paths.join(", ")}`;
    case "mcp_tool":
      return `mcp: ${scope.serverId}/${scope.toolName}`;
    case "runner_capability":
      return `runner: ${scope.runnerId}/${scope.capability}`;
  }
}

export function summarizeRuntimePermissionRequestPayload(payload: RuntimePermissionRequestPayload): string {
  return `${payload.requestKind}: ${summarizeRuntimePermissionScope(payload.requestedScope)} -> ${payload.proposedContinuation.mode}`;
}

export function runtimePermissionToolDelta(
  currentScope: RuntimePermissionScopeSnapshot,
  requestedTools: readonly RunTool[],
): RunTool[] {
  const current = new Set(currentScope.tools);
  return requestedTools.filter((tool) => !current.has(tool));
}

function evaluateCoreToolRequest(input: RuntimePermissionEvaluationInput): RuntimePermissionEvaluationResult {
  const scope = input.payload.requestedScope;
  if (scope.kind !== "core_tool") {
    return { decision: "deny", reason: "Permission request scope is not core_tool." };
  }
  const unsupported = scope.tools.find((tool) => input.supportedTools && !input.supportedTools.includes(tool));
  if (unsupported) {
    return { decision: "deny", reason: `Runner does not support core tool ${unsupported}.` };
  }
  const denied = scope.tools.find((tool) => (input.approvalPolicy.toolDecisions[tool] ?? defaultApprovalToolDecisions[tool]) === "deny");
  if (denied) {
    return { decision: "deny", reason: `Workspace policy denied core tool ${denied}.` };
  }
  return { decision: "ask", reason: `Permission request requires approval for ${scope.tools.join(", ")}.` };
}

function evaluateWriteScopeRequest(input: RuntimePermissionEvaluationInput): RuntimePermissionEvaluationResult {
  const scope = input.payload.requestedScope;
  if (scope.kind !== "write_scope") {
    return { decision: "deny", reason: "Permission request scope is not write_scope." };
  }
  const deniedPath = scope.paths.find((path) => !isPathWithinAllowedWritePaths(path, input.cwd, input.approvalPolicy.allowedWritePaths));
  if (deniedPath) {
    return { decision: "deny", reason: `Workspace policy denied write scope ${deniedPath}.` };
  }
  return { decision: "ask", reason: `Permission request requires approval for write scope ${scope.paths.join(", ")}.` };
}

function evaluateMcpToolRequest(input: RuntimePermissionEvaluationInput): RuntimePermissionEvaluationResult {
  const scope = input.payload.requestedScope;
  if (scope.kind !== "mcp_tool") {
    return { decision: "deny", reason: "Permission request scope is not mcp_tool." };
  }
  const refs = input.mcpToolRefs;
  if (refs && refs.length > 0 && !refs.includes(mcpToolRef(scope.serverId, scope.toolName))) {
    return { decision: "deny", reason: `MCP tool ${scope.serverId}/${scope.toolName} is not available in the current run.` };
  }
  if (scope.defaultApproval === "deny") {
    return { decision: "deny", reason: `MCP tool ${scope.serverId}/${scope.toolName} is denied by default.` };
  }
  return { decision: "ask", reason: `Permission request requires approval for MCP tool ${scope.serverId}/${scope.toolName}.` };
}

function evaluateRunnerCapabilityRequest(input: RuntimePermissionEvaluationInput): RuntimePermissionEvaluationResult {
  const scope = input.payload.requestedScope;
  if (scope.kind !== "runner_capability") {
    return { decision: "deny", reason: "Permission request scope is not runner_capability." };
  }
  if (input.runnerCapabilities && !input.runnerCapabilities.includes(scope.capability)) {
    return { decision: "deny", reason: `Runner ${scope.runnerId} does not expose capability ${scope.capability}.` };
  }
  return { decision: "ask", reason: `Permission request requires approval for runner capability ${scope.capability}.` };
}

function isRunTool(value: string): value is RunTool {
  return value === "read" || value === "grep" || value === "find" || value === "ls" || value === "bash" || value === "edit" || value === "write";
}

function isSafeRequestedPath(path: string): boolean {
  const trimmed = path.trim();
  if (!trimmed || trimmed === "<unknown>") {
    return false;
  }
  if (trimmed.includes("\0")) {
    return false;
  }
  const normalized = relative(".", trimmed);
  return normalized !== ".." && !normalized.startsWith(`..${"/"}`) && !isAbsolute(normalized);
}

function isPathWithinAllowedWritePaths(inputPath: string, cwd: string, allowedWritePaths: readonly string[]): boolean {
  const absolutePath = isAbsolute(inputPath) ? inputPath : resolvePath(cwd, inputPath);
  return allowedWritePaths.some((allowedPath) => {
    const scopePath = isAbsolute(allowedPath) ? allowedPath : resolvePath(cwd, allowedPath);
    const relativePath = relative(scopePath, absolutePath);
    return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
  });
}

function mcpToolRef(serverId: string, toolName: string): string {
  return `${serverId}:${toolName}`;
}
