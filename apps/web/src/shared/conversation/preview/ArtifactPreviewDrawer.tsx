import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { Download, ExternalLink, Loader2, X } from "lucide-react";
import { useI18n } from "../../../i18n.js";
import type { PreviewContentKind } from "../../../types.js";
import type { PreviewContentResponse } from "../../../types.js";
import { ArtifactPreview } from "./ArtifactPreview.js";

export type ArtifactPreviewRequest =
  | {
    readonly source: "artifact";
    readonly cwd: string;
    readonly artifactId: string;
    readonly maxBytes?: number;
  }
  | {
    readonly source: "attachment";
    readonly cwd: string;
    readonly attachmentId: string;
    readonly maxBytes?: number;
    readonly scope?: "channel" | "teammate_private" | "conversation";
    readonly channelId?: string;
    readonly teammateId?: string;
    readonly threadId?: string;
  };

export type ArtifactPreviewLoader = (request: ArtifactPreviewRequest) => Promise<PreviewContentResponse>;

export interface ArtifactPreviewDrawerProps {
  readonly request: ArtifactPreviewRequest | undefined;
  readonly loadPreview: ArtifactPreviewLoader;
  readonly openHref?: string;
  readonly downloadHref?: string;
  readonly downloadName?: string;
  readonly variant?: "drawer" | "lightbox";
  readonly onClose: () => void;
}

export function ArtifactPreviewDrawer({
  request,
  loadPreview,
  openHref,
  downloadHref,
  downloadName,
  variant = "lightbox",
  onClose,
}: ArtifactPreviewDrawerProps): JSX.Element | null {
  const { t } = useI18n();
  const [preview, setPreview] = useState<PreviewContentResponse | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [actionFeedback, setActionFeedback] = useState("");
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | undefined>();
  const actionFeedbackTimeoutRef = useRef<number | undefined>();
  const lightboxSwipeRef = useRef<{ readonly pointerId: number; readonly startX: number; readonly startY: number } | undefined>();

  useEffect(() => {
    if (!request) {
      setPreview(undefined);
      setError("");
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError("");
    setPreview(undefined);
    void loadPreview(request).then((response) => {
      if (!cancelled) {
        setPreview(response);
      }
    }, (reason) => {
      if (!cancelled) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    }).finally(() => {
      if (!cancelled) {
        setLoading(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [loadPreview, request]);

  useEffect(() => {
    if (!request) {
      previousFocusRef.current = undefined;
      return;
    }
    const activeElement = document.activeElement;
    previousFocusRef.current = activeElement instanceof HTMLElement ? activeElement : undefined;
    const frameId = globalThis.requestAnimationFrame(() => {
      closeButtonRef.current?.focus();
    });
    return () => globalThis.cancelAnimationFrame(frameId);
  }, [Boolean(request)]);

  useEffect(() => () => {
    if (actionFeedbackTimeoutRef.current !== undefined) {
      globalThis.clearTimeout(actionFeedbackTimeoutRef.current);
    }
  }, []);

  if (!request) {
    return null;
  }

  const title = preview?.ref.label ?? t("Preview");
  const kind = preview ? previewKindLabel(preview.kind) : "";
  const rootClassName = variant === "lightbox"
    ? "artifact-preview-drawer artifact-preview-lightbox"
    : "artifact-preview-drawer";

  function showActionFeedback(message: string): void {
    if (actionFeedbackTimeoutRef.current !== undefined) {
      globalThis.clearTimeout(actionFeedbackTimeoutRef.current);
    }
    setActionFeedback(message);
    actionFeedbackTimeoutRef.current = globalThis.setTimeout(() => {
      setActionFeedback("");
      actionFeedbackTimeoutRef.current = undefined;
    }, 1_800);
  }

  function closePreview(): void {
    const returnTarget = previousFocusRef.current;
    previousFocusRef.current = undefined;
    onClose();
    globalThis.requestAnimationFrame(() => {
      if (returnTarget?.isConnected) {
        returnTarget.focus();
      }
    });
  }

  function handleLightboxPointerDown(event: ReactPointerEvent<HTMLElement>): void {
    if (variant !== "lightbox" || event.pointerType === "mouse") {
      return;
    }
    lightboxSwipeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
    };
  }

  function handleLightboxPointerUp(event: ReactPointerEvent<HTMLElement>): void {
    const swipe = lightboxSwipeRef.current;
    if (variant !== "lightbox" || !swipe || swipe.pointerId !== event.pointerId) {
      return;
    }
    lightboxSwipeRef.current = undefined;
    const deltaX = Math.abs(event.clientX - swipe.startX);
    const deltaY = event.clientY - swipe.startY;
    if (deltaY > 84 && deltaX < 80) {
      closePreview();
    }
  }

  const overlay = (
    <aside
      className={rootClassName}
      aria-label={t("File preview")}
      onPointerDown={handleLightboxPointerDown}
      onPointerUp={handleLightboxPointerUp}
      onPointerCancel={() => {
        lightboxSwipeRef.current = undefined;
      }}
    >
      <div className="artifact-preview-panel">
        <header className="artifact-preview-head">
          <div>
            <strong>{title}</strong>
            {preview ? (
              <small>
                {kind}
                {preview.sizeBytes !== undefined ? ` · ${formatPreviewSize(preview.sizeBytes)}` : ""}
                {preview.truncated ? ` · ${t("Preview truncated")}` : ""}
              </small>
            ) : null}
          </div>
          <button ref={closeButtonRef} className="icon-button" type="button" onClick={closePreview} aria-label={t("Close preview")} title={t("Close preview")}>
            <X size={14} />
          </button>
        </header>

        <div className="artifact-preview-body">
          {loading ? (
            <div className="artifact-preview-loading">
              <Loader2 className="spin" size={16} />
              <span>{t("Loading preview...")}</span>
            </div>
          ) : null}
          {error ? <div className="artifact-preview-error" role="alert">{t("Preview unavailable")}: {error}</div> : null}
          {preview ? <ArtifactPreview preview={preview} /> : null}
        </div>

        {preview?.redactionNotes.length ? (
          <div className="artifact-preview-notes">
            {preview.redactionNotes.map((note) => <small key={note}>{t(note)}</small>)}
          </div>
        ) : (
          <div className="artifact-preview-notes">
            <small>{t("Not included in AI context")}</small>
          </div>
        )}

        <footer className="artifact-preview-actions">
          {actionFeedback ? <span className="artifact-preview-action-feedback" role="status" aria-live="polite">{actionFeedback}</span> : null}
          {openHref ? (
            <a
              className="artifact-action-link"
              href={openHref}
              target="_blank"
              rel="noreferrer"
              aria-label={t("Open")}
              title={t("Open")}
              onClick={() => showActionFeedback(t("Opened"))}
            >
              <ExternalLink size={13} />
              {t("Open")}
            </a>
          ) : null}
          {downloadHref ? (
            <a
              className="artifact-action-link"
              href={downloadHref}
              download={downloadName}
              aria-label={t("Download file")}
              title={t("Download file")}
              onClick={() => showActionFeedback(t("Download started"))}
            >
              <Download size={13} />
              {t("Download file")}
            </a>
          ) : null}
        </footer>
      </div>
    </aside>
  );
  return typeof document === "undefined" ? overlay : createPortal(overlay, document.body);
}

function formatPreviewSize(sizeBytes: number): string {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }
  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`;
  }
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function previewKindLabel(kind: PreviewContentKind): string {
  if (kind === "markdown_text") {
    return "Markdown";
  }
  if (kind === "plain_text") {
    return "Text";
  }
  if (kind === "json") {
    return "JSON";
  }
  if (kind === "diff") {
    return "Diff";
  }
  if (kind === "log") {
    return "Log";
  }
  if (kind === "code") {
    return "Code";
  }
  if (kind === "image") {
    return "Image";
  }
  if (kind === "pdf") {
    return "PDF";
  }
  if (kind === "office") {
    return "Office";
  }
  return "Unsupported";
}
