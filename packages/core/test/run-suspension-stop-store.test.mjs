import assert from "node:assert/strict";
import test from "node:test";
import { hasRunSuspensionStoppedHandoff } from "../dist/storage/sqlite/run-suspension-stopped-handoff.js";
import { applyRunSuspensionStopMigration } from "../dist/storage/sqlite/run-suspension-stop-migration.js";
import { suspensionStopFixture, stopNow } from "./support/run-suspension-stop-fixture.mjs";

test("root begin preserves the original running source and all logical states; response replay is read-only", async t => {
  const f = await suspensionStopFixture(t); f.track(); f.seal();
  const run = f.store.getRun("root"), attempt = f.store.getWorkUnitAttempt(f.fence.attemptId), unit = f.store.getWorkUnit(f.unit.id);
  const begun = f.begin(); assert.equal(begun.state, "stopping"); assert.deepEqual(begun.begin.source, { kind: "root" });
  assert.deepEqual(f.store.getRun("root"), run); assert.deepEqual(f.store.getWorkUnitAttempt(f.fence.attemptId), attempt);
  assert.deepEqual(f.store.getWorkUnit(f.unit.id), unit); assert.equal(begun.receipt, undefined);
  const snapshot = f.snapshot(); assert.deepEqual(f.begin(), begun); assert.deepEqual(f.snapshot(), snapshot);
  assert.equal(typeof f.store.beginRunSuspensionStop, "undefined");
});

test("request without a real seal and caller-supplied stop flags never authorize begin", async t => {
  const f = await suspensionStopFixture(t), requested = f.suspension.requestRunSuspension({ ...f.root.input, now: stopNow() });
  f.root.suspensionId = requested.id;
  const before = f.snapshot(); assert.throws(() => f.begin(), /not_sealed/);
  assert.throws(() => f.begin(f.root, { stopped: true })); assert.deepEqual(f.snapshot(), before);
});

for (const mode of ["missing", "pending", "unknown"]) test(`root ${mode} Host lifetime cannot manufacture a stopped receipt`, async t => {
  const f = await suspensionStopFixture(t);
  if (mode !== "missing") f.track(f.root, mode !== "unknown");
  f.seal(); f.begin(); if (mode === "unknown") await f.drain();
  const before = f.snapshot(); assert.throws(() => f.commit(), /host_not_drained/); assert.deepEqual(f.snapshot(), before);
});

test("drained root atomically closes only its physical Attempt, retains budgets, releases exact resources, and survives reopen", async t => {
  const f = await suspensionStopFixture(t); f.track(); f.resources(); f.seal(); f.begin();
  assert.equal(f.store.releaseResourceLeasesForAttempt(f.fence, stopNow(), "not-yet-stopped"), 0);
  const run = f.store.getRun("root"), budgets = f.db.prepare("SELECT * FROM delegation_root_budgets").all(), events = f.store.listEvents("root");
  await f.drain(); const stopped = f.commit();
  assert.equal(stopped.state, "stopped"); assert.equal(stopped.receipt.kind, "run.suspension_stopped.v1");
  assert.deepEqual(f.store.getRun("root"), run); assert.deepEqual(f.store.listEvents("root"), events);
  assert.deepEqual(f.db.prepare("SELECT * FROM delegation_root_budgets").all(), budgets);
  assert.equal(f.store.getWorkUnit(f.unit.id).status, "stale");
  const attempt = f.store.getWorkUnitAttempt(f.fence.attemptId);
  assert.equal(attempt.status, "lost"); assert.equal(attempt.errorCode, "runtime_graceful_suspend"); assert.equal(attempt.abortRequestedAt, undefined);
  assert.equal(hasRunSuspensionStoppedHandoff(f.db, f.fence, stopNow()), true);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM resource_leases WHERE status='active'").get().n, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM runtime_semaphore_slots WHERE status='active'").get().n, 0);
  const snapshot = f.snapshot(); assert.deepEqual(f.commit(), stopped); assert.deepEqual(f.snapshot(), snapshot);
  f.reopen(); assert.deepEqual(f.stops.getRunSuspensionStop(stopped.suspensionId), stopped); assert.deepEqual(f.commit(), stopped);
  assert.equal(f.store.listWorkUnitAttempts(f.unit.id).length, 1);
});

for (const field of ["workUnitId", "attemptId", "runtimeInstanceId", "fencingToken"]) test(`foreign ${field} cannot begin or consume original stopped provenance`, async t => {
  const f = await suspensionStopFixture(t); f.track(); f.seal(); const changed = { ...f.fence, [field]: "foreign" }, before = f.snapshot();
  assert.throws(() => f.begin(f.root, { sourceFence: changed })); assert.deepEqual(f.snapshot(), before);
  f.begin(); await f.drain(); const snapshot = f.snapshot(); assert.throws(() => f.commit(f.root, { sourceFence: changed })); assert.deepEqual(f.snapshot(), snapshot);
});

for (const drift of ["context", "policy", "tail", "head", "owner"]) test(`${drift} drift after begin remains blocked without a partial root closure`, async t => {
  const f = await suspensionStopFixture(t); f.track(); f.seal(); f.begin(); await f.drain();
  if (drift === "context") f.db.prepare("UPDATE run_sessions SET context_view_id='foreign' WHERE id='root'").run();
  if (drift === "policy") f.store.updateApprovalPolicy({ toolDecisions: { read: "deny" } }, stopNow());
  if (drift === "tail") f.store.appendExecutionEvent("root", f.fence, "assistant_text_delta", { text: "late" });
  if (drift === "head") f.db.prepare("UPDATE run_progress_checkpoint_heads SET revision=revision+1 WHERE run_id='root'").run();
  if (drift === "owner") f.store.createWorkUnitAttempt({ workUnitId: f.unit.id, attemptNumber: 2, runtimeInstanceId: "successor", runnerId: "pi", status: "started", now: stopNow() });
  const before = f.snapshot(); assert.throws(() => f.commit()); assert.deepEqual(f.snapshot(), before);
});

for (const failure of ["sqlite:run-suspension-stop-receipt", "audit", "resources", "receipt_tail"]) test(`${failure} failure rolls receipt, physical states, audit and both resource tables back atomically`, async t => {
  const f = await suspensionStopFixture(t); f.track(); f.resources(); f.seal(); f.begin(); await f.drain();
  const before = f.snapshot(); f.fault(failure); assert.throws(() => f.commit()); assert.deepEqual(f.snapshot(), before);
  f.fault(undefined); assert.equal(f.commit().state, "stopped");
});

test("child begin binds the actual interrupt control atomically, then stopped commit preserves the original reservation", async t => {
  const f = await suspensionStopFixture(t), child = f.spawn(), live = f.start(child), own = live.own;
  f.track(own); f.resources(own); f.seal(own); const reservation = f.writer.getDelegationBudgetReservation(child.reservation.id);
  const begun = f.begin(own); assert.equal(begun.begin.source.kind, "delegated");
  const control = begun.begin.source, message = f.db.prepare("SELECT * FROM delegation_messages WHERE id=?").get(control.interruptMessageId);
  assert.equal(message.body_artifact_id, control.interruptArtifactId); assert.equal(message.digest, control.interruptDigest);
  assert.equal(f.store.getWorkUnitAttempt(own.fence.attemptId).status, "cancelling");
  assert.equal(f.store.getRun(own.runId).status, "running");
  await f.drain(own); const stopped = f.commit(own);
  assert.equal(stopped.state, "stopped"); assert.equal(f.store.getDelegationStep(child.stepId).state, "interrupted");
  assert.equal(f.store.getWorkUnitAttempt(own.fence.attemptId).status, "cancelled");
  assert.equal(f.store.getRun(own.runId).status, "running");
  assert.deepEqual(f.writer.getDelegationBudgetReservation(child.reservation.id), reservation);
  assert.equal(hasRunSuspensionStoppedHandoff(f.db, own.fence, stopNow()), true);
  const snapshot = f.snapshot(); assert.deepEqual(f.commit(own), stopped); assert.deepEqual(f.snapshot(), snapshot);
});

test("child begin failure rolls the real interrupt, control, pins and provenance back together", async t => {
  const f = await suspensionStopFixture(t), child = f.spawn(), own = f.start(child).own;
  f.track(own); f.seal(own); const before = f.snapshot(); f.fault("sqlite:run-suspension-stop-begin");
  assert.throws(() => f.begin(own), /injected-stop-artifact/); assert.deepEqual(f.snapshot(), before);
  f.fault(undefined); assert.equal(f.begin(own).state, "stopping");
});

test("a pre-existing explicit interrupt cannot be relabeled as Host graceful suspension", async t => {
  const f = await suspensionStopFixture(t), child = f.spawn(), own = f.start(child).own;
  f.track(own); f.seal(own);
  f.lifecycle.requestDelegatedChildInterrupt({ reservationId: child.reservation.id, parentFence: f.fence, callId: "user-explicit-interrupt", now: stopNow() });
  const before = f.snapshot(); assert.throws(() => f.begin(own), /source_stale/); assert.deepEqual(f.snapshot(), before);
});

test("stopping provenance cannot adopt child terminal states written by another lifecycle writer", async t => {
  const f = await suspensionStopFixture(t), child = f.spawn(), own = f.start(child).own;
  f.track(own); f.seal(own); f.begin(own); await f.drain(own);
  f.lifecycle.commitDelegatedChildInterrupted({ reservationId: child.reservation.id, sourceFence: own.fence, now: stopNow() });
  const before = f.snapshot(); assert.throws(() => f.commit(own), /source_stale/); assert.deepEqual(f.snapshot(), before);
});

test("root/optional child/required grandchild close leaf-first with an exact proof for every physical descendant", async t => {
  const f = await suspensionStopFixture(t), child = f.spawn({ required: false }), live = f.start(child), own = live.own;
  const grandchild = f.spawn({ parentRunId: own.runId, sourceFence: own.fence, capture: f.captureToken(live.capture), spawnCallId: "grandchild", requestedBudget: { tokenBudget: 10 } });
  const grand = f.start(grandchild).own;
  for (const node of [f.root, own, grand]) { f.track(node); f.seal(node); }
  f.begin(); f.begin(grand); f.begin(own); await f.drain(); await f.drain(own);
  let before = f.snapshot(); assert.throws(() => f.commit(), /descendant_not_stopped/); assert.deepEqual(f.snapshot(), before);
  before = f.snapshot(); assert.throws(() => f.commit(own), /descendant_not_stopped/); assert.deepEqual(f.snapshot(), before);
  await f.drain(grand); const grandStop = f.commit(grand), childStop = f.commit(own), rootStop = f.commit();
  assert.equal(rootStop.receipt.descendants.length, 2); assert.equal(childStop.receipt.descendants.length, 1);
  assert.deepEqual(new Set(rootStop.receipt.descendants.map(proof => proof.receiptArtifactId)), new Set([grandStop.receiptArtifactId, childStop.receiptArtifactId]));
  for (const node of [f.root, own, grand]) assert.equal(f.store.getRun(node.runId).status, "running");
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM delegation_budget_reservations WHERE state='reserved'").get().n, 2);
});

for (const required of [false, true]) test(`an unclaimed ${required ? "required" : "optional"} child has reverified never-dispatched proof, not invented physical stop`, async t => {
  const f = await suspensionStopFixture(t), child = f.spawn({ required });
  f.track(); f.seal(); f.begin(); await f.drain();
  const queued = f.store.getRun(child.childRun.id), unit = f.store.getWorkUnit(child.childWorkUnit.id);
  const stopped = f.commit();
  assert.equal(stopped.state, "stopped");
  assert.deepEqual(stopped.receipt.descendants.map(proof => [proof.runId, proof.kind]), [[child.childRun.id, "never_dispatched"]]);
  assert.match(stopped.receipt.descendants[0].evidenceDigest, /^[a-f0-9]{64}$/u);
  assert.deepEqual(f.store.getRun(child.childRun.id), queued); assert.deepEqual(f.store.getWorkUnit(unit.id), unit);
  assert.equal(f.store.listWorkUnitAttempts(child.childWorkUnit.id).length, 0);
  assert.equal(f.writer.getDelegationBudgetReservation(child.reservation.id).state, "reserved");
  assert.equal(f.store.getDelegationCompletionEvidence({ rootRunIds: ["root"] }).status, "pending");
  const after = f.snapshot(); assert.deepEqual(f.commit(), stopped); assert.deepEqual(f.snapshot(), after);
  f.reopen(); assert.deepEqual(f.commit(), stopped);
});

for (const phase of ["before_stop", "before_recovery"]) for (const drift of ["hidden_attempt", "counter", "active_pointer", "run_event",
  "host_operation", "approval", "context", "unit_request", "step_revision"])
test(`queued ${drift} at ${phase} cannot borrow an earlier never-dispatched observation`, async t => {
  const f = await suspensionStopFixture(t), child = f.spawn({ required: true });
  f.track(); f.seal(); f.begin(); await f.drain();
  if (phase === "before_recovery") f.commit();
  if (drift === "hidden_attempt") {
    f.store.createWorkUnitAttempt({ workUnitId: child.childWorkUnit.id, attemptNumber: 1, runtimeInstanceId: "hidden-dispatch",
      runnerId: "pi", status: "created", now: stopNow() });
    // Simulate corrupt counters, not a normal lifecycle operation. The actual
    // Attempt row must still veto absence-based proof when its pointer is hidden.
    f.db.prepare("UPDATE work_units SET active_attempt_id=NULL,attempt_count=0 WHERE id=?").run(child.childWorkUnit.id);
  }
  if (drift === "counter") f.db.prepare("UPDATE work_units SET attempt_count=1 WHERE id=?").run(child.childWorkUnit.id);
  if (drift === "active_pointer") f.db.prepare("UPDATE work_units SET active_attempt_id=? WHERE id=?").run(f.fence.attemptId, child.childWorkUnit.id);
  if (drift === "run_event") f.store.appendEvent(child.childRun.id, "tool_start", { toolCallId: "unexpected", toolName: "read" });
  if (drift === "host_operation") f.db.prepare(`INSERT INTO host_operations
    (operation_id,schema_version,run_id,work_unit_id,attempt_id,runtime_instance_id,fencing_token,kind,tool_call_id,phase,admitted_at)
    VALUES('foreign-queued-operation',1,?,?,?,?,?,'plugin','unexpected','admitted',?)`)
    .run(child.childRun.id, f.fence.workUnitId, f.fence.attemptId, f.fence.runtimeInstanceId, f.fence.fencingToken, stopNow());
  if (drift === "approval") f.store.createApprovalRequest({ runId: child.childRun.id, taskId: child.childRun.taskId,
    actionType: "bash", risk: "medium", title: "Contradictory queued approval", description: "Do not execute",
    payload: { type: "bash", command: "echo fixture", cwd: f.cwd, riskFlags: [] } }, stopNow());
  if (drift === "context") f.db.prepare("UPDATE run_sessions SET request_snapshot_json=json_set(request_snapshot_json,'$.objective','drift') WHERE id=?").run(child.childRun.id);
  if (drift === "unit_request") f.db.prepare("UPDATE work_units SET request_json=json_set(request_json,'$.objective','drift') WHERE id=?").run(child.childWorkUnit.id);
  if (drift === "step_revision") f.db.prepare("UPDATE delegation_steps SET revision=revision+1 WHERE id=?").run(child.stepId);
  const before = f.snapshot();
  if (phase === "before_stop") assert.throws(() => f.commit());
  else {
    f.db.exec("BEGIN IMMEDIATE");
    try { assert.throws(() => f.stops.assertStoppedWithinTransaction({ suspensionId: f.root.suspensionId, sourceFence: f.fence, now: stopNow() })); }
    finally { f.db.exec("ROLLBACK"); }
  }
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.writer.getDelegationBudgetReservation(child.reservation.id).state, "reserved");
});

test("a queued required grandchild remains unclaimed across leaf-first closure of its optional parent", async t => {
  const f = await suspensionStopFixture(t), child = f.spawn({ required: false }), live = f.start(child), own = live.own;
  const queued = f.spawn({ parentRunId: own.runId, sourceFence: own.fence, capture: f.captureToken(live.capture),
    spawnCallId: "queued-required-grandchild", required: true, requestedBudget: { tokenBudget: 10 } });
  for (const source of [f.root, own]) { f.track(source); f.seal(source); f.begin(source); await f.drain(source); }
  const before = f.snapshot(); assert.throws(() => f.commit(), /descendant_not_stopped/); assert.deepEqual(f.snapshot(), before);
  const childStop = f.commit(own), rootStop = f.commit();
  assert.equal(childStop.receipt.descendants[0].kind, "never_dispatched");
  assert.deepEqual(rootStop.receipt.descendants.find(proof => proof.runId === queued.childRun.id), childStop.receipt.descendants[0]);
  assert.equal(rootStop.receipt.descendants.find(proof => proof.runId === own.runId).kind, "stopped");
  assert.equal(f.store.listWorkUnitAttempts(queued.childWorkUnit.id).length, 0);
  assert.equal(f.store.getDelegationCompletionEvidence({ rootRunIds: ["root"] }).status, "pending");
});

for (const fault of ["sqlite:run-suspension-stop-receipt", "audit", "resources"]) test(`queued proof with ${fault} failure cannot partially close the parent`, async t => {
  const f = await suspensionStopFixture(t), child = f.spawn({ required: true });
  f.track(); f.resources(); f.seal(); f.begin(); await f.drain();
  const before = f.snapshot(); f.fault(fault); assert.throws(() => f.commit()); assert.deepEqual(f.snapshot(), before);
  f.fault(undefined); assert.equal(f.commit().receipt.descendants[0].kind, "never_dispatched");
  assert.equal(f.store.listWorkUnitAttempts(child.childWorkUnit.id).length, 0);
});

test("current unknown Host effects and unmeasured usage veto closure even after original lifetime resolves", async t => {
  for (const kind of ["effect", "usage"]) {
    const f = await suspensionStopFixture(t); f.track();
    if (kind === "usage") f.charge({ now: stopNow() });
    f.seal(); f.begin(); await f.drain();
    if (kind === "effect") f.store.admitHostOperation({ operationId: "unknown-physical-effect", source: { runId: "root", ...f.fence }, kind: "plugin", toolCallId: "unknown", admittedAt: stopNow() });
    const before = f.snapshot(); assert.throws(() => f.commit()); assert.deepEqual(f.snapshot(), before);
  }
});

test("canonical event bytes cannot change under an unchanged checkpoint head and event sequence", async t => {
  const f = await suspensionStopFixture(t); f.track(); f.seal(); f.begin(); await f.drain();
  f.db.prepare("UPDATE run_events SET data_json=json_set(data_json,'$.model','replaced-model') WHERE run_id='root' AND type='run_start'").run();
  const before = f.snapshot(); assert.throws(() => f.commit(), /watermark_changed/); assert.deepEqual(f.snapshot(), before);
});

test("a same-timestamp newly inserted measured invocation cannot borrow the pre-seal dispatch boundary", async t => {
  const f = await suspensionStopFixture(t); f.track(); const charged = f.charge({ now: stopNow() });
  f.writer.settleModelInvocation({ chargeId: charged.id, receipt: f.receipt(charged), now: stopNow() });
  f.seal(); f.begin(); await f.drain();
  f.db.prepare(`INSERT INTO delegation_budget_charges (id,schema_version,root_run_id,reservation_id,run_id,attempt_id,invocation_id,request_digest,
    price_artifact_id,price_digest,reserved_tokens,reserved_cost_micros,input_tokens,cached_input_tokens,output_tokens,actual_cost_micros,
    state,idempotency_key,revision,created_at,updated_at,settled_at)
    SELECT 'forged-new-admission',schema_version,root_run_id,reservation_id,run_id,attempt_id,'new-invocation',request_digest,
      price_artifact_id,price_digest,reserved_tokens,reserved_cost_micros,input_tokens,cached_input_tokens,output_tokens,actual_cost_micros,
      state,'new-idempotency',revision,created_at,updated_at,settled_at FROM delegation_budget_charges WHERE id=?`).run(charged.id);
  const before = f.snapshot(); assert.throws(() => f.commit(), /post_seal_dispatch/); assert.deepEqual(f.snapshot(), before);
});

for (const kind of ["question", "approval"]) test(`an unresolved real ${kind} is not a completed graceful stop`, async t => {
  const f = await suspensionStopFixture(t); f.track();
  let turn;
  if (kind === "question") {
    const threadId = f.store.getRun("root").threadId;
    turn = f.store.appendConversationUserTurn({ threadId, title: "Question source", userInstruction: "Ask safely", idempotencyKey: "qa-question-source",
      payload: { body: "Ask safely", format: "markdown", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] } }, stopNow());
    f.store.linkRunToLingTurn({ turnId: turn.turnId, runId: "root", now: stopNow() });
  }
  f.seal(); f.begin();
  if (kind === "approval") f.store.createApprovalRequest({ runId: "root", taskId: f.root.input.runId, actionType: "bash", risk: "medium",
    title: "Pending QA command", description: "Do not execute", payload: { type: "bash", command: "echo fixture", cwd: f.cwd, riskFlags: [] } }, stopNow());
  else {
    f.store.createUserInputRequest({ sourceRunId: "root", sourceItemId: turn.item.id, sourceFence: f.fence,
      toolCallId: "required-question", idempotencyKey: "required-question", toolInput: { schemaVersion: 1, waitMode: "required", questions: [{
        questionId: "choice", prompt: "Choose", required: true, allowFreeText: true, options: [{ optionId: "yes", label: "Yes" }] }] } }, stopNow());
  }
  await f.drain(); const before = f.snapshot();
  assert.throws(() => f.commit(), /question_pending/); assert.deepEqual(f.snapshot(), before);
});

test("a true terminal descendant is accepted only with its real Host, usage settlement and immutable result proof", async t => {
  const f = await suspensionStopFixture(t), child = f.spawn(), live = f.start(child), own = live.own;
  f.track(own); await f.drain(own); const endedAt = stopNow();
  f.db.prepare("UPDATE run_sessions SET status='succeeded',ended_at=?,updated_at=? WHERE id=?").run(endedAt, endedAt, own.runId);
  f.db.prepare("UPDATE work_units SET status='succeeded',ended_at=?,updated_at=? WHERE id=?").run(endedAt, endedAt, own.fence.workUnitId);
  f.db.prepare("UPDATE work_unit_attempts SET status='succeeded',ended_at=? WHERE id=?").run(endedAt, own.fence.attemptId);
  f.writer.settleDelegatedChild({ reservationId: child.reservation.id, receipt: f.childReceipt({ kind: "verified_usage", childRunId: own.runId, sourceFence: own.fence }), now: stopNow() });
  f.lifecycle.commitDelegatedChildTerminal({ reservationId: child.reservation.id, sourceFence: own.fence, now: stopNow() });
  f.track(); f.seal(); f.begin(); await f.drain(); const stopped = f.commit();
  assert.equal(stopped.receipt.descendants[0].kind, "terminal"); assert.equal(stopped.receipt.descendants[0].runId, own.runId);
  const before = f.snapshot(); assert.deepEqual(f.commit(), stopped); assert.deepEqual(f.snapshot(), before);
});

for (const kind of ["begin", "receipt", "interrupt", "pin"]) test(`${kind} tampering cannot serve as current stop provenance`, async t => {
  const f = await suspensionStopFixture(t), child = kind === "interrupt" ? f.spawn() : undefined, own = child ? f.start(child).own : f.root;
  f.track(own); f.seal(own); const begun = f.begin(own); await f.drain(own);
  const stopped = kind === "receipt" || kind === "pin" ? f.commit(own) : undefined;
  const id = kind === "begin" ? begun.beginArtifactId : kind === "interrupt" ? begun.begin.source.interruptArtifactId : stopped.receiptArtifactId;
  if (kind === "pin") f.db.prepare("UPDATE harness_artifact_pins SET released_at=? WHERE artifact_id=? AND holder LIKE 'host:run_suspension_stop:%'").run(stopNow(), id);
  else f.db.prepare("UPDATE artifacts SET sealed_payload_json=sealed_payload_json||' ' WHERE id=?").run(id);
  const before = f.snapshot(); assert.throws(() => f.commit(own)); assert.deepEqual(f.snapshot(), before);
  assert.equal(hasRunSuspensionStoppedHandoff(f.db, own.fence, stopNow()), false);
});

test("all stop authority/view/control/receipt bodies stay recovery and audit pinned through explicit retention collection", async t => {
  const f = await suspensionStopFixture(t); f.track(); f.seal(); f.begin(); await f.drain(); const stopped = f.commit();
  const ids = f.db.prepare("SELECT artifact_id FROM harness_artifact_pins WHERE holder LIKE 'host:run_suspension_stop:%' AND released_at IS NULL").all().map(row => row.artifact_id);
  assert.ok(ids.includes(stopped.beginArtifactId)); assert.ok(ids.includes(stopped.receiptArtifactId));
  for (const artifactId of ids) f.store.enrollHarnessArtifactRetention({ artifactId, retainUntil: stopNow(), now: stopNow() });
  assert.deepEqual(f.store.collectHarnessArtifactBodies({ now: stopNow() }).prunedArtifactIds, []);
});

test("additive 183 schema is replay-stable, immutable and fails closed for recorded missing objects", async t => {
  const f = await suspensionStopFixture(t);
  const migrate = () => applyRunSuspensionStopMigration({ database: f.db,
    hasMigration: version => Boolean(f.db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version)),
    recordMigration: () => assert.fail("already installed") });
  assert.equal(migrate(), false); f.track(); f.seal(); const begun = f.begin();
  assert.throws(() => f.db.prepare("UPDATE run_suspension_stops SET run_id='foreign' WHERE suspension_id=?").run(begun.suspensionId), /immutable/);
  f.db.exec("DROP INDEX idx_run_suspension_stops_source"); assert.throws(migrate, /schema_missing/);
});
