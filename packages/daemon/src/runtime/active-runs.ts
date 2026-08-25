import type { RunEventEnvelope } from "@ling-stack/core";

export type ActiveRunStopIntentV1 =
  | { readonly kind: "user_cancel"; readonly actor: "local-user"; readonly reason: string }
  | { readonly kind: "workflow_cancel"; readonly workflowId: string; readonly reason: string }
  | {
      readonly kind: "runtime_suspend";
      readonly cause: "daemon_restart" | "desktop_quit" | "process_signal";
      readonly runtimeInstanceId: string;
    }
  | {
      readonly kind: "runtime_failure";
      readonly code: "idle_timeout" | "hard_timeout" | "runner_crash";
      readonly reason: string;
    };

export interface ActiveRun {
  readonly abortController: AbortController;
  readonly streamEnvelope: (envelope: RunEventEnvelope) => void;
  readonly completion?: Promise<unknown>;
  readonly runtimeInstanceId?: string;
  readonly workUnitId?: string;
  readonly attemptId?: string;
  readonly stopIntent?: ActiveRunStopIntentV1;
}

interface RegisteredActiveRun extends ActiveRun {
  stopIntent?: ActiveRunStopIntentV1;
}

export class ActiveRunRegistry {
  private readonly activeRuns = new Map<string, RegisteredActiveRun>();
  private readonly completions = new Set<Promise<unknown>>();

  add(runId: string, run: ActiveRun): void {
    this.activeRuns.set(runId, { ...run });
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

  requestStop(runId: string, intent: ActiveRunStopIntentV1): boolean {
    const run = this.activeRuns.get(runId);
    if (!run) {
      return false;
    }
    if (!run.stopIntent) {
      run.stopIntent = intent;
    }
    if (!run.abortController.signal.aborted) {
      run.abortController.abort(run.stopIntent);
    }
    return true;
  }

  getStopIntent(runId: string): ActiveRunStopIntentV1 | undefined {
    return this.activeRuns.get(runId)?.stopIntent;
  }

  suspendAll(cause: Extract<ActiveRunStopIntentV1, { kind: "runtime_suspend" }>["cause"]): void {
    for (const [runId, run] of this.activeRuns) {
      this.requestStop(runId, {
        kind: "runtime_suspend",
        cause,
        runtimeInstanceId: run.runtimeInstanceId ?? "unknown-runtime",
      });
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
