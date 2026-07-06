import type { AutomationDefinition, AutomationDraft, AutomationRun, AutomationSchedulerState } from "../../types.js";

export type AutomationTab = "enabled" | "paused" | "failed" | "succeeded" | "history";

export interface AutomationTabItem {
  readonly id: AutomationTab;
  readonly label: string;
  readonly count: number;
}

export interface AutomationPageSummary {
  readonly totalDefinitions: number;
  readonly enabledDefinitions: number;
  readonly manualEnabledDefinitions: number;
  readonly scheduledEnabledDefinitions: number;
  readonly pausedDefinitions: number;
  readonly schedulerRunning: boolean;
  readonly scheduledWatchCount: number;
  readonly runningRunCount: number;
  readonly failedRecentRunCount: number;
  readonly readyDraftCount: number;
  readonly errorDefinitionCount: number;
  readonly schedulerStoppedWithScheduledWatches: boolean;
  readonly attentionCount: number;
}

export type AutomationTranslate = (
  value: string,
  values?: Readonly<Record<string, string | number>>,
) => string;

export interface AutomationSchedulerCopy {
  readonly statusLabel: string;
  readonly summary: string;
}

export function activeAutomations(automations: readonly AutomationDefinition[]): readonly AutomationDefinition[] {
  return automations.filter((automation) => automation.status === "enabled");
}

export function pausedAutomations(automations: readonly AutomationDefinition[]): readonly AutomationDefinition[] {
  return automations.filter((automation) => automation.status === "paused");
}

export function latestRunByAutomationId(runs: readonly AutomationRun[]): ReadonlyMap<string, AutomationRun> {
  const map = new Map<string, AutomationRun>();
  for (const run of runs) {
    if (!map.has(run.automationId)) {
      map.set(run.automationId, run);
    }
  }
  return map;
}

export function failedAutomations(
  automations: readonly AutomationDefinition[],
  latestRunById: ReadonlyMap<string, AutomationRun>,
): readonly AutomationDefinition[] {
  return automations.filter((automation) => automation.status === "error" || latestRunById.get(automation.id)?.status === "failed");
}

export function succeededAutomations(
  automations: readonly AutomationDefinition[],
  latestRunById: ReadonlyMap<string, AutomationRun>,
): readonly AutomationDefinition[] {
  return automations.filter((automation) => latestRunById.get(automation.id)?.status === "succeeded");
}

export function visibleAutomationsForTab(input: {
  readonly tab: AutomationTab;
  readonly enabled: readonly AutomationDefinition[];
  readonly paused: readonly AutomationDefinition[];
  readonly failed: readonly AutomationDefinition[];
  readonly succeeded: readonly AutomationDefinition[];
}): readonly AutomationDefinition[] {
  if (input.tab === "paused") {
    return input.paused;
  }
  if (input.tab === "failed") {
    return input.failed;
  }
  if (input.tab === "succeeded") {
    return input.succeeded;
  }
  return input.enabled;
}

export function isSchedulerRunning(status: string | undefined): boolean {
  return status === "running";
}

export function summarizeAutomationsPage({
  automations,
  automationRuns,
  automationDrafts,
  scheduler,
}: {
  readonly automations: readonly AutomationDefinition[];
  readonly automationRuns: readonly AutomationRun[];
  readonly automationDrafts: readonly AutomationDraft[];
  readonly scheduler?: AutomationSchedulerState;
}): AutomationPageSummary {
  const recentRuns = automationRuns.slice(0, 8);
  const enabledAutomations = automations.filter((automation) => automation.status === "enabled");
  const enabledDefinitions = enabledAutomations.length;
  const scheduledEnabledDefinitions = enabledAutomations.filter(isScheduledAutomationDefinition).length;
  const manualEnabledDefinitions = enabledDefinitions - scheduledEnabledDefinitions;
  const pausedDefinitions = automations.filter((automation) => automation.status === "paused").length;
  const errorDefinitionCount = automations.filter((automation) => automation.status === "error").length;
  const runningRunCount = recentRuns.filter(isAutomationRunInProgress).length;
  const failedRecentRunCount = recentRuns.filter((run) => run.status === "failed").length;
  const readyDraftCount = automationDrafts.filter((draft) => draft.status === "ready_for_confirmation").length;
  const schedulerRunning = isSchedulerRunning(scheduler?.status);
  const scheduledWatchCount = scheduler?.automationCount ?? scheduledEnabledDefinitions;
  const schedulerStoppedWithScheduledWatches = !schedulerRunning && scheduledWatchCount > 0;
  return {
    totalDefinitions: automations.filter((automation) => automation.status !== "archived").length,
    enabledDefinitions,
    manualEnabledDefinitions,
    scheduledEnabledDefinitions,
    pausedDefinitions,
    schedulerRunning,
    scheduledWatchCount,
    runningRunCount,
    failedRecentRunCount,
    readyDraftCount,
    errorDefinitionCount,
    schedulerStoppedWithScheduledWatches,
    attentionCount: readyDraftCount + failedRecentRunCount + errorDefinitionCount + (schedulerStoppedWithScheduledWatches ? 1 : 0),
  };
}

export function buildAutomationTabs({
  enabled,
  paused,
  needsAttention,
  succeeded,
  recentRuns,
  attentionCount,
  t,
}: {
  readonly enabled: readonly AutomationDefinition[];
  readonly paused: readonly AutomationDefinition[];
  readonly needsAttention: readonly AutomationDefinition[];
  readonly succeeded: readonly AutomationDefinition[];
  readonly recentRuns: readonly AutomationRun[];
  readonly attentionCount: number;
  readonly t: AutomationTranslate;
}): readonly AutomationTabItem[] {
  return [
    { id: "enabled", label: t("Enabled automations"), count: enabled.length },
    { id: "paused", label: t("Paused"), count: paused.length },
    { id: "failed", label: t("Needs attention"), count: attentionCount },
    { id: "succeeded", label: t("Succeeded"), count: succeeded.length },
    { id: "history", label: t("Recent history"), count: recentRuns.length },
  ];
}

export function automationSchedulerCopy({
  scheduler,
  manualEnabledCount = 0,
  t,
}: {
  readonly scheduler?: AutomationSchedulerState;
  readonly manualEnabledCount?: number;
  readonly t: AutomationTranslate;
}): AutomationSchedulerCopy {
  const isRunning = scheduler?.status === "running";
  const isError = scheduler?.status === "error";
  const scheduleCount = scheduler?.automationCount ?? 0;
  if (isError) {
    return {
      statusLabel: t("Scheduler needs attention"),
      summary: t("Scheduler needs attention: {message}", { message: scheduler?.lastErrorMessage || t("Unknown error") }),
    };
  }
  if (isRunning && scheduleCount > 0) {
    return {
      statusLabel: t("Scheduler started"),
      summary: t("Watching {count} scheduled automations.", { count: scheduleCount }),
    };
  }
  if (isRunning) {
    return {
      statusLabel: t("Scheduler started"),
      summary: manualEnabledCount > 0
        ? t("No scheduled automations are enabled. Manual automations can still run now.")
        : t("No enabled scheduled automations yet."),
    };
  }
  if (scheduleCount > 0) {
    return {
      statusLabel: t("Scheduler stopped"),
      summary: t("{count} scheduled automations are ready. Start scheduler to run them automatically.", { count: scheduleCount }),
    };
  }
  return {
    statusLabel: t("Scheduler stopped"),
    summary: manualEnabledCount > 0
      ? t("Manual automations can still run now. Add a schedule to run automatically.")
      : t("No enabled scheduled automations yet. Create or edit one with a schedule."),
  };
}

function isScheduledAutomationDefinition(automation: AutomationDefinition): boolean {
  return automation.trigger.type === "schedule" || Boolean(automation.rrule);
}

function isAutomationRunInProgress(run: AutomationRun): boolean {
  return run.status === "running" || run.status === "queued" || run.status === "waiting_for_approval";
}
