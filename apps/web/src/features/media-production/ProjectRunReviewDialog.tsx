import { CircleAlert, Play } from "lucide-react";
import { CreateDialogShell } from "../../shared/components/CreateDialogShell.js";
import type { ProjectRunReview } from "./media-production-view-models.js";

export function ProjectRunReviewDialog({
  review,
  onClose,
  onConfirm,
  isSubmitting,
}: {
  readonly review: ProjectRunReview;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
  readonly isSubmitting: boolean;
}): JSX.Element {
  const hasReadyScenes = review.ready.length > 0;
  return (
    <CreateDialogShell
      ariaLabel={hasReadyScenes ? "确认生成场景" : "检查场景"}
      title={hasReadyScenes ? `生成 ${review.ready.length} 个场景` : "检查场景"}
      description={hasReadyScenes ? "每个场景会生成独立视频片段，不会自动合成为最终视频。" : "查看哪些场景已经完成，以及哪些内容还需要完善。"}
      closeLabel="关闭"
      onClose={onClose}
      overlayClassName="project-run-review-overlay"
      className="project-run-review-dialog"
      bodyClassName="project-run-review-body"
      footer={(
        <>
          <button className="secondary-button" type="button" onClick={onClose} disabled={isSubmitting}>{hasReadyScenes ? "取消" : "关闭"}</button>
          {hasReadyScenes ? (
            <button className="primary-button" type="button" onClick={onConfirm} disabled={isSubmitting}>
              <Play size={16} /> {isSubmitting ? "提交中" : `生成 ${review.ready.length} 个场景`}
            </button>
          ) : null}
        </>
      )}
    >
      <section className="project-run-review-section">
        <div className="project-run-review-section-head">
          <strong>{hasReadyScenes ? `本次将提交 ${review.ready.length} 个场景` : "当前没有可生成场景"}</strong>
          <span>{hasReadyScenes ? "按场景编号依次创建任务" : "完善后可再次检查"}</span>
        </div>
        {review.ready.length ? (
          <ol className="project-run-review-list ready">
            {review.ready.map((item) => <li key={item.sceneId}><span>{String(item.sortOrder + 1).padStart(2, "0")}</span><strong>{item.sceneTitle}</strong><small>{item.workflow?.definition.name ?? item.provider?.displayName ?? "视频模型"}</small></li>)}
          </ol>
        ) : (
          <div className="project-run-review-empty"><CircleAlert size={16} /> 还没有可以提交的场景，请先完善场景输入以及视频模型或生产流程。</div>
        )}
      </section>
      {review.skipped.length ? (
        <section className="project-run-review-section skipped">
          <div className="project-run-review-section-head"><strong>本次不提交 {review.skipped.length} 个场景</strong></div>
          <ul className="project-run-review-list">
            {review.skipped.map((item) => <li key={item.sceneId}><span>{item.label}</span><strong>{item.sceneTitle}</strong><small>{item.reason}</small></li>)}
          </ul>
        </section>
      ) : null}
    </CreateDialogShell>
  );
}
