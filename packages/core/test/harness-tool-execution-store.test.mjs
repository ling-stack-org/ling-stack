import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createSqliteRunStore,
  DEFAULT_WORKSPACE_ID,
  digestHarnessToolValue,
  resolveRuntimePaths,
  toRuntimeAttemptFence,
} from "../dist/index.js";

const now = "2026-09-13T00:00:00.000Z";
const later = "2026-09-13T00:01:00.000Z";
const expires = "2026-09-13T00:05:00.000Z";
const expired = "2026-09-13T00:00:30.000Z";
const requestDigest = "a".repeat(64);
const sideEffectFingerprint = "b".repeat(64);
const resultDigest = "c".repeat(64);

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-tool-execution-store-"));
  const f = { cwd, store: createSqliteRunStore(cwd) };
  f.database = new DatabaseSync(resolveRuntimePaths(cwd).databasePath);
  t.after(async () => {
    try { f.database.close(); } catch {}
    try { f.store.close(); } catch {}
    await rm(cwd, { recursive: true, force: true });
  });
  const channel = f.store.createChannel({ name: "Harness", boundPath: cwd }, now);
  const task = f.store.createTask({ channelId: channel.id, title: "Tool", prompt: "Execute safely" }, now);
  f.unit = f.store.createWorkUnit({
    workspaceId: DEFAULT_WORKSPACE_ID,
    kind: "task_run",
    ownerType: "run",
    ownerId: "run-tool-1",
    idempotencyKey: "tool-unit",
    status: "running",
    createdByActor: "system",
    request: {},
    now,
  });
  f.attempt = f.store.createWorkUnitAttempt({
    id: "attempt-tool-1",
    workUnitId: f.unit.id,
    attemptNumber: 1,
    runtimeInstanceId: "runtime-tool-1",
    runnerId: "runner_pi_embedded",
    effectiveRunnerId: "runner_pi_embedded",
    status: "started",
    now,
  });
  f.run = f.store.createRun({
    id: "run-tool-1",
    cwd,
    taskId: task.id,
    workUnitId: f.unit.id,
    providerName: "test",
    providerModel: "fixture",
    taskSnapshot: {},
    providerSnapshot: {},
    requestSnapshot: {},
    contextViewId: "context-tool",
    contextViewCreatedAt: now,
    createdAt: now,
  });
  f.store.linkRunToWorkUnit(f.run.id, f.unit.id, now);
  f.store.markRunRunning(f.run.id, now);
  f.policyArtifact = f.store.createArtifact({
    id: "artifact-policy-tool",
    runId: f.run.id,
    type: "json",
    path: "harness/tool-policy.json",
    sealedPayload: { mode: "workspace_write" },
    createdAt: now,
  });
  f.input = {
    id: "tool-execution-1",
    runId: f.run.id,
    workUnitId: f.unit.id,
    sourceFence: toRuntimeAttemptFence(f.attempt),
    toolCallId: "tool-call-1",
    toolName: "bash",
    executorKind: "bash",
    requestDigest,
    sideEffectFingerprint,
    policySnapshotArtifactId: f.policyArtifact.id,
    approvalState: "allowed",
    sandboxProfileId: "workspace-write",
    now,
  };
  return f;
}

test("prepare is Attempt-fenced and idempotent without weakening immutable inputs", async (t) => {
  const f = await fixture(t);
  const first = f.store.prepareHarnessToolExecution(f.input);
  assert.equal(first.replayed, false);
  assert.equal(first.execution.state, "approved");
  const replay = f.store.prepareHarnessToolExecution(f.input);
  assert.equal(replay.replayed, true);
  assert.equal(replay.execution.id, first.execution.id);
  assert.equal(count(f, "harness_tool_executions"), 1);
  assert.throws(
    () => f.store.prepareHarnessToolExecution({ ...f.input, requestDigest: "d".repeat(64) }),
    hasCode("tool.idempotency_conflict"),
  );
});

test("pending and denied approval never become claimable", async (t) => {
  const f = await fixture(t);
  const approval = f.store.createApprovalRequest({
    runId: f.run.id,
    taskId: f.run.taskId,
    toolCallId: "tool-call-pending",
    actionType: "bash",
    risk: "medium",
    title: "Run command",
    description: "approval",
    payload: { type: "bash", cwd: f.cwd, command: "touch denied", riskFlags: [] },
  }, now);
  const prepared = f.store.prepareHarnessToolExecution({
    ...f.input,
    id: "tool-execution-pending",
    toolCallId: "tool-call-pending",
    approvalId: approval.id,
    approvalState: "approval_pending",
  });
  assert.equal(prepared.execution.state, "approval_pending");
  assert.equal(f.store.claimHarnessToolExecution({
    executionId: prepared.execution.id,
    expectedRevision: 0,
    claimOwner: "daemon",
    claimToken: "claim-pending",
    claimExpiresAt: expires,
    sourceFence: f.input.sourceFence,
    now,
  }).code, "invalid_transition");
  const denied = f.store.denyApprovalRequest(approval.id, { reason: "No" }, later);
  assert.equal(denied.status, "denied");
  const resolved = f.store.resolveHarnessToolApproval({
    executionId: prepared.execution.id,
    expectedRevision: 0,
    approvalId: approval.id,
    nextState: "denied",
    failureCode: "tool.approval_denied",
    resultSummary: { reason: "No" },
    now: later,
  });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.value.executionStartedAt, undefined);
  assert.equal(resolved.value.executionFinishedAt, later);
  assert.equal(count(f, "run_events", "type='host_command_prepared'"), 0);
});

test("approval recovery supersedes the pre-effect execution when a successor Attempt takes ownership", async (t) => {
  const f = await fixture(t);
  const approval = f.store.createApprovalRequest({
    runId: f.run.id,
    taskId: f.run.taskId,
    toolCallId: "tool-call-recovered",
    actionType: "bash",
    risk: "medium",
    title: "Run recovered command",
    description: "approval recovery",
    payload: { type: "bash", cwd: f.cwd, command: "printf recovered", riskFlags: [] },
  }, now);
  const pending = f.store.prepareHarnessToolExecution({
    ...f.input,
    id: "tool-execution-before-restart",
    toolCallId: "tool-call-recovered",
    approvalId: approval.id,
    approvalState: "approval_pending",
  }).execution;
  f.store.approveApprovalRequest(approval.id, { reason: "Approved after restart" }, later);
  const successorAttempt = f.store.createWorkUnitAttempt({
    id: "attempt-tool-recovered",
    workUnitId: f.unit.id,
    attemptNumber: 2,
    runtimeInstanceId: "runtime-tool-recovered",
    runnerId: "runner_pi_embedded",
    effectiveRunnerId: "runner_pi_embedded",
    status: "started",
    now: later,
  });
  const successor = f.store.prepareHarnessToolExecution({
    ...f.input,
    id: "tool-execution-after-restart",
    sourceFence: toRuntimeAttemptFence(successorAttempt),
    toolCallId: "tool-call-recovered",
    approvalId: approval.id,
    approvalState: "allowed",
    supersedesExecutionId: pending.id,
    now: later,
  }).execution;
  assert.equal(successor.state, "approved");
  assert.equal(successor.supersedesExecutionId, pending.id);
  const superseded = f.store.getHarnessToolExecution(pending.id);
  assert.equal(superseded.state, "superseded");
  assert.equal(superseded.failureCode, "tool.stale_attempt");
  assert.equal(superseded.executionStartedAt, undefined);
  assert.equal(superseded.executionFinishedAt, later);
});

test("claim token prevents ABA and successful evidence commit is atomic", async (t) => {
  const f = await fixture(t);
  const prepared = f.store.prepareHarnessToolExecution(f.input);
  const claimed = f.store.claimHarnessToolExecution({
    executionId: prepared.execution.id,
    expectedRevision: 0,
    claimOwner: "daemon",
    claimToken: "claim-1",
    claimExpiresAt: expires,
    sourceFence: f.input.sourceFence,
    now,
  });
  assert.equal(claimed.ok, true);
  assert.equal(f.store.claimHarnessToolExecution({
    executionId: prepared.execution.id,
    expectedRevision: 0,
    claimOwner: "daemon",
    claimToken: "claim-other",
    claimExpiresAt: expires,
    sourceFence: f.input.sourceFence,
    now,
  }).ok, false);
  const started = f.store.startHarnessToolExecution({
    executionId: prepared.execution.id,
    expectedRevision: 1,
    claimOwner: "daemon",
    claimToken: "claim-1",
    sourceFence: f.input.sourceFence,
    now,
  });
  assert.equal(started.ok, true);
  const artifact = f.store.createArtifact({
    id: "artifact-result-tool",
    runId: f.run.id,
    type: "json",
    path: "harness/tool-result.json",
    sealedPayload: { exitCode: 0 },
    createdAt: later,
  });
  const finished = f.store.finishHarnessToolExecution({
    executionId: prepared.execution.id,
    expectedRevision: 2,
    claimOwner: "daemon",
    claimToken: "claim-1",
    sourceFence: f.input.sourceFence,
    nextState: "succeeded",
    resultDigest,
    resultSummary: { status: "succeeded", exitCode: 0 },
    evidenceArtifactIds: [artifact.id],
    now: later,
  });
  assert.equal(finished.ok, true);
  assert.equal(finished.value.state, "succeeded");
  assert.equal(finished.value.revision, 4);
  assert.deepEqual(finished.value.evidenceArtifactIds, [artifact.id]);
  const replay = f.store.finishHarnessToolExecution({
    executionId: prepared.execution.id,
    expectedRevision: 2,
    claimOwner: "daemon",
    claimToken: "claim-1",
    sourceFence: f.input.sourceFence,
    nextState: "succeeded",
    resultDigest,
    resultSummary: { status: "succeeded", exitCode: 0 },
    evidenceArtifactIds: [artifact.id],
    now: later,
  });
  assert.equal(replay.ok, true);
  assert.equal(replay.replayed, true);
});

test("evidence association failure rolls committing_evidence and artifact refs back", async (t) => {
  const f = await fixture(t);
  const prepared = f.store.prepareHarnessToolExecution(f.input);
  assert.equal(f.store.claimHarnessToolExecution({ executionId: prepared.execution.id, expectedRevision: 0,
    claimOwner: "daemon", claimToken: "claim-rollback", claimExpiresAt: expires,
    sourceFence: f.input.sourceFence, now }).ok, true);
  assert.equal(f.store.startHarnessToolExecution({ executionId: prepared.execution.id, expectedRevision: 1,
    claimOwner: "daemon", claimToken: "claim-rollback", sourceFence: f.input.sourceFence, now }).ok, true);
  const artifact = f.store.createArtifact({ id: "artifact-result-rollback", runId: f.run.id, type: "json",
    path: "harness/tool-result-rollback.json", sealedPayload: { exitCode: 0 }, createdAt: later });
  f.database.exec(`
    CREATE TRIGGER reject_tool_evidence
    BEFORE INSERT ON harness_tool_execution_artifacts
    BEGIN SELECT RAISE(ABORT, 'reject tool evidence'); END;
  `);
  assert.throws(() => f.store.finishHarnessToolExecution({
    executionId: prepared.execution.id,
    expectedRevision: 2,
    claimOwner: "daemon",
    claimToken: "claim-rollback",
    sourceFence: f.input.sourceFence,
    nextState: "succeeded",
    resultDigest,
    resultSummary: { status: "succeeded" },
    evidenceArtifactIds: [artifact.id],
    now: later,
  }), /reject tool evidence/u);
  const stored = f.store.getHarnessToolExecution(prepared.execution.id);
  assert.equal(stored.state, "executing");
  assert.equal(stored.revision, 2);
  assert.deepEqual(stored.evidenceArtifactIds, []);
});

test("expired executing claims become unknown_outcome and cannot be blindly retried", async (t) => {
  const f = await fixture(t);
  const prepared = f.store.prepareHarnessToolExecution(f.input);
  assert.equal(f.store.claimHarnessToolExecution({ executionId: prepared.execution.id, expectedRevision: 0,
    claimOwner: "daemon", claimToken: "claim-expired", claimExpiresAt: expired,
    sourceFence: f.input.sourceFence, now }).ok, true);
  assert.equal(f.store.startHarnessToolExecution({ executionId: prepared.execution.id, expectedRevision: 1,
    claimOwner: "daemon", claimToken: "claim-expired", sourceFence: f.input.sourceFence, now }).ok, true);
  const recovered = f.store.reconcileAbandonedHarnessToolExecutions({ now: later });
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].state, "unknown_outcome");
  assert.equal(recovered[0].failureCode, "tool.unknown_side_effect_outcome");
  assert.equal(f.store.claimHarnessToolExecution({ executionId: prepared.execution.id, expectedRevision: 3,
    claimOwner: "daemon", claimToken: "claim-retry", claimExpiresAt: expires,
    sourceFence: f.input.sourceFence, now: later }).code, "invalid_transition");
});

for (const [name, nextState, failureCode] of [
  ["applied", "succeeded", undefined],
  ["not_applied", "failed", "tool.executor_failed"],
  ["diverged", "unknown_outcome", "tool.unknown_side_effect_outcome"],
]) {
  test(`expired claims atomically commit a classifier-proven ${name} outcome`, async (t) => {
    const f = await fixture(t);
    const prepared = f.store.prepareHarnessToolExecution(f.input);
    assert.equal(f.store.claimHarnessToolExecution({ executionId: prepared.execution.id, expectedRevision: 0,
      claimOwner: "daemon", claimToken: `claim-classified-${name}`, claimExpiresAt: expired,
      sourceFence: f.input.sourceFence, now }).ok, true);
    assert.equal(f.store.startHarnessToolExecution({ executionId: prepared.execution.id, expectedRevision: 1,
      claimOwner: "daemon", claimToken: `claim-classified-${name}`,
      sourceFence: f.input.sourceFence, now }).ok, true);
    const artifact = f.store.createArtifact({
      id: `artifact-recovery-${name}`,
      runId: f.run.id,
      type: "json",
      path: `harness/recovery-${name}.json`,
      sealedPayload: { outcome: name },
      createdAt: later,
    });
    const summary = { status: nextState, outcome: name };

    const [recovered] = f.store.reconcileAbandonedHarnessToolExecutions({
      now: later,
      classify: () => ({
        nextState,
        resultDigest: digestHarnessToolValue(summary),
        resultSummary: summary,
        evidenceArtifactIds: [artifact.id],
        ...(failureCode ? { failureCode } : {}),
      }),
    });

    assert.equal(recovered.state, nextState);
    assert.equal(recovered.failureCode, failureCode);
    assert.equal(recovered.resultDigest, digestHarnessToolValue(summary));
    assert.deepEqual(recovered.resultSummary, summary);
    assert.deepEqual(recovered.evidenceArtifactIds, [artifact.id]);
  });
}

test("classifier evidence failure rolls recovery state and artifact refs back together", async (t) => {
  const f = await fixture(t);
  const prepared = f.store.prepareHarnessToolExecution(f.input);
  assert.equal(f.store.claimHarnessToolExecution({ executionId: prepared.execution.id, expectedRevision: 0,
    claimOwner: "daemon", claimToken: "claim-recovery-rollback", claimExpiresAt: expired,
    sourceFence: f.input.sourceFence, now }).ok, true);
  assert.equal(f.store.startHarnessToolExecution({ executionId: prepared.execution.id, expectedRevision: 1,
    claimOwner: "daemon", claimToken: "claim-recovery-rollback",
    sourceFence: f.input.sourceFence, now }).ok, true);
  const artifact = f.store.createArtifact({
    id: "artifact-recovery-rollback",
    runId: f.run.id,
    type: "json",
    path: "harness/recovery-rollback.json",
    sealedPayload: { outcome: "applied" },
    createdAt: later,
  });
  const summary = { status: "succeeded", outcome: "applied" };
  f.database.exec(`
    CREATE TRIGGER reject_recovery_evidence
    BEFORE INSERT ON harness_tool_execution_artifacts
    BEGIN SELECT RAISE(ABORT, 'reject recovery evidence'); END;
  `);

  assert.throws(() => f.store.reconcileAbandonedHarnessToolExecutions({
    now: later,
    classify: () => ({
      nextState: "succeeded",
      resultDigest: digestHarnessToolValue(summary),
      resultSummary: summary,
      evidenceArtifactIds: [artifact.id],
    }),
  }), /reject recovery evidence/u);

  const stored = f.store.getHarnessToolExecution(prepared.execution.id);
  assert.equal(stored.state, "executing");
  assert.equal(stored.revision, 2);
  assert.equal(stored.resultDigest, undefined);
  assert.deepEqual(stored.evidenceArtifactIds, []);
});

test("stale Attempt cannot commit success and is reconciled as unknown", async (t) => {
  const f = await fixture(t);
  const prepared = f.store.prepareHarnessToolExecution(f.input);
  assert.equal(f.store.claimHarnessToolExecution({ executionId: prepared.execution.id, expectedRevision: 0,
    claimOwner: "daemon", claimToken: "claim-stale", claimExpiresAt: expired,
    sourceFence: f.input.sourceFence, now }).ok, true);
  assert.equal(f.store.startHarnessToolExecution({ executionId: prepared.execution.id, expectedRevision: 1,
    claimOwner: "daemon", claimToken: "claim-stale", sourceFence: f.input.sourceFence, now }).ok, true);
  f.store.createWorkUnitAttempt({
    id: "attempt-tool-replacement",
    workUnitId: f.unit.id,
    attemptNumber: 2,
    runtimeInstanceId: "runtime-tool-replacement",
    runnerId: "runner_pi_embedded",
    status: "started",
    now: later,
  });
  assert.equal(f.store.finishHarnessToolExecution({
    executionId: prepared.execution.id,
    expectedRevision: 2,
    claimOwner: "daemon",
    claimToken: "claim-stale",
    sourceFence: f.input.sourceFence,
    nextState: "succeeded",
    resultDigest,
    resultSummary: { status: "succeeded" },
    evidenceArtifactIds: [],
    now: later,
  }).code, "tool.stale_attempt");
  assert.equal(f.store.reconcileAbandonedHarnessToolExecutions({ now: later })[0].state, "unknown_outcome");
});

function count(f, table, where) {
  return f.database.prepare(`SELECT COUNT(*) AS count FROM ${table}${where ? ` WHERE ${where}` : ""}`).get().count;
}

function hasCode(expected) {
  return (error) => error?.code === expected;
}
