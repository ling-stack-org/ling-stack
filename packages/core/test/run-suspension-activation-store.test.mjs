import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { SqliteRunStore, resolveStoragePaths, captureRunProgressCheckpointLineage, digestHarnessToolValue } from "../dist/index.js";
import { createDelegationHostStoreBinding } from "../dist/delegation-host-store-bridge.js";
import { createBudgetHarness } from "./support/delegation-budget-fixture.mjs";
import { prepareSuspensionSource } from "./support/run-suspension-integration-fixture.mjs";
import { captureRunnerContinuationReplayPackage, createRunnerContinuationReplayArtifact } from "../../daemon/dist/features/harness/continuations/replay-package.js";
import { formatTaskPrompt } from "../../runner-pi/dist/utils.js";
import { assertNoRunSuspensionAdmission, hasPendingRunSuspension } from "../dist/storage/sqlite/run-suspension-store.js";
import { hostAttemptReadScopeForSource } from "../dist/storage/sqlite/host-attempt-read-scope.js";
import { applyRunSuspensionActivationMigration } from "../dist/storage/sqlite/run-suspension-activation-migration.js";
import { applyRunSuspensionStartMigration } from "../dist/storage/sqlite/run-suspension-start-migration.js";
import { assertRootSuspensionStartAdmission } from "../dist/storage/sqlite/run-suspension-start-records.js";
import { runSuspensionWitnessArtifactIds } from "../dist/storage/sqlite/run-suspension-dependencies.js";
import { readRunFinalSettlementRecord } from "../dist/storage/sqlite/run-final-settlement-records.js";

const now = () => new Date().toISOString();

for (const budget of [false, true]) test(`final-settlement recovery observes only the exact stopped source and184/185 target, budget=${budget}`, async t => {
  const f = await fixture(t, { final: true, budget });
  const observe = () => f.writer.readStoppedFinalSettlementRecovery({ suspensionId: f.input.suspensionId, sourceFence: f.fence, now: now() });
  let before = f.snapshot(); assert.equal(observe().kind, "verified"); assert.deepEqual(f.snapshot(), before);
  const activated = f.activate(); assert.equal(activated.kind, "activated");
  before = f.snapshot(); assert.equal(observe().kind, "verified"); assert.deepEqual(f.snapshot(), before);
  const start = f.startInput(activated); before = f.snapshot(); assert.equal(observe().kind, "verified"); assert.deepEqual(f.snapshot(), before);
  f.writer.acknowledgeRootRunSuspensionStart(start);
  const run = f.store.getRun("root");
  f.store.appendExecutionEvent("root", activated.record.activation.targetFence, "run_start", { attemptId: activated.attempt.id,
    taskId: run.taskId, cwd: run.cwd, provider: run.providerName, model: run.providerModel });
  before = f.snapshot(); const verified = observe(); assert.equal(verified.kind, "verified", JSON.stringify(verified));
  assert.deepEqual(verified.modelView, f.source.view); assert.deepEqual(f.snapshot(), before);
  f.store.appendExecutionEvent("root", activated.record.activation.targetFence, "assistant_text_delta", { text: "not a zero-wire completion" });
  before = f.snapshot(); assert.equal(observe().kind, "blocked"); assert.deepEqual(f.snapshot(), before);
});

test("a pending final-settlement target cannot invent a canonical start without original SDK ACK", async t => {
  const f = await fixture(t, { final: true, budget: false }), activated = f.activate();
  f.store.appendEvent("root", "run_start", { attemptId: activated.attempt.id, taskId: f.store.getRun("root").taskId,
    cwd: f.cwd, provider: f.root.providerName, model: f.root.providerModel });
  const before = f.snapshot();
  assert.equal(f.writer.readStoppedFinalSettlementRecovery({ suspensionId: f.input.suspensionId, sourceFence: f.fence, now: now() }).kind, "blocked");
  assert.deepEqual(f.snapshot(), before);
});

function restoredFinalInput(f, activated, changes = {}) {
  const fence = activated.record.activation.targetFence;
  return { runId: "root", sourceFence: fence, expectedLineage: f.source.lineage, modelView: f.source.view,
    observation: f.observationToken({ kind: "pi_restored_final_settlement", runId: "root", sourceFence: fence,
      modelView: f.source.view, toolCallIds: [], settledBuiltinReads: [], ...changes }), now: now() };
}
function appendRestoredStart(f, activated) {
  const run = f.store.getRun("root"), fence = activated.record.activation.targetFence;
  f.store.appendExecutionEvent("root", fence, "run_start", { attemptId: fence.attemptId,
    taskId: run.taskId, cwd: run.cwd, provider: run.providerName, model: run.providerModel });
}
for (const budget of [false, true]) test(`a restored complete ACK has independent B settlement, can stop again and needs zero B charge, budget=${budget}`, async t => {
  const f = await fixture(t, { final: true, tracked: true, budget }), activated = f.activate();
  f.writer.acknowledgeRootRunSuspensionStart(f.startInput(activated)); appendRestoredStart(f, activated);
  const input = restoredFinalInput(f, activated), result = f.writer.commitRunFinalSettlement(input);
  assert.equal(result.kind, "verified", JSON.stringify(result));
  assert.notEqual(result.witness.settlement.id, f.sealed.seal.witness.settlement.id);
  assert.deepEqual(result.witness.settlement.sourceFence, activated.record.activation.targetFence);
  assert.equal(f.store.database.prepare("SELECT count(*) n FROM delegation_budget_charges WHERE attempt_id=?").get(input.sourceFence.attemptId).n, 0);
  const record = readRunFinalSettlementRecord(f.store.database, result.witness.settlement.id);
  assert.equal(record.payload.observationKind, "pi_restored_final_settlement");
  assert.deepEqual(result.artifactIds, runSuspensionWitnessArtifactIds({ database: f.store.database }, result.witness));
  assert.deepEqual(record.payload.restoredHandoff.predecessor, f.sealed.seal.witness);
  for (const id of runSuspensionWitnessArtifactIds({ database: f.store.database }, f.sealed.seal.witness))
    assert.ok(record.payload.dependencies.some(dep => dep.id === id));
  const before = f.snapshot(); assert.deepEqual(f.writer.commitRunFinalSettlement(input), result); assert.deepEqual(f.snapshot(), before);
  let finish; const done = f.store.trackHostAttemptCompletion({ runId: "root", ...input.sourceFence }, new Promise(resolve => { finish = resolve; }), () => true);
  const requested = f.writer.requestRunSuspension({ ...f.source.input, sourceFence: input.sourceFence, now: now() });
  f.writer.sealRunSuspension({ suspensionId: requested.id, sourceFence: input.sourceFence, witness: result.witness, now: now() });
  f.writer.beginRunSuspensionStop({ suspensionId: requested.id, sourceFence: input.sourceFence, now: now() });
  finish(); await done;
  assert.equal(f.writer.commitRunSuspensionStopped({ suspensionId: requested.id, sourceFence: input.sourceFence, now: now() }).state, "stopped");
  const stopped = f.writer.readStoppedFinalSettlementRecovery({ suspensionId: requested.id, sourceFence: input.sourceFence, now: now() });
  assert.equal(stopped.kind, "verified", JSON.stringify(stopped)); assert.deepEqual(stopped.modelView, f.source.view);
});
for (const failure of ["unacked", "no-start", "new-turn", "narrative", "tools", "view", "old-kind", "predecessor-body", "ack-pin"])
test(`restored final rejects ${failure} without creating B settlement`, async t => {
  const f = await fixture(t, { final: true }), activated = f.activate();
  const start = f.startInput(activated);
  if (failure !== "unacked") f.writer.acknowledgeRootRunSuspensionStart(start);
  if (failure !== "no-start") appendRestoredStart(f, activated);
  const fence = activated.record.activation.targetFence; let changes = {};
  if (failure === "new-turn") f.store.appendExecutionEvent("root", fence, "turn_start", { attemptId: fence.attemptId });
  if (failure === "narrative") f.store.appendExecutionEvent("root", fence, "assistant_text_delta", { text: "new narration" });
  if (failure === "tools") changes.toolCallIds = ["borrowed-a"];
  if (failure === "view") changes.modelView = [...f.source.view, { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "new final" }] }];
  if (failure === "old-kind") changes.kind = "pi_final_settlement";
  if (failure === "predecessor-body") f.store.database.prepare("UPDATE artifacts SET sealed_payload_json=sealed_payload_json||' ' WHERE id=?").run(f.sealed.seal.modelViewArtifactId);
  if (failure === "ack-pin") f.store.database.prepare("DELETE FROM harness_artifact_pins WHERE artifact_id=(SELECT artifact_id FROM run_suspension_root_starts WHERE suspension_id=?)").run(f.input.suspensionId);
  const input = restoredFinalInput(f, activated, changes), before = f.snapshot();
  assert.equal(f.writer.commitRunFinalSettlement(input).kind, "blocked"); assert.deepEqual(f.snapshot(), before);
  assert.equal(f.store.database.prepare("SELECT count(*) n FROM run_final_settlements WHERE attempt_id=?").get(fence.attemptId).n, 0);
});
function fileRound(store, view, fence, id) {
  const run = store.getRun("root"), args = { path: `${id}.txt`, content: `Owned result ${id}` };
  const content = [{ type: "text", text: `Owned file result ${id}` }];
  view.push({ role: "assistant", content: [{ type: "toolCall", id, name: "write", arguments: args }], stopReason: "toolUse", timestamp: 2 });
  store.appendExecutionEvent("root", fence, "tool_start", { toolCallId: id, toolName: "write", args });
  const ticket = store.admitHostOperation({ operationId: `op-${id}`, kind: "file_mutation", source: { runId: "root", ...fence }, toolCallId: id, admittedAt: now() });
  const requestDigest = digestHarnessToolValue({ schemaVersion: 1, toolName: "write", toolCallId: id, cwd: run.cwd, input: args });
  const policy = store.createArtifact({ runId: "root", type: "json", path: `harness/${id}/policy.json`, createdAt: now(),
    sealedPayload: { schemaVersion: 1, runId: "root", attemptId: fence.attemptId, toolCallId: id, executorKind: "write",
      brokerMode: "enforce", requestDigest, sideEffectFingerprint: requestDigest, effectivePolicySnapshot: run.requestSnapshot.effectivePolicySnapshot } });
  const prepared = store.prepareHarnessToolExecution({ runId: "root", workUnitId: fence.workUnitId, sourceFence: fence,
    toolCallId: id, toolName: "write", executorKind: "write", requestDigest, sideEffectFingerprint: requestDigest,
    policySnapshotArtifactId: policy.id, approvalState: "allowed", sandboxProfileId: "workspace_write", now: now() }).execution;
  store.bindHostOperationEvidence(ticket, { kind: "harness_tool_execution", id: prepared.id });
  const claimed = store.claimHarnessToolExecution({ executionId: prepared.id, expectedRevision: prepared.revision, sourceFence: fence,
    claimOwner: "host", claimToken: `claim-${id}`, claimExpiresAt: new Date(Date.now() + 60_000).toISOString(), now: now() });
  assert.equal(claimed.ok, true, JSON.stringify(claimed));
  const started = store.startHarnessToolExecution({ executionId: prepared.id, expectedRevision: claimed.value.revision,
    sourceFence: fence, claimOwner: "host", claimToken: `claim-${id}`, now: now() });
  assert.equal(started.ok, true, JSON.stringify(started));
  store.launchHostOperation(ticket, () => 1);
  const artifact = store.createArtifact({ runId: "root", type: "json", path: `harness/${prepared.id}/result.json`, createdAt: now(),
    sealedPayload: { status: "applied", format: "ling-apply-patch-v1", touchedPaths: [args.path], rawPatchSha256: "c".repeat(64) } });
  const resultSummary = { status: "applied", outcome: "applied", touchedPaths: [args.path], artifactCount: 1, cancelled: false };
  const finished = store.finishHarnessToolExecution({ executionId: prepared.id, expectedRevision: started.value.revision,
    sourceFence: fence, claimOwner: "host", claimToken: `claim-${id}`, nextState: "succeeded", resultSummary,
    resultDigest: digestHarnessToolValue(resultSummary), evidenceArtifactIds: [artifact.id], now: now() });
  assert.equal(finished.ok, true, JSON.stringify(finished));
  store.settleHostOperation(ticket, { kind: "file_completed", settledAt: now() });
  store.appendExecutionEvent("root", fence, "tool_end", { toolCallId: id, toolName: "write", result: { content }, isError: false });
  view.push({ role: "toolResult", toolCallId: id, toolName: "write", content, isError: false, timestamp: 3 });
  return [id];
}
async function fixture(t, options = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-suspension-activation-")); let store, f;
  const observations = new WeakMap();
  const readers = () => ({ readCapture: token => f.ports.readCapture(token), readCurrentAuthority: (...args) => f.ports.readCurrentAuthority(...args),
    readUsageReceipt: token => f.ports.readUsageReceipt(token), readChildReceipt: token => f.ports.readChildReceipt(token),
    readFinalSettlementObservation: ref => { const value = observations.get(ref); if (!value) throw new Error("original_final_observation_required"); return structuredClone(value); },
    ...(options.receiver === false ? {} : { readRootSuspensionRecoveryAuthority: () => f.ports.readCurrentAuthority() }),
    ...(options.startReceiver === false ? {} : { readRootSuspensionStartObservation: ref => {
      const observation = observations.get(ref); if (!observation) throw new Error("original_start_observation_required"); return structuredClone(observation);
    } }),
    ...(options.startAuthority === false ? {} : { readRootSuspensionStartAuthority: () => f.ports.readCurrentAuthority() }) });
  let host;
  const open = () => { host = createDelegationHostStoreBinding(readers()); store = new SqliteRunStore({ cwd,
    paths: resolveStoragePaths(cwd).workspace, delegationHostBinding: host.binding }); };
  open(); f = createBudgetHarness(cwd, { store, now: now(), later: now() });
  if (options.budget !== false) f.freeze(); f.start();
  const source = prepareSuspensionSource(f, now()), writer = host.writer();
  // Replay uses the real Runner validator, including its formatted task prompt.
  // Keep this strict input local to S5; S1/S4 fixture semantics stay unchanged.
  const initialRun = store.getRun("root"), request = initialRun.requestSnapshot;
  const executionInput = request.runnerExecutionInput, { fingerprint: _fingerprint, ...prepared } = executionInput.preparedInput;
  prepared.userPrompt = formatTaskPrompt(executionInput.input.task);
  executionInput.preparedInput = { ...prepared, fingerprint: createHash("sha256").update(JSON.stringify(prepared)).digest("hex") };
  store.database.prepare("UPDATE run_sessions SET request_snapshot_json=? WHERE id='root'").run(JSON.stringify(request));
  source.lineage = captureRunProgressCheckpointLineage(store, store.getRun("root")).lineage;
  source.input.expectedLineage = source.lineage;
  source.view[0].content = prepared.userPrompt;
  const coverage = options.tracked ? fileRound(store, source.view, f.fence, "write-a") : true;
  let finalSettlement;
  if (options.final) {
    source.view.push({ role: "assistant", content: [{ type: "text", text: "Complete without replay." }], stopReason: "stop" });
    store.appendExecutionEvent("root", f.fence, "message_end", { attemptId: f.fence.attemptId, role: "assistant", text: "Complete without replay.", stopReason: "stop" });
    if (options.budget !== false) {
      const charge = f.charge({ now: now() }); writer.settleModelInvocation({ chargeId: charge.id, receipt: f.receipt(charge), now: now() });
    }
    const observation = Object.freeze({}); observations.set(observation, { kind: "pi_final_settlement", runId: "root", sourceFence: f.fence,
      modelView: structuredClone(source.view), toolCallIds: options.tracked ? ["write-a"] : [], settledBuiltinReads: [] });
    finalSettlement = writer.commitRunFinalSettlement({ runId: "root", sourceFence: f.fence, expectedLineage: source.lineage,
      modelView: source.view, observation, now: now() });
    assert.equal(finalSettlement.kind, "verified", JSON.stringify(finalSettlement));
  }
  let finish; const lifetime = new Promise(resolve => { finish = resolve; });
  const drained = store.trackHostAttemptCompletion({ runId: "root", ...f.fence }, lifetime, () => coverage);
  t.after(async () => { finish(); await drained; if (store.database.isOpen) store.close(); await rm(cwd, { recursive: true, force: true }); });
  const requested = writer.requestRunSuspension({ ...source.input, now: now() });
  let sealed, stopped, replayArtifact = { id: "missing-replay" };
  if (options.phase !== "requested") {
    if (options.final) sealed = writer.sealRunSuspension({ suspensionId: requested.id, sourceFence: f.fence, witness: finalSettlement.witness, now: now() });
    else {
      const committed = store.commitRunProgressCheckpoint({ runId: "root", sourceFence: f.fence, expectedHead: { checkpointId: null, revision: 0 },
        sourceEventSeq: store.listEvents("root").at(-1).seq, expectedLineage: source.lineage, modelView: source.view, now: now() });
      assert.equal(committed.kind, "committed", JSON.stringify(committed));
      const witness = store.readRunProgressCheckpointForRecovery({ runId: "root", sourceFence: f.fence, expectedLineage: source.lineage }).witness;
      sealed = writer.sealRunSuspension({ suspensionId: requested.id, sourceFence: f.fence, witness: { kind: "ordinary", checkpoint: witness }, now: now() });
    }
  }
  if (!["requested", "sealed"].includes(options.phase)) writer.beginRunSuspensionStop({ suspensionId: requested.id, sourceFence: f.fence, now: now() });
  finish(); await drained;
  if (!options.phase || options.phase === "stopped") {
    stopped = writer.commitRunSuspensionStopped({ suspensionId: requested.id, sourceFence: f.fence, now: now() });
    const run = store.getRun("root"), execution = run.requestSnapshot.runnerExecutionInput;
    const replay = captureRunnerContinuationReplayPackage({ runId: run.id, rootRunId: run.id, workUnitId: f.unit.id, sourceRunId: run.id,
      sourceWorkUnitId: f.unit.id, origin: "daemon_recovery", workspaceCwd: cwd, contextViewId: run.contextViewId,
      contextProjectionVersion: "suspension-ordinary-v1", contextSourceRefs: [{ type: "run", id: run.id }], sourceAttempt: store.getWorkUnitAttempt(f.fence.attemptId),
      runnerId: "pi", runnerCapabilityRevision: "fixture-1", policySnapshot: run.requestSnapshot.effectivePolicySnapshot, execution,
      artifactRefs: [...new Set([sealed.seal.modelViewArtifactId, stopped.beginArtifactId, stopped.receiptArtifactId,
        ...runSuspensionWitnessArtifactIds({ database: store.database }, sealed.seal.witness)])] });
    replayArtifact = createRunnerContinuationReplayArtifact({ store, replayPackage: replay, createdAt: now() });
  }
  const input = { suspensionId: requested.id, sourceFence: f.fence, expectedReceiptDigest: stopped?.receiptDigest ?? "a".repeat(64), replayArtifactId: replayArtifact.id,
    target: { runtimeInstanceId: "new-runtime", runnerId: "pi", runnerCapabilityRevision: "fixture-1" },
    claim: { owner: "new-host", token: "single-dispatch-claim", expiresAt: new Date(Date.now() + 60_000).toISOString() }, now: now() };
  const snapshot = () => ["run_sessions", "work_units", "work_unit_attempts", "runner_continuations", "run_suspensions", "run_suspension_stops",
    "run_suspension_root_activations", "run_suspension_root_starts", "delegation_root_budgets", "delegation_budget_reservations", "delegation_budget_charges",
    "artifacts", "run_events", "runtime_events", "state_transition_events", "harness_artifact_pins", "harness_artifact_pin_events",
    "run_progress_checkpoints", "run_progress_checkpoint_heads", "run_final_settlements", "host_attempt_completions", "resource_leases", "runtime_semaphore_slots", "tasks"]
    .map(table => [table, store.database.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()]);
  const observationToken = observation => { const ref = Object.freeze({}); observations.set(ref, structuredClone(observation)); return ref; };
  const startInput = activated => {
    const activation = activated.record.activation;
    if (store.getWorkUnit(activation.targetFence.workUnitId).status === "queued") assert.equal(store.transitionWorkUnitStatus({
      ...activation.targetFence, expectedStatus: "queued", event: "claim", actor: "system", now: now() }).ok, true);
    const at = now(), observation = { schemaVersion: 1, kind: "run.suspension_start_observation.v1", activationId: activation.id,
      runId: activation.runId, targetFence: activation.targetFence, continuationId: activation.continuationId, taskId: store.getRun("root").taskId,
      preparedInputFingerprint: store.getRun("root").requestSnapshot.runnerExecutionInput.preparedInput.fingerprint,
      runnerId: "pi", observationId: `owned-sdk-${activation.targetFence.attemptId}`, observedAt: at };
    return { suspensionId: activation.suspensionId, targetFence: activation.targetFence, claimOwner: input.claim.owner, claimToken: input.claim.token,
      expectedRevision: activated.continuation.revision, observationRef: observationToken(observation), now: at };
  };
  return { ...f, get store() { return store; }, get writer() { return host.writer(); }, source, stopped, sealed, input, snapshot, observationToken, startInput,
    activate: (changes = {}) => host.writer().activateRootRunSuspension({ ...input, now: now(), ...changes }),
    reopen: () => { store.close(); open(); } };
}

test("exact original private root activation atomically prepares and claims one fresh Attempt without replacing logical inputs or budget", async t => {
  const f = await fixture(t), run = f.store.getRun("root"), budget = f.writer.getRootDelegationBudget("root");
  const result = f.activate();
  assert.equal(result.kind, "activated"); assert.equal(result.attempt.attemptNumber, 2); assert.notEqual(result.attempt.fencingToken, f.fence.fencingToken);
  assert.equal(result.continuation.state, "claimed"); assert.equal(result.continuation.strategy, "deterministic_replay");
  assert.deepEqual(f.store.getRun("root"), run); assert.deepEqual(f.writer.getRootDelegationBudget("root"), budget);
  assert.equal(result.record.activation.targetFence.attemptId, result.attempt.id); assert.equal(result.record.activation.sourceFence.attemptId, f.fence.attemptId);
  assert.equal(result.continuation.contextSnapshotArtifactId, f.input.replayArtifactId);
  assert.equal(result.record.activation.modelViewArtifactId, f.sealed.seal.modelViewArtifactId);
  assert.equal(typeof f.store.activateRootRunSuspension, "undefined");
});

test("lost activation response, reopen and expired claim never create a second target or grant another dispatch", async t => {
  const f = await fixture(t), first = f.activate(), before = f.snapshot();
  const replay = f.activate(); assert.equal(replay.kind, "already_activated"); assert.deepEqual(replay.record, first.record);
  assert.equal("continuation" in replay, false); assert.deepEqual(f.snapshot(), before);
  f.reopen(); const reopened = f.activate({ now: new Date(Date.now() + 120_000).toISOString() });
  assert.equal(reopened.kind, "already_activated"); assert.deepEqual(f.snapshot(), before);
  assert.equal(f.store.listWorkUnitAttempts(f.unit.id).length, 2);
  assert.deepEqual(f.writer.getRootRunSuspensionActivation({ runId: "root", targetAttemptId: first.attempt.id }), first.record);
  assert.deepEqual(f.writer.getRootRunSuspensionActivation(f.input.suspensionId), first.record);
  assert.equal(f.writer.getRootRunSuspensionActivation({ runId: "root", targetAttemptId: f.fence.attemptId }), undefined);
});

test("ordinary root with delegation disabled does not require or invent a dynamic root budget", async t => {
  const f = await fixture(t, { budget: false }); assert.equal(f.writer.getRootDelegationBudget("root"), undefined);
  assert.equal(f.activate().kind, "activated"); assert.equal(f.writer.getRootDelegationBudget("root"), undefined);
});

test("missing private recovery receiver fails closed without borrowing the live receiver", async t => {
  const f = await fixture(t, { receiver: false }); const before = f.snapshot();
  assert.throws(() => f.activate()); assert.deepEqual(f.snapshot(), before);
});

test("public continuation preparation and generic stale recovery cannot borrow the private suspension activation scope", async t => {
  const f = await fixture(t), preparation = { runId: "root", workUnitId: f.unit.id, sourceFence: f.fence,
    expectedTargetAttemptId: f.fence.attemptId, origin: "daemon_recovery", strategy: "deterministic_replay", runnerId: "pi",
    runnerCapabilityRevision: "fixture-1", contextViewId: f.store.getRun("root").contextViewId,
    contextSnapshotArtifactId: f.input.replayArtifactId, idempotencyKey: "public-suspension-bypass", generation: 0,
    targetAttempt: { runtimeInstanceId: "another-runtime", runnerId: "pi" }, now: now() };
  const before = f.snapshot();
  assert.throws(() => f.store.prepareContinuationAndAttempt(preparation), /source_attempt_stale/);
  assert.throws(() => f.store.commitExistingRunContinuation({ preparation, expectedRunStatus: "running", expectedWorkUnitStatus: "stale", now: now() }), /source_attempt_stale/);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.activate().kind, "activated");
});

test("a newly pending durable approval after183 receipt prevents activation without trusting the earlier quiescence", async t => {
  const f = await fixture(t);
  f.store.createApprovalRequest({ runId: "root", taskId: "inline-task", actionType: "bash", risk: "medium", title: "Late pending QA",
    description: "Never execute", payload: { type: "bash", command: "echo fixture", cwd: f.cwd, riskFlags: [] } }, now());
  const before = f.snapshot(); assert.throws(() => f.activate(), /question_pending/); assert.deepEqual(f.snapshot(), before);
});

for (const phase of ["requested", "sealed", "stopping"]) test(`${phase} without original183 physical-stop receipt cannot activate`, async t => {
  const f = await fixture(t, { phase }), before = f.snapshot();
  assert.throws(() => f.activate()); assert.deepEqual(f.snapshot(), before);
});

for (const mismatch of ["workUnitId", "attemptId", "runtimeInstanceId", "fencingToken", "receipt", "runtime", "runner", "capability", "expired_claim", "replay"])
  test(`activation rejects ${mismatch} mismatch without a target, claim or activation receipt`, async t => {
    const f = await fixture(t), before = f.snapshot();
    const changes = ["workUnitId", "attemptId", "runtimeInstanceId", "fencingToken"].includes(mismatch)
      ? { sourceFence: { ...f.fence, [mismatch]: "foreign" } }
      : mismatch === "receipt" ? { expectedReceiptDigest: "a".repeat(64) }
      : mismatch === "runtime" ? { target: { ...f.input.target, runtimeInstanceId: f.fence.runtimeInstanceId } }
      : mismatch === "runner" ? { target: { ...f.input.target, runnerId: "foreign" } }
      : mismatch === "capability" ? { target: { ...f.input.target, runnerCapabilityRevision: "foreign" } }
      : mismatch === "expired_claim" ? { claim: { ...f.input.claim, expiresAt: f.stopped.receipt.stoppedAt } }
      : { replayArtifactId: f.sealed.seal.modelViewArtifactId };
    assert.throws(() => f.activate(changes)); assert.deepEqual(f.snapshot(), before);
  });

for (const drift of ["context", "policy", "head", "event_bytes", "event_tail", "explicit_abort", "generic_loss", "completion", "authority", "budget_deadline"])
  test(`fresh activation revalidates ${drift} after the stop receipt instead of trusting its mere presence`, async t => {
    const f = await fixture(t), db = f.store.database;
    let changes = {};
    if (drift === "context") db.exec("UPDATE run_sessions SET context_view_id='foreign' WHERE id='root'");
    if (drift === "policy") f.store.updateApprovalPolicy({ toolDecisions: { read: "deny" } }, now());
    if (drift === "head") db.exec("UPDATE run_progress_checkpoint_heads SET revision=revision+1 WHERE run_id='root'");
    if (drift === "event_bytes") db.exec("UPDATE run_events SET data_json='{}' WHERE run_id='root'");
    if (drift === "event_tail") f.store.appendEvent("root", "assistant_text_delta", { text: "late source data" });
    if (drift === "explicit_abort") db.prepare("UPDATE work_unit_attempts SET abort_requested_at=? WHERE id=?").run(now(), f.fence.attemptId);
    if (drift === "generic_loss") db.prepare("UPDATE work_unit_attempts SET error_code='runtime_lost' WHERE id=?").run(f.fence.attemptId);
    if (drift === "completion") db.exec("DELETE FROM host_attempt_completions WHERE run_id='root'");
    if (drift === "authority") f.setCurrentAuthority({ ...f.authority, sourceRevision: "new-policy" });
    if (drift === "budget_deadline") {
      const expired = new Date(Date.parse(f.writer.getRootDelegationBudget("root").deadlineAt) + 1).toISOString();
      changes = { now: expired, claim: { ...f.input.claim, expiresAt: new Date(Date.parse(expired) + 60_000).toISOString() } };
    }
    const before = f.snapshot(); assert.throws(() => f.activate(changes)); assert.deepEqual(f.snapshot(), before);
  });

for (const failure of ["prepare", "claim", "artifact", "pin", "audit"]) test(`${failure} fault rolls back queue, target, claim,184 receipt and all pin/audit writes`, async t => {
  const f = await fixture(t), db = f.store.database, before = f.snapshot();
  const target = failure === "prepare" ? [f.store.harnessCommits, "prepareContinuationAndAttemptWithinTransaction"]
    : failure === "claim" ? [f.store.runnerContinuations, "claimRunnerContinuationWithinTransaction"]
    : failure === "artifact" ? [f.store.artifacts, "createArtifactWithinTransaction"]
    : failure === "audit" ? [f.store, "appendRuntimeEvent"] : undefined;
  let restore;
  if (target) {
    const [object, key] = target, original = object[key];
    object[key] = function(...args) { original.apply(this, args); throw new Error(`injected-activation-${failure}`); };
    restore = () => { object[key] = original; };
  } else {
    db.exec(`CREATE TRIGGER injected_activation_pin BEFORE INSERT ON harness_artifact_pins
      WHEN NEW.holder LIKE 'host:run_suspension_activation:%' BEGIN SELECT RAISE(ABORT,'injected-activation-pin'); END`);
    restore = () => db.exec("DROP TRIGGER injected_activation_pin");
  }
  try { assert.throws(() => f.activate(), /injected-activation/); assert.deepEqual(f.snapshot(), before); }
  finally { restore(); }
  assert.equal(f.activate().kind, "activated");
});

test("only valid184 exact current root successor receives admission/read scope; old source and a new pending suspension remain closed", async t => {
  const f = await fixture(t), context = { database: f.store.database }, oldSource = { runId: "root", ...f.fence };
  assert.throws(() => assertNoRunSuspensionAdmission(context, "root"), /admission_closed/);
  assert.equal(hostAttemptReadScopeForSource(context.database, oldSource), "whole_run");
  const result = f.activate(), target = result.record.activation.targetFence, source = { runId: "root", ...target };
  assert.doesNotThrow(() => assertNoRunSuspensionAdmission(context, "root"));
  assert.equal(hostAttemptReadScopeForSource(context.database, source), "exact_attempt");
  assert.equal(hostAttemptReadScopeForSource(context.database, oldSource), "whole_run");
  assert.equal(hasPendingRunSuspension(context, oldSource), true);
  assert.equal(hasPendingRunSuspension(context, source), false);
  assert.throws(() => f.writer.reserveModelInvocation({ runId: "root", sourceFence: f.fence, invocationId: "stale-callback", reservedTokens: 1,
    capture: f.rootCapture, now: now() }));
  assert.equal(f.writer.acknowledgeRootRunSuspensionStart(f.startInput(result)).kind, "started");
  const freshCapture = f.captureToken({ ...f.capture, sourceFence: target });
  assert.doesNotThrow(() => f.writer.reserveModelInvocation({ runId: "root", sourceFence: target, invocationId: "current-target", reservedTokens: 1,
    capture: freshCapture, now: now() }));
  f.writer.requestRunSuspension({ ...f.source.input, sourceFence: target, now: now() });
  assert.throws(() => assertNoRunSuspensionAdmission(context, "root"), /admission_closed/);
});

test("immutable184 and every activation replay/view/stop body remain pinned; corrupted original custody is not audit replay", async t => {
  const f = await fixture(t), result = f.activate(), db = f.store.database;
  assert.throws(() => db.prepare("UPDATE run_suspension_root_activations SET digest=? WHERE suspension_id=?").run("b".repeat(64), f.input.suspensionId), /immutable/);
  const ids = db.prepare("SELECT artifact_id FROM harness_artifact_pins WHERE holder LIKE 'host:run_suspension_activation:%' AND released_at IS NULL").all().map(row => row.artifact_id);
  for (const id of [result.record.artifactId, f.input.replayArtifactId, f.stopped.receiptArtifactId, f.sealed.seal.modelViewArtifactId]) assert.ok(ids.includes(id));
  for (const artifactId of ids) f.store.enrollHarnessArtifactRetention({ artifactId, retainUntil: now(), now: now() });
  assert.deepEqual(f.store.collectHarnessArtifactBodies({ now: now() }).prunedArtifactIds, []);
  db.prepare("UPDATE artifacts SET sealed_payload_json=sealed_payload_json||' ' WHERE id=?").run(result.record.artifactId);
  const before = f.snapshot(); assert.throws(() => f.activate()); assert.deepEqual(f.snapshot(), before);
});

test("activation idempotency never accepts a changed claim token or replay target", async t => {
  const f = await fixture(t); f.activate(); const before = f.snapshot();
  assert.throws(() => f.activate({ claim: { ...f.input.claim, token: "another-dispatch" } }), /idempotency_conflict/);
  assert.throws(() => f.activate({ target: { ...f.input.target, runtimeInstanceId: "third-runtime" } }), /idempotency_conflict/);
  assert.deepEqual(f.snapshot(), before);
});

test("tracked A→B→C preserves historical completion through physical and logical closure without admitting old callbacks", async t => {
  const f = await fixture(t, { tracked: true }), first = f.activate(), b = first.record.activation.targetFence;
  const started = f.writer.acknowledgeRootRunSuspensionStart(f.startInput(first));
  assert.equal(started.kind, "started");
  const prior = f.store.readRunProgressCheckpointForRecovery({ runId: "root", sourceFence: f.fence, expectedLineage: f.source.lineage,
    continuationBinding: { continuationId: first.continuation.id, targetFence: b } });
  assert.equal(prior.kind, "verified");
  const nextView = structuredClone(prior.modelView), coverage = fileRound(f.store, nextView, b, "write-b");
  let finish; const lifetime = new Promise(resolve => { finish = resolve; });
  const drained = f.store.trackHostAttemptCompletion({ runId: "root", ...b }, lifetime, () => coverage);
  t.after(async () => { finish(); await drained; });
  const requested = f.writer.requestRunSuspension({ ...f.source.input, sourceFence: b, now: now() });
  const next = f.store.commitRunProgressCheckpoint({ runId: "root", sourceFence: b,
    expectedHead: { checkpointId: prior.witness.checkpointId, revision: prior.witness.headRevision }, recoveryPredecessor: prior.witness,
    sourceEventSeq: f.store.listEvents("root").at(-1).seq, expectedLineage: f.source.lineage,
    modelView: nextView, now: now() });
  assert.equal(next.kind, "committed", JSON.stringify(next));
  const verified = f.store.readRunProgressCheckpointForRecovery({ runId: "root", sourceFence: b, expectedLineage: f.source.lineage });
  assert.equal(verified.kind, "verified");
  const seal = f.writer.sealRunSuspension({ suspensionId: requested.id, sourceFence: b, witness: { kind: "ordinary", checkpoint: verified.witness }, now: now() });
  f.writer.beginRunSuspensionStop({ suspensionId: requested.id, sourceFence: b, now: now() }); finish(); await drained;
  const stop = f.writer.commitRunSuspensionStopped({ suspensionId: requested.id, sourceFence: b, now: now() });
  assert.equal(f.store.getHostAttemptCompletion({ runId: "root", ...b }).effectCoverage, "pi_tracked_tools_v1");
  const run = f.store.getRun("root"), replay = captureRunnerContinuationReplayPackage({ runId: "root", rootRunId: "root", workUnitId: f.unit.id,
    sourceRunId: "root", sourceWorkUnitId: f.unit.id, origin: "daemon_recovery", workspaceCwd: f.cwd, contextViewId: run.contextViewId,
    contextProjectionVersion: "suspension-ordinary-v1", contextSourceRefs: [{ type: "run", id: "root" }], sourceAttempt: f.store.getWorkUnitAttempt(b.attemptId),
    runnerId: "pi", runnerCapabilityRevision: "fixture-1", policySnapshot: run.requestSnapshot.effectivePolicySnapshot,
    execution: run.requestSnapshot.runnerExecutionInput, artifactRefs: [seal.seal.modelViewArtifactId, stop.beginArtifactId, stop.receiptArtifactId] });
  const artifact = createRunnerContinuationReplayArtifact({ store: f.store, replayPackage: replay, createdAt: now() });
  const second = f.writer.activateRootRunSuspension({ ...f.input, suspensionId: requested.id, sourceFence: b, expectedReceiptDigest: stop.receiptDigest,
    replayArtifactId: artifact.id, target: { ...f.input.target, runtimeInstanceId: "third-runtime" }, now: now() });
  assert.equal(second.kind, "activated"); assert.equal(second.attempt.attemptNumber, 3);
  const c = second.record.activation.targetFence, context = { database: f.store.database };
  assert.doesNotThrow(() => assertNoRunSuspensionAdmission(context, "root"));
  assert.equal(hostAttemptReadScopeForSource(context.database, { runId: "root", ...c }), "exact_attempt");
  for (const old of [f.fence, b]) {
    assert.equal(hasPendingRunSuspension(context, { runId: "root", ...old }), true);
    assert.equal(hostAttemptReadScopeForSource(context.database, { runId: "root", ...old }), old === b ? "exact_attempt" : "whole_run");
    assert.throws(() => f.writer.reserveModelInvocation({ runId: "root", sourceFence: old, invocationId: `stale-${old.attemptId}`, reservedTokens: 1,
      capture: f.captureToken({ ...f.capture, sourceFence: old }), now: now() }));
  }
  const original = context.database.prepare("SELECT sealed_payload_json FROM artifacts WHERE id=?").get(first.record.artifactId).sealed_payload_json;
  context.database.prepare("UPDATE artifacts SET sealed_payload_json=sealed_payload_json||' ' WHERE id=?").run(first.record.artifactId);
  assert.throws(() => assertNoRunSuspensionAdmission(context, "root"), /admission_closed/);
  assert.equal(f.store.getHostAttemptCompletion({ runId: "root", ...b }).effectCoverage, undefined,
    "without immutable historical qualification, A's real Host effect is correctly foreign to B's whole-Run read");
  context.database.prepare("UPDATE artifacts SET sealed_payload_json=? WHERE id=?").run(original, first.record.artifactId);
  assert.equal(f.store.getHostAttemptCompletion({ runId: "root", ...b }).effectCoverage, "pi_tracked_tools_v1");
  assert.doesNotThrow(() => assertNoRunSuspensionAdmission(context, "root"));
  context.database.exec("UPDATE run_sessions SET status='succeeded',ended_at='2026-10-23T23:59:59.000Z' WHERE id='root'");
  assert.equal(f.store.getHostAttemptCompletion({ runId: "root", ...b }).effectCoverage, "pi_tracked_tools_v1");
  assert.equal(context.database.prepare("SELECT count(*) n FROM host_operations").get().n, 2);
  assert.equal(context.database.prepare("SELECT count(*) n FROM harness_tool_executions WHERE state='succeeded'").get().n, 2);
  f.reopen();
  assert.equal(f.store.getHostAttemptCompletion({ runId: "root", ...b }).effectCoverage, "pi_tracked_tools_v1");
});

test("only original prepared SDK observation atomically ACKs root185 and immutable replay never grants dispatch", async t => {
  const f = await fixture(t), activated = f.activate(), activation = activated.record;
  const input = f.startInput(activated), run = f.store.getRun("root"), result = f.writer.acknowledgeRootRunSuspensionStart(input);
  assert.equal(result.kind, "started"); assert.equal(result.attempt.status, "started");
  assert.equal(result.workUnit.status, "running"); assert.equal(result.continuation.state, "running");
  assert.deepEqual(f.store.getRun("root"), run); assert.deepEqual(f.writer.getRootRunSuspensionActivation(input.suspensionId), activation);
  assert.equal(result.record.start.observation.targetFence.attemptId, result.attempt.id);
  assert.equal(result.record.start.rootBudgetDigest, activation.activation.rootBudgetDigest);
  assert.equal(f.store.getTask(run.taskId), undefined, "snapshot-only tasks are never synthesized");
  assert.equal(typeof f.store.acknowledgeRootRunSuspensionStart, "undefined");
  const before = f.snapshot(), replay = f.writer.acknowledgeRootRunSuspensionStart(input);
  assert.equal(replay.kind, "already_started"); assert.equal("continuation" in replay, false); assert.deepEqual(f.snapshot(), before);
  assert.doesNotThrow(() => assertRootSuspensionStartAdmission(f.store.database, "root"));
  assert.deepEqual(f.writer.getRootRunSuspensionStart({ runId: "root", targetAttemptId: result.attempt.id }), result.record);
  f.reopen(); assert.deepEqual(f.writer.getRootRunSuspensionStart(input.suspensionId), result.record); assert.deepEqual(f.snapshot(), before);
});

test("unacknowledged activation cannot borrow public start, started mutation, duplicate WorkUnit transition or replacement", async t => {
  const f = await fixture(t), activated = f.activate(), input = f.startInput(activated), before = f.snapshot();
  assert.throws(() => assertRootSuspensionStartAdmission(f.store.database, "root"), /admission_closed/);
  const start = { continuationId: activated.continuation.id, expectedRevision: activated.continuation.revision,
    claimOwner: input.claimOwner, claimToken: input.claimToken, targetFence: input.targetFence, now: input.now };
  assert.equal(f.store.startRunnerContinuation(start).ok, false);
  f.store.database.exec("BEGIN IMMEDIATE");
  assert.equal(f.store.runnerContinuations.startRunnerContinuationWithinTransaction(start, {}).ok, false);
  f.store.database.exec("ROLLBACK");
  assert.equal(f.store.updateWorkUnitAttemptStatus({ ...input.targetFence, status: "started", now: now() }), undefined);
  for (const extra of [{}, input.targetFence]) assert.equal(f.store.transitionWorkUnitStatus({ workUnitId: f.unit.id, ...extra,
    expectedStatus: "claimed", event: "runner_started", actor: "system", now: now() }).ok, false);
  assert.throws(() => f.store.createWorkUnitAttempt({ workUnitId: f.unit.id, runtimeInstanceId: "forged-runtime", runnerId: "pi", status: "started", now: now() }),
    /root_suspension_start_required/);
  assert.deepEqual(f.snapshot(), before);
});

for (const budget of [true, false]) test(`unacknowledged activation retains its exact active target through public transitions (${budget ? "budgeted" : "ordinary"})`, async t => {
  const f = await fixture(t, { budget }), activated = f.activate(), input = f.startInput(activated), before = f.snapshot();
  for (const activeAttemptId of [null, f.fence.attemptId, "foreign-active-target"]) {
    for (const extra of [{}, input.targetFence]) {
      const result = f.store.transitionWorkUnitStatus({ workUnitId: f.unit.id, ...extra, activeAttemptId,
        expectedStatus: "claimed", event: "runner_lost", actor: "system", now: now() });
      assert.equal(result.ok, false, "an unacknowledged target cannot be cleared or replaced by a status transition");
      assert.deepEqual(f.snapshot(), before, "the rejected transition must leave the original claim, target and audit intact");
    }
  }
  assert.throws(() => f.store.createWorkUnitAttempt({ workUnitId: f.unit.id, runtimeInstanceId: "replacement-runtime",
    runnerId: "pi", status: "created", now: now() }), /root_suspension_start_required/);
  assert.equal(f.store.listWorkUnitAttempts(f.unit.id).length, 2, "a rejected pointer change cannot open a replacement Attempt");
  assert.deepEqual(f.snapshot(), before);
  f.reopen();
  assert.equal(f.store.transitionWorkUnitStatus({ workUnitId: f.unit.id, activeAttemptId: null,
    expectedStatus: "claimed", event: "runner_lost", actor: "system", now: now() }).ok, false);
  assert.deepEqual(f.snapshot(), before, "the same guard must use durable state after reopen");
});

for (const option of ["startReceiver", "startAuthority"]) test(`missing original ${option} fails closed even for an ordinary no-budget root`, async t => {
  const f = await fixture(t, { budget: false, [option]: false }), activated = f.activate(), input = f.startInput(activated), before = f.snapshot();
  assert.throws(() => f.writer.acknowledgeRootRunSuspensionStart(input)); assert.deepEqual(f.snapshot(), before);
});

test("ordinary root ACK has independent current-target authority without creating a delegation budget", async t => {
  const f = await fixture(t, { budget: false }), result = f.writer.acknowledgeRootRunSuspensionStart(f.startInput(f.activate()));
  assert.equal(result.kind, "started"); assert.equal(f.writer.getRootDelegationBudget("root"), undefined);
});

for (const initialStatus of ["claimed", "running"]) test(`ACK keeps a real ${initialStatus} Task bound to its logical Run and advances it once`, async t => {
  const f = await fixture(t), channel = f.store.createChannel({ name: "Stored ACK task", boundPath: f.cwd }, now());
  const task = f.store.createTask({ channelId: channel.id, title: "Stored ACK task", prompt: "Fixture only", status: initialStatus }, now());
  f.store.database.prepare("UPDATE tasks SET id='inline-task',current_run_id='root' WHERE id=?").run(task.id);
  const input = f.startInput(f.activate()), result = f.writer.acknowledgeRootRunSuspensionStart(input);
  assert.equal(result.kind, "started"); assert.equal(f.store.getTask("inline-task").status, "running");
  assert.equal(f.store.getTask("inline-task").currentRunId, "root");
  const before = f.snapshot(); assert.equal(f.writer.acknowledgeRootRunSuspensionStart(input).kind, "already_started");
  assert.deepEqual(f.snapshot(), before);
});

test("a failed stored Task transition rolls back the ACK and all execution statuses", async t => {
  const f = await fixture(t), channel = f.store.createChannel({ name: "Atomic Task", boundPath: f.cwd }, now());
  const task = f.store.createTask({ channelId: channel.id, title: "Atomic Task", prompt: "Fixture only", status: "claimed" }, now());
  f.store.database.prepare("UPDATE tasks SET id='inline-task',current_run_id='root' WHERE id=?").run(task.id);
  const input = f.startInput(f.activate()), original = f.store.transitionTaskStatus, before = f.snapshot();
  f.store.transitionTaskStatus = function(...args) { original.apply(this, args); throw new Error("injected-start-task"); };
  try { assert.throws(() => f.writer.acknowledgeRootRunSuspensionStart(input), /injected-start-task/); assert.deepEqual(f.snapshot(), before); }
  finally { f.store.transitionTaskStatus = original; }
});

test("setting started flags cannot grant model/spawn authority before the actual185 receipt", async t => {
  const f = await fixture(t), activated = f.activate(), input = f.startInput(activated);
  f.start(); // Test-only corrupt flags, not the original SDK callback.
  const before = f.snapshot(), capture = f.captureToken({ ...f.capture, sourceFence: input.targetFence });
  assert.throws(() => f.writer.reserveModelInvocation({ runId: "root", sourceFence: input.targetFence, invocationId: "forged-start", reservedTokens: 1,
    capture, now: now() }), /admission_closed/);
  assert.throws(() => f.writer.prepareDelegatedChild({ parentRunId: "root", sourceFence: input.targetFence, spawnCallId: "forged-spawn",
    objective: "Must not spawn", requestedBudget: { tokenBudget: 1 }, required: true, capture, now: now() }), /admission_closed/);
  assert.deepEqual(f.snapshot(), before);
});

for (const mismatch of ["plain_json", "activationId", "runId", "continuationId", "taskId", "preparedInputFingerprint", "runnerId", "targetFence", "future", "old"])
  test(`ACK rejects ${mismatch} observation without any start or185 fact`, async t => {
    const f = await fixture(t), activated = f.activate(), input = f.startInput(activated);
    const observation = { schemaVersion: 1, kind: "run.suspension_start_observation.v1", activationId: activated.record.activation.id,
      runId: "root", targetFence: input.targetFence, continuationId: activated.continuation.id, taskId: f.store.getRun("root").taskId,
      preparedInputFingerprint: f.store.getRun("root").requestSnapshot.runnerExecutionInput.preparedInput.fingerprint,
      runnerId: "pi", observationId: "mismatched-sdk", observedAt: input.now };
    if (mismatch === "targetFence") observation.targetFence = { ...input.targetFence, fencingToken: "foreign" };
    else if (mismatch === "future") observation.observedAt = new Date(Date.parse(input.now) + 1_000).toISOString();
    else if (mismatch === "old") observation.observedAt = f.stopped.receipt.stoppedAt;
    else if (mismatch !== "plain_json") observation[mismatch] = mismatch === "preparedInputFingerprint" ? "a".repeat(64) : "foreign";
    const before = f.snapshot();
    assert.throws(() => f.writer.acknowledgeRootRunSuspensionStart({ ...input,
      observationRef: mismatch === "plain_json" ? observation : f.observationToken(observation) }));
    assert.deepEqual(f.snapshot(), before);
  });

for (const drift of ["claim_owner", "claim_token", "revision", "expired_claim", "work_unit", "attempt", "abort", "run_terminal", "policy", "authority", "head", "event_bytes", "replay_bytes", "activation_bytes", "budget_deadline"])
  test(`SDK ACK revalidates ${drift} under the same write transaction`, async t => {
    const f = await fixture(t), activated = f.activate(), input = f.startInput(activated), db = f.store.database;
    const changes = {};
    if (drift === "claim_owner") changes.claimOwner = "foreign";
    if (drift === "claim_token") changes.claimToken = "foreign";
    if (drift === "revision") changes.expectedRevision = input.expectedRevision + 1;
    if (drift === "expired_claim") changes.now = new Date(Date.parse(f.input.claim.expiresAt) + 1).toISOString();
    if (drift === "work_unit") db.exec("UPDATE work_units SET status='queued' WHERE linked_run_id='root'");
    if (drift === "attempt") db.prepare("UPDATE work_unit_attempts SET status='started' WHERE id=?").run(input.targetFence.attemptId);
    if (drift === "abort") db.prepare("UPDATE work_unit_attempts SET abort_requested_at=? WHERE id=?").run(now(), input.targetFence.attemptId);
    if (drift === "run_terminal") db.exec("UPDATE run_sessions SET status='failed' WHERE id='root'");
    if (drift === "policy") f.store.updateApprovalPolicy({ toolDecisions: { read: "deny" } }, now());
    if (drift === "authority") f.setCurrentAuthority({ ...f.authority, sourceRevision: "changed-at-ack" });
    if (drift === "head") db.exec("UPDATE run_progress_checkpoint_heads SET revision=revision+1 WHERE run_id='root'");
    if (drift === "event_bytes") db.exec("UPDATE run_events SET data_json='{}' WHERE run_id='root'");
    if (drift === "replay_bytes" || drift === "activation_bytes") db.prepare("UPDATE artifacts SET sealed_payload_json=sealed_payload_json||' ' WHERE id=?")
      .run(drift === "replay_bytes" ? f.input.replayArtifactId : activated.record.artifactId);
    if (drift === "budget_deadline") {
      changes.now = new Date(Date.parse(f.writer.getRootDelegationBudget("root").deadlineAt) + 1).toISOString();
      db.prepare("UPDATE runner_continuations SET claim_expires_at=? WHERE id=?").run(new Date(Date.parse(changes.now) + 60_000).toISOString(), activated.continuation.id);
    }
    const before = f.snapshot(); assert.throws(() => f.writer.acknowledgeRootRunSuspensionStart({ ...input, ...changes }));
    assert.deepEqual(f.snapshot(), before);
  });

for (const failure of ["artifact", "receipt", "pin", "continuation", "unit", "audit"]) test(`${failure} fault atomically rolls back185 and every started status`, async t => {
  const f = await fixture(t), activated = f.activate(), input = f.startInput(activated), db = f.store.database, before = f.snapshot();
  const target = failure === "artifact" ? [f.store.artifacts, "createArtifactWithinTransaction"]
    : failure === "continuation" ? [f.store.runnerContinuations, "startRunnerContinuationWithinTransaction"]
    : failure === "unit" ? [f.store, "transitionWorkUnitStatus"] : failure === "audit" ? [f.store, "appendRuntimeEvent"] : undefined;
  let restore;
  if (target) {
    const [object, key] = target, original = object[key];
    object[key] = function(...args) { original.apply(this, args); throw new Error(`injected-start-${failure}`); };
    restore = () => { object[key] = original; };
  } else {
    db.exec(failure === "receipt" ? `CREATE TRIGGER injected_start BEFORE INSERT ON run_suspension_root_starts
      BEGIN SELECT RAISE(ABORT,'injected-start-receipt'); END` : `CREATE TRIGGER injected_start BEFORE INSERT ON harness_artifact_pins
      WHEN NEW.holder LIKE 'host:run_suspension_start:%' BEGIN SELECT RAISE(ABORT,'injected-start-pin'); END`);
    restore = () => db.exec("DROP TRIGGER injected_start");
  }
  try { assert.throws(() => f.writer.acknowledgeRootRunSuspensionStart(input), /injected-start/); assert.deepEqual(f.snapshot(), before); }
  finally { restore(); }
  assert.equal(f.writer.acknowledgeRootRunSuspensionStart(input).kind, "started");
});

test("additive185 migration is replay stable and an ACK record cannot be updated or silently lose schema", async t => {
  const f = await fixture(t), input = f.startInput(f.activate()); f.writer.acknowledgeRootRunSuspensionStart(input);
  assert.throws(() => f.store.database.exec("UPDATE run_suspension_root_starts SET digest='a'"), /immutable/);
  const migration = { database: f.store.database, hasMigration: version => Boolean(f.store.database.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version)),
    recordMigration: () => { throw new Error("must-not-rewrite"); } };
  assert.equal(applyRunSuspensionStartMigration(migration), false);
  f.store.database.exec("DROP INDEX idx_run_suspension_root_start_target");
  assert.throws(() => applyRunSuspensionStartMigration(migration), /schema_missing/);
});

test("close retires retained activation functions along with the original writer", async t => {
  const f = await fixture(t), retainedActivate = f.writer.activateRootRunSuspension, retainedGet = f.writer.getRootRunSuspensionActivation;
  f.store.close(); assert.throws(() => retainedActivate(f.input), /authority_invalid/);
  assert.throws(() => retainedGet(f.input.suspensionId), /authority_invalid/);
});

test("additive184 schema is replay-stable and rejects missing recorded authority objects", async t => {
  const f = await fixture(t), db = f.store.database;
  const migrate = () => applyRunSuspensionActivationMigration({ database: db,
    hasMigration: version => Boolean(db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version)),
    recordMigration: () => assert.fail("already installed") });
  assert.equal(migrate(), false); db.exec("DROP INDEX idx_run_suspension_root_activation_target");
  assert.throws(migrate, /schema_missing/);
});
