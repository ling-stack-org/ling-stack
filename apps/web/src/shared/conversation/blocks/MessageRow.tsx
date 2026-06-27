import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { MessageBodyRenderer } from "./MessageBodyRenderer.js";

export type MessageRowAuthorType = "local-user" | "ai-teammate" | "system";
export type MessageRowTone = "chat" | "chat-blocked" | "system";

export interface MessageRowProps {
  readonly id?: string;
  readonly className?: string;
  readonly authorType: MessageRowAuthorType;
  readonly avatar?: ReactNode;
  readonly authorName: string;
  readonly createdAtLabel?: string;
  readonly tone?: MessageRowTone;
  readonly statusNode?: ReactNode;
  readonly showOwnAuthor?: boolean;
  readonly body?: string;
  readonly bodyCwd?: string;
  readonly bodyCompact?: boolean;
  readonly bodyStreaming?: boolean;
  readonly bodyNode?: ReactNode;
  readonly attachmentsNode?: ReactNode;
  readonly evidenceNode?: ReactNode;
  readonly errorNode?: ReactNode;
  readonly actionsNode?: ReactNode;
}

export function MessageRow({
  id,
  className,
  authorType,
  avatar,
  authorName,
  createdAtLabel,
  tone,
  statusNode,
  showOwnAuthor = false,
  body,
  bodyCwd,
  bodyCompact,
  bodyStreaming = false,
  bodyNode,
  attachmentsNode,
  evidenceNode,
  errorNode,
  actionsNode,
}: MessageRowProps): JSX.Element {
  const ownMessage = authorType === "local-user";
  const legacySideClass = authorType === "local-user" ? "message-bubble-own" : "message-bubble-peer";
  const resolvedTone = tone ?? (authorType === "system" ? "system" : "chat");
  const legacyToneClass = `message-bubble-${resolvedTone}`;
  const rootClassName = [
    "conversation-message-row",
    "message-bubble",
    "message-bubble-inline",
    legacyToneClass,
    legacySideClass,
    bodyStreaming ? "message-bubble-pending" : "",
    authorType,
    className,
  ].filter(Boolean).join(" ");
  const resolvedBodyNode = bodyNode ?? (body ? (
    <div className={bodyStreaming ? "message-body-shell message-body-with-spinner" : "message-body-shell"}>
      {bodyStreaming ? <Loader2 className="message-pending-spinner spin" size={13} /> : null}
      <MessageBodyRenderer text={body} cwd={bodyCwd} compact={bodyCompact} streaming={bodyStreaming} />
    </div>
  ) : null);

  return (
    <article id={id} className={rootClassName}>
      {!ownMessage ? avatar : showOwnAuthor ? (
        <header className="message-row-own-identity">
          <strong>{authorName}</strong>
          {createdAtLabel ? <time>{createdAtLabel}</time> : null}
          {statusNode}
          {avatar}
        </header>
      ) : null}
      <div className="message-content">
        {ownMessage ? null : (
          <header>
            <strong>{authorName}</strong>
            {createdAtLabel ? <time>{createdAtLabel}</time> : null}
            {statusNode}
          </header>
        )}
        {resolvedBodyNode}
        {attachmentsNode}
        {evidenceNode}
        {errorNode}
        {actionsNode}
      </div>
      {ownMessage && !showOwnAuthor ? avatar : null}
    </article>
  );
}
