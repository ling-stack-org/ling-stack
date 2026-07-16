import type { ComponentProps } from "react";
import { PluginManagerSettingsPanel } from "../settings/PluginManagerSettingsPanel.js";

export type PluginManagerPageProps = ComponentProps<typeof PluginManagerSettingsPanel>;

export function PluginManagerPage(props: PluginManagerPageProps): JSX.Element {
  return (
    <div className="plugin-manager-page">
      <PluginManagerSettingsPanel {...props} />
    </div>
  );
}
