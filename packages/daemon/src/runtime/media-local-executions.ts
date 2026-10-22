import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { RuntimeAttemptFenceV1 } from "@ling-stack/core";
import type { AttemptExecutionSource } from "./attempt-execution-quiescence.js";
import type { AttemptLocalWriterGroup } from "./attempt-local-writers.js";

/** Opaque daemon-local lifetime. Completion is not a remote-stop or Core safety receipt. */
export interface MediaLocalExecutionHandle {
  readonly cwd: string;
  readonly mediaJobId: string;
  readonly generation: string;
  readonly completion: Promise<void>;
}
export interface MediaLocalExecutionReservation { readonly completion: Promise<void> }
export interface MediaLocalExecutionReservationInput {
  readonly source: AttemptExecutionSource;
  readonly requestDigest: string;
  readonly toolCallId: string;
  readonly localWriters?: AttemptLocalWriterGroup;
  /** Trusted synchronous Host admission check; never a proof of physical settlement. */
  readonly effectGate?: (mode: "forward" | "observation") => void;
  /** Trusted Host transaction encloses the actual synchronous transport launch. */
  readonly launchEffect?: (mode: "forward" | "observation", effect: () => void) => void;
  /** Exact source lineage read-back for entered tails; parent terminal alone is not obsolete. */
  readonly completionGate?: () => void;
  readonly onLocalCompleted?: () => void | Promise<void>;
}
export interface MediaLocalExecutionBinding {
  readonly cwd: string;
  readonly mediaJobId: string;
  readonly workUnitId?: string;
}
export interface MediaLocalExecutionTickInput {
  readonly cwd: string;
  readonly mediaJobId: string;
  readonly execution?: MediaLocalExecutionHandle;
}
export interface MediaLocalExecutionCapturedBinding {
  readonly source: AttemptExecutionSource;
  readonly requestDigest: string;
  readonly toolCallId: string;
  readonly workUnitId: string;
}
type ChildAttempt = RuntimeAttemptFenceV1 & { readonly runId?: string };
type Phase = "prepared" | "active" | "completing" | "completed";
interface Completion {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}
interface Reservation {
  readonly public: MediaLocalExecutionReservation;
  readonly input: MediaLocalExecutionReservationInput;
  readonly finishWriter?: () => void;
  readonly done: Completion;
  state: "reserved" | "bound" | "completing" | "completed";
}
interface Scheduled {
  readonly timer: ReturnType<typeof setTimeout>;
}
interface Execution {
  readonly handle: MediaLocalExecutionHandle;
  readonly abortController: AbortController;
  readonly key: string;
  readonly done: Completion;
  readonly reservations: Reservation[];
  readonly source?: AttemptExecutionSource;
  readonly requestDigest?: string;
  readonly toolCallId?: string;
  readonly workUnitId?: string;
  readonly effectGate?: MediaLocalExecutionReservationInput["effectGate"];
  readonly launchEffect?: MediaLocalExecutionReservationInput["launchEffect"];
  readonly completionGate?: MediaLocalExecutionReservationInput["completionGate"];
  phase: Phase;
  retained: boolean;
  active: number;
  stopped?: "shutdown" | "source_obsolete";
  cancelled: boolean;
  scheduled?: Scheduled;
  tick?: Promise<unknown>;
  childAttempt?: ChildAttempt;
  lastError?: string;
}
const fenceKeys = ["workUnitId", "attemptId", "runtimeInstanceId", "fencingToken"] as const;

/** A local identity/admission failure must not be projected as a media-job failure. */
export class MediaLocalExecutionAdmissionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "MediaLocalExecutionAdmissionError";
  }
}

/** A finite local drain observation, never a remote stop or release receipt. */
export class MediaLocalExecutionDrainTimeoutError extends Error {
  readonly code = "media_local_drain_timeout";
  readonly details: Readonly<{ activeExecutions: number; activeCallbacks: number; pendingReservations: number }>;

  constructor(details: MediaLocalExecutionDrainTimeoutError["details"]) {
    super("Media local executions have not drained.");
    this.name = "MediaLocalExecutionDrainTimeoutError";
    this.details = Object.freeze({ ...details });
  }
}

/**
 * Owns actual local callbacks, poll reservations and completion tails per daemon.
 * It performs no SQLite writes, remote cancellation, lease release or safety inference.
 * Host code must still gate the actual synchronous forward-effect dispatch.
 */
export class MediaLocalExecutionRegistry {
  readonly #handles = new WeakMap<MediaLocalExecutionHandle, Execution>();
  readonly #reservations = new WeakMap<MediaLocalExecutionReservation, Reservation>();
  readonly #pending = new Set<Reservation>();
  readonly #current = new Map<string, Execution>();
  readonly #active = new Set<Execution>();
  readonly #completed = new Map<string, Execution>();
  readonly #stoppedSources = new Set<string>();
  readonly #waiters = new Set<() => void>();
  readonly #completedLimit: number;
  #shutdown = false;

  constructor(options: { readonly completedLimit?: number } = {}) {
    const limit = options.completedLimit ?? 128;
    if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError("Media completed retention must be non-negative.");
    this.#completedLimit = limit;
  }

  /** Reserve before the first metadata write/await, not after background dispatch. */
  reserve(input: MediaLocalExecutionReservationInput): MediaLocalExecutionReservation {
    this.#assertOpen();
    const source = readSource(input.source);
    if (this.#stoppedSources.has(sourceKey(source))) throw new MediaLocalExecutionAdmissionError("source_obsolete", "Media execution source is obsolete.");
    textIdentity(input.requestDigest, "Media request digest");
    textIdentity(input.toolCallId, "Media tool call identity");
    if (input.localWriters && !sameSource(input.localWriters.source, source)) {
      throw new Error("Media local writer source does not match the captured source.");
    }
    assertGate(input.effectGate, "forward");
    this.#assertOpen();
    if (this.#stoppedSources.has(sourceKey(source))) throw new MediaLocalExecutionAdmissionError("source_obsolete", "Media execution source is obsolete.");
    const done = completion();
    const ticket = Object.freeze({ completion: done.promise });
    const reservation: Reservation = { public: ticket, input: Object.freeze({ ...input, source }), done,
      finishWriter: input.localWriters?.reserve(`media:${input.toolCallId}`), state: "reserved" };
    this.#reservations.set(ticket, reservation);
    this.#pending.add(reservation);
    return ticket;
  }

  /** The prepared generation remains owned until its first dispatch or explicit stop. */
  bindNew(ticket: MediaLocalExecutionReservation, binding: MediaLocalExecutionBinding): MediaLocalExecutionHandle {
    const reservation = this.#reservation(ticket);
    this.#assertReservable(reservation);
    const captured = readBinding(binding);
    const previous = this.#current.get(bindingKey(captured));
    if (previous && previous.phase !== "completed") throw new Error("Media job already has a live local generation.");
    const entry = this.#create(captured, reservation.input);
    reservation.state = "bound";
    entry.reservations.push(reservation);
    return entry.handle;
  }

  /** Exact existing ownership only; a reused DB job cannot manufacture a lifecycle. */
  attachReused(ticket: MediaLocalExecutionReservation, binding: MediaLocalExecutionBinding): MediaLocalExecutionHandle {
    const reservation = this.#reservation(ticket);
    this.#assertReservable(reservation);
    const captured = readBinding(binding);
    const entry = this.#current.get(bindingKey(captured));
    if (!entry?.source || entry.stopped || entry.phase === "completing"
      || !sameSource(entry.source, reservation.input.source)
      || entry.requestDigest !== reservation.input.requestDigest || entry.toolCallId !== reservation.input.toolCallId
      || entry.workUnitId !== captured.workUnitId) {
      throw new Error("Reused media job has no exact captured local execution ownership.");
    }
    reservation.state = "bound";
    if (entry.phase === "completed") this.#finishReservation(reservation);
    else entry.reservations.push(reservation);
    return entry.handle;
  }

  /** Only an unbound ticket may be abandoned; bound callbacks retain their own lifetime. */
  abandon(ticket: MediaLocalExecutionReservation): boolean {
    const reservation = this.#reservation(ticket);
    if (reservation.state !== "reserved") return false;
    this.#finishReservation(reservation);
    return true;
  }

  /** Manual/non-U jobs are tracked too, without claiming a captured Attempt source. */
  getOrStart(input: MediaLocalExecutionTickInput): MediaLocalExecutionHandle {
    this.#assertOpen();
    const binding = readBinding(input);
    if (input.execution !== undefined) {
      const entry = this.#execution(input.execution);
      if (entry.key !== bindingKey(binding)) throw new MediaLocalExecutionAdmissionError("invalid_handle", "Media local handle does not match the requested job/workspace.");
      this.#assertRunnable(entry);
      return entry.handle;
    }
    const previous = this.#current.get(bindingKey(binding));
    if (previous && previous.phase !== "completed") {
      if (previous.source) throw new MediaLocalExecutionAdmissionError("captured_handle_required", "Captured media execution requires its original opaque handle.");
      this.#assertRunnable(previous);
      return previous.handle;
    }
    return this.#create(binding).handle;
  }

  /** Exclusive tick owner. Duplicate tick calls join the same actual execution. */
  runTick<T>(input: MediaLocalExecutionTickInput, owner: (handle: MediaLocalExecutionHandle) => T | Promise<T>): Promise<T> {
    const entry = this.#execution(this.getOrStart(input));
    if (entry.tick) return entry.tick as Promise<T>;
    this.#begin(entry);
    let resolveResult!: (value: T | PromiseLike<T>) => void;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<T>((resolvePromise, rejectPromise) => { resolveResult = resolvePromise; rejectResult = rejectPromise; });
    entry.tick = result;
    const settle = (error?: unknown) => {
      if (error !== undefined) entry.lastError = errorMessage(error);
      if (entry.tick === result) entry.tick = undefined;
      this.#end(entry);
    };
    // Observe before invoking user code: same-stack failure/abort cannot leak a rejection.
    result.then(() => settle(), error => settle(error));
    try { resolveResult(owner(entry.handle)); } catch (error) { rejectResult(error); }
    return result;
  }

  /** Non-exclusive dispatch/catch/cleanup tail; safe to nest around runTick. */
  track<T>(handle: MediaLocalExecutionHandle, callback: () => T | Promise<T>): Promise<T> {
    const entry = this.#execution(handle);
    this.#assertRunnable(entry);
    this.#begin(entry);
    return this.#invoke(entry, callback);
  }

  /** Reserve future polling before setTimeout. Firing transfers ownership without an idle gap. */
  schedule(handle: MediaLocalExecutionHandle, delayMs: number,
    callback: (handle: MediaLocalExecutionHandle) => unknown | Promise<unknown>): void {
    const entry = this.#execution(handle);
    this.#assertRunnable(entry);
    this.assertEffectAllowed(handle, "observation");
    deadline(delayMs);
    // Same opaque generation may refresh a pending poll. No completion/idle check in between.
    if (entry.scheduled) clearTimeout(entry.scheduled.timer);
    entry.phase = "active";
    const scheduled: Scheduled = { timer: setTimeout(() => {
      if (entry.scheduled !== scheduled) return;
      this.#begin(entry); // Transfer timer reservation before removing it.
      entry.scheduled = undefined;
      const priorTick = entry.tick;
      this.#invoke(entry, async () => {
        if (priorTick) await priorTick.then(() => undefined, () => undefined);
        this.#assertRunnable(entry);
        this.assertEffectAllowed(handle, "observation");
        return callback(handle);
      });
    }, delayMs) };
    entry.scheduled = scheduled;
  }

  cancelScheduled(handle: MediaLocalExecutionHandle): void {
    const entry = this.#execution(handle);
    if (entry.scheduled) { clearTimeout(entry.scheduled.timer); entry.scheduled = undefined; }
    this.#tryComplete(entry);
  }

  /** Stop only this job's current generation; entered response/cleanup tails remain owned. */
  cancelJob(input: MediaLocalExecutionBinding & { readonly execution?: MediaLocalExecutionHandle }): boolean {
    const entry = this.#current.get(bindingKey(readBinding(input)));
    if (input.execution && (!entry || this.#execution(input.execution) !== entry)) {
      throw new MediaLocalExecutionAdmissionError("invalid_handle", "Cancelled Media tail no longer owns this job generation.");
    }
    if (!entry || entry.phase === "completed" || entry.phase === "completing") return false;
    const draining = entry.active > 0;
    entry.cancelled = true;
    entry.abortController.abort();
    if (entry.scheduled) { clearTimeout(entry.scheduled.timer); entry.scheduled = undefined; }
    // A prepared-but-never-dispatched generation has no physical tail to drain.
    if (entry.phase === "prepared") entry.phase = "active";
    this.#tryComplete(entry);
    this.#notify();
    return draining;
  }

  /** Business projection is separate from completed native receipt capture. */
  assertBusinessCompletionAllowed(handle: MediaLocalExecutionHandle): void {
    this.assertCompletionAllowed(handle);
    if (this.#execution(handle).cancelled) {
      throw new MediaLocalExecutionAdmissionError("media_job_cancelled", "Media job was locally cancelled; remote outcome is separate.");
    }
  }

  /** A stop request for this exact local generation, never proof of remote cancellation or drain. */
  getAbortSignal(handle: MediaLocalExecutionHandle): AbortSignal {
    return this.#execution(handle).abortController.signal;
  }

  /** Read back the original immutable child fence; a late tail cannot adopt a replacement. */
  getBoundAttempt(handle: MediaLocalExecutionHandle): RuntimeAttemptFenceV1 | undefined {
    const attempt = this.#execution(handle).childAttempt;
    return attempt ? Object.freeze({ workUnitId: attempt.workUnitId, attemptId: attempt.attemptId,
      runtimeInstanceId: attempt.runtimeInstanceId, fencingToken: attempt.fencingToken }) : undefined;
  }

  /** One immutable child Attempt per opaque generation; parent source is separate. */
  bindAttempt(handle: MediaLocalExecutionHandle, attempt: ChildAttempt): void {
    const entry = this.#execution(handle);
    this.#assertRunnable(entry);
    const captured = readAttempt(attempt);
    if (entry.workUnitId && captured.workUnitId !== entry.workUnitId) {
      throw new MediaLocalExecutionAdmissionError("invalid_handle", "Media child work unit does not match its binding.");
    }
    if (entry.childAttempt && !sameAttempt(entry.childAttempt, captured)) {
      throw new MediaLocalExecutionAdmissionError("invalid_handle", "Media local generation cannot replace its child Attempt.");
    }
    entry.childAttempt ??= captured;
  }

  /** Read-only recovery validation. A DB job/approval alone cannot mint a captured capability. */
  assertCapturedBinding(handle: MediaLocalExecutionHandle, binding: MediaLocalExecutionCapturedBinding): void {
    const entry = this.#execution(handle);
    this.#assertRunnable(entry);
    let source: AttemptExecutionSource;
    try {
      source = readSource(binding?.source);
      textIdentity(binding.requestDigest, "Media captured request digest");
      textIdentity(binding.toolCallId, "Media captured tool call identity");
      textIdentity(binding.workUnitId, "Media captured child work unit");
    } catch (error) {
      throw new MediaLocalExecutionAdmissionError("captured_binding_invalid", errorMessage(error));
    }
    if (!entry.source || !sameSource(entry.source, source)
      || entry.requestDigest !== binding.requestDigest || entry.toolCallId !== binding.toolCallId
      || entry.workUnitId !== binding.workUnitId) {
      throw new MediaLocalExecutionAdmissionError("captured_binding_mismatch", "Media local capability does not match the exact persisted captured binding.");
    }
  }

  /** Required-input close is a Host forward-admission decision, not a poll/cleanup stop. */
  assertEffectAllowed(handle: MediaLocalExecutionHandle, mode: "forward" | "observation" = "forward"): void {
    if (mode !== "forward" && mode !== "observation") throw new Error("Invalid media effect mode.");
    const entry = this.#execution(handle);
    this.#assertRunnable(entry);
    assertGate(entry.effectGate, mode);
    this.#assertRunnable(entry);
  }

  /** No await between Host admission and the actual fetch/send invocation. */
  launchEffect(handle: MediaLocalExecutionHandle, mode: "forward" | "observation", effect: () => void): void {
    this.assertEffectAllowed(handle, mode);
    if (typeof effect !== "function") throw new TypeError("Media effect must be a synchronous launch callback.");
    const entry = this.#execution(handle);
    if (entry.launchEffect) entry.launchEffect(mode, effect);
    else effect();
  }

  /** Shutdown allows an already-entered tail; obsolete sources can never write a successor. */
  assertCompletionAllowed(handle: MediaLocalExecutionHandle): void {
    const entry = this.#execution(handle);
    if (entry.stopped === "source_obsolete") throw new MediaLocalExecutionAdmissionError("source_obsolete", "Media execution source is obsolete.");
    if (entry.phase === "completed" || entry.phase === "completing" || entry.active === 0) {
      throw new MediaLocalExecutionAdmissionError("completed", "Media local completion write has no entered callback.");
    }
    try { entry.completionGate?.(); }
    catch (error) {
      if (error instanceof MediaLocalExecutionAdmissionError) throw error;
      throw new MediaLocalExecutionAdmissionError("host_completion_unconfirmed", errorMessage(error));
    }
    const afterGate = this.#execution(handle);
    if (afterGate.stopped === "source_obsolete") throw new MediaLocalExecutionAdmissionError("source_obsolete", "Media execution source is obsolete.");
  }

  beginShutdown(): void {
    this.stopAdmission();
    this.abortOwned();
  }

  stopAdmission(): void {
    this.#shutdown = true;
  }

  abortOwned(): void {
    for (const entry of this.#active) this.#stop(entry, "shutdown");
    this.#notify();
  }

  stopSource(source: AttemptExecutionSource): void {
    const captured = readSource(source);
    this.#stoppedSources.add(sourceKey(captured));
    for (const entry of this.#active) if (entry.source && sameSource(entry.source, captured)) this.#stop(entry, "source_obsolete");
    this.#notify();
  }

  /** Deadline failure changes no membership, ownership, completion or Core authority. */
  async waitForIdle(timeoutMs?: number): Promise<void> {
    if (timeoutMs !== undefined) deadline(timeoutMs);
    if (this.#active.size === 0 && this.#pending.size === 0) return;
    await new Promise<void>((resolvePromise, rejectPromise) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const notify = () => {
        if (this.#active.size !== 0 || this.#pending.size !== 0) return;
        this.#waiters.delete(notify);
        if (timer !== undefined) clearTimeout(timer);
        resolvePromise();
      };
      this.#waiters.add(notify);
      if (timeoutMs !== undefined) timer = setTimeout(() => {
        this.#waiters.delete(notify);
        rejectPromise(new MediaLocalExecutionDrainTimeoutError({ activeExecutions: this.#active.size,
          activeCallbacks: [...this.#active].reduce((count, entry) => count + entry.active, 0),
          pendingReservations: this.#pending.size }));
      }, timeoutMs);
    });
  }

  getSnapshot(): { readonly shutdown: boolean; readonly pendingReservations: number; readonly retainedCompleted: number;
    readonly executions: readonly { readonly cwd: string; readonly mediaJobId: string; readonly generation: string;
      readonly phase: Phase; readonly active: number; readonly scheduled: boolean; readonly stopped?: string; readonly lastError?: string }[] } {
    return Object.freeze({ shutdown: this.#shutdown, pendingReservations: this.#pending.size, retainedCompleted: this.#completed.size,
      executions: Object.freeze([...this.#active, ...this.#completed.values()].map(entry => Object.freeze({
        cwd: entry.handle.cwd, mediaJobId: entry.handle.mediaJobId, generation: entry.handle.generation,
        phase: entry.phase, active: entry.active, scheduled: entry.scheduled !== undefined,
        ...(entry.stopped ? { stopped: entry.stopped } : {}), ...(entry.lastError ? { lastError: entry.lastError } : {}),
      }))) });
  }

  #create(binding: MediaLocalExecutionBinding, input?: MediaLocalExecutionReservationInput): Execution {
    const done = completion();
    const handle = Object.freeze({ cwd: binding.cwd, mediaJobId: binding.mediaJobId, generation: randomUUID(), completion: done.promise });
    const entry: Execution = { handle, abortController: new AbortController(), key: bindingKey(binding), done, reservations: [], phase: "prepared", retained: true, active: 0,
      cancelled: false, source: input?.source, requestDigest: input?.requestDigest, toolCallId: input?.toolCallId,
      workUnitId: binding.workUnitId, effectGate: input?.effectGate, launchEffect: input?.launchEffect,
      completionGate: input?.completionGate };
    this.#handles.set(handle, entry);
    this.#current.set(entry.key, entry);
    this.#active.add(entry);
    return entry;
  }

  #execution(handle: MediaLocalExecutionHandle): Execution {
    const entry = this.#handles.get(handle);
    if (!entry?.retained) throw new MediaLocalExecutionAdmissionError("invalid_handle", "Unknown, expired or foreign media local handle.");
    return entry;
  }
  #reservation(ticket: MediaLocalExecutionReservation): Reservation {
    const reservation = this.#reservations.get(ticket);
    if (!reservation) throw new Error("Unknown or foreign media local reservation.");
    return reservation;
  }
  #assertOpen(): void {
    if (this.#shutdown) throw new MediaLocalExecutionAdmissionError("shutdown", "Media local execution admission is closed for shutdown.");
  }
  #assertReservable(reservation: Reservation): void {
    this.#assertOpen();
    if (reservation.state !== "reserved") throw new Error("Media local reservation has already been consumed.");
    if (this.#stoppedSources.has(sourceKey(reservation.input.source))) throw new MediaLocalExecutionAdmissionError("source_obsolete", "Media execution source is obsolete.");
  }
  #assertRunnable(entry: Execution): void {
    this.#assertOpen();
    if (entry.cancelled) throw new MediaLocalExecutionAdmissionError("media_job_cancelled", "Cancelled Media generation cannot be re-entered.");
    if (entry.stopped === "source_obsolete") throw new MediaLocalExecutionAdmissionError("source_obsolete", "Media local execution is stopped: source obsolete.");
    if (entry.stopped || entry.phase === "completed" || entry.phase === "completing") {
      throw new MediaLocalExecutionAdmissionError("completed", "Media local execution is stopped or completed.");
    }
  }
  #begin(entry: Execution): void { entry.phase = "active"; entry.active++; }
  #end(entry: Execution): void { entry.active--; this.#tryComplete(entry); this.#notify(); }
  #invoke<T>(entry: Execution, callback: () => T | Promise<T>): Promise<T> {
    let result: Promise<T>;
    try { result = Promise.resolve(callback()); } catch (error) { result = Promise.reject(error); }
    result.then(() => this.#end(entry), error => { entry.lastError = errorMessage(error); this.#end(entry); });
    return result;
  }
  #stop(entry: Execution, reason: "shutdown" | "source_obsolete"): void {
    entry.stopped = reason === "source_obsolete" ? reason : entry.stopped ?? reason;
    entry.abortController.abort();
    if (entry.scheduled) { clearTimeout(entry.scheduled.timer); entry.scheduled = undefined; }
    this.#tryComplete(entry);
  }
  #finishReservation(reservation: Reservation): Promise<void> {
    if (reservation.state === "completing" || reservation.state === "completed") return reservation.done.promise;
    reservation.state = "completing";
    let result: Promise<void>;
    try { result = Promise.resolve(reservation.input.onLocalCompleted?.()); } catch (error) { result = Promise.reject(error); }
    result.then(() => finish(), error => finish(error));
    const finish = (error?: unknown) => {
      try { reservation.finishWriter?.(); } catch (releaseError) { error ??= releaseError; }
      finally {
        reservation.state = "completed";
        this.#pending.delete(reservation);
        if (error === undefined) reservation.done.resolve(); else reservation.done.reject(error);
        this.#notify();
      }
    };
    return reservation.done.promise;
  }
  #tryComplete(entry: Execution): void {
    if (entry.phase === "completed" || entry.phase === "completing" || entry.active !== 0 || entry.scheduled
      || (entry.phase === "prepared" && !entry.stopped)) return;
    entry.phase = "completing";
    Promise.allSettled(entry.reservations.map(reservation => this.#finishReservation(reservation))).then(results => {
      const rejected = results.find(result => result.status === "rejected");
      entry.phase = "completed";
      this.#active.delete(entry);
      this.#completed.set(entry.handle.generation, entry);
      if (rejected?.status === "rejected") { entry.lastError = errorMessage(rejected.reason); entry.done.reject(rejected.reason); }
      else entry.done.resolve();
      while (this.#completed.size > this.#completedLimit) {
        const oldest = this.#completed.values().next().value as Execution;
        this.#completed.delete(oldest.handle.generation);
        oldest.retained = false;
        if (this.#current.get(oldest.key) === oldest) this.#current.delete(oldest.key);
      }
      this.#notify();
    });
  }
  #notify(): void { for (const notify of this.#waiters) notify(); }
}

function completion(): Completion {
  let resolvePromise!: () => void, rejectPromise!: (error: unknown) => void;
  const promise = new Promise<void>((resolveValue, rejectValue) => { resolvePromise = resolveValue; rejectPromise = rejectValue; });
  promise.catch(() => undefined); // Internal fire-and-forget lifetimes always observe late rejection.
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}
function textIdentity(value: string, name: string): void {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) throw new Error(`${name} must be a non-empty identity.`);
}
function readAttempt(attempt: ChildAttempt): ChildAttempt {
  if (!attempt || typeof attempt !== "object") throw new Error("Media child Attempt fence is required.");
  for (const key of fenceKeys) textIdentity(attempt[key], `Media ${key}`);
  if (attempt.runId !== undefined) textIdentity(attempt.runId, "Media child runId");
  return Object.freeze({ ...Object.fromEntries(fenceKeys.map(key => [key, attempt[key]])),
    ...(attempt.runId === undefined ? {} : { runId: attempt.runId }) }) as ChildAttempt;
}
function readSource(source: AttemptExecutionSource): AttemptExecutionSource {
  textIdentity(source?.runId, "Media source runId");
  return Object.freeze({ ...readAttempt(source), runId: source.runId });
}
function readBinding(binding: MediaLocalExecutionBinding): MediaLocalExecutionBinding {
  textIdentity(binding.cwd, "Media workspace");
  textIdentity(binding.mediaJobId, "Media job identity");
  if (binding.workUnitId !== undefined) textIdentity(binding.workUnitId, "Media child work unit");
  return Object.freeze({ cwd: canonicalWorkspace(binding.cwd), mediaJobId: binding.mediaJobId,
    ...(binding.workUnitId === undefined ? {} : { workUnitId: binding.workUnitId }) });
}
function canonicalWorkspace(cwd: string): string {
  const resolved = resolve(cwd);
  try { return realpathSync(resolved); }
  catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return resolved;
    throw error;
  }
}
function bindingKey(binding: MediaLocalExecutionBinding): string { return JSON.stringify([binding.cwd, binding.mediaJobId]); }
function sourceKey(source: AttemptExecutionSource): string { return JSON.stringify([source.runId, ...fenceKeys.map(key => source[key])]); }
function sameSource(left: AttemptExecutionSource, right: AttemptExecutionSource): boolean { return sourceKey(left) === sourceKey(right); }
function sameAttempt(left: ChildAttempt, right: ChildAttempt): boolean {
  return left.runId === right.runId && fenceKeys.every(key => left[key] === right[key]);
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function assertGate(gate: MediaLocalExecutionReservationInput["effectGate"], mode: "forward" | "observation"): void {
  try { gate?.(mode); }
  catch (error) {
    if (error instanceof MediaLocalExecutionAdmissionError) throw error;
    throw new MediaLocalExecutionAdmissionError("host_admission_closed", errorMessage(error));
  }
}
function deadline(value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 2_147_483_647) throw new RangeError("Media local deadline must be finite and non-negative.");
}
