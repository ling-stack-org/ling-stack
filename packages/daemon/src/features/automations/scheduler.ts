import { randomUUID } from "node:crypto";
import type {
  AutomationDefinition,
  RunSession,
  SecretResolver,
} from "@ling-stack/core";
import type { McpBroker } from "../../context.js";
import type { ActiveRunRegistry } from "../../runtime/active-runs.js";
import type { RunnerRegistry } from "../../runtime/runners.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import type { RuntimeSupervisor } from "../../runtime/supervisor.js";
import type { StartupStateRegistry } from "../../startup/state.js";
import type { ControlPlaneEventHub } from "../control-plane/events.js";
import type { ComputerUseProjectionRegistry } from "../computer-use/registry.js";
import { createDetachedRunExecutionSink, executeRunRequest } from "../runs/orchestrator.js";
import { maybeStartNextRunInterventionContinuation } from "../runs/interventions.js";
import { runAutomation } from "./run.js";
import { AutomationRecurrenceError, computeNextAutomationRunAt } from "./recurrence.js";
export { computeNextAutomationRunAt, computeNextRunAt, computeNextRunAtFromRRule } from "./recurrence.js";

// Node turns a larger delay into a 1ms timer, rather than waiting longer.
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export type AutomationSchedulerStatus = "running" | "stopped" | "error";

export interface AutomationSchedulerItem {
  readonly automationId: string;
  readonly title: string;
  readonly nextRunAt?: string;
  readonly lastRunAt?: string;
  readonly lastAutomationRunId?: string;
  readonly lastErrorMessage?: string;
}

export interface AutomationSchedulerState {
  readonly id: string;
  readonly cwd: string;
  readonly status: AutomationSchedulerStatus;
  readonly startedAt: string;
  readonly stoppedAt?: string;
  readonly automationCount: number;
  readonly tickCount: number;
  readonly nextRunAt?: string;
  readonly lastRunAt?: string;
  readonly lastErrorMessage?: string;
  readonly items: readonly AutomationSchedulerItem[];
}

interface AutomationSchedulerEntry {
  state: AutomationSchedulerState;
  generation: number;
  timers: Map<string, ReturnType<typeof setTimeout>>;
  runningAutomationIds: Set<string>;
}

export class AutomationSchedulerRegistry {
  private readonly entriesByCwd = new Map<string, AutomationSchedulerEntry>();
  private readonly inFlightTasks = new Set<Promise<void>>();

  constructor(
    private readonly runnerRegistry: RunnerRegistry,
    private readonly storeRegistry: RunStoreRegistry,
    private readonly activeRuns: ActiveRunRegistry,
    private readonly runtimeSupervisor: RuntimeSupervisor,
    private readonly secretResolver: SecretResolver,
    private readonly mcpBroker: McpBroker,
    private readonly computerUsePreviews: ComputerUseProjectionRegistry,
    private readonly controlPlaneEvents: ControlPlaneEventHub,
    private readonly startupState?: StartupStateRegistry,
  ) {}

  start(cwd: string): { readonly scheduler: AutomationSchedulerState; readonly duplicate: boolean } {
    this.startupState?.setPhase(cwd, "automation_scheduler", "warming");
    const existing = this.entriesByCwd.get(cwd);
    if (existing?.state.status === "running") {
      this.startupState?.setPhase(cwd, "automation_scheduler", "ready");
      return { scheduler: existing.state, duplicate: true };
    }
    try {
      if (existing) {
        this.clearTimers(existing);
        this.entriesByCwd.delete(cwd);
      }

      const now = new Date().toISOString();
      const store = this.storeRegistry.getStore(cwd);
      const automations = store.listAutomationDefinitions({ status: "enabled", scheduledOnly: true, limit: 500 });
      const entry: AutomationSchedulerEntry = {
        state: {
          id: `automation_scheduler_${randomUUID()}`,
          cwd,
          status: "running",
          startedAt: now,
          automationCount: automations.length,
          tickCount: 0,
          items: [],
        },
        generation: 1,
        timers: new Map(),
        runningAutomationIds: new Set(),
      };
      this.entriesByCwd.set(cwd, entry);
      for (const automation of automations) {
        this.scheduleAutomation(entry, automation, new Date());
      }
      this.refreshStateSummary(entry);
      this.startupState?.setPhase(cwd, "automation_scheduler", "ready");
      return { scheduler: entry.state, duplicate: false };
    } catch (error) {
      const entry = this.entriesByCwd.get(cwd);
      if (entry) {
        this.failEntry(entry, error);
      }
      this.startupState?.setPhase(cwd, "automation_scheduler", "degraded");
      this.startupState?.addDiagnostic(cwd, {
        level: "warning",
        code: "automation_scheduler_start_failed",
        phase: "automation_scheduler",
        message: error instanceof Error ? error.message : String(error),
        nextAction: "Inspect automation definitions and scheduler logs.",
      });
      throw error;
    }
  }

  list(cwd: string): AutomationSchedulerState[] {
    const entry = this.entriesByCwd.get(cwd);
    return entry ? [entry.state] : [];
  }

  refresh(cwd: string): AutomationSchedulerState {
    const existing = this.entriesByCwd.get(cwd);
    if (!existing || existing.state.status !== "running") {
      return this.start(cwd).scheduler;
    }
    existing.generation += 1;
    this.clearTimers(existing);
    existing.state = {
      ...existing.state,
      automationCount: 0,
      nextRunAt: undefined,
      items: [],
      lastErrorMessage: undefined,
    };
    try {
      const store = this.storeRegistry.getStore(cwd);
      const automations = store.listAutomationDefinitions({ status: "enabled", scheduledOnly: true, limit: 500 });
      for (const automation of automations) {
        if (existing.runningAutomationIds.has(automation.id)) {
          this.upsertItem(existing, {
            automationId: automation.id,
            title: automation.title,
          });
        } else {
          this.scheduleAutomation(existing, automation, new Date());
        }
      }
      this.refreshStateSummary(existing);
      return existing.state;
    } catch (error) {
      this.failEntry(existing, error);
      this.startupState?.setPhase(cwd, "automation_scheduler", "degraded");
      this.startupState?.addDiagnostic(cwd, {
        level: "warning",
        code: "automation_scheduler_refresh_failed",
        phase: "automation_scheduler",
        message: error instanceof Error ? error.message : String(error),
        nextAction: "Inspect automation definitions and scheduler logs, then refresh the scheduler.",
      });
      throw error;
    }
  }

  stop(cwd: string): AutomationSchedulerState | undefined {
    const entry = this.entriesByCwd.get(cwd);
    if (!entry) {
      return undefined;
    }
    entry.generation += 1;
    this.clearTimers(entry);
    entry.state = {
      ...entry.state,
      status: "stopped",
      stoppedAt: new Date().toISOString(),
      nextRunAt: undefined,
      items: entry.state.items.map((item) => ({ ...item, nextRunAt: undefined })),
    };
    this.entriesByCwd.delete(cwd);
    return entry.state;
  }

  stopAll(): void {
    for (const cwd of [...this.entriesByCwd.keys()]) {
      this.stop(cwd);
    }
  }

  async waitForIdle(): Promise<void> {
    while (this.inFlightTasks.size > 0) {
      await Promise.allSettled([...this.inFlightTasks]);
    }
  }

  private scheduleAutomation(entry: AutomationSchedulerEntry, automation: AutomationDefinition, from: Date): void {
    if (!this.isCurrentEntry(entry, entry.generation) || automation.status !== "enabled" || automation.trigger.type !== "schedule") {
      return;
    }
    const generation = entry.generation;
    let nextRunAt: string;
    try {
      nextRunAt = computeNextAutomationRunAt(automation, from);
    } catch (error) {
      if (!(error instanceof AutomationRecurrenceError)) throw error;
      // A malformed persisted schedule must not revoke unrelated timers. This
      // durable cleanup is intentionally outside the calculation catch: a DB
      // failure still follows the workspace-wide failEntry safety contract.
      this.storeRegistry.getStore(entry.state.cwd).updateAutomationDefinition(automation.id,
        { nextRunAt: null, lastErrorMessage: error.message }, new Date().toISOString());
      this.upsertItem(entry, { automationId: automation.id, title: automation.title, lastErrorMessage: error.message });
      return;
    }
    // Persist the real final due time, never the end of an intermediate segment.
    this.storeRegistry.getStore(entry.state.cwd).updateAutomationDefinition(automation.id, { nextRunAt }, new Date().toISOString());
    this.armAutomationTimer(entry, automation, nextRunAt, generation);
  }

  private armAutomationTimer(
    entry: AutomationSchedulerEntry,
    automation: AutomationDefinition,
    scheduledFor: string,
    generation: number,
  ): void {
    if (!this.isCurrentEntry(entry, generation)) {
      return;
    }
    const delayMs = Math.min(Math.max(Date.parse(scheduledFor) - Date.now(), 1), MAX_TIMER_DELAY_MS);
    const existingTimer = entry.timers.get(automation.id);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
    const timer = setTimeout(() => {
      if (!this.isCurrentEntry(entry, generation) || entry.timers.get(automation.id) !== timer) {
        return;
      }
      entry.timers.delete(automation.id);
      clearTimeout(timer);
      const task = this.fireAutomation(entry, automation.id, scheduledFor, automationScheduleIdentity(automation), generation);
      this.inFlightTasks.add(task);
      void task.then(() => this.inFlightTasks.delete(task), () => this.inFlightTasks.delete(task));
    }, delayMs);
    timer.unref?.();
    entry.timers.set(automation.id, timer);
    this.upsertItem(entry, {
      automationId: automation.id,
      title: automation.title,
      nextRunAt: scheduledFor,
    });
  }

  private async fireAutomation(
    entry: AutomationSchedulerEntry,
    automationId: string,
    scheduledFor: string,
    scheduleIdentity: string,
    generation: number,
  ): Promise<void> {
    if (
      !this.isCurrentEntry(entry, generation)
      || entry.runningAutomationIds.has(automationId)
    ) {
      return;
    }
    entry.runningAutomationIds.add(automationId);
    const firedAt = new Date().toISOString();
    let executionEntered = false;
    try {
      const store = this.storeRegistry.getStore(entry.state.cwd);
      const automation = store.getAutomationDefinition(automationId);
      if (!automation || automation.status !== "enabled" || automation.trigger.type !== "schedule") {
        this.removeTimer(entry, automationId);
        return;
      }
      // Definitions can change without an HTTP refresh (another Store writer,
      // restart or recovery). A captured timer is not execution authority.
      if (automationScheduleIdentity(automation) !== scheduleIdentity) {
        this.scheduleAutomation(entry, automation, new Date());
        return;
      }
      if (automation.nextRunAt !== scheduledFor) {
        if (automation.nextRunAt && Number.isFinite(Date.parse(automation.nextRunAt))) {
          this.armAutomationTimer(entry, automation, automation.nextRunAt, generation);
        } else {
          // A cleared/invalid durable due is revoked; only refresh may re-admit.
          this.removeTimer(entry, automationId);
        }
        return;
      }
      if (Date.now() < Date.parse(scheduledFor)) {
        this.armAutomationTimer(entry, automation, scheduledFor, generation);
        return;
      }
      executionEntered = true;
      const result = await runAutomation({
        cwd: entry.state.cwd,
        automationId,
        storeRegistry: this.storeRegistry,
        request: {
          triggerType: "schedule",
          scheduledFor,
          idempotencyKey: `automation:${automationId}:schedule:${scheduledFor}`,
        },
        startRun: async (runRequest, hooks) =>
          await executeRunRequest(
            runRequest,
            createDetachedRunExecutionSink(),
            this.runnerRegistry,
            this.storeRegistry,
            this.activeRuns,
            this.runtimeSupervisor,
            this.secretResolver,
            this.mcpBroker,
            {
              onRunReady: hooks.onRunReady,
              afterRunTerminal: async (terminalRun) => {
                await hooks.afterRunTerminal?.(terminalRun);
                await this.maybeContinueRunInterventions(terminalRun);
              },
              controlPlaneEvents: this.controlPlaneEvents,
              startupState: this.startupState,
              computerUsePreviews: this.computerUsePreviews,
            },
          ),
      });
      if (!this.isCurrentEntry(entry, generation)) {
        return;
      }
      entry.state = {
        ...entry.state,
        tickCount: entry.state.tickCount + 1,
        lastRunAt: firedAt,
        lastErrorMessage: undefined,
      };
      this.upsertItem(entry, {
        automationId: automation.id,
        title: automation.title,
        lastRunAt: firedAt,
        lastAutomationRunId: result.automationRun.id,
        lastErrorMessage: undefined,
      });
    } catch (error) {
      if (!this.isCurrentEntry(entry, generation)) {
        return;
      }
      if (!executionEntered) {
        // No execution was admitted. A scheduling/store fault cannot be
        // reported as a failed automation execution or silently rearmed.
        this.failEntry(entry, error, generation);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      entry.state = {
        ...entry.state,
        status: "running",
        tickCount: entry.state.tickCount + 1,
        lastRunAt: firedAt,
        lastErrorMessage: message,
      };
      this.upsertItem(entry, {
        automationId,
        title: automationId,
        lastRunAt: firedAt,
        lastErrorMessage: message,
      });
      const store = this.storeRegistry.getStore(entry.state.cwd);
      store.updateAutomationDefinition(automationId, { status: "error", lastErrorMessage: message }, new Date().toISOString());
    } finally {
      entry.runningAutomationIds.delete(automationId);
      // Rearming is scheduling recovery, not part of the completed execution.
      // Both unchanged and refreshed generations use the same persistence
      // failure boundary without relabelling an already committed Run.
      if (executionEntered || !this.isCurrentEntry(entry, generation)) {
        this.rescheduleAutomationAfterRefresh(entry, automationId);
      }
      if (this.isCurrentEntry(entry, entry.generation)) {
        this.refreshStateSummary(entry);
      }
    }
  }

  private rescheduleAutomationAfterRefresh(entry: AutomationSchedulerEntry, automationId: string): void {
    if (
      !this.isCurrentEntry(entry, entry.generation)
      || entry.timers.has(automationId)
      || entry.runningAutomationIds.has(automationId)
    ) {
      return;
    }
    const generation = entry.generation;
    try {
      const automation = this.storeRegistry.getStore(entry.state.cwd).getAutomationDefinition(automationId);
      if (!automation || automation.status !== "enabled" || automation.trigger.type !== "schedule") {
        return;
      }
      this.scheduleAutomation(entry, automation, new Date());
    } catch (error) {
      // This is scheduling recovery, not a failed execution. The completed Run
      // and AutomationRun must retain their already persisted terminal facts.
      if (!this.failEntry(entry, error, generation)) {
        return;
      }
      this.startupState?.setPhase(entry.state.cwd, "automation_scheduler", "degraded");
      this.startupState?.addDiagnostic(entry.state.cwd, {
        level: "warning",
        code: "automation_scheduler_rearm_failed",
        phase: "automation_scheduler",
        message: error instanceof Error ? error.message : String(error),
        nextAction: "Inspect automation definitions and scheduler logs, then restart the scheduler.",
      });
    }
  }

  private isCurrentEntry(entry: AutomationSchedulerEntry, generation: number): boolean {
    return entry.state.status === "running"
      && entry.generation === generation
      && this.entriesByCwd.get(entry.state.cwd) === entry;
  }

  private failEntry(entry: AutomationSchedulerEntry, error: unknown, generation = entry.generation): boolean {
    if (!this.isCurrentEntry(entry, generation)) {
      return false;
    }
    entry.generation += 1;
    this.clearTimers(entry);
    entry.state = {
      ...entry.state,
      status: "error",
      automationCount: 0,
      nextRunAt: undefined,
      items: [],
      lastErrorMessage: error instanceof Error ? error.message : String(error),
    };
    return true;
  }

  private async maybeContinueRunInterventions(terminalRun: RunSession): Promise<void> {
    const sourceRunId = terminalRun.parentRunId ?? terminalRun.id;
    const store = this.storeRegistry.findStoreForRun(sourceRunId, terminalRun.cwd) ?? this.storeRegistry.findStoreForRun(terminalRun.id, terminalRun.cwd);
    if (!store) {
      return;
    }
    await maybeStartNextRunInterventionContinuation({
      sourceRunId,
      terminalRun,
      store,
      runnerRegistry: this.runnerRegistry,
      storeRegistry: this.storeRegistry,
      activeRuns: this.activeRuns,
      runtimeSupervisor: this.runtimeSupervisor,
      secretResolver: this.secretResolver,
      mcpBroker: this.mcpBroker,
      controlPlaneEvents: this.controlPlaneEvents,
      startupState: this.startupState,
      computerUsePreviews: this.computerUsePreviews,
    });
  }

  private upsertItem(entry: AutomationSchedulerEntry, item: AutomationSchedulerItem): void {
    const current = entry.state.items.find((candidate) => candidate.automationId === item.automationId);
    const nextItem = { ...current, ...item };
    entry.state = {
      ...entry.state,
      items: [
        nextItem,
        ...entry.state.items.filter((candidate) => candidate.automationId !== item.automationId),
      ],
    };
    this.refreshStateSummary(entry);
  }

  private removeTimer(entry: AutomationSchedulerEntry, automationId: string): void {
    const timer = entry.timers.get(automationId);
    if (timer) {
      clearTimeout(timer);
      entry.timers.delete(automationId);
    }
    entry.state = {
      ...entry.state,
      items: entry.state.items.filter((item) => item.automationId !== automationId),
      automationCount: Math.max(entry.state.automationCount - 1, 0),
    };
    this.refreshStateSummary(entry);
  }

  private clearTimers(entry: AutomationSchedulerEntry): void {
    for (const timer of entry.timers.values()) {
      clearTimeout(timer);
    }
    entry.timers.clear();
  }

  private refreshStateSummary(entry: AutomationSchedulerEntry): void {
    const nextRunAt = entry.state.items
      .map((item) => item.nextRunAt)
      .filter((value): value is string => Boolean(value))
      .sort()[0];
    entry.state = {
      ...entry.state,
      automationCount: entry.state.items.length,
      nextRunAt,
    };
  }
}

function automationScheduleIdentity(automation: AutomationDefinition): string {
  return JSON.stringify([automation.trigger, automation.rrule]);
}
