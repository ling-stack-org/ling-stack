import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyConversationModeToEffectiveRunPolicySnapshot,
  captureRunProgressCheckpointLineage,
  createSqliteRunStore,
  resolveSessionRunPolicy,
  toRuntimeAttemptFence,
} from "../dist/index.js";
import { SqliteDelegationLifecycleStore } from "../dist/storage/sqlite/delegation-lifecycle-store.js";
import { createBudgetHarness } from "./support/delegation-budget-fixture.mjs";

const clock = () => new Date().toISOString();
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const assertCommitted = result => assert.equal(result.kind, "committed", JSON.stringify(result));
const assertBlocked = (result, code) => {
  assert.equal(result.kind, "blocked", JSON.stringify(result));
  if (code) assert.equal(result.code, code);
};
const counts = f => ["artifacts", "run_progress_checkpoints", "run_progress_checkpoint_heads"].map(table =>
  Number(f.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n));

/** Real Core SQLite lifecycle and checkpoint authority, not SDK/OS or packaged-client evidence. */
async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-delegation-progress-")), at = clock();
  const f = createBudgetHarness(cwd, { now: at, later: at });
  t.after(async () => { f.other?.close(); f.store.close(); await rm(cwd, { recursive: true, force: true }); });
  // The small budget harness omits conversation identity. Seed its existing
  // parent with the real product's Thread before the lifecycle inherits it.
  const thread = f.store.createLingThread({ kind: "conversation", title: "Progress recovery fixture", objective: "Resume once" }, at);
  f.db.prepare("UPDATE run_sessions SET thread_id=? WHERE id='root'").run(thread.id);
  f.freeze(); f.start();
  const child = f.spawn({ now: clock() });
  const observations = new WeakMap(), preparations = new WeakMap();
  const lifecycle = new SqliteDelegationLifecycleStore({ database: f.db }, {
    getRun: id => f.store.getRun(id),
    getWorkUnit: id => f.store.getWorkUnit(id),
    getWorkUnitAttempt: id => f.store.getWorkUnitAttempt(id),
    getDelegationStep: id => f.store.getDelegationStep(id),
    getDelegationBudgetReservation: id => f.writer.getDelegationBudgetReservation(id),
    getArtifact: id => f.store.getArtifact(id),
    createArtifactWithinTransaction: input => f.ports.createArtifactWithinTransaction(input),
    createWorkUnitAttemptWithinTransaction: input => f.store.runtimeWorkUnits.createWorkUnitAttemptWithinTransaction(input),
    transitionRunStatus: input => f.store.transitionRunStatus(input),
    transitionWorkUnitStatus: input => f.store.transitionWorkUnitStatus(input),
    updateWorkUnitAttemptStatus: input => f.store.updateWorkUnitAttemptStatus(input),
    appendRuntimeEvent: input => f.store.appendRuntimeEvent(input),
    getHostAttemptCompletion: source => f.store.getHostAttemptCompletion(source),
    appendTerminalRuntimeAudit: input => f.store.appendTerminalRuntimeAudit(input),
    releaseResourceLeasesForAttempt: (...args) => f.store.releaseResourceLeasesForAttempt(...args),
    releaseRuntimeSemaphoreSlotsForAttempt: (...args) => f.store.releaseRuntimeSemaphoreSlotsForAttempt(...args),
    assertDispatchAuthorityWithinTransaction: input => f.writer.assertDelegatedChildDispatchAuthorityWithinTransaction(input),
    readRunnerStartObservation: token => { assert.ok(observations.has(token)); return structuredClone(observations.get(token)); },
    readExecutionPreparation: token => { assert.ok(preparations.has(token)); return structuredClone(preparations.get(token)); },
  });
  const claimed = lifecycle.claimDelegatedChild({ reservationId: child.reservation.id, expectedStepRevision: 0,
    runtimeInstanceId: "checkpoint-source", now: clock() });
  const sourceFence = toRuntimeAttemptFence(claimed.attempt), run = claimed.run;
  const acceptedPrompt = `Task: ${run.taskSnapshot.title}\n\n${run.taskSnapshot.prompt}`;
  const preparedBody = { schemaVersion: 1, boundary: "pi-model-context", taskId: run.taskId,
    systemPrompt: "Fixture system", userPrompt: acceptedPrompt,
    model: { id: run.providerModel, provider: run.providerName, api: "openai-responses", baseUrl: "https://provider.invalid/v1",
      reasoning: false, input: ["text"], contextWindow: 100_000, maxTokens: 8192 },
    thinkingLevel: "off", tools: [{ name: "read", description: "Fixture read", parameters: { type: "object" } }] };
  const execution = { schemaVersion: 1, runnerId: "pi", input: { cwd, task: structuredClone(run.taskSnapshot),
    provider: { provider: run.providerName, model: run.providerModel, api: "openai-responses", baseUrl: "https://provider.invalid/v1" },
    tools: ["read"], systemPrompt: "Fixture system" }, toolHydrationEnabled: false,
    preparedInput: { ...preparedBody, fingerprint: digest(preparedBody) } };
  const policy = applyConversationModeToEffectiveRunPolicySnapshot(resolveSessionRunPolicy({ workspacePolicy: f.store.getApprovalPolicy(),
    authorizationMode: "smart", workspaceAccessMode: "workspace_write", channelBoundPath: run.cwd }).snapshot, thread.conversationMode.mode);
  const preparation = Object.freeze({});
  preparations.set(preparation, { schemaVersion: 1, kind: "delegation.execution.v1", stepId: child.stepId,
    reservationId: child.reservation.id, rootRunId: "root", parentRunId: "root", childRunId: run.id, sourceFence,
    runnerId: "pi", preparedAt: clock(), requestSnapshot: { cwd, task: structuredClone(run.taskSnapshot), parentRunId: "root",
      runnerId: "pi", authorizationMode: "smart", workspaceAccessMode: "workspace_write",
      ...(run.teammateId ? { teammateId: run.teammateId } : {}),
      ...(run.workflowStepId ? { workflowStepId: run.workflowStepId } : {}),
      ...(run.threadId ? { threadId: run.threadId } : {}),
      ...(run.providerPresetId ? { providerPresetId: run.providerPresetId } : {}) },
    runnerExecutionInput: execution, effectivePolicySnapshot: policy });
  const prepared = lifecycle.commitDelegatedChildPreparation({ reservationId: child.reservation.id, sourceFence, preparation, now: clock() });
  const start = current => {
    const fence = toRuntimeAttemptFence(current.attempt), observation = Object.freeze({});
    observations.set(observation, { childRunId: run.id, sourceFence: fence, runnerId: "pi",
      observationId: `accepted:${fence.attemptId}`, observedAt: clock() });
    return lifecycle.commitDelegatedChildStart({ reservationId: child.reservation.id, sourceFence: fence, observation, now: clock() });
  };
  start(claimed);
  const view = [{ role: "user", content: acceptedPrompt, timestamp: 1 }];
  const addRead = (id = "source-read", fence = sourceFence) => {
    const args = { path: `${id}.txt` }, content = [{ type: "text", text: `Settled fixture read ${id}` }];
    f.store.appendExecutionEvent(run.id, fence, "tool_start", { toolCallId: id, toolName: "read", args }, clock());
    f.store.appendExecutionEvent(run.id, fence, "tool_end", { toolCallId: id, toolName: "read", result: { content }, isError: false }, clock());
    view.push({ role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: args }], stopReason: "toolUse", timestamp: view.length + 1 },
      { role: "toolResult", toolCallId: id, toolName: "read", content, isError: false, timestamp: view.length + 2 });
  };
  addRead();
  const lineage = captureRunProgressCheckpointLineage(f.store, f.store.getRun(run.id), policy).lineage;
  const input = (changes = {}) => ({ runId: run.id, sourceFence, expectedHead: { checkpointId: null, revision: 0 },
    sourceEventSeq: f.store.listEvents(run.id).at(-1).seq, expectedLineage: lineage, modelView: structuredClone(view), now: clock(), ...changes });
  const committed = f.store.commitRunProgressCheckpoint(input());
  assertCommitted(committed);
  const resume = async () => {
    let finish;
    const completion = f.store.trackHostAttemptCompletion({ runId: run.id, ...sourceFence }, new Promise(resolve => { finish = resolve; }),
      () => ({ schemaVersion: 1, toolCallIds: ["source-read"], settledBuiltinReads: [{ toolCallId: "source-read", toolName: "read" }] }));
    try {
      lifecycle.requestDelegatedChildInterrupt({ reservationId: child.reservation.id, parentFence: f.fence, callId: "interrupt-source", now: clock() });
    } finally { finish(); await completion; }
    const interrupted = lifecycle.commitDelegatedChildInterrupted({ reservationId: child.reservation.id, sourceFence, now: clock() });
    const target = lifecycle.resumeDelegatedChild({ reservationId: child.reservation.id, expectedStepRevision: interrupted.step.revision,
      runtimeInstanceId: "checkpoint-target", parentFence: f.fence, callId: "resume-checkpoint-target", now: clock() });
    return { target, binding: { reservationId: child.reservation.id, targetFence: toRuntimeAttemptFence(target.attempt) } };
  };
  const read = (binding, reader = f.store, changes = {}) => reader.readRunProgressCheckpointForRecovery({ runId: run.id,
    sourceFence, expectedLineage: lineage, delegationBinding: binding, ...changes });
  return Object.assign(f, { child, lifecycle, run, sourceFence, policy, execution, prepared, view, lineage,
    committed, input, addRead, resume, start, read });
}

test("delegated progress recovery verifies the persisted Pi input and exact stopped-to-created binding across connections", async t => {
  const f = await fixture(t), { target, binding } = await f.resume();
  assert.equal(f.store.getWorkUnitAttempt(f.sourceFence.attemptId).status, "cancelled");
  assert.equal(target.attempt.status, "created");
  assert.equal(target.attempt.attemptNumber, 2);
  assert.equal(f.store.getRun(f.run.id).contextViewId, f.prepared.artifactId);
  assert.deepEqual(f.store.getRun(f.run.id).requestSnapshot.runnerExecutionInput, f.execution);
  f.other = createSqliteRunStore(f.cwd);
  const read = f.read(binding, f.other);
  assert.equal(read.kind, "verified", JSON.stringify(read));
  assert.deepEqual(read.modelView, f.view);
  assert.deepEqual(read.witness.sourceFence, f.sourceFence);
  assert.equal(read.witness.checkpointId, f.committed.checkpoint.id);
  assert.equal(f.other.listEvents(f.run.id).filter(event => event.type === "tool_start").length, 1);
});

test("a started delegated successor may append its own settled result without replaying the historical read", async t => {
  const f = await fixture(t), { target, binding } = await f.resume(), prefix = structuredClone(f.view);
  f.start(target);
  // Host supplies lifecycle attribution; only tool events are auto-attributed by the Store.
  f.store.appendExecutionEvent(f.run.id, binding.targetFence, "run_start", { attemptId: binding.targetFence.attemptId, taskId: f.run.taskId,
    cwd: f.cwd, provider: f.run.providerName, model: f.run.providerModel }, clock());
  f.store.appendExecutionEvent(f.run.id, binding.targetFence, "turn_start", { attemptId: binding.targetFence.attemptId }, clock());
  const read = f.read(binding);
  assert.equal(read.kind, "verified", JSON.stringify(read));
  f.addRead("target-read", binding.targetFence);
  const next = f.store.commitRunProgressCheckpoint(f.input({ sourceFence: binding.targetFence,
    expectedHead: { checkpointId: read.witness.checkpointId, revision: read.witness.headRevision },
    recoveryPredecessor: read.witness, delegationBinding: binding }));
  assertCommitted(next);
  assert.equal(next.headRevision, 2);
  assert.equal(next.checkpoint.predecessorId, f.committed.checkpoint.id);
  const current = f.store.readRunProgressCheckpointForRecovery({ runId: f.run.id, sourceFence: binding.targetFence, expectedLineage: f.lineage });
  assert.equal(current.kind, "verified", JSON.stringify(current));
  assert.deepEqual(current.modelView.slice(0, prefix.length), prefix);
  assert.deepEqual(current.modelView, f.view);
  assert.deepEqual(f.store.listEvents(f.run.id).filter(event => event.type === "tool_start").map(event =>
    [event.data.toolCallId, event.data.attemptId]), [["source-read", f.sourceFence.attemptId], ["target-read", binding.targetFence.attemptId]]);
});

test("a delegated handoff requires both the exact reservation and every target-fence field", async t => {
  const f = await fixture(t), { binding } = await f.resume(), before = counts(f);
  for (const invalid of [
    { ...binding, reservationId: "foreign-reservation" },
    ...["workUnitId", "attemptId", "runtimeInstanceId", "fencingToken"].map(key =>
      ({ ...binding, targetFence: { ...binding.targetFence, [key]: "foreign" } })),
  ]) {
    assertBlocked(f.read(invalid), "checkpoint.lineage_mismatch");
    assert.deepEqual(counts(f), before);
  }
  assert.equal(f.read(binding).kind, "verified");
});

test("a delegated successor cannot advance the checkpoint without the authenticated predecessor binding", async t => {
  const f = await fixture(t), { target, binding } = await f.resume(), read = f.read(binding);
  assert.equal(read.kind, "verified", JSON.stringify(read));
  f.start(target); f.addRead("target-read", binding.targetFence);
  const next = f.input({ sourceFence: binding.targetFence,
    expectedHead: { checkpointId: read.witness.checkpointId, revision: read.witness.headRevision },
    recoveryPredecessor: read.witness, delegationBinding: binding });
  const before = counts(f);
  for (const changes of [
    { recoveryPredecessor: undefined },
    { delegationBinding: undefined },
    { recoveryPredecessor: { ...read.witness, headRevision: read.witness.headRevision + 1 } },
    { delegationBinding: { ...binding, reservationId: "foreign-reservation" } },
  ]) {
    assertBlocked(f.store.commitRunProgressCheckpoint({ ...next, ...changes }), "checkpoint.lineage_mismatch");
    assert.deepEqual(counts(f), before);
  }
  assertCommitted(f.store.commitRunProgressCheckpoint(next));
});

test("corrupted nonadjacent Attempt numbering cannot borrow a valid delegated stop receipt", async t => {
  const f = await fixture(t), { binding } = await f.resume(), before = counts(f);
  // Isolated corruption injection only; production lifecycle always creates the adjacent Attempt.
  f.db.prepare("UPDATE work_unit_attempts SET attempt_number=3 WHERE id=?").run(binding.targetFence.attemptId);
  assertBlocked(f.read(binding), "checkpoint.lineage_mismatch");
  assert.deepEqual(counts(f), before);
});

test("a missing original Host drain receipt blocks an otherwise valid delegated recovery", async t => {
  const f = await fixture(t), { binding } = await f.resume(), before = counts(f);
  // Simulate incomplete/corrupt persisted state, never reconstruct a receipt from a stop label.
  f.db.prepare("DELETE FROM host_attempt_completions WHERE attempt_id=?").run(f.sourceFence.attemptId);
  assertBlocked(f.read(binding), "checkpoint.lineage_mismatch");
  assert.deepEqual(counts(f), before);
});

test("old live callbacks are fenced and an injected late source event also invalidates recovery", async t => {
  const f = await fixture(t), { binding } = await f.resume(), before = counts(f);
  const data = { toolCallId: "source-read", toolName: "read", result: { content: [{ type: "text", text: "late" }] }, isError: false };
  const eventCount = f.store.listEvents(f.run.id).length;
  assert.throws(() => f.store.appendExecutionEvent(f.run.id, f.sourceFence, "tool_end", data, clock()), { code: "stale_run_execution" });
  assert.equal(f.store.listEvents(f.run.id).length, eventCount);
  assert.equal(f.read(binding).kind, "verified");
  // Read-side fail-closed proof for corruption/import bypassing the normal writer fence.
  f.db.prepare("INSERT INTO run_events(id,run_id,seq,ts,type,data_json) VALUES(?,?,?,?,?,?)")
    .run("injected-late-source", f.run.id, eventCount + 1, clock(), "tool_end", JSON.stringify({ ...data, attemptId: f.sourceFence.attemptId }));
  assertBlocked(f.read(binding), "checkpoint.effect_unknown");
  assert.deepEqual(counts(f), before);
});

test("delegation and continuation bindings cannot be combined into ambiguous recovery authority", async t => {
  const f = await fixture(t), { binding } = await f.resume(), before = counts(f);
  assertBlocked(f.read(binding, f.store, { continuationBinding: { continuationId: "foreign-continuation", targetFence: binding.targetFence } }),
    "checkpoint.lineage_mismatch");
  assert.deepEqual(counts(f), before);
  assert.equal(f.read(binding).kind, "verified");
});

test("queued parent instructions are atomically checkpointed once and recover across SQLite connections", async t => {
  const f = await fixture(t);
  const appended = f.lifecycle.appendDelegationInstruction({ reservationId: f.child.reservation.id,
    parentFence: f.fence, messageCallId: "instruction-1", text: "Inspect only the current README.", now: clock() });
  const binding = { reservationId: f.child.reservation.id, targetFence: f.sourceFence };
  const ids = f.store.listPendingDelegationInstructionIds({ runId: f.run.id, sourceFence: f.sourceFence,
    delegationBinding: binding, limit: 32 });
  assert.deepEqual(ids, [appended.message.id]);
  const raw = f.input({ expectedHead: { checkpointId: f.committed.checkpoint.id, revision: f.committed.headRevision },
    sourceEventSeq: f.store.listEvents(f.run.id).at(-1).seq, delegationBinding: binding,
    delegationInstructionIds: ids });
  const committed = f.store.commitRunProgressCheckpoint(raw);
  assertCommitted(committed);
  assert.equal(committed.replayed, false);
  assert.equal(committed.delegationInstructions.length, 1);
  assert.equal(committed.delegationInstructions[0].content, "Inspect only the current README.");
  assert.equal(f.store.listPendingDelegationInstructionIds({ runId: f.run.id, sourceFence: f.sourceFence,
    delegationBinding: binding, limit: 32 }).length, 0);
  const receipt = f.db.prepare("SELECT * FROM delegation_instruction_receipts WHERE message_id=?").get(appended.message.id);
  assert.equal(receipt.checkpoint_id, committed.checkpoint.id);
  assert.equal(receipt.model_view_index, f.view.length + 1);
  const event = f.store.listEvents(f.run.id).at(-1);
  assert.equal(event.type, "delegation_instruction_checkpointed");
  assert.deepEqual(event.data.messageIds, ids);
  const replay = f.store.commitRunProgressCheckpoint(raw);
  assertCommitted(replay);
  assert.equal(replay.replayed, true);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM delegation_instruction_receipts").get().n, 1);
  f.other = createSqliteRunStore(f.cwd);
  const recovered = f.other.readRunProgressCheckpointForRecovery({ runId: f.run.id,
    sourceFence: f.sourceFence, expectedLineage: f.lineage });
  assert.equal(recovered.kind, "verified", JSON.stringify(recovered));
  assert.equal(recovered.modelView.filter(message => message.delegationInstruction?.messageId === appended.message.id).length, 1);
});

test("instruction receipt failure rolls checkpoint, event, artifact and head back together", async t => {
  const f = await fixture(t);
  const appended = f.lifecycle.appendDelegationInstruction({ reservationId: f.child.reservation.id,
    parentFence: f.fence, messageCallId: "instruction-fault", text: "Do not replay tools.", now: clock() });
  const binding = { reservationId: f.child.reservation.id, targetFence: f.sourceFence };
  const ids = [appended.message.id], before = {
    artifacts: f.db.prepare("SELECT COUNT(*) AS n FROM artifacts").get().n,
    checkpoints: f.db.prepare("SELECT COUNT(*) AS n FROM run_progress_checkpoints").get().n,
    events: f.db.prepare("SELECT COUNT(*) AS n FROM run_events").get().n,
    head: f.db.prepare("SELECT checkpoint_id,revision FROM run_progress_checkpoint_heads WHERE run_id=?").get(f.run.id),
  };
  f.db.exec(`CREATE TRIGGER fixture_instruction_receipt_fault BEFORE INSERT ON delegation_instruction_receipts
    BEGIN SELECT RAISE(ABORT,'injected instruction receipt fault'); END`);
  const result = f.store.commitRunProgressCheckpoint(f.input({
    expectedHead: { checkpointId: f.committed.checkpoint.id, revision: f.committed.headRevision },
    sourceEventSeq: f.store.listEvents(f.run.id).at(-1).seq, delegationBinding: binding,
    delegationInstructionIds: ids,
  }));
  assertBlocked(result, "checkpoint.commit_failed");
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM artifacts").get().n, before.artifacts);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM run_progress_checkpoints").get().n, before.checkpoints);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM run_events").get().n, before.events);
  assert.deepEqual(f.db.prepare("SELECT checkpoint_id,revision FROM run_progress_checkpoint_heads WHERE run_id=?").get(f.run.id), before.head);
  assert.equal(f.store.listPendingDelegationInstructionIds({ runId: f.run.id, sourceFence: f.sourceFence,
    delegationBinding: binding, limit: 32 }).length, 1);
});
