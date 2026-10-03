import {
  parseApprovalAutoReviewVerdict,
  type ApprovalAutoReviewVerdict,
} from "./approval-auto-review-parser.js";

const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_MAX_QUEUED = 16;
const DEFAULT_DEADLINE_MS = 45_000;
const DEFAULT_MAX_TRANSIENT_RETRIES = 1;

export interface ApprovalAutoReviewCoordinatorOptions {
  readonly maxConcurrent?: number;
  readonly maxQueued?: number;
  readonly deadlineMs?: number;
  readonly maxTransientRetries?: number;
}

export interface ApprovalAutoReviewRequest {
  readonly execute: (signal: AbortSignal) => Promise<string>;
  readonly signal?: AbortSignal;
}

export type ApprovalAutoReviewOutcome =
  | {
      readonly status: "resolved";
      readonly verdict: ApprovalAutoReviewVerdict & { readonly decision: "approve" | "deny" };
      readonly attempts: number;
    }
  | {
      readonly status: "manual";
      readonly code:
        | "reviewer_manual"
        | "invalid_output"
        | "execution_failed"
        | "deadline_exceeded"
        | "cancelled"
        | "queue_full";
      readonly reason: string;
      readonly attempts: number;
    };

export interface ApprovalAutoReviewCoordinator {
  review(input: ApprovalAutoReviewRequest): Promise<ApprovalAutoReviewOutcome>;
}

interface ReviewJob {
  readonly input: ApprovalAutoReviewRequest;
  readonly controller: AbortController;
  readonly resolve: (result: ApprovalAutoReviewOutcome) => void;
  readonly deadlineTimer: ReturnType<typeof setTimeout>;
  readonly onSourceAbort?: () => void;
  started: boolean;
  settled: boolean;
  timedOut: boolean;
  cancelled: boolean;
  /** Logical fallback may settle before the current Runner's cleanup has ended. */
  executionCompletion?: Promise<void>;
  executionSettled?: boolean;
}

/**
 * Creates one process-local scheduler. A single shared instance is exported
 * below so automatic reviewers cannot bypass the global concurrency bound by
 * starting from different Runs.
 */
export function createApprovalAutoReviewCoordinator(
  options: ApprovalAutoReviewCoordinatorOptions = {},
): ApprovalAutoReviewCoordinator {
  const maxConcurrent = positiveInteger(options.maxConcurrent, DEFAULT_MAX_CONCURRENT);
  const maxQueued = nonNegativeInteger(options.maxQueued, DEFAULT_MAX_QUEUED);
  const deadlineMs = positiveInteger(options.deadlineMs, DEFAULT_DEADLINE_MS);
  const maxTransientRetries = nonNegativeInteger(
    options.maxTransientRetries,
    DEFAULT_MAX_TRANSIENT_RETRIES,
  );
  const queue: ReviewJob[] = [];
  let active = 0;

  const finish = (job: ReviewJob, outcome: ApprovalAutoReviewOutcome): void => {
    if (job.settled) return;
    job.settled = true;
    clearTimeout(job.deadlineTimer);
    if (job.input.signal && job.onSourceAbort) {
      job.input.signal.removeEventListener("abort", job.onSourceAbort);
    }
    job.resolve(outcome);
  };

  const removeQueued = (job: ReviewJob): void => {
    const index = queue.indexOf(job);
    if (index >= 0) queue.splice(index, 1);
  };

  const pump = (): void => {
    while (active < maxConcurrent && queue.length > 0) {
      const job = queue.shift()!;
      if (job.settled) continue;
      job.started = true;
      active += 1;
      void runReview(job, maxTransientRetries)
        .then(
          (outcome) => finish(job, outcome),
          () => finish(job, manual("execution_failed", "Automatic reviewer could not produce a trusted verdict; manual approval is required.", 0)),
        )
        .finally(async () => {
          // An abort/deadline only returns control to the human. Keep the
          // physical slot until the actual execute promise has settled, so
          // abandoned cleanup cannot escape the process concurrency bound.
          // Avoid adding a microtask when physical execution already ended:
          // an async Host wrapper can immediately request the next review.
          if (job.executionCompletion && !job.executionSettled) await job.executionCompletion;
          active -= 1;
          pump();
        });
    }
  };

  return {
    review(input) {
      if (input.signal?.aborted) {
        return Promise.resolve(manual("cancelled", "Automatic review was cancelled; manual approval is required.", 0));
      }
      if (active >= maxConcurrent && queue.length >= maxQueued) {
        return Promise.resolve(manual("queue_full", "Automatic review queue is full; manual approval is required.", 0));
      }
      return new Promise<ApprovalAutoReviewOutcome>((resolve) => {
        const controller = new AbortController();
        const job = {} as ReviewJob;
        const onSourceAbort = input.signal
          ? () => {
              job.cancelled = true;
              controller.abort();
              if (!job.started) {
                removeQueued(job);
                finish(job, manual("cancelled", "Automatic review was cancelled; manual approval is required.", 0));
              }
            }
          : undefined;
        const deadlineTimer = setTimeout(() => {
          job.timedOut = true;
          controller.abort();
          if (!job.started) {
            removeQueued(job);
            finish(job, manual("deadline_exceeded", "Automatic review exceeded its shared deadline; manual approval is required.", 0));
          }
        }, deadlineMs);
        Object.assign(job, {
          input,
          controller,
          resolve,
          deadlineTimer,
          onSourceAbort,
          started: false,
          settled: false,
          timedOut: false,
          cancelled: false,
        });
        if (typeof deadlineTimer.unref === "function") deadlineTimer.unref();
        input.signal?.addEventListener("abort", onSourceAbort!, { once: true });
        queue.push(job);
        pump();
      });
    },
  };
}

async function runReview(job: ReviewJob, maxTransientRetries: number): Promise<ApprovalAutoReviewOutcome> {
  let attempts = 0;
  for (;;) {
    if (job.controller.signal.aborted) return abortedOutcome(job, attempts);
    attempts += 1;
    try {
      const execution = Promise.resolve(job.input.execute(job.controller.signal));
      // Observe rejection immediately, including synchronous cancellation
      // inside execute before raceWithAbort installs its abort listener.
      job.executionSettled = false;
      job.executionCompletion = execution.then(
        () => { job.executionSettled = true; },
        () => { job.executionSettled = true; },
      );
      const output = await raceWithAbort(execution, job.controller.signal);
      if (job.controller.signal.aborted) return abortedOutcome(job, attempts);
      const parsed = parseApprovalAutoReviewVerdict(output);
      if (!parsed.ok) {
        return manual("invalid_output", "Automatic reviewer returned an invalid verdict; manual approval is required.", attempts);
      }
      const verdict = parsed.verdict;
      if (verdict.decision === "manual") {
        return manual("reviewer_manual", verdict.reason, attempts);
      }
      return { status: "resolved", verdict: { ...verdict, decision: verdict.decision }, attempts };
    } catch (error) {
      if (job.controller.signal.aborted || isAbortError(error)) return abortedOutcome(job, attempts);
      if (attempts <= maxTransientRetries && isTransientTransportError(error)) continue;
      return manual("execution_failed", "Automatic reviewer could not produce a trusted verdict; manual approval is required.", attempts);
    }
  }
}

function abortedOutcome(job: ReviewJob, attempts: number): ApprovalAutoReviewOutcome {
  if (job.timedOut) {
    return manual("deadline_exceeded", "Automatic review exceeded its shared deadline; manual approval is required.", attempts);
  }
  return manual("cancelled", "Automatic review was cancelled; manual approval is required.", attempts);
}

function manual(
  code: Extract<ApprovalAutoReviewOutcome, { readonly status: "manual" }>["code"],
  reason: string,
  attempts: number,
): ApprovalAutoReviewOutcome {
  return { status: "manual", code, reason, attempts };
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(createAbortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(createAbortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function isTransientTransportError(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code ?? "").toUpperCase()
    : "";
  if (["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT"].includes(code)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /(fetch failed|network error|socket hang up|temporarily unavailable|http (408|429|500|502|503|504)|status (408|429|500|502|503|504))/iu.test(message);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function createAbortError(): Error {
  const error = new Error("Automatic review aborted.");
  error.name = "AbortError";
  return error;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value! > 0 ? value! : fallback;
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value! >= 0 ? value! : fallback;
}

export const approvalAutoReviewCoordinator = createApprovalAutoReviewCoordinator();
