import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as core from "../dist/index.js";
import { createBudgetHarness } from "./support/delegation-budget-fixture.mjs";
import { SqliteDelegationLifecycleStore } from "../dist/storage/sqlite/delegation-lifecycle-store.js";
import { verifyCompactionSuspensionEffects } from "../dist/storage/sqlite/run-compaction-suspension-effects.js";

const now = "2026-10-13T03:00:00.000Z";
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const normalClose = { scope: "process_group", leaderExited: true, stdioClosed: true,
  descendants: "unverified", settledBy: "close", signalFailures: [] };

/** Core transaction fixture; not real SDK, OS execution, or packaged GUI evidence. */
async function fixture(t, extraTools = []) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-a21-progress-core-"));
  const f = { cwd, store: core.createSqliteRunStore(cwd) };
  t.after(async () => { f.other?.close(); f.store.close(); await rm(cwd, { recursive: true, force: true }); });
  f.channel = f.store.createChannel({ name: "Owned progress fixture", boundPath: cwd }, now);
  f.task = f.store.createTask({ channelId: f.channel.id, title: "Continue once", prompt: "Inspect a fixture result." }, now);
  f.thread = f.store.createLingThread({ kind: "task", channelId: f.channel.id, taskId: f.task.id, title: f.task.title, objective: f.task.prompt }, now);
  f.turn = f.store.appendConversationUserTurn({ threadId: f.thread.id, channelId: f.channel.id, title: f.task.title, userInstruction: f.task.prompt,
    idempotencyKey: "owned-user-turn", payload: { body: f.task.prompt, format: "markdown", mentions: [],
      attachmentIds: [], linkPreviewIds: [], fileRefs: [] } }, now);
  f.preset = f.store.createProviderPreset({ kind: "openai-compatible", displayName: "Owned source", providerId: "fixture",
    model: "fixture-model", api: "openai-completions", baseUrl: "https://fixture.invalid/v1", capabilities: ["chat", "tool_call"], enabled: true }, now);
  const task = { id: f.task.id, title: f.task.title, prompt: f.task.prompt, channelId: f.channel.id };
  const acceptedPrompt = `Channel: ${task.channelId}\n\nTask: ${task.title}\n\n${task.prompt}`;
  const preparedBody = { schemaVersion: 1, boundary: "pi-model-context", taskId: task.id, systemPrompt: "Fixture system",
    userPrompt: acceptedPrompt, model: { id: "fixture-model", provider: "fixture", api: "openai-completions",
      baseUrl: "https://fixture.invalid/v1", reasoning: false, input: ["text"], contextWindow: 100_000, maxTokens: 8192 },
    thinkingLevel: "off", tools: ["bash", "write", "edit", ...extraTools].map(name => ({ name, description: `Fixture ${name}`, parameters: { type: "object" } })) };
  f.execution = { schemaVersion: 1, runnerId: "pi", input: { cwd, task, provider: { provider: "fixture", model: "fixture-model",
    api: "openai-completions", baseUrl: "https://fixture.invalid/v1" }, tools: ["bash", "write", "edit", ...extraTools], systemPrompt: "Fixture system" },
    toolHydrationEnabled: false, preparedInput: { ...preparedBody, fingerprint: digest(preparedBody) } };
  const policy = core.resolveSessionRunPolicy({ workspacePolicy: f.store.getApprovalPolicy(),
    authorizationMode: "always", workspaceAccessMode: "full_access", channelBoundPath: cwd });
  f.policy = core.applyConversationModeToEffectiveRunPolicySnapshot(policy.snapshot, "default");
  f.unit = f.store.createWorkUnit({ workspaceId: core.DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "task", ownerId: f.task.id,
    taskId: f.task.id, channelId: f.channel.id, runnerId: "pi", status: extraTools.length ? "claimed" : "running", idempotencyKey: "unit", createdByActor: "system", request: {}, now });
  f.attempt = f.store.createWorkUnitAttempt({ workUnitId: f.unit.id, attemptNumber: 1, runtimeInstanceId: "source-A",
    runnerId: "pi", effectiveRunnerId: "pi", providerPresetId: f.preset.id, status: extraTools.length ? "created" : "started", now });
  f.run = f.store.createRun({ id: "progress-run", cwd, taskId: f.task.id, channelId: f.channel.id, threadId: f.thread.id, turnId: f.turn.turnId,
    workUnitId: f.unit.id, providerPresetId: f.preset.id, providerName: "fixture", providerModel: "fixture-model", taskSnapshot: task,
    providerSnapshot: {}, requestSnapshot: { authorizationMode: "always", workspaceAccessMode: "full_access",
      effectivePolicySnapshot: f.policy, runnerExecutionInput: f.execution }, contextViewId: "owned-context", contextViewCreatedAt: now, createdAt: now });
  f.store.linkRunToWorkUnit(f.run.id, f.unit.id, now);
  if (extraTools.length) {
    f.delegationBudget = createBudgetHarness(cwd, { store: f.store, rootRunId: f.run.id, now,
      later: new Date(Date.parse(now) + 1).toISOString() });
    f.delegationBudget.freeze();
    f.delegationBudget.start();
  } else f.store.markRunStarted(f.run.id, now);
  assert.equal(f.store.transitionTaskStatus({ taskId: f.task.id, expectedStatus: "todo", event: "claim", actor: "system", now }).ok, true);
  f.fence = core.toRuntimeAttemptFence(f.attempt);
  f.view = [{ role: "user", content: acceptedPrompt, timestamp: 1 }];
  f.addRound = (id = "call-1", source = f.fence) => {
    const args = { command: `echo ${id}` }, content = [{ type: "text", text: `result ${id}` }];
    f.view.push({ role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: args }], stopReason: "toolUse", timestamp: 2 });
    f.store.appendExecutionEvent(f.run.id, source, "tool_start", { toolCallId: id, toolName: "bash", args });
    const ticket = f.store.prepareHostCommandExecution({ runId: f.run.id, sourceFence: source, toolCallId: id,
      command: { kind: "shell", command: args.command, shell: "bash" }, cwd });
    f.store.settleHostCommandExecution(ticket, { kind: "observed", observation: normalClose });
    f.store.appendExecutionEvent(f.run.id, source, "tool_end", { toolCallId: id, toolName: "bash", result: { content }, isError: false });
    f.view.push({ role: "toolResult", toolCallId: id, toolName: "bash", content, isError: false, timestamp: 3 });
  };
  f.setBroker = mode => f.store.database.prepare(`UPDATE run_sessions SET request_snapshot_json=
    json_set(request_snapshot_json,'$.harnessFeatureSnapshot',json(?)) WHERE id=?`).run(JSON.stringify({ toolBroker: mode }), f.run.id);
  f.addFileRound = (name = "write", id = "file-1", dedicated = false, tracked = false, source = f.fence, canonical = true) => {
    const args = name === "write" ? { path: "result.txt", content: "owned result" }
      : { path: "result.txt", oldText: "old", newText: "owned result" };
    const content = [{ type: "text", text: `file result ${id}` }];
    if (canonical) {
      f.view.push({ role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }], stopReason: "toolUse", timestamp: 2 });
      f.store.appendExecutionEvent(f.run.id, source, "tool_start", { toolCallId: id, toolName: name, args });
    }
    let receipt;
    if (dedicated) {
      const at = () => new Date().toISOString();
      const ticket = tracked ? f.store.admitHostOperation({ operationId: `op-${id}`, kind: "file_mutation",
        source: { runId: f.run.id, ...source }, toolCallId: id, admittedAt: at() }) : undefined;
      const requestDigest = core.digestHarnessToolValue({ schemaVersion: 1, toolName: name, toolCallId: id, cwd, input: args });
      const sideEffectFingerprint = requestDigest;
      const policy = f.store.createArtifact({ runId: f.run.id, type: "json", path: `harness/${id}/policy.json`, createdAt: at(),
        sealedPayload: { schemaVersion: 1, runId: f.run.id, attemptId: source.attemptId, toolCallId: id, executorKind: "write",
          brokerMode: "enforce", requestDigest, sideEffectFingerprint, effectivePolicySnapshot: f.policy } });
      const prepared = f.store.prepareHarnessToolExecution({ runId: f.run.id, workUnitId: f.unit.id, sourceFence: source,
        toolCallId: id, toolName: name, executorKind: "write", requestDigest, sideEffectFingerprint,
        policySnapshotArtifactId: policy.id, approvalState: "allowed", sandboxProfileId: "full_access", now: at() }).execution;
      if (ticket) f.store.bindHostOperationEvidence(ticket, { kind: "harness_tool_execution", id: prepared.id });
      const claimed = f.store.claimHarnessToolExecution({ executionId: prepared.id, expectedRevision: prepared.revision, sourceFence: source,
        claimOwner: "host", claimToken: `claim-${id}`, claimExpiresAt: new Date(Date.now() + 60_000).toISOString(), now: at() });
      assert.equal(claimed.ok, true, JSON.stringify(claimed));
      const started = f.store.startHarnessToolExecution({ executionId: prepared.id, expectedRevision: claimed.value.revision,
        sourceFence: source, claimOwner: "host", claimToken: `claim-${id}`, now: at() });
      assert.equal(started.ok, true, JSON.stringify(started));
      if (ticket) f.store.launchHostOperation(ticket, () => 1);
      const artifact = f.store.createArtifact({ runId: f.run.id, type: "json", path: `harness/${prepared.id}/result.json`, createdAt: at(),
        sealedPayload: { status: "applied", format: "ling-apply-patch-v1", touchedPaths: ["result.txt"], rawPatchSha256: "c".repeat(64) } });
      const resultSummary = { status: "applied", outcome: "applied", touchedPaths: ["result.txt"], artifactCount: 1, cancelled: false };
      const finished = f.store.finishHarnessToolExecution({ executionId: prepared.id, expectedRevision: started.value.revision,
        sourceFence: source, claimOwner: "host", claimToken: `claim-${id}`, nextState: "succeeded",
        resultSummary, resultDigest: core.digestHarnessToolValue(resultSummary), evidenceArtifactIds: [artifact.id], now: at() });
      assert.equal(finished.ok, true, JSON.stringify(finished));
      if (ticket) f.store.settleHostOperation(ticket, { kind: "file_completed", settledAt: at() });
      receipt = { row: finished.value, policy, artifact, ticket };
    }
    if (canonical) {
      f.store.appendExecutionEvent(f.run.id, source, "tool_end", { toolCallId: id, toolName: name, result: { content }, isError: false });
      f.view.push({ role: "toolResult", toolCallId: id, toolName: name, content, isError: false, timestamp: 3 });
    }
    return receipt;
  };
  f.input = (head = { checkpointId: null, revision: 0 }, extra = {}) => ({ runId: f.run.id, sourceFence: f.fence,
    sourceEventSeq: f.store.listEvents(f.run.id).at(-1)?.seq ?? 0, expectedHead: head,
    expectedLineage: core.captureRunProgressCheckpointLineage(f.store, f.store.getRun(f.run.id), f.policy).lineage,
    modelView: structuredClone(f.view), now, ...extra });
  f.read = (writer = f.store, extra = {}) => writer.readRunProgressCheckpointForRecovery({ runId: f.run.id, sourceFence: f.fence,
    expectedLineage: core.captureRunProgressCheckpointLineage(f.store, f.store.getRun(f.run.id), f.policy).lineage, ...extra });
  f.openOther = () => f.other = core.createSqliteRunStore(cwd);
  f.loseSource = () => {
    assert.ok(f.store.updateWorkUnitAttemptStatus({ ...f.fence, status: "lost", now, endedAt: now }));
    assert.equal(f.store.transitionWorkUnitStatus({ workUnitId: f.unit.id, expectedStatus: "running", event: "runner_lost",
      actor: "system", now }).ok, true);
  };
  f.startB = (activation, canonicalType) => {
    const fence = core.toRuntimeAttemptFence(activation.attempt);
    assert.equal(f.store.claimRunnerContinuation({ continuationId: activation.continuation.id, expectedRevision: 0,
      claimOwner: "daemon", claimToken: "owned-B", claimExpiresAt: "2026-10-13T04:00:00.000Z", now }).ok, true);
    assert.equal(f.store.startRunnerContinuation({ continuationId: activation.continuation.id, expectedRevision: 1,
      claimOwner: "daemon", claimToken: "owned-B", targetFence: fence, now }).ok, true);
    assert.equal(f.store.transitionWorkUnitStatus({ workUnitId: f.unit.id, expectedStatus: "queued", event: "claim", actor: "system", now }).ok, true);
    assert.equal(f.store.transitionWorkUnitStatus({ workUnitId: f.unit.id, expectedStatus: "claimed", event: "runner_started", actor: "system", now }).ok, true);
    if (canonicalType !== undefined) f.store.appendExecutionEvent(f.run.id, fence, "run_start", {
      type: canonicalType, attemptId: fence.attemptId, taskId: f.task.id, cwd: f.cwd, provider: f.run.providerName, model: f.run.providerModel });
    else f.store.markRunStarted(f.run.id, now);
    return fence;
  };
  f.activation = (guard, key = "owned-recovery") => {
    const artifact = f.store.createArtifact({ runId: f.run.id, type: "json", path: `${f.run.id}/replay.json`,
      sealedPayload: { purpose: "activation fixture, not checkpoint authority" }, createdAt: now });
    return { preparation: { runId: f.run.id, workUnitId: f.unit.id, sourceFence: f.fence, expectedTargetAttemptId: f.attempt.id,
      origin: "daemon_recovery", strategy: "deterministic_replay", runnerId: "pi", runnerCapabilityRevision: "pi:fixture",
      contextViewId: f.run.contextViewId, contextSnapshotArtifactId: artifact.id, idempotencyKey: key, generation: 0,
      targetAttempt: { runtimeInstanceId: "target-B", runnerId: "pi", effectiveRunnerId: "pi", providerPresetId: f.preset.id }, now },
      expectedRunStatus: "running", expectedWorkUnitStatus: "stale", expectedTaskStatus: "claimed", actor: "system", reason: "fixture", now,
      ...(guard ? { recoveryProgressCheckpointGuard: guard } : {}) };
  };
  return f;
}
const headOf = result => ({ checkpointId: result.checkpoint.id, revision: result.headRevision });
const assertCommitted = result => assert.equal(result.kind, "committed", JSON.stringify(result));
const assertBlocked = (result, code) => { assert.equal(result.kind, "blocked", JSON.stringify(result)); if (code) assert.equal(result.code, code); };
const counts = f => ["artifacts", "run_progress_checkpoints", "run_progress_checkpoint_heads"].map(table =>
  Number(f.store.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n));

/** Full canonical failed result, paired with genuine dedicated Host journal rows. */
function addClosedFailedBash(f, { mutate = () => {}, observation = normalClose, settle = true, receipt = true,
  source = f.fence, id = "closed-failure", cwd = f.cwd } = {}) {
  const args = { command: "printf 'observed failure\\n'; exit 7", ...(cwd === f.cwd ? {} : { cwd }) };
  const command = { kind: "shell", command: args.command, shell: "bash" };
  const content = [{ type: "text", text: "observed failure\n\nCommand exited with code 7" }];
  const unifiedExec = { status: "failed", runId: f.run.id, taskId: f.task.id, toolCallId: id,
    cwd, command, environmentSummary: { mode: "inherit_minimal", cwd, keys: [], redactedKeys: [] },
    startedAt: now, endedAt: now, durationMs: 1, exitCode: 7, timedOut: false, cancelled: false,
    processObservation: structuredClone(normalClose), stdout: { byteCount: 17, preview: "observed failure\n", truncated: false },
    stderr: { byteCount: 0, preview: "", truncated: false }, artifacts: [] };
  const result = { content, details: { unifiedExec } };
  mutate(result);
  f.view.push({ role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: args }], stopReason: "toolUse", timestamp: 2 });
  f.store.appendExecutionEvent(f.run.id, source, "tool_start", { toolCallId: id, toolName: "bash", args });
  if (receipt) {
    const ticket = f.store.prepareHostCommandExecution({ runId: f.run.id, sourceFence: source, toolCallId: id, command, cwd });
    if (settle) f.store.settleHostCommandExecution(ticket, { kind: "observed", observation });
  }
  f.store.appendExecutionEvent(f.run.id, source, "tool_end", { toolCallId: id, toolName: "bash", result, isError: true });
  f.view.push({ role: "toolResult", toolCallId: id, toolName: "bash", content, isError: true, timestamp: 3 });
}

test("A21 Core closed failed bash seals and reopens the exact original error view", async t => {
  const f = await fixture(t); addClosedFailedBash(f);
  const input = f.input(), committed = f.store.commitRunProgressCheckpoint(input); assertCommitted(committed);
  assert.deepEqual(f.store.getArtifact(committed.checkpoint.modelViewArtifactId).sealedPayload.completedToolCallIds, ["closed-failure"]);
  const read = f.read(f.openOther()); assert.equal(read.kind, "verified", JSON.stringify(read));
  assert.deepEqual(read.modelView, f.view); assert.equal(read.modelView.at(-1).isError, true);
  f.store.close(); f.store = core.createSqliteRunStore(f.cwd);
  assert.deepEqual(f.read().modelView, f.view);
  assert.equal(f.store.listHostCommandWriteBlockers(f.cwd).length, 0);
});

test("A21 Core closed failed bash remains historical A evidence when genuine B advances the head", async t => {
  const f = await fixture(t); addClosedFailedBash(f);
  const first = f.store.commitRunProgressCheckpoint(f.input()); assertCommitted(first);
  const read = f.read(); f.loseSource(); const activation = f.store.commitExistingRunContinuation(f.activation(read.witness));
  assert.equal(activation.ok, true, JSON.stringify(activation)); const target = f.startB(activation);
  f.addRound("later-success", target);
  const input = f.input(headOf(first), { sourceFence: target, recoveryPredecessor: read.witness });
  const second = f.store.commitRunProgressCheckpoint(input); assertCommitted(second);
  assert.equal(second.headRevision, 2);
  const recovered = f.read(f.openOther(), { sourceFence: target, expectedLineage: input.expectedLineage });
  assert.equal(recovered.kind, "verified", JSON.stringify(recovered)); assert.deepEqual(recovered.modelView, f.view);
  assert.equal(recovered.modelView.find(message => message.role === "toolResult" && message.toolCallId === "closed-failure").isError, true);
});

const failedBashMutations = {
  "missing canonical details": result => { delete result.details; },
  "missing canonical unifiedExec": result => { delete result.details.unifiedExec; },
  "wrong run": result => { result.details.unifiedExec.runId = "foreign"; },
  "wrong task": result => { result.details.unifiedExec.taskId = "foreign"; },
  "wrong call": result => { result.details.unifiedExec.toolCallId = "foreign"; },
  "different command": result => { result.details.unifiedExec.command = { kind: "shell", command: "exit 8", shell: "bash" }; },
  "different shell": result => { result.details.unifiedExec.command = { ...result.details.unifiedExec.command, shell: "zsh" }; },
  "different cwd": result => { result.details.unifiedExec.cwd = join(result.details.unifiedExec.cwd, "other"); },
  "relative cwd": result => { result.details.unifiedExec.cwd = "."; },
  "success status": result => { result.details.unifiedExec.status = "succeeded"; },
  "zero exit": result => { result.details.unifiedExec.exitCode = 0; },
  "missing exit": result => { delete result.details.unifiedExec.exitCode; },
  "negative exit": result => { result.details.unifiedExec.exitCode = -1; },
  "fractional exit": result => { result.details.unifiedExec.exitCode = 1.5; },
  "timed out": result => { result.details.unifiedExec.timedOut = true; },
  "cancelled": result => { result.details.unifiedExec.cancelled = true; },
  "missing timeout flag": result => { delete result.details.unifiedExec.timedOut; },
  "missing cancellation flag": result => { delete result.details.unifiedExec.cancelled; },
  "signal": result => { result.details.unifiedExec.signal = "SIGINT"; },
  "denied": result => { result.details.denied = true; },
  "missing observation": result => { delete result.details.unifiedExec.processObservation; },
  "different observation": result => { result.details.unifiedExec.processObservation.scope = "leader"; },
  "open stdio": result => { result.details.unifiedExec.processObservation.stdioClosed = false; },
  "not closed": result => { result.details.unifiedExec.processObservation.settledBy = "cleanup_deadline"; },
};
for (const [mutation, mutate] of Object.entries(failedBashMutations)) {
  test(`A21 Core closed failed bash rejects ${mutation} without checkpoint writes`, async t => {
    const f = await fixture(t); addClosedFailedBash(f, { mutate });
    assertBlocked(f.store.commitRunProgressCheckpoint(f.input()), "checkpoint.effect_unknown");
    assert.deepEqual(counts(f), [0, 0, 0]);
  });
}

for (const variant of ["no receipt", "unsettled", "stop unconfirmed", "pending approval", "unknown Host operation", "old owner", "wrong digest", "SDK-only details"]) {
  test(`A21 Core closed failed bash refuses ${variant}`, async t => {
    const f = await fixture(t);
    addClosedFailedBash(f, { receipt: variant !== "no receipt", settle: variant !== "unsettled",
      observation: variant === "stop unconfirmed" ? { ...normalClose, stopReason: "cancelled" } : normalClose,
      ...(variant === "SDK-only details" ? { mutate: result => { delete result.details; } } : {}) });
    if (variant === "pending approval") f.store.createApprovalRequest({ runId: f.run.id, taskId: f.task.id, toolCallId: "pending",
      actionType: "bash", risk: "high", title: "Pending command", description: "Fixture pending approval",
      payload: { type: "bash", command: "exit 7", cwd: f.cwd, riskFlags: [] } }, now);
    if (variant === "unknown Host operation") {
      const ticket = f.store.admitHostOperation({ operationId: "unresolved", kind: "command", source: { runId: f.run.id, ...f.fence },
        toolCallId: "closed-failure", admittedAt: now });
      f.store.settleHostOperation(ticket, { kind: "unknown_outcome", code: "command_physical_scope_unverified", settledAt: now });
    }
    if (variant === "old owner" || variant === "wrong digest") {
      const event = f.store.listEvents(f.run.id).find(event => event.type === (variant === "old owner" ? "host_command_settled" : "host_command_prepared"));
      const data = structuredClone(event.data);
      if (variant === "old owner") { data.ownerCurrent = false; data.outcome = "stop_unconfirmed"; }
      else data.commandDigest = "a".repeat(64);
      f.openOther().database.prepare("UPDATE run_events SET data_json=? WHERE id=?").run(JSON.stringify(data), event.id);
    }
    if (variant === "SDK-only details") f.view.at(-1).details = { unifiedExec: { status: "failed", exitCode: 7 } };
    assertBlocked(f.store.commitRunProgressCheckpoint(f.input()), "checkpoint.effect_unknown");
    assert.deepEqual(counts(f), [0, 0, 0]);
  });
}

for (const mutation of ["command digest", "source fence", "canonical result", "normal close"]) {
  test(`A21 Core closed failed bash recovery revalidates ${mutation} after sealing`, async t => {
    const f = await fixture(t); addClosedFailedBash(f);
    assertCommitted(f.store.commitRunProgressCheckpoint(f.input()));
    const type = mutation === "canonical result" ? "tool_end" : mutation === "normal close" ? "host_command_settled" : "host_command_prepared";
    const event = f.store.listEvents(f.run.id).find(event => event.type === type), data = structuredClone(event.data);
    if (mutation === "command digest") data.commandDigest = "a".repeat(64);
    else if (mutation === "source fence") data.source.runtimeInstanceId = "foreign";
    else if (mutation === "canonical result") data.result.details.unifiedExec.cancelled = true;
    else { data.outcome = "stop_unconfirmed"; data.observation.stopReason = "observer_error"; }
    f.openOther().database.prepare("UPDATE run_events SET data_json=? WHERE id=?").run(JSON.stringify(data), event.id);
    assertBlocked(f.read(), "checkpoint.effect_unknown");
    assert.deepEqual(counts(f), [1, 1, 1]);
  });
}

test("A21 Core closed failed bash remains outside the existing compaction suspension domain", async t => {
  const f = await fixture(t); addClosedFailedBash(f);
  assert.throws(() => verifyCompactionSuspensionEffects(f.store.database, f.store, f.store.getRun(f.run.id),
    f.store.listEvents(f.run.id), f.view, f.fence), error => error.code === "checkpoint.effect_unknown");
});

function delegationFixture(f) {
  const d = f.delegationBudget;
  const lifecycle = new SqliteDelegationLifecycleStore({ database: d.db }, {
    getRun: id => f.store.getRun(id), getWorkUnit: id => f.store.getWorkUnit(id),
    getWorkUnitAttempt: id => f.store.getWorkUnitAttempt(id), getDelegationStep: id => f.store.getDelegationStep(id),
    getDelegationBudgetReservation: id => d.writer.getDelegationBudgetReservation(id),
    getArtifact: id => f.store.getArtifact(id), createArtifactWithinTransaction: d.ports.createArtifactWithinTransaction,
  });
  const round = (name, id, args, result) => {
    const content = [{ type: "text", text: JSON.stringify(result) }];
    f.view.push({ role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }], stopReason: "toolUse", timestamp: 2 });
    f.store.appendExecutionEvent(f.run.id, f.fence, "tool_start", { toolCallId: id, toolName: name, args });
    f.store.appendExecutionEvent(f.run.id, f.fence, "tool_end", { toolCallId: id, toolName: name, result: { content }, isError: false });
    f.view.push({ role: "toolResult", toolCallId: id, toolName: name, content, isError: false, timestamp: 3 });
  };
  const args = { objective: "Inspect only this QA fixture", requestedBudget: { tokenBudget: 40 }, required: true };
  const child = d.spawn({ spawnCallId: "spawn-1", ...args });
  const spawnResult = { status: "accepted", reservationId: child.reservation.id, childRunId: child.childRun.id,
    stepId: child.stepId, state: "spawning", stepRevision: 0 };
  return { d, child, lifecycle, round, args, spawnResult };
}

test("A21 Core real delegation spawn and queued instruction facts authorize an exact progress checkpoint", async t => {
  const f = await fixture(t, ["spawn_agent", "send_message"]), d = delegationFixture(f);
  d.round("spawn_agent", "spawn-1", d.args, d.spawnResult);
  const message = d.lifecycle.appendDelegationInstruction({ reservationId: d.child.reservation.id,
    parentFence: f.fence, messageCallId: "message-1", text: "Keep the original objective", now: new Date(Date.parse(now) + 2).toISOString() });
  d.round("send_message", "message-1", { reservationId: d.child.reservation.id, text: "Keep the original objective" },
    { status: "durable_queued", messageId: message.message.id });
  const committed = f.store.commitRunProgressCheckpoint(f.input());
  assertCommitted(committed);
  const recovered = f.read(f.openOther());
  assert.equal(recovered.kind, "verified", JSON.stringify(recovered));
  assert.deepEqual(recovered.modelView, f.view);
  assert.equal(f.store.listWorkUnitAttempts(d.child.childWorkUnit.id).length, 0);
  assert.equal(d.d.writer.getDelegationBudgetReservation(d.child.reservation.id).state, "reserved");
});

for (const mutation of ["missing spawn", "wrong canonical arguments", "wrong SDK result", "changed durable objective",
  "changed durable budget", "corrupt objective", "missing instruction", "changed durable instruction", "corrupt instruction"]) {
  test(`A21 Core delegation checkpoint rejects ${mutation} without advancing its head`, async t => {
    const f = await fixture(t, ["spawn_agent", "send_message"]), d = delegationFixture(f);
    const spawnArgs = mutation === "changed durable objective" ? { ...d.args, objective: "Different task" }
      : mutation === "changed durable budget" ? { ...d.args, requestedBudget: { tokenBudget: 39 } } : d.args;
    d.round("spawn_agent", mutation === "missing spawn" ? "unrecorded-spawn" : "spawn-1", spawnArgs, d.spawnResult);
    if (mutation === "wrong canonical arguments") f.view[1].content[0].arguments = { ...d.args, objective: "Different task" };
    if (mutation === "wrong SDK result") f.view[2].content[0].text = "Different result";
    if (mutation === "corrupt objective") {
      const step = f.store.getDelegationStep(d.child.stepId);
      f.store.database.prepare("UPDATE artifacts SET sealed_payload_json=? WHERE id=?")
        .run(JSON.stringify({ schemaVersion: 1, objective: "Corrupted task" }), step.objectiveArtifactId);
    }
    if (mutation === "missing instruction") {
      d.round("send_message", "message-missing", { reservationId: d.child.reservation.id, text: "Unrecorded instruction" },
        { status: "durable_queued", messageId: "not-a-durable-message" });
    }
    if (mutation === "corrupt instruction" || mutation === "changed durable instruction") {
      const message = d.lifecycle.appendDelegationInstruction({ reservationId: d.child.reservation.id,
        parentFence: f.fence, messageCallId: "message-1", text: "Keep the original objective", now: new Date(Date.parse(now) + 2).toISOString() });
      d.round("send_message", "message-1", { reservationId: d.child.reservation.id,
        text: mutation === "changed durable instruction" ? "Different instruction" : "Keep the original objective" },
        { status: "durable_queued", messageId: message.message.id });
      if (mutation === "corrupt instruction") {
        f.store.database.prepare("UPDATE artifacts SET sealed_payload_json=? WHERE id=?").run(JSON.stringify({ schemaVersion: 1,
          kind: "delegation.instruction.v1", parentFence: f.fence, text: "Corrupted instruction" }), message.message.bodyArtifactId);
      }
    }
    const before = counts(f);
    assertBlocked(f.store.commitRunProgressCheckpoint(f.input()), "checkpoint.effect_unknown");
    assert.deepEqual(counts(f), before);
  });
}

test("A21 Core wait_agent checkpoint requires this parent's actual reservation, not merely the tool name", async t => {
  const f = await fixture(t, ["wait_agent"]), d = delegationFixture(f);
  d.round("wait_agent", "wait-1", { reservationId: d.child.reservation.id, timeoutMs: 0 }, { status: "timed_out", timedOut: true });
  assertCommitted(f.store.commitRunProgressCheckpoint(f.input()));
  const g = await fixture(t, ["wait_agent"]), e = delegationFixture(g);
  e.round("wait_agent", "wait-1", { reservationId: "not-an-owned-reservation", timeoutMs: 0 }, { status: "timed_out", timedOut: true });
  assertBlocked(g.store.commitRunProgressCheckpoint(g.input()), "checkpoint.effect_unknown");
});

test("A21 Core atomically seals artifact/checkpoint/head; second connection and reopen verify exact view", async t => {
  const f = await fixture(t); f.addRound(); const input = f.input();
  const committed = f.store.commitRunProgressCheckpoint(input); assertCommitted(committed);
  assert.equal(committed.headRevision, 1); assert.deepEqual(counts(f), [1, 1, 1]);
  const other = f.openOther(); const read = f.read(other); assert.equal(read.kind, "verified", JSON.stringify(read));
  assert.deepEqual(read.modelView, f.view); assert.deepEqual(read.witness.sourceFence, f.fence);
  const replay = other.commitRunProgressCheckpoint({ ...input, now: "2026-10-13T03:01:00.000Z" });
  assertCommitted(replay); assert.equal(replay.replayed, true); assert.deepEqual(counts(f), [1, 1, 1]);
  f.store.close(); f.store = core.createSqliteRunStore(f.cwd);
  assert.equal(f.read().witness.checkpointId, committed.checkpoint.id);
  assert.equal(f.store.listEvents(f.run.id).some(e => e.type.startsWith("context_compaction_")), false);
});

test("A21 Core strict head CAS across connections preserves immutable predecessor and rejects stale rewind", async t => {
  const f = await fixture(t); f.addRound(); const firstInput = f.input();
  const first = f.store.commitRunProgressCheckpoint(firstInput); assertCommitted(first); f.openOther();
  f.addRound("call-2"); const next = f.input(headOf(first));
  const second = f.other.commitRunProgressCheckpoint(next); assertCommitted(second);
  assert.equal(second.headRevision, 2); assert.equal(second.checkpoint.predecessorId, first.checkpoint.id);
  const priorCounts = counts(f);
  assertBlocked(f.store.commitRunProgressCheckpoint({ ...next, expectedHead: headOf(first), modelView: [...next.modelView, next.modelView.at(-1)] }));
  assertBlocked(f.store.commitRunProgressCheckpoint(firstInput));
  assert.deepEqual(counts(f), priorCounts); assert.equal(f.read().witness.checkpointId, second.checkpoint.id);
  assert.throws(() => f.store.database.prepare("UPDATE run_progress_checkpoints SET source_event_seq=999 WHERE id=?").run(first.checkpoint.id), /immutable/);
});

for (const target of ["run_progress_checkpoints", "run_progress_checkpoint_heads"]) {
  test(`A21 Core rollback leaves no artifact/row/head after ${target} insertion failure`, async t => {
    const f = await fixture(t); f.addRound(); f.openOther();
    f.store.database.exec(`CREATE TEMP TRIGGER owned_checkpoint_failure BEFORE INSERT ON ${target} BEGIN SELECT RAISE(ABORT,'owned injection'); END`);
    assertBlocked(f.store.commitRunProgressCheckpoint(f.input()), "checkpoint.commit_failed");
    assert.deepEqual(counts(f), [0, 0, 0]); assertBlocked(f.read(f.other), "checkpoint.missing");
    f.store.database.exec("DROP TRIGGER owned_checkpoint_failure");
    assertCommitted(f.store.commitRunProgressCheckpoint(f.input()));
  });
}

test("A21 Core missing authority and isolated sealed artifact never authorize settled tool progress", async t => {
  const f = await fixture(t); f.addRound(); assertBlocked(f.read(), "checkpoint.missing");
  const committed = f.store.commitRunProgressCheckpoint(f.input()); assertCommitted(committed);
  f.store.database.exec("DELETE FROM run_progress_checkpoint_heads; DELETE FROM run_progress_checkpoints;");
  assert.deepEqual(counts(f), [1, 0, 0]); f.openOther(); assertBlocked(f.read(f.other), "checkpoint.missing");
});

test("A21 Core late A cannot commit after actual B takes its active pointer", async t => {
  const f = await fixture(t); f.addRound(); const input = f.input();
  f.store.createWorkUnitAttempt({ workUnitId: f.unit.id, attemptNumber: 2, runtimeInstanceId: "takeover-B", runnerId: "pi", status: "started", now });
  assertBlocked(f.store.commitRunProgressCheckpoint(input), "checkpoint.lineage_mismatch"); assert.deepEqual(counts(f), [0, 0, 0]);
});

test("A21 Core exact event high-water rejects a stale boundary without partial writes", async t => {
  const f = await fixture(t); f.addRound(); const input = f.input(); f.addRound("later-tool");
  assertBlocked(f.store.commitRunProgressCheckpoint(input), "checkpoint.lineage_mismatch"); assert.deepEqual(counts(f), [0, 0, 0]);
});

test("A21 Core permission source changes on a second connection are not caller-authorizable fingerprints", async t => {
  const f = await fixture(t); f.addRound(); const input = f.input(); assertCommitted(f.store.commitRunProgressCheckpoint(input));
  f.openOther().updateApprovalPolicy({ toolDecisions: { read: "deny" } }, now);
  assertBlocked(f.store.readRunProgressCheckpointForRecovery({ runId: f.run.id, sourceFence: f.fence, expectedLineage: input.expectedLineage }), "checkpoint.permission_drift");
  assertBlocked(f.store.commitRunProgressCheckpoint(input), "checkpoint.permission_drift");
});

for (const mutation of ["context", "frozen execution", "provider capabilities"]) {
  test(`A21 Core refuses ${mutation} drift from another SQLite connection`, async t => {
    const f = await fixture(t); f.addRound(); const input = f.input(); assertCommitted(f.store.commitRunProgressCheckpoint(input)); const other = f.openOther();
    if (mutation === "context") other.database.prepare("UPDATE run_sessions SET context_view_id='foreign' WHERE id=?").run(f.run.id);
    else if (mutation === "frozen execution") other.database.prepare("UPDATE run_sessions SET request_snapshot_json=json_set(request_snapshot_json,'$.runnerExecutionInput.input.systemPrompt','drift') WHERE id=?").run(f.run.id);
    else other.updateProviderPreset(f.preset.id, { capabilities: ["chat"] }, now);
    assertBlocked(f.store.readRunProgressCheckpointForRecovery({ runId: f.run.id, sourceFence: f.fence, expectedLineage: input.expectedLineage }));
  });
}

for (const mutation of ["duplicate result", "unpaired call", "wrong arguments", "wrong result", "failed command"]) {
  test(`A21 Core rejects actual event/model pair mismatch: ${mutation}`, async t => {
    const f = await fixture(t); f.addRound(); const input = f.input();
    if (mutation === "duplicate result") input.modelView.push(input.modelView.at(-1));
    else if (mutation === "unpaired call") input.modelView[1].content.push({ type: "toolCall", id: "unsettled", name: "bash", arguments: {} });
    else if (mutation === "wrong arguments") input.modelView[1].content[0].arguments.command = "different";
    else if (mutation === "wrong result") input.modelView.at(-1).content[0].text = "different";
    else { input.modelView.at(-1).isError = true; }
    assertBlocked(f.store.commitRunProgressCheckpoint(input), "checkpoint.effect_unknown"); assert.deepEqual(counts(f), [0, 0, 0]);
  });
}

for (const bad of ["unknown journal", "stop unconfirmed"]) {
  test(`A21 Core never seals ${bad} as a settled command`, async t => {
    const f = await fixture(t);
    const args = { command: "echo unsafe" }; f.view.push({ role: "assistant", content: [{ type: "toolCall", id: "unsafe", name: "bash", arguments: args }] });
    f.store.appendExecutionEvent(f.run.id, f.fence, "tool_start", { toolCallId: "unsafe", toolName: "bash", args });
    const ticket = f.store.prepareHostCommandExecution({ runId: f.run.id, sourceFence: f.fence, toolCallId: "unsafe", cwd: f.cwd,
      command: { kind: "shell", command: args.command, shell: "bash" } });
    if (bad === "stop unconfirmed") f.store.settleHostCommandExecution(ticket, { kind: "observed", observation: { ...normalClose, stopReason: "cancelled" } });
    const content = [{ type: "text", text: "untrusted success" }];
    f.store.appendExecutionEvent(f.run.id, f.fence, "tool_end", { toolCallId: "unsafe", toolName: "bash", result: { content }, isError: false });
    f.view.push({ role: "toolResult", toolCallId: "unsafe", toolName: "bash", content, isError: false });
    assertBlocked(f.store.commitRunProgressCheckpoint(f.input()), "checkpoint.effect_unknown"); assert.deepEqual(counts(f), [0, 0, 0]);
  });
}

test("A21 Core new activation and idempotent replay both require the current verified witness", async t => {
  const f = await fixture(t); f.addRound(); assertCommitted(f.store.commitRunProgressCheckpoint(f.input()));
  assert.ok(f.store.acquireResourceLease({ workspaceId: core.DEFAULT_WORKSPACE_ID, resourceType: "bound_path", resourceKey: f.cwd,
    ownerType: "run", ownerId: f.run.id, workUnitId: f.unit.id, attemptId: f.attempt.id,
    runtimeInstanceId: f.attempt.runtimeInstanceId, fencingToken: f.attempt.fencingToken,
    acquiredAt: now, expiresAt: "2026-10-13T04:00:00.000Z" }));
  assert.ok(f.store.acquireRuntimeSemaphoreSlot({ workspaceId: core.DEFAULT_WORKSPACE_ID, resourceType: "runner", resourceKey: "pi",
    limit: 1, ownerType: "work_unit_attempt", ownerId: f.attempt.id, workUnitId: f.unit.id, attemptId: f.attempt.id,
    runtimeInstanceId: f.attempt.runtimeInstanceId, fencingToken: f.attempt.fencingToken,
    acquiredAt: now, expiresAt: "2026-10-13T04:00:00.000Z" }));
  void f.store.trackHostAttemptCompletion({ runId: f.run.id, ...f.fence }, new Promise(() => {}));
  const read = f.read(); assert.equal(read.kind, "verified"); f.loseSource();
  const noGuard = f.activation(); assert.equal(f.store.commitExistingRunContinuation(noGuard).code, "checkpoint.missing");
  assert.equal(f.store.listWorkUnitAttempts(f.unit.id).length, 1);
  const guarded = { ...noGuard, recoveryProgressCheckpointGuard: read.witness };
  const activation = f.store.commitExistingRunContinuation(guarded); assert.equal(activation.ok, true, JSON.stringify(activation));
  assert.equal(f.store.listResourceLeases({ attemptId: f.attempt.id, status: "active" }).length, 0);
  assert.equal(f.store.listResourceLeases({ attemptId: f.attempt.id, status: "released" }).length, 1);
  assert.equal(f.store.listRuntimeSemaphoreSlots({ ownerId: f.attempt.id, status: "active" }).length, 0);
  assert.equal(f.store.listRuntimeSemaphoreSlots({ ownerId: f.attempt.id, status: "released" }).length, 1);
  assert.equal(f.store.commitExistingRunContinuation(noGuard).code, "checkpoint.missing");
  const replay = f.store.commitExistingRunContinuation(guarded); assert.equal(replay.ok, true, JSON.stringify(replay)); assert.equal(replay.replayed, true);
  assert.equal(f.store.listWorkUnitAttempts(f.unit.id).length, 2);
});

test("A21 Core reader-to-activation watermark drift on another connection creates no B", async t => {
  const f = await fixture(t); f.addRound(); assertCommitted(f.store.commitRunProgressCheckpoint(f.input()));
  const witness = f.read().witness; f.openOther(); f.addRound("new-progress"); f.loseSource();
  const result = f.other.commitExistingRunContinuation(f.activation(witness));
  assert.equal(result.ok, false); assert.equal(f.store.listWorkUnitAttempts(f.unit.id).length, 1);
  assert.equal(f.store.getWorkUnit(f.unit.id).status, "stale");
});

test("A21 Core scheduled B permits only its exact Host-attributed recovery bookkeeping", async t => {
  const f = await fixture(t); f.addRound(); assertCommitted(f.store.commitRunProgressCheckpoint(f.input())); const read = f.read(); f.loseSource();
  const activation = f.store.commitExistingRunContinuation(f.activation(read.witness)); assert.equal(activation.ok, true, JSON.stringify(activation));
  const binding = { continuationId: activation.continuation.id, targetFence: core.toRuntimeAttemptFence(activation.attempt) };
  assert.equal(f.read(f.store, { continuationBinding: binding }).kind, "verified");
  f.store.appendEvent(f.run.id, "run_start", { taskId: f.run.taskId, cwd: f.cwd, provider: f.run.providerName, model: f.run.providerModel,
    attemptId: activation.attempt.id });
  f.store.appendEvent(f.run.id, "turn_start", { attemptId: activation.attempt.id });
  assert.equal(f.read(f.store, { continuationBinding: binding }).kind, "verified");
  f.store.appendEvent(f.run.id, "assistant_text_delta", { text: "new model content" });
  assertBlocked(f.read(f.store, { continuationBinding: binding }), "checkpoint.effect_unknown");
});

for (const discriminator of ["run_start", "turn_start"]) {
  test(`A21 Core canonical recovery envelope discriminator ${discriminator} is matched to its actual event`, async t => {
    const f = await fixture(t); f.addRound(); const input = f.input();
    assertCommitted(f.store.commitRunProgressCheckpoint(input)); const witness = f.read().witness;
    f.loseSource(); const activation = f.store.commitExistingRunContinuation(f.activation(witness));
    assert.equal(activation.ok, true, JSON.stringify(activation)); const target = f.startB(activation, discriminator);
    f.store.appendExecutionEvent(f.run.id, target, "turn_start", { type: "turn_start", attemptId: target.attemptId });
    const read = f.store.readRunProgressCheckpointForRecovery({ runId: f.run.id, sourceFence: f.fence, expectedLineage: input.expectedLineage,
      continuationBinding: { continuationId: activation.continuation.id, targetFence: target } });
    if (discriminator === "run_start") assert.equal(read.kind, "verified", JSON.stringify(read));
    else assertBlocked(read, "checkpoint.effect_unknown");
  });
}

test("A21 Core non-JSON/getter/oversized views fail before transaction or serialization side effects", async t => {
  const f = await fixture(t); f.addRound(); let invoked = false;
  const getter = { get role() { invoked = true; return "user"; } };
  for (const modelView of [[getter], [{ role: "user", content: "x".repeat(513 * 1024) }], [{ role: "user", toJSON() { invoked = true; return {}; } }]]) {
    assertBlocked(f.store.commitRunProgressCheckpoint({ ...f.input(), modelView }), "checkpoint.snapshot_unavailable");
  }
  assert.equal(invoked, false); assert.deepEqual(counts(f), [0, 0, 0]);
});

test("A21 Core nested writer BEGIN does not roll back caller's existing transaction", async t => {
  const f = await fixture(t); f.addRound(); const input = f.input(); f.store.database.exec("BEGIN IMMEDIATE");
  assert.throws(() => f.store.commitRunProgressCheckpoint(input), /transaction/i);
  assert.equal(f.store.database.isTransaction, true); f.store.database.exec("ROLLBACK"); assert.deepEqual(counts(f), [0, 0, 0]);
});

test("A21 Core pristine recovery still requires the actual source fence and frozen lineage", async t => {
  const f = await fixture(t); assert.equal(f.read().kind, "not_needed");
  for (const field of ["workUnitId", "attemptId", "runtimeInstanceId", "fencingToken"]) {
    assertBlocked(f.read(f.store, { sourceFence: { ...f.fence, [field]: "foreign" } }), "checkpoint.lineage_mismatch");
  }
  const expectedLineage = { ...f.input().expectedLineage, providerModel: "foreign" };
  assertBlocked(f.read(f.store, { expectedLineage }), "checkpoint.lineage_mismatch");
});

test("A21 Core full durable Task metadata is not part of the frozen four-field model task", async t => {
  const f = await fixture(t);
  f.store.database.prepare("UPDATE run_sessions SET task_snapshot_json=? WHERE id=?").run(JSON.stringify(f.task), f.run.id);
  f.addRound(); const input = f.input(); assertCommitted(f.store.commitRunProgressCheckpoint(input));
  assert.equal(f.read().kind, "verified");
});

for (const field of ["id", "title", "prompt", "channelId"]) {
  test(`A21 Core full Task snapshot still refuses model-semantic ${field} drift`, async t => {
    const f = await fixture(t); f.addRound(); const input = f.input();
    const other = f.openOther(); other.database.prepare("UPDATE run_sessions SET task_snapshot_json=? WHERE id=?")
      .run(JSON.stringify({ ...f.task, [field]: "foreign" }), f.run.id);
    assertBlocked(f.store.commitRunProgressCheckpoint(input), "checkpoint.lineage_mismatch");
    assertBlocked(f.store.readRunProgressCheckpointForRecovery({ runId: f.run.id, sourceFence: f.fence,
      expectedLineage: input.expectedLineage }), "checkpoint.lineage_mismatch");
  });
}

test("A21 Core accepted task anchor is exact, supports text blocks, and refuses new user authority", async t => {
  const f = await fixture(t); f.addRound(); const input = f.input();
  const different = structuredClone(input.modelView); different[0].content = "Different accepted task";
  assertBlocked(f.store.commitRunProgressCheckpoint({ ...input, modelView: different }), "checkpoint.effect_unknown");
  const extra = structuredClone(input.modelView); extra.splice(1, 0, { role: "user", content: "new instructions", timestamp: 1 });
  assertBlocked(f.store.commitRunProgressCheckpoint({ ...input, modelView: extra }), "checkpoint.effect_unknown");
  input.modelView[0].content = [{ type: "text", text: input.modelView[0].content }];
  assertCommitted(f.store.commitRunProgressCheckpoint(input));
});

for (const name of ["write", "edit"]) {
  test(`A21 Core ${name} in explicit broker-off mode is unjournaled, never sealed or recoverable`, async t => {
    const f = await fixture(t); f.setBroker("off"); f.addFileRound(name);
    assertBlocked(f.store.commitRunProgressCheckpoint(f.input()), "checkpoint.effect_unjournaled");
    assert.deepEqual(counts(f), [0, 0, 0]); assertBlocked(f.read(), "checkpoint.missing");
    f.loseSource(); const activation = f.store.commitExistingRunContinuation(f.activation());
    assert.equal(activation.ok, false); assert.equal(activation.code, "checkpoint.missing");
    assert.equal(f.store.listWorkUnitAttempts(f.unit.id).length, 1);
  });
  for (const tracked of [false, true]) {
    test(`A21 Core dedicated ${name} receipt ${tracked ? "with" : "without"} optional input-pause tracker authorizes a checkpoint`, async t => {
      const f = await fixture(t); f.setBroker("enforce"); f.addFileRound(name, "dedicated-file", true, tracked);
      assertCommitted(f.store.commitRunProgressCheckpoint(f.input())); f.openOther();
      assert.equal(f.read(f.other).kind, "verified");
    });
  }
}

for (const mode of [undefined, "shadow", "enforce"]) {
  test(`A21 Core missing dedicated receipt with broker=${mode ?? "absent"} cannot use unsupported live fallback`, async t => {
    const f = await fixture(t); if (mode) f.setBroker(mode); f.addFileRound();
    assertBlocked(f.store.commitRunProgressCheckpoint(f.input()), "checkpoint.effect_unknown");
  });
}

test("A21 Core unsupported file cannot mask a later unknown MCP or unstarted Host operation", async t => {
  const f = await fixture(t); f.setBroker("off"); f.addFileRound();
  const ticket = f.store.admitHostOperation({ operationId: "later-mcp", source: { runId: f.run.id, ...f.fence },
    kind: "mcp", toolCallId: "later", admittedAt: new Date().toISOString() });
  assertBlocked(f.store.commitRunProgressCheckpoint(f.input()), "checkpoint.effect_unknown");
  f.store.launchHostOperation(ticket, () => 1);
  f.store.settleHostOperation(ticket, { kind: "unknown_outcome", code: "mcp_remote_operation_unverified", settledAt: new Date().toISOString() });
  assertBlocked(f.store.commitRunProgressCheckpoint(f.input()), "checkpoint.effect_unknown");
  assert.deepEqual(counts(f), [0, 0, 0]);
});

for (const kind of ["file", "command"]) {
  for (const broker of ["enforce", "off"]) {
    test(`A21 Core extra terminal ${kind} receipt without a canonical SDK pair in ${broker} never authorizes a checkpoint`, async t => {
      const f = await fixture(t); f.setBroker(broker);
      if (broker === "off") f.addFileRound();
      else f.addRound();
      if (kind === "file") f.addFileRound("write", "unpaired-file", true, false, f.fence, false);
      else {
        const ticket = f.store.prepareHostCommandExecution({ runId: f.run.id, sourceFence: f.fence,
          toolCallId: "unpaired-command", command: { kind: "shell", command: "echo unpaired", shell: "bash" }, cwd: f.cwd });
        f.store.settleHostCommandExecution(ticket, { kind: "observed", observation: normalClose });
      }
      assertBlocked(f.store.commitRunProgressCheckpoint(f.input()), "checkpoint.effect_unknown");
      assert.deepEqual(counts(f).slice(1), [0, 0]);
    });
  }
}

test("A21 Core reader detects an unpaired terminal file receipt even when the Run event high-water is unchanged", async t => {
  const f = await fixture(t); f.setBroker("enforce"); f.addRound();
  assertCommitted(f.store.commitRunProgressCheckpoint(f.input()));
  const seq = f.store.listEvents(f.run.id).at(-1).seq;
  f.addFileRound("write", "unpaired-later-file", true, false, f.fence, false);
  assert.equal(f.store.listEvents(f.run.id).at(-1).seq, seq);
  assertBlocked(f.read(), "checkpoint.effect_unknown");
});

for (const mutation of ["request digest", "policy payload", "result digest", "artifact type"]) {
  test(`A21 Core dedicated file receipt refuses second-connection ${mutation} corruption`, async t => {
    const f = await fixture(t); f.setBroker("enforce"); const receipt = f.addFileRound("write", "file", true);
    const input = f.input(), other = f.openOther();
    if (mutation === "request digest") other.database.prepare("UPDATE harness_tool_executions SET request_digest=? WHERE id=?").run("d".repeat(64), receipt.row.id);
    else if (mutation === "policy payload") other.database.prepare("UPDATE artifacts SET sealed_payload_json=json_set(sealed_payload_json,'$.effectivePolicySnapshot.workspaceAccessMode','read_only') WHERE id=?").run(receipt.policy.id);
    else if (mutation === "result digest") other.database.prepare("UPDATE artifacts SET content_sha256=? WHERE id=?").run("d".repeat(64), receipt.artifact.id);
    else other.database.prepare("UPDATE artifacts SET type='markdown' WHERE id=?").run(receipt.artifact.id);
    assertBlocked(f.store.commitRunProgressCheckpoint(input), "checkpoint.effect_unknown");
    assert.deepEqual(counts(f).slice(1), [0, 0]);
  });
}

test("A21 Core actual recovery B advances A head exactly once with the original prefix and witness", async t => {
  const f = await fixture(t); f.setBroker("enforce"); f.addFileRound("write", "source-file", true, true);
  const first = f.store.commitRunProgressCheckpoint(f.input()); assertCommitted(first);
  const read = f.read(); f.loseSource(); const activation = f.store.commitExistingRunContinuation(f.activation(read.witness));
  assert.equal(activation.ok, true, JSON.stringify(activation)); const target = f.startB(activation);
  f.addFileRound("edit", "target-file", true, true, target);
  const input = f.input(headOf(first), { sourceFence: target, recoveryPredecessor: read.witness });
  assertBlocked(f.store.commitRunProgressCheckpoint({ ...input, recoveryPredecessor: undefined }), "checkpoint.lineage_mismatch");
  const wrong = structuredClone(input); wrong.modelView[1].content[0].arguments.content = "rewritten prefix";
  assertBlocked(f.store.commitRunProgressCheckpoint(wrong), "checkpoint.effect_unknown");
  assertBlocked(f.store.commitRunProgressCheckpoint({ ...input, recoveryPredecessor: { ...read.witness, headRevision: 999 } }), "checkpoint.lineage_mismatch");
  const second = f.store.commitRunProgressCheckpoint(input); assertCommitted(second);
  assert.equal(second.checkpoint.predecessorId, first.checkpoint.id); assert.equal(second.headRevision, 2);
  assert.equal(second.checkpoint.sourceFence.attemptId, target.attemptId);
  assertCommitted(f.store.commitRunProgressCheckpoint(input));
  const recovered = f.store.readRunProgressCheckpointForRecovery({ runId: f.run.id, sourceFence: target, expectedLineage: input.expectedLineage });
  assert.equal(recovered.kind, "verified", JSON.stringify(recovered)); assert.deepEqual(recovered.modelView, f.view);
});

for (const replay of [false, true]) {
  test(`A21 Core naked compaction start cannot bypass ${replay ? "idempotent replay" : "new activation"} guard`, async t => {
    const f = await fixture(t); f.addRound();
    let activation;
    if (replay) {
      assertCommitted(f.store.commitRunProgressCheckpoint(f.input())); const witness = f.read().witness;
      f.loseSource(); const input = f.activation(witness); activation = f.store.commitExistingRunContinuation(input);
      assert.equal(activation.ok, true, JSON.stringify(activation));
      f.store.appendEvent(f.run.id, "context_compaction_start", { attemptId: f.attempt.id, checkpointArtifactId: "naked",
        reason: "threshold", policyVersion: "pi_sdk_lifecycle_v1" });
      const result = f.store.commitExistingRunContinuation({ ...input, recoveryProgressCheckpointGuard: undefined });
      assert.equal(result.ok, false); assert.equal(result.code, "checkpoint.missing");
      assert.equal(f.store.listWorkUnitAttempts(f.unit.id).length, 2);
    } else {
      f.store.appendEvent(f.run.id, "context_compaction_start", { attemptId: f.attempt.id, checkpointArtifactId: "naked",
        reason: "threshold", policyVersion: "pi_sdk_lifecycle_v1" });
      f.loseSource(); const result = f.store.commitExistingRunContinuation(f.activation());
      assert.equal(result.ok, false); assert.equal(result.code, "checkpoint.missing");
      assert.equal(f.store.listWorkUnitAttempts(f.unit.id).length, 1);
    }
  });
}

const sealCompaction = f => {
  const snapshotPayload = { schemaVersion: 1, boundary: "pi-compaction-context", runId: f.run.id, attemptId: f.attempt.id,
    contextViewId: f.run.contextViewId, model: f.run.providerModel, messages: f.view };
  const snapshot = f.store.createArtifact({ runId: f.run.id, type: "json", path: "owned-compaction.json",
    contentType: "application/vnd.ling.pi-compaction-context+json", sealedPayload: snapshotPayload, createdAt: now });
  const start = f.store.appendExecutionEvent(f.run.id, f.fence, "context_compaction_start", {
    attemptId: f.attempt.id, checkpointArtifactId: snapshot.id, reason: "threshold", policyVersion: "pi_sdk_lifecycle_v1" });
  const summaryPayload = { schemaVersion: 1, boundary: "run-compaction-summary", runId: f.run.id, attemptId: f.attempt.id,
    sourceEventSeq: start.seq, summary: "Owned compaction", modelView: [{ role: "compactionSummary", summary: "Owned compaction", timestamp: 1 }, ...f.view] };
  const summary = f.store.createArtifact({ runId: f.run.id, type: "json", path: "owned-summary.json",
    contentType: "application/vnd.ling.run-compaction-summary+json", sealedPayload: summaryPayload, createdAt: now });
  const checkpoint = f.store.createRunCompactionCheckpoint({ runId: f.run.id, attemptId: f.attempt.id, sourceEventSeq: start.seq,
    contextSnapshotArtifactId: snapshot.id, summaryArtifactId: summary.id, summaryContentSha256: summary.contentSha256,
    contextViewId: f.run.contextViewId, providerName: f.run.providerName, providerModel: f.run.providerModel, policyVersion: "pi_sdk_lifecycle_v1",
    policySnapshotFingerprint: digest(f.policy), workspaceProvenanceWatermark: f.store.getLatestWorkspaceProvenanceWatermark(),
    objective: f.task.prompt, createdAt: now });
  assert.ok(f.store.transitionRunCompactionCheckpoint({ id: checkpoint.id, expectedRevision: 0, state: "committed", now }));
  f.store.appendExecutionEvent(f.run.id, f.fence, "context_compaction_end", {
    attemptId: f.attempt.id, reason: "threshold", policyVersion: "pi_sdk_lifecycle_v1", outcome: "sdk_installed", willRetry: false });
  return { snapshot, summary };
};

const compactionActivation = (f, receipt) => {
  const activation = f.activation();
  const lineage = core.captureRunProgressCheckpointLineage(f.store, f.store.getRun(f.run.id), f.policy).lineage;
  const body = { schemaVersion: 1, boundary: "runner-continuation-replay", runId: f.run.id, workUnitId: f.unit.id,
    sourceRunId: f.run.id, sourceWorkUnitId: f.unit.id, origin: "daemon_recovery", contextViewId: f.run.contextViewId,
    sourceFence: f.fence, runnerId: "pi", runnerCapabilityRevision: "pi:fixture", policySnapshotFingerprint: lineage.policySnapshotFingerprint,
    preparedExecutionFingerprint: lineage.preparedExecutionFingerprint, acceptedInstructionsFingerprint: lineage.acceptedInstructionsFingerprint,
    execution: f.execution, artifactRefs: [receipt.snapshot.id, receipt.summary.id] };
  const replay = f.store.createArtifact({ runId: f.run.id, type: "json", path: "harness/continuations/owned-compaction-replay.json",
    contentType: "application/vnd.ling.runner-continuation-replay+json", sealedPayload: { ...body, fingerprint: digest(body) }, createdAt: now });
  activation.preparation.contextSnapshotArtifactId = replay.id;
  return activation;
};

test("A21 Core genuine committed compaction receipt retains its existing activation domain", async t => {
  const f = await fixture(t), receipt = sealCompaction(f);
  f.loseSource(); const activation = compactionActivation(f, receipt);
  assert.equal(f.store.commitExistingRunContinuation(activation).ok, true);
});

for (const discriminator of [undefined, "run_start", "turn_start"]) {
  test(`A21 Core genuine compaction running-B replay checks ${discriminator ?? "Host marker"} bookkeeping against the actual target`, async t => {
    const f = await fixture(t), receipt = sealCompaction(f);
    f.loseSource(); const input = compactionActivation(f, receipt), activation = f.store.commitExistingRunContinuation(input);
    assert.equal(activation.ok, true, JSON.stringify(activation)); const target = f.startB(activation, discriminator);
    f.store.appendExecutionEvent(f.run.id, target, "turn_start", { type: "turn_start", attemptId: target.attemptId });
    const replay = f.store.commitExistingRunContinuation(input);
    assert.equal(replay.ok, discriminator !== "turn_start", JSON.stringify(replay));
    if (replay.ok) { assert.equal(replay.replayed, true); assert.equal(replay.attempt.id, activation.attempt.id); }
    assert.equal(f.store.listWorkUnitAttempts(f.unit.id).length, 2);
  });
}

test("A21 Core compaction domain cannot route an unsealed later tool through ordinary activation", async t => {
  const f = await fixture(t), receipt = sealCompaction(f);
  f.store.appendExecutionEvent(f.run.id, f.fence, "tool_start", { toolCallId: "after-compaction", toolName: "write",
    args: { path: "later.txt", content: "not yet settled" } });
  f.loseSource(); const activation = compactionActivation(f, receipt);
  const result = f.store.commitExistingRunContinuation(activation);
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(f.store.listWorkUnitAttempts(f.unit.id).length, 1);
});

for (const mutation of ["unrelated snapshot", "source fence", "summary ref", "pending Host operation"]) {
  test(`A21 Core compaction domain refuses ${mutation} before creating a replacement Attempt`, async t => {
    const f = await fixture(t), receipt = sealCompaction(f), activation = compactionActivation(f, receipt);
    if (mutation === "unrelated snapshot") activation.preparation.contextSnapshotArtifactId = f.activation().preparation.contextSnapshotArtifactId;
    else if (mutation === "pending Host operation") f.store.admitHostOperation({ operationId: "unresolved-compaction-mcp", kind: "mcp",
      source: { runId: f.run.id, ...f.fence }, toolCallId: "unresolved-compaction-mcp", admittedAt: new Date().toISOString() });
    else {
      const artifact = f.store.getArtifact(activation.preparation.contextSnapshotArtifactId);
      const { fingerprint: _fingerprint, ...body } = artifact.sealedPayload;
      if (mutation === "source fence") body.sourceFence = { ...body.sourceFence, runtimeInstanceId: "foreign" };
      else body.artifactRefs = [receipt.snapshot.id];
      const payload = { ...body, fingerprint: digest(body) };
      f.openOther().database.prepare("UPDATE artifacts SET sealed_payload_json=?,content_sha256=? WHERE id=?")
        .run(JSON.stringify(payload), digest(payload), artifact.id);
    }
    f.loseSource(); const result = f.store.commitExistingRunContinuation(activation);
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(f.store.listWorkUnitAttempts(f.unit.id).length, 1);
  });
}

test("A21 Core workspace provenance drift on a second connection blocks both reader and activation", async t => {
  const f = await fixture(t); f.addRound(); const input = f.input(); assertCommitted(f.store.commitRunProgressCheckpoint(input));
  const witness = f.read().witness, seq = f.store.listEvents(f.run.id).at(-1).seq, other = f.openOther();
  const inverse = other.createArtifact({ runId: f.run.id, type: "json", path: "owned-inverse.json", sealedPayload: {}, createdAt: now });
  other.createWorkspaceMutationRecord({ cwd: f.cwd, threadId: f.thread.id, runId: f.run.id, patchPlanId: "owned-plan", operationIndex: 0,
    path: "result.txt", operation: "add", beforeSha256: "before", afterSha256: "after", inversePatchArtifactId: inverse.id,
    sourceRefs: [{ type: "run", id: f.run.id }], createdAt: now });
  assert.equal(f.store.listEvents(f.run.id).at(-1).seq, seq);
  assertBlocked(f.read(f.store, { expectedLineage: input.expectedLineage }), "checkpoint.source_watermark_changed");
  f.loseSource(); const result = f.store.commitExistingRunContinuation(f.activation(witness));
  assert.equal(result.ok, false); assert.equal(result.code, "checkpoint.source_watermark_changed");
  assert.equal(f.store.listWorkUnitAttempts(f.unit.id).length, 1);
});

for (const kind of ["approval", "required question"]) {
  test(`A21 Core pending ${kind} is a durable blocker, including after loss`, async t => {
    const f = await fixture(t); f.addRound(); assertCommitted(f.store.commitRunProgressCheckpoint(f.input()));
    if (kind === "approval") f.store.createExecutionApprovalRequest({ runId: f.run.id, taskId: f.task.id,
      channelId: f.channel.id, toolCallId: "pending", actionType: "execute",
      risk: "medium", title: "Pending", description: "Pending", payload: { type: "bash", cwd: f.cwd, command: "echo pending", riskFlags: [] } }, f.fence, now);
    else f.store.createUserInputRequest({ sourceRunId: f.run.id, sourceItemId: f.turn.item.id, sourceFence: f.fence,
      toolCallId: "ask", idempotencyKey: "ask", toolInput: { schemaVersion: 1, waitMode: "required",
        questions: [{ questionId: "choice", prompt: "Choose", required: true, allowFreeText: true, options: [] }] } }, now);
    assertBlocked(f.read(), "checkpoint.effect_unknown"); f.loseSource(); assertBlocked(f.read(), "checkpoint.effect_unknown");
  });
}

for (const mutation of ["digest", "type", "payload"]) {
  test(`A21 Core sealed checkpoint artifact ${mutation} corruption never grants recovery`, async t => {
    const f = await fixture(t); f.addRound(); const committed = f.store.commitRunProgressCheckpoint(f.input()); assertCommitted(committed);
    const other = f.openOther();
    if (mutation === "digest") other.database.prepare("UPDATE artifacts SET content_sha256=? WHERE id=?").run("d".repeat(64), committed.checkpoint.modelViewArtifactId);
    else if (mutation === "type") other.database.prepare("UPDATE artifacts SET type='markdown' WHERE id=?").run(committed.checkpoint.modelViewArtifactId);
    else other.database.prepare("UPDATE artifacts SET sealed_payload_json=json_set(sealed_payload_json,'$.modelView[0].content','foreign') WHERE id=?").run(committed.checkpoint.modelViewArtifactId);
    assertBlocked(f.read(), "checkpoint.snapshot_unavailable");
  });
}

test("A21 Core sparse/prototype/depth/node/aggregate byte limits run before BEGIN without accessors", async t => {
  const f = await fixture(t); f.addRound(); const input = f.input(); let began = 0, invoked = false;
  const exec = f.store.database.exec.bind(f.store.database);
  f.store.database.exec = sql => { if (sql.startsWith("BEGIN")) began += 1; return exec(sql); };
  let deep = {}; for (let i = 0; i < 70; i += 1) deep = { child: deep };
  const sparse = Array(3); sparse[0] = input.modelView[0];
  const accessor = []; Object.defineProperty(accessor, "0", { enumerable: true, get() { invoked = true; return {}; } });
  for (const modelView of [sparse, accessor, [new Date()], [deep], Array(40_001).fill(null), Array(600).fill("x".repeat(1000))]) {
    assertBlocked(f.store.commitRunProgressCheckpoint({ ...input, modelView }), "checkpoint.snapshot_unavailable");
  }
  assert.equal(began, 0); assert.equal(invoked, false);
});

test("A21 Core migration marker, composite head foreign key and immutable row are enforced", async t => {
  const f = await fixture(t); f.addRound(); const committed = f.store.commitRunProgressCheckpoint(f.input()); assertCommitted(committed);
  assert.ok(f.store.database.prepare("SELECT 1 FROM schema_migrations WHERE version=161").get());
  assert.deepEqual(f.store.database.prepare("PRAGMA foreign_key_check(run_progress_checkpoint_heads)").all(), []);
  assert.throws(() => f.store.database.prepare("UPDATE run_progress_checkpoint_heads SET checkpoint_id='foreign' WHERE run_id=?").run(f.run.id), /foreign key/i);
  assert.throws(() => f.store.database.prepare("UPDATE run_progress_checkpoints SET model_view_sha256=? WHERE id=?").run("d".repeat(64), committed.checkpoint.id), /immutable/);
});
