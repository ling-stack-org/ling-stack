import type { ReactNode } from "react";
import { FileText, Link2, Loader2, RotateCw, X } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { IconButton } from "../ui/index.js";
import { pendingAssetLabel, type AttachmentCleanupFailure, type PendingAttachmentItem } from "./composer-pending-assets.js";

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
  readonly onRetryAttachment?: (localId: string) => void | Promise<void>;
  readonly cleanupFailures?: readonly AttachmentCleanupFailure[];
  readonly onRetryCleanup?: (localId: string) => void | Promise<void>;
  readonly onRemoveLink?: (id: string) => void | Promise<void>;
}

export function ComposerPendingAssetStrip<TAttachment extends { readonly sizeBytes: number }>({
  attachments,
  leadingItems,
  links = [],
  onRemoveAttachment,
  onRetryAttachment,
  cleanupFailures = [],
  onRetryCleanup,
  onRemoveLink,
}: ComposerPendingAssetStripProps<TAttachment>): React.JSX.Element {
  const { t } = useI18n();

  return (
    <div className="pending-assets composer-preview-strip" aria-label={t("Pending message assets")}>
      {leadingItems}
      {cleanupFailures.map(failure => (
        <div key={failure.localId} className="composer-preview-card file failed" role="alert">
          <span className="composer-preview-file-icon" aria-hidden="true"><FileText size={17} /></span>
          <span className="composer-preview-body">
            <strong title={failure.fileName}>{failure.fileName}</strong>
            <small title={failure.error}>{t("Remove pending attachment")} · {failure.error}</small>
          </span>
          {onRetryCleanup ? <span className="composer-preview-actions">
            <IconButton className="composer-preview-remove" icon={failure.retrying ? Loader2 : RotateCw}
              label={t("Retry")} disabled={failure.retrying}
              onClick={event => runWithFocus(event.currentTarget, () => onRetryCleanup(failure.localId))} />
          </span> : null}
        </div>
      ))}
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
            <small title={item.error}>{item.error ?? `${t(pendingAssetLabel(item.state))} · ${formatBytes(item.attachment?.sizeBytes ?? item.sizeBytes)}`}</small>
          </span>
          <span className="composer-preview-actions">
            <IconButton
              className="composer-preview-remove"
              icon={X}
              label={t("Remove pending attachment")}
              tooltip=""
              onClick={() => void onRemoveAttachment(item.localId)}
            />
            {item.state === "uploading" ? <Loader2 className="spin" size={13} aria-hidden="true" /> : null}
            {item.state === "failed" && item.sourceFile && onRetryAttachment ? (
              <IconButton className="composer-preview-remove" icon={RotateCw}
                label={t("Retry upload")} onClick={event => runWithFocus(event.currentTarget, () => onRetryAttachment(item.localId))} />
            ) : null}
          </span>
        </div>
      ))}
    </div>
  );
}

function runWithFocus(button: HTMLButtonElement, action: () => void | Promise<void>): void {
  const wasFocused = document.activeElement === button;
  const card = button.closest(".composer-preview-card");
  const composer = button.closest("[data-conversation-composer]");
  const restore = () => {
    if (!wasFocused || document.activeElement !== document.body) return;
    const next = card?.isConnected ? card.querySelector<HTMLButtonElement>("button:not(:disabled)") : undefined;
    (next ?? composer?.querySelector<HTMLElement>('[role="textbox"]'))?.focus();
  };
  const result = action();
  requestAnimationFrame(restore);
  void Promise.resolve(result).then(() => requestAnimationFrame(restore));
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
