import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { DaemonRunnerRecoveryCoordinator } from "../dist/features/harness/continuations/daemon-recovery-coordinator.js";
import { readStoredRunnerExecution } from "../dist/features/runs/existing-run-request.js";
import { createQueuedAdmissionFixture } from "./test-support/recovery-queued-admission-fixture.mjs";

const recoveryCases = ["todo", "virtual"].flatMap(taskMode =>
  [false, true].map(replaceSourceAttempt => ({ taskMode, replaceSourceAttempt })));
for (const { taskMode, replaceSourceAttempt } of recoveryCases) {
  test(`production queued ${taskMode} Task is recovered${replaceSourceAttempt ? " after the source gets a newer Attempt" : " through its existing prepared Attempt"}`, async (t) => {
    const fixture = await createQueuedAdmissionFixture(t, taskMode);
    t.diagnostic(JSON.stringify(fixture.admissionFacts));
    assert.equal(fixture.admissionFacts.targetKind, "task_run");
    assert.equal(fixture.admissionFacts.targetThreadKind, "task");
    assert.equal(fixture.admissionFacts.targetTaskStatus, taskMode === "todo" ? "todo" : "absent");
    assert.equal(fixture.admissionFacts.parentMatchesSource, true);
    assert.ok(readStoredRunnerExecution(fixture.targetRun), "fixture must match the canonical production Task input");
    if (replaceSourceAttempt) {
      const replacement = fixture.store.createWorkUnitAttempt({ workUnitId: fixture.sourceUnit.id, attemptNumber: 2,
        runtimeInstanceId: fixture.runtime.runtimeInstanceId, runnerId: "pi", status: "succeeded", now: new Date().toISOString() });
      assert.equal(fixture.store.getWorkUnit(fixture.sourceUnit.id).activeAttemptId, replacement.id);
      assert.notEqual(replacement.id, fixture.continuation.sourceAttemptId);
    }
    const dispatches = [];
    const coordinator = new DaemonRunnerRecoveryCoordinator({ runtimeSupervisor: fixture.supervisor,
      activeRuns: fixture.activeRuns, executeExistingRunContinuation: (input) => {
        dispatches.push(input);
        return fixture.execution(input);
      } });
    t.after(() => coordinator.beginShutdown());
    assert.deepEqual(coordinator.recoverStore(fixture.store), { scanned: 1, dispatched: 1, skipped: 0 });
    assert.equal(dispatches[0].runId, fixture.targetRun.id);
    assert.equal(dispatches[0].origin, "manual_resume");
    assert.equal(dispatches[0].idempotencyDiscriminator, fixture.continuation.id);
    assert.equal(dispatches[0].preparedExecution.attempt.id, fixture.continuation.targetAttemptId);
    await Promise.all(fixture.completions);
    assert.deepEqual(fixture.errors, []);
    assert.equal(fixture.store.getRun(fixture.targetRun.id).status, "succeeded");
    assert.equal(fixture.store.getWorkUnit(fixture.targetUnit.id).status, "succeeded");
    assert.equal(fixture.store.getRunnerContinuation(fixture.continuation.id).state, "succeeded");
    assert.equal(fixture.calls.filter((call) => call.runId === fixture.targetRun.id).length, 1);
    assert.equal(fixture.store.getTask(fixture.targetTask.id)?.status, taskMode === "todo" ? "done" : undefined);
    assert.equal(coordinator.recoverStore(fixture.store).dispatched, 0);
  });
}

for (const taskMode of ["todo", "virtual"]) {
  for (const mutation of ["missing parent", "foreign parent", "same-root sibling parent", "changed context", "changed frozen execution"]) {
    test(`scheduled ${taskMode} Task refuses ${mutation} provenance without starting its prepared Attempt`, async (t) => {
      const fixture = await createQueuedAdmissionFixture(t, taskMode);
      const snapshot = structuredClone(fixture.targetRun.requestSnapshot);
      const sibling = mutation === "same-root sibling parent" ? await fixture.createSiblingSource() : undefined;
      if (sibling) assert.equal(sibling.parentRunId, fixture.sourceRun.id);
      const database = new DatabaseSync(fixture.store.paths.databasePath);
      try {
        if (mutation === "changed context") {
          database.prepare("UPDATE run_sessions SET context_view_id = ? WHERE id = ?")
            .run("foreign-context", fixture.targetRun.id);
        } else if (mutation === "changed frozen execution") {
          snapshot.runnerExecutionInput.input.reasoningSummary = "concise";
          database.prepare("UPDATE run_sessions SET request_snapshot_json = ? WHERE id = ?")
            .run(JSON.stringify(snapshot), fixture.targetRun.id);
        } else {
          const foreignRun = fixture.store.listRuns({ limit: 100 })
            .find(run => run.id !== fixture.sourceRun.id && run.id !== fixture.targetRun.id);
          const parentId = mutation === "missing parent" ? "missing-source-run" : sibling?.id ?? foreignRun.id;
          snapshot.parentRunId = parentId;
          database.prepare("UPDATE run_sessions SET parent_run_id = ?, request_snapshot_json = ? WHERE id = ?")
            .run(parentId, JSON.stringify(snapshot), fixture.targetRun.id);
        }
      } finally { database.close(); }
      assert.ok(readStoredRunnerExecution(fixture.store.getRun(fixture.targetRun.id)),
        "a malformed execution payload must not mask the provenance guard");
      const dispatches = [];
      const coordinator = new DaemonRunnerRecoveryCoordinator({ runtimeSupervisor: fixture.supervisor,
        activeRuns: fixture.activeRuns, executeExistingRunContinuation: (input) => {
          dispatches.push(input);
          return fixture.execution(input);
        } });
      t.after(() => coordinator.beginShutdown());
      assert.deepEqual(coordinator.recoverStore(fixture.store), { scanned: 1, dispatched: 0, skipped: 1 });
      assert.deepEqual(dispatches, []);
      assert.equal(fixture.store.getRunnerContinuation(fixture.continuation.id).state, "prepared");
      assert.equal(fixture.store.getWorkUnitAttempt(fixture.continuation.targetAttemptId).status, "created");
      assert.equal(fixture.calls.some(call => call.runId === fixture.targetRun.id), false);
    });
  }
}
