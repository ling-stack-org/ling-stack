import { randomUUID } from "node:crypto";
import type {
  AutomationDefinition,
  AutomationSchedule,
  RunSession,
  SecretResolver,
} from "@ling-stack/core";
import type { McpBroker } from "../../context.js";
import type { ActiveRunRegistry } from "../../runtime/active-runs.js";
import type { RunnerRegistry } from "../../runtime/runners.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import type { RuntimeSupervisor } from "../../runtime/supervisor.js";
import type { ControlPlaneEventHub } from "../control-plane/events.js";
import { createDetachedRunExecutionSink, executeRunRequest } from "../runs/orchestrator.js";
import { maybeStartNextRunInterventionContinuation } from "../runs/interventions.js";
import { runAutomation } from "./run.js";

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
  timers: Map<string, ReturnType<typeof setTimeout>>;
  runningAutomationIds: Set<string>;
}

export class AutomationSchedulerRegistry {
  private readonly entriesByCwd = new Map<string, AutomationSchedulerEntry>();

  constructor(
    private readonly runnerRegistry: RunnerRegistry,
    private readonly storeRegistry: RunStoreRegistry,
    private readonly activeRuns: ActiveRunRegistry,
    private readonly runtimeSupervisor: RuntimeSupervisor,
    private readonly secretResolver: SecretResolver,
    private readonly mcpBroker: McpBroker,
    private readonly controlPlaneEvents: ControlPlaneEventHub,
  ) {}

  start(cwd: string): { readonly scheduler: AutomationSchedulerState; readonly duplicate: boolean } {
    const existing = this.entriesByCwd.get(cwd);
    if (existing?.state.status === "running") {
      return { scheduler: existing.state, duplicate: true };
    }
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
      timers: new Map(),
      runningAutomationIds: new Set(),
    };
    this.entriesByCwd.set(cwd, entry);
    for (const automation of automations) {
      this.scheduleAutomation(entry, automation, new Date());
    }
    this.refreshStateSummary(entry);
    return { scheduler: entry.state, duplicate: false };
  }

  list(cwd: string): AutomationSchedulerState[] {
    const entry = this.entriesByCwd.get(cwd);
    return entry ? [entry.state] : [];
  }

  stop(cwd: string): AutomationSchedulerState | undefined {
    const entry = this.entriesByCwd.get(cwd);
    if (!entry) {
      return undefined;
    }
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

  private scheduleAutomation(entry: AutomationSchedulerEntry, automation: AutomationDefinition, from: Date): void {
    if (automation.trigger.type !== "schedule") {
      return;
    }
    const nextRunAt = computeNextRunAt(automation.trigger.schedule, automation.trigger.timezone, from);
    const delayMs = Math.max(new Date(nextRunAt).getTime() - Date.now(), 1000);
    const existingTimer = entry.timers.get(automation.id);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
    const timer = setTimeout(() => {
      void this.fireAutomation(entry, automation.id, nextRunAt);
    }, delayMs);
    timer.unref?.();
    entry.timers.set(automation.id, timer);
    this.upsertItem(entry, {
      automationId: automation.id,
      title: automation.title,
      nextRunAt,
    });
    this.storeRegistry.getStore(entry.state.cwd).updateAutomationDefinition(automation.id, { nextRunAt }, new Date().toISOString());
  }

  private async fireAutomation(entry: AutomationSchedulerEntry, automationId: string, scheduledFor: string): Promise<void> {
    if (entry.state.status !== "running" || entry.runningAutomationIds.has(automationId)) {
      return;
    }
    entry.runningAutomationIds.add(automationId);
    const firedAt = new Date().toISOString();
    try {
      const store = this.storeRegistry.getStore(entry.state.cwd);
      const automation = store.getAutomationDefinition(automationId);
      if (!automation || automation.status !== "enabled" || automation.trigger.type !== "schedule") {
        this.removeTimer(entry, automationId);
        return;
      }
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
              afterRunTerminal: (terminalRun) => {
                hooks.afterRunTerminal?.(terminalRun);
                this.maybeContinueRunInterventions(terminalRun);
              },
              controlPlaneEvents: this.controlPlaneEvents,
            },
          ),
      });
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
      this.scheduleAutomation(entry, automation, new Date());
    } catch (error) {
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
      this.refreshStateSummary(entry);
    }
  }

  private maybeContinueRunInterventions(terminalRun: RunSession): void {
    const sourceRunId = terminalRun.parentRunId ?? terminalRun.id;
    const store = this.storeRegistry.findStoreForRun(sourceRunId, terminalRun.cwd) ?? this.storeRegistry.findStoreForRun(terminalRun.id, terminalRun.cwd);
    if (!store) {
      return;
    }
    maybeStartNextRunInterventionContinuation({
      sourceRunId,
      store,
      runnerRegistry: this.runnerRegistry,
      storeRegistry: this.storeRegistry,
      activeRuns: this.activeRuns,
      runtimeSupervisor: this.runtimeSupervisor,
      secretResolver: this.secretResolver,
      mcpBroker: this.mcpBroker,
      controlPlaneEvents: this.controlPlaneEvents,
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

export function computeNextRunAt(schedule: AutomationSchedule, timezone: string, from: Date = new Date()): string {
  if (schedule.cadence === "interval") {
    return new Date(from.getTime() + schedule.everyMs).toISOString();
  }
  const [hour, minute] = schedule.timeOfDay.split(":").map((part) => Number.parseInt(part, 10));
  const fromParts = getZonedDateParts(from, timezone);
  for (let dayOffset = 0; dayOffset <= 8; dayOffset += 1) {
    const candidateDate = addUtcCalendarDays(fromParts, dayOffset);
    const weekday = new Date(Date.UTC(candidateDate.year, candidateDate.month - 1, candidateDate.day)).getUTCDay();
    if (schedule.cadence === "weekly" && weekday !== schedule.weekday) {
      continue;
    }
    const candidate = zonedTimeToUtc(candidateDate.year, candidateDate.month, candidateDate.day, hour, minute, timezone);
    if (candidate.getTime() > from.getTime() + 999) {
      return candidate.toISOString();
    }
  }
  return new Date(from.getTime() + 24 * 60 * 60 * 1000).toISOString();
}

function addUtcCalendarDays(parts: ZonedDateParts, dayOffset: number): ZonedDateParts {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + dayOffset));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, timezone: string): Date {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const actualParts = getZonedDateParts(new Date(utcGuess), timezone);
  const desiredLocal = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const actualLocal = Date.UTC(actualParts.year, actualParts.month - 1, actualParts.day, actualParts.hour ?? 0, actualParts.minute ?? 0, 0, 0);
  return new Date(utcGuess + (desiredLocal - actualLocal));
}

interface ZonedDateParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour?: number;
  readonly minute?: number;
}

function getZonedDateParts(date: Date, timezone: string): ZonedDateParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const values: Record<string, number> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type === "year" || part.type === "month" || part.type === "day" || part.type === "hour" || part.type === "minute") {
      values[part.type] = Number.parseInt(part.value, 10);
    }
  }
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour === 24 ? 0 : values.hour,
    minute: values.minute,
  };
}
