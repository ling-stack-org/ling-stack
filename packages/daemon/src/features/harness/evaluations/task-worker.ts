import { randomUUID } from "node:crypto";
import type {
  RunEvaluationStore, RunEvaluationTaskClaim, RunEvaluationTaskFence,
  RunEvaluationTaskResultInput, RunEvaluationTaskStore,
} from "@ling-stack/core";
import {
  copyImmutableTaskData, prepareRunEvaluationTaskRequest,
  type RunEvaluationTaskExecutionInput,
} from "./task-worker-input.js";
import { processPreparedRunEvaluationTaskClaim, type RunEvaluationTaskDeferredReason,
  type RunEvaluationTaskHostAdapter } from "./task-worker-prepared.js";

export type { RunEvaluationTaskExecutionInput } from "./task-worker-input.js";
export type { RunEvaluationTaskHostAdapter } from "./task-worker-prepared.js";
export type RunEvaluationTaskWorkerStore = RunEvaluationTaskStore & Pick<RunEvaluationStore, "getRunEvaluation">;
export type RunEvaluationTaskExecutor = (input: RunEvaluationTaskExecutionInput) =>
  RunEvaluationTaskResultInput | Promise<RunEvaluationTaskResultInput>;
export type RunEvaluationTaskProcessDisposition =
  "unconfigured" | "idle" | "stopped" | "completed" | "failed" | "cancelled" | "unknown" | "claim_lost" | "deferred";
export interface RunEvaluationTaskProcessResult {
  readonly disposition: RunEvaluationTaskProcessDisposition;
  readonly taskId?: string;
  readonly reason?: RunEvaluationTaskDeferredReason;
}
export interface ProcessNextRunEvaluationTaskOptions {
  readonly store: RunEvaluationTaskWorkerStore;
  readonly workerId: string;
  readonly executor?: RunEvaluationTaskExecutor;
  readonly hostAdapter?: RunEvaluationTaskHostAdapter;
  /** Explicit Host scope pin, not a Provider quota, credential proof or executor assertion. */
  readonly executionScopeDigest?: string;
  readonly leaseMs?: number;
  readonly executionTimeoutMs?: number;
  readonly clock?: () => string;
  readonly signal?: AbortSignal;
}

/** Process one explicitly enrolled repeat; absent executor never reads, claims or admits work. */
export async function processNextRunEvaluationTask(
  options: ProcessNextRunEvaluationTaskOptions,
): Promise<RunEvaluationTaskProcessResult> {
  const executor = options.executor;
  const hostAdapter = options.hostAdapter;
  if (!executor && !hostAdapter) return { disposition: "unconfigured" };
  if (options.signal?.aborted) return { disposition: "stopped" };
  const executionScopeDigest = options.executionScopeDigest;
  if (!hostAdapter && (typeof executionScopeDigest !== "string" || !/^[a-f0-9]{64}$/u.test(executionScopeDigest))) {
    throw new Error("evaluation_task_worker_scope_invalid");
  }
  const leaseMs = positiveDuration(options.leaseMs, 60_000);
  const executionTimeoutMs = positiveDuration(options.executionTimeoutMs, 30_000);
  const clock = (): string => canonicalNow(options.clock);
  const now = clock();
  if (options.signal?.aborted) return { disposition: "stopped" };
  // One bounded recovery page per wake; admission history is classified before a new queue scan.
  options.store.reconcileExpiredRunEvaluationTaskAttemptsPage({ now, limit: 100 });
  if (options.signal?.aborted) return { disposition: "stopped" };
  hostAdapter?.reconcile(now);
  if (options.signal?.aborted) return { disposition: "stopped" };
  const selected = hostAdapter?.selectCandidate
    ? hostAdapter.selectCandidate(now)
    : options.store.listClaimableRunEvaluationTasks({ now, limit: 1 })[0];
  const candidate = selected && (!hostAdapter || hostAdapter.acceptsTask(copyImmutableTaskData(selected))) ? selected : undefined;
  if (!candidate) return { disposition: "idle" };
  if (options.signal?.aborted) return { disposition: "stopped" };
  const claimed = options.store.claimRunEvaluationTask({
    taskId: candidate.id, expectedTaskRevision: candidate.revision,
    claimOwner: options.workerId, claimToken: `evaluation_task_claim_${randomUUID()}`,
    claimExpiresAt: new Date(Date.parse(now) + leaseMs).toISOString(), now,
  });
  if (!claimed.ok) return { disposition: "claim_lost", taskId: candidate.id };
  if (hostAdapter) return processPreparedRunEvaluationTaskClaim({ options, adapter: hostAdapter, claim: claimed.value,
    clock, executionTimeoutMs });
  // The unconfigured gate above leaves this branch with its original executor and scope.
  if (!executor || !executionScopeDigest) throw new Error("evaluation_task_worker_scope_invalid");
  let current = claimed.value;
  const disposition = (value: RunEvaluationTaskProcessDisposition): RunEvaluationTaskProcessResult =>
    ({ disposition: value, taskId: candidate.id });
  const fence = (): RunEvaluationTaskFence => ({
    taskId: current.task.id, attemptId: current.attempt.id,
    expectedTaskRevision: current.task.revision, expectedAttemptRevision: current.attempt.revision,
    claimOwner: current.attempt.claimOwner, claimToken: current.attempt.claimToken, now: clock(),
  });
  const finishBeforeDispatch = (cancelled: boolean): RunEvaluationTaskProcessResult => {
    const finished = options.store.finishRunEvaluationTaskBeforeDispatch({ ...fence(),
      nextState: cancelled ? "cancelled" : "failed",
      failureCode: cancelled ? "evaluation.cancelled_before_dispatch" : "evaluation.task_invalid" });
    return disposition(finished.ok ? cancelled ? "cancelled" : "failed" : "claim_lost");
  };
  let request: ReturnType<typeof prepareRunEvaluationTaskRequest>;
  try {
    if (options.signal?.aborted) return finishBeforeDispatch(true);
    request = prepareRunEvaluationTaskRequest(current, options.store.getRunEvaluation(current.task.evaluationId));
  } catch {
    return finishBeforeDispatch(false);
  }
  if (options.signal?.aborted) return finishBeforeDispatch(true);
  const admissionFence = fence();
  if (options.signal?.aborted) return finishBeforeDispatch(true);
  const admission = options.store.admitRunEvaluationTaskDispatch({ ...admissionFence,
    requestDigest: request.requestDigest, executionScopeDigest });
  if (!admission.ok) return finishBeforeDispatch(false);
  current = admission.value;
  // Successful replay is history, not a second grant to invoke the executor.
  if (!admission.value.mayDispatch) return disposition("claim_lost");

  const controller = new AbortController();
  let uncertain = false;
  let unknownCommitError: unknown;
  let unknownCommitted = false;
  const markUnknown = (): boolean => {
    if (unknownCommitted) return true;
    const marked = options.store.markRunEvaluationTaskDispatchUnknown(fence());
    if (marked.ok) { current = marked.value; unknownCommitted = true; return true; }
    // Expiry does not mean no-start. Exact bounded recovery classifies only this captured attempt.
    const recovered = options.store.reconcileExpiredRunEvaluationTaskAttempt({
      taskId: current.task.id, attemptId: current.attempt.id, now: clock() });
    if (recovered.ok && recovered.value.attempt.state === "unknown_outcome") {
      current = recovered.value; unknownCommitted = true; return true;
    }
    return false;
  };
  const stop = (): void => {
    uncertain = true;
    try { markUnknown(); } catch (error) { unknownCommitError = error; }
    controller.abort();
  };
  const onAbort = (): void => stop();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(stop, executionTimeoutMs);
  try {
    if (options.signal?.aborted) stop();
    if (uncertain) return disposition(unknownCommitted ? "unknown" : "claim_lost");
    const input: RunEvaluationTaskExecutionInput = Object.freeze({
      ...copyImmutableTaskData({ task: current.task, attempt: current.attempt }),
      artifacts: request.artifacts, requestDigest: request.requestDigest, executionScopeDigest,
      signal: controller.signal,
    });
    // Input capture can synchronously re-enter shutdown at a controlled Store/descriptor seam.
    if (uncertain || controller.signal.aborted || options.signal?.aborted) {
      markUnknown();
      return disposition(unknownCommitted ? "unknown" : "claim_lost");
    }
    // There is no await between durable admission, stop recheck and the actual local call.
    const result = await executor(input);
    if (uncertain || controller.signal.aborted || options.signal?.aborted) {
      markUnknown();
      return disposition(unknownCommitted ? "unknown" : "claim_lost");
    }
    // Core validates the untrusted own-data payload. Do not spread/getter-read returned claims here.
    const completed = options.store.completeRunEvaluationTask({ ...fence(), result });
    if (completed.ok) return disposition("completed");
    markUnknown();
    return disposition(unknownCommitted ? "unknown" : "claim_lost");
  } catch {
    uncertain = true;
    markUnknown();
    return disposition(unknownCommitted ? "unknown" : "claim_lost");
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
    // An event-listener failure must not throw globally or permit an unobserved rejection.
    if (unknownCommitError !== undefined && !unknownCommitted) throw unknownCommitError;
  }
}

interface WorkerEntry { readonly store: RunEvaluationTaskWorkerStore; timer?: ReturnType<typeof setInterval> }
export interface RunEvaluationTaskWorkerRegistryOptions {
  readonly enabled?: boolean;
  readonly executor?: RunEvaluationTaskExecutor;
  readonly hostAdapter?: RunEvaluationTaskHostAdapter;
  readonly executionScopeDigest?: string;
  readonly concurrency?: number;
  readonly scanIntervalMs?: number;
  readonly leaseMs?: number;
  readonly executionTimeoutMs?: number;
  readonly clock?: () => string;
  readonly workerId?: string;
  readonly onError?: (error: unknown) => void;
}

/** Explicit independent internal worker. Registration is Host-only; there is no automatic enrollment or ordinary Run quota. */
export class RunEvaluationTaskWorkerRegistry {
  private readonly entries = new Map<string, WorkerEntry>();
  private readonly pending = new Set<string>();
  private readonly inFlight = new Map<Promise<void>, AbortController>();
  private readonly concurrency: number;
  private readonly scanIntervalMs: number;
  private readonly workerId: string;
  private active = 0;
  private stopped = false;

  constructor(private readonly options: RunEvaluationTaskWorkerRegistryOptions) {
    this.options = Object.freeze({ ...options });
    this.concurrency = positiveDuration(options.concurrency, 1);
    this.scanIntervalMs = positiveDuration(options.scanIntervalMs, 30_000);
    this.workerId = options.workerId ?? `evaluation_task_worker_${randomUUID()}`;
  }

  registerStore(cwd: string, store: RunEvaluationTaskWorkerStore): void {
    if (!this.configured() || this.stopped || this.entries.has(cwd)) return;
    const entry: WorkerEntry = { store };
    entry.timer = setInterval(() => this.wake(cwd), this.scanIntervalMs);
    entry.timer.unref?.();
    this.entries.set(cwd, entry);
    this.wake(cwd);
  }

  wake(cwd: string): void {
    if (!this.configured() || this.stopped || !this.entries.has(cwd)) return;
    this.pending.add(cwd);
    this.pump();
  }

  /** Close forward admission synchronously before signalling only owned adapters. */
  beginShutdown(): void {
    this.stopped = true;
    this.pending.clear();
    for (const entry of this.entries.values()) if (entry.timer) clearInterval(entry.timer);
    for (const controller of this.inFlight.values()) controller.abort();
  }

  /** No timeout, fabricated idle or early Store close while a callback is still alive. */
  async waitForIdle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight.keys()]);
  }

  private configured(): boolean { return this.options.enabled === true && (this.options.executor !== undefined || this.options.hostAdapter !== undefined); }

  private pump(): void {
    while (!this.stopped && this.active < this.concurrency && this.pending.size > 0) {
      const cwd = this.pending.values().next().value as string;
      this.pending.delete(cwd);
      const entry = this.entries.get(cwd);
      if (!entry) continue;
      const controller = new AbortController();
      this.active += 1;
      let task!: Promise<void>;
      // Register lifetime and controller before even clock/Store code can re-enter shutdown.
      task = Promise.resolve().then(() => processNextRunEvaluationTask({
        store: entry.store, workerId: this.workerId, executor: this.options.executor,
        hostAdapter: this.options.hostAdapter,
        executionScopeDigest: this.options.executionScopeDigest,
        leaseMs: this.options.leaseMs, executionTimeoutMs: this.options.executionTimeoutMs,
        clock: this.options.clock, signal: controller.signal,
      })).then(result => {
        if (["completed", "failed", "cancelled", "unknown"].includes(result.disposition)) this.pending.add(cwd);
      }).catch((error: unknown) => {
        try { this.options.onError?.(error); } catch { /* Diagnostic callbacks grant no lifecycle authority. */ }
      }).finally(() => {
        this.active -= 1;
        this.inFlight.delete(task);
        this.pump();
      });
      this.inFlight.set(task, controller);
    }
  }
}

function positiveDuration(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > 2_147_483_647) {
    throw new Error("evaluation_task_worker_option_invalid");
  }
  return resolved;
}
function canonicalNow(clock?: () => string): string {
  const value = clock?.() ?? new Date().toISOString();
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value) {
    throw new Error("evaluation_task_worker_clock_invalid");
  }
  return value;
}
