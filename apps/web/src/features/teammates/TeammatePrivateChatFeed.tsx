import { useMemo } from "react";
import { ArrowDown, Copy, FileText, Image, Loader2, MessageSquare, Pencil, Plus, ThumbsDown, ThumbsUp } from "lucide-react";
import { attachmentContentUrl, daemonBaseUrl, submitUserInputAnswer } from "../../api.js";
import { useI18n } from "../../i18n.js";
import { formatDateTime } from "../../lib/formatting.js";
import { attachmentCanPreview, loadPreviewContent } from "../../lib/previews.js";
import {
  buildComposerGateApprovalPresentationByRunId,
  composerGateApprovalPresentationForRunId,
} from "../../lib/runtime-approval-presentation.js";
import {
  AvatarInitial,
  UsedMemorySummary,
  UsedMemorySummaryLabel,
  UserProfileAvatar,
  filterUsedMemoryEventsByResponse,
} from "../../shared/components/index.js";
import {
  ConversationAttachmentStrip,
  mountConversationTimeline,
  ConversationGeneratedMediaBlock,
  ConversationReferenceStrip,
  ConversationReplacementRetry,
  ConversationTimelineFeed,
  InlineMessageEditor,
  MessageActionBar,
  MessageEvidencePanel,
  MessageRow,
} from "../../shared/conversation/index.js";
import { IconButton, InlineFeedback } from "../../shared/ui/index.js";
import type { TeammateDirectLinkPreview, TeammateDirectMessage, TeammatePrivateAttachment } from "../../types.js";
import { TeammateAvatarView } from "./TeammateAvatarView.js";
import type { TeammatePrivateChatSurfaceProps } from "./teammate-private-chat-types.js";
import {
  buildTeammatePrivateUnverifiedEvidenceMap,
  buildTeammatePrivateWorkCellMap,
  projectTeammatePrivateMessage,
  teammateReferenceFileName,
  teammateWebReferenceHost,
} from "./teammate-private-chat-view-models.js";
import { conversationTimelineItemsForModel } from "../../lib/conversation-work-cell.js";
import { formatBytes } from "./teammate-workspace-utils.js";
import type { TeammatePrivateMessageController } from "./useTeammatePrivateMessageController.js";
import { buildSurfaceTimelineSnapshot } from "../../domains/conversations/timeline-snapshot.js";
import { requestTimelineWorkspaceFileOpen } from "../../shared/conversation/timeline/workspace-file-capability.js";
import { timelineMessageChromeOwnerIds } from "../../shared/conversation/timeline/timeline-message-chrome-owners.js";
import {
  privateGeneratedMediaForMessage,
  privateTimelineOwnedRunIds,
  projectTeammatePrivateTimelineItems,
  resolveTeammatePrivateDiagnosticPlacements,
  selectTeammatePrivateMessages,
  selectTeammatePrivateOwnedMessages,
} from "./teammate-private-timeline-items.js";
import { useTeammatePrivateTimeline } from "./use-teammate-private-timeline.js";
import { conversationReadingScope } from "../../shared/conversation/view-store/conversation-reading-storage.js";

export type TeammatePrivateChatFeedProps = Pick<TeammatePrivateChatSurfaceProps,
  | "approvals"
  | "cwd"
  | "directLinkPreviewById"
  | "composerGateApprovals"
  | "executionActions"
  | "generatedMedia"
  | "latestButtonVisible"
  | "loading"
  | "memoryById"
  | "normalizedMessageSearchQuery"
  | "onCancelPrivateFeedAutoFollow"
  | "onCopyMessageText"
  | "onCreateTaskFromMessage"
  | "onOpenFiles"
  | "onOpenReview"
  | "onOpenRun"
  | "onPrivateFeedScroll"
  | "onScrollToLatest"
  | "privateAttachmentById"
  | "privateFeedRef"
  | "privateFeedLocatorRef"
  | "providerRecovered"
  | "runs"
  | "taskCreateBusyKeys"
  | "taskCreateErrors"
  | "taskChannelOptions"
  | "teammate"
  | "threadId"
  | "terminalReports"
  | "usedMemoryEvents"
  | "userProfile"
  | "visibleMessages"
> & {
  readonly messageController: TeammatePrivateMessageController;
};

export function TeammatePrivateChatFeed({
  approvals,
  cwd,
  directLinkPreviewById,
  composerGateApprovals,
  executionActions,
  generatedMedia,
  latestButtonVisible,
  loading,
  memoryById,
  messageController,
  normalizedMessageSearchQuery,
  onCancelPrivateFeedAutoFollow,
  onCopyMessageText,
  onCreateTaskFromMessage,
  onOpenFiles,
  onOpenReview,
  onOpenRun,
  onPrivateFeedScroll,
  onScrollToLatest,
  privateAttachmentById,
  privateFeedRef,
  privateFeedLocatorRef,
  providerRecovered,
  runs,
  taskCreateBusyKeys,
  taskCreateErrors,
  taskChannelOptions,
  teammate,
  threadId,
  terminalReports,
  usedMemoryEvents,
  userProfile,
  visibleMessages: candidateMessages,
}: TeammatePrivateChatFeedProps): React.JSX.Element {
  const { t } = useI18n();
  const timelineItemLocatorRef = privateFeedLocatorRef;
  const ownerMessageText = useMemo(() => selectTeammatePrivateOwnedMessages(candidateMessages, {
    teammateId: teammate.id, directThreadId: threadId,
  }), [candidateMessages, teammate.id, threadId]);
  const canonical = useTeammatePrivateTimeline({
    cwd, teammateId: teammate.id, directThreadId: threadId,
    refreshKey: JSON.stringify([
      ownerMessageText.map((message) => [message.id, message.revision, message.status]),
      executionActions.map((action) => [action.id, action.revision, action.updatedAt, action.status]),
    ]),
    active: ownerMessageText.some((message) => message.authorType === "ai-teammate" && message.status === "pending"),
  });
  const privateScope = useMemo(() => ({
    teammateId: teammate.id, directThreadId: threadId ?? canonical.directThreadId,
    canonicalThreadId: canonical.threadId, runs: canonical.runs, runLinks: canonical.runLinks,
    turns: canonical.turns,
  }), [canonical.directThreadId, canonical.runLinks, canonical.runs, canonical.threadId, canonical.turns, teammate.id, threadId]);
  const visibleMessages = useMemo(() => selectTeammatePrivateOwnedMessages(candidateMessages, privateScope), [candidateMessages, privateScope]);
  const executionMessages = useMemo(() => selectTeammatePrivateMessages(visibleMessages, privateScope), [privateScope, visibleMessages]);
  const executionMessageById = useMemo(() => new Map(executionMessages.map((message) => [message.id, message])), [executionMessages]);
  const localUserDisplayName = userProfile?.displayName.trim() || t("You");
  const composerGateApprovalByRunId = useMemo(
    () => buildComposerGateApprovalPresentationByRunId(composerGateApprovals, t),
    [composerGateApprovals, t],
  );
  const workCellByMessageId = useMemo(() => buildTeammatePrivateWorkCellMap({
    messages: executionMessages,
    teammateId: teammate.id,
    runs: canonical.runs ?? [],
    executionActions,
    approvals,
    terminalReports,
    t,
  }), [approvals, canonical.runs, executionActions, executionMessages, teammate.id, t, terminalReports]);
  const unverifiedEvidenceByMessageId = useMemo(() => buildTeammatePrivateUnverifiedEvidenceMap({
    messages: visibleMessages,
    teammateId: teammate.id,
    authorizedRunIds: privateTimelineOwnedRunIds(privateScope),
    runs,
    executionActions,
    t,
  }), [executionActions, privateScope, runs, t, teammate.id, visibleMessages]);
  const projectionByMessageId = useMemo(
    () => new Map(visibleMessages.map((message) => [message.id, projectTeammatePrivateMessage({
      localUserDisplayName,
      message,
      providerRecovered,
      teammateDisplayName: teammate.displayName,
      t,
    })])),
    [localUserDisplayName, providerRecovered, t, teammate.displayName, visibleMessages],
  );
  const activeMessage = [...executionMessages].reverse().find((message) => {
    const projection = projectionByMessageId.get(message.id);
    return Boolean(projection?.pendingAiReply && message.linkedRunId);
  });
  const timelineItems = useMemo(() => {
    const hiddenApprovals = new Set([...composerGateApprovalByRunId.values()].map((approval) => approval.approvalId));
    return projectTeammatePrivateTimelineItems({
      ...privateScope,
      messages: visibleMessages.map((message) => {
        const workCell = workCellByMessageId.get(message.id);
        const composerApprovalId = composerGateApprovalPresentationForRunId(
          message.linkedRunId,
          composerGateApprovalByRunId,
        )?.approvalId;
        return {
          message,
          body: projectionByMessageId.get(message.id)?.body ?? message.body,
          facts: workCell
            ? conversationTimelineItemsForModel(workCell.model, composerApprovalId)
            : unverifiedEvidenceByMessageId.get(message.id) ?? [],
        };
      }),
      runLinks: canonical.runLinks,
      canonical: canonical.projection ? {
        ...canonical.projection,
        items: canonical.projection.items.filter((item) => !item.approvalId || !hiddenApprovals.has(item.approvalId)),
      } : undefined,
      canonicalMessageIds: canonical.messageIds,
      canonicalState: canonical.status,
    });
  }, [canonical, composerGateApprovalByRunId, privateScope, projectionByMessageId, unverifiedEvidenceByMessageId, visibleMessages, workCellByMessageId]);
  const timelineSnapshot = useMemo(() => buildSurfaceTimelineSnapshot({
    surface: "teammate_direct",
    threadId: canonical.threadId ?? threadId,
    items: timelineItems,
    runLifecycles: new Map((canonical.runs ?? []).map(run => [run.id, run])),
    diagnosticPlacements: resolveTeammatePrivateDiagnosticPlacements({
      items: timelineItems, scope: privateScope, messages: visibleMessages,
      canonical: canonical.projection, canonicalMessageIds: canonical.messageIds,
    }),
    contextSegmentIdByItemId: canonical.projection?.contextSegmentIdByItemId,
    activeRun: activeMessage?.linkedRunId ? {
      runId: activeMessage.linkedRunId,
      status: "working",
      workspaceLabel: cwd.trim(),
      cwd: cwd.trim(),
      branch: null,
      modelLabel: null,
      sourceRefs: [],
    } : null,
    canonicalRevision: timelineItems.reduce((max, item) => Math.max(max, item.revision), 0),
  }), [activeMessage?.linkedRunId, canonical.messageIds, canonical.projection, canonical.runs, canonical.threadId, cwd, privateScope, threadId, timelineItems, visibleMessages]);
  const messageChromeOwnerIds = useMemo(
    () => timelineMessageChromeOwnerIds(timelineSnapshot.items),
    [timelineSnapshot.items],
  );
  const workspaceId = canonical.workspaceId ?? executionActions.find((action) => action.workspaceId.trim())?.workspaceId;

  async function handleOpenTimelineSourceRef(
    ref: import("@ling-stack/conversation-ui-core").ConversationOperationSourceRef,
    item?: import("@ling-stack/conversation-ui-core").ConversationTimelineItem,
  ): Promise<void> {
    if (ref.kind !== "file" && ref.kind !== "path" && ref.kind !== "diff" && ref.kind !== "artifact") {
      throw new Error("This source is not an openable workspace resource.");
    }
    await requestTimelineWorkspaceFileOpen(ref, item, {
      cwd: cwd.trim(),
      workspaceId,
      threadId: canonical.threadId ?? threadId,
    }, onOpenFiles);
  }

  function renderPrivateMessageActions(message: TeammateDirectMessage, copyText: string): React.ReactNode {
    const projection = projectionByMessageId.get(message.id);
    const messageFeedback = messageController.feedbackById[message.id];
    const taskCreateBusy = taskCreateBusyKeys.has(`message:${message.id}`);
    const actionMessage = projection?.userGuidance ? { ...message, body: projection.body } : message;
    return <MessageActionBar surface="teammate_direct" className="teammate-message-actions" copiedLabel={t("Copied")} actions={[
      { id: "copy", kind: "copy", label: t("Copy message"), icon: <Copy size={14} />, onClick: () => onCopyMessageText(copyText) },
      ...(message.authorType === "local-user" && message.id === messageController.latestEditableMessageId ? [{
        id: "edit", kind: "edit_latest" as const, label: t("Edit message"), icon: <Pencil size={14} />,
        onClick: () => messageController.beginEdit(message.id),
      }] : []),
      ...(message.authorType === "ai-teammate" ? [
        { id: "like", kind: "like" as const, label: t("Like response"), icon: <ThumbsUp size={14} />, selected: messageFeedback === "up", onClick: () => messageController.toggleFeedback(message.id, "up") },
        { id: "dislike", kind: "dislike" as const, label: t("Dislike response"), icon: <ThumbsDown size={14} />, selected: messageFeedback === "down", onClick: () => messageController.toggleFeedback(message.id, "down") },
      ] : []),
      { id: "create-task", kind: "create_task", label: t("Create task"),
        icon: taskCreateBusy ? <Loader2 className="spin" size={14} /> : <Plus size={14} />,
        disabled: taskCreateBusy || taskChannelOptions.length === 0, loading: taskCreateBusy,
        onClick: () => void onCreateTaskFromMessage(actionMessage) },
    ]} />;
  }

  function renderPrivateMessageRow(message: TeammateDirectMessage, body: React.ReactNode, ownsMessageChrome: boolean, ownsIdentity: boolean): React.JSX.Element {
    const executionMessage = executionMessageById.get(message.id);
    const messageGeneratedMedia = executionMessage ? privateGeneratedMediaForMessage(generatedMedia, executionMessage) : [];
    const projection = projectionByMessageId.get(message.id) ?? projectTeammatePrivateMessage({
      localUserDisplayName,
      message,
      providerRecovered,
      teammateDisplayName: teammate.displayName,
      t,
    });
    const messageUsedMemoryEvents = filterUsedMemoryEventsByResponse(usedMemoryEvents, message.id);
    const taskCreateError = taskCreateErrors[message.id];
    const editing = ownsMessageChrome && messageController.editingMessageId === message.id;
    const messageFileRefs = message.fileRefs ?? [];
    const messageLinkPreviews = (message.linkPreviewIds ?? [])
      .map((id) => directLinkPreviewById.get(id))
      .filter((preview): preview is TeammateDirectLinkPreview => preview?.status === "ready" &&
        preview.teammateId === teammate.id && preview.threadId === message.threadId &&
        (!preview.messageId || preview.messageId === message.id));
    return (
      <MessageRow
        surface="teammate_direct"
        className={`teammate-message-row ${projection.authorType}${projection.blocked ? " blocked" : ""}`}
        authorType={projection.authorType}
        identityContinuation={projection.authorType === "ai-teammate" && !ownsIdentity}
        tone={projection.blocked ? "chat-blocked" : projection.authorType === "system" ? "system" : "document"}
        avatar={projection.authorType === "ai-teammate"
          ? <TeammateAvatarView teammate={teammate} cwd={cwd} compact />
          : projection.authorType === "system"
            ? <AvatarInitial label="S" tone="violet" />
            : <UserProfileAvatar profile={userProfile} fallbackLabel={localUserDisplayName} />}
        authorName={projection.authorName}
        createdAtLabel={formatDateTime(message.createdAt)}
        statusNode={message.editedAt ? <span className="conversation-message-edited-label">{t("Edited")}</span> : undefined}
        body={projection.body}
        bodyNode={editing ? (
          <div className="conversation-inline-message-editor-stack">
            <InlineMessageEditor
              initialValue={message.body}
              cwd={cwd}
              ariaLabel={t("Edit message")}
              saveLabel={t("Save and resend")}
              cancelLabel={t("Cancel")}
              saving={messageController.editSaving}
              onCancel={messageController.cancelEdit}
              onSave={(value) => messageController.saveEdit(message, value)}
            />
            {messageController.editError ? (
              <InlineFeedback className="teammate-message-error" tone="danger">
                {messageController.editError}
              </InlineFeedback>
            ) : null}
          </div>
        ) : body}
        bodyCwd={cwd}
        bodyCompact
        bodyStreaming={projection.pendingAiReply}
        // Model-text paths are display-only; only typed timeline evidence may open a file.
        bodyOnOpenLocalFile={undefined}
        attachmentsNode={ownsMessageChrome && ((message.attachmentIds ?? []).length > 0 || messageFileRefs.length > 0 || messageLinkPreviews.length > 0) ? (
          <>
            <ConversationAttachmentStrip
              className="teammate-message-attachments"
              chipClassName="teammate-attachment-chip"
              loadPreview={loadPreviewContent}
              attachments={(message.attachmentIds ?? [])
                .map((id) => privateAttachmentById.get(id))
                .filter((attachment): attachment is TeammatePrivateAttachment => Boolean(attachment &&
                  attachment.teammateId === teammate.id && (!attachment.threadId || attachment.threadId === message.threadId) &&
                  (!attachment.messageId || attachment.messageId === message.id)))
                .map((attachment) => ({
                  id: attachment.id,
                  label: attachment.fileName,
                  meta: formatBytes(attachment.sizeBytes),
                  href: attachmentContentUrl(attachment, cwd.trim()),
                  target: "_blank",
                  rel: "noreferrer",
                  icon: attachment.kind === "image" ? <Image size={13} /> : <FileText size={13} />,
                  previewRequest: attachmentCanPreview(attachment) ? {
                    source: "attachment",
                    cwd: cwd.trim(),
                    attachmentId: attachment.id,
                    scope: "teammate_private",
                    teammateId: teammate.id,
                  } : undefined,
                }))}
            />
            <ConversationReferenceStrip
              ariaLabel={t("References")}
              references={[
                ...messageFileRefs.map((fileRef, index) => ({
                  id: `file:${fileRef.path}:${fileRef.line ?? ""}:${index}`,
                  kind: "workspace_file" as const,
                  label: fileRef.label ?? teammateReferenceFileName(fileRef.path),
                  meta: fileRef.line !== undefined ? `${fileRef.path}:${fileRef.line}` : fileRef.path,
                  previewTitle: fileRef.label ?? teammateReferenceFileName(fileRef.path),
                  previewText: fileRef.path,
                  onOpen: () => onOpenFiles({
                    cwd: cwd.trim(),
                    path: fileRef.path,
                    ...(fileRef.line !== undefined ? { line: fileRef.line } : {}),
                    label: fileRef.label ?? teammateReferenceFileName(fileRef.path),
                  }),
                })),
                ...messageLinkPreviews.map((preview) => ({
                  id: `web:${preview.id}`,
                  kind: "web" as const,
                  label: preview.title ?? preview.siteName ?? teammateWebReferenceHost(preview.normalizedUrl || preview.url),
                  meta: preview.siteName ?? teammateWebReferenceHost(preview.normalizedUrl || preview.url),
                  href: preview.normalizedUrl || preview.url,
                  previewTitle: preview.title,
                  previewText: preview.description,
                })),
              ]}
            />
          </>
        ) : null}
        workCellNode={ownsMessageChrome && messageGeneratedMedia.length > 0 && message.authorType === "ai-teammate" ? (
          <ConversationGeneratedMediaBlock items={messageGeneratedMedia} cwd={cwd.trim()} />
        ) : null}
        evidenceNode={ownsMessageChrome && (messageUsedMemoryEvents.length > 0 || message.webEvidence) ? (
          <MessageEvidencePanel
            memoryContent={messageUsedMemoryEvents.length > 0 ? (
              <UsedMemorySummary variant="inline" events={messageUsedMemoryEvents} memoryById={memoryById} />
            ) : undefined}
            memorySummary={messageUsedMemoryEvents.length > 0 ? <UsedMemorySummaryLabel events={messageUsedMemoryEvents} /> : undefined}
            webEvidence={message.webEvidence}
          />
        ) : null}
        errorNode={ownsMessageChrome ? (
          <>
            {projection.errorText ? (
              <InlineFeedback className="teammate-message-error" tone="danger">
                {projection.errorText}
              </InlineFeedback>
            ) : null}
            {message.pendingReplacement ? (
              <ConversationReplacementRetry
                failureReason={messageController.replacementRetryError || message.pendingReplacement.failureReason}
                retryLabel={t("Retry response")}
                retrying={messageController.replacementRetryingMessageId === message.id}
                onRetry={() => void messageController.retryReplacement(message)}
              />
            ) : null}
            {taskCreateError ? (
              <InlineFeedback className="teammate-message-error" tone="danger">
                {taskCreateError}
              </InlineFeedback>
            ) : null}
          </>
        ) : null}
        actionsNode={message.authorType === "local-user" && ownsMessageChrome && !editing && !projection.pendingAiReply && !projection.blocked
          ? renderPrivateMessageActions(message, projection.copyBody) : null}
      />
    );
  }

  return (
    <div className="teammate-private-feed-owner" data-ui2-teammate-private-feed="true">
      <ConversationTimelineFeed
        surfaceId={`teammate:${teammate.id}`}
        readingScopeKey={conversationReadingScope(daemonBaseUrl, cwd, `teammate:${teammate.id}`, threadId ?? canonical.directThreadId)}
        scrollRef={privateFeedRef}
        ariaLabel={t("Private message feed")}
        frameClassName="message-feed-wrap"
        feedClassName="message-feed teammate-message-list"
        emptyFeedClassName="message-feed-empty"
        loading={loading}
        empty={visibleMessages.length === 0}
        loadingLabel={t("Loading teammate workspace...")}
        emptyIcon={<MessageSquare size={18} />}
        emptyLabel={normalizedMessageSearchQuery ? t("No private messages match search") : t("No private messages yet")}
        timelineId={`timeline:${timelineSnapshot.scope.threadId || "unbound"}`}
        onScroll={onPrivateFeedScroll}
        onUserScrollIntent={onCancelPrivateFeedAutoFollow}
        timelineNode={mountConversationTimeline({
            renderUserInputAvatar: (item) => item.kind === "userInputAnswer"
              ? <UserProfileAvatar profile={userProfile} fallbackLabel={localUserDisplayName} />
              : item.participantId === teammate.id ? <TeammateAvatarView teammate={teammate} cwd={cwd} compact /> : undefined,
            snapshot: timelineSnapshot,
            depth: 0,
            cwd: cwd.trim(),
            onSubmitUserInputAnswer: (command) => submitUserInputAnswer(cwd.trim(), command),
            virtualScrollRef: privateFeedRef,
            itemLocatorRef: timelineItemLocatorRef,
            onPositionNavigate: onCancelPrivateFeedAutoFollow,
            positionIdentity: (item) => item.kind === "userMessage" ? {
              name: localUserDisplayName,
              avatar: <UserProfileAvatar profile={userProfile} fallbackLabel={localUserDisplayName} />,
            } : {
              name: teammate.displayName,
              avatar: <TeammateAvatarView teammate={teammate} cwd={cwd} compact />,
            },
            onDisclosureIntent: onCancelPrivateFeedAutoFollow,
            onOpenSourceRef: handleOpenTimelineSourceRef,
            onOpenNativeFile: (localFile) => onOpenFiles({ path: localFile.path, line: localFile.line, localFile }),
            onOpenReview,
            renderResponseActions: (response, copyText) => {
              const itemId = response.message?.itemId;
              const messageId = itemId ? canonical.messageIds?.get(itemId) ?? itemId : undefined;
              const message = visibleMessages.find((candidate) => candidate.id === messageId);
              if (!message) return undefined;
              return renderPrivateMessageActions(message, copyText);
            },
            renderMessageChrome: (messageItem, body, presentation) => {
              const messageId = messageItem.itemId ? canonical.messageIds?.get(messageItem.itemId) ?? messageItem.itemId : undefined;
              const message = visibleMessages.find((candidate) => candidate.id === messageId);
              return message ? renderPrivateMessageRow(message, body, messageChromeOwnerIds.has(messageItem.id), presentation.ownsIdentity) : body;
            },
            ariaLabel: t("Private conversation transcript"),
          }).node}
        latestButtonNode={latestButtonVisible ? (
          <IconButton
            className="message-feed-latest-button"
            icon={ArrowDown}
            label={t("Jump to latest message")}
            onClick={onScrollToLatest}
          />
        ) : null}
      />
    </div>
  );
}
