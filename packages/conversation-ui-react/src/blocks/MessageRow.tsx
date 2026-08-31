import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
import {
  getConversationInteractionPolicy,
  type ConversationInteractionSurfaceKind,
  type LocalFileReference,
} from "@ling-stack/conversation-ui-core";
import { MessageBodyRenderer } from "./MessageBodyRenderer.js";

export type MessageRowAuthorType = "local-user" | "ai-teammate" | "system";
export type MessageRowTone = "chat" | "chat-blocked" | "system";

export interface MessageRowProps {
  readonly id?: string;
  readonly className?: string;
  readonly surface: ConversationInteractionSurfaceKind;
  readonly authorType: MessageRowAuthorType;
  readonly avatar?: ReactNode;
  readonly authorName: string;
  readonly createdAtLabel?: string;
  readonly tone?: MessageRowTone;
  readonly statusNode?: ReactNode;
  readonly showOwnAuthor?: boolean;
  readonly identityLabelMode?: "visible" | "sr-only";
  readonly body?: string;
  readonly bodyCwd?: string;
  readonly bodyCompact?: boolean;
  readonly bodyStreaming?: boolean;
  readonly bodyOnOpenLocalFile?: (reference: LocalFileReference) => void;
  readonly bodyNode?: ReactNode;
  readonly attachmentsNode?: ReactNode;
  readonly workCellNode?: ReactNode;
  readonly evidenceNode?: ReactNode;
  readonly errorNode?: ReactNode;
  readonly actionsNode?: ReactNode;
}

export function MessageRow({
  id,
  className,
  surface,
  authorType,
  avatar,
  authorName,
  createdAtLabel,
  tone,
  statusNode,
  showOwnAuthor = false,
  identityLabelMode,
  body,
  bodyCwd,
  bodyCompact,
  bodyStreaming = false,
  bodyOnOpenLocalFile,
  bodyNode,
  attachmentsNode,
  workCellNode,
  evidenceNode,
  errorNode,
  actionsNode,
}: MessageRowProps): React.JSX.Element {
  const ownMessage = authorType === "local-user";
  const surfacePolicy = getConversationInteractionPolicy(surface);
  const avatarAllowed = authorType === "local-user"
    ? surfacePolicy.showUserAvatar
    : authorType === "ai-teammate"
      ? surfacePolicy.showAgentAvatar
      : true;
  const resolvedAvatar = avatarAllowed ? avatar : undefined;
  const hasAvatar = resolvedAvatar !== null && resolvedAvatar !== undefined && resolvedAvatar !== false;
  const resolvedIdentityLabelMode = identityLabelMode ?? (authorType === "system" ? "visible" : "sr-only");
  const legacySideClass = authorType === "local-user" ? "message-bubble-own" : "message-bubble-peer";
  const resolvedTone = tone ?? (authorType === "system" ? "system" : "chat");
  const legacyToneClass = `message-bubble-${resolvedTone}`;
  const rootClassName = [
    "conversation-message-row",
    "message-bubble",
    "message-bubble-inline",
    legacyToneClass,
    legacySideClass,
    ownMessage && showOwnAuthor ? "message-bubble-own-with-author" : "",
    bodyStreaming ? "message-bubble-pending" : "",
    resolvedIdentityLabelMode === "sr-only" ? "message-row-identity-sr-only" : "",
    authorType,
    className,
  ].filter(Boolean).join(" ");
  const resolvedBodyNode = bodyNode ?? (body ? (
    <div className={bodyStreaming ? "message-body-shell message-body-with-spinner" : "message-body-shell"}>
      {bodyStreaming ? <Loader2 className="message-pending-spinner spin" size={13} /> : null}
      <MessageBodyRenderer text={body} cwd={bodyCwd} compact={bodyCompact} streaming={bodyStreaming} onOpenLocalFile={bodyOnOpenLocalFile} />
    </div>
  ) : null);

  return (
    <article
      id={id}
      className={rootClassName}
      data-conversation-message-row="true"
      data-conversation-surface={surface}
      data-has-avatar={hasAvatar ? "true" : "false"}
    >
      {!ownMessage ? resolvedAvatar : showOwnAuthor ? (
        <header className="message-row-own-identity">
          <strong>{authorName}</strong>
          {createdAtLabel ? <time>{createdAtLabel}</time> : null}
          {statusNode}
          {resolvedAvatar}
        </header>
      ) : null}
      <div className="message-content">
        {ownMessage ? null : (
          <header className="message-row-peer-identity">
            <strong>{authorName}</strong>
            {createdAtLabel ? <time>{createdAtLabel}</time> : null}
            {resolvedIdentityLabelMode === "visible" ? statusNode : null}
          </header>
        )}
        {resolvedBodyNode}
        {!ownMessage && resolvedIdentityLabelMode === "sr-only" && statusNode ? <span className="message-row-peer-status">{statusNode}</span> : null}
        {ownMessage && !showOwnAuthor && statusNode ? <span className="message-row-own-status">{statusNode}</span> : null}
        {attachmentsNode}
        {workCellNode}
        {evidenceNode}
        {errorNode}
        {ownMessage ? null : actionsNode}
      </div>
      {ownMessage && !showOwnAuthor ? resolvedAvatar : null}
      {ownMessage && actionsNode ? <div className="message-row-own-actions">{actionsNode}</div> : null}
    </article>
  );
}
