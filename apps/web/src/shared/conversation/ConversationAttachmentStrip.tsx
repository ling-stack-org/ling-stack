import type { ReactNode } from "react";

export interface ConversationAttachmentChip {
  readonly id: string;
  readonly label: string;
  readonly href?: string;
  readonly meta?: string;
  readonly icon?: ReactNode;
  readonly target?: string;
  readonly rel?: string;
  readonly title?: string;
  readonly onClick?: () => void;
}

export interface ConversationAttachmentStripProps {
  readonly className?: string;
  readonly chipClassName?: string;
  readonly attachments: readonly ConversationAttachmentChip[];
}

export function ConversationAttachmentStrip({
  className,
  chipClassName,
  attachments,
}: ConversationAttachmentStripProps): JSX.Element | null {
  if (attachments.length === 0) {
    return null;
  }

  const rootClassName = ["conversation-attachment-strip", className].filter(Boolean).join(" ");
  const resolvedChipClassName = ["conversation-attachment-chip", chipClassName].filter(Boolean).join(" ");

  return (
    <div className={rootClassName}>
      {attachments.map((attachment) => {
        const content = (
          <>
            {attachment.icon}
            <span>{attachment.label}</span>
            {attachment.meta ? <small>{attachment.meta}</small> : null}
          </>
        );
        if (attachment.href) {
          return (
            <a
              key={attachment.id}
              className={resolvedChipClassName}
              href={attachment.href}
              target={attachment.target}
              rel={attachment.rel}
              title={attachment.title ?? attachment.label}
              onClick={attachment.onClick}
            >
              {content}
            </a>
          );
        }
        return (
          <button
            key={attachment.id}
            className={resolvedChipClassName}
            type="button"
            title={attachment.title ?? attachment.label}
            onClick={attachment.onClick}
          >
            {content}
          </button>
        );
      })}
    </div>
  );
}
