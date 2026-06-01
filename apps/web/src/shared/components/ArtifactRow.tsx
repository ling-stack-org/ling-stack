import { Download, ExternalLink, Image as ImageIcon } from "lucide-react";
import { artifactContentUrl } from "../../api.js";
import { useI18n } from "../../i18n.js";
import { artifactDownloadName, formatArtifactSize, isImageArtifact } from "../../lib/artifacts.js";
import type { RunArtifact } from "../../types.js";

export function ArtifactRow({ artifact, cwd }: { readonly artifact: RunArtifact; readonly cwd?: string }): JSX.Element {
  const { t } = useI18n();
  const contentUrl = artifactContentUrl(artifact.id, cwd);
  const isImage = isImageArtifact(artifact);
  const title = artifact.title || artifactDownloadName(artifact);
  const downloadName = artifactDownloadName(artifact);

  if (!isImage) {
    return (
      <a className="artifact-row" href={contentUrl} target="_blank" rel="noreferrer">
        <span className="artifact-type">{artifact.type}</span>
        <span className="artifact-main">
          <strong>{title}</strong>
          <small>{downloadName}</small>
        </span>
        <small>{formatArtifactSize(artifact.sizeBytes)}</small>
      </a>
    );
  }

  return (
    <div className="artifact-row with-actions">
      <span className="artifact-type image-artifact-type" title={t("Image artifact")}>
        <ImageIcon size={13} aria-hidden="true" />
        {artifact.type}
      </span>
      <a className="artifact-main artifact-main-link" href={contentUrl} target="_blank" rel="noreferrer">
        <strong>{title}</strong>
        <small>{downloadName}</small>
      </a>
      <small>{formatArtifactSize(artifact.sizeBytes)}</small>
      <span className="artifact-actions">
        <a className="artifact-action-link" href={contentUrl} target="_blank" rel="noreferrer">
          <ExternalLink size={13} aria-hidden="true" />
          {t("Open")}
        </a>
        <a className="artifact-action-link" href={contentUrl} download={downloadName}>
          <Download size={13} aria-hidden="true" />
          {t("Download")}
        </a>
      </span>
    </div>
  );
}
