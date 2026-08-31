import { useEffect, useState } from "react";
import { Copy, Minus, PanelLeftClose, PanelLeftOpen, Square, X } from "lucide-react";
import { useI18n } from "../i18n.js";
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
  const { t } = useI18n();
  const setTitlebarHost = useDesktopTitlebarHost();
  const windowControls = typeof window === "undefined" ? undefined : window.lingDesktop?.windowControls;
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!windowControls) return undefined;
    return windowControls.onStateChanged((state) => setMaximized(state.maximized));
  }, [windowControls]);

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
      {windowControls ? (
        <div
          className="desktop-window-controls"
          data-desktop-window-no-drag="true"
          role="toolbar"
          aria-label={t("Window controls")}
        >
          <IconButton
            className="desktop-window-control desktop-window-minimize"
            icon={Minus}
            label={t("Minimize window")}
            onClick={() => void windowControls.minimize()}
          />
          <IconButton
            className="desktop-window-control desktop-window-maximize"
            icon={maximized ? Copy : Square}
            label={maximized ? t("Restore window") : t("Maximize window")}
            onClick={() => void windowControls.toggleMaximize()}
          />
          <IconButton
            className="desktop-window-control desktop-window-close"
            icon={X}
            label={t("Close window")}
            onClick={() => void windowControls.close()}
          />
        </div>
      ) : null}
    </div>
  );
}
