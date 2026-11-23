import type { TerminalReport, TerminalReportEvidenceSnapshot } from "../dist/index.js";

type SnapshotOverrides = Partial<Omit<TerminalReportEvidenceSnapshot,
  "schemaVersion" | "source" | "delegationCompletionFingerprint" | "evidenceFingerprint">> & {
  sourceId?: string;
  sourceKind?: TerminalReportEvidenceSnapshot["source"]["kind"];
};

type ReportOverrides = Partial<
  Pick<TerminalReport, "id" | "status" | "createdAt" | "committedAt"> &
  Pick<TerminalReport["synthesis"], "mode" | "promptVersion" | "attemptCount" | "validationCodes">
>;

export function buildTerminalReportSnapshot(overrides?: SnapshotOverrides): TerminalReportEvidenceSnapshot;

export function buildTerminalReport(
  snapshot: TerminalReportEvidenceSnapshot,
  overrides?: ReportOverrides,
): TerminalReport;
