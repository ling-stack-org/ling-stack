import {
  visibleTerminalReportTimelineItem,
  type ConversationTimelineTerminalReportItem,
} from "@ling-stack/conversation-ui-core";

/**
 * A report-only failure needs a readable ending, not just a generic outcome.
 * Use only the privacy-filtered report's own run-level warnings. Atomic output,
 * internal error codes and source labels never become narrative here. Detail
 * sections retain every original risk and reference for inspection and copy.
 */
export function terminalReportFallbackSummary(input: ConversationTimelineTerminalReportItem): string {
  const item = visibleTerminalReportTimelineItem(input);
  const blocks = [item.summary];
  if (item.outcomeStatus === "failed" || item.outcomeStatus === "cancelled" || item.outcomeStatus === "blocked") {
    for (const risk of item.risks) {
      // Canonical display refs intentionally remove internal Run links. Host
      // interruption risk identities survive that projection; use these fixed
      // namespaces, never raw error text or inferred command/path content.
      const runLevel = risk.sourceRefs.some((ref) => ref.kind === "run") ||
        risk.id.startsWith("run-failure:") || risk.id.startsWith("execution-unconfirmed:");
      if (risk.severity !== "critical" || (risk.status !== "unresolved" && risk.status !== "unverified") || !runLevel) continue;
      blocks.push(risk.summary);
    }
  }
  return [...new Set(blocks.map((block) => block.trim()).filter(Boolean))].join("\n\n");
}
