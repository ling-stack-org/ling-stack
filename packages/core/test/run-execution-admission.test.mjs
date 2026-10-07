import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, toRuntimeAttemptFence } from "../dist/index.js";
import { SqliteRunSessionStore } from "../dist/storage/sqlite/run-session-store.js";
import { SqliteApprovalRequestStore } from "../dist/storage/sqlite/approval-request-store.js";

const now = "2026-09-07T04:00:00.000Z";
const hostApprovalInput = f => ({ runId: f.run.id, taskId: f.run.taskId, toolCallId: "host-call",
  actionType: "host_capability", risk: "medium", title: "Host approval", description: "Host approval",
  payload: { type: "host_capability", contractVersion: 1, cwd: f.cwd, capabilityId: "host.open_local_target", input: { path: "index.html" } } });

test("execution approval atomically persists its checkpoint under the captured owner", async t => {
  const f = await fixture(t);
  const approval = f.store.createExecutionApprovalRequest(hostApprovalInput(f), f.fence, now);
  assert.equal(approval.runId, f.run.id);
  assert.equal(f.store.getApprovalCheckpointForApproval(approval.id).status, "pending");
});

for (const field of ["attemptId", "runtimeInstanceId", "fencingToken", "workUnitId", "taskId", "channelId"]) {
  test(`execution approval INSERT rejects a foreign ${field} without orphan records`, async t => {
    const f = await fixture(t);
    const input = hostApprovalInput(f);
    const fence = { ...f.fence };
    if (field === "taskId" || field === "channelId") input[field] = "foreign";
    else fence[field] = "foreign";
    assert.throws(() => f.store.createExecutionApprovalRequest(input, fence, now), e => e.code === "stale_run_execution");
    assert.equal(f.store.listApprovalRequests({ runId: f.run.id }).length, 0);
    assert.equal(f.store.listApprovalCheckpoints({ runId: f.run.id }).length, 0);
  });
}

test("execution approval rolls back the INSERT if checkpoint creation fails", async t => {
  const f = await fixture(t);
  const requests = new SqliteApprovalRequestStore({ database: f.store.database }, {
    hasRun: id => Boolean(f.store.getRun(id)), hasMediaJob: () => false, hasExternalWorkAction: () => false, hasWorkflowStep: () => false,
    createApprovalCheckpoint: () => { throw new Error("checkpoint fixture failure"); },
    syncApprovalCheckpointForApproval() {}, rebuildLingThreadMetadataForApproval() { assert.fail("partial approval must not publish"); },
  });
  assert.throws(() => requests.createExecutionApprovalRequest(hostApprovalInput(f), f.fence, now), /checkpoint fixture failure/);
  assert.equal(f.store.listApprovalRequests({ runId: f.run.id }).length, 0);
  assert.equal(f.store.listApprovalCheckpoints({ runId: f.run.id }).length, 0);
  assert.ok(f.store.createExecutionApprovalRequest(hostApprovalInput(f), f.fence, now), "rollback must release its transaction");
});
async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-execution-admission-"));
  const store = createSqliteRunStore(cwd);
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  const unit = store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run", ownerId: "run",
    idempotencyKey: "unit", status: "running", createdByActor: "system", request: {}, now });
  const attempt = store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1, runtimeInstanceId: "original-runtime",
    runnerId: "pi", status: "started", now });
  const run = store.createRun({ id: "run", cwd, workUnitId: unit.id, taskId: "task", providerName: "test", providerModel: "test",
    taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: now });
  store.linkRunToWorkUnit(run.id, unit.id, now);
  store.markRunStarted(run.id, now);
  store.appendEvent(run.id, "run_start", { taskId: run.taskId, cwd, provider: "test", model: "test" });
  const fence = toRuntimeAttemptFence(attempt);
  const replace = (writer = store) => writer.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 2,
    runtimeInstanceId: "new-runtime", runnerId: "pi", status: "started", now });
  return { cwd, store, unit, attempt, run, fence, replace,
    event: () => store.appendExecutionEvent(run.id, fence, "result", { taskId: "task", messageCount: 1, runnerEventCount: 0 }),
    complete: event => store.transitionRunExecutionStatus({ runId: run.id, sourceFence: fence, expectedStatus: "running",
      event, actor: "runner", now, endedAt: now }),
  };
}

test("current execution can append and complete with its captured identity", async t => {
  const f = await fixture(t);
  assert.equal(f.event().type, "result");
  assert.equal(f.complete("runner_succeeded").ok, true);
  assert.equal(f.store.getRun(f.run.id).status, "succeeded");
});

test("provider retry evidence cannot outlive its captured Attempt or reopen a terminal Run", async t => {
  const data = { policyVersion: "pi_sdk_retry_v1", scope: "assistant", phase: "scheduled", retryAttempt: 1,
    maxRetryAttempts: 1, delayMs: 1, errorDiagnostic: { schemaVersion: 1, category: "unknown", basis: "unclassified" } };
  for (const boundary of ["replacement", "terminal", "cancelling"]) {
    const f = await fixture(t);
    assert.equal(f.store.appendExecutionEvent(f.run.id, f.fence, "provider_retry", data).type, "provider_retry");
    if (boundary === "replacement") f.replace();
    else if (boundary === "terminal") assert.equal(f.complete("runner_succeeded").ok, true);
    else {
      f.store.database.prepare("UPDATE work_units SET status='cancelling' WHERE id=?").run(f.unit.id);
      f.store.database.prepare("UPDATE work_unit_attempts SET status='cancelling', abort_requested_at=? WHERE id=?")
        .run(now, f.attempt.id);
    }
    const count = f.store.listEvents(f.run.id).length;
    assert.throws(() => f.store.appendExecutionEvent(f.run.id, f.fence, "provider_retry", data),
      error => error.code === "stale_run_execution");
    assert.equal(f.store.listEvents(f.run.id).length, count);
  }
});

test("compaction lifecycle remains ordered durable evidence and rejects a replaced attempt", async t => {
  const f = await fixture(t);
  const start = f.store.appendExecutionEvent(f.run.id, f.fence, "context_compaction_start", {
    reason: "threshold", policyVersion: "pi_sdk_lifecycle_v1", attemptId: f.attempt.id,
  });
  const end = f.store.appendExecutionEvent(f.run.id, f.fence, "context_compaction_end", {
    reason: "threshold", policyVersion: "pi_sdk_lifecycle_v1", outcome: "sdk_installed",
    willRetry: false, tokensBefore: 1800, estimatedTokensAfter: 400, attemptId: f.attempt.id,
  });
  assert.equal(end.seq, start.seq + 1);
  const reader = createSqliteRunStore(f.cwd);
  try {
    assert.deepEqual(reader.listEvents(f.run.id).slice(-2).map(event => [event.type, event.data.attemptId]), [
      ["context_compaction_start", f.attempt.id], ["context_compaction_end", f.attempt.id],
    ]);
  } finally { reader.close(); }
  f.replace();
  assert.throws(() => f.store.appendExecutionEvent(f.run.id, f.fence, "context_compaction_end", {
    reason: "threshold", policyVersion: "pi_sdk_lifecycle_v1", outcome: "failed", willRetry: false,
    attemptId: f.attempt.id,
  }), error => error.code === "stale_run_execution");
  assert.equal(f.store.countEvents(f.run.id), end.seq);
});

for (const scenario of ["replaced", "yielded", "succeeded", "cancelled", "failed"]) test(`closed or stale owner cannot append or settle: ${scenario}`, async t => {
  const f = await fixture(t);
  if (scenario === "replaced") f.replace();
  else if (scenario === "yielded") f.store.transitionRunStatus({ runId: f.run.id, expectedStatus: "running", event: "runner_yielded", actor: "system", now });
  else f.store.database.prepare("UPDATE run_sessions SET status=? WHERE id=?").run(scenario, f.run.id);
  const before = f.store.getRun(f.run.id);
  const eventFile = await readFile(f.run.eventLogPath, "utf8");
  assert.throws(f.event, error => error.code === "stale_run_execution");
  assert.equal(f.complete("runner_failed").ok, false);
  assert.deepEqual(f.store.getRun(f.run.id), before);
  assert.equal(await readFile(f.run.eventLogPath, "utf8"), eventFile);
  assert.equal(f.store.countEvents(f.run.id), 1);
});

for (const field of ["attemptId", "workUnitId", "runtimeInstanceId", "fencingToken"]) test(`execution admission rejects a forged ${field}`, async t => {
  const f = await fixture(t);
  const fence = { ...f.fence, [field]: "foreign" };
  assert.equal(f.store.isCurrentRunExecutionOwner(f.run.id, fence), false);
  assert.throws(() => f.store.appendExecutionEvent(f.run.id, fence, "run_error", { message: "forged" }), error => error.code === "stale_run_execution");
  assert.equal(f.store.transitionRunExecutionStatus({ runId: f.run.id, sourceFence: fence, event: "runner_failed", actor: "runner", now }).ok, false);
});

test("replacement during payload normalization is rejected at SQL INSERT before touching event file", async t => {
  const f = await fixture(t);
  const before = await readFile(f.run.eventLogPath, "utf8");
  let replaced = false;
  const payload = { get taskId() { if (!replaced) { replaced = true; f.replace(); } return "task"; }, messageCount: 1, runnerEventCount: 0 };
  assert.throws(() => f.store.appendExecutionEvent(f.run.id, f.fence, "result", payload), error => error.code === "stale_run_execution");
  assert.equal(replaced, true);
  assert.equal(await readFile(f.run.eventLogPath, "utf8"), before);
  assert.equal(f.store.countEvents(f.run.id), 1);
});

test("another connection replaces the owner between completion precheck and SQL UPDATE", async t => {
  const f = await fixture(t);
  const writer = createSqliteRunStore(f.cwd);
  try {
    let replaced = false;
    const sessions = new SqliteRunSessionStore({ database: f.store.database }, f.store.paths, {
      findStateTransitionByIdempotency() { replaced = true; f.replace(writer); },
      recordStateTransitionEvent() { assert.fail("stale transition must not publish"); },
      reconcileLingTurnStatusForRun() { assert.fail("stale transition must not project"); },
      rebuildLingThreadMetadata() { assert.fail("stale transition must not invalidate"); },
    });
    const result = sessions.transitionRunExecutionStatus({ runId: f.run.id, sourceFence: f.fence, event: "runner_succeeded",
      actor: "runner", now, endedAt: now, idempotencyKey: "race" });
    assert.equal(replaced, true);
    assert.equal(result.ok, false);
    assert.equal(f.store.getRun(f.run.id).status, "running");
  } finally { writer.close(); }
});

test("timeout cleanup may record failure but cannot start new tools or succeed", async t => {
  const f = await fixture(t);
  f.store.database.prepare("UPDATE work_units SET status='cancelling' WHERE id=?").run(f.unit.id);
  f.store.database.prepare("UPDATE work_unit_attempts SET status='cancelling', abort_requested_at=? WHERE id=?").run(now, f.attempt.id);
  assert.equal(f.store.isCurrentRunExecutionOwner(f.run.id, f.fence), false);
  assert.equal(f.store.isCurrentRunExecutionOwner(f.run.id, f.fence, true), true);
  assert.throws(() => f.store.appendExecutionEvent(f.run.id, f.fence, "tool_start", { toolCallId: "late", toolName: "bash", args: {} }));
  assert.equal(f.complete("runner_succeeded").ok, false);
  assert.equal(f.store.appendExecutionEvent(f.run.id, f.fence, "run_error", { message: "hard_timeout" }).type, "run_error");
  assert.equal(f.complete("runner_failed").ok, true);
});

test("an unlinked source run cannot borrow the current work unit identity", async t => {
  const f = await fixture(t);
  f.store.database.prepare("UPDATE work_units SET linked_run_id=NULL WHERE id=?").run(f.unit.id);
  assert.throws(f.event, error => error.code === "stale_run_execution");
  assert.equal(f.complete("runner_failed").ok, false);
});
