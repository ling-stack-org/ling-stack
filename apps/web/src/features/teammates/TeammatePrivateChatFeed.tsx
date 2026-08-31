import { useMemo } from "react";
import { ArrowDown, Copy, FileText, Image, Loader2, MessageSquare, Pencil, Plus, ThumbsDown, ThumbsUp } from "lucide-react";
import { createConversationTimelineMessageItem, getConversationInteractionPolicy, type ConversationTimelineItem } from "@ling-stack/conversation-ui-core";
import { attachmentContentUrl } from "../../api.js";
import { useI18n } from "../../i18n.js";
import { formatDateTime } from "../../lib/formatting.js";
import { attachmentCanPreview, loadPreviewContent } from "../../lib/previews.js";
import {
  buildComposerGateApprovalPresentationByRunId,
  composerGateApprovalPresentationForWorkCell,
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
  ConversationTimeline,
  ConversationGeneratedMediaBlock,
  ConversationReferenceStrip,
  ConversationReplacementRetry,
  ConversationVirtualFeed,
  ConversationViewProvider,
  InlineMessageEditor,
  MessageActionBar,
  MessageEvidencePanel,
  MessageRow,
} from "../../shared/conversation/index.js";
import { IconButton, InlineFeedback } from "../../shared/ui/index.js";
import type { ConversationGeneratedMedia, TeammateDirectLinkPreview, TeammateDirectMessage, TeammatePrivateAttachment } from "../../types.js";
import { TeammateAvatarView } from "./TeammateAvatarView.js";
import type { TeammatePrivateChatSurfaceProps } from "./teammate-private-chat-types.js";
import {
  buildTeammatePrivateWorkCellMap,
  projectTeammatePrivateMessage,
  teammateReferenceFileName,
  teammateWebReferenceHost,
  teammateWorkspaceFileTarget,
} from "./teammate-private-chat-view-models.js";
import { conversationTimelineItemsForModel } from "../../lib/conversation-work-cell.js";
import { formatBytes } from "./teammate-workspace-utils.js";
import type { TeammatePrivateMessageController } from "./useTeammatePrivateMessageController.js";

function privateMessageTimelineItems(input: {
  readonly message: TeammateDirectMessage;
  readonly body: string;
  readonly facts: readonly ConversationTimelineItem[];
}): readonly ConversationTimelineItem[] {
  const messageItem = createConversationTimelineMessageItem({
    id: `message:${input.message.authorType === "local-user" ? "user" : "agent"}:${input.message.id}`,
    role: input.message.authorType === "local-user" ? "user" : "agent",
    markdown: input.body,
    phase: input.message.authorType === "ai-teammate" && input.message.status === "ready" ? "final" : "commentary",
    revision: input.message.revision,
    threadSequence: 0,
    status: privateMessageTimelineStatus(input.message.status),
    itemId: input.message.id,
  });
  return [messageItem, ...input.facts]
    .filter((candidate, index, all) => all.findIndex((other) => other.id === candidate.id) === index)
    .sort((left, right) => left.threadSequence - right.threadSequence || left.partIndex - right.partIndex || left.id.localeCompare(right.id));
}

function privateMessageTimelineStatus(status: TeammateDirectMessage["status"]): ConversationTimelineItem["status"] {
  switch (status) {
    case "pending": return "running";
    case "blocked": return "blocked";
    case "failed": return "failed";
    case "cancelled": return "cancelled";
    case "ready": return "succeeded";
    default: return "pending";
  }
}

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
  | "privateMessageFeedVirtualRows"
  | "privateMessageFeedVirtualizer"
  | "providerRecovered"
  | "runs"
  | "taskCreateBusyKeys"
  | "taskCreateErrors"
  | "taskChannelOptions"
  | "teammate"
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
  privateMessageFeedVirtualRows,
  privateMessageFeedVirtualizer,
  providerRecovered,
  runs,
  taskCreateBusyKeys,
  taskCreateErrors,
  taskChannelOptions,
  teammate,
  terminalReports,
  usedMemoryEvents,
  userProfile,
  visibleMessages,
}: TeammatePrivateChatFeedProps): React.JSX.Element {
  const { t } = useI18n();
  const localUserDisplayName = userProfile?.displayName.trim() || t("You");
  const runById = useMemo(() => new Map(runs.map((run) => [run.id, run])), [runs]);
  const composerGateApprovalByRunId = useMemo(
    () => buildComposerGateApprovalPresentationByRunId(composerGateApprovals, t),
    [composerGateApprovals, t],
  );
  const workCellByMessageId = useMemo(() => buildTeammatePrivateWorkCellMap({
    messages: visibleMessages,
    teammateId: teammate.id,
    runs,
    executionActions,
    approvals,
    terminalReports,
    t,
  }), [approvals, executionActions, runs, teammate.id, t, terminalReports, visibleMessages]);

  return (
    <div className="teammate-private-feed-owner" data-ui2-teammate-private-feed="true">
      <ConversationViewProvider surfaceId={`teammate:${teammate.id}`}>
        <ConversationVirtualFeed
          scrollRef={privateFeedRef}
          ariaLabel={t("Private message feed")}
          feedClassName="message-feed teammate-message-list"
          emptyFeedClassName="message-feed teammate-message-list message-feed-empty"
          loading={false}
          empty={!loading && visibleMessages.length === 0}
          loadingLabel={t("Loading teammate workspace...")}
          emptyIcon={<MessageSquare size={18} />}
          emptyLabel={normalizedMessageSearchQuery ? t("No private messages match search") : t("No private messages yet")}
          totalSize={privateMessageFeedVirtualizer.getTotalSize()}
          virtualRows={privateMessageFeedVirtualRows}
          items={visibleMessages}
          getItemId={(message) => message.id}
          getItemKind={(message) => message.authorType}
          measureElement={privateMessageFeedVirtualizer.measureElement}
          onScroll={onPrivateFeedScroll}
          onUserScrollIntent={onCancelPrivateFeedAutoFollow}
          renderItem={(message) => {
            const workCell = workCellByMessageId.get(message.id);
            const messageGeneratedMedia = generatedMediaForDirectMessage(generatedMedia, message);
            const projection = projectTeammatePrivateMessage({
              localUserDisplayName,
              message,
              providerRecovered,
              teammateDisplayName: teammate.displayName,
              t,
            });
            const messageUsedMemoryEvents = filterUsedMemoryEventsByResponse(usedMemoryEvents, message.id);
            const workCellRun = workCell ? runById.get(workCell.model.anchorRunId) : undefined;
            const composerApprovalId = workCell
              ? composerGateApprovalPresentationForWorkCell(workCell.model, composerGateApprovalByRunId)?.approvalId
              : undefined;
            const timelineItems = privateMessageTimelineItems({
              message,
              body: projection.body,
              facts: workCell
                ? conversationTimelineItemsForModel(workCell.model, composerApprovalId)
                : [],
            });
            const messageFeedback = messageController.feedbackById[message.id];
            const taskCreateKey = `message:${message.id}`;
            const taskCreateBusy = taskCreateBusyKeys.has(taskCreateKey);
            const taskCreateError = taskCreateErrors[message.id];
            const editing = messageController.editingMessageId === message.id;
            const actionMessage = projection.userGuidance
              ? { ...message, body: projection.body }
              : message;
            const messageFileRefs = message.fileRefs ?? [];
            const messageLinkPreviews = (message.linkPreviewIds ?? [])
              .map((id) => directLinkPreviewById.get(id))
              .filter((preview): preview is TeammateDirectLinkPreview => preview?.status === "ready");
            const feedbackActions = message.authorType === "ai-teammate" ? [
              {
                id: "like",
                kind: "like" as const,
                label: t("Like response"),
                icon: <ThumbsUp size={14} />,
                selected: messageFeedback === "up",
                onClick: () => messageController.toggleFeedback(message.id, "up"),
              },
              {
                id: "dislike",
                kind: "dislike" as const,
                label: t("Dislike response"),
                icon: <ThumbsDown size={14} />,
                selected: messageFeedback === "down",
                onClick: () => messageController.toggleFeedback(message.id, "down"),
              },
            ] : [];

            return (
              <MessageRow
                surface="teammate_direct"
                className={`teammate-message-row ${projection.authorType}${projection.blocked ? " blocked" : ""}`}
                authorType={projection.authorType}
                tone={projection.blocked ? "chat-blocked" : undefined}
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
                ) : (
                  <ConversationTimeline
                    items={timelineItems}
                    policy={getConversationInteractionPolicy("teammate_direct")}
                    timelineId={`message:${message.id}`}
                    threadId={message.threadId}
                    sourceKind="private"
                    activityMode={projection.pendingAiReply ? "active" : "completed"}
                    cwd={cwd.trim()}
                    onOpenSourceRef={(ref) => {
                      if ((ref.kind === "file" || ref.kind === "path") && ref.path) {
                        onOpenFiles({ cwd: cwd.trim(), path: ref.path, label: ref.label });
                      }
                    }}
                    ariaLabel={t("Private conversation transcript")}
                  />
                )}
                bodyCwd={cwd}
                bodyCompact
                bodyStreaming={projection.pendingAiReply}
                bodyOnOpenLocalFile={(reference) => onOpenFiles(teammateWorkspaceFileTarget(reference))}
                attachmentsNode={(message.attachmentIds ?? []).length > 0 || messageFileRefs.length > 0 || messageLinkPreviews.length > 0 ? (
                  <>
                    <ConversationAttachmentStrip
                      className="teammate-message-attachments"
                      chipClassName="teammate-attachment-chip"
                      loadPreview={loadPreviewContent}
                      attachments={(message.attachmentIds ?? [])
                        .map((id) => privateAttachmentById.get(id))
                        .filter((attachment): attachment is TeammatePrivateAttachment => Boolean(attachment))
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
                            path: fileRef.path,
                            line: fileRef.line,
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
                workCellNode={messageGeneratedMedia.length > 0 ? (
                  <>
                    {message.authorType === "ai-teammate" ? (
                      <ConversationGeneratedMediaBlock items={messageGeneratedMedia} cwd={cwd.trim()} />
                    ) : null}
                  </>
                ) : null}
                evidenceNode={messageUsedMemoryEvents.length > 0 || message.webEvidence ? (
                  <MessageEvidencePanel
                    memoryContent={messageUsedMemoryEvents.length > 0 ? (
                      <UsedMemorySummary variant="inline" events={messageUsedMemoryEvents} memoryById={memoryById} />
                    ) : undefined}
                    memorySummary={messageUsedMemoryEvents.length > 0 ? <UsedMemorySummaryLabel events={messageUsedMemoryEvents} /> : undefined}
                    webEvidence={message.webEvidence}
                  />
                ) : null}
                errorNode={(
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
                )}
                actionsNode={!editing ? (
                  <MessageActionBar
                    surface="teammate_direct"
                    className="teammate-message-actions"
                    copiedLabel={t("Copied")}
                    actions={[
                      {
                        id: "copy",
                        kind: "copy",
                        label: t("Copy message"),
                        icon: <Copy size={14} />,
                        onClick: () => onCopyMessageText(projection.copyBody),
                      },
                      ...(message.authorType === "local-user" && message.id === messageController.latestEditableMessageId ? [{
                        id: "edit",
                        kind: "edit_latest" as const,
                        label: t("Edit message"),
                        icon: <Pencil size={14} />,
                        onClick: () => messageController.beginEdit(message.id),
                      }] : []),
                      ...feedbackActions,
                      {
                        id: "create-task",
                        kind: "create_task" as const,
                        label: t("Create task"),
                        icon: taskCreateBusy ? <Loader2 className="spin" size={14} /> : <Plus size={14} />,
                        disabled: taskCreateBusy || taskChannelOptions.length === 0,
                        loading: taskCreateBusy,
                        onClick: () => void onCreateTaskFromMessage(actionMessage),
                      },
                    ]}
                  />
                ) : null}
              />
            );
          }}
          latestButtonNode={latestButtonVisible ? (
            <IconButton
              className="message-feed-latest-button"
              icon={ArrowDown}
              label={t("Jump to latest message")}
              onClick={onScrollToLatest}
            />
          ) : null}
        />
      </ConversationViewProvider>
    </div>
  );
}

function generatedMediaForDirectMessage(
  items: readonly ConversationGeneratedMedia[],
  message: TeammatePrivateChatSurfaceProps["visibleMessages"][number],
): readonly ConversationGeneratedMedia[] {
  return items.filter((item) => item.messageId
    ? item.messageId === message.id
    : Boolean(message.linkedRunId && item.runId === message.linkedRunId));
}
