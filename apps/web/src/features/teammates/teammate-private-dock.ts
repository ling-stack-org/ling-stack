import type { Translate } from "../../i18n.js";
import { formatDateTime } from "../../lib/formatting.js";
import type { StatusTone } from "../../shared/ui/index.js";
import type {
  AiTeammate,
  DirectWorkspaceResponse,
  ExecutionAction,
  MemoryObject,
  RunSession,
  TeammateActivityItem,
  TeammateDirectMessage,
  TeammatePrivateAttachment,
  TerminalReportDto,
  UsedMemoryEvent,
} from "../../types.js";
import {
  mergeDockFileItems,
  mergeEvidenceGroups,
  projectAttachmentsToFileItems,
  projectFileRefsToFileItems,
  projectFilesToEvidenceGroup,
  projectFilesToReviewItems,
  projectMessagesToReviewItems,
  projectRunsToEvidenceGroup,
  projectRunsToReviewItems,
  projectWebEvidenceToEvidenceGroup,
  type RightDockMessageProjectionInput,
  type WorkspaceRightDockProps,
} from "../workspace/right-dock/index.js";
import {
  directWorkspacePathLabel,
  directWorkspaceStatusLabel,
  formatBytes,
  truncateText,
} from "./teammate-workspace-utils.js";

export interface TeammatePrivateDockAttachmentView {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
}

export interface TeammatePrivateDockMemoryView {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
}

export interface TeammatePrivateDockContextView {
  readonly teammateName: string;
  readonly teammateRoleLabel: string;
  readonly refreshing: boolean;
  readonly threadId?: string;
  readonly workspace: {
    readonly pathLabel: string;
    readonly executionPath?: string;
    readonly statusLabel: string;
    readonly tone: StatusTone;
    readonly modeLabel?: string;
    readonly branchName?: string;
    readonly checkedAtLabel?: string;
    readonly error?: string;
  };
  readonly latestReply?: {
    readonly summary: string;
    readonly timestampLabel: string;
  };
  readonly attachments: readonly TeammatePrivateDockAttachmentView[];
  readonly memories: readonly TeammatePrivateDockMemoryView[];
  readonly memoryEventCount: number;
  readonly messageCount: number;
  readonly runCount: number;
  readonly actionCount: number;
  readonly terminalReportCount: number;
  readonly fileCount: number;
}

export interface TeammatePrivateDockActivityView {
  readonly id: string;
  readonly kind: TeammateActivityItem["kind"] | "execution";
  readonly title: string;
  readonly summary?: string;
  readonly statusLabel: string;
  readonly tone: StatusTone;
  readonly timestampLabel: string;
  readonly sortTimestamp: string;
}

export interface TeammatePrivateDockViewModel {
  readonly context: TeammatePrivateDockContextView;
  readonly contextCount: number;
  readonly activityItems: readonly TeammatePrivateDockActivityView[];
  readonly activityCount: number;
  readonly reviewItems: WorkspaceRightDockProps["reviewItems"];
  readonly evidenceGroups: WorkspaceRightDockProps["evidenceGroups"];
  readonly fileItems: WorkspaceRightDockProps["fileItems"];
}

export function buildTeammatePrivateDockViewModel({
  teammate,
  messages,
  attachments,
  runs,
  executionActions,
  terminalReports,
  directWorkspace,
  usedMemoryEvents,
  memoryById,
  activityItems,
  refreshing,
  t,
}: {
  readonly teammate: Pick<AiTeammate, "id" | "displayName" | "roleKey">;
  readonly messages: readonly TeammateDirectMessage[];
  readonly attachments: readonly TeammatePrivateAttachment[];
  readonly runs: readonly RunSession[];
  readonly executionActions: readonly ExecutionAction[];
  readonly terminalReports: readonly TerminalReportDto[];
  readonly directWorkspace: DirectWorkspaceResponse | undefined;
  readonly usedMemoryEvents: readonly UsedMemoryEvent[];
  readonly memoryById: ReadonlyMap<string, MemoryObject>;
  readonly activityItems: readonly TeammateActivityItem[];
  readonly refreshing: boolean;
  readonly t: Translate;
}): TeammatePrivateDockViewModel {
  const directRuns = filterPrivateRuns(runs, messages, directWorkspace, teammate.id);
  const dockMessages: readonly RightDockMessageProjectionInput[] = messages.map((message) => ({
    id: message.id,
    title: message.authorType === "ai-teammate" ? teammate.displayName : message.authorType === "local-user" ? t("User message") : t("System message"),
    body: message.body,
    status: message.status,
    errorMessage: message.errorMessage,
    runId: message.linkedRunId,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
    webEvidence: message.webEvidence,
    fileRefs: message.fileRefs ?? [],
  }));
  const fileItems = mergeDockFileItems(
    projectAttachmentsToFileItems(attachments, t),
    projectFileRefsToFileItems(messages.flatMap((message) => message.fileRefs ?? [])),
    projectTerminalReportsToFileItems(terminalReports, t),
  );
  const evidenceGroups = mergeEvidenceGroups(
    projectRunsToEvidenceGroup(directRuns, t),
    projectWebEvidenceToEvidenceGroup(dockMessages, t),
    projectFilesToEvidenceGroup(fileItems, t),
    projectTerminalReportsToBrowserEvidenceGroup(terminalReports, t),
    projectTerminalEvidenceGroup(executionActions, terminalReports, t),
  );
  const reviewItems = [
    ...projectRunsToReviewItems(directRuns, t),
    ...projectMessagesToReviewItems(dockMessages, t),
    ...projectFilesToReviewItems(fileItems, t),
  ];
  const recentUsedMemoryEvents = usedMemoryEvents.slice(0, 3);
  const recentMemoryObjects = [...new Set(recentUsedMemoryEvents.flatMap((event) => event.memoryIds))]
    .map((id) => memoryById.get(id))
    .filter((memory): memory is MemoryObject => Boolean(memory))
    .slice(0, 3);
  const latestReply = [...messages].reverse().find((message) => message.authorType === "ai-teammate");
  const context = buildContextView({
    teammate,
    messages,
    attachments,
    directRuns,
    executionActions,
    terminalReports,
    directWorkspace,
    latestReply,
    recentUsedMemoryEvents,
    recentMemoryObjects,
    fileCount: fileItems.length,
    refreshing,
    t,
  });
  const projectedActivity = projectPrivateActivity(activityItems, executionActions, t);

  return {
    context,
    contextCount: [
      directWorkspace,
      latestReply,
      attachments.length > 0 ? attachments : undefined,
      recentUsedMemoryEvents.length > 0 ? recentUsedMemoryEvents : undefined,
      directRuns.length > 0 || executionActions.length > 0 || terminalReports.length > 0 ? true : undefined,
    ].filter(Boolean).length,
    activityItems: projectedActivity,
    activityCount: projectedActivity.length,
    reviewItems,
    evidenceGroups,
    fileItems,
  };
}

function buildContextView({
  teammate,
  messages,
  attachments,
  directRuns,
  executionActions,
  terminalReports,
  directWorkspace,
  latestReply,
  recentUsedMemoryEvents,
  recentMemoryObjects,
  fileCount,
  refreshing,
  t,
}: {
  readonly teammate: Pick<AiTeammate, "displayName" | "roleKey">;
  readonly messages: readonly TeammateDirectMessage[];
  readonly attachments: readonly TeammatePrivateAttachment[];
  readonly directRuns: readonly RunSession[];
  readonly executionActions: readonly ExecutionAction[];
  readonly terminalReports: readonly TerminalReportDto[];
  readonly directWorkspace: DirectWorkspaceResponse | undefined;
  readonly latestReply: TeammateDirectMessage | undefined;
  readonly recentUsedMemoryEvents: readonly UsedMemoryEvent[];
  readonly recentMemoryObjects: readonly MemoryObject[];
  readonly fileCount: number;
  readonly refreshing: boolean;
  readonly t: Translate;
}): TeammatePrivateDockContextView {
  const workspaceStatus = directWorkspace?.binding.status ?? "not_created";
  return {
    teammateName: teammate.displayName,
    teammateRoleLabel: t(`role.${teammate.roleKey}`),
    refreshing,
    threadId: directWorkspace?.threadId,
    workspace: {
      pathLabel: directWorkspacePathLabel(directWorkspace, t),
      executionPath: directWorkspace?.snapshot.executionCwd || directWorkspace?.binding.executionPath,
      statusLabel: refreshing ? t("Refreshing workspace") : directWorkspaceStatusLabel(directWorkspace, t),
      tone: refreshing ? "info" : workspaceStatusTone(workspaceStatus),
      modeLabel: directWorkspace?.binding.mode ? t(directWorkspace.binding.mode) : undefined,
      branchName: directWorkspace?.binding.branchName,
      checkedAtLabel: directWorkspace?.binding.checkedAt ? formatDateTime(directWorkspace.binding.checkedAt) : undefined,
      error: directWorkspace?.binding.errorMessage,
    },
    latestReply: latestReply ? {
      summary: truncateText(latestReply.body || t("No AI reply summary yet."), 180),
      timestampLabel: formatDateTime(latestReply.updatedAt ?? latestReply.createdAt),
    } : undefined,
    attachments: attachments.slice(0, 8).map((attachment) => ({
      id: attachment.id,
      name: attachment.fileName,
      summary: `${formatBytes(attachment.sizeBytes)} · ${formatDateTime(attachment.createdAt)}`,
    })),
    memories: recentMemoryObjects.map((memory) => ({
      id: memory.id,
      title: memory.title,
      summary: truncateText(memory.body, 120),
    })),
    memoryEventCount: recentUsedMemoryEvents.length,
    messageCount: messages.length,
    runCount: directRuns.length,
    actionCount: executionActions.length,
    terminalReportCount: terminalReports.length,
    fileCount,
  };
}

function filterPrivateRuns(
  runs: readonly RunSession[],
  messages: readonly TeammateDirectMessage[],
  directWorkspace: DirectWorkspaceResponse | undefined,
  teammateId: string,
): readonly RunSession[] {
  const linkedRunIds = new Set(messages.flatMap((message) => message.linkedRunId ? [message.linkedRunId] : []));
  const directThreadId = directWorkspace?.threadId;
  return runs.filter((run) => linkedRunIds.has(run.id) || (
    Boolean(directThreadId) &&
    run.threadId === directThreadId &&
    (!run.teammateId || run.teammateId === teammateId)
  ));
}

function projectPrivateActivity(
  items: readonly TeammateActivityItem[],
  actions: readonly ExecutionAction[],
  t: Translate,
): readonly TeammatePrivateDockActivityView[] {
  return [
    ...items.map((item): TeammatePrivateDockActivityView => ({
      id: item.id,
      kind: item.kind,
      title: item.title,
      summary: item.subtitle,
      statusLabel: item.status ? t(item.status) : t(item.kind),
      tone: activityStatusTone(item.status),
      timestampLabel: formatDateTime(item.createdAt),
      sortTimestamp: item.createdAt,
    })),
    ...actions.map((action): TeammatePrivateDockActivityView => ({
      id: `execution:${action.id}`,
      kind: "execution",
      title: action.title || t("Execution action"),
      summary: action.summary,
      statusLabel: t(action.status),
      tone: activityStatusTone(action.status),
      timestampLabel: formatDateTime(action.updatedAt ?? action.createdAt),
      sortTimestamp: action.updatedAt ?? action.createdAt,
    })),
  ].sort((left, right) => right.sortTimestamp.localeCompare(left.sortTimestamp)).slice(0, 40);
}

function projectTerminalReportsToFileItems(
  reports: readonly TerminalReportDto[],
  t: Translate,
): WorkspaceRightDockProps["fileItems"] {
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
      name: fileNameFromPath(path),
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
): WorkspaceRightDockProps["evidenceGroups"][number] {
  const seen = new Set<string>();
  const items: WorkspaceRightDockProps["evidenceGroups"][number]["items"][number][] = [];
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
        timestampLabel: formatDateTime(report.committedAt),
      });
    }
  }
  return { id: "browser", label: t("Browser evidence"), items };
}

function projectTerminalEvidenceGroup(
  actions: readonly ExecutionAction[],
  reports: readonly TerminalReportDto[],
  t: Translate,
): WorkspaceRightDockProps["evidenceGroups"][number] {
  const actionItems = actions.filter((action) => action.commandEvidence).map((action) => ({
    id: `execution-command:${action.id}`,
    kind: "shell" as const,
    title: action.commandEvidence?.command ?? action.title,
    summary: action.commandEvidence?.outputTail.at(-1)?.text.trim() || action.summary,
    status: action.status === "failed" ? "failed" as const : action.status === "executing" ? "loading" as const : "available" as const,
    statusLabel: t(action.status),
    sourceLabel: t("Execution action"),
    timestampLabel: formatDateTime(action.updatedAt ?? action.createdAt),
  }));
  const reportItems = reports.flatMap((report) => report.verification.filter((item) => item.command).map((item) => ({
    id: `terminal-report-verification:${report.id}:${item.id}`,
    kind: "shell" as const,
    title: item.command ?? item.title,
    summary: item.summary ?? item.title,
    status: item.status === "failed" || item.status === "blocked" ? "failed" as const : item.status === "not_run" ? "loading" as const : "available" as const,
    statusLabel: t(item.status),
    sourceLabel: t("Terminal report"),
    timestampLabel: formatDateTime(report.committedAt),
  })));
  return { id: "shell", label: t("Terminal evidence"), items: [...actionItems, ...reportItems] };
}

function collectTerminalReportSourceRefs(
  report: TerminalReportDto,
): readonly TerminalReportDto["references"][number][] {
  return [
    ...report.references,
    ...report.outcome.sourceRefs,
    ...report.changes.flatMap((item) => item.sourceRefs),
    ...report.verification.flatMap((item) => item.sourceRefs),
    ...report.artifacts.flatMap((item) => item.sourceRefs),
    ...report.risks.flatMap((item) => item.sourceRefs),
  ];
}

function workspaceStatusTone(status: DirectWorkspaceResponse["binding"]["status"]): StatusTone {
  if (status === "ready") return "success";
  if (status === "blocked" || status === "unsupported") return "danger";
  if (status === "missing") return "warning";
  return "neutral";
}

function activityStatusTone(status?: string): StatusTone {
  if (status === "failed" || status === "blocked" || status === "rejected") return "danger";
  if (status === "waiting_for_approval" || status === "pending" || status === "todo") return "warning";
  if (status === "running" || status === "queued" || status === "executing") return "info";
  if (status === "ready" || status === "succeeded" || status === "completed" || status === "approved") return "success";
  return "neutral";
}

function fileNameFromPath(path: string): string {
  const normalized = path.replace(/\\/gu, "/").replace(/\/+$/gu, "");
  return normalized.split("/").filter(Boolean).at(-1) ?? path;
}
