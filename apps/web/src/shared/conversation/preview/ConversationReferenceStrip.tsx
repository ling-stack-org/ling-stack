import { useState } from "react";
import { FileText, Globe2 } from "lucide-react";
import type {
  ConversationOperationSourceRef,
  ConversationTrustedSourceRef,
} from "@ling-stack/conversation-ui-core";
import { isTrustedSourceRef } from "../timeline/source-ref.js";

export interface ConversationReferenceItem {
  readonly id: string;
  readonly kind: "workspace_file" | "web";
  readonly label: string;
  readonly meta?: string;
  readonly href?: string;
  readonly previewTitle?: string;
  readonly previewText?: string;
  /** Display-only or Host-issued ref. Raw paths never become navigation. */
  readonly sourceRef?: ConversationOperationSourceRef;
  readonly onOpen?: () => void;
}

export function ConversationReferenceStrip({
  references,
  ariaLabel,
  onOpenSourceRef,
}: {
  readonly references: readonly ConversationReferenceItem[];
  readonly ariaLabel: string;
  readonly onOpenSourceRef?: (ref: ConversationTrustedSourceRef) => void;
}): React.JSX.Element | null {
  const [activePreviewId, setActivePreviewId] = useState<string | undefined>();
  if (references.length === 0) {
    return null;
  }

  return (
    <div className="conversation-reference-strip" aria-label={ariaLabel}>
      {references.map((reference) => {
        const trustedSourceRef = isTrustedSourceRef(reference.sourceRef) ? reference.sourceRef : undefined;
        const sourceRefAction = trustedSourceRef && onOpenSourceRef
          ? () => onOpenSourceRef(trustedSourceRef)
          : undefined;
        const onOpen = reference.sourceRef ? sourceRefAction : reference.onOpen;
        const content = (
          <>
            {reference.kind === "workspace_file" ? <FileText size={13} aria-hidden="true" /> : <Globe2 size={13} aria-hidden="true" />}
            <span>{reference.label}</span>
            {reference.meta ? <small>{reference.meta}</small> : null}
          </>
        );
        return (
          <span
            key={reference.id}
            className="conversation-reference-item"
            onMouseEnter={() => setActivePreviewId(reference.id)}
            onMouseLeave={() => setActivePreviewId((current) => current === reference.id ? undefined : current)}
          >
            {reference.href ? (
              <a
                className="conversation-reference-trigger"
                href={reference.href}
                target="_blank"
                rel="noreferrer"
                onFocus={() => setActivePreviewId(reference.id)}
                onBlur={() => setActivePreviewId((current) => current === reference.id ? undefined : current)}
              >
                {content}
              </a>
            ) : (
              <button
                className="conversation-reference-trigger"
                type="button"
                onClick={onOpen}
                onFocus={() => setActivePreviewId(reference.id)}
                onBlur={() => setActivePreviewId((current) => current === reference.id ? undefined : current)}
                disabled={!onOpen}
              >
                {content}
              </button>
            )}
            {activePreviewId === reference.id && (reference.previewTitle || reference.previewText || reference.meta) ? (
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
