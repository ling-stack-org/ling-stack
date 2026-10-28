import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { Download, ExternalLink, Loader2, X } from "lucide-react";
import { useI18n } from "../../../i18n.js";
import type { PreviewContentKind } from "../../../types.js";
import type { PreviewContentResponse } from "../../../types.js";
import { InlineFeedback, useLingToast } from "../../ui/index.js";
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
}: ArtifactPreviewDrawerProps): React.JSX.Element | null {
  const { t } = useI18n();
  const { showToast } = useLingToast();
  const [preview, setPreview] = useState<PreviewContentResponse | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | undefined>(undefined);
  const lightboxSwipeRef = useRef<{ readonly pointerId: number; readonly startX: number; readonly startY: number } | undefined>(undefined);

  useEffect(() => {
    if (!request) {
      setPreview(undefined);
      setError("");
      setActionError("");
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError("");
    setActionError("");
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

  if (!request) {
    return null;
  }

  const title = preview?.ref.label ?? t("Preview");
  const kind = preview ? previewKindLabel(preview.kind) : "";
  const rootClassName = variant === "lightbox"
    ? "artifact-preview-drawer artifact-preview-lightbox"
    : "artifact-preview-drawer";
  const toastScope = artifactPreviewToastScope(request);
  const previewUnavailable = preview !== undefined && !artifactPreviewCanRender(preview);

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

  function handlePreviewClickCapture(event: ReactMouseEvent<HTMLDivElement>): void {
    if (preview?.text === undefined) {
      return;
    }
    const target = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("button")
      : null;
    if (!target || !event.currentTarget.contains(target) || target.getAttribute("aria-label") !== t("Copy preview")) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    void copyPreviewText(preview.text);
  }

  async function copyPreviewText(text: string): Promise<void> {
    setActionError("");
    try {
      if (!globalThis.navigator?.clipboard?.writeText) {
        throw new Error("clipboard_unavailable");
      }
      await globalThis.navigator.clipboard.writeText(text);
      showToast({
        message: t("Copied"),
        scope: `${toastScope}:copy`,
        tone: "success",
        durationMs: 3_000,
      });
    } catch {
      setActionError(t("Copy failed"));
    }
  }

  async function downloadPreview(event: ReactMouseEvent<HTMLAnchorElement>): Promise<void> {
    event.preventDefault();
    if (!downloadHref) {
      return;
    }
    setActionError("");
    try {
      const response = await globalThis.fetch(downloadHref, { credentials: "same-origin" });
      if (!response.ok) {
        throw new Error(`download_failed_${response.status}`);
      }
      const objectUrl = globalThis.URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      if (downloadName) {
        anchor.download = downloadName;
      }
      anchor.hidden = true;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      globalThis.requestAnimationFrame(() => globalThis.URL.revokeObjectURL(objectUrl));
      showToast({
        message: t("Download started"),
        scope: `${toastScope}:download`,
        tone: "success",
        durationMs: 3_000,
      });
    } catch {
      setActionError(`${t("Download file")}: ${t("Failed")}`);
    }
  }

  const overlay = (
    <aside
      className={rootClassName}
      data-desktop-window-no-drag="true"
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

        <div className="artifact-preview-body" onClickCapture={handlePreviewClickCapture}>
          {loading ? (
            <div className="artifact-preview-loading">
              <Loader2 className="spin" size={16} />
              <span>{t("Loading preview...")}</span>
            </div>
          ) : null}
          {error ? (
            <InlineFeedback className="artifact-preview-error" data-artifact-preview-feedback="load" tone="danger">
              {t("Preview unavailable")}: {error}
            </InlineFeedback>
          ) : null}
          {previewUnavailable ? (
            <InlineFeedback className="artifact-preview-error" data-artifact-preview-feedback="preview" tone="danger">
              {t("Preview unavailable")}
            </InlineFeedback>
          ) : null}
          {actionError ? (
            <InlineFeedback className="artifact-preview-error" data-artifact-preview-feedback="action" tone="danger">
              {actionError}
            </InlineFeedback>
          ) : null}
          {preview && !previewUnavailable ? <ArtifactPreview preview={preview} cwd={request?.cwd} /> : null}
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
          {openHref ? (
            <a
              className="artifact-action-link"
              href={openHref}
              target="_blank"
              rel="noreferrer"
              aria-label={t("Open")}
              title={t("Open")}
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
              onClick={(event) => void downloadPreview(event)}
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

function artifactPreviewCanRender(preview: PreviewContentResponse): boolean {
  if (preview.kind === "image") {
    return Boolean(preview.imageUrl);
  }
  if (preview.kind === "html_interactive") {
    return Boolean(preview.htmlInteractive);
  }
  if (preview.kind === "spreadsheet") {
    return Boolean(preview.spreadsheet);
  }
  return preview.text !== undefined;
}

function artifactPreviewToastScope(request: ArtifactPreviewRequest): string {
  const resourceId = request.source === "artifact" ? request.artifactId : request.attachmentId;
  return `artifact-preview:${request.source}:${resourceId}`;
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
  if (kind === "html_interactive") {
    return "Interactive";
  }
  return "Unsupported";
}
