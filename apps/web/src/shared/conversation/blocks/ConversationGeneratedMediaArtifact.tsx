import { Download, ExternalLink } from "lucide-react";
import { artifactContentUrl } from "../../../api/media.js";
import { useI18n } from "../../../i18n.js";
import { artifactDownloadName } from "../../../lib/artifacts.js";
import type { RunArtifact } from "../../../types.js";

export function ConversationGeneratedMediaArtifact({ artifact, cwd }: {
  readonly artifact: RunArtifact;
  readonly cwd: string;
}): React.JSX.Element {
  const { t } = useI18n();
  const url = artifactContentUrl(artifact.id, cwd);
  const title = artifact.title || artifactDownloadName(artifact);
  return (
    <figure className={`conversation-generated-media-artifact artifact-${artifact.type}`}>
      {artifact.type === "video" ? (
        <video controls preload="metadata" playsInline aria-label={title}>
          <source src={url} type={artifact.contentType ?? "video/mp4"} />
          {t("This browser cannot play this video.")}
        </video>
      ) : (
        <img src={url} alt={title} loading="lazy" />
      )}
      <figcaption aria-label={t("Generated result actions")}>
        <span className="conversation-generated-media-actions">
          <a href={url} target="_blank" rel="noreferrer" aria-label={t("Open generated result")} title={t("Open generated result")}>
            <ExternalLink size={15} />
          </a>
          <a href={url} download={artifactDownloadName(artifact)} aria-label={t("Download generated result")} title={t("Download generated result")}>
            <Download size={15} />
          </a>
        </span>
      </figcaption>
    </figure>
  );
}
