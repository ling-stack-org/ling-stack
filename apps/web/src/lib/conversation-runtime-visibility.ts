import type { ApprovalRequest, ExecutionAction, RunSession, TerminalReportDto, WorkUnit } from "../types.js";

export function deriveSilentChannelReplyRunIds(input: {
  readonly runs: readonly RunSession[];
  readonly workUnits: readonly WorkUnit[];
  readonly approvals: readonly ApprovalRequest[];
  readonly executionActions: readonly ExecutionAction[];
  readonly terminalReports: readonly TerminalReportDto[];
}): ReadonlySet<string> {
  const workUnitById = new Map(input.workUnits.map((workUnit) => [workUnit.id, workUnit]));
  const terminalReportByRunId = new Map(input.terminalReports.flatMap((report) =>
    report.source.kind === "run" ? [[report.source.id, report] as const] : []
  ));
  const silentRunIds = new Set<string>();

  for (const run of input.runs) {
    const workUnit = run.workUnitId ? workUnitById.get(run.workUnitId) : undefined;
    const hasVisibleWork = conversationRunHasVisibleWork({
      run,
      approvals: input.approvals.filter((approval) => approval.runId === run.id),
      executionActions: input.executionActions.filter((action) => action.runId === run.id),
      terminalReport: terminalReportByRunId.get(run.id),
    });
    if (run.workUnitId && !workUnit) {
      // A paged-out or still-loading owner does not invalidate known facts.
      // Hide only the evidence-free supervision shell while ownership loads.
      if (!hasVisibleWork) silentRunIds.add(run.id);
      continue;
    }
    if (workUnit?.kind !== "channel_ai_reply") {
      continue;
    }
    if (!hasVisibleWork) {
      silentRunIds.add(run.id);
    }
  }

  return silentRunIds;
}

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
