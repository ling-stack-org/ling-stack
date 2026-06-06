import { useState } from "react";
import {
  applyManagedPluginPreset,
  checkManagedPlugin,
  disableManagedPlugin,
  enableManagedPlugin,
  listManagedPlugins,
} from "../../api.js";
import type { DomainController, DomainError } from "../../app/domain-controller.js";
import type { ManagedPluginApplyPresetResponse, ManagedPluginView } from "../../types.js";

export type PluginBusyAction = "apply" | "check" | "enable" | "disable";

export interface PluginsState {
  readonly plugins: readonly ManagedPluginView[];
  readonly pluginsLoading: boolean;
  readonly pluginBusyId: string;
  readonly pluginBusyAction: PluginBusyAction | undefined;
  readonly latestApplyResult?: ManagedPluginApplyPresetResponse;
}

export interface PluginsActions {
  readonly refreshPlugins: (cwd?: string) => Promise<void>;
  readonly applyPluginPreset: (pluginId: string) => Promise<void>;
  readonly checkPlugin: (pluginId: string) => Promise<void>;
  readonly enablePlugin: (pluginId: string) => Promise<void>;
  readonly disablePlugin: (pluginId: string) => Promise<void>;
  readonly resetForCwd: () => void;
}

export type PluginsController = DomainController<PluginsState, PluginsActions>;

export function usePluginsDomain(input: {
  readonly cwd: string;
  readonly translate: (value: string) => string;
  readonly setErrorMessage: (message: string) => void;
}): PluginsController {
  const [plugins, setPlugins] = useState<readonly ManagedPluginView[]>([]);
  const [pluginsLoading, setPluginsLoading] = useState(false);
  const [pluginBusyId, setPluginBusyId] = useState("");
  const [pluginBusyAction, setPluginBusyAction] = useState<PluginBusyAction | undefined>();
  const [latestApplyResult, setLatestApplyResult] = useState<ManagedPluginApplyPresetResponse | undefined>();
  const [error, setError] = useState<DomainError | undefined>();

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
      setLatestApplyResult(response);
      return response.plugin;
    });
  }

  async function checkPlugin(pluginId: string): Promise<void> {
    await mutatePlugin(pluginId, "check", async (cwd) => (await checkManagedPlugin(cwd, pluginId)).plugin);
  }

  async function enablePlugin(pluginId: string): Promise<void> {
    await mutatePlugin(pluginId, "enable", async (cwd) => (await enableManagedPlugin(cwd, pluginId)).plugin);
  }

  async function disablePlugin(pluginId: string): Promise<void> {
    await mutatePlugin(pluginId, "disable", async (cwd) => (await disableManagedPlugin(cwd, pluginId)).plugin);
  }

  async function mutatePlugin(
    pluginId: string,
    action: PluginBusyAction,
    mutation: (cwd: string) => Promise<ManagedPluginView>,
  ): Promise<void> {
    const workspaceCwd = input.cwd.trim();
    if (!workspaceCwd) {
      input.setErrorMessage(input.translate("Local workspace is not ready."));
      return;
    }
    setPluginBusyId(pluginId);
    setPluginBusyAction(action);
    try {
      input.setErrorMessage("");
      setError(undefined);
      const plugin = await mutation(workspaceCwd);
      setPlugins((current) => upsertPlugin(current, plugin));
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError({ scope: "mutation", message });
      input.setErrorMessage(message);
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
    setLatestApplyResult(undefined);
    setError(undefined);
  }

  return {
    state: {
      plugins,
      pluginsLoading,
      pluginBusyId,
      pluginBusyAction,
      latestApplyResult,
    },
    actions: {
      refreshPlugins,
      applyPluginPreset,
      checkPlugin,
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

function upsertPlugin(current: readonly ManagedPluginView[], plugin: ManagedPluginView): readonly ManagedPluginView[] {
  const next = current.some((item) => item.id === plugin.id)
    ? current.map((item) => (item.id === plugin.id ? plugin : item))
    : [...current, plugin];
  return next.sort((left, right) => left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id));
}
