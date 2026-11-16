import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { createSqliteRunStore, toRuntimeAttemptFence, type RunStore } from "../../core/dist/index.js";
import { testDatabase } from "../../core/test/support/sqlite-test-database.ts";
import { openRuntimeRunQueueRecovery, waitForRecoveryCondition,
  type RecoveryBoundary } from "./support/runtime-run-queue-recovery-fixture.ts";

function readRun(store: RunStore, runId: string) {
  return store.readSnapshot(() => {
    const run = store.getRun(runId)!;
    assert.ok(run?.workUnitId);
    const unit = store.getWorkUnit(run.workUnitId)!;
    assert.ok(unit?.activeAttemptId);
    const attempt = store.getWorkUnitAttempt(unit.activeAttemptId)!;
    assert.ok(attempt);
    return { run, unit, attempt, task: store.getTask(run.taskId), entry: store.getRuntimeRunQueueEntry(runId)!,
      attempts: store.listWorkUnitAttempts(unit.id), events: store.listEvents(runId),
      runtimeEvents: store.listRuntimeEvents(unit.id),
      leases: store.listResourceLeases({ attemptId: attempt.id, limit: 100 }),
      slots: store.listRuntimeSemaphoreSlots({ workUnitId: unit.id, limit: 100 }),
      completion: store.getHostAttemptCompletion({ runId, ...toRuntimeAttemptFence(attempt) }) };
  });
}

function lineage(store: RunStore) {
  return { runs: store.listRuns({ limit: 100 }).map(run => run.id).sort(),
    units: store.listWorkUnits({ limit: 100 }).map(unit => unit.id).sort(),
    attempts: testDatabase(store).prepare("SELECT id FROM work_unit_attempts ORDER BY id").all(),
    continuations: testDatabase(store).prepare("SELECT * FROM runner_continuations ORDER BY id").all() };
}

async function crashSource(t: TestContext) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "ling-run-queue-recovery-")));
  const child = spawn(process.execPath,
    [fileURLToPath(new URL("./support/runtime-run-queue-recovery-fixture.ts", import.meta.url)), cwd], {
      cwd, env: { ...process.env, LING_STACK_HOME: join(cwd, "home"), LING_STACK_DEFAULT_WORKSPACE_CWD: cwd },
      stdio: ["ignore", "pipe", "pipe"],
    });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-16_000); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  // Register before waiting for readiness so failed setup cannot leak the source process.
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    try { await exited; }
    finally { await rm(cwd, { recursive: true, force: true }); }
  });
  await waitForRecoveryCondition(() => stdout.includes("\n") || child.exitCode !== null || child.signalCode !== null,
    "source committed the dispatch gate", () => ({ stdout, stderr, code: child.exitCode, signal: child.signalCode }));
  assert.ok(stdout.includes("\n"), JSON.stringify({ stdout, stderr, code: child.exitCode, signal: child.signalCode }));
  const boundary = JSON.parse(stdout.slice(0, stdout.indexOf("\n"))) as RecoveryBoundary;
  assert.equal(boundary.kind, "queue_dispatch_committed");
  assert.equal(boundary.pid, child.pid);
  assert.notEqual(boundary.pid, process.pid);
  assert.equal(boundary.paths.cwd, cwd);
  assert.deepEqual(boundary.calls.map(call => call.runId), [boundary.holderRunId]);
  assert.deepEqual(boundary.sdkCalls.map(call => call.runId), [boundary.holderRunId]);
  // Independent connection evidence proves the gate/resources are COMMITted, not an uncommitted worker view.
  const peer = createSqliteRunStore(cwd, boundary.paths);
  let unknown: ReturnType<typeof readRun>, independent: ReturnType<typeof readRun>, originalLineage: ReturnType<typeof lineage>;
  try {
    unknown = readRun(peer, boundary.unknownRunId);
    independent = readRun(peer, boundary.independentRunId);
    originalLineage = lineage(peer);
    assert.equal(peer.getRun(boundary.holderRunId)!.status, "succeeded");
    assert.ok(unknown.entry.dispatchedAt);
    assert.equal(unknown.run.status, "queued");
    assert.equal(unknown.unit.status, "claimed");
    assert.equal(unknown.attempt.status, "created");
    assert.equal(unknown.task!.status, "claimed");
    for (const owner of [unknown.run, unknown.unit, unknown.attempt]) {
      assert.equal(owner.startedAt, undefined);
      assert.equal(owner.endedAt, undefined);
    }
    assert.equal(unknown.attempt.abortRequestedAt, undefined);
    assert.equal(unknown.attempts.length, 1);
    assert.equal(unknown.attempt.attemptNumber, 1);
    assert.equal(unknown.unit.attemptCount, 1);
    assert.equal(unknown.completion?.drainedAt, undefined);
    assert.equal(unknown.completion?.effectCoverage, undefined);
    assert.equal(unknown.leases.length, 1);
    assert.equal(unknown.leases[0].resourceType, "task");
    assert.deepEqual(unknown.slots.map(slot => slot.resourceType).sort(), ["channel_parallel", "provider", "runner"]);
    for (const resource of [...unknown.leases, ...unknown.slots]) {
      assert.equal(resource.status, "active");
      const { workUnitId, attemptId, runtimeInstanceId, fencingToken } = resource;
      assert.deepEqual({ workUnitId, attemptId, runtimeInstanceId, fencingToken }, toRuntimeAttemptFence(unknown.attempt));
      assert.equal(resource.releasedAt, undefined);
    }
    assert.equal(independent.run.status, "queued");
    assert.equal(independent.unit.status, "queued");
    assert.equal(independent.attempt.status, "created");
    assert.equal(independent.entry.dispatchedAt, undefined);
    assert.notEqual(independent.entry.groupKey, unknown.entry.groupKey);
    assert.notEqual(independent.run.providerPresetId, unknown.run.providerPresetId);
    assert.deepEqual(independent.leases, []);
    assert.deepEqual(independent.slots, []);
    assert.equal(originalLineage.continuations.length, 0);
  } finally { peer.close(); }
  assert.equal(child.kill("SIGKILL"), true);
  assert.deepEqual(await exited, { code: null, signal: "SIGKILL" });
  assert.throws(() => process.kill(boundary.pid, 0), { code: "ESRCH" });
  const lock = JSON.parse(await readFile(join(boundary.paths.rootDir, "runtime.lock"), "utf8")) as { pid: number };
  assert.equal(lock.pid, boundary.pid, "the unclean runtime projection remains for real startup ownership arbitration");
  return { cwd, boundary, unknown, independent, originalLineage };
}

for (const afterExpiry of [false, true]) {
  test(`a committed first-Pi gate with unknown SDK ACK survives full cold startup${afterExpiry ? " beyond claim and resource TTL" : ""}`,
    { timeout: 40_000 }, async t => {
      const source = await crashSource(t), { boundary, unknown, independent, originalLineage } = source;
      if (afterExpiry) {
        const expiredAt = Math.max(Date.parse(unknown.entry.claimExpiresAt!),
          ...[...unknown.leases, ...unknown.slots].map(resource => Date.parse(resource.expiresAt))) + 1;
        t.mock.timers.enable({ apis: ["Date"], now: expiredAt });
      }
      const f = openRuntimeRunQueueRecovery(source.cwd, boundary.paths);
      // Cleanup must precede the source fixture's temporary-directory removal.
      try {
        const runtime = f.supervisor.getRuntime(source.cwd, f.store);
        assert.notEqual(runtime.runtimeInstanceId, boundary.runtimeInstanceId);
        assert.equal(runtime.pid, process.pid);
        assert.notEqual(runtime.pid, boundary.pid);
        assert.equal(f.store.getRuntimeConcurrencyPolicy(unknown.unit.workspaceId)!.runtimeInstanceId, runtime.runtimeInstanceId);
        assert.deepEqual(readRun(f.store, boundary.unknownRunId), unknown,
          "Supervisor reconciliation and registry recovery preserve exact gate, fence, snapshots, events and active resources");
        assert.deepEqual(readRun(f.store, boundary.independentRunId), independent);
        assert.deepEqual(lineage(f.store), originalLineage);
        assert.equal(f.store.hasRuntimeRunQueueCustody(boundary.unknownRunId), true);
        assert.equal(f.store.hasRuntimeRunQueueCustody(boundary.independentRunId), true);
        if (afterExpiry) {
          assert.ok(unknown.entry.claimExpiresAt! < new Date().toISOString());
          assert.ok([...unknown.leases, ...unknown.slots].every(resource => resource.expiresAt < new Date().toISOString()));
          assert.equal(f.store.expireResourceLeases(new Date().toISOString()), 0);
          assert.equal(f.store.expireRuntimeSemaphoreSlots(new Date().toISOString()), 0);
          assert.deepEqual(readRun(f.store, boundary.unknownRunId), unknown,
            "neither daemon exit nor elapsed TTL is an Attempt stop/effect receipt");
        }
        assert.equal(f.recovery.recoverStore(f.store).dispatched, 0);
        const expectedBusyErrors: typeof f.errors = [];
        f.start();
        for (let cycle = 1; cycle <= 2; cycle++) {
          const previousRevision = f.store.getRuntimeRunQueueEntry(boundary.independentRunId)!.revision;
          const previousClaims = f.claims.length;
          for (let wake = 0; wake < 20; wake++) f.queue.wakeStore(f.store);
          await waitForRecoveryCondition(() => {
            const entry = f.store.getRuntimeRunQueueEntry(boundary.independentRunId)!;
            return entry.revision > previousRevision && entry.claim === undefined && entry.retryAt !== undefined;
          }, `independent group was actually prepared and deferred on cold scan ${cycle}`,
          () => ({ claims: f.claims, errors: f.errors, failures: f.failures,
            entry: f.store.getRuntimeRunQueueEntry(boundary.independentRunId) }));
          // Date-only mocking leaves timers real; advance to the durable retry, not to a stop decision.
          if (afterExpiry) t.mock.timers.setTime(Date.parse(f.store.getRuntimeRunQueueEntry(boundary.independentRunId)!.retryAt!));
          assert.equal(f.recovery.recoverStore(f.store).dispatched, 0);
          assert.deepEqual(readRun(f.store, boundary.unknownRunId), unknown);
          const current = readRun(f.store, boundary.independentRunId), { entry, ...retained } = current;
          const { entry: acceptedEntry, ...accepted } = independent;
          assert.deepEqual(retained, accepted, "failed admission leaves the original independent Run and Attempt without partial resources");
          assert.equal(entry.dispatchedAt, undefined);
          assert.equal(entry.reason, "runtime_semaphore_conflict");
          assert.equal(entry.snapshotDigest, acceptedEntry.snapshotDigest);
          assert.deepEqual(entry.sourceFence, acceptedEntry.sourceFence);
          assert.ok(entry.revision > acceptedEntry.revision);
          assert.ok(entry.retryAt);
          const cycleClaims = f.claims.slice(previousClaims);
          assert.equal(cycleClaims.length, 1, `cold scan ${cycle} prepared exactly one independent claim`);
          const [claim] = cycleClaims;
          assert.ok(claim);
          assert.equal(claim.runId, boundary.independentRunId);
          assert.equal(claim.runtimeInstanceId, runtime.runtimeInstanceId);
          assert.deepEqual(claim.sourceFence, acceptedEntry.sourceFence);
          assert.equal(claim.revision, previousRevision + 1);
          assert.equal(entry.revision, claim.revision + 1);
          assert.equal(entry.claimExpiresAt, undefined);
          expectedBusyErrors.push({ runId: boundary.independentRunId, claim, status: 409,
            body: { error: "runtime_semaphore_conflict", message: "Run is waiting for execution resources." } });
          assert.deepEqual(lineage(f.store), originalLineage, "no new Run, WorkUnit, Attempt or successor continuation");
          assert.deepEqual(f.calls, [], "the unknown gate cannot be replayed and occupied capacity still blocks other groups");
          assert.deepEqual(f.sdkCalls, []);
          assert.deepEqual(f.continuationCalls, []);
          assert.deepEqual(f.errors, expectedBusyErrors,
            `cold scan ${cycle} returns only its claim-bound busy response without failing the queued Run`);
          assert.deepEqual(f.failures, []);
        }
        f.queue.beginShutdown();
        f.recovery.beginShutdown();
        await f.queue.waitForIdle();
        await f.recovery.waitForIdle();
        assert.equal(f.claims.length, 2, "both queue scans exercised the actual executor exactly once");
        assert.ok(f.claims.every(claim => claim.runId === boundary.independentRunId
          && claim.runtimeInstanceId === runtime.runtimeInstanceId));
        assert.deepEqual(f.errors, expectedBusyErrors, "coordinator cleanup produces no additional transport errors");
        assert.deepEqual(readRun(f.store, boundary.unknownRunId), unknown,
          "coordinator cleanup cannot defer or release an already-consumed gate");
        assert.deepEqual(lineage(f.store), originalLineage);
      } finally { await f.close(); }
    });
}
