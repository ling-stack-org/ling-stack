import type { AttemptExecutionSource } from "./attempt-execution-quiescence.js";

/** Local callback lifetime only. This is not an OS/remote stop or a Core safety receipt. */
export class AttemptLocalWriterGroup {
  readonly source: AttemptExecutionSource;
  readonly #writers = new Map<symbol, string>();
  readonly #waiters = new Set<() => void>();
  #closed = false;

  constructor(source: AttemptExecutionSource) {
    this.source = Object.freeze({ ...source });
  }

  /** Reserve before a callback's first await or a background producer's dispatch. */
  reserve(label: string): () => void {
    if (this.#closed) throw new Error("Captured attempt local writer admission is closed.");
    const ticket = Symbol(label);
    this.#writers.set(ticket, label);
    return () => {
      if (!this.#writers.delete(ticket)) return;
      for (const notify of this.#waiters) notify();
    };
  }

  wrapAsync<A extends unknown[], R>(label: string, callback: (...args: A) => R | Promise<R>): (...args: A) => Promise<R> {
    return (...args) => {
      const finish = this.reserve(label);
      try { return Promise.resolve(callback(...args)).finally(finish); }
      catch (error) { finish(); throw error; }
    };
  }

  wrapSync<A extends unknown[], R>(label: string, callback: (...args: A) => R): (...args: A) => R {
    return (...args) => {
      const finish = this.reserve(label);
      try { return callback(...args); } finally { finish(); }
    };
  }

  /** Close after SDK execution ends. In-flight writers retain their own completion closures. */
  close(): void {
    this.#closed = true;
    for (const notify of this.#waiters) notify();
  }

  getSnapshot(): { readonly closed: boolean; readonly writers: readonly string[] } {
    return Object.freeze({ closed: this.#closed, writers: Object.freeze([...this.#writers.values()]) });
  }

  /** A deadline rejects the observation without changing membership, authority, or leases. */
  async waitForIdle(timeoutMs?: number): Promise<void> {
    if (!this.#closed) throw new Error("Captured attempt local writer admission must close before drain.");
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647)) {
      throw new RangeError("Local writer observation deadline must be finite and non-negative.");
    }
    if (this.#writers.size === 0) return;
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const notify = () => {
        if (this.#writers.size !== 0) return;
        this.#waiters.delete(notify);
        if (timer !== undefined) clearTimeout(timer);
        resolve();
      };
      this.#waiters.add(notify);
      if (timeoutMs !== undefined) timer = setTimeout(() => {
        this.#waiters.delete(notify);
        reject(new Error("Captured attempt local writers have not drained."));
      }, timeoutMs);
    });
  }
}
