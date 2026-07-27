import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { MessageBodyRenderer } from "./MessageBodyRenderer.js";

export type MessageBubbleTone = "chat" | "chat-blocked" | "system" | "work" | "approval" | "protocol" | "runtime";

export interface MessageBubbleProps {
  readonly className?: string;
  readonly tone?: MessageBubbleTone;
  readonly side?: "start" | "end";
  readonly avatar: ReactNode;
  readonly author: string;
  readonly tag?: string;
  readonly time?: string;
  readonly body?: string;
  readonly bodyCwd?: string;
  readonly bodyCompact?: boolean;
  readonly bodyNode?: ReactNode;
  readonly showOwnAuthor?: boolean;
  readonly pending?: boolean;
  readonly metaAction?: ReactNode;
  readonly action?: ReactNode;
  readonly attachmentsNode?: ReactNode;
  readonly evidenceNode?: ReactNode;
  readonly errorNode?: ReactNode;
}

export function MessageBubble({
  className,
  tone = "chat",
  side = "start",
  avatar,
  author,
  tag,
  time = "",
  body,
  bodyCwd,
  bodyCompact = true,
  bodyNode,
  showOwnAuthor = false,
  pending = false,
  metaAction,
  action,
  attachmentsNode,
  evidenceNode,
  errorNode,
}: MessageBubbleProps): JSX.Element {
  const hasAvatar = avatar !== null && avatar !== undefined && avatar !== false;
  const inlineAuthor = tone === "chat" || tone === "chat-blocked";
  const sideClass = inlineAuthor ? side === "end" ? "message-bubble-own" : "message-bubble-peer" : "";
  const ownMessage = inlineAuthor && side === "end";
  const peerMessage = inlineAuthor && side === "start";
  const showOwnIdentity = ownMessage && showOwnAuthor;
  const showTime = !inlineAuthor && time.length > 0;
  const rootClassName = [
    "message-bubble",
    `message-bubble-${tone}`,
    inlineAuthor ? "message-bubble-inline" : "",
    sideClass,
    showOwnIdentity ? "message-bubble-own-with-author" : "",
    pending ? "message-bubble-pending" : "",
    className,
  ].filter(Boolean).join(" ");
  const resolvedBodyNode = bodyNode ?? (body ? <MessageBodyRenderer text={body} cwd={bodyCwd} compact={bodyCompact} streaming={pending} /> : null);

  return (
    <article
      className={rootClassName}
      data-conversation-message-row="true"
      data-has-avatar={hasAvatar ? "true" : "false"}
    >
      {!inlineAuthor || peerMessage ? avatar : null}
      <div className={metaAction ? "message-content has-floating-action" : "message-content"}>
        {ownMessage ? (
          metaAction ? <span className="message-meta-action">{metaAction}</span> : null
        ) : (
          <div className={metaAction ? "message-meta has-meta-action" : "message-meta"}>
            <strong>{author}</strong>
            {tag ? <small>{tag}</small> : null}
            {showTime ? <time>{time}</time> : null}
            {metaAction ? <span className="message-meta-action">{metaAction}</span> : null}
          </div>
        )}
        {resolvedBodyNode ? (
          <div className={pending ? "message-body-shell message-body-with-spinner" : "message-body-shell"}>
            {pending ? <Loader2 className="message-pending-spinner spin" size={13} /> : null}
            {resolvedBodyNode}
          </div>
        ) : null}
        {attachmentsNode}
        {evidenceNode}
        {errorNode}
        {action ? <div className="message-action">{action}</div> : null}
      </div>
      {showOwnIdentity ? (
        <div className="message-own-identity">
          <strong>{author}</strong>
          {avatar}
        </div>
      ) : ownMessage ? avatar : null}
    </article>
  );
}
