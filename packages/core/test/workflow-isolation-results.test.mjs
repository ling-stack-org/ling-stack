import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { workflowIsolationResultsFixture, now, packetDigest } from "./support/workflow-isolation-results-fixture.mjs";

test("terminal result journal is separate from source authority, retained, idempotent and durable after release/reopen", async t => {
  const f = await workflowIsolationResultsFixture(t); f.release();
  const authority = f.readAuthority(), binding = f.binding(), round = f.round(), source = f.snapshotIsolation();
  const intentInput = f.resultIntentInput(), intent = f.resultIntent();
  assert.equal(intent.revision, 0); assert.equal(intent.status, "pending");
  assert.equal(intent.packetContentSha256, f.packetArtifact.contentSha256);
  assert.equal(f.isolation.getTerminalResultIntent("missing"), undefined);
  assert.equal(f.isolation.getTerminalResultReceipt("missing"), undefined);
  assert.deepEqual(f.noResultWrites(() => f.isolation.recordTerminalResultIntent({ ...intentInput, now: f.at(21) })), { status: "duplicate", value: intent });
  const receiptInput = f.resultReceiptInput(), result = f.isolation.recordTerminalResultReceipt(receiptInput);
  assert.equal(result.status, "created", JSON.stringify(result));
  assert.equal(result.value.revision, 1);
  assert.equal(f.isolation.getTerminalResultIntent(f.writer.bindingId).status, "confirmed");
  assert.deepEqual(f.noResultWrites(() => f.isolation.recordTerminalResultReceipt({ ...receiptInput, now: f.at(22) })), { status: "duplicate", value: result.value });
  assert.deepEqual(f.snapshotIsolation(), source);
  assert.deepEqual(f.binding(), binding); assert.deepEqual(f.round(), round); assert.deepEqual(f.readAuthority(), authority);
  assert.equal(f.store.database.prepare("SELECT COUNT(*) AS n FROM harness_artifact_pins WHERE holder LIKE 'host:workflow_terminal_result:%' AND released_at IS NULL").get().n, 2);
  const before = f.snapshotResults(); f.reopenIsolation();
  assert.deepEqual(f.snapshotResults(), before);
  assert.deepEqual(f.isolation.getTerminalResultReceipt(result.value.receiptId), result.value);
  assert.deepEqual(f.readAuthority(), authority);
  assert.equal(f.isolation.assertExecutionBinding({ writer: f.writer, now: now() }).status, "stale");
  assert.equal(f.noResultWrites(() => f.isolation.recordTerminalResultReceipt(f.resultReceiptInput())).code, "workflow_isolation.result_already_confirmed");
});

test("blocked and unknown observations promote only by independent receipt CAS, keeping original intent and every observation", async t => {
  const f = await workflowIsolationResultsFixture(t); const intent = f.resultIntent();
  const first = f.resultReceipt({ outcome: "blocked", observedCommit: null });
  const second = f.resultReceipt({ outcome: "effect_unknown", observedCommit: "7".repeat(40) });
  const third = f.resultReceipt();
  assert.deepEqual([first.revision, second.revision, third.revision], [1, 2, 3]);
  const final = f.isolation.getTerminalResultIntent(f.writer.bindingId);
  assert.deepEqual({ ...final, revision: 0, status: "pending", updatedAt: intent.updatedAt }, intent);
  for (const receipt of [first, second, third]) assert.deepEqual(f.isolation.getTerminalResultReceipt(receipt.receiptId), receipt);
  assert.equal(final.status, "confirmed");
  assert.equal(f.store.database.prepare("SELECT COUNT(*) AS n FROM workflow_isolation_result_intents").get().n, 1);
});

test("packet lineage requires the canonical linked owner without rewriting the immutable preparing binding", async t => {
  const f = await workflowIsolationResultsFixture(t);
  assert.equal(f.binding().startOwner.phase, "preparing");
  assert.equal(f.packet.context.lineage.startOwner.phase, "linked");
  assert.deepEqual(f.packet.context.lineage.startOwner, f.current(f.scopeIsolation).metadata.startOwner);
  const packet = structuredClone(f.packet);
  packet.context.lineage.startOwner = f.binding().startOwner;
  packet.terminal.lineage.startOwner = f.binding().startOwner;
  const artifact = f.sealed("preparing-owner-packet", packet);
  assert.equal(f.noResultWrites(() => f.isolation.recordTerminalResultIntent(f.resultIntentInput({
    packetArtifactId: artifact.id, packetDigest: packetDigest(packet),
  }))).code, "workflow_isolation.result_packet_context_mismatch");
  f.resultIntent();
  f.resultReceipt();
  assert.equal(f.binding().startOwner.phase, "preparing");
});

function blockResult(f, { reason = "workflow_isolation.result_ref_unconfirmed", actor = "system", aggregate = true } = {}) {
  const step = f.current(f.scopeIsolation), workflow = f.store.getChannelWorkflow(f.plan.workflowId);
  assert.equal(f.store.transitionChannelWorkflowStepStatus({ workflowStepId: step.id, expectedStartOwner: step.metadata.startOwner,
    expectedStatus: step.status, taskId: step.taskId, runId: step.runId, event: "blocked", actor, reason, blocker: reason, now: f.at(21) }).ok, true);
  if (aggregate) assert.equal(f.store.transitionChannelWorkflowStatus({ workflowId: workflow.id, expectedStatus: workflow.status,
    event: "step_blocked", actor: "system", reason, now: f.at(21) }).ok, true);
}
const resumeInput = (f, overrides = {}) => ({ writer: f.writer, expectedBindingRevision: f.binding().revision, now: f.at(22), ...overrides });
function noResumeWrites(f, action) {
  const before = { source: f.snapshotIsolation(), results: f.snapshotResults() };
  const result = action();
  assert.deepEqual({ source: f.snapshotIsolation(), results: f.snapshotResults() }, before);
  return result;
}

test("confirmed terminal result resumes only the original blocked step, audits both transitions, and survives duplicate/reopen", async t => {
  const f = await workflowIsolationResultsFixture(t); f.release(); f.resultIntent(); blockResult(f); f.resultReceipt();
  const step = f.current(f.scopeIsolation), authority = f.readAuthority(), source = f.snapshotIsolation(), results = f.snapshotResults();
  const resumed = f.isolation.resumeTerminalResultStep(resumeInput(f));
  assert.equal(resumed.status, "updated", JSON.stringify(resumed));
  const { blocker, ...unblocked } = step;
  assert.deepEqual(resumed.value, { ...unblocked, status: "running", updatedAt: f.at(22) });
  assert.equal(f.store.getChannelWorkflow(f.plan.workflowId).status, "running");
  const after = f.snapshotIsolation();
  for (const table of Object.keys(source).filter(table => !["channel_workflows", "channel_workflow_steps", "state_transition_events"].includes(table)))
    assert.deepEqual(after[table], source[table], table);
  const audits = after.state_transition_events.slice(source.state_transition_events.length);
  assert.deepEqual(audits.map(row => [row.entity_type, row.from_status, row.to_status, row.event, row.actor, row.reason]), [
    ["workflow_step", "blocked", "claimed", "resume", "system", "workflow_isolation.result_ref_confirmed"],
    ["workflow_step", "claimed", "running", "start", "system", "workflow_isolation.result_ref_confirmed"],
    ["workflow", "blocked", "running", "start", "system", "workflow_isolation.result_ref_confirmed"],
  ]);
  assert.deepEqual(f.snapshotResults(), results);
  assert.deepEqual(f.readAuthority(), authority);
  assert.equal(noResumeWrites(f, () => f.isolation.resumeTerminalResultStep(resumeInput(f))).status, "duplicate");
  f.reopenIsolation();
  assert.equal(noResumeWrites(f, () => f.isolation.resumeTerminalResultStep(resumeInput(f))).status, "duplicate");
  assert.equal(f.isolation.assertExecutionBinding({ writer: f.writer, now: f.at(22) }).status, "stale");
});

for (const outcome of ["pending", "blocked", "effect_unknown"]) {
  test(`result step resume rejects ${outcome} journal rather than creating a new execution`, async t => {
    const f = await workflowIsolationResultsFixture(t); f.resultIntent(); blockResult(f);
    if (outcome !== "pending") f.resultReceipt({ outcome, observedCommit: null });
    assert.equal(noResumeWrites(f, () => f.isolation.resumeTerminalResultStep(resumeInput(f))).code, "workflow_isolation.result_ref_unconfirmed");
  });
}

for (const field of ["workUnitId", "attemptId", "runtimeInstanceId", "fencingToken", "bindingId"]) {
  test(`result step resume rechecks exact ${field}`, async t => {
    const f = await workflowIsolationResultsFixture(t); f.resultIntent(); f.resultReceipt(); blockResult(f);
    const writer = { ...f.writer, [field]: field === "fencingToken" ? "999" : "foreign" };
    assert.equal(noResumeWrites(f, () => f.isolation.resumeTerminalResultStep(resumeInput(f, { writer }))).status, "stale");
  });
}

for (const [name, mutate] of Object.entries({
  bindingRevision: f => ({ expectedBindingRevision: f.binding().revision - 1 }),
  sourceProof: f => { f.store.database.prepare("UPDATE run_sessions SET error_message='changed' WHERE id=?").run(f.prepared.run.id); },
  workflowCancel: f => { f.store.database.prepare("UPDATE channel_workflows SET status='cancelled' WHERE id=?").run(f.plan.workflowId); },
  workflowFailed: f => { f.store.database.prepare("UPDATE channel_workflows SET status='failed' WHERE id=?").run(f.plan.workflowId); },
  workflowSucceeded: f => { f.store.database.prepare("UPDATE channel_workflows SET status='succeeded' WHERE id=?").run(f.plan.workflowId); },
  lateAbort: f => { f.store.database.prepare("UPDATE work_unit_attempts SET abort_requested_at=? WHERE id=?").run(now(), f.writer.attemptId); },
  leaseSuccessor: f => { f.store.releaseResourceLease(f.generation.owner.leaseId, "workflow_step", f.plan.workflowStepId, now()); f.lease(f.scopeIsolation, f.at(21)); },
  runPin: f => { f.store.database.prepare("UPDATE run_sessions SET request_snapshot_json='{}' WHERE id=?").run(f.prepared.run.id); },
  packet: f => { f.store.database.prepare("UPDATE artifacts SET sealed_payload_json='{}' WHERE id=?").run(f.packetArtifact.id); },
  receipt: f => { const receipt = f.store.database.prepare("SELECT artifact_id FROM workflow_isolation_result_receipts").get();
    f.store.database.prepare("UPDATE artifacts SET sealed_payload_json='{}' WHERE id=?").run(receipt.artifact_id); },
})) {
  test(`result step resume rejects ${name} after confirmation without mutating the old owner`, async t => {
    const f = await workflowIsolationResultsFixture(t); f.resultIntent(); f.resultReceipt(); blockResult(f);
    const overrides = mutate(f) ?? {};
    assert.ok(["invalid", "stale", "conflict"].includes(noResumeWrites(f, () => f.isolation.resumeTerminalResultStep(resumeInput(f, overrides))).status));
  });
}

for (const [name, mutate] of Object.entries({
  foreignBlocker: f => f.store.database.prepare("UPDATE channel_workflow_steps SET blocker='host.other_blocker' WHERE id=?").run(f.plan.workflowStepId),
  missingAudit: f => f.store.database.prepare("DELETE FROM state_transition_events WHERE entity_type='workflow_step' AND entity_id=? AND event='blocked'").run(f.plan.workflowStepId),
  foreignActor: f => f.store.database.prepare("UPDATE state_transition_events SET actor='human' WHERE entity_type='workflow_step' AND entity_id=? AND event='blocked'").run(f.plan.workflowStepId),
  mismatchedAudit: f => f.store.database.prepare("UPDATE state_transition_events SET reason='other' WHERE entity_type='workflow_step' AND entity_id=? AND event='blocked'").run(f.plan.workflowStepId),
  changedStep: f => f.store.database.prepare("UPDATE channel_workflow_steps SET updated_at=? WHERE id=?").run(f.at(23), f.plan.workflowStepId),
})) {
  test(`result step resume requires the latest matching Host result-gate audit: ${name}`, async t => {
    const f = await workflowIsolationResultsFixture(t); f.resultIntent(); f.resultReceipt(); blockResult(f); mutate(f);
    assert.equal(noResumeWrites(f, () => f.isolation.resumeTerminalResultStep(resumeInput(f))).code, "workflow_isolation.result_resume_not_result_gate");
  });
}

test("result resume never clears an active post gate or an approval-waiting step", async t => {
  const f = await workflowIsolationResultsFixture(t); f.resultIntent(); f.resultReceipt(); blockResult(f);
  const step = f.current(f.scopeIsolation);
  f.store.database.prepare("UPDATE channel_workflow_steps SET metadata_json=? WHERE id=?")
    .run(JSON.stringify({ ...step.metadata, activeGateStage: "post" }), step.id);
  assert.equal(noResumeWrites(f, () => f.isolation.resumeTerminalResultStep(resumeInput(f))).code, "workflow_isolation.result_resume_gate_active");
  f.store.database.prepare("UPDATE channel_workflow_steps SET metadata_json=?,status='waiting_for_approval' WHERE id=?")
    .run(JSON.stringify(step.metadata), step.id);
  assert.equal(noResumeWrites(f, () => f.isolation.resumeTerminalResultStep(resumeInput(f))).code, "workflow_isolation.result_resume_not_result_gate");
});

for (const aggregate of ["approval-waiting", "pending-approval", "other-blocker"]) {
  test(`result resume preserves workflow ${aggregate}`, async t => {
    const f = await workflowIsolationResultsFixture(t); f.resultIntent(); f.resultReceipt();
    if (aggregate === "approval-waiting") assert.equal(f.store.transitionChannelWorkflowStatus({ workflowId: f.plan.workflowId,
      expectedStatus: "running", event: "approval_requested", actor: "system", now: f.at(21) }).ok, true);
    blockResult(f, { aggregate: aggregate !== "approval-waiting" });
    if (aggregate === "pending-approval") {
      const run = f.store.createRun({ id: "other-approval-run", taskId: "other-approval-task", cwd: f.cwd, providerName: "fixture", providerModel: "fixture",
        taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: f.at(21) });
      f.store.createApprovalRequest({ runId: run.id, taskId: run.taskId, actionType: "workflow", risk: "medium", title: "Review candidate", description: "Review",
        payload: { workflowId: f.plan.workflowId } }, f.at(21));
    }
    if (aggregate === "other-blocker") f.store.database.prepare("UPDATE state_transition_events SET reason='other-blocker' WHERE entity_type='workflow' AND entity_id=? AND event='step_blocked'").run(f.plan.workflowId);
    const workflow = f.store.getChannelWorkflow(f.plan.workflowId);
    assert.equal(f.isolation.resumeTerminalResultStep(resumeInput(f)).status, "updated");
    assert.equal(f.current(f.scopeIsolation).status, "running");
    assert.deepEqual(f.store.getChannelWorkflow(f.plan.workflowId), workflow);
  });
}

test("resume audit failure rolls back both original step and aggregate workflow, with no new execution or journal", async t => {
  const f = await workflowIsolationResultsFixture(t); f.resultIntent(); f.resultReceipt(); blockResult(f);
  const before = { source: f.snapshotIsolation(), results: f.snapshotResults() };
  f.store.database.exec("CREATE TRIGGER result_resume_audit_fault BEFORE INSERT ON state_transition_events WHEN NEW.entity_type='workflow' AND NEW.reason='workflow_isolation.result_ref_confirmed' BEGIN SELECT RAISE(ABORT,'result-resume-audit-fault'); END");
  assert.throws(() => f.isolation.resumeTerminalResultStep(resumeInput(f)), /result-resume-audit-fault/);
  assert.deepEqual({ source: f.snapshotIsolation(), results: f.snapshotResults() }, before);
  assert.equal(f.store.database.isTransaction, false);
});

for (const field of ["workUnitId", "attemptId", "runtimeInstanceId", "fencingToken", "bindingId"]) {
  test(`intent and receipt reject exact stale ${field} without releasing or mutating source`, async t => {
    const f = await workflowIsolationResultsFixture(t);
    const writer = { ...f.writer, [field]: field === "fencingToken" ? "999" : "foreign" };
    assert.equal(f.noResultWrites(() => f.isolation.recordTerminalResultIntent(f.resultIntentInput({ writer }))).status, "stale");
    f.resultIntent();
    const input = f.resultReceiptInput({ writer });
    assert.equal(f.noResultWrites(() => f.isolation.recordTerminalResultReceipt(input)).status, "stale");
  });
}

test("one binding retains one immutable intent; changed command/packet/ref cannot start another effect", async t => {
  const f = await workflowIsolationResultsFixture(t); f.resultIntent();
  for (const overrides of [{ intentId: "another" }, { expectedBindingRevision: f.binding().revision - 1 }, { proofDigest: `witc1_${"0".repeat(64)}` },
    { ref: f.plan.branchRef }, { ref: f.plan.target.branchRef }, { commit: "7".repeat(40) }, { tree: "8".repeat(40) }]) {
    const result = f.noResultWrites(() => f.isolation.recordTerminalResultIntent(f.resultIntentInput(overrides)));
    assert.ok(["invalid", "stale", "conflict"].includes(result.status), JSON.stringify(result));
  }
});

for (const [name, mutate] of Object.entries({
  kind: packet => { packet.kind = "workflow_candidate"; },
  binding: packet => { packet.context.lineage.bindingId = "foreign"; },
  plan: packet => { packet.context.lineage.planDigest = "foreign"; },
  sourceFence: packet => { packet.context.lineage.fencingToken = "999"; },
  terminalLineage: packet => { packet.terminal.lineage.attemptId = "foreign"; },
  scopeGeneration: packet => { packet.context.scope.generation = 2; },
  scopeBase: packet => { packet.context.scope.baseCommit = "7".repeat(40); },
  executionRoot: packet => { packet.context.scope.executionRoot = "/foreign"; },
  commonDir: packet => { packet.context.scope.repository.commonDir = "/foreign"; },
  repositoryInode: packet => { packet.context.scope.repository.commonInode = "999"; },
  receiptInode: packet => { packet.context.receipt.rootInode = "999"; },
  targetBranch: packet => { packet.context.scope.repository.branchRef = "refs/heads/other"; },
  worktreeHeadAsResult: packet => { packet.resultRef = packet.context.scope.branchRef; },
  unknownEffect: packet => { packet.terminal.unknownEffects = ["write-unknown"]; },
  terminalOutcome: packet => { packet.terminal.outcome = "failed"; },
  patch: packet => { packet.patch = "tampered"; },
  missingContext: packet => { delete packet.context; },
  missingLineage: packet => { delete packet.context.lineage; },
  terminalArtifact: packet => { packet.terminal.terminalArtifactRef = "result-context"; },
})) {
  test(`sealed packet ${name} mismatch is rejected even with a matching caller-supplied digest`, async t => {
    const f = await workflowIsolationResultsFixture(t), packet = structuredClone(f.packet); mutate(packet);
    const artifact = f.sealed(`bad-packet-${name}`, packet);
    const input = f.resultIntentInput({ packetArtifactId: artifact.id, packetDigest: packetDigest(packet),
      ref: packet.resultRef, commit: packet.commit, tree: packet.tree });
    assert.equal(f.noResultWrites(() => f.isolation.recordTerminalResultIntent(input)).status, "invalid");
  });
}

for (const [name, mutate] of Object.entries({
  workflowCancel: f => f.store.database.prepare("UPDATE channel_workflows SET status='cancelled' WHERE id=?").run(f.plan.workflowId),
  stepCancel: f => f.store.database.prepare("UPDATE channel_workflow_steps SET status='cancelled' WHERE id=?").run(f.plan.workflowStepId),
  abort: f => f.store.database.prepare("UPDATE work_unit_attempts SET abort_requested_at=? WHERE id=?").run(now(), f.writer.attemptId),
  currentRun: f => f.store.database.prepare("UPDATE tasks SET current_run_id=NULL WHERE id=?").run(f.generation.task.id),
  currentAttempt: f => f.store.createWorkUnitAttempt({ workUnitId: f.writer.workUnitId, attemptNumber: 2, runtimeInstanceId: "next", runnerId: "pi", now: now() }),
  runPin: f => f.store.database.prepare("UPDATE run_sessions SET request_snapshot_json='{}' WHERE id=?").run(f.prepared.run.id),
  terminalProof: f => f.store.database.prepare("UPDATE run_sessions SET error_message='changed' WHERE id=?").run(f.prepared.run.id),
})) {
  test(`${name} prevents confirmation and duplicate confirmed replay, while exact unknown observation stays auditable`, async t => {
    const f = await workflowIsolationResultsFixture(t); f.resultIntent();
    const confirmed = f.resultReceiptInput(), unknown = f.resultReceiptInput({ outcome: "effect_unknown", observedCommit: null });
    mutate(f);
    assert.ok(["stale", "conflict"].includes(f.noResultWrites(() => f.isolation.recordTerminalResultReceipt(confirmed)).status));
    const audit = f.isolation.recordTerminalResultReceipt(unknown);
    assert.equal(audit.status, "created", JSON.stringify(audit));
    assert.equal(f.isolation.getTerminalResultIntent(f.writer.bindingId).status, "effect_unknown");
    assert.equal(f.noResultWrites(() => f.isolation.recordTerminalResultIntent(f.resultIntentInput())).status === "duplicate", false);
  });
}

test("an already confirmed receipt never hides cancellation or changed terminal proof on duplicate replay", async t => {
  const f = await workflowIsolationResultsFixture(t); f.resultIntent();
  const input = f.resultReceiptInput(); assert.equal(f.isolation.recordTerminalResultReceipt(input).status, "created");
  f.store.database.prepare("UPDATE work_unit_attempts SET abort_requested_at=? WHERE id=?").run(now(), f.writer.attemptId);
  assert.equal(f.noResultWrites(() => f.isolation.recordTerminalResultReceipt(input)).status, "conflict");
});

for (const [name, change] of Object.entries({
  wrongKind: evidence => { evidence.kind = "host_git_observation"; },
  wrongIntent: evidence => { evidence.intentId = "other"; },
  worktreeRef: evidence => { evidence.effect.ref = "refs/heads/main"; },
  wrongCommit: evidence => { evidence.effect.afterCommit = "7".repeat(40); },
  wrongPacket: evidence => { evidence.effect.packetJson = "{}"; },
  wrongGeneration: evidence => { evidence.effect.generation = 2; },
  wrongObservation: evidence => { evidence.observedCommit = "7".repeat(40); },
  differentOutcome: evidence => { evidence.outcome = "effect_unknown"; },
})) {
  test(`receipt artifact must attest exact original effect and observation: ${name}`, async t => {
    const f = await workflowIsolationResultsFixture(t); f.resultIntent();
    const input = f.resultReceiptInput(), body = structuredClone(f.store.getArtifact(input.artifactId).sealedPayload); change(body);
    const artifact = f.sealed(`forged-${name}`, body);
    assert.equal(f.noResultWrites(() => f.isolation.recordTerminalResultReceipt({ ...input, artifactId: artifact.id })).status, "invalid");
  });
}

test("receipt CAS, command identity and observed commit are strict; confirmed cannot be replaced", async t => {
  const f = await workflowIsolationResultsFixture(t); f.resultIntent();
  const first = f.resultReceiptInput({ outcome: "blocked", observedCommit: null }), stale = f.resultReceiptInput();
  assert.equal(f.isolation.recordTerminalResultReceipt(first).status, "created");
  assert.equal(f.noResultWrites(() => f.isolation.recordTerminalResultReceipt(stale)).status, "stale");
  assert.equal(f.noResultWrites(() => f.isolation.recordTerminalResultReceipt({ ...first, expectedRevision: 1 })).status, "conflict");
  const incorrect = f.resultReceiptInput({ observedCommit: "7".repeat(40) });
  assert.equal(f.noResultWrites(() => f.isolation.recordTerminalResultReceipt(incorrect)).status, "invalid");
  f.resultReceipt();
  assert.equal(f.noResultWrites(() => f.isolation.recordTerminalResultReceipt(f.resultReceiptInput({ outcome: "blocked", observedCommit: null }))).status, "conflict");
});

test("unsealed, foreign-run or corrupted packet/receipt artifact cannot become result evidence", async t => {
  const f = await workflowIsolationResultsFixture(t);
  const noBody = f.store.createArtifact({ id: "unsealed", runId: f.prepared.run.id, type: "json", path: "unsealed", createdAt: now() });
  assert.equal(f.noResultWrites(() => f.isolation.recordTerminalResultIntent(f.resultIntentInput({ packetArtifactId: noBody.id }))).status, "invalid");
  f.store.database.prepare("UPDATE artifacts SET sealed_payload_json='{}' WHERE id=?").run(f.packetArtifact.id);
  assert.equal(f.noResultWrites(() => f.isolation.recordTerminalResultIntent(f.resultIntentInput())).status, "invalid");
});

test("receipt and artifact-pin failure roll back the complete journal CAS", async t => {
  const f = await workflowIsolationResultsFixture(t), db = f.store.database;
  db.exec("CREATE TRIGGER result_pin_fault BEFORE INSERT ON harness_artifact_pins WHEN NEW.holder LIKE 'host:workflow_terminal_result:%' BEGIN SELECT RAISE(ABORT,'result-pin-fault'); END");
  assert.throws(() => f.noResultWrites(() => f.isolation.recordTerminalResultIntent(f.resultIntentInput())), /result-pin-fault/);
  assert.equal(f.isolation.getTerminalResultIntent(f.writer.bindingId), undefined);
  db.exec("DROP TRIGGER result_pin_fault");
  f.resultIntent(); const input = f.resultReceiptInput(); const before = f.snapshotResults();
  db.exec("CREATE TRIGGER result_pin_fault BEFORE INSERT ON harness_artifact_pins WHEN NEW.holder LIKE 'host:workflow_terminal_result:%' BEGIN SELECT RAISE(ABORT,'result-pin-fault'); END");
  assert.throws(() => f.isolation.recordTerminalResultReceipt(input), /result-pin-fault/);
  assert.deepEqual(f.snapshotResults(), before); assert.equal(f.isolation.getTerminalResultReceipt(input.receiptId), undefined);
  assert.equal(db.isTransaction, false);
});

test("terminal journal never adopts or rolls back an external transaction", async t => {
  const f = await workflowIsolationResultsFixture(t), input = f.resultIntentInput(); f.resultIntent(); const receipt = f.resultReceiptInput();
  f.store.database.exec("BEGIN IMMEDIATE");
  try {
    f.store.database.prepare("UPDATE channel_workflows SET title='caller-wip' WHERE id=?").run(f.plan.workflowId);
    for (const action of [() => f.isolation.recordTerminalResultIntent(input), () => f.isolation.recordTerminalResultReceipt(receipt),
      () => f.isolation.resumeTerminalResultStep(resumeInput(f))])
      assert.throws(action, /transaction/i);
    assert.equal(f.store.database.isTransaction, true); assert.equal(f.store.getChannelWorkflow(f.plan.workflowId).title, "caller-wip");
  } finally { f.store.database.exec("ROLLBACK"); }
});

async function race(t, f, operations) {
  const moduleUrl = import.meta.resolve("../dist/index.js");
  const source = `const {parentPort,workerData:d}=require("node:worker_threads");
    (async()=>{if(d.sourceLoaderUrl)await import(d.sourceLoaderUrl);
      const m=await import(d.moduleUrl),store=m.createSqliteRunStore(d.cwd,d.paths),isolation=m.createSqliteWorkflowIsolationStore(store);
      parentPort.once("message",()=>{try{parentPort.postMessage({type:"result",value:isolation[d.method](d.input)})}
        catch(error){parentPort.postMessage({type:"error",message:String(error)})}finally{store.close()}});
      parentPort.postMessage({type:"ready"})})().catch(error=>parentPort.postMessage({type:"error",message:String(error)}));`;
  const workers = operations.map(operation => new Worker(source, { eval: true, workerData: { ...operation, moduleUrl, cwd: f.cwd,
    paths: f.paths, ...(moduleUrl.endsWith(".ts") ? { sourceLoaderUrl: new URL("./support/workflow-step-admission-source-loader.mjs", import.meta.url).href } : {}) } }));
  try {
    await Promise.all(workers.map(async worker => { const [message] = await once(worker, "message", { signal: t.signal });
      assert.equal(message.type, "ready", JSON.stringify(message)); }));
    const waits = workers.map(worker => once(worker, "message", { signal: t.signal })); workers.forEach(worker => worker.postMessage("go"));
    return (await Promise.all(waits)).map(([message]) => { assert.equal(message.type, "result", JSON.stringify(message)); return message.value; });
  } finally { await Promise.all(workers.map(worker => worker.terminate())); }
}

test("independent SQLite workers retain exactly one intent, so only created can start one physical effect", async t => {
  const f = await workflowIsolationResultsFixture(t), input = f.resultIntentInput();
  const results = await race(t, f, [input, { ...input, intentId: "competitor" }].map(value => ({ method: "recordTerminalResultIntent", input: value })));
  assert.deepEqual(results.map(result => result.status).sort(), ["conflict", "created"]);
  assert.equal(f.store.database.prepare("SELECT COUNT(*) AS n FROM workflow_isolation_result_intents").get().n, 1);
});

test("independent SQLite receipt CAS accepts one observation and never loses the prior journal", async t => {
  const f = await workflowIsolationResultsFixture(t); f.resultIntent();
  const results = await race(t, f, [f.resultReceiptInput({ outcome: "blocked", observedCommit: null }),
    f.resultReceiptInput({ outcome: "effect_unknown", observedCommit: null })].map(input => ({ method: "recordTerminalResultReceipt", input })));
  assert.deepEqual(results.map(result => result.status).sort(), ["created", "stale"]);
  assert.equal(f.isolation.getTerminalResultIntent(f.writer.bindingId).revision, 1);
  f.resultReceipt();
  assert.equal(f.isolation.getTerminalResultIntent(f.writer.bindingId).revision, 2);
});
