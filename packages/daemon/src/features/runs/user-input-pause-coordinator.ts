import { isDeepStrictEqual } from "node:util";
import { UserInputStoreError, type RunStore, type RuntimeAttemptFenceV1, type CommitUserInputYieldResult, type UserInputRequest } from "@ling-stack/core";
import { PiRunnerYielded, type PiRunnerUserInputRequestReceipt, type PiRunnerUserInputYieldDirective } from "@ling-stack/runner-pi";
import { AttemptExecutorGroup, type HostExecutorDrainResult } from "../../runtime/attempt-execution-quiescence.js";
import { HttpError } from "../../errors.js";

type PauseStore = Pick<RunStore, "createUserInputRequest" | "findRequiredUserInputForAttempt"
  | "commitUserInputYield" | "isCurrentRunExecutionOwner" | "listEvents" | "countEvents">;
export type UserInputPauseResult =
  | { readonly kind: "committed"; readonly result: CommitUserInputYieldResult }
  | { readonly kind: "source_obsolete" }
  | { readonly kind: "quiescence_blocked"; readonly code: "host_executor_unconfirmed" | "durable_evidence_unconfirmed";
      readonly drain: HostExecutorDrainResult };

/**
 * Host-only question → close admission → SDK yield → executor drain → atomic wait.
 * No user abort, ActiveRunRegistry idle, terminal finalizer, lease release or answer
 * dispatch is hidden here. A blocked result must retain the execution's authority
 * and producers; its caller must not fall through to ordinary failure cleanup.
 */
export class UserInputPauseCoordinator {
  readonly #store: PauseStore;
  readonly #runId: string;
  readonly #itemId: string;
  readonly #fence: RuntimeAttemptFenceV1;
  readonly #runnerId: string;
  readonly #group: AttemptExecutorGroup;
  readonly #signal?: AbortSignal;
  readonly #now: () => string;
  #required?: PiRunnerUserInputYieldDirective;
  #flight?: Promise<UserInputPauseResult>;
  #committed?: UserInputPauseResult;

  constructor(options: { readonly store: PauseStore; readonly runId: string; readonly sourceItemId: string;
    readonly sourceFence: RuntimeAttemptFenceV1; readonly runnerId: string; readonly executorGroup: AttemptExecutorGroup;
    readonly signal?: AbortSignal; readonly now?: () => string }) {
    if (!(options.executorGroup instanceof AttemptExecutorGroup)
      || !isDeepStrictEqual(options.executorGroup.source, { runId: options.runId, ...options.sourceFence })
      || !options.sourceItemId || !options.runnerId) throw invalid("user_input_pause_source_invalid");
    this.#store = options.store;
    this.#runId = options.runId;
    this.#itemId = options.sourceItemId;
    const { runId: _runId, ...fence } = options.executorGroup.source;
    this.#fence = Object.freeze(fence);
    this.#runnerId = options.runnerId;
    this.#group = options.executorGroup;
    this.#signal = options.signal;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  /** Synchronous Core create and Host close share one callback, with no await window. */
  request(toolCallId: string, input: unknown): PiRunnerUserInputRequestReceipt {
    this.#assertCurrent();
    this.#group.assertAdmissionOpen();
    // Durable required intent from another callback/recovered source takes priority.
    if (this.beforeBoundary()) throw invalid("user_input_pause_already_required");
    const { request } = this.#store.createUserInputRequest({ sourceRunId: this.#runId,
      sourceItemId: this.#itemId, sourceFence: this.#fence, toolCallId,
      idempotencyKey: "user-input-tool:" + toolCallId, toolInput: input }, this.#now());
    // Core idempotent create returns the original record, including a cancelled
    // one. Replay proves persistence, not that this request can still own a wait.
    this.#assertRequestActive(request);
    if (request.waitMode === "required") {
      const active = this.#store.findRequiredUserInputForAttempt({ sourceRunId: this.#runId, sourceFence: this.#fence });
      if (!active || active.requestId !== request.requestId || active.requestVersion !== request.requestVersion) {
        throw invalid("user_input_request_not_active");
      }
      const receipt = Object.freeze({ kind: "user_input_required" as const,
        requestId: request.requestId, requestVersion: request.requestVersion });
      this.#close(receipt);
      return receipt;
    }
    return Object.freeze({ kind: "user_input_optional", requestId: request.requestId, requestVersion: request.requestVersion });
  }

  /** Required intent is checked before lock-screen waits or compaction admission. */
  beforeBoundary(): PiRunnerUserInputYieldDirective | undefined {
    this.#assertCurrent();
    if (this.#required) return this.#required;
    const request = this.#store.findRequiredUserInputForAttempt({ sourceRunId: this.#runId, sourceFence: this.#fence });
    if (request) {
      this.#assertRequestActive(request);
      this.#close(Object.freeze({ kind: "user_input_required", requestId: request.requestId, requestVersion: request.requestVersion }));
    }
    return this.#required;
  }

  /** Typed SDK settlement is necessary, not sufficient. An observation timeout never releases authority. */
  async completeYield(yielded: PiRunnerYielded, observationTimeoutMs?: number): Promise<UserInputPauseResult> {
    if (!(yielded instanceof PiRunnerYielded)) throw invalid("user_input_sdk_yield_unverified");
    if (this.#required && !isDeepStrictEqual(yielded.request, this.#required)) throw invalid("user_input_sdk_yield_changed");
    if (this.#committed) return this.#committed;
    if (this.#flight) return this.#flight;
    this.#flight = this.#complete(yielded, observationTimeoutMs);
    try {
      const result = await this.#flight;
      if (result.kind === "committed") this.#committed = result;
      return result;
    } finally { this.#flight = undefined; }
  }

  async #complete(yielded: PiRunnerYielded, timeoutMs?: number): Promise<UserInputPauseResult> {
    if (!this.#isCurrent()) return { kind: "source_obsolete" };
    const required = this.beforeBoundary();
    if (!required || !isDeepStrictEqual(required, yielded.request)) throw invalid("user_input_sdk_yield_changed");
    const drain = await this.#group.observeDrain(timeoutMs);
    if (!this.#isCurrent()) return { kind: "source_obsolete" };
    if (drain.status === "blocked") return { kind: "quiescence_blocked", code: "host_executor_unconfirmed", drain };
    if (!isDeepStrictEqual(drain.source, this.#group.source) || !isDeepStrictEqual(drain.requiredInput, required)) {
      throw invalid("user_input_executor_source_changed");
    }
    // Read the real final watermark after every Host settlement. Count/last mismatch
    // is corruption, not permission to truncate evidence or guess an empty log.
    const count = this.#store.countEvents(this.#runId);
    const tail = this.#store.listEvents(this.#runId, { afterSeq: Math.max(0, count - 1), limit: 2 });
    if (!Number.isSafeInteger(count) || count < 0 || (count === 0 ? tail.length !== 0 : tail.length !== 1 || tail[0]!.seq !== count)) {
      throw invalid("user_input_event_watermark_invalid");
    }
    const stoppedAt = this.#now();
    const stopped = timestamp(stoppedAt);
    const settledTimes = drain.operations.map(operation => timestamp(operation.settlement!.settledAt));
    if (timestamp(yielded.sdkStoppedAt) > stopped || tail.some(event => timestamp(event.ts) > stopped)
      || settledTimes.some(time => time > stopped)) throw invalid("user_input_stop_time_invalid");
    // Core resolves and revalidates the complete persisted source in the same
    // writer transaction as the checkpoint; no model payload supplies a thread.
    const persisted = this.#store.findRequiredUserInputForAttempt({ sourceRunId: this.#runId, sourceFence: this.#fence });
    if (!persisted || persisted.requestId !== required.requestId || persisted.requestVersion !== required.requestVersion) {
      throw invalid("user_input_request_changed");
    }
    try {
      const result = this.#store.commitUserInputYield({ threadId: persisted.source.threadId, requestId: required.requestId,
        expectedRequestVersion: required.requestVersion, sourceFence: this.#fence,
        quiescence: { kind: "runner_quiesced", runnerId: this.#runnerId, stoppedAt, lastRunEventSeq: count } }, stoppedAt);
      return { kind: "committed", result };
    } catch (error) {
      if (!this.#isCurrent()) return { kind: "source_obsolete" };
      if (error instanceof UserInputStoreError && error.code === "not_quiescent") {
        return { kind: "quiescence_blocked", code: "durable_evidence_unconfirmed", drain };
      }
      throw error;
    }
  }

  #close(required: PiRunnerUserInputYieldDirective): void {
    this.#group.closeAdmission(required);
    this.#required = Object.freeze({ ...required });
  }
  #assertRequestActive(request: UserInputRequest): void {
    // Match Core yield semantics: an answer accepted before expiry remains valid.
    // A still-pending expired request cannot close a reconstructed Host group.
    if (!["pending", "answered"].includes(request.status)
      || request.status === "pending" && request.expiresAt && timestamp(request.expiresAt) <= timestamp(this.#now())) {
      throw invalid("user_input_request_not_active");
    }
  }
  #isCurrent(): boolean { return !this.#signal?.aborted && this.#store.isCurrentRunExecutionOwner(this.#runId, this.#fence); }
  #assertCurrent(): void {
    this.#signal?.throwIfAborted();
    if (!this.#isCurrent()) throw invalid("user_input_pause_source_obsolete");
  }
}
function timestamp(value: string): number {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) throw invalid("user_input_stop_time_invalid");
  return time;
}
function invalid(code: string): HttpError { return new HttpError(409, code, "User input pause rejected without releasing execution authority."); }
