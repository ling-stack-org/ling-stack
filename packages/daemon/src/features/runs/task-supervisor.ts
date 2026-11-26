import { createSqliteGoalSupervisionStore, createSqliteNodeRerunStore, type RunSession, type RunStore } from "@ling-stack/core";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { assertNodeRerunReuseCurrent } from "./node-rerun-submission.js";

/** Restarts recover durable work through existing workflow and intervention owners. */
export class TaskSupervisor {
  private readonly workspaces = new Map<string, { timer: ReturnType<typeof setInterval>; stopped: boolean; pending?: Promise<void> }>();
  private readonly pending = new Set<Promise<void>>();
  private readonly activeSources = new Set<string>();
  private closed = false;
  constructor(private readonly stores: RunStoreRegistry, private readonly advanceWorkflow: (store: RunStore, workflowId: string) => Promise<unknown>,
    private readonly advanceGoal: (store: RunStore, run: RunSession) => Promise<void>,
    private readonly advanceRunInterventions?: (store: RunStore, sourceRunId: string) => Promise<void>) {}
  start(cwd: string): void {
    if (this.closed || this.workspaces.has(cwd)) return;
    const timer = setInterval(() => this.poke(cwd), 2000); timer.unref();
    this.workspaces.set(cwd, { timer, stopped: false }); this.poke(cwd);
  }
  poke(cwd: string): void {
    this.startIfMissing(cwd);
    const state = this.workspaces.get(cwd);
    if (!state || state.stopped || state.pending) return;
    state.pending = this.tick(cwd, state).catch(() => undefined).finally(() => { this.pending.delete(state.pending!); state.pending = undefined; });
    this.pending.add(state.pending);
  }
  private startIfMissing(cwd: string): void { if (!this.workspaces.has(cwd)) this.start(cwd); }
  stopAll(): void { this.closed = true; for (const state of this.workspaces.values()) { state.stopped = true; clearInterval(state.timer); } }
  async waitForIdle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
  private async tick(cwd: string, state: { stopped: boolean }): Promise<void> {
    const store = this.stores.getInitializedStore(cwd);
    if (!store) return;
    for (const submission of createSqliteNodeRerunStore(store).listPending()) {
      if (state.stopped) return;
      try { assertNodeRerunReuseCurrent(store, submission); }
      catch {
        const workflow = store.getChannelWorkflow(submission.successorWorkflowId);
        if (workflow && ["ready", "running"].includes(workflow.status)) store.updateChannelWorkflow(workflow.id, { status: "blocked" }, new Date().toISOString());
        continue;
      }
      try { await this.advanceWorkflow(store, submission.successorWorkflowId); } catch { /* Normal workflow admission retains its durable blockers. */ }
    }
    for (const workflowId of store.listActiveWorkItemWorkflowIds(8)) {
      if (state.stopped) return;
      this.advanceSource(cwd, workflowId, async () => { await this.advanceWorkflow(store, workflowId); });
    }
    const advanceInterventions = this.advanceRunInterventions;
    if (advanceInterventions) {
      for (const sourceRunId of store.listPendingConversationInterventionSources()) {
        if (state.stopped) return;
        this.advanceSource(cwd, sourceRunId, () => advanceInterventions(store, sourceRunId));
      }
    }
    for (const run of createSqliteGoalSupervisionStore(store).listEligibleSources()) {
      if (state.stopped) return;
      if (run.threadId && createSqliteGoalSupervisionStore(store).reconcileAcceptance(run.threadId, new Date().toISOString())) continue;
      this.advanceSource(cwd, run.id, () => this.advanceGoal(store, run));
    }
  }

  private advanceSource(cwd: string, sourceRunId: string, advance: () => Promise<void>): void {
    const key = JSON.stringify([cwd, sourceRunId]);
    if (this.activeSources.has(key) || this.activeSources.size >= 8) return;
    this.activeSources.add(key);
    const pending = Promise.resolve().then(advance).catch(() => undefined).finally(() => {
      this.activeSources.delete(key);
      this.pending.delete(pending);
    });
    this.pending.add(pending);
  }
}
