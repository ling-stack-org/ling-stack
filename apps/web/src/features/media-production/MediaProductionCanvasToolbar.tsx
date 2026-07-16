import { Clapperboard, ListVideo, PanelsTopLeft, Play, Settings2 } from "lucide-react";
import { useI18n } from "../../i18n.js";
import type { MediaProductionView } from "./media-production-types.js";

export function MediaProductionCanvasToolbar({
  projectName,
  sceneCount,
  view,
  canRun,
  hasVideoModel,
  busy,
  onViewChange,
  onOpenProjectDock,
  onRunProject,
  onConfigureVideoModel,
}: {
  readonly projectName?: string;
  readonly sceneCount: number;
  readonly view: MediaProductionView;
  readonly canRun: boolean;
  readonly hasVideoModel: boolean;
  readonly busy: boolean;
  readonly onViewChange: (view: MediaProductionView) => void;
  readonly onOpenProjectDock: () => void;
  readonly onRunProject: () => void;
  readonly onConfigureVideoModel: () => void;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <nav className="media-production-canvas-toolbar" aria-label="媒体生产工具栏">
      <button className="media-production-project-trigger" type="button" onClick={onOpenProjectDock} title="打开项目与分镜" aria-label="打开项目与分镜">
        <PanelsTopLeft size={15} />
        <span>{projectName ?? "项目与分镜"}</span>
        {projectName ? <small>{sceneCount} 个场景</small> : null}
      </button>
      <span className="media-production-toolbar-divider" aria-hidden="true" />
      <span className="media-production-view-switcher" role="tablist" aria-label="媒体生产视图">
        <button className={view === "studio" ? "active" : ""} type="button" role="tab" aria-selected={view === "studio"} onClick={() => onViewChange("studio")}>
          <Clapperboard size={14} /> {t("Production studio")}
        </button>
        <button className={view === "jobs" ? "active" : ""} type="button" role="tab" aria-selected={view === "jobs"} onClick={() => onViewChange("jobs")}>
          <ListVideo size={14} /> {t("Generation tasks")}
        </button>
      </span>
      {view === "studio" && projectName ? (
        <>
          <span className="media-production-toolbar-divider" aria-hidden="true" />
          {hasVideoModel ? (
            <button className="primary-button compact-button" type="button" onClick={onRunProject} disabled={busy} title={canRun ? "确认本次要生成的场景" : "查看需要完善的场景"}>
              <Play size={15} /> 按顺序生成
            </button>
          ) : (
            <button className="secondary-button compact-button" type="button" onClick={onConfigureVideoModel} disabled={busy}>
              <Settings2 size={15} /> 配置视频模型
            </button>
          )}
        </>
      ) : null}
    </nav>
  );
}
