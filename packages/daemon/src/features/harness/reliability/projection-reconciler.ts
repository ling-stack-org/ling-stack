import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import {
  HARNESS_PROJECTION_DOMAINS,
  type HarnessProjectionCheckpoint,
  type HarnessProjectionDomain,
  type HarnessProjectionStore,
} from "@ling-stack/core";

/** Single-flight per Store. Pages are durable; abort or restart never publishes a partial generation. */
export class HarnessProjectionReconciler {
  private readonly running = new Map<HarnessProjectionStore, Promise<readonly HarnessProjectionCheckpoint[]>>();
  private readonly controllers = new Set<AbortController>();
  private stopped = false;

  constructor(private readonly options: {
    readonly pageSize?: number;
    readonly maxPagesPerDomain?: number;
    readonly clock?: () => string;
  } = {}) {
    if (options.pageSize !== undefined && (!Number.isSafeInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > 500)) {
      throw new TypeError("projection_reconciler_page_size_invalid");
    }
    if (options.maxPagesPerDomain !== undefined && (!Number.isSafeInteger(options.maxPagesPerDomain) || options.maxPagesPerDomain < 1)) {
      throw new TypeError("projection_reconciler_page_budget_invalid");
    }
  }

  reconcileStore(store: HarnessProjectionStore): Promise<readonly HarnessProjectionCheckpoint[]> {
    if (this.stopped) return Promise.reject(new Error("projection_reconciler_stopped"));
    const existing = this.running.get(store);
    if (existing) return existing;
    const controller = new AbortController();
    this.controllers.add(controller);
    const work = Promise.resolve().then(() => this.rebuild(store, controller.signal)).finally(() => {
      this.running.delete(store);
      this.controllers.delete(controller);
    });
    this.running.set(store, work);
    return work;
  }

  beginShutdown(): void { this.stopped = true; }

  abortOwned(): void {
    for (const controller of this.controllers) controller.abort(new Error("projection_reconciler_shutdown"));
  }

  async waitForIdle(): Promise<void> { await Promise.allSettled([...this.running.values()]); }

  private async rebuild(store: HarnessProjectionStore, signal: AbortSignal): Promise<readonly HarnessProjectionCheckpoint[]> {
    const completed: HarnessProjectionCheckpoint[] = [];
    const failures: Error[] = [];
    for (const domain of HARNESS_PROJECTION_DOMAINS) {
      signal.throwIfAborted();
      try {
        completed.push(await this.rebuildDomain(store, domain, signal));
      } catch (error) {
        if (signal.aborted) throw error;
        failures.push(error instanceof Error ? error : new Error("projection_reconciler_domain_failed", { cause: error }));
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, "projection_reconciler_domain_failures");
    return completed;
  }

  private async rebuildDomain(store: HarnessProjectionStore, domain: HarnessProjectionDomain, signal: AbortSignal): Promise<HarnessProjectionCheckpoint> {
    const budget = this.options.maxPagesPerDomain ?? 10_000;
    for (let pages = 0; pages < budget; pages += 1) {
      signal.throwIfAborted();
      const checkpoint = store.reconcileHarnessProjectionPage({
        domain, now: this.options.clock?.() ?? new Date().toISOString(),
        ...(this.options.pageSize === undefined ? {} : { limit: this.options.pageSize }),
      });
      if (checkpoint.state === "ready" && checkpoint.sourceEpoch === checkpoint.builtEpoch) return checkpoint;
      // Recovery is cooperative, not a single unbounded synchronous startup scan.
      await yieldToEventLoop(undefined, { signal });
    }
    throw new Error(`projection_reconciler_page_budget_exhausted:${domain}`);
  }
}
