import { useMemo, useRef, useState } from "react";
import type { PluginsController } from "../plugins/use-plugins-domain.js";
import { buildComputerControlViewModel } from "./computer-control-view-model.js";
import {
  CUA_DRIVER_PLUGIN_ID,
  resolveCuaDriverSurfaceMode,
} from "./computer-control-surface.js";

export interface ComputerControlController {
  readonly surfaceMode: ReturnType<typeof resolveCuaDriverSurfaceMode>;
  readonly plugin: ReturnType<typeof findCuaPlugin>;
  readonly view: ReturnType<typeof buildComputerControlViewModel>;
  refresh(): Promise<void>;
  setRequestedEnabled(enabled: boolean): Promise<void>;
  recheck(): Promise<void>;
  requestPermissions(): Promise<void>;
  openPermissionSettings(permission: "accessibility" | "screen_recording"): Promise<void>;
}

export function useComputerControlController(input: {
  readonly plugins: PluginsController;
}): ComputerControlController {
  const requestSequenceRef = useRef(0);
  const [permissionPending, setPermissionPending] = useState(false);
  const [permissionError, setPermissionError] = useState<string>();
  const capability = typeof window === "undefined" ? undefined : window.lingDesktop?.computerControl;
  const plugin = findCuaPlugin(input.plugins.state.plugins);
  const surfaceMode = resolveCuaDriverSurfaceMode(capability, plugin);
  const view = useMemo(() => buildComputerControlViewModel({
    surfaceMode,
    plugin,
    loading: input.plugins.state.pluginsLoading,
    loadError: input.plugins.error?.scope === "load" ? input.plugins.error.message : undefined,
    pendingActions: input.plugins.state.pluginPendingActions,
    actionErrors: input.plugins.state.pluginActionErrors,
    permissionPending,
    permissionError,
  }), [
    input.plugins.state.pluginsLoading,
    input.plugins.state.pluginPendingActions,
    input.plugins.state.pluginActionErrors,
    input.plugins.error,
    surfaceMode,
    plugin,
    permissionPending,
    permissionError,
  ]);

  const request = () => ({
    owner: "computer-control" as const,
    requestId: `computer-control:${++requestSequenceRef.current}`,
  });

  return {
    surfaceMode,
    plugin,
    view,
    refresh: () => input.plugins.actions.refreshPlugins(),
    async setRequestedEnabled(enabled) {
      setPermissionError(undefined);
      if (enabled) {
        await input.plugins.actions.enablePlugin(CUA_DRIVER_PLUGIN_ID, request());
      } else {
        await input.plugins.actions.disablePlugin(CUA_DRIVER_PLUGIN_ID, request());
      }
    },
    async recheck() {
      setPermissionError(undefined);
      await input.plugins.actions.checkPlugin(CUA_DRIVER_PLUGIN_ID, request());
    },
    async requestPermissions() {
      if (!capability || permissionPending) return;
      setPermissionPending(true);
      setPermissionError(undefined);
      try {
        const result = await capability.requestPermissions();
        if (!result.accepted) {
          setPermissionError(result.reason ?? "permission_request_rejected");
          return;
        }
        await input.plugins.actions.checkPlugin(CUA_DRIVER_PLUGIN_ID, request());
        await input.plugins.actions.refreshPlugins();
      } catch (error) {
        setPermissionError(error instanceof Error ? error.message : String(error));
      } finally {
        setPermissionPending(false);
      }
    },
    async openPermissionSettings(permission) {
      if (!capability) return;
      setPermissionError(undefined);
      try {
        const result = await capability.openPermissionSettings(permission);
        if (!result.accepted) setPermissionError(result.reason ?? "permission_settings_rejected");
      } catch (error) {
        setPermissionError(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

function findCuaPlugin(plugins: PluginsController["state"]["plugins"]) {
  return plugins.find((plugin) => plugin.id === CUA_DRIVER_PLUGIN_ID);
}
