import { resolveRunAncestry, type RunStore } from "@ling-stack/core";
import type { AttemptExecutionSource } from "./attempt-execution-quiescence.js";
import type { ActiveRunRegistry } from "./active-runs.js";

declare const sourceBrand: unique symbol;
export interface RunSuspensionOrderSource { readonly [sourceBrand]: true }
type Phase = "ready" | "finished";
interface Latch { readonly promise: Promise<void>; readonly resolve: () => void; readonly reject: (error: unknown) => void }
interface CapturedSource {
  readonly store: RunStore;
  readonly source: AttemptExecutionSource;
  readonly ancestors: readonly string[];
  readonly ready: Latch;
  readonly finished: Latch;
  state: "live" | "ready" | "finished" | "blocked";
  failure?: unknown;
}
interface StoreSources { readonly runs: Map<string, CapturedSource>; revision: number }

/**
 * Process-local ordering only. These latches never authorize stop, recovery,
 * resource release or budget settlement. Core must independently verify all
 * persisted descendants and receipts, including sources absent from this map.
 */
export class RunSuspensionOrder {
  private readonly stores = new WeakMap<RunStore, StoreSources>();
  private readonly handles = new WeakMap<RunSuspensionOrderSource, CapturedSource>();
  private readonly sources = new Set<CapturedSource>();
  private revision = 0;

  capture(store: RunStore, source: AttemptExecutionSource): RunSuspensionOrderSource {
    const ancestry = resolveRunAncestry({ getRun: id => store.getRun(id) }, { leafRunId: source.runId });
    let state = this.stores.get(store);
    if (!state) { state = { runs: new Map(), revision: 0 }; this.stores.set(store, state); }
    // A second handle must not reset pending/failed original execution latches.
    if (state.runs.has(source.runId)) throw new Error("runtime_suspension_source_already_captured");
    const captured: CapturedSource = { store, source: Object.freeze({ ...source }),
      ancestors: Object.freeze(ancestry.entries.slice(0, -1).map(run => run.id)),
      ready: latch(), finished: latch(), state: "live" };
    const handle = Object.freeze(Object.create(null) as RunSuspensionOrderSource);
    this.handles.set(handle, captured);
    state.runs.set(source.runId, captured); state.revision += 1;
    this.sources.add(captured); this.revision += 1;
    return handle;
  }

  /** Caller has completed the exact Core begin-stop transaction, not physical drain. */
  ready(handle: RunSuspensionOrderSource): void {
    const captured = this.current(handle);
    if (captured.state === "blocked") throw new Error("runtime_suspension_source_blocked");
    captured.state = "ready"; captured.ready.resolve();
  }

  /** Caller has finished original finalization, including its durable Core receipt. */
  finish(handle: RunSuspensionOrderSource): void {
    const captured = this.current(handle);
    if (captured.state === "blocked") throw new Error("runtime_suspension_source_blocked");
    captured.state = "finished";
    captured.ready.resolve(); captured.finished.resolve();
    const state = this.stores.get(captured.store)!;
    state.runs.delete(captured.source.runId); state.revision += 1;
    this.sources.delete(captured); this.revision += 1;
  }

  /** Unknown outcomes remain in the tree and fail both ordering barriers. */
  block(handle: RunSuspensionOrderSource, error: unknown): void {
    const captured = this.current(handle);
    if (captured.state === "blocked") return;
    captured.state = "blocked";
    captured.failure = error;
    captured.ready.reject(error); captured.finished.reject(error);
  }

  async waitForDescendants(handle: RunSuspensionOrderSource, phase: Phase): Promise<void> {
    const captured = this.current(handle), state = this.stores.get(captured.store)!;
    for (;;) {
      this.current(handle);
      const revision = state.revision;
      const descendants = [...state.runs.values()].filter(candidate => candidate !== captured
        && candidate.ancestors.includes(captured.source.runId));
      // Never include this source's own lifetime: its Runner is awaiting this callback.
      await Promise.all(descendants.map(candidate => candidate[phase].promise));
      // A fulfilled readiness latch cannot be revoked. Recheck actual state
      // when a later drain failure has blocked that same original source.
      for (const candidate of descendants) if (candidate.state === "blocked") throw candidate.failure;
      if (state.revision === revision) return;
    }
  }

  /** Call again after preflight/executor drain to include late registrations. */
  async waitForAllFinished(): Promise<void> {
    for (;;) {
      const revision = this.revision;
      await Promise.all([...this.sources].map(source => source.finished.promise));
      if (revision === this.revision) return;
    }
  }

  private current(handle: RunSuspensionOrderSource): CapturedSource {
    const captured = this.handles.get(handle);
    if (!captured || this.stores.get(captured.store)?.runs.get(captured.source.runId) !== captured) {
      throw new Error("runtime_suspension_source_stale");
    }
    return captured;
  }
}

const orders = new WeakMap<ActiveRunRegistry, RunSuspensionOrder>();
export function runSuspensionOrderFor(owner: ActiveRunRegistry): RunSuspensionOrder {
  let order = orders.get(owner);
  if (!order) { order = new RunSuspensionOrder(); orders.set(owner, order); }
  return order;
}

function latch(): Latch {
  let resolve!: () => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  // A descendant can fail before its parent reaches the ordering barrier.
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}
