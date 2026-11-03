import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { digestRunEvaluationValue } from "../dist/index.js";
import { SqliteRunEvaluationQaStore } from "../dist/storage/sqlite/run-evaluation-qa-store.js";
import { qaFixture, value, fence, now, later, expires, after } from "./support/evaluation-qa-fixture.mjs";

test("explicit QA enroll+enqueue pins all artifacts; replay is stable; old Run/grade unchanged", async t => {
  const f = await qaFixture(t), beforeRun = f.store.getRun(f.run.id), beforeGrades = f.counts().run_evaluation_grades;
  assert.equal(f.counts().run_evaluation_tasks, 0);
  const enrollment = f.enroll(), repeated = f.store.enrollRunEvaluationQaTask(f.enrollInput());
  assert.equal(repeated.replayed, true);
  assert.deepEqual(value(repeated), enrollment);
  assert.deepEqual(enrollment.artifactPins, f.pins);
  assert.equal(f.counts().run_evaluation_tasks, 1);
  assert.equal(f.counts().run_evaluation_qa_requests, 0);
  assert.deepEqual(f.store.getRun(f.run.id), beforeRun);
  assert.equal(f.counts().run_evaluation_grades, beforeGrades);
});
for (const field of ["suite", "case", "baseline", "candidate", "frozen"]) test(`wrong physical ${field} pin rolls enrollment and enqueue fully back`, async t => {
  const f = await qaFixture(t), before = f.counts(), scope = f.store.getRunEvaluationQaScope();
  const input = f.enrollInput();
  input.artifactPins = { ...input.artifactPins, [field]: { ...input.artifactPins[field], contentSha256: "e".repeat(64) } };
  assert.equal(f.store.enrollRunEvaluationQaTask(input).code, "identity_conflict");
  assert.deepEqual(f.counts(), before);
  assert.deepEqual(f.store.getRunEvaluationQaScope(), scope);
});
test("enrollment identity cannot be reassigned to new batch/review or retrofit used task", async t => {
  const f = await qaFixture(t), enrolled = f.enroll();
  assert.equal(f.store.enrollRunEvaluationQaTask({ ...f.enrollInput(), batchId: f.newBatch().id }).code, "identity_conflict");
  assert.equal(f.store.enrollRunEvaluationQaTask({ ...f.enrollInput(), reviewRef: "different-review" }).code, "identity_conflict");
  assert.equal(f.counts().run_evaluation_tasks, 1);
  const ordinaryTask = value(f.store.enqueueRunEvaluationTask({ ...f.enqueue, repeatOrdinal: 2 }));
  f.claim({ taskId: ordinaryTask.id, id: ordinaryTask.id });
  assert.equal(f.store.enrollRunEvaluationQaTask(f.enrollInput(2)).code, "invalid_transition");
  assert.equal(f.store.getRunEvaluationQaEnrollment(ordinaryTask.id), undefined);
  assert.equal(enrolled.taskId, f.store.getRunEvaluationQaEnrollment(enrolled.taskId).taskId);
});
test("unenrolled normal task is not QA; enrolled task cannot use old 158 admission", async t => {
  const f = await qaFixture(t), ordinary = value(f.store.enqueueRunEvaluationTask({ ...f.enqueue, repeatOrdinal: 2 })), ordinaryClaim = f.claim({ taskId: ordinary.id, id: ordinary.id });
  assert.equal(f.store.admitRunEvaluationQaRequest(f.admissionInput(ordinaryClaim)).code, "qa_not_enrolled");
  const normal = value(f.store.admitRunEvaluationTaskDispatch({ ...fence(ordinaryClaim), requestDigest: "a".repeat(64), executionScopeDigest: "b".repeat(64) }));
  assert.equal(normal.mayDispatch, true);
  assert.equal(f.counts().run_evaluation_qa_requests, 0);
  const claimed = f.claim(f.enroll());
  assert.equal(f.store.admitRunEvaluationTaskDispatch({ ...fence(claimed), requestDigest: "a".repeat(64), executionScopeDigest: "b".repeat(64) }).code, "invalid_transition");
  assert.equal(f.store.getRunEvaluationTaskAttempt(claimed.attempt.id).state, "claimed");
  assert.equal(f.store.getRunEvaluationQaScope().laneState, "available");
});
for (const violation of ["config", "batch", "bytes", "estimated", "stale", "token"]) test(`pre-admission ${violation} rejection changes no task, lane or reservation`, async t => {
  const f = await qaFixture(t), claimed = f.claim(f.enroll()), input = f.admissionInput(claimed), before = f.counts(), scope = f.store.getRunEvaluationQaScope();
  if (violation === "config") input.configDigest = "e".repeat(64);
  if (violation === "batch") input.batchId = f.newBatch().id;
  if (violation === "bytes") input.payloadUtf8 = "你".repeat(10923);
  if (violation === "estimated") input.estimatedInputTokens = 8001;
  if (violation === "stale") input.expectedTaskRevision = 0;
  if (violation === "token") input.claimToken = "stale-token";
  const beforeCall = f.counts();
  assert.equal(f.store.admitRunEvaluationQaRequest(input).ok, false);
  assert.deepEqual(f.counts(), beforeCall);
  assert.deepEqual(f.store.getRunEvaluationQaScope(), scope);
  assert.deepEqual(f.store.getRunEvaluationTaskAttempt(claimed.attempt.id), claimed.attempt);
  assert.equal(before.run_evaluation_qa_requests, 0);
});
test("same-admission exact/historical replay never authorizes another transport; conflicts fail", async t => {
  const f = await qaFixture(t), claimed = f.claim(f.enroll()), input = f.admissionInput(claimed), admitted = f.admit(claimed), second = f.open();
  assert.equal(admitted.mayDispatch, true);
  const replay = second.admitRunEvaluationQaRequest(input);
  assert.equal(value(replay).mayDispatch, false);
  assert.equal(replay.replayed, true);
  assert.equal(value(replay).request.id, admitted.request.id);
  assert.equal(second.admitRunEvaluationQaRequest({ ...input, payloadUtf8: f.payloadUtf8 + " " }).code, "identity_conflict");
  assert.equal(second.admitRunEvaluationQaRequest({ ...input, estimatedInputTokens: 71 }).code, "identity_conflict");
  assert.equal(second.admitRunEvaluationQaRequest({ ...input, requestDigest: "f".repeat(64) }).code, "identity_conflict");
  assert.equal(f.counts().run_evaluation_qa_requests, 1);
});
test("two connections cannot admit another task while first local callback is live", async t => {
  const f = await qaFixture(t), second = f.open(), first = f.admit(f.claim(f.enroll())), other = f.claim(f.enroll(2), second);
  assert.equal(second.admitRunEvaluationQaRequest(f.admissionInput(other)).code, "qa_lane_busy");
  const done = f.complete(first);
  assert.equal(f.store.getRunEvaluationQaScope().laneState, "held");
  assert.equal(second.admitRunEvaluationQaRequest(f.admissionInput(other)).code, "qa_lane_busy");
  f.release(done.request);
  assert.equal(second.admitRunEvaluationQaRequest(f.admissionInput(other)).ok, true);
});
for (const cut of ["ledger", "lane"]) test(`fault after task admission at ${cut} rolls quota/lane/attempt fully back`, async t => {
  const f = await qaFixture(t), claimed = f.claim(f.enroll()), before = f.counts(), scope = f.store.getRunEvaluationQaScope();
  f.database.exec(cut === "ledger" ? "CREATE TRIGGER qa_inject BEFORE INSERT ON run_evaluation_qa_requests BEGIN SELECT RAISE(ABORT,'inject'); END" : "CREATE TRIGGER qa_inject BEFORE UPDATE ON run_evaluation_qa_namespace BEGIN SELECT RAISE(ABORT,'inject'); END");
  assert.throws(() => f.store.admitRunEvaluationQaRequest(f.admissionInput(claimed)), /evaluation.task_invalid/u);
  assert.deepEqual(f.counts(), before);
  assert.deepEqual(f.store.getRunEvaluationQaScope(), scope);
  assert.deepEqual(f.store.getRunEvaluationTaskAttempt(claimed.attempt.id), claimed.attempt);
});
test("settlement result/receipt/usage atomic; completed task still holds lane until real Host drain", async t => {
  const f = await qaFixture(t), admitted = f.admit(f.claim(f.enroll())), usage = { state: "measured", inputTokens: 42, outputTokens: 17 }, done = f.complete(admitted, f.store, usage);
  assert.equal(done.result.authority, "unverified");
  assert.equal(done.result.costInputTokens, 42);
  assert.deepEqual(done.request.usage, usage);
  assert.deepEqual(done.request.receipt, f.receipt(admitted.request, usage));
  assert.equal(f.store.getRunEvaluationQaScope().laneState, "held");
  assert.equal(f.store.completeRunEvaluationTask({ ...fence(done), result: f.result }).code, "invalid_transition");
  const replay = f.store.completeRunEvaluationQaRequest(f.completeInput(admitted, usage));
  assert.equal(replay.replayed, true);
  assert.deepEqual(value(replay).request, done.request);
  assert.equal(f.counts().run_evaluation_task_results, 1);
  assert.equal(f.counts().run_evaluation_grades, 1);
  f.release(done.request);
  assert.equal(f.store.getRunEvaluationQaScope().laneState, "available");
  assert.equal(f.counts().run_evaluation_qa_requests, 1);
});
test("task receipt lookup returns one allowlisted immutable binding and rejects cross-enrollment corruption", async t => {
  const f = await qaFixture(t), first = f.complete(f.admit(f.claim(f.enroll())));
  f.release(first.request);
  assert.deepEqual(f.store.getRunEvaluationQaRequestForTask(first.task.id), f.store.getRunEvaluationQaRequest(first.request.id));
  assert.equal("payloadUtf8" in f.store.getRunEvaluationQaRequestForTask(first.task.id), false);
  const task = f.store.getRunEvaluationTask(first.task.id);
  const corrupted = new SqliteRunEvaluationQaStore({ database: f.database }, {
    getRunEvaluationTask: () => ({ ...task, evaluationId: "foreign-evaluation" }),
  }, f.cwd, id => f.store.getArtifact(id));
  assert.throws(() => corrupted.getRunEvaluationQaRequestForTask(first.task.id), /evaluation.task_invalid/u);
});
test("fault in final receipt update rolls task result and terminal task/attempt back", async t => {
  const f = await qaFixture(t), admitted = f.admit(f.claim(f.enroll())), before = f.counts();
  f.database.exec("CREATE TRIGGER qa_inject BEFORE UPDATE OF receipt_json ON run_evaluation_qa_requests BEGIN SELECT RAISE(ABORT,'inject'); END");
  assert.throws(() => f.store.completeRunEvaluationQaRequest(f.completeInput(admitted)), /evaluation.task_invalid/u);
  assert.deepEqual(f.counts(), before);
  assert.equal(f.store.getRunEvaluationTask(admitted.task.id).state, "active");
  assert.equal(f.store.getRunEvaluationTaskAttempt(admitted.attempt.id).state, "dispatch_admitted");
  assert.equal(f.store.getRunEvaluationQaRequest(admitted.request.id).state, "admitted");
});
for (const violation of ["payload", "model", "missing_usage", "invented_zero", "amount", "over_output"]) test(`receipt ${violation} cannot settle result`, async t => {
  const f = await qaFixture(t), admitted = f.admit(f.claim(f.enroll())), input = f.completeInput(admitted, { state: "measured", inputTokens: 9, outputTokens: 3 });
  if (violation === "payload") input.receipt.payloadSha256 = "f".repeat(64);
  if (violation === "model") input.receipt.modelId = "other-model";
  if (violation === "missing_usage") delete input.result.costInputTokens;
  if (violation === "invented_zero") { input.receipt.usage = { state: "unknown" }; input.result.costInputTokens = 0; input.result.costOutputTokens = 0; }
  if (violation === "amount") input.result.costAmountMicros = 0;
  if (violation === "over_output") { input.receipt.usage.outputTokens = 1025; input.result.costOutputTokens = 1025; }
  assert.equal(f.store.completeRunEvaluationQaRequest(input).code, "qa_receipt_invalid");
  assert.equal(f.store.getRunEvaluationTaskResult(admitted.task.id), undefined);
  assert.equal(f.store.getRunEvaluationQaRequest(admitted.request.id).state, "admitted");
});
test("admitted unknown consumes slot forever, quarantines; callback drain/TTL cannot release", async t => {
  const f = await qaFixture(t), admitted = f.admit(f.claim(f.enroll()));
  const unknown = value(f.store.markRunEvaluationQaRequestUnknown({ ...fence(admitted), requestId: admitted.request.id }));
  assert.equal(unknown.state, "unknown");
  assert.equal(f.store.getRunEvaluationTask(admitted.task.id).state, "unknown_outcome");
  assert.equal(f.store.getRunEvaluationQaScope().laneState, "quarantined");
  assert.equal(f.store.releaseRunEvaluationQaLane({ requestId: unknown.id, expectedRequestRevision: unknown.revision, now: after, release: { kind: "host_callback_drained" } }).code, "qa_lane_quarantined");
  value(f.store.reconcileRunEvaluationQaScope({ now: "2026-10-20T00:00:00.000Z" }));
  assert.equal(f.store.getRunEvaluationQaScope().laneState, "quarantined");
  assert.equal(f.store.completeRunEvaluationQaRequest(f.completeInput(admitted)).code, "qa_lane_quarantined");
  value(f.store.releaseRunEvaluationQaLane({ requestId: unknown.id, expectedRequestRevision: unknown.revision, now: after, release: { kind: "host_explicit_reconciliation", auditRef: "host-audit:remote-reviewed" } }));
  assert.equal(f.store.getRunEvaluationQaRequest(unknown.id).reconciliationAuditRef, "host-audit:remote-reviewed");
  assert.equal(f.counts().run_evaluation_qa_requests, 1);
  assert.equal(f.store.getRunEvaluationTask(admitted.task.id).state, "unknown_outcome");
});
test("old158 exact expired recovery atomically quarantines QA ledger and never allows replay", async t => {
  const f = await qaFixture(t), admitted = f.admit(f.claim(f.enroll()));
  value(f.store.reconcileExpiredRunEvaluationTaskAttempt({ taskId: admitted.task.id, attemptId: admitted.attempt.id, now: after }));
  assert.equal(f.store.getRunEvaluationQaRequest(admitted.request.id).state, "unknown");
  assert.equal(f.store.getRunEvaluationQaScope().laneState, "quarantined");
  assert.equal(f.store.admitRunEvaluationQaRequest(f.admissionInput(admitted, f.batch, after)).code, "qa_lane_quarantined");
});
test("a new real process boot quarantines unreleased admission even while lease is live", async t => {
  const f = await qaFixture(t), admitted = f.admit(f.claim(f.enroll())), index = new URL("../dist/index.js", import.meta.url).href;
  const script = `import {createSqliteRunStore} from ${JSON.stringify(index)}; const s=createSqliteRunStore(${JSON.stringify(f.cwd)}); const before=s.getRunEvaluationQaScope(); const result=s.reconcileRunEvaluationQaScope({now:${JSON.stringify(later)}}); const request=s.getRunEvaluationQaRequest(${JSON.stringify(admitted.request.id)}); console.log(JSON.stringify({before,result,request})); s.close();`;
  const child = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "1" } }));
  assert.equal(child.before.laneState, "held"); // Read-only getter does not mutate.
  assert.equal(child.result.value.laneState, "quarantined");
  assert.equal(child.request.state, "unknown");
  assert.equal(f.store.getRunEvaluationTask(admitted.task.id).state, "unknown_outcome");
  assert.equal(f.counts().run_evaluation_qa_requests, 1);
  assert.equal(f.store.completeRunEvaluationQaRequest(f.completeInput(admitted)).code, "qa_lane_quarantined");
});
for (const releaseProcess of ["original", "new_boot"]) test(`completed undrained receipt survives new boot; explicit ${releaseProcess} reconciliation alone releases lane`, async t => {
  const f = await qaFixture(t), done = f.complete(f.admit(f.claim(f.enroll()))), index = new URL("../dist/index.js", import.meta.url).href;
  const script = `import {createSqliteRunStore} from ${JSON.stringify(index)}; const s=createSqliteRunStore(${JSON.stringify(f.cwd)}); const reconciled=s.reconcileRunEvaluationQaScope({now:${JSON.stringify(later)}}); const request=s.getRunEvaluationQaRequest(${JSON.stringify(done.request.id)}); const release=s.releaseRunEvaluationQaLane({requestId:request.id,expectedRequestRevision:request.revision,now:${JSON.stringify(later)},release:{kind:"host_callback_drained"}}); const explicit=${JSON.stringify(releaseProcess)} === "new_boot" ? s.releaseRunEvaluationQaLane({requestId:request.id,expectedRequestRevision:request.revision,now:${JSON.stringify(later)},release:{kind:"host_explicit_reconciliation",auditRef:"host-audit:completed-old-boot"}}):undefined; console.log(JSON.stringify({reconciled,request,release,explicit})); s.close();`;
  const child = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "1" } }));
  assert.equal(child.reconciled.value.laneState, "quarantined");
  assert.equal(child.request.state, "completed");
  assert.deepEqual(child.request.receipt, done.request.receipt);
  assert.equal(child.release.code, "qa_lane_quarantined");
  assert.equal(f.store.getRunEvaluationTask(done.task.id).state, "completed");
  if (releaseProcess === "original") {
    assert.equal(f.store.releaseRunEvaluationQaLane({ requestId: done.request.id, expectedRequestRevision: done.request.revision - 1, now: later, release: { kind: "host_explicit_reconciliation", auditRef: "host-audit:stale-revision" } }).code, "stale_revision");
    value(f.store.releaseRunEvaluationQaLane({ requestId: done.request.id, expectedRequestRevision: done.request.revision, now: later, release: { kind: "host_explicit_reconciliation", auditRef: "host-audit:completed-old-boot" } }));
  } else assert.equal(child.explicit.ok, true);
  assert.equal(f.store.getRunEvaluationQaScope().laneState, "available");
  assert.equal(f.counts().run_evaluation_qa_requests, 1);
  assert.equal(f.counts().run_evaluation_task_results, 1);
});
test("batch cap is three charged attempts, not completed successes or refunded unknowns", async t => {
  const f = await qaFixture(t);
  for (let ordinal = 1; ordinal <= 3; ordinal++) f.release(f.complete(f.admit(f.claim(f.enroll(ordinal)))).request);
  const fourth = f.claim(f.enroll(4)), before = f.counts(), scope = f.store.getRunEvaluationQaScope();
  assert.equal(f.store.admitRunEvaluationQaRequest(f.admissionInput(fourth)).code, "qa_batch_budget_exhausted");
  assert.deepEqual(f.counts(), before);
  assert.deepEqual(f.store.getRunEvaluationQaScope(), scope);
  assert.equal(f.store.getRunEvaluationTaskAttempt(fourth.attempt.id).state, "claimed");
});
test("three explicitly reconciled unknown requests exhaust batch without refund or successful grades", async t => {
  const f = await qaFixture(t);
  for (let ordinal = 1; ordinal <= 3; ordinal++) {
    const admitted = f.admit(f.claim(f.enroll(ordinal)));
    const unknown = value(f.store.markRunEvaluationQaRequestUnknown({ ...fence(admitted), requestId: admitted.request.id }));
    value(f.store.releaseRunEvaluationQaLane({ requestId: unknown.id, expectedRequestRevision: unknown.revision, now: later, release: { kind: "host_explicit_reconciliation", auditRef: `host-audit:unknown-${ordinal}` } }));
  }
  const claimed = f.claim(f.enroll(4));
  assert.equal(f.store.admitRunEvaluationQaRequest(f.admissionInput(claimed)).code, "qa_batch_budget_exhausted");
  assert.equal(f.counts().run_evaluation_qa_requests, 3);
  assert.equal(f.counts().run_evaluation_task_results, 0);
  assert.equal(f.counts().run_evaluation_grades, 1);
});
test("rolling cap survives config/provider snapshot changes, clock rollback and reopen", async t => {
  const f = await qaFixture(t);
  for (let ordinal = 1; ordinal <= 12; ordinal++) {
    let batch = ordinal === 1 ? f.batch : f.currentBatch;
    if (ordinal > 1 && ordinal % 3 === 1) {
      const config = { ...f.config, provider: `changed-provider:${ordinal}` }, pin = f.artifact(`qa-config-${ordinal}`, config);
      batch = value(f.store.createRunEvaluationQaBatch({ ...f.batchInput, configSnapshotRef: pin.artifactId, configDigest: digestRunEvaluationValue(config) }));
    }
    f.currentBatch = batch;
    f.release(f.complete(f.admit(f.claim(f.enroll(ordinal, batch)), batch)).request);
  }
  const fresh = f.newBatch(), enrolled = f.enroll(13, fresh), claimed = f.claim(enrolled), second = f.open();
  assert.equal(second.admitRunEvaluationQaRequest(f.admissionInput(claimed, fresh)).code, "qa_window_budget_exhausted");
  assert.equal(second.admitRunEvaluationQaRequest(f.admissionInput(claimed, fresh, now)).code, "qa_window_budget_exhausted");
  assert.equal(f.store.getRunEvaluationQaScope().clockHighWaterAt, later);
  assert.equal(f.counts().run_evaluation_qa_requests, 12);
  // Safe lease recovery before dispatch does not spend/refund a request slot.
  value(f.store.reconcileExpiredRunEvaluationTaskAttempt({ taskId: enrolled.taskId, attemptId: claimed.attempt.id, now: after }));
  const day = "2026-10-11T00:01:00.000Z", newClaim = f.claim(enrolled, second, day, "2026-10-11T00:10:00.000Z");
  assert.equal(second.admitRunEvaluationQaRequest(f.admissionInput(newClaim, fresh, day)).ok, true);
  assert.equal(f.counts().run_evaluation_qa_requests, 13);
});
test("release ABA cannot release a different live request; release fault rolls both row and lane back", async t => {
  const f = await qaFixture(t), one = f.complete(f.admit(f.claim(f.enroll()))), released = f.release(one.request), two = f.admit(f.claim(f.enroll(2)));
  assert.equal(f.store.releaseRunEvaluationQaLane({ requestId: one.request.id, expectedRequestRevision: released.revision, now: later, release: { kind: "host_callback_drained" } }).code, "invalid_transition");
  assert.equal(f.store.getRunEvaluationQaScope().laneRequestId, two.request.id);
  assert.equal(f.store.releaseRunEvaluationQaLane({ requestId: one.request.id, expectedRequestRevision: released.revision, now: later, release: { kind: "host_explicit_reconciliation", auditRef: "host-audit:old-request" } }).code, "invalid_transition");
  assert.equal(f.store.getRunEvaluationQaScope().laneRequestId, two.request.id);
  const done = f.complete(two), scope = f.store.getRunEvaluationQaScope();
  f.database.exec("CREATE TRIGGER qa_inject BEFORE UPDATE ON run_evaluation_qa_namespace BEGIN SELECT RAISE(ABORT,'inject'); END");
  assert.throws(() => f.release(done.request), /evaluation.task_invalid/u);
  assert.deepEqual(f.store.getRunEvaluationQaRequest(done.request.id), done.request);
  assert.deepEqual(f.store.getRunEvaluationQaScope(), scope);
});
test("own-data validation rejects getters/custom prototypes and missing explicit audit without evaluation", async t => {
  const f = await qaFixture(t); let reads = 0;
  const getter = { ...f.enrollInput(), get reviewRef() { reads++; return "never"; } };
  assert.throws(() => f.store.enrollRunEvaluationQaTask(getter), /evaluation.task_invalid/u);
  assert.equal(reads, 0);
  assert.throws(() => f.store.createRunEvaluationQaBatch(Object.assign(Object.create({}), f.batchInput)), /evaluation.task_invalid/u);
  const admitted = f.admit(f.claim(f.enroll()));
  assert.throws(() => f.store.releaseRunEvaluationQaLane({ requestId: admitted.request.id, expectedRequestRevision: admitted.request.revision, now: later, release: { kind: "host_explicit_reconciliation" } }), /evaluation.task_invalid/u);
  assert.equal(f.store.getRunEvaluationQaScope().laneState, "held");
});
for (const violation of ["second_cap", "big_wire_cap", "sampling", "wrong_model", "stream", "bad_messages", "invalid_json"]) test(`Core final wire rejects ${violation}, independently of caller cap declaration`, async t => {
  const f = await qaFixture(t), claimed = f.claim(f.enroll()), input = f.admissionInput(claimed), body = JSON.parse(input.payloadUtf8), before = f.counts();
  if (violation === "second_cap") body.max_completion_tokens = 1024;
  if (violation === "big_wire_cap") body.max_tokens = 99999;
  if (violation === "sampling") body.temperature = 0.9;
  if (violation === "wrong_model") body.model = "unfrozen";
  if (violation === "stream") body.stream = true;
  if (violation === "bad_messages") body.messages = [{ role: "user", content: "no system" }];
  input.payloadUtf8 = violation === "invalid_json" ? "not JSON" : JSON.stringify(body);
  assert.equal(f.store.admitRunEvaluationQaRequest(input).code, "qa_payload_invalid");
  assert.deepEqual(f.counts(), before);
  assert.equal(f.store.getRunEvaluationQaScope().laneState, "available");
});
test("Core accepts max_completion_tokens total cap only when sole output cap", async t => {
  const f = await qaFixture(t), claimed = f.claim(f.enroll()), input = f.admissionInput(claimed), body = JSON.parse(input.payloadUtf8);
  delete body.max_tokens; body.max_completion_tokens = 1024;
  input.payloadUtf8 = JSON.stringify(body);
  assert.equal(value(f.store.admitRunEvaluationQaRequest(input)).request.outputTokenLimit, 1024);
});
test("batch requires real sealed config bytes; admission rechecks artifact drift and never resets namespace", async t => {
  const f = await qaFixture(t), before = f.counts(), scope = f.store.getRunEvaluationQaScope();
  assert.equal(f.store.createRunEvaluationQaBatch({ ...f.batchInput, configSnapshotRef: "missing" }).code, "evaluation.artifact_invalid");
  assert.equal(f.store.createRunEvaluationQaBatch({ ...f.batchInput, configDigest: "f".repeat(64) }).code, "qa_config_conflict");
  assert.deepEqual(f.counts(), before);
  const claimed = f.claim(f.enroll());
  f.database.prepare("UPDATE artifacts SET sealed_payload_json=? WHERE id=?").run(JSON.stringify({ ...f.config, modelId: "changed" }), f.configPin.artifactId);
  assert.equal(f.store.admitRunEvaluationQaRequest(f.admissionInput(claimed)).code, "qa_config_conflict");
  assert.deepEqual(f.store.getRunEvaluationQaScope(), scope);
  assert.equal(f.counts().run_evaluation_qa_requests, 0);
});
test("failed nested coordinator BEGIN preserves caller transaction and all QA facts", async t => {
  const f = await qaFixture(t), before = f.counts(), coordinator = new SqliteRunEvaluationQaStore({ database: f.database }, {}, f.cwd, id => f.store.getArtifact(id));
  f.database.exec("BEGIN IMMEDIATE;");
  try {
    f.database.prepare("INSERT INTO schema_migrations(version,name,applied_at) VALUES(999,'caller-owned',?)").run(now);
    assert.throws(() => coordinator.createRunEvaluationQaBatch(f.batchInput), /transaction/u);
    assert.equal(f.database.isTransaction, true);
    assert.equal(f.database.prepare("SELECT name FROM schema_migrations WHERE version=999").get().name, "caller-owned");
    assert.deepEqual(f.counts(), before);
  } finally { f.database.exec("ROLLBACK;"); }
});
