import { useState, type ReactNode } from "react";
import { Eye } from "lucide-react";
import { useI18n } from "../../../i18n.js";
import { ArtifactPreviewDrawer, type ArtifactPreviewLoader, type ArtifactPreviewRequest } from "./ArtifactPreviewDrawer.js";

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
  readonly previewRequest?: ArtifactPreviewRequest;
}

export interface ConversationAttachmentStripProps {
  readonly className?: string;
  readonly chipClassName?: string;
  readonly attachments: readonly ConversationAttachmentChip[];
  readonly loadPreview: ArtifactPreviewLoader;
}

export function ConversationAttachmentStrip({
  className,
  chipClassName,
  attachments,
  loadPreview,
}: ConversationAttachmentStripProps): JSX.Element | null {
  const { t } = useI18n();
  const [activePreview, setActivePreview] = useState<ConversationAttachmentChip | undefined>();

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
        return (
          <span key={attachment.id} className="conversation-attachment-item">
            {attachment.href ? (
              <a
                className={resolvedChipClassName}
                href={attachment.href}
                target={attachment.target}
                rel={attachment.rel}
                title={attachment.title ?? attachment.label}
                onClick={attachment.onClick}
              >
                {content}
              </a>
            ) : (
              <button
                className={resolvedChipClassName}
                type="button"
                title={attachment.title ?? attachment.label}
                onClick={attachment.onClick}
              >
                {content}
              </button>
            )}
            {attachment.previewRequest ? (
              <button
                className="conversation-attachment-preview-button"
                type="button"
                aria-label={`${t("Preview")}: ${attachment.label}`}
                title={`${t("Preview")}: ${attachment.label}`}
                onClick={() => setActivePreview(attachment)}
              >
                <Eye size={13} aria-hidden="true" />
              </button>
            ) : null}
          </span>
        );
      })}
      <ArtifactPreviewDrawer
        request={activePreview?.previewRequest}
        loadPreview={loadPreview}
        openHref={activePreview?.href}
        downloadHref={activePreview?.href}
        downloadName={activePreview?.label}
        onClose={() => setActivePreview(undefined)}
      />
    </div>
  );
}
