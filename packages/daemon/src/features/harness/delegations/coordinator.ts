import {
  toRuntimeAttemptFence,
  type AppendedDelegationInstruction, type AppendDelegationInstructionInput,
  type ClaimedDelegatedChild, type ClaimDelegatedChildInput, type CommitDelegatedChildStartInput,
  type DelegationRecoveryClassification, type RuntimeAttemptFenceV1,
} from "@ling-stack/core";

export interface DelegationLifecycleHostStore {
  readonly claimDelegatedChild: (input: ClaimDelegatedChildInput) => ClaimedDelegatedChild;
  readonly commitDelegatedChildStart: (input: CommitDelegatedChildStartInput) => ClaimedDelegatedChild;
  readonly appendDelegationInstruction: (input: AppendDelegationInstructionInput) => AppendedDelegationInstruction;
  readonly classifyDelegatedChildRecovery: (reservationId: string) => DelegationRecoveryClassification;
}
export interface DelegationLifecycleCoordinatorPorts {
  readonly store: DelegationLifecycleHostStore;
  readonly runtimeInstanceId: string;
  readonly now: () => string;
  /** Called by the actual Runner acceptance boundary. Resolution alone is not evidence. */
  readonly dispatch: (child: ClaimedDelegatedChild, onAccepted: (adapterReference: unknown) => void) => Promise<void>;
  readonly captureStart: (adapterReference: unknown) => object;
  /** Commit failure after real acceptance must request physical stop, not undo SQLite. */
  readonly stopAfterRejectedStart: (child: ClaimedDelegatedChild, sourceFence: RuntimeAttemptFenceV1) => Promise<void>;
  /** EventHub may wake the observer, but durable store remains the authority. */
  readonly waitForChange: (reservationId: string, timeoutMs: number, signal?: AbortSignal) => Promise<void>;
}
export type DelegatedChildStartResult =
  | { readonly status: "started"; readonly child: ClaimedDelegatedChild }
  | { readonly status: "recovery_required"; readonly runtime: DelegationRecoveryClassification; readonly code: "delegation.recovery_required" };

/**
 * One composition-root coordinator, not a second orchestrator. Dispatches an
 * initial claim once per process. Reopened claims are observation-only until
 * the Host reconciles genuine adapter evidence; no response loss can respawn.
 */
export function createDelegationLifecycleCoordinator(ports: DelegationLifecycleCoordinatorPorts): {
  readonly start: (reservationId: string, expectedStepRevision: number) => Promise<DelegatedChildStartResult>;
  readonly message: (input: Omit<AppendDelegationInstructionInput, "now">) => AppendedDelegationInstruction;
  readonly wait: (reservationId: string, timeoutMs: number, signal?: AbortSignal) => Promise<{ readonly timedOut: boolean; readonly runtime: DelegationRecoveryClassification }>;
  /** Shutdown/recovery must observe these owned physical-stop lifetimes too. */
  readonly drainRejectedStarts: () => Promise<void>;
} {
  const pending = new Map<string, { readonly revision: number; readonly promise: Promise<DelegatedChildStartResult> }>();
  const rejectedStops = new Map<string, Promise<void>>();
  const recover = (id: string): DelegatedChildStartResult => ({ status: "recovery_required", code: "delegation.recovery_required",
    runtime: ports.store.classifyDelegatedChildRecovery(id) });
  const start = (reservationId: string, revision: number): Promise<DelegatedChildStartResult> => {
    const existing = pending.get(reservationId);
    if (existing) {
      if (existing.revision !== revision) return Promise.reject(Object.assign(new Error("delegation.idempotency_conflict"), { code: "delegation.idempotency_conflict" }));
      return existing.promise;
    }
    const promise = (async (): Promise<DelegatedChildStartResult> => {
      const child = ports.store.claimDelegatedChild({ reservationId, expectedStepRevision: revision,
        runtimeInstanceId: ports.runtimeInstanceId, now: ports.now() });
      if (child.replayed) return recover(reservationId);
      const sourceFence = toRuntimeAttemptFence(child.attempt);
      let accepted: ClaimedDelegatedChild | undefined;
      let startRejected = false;
      let dispatchOpen = true;
      const stopRejectedStart = (): Promise<void> => {
        const key = `${sourceFence.workUnitId}:${sourceFence.attemptId}:${sourceFence.runtimeInstanceId}:${sourceFence.fencingToken}`;
        const existing = rejectedStops.get(key);
        if (existing) return existing;
        const stop = Promise.resolve().then(() => ports.stopAfterRejectedStart(child, sourceFence));
        rejectedStops.set(key, stop);
        // Retain the original promise for drain/recovery, including rejection.
        // A late event must not become an unhandled rejection before shutdown.
        void stop.catch(() => {});
        return stop;
      };
      try {
        await ports.dispatch(child, reference => {
          try {
            if (!dispatchOpen) throw Object.assign(new Error("delegation.source_attempt_stale"), { code: "delegation.source_attempt_stale" });
            accepted = ports.store.commitDelegatedChildStart({ reservationId, sourceFence,
              observation: ports.captureStart(reference), now: ports.now() });
          } catch (error) {
            startRejected = true;
            // Own stop at the callback boundary itself: an adapter may swallow
            // this exception, or deliver acceptance after dispatch settled.
            void stopRejectedStart();
            throw error;
          }
        });
      } catch (error) {
        // The SDK/OS may have started even though dispatch returned an error.
        // Keep the reservation and claim. Stop failures propagate as failures.
        if (startRejected) await stopRejectedStart();
        if (accepted) throw error;
        return recover(reservationId);
      } finally { dispatchOpen = false; }
      if (startRejected) { await stopRejectedStart(); return recover(reservationId); }
      // A dispatch Promise or ready narration never substitutes for acceptance.
      if (!accepted) return recover(reservationId);
      return { status: "started", child: accepted };
    })();
    pending.set(reservationId, { revision, promise });
    void promise.finally(() => { if (pending.get(reservationId)?.promise === promise) pending.delete(reservationId); }).catch(() => {});
    return promise;
  };
  return Object.freeze({ start,
    async drainRejectedStarts() {
      for (const [key, stop] of rejectedStops) { await stop; if (rejectedStops.get(key) === stop) rejectedStops.delete(key); }
    },
    message: (input: Omit<AppendDelegationInstructionInput, "now">) => ports.store.appendDelegationInstruction({ ...input, now: ports.now() }),
    async wait(reservationId: string, timeoutMs: number, signal?: AbortSignal) {
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 60_000) throw new Error("delegation.invalid_wait_timeout");
      const initial = ports.store.classifyDelegatedChildRecovery(reservationId);
      if (initial.kind === "terminal" || timeoutMs === 0 || signal?.aborted) return { timedOut: initial.kind !== "terminal", runtime: initial };
      const deadline = Math.min(Date.parse(ports.now()) + timeoutMs, Date.parse(initial.runtime.reservation.deadlineAt));
      const observerDeadline = Date.now() + timeoutMs;
      let runtime: DelegationRecoveryClassification = initial;
      while (!signal?.aborted) {
        const remaining = Math.max(0, Math.min(deadline - Date.parse(ports.now()), observerDeadline - Date.now()));
        if (!remaining) break;
        await ports.waitForChange(reservationId, remaining, signal);
        runtime = ports.store.classifyDelegatedChildRecovery(reservationId);
        if (runtime.kind === "terminal") return { timedOut: false, runtime };
      }
      return { timedOut: true, runtime };
    },
  });
}
