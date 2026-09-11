import { createHash } from "node:crypto";
import type {
  TerminalReport,
  TerminalReportContent,
  TerminalReportEvidenceSnapshot,
  TerminalReportOutcomeStatus,
  TerminalReportSourceRef,
} from "./terminal-report-types.js";

export type TerminalReportValidationCode =
  | "terminal_report_schema_invalid"
  | "terminal_report_source_ref_missing"
  | "terminal_report_outcome_mismatch"
  | "terminal_report_unverified_success_claim"
  | "terminal_report_changed_path_without_evidence"
  | "terminal_report_participant_without_activity"
  | "terminal_report_external_ref_unverified"
  | "terminal_report_privacy_violation"
  | "terminal_report_duplicate_item_id"
  | "terminal_report_fingerprint_mismatch";

export interface TerminalReportValidationIssue {
  readonly code: TerminalReportValidationCode;
  readonly path: string;
  readonly message: string;
}

export interface TerminalReportValidationResult {
  readonly ok: boolean;
  readonly issues: readonly TerminalReportValidationIssue[];
}

export function terminalReportSourceRefKey(ref: Pick<TerminalReportSourceRef, "kind" | "id">): string {
  return `${ref.kind}:${ref.id}`;
}

export function computeTerminalReportEvidenceFingerprint(
  snapshot: Omit<TerminalReportEvidenceSnapshot, "evidenceFingerprint"> | TerminalReportEvidenceSnapshot,
): string {
  // Snapshot ids and collection timestamps identify an observation, but are not
  // evidence themselves. Excluding these volatile fields makes repeated
  // projections of the same canonical run/workflow state compare equal while
  // still changing the fingerprint whenever a durable fact changes.
  const normalized = {
    ...snapshot,
    id: undefined,
    generatedAt: undefined,
    evidenceFingerprint: undefined,
  };
  return createHash("sha256").update(stableStringify(normalized)).digest("hex");
}

export function validateTerminalReportEvidenceSnapshot(snapshot: TerminalReportEvidenceSnapshot): TerminalReportValidationResult {
  const issues: TerminalReportValidationIssue[] = [];
  if (snapshot.schemaVersion !== 1 || !snapshot.id.trim() || !snapshot.workspaceId.trim() || !snapshot.source.id.trim()) {
    issues.push(issue("terminal_report_schema_invalid", "snapshot", "Snapshot identity or schema version is invalid."));
  }
  if (!snapshot.objective.trim() || !isIsoTimestamp(snapshot.terminalAt) || !isIsoTimestamp(snapshot.generatedAt)) {
    issues.push(issue("terminal_report_schema_invalid", "snapshot", "Snapshot objective or timestamps are invalid."));
  }
  const expectedFingerprint = computeTerminalReportEvidenceFingerprint(snapshot);
  if (snapshot.evidenceFingerprint !== expectedFingerprint) {
    issues.push(issue("terminal_report_fingerprint_mismatch", "snapshot.evidenceFingerprint", "Snapshot fingerprint does not match its evidence body."));
  }
  validateUniqueIds(issues, "snapshot.steps", snapshot.steps.map((item) => item.id));
  validateUniqueIds(issues, "snapshot.operations", snapshot.operations.map((item) => item.id));
  validateUniqueIds(issues, "snapshot.checks", snapshot.checks.map((item) => item.id));
  validateUniqueIds(issues, "snapshot.participants", snapshot.participants.map((item) => item.agentId));
  validateUniqueIds(issues, "snapshot.artifacts", snapshot.artifacts.map((item) => item.id));
  validateUniqueIds(issues, "snapshot.approvals", snapshot.approvals.map((item) => item.id));
  validateUniqueIds(issues, "snapshot.risks", snapshot.risks.map((item) => item.id));
  validateNoVisibleSecretRefs(issues, snapshot.references, "snapshot.references");
  return { ok: issues.length === 0, issues };
}

export function validateTerminalReportContent(
  content: TerminalReportContent,
  snapshot: TerminalReportEvidenceSnapshot,
): TerminalReportValidationResult {
  const issues: TerminalReportValidationIssue[] = [];
  const availableRefs = collectAvailableSourceRefs(snapshot);
  if (!content.outcome.title.trim() || !content.outcome.summary.trim()) {
    issues.push(issue("terminal_report_schema_invalid", "outcome", "Outcome title and summary are required."));
  }
  if (!outcomeCompatible(snapshot.terminalState, content.outcome.status)) {
    issues.push(issue("terminal_report_outcome_mismatch", "outcome.status", `Outcome ${content.outcome.status} is incompatible with source state ${snapshot.terminalState}.`));
  }
  validateUniqueIds(issues, "changes", content.changes.map((item) => item.id));
  validateUniqueIds(issues, "verification", content.verification.map((item) => item.id));
  validateUniqueIds(issues, "participants", content.participants.map((item) => item.agentId));
  validateUniqueIds(issues, "artifacts", content.artifacts.map((item) => item.id));
  validateUniqueIds(issues, "risks", content.risks.map((item) => item.id));
  validateUniqueIds(issues, "corrections", content.outcome.corrections.map((item) => item.id));

  const allRefGroups: readonly (readonly [string, readonly TerminalReportSourceRef[]])[] = [
    ["outcome.sourceRefs", content.outcome.sourceRefs],
    ...content.outcome.corrections.map((item, index) => [`outcome.corrections.${index}.sourceRefs`, item.sourceRefs] as const),
    ...content.changes.map((item, index) => [`changes.${index}.sourceRefs`, item.sourceRefs] as const),
    ...content.verification.map((item, index) => [`verification.${index}.sourceRefs`, item.sourceRefs] as const),
    ...content.participants.map((item, index) => [`participants.${index}.sourceRefs`, item.sourceRefs] as const),
    ...content.artifacts.map((item, index) => [`artifacts.${index}.sourceRefs`, item.sourceRefs] as const),
    ...content.risks.map((item, index) => [`risks.${index}.sourceRefs`, item.sourceRefs] as const),
    ["references", content.references],
  ];
  for (const [path, refs] of allRefGroups) {
    validateRefsResolve(issues, refs, availableRefs, path);
    validateNoVisibleSecretRefs(issues, refs, path);
  }

  const checksById = new Map(snapshot.checks.map((check) => [check.id, check]));
  // A model cannot report checks withheld from its evidence projection. Use the
  // strongest Host policy, including aliases elsewhere in the snapshot, solely
  // for this presence requirement; status/ref validation still uses all facts.
  const hasVisibleChecks = snapshot.checks.some((check) => check.sourceRefs.every((ref) =>
    availableRefs.get(terminalReportSourceRefKey(ref))?.every((evidence) =>
      evidence.visibility !== "developer_only" && evidence.sensitivity !== "secret_adjacent"
    )
  ));
  if (snapshot.terminalState === "succeeded" && hasVisibleChecks && content.verification.length === 0) {
    issues.push(issue(
      "terminal_report_unverified_success_claim",
      "verification",
      "A successful evidence snapshot with model-visible checks must include verification rows.",
    ));
  }
  for (const [index, verification] of content.verification.entries()) {
    const matched = verification.sourceRefs.some((ref) => ref.kind === "check" && checksById.has(ref.id));
    if ((verification.status === "passed" || verification.status === "failed") && !matched) {
      issues.push(issue("terminal_report_unverified_success_claim", `verification.${index}`, "Passed or failed verification requires matching check evidence."));
    }
  }

  const changedPaths = collectEvidenceChangedPaths(snapshot);
  for (const [index, change] of content.changes.entries()) {
    for (const path of change.paths) {
      if (!changedPaths.has(path)) {
        issues.push(issue("terminal_report_changed_path_without_evidence", `changes.${index}.paths`, `Changed path is not present in evidence: ${path}`));
      }
    }
    if ((change.addedLines !== undefined || change.deletedLines !== undefined) && !change.sourceRefs.some((ref) => ref.kind === "artifact")) {
      issues.push(issue("terminal_report_changed_path_without_evidence", `changes.${index}`, "Line counts require artifact evidence."));
    }
  }

  const participants = new Set(snapshot.participants.map((participant) => participant.agentId));
  for (const [index, participant] of content.participants.entries()) {
    if (!participants.has(participant.agentId)) {
      issues.push(issue("terminal_report_participant_without_activity", `participants.${index}`, `Participant has no terminal activity evidence: ${participant.agentId}`));
    }
  }

  const artifactsById = new Map(snapshot.artifacts.map((artifact) => [artifact.id, artifact]));
  for (const [index, artifact] of content.artifacts.entries()) {
    const evidenceArtifact = artifactsById.get(artifact.id);
    if (!evidenceArtifact) {
      issues.push(issue("terminal_report_external_ref_unverified", `artifacts.${index}`, `Artifact is not present in evidence: ${artifact.id}`));
    } else {
      const artifactRefs = new Set(evidenceArtifact.sourceRefs.map(terminalReportSourceRefKey));
      for (const ref of artifact.sourceRefs) {
        if (!artifactRefs.has(terminalReportSourceRefKey(ref))) {
          issues.push(issue(
            "terminal_report_source_ref_missing",
            `artifacts.${index}.sourceRefs`,
            `Source ref is not bound to artifact evidence: ${terminalReportSourceRefKey(ref)}`,
          ));
        }
      }
    }
    if ((artifact.kind === "commit" || artifact.kind === "pull_request" || artifact.kind === "deployment") && !artifact.href) {
      issues.push(issue("terminal_report_external_ref_unverified", `artifacts.${index}.href`, `${artifact.kind} artifacts require a validated href.`));
    }
  }

  return { ok: issues.length === 0, issues };
}

export function validateTerminalReport(
  report: TerminalReport,
  snapshot: TerminalReportEvidenceSnapshot,
): TerminalReportValidationResult {
  const contentResult = validateTerminalReportContent(report, snapshot);
  const issues = [...contentResult.issues];
  if (report.schemaVersion !== 1 || report.evidenceSnapshotId !== snapshot.id) {
    issues.push(issue("terminal_report_schema_invalid", "report", "Report schema or snapshot id is invalid."));
  }
  if (report.evidenceFingerprint !== snapshot.evidenceFingerprint) {
    issues.push(issue("terminal_report_fingerprint_mismatch", "report.evidenceFingerprint", "Report fingerprint does not match the source snapshot."));
  }
  if (report.source.kind !== snapshot.source.kind || report.source.id !== snapshot.source.id) {
    issues.push(issue("terminal_report_schema_invalid", "report.source", "Report source does not match the evidence snapshot."));
  }
  return { ok: issues.length === 0, issues };
}

function collectAvailableSourceRefs(snapshot: TerminalReportEvidenceSnapshot): ReadonlyMap<string, readonly TerminalReportSourceRef[]> {
  const refs = [
    ...snapshot.references,
    ...snapshot.steps.flatMap((item) => item.sourceRefs),
    ...snapshot.operations.flatMap((item) => item.sourceRefs),
    ...snapshot.checks.flatMap((item) => item.sourceRefs),
    ...snapshot.participants.flatMap((item) => item.sourceRefs),
    ...snapshot.artifacts.flatMap((item) => item.sourceRefs),
    ...snapshot.approvals.flatMap((item) => item.sourceRefs),
    ...snapshot.risks.flatMap((item) => item.sourceRefs),
  ];
  const available = new Map<string, TerminalReportSourceRef[]>();
  for (const ref of refs) {
    const key = terminalReportSourceRefKey(ref);
    const group = available.get(key) ?? [];
    group.push(ref);
    available.set(key, group);
  }
  return available;
}

function collectEvidenceChangedPaths(snapshot: TerminalReportEvidenceSnapshot): ReadonlySet<string> {
  return new Set([
    ...snapshot.steps.flatMap((item) => item.changedPaths),
    ...snapshot.operations.flatMap((item) => item.changedPaths),
    ...snapshot.artifacts.flatMap((item) => item.changedPaths),
    ...snapshot.artifacts.map((item) => item.path).filter((path): path is string => Boolean(path)),
  ]);
}

function validateRefsResolve(
  issues: TerminalReportValidationIssue[],
  refs: readonly TerminalReportSourceRef[],
  availableRefs: ReadonlyMap<string, readonly TerminalReportSourceRef[]>,
  path: string,
): void {
  for (const ref of refs) {
    const evidenceRefs = availableRefs.get(terminalReportSourceRefKey(ref));
    if (!evidenceRefs) {
      issues.push(issue("terminal_report_source_ref_missing", path, `Source ref is not present in evidence: ${terminalReportSourceRefKey(ref)}`));
    } else if (evidenceRefs.some((evidence) =>
      REF_VISIBILITY[ref.visibility] < REF_VISIBILITY[evidence.visibility] ||
      REF_SENSITIVITY[ref.sensitivity ?? "normal"] < REF_SENSITIVITY[evidence.sensitivity ?? "normal"]
    )) {
      issues.push(issue("terminal_report_privacy_violation", path, "Report references cannot lower Host evidence privacy restrictions."));
    }
  }
}

const REF_VISIBILITY = { conversation: 0, folded_evidence: 1, developer_only: 2 } as const;
const REF_SENSITIVITY = { normal: 0, private: 1, secret_adjacent: 2 } as const;

function validateNoVisibleSecretRefs(
  issues: TerminalReportValidationIssue[],
  refs: readonly TerminalReportSourceRef[],
  path: string,
): void {
  if (refs.some((ref) => ref.sensitivity === "secret_adjacent" && ref.visibility === "conversation")) {
    issues.push(issue("terminal_report_privacy_violation", path, "Secret-adjacent evidence cannot be conversation-visible."));
  }
}

function validateUniqueIds(issues: TerminalReportValidationIssue[], path: string, ids: readonly string[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (!id.trim()) {
      issues.push(issue("terminal_report_schema_invalid", path, "Item ids must be non-empty."));
      continue;
    }
    if (seen.has(id)) {
      issues.push(issue("terminal_report_duplicate_item_id", path, `Duplicate item id: ${id}`));
    }
    seen.add(id);
  }
}

function outcomeCompatible(source: TerminalReportOutcomeStatus, report: TerminalReportOutcomeStatus): boolean {
  if (source === report) {
    return true;
  }
  return report === "partially_succeeded" && source !== "succeeded";
}

function issue(code: TerminalReportValidationCode, path: string, message: string): TerminalReportValidationIssue {
  return { code, path, message };
}

function isIsoTimestamp(value: string): boolean {
  return Boolean(value && Number.isFinite(Date.parse(value)));
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
