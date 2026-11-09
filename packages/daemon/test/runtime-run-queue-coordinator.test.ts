import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { DEFAULT_WORKSPACE_ID, type RunStore, type RuntimeRunQueueEntry } from "../../core/dist/index.js";
import type { RuntimeSupervisor } from "../dist/runtime/supervisor.js";
import { ActiveRunRegistry } from "../dist/runtime/active-runs.js";
import {
  notifyRuntimeRunQueued,
  notifyRuntimeRunResourcesReleased,
  RuntimeRunQueueCoordinator,
} from "../dist/runtime/run-queue.js";

type ClaimInput = Parameters<RunStore["claimNextRuntimeRun"]>[0];
type Claimed = Extract<ReturnType<RunStore["claimNextRuntimeRun"]>, { status: "claimed" }>;
type Deferral = Parameters<RunStore["deferRuntimeQueuedRun"]>[0];
type ExecutionInput = Parameters<ConstructorParameters<typeof RuntimeRunQueueCoordinator>[0]["execute"]>[0];
type Execution = ExecutionInput & { completion: ReturnType<typeof deferred> };
type HostCapacity = NonNullable<ConstructorParameters<typeof RuntimeRunQueueCoordinator>[0]["hostCapacity"]>;

function deferred() {
  let resolve!: () => void, reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Finite selections exercise scheduling, without emulating SQLite admission or a Provider.
function scriptedStore(label: string, count = 0) {
  const pending = Array.from({ length: count }, (_, index) => `${label}-${index + 1}`);
  const claimInputs: ClaimInput[] = [], claimed: Claimed[] = [], deferrals: Deferral[] = [];
  const revisions = new Map<string, number>();
  const store = {
    paths: { cwd: `/queue-coordinator/${label}` },
    claimNextRuntimeRun(input: ClaimInput): ReturnType<RunStore["claimNextRuntimeRun"]> {
      claimInputs.push(input);
      const runId = pending.shift();
      if (!runId) return { status: "empty" };
      const revision = (revisions.get(runId) ?? 1) + 1;
      revisions.set(runId, revision);
      const sourceFence = Object.freeze({ workUnitId: `unit-${runId}`, attemptId: `attempt-${runId}`,
        runtimeInstanceId: `accepted-${label}`, fencingToken: `fence-${runId}` });
      const claim = Object.freeze({ runId, revision, sourceFence, ownerId: input.ownerId,
        token: `claim-${runId}-${revision}`, runtimeInstanceId: input.runtimeInstanceId });
      const entry: RuntimeRunQueueEntry = { sequence: claimed.length + 1, runId, workspaceId: DEFAULT_WORKSPACE_ID, sourceFence,
        snapshotDigest: "a".repeat(64), groupKey: label, queuedAt: input.now,
        reason: claimed.length % 2 ? "resource_conflict" : "runtime_semaphore_conflict",
        revision: claim.revision, lastSelected: claimed.length + 1, claim,
        claimExpiresAt: new Date(Date.parse(input.now) + input.leaseMs).toISOString() };
      const selected: Claimed = { status: "claimed", entry, claim };
      claimed.push(selected);
      return selected;
    },
    deferRuntimeQueuedRun(input: Deferral) { deferrals.push(input); return true; },
    getRun(runId: string) { return { id: runId, status: "succeeded" as const }; },
  };
  // The coordinator reads only cwd, claims, deferrals and the terminal Run status.
  return { store: store as unknown as RunStore, pending, claimInputs, claimed, deferrals };
}

function fixture(t: TestContext, stores: ReturnType<typeof scriptedStore>[] = [],
  { intervalMs = 60_000, maxConcurrentRuns = 4, hostCapacity }: {
    intervalMs?: number;
    maxConcurrentRuns?: number;
    hostCapacity?: HostCapacity;
  } = {}) {
  const activeRuns = new ActiveRunRegistry();
  const executions: Execution[] = [], runtimeCalls: { cwd: string; store: RunStore }[] = [];
  const coordinator = new RuntimeRunQueueCoordinator({ activeRuns, intervalMs,
    // This scheduling fixture exposes only the runtime identity consumed by a scan.
    runtimeSupervisor: {
      getRuntime(cwd: string, store: RunStore) {
        assert.equal(cwd, store.paths.cwd);
        runtimeCalls.push({ cwd, store });
        return { runtimeInstanceId: `runtime:${cwd}` };
      },
      getConcurrencyPolicy() {
        return { maxConcurrentRuns };
      },
    } as RuntimeSupervisor,
    ...(hostCapacity ? { hostCapacity } : {}),
    execute(input) {
      const completion = deferred();
      executions.push({ ...input, completion });
      return completion.promise;
    },
  });
  for (const { store } of stores) coordinator.registerStore(store);
  t.after(async () => {
    coordinator.beginShutdown();
    for (const execution of executions) execution.completion.resolve();
    await coordinator.waitForIdle();
  });
  return { coordinator, activeRuns, executions, runtimeCalls };
}

function ready(execution: Execution) {
  assert.equal(typeof execution.executionOptions!.onRunReady, "function");
  execution.executionOptions!.onRunReady!(execution.claim.runId);
}

test("four preparation slots do not cap unfinished executions, and ready releases exactly once", async t => {
  const queue = scriptedStore("preparation", 10);
  const f = fixture(t, [queue]);
  f.coordinator.start();
  await nextTurn();
  assert.equal(f.executions.length, 4);
  assert.equal(queue.claimInputs.length, 4);

  for (let index = 0; index < 20; index++) f.coordinator.wakeStore(queue.store);
  await nextTurn();
  assert.equal(f.executions.length, 4, "a wake cannot bypass occupied preparation slots");

  ready(f.executions[0]);
  ready(f.executions[0]);
  await nextTurn();
  assert.equal(f.executions.length, 5, "duplicate ready cannot free another preparation slot");

  for (const execution of f.executions.slice(1, 4)) ready(execution);
  await nextTurn();
  assert.equal(f.executions.length, 8, "eight execution Promises remain unsettled");
  assert.equal(queue.deferrals.length, 0);
  ready(f.executions[0]);
  await nextTurn();
  assert.equal(f.executions.length, 8);

  for (const execution of f.executions.slice(4)) ready(execution);
  await nextTurn();
  assert.equal(f.executions.length, 10);
  assert.equal(new Set(f.executions.map(execution => execution.claim.runId)).size, 10);
  assert.equal(queue.deferrals.length, 0, "ready is not execution completion or claim cleanup");
});

test("preparation capacity follows the trusted Supervisor policy above its fairness floor", async t => {
  const queue = scriptedStore("configured-preparation", 10);
  const f = fixture(t, [queue], { maxConcurrentRuns: 6 });
  f.coordinator.start();
  await nextTurn();
  assert.equal(f.executions.length, 6);
  assert.equal(queue.claimInputs.length, 6);
  assert.deepEqual(queue.pending, ["configured-preparation-7", "configured-preparation-8", "configured-preparation-9", "configured-preparation-10"]);
});

test("Host capacity full defers a claim without starting execution", async t => {
  const queue = scriptedStore("host-full", 1);
  const reserve = t.mock.fn<HostCapacity["reserve"]>(() => ({ status: "full" }));
  const f = fixture(t, [queue], { hostCapacity: {
    reserve,
    reserveExecution: t.mock.fn<HostCapacity["reserveExecution"]>(() => ({ status: "changed" })),
    reserveApprovalResumePending: t.mock.fn<HostCapacity["reserveApprovalResumePending"]>(() => ({ status: "changed" })),
    reserveUserInputContinuation: t.mock.fn<HostCapacity["reserveUserInputContinuation"]>(() => ({ status: "changed" })),
    getAttemptReference: t.mock.fn<HostCapacity["getAttemptReference"]>(() => undefined),
    consumeDispatch: t.mock.fn<HostCapacity["consumeDispatch"]>(() => false),
    reserveWorkflowStart: t.mock.fn(() => ({ status: "reserved", reference: {
      intentId: "workflow-intent-host-full-test", dispatchToken: "workflow-token-host-full-test",
    } })),
    reserveDelegationSpawn: t.mock.fn(() => ({ status: "changed" as const })),
    reserveDelegationPending: t.mock.fn(() => ({ status: "changed" as const })),
    releaseNoDispatch: t.mock.fn(() => true),
    releaseStopped: t.mock.fn(() => true),
  } });
  f.coordinator.start();
  await nextTurn();
  assert.equal(reserve.mock.calls.length, 1);
  assert.equal(f.executions.length, 0);
  assert.equal(queue.deferrals.length, 1);
  assert.equal(queue.deferrals[0]!.reason, "runtime_semaphore_conflict");
});

test("a queued Host receipt reaches execution and is released only when dispatch is not committed", async t => {
  const queue = scriptedStore("host-receipt", 1);
  const releaseNoDispatch = t.mock.fn(() => true);
  const reference = { intentId: "intent-host-receipt", dispatchToken: "token-host-receipt" };
  const f = fixture(t, [queue], { hostCapacity: {
    reserve: t.mock.fn(() => ({ status: "reserved", reference })),
    reserveExecution: t.mock.fn<HostCapacity["reserveExecution"]>(() => ({ status: "changed" })),
    reserveApprovalResumePending: t.mock.fn<HostCapacity["reserveApprovalResumePending"]>(() => ({ status: "changed" })),
    reserveUserInputContinuation: t.mock.fn<HostCapacity["reserveUserInputContinuation"]>(() => ({ status: "changed" })),
    getAttemptReference: t.mock.fn<HostCapacity["getAttemptReference"]>(() => undefined),
    consumeDispatch: t.mock.fn<HostCapacity["consumeDispatch"]>(() => false),
    reserveWorkflowStart: t.mock.fn(() => ({ status: "reserved", reference })),
    reserveDelegationSpawn: t.mock.fn(() => ({ status: "changed" as const })),
    reserveDelegationPending: t.mock.fn(() => ({ status: "changed" as const })),
    releaseNoDispatch,
    releaseStopped: t.mock.fn(() => true),
  } });
  f.coordinator.start();
  await nextTurn();
  assert.deepEqual(f.executions[0]!.executionOptions?.queuedHostCapacity, reference);
  f.executions[0]!.completion.resolve();
  await nextTurn();
  assert.equal(releaseNoDispatch.mock.calls.length, 1);
  const releaseCalls = releaseNoDispatch.mock.calls as unknown as readonly { arguments: readonly [{ intentId: string }] }[];
  const releaseInput = releaseCalls[0]?.arguments[0];
  assert.equal(releaseInput?.intentId, reference.intentId);
});

test("same-run claim takeovers each occupy a preparation slot up to four", async t => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const queue = scriptedStore("takeover-cap", 1);
  const f = fixture(t, [queue]);
  f.coordinator.start();
  await nextTurn();
  const runId = f.executions[0].claim.runId;

  for (let generation = 2; generation <= 5; generation++) {
    t.mock.timers.tick(30_001);
    queue.pending.push(runId);
    f.coordinator.wakeStore(queue.store);
    await nextTurn();
    assert.equal(f.executions.length, Math.min(generation, 4),
      `generation ${generation} cannot exceed four unfinished preparations`);
  }
  assert.deepEqual(f.executions.map(item => item.claim.revision), [2, 3, 4, 5]);
  assert.equal(new Set(f.executions.map(item => item.claim.token)).size, 4);
  assert.equal(queue.pending.length, 1);
  assert.equal(queue.deferrals.length, 0);

  ready(f.executions[0]);
  await nextTurn();
  assert.equal(f.executions.length, 5, "one generation releases only its own preparation slot");
  assert.equal(queue.pending.length, 0);
});

test("an old ready callback cannot release a same-run successor or remove it from drain", async t => {
  const queue = scriptedStore("takeover-ready", 1);
  const f = fixture(t, [queue]);
  f.coordinator.start();
  await nextTurn();
  const previous = f.executions[0];
  ready(previous);
  await nextTurn();
  queue.pending.push(previous.claim.runId, "ready-peer-1", "ready-peer-2", "ready-peer-3", "ready-waiting");
  f.coordinator.wakeStore(queue.store);
  await nextTurn();
  assert.equal(f.executions.length, 5);
  const successor = f.executions[1];
  assert.equal(successor.claim.runId, previous.claim.runId);
  assert.notEqual(successor.claim.token, previous.claim.token);

  ready(previous);
  ready(previous);
  await nextTurn();
  assert.equal(f.executions.length, 5, "stale ready must not free the successor's slot");
  assert.deepEqual(queue.pending, ["ready-waiting"]);
  ready(successor);
  await nextTurn();
  assert.equal(f.executions.length, 6, "the successor's own ready releases one slot");

  f.coordinator.beginShutdown();
  let drained = false;
  const drain = f.coordinator.waitForIdle().then(() => { drained = true; });
  for (const execution of f.executions.slice(1)) execution.completion.resolve();
  await nextTurn();
  assert.equal(drained, false, "the old ready generation still owns its full execution Promise");
  previous.completion.resolve();
  await drain;
  assert.equal(drained, true);
  assert.equal(queue.deferrals.length, 6);
});

for (const settlement of ["resolve", "reject"] as const) {
  test(`an old ${settlement} finally cannot release a same-run successor's preparation slot`, async t => {
    t.mock.method(console, "warn", () => {});
    const queue = scriptedStore(`takeover-${settlement}`, 1);
    const f = fixture(t, [queue]);
    f.coordinator.start();
    await nextTurn();
    const previous = f.executions[0];
    ready(previous);
    await nextTurn();
    queue.pending.push(previous.claim.runId, "finally-peer-1", "finally-peer-2", "finally-peer-3", "finally-waiting");
    f.coordinator.wakeStore(queue.store);
    await nextTurn();
    assert.equal(f.executions.length, 5);
    const successor = f.executions[1];
    assert.equal(successor.claim.runId, previous.claim.runId);
    assert.notEqual(successor.claim.token, previous.claim.token);

    previous.completion[settlement]();
    await nextTurn();
    assert.equal(f.executions.length, 5, "old finally must not free the successor's slot");
    assert.deepEqual(queue.pending, ["finally-waiting"]);
    assert.equal(queue.deferrals.length, 1);
    assert.equal(queue.deferrals[0].claim, previous.claim);
    ready(previous);
    await nextTurn();
    assert.equal(f.executions.length, 5, "late ready after settlement must also be harmless");

    successor.completion.resolve();
    await nextTurn();
    assert.equal(f.executions.length, 6, "the successor's own finally releases one slot");
    assert.equal(queue.deferrals.length, 2);
    assert.equal(queue.deferrals[1].claim, successor.claim);
  });
}

test("preparation limits and runtime lookups are scoped to each registered Store", async t => {
  const first = scriptedStore("first", 5), second = scriptedStore("second", 5);
  const f = fixture(t, [first, second]);
  f.coordinator.start();
  await nextTurn();
  assert.equal(f.executions.filter(item => item.store === first.store).length, 4);
  assert.equal(f.executions.filter(item => item.store === second.store).length, 4);
  assert.deepEqual(f.runtimeCalls.map(call => call.store), [first.store, second.store]);
  const owners = new Set();
  for (const queue of [first, second]) {
    for (const input of queue.claimInputs) {
      assert.equal(input.workspaceId, DEFAULT_WORKSPACE_ID);
      assert.equal(input.runtimeInstanceId, `runtime:${queue.store.paths.cwd}`);
      assert.equal(input.leaseMs, 30_000);
      assert.equal(new Date(input.now).toISOString(), input.now);
      assert.match(input.ownerId, /^run-queue:/);
      owners.add(input.ownerId);
    }
  }
  assert.equal(owners.size, 1);
  ready(f.executions.find(item => item.store === first.store)!);
  await nextTurn();
  assert.equal(f.executions.filter(item => item.store === first.store).length, 5);
  assert.equal(f.executions.filter(item => item.store === second.store).length, 4);
});

test("completion and rejection before ready release preparation and defer only the exact claim", async t => {
  const warning = t.mock.method(console, "warn", (..._args: unknown[]) => {});
  const queue = scriptedStore("settlement", 6);
  const f = fixture(t, [queue]);
  f.coordinator.start();
  await nextTurn();
  f.executions[0].completion.resolve();
  await nextTurn();
  assert.equal(f.executions.length, 5);
  f.executions[1].completion.reject(new Error("preparation refused"));
  await nextTurn();
  assert.equal(f.executions.length, 6);
  assert.equal(warning.mock.calls.length, 1);
  assert.match(warning.mock.calls[0].arguments[0] as string, /runtime_run_queue_preparation_incomplete/);
  assert.equal(queue.deferrals.length, 2);
  for (const [index, input] of queue.deferrals.entries()) {
    assert.equal(input.claim, queue.claimed[index].claim);
    assert.equal(input.reason, queue.claimed[index].entry.reason);
    assert.equal(Date.parse(input.retryAt) - Date.parse(input.now), 1_000);
    assert.equal(new Date(input.now).toISOString(), input.now);
  }
});

test("shutdown stops new preparations but drain waits for every execution after ready", async t => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  t.mock.method(console, "warn", () => {});
  const queue = scriptedStore("shutdown", 6);
  const f = fixture(t, [queue]);
  f.coordinator.start();
  await nextTurn();
  for (const execution of f.executions) ready(execution);
  await nextTurn();
  assert.equal(f.executions.length, 6);
  for (const execution of f.executions) ready(execution);
  f.coordinator.beginShutdown();
  let drained = false;
  const drain = f.coordinator.waitForIdle().then(() => { drained = true; });
  await f.activeRuns.waitForIdle();
  t.mock.timers.tick(120_001);
  await nextTurn();
  assert.equal(drained, false, "an empty ActiveRunRegistry and elapsed time do not settle executor Promises");
  assert.equal(queue.deferrals.length, 0);
  for (const execution of f.executions.slice(0, -1)) execution.completion.resolve();
  await nextTurn();
  assert.equal(drained, false);
  assert.equal(queue.deferrals.length, 5);
  f.executions.at(-1)!.completion.reject(new Error("execution stopped with a business failure"));
  await drain;
  assert.equal(drained, true);
  assert.equal(queue.deferrals.length, 6);
});

test("an idle wait includes executions started after its original preparation snapshot", async t => {
  const queue = scriptedStore("live-drain", 5);
  const f = fixture(t, [queue]);
  f.coordinator.start();
  await nextTurn();
  let drained = false;
  const drain = f.coordinator.waitForIdle().then(() => { drained = true; });
  ready(f.executions[0]);
  await nextTurn();
  assert.equal(f.executions.length, 5);
  for (const execution of f.executions.slice(0, 4)) execution.completion.resolve();
  await nextTurn();
  assert.equal(drained, false, "the fifth executor was not in the initial idle snapshot");
  f.coordinator.beginShutdown();
  f.executions[4].completion.resolve();
  await drain;
  assert.equal(drained, true);
});

for (const shutdown of ["coordinator", "active-runs"]) {
  test(`${shutdown} shutdown between claim and execution skips dispatch and cleans up claimed work`, async t => {
    const queue = scriptedStore(`late-${shutdown}`, 5);
    const f = fixture(t, [queue]);
    const stopped = deferred();
    f.coordinator.start();
    queueMicrotask(() => {
      if (shutdown === "coordinator") f.coordinator.beginShutdown();
      else f.activeRuns.suspendAll("daemon_restart");
      stopped.resolve();
    });
    await stopped.promise;
    await f.coordinator.waitForIdle();
    assert.equal(queue.claimed.length, 4, "shutdown follows the scan but precedes executor microtasks");
    assert.equal(f.executions.length, 0);
    assert.equal(queue.deferrals.length, 4);
    assert.deepEqual(queue.deferrals.map(input => input.claim), queue.claimed.map(item => item.claim));
    notifyRuntimeRunResourcesReleased(queue.store);
    await nextTurn();
    assert.equal(queue.pending.length, 1);
    assert.equal(queue.claimed.length, 4);
  });
}

test("start, explicit wake and resource notifications coalesce to one scan per Store and turn", async t => {
  const queue = scriptedStore("wake");
  const f = fixture(t, [queue]);
  notifyRuntimeRunResourcesReleased(queue.store);
  await nextTurn();
  assert.equal(queue.claimInputs.length, 0, "registration alone does not start discovery");
  f.coordinator.start();
  for (let index = 0; index < 50; index++) {
    f.coordinator.wakeStore(queue.store);
    notifyRuntimeRunResourcesReleased(queue.store);
  }
  assert.equal(queue.claimInputs.length, 0, "wake schedules a microtask, not synchronous SQLite work");
  await nextTurn();
  assert.equal(queue.claimInputs.length, 1);
  assert.equal(f.runtimeCalls.length, 1);
  for (let index = 0; index < 50; index++) notifyRuntimeRunResourcesReleased(queue.store);
  await nextTurn();
  assert.equal(queue.claimInputs.length, 2, "a later turn still discovers newly available work");
});

test("polling starts once, supports late registration, and cannot restart after shutdown", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const schedule = t.mock.method(globalThis, "setInterval");
  const cancel = t.mock.method(globalThis, "clearInterval");
  const f = fixture(t, [], { intervalMs: 50 });
  f.coordinator.start();
  f.coordinator.start();
  assert.equal(schedule.mock.calls.length, 1);
  t.mock.timers.tick(100);
  await nextTurn();
  assert.equal(f.runtimeCalls.length, 0);

  const queue = scriptedStore("late-registration");
  f.coordinator.registerStore(queue.store);
  f.coordinator.registerStore(queue.store);
  await nextTurn();
  assert.equal(queue.claimInputs.length, 1);
  t.mock.timers.tick(49);
  await nextTurn();
  assert.equal(queue.claimInputs.length, 1);
  t.mock.timers.tick(1);
  await nextTurn();
  assert.equal(queue.claimInputs.length, 2);
  t.mock.timers.tick(50);
  await nextTurn();
  assert.equal(queue.claimInputs.length, 3);

  f.coordinator.wakeStore(queue.store);
  f.coordinator.beginShutdown();
  f.coordinator.beginShutdown();
  f.coordinator.start();
  const late = scriptedStore("closed", 1);
  f.coordinator.registerStore(late.store);
  notifyRuntimeRunQueued(queue.store, "ignored-after-close", {});
  notifyRuntimeRunResourcesReleased(queue.store);
  t.mock.timers.tick(1_000);
  await nextTurn();
  await f.coordinator.waitForIdle();
  assert.equal(queue.claimInputs.length, 3, "the pending wake also observes the closed latch");
  assert.equal(late.claimInputs.length, 0);
  assert.equal(f.executions.length, 0);
  assert.equal(schedule.mock.calls.length, 1);
  assert.equal(cancel.mock.calls.length, 1);
});

test("duplicate registration does not reset occupied preparation slots", async t => {
  const queue = scriptedStore("registered", 6);
  const f = fixture(t, [queue]);
  f.coordinator.start();
  await nextTurn();
  f.coordinator.registerStore(queue.store);
  f.coordinator.start();
  notifyRuntimeRunResourcesReleased(queue.store);
  await nextTurn();
  assert.equal(f.executions.length, 4);
  ready(f.executions[0]);
  await nextTurn();
  assert.equal(f.executions.length, 5);
  assert.equal(queue.pending.length, 1);
});

test("queued notification retains copied hooks but replaces the original ready callback", async t => {
  const queue = scriptedStore("retained", 1);
  const f = fixture(t, [queue]);
  const originalReady = t.mock.fn(), terminal = t.mock.fn();
  const options = { onRunReady: originalReady, afterRunTerminal: terminal, enableUserInputPause: true };
  notifyRuntimeRunQueued(queue.store, queue.pending[0], options);
  options.afterRunTerminal = t.mock.fn();
  options.enableUserInputPause = false;
  f.coordinator.start();
  await nextTurn();
  assert.equal(f.executions.length, 1);
  const passed = f.executions[0].executionOptions!;
  assert.notEqual(passed, options);
  assert.equal(passed.afterRunTerminal, terminal);
  assert.equal(passed.enableUserInputPause, true);
  assert.notEqual(passed.onRunReady, originalReady);
  ready(f.executions[0]);
  await nextTurn();
  assert.equal(originalReady.mock.calls.length, 0);
  f.executions[0].completion.resolve();
  await f.coordinator.waitForIdle();
  assert.equal(terminal.mock.calls.length, 0, "only the executor owns terminal hook invocation");
});

test("a failed scan releases its scan guard so a later wake can discover work", async t => {
  const warning = t.mock.method(console, "warn", (..._args: unknown[]) => {});
  const queue = scriptedStore("scan-retry", 1);
  const claim = queue.store.claimNextRuntimeRun.bind(queue.store);
  let fail = true;
  t.mock.method(queue.store, "claimNextRuntimeRun", (input: ClaimInput) => {
    if (fail) { fail = false; throw new Error("SQLite temporarily unavailable"); }
    return claim(input);
  });
  const f = fixture(t, [queue]);
  f.coordinator.start();
  await nextTurn();
  assert.equal(f.executions.length, 0);
  assert.match(warning.mock.calls[0].arguments[0] as string, /runtime_run_queue_scan_incomplete/);
  notifyRuntimeRunResourcesReleased(queue.store);
  await nextTurn();
  assert.equal(f.executions.length, 1);
  assert.equal(f.executions[0].claim, queue.claimed[0].claim);
});

test("cleanup failure does not strand preparation slots or prevent executor drain", async t => {
  const warning = t.mock.method(console, "warn", (..._args: unknown[]) => {});
  const queue = scriptedStore("cleanup", 5);
  const defer = queue.store.deferRuntimeQueuedRun.bind(queue.store);
  let fail = true;
  t.mock.method(queue.store, "deferRuntimeQueuedRun", (input: Deferral) => {
    if (fail) { fail = false; throw new Error("claim cleanup unavailable"); }
    return defer(input);
  });
  const f = fixture(t, [queue]);
  f.coordinator.start();
  await nextTurn();
  f.executions[0].completion.resolve();
  await nextTurn();
  assert.equal(f.executions.length, 5);
  assert.match(warning.mock.calls[0].arguments[0] as string, /runtime_run_queue_cleanup_incomplete/);
  f.coordinator.beginShutdown();
  for (const execution of f.executions.slice(1)) execution.completion.resolve();
  await f.coordinator.waitForIdle();
  assert.equal(queue.deferrals.length, 4);
});
