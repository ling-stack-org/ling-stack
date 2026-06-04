import { randomUUID } from "node:crypto";
import {
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
      if (existing && existing.scheduler.status === "running") {
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
      startupReconcile = await reconcileExternalWork({
        store: prepared.store,
        channelId: input.channelId,
        workflowDefinition: prepared.workflowDefinition,
        githubToken: prepared.githubToken,
        fetch: this.externalWorkFetch,
      });
      entry.scheduler = {
        ...entry.scheduler,
        lastReconcileAt: new Date().toISOString(),
        lastReconcile: startupReconcile,
      };
    }

    if (input.runImmediately !== false) {
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
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    entry.scheduler = {
      ...entry.scheduler,
      status: "stopped",
      stoppedAt: new Date().toISOString(),
      nextPollAt: undefined,
    };
    this.idsByKey.delete(entry.key);
    return entry.scheduler;
  }

  stopAll(): void {
    for (const entry of this.entriesById.values()) {
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = undefined;
      }
      entry.scheduler = {
        ...entry.scheduler,
        status: "stopped",
        stoppedAt: new Date().toISOString(),
        nextPollAt: undefined,
      };
    }
    this.idsByKey.clear();
  }

  private schedule(entry: ExternalWorkBackgroundSchedulerEntry): void {
    if (entry.scheduler.status !== "running") {
      return;
    }
    const nextPollAt = new Date(Date.now() + entry.scheduler.pollIntervalMs).toISOString();
    entry.scheduler = { ...entry.scheduler, nextPollAt };
    entry.timer = setTimeout(() => {
      void this.runTick(entry).finally(() => this.schedule(entry));
    }, entry.scheduler.pollIntervalMs);
    entry.timer.unref?.();
  }

  private async runTick(entry: ExternalWorkBackgroundSchedulerEntry): Promise<void> {
    if (entry.running || entry.scheduler.status !== "running") {
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
        repository: prepared.workflowDefinition.config.source.repository,
        pollIntervalMs: prepared.workflowDefinition.config.scheduler.pollIntervalMs,
        status: "running",
        tickCount: entry.scheduler.tickCount + 1,
        lastPollAt: now,
        lastReconcileAt: new Date().toISOString(),
        lastErrorCode: undefined,
        lastErrorMessage: undefined,
        lastPoll: poll,
        lastReconcile: reconcile,
      };
    } catch (error) {
      entry.scheduler = {
        ...entry.scheduler,
        status: "running",
        tickCount: entry.scheduler.tickCount + 1,
        lastPollAt: now,
        lastErrorCode: "background_tick_failed",
        lastErrorMessage: error instanceof Error ? error.message : String(error),
      };
    } finally {
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
