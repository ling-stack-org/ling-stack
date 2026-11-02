import assert from "node:assert/strict";
import test from "node:test";
import { suspensionStopFixture, stopNow } from "./support/run-suspension-stop-fixture.mjs";
import { SqliteRunFinalSettlementStore, verifyRunFinalSettlement } from "../dist/storage/sqlite/run-final-settlement-store.js";
import { readRunFinalSettlementRecord } from "../dist/storage/sqlite/run-final-settlement-records.js";

async function fixture(t, { tools = true, budget = true, predecessor = false, compacted = false } = {}) {
  const f = await suspensionStopFixture(t, { budget }), observations = new WeakMap();
  if (budget) {
    const charge = f.charge({ now: stopNow() });
    f.writer.settleModelInvocation({ chargeId: charge.id, receipt: f.receipt(charge), now: stopNow() });
  }
  const view = structuredClone(f.root.view);
  if (tools) {
    f.store.appendExecutionEvent(f.root.runId, f.root.fence, "tool_start", { toolCallId: "read-final", toolName: "read", args: { path: "fixture.txt" } });
    f.store.appendExecutionEvent(f.root.runId, f.root.fence, "tool_end", { toolCallId: "read-final", toolName: "read", isError: false, result: { content: [{ type: "text", text: "owned" }] } });
    view.push({ role: "assistant", content: [{ type: "toolCall", id: "read-final", name: "read", arguments: { path: "fixture.txt" } }], stopReason: "toolUse" },
      { role: "toolResult", toolCallId: "read-final", toolName: "read", content: [{ type: "text", text: "owned" }], isError: false });
  }
  if (predecessor) {
    const committed = f.store.commitRunProgressCheckpoint({ runId: f.root.runId, sourceFence: f.root.fence, expectedHead: { checkpointId: null, revision: 0 },
      sourceEventSeq: f.store.listEvents(f.root.runId).at(-1).seq, expectedLineage: f.root.lineage, modelView: view, now: stopNow() });
    assert.equal(committed.kind, "committed", JSON.stringify(committed));
  }
  let compaction;
  if (compacted) {
    const run = f.store.getRun(f.root.runId), fence = f.root.fence, summary = "Owned compacted final context";
    const snapshot = f.store.createArtifact({ runId: run.id, type: "json", path: "final-compaction-snapshot",
      contentType: "application/vnd.ling.pi-compaction-context+json", sealedPayload: { schemaVersion: 1, boundary: "pi-compaction-context",
        runId: run.id, attemptId: fence.attemptId, contextViewId: run.contextViewId, model: run.providerModel, messages: structuredClone(view) }, createdAt: stopNow() });
    const start = f.store.appendExecutionEvent(run.id, fence, "context_compaction_start", { attemptId: fence.attemptId, reason: "threshold",
      policyVersion: "pi_sdk_lifecycle_v1", checkpointArtifactId: snapshot.id });
    view.unshift({ role: "compactionSummary", summary, timestamp: 1 });
    const artifact = f.store.createArtifact({ runId: run.id, type: "json", path: "final-compaction-summary",
      contentType: "application/vnd.ling.run-compaction-summary+json", sealedPayload: { schemaVersion: 1, boundary: "run-compaction-summary",
        runId: run.id, attemptId: fence.attemptId, sourceEventSeq: start.seq, summary, modelView: structuredClone(view) }, createdAt: stopNow() });
    const checkpoint = f.store.createRunCompactionCheckpoint({ runId: run.id, attemptId: fence.attemptId, sourceEventSeq: start.seq,
      contextSnapshotArtifactId: snapshot.id, summaryArtifactId: artifact.id, summaryContentSha256: artifact.contentSha256,
      contextViewId: run.contextViewId, providerName: run.providerName, providerModel: run.providerModel, policyVersion: "pi_sdk_lifecycle_v1",
      policySnapshotFingerprint: f.root.lineage.policySnapshotFingerprint, workspaceProvenanceWatermark: f.root.lineage.workspaceProvenanceWatermark,
      objective: "Read isolated evidence once.", createdAt: stopNow() });
    f.store.transitionRunCompactionCheckpoint({ id: checkpoint.id, expectedRevision: 0, state: "committed", now: stopNow() });
    f.store.appendExecutionEvent(run.id, fence, "context_compaction_end", { attemptId: fence.attemptId, reason: "threshold",
      policyVersion: "pi_sdk_lifecycle_v1", outcome: "sdk_installed", willRetry: false });
    compaction = { snapshot, artifact, checkpoint };
  }
  view.push({ role: "assistant", content: [{ type: "text", text: "Read complete." }], stopReason: "stop" });
  f.store.appendExecutionEvent(f.root.runId, f.root.fence, "message_end", { attemptId: f.root.fence.attemptId, role: "assistant", text: "Read complete.", stopReason: "stop" });
  const ports = { ...f.ports,
    listEvents: (...args) => f.store.listEvents(...args), listHarnessToolExecutions: id => f.store.listHarnessToolExecutions(id),
    listHostCommandWriteBlockers: cwd => f.store.listHostCommandWriteBlockers(cwd), listApprovalRequests: options => f.store.listApprovalRequests(options),
    readFinalSettlementObservation: ref => { assert.ok(observations.has(ref), "only original SDK references are accepted"); return structuredClone(observations.get(ref)); } };
  const authority = new SqliteRunFinalSettlementStore({ database: f.db }, ports);
  const issue = (changes = {}) => {
    const ref = Object.freeze({});
    observations.set(ref, { kind: "pi_final_settlement", runId: f.root.runId, sourceFence: f.root.fence, modelView: structuredClone(view),
      toolCallIds: tools ? ["read-final"] : [], settledBuiltinReads: tools ? [{ toolCallId: "read-final", toolName: "read" }] : [], ...changes });
    return ref;
  };
  const observation = issue();
  const commit = (changes = {}) => authority.commitRunFinalSettlement({ runId: f.root.runId, sourceFence: f.root.fence,
    expectedLineage: f.root.lineage, observation, modelView: view, now: stopNow(), ...changes });
  const seal = result => {
    const requested = f.suspension.requestRunSuspension({ ...f.root.input, now: stopNow() });
    const saved = f.suspension.sealRunSuspension({ suspensionId: requested.id, sourceFence: f.root.fence, witness: result.witness, now: stopNow() });
    f.root.suspensionId = saved.id; return saved;
  };
  const snapshot = () => [f.snapshot(), f.db.prepare("SELECT * FROM run_final_settlements ORDER BY id").all()];
  return { ...f, view, commit, issue, observation, observations, ports, seal, snapshot, compaction };
}

test("a successful SDK final has independent Host settlement authority, never an ordinary checkpoint", async t => {
  const f = await fixture(t), result = f.commit();
  assert.equal(result.kind, "verified", JSON.stringify(result));
  assert.equal(result.witness.kind, "settlement");
  assert.deepEqual(result.modelView, f.view);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM run_progress_checkpoints").get().n, 0);
  const before = f.snapshot(), replay = f.commit();
  assert.deepEqual(replay, result); assert.deepEqual(f.snapshot(), before);
  assert.deepEqual(readRunFinalSettlementRecord(f.db, result.witness.settlement.id).modelView, f.view);
  assert.equal("commitRunFinalSettlement" in f.store, false, "public RunStore has no settlement writer");
});

for (const tools of [false, true]) test(`final settlement seals and physically stops, tools=${tools}`, async t => {
  const f = await fixture(t, { tools }); f.track(); const result = f.commit();
  assert.equal(result.kind, "verified", JSON.stringify(result));
  f.seal(result); f.begin(); await f.drain();
  assert.equal(f.stops.commitRunSuspensionStopped({ suspensionId: f.root.suspensionId, sourceFence: f.root.fence, now: stopNow() }).state, "stopped");
  const before = f.snapshot(), observed = f.stops.readStoppedFinalSettlementRecovery({ suspensionId: f.root.suspensionId, sourceFence: f.root.fence, now: stopNow() });
  assert.equal(observed.kind, "verified", JSON.stringify(observed)); assert.deepEqual(observed.modelView, f.view); assert.deepEqual(f.snapshot(), before);
});

test("ordinary no-budget runs do not invent a dynamic-budget charge", async t => {
  const f = await fixture(t, { tools: false, budget: false }); assert.equal(f.commit().kind, "verified");
});

test("original SDK optional undefined fields compare at the same persisted JSON boundary", async t => {
  const f = await fixture(t); f.view.at(-1).errorMessage = undefined;
  f.view.at(-1).content[0].optionalSdkField = undefined;
  const result = f.commit({ observation: f.issue() });
  assert.equal(result.kind, "verified", JSON.stringify(result)); assert.deepEqual(result.modelView, JSON.parse(JSON.stringify(f.view)));
});

test("compacted SDK final keeps its committed predecessor closure and independent complete model view", async t => {
  const f = await fixture(t, { compacted: true, predecessor: true }), result = f.commit();
  assert.equal(result.kind, "verified", JSON.stringify(result));
  assert.deepEqual(result.modelView, f.view);
  const saved = readRunFinalSettlementRecord(f.db, result.witness.settlement.id);
  for (const artifact of [f.compaction.snapshot, f.compaction.artifact]) assert.ok(saved.payload.dependencies.some(dep => dep.id === artifact.id));
  f.track(); f.seal(result); f.begin(); await f.drain();
  assert.equal(f.stops.commitRunSuspensionStopped({ suspensionId: f.root.suspensionId, sourceFence: f.root.fence, now: stopNow() }).state, "stopped");
  assert.equal(f.stops.readStoppedFinalSettlementRecovery({ suspensionId: f.root.suspensionId, sourceFence: f.root.fence, now: stopNow() }).kind, "verified");
});

test("INSERT OR REPLACE cannot erase final authority even with recursive_triggers disabled", async t => {
  const f = await fixture(t), result = f.commit(); assert.equal(result.kind, "verified");
  f.db.exec("PRAGMA recursive_triggers=OFF");
  const before = f.snapshot();
  assert.throws(() => f.db.exec("INSERT OR REPLACE INTO run_final_settlements SELECT * FROM run_final_settlements"), /identity_conflict/u);
  assert.deepEqual(f.snapshot(), before);
});

for (const change of ["opaque-copy", "no-reader", "view", "source", "lineage", "tool-inventory", "read-inventory", "length", "error", "unpaired", "late-event", "canonical-final", "canonical-usage", "usage-nan", "pending-budget", "unresolved-budget", "pending-approval"])
test(`final settlement rejects ${change} atomically`, async t => {
  const f = await fixture(t); let changes = {};
  if (change === "opaque-copy") changes.observation = {};
  if (change === "no-reader") f.observations.delete(f.observation);
  if (change === "view") changes.modelView = [...f.view.slice(0, -1), { ...f.view.at(-1), content: [{ type: "text", text: "invented" }] }];
  if (change === "source") changes.sourceFence = { ...f.root.fence, fencingToken: "foreign" };
  if (change === "lineage") changes.expectedLineage = { ...f.root.lineage, preparedExecutionFingerprint: "f".repeat(64) };
  if (change === "tool-inventory") changes.observation = f.issue({ toolCallIds: [] });
  if (change === "read-inventory") changes.observation = f.issue({ settledBuiltinReads: [] });
  if (["length", "error", "unpaired", "usage-nan"].includes(change)) {
    if (change === "unpaired") f.view.splice(-1, 0, { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "orphan", name: "read", arguments: {} }] });
    else if (change === "usage-nan") f.view.at(-1).usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: NaN };
    else f.view.at(-1).stopReason = change;
    changes.observation = f.issue();
  }
  if (change === "late-event") f.store.appendExecutionEvent(f.root.runId, f.root.fence, "run_error", { message: "failed" });
  if (change === "canonical-final") f.db.prepare("UPDATE run_events SET data_json=json_set(data_json,'$.text','other') WHERE run_id=? AND type='message_end'").run(f.root.runId);
  if (change === "canonical-usage") { f.view.at(-1).usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 }; changes.observation = f.issue(); }
  if (["pending-budget", "unresolved-budget"].includes(change)) {
    const charge = f.charge({ invocationId: "unsettled", now: stopNow() });
    if (change === "unresolved-budget") f.writer.settleModelInvocation({ chargeId: charge.id, receipt: f.receipt(charge, { kind: "unknown", inputTokens: undefined, cachedInputTokens: undefined, outputTokens: undefined }), now: stopNow() });
  }
  if (change === "pending-approval") f.store.createApprovalRequest({ runId: f.root.runId, taskId: f.store.getRun(f.root.runId).taskId,
    actionType: "bash", risk: "medium", title: "Pending", description: "Pending", payload: { type: "bash", command: "echo pending", cwd: f.cwd, riskFlags: [] } }, stopNow());
  const before = f.snapshot(); assert.equal(f.commit(changes).kind, "blocked"); assert.deepEqual(f.snapshot(), before);
});

for (const change of ["model-body", "ledger-body", "canonical", "budget", "pin", "head"])
test(`settled immutable authority rejects later ${change} drift`, async t => {
  const f = await fixture(t, { predecessor: change === "head" }), result = f.commit(); assert.equal(result.kind, "verified", JSON.stringify(result));
  if (change === "model-body" || change === "ledger-body") f.db.prepare("UPDATE artifacts SET sealed_payload_json=sealed_payload_json||' ' WHERE id=?")
    .run(change === "model-body" ? result.modelViewArtifactId : result.witness.settlement.artifactId);
  if (change === "canonical") f.store.appendExecutionEvent(f.root.runId, f.root.fence, "assistant_text_delta", { text: "late" });
  if (change === "budget") {
    const charge = f.charge({ invocationId: "post-settlement", now: stopNow() });
    f.writer.settleModelInvocation({ chargeId: charge.id, receipt: f.receipt(charge), now: stopNow() });
  }
  if (change === "pin") f.db.prepare("DELETE FROM harness_artifact_pins WHERE artifact_id=?").run(result.modelViewArtifactId);
  if (change === "head") f.db.prepare("UPDATE run_progress_checkpoint_heads SET revision=revision+1 WHERE run_id=?").run(f.root.runId);
  const before = f.snapshot(); assert.throws(() => verifyRunFinalSettlement({ database: f.db }, f.ports, result.witness, stopNow())); assert.deepEqual(f.snapshot(), before);
});

test("final retained view and receipt survive retention; ledger cannot be rewritten or deleted", async t => {
  const f = await fixture(t), result = f.commit(); assert.equal(result.kind, "verified", JSON.stringify(result));
  for (const artifactId of [result.modelViewArtifactId, result.witness.settlement.artifactId])
    f.store.enrollHarnessArtifactRetention({ artifactId, retainUntil: stopNow(), now: stopNow() });
  assert.deepEqual(f.store.collectHarnessArtifactBodies({ now: stopNow() }).prunedArtifactIds, []);
  assert.throws(() => f.db.prepare("UPDATE run_final_settlements SET digest=?").run("0".repeat(64)), /immutable/u);
  assert.throws(() => f.db.prepare("DELETE FROM run_final_settlements").run(), /retained/u);
});

for (const failure of ["view-write", "receipt-write", "reader-drift", "canonical-reentry", "budget-reentry", "pin-write"])
test(`final settlement ${failure} leaves no partial authority or retained artifacts`, async t => {
  const f = await fixture(t), write = f.ports.createArtifactWithinTransaction;
  if (failure === "pin-write") f.db.exec(`CREATE TRIGGER final_pin_fault BEFORE INSERT ON harness_artifact_pins
    WHEN NEW.holder LIKE 'host:run_final_settlement:%' BEGIN SELECT RAISE(ABORT,'injected-final-pin'); END`);
  let writes = 0;
  f.ports.createArtifactWithinTransaction = input => {
    const artifact = write(input); writes += 1;
    if (failure === "view-write" && writes === 1 || failure === "receipt-write" && writes === 2) throw new Error("injected-final-artifact");
    if (writes === 1 && failure === "reader-drift") f.observations.delete(f.observation);
    if (writes === 1 && failure === "canonical-reentry") f.store.appendExecutionEvent(f.root.runId, f.root.fence, "assistant_text_delta", { text: "late write-port" });
    if (writes === 1 && failure === "budget-reentry") {
      const charge = f.charge({ invocationId: "reentrant-charge", now: stopNow() });
      f.writer.settleModelInvocation({ chargeId: charge.id, receipt: f.receipt(charge), now: stopNow() });
    }
    return artifact;
  };
  const before = f.snapshot();
  assert.equal(f.commit().kind, "blocked"); assert.deepEqual(f.snapshot(), before); assert.equal(f.db.isTransaction, false);
});

for (const field of ["observation-getter", "view-getter", "view-proxy", "inventory-getter", "inventory-proxy"])
test(`final settlement rejects ${field} without invoking its accessor/trap`, async t => {
  const f = await fixture(t); let invoked = false;
  const original = f.observations.get(f.observation), trap = () => { invoked = true; throw new Error("must not execute"); };
  if (field === "observation-getter") Object.defineProperty(original, "modelView", { get: trap, enumerable: true });
  if (field === "view-getter") Object.defineProperty(original.modelView.at(-1), "stopReason", { get: trap, enumerable: true });
  if (field === "view-proxy") original.modelView = new Proxy(original.modelView, { get: trap, ownKeys: trap });
  if (field === "inventory-getter") Object.defineProperty(original.toolCallIds, "0", { get: trap, enumerable: true });
  if (field === "inventory-proxy") original.toolCallIds = new Proxy(original.toolCallIds, { get: trap, ownKeys: trap });
  f.ports.readFinalSettlementObservation = () => original;
  const before = f.snapshot(); assert.equal(f.commit().kind, "blocked"); assert.equal(invoked, false); assert.deepEqual(f.snapshot(), before);
});
