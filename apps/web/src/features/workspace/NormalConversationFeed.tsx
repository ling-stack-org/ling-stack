import { useCallback, useMemo, useState, type ReactNode } from "react";
import { ArrowDown, Copy, FileText, Pencil } from "lucide-react";
import { attachmentContentUrl, submitUserInputAnswer } from "../../api.js";
import { useI18n } from "../../i18n.js";
import { attachmentCanPreview, loadPreviewContent } from "../../lib/previews.js";
import type { InlineApprovalView } from "../../lib/inline-approvals.js";
import {
  buildComposerGateApprovalPresentationByRunId,
  composerGateApprovalPresentationForRunId,
  type ComposerGateApprovalPresentation,
} from "../../lib/runtime-approval-presentation.js";
import {
  ConversationAttachmentStrip,
  ConversationGeneratedMediaBlock,
  ConversationTimelineFeed,
  mountConversationTimeline,
  ConversationReferenceStrip,
  ConversationReplacementRetry,
  InlineMessageEditor,
  MessageActionBar,
  MessageRow,
} from "../../shared/conversation/index.js";
import { IconButton, InlineFeedback } from "../../shared/ui/index.js";
import type { ConversationGeneratedMedia, RunSession } from "../../types.js";
import type {
  WorkspaceRightDockFileTarget,
  WorkspaceRightDockReviewTarget,
} from "./right-dock/index.js";
import {
  projectNormalConversationFeedItems,
  type NormalConversationFeedItem,
} from "./normal-conversation-feed-view-models.js";
import type {
  ConversationHomeDetailContext,
  ConversationHomeMessage,
} from "./normal-conversation-types.js";
import { buildSurfaceTimelineSnapshot } from "../../domains/conversations/timeline-snapshot.js";
import {
  flattenNormalTimelineItems,
  maxTimelineRevision,
  selectNormalTimelineItems,
} from "./normal-conversation-timeline-items.js";
import { requestTimelineWorkspaceFileOpen } from "../../shared/conversation/timeline/workspace-file-capability.js";
import { timelineMessageChromeOwnerIds } from "../../shared/conversation/timeline/timeline-message-chrome-owners.js";
import { NormalConversationResponseActions } from "./NormalConversationResponseActions.js";
import { useConversationReadingViewport } from "../../shared/conversation/blocks/use-conversation-reading-viewport.js";

export interface NormalConversationFeedProps {
  readonly messages: readonly ConversationHomeMessage[];
  readonly visibleMessages: readonly ConversationHomeMessage[];
  readonly runById: ReadonlyMap<string, RunSession>;
  readonly detailContext?: ConversationHomeDetailContext;
  readonly composerGateApprovals: readonly InlineApprovalView[];
  readonly generatedMedia: readonly ConversationGeneratedMedia[];
  readonly projectPath?: string;
  readonly workspaceCwd: string;
  readonly searchActive: boolean;
  readonly editingMessageId?: string;
  readonly editSaving: boolean;
  readonly latestEditableUserMessageId?: string;
  readonly replacementRetryingMessageId?: string;
  readonly replacementRetryError: string;
  readonly onCancelMessageEdit: () => void;
  readonly onEditMessage: (messageId: string) => void;
  readonly onSaveMessage: (message: ConversationHomeMessage, body: string) => void | Promise<void>;
  readonly onRetryReplacement: (message: ConversationHomeMessage) => void | Promise<void>;
  readonly onOpenFiles: () => void;
  readonly onOpenReportFile: (target: WorkspaceRightDockFileTarget) => void;
  readonly onOpenReview: (target: WorkspaceRightDockReviewTarget) => void;
  readonly onOpenRun?: (runId: string) => void;
}

export function NormalConversationFeed({
  detailContext,
  composerGateApprovals,
  editSaving,
  editingMessageId,
  latestEditableUserMessageId,
  messages,
  generatedMedia,
  onCancelMessageEdit,
  onEditMessage,
  onOpenFiles,
  onOpenReportFile,
  onOpenReview,
  onOpenRun,
  onRetryReplacement,
  onSaveMessage,
  projectPath,
  replacementRetryError,
  replacementRetryingMessageId,
  runById,
  searchActive,
  visibleMessages,
  workspaceCwd,
}: NormalConversationFeedProps): React.JSX.Element {
  const { t } = useI18n();
  const [feedbackById, setFeedbackById] = useState<Record<string, "up" | "down">>({});
  const composerGateApprovalByRunId = useMemo(
    () => buildComposerGateApprovalPresentationByRunId(composerGateApprovals, t),
    [composerGateApprovals, t],
  );
  const feedItems = useMemo(() => projectNormalConversationFeedItems({
    detailContext,
    messages,
    projectPath,
    runById,
    t,
    visibleMessages,
    workspaceCwd,
  }), [detailContext, messages, projectPath, runById, t, visibleMessages, workspaceCwd]);
  const generatedMediaByRunId = useMemo(() => groupGeneratedMediaByRunId(generatedMedia), [generatedMedia]);
  const timelineSnapshot = useMemo(() => {
    const canonicalItems = detailContext?.timelineProjection?.items;
    const items = canonicalItems && canonicalItems.length > 0
      ? selectNormalTimelineItems(canonicalItems, feedItems)
      : flattenNormalTimelineItems(feedItems);
    const activeMessage = feedItems.find((item) => item.bodyStreaming && item.message.runId);
    const activeRun = activeMessage?.message.runId
      ? {
          runId: activeMessage.message.runId,
          status: "working" as const,
          workspaceLabel: projectPath?.trim() || workspaceCwd.trim(),
          cwd: projectPath?.trim() || workspaceCwd.trim(),
          branch: null,
          modelLabel: null,
          sourceRefs: [],
        }
      : null;
    return buildSurfaceTimelineSnapshot({
      surface: "normal_conversation",
      threadId: detailContext?.threadId ?? feedItems.find((item) => item.message.threadId)?.message.threadId,
      items,
      activeRun,
      runLifecycles: runById,
      contextSegmentIdByItemId: detailContext?.timelineProjection?.contextSegmentIdByItemId,
      canonicalRevision: maxTimelineRevision(items),
    });
  }, [detailContext, feedItems, projectPath, runById, workspaceCwd]);
  const messageChromeOwnerIds = useMemo(
    () => timelineMessageChromeOwnerIds(timelineSnapshot.items),
    [timelineSnapshot.items],
  );
  const feedItemByMessageId = useMemo(
    () => new Map(feedItems.flatMap((item) => [
      [item.message.id, item] as const,
      ...(item.message.canonicalItemId ? [[item.message.canonicalItemId, item] as const] : []),
    ])),
    [feedItems],
  );
  const workspaceId = detailContext?.executionActions.find((action) => action.workspaceId.trim())?.workspaceId;
  const timelineThreadId = detailContext?.threadId ?? feedItems.find((item) => item.message.threadId)?.message.threadId;
  const handleOpenTimelineSourceRef = useCallback(async (
    ref: import("@ling-stack/conversation-ui-core").ConversationOperationSourceRef,
    item?: import("@ling-stack/conversation-ui-core").ConversationTimelineItem,
  ): Promise<void> => {
    if (ref.kind !== "file" && ref.kind !== "path" && ref.kind !== "diff" && ref.kind !== "artifact") {
      throw new Error("This source is not an openable workspace resource.");
    }
    await requestTimelineWorkspaceFileOpen(ref, item, {
      cwd: projectPath?.trim() || workspaceCwd.trim(),
      workspaceId,
      threadId: timelineThreadId,
    }, onOpenReportFile);
  }, [onOpenReportFile, projectPath, timelineThreadId, workspaceCwd, workspaceId]);
  const itemIdentityKey = useMemo(
    () => feedItems.map((item) => item.message.id).join("|"),
    [feedItems],
  );

  const {
    scrollRef: feedRef,
    locatorRef: timelineItemLocatorRef,
    latestButtonVisible,
    scrollToLatest,
    pauseAutoFollow: pauseTimelineAutoFollow,
    onScroll: handleFeedScroll,
  } = useConversationReadingViewport({
    scopeKey: timelineSnapshot.scope.threadId,
    revision: feedItems,
    contentKey: itemIdentityKey,
    searchActive,
  });

  function toggleFeedback(messageId: string, feedback: "up" | "down"): void {
    setFeedbackById((current) => {
      if (current[messageId] === feedback) {
        const next = { ...current };
        delete next[messageId];
        return next;
      }
      return { ...current, [messageId]: feedback };
    });
  }

  return (
    <ConversationTimelineFeed
      surfaceId={`normal:${timelineSnapshot.scope.threadId}`}
      scrollRef={feedRef}
      frameClassName="normal-conversation-feed-frame"
      feedClassName="normal-conversation-feed"
      ariaLabel={t("Conversation messages")}
      timelineId={`timeline:${timelineSnapshot.scope.threadId}`}
      empty={feedItems.length === 0}
      loadingLabel={t("Loading messages...")}
      emptyLabel={searchActive ? t("No matching conversation messages") : t("No conversation messages yet")}
      onScroll={handleFeedScroll}
      onUserScrollIntent={pauseTimelineAutoFollow}
      timelineNode={(
        <div className="normal-conversation-timeline-surface" data-conversation-surface-timeline="normal">
          {mountConversationTimeline({
            snapshot: timelineSnapshot,
            depth: 0,
            cwd: projectPath?.trim() || workspaceCwd.trim(),
            onSubmitUserInputAnswer: (command) => submitUserInputAnswer(projectPath?.trim() || workspaceCwd.trim(), command),
            virtualScrollRef: feedRef,
            itemLocatorRef: timelineItemLocatorRef,
            onDisclosureIntent: pauseTimelineAutoFollow,
            onOpenSourceRef: handleOpenTimelineSourceRef,
            onOpenNativeFile: (localFile) => onOpenReportFile({ path: localFile.path, line: localFile.line, localFile }),
            onOpenReview,
            renderResponseActions: (response, copyText) => {
              const messageId = response.message?.logicalMessageId ?? response.message?.itemId;
              const item = messageId ? feedItemByMessageId.get(messageId) : undefined;
              if (!item || item.message.role !== "assistant" || !item.message.content) return undefined;
              return <NormalConversationResponseActions
                copyText={copyText}
                feedback={feedbackById[item.message.id]}
                onToggleFeedback={(value) => toggleFeedback(item.message.id, value)} />;
            },
            renderMessageChrome: (messageItem, body) => {
              const messageId = messageItem.logicalMessageId ?? messageItem.itemId;
              const item = messageId ? feedItemByMessageId.get(messageId) : undefined;
              if (!item) return body;
              return (
                <NormalConversationMessageRow
                  item={item}
                  bodyNodeOverride={body}
                  ownsMessageChrome={messageChromeOwnerIds.has(messageItem.id)}
                  composerGateApproval={composerGateApprovalPresentationForRunId(item.message.runId, composerGateApprovalByRunId)}
                  generatedMedia={item.message.runId ? generatedMediaByRunId.get(item.message.runId) ?? [] : []}
                  editing={editingMessageId === item.message.id}
                  editSaving={editSaving}
                  editable={item.message.id === latestEditableUserMessageId}
                  replacementRetrying={replacementRetryingMessageId === item.message.id}
                  replacementRetryError={replacementRetryError}
                  projectPath={projectPath}
                  workspaceCwd={workspaceCwd}
                  onCancelEdit={onCancelMessageEdit}
                  onEdit={() => onEditMessage(item.message.id)}
                  onSave={(nextBody) => onSaveMessage(item.message, nextBody)}
                  onRetryReplacement={() => onRetryReplacement(item.message)}
                  onOpenFiles={onOpenFiles}
                  onOpenReview={onOpenReview}
                  onOpenRun={onOpenRun}
                />
              );
            },
            ariaLabel: t("Conversation transcript"),
          }).node}
        </div>
      )}
      latestButtonNode={latestButtonVisible ? (
        <IconButton
          className="message-feed-latest-button normal-conversation-latest-button"
          icon={ArrowDown}
          label={t("Jump to latest message")}
          onClick={() => scrollToLatest()}
        />
      ) : null}
    />
  );
}

function NormalConversationMessageRow({
  bodyNodeOverride,
  ownsMessageChrome,
  composerGateApproval,
  editSaving,
  editable,
  editing,
  item,
  generatedMedia,
  onCancelEdit,
  onEdit,
  onOpenFiles,
  onOpenReview,
  onOpenRun,
  onRetryReplacement,
  onSave,
  projectPath,
  replacementRetryError,
  replacementRetrying,
  workspaceCwd,
}: {
  readonly item: NormalConversationFeedItem;
  /** Body is supplied by the owning surface Timeline renderer. */
  readonly bodyNodeOverride: ReactNode;
  /** Message resources/actions belong to one segment, not each narration row. */
  readonly ownsMessageChrome: boolean;
  readonly composerGateApproval?: ComposerGateApprovalPresentation;
  readonly generatedMedia: readonly ConversationGeneratedMedia[];
  readonly editing: boolean;
  readonly editSaving: boolean;
  readonly editable: boolean;
  readonly replacementRetrying: boolean;
  readonly replacementRetryError: string;
  readonly projectPath?: string;
  readonly workspaceCwd: string;
  readonly onCancelEdit: () => void;
  readonly onEdit: () => void;
  readonly onSave: (body: string) => void | Promise<void>;
  readonly onRetryReplacement: () => void | Promise<void>;
  readonly onOpenFiles: () => void;
  readonly onOpenReview: (target: WorkspaceRightDockReviewTarget) => void;
  readonly onOpenRun?: (runId: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const { message } = item;
  const blockedAgentMessage = item.authorType === "ai-teammate"
    && (Boolean(composerGateApproval) || message.status === "blocked");
  const actionsReady = message.role !== "assistant"
    || message.status === "succeeded" || message.status === "failed" || message.status === "cancelled";
  return (
    <MessageRow
      surface="normal_conversation"
      className={item.className}
      authorType={item.authorType}
      tone={item.authorType === "system" ? "system" : "document"}
      authorName={item.authorName}
      createdAtLabel={item.createdAtLabel}
      statusNode={message.editedAt ? <span className="conversation-message-edited-label">{t("Edited")}</span> : undefined}
      body={item.body}
      bodyCwd={projectPath?.trim() || workspaceCwd.trim()}
      bodyNode={ownsMessageChrome && editing ? (
        <InlineMessageEditor
          initialValue={message.content}
          cwd={projectPath?.trim() || workspaceCwd.trim()}
          ariaLabel={t("Edit message")}
          saveLabel={t("Save and resend")}
          cancelLabel={t("Cancel")}
          saving={editSaving}
          warning={item.workspaceMayHaveChanged ? t("This turn changed the workspace. The edited prompt will continue from the current state.") : undefined}
          onCancel={onCancelEdit}
          onSave={onSave}
        />
      ) : bodyNodeOverride}
      bodyCompact
      bodyStreaming={item.bodyStreaming}
      // Model-text paths are display-only. Only typed timeline evidence with
      // a complete execution lineage may open a workspace file.
      bodyOnOpenLocalFile={undefined}
      attachmentsNode={ownsMessageChrome && ((message.attachments?.length ?? 0) > 0 || (message.fileRefs?.length ?? 0) > 0) ? (
        <>
          <ConversationAttachmentStrip
            attachments={(message.attachments ?? []).map((attachment) => ({
            id: attachment.id,
            label: attachment.fileName,
            meta: formatBytes(attachment.sizeBytes),
            icon: <FileText size={13} />,
            href: attachmentContentUrl(attachment, workspaceCwd.trim()),
            target: "_blank",
            rel: "noreferrer",
            previewRequest: attachmentCanPreview(attachment) ? {
              source: "attachment",
              cwd: workspaceCwd.trim(),
              attachmentId: attachment.id,
              scope: "conversation",
              threadId: message.threadId,
              maxBytes: 64_000,
            } : undefined,
            }))}
            loadPreview={loadPreviewContent}
          />
          <ConversationReferenceStrip
            ariaLabel={t("References")}
            references={(message.fileRefs ?? []).map((fileRef, index) => ({
              id: `file:${fileRef.path}:${fileRef.line ?? ""}:${index}`,
              kind: "workspace_file" as const,
              label: fileRef.label ?? fileRef.path.split(/[\\/]/u).filter(Boolean).at(-1) ?? fileRef.path,
              meta: fileRef.line !== undefined ? `${fileRef.path}:${fileRef.line}` : fileRef.path,
              previewTitle: fileRef.label,
              previewText: fileRef.path,
            }))}
          />
        </>
      ) : null}
      workCellNode={ownsMessageChrome && generatedMedia.length > 0 ? (
        <>
          {message.role === "assistant" ? (
            <ConversationGeneratedMediaBlock items={generatedMedia} cwd={workspaceCwd.trim()} />
          ) : null}
        </>
      ) : null}
      errorNode={ownsMessageChrome ? (
        <>
          {item.errorText ? (
            <InlineFeedback
              className="normal-conversation-message-error"
              tone="danger"
              title={item.errorText}
            />
          ) : null}
          {message.pendingReplacement ? (
            <ConversationReplacementRetry
              failureReason={replacementRetryError || message.pendingReplacement.failureReason}
              retryLabel={t("Retry response")}
              retrying={replacementRetrying}
              onRetry={() => void onRetryReplacement()}
            />
          ) : null}
        </>
      ) : null}
      actionsNode={message.role === "user" && ownsMessageChrome && actionsReady && message.content && !editing && !blockedAgentMessage ? (
        <MessageActionBar
          surface="normal_conversation"
          className="normal-conversation-message-actions"
          actions={[
            {
              id: "copy",
              kind: "copy",
              label: t("Copy message"),
              icon: <Copy size={14} />,
              copyText: message.content,
            },
            ...(editable ? [{
              id: "edit",
              kind: "edit_latest" as const,
              label: t("Edit message"),
              icon: <Pencil size={14} />,
              onClick: onEdit,
            }] : []),
          ]}
        />
      ) : null}
    />
  );
}

function groupGeneratedMediaByRunId(
  items: readonly ConversationGeneratedMedia[],
): ReadonlyMap<string, readonly ConversationGeneratedMedia[]> {
  const grouped = new Map<string, ConversationGeneratedMedia[]>();
  for (const item of items) {
    grouped.set(item.runId, [...(grouped.get(item.runId) ?? []), item]);
  }
  return grouped;
}


function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
