import assert from "node:assert/strict";
import test from "node:test";
import { qaFixture, value, fence, later, expires } from "./support/evaluation-qa-fixture.mjs";

test("owned QA selection sees its first task beyond 100 unrelated ordinary and old-batch tasks", async t => {
  const f = await qaFixture(t), oldBatch = f.newBatch();
  const normal = [];
  for (let ordinal = 1; ordinal <= 101; ordinal++) normal.push(value(f.store.enqueueRunEvaluationTask({ ...f.enqueue, repeatOrdinal: ordinal })));
  const oldBatchTasks = [];
  for (let ordinal = 102; ordinal <= 203; ordinal++) oldBatchTasks.push(f.enroll(ordinal, oldBatch));
  const target = f.enroll(204);
  // Arrange the exact prefix deterministically without depending on UUID ordering.
  f.database.prepare("UPDATE run_evaluation_tasks SET next_attempt_at=? WHERE id=?").run(later, target.taskId);
  const prefix = f.store.listClaimableRunEvaluationTasks({ now: later, limit: 100 });
  assert.equal(prefix.length, 100);
  assert.ok(prefix.every(task => task.id !== target.taskId));
  assert.deepEqual(f.store.listClaimableRunEvaluationQaTasks({ batchId: f.batch.id, configDigest: f.batch.configDigest, now: later, limit: 1 }).map(task => task.id), [target.taskId]);
  assert.deepEqual(f.store.listClaimableRunEvaluationQaTasks({ batchId: f.batch.id, now: later, limit: 1 }).map(task => task.id), [target.taskId]);
  assert.deepEqual(f.store.listClaimableRunEvaluationQaTasks({ batchId: f.batch.id, configDigest: "e".repeat(64), now: later, limit: 1 }), []);
  assert.equal(f.counts().run_evaluation_qa_requests, 0);
  assert.equal(f.store.getRunEvaluationQaScope().laneState, "available");
  assert.ok(normal.every(task => f.store.getRunEvaluationTask(task.id).state === "queued"));
  assert.ok(oldBatchTasks.every(item => f.store.getRunEvaluationTask(item.taskId).state === "queued"));
});

test("QA selection is readonly, correctly ordered and due-only; two connections still compete using158 claim CAS", async t => {
  const f = await qaFixture(t), a = f.enroll(1), b = f.enroll(2), c = f.enroll(3), future = "2026-10-10T01:00:00.000Z";
  f.database.prepare("UPDATE run_evaluation_tasks SET next_attempt_at=? WHERE id=?").run(later, a.taskId);
  f.database.prepare("UPDATE run_evaluation_tasks SET next_attempt_at=? WHERE id=?").run(future, c.taskId);
  const before = f.counts(), scope = f.store.getRunEvaluationQaScope();
  assert.deepEqual(f.store.listClaimableRunEvaluationQaTasks({ batchId: f.batch.id, now: later, limit: 2 }).map(task => task.id), [b.taskId, a.taskId]);
  assert.deepEqual(f.counts(), before);
  assert.deepEqual(f.store.getRunEvaluationQaScope(), scope);
  const second = f.open(), firstCandidate = f.store.listClaimableRunEvaluationQaTasks({ batchId: f.batch.id, now: later, limit: 1 })[0];
  assert.equal(second.listClaimableRunEvaluationQaTasks({ batchId: f.batch.id, now: later, limit: 1 })[0].id, firstCandidate.id);
  const claimed = f.claim(b);
  assert.equal(second.claimRunEvaluationTask({ taskId: b.taskId, expectedTaskRevision: firstCandidate.revision, claimOwner: "competitor", claimToken: "competing-candidate", claimExpiresAt: expires, now: later }).code, "stale_revision");
  assert.deepEqual(second.listClaimableRunEvaluationQaTasks({ batchId: f.batch.id, now: later, limit: 2 }).map(task => task.id), [a.taskId]);
  value(f.store.finishRunEvaluationTaskBeforeDispatch({ ...fence(claimed), nextState: "queued", failureCode: "evaluation.task_invalid", nextAttemptAt: future }));
  assert.deepEqual(f.store.listClaimableRunEvaluationQaTasks({ batchId: f.batch.id, now: later, limit: 2 }).map(task => task.id), [a.taskId]);
  assert.equal(f.store.listClaimableRunEvaluationQaTasks({ batchId: "missing", now: later, limit: 1 }).length, 0);
});

test("QA current-batch selector validates own-data and bounded limits before reading queue", async t => {
  const f = await qaFixture(t); let getterReads = 0;
  assert.throws(() => f.store.listClaimableRunEvaluationQaTasks({ batchId: f.batch.id, get now() { getterReads++; return later; }, limit: 1 }), /evaluation.task_invalid/u);
  assert.equal(getterReads, 0);
  for (const limit of [0, 501, -1, 1.5]) assert.throws(() => f.store.listClaimableRunEvaluationQaTasks({ batchId: f.batch.id, now: later, limit }), /evaluation.task_invalid/u);
  assert.throws(() => f.store.listClaimableRunEvaluationQaTasks({ batchId: f.batch.id, configDigest: undefined, now: later, limit: 1 }), /evaluation.task_invalid/u);
  assert.throws(() => f.store.listClaimableRunEvaluationQaTasks(Object.assign(Object.create({}), { batchId: f.batch.id, now: later, limit: 1 })), /evaluation.task_invalid/u);
  assert.equal(f.counts().run_evaluation_tasks, 0);
});

test("QA current-batch query plan confines enrollment scan to(batch_id,task_id) before sorting/limit", async t => {
  const f = await qaFixture(t);
  const input = { batchId: f.batch.id, configDigest: f.batch.configDigest, now: later, limit: 1 }, scope = f.store.getRunEvaluationQaScope();
  const sql = `SELECT t.* FROM run_evaluation_qa_batches b
    JOIN run_evaluation_qa_enrollments e INDEXED BY idx_evaluation_qa_enrollment_batch_task ON e.batch_id=b.id
    JOIN run_evaluation_tasks t ON t.id=e.task_id
    WHERE b.id=? AND b.namespace_id=? AND b.config_digest=?
      AND t.state='queued' AND (t.next_attempt_at IS NULL OR t.next_attempt_at<=?)
    ORDER BY COALESCE(t.next_attempt_at,t.created_at),t.created_at,t.id LIMIT ?`;
  const plan = f.database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(input.batchId, scope.namespaceId, input.configDigest, input.now, input.limit).map(row => row.detail);
  assert.ok(plan.some(detail => detail.includes("idx_evaluation_qa_enrollment_batch_task") && detail.includes("batch_id=?")), JSON.stringify(plan));
  assert.ok(plan.some(detail => detail.includes("sqlite_autoindex_run_evaluation_tasks_1") && detail.includes("id=?")), JSON.stringify(plan));
  assert.ok(plan.every(detail => !/^SCAN (?:e|t)\b/u.test(detail)), JSON.stringify(plan));
  // A sort within this one batch is permitted; this does not claim O(limit) examined rows.
  const columns = f.database.prepare("PRAGMA index_xinfo(idx_evaluation_qa_enrollment_batch_task)").all().filter(row => row.key === 1);
  assert.deepEqual(columns.map(row => ({ name: row.name, desc: row.desc, coll: row.coll })), [{ name: "batch_id", desc: 0, coll: "BINARY" }, { name: "task_id", desc: 0, coll: "BINARY" }]);
});
