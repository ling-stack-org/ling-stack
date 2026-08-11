import type { RunEventEnvelope } from "@ling-stack/core";

export interface ActiveRun {
  readonly abortController: AbortController;
  readonly streamEnvelope: (envelope: RunEventEnvelope) => void;
  readonly completion?: Promise<unknown>;
}

export class ActiveRunRegistry {
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly completions = new Set<Promise<unknown>>();

  add(runId: string, run: ActiveRun): void {
    this.activeRuns.set(runId, run);
    if (run.completion) {
      this.trackCompletion(run.completion);
    }
  }

  trackCompletion(completion: Promise<unknown>): void {
    this.completions.add(completion);
    completion.then(() => {
      this.completions.delete(completion);
    }, () => {
      this.completions.delete(completion);
    });
  }

  get(runId: string): ActiveRun | undefined {
    return this.activeRuns.get(runId);
  }

  delete(runId: string): void {
    this.activeRuns.delete(runId);
  }

  cancelAll(): void {
    for (const run of this.activeRuns.values()) {
      run.abortController.abort();
    }
  }

  async waitForIdle(timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.completions.size > 0) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        return;
      }
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.allSettled([...this.completions]).then(() => undefined),
          new Promise<void>((resolve) => {
            timeout = setTimeout(resolve, remainingMs);
            timeout.unref?.();
          }),
        ]);
      } finally {
        if (timeout) {
          clearTimeout(timeout);
        }
      }
    }
  }
}
