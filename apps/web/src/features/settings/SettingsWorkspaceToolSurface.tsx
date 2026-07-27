import type { ReactNode } from "react";

export type SettingsWorkspaceToolSurfaceView = "providers" | "teammates" | "councils";

export function SettingsWorkspaceToolSurface({
  children,
  label,
  view,
}: {
  readonly children: ReactNode;
  readonly label: string;
  readonly view: SettingsWorkspaceToolSurfaceView;
}): JSX.Element {
  return (
    <div
      className="settings-workspace-tool-surface"
      data-ui2-settings-workspace-tool="true"
      data-settings-workspace-tool={view}
      data-settings-workspace-tool-label={label}
    >
      {children}
    </div>
  );
}
