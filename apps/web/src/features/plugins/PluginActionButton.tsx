import {
  ChevronRight,
  Download,
  Eye,
  Loader2,
  Power,
  PowerOff,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Wrench,
} from "lucide-react";
import type { PluginBusyAction } from "../../domains/plugins/use-plugins-domain.js";
import type { PluginActionId, PluginActionView } from "../settings/plugin-manager-view-models.js";

export interface PluginActionHandlers {
  readonly onApplyPreset: (pluginId: string) => void;
  readonly onOpenInstallGuide: (pluginId: string) => void;
  readonly onOpenDetails: (pluginId: string) => void;
  readonly onCheck: (pluginId: string) => void;
  readonly onValidatePackage: (pluginId: string) => void;
  readonly onInstall: (pluginId: string) => void;
  readonly onUninstall: (pluginId: string) => void;
  readonly onRefreshPackage: (pluginId: string) => void;
  readonly onRuntimePreview: (pluginId: string) => void;
  readonly onEnable: (pluginId: string) => void;
  readonly onDisable: (pluginId: string) => void;
}

export function PluginActionButton({
  action,
  pluginId,
  busyPluginId,
  busyAction,
  handlers,
  presentation = "row",
}: {
  readonly action: PluginActionView;
  readonly pluginId: string;
  readonly busyPluginId: string;
  readonly busyAction: PluginBusyAction | undefined;
  readonly handlers: PluginActionHandlers;
  readonly presentation?: "row" | "drawer";
}): JSX.Element {
  const rowBusy = busyAction !== undefined && busyPluginId === pluginId;
  const busy = rowBusy && busyAction === action.id;
  const iconOnly = presentation === "row" && action.tone !== "primary";
  const className = presentation === "drawer"
    ? `secondary-button compact-button plugin-drawer-action${action.tone === "danger" ? " danger" : ""}`
    : iconOnly
      ? `icon-button plugin-table-icon-action${action.tone === "danger" ? " danger" : ""}`
      : "secondary-button compact-button plugin-table-primary-action";
  return (
    <button
      className={className}
      type="button"
      onClick={() => runPluginAction(action.id, pluginId, handlers)}
      disabled={rowBusy}
      aria-label={iconOnly ? action.label : undefined}
      title={iconOnly ? action.label : undefined}
    >
      {busy ? <Loader2 className="spin" size={14} /> : pluginActionIcon(action.id)}
      {iconOnly ? null : <span>{action.label}</span>}
    </button>
  );
}

function pluginActionIcon(action: PluginActionId): JSX.Element {
  switch (action) {
    case "apply":
      return <Wrench size={14} />;
    case "guide":
    case "install":
      return <Download size={14} />;
    case "check":
      return <RefreshCw size={14} />;
    case "enable":
      return <Power size={14} />;
    case "disable":
      return <PowerOff size={14} />;
    case "details":
      return <ChevronRight size={15} />;
    case "runtime-preview":
      return <Eye size={14} />;
    case "refresh-package":
      return <RefreshCw size={14} />;
    case "validate":
      return <ShieldCheck size={14} />;
    case "uninstall":
      return <Trash2 size={14} />;
  }
}

function runPluginAction(action: PluginActionId, pluginId: string, handlers: PluginActionHandlers): void {
  switch (action) {
    case "guide":
      handlers.onOpenInstallGuide(pluginId);
      return;
    case "details":
      handlers.onOpenDetails(pluginId);
      return;
    case "apply":
      handlers.onApplyPreset(pluginId);
      return;
    case "check":
      handlers.onCheck(pluginId);
      return;
    case "validate":
      handlers.onValidatePackage(pluginId);
      return;
    case "install":
      handlers.onInstall(pluginId);
      return;
    case "uninstall":
      handlers.onUninstall(pluginId);
      return;
    case "refresh-package":
      handlers.onRefreshPackage(pluginId);
      return;
    case "runtime-preview":
      handlers.onRuntimePreview(pluginId);
      return;
    case "enable":
      handlers.onEnable(pluginId);
      return;
    case "disable":
      handlers.onDisable(pluginId);
      return;
  }
}
