import { Download, ExternalLink } from "lucide-react";
import { artifactContentUrl } from "../../api.js";
import { useI18n } from "../../i18n.js";
import { artifactDownloadName } from "../../lib/artifacts.js";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
} from "../../shared/ui/index.js";
import type { MediaScene, RunArtifact } from "../../types.js";
import { MediaArtifactPreview } from "../media/MediaArtifactPreview.js";

export function SceneResultPreviewDialog({
  cwd,
  scene,
  artifact,
  currentMediaJobId,
  onClose,
  onOpenTask,
}: {
  readonly cwd: string;
  readonly scene: MediaScene;
  readonly artifact: RunArtifact;
  readonly currentMediaJobId?: string;
  readonly onClose: () => void;
  readonly onOpenTask: (mediaJobId: string) => void;
}): JSX.Element {
  const { t } = useI18n();
  const href = artifactContentUrl(artifact.id, cwd);
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        className="scene-result-preview-dialog"
        overlayClassName="scene-result-preview-overlay"
        size="lg"
        data-current-media-job={currentMediaJobId}
        data-media-production-dialog="scene-result-preview"
      >
        <DialogHeader closeLabel={t("Close preview")} title={t("Preview")} description={scene.title} />
        <DialogBody className="scene-result-preview-body">
          <div className="scene-result-preview-frame">
            <MediaArtifactPreview artifact={artifact} cwd={cwd} mode="scene" autoPlay={artifact.type === "video"} />
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>{t("Close")}</Button>
          <Button asChild leadingIcon={<Download size={15} />}>
            <a href={href} download={artifactDownloadName(artifact)}>{t("Download")}</a>
          </Button>
          {currentMediaJobId ? (
            <Button
              leadingIcon={<ExternalLink size={15} />}
              variant="primary"
              onClick={() => onOpenTask(currentMediaJobId)}
            >
              {t("Open task")}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
