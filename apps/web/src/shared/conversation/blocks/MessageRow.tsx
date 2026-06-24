import type { ReactNode } from "react";
import { MessageBodyRenderer } from "./MessageBodyRenderer.js";

export type MessageRowAuthorType = "local-user" | "ai-teammate" | "system";

export interface MessageRowProps {
  readonly id?: string;
  readonly className?: string;
  readonly authorType: MessageRowAuthorType;
  readonly avatar?: ReactNode;
  readonly authorName: string;
  readonly createdAtLabel?: string;
  readonly statusNode?: ReactNode;
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
  statusNode,
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
  const legacyToneClass = authorType === "system" ? "message-bubble-system" : "message-bubble-chat";
  const rootClassName = [
    "conversation-message-row",
    "message-bubble",
    "message-bubble-inline",
    legacyToneClass,
    legacySideClass,
    authorType,
    className,
  ].filter(Boolean).join(" ");

  return (
    <article id={id} className={rootClassName}>
      {ownMessage ? (
        <header className="message-row-own-identity">
          <strong>{authorName}</strong>
          {createdAtLabel ? <time>{createdAtLabel}</time> : null}
          {statusNode}
          {avatar}
        </header>
      ) : avatar}
      <div className="message-content">
        {ownMessage ? null : (
          <header>
            <strong>{authorName}</strong>
            {createdAtLabel ? <time>{createdAtLabel}</time> : null}
            {statusNode}
          </header>
        )}
        {bodyNode ?? (body ? <MessageBodyRenderer text={body} cwd={bodyCwd} compact={bodyCompact} streaming={bodyStreaming} /> : null)}
        {attachmentsNode}
        {evidenceNode}
        {errorNode}
        {actionsNode}
      </div>
    </article>
  );
}
