import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  approvalSideEffectFingerprintV1,
  createApprovalResumeBasisV1,
  createSqliteRunStore,
} from "../../core/dist/index.js";
import { ApprovalResumeCoordinator } from "../dist/features/runs/approval-resume-coordinator.js";
import { ActiveRunRegistry } from "../dist/runtime/active-runs.js";

test("resume_pending before tool_start replaces the lost attempt and executes exactly once", async () => {
  const fixture = await createResumeFixture("before-tool-start", "printf x >> resume-count.txt");
  try {
    claimResume(fixture, "attempt_bound_before_start");
    const coordinator = createCoordinator(new ActiveRunRegistry());
    coordinator.registerStore(fixture.store);

    await waitForCondition(() => fixture.store.getRun(fixture.run.id)?.status === "succeeded", "resume should succeed");
    assert.equal(await readFile(resolve(fixture.cwd, "resume-count.txt"), "utf8"), "x");
    const attempts = fixture.store.listWorkUnitAttempts(fixture.workUnit.id);
    assert.deepEqual(attempts.map((attempt) => attempt.status), ["lost", "lost", "succeeded"]);
    assert.equal(matchingToolEvents(fixture).filter((event) => event.type === "tool_start").length, 1);
    assert.equal(fixture.store.getApprovalCheckpoint(fixture.checkpoint.id)?.status, "resumed");
    assert.equal(fixture.store.listRuntimeEvents(fixture.workUnit.id, { limit: 100 }).some((event) =>
      event.type === "semaphore_acquired" && event.attemptId === attempts.at(-1)?.id), true);
    assert.equal(fixture.store.listRuntimeSemaphoreSlots({ workUnitId: fixture.workUnit.id, status: "active" }).length, 0);
    assert.equal(fixture.store.listResourceLeases({ workUnitId: fixture.workUnit.id, status: "active" }).length, 0);
  } finally {
    await fixture.close();
  }
});

test("legacy resume_pending without its bound Attempt repairs the bound identity once", async () => {
  const fixture = await createResumeFixture("missing-bound-attempt", "printf x >> resume-count.txt");
  try {
    const missingAttemptId = "attempt_missing_bound_identity";
    const checkpoint = fixture.store.updateApprovalCheckpointStatus(fixture.checkpoint.id, {
      status: "resume_pending",
      expectedStatus: "approved",
      expectedRevision: fixture.checkpoint.revision,
      runnerResumeHandle: {
        kind: "ling_continuation",
        runnerId: "pi",
        runId: fixture.run.id,
        attemptId: missingAttemptId,
        verified: true,
        payload: { schemaVersion: 1, approvalId: fixture.approval.id },
      },
    }, "2026-08-16T02:02:00.000Z");
    assert.equal(checkpoint?.status, "resume_pending");
    assert.equal(fixture.store.getWorkUnitAttempt(missingAttemptId), undefined);

    createCoordinator(new ActiveRunRegistry()).registerStore(fixture.store);
    await waitForCondition(() => fixture.store.getRun(fixture.run.id)?.status === "succeeded", "missing Attempt repair should finish");
    assert.equal(await readFile(resolve(fixture.cwd, "resume-count.txt"), "utf8"), "x");
    const attempts = fixture.store.listWorkUnitAttempts(fixture.workUnit.id);
    assert.deepEqual(attempts.map((attempt) => attempt.id), [fixture.priorAttempt.id, missingAttemptId]);
    assert.deepEqual(attempts.map((attempt) => attempt.status), ["lost", "succeeded"]);
  } finally {
    await fixture.close();
  }
});

test("invalid resume lineage quarantines only the checkpoint and emits an approval invalidation", async () => {
  const fixture = await createResumeFixture("lineage-quarantine", "printf x >> must-not-run.txt");
  try {
    fixture.store.database.prepare("UPDATE approval_checkpoints SET resume_basis_json = NULL WHERE id = ?")
      .run(fixture.checkpoint.id);
    const published = [];
    const coordinator = new ApprovalResumeCoordinator({
      activeRuns: new ActiveRunRegistry(),
      runnerRegistry: resumeRunnerRegistry(),
      runtimeSupervisor: {
        getRuntime() {
          return { runtimeInstanceId: "runtime_after_restart" };
        },
      },
      controlPlaneEvents: { publish(event) { published.push(event); } },
    });

    const result = coordinator.resumeAfterApproval({ store: fixture.store, approval: fixture.approval });
    assert.deepEqual(result, {
      status: "blocked",
      runId: fixture.run.id,
      reason: "approval_resume_checkpoint_missing",
    });
    assert.equal(fixture.store.getApprovalCheckpoint(fixture.checkpoint.id)?.status, "resume_failed");
    assert.equal(fixture.store.getRun(fixture.run.id)?.status, "waiting_for_approval");
    assert.equal(fixture.store.getWorkUnit(fixture.workUnit.id)?.status, "waiting_for_approval");
    assert.equal(fixture.store.getWorkUnitAttempt(fixture.priorAttempt.id)?.status, "waiting_for_approval");
    assert.deepEqual(published.map((event) => [event.domain, event.action]), [["approvals", "approval.resume_blocked"]]);
    await assert.rejects(() => readFile(resolve(fixture.cwd, "must-not-run.txt"), "utf8"), /ENOENT/u);
  } finally {
    await fixture.close();
  }
});

test("resume_pending with tool_start but no tool_end blocks effect-unknown and never retries", async () => {
  const fixture = await createResumeFixture("effect-unknown", "printf x >> must-not-run.txt");
  try {
    const claimed = claimResume(fixture, "attempt_effect_unknown");
    appendResumeToolStart(fixture, claimed.attempt.id);
    const coordinator = createCoordinator(new ActiveRunRegistry());
    coordinator.registerStore(fixture.store);

    await waitForCondition(() => fixture.store.getRun(fixture.run.id)?.status === "failed", "effect unknown should fail closed");
    const checkpoint = fixture.store.getApprovalCheckpoint(fixture.checkpoint.id);
    assert.equal(checkpoint?.status, "resume_failed");
    assert.equal(checkpoint?.resumeFailureReason, "approval_resume_effect_unknown");
    await assert.rejects(() => readFile(resolve(fixture.cwd, "must-not-run.txt"), "utf8"), /ENOENT/u);
    assert.equal(fixture.store.listWorkUnitAttempts(fixture.workUnit.id).length, 2);
    assert.equal(matchingToolEvents(fixture).filter((event) => event.type === "tool_end").length, 0);

    createCoordinator(new ActiveRunRegistry()).registerStore(fixture.store);
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    assert.equal(fixture.store.listWorkUnitAttempts(fixture.workUnit.id).length, 2);
  } finally {
    await fixture.close();
  }
});

test("resume_pending with tool_end finalizes durable evidence without executing again", async () => {
  const fixture = await createResumeFixture("after-tool-end", "printf x >> resume-count.txt");
  try {
    const claimed = claimResume(fixture, "attempt_after_tool_end");
    await writeFile(resolve(fixture.cwd, "resume-count.txt"), "x", "utf8");
    appendResumeToolStart(fixture, claimed.attempt.id);
    fixture.store.appendEvent(fixture.run.id, "tool_end", {
      type: "tool_end",
      toolCallId: fixture.approval.toolCallId,
      toolName: "bash",
      result: { content: [{ type: "text", text: "persisted result" }], isError: false },
      isError: false,
      resumedFromApprovalId: fixture.approval.id,
      attemptId: claimed.attempt.id,
    });
    createCoordinator(new ActiveRunRegistry()).registerStore(fixture.store);

    await waitForCondition(() => fixture.store.getRun(fixture.run.id)?.status === "succeeded", "durable tool_end should finalize");
    assert.equal(await readFile(resolve(fixture.cwd, "resume-count.txt"), "utf8"), "x");
    assert.equal(fixture.store.listWorkUnitAttempts(fixture.workUnit.id).length, 2);
    assert.equal(fixture.store.getApprovalCheckpoint(fixture.checkpoint.id)?.status, "resumed");
  } finally {
    await fixture.close();
  }
});

test("a second runtime suspension before tool_start preserves resume_pending and later recovers", async () => {
  const fixture = await createResumeFixture("second-suspend-before-start", "printf x >> resume-count.txt");
  try {
    const firstActiveRuns = new ActiveRunRegistry();
    const firstCoordinator = createCoordinator(firstActiveRuns);
    const started = firstCoordinator.resumeAfterApproval({ store: fixture.store, approval: fixture.approval });
    assert.equal(started.status, "started");
    firstActiveRuns.suspendAll("daemon_restart");
    await firstActiveRuns.waitForIdle();

    assert.equal(fixture.store.getRun(fixture.run.id)?.status, "running");
    assert.equal(fixture.store.getWorkUnit(fixture.workUnit.id)?.status, "running");
    assert.equal(fixture.store.getApprovalCheckpoint(fixture.checkpoint.id)?.status, "resume_pending");
    assert.equal(matchingToolEvents(fixture).filter((event) => event.type === "tool_start").length, 0);

    createCoordinator(new ActiveRunRegistry()).registerStore(fixture.store);
    await waitForCondition(() => fixture.store.getRun(fixture.run.id)?.status === "succeeded", "third attempt should recover");
    assert.equal(await readFile(resolve(fixture.cwd, "resume-count.txt"), "utf8"), "x");
    assert.deepEqual(
      fixture.store.listWorkUnitAttempts(fixture.workUnit.id).map((attempt) => attempt.status),
      ["lost", "lost", "succeeded"],
    );
  } finally {
    await fixture.close();
  }
});

test("a second runtime suspension after tool_start records effect-unknown instead of cancellation", async () => {
  const fixture = await createResumeFixture("second-suspend-after-start", "sleep 30; printf x >> uncertain.txt");
  try {
    const activeRuns = new ActiveRunRegistry();
    const coordinator = createCoordinator(activeRuns);
    const started = coordinator.resumeAfterApproval({ store: fixture.store, approval: fixture.approval });
    assert.equal(started.status, "started");
    await waitForCondition(
      () => matchingToolEvents(fixture).some((event) => event.type === "tool_start"),
      "resumed tool_start should be durable",
    );
    activeRuns.suspendAll("daemon_restart");
    await activeRuns.waitForIdle();

    const run = fixture.store.getRun(fixture.run.id);
    const checkpoint = fixture.store.getApprovalCheckpoint(fixture.checkpoint.id);
    assert.equal(run?.status, "failed");
    assert.equal(checkpoint?.status, "resume_failed");
    assert.equal(checkpoint?.resumeFailureReason, "approval_resume_effect_unknown");
    assert.equal(fixture.store.listEvents(fixture.run.id, { limit: 1_000 }).some((event) => event.type === "run_cancelled"), false);
    assert.equal(fixture.store.listEvents(fixture.run.id, { limit: 1_000 }).some((event) => event.type === "approval_cancelled"), false);
  } finally {
    await fixture.close();
  }
});

function createCoordinator(activeRuns) {
  return new ApprovalResumeCoordinator({
    activeRuns,
    runnerRegistry: resumeRunnerRegistry(),
    runtimeSupervisor: {
      getRuntime() {
        return { runtimeInstanceId: "runtime_after_restart" };
      },
    },
  });
}

function resumeRunnerRegistry() {
  const runner = {
    id: "pi",
    displayName: "Pi",
    status: "enabled",
    adapter: { async runTask() { return { taskId: "unused", events: [], messages: [] }; } },
    resumeCapabilities: { nativeResume: false, hostApprovalContinuation: ["bash"] },
  };
  return {
    get(id) { return id === "pi" ? runner : undefined; },
    list() { return [runner]; },
    resolve() { return { runner, requestedRunnerId: "pi", effectiveRunnerId: "pi" }; },
  };
}

function claimResume(fixture, attemptId) {
  const result = fixture.store.commitApprovalResumeClaim({
    checkpointId: fixture.checkpoint.id,
    expectedCheckpointStatus: "approved",
    expectedCheckpointRevision: fixture.checkpoint.revision,
    approvalId: fixture.approval.id,
    runId: fixture.run.id,
    workUnitId: fixture.workUnit.id,
    expectedActiveAttemptId: fixture.priorAttempt.id,
    attemptToLoseId: fixture.priorAttempt.id,
    replacementAttempt: {
      id: attemptId,
      workUnitId: fixture.workUnit.id,
      attemptNumber: 2,
      runtimeInstanceId: "runtime_claimed",
      runnerId: "pi",
      effectiveRunnerId: "pi",
      now: "2026-08-16T02:02:00.000Z",
    },
    runnerResumeHandle: {
      kind: "ling_continuation",
      runnerId: "pi",
      runId: fixture.run.id,
      attemptId,
      verified: true,
      payload: { schemaVersion: 1, approvalId: fixture.approval.id },
    },
    mode: "activate_waiting",
    now: "2026-08-16T02:02:00.000Z",
  });
  assert.equal(result.ok, true);
  return result;
}

function appendResumeToolStart(fixture, attemptId) {
  fixture.store.appendEvent(fixture.run.id, "tool_start", {
    type: "tool_start",
    toolCallId: fixture.approval.toolCallId,
    toolName: "bash",
    args: { command: fixture.command, cwd: fixture.cwd },
    resumedFromApprovalId: fixture.approval.id,
    attemptId,
  });
}

function matchingToolEvents(fixture) {
  return fixture.store.listEvents(fixture.run.id, { limit: 1_000 }).filter((event) => {
    const data = event.data && typeof event.data === "object" ? event.data : {};
    return data.resumedFromApprovalId === fixture.approval.id;
  });
}

async function createResumeFixture(suffix, command) {
  const cwd = await mkdtemp(resolve(tmpdir(), `ling-stack-approval-resume-recovery-${suffix}-`));
  const store = createSqliteRunStore(cwd);
  const now = "2026-08-16T02:00:00.000Z";
  const run = store.createRun({
    id: `run_resume_recovery_${suffix}`,
    cwd,
    taskId: `task_resume_recovery_${suffix}`,
    providerName: "test-provider",
    providerModel: "test-model",
    taskSnapshot: { id: `task_resume_recovery_${suffix}`, title: "Resume recovery", prompt: "Resume safely" },
    providerSnapshot: { provider: "test-provider", model: "test-model" },
    requestSnapshot: { cwd },
    createdAt: now,
  });
  store.markRunStarted(run.id, now);
  const workUnit = store.createWorkUnit({
    id: `work_unit_resume_recovery_${suffix}`,
    workspaceId: "workspace_default",
    kind: "task_run",
    ownerType: "run",
    ownerId: run.id,
    taskId: run.taskId,
    runnerId: "pi",
    effectiveRunnerId: "pi",
    idempotencyKey: `resume-recovery-${suffix}`,
    createdByActor: "system",
    request: { runId: run.id },
    linkedRunId: run.id,
    now,
  });
  const priorAttempt = store.createWorkUnitAttempt({
    id: `attempt_resume_recovery_${suffix}_1`,
    workUnitId: workUnit.id,
    attemptNumber: 1,
    runtimeInstanceId: "runtime_before_restart",
    runnerId: "pi",
    effectiveRunnerId: "pi",
    now,
  });
  store.linkRunToWorkUnit(run.id, workUnit.id, now);
  const priorFence = {
    workUnitId: workUnit.id,
    attemptId: priorAttempt.id,
    runtimeInstanceId: priorAttempt.runtimeInstanceId,
    fencingToken: priorAttempt.fencingToken,
  };
  store.transitionWorkUnitStatus({ ...priorFence, activeAttemptId: priorAttempt.id, expectedStatus: "queued", event: "claim", actor: "system", now });
  store.transitionWorkUnitStatus({ ...priorFence, expectedStatus: "claimed", event: "runner_started", actor: "runner", now });
  store.transitionWorkUnitStatus({ ...priorFence, expectedStatus: "running", event: "approval_requested", actor: "system", now });
  store.updateWorkUnitAttemptStatus({ ...priorFence, status: "waiting_for_approval", now });
  store.transitionRunStatus({ runId: run.id, expectedStatus: "running", event: "approval_requested", actor: "system", now });
  const payload = { type: "bash", cwd, command, riskFlags: [] };
  const approval = store.createApprovalRequest({
    runId: run.id,
    taskId: run.taskId,
    toolCallId: `tool_resume_recovery_${suffix}`,
    actionType: "bash",
    risk: "medium",
    title: "Approve resume recovery",
    description: command,
    payload,
  }, now);
  const initialCheckpoint = store.getApprovalCheckpointForApproval(approval.id);
  assert.ok(initialCheckpoint);
  const resumeBasis = createApprovalResumeBasisV1({
    approvalId: approval.id,
    runId: run.id,
    workUnitId: workUnit.id,
    priorAttemptId: priorAttempt.id,
    toolCallId: approval.toolCallId,
    actionType: approval.actionType,
    sideEffectFingerprint: approvalSideEffectFingerprintV1({
      actionType: approval.actionType,
      toolCallId: approval.toolCallId,
      sideEffect: payload,
    }),
  });
  assert.ok(store.updateApprovalCheckpointStatus(initialCheckpoint.id, {
    status: "pending",
    expectedStatus: "pending",
    expectedRevision: initialCheckpoint.revision,
    resumeBasis,
  }, now));
  const approved = store.approveApprovalRequest(approval.id, { reason: "resume recovery" }, "2026-08-16T02:01:00.000Z");
  assert.equal(approved?.status, "approved");
  const checkpoint = store.getApprovalCheckpointForApproval(approval.id);
  return {
    cwd,
    command,
    store,
    run: store.getRun(run.id),
    workUnit: store.getWorkUnit(workUnit.id),
    priorAttempt: store.getWorkUnitAttempt(priorAttempt.id),
    approval: approved,
    checkpoint,
    async close() {
      store.close();
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

async function waitForCondition(predicate, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  assert.fail(message);
}
