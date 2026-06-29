import type {
  DockReviewChangeStats,
  DockEvidenceGroupView,
  DockEvidenceItem,
  DockFileItem,
  DockReviewCodeLine,
  DockReviewItem,
  DockReviewStatus,
  DockSeverity,
} from "../../../shared/conversation/index.js";
import { effectiveApprovalStatus } from "../../../lib/approvals.js";
import { formatDateTime } from "../../../lib/formatting.js";
import type { Translate } from "../../../i18n.js";
import type {
  ApprovalRequest,
  ChannelAttachment,
  ChannelMessageFileRef,
  MessageWebEvidence,
  RunArtifact,
  RunSession,
} from "../../../types.js";

export interface RightDockMessageProjectionInput {
  readonly id: string;
  readonly title: string;
  readonly body?: string;
  readonly status?: "pending" | "ready" | "blocked" | "failed" | "cancelled" | "running";
  readonly errorMessage?: string;
  readonly runId?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly webEvidence?: MessageWebEvidence;
  readonly fileRefs?: readonly ChannelMessageFileRef[];
}

export interface RightDockAttachmentProjectionInput {
  readonly id: string;
  readonly fileName: string;
  readonly path?: string;
  readonly sizeBytes: number;
  readonly createdAt?: string;
}

export function projectApprovalsToReviewItems(
  approvals: readonly ApprovalRequest[],
  t: Translate,
): readonly DockReviewItem[] {
  return approvals
    .filter((approval) => effectiveApprovalStatus(approval) !== "approved")
    .map((approval) => {
      const status = approvalStatusToReviewStatus(effectiveApprovalStatus(approval));
      const codePreview = approvalCodePreview(approval, t);
      return {
        id: `approval:${approval.id}`,
        group: "action_required",
        severity: approvalRiskToSeverity(approval.risk),
        status,
        kind: "approval_gate",
        title: approval.title || t("Approval required"),
        reason: approval.description || approval.actionType,
        pathLabel: codePreview?.pathLabel,
        sourceLabel: t("Approval gate"),
        actionLabel: status === "pending" ? t("Resolve approval") : t("Blocked"),
        timestampLabel: formatMaybeDate(approval.createdAt),
        stats: codePreview?.stats,
        facts: [
          { label: t("Risk"), value: t(approval.risk), tone: approvalRiskToSeverity(approval.risk) },
          { label: t("Action"), value: t(approval.actionType) },
          { label: t("Status"), value: t(effectiveApprovalStatus(approval)) },
        ],
        codePreview,
      };
    });
}

export function projectRunsToReviewItems(
  runs: readonly RunSession[],
  t: Translate,
): readonly DockReviewItem[] {
  const items: DockReviewItem[] = [];
  for (const run of runs) {
    if (run.status === "waiting_for_approval") {
      items.push({
        id: `run-approval:${run.id}`,
        group: "action_required",
        severity: "warning",
        status: "pending",
      kind: "approval_gate",
      title: t("Run is waiting for approval"),
      reason: run.providerModel || run.providerName,
        sourceLabel: t("Runtime gate"),
        actionLabel: t("Inspect"),
        timestampLabel: formatMaybeDate(run.updatedAt),
        facts: [
          { label: t("Run"), value: run.id },
          { label: t("Status"), value: t(run.status), tone: "warning" },
        ],
      });
      continue;
    }
    if (run.status === "failed") {
      items.push({
        id: `run-failed:${run.id}`,
        group: "runtime",
        severity: "danger",
        status: "failed",
      kind: "runtime_issue",
      title: t("Run failed"),
      reason: run.errorMessage || run.providerModel || run.id,
        sourceLabel: t("Runtime"),
        actionLabel: t("Inspect"),
        timestampLabel: formatMaybeDate(run.updatedAt),
        facts: [
          { label: t("Run"), value: run.id },
          { label: t("Status"), value: t(run.status), tone: "danger" },
        ],
      });
      continue;
    }
    if (run.status === "cancelled") {
      items.push({
        id: `run-cancelled:${run.id}`,
        group: "runtime",
        severity: "warning",
        status: "blocked",
      kind: "runtime_issue",
      title: t("Run was cancelled"),
      reason: run.errorMessage || run.providerModel || run.id,
        sourceLabel: t("Runtime"),
        actionLabel: t("Inspect"),
        timestampLabel: formatMaybeDate(run.updatedAt),
        facts: [
          { label: t("Run"), value: run.id },
          { label: t("Status"), value: t(run.status), tone: "warning" },
        ],
      });
    }
  }
  return items;
}

export function projectMessagesToReviewItems(
  messages: readonly RightDockMessageProjectionInput[],
  t: Translate,
): readonly DockReviewItem[] {
  const items: DockReviewItem[] = [];
  for (const message of messages) {
    if (message.status !== "blocked" && message.status !== "failed" && message.status !== "cancelled") {
      continue;
    }
    const failed = message.status === "failed";
    items.push({
      id: `message:${message.id}`,
      group: failed ? "runtime" : "evidence",
      severity: failed ? "danger" : "warning",
      status: failed ? "failed" : "blocked",
      kind: failed ? "runtime_issue" : "evidence_gap",
      title: message.title,
      reason: message.errorMessage || truncateText(message.body || t("Message needs attention"), 120),
      sourceLabel: t("Message"),
      actionLabel: t("Inspect"),
      timestampLabel: formatMaybeDate(message.updatedAt ?? message.createdAt),
      facts: [
        { label: t("Message"), value: message.id },
        { label: t("Status"), value: message.status ?? t("unknown"), tone: failed ? "danger" : "warning" },
      ],
    });
  }
  return items;
}

export function projectFilesToReviewItems(
  fileItems: readonly DockFileItem[],
  t: Translate,
): readonly DockReviewItem[] {
  return fileItems
    .filter((item) => item.kind === "change")
    .slice(0, 20)
    .map((item) => ({
      id: `file-review:${item.id}`,
      group: "files",
      kind: "code_change",
      severity: "info",
      status: "pending",
      title: item.name || t("Changed file"),
      reason: item.pathLabel || t("File change needs review"),
      pathLabel: item.pathLabel,
      sourceLabel: t("File change"),
      actionLabel: t("Changes"),
      artifactRef: artifactRefFromFileItem(item),
      facts: [
        { label: t("Type"), value: t(item.kind) },
        { label: t("Status"), value: item.status ? t(item.status) : t("unknown") },
      ],
    }));
}

export function projectRunsToEvidenceGroup(
  runs: readonly RunSession[],
  t: Translate,
): DockEvidenceGroupView {
  return {
    id: "run",
    label: t("Runs"),
    items: runs.slice(0, 20).map((run) => ({
      id: `run:${run.id}`,
      kind: "run",
      title: run.providerModel || run.providerName || t("Run"),
      summary: run.errorMessage || runStatusLabel(run.status, t),
      status: run.status === "failed" ? "failed" : run.status === "running" || run.status === "queued" || run.status === "waiting_for_approval" ? "loading" : "available",
      sourceLabel: runStatusLabel(run.status, t),
      timestampLabel: formatMaybeDate(run.updatedAt),
    })),
  };
}

export function projectApprovalsToEvidenceGroup(
  approvals: readonly ApprovalRequest[],
  t: Translate,
): DockEvidenceGroupView {
  return {
    id: "approval",
    label: t("Approvals"),
    items: approvals.slice(0, 20).map((approval) => ({
      id: `approval:${approval.id}`,
      kind: "approval",
      title: approval.title || t("Approval"),
      summary: approval.description,
      status: effectiveApprovalStatus(approval) === "pending" ? "loading" : "available",
      sourceLabel: approval.actionType,
      timestampLabel: formatMaybeDate(approval.createdAt),
    })),
  };
}

export function projectWebEvidenceToEvidenceGroup(
  messages: readonly RightDockMessageProjectionInput[],
  t: Translate,
): DockEvidenceGroupView {
  const items: DockEvidenceItem[] = [];
  for (const message of messages) {
    const evidence = message.webEvidence;
    if (!evidence || (evidence.sources.length === 0 && evidence.readUrls.length === 0)) {
      continue;
    }
    const queryLabel = evidence.queries?.[0] ?? evidence.query ?? message.title;
    evidence.sources.forEach((source, index) => {
      items.push({
        id: `web-source:${message.id}:${index}`,
        kind: "browser",
        title: source.title || source.url,
        summary: source.snippet || queryLabel,
        status: evidence.status === "blocked" ? "failed" : "available",
        sourceLabel: t("Web source"),
        timestampLabel: formatMaybeDate(evidence.updatedAt),
      });
    });
    evidence.readUrls.forEach((readUrl, index) => {
      items.push({
        id: `web-read:${message.id}:${index}`,
        kind: "browser",
        title: readUrl.title || readUrl.finalUrl || readUrl.url,
        summary: readUrl.reason || queryLabel,
        status: readUrl.status === "blocked" ? "failed" : "available",
        sourceLabel: t("Read URL"),
        timestampLabel: formatMaybeDate(evidence.updatedAt),
      });
    });
  }
  return {
    id: "browser",
    label: t("Browser evidence"),
    items,
  };
}

export function projectFilesToEvidenceGroup(
  fileItems: readonly DockFileItem[],
  t: Translate,
): DockEvidenceGroupView {
  return {
    id: "file",
    label: t("Files"),
    items: fileItems.slice(0, 20).map((item) => ({
      id: `file-evidence:${item.id}`,
      kind: "file",
      title: item.name,
      summary: item.pathLabel,
      status: item.status === "missing" ? "failed" : "available",
      sourceLabel: fileKindLabel(item.kind, t),
    })),
  };
}

export function projectAttachmentsToFileItems(
  attachments: readonly RightDockAttachmentProjectionInput[],
  t: Translate,
): readonly DockFileItem[] {
  return attachments.map((attachment) => ({
    id: `attachment:${attachment.id}`,
    name: attachment.fileName,
    pathLabel: attachment.path || formatBytes(attachment.sizeBytes, t),
    kind: "attachment",
    status: "available",
  }));
}

export function projectChannelAttachmentsToFileItems(
  attachments: readonly ChannelAttachment[],
  t: Translate,
): readonly DockFileItem[] {
  return projectAttachmentsToFileItems(attachments, t);
}

export function projectFileRefsToFileItems(
  refs: readonly ChannelMessageFileRef[],
): readonly DockFileItem[] {
  const seen = new Set<string>();
  const items: DockFileItem[] = [];
  for (const ref of refs) {
    const key = `${ref.path}:${ref.line ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    items.push({
      id: `ref:${key}`,
      name: ref.label || fileNameFromPath(ref.path),
      pathLabel: ref.line ? `${ref.path}:${ref.line}` : ref.path,
      kind: "reference",
      status: "available",
    });
  }
  return items;
}

export function projectArtifactsToFileItems(
  artifactsByRun: Readonly<Record<string, readonly RunArtifact[]>> | readonly RunArtifact[],
): readonly DockFileItem[] {
  const artifacts = Array.isArray(artifactsByRun)
    ? artifactsByRun
    : Object.values(artifactsByRun).flat();
  return artifacts.map((artifact) => ({
    id: `artifact:${artifact.id}`,
    name: artifact.title || fileNameFromPath(artifact.path),
    pathLabel: artifact.path,
    kind: artifact.type === "diff" ? "change" : "artifact",
    status: artifact.type === "diff" ? "changed" : "generated",
  }));
}

export function mergeDockFileItems(...groups: readonly (readonly DockFileItem[])[]): readonly DockFileItem[] {
  const seen = new Set<string>();
  const items: DockFileItem[] = [];
  for (const group of groups) {
    for (const item of group) {
      if (seen.has(item.id)) {
        continue;
      }
      seen.add(item.id);
      items.push(item);
    }
  }
  return items;
}

export function mergeEvidenceGroups(...groups: readonly DockEvidenceGroupView[]): readonly DockEvidenceGroupView[] {
  return groups.filter((group) => group.items.length > 0);
}

export function reviewNeedsAction(item: DockReviewItem): boolean {
  return item.status === "pending" || item.status === "blocked" || item.status === "failed";
}

export function runStatusLabel(status: RunSession["status"], t: Translate): string {
  switch (status) {
    case "queued":
      return t("Queued");
    case "running":
      return t("Running");
    case "waiting_for_approval":
      return t("Waiting for approval");
    case "succeeded":
      return t("Succeeded");
    case "failed":
      return t("Failed");
    case "cancelled":
      return t("Cancelled");
  }
}

function approvalRiskToSeverity(risk: ApprovalRequest["risk"]): Exclude<DockSeverity, "neutral"> {
  if (risk === "critical" || risk === "high") {
    return "danger";
  }
  if (risk === "medium") {
    return "warning";
  }
  return "info";
}

function approvalStatusToReviewStatus(status: ApprovalRequest["status"]): DockReviewStatus {
  switch (status) {
    case "pending":
      return "pending";
    case "approved":
      return "passed";
    case "denied":
    case "expired":
    case "cancelled":
      return "blocked";
  }
}

function approvalCodePreview(approval: ApprovalRequest, t: Translate): DockReviewItem["codePreview"] {
  const payload = asRecord(approval.payload);
  if (!payload) {
    return undefined;
  }
  const diffPreview = readString(payload, "diffPreview") ?? readString(payload, "diff") ?? readString(payload, "patch");
  if (diffPreview) {
    const lines = diffPreviewToLines(diffPreview);
    return {
      title: fileNameFromPath(readString(payload, "path") ?? readString(payload, "filePath") ?? approval.title ?? t("Payload preview")),
      language: "diff",
      pathLabel: readString(payload, "path") ?? readString(payload, "filePath"),
      lines: lines.slice(0, 80),
      stats: codeLineStats(lines),
      truncated: lines.length > 80,
    };
  }

  const command = readString(payload, "command") ?? readString(payload, "cmd");
  if (command) {
    const cwd = readString(payload, "cwd");
    return {
      title: t("Command preview"),
      language: "shell",
      pathLabel: cwd,
      lines: [
        ...(cwd ? [{ kind: "meta" as const, text: `cwd ${cwd}` }] : []),
        ...command.split(/\s+&&\s+|\s*;\s*/u).filter(Boolean).slice(0, 12).map((part) => ({
          kind: "command" as const,
          text: part.trim(),
        })),
      ],
      truncated: command.length > 800,
    };
  }

  const path = readString(payload, "path") ?? readString(payload, "filePath");
  const contentPreview = readString(payload, "contentPreview") ?? readString(payload, "content");
  if (path || contentPreview) {
    const previewLines = (contentPreview ?? path ?? "").split(/\r?\n/u).slice(0, 24);
    return {
      title: t("File preview"),
      language: "text",
      pathLabel: path,
      lines: [
        ...(path ? [{ kind: "meta" as const, text: path }] : []),
        ...previewLines.map((line) => ({ kind: "context" as const, text: line || " " })),
      ],
      truncated: Boolean(contentPreview && contentPreview.split(/\r?\n/u).length > 24),
    };
  }

  return undefined;
}

function diffPreviewToLines(diff: string): readonly DockReviewCodeLine[] {
  const lines: DockReviewCodeLine[] = [];
  let oldLine: number | undefined;
  let newLine: number | undefined;
  diff.split(/\r?\n/u).forEach((line, index) => {
    const kind = diffLineKind(line);
    if (kind === "hunk") {
      const match = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?/u.exec(line);
      oldLine = match ? Number(match[1]) : undefined;
      newLine = match ? Number(match[2]) : undefined;
      lines.push({ kind, text: line || " ", lineNumber: index + 1 });
      return;
    }
    if (kind === "add") {
      lines.push({ kind, text: line || " ", lineNumber: index + 1, newLineNumber: newLine });
      if (newLine !== undefined) {
        newLine += 1;
      }
      return;
    }
    if (kind === "delete") {
      lines.push({ kind, text: line || " ", lineNumber: index + 1, oldLineNumber: oldLine });
      if (oldLine !== undefined) {
        oldLine += 1;
      }
      return;
    }
    if (kind === "context") {
      lines.push({
        kind,
        text: line || " ",
        lineNumber: index + 1,
        oldLineNumber: oldLine,
        newLineNumber: newLine,
      });
      if (oldLine !== undefined) {
        oldLine += 1;
      }
      if (newLine !== undefined) {
        newLine += 1;
      }
      return;
    }
    lines.push({ kind, text: line || " ", lineNumber: index + 1 });
  });
  return lines;
}

function diffLineKind(line: string): DockReviewCodeLine["kind"] {
  if (line.startsWith("+") && !line.startsWith("+++")) {
    return "add";
  }
  if (line.startsWith("-") && !line.startsWith("---")) {
    return "delete";
  }
  if (line.startsWith("@@")) {
    return "hunk";
  }
  if (line.startsWith("diff ") || line.startsWith("---") || line.startsWith("+++") || line.startsWith("index ")) {
    return "meta";
  }
  return "context";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function fileKindLabel(kind: DockFileItem["kind"], t: Translate): string {
  switch (kind) {
    case "attachment":
      return t("Attachment");
    case "reference":
      return t("Reference");
    case "artifact":
      return t("Artifact");
    case "change":
      return t("Change");
  }
}

function artifactRefFromFileItem(item: DockFileItem): DockReviewItem["artifactRef"] {
  const artifactPrefix = "artifact:";
  if (!item.id.startsWith(artifactPrefix)) {
    return undefined;
  }
  const type = item.status === "changed" || item.pathLabel?.endsWith(".diff") || item.pathLabel?.endsWith(".patch") ? "diff" : undefined;
  return {
    id: item.id.slice(artifactPrefix.length),
    ...(type ? { type } : {}),
    ...(item.pathLabel ? { path: item.pathLabel } : {}),
    title: item.name,
  };
}

function codeLineStats(lines: readonly DockReviewCodeLine[]): DockReviewChangeStats | undefined {
  const additions = lines.filter((line) => line.kind === "add").length;
  const deletions = lines.filter((line) => line.kind === "delete").length;
  return additions > 0 || deletions > 0 ? { additions, deletions } : undefined;
}

function fileNameFromPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.split("/").filter(Boolean).at(-1) || normalized || "file";
}

function formatBytes(value: number, t: Translate): string {
  if (!Number.isFinite(value) || value <= 0) {
    return t("Unknown size");
  }
  if (value < 1024) {
    return `${value} B`;
  }
  const kib = value / 1024;
  if (kib < 1024) {
    return `${kib.toFixed(kib >= 10 ? 0 : 1)} KB`;
  }
  const mib = kib / 1024;
  return `${mib.toFixed(mib >= 10 ? 0 : 1)} MB`;
}

function formatMaybeDate(value: string | undefined): string | undefined {
  return value ? formatDateTime(value) : undefined;
}

function truncateText(value: string, maxLength: number): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}
