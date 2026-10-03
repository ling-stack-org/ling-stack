import type { RunEventEnvelope } from "@ling-stack/core";
import type { AttemptExecutionSource } from "./attempt-execution-quiescence.js";
import { AttemptLocalWriterGroup } from "./attempt-local-writers.js";

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
  private readonly retainedAttempts = new Map<string, {
    readonly source: AttemptExecutionSource;
    readonly localWriters: AttemptLocalWriterGroup;
    localDrainStatus: "draining" | "drained";
  }>();
  private shutdownCause?: Extract<ActiveRunStopIntentV1, { kind: "runtime_suspend" }>["cause"];

  add(runId: string, run: ActiveRun): void {
    this.activeRuns.set(runId, { ...run });
    if (run.completion) {
      this.trackCompletion(run.completion);
    }
    if (this.shutdownCause) {
      this.requestStop(runId, {
        kind: "runtime_suspend",
        cause: this.shutdownCause,
        runtimeInstanceId: run.runtimeInstanceId ?? "unknown-runtime",
      });
    }
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
