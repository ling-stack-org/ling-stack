import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { qaFixture, fence, now, later, value } from "./support/evaluation-qa-fixture.mjs";
import { createBudgetHarness } from "./support/delegation-budget-fixture.mjs";

const activePins = (db, reason) => db.prepare(`SELECT artifact_id,holder,reason FROM harness_artifact_pins
  WHERE released_at IS NULL ${reason ? "AND reason=?" : ""} ORDER BY artifact_id,holder`).all(...(reason ? [reason] : []));
const artifactSet = rows => [...new Set(rows.map(row => row.artifact_id))].sort();
const inputIds = f => [f.pins.suite, f.pins.case, f.pins.baseline, f.pins.candidate, f.pins.frozen].map(pin => pin.artifactId).sort();

test("model task enqueue owns durable recovery pins without implicit GC enrollment", async t => {
  const f = await qaFixture(t);
  const task = value(f.store.enqueueRunEvaluationTask(f.enqueue));
  assert.deepEqual(artifactSet(activePins(f.database, "recovery")), inputIds(f));
  assert.equal(new Set(activePins(f.database, "recovery").map(pin => pin.holder)).size, 1);
  const events = f.database.prepare("SELECT COUNT(*) n FROM harness_artifact_pin_events").get().n;
  assert.equal(value(f.store.enqueueRunEvaluationTask(f.enqueue)).id, task.id);
  assert.equal(f.database.prepare("SELECT COUNT(*) n FROM harness_artifact_pin_events").get().n, events);
  assert.equal(f.database.prepare("SELECT COUNT(*) n FROM harness_artifact_retention").get().n, 0);
});

test("task pre-dispatch retry keeps pins, terminal cancellation releases only its own holder", async t => {
  const f = await qaFixture(t);
  const enrollment = f.enroll();
  const pair = f.claim(enrollment);
  const before = activePins(f.database, "recovery");
  assert.equal(before.length, 5);
  value(f.store.finishRunEvaluationTaskBeforeDispatch({ ...fence(pair), nextState: "queued", failureCode: "evaluation.lease_expired_before_dispatch" }));
  assert.deepEqual(activePins(f.database, "recovery"), before);
  const retried = f.claim(enrollment);
  value(f.store.finishRunEvaluationTaskBeforeDispatch({ ...fence(retried), nextState: "cancelled", failureCode: "evaluation.cancelled_before_dispatch" }));
  assert.equal(activePins(f.database, "recovery").length, 0);
  assert.equal(activePins(f.database, "audit_hold").length, 6);
});

test("QA audit hold survives completion and callback drain; request recovery pin does not release early", async t => {
  const f = await qaFixture(t);
  const enrolled = f.enroll();
  const audit = activePins(f.database, "audit_hold");
  assert.deepEqual(artifactSet(audit), [...inputIds(f), f.configPin.artifactId].sort());
  const admitted = f.admit(f.claim(enrolled));
  const requestPins = activePins(f.database, "recovery");
  assert.equal(requestPins.length, 11);
  const settled = f.complete(admitted);
  assert.equal(activePins(f.database, "recovery").length, 6, "task settled but callback is not drained");
  assert.deepEqual(activePins(f.database, "audit_hold"), audit);
  f.release(settled.request);
  assert.equal(activePins(f.database, "recovery").length, 0);
  assert.deepEqual(activePins(f.database, "audit_hold"), audit);
});

test("unknown QA outcome and quarantined lane keep input recovery and audit holds", async t => {
  const f = await qaFixture(t);
  const admitted = f.admit(f.claim(f.enroll()));
  const held = activePins(f.database);
  assert.equal(held.length, 17);
  value(f.store.markRunEvaluationQaRequestUnknown({ ...fence(admitted), requestId: admitted.request.id }));
  assert.deepEqual(activePins(f.database), held);
  const request = f.store.getRunEvaluationQaRequest(admitted.request.id);
  assert.equal(f.store.releaseRunEvaluationQaLane({ requestId: request.id, expectedRequestRevision: request.revision, now: later, release: { kind: "host_callback_drained" } }).ok, false);
  assert.deepEqual(activePins(f.database), held);
});

test("a pin event failure rolls back task authority and pins in the owner transaction", async t => {
  const f = await qaFixture(t);
  f.database.exec("CREATE TRIGGER fail_producer_pin BEFORE INSERT ON harness_artifact_pin_events BEGIN SELECT RAISE(ABORT,'pin-test-fault'); END");
  assert.throws(() => f.store.enqueueRunEvaluationTask(f.enqueue));
  assert.equal(f.database.prepare("SELECT COUNT(*) n FROM run_evaluation_tasks").get().n, 0);
  assert.equal(activePins(f.database).length, 0);
  f.database.exec("DROP TRIGGER fail_producer_pin");
  assert.equal(value(f.store.enqueueRunEvaluationTask(f.enqueue)).state, "queued");
});

test("QA enrollment failure rolls back its task, audit pins and pin events", async t => {
  const f = await qaFixture(t);
  f.database.exec("CREATE TRIGGER fail_audit_pin BEFORE INSERT ON harness_artifact_pin_events WHEN NEW.reason='audit_hold' BEGIN SELECT RAISE(ABORT,'audit-test-fault'); END");
  assert.throws(() => f.enroll());
  assert.equal(f.database.prepare("SELECT COUNT(*) n FROM run_evaluation_tasks").get().n, 0);
  assert.equal(f.database.prepare("SELECT COUNT(*) n FROM run_evaluation_qa_enrollments").get().n, 0);
  assert.equal(activePins(f.database).length, 0);
});

test("required child preparation pins frozen authority and failed child transaction rolls back", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-child-pins-"));
  const f = createBudgetHarness(cwd);
  t.after(async () => { f.store.close(); await rm(cwd, { recursive: true, force: true }); });
  f.freeze();
  f.start();
  const rootPins = activePins(f.db);
  f.setFaultPort("run");
  assert.throws(() => f.spawn());
  assert.deepEqual(activePins(f.db), rootPins);
  f.setFaultPort(undefined);
  const child = f.spawn();
  const step = f.store.getDelegationStep(child.stepId);
  const held = activePins(f.db, "recovery");
  assert.ok(held.some(pin => pin.artifact_id === step.objectiveArtifactId));
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM harness_artifact_retention").get().n, 0);
});

test("independent task owners survive reopen and one cancellation cannot release the sibling", async t => {
  const f = await qaFixture(t);
  const first = value(f.store.enqueueRunEvaluationTask(f.enqueue));
  const second = value(f.store.enqueueRunEvaluationTask({ ...f.enqueue, repeatOrdinal: 2 }));
  const before = activePins(f.database, "recovery");
  assert.equal(before.length, 10);
  const reopened = f.open();
  const pair = value(reopened.claimRunEvaluationTask({ taskId: first.id, expectedTaskRevision: first.revision, claimOwner: "qa", claimToken: "first-only", claimExpiresAt: "2026-10-10T00:10:00.000Z", now: later }));
  value(reopened.finishRunEvaluationTaskBeforeDispatch({ ...fence(pair), nextState: "cancelled", failureCode: "evaluation.cancelled_before_dispatch" }));
  assert.equal(reopened.getRunEvaluationTask(second.id).state, "queued");
  assert.equal(activePins(f.database, "recovery").length, 5);
  assert.deepEqual(artifactSet(activePins(f.database, "recovery")), inputIds(f));
});

test("QA callback drain release failure rolls back lane and all release events", async t => {
  const f = await qaFixture(t);
  const settled = f.complete(f.admit(f.claim(f.enroll())));
  f.database.exec("CREATE TRIGGER fail_lane_pin_release BEFORE INSERT ON harness_artifact_pin_events WHEN NEW.event='release' BEGIN SELECT RAISE(ABORT,'lane-pin-release-fault'); END");
  assert.throws(() => f.release(settled.request));
  assert.equal(f.store.getRunEvaluationQaScope().laneState, "held");
  assert.equal(f.store.getRunEvaluationQaRequest(settled.request.id).releasedAt, undefined);
  assert.equal(activePins(f.database, "recovery").length, 6);
  f.database.exec("DROP TRIGGER fail_lane_pin_release");
  f.release(settled.request);
  assert.equal(activePins(f.database, "recovery").length, 0);
  assert.equal(activePins(f.database, "audit_hold").length, 6);
});

test("known task settlement never weakens authority FK retention of its input body", async t => {
  const f = await qaFixture(t);
  const task = value(f.store.enqueueRunEvaluationTask(f.enqueue));
  const pair = value(f.store.claimRunEvaluationTask({ taskId: task.id, expectedTaskRevision: task.revision, claimOwner: "qa", claimToken: "fk-protection", claimExpiresAt: "2026-10-10T00:10:00.000Z", now }));
  value(f.store.finishRunEvaluationTaskBeforeDispatch({ ...fence(pair), nextState: "cancelled", failureCode: "evaluation.cancelled_before_dispatch" }));
  assert.equal(activePins(f.database).length, 0);
  f.store.enrollHarnessArtifactRetention({ artifactId: f.pins.frozen.artifactId, retainUntil: now, now });
  assert.deepEqual(f.store.collectHarnessArtifactBodies({ now: later }).prunedArtifactIds, []);
  assert.notEqual(f.database.prepare("SELECT sealed_payload_json FROM artifacts WHERE id=?").get(f.pins.frozen.artifactId).sealed_payload_json, null);
});
