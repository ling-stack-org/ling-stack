import { CreateDialogShell } from "../../shared/components/CreateDialogShell.js";
import type { MediaScene } from "../../types.js";

export function SceneDeleteDialog({
  scene,
  isDeleting,
  onClose,
  onConfirm,
}: {
  readonly scene: MediaScene;
  readonly isDeleting: boolean;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
}): JSX.Element {
  return (
    <CreateDialogShell
      ariaLabel="删除场景"
      title="删除这个场景？"
      description="场景将从项目中移除，已生成的视频和任务记录仍会保留。"
      closeLabel="关闭"
      onClose={onClose}
      overlayClassName="scene-delete-overlay"
      className="scene-delete-dialog"
      bodyClassName="scene-delete-body"
      footer={(
        <>
          <button className="secondary-button" type="button" onClick={onClose} disabled={isDeleting}>取消</button>
          <button className="scene-delete-confirm" type="button" onClick={onConfirm} disabled={isDeleting}>{isDeleting ? "删除中…" : "删除场景"}</button>
        </>
      )}
    >
      {null}
    </CreateDialogShell>
  );
}
