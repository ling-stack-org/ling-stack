import { MediaArtifactPreview } from "../media/MediaArtifactPreview.js";
import { CreateDialogShell } from "../../shared/components/CreateDialogShell.js";
import type { MediaScene, RunArtifact } from "../../types.js";

export function SceneResultPreviewDialog({
  cwd,
  scene,
  artifact,
  onClose,
}: {
  readonly cwd: string;
  readonly scene: MediaScene;
  readonly artifact: RunArtifact;
  readonly onClose: () => void;
}): JSX.Element {
  const video = artifact.type === "video";
  return (
    <CreateDialogShell
      ariaLabel={video ? "预览当前视频" : "预览当前结果"}
      title={video ? "预览当前视频" : "预览当前结果"}
      description={video ? `${scene.title}的当前选用结果，打开后将自动播放。` : `${scene.title}的当前选用结果。`}
      closeLabel="关闭预览"
      onClose={onClose}
      overlayClassName="scene-result-preview-overlay"
      className="scene-result-preview-dialog"
      bodyClassName="scene-result-preview-body"
      footer={<button className="secondary-button" type="button" onClick={onClose}>关闭</button>}
    >
      <div className="scene-result-preview-frame">
        <MediaArtifactPreview artifact={artifact} cwd={cwd} variant="hero" autoPlay={video} />
      </div>
    </CreateDialogShell>
  );
}
