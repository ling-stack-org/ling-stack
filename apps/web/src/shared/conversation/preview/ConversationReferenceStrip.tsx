import { FileText, Globe2 } from "lucide-react";

export interface ConversationReferenceItem {
  readonly id: string;
  readonly kind: "workspace_file" | "web";
  readonly label: string;
  readonly meta?: string;
  readonly href?: string;
  readonly previewTitle?: string;
  readonly previewText?: string;
  readonly onOpen?: () => void;
}

export function ConversationReferenceStrip({
  references,
  ariaLabel,
}: {
  readonly references: readonly ConversationReferenceItem[];
  readonly ariaLabel: string;
}): React.JSX.Element | null {
  if (references.length === 0) {
    return null;
  }

  return (
    <div className="conversation-reference-strip" aria-label={ariaLabel}>
      {references.map((reference) => {
        const content = (
          <>
            {reference.kind === "workspace_file" ? <FileText size={13} aria-hidden="true" /> : <Globe2 size={13} aria-hidden="true" />}
            <span>{reference.label}</span>
            {reference.meta ? <small>{reference.meta}</small> : null}
          </>
        );
        return (
          <span key={reference.id} className="conversation-reference-item">
            {reference.href ? (
              <a className="conversation-reference-trigger" href={reference.href} target="_blank" rel="noreferrer">
                {content}
              </a>
            ) : (
              <button className="conversation-reference-trigger" type="button" onClick={reference.onOpen} disabled={!reference.onOpen}>
                {content}
              </button>
            )}
            {reference.previewTitle || reference.previewText || reference.meta ? (
              <span className="conversation-reference-preview" role="tooltip">
                <strong>{reference.previewTitle ?? reference.label}</strong>
                {reference.previewText ? <span>{reference.previewText}</span> : null}
                {reference.meta ? <small>{reference.meta}</small> : null}
              </span>
            ) : null}
          </span>
        );
      })}
    </div>
  );
}
