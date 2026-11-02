import { createSqliteWorkflowIntegrationCoordinatorStore, type RunStore,
  type TerminalReportEvidenceRisk, type TerminalReportLanguage } from "@ling-stack/core";
import { formatSynchronousCatalogMessage } from "@ling-stack/localization";
import { workflowIsolationIsDraining } from "./workflow-isolation-lifecycle.js";

export const workflowIsolationRiskId = (workflowId: string): string => `workflow-isolation-unconfirmed:${workflowId}`;

export function collectWorkflowIsolationRisks(store: RunStore, workflowId: string,
  language: TerminalReportLanguage): readonly TerminalReportEvidenceRisk[] {
  let unconfirmed = workflowIsolationIsDraining(store, workflowId);
  try {
    unconfirmed ||= Boolean(createSqliteWorkflowIntegrationCoordinatorStore(store).readPublicationBlocker(workflowId));
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "workflow_integration.store_not_sqlite") unconfirmed = true;
    else unconfirmed ||= store.listChannelWorkflowSteps({ workflowId, complete: true }).some(step => Boolean(step.metadata?.isolationScopePlan));
  }
  return unconfirmed ? [{ id: workflowIsolationRiskId(workflowId), severity: "critical", status: "unverified",
    summary: formatSynchronousCatalogMessage(language, "terminal_report.evidence.execution_unconfirmed"),
    sourceRefs: [{ kind: "workflow", id: workflowId, visibility: "conversation", sensitivity: "normal" }] }] : [];
}
