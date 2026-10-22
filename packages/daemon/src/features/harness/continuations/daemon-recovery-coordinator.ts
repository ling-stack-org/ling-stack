import { isDeepStrictEqual } from "node:util";
import {
  toRuntimeAttemptFence,
  type RunnerContinuationDiscoveryCursor,
  type RunSession,
  type RunStore,
  type WorkUnit,
  type WorkUnitDiscoveryCursor,
} from "@ling-stack/core";
import type { RunnerContinuationOrigin, RunnerContinuationV1 } from "@ling-stack/contracts";
import type { ActiveRunRegistry } from "../../../runtime/active-runs.js";
import type { RuntimeSupervisor } from "../../../runtime/supervisor.js";
import {
  readStoredEffectivePolicySnapshot,
  readStoredRunnerExecution,
  rebuildExistingRunRequest,
} from "../../runs/existing-run-request.js";
import {
  restoreScheduledRunnerContinuationExecution,
  type PreparedRunnerContinuationExecution,
} from "./coordinator.js";
import { readRunnerContinuationReplayArtifact } from "./replay-package.js";

const DEFAULT_RECOVERY_SCAN_INTERVAL_MS = 5_000;
const RECOVERY_DISCOVERY_PAGE_SIZE = 500;
const RECOVERABLE_WORK_UNIT_KINDS = ["task_run", "conversation_run", "teammate_direct_reply"] as const;
type RecoverableWorkUnitKind = typeof RECOVERABLE_WORK_UNIT_KINDS[number];

interface DiscoverySweep<Cursor> {
  readonly cutoff: string;
  readonly after?: Cursor;
}

interface StoreDiscoverySweeps {
  scheduled?: DiscoverySweep<RunnerContinuationDiscoveryCursor>;
  readonly workUnits: Partial<Record<RecoverableWorkUnitKind, DiscoverySweep<WorkUnitDiscoveryCursor>>>;
}

export interface DaemonRunnerRecoveryResult {
  readonly scanned: number;
  readonly dispatched: number;
  readonly skipped: number;
}

/**
 * Re-dispatches only fenced, daemon-owned Run continuations after startup.
 * SQLite remains the authority for activation; this class only discovers
 * eligible stale WorkUnits and prevents duplicate in-process dispatch. Channel
 * reply children belong to the channel dispatch recovery path instead.
 */
export class DaemonRunnerRecoveryCoordinator {
  private readonly stores = new Set<RunStore>();
  private readonly dispatches = new WeakMap<RunStore, Set<string>>();
  private readonly discoverySweeps = new WeakMap<RunStore, StoreDiscoverySweeps>();
  private readonly scansInProgress = new WeakSet<RunStore>();
  private readonly inFlight = new Set<Promise<unknown>>();
  private started = false;
  private shuttingDown = false;
  private scanTimer?: ReturnType<typeof setInterval>;

  constructor(private readonly options: {
    readonly runtimeSupervisor: RuntimeSupervisor;
    readonly activeRuns: ActiveRunRegistry;
    readonly executeExistingRunContinuation: (input: {
      readonly cwd: string;
      readonly runId: string;
      readonly origin: RunnerContinuationOrigin;
      readonly idempotencyDiscriminator: string;
      readonly preparedExecution?: PreparedRunnerContinuationExecution;
    }) => Promise<string | undefined>;
    readonly scanIntervalMs?: number;
  }) {}

  registerStore(store: RunStore): void {
    this.stores.add(store);
    if (this.started && !this.shuttingDown) this.recoverStore(store);
  }

  start(): void {
    if (this.shuttingDown) return;
    this.started = true;
    for (const store of this.stores) this.recoverStore(store);
    if (!this.isShuttingDown() && !this.scanTimer) {
      this.scanTimer = setInterval(() => {
        if (this.shuttingDown) return;
        for (const store of this.stores) this.recoverStore(store);
      }, this.options.scanIntervalMs ?? DEFAULT_RECOVERY_SCAN_INTERVAL_MS);
      this.scanTimer.unref?.();
    }
  }

  beginShutdown(): void {
    this.shuttingDown = true;
    this.started = false;
    if (this.scanTimer) clearInterval(this.scanTimer);
    this.scanTimer = undefined;
  }

  /** Admission closes synchronously; actual recovery callbacks retain Store ownership until settled. */
  async waitForIdle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }

  recoverStore(store: RunStore): DaemonRunnerRecoveryResult {
    if (this.isShuttingDown() || this.scansInProgress.has(store)) {
      return { scanned: 0, dispatched: 0, skipped: 0 };
    }
    // The executor can synchronously register stores or request another scan.
    // That must not recursively wrap a discovery sweep or exhaust the stack.
    this.scansInProgress.add(store);
    try {
      return this.recoverStorePage(store);
    } finally {
      this.scansInProgress.delete(store);
    }
  }

  private recoverStorePage(store: RunStore): DaemonRunnerRecoveryResult {
    const runtime = this.options.runtimeSupervisor.getRuntime(store.paths.cwd, store);
    const dispatches = this.dispatchesFor(store);
    const sweeps = this.discoverySweepsFor(store);
    let scanned = 0;
    let dispatched = 0;
    let skipped = 0;

    const newSweepCutoff = new Date().toISOString();
    const scheduledSweep = sweeps.scheduled ?? { cutoff: newSweepCutoff };
    const scheduledPage = store.listClaimableRunnerContinuations({
      now: scheduledSweep.cutoff,
      createdAtOrBefore: scheduledSweep.cutoff,
      after: scheduledSweep.after,
      limit: RECOVERY_DISCOVERY_PAGE_SIZE,
      scheduledOnly: true,
    });
    // Commit discovery progress only after a successful query, including skipped
    // rows. A short/empty tail ends this sweep; the next scan gets a fresh cutoff.
    sweeps.scheduled = nextDiscoverySweep(scheduledSweep, scheduledPage, (row) => ({
      dueAt: row.nextAttemptAt ?? row.createdAt, createdAt: row.createdAt, id: row.id,
    }));
    for (const continuation of scheduledPage) {
      if (this.isShuttingDown()) return { scanned, dispatched, skipped };
      scanned += 1;
      // Frozen time is discovery-only. Restore/lease expiry must use current time.
      const scheduled = this.recoverableScheduledContinuation(
        store, continuation, runtime, dispatches, new Date().toISOString(),
      );
      if (!scheduled) {
        skipped += 1;
        continue;
      }
      if (this.isShuttingDown()) return { scanned, dispatched, skipped };
      dispatches.add(scheduled.run.id);
      try {
        const completion = this.options.executeExistingRunContinuation({
          cwd: store.paths.cwd,
          runId: scheduled.run.id,
          origin: continuation.origin,
          idempotencyDiscriminator: continuation.id,
          preparedExecution: scheduled.execution,
        });
        dispatched += 1;
        this.trackDispatch(completion, () => dispatches.delete(scheduled.run.id));
      } catch {
        dispatches.delete(scheduled.run.id);
        skipped += 1;
      }
    }

    for (const kind of RECOVERABLE_WORK_UNIT_KINDS) {
      if (this.isShuttingDown()) return { scanned, dispatched, skipped };
      const sweep = sweeps.workUnits[kind] ?? { cutoff: newSweepCutoff };
      const page = store.listWorkUnits({ kind, status: "stale", limit: RECOVERY_DISCOVERY_PAGE_SIZE,
        after: sweep.after, createdAtOrBefore: sweep.cutoff });
      sweeps.workUnits[kind] = nextDiscoverySweep(sweep, page, (row) => ({ createdAt: row.createdAt, id: row.id }));
      for (const workUnit of page) {
        if (this.isShuttingDown()) return { scanned, dispatched, skipped };
        scanned += 1;
        const run = this.recoverableRun(store, workUnit, dispatches);
        if (!run) {
          skipped += 1;
          continue;
        }
        if (this.isShuttingDown()) return { scanned, dispatched, skipped };
        dispatches.add(run.id);
        try {
          const completion = this.options.executeExistingRunContinuation({
            cwd: store.paths.cwd,
            runId: run.id,
            origin: "daemon_recovery",
            idempotencyDiscriminator: "runtime-startup",
          });
          dispatched += 1;
          this.trackDispatch(completion, () => dispatches.delete(run.id));
        } catch {
          dispatches.delete(run.id);
          skipped += 1;
        }
      }
    }
    return { scanned, dispatched, skipped };
  }

  private isShuttingDown(): boolean {
    return this.shuttingDown || this.options.activeRuns.isShuttingDown();
  }

  private trackDispatch(completion: Promise<unknown>, cleanup: () => void): void {
    const owned = completion.then(() => undefined, () => undefined).finally(() => {
      cleanup();
      this.inFlight.delete(owned);
    });
    this.inFlight.add(owned);
  }

  private discoverySweepsFor(store: RunStore): StoreDiscoverySweeps {
    const existing = this.discoverySweeps.get(store);
    if (existing) return existing;
    const created: StoreDiscoverySweeps = { workUnits: {} };
    this.discoverySweeps.set(store, created);
    return created;
  }

  private recoverableScheduledContinuation(
    store: RunStore,
    continuation: RunnerContinuationV1,
    runtime: ReturnType<RuntimeSupervisor["getRuntime"]>,
    dispatches: ReadonlySet<string>,
    now: string,
  ): { readonly run: RunSession; readonly execution: PreparedRunnerContinuationExecution } | undefined {
    if (continuation.origin === "approval_resume" || dispatches.has(continuation.runId)
      || this.options.activeRuns.get(continuation.runId)) {
      return undefined;
    }
    const run = store.getRun(continuation.runId);
    const workUnit = store.getWorkUnit(continuation.workUnitId);
    if (!run
      || run.workUnitId !== continuation.workUnitId
      || (run.status !== "queued" && run.status !== "running")
      || !workUnit
      || workUnit.linkedRunId !== run.id
      || workUnit.status !== "queued"
      || !isDaemonOwnedRecoveryRun(store, workUnit, run)
      || !hasRecoverableScheduledTask(store, workUnit, run, continuation)
      || hasUnresolvedApproval(store, run.id)) {
      return undefined;
    }
    try {
      rebuildExistingRunRequest(run, continuation.origin);
    } catch {
      return undefined;
    }
    if (!readStoredRunnerExecution(run) || !readStoredEffectivePolicySnapshot(run.requestSnapshot)) {
      return undefined;
    }
    const execution = restoreScheduledRunnerContinuationExecution({ store, continuation, runtime, now });
    return execution ? { run, execution } : undefined;
  }

  private recoverableRun(
    store: RunStore,
    workUnit: WorkUnit,
    dispatches: ReadonlySet<string>,
  ): RunSession | undefined {
    if (!workUnit.linkedRunId || !workUnit.activeAttemptId) return undefined;
    const run = store.getRun(workUnit.linkedRunId);
    const attempt = store.getWorkUnitAttempt(workUnit.activeAttemptId);
    if (!run
      || run.workUnitId !== workUnit.id
      || (run.status !== "running" && run.status !== "queued")
      || attempt?.workUnitId !== workUnit.id
      || attempt.status !== "lost"
      || !isDaemonOwnedRecoveryRun(store, workUnit, run)
      || !hasRecoverableStaleTask(store, workUnit, run)
      || dispatches.has(run.id)
      || this.options.activeRuns.get(run.id)
      || hasUnresolvedApproval(store, run.id)) {
      return undefined;
    }
    try {
      rebuildExistingRunRequest(run, "daemon_recovery");
    } catch {
      return undefined;
    }
    if (!readStoredRunnerExecution(run) || !readStoredEffectivePolicySnapshot(run.requestSnapshot)) {
      return undefined;
    }
    return run;
  }

  private dispatchesFor(store: RunStore): Set<string> {
    const existing = this.dispatches.get(store);
    if (existing) return existing;
    const created = new Set<string>();
    this.dispatches.set(store, created);
    return created;
  }
}

/** Scheduled and stale discovery share ownership, not their distinct Attempt eligibility. */
function isDaemonOwnedRecoveryRun(store: RunStore, workUnit: WorkUnit, run: RunSession): boolean {
  if (workUnit.kind !== "task_run" && workUnit.kind !== "conversation_run"
    && workUnit.kind !== "teammate_direct_reply") return false;
  if (workUnit.kind === "task_run") return true;
  const thread = run.threadId ? store.getLingThread(run.threadId) : undefined;
  if (workUnit.kind === "conversation_run") return thread?.kind === "conversation";
  return thread?.kind === "teammate_direct" && Boolean(run.teammateId)
    && thread.teammateId === run.teammateId && workUnit.teammateId === run.teammateId;
}

/** A lost stale task is recoverable only after its original Task was claimed. */
function hasRecoverableStaleTask(store: RunStore, workUnit: WorkUnit, run: RunSession): boolean {
  const task = store.getTask(run.taskId);
  return (workUnit.kind !== "task_run" || Boolean(task))
    && (!task || task.status === "claimed" || task.status === "running");
}

/** Admission can defer a prepared new Run before it claims a Task; stale takeover cannot. */
function hasRecoverableScheduledTask(
  store: RunStore, workUnit: WorkUnit, run: RunSession, continuation: RunnerContinuationV1,
): boolean {
  const task = store.getTask(run.taskId);
  const newRunOrigin = continuation.origin === "manual_resume" || continuation.origin === "queued_followup"
    || continuation.origin === "interrupt_redirect";
  if (!task) {
    return workUnit.kind !== "task_run"
      || (newRunOrigin && hasPreparedReplaySourceLineage(store, run, continuation));
  }
  if (newRunOrigin || continuation.origin === "runner_retry") {
    return task.status === "claimed"
      || ((task.status === "todo" || task.status === "failed")
        && hasPreparedReplaySourceLineage(store, run, continuation));
  }
  return task.status === "claimed" || task.status === "running";
}

/** Missing Task rows are supported only by the already-admitted durable child/retry replay. */
function hasPreparedReplaySourceLineage(store: RunStore, run: RunSession, continuation: RunnerContinuationV1): boolean {
  try {
    const replay = readRunnerContinuationReplayArtifact({ store, continuation });
    const sourceRun = store.getRun(replay.sourceRunId);
    const sourceUnit = store.getWorkUnit(replay.sourceWorkUnitId);
    const sourceAttempt = store.getWorkUnitAttempt(replay.sourceFence.attemptId);
    const expectedSourceRunId = continuation.origin === "runner_retry" ? run.id : run.parentRunId;
    return Boolean(expectedSourceRunId && sourceRun && sourceUnit && sourceAttempt
      && sourceRun.id === expectedSourceRunId
      && sourceRun.workUnitId === sourceUnit.id && sourceUnit.linkedRunId === sourceRun.id
      && sourceAttempt.workUnitId === sourceUnit.id
      && run.contextViewId === replay.contextViewId
      && isDeepStrictEqual(toRuntimeAttemptFence(sourceAttempt), replay.sourceFence)
      && isDeepStrictEqual(readStoredRunnerExecution(run), replay.execution));
  } catch {
    return false;
  }
}

function nextDiscoverySweep<Row, Cursor>(
  sweep: DiscoverySweep<Cursor>,
  page: readonly Row[],
  cursorFor: (row: Row) => Cursor,
): DiscoverySweep<Cursor> | undefined {
  if (page.length < RECOVERY_DISCOVERY_PAGE_SIZE) return undefined;
  return { cutoff: sweep.cutoff, after: cursorFor(page[page.length - 1]!) };
}

function hasUnresolvedApproval(store: RunStore, runId: string): boolean {
  return store.listApprovalRequests({ runId, status: "pending", limit: 1 }).length > 0
    || store.listApprovalRequests({ runId, status: "approved", limit: 1 }).length > 0;
}
