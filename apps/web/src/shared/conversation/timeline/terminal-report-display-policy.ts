import type { ConversationTimelineTerminalReportItem } from "@ling-stack/conversation-ui-core";

/**
 * Presentation only, after the shared privacy projection. The durable report,
 * its completion authority and its response/file/footer ownership stay intact.
 * In particular, model prose is never used to decide whether a Run succeeded.
 */
export function terminalReportDisplayPolicy(
  item: ConversationTimelineTerminalReportItem,
  hasFinalNarration: boolean,
): { readonly visible: boolean; readonly needsAttention: boolean } {
  const needsAttention = item.status !== "succeeded" || item.outcomeStatus !== "succeeded" ||
    item.verification.some((check) => check.status !== "passed" && !(check.expectation === "informational" &&
      (check.status === "skipped" || check.status === "not_run"))) ||
    item.participants.some((participant) => participant.status !== "completed") ||
    item.risks.some((risk) => risk.status === "unresolved" || risk.status === "unverified" ||
      risk.approvalDecision === "pending" || risk.approvalDecision === "denied" ||
      risk.approvalDecision === "expired" || risk.approvalDecision === "cancelled");
  // A correction or a non-file deliverable can add useful information even
  // when the Run succeeded. File changes have their own shared final card.
  const hasSupplement = item.corrections.length > 0 || item.artifacts.some((artifact) =>
    artifact.kind !== "file" && artifact.kind !== "diff" && artifact.kind !== "test_result");
  return { visible: !hasFinalNarration || needsAttention || hasSupplement, needsAttention };
}
