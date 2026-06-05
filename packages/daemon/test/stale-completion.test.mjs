import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { DEFAULT_WORKSPACE_ID, createSqliteRunStore } from "../../core/dist/index.js";
import { auditIgnoredRunnerCompletion } from "../dist/features/runs/stale-completion.js";

test("stale runner completion audit is idempotent per run attempt and status", async () => {
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
      status: "cancelled",
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
      status: "cancelled",
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
    store.markRunCancelled(run.id, "2026-06-05T00:00:01.000Z");

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
    assert.equal(events[0].data.reason, "run_cancelled");
    assert.equal(events[0].data.reportedStatus, "succeeded");
    assert.equal(events[0].data.currentRunStatus, "cancelled");
    assert.equal(events[0].data.currentWorkUnitStatus, "cancelled");

    const runtimeEvents = store.listRuntimeEvents(workUnit.id, { limit: 1000 })
      .filter((event) => event.type === "stale_runner_completion_ignored");
    assert.equal(runtimeEvents.length, 1);
    assert.equal(runtimeEvents[0].data.runEventId, events[0].id);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
