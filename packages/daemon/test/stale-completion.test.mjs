import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { DEFAULT_WORKSPACE_ID, createSqliteRunStore } from "../../core/dist/index.js";
import { auditIgnoredRunnerCompletion } from "../dist/features/runs/stale-completion.js";

for (const status of ["cancelled", "yielded"]) test(`stale runner completion audit remains idempotent after ${status}`, async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-stale-completion-"));
  const store = createSqliteRunStore(cwd);
  try {
    const now = "2026-06-05T00:00:00.000Z";
    const workUnit = store.createWorkUnit({
      id: "wu_stale_completion",
      workspaceId: DEFAULT_WORKSPACE_ID,
      kind: "task_run",
      ownerType: "task",
      ownerId: "task_stale_completion",
      runnerId: "pi",
      requestedRunnerId: "pi",
      effectiveRunnerId: "pi",
      idempotencyKey: "stale-completion-test",
      status: status === "yielded" ? "waiting_for_input" : "cancelled",
      createdByActor: "user",
      request: { prompt: "cancelled" },
      now,
    });
    const attempt = store.createWorkUnitAttempt({
      id: "attempt_stale_completion",
      workUnitId: workUnit.id,
      attemptNumber: 1,
      runtimeInstanceId: "runtime_test",
      runnerId: "pi",
      requestedRunnerId: "pi",
      effectiveRunnerId: "pi",
      status,
      now,
    });
    const run = store.createRun({
      id: "run_stale_completion",
      cwd,
      taskId: "task_stale_completion",
      providerName: "test-provider",
      providerModel: "test-model",
      taskSnapshot: { id: "task_stale_completion", title: "Stale completion" },
      providerSnapshot: { provider: "test-provider", model: "test-model" },
      requestSnapshot: { cwd },
      workUnitId: workUnit.id,
      createdAt: now,
    });
    store.linkRunToWorkUnit(run.id, workUnit.id, now);
    if (status === "cancelled") store.markRunCancelled(run.id, "2026-06-05T00:00:01.000Z");
    else {
      store.markRunStarted(run.id, now);
      assert.equal(store.transitionRunStatus({ runId: run.id, expectedStatus: "running", event: "runner_yielded", actor: "system", now }).ok, true);
    }

    const first = auditIgnoredRunnerCompletion({
      store,
      run,
      workUnit,
      attempt,
      reportedStatus: "succeeded",
      now: "2026-06-05T00:00:02.000Z",
    });
    const duplicate = auditIgnoredRunnerCompletion({
      store,
      run,
      workUnit,
      attempt,
      reportedStatus: "succeeded",
      now: "2026-06-05T00:00:03.000Z",
    });

    assert.ok(first);
    assert.equal(duplicate, undefined);
    const events = store.listEvents(run.id, { limit: 1000 }).filter((event) => event.type === "stale_runner_completion_ignored");
    assert.equal(events.length, 1);
    assert.equal(events[0].data.reason, status === "cancelled" ? "run_cancelled" : "terminal_state_changed");
    assert.equal(events[0].data.reportedStatus, "succeeded");
    assert.equal(events[0].data.currentRunStatus, status);
    assert.equal(events[0].data.currentWorkUnitStatus, status === "yielded" ? "waiting_for_input" : "cancelled");

    const runtimeEvents = store.listRuntimeEvents(workUnit.id, { limit: 1000 })
      .filter((event) => event.type === "stale_runner_completion_ignored");
    assert.equal(runtimeEvents.length, 1);
    assert.equal(runtimeEvents[0].data.runEventId, events[0].id);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
