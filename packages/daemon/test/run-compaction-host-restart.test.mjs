import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createSqliteRunStore, toRuntimeAttemptFence } from "@ling-stack/core";
import { PiRunnerAdapter } from "@ling-stack/runner-pi";
import { stream } from "../../runner-pi/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js";
import { resolveConfig } from "../dist/config.js";
import { DaemonRunnerRecoveryCoordinator } from "../dist/features/harness/continuations/daemon-recovery-coordinator.js";
import { createDetachedRunExecutionSink, executeExistingRunContinuation } from "../dist/features/runs/orchestrator.js";
import { ActiveRunRegistry } from "../dist/runtime/active-runs.js";
import { createRunnerRegistry } from "../dist/runtime/runners.js";
import { RunStoreRegistry } from "../dist/runtime/store-registry.js";
import { RuntimeSupervisor } from "../dist/runtime/supervisor.js";

function finalResponse() {
  const records = [
    { choices: [{ index: 0, delta: { content: "The marker was already written before restart." }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: 100, completion_tokens: 16, total_tokens: 116 } },
  ];
  return new Response(records.map((record) => `data: ${JSON.stringify(record)}\n\n`).join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } });
}

async function waitForCondition(predicate, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(typeof message === "function" ? message() : message);
}

for (const mode of ["crash", "initial-crash"]) {
test(`auto-compacted Host Run restarts at ${mode} without replaying prior effects`, { timeout: 40_000 }, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-host-compaction-crash-"));
  const child = fork(fileURLToPath(new URL("./support/host-compaction-crash-child.mjs", import.meta.url)), [cwd, mode],
    { stdio: ["ignore", "pipe", "pipe", "ipc"], execArgv: [] });
  let stores;
  let supervisor;
  let coordinator;
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await waitForCondition(() => child.exitCode !== null || child.signalCode !== null,
        "crash fixture did not exit after kill", 5_000);
    }
    coordinator?.beginShutdown();
    supervisor?.releaseAll();
    stores?.closeAll();
    await rm(cwd, { recursive: true, force: true });
  });
  const childStderr = [];
  child.stderr.on("data", (chunk) => {
    if (childStderr.length < 10) childStderr.push(String(chunk).slice(0, 1_000));
  });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Child never reached the sealed write boundary.")), 20_000);
    child.on("message", (message) => {
      if (message?.type === "ready") {
        clearTimeout(timer);
        resolve(message);
      } else if (message?.type === "error" || message?.type === "unexpected_completion") {
        clearTimeout(timer);
        reject(new Error(JSON.stringify({ message, childStderr })));
      }
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`Child exited before checkpoint: ${code ?? signal}; ${childStderr.join(" ")}`));
    });
  });
  assert.ok(ready.summaryRequests > 0, "the source Run must use actual Pi auto-compaction");
  if (mode === "crash") assert.equal(await readFile(join(cwd, "effect-marker.txt"), "utf8"), "COMMITTED_ONCE\n");
  else await assert.rejects(readFile(join(cwd, "effect-marker.txt"), "utf8"), { code: "ENOENT" });
  assert.equal(child.kill("SIGKILL"), true);
  await waitForCondition(() => child.exitCode !== null || child.signalCode !== null,
    "crash fixture did not exit after kill", 5_000);

  stores = new RunStoreRegistry(createSqliteRunStore);
  supervisor = new RuntimeSupervisor(resolveConfig({
    defaultWorkspaceCwd: cwd,
    harness: { continuations: { mode: "enforce" } },
  }));
  const activeRuns = new ActiveRunRegistry();
  const store = stores.getStore(cwd);
  const sourceRun = store.getRun(ready.runId);
  const sourceUnit = store.getWorkUnit(sourceRun.workUnitId);
  const sourceAttempt = store.getWorkUnitAttempt(sourceUnit.activeAttemptId);
  const source = { runId: ready.runId, ...toRuntimeAttemptFence(sourceAttempt) };
  assert.equal(store.getHostAttemptCompletion(source).drainedAt, undefined);
  const sourceCheckpoint = store.getLatestRunCompactionCheckpoint(ready.runId);
  const sourceBoundary = {
    checkpoint: sourceCheckpoint,
    events: store.listEvents(ready.runId, { afterSeq: sourceCheckpoint.sourceEventSeq }).map(event => ({
      seq: event.seq, type: event.type, attemptId: event.data.attemptId, outcome: event.data.outcome,
      toolCallId: event.data.toolCallId,
    })),
    blockers: store.listHostOperationBlockers(source),
  };
  let modelRequests = 0;
  let installedRecoveryView;
  class RecoveryRunner extends PiRunnerAdapter {
    async prepareTaskInput(options) {
      return super.prepareTaskInput({ ...options, provider: { ...options.provider, apiKey: "fixture-no-network" } });
    }

    async runTask(options) {
      installedRecoveryView = options.compactionRecovery?.modelView;
      return super.runTask({ ...options, provider: { ...options.provider, apiKey: "fixture-no-network" } });
    }

    registerCustomProviderIfNeeded(runtime, provider) {
      super.registerCustomProviderIfNeeded(runtime, provider);
      runtime.registerProvider(provider.provider, { api: "openai-completions",
        streamSimple: (model, context, options) => stream(model, context, { ...options,
          fetch: async () => { modelRequests += 1; return finalResponse(); },
        }),
      });
    }
  }
  const errors = [];
  coordinator = new DaemonRunnerRecoveryCoordinator({
    runtimeSupervisor: supervisor,
    activeRuns,
    executeExistingRunContinuation: (input) => executeExistingRunContinuation(input,
      { ...createDetachedRunExecutionSink(), writeError: (_status, body) => errors.push(body) },
      createRunnerRegistry([{ id: "pi", displayName: "Real Pi SDK recovery", status: "enabled",
        adapter: new RecoveryRunner() }]),
      stores, activeRuns, supervisor, { resolve: () => ({ configured: false }) }, {}),
  });
  coordinator.registerStore(store);
  coordinator.start();
  await waitForCondition(() => ["succeeded", "failed"].includes(store.getRun(ready.runId)?.status),
    () => {
      const run = store.getRun(ready.runId);
      const unit = run?.workUnitId ? store.getWorkUnit(run.workUnitId) : undefined;
      return `recovered Host Run did not settle: ${JSON.stringify({ errors, modelRequests,
        runStatus: run?.status, runError: run?.errorMessage,
        unit: unit && { status: unit.status, activeAttemptId: unit.activeAttemptId, attemptCount: unit.attemptCount },
        attempts: unit ? store.listWorkUnitAttempts(unit.id).map(attempt => ({ id: attempt.id,
          status: attempt.status, error: attempt.errorMessage })) : [],
        leases: store.listResourceLeases({ status: "active" }),
        slots: store.listRuntimeSemaphoreSlots({ status: "active" }),
      })}`;
    });
  assert.equal(store.getRun(ready.runId)?.status, "succeeded", JSON.stringify({ errors,
    runError: store.getRun(ready.runId)?.errorMessage, sourceBoundary }));
  assert.equal(modelRequests, 1);
  assert.ok(installedRecoveryView?.length > 0, "recovery must install the exact compacted view");
  if (mode === "crash") assert.ok(installedRecoveryView.some((message) => message.role === "toolResult"
    && message.toolCallId === "crash-write-once"), "recovery must install the sealed write result");
  const events = store.listEvents(ready.runId);
  const installed = events.find((event) => event.type === "context_compaction_end"
    && event.data.outcome === "sdk_installed");
  const failedRead = events.find((event) => event.type === "tool_end"
    && event.data.toolCallId === "crash-read-missing" && event.data.isError);
  assert.ok(installed);
  if (mode === "crash") assert.ok(failedRead && installed.seq < failedRead.seq,
    "the failed read must occur after real SDK compaction in this Run");
  assert.equal(events.filter((event) => event.type === "tool_end"
    && event.data.toolCallId === "crash-read-missing" && event.data.isError).length, mode === "crash" ? 1 : 0,
  "a failed read must remain one error fact across restart");
  assert.equal(events.filter((event) => event.type === "tool_end"
    && event.data.toolName === "write" && !event.data.isError).length, mode === "crash" ? 1 : 0);
  if (mode === "crash") assert.equal(await readFile(join(cwd, "effect-marker.txt"), "utf8"), "COMMITTED_ONCE\n");
  else await assert.rejects(readFile(join(cwd, "effect-marker.txt"), "utf8"), { code: "ENOENT" });
  assert.equal(store.getHostAttemptCompletion(source).drainedAt, undefined);
  assert.equal(store.getHostAttemptCompletion(source).effectCoverage, undefined);
  const leases = store.listResourceLeases().filter(row => row.attemptId === source.attemptId);
  const slots = store.listRuntimeSemaphoreSlots().filter(row => row.attemptId === source.attemptId);
  assert.ok(leases.length > 0 && slots.length > 0);
  assert.match(leases[0].releaseReason, /^compaction-checkpoint-handoff:/u);
  for (const resource of [...leases, ...slots]) {
    assert.equal(resource.status, "released");
    assert.equal(resource.releaseReason, leases[0].releaseReason);
  }
});
}

test("cancelling the same auto-compacted Host Run after a failed read and write prevents restart replay", { timeout: 40_000 }, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-host-compaction-cancel-"));
  const child = fork(fileURLToPath(new URL("./support/host-compaction-crash-child.mjs", import.meta.url)), [cwd, "cancel"],
    { stdio: ["ignore", "pipe", "pipe", "ipc"], execArgv: [] });
  let stores;
  let supervisor;
  let coordinator;
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await waitForCondition(() => child.exitCode !== null || child.signalCode !== null,
        "cancel fixture did not exit after kill", 5_000);
    }
    coordinator?.beginShutdown();
    supervisor?.releaseAll();
    stores?.closeAll();
    await rm(cwd, { recursive: true, force: true });
  });
  const messages = [];
  const childStderr = [];
  child.on("message", (message) => messages.push(message));
  child.stderr.on("data", (chunk) => {
    if (childStderr.length < 10) childStderr.push(String(chunk).slice(0, 1_000));
  });
  const waitForMessage = async (type) => {
    await waitForCondition(() => messages.some((message) => message?.type === type)
      || messages.some(message => message?.type === "error" || message?.type === "unexpected_completion"
        || (type === "ready" && message?.type === "completed"))
      || child.exitCode !== null || child.signalCode !== null,
    () => `Child did not send ${type}: ${JSON.stringify({ messages, childStderr,
      exitCode: child.exitCode, signalCode: child.signalCode })}`, 20_000);
    const error = messages.find((message) => message?.type === "error");
    assert.equal(error, undefined, JSON.stringify({ error, childStderr }));
    const matching = messages.find((message) => message?.type === type);
    assert.ok(matching, JSON.stringify({ messages, childStderr }));
    return matching;
  };
  const ready = await waitForMessage("ready");
  assert.ok(ready.summaryRequests > 0);
  assert.equal(await readFile(join(cwd, "effect-marker.txt"), "utf8"), "COMMITTED_ONCE\n");
  child.send({ type: "cancel" });
  const completed = await waitForMessage("completed");
  assert.equal(completed.status, "cancelled", JSON.stringify(completed));
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await waitForCondition(() => child.exitCode !== null || child.signalCode !== null,
    "cancel fixture did not exit after completion", 5_000);

  stores = new RunStoreRegistry(createSqliteRunStore);
  supervisor = new RuntimeSupervisor(resolveConfig({
    defaultWorkspaceCwd: cwd,
    harness: { continuations: { mode: "enforce" } },
  }));
  const activeRuns = new ActiveRunRegistry();
  const store = stores.getStore(cwd);
  let runnerCalls = 0;
  class ForbiddenReplayRunner extends PiRunnerAdapter {
    async runTask() { runnerCalls += 1; throw new Error("Cancelled Run must not restart."); }
  }
  coordinator = new DaemonRunnerRecoveryCoordinator({
    runtimeSupervisor: supervisor,
    activeRuns,
    executeExistingRunContinuation: (input) => executeExistingRunContinuation(input,
      createDetachedRunExecutionSink(),
      createRunnerRegistry([{ id: "pi", displayName: "Forbidden replay", status: "enabled",
        adapter: new ForbiddenReplayRunner() }]),
      stores, activeRuns, supervisor, { resolve: () => ({ configured: false }) }, {}),
  });
  coordinator.registerStore(store);
  coordinator.start();
  assert.equal(coordinator.recoverStore(store).dispatched, 0);
  assert.equal(store.getRun(ready.runId)?.status, "cancelled");
  assert.equal(runnerCalls, 0);
  const events = store.listEvents(ready.runId);
  const installed = events.find((event) => event.type === "context_compaction_end"
    && event.data.outcome === "sdk_installed");
  const failedRead = events.find((event) => event.type === "tool_end"
    && event.data.toolCallId === "crash-read-missing" && event.data.isError);
  assert.ok(installed && failedRead && installed.seq < failedRead.seq);
  assert.equal(events.filter((event) => event.type === "tool_end"
    && event.data.toolCallId === "crash-read-missing" && event.data.isError).length, 1);
  assert.equal(events.filter((event) => event.type === "tool_end"
    && event.data.toolCallId === "crash-write-once" && !event.data.isError).length, 1);
  assert.equal(await readFile(join(cwd, "effect-marker.txt"), "utf8"), "COMMITTED_ONCE\n");
});
