import type { ConversationItemV1, TerminalReportDto } from "@ling-stack/contracts";

interface TerminalReportScope {
  readonly workspaceId: string;
  readonly channelId: string;
  readonly threadId: string;
  readonly turnId: string;
}

export function terminalReportGeneration(
  report: TerminalReportDto | undefined,
  reportId: string,
  items: readonly ConversationItemV1[],
  scope: TerminalReportScope,
): number | undefined {
  if (!report || report.id !== reportId || !scope.threadId || !scope.turnId
    || report.workspaceId !== scope.workspaceId || report.channelId !== scope.channelId
    || (report.threadId && report.threadId !== scope.threadId)
    || (report.turnId && report.turnId !== scope.turnId)) {
    return undefined;
  }
  const generations: number[] = [];
  for (const item of items) {
    if (item.kind !== "terminal_report" || item.status !== "committed"
      || (item.visibility !== "channel" && item.visibility !== "thread_participants")
      || item.workspaceId !== scope.workspaceId || item.channelId !== scope.channelId
      || item.threadId !== scope.threadId || item.turnId !== scope.turnId) continue;
    const payload = item.payload;
    if (payload.reportId !== reportId
      || payload.sourceKind !== report.source.kind || payload.sourceId !== report.source.id
      || payload.evidenceFingerprint !== report.evidenceFingerprint
      || payload.outcomeStatus !== report.outcome.status
      || !Number.isSafeInteger(payload.generation) || payload.generation < 1) continue;
    generations.push(payload.generation);
  }
  return generations.length === 1 ? generations[0] : undefined;
}
