import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, toRuntimeAttemptFence } from "../dist/index.js";

const now = "2026-09-27T04:00:00.000Z";

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-run-compaction-checkpoint-"));
  const store = createSqliteRunStore(cwd);
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  const unit = store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run", ownerId: "run",
    idempotencyKey: "run-compaction-unit", status: "running", createdByActor: "system", request: {}, now });
  const attempt = store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1, runtimeInstanceId: "runtime-1",
    runnerId: "pi", status: "started", now });
  const run = store.createRun({ id: "run-compaction", cwd, workUnitId: unit.id, taskId: "task", providerName: "test",
    providerModel: "test-model", taskSnapshot: { title: "Keep the objective" }, providerSnapshot: {}, requestSnapshot: {}, createdAt: now });
  store.linkRunToWorkUnit(run.id, unit.id, now);
  store.markRunStarted(run.id, now);
  const fence = toRuntimeAttemptFence(attempt);
  const appendBoundary = (suffix) => {
    const artifact = store.createArtifact({ runId: run.id, type: "json", path: `compaction/${suffix}.json`,
      contentType: "application/vnd.ling.pi-compaction-context+json", sealedPayload: { boundary: "pi-compaction-context", messages: [] }, createdAt: now });
    const event = store.appendExecutionEvent(run.id, fence, "context_compaction_start", { reason: "threshold",
      policyVersion: "pi_sdk_lifecycle_v1", attemptId: attempt.id, checkpointArtifactId: artifact.id });
    const summaryPayload = { summary: `Safe summary ${suffix}` };
    const summary = store.createArtifact({ runId: run.id, type: "json", path: `compaction/${suffix}-summary.json`,
      contentType: "application/vnd.ling.run-compaction-summary+json", sealedPayload: summaryPayload, createdAt: now });
    assert.equal(summary.contentSha256, createHash("sha256").update(JSON.stringify(summaryPayload)).digest("hex"));
    return { artifact, event, summary };
  };
  const input = (boundary, predecessorId) => ({ runId: run.id, attemptId: attempt.id,
    sourceEventSeq: boundary.event.seq, predecessorId, contextSnapshotArtifactId: boundary.artifact.id,
    summaryArtifactId: boundary.summary.id, summaryContentSha256: boundary.summary.contentSha256,
    providerName: "test", providerModel: "test-model", policyVersion: "pi_sdk_lifecycle_v1",
    policySnapshotFingerprint: "policy-fingerprint", workspaceProvenanceWatermark: "workspace_default:0",
    objective: "Keep the objective", constraints: ["Do not rerun completed tools"], createdAt: now });
  return { cwd, store, run, attempt, appendBoundary, input };
}

test("Run compaction checkpoint is durable, idempotent, CAS transitioned and has one successor", async (t) => {
  const f = await fixture(t);
  const firstBoundary = f.appendBoundary("first");
  const first = f.store.createRunCompactionCheckpoint(f.input(firstBoundary));
  assert.equal(first.state, "prepared");
  assert.equal(f.store.createRunCompactionCheckpoint(f.input(firstBoundary)).id, first.id);
  assert.equal(f.store.transitionRunCompactionCheckpoint({ id: first.id, expectedRevision: 1, state: "committed", now }), undefined);
  const committed = f.store.transitionRunCompactionCheckpoint({ id: first.id, expectedRevision: 0, state: "committed", now });
  assert.equal(committed?.state, "committed");
  assert.equal(committed?.revision, 1);
  assert.equal(f.store.transitionRunCompactionCheckpoint({ id: first.id, expectedRevision: 0, state: "blocked",
    blockerCode: "checkpoint.effect_unknown", now }), undefined);
  const secondBoundary = f.appendBoundary("second");
  assert.throws(() => f.store.createRunCompactionCheckpoint(f.input(secondBoundary)), /latest committed checkpoint/u);
  const second = f.store.createRunCompactionCheckpoint(f.input(secondBoundary, first.id));
  assert.equal(second.predecessorId, first.id);
  const reopened = createSqliteRunStore(f.cwd);
  try {
    assert.equal(reopened.getLatestRunCompactionCheckpoint(f.run.id)?.id, second.id);
    assert.deepEqual(reopened.listRunCompactionCheckpoints({ runId: f.run.id }).map((item) => item.id), [first.id, second.id]);
  } finally { reopened.close(); }
  const thirdBoundary = f.appendBoundary("third");
  assert.throws(() => f.store.createRunCompactionCheckpoint(f.input(thirdBoundary, first.id)), /latest committed checkpoint/u);
  assert.equal(f.store.transitionRunCompactionCheckpoint({ id: second.id, expectedRevision: 0, state: "blocked",
    blockerCode: "checkpoint.effect_unknown", now })?.state, "blocked");
  assert.throws(() => f.store.createRunCompactionCheckpoint(f.input(thirdBoundary, second.id)), /latest committed checkpoint/u);
});

test("Run compaction checkpoint rejects foreign artifact, digest and forged event lineage", async (t) => {
  const f = await fixture(t);
  const boundary = f.appendBoundary("lineage");
  assert.throws(() => f.store.createRunCompactionCheckpoint({ ...f.input(boundary), sourceEventSeq: boundary.event.seq + 1 }), /source event not found/u);
  assert.throws(() => f.store.createRunCompactionCheckpoint({ ...f.input(boundary), contextSnapshotArtifactId: "missing" }), /source event lineage mismatch/u);
  assert.throws(() => f.store.createRunCompactionCheckpoint({ ...f.input(boundary), summaryContentSha256: "0".repeat(64) }), /summary artifact lineage or digest mismatch/u);
  assert.equal(f.store.listRunCompactionCheckpoints({ runId: f.run.id }).length, 0);
});

test("Run compaction checkpoint idempotency rejects a changed recovery model view", async (t) => {
  const f = await fixture(t);
  const boundary = f.appendBoundary("identity");
  const original = f.input(boundary);
  f.store.createRunCompactionCheckpoint(original);
  for (const changed of [
    { objective: "A different objective" },
    { constraints: ["Allow completed tools to rerun"] },
    { providerModel: "another-model" },
    { policyVersion: "another-policy" },
    { unresolvedToolCallIds: ["call-unknown"] },
  ]) {
    assert.throws(() => f.store.createRunCompactionCheckpoint({ ...original, ...changed }),
      /identity conflict/u, JSON.stringify(changed));
  }
  assert.equal(f.store.listRunCompactionCheckpoints({ runId: f.run.id }).length, 1);
});

test("stale Attempt cannot commit a prepared Run compaction checkpoint", async (t) => {
  const f = await fixture(t);
  const firstBoundary = f.appendBoundary("stale-first");
  const prepared = f.store.createRunCompactionCheckpoint(f.input(firstBoundary));
  f.store.createWorkUnitAttempt({ workUnitId: f.attempt.workUnitId, attemptNumber: 2,
    runtimeInstanceId: "runtime-2", runnerId: "pi", status: "started", now });
  assert.equal(f.store.transitionRunCompactionCheckpoint({ id: prepared.id, expectedRevision: 0,
    state: "committed", now }), undefined);
  assert.equal(f.store.getRunCompactionCheckpoint(prepared.id)?.state, "prepared");
});
