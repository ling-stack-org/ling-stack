import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, toRuntimeAttemptFence } from "@ling-stack/core";

/** Real task claim and atomic same-Run continuation activation, not model/checkpoint evidence. */
export async function createContinuationConcurrencyFixture(t, ownedStore) {
  const cwd = ownedStore?.cwd ?? await mkdtemp(join(tmpdir(), "ling-continuation-concurrency-"));
  const store = ownedStore?.store ?? createSqliteRunStore(cwd);
  if (!ownedStore) t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  const now = new Date().toISOString();
  const nonce = randomUUID();
  const channel = store.createChannel({ name: "Owned concurrency fixture", boundPath: cwd }, now);
  const task = store.createTask({ channelId: channel.id, title: "Resume same task", prompt: "Fixture only." }, now);
  const unit = store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "task",
    ownerId: task.id, taskId: task.id, channelId: channel.id, runnerId: "pi", effectiveRunnerId: "pi",
    idempotencyKey: `unit-${nonce}`, status: "stale", createdByActor: "system", request: {}, now });
  const sourceAttempt = store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1,
    runtimeInstanceId: `source-${nonce}`, runnerId: "pi", effectiveRunnerId: "pi", status: "lost", now });
  const idempotencyKey = `task-request-${nonce}`;
  const run = store.createRun({ id: `run-${nonce}`, cwd, taskId: task.id, channelId: channel.id,
    workUnitId: unit.id, providerName: "fixture", providerModel: "fixture", taskSnapshot: task,
    providerSnapshot: {}, requestSnapshot: {}, contextViewId: `context-${nonce}`, contextViewCreatedAt: now, createdAt: now });
  store.linkRunToWorkUnit(run.id, unit.id, now);
  store.markRunStarted(run.id, now);
  assert.equal(store.transitionTaskStatus({ taskId: task.id, expectedStatus: "todo", event: "claim",
    actor: "system", reason: `run:${run.id}`, idempotencyKey, now }).ok, true);
  const contextArtifact = store.createArtifact({ runId: run.id, type: "json", path: `${run.id}/admission-context.json`,
    sealedPayload: { purpose: "admission-only fixture; not a model-view checkpoint" }, createdAt: now });
  const activation = store.commitExistingRunContinuation({ preparation: { runId: run.id, workUnitId: unit.id,
    sourceFence: toRuntimeAttemptFence(sourceAttempt), expectedTargetAttemptId: sourceAttempt.id,
    origin: "daemon_recovery", strategy: "deterministic_replay", runnerId: "pi", runnerCapabilityRevision: "pi:fixture",
    contextViewId: run.contextViewId, contextSnapshotArtifactId: contextArtifact.id,
    idempotencyKey: `recovery-${nonce}`, generation: 0, targetAttempt: { runtimeInstanceId: `target-${nonce}`,
      runnerId: "pi", effectiveRunnerId: "pi" }, now }, expectedRunStatus: "running", expectedWorkUnitStatus: "stale",
    expectedTaskStatus: "claimed", actor: "system", reason: "fixture recovery", now });
  assert.equal(activation.ok, true, JSON.stringify(activation));
  const runRequest = { cwd, workspaceCwd: cwd, task: { id: task.id, channelId: channel.id, title: task.title,
    prompt: task.prompt }, tools: ["write"], idempotencyKey };
  const input = { store, runRequest, runId: run.id, workUnit: activation.workUnit, attempt: activation.attempt,
    existingContinuationId: activation.continuation.id, now };
  return { cwd, store, task, channel, run, sourceAttempt, activation, input, now };
}

export function claimFixtureContinuation(fixture) {
  const expiresAt = new Date(Date.parse(fixture.now) + 60_000).toISOString();
  const claim = fixture.store.claimRunnerContinuation({ continuationId: fixture.activation.continuation.id,
    expectedRevision: fixture.activation.continuation.revision, claimOwner: fixture.activation.attempt.runtimeInstanceId,
    claimToken: "owned-fixture-claim", claimExpiresAt: expiresAt, now: fixture.now });
  assert.equal(claim.ok, true, JSON.stringify(claim));
  return { claim, claimOwner: fixture.activation.attempt.runtimeInstanceId, claimToken: "owned-fixture-claim" };
}
