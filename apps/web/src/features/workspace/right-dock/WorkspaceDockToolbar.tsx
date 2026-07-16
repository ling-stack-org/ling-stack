import { Code2, FileText, PanelRightClose, PanelRightOpen } from "lucide-react";
import type { DockPageKind } from "../../../shared/conversation/index.js";
import { useI18n } from "../../../i18n.js";
import {
  WorkspaceToolbarActionButton,
  WorkspaceToolbarIconButton,
  WorkspaceTopRightToolbar,
} from "./WorkspaceTopRightToolbar.js";

export type WorkspaceDockToolbarMode = "icon" | "channel";

export interface WorkspaceDockToolbarProps {
  readonly open: boolean;
  readonly reviewCount: number;
  readonly fileCount: number;
  readonly ariaLabel?: string;
  readonly mode?: WorkspaceDockToolbarMode;
  readonly onOpenPage: (page: DockPageKind) => void;
  readonly onToggleDetails: () => void;
}

type WorkspaceDockToolbarButtonsProps = Omit<WorkspaceDockToolbarProps, "ariaLabel">;

export function WorkspaceDockToolbarButtons({
  open,
  reviewCount,
  fileCount,
  mode = "channel",
  onOpenPage,
  onToggleDetails,
}: WorkspaceDockToolbarButtonsProps): JSX.Element {
  const { t } = useI18n();
  const items = [
    {
      id: "review" as const,
      label: t("Review"),
      count: reviewCount,
      icon: <Code2 size={15} />,
    },
    {
      id: "files" as const,
      label: t("Files"),
      count: fileCount,
      icon: <FileText size={15} />,
    },
  ].filter((item) => item.count > 0);

  return (
    <>
      {items.map((item) => (
        mode === "channel" ? (
          <WorkspaceToolbarActionButton
            key={item.id}
            className="workspace-dock-toolbar-button workspace-dock-toolbar-action"
            count={item.count}
            icon={item.icon}
            label={t("{label}: {count}", { label: item.label, count: item.count })}
            visibleLabel={item.label}
            onClick={() => onOpenPage(item.id)}
          />
        ) : (
          <WorkspaceToolbarIconButton
            key={item.id}
            className="workspace-dock-toolbar-button"
            count={item.count}
            icon={item.icon}
            label={t("{label}: {count}", { label: item.label, count: item.count })}
            onClick={() => onOpenPage(item.id)}
          />
        )
      ))}
      <WorkspaceToolbarIconButton
        active={open}
        className="workspace-dock-toolbar-button workspace-dock-toolbar-details"
        aria-expanded={open}
        icon={open ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
        label={open ? t("Hide details") : t("Show details")}
        onClick={onToggleDetails}
      />
    </>
  );
}

export function WorkspaceDockToolbar({
  ariaLabel,
  ...buttonProps
}: WorkspaceDockToolbarProps): JSX.Element {
  const { t } = useI18n();
  return (
    <WorkspaceTopRightToolbar className="workspace-dock-toolbar" ariaLabel={ariaLabel ?? t("Workspace dock toolbar")}>
      <WorkspaceDockToolbarButtons {...buttonProps} />
    </WorkspaceTopRightToolbar>
  );
}
