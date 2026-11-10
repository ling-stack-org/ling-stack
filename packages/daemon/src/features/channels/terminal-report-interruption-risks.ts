import {
  readNormalTerminalToolBarrier,
  unconfirmedToolRiskId,
  type ExecutionAction,
  type RunSession,
  type RunStore,
  type TerminalReportEvidenceRisk,
  type TerminalReportLanguage,
} from "@ling-stack/core";
import { formatSynchronousCatalogMessage } from "@ling-stack/localization";

/** Unfinished tool receipts remain explicit even when Run authority has ended. */
export function collectTerminalInterruptionRisks(
  store: RunStore,
  runs: readonly RunSession[],
  language: TerminalReportLanguage,
  actions: readonly ExecutionAction[],
): TerminalReportEvidenceRisk[] {
  return runs.flatMap(run => readNormalTerminalToolBarrier(store, run).unsettledTools.map(tool => ({
    id: unconfirmedToolRiskId(tool), severity: "critical" as const, status: "unverified" as const,
    summary: formatSynchronousCatalogMessage(language, "terminal_report.evidence.execution_unconfirmed"),
    sourceRefs: [
      { kind: "run" as const, id: run.id, visibility: "conversation" as const, sensitivity: "normal" as const },
      ...actions.filter(action => action.runId === run.id && action.toolCallId === tool.toolCallId).map(action => ({
        kind: "operation" as const, id: action.id, visibility: "conversation" as const, sensitivity: "normal" as const,
      })),
    ],
  })));
}

/** Keep the diagnostic code in Run/event storage, not in ordinary narration. */
export function terminalReportFailureSummary(run: RunSession, language: TerminalReportLanguage): string | undefined {
  if (run.errorMessage?.trim() === "runtime_interrupted_no_checkpoint") {
    return formatSynchronousCatalogMessage(language, "terminal_report.evidence.runtime_interrupted_no_checkpoint");
  }
  return run.errorMessage;
}
