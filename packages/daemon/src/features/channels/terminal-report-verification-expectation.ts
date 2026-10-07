import type { TerminalReportDto } from "@ling-stack/contracts";
import type { TerminalReport, TerminalReportEvidenceSnapshot, TerminalReportVerification } from "@ling-stack/core";

/**
 * Classify only against the report's sealed Host evidence. An unrun declaration
 * about this Turn is not an expected check; actual/missing planned checks retain
 * their own check refs and attention. This grants no tool or test permission.
 * Old/unbound evidence stays unknown, never rewritten or inferred from prose.
 */
export function terminalReportVerificationExpectation(
  check: TerminalReportVerification, report: TerminalReport, snapshot?: TerminalReportEvidenceSnapshot,
): NonNullable<TerminalReportDto["verification"][number]["expectation"]> {
  if (!snapshot || snapshot.id !== report.evidenceSnapshotId || snapshot.evidenceFingerprint !== report.evidenceFingerprint
    || snapshot.workspaceId !== report.workspaceId || snapshot.source.kind !== report.source.kind || snapshot.source.id !== report.source.id) return "unknown";
  const checkRefs = check.sourceRefs.filter(ref => ref.kind === "check");
  if (checkRefs.length) return checkRefs.every(ref => snapshot.checks.some(evidence => evidence.id === ref.id && evidence.status === check.status))
    ? "evidence_backed" : "unknown";
  if (!["skipped", "not_run"].includes(check.status) || check.command || !check.sourceRefs.length) return "unknown";
  // Only a declaration linked to the owning request can be informational.
  // Operation/file/external/check refs or ambiguous ownership remain conservative.
  const ownsRequestRef = (ref: TerminalReportVerification["sourceRefs"][number]): boolean =>
    ref.kind === "turn" && !!snapshot.turnId && ref.id === snapshot.turnId
    || ref.kind === "message" && !!snapshot.sourceMessageId && ref.id === snapshot.sourceMessageId;
  return check.sourceRefs.every(ownsRequestRef) ? "informational" : "unknown";
}
