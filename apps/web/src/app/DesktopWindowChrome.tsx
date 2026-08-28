import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { IconButton } from "../shared/ui/index.js";

export function DesktopWindowChrome({
  hideSidebarLabel,
  onSidebarOpenChange,
  showSidebarLabel,
  sidebarOpen,
  sidebarToggleVisible,
}: {
  readonly hideSidebarLabel: string;
  readonly onSidebarOpenChange: (open: boolean) => void;
  readonly showSidebarLabel: string;
  readonly sidebarOpen: boolean;
  readonly sidebarToggleVisible: boolean;
}): React.JSX.Element | null {
  const isMacosDesktop =
    typeof window !== "undefined" && window.lingDesktop?.platform === "macos";

  if (!isMacosDesktop) {
    return null;
  }

  return (
    <div
      className="desktop-window-chrome"
      data-desktop-window-chrome="true"
    >
      <div
        className="desktop-window-chrome-region"
        data-desktop-window-drag-owner="sidebar"
        data-desktop-window-drag-region="true"
        aria-hidden="true"
      />
      <div
        className="desktop-window-chrome-region"
        data-desktop-window-drag-owner="content-fallback"
        data-desktop-window-drag-region="true"
        aria-hidden="true"
      />
      {sidebarToggleVisible ? (
        <div
          className="desktop-window-chrome-toolbar"
          data-desktop-window-no-drag="true"
        >
          <IconButton
            className="desktop-window-sidebar-toggle"
            label={sidebarOpen ? hideSidebarLabel : showSidebarLabel}
            icon={sidebarOpen ? PanelLeftClose : PanelLeftOpen}
            pressed={sidebarOpen}
            onClick={() => onSidebarOpenChange(!sidebarOpen)}
          />
        </div>
      ) : null}
    </div>
  );
}
