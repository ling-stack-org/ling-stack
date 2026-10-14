import { randomUUID } from "node:crypto";
import "../../runtime/sandbox/core-original-process-bridge.js";
import {
  isCoreOriginalLaunchRefusal,
  parseExternalWorkflowMarkdown,
  pollGitHubExternalWork,
  reconcileExternalWork,
  type Channel,
  type ExternalWorkBackgroundScheduler,
  type ExternalWorkGitHubBackgroundStartRequest,
  type ExternalWorkReconcileResponse,
  type ExternalWorkflowDefinition,
  type RunStore,
  type SecretResolver,
} from "@ling-stack/core";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import {
  readExternalWorkflowFile,
  resolveExternalGitHubToken,
} from "./workflow.js";

interface ExternalWorkBackgroundSchedulerEntry {
  scheduler: ExternalWorkBackgroundScheduler;
  key: string;
  timer?: ReturnType<typeof setTimeout>;
  running: boolean;
}

export class ExternalWorkBackgroundSchedulerRegistry {
  private readonly entriesById = new Map<string, ExternalWorkBackgroundSchedulerEntry>();
  private readonly idsByKey = new Map<string, string>();

  constructor(
    private readonly storeRegistry: RunStoreRegistry,
    private readonly secretResolver: SecretResolver,
    private readonly externalWorkFetch?: typeof globalThis.fetch,
  ) {}

  async start(cwd: string, input: ExternalWorkGitHubBackgroundStartRequest): Promise<{
    readonly scheduler: ExternalWorkBackgroundScheduler;
    readonly duplicate: boolean;
    readonly startupReconcile?: ExternalWorkReconcileResponse;
  }> {
    const prepared = this.prepare(cwd, input);
    const key = this.key(cwd, input.channelId, prepared.workflowFile.path);
    const existingId = this.idsByKey.get(key);
    if (existingId) {
      const existing = this.entriesById.get(existingId);
      if (existing && this.isCurrentRunningEntry(existing)) {
        return { scheduler: existing.scheduler, duplicate: true };
      }
    }

    const now = new Date().toISOString();
    const scheduler: ExternalWorkBackgroundScheduler = {
      id: `external_work_background_${randomUUID()}`,
      cwd,
      sourceKind: "github",
      channelId: input.channelId,
      ...(input.workflowPath ? { workflowPath: input.workflowPath } : {}),
      repository: prepared.workflowDefinition.config.source.repository,
      pollIntervalMs: prepared.workflowDefinition.config.scheduler.pollIntervalMs,
      ...(input.limit ? { limit: input.limit } : {}),
      executeHooks: input.executeHooks === true,
      status: "running",
      startedAt: now,
      tickCount: 0,
    };
    const entry: ExternalWorkBackgroundSchedulerEntry = { scheduler, key, running: false };
    this.entriesById.set(scheduler.id, entry);
    this.idsByKey.set(key, scheduler.id);

    let startupReconcile: ExternalWorkReconcileResponse | undefined;
    if (prepared.workflowDefinition.config.scheduler.reconcileOnStartup) {
      try {
        startupReconcile = await reconcileExternalWork({
          store: prepared.store,
          channelId: input.channelId,
          workflowDefinition: prepared.workflowDefinition,
          githubToken: prepared.githubToken,
          fetch: this.externalWorkFetch,
        });
      } catch (error) {
        this.failEntry(entry, error, "background_startup_reconcile_failed");
        throw error;
      }
      entry.scheduler = {
        ...entry.scheduler,
        lastReconcileAt: new Date().toISOString(),
        lastReconcile: startupReconcile,
      };
    }

    if (this.isCurrentRunningEntry(entry) && input.runImmediately !== false) {
      await this.runTick(entry);
    }
    this.schedule(entry);
    return { scheduler: entry.scheduler, duplicate: false, ...(startupReconcile ? { startupReconcile } : {}) };
  }

  list(cwd: string): ExternalWorkBackgroundScheduler[] {
    return Array.from(this.entriesById.values())
      .filter((entry) => entry.scheduler.cwd === cwd)
      .map((entry) => entry.scheduler);
  }

  stop(cwd: string, schedulerId: string): ExternalWorkBackgroundScheduler | undefined {
    const entry = this.entriesById.get(schedulerId);
    if (!entry || entry.scheduler.cwd !== cwd) {
      return undefined;
    }
    this.stopEntry(entry);
    return entry.scheduler;
  }

  stopAll(): void {
    for (const entry of this.entriesById.values()) {
      this.stopEntry(entry);
    }
  }

  private isCurrentRunningEntry(entry: ExternalWorkBackgroundSchedulerEntry): boolean {
    return this.entriesById.get(entry.scheduler.id) === entry
      && this.idsByKey.get(entry.key) === entry.scheduler.id
      && entry.scheduler.status === "running";
  }

  private clearTimer(entry: ExternalWorkBackgroundSchedulerEntry): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
  }

  private releaseKey(entry: ExternalWorkBackgroundSchedulerEntry): void {
    if (this.idsByKey.get(entry.key) === entry.scheduler.id) {
      this.idsByKey.delete(entry.key);
    }
  }

  private stopEntry(entry: ExternalWorkBackgroundSchedulerEntry): void {
    this.clearTimer(entry);
    entry.scheduler = {
      ...entry.scheduler,
      status: "stopped",
      stoppedAt: entry.scheduler.stoppedAt ?? new Date().toISOString(),
      nextPollAt: undefined,
    };
    this.releaseKey(entry);
  }

  private failEntry(entry: ExternalWorkBackgroundSchedulerEntry, error: unknown, code: string): void {
    const current = this.isCurrentRunningEntry(entry);
    // A late failure remains observable without changing a stopped generation
    // or releasing the key/timer owned by its successor.
    entry.scheduler = {
      ...entry.scheduler,
      ...(current ? { status: "failed", nextPollAt: undefined } as const : {}),
      lastErrorCode: code,
      lastErrorMessage: error instanceof Error ? error.message : String(error),
    };
    if (current) {
      this.clearTimer(entry);
      this.releaseKey(entry);
    }
  }

  private schedule(entry: ExternalWorkBackgroundSchedulerEntry): void {
    if (!this.isCurrentRunningEntry(entry) || entry.running || entry.timer) {
      return;
    }
    const nextPollAt = new Date(Date.now() + entry.scheduler.pollIntervalMs).toISOString();
    entry.scheduler = { ...entry.scheduler, nextPollAt };
    const timer = setTimeout(() => {
      if (entry.timer !== timer || !this.isCurrentRunningEntry(entry)) return;
      entry.timer = undefined;
      entry.scheduler = { ...entry.scheduler, nextPollAt: undefined };
      void this.runTick(entry).then(() => this.schedule(entry)).catch(error => {
        // Consume unexpected timer failures as well; a failed tick cannot keep
        // scheduling behind an unhandled rejection or pretend to be running.
        this.failEntry(entry, error, "background_tick_failed");
      });
    }, entry.scheduler.pollIntervalMs);
    entry.timer = timer;
    timer.unref?.();
  }

  private async runTick(entry: ExternalWorkBackgroundSchedulerEntry): Promise<void> {
    if (entry.running || !this.isCurrentRunningEntry(entry)) {
      return;
    }
    entry.running = true;
    const now = new Date().toISOString();
    try {
      const prepared = this.prepare(entry.scheduler.cwd, {
        channelId: entry.scheduler.channelId,
        workflowPath: entry.scheduler.workflowPath,
        limit: entry.scheduler.limit,
        executeHooks: entry.scheduler.executeHooks,
      });
      const poll = await pollGitHubExternalWork({
        store: prepared.store,
        cwd: entry.scheduler.cwd,
        channelId: entry.scheduler.channelId,
        workflowDefinition: prepared.workflowDefinition,
        workflowDirectory: prepared.workflowFile.directory,
        githubToken: prepared.githubToken,
        fetch: this.externalWorkFetch,
        limit: entry.scheduler.limit,
        executeHooks: entry.scheduler.executeHooks,
        now,
      });
      entry.scheduler = {
        ...entry.scheduler,
        repository: prepared.workflowDefinition.config.source.repository,
        pollIntervalMs: prepared.workflowDefinition.config.scheduler.pollIntervalMs,
        lastPoll: poll,
      };
      // Stopping does not revoke a poll already admitted to Core, but it does
      // prevent that poll from admitting the next remote stage or another tick.
      if (!this.isCurrentRunningEntry(entry)) return;
      const reconcile = await reconcileExternalWork({
        store: prepared.store,
        channelId: entry.scheduler.channelId,
        workflowDefinition: prepared.workflowDefinition,
        githubToken: prepared.githubToken,
        fetch: this.externalWorkFetch,
        now: new Date().toISOString(),
      });
      entry.scheduler = {
        ...entry.scheduler,
        lastReconcileAt: new Date().toISOString(),
        lastErrorCode: undefined,
        lastErrorMessage: undefined,
        lastReconcile: reconcile,
      };
    } catch (error) {
      const launchRefused = isCoreOriginalLaunchRefusal(error);
      const code = launchRefused && error instanceof Error ? error.message : "background_tick_failed";
      if (launchRefused) this.failEntry(entry, error, code);
      else entry.scheduler = {
        ...entry.scheduler, lastErrorCode: code,
        lastErrorMessage: error instanceof Error ? error.message : String(error),
      };
    } finally {
      entry.scheduler = { ...entry.scheduler, tickCount: entry.scheduler.tickCount + 1, lastPollAt: now };
      entry.running = false;
    }
  }

  private prepare(cwd: string, input: Pick<ExternalWorkGitHubBackgroundStartRequest, "channelId" | "workflowPath" | "limit" | "executeHooks">): {
    readonly store: RunStore;
    readonly channel: Channel;
    readonly workflowFile: ReturnType<typeof readExternalWorkflowFile>;
    readonly workflowDefinition: ExternalWorkflowDefinition;
    readonly githubToken: string | undefined;
  } {
    const store = this.storeRegistry.getStore(cwd);
    const channel = store.getChannel(input.channelId);
    if (!channel) {
      throw new Error(`Channel not found: ${input.channelId}`);
    }
    const workflowFile = readExternalWorkflowFile({ workflowPath: input.workflowPath }, channel, cwd);
    const workflowDefinition = parseExternalWorkflowMarkdown(workflowFile.markdown);
    if (workflowDefinition.config.source.kind !== "github") {
      throw new Error(`Unsupported external source kind: ${workflowDefinition.config.source.kind}`);
    }
    return {
      store,
      channel,
      workflowFile,
      workflowDefinition,
      githubToken: resolveExternalGitHubToken(workflowDefinition, this.secretResolver),
    };
  }

  private key(cwd: string, channelId: string, workflowPath: string | undefined): string {
    return [cwd, channelId, workflowPath ?? "WORKFLOW.md"].join("\0");
  }
}
