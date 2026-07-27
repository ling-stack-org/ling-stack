import { Download, ExternalLink } from "lucide-react";
import { artifactContentUrl } from "../../api.js";
import { artifactDownloadName, formatArtifactSize } from "../../lib/artifacts.js";
import { Button } from "../../shared/ui/index.js";
import { useI18n } from "../../i18n.js";
import type { RunArtifact } from "../../types.js";
import { MediaArtifactPreview } from "./MediaArtifactPreview.js";

export function MediaJobArtifactRow({ artifact, cwd }: { readonly artifact: RunArtifact; readonly cwd: string }): JSX.Element {
  const { t } = useI18n();
  const href = artifactContentUrl(artifact.id, cwd);
  const title = artifact.title || t("Generated result");
  return (
    <div className="media-job-artifact-row" data-media-job-artifact={artifact.id}>
      <MediaArtifactPreview artifact={artifact} cwd={cwd} mode="tile" />
      <span className="media-job-artifact-copy">
        <strong title={title}>{title}</strong>
        <span>{t(artifact.type)}{artifact.sizeBytes ? ` · ${formatArtifactSize(artifact.sizeBytes)}` : ""}</span>
      </span>
      <span className="media-job-artifact-actions">
        <Button asChild leadingIcon={<ExternalLink size={15} />} size="sm" variant="ghost">
          <a href={href} target="_blank" rel="noreferrer">{t("Open")}</a>
        </Button>
        <Button asChild leadingIcon={<Download size={15} />} size="sm" variant="ghost">
          <a href={href} download={artifactDownloadName(artifact)}>{t("Download")}</a>
        </Button>
      </span>
    </div>
  );
}
