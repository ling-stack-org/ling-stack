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
import type { StartupStateRegistry } from "../../startup/state.js";
import type { ControlPlaneEventHub } from "../control-plane/events.js";
import type { ComputerUseProjectionRegistry } from "../computer-use/registry.js";
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
    if (entry.state.status !== "running" || automation.trigger.type !== "schedule") {
      return;
    }
    const generation = entry.generation;
    const nextRunAt = computeNextAutomationRunAt(automation, from);
    const delayMs = Math.max(new Date(nextRunAt).getTime() - Date.now(), 1000);
    const existingTimer = entry.timers.get(automation.id);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
    const timer = setTimeout(() => {
      if (entry.timers.get(automation.id) === timer) {
        entry.timers.delete(automation.id);
      }
      const task = this.fireAutomation(entry, automation.id, nextRunAt, generation);
      this.inFlightTasks.add(task);
      void task.finally(() => this.inFlightTasks.delete(task));
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

  private async fireAutomation(
    entry: AutomationSchedulerEntry,
    automationId: string,
    scheduledFor: string,
    generation: number,
  ): Promise<void> {
    if (
      entry.state.status !== "running"
      || entry.generation !== generation
      || entry.runningAutomationIds.has(automationId)
    ) {
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
      if (entry.state.status !== "running" || entry.generation !== generation) {
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
      this.scheduleAutomation(entry, automation, new Date());
    } catch (error) {
      if (entry.state.status !== "running" || entry.generation !== generation) {
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
      if (entry.generation === generation) {
        this.refreshStateSummary(entry);
      } else {
        this.rescheduleAutomationAfterRefresh(entry, automationId);
      }
    }
  }

  private rescheduleAutomationAfterRefresh(entry: AutomationSchedulerEntry, automationId: string): void {
    if (
      entry.state.status !== "running"
      || entry.timers.has(automationId)
      || entry.runningAutomationIds.has(automationId)
    ) {
      return;
    }
    const automation = this.storeRegistry.getStore(entry.state.cwd).getAutomationDefinition(automationId);
    if (!automation || automation.status !== "enabled" || automation.trigger.type !== "schedule") {
      return;
    }
    this.scheduleAutomation(entry, automation, new Date());
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

export function computeNextAutomationRunAt(
  automation: Pick<AutomationDefinition, "trigger" | "rrule">,
  from: Date = new Date(),
): string {
  if (automation.trigger.type !== "schedule") {
    return new Date(from.getTime() + 24 * 60 * 60 * 1000).toISOString();
  }
  if (automation.trigger.schedule.cadence !== "interval" && automation.rrule) {
    const rruleRunAt = computeNextRunAtFromRRule(automation.rrule, automation.trigger.timezone, from);
    if (rruleRunAt) {
      return rruleRunAt;
    }
  }
  return computeNextRunAt(automation.trigger.schedule, automation.trigger.timezone, from);
}

export function computeNextRunAtFromRRule(rrule: string, timezone: string, from: Date = new Date()): string | undefined {
  const parsed = parseRRule(rrule);
  if (!parsed) {
    return undefined;
  }
  if (parsed.freq === "MINUTELY") {
    return new Date(from.getTime() + parsed.interval * 60 * 1000).toISOString();
  }

  const fromParts = getZonedDateParts(from, timezone);
  const byHour = parsed.byHour.length > 0 ? parsed.byHour : [fromParts.hour ?? 9];
  const byMinute = parsed.byMinute.length > 0 ? parsed.byMinute : [0];
  const bySecond = parsed.bySecond.length > 0 ? parsed.bySecond : [0];
  const weekdays = parsed.freq === "WEEKLY" || parsed.byDay.length > 0 ? parsed.byDay : [];

  for (let dayOffset = 0; dayOffset <= 370; dayOffset += 1) {
    const candidateDate = addUtcCalendarDays(fromParts, dayOffset);
    const weekday = new Date(Date.UTC(candidateDate.year, candidateDate.month - 1, candidateDate.day)).getUTCDay();
    if (weekdays.length > 0 && !weekdays.includes(weekday)) {
      continue;
    }
    for (const hour of byHour) {
      for (const minute of byMinute) {
        for (const second of bySecond) {
          const candidate = new Date(zonedTimeToUtc(candidateDate.year, candidateDate.month, candidateDate.day, hour, minute, timezone).getTime() + second * 1000);
          if (candidate.getTime() > from.getTime() + 999) {
            return candidate.toISOString();
          }
        }
      }
    }
  }
  return undefined;
}

interface ParsedRRule {
  readonly freq: "MINUTELY" | "DAILY" | "WEEKLY";
  readonly interval: number;
  readonly byDay: readonly number[];
  readonly byHour: readonly number[];
  readonly byMinute: readonly number[];
  readonly bySecond: readonly number[];
}

function parseRRule(rrule: string): ParsedRRule | undefined {
  const fields = new Map<string, string>();
  for (const part of rrule.split(";")) {
    const [rawKey, ...rawValue] = part.split("=");
    const key = rawKey?.trim().toUpperCase();
    const value = rawValue.join("=").trim().toUpperCase();
    if (key && value) {
      fields.set(key, value);
    }
  }
  const freq = fields.get("FREQ");
  if (freq !== "MINUTELY" && freq !== "DAILY" && freq !== "WEEKLY") {
    return undefined;
  }
  return {
    freq,
    interval: Math.max(readPositiveInteger(fields.get("INTERVAL")) ?? 1, 1),
    byDay: parseRRuleWeekdays(fields.get("BYDAY")),
    byHour: parseRRuleNumbers(fields.get("BYHOUR"), 0, 23),
    byMinute: parseRRuleNumbers(fields.get("BYMINUTE"), 0, 59),
    bySecond: parseRRuleNumbers(fields.get("BYSECOND"), 0, 59),
  };
}

function parseRRuleNumbers(value: string | undefined, min: number, max: number): readonly number[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((item) => Number.parseInt(item.trim(), 10))
    .filter((item, index, values) => Number.isInteger(item) && item >= min && item <= max && values.indexOf(item) === index)
    .sort((left, right) => left - right);
}

function parseRRuleWeekdays(value: string | undefined): readonly number[] {
  if (!value) {
    return [];
  }
  const weekdays = new Map([
    ["SU", 0],
    ["MO", 1],
    ["TU", 2],
    ["WE", 3],
    ["TH", 4],
    ["FR", 5],
    ["SA", 6],
  ]);
  return value
    .split(",")
    .map((item) => weekdays.get(item.trim().slice(-2).toUpperCase()))
    .filter((item, index, values): item is number => item !== undefined && values.indexOf(item) === index)
    .sort((left, right) => left - right);
}

function readPositiveInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
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
