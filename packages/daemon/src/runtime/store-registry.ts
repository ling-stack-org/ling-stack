import type { RunArtifact, RunStore } from "@ling-stack/core";

export type RunStoreFactory = (cwd: string) => RunStore;

export interface RunStoreRegistryOptions {
  readonly onStoreInitialized?: (cwd: string, store: RunStore) => void | Promise<void>;
}

export class RunStoreRegistry {
  private readonly storesByCwd = new Map<string, RunStore>();
  private readonly storesByRunId = new Map<string, RunStore>();

  constructor(
    private readonly storeFactory: RunStoreFactory,
    private readonly options: RunStoreRegistryOptions = {},
  ) {}

  getStore(cwd: string): RunStore {
    const existing = this.storesByCwd.get(cwd);
    if (existing) {
      return existing;
    }

    const store = this.storeFactory(cwd);
    const now = new Date().toISOString();
    store.recoverStaleRuns(now);
    store.recoverStaleChannelWorkflows(now);
    this.storesByCwd.set(cwd, store);
    void Promise.resolve(this.options.onStoreInitialized?.(cwd, store)).catch(() => undefined);
    return store;
  }

  rememberRun(runId: string, store: RunStore): void {
    this.storesByRunId.set(runId, store);
  }

  findStoreForRun(runId: string, cwd?: string): RunStore | undefined {
    if (cwd) {
      return this.getStore(cwd);
    }

    const knownStore = this.storesByRunId.get(runId);
    if (knownStore?.getRun(runId)) {
      return knownStore;
    }

    for (const store of this.storesByCwd.values()) {
      if (store.getRun(runId)) {
        this.rememberRun(runId, store);
        return store;
      }
    }

    return undefined;
  }

  findStoreForArtifact(artifactId: string, cwd?: string): { readonly store: RunStore; readonly artifact: RunArtifact } | undefined {
    if (cwd) {
      const store = this.getStore(cwd);
      const artifact = store.getArtifact(artifactId);
      return artifact ? { store, artifact } : undefined;
    }

    for (const store of this.storesByCwd.values()) {
      const artifact = store.getArtifact(artifactId);
      if (artifact) {
        if (artifact.runId) {
          this.rememberRun(artifact.runId, store);
        }
        return { store, artifact };
      }
    }

    return undefined;
  }

  closeAll(): void {
    for (const store of this.storesByCwd.values()) {
      store.close();
    }
    this.storesByCwd.clear();
    this.storesByRunId.clear();
  }
}
