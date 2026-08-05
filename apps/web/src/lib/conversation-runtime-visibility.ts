import type { ApprovalRequest, ExecutionAction, RunSession, TerminalReportDto } from "../types.js";

export function conversationRunHasVisibleWork(input: {
  readonly run: RunSession;
  readonly approvals: readonly ApprovalRequest[];
  readonly executionActions: readonly ExecutionAction[];
  readonly terminalReport?: TerminalReportDto;
}): boolean {
  if (input.run.status === "failed" || input.run.status === "waiting_for_approval") {
    return true;
  }
  if (input.executionActions.length > 0) {
    return true;
  }
  if (input.approvals.some((approval) => approval.status !== "approved")) {
    return true;
  }
  return conversationTerminalReportHasVisibleWork(input.terminalReport);
}

export function conversationTerminalReportHasVisibleWork(report: TerminalReportDto | undefined): boolean {
  if (!report) {
    return false;
  }
  if (
    report.outcome.corrections.length > 0 ||
    report.changes.length > 0 ||
    report.artifacts.length > 0 ||
    report.risks.length > 0
  ) {
    return true;
  }
  return [
    ...report.references,
    ...report.outcome.sourceRefs,
    ...report.verification.flatMap((verification) => verification.sourceRefs),
  ].some((reference) =>
    reference.visibility !== "developer_only" &&
    reference.sensitivity !== "secret_adjacent" &&
    ["approval", "artifact", "file", "operation"].includes(reference.kind)
  );
}
