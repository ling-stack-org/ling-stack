import type { LingTerminalReportRecord, RunSession, RunStore } from "@ling-stack/core";

export function runIsEligibleForTerminalReport(store: RunStore, run: RunSession): boolean {
  if (run.workflowStepId) return false;
  const primaryWorkUnit = run.workUnitId ? store.getWorkUnit(run.workUnitId) : undefined;
  if (primaryWorkUnit?.kind === "channel_ai_reply") return false;
  return store.listWorkUnits({ kind: "channel_ai_reply", linkedRunId: run.id, limit: 1 }).length === 0;
}

export function turnIsEligibleForTerminalReport(store: RunStore, turnId: string): boolean {
  const runLinks = store.listLingTurnRuns(turnId);
  if (runLinks.length === 0) return true;
  return runLinks.some((link) => {
    const run = store.getRun(link.runId);
    return run ? runIsEligibleForTerminalReport(store, run) : false;
  });
}

export function terminalReportIsEligibleForDisplay(
  store: RunStore,
  record: Pick<LingTerminalReportRecord, "sourceKind" | "sourceId" | "turnId">,
): boolean {
  if (record.sourceKind === "workflow") return true;
  if (record.sourceKind === "turn") {
    return turnIsEligibleForTerminalReport(store, record.turnId ?? record.sourceId);
  }
  const run = store.getRun(record.sourceId);
  return run ? runIsEligibleForTerminalReport(store, run) : true;
}
