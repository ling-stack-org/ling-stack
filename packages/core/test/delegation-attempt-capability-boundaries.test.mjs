import assert from "node:assert/strict";
import test from "node:test";
import { assertUserInputQuiescence } from "../dist/storage/sqlite/user-input-wait-evidence.js";
import { hostAttemptReadScopeForSource } from "../dist/storage/sqlite/host-attempt-read-scope.js";
import { readUserInputDurableSettlementsByAttempt } from "../dist/storage/sqlite/user-input-durable-quiescence.js";
import { resumedDelegationFixture, capabilityNow } from "./support/resumed-delegation-fixture.mjs";
import { officeTerminalFixture } from "./support/host-office-local-terminal-fixture.mjs";

function assertQuiescent(f) {
  const stoppedAt = capabilityNow();
  const seq = f.db.prepare("SELECT COALESCE(MAX(seq),0) seq FROM run_events WHERE run_id=?").get(f.run.id).seq;
  f.db.exec("BEGIN IMMEDIATE");
  try {
    assertUserInputQuiescence(f.db, f.run.id, { kind: "runner_quiesced", runnerId: "pi", stoppedAt, lastRunEventSeq: seq }, stoppedAt, f.fence);
    f.db.exec("COMMIT");
  } catch (error) { f.db.exec("ROLLBACK"); throw error; }
}
function changeToolData(f, attemptId, change) {
  for (const row of f.db.prepare("SELECT id,data_json FROM run_events WHERE run_id=? AND type IN ('tool_start','tool_end')").all(f.run.id)) {
    const data = JSON.parse(row.data_json);
    if (data.attemptId !== attemptId) continue;
    change(data);
    f.db.prepare("UPDATE run_events SET data_json=? WHERE id=?").run(JSON.stringify(data), row.id);
  }
}
function removeHistoricalCompletion(f) {
  assert.throws(() => f.db.prepare("UPDATE host_attempt_completions SET drained_at=NULL WHERE attempt_id=?")
    .run(f.oldFence.attemptId), /host_attempt_completion_terminal_immutable/,
  "a resumed Attempt never makes the original terminal Host receipt mutable");
  // Isolated database fault injection: a valid resume happened first. Missing
  // original evidence must be rechecked, not hidden by the later capability.
  assert.equal(f.db.prepare("DELETE FROM host_attempt_completions WHERE attempt_id=?")
    .run(f.oldFence.attemptId).changes, 1);
}

test("resumed delegated user-input stop verifies historical receipts without flattening tool IDs", async t => {
  const f = await resumedDelegationFixture(t);
  assert.equal(hostAttemptReadScopeForSource(f.db, f.source), "exact_attempt");
  assertQuiescent(f);
  f.tool(f.source, "tool_start", "read"); f.tool(f.source, "tool_end", "read");
  assertQuiescent(f);
  const byAttempt = readUserInputDurableSettlementsByAttempt(f.db, f.run.id, f.fence, Date.now(), "exact_attempt");
  assert.equal(byAttempt.get(f.oldFence.attemptId).get("reused-call"), "bash");
  assert.equal(byAttempt.get(f.fence.attemptId)?.has("reused-call") ?? false, false,
    "a builtin read in the new Attempt never borrows the old command receipt");
});

test("ordinary Run user-input stop keeps strict whole-Run behavior", async t => {
  const f = await resumedDelegationFixture(t, { delegated: false });
  assert.equal(hostAttemptReadScopeForSource(f.db, f.source), "whole_run");
  assert.throws(() => assertQuiescent(f), { code: "not_quiescent" });
});

for (const position of ["historical", "current"]) test(`${position} tool event missing Host Attempt attribution remains a stop veto`, async t => {
  const f = await resumedDelegationFixture(t);
  if (position === "current") { f.tool(f.source, "tool_start", "read"); f.tool(f.source, "tool_end", "read"); }
  changeToolData(f, position === "current" ? f.fence.attemptId : f.oldFence.attemptId, data => { delete data.attemptId; });
  assert.throws(() => assertQuiescent(f), { code: "not_quiescent" });
});

test("foreign and unknown event Attempt identities cannot disappear as historical events", async t => {
  for (const foreignId of ["missing-attempt", "root-attempt"]) {
    const f = await resumedDelegationFixture(t);
    changeToolData(f, f.oldFence.attemptId, data => { data.attemptId = foreignId; });
    assert.throws(() => assertQuiescent(f), { code: "not_quiescent" });
  }
});

test("historical tool names still match independently reverified durable receipts", async t => {
  const f = await resumedDelegationFixture(t);
  changeToolData(f, f.oldFence.attemptId, data => { data.toolName = "write"; });
  assert.throws(() => assertQuiescent(f), { code: "not_quiescent" });
});

test("a historical unmatched tool_start is not hidden by a closed Host lifetime", async t => {
  const f = await resumedDelegationFixture(t);
  f.db.prepare("DELETE FROM run_events WHERE run_id=? AND type='tool_end' AND json_extract(data_json,'$.attemptId')=?")
    .run(f.run.id, f.oldFence.attemptId);
  assert.throws(() => assertQuiescent(f), { code: "not_quiescent" });
});

test("a logical Run terminal still vetoes a resumed user-input stop", async t => {
  const f = await resumedDelegationFixture(t);
  f.store.appendEvent(f.run.id, "run_cancelled", { reason: "cancelled" }, capabilityNow());
  assert.throws(() => assertQuiescent(f), { code: "not_quiescent" });
});

test("missing original Host completion still blocks resumed user-input quiescence", async t => {
  const f = await resumedDelegationFixture(t);
  removeHistoricalCompletion(f);
  assert.throws(() => assertQuiescent(f), { code: "not_quiescent" });
});

function checkpoint(f) {
  const at = capabilityNow(), run = f.store.getRun(f.run.id), policyVersion = "pi_sdk_lifecycle_v1";
  const context = f.store.createArtifact({ runId: run.id, type: "json", path: "resume-context.json",
    contentType: "application/vnd.ling.pi-compaction-context+json", sealedPayload: { messages: [] }, createdAt: at });
  const start = f.store.appendExecutionEvent(run.id, f.fence, "context_compaction_start",
    { reason: "threshold", policyVersion, attemptId: f.fence.attemptId, checkpointArtifactId: context.id }, at);
  const summary = f.store.createArtifact({ runId: run.id, type: "json", path: "resume-summary.json",
    contentType: "application/vnd.ling.run-compaction-summary+json", sealedPayload: { summary: "Preserve completed work" }, createdAt: at });
  const prepared = f.store.createRunCompactionCheckpoint({ runId: run.id, attemptId: f.fence.attemptId,
    sourceEventSeq: start.seq, contextSnapshotArtifactId: context.id, summaryArtifactId: summary.id,
    contextViewId: run.contextViewId,
    summaryContentSha256: summary.contentSha256, providerName: run.providerName, providerModel: run.providerModel,
    policyVersion, policySnapshotFingerprint: "a".repeat(64), workspaceProvenanceWatermark: f.store.getLatestWorkspaceProvenanceWatermark(),
    objective: "Continue delegated work", createdAt: at });
  const committed = f.store.transitionRunCompactionCheckpoint({ id: prepared.id, expectedRevision: 0, state: "committed", now: at });
  f.store.appendExecutionEvent(run.id, f.fence, "context_compaction_end",
    { reason: "threshold", policyVersion, attemptId: f.fence.attemptId, outcome: "sdk_installed", willRetry: false }, at);
  return () => f.store.sealHostCompactionResourceBoundary({ source: f.source, checkpointId: committed.id,
    inventory: { schemaVersion: 1, toolCallIds: ["current-read"], settledBuiltinReads: [{ toolCallId: "current-read", toolName: "read" }] }, now: capabilityNow() });
}

test("resumed delegated compaction boundary excludes only verified closed historical effects", async t => {
  const f = await resumedDelegationFixture(t), seal = checkpoint(f);
  assert.equal(typeof seal(), "string");
  removeHistoricalCompletion(f);
  assert.equal(seal(), undefined, "a saved boundary never overrides a new historical stop veto");
});

test("ordinary mixed-Attempt compaction boundary remains unverified", async t => {
  const f = await resumedDelegationFixture(t, { delegated: false });
  assert.equal(checkpoint(f)(), undefined);
});

test("resumed delegated Office pair settles real native file effects despite safe old command facts", async t => {
  const f = await resumedDelegationFixture(t), office = await officeTerminalFixture(t, f, { fixedWriter: true });
  office.commit(office.published());
  const pair = office.store.settleHostOfficeLocalExecution(office.ticket);
  assert.equal(pair.parent.phase, "safe"); assert.equal(pair.producer.phase, "safe");
  assert.equal(pair.parent.source.attemptId, f.fence.attemptId);
  assert.equal(office.other.getHostOperation(pair.parent.operationId).evidenceDigest, pair.parent.evidenceDigest);
});

for (const delegated of [false, true]) test(`Office pair retains unsafe historical scope for delegated=${delegated}`, async t => {
  const f = await resumedDelegationFixture(t, { delegated }), office = await officeTerminalFixture(t, f, { fixedWriter: true });
  office.commit(office.published());
  if (delegated) removeHistoricalCompletion(f);
  const before = f.db.prepare("SELECT phase FROM host_operations WHERE operation_id IN (?,?) ORDER BY operation_id")
    .all(office.parent.operationId, office.producer.operationId);
  assert.throws(() => office.store.settleHostOfficeLocalExecution(office.ticket));
  assert.deepEqual(f.db.prepare("SELECT phase FROM host_operations WHERE operation_id IN (?,?) ORDER BY operation_id")
    .all(office.parent.operationId, office.producer.operationId), before,
  "an invalid history cannot partially publish either Office safe role");
});
