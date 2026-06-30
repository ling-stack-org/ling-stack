import { CircleAlert, Loader2, Reply, Send, X } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { filterUsedMemoryEventsByResponse, UsedMemorySummary } from "../../shared/components/index.js";
import { MessageBodyRenderer } from "../../shared/conversation/index.js";
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
  readonly messageAuthorLabel: (message: ChannelMessage, teammates: readonly ChannelMention[]) => string;
}): JSX.Element {
  const { t } = useI18n();
  const canSend = draft.trim().length > 0 && !pending;
  const rootMessageIsOwn = rootMessage.authorType === "local-user";
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
        <MessageBodyRenderer text={rootMessage.body} cwd={cwd} compact />
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
          return (
            <article key={reply.id} className={replyIsOwn ? "thread-reply-item thread-reply-own" : "thread-reply-item"}>
              {replyIsOwn ? null : (
                <div className="thread-reply-meta">
                  <strong>{messageAuthorLabel(reply, teammates)}</strong>
                  {reply.kind === "ai_reply" ? <small>AI</small> : null}
                </div>
              )}
              <MessageBodyRenderer text={reply.body} cwd={cwd} compact />
              <UsedMemorySummary
                compact
                events={filterUsedMemoryEventsByResponse(usedMemoryEvents, reply.id)}
                memoryById={memoryById}
              />
            </article>
          );
        })}
      </div>
      <div className="thread-reply-composer">
        <textarea
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
