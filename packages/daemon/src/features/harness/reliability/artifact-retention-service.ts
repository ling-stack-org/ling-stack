import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { HarnessArtifactRetentionStore } from "@ling-stack/core";

/** Only consumes Host-explicit enrollments; never infers that old user artifacts are disposable. */
export class HarnessArtifactRetentionService {
  private readonly inFlight = new Map<HarnessArtifactRetentionStore, Promise<void>>();
  private readonly cursors = new WeakMap<HarnessArtifactRetentionStore, string>();
  private readonly controllers = new Set<AbortController>();
  private stopped = false;

  constructor(private readonly options: {
    readonly pageSize?: number;
    readonly maxPagesPerSweep?: number;
    readonly clock?: () => string;
  } = {}) {
    if (options.pageSize !== undefined && (!Number.isSafeInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > 500)) {
      throw new TypeError("artifact_retention_service_page_size_invalid");
    }
    if (options.maxPagesPerSweep !== undefined && (!Number.isSafeInteger(options.maxPagesPerSweep) || options.maxPagesPerSweep < 1)) {
      throw new TypeError("artifact_retention_service_page_budget_invalid");
    }
  }

  collectStore(store: HarnessArtifactRetentionStore): Promise<void> {
    if (this.stopped) return Promise.reject(new Error("artifact_retention_service_stopped"));
    const previous = this.inFlight.get(store);
    if (previous) return previous;
    const controller = new AbortController();
    this.controllers.add(controller);
    const work = Promise.resolve().then(() => this.collect(store, controller.signal)).finally(() => {
      this.inFlight.delete(store);
      this.controllers.delete(controller);
    });
    this.inFlight.set(store, work);
    return work;
  }

  beginShutdown(): void { this.stopped = true; }
  abortOwned(): void { for (const controller of this.controllers) controller.abort(new Error("artifact_retention_service_shutdown")); }
  async waitForIdle(): Promise<void> { while (this.inFlight.size) await Promise.allSettled([...this.inFlight.values()]); }

  private async collect(store: HarnessArtifactRetentionStore, signal: AbortSignal): Promise<void> {
    for (let page = 0; page < (this.options.maxPagesPerSweep ?? 16); page += 1) {
      signal.throwIfAborted();
      const after = this.cursors.get(store);
      const result = store.collectHarnessArtifactBodies({
        now: this.options.clock?.() ?? new Date().toISOString(), ...(after === undefined ? {} : { after }),
        ...(this.options.pageSize === undefined ? {} : { limit: this.options.pageSize }),
      });
      if (!result.nextCursor) { this.cursors.delete(store); return; }
      if (result.examined < 1 || result.nextCursor === after) throw new Error("artifact_retention_service_cursor_invalid");
      this.cursors.set(store, result.nextCursor);
      await yieldToEventLoop(undefined, { signal });
    }
    // A sweep budget is not success for the whole population. The next tick resumes this cursor.
  }
}
