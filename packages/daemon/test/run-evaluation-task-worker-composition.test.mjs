import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "@ling-stack/core";
import {
  createDaemonServer,
  reconcileRunEvaluationTasksAtStartup,
  RunEvaluationTaskWorkerComposition,
} from "../dist/index.js";
import { admitRunEvaluationQaModelTransport } from "../dist/features/harness/evaluations/qa-model-transport.js";
import {
  completion,
  expired,
  fixture,
  now,
  ownedServer,
  preparedTransport,
} from "./fixtures/run-evaluation-qa-model.mjs";

test("startup recovery drains every task page before optional worker activation", () => {
  const cursor = { claimExpiresAt: "2026-10-10T00:00:30.000Z", attemptId: "attempt-1" };
  const calls = [];
  const store = {
    reconcileExpiredRunEvaluationTaskAttemptsPage(input) {
      calls.push(input);
      return calls.length === 1
        ? { examinedCount: 2, changed: [{}, {}], nextCursor: cursor }
        : { examinedCount: 1, changed: [{}] };
    },
    getRunEvaluationQaScope() { return undefined; },
    reconcileRunEvaluationQaScope() { assert.fail("an absent QA namespace must not be created during recovery"); },
  };

  assert.deepEqual(reconcileRunEvaluationTasksAtStartup({ store, now, limit: 2 }), {
    examined: 3,
    changed: 3,
    pages: 2,
    qaScope: "absent",
  });
  assert.deepEqual(calls, [{ now, limit: 2 }, { now, limit: 2, cursor }]);
});

test("disabled-by-default composition recovers durable state without reading or claiming the queue", async () => {
  let queueReads = 0;
  const store = {
    reconcileExpiredRunEvaluationTaskAttemptsPage() {
      return { examinedCount: 0, changed: [] };
    },
    getRunEvaluationQaScope() { return undefined; },
    listClaimableRunEvaluationTasks() { queueReads += 1; return []; },
  };
  const composition = new RunEvaluationTaskWorkerComposition({ clock: () => now });
  composition.registerStore("/explicit/qa-disabled", store);
  await new Promise(resolve => setImmediate(resolve));
  composition.beginShutdown();
  await composition.waitForIdle();
  assert.equal(queueReads, 0);
});

test("real startup recovery requeues an expired pre-dispatch claim without a Provider call", async t => {
  const server = await ownedServer(t);
  const f = await fixture(t, server.baseUrl);
  const claimed = f.store.claimRunEvaluationTask({
    taskId: f.task.id,
    expectedTaskRevision: f.task.revision,
    claimOwner: "crashed-before-dispatch",
    claimToken: "crashed-before-dispatch-token",
    claimExpiresAt: "2026-10-10T00:02:00.000Z",
    now,
  });
  assert.equal(claimed.ok, true);

  const composition = new RunEvaluationTaskWorkerComposition({ clock: () => expired });
  const recovered = composition.registerStore(f.cwd, f.store);
  composition.beginShutdown();
  await composition.waitForIdle();

  assert.deepEqual(recovered, { examined: 1, changed: 1, pages: 1, qaScope: "available" });
  assert.equal(f.store.getRunEvaluationTask(f.task.id).state, "queued");
  assert.equal(f.store.getRunEvaluationTask(f.task.id).activeAttemptId, undefined);
  assert.equal(server.requests.length, 0);
});

test("real restart recovery quarantines an admitted QA request and never silently rebinds it", async t => {
  const server = await ownedServer(t);
  const f = await fixture(t, server.baseUrl);
  const prepared = await preparedTransport(f);
  const admitted = admitRunEvaluationQaModelTransport(prepared.transport, prepared.fence(prepared.claim));
  assert.equal(admitted.ok, true);
  assert.equal(admitted.value.mayDispatch, true);
  assert.equal(f.store.getRunEvaluationQaScope().laneState, "held");

  const composition = new RunEvaluationTaskWorkerComposition({ clock: () => expired });
  const recovered = composition.registerStore(f.cwd, f.store);
  composition.beginShutdown();
  await composition.waitForIdle();

  assert.deepEqual(recovered, { examined: 1, changed: 1, pages: 1, qaScope: "quarantined" });
  assert.equal(f.store.getRunEvaluationTask(f.task.id).state, "unknown_outcome");
  assert.equal(f.store.getRunEvaluationQaScope().laneState, "quarantined");
  assert.equal(server.requests.length, 0);
});

test("trusted store-bound activation runs once, aborts on shutdown and waits for the real drain tail", async t => {
  const responseGate = deferred();
  const requestStarted = deferred();
  const drainGate = deferred();
  const drainEntered = deferred();
  t.after(() => {
    responseGate.resolve();
    drainGate.resolve();
  });
  const server = await ownedServer(t, async (_request, response) => {
    requestStarted.resolve();
    await responseGate.promise;
    response.end(JSON.stringify(completion()));
  });
  const f = await fixture(t, server.baseUrl);
  let factoryCalls = 0;
  const composition = new RunEvaluationTaskWorkerComposition({
    clock: () => now,
    activation: {
      scanIntervalMs: 60_000,
      createHostAdapter(input) {
        factoryCalls += 1;
        assert.equal(input.cwd, f.cwd);
        assert.equal(input.store, f.store);
        const adapter = f.adapter();
        return {
          ...adapter,
          async prepare(preparation) {
            const execution = await adapter.prepare(preparation);
            return {
              ...execution,
              async onDrained() {
                await execution.onDrained();
                drainEntered.resolve();
                await drainGate.promise;
              },
            };
          },
        };
      },
    },
  });
  composition.registerStore(f.cwd, f.store);
  await requestStarted.promise;

  composition.beginShutdown();
  let idle = false;
  const waiting = composition.waitForIdle().then(() => { idle = true; });
  await drainEntered.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(idle, false, "Store close must remain blocked while the Host drain callback is alive");
  drainGate.resolve();
  responseGate.resolve();
  await waiting;

  assert.equal(factoryCalls, 1);
  assert.equal(server.requests.length, 1);
  assert.equal(f.store.getRunEvaluationTask(f.task.id).state, "unknown_outcome");
  assert.equal(f.store.getRunEvaluationQaScope().laneState, "quarantined");

  const restarted = new RunEvaluationTaskWorkerComposition({ clock: () => now });
  restarted.registerStore(f.cwd, f.store);
  restarted.beginShutdown();
  await restarted.waitForIdle();
  assert.equal(server.requests.length, 1, "restart without a new trusted activation cannot rebind or resend the old batch");
});

test("Daemon shutdown drains the QA worker composition before closing its Store", { timeout: 15_000 }, async t => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-evaluation-worker-composition-"));
  const events = [];
  let daemon;
  let stopped = false;
  const originalBegin = RunEvaluationTaskWorkerComposition.prototype.beginShutdown;
  const originalWait = RunEvaluationTaskWorkerComposition.prototype.waitForIdle;
  t.mock.method(RunEvaluationTaskWorkerComposition.prototype, "beginShutdown", function () {
    events.push("worker-begin");
    return originalBegin.call(this);
  });
  t.mock.method(RunEvaluationTaskWorkerComposition.prototype, "waitForIdle", async function () {
    await originalWait.call(this);
    events.push("worker-idle");
  });
  t.after(async () => {
    if (!stopped) await daemon?.stop();
    await rm(cwd, { recursive: true, force: true });
  });

  daemon = createDaemonServer({
    host: "127.0.0.1",
    port: 0,
    defaultWorkspaceCwd: cwd,
    harness: { evaluations: { mode: "off" } },
  }, {
    storeFactory(workspaceCwd) {
      const store = createSqliteRunStore(workspaceCwd);
      const close = store.close.bind(store);
      store.close = () => { events.push("store-close"); close(); };
      return store;
    },
    runEvaluationQaTaskWorker: {
      scanIntervalMs: 60_000,
      createHostAdapter({ cwd: activatedCwd }) {
        events.push("worker-factory");
        assert.equal(activatedCwd, cwd);
        return {
          reconcile() { events.push("worker-reconcile"); },
          selectCandidate() { return undefined; },
          acceptsTask() { return false; },
          prepare() { assert.fail("empty QA queue must not prepare a request"); },
        };
      },
    },
  });
  await daemon.start();
  await waitFor(() => events.includes("worker-reconcile"));
  await daemon.stop();
  stopped = true;

  assert.ok(events.indexOf("worker-factory") < events.indexOf("worker-reconcile"));
  assert.ok(events.indexOf("worker-begin") < events.indexOf("worker-idle"));
  assert.ok(events.indexOf("worker-idle") < events.indexOf("store-close"));
});

function deferred() {
  let resolve;
  const promise = new Promise(settle => { resolve = settle; });
  return { promise, resolve };
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail("condition was not observed before timeout");
}
