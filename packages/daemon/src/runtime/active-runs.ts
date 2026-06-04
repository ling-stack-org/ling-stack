import type { RunEventEnvelope } from "@ling-stack/core";

export interface ActiveRun {
  readonly abortController: AbortController;
  readonly streamEnvelope: (envelope: RunEventEnvelope) => void;
}

export class ActiveRunRegistry {
  private readonly activeRuns = new Map<string, ActiveRun>();

  add(runId: string, run: ActiveRun): void {
    this.activeRuns.set(runId, run);
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
    this.activeRuns.clear();
  }
}
