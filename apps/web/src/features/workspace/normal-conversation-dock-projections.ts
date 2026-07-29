import { collectLocalFileReferences, parseMessageBody } from "@ling-stack/conversation-ui-core";
import type { Translate } from "../../i18n.js";
import type {
  DockEvidenceGroupView,
  DockEvidenceItem,
  DockFileItem,
  DockReviewItem,
} from "../../shared/conversation/index.js";
import type { StatusTone } from "../../shared/ui/index.js";
import type { ExecutionAction, LingTurn, RunSession, TerminalReportDto } from "../../types.js";
import {
  mergeDockFileItems,
  mergeEvidenceGroups,
  projectAttachmentsToFileItems,
  projectFilesToEvidenceGroup,
  projectFilesToReviewItems,
  projectMessagesToReviewItems,
  projectRunsToEvidenceGroup,
  projectRunsToReviewItems,
  type RightDockMessageProjectionInput,
} from "./right-dock/index.js";
import {
  formatConversationTimeLabel,
  normalConversationMessageErrorText,
} from "./normal-conversation-feed-view-models.js";
import type {
  ConversationHomeMessage,
  ConversationHomeProjectSelection,
} from "./normal-conversation-types.js";

export type NormalConversationDockSummaryTone = "success" | "running" | "waiting" | "blocked" | "failed" | "neutral";

export interface NormalConversationDockContextView {
  readonly conversationTitle: string;
  readonly workspaceLabel: string;
  readonly workspacePath?: string;
  readonly threadId?: string;
  readonly messageCount: number;
  readonly turnCount: number;
  readonly runCount: number;
  readonly fileCount: number;
  readonly actionCount: number;
  readonly terminalReportCount: number;
  readonly latestRun?: {
    readonly label: string;
    readonly statusLabel: string;
    readonly tone: StatusTone;
    readonly summaryTone: NormalConversationDockSummaryTone;
    readonly updatedAt?: string;
  };
}

export interface NormalConversationDockActivityItem {
  readonly id: string;
  readonly kind: "turn" | "execution";
  readonly title: string;
  readonly summary?: string;
  readonly statusLabel: string;
  readonly tone: StatusTone;
  readonly timestampLabel?: string;
  readonly sortTimestamp: string;
}

export interface NormalConversationDockViewModel {
  readonly context: NormalConversationDockContextView;
  readonly activityItems: readonly NormalConversationDockActivityItem[];
  readonly activityCount: number;
  readonly fileItems: readonly DockFileItem[];
  readonly evidenceGroups: readonly DockEvidenceGroupView[];
  readonly reviewItems: readonly DockReviewItem[];
  readonly summary: {
    readonly workspaceLabel: string;
    readonly messageCount: number;
    readonly fileCount: number;
    readonly latestRun?: NormalConversationDockContextView["latestRun"];
  };
}

export interface BuildNormalConversationDockViewModelInput {
  readonly conversationTitle: string;
  readonly messages: readonly ConversationHomeMessage[];
  readonly project: ConversationHomeProjectSelection;
  readonly workspaceCwd: string;
  readonly threadId?: string;
  readonly turns: readonly LingTurn[];
  readonly runs: readonly RunSession[];
  readonly executionActions: readonly ExecutionAction[];
  readonly terminalReports: readonly TerminalReportDto[];
  readonly t: Translate;
}

export function buildNormalConversationDockViewModel({
  conversationTitle,
  messages,
  project,
  workspaceCwd,
  threadId,
  turns,
  runs,
  executionActions,
  terminalReports,
  t,
}: BuildNormalConversationDockViewModelInput): NormalConversationDockViewModel {
  const runById = new Map(runs.map((run) => [run.id, run]));
  const dockMessages: readonly RightDockMessageProjectionInput[] = messages.map((message) => ({
    id: message.id,
    title: message.role === "assistant" ? t("Assistant message") : message.role === "user" ? t("User message") : t("System message"),
    body: message.content,
    status: conversationDockMessageStatus(message.status),
    errorMessage: normalConversationMessageErrorText(message, message.runId ? runById.get(message.runId)?.status : undefined) || undefined,
    runId: message.runId,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
  }));
  const fileItems = mergeDockFileItems(
    projectAttachmentsToFileItems(messages.flatMap((message) => message.attachments ?? []), t),
    messages.flatMap((message) => collectLocalFileReferences(
      parseMessageBody(message.content, project.projectPath?.trim() || workspaceCwd.trim()),
    ).map((reference, index) => ({
      id: `inline-ref:${message.id}:${reference.raw}:${index}`,
      name: fileNameFromReferencePath(reference.displayPath),
      pathLabel: reference.displayPath,
      kind: "reference" as const,
      status: "available" as const,
      ownerScope: {
        kind: "message" as const,
        id: message.id,
        label: message.role === "assistant" ? t("Assistant message files") : t("User message files"),
        detail: formatConversationTimeLabel(message.updatedAt ?? message.createdAt),
      },
    }))),
    projectTerminalReportsToFileItems(terminalReports, t),
  );
  const evidenceGroups = mergeEvidenceGroups(
    projectRunsToEvidenceGroup(runs, t),
    projectFilesToEvidenceGroup(fileItems, t),
    projectTerminalReportsToBrowserEvidenceGroup(terminalReports, t),
    projectTerminalEvidenceGroup(executionActions, terminalReports, t),
  );
  const reviewItems = [
    ...projectRunsToReviewItems(runs, t),
    ...projectMessagesToReviewItems(dockMessages, t),
    ...projectFilesToReviewItems(fileItems, t),
  ];
  const latestRun = [...runs].sort((left, right) =>
    (right.updatedAt ?? right.createdAt).localeCompare(left.updatedAt ?? left.createdAt)
  )[0];
  const latestRunView = latestRun ? {
    label: runTaskSnapshotTitle(latestRun) ?? latestRun.providerModel ?? latestRun.providerName ?? t("Run"),
    statusLabel: t(latestRun.status),
    tone: runStatusTone(latestRun.status),
    summaryTone: runSummaryTone(latestRun.status),
    updatedAt: latestRun.updatedAt ?? latestRun.createdAt,
  } : undefined;
  const activityItems = projectNormalConversationActivity(turns, executionActions, t);
  const workspaceLabel = workspaceDisplayLabel(workspaceCwd.trim());

  return {
    context: {
      conversationTitle,
      workspaceLabel,
      workspacePath: workspaceCwd.trim() || undefined,
      threadId,
      messageCount: messages.length,
      turnCount: turns.length,
      runCount: runs.length,
      fileCount: fileItems.length,
      actionCount: executionActions.length,
      terminalReportCount: terminalReports.length,
      latestRun: latestRunView,
    },
    activityItems,
    activityCount: activityItems.length,
    fileItems,
    evidenceGroups,
    reviewItems,
    summary: {
      workspaceLabel,
      messageCount: messages.length,
      fileCount: fileItems.length,
      latestRun: latestRunView,
    },
  };
}

export function runTaskSnapshotTitle(run: RunSession): string | undefined {
  const snapshot = run.taskSnapshot;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return undefined;
  const title = (snapshot as Record<string, unknown>).title;
  return typeof title === "string" && title.trim() ? title.trim() : undefined;
}

export function workspaceDisplayLabel(cwd: string): string {
  if (!cwd) return "-";
  const normalized = cwd.replace(/\\/gu, "/").replace(/\/+$/gu, "");
  return normalized.split("/").filter(Boolean).at(-1) ?? cwd;
}

function projectNormalConversationActivity(
  turns: readonly LingTurn[],
  executionActions: readonly ExecutionAction[],
  t: Translate,
): readonly NormalConversationDockActivityItem[] {
  return [
    ...turns.map((turn): NormalConversationDockActivityItem => ({
      id: `turn:${turn.id}`,
      kind: "turn",
      title: turn.title || t("Conversation turn"),
      summary: turn.userInstruction,
      statusLabel: t(turn.status),
      tone: turnStatusTone(turn.status),
      timestampLabel: formatConversationTimeLabel(turn.updatedAt),
      sortTimestamp: turn.updatedAt,
    })),
    ...executionActions.map((action): NormalConversationDockActivityItem => ({
      id: `execution:${action.id}`,
      kind: "execution",
      title: action.title || t("Execution action"),
      summary: action.summary,
      statusLabel: t(action.status),
      tone: executionActionTone(action.status),
      timestampLabel: formatConversationTimeLabel(action.updatedAt ?? action.createdAt),
      sortTimestamp: action.updatedAt ?? action.createdAt,
    })),
  ].sort((left, right) => right.sortTimestamp.localeCompare(left.sortTimestamp)).slice(0, 40);
}

function projectTerminalReportsToFileItems(
  reports: readonly TerminalReportDto[],
  t: Translate,
): readonly DockFileItem[] {
  return reports.flatMap((report) => [
    ...report.artifacts.filter((artifact) => artifact.path).map((artifact) => ({
      id: `terminal-report-artifact:${report.id}:${artifact.id}`,
      name: artifact.title,
      pathLabel: artifact.path,
      kind: "artifact" as const,
      status: "generated" as const,
      ownerScope: {
        kind: "run" as const,
        id: report.source.id,
        label: t("Terminal report files"),
        detail: report.outcome.title,
      },
    })),
    ...report.changes.flatMap((change) => change.paths.map((path, index) => ({
      id: `terminal-report-change:${report.id}:${change.id}:${index}`,
      name: fileNameFromReferencePath(path),
      pathLabel: path,
      kind: "change" as const,
      status: "changed" as const,
      ownerScope: {
        kind: "run" as const,
        id: report.source.id,
        label: t("Terminal report files"),
        detail: change.title,
      },
    }))),
  ]);
}

function projectTerminalReportsToBrowserEvidenceGroup(
  reports: readonly TerminalReportDto[],
  t: Translate,
): DockEvidenceGroupView {
  const seen = new Set<string>();
  const items: DockEvidenceItem[] = [];
  for (const report of reports) {
    for (const ref of collectTerminalReportSourceRefs(report)) {
      const href = ref.href;
      if (!href || !/^https?:\/\//iu.test(href) || seen.has(href)) continue;
      seen.add(href);
      items.push({
        id: `terminal-report-browser:${report.id}:${ref.id}`,
        kind: "browser",
        title: ref.label || href || t("Browser source"),
        summary: report.outcome.summary,
        status: "available",
        sourceLabel: t("Terminal report"),
        href,
        originalUrl: href,
        timestampLabel: formatConversationTimeLabel(report.committedAt),
      });
    }
  }
  return { id: "browser", label: t("Browser evidence"), items };
}

function projectTerminalEvidenceGroup(
  actions: readonly ExecutionAction[],
  reports: readonly TerminalReportDto[],
  t: Translate,
): DockEvidenceGroupView {
  const actionItems = actions.filter((action) => action.commandEvidence).map((action) => ({
    id: `execution-command:${action.id}`,
    kind: "shell" as const,
    title: action.commandEvidence?.command ?? action.title,
    summary: action.commandEvidence?.outputTail.at(-1)?.text.trim() || action.summary,
    status: action.status === "failed" ? "failed" as const : action.status === "executing" ? "loading" as const : "available" as const,
    statusLabel: t(action.status),
    sourceLabel: t("Execution action"),
    timestampLabel: formatConversationTimeLabel(action.updatedAt ?? action.createdAt),
  }));
  const reportItems = reports.flatMap((report) => report.verification.filter((item) => item.command).map((item) => ({
    id: `terminal-report-verification:${report.id}:${item.id}`,
    kind: "shell" as const,
    title: item.command ?? item.title,
    summary: item.summary ?? item.title,
    status: item.status === "failed" || item.status === "blocked" ? "failed" as const : item.status === "not_run" ? "loading" as const : "available" as const,
    statusLabel: t(item.status),
    sourceLabel: t("Terminal report"),
    timestampLabel: formatConversationTimeLabel(report.committedAt),
  })));
  return { id: "shell", label: t("Terminal evidence"), items: [...actionItems, ...reportItems] };
}

function collectTerminalReportSourceRefs(report: TerminalReportDto): readonly TerminalReportDto["references"][number][] {
  return [
    ...report.references,
    ...report.outcome.sourceRefs,
    ...report.changes.flatMap((item) => item.sourceRefs),
    ...report.verification.flatMap((item) => item.sourceRefs),
    ...report.artifacts.flatMap((item) => item.sourceRefs),
    ...report.risks.flatMap((item) => item.sourceRefs),
  ];
}

function conversationDockMessageStatus(
  status: ConversationHomeMessage["status"],
): RightDockMessageProjectionInput["status"] | undefined {
  switch (status) {
    case "pending":
      return "pending";
    case "running":
      return "running";
    case "blocked":
      return "blocked";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "succeeded":
      return "ready";
    default:
      return undefined;
  }
}

function fileNameFromReferencePath(path: string): string {
  const normalized = path.replace(/\\/gu, "/").replace(/\/+$/gu, "");
  return normalized.split("/").filter(Boolean).at(-1) ?? path;
}

function runStatusTone(status: RunSession["status"]): StatusTone {
  if (status === "failed") return "danger";
  if (status === "waiting_for_approval" || status === "cancelled") return "warning";
  if (status === "running" || status === "queued") return "info";
  if (status === "succeeded") return "success";
  return "neutral";
}

function runSummaryTone(status: RunSession["status"]): NormalConversationDockSummaryTone {
  if (status === "failed") return "failed";
  if (status === "waiting_for_approval") return "waiting";
  if (status === "cancelled") return "blocked";
  if (status === "running" || status === "queued") return "running";
  if (status === "succeeded") return "success";
  return "neutral";
}

function turnStatusTone(status: LingTurn["status"]): StatusTone {
  if (status === "failed") return "danger";
  if (status === "waiting_for_approval" || status === "blocked" || status === "cancelled") return "warning";
  if (status === "running" || status === "open") return "info";
  if (status === "succeeded") return "success";
  return "neutral";
}

function executionActionTone(status: ExecutionAction["status"]): StatusTone {
  if (status === "failed" || status === "denied") return "danger";
  if (status === "waiting_for_approval" || status === "expired" || status === "cancelled") return "warning";
  if (status === "executing" || status === "proposed" || status === "approved") return "info";
  if (status === "succeeded") return "success";
  return "neutral";
}
