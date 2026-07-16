import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from "lucide-react";

export function MediaProductionDockRail({
  leftOpen,
  rightOpen,
  rightAvailable,
  onToggleLeft,
  onToggleRight,
}: {
  readonly leftOpen: boolean;
  readonly rightOpen: boolean;
  readonly rightAvailable: boolean;
  readonly onToggleLeft: () => void;
  readonly onToggleRight: () => void;
}): JSX.Element {
  return (
    <>
      <div className="media-production-dock-rail left" aria-label="项目与分镜">
        <button className={leftOpen ? "active" : ""} type="button" onClick={onToggleLeft} title={leftOpen ? "收起项目与分镜" : "展开项目与分镜"} aria-label={leftOpen ? "收起项目与分镜" : "展开项目与分镜"}>
          {leftOpen ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}
        </button>
      </div>
      <div className="media-production-dock-rail right" aria-label="场景检查器">
        <button className={rightOpen ? "active" : ""} type="button" onClick={onToggleRight} disabled={!rightAvailable} title={rightAvailable ? (rightOpen ? "收起场景检查器" : "展开场景检查器") : "选择一个场景后查看检查器"} aria-label={rightAvailable ? (rightOpen ? "收起场景检查器" : "展开场景检查器") : "选择一个场景后查看检查器"}>
          {rightOpen ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}
        </button>
      </div>
    </>
  );
}
