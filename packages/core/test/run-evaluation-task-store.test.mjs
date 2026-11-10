import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteRunStore, resolveRuntimePaths, digestRunEvaluationValue, runEvaluationTaskIdempotencyKey } from "../dist/index.js";
const now = "2026-10-10T00:00:00.000Z";
const later = "2026-10-10T00:01:00.000Z";
const expires = "2026-10-10T00:02:00.000Z";
const after = "2026-10-10T00:03:00.000Z";
const future = "2026-10-10T00:10:00.000Z";
async function emptyFixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-evaluation-task-"));
  const stores = [];
  const open = () => {
    const store = createSqliteRunStore(cwd);
    stores.push(store);
    return store;
  };
  const store = open();
  const database = new DatabaseSync(resolveRuntimePaths(cwd).databasePath);
  t.after(async () => {
    database.close();
    for (const item of stores) {
      try {
        item.close();
      } catch {}
    }
    await rm(cwd, {
      recursive: true,
      force: true
    });
  });
  return {
    cwd,
    store,
    database,
    open
  };
}
const methods = ["getRunEvaluationTask", "getRunEvaluationTaskAttempt", "getRunEvaluationTaskResult", "enqueueRunEvaluationTask", "listClaimableRunEvaluationTasks", "claimRunEvaluationTask", "renewRunEvaluationTaskLease", "admitRunEvaluationTaskDispatch", "completeRunEvaluationTask", "finishRunEvaluationTaskBeforeDispatch", "markRunEvaluationTaskDispatchUnknown", "reconcileExpiredRunEvaluationTaskAttemptsPage"];
for (const method of methods) test(`public task foundation exposes ${method}`, async t => {
  const f = await emptyFixture(t);
  assert.equal(typeof f.store[method], "function");
});
function value(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
}
function fence(pair, at = later) {
  return {
    taskId: pair.task.id,
    attemptId: pair.attempt.id,
    expectedTaskRevision: pair.task.revision,
    expectedAttemptRevision: pair.attempt.revision,
    claimOwner: pair.attempt.claimOwner,
    claimToken: pair.attempt.claimToken,
    now: at
  };
}
async function fixture(t) {
  const f = await emptyFixture(t);
  const {
    store
  } = f;
  const channel = store.createChannel({
    name: "Task foundation",
    boundPath: f.cwd
  }, now);
  const task = store.createTask({
    channelId: channel.id,
    title: "Task",
    prompt: "synthetic"
  }, now);
  const run = store.createRun({
    id: "task-source-run",
    cwd: f.cwd,
    taskId: task.id,
    providerName: "synthetic",
    providerModel: "fixture",
    taskSnapshot: {},
    providerSnapshot: {},
    requestSnapshot: {},
    createdAt: now
  });
  store.markRunSucceeded(run.id, now);
  f.sourceRun = store.getRun(run.id);
  f.artifact = (id, payload, runId = run.id) => {
    const artifact = store.createArtifact({
      id,
      runId,
      type: "json",
      path: `synthetic/${id}.json`,
      sealedPayload: payload,
      createdAt: now
    });
    return {
      artifactId: id,
      contentSha256: artifact.contentSha256
    };
  };
  const suite = f.artifact("task-suite", {
      id: "suite",
      version: "1"
    }),
    testCase = f.artifact("task-case", {
      id: "case",
      version: "1"
    }),
    baseline = f.artifact("task-baseline", {
      answer: "ok"
    }),
    candidate = f.artifact("task-candidate", {
      answer: "ok"
    });
  const evaluation = store.enqueueRunEvaluation({
    id: "task-evaluation",
    runId: run.id,
    suiteId: "suite",
    suiteVersion: "1",
    suiteArtifactId: suite.artifactId,
    caseId: "case",
    caseVersion: "1",
    caseArtifactId: testCase.artifactId,
    baselineId: "baseline",
    baselineVersion: "1",
    baselineArtifactId: baseline.artifactId,
    candidateArtifactId: candidate.artifactId,
    now
  }).evaluation;
  assert.equal(store.claimRunEvaluation({
    evaluationId: evaluation.id,
    expectedRevision: 0,
    claimOwner: "rule",
    claimToken: "rule-token",
    claimExpiresAt: future,
    now
  }).ok, true);
  assert.equal(store.startRunEvaluation({
    evaluationId: evaluation.id,
    expectedRevision: 1,
    claimOwner: "rule",
    claimToken: "rule-token",
    now
  }).ok, true);
  assert.equal(store.completeRunEvaluation({
    evaluationId: evaluation.id,
    expectedRevision: 2,
    claimOwner: "rule",
    claimToken: "rule-token",
    now,
    grade: {
      graderType: "rule",
      graderId: "rule",
      graderVersion: "1",
      verdict: "pass"
    }
  }).ok, true);
  f.frozen = {
    graderId: "model-grader",
    graderVersion: "1",
    promptDigest: "1".repeat(64),
    modelId: "synthetic",
    modelVersion: "1",
    samplingDigest: "2".repeat(64),
    rubricDigest: "3".repeat(64)
  };
  f.frozenPin = f.artifact("task-frozen", f.frozen);
  f.raw = f.artifact("task-raw", {
    verdict: "pass",
    synthetic: true
  });
  f.enqueue = {
    evaluationId: evaluation.id,
    evaluationKey: evaluation.idempotencyKey,
    frozenGraderArtifact: f.frozenPin,
    frozenGraderDigest: digestRunEvaluationValue(f.frozen),
    repeatOrdinal: 1,
    now
  };
  f.task = value(store.enqueueRunEvaluationTask(f.enqueue));
  f.evaluation = store.getRunEvaluation(evaluation.id);
  f.claim = (token = "task-token", chosen = store) => value(chosen.claimRunEvaluationTask({
    taskId: f.task.id,
    expectedTaskRevision: chosen.getRunEvaluationTask(f.task.id).revision,
    claimOwner: "worker",
    claimToken: token,
    claimExpiresAt: expires,
    now: later
  }));
  f.admit = (pair, at = later) => value(store.admitRunEvaluationTaskDispatch({
    ...fence(pair, at),
    requestDigest: "a".repeat(64),
    executionScopeDigest: "b".repeat(64)
  }));
  f.result = {
    verdict: "pass",
    rawOutputArtifact: f.raw
  };
  return f;
}
test("renew before dispatch rejects the old dual-revision admission fence", async t => {
  const f = await fixture(t),
    claimed = f.claim();
  value(f.store.renewRunEvaluationTaskLease({
    ...fence(claimed),
    claimExpiresAt: future
  }));
  const result = f.store.admitRunEvaluationTaskDispatch({
    ...fence(claimed),
    requestDigest: "a".repeat(64),
    executionScopeDigest: "b".repeat(64)
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "stale_revision");
  assert.equal(f.database.prepare("SELECT COUNT(*) n FROM run_evaluation_task_attempts WHERE invocation_id IS NOT NULL").get().n, 0);
});
test("renew after dispatch rejects the old dual-revision completion fence", async t => {
  const f = await fixture(t),
    admitted = f.admit(f.claim());
  value(f.store.renewRunEvaluationTaskLease({
    ...fence(admitted),
    claimExpiresAt: future
  }));
  const result = f.store.completeRunEvaluationTask({
    ...fence(admitted),
    result: f.result
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "stale_revision");
  assert.equal(f.store.getRunEvaluationTaskResult(f.task.id), undefined);
});
test("identity replay is stable; cloned locator or key encoding cannot manufacture a repeat", async t => {
  const f = await fixture(t);
  assert.equal(value(f.store.enqueueRunEvaluationTask(f.enqueue)).id, f.task.id);
  for (const [id, payload] of [["clone", f.frozen], ["reordered", Object.fromEntries(Object.entries(f.frozen).reverse())]]) {
    const pin = f.artifact(id, payload),
      result = f.store.enqueueRunEvaluationTask({
        ...f.enqueue,
        frozenGraderArtifact: pin
      });
    assert.equal(result.ok, false);
    assert.equal(result.code, "identity_conflict");
  }
  assert.equal(f.database.prepare("SELECT COUNT(*) n FROM run_evaluation_tasks").get().n, 1);
  assert.notEqual(value(f.store.enqueueRunEvaluationTask({
    ...f.enqueue,
    repeatOrdinal: 2
  })).id, f.task.id);
});
test("two SQLite connections compete for one claim; same-token replay creates no new attempt", async t => {
  const f = await fixture(t),
    second = f.open();
  const claimed = f.claim();
  const replay = second.claimRunEvaluationTask({
    taskId: f.task.id,
    expectedTaskRevision: 0,
    claimOwner: "worker",
    claimToken: "task-token",
    claimExpiresAt: expires,
    now: later
  });
  assert.equal(replay.ok, true);
  assert.equal(replay.replayed, true);
  assert.equal(replay.value.attempt.id, claimed.attempt.id);
  assert.equal(second.claimRunEvaluationTask({
    taskId: f.task.id,
    expectedTaskRevision: 0,
    claimOwner: "worker",
    claimToken: "competitor",
    claimExpiresAt: expires,
    now: later
  }).code, "stale_revision");
  assert.equal(f.database.prepare("SELECT COUNT(*) n FROM run_evaluation_task_attempts").get().n, 1);
});
test("same-owner fresh-token ABA fences reject old target after safe pre-dispatch recovery", async t => {
  const f = await fixture(t),
    old = f.claim();
  value(f.store.reconcileExpiredRunEvaluationTaskAttempt({
    taskId: f.task.id,
    attemptId: old.attempt.id,
    now: after
  }));
  const queued = f.store.getRunEvaluationTask(f.task.id);
  const fresh = value(f.store.claimRunEvaluationTask({
    taskId: f.task.id,
    expectedTaskRevision: queued.revision,
    claimOwner: "worker",
    claimToken: "fresh-token",
    claimExpiresAt: future,
    now: after
  }));
  const oldRecovery = f.store.reconcileExpiredRunEvaluationTaskAttempt({
    taskId: f.task.id,
    attemptId: old.attempt.id,
    now: after
  });
  assert.equal(oldRecovery.code, "invalid_transition");
  assert.equal(f.store.admitRunEvaluationTaskDispatch({
    ...fence(old, after),
    requestDigest: "a".repeat(64),
    executionScopeDigest: "b".repeat(64)
  }).ok, false);
  assert.equal(f.store.getRunEvaluationTask(f.task.id).activeAttemptId, fresh.attempt.id);
});
test("admission mints one invocation; exact replay never grants a second dispatch", async t => {
  const f = await fixture(t),
    claimed = f.claim(),
    input = {
      ...fence(claimed),
      requestDigest: "a".repeat(64),
      executionScopeDigest: "b".repeat(64)
    };
  const admitted = value(f.store.admitRunEvaluationTaskDispatch(input));
  assert.equal(admitted.mayDispatch, true);
  const replay = f.store.admitRunEvaluationTaskDispatch(input);
  assert.equal(replay.ok, true);
  assert.equal(replay.replayed, true);
  assert.equal(replay.value.mayDispatch, false);
  assert.equal(replay.value.attempt.invocationId, admitted.attempt.invocationId);
  const conflict = f.store.admitRunEvaluationTaskDispatch({
    ...fence(admitted),
    requestDigest: "c".repeat(64),
    executionScopeDigest: "b".repeat(64)
  });
  assert.equal(conflict.code, "identity_conflict");
});
test("completion commits independent unverified result and terminal pair atomically; exact replay is no-op", async t => {
  const f = await fixture(t),
    admitted = f.admit(f.claim()),
    input = {
      ...fence(admitted),
      result: {
        ...f.result,
        costInputTokens: 12
      }
    };
  const completed = value(f.store.completeRunEvaluationTask(input));
  assert.equal(completed.task.state, "completed");
  assert.equal(completed.attempt.state, "completed");
  assert.equal(completed.result.authority, "unverified");
  assert.equal(completed.result.costInputTokens, 12);
  assert.equal(completed.result.costAmountMicros, undefined);
  const replay = f.store.completeRunEvaluationTask(input);
  assert.equal(replay.ok, true);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.value.result, completed.result);
  assert.equal(f.store.completeRunEvaluationTask({
    ...input,
    result: {
      ...input.result,
      verdict: "fail"
    }
  }).code, "result_conflict");
  assert.equal(f.database.prepare("SELECT COUNT(*) n FROM run_evaluation_task_results").get().n, 1);
  assert.deepEqual(f.store.getRun(f.sourceRun.id), f.sourceRun);
  assert.deepEqual(f.store.getRunEvaluation(f.evaluation.id), f.evaluation);
  assert.equal(f.store.listRunEvaluationGrades(f.evaluation.id).length, 1);
  assert.equal(f.database.prepare("SELECT COUNT(*) n FROM runtime_semaphore_slots").get().n, 0);
  assert.deepEqual(f.open().getRunEvaluationTaskResult(f.task.id), completed.result);
  assert.throws(() => f.database.prepare("UPDATE run_evaluation_task_results SET verdict='fail' WHERE task_id=?").run(f.task.id), /evaluation.task_invalid/u);
  assert.throws(() => f.database.prepare("DELETE FROM run_evaluation_task_results WHERE task_id=?").run(f.task.id), /evaluation.task_invalid/u);
});
for (const cut of ["before_claim", "after_claim", "after_admission", "after_settlement"]) test(`real reopen at crash cut ${cut} preserves outcome and never auto-resends`, async t => {
  const f = await fixture(t);
  let pair;
  if (cut !== "before_claim") pair = f.claim();
  if (cut === "after_admission" || cut === "after_settlement") pair = f.admit(pair);
  if (cut === "after_settlement") value(f.store.completeRunEvaluationTask({
    ...fence(pair),
    result: f.result
  }));
  const reopened = f.open();
  if (pair && cut !== "after_settlement") value(reopened.reconcileExpiredRunEvaluationTaskAttempt({
    taskId: f.task.id,
    attemptId: pair.attempt.id,
    now: after
  }));
  const task = reopened.getRunEvaluationTask(f.task.id);
  assert.equal(task.state, cut === "after_admission" ? "unknown_outcome" : cut === "after_settlement" ? "completed" : "queued");
  assert.equal(reopened.listClaimableRunEvaluationTasks({
    now: after
  }).length, task.state === "queued" ? 1 : 0);
  if (cut === "after_admission") {
    assert.equal(reopened.getRunEvaluationTaskResult(f.task.id), undefined);
    assert.equal(reopened.completeRunEvaluationTask({
      ...fence(pair, after),
      result: f.result
    }).ok, false);
  }
});
test("bounded recovery cursor advances discovery and exhausted unknown tasks remain unclaimable", async t => {
  const f = await fixture(t);
  const tasks = [f.task, value(f.store.enqueueRunEvaluationTask({
    ...f.enqueue,
    repeatOrdinal: 2
  })), value(f.store.enqueueRunEvaluationTask({
    ...f.enqueue,
    repeatOrdinal: 3
  }))];
  for (const task of tasks) value(f.store.claimRunEvaluationTask({
    taskId: task.id,
    expectedTaskRevision: 0,
    claimOwner: "worker",
    claimToken: `token-${task.repeatOrdinal}`,
    claimExpiresAt: expires,
    now: later
  }));
  const first = f.store.reconcileExpiredRunEvaluationTaskAttemptsPage({
    now: after,
    limit: 1
  });
  assert.equal(first.examinedCount, 1);
  assert.equal(first.changed.length, 1);
  assert.ok(first.nextCursor);
  const second = f.store.reconcileExpiredRunEvaluationTaskAttemptsPage({
    now: after,
    limit: 1,
    cursor: first.nextCursor
  });
  assert.equal(second.changed.length, 1);
  assert.ok(second.nextCursor);
  const last = f.store.reconcileExpiredRunEvaluationTaskAttemptsPage({
    now: after,
    limit: 1,
    cursor: second.nextCursor
  });
  assert.equal(last.changed.length, 1);
  assert.equal(last.nextCursor, undefined);
});
test("unknown terminal resists late completion, new claim, SQL resurrection and reopening", async t => {
  const f = await fixture(t),
    pair = f.admit(f.claim());
  value(f.store.markRunEvaluationTaskDispatchUnknown(fence(pair)));
  assert.equal(f.store.completeRunEvaluationTask({
    ...fence(pair),
    result: f.result
  }).ok, false);
  assert.equal(f.store.claimRunEvaluationTask({
    taskId: f.task.id,
    expectedTaskRevision: f.store.getRunEvaluationTask(f.task.id).revision,
    claimOwner: "worker",
    claimToken: "retry",
    claimExpiresAt: future,
    now: later
  }).code, "invalid_transition");
  assert.equal(f.open().getRunEvaluationTask(f.task.id).state, "unknown_outcome");
  assert.equal(f.store.getRunEvaluationTaskResult(f.task.id), undefined);
  assert.throws(() => f.database.prepare("UPDATE run_evaluation_tasks SET state='active',completed_at=NULL WHERE id=?").run(f.task.id), /evaluation.task_invalid/u);
});
test("safe before-dispatch defer is recoverable but dispatch cannot claim a safe cancellation", async t => {
  const f = await fixture(t),
    claimed = f.claim();
  value(f.store.finishRunEvaluationTaskBeforeDispatch({
    ...fence(claimed),
    nextState: "queued",
    failureCode: "evaluation.task_invalid",
    nextAttemptAt: after
  }));
  assert.equal(f.store.listClaimableRunEvaluationTasks({
    now: later
  }).length, 0);
  assert.equal(f.store.listClaimableRunEvaluationTasks({
    now: after
  }).length, 1);
  const fresh = value(f.store.claimRunEvaluationTask({
    taskId: f.task.id,
    expectedTaskRevision: f.store.getRunEvaluationTask(f.task.id).revision,
    claimOwner: "worker",
    claimToken: "second",
    claimExpiresAt: future,
    now: after
  }));
  const admitted = f.admit(fresh, after);
  assert.equal(f.store.finishRunEvaluationTaskBeforeDispatch({
    ...fence(admitted, after),
    nextState: "cancelled",
    failureCode: "evaluation.cancelled_before_dispatch"
  }).code, "invalid_transition");
});
for (const target of ["task-frozen", "task-candidate"]) test(`admission revalidates actual ${target} bytes even when saved hash is unchanged`, async t => {
  const f = await fixture(t),
    claimed = f.claim();
  f.database.prepare("UPDATE artifacts SET sealed_payload_json=? WHERE id=?").run(JSON.stringify({
    tampered: true
  }), target);
  const result = f.store.admitRunEvaluationTaskDispatch({
    ...fence(claimed),
    requestDigest: "a".repeat(64),
    executionScopeDigest: "b".repeat(64)
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "evaluation.artifact_invalid");
  assert.equal(f.store.getRunEvaluationTaskAttempt(claimed.attempt.id).invocationId, undefined);
});
test("atomic result settlement rolls back result and both states when terminal task update fails", async t => {
  const f = await fixture(t),
    pair = f.admit(f.claim());
  f.database.exec("CREATE TRIGGER injected_settlement_failure BEFORE UPDATE ON run_evaluation_tasks WHEN NEW.state='completed' BEGIN SELECT RAISE(ABORT,'injected'); END");
  assert.throws(() => f.store.completeRunEvaluationTask({
    ...fence(pair),
    result: f.result
  }), /evaluation.task_invalid/u);
  assert.equal(f.store.getRunEvaluationTaskResult(f.task.id), undefined);
  assert.deepEqual(f.store.getRunEvaluationTask(f.task.id), pair.task);
  assert.deepEqual(f.store.getRunEvaluationTaskAttempt(pair.attempt.id), pair.attempt);
  f.database.exec("DROP TRIGGER injected_settlement_failure");
  value(f.store.completeRunEvaluationTask({
    ...fence(pair),
    result: f.result
  }));
});
test("failed nested BEGIN does not roll back caller-owned transaction", async t => {
  const f = await fixture(t);
  f.store.database.exec("BEGIN IMMEDIATE;");
  try {
    assert.throws(() => f.store.enqueueRunEvaluationTask({
      ...f.enqueue,
      repeatOrdinal: 2
    }), /transaction/u);
    assert.equal(f.store.database.isTransaction, true);
  } finally {
    f.store.database.exec("ROLLBACK;");
  }
});
test("public helpers and inputs refuse getters, hidden/symbol fields, prototypes, undefined and extended years", async t => {
  const f = await fixture(t);
  let reads = 0;
  const identity = {
    ...f.enqueue
  };
  delete identity.now;
  Object.defineProperty(identity, "repeatOrdinal", {
    get() {
      reads++;
      throw new Error("secret");
    },
    enumerable: true
  });
  assert.throws(() => runEvaluationTaskIdempotencyKey(identity), /evaluation.task_invalid/u);
  assert.equal(reads, 0);
  for (const invalid of [{
    ...f.enqueue,
    now: "+010000-01-01T00:00:00.000Z"
  }, {
    ...f.enqueue,
    repeatOrdinal: 0
  }, {
    ...f.enqueue,
    repeatOrdinal: Number.MAX_SAFE_INTEGER
  }, {
    ...f.enqueue,
    authenticated: true
  }, Object.assign(Object.create({
    bad: true
  }), f.enqueue)]) assert.throws(() => f.store.enqueueRunEvaluationTask(invalid), /evaluation.task_invalid/u);
  const pair = f.admit(f.claim());
  const input = {
    ...fence(pair),
    result: {
      ...f.result,
      latencyMs: undefined
    }
  };
  assert.throws(() => f.store.completeRunEvaluationTask(input), /evaluation.task_invalid/u);
  const hidden = {
    ...fence(pair)
  };
  Object.defineProperty(hidden, "hidden", {
    value: true
  });
  assert.throws(() => f.store.markRunEvaluationTaskDispatchUnknown(hidden), /evaluation.task_invalid/u);
  assert.equal(f.store.getRunEvaluationTaskResult(f.task.id), undefined);
});
test("completion rejects cross-task attempt/result artifact owners and unbounded result bodies", async t => {
  const f = await fixture(t),
    pair = f.admit(f.claim());
  const wrong = value(f.store.enqueueRunEvaluationTask({
    ...f.enqueue,
    repeatOrdinal: 2
  }));
  assert.equal(f.store.completeRunEvaluationTask({
    ...fence(pair),
    taskId: wrong.id,
    result: f.result
  }).code, "lease_mismatch");
  const otherRun = f.store.createRun({
    id: "other-run",
    cwd: f.cwd,
    taskId: f.sourceRun.taskId,
    providerName: "synthetic",
    providerModel: "fixture",
    taskSnapshot: {},
    providerSnapshot: {},
    requestSnapshot: {},
    createdAt: now
  });
  const foreign = f.artifact("foreign-raw", {
    ok: true
  }, otherRun.id);
  assert.equal(f.store.completeRunEvaluationTask({
    ...fence(pair),
    result: {
      ...f.result,
      rawOutputArtifact: foreign
    }
  }).code, "evaluation.artifact_invalid");
  const huge = f.artifact("huge-raw", {
    text: "x".repeat(1_048_577)
  });
  assert.throws(() => f.store.completeRunEvaluationTask({
    ...fence(pair),
    result: {
      ...f.result,
      rawOutputArtifact: huge
    }
  }), /evaluation.task_invalid/u);
});
