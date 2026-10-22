import assert from "node:assert/strict";
import test from "node:test";
import { createHarnessReliabilityCorpus, HARNESS_CORPUS_SPEC } from "../../../scripts/harness-reliability-corpus.mjs";

const now = HARNESS_CORPUS_SPEC.time;

test("public RunStore rebuilds real committed continuation/evaluation metadata without changing authority", async t => {
  const f = await createHarnessReliabilityCorpus({ targets: 2, evaluations: 2 }); t.after(() => f.close());
  const prepared = f.store.prepareContinuationAndAttempt(f.preparations[0]);
  const before = f.database.prepare("SELECT state,revision FROM runner_continuations WHERE id=?").get(prepared.continuation.id);
  const ready = f.store.reconcileHarnessProjectionPage({ domain: "continuation", now });
  assert.equal(ready.state, "ready"); assert.equal(ready.rowCount, 1);
  const page = f.store.queryHarnessProjection({ domain: "continuation", generation: ready.generation });
  assert.equal(page.items[0].id, prepared.continuation.id);
  assert.deepEqual(f.database.prepare("SELECT state,revision FROM runner_continuations WHERE id=?").get(prepared.continuation.id), before);
  assert.equal(f.store.reconcileHarnessProjectionPage({ domain: "evaluation", now }).rowCount, 2);
});

test("public artifact API explicitly reports pruned bodies while protecting real continuation snapshots", async t => {
  const f = await createHarnessReliabilityCorpus({ targets: 1, evaluations: 0 }); t.after(() => f.close());
  const prepared = f.store.prepareContinuationAndAttempt(f.preparations[0]);
  const protectedId = prepared.continuation.contextSnapshotArtifactId;
  f.store.enrollHarnessArtifactRetention({ artifactId: protectedId, retainUntil: now, now });
  const cold = f.store.createArtifact({ id: "corpus-cold-cache", runId: f.root.id, type: "json", path: "harness/cache.json", sealedPayload: { cache: true }, createdAt: now });
  f.store.enrollHarnessArtifactRetention({ artifactId: cold.id, retainUntil: now, now });
  assert.deepEqual(f.store.collectHarnessArtifactBodies({ now }).prunedArtifactIds, [cold.id]);
  const metadata = f.store.getArtifact(cold.id);
  assert.equal(metadata.sealedPayloadState, "pruned"); assert.equal(metadata.sealedPayload, undefined);
  assert.equal(metadata.contentSha256, cold.contentSha256);
  assert.equal(f.store.listArtifacts(f.root.id).find(row => row.id === cold.id).sealedPayloadState, "pruned");
  assert.notEqual(f.store.getArtifact(protectedId).sealedPayload, undefined);
});
