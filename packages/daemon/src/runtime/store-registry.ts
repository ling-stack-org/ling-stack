import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve as resolvePath } from "node:path";
import type { RunArtifact, RunStore } from "@ling-stack/core";
import { MediaLocalExecutionRegistry } from "./media-local-executions.js";

export type RunStoreFactory = (cwd: string) => RunStore;

export interface RunStoreRegistryOptions {
  readonly onStoreInitialized?: (cwd: string, store: RunStore) => void | Promise<void>;
  readonly trustedWorkspaceRoots?: readonly string[];
}

export class RunStoreRegistry {
  readonly mediaLocalExecutions = new MediaLocalExecutionRegistry();
  private readonly storesByCwd = new Map<string, RunStore>();
  private readonly storesByRunId = new Map<string, RunStore>();
  private readonly trustedWorkspaceRoots = new Set<string>();
  private closed = false;

  constructor(
    private readonly storeFactory: RunStoreFactory,
    private readonly options: RunStoreRegistryOptions = {},
  ) {
    for (const root of options.trustedWorkspaceRoots ?? []) {
      this.trustWorkspaceRoot(root);
    }
  }

  getStore(cwd: string): RunStore {
    if (this.closed) throw new Error("Run Store registry is closed; no new or retained Store access is permitted.");
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

  trustWorkspaceRoot(cwd: string): void {
    this.trustedWorkspaceRoots.add(normalizeWorkspaceRoot(cwd));
  }

  isTrustedWorkspaceRoot(cwd: string): boolean {
    const candidate = normalizeWorkspaceRoot(cwd);
    for (const root of this.knownTrustedWorkspaceRoots()) {
      if (isPathInsideRoot(root, candidate)) {
        return true;
      }
    }
    return false;
  }

  findStoreForRun(runId: string, cwd?: string): RunStore | undefined {
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

    for (const root of this.trustedWorkspaceRoots) {
      const store = this.getStore(root);
      if (store.getRun(runId)) {
        this.rememberRun(runId, store);
        return store;
      }
    }

    if (cwd) {
      const store = this.getStore(cwd);
      if (store.getRun(runId)) {
        this.rememberRun(runId, store);
        return store;
      }
    }

    return undefined;
  }

  findStoreForWorkflow(workflowId: string, cwd?: string): RunStore | undefined {
    for (const store of this.storesByCwd.values()) {
      if (store.getChannelWorkflow(workflowId)) {
        return store;
      }
    }

    for (const root of this.trustedWorkspaceRoots) {
      const store = this.getStore(root);
      if (store.getChannelWorkflow(workflowId)) {
        return store;
      }
    }

    if (cwd) {
      const store = this.getStore(cwd);
      if (store.getChannelWorkflow(workflowId)) {
        return store;
      }
    }

    return undefined;
  }

  findStoreForTurn(turnId: string, cwd?: string): RunStore | undefined {
    for (const store of this.storesByCwd.values()) {
      if (store.getLingTurn(turnId)) return store;
    }
    for (const root of this.trustedWorkspaceRoots) {
      const store = this.getStore(root);
      if (store.getLingTurn(turnId)) return store;
    }
    if (cwd) {
      const store = this.getStore(cwd);
      if (store.getLingTurn(turnId)) return store;
    }
    return undefined;
  }

  findStoreForArtifact(artifactId: string, cwd?: string): { readonly store: RunStore; readonly artifact: RunArtifact } | undefined {
    // An explicit workspace is an authorization boundary, not merely a lookup
    // hint. Never let an already-open sibling store satisfy that request.
    if (cwd) {
      const requested = normalizeWorkspaceRoot(cwd);
      const candidateStores = [...this.storesByCwd.values()].filter((store) =>
        isPathInsideRoot(normalizeWorkspaceRoot(store.paths.cwd), requested));
      for (const store of candidateStores) {
        const artifact = store.getArtifact(artifactId);
        if (!artifact) continue;
        if (artifact.runId) this.rememberRun(artifact.runId, store);
        return { store, artifact };
      }
      for (const root of this.knownTrustedWorkspaceRoots()) {
        if (!isPathInsideRoot(normalizeWorkspaceRoot(root), requested)) continue;
        const store = this.getStore(root);
        const artifact = store.getArtifact(artifactId);
        if (!artifact) continue;
        if (artifact.runId) this.rememberRun(artifact.runId, store);
        return { store, artifact };
      }
      const store = this.getStore(cwd);
      const artifact = store.getArtifact(artifactId);
      if (!artifact) return undefined;
      if (artifact.runId) this.rememberRun(artifact.runId, store);
      return { store, artifact };
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

    for (const root of this.trustedWorkspaceRoots) {
      const store = this.getStore(root);
      const artifact = store.getArtifact(artifactId);
      if (artifact) {
        if (artifact.runId) {
          this.rememberRun(artifact.runId, store);
        }
        return { store, artifact };
      }
    }

    if (cwd) {
      const store = this.getStore(cwd);
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
    this.mediaLocalExecutions.beginShutdown();
    const media = this.mediaLocalExecutions.getSnapshot();
    if (media.pendingReservations !== 0 || media.executions.some(execution => execution.phase !== "completed")) {
      throw new Error("Media local executions must drain before closing Run Stores.");
    }
    this.closed = true;
    for (const store of this.storesByCwd.values()) {
      store.close();
    }
    this.storesByCwd.clear();
    this.storesByRunId.clear();
  }

  private knownTrustedWorkspaceRoots(): readonly string[] {
    const roots = new Set(this.trustedWorkspaceRoots);
    for (const store of this.storesByCwd.values()) {
      const storeRoot = normalizeWorkspaceRoot(store.paths.cwd);
      if (!this.trustedWorkspaceRoots.has(storeRoot)) {
        continue;
      }
      roots.add(storeRoot);
      for (const run of store.listRuns({ limit: 10_000 })) {
        roots.add(normalizeWorkspaceRoot(run.cwd));
      }
      for (const channel of store.listChannels({ limit: 10_000 })) {
        if (channel.boundPath) {
          roots.add(normalizeWorkspaceRoot(channel.boundPath));
        }
        if (channel.workspaceBinding?.executionPath) {
          roots.add(normalizeWorkspaceRoot(channel.workspaceBinding.executionPath));
        }
      }
    }
    return [...roots];
  }
}

function normalizeWorkspaceRoot(cwd: string): string {
  const resolved = resolvePath(cwd);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function isPathInsideRoot(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}
