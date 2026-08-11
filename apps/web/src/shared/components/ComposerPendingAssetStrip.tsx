import type { ReactNode } from "react";
import { FileText, Link2, Loader2, X } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { IconButton } from "../ui/index.js";
import { pendingAssetLabel, type PendingAttachmentItem } from "./composer-pending-assets.js";

export interface ComposerPendingLinkItem {
  readonly id: string;
  readonly url: string;
  readonly label: string;
  readonly detail: string;
}

export interface ComposerPendingAssetStripProps<TAttachment extends { readonly sizeBytes: number }> {
  readonly attachments: readonly PendingAttachmentItem<TAttachment>[];
  readonly links?: readonly ComposerPendingLinkItem[];
  readonly leadingItems?: ReactNode;
  readonly onRemoveAttachment: (localId: string) => void | Promise<void>;
  readonly onRemoveLink?: (id: string) => void | Promise<void>;
}

export function ComposerPendingAssetStrip<TAttachment extends { readonly sizeBytes: number }>({
  attachments,
  leadingItems,
  links = [],
  onRemoveAttachment,
  onRemoveLink,
}: ComposerPendingAssetStripProps<TAttachment>): JSX.Element {
  const { t } = useI18n();

  return (
    <div className="pending-assets composer-preview-strip" aria-label={t("Pending message assets")}>
      {leadingItems}
      {links.map((link) => (
        <div key={link.id} className="composer-preview-card link ready">
          <span className="composer-preview-file-icon" aria-hidden="true"><Link2 size={16} /></span>
          <span className="composer-preview-body">
            <strong title={link.url}>{link.label}</strong>
            <small>{link.detail}</small>
          </span>
          {onRemoveLink ? (
            <IconButton
              className="composer-preview-remove"
              icon={X}
              label={t("Remove link preview")}
              tooltip=""
              onClick={() => void onRemoveLink(link.id)}
            />
          ) : null}
        </div>
      ))}
      {attachments.map((item) => (
        <div key={item.localId} className={`composer-preview-card ${item.previewUrl ? "image" : "file"} ${item.state}`}>
          {item.previewUrl ? (
            <img className="composer-preview-thumbnail" src={item.previewUrl} alt={item.fileName} />
          ) : (
            <span className="composer-preview-file-icon" aria-hidden="true"><FileText size={17} /></span>
          )}
          <span className="composer-preview-body">
            <strong title={item.fileName}>{item.fileName}</strong>
            <small>{item.error ?? `${t(pendingAssetLabel(item.state))} · ${formatBytes(item.attachment?.sizeBytes ?? item.sizeBytes)}`}</small>
          </span>
          {item.state === "uploading" ? <Loader2 className="composer-preview-state-icon spin" size={13} /> : null}
          <IconButton
            className="composer-preview-remove"
            icon={X}
            label={t("Remove pending attachment")}
            tooltip=""
            onClick={() => void onRemoveAttachment(item.localId)}
          />
        </div>
      ))}
    </div>
  );
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
