import { useEffect, useState } from "react";
import { FileVideo, Image as ImageIcon, RefreshCw } from "lucide-react";
import { artifactContentUrl } from "../../api.js";
import { artifactDownloadName, isImageArtifact } from "../../lib/artifacts.js";
import { Button, Skeleton } from "../../shared/ui/index.js";
import { useI18n } from "../../i18n.js";
import type { RunArtifact } from "../../types.js";
import { appendPreviewRetry } from "./media-job-result-view-models.js";

export type MediaArtifactPreviewVariant = "tile" | "hero" | "scene";

export function MediaArtifactPreview({
  artifact,
  cwd,
  mode,
  variant,
  className = "",
  autoPlay = false,
  loading = false,
}: {
  readonly artifact?: RunArtifact;
  readonly cwd: string;
  readonly mode?: MediaArtifactPreviewVariant;
  readonly variant?: MediaArtifactPreviewVariant;
  readonly className?: string;
  readonly autoPlay?: boolean;
  readonly loading?: boolean;
}): JSX.Element {
  const { t } = useI18n();
  const resolvedMode = mode ?? variant ?? "tile";
  const canonicalUrl = artifact ? artifactContentUrl(artifact.id, cwd) : "";
  const identity = `${cwd}\u001f${artifact?.id ?? ""}\u001f${canonicalUrl}`;
  const [contentPhase, setContentPhase] = useState<"loading" | "ready" | "error">("loading");
  const [retryNonce, setRetryNonce] = useState(0);
  useEffect(() => {
    setContentPhase("loading");
    setRetryNonce(0);
  }, [identity]);
  const classes = ["media-artifact-preview", resolvedMode, className].filter(Boolean).join(" ");
  if (!artifact || loading) {
    return <span className={`${classes} empty`} aria-label={t("Result loading")} data-media-preview-artifact={artifact?.id} data-media-preview-mode={resolvedMode}><Skeleton shape="block" width="100%" height="100%" /></span>;
  }
  const title = artifact.title || artifactDownloadName(artifact);
  const src = appendPreviewRetry(canonicalUrl, retryNonce);
  if (contentPhase === "error") {
    return (
      <span className={`${classes} unavailable`} data-media-preview-artifact={artifact.id} data-media-preview-mode={resolvedMode} data-media-preview-state="error">
        {artifact.type === "video" ? <FileVideo size={20} /> : <ImageIcon size={20} />}
        {resolvedMode !== "tile" ? <strong>{t("Preview unavailable")}</strong> : null}
        {resolvedMode !== "tile" ? (
          <Button
            leadingIcon={<RefreshCw size={15} />}
            size="sm"
            onClick={() => { setRetryNonce((current) => current + 1); setContentPhase("loading"); }}
          >{t("Retry preview")}</Button>
        ) : null}
      </span>
    );
  }
  if (isImageArtifact(artifact)) {
    return (
      <span className={classes} data-media-preview-artifact={artifact.id} data-media-preview-mode={resolvedMode} data-media-preview-state={contentPhase}>
        <img key={src} src={src} alt={title} onLoad={() => setContentPhase("ready")} onError={() => setContentPhase("error")} />
      </span>
    );
  }
  if (artifact.type === "video") {
    return (
      <span className={classes} data-media-preview-artifact={artifact.id} data-media-preview-mode={resolvedMode} data-media-preview-state={contentPhase}>
        <video
          key={src}
          autoPlay={autoPlay && resolvedMode !== "hero"}
          controls={resolvedMode !== "tile"}
          muted={resolvedMode === "tile" || autoPlay}
          preload={autoPlay ? "auto" : "metadata"}
          playsInline
          aria-label={title}
          onLoadedMetadata={() => setContentPhase("ready")}
          onError={() => setContentPhase("error")}
        ><source src={src} type={artifact.contentType ?? "video/mp4"} />{t("This browser cannot play this video.")}</video>
        {resolvedMode === "tile" ? <FileVideo className="media-artifact-preview-icon" size={16} aria-hidden="true" /> : null}
      </span>
    );
  }
  return <span className={`${classes} empty`}><ImageIcon size={20} aria-hidden="true" /></span>;
}
