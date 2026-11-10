import { captureNormalTerminalReportBasis, type NormalTerminalReportBasis, type RunStore, type TerminalReport } from "@ling-stack/core";
import { collectRunTerminalReportEvidence, collectTurnTerminalReportEvidence } from "./terminal-report-evidence.js";
import { TerminalReportPublicationError, type TerminalReportPublication } from "./terminal-report-publisher.js";

/** Publish into the existing normal Thread/Turn; never synthesize channel lineage. */
export function publishNormalTerminalReport(input: {
  readonly store: RunStore;
  readonly report: TerminalReport;
  readonly expectedNormalBasis?: NormalTerminalReportBasis;
  readonly now: string;
}): TerminalReportPublication {
  const { store, report } = input;
  if (report.source.kind === "workflow") throw new TerminalReportPublicationError("report_conflict", "Normal report cannot own a workflow");
  const source = { kind: report.source.kind, id: report.source.id };
  const basis = input.expectedNormalBasis ?? store.readSnapshot(() => captureNormalTerminalReportBasis(store, source));
  const record = store.getTerminalReport(report.id);
  if (!basis || !record || (record.status !== "validating" && record.status !== "committed" && record.status !== "fallback")) {
    throw new TerminalReportPublicationError("source_turn_conflict", `Normal report has no canonical source scope: ${report.id}`);
  }
  const supersedesItemId = store.listTerminalReports({ sourceKind: source.kind, sourceId: source.id, limit: 500 })
    .filter((other) => other.generation < record.generation && other.resultItemId)
    .sort((a, b) => b.generation - a.generation)[0]?.resultItemId;
  const result = store.commitTerminalReportPublication({
    reportId: report.id, expectedReportStatus: record.status, expectedEvidenceFingerprint: report.evidenceFingerprint,
    expectedNormalBasis: basis, report,
    readEvidence: () => source.kind === "turn"
      ? collectTurnTerminalReportEvidence(store, source.id, { generatedAt: input.now })
      : collectRunTerminalReportEvidence(store, source.id, { generatedAt: input.now }),
    publicationItem: {
      id: `result_terminal_report:${report.id}`, threadId: basis.threadId, turnId: basis.turnId,
      kind: "terminal_report", status: "committed", actorType: "system", visibility: "thread_participants",
      payload: { reportId: report.id, generation: record.generation, sourceKind: source.kind, sourceId: source.id,
        evidenceFingerprint: report.evidenceFingerprint, outcomeStatus: report.outcome.status },
      domainRefs: [
        { type: "terminal_report", id: report.id }, { type: "conversation_item", id: basis.sourceItemId },
        { type: "turn", id: basis.turnId }, ...basis.runIds.map((id) => ({ type: "run" as const, id })),
      ],
      idempotencyKey: `terminal-report:${report.id}`, ...(supersedesItemId ? { supersedesItemId } : {}),
    },
    publicationEventIdempotencyKey: `terminal-report:${report.id}:published`, now: input.now,
  });
  if (!result.ok) throw new TerminalReportPublicationError(result.code, `Normal report publication conflict: ${report.id}/${result.code}`);
  return { resultItem: result.item, controlPlaneEvent: result.controlPlaneEvent, duplicate: result.duplicate };
}
