import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  buildRuntimePermissionGrant,
  createApprovalRequestId,
  defaultApprovalToolDecisions,
  evaluateRuntimePermissionRequest,
  validateRuntimePermissionRequestPayload,
} from "../dist/index.js";

const now = "2026-06-07T00:00:00.000Z";
const cwd = resolve("/tmp/ling-stack-runtime-permissions");

test("runtime permission payload validation requires matching request kind and scope", () => {
  const payload = permissionPayload({
    requestKind: "core_tool",
    requestedScope: { kind: "write_scope", paths: ["docs"], operation: "update" },
  });

  const result = validateRuntimePermissionRequestPayload(payload);

  assert.equal(result.ok, false);
  assert.match(result.reason, /does not match/);
});

test("core tool permission requests respect workspace deny", () => {
  const payload = permissionPayload({
    requestKind: "core_tool",
    requestedScope: { kind: "core_tool", tools: ["bash"] },
  });

  const result = evaluateRuntimePermissionRequest({
    payload,
    cwd,
    approvalPolicy: policy({ bash: "deny" }),
    supportedTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
  });

  assert.equal(result.decision, "deny");
  assert.match(result.reason, /Workspace policy denied core tool bash/);
});

test("write-scope permission requests reject traversal before actionable approval", () => {
  const payload = permissionPayload({
    requestKind: "write_scope",
    requestedScope: { kind: "write_scope", paths: ["../secrets"], operation: "update" },
  });

  const result = evaluateRuntimePermissionRequest({
    payload,
    cwd,
    approvalPolicy: policy({ write: "ask" }),
  });

  assert.equal(result.decision, "deny");
  assert.match(result.reason, /Unsafe write-scope path/);
});

test("approved runtime permission approvals materialize deterministic continuation grants", () => {
  const approvalId = createApprovalRequestId();
  const payload = permissionPayload({
    requestKind: "core_tool",
    requestedScope: { kind: "core_tool", tools: ["write"] },
  });

  const grant = buildRuntimePermissionGrant({
    id: approvalId,
    runId: "run_permission",
    taskId: "task_permission",
    actionType: "runtime_permission_request",
    risk: "medium",
    title: "Approve runtime permission",
    description: "Request write",
    payload,
    status: "approved",
    createdAt: now,
    resolvedAt: now,
  }, now, "continuation");

  assert.deepEqual(grant, {
    id: `runtime_permission_grant:${approvalId}`,
    approvalId,
    runId: "run_permission",
    scope: payload.requestedScope,
    mode: "continuation",
    createdAt: now,
    expiresAt: undefined,
  });
});

function policy(overrides = {}) {
  return {
    workspaceId: "workspace_default",
    toolDecisions: {
      ...defaultApprovalToolDecisions,
      ...overrides,
    },
    allowedWritePaths: ["."],
    createdAt: now,
    updatedAt: now,
  };
}

function permissionPayload(overrides = {}) {
  return {
    type: "runtime_permission_request",
    requestKind: "core_tool",
    requestedByRunId: "run_permission",
    requestedByToolCallId: "tool_permission",
    reason: "Need a scoped permission for the current task.",
    requestedScope: { kind: "core_tool", tools: ["write"] },
    currentScope: {
      tools: ["read", "grep", "find", "ls"],
      allowedWritePaths: ["."],
      mcpToolRefs: [],
      runnerId: "pi",
    },
    proposedContinuation: {
      mode: "queue_followup",
      toolDelta: ["write"],
      reason: "Continue with approved scope.",
    },
    ...overrides,
  };
}
