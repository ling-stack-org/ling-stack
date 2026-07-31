export interface LockedTaskContinuationSnapshot {
  readonly revision: number;
  readonly continueWhileLocked: boolean;
  readonly locked: boolean;
  readonly blocked: boolean;
}

interface LockedTaskContinuationWaiter {
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
}

/**
 * Process-wide cooperative gate for non-visual Agent work. It never interrupts
 * an in-flight atomic tool action; the next model/tool boundary waits until the
 * Desktop reports unlock or the user re-enables continuation.
 */
export class LockedTaskContinuationGate {
  private revision = 0;
  private continueWhileLocked = true;
  private locked = false;
  private readonly waiters = new Set<LockedTaskContinuationWaiter>();

  snapshot(): LockedTaskContinuationSnapshot {
    return Object.freeze({
      revision: this.revision,
      continueWhileLocked: this.continueWhileLocked,
      locked: this.locked,
      blocked: this.isBlocked(),
    });
  }

  update(input: {
    readonly continueWhileLocked: boolean;
    readonly locked: boolean;
  }): LockedTaskContinuationSnapshot {
    if (
      input.continueWhileLocked === this.continueWhileLocked
      && input.locked === this.locked
    ) {
      return this.snapshot();
    }
    this.continueWhileLocked = input.continueWhileLocked;
    this.locked = input.locked;
    this.revision += 1;
    if (!this.isBlocked()) {
      this.releaseWaiters();
    }
    return this.snapshot();
  }

  isBlocked(): boolean {
    return this.locked && !this.continueWhileLocked;
  }

  waitUntilAllowed(signal?: AbortSignal): Promise<void> {
    if (!this.isBlocked()) return Promise.resolve();
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    return new Promise<void>((resolve, reject) => {
      let registered: LockedTaskContinuationWaiter;
      const onAbort = signal
        ? () => {
            this.deleteWaiter(registered);
            reject(abortReason(signal));
          }
        : undefined;
      registered = { resolve, reject, signal, ...(onAbort ? { onAbort } : {}) };
      this.waiters.add(registered);
      if (signal && onAbort) signal.addEventListener("abort", onAbort, { once: true });
      if (!this.isBlocked()) {
        this.deleteWaiter(registered);
        resolve();
      }
    });
  }

  private releaseWaiters(): void {
    for (const waiter of [...this.waiters]) {
      this.deleteWaiter(waiter);
      waiter.resolve();
    }
  }

  private deleteWaiter(waiter: LockedTaskContinuationWaiter): void {
    this.waiters.delete(waiter);
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("locked_task_continuation_wait_aborted");
}
