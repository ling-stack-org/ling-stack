import { ArrowDown, CircleAlert, Copy, Loader2, Pencil, Reply, Send, X } from "lucide-react";
import { projectTopicReplyTimeline } from "./topic-reply-timeline.js";
import { useI18n } from "../../i18n.js";
import { buildSurfaceTimelineSnapshot } from "../../domains/conversations/timeline-snapshot.js";
import { filterUsedMemoryEventsByResponse, UsedMemorySummary } from "../../shared/components/index.js";
import { ConversationReplacementRetry, ConversationTimelineFeed, InlineMessageEditor, MessageActionBar, MessageRow, mountConversationTimeline } from "../../shared/conversation/index.js";
import { useConversationReadingViewport } from "../../shared/conversation/blocks/use-conversation-reading-viewport.js";
import { IconButton, Textarea } from "../../shared/ui/index.js";
import { submitUserInputAnswer } from "../../api.js";
import type { ChannelMention, ChannelMessage, ConversationItemV1, ConversationReasoningSummaryRecord, MemoryObject, UsedMemoryEvent, UserInputTranscriptItemV1 } from "../../types.js";

export function ThreadReplyPanel({
  cwd,
  rootMessage,
  threadId,
  replies,
  conversationItems,
  userInputs,
  reasoningSummaries,
  teammates,
  memoryById,
  usedMemoryEvents,
  draft,
  pending,
  error,
  onDraftChange,
  onSend,
  onClose,
  editingMessageId,
  editSaving,
  editError,
  replacementRetryingMessageId,
  replacementRetryError,
  onBeginMessageEdit,
  onCancelMessageEdit,
  onSaveMessageEdit,
  onRetryMessageReplacement,
  onOpenFileReference,
  messageAuthorLabel,
}: {
  readonly cwd: string;
  readonly rootMessage: ChannelMessage;
  /** Verified topic LingThread.id. Empty while the topic snapshot is loading. */
  readonly threadId?: string;
  readonly replies: readonly ChannelMessage[];
  readonly conversationItems: readonly ConversationItemV1[];
  readonly userInputs: readonly UserInputTranscriptItemV1[];
  readonly reasoningSummaries: readonly ConversationReasoningSummaryRecord[];
  readonly teammates: readonly ChannelMention[];
  readonly memoryById: ReadonlyMap<string, MemoryObject>;
  readonly usedMemoryEvents: readonly UsedMemoryEvent[];
  readonly draft: string;
  readonly pending: boolean;
  readonly error: string;
  readonly onDraftChange: (value: string) => void;
  readonly onSend: () => void;
  readonly onClose: () => void;
  readonly editingMessageId?: string;
  readonly editSaving?: boolean;
  readonly editError?: string;
  readonly replacementRetryingMessageId?: string;
  readonly replacementRetryError?: string;
  readonly onBeginMessageEdit: (messageId: string) => void;
  readonly onCancelMessageEdit: () => void;
  readonly onSaveMessageEdit: (message: ChannelMessage, body: string) => void | Promise<void>;
  readonly onRetryMessageReplacement: (message: ChannelMessage) => void | Promise<void>;
  readonly onOpenFileReference: () => void;
  readonly messageAuthorLabel: (message: ChannelMessage, teammates: readonly ChannelMention[]) => string;
}): React.JSX.Element {
  const { t } = useI18n();
  const canSend = draft.trim().length > 0 && !pending;
  const latestOwnReplyId = [...replies].reverse().find((reply) => reply.authorType === "local-user" && !reply.pendingReplacement)?.id;
  const messages = [rootMessage, ...replies.filter((reply) => reply.id !== rootMessage.id)];
  const messageByTimelineId = new Map<string, ChannelMessage>();
  for (const message of messages) {
    messageByTimelineId.set(`message:${message.authorType === "local-user" ? "user" : "agent"}:${message.id}`, message);
  }
  const timelineItems = projectTopicReplyTimeline({
    workspaceId: rootMessage.workspaceId, channelId: rootMessage.channelId, threadId,
    rootMessage, replies, conversationItems, userInputs, reasoningSummaries,
  });
  const reading = useConversationReadingViewport({
    scopeKey: JSON.stringify([cwd, rootMessage.id, threadId]),
    revision: timelineItems,
    contentKey: timelineItems.map(item => item.id).join("|"),
  });
  const timelineNode = mountConversationTimeline({
    snapshot: buildSurfaceTimelineSnapshot({
      surface: "topic_reply",
      threadId,
      anchorItemId: rootMessage.threadAnchorItemId ?? rootMessage.id,
      items: timelineItems,
      canonicalRevision: timelineItems.reduce((max, item) => Math.max(max, item.revision), 0),
    }),
    depth: 0,
    cwd,
    onSubmitUserInputAnswer: (command) => submitUserInputAnswer(cwd, command),
    virtualScrollRef: reading.scrollRef,
    itemLocatorRef: reading.locatorRef,
    onDisclosureIntent: reading.pauseAutoFollow,
    onOpenSourceRef: () => onOpenFileReference(),
    renderMessageChrome: (item, body) => {
      const message = messageByTimelineId.get(item.id);
      if (!message) return body;
      const messageIsRoot = message.id === rootMessage.id;
      const editing = editingMessageId === message.id;
      const memoryEvents = filterUsedMemoryEventsByResponse(usedMemoryEvents, message.id);
      return (
        <MessageRow
          surface="topic_reply"
          className={messageIsRoot ? "thread-root-message-row" : message.authorType === "local-user" ? "thread-reply-item thread-reply-own" : "thread-reply-item"}
          authorType={message.authorType}
          tone={message.authorType === "system" ? "system" : "document"}
          authorName={messageAuthorLabel(message, teammates)}
          statusNode={(
            <>
              {messageIsRoot && message.authorType !== "local-user" ? (
                <small>{t("Topic started by {author}", { author: messageAuthorLabel(message, teammates) })}</small>
              ) : null}
              {message.editedAt ? <span className="conversation-message-edited-label">{t("Edited")}</span> : null}
            </>
          )}
          bodyNode={editing ? (
            <div className="conversation-inline-message-editor-stack">
              <InlineMessageEditor
                initialValue={message.body}
                cwd={cwd}
                ariaLabel={t("Edit message")}
                saveLabel={t("Save and resend")}
                cancelLabel={t("Cancel")}
                saving={editSaving}
                onCancel={onCancelMessageEdit}
                onSave={(value) => onSaveMessageEdit(message, value)}
              />
              {editError ? <div className="inline-error compact-inline-error" role="alert">{editError}</div> : null}
            </div>
          ) : body}
          evidenceNode={!editing && memoryEvents.length > 0 ? (
            <UsedMemorySummary compact events={memoryEvents} memoryById={memoryById} />
          ) : null}
          errorNode={message.pendingReplacement ? (
            <ConversationReplacementRetry
              failureReason={replacementRetryError || message.pendingReplacement.failureReason}
              retryLabel={t("Retry response")}
              retrying={replacementRetryingMessageId === message.id}
              onRetry={() => void onRetryMessageReplacement(message)}
            />
          ) : message.errorMessage ? (
            <div className="composer-status-row failed" role="alert"><CircleAlert size={14} /><span>{message.errorMessage}</span></div>
          ) : null}
          actionsNode={!editing ? (
            <MessageActionBar
              surface="topic_reply"
              actions={[
                { id: "copy", kind: "copy", label: t("Copy message"), icon: <Copy size={13} />, copyText: message.body },
                ...(message.id === latestOwnReplyId ? [{
                  id: "edit",
                  kind: "edit_latest" as const,
                  label: t("Edit message"),
                  icon: <Pencil size={13} />,
                  onClick: () => onBeginMessageEdit(message.id),
                }] : []),
              ]}
            />
          ) : null}
        />
      );
    },
    ariaLabel: t("Topic conversation transcript"),
  }).node;
  return (
    <aside className="thread-reply-panel" aria-label={t("Topic replies")}>
      <div className="thread-reply-head">
        <span>
          <Reply size={15} />
          <strong>{t("Topic replies")}</strong>
        </span>
        <button className="icon-button" type="button" onClick={onClose} aria-label={t("Close topic")}>
          <X size={14} />
        </button>
      </div>
      <ConversationTimelineFeed
        surfaceId={`topic:${rootMessage.id}`}
        scrollRef={reading.scrollRef}
        frameClassName="message-feed-wrap"
        feedClassName="thread-reply-list"
        ariaLabel={t("Replies")}
        loadingLabel={t("Loading...")}
        emptyLabel={t("No replies yet")}
        timelineId={`topic:${threadId ?? rootMessage.id}`}
        timelineNode={timelineNode}
        statusNode={timelineItems.length === 1 ? <div className="thread-empty-state">{t("No replies yet")}</div> : undefined}
        onScroll={reading.onScroll}
        onUserScrollIntent={reading.pauseAutoFollow}
        latestButtonNode={reading.latestButtonVisible ? <IconButton
          className="message-feed-latest-button"
          icon={ArrowDown}
          label={t("Jump to latest message")}
          onClick={() => reading.scrollToLatest("auto")}
        /> : undefined}
      />
      <div className="thread-reply-composer">
        <Textarea
          className="thread-reply-input"
          value={draft}
          rows={3}
          onChange={(event) => onDraftChange(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              onSend();
            }
          }}
          placeholder={t("Reply in this topic")}
          aria-label={t("Topic reply input")}
        />
        {error ? (
          <div className="composer-status-row failed" role="alert">
            <CircleAlert size={14} />
            <span>{error}</span>
          </div>
        ) : null}
        <button className="primary-button compact-button" type="button" onClick={onSend} disabled={!canSend}>
          {pending ? <Loader2 className="spin" size={14} /> : <Send size={14} />}
          {pending ? t("Sending...") : t("Send reply")}
        </button>
      </div>
    </aside>
  );
}
