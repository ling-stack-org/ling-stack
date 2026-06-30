import type { AutomationDefinition, AutomationRun } from "../../types.js";

export type AutomationTab = "enabled" | "paused" | "failed" | "succeeded" | "history";

export interface AutomationTabItem {
  readonly id: AutomationTab;
  readonly label: string;
  readonly count: number;
}

export function activeAutomations(automations: readonly AutomationDefinition[]): readonly AutomationDefinition[] {
  return automations.filter((automation) => automation.status !== "paused" && automation.status !== "archived");
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
