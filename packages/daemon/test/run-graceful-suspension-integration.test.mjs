import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteRunStore, resolveStoragePaths } from "@ling-stack/core";
import { resolveConfig } from "../dist/config.js";
import { createOriginalDelegationStoreComposition, readOriginalRunSuspensionLifecycle }
  from "../dist/features/harness/delegations/store-composition.js";
import { createDetachedRunExecutionSink, executeRunRequest } from "../dist/features/runs/orchestrator.js";
import { ActiveRunRegistry } from "../dist/runtime/active-runs.js";
import { runSuspensionOrderFor } from "../dist/runtime/run-suspension-order.js";
import { createRunShutdownCoordinator } from "../dist/runtime/run-shutdown-coordinator.js";
import { createRunnerRegistry } from "../dist/runtime/runners.js";
import { RunStoreRegistry } from "../dist/runtime/store-registry.js";
import { RuntimeSupervisor } from "../dist/runtime/supervisor.js";
import { createA21LoopbackTransport, createA21RealPiRunner } from "./support/noncompacted-recovery-crash-worker.mjs";

for (const unified of [false, true]) test(`ordinary Host shutdown seals an actual SDK read result before stopping its original source: unified=${unified}`, { timeout: 15_000 }, async t => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-graceful-host-integration-"));
  let stores, transport;
  const supervisor = new RuntimeSupervisor(resolveConfig({ defaultWorkspaceCwd: cwd,
    harness: { continuations: { mode: "enforce" } }, channels: { terminalReports: false } }));
  t.after(async () => {
    await transport?.close(); supervisor.releaseAll(); stores?.closeAll();
    await rm(cwd, { recursive: true, force: true });
  });
  await writeFile(join(cwd, "fixture.txt"), "one original read\n");
  transport = await createA21LoopbackTransport(count => count === 1
    ? { tool_calls: [{ index: 0, id: "original-read", type: "function",
      function: { name: "read", arguments: JSON.stringify({ path: "fixture.txt" }) } }] }
    : { content: "The next provider request must not be dispatched." });
  const runner = createA21RealPiRunner(transport), activeRuns = new ActiveRunRegistry();
  const originalRunTask = runner.runTask.bind(runner);
  let requested = false, directive, sealedView, boundaryError, sourceRunId, shutdownWork;
  const shutdown = createRunShutdownCoordinator({ activeRuns, delegations: { stopAdmission() {}, async settle() {} } });
  const checkpointReads = [];
  runner.runTask = options => originalRunTask({ ...options, onTaskContinuationBoundary: async (boundary, modelView) => {
    sourceRunId = options.runId;
    if (!requested && boundary === "before_provider_request"
      && modelView?.some(message => message.role === "toolResult")) {
      requested = true;
      // Persist through the actual registered Host callback; do not synthesize
      // a checkpoint, SDK stop exception or completion receipt in this fixture.
      if (unified) shutdownWork = shutdown.shutdown("daemon_restart");
      else await activeRuns.requestGracefulSuspension("daemon_restart");
      assert.equal(activeRuns.get(options.runId).abortController.signal.aborted, false);
      sealedView = structuredClone(modelView);
      try { directive = await options.onTaskContinuationBoundary(boundary, modelView); }
      catch (error) { boundaryError = error; throw error; }
      return directive;
    }
    return options.onTaskContinuationBoundary?.(boundary, modelView);
  } });
  const runners = createRunnerRegistry([{ id: "pi", displayName: "Real offline Pi SDK", status: "enabled", adapter: runner }]);
  const resolver = { resolve: () => ({ configured: false }) };
  const composition = createOriginalDelegationStoreComposition({ supervisor, runnerRegistry: runners, secretResolver: resolver });
  stores = new RunStoreRegistry(path => {
    const paths = resolveStoragePaths(path, { homeDir: join(cwd, "fixture-home"), env: {}, workspaceStateLocation: "repo-local" }).workspace;
    const store = new SqliteRunStore({ cwd: path, paths, delegationHostBinding: composition.binding });
    composition.bindExactStore(store); return store;
  });
  const store = stores.getStore(cwd), now = new Date().toISOString();
  const readCheckpoint = store.readRunProgressCheckpointForRecovery.bind(store);
  store.readRunProgressCheckpointForRecovery = input => {
    const result = readCheckpoint(input); checkpointReads.push(result); return result;
  };
  const preset = store.createProviderPreset({ kind: "openai-compatible", displayName: "Owned offline provider",
    providerId: "graceful-owned-fixture", model: "fixture", api: "openai-completions", baseUrl: "https://fixture.invalid/v1",
    authHeader: false, reasoning: false, capabilities: ["chat", "tool_call"], enabled: true }, now);
  store.recordProviderCheckResult(preset.id, { ok: true, code: "ready", message: "Synthetic transport", checkedAt: now });
  const thread = store.createLingThread({ kind: "conversation", teammateId: "ling_agent", title: "Graceful original source",
    objective: "Read the dedicated fixture once" }, now);
  const errors = [];
  const runId = await executeRunRequest({ cwd, workspaceCwd: cwd, threadId: thread.id, teammateId: "ling_agent",
    providerPresetId: preset.id, tools: ["read"], authorizationMode: "smart", workspaceAccessMode: "workspace_write",
    task: { id: "original-source", title: "Original read", prompt: "Read fixture.txt exactly once, then describe it." },
    idempotencyKey: "graceful-original-source" },
  { ...createDetachedRunExecutionSink(), writeError: (_status, body) => errors.push(body) },
  runners, stores, activeRuns, supervisor, resolver, {}).catch(error => {
    t.diagnostic(JSON.stringify(store.listEvents(sourceRunId, { limit: 1000 }).map(event => ({
      seq: event.seq, type: event.type, data: event.data }))));
    throw error;
  });
  assert.equal(requested, true);
  if (boundaryError) {
    const verified = checkpointReads.find(result => result.kind === "verified");
    assert.ok(verified, JSON.stringify(checkpointReads));
    assert.deepEqual(verified.modelView, sealedView);
  }
  assert.equal(boundaryError, undefined);
  assert.deepEqual(errors, []);
  assert.equal(directive?.kind, "runtime_suspension");
  await activeRuns.waitForIdle();
  await activeRuns.waitForGracefulSuspensionRequests();
  await runSuspensionOrderFor(activeRuns).waitForAllFinished();
  await shutdownWork;
  assert.equal(transport.requests.length, 1);
  const run = store.getRun(runId), unit = store.getWorkUnit(run.workUnitId), attempt = store.getWorkUnitAttempt(unit.activeAttemptId);
  assert.equal(run.status, "running", "logical Run must stay open, not publish an invented final reply");
  assert.equal(unit.status, "stale"); assert.equal(attempt.status, "lost");
  assert.equal(attempt.errorCode, "runtime_graceful_suspend");
  const lifecycle = readOriginalRunSuspensionLifecycle(store, supervisor);
  const suspended = lifecycle.getRunSuspensionForAttempt(attempt.id), stopped = lifecycle.getRunSuspensionStop(suspended.id);
  assert.equal(suspended.state, "sealed"); assert.equal(stopped.state, "stopped");
  assert.equal(stopped.begin.source.kind, "root");
  assert.equal(stopped.receipt.sourceFence.attemptId, attempt.id);
  const completion = store.getHostAttemptCompletion({ runId, ...stopped.begin.sourceFence });
  assert.ok(completion?.drainedAt); assert.equal(completion.effectCoverage, "pi_tracked_tools_v1");
  assert.equal(sealedView.filter(message => message.role === "toolResult").length, 1);
  const events = store.listEvents(runId, { limit: 1000 });
  assert.equal(events.filter(event => event.type === "tool_end").length, 1);
  assert.equal(events.some(event => ["run_completed", "run_error", "run_cancelled"].includes(event.type)), false);
  assert.equal(store.listWorkUnitAttempts(unit.id).length, 1);
});
