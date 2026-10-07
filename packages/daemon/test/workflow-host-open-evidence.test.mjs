import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSqliteRunStore, toRuntimeAttemptFence, createApprovalResumeBasisV1,
  approvalSideEffectFingerprintV1,
} from "@ling-stack/core";
import { createTypedWorkflowBasis, typedOperation } from "./support/workflow-operation-gate-fixture.mjs";
import { listAllExecutionActionsForRun } from "../dist/features/runs/execution-actions.js";
import { verifyWorkflowStepExecutionOperations } from "../dist/features/channels/workflow-operation-evidence.js";

// Durable protocol fixtures, not an OS opener, model, or GUI validation.
async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-host-open-evidence-"));
  const store = createSqliteRunStore(cwd);
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  const now = new Date().toISOString();
  const operation = typedOperation("open_local_target", "index.html", "open");
  operation.binding.inputRefs = [{ path: "index.html", sourceRefs: operation.binding.sourceRefs }];
  operation.binding.effectScope.readPaths = ["index.html"];
  const basis = createTypedWorkflowBasis(store, cwd, [operation], now);
  const task = store.createTask({ channelId: basis.channel.id, title: "Open evidence fixture", prompt: "Open index.html" }, now);
  const unit = store.createWorkUnit({ id: "open-unit", workspaceId: "workspace_default", kind: "task_run", ownerType: "run",
    ownerId: "open-run", taskId: task.id, runnerId: "pi", effectiveRunnerId: "pi", idempotencyKey: "open-unit",
    status: "running", createdByActor: "system", request: {}, now });
  const attempt = store.createWorkUnitAttempt({ id: "open-attempt", workUnitId: unit.id, attemptNumber: 1,
    runtimeInstanceId: "open-runtime", runnerId: "pi", effectiveRunnerId: "pi", status: "started", now });
  const fence = toRuntimeAttemptFence(attempt);
  const run = store.createRun({ id: "open-run", cwd, taskId: task.id, workUnitId: unit.id, channelId: basis.channel.id,
    teammateId: basis.step.toParticipantId, workflowStepId: basis.step.id, providerName: "fixture", providerModel: "fixture",
    taskSnapshot: task, providerSnapshot: {}, requestSnapshot: { cwd, workflowOperationExecution: basis.snapshot,
      delegatedRequirement: basis.requirement }, createdAt: now });
  store.linkRunToWorkUnit(run.id, unit.id, now);
  store.markRunStarted(run.id, now);
  store.updateChannelWorkflowStep(basis.step.id, { runId: run.id, taskId: task.id }, now);
  const toolCallId = "open-call";
  const payload = { type: "host_capability", contractVersion: 1, capabilityId: "host.open_local_target", cwd, input: { path: "index.html" } };
  const approval = store.createExecutionApprovalRequest({ runId: run.id, taskId: task.id, channelId: basis.channel.id,
    toolCallId, actionType: "host_capability", risk: "medium", title: "Open", description: "Fixture only", payload }, fence, now);
  const checkpoint = store.getApprovalCheckpointForApproval(approval.id);
  store.updateApprovalCheckpointStatus(checkpoint.id, { status: checkpoint.status, expectedRevision: checkpoint.revision,
    resumeBasis: createApprovalResumeBasisV1({ approvalId: approval.id, runId: run.id, workUnitId: unit.id,
      priorAttemptId: attempt.id, workflowStepId: basis.step.id, toolCallId, actionType: "host_capability",
      sideEffectFingerprint: approvalSideEffectFingerprintV1({ actionType: "host_capability", toolCallId, sideEffect: payload }) }) }, now);
  store.approveApprovalRequest(approval.id, {}, now);
  const receipt = { contractVersion: 1, capabilityId: "host.open_local_target", status: "launched", path: "index.html",
    runId: run.id, attemptId: attempt.id, toolCallId, approvalId: approval.id, receiptId: "fixture-open-receipt",
    launchedAt: new Date().toISOString(), visibility: "unverified" };
  const emit = (type, data = {}) => store.appendExecutionEvent(run.id, fence, type,
    { toolCallId, toolName: "host_open_local_target", attemptId: attempt.id, ...data });
  return { cwd, store, ...basis, run, attempt, fence, approval, receipt, emit,
    verify: () => verifyWorkflowStepExecutionOperations({ store, step: store.getChannelWorkflowStep(basis.step.id), now: new Date().toISOString() }),
    actions: () => listAllExecutionActionsForRun(store, run.id) };
}

test("typed open accepts a scoped Host launch receipt, not a Bash exit, and survives SQLite reopen", async t => {
  const f = await fixture(t);
  f.emit("tool_start", { args: { path: "index.html" } });
  f.emit("tool_end", { isError: false, result: { content: [{ type: "text", text: "Launch accepted; window visibility unverified." }],
    details: { hostCapabilityResult: f.receipt } } });
  const actions = f.actions();
  assert.equal(actions.length, 1);
  assert.equal(actions[0].actionType, "host_capability");
  assert.equal(actions[0].status, "succeeded");
  assert.deepEqual(actions[0].hostOpenReceipt, f.receipt);
  assert.equal(actions[0].commandEvidence, undefined);
  assert.equal(f.verify().status, "verified");
  assert.deepEqual(f.verify().operationResults[0].evidenceActionIds, [actions[0].id]);
  f.store.close();
  const reopened = createSqliteRunStore(f.cwd);
  try {
    assert.deepEqual(listAllExecutionActionsForRun(reopened, f.run.id), actions);
    assert.equal(verifyWorkflowStepExecutionOperations({ store: reopened, step: reopened.getChannelWorkflowStep(f.step.id),
      now: new Date().toISOString() }).status, "verified");
  } finally { reopened.close(); }
});

for (const scenario of ["narration-only", "queued", "missing-start", "foreign-path", "foreign-run", "foreign-attempt",
  "foreign-call", "foreign-approval", "no-receipt-id", "invalid-date", "invented-visibility", "unknown-field", "tool-error", "wrong-end-tool"]) {
  test("typed open rejects " + scenario + " as launch evidence", async t => {
    const f = await fixture(t);
    if (scenario !== "missing-start") f.emit("tool_start", { args: { path: "index.html" } });
    const result = structuredClone(f.receipt);
    if (scenario === "queued") result.status = "queued";
    if (scenario === "foreign-path") result.path = "another.html";
    if (scenario === "foreign-run") result.runId = "other";
    if (scenario === "foreign-attempt") result.attemptId = "other";
    if (scenario === "foreign-call") result.toolCallId = "other";
    if (scenario === "foreign-approval") result.approvalId = "other";
    if (scenario === "no-receipt-id") delete result.receiptId;
    if (scenario === "invalid-date") result.launchedAt = "yesterday";
    if (scenario === "invented-visibility") result.visibility = "visible";
    if (scenario === "unknown-field") result.command = "open index.html";
    f.emit("tool_end", { isError: scenario === "tool-error",
      ...(scenario === "wrong-end-tool" ? { toolName: "read" } : {}),
      result: { content: [{ type: "text", text: "I opened index.html, exit 0." }],
        ...(scenario === "narration-only" ? {} : { details: { hostCapabilityResult: result } }) } });
    assert.equal(f.actions().some(action => action.hostOpenReceipt !== undefined), false);
    assert.notEqual(f.verify().status, "verified");
  });
}

test("a successful shell open cannot substitute for the required Host capability", async t => {
  const f = await fixture(t);
  f.emit("tool_start", { toolCallId: "bash-open", toolName: "bash", args: { command: "open index.html" } });
  f.emit("tool_end", { toolCallId: "bash-open", toolName: "bash", isError: false,
    result: { exitCode: 0, stdout: "", stderr: "", timedOut: false, cancelled: false } });
  assert.notEqual(f.verify().status, "verified");
});

test("duplicate terminal events cannot replace an unconfirmed open with a late launch receipt", async t => {
  const f = await fixture(t);
  f.emit("tool_start", { args: { path: "index.html" } });
  f.emit("tool_end", { isError: false, result: { content: [{ type: "text", text: "Queued only" }] } });
  f.emit("tool_end", { isError: false, result: { details: { hostCapabilityResult: f.receipt } } });
  assert.equal(f.actions().some(action => action.hostOpenReceipt !== undefined), false);
  assert.notEqual(f.verify().status, "verified");
});

test("late tool updates cannot change the Attempt of an accepted Host launch receipt", async t => {
  const f = await fixture(t);
  f.emit("tool_start", { args: { path: "index.html" } });
  f.emit("tool_end", { isError: false, result: { details: { hostCapabilityResult: f.receipt } } });
  f.emit("tool_update", { attemptId: "foreign-late-attempt", partialResult: { content: [{ type: "text", text: "late" }] } });
  assert.equal(f.actions()[0].attemptId, f.attempt.id);
  assert.equal(f.verify().status, "verified");
});

for (const field of ["payload", "status", "channelId", "taskId", "toolCallId"]) {
  test("Host launch receipt cannot borrow an approval with changed " + field, async t => {
    const f = await fixture(t);
    f.emit("tool_start", { args: { path: "index.html" } });
    f.emit("tool_end", { isError: false, result: { details: { hostCapabilityResult: f.receipt } } });
    const read = f.store.getApprovalRequest.bind(f.store);
    f.store.getApprovalRequest = id => {
      const approval = read(id);
      if (!approval || id !== f.approval.id) return approval;
      return { ...approval, [field]: field === "payload" ? { ...approval.payload, input: { path: "other.html" } }
        : field === "status" ? "denied" : "foreign" };
    };
    assert.equal(f.actions().some(action => action.hostOpenReceipt !== undefined), false);
    assert.notEqual(f.verify().status, "verified");
  });
}

test("another active Attempt cannot complete its operation using the old launch receipt", async t => {
  const f = await fixture(t);
  f.emit("tool_start", { args: { path: "index.html" } });
  f.emit("tool_end", { isError: false, result: { details: { hostCapabilityResult: f.receipt } } });
  assert.equal(f.verify().status, "verified");
  const other = createSqliteRunStore(f.cwd);
  try {
    other.createWorkUnitAttempt({ workUnitId: f.run.workUnitId, attemptNumber: 2, runtimeInstanceId: "successor-runtime",
      runnerId: "pi", effectiveRunnerId: "pi", status: "started", now: new Date().toISOString() });
  } finally { other.close(); }
  assert.deepEqual(f.actions()[0].hostOpenReceipt, f.receipt, "the historical action remains inspectable");
  assert.notEqual(f.verify().status, "verified", "the successor still needs its own evidence");
});

test("unavailable checkpoint or atomic read support cannot produce a trusted launch receipt", async t => {
  const f = await fixture(t);
  f.emit("tool_start", { args: { path: "index.html" } });
  f.emit("tool_end", { isError: false, result: { details: { hostCapabilityResult: f.receipt } } });
  f.store.getApprovalCheckpointForApproval = () => undefined;
  assert.equal(f.actions().some(action => action.hostOpenReceipt !== undefined), false);
  assert.notEqual(f.verify().status, "verified");
});
