import { randomUUID } from "node:crypto";
import { setImmediate as yieldToForeground } from "node:timers/promises";
import {
  RunEvaluationInputError,
  type CreateRunEvaluationGradeInput,
  type RunEvaluationStore,
  type RunStore,
} from "@ling-stack/core";
import { RunEvaluationArtifactError, executeDeterministicRuleEvaluation } from "./rule-grader.js";

export type RunEvaluationSchedulerStore = Pick<
  RunStore,
  | "paths"
  | "getArtifact"
  | "createArtifact"
  | keyof RunEvaluationStore
>;

export type RunEvaluationProcessDisposition = "idle" | "stopped" | "completed" | "failed" | "requeued" | "claim_lost";

export interface RunEvaluationProcessResult {
  readonly disposition: RunEvaluationProcessDisposition;
  readonly evaluationId?: string;
}

export interface ProcessNextRunEvaluationOptions {
  readonly store: RunEvaluationSchedulerStore;
  readonly workerId: string;
  readonly now?: string;
  readonly leaseMs?: number;
  readonly retryDelayMs?: number;
  readonly signal?: AbortSignal;
  readonly grade?: (input: {
    readonly store: RunEvaluationSchedulerStore;
    readonly evaluation: NonNullable<ReturnType<RunEvaluationSchedulerStore["getRunEvaluation"]>>;
    readonly now: string;
    readonly signal?: AbortSignal;
  }) => CreateRunEvaluationGradeInput | Promise<CreateRunEvaluationGradeInput>;
}

/** Claims and settles at most one durable evaluation without touching normal Run scheduling. */
export async function processNextRunEvaluation(
  options: ProcessNextRunEvaluationOptions,
): Promise<RunEvaluationProcessResult> {
  if (options.signal?.aborted) return { disposition: "stopped" };
  // The worker is low priority. Defer even its synchronous SQLite claim and
  // deterministic grader until already queued foreground callbacks have run.
  // A microtask alone still runs before that foreground work.
  await yieldToForeground();
  if (options.signal?.aborted) return { disposition: "stopped" };
  const now = options.now ?? new Date().toISOString();
  const leaseMs = positiveInteger(options.leaseMs, 60_000, "evaluation lease");
  const retryDelayMs = positiveInteger(options.retryDelayMs, 5_000, "evaluation retry delay");
  if (options.signal?.aborted) return { disposition: "stopped" };
  const candidate = options.store.listClaimableRunEvaluations({ now, limit: 1 })[0];
  if (!candidate) return { disposition: "idle" };
  const claimToken = `evaluation_claim_${randomUUID()}`;
  const claimExpiresAt = new Date(Date.parse(now) + leaseMs).toISOString();
  const claimed = options.store.claimRunEvaluation({
    evaluationId: candidate.id,
    expectedRevision: candidate.revision,
    claimOwner: options.workerId,
    claimToken,
    claimExpiresAt,
    now,
  });
  if (!claimed.ok) return { disposition: "claim_lost", evaluationId: candidate.id };
  const grading = options.store.startRunEvaluation({
    evaluationId: candidate.id,
    expectedRevision: claimed.value.revision,
    claimOwner: options.workerId,
    claimToken,
    now,
  });
  if (!grading.ok) return { disposition: "claim_lost", evaluationId: candidate.id };
  try {
    options.signal?.throwIfAborted();
    const grade = await (options.grade ?? ((input) => executeDeterministicRuleEvaluation(input)))({
      store: options.store,
      evaluation: grading.value,
      now,
      signal: options.signal,
    });
    options.signal?.throwIfAborted();
    const completed = options.store.completeRunEvaluation({
      evaluationId: candidate.id,
      expectedRevision: grading.value.revision,
      claimOwner: options.workerId,
      claimToken,
      grade,
      now: options.now ?? new Date().toISOString(),
    });
    return {
      disposition: completed.ok ? "completed" : "claim_lost",
      evaluationId: candidate.id,
    };
  } catch (error) {
    const settledAt = options.now ?? new Date().toISOString();
    if (error instanceof RunEvaluationInputError || error instanceof RunEvaluationArtifactError) {
      const failed = options.store.failRunEvaluation({
        evaluationId: candidate.id,
        expectedRevision: grading.value.revision,
        claimOwner: options.workerId,
        claimToken,
        failureCode: "evaluation.result_invalid",
        now: settledAt,
      });
      return { disposition: failed.ok ? "failed" : "claim_lost", evaluationId: candidate.id };
    }
    const requeued = options.store.requeueRunEvaluation({
      evaluationId: candidate.id,
      expectedRevision: grading.value.revision,
      claimOwner: options.workerId,
      claimToken,
      nextAttemptAt: new Date(Date.parse(settledAt) + retryDelayMs).toISOString(),
      failureCode: "evaluation.grader_unavailable",
      now: settledAt,
    });
    return { disposition: requeued.ok ? "requeued" : "claim_lost", evaluationId: candidate.id };
  }
}

interface SchedulerEntry {
  readonly store: RunEvaluationSchedulerStore;
  timer?: ReturnType<typeof setInterval>;
}

export interface RunEvaluationSchedulerOptions {
  readonly enabled: boolean;
  readonly concurrency?: number;
  readonly scanIntervalMs?: number;
  readonly leaseMs?: number;
  readonly retryDelayMs?: number;
  readonly workerId?: string;
  readonly grade?: ProcessNextRunEvaluationOptions["grade"];
  readonly onError?: (error: unknown) => void;
}

/** Separate low-priority scheduler. SQLite leases are authority; timers are wake-up hints only. */
export class RunEvaluationSchedulerRegistry {
  private readonly entries = new Map<string, SchedulerEntry>();
  private readonly pending = new Set<string>();
  private readonly inFlight = new Map<Promise<void>, AbortController>();
  private readonly concurrency: number;
  private readonly scanIntervalMs: number;
  private readonly leaseMs: number;
  private readonly retryDelayMs: number;
  private readonly workerId: string;
  private stopped = false;
  private active = 0;

  constructor(private readonly options: RunEvaluationSchedulerOptions) {
    this.concurrency = positiveInteger(options.concurrency, 1, "evaluation worker concurrency");
    this.scanIntervalMs = positiveInteger(options.scanIntervalMs, 30_000, "evaluation scan interval");
    this.leaseMs = positiveInteger(options.leaseMs, 60_000, "evaluation lease");
    this.retryDelayMs = positiveInteger(options.retryDelayMs, 5_000, "evaluation retry delay");
    this.workerId = options.workerId ?? `evaluation_worker_${randomUUID()}`;
  }

  registerStore(store: RunEvaluationSchedulerStore): void {
    if (!this.options.enabled || this.stopped || this.entries.has(store.paths.cwd)) return;
    const entry: SchedulerEntry = { store };
    entry.timer = setInterval(() => this.wake(store), this.scanIntervalMs);
    entry.timer.unref?.();
    this.entries.set(store.paths.cwd, entry);
    this.wake(store);
  }

  wake(store: RunEvaluationSchedulerStore): void {
    if (!this.options.enabled || this.stopped) return;
    if (!this.entries.has(store.paths.cwd)) this.registerStore(store);
    this.pending.add(store.paths.cwd);
    this.pump();
  }

  beginShutdown(): void {
    this.stopped = true;
    this.pending.clear();
    for (const entry of this.entries.values()) {
      if (entry.timer) clearInterval(entry.timer);
    }
  }

  abortOwned(): void {
    for (const controller of this.inFlight.values()) controller.abort(new Error("evaluation_scheduler_shutdown"));
  }

  async waitForIdle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight.keys()]);
  }

  private pump(): void {
    while (!this.stopped && this.active < this.concurrency && this.pending.size > 0) {
      const cwd = [...this.pending].sort()[0]!;
      this.pending.delete(cwd);
      const entry = this.entries.get(cwd);
      if (!entry) continue;
      this.active += 1;
      const controller = new AbortController();
      let task!: Promise<void>;
      // Own the promise/controller before a re-entrant grader or Store can request shutdown.
      task = Promise.resolve().then(() => processNextRunEvaluation({
        store: entry.store,
        workerId: this.workerId,
        leaseMs: this.leaseMs,
        retryDelayMs: this.retryDelayMs,
        grade: this.options.grade,
        signal: controller.signal,
      })).then((result) => {
        if (result.disposition === "completed" || result.disposition === "failed") {
          this.pending.add(cwd);
        }
      }).catch((error: unknown) => {
        this.options.onError?.(error);
      }).finally(() => {
        this.active -= 1;
        this.inFlight.delete(task);
        this.pump();
      });
      this.inFlight.set(task, controller);
    }
  }
}

function positiveInteger(value: number | undefined, fallback: number, field: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) throw new Error(`${field} must be a positive integer.`);
  return resolved;
}
