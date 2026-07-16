import { FileVideo, Image as ImageIcon } from "lucide-react";
import { artifactContentUrl } from "../../api.js";
import { artifactDownloadName, isImageArtifact } from "../../lib/artifacts.js";
import type { RunArtifact } from "../../types.js";

export type MediaArtifactPreviewVariant = "tile" | "hero" | "scene";

export function MediaArtifactPreview({
  artifact,
  cwd,
  variant,
  className = "",
  autoPlay = false,
}: {
  readonly artifact: RunArtifact;
  readonly cwd: string;
  readonly variant: MediaArtifactPreviewVariant;
  readonly className?: string;
  readonly autoPlay?: boolean;
}): JSX.Element {
  const href = artifactContentUrl(artifact.id, cwd);
  const title = artifact.title || artifactDownloadName(artifact);
  const classes = ["media-artifact-preview", variant, className].filter(Boolean).join(" ");

  if (isImageArtifact(artifact)) {
    return (
      <a className={classes} href={href} target="_blank" rel="noreferrer" aria-label={`打开${title}`}>
        <img src={href} alt={title} />
      </a>
    );
  }

  if (artifact.type === "video") {
    return (
      <div className={classes}>
        <video
          autoPlay={autoPlay}
          controls={variant !== "tile"}
          muted={variant === "tile" || autoPlay}
          preload={autoPlay ? "auto" : "metadata"}
          playsInline
          aria-label={title}
        >
          <source src={href} type={artifact.contentType ?? "video/mp4"} />
          当前浏览器无法播放该视频。
        </video>
        {variant === "tile" ? <FileVideo className="media-artifact-preview-icon" size={16} aria-hidden="true" /> : null}
      </div>
    );
  }

  return (
    <a className={classes} href={href} target="_blank" rel="noreferrer" aria-label={`打开${title}`}>
      <ImageIcon size={20} aria-hidden="true" />
    </a>
  );
}
