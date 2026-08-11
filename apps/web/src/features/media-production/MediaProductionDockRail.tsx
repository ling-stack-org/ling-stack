import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from "lucide-react";
import { IconButton } from "../../shared/ui/index.js";
import { useI18n } from "../../i18n.js";

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
}): React.JSX.Element {
  const { t } = useI18n();
  const leftLabel = leftOpen ? t("Close projects and scenes") : t("Projects and scenes");
  const rightLabel = rightAvailable
    ? rightOpen ? t("Collapse") : t("Expand")
    : t("Needs setup");
  const LeftDockIcon = leftOpen ? PanelLeftClose : PanelLeftOpen;
  const RightDockIcon = rightOpen ? PanelRightClose : PanelRightOpen;
  return (
    <>
      <div className="media-production-dock-rail left" aria-label={t("Projects and scenes")}>
        <IconButton
          className={leftOpen ? "active" : undefined}
          icon={LeftDockIcon}
          label={leftLabel}
          pressed={leftOpen}
          size="sm"
          tooltip={leftLabel}
          onClick={onToggleLeft}
        />
      </div>
      <div className="media-production-dock-rail right" aria-label={t("Scenes")}>
        <IconButton
          className={rightOpen ? "active" : undefined}
          disabled={!rightAvailable}
          icon={RightDockIcon}
          label={rightLabel}
          pressed={rightOpen}
          size="sm"
          tooltip={rightLabel}
          onClick={onToggleRight}
        />
      </div>
    </>
  );
}
