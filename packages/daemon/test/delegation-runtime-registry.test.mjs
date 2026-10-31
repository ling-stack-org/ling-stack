import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { DEFAULT_WORKSPACE_ID, SqliteRunStore, resolveStoragePaths, resolveSessionRunPolicy,
  applyConversationModeToEffectiveRunPolicySnapshot, toRuntimeAttemptFence } from "@ling-stack/core";
import { PiRunnerAdapter } from "@ling-stack/runner-pi";
import { resolveConfig } from "../dist/config.js";
import { RuntimeSupervisor } from "../dist/runtime/supervisor.js";
import { ActiveRunRegistry } from "../dist/runtime/active-runs.js";
import { createRunnerRegistry } from "../dist/runtime/runners.js";
import { patchWorkspaceRuntimeSettings } from "../dist/runtime/runner-settings.js";
import { resolveProviderForRun } from "../dist/features/runs/providers.js";
import { createHarnessFeatureSnapshot } from "../dist/features/harness/index.js";
import { createOriginalDelegationStoreComposition, admitOriginalDelegationRoot } from "../dist/features/harness/delegations/store-composition.js";
import { createDelegatedRunDispatchAuthority } from "../dist/features/harness/delegations/delegated-run-dispatch.js";
import { settleDelegationsForParentOutcome } from "../dist/features/harness/delegations/completion-wait.js";
import { ensureRunCancelled } from "../dist/features/runs/cancellation.js";
import { assertDelegationRecoveryParentCurrent, createDelegationRuntimeRegistry, createDelegationWorkflowSelector,
  readOriginalDelegationRuntimeRegistry } from "../dist/features/harness/delegations/runtime-registry.js";

const at = () => new Date().toISOString();
const spawnInput = (id = "spawn-1") => ({ spawnCallId: id, objective: "Read the isolated child objective.",
  requestedBudget: { tokenBudget: 1000 }, required: true });
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

/** Real original custody and isolated SQLite. No network, user data or model transport. */
async function fixture(t, options = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-delegation-runtime-"));
  const config = resolveConfig({ defaultWorkspaceCwd: cwd, harness: {
    continuations: { mode: options.continuations ?? "enforce" }, toolBroker: { mode: options.toolBroker ?? "enforce" }, delegations: {
    mode: options.mode ?? "enforce", rootBudget: { tokenBudget: 100_000, wallTimeBudgetMs: 120_000 },
  } } });
  const supervisor = new RuntimeSupervisor(config), active = new ActiveRunRegistry();
  const runners = createRunnerRegistry([{ id: "pi", displayName: "Registry fixture", status: "enabled", adapter: new PiRunnerAdapter() }]);
  const keyRef = "env:ISOLATED_DELEGATION_REGISTRY_KEY";
  const resolver = { status: ref => ({ ref, kind: "env", configured: ref === keyRef }),
    resolve: ref => ({ ref, configured: ref === keyRef, value: ref === keyRef ? "synthetic-no-network-key" : undefined,
      status: { ref, kind: "env", configured: ref === keyRef } }) };
  const composition = createOriginalDelegationStoreComposition({ supervisor, runnerRegistry: runners, secretResolver: resolver,
    delegatedDispatchAuthority: createDelegatedRunDispatchAuthority() });
  const paths = resolveStoragePaths(cwd, { homeDir: join(cwd, "fixture-home"), env: {}, workspaceStateLocation: "repo-local" }).workspace;
  const store = new SqliteRunStore({ cwd, paths, delegationHostBinding: composition.binding });
  composition.bindExactStore(store);
  const runtime = supervisor.getRuntime(cwd, store), now = at();
  patchWorkspaceRuntimeSettings(store, runners, { defaultRunnerId: "pi", allowedRunnerIds: ["pi"] }, now);
  const preset = store.createProviderPreset({ kind: "openai-compatible", displayName: "Registry fixture", providerId: "registry-fixture",
    model: "fixture-model", api: "openai-completions", baseUrl: "https://delegation.invalid/v1", apiKeyRef: keyRef,
    contextWindow: 1000, maxTokens: 100, capabilities: ["chat"], enabled: true }, now);
  const provider = resolveProviderForRun(store, { providerPresetId: preset.id, skipProviderPreflight: true }, resolver);
  const channel = store.createChannel({ name: "Isolated registry", boundPath: cwd, allowedTools: ["read"] }, now);
  const task = store.createTask({ channelId: channel.id, title: "Parent", prompt: "Parent frozen task." }, now);
  const workflow = store.createChannelWorkflow({ channelId: channel.id, title: "Explicit selected workflow",
    objective: task.prompt, createdBy: "local-user", status: "running" }, now);
  config.harness.delegations.selectedWorkflowIds = Object.freeze(options.selected === false ? [] : [workflow.id]);
  const step = store.createChannelWorkflowStep({ workflowId: workflow.id, title: "Parent execution", prompt: task.prompt,
    toParticipantId: "teammate_builtin_engineer", toParticipantLabel: "Engineer", status: "running" }, now);
  const thread = store.createLingThread({ kind: "task", channelId: channel.id, taskId: task.id, title: task.title, objective: task.prompt }, now);
  const turn = store.createLingTurn({ threadId: thread.id, kind: "initial_request", taskId: task.id,
    channelId: channel.id, title: task.title, userInstruction: task.prompt, createdByActor: "local-user" }, now);
  const taskSnapshot = { id: task.id, channelId: channel.id, title: task.title, prompt: task.prompt };
  const request = { cwd, workspaceCwd: cwd, providerPresetId: preset.id, task: taskSnapshot, threadId: thread.id,
    turnId: turn.id, workflowStepId: step.id, runnerId: "pi", tools: ["read"],
    authorizationMode: "smart", workspaceAccessMode: "workspace_write",
    harnessFeatureSnapshot: { ...createHarnessFeatureSnapshot({ harness: supervisor.getHarnessFeatures() }),
      delegationSelectedWorkflowIds: [...config.harness.delegations.selectedWorkflowIds] } };
  const unit = store.createWorkUnit({ id: "root-unit", workspaceId: DEFAULT_WORKSPACE_ID, kind: "conversation_run", ownerType: "run",
    ownerId: "root", status: "claimed", channelId: channel.id, taskId: task.id, runnerId: "pi", effectiveRunnerId: "pi",
    idempotencyKey: "registry-root", createdByActor: "system", request, now });
  const attempt = store.createWorkUnitAttempt({ id: "root-attempt", workUnitId: unit.id, attemptNumber: 1,
    runtimeInstanceId: runtime.runtimeInstanceId, runnerId: "pi", effectiveRunnerId: "pi", now });
  const run = store.createRun({ id: "root", cwd, taskId: task.id, channelId: channel.id, workflowStepId: step.id,
    workUnitId: unit.id, threadId: thread.id, turnId: turn.id, providerPresetId: preset.id,
    providerName: provider.provider, providerModel: provider.model, taskSnapshot, providerSnapshot: {}, requestSnapshot: request, createdAt: now });
  store.linkRunToWorkUnit(run.id, unit.id, now);
  store.updateChannelWorkflowStep(step.id, { runId: run.id, taskId: task.id }, now);
  const policy = applyConversationModeToEffectiveRunPolicySnapshot(resolveSessionRunPolicy({ workspacePolicy: store.getApprovalPolicy(),
    authorizationMode: "smart", workspaceAccessMode: "workspace_write", channelBoundPath: cwd }).snapshot, thread.conversationMode.mode);
  admitOriginalDelegationRoot({ store, run: store.getRun(run.id), attempt: store.getWorkUnitAttempt(attempt.id),
    originalProvider: provider, request, effectivePolicySnapshot: policy, runtimeTools: ["read"], now });
  // Seed only the pre-existing parent. All child facts belong to production lifecycle methods.
  store.database.prepare("UPDATE run_sessions SET status='running',started_at=? WHERE id=?").run(now, run.id);
  store.database.prepare("UPDATE work_units SET status='running',started_at=? WHERE id=?").run(now, unit.id);
  store.database.prepare("UPDATE work_unit_attempts SET status='started',started_at=? WHERE id=?").run(now, attempt.id);
  const fence = toRuntimeAttemptFence(store.getWorkUnitAttempt(attempt.id));
  let current = true, assertions = 0;
  const assertCurrent = () => { assertions++; if (!current) throw Object.assign(new Error("revoked Host authority"), { code: "delegation.provider_revoked" }); };
  const calls = [], selector = createDelegationWorkflowSelector((options.currentSelected ?? options.selected) === false ? [] : [workflow.id]);
  const registry = createDelegationRuntimeRegistry({ supervisor, activeRuns: active,
    ...(options.onRunTerminal ? { onRunTerminal: options.onRunTerminal } : {}),
    ...(options.selectorAbsent ? {} : { isWorkflowSelected: selector }),
    ...(options.recoveryAuthority ? { assertRecoveryParentCurrent: assertCurrent } : {}),
    executeDelegatedRunRequest: async input => { calls.push(input); return options.execute?.(input); },
  });
  if (options.register !== false) registry.registerStore(store, composition.lifecycle);
  const binding = { store, runId: run.id, sourceFence: fence, assertCurrent };
  const bind = () => registry.bindParent(binding);
  t.after(async () => {
    registry.stopAdmission(); await registry.abortOwned().catch(() => undefined);
    await registry.settle().catch(() => undefined);
    supervisor.releaseAll(); store.close(); await rm(cwd, { recursive: true, force: true });
  });
  return { cwd, config, supervisor, active, composition, store, workflow, step, run, fence, registry,
    binding, bind, calls, selector, revoke: () => { current = false; }, restore: () => { current = true; }, assertions: () => assertions };
}

for (const outcome of ["succeeded", "failed", "cancelled"]) test(`feature-off ordinary ${outcome} needs no dynamic Store enrollment`, async t => {
  const f = await fixture(t, { mode: "off", register: false });
  assert.deepEqual(f.store.getDelegationCompletionEvidence({ rootRunIds: [f.run.id] }).steps, []);
  assert.deepEqual(f.registry.recoverStore(f.store), { status: "disabled", scanned: 0, dispatched: 0, retained: 0 });
  await settleDelegationsForParentOutcome({ store: f.store, registry: f.registry, runId: f.run.id,
    sourceFence: f.fence, outcome, signal: AbortSignal.timeout(1000) });
  assert.equal(f.calls.length, 0);
});

test("enabled recovery still rejects a Store without its original composition", async t => {
  const f = await fixture(t, { register: false });
  assert.throws(() => f.registry.recoverStore(f.store), { code: "delegation.store_composition_unavailable" });
  assert.equal(f.calls.length, 0);
});

for (const desiredOutcome of ["failed", "cancelled"]) test(`public cancel cannot steal a pending ${desiredOutcome} terminal intent`, async t => {
  const notifications = [], f = await fixture(t, { onRunTerminal: value => { notifications.push(value); } });
  const lifetime = deferred(), completion = f.store.trackHostAttemptCompletion({ runId: f.run.id, ...f.fence }, lifetime.promise, () => true);
  t.after(async () => { lifetime.resolve(); await completion; });
  const acquiredAt = at(), resource = { ...f.fence, workspaceId: DEFAULT_WORKSPACE_ID,
    ownerType: "work_unit_attempt", ownerId: f.fence.attemptId, acquiredAt,
    expiresAt: new Date(Date.now() + 60000).toISOString() };
  f.store.acquireResourceLease({ ...resource, resourceType: "channel", resourceKey: f.run.channelId });
  f.store.acquireRuntimeSemaphoreSlot({ ...resource, resourceType: "runner", resourceKey: "pi", limit: 1 });
  f.registry.prepareParentTerminalIntent({ store: f.store, runId: f.run.id, sourceFence: f.fence,
    desiredOutcome, errorCode: "controlled", errorMessage: "Controlled terminal intent." });
  const snapshot = () => ["run_sessions", "work_units", "work_unit_attempts", "tasks", "run_events",
    "resource_leases", "runtime_semaphore_slots", "control_plane_events", "run_terminal_intents"]
    .map(table => [table, f.store.database.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()]);
  const before = snapshot();
  assert.throws(() => ensureRunCancelled({ store: f.store, runId: f.run.id, taskId: f.run.taskId,
    reason: "User clicked Stop while cleanup was pending.", active: false, expectedAttemptId: f.fence.attemptId }),
  { statusCode: 409, code: "run_terminal_cleanup_pending" });
  assert.deepEqual(snapshot(), before, "no terminal, history, projection or resource write before actual drain");
  lifetime.resolve(); await completion; await f.registry.reconcileTerminalIntents(f.store);
  assert.equal(f.store.getRun(f.run.id).status, desiredOutcome);
  assert.equal(notifications.length, 1);
});

test("terminal notification failure leaves its committed outbox retryable and a successful retry ACKs once", async t => {
  const notifications = [], f = await fixture(t, { onRunTerminal(input) {
    notifications.push(input); if (notifications.length === 1) throw new Error("isolated-notification-failure");
  } });
  const lifetime = deferred();
  const completion = f.store.trackHostAttemptCompletion({ runId: f.run.id, ...f.fence }, lifetime.promise, () => true);
  f.registry.prepareParentTerminalIntent({ store: f.store, runId: f.run.id, sourceFence: f.fence,
    desiredOutcome: "failed", errorCode: "controlled", errorMessage: "Controlled failure." });
  lifetime.resolve(); await completion;
  await f.registry.reconcileTerminalIntents(f.store);
  assert.equal(f.store.getRun(f.run.id).status, "failed");
  assert.equal(f.composition.lifecycle.getRunTerminalIntent(f.fence.attemptId).notifiedAt, undefined);
  assert.equal(notifications.length, 1);
  const count = f.store.database.prepare("SELECT COUNT(*) n FROM control_plane_events").get().n;
  await f.registry.reconcileTerminalIntents(f.store);
  assert.ok(f.composition.lifecycle.getRunTerminalIntent(f.fence.attemptId).notifiedAt);
  assert.equal(notifications.length, 2);
  assert.deepEqual(notifications[1].controlPlaneEvents, notifications[0].controlPlaneEvents);
  await f.registry.reconcileTerminalIntents(f.store);
  assert.equal(notifications.length, 2);
  assert.equal(f.store.database.prepare("SELECT COUNT(*) n FROM control_plane_events").get().n, count);
});

test("an absent terminal projection hook cannot acknowledge its durable outbox", async t => {
  const f = await fixture(t), lifetime = deferred();
  const completion = f.store.trackHostAttemptCompletion({ runId: f.run.id, ...f.fence }, lifetime.promise, () => true);
  f.registry.prepareParentTerminalIntent({ store: f.store, runId: f.run.id, sourceFence: f.fence,
    desiredOutcome: "failed", errorCode: "controlled", errorMessage: "Controlled failure." });
  lifetime.resolve(); await completion; await f.registry.reconcileTerminalIntents(f.store);
  const intent = f.composition.lifecycle.getRunTerminalIntent(f.fence.attemptId);
  assert.equal(intent.state, "committed"); assert.equal(intent.notifiedAt, undefined);
  assert.deepEqual(f.composition.lifecycle.listUnfinishedRunTerminalIntents({ cutoffAt: at(), limit: 100 }).attemptIds, [f.fence.attemptId]);
});

test("reopened disabled registry consumes original drained intent at Store registration without a Runner", async t => {
  const f = await fixture(t), lifetime = deferred();
  const completion = f.store.trackHostAttemptCompletion({ runId: f.run.id, ...f.fence }, lifetime.promise, () => true);
  f.registry.prepareParentTerminalIntent({ store: f.store, runId: f.run.id, sourceFence: f.fence,
    desiredOutcome: "cancelled", errorCode: "controlled", errorMessage: "Controlled cancellation." });
  lifetime.resolve(); await completion;
  f.registry.stopAdmission(); await f.registry.settle(); f.supervisor.releaseAll(); f.store.close();
  f.config.harness.delegations.mode = "off";
  const supervisor = new RuntimeSupervisor(f.config), active = new ActiveRunRegistry();
  const runners = createRunnerRegistry([{ id: "pi", displayName: "No-dispatch recovery", status: "enabled", adapter: new PiRunnerAdapter() }]);
  const composition = createOriginalDelegationStoreComposition({ supervisor, runnerRegistry: runners,
    secretResolver: { status: () => ({ kind: "env", configured: false }), resolve: () => ({ configured: false }) } });
  const store = new SqliteRunStore({ cwd: f.cwd, paths: f.store.paths, delegationHostBinding: composition.binding });
  composition.bindExactStore(store);
  let dispatched = 0; const notifications = [];
  const registry = createDelegationRuntimeRegistry({ supervisor, activeRuns: active,
    onRunTerminal: input => notifications.push(input),
    executeDelegatedRunRequest: async () => { dispatched++; throw new Error("must-not-dispatch"); } });
  try {
    registry.registerStore(store, composition.lifecycle);
    assert.equal(registry.isEnabled(), false);
    await registry.settle();
    assert.equal(store.getRun(f.run.id).status, "cancelled");
    assert.equal(store.getWorkUnitAttempt(f.fence.attemptId).runtimeInstanceId, f.fence.runtimeInstanceId);
    assert.equal(store.listWorkUnitAttempts(f.fence.workUnitId).length, 1);
    assert.ok(composition.lifecycle.getRunTerminalIntent(f.fence.attemptId).notifiedAt);
    assert.equal(notifications.length, 1); assert.equal(dispatched, 0);
    assert.equal(registry.recoverStore(store).status, "disabled"); await registry.settle();
    assert.equal(notifications.length, 1); assert.equal(dispatched, 0);
  } finally {
    registry.stopAdmission(); await registry.settle(); supervisor.releaseAll(); store.close();
  }
});

test("only original startup Supervisor, exact lifecycle and Store can enroll", async t => {
  assert.throws(() => createDelegationRuntimeRegistry({ supervisor: {}, activeRuns: new ActiveRunRegistry(),
    executeDelegatedRunRequest: async () => undefined }), { code: "delegation.authority_invalid" });
  const f = await fixture(t);
  assert.equal(readOriginalDelegationRuntimeRegistry(f.supervisor), f.registry);
  assert.throws(() => readOriginalDelegationRuntimeRegistry({}), { code: "delegation.authority_invalid" });
  assert.throws(() => createDelegationRuntimeRegistry({ supervisor: f.supervisor, activeRuns: f.active,
    executeDelegatedRunRequest: async () => undefined }), { code: "delegation.authority_invalid" });
  assert.throws(() => f.registry.registerStore(f.store, { ...f.composition.lifecycle }), { code: "delegation.authority_invalid" });
  assert.throws(() => f.registry.registerStore({}, f.composition.lifecycle), { code: "delegation.authority_invalid" });
});

test("restart recovery requires the exact live parent process entry and durable fence", async t => {
  const f = await fixture(t);
  const check = () => assertDelegationRecoveryParentCurrent({ store: f.store, activeRuns: f.active,
    runId: f.run.id, sourceFence: f.fence });
  assert.throws(check, { code: "delegation.source_attempt_stale" });
  const abortController = new AbortController();
  f.active.add(f.run.id, { abortController, streamEnvelope() {}, workUnitId: f.fence.workUnitId,
    attemptId: f.fence.attemptId, runtimeInstanceId: f.fence.runtimeInstanceId, fencingToken: f.fence.fencingToken });
  assert.doesNotThrow(check);
  assert.throws(() => assertDelegationRecoveryParentCurrent({ store: f.store, activeRuns: f.active,
    runId: f.run.id, sourceFence: { ...f.fence, fencingToken: "foreign" } }), { code: "delegation.source_attempt_stale" });
  abortController.abort();
  assert.throws(check, { code: "delegation.source_attempt_stale" });
});

for (const options of [{ mode: "off" }, { mode: "shadow" }, { selectorAbsent: true }, { selected: false },
  { continuations: "off" }, { continuations: "shadow" }, { toolBroker: "off" }, { toolBroker: "shadow" }]) {
  test(`off/shadow/absent/unselected cannot activate a dynamic producer: ${JSON.stringify(options)}`, async t => {
    const f = await fixture(t, options);
    assert.equal(f.registry.isSelectedWorkflow({ store: f.store, workflowStepId: f.step.id, channelId: f.run.channelId }), false);
    assert.throws(f.bind, error => ["delegation.dynamic_gate_unavailable", "delegation.workflow_not_selected"].includes(error.code));
    assert.equal(f.calls.length, 0);
    assert.equal(f.store.database.prepare("SELECT count(*) AS count FROM delegation_steps").get().count, 0);
  });
}

test("Host workflow selection prepares schema without a Run and rejects design drift", async t => {
  const f = await fixture(t);
  assert.equal(f.registry.isSelectedWorkflow({ store: f.store, workflowStepId: f.step.id, channelId: f.run.channelId }), true);
  f.store.updateChannelWorkflowStep(f.step.id, { prompt: "Changed selected design" }, at());
  assert.equal(f.registry.isSelectedWorkflow({ store: f.store, workflowStepId: f.step.id, channelId: f.run.channelId }), false);
  assert.throws(f.bind, { code: "delegation.workflow_not_selected" });
});

test("expanded current workflow selection cannot retroactively authorize a persisted unselected Run", async t => {
  const f = await fixture(t, { selected: false, currentSelected: true });
  assert.equal(f.registry.isSelectedWorkflow({ store: f.store, workflowStepId: f.step.id, channelId: f.run.channelId }), true);
  assert.deepEqual(f.store.getRun(f.run.id).requestSnapshot.harnessFeatureSnapshot.delegationSelectedWorkflowIds, []);
  assert.throws(f.bind, { code: "delegation.workflow_not_selected" });
  assert.equal(f.calls.length, 0);
  assert.equal(f.store.database.prepare("SELECT COUNT(*) AS count FROM delegation_steps").get().count, 0);
});

for (const selected of [undefined, "not-an-array", [""], ["different-workflow"]]) {
  test(`historical missing/malformed/unselected workflow snapshot stays fail-closed: ${JSON.stringify(selected)}`, async t => {
    const f = await fixture(t), request = f.store.getRun(f.run.id).requestSnapshot;
    const snapshot = { ...request.harnessFeatureSnapshot, delegationSelectedWorkflowIds: selected };
    f.store.database.prepare("UPDATE run_sessions SET request_snapshot_json=? WHERE id=?")
      .run(JSON.stringify({ ...request, harnessFeatureSnapshot: snapshot }), f.run.id);
    assert.throws(f.bind, { code: "delegation.workflow_not_selected" });
    assert.equal(f.calls.length, 0);
  });
}

test("one original spawn creates one Attempt and dispatch; replay is observation only", async t => {
  const f = await fixture(t), tools = f.bind();
  const first = tools.spawn(spawnInput()), replay = tools.spawn(spawnInput());
  assert.equal(first.replayed, false); assert.equal(replay.replayed, true);
  assert.equal(replay.childRunId, first.childRunId);
  await f.registry.settle();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].store, f.store);
  assert.equal(f.calls[0].request.parentRunId, f.run.id);
  assert.equal(f.calls[0].request.workflowStepId, f.step.id);
  assert.deepEqual(f.calls[0].request.harnessFeatureSnapshot.delegationSelectedWorkflowIds, [f.workflow.id],
    "the child inherits the root Run's frozen Host selection rather than current config");
  assert.doesNotMatch(JSON.stringify(f.calls[0].request), /synthetic-no-network-key/);
  const actual = f.composition.lifecycle.recover(first.reservationId);
  assert.equal(actual.kind, "dispatch_outcome_unknown", "a test executor resolving is not a fabricated SDK ACK");
  assert.equal(actual.runtime.workUnit.attemptCount, 1);
  assert.equal(f.store.getRun("root").status, "running");
});

for (const frozen of [undefined, { schemaVersion: 0, continuations: "enforce", toolBroker: "enforce", delegations: "enforce" },
  { schemaVersion: 1, continuations: "off", toolBroker: "enforce", delegations: "enforce" },
  { schemaVersion: 1, continuations: "enforce", toolBroker: "shadow", delegations: "enforce" },
  { schemaVersion: 1, continuations: "enforce", toolBroker: "enforce", delegations: "off" }]) {
  test(`current enforce config cannot retroactively authorize a historical frozen Run: ${JSON.stringify(frozen)}`, async t => {
    const f = await fixture(t);
    // Simulate an already persisted Run admitted under an older feature policy.
    const request = { ...f.store.getRun(f.run.id).requestSnapshot, harnessFeatureSnapshot: frozen };
    f.store.database.prepare("UPDATE run_sessions SET request_snapshot_json=? WHERE id=?").run(JSON.stringify(request), f.run.id);
    assert.throws(f.bind, { code: "delegation.dynamic_gate_unavailable" });
    assert.equal(f.calls.length, 0);
    assert.equal(f.store.database.prepare("SELECT count(*) AS count FROM delegation_steps").get().count, 0);
  });
}

test("message is durably queued, not falsely delivered; every call rechecks Host authority", async t => {
  const f = await fixture(t), tools = f.bind(), child = tools.spawn(spawnInput());
  await f.registry.settle();
  const message = tools.message({ reservationId: child.reservationId, messageCallId: "message-1", text: "Read only." });
  assert.equal(message.status, "durable_queued"); assert.ok(message.messageId);
  assert.equal(tools.message({ reservationId: child.reservationId, messageCallId: "message-1", text: "Read only." }).replayed, true);
  f.revoke();
  for (const operation of [() => tools.spawn(spawnInput("revoked")),
    () => tools.message({ reservationId: child.reservationId, messageCallId: "revoked", text: "No" }),
    () => tools.wait({ reservationId: child.reservationId, timeoutMs: 0 }),
    () => tools.interrupt({ reservationId: child.reservationId, callId: "revoked" }),
    () => tools.resume({ reservationId: child.reservationId, expectedStepRevision: child.stepRevision, callId: "revoked-resume" })]) {
    assert.throws(operation, { code: "delegation.provider_revoked" });
  }
  assert.ok(f.assertions() > 5);
});

test("revocation before executor entry stays unknown/blocked, not refunded or replayed", async t => {
  const f = await fixture(t), tools = f.bind(), child = tools.spawn(spawnInput());
  f.revoke(); await f.registry.settle(); f.restore();
  assert.equal(f.calls.length, 0);
  const result = await tools.wait({ reservationId: child.reservationId, timeoutMs: 0 });
  assert.equal(result.observation.code, "delegation.provider_revoked"); assert.equal(result.timedOut, false);
  assert.equal(f.composition.lifecycle.recover(child.reservationId).kind, "dispatch_outcome_unknown");
  assert.equal(tools.spawn(spawnInput()).replayed, true);
  await f.registry.settle(); assert.equal(f.calls.length, 0);
});

test("admission shutdown preserves an existing wait until the explicit abort phase", async t => {
  const f = await fixture(t), tools = f.bind(), child = tools.spawn(spawnInput());
  await f.registry.settle();
  assert.throws(() => tools.wait({ reservationId: child.reservationId, timeoutMs: 60_001 }), { code: "delegation.invalid_wait_timeout" });
  const immediate = await tools.wait({ reservationId: child.reservationId, timeoutMs: 0 });
  assert.equal(immediate.timedOut, true);
  assert.equal(f.composition.lifecycle.recover(child.reservationId).runtime.reservation.state, "reserved");
  const wait = tools.wait({ reservationId: child.reservationId, timeoutMs: 60_000 });
  let settled = false;
  void wait.then(() => { settled = true; }, () => { settled = true; });
  const observations = f.assertions();
  f.registry.stopAdmission();
  // Force the real polling branch to recheck authority after admission closes.
  await delay(150);
  assert.equal(settled, false, "stopping new work is not permission to abort a captured observer");
  assert.ok(f.assertions() > observations, "the existing poll must still verify its original live authority");
  assert.throws(() => tools.wait({ reservationId: child.reservationId, timeoutMs: 0 }), { code: "delegation.admission_closed" });
  assert.throws(() => tools.spawn(spawnInput("after-stop")), { code: "delegation.admission_closed" });
  await f.registry.abortOwned();
  await assert.rejects(wait, error => error.name === "AbortError");
  await f.registry.settle();
});

test("an existing shutdown observer cannot retain revoked Host authority", async t => {
  const f = await fixture(t), tools = f.bind(), child = tools.spawn(spawnInput());
  await f.registry.settle();
  const wait = tools.wait({ reservationId: child.reservationId, timeoutMs: 60_000 });
  const rejected = assert.rejects(wait, { code: "delegation.provider_revoked" });
  f.registry.stopAdmission(); f.revoke();
  await rejected;
  assert.equal(f.composition.lifecycle.recover(child.reservationId).runtime.reservation.state, "reserved");
});

test("actual executor rejection remains a shutdown settlement failure", async t => {
  const f = await fixture(t, { execute: async () => { throw new Error("controlled executor drain failure"); } });
  f.bind().spawn(spawnInput());
  await assert.rejects(f.registry.settle(), error => error instanceof AggregateError
    && error.errors.some(cause => cause.message === "controlled executor drain failure"));
});

for (const replacement of [false, true]) test(`shutdown preserves a pre-ACK child and never stops a foreign fence (replacement=${replacement})`, async t => {
  const release = deferred(); t.after(() => release.resolve());
  const f = await fixture(t, { execute: () => release.promise }), child = f.bind().spawn(spawnInput());
  await Promise.resolve();
  const actual = f.composition.lifecycle.recover(child.reservationId), abortController = new AbortController();
  f.active.add(child.childRunId, { ...toRuntimeAttemptFence(actual.runtime.attempt),
    ...(replacement ? { attemptId: "replacement-attempt" } : {}), abortController, streamEnvelope() {}, completion: release.promise });
  let settled = false;
  const settlement = f.registry.settle().then(() => { settled = true; });
  f.registry.stopAdmission(); await f.registry.abortOwned();
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(abortController.signal.aborted, false,
    "a claimed child without a durable receiver ACK has no resumable interrupt basis");
  assert.equal(f.composition.lifecycle.recover(child.reservationId).kind, "dispatch_outcome_unknown");
  release.resolve(); await settlement;
});

function liveParent(f) {
  const abortController = new AbortController();
  f.active.add(f.run.id, { ...f.fence, abortController, streamEnvelope() {} });
  return abortController;
}

for (const outcome of ["succeeded", "failed", "cancelled"]) test(`parent ${outcome} closes admission and owns exact optional stop, without resumable interrupt`, async t => {
  const release = deferred(); t.after(() => release.resolve());
  const f = await fixture(t, { execute: () => release.promise }), tools = f.bind(); liveParent(f);
  const child = tools.spawn({ ...spawnInput(), required: false }); await Promise.resolve();
  const before = f.composition.lifecycle.recover(child.reservationId), abortController = new AbortController();
  const hostCompletion = f.store.trackHostAttemptCompletion({ runId: child.childRunId,
    ...toRuntimeAttemptFence(before.runtime.attempt) }, release.promise);
  void hostCompletion.catch(() => undefined);
  f.active.add(child.childRunId, { ...toRuntimeAttemptFence(before.runtime.attempt), abortController,
    streamEnvelope() {}, completion: release.promise });
  let finished = false;
  const stopping = f.registry.closeParent({ store: f.store, runId: f.run.id, sourceFence: f.fence,
    outcome, signal: new AbortController().signal }).then(() => { finished = true; });
  void stopping.catch(() => {});
  const repeated = f.registry.closeParent({ store: f.store, runId: f.run.id, sourceFence: f.fence,
    outcome, signal: new AbortController().signal }); void repeated.catch(() => {});
  assert.throws(() => tools.spawn(spawnInput("after-parent-return")), { code: "delegation.admission_closed" });
  assert.equal(abortController.signal.aborted, true);
  assert.equal(f.active.get(child.childRunId).stopIntent.kind, "workflow_cancel");
  assert.equal(f.composition.lifecycle.recover(child.reservationId).runtime.step.state, before.runtime.step.state,
    "stop request must not fabricate an interrupt checkpoint or terminal receipt");
  await Promise.resolve(); assert.equal(finished, false);
  release.resolve(); await Promise.all([stopping, repeated, hostCompletion]);
  assert.equal(finished, true);
  assert.equal(f.calls.length, 1, "repeated close never redispatches or creates another Attempt");
  assert.equal(f.store.getDelegationCompletionEvidence({ rootRunIds: [f.run.id] }).status, "pending",
    "original Promise completion alone cannot fabricate Host drain, usage settlement or a sealed result");
});

test("optional stop without original registered Host completion stays blocked before physical abort", async t => {
  const release = deferred(); t.after(() => release.resolve());
  const f = await fixture(t, { execute: () => release.promise }), tools = f.bind(); liveParent(f);
  const child = tools.spawn({ ...spawnInput(), required: false }); await Promise.resolve();
  const before = f.composition.lifecycle.recover(child.reservationId), abortController = new AbortController();
  f.active.add(child.childRunId, { ...toRuntimeAttemptFence(before.runtime.attempt), abortController,
    streamEnvelope() {}, completion: release.promise });
  await assert.rejects(f.registry.closeParent({ store: f.store, runId: f.run.id, sourceFence: f.fence,
    outcome: "succeeded", signal: new AbortController().signal }), /run_terminal_intent_source_invalid/);
  assert.equal(abortController.signal.aborted, false);
  assert.equal(f.composition.lifecycle.getRunTerminalIntent(before.runtime.attempt.id), undefined);
  assert.equal(f.composition.lifecycle.recover(child.reservationId).runtime.reservation.state, "reserved");
});

test("parent stop preserves an original failed terminal intent and process stop reason", async t => {
  const release = deferred(); t.after(() => release.resolve());
  const f = await fixture(t, { execute: () => release.promise }), tools = f.bind(); liveParent(f);
  const child = tools.spawn({ ...spawnInput(), required: false }); await Promise.resolve();
  const before = f.composition.lifecycle.recover(child.reservationId), fence = toRuntimeAttemptFence(before.runtime.attempt);
  const hostCompletion = f.store.trackHostAttemptCompletion({ runId: child.childRunId, ...fence }, release.promise);
  void hostCompletion.catch(() => undefined);
  const abortController = new AbortController();
  f.active.add(child.childRunId, { ...fence, abortController, streamEnvelope() {}, completion: release.promise });
  const intent = f.composition.lifecycle.prepareRunTerminalIntent({ runId: child.childRunId, sourceFence: fence,
    desiredOutcome: "failed", errorCode: "hard_timeout", errorMessage: "original timeout", now: at() });
  f.active.requestStop(child.childRunId, { kind: "runtime_failure", code: "hard_timeout", reason: "original timeout" });
  const stopping = f.registry.closeParent({ store: f.store, runId: f.run.id, sourceFence: f.fence,
    outcome: "succeeded", signal: new AbortController().signal });
  f.registry.prepareParentTerminalIntent({ store: f.store, runId: child.childRunId, sourceFence: fence,
    desiredOutcome: "cancelled", errorCode: "cancelled", errorMessage: "cancelled" });
  assert.deepEqual(f.composition.lifecycle.getRunTerminalIntent(fence.attemptId), intent);
  assert.equal(f.active.getStopIntent(child.childRunId).kind, "runtime_failure");
  release.resolve(); await Promise.all([stopping, hostCompletion]);
});

test("partial subtree intent persistence never sends a partial abort and exact retry preserves the first intent", async t => {
  const release = deferred(); t.after(() => release.resolve());
  const f = await fixture(t, { execute: () => release.promise }), tools = f.bind(); liveParent(f);
  tools.spawn({ ...spawnInput("optional-first"), required: false });
  tools.spawn({ ...spawnInput("optional-second"), required: false }); await Promise.resolve();
  const children = f.store.getDelegationCompletionEvidence({ rootRunIds: [f.run.id] }).steps;
  assert.equal(children.length, 2);
  const controllers = children.map(() => new AbortController());
  for (const [index, read] of children.entries()) f.active.add(read.childRun.id, { ...read.attempt.sourceFence,
    abortController: controllers[index], streamEnvelope() {}, completion: release.promise });
  const first = children[0], second = children[1];
  const completedFirst = f.store.trackHostAttemptCompletion({ runId: first.childRun.id, ...first.attempt.sourceFence }, release.promise);
  void completedFirst.catch(() => undefined);
  const close = () => f.registry.closeParent({ store: f.store, runId: f.run.id, sourceFence: f.fence,
    outcome: "succeeded", signal: new AbortController().signal });
  await assert.rejects(close(), /run_terminal_intent_source_invalid/);
  assert.ok(controllers.every(controller => !controller.signal.aborted), "all intents must exist before the first abort");
  const original = f.composition.lifecycle.getRunTerminalIntent(first.attempt.sourceFence.attemptId); assert.ok(original);
  assert.equal(f.composition.lifecycle.getRunTerminalIntent(second.attempt.sourceFence.attemptId), undefined);
  const completedSecond = f.store.trackHostAttemptCompletion({ runId: second.childRun.id, ...second.attempt.sourceFence }, release.promise);
  void completedSecond.catch(() => undefined);
  const retry = close();
  assert.ok(controllers.every(controller => controller.signal.aborted));
  assert.deepEqual(f.composition.lifecycle.getRunTerminalIntent(first.attempt.sourceFence.attemptId), original);
  release.resolve(); await Promise.all([retry, completedFirst, completedSecond]);
});

test("a previous process-only failure cannot acquire a new cancellation intent from parent stop", async t => {
  const release = deferred(); t.after(() => release.resolve());
  const f = await fixture(t, { execute: () => release.promise }), tools = f.bind(); liveParent(f);
  const child = tools.spawn({ ...spawnInput(), required: false }); await Promise.resolve();
  const before = f.composition.lifecycle.recover(child.reservationId), fence = toRuntimeAttemptFence(before.runtime.attempt);
  const hostCompletion = f.store.trackHostAttemptCompletion({ runId: child.childRunId, ...fence }, release.promise);
  void hostCompletion.catch(() => undefined);
  const abortController = new AbortController();
  f.active.add(child.childRunId, { ...fence, abortController, streamEnvelope() {}, completion: release.promise });
  f.active.requestStop(child.childRunId, { kind: "runtime_failure", code: "hard_timeout", reason: "original timeout" });
  await assert.rejects(f.registry.closeParent({ store: f.store, runId: f.run.id, sourceFence: f.fence,
    outcome: "succeeded", signal: new AbortController().signal }), { status: "blocked" });
  assert.equal(f.composition.lifecycle.getRunTerminalIntent(fence.attemptId), undefined);
  assert.equal(f.active.getStopIntent(child.childRunId).kind, "runtime_failure");
  release.resolve(); await hostCompletion;
});

test("optional close with a foreign live child blocks without stopping it, refunding or redispatching", async t => {
  const f = await fixture(t), tools = f.bind(); liveParent(f);
  const child = tools.spawn({ ...spawnInput(), required: false }); await f.registry.settle();
  const before = f.composition.lifecycle.recover(child.reservationId), abortController = new AbortController();
  f.active.add(child.childRunId, { ...toRuntimeAttemptFence(before.runtime.attempt), attemptId: "replacement-attempt",
    abortController, streamEnvelope() {}, completion: Promise.resolve() });
  await assert.rejects(f.registry.closeParent({ store: f.store, runId: f.run.id, sourceFence: f.fence,
    outcome: "succeeded", signal: new AbortController().signal }), { status: "blocked" });
  assert.equal(abortController.signal.aborted, false);
  assert.equal(f.composition.lifecycle.recover(child.reservationId).runtime.reservation.state, "reserved");
  assert.equal(f.registry.recoverStore(f.store).dispatched, 0);
  assert.equal(f.calls.length, 1);
});

test("claimed optional with no live original completion is blocked and keeps its allocation", async t => {
  const f = await fixture(t), tools = f.bind(); liveParent(f);
  const child = tools.spawn({ ...spawnInput(), required: false }); await f.registry.settle();
  await assert.rejects(f.registry.closeParent({ store: f.store, runId: f.run.id, sourceFence: f.fence,
    outcome: "cancelled", signal: new AbortController().signal }), { status: "blocked" });
  assert.equal(f.composition.lifecycle.recover(child.reservationId).kind, "dispatch_outcome_unknown");
  assert.equal(f.composition.lifecycle.recover(child.reservationId).runtime.reservation.state, "reserved");
  assert.throws(() => tools.resume({ reservationId: child.reservationId, expectedStepRevision: child.stepRevision,
    callId: "forbidden-resume" }), { code: "delegation.admission_closed" });
});

for (const recoveryAuthority of [false, true]) test(`bounded original recovery only dispatches unclaimed children with live authority (${recoveryAuthority})`, async t => {
  const f = await fixture(t, { recoveryAuthority });
  const queued = f.composition.lifecycle.spawn({ parentRunId: f.run.id, sourceFence: f.fence,
    ...spawnInput("queued"), now: at() });
  const claimed = f.bind().spawn(spawnInput("already-claimed"));
  await f.registry.settle();
  const before = f.calls.length, result = f.registry.recoverStore(f.store);
  assert.equal(result.status, "scanned"); assert.equal(result.scanned, 2);
  assert.equal(result.dispatched, recoveryAuthority ? 1 : 0);
  assert.equal(result.retained, recoveryAuthority ? 1 : 2);
  await f.registry.settle();
  assert.equal(f.calls.length, before + (recoveryAuthority ? 1 : 0));
  assert.equal(f.composition.lifecycle.recover(claimed.reservationId).runtime.workUnit.attemptCount, 1);
  assert.equal(f.composition.lifecycle.recover(queued.reservation.id).kind,
    recoveryAuthority ? "dispatch_outcome_unknown" : "queued_unclaimed");
});

test("reopened SQLite restores the exact parent before dispatching each queued child once", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const queued = f.composition.lifecycle.spawn({ parentRunId: f.run.id, sourceFence: f.fence,
    ...spawnInput("restart-queued"), now: at() });
  const paths = f.store.paths;
  f.registry.stopAdmission(); await f.registry.settle(); f.supervisor.releaseAll(); f.store.close();

  const supervisor = new RuntimeSupervisor(f.config), active = new ActiveRunRegistry();
  const runners = createRunnerRegistry([{ id: "pi", displayName: "Restart registry fixture", status: "enabled", adapter: new PiRunnerAdapter() }]);
  const keyRef = "env:ISOLATED_DELEGATION_REGISTRY_KEY";
  const resolver = { status: ref => ({ ref, kind: "env", configured: ref === keyRef }),
    resolve: ref => ({ ref, configured: ref === keyRef, value: ref === keyRef ? "synthetic-no-network-key" : undefined,
      status: { ref, kind: "env", configured: ref === keyRef } }) };
  const composition = createOriginalDelegationStoreComposition({ supervisor, runnerRegistry: runners, secretResolver: resolver,
    delegatedDispatchAuthority: createDelegatedRunDispatchAuthority() });
  const store = new SqliteRunStore({ cwd: f.cwd, paths, delegationHostBinding: composition.binding });
  composition.bindExactStore(store);
  const calls = [];
  const registry = createDelegationRuntimeRegistry({ supervisor, activeRuns: active,
    isWorkflowSelected: createDelegationWorkflowSelector([f.workflow.id]),
    assertRecoveryParentCurrent: input => assertDelegationRecoveryParentCurrent({ ...input, activeRuns: active }),
    executeDelegatedRunRequest: async input => { calls.push(input); return input.request.parentRunId; } });
  registry.registerStore(store, composition.lifecycle);
  try {
    // Runtime startup correctly marks the old process Attempt lost. Recover the
    // parent Work Unit first with a monotonic Attempt, exactly as the daemon
    // continuation coordinator does before delegation discovery.
    const parentRecoveredAt = at();
    assert.equal(store.transitionWorkUnitStatus({ workUnitId: f.fence.workUnitId, expectedStatus: "stale",
      event: "retry", actor: "system", now: parentRecoveredAt, endedAt: null, errorCode: null, errorMessage: null }).ok, true);
    const parentAttempt = store.createWorkUnitAttempt({ workUnitId: f.fence.workUnitId, attemptNumber: 2,
      runtimeInstanceId: supervisor.getRuntime(f.cwd, store).runtimeInstanceId, runnerId: "pi", effectiveRunnerId: "pi",
      status: "created", now: parentRecoveredAt });
    const parentFence = toRuntimeAttemptFence(parentAttempt);
    assert.equal(store.transitionWorkUnitStatus({ ...parentFence, activeAttemptId: parentAttempt.id, expectedStatus: "queued",
      event: "claim", actor: "system", now: parentRecoveredAt }).ok, true);
    assert.equal(store.transitionWorkUnitStatus({ ...parentFence, expectedStatus: "claimed", event: "runner_started",
      actor: "runner", now: parentRecoveredAt, startedAt: parentRecoveredAt }).ok, true);
    assert.ok(store.updateWorkUnitAttemptStatus({ ...parentFence, status: "started", now: parentRecoveredAt,
      startedAt: parentRecoveredAt }));
    const recoveredRun = store.getRun(f.run.id), recoveredThread = store.getLingThread(recoveredRun.threadId);
    const recoveredProvider = resolveProviderForRun(store,
      { providerPresetId: recoveredRun.providerPresetId, skipProviderPreflight: true }, resolver);
    const recoveredPolicy = applyConversationModeToEffectiveRunPolicySnapshot(resolveSessionRunPolicy({
      workspacePolicy: store.getApprovalPolicy(), authorizationMode: recoveredRun.requestSnapshot.authorizationMode,
      workspaceAccessMode: recoveredRun.requestSnapshot.workspaceAccessMode, channelBoundPath: f.cwd,
    }).snapshot, recoveredThread.conversationMode.mode);
    admitOriginalDelegationRoot({ store, run: recoveredRun, attempt: store.getWorkUnitAttempt(parentAttempt.id),
      originalProvider: recoveredProvider, request: recoveredRun.requestSnapshot, effectivePolicySnapshot: recoveredPolicy,
      runtimeTools: ["read"], now: parentRecoveredAt });

    // A foreign/replaced process entry is observation-only and cannot claim the durable child.
    active.add(f.run.id, { abortController: new AbortController(), streamEnvelope() {}, ...parentFence, fencingToken: "foreign" });
    const foreign = registry.recoverStore(store);
    assert.equal(foreign.dispatched, 0); assert.equal(foreign.retained, 1); assert.equal(calls.length, 0);

    // Restore the exact parent process entry first; only then may startup discovery claim and dispatch.
    active.delete(f.run.id);
    active.add(f.run.id, { abortController: new AbortController(), streamEnvelope() {}, ...parentFence });
    const recovered = registry.recoverStore(store);
    assert.equal(recovered.dispatched, 1, JSON.stringify({ recovered, run: store.getRun(f.run.id),
      unit: store.getWorkUnit(parentFence.workUnitId), attempt: store.getWorkUnitAttempt(parentFence.attemptId),
      child: composition.lifecycle.recover(queued.reservation.id) }));
    assert.equal(recovered.retained, 0);
    await registry.settle();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].request.parentRunId, f.run.id);
    assert.equal(calls[0].request.task.prompt, "Read the isolated child objective.");
    assert.equal(composition.lifecycle.recover(queued.reservation.id).runtime.workUnit.attemptCount, 1);

    // Immediate and periodic sweeps can reobserve the row, but can never redispatch its claimed Attempt.
    assert.equal(registry.recoverStore(store).dispatched, 0);
    await delay(5_200);
    await registry.settle();
    assert.equal(calls.length, 1);
    assert.equal(composition.lifecycle.recover(queued.reservation.id).runtime.workUnit.attemptCount, 1);
  } finally {
    registry.stopAdmission(); await registry.abortOwned().catch(() => undefined); await registry.settle().catch(() => undefined);
    supervisor.releaseAll(); store.close();
  }
});
