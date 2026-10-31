import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteRunStore, resolveStoragePaths, toRuntimeAttemptFence, captureRunProgressCheckpointLineage }
  from "@ling-stack/core";
import { resolveConfig } from "../dist/config.js";
import { activateOriginalRootRunSuspension, createOriginalDelegationStoreComposition, readOriginalRunSuspensionLifecycle }
  from "../dist/features/harness/delegations/store-composition.js";
import { prepareExistingRunContinuationPlan } from "../dist/features/harness/continuations/coordinator.js";
import { readStoredRunnerExecution } from "../dist/features/runs/existing-run-request.js";
import { createDetachedRunExecutionSink, executeRunRequest, executeExistingRunContinuation } from "../dist/features/runs/orchestrator.js";
import { ActiveRunRegistry } from "../dist/runtime/active-runs.js";
import { createRunnerRegistry } from "../dist/runtime/runners.js";
import { patchWorkspaceRuntimeSettings } from "../dist/runtime/runner-settings.js";
import { RunStoreRegistry } from "../dist/runtime/store-registry.js";
import { RuntimeSupervisor } from "../dist/runtime/supervisor.js";
import { runSuspensionOrderFor } from "../dist/runtime/run-suspension-order.js";
import { DaemonRunnerRecoveryCoordinator } from "../dist/features/harness/continuations/daemon-recovery-coordinator.js";
import { createA21LoopbackTransport, createA21RealPiRunner } from "./support/noncompacted-recovery-crash-worker.mjs";

// Real SDK → original Host suspension → SQLite close/reopen. Provider transport
// is owned deterministic SSE, not a paid model or a fabricated stop receipt.
async function fixture(t, { budget = false, inline = false, credential = true, realTask = false,
  customTeammate = false, requestReadAfterRecovery = false, compaction = false, repeatCompactionSuspension,
  suspendWhileLocked = false, suspendAtFinal = false, noTools = false } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-root-suspension-recovery-"));
  const config = resolveConfig({ defaultWorkspaceCwd: cwd, channels: { terminalReports: false }, harness: {
    continuations: { mode: "enforce" }, delegations: { mode: budget ? "enforce" : "off",
      ...(budget ? { rootBudget: { tokenBudget: 100_000, wallTimeBudgetMs: 60_000 } } : {}) },
  } });
  let supervisor = new RuntimeSupervisor(config), stores, store, transport, stop, requested = false;
  const values = new Map(credential ? [["env:ROOT_RECOVERY_TEST_KEY", "synthetic-recovery-key"]] : []);
  let afterResolve, beforeRecoveryAck, afterRecoveryAck, suspensionBoundaryError;
  const resolver = { status: ref => ({ ref, kind: "env", configured: values.has(ref) }), resolve: ref => {
    const result = { ref, configured: values.has(ref), value: values.get(ref), status: { ref, kind: "env", configured: values.has(ref) } };
    const callback = afterResolve; afterResolve = undefined; callback?.(); return result;
  } };
  t.after(async () => {
    supervisor.releaseAll(); stores?.closeAll(); await transport?.close();
    await rm(cwd, { recursive: true, force: true });
  });
  await writeFile(join(cwd, "fixture.txt"), "exact original result, do not read again\n");
  if (compaction) await Promise.all(Array.from({ length: 12 }, (_, i) => writeFile(join(cwd, `compaction-${i + 1}.txt`),
    `Owned compaction read ${i + 1}.\n` + `evidence-${i + 1} `.repeat(2_000))));
  let compacting = false, summaryRequests = 0, taskRequests = 0, requestedAgain = false;
  transport = await createA21LoopbackTransport(count => {
    if (noTools) return { content: "A complete answer with no tool execution.",
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
    if (compaction) {
      if (compacting) { summaryRequests += 1; return { content: "## Goal\nRead owned evidence.\n## Progress\nCompleted reads must not be repeated.",
        usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } }; }
      taskRequests += 1;
      if (requested && repeatCompactionSuspension === "new_tool" && !requestedAgain) {
        return { usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 },
          tool_calls: [{ index: 0, id: "compacted-restored-read", type: "function", function: {
            name: "read", arguments: JSON.stringify({ path: "fixture.txt" }) } }] };
      }
      return { usage: { prompt_tokens: summaryRequests ? 100 : 32_000, completion_tokens: 5, total_tokens: summaryRequests ? 105 : 32_005 },
        ...(requested || taskRequests > 12 ? { content: "Recovered compacted task without repeating reads." } : {
          tool_calls: [{ index: 0, id: `compacted-read-${taskRequests}`, type: "function", function: {
            name: "read", arguments: JSON.stringify({ path: `compaction-${taskRequests}.txt` }) } }] }) };
    }
    return { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    ...(count > (requestReadAfterRecovery ? 2 : 1) ? { content: "Recovered without repeating the original read." } : {
      tool_calls: [{ index: 0, id: count === 1 ? "root-original-read" : "root-resumed-read", type: "function",
        function: { name: "read", arguments: JSON.stringify({ path: "fixture.txt" }) } }] }) };
  });
  const runner = createA21RealPiRunner(transport), originalRunTask = runner.runTask.bind(runner);
  let activeRuns = new ActiveRunRegistry();
  runner.runTask = options => originalRunTask({ ...options,
    onEvent: event => {
      if (event.type === "context_compaction_start") compacting = true;
      if (event.type === "context_compaction_end") compacting = false;
      options.onEvent?.(event);
    },
    ...(requested && options.onPreparedInputAccepted ? { onPreparedInputAccepted: async (receipt, signal) => {
      await beforeRecoveryAck?.(receipt); await options.onPreparedInputAccepted(receipt, signal); await afterRecoveryAck?.(receipt);
    } } : {}),
    onTaskSettledBoundary: async view => {
      if (suspendAtFinal && !requested) {
        assert.equal(view.at(-1)?.role, "assistant");
        assert.equal(view.at(-1)?.stopReason, "stop");
        requested = true;
        await activeRuns.requestGracefulSuspension("daemon_restart");
      }
      try { return await options.onTaskSettledBoundary?.(view); }
      catch (error) { suspensionBoundaryError = error; throw error; }
    },
    onTaskContinuationBoundary: async (boundary, view) => {
    const compacted = view?.[0]?.role === "compactionSummary";
    const start = compaction && options.runId ? store.getLatestRunCompactionStart(options.runId) : undefined;
    const checkpoint = compaction && options.runId ? store.getLatestRunCompactionCheckpoint(options.runId) : undefined;
    if (!suspendAtFinal && !requested && boundary === "before_provider_request" && view?.some(message => message.role === "toolResult")
      && (!compaction || compacted && (compaction !== "progress" || checkpoint?.sourceEventSeq > start?.seq))) {
      if (suspendWhileLocked) {
        const owner = "owned-root-suspension-lock";
        supervisor.updateLockedTaskContinuation({ desktopInstanceId: owner, leaseTtlMs: 60_000,
          continueWhileLocked: false, locked: true });
        const actualWait = supervisor.waitForLockedTaskContinuation.bind(supervisor);
        supervisor.waitForLockedTaskContinuation = async signal => {
          supervisor.waitForLockedTaskContinuation = actualWait;
          assert.equal(supervisor.isLockedTaskContinuationBlocked(), true);
          const waiting = actualWait(signal);
          // Force the real gate interleaving after the Host's pre-wait check.
          // Do not abort the SDK, fabricate a directive, or release first.
          requested = true;
          try { await activeRuns.requestGracefulSuspension("daemon_restart"); }
          finally { supervisor.releaseLockedTaskContinuation(owner); }
          return waiting;
        };
      } else { requested = true; await activeRuns.requestGracefulSuspension("daemon_restart"); }
    } else if (requested && repeatCompactionSuspension && !requestedAgain && options.onPreparedInputAccepted
      && boundary === "before_provider_request" && (repeatCompactionSuspension === "no_new_tool"
        || view?.some(message => message.role === "toolResult" && message.toolCallId === "compacted-restored-read"))) {
      requestedAgain = true; await activeRuns.requestGracefulSuspension("daemon_restart");
    }
    try { return await options.onTaskContinuationBoundary?.(boundary, view); }
    catch (error) { if (requested) suspensionBoundaryError = error; throw error; }
  } });
  const runners = createRunnerRegistry([{ id: "pi", displayName: "Actual isolated Pi", status: "enabled", adapter: runner }]);
  const open = () => {
    const composition = createOriginalDelegationStoreComposition({ supervisor, runnerRegistry: runners, secretResolver: resolver });
    stores = new RunStoreRegistry(path => {
      const paths = resolveStoragePaths(path, { homeDir: join(cwd, "fixture-home"), env: {}, workspaceStateLocation: "repo-local" }).workspace;
      const value = new SqliteRunStore({ cwd: path, paths, delegationHostBinding: composition.binding });
      composition.bindExactStore(value); return value;
    });
    store = stores.getStore(cwd);
  };
  open();
  const now = new Date().toISOString();
  const teammateId = customTeammate ? "root-recovery-agent" : "ling_agent";
  if (customTeammate) store.createAiTeammate({ id: teammateId, roleKey: "engineer", displayName: "Root recovery agent",
    description: "Isolated root recovery", allowedTools: ["read"],
    approvalProfile: { mode: "standard", risk: "medium" }, status: "active" }, now);
  const provider = { provider: "root-recovery-fixture", model: "fixture", api: "openai-completions",
    baseUrl: "https://fixture.invalid/v1", authHeader: false, reasoning: false };
  const preset = inline ? undefined : store.createProviderPreset({ kind: "openai-compatible", displayName: "Root recovery",
    providerId: provider.provider, model: provider.model, api: provider.api, baseUrl: provider.baseUrl,
    authHeader: credential, ...(credential ? { apiKeyRef: "env:ROOT_RECOVERY_TEST_KEY" } : {}),
    reasoning: false, contextWindow: compaction ? 32_768 : 16_000, maxTokens: compaction ? 256 : 1_000,
    capabilities: ["chat", "tool_call"], enabled: true }, now);
  if (preset) store.recordProviderCheckResult(preset.id, { ok: true, code: "ready", message: "Owned transport", checkedAt: now });
  const channel = realTask ? store.createChannel({ name: "Root task recovery", boundPath: cwd, allowedTools: ["read"],
    ...(preset ? { defaultProviderPresetId: preset.id } : {}) }, now) : undefined;
  const taskRow = channel ? store.createTask({ channelId: channel.id, title: "Root task recovery",
    prompt: "Read fixture.txt exactly once." }, now) : undefined;
  const task = { id: taskRow?.id ?? "root-recovery", title: taskRow?.title ?? "Root recovery",
    prompt: taskRow?.prompt ?? "Read fixture.txt exactly once.", ...(channel ? { channelId: channel.id } : {}) };
  const thread = store.createLingThread({ kind: realTask ? "task" : "conversation", teammateId,
    ...(channel ? { channelId: channel.id, taskId: task.id } : {}), title: "Root recovery", objective: "Read once" }, now);
  const errors = [];
  const runId = await executeRunRequest({ cwd, workspaceCwd: cwd, threadId: thread.id, teammateId,
    ...(preset ? { providerPresetId: preset.id } : { provider }), tools: noTools ? [] : ["read"],
    authorizationMode: "smart", workspaceAccessMode: "workspace_write",
    task, idempotencyKey: "root-recovery" },
  { ...createDetachedRunExecutionSink(), writeError: (_status, body) => errors.push(body) },
  runners, stores, activeRuns, supervisor, resolver, {});
  await activeRuns.waitForIdle();
  const originalState = store.getRun(runId);
  if (compaction) {
    assert.ok(summaryRequests > 0, "the actual Pi SDK must have compacted the source view");
    assert.equal(requested, true, "the source must reach its real post-compaction provider boundary");
  }
  assert.deepEqual(errors, [], `the original Run must pass real Host preflight before testing recovery: ${JSON.stringify({
    boundaryError: suspensionBoundaryError?.stack, summaryRequests, taskRequests })}`);
  assert.equal(requested, true, JSON.stringify({ status: originalState?.status, error: originalState?.errorMessage,
    requests: transport.requests.length }));
  await activeRuns.waitForGracefulSuspensionRequests();
  await runSuspensionOrderFor(activeRuns).waitForAllFinished();
  assert.deepEqual(errors, []); assert.equal(requested, true);
  if (compaction) assert.ok(summaryRequests > 0, "the actual Pi SDK must have compacted the source view");
  else assert.equal(transport.requests.length, suspendAtFinal && !noTools ? 2 : 1);
  const sourceWireCount = transport.requests.length;
  const oldRun = store.getRun(runId), oldAttempt = store.getWorkUnitAttempt(store.getWorkUnit(oldRun.workUnitId).activeAttemptId);
  const originalLifecycle = readOriginalRunSuspensionLifecycle(store, supervisor);
  const suspension = originalLifecycle.getRunSuspensionForAttempt(oldAttempt.id);
  stop = originalLifecycle.getRunSuspensionStop(suspension.id);
  assert.equal(stop.state, "stopped");
  const budgetBefore = store.database.prepare("SELECT * FROM delegation_root_budgets WHERE root_run_id=?").get(runId);
  const chargesBefore = store.database.prepare("SELECT * FROM delegation_budget_charges ORDER BY id").all();
  supervisor.releaseAll(); stores.closeAll(); supervisor = new RuntimeSupervisor(config);
  activeRuns = new ActiveRunRegistry(); open();
  // All composition facts are now new and empty. No live old-fence admission
  // can be borrowed from the source executor which has already drained/closed.
  const runtime = supervisor.getRuntime(cwd, store), run = store.getRun(runId), unit = store.getWorkUnit(run.workUnitId);
  const sourceAttempt = store.getWorkUnitAttempt(oldAttempt.id), { policySnapshot } = captureRunProgressCheckpointLineage(store, run);
  const selected = runners.resolve({ requestedRunnerId: "pi", allowFallback: false,
    allowedRunnerIds: ["pi"], providerApi: "openai-completions", tools: ["read"], requestSource: "product_default" }).runner;
  const plan = prepareExistingRunContinuationPlan({ store, run, workUnit: unit, sourceAttempt, runtime, runner: selected,
    origin: "daemon_recovery", policySnapshot, execution: readStoredRunnerExecution(run), workspaceCwd: cwd,
    now: new Date().toISOString(), idempotencyDiscriminator: "suspension-test" });
  if (compaction) {
    const refs = store.getArtifact(plan.preparation.contextSnapshotArtifactId).sealedPayload.artifactRefs;
    let checkpoint = store.getLatestRunCompactionCheckpoint(run.id);
    const seen = new Set();
    while (checkpoint) {
      assert.equal(seen.has(checkpoint.id), false, "replay dependencies must form an acyclic real compaction chain");
      seen.add(checkpoint.id);
      assert.ok(refs.includes(checkpoint.contextSnapshotArtifactId), "replay must reference the original snapshot");
      assert.ok(refs.includes(checkpoint.summaryArtifactId), "replay must reference every predecessor summary");
      checkpoint = checkpoint.predecessorId ? store.getRunCompactionCheckpoint(checkpoint.predecessorId) : undefined;
    }
    assert.ok(seen.size >= (compaction === "progress" ? 2 : 1));
  }
  const activation = { suspensionId: suspension.id, sourceFence: toRuntimeAttemptFence(sourceAttempt),
    expectedReceiptDigest: stop.receiptDigest, replayArtifactId: plan.preparation.contextSnapshotArtifactId,
    target: { runtimeInstanceId: runtime.runtimeInstanceId, runnerId: "pi", runnerCapabilityRevision: selected.nativeResumeConformance.revision },
    claim: { owner: plan.claimOwner, token: plan.claimToken, expiresAt: plan.claimExpiresAt }, now: new Date().toISOString() };
  return { cwd, get store() { return store; }, get supervisor() { return supervisor; }, runners,
    get activeRuns() { return activeRuns; }, preset, run, sourceAttempt, activation, budgetBefore, chargesBefore, transport,
    sourceWireCount, suspension, stop,
    reopen: () => {
      supervisor.releaseAll(); stores.closeAll(); supervisor = new RuntimeSupervisor(config);
      activeRuns = new ActiveRunRegistry(); open();
    },
    setRecoveryAckHooks: (before, after) => { beforeRecoveryAck = before; afterRecoveryAck = after; },
    recover: async (preparedExecution) => {
      const recoveryErrors = [], recoveryEvents = [];
      const awaitingRepeatSuspension = Boolean(repeatCompactionSuspension && !requestedAgain);
      const result = await executeExistingRunContinuation({ cwd, runId, origin: "daemon_recovery",
        idempotencyDiscriminator: "real-root-recovery", ...(preparedExecution ? { preparedExecution } : {}) },
      { ...createDetachedRunExecutionSink(), writeError: (_status, body) => recoveryErrors.push(body),
        writeEvent: (name, body) => recoveryEvents.push({ name, body }) }, runners, stores, activeRuns, supervisor, resolver, {});
      await activeRuns.waitForIdle();
      if (awaitingRepeatSuspension && requestedAgain) {
        await activeRuns.waitForGracefulSuspensionRequests();
        await runSuspensionOrderFor(activeRuns).waitForAllFinished();
      }
      return { result, errors: recoveryErrors, events: recoveryEvents };
    },
    afterNextCredentialRead: callback => { afterResolve = callback; }, setCredential: value => values.set("env:ROOT_RECOVERY_TEST_KEY", value),
    activate: changes => activateOriginalRootRunSuspension({ store, supervisor, activation: { ...activation, ...changes } }) };
}

for (const options of [{}, { budget: true }, { noTools: true }, { noTools: true, budget: true }, { compaction: "progress" }]) {
  test(`a real final-assistant suspension restores complete without a new provider wire: ${JSON.stringify(options)}`,
    { timeout: 30_000 }, async t => {
      const f = await fixture(t, { ...options, suspendAtFinal: true });
      assert.equal(f.suspension.seal.witness.kind, "settlement");
      const readsBefore = f.store.listEvents(f.run.id, { limit: 1000 }).filter(event => event.type === "tool_end");
      const assistantBefore = f.store.listEvents(f.run.id, { limit: 1000 }).filter(event =>
        event.type === "assistant_text_delta" || event.type === "message_end" && event.data.role === "assistant");
      let acknowledged = false;
      f.setRecoveryAckHooks(undefined, () => {
        acknowledged = true;
        assert.equal(f.transport.requests.length, f.sourceWireCount);
      });
      const recovered = await f.recover();
      assert.deepEqual(recovered.errors, [], JSON.stringify(recovered.events));
      assert.equal(acknowledged, true, "the restored terminal view still needs the actual SDK receiver ACK");
      assert.equal(f.store.getRun(f.run.id).status, "succeeded");
      assert.equal(f.store.listWorkUnitAttempts(f.run.workUnitId).length, 2);
      assert.equal(f.transport.requests.length, f.sourceWireCount, "a settled final answer must never be reprompted");
      assert.deepEqual(f.store.listEvents(f.run.id, { limit: 1000 }).filter(event => event.type === "tool_end"), readsBefore);
      assert.deepEqual(f.store.listEvents(f.run.id, { limit: 1000 }).filter(event =>
        event.type === "assistant_text_delta" || event.type === "message_end" && event.data.role === "assistant"), assistantBefore,
      "restoring a final answer cannot append a duplicate assistant reply");
      assert.deepEqual(f.store.database.prepare("SELECT * FROM delegation_root_budgets WHERE root_run_id=?").get(f.run.id), f.budgetBefore);
      assert.deepEqual(f.store.database.prepare("SELECT * FROM delegation_budget_charges ORDER BY id").all(), f.chargesBefore);
    });
}

for (const afterAck of [false, true]) {
  test(`final settlement rejects credential rotation ${afterAck ? "after" : "before"} actual SDK ACK without a new wire`,
    { timeout: 30_000 }, async t => {
      const f = await fixture(t, { suspendAtFinal: true });
      let reached = false;
      const rotate = () => { reached = true; f.setCredential("rotated-at-final-recovery-ack"); };
      f.setRecoveryAckHooks(afterAck ? undefined : rotate, afterAck ? rotate : undefined);
      await f.recover();
      assert.equal(reached, true);
      assert.notEqual(f.store.getRun(f.run.id).status, "succeeded");
      assert.equal(f.transport.requests.length, f.sourceWireCount);
      assert.equal(f.store.listEvents(f.run.id, { limit: 1000 }).filter(event => event.type === "run_end").length, 0);
      assert.equal(f.store.database.prepare("SELECT COUNT(*) n FROM run_suspension_root_starts").get().n, afterAck ? 1 : 0);
    });
}

test("a final settlement with a corrupted model-view artifact cannot fall back to an older progress head", { timeout: 30_000 }, async t => {
  const f = await fixture(t, { suspendAtFinal: true });
  const id = f.suspension.seal.witness.settlement.modelViewArtifactId;
  f.store.database.prepare("UPDATE artifacts SET sealed_payload_json=sealed_payload_json||' ' WHERE id=?").run(id);
  const before = f.store.listWorkUnitAttempts(f.run.workUnitId);
  const result = await f.recover();
  assert.deepEqual(f.store.listWorkUnitAttempts(f.run.workUnitId), before);
  assert.notEqual(f.store.getRun(f.run.id).status, "succeeded");
  assert.equal(f.transport.requests.length, f.sourceWireCount);
  assert.ok(result.errors.length || result.events.some(event => event.body.status === "blocked"));
});

for (const compaction of ["installed", "progress"]) {
  test(`a real ${compaction} compacted source seals and resumes without repeating any owned tool`, { timeout: 30_000 }, async t => {
    const f = await fixture(t, { compaction });
    assert.equal(f.suspension.seal.witness.kind, "compaction");
    const readsBefore = f.store.listEvents(f.run.id, { limit: 1000 }).filter(event => event.type === "tool_end");
    assert.ok(readsBefore.length > 0);
    let acknowledged = false;
    f.setRecoveryAckHooks(undefined, () => {
      acknowledged = true;
      assert.equal(f.transport.requests.length, f.sourceWireCount, "real ACK must precede resumed provider I/O");
    });
    const recovered = await f.recover();
    assert.deepEqual(recovered.errors, [], JSON.stringify(recovered.events));
    assert.equal(acknowledged, true);
    assert.equal(f.store.getRun(f.run.id).status, "succeeded");
    assert.equal(f.transport.requests.length, f.sourceWireCount + 1);
    assert.equal(f.store.listWorkUnitAttempts(f.run.workUnitId).length, 2);
    assert.deepEqual(f.store.listEvents(f.run.id, { limit: 1000 }).filter(event => event.type === "tool_end"), readsBefore);
    const lastRead = readsBefore.at(-1).data.toolCallId;
    assert.ok(JSON.stringify(f.transport.requests.at(-1).body.messages).includes(lastRead));
    assert.deepEqual(f.store.database.prepare("SELECT * FROM delegation_root_budgets WHERE root_run_id=?").get(f.run.id), f.budgetBefore);
  });
}

for (const compaction of [false, "installed"]) {
  test(`a graceful suspension requested during the real locked gate is sealed before another provider request: ${compaction || "ordinary"}`,
    { timeout: 30_000 }, async t => {
      const f = await fixture(t, { compaction, suspendWhileLocked: true });
      assert.equal(f.stop.state, "stopped");
      const recovered = await f.recover();
      assert.deepEqual(recovered.errors, [], JSON.stringify(recovered.events));
      assert.equal(f.store.getRun(f.run.id).status, "succeeded");
      assert.equal(f.transport.requests.length, f.sourceWireCount + 1);
    });
}

for (const repeatCompactionSuspension of ["no_new_tool", "new_tool"]) {
  test(`a compacted restored source can suspend again with ${repeatCompactionSuspension} without losing its installed lineage`,
    { timeout: 30_000 }, async t => {
      const f = await fixture(t, { compaction: "installed", repeatCompactionSuspension });
      const reads = () => f.store.listEvents(f.run.id, { limit: 1000 }).filter(event => event.type === "tool_end");
      const originalReads = reads();
      const firstRecovery = await f.recover();
      assert.deepEqual(firstRecovery.errors, [], JSON.stringify(firstRecovery.events));
      const secondSource = f.store.getWorkUnitAttempt(f.store.getWorkUnit(f.run.workUnitId).activeAttemptId);
      const lifecycle = readOriginalRunSuspensionLifecycle(f.store, f.supervisor);
      const suspension = lifecycle.getRunSuspensionForAttempt(secondSource.id);
      assert.ok(suspension, "the restored source must persist its own suspension intent");
      assert.equal(suspension.seal?.witness.kind, "compaction");
      assert.equal(lifecycle.getRunSuspensionStop(suspension.id)?.state, "stopped");
      const readsBeforeReopen = reads();
      assert.equal(readsBeforeReopen.length, originalReads.length + (repeatCompactionSuspension === "new_tool" ? 1 : 0));
      const wireBeforeReopen = f.transport.requests.length;
      assert.equal(wireBeforeReopen, f.sourceWireCount + (repeatCompactionSuspension === "new_tool" ? 1 : 0));
      f.reopen();
      const secondRecovery = await f.recover();
      assert.deepEqual(secondRecovery.errors, [], JSON.stringify(secondRecovery.events));
      assert.equal(f.store.getRun(f.run.id).status, "succeeded");
      assert.equal(f.store.listWorkUnitAttempts(f.run.workUnitId).length, 3);
      assert.equal(f.transport.requests.length, wireBeforeReopen + 1);
      assert.deepEqual(reads(), readsBeforeReopen, "neither original nor restored tools may replay");
      assert.ok(JSON.stringify(f.transport.requests.at(-1).body.messages).includes(readsBeforeReopen.at(-1).data.toolCallId));
      assert.deepEqual(f.store.database.prepare("SELECT * FROM delegation_root_budgets WHERE root_run_id=?").get(f.run.id), f.budgetBefore);
    });
}

for (const dependency of ["snapshot", "latest_summary", "predecessor_summary"]) {
  test(`a stopped compacted source rejects changed ${dependency} before creating or dispatching a successor`,
    { timeout: 30_000 }, async t => {
      const f = await fixture(t, { compaction: "progress" });
      const checkpoint = f.store.getLatestRunCompactionCheckpoint(f.run.id);
      const id = dependency === "snapshot" ? checkpoint.contextSnapshotArtifactId : dependency === "latest_summary"
        ? checkpoint.summaryArtifactId : f.store.getRunCompactionCheckpoint(checkpoint.predecessorId).summaryArtifactId;
      // Corrupt only this test's owned temporary SQLite body, not its digest or
      // any production state; a saved seal must not waive dependency validation.
      f.store.database.prepare("UPDATE artifacts SET sealed_payload_json=sealed_payload_json||' ' WHERE id=?").run(id);
      const source = f.store.getWorkUnitAttempt(f.sourceAttempt.id), unit = f.store.getWorkUnit(f.run.workUnitId);
      const recovered = await f.recover();
      assert.ok(recovered.errors.length > 0, "dependency corruption must be reported rather than silently replayed");
      assert.equal(f.transport.requests.length, f.sourceWireCount);
      assert.equal(f.store.listWorkUnitAttempts(f.run.workUnitId).length, 1);
      assert.deepEqual(f.store.getWorkUnitAttempt(source.id), source);
      assert.deepEqual(f.store.getWorkUnit(unit.id), unit);
    });
}

for (const options of [{ budget: false }, { budget: false, inline: true }, { budget: true }, { budget: false, realTask: true },
  { budget: false, customTeammate: true }]) {
  test(`real SDK root recovery commits ACK before the second wire without repeating tools: ${JSON.stringify(options)}`,
    { timeout: 20_000 }, async t => {
      const f = await fixture(t, options);
      let acknowledged = false;
      f.setRecoveryAckHooks(undefined, receipt => {
        acknowledged = true;
        const unit = f.store.getWorkUnit(f.run.workUnitId), target = f.store.getWorkUnitAttempt(unit.activeAttemptId);
        assert.equal(target.id, receipt.attemptId); assert.equal(target.status, "started"); assert.equal(unit.status, "running");
        assert.equal(f.store.database.prepare("SELECT COUNT(*) n FROM run_suspension_root_starts").get().n, 1);
        assert.equal(f.transport.requests.length, 1, "SDK acknowledgement must precede any resumed model request");
      });
      const result = await f.recover();
      assert.deepEqual(result.errors, []); assert.equal(acknowledged, true, JSON.stringify(result.events));
      assert.equal(f.store.getRun(f.run.id).status, "succeeded");
      if (options.realTask) assert.equal(f.store.getTask(f.run.taskId).status, "done");
      assert.equal(f.store.listWorkUnitAttempts(f.run.workUnitId).length, 2);
      assert.equal(f.transport.requests.length, 2);
      assert.ok(JSON.stringify(f.transport.requests[1].body.messages).includes("exact original result, do not read again"));
      assert.equal(f.store.listEvents(f.run.id, { limit: 1000 }).filter(event => event.type === "tool_start"
        && event.data.toolCallId === "root-original-read").length, 1);
      const budgetAfter = f.store.database.prepare("SELECT * FROM delegation_root_budgets WHERE root_run_id=?").get(f.run.id);
      assert.deepEqual(budgetAfter, f.budgetBefore, "recovery does not refreeze or extend the root budget");
    });
}

test("ordinary root activation rejects a revoked teammate tool surface without creating a successor", { timeout: 20_000 }, async t => {
  const f = await fixture(t, { customTeammate: true });
  f.store.updateAiTeammate(f.run.teammateId, { allowedTools: [] }, new Date().toISOString());
  assert.throws(() => f.activate(), error => error.code === "delegation.tool_revoked");
  assert.equal(f.store.listWorkUnitAttempts(f.run.workUnitId).length, 1);
  assert.equal(f.transport.requests.length, 1);
});

test("production root recovery keeps the stopped source unchanged when tools are revoked before activation", { timeout: 20_000 }, async t => {
  const f = await fixture(t, { customTeammate: true });
  f.store.updateAiTeammate(f.run.teammateId, { allowedTools: [] }, new Date().toISOString());
  const beforeUnit = f.store.getWorkUnit(f.run.workUnitId), beforeAttempt = f.store.getWorkUnitAttempt(beforeUnit.activeAttemptId);
  const result = await f.recover();
  assert.deepEqual(f.store.getWorkUnit(f.run.workUnitId), beforeUnit);
  assert.deepEqual(f.store.getWorkUnitAttempt(beforeAttempt.id), beforeAttempt);
  assert.equal(f.store.getRun(f.run.id).status, "running");
  assert.equal(f.store.listWorkUnitAttempts(f.run.workUnitId).length, 1);
  assert.equal(f.transport.requests.length, 1);
  assert.ok(result.errors.length > 0, "preflight must reject the revoked tool surface");
});

test("ordinary root ACK rejects teammate tool revocation before any resumed wire or tool", { timeout: 20_000 }, async t => {
  const f = await fixture(t, { customTeammate: true, requestReadAfterRecovery: true });
  let reached = false;
  f.setRecoveryAckHooks(() => { reached = true;
    f.store.updateAiTeammate(f.run.teammateId, { allowedTools: [] }, new Date().toISOString());
  });
  const result = await f.recover(), unit = f.store.getWorkUnit(f.run.workUnitId);
  assert.equal(reached, true);
  assert.equal(f.store.database.prepare("SELECT COUNT(*) n FROM run_suspension_root_starts").get().n, 0);
  assert.equal(f.transport.requests.length, 1);
  assert.equal(unit.status, "claimed");
  assert.equal(f.store.getWorkUnitAttempt(unit.activeAttemptId).status, "created");
  assert.equal(f.store.getRun(f.run.id).status, "running");
  assert.ok(result.events.some(event => event.body.status === "blocked" && event.body.code === "delegation.tool_revoked"));
  assert.equal(f.store.listEvents(f.run.id, { limit: 1000 }).filter(event => event.data.toolCallId === "root-resumed-read").length, 0);
});

for (const failure of ["callback", "policy", "credential"]) {
  test(`root receiver ${failure} failure retains unacknowledged authority and sends no resumed wire`, { timeout: 20_000 }, async t => {
    const f = await fixture(t);
    f.setRecoveryAckHooks(() => {
      if (failure === "callback") throw new Error("owned receiver failure");
      if (failure === "policy") f.store.updateApprovalPolicy({ toolDecisions: { read: "deny" } }, new Date().toISOString());
      if (failure === "credential") f.setCredential("rotated-before-actual-ack");
    });
    const result = await f.recover(), unit = f.store.getWorkUnit(f.run.workUnitId), target = f.store.getWorkUnitAttempt(unit.activeAttemptId);
    assert.equal(result.result, f.run.id); assert.equal(target.status, "created"); assert.equal(unit.status, "claimed");
    assert.equal(f.store.getRun(f.run.id).status, "running"); assert.equal(f.transport.requests.length, 1);
    assert.equal(f.store.database.prepare("SELECT COUNT(*) n FROM run_suspension_root_starts").get().n, 0);
    assert.ok(result.events.some(event => event.body.status === "blocked"));
    await f.recover();
    assert.equal(f.store.listWorkUnitAttempts(f.run.workUnitId).length, 2);
    assert.equal(f.transport.requests.length, 1, "repeat recovery never regrants the consumed dispatch claim");
  });
}

test("saved root activation is audit-only and cannot be submitted as an ordinary prepared dispatch", { timeout: 20_000 }, async t => {
  const f = await fixture(t), activated = f.activate();
  assert.equal(activated.kind, "activated");
  const beforeUnit = f.store.getWorkUnit(f.run.workUnitId);
  const beforeContinuation = f.store.getRunnerContinuation(activated.continuation.id);
  const beforeEvents = f.store.database.prepare("SELECT * FROM runtime_events WHERE work_unit_id=? ORDER BY rowid").all(beforeUnit.id);
  const result = await f.recover({ continuation: activated.continuation, attempt: activated.attempt,
    claimOwner: f.activation.claim.owner, claimToken: f.activation.claim.token, claimExpiresAt: f.activation.claim.expiresAt });
  assert.ok(result.errors.some(error => error.error === "suspension_start.dispatch_not_regranted"));
  assert.equal(f.transport.requests.length, 1); assert.equal(f.store.getRun(f.run.id).status, "running");
  assert.equal(f.store.getWorkUnitAttempt(activated.attempt.id).status, "created");
  assert.equal(f.store.listWorkUnitAttempts(f.run.workUnitId).length, 2);
  assert.deepEqual(f.store.getWorkUnit(f.run.workUnitId), beforeUnit, "an audit-only dispatch rejection must not fail the retained WorkUnit");
  assert.deepEqual(f.store.getRunnerContinuation(activated.continuation.id), beforeContinuation);
  assert.deepEqual(f.store.database.prepare("SELECT * FROM runtime_events WHERE work_unit_id=? ORDER BY rowid").all(beforeUnit.id), beforeEvents);
});

test("new daemon recovery discovery resumes the stopped ordinary root once and ignores its completed successor", { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  let dispatches = 0, result;
  const coordinator = new DaemonRunnerRecoveryCoordinator({ runtimeSupervisor: f.supervisor, activeRuns: f.activeRuns,
    executeExistingRunContinuation: async input => {
      dispatches += 1; assert.equal(input.runId, f.run.id); assert.equal(input.preparedExecution, undefined);
      result = await f.recover(); return result.result;
    } });
  t.after(() => coordinator.beginShutdown());
  const scanned = coordinator.recoverStore(f.store); assert.equal(scanned.dispatched, 1);
  coordinator.recoverStore(f.store); await coordinator.waitForIdle();
  assert.deepEqual(result.errors, []); assert.equal(f.store.getRun(f.run.id).status, "succeeded");
  assert.equal(coordinator.recoverStore(f.store).dispatched, 0);
  assert.equal(dispatches, 1); assert.equal(f.transport.requests.length, 2);
});

test("a failed Core activation does not leave a reusable or stuck Host recovery receiver", { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  assert.throws(() => f.activate({ claim: { ...f.activation.claim, expiresAt: f.sourceAttempt.createdAt } }));
  assert.equal(f.store.listWorkUnitAttempts(f.run.workUnitId).length, 1);
  const valid = f.activate(); assert.equal(valid.kind, "activated");
  assert.equal(f.store.listWorkUnitAttempts(f.run.workUnitId).length, 2); assert.equal(f.transport.requests.length, 1);
});

test("credential changes after actual recovery resolution fail D1 and receiver cleanup permits a fresh valid attempt", { timeout: 20_000 }, async t => {
  const f = await fixture(t, { credential: true });
  f.afterNextCredentialRead(() => f.setCredential("changed-synthetic-key"));
  assert.throws(() => f.activate(), { code: "delegation.provider_revoked" });
  assert.equal(f.store.listWorkUnitAttempts(f.run.workUnitId).length, 1);
  f.setCredential("synthetic-recovery-key");
  assert.equal(f.activate().kind, "activated"); assert.equal(f.transport.requests.length, 1);
});

test("a preset without deterministic effective credential proof remains blocked, never borrowed from SDK ambient auth", { timeout: 20_000 }, async t => {
  const f = await fixture(t, { credential: false });
  assert.throws(() => f.activate(), { code: "delegation.provider_authority_unavailable" });
  assert.equal(f.store.listWorkUnitAttempts(f.run.workUnitId).length, 1);
  assert.equal(f.transport.requests.length, 1);
});

for (const options of [{ budget: false }, { budget: false, inline: true }, { budget: true }]) {
  test(`stopped root reopens with fresh Host authority and activates once: ${JSON.stringify(options)}`, { timeout: 20_000 }, async t => {
    const f = await fixture(t, options), result = f.activate();
    assert.equal(result.kind, "activated"); assert.equal(result.run.id, f.run.id);
    assert.equal(result.attempt.attemptNumber, 2); assert.notEqual(result.attempt.runtimeInstanceId, f.sourceAttempt.runtimeInstanceId);
    assert.ok(BigInt(result.attempt.fencingToken) > BigInt(f.sourceAttempt.fencingToken));
    assert.equal(f.store.listWorkUnitAttempts(f.run.workUnitId).length, 2);
    assert.equal(f.transport.requests.length, 1, "activation alone is neither SDK ACK nor permission for another model request");
    assert.deepEqual(f.store.database.prepare("SELECT * FROM delegation_root_budgets WHERE root_run_id=?").get(f.run.id), f.budgetBefore);
    assert.deepEqual(f.store.database.prepare("SELECT * FROM delegation_budget_charges ORDER BY id").all(), f.chargesBefore);
    const again = f.activate(); assert.equal(again.kind, "already_activated");
    assert.equal("attempt" in again, false); assert.equal("continuation" in again, false);
    assert.equal(f.store.listWorkUnitAttempts(f.run.workUnitId).length, 2);
    assert.equal("activateRootRunSuspension" in f.store, false);
  });
}

for (const change of ["receipt", "source", "provider", "policy", "runner", "supervisor"]) {
  test(`root recovery rejects ${change} drift without creating a replacement Attempt`, { timeout: 20_000 }, async t => {
    const f = await fixture(t), now = new Date().toISOString();
    if (change === "provider") f.store.updateProviderPreset(f.preset.id, { enabled: false }, now);
    if (change === "policy") f.store.updateApprovalPolicy({ toolDecisions: { read: "deny" } }, now);
    if (change === "runner") patchWorkspaceRuntimeSettings(f.store, f.runners, { allowedRunnerIds: [] }, now);
    const call = change === "supervisor"
      ? () => activateOriginalRootRunSuspension({ store: f.store, supervisor: { ...f.supervisor }, activation: f.activation })
      : () => f.activate(change === "receipt" ? { expectedReceiptDigest: "0".repeat(64) }
        : change === "source" ? { sourceFence: { ...f.activation.sourceFence, fencingToken: (BigInt(f.activation.sourceFence.fencingToken) + 1n).toString() } } : {});
    assert.throws(call);
    assert.equal(f.store.listWorkUnitAttempts(f.run.workUnitId).length, 1);
    assert.equal(f.store.getWorkUnit(f.run.workUnitId).status, "stale");
    assert.equal(f.store.getRun(f.run.id).status, "running"); assert.equal(f.transport.requests.length, 1);
    assert.equal(f.store.database.prepare("SELECT COUNT(*) n FROM run_suspension_root_activations").get().n, 0);
  });
}
