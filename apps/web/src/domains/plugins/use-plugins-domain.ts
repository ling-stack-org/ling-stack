import { useRef, useState } from "react";
import {
  applyManagedPluginPreset,
  checkManagedPlugin,
  connectManagedPlugin,
  createManagedPlugin,
  disableManagedPlugin,
  enableManagedPlugin,
  getManagedPluginRuntimePreview,
  installManagedPlugin,
  listManagedPlugins,
  refreshManagedPluginPackage,
  uninstallManagedPlugin,
  validatePluginPackage,
} from "../../api.js";
import type { DomainController, DomainError } from "../../app/domain-controller.js";
import type { ManagedPluginCreateRequest, ManagedPluginView } from "../../types.js";

export type PluginBusyAction = "create" | "apply" | "check" | "connect" | "enable" | "disable" | "validate" | "install" | "uninstall" | "refresh-package" | "runtime-preview";

export interface PluginActionNotice {
  readonly pluginId: string;
  readonly action: PluginBusyAction;
  readonly tone: "success" | "error";
  readonly message: string;
}

export interface PluginsState {
  readonly plugins: readonly ManagedPluginView[];
  readonly pluginsLoading: boolean;
  readonly pluginBusyId: string;
  readonly pluginBusyAction: PluginBusyAction | undefined;
}

export interface PluginsActions {
  readonly refreshPlugins: (cwd?: string) => Promise<void>;
  readonly createPlugin: (input: ManagedPluginCreateRequest) => Promise<ManagedPluginView | undefined>;
  readonly applyPluginPreset: (pluginId: string) => Promise<void>;
  readonly connectPlugin: (pluginId: string, command?: string) => Promise<ManagedPluginView | undefined>;
  readonly checkPlugin: (pluginId: string) => Promise<void>;
  readonly validatePackage: (pluginId: string) => Promise<void>;
  readonly installPlugin: (pluginId: string) => Promise<void>;
  readonly uninstallPlugin: (pluginId: string) => Promise<void>;
  readonly refreshPluginPackage: (pluginId: string) => Promise<void>;
  readonly previewPluginRuntime: (pluginId: string) => Promise<void>;
  readonly enablePlugin: (pluginId: string) => Promise<void>;
  readonly disablePlugin: (pluginId: string) => Promise<void>;
  readonly resetForCwd: () => void;
}

export type PluginsController = DomainController<PluginsState, PluginsActions>;

export function usePluginsDomain(input: {
  readonly cwd: string;
  readonly translate: (value: string) => string;
  readonly setErrorMessage: (message: string) => void;
  readonly notify: (notice: PluginActionNotice) => void;
}): PluginsController {
  const [plugins, setPlugins] = useState<readonly ManagedPluginView[]>([]);
  const [pluginsLoading, setPluginsLoading] = useState(false);
  const [pluginBusyId, setPluginBusyId] = useState("");
  const [pluginBusyAction, setPluginBusyAction] = useState<PluginBusyAction | undefined>();
  const [error, setError] = useState<DomainError | undefined>();
  const autoConnectInFlightRef = useRef<Promise<ManagedPluginView> | undefined>();

  async function refreshPlugins(cwd = input.cwd): Promise<void> {
    if (!cwd.trim()) {
      setPlugins([]);
      return;
    }
    setPluginsLoading(true);
    try {
      input.setErrorMessage("");
      setError(undefined);
      const response = await listManagedPlugins(cwd);
      setPlugins(response.plugins);
      const detectedCuaDriver = response.plugins.find((plugin) =>
        plugin.id === "trusted-local:cua-driver"
        && plugin.setup?.distribution !== "bundled_embedded"
        && plugin.setup?.state === "detected"
      );
      if (detectedCuaDriver) {
        setPluginBusyId(detectedCuaDriver.id);
        setPluginBusyAction("connect");
        const existingRequest = autoConnectInFlightRef.current;
        const request = existingRequest ?? connectManagedPlugin(cwd, detectedCuaDriver.id).then((result) => result.plugin);
        if (!existingRequest) {
          autoConnectInFlightRef.current = request;
        }
        try {
          const connected = await request;
          setPlugins((current) => upsertPlugin(current, connected));
        } catch (caught) {
          const message = caught instanceof Error ? caught.message : String(caught);
          setError({ scope: "mutation", message });
          input.notify({
            pluginId: detectedCuaDriver.id,
            action: "connect",
            tone: "error",
            message,
          });
        } finally {
          if (autoConnectInFlightRef.current === request) {
            autoConnectInFlightRef.current = undefined;
          }
          setPluginBusyId("");
          setPluginBusyAction(undefined);
        }
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError({ scope: "load", message });
      input.setErrorMessage(message);
    } finally {
      setPluginsLoading(false);
    }
  }

  async function applyPluginPreset(pluginId: string): Promise<void> {
    await mutatePlugin(pluginId, "apply", async (cwd) => {
      const response = await applyManagedPluginPreset(cwd, pluginId);
      input.notify({
        pluginId,
        action: "apply",
        tone: "success",
        message: response.tools.length
          ? input.translate("Preset applied and tools synced.")
          : input.translate("Preset applied."),
      });
      return response.plugin;
    });
  }

  async function createPlugin(createInput: ManagedPluginCreateRequest): Promise<ManagedPluginView | undefined> {
    const workspaceCwd = input.cwd.trim();
    if (!workspaceCwd) {
      input.setErrorMessage(input.translate("Local workspace is not ready."));
      return undefined;
    }
    setPluginBusyId("__create__");
    setPluginBusyAction("create");
    try {
      input.setErrorMessage("");
      setError(undefined);
      const response = await createManagedPlugin(workspaceCwd, createInput);
      setPlugins((current) => upsertPlugin(current, response.plugin));
      input.notify({
        pluginId: response.plugin.id,
        action: "create",
        tone: "success",
        message: input.translate("Plugin added."),
      });
      return response.plugin;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError({ scope: "mutation", message });
      input.notify({ pluginId: "new", action: "create", tone: "error", message });
      input.setErrorMessage(message);
      return undefined;
    } finally {
      setPluginBusyId("");
      setPluginBusyAction(undefined);
    }
  }

  async function connectPlugin(pluginId: string, command?: string): Promise<ManagedPluginView | undefined> {
    return mutatePlugin(pluginId, "connect", async (cwd) =>
      (await connectManagedPlugin(cwd, pluginId, command ? { command } : {})).plugin);
  }

  async function checkPlugin(pluginId: string): Promise<void> {
    await mutatePlugin(pluginId, "check", async (cwd) => (await checkManagedPlugin(cwd, pluginId)).plugin, (plugin) =>
      plugin.health?.message
        ? `${input.translate("Plugin check completed.")} ${plugin.health.message}`
        : input.translate("Plugin check completed."));
  }

  async function validatePackage(pluginId: string): Promise<void> {
    const workspaceCwd = input.cwd.trim();
    if (!workspaceCwd) {
      input.setErrorMessage(input.translate("Local workspace is not ready."));
      return;
    }
    setPluginBusyId(pluginId);
    setPluginBusyAction("validate");
    try {
      input.setErrorMessage("");
      setError(undefined);
      const response = await validatePluginPackage(workspaceCwd, pluginId);
      input.notify({
        pluginId,
        action: "validate",
        tone: response.validation.ok ? "success" : "error",
        message: response.validation.ok
          ? input.translate("Package validation passed.")
          : `${input.translate("Package validation failed.")} ${formatValidationMessage(response.validation.errors[0])}`.trim(),
      });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError({ scope: "mutation", message });
      input.notify({ pluginId, action: "validate", tone: "error", message });
      input.setErrorMessage(message);
    } finally {
      setPluginBusyId("");
      setPluginBusyAction(undefined);
    }
  }

  async function installPlugin(pluginId: string): Promise<void> {
    await mutatePlugin(pluginId, "install", async (cwd) => (await installManagedPlugin(cwd, pluginId)).plugin, (plugin) =>
      plugin.package?.packageHash
        ? `${input.translate("Plugin package installed.")} ${plugin.package.packageHash.slice(0, 12)}`
        : input.translate("Plugin package installed."));
  }

  async function uninstallPlugin(pluginId: string): Promise<void> {
    await mutatePlugin(pluginId, "uninstall", async (cwd) => (await uninstallManagedPlugin(cwd, pluginId)).plugin, () =>
      input.translate("Plugin package uninstalled."));
  }

  async function refreshPluginPackage(pluginId: string): Promise<void> {
    await mutatePlugin(pluginId, "refresh-package", async (cwd) => (await refreshManagedPluginPackage(cwd, pluginId)).plugin, () =>
      input.translate("Plugin package refreshed."));
  }

  async function previewPluginRuntime(pluginId: string): Promise<void> {
    const workspaceCwd = input.cwd.trim();
    if (!workspaceCwd) {
      input.setErrorMessage(input.translate("Local workspace is not ready."));
      return;
    }
    setPluginBusyId(pluginId);
    setPluginBusyAction("runtime-preview");
    try {
      input.setErrorMessage("");
      setError(undefined);
      const response = await getManagedPluginRuntimePreview(workspaceCwd, pluginId);
      setPlugins((current) => upsertPlugin(current, response.plugin));
      input.notify({
        pluginId,
        action: "runtime-preview",
        tone: response.preview.status === "injectable" ? "success" : "error",
        message: response.preview.blockers.length
          ? `${input.translate("Runtime preview blocked.")} ${response.preview.blockers[0]}`
          : input.translate("Runtime preview ready."),
      });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError({ scope: "mutation", message });
      input.notify({ pluginId, action: "runtime-preview", tone: "error", message });
      input.setErrorMessage(message);
    } finally {
      setPluginBusyId("");
      setPluginBusyAction(undefined);
    }
  }

  async function enablePlugin(pluginId: string): Promise<void> {
    await mutatePlugin(pluginId, "enable", async (cwd) => (await enableManagedPlugin(cwd, pluginId)).plugin, (plugin) =>
      plugin.setup?.distribution === "bundled_embedded"
        && plugin.setup.requestedEnabled === true
        && plugin.setup.effectiveEnabled === false
        ? input.translate("Plugin enable requested.")
        : input.translate("Plugin enabled."));
  }

  async function disablePlugin(pluginId: string): Promise<void> {
    await mutatePlugin(pluginId, "disable", async (cwd) => (await disableManagedPlugin(cwd, pluginId)).plugin, () =>
      input.translate("Plugin disabled."));
  }

  async function mutatePlugin(
    pluginId: string,
    action: PluginBusyAction,
    mutation: (cwd: string) => Promise<ManagedPluginView>,
    successMessage?: (plugin: ManagedPluginView) => string,
  ): Promise<ManagedPluginView | undefined> {
    const workspaceCwd = input.cwd.trim();
    if (!workspaceCwd) {
      input.setErrorMessage(input.translate("Local workspace is not ready."));
      return undefined;
    }
    setPluginBusyId(pluginId);
    setPluginBusyAction(action);
    try {
      input.setErrorMessage("");
      setError(undefined);
      const plugin = await mutation(workspaceCwd);
      setPlugins((current) => upsertPlugin(current, plugin));
      if (successMessage) {
        input.notify({
          pluginId,
          action,
          tone: "success",
          message: successMessage(plugin),
        });
      }
      return plugin;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError({ scope: "mutation", message });
      input.notify({
        pluginId,
        action,
        tone: "error",
        message,
      });
      input.setErrorMessage(message);
      return undefined;
    } finally {
      setPluginBusyId("");
      setPluginBusyAction(undefined);
    }
  }

  function resetForCwd(): void {
    setPlugins([]);
    setPluginsLoading(false);
    setPluginBusyId("");
    setPluginBusyAction(undefined);
    setError(undefined);
    autoConnectInFlightRef.current = undefined;
  }

  return {
    state: {
      plugins,
      pluginsLoading,
      pluginBusyId,
      pluginBusyAction,
    },
    actions: {
      refreshPlugins,
      createPlugin,
      applyPluginPreset,
      connectPlugin,
      checkPlugin,
      validatePackage,
      installPlugin,
      uninstallPlugin,
      refreshPluginPackage,
      previewPluginRuntime,
      enablePlugin,
      disablePlugin,
      resetForCwd,
    },
    refresh: refreshPlugins,
    isLoading: pluginsLoading,
    error,
    clearError: () => setError(undefined),
  };
}

function formatValidationMessage(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object" && "message" in value && typeof value.message === "string") {
    return value.message;
  }
  return "";
}

function upsertPlugin(current: readonly ManagedPluginView[], plugin: ManagedPluginView): readonly ManagedPluginView[] {
  const next = current.some((item) => item.id === plugin.id)
    ? current.map((item) => (item.id === plugin.id ? plugin : item))
    : [...current, plugin];
  return next.sort((left, right) => left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id));
}
