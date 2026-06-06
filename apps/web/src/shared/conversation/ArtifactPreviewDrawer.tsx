import { useEffect, useState } from "react";
import { Download, ExternalLink, Loader2, X } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { loadPreviewContent, previewKindLabel, type PreviewRequest } from "../../lib/previews.js";
import type { PreviewContentResponse } from "../../types.js";
import { ArtifactPreview } from "./ArtifactPreview.js";

export interface ArtifactPreviewDrawerProps {
  readonly request: PreviewRequest | undefined;
  readonly openHref?: string;
  readonly downloadHref?: string;
  readonly downloadName?: string;
  readonly onClose: () => void;
}

export function ArtifactPreviewDrawer({
  request,
  openHref,
  downloadHref,
  downloadName,
  onClose,
}: ArtifactPreviewDrawerProps): JSX.Element | null {
  const { t } = useI18n();
  const [preview, setPreview] = useState<PreviewContentResponse | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

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
    void loadPreviewContent(request).then((response) => {
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
  }, [request]);

  if (!request) {
    return null;
  }

  const title = preview?.ref.label ?? t("Preview");
  const kind = preview ? previewKindLabel(preview.kind) : "";

  return (
    <aside className="artifact-preview-drawer" aria-label={t("File preview")}>
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
          <button className="icon-button" type="button" onClick={onClose} aria-label={t("Close preview")} title={t("Close preview")}>
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
          {openHref ? (
            <a className="artifact-action-link" href={openHref} target="_blank" rel="noreferrer">
              <ExternalLink size={13} />
              {t("Open")}
            </a>
          ) : null}
          {downloadHref ? (
            <a className="artifact-action-link" href={downloadHref} download={downloadName}>
              <Download size={13} />
              {t("Download file")}
            </a>
          ) : null}
        </footer>
      </div>
    </aside>
  );
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
