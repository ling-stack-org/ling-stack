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
      title: snapshot.objective,
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
    ? snapshot.language === "zh-CN" ? `完成 ${completed}/${total} 个步骤。` : `Completed ${completed}/${total} steps.`
    : "";
  if (snapshot.language === "zh-CN") {
    const lead = snapshot.terminalState === "succeeded" ? "任务已完成。"
      : snapshot.terminalState === "partially_succeeded" ? "任务已部分完成。"
        : snapshot.terminalState === "blocked" ? "任务当前受阻。"
          : snapshot.terminalState === "cancelled" ? "任务已取消。"
            : "任务执行失败。";
    return [lead, suffix].filter(Boolean).join(" ");
  }
  const lead = snapshot.terminalState === "succeeded" ? "The task completed."
    : snapshot.terminalState === "partially_succeeded" ? "The task partially completed."
      : snapshot.terminalState === "blocked" ? "The task is blocked."
        : snapshot.terminalState === "cancelled" ? "The task was cancelled."
          : "The task failed.";
  return [lead, suffix].filter(Boolean).join(" ");
}

function fallbackChanges(snapshot: TerminalReportEvidenceSnapshot): TerminalReportChange[] {
  const artifactsByPath = new Map<string, typeof snapshot.artifacts[number]>();
  for (const artifact of snapshot.artifacts) {
    if (artifact.path) {
      artifactsByPath.set(artifact.path, artifact);
    }
    for (const path of artifact.changedPaths) {
      artifactsByPath.set(path, artifact);
    }
  }
  const paths = new Set([
    ...snapshot.steps.flatMap((step) => step.changedPaths),
    ...snapshot.operations.filter((operation) => operation.kind === "edit").flatMap((operation) => operation.changedPaths),
    ...snapshot.artifacts.flatMap((artifact) => artifact.changedPaths),
    ...snapshot.artifacts.map((artifact) => artifact.path).filter((path): path is string => Boolean(path)),
  ]);
  return [...paths].sort().map((path, index): TerminalReportChange => {
    const artifact = artifactsByPath.get(path);
    return {
      id: `change:${index}:${path}`,
      kind: inferChangeKind(path),
      title: path,
      summary: snapshot.language === "zh-CN" ? `已更新 ${path}` : `Updated ${path}`,
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
        summary: check.summary ?? (snapshot.language === "zh-CN" ? `${check.title} 未完成验证。` : `${check.title} was not verified.`),
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
  return language === "zh-CN" ? `${displayName} 完成了分配的工作。` : `${displayName} completed the assigned work.`;
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
