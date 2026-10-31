import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { suspensionStopFixture, stopNow } from "./support/run-suspension-stop-fixture.mjs";

async function fixture(t, { child = false } = {}) {
  const f = await suspensionStopFixture(t);
  const own = child ? f.start(f.spawn()).own : f.root, fence = own.fence;
  const run = f.store.getRun(own.runId), summary = "Owned installed compaction";
  f.store.appendExecutionEvent(run.id, fence, "tool_start", { toolCallId: "before-compaction", toolName: "read", args: { path: "fixture.txt" } });
  f.store.appendExecutionEvent(run.id, fence, "tool_end", { toolCallId: "before-compaction", toolName: "read", isError: false, result: { content: [{ type: "text", text: "owned" }] } });
  const view = [{ role: "compactionSummary", summary, timestamp: 1 }, ...own.view,
    { role: "assistant", content: [{ type: "toolCall", id: "before-compaction", name: "read", arguments: { path: "fixture.txt" } }], stopReason: "toolUse" },
    { role: "toolResult", toolCallId: "before-compaction", toolName: "read", content: [{ type: "text", text: "owned" }], isError: false }];
  const snapshot = f.store.createArtifact({ runId: run.id, type: "json", path: "fixture-compaction-snapshot",
    contentType: "application/vnd.ling.pi-compaction-context+json", sealedPayload: { schemaVersion: 1, boundary: "pi-compaction-context",
      runId: run.id, attemptId: fence.attemptId, contextViewId: run.contextViewId, model: run.providerModel, messages: own.view }, createdAt: stopNow() });
  const start = f.store.appendExecutionEvent(run.id, fence, "context_compaction_start", { attemptId: fence.attemptId, reason: "threshold", policyVersion: "pi_sdk_lifecycle_v1", checkpointArtifactId: snapshot.id });
  const artifact = f.store.createArtifact({ runId: run.id, type: "json", path: "fixture-compaction-summary",
    contentType: "application/vnd.ling.run-compaction-summary+json", sealedPayload: { schemaVersion: 1, boundary: "run-compaction-summary",
      runId: run.id, attemptId: fence.attemptId, sourceEventSeq: start.seq, summary, modelView: view }, createdAt: stopNow() });
  const checkpoint = f.store.createRunCompactionCheckpoint({ runId: run.id, attemptId: fence.attemptId, sourceEventSeq: start.seq,
    contextSnapshotArtifactId: snapshot.id, summaryArtifactId: artifact.id, summaryContentSha256: artifact.contentSha256,
    contextViewId: run.contextViewId, providerName: run.providerName, providerModel: run.providerModel, policyVersion: "pi_sdk_lifecycle_v1",
    policySnapshotFingerprint: own.lineage.policySnapshotFingerprint, workspaceProvenanceWatermark: own.lineage.workspaceProvenanceWatermark,
    objective: "Read isolated evidence once.", createdAt: stopNow() });
  f.store.transitionRunCompactionCheckpoint({ id: checkpoint.id, expectedRevision: 0, state: "committed", now: stopNow() });
  const installed = f.store.appendExecutionEvent(run.id, fence, "context_compaction_end", { attemptId: fence.attemptId, reason: "threshold", policyVersion: "pi_sdk_lifecycle_v1", outcome: "sdk_installed", willRetry: false });
  const read = () => f.store.readRunCompactionSuspensionWitness({ runId: run.id, sourceFence: fence, expectedLineage: own.lineage });
  const seal = () => {
    const requested = f.suspension.requestRunSuspension({ ...own.input, now: stopNow() });
    const verified = read(); assert.equal(verified.kind, "verified", JSON.stringify(verified));
    const saved = f.suspension.sealRunSuspension({ suspensionId: requested.id, sourceFence: fence, witness: verified.witness, now: stopNow() });
    own.suspensionId = saved.id; return saved;
  };
  for (const name of ["listEvents", "listHarnessToolExecutions", "listHostCommandWriteBlockers", "listApprovalRequests"]) f.ports[name] = (...args) => f.store[name](...args);
  return { ...f, fence, root: own, run, view, snapshotArtifact: snapshot, artifact, checkpoint, installed, read, seal,
    track: () => f.track(own), begin: () => f.begin(own), drain: () => f.drain(own), commit: () => f.commit(own) };
}

function progress(f, id = "after-compaction") {
  const { store, run, fence } = f, previous = store.getLatestRunCompactionCheckpoint(run.id);
  const old = store.getArtifact(previous.summaryArtifactId).sealedPayload, args = { path: `${id}.txt` }, content = [{ type: "text", text: `read:${id}` }];
  store.appendExecutionEvent(run.id, fence, "tool_start", { toolCallId: id, toolName: "read", args });
  const end = store.appendExecutionEvent(run.id, fence, "tool_end", { toolCallId: id, toolName: "read", result: { content }, isError: false });
  const modelView = [...old.modelView, { role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: args }], stopReason: "toolUse" },
    { role: "toolResult", toolCallId: id, toolName: "read", content, isError: false }];
  const artifact = store.createArtifact({ runId: run.id, type: "json", path: `progress:${id}`, contentType: "application/vnd.ling.run-compaction-summary+json",
    sealedPayload: { schemaVersion: 1, boundary: "run-compaction-progress", runId: run.id, attemptId: fence.attemptId, sourceEventSeq: end.seq,
      predecessorId: previous.id, summary: old.summary, modelView, completedToolCallIds: [id] }, createdAt: stopNow() });
  const checkpoint = store.createRunCompactionCheckpoint({ runId: run.id, attemptId: fence.attemptId, sourceEventSeq: end.seq, predecessorId: previous.id,
    contextSnapshotArtifactId: previous.contextSnapshotArtifactId, summaryArtifactId: artifact.id, summaryContentSha256: artifact.contentSha256,
    contextViewId: run.contextViewId, providerName: run.providerName, providerModel: run.providerModel, policyVersion: previous.policyVersion,
    policySnapshotFingerprint: previous.policySnapshotFingerprint, workspaceProvenanceWatermark: previous.workspaceProvenanceWatermark,
    objective: previous.objective, createdAt: stopNow() });
  store.transitionRunCompactionCheckpoint({ id: checkpoint.id, expectedRevision: 0, state: "committed", now: stopNow() });
  return { checkpoint, artifact, modelView };
}

function replaceBody(f, artifact, change) {
  const payload = structuredClone(f.store.getArtifact(artifact.id).sealedPayload); change(payload);
  const json = JSON.stringify(payload), digest = createHash("sha256").update(json).digest("hex");
  f.db.prepare("UPDATE artifacts SET sealed_payload_json=?,content_sha256=? WHERE id=?").run(json, digest, artifact.id);
  f.db.prepare("UPDATE run_compaction_checkpoints SET summary_content_sha256=? WHERE summary_artifact_id=?").run(digest, artifact.id);
}

test("compaction witness binds actual installed checkpoint and a separate seal boundary without an ordinary head", async t => {
  const f = await fixture(t);
  f.store.appendExecutionEvent(f.run.id, f.fence, "turn_start", { attemptId: f.fence.attemptId });
  const verified = f.read(); assert.equal(verified.kind, "verified", JSON.stringify(verified));
  assert.equal(verified.witness.kind, "compaction");
  assert.equal(verified.witness.checkpoint.sourceEventSeq, f.checkpoint.sourceEventSeq);
  assert.equal(verified.witness.checkpoint.boundaryEventSeq, f.store.listEvents(f.run.id).at(-1).seq);
  assert.ok(verified.witness.checkpoint.boundaryEventSeq > verified.witness.checkpoint.sourceEventSeq);
  assert.deepEqual(verified.modelView, f.view); assert.equal(verified.modelViewArtifactId, f.artifact.id);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM run_progress_checkpoints").get().n, 0);
  f.track(); const sealed = f.seal(); assert.equal(sealed.seal.modelViewArtifactId, f.artifact.id);
  f.begin(); await f.drain(); assert.equal(f.commit().state, "stopped");
});

for (const drift of ["missing_install", "failed_install", "late_text", "foreign_marker", "summary_body", "snapshot_body", "checkpoint_revision", "policy", "question"])
test(`compaction ${drift} cannot become suspension authority`, async t => {
  const f = await fixture(t);
  if (drift === "missing_install") f.db.prepare("DELETE FROM run_events WHERE run_id=? AND seq=?").run(f.run.id, f.installed.seq);
  if (drift === "failed_install") f.db.prepare("UPDATE run_events SET data_json=json_set(data_json,'$.outcome','failed') WHERE run_id=? AND seq=?").run(f.run.id, f.installed.seq);
  if (drift === "late_text") f.store.appendExecutionEvent(f.run.id, f.fence, "assistant_text_delta", { text: "new uncheckpointed progress" });
  if (drift === "foreign_marker") f.store.appendEvent(f.run.id, "turn_start", { attemptId: "foreign" });
  if (drift === "summary_body" || drift === "snapshot_body") f.db.prepare("UPDATE artifacts SET sealed_payload_json=sealed_payload_json||' ' WHERE id=?").run(drift === "summary_body" ? f.artifact.id : f.snapshotArtifact.id);
  if (drift === "checkpoint_revision") {
    const before = f.read(); assert.equal(before.kind, "verified");
    f.db.prepare("UPDATE run_compaction_checkpoints SET revision=revision+1 WHERE id=?").run(f.checkpoint.id);
    const requested = f.suspension.requestRunSuspension({ ...f.root.input, now: stopNow() });
    assert.throws(() => f.suspension.sealRunSuspension({ suspensionId: requested.id, sourceFence: f.fence, witness: before.witness, now: stopNow() })); return;
  }
  if (drift === "policy") f.store.updateApprovalPolicy({ toolDecisions: { read: "deny" } }, stopNow());
  if (drift === "question") f.store.createApprovalRequest({ runId: f.run.id, taskId: f.run.taskId, actionType: "bash", risk: "medium", title: "Pending", description: "Pending",
    payload: { type: "bash", command: "echo fixture", cwd: f.cwd, riskFlags: [] } }, stopNow());
  assert.equal(f.read().kind, "blocked");
});

test("post-seal compaction drift fails stop atomically and retained compaction inputs survive collection", async t => {
  const f = await fixture(t); f.track(); f.seal(); f.begin(); await f.drain();
  for (const artifactId of [f.snapshotArtifact.id, f.artifact.id]) f.store.enrollHarnessArtifactRetention({ artifactId, retainUntil: stopNow(), now: stopNow() });
  assert.deepEqual(f.store.collectHarnessArtifactBodies({ now: stopNow() }).prunedArtifactIds, []);
  f.db.prepare("UPDATE run_compaction_checkpoints SET revision=revision+1 WHERE id=?").run(f.checkpoint.id);
  const before = f.snapshot(); assert.throws(() => f.commit()); assert.deepEqual(f.snapshot(), before);
});

test("real compaction predecessor prefixes keep every retained input through stop", async t => {
  const f = await fixture(t); progress(f, "one"); const latest = progress(f, "two");
  const read = f.read(); assert.equal(read.kind, "verified", JSON.stringify(read)); assert.deepEqual(read.modelView, latest.modelView);
  f.track(); f.seal(); f.begin(); await f.drain(); assert.equal(f.commit().state, "stopped");
  for (const artifact of f.store.listArtifacts(f.run.id).filter(row => row.contentType?.includes("compaction")))
    f.store.enrollHarnessArtifactRetention({ artifactId: artifact.id, retainUntil: stopNow(), now: stopNow() });
  assert.deepEqual(f.store.collectHarnessArtifactBodies({ now: stopNow() }).prunedArtifactIds, []);
});

test("historical seal cannot truncate a retained progress predecessor into an invented compaction root", async t => {
  const f = await fixture(t), middle = progress(f, "middle"); progress(f, "latest"); f.seal();
  replaceBody(f, middle.artifact, payload => { payload.boundary = "run-compaction-summary"; });
  assert.throws(() => f.suspension.getRunSuspension(f.root.suspensionId));
});

for (const change of ["prefix", "arguments", "result", "ids", "final", "new_user", "orphan_result", "predecessor", "install_attempt"])
test(`cryptographically valid compaction ${change} drift still cannot grant authority`, async t => {
  const f = await fixture(t), p = progress(f);
  if (change === "predecessor") f.db.prepare("UPDATE run_compaction_checkpoints SET predecessor_id=id WHERE id=?").run(p.checkpoint.id);
  else if (change === "install_attempt") f.db.prepare("UPDATE run_events SET data_json=json_set(data_json,'$.attemptId','foreign') WHERE run_id=? AND seq=?").run(f.run.id, f.installed.seq);
  else replaceBody(f, p.artifact, payload => {
    if (change === "prefix") payload.modelView[0].summary += "changed";
    if (change === "arguments") payload.modelView.at(-2).content[0].arguments.path = "different.txt";
    if (change === "result") payload.modelView.at(-1).content[0].text = "not canonical";
    if (change === "ids") payload.completedToolCallIds = ["not the actual tool"];
    if (change === "final") payload.modelView.push({ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" });
    if (change === "new_user") payload.modelView.splice(-2, 0, { role: "user", content: "new unauthorized instruction" });
    if (change === "orphan_result") payload.modelView.at(-1).toolCallId = "orphan";
  });
  assert.equal(f.read().kind, "blocked");
});

test("delegated compaction uses the same witness while preserving the parent and reservation", async t => {
  const f = await fixture(t, { child: true });
  f.track(); f.seal(); assert.equal(f.begin().begin.source.kind, "delegated"); await f.drain();
  assert.equal(f.commit().state, "stopped"); assert.equal(f.store.getRun("root").status, "running");
  assert.equal(f.store.getWorkUnitAttempt(f.fence.attemptId).status, "cancelled");
});

test("stopped compaction observation requires the real drain receipt and is read-only, not a live-owner exemption", async t => {
  const f = await fixture(t); f.track(); f.seal();
  const input = () => ({ suspensionId: f.root.suspensionId, sourceFence: f.fence, now: stopNow() });
  const observe = () => f.stops.readStoppedCompactionSuspensionRecovery(input());
  let before = f.snapshot(); assert.equal(observe().kind, "blocked"); assert.deepEqual(f.snapshot(), before);
  f.begin(); before = f.snapshot(); assert.equal(observe().kind, "blocked"); assert.deepEqual(f.snapshot(), before);
  await f.drain(); f.commit(); before = f.snapshot();
  const observed = observe(); assert.equal(observed.kind, "verified", JSON.stringify(observed)); assert.deepEqual(observed.modelView, f.view);
  assert.equal(f.read().kind, "blocked"); assert.deepEqual(f.snapshot(), before);
  assert.equal(f.stops.readStoppedCompactionSuspensionRecovery({ ...input(), sourceFence: { ...f.fence, fencingToken: "foreign" } }).kind, "blocked");
  assert.deepEqual(f.snapshot(), before);
});

for (const drift of ["policy", "body", "canonical", "receipt"])
test(`stopped observation rejects ${drift} drift without writes`, async t => {
  const f = await fixture(t); f.track(); f.seal(); f.begin(); await f.drain(); f.commit();
  if (drift === "policy") f.store.updateApprovalPolicy({ toolDecisions: { read: "deny" } }, stopNow());
  if (drift === "body") f.db.prepare("UPDATE artifacts SET sealed_payload_json=sealed_payload_json||' ' WHERE id=?").run(f.snapshotArtifact.id);
  if (drift === "canonical") f.store.appendEvent(f.run.id, "assistant_text_delta", { text: "late stale output" });
  if (drift === "receipt") {
    const receipt = f.stops.getRunSuspensionStop(f.root.suspensionId);
    f.db.prepare("UPDATE artifacts SET sealed_payload_json=sealed_payload_json||' ' WHERE id=?").run(receipt.receiptArtifactId);
  }
  const before = f.snapshot();
  assert.equal(f.stops.readStoppedCompactionSuspensionRecovery({ suspensionId: f.root.suspensionId, sourceFence: f.fence, now: stopNow() }).kind, "blocked");
  assert.deepEqual(f.snapshot(), before);
});

test("public compaction observation rejects getters and foreign owners without invoking caller code", async t => {
  const f = await fixture(t); let called = false;
  const result = f.store.readRunCompactionSuspensionWitness({ get runId() { called = true; return f.run.id; },
    sourceFence: f.fence, expectedLineage: f.root.lineage });
  assert.equal(result.kind, "blocked"); assert.equal(called, false);
  assert.equal(f.store.readRunCompactionSuspensionWitness({ runId: f.run.id, sourceFence: { ...f.fence, attemptId: "foreign" },
    expectedLineage: f.root.lineage }).kind, "blocked");
});

test("stopped ordinary source stays non-compacted and receives no new recovery authority", async t => {
  const f = await suspensionStopFixture(t); f.track(); f.seal(); f.begin(); await f.drain(); f.commit();
  const before = f.snapshot();
  assert.equal(f.stops.readStoppedCompactionSuspensionRecovery({ suspensionId: f.root.suspensionId, sourceFence: f.fence, now: stopNow() }).kind, "not_compacted");
  assert.deepEqual(f.snapshot(), before);
});

for (const toolName of ["write", "bash", "external_mcp_tool"])
test(`compacted ${toolName} text without dedicated Host effect evidence cannot be sealed`, async t => {
  const f = await fixture(t), args = { path: "fixture.txt" };
  for (const row of f.db.prepare("SELECT seq,data_json FROM run_events WHERE run_id=? AND type IN ('tool_start','tool_end')").all(f.run.id)) {
    const data = JSON.parse(row.data_json); data.toolName = toolName;
    f.db.prepare("UPDATE run_events SET data_json=? WHERE run_id=? AND seq=?").run(JSON.stringify(data), f.run.id, row.seq);
  }
  replaceBody(f, f.artifact, payload => {
    payload.modelView.at(-2).content[0].name = toolName; payload.modelView.at(-2).content[0].arguments = args;
    payload.modelView.at(-1).toolName = toolName;
  });
  assert.equal(f.read().kind, "blocked");
});
