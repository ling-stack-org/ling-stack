/// <reference lib="es2023.array" />

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { createCompositeSecretResolver, createSqliteRunStore, SqliteRunStore, resolveStoragePaths, normalizeWorkflowIntegrationRoundInputs, toRuntimeAttemptFence,
  workflowIsolationSafetyFingerprint, workflowIsolationStepSafetyFingerprint, type EffectiveRunPolicySnapshot,
  type RunSession, type RunStore, type RuntimeRunQueueClaim, type RuntimeRunQueueEntry,
  type SecretResolver, type WorkUnit, type WorkUnitAttempt } from "../../core/dist/index.js";
import { testDatabase } from "../../core/test/support/sqlite-test-database.ts";
import { hostCapacityFixture } from "../../core/test/support/runtime-host-capacity-fixture.ts";
import { createRuntimeHostCapacityStoreBinding, type HostRunCapacityStore }
  from "../../core/dist/runtime-host-capacity-store-bridge.js";
import type { PiRunnerRunOptions } from "../../runner-pi/dist/index.js";
import { resolveConfig } from "../dist/config.js";
import type { McpBroker } from "../dist/context.js";
import { createDetachedRunExecutionSink, executeQueuedRunRequest, executeRunRequest, type ExecuteRunRequestOptions }
  from "../dist/features/runs/orchestrator.js";
import type { PreparedRunnerInput } from "../dist/features/runs/prepared-runner-input.js";
import { ensureRunCancelled } from "../dist/features/runs/cancellation.js";
import { assertWorkflowRepositoryRunAllowed, releaseWorkflowRepositoryFence, reserveWorkflowRepositoryFence }
  from "../dist/features/workspaces/workflow-repository-fence.js";
import { inspectWorkflowGitRepository, workflowGitRepositoryBasisDigest }
  from "../dist/features/workspaces/workflow-git-repository.js";
import { ActiveRunRegistry } from "../dist/runtime/active-runs.js";
import { createRuntimeHostCapacityAdmission, RuntimeRunQueueCoordinator, type RuntimeHostCapacityAdmission } from "../dist/runtime/run-queue.js";
import { createRunnerRegistry, type RunnerRegistry } from "../dist/runtime/runners.js";
import { loadWorkspaceRuntimeSettings, patchWorkspaceRuntimeSettings } from "../dist/runtime/runner-settings.js";
import { RunStoreRegistry } from "../dist/runtime/store-registry.js";
import { RuntimeSupervisor } from "../dist/runtime/supervisor.js";
import { ToolFreePiRunner } from "./support/tool-free-pi-runner.mjs";

const exec = promisify(execFile);

type Store = RunStore;
type Preset = ReturnType<Store["createProviderPreset"]>;
type Channel = ReturnType<Store["createChannel"]>;
type Completion = ReturnType<typeof executeRunRequest>;
type Call = { runId?: string; attemptId?: string; prepared: PiRunnerRunOptions["preparedInput"]; task: PiRunnerRunOptions["task"] };
type SdkCall = Pick<Call, "runId" | "attemptId">;
type QueueError = { runId?: string; status: number; body: { error: string } };
type Ready = { runId?: string; queued?: boolean; error?: unknown };
type Dispatch = { task: ReturnType<Store["createTask"]>; completion: Completion; runId: string; ready: Ready };
type DispatchOptions = { store?: Store; channel?: Channel; preset?: Preset; teammateId?: string };
type Source = { run: RunSession & { requestSnapshot: { runnerExecutionInput: PreparedRunnerInput;
  effectivePolicySnapshot: EffectiveRunPolicySnapshot } }; unit: WorkUnit; attempt: WorkUnitAttempt };
type Execution = { claim: RuntimeRunQueueClaim; settled: boolean };
type ScriptedRunTask = (options: PiRunnerRunOptions, reply: () => string | Promise<string>) => ReturnType<ToolFreePiRunner["runTask"]>;

interface Fixture {
  cwd: string;
  calls: Call[];
  sdkCalls: SdkCall[];
  executions: Execution[];
  errors: QueueError[];
  ready: unknown[];
  terminals: string[];
  closed: boolean;
  cleaningUp: boolean;
  runner: ToolFreePiRunner & { preparations: number };
  runners: RunnerRegistry;
  supervisor: RuntimeSupervisor;
  activeRuns: ActiveRunRegistry;
  stores: RunStoreRegistry;
  store: Store;
  host?: HostRunCapacityStore;
  queue: RuntimeRunQueueCoordinator;
  preset: Preset;
  channel: Channel;
  beforeQueuedExecution?: (claim: RuntimeRunQueueClaim) => Promise<void>;
  executeClaim(claim: RuntimeRunQueueClaim, executionOptions?: ExecuteRunRequestOptions, store?: Store): Completion;
  pauseQueuedExecution(runId: string): { entered: Promise<RuntimeRunQueueClaim>; resume(): void };
  open(start?: boolean): void;
  close(): Promise<void>;
  provider(name: string, store?: Store): Preset;
  channelFor(name: string, options?: Pick<DispatchOptions, "store" | "preset">): Channel;
  addWorkspace(name: string): Promise<{ cwd: string; store: Store; preset: Preset; channel: Channel }>;
  release(index: number): void;
  describe(): unknown;
  dispatch(name: string, options?: DispatchOptions): Promise<Dispatch>;
  source(runId: string, store?: Store): Source;
  slots(runId: string, store?: Store): ReturnType<Store["listRuntimeSemaphoreSlots"]>;
  resources(runId: string, store?: Store): { leases: ReturnType<Store["listResourceLeases"]>;
    slots: ReturnType<Store["listRuntimeSemaphoreSlots"]> };
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(done => { resolve = done; }), resolve: (value: T) => resolve(value) };
}

async function until(predicate: () => boolean, label: string, describe: () => unknown = () => ({})) {
  const end = Date.now() + 10_000;
  while (Date.now() < end) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`${label}: ${JSON.stringify(describe())}`);
}

/** Uses the original Pi SDK with an in-process scripted transport, never an external Provider. */
async function fixture(t: TestContext, { startQueue = true, secretResolver = createCompositeSecretResolver({ env: {} }), hostMaximum }: {
  startQueue?: boolean; secretResolver?: SecretResolver; hostMaximum?: number;
} = {}): Promise<Fixture> {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "ling-runtime-run-queue-integration-")));
  const roots = [cwd], calls: Call[] = [], sdkCalls: SdkCall[] = [];
  const releases: ReturnType<typeof deferred<void>>[] = [], barriers: ReturnType<typeof deferred<void>>[] = [], executions: Execution[] = [];
  const completions = new Set<Completion>(), errors: QueueError[] = [], ready: unknown[] = [], terminals: string[] = [];
  const mcpBroker = {} as McpBroker;
  // Runtime handles and fixture methods are installed before returning this object.
  const f = { cwd, calls, sdkCalls, executions, errors, ready, terminals, closed: false, cleaningUp: false } as Fixture;
  const host = hostMaximum === undefined ? undefined : hostCapacityFixture(t, { maximum: hostMaximum });
  f.host = host?.host;
  class Runner extends ToolFreePiRunner {
    preparations = 0;
    async prepareTaskInput(options: PiRunnerRunOptions) { this.preparations++; return super.prepareTaskInput(options); }
    async runTask(options: PiRunnerRunOptions) {
      const release = deferred();
      releases.push(release);
      calls.push({ runId: options.runId, attemptId: options.runnerAttemptId,
        prepared: structuredClone(options.preparedInput), task: structuredClone(options.task) });
      if (f.cleaningUp) release.resolve();
      // The JavaScript helper awaits scripted replies in the SDK transport.
      return (super.runTask as ScriptedRunTask).call(this, options, async () => {
        sdkCalls.push({ runId: options.runId, attemptId: options.runnerAttemptId });
        await release.promise;
        return `Inspected ${options.task.title}.`;
      });
    }
  }
  f.runner = new Runner();
  f.runners = createRunnerRegistry([{ id: "pi", displayName: "Queue SDK fixture", status: "enabled", adapter: f.runner }]);
  const config = resolveConfig({ defaultWorkspaceCwd: cwd, concurrency: { enabled: true,
    maxConcurrentRuns: 1, maxReadOnlyRuns: 1, maxWorkspaceWriteRuns: 1,
    maxRunsPerProvider: 1, maxRunsPerRunner: 1 } });
  f.executeClaim = (claim, executionOptions = {}, store = f.store) => {
    const completion = executeQueuedRunRequest({ store, claim },
      { ...createDetachedRunExecutionSink(), writeError: (status, body) => errors.push({ runId: claim.runId, status,
        body: body as QueueError["body"] }) },
      f.runners, f.stores, f.activeRuns, f.supervisor, secretResolver, mcpBroker, executionOptions);
    completions.add(completion);
    void completion.finally(() => completions.delete(completion));
    return completion;
  };
  f.pauseQueuedExecution = runId => {
    const entered = deferred<RuntimeRunQueueClaim>(), resume = deferred();
    barriers.push(resume);
    f.beforeQueuedExecution = async claim => {
      if (claim.runId === runId) { entered.resolve(claim); await resume.promise; }
    };
    return { entered: entered.promise, resume: () => resume.resolve() };
  };
  f.open = (start = true) => {
    const capacities = new WeakMap<Store, RuntimeHostCapacityAdmission>();
    f.supervisor = new RuntimeSupervisor(config, undefined, undefined, host ? store => {
      const admission = capacities.get(store);
      assert.ok(admission, "the exact Store must own its Host journal binding");
      return admission;
    } : undefined);
    f.activeRuns = new ActiveRunRegistry();
    f.stores = new RunStoreRegistry(host ? root => {
      const capacity = createRuntimeHostCapacityStoreBinding();
      const store = new SqliteRunStore({ cwd: root, paths: resolveStoragePaths(root).workspace,
        runtimeHostCapacityBinding: capacity.binding });
      capacities.set(store, createRuntimeHostCapacityAdmission({ host: host.host, workspace: capacity.workspace }));
      return store;
    } : createSqliteRunStore, {
      beforeRecovery: (root, store) => f.supervisor.getRuntime(root, store),
    });
    f.store = f.stores.getStore(cwd);
    f.queue = new RuntimeRunQueueCoordinator({ runtimeSupervisor: f.supervisor, activeRuns: f.activeRuns, intervalMs: 20,
      execute: async ({ store, claim, executionOptions }) => {
        const execution = { claim, settled: false };
        executions.push(execution);
        try {
          await f.beforeQueuedExecution?.(claim);
          return await f.executeClaim(claim, executionOptions, store);
        } finally { execution.settled = true; }
      },
    });
    f.queue.registerStore(f.store);
    if (start) f.queue.start();
    f.closed = false;
  };
  f.open(startQueue);
  f.close = async () => {
    f.queue.beginShutdown();
    await f.queue.waitForIdle();
    await f.activeRuns.waitForIdle();
    f.supervisor.releaseAll();
    f.stores.closeAll();
    f.closed = true;
  };
  t.after(async () => {
    f.cleaningUp = true;
    f.queue.beginShutdown();
    for (const barrier of barriers) barrier.resolve();
    for (const release of releases) release.resolve();
    await Promise.allSettled([...completions]);
    try { if (!f.closed) await f.close(); }
    finally { for (const root of roots) await rm(root, { recursive: true, force: true }); }
  });
  f.provider = (name, store = f.store) => {
    const now = new Date().toISOString();
    const preset = store.createProviderPreset({ kind: "openai-compatible", displayName: `Queue SDK ${name}`,
      providerId: `queue-sdk-fixture-${name}`, model: "queue-model", api: "openai-completions",
      baseUrl: "https://queue.fixture.invalid/v1", capabilities: ["chat", "tool_call"], authHeader: false,
      reasoning: false, enabled: true }, now);
    store.recordProviderCheckResult(preset.id, { ok: true, code: "ready", message: "Local scripted SDK transport", checkedAt: now });
    return preset;
  };
  f.channelFor = (name, { store = f.store, preset = f.preset } = {}) => store.createChannel({ name,
    boundPath: store.paths.cwd, defaultProviderPresetId: preset.id, allowedTools: ["read"],
    runtimePolicy: { queueOnConflict: true, maxConcurrentRuns: 3 } }, new Date().toISOString());
  f.addWorkspace = async name => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "ling-runtime-run-queue-integration-")));
    roots.push(cwd);
    const store = f.stores.getStore(cwd), preset = f.provider(name, store);
    const channel = f.channelFor(name, { store, preset });
    f.queue.registerStore(store);
    return { cwd, store, preset, channel };
  };
  f.preset = f.provider("default");
  f.channel = f.channelFor("Queue SDK integration");
  f.release = index => releases[index]?.resolve();
  f.describe = () => ({ calls, sdkCalls, errors, executions, runs: f.store.listRuns({ limit: 20 }).map(run => ({ id: run.id, status: run.status,
    error: run.errorMessage, unit: f.store.getWorkUnit(run.workUnitId!), queue: f.store.getRuntimeRunQueueEntry(run.id) })) });
  f.dispatch = async (name, { store = f.store, channel = f.channel, preset = f.preset, teammateId } = {}) => {
    const cwd = store.paths.cwd;
    const task = store.createTask({ channelId: channel.id, title: name,
      prompt: `Frozen objective ${name}` }, new Date().toISOString());
    const started = deferred<Ready>();
    const completion = executeRunRequest({ cwd, workspaceCwd: cwd, task, providerPresetId: preset.id,
      teammateId, tools: ["read"], idempotencyKey: `queue-${task.id}`, createdByActor: "local-user" },
    { ...createDetachedRunExecutionSink(), writeReady: body => { ready.push(body); started.resolve(body as Ready); },
      writeError: (status, body) => { errors.push({ status, body: body as QueueError["body"] }); started.resolve({ error: body }); } },
    f.runners, f.stores, f.activeRuns, f.supervisor, secretResolver, mcpBroker, {
      afterRunTerminal: run => { terminals.push(run.id); },
    });
    completions.add(completion);
    void completion.finally(() => completions.delete(completion));
    const result = await started.promise;
    assert.ok(result.runId, JSON.stringify(result));
    return { task, completion, runId: result.runId, ready: result };
  };
  f.source = (runId, store = f.store) => {
    // Ordinary dispatch captures both frozen snapshots and links the original Attempt.
    const run = store.getRun(runId)! as Source["run"], unit = store.getWorkUnit(run.workUnitId!)!;
    return { run, unit, attempt: store.getWorkUnitAttempt(unit.activeAttemptId!)! };
  };
  f.slots = (runId, store = f.store) => store.listRuntimeSemaphoreSlots({ workUnitId: f.source(runId, store).unit.id,
    status: "active", limit: 100 });
  f.resources = (runId, store = f.store) => {
    const { unit, attempt } = f.source(runId, store);
    return { leases: store.listResourceLeases({ attemptId: attempt.id, limit: 100 }),
      slots: store.listRuntimeSemaphoreSlots({ workUnitId: unit.id, limit: 100 }) };
  };
  return f;
}

function assertRetainedQueue(f: Fixture, pending: Dispatch, original: Source, store = f.store) {
  const current = f.source(pending.runId, store), entry = store.getRuntimeRunQueueEntry(pending.runId)!;
  assert.equal(f.calls.filter(call => call.runId === pending.runId).length, 0);
  assert.equal(f.sdkCalls.filter(call => call.runId === pending.runId).length, 0);
  assert.equal(current.run.status, "queued");
  assert.equal(current.unit.status, "queued");
  assert.equal(current.unit.attemptCount, 1);
  assert.equal(current.attempt.status, "created");
  assert.deepEqual(toRuntimeAttemptFence(current.attempt), toRuntimeAttemptFence(original.attempt));
  assert.deepEqual(current.run.requestSnapshot, original.run.requestSnapshot);
  assert.deepEqual(current.unit.request, original.unit.request);
  assert.equal(store.getTask(pending.task.id)!.status, "todo");
  assert.equal(entry.dispatchedAt, undefined);
  assert.equal(store.hasRuntimeRunQueueCustody(pending.runId), true);
  assert.deepEqual(f.resources(pending.runId, store), { leases: [], slots: [] }, "no partial or released admission rows");
  assert.equal(store.listRuntimeEvents(original.unit.id)
    .filter(event => event.type === "work_unit_claimed" && (event.data as { runId?: string } | undefined)?.runId === pending.runId).length, 0);
}

function assertDeferred(f: Fixture, pending: Dispatch, originalEntry: RuntimeRunQueueEntry,
  expectedError: { status: number; error: string }) {
  const entry = f.store.getRuntimeRunQueueEntry(pending.runId)!;
  assert.equal(entry.claim, undefined);
  assert.ok(entry.revision > originalEntry.revision);
  assert.equal(entry.snapshotDigest, originalEntry.snapshotDigest);
  assert.ok(Date.parse(entry.retryAt!) > Date.now(), "rejection persists a future retry without consuming dispatch");
  assert.deepEqual(f.errors.map(({ runId, status, body }) => ({ runId, status, error: body.error })),
    [{ runId: pending.runId, ...expectedError }]);
}

async function repositoryReservationInputs(f: Fixture) {
  const env = { PATH: "/usr/bin:/bin", HOME: f.cwd, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@ling.invalid",
    GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@ling.invalid" };
  const git = (args: string[]) => exec("/usr/bin/git", args, { cwd: f.cwd, env });
  await git(["init", "--initial-branch=main"]);
  await writeFile(join(f.cwd, ".gitignore"), "*\n!.gitignore\n!owned.txt\n");
  await writeFile(join(f.cwd, "owned.txt"), "base\n");
  await git(["add", "--", ".gitignore", "owned.txt"]);
  await git(["commit", "-m", "initial"]);
  const repository = await inspectWorkflowGitRepository(f.cwd, { hostStateRoot: f.store.paths.rootDir });
  const safety = { metadata: { sideEffectClass: "workspace_write", requiredTools: ["read", "write"],
    requestedRunnerId: "pi", parallelPolicy: { autoParallel: true, maxParallelSiblings: 2 } } } as const;
  const safetyPins = ["left", "right"].map(workflowStepId => ({ workflowStepId,
    fingerprint: workflowIsolationStepSafetyFingerprint(safety) }));
  const inputs = normalizeWorkflowIntegrationRoundInputs({ schemaVersion: 1, workflowId: "queue-repository-parent",
    canonicalWorkspaceId: f.channel.workspaceId, canonicalWorkspaceRoot: repository.root,
    repositoryIdentity: { commonDir: repository.commonDir, objectFormat: repository.head.length === 40 ? "sha1" : "sha256" },
    target: { executionRoot: repository.root, worktreeId: "target", branchRef: repository.branchRef,
      expectedHead: repository.head, cleanStateDigest: workflowGitRepositoryBasisDigest(repository), inputMode: "clean_checkout" },
    baseCommit: repository.head,
    integration: { executionRoot: join(f.cwd, "..", `${f.channel.id}-integration`), worktreeId: "integration",
      branchRef: "refs/heads/ling/integration" }, graphFingerprint: "queue-repository-graph", safetyPins,
    safetyFingerprint: workflowIsolationSafetyFingerprint(safetyPins), templatePins: [],
    participants: safetyPins.map((pin, position) => ({ workflowStepId: pin.workflowStepId, position, required: true })),
    mergeOrder: safetyPins.map(pin => pin.workflowStepId), optionalFailurePolicy: "require_success",
    validationRequirements: [{ id: "static", fingerprint: "fixture-v1" }], mode: "candidate_only",
    parallelExecution: { profile: "isolated_siblings_v1", maxConcurrentSteps: 2, writeLockScope: "boundPath" } });
  assert.ok(inputs);
  return inputs;
}

test("capacity queue wakes on actual Pi drain, reuses Attempt 1 and the frozen prompt exactly once", { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const first = await f.dispatch("First");
  await until(() => f.calls.length === 1, "first original SDK dispatch", f.describe);
  const second = await f.dispatch("Second");
  assert.equal(second.ready.queued, true);
  await second.completion;
  const original = f.source(second.runId);
  const snapshot = structuredClone(original.run.requestSnapshot.runnerExecutionInput);
  assert.equal(original.run.status, "queued");
  assert.equal(original.attempt.attemptNumber, 1);
  assert.equal(f.slots(second.runId).length, 0);
  assert.equal(f.store.listResourceLeases({ attemptId: original.attempt.id, status: "active" }).length, 0);
  const preparedCount = f.runner.preparations;
  for (let i = 0; i < 10; i++) f.queue.wakeStore(f.store);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(f.calls.length, 1);
  assert.equal(f.runner.preparations, preparedCount, "queued retries do not prepare a fresh SDK prompt");
  testDatabase(f.store).prepare("UPDATE tasks SET prompt=? WHERE id=?").run("Changed mutable task must not replace accepted input", second.task.id);
  f.release(0);
  await first.completion;
  await until(() => f.calls.length === 2, "waiting original Run automatically admitted after drain", f.describe);
  assert.equal(f.calls[1].runId, second.runId);
  assert.equal(f.calls[1].attemptId, original.attempt.id);
  assert.deepEqual(f.calls[1].prepared, snapshot.preparedInput);
  assert.equal(f.calls[1].task.prompt, "Frozen objective Second");
  assert.equal(f.source(second.runId).unit.attemptCount, 1);
  assert.equal(f.slots(first.runId).length, 0);
  assert.equal(f.slots(second.runId).length, 3);
  assert.ok(f.store.getRuntimeRunQueueEntry(second.runId)!.dispatchedAt);
  assert.equal(f.store.listRuntimeEvents(original.unit.id)
    .filter(event => event.type === "work_unit_claimed" && (event.data as { runId?: string } | undefined)?.runId === second.runId).length, 1);
  f.release(1);
  await until(() => f.store.getRun(second.runId)!.status === "succeeded" && f.slots(second.runId).length === 0,
    "second SDK completion and resource drain", f.describe);
  await f.queue.waitForIdle();
  assert.deepEqual(f.terminals.toSorted(), [first.runId, second.runId].toSorted(), "original terminal hooks survive process-local queueing");
  assert.equal(f.errors.length, 0, JSON.stringify(f.errors));
  assert.equal(f.calls.length, 2);
  assert.equal(f.store.listEvents(second.runId).filter(event => event.type === "run_created").length, 1);
});

test("never-dispatched queue survives Store recovery and executes its original Attempt under the next runtime", { timeout: 30_000 }, async t => {
  const f = await fixture(t, { startQueue: false });
  const first = await f.dispatch("Before restart");
  await until(() => f.calls.length === 1, "first SDK dispatch", f.describe);
  const second = await f.dispatch("After restart");
  assert.equal(second.ready.queued, true);
  const source = f.source(second.runId), originalFence = toRuntimeAttemptFence(source.attempt);
  f.release(0);
  await first.completion;
  await f.close();
  f.open();
  assert.equal(f.source(second.runId).attempt.id, source.attempt.id);
  await until(() => f.calls.length === 2, "cold startup dispatches the never-started queue", f.describe);
  assert.notEqual(f.supervisor.getRuntime(f.cwd, f.store).runtimeInstanceId, originalFence.runtimeInstanceId);
  assert.deepEqual(toRuntimeAttemptFence(f.source(second.runId).attempt), originalFence);
  assert.equal(f.calls[1].runId, second.runId);
  assert.equal(f.calls[1].attemptId, source.attempt.id);
  f.release(1);
  await until(() => f.store.getRun(second.runId)!.status === "succeeded", "cold queue completion", f.describe);
  await f.queue.waitForIdle();
  assert.equal(f.source(second.runId).unit.attemptCount, 1);
  assert.equal(f.calls.length, 2);
  assert.equal(f.errors.length, 0, JSON.stringify(f.errors));
});

test("cancelled queue never reaches the Pi SDK after capacity becomes free", { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const first = await f.dispatch("Running");
  await until(() => f.calls.length === 1, "first SDK dispatch", f.describe);
  const second = await f.dispatch("Cancelled");
  const { unit, attempt } = f.source(second.runId);
  assert.ok(ensureRunCancelled({ store: f.store, runId: second.runId, taskId: second.task.id,
    expectedAttemptId: attempt.id, active: false, reason: "user_requested" }).event);
  f.release(0);
  await first.completion;
  for (let i = 0; i < 3; i++) { f.queue.wakeStore(f.store); await new Promise(resolve => setTimeout(resolve, 25)); }
  assert.equal(f.calls.length, 1);
  assert.equal(f.store.getRun(second.runId)!.status, "cancelled");
  assert.equal(f.store.getWorkUnit(unit.id)!.status, "cancelled");
  assert.equal(f.slots(second.runId).length, 0);
  assert.equal(f.store.getRuntimeRunQueueEntry(second.runId)!.dispatchedAt, undefined);
});

test("Provider disabled while queued preserves the dispatch gate and lets an enabled Provider group run", { timeout: 30_000 }, async t => {
  const f = await fixture(t, { startQueue: false });
  const first = await f.dispatch("Provider holder");
  await until(() => f.sdkCalls.length === 1, "holder reached the real SDK transport", f.describe);
  const pending = await f.dispatch("Disabled Provider");
  assert.equal(pending.ready.queued, true);
  await pending.completion;
  const original = f.source(pending.runId), originalEntry = f.store.getRuntimeRunQueueEntry(pending.runId)!;
  const preset = f.provider("enabled"), channel = f.channelFor("Enabled Provider group", { preset });
  const healthy = await f.dispatch("Enabled Provider", { preset, channel });
  assert.equal(healthy.ready.queued, true);
  await healthy.completion;
  assert.notEqual(originalEntry.groupKey, f.store.getRuntimeRunQueueEntry(healthy.runId)!.groupKey);
  assert.equal(f.store.updateProviderPreset(f.preset.id, { enabled: false }, new Date().toISOString())!.enabled, false);
  f.release(0);
  await first.completion;
  f.queue.start();
  await until(() => f.errors.some(error => error.runId === pending.runId && error.body.error === "provider_disabled")
    && f.sdkCalls.some(call => call.runId === healthy.runId), "disabled authority rejected while enabled group dispatches", f.describe);
  assertRetainedQueue(f, pending, original);
  f.release(1);
  await until(() => f.store.getRun(healthy.runId)!.status === "succeeded" && f.slots(healthy.runId).length === 0,
    "enabled Provider group completed and drained", f.describe);
  await f.queue.waitForIdle();
  assertDeferred(f, pending, originalEntry, { status: 400, error: "provider_disabled" });
  assertRetainedQueue(f, pending, original);
  assert.deepEqual(f.sdkCalls.map(call => call.runId), [first.runId, healthy.runId]);
});

for (const status of ["paused", "archived"] as const) {
  test(`a channel made ${status} while queued preserves its gate without acquiring resources while an active group runs`, { timeout: 30_000 }, async t => {
    const f = await fixture(t, { startQueue: false });
    const first = await f.dispatch("Channel holder");
    await until(() => f.sdkCalls.length === 1, "holder reached SDK transport", f.describe);
    const pending = await f.dispatch("Channel authority");
    assert.equal(pending.ready.queued, true);
    await pending.completion;
    const original = f.source(pending.runId), originalEntry = f.store.getRuntimeRunQueueEntry(pending.runId)!;
    const channel = f.channelFor("Active channel group");
    const healthy = await f.dispatch("Active channel group", { channel });
    assert.equal(healthy.ready.queued, true);
    await healthy.completion;
    assert.notEqual(originalEntry.groupKey, f.store.getRuntimeRunQueueEntry(healthy.runId)!.groupKey);
    assert.equal(f.store.updateChannel(f.channel.id, { status }, new Date().toISOString())!.status, status);
    f.release(0);
    await first.completion;
    f.queue.start();
    await until(() => f.errors.some(error => error.runId === pending.runId)
      && f.sdkCalls.some(call => call.runId === healthy.runId), "inactive channel rejected without blocking the active group", f.describe);
    assertRetainedQueue(f, pending, original);
    f.release(1);
    await until(() => f.store.getRun(healthy.runId)!.status === "succeeded" && f.slots(healthy.runId).length === 0,
      "active channel group completed and drained", f.describe);
    await f.queue.waitForIdle();
    assertDeferred(f, pending, originalEntry, { status: 409, error: "runtime_run_queue_claim_changed" });
    assertRetainedQueue(f, pending, original);
    assert.equal(f.store.getChannel(f.channel.id)!.status, status);
    assert.deepEqual(f.sdkCalls.map(call => call.runId), [first.runId, healthy.runId]);
  });
}

test("workspace Pi authorization revoked after a queue claim retains the original gate while an authorized workspace runs", { timeout: 30_000 }, async t => {
  const f = await fixture(t, { startQueue: false });
  const first = await f.dispatch("Runner holder");
  await until(() => f.sdkCalls.length === 1, "holder reached SDK transport", f.describe);
  const pending = await f.dispatch("Runner authorization");
  assert.equal(pending.ready.queued, true);
  await pending.completion;
  const original = f.source(pending.runId), originalEntry = f.store.getRuntimeRunQueueEntry(pending.runId)!;
  const independent = await f.addWorkspace("authorized-runner");
  const independentFirst = await f.dispatch("Authorized workspace holder", independent);
  await until(() => f.sdkCalls.length === 2, "independent holder reached SDK transport", f.describe);
  const healthy = await f.dispatch("Authorized workspace queue", independent);
  assert.equal(healthy.ready.queued, true);
  await healthy.completion;
  const independentSettings = loadWorkspaceRuntimeSettings(independent.store, f.runners);
  assert.deepEqual(loadWorkspaceRuntimeSettings(f.store, f.runners).allowedRunnerIds, ["pi"]);
  assert.deepEqual(independentSettings.allowedRunnerIds, ["pi"]);
  const paused = f.pauseQueuedExecution(pending.runId);
  f.release(0);
  f.release(1);
  await Promise.all([first.completion, independentFirst.completion]);
  f.queue.start();
  await until(() => f.executions.some(execution => execution.claim.runId === pending.runId), "original queue preparation claimed", f.describe);
  const claim = await paused.entered;
  assert.deepEqual(f.store.getRuntimeRunQueueEntry(pending.runId)!.claim, claim);
  assertRetainedQueue(f, pending, original);
  const settings = patchWorkspaceRuntimeSettings(f.store, f.runners, { allowedRunnerIds: [] });
  assert.deepEqual(settings.allowedRunnerIds, []);
  assert.equal(f.runners.get("pi")!.status, "enabled");
  assert.throws(() => f.runners.resolve({ requestedRunnerId: "pi", allowedRunnerIds: settings.allowedRunnerIds,
    allowFallback: false }), /not allowed in this workspace/);
  assert.deepEqual(loadWorkspaceRuntimeSettings(independent.store, f.runners), independentSettings);
  paused.resume();
  await until(() => f.errors.some(error => error.runId === pending.runId)
    && f.sdkCalls.some(call => call.runId === healthy.runId), "revoked Runner rejected while authorized workspace dispatches", f.describe);
  assertRetainedQueue(f, pending, original);
  f.release(2);
  await until(() => independent.store.getRun(healthy.runId)!.status === "succeeded"
    && f.slots(healthy.runId, independent.store).length === 0, "authorized workspace queue completed and drained", f.describe);
  await f.queue.waitForIdle();
  assertDeferred(f, pending, originalEntry, { status: 409, error: "runtime_run_queue_preparation_deferred" });
  assertRetainedQueue(f, pending, original);
  assert.deepEqual(loadWorkspaceRuntimeSettings(f.store, f.runners).allowedRunnerIds, []);
  assert.deepEqual(f.sdkCalls.map(call => call.runId), [first.runId, independentFirst.runId, healthy.runId]);
});

for (const credential of ["local_deleted", "env_missing", "keychain_access_denied", "keychain_unavailable"] as const) {
  test(`Provider credentials becoming ${credential} while queued cannot spend the gate or block an available Provider group`, { timeout: 30_000 }, async t => {
    const env: Record<string, string | undefined> = { QUEUE_API_KEY: "synthetic-queue-env-key" };
    let keychainAvailable = true;
    const keychainError = credential === "keychain_access_denied" ? "secret_access_denied" : "secret_store_unavailable";
    const keychainResolver: SecretResolver = {
      status: ref => ({ ref, kind: "keychain", configured: keychainAvailable,
        ...(!keychainAvailable ? { errorCode: keychainError, message: "Scripted keychain credential is unavailable." } : {}) }),
      resolve(ref, purpose) {
        const status = this.status(ref, purpose);
        return { ref, configured: status.configured, status,
          ...(status.configured ? { value: "synthetic-queue-keychain-key" } : {}) };
      },
    };
    const secretResolver = createCompositeSecretResolver({ env, keychainResolver });
    const f = await fixture(t, { startQueue: false, secretResolver });
    const created = f.provider("credential");
    const apiKeyRef = credential === "local_deleted" ? `local:${created.id}`
      : credential === "env_missing" ? "env:QUEUE_API_KEY" : "keychain:QUEUE_API_KEY";
    if (credential === "local_deleted") f.store.setProviderSecret(created.id, "synthetic-queue-local-key", new Date().toISOString());
    f.store.updateProviderPreset(created.id, { authHeader: true, apiKeyRef }, new Date().toISOString());
    f.store.recordProviderCheckResult(created.id, { ok: true, code: "ready",
      message: "Local scripted SDK transport", checkedAt: new Date().toISOString() });
    const preset = f.store.getProviderPreset(created.id)!;
    assert.equal(preset.lastCheck!.ok, true);
    const first = await f.dispatch("Credential holder");
    await until(() => f.sdkCalls.length === 1, "holder reached SDK transport", f.describe);
    const pending = await f.dispatch("Credential authority", { preset });
    assert.equal(pending.ready.queued, true);
    await pending.completion;
    const original = f.source(pending.runId), originalEntry = f.store.getRuntimeRunQueueEntry(pending.runId)!;
    assert.equal(original.run.providerPresetId, preset.id);
    const channel = f.channelFor("Available credential group");
    const healthy = await f.dispatch("Available credential group", { channel });
    assert.equal(healthy.ready.queued, true);
    await healthy.completion;
    assert.notEqual(originalEntry.groupKey, f.store.getRuntimeRunQueueEntry(healthy.runId)!.groupKey);
    if (credential === "local_deleted") {
      assert.equal(f.store.hasProviderSecret(preset.id), true);
      assert.equal(f.store.deleteProviderSecret(preset.id), true);
      assert.equal(f.store.hasProviderSecret(preset.id), false);
      const { lastCheck, ...configuration } = preset;
      assert.equal(lastCheck!.ok, true);
      assert.deepEqual(f.store.getProviderPreset(preset.id), configuration, "local credential deletion invalidates check evidence, not Provider configuration");
    } else {
      if (credential === "env_missing") delete env.QUEUE_API_KEY;
      else keychainAvailable = false;
      const status = secretResolver.status(apiKeyRef, "provider_api_key");
      assert.equal(status.configured, false);
      assert.equal(status.errorCode, credential === "env_missing" ? "secret_missing" : keychainError);
      assert.deepEqual(f.store.getProviderPreset(preset.id), preset, "external credential loss does not edit the checked Provider");
    }
    f.release(0);
    await first.completion;
    f.queue.start();
    await until(() => f.errors.some(error => error.runId === pending.runId && error.body.error === "provider_preflight_failed")
      && f.sdkCalls.some(call => call.runId === healthy.runId), "current credential failure rejected without blocking an available group", f.describe);
    assertRetainedQueue(f, pending, original);
    f.release(1);
    await until(() => f.store.getRun(healthy.runId)!.status === "succeeded" && f.slots(healthy.runId).length === 0,
      "available Provider group completed and drained", f.describe);
    await f.queue.waitForIdle();
    assertDeferred(f, pending, originalEntry, { status: 400, error: "provider_preflight_failed" });
    assertRetainedQueue(f, pending, original);
    assert.deepEqual(f.sdkCalls.map(call => call.runId), [first.runId, healthy.runId]);
  });
}

for (const state of ["paused", "disabled", "hidden"] as const) {
  test(`a participant made ${state} while queued never reaches the SDK or blocks an independent group`, { timeout: 30_000 }, async t => {
    const f = await fixture(t, { startQueue: false });
    const teammate = f.store.createAiTeammate({ roleKey: "engineer", displayName: "Queued engineer",
      description: "Queue participant", allowedTools: ["read"], approvalProfile: { mode: "none" } }, new Date().toISOString());
    const first = await f.dispatch("Participant holder");
    await until(() => f.sdkCalls.length === 1, "holder reached SDK transport", f.describe);
    const pending = await f.dispatch("Participant authority", { teammateId: teammate.id });
    assert.equal(pending.ready.queued, true);
    await pending.completion;
    const original = f.source(pending.runId), originalEntry = f.store.getRuntimeRunQueueEntry(pending.runId)!;
    assert.equal(original.run.teammateId, teammate.id);
    assert.equal(original.run.selectedSkillId, undefined);
    assert.equal(original.run.requestSnapshot.runnerExecutionInput.usedMemory, undefined);
    const channel = f.channelFor("Available participant group");
    const healthy = await f.dispatch("Available participant group", { channel });
    assert.equal(healthy.ready.queued, true);
    await healthy.completion;
    if (state === "disabled") f.store.disableAiTeammate(teammate.id, new Date().toISOString());
    else f.store.updateAiTeammate(teammate.id, state === "hidden" ? { hidden: true } : { status: state }, new Date().toISOString());
    f.release(0);
    await first.completion;
    f.queue.start();
    await until(() => f.sdkCalls.length > 1, "queue processes a free execution place", f.describe);
    assertRetainedQueue(f, pending, original);
    assert.equal(f.sdkCalls[1].runId, healthy.runId);
    f.release(1);
    await until(() => f.store.getRun(healthy.runId)!.status === "succeeded" && f.slots(healthy.runId).length === 0,
      "available participant group completed and drained", f.describe);
    await f.queue.waitForIdle();
    assertDeferred(f, pending, originalEntry, { status: 409, error: "runtime_run_queue_participant_unavailable" });
    assertRetainedQueue(f, pending, original);
    assert.deepEqual(f.sdkCalls.map(call => call.runId), [first.runId, healthy.runId]);
  });
}

test("queued frozen policy rejects changed authority while a group accepted under current policy runs", { timeout: 30_000 }, async t => {
  const f = await fixture(t, { startQueue: false });
  const first = await f.dispatch("Policy holder");
  await until(() => f.sdkCalls.length === 1, "holder reached the real SDK transport", f.describe);
  const pending = await f.dispatch("Original policy");
  assert.equal(pending.ready.queued, true);
  await pending.completion;
  const original = f.source(pending.runId), originalEntry = f.store.getRuntimeRunQueueEntry(pending.runId)!;
  const frozenPolicy = original.run.requestSnapshot.effectivePolicySnapshot;
  await until(() => Date.now() > Date.parse(frozenPolicy.workspacePolicyUpdatedAt), "distinct policy authority timestamp");
  const policy = f.store.updateApprovalPolicy({ toolDecisions: { write: "deny" } }, new Date().toISOString());
  assert.equal(policy.toolDecisions.write, "deny");
  assert.notEqual(policy.updatedAt, frozenPolicy.workspacePolicyUpdatedAt);
  const channel = f.channelFor("Current policy group");
  const healthy = await f.dispatch("Current policy", { channel });
  assert.equal(healthy.ready.queued, true);
  await healthy.completion;
  assert.equal(f.source(healthy.runId).run.requestSnapshot.effectivePolicySnapshot.workspacePolicyUpdatedAt, policy.updatedAt);
  assert.notEqual(originalEntry.groupKey, f.store.getRuntimeRunQueueEntry(healthy.runId)!.groupKey);
  f.release(0);
  await first.completion;
  f.queue.start();
  await until(() => f.errors.some(error => error.runId === pending.runId && error.body.error === "runtime_run_queue_policy_changed")
    && f.sdkCalls.some(call => call.runId === healthy.runId), "frozen authority rejected without blocking current-policy group", f.describe);
  assertRetainedQueue(f, pending, original);
  f.release(1);
  await until(() => f.store.getRun(healthy.runId)!.status === "succeeded" && f.slots(healthy.runId).length === 0,
    "current-policy group completed and drained", f.describe);
  await f.queue.waitForIdle();
  assertDeferred(f, pending, originalEntry, { status: 409, error: "runtime_run_queue_policy_changed" });
  assertRetainedQueue(f, pending, original);
  assert.deepEqual(f.sdkCalls.map(call => call.runId), [first.runId, healthy.runId]);
});

test("repository parent reservation rejects queued SDK dispatch while an independent workspace drains", { timeout: 30_000 }, async t => {
  const f = await fixture(t, { startQueue: false }), inputs = await repositoryReservationInputs(f);
  const independent = await f.addWorkspace("independent");
  const first = await f.dispatch("Repository holder");
  await until(() => f.sdkCalls.length === 1, "repository holder SDK transport", f.describe);
  const pending = await f.dispatch("Repository fenced");
  assert.equal(pending.ready.queued, true);
  await pending.completion;
  const original = f.source(pending.runId), originalEntry = f.store.getRuntimeRunQueueEntry(pending.runId)!;
  const independentFirst = await f.dispatch("Independent holder", independent);
  await until(() => f.sdkCalls.length === 2, "independent holder SDK transport", f.describe);
  const healthy = await f.dispatch("Independent queued", independent);
  assert.equal(healthy.ready.queued, true);
  await healthy.completion;
  f.release(0);
  f.release(1);
  await Promise.all([first.completion, independentFirst.completion]);
  assert.equal(f.slots(first.runId).length, 0);
  assert.equal(f.slots(independentFirst.runId, independent.store).length, 0);
  const roundId = "queue-repository-reservation";
  const token = await reserveWorkflowRepositoryFence(f.store, roundId, inputs);
  assert.ok(token, "the real repository sidecar granted a planning reservation");
  try {
    assert.throws(() => assertWorkflowRepositoryRunAllowed(f.store, { cwd: f.cwd }), { code: "workflow_repository_busy" });
    f.queue.start();
    await until(() => f.errors.some(error => error.runId === pending.runId && error.body.error === "workflow_repository_busy")
      && f.sdkCalls.some(call => call.runId === healthy.runId), "held parent fence rejects admission without blocking another repository", f.describe);
    assertRetainedQueue(f, pending, original);
    f.release(2);
    await until(() => independent.store.getRun(healthy.runId)!.status === "succeeded"
      && f.slots(healthy.runId, independent.store).length === 0, "independent queued Run completed and drained", f.describe);
    await f.queue.waitForIdle();
    assertDeferred(f, pending, originalEntry, { status: 409, error: "workflow_repository_busy" });
    assertRetainedQueue(f, pending, original);
    assert.throws(() => assertWorkflowRepositoryRunAllowed(f.store, { cwd: f.cwd }), { code: "workflow_repository_busy" });
    assert.deepEqual(f.sdkCalls.map(call => call.runId), [first.runId, independentFirst.runId, healthy.runId]);
  } finally { releaseWorkflowRepositoryFence(f.store, roundId, 1, inputs, undefined, token); }
  assert.doesNotThrow(() => assertWorkflowRepositoryRunAllowed(f.store, { cwd: f.cwd }));
});

test("a superseded queue owner cannot call the SDK or clear the replacement owner's gate and resources", { timeout: 30_000 }, async t => {
  const f = await fixture(t, { startQueue: false });
  const first = await f.dispatch("Claim holder");
  await until(() => f.sdkCalls.length === 1, "holder SDK transport", f.describe);
  const pending = await f.dispatch("Claim takeover");
  assert.equal(pending.ready.queued, true);
  await pending.completion;
  const original = f.source(pending.runId), paused = f.pauseQueuedExecution(pending.runId);
  const channel = f.channelFor("Unblocked claim group");
  const healthy = await f.dispatch("Unblocked claim group", { channel });
  assert.equal(healthy.ready.queued, true);
  await healthy.completion;
  assert.notEqual(f.store.getRuntimeRunQueueEntry(pending.runId)!.groupKey, f.store.getRuntimeRunQueueEntry(healthy.runId)!.groupKey);
  f.release(0);
  await first.completion;
  f.queue.start();
  await until(() => f.executions.some(execution => execution.claim.runId === pending.runId)
    && f.sdkCalls.some(call => call.runId === healthy.runId), "paused preparation holds no capacity for an independent group", f.describe);
  const oldClaim = await paused.entered, beforeTakeover = f.store.getRuntimeRunQueueEntry(pending.runId)!;
  assert.deepEqual(beforeTakeover.claim, oldClaim);
  assertRetainedQueue(f, pending, original);
  f.queue.beginShutdown();
  f.release(1);
  await until(() => f.store.getRun(healthy.runId)!.status === "succeeded" && f.slots(healthy.runId).length === 0,
    "independent group drained before claim takeover", f.describe);
  const peer = createSqliteRunStore(f.cwd, f.store.paths);
  try {
    // Arbitrate at the stored TTL boundary without delaying the live SDK runtime clock.
    const replacement = peer.claimNextRuntimeRun({ workspaceId: beforeTakeover.workspaceId,
      runtimeInstanceId: oldClaim.runtimeInstanceId, ownerId: "replacement-worker", leaseMs: 60_000,
      now: beforeTakeover.claimExpiresAt!, runId: pending.runId });
    assert.equal(replacement.status, "claimed", JSON.stringify(replacement));
    assert.notEqual(replacement.claim.token, oldClaim.token);
    assert.equal(replacement.claim.revision, oldClaim.revision + 1);
    assert.deepEqual(replacement.claim.sourceFence, oldClaim.sourceFence);
    assert.deepEqual(peer.getRuntimeRunQueueEntry(pending.runId), replacement.entry);
    assert.equal(await f.executeClaim(oldClaim), undefined, "the old token is rejected even before the winner consumes the gate");
    assert.deepEqual(peer.getRuntimeRunQueueEntry(pending.runId), replacement.entry, "rejected stale execution preserves the new preparation claim");
    assertRetainedQueue(f, pending, original);
    assert.deepEqual(f.errors.map(({ runId, status, body }) => ({ runId, status, error: body.error })),
      [{ runId: pending.runId, status: 409, error: "runtime_run_queue_source_changed" }]);
    const completion = f.executeClaim(replacement.claim);
    await until(() => f.sdkCalls.some(call => call.runId === pending.runId), "replacement owner reached actual SDK transport", f.describe);
    const admitted = peer.getRuntimeRunQueueEntry(pending.runId)!, resources = f.resources(pending.runId, peer);
    assert.ok(admitted.dispatchedAt);
    assert.deepEqual(admitted.claim, { ...replacement.claim, revision: replacement.claim.revision + 1 });
    assert.equal(resources.leases.length, 1);
    assert.equal(resources.leases[0].resourceType, "task");
    assert.equal(resources.leases[0].resourceKey, pending.task.id);
    assert.equal(resources.leases[0].status, "active");
    assert.deepEqual(resources.slots.map(slot => slot.resourceType).toSorted(), ["channel_parallel", "provider", "runner"]);
    assert.ok(resources.slots.every(slot => slot.status === "active" && slot.attemptId === original.attempt.id));
    paused.resume();
    await f.queue.waitForIdle();
    assert.deepEqual(peer.getRuntimeRunQueueEntry(pending.runId), admitted, "stale coordinator cleanup cannot replace or defer the winner's gate");
    assert.deepEqual(f.resources(pending.runId, peer), resources, "stale preparation cannot release the winner's live resources");
    assert.equal(f.calls.filter(call => call.runId === pending.runId).length, 1);
    assert.equal(f.sdkCalls.filter(call => call.runId === pending.runId).length, 1);
    assert.deepEqual(f.errors.map(({ runId, status, body }) => ({ runId, status, error: body.error })),
      Array.from({ length: 2 }, () => ({ runId: pending.runId, status: 409, error: "runtime_run_queue_source_changed" })));
    assert.equal(peer.listRuntimeEvents(original.unit.id)
      .filter(event => event.type === "work_unit_claimed" && (event.data as { runId?: string } | undefined)?.runId === pending.runId).length, 1);
    assert.deepEqual(toRuntimeAttemptFence(f.source(pending.runId).attempt), toRuntimeAttemptFence(original.attempt));
    f.release(2);
    await completion;
    await until(() => f.store.getRun(pending.runId)!.status === "succeeded" && f.slots(pending.runId).length === 0,
      "replacement owner completed and drained", f.describe);
    assert.deepEqual(f.sdkCalls.map(call => call.runId), [first.runId, healthy.runId, pending.runId]);
    assert.equal(f.source(pending.runId).unit.attemptCount, 1);
  } finally { peer.close(); }
});

test("claim takeover across the sandbox preflight await cannot dispatch or defer the replacement preparation", { timeout: 30_000 }, async t => {
  const f = await fixture(t, { startQueue: false });
  const first = await f.dispatch("Preflight holder");
  await until(() => f.sdkCalls.length === 1, "holder reached SDK transport", f.describe);
  const pending = await f.dispatch("Preflight takeover");
  assert.equal(pending.ready.queued, true);
  await pending.completion;
  const original = f.source(pending.runId);
  f.release(0);
  await first.completion;
  await until(() => Date.parse(f.store.getRuntimeRunQueueEntry(pending.runId)!.retryAt!) <= Date.now(),
    "queued retry is eligible", f.describe);
  const now = new Date().toISOString();
  const selected = f.store.claimNextRuntimeRun({ workspaceId: original.unit.workspaceId,
    runtimeInstanceId: f.supervisor.getRuntime(f.cwd, f.store).runtimeInstanceId,
    ownerId: "preflight-original", leaseMs: 30_000, now, runId: pending.runId });
  assert.equal(selected.status, "claimed", JSON.stringify(selected));
  const peer = createSqliteRunStore(f.cwd, f.store.paths);
  const resolveRunner = f.runners.resolve.bind(f.runners);
  let resolutions = 0;
  const takeover = deferred<ReturnType<Store["claimNextRuntimeRun"]> | Error>();
  try {
    f.runners.resolve = input => {
      const resolution = resolveRunner(input);
      // Frozen input resolves once initially and once immediately before the sandbox await.
      if (++resolutions === 2) queueMicrotask(() => {
        try {
          const current = peer.getRuntimeRunQueueEntry(pending.runId)!;
          assert.deepEqual(current.claim, selected.claim);
          assert.equal(current.dispatchedAt, undefined);
          assertRetainedQueue(f, pending, original, peer);
          // Only the preparation clock advances; the replacement still uses the live SDK clock.
          takeover.resolve(peer.claimNextRuntimeRun({ workspaceId: current.workspaceId,
            runtimeInstanceId: selected.claim.runtimeInstanceId, ownerId: "preflight-replacement",
            leaseMs: 30_000, now: current.claimExpiresAt!, runId: pending.runId }));
        } catch (error) { takeover.resolve(error instanceof Error ? error : new Error(String(error))); }
      });
      return resolution;
    };
    const staleExecution = f.executeClaim(selected.claim);
    const replacement = await takeover.promise;
    if (replacement instanceof Error) throw replacement;
    assert.equal(replacement.status, "claimed", JSON.stringify(replacement));
    assert.notEqual(replacement.claim.token, selected.claim.token);
    assert.deepEqual(replacement.claim.sourceFence, selected.claim.sourceFence);
    await staleExecution;
    f.runners.resolve = resolveRunner;
    assertRetainedQueue(f, pending, original, peer);
    assert.deepEqual(peer.getRuntimeRunQueueEntry(pending.runId), replacement.entry,
      "stale preflight cleanup preserves the replacement's unconsumed claim");
    assert.deepEqual(f.errors.map(({ runId, status, body }) => ({ runId, status, error: body.error })),
      [{ runId: pending.runId, status: 409, error: "runtime_run_queue_claim_changed" }]);
    const completion = f.executeClaim(replacement.claim);
    await until(() => f.sdkCalls.some(call => call.runId === pending.runId), "replacement reached SDK transport", f.describe);
    const admitted = peer.getRuntimeRunQueueEntry(pending.runId)!;
    assert.ok(admitted.dispatchedAt);
    assert.deepEqual(admitted.claim, { ...replacement.claim, revision: replacement.claim.revision + 1 });
    assert.equal(f.slots(pending.runId).length, 3);
    f.release(1);
    await completion;
    assert.equal(f.store.getRun(pending.runId)!.status, "succeeded");
    assert.equal(f.slots(pending.runId).length, 0);
    assert.deepEqual(f.sdkCalls.map(call => call.runId), [first.runId, pending.runId]);
    assert.equal(f.source(pending.runId).unit.attemptCount, 1);
    assert.equal(peer.listRuntimeEvents(original.unit.id)
      .filter(event => event.type === "work_unit_claimed" && (event.data as { runId?: string } | undefined)?.runId === pending.runId).length, 1);
  } finally {
    f.runners.resolve = resolveRunner;
    peer.close();
  }
});
