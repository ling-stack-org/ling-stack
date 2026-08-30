import type {
  TerminalReport,
  TerminalReportArtifact,
  TerminalReportChange,
  TerminalReportContent,
  TerminalReportEvidenceSnapshot,
  TerminalReportParticipant,
  TerminalReportRisk,
  TerminalReportSourceRef,
  TerminalReportVerification,
} from "./terminal-report-types.js";
import { createTerminalReportId } from "./terminal-report-types.js";
import { formatSynchronousCatalogMessage } from "@ling-stack/localization";

export interface BuildDeterministicTerminalReportInput {
  readonly id?: string;
  readonly promptVersion?: string;
  readonly validationCodes?: readonly string[];
  readonly createdAt?: string;
  readonly committedAt?: string;
}

export function buildDeterministicTerminalReport(
  snapshot: TerminalReportEvidenceSnapshot,
  input: BuildDeterministicTerminalReportInput = {},
): TerminalReport {
  const committedAt = input.committedAt ?? snapshot.generatedAt;
  return {
    schemaVersion: 1,
    id: input.id ?? createTerminalReportId(),
    workspaceId: snapshot.workspaceId,
    channelId: snapshot.channelId,
    threadId: snapshot.threadId,
    turnId: snapshot.turnId,
    sourceMessageId: snapshot.sourceMessageId,
    source: snapshot.source,
    status: "fallback",
    language: snapshot.language,
    evidenceSnapshotId: snapshot.id,
    evidenceFingerprint: snapshot.evidenceFingerprint,
    synthesis: {
      mode: "deterministic_fallback",
      promptVersion: input.promptVersion ?? "terminal-report-fallback-v1",
      attemptCount: 0,
      validationCodes: input.validationCodes ?? [],
    },
    ...buildDeterministicTerminalReportContent(snapshot),
    createdAt: input.createdAt ?? snapshot.generatedAt,
    committedAt,
  };
}

export function buildDeterministicTerminalReportContent(snapshot: TerminalReportEvidenceSnapshot): TerminalReportContent {
  const references = uniqueRefs([
    ...snapshot.references,
    ...snapshot.steps.flatMap((item) => item.sourceRefs),
    ...snapshot.operations.flatMap((item) => item.sourceRefs),
    ...snapshot.checks.flatMap((item) => item.sourceRefs),
    ...snapshot.participants.flatMap((item) => item.sourceRefs),
    ...snapshot.artifacts.flatMap((item) => item.sourceRefs),
    ...snapshot.risks.flatMap((item) => item.sourceRefs),
  ]);
  return {
    outcome: {
      status: snapshot.terminalState,
      title: fallbackOutcomeTitle(snapshot),
      summary: fallbackOutcomeSummary(snapshot),
      corrections: [],
      sourceRefs: sourceIdentityRefs(snapshot, references),
    },
    changes: fallbackChanges(snapshot),
    verification: snapshot.checks.map((check): TerminalReportVerification => ({
      id: check.id,
      title: check.title,
      status: check.status,
      summary: check.summary,
      command: check.command,
      durationMs: check.durationMs,
      sourceRefs: check.sourceRefs,
    })),
    participants: snapshot.participants.map((participant): TerminalReportParticipant => ({
      agentId: participant.agentId,
      displayName: participant.displayName,
      roleKey: participant.roleKey,
      status: participant.status,
      contribution: participant.contributionSummaries.filter(Boolean).join("; ") || fallbackParticipantContribution(participant.displayName, snapshot.language),
      sourceRefs: participant.sourceRefs,
    })),
    artifacts: snapshot.artifacts.filter(isConversationVisibleArtifact).map((artifact): TerminalReportArtifact => ({
      id: artifact.id,
      kind: artifact.kind,
      title: artifact.title,
      path: artifact.path,
      href: artifact.href,
      addedLines: artifact.addedLines,
      deletedLines: artifact.deletedLines,
      sourceRefs: artifact.sourceRefs,
    })),
    risks: fallbackRisks(snapshot),
    references,
  };
}

/**
 * Keep protocol wrappers and pasted harness instructions out of the visible
 * result title. The complete objective remains in the evidence snapshot.
 */
function fallbackOutcomeTitle(snapshot: TerminalReportEvidenceSnapshot): string {
  const normalized = snapshot.objective.replace(/\s+/gu, " ").trim();
  const wrapped = normalized.match(
    /(?:原始请求|Original request):\s*(.+?)(?=\s+(?:Requested objective\b|No literal file content\b|已物化的执行操作\b|参与者操作归属\b|Permission boundary\b)|$)/iu,
  )?.[1]?.trim();
  const candidate = (wrapped || normalized).replace(/^\*+|\*+$/gu, "").trim();
  const maxLength = 120;
  return candidate.length > maxLength ? `${candidate.slice(0, maxLength - 1).trimEnd()}…` : candidate;
}

function isConversationVisibleArtifact(artifact: TerminalReportEvidenceSnapshot["artifacts"][number]): boolean {
  return artifact.sourceRefs.some((ref) =>
    ref.kind === "artifact" &&
    ref.id === artifact.id &&
    ref.visibility !== "developer_only" &&
    ref.sensitivity !== "secret_adjacent",
  );
}

function fallbackOutcomeSummary(snapshot: TerminalReportEvidenceSnapshot): string {
  const completed = snapshot.steps.filter((step) => step.status === "succeeded").length;
  const total = snapshot.steps.length;
  const suffix = total > 1
    ? formatSynchronousCatalogMessage(snapshot.language, "terminal_report.outcome.steps", { completed, total })
    : "";
  const lead = formatSynchronousCatalogMessage(
    snapshot.language,
    `terminal_report.outcome.${snapshot.terminalState}`,
  );
  return [lead, suffix].filter(Boolean).join(" ");
}

function fallbackChanges(snapshot: TerminalReportEvidenceSnapshot): TerminalReportChange[] {
  const artifactsByPath = new Map<string, typeof snapshot.artifacts[number]>();
  for (const artifact of snapshot.artifacts) {
    for (const path of artifact.changedPaths) {
      artifactsByPath.set(path, artifact);
    }
  }
  const paths = new Set([
    ...snapshot.steps.flatMap((step) => step.changedPaths),
    ...snapshot.operations.filter((operation) => operation.kind === "edit").flatMap((operation) => operation.changedPaths),
    ...snapshot.artifacts.flatMap((artifact) => artifact.changedPaths),
  ]);
  return [...paths].sort().map((path, index): TerminalReportChange => {
    const artifact = artifactsByPath.get(path);
    return {
      id: `change:${index}:${path}`,
      kind: inferChangeKind(path),
      title: path,
      summary: formatSynchronousCatalogMessage(snapshot.language, "terminal_report.change.updated", { path }),
      paths: [path],
      addedLines: artifact?.addedLines,
      deletedLines: artifact?.deletedLines,
      sourceRefs: artifact?.sourceRefs ?? sourceRefsForChangedPath(snapshot, path),
    };
  });
}

function fallbackRisks(snapshot: TerminalReportEvidenceSnapshot): TerminalReportRisk[] {
  const risks = snapshot.risks.map((risk): TerminalReportRisk => ({ ...risk }));
  const existing = new Set(risks.map((risk) => risk.id));
  for (const check of snapshot.checks) {
    if ((check.status === "not_run" || check.status === "unknown") && !existing.has(`check-risk:${check.id}`)) {
      risks.push({
        id: `check-risk:${check.id}`,
        severity: "warning",
        status: "unverified",
        summary: check.summary ?? formatSynchronousCatalogMessage(
          snapshot.language,
          "terminal_report.risk.check_unverified",
          { title: check.title },
        ),
        sourceRefs: check.sourceRefs,
      });
    }
  }
  return risks;
}

function sourceIdentityRefs(snapshot: TerminalReportEvidenceSnapshot, refs: readonly TerminalReportSourceRef[]): TerminalReportSourceRef[] {
  const sourceRef = refs.find((ref) => ref.kind === snapshot.source.kind && ref.id === snapshot.source.id);
  return sourceRef ? [sourceRef] : refs.slice(0, 3);
}

function sourceRefsForChangedPath(snapshot: TerminalReportEvidenceSnapshot, path: string): TerminalReportSourceRef[] {
  return uniqueRefs([
    ...snapshot.steps.filter((item) => item.changedPaths.includes(path)).flatMap((item) => item.sourceRefs),
    ...snapshot.operations.filter((item) => item.changedPaths.includes(path)).flatMap((item) => item.sourceRefs),
  ]);
}

function fallbackParticipantContribution(displayName: string, language: TerminalReportEvidenceSnapshot["language"]): string {
  return formatSynchronousCatalogMessage(language, "terminal_report.participant.completed", { displayName });
}

function inferChangeKind(path: string): TerminalReportChange["kind"] {
  const lower = path.toLowerCase();
  if (lower.endsWith(".md") || lower.includes("/docs/")) {
    return "documentation";
  }
  if (/\.(json|ya?ml|toml|ini|env)$/u.test(lower)) {
    return "configuration";
  }
  return "code";
}

function uniqueRefs(refs: readonly TerminalReportSourceRef[]): TerminalReportSourceRef[] {
  const result: TerminalReportSourceRef[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const key = `${ref.kind}:${ref.id}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(ref);
    }
  }
  return result;
}
