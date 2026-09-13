import type { RunSession, RunStore, WorkUnit } from "@ling-stack/core";
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

const DEFAULT_RECOVERY_SCAN_INTERVAL_MS = 5_000;

export interface DaemonRunnerRecoveryResult {
  readonly scanned: number;
  readonly dispatched: number;
  readonly skipped: number;
}

/**
 * Re-dispatches only fenced, daemon-owned task continuations after startup.
 * SQLite remains the authority for activation; this class only discovers
 * eligible stale WorkUnits and prevents duplicate in-process dispatch.
 */
export class DaemonRunnerRecoveryCoordinator {
  private readonly stores = new Set<RunStore>();
  private readonly dispatches = new WeakMap<RunStore, Set<string>>();
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
    if (!this.scanTimer) {
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

  recoverStore(store: RunStore): DaemonRunnerRecoveryResult {
    if (this.shuttingDown || this.options.activeRuns.isShuttingDown()) {
      return { scanned: 0, dispatched: 0, skipped: 0 };
    }
    const runtime = this.options.runtimeSupervisor.getRuntime(store.paths.cwd, store);
    const dispatches = this.dispatchesFor(store);
    let scanned = 0;
    let dispatched = 0;
    let skipped = 0;

    const now = new Date().toISOString();
    for (const continuation of store.listClaimableRunnerContinuations({
      now,
      limit: 500,
      scheduledOnly: true,
    })) {
      scanned += 1;
      const scheduled = this.recoverableScheduledContinuation(store, continuation, runtime, dispatches, now);
      if (!scheduled) {
        skipped += 1;
        continue;
      }
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
        void completion.catch(() => undefined).finally(() => {
          dispatches.delete(scheduled.run.id);
        });
      } catch {
        dispatches.delete(scheduled.run.id);
        skipped += 1;
      }
    }

    for (const workUnit of store.listWorkUnits({ kind: "task_run", status: "stale", limit: 500 })) {
      scanned += 1;
      const run = this.recoverableRun(store, workUnit, dispatches);
      if (!run) {
        skipped += 1;
        continue;
      }
      dispatches.add(run.id);
      try {
        const completion = this.options.executeExistingRunContinuation({
          cwd: store.paths.cwd,
          runId: run.id,
          origin: "daemon_recovery",
          idempotencyDiscriminator: "runtime-startup",
        });
        dispatched += 1;
        void completion.catch(() => undefined).finally(() => {
          dispatches.delete(run.id);
        });
      } catch {
        dispatches.delete(run.id);
        skipped += 1;
      }
    }
    return { scanned, dispatched, skipped };
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
    const task = run ? store.getTask(run.taskId) : undefined;
    if (!run
      || run.workUnitId !== workUnit.id
      || (run.status !== "running" && run.status !== "queued")
      || attempt?.workUnitId !== workUnit.id
      || attempt.status !== "lost"
      || (task?.status !== "claimed" && task?.status !== "running")
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

function hasUnresolvedApproval(store: RunStore, runId: string): boolean {
  return store.listApprovalRequests({ runId, status: "pending", limit: 1 }).length > 0
    || store.listApprovalRequests({ runId, status: "approved", limit: 1 }).length > 0;
}
