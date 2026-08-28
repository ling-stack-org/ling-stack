import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { IconButton } from "../shared/ui/index.js";
import { useDesktopTitlebarHost } from "./DesktopTitlebarSurface.js";

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
  const setTitlebarHost = useDesktopTitlebarHost();
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
        className="desktop-window-chrome-leading"
        data-desktop-window-drag-region="true"
      >
        <span className="desktop-window-traffic-light-exclusion" aria-hidden="true" />
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
      <div
        ref={setTitlebarHost}
        className="desktop-window-titlebar-surface"
        data-desktop-window-titlebar-surface="true"
        data-desktop-window-drag-region="true"
      />
    </div>
  );
}
