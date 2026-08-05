import type { ConversationWorkCellViewModel } from "@ling-stack/conversation-ui-core";
import type { Translate } from "../../i18n.js";
import { buildConversationWorkCellViewModel } from "../../lib/conversation-work-cell.js";
import { conversationRunHasVisibleWork } from "../../lib/conversation-runtime-visibility.js";
import type { MessageRowAuthorType } from "../../shared/conversation/index.js";
import type { RunSession, TerminalReportDto } from "../../types.js";
import type {
  ConversationHomeDetailContext,
  ConversationHomeMessage,
} from "./normal-conversation-types.js";

export interface NormalConversationFeedItem {
  readonly message: ConversationHomeMessage;
  readonly authorType: MessageRowAuthorType;
  readonly authorName: string;
  readonly createdAtLabel: string;
  readonly className: string;
  readonly body: string;
  readonly bodyStreaming: boolean;
  readonly errorText: string;
  readonly workCell?: ConversationWorkCellViewModel;
  readonly workCellCwd: string;
  readonly workspaceMayHaveChanged: boolean;
}

export function projectNormalConversationFeedItems(input: {
  readonly messages: readonly ConversationHomeMessage[];
  readonly visibleMessages: readonly ConversationHomeMessage[];
  readonly runById: ReadonlyMap<string, RunSession>;
  readonly detailContext?: ConversationHomeDetailContext;
  readonly projectPath?: string;
  readonly workspaceCwd: string;
  readonly t: Translate;
}): readonly NormalConversationFeedItem[] {
  return input.visibleMessages.map((message) => {
    const linkedRun = message.runId ? input.runById.get(message.runId) : undefined;
    const relatedRun = linkedRun ?? findRelatedRun(message, input.messages, input.runById);
    const terminalReport = findTerminalReport(message, input.detailContext?.terminalReports ?? []);
    const executionActions = linkedRun
      ? input.detailContext?.executionActions.filter((action) => action.runId === linkedRun.id) ?? []
      : [];
    const runApprovals = linkedRun
      ? input.detailContext?.approvals.filter((approval) => approval.runId === linkedRun.id) ?? []
      : [];
    const workCell = message.role === "assistant" && message.threadId && linkedRun && conversationRunHasVisibleWork({
      run: linkedRun,
      approvals: runApprovals,
      executionActions,
      terminalReport,
    }) ? buildConversationWorkCellViewModel({
      threadId: message.threadId,
      runs: [linkedRun],
      allowRunThreadFallback: true,
      approvals: input.detailContext?.approvals ?? [],
      artifactsByRun: {},
      executionActions,
      t: input.t,
      terminalReport,
    }) : undefined;
    const errorText = normalConversationMessageErrorText(message, linkedRun?.status);
    const hasStructuredTerminalReport = Boolean(workCell?.terminalReportRows.length);
    const bodyStreaming = message.status === "running" || message.status === "pending";

    return {
      message,
      authorType: conversationMessageAuthorType(message),
      authorName: conversationMessageAuthorName(message, input.t),
      createdAtLabel: formatConversationTimeLabel(message.createdAt),
      className: normalConversationMessageClassName(message),
      body: errorText || hasStructuredTerminalReport
        ? ""
        : message.content || (bodyStreaming ? input.t("Ling Agent is thinking...") : ""),
      bodyStreaming,
      errorText,
      workCell,
      workCellCwd: linkedRun?.cwd ?? input.workspaceCwd.trim(),
      workspaceMayHaveChanged: runMayHaveWorkspaceChanges(relatedRun),
    };
  });
}

export function normalConversationMessageErrorText(
  message: ConversationHomeMessage,
  runStatus?: RunSession["status"],
): string {
  if (message.role === "user") {
    return "";
  }
  if (message.status !== "blocked" && message.status !== "failed" && runStatus !== "failed" && runStatus !== "cancelled") {
    return "";
  }
  return message.content.trim();
}

export function formatConversationTimeLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function findRelatedRun(
  message: ConversationHomeMessage,
  messages: readonly ConversationHomeMessage[],
  runById: ReadonlyMap<string, RunSession>,
): RunSession | undefined {
  if (!message.turnId) {
    return undefined;
  }
  const assistantRunId = messages.find((candidate) =>
    candidate.role === "assistant" && candidate.turnId === message.turnId
  )?.runId;
  return assistantRunId ? runById.get(assistantRunId) : undefined;
}

function findTerminalReport(
  message: ConversationHomeMessage,
  reports: readonly TerminalReportDto[],
): TerminalReportDto | undefined {
  return reports.find((report) =>
    (message.turnId && report.source.kind === "turn" && report.source.id === message.turnId) ||
    (message.runId && report.source.kind === "run" && report.source.id === message.runId)
  );
}

function conversationMessageAuthorType(message: ConversationHomeMessage): MessageRowAuthorType {
  if (message.role === "user") {
    return "local-user";
  }
  if (message.role === "system") {
    return "system";
  }
  return "ai-teammate";
}

function conversationMessageAuthorName(message: ConversationHomeMessage, t: Translate): string {
  if (message.role === "user") {
    return t("You");
  }
  if (message.role === "system") {
    return t("System");
  }
  return message.authorLabel === "Ling Agent" || !message.authorLabel ? t("Ling Agent") : message.authorLabel;
}

function normalConversationMessageClassName(message: ConversationHomeMessage): string {
  return [
    "normal-conversation-message-row",
    message.status === "blocked" ? "blocked" : "",
    message.status === "failed" ? "failed" : "",
  ].filter(Boolean).join(" ");
}

function runMayHaveWorkspaceChanges(run: RunSession | undefined): boolean {
  if (!run?.requestSnapshot || typeof run.requestSnapshot !== "object") {
    return false;
  }
  const tools = "tools" in run.requestSnapshot ? run.requestSnapshot.tools : undefined;
  return Array.isArray(tools) && tools.some((tool) => tool === "edit" || tool === "write" || tool === "bash");
}
