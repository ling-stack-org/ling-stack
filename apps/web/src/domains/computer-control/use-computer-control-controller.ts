import { useEffect, useMemo, useRef, useState } from "react";
import type { PluginsController } from "../plugins/use-plugins-domain.js";
import { buildComputerControlViewModel } from "./computer-control-view-model.js";
import {
  CUA_DRIVER_PLUGIN_ID,
  resolveCuaDriverSurfaceMode,
} from "./computer-control-surface.js";
import {
  buildLockedComputerControlViewModel,
  type LockedControlCommand,
} from "./locked-control-view-model.js";

export interface ComputerControlController {
  readonly surfaceMode: ReturnType<typeof resolveCuaDriverSurfaceMode>;
  readonly plugin: ReturnType<typeof findCuaPlugin>;
  readonly view: ReturnType<typeof buildComputerControlViewModel>;
  readonly lockedView: ReturnType<typeof buildLockedComputerControlViewModel>;
  refresh(): Promise<void>;
  setRequestedEnabled(enabled: boolean): Promise<void>;
  recheck(): Promise<void>;
  requestPermissions(): Promise<void>;
  openPermissionSettings(permission: "accessibility" | "screen_recording"): Promise<void>;
  authorizeLockedControl(): Promise<void>;
  revokeLockedControl(): Promise<void>;
}

export function useComputerControlController(input: {
  readonly plugins: PluginsController;
}): ComputerControlController {
  const requestSequenceRef = useRef(0);
  const commandQueueRef = useRef<Promise<void>>(Promise.resolve());
  const [permissionPending, setPermissionPending] = useState(false);
  const [permissionError, setPermissionError] = useState<string>();
  const [lockedPending, setLockedPending] = useState<LockedControlCommand>();
  const [lockedError, setLockedError] = useState<string>();
  const [lockedNowMs, setLockedNowMs] = useState(() => Date.now());
  const capability = typeof window === "undefined" ? undefined : window.lingDesktop?.computerControl;
  const plugin = findCuaPlugin(input.plugins.state.plugins);
  const surfaceMode = resolveCuaDriverSurfaceMode(capability, plugin);
  const lockedProjection = plugin?.setup?.lockedControl;
  const lockedExpiry = lockedProjection?.expiresAt;
  useEffect(() => {
    if (!lockedExpiry) return;
    setLockedNowMs(Date.now());
    const timer = window.setInterval(() => setLockedNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [lockedExpiry]);
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
  const lockedView = useMemo(() => buildLockedComputerControlViewModel({
    projection: lockedProjection,
    requestedEnabled: plugin?.setup?.requestedEnabled === true,
    effectiveEnabled: plugin?.setup?.effectiveEnabled === true,
    nowMs: lockedNowMs,
    ...(lockedPending ? { busyAction: lockedPending } : {}),
    ...(lockedError ? { commandError: lockedError } : {}),
  }), [lockedError, lockedNowMs, lockedPending, lockedProjection, plugin]);

  const request = () => ({
    owner: "computer-control" as const,
    requestId: `computer-control:${++requestSequenceRef.current}`,
  });

  const enqueue = (command: () => Promise<void>): Promise<void> => {
    const next = commandQueueRef.current.then(command, command);
    commandQueueRef.current = next.catch(() => undefined);
    return next;
  };

  const runLockedCommand = (action: LockedControlCommand): Promise<void> => enqueue(async () => {
    if (!capability) return;
    setLockedPending(action);
    setLockedError(undefined);
    try {
      const result = action === "authorize"
        ? await capability.authorizeLockedControl()
        : await capability.revokeLockedControl();
      if (!result.accepted) {
        setLockedError(result.reason ?? `locked_control_${action}_rejected`);
      }
    } catch (error) {
      setLockedError(error instanceof Error ? error.message : String(error));
    } finally {
      try {
        await input.plugins.actions.refreshPlugins();
      } finally {
        setLockedPending(undefined);
      }
    }
  });

  return {
    surfaceMode,
    plugin,
    view,
    lockedView,
    refresh: () => input.plugins.actions.refreshPlugins(),
    setRequestedEnabled: (enabled) => enqueue(async () => {
      setPermissionError(undefined);
      setLockedError(undefined);
      if (enabled) {
        await input.plugins.actions.enablePlugin(CUA_DRIVER_PLUGIN_ID, request());
      } else {
        if (lockedProjection?.phase !== "off") {
          await capability?.revokeLockedControl();
        }
        await input.plugins.actions.disablePlugin(CUA_DRIVER_PLUGIN_ID, request());
      }
      await input.plugins.actions.refreshPlugins();
    }),
    recheck: () => enqueue(async () => {
      setPermissionError(undefined);
      setLockedError(undefined);
      await input.plugins.actions.checkPlugin(CUA_DRIVER_PLUGIN_ID, request());
      await input.plugins.actions.refreshPlugins();
    }),
    requestPermissions: () => enqueue(async () => {
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
    }),
    openPermissionSettings: (permission) => enqueue(async () => {
      if (!capability) return;
      setPermissionError(undefined);
      try {
        const result = await capability.openPermissionSettings(permission);
        if (!result.accepted) setPermissionError(result.reason ?? "permission_settings_rejected");
      } catch (error) {
        setPermissionError(error instanceof Error ? error.message : String(error));
      }
    }),
    authorizeLockedControl: () => runLockedCommand("authorize"),
    revokeLockedControl: () => runLockedCommand("revoke"),
  };
}

function findCuaPlugin(plugins: PluginsController["state"]["plugins"]) {
  return plugins.find((plugin) => plugin.id === CUA_DRIVER_PLUGIN_ID);
}
