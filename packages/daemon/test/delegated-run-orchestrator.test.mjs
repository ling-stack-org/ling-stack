import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_WORKSPACE_ID, SqliteRunStore, applyConversationModeToEffectiveRunPolicySnapshot, captureRunProgressCheckpointLineage,
  resolveSessionRunPolicy, resolveStoragePaths, toRuntimeAttemptFence,
} from "@ling-stack/core";
import { readPreparedPiInput } from "@ling-stack/runner-pi";
import { stream } from "../../runner-pi/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js";
import { resolveConfig } from "../dist/config.js";
import { createHarnessFeatureSnapshot } from "../dist/features/harness/index.js";
import { executeRunRequest, createDetachedRunExecutionSink } from "../dist/features/runs/orchestrator.js";
import { resolveProviderForRun } from "../dist/features/runs/providers.js";
import { admitOriginalDelegationRoot, createOriginalDelegationStoreComposition } from "../dist/features/harness/delegations/store-composition.js";
import { createDelegatedRunDispatchAuthority, rebuildDelegatedRunRequest } from "../dist/features/harness/delegations/delegated-run-dispatch.js";
import { ActiveRunRegistry } from "../dist/runtime/active-runs.js";
import { createRunnerRegistry } from "../dist/runtime/runners.js";
import { patchWorkspaceRuntimeSettings } from "../dist/runtime/runner-settings.js";
import { RunStoreRegistry } from "../dist/runtime/store-registry.js";
import { RuntimeSupervisor } from "../dist/runtime/supervisor.js";
import { ToolFreePiRunner } from "./support/tool-free-pi-runner.mjs";

const KEY_REF = "env:DELEGATED_ORCHESTRATOR_FIXTURE_KEY";
const now = () => new Date().toISOString();
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

/**
 * Production Store custody, policy, SDK preparation/ACK, budget port and Host
 * drain. Only the Provider transport is deterministic and network-free. Root
 * state is seeded explicitly; child state may only be advanced by production
 * lifecycle/orchestrator code, never fixture status writes or DTO receipts.
 */
async function fixture(t, { mode = "sdk", channelBound = true } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-delegated-orchestrator-"));
  const accepted = deferred(), transportEntered = deferred(), releaseTransport = deferred();
  const checkpointEntered = deferred(), releaseCheckpoint = deferred();
  const observed = { preparations: [], calls: [], receipts: [], events: [], errors: [], terminals: [], transportCalls: 0, wireRequests: [] };
  const controls = {};
  class FixturePiRunner extends ToolFreePiRunner {
    fixtureUsage = { inputTokens: 100, outputTokens: 16 };
    async prepareTaskInput(options) {
      const prepared = await super.prepareTaskInput(options);
      observed.preparations.push(prepared);
      return prepared;
    }
    async runTask(options) {
      observed.calls.push(options);
      // Validate the persisted SDK input using the actual order-sensitive
      // reader; sorting nested JSON keys would break this fingerprint.
      assert.equal(readPreparedPiInput(options.preparedInput).fingerprint, observed.preparations[0].fingerprint);
      await controls.beforeRun?.(options);
      if (mode === "no-ack" || mode === "spurious-ready") {
        if (mode === "spurious-ready") {
          options.onEvent({ type: "run_start", taskId: options.task.id, cwd,
            provider: options.provider.provider, model: options.provider.model });
          options.onEvent({ type: "message_end", role: "assistant", text: "Ready; I will execute the task." });
        }
        return { taskId: options.task.id, events: [], messages: [{ role: "assistant", content: "Ready; I will execute the task." }] };
      }
      return super.runTask({ ...options,
        onTaskContinuationBoundary: async (boundary, modelView) => {
          const directive = await options.onTaskContinuationBoundary?.(boundary, modelView);
          if (mode === "checkpoint-sdk" && !options.ordinaryProgressRecovery && !options.compactionRecovery
            && boundary === "before_provider_request" && modelView?.some(message => message.role === "toolResult")) {
            // The production Host callback above has sealed the actual SDK
            // read result. Hold before another model request can be admitted.
            checkpointEntered.resolve();
            await releaseCheckpoint.promise;
          }
          return directive;
        },
        onPreparedInputAccepted: async (receipt, signal) => {
        observed.receipts.push(receipt);
        await options.onPreparedInputAccepted(receipt, signal);
        accepted.resolve(receipt);
        await controls.afterAck?.(options);
      } }, async () => {
        observed.transportCalls++;
        transportEntered.resolve();
        if (mode === "held-sdk") await releaseTransport.promise;
        return "Deterministic SDK child completed.";
      });
    }
    registerCustomProviderIfNeeded(runtime, provider) {
      super.registerCustomProviderIfNeeded(runtime, provider);
      if (mode !== "checkpoint-sdk") return;
      runtime.registerProvider(provider.provider, { api: "openai-completions", apiKey: "fixture-no-network",
        streamSimple: (model, context, options) => stream(model, context, { ...options, fetch: async (_url, init) => {
          const payload = JSON.parse(init.body);
          observed.wireRequests.push(payload);
          observed.transportCalls++;
          transportEntered.resolve();
          const hasResult = payload.messages.some(message => message.role === "tool" && message.tool_call_id === "delegated-prior-read");
          const delta = hasResult ? { content: "The restored SDK used the already completed read." }
            : { tool_calls: [{ index: 0, id: "delegated-prior-read", type: "function",
              function: { name: "read", arguments: JSON.stringify({ path: join(cwd, "read-once.txt") }) } }] };
          const records = [{ choices: [{ index: 0, delta, finish_reason: null }] },
            { choices: [{ index: 0, delta: {}, finish_reason: hasResult ? "stop" : "tool_calls" }] },
            { choices: [], usage: { prompt_tokens: 100, completion_tokens: 16, total_tokens: 116 } }];
          return new Response(records.map(record => `data: ${JSON.stringify(record)}\n\n`).join("") + "data: [DONE]\n\n",
            { headers: { "content-type": "text/event-stream" } });
        } }),
      });
    }
  }
  const adapter = new FixturePiRunner();
  const config = resolveConfig({ defaultWorkspaceCwd: cwd, harness: {
    continuations: { mode: "enforce" }, toolBroker: { mode: "enforce" },
    delegations: { mode: "enforce", rootBudget: { tokenBudget: 1_000_000, wallTimeBudgetMs: 120_000 } },
  } });
  const supervisor = new RuntimeSupervisor(config);
  const runners = createRunnerRegistry([{ id: "pi", displayName: "Actual SDK fixture", status: "enabled", adapter }]);
  const resolver = {
    status: ref => ({ ref, kind: "env", configured: ref === KEY_REF }),
    resolve: ref => ({ ref, configured: ref === KEY_REF, value: ref === KEY_REF ? "synthetic-no-network-key" : undefined,
      status: { ref, kind: "env", configured: ref === KEY_REF } }),
  };
  const composition = createOriginalDelegationStoreComposition({ supervisor, runnerRegistry: runners, secretResolver: resolver,
    delegatedDispatchAuthority: createDelegatedRunDispatchAuthority() });
  const paths = resolveStoragePaths(cwd, { homeDir: join(cwd, "fixture-home"), env: {}, workspaceStateLocation: "repo-local" }).workspace;
  const store = new SqliteRunStore({ cwd, paths, delegationHostBinding: composition.binding });
  composition.bindExactStore(store);
  const registry = new RunStoreRegistry(() => store, { recoverOnOpen: false });
  assert.equal(registry.getStore(cwd), store);
  const active = new ActiveRunRegistry();
  const runtime = supervisor.getRuntime(cwd, store), createdAt = now();
  t.after(async () => {
    releaseTransport.resolve();
    releaseCheckpoint.resolve();
    supervisor.releaseAll();
    registry.closeAll();
    await rm(cwd, { recursive: true, force: true });
  });
  patchWorkspaceRuntimeSettings(store, runners, { defaultRunnerId: "pi", allowedRunnerIds: ["pi"] }, createdAt);
  const preset = store.createProviderPreset({ kind: "openai-compatible", displayName: "Delegated SDK fixture",
    providerId: "delegated-orchestrator-fixture", model: "fixture-model", api: "openai-completions",
    baseUrl: "https://delegation.invalid/v1", apiKeyRef: KEY_REF, authHeader: false, reasoning: false,
    contextWindow: 65_536, maxTokens: 4096, capabilities: ["chat"], enabled: true }, createdAt);
  store.recordProviderCheckResult(preset.id, { ok: true, code: "ready", message: "Deterministic fixture ready", checkedAt: createdAt });
  const provider = resolveProviderForRun(store, { providerPresetId: preset.id }, resolver);
  const channel = channelBound ? store.createChannel({ name: "Delegation boundary", boundPath: cwd }, createdAt) : undefined;
  const task = channel ? store.createTask({ channelId: channel.id, title: "Parent task", prompt: "Parent frozen objective." }, createdAt)
    : { id: "inline-parent", title: "Parent task", prompt: "Parent frozen objective." };
  const taskSnapshot = { id: task.id, title: task.title, prompt: task.prompt, ...(channel ? { channelId: channel.id } : {}) };
  const thread = store.createLingThread({ kind: channel ? "task" : "conversation", channelId: channel?.id, taskId: channel ? task.id : undefined,
    title: "Existing parent", objective: task.prompt }, createdAt);
  const turn = store.createLingTurn({ threadId: thread.id, kind: "initial_request", taskId: task.id, channelId: channel?.id,
    title: task.title, userInstruction: task.prompt, createdByActor: "local-user" }, createdAt);
  const request = { cwd, workspaceCwd: cwd, task: taskSnapshot, threadId: thread.id, turnId: turn.id,
    providerPresetId: preset.id, runnerId: "pi", tools: ["read"], authorizationMode: "smart", workspaceAccessMode: "workspace_write",
    thinkingLevel: "off", harnessFeatureSnapshot: createHarnessFeatureSnapshot({ harness: supervisor.getHarnessFeatures() }) };
  const unit = store.createWorkUnit({ id: "root-unit", workspaceId: DEFAULT_WORKSPACE_ID, kind: "conversation_run", ownerType: "run",
    ownerId: "root", status: "claimed", channelId: channel?.id, taskId: task.id, runnerId: "pi", effectiveRunnerId: "pi",
    idempotencyKey: "root-unit", createdByActor: "system", request, now: createdAt });
  const attempt = store.createWorkUnitAttempt({ id: "root-attempt", workUnitId: unit.id, attemptNumber: 1,
    runtimeInstanceId: runtime.runtimeInstanceId, runnerId: "pi", effectiveRunnerId: "pi", now: createdAt });
  const run = store.createRun({ id: "root", cwd, taskId: task.id, channelId: channel?.id, workUnitId: unit.id,
    threadId: thread.id, turnId: turn.id, providerPresetId: preset.id, providerName: provider.provider, providerModel: provider.model,
    taskSnapshot, providerSnapshot: {}, requestSnapshot: request, createdAt });
  store.linkRunToWorkUnit(run.id, unit.id, createdAt);
  const policy = applyConversationModeToEffectiveRunPolicySnapshot(resolveSessionRunPolicy({ workspacePolicy: store.getApprovalPolicy(),
    authorizationMode: "smart", workspaceAccessMode: "workspace_write", channelBoundPath: cwd }).snapshot, thread.conversationMode.mode);
  const rootBudget = admitOriginalDelegationRoot({ store, run: store.getRun(run.id), attempt: store.getWorkUnitAttempt(attempt.id),
    originalProvider: provider, request, effectivePolicySnapshot: policy, runtimeTools: ["read"], now: createdAt });
  // Only seed the pre-existing parent; the system under test owns all child writes.
  store.database.prepare("UPDATE run_sessions SET status='running',started_at=? WHERE id=?").run(createdAt, run.id);
  store.database.prepare("UPDATE work_units SET status='running',started_at=? WHERE id=?").run(createdAt, unit.id);
  store.database.prepare("UPDATE work_unit_attempts SET status='started',started_at=? WHERE id=?").run(createdAt, attempt.id);
  if (channel) store.database.prepare("UPDATE tasks SET status='running',current_run_id=? WHERE id=?").run(run.id, task.id);
  const parentFence = toRuntimeAttemptFence(store.getWorkUnitAttempt(attempt.id));
  const spawned = composition.lifecycle.spawn({ parentRunId: run.id, sourceFence: parentFence, spawnCallId: "child-spawn",
    objective: "Read the frozen child objective without modifying files.", requestedBudget: { tokenBudget: 300_000 }, required: true, now: now() });
  const claimed = composition.lifecycle.claim({ reservationId: spawned.reservation.id, expectedStepRevision: 0,
    runtimeInstanceId: runtime.runtimeInstanceId, now: now() });
  const childRequest = rebuildDelegatedRunRequest({ store, child: claimed });
  const entry = composition.lifecycle.createExecutionEntry(claimed);
  const parentBefore = { run: store.getRun(run.id), task: store.getTask(task.id), turn: store.getLingTurn(turn.id),
    turns: store.listLingTurns({ threadId: thread.id }), links: store.listLingTurnRuns(turn.id) };
  const sink = { ...createDetachedRunExecutionSink(), writeEvent: (type, data) => observed.events.push({ type, data }),
    writeError: (status, body) => observed.errors.push({ status, body }) };
  const dispatch = (changes = {}) => executeRunRequest(changes.request ?? childRequest, sink, runners, registry, active, supervisor, resolver, {},
    { delegatedExecution: changes.entry ?? entry, afterRunTerminal: terminal => observed.terminals.push(terminal) });
  const assertParentUntouched = () => {
    assert.deepEqual(store.getRun(run.id), parentBefore.run, "child cannot finish or rewrite its parent Run");
    assert.deepEqual(store.getTask(task.id), parentBefore.task, "child cannot claim, finish or cancel the shared parent Task");
    assert.deepEqual(store.listLingTurns({ threadId: thread.id }), parentBefore.turns, "a dynamic child is not a new accepted Turn");
    assert.deepEqual(store.listLingTurnRuns(turn.id), parentBefore.links, "a child is not a top-level primary/retry link");
  };
  return { cwd, store, registry, active, supervisor, adapter, runners, resolver, composition, request: childRequest, rootBudget,
    claimed, entry, observed, controls, dispatch, parentFence, assertParentUntouched, accepted, transportEntered, releaseTransport,
    checkpointEntered, releaseCheckpoint };
}

for (const channelBound of [true, false]) test(`first delegated child reaches real SDK ACK, measured budget and sealed Host result (${channelBound ? "channel" : "conversation"})`,
  { timeout: 20_000 }, async t => {
    const f = await fixture(t, { channelBound });
    const id = await f.dispatch();
    assert.equal(id, f.claimed.run.id, JSON.stringify(f.observed.errors));
    assert.deepEqual(f.observed.errors, []);
    assert.equal(f.observed.calls.length, 1);
    assert.equal(f.observed.receipts.length, 1);
    assert.equal(f.observed.receipts[0].boundary, "pi-session-ready");
    assert.equal(f.observed.transportCalls, 1);
    const state = f.composition.lifecycle.recover(f.claimed.reservation.id);
    assert.equal(state.kind, "terminal");
    assert.equal(state.runtime.run.status, "succeeded");
    assert.equal(state.runtime.attempt.status, "succeeded");
    assert.equal(state.runtime.step.state, "succeeded");
    assert.equal(state.runtime.reservation.state, "settled");
    const charges = f.store.database.prepare("SELECT * FROM delegation_budget_charges WHERE reservation_id=?").all(f.claimed.reservation.id);
    assert.equal(charges.length, 1);
    assert.equal(charges[0].run_id, id);
    assert.equal(charges[0].root_run_id, "root");
    assert.equal(charges[0].state, "measured");
    const completion = f.store.getHostAttemptCompletion({ runId: id, ...toRuntimeAttemptFence(f.claimed.attempt) });
    assert.ok(completion?.drainedAt);
    assert.equal(completion.effectCoverage, "pi_no_tools_v1");
    const evidence = f.store.getDelegationCompletionEvidence({ rootRunIds: ["root"] });
    assert.equal(evidence.status, "satisfied", JSON.stringify(evidence.issues));
    assert.equal(evidence.steps[0].results.length, 1);
    assert.equal(evidence.steps[0].results[0].payload.sourceFence.attemptId, f.claimed.attempt.id);
    assert.deepEqual(f.observed.terminals.map(run => run.id), [id]);
    const persisted = f.composition.lifecycle.getPreparation(f.claimed.reservation.id);
    assert.equal(readPreparedPiInput(persisted.payload.runnerExecutionInput.preparedInput).fingerprint,
      f.observed.preparations[0].fingerprint, "SQLite must retain original SDK key order");
    assert.doesNotMatch(JSON.stringify(persisted.payload), /synthetic-no-network-key/);
    f.assertParentUntouched();
  });

for (const mode of ["no-ack", "spurious-ready"]) test(`resolved adapter and narrative/run_start cannot replace the actual receiver ACK: ${mode}`,
  { timeout: 20_000 }, async t => {
    const f = await fixture(t, { mode });
    assert.equal(await f.dispatch(), f.claimed.run.id);
    assert.equal(f.observed.calls.length, 1);
    assert.equal(f.observed.transportCalls, 0);
    assert.equal(f.observed.receipts.length, 0);
    const state = f.composition.lifecycle.recover(f.claimed.reservation.id);
    assert.equal(state.kind, "dispatch_outcome_unknown");
    assert.equal(state.runtime.step.state, "spawning");
    assert.equal(state.runtime.run.status, "queued");
    assert.equal(state.runtime.workUnit.status, "claimed");
    assert.equal(state.runtime.attempt.status, "created");
    assert.equal(state.runtime.reservation.state, "reserved");
    assert.equal(f.store.getDelegationCompletionEvidence({ rootRunIds: ["root"] }).status, "pending");
    assert.equal(f.store.database.prepare("SELECT COUNT(*) AS n FROM delegation_budget_charges").get().n, 0);
    assert.ok(f.observed.events.some(event => event.type === "delegation_blocked" && event.data.code === "delegation.receiver_unacknowledged"));
    assert.equal(f.observed.terminals.length, 0);
    f.assertParentUntouched();
    assert.equal(await f.dispatch(), undefined, "single-use original entry cannot dispatch again after unknown outcome");
    assert.equal(f.observed.calls.length, 1);
  });

test("a failed durable start commit rolls back ACK state and prevents the Provider transport", { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  f.store.database.exec(`CREATE TRIGGER delegated_start_fault BEFORE UPDATE ON delegation_steps
    WHEN NEW.state='running' BEGIN SELECT RAISE(ABORT, 'fixture_start_commit_failed'); END`);
  assert.equal(await f.dispatch(), f.claimed.run.id);
  assert.equal(f.observed.receipts.length, 1, "actual SDK reached the receiver, not the model");
  assert.equal(f.observed.transportCalls, 0, "failed ACK cannot admit a model request");
  const state = f.composition.lifecycle.recover(f.claimed.reservation.id);
  assert.equal(state.runtime.run.status, "queued");
  assert.equal(state.runtime.workUnit.status, "claimed");
  assert.equal(state.runtime.attempt.status, "created");
  assert.equal(state.runtime.step.state, "spawning");
  assert.equal(state.runtime.reservation.state, "reserved");
  assert.equal(f.observed.terminals.length, 0);
  assert.equal(f.store.database.prepare("SELECT COUNT(*) AS n FROM delegation_budget_charges").get().n, 0);
  assert.ok(f.observed.events.some(event => event.type === "delegation_blocked"));
  f.assertParentUntouched();
});

test("lookalike execution entry and modified child request cannot enter the actual Runner", { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  assert.equal(await f.dispatch({ entry: { ...f.entry } }), undefined);
  assert.equal(f.observed.errors.at(-1).body.error, "delegation.authority_invalid");
  assert.equal(f.observed.calls.length, 0);
  assert.equal(await f.dispatch({ request: { ...f.request, task: { ...f.request.task, prompt: "untrusted injected prompt" } } }), undefined);
  assert.equal(f.observed.errors.at(-1).body.error, "delegation.request_changed");
  assert.equal(f.observed.calls.length, 0);
  assert.equal(f.composition.lifecycle.getPreparation(f.claimed.reservation.id), undefined);
  f.assertParentUntouched();
});

test("interrupt drains the physical SDK Attempt without ending its logical Run or parent Task", { timeout: 20_000 }, async t => {
  const f = await fixture(t, { mode: "held-sdk" });
  const pending = f.dispatch();
  await Promise.race([f.transportEntered.promise, pending.then(() => { throw new Error(`child stopped before real SDK transport: ${JSON.stringify(f.observed.errors)}`); })]);
  assert.equal(f.store.getRun(f.claimed.run.id).status, "running");
  assert.equal(f.store.getDelegationStep(f.claimed.step.id).state, "running");
  f.composition.lifecycle.interrupt({ reservationId: f.claimed.reservation.id, parentFence: f.parentFence,
    callId: "interrupt-child", now: now() });
  assert.equal(f.active.requestStop(f.claimed.run.id, { kind: "user_cancel", actor: "local-user", reason: "Dedicated child interruption fixture" }), true);
  f.releaseTransport.resolve();
  assert.equal(await pending, f.claimed.run.id);
  const state = f.composition.lifecycle.recover(f.claimed.reservation.id);
  assert.equal(state.kind, "interrupted");
  assert.equal(state.runtime.run.status, "running");
  assert.equal(state.runtime.run.endedAt, undefined);
  assert.equal(state.runtime.workUnit.status, "cancelled");
  assert.equal(state.runtime.attempt.status, "cancelled");
  assert.equal(state.runtime.reservation.state, "reserved");
  assert.equal(f.observed.terminals.length, 0);
  const completion = f.store.getHostAttemptCompletion({ runId: f.claimed.run.id, ...toRuntimeAttemptFence(f.claimed.attempt) });
  assert.ok(completion?.drainedAt);
  assert.equal(completion.effectCoverage, "pi_no_tools_v1");
  f.assertParentUntouched();
  // No transcript reconstruction has been verified yet. The original Run and
  // allocation survive, but a second prompt must not replay its tools.
  const resumed = f.composition.lifecycle.resume({ reservationId: f.claimed.reservation.id,
    expectedStepRevision: state.runtime.step.revision, parentFence: f.parentFence,
    runtimeInstanceId: f.claimed.attempt.runtimeInstanceId, callId: "resume-missing-checkpoint", now: now() });
  const original = f.composition.lifecycle.getPreparation(f.claimed.reservation.id);
  const request = rebuildDelegatedRunRequest({ store: f.store, child: resumed, prepared: original });
  const entry = f.composition.lifecycle.createExecutionEntry(resumed);
  assert.equal(await f.dispatch({ request, entry }), f.claimed.run.id);
  assert.equal(f.observed.errors.at(-1).body.error, "checkpoint.missing");
  assert.equal(f.observed.calls.length, 1, "checkpoint unavailable is blocked, never an implicit fresh model run");
  assert.equal(f.store.getRun(f.claimed.run.id).status, "running");
  f.assertParentUntouched();
});

for (const channelBound of [true, false]) test(
  `same delegated child resumes its real committed SDK read checkpoint without replay (${channelBound ? "channel" : "conversation"})`,
  { timeout: 30_000 }, async t => {
    const f = await fixture(t, { mode: "checkpoint-sdk", channelBound });
    const sourceText = "Dedicated read-once evidence from the original child Attempt.\n";
    await writeFile(join(f.cwd, "read-once.txt"), sourceText, "utf8");
    const pending = f.dispatch();
    void pending.catch(() => {});
    let firstFinished = false;
    try {
      await Promise.race([f.checkpointEntered.promise, pending.then(() => {
        throw new Error(`child stopped before its real settled-read checkpoint: ${JSON.stringify({ errors: f.observed.errors,
          run: f.store.getRun(f.claimed.run.id), transportCalls: f.observed.transportCalls })}`);
      })]);
      const sourceRun = f.store.getRun(f.claimed.run.id);
      const sourceFence = toRuntimeAttemptFence(f.claimed.attempt);
      const sourcePolicy = sourceRun.requestSnapshot.effectivePolicySnapshot;
      const { lineage } = captureRunProgressCheckpointLineage(f.store, sourceRun, sourcePolicy);
      const checkpoint = f.store.readRunProgressCheckpointForRecovery({ runId: sourceRun.id,
        sourceFence, expectedLineage: lineage });
      assert.equal(checkpoint.kind, "verified", JSON.stringify(checkpoint));
      assert.deepEqual(checkpoint.witness.sourceFence, sourceFence);
      assert.equal(checkpoint.modelView.at(-1).role, "toolResult");
      assert.equal(checkpoint.modelView.at(-1).toolCallId, "delegated-prior-read");
      assert.ok(checkpoint.modelView.at(-1).content.some(block => block.type === "text" && block.text.includes(sourceText.trim())));
      const prepared = f.composition.lifecycle.getPreparation(f.claimed.reservation.id);
      assert.ok(prepared);
      assert.equal(f.observed.transportCalls, 1, "the Host pause precedes a second provider admission");
      assert.equal(f.store.listEvents(sourceRun.id).filter(event => event.type === "tool_start").length, 1);
      f.composition.lifecycle.interrupt({ reservationId: f.claimed.reservation.id, parentFence: f.parentFence,
        callId: "interrupt-at-committed-read", now: now() });
      assert.equal(f.active.requestStop(sourceRun.id, { kind: "user_cancel", actor: "local-user",
        reason: "Dedicated interruption after actual settled read and Core checkpoint" }), true);
      f.releaseCheckpoint.resolve();
      assert.equal(await pending, sourceRun.id);
      firstFinished = true;
      const interrupted = f.composition.lifecycle.recover(f.claimed.reservation.id);
      assert.equal(interrupted.kind, "interrupted", JSON.stringify({ errors: f.observed.errors, interrupted }));
      const sourceCompletion = f.store.getHostAttemptCompletion({ runId: sourceRun.id, ...sourceFence });
      assert.ok(sourceCompletion?.drainedAt);
      assert.equal(sourceCompletion.effectCoverage, "pi_tracked_tools_v1");
      assert.equal(interrupted.runtime.run.status, "running");
      assert.equal(interrupted.runtime.run.endedAt, undefined);
      assert.equal(f.observed.terminals.length, 0);
      assert.equal(f.observed.transportCalls, 1);

      const resumed = f.composition.lifecycle.resume({ reservationId: f.claimed.reservation.id,
        expectedStepRevision: interrupted.runtime.step.revision, parentFence: f.parentFence,
        runtimeInstanceId: f.claimed.attempt.runtimeInstanceId, callId: "resume-original-preparation", now: now() });
      assert.equal(resumed.run.id, sourceRun.id);
      assert.equal(resumed.attempt.attemptNumber, f.claimed.attempt.attemptNumber + 1);
      assert.ok(BigInt(resumed.attempt.fencingToken) > BigInt(f.claimed.attempt.fencingToken));
      const original = f.composition.lifecycle.getPreparation(f.claimed.reservation.id);
      assert.deepEqual(original, prepared, "resume retains the original immutable SDK preparation");
      const request = rebuildDelegatedRunRequest({ store: f.store, child: resumed, prepared: original });
      const entry = f.composition.lifecycle.createExecutionEntry(resumed);
      assert.equal(await f.dispatch({ request, entry }), sourceRun.id, JSON.stringify(f.observed.errors));
      assert.deepEqual(f.observed.errors, []);
      assert.equal(f.observed.calls.length, 2);
      assert.equal(f.observed.receipts.length, 2);
      assert.equal(f.observed.receipts[1].attemptId, resumed.attempt.id);
      assert.equal(f.observed.receipts[1].runId, sourceRun.id);
      assert.deepEqual(f.observed.calls[1].ordinaryProgressRecovery.modelView, checkpoint.modelView);
      assert.equal(f.observed.transportCalls, 2, "resume performs exactly the next model request");
      const restoredTools = f.observed.wireRequests[1].messages.filter(message => message.role === "tool");
      assert.equal(restoredTools.length, 1);
      assert.equal(restoredTools[0].tool_call_id, "delegated-prior-read");
      assert.ok(restoredTools[0].content.includes(sourceText.trim()));
      const events = f.store.listEvents(sourceRun.id);
      const starts = events.filter(event => event.type === "tool_start"), ends = events.filter(event => event.type === "tool_end");
      assert.equal(starts.length, 1, "the already completed read is never executed again");
      assert.equal(ends.length, 1);
      assert.equal(starts[0].data.attemptId, f.claimed.attempt.id);
      assert.equal(ends[0].data.attemptId, f.claimed.attempt.id);
      const result = f.composition.lifecycle.recover(f.claimed.reservation.id);
      assert.equal(result.kind, "terminal", JSON.stringify(result));
      assert.equal(result.runtime.run.status, "succeeded");
      assert.equal(result.runtime.attempt.id, resumed.attempt.id);
      assert.equal(result.runtime.reservation.state, "settled");
      assert.equal(f.store.listWorkUnitAttempts(f.claimed.workUnit.id).length, 2);
      assert.equal(f.store.database.prepare("SELECT COUNT(*) AS n FROM run_sessions WHERE parent_run_id='root'").get().n, 1);
      assert.equal(f.store.database.prepare("SELECT COUNT(*) AS n FROM run_progress_checkpoints WHERE run_id=?").get(sourceRun.id).n, 1);
      assert.equal(f.observed.terminals.length, 1);
      assert.equal(f.store.getDelegationCompletionEvidence({ rootRunIds: ["root"] }).status, "satisfied");
      f.assertParentUntouched();
    } finally {
      if (!firstFinished) {
        f.active.requestStop(f.claimed.run.id, { kind: "user_cancel", actor: "local-user", reason: "Dedicated fixture cleanup" });
        f.releaseCheckpoint.resolve();
        await pending.catch(() => {});
      }
    }
  });
