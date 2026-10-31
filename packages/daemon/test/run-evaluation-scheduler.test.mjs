import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteRunStore, resolveRuntimePaths } from "@ling-stack/core";
import {
  RunEvaluationSchedulerRegistry,
  processNextRunEvaluation,
} from "../dist/index.js";

const now = "2026-09-14T00:00:00.000Z";
const later = "2026-09-14T00:01:00.000Z";

async function fixture(t, casePayload = validCase()) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-evaluation-scheduler-"));
  const store = createSqliteRunStore(cwd);
  t.after(async () => {
    try { store.close(); } catch {}
    await rm(cwd, { recursive: true, force: true });
  });
  const channel = store.createChannel({ name: "Evaluation", boundPath: cwd }, now);
  const task = store.createTask({ channelId: channel.id, title: "Evaluate", prompt: "grade" }, now);
  const run = store.createRun({
    id: "run-evaluation-scheduler",
    cwd,
    taskId: task.id,
    providerName: "test",
    providerModel: "fixture",
    taskSnapshot: {},
    providerSnapshot: {},
    requestSnapshot: {},
    createdAt: now,
  });
  store.markRunSucceeded(run.id, now);
  const suite = store.createArtifact({
    id: "artifact-scheduler-suite",
    runId: run.id,
    type: "json",
    path: "evaluation/suite.json",
    sealedPayload: { id: "suite", version: "1" },
    createdAt: now,
  });
  const testCase = store.createArtifact({
    id: "artifact-scheduler-case",
    runId: run.id,
    type: "json",
    path: "evaluation/case.json",
    sealedPayload: casePayload,
    createdAt: now,
  });
  const baseline = store.createArtifact({
    id: "artifact-scheduler-baseline",
    runId: run.id,
    type: "json",
    path: "evaluation/baseline.json",
    sealedPayload: { status: "ok", count: 2 },
    createdAt: now,
  });
  const candidate = store.createArtifact({
    id: "artifact-scheduler-candidate",
    runId: run.id,
    type: "json",
    path: "evaluation/candidate.json",
    sealedPayload: { count: 2, status: "ok" },
    createdAt: now,
  });
  const evaluation = store.enqueueRunEvaluation({
    id: "evaluation-scheduler-1",
    runId: run.id,
    suiteId: "suite",
    suiteVersion: "1",
    suiteArtifactId: suite.id,
    caseId: "case",
    caseVersion: "1",
    caseArtifactId: testCase.id,
    baselineId: "baseline",
    baselineVersion: "1",
    baselineArtifactId: baseline.id,
    candidateArtifactId: candidate.id,
    now,
  }).evaluation;
  return { cwd, store, run, suite, testCase, baseline, candidate, evaluation };
}

test("rule scheduler completes sealed JSON evaluation and records deterministic rationale evidence", async (t) => {
  const f = await fixture(t);
  let semaphoreCalls = 0;
  f.store.acquireRuntimeSemaphoreSlot = () => {
    semaphoreCalls += 1;
    throw new Error("normal run semaphore must not be used");
  };
  const result = await processNextRunEvaluation({
    store: f.store,
    workerId: "rule-worker",
    now: later,
  });
  assert.deepEqual(result, { disposition: "completed", evaluationId: f.evaluation.id });
  assert.equal(semaphoreCalls, 0);
  assert.equal(f.store.getRunEvaluation(f.evaluation.id).state, "completed");
  const grades = f.store.listRunEvaluationGrades(f.evaluation.id);
  assert.equal(grades.length, 1);
  assert.equal(grades[0].verdict, "pass");
  assert.equal(grades[0].score, 1);
  const rationale = f.store.getArtifact(grades[0].rationaleArtifactId);
  assert.equal(rationale.sealedPayload.verdict, "pass");
  assert.equal(rationale.sealedPayload.rationale.total, 2);
});

test("low priority evaluation yields before claim and grading to already queued foreground work", async t => {
  const f = await fixture(t);
  const order = [];
  const claim = f.store.claimRunEvaluation.bind(f.store);
  f.store.claimRunEvaluation = input => { order.push("evaluation-claim"); return claim(input); };
  const foreground = new Promise(resolve => setImmediate(() => { order.push("foreground"); resolve(); }));
  const evaluation = processNextRunEvaluation({ store: f.store, workerId: "low-priority", now: later });
  assert.deepEqual(order, []);
  await foreground;
  assert.equal((await evaluation).disposition, "completed");
  assert.deepEqual(order, ["foreground", "evaluation-claim"]);
});

test("shutdown during the foreground yield stops evaluation before any durable claim", async t => {
  const f = await fixture(t);
  const abort = new AbortController();
  const evaluation = processNextRunEvaluation({ store: f.store, workerId: "stopped-before-claim", now: later, signal: abort.signal });
  abort.abort();
  assert.deepEqual(await evaluation, { disposition: "stopped" });
  assert.equal(f.store.getRunEvaluation(f.evaluation.id).state, "queued");
});

test("malformed rule input fails closed instead of retrying or fabricating a grade", async (t) => {
  const f = await fixture(t, {
    schemaVersion: 1,
    kind: "deterministic_json_rule",
    graderId: "unsafe",
    graderVersion: "1",
    failureSeverity: "critical",
    assertions: [{ type: "execute", command: "echo unsafe" }],
  });
  const result = await processNextRunEvaluation({ store: f.store, workerId: "rule-worker", now: later });
  assert.deepEqual(result, { disposition: "failed", evaluationId: f.evaluation.id });
  assert.equal(f.store.getRunEvaluation(f.evaluation.id).failureCode, "evaluation.result_invalid");
  assert.equal(f.store.listRunEvaluationGrades(f.evaluation.id).length, 0);
});
test("artifact payload corruption after enqueue fails closed against the sealed digest", async (t) => {
  const f = await fixture(t);
  const database = new DatabaseSync(resolveRuntimePaths(f.cwd).databasePath);
  database.prepare("UPDATE artifacts SET sealed_payload_json = ? WHERE id = ?")
    .run(JSON.stringify({ status: "tampered" }), f.candidate.id);
  database.close();

  const result = await processNextRunEvaluation({
    store: f.store,
    workerId: "rule-worker",
    now: later,
  });
  assert.equal(result.disposition, "failed");
  assert.equal(f.store.getRunEvaluation(f.evaluation.id).state, "failed");
  assert.equal(f.store.getRunEvaluation(f.evaluation.id).failureCode, "evaluation.result_invalid");
  assert.equal(f.store.listRunEvaluationGrades(f.evaluation.id).length, 0);
});

test("artifact corruption after a real claim fails before start can invoke any grader", async t => {
  const f = await fixture(t);
  const claim = f.store.claimRunEvaluation.bind(f.store);
  f.store.claimRunEvaluation = input => {
    const result = claim(input);
    if (result.ok) replaceArtifactBody(f, f.candidate.id, { status: "changed-after-claim" });
    return result;
  };
  let graderCalls = 0;
  const result = await processNextRunEvaluation({ store: f.store, workerId: "rule-worker", now: later,
    grade() { graderCalls++; assert.fail("a corrupt claimed input must not enter the grader"); } });
  assert.deepEqual(result, { disposition: "failed", evaluationId: f.evaluation.id });
  const failed = f.store.getRunEvaluation(f.evaluation.id);
  assert.equal(failed.state, "failed");
  assert.equal(failed.failureCode, "evaluation.result_invalid");
  assert.equal(failed.claimOwner, undefined);
  assert.equal(failed.claimToken, undefined);
  assert.equal(graderCalls, 0);
  assert.equal(f.store.listRunEvaluationGrades(f.evaluation.id).length, 0);
});

test("body corruption during a transient grader failure is terminal instead of requeued", async t => {
  const f = await fixture(t);
  let graderCalls = 0;
  const result = await processNextRunEvaluation({ store: f.store, workerId: "rule-worker", now: later,
    grade() {
      graderCalls++;
      replaceArtifactBody(f, f.candidate.id, { status: "changed-during-grading" });
      throw new Error("the original grader became unavailable");
    } });
  assert.deepEqual(result, { disposition: "failed", evaluationId: f.evaluation.id });
  const failed = f.store.getRunEvaluation(f.evaluation.id);
  assert.equal(failed.state, "failed");
  assert.equal(failed.failureCode, "evaluation.result_invalid");
  assert.equal(failed.nextAttemptAt, undefined);
  assert.equal(failed.claimToken, undefined);
  assert.equal(graderCalls, 1);
  assert.equal(f.store.listRunEvaluationGrades(f.evaluation.id).length, 0);
});

test("a corrupt queue head fails without starving the next valid evaluation", async t => {
  const f = await fixture(t);
  const candidate = f.store.createArtifact({ id: "artifact-scheduler-valid-candidate", runId: f.run.id,
    type: "json", path: "evaluation/valid-candidate.json", sealedPayload: { count: 2, status: "ok" }, createdAt: now });
  const next = f.store.enqueueRunEvaluation({
    id: "evaluation-scheduler-2", runId: f.run.id,
    suiteId: "suite", suiteVersion: "1", suiteArtifactId: f.suite.id,
    caseId: "case", caseVersion: "1", caseArtifactId: f.testCase.id,
    baselineId: "baseline", baselineVersion: "1", baselineArtifactId: f.baseline.id,
    candidateArtifactId: candidate.id, now,
  }).evaluation;
  replaceArtifactBody(f, f.candidate.id, { status: "invalid-head" });
  const errors = [];
  const scheduler = new RunEvaluationSchedulerRegistry({ enabled: true, concurrency: 1,
    scanIntervalMs: 60_000, onError: error => { errors.push(error); } });
  t.after(async () => { scheduler.beginShutdown(); await scheduler.waitForIdle(); });
  scheduler.registerStore(f.store);
  await waitFor(() => f.store.getRunEvaluation(next.id).state === "completed");
  scheduler.beginShutdown();
  await scheduler.waitForIdle();
  assert.equal(f.store.getRunEvaluation(f.evaluation.id).state, "failed");
  assert.equal(f.store.getRunEvaluation(f.evaluation.id).failureCode, "evaluation.result_invalid");
  assert.equal(f.store.listRunEvaluationGrades(f.evaluation.id).length, 0);
  assert.equal(f.store.listRunEvaluationGrades(next.id).length, 1);
  assert.deepEqual(errors, [], "a permanent bad input is a durable failure, not a worker crash");
});

function replaceArtifactBody(fixture, artifactId, payload) {
  const database = new DatabaseSync(resolveRuntimePaths(fixture.cwd).databasePath);
  try { database.prepare("UPDATE artifacts SET sealed_payload_json = ? WHERE id = ?").run(JSON.stringify(payload), artifactId); }
  finally { database.close(); }
}

test("transient grader failure requeues with backoff and a later scan completes", async (t) => {
  const f = await fixture(t);
  const failed = await processNextRunEvaluation({
    store: f.store,
    workerId: "rule-worker",
    now: later,
    retryDelayMs: 1_000,
    grade: async () => { throw new Error("temporary grader outage"); },
  });
  assert.equal(failed.disposition, "requeued");
  const queued = f.store.getRunEvaluation(f.evaluation.id);
  assert.equal(queued.state, "queued");
  assert.equal(queued.failureCode, "evaluation.grader_unavailable");
  assert.equal((await processNextRunEvaluation({
    store: f.store,
    workerId: "rule-worker",
    now: "2026-09-14T00:01:00.500Z",
  })).disposition, "idle");
  assert.equal((await processNextRunEvaluation({
    store: f.store,
    workerId: "rule-worker",
    now: "2026-09-14T00:01:01.000Z",
  })).disposition, "completed");
});

test("a worker that outlives its lease cannot publish a stale grade", async (t) => {
  const f = await fixture(t);
  const stale = await processNextRunEvaluation({
    store: f.store,
    workerId: "slow-worker",
    leaseMs: 1,
    grade: async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        graderType: "rule",
        graderId: "slow-rule",
        graderVersion: "1",
        verdict: "pass",
        score: 1,
      };
    },
  });
  assert.equal(stale.disposition, "claim_lost");
  assert.equal(f.store.listRunEvaluationGrades(f.evaluation.id).length, 0);
  assert.equal((await processNextRunEvaluation({ store: f.store, workerId: "recovery-worker" })).disposition, "completed");
  assert.equal(f.store.listRunEvaluationGrades(f.evaluation.id).length, 1);
});

test("scheduler registry contains worker failures and leaves the durable lease recoverable", async (t) => {
  const f = await fixture(t);
  const observed = [];
  const scheduler = new RunEvaluationSchedulerRegistry({
    enabled: true,
    leaseMs: 1,
    scanIntervalMs: 60_000,
    onError: (error) => observed.push(error),
    grade: () => {
      f.store.close();
      throw new Error("injected store failure");
    },
  });
  scheduler.registerStore(f.store);
  await waitFor(() => observed.length === 1);
  scheduler.beginShutdown();
  await scheduler.waitForIdle();
  assert.match(String(observed[0]), /database is not open|store failure/u);

  const recoveredStore = createSqliteRunStore(f.cwd);
  t.after(() => recoveredStore.close());
  const recovered = await processNextRunEvaluation({
    store: recoveredStore,
    workerId: "recovery-worker",
    now: new Date(Date.now() + 1_000).toISOString(),
  });
  assert.equal(recovered.disposition, "completed");
  assert.equal(recoveredStore.listRunEvaluationGrades(f.evaluation.id).length, 1);
});

test("scheduler registry drains multiple evaluations at independent concurrency one", async (t) => {
  const f = await fixture(t);
  const candidate2 = f.store.createArtifact({
    id: "artifact-scheduler-candidate-2",
    runId: f.run.id,
    type: "json",
    path: "evaluation/candidate-2.json",
    sealedPayload: { count: 2, status: "ok" },
    createdAt: now,
  });
  const second = f.store.enqueueRunEvaluation({
    id: "evaluation-scheduler-2",
    runId: f.run.id,
    suiteId: "suite",
    suiteVersion: "1",
    suiteArtifactId: f.suite.id,
    caseId: "case",
    caseVersion: "1",
    caseArtifactId: f.testCase.id,
    baselineId: "baseline",
    baselineVersion: "1",
    baselineArtifactId: f.baseline.id,
    candidateArtifactId: candidate2.id,
    now,
  }).evaluation;
  let active = 0;
  let maximumActive = 0;
  const scheduler = new RunEvaluationSchedulerRegistry({
    enabled: true,
    concurrency: 1,
    scanIntervalMs: 60_000,
    grade: async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return {
        graderType: "rule",
        graderId: "registry-fixture",
        graderVersion: "1",
        verdict: "pass",
        score: 1,
      };
    },
  });
  t.after(() => scheduler.beginShutdown());
  scheduler.registerStore(f.store);
  await waitFor(() => f.store.listRunEvaluationGrades(f.evaluation.id).length === 1
    && f.store.listRunEvaluationGrades(second.id).length === 1);
  scheduler.beginShutdown();
  await scheduler.waitForIdle();
  assert.equal(maximumActive, 1);
});

function validCase() {
  return {
    schemaVersion: 1,
    kind: "deterministic_json_rule",
    graderId: "json-contract",
    graderVersion: "1",
    failureSeverity: "error",
    assertions: [
      { type: "deep_equal" },
      { type: "number_range", candidatePath: ["count"], minimum: 1, maximum: 3 },
    ],
  };
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("scheduler did not drain evaluations before timeout");
}
