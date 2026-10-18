import type { RunEventEnvelope } from "@ling-stack/core";
import type { AttemptExecutionSource } from "./attempt-execution-quiescence.js";
import { AttemptLocalWriterGroup } from "./attempt-local-writers.js";
import { readOriginalAttemptExecutorGroupSnapshot, type AttemptExecutorGroup } from "./attempt-execution-quiescence.js";

export type ActiveRunStopIntentV1 =
  | { readonly kind: "user_cancel"; readonly actor: "local-user"; readonly reason: string }
  | { readonly kind: "workflow_cancel"; readonly workflowId: string; readonly reason: string }
  | {
      readonly kind: "runtime_suspend";
      readonly cause: "daemon_restart" | "desktop_quit" | "process_signal";
      readonly runtimeInstanceId: string;
    }
  | {
      readonly kind: "runtime_failure";
      readonly code: "idle_timeout" | "hard_timeout" | "runner_crash" | "execution_loop_detected";
      readonly reason: string;
    };

export interface ActiveRun {
  readonly abortController: AbortController;
  readonly streamEnvelope: (envelope: RunEventEnvelope) => void;
  readonly completion?: Promise<unknown>;
  readonly runtimeInstanceId?: string;
  readonly workUnitId?: string;
  readonly attemptId?: string;
  readonly fencingToken?: string;
  readonly stopIntent?: ActiveRunStopIntentV1;
}

interface RegisteredActiveRun extends ActiveRun {
  stopIntent?: ActiveRunStopIntentV1;
}

export class ActiveRunRegistry {
  private readonly activeRuns = new Map<string, RegisteredActiveRun>();
  private readonly completions = new Set<Promise<unknown>>();
  private readonly idleWaiters = new Set<() => void>();
  private readonly attemptLifetimes = new Map<string, {
    readonly source: AttemptExecutionSource;
    readonly completions: Set<Promise<unknown>>;
    hasCompletion: boolean;
    retireWhenDrained?: boolean;
    executors?: AttemptExecutorGroup;
    readonly deferred: Set<string>;
  }>();
  private readonly retainedAttempts = new Map<string, {
    readonly source: AttemptExecutionSource;
    readonly localWriters: AttemptLocalWriterGroup;
    localDrainStatus: "draining" | "drained";
  }>();
  private shutdownCause?: Extract<ActiveRunStopIntentV1, { kind: "runtime_suspend" }>["cause"];

  add(runId: string, run: ActiveRun): void {
    this.activeRuns.set(runId, { ...run });
    if (run.completion) {
      if (run.workUnitId && run.attemptId && run.runtimeInstanceId && run.fencingToken) {
        this.trackAttemptCompletion({ runId, workUnitId: run.workUnitId, attemptId: run.attemptId,
          runtimeInstanceId: run.runtimeInstanceId, fencingToken: run.fencingToken }, run.completion);
      } else this.trackCompletion(run.completion);
    }
    if (this.shutdownCause) {
      this.requestStop(runId, {
        kind: "runtime_suspend",
        cause: this.shutdownCause,
        runtimeInstanceId: run.runtimeInstanceId ?? "unknown-runtime",
      });
    }
  }

  /** Captured callback lifetime survives live-entry removal, but not a Daemon restart. */
  trackAttemptCompletion(source: AttemptExecutionSource, completion: Promise<unknown>): void {
    const lifetime = this.attemptLifetime(source);
    lifetime.hasCompletion = true;
    lifetime.completions.add(completion);
    this.trackCompletion(completion);
    const finish = () => { lifetime.completions.delete(completion); this.retireIfDrained(source); };
    void completion.then(finish, finish);
  }

  /** Queue continuation work outside the source's own terminal callback lifetime. */
  deferUntilAttemptDrained(source: AttemptExecutionSource, key: string, callback: () => void | Promise<void>): boolean {
    const lifetime = this.attemptLifetimes.get(attemptKey(source));
    if (!lifetime?.completions.size) return false;
    if (lifetime.deferred.has(key)) return true;
    lifetime.deferred.add(key);
    const completion = Promise.allSettled([...lifetime.completions]).then(async () => {
      // A terminal callback may have registered its final local-writer drain.
      if (lifetime.completions.size) {
        lifetime.deferred.delete(key);
        this.deferUntilAttemptDrained(source, key, callback);
        return;
      }
      try { await callback(); }
      catch { console.warn("attempt_continuation_unavailable: continuation remains recoverable"); }
      finally { lifetime.deferred.delete(key); this.retireIfDrained(source); }
    });
    this.trackCompletion(completion);
    return true;
  }

  /** Durable source facts replace completed in-memory observers, never pending or failed persistence. */
  retireDurablyDrainedAttempt(source: AttemptExecutionSource): void {
    const lifetime = this.attemptLifetimes.get(attemptKey(source));
    if (!lifetime) return;
    lifetime.retireWhenDrained = true;
    this.retireIfDrained(source);
  }

  private retireIfDrained(source: AttemptExecutionSource): void {
    const key = attemptKey(source), lifetime = this.attemptLifetimes.get(key);
    if (!lifetime?.retireWhenDrained || lifetime.completions.size || lifetime.deferred.size
      || sameAttemptIfPresent(this.activeRuns.get(source.runId), source)) return;
    this.attemptLifetimes.delete(key);
    this.retainedAttempts.delete(JSON.stringify([source.runId, source.attemptId]));
  }

  registerAttemptExecutors(group: AttemptExecutorGroup): void {
    const snapshot = readOriginalAttemptExecutorGroupSnapshot(group);
    const active = this.activeRuns.get(snapshot.source.runId);
    if (!active || !sameAttempt(active, snapshot.source)) throw new Error("Host executors do not match the captured active Attempt.");
    const lifetime = this.attemptLifetime(snapshot.source);
    if (lifetime.executors && lifetime.executors !== group) throw new Error("Captured Host executors cannot be replaced.");
    lifetime.executors = group;
  }

  /** Local drain and original Host facts are separate; neither registry deletion nor abort proves either. */
  observeAttemptStop(source: AttemptExecutionSource): {
    readonly localExecution: "draining" | "drained" | "unverified";
    readonly effects: "settled" | "pending" | "unknown" | "unverified";
  } {
    const lifetime = this.attemptLifetimes.get(attemptKey(source));
    const active = this.activeRuns.get(source.runId);
    const localExecution = (active && sameAttempt(active, source)) || lifetime?.completions.size
      ? "draining" : lifetime?.hasCompletion ? "drained" : "unverified";
    const snapshot = lifetime?.executors ? readOriginalAttemptExecutorGroupSnapshot(lifetime.executors) : undefined;
    const effects = !snapshot ? "unverified"
      : snapshot.operations.some(operation => operation.settlement?.kind === "unknown_outcome") ? "unknown"
      : snapshot.operations.some(operation => !operation.settlement) ? "pending" : "settled";
    return { localExecution, effects };
  }

  private attemptLifetime(source: AttemptExecutionSource) {
    const key = attemptKey(source);
    let lifetime = this.attemptLifetimes.get(key);
    if (!lifetime) {
      lifetime = { source, completions: new Set<Promise<unknown>>(), hasCompletion: false, deferred: new Set<string>() };
      this.attemptLifetimes.set(key, lifetime);
    }
    return lifetime;
  }

  trackCompletion(completion: Promise<unknown>): void {
    this.completions.add(completion);
    completion.then(() => {
      this.completions.delete(completion);
      this.notifyIdleWaiters();
    }, () => {
      this.completions.delete(completion);
      this.notifyIdleWaiters();
    });
  }

  get(runId: string): ActiveRun | undefined {
    return this.activeRuns.get(runId);
  }

  delete(runId: string): void {
    this.activeRuns.delete(runId);
    for (const lifetime of this.attemptLifetimes.values()) {
      if (lifetime.source.runId === runId) this.retireIfDrained(lifetime.source);
    }
    this.notifyIdleWaiters();
  }

  requestStop(runId: string, intent: ActiveRunStopIntentV1): boolean {
    const run = this.activeRuns.get(runId);
    if (!run) {
      return false;
    }
    if (!run.stopIntent) {
      run.stopIntent = intent;
    }
    if (!run.abortController.signal.aborted) {
      run.abortController.abort(run.stopIntent);
    }
    return true;
  }

  getStopIntent(runId: string): ActiveRunStopIntentV1 | undefined {
    return this.activeRuns.get(runId)?.stopIntent;
  }

  /**
   * Transfer a blocked source's local lifetime, not its execution authority.
   * SQLite blockers/leases remain untouched. Only actual local callback drain
   * can retire its live entry; a successor is never removed by old cleanup.
   */
  retainBlockedAttempt(runId: string, localWriters: AttemptLocalWriterGroup, onLocalDrained: () => void): void {
    const active = this.activeRuns.get(runId);
    const source = localWriters.source;
    if (!active || source.runId !== runId || active.workUnitId !== source.workUnitId
      || active.attemptId !== source.attemptId || active.runtimeInstanceId !== source.runtimeInstanceId
      || active.fencingToken !== source.fencingToken) {
      throw new Error("Retained attempt does not match the registered captured source.");
    }
    const key = JSON.stringify([runId, source.attemptId]);
    const previous = this.retainedAttempts.get(key);
    if (previous) {
      if (previous.localWriters !== localWriters) throw new Error("Retained attempt cannot replace its local writer ownership.");
      return;
    }
    const retained = { source, localWriters, localDrainStatus: "draining" as "draining" | "drained" };
    this.retainedAttempts.set(key, retained);
    localWriters.close();
    const completion = localWriters.waitForIdle().then(() => {
      onLocalDrained();
      retained.localDrainStatus = "drained";
      if (this.activeRuns.get(runId) === active) this.activeRuns.delete(runId);
      this.notifyIdleWaiters();
    });
    this.trackCompletion(completion);
  }

  getRetainedAttempt(runId: string, attemptId: string): {
    readonly source: AttemptExecutionSource; readonly localDrainStatus: "draining" | "drained";
  } | undefined {
    const retained = this.retainedAttempts.get(JSON.stringify([runId, attemptId]));
    return retained ? Object.freeze({ source: retained.source, localDrainStatus: retained.localDrainStatus }) : undefined;
  }

  suspendAll(cause: Extract<ActiveRunStopIntentV1, { kind: "runtime_suspend" }>["cause"]): void {
    this.shutdownCause ??= cause;
    for (const [runId, run] of this.activeRuns) {
      this.requestStop(runId, {
        kind: "runtime_suspend",
        cause: this.shutdownCause,
        runtimeInstanceId: run.runtimeInstanceId ?? "unknown-runtime",
      });
    }
  }

  isShuttingDown(): boolean {
    return this.shutdownCause !== undefined;
  }

  /** Wait for registered executions and callbacks, never infer idle from elapsed time. */
  async waitForIdle(timeoutMs?: number): Promise<void> {
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647)) {
      throw new RangeError("Idle timeout must be a finite non-negative timer duration.");
    }
    if (this.isIdle()) return;
    await new Promise<void>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const onIdle = (): void => {
        if (!this.isIdle()) return;
        this.idleWaiters.delete(onIdle);
        if (timeout !== undefined) clearTimeout(timeout);
        resolve();
      };
      this.idleWaiters.add(onIdle);
      if (timeoutMs !== undefined) {
        timeout = setTimeout(() => {
          this.idleWaiters.delete(onIdle);
          reject(new Error("Runtime is not idle; execution cleanup is still pending."));
        }, timeoutMs);
      }
    });
  }

  private isIdle(): boolean {
    return this.activeRuns.size === 0 && this.completions.size === 0;
  }

  private notifyIdleWaiters(): void {
    for (const onIdle of this.idleWaiters) onIdle();
  }
}

function attemptKey(source: AttemptExecutionSource): string {
  return JSON.stringify([source.runId, source.workUnitId, source.attemptId, source.runtimeInstanceId, source.fencingToken]);
}

function sameAttempt(active: ActiveRun, source: AttemptExecutionSource): boolean {
  return active.workUnitId === source.workUnitId && active.attemptId === source.attemptId
    && active.runtimeInstanceId === source.runtimeInstanceId && active.fencingToken === source.fencingToken;
}

function sameAttemptIfPresent(active: ActiveRun | undefined, source: AttemptExecutionSource): boolean {
  return active !== undefined && sameAttempt(active, source);
}
