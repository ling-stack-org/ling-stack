import { CircleAlert, Copy, Loader2, Pencil, Reply, Send, X } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { filterUsedMemoryEventsByResponse, UsedMemorySummary } from "../../shared/components/index.js";
import { ConversationReplacementRetry, InlineMessageEditor, MessageActionBar, MessageBodyRenderer, MessageRow } from "../../shared/conversation/index.js";
import { Textarea } from "../../shared/ui/index.js";
import type { ChannelMention, ChannelMessage, MemoryObject, UsedMemoryEvent } from "../../types.js";

export function ThreadReplyPanel({
  cwd,
  rootMessage,
  replies,
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
  readonly replies: readonly ChannelMessage[];
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
}): JSX.Element {
  const { t } = useI18n();
  const canSend = draft.trim().length > 0 && !pending;
  const rootMessageIsOwn = rootMessage.authorType === "local-user";
  const latestOwnReplyId = [...replies].reverse().find((reply) => reply.authorType === "local-user" && !reply.pendingReplacement)?.id;
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
      <div className="thread-root-message">
        {rootMessageIsOwn ? null : (
          <small>{t("Topic started by {author}", { author: messageAuthorLabel(rootMessage, teammates) })}</small>
        )}
        <MessageBodyRenderer text={rootMessage.body} cwd={cwd} compact onOpenLocalFile={onOpenFileReference} />
        <UsedMemorySummary
          compact
          events={filterUsedMemoryEventsByResponse(usedMemoryEvents, rootMessage.id)}
          memoryById={memoryById}
        />
      </div>
      <div className="thread-reply-list" aria-label={t("Replies")}>
        {replies.length === 0 ? (
          <div className="thread-empty-state">{t("No replies yet")}</div>
        ) : replies.map((reply) => {
          const replyIsOwn = reply.authorType === "local-user";
          const editing = editingMessageId === reply.id;
          return (
            <MessageRow
              surface="topic_reply"
              key={reply.id}
              className={replyIsOwn ? "thread-reply-item thread-reply-own" : "thread-reply-item"}
              authorType={reply.authorType}
              authorName={messageAuthorLabel(reply, teammates)}
              statusNode={reply.editedAt ? <span className="conversation-message-edited-label">{t("Edited")}</span> : undefined}
              bodyNode={editing ? (
                <div className="conversation-inline-message-editor-stack">
                  <InlineMessageEditor
                    initialValue={reply.body}
                    cwd={cwd}
                    ariaLabel={t("Edit message")}
                    saveLabel={t("Save and resend")}
                    cancelLabel={t("Cancel")}
                    saving={editSaving}
                    onCancel={onCancelMessageEdit}
                    onSave={(value) => onSaveMessageEdit(reply, value)}
                  />
                  {editError ? <div className="inline-error compact-inline-error" role="alert">{editError}</div> : null}
                </div>
              ) : <MessageBodyRenderer text={reply.body} cwd={cwd} compact onOpenLocalFile={onOpenFileReference} />}
              evidenceNode={!editing ? (
                <UsedMemorySummary
                  compact
                  events={filterUsedMemoryEventsByResponse(usedMemoryEvents, reply.id)}
                  memoryById={memoryById}
                />
              ) : null}
              errorNode={reply.pendingReplacement ? (
                <ConversationReplacementRetry
                  failureReason={replacementRetryError || reply.pendingReplacement.failureReason}
                  retryLabel={t("Retry response")}
                  retrying={replacementRetryingMessageId === reply.id}
                  onRetry={() => void onRetryMessageReplacement(reply)}
                />
              ) : null}
              actionsNode={!editing ? (
                <MessageActionBar
                  surface="topic_reply"
                  actions={[
                    { id: "copy", kind: "copy", label: t("Copy message"), icon: <Copy size={13} />, copyText: reply.body },
                    ...(reply.id === latestOwnReplyId ? [{
                      id: "edit",
                      kind: "edit_latest" as const,
                      label: t("Edit message"),
                      icon: <Pencil size={13} />,
                      onClick: () => onBeginMessageEdit(reply.id),
                    }] : []),
                  ]}
                />
              ) : null}
            />
          );
        })}
      </div>
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
            <span>{t("Message failed")}: {error}</span>
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
