import { useState } from "react";
import { Download, ExternalLink, Eye, Image as ImageIcon, Save } from "lucide-react";
import { artifactContentUrl } from "../../api.js";
import { useI18n } from "../../i18n.js";
import { artifactDownloadName, formatArtifactSize, isImageArtifact } from "../../lib/artifacts.js";
import { artifactCanPreview, loadPreviewContent, type PreviewRequest } from "../../lib/previews.js";
import { ArtifactPreviewDrawer } from "../conversation/index.js";
import type { RunArtifact } from "../../types.js";

export function ArtifactRow({
  artifact,
  cwd,
  onUseAsSkillEvidence,
}: {
  readonly artifact: RunArtifact;
  readonly cwd?: string;
  readonly onUseAsSkillEvidence?: (artifact: RunArtifact) => void;
}): JSX.Element {
  const { t } = useI18n();
  const [previewRequest, setPreviewRequest] = useState<PreviewRequest | undefined>();
  const contentUrl = artifactContentUrl(artifact.id, cwd);
  const isImage = isImageArtifact(artifact);
  const title = artifact.title || artifactDownloadName(artifact);
  const downloadName = artifactDownloadName(artifact);
  const previewable = Boolean(cwd) && artifactCanPreview(artifact);

  function openPreview(): void {
    if (!cwd) {
      return;
    }
    setPreviewRequest({ source: "artifact", cwd, artifactId: artifact.id });
  }

  return (
    <div className="artifact-row with-actions">
      <span className={isImage ? "artifact-type image-artifact-type" : "artifact-type"} title={isImage ? t("Image artifact") : artifact.type}>
        {isImage ? <ImageIcon size={13} aria-hidden="true" /> : null}
        {artifact.type}
      </span>
      <a className="artifact-main artifact-main-link" href={contentUrl} target="_blank" rel="noreferrer">
        <strong>{title}</strong>
        <small>{downloadName}</small>
      </a>
      <small>{formatArtifactSize(artifact.sizeBytes)}</small>
      <span className="artifact-actions">
        {onUseAsSkillEvidence ? (
          <button
            className="artifact-action-link"
            type="button"
            onClick={() => onUseAsSkillEvidence(artifact)}
            aria-label={`${t("Use as skill evidence")}: ${title}`}
            title={`${t("Use as skill evidence")}: ${title}`}
          >
            <Save size={13} aria-hidden="true" />
            {t("Skill evidence")}
          </button>
        ) : null}
        {previewable ? (
          <button className="artifact-action-link" type="button" onClick={openPreview} aria-label={`${t("Preview")}: ${title}`} title={`${t("Preview")}: ${title}`}>
            <Eye size={13} aria-hidden="true" />
            {t("Preview")}
          </button>
        ) : null}
        <a className="artifact-action-link" href={contentUrl} target="_blank" rel="noreferrer">
          <ExternalLink size={13} aria-hidden="true" />
          {t("Open")}
        </a>
        <a className="artifact-action-link" href={contentUrl} download={downloadName}>
          <Download size={13} aria-hidden="true" />
          {t("Download")}
        </a>
      </span>
      <ArtifactPreviewDrawer
        request={previewRequest}
        loadPreview={loadPreviewContent}
        openHref={contentUrl}
        downloadHref={contentUrl}
        downloadName={downloadName}
        onClose={() => setPreviewRequest(undefined)}
      />
    </div>
  );
}
