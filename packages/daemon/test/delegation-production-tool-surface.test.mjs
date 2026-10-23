import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteRunStore, resolveStoragePaths, toRuntimeAttemptFence } from "@ling-stack/core";
import { DELEGATION_TOOL_NAMES } from "@ling-stack/runner-pi";
import { resolveConfig } from "../dist/config.js";
import { createDelegatedRunDispatchAuthority } from "../dist/features/harness/delegations/delegated-run-dispatch.js";
import { createDelegationRuntimeRegistry, createDelegationWorkflowSelector } from "../dist/features/harness/delegations/runtime-registry.js";
import { createOriginalDelegationStoreComposition } from "../dist/features/harness/delegations/store-composition.js";
import { createDetachedRunExecutionSink, executeDelegatedRunRequest, executeRunRequest } from "../dist/features/runs/orchestrator.js";
import { ActiveRunRegistry } from "../dist/runtime/active-runs.js";
import { createRunnerRegistry } from "../dist/runtime/runners.js";
import { patchWorkspaceRuntimeSettings } from "../dist/runtime/runner-settings.js";
import { RunStoreRegistry } from "../dist/runtime/store-registry.js";
import { RuntimeSupervisor } from "../dist/runtime/supervisor.js";
import { ToolFreePiRunner } from "./support/tool-free-pi-runner.mjs";
import { ControlPlaneEventHub } from "../dist/features/control-plane/events.js";

async function fixture(t, selected, behavior = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-delegation-production-surface-"));
  const observed = { calls: [], errors: [], delegated: [], toolResults: [], events: [], terminalNotifications: [] };
  const controlPlaneEvents = new ControlPlaneEventHub();
  class FixtureRunner extends ToolFreePiRunner {
    async runTask(options) {
      observed.calls.push(options);
      const spawn = behavior.spawns?.[options.task.prompt];
      const invokeSpawn = async () => {
        if (!spawn || !options.onDelegationToolCall) return;
        const request = { toolName: "spawn_agent", toolCallId: spawn.toolCallId,
          input: { objective: spawn.objective, required: spawn.required ?? true,
            requestedBudget: { tokenBudget: spawn.tokenBudget ?? 50_000 } } };
        observed.toolResults.push(await options.onDelegationToolCall(request));
        if (spawn.replay) observed.toolResults.push(await options.onDelegationToolCall(request));
      };
      if (options.onPreparedInputAccepted && spawn) {
        const accept = options.onPreparedInputAccepted;
        options = { ...options, async onPreparedInputAccepted(receipt, signal) {
          await accept(receipt, signal);
          await invokeSpawn();
        } };
      } else {
        await invokeSpawn();
      }
      if (behavior.beforeSdkSettlement) {
        const settled = options.onTaskSettledBoundary, source = options;
        options = { ...options, async onTaskSettledBoundary(view) {
          // Hold the actual SDK window, not a returned adapter result. The
          // original Host observes fan-in/optional stop inside this callback;
          // a post-run hook would wait after that observation already happened.
          await behavior.beforeSdkSettlement(source, view);
          return settled?.(view);
        } };
      }
      return super.runTask(options);
    }
  }
  const adapter = new FixtureRunner();
  adapter.fixtureUsage = { inputTokens: 10, outputTokens: 10 };
  const runners = createRunnerRegistry([{ id: "pi", displayName: "Delegation surface fixture", status: "enabled", adapter }]);
  const config = resolveConfig({ defaultWorkspaceCwd: cwd, harness: {
    continuations: { mode: "enforce" }, toolBroker: { mode: "enforce" },
    delegations: { mode: "enforce", rootBudget: { tokenBudget: 100_000, wallTimeBudgetMs: 120_000 } },
  } });
  const supervisor = new RuntimeSupervisor(config), active = new ActiveRunRegistry();
  const keyRef = "env:DELEGATION_PRODUCTION_SURFACE_KEY";
  const resolver = { status: ref => ({ ref, kind: "env", configured: ref === keyRef }),
    resolve: ref => ({ ref, configured: ref === keyRef, value: ref === keyRef ? "synthetic-no-network-key" : undefined,
      status: { ref, kind: "env", configured: ref === keyRef } }) };
  const composition = createOriginalDelegationStoreComposition({ supervisor, runnerRegistry: runners, secretResolver: resolver,
    delegatedDispatchAuthority: createDelegatedRunDispatchAuthority() });
  const paths = resolveStoragePaths(cwd, { homeDir: join(cwd, "fixture-home"), env: {}, workspaceStateLocation: "repo-local" }).workspace;
  const store = new SqliteRunStore({ cwd, paths, delegationHostBinding: composition.binding });
  composition.bindExactStore(store);
  const stores = new RunStoreRegistry(() => store, { recoverOnOpen: false });
  assert.equal(stores.getStore(cwd), store);
  const now = new Date().toISOString();
  patchWorkspaceRuntimeSettings(store, runners, { defaultRunnerId: "pi", allowedRunnerIds: ["pi"] }, now);
  const preset = store.createProviderPreset({ kind: "openai-compatible", displayName: "Delegation surface fixture",
    providerId: "delegation-surface-fixture", model: "fixture-model", api: "openai-completions",
    baseUrl: "https://fixture.invalid/v1", apiKeyRef: keyRef, reasoning: false, contextWindow: 16_000,
    maxTokens: 1_000, capabilities: ["chat", "tool_call"], enabled: true }, now);
  store.recordProviderCheckResult(preset.id, { ok: true, code: "ready", message: "Synthetic ready", checkedAt: now });
  const channel = store.createChannel({ name: "Delegation surface", boundPath: cwd, allowedTools: ["read"] }, now);
  store.replaceTeammateChannelMemberships("teammate_builtin_engineer", [{ channelId: channel.id }], now);
  const prompt = "Inspect the selected workflow.";
  const workflow = store.createChannelWorkflow({ channelId: channel.id, title: "Selected workflow", objective: prompt,
    createdBy: "local-user", status: "ready" }, now);
  config.harness.delegations.selectedWorkflowIds = Object.freeze(selected ? [workflow.id] : []);
  const createdStep = store.createChannelWorkflowStep({ workflowId: workflow.id, title: "Parent", prompt,
    toParticipantId: "teammate_builtin_engineer", toParticipantLabel: "Engineer" }, now);
  const lease = store.acquireResourceLease({ workspaceId: channel.workspaceId, resourceType: "workflow_step",
    resourceKey: createdStep.id, ownerType: "workflow_step", ownerId: createdStep.id, acquiredAt: now,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  assert.ok(lease);
  const begun = store.beginChannelWorkflowStepStart({ workflowStepId: createdStep.id,
    expected: store.getChannelWorkflowStep(createdStep.id), leaseId: lease.id,
    task: { channelId: channel.id, assigneeTeammateId: "teammate_builtin_engineer", title: "Parent task", prompt }, now });
  assert.equal(begun.status, "begun", JSON.stringify(begun));
  const task = begun.task, step = store.getChannelWorkflowStep(createdStep.id);
  const thread = store.createLingThread({ kind: "task", channelId: channel.id, taskId: task.id,
    title: task.title, objective: task.prompt }, now);
  const turn = store.createLingTurn({ threadId: thread.id, kind: "initial_request", taskId: task.id,
    channelId: channel.id, title: task.title, userInstruction: task.prompt, createdByActor: "local-user" }, now);
  const runtime = createDelegationRuntimeRegistry({ supervisor, activeRuns: active,
    onRunTerminal: input => observed.terminalNotifications.push({ source: "intent", runId: input.run.id }),
    isWorkflowSelected: createDelegationWorkflowSelector(selected ? [workflow.id] : []),
    executeDelegatedRunRequest: async input => {
      observed.delegated.push(input);
      return behavior.dispatchChildren
        ? executeDelegatedRunRequest(input, { ...createDetachedRunExecutionSink(),
            writeEvent: (type, data) => observed.events.push({ type, data, delegated: true }),
            writeError: (status, body) => observed.errors.push({ status, body, delegated: true }) },
          runners, stores, active, supervisor, resolver, {}, { controlPlaneEvents })
        : input.request.parentRunId;
    } });
  runtime.registerStore(store, composition.lifecycle);
  const request = { cwd, workspaceCwd: cwd, threadId: thread.id, turnId: turn.id, workflowStepId: step.id,
    workflowStartOwner: begun.owner,
    teammateId: "teammate_builtin_engineer",
    task: { id: task.id, channelId: channel.id, title: task.title, prompt: task.prompt }, providerPresetId: preset.id,
    runnerId: "pi", tools: ["read"], authorizationMode: "smart", workspaceAccessMode: "workspace_write",
    createdByActor: "local-user" };
  const dispatch = () => executeRunRequest(request, { ...createDetachedRunExecutionSink(),
    writeEvent: (type, data) => observed.events.push({ type, data }),
    writeError: (_status, body) => observed.errors.push(body) }, runners, stores, active, supervisor, resolver, {},
    { controlPlaneEvents, afterRunTerminal: terminalRun => { observed.terminalNotifications.push({ source: "ordinary", runId: terminalRun.id }); } });
  t.after(async () => {
    runtime.stopAdmission(); await runtime.abortOwned().catch(() => undefined); await runtime.settle().catch(() => undefined);
    supervisor.releaseAll(); stores.closeAll(); await rm(cwd, { recursive: true, force: true });
  });
  return { dispatch, observed, store, channel, workflow, step, runtime, active, config, supervisor, lifecycle: composition.lifecycle };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

for (const outcome of ["succeeded", "failed", "cancelled"]) test(`production parent ${outcome} stops optional exact lifetime before terminal and rejects late spawn`, { timeout: 15_000 }, async t => {
  const parentPrompt = "Inspect the selected workflow.", childObjective = "Hold the optional child after measured SDK completion.";
  const childModel = deferred(), stopped = deferred(), drain = deferred(); t.after(() => drain.resolve());
  const f = await fixture(t, true, { dispatchChildren: true, spawns: {
    [parentPrompt]: { toolCallId: "optional-child", objective: childObjective, required: false },
  }, async beforeSdkSettlement(options) {
    if (options.task.prompt === childObjective) {
      childModel.resolve(options);
      await new Promise(resolve => options.signal.aborted ? resolve() : options.signal.addEventListener("abort", resolve, { once: true }));
      stopped.resolve(options);
      await drain.promise;
      options.signal.throwIfAborted();
      return;
    }
    await childModel.promise;
    if (outcome === "failed") throw new Error("controlled parent failure after SDK completion");
    if (outcome === "cancelled") {
      f.active.requestStop(options.runId, { kind: "user_cancel", actor: "local-user", reason: "controlled parent cancel" });
      options.signal.throwIfAborted();
    }
  } });
  let parentReturned = false;
  const pending = f.dispatch().then(id => { parentReturned = true; return id; }); void pending.catch(() => {});
  const childOptions = await stopped.promise;
  const parent = f.store.listRuns().find(run => !run.parentRunId), child = f.store.getRun(childOptions.runId);
  assert.equal(parentReturned, false);
  assert.equal(f.store.getWorkUnit(parent.workUnitId).status, "running");
  assert.equal(f.active.get(child.id).stopIntent.kind, "workflow_cancel");
  const parentFence = toRuntimeAttemptFence(f.store.getWorkUnitAttempt(f.store.getWorkUnit(parent.workUnitId).activeAttemptId));
  assert.equal(f.store.isCurrentRunExecutionOwner(parent.id, parentFence, true), true);
  const reservation = f.store.getDelegationCompletionEvidence({ rootRunIds: [parent.id] }).steps[0].reservation;
  assert.equal(reservation.state, "reserved", "stop request cannot release the allocation before real drain");
  for (const options of [f.observed.calls.find(call => call.task.prompt === parentPrompt), childOptions]) {
    await assert.rejects(options.onDelegationToolCall({ toolName: "spawn_agent", toolCallId: `late-${options.runId}`,
      input: { objective: "Must never be admitted after parent return.", required: false, requestedBudget: { tokenBudget: 100 } } }),
    { code: "delegation.admission_closed" });
  }
  drain.resolve();
  const parentId = await pending; await f.runtime.settle();
  assert.equal(f.store.getRun(parentId).status, outcome);
  const evidence = f.store.getDelegationCompletionEvidence({ rootRunIds: [parentId] });
  assert.deepEqual(evidence.issues, []); assert.equal(evidence.status, "satisfied");
  assert.equal(evidence.steps[0].step.state, "cancelled");
  assert.equal(evidence.steps[0].quiescence, "verified");
  assert.equal(evidence.steps[0].reservation.state, "settled");
  assert.equal(evidence.steps[0].results[0].payload.outcome, "cancelled");
  assert.equal(f.observed.calls.length, 2);
  assert.deepEqual(f.observed.terminalNotifications.filter(item => item.runId === parentId),
    [{ source: outcome === "succeeded" ? "ordinary" : "intent", runId: parentId }], "one terminal writer produces one root follow-up");
  assert.equal(f.store.database.prepare("SELECT COUNT(*) n FROM control_plane_events WHERE entity_type='run' AND entity_id=? AND action IN ('run.completed','run.cancelled')").get(parentId).n, 1);
});

test("production stop_with_parent freezes a deep optional subtree without erasing its required grandchild outcome", { timeout: 15_000 }, async t => {
  const parentPrompt = "Inspect the selected workflow.", childObjective = "Optional parent of required work.", grandchildObjective = "Required grandchild.";
  const childModel = deferred(), grandchildModel = deferred(), childStopped = deferred(), grandchildStopped = deferred(), drain = deferred();
  t.after(() => drain.resolve());
  const f = await fixture(t, true, { dispatchChildren: true, spawns: {
    [parentPrompt]: { toolCallId: "deep-optional", objective: childObjective, required: false },
    [childObjective]: { toolCallId: "deep-required", objective: grandchildObjective, tokenBudget: 20_000 },
  }, async beforeSdkSettlement(options) {
    if (options.task.prompt === parentPrompt) {
      await Promise.all([childModel.promise, grandchildModel.promise]);
      return;
    }
    const isChild = options.task.prompt === childObjective;
    (isChild ? childModel : grandchildModel).resolve(options);
    await new Promise(resolve => options.signal.aborted ? resolve() : options.signal.addEventListener("abort", resolve, { once: true }));
    (isChild ? childStopped : grandchildStopped).resolve(options);
    await drain.promise; options.signal.throwIfAborted();
  } });
  const pending = f.dispatch(); void pending.catch(() => {});
  const [child, grandchild] = await Promise.all([childStopped.promise, grandchildStopped.promise]);
  for (const options of [child, grandchild]) {
    assert.equal(f.active.get(options.runId).stopIntent.kind, "workflow_cancel");
    await assert.rejects(options.onDelegationToolCall({ toolName: "spawn_agent", toolCallId: `late-deep-${options.runId}`,
      input: { objective: "No late nested work.", required: false, requestedBudget: { tokenBudget: 100 } } }),
    { code: "delegation.admission_closed" });
  }
  assert.equal(f.store.listRuns().find(run => !run.parentRunId).status, "running");
  drain.resolve(); const parentId = await pending; await f.runtime.settle();
  const evidence = f.store.getDelegationCompletionEvidence({ rootRunIds: [parentId] });
  assert.deepEqual(evidence.issues, []);
  assert.equal(evidence.status, "cancelled", "a required grandchild cancellation cannot be hidden by its optional ancestor");
  assert.equal(f.store.getRun(parentId).status, "failed", JSON.stringify({ errors: f.observed.errors,
    events: f.observed.events.filter(event => event.type.startsWith("delegation")) }));
  assert.deepEqual(evidence.steps.map(read => read.step.required).sort(), [false, true]);
  assert.ok(evidence.steps.every(read => read.step.state === "cancelled" && read.quiescence === "verified"
    && read.reservation.state === "settled" && read.results.length === 1));
  assert.equal(f.observed.calls.length, 3);
});

for (const featureOff of [false, true]) for (const outcome of ["failed", "cancelled"]) test(`${outcome}-parent stop observation timeout retains custody then durably closes after late drain${featureOff ? " with producer feature off" : ""}`, { timeout: 15_000 }, async t => {
  const parentPrompt = "Inspect the selected workflow.", childObjective = "Hold original stop drain beyond the observation deadline.";
  const childModel = deferred(), stopped = deferred(), drain = deferred(); t.after(() => drain.resolve());
  const f = await fixture(t, true, { dispatchChildren: true, spawns: {
    [parentPrompt]: { toolCallId: "unverified-stop", objective: childObjective, required: false },
  }, async beforeSdkSettlement(options) {
    if (options.task.prompt === parentPrompt) {
      await childModel.promise;
      if (outcome === "cancelled") {
        f.active.requestStop(options.runId, { kind: "user_cancel", actor: "local-user", reason: "controlled parent cancel" });
        options.signal.throwIfAborted();
      }
      throw new Error("controlled failure requiring stop");
    }
    childModel.resolve();
    await new Promise(resolve => options.signal.aborted ? resolve() : options.signal.addEventListener("abort", resolve, { once: true }));
    stopped.resolve(); await drain.promise; options.signal.throwIfAborted();
  } });
  const pending = f.dispatch(); void pending.catch(() => {}); await stopped.promise;
  const parentId = await pending, parent = f.store.getRun(parentId), unit = f.store.getWorkUnit(parent.workUnitId);
  const attempt = f.store.getWorkUnitAttempt(unit.activeAttemptId), sourceFence = toRuntimeAttemptFence(attempt);
  assert.equal(parent.status, "running"); assert.equal(unit.status, "running"); assert.equal(attempt.status, "started");
  assert.equal(f.store.isCurrentRunExecutionOwner(parentId, sourceFence, true), true);
  assert.ok(f.store.listResourceLeases({ attemptId: attempt.id, status: "active" }).length > 0);
  assert.ok(f.store.listRuntimeSemaphoreSlots({ workUnitId: unit.id, status: "active" }).length > 0);
  const evidence = f.store.getDelegationCompletionEvidence({ rootRunIds: [parentId] });
  assert.equal(evidence.status, "pending"); assert.equal(evidence.steps[0].reservation.state, "reserved");
  assert.equal(evidence.steps[0].results.length, 0);
  assert.ok(f.observed.events.some(event => event.type === "delegation_blocked" && event.data.status === "blocked"));
  if (featureOff) {
    f.config.harness.delegations.mode = "off";
    assert.equal(f.runtime.isEnabled(), false);
  }
  drain.resolve(); await f.runtime.settle();
  assert.equal(f.store.getRun(parentId).status, outcome, "the original durable terminal intent is completed without replaying its model");
  assert.equal(f.store.getWorkUnit(unit.id).status, outcome);
  assert.equal(f.store.getWorkUnitAttempt(attempt.id).status, outcome);
  assert.equal(f.store.isCurrentRunExecutionOwner(parentId, sourceFence, true), false);
  assert.equal(f.observed.calls.length, 2);
  if (featureOff) {
    // A reconstructed registered Store callback may observe the committed
    // original intent even when new dynamic producers are disabled. No timer,
    // Runner or new dispatch is enabled by this cleanup-only read/replay.
    assert.equal(f.runtime.recoverStore(f.store).status, "disabled");
    await f.runtime.settle();
    assert.equal(f.store.getRun(parentId).status, outcome);
    assert.equal(f.observed.calls.length, 2);
  }
});

test("daemon shutdown persists a started child's interrupt before abort and commits its physical drain", { timeout: 15_000 }, async t => {
  const parentPrompt = "Inspect the selected workflow.";
  const childObjective = "Hold a started delegated child until daemon shutdown.";
  const childStarted = deferred(), childSawAbort = deferred(), childDrain = deferred(), parentDrain = deferred();
  t.after(() => { childDrain.resolve(); parentDrain.resolve(); });
  let f;
  f = await fixture(t, true, { dispatchChildren: true, spawns: {
    [parentPrompt]: { toolCallId: "shutdown-started-child", objective: childObjective, required: false },
  }, async beforeSdkSettlement(options) {
    if (options.task.prompt === parentPrompt) {
      await parentDrain.promise;
      return;
    }
    childStarted.resolve(options);
    await new Promise(resolve => options.signal.aborted ? resolve() : options.signal.addEventListener("abort", resolve, { once: true }));
    const run = f.store.getRun(options.runId), unit = f.store.getWorkUnit(run.workUnitId);
    const attempt = f.store.getWorkUnitAttempt(unit.activeAttemptId);
    const evidence = f.store.getDelegationCompletionEvidence({ rootRunIds: [run.parentRunId] });
    const read = evidence.steps.find(item => item.reservation?.childRunId === run.id);
    childSawAbort.resolve({ run, unit, attempt, read,
      controlCount: f.store.database.prepare(`SELECT COUNT(*) AS count FROM delegation_messages m
        JOIN artifacts a ON a.id=m.body_artifact_id
        WHERE m.delegation_step_id=? AND m.kind='control'
          AND json_extract(a.sealed_payload_json,'$.kind')='delegation.interrupt.v1'`).get(read.step.id).count });
    await childDrain.promise;
    options.signal.throwIfAborted();
  } });

  const parentCompletion = f.dispatch(); void parentCompletion.catch(() => {});
  const childOptions = await childStarted.promise;
  const childBefore = f.store.getRun(childOptions.runId), unitBefore = f.store.getWorkUnit(childBefore.workUnitId);
  const attemptBefore = f.store.getWorkUnitAttempt(unitBefore.activeAttemptId);
  const stepBefore = f.store.getDelegationCompletionEvidence({ rootRunIds: [childBefore.parentRunId] }).steps
    .find(item => item.reservation?.childRunId === childBefore.id);
  assert.equal(stepBefore.step.state, "running");
  assert.equal(unitBefore.status, "running");
  assert.equal(attemptBefore.status, "started");

  f.runtime.stopAdmission();
  await f.runtime.abortOwned();
  const atAbort = await childSawAbort.promise;
  assert.equal(f.active.get(childOptions.runId).stopIntent.kind, "runtime_suspend");
  assert.equal(atAbort.read.step.state, "interrupting",
    "the durable delegation control fact must commit before the process receives abort");
  assert.equal(atAbort.unit.status, "cancelling");
  assert.equal(atAbort.attempt.status, "cancelling");
  assert.equal(atAbort.controlCount, 1);

  childDrain.resolve();
  await f.runtime.settle();
  const childAfter = f.store.getRun(childOptions.runId), unitAfter = f.store.getWorkUnit(childAfter.workUnitId);
  const attemptAfter = f.store.getWorkUnitAttempt(unitAfter.activeAttemptId);
  const stepAfter = f.store.getDelegationCompletionEvidence({ rootRunIds: [childAfter.parentRunId] }).steps
    .find(item => item.reservation?.childRunId === childAfter.id);
  assert.equal(stepAfter.step.state, "interrupted");
  assert.equal(unitAfter.status, "cancelled");
  assert.equal(attemptAfter.status, "cancelled");
  assert.equal(attemptAfter.errorCode, "delegation_interrupted");
  assert.ok(attemptAfter.endedAt);
  assert.equal(f.store.listResourceLeases({ workUnitId: unitAfter.id, attemptId: attemptAfter.id, status: "active" }).length, 0);
  assert.equal(f.store.listRuntimeSemaphoreSlots({ workUnitId: unitAfter.id, status: "active", limit: 10_000 })
    .filter(slot => slot.attemptId === attemptAfter.id).length, 0);

  parentDrain.resolve();
  await parentCompletion;
});

for (const selected of [false, true]) test(`production orchestrator ${selected ? "exposes" : "withholds"} delegation only for a Host-selected workflow`, async t => {
  const f = await fixture(t, selected);
  const runId = await f.dispatch();
  assert.ok(runId, JSON.stringify({ errors: f.observed.errors, runs: f.store.listRuns().map(run => ({ id: run.id,
    channelId: run.channelId, workflowStepId: run.workflowStepId, workUnitId: run.workUnitId })),
  units: f.store.listWorkUnits({ limit: 10 }).map(unit => ({ id: unit.id, workspaceId: unit.workspaceId, linkedRunId: unit.linkedRunId })),
  channel: { id: f.channel.id, workspaceId: f.channel.workspaceId },
  workflow: { id: f.workflow.id, channelId: f.workflow.channelId, workspaceId: f.workflow.workspaceId },
  step: { id: f.step.id, channelId: f.step.channelId, workspaceId: f.step.workspaceId } }));
  assert.deepEqual(f.observed.errors, []);
  assert.equal(f.observed.calls.length, 1);
  const options = f.observed.calls[0];
  assert.equal(options.initialToolSurface.delegation, selected);
  assert.equal(typeof options.onDelegationToolCall === "function", selected);
  const names = options.preparedInput.tools.filter(tool => DELEGATION_TOOL_NAMES.includes(tool.name)).map(tool => tool.name);
  assert.deepEqual(names, selected ? DELEGATION_TOOL_NAMES : []);
  assert.equal(f.store.getRun(runId).requestSnapshot.runnerExecutionInput.input.initialToolSurface.delegation, selected);
  assert.equal(f.observed.delegated.length, 0);
});

test("production orchestrator spawn dispatches exactly once and response-loss replay reuses the child", async t => {
  const parentPrompt = "Inspect the selected workflow.", childObjective = "Inspect the delegated child.";
  const f = await fixture(t, true, { dispatchChildren: true,
    spawns: { [parentPrompt]: { toolCallId: "production-spawn", objective: childObjective, replay: true } } });
  const pending = f.dispatch();
  const parentRunId = await Promise.race([pending, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(JSON.stringify({ errors: f.observed.errors,
      calls: f.observed.calls.map(call => ({ task: call.task, runId: call.runId, attemptId: call.runnerAttemptId })),
      delegated: f.observed.delegated.map(call => call.request.task), toolResults: f.observed.toolResults,
      runs: f.store.listRuns().map(run => ({ id: run.id, parentRunId: run.parentRunId,
        status: run.status, errorMessage: run.errorMessage, summaryPath: run.summaryPath })),
      steps: f.store.database.prepare("SELECT id,state,child_run_id,revision,failure_code FROM delegation_steps").all(),
      attempts: f.store.database.prepare("SELECT id,work_unit_id,status,ended_at FROM work_unit_attempts").all(),
    }))), 5_000);
    timer.unref();
  })]);
  assert.ok(parentRunId, JSON.stringify(f.observed.errors));
  await f.runtime.settle();
  assert.deepEqual(f.observed.errors, []);
  assert.equal(f.observed.delegated.length, 1);
  assert.equal(f.observed.delegated[0].request.parentRunId, parentRunId);
  assert.equal(f.observed.delegated[0].request.task.prompt, childObjective);
  assert.equal(f.observed.toolResults.length, 2);
  assert.equal(f.observed.toolResults[0].childRunId, f.observed.toolResults[1].childRunId);
  assert.equal(f.observed.toolResults[0].reservationId, f.observed.toolResults[1].reservationId);
  const child = f.store.getRun(f.observed.toolResults[0].childRunId);
  const unit = f.store.getWorkUnit(child.workUnitId);
  assert.equal(unit.attemptCount, 1);
  assert.equal(f.observed.calls.length, 2, "only the parent and one child Runner execution may enter");
});

test("a production delegated child may spawn one nested child with the same root and narrowed lineage", async t => {
  const parentPrompt = "Inspect the selected workflow.", childObjective = "Inspect the delegated child.";
  const grandchildObjective = "Inspect the nested delegated child.";
  const f = await fixture(t, true, { dispatchChildren: true, spawns: {
    [parentPrompt]: { toolCallId: "production-child", objective: childObjective, tokenBudget: 50_000 },
    [childObjective]: { toolCallId: "production-grandchild", objective: grandchildObjective, tokenBudget: 20_000 },
  } });
  const pending = f.dispatch();
  const parentRunId = await Promise.race([pending, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(JSON.stringify({ errors: f.observed.errors,
      calls: f.observed.calls.map(call => ({ task: call.task, runId: call.runId, attemptId: call.runnerAttemptId })),
      delegated: f.observed.delegated.map(call => call.request.task), toolResults: f.observed.toolResults,
      runs: f.store.listRuns().map(run => ({ id: run.id, parentRunId: run.parentRunId,
        status: run.status, errorMessage: run.errorMessage, summaryPath: run.summaryPath })),
      steps: f.store.database.prepare("SELECT id,root_run_id,parent_run_id,parent_delegation_step_id,state,child_run_id,revision,failure_code,depth FROM delegation_steps ORDER BY depth").all(),
      attempts: f.store.database.prepare("SELECT id,work_unit_id,status,ended_at FROM work_unit_attempts").all(),
    }))), 5_000);
    timer.unref();
  })]);
  assert.ok(parentRunId, JSON.stringify(f.observed.errors));
  await f.runtime.settle();
  assert.deepEqual(f.observed.errors, []);
  assert.equal(f.observed.delegated.length, 2);
  assert.equal(f.observed.calls.length, 3, "parent, child and grandchild each execute exactly once");
  const steps = f.store.database.prepare(`SELECT root_run_id,parent_run_id,parent_delegation_step_id,child_run_id,depth,
    permission_snapshot_artifact_id,tool_allowlist_artifact_id FROM delegation_steps ORDER BY depth`).all();
  assert.equal(steps.length, 2);
  assert.equal(steps[0].root_run_id, parentRunId);
  assert.equal(steps[0].parent_run_id, parentRunId);
  assert.equal(steps[0].depth, 1);
  assert.equal(steps[1].root_run_id, parentRunId);
  assert.equal(steps[1].parent_run_id, steps[0].child_run_id);
  assert.equal(steps[1].parent_delegation_step_id !== null, true);
  assert.equal(steps[1].depth, 2);
  assert.notEqual(steps[1].permission_snapshot_artifact_id, steps[0].permission_snapshot_artifact_id);
  assert.notEqual(steps[1].tool_allowlist_artifact_id, steps[0].tool_allowlist_artifact_id);
});
