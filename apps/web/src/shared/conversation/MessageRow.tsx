import type { ReactNode } from "react";

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
  bodyNode,
  attachmentsNode,
  evidenceNode,
  errorNode,
  actionsNode,
}: MessageRowProps): JSX.Element {
  const rootClassName = ["conversation-message-row", authorType, className].filter(Boolean).join(" ");

  return (
    <article id={id} className={rootClassName}>
      {avatar}
      <div>
        <header>
          <strong>{authorName}</strong>
          {createdAtLabel ? <time>{createdAtLabel}</time> : null}
          {statusNode}
        </header>
        {bodyNode ?? (body ? <p>{body}</p> : null)}
        {attachmentsNode}
        {evidenceNode}
        {errorNode}
        {actionsNode}
      </div>
    </article>
  );
}
