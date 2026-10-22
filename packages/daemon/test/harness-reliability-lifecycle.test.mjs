import assert from "node:assert/strict";
import { setImmediate as nextTick } from "node:timers/promises";
import test from "node:test";
import { HARNESS_LIFECYCLE_DOMAINS, HarnessLifecycleCoordinator } from "../dist/features/harness/reliability/lifecycle-coordinator.js";
import { HarnessProjectionReconciler } from "../dist/features/harness/reliability/projection-reconciler.js";
import { HarnessArtifactRetentionService } from "../dist/features/harness/reliability/artifact-retention-service.js";
import { RunEvaluationSchedulerRegistry, processNextRunEvaluation } from "../dist/features/harness/evaluations/scheduler.js";
import { createHarnessReliabilityCorpus, HARNESS_CORPUS_SPEC } from "../../../scripts/harness-reliability-corpus.mjs";
import { createDaemonServer } from "../dist/index.js";
import { createSqliteRunStore } from "../../core/dist/index.js";

function deferred() {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function lifecycle(options = {}) {
  const calls = [];
  const coordinator = new HarnessLifecycleCoordinator({
    stopExternalAdmission: () => { calls.push("external:stop"); return options.externalStop?.(); },
    closeResources: () => { calls.push("store:close"); return options.close?.(); },
  });
  for (const domain of HARNESS_LIFECYCLE_DOMAINS) coordinator.register({
    domain, enabled: domain !== "delegation",
    stopAdmission: () => { calls.push(`${domain}:stop`); return options.stop?.(domain); },
    abortOwned: () => { calls.push(`${domain}:abort`); return options.abort?.(domain); },
    settle: async () => { calls.push(`${domain}:settle`); await options.settle?.(domain); calls.push(`${domain}:settled`); },
  });
  return { calls, coordinator };
}

test("all admissions stop before abort; every owned domain actually settles before Store close", async () => {
  const completion = deferred();
  const f = lifecycle({ settle: domain => domain === "tool_execution" ? completion.promise : undefined });
  const closing = f.coordinator.shutdown();
  await nextTick();
  assert.equal(f.calls.includes("store:close"), false);
  assert.equal(f.coordinator.getPhase(), "draining");
  const firstAbort = f.calls.findIndex(call => call.endsWith(":abort"));
  for (const domain of HARNESS_LIFECYCLE_DOMAINS) assert.ok(f.calls.indexOf(`${domain}:stop`) < firstAbort);
  completion.resolve();
  const receipt = await closing;
  assert.equal(receipt.status, "closed"); assert.deepEqual(receipt.disabledDomains, ["delegation"]);
  const closeAt = f.calls.indexOf("store:close");
  for (const domain of HARNESS_LIFECYCLE_DOMAINS) assert.ok(f.calls.indexOf(`${domain}:settled`) < closeAt);
});

test("timeout reports draining but never falsely closes a Store; a later wait observes real completion", async () => {
  const completion = deferred();
  const f = lifecycle({ settle: domain => domain === "continuation" ? completion.promise : undefined });
  const timed = await f.coordinator.shutdown({ timeoutMs: 10 });
  assert.equal(timed.status, "draining_timeout"); assert.equal(f.calls.includes("store:close"), false);
  completion.resolve();
  assert.equal((await f.coordinator.shutdown()).status, "closed");
  assert.equal(f.calls.filter(call => call === "store:close").length, 1);
});

for (const fault of ["stop", "abort", "settle"]) {
  test(`${fault} failure retains resources, still drains every domain, and preserves the original error`, async () => {
    const failure = new Error(`fault-${fault}`);
    const f = lifecycle({ [fault]: domain => { if (domain === "evaluation") throw failure; } });
    const result = await f.coordinator.shutdown();
    assert.equal(result.status, "failed"); assert.equal(f.calls.includes("store:close"), false);
    for (const domain of HARNESS_LIFECYCLE_DOMAINS) assert.ok(f.calls.includes(`${domain}:settle`));
    assert.equal(f.coordinator.getFailureCauses()[0].error, failure);
  });
}

test("a pending external stop does not postpone stopping internal admissions", async () => {
  const admission = deferred(); const f = lifecycle({ externalStop: () => admission.promise });
  const closing = f.coordinator.shutdown(); await nextTick();
  for (const domain of HARNESS_LIFECYCLE_DOMAINS) assert.ok(f.calls.includes(`${domain}:stop`));
  assert.equal(f.calls.some(call => call.endsWith(":abort")), false);
  admission.resolve(); assert.equal((await closing).status, "closed");
});

test("missing domains, duplicate registration and late registration fail closed", async () => {
  const missing = new HarnessLifecycleCoordinator({ stopExternalAdmission() {}, closeResources() {} });
  await assert.rejects(missing.shutdown(), /domain_missing/);
  const port = { domain: "continuation", enabled: true, stopAdmission() {}, abortOwned() {}, async settle() {} };
  missing.register(port); assert.throws(() => missing.register(port), /duplicate/);
  const f = lifecycle(); await f.coordinator.shutdown(); assert.throws(() => f.coordinator.register(port), /registration_closed/);
});

function projectionStore() {
  const counts = new Map();
  return {
    counts,
    reconcileHarnessProjectionPage({ domain }) {
      const rowCount = (counts.get(domain) ?? 0) + 1; counts.set(domain, rowCount);
      return { domain, rowCount, state: rowCount >= 3 ? "ready" : "rebuilding", sourceEpoch: 1, builtEpoch: 1 };
    },
  };
}

test("reconciler is single-flight, yields between durable pages, and covers every domain", async () => {
  const store = projectionStore(); const reconciler = new HarnessProjectionReconciler();
  const first = reconciler.reconcileStore(store); const second = reconciler.reconcileStore(store);
  assert.equal(first, second);
  const checkpoints = await first;
  assert.deepEqual(checkpoints.map(row => row.domain), [...HARNESS_LIFECYCLE_DOMAINS]);
  for (const count of store.counts.values()) assert.equal(count, 3);
});

test("reconciler shutdown aborts between pages, drains its actual promise, and rejects new work", async () => {
  const store = projectionStore(); const reconciler = new HarnessProjectionReconciler();
  const work = reconciler.reconcileStore(store);
  await Promise.resolve();
  reconciler.beginShutdown(); reconciler.abortOwned();
  await assert.rejects(work, /shutdown|aborted/); await reconciler.waitForIdle();
  assert.equal(store.counts.get("continuation"), 1);
  await assert.rejects(reconciler.reconcileStore(store), /stopped/);
});

test("reconciler keeps incomplete checkpoints non-ready when its page budget is exhausted", async () => {
  const store = projectionStore(); const reconciler = new HarnessProjectionReconciler({ maxPagesPerDomain: 1 });
  await assert.rejects(reconciler.reconcileStore(store), /page_budget_exhausted/);
  assert.equal(store.counts.get("continuation"), 1); assert.equal(store.counts.has("evaluation"), false);
});

test("retention service resumes bounded sweeps without enrolling or touching an unrequested artifact", async () => {
  const calls = [];
  const store = { collectHarnessArtifactBodies({ after }) {
    calls.push(after); const ordinal = Number(after ?? 0) + 1;
    return { examined: 1, prunedArtifactIds: [], ...(ordinal < 5 ? { nextCursor: String(ordinal) } : {}) };
  } };
  const service = new HarnessArtifactRetentionService({ maxPagesPerSweep: 2 });
  const first = service.collectStore(store); assert.equal(first, service.collectStore(store));
  await first; assert.deepEqual(calls, [undefined, "1"]);
  await service.collectStore(store); assert.deepEqual(calls, [undefined, "1", "2", "3"]);
  await service.collectStore(store); assert.equal(calls.at(-1), "4");
  service.beginShutdown(); service.abortOwned(); await service.waitForIdle();
  await assert.rejects(service.collectStore(store), /stopped/);
});

test("rule scheduler forwards owned abort and still waits for a grader that ignores cancellation", { timeout: 10_000 }, async t => {
  const f = await createHarnessReliabilityCorpus({ targets: 0, evaluations: 1 });
  const entered = deferred(); const completed = deferred();
  const scheduler = new RunEvaluationSchedulerRegistry({ enabled: true,
    grade: async ({ signal }) => { entered.resolve(signal); await completed.promise;
      return { graderType: "rule", graderId: "test", graderVersion: "1", verdict: "pass" }; },
  });
  t.after(async () => { completed.resolve(); scheduler.beginShutdown(); scheduler.abortOwned(); await scheduler.waitForIdle(); await f.close(); });
  scheduler.registerStore(f.store);
  const signal = await entered.promise;
  scheduler.beginShutdown(); assert.equal(signal.aborted, false, "closing admission alone is not an abort receipt");
  scheduler.abortOwned(); assert.equal(signal.aborted, true);
  let idle = false; const drain = scheduler.waitForIdle().then(() => { idle = true; });
  await nextTick(); assert.equal(idle, false);
  completed.resolve(); await drain;
  assert.equal(f.store.getRunEvaluation(f.evaluationRows[0].id).state, "queued");
  assert.equal(f.store.listRunEvaluationGrades(f.evaluationRows[0].id).length, 0, "an aborted late grade must not become completed evidence");
});

test("already-aborted evaluation work refuses before any Store read", async () => {
  const controller = new AbortController(); controller.abort();
  const result = await processNextRunEvaluation({ signal: controller.signal, workerId: "stopped", store: new Proxy({}, {
    get() { assert.fail("aborted scheduler must not inspect authority"); },
  }) });
  assert.equal(result.disposition, "stopped");
});

test("real daemon startup consumes projection checkpoints and explicit retention, then closes only after both stop", { timeout: 15_000 }, async t => {
  const f = await createHarnessReliabilityCorpus({ targets: 1, evaluations: 1 });
  const prepared = f.store.prepareContinuationAndAttempt(f.preparations[0]);
  const cache = f.store.createArtifact({ id: "daemon-cold-cache", runId: f.root.id, type: "json", path: "harness/cache.json",
    sealedPayload: { cache: true }, createdAt: HARNESS_CORPUS_SPEC.time });
  f.store.enrollHarnessArtifactRetention({ artifactId: cache.id, retainUntil: HARNESS_CORPUS_SPEC.time, now: HARNESS_CORPUS_SPEC.time });
  f.store.close();
  let current; let closed = false;
  const daemon = createDaemonServer({ defaultWorkspaceCwd: f.cwd, host: "127.0.0.1", port: 0,
    channels: { intentSelector: false, terminalReports: false },
    harness: { continuations: { mode: "off" }, evaluations: { mode: "off" }, delegations: { mode: "off" } },
  }, { chromeBrowserNativeMessagingEnabled: false, storeFactory: cwd => {
    current = createSqliteRunStore(cwd); const close = current.close.bind(current);
    current.close = () => { closed = true; close(); }; return current;
  } });
  t.after(async () => { await daemon.stop(); await f.close(); });
  await daemon.start();
  let finished = false;
  for (let iteration = 0; iteration < 200; iteration += 1) {
    await nextTick();
    if (HARNESS_LIFECYCLE_DOMAINS.every(domain => current.getHarnessProjectionCheckpoint(domain).state === "ready")
      && current.getArtifact(cache.id).sealedPayloadState === "pruned") { finished = true; break; }
  }
  assert.equal(finished, true, "real production consumers must run, not only export unused helpers");
  const checkpoint = current.getHarnessProjectionCheckpoint("continuation");
  assert.ok(current.queryHarnessProjection({ domain: "continuation", generation: checkpoint.generation }).items.some(item => item.id === prepared.continuation.id));
  assert.equal(closed, false); await daemon.stop(); assert.equal(closed, true);
});
