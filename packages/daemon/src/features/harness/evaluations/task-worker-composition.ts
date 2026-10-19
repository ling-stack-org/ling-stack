import type {
  RunEvaluationTaskRecoveryCursor,
  RunStore,
} from "@ling-stack/core";
import type { RunEvaluationTaskHostAdapter } from "./task-worker-prepared.js";
import {
  RunEvaluationTaskWorkerRegistry,
  type RunEvaluationTaskWorkerRegistryOptions,
} from "./task-worker.js";

export interface RunEvaluationQaTaskWorkerActivation {
  /** Trusted Host factory. Renderer, HTTP, persisted rows and model output never receive this seam. */
  readonly createHostAdapter: (input: {
    readonly cwd: string;
    readonly store: RunStore;
  }) => RunEvaluationTaskHostAdapter | undefined;
  readonly concurrency?: number;
  readonly scanIntervalMs?: number;
  readonly leaseMs?: number;
  readonly executionTimeoutMs?: number;
  readonly workerId?: string;
  readonly onError?: (error: unknown) => void;
}

export interface RunEvaluationTaskStartupRecoveryResult {
  readonly examined: number;
  readonly changed: number;
  readonly pages: number;
  readonly qaScope: "absent" | "available" | "held" | "quarantined";
}

/** Credential-free recovery must finish before any optional Provider adapter can inspect the queue. */
export function reconcileRunEvaluationTasksAtStartup(input: {
  readonly store: Pick<RunStore,
    "reconcileExpiredRunEvaluationTaskAttemptsPage" | "getRunEvaluationQaScope" | "reconcileRunEvaluationQaScope">;
  readonly now: string;
  readonly limit?: number;
  readonly signal?: AbortSignal;
}): RunEvaluationTaskStartupRecoveryResult {
  let cursor: RunEvaluationTaskRecoveryCursor | undefined;
  let examined = 0;
  let changed = 0;
  let pages = 0;
  const seenCursors = new Set<string>();
  do {
    input.signal?.throwIfAborted();
    const page = input.store.reconcileExpiredRunEvaluationTaskAttemptsPage({
      now: input.now,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(cursor === undefined ? {} : { cursor }),
    });
    examined += page.examinedCount;
    changed += page.changed.length;
    pages += 1;
    cursor = page.nextCursor;
    if (cursor) {
      const key = `${cursor.claimExpiresAt}\0${cursor.attemptId}`;
      if (page.examinedCount < 1 || seenCursors.has(key)) {
        throw new Error("evaluation_task_startup_recovery_cursor_invalid");
      }
      seenCursors.add(key);
    }
  } while (cursor);

  input.signal?.throwIfAborted();
  if (!input.store.getRunEvaluationQaScope()) {
    return { examined, changed, pages, qaScope: "absent" };
  }
  const qa = input.store.reconcileRunEvaluationQaScope({ now: input.now });
  if (!qa.ok) throw new Error("evaluation_qa_startup_recovery_failed");
  return { examined, changed, pages, qaScope: qa.value.laneState };
}

export interface RunEvaluationTaskWorkerCompositionOptions {
  readonly activation?: RunEvaluationQaTaskWorkerActivation;
  readonly clock?: () => string;
  readonly recoveryPageSize?: number;
}

/**
 * Per-Store Host composition. Durable recovery is always active; Provider execution exists only
 * when the embedding Host supplies an in-memory activation factory for this daemon instance.
 */
export class RunEvaluationTaskWorkerComposition {
  private readonly activation?: RunEvaluationQaTaskWorkerActivation;
  private readonly clock?: () => string;
  private readonly recoveryPageSize?: number;
  private readonly registered = new WeakSet<RunStore>();
  private readonly workers = new Map<RunStore, RunEvaluationTaskWorkerRegistry>();
  private stopped = false;

  constructor(options: RunEvaluationTaskWorkerCompositionOptions = {}) {
    this.activation = options.activation;
    this.clock = options.clock;
    this.recoveryPageSize = options.recoveryPageSize;
  }

  registerStore(cwd: string, store: RunStore): RunEvaluationTaskStartupRecoveryResult | undefined {
    if (this.stopped || this.registered.has(store)) return undefined;
    const now = this.clock?.() ?? new Date().toISOString();
    const recovered = reconcileRunEvaluationTasksAtStartup({
      store,
      now,
      ...(this.recoveryPageSize === undefined ? {} : { limit: this.recoveryPageSize }),
    });
    const activation = this.activation;
    if (activation) {
      const adapter = activation.createHostAdapter(Object.freeze({ cwd, store }));
      if (adapter) {
        const options: RunEvaluationTaskWorkerRegistryOptions = {
          enabled: true,
          hostAdapter: adapter,
          ...(activation.concurrency === undefined ? {} : { concurrency: activation.concurrency }),
          ...(activation.scanIntervalMs === undefined ? {} : { scanIntervalMs: activation.scanIntervalMs }),
          ...(activation.leaseMs === undefined ? {} : { leaseMs: activation.leaseMs }),
          ...(activation.executionTimeoutMs === undefined ? {} : { executionTimeoutMs: activation.executionTimeoutMs }),
          ...(activation.workerId === undefined ? {} : { workerId: activation.workerId }),
          ...(activation.onError === undefined ? {} : { onError: activation.onError }),
          ...(this.clock === undefined ? {} : { clock: this.clock }),
        };
        const worker = new RunEvaluationTaskWorkerRegistry(options);
        this.workers.set(store, worker);
        worker.registerStore(cwd, store);
      }
    }
    this.registered.add(store);
    return recovered;
  }

  beginShutdown(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const worker of this.workers.values()) worker.beginShutdown();
  }

  async waitForIdle(): Promise<void> {
    await Promise.all([...this.workers.values()].map(worker => worker.waitForIdle()));
  }
}
