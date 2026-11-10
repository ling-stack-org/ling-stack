import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, toRuntimeAttemptFence } from "../../../core/dist/index.js";

/** Real Host metadata, fencing and journal. No production safety methods are stubbed. */
export function createUnifiedExecFixture(t, cwd, task, runId, options = {}) {
  const store = createSqliteRunStore(cwd);
  t.after(() => store.close());
  const now = new Date().toISOString();
  const unit = store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run", ownerId: runId,
    idempotencyKey: "exec-unit-" + runId, status: "running", createdByActor: "system", request: {}, now });
  const attempt = store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1, runtimeInstanceId: "exec-runtime",
    runnerId: "pi", status: "started", now });
  store.createRun({ id: runId, cwd, workUnitId: unit.id, taskId: task.id, providerName: "test", providerModel: "test",
    taskSnapshot: task, providerSnapshot: {}, requestSnapshot: options.requestSnapshot ?? {}, createdAt: now });
  store.linkRunToWorkUnit(runId, unit.id, now); store.markRunStarted(runId, now);
  return { store, run: store.getRun(runId), sourceFence: toRuntimeAttemptFence(attempt) };
}
