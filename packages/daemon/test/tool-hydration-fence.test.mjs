import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, toRuntimeAttemptFence } from "../../core/dist/index.js";
import { hydrateRunnerToolSurface } from "../dist/features/runs/tool-surfaces.js";

const now = "2026-09-07T04:00:00.000Z";
async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-hydration-fence-"));
  const store = createSqliteRunStore(cwd);
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  const unit = store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run", ownerId: "source",
    idempotencyKey: "source", status: "running", createdByActor: "system", request: {}, now });
  const attempt = store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1, runtimeInstanceId: "old-runtime",
    runnerId: "runner_pi_embedded", status: "started", now });
  const run = store.createRun({ id: "source", cwd, workUnitId: unit.id, taskId: "source-task", providerName: "test", providerModel: "test",
    taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: now });
  store.linkRunToWorkUnit(run.id, unit.id, now);
  store.markRunStarted(run.id, now);
  const f = { store, unit, attempt, run, fence: toRuntimeAttemptFence(attempt), nextAttempt: 2 };
  f.registry = { list: () => [{ id: "runner_pi_embedded", displayName: "Pi", status: "enabled", supportedTools: ["read"] }] };
  f.request = { runId: run.id, runnerAttemptId: attempt.id, scope: { kind: "namespace", namespaceId: "core" }, reason: "Read tool schema", idempotencyKey: "load-core" };
  f.replace = () => store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: f.nextAttempt++, runtimeInstanceId: "new-runtime",
    runnerId: "runner_pi_embedded", status: "started", now });
  f.hydrate = (override = {}) => hydrateRunnerToolSurface({ store, runnerRegistry: f.registry, run, sourceFence: f.fence, request: f.request, now, ...override });
  f.events = () => store.listRuntimeEvents(unit.id, { limit: 1000 }).filter(event => ["tool_namespace_materialized", "tool_hydration_rejected"].includes(event.type));
  return f;
}

test("current captured hydration owner returns schemas and preserves exact event lineage", async (t) => {
  const f = await fixture(t);
  const first = f.hydrate();
  assert.equal(first.ok, true);
  assert.ok(first.tools.some(tool => tool.id === "core:read"));
  const replay = f.hydrate();
  assert.equal(replay.ok, true);
  assert.equal(first.materialization.id, replay.materialization.id);
  assert.equal(f.events().length, 1);
  assert.equal(f.events()[0].attemptId, f.attempt.id);
  assert.equal(f.events()[0].fencingToken, f.fence.fencingToken);
});

for (const stage of ["before-entry", "during-catalog", "cached-replay"]) {
  test(`old hydration cannot borrow the successor fence: ${stage}`, async (t) => {
    const f = await fixture(t);
    if (stage === "cached-replay") assert.equal(f.hydrate().ok, true);
    const acceptedBefore = f.events().length;
    if (stage === "during-catalog") f.registry.list = () => { f.replace(); return []; };
    else f.replace();
    const result = f.hydrate();
    assert.equal(result.ok, false);
    assert.equal(result.code, "tool_materialization_denied");
    assert.equal(result.hydration.schemaReturnedToRunner, false);
    assert.equal(result.tools, undefined);
    assert.equal(f.events().length, acceptedBefore);
    assert.equal(f.store.getWorkUnit(f.unit.id).status, "running");
  });
}

for (const field of ["runId", "runnerAttemptId", "fencingToken", "runtimeInstanceId"]) {
  test(`hydration rejects a mismatched ${field} without mutating any attempt`, async (t) => {
    const f = await fixture(t);
    const override = field === "runId" || field === "runnerAttemptId"
      ? { request: { ...f.request, [field]: "foreign" } } : { sourceFence: { ...f.fence, [field]: "foreign" } };
    const result = f.hydrate(override);
    assert.equal(result.ok, false);
    assert.equal(result.hydration.schemaReturnedToRunner, false);
    assert.equal(f.events().length, 0);
  });
}

test("a forged request cannot replace the Host captured old identity with a new attempt id", async (t) => {
  const f = await fixture(t);
  const successor = f.replace();
  const result = f.hydrate({ request: { ...f.request, runnerAttemptId: successor.id } });
  assert.equal(result.ok, false);
  assert.equal(f.events().length, 0);
});

for (const status of ["cancelled", "yielded", "succeeded"]) {
  test(`a closed source cannot load fresh or cached schemas: ${status}`, async (t) => {
    const f = await fixture(t);
    assert.equal(f.hydrate().ok, true);
    if (status === "yielded") f.store.transitionRunStatus({ runId: f.run.id, expectedStatus: "running", event: "runner_yielded", actor: "system", now });
    else if (status === "cancelled") f.store.markRunCancelled(f.run.id, now);
    else f.store.markRunSucceeded(f.run.id, now);
    const result = f.hydrate();
    assert.equal(result.ok, false);
    assert.equal(f.events().length, 1);
    assert.equal(result.tools, undefined);
  });
}

test("an old rejected hydration does not publish rejection onto a new attempt", async (t) => {
  const f = await fixture(t);
  f.registry.list = () => { f.replace(); return []; };
  const result = f.hydrate({ request: { ...f.request, scope: { kind: "namespace", namespaceId: "missing" } } });
  assert.equal(result.ok, false);
  assert.equal(f.events().length, 0);
});
