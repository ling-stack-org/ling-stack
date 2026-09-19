import type {
  ConversationArtifactStripItem,
  ConversationWorkCellEvidenceLink,
  ConversationWorkCellRow,
  ConversationWorkCellRowTone,
} from "./work-cell-view-model.js";

interface TerminalReportSourceRefInput {
  readonly kind: string;
  readonly id: string;
  readonly label?: string;
  readonly href?: string;
  readonly visibility: "conversation" | "folded_evidence" | "developer_only";
  readonly sensitivity?: "normal" | "private" | "secret_adjacent";
}

interface TerminalReportSectionInput {
  readonly sourceRefs: readonly TerminalReportSourceRefInput[];
}

type TerminalReportArtifactKindInput =
  | "file"
  | "diff"
  | "document"
  | "image"
  | "test_result"
  | "commit"
  | "pull_request"
  | "deployment"
  | "external"
  | "other";

export interface TerminalReportViewInput {
  readonly id: string;
  readonly status: "committed" | "fallback";
  readonly language: "zh-CN" | "en-US";
  readonly outcome: TerminalReportSectionInput & {
    readonly status: "succeeded" | "partially_succeeded" | "blocked" | "failed" | "cancelled";
    readonly title: string;
    readonly summary: string;
    readonly corrections: readonly (TerminalReportSectionInput & {
      readonly id: string;
      readonly originalAssumption: string;
      readonly correctedFact: string;
      readonly confidence: "high" | "medium";
    })[];
  };
  readonly changes: readonly (TerminalReportSectionInput & {
    readonly id: string;
    readonly title: string;
    readonly summary: string;
    readonly paths: readonly string[];
    readonly addedLines?: number;
    readonly deletedLines?: number;
  })[];
  readonly verification: readonly (TerminalReportSectionInput & {
    readonly id: string;
    readonly title: string;
    readonly status: "passed" | "failed" | "blocked" | "cancelled" | "skipped" | "not_run" | "unknown";
    readonly summary?: string;
    readonly command?: string;
    readonly durationMs?: number;
  })[];
  readonly participants: readonly (TerminalReportSectionInput & {
    readonly agentId: string;
    readonly displayName: string;
    readonly status: "completed" | "failed" | "blocked" | "cancelled";
    readonly contribution: string;
  })[];
  readonly artifacts: readonly (TerminalReportSectionInput & {
    readonly id: string;
    readonly kind: TerminalReportArtifactKindInput;
    readonly title: string;
    readonly path?: string;
    readonly href?: string;
    readonly addedLines?: number;
    readonly deletedLines?: number;
  })[];
  readonly risks: readonly (TerminalReportSectionInput & {
    readonly id: string;
    readonly severity: "info" | "warning" | "critical";
    readonly status: "unresolved" | "mitigated" | "accepted" | "unverified";
    readonly summary: string;
    readonly nextAction?: string;
  })[];
  readonly references: readonly TerminalReportSourceRefInput[];
  readonly evidenceFingerprint: string;
  readonly committedAt: string;
}

export interface TerminalReportViewModel {
  readonly reportId: string;
  readonly revisionKey: string;
  readonly rows: readonly ConversationWorkCellRow[];
  readonly evidenceLinks: readonly ConversationWorkCellEvidenceLink[];
  readonly artifactStripItems: readonly ConversationArtifactStripItem[];
  readonly updatedAt: string;
}

export function terminalReportToViewModel(report: TerminalReportViewInput): TerminalReportViewModel {
  const rawSections: readonly TerminalReportSectionInput[] = [
    report.outcome,
    ...report.outcome.corrections,
    ...report.changes,
    ...report.verification,
    ...report.participants,
    ...report.artifacts,
    ...report.risks,
  ];
  const allSourceRefs = [
    ...report.references,
    ...rawSections.flatMap((section) => section.sourceRefs),
  ];
  const changes = workspaceChanges(report.changes, allSourceRefs);
  const visibleArtifacts = report.artifacts.filter(isUserVisibleTerminalReportArtifact);
  const sections: readonly TerminalReportSectionInput[] = [
    report.outcome,
    ...report.outcome.corrections,
    ...changes,
    ...report.verification,
    ...report.participants,
    ...visibleArtifacts,
    ...report.risks,
  ];
  const sourceRefs = uniqueSourceRefs([
    ...report.references,
    ...sections.flatMap((section) => section.sourceRefs),
  ]);
  const changedPaths = [...new Set(changes.flatMap((change) => change.paths).filter(Boolean))];
  const visibleArtifactIds = new Set(visibleArtifacts.map((artifact) => artifact.id));
  const evidenceSourceRefs = sourceRefs.filter((ref) =>
    !(ref.kind === "artifact" && visibleArtifactIds.has(ref.id)) &&
    !(ref.kind === "file" && (changedPaths.includes(ref.id) || (ref.label ? changedPaths.includes(ref.label) : false))),
  );
  return {
    reportId: report.id,
    revisionKey: `${report.id}:${report.evidenceFingerprint}`,
    rows: [
      {
        id: `${report.id}:outcome`,
        kind: "watch",
        presentation: "note",
        reportSection: "outcome",
        title: report.outcome.title,
        description: report.outcome.summary,
        tone: outcomeTone(report.outcome.status),
      },
      ...report.outcome.corrections.map((correction) => ({
        id: `${report.id}:correction:${correction.id}`,
        kind: "watch" as const,
        presentation: "note" as const,
        reportSection: "correction" as const,
        title: correction.correctedFact,
        description: correction.originalAssumption,
        meta: localizedMeta(report.language, correction.confidence),
        tone: "neutral" as const,
      })),
      ...changes.map((change) => ({
        id: `${report.id}:change:${change.id}`,
        kind: "edit" as const,
        reportSection: "change" as const,
        title: change.title,
        description: change.summary,
        meta: changeMeta(change, report.language),
        detailLines: change.paths.map((path) => ({ kind: "file_ref" as const, text: path, path })),
        tone: "success" as const,
      })),
      ...report.verification.map((verification) => ({
        id: `${report.id}:verification:${verification.id}`,
        kind: "verify" as const,
        reportSection: "verification" as const,
        title: verification.title,
        description: verification.summary,
        meta: verificationMeta(verification.status, verification.durationMs, report.language),
        commandText: verification.command,
        tone: verificationTone(verification.status),
      })),
      ...report.participants.map((participant) => ({
        id: `${report.id}:participant:${participant.agentId}`,
        kind: "handoff" as const,
        reportSection: "participant" as const,
        participantId: participant.agentId,
        title: participant.displayName,
        description: participant.contribution,
        meta: localizedMeta(report.language, participant.status),
        tone: participantTone(participant.status),
      })),
      ...report.risks.map((risk) => ({
        id: `${report.id}:risk:${risk.id}`,
        kind: "watch" as const,
        reportSection: "risk" as const,
        title: risk.summary,
        description: risk.nextAction,
        meta: localizedMeta(report.language, risk.status),
        tone: riskTone(risk.severity, risk.status),
      })),
    ],
    evidenceLinks: evidenceSourceRefs.map((ref) => ({
      id: `${report.id}:ref:${ref.kind}:${ref.id}`,
      label: ref.label || ref.id,
      meta: ref.kind,
      href: ref.href,
      artifactId: ref.kind === "artifact" ? ref.id : undefined,
      previewable: ref.kind === "artifact" || ref.kind === "file",
      previewKind: ref.kind === "file" ? "file" : undefined,
    })),
    artifactStripItems: [
      ...(changedPaths.length > 0 ? [{
        id: `${report.id}:changed`,
        kind: "changed" as const,
        label: localizedChangedFilesLabel(report.language, changedPaths.length),
        changeArtifacts: changedPaths.map((path) => ({
          id: `${report.id}:changed:${path}`,
          label: path,
          path,
          previewable: false,
        })),
        tone: "neutral" as const,
      }] : []),
      ...visibleArtifacts.map((artifact) => {
        const workspaceFilePath = terminalReportArtifactWorkspacePath(artifact, changedPaths);
        return {
          id: `${report.id}:artifact:${artifact.id}`,
          kind: "artifact" as const,
          label: artifact.title || artifact.path || artifact.id,
          path: artifact.path,
          ...(workspaceFilePath ? { workspaceFilePath } : {}),
          href: artifact.href,
          artifactId: artifact.id,
          previewable: Boolean(artifact.path || artifact.href),
          previewKind: "file" as const,
        };
      }),
    ],
    updatedAt: report.committedAt,
  };
}

function workspaceChanges(
  changes: TerminalReportViewInput["changes"],
  sourceRefs: readonly TerminalReportSourceRefInput[],
): TerminalReportViewInput["changes"] {
  const artifactStoragePrefixes = sourceRefs
    .filter((ref) => ref.kind === "run")
    .map((ref) => `${ref.id}/`);
  if (artifactStoragePrefixes.length === 0) {
    return changes;
  }
  return changes.flatMap((change) => {
    const paths = change.paths.filter((path) => !artifactStoragePrefixes.some((prefix) => path.startsWith(prefix)));
    return paths.length > 0 ? [{ ...change, paths }] : [];
  });
}

const WORKSPACE_FILE_ARTIFACT_KINDS = new Set<TerminalReportArtifactKindInput>([
  "file",
  "diff",
  "document",
  "image",
  "test_result",
]);

function terminalReportArtifactWorkspacePath(
  artifact: TerminalReportViewInput["artifacts"][number],
  changedPaths: readonly string[],
): string | undefined {
  if (!WORKSPACE_FILE_ARTIFACT_KINDS.has(artifact.kind) || changedPaths.length === 0) {
    return undefined;
  }
  const changedPathByNormalizedPath = new Map(
    changedPaths.map((path) => [normalizedConversationFilePath(path), path] as const),
  );
  const trustedWorkspacePaths = [...new Map(
    artifact.sourceRefs
      .filter((ref) => ref.kind === "file" && isUserVisibleTerminalReportSourceRef(ref))
      .map((ref) => {
        const normalizedPath = normalizedConversationFilePath(ref.id);
        const changedPath = changedPathByNormalizedPath.get(normalizedPath);
        return changedPath ? [normalizedPath, changedPath] as const : undefined;
      })
      .filter((entry): entry is readonly [string, string] => Boolean(entry)),
  ).values()];
  return trustedWorkspacePaths.length === 1 ? trustedWorkspacePaths[0] : undefined;
}

function normalizedConversationFilePath(value?: string): string {
  return value?.trim().replace(/\\/gu, "/").replace(/^\.\//u, "") ?? "";
}

function localizedChangedFilesLabel(language: TerminalReportViewInput["language"], count: number): string {
  if (language === "zh-CN") {
    return count === 1 ? "已编辑 1 个文件" : `已编辑 ${count} 个文件`;
  }
  return count === 1 ? "Edited 1 file" : `Edited ${count} files`;
}

function uniqueSourceRefs(refs: readonly TerminalReportSourceRefInput[]): TerminalReportSourceRefInput[] {
  const visible = refs.filter(isUserVisibleTerminalReportSourceRef);
  return [...new Map(visible.map((ref) => [`${ref.kind}:${ref.id}`, ref])).values()];
}

const INTERNAL_TERMINAL_REPORT_REFERENCE_KINDS = new Set([
  "approval",
  "check",
  "message",
  "operation",
  "run",
  "task",
  "turn",
  "workflow",
  "workflow_step",
]);

function isUserVisibleTerminalReportSourceRef(ref: TerminalReportSourceRefInput): boolean {
  if (ref.visibility === "developer_only" || ref.sensitivity === "secret_adjacent") {
    return false;
  }
  if (INTERNAL_TERMINAL_REPORT_REFERENCE_KINDS.has(ref.kind)) {
    return false;
  }
  if (isInternalTerminalReportArtifactText(ref.label ?? "")) {
    return false;
  }
  if (ref.kind === "external") {
    return Boolean(ref.href);
  }
  return ref.kind === "artifact" || ref.kind === "file" || ref.kind === "memory" || Boolean(ref.href);
}

function isUserVisibleTerminalReportArtifact(artifact: TerminalReportViewInput["artifacts"][number]): boolean {
  return !isInternalTerminalReportArtifactText([artifact.title, artifact.path].filter(Boolean).join(" "));
}

function isInternalTerminalReportArtifactText(value: string): boolean {
  return /^(Generated file metadata|Workflow step context|Workflow step output|Action preview):/iu.test(value.trim()) ||
    /\bcontent log\b/iu.test(value);
}

function outcomeTone(status: TerminalReportViewInput["outcome"]["status"]): ConversationWorkCellRowTone {
  if (status === "succeeded") return "success";
  if (status === "failed" || status === "blocked") return "failed";
  if (status === "partially_succeeded") return "waiting";
  return "neutral";
}

function verificationTone(status: TerminalReportViewInput["verification"][number]["status"]): ConversationWorkCellRowTone {
  if (status === "passed") return "success";
  if (status === "failed" || status === "blocked") return "failed";
  if (status === "unknown" || status === "not_run") return "waiting";
  return "neutral";
}

function participantTone(status: TerminalReportViewInput["participants"][number]["status"]): ConversationWorkCellRowTone {
  if (status === "completed") return "success";
  if (status === "failed" || status === "blocked") return "failed";
  return "neutral";
}

function riskTone(
  severity: TerminalReportViewInput["risks"][number]["severity"],
  status: TerminalReportViewInput["risks"][number]["status"],
): ConversationWorkCellRowTone {
  if (status === "mitigated" || status === "accepted") return "neutral";
  return severity === "critical" ? "failed" : "waiting";
}

function changeMeta(
  change: TerminalReportViewInput["changes"][number],
  language: TerminalReportViewInput["language"],
): string | undefined {
  const stats = [
    change.paths.length > 0
      ? language === "zh-CN" ? `${change.paths.length} 个文件` : `${change.paths.length} ${change.paths.length === 1 ? "file" : "files"}`
      : undefined,
    change.addedLines !== undefined ? `+${change.addedLines}` : undefined,
    change.deletedLines !== undefined ? `-${change.deletedLines}` : undefined,
  ].filter((item): item is string => Boolean(item));
  return stats.length > 0 ? stats.join(" ") : undefined;
}

function verificationMeta(
  status: TerminalReportViewInput["verification"][number]["status"],
  durationMs: number | undefined,
  language: TerminalReportViewInput["language"],
): string {
  const label = localizedMeta(language, status);
  if (!durationMs || durationMs < 1000) return label;
  return `${label} · ${Math.round(durationMs / 1000)}s`;
}

function localizedMeta(language: TerminalReportViewInput["language"], value: string): string {
  if (language !== "zh-CN") return value;
  return ZH_CN_META[value] ?? value;
}

const ZH_CN_META: Readonly<Record<string, string>> = {
  high: "高置信度",
  medium: "中等置信度",
  passed: "已通过",
  failed: "失败",
  blocked: "已阻塞",
  cancelled: "已取消",
  skipped: "已跳过",
  not_run: "未运行",
  unknown: "未知",
  completed: "已完成",
  unresolved: "未解决",
  mitigated: "已缓解",
  accepted: "已接受",
  unverified: "未验证",
};
