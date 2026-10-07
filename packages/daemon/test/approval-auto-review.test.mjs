import assert from "node:assert/strict";
import { test } from "node:test";
import { parseApprovalAutoReviewVerdict } from "../dist/features/runs/approval-auto-review-parser.js";
import { systemReviewedApprovalExecutionRejection } from "../dist/features/runs/approvals.js";

test("automatic approval reviewer accepts only the exact verdict JSON contract", () => {
  assert.deepEqual(parseApprovalAutoReviewVerdict(
    '{"schemaVersion":1,"decision":"approve","reason":"Exact scoped command is necessary."}',
  ), {
    ok: true,
    verdict: {
      schemaVersion: 1,
      decision: "approve",
      reason: "Exact scoped command is necessary.",
    },
  });
  assert.equal(parseApprovalAutoReviewVerdict("```json\n{}\n```").ok, false);
  assert.equal(parseApprovalAutoReviewVerdict("approve").ok, false);
  assert.equal(parseApprovalAutoReviewVerdict('{"schemaVersion":1,"decision":"approve","reason":"ok","extra":true}').ok, false);
  assert.equal(parseApprovalAutoReviewVerdict('{"schemaVersion":1,"decision":"maybe","reason":"ok"}').ok, false);
  assert.equal(parseApprovalAutoReviewVerdict('{"schemaVersion":1,"decision":"manual","reason":""}').ok, false);
});

test("system-reviewed approval rechecks policy, active Attempt, and exact side effect before execution", () => {
  const payload = { type: "bash", cwd: "/workspace", command: "npm test", riskFlags: [] };
  const approval = {
    id: "approval-1",
    runId: "run-1",
    taskId: "task-1",
    toolCallId: "tool-1",
    actionType: "bash",
    risk: "medium",
    title: "Run tests",
    description: "npm test",
    payload,
    status: "approved",
    createdAt: "2026-09-12T00:00:00.000Z",
    resolvedAt: "2026-09-12T00:00:01.000Z",
    resolvedBy: "system-reviewer",
  };
  const run = { id: "run-1" };
  const fence = { workUnitId: "unit-1", attemptId: "attempt-1", runtimeInstanceId: "runtime-1", fencingToken: "1" };
  const snapshot = { workspacePolicyUpdatedAt: "2026-09-12T00:00:00.000Z" };
  const store = {
    getApprovalPolicy: () => ({ updatedAt: snapshot.workspacePolicyUpdatedAt }),
    isCurrentRunExecutionOwner: () => true,
  };
  const base = {
    store,
    run,
    approval,
    sourceFence: fence,
    effectivePolicySnapshot: snapshot,
    currentActionType: "bash",
    currentToolCallId: "tool-1",
    currentPayload: payload,
  };
  assert.equal(systemReviewedApprovalExecutionRejection(base), undefined);
  assert.match(systemReviewedApprovalExecutionRejection({
    ...base,
    currentPayload: { ...payload, command: "npm publish" },
  }), /effect_changed/);
  assert.match(systemReviewedApprovalExecutionRejection({
    ...base,
    store: { ...store, getApprovalPolicy: () => ({ updatedAt: "changed" }) },
  }), /policy_changed/);
  assert.match(systemReviewedApprovalExecutionRejection({
    ...base,
    store: { ...store, isCurrentRunExecutionOwner: () => false },
  }), /execution_stale/);
});
