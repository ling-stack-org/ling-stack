import { useEffect, useRef, useState } from "react";
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
}): JSX.Element | null {
  const [activeId, setActiveId] = useState("");
  const openTimerRef = useRef<number | undefined>();
  const closeTimerRef = useRef<number | undefined>();

  useEffect(() => () => {
    if (openTimerRef.current !== undefined) {
      globalThis.clearTimeout(openTimerRef.current);
    }
    if (closeTimerRef.current !== undefined) {
      globalThis.clearTimeout(closeTimerRef.current);
    }
  }, []);

  if (references.length === 0) {
    return null;
  }

  function clearOpenTimer(): void {
    if (openTimerRef.current !== undefined) {
      globalThis.clearTimeout(openTimerRef.current);
      openTimerRef.current = undefined;
    }
  }

  function clearCloseTimer(): void {
    if (closeTimerRef.current !== undefined) {
      globalThis.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = undefined;
    }
  }

  function scheduleOpen(id: string): void {
    clearOpenTimer();
    clearCloseTimer();
    openTimerRef.current = globalThis.setTimeout(() => {
      setActiveId(id);
      openTimerRef.current = undefined;
    }, 450);
  }

  function openImmediately(id: string): void {
    clearOpenTimer();
    clearCloseTimer();
    setActiveId(id);
  }

  function scheduleClose(): void {
    clearOpenTimer();
    clearCloseTimer();
    closeTimerRef.current = globalThis.setTimeout(() => {
      setActiveId("");
      closeTimerRef.current = undefined;
    }, 120);
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
        const interactionProps = {
          onMouseEnter: () => scheduleOpen(reference.id),
          onMouseLeave: scheduleClose,
          onFocus: () => openImmediately(reference.id),
          onBlur: scheduleClose,
        };
        return (
          <span key={reference.id} className="conversation-reference-item">
            {reference.href ? (
              <a className="conversation-reference-trigger" href={reference.href} target="_blank" rel="noreferrer" {...interactionProps}>
                {content}
              </a>
            ) : (
              <button className="conversation-reference-trigger" type="button" onClick={reference.onOpen} disabled={!reference.onOpen} {...interactionProps}>
                {content}
              </button>
            )}
            {activeId === reference.id && (reference.previewTitle || reference.previewText || reference.meta) ? (
              <span
                className="conversation-reference-preview"
                role="tooltip"
                onMouseEnter={clearCloseTimer}
                onMouseLeave={scheduleClose}
              >
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
