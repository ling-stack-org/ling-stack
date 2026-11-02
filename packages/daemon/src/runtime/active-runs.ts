import type { RunEventEnvelope } from "@ling-stack/core";
import type { AttemptExecutionSource } from "./attempt-execution-quiescence.js";
import { AttemptLocalWriterGroup } from "./attempt-local-writers.js";
import { readOriginalAttemptExecutorGroupSnapshot, type AttemptExecutorGroup } from "./attempt-execution-quiescence.js";
import { verifyDelegatedTerminalHandoff, type DelegatedTerminalHandoff } from "./delegated-terminal-handoff.js";

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
  /** Host-selected current executor capability, not a persisted-version fallback. */
  readonly runtimeShutdownPolicy?: "checkpoint" | "stop_without_resume";
  /** Original Host request callback. Fulfilment acknowledges persistence only, never physical stop. */
  readonly requestGracefulSuspension?: (request: ActiveRunSuspensionRequest) => void | Promise<void>;
  readonly terminalHandoff?: DelegatedTerminalHandoff;
}

export interface ActiveRunSuspensionRequest {
  readonly cause: Extract<ActiveRunStopIntentV1, { kind: "runtime_suspend" }>["cause"];
  readonly source: AttemptExecutionSource;
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
  private admissionClosed = false;
  private shutdownMode?: "abort" | "graceful";
  private gracefulRequestBarrier?: Promise<void>;
  private readonly gracefulRequests = new Set<Promise<void>>();
  private readonly gracefulRequested = new WeakSet<RegisteredActiveRun>();
  private readonly gracefulRequestFailures: unknown[] = [];
  private readonly terminalHandoffs: { readonly source: AttemptExecutionSource; readonly reference: DelegatedTerminalHandoff }[] = [];

  add(runId: string, run: ActiveRun): void {
    const registered = { ...run };
    this.activeRuns.set(runId, registered);
    if (run.completion) {
      if (run.workUnitId && run.attemptId && run.runtimeInstanceId && run.fencingToken) {
        this.trackAttemptCompletion({ runId, workUnitId: run.workUnitId, attemptId: run.attemptId,
          runtimeInstanceId: run.runtimeInstanceId, fencingToken: run.fencingToken }, run.completion);
      } else this.trackCompletion(run.completion);
    }
    if (this.shutdownCause) {
      if (this.shutdownMode === "graceful") this.requestCapturedSuspension(runId, registered);
      else this.requestStop(runId, {
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

  /** Close launch admission without invoking sources before other domains close theirs. */
  stopAdmission(): void {
    this.admissionClosed = true;
  }

  suspendAll(cause: Extract<ActiveRunStopIntentV1, { kind: "runtime_suspend" }>["cause"]): void {
    if (this.shutdownMode === "graceful") throw new Error("runtime_graceful_suspension_cannot_be_replaced_by_abort");
    this.shutdownMode = "abort";
    this.shutdownCause ??= cause;
    for (const [runId, run] of this.activeRuns) {
      this.requestStop(runId, {
        kind: "runtime_suspend",
        cause: this.shutdownCause,
        runtimeInstanceId: run.runtimeInstanceId ?? "unknown-runtime",
      });
    }
  }

  /**
   * Close admission, then ask each original execution to persist its exact
   * source-bound intent. This deliberately does not set stopIntent or abort:
   * a later explicit cancellation keeps its own disposition. The separate
   * physical-lifetime and durable stopped-receipt barriers remain mandatory.
   */
  requestGracefulSuspension(cause: ActiveRunSuspensionRequest["cause"]): Promise<void> {
    if (!["daemon_restart", "desktop_quit", "process_signal"].includes(cause)) {
      return Promise.reject(new TypeError("runtime_graceful_suspension_cause_invalid"));
    }
    if (this.shutdownMode === "abort") return Promise.reject(new Error("runtime_already_aborting"));
    if (this.gracefulRequestBarrier) return this.gracefulRequestBarrier;
    this.shutdownMode = "graceful";
    this.shutdownCause ??= cause;
    let resolveBarrier!: () => void, rejectBarrier!: (error: unknown) => void;
    this.gracefulRequestBarrier = new Promise<void>((resolve, reject) => { resolveBarrier = resolve; rejectBarrier = reject; });
    for (const [runId, run] of this.activeRuns) this.requestCapturedSuspension(runId, run);
    void this.waitForGracefulRequests().then(resolveBarrier, rejectBarrier);
    // A caller may observe the barrier later, after shutting down other domains.
    // Retain the rejection without emitting an unhandled rejection meanwhile.
    void this.gracefulRequestBarrier.catch(() => undefined);
    return this.gracefulRequestBarrier;
  }

  /** Recheck after actual execution/preflight drain; a later registration can fail after initial acceptance. */
  waitForGracefulSuspensionRequests(): Promise<void> {
    if (this.shutdownMode !== "graceful") return Promise.reject(new Error("runtime_graceful_suspension_not_requested"));
    return this.waitForGracefulRequests();
  }

  /** This is a separate final proof, never graceful/resumable acceptance. */
  verifyTerminalShutdownHandoffs(): void {
    const failures: unknown[] = [];
    for (const handoff of this.terminalHandoffs) {
      try {
        const active = this.activeRuns.get(handoff.source.runId);
        if (active && !sameAttempt(active, handoff.source)) throw new Error("runtime_terminal_handoff_source_replaced");
        verifyDelegatedTerminalHandoff(handoff.reference, handoff.source, "settled");
      } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "runtime_terminal_handoff_unverified");
  }

  private requestCapturedSuspension(runId: string, run: RegisteredActiveRun): void {
    if (this.gracefulRequested.has(run)) return;
    this.gracefulRequested.add(run);
    let accepted: void | Promise<void>;
    try {
      if (!runId || !run.completion || !run.workUnitId || !run.attemptId || !run.runtimeInstanceId
        || !run.fencingToken) {
        throw new Error("runtime_graceful_suspension_source_unverified");
      }
      const source = Object.freeze({ runId, workUnitId: run.workUnitId, attemptId: run.attemptId,
        runtimeInstanceId: run.runtimeInstanceId, fencingToken: run.fencingToken });
      if (run.abortController.signal.aborted && run.terminalHandoff !== undefined) {
        verifyDelegatedTerminalHandoff(run.terminalHandoff, source, "capture");
        this.terminalHandoffs.push({ source, reference: run.terminalHandoff! });
        return;
      }
      if (run.runtimeShutdownPolicy === "stop_without_resume") {
        // The original entry still owns its terminal/drain path. This is not
        // checkpoint acceptance, a stopped receipt or permission to replay.
        // An earlier explicit stop keeps its disposition; it must still pass
        // the same original lifetime/finalization barriers as a new stop.
        this.requestStop(runId, { kind: "runtime_suspend", cause: this.shutdownCause!, runtimeInstanceId: run.runtimeInstanceId });
        return;
      }
      if (run.abortController.signal.aborted) throw new Error("runtime_terminal_handoff_source_unverified");
      if (!run.requestGracefulSuspension) throw new Error("runtime_graceful_suspension_source_unverified");
      accepted = run.requestGracefulSuspension(Object.freeze({ cause: this.shutdownCause!, source }));
    } catch (error) { this.gracefulRequestFailures.push(error); return; }
    const request = Promise.resolve(accepted).catch(error => { this.gracefulRequestFailures.push(error); });
    this.gracefulRequests.add(request);
    this.trackCompletion(request);
    void request.then(() => this.gracefulRequests.delete(request));
  }

  private async waitForGracefulRequests(): Promise<void> {
    // Preflight executions may register their exact source while an earlier
    // source persists its request. Include these actual callbacks too.
    while (this.gracefulRequests.size) await Promise.all([...this.gracefulRequests]);
    if (this.gracefulRequestFailures.length) {
      throw new AggregateError([...this.gracefulRequestFailures], "runtime_graceful_suspension_request_failed");
    }
  }

  isShuttingDown(): boolean {
    return this.admissionClosed || this.shutdownCause !== undefined;
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
