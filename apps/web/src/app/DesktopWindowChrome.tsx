export function DesktopWindowChrome(): React.JSX.Element | null {
  const isMacosDesktop =
    typeof window !== "undefined" && window.lingDesktop?.platform === "macos";

  if (!isMacosDesktop) {
    return null;
  }

  return (
    <div
      className="desktop-window-chrome"
      data-desktop-window-chrome="true"
      aria-hidden="true"
    >
      <div
        className="desktop-window-chrome-region"
        data-desktop-window-drag-owner="sidebar"
        data-desktop-window-drag-region="true"
      />
      <div
        className="desktop-window-chrome-region"
        data-desktop-window-drag-owner="content-fallback"
        data-desktop-window-drag-region="true"
      />
    </div>
  );
}
