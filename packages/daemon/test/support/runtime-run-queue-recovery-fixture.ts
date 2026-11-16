import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createCompositeSecretResolver, createSqliteRunStore, type RunStore,
  type RuntimeRunQueueClaim } from "../../../core/dist/index.js";
import type { PiRunnerRunOptions } from "../../../runner-pi/dist/index.js";
import { resolveConfig } from "../../dist/config.js";
import type { McpBroker } from "../../dist/context.js";
import { DaemonRunnerRecoveryCoordinator } from "../../dist/features/harness/continuations/daemon-recovery-coordinator.js";
import { createDetachedRunExecutionSink, executeExistingRunContinuation, executeQueuedRunRequest,
  executeRunRequest } from "../../dist/features/runs/orchestrator.js";
import { ActiveRunRegistry } from "../../dist/runtime/active-runs.js";
import { RuntimeRunQueueCoordinator } from "../../dist/runtime/run-queue.js";
import { createRunnerRegistry } from "../../dist/runtime/runners.js";
import { RunStoreRegistry } from "../../dist/runtime/store-registry.js";
import { RuntimeSupervisor } from "../../dist/runtime/supervisor.js";
import { ToolFreePiRunner } from "./tool-free-pi-runner.mjs";

type Completion = ReturnType<typeof executeRunRequest>;
type Call = { runId?: string; attemptId?: string };
type Ready = { runId?: string; queued?: boolean; error?: unknown };
type Provider = ReturnType<RunStore["createProviderPreset"]>;
type Channel = ReturnType<RunStore["createChannel"]>;
type ScriptedRunTask = (options: PiRunnerRunOptions,
  reply: () => string | Promise<string>) => ReturnType<ToolFreePiRunner["runTask"]>;

export interface RecoveryBoundary {
  kind: "queue_dispatch_committed";
  pid: number;
  paths: RunStore["paths"];
  runtimeInstanceId: string;
  holderRunId: string;
  unknownRunId: string;
  independentRunId: string;
  calls: Call[];
  sdkCalls: Call[];
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(done => { resolve = done; }), resolve: (value: T) => resolve(value) };
}

export async function waitForRecoveryCondition(predicate: () => boolean, label: string,
  describe: () => unknown = () => ({})) {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`${label}: ${JSON.stringify(describe())}`);
}

/** Real startup ownership and both discovery coordinators share the reopened SQLite Store. */
export function openRuntimeRunQueueRecovery(cwd: string, paths?: RunStore["paths"],
  queuedReady?: (runId: string) => void) {
  const calls: Call[] = [], sdkCalls: Call[] = [], claims: RuntimeRunQueueClaim[] = [];
  const continuationCalls: Parameters<typeof executeExistingRunContinuation>[0][] = [];
  const errors: { runId?: string; claim?: RuntimeRunQueueClaim; status: number; body: unknown }[] = [], failures: unknown[] = [];
  const releases = new Map<string, ReturnType<typeof deferred<void>>>();
  const completions = new Set<Completion>();
  let cleaningUp = false;
  class Runner extends ToolFreePiRunner {
    async runTask(options: PiRunnerRunOptions) {
      assert.ok(options.runId);
      const release = deferred<void>();
      releases.set(options.runId, release);
      calls.push({ runId: options.runId, attemptId: options.runnerAttemptId });
      if (cleaningUp) release.resolve();
      return (super.runTask as ScriptedRunTask).call(this, options, async () => {
        sdkCalls.push({ runId: options.runId, attemptId: options.runnerAttemptId });
        await release.promise;
        return `Inspected ${options.task.title}.`;
      });
    }
  }
  const runner = new Runner();
  const runners = createRunnerRegistry([{ id: "pi", displayName: "Recovery SDK fixture",
    status: "enabled", adapter: runner }]);
  const supervisor = new RuntimeSupervisor(resolveConfig({ defaultWorkspaceCwd: cwd,
    concurrency: { enabled: true, maxConcurrentRuns: 1, maxReadOnlyRuns: 4,
      maxWorkspaceWriteRuns: 4, maxRunsPerProvider: 4, maxRunsPerRunner: 4 } }));
  const activeRuns = new ActiveRunRegistry();
  const stores = new RunStoreRegistry(root => createSqliteRunStore(root, paths), {
    beforeRecovery: (root, store) => { supervisor.getRuntime(root, store); },
  });
  const store = stores.getStore(cwd);
  const secretResolver = createCompositeSecretResolver({ env: {} }), mcpBroker = {} as McpBroker;
  const track = (completion: Completion) => {
    completions.add(completion);
    void completion.then(() => completions.delete(completion), error => {
      failures.push(error);
      completions.delete(completion);
    });
    return completion;
  };
  const sink = (runId?: string, claim?: RuntimeRunQueueClaim) => ({ ...createDetachedRunExecutionSink(),
    writeError: (status: number, body: unknown) => { errors.push({ runId, claim, status, body }); } });
  const queue = new RuntimeRunQueueCoordinator({ runtimeSupervisor: supervisor, activeRuns, intervalMs: 20,
    execute: ({ store, claim, executionOptions }) => {
      claims.push(claim);
      return track(executeQueuedRunRequest({ store, claim }, { ...sink(claim.runId, claim),
        writeReady: body => {
          const ready = body as Ready;
          if (ready.runId && !ready.queued) queuedReady?.(ready.runId);
        } }, runners, stores, activeRuns, supervisor, secretResolver, mcpBroker, executionOptions));
    },
  });
  const recovery = new DaemonRunnerRecoveryCoordinator({ runtimeSupervisor: supervisor, activeRuns, scanIntervalMs: 20,
    executeExistingRunContinuation: input => {
      continuationCalls.push(input);
      return track(executeExistingRunContinuation(input, sink(input.runId), runners, stores, activeRuns,
        supervisor, secretResolver, mcpBroker));
    },
  });
  queue.registerStore(store);
  recovery.registerStore(store);
  const provider = (name: string) => {
    const now = new Date().toISOString();
    const preset = store.createProviderPreset({ kind: "openai-compatible", displayName: name,
      providerId: `queue-recovery-${name}`, model: "queue-model", api: "openai-completions",
      baseUrl: "https://queue.fixture.invalid/v1", capabilities: ["chat", "tool_call"], authHeader: false,
      reasoning: false, enabled: true }, now);
    store.recordProviderCheckResult(preset.id, { ok: true, code: "ready",
      message: "Local scripted SDK transport", checkedAt: now });
    return preset;
  };
  const channelFor = (name: string, preset: Provider) => store.createChannel({ name, boundPath: cwd,
    defaultProviderPresetId: preset.id, allowedTools: ["read"],
    runtimePolicy: { queueOnConflict: true, maxConcurrentRuns: 3 } }, new Date().toISOString());
  const dispatch = async (name: string, channel: Channel, preset: Provider) => {
    const task = store.createTask({ channelId: channel.id, title: name, prompt: `Frozen objective ${name}` }, new Date().toISOString());
    const started = deferred<Ready>();
    const completion = track(executeRunRequest({ cwd, workspaceCwd: cwd, task, providerPresetId: preset.id,
      tools: ["read"], idempotencyKey: `queue-recovery-${task.id}`, createdByActor: "local-user" },
    { ...sink(), writeReady: body => started.resolve(body as Ready),
      writeError: (status, body) => { errors.push({ status, body }); started.resolve({ error: body }); } },
    runners, stores, activeRuns, supervisor, secretResolver, mcpBroker));
    const ready = await started.promise;
    assert.ok(ready.runId, JSON.stringify({ ready, errors, failures }));
    return { runId: ready.runId, task, ready, completion };
  };
  return { store, stores, supervisor, activeRuns, queue, recovery, calls, sdkCalls, claims, continuationCalls,
    errors, failures, provider, channelFor, dispatch,
    release(runId: string) { assert.ok(releases.has(runId)); releases.get(runId)!.resolve(); },
    start() { recovery.start(); queue.start(); },
    async close() {
      cleaningUp = true;
      queue.beginShutdown();
      recovery.beginShutdown();
      for (const release of releases.values()) release.resolve();
      await Promise.allSettled([...completions]);
      await queue.waitForIdle();
      await recovery.waitForIdle();
      await activeRuns.waitForIdle();
      try { supervisor.releaseAll(); }
      finally { stores.closeAll(); }
    },
  };
}

async function runCrashWorker(cwd: string) {
  assert.equal(process.env.LING_STACK_DEFAULT_WORKSPACE_CWD, cwd);
  let boundary: RecoveryBoundary | undefined;
  const f = openRuntimeRunQueueRecovery(cwd, undefined, runId => {
    assert.ok(boundary);
    assert.equal(runId, boundary.unknownRunId);
    const entry = f.store.getRuntimeRunQueueEntry(runId)!;
    assert.ok(entry.dispatchedAt);
    const run = f.store.getRun(runId)!, unit = f.store.getWorkUnit(run.workUnitId!)!;
    assert.equal(run.status, "queued");
    assert.equal(unit.status, "claimed");
    assert.equal(f.store.getWorkUnitAttempt(unit.activeAttemptId!)!.status, "created");
    assert.deepEqual(f.calls.map(call => call.runId), [boundary.holderRunId]);
    assert.deepEqual(f.sdkCalls.map(call => call.runId), [boundary.holderRunId]);
    assert.equal(f.store.getRun(boundary.holderRunId)!.status, "succeeded");
    assert.equal(f.store.listRuntimeSemaphoreSlots({ status: "active" }).length, 3);
    assert.equal(f.store.getRuntimeRunQueueEntry(boundary.independentRunId)!.dispatchedAt, undefined);
    // A synchronous transport boundary prevents Runner start and all executor/finally cleanup.
    // The parent observes committed rows through a second connection, then kills this process.
    writeSync(1, `${JSON.stringify({ ...boundary, calls: f.calls, sdkCalls: f.sdkCalls })}\n`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    assert.fail("Crash boundary resumed without process exit");
  });
  const preset = f.provider("source"), channel = f.channelFor("Source queue", preset);
  const holder = await f.dispatch("Capacity holder", channel, preset);
  await waitForRecoveryCondition(() => f.sdkCalls.length === 1, "holder entered the real SDK transport");
  const unknown = await f.dispatch("Committed gate", channel, preset);
  assert.equal(unknown.ready.queued, true);
  await unknown.completion;
  const independentPreset = f.provider("independent"), independentChannel = f.channelFor("Independent queue", independentPreset);
  const independent = await f.dispatch("Independent group", independentChannel, independentPreset);
  assert.equal(independent.ready.queued, true);
  await independent.completion;
  assert.notEqual(f.store.getRuntimeRunQueueEntry(unknown.runId)!.groupKey,
    f.store.getRuntimeRunQueueEntry(independent.runId)!.groupKey);
  boundary = { kind: "queue_dispatch_committed", pid: process.pid, paths: f.store.paths,
    runtimeInstanceId: f.supervisor.getRuntime(cwd, f.store).runtimeInstanceId,
    holderRunId: holder.runId, unknownRunId: unknown.runId, independentRunId: independent.runId, calls: [], sdkCalls: [] };
  f.release(holder.runId);
  await holder.completion;
  await waitForRecoveryCondition(() => f.store.listRuntimeSemaphoreSlots({ status: "active" }).length === 0,
    "the real holder drained before queue dispatch");
  f.queue.start();
  // The coordinator's unref'd timer cannot keep the source process alive until admission is due.
  await waitForRecoveryCondition(() => f.store.getRuntimeRunQueueEntry(unknown.runId)!.dispatchedAt !== undefined,
    "source queue reached its committed gate", () => ({ claims: f.claims, errors: f.errors, failures: f.failures,
      entry: f.store.getRuntimeRunQueueEntry(unknown.runId) }));
  assert.fail("Committed queue dispatch bypassed the crash boundary");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void runCrashWorker(process.argv[2]!).catch(error => {
    writeSync(2, `${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}
