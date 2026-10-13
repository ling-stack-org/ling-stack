import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteRunStore, digestRunEvaluationValue, resolveRuntimePaths, DEFAULT_WORKSPACE_ID } from "@ling-stack/core";
import { processNextRunEvaluation, processNextRunEvaluationTask, RunEvaluationTaskWorkerRegistry } from "../dist/index.js";

const now = "2026-10-10T00:00:00.000Z";
const started = "2026-10-10T00:01:00.000Z";
const expired = "2026-10-10T00:03:00.000Z";
const scope = "a".repeat(64);

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-evaluation-task-worker-"));
  const stores = [];
  const open = () => { const store = createSqliteRunStore(cwd); stores.push(store); return store; };
  const store = open();
  const database = new DatabaseSync(resolveRuntimePaths(cwd).databasePath);
  let verifySource;
  t.after(async () => {
    try {
      verifySource?.();
    } finally {
      database.close();
      for (const item of stores) { try { item.close(); } catch {} }
      await rm(cwd, { recursive: true, force: true });
    }
  });
  const channel = store.createChannel({ name: "Internal evaluation fixture", boundPath: cwd }, now);
  const sourceTask = store.createTask({ channelId: channel.id, title: "Completed source", prompt: "fixture" }, now);
  const workUnit = store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "task",
    ownerId: sourceTask.id, taskId: sourceTask.id, idempotencyKey: "worker-source-workunit", createdByActor: "system", request: {}, now });
  const attempt = store.createWorkUnitAttempt({ workUnitId: workUnit.id, attemptNumber: 1,
    runtimeInstanceId: "fixture-source-runtime", runnerId: "pi", now });
  const sourceFence = { workUnitId: workUnit.id, attemptId: attempt.id,
    runtimeInstanceId: attempt.runtimeInstanceId, fencingToken: attempt.fencingToken };
  assert.equal(store.transitionWorkUnitStatus({ workUnitId: workUnit.id, expectedStatus: "queued", event: "claim",
    actor: "system", activeAttemptId: attempt.id, now }).ok, true);
  assert.equal(store.transitionWorkUnitStatus({ workUnitId: workUnit.id, expectedStatus: "claimed", event: "runner_started", actor: "runner", now }).ok, true);
  store.updateWorkUnitAttemptStatus({ ...sourceFence, status: "started", now });
  assert.ok(store.acquireRuntimeSemaphoreSlot({ ...sourceFence, workspaceId: DEFAULT_WORKSPACE_ID,
    resourceType: "provider", resourceKey: "source-provider", ownerType: "work_unit_attempt", ownerId: attempt.id,
    acquiredAt: now, expiresAt: "2099-01-01T00:00:00.000Z", limit: 1 }));
  const run = store.createRun({ id: "run-task-worker-source", cwd, taskId: sourceTask.id, workUnitId: workUnit.id,
    providerName: "fixture", providerModel: "fixture", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: now });
  store.linkRunToWorkUnit(run.id, workUnit.id, now);
  store.markRunSucceeded(run.id, now);
  assert.ok(store.transitionWorkUnitAttemptTerminal({ ...sourceFence, event: "runner_succeeded", attemptStatus: "succeeded",
    runtimeEventType: "work_unit_succeeded", actor: "system", now }));
  store.releaseRuntimeSemaphoreSlotsForAttempt(sourceFence, now, "source-completed");
  const artifact = (id, payload) => store.createArtifact({ id: `worker-artifact-${id}`, runId: run.id,
    type: "json", path: `evaluation/${id}.json`, sealedPayload: payload, createdAt: now });
  const suite = artifact("suite", { id: "suite", version: "1" });
  const testCase = artifact("case", { schemaVersion: 1, kind: "deterministic_json_rule", graderId: "rule-source",
    graderVersion: "1", failureSeverity: "error", assertions: [{ type: "deep_equal" }] });
  const baseline = artifact("baseline", { ok: true });
  const candidate = artifact("candidate", { ok: true });
  const evaluation = store.enqueueRunEvaluation({ runId: run.id, suiteId: "suite", suiteVersion: "1", suiteArtifactId: suite.id,
    caseId: "case", caseVersion: "1", caseArtifactId: testCase.id, baselineId: "baseline", baselineVersion: "1",
    baselineArtifactId: baseline.id, candidateArtifactId: candidate.id, now }).evaluation;
  assert.equal((await processNextRunEvaluation({ store, workerId: "source-rule", now: started })).disposition, "completed");
  const frozen = { graderId: "internal-model-fixture", graderVersion: "1", promptDigest: "b".repeat(64), modelId: "not-a-provider",
    modelVersion: "fixture", samplingDigest: "c".repeat(64), rubricDigest: "d".repeat(64) };
  const frozenArtifact = artifact("frozen", frozen);
  const raw = artifact("raw", { fixtureOnly: true, verdict: "pass" });
  const pin = value => ({ artifactId: value.id, contentSha256: value.contentSha256 });
  const enqueue = { evaluationId: evaluation.id, evaluationKey: evaluation.idempotencyKey,
    frozenGraderArtifact: pin(frozenArtifact), frozenGraderDigest: digestRunEvaluationValue(frozen), repeatOrdinal: 1, now: started };
  const enqueued = store.enqueueRunEvaluationTask(enqueue);
  assert.equal(enqueued.ok, true);
  const task = enqueued.value;
  const response = () => ({ verdict: "pass", rawOutputArtifact: pin(raw) });
  const sourceSnapshot = () => ({ run: store.getRun(run.id), workUnit: store.getWorkUnit(workUnit.id),
    attempt: store.getWorkUnitAttempt(attempt.id), evaluation: store.getRunEvaluation(evaluation.id),
    grades: store.listRunEvaluationGrades(evaluation.id),
    semaphores: store.listRuntimeSemaphoreSlots({ workUnitId: workUnit.id }) });
  const originalSource = sourceSnapshot();
  let semaphoreCalls = 0;
  store.acquireRuntimeSemaphoreSlot = () => { semaphoreCalls += 1; throw new Error("normal quota forbidden"); };
  verifySource = () => {
    // Reopen rather than reading a deliberately closed fixture connection.
    const check = open();
    assert.deepEqual({ run: check.getRun(run.id), workUnit: check.getWorkUnit(workUnit.id),
      attempt: check.getWorkUnitAttempt(attempt.id), evaluation: check.getRunEvaluation(evaluation.id),
      grades: check.listRunEvaluationGrades(evaluation.id),
      semaphores: check.listRuntimeSemaphoreSlots({ workUnitId: workUnit.id }) }, originalSource);
    assert.equal(semaphoreCalls, 0);
  };
  return { cwd, store, database, open, run, evaluation, task, frozen, frozenArtifact, raw, enqueue, response, pin };
}

const options = (f, executor, extra = {}) => ({ store: f.store, workerId: "internal-worker", executor,
  executionScopeDigest: scope, clock: () => started, ...extra });

test("absent executor, disabled registry and pre-aborted execution do not read, claim or admit", async t => {
  const f = await fixture(t);
  const untouched = new Proxy({}, { get() { assert.fail("unconfigured/aborted worker must not read the Store"); } });
  assert.equal((await processNextRunEvaluationTask({ store: untouched, workerId: "absent" })).disposition, "unconfigured");
  const controller = new AbortController(); controller.abort();
  assert.equal((await processNextRunEvaluationTask({ store: untouched, workerId: "aborted", executor: f.response,
    signal: controller.signal })).disposition, "stopped");
  const registry = new RunEvaluationTaskWorkerRegistry({ enabled: true });
  registry.registerStore(f.cwd, untouched); registry.wake(f.cwd); registry.beginShutdown(); await registry.waitForIdle();
  const disabled = new RunEvaluationTaskWorkerRegistry({ executor: f.response, executionScopeDigest: scope });
  disabled.registerStore(f.cwd, untouched); disabled.beginShutdown(); await disabled.waitForIdle();
  assert.equal(f.store.getRunEvaluationTask(f.task.id).state, "queued");
});

test("one explicit internal result has immutable pins, missing cost remains unknown and authority stays unverified", async t => {
  const f = await fixture(t);
  let calls = 0;
  const result = await processNextRunEvaluationTask(options(f, input => {
    calls += 1;
    assert.equal(Object.hasOwn(input, "store"), false);
    assert.equal(Object.hasOwn(input, "secretResolver"), false);
    assert.equal(Object.isFrozen(input), true);
    for (const object of [input.task, input.task.frozenGrader, input.attempt, input.artifacts, input.artifacts.candidate]) {
      assert.equal(Object.isFrozen(object), true);
    }
    assert.throws(() => { input.task.frozenGrader.modelId = "mutated"; }, TypeError);
    assert.equal(input.task.evaluationKey, f.evaluation.idempotencyKey);
    assert.equal(input.executionScopeDigest, scope);
    assert.equal(input.artifacts.frozenGrader.contentSha256, f.frozenArtifact.contentSha256);
    assert.equal(input.attempt.requestDigest, input.requestDigest);
    assert.equal(input.attempt.executionScopeDigest, scope);
    assert.match(input.attempt.invocationId, /^evaluation_invocation_/u);
    return f.response();
  }));
  assert.deepEqual(result, { disposition: "completed", taskId: f.task.id });
  const persisted = f.store.getRunEvaluationTaskResult(f.task.id);
  assert.equal(persisted.authority, "unverified");
  assert.equal(persisted.executionScopeDigest, scope);
  for (const key of ["costInputTokens", "costOutputTokens", "costAmountMicros", "latencyMs"]) assert.equal(persisted[key], undefined);
  assert.equal((await processNextRunEvaluationTask(options(f, () => { calls += 1; return f.response(); }))).disposition, "idle");
  assert.equal(calls, 1);
});

test("genuine admission replay returns mayDispatch false and never invokes the executor again", async t => {
  const f = await fixture(t);
  const admit = f.store.admitRunEvaluationTaskDispatch.bind(f.store);
  f.store.admitRunEvaluationTaskDispatch = input => {
    const first = admit(input); assert.equal(first.ok, true);
    const replay = admit({ ...input, expectedTaskRevision: first.value.task.revision,
      expectedAttemptRevision: first.value.attempt.revision });
    assert.equal(replay.ok, true); assert.equal(replay.value.mayDispatch, false); return replay;
  };
  let calls = 0;
  assert.equal((await processNextRunEvaluationTask(options(f, () => { calls += 1; return f.response(); }))).disposition, "claim_lost");
  assert.equal(calls, 0);
  assert.equal(f.store.getRunEvaluationTaskAttempt(f.store.getRunEvaluationTask(f.task.id).activeAttemptId).state, "dispatch_admitted");
});

test("failed admission and frozen artifact drift produce zero executor calls", async t => {
  for (const cause of ["rejected", "frozen-drift"]) await t.test(cause, async t => {
    const f = await fixture(t);
    if (cause === "rejected") f.store.admitRunEvaluationTaskDispatch = () => ({ ok: false, code: "stale_revision" });
    else f.database.prepare("UPDATE artifacts SET sealed_payload_json=? WHERE id=?")
      .run(JSON.stringify({ ...f.frozen, modelVersion: "drift" }), f.frozenArtifact.id);
    let calls = 0;
    await processNextRunEvaluationTask(options(f, () => { calls += 1; return f.response(); }));
    assert.equal(calls, 0);
    assert.equal(f.store.getRunEvaluationTaskResult(f.task.id), undefined);
  });
});

test("untrusted or oversized source data is rejected before admission without executing getters", async t => {
  for (const cause of ["getter", "toJSON", "prototype", "wide-tree", "large-strings"]) await t.test(cause, async t => {
    const f = await fixture(t);
    const read = f.store.getRunEvaluation.bind(f.store);
    let reads = 0, calls = 0;
    f.store.getRunEvaluation = id => {
      const source = { ...read(id) };
      if (cause === "getter") Object.defineProperty(source, "extra", {
        enumerable: true, get() { reads += 1; return "unsafe"; },
      });
      else if (cause === "toJSON") source.toJSON = () => { reads += 1; return {}; };
      else if (cause === "prototype") Object.setPrototypeOf(source, { inherited: true });
      else if (cause === "wide-tree") source.extra = Object.fromEntries(Array.from({ length: 64 }, (_, outer) =>
        [String(outer), Object.fromEntries(Array.from({ length: 64 }, (_, inner) => [String(inner), null]))]));
      else source.extra = Object.fromEntries(Array.from({ length: 64 }, (_, index) => [String(index), "x".repeat(2_048)]));
      return source;
    };
    const result = await processNextRunEvaluationTask(options(f, () => { calls += 1; return f.response(); }));
    assert.equal(result.disposition, "failed");
    assert.equal(calls, 0); assert.equal(reads, 0);
    const current = f.store.getRunEvaluationTask(f.task.id);
    assert.equal(f.store.getRunEvaluationTaskAttempt(current.activeAttemptId).invocationId, undefined);
  });
});

test("unknown getter and authentication claims in returned results never execute or become producer authority", async t => {
  for (const cause of ["getter", "authentication-claim", "request-claim"]) await t.test(cause, async t => {
    const f = await fixture(t);
    let reads = 0;
    const payload = f.response();
    if (cause === "getter") Object.defineProperty(payload, "verdict", { enumerable: true, get() { reads += 1; return "pass"; } });
    else payload[cause === "authentication-claim" ? "authenticated" : "requestDigest"] = cause === "authentication-claim" ? true : "f".repeat(64);
    assert.equal((await processNextRunEvaluationTask(options(f, () => payload))).disposition, "unknown");
    assert.equal(reads, 0);
    assert.equal(f.store.getRunEvaluationTaskResult(f.task.id), undefined);
    assert.equal(f.store.getRunEvaluationTask(f.task.id).state, "unknown_outcome");
  });
});

test("generic synchronous and asynchronous errors after admission remain unknown and never auto resend", async t => {
  for (const kind of ["throw", "reject"]) await t.test(kind, async t => {
    const f = await fixture(t);
    let calls = 0;
    const result = await processNextRunEvaluationTask(options(f, () => {
      calls += 1;
      if (kind === "throw") throw new Error("fixture failure");
      return Promise.reject(new Error("fixture failure"));
    }));
    assert.equal(result.disposition, "unknown");
    assert.equal(f.store.getRunEvaluationTask(f.task.id).state, "unknown_outcome");
    assert.equal((await processNextRunEvaluationTask(options(f, () => { calls += 1; return f.response(); }))).disposition, "idle");
    assert.equal(calls, 1);
  });
});

test("configured startup recovery separates expired unadmitted claim from admitted unknown after SQLite reopen", async t => {
  for (const dispatch of [false, true]) await t.test(dispatch ? "admitted unknown" : "claimed no dispatch", async t => {
    const f = await fixture(t);
    const claimed = f.store.claimRunEvaluationTask({ taskId: f.task.id, expectedTaskRevision: f.task.revision,
      claimOwner: "dead-worker", claimToken: "dead-token", claimExpiresAt: "2026-10-10T00:02:00.000Z", now: started });
    assert.equal(claimed.ok, true);
    if (dispatch) assert.equal(f.store.admitRunEvaluationTaskDispatch({ ...fence(claimed.value, started),
      requestDigest: "e".repeat(64), executionScopeDigest: scope }).ok, true);
    f.store.close();
    const recovered = f.open();
    let calls = 0;
    const result = await processNextRunEvaluationTask(options(f, () => { calls += 1; return f.response(); },
      { store: recovered, clock: () => expired }));
    assert.equal(calls, dispatch ? 0 : 1);
    assert.equal(result.disposition, dispatch ? "idle" : "completed");
    assert.equal(recovered.getRunEvaluationTask(f.task.id).state, dispatch ? "unknown_outcome" : "completed");
    assert.equal(recovered.getRunEvaluationTaskAttempt(claimed.value.attempt.id).state,
      dispatch ? "unknown_outcome" : "abandoned_before_dispatch");
    assert.equal(recovered.getRunEvaluationTask(f.task.id).repeatOrdinal, 1);
  });
});

test("lease expiration after local call uses exact unknown recovery and rejects the late success", async t => {
  const f = await fixture(t);
  let clock = started;
  const result = await processNextRunEvaluationTask(options(f, () => { clock = expired; return f.response(); }, { clock: () => clock }));
  assert.equal(result.disposition, "unknown");
  assert.equal(f.store.getRunEvaluationTask(f.task.id).state, "unknown_outcome");
  assert.equal(f.store.getRunEvaluationTaskResult(f.task.id), undefined);
});

test("explicit timeout marks unknown, propagates abort and still waits for the real callback drain", async t => {
  const f = await fixture(t);
  const gate = deferred();
  let input;
  let drained = false;
  const work = processNextRunEvaluationTask(options(f, value => { input = value; return gate.promise; }, { executionTimeoutMs: 10 }))
    .then(result => { drained = true; return result; });
  try {
    await waitFor(() => input?.signal.aborted === true);
    assert.equal(f.store.getRunEvaluationTask(f.task.id).state, "unknown_outcome");
    assert.equal(drained, false);
  } finally { gate.resolve(f.response()); }
  assert.equal((await work).disposition, "unknown");
  assert.equal(f.store.getRunEvaluationTaskResult(f.task.id), undefined);
});

test("shutdown before scheduled work is registered and drained without claim or admission", async t => {
  const f = await fixture(t);
  let calls = 0;
  const registry = new RunEvaluationTaskWorkerRegistry({ enabled: true, executor: () => { calls += 1; return f.response(); }, executionScopeDigest: scope });
  registry.registerStore(f.cwd, f.store);
  registry.beginShutdown(); await registry.waitForIdle();
  assert.equal(calls, 0);
  assert.equal(f.store.getRunEvaluationTask(f.task.id).state, "queued");
});

test("clock and Store reentry before admission close the real registered controller", async t => {
  for (const cut of ["clock", "after-claim", "before-admission-clock", "source-read"]) await t.test(cut, async t => {
    const f = await fixture(t);
    let calls = 0, clockReads = 0;
    const registry = new RunEvaluationTaskWorkerRegistry({ enabled: true,
      executor: () => { calls += 1; return f.response(); }, executionScopeDigest: scope,
      clock: () => { clockReads += 1; if (cut === "clock" || (cut === "before-admission-clock" && clockReads === 2)) registry.beginShutdown(); return started; } });
    if (cut === "after-claim") {
      const claim = f.store.claimRunEvaluationTask.bind(f.store);
      f.store.claimRunEvaluationTask = input => { const result = claim(input); registry.beginShutdown(); return result; };
    }
    if (cut === "source-read") {
      const read = f.store.getRunEvaluation.bind(f.store);
      f.store.getRunEvaluation = id => { const result = read(id); registry.beginShutdown(); return result; };
    }
    registry.registerStore(f.cwd, f.store); await registry.waitForIdle(); registry.beginShutdown();
    assert.equal(calls, 0);
    const current = f.store.getRunEvaluationTask(f.task.id);
    assert.equal(current.state, cut === "clock" ? "queued" : "cancelled");
    if (current.activeAttemptId) assert.equal(f.store.getRunEvaluationTaskAttempt(current.activeAttemptId).invocationId, undefined);
  });
});

test("abort reentry after durable admission records unknown without invoking the callback", async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const admit = f.store.admitRunEvaluationTaskDispatch.bind(f.store);
  f.store.admitRunEvaluationTaskDispatch = input => {
    const result = admit(input); assert.equal(result.ok, true);
    controller.abort();
    return result;
  };
  let calls = 0;
  const result = await processNextRunEvaluationTask(options(f, () => { calls += 1; return f.response(); },
    { signal: controller.signal }));
  assert.equal(result.disposition, "unknown");
  assert.equal(calls, 0);
  assert.equal(f.store.getRunEvaluationTask(f.task.id).state, "unknown_outcome");
});

test("captured admission DTO copy reentry aborts before the real executor call", async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const admit = f.store.admitRunEvaluationTaskDispatch.bind(f.store);
  let descriptorReads = 0;
  f.store.admitRunEvaluationTaskDispatch = input => {
    const result = admit(input); assert.equal(result.ok, true);
    // Controlled Store seam only: production Core returns plain own-data DTOs.
    return { ...result, value: { ...result.value, task: new Proxy(result.value.task, {
      ownKeys(target) { descriptorReads += 1; controller.abort(); return Reflect.ownKeys(target); },
    }) } };
  };
  let calls = 0;
  const result = await processNextRunEvaluationTask(options(f, () => { calls += 1; return f.response(); },
    { signal: controller.signal }));
  assert.equal(result.disposition, "unknown");
  assert.equal(descriptorReads, 1);
  assert.equal(calls, 0);
  assert.equal(f.store.getRunEvaluationTask(f.task.id).state, "unknown_outcome");
  assert.equal(f.store.getRunEvaluationTaskResult(f.task.id), undefined);
});

test("executor reentrant shutdown does not declare idle until an explicitly released callback settles", async t => {
  const f = await fixture(t);
  const gate = deferred();
  let callbackInput, idlePromise, idle = false;
  const registry = new RunEvaluationTaskWorkerRegistry({ enabled: true, executionScopeDigest: scope, clock: () => started,
    executor: input => {
      callbackInput = input; registry.beginShutdown();
      idlePromise = registry.waitForIdle().then(() => { idle = true; });
      return gate.promise;
    } });
  registry.registerStore(f.cwd, f.store);
  try {
    await waitFor(() => callbackInput !== undefined);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(callbackInput.signal.aborted, true);
    assert.equal(f.store.getRunEvaluationTask(f.task.id).state, "unknown_outcome");
    assert.equal(idle, false);
  } finally { gate.resolve(f.response()); registry.beginShutdown(); }
  await idlePromise; await registry.waitForIdle();
  assert.equal(idle, true);
  assert.equal(f.store.getRunEvaluationTaskResult(f.task.id), undefined);
});

test("unknown persistence errors are contained until the real callback drains and then reported", async t => {
  const f = await fixture(t);
  const gate = deferred();
  const commitError = new Error("controlled unknown commit failure");
  f.store.markRunEvaluationTaskDispatchUnknown = () => { throw commitError; };
  let callbackInput, reported, drained = false;
  const registry = new RunEvaluationTaskWorkerRegistry({ enabled: true, executionScopeDigest: scope,
    clock: () => started, executor: input => { callbackInput = input; return gate.promise; },
    onError: error => { reported = error; throw new Error("diagnostic callback failure is contained"); } });
  registry.registerStore(f.cwd, f.store);
  try {
    await waitFor(() => callbackInput !== undefined);
    registry.beginShutdown();
    const idle = registry.waitForIdle().then(() => { drained = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(callbackInput.signal.aborted, true);
    assert.equal(drained, false); assert.equal(reported, undefined);
    gate.resolve(f.response());
    await idle;
  } finally { gate.resolve(f.response()); registry.beginShutdown(); await registry.waitForIdle(); }
  assert.equal(drained, true); assert.equal(reported, commitError);
  assert.equal(f.store.getRunEvaluationTaskResult(f.task.id), undefined);
  const current = f.store.getRunEvaluationTask(f.task.id);
  assert.equal(current.state, "active");
  assert.equal(f.store.getRunEvaluationTaskAttempt(current.activeAttemptId).state, "dispatch_admitted");
});

test("independent concurrency drains distinct repeats without changing ordinal or using normal quota", async t => {
  const f = await fixture(t);
  const second = f.store.enqueueRunEvaluationTask({ ...f.enqueue, repeatOrdinal: 2 }); assert.equal(second.ok, true);
  let active = 0, maximum = 0, calls = 0;
  const mutable = { enabled: true, concurrency: 1, executionScopeDigest: scope, clock: () => started,
    executor: async () => { active += 1; maximum = Math.max(maximum, active); calls += 1;
      await new Promise(resolve => setImmediate(resolve)); active -= 1; return f.response(); } };
  const registry = new RunEvaluationTaskWorkerRegistry(mutable);
  registry.registerStore(f.cwd, f.store);
  mutable.executor = () => { assert.fail("registered options must not drift"); };
  mutable.executionScopeDigest = "f".repeat(64);
  try { await waitFor(() => f.store.getRunEvaluationTask(second.value.id).state === "completed"
    && f.store.getRunEvaluationTask(f.task.id).state === "completed"); }
  finally { registry.beginShutdown(); await registry.waitForIdle(); }
  assert.equal(maximum, 1); assert.equal(calls, 2);
  assert.equal(f.store.getRunEvaluationTask(f.task.id).repeatOrdinal, 1);
  assert.equal(f.store.getRunEvaluationTask(second.value.id).repeatOrdinal, 2);
  assert.equal(f.store.getRunEvaluationTaskResult(second.value.id).executionScopeDigest, scope);
});

test("scope and timestamp validation fail before any Store read or claim", async () => {
  const store = new Proxy({}, { get() { assert.fail("invalid options must not reach Store"); } });
  await assert.rejects(processNextRunEvaluationTask({ store, workerId: "invalid", executor: () => ({}), executionScopeDigest: "bad" }), /scope_invalid/u);
  await assert.rejects(processNextRunEvaluationTask({ store, workerId: "invalid", executor: () => ({}), executionScopeDigest: scope,
    clock: () => "+010000-01-01T00:00:00.000Z" }), /clock_invalid/u);
});

function fence(claim, time) {
  return { taskId: claim.task.id, attemptId: claim.attempt.id, expectedTaskRevision: claim.task.revision,
    expectedAttemptRevision: claim.attempt.revision, claimOwner: claim.attempt.claimOwner, claimToken: claim.attempt.claimToken, now: time };
}
function deferred() {
  let resolve;
  const promise = new Promise(settle => { resolve = settle; });
  return { promise, resolve };
}
async function waitFor(predicate) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail("controlled internal worker did not reach the expected state");
}
