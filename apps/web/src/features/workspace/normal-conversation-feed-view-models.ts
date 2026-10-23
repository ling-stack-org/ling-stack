import {
  createConversationTimelineMessageItem,
  projectConversationMessagePresentation,
  type ConversationTimelineItem,
} from "@ling-stack/conversation-ui-core";
import type { Translate } from "../../i18n.js";
import { buildConversationWorkCellViewModel, conversationTimelineItemsForModel } from "../../lib/conversation-work-cell.js";
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
  readonly timelineItems: readonly ConversationTimelineItem[];
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
    const typedTimelineItems = linkedRun
      ? canonicalFactsForMessage(input.detailContext?.timelineProjection?.items ?? [], message, linkedRun.id)
      : [];
    const legacyFactsAdapter = message.role === "assistant" && message.threadId && linkedRun && conversationRunHasVisibleWork({
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
      contextSegmentIdByItemId: input.detailContext?.timelineProjection?.contextSegmentIdByItemId,
      ...(typedTimelineItems.length > 0 ? { typedTimelineItems } : {}),
    }) : undefined;
    // Only an accepted, published canonical fact can supersede a Host-generated
    // status placeholder. Unknown provenance and real model segments stay visible.
    const reportOwnsHostStatus = message.role === "assistant" && message.contentSource === "host_status" &&
      !message.narrationSegments?.length && (message.status === "failed" || message.status === "cancelled" || message.status === "blocked") &&
      typedTimelineItems.some((item) => item.kind === "terminalReport" && Boolean(item.reportId && item.resultItemId) &&
        item.generation > 0 && item.turnId === message.turnId && (!item.runId || item.runId === message.runId) &&
        (item.status === "failed" || item.status === "cancelled" || item.status === "blocked" || item.status === "partially_succeeded"));
    const bodyStreaming = message.status === "running" || message.status === "pending";
    const messagePresentation = projectConversationMessagePresentation({
      content: message.content,
      errorMessage: message.role === "assistant" ? message.errorMessage : undefined,
      status: message.role === "assistant" ? message.status : undefined,
      runtimeFailed: message.role === "assistant" && linkedRun?.status === "failed",
      streaming: bodyStreaming,
      streamingPlaceholder: input.t("Ling Agent is thinking..."),
    });
    const messageItem = createConversationTimelineMessageItem({
      id: `message:${message.role === "user" ? "user" : "agent"}:${message.id}`,
      role: message.role === "user" ? "user" : "agent",
      markdown: messagePresentation.body,
      waitingPlaceholder: bodyStreaming && !message.content.trim() && !message.narrationSegments?.length && !message.errorMessage?.trim(),
      phase: message.role === "assistant" && (message.status === "succeeded" || relatedRun?.status === "succeeded") ? "final" : "commentary",
      revision: message.revision,
      threadSequence: 0,
      turnId: message.turnId,
      itemId: message.id,
      status: message.status,
      fileRefs: message.fileRefs,
    });
    // Canonical typed facts own the normal surface whenever they are present.
    // The WorkCell path is only a source adapter for optimistic/older detail
    // responses and is never exposed as a renderer owner.
    const facts = typedTimelineItems.length > 0
      ? typedTimelineItems
      : legacyFactsAdapter
        ? conversationTimelineItemsForModel(legacyFactsAdapter)
        : [];
    const timelineItems = reportOwnsHostStatus ? facts : [messageItem, ...facts];

    return {
      message,
      authorType: conversationMessageAuthorType(message),
      authorName: conversationMessageAuthorName(message, input.t),
      createdAtLabel: formatConversationTimeLabel(message.createdAt),
      className: normalConversationMessageClassName(message),
      // Real model prose owns narration. A Host fallback is only a status view
      // until the same owner's canonical final report has arrived.
      body: reportOwnsHostStatus ? "" : messagePresentation.body,
      bodyStreaming,
      errorText: reportOwnsHostStatus ? "" : messagePresentation.errorText,
      timelineItems,
      workspaceMayHaveChanged: runMayHaveWorkspaceChanges(relatedRun),
    };
  });
}

function canonicalFactsForMessage(
  items: readonly ConversationTimelineItem[],
  message: ConversationHomeMessage,
  runId: string,
): readonly ConversationTimelineItem[] {
  return items.filter((item) => {
    if (item.kind === "userMessage" || item.kind === "agentMessage") return false;
    return item.runId === runId || (Boolean(message.turnId) && item.turnId === message.turnId);
  });
}

export function normalConversationMessageErrorText(
  message: ConversationHomeMessage,
  runStatus?: RunSession["status"],
): string {
  return message.role === "user" ? "" : projectConversationMessagePresentation({
    content: message.content,
    errorMessage: message.errorMessage,
    status: message.status,
    runtimeFailed: runStatus === "failed",
  }).errorText;
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
