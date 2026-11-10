import assert from "node:assert/strict";
import test from "node:test";
import { createSqliteWorkflowIntegrationCoordinatorStore, workflowIsolationSafetyFingerprint } from "../dist/index.js";
import { workflowIsolationFixture, assertIsolationNoWrites, nextCommit } from "./support/workflow-isolation-fixture.mjs";
import { workflowIsolationResultsFixture } from "./support/workflow-isolation-results-fixture.mjs";

const now = () => new Date().toISOString();
const generationInput = f => ({ commandId: "terminal-retry", roundId: f.roundId, expectedGeneration: 1,
  expectedRevision: f.round().revision, writer: f.writer, inputs: { ...f.inputs,
    integration: { executionRoot: `${f.root}/integration-2`, worktreeId: "integration-2", branchRef: "refs/heads/ling/integration-2" } }, now: now() });
const retry = (f, overrides = {}) => f.isolation.beginIntegrationRoundGeneration({ ...generationInput(f), ...overrides });
const reject = (f, code, overrides = {}) => {
  const result = assertIsolationNoWrites(f, () => retry(f, overrides));
  assert.ok(["invalid", "stale", "conflict"].includes(result.status), JSON.stringify(result));
  assert.equal(result.code, `workflow_isolation.${code}`);
  return result;
};

async function terminalGenerationFixture(t, { outcome = "succeeded", drained = true, coverage = true,
  audit = true, release = true, beforeStop, source = false } = {}) {
  const f = await workflowIsolationFixture(t, { create: false, pin: false });
  if (source) {
    const thread = f.store.createLingThread({ kind: "channel_discussion", channelId: f.channel.id,
      title: "Retry source", objective: "Retain exact source authority" }, f.at(0));
    f.sourceTurn = f.store.appendConversationUserTurn({ threadId: thread.id, channelId: f.channel.id,
      title: "Isolated work", userInstruction: "Write the result", idempotencyKey: "retry-source",
      payload: { body: "Write the result", format: "markdown", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] } }, f.at(0));
    const workflow = f.store.getChannelWorkflow(f.plan.workflowId);
    f.store.updateChannelWorkflow(workflow.id, { metadata: { ...workflow.metadata,
      sourceMessageId: f.sourceTurn.item.id, sourceTurnId: f.sourceTurn.turnId } }, f.at(0));
  }
  f.create(); f.persistPin(); f.makeReady();
  assert.equal(f.isolation.sealPreparedExecution({ writer: f.writer, expectedRevision: f.binding().revision,
    runnerExecutionInput: f.executionPayload(), now: f.at(11) }).status, "updated");
  assert.equal(f.advance("blocked", { reason: "Retry with a new integration checkout" }).status, "updated");
  beforeStop?.(f);
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(f.at(20)) });
  const fence = f.prepared.fence, runId = f.prepared.run.id;
  f.source = { runId, ...fence };
  assert.equal(f.store.transitionWorkUnitStatus({ ...fence, expectedStatus: "queued", event: "claim", actor: "system", now: now() }).ok, true);
  assert.ok(f.store.updateWorkUnitAttemptStatus({ ...fence, status: "started", startedAt: now(), now: now() }));
  assert.equal(f.store.transitionRunStatus({ runId, expectedStatus: "queued", event: "runner_started", actor: "runner", startedAt: now(), now: now() }).ok, true);
  assert.equal(f.store.transitionWorkUnitStatus({ ...fence, expectedStatus: "claimed", event: "runner_started", actor: "runner", startedAt: now(), now: now() }).ok, true);
  assert.equal(f.store.transitionTaskStatus({ taskId: f.generation.task.id, expectedStatus: "claimed", event: "start_run",
    actor: "system", currentRunId: runId, now: now() }).ok, true);
  let finish;
  const lifetime = new Promise(resolve => { finish = resolve; });
  const completion = f.store.trackHostAttemptCompletion(f.source, lifetime, () => coverage);
  f.finish = async () => { finish(); return completion; };
  if (drained) await f.finish();
  else t.after(f.finish);
  const event = outcome === "succeeded" ? "runner_succeeded" : "runner_failed";
  assert.equal(f.store.transitionRunStatus({ runId, expectedStatus: "running", event, actor: "runner", endedAt: now(), now: now() }).ok, true);
  assert.equal(f.store.transitionWorkUnitStatus({ ...fence, expectedStatus: "running", event, actor: "runner", endedAt: now(), now: now() }).ok, true);
  assert.ok(f.store.updateWorkUnitAttemptStatus({ ...fence, status: outcome, endedAt: now(), now: now() }));
  if (audit) f.store.appendTerminalRuntimeAudit({ capability: { ...fence, attemptStatus: outcome, transitionedAt: now() },
    type: outcome === "succeeded" ? "work_unit_succeeded" : "work_unit_failed", actor: "runner", data: { runId } });
  f.release = () => {
    f.store.releaseHostAttemptResources(f.source, now());
    assert.deepEqual(f.store.listRuntimeSemaphoreSlots({ workUnitId: fence.workUnitId, status: "active" }), []);
    assert.equal(f.store.releaseResourceLease(f.generation.owner.leaseId, "workflow_step", f.plan.workflowStepId, now()), 1);
  };
  if (release) f.release();
  return f;
}

for (const outcome of ["succeeded", "failed"]) {
  test(`${outcome} original source creates one retry after real terminal, drain, release and reopen`, async t => {
    const f = await terminalGenerationFixture(t, { outcome }); f.reopenIsolation();
    const input = generationInput(f), binding = f.binding(), original = f.round(), plan = f.isolation.getScopePlan(f.plan.planId);
    assert.equal(f.isolation.assertTerminalCapture({ writer: f.writer, expectedRevision: binding.revision, now: now() }).status, "authorized");
    assert.equal(f.isolation.assertExecutionBinding({ writer: f.writer, now: now() }).status, "stale");
    const result = f.isolation.beginIntegrationRoundGeneration(input);
    assert.equal(result.status, "created", JSON.stringify(result));
    assert.equal(result.value.generation, 2); assert.equal(result.value.revision, 0);
    assert.equal(result.value.phase, "preparing"); assert.equal(result.value.writerBindingId, undefined);
    assert.deepEqual(f.isolation.getIntegrationRound(f.roundId, 1), original);
    assert.deepEqual(f.binding(), binding);
    assert.deepEqual(f.isolation.getScopePlan(f.plan.planId), plan);
    assert.equal(f.isolation.assertTerminalCapture({ writer: f.writer, expectedRevision: binding.revision, now: now() }).code,
      "workflow_isolation.terminal_lineage_changed");
    assert.equal(assertIsolationNoWrites(f, () => f.advance("collecting", { now: now() })).status, "stale");
    const coordinator = createSqliteWorkflowIntegrationCoordinatorStore(f.store);
    assert.equal(coordinator.assertAuthority({ roundId: f.roundId, generation: 2, now: now() }).code,
      "workflow_integration.participants_not_ready", "a new generation cannot silently adopt old branch plans/results");
    f.reopenIsolation(); t.mock.timers.tick(3_600_000);
    assert.deepEqual(assertIsolationNoWrites(f, () => f.isolation.beginIntegrationRoundGeneration({ ...input, now: now() })),
      { status: "duplicate", value: result.value });
    reject(f, "generation_changed", { ...input, commandId: "second-retry", now: now() });
    reject(f, "command_id_reused", { ...input, inputs: { ...input.inputs, integration: {
      ...input.inputs.integration, branchRef: "refs/heads/ling/different-retry" } }, now: now() });
  });
}

test("terminal retry may precede resource cleanup but not original Host drain", async t => {
  const f = await terminalGenerationFixture(t, { drained: false, release: false });
  assert.equal(f.isolation.assertExecutionBinding({ writer: f.writer, now: now() }).status, "current");
  reject(f, "terminal_host_not_drained");
  await f.finish();
  assert.equal(retry(f).status, "created");
  assert.equal(f.isolation.assertExecutionBinding({ writer: f.writer, now: now() }).status, "stale");
  assert.equal(f.isolation.assertTerminalCapture({ writer: f.writer, expectedRevision: f.binding().revision, now: now() }).code,
    "workflow_isolation.terminal_lineage_changed");
});

test("expired resources are not Host drain or terminal retry authority", async t => {
  const f = await terminalGenerationFixture(t, { drained: false, release: false });
  f.store.database.prepare("UPDATE resource_leases SET expires_at=?").run(f.at(-1));
  f.store.database.prepare("UPDATE runtime_semaphore_slots SET expires_at=?").run(f.at(-1));
  reject(f, "terminal_host_not_drained");
  await f.finish(); f.release();
  assert.equal(retry(f).status, "created");
});

for (const [name, options, code] of [
  ["effect coverage", { coverage: false }, "effect_coverage_unverified"],
  ["original runtime audit", { audit: false }, "audit_unverified"],
]) {
  test(`terminal retry cannot use active resources instead of ${name}`, async t => {
    const f = await terminalGenerationFixture(t, { ...options, release: false });
    reject(f, `terminal_${code}`);
  });
}

for (const status of ["pending", "blocked", "effect_unknown"]) {
  test(`terminal retry retains ${status} binding Git effects`, async t => {
    const f = await terminalGenerationFixture(t, { beforeStop: f => {
      const intent = f.intent({ intentId: "open-capture", commandId: "open-capture", kind: "branch_capture",
        before: f.gitIdentity(true), after: f.gitIdentity(true) });
      if (status !== "pending") f.receipt(intent, { outcome: status });
    } });
    reject(f, "terminal_git_effect_unconfirmed");
    assert.equal(f.binding().openIntentId, "open-capture");
  });
}

for (const status of ["pending", "blocked", "effect_unknown", "confirmed"]) {
  test(`terminal retry checks the separate ${status} result-ref journal`, async t => {
    const f = await workflowIsolationResultsFixture(t);
    assert.equal(f.advance("blocked", { reason: "Retry integration", now: now() }).status, "updated");
    f.resultIntent();
    if (status !== "pending") f.resultReceipt({ outcome: status });
    f.release();
    if (status === "confirmed") assert.equal(retry(f).status, "created");
    else f.noResultWrites(() => reject(f, "generation_effects_unconfirmed"));
  });
}

const authorityFaults = {
  workflowCancelled: f => f.store.database.prepare("UPDATE channel_workflows SET status='cancelled' WHERE id=?").run(f.plan.workflowId),
  stepCancelled: f => f.store.database.prepare("UPDATE channel_workflow_steps SET status='cancelled' WHERE id=?").run(f.plan.workflowStepId),
  taskCancelled: f => f.store.database.prepare("UPDATE tasks SET status='cancelled' WHERE id=?").run(f.generation.task.id),
  abortRequested: f => f.store.database.prepare("UPDATE work_unit_attempts SET abort_requested_at=? WHERE id=?").run(now(), f.prepared.attempt.id),
  channelPolicyRevoked: f => f.store.updateChannel(f.channel.id, { allowedTools: ["read"] }, now()),
  promptChanged: f => f.store.updateChannelWorkflowStep(f.plan.workflowStepId, { prompt: "Different work" }, now()),
  scopePinChanged: f => f.store.updateChannelWorkflowStep(f.plan.workflowStepId, { metadata: { ...f.current(f.scopeIsolation).metadata,
    isolationScopePlan: { planId: "new-plan", planDigest: f.plan.planDigest } } }, now()),
  safetyChanged: f => f.store.updateChannelWorkflowStep(f.plan.workflowStepId, { metadata: { ...f.current(f.scopeIsolation).metadata,
    requiredTools: ["bash"] } }, now()),
  ownerChanged: f => f.store.updateChannelWorkflowStep(f.plan.workflowStepId, { metadata: { ...f.current(f.scopeIsolation).metadata,
    startOwner: { ...f.current(f.scopeIsolation).metadata.startOwner, taskId: "new-task" } } }, now()),
  runPinChanged: f => f.store.database.prepare("UPDATE run_sessions SET request_snapshot_json='{}' WHERE id=?").run(f.prepared.run.id),
  slotOwnerChanged: f => f.store.database.prepare("UPDATE runtime_semaphore_slots SET owner_id='foreign' WHERE attempt_id=?").run(f.writer.attemptId),
};
for (const [name, mutate] of Object.entries(authorityFaults)) {
  test(`terminal retry rejects revoked or replaced authority: ${name}`, async t => {
    const f = await terminalGenerationFixture(t); mutate(f);
    const result = assertIsolationNoWrites(f, () => retry(f));
    assert.ok(["stale", "conflict"].includes(result.status), JSON.stringify(result));
  });
}

test("terminal retry rechecks original source revocation even for a duplicate command", async t => {
  const f = await terminalGenerationFixture(t, { source: true }), input = generationInput(f);
  assert.equal(f.isolation.beginIntegrationRoundGeneration(input).status, "created");
  f.store.database.prepare("UPDATE ling_turns SET status='superseded' WHERE id=?").run(f.sourceTurn.turnId);
  reject(f, "terminal_lineage_changed", input);
});

test("terminal retry rejects a different active start lease or a newer current Attempt", async t => {
  const f = await terminalGenerationFixture(t);
  const lease = f.lease(f.scopeIsolation, now());
  reject(f, "terminal_lease_owner_changed");
  assert.equal(f.store.releaseResourceLease(lease.id, "workflow_step", f.plan.workflowStepId, now()), 1);
  f.store.createWorkUnitAttempt({ workUnitId: f.prepared.unit.id, attemptNumber: 2,
    runtimeInstanceId: "successor-runtime", runnerId: "pi", now: now() });
  reject(f, "terminal_execution_changed");
});

test("terminal retry rejects each mismatched writer fence without adopting the caller", async t => {
  const f = await terminalGenerationFixture(t);
  for (const field of ["bindingId", "workUnitId", "attemptId", "runtimeInstanceId", "fencingToken"])
    reject(f, "writer_fence_changed", { writer: { ...f.writer, [field]: field === "fencingToken" ? "999" : "foreign" } });
});

test("terminal retry pins the current round, generation and revision", async t => {
  const f = await terminalGenerationFixture(t);
  reject(f, "generation_changed", { roundId: "different-round" });
  reject(f, "generation_changed", { expectedGeneration: 2 });
  reject(f, "revision_changed", { expectedRevision: f.round().revision + 1 });
  reject(f, "revision_invalid", { expectedRevision: -1 });
});

test("a retry only changes integration location, never source, target, template or safety pins", async t => {
  const f = await terminalGenerationFixture(t), original = generationInput(f).inputs;
  const safetyPins = [{ workflowStepId: f.plan.workflowStepId, fingerprint: "different-safety" }];
  for (const patch of [
    { target: { ...original.target, branchRef: "refs/heads/other-target" } },
    { target: { ...original.target, expectedHead: nextCommit }, baseCommit: nextCommit },
    { target: { ...original.target, cleanStateDigest: "different-basis" } },
    { target: { ...original.target, inputMode: "committed_head_only" } },
    { templatePins: [{ templateId: "other-template", version: "2", digest: "other-digest" }] },
    { safetyPins, safetyFingerprint: workflowIsolationSafetyFingerprint(safetyPins) },
    { graphFingerprint: "other-graph" },
    { repositoryIdentity: { ...original.repositoryIdentity, commonDir: `${f.cwd}/other.git` } },
    { validationRequirements: [{ id: "other-validation", fingerprint: "other-validator" }] },
  ]) reject(f, "generation_inputs_mismatch", { inputs: { ...original, ...patch } });
  for (const patch of [
    { branchRef: f.inputs.integration.branchRef }, { branchRef: f.plan.branchRef },
    { executionRoot: f.plan.executionRoot }, { worktreeId: f.plan.worktreeId },
  ]) reject(f, "location_retained", { inputs: { ...original, integration: { ...original.integration, ...patch } } });
});

test("a terminal retry rolls back its new generation and command on a late SQLite fault", async t => {
  const f = await terminalGenerationFixture(t);
  f.store.database.exec("CREATE TEMP TRIGGER generation_fault BEFORE INSERT ON workflow_isolation_commands BEGIN SELECT RAISE(ABORT,'generation-fault'); END");
  const before = f.snapshotIsolation();
  assert.throws(() => retry(f), /generation-fault/);
  assert.deepEqual(f.snapshotIsolation(), before);
  assert.equal(f.round().generation, 1);
});
