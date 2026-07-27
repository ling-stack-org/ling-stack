import { useCallback, useRef, useState } from "react";
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

export const PLUGIN_DRAFT_ID = "draft";

export type PluginActionOwner = "create" | "detected-connect" | "row" | "detail" | "guide" | "uninstall";

export interface PluginActionRequest {
  readonly owner: PluginActionOwner;
  readonly requestId: string;
}

export interface PluginPendingAction extends PluginActionRequest {
  readonly pluginId: string;
  readonly action: PluginBusyAction;
}

export interface PluginActionError extends PluginPendingAction {
  readonly message: string;
}

export interface PluginActionErrorFilter {
  readonly pluginId?: string;
  readonly action?: PluginBusyAction;
  readonly owner?: PluginActionOwner;
}

export interface PluginActionNotice {
  readonly pluginId: string;
  readonly action: PluginBusyAction;
  readonly owner: PluginActionOwner;
  readonly tone: "success" | "error";
  readonly message: string;
}

export interface PluginsState {
  readonly plugins: readonly ManagedPluginView[];
  readonly pluginsLoading: boolean;
  readonly pluginPendingActions: readonly PluginPendingAction[];
  readonly pluginActionErrors: readonly PluginActionError[];
}

export interface PluginsActions {
  readonly refreshPlugins: (cwd?: string) => Promise<void>;
  readonly createPlugin: (input: ManagedPluginCreateRequest, request: PluginActionRequest) => Promise<ManagedPluginView | undefined>;
  readonly applyPluginPreset: (pluginId: string, request: PluginActionRequest) => Promise<void>;
  readonly connectPlugin: (pluginId: string, request: PluginActionRequest, command?: string) => Promise<ManagedPluginView | undefined>;
  readonly checkPlugin: (pluginId: string, request: PluginActionRequest) => Promise<void>;
  readonly validatePackage: (pluginId: string, request: PluginActionRequest) => Promise<void>;
  readonly installPlugin: (pluginId: string, request: PluginActionRequest) => Promise<void>;
  readonly uninstallPlugin: (pluginId: string, request: PluginActionRequest) => Promise<void>;
  readonly refreshPluginPackage: (pluginId: string, request: PluginActionRequest) => Promise<void>;
  readonly previewPluginRuntime: (pluginId: string, request: PluginActionRequest) => Promise<void>;
  readonly enablePlugin: (pluginId: string, request: PluginActionRequest) => Promise<void>;
  readonly disablePlugin: (pluginId: string, request: PluginActionRequest) => Promise<void>;
  readonly clearPluginActionErrors: (filter: PluginActionErrorFilter) => void;
  readonly resetForCwd: () => void;
}

export type PluginsController = DomainController<PluginsState, PluginsActions>;

export function usePluginsDomain(input: {
  readonly cwd: string;
  readonly translate: (value: string) => string;
  readonly notify: (notice: PluginActionNotice) => void;
}): PluginsController {
  const [plugins, setPlugins] = useState<readonly ManagedPluginView[]>([]);
  const [pluginsLoading, setPluginsLoading] = useState(false);
  const [pluginPendingActions, setPluginPendingActions] = useState<readonly PluginPendingAction[]>([]);
  const [pluginActionErrors, setPluginActionErrors] = useState<readonly PluginActionError[]>([]);
  const [error, setError] = useState<DomainError | undefined>();
  const autoConnectInFlightRef = useRef<Promise<ManagedPluginView | undefined> | undefined>();
  const latestActionRequestsRef = useRef(new Map<string, string>());
  const loadRequestIdRef = useRef(0);
  const internalRequestIdRef = useRef(0);
  const clearPluginActionErrors = useCallback((filter: PluginActionErrorFilter): void => {
    setPluginActionErrors((current) => current.filter((candidate) => !matchesPluginActionFilter(candidate, filter)));
  }, []);

  async function refreshPlugins(cwd = input.cwd): Promise<void> {
    if (!cwd.trim()) {
      setPlugins([]);
      setError(undefined);
      return;
    }
    const loadRequestId = ++loadRequestIdRef.current;
    setPluginsLoading(true);
    setError(undefined);
    try {
      const response = await listManagedPlugins(cwd);
      if (loadRequestIdRef.current !== loadRequestId) return;
      setPlugins(response.plugins);
      const detectedCuaDriver = response.plugins.find((plugin) =>
        plugin.id === "trusted-local:cua-driver" && plugin.setup?.state === "detected"
      );
      if (detectedCuaDriver) {
        const existingRequest = autoConnectInFlightRef.current;
        const request = existingRequest ?? runPluginOperation(
          detectedCuaDriver.id,
          "connect",
          {
            owner: "detected-connect",
            requestId: `detected-connect:${++internalRequestIdRef.current}`,
          },
          async (workspaceCwd) => {
            const connected = (await connectManagedPlugin(workspaceCwd, detectedCuaDriver.id)).plugin;
            return { plugin: connected, value: connected };
          },
          cwd,
        );
        if (!existingRequest) {
          autoConnectInFlightRef.current = request;
        }
        try {
          await request;
        } finally {
          if (autoConnectInFlightRef.current === request) {
            autoConnectInFlightRef.current = undefined;
          }
        }
      }
    } catch (caught) {
      if (loadRequestIdRef.current !== loadRequestId) return;
      const message = caught instanceof Error ? caught.message : String(caught);
      setError({ scope: "load", message });
    } finally {
      if (loadRequestIdRef.current === loadRequestId) setPluginsLoading(false);
    }
  }

  async function applyPluginPreset(pluginId: string, request: PluginActionRequest): Promise<void> {
    await runPluginOperation(pluginId, "apply", request, async (cwd) => {
      const response = await applyManagedPluginPreset(cwd, pluginId);
      return {
        plugin: response.plugin,
        value: response.plugin,
        successMessage: response.tools.length
          ? input.translate("Preset applied and tools synced.")
          : input.translate("Preset applied."),
      };
    });
  }

  async function createPlugin(createInput: ManagedPluginCreateRequest, request: PluginActionRequest): Promise<ManagedPluginView | undefined> {
    return runPluginOperation(PLUGIN_DRAFT_ID, "create", request, async (cwd) => {
      const response = await createManagedPlugin(cwd, createInput);
      return {
        plugin: response.plugin,
        value: response.plugin,
        successMessage: input.translate("Plugin added."),
        noticePluginId: response.plugin.id,
      };
    });
  }

  async function connectPlugin(pluginId: string, request: PluginActionRequest, command?: string): Promise<ManagedPluginView | undefined> {
    return mutatePlugin(pluginId, "connect", request, async (cwd) =>
      (await connectManagedPlugin(cwd, pluginId, command ? { command } : {})).plugin);
  }

  async function checkPlugin(pluginId: string, request: PluginActionRequest): Promise<void> {
    await mutatePlugin(pluginId, "check", request, async (cwd) => (await checkManagedPlugin(cwd, pluginId)).plugin, (plugin) =>
      plugin.health?.message
        ? `${input.translate("Plugin check completed.")} ${plugin.health.message}`
        : input.translate("Plugin check completed."));
  }

  async function validatePackage(pluginId: string, request: PluginActionRequest): Promise<void> {
    await runPluginOperation(pluginId, "validate", request, async (cwd) => {
      const response = await validatePluginPackage(cwd, pluginId);
      const validationError = response.validation.ok
        ? undefined
        : `${input.translate("Package validation failed.")} ${formatValidationMessage(response.validation.errors[0])}`.trim();
      return {
        value: undefined,
        errorMessage: validationError,
        successMessage: validationError ? undefined : input.translate("Package validation passed."),
      };
    });
  }

  async function installPlugin(pluginId: string, request: PluginActionRequest): Promise<void> {
    await mutatePlugin(pluginId, "install", request, async (cwd) => (await installManagedPlugin(cwd, pluginId)).plugin, (plugin) =>
      plugin.package?.packageHash
        ? `${input.translate("Plugin package installed.")} ${plugin.package.packageHash.slice(0, 12)}`
        : input.translate("Plugin package installed."));
  }

  async function uninstallPlugin(pluginId: string, request: PluginActionRequest): Promise<void> {
    await mutatePlugin(pluginId, "uninstall", request, async (cwd) => (await uninstallManagedPlugin(cwd, pluginId)).plugin, () =>
      input.translate("Plugin package uninstalled."));
  }

  async function refreshPluginPackage(pluginId: string, request: PluginActionRequest): Promise<void> {
    await mutatePlugin(pluginId, "refresh-package", request, async (cwd) => (await refreshManagedPluginPackage(cwd, pluginId)).plugin, () =>
      input.translate("Plugin package refreshed."));
  }

  async function previewPluginRuntime(pluginId: string, request: PluginActionRequest): Promise<void> {
    await runPluginOperation(pluginId, "runtime-preview", request, async (cwd) => {
      const response = await getManagedPluginRuntimePreview(cwd, pluginId);
      const previewError = response.preview.status === "injectable"
        ? undefined
        : response.preview.blockers.length
          ? `${input.translate("Runtime preview blocked.")} ${response.preview.blockers[0]}`
          : input.translate("Runtime preview blocked.");
      return {
        plugin: response.plugin,
        value: undefined,
        errorMessage: previewError,
        successMessage: previewError ? undefined : input.translate("Runtime preview ready."),
      };
    });
  }

  async function enablePlugin(pluginId: string, request: PluginActionRequest): Promise<void> {
    await mutatePlugin(pluginId, "enable", request, async (cwd) => (await enableManagedPlugin(cwd, pluginId)).plugin, () =>
      input.translate("Plugin enabled."));
  }

  async function disablePlugin(pluginId: string, request: PluginActionRequest): Promise<void> {
    await mutatePlugin(pluginId, "disable", request, async (cwd) => (await disableManagedPlugin(cwd, pluginId)).plugin, () =>
      input.translate("Plugin disabled."));
  }

  async function mutatePlugin(
    pluginId: string,
    action: PluginBusyAction,
    request: PluginActionRequest,
    mutation: (cwd: string) => Promise<ManagedPluginView>,
    successMessage?: (plugin: ManagedPluginView) => string,
  ): Promise<ManagedPluginView | undefined> {
    return runPluginOperation(pluginId, action, request, async (cwd) => {
      const plugin = await mutation(cwd);
      return {
        plugin,
        value: plugin,
        successMessage: successMessage?.(plugin),
      };
    });
  }

  async function runPluginOperation<T>(
    pluginId: string,
    action: PluginBusyAction,
    request: PluginActionRequest,
    operation: (cwd: string) => Promise<PluginOperationOutcome<T>>,
    cwdOverride?: string,
  ): Promise<T | undefined> {
    const pending = { pluginId, action, ...request } satisfies PluginPendingAction;
    const key = pluginActionKey(pending);
    latestActionRequestsRef.current.set(key, request.requestId);
    setPluginPendingActions((current) => upsertPendingAction(current, pending));
    clearPluginActionErrors({ pluginId, action, owner: request.owner });
    const workspaceCwd = (cwdOverride ?? input.cwd).trim();
    if (!workspaceCwd) {
      recordPluginActionError(pending, input.translate("Local workspace is not ready."));
      finishPluginAction(pending);
      return undefined;
    }
    try {
      const outcome = await operation(workspaceCwd);
      if (!isLatestPluginAction(pending)) return outcome.value;
      if (outcome.plugin) setPlugins((current) => upsertPlugin(current, outcome.plugin as ManagedPluginView));
      if (outcome.errorMessage) {
        recordPluginActionError(pending, outcome.errorMessage);
        input.notify({ ...pending, tone: "error", message: outcome.errorMessage });
        return undefined;
      }
      clearPluginActionErrors({ pluginId, action });
      if (outcome.successMessage) {
        input.notify({
          ...pending,
          pluginId: outcome.noticePluginId ?? pluginId,
          tone: "success",
          message: outcome.successMessage,
        });
      }
      return outcome.value;
    } catch (caught) {
      if (!isLatestPluginAction(pending)) return undefined;
      const message = caught instanceof Error ? caught.message : String(caught);
      recordPluginActionError(pending, message);
      input.notify({ ...pending, tone: "error", message });
      return undefined;
    } finally {
      finishPluginAction(pending);
    }
  }

  function isLatestPluginAction(action: PluginPendingAction): boolean {
    return latestActionRequestsRef.current.get(pluginActionKey(action)) === action.requestId;
  }

  function finishPluginAction(action: PluginPendingAction): void {
    if (!isLatestPluginAction(action)) return;
    latestActionRequestsRef.current.delete(pluginActionKey(action));
    setPluginPendingActions((current) => current.filter((candidate) => candidate.requestId !== action.requestId));
  }

  function recordPluginActionError(action: PluginPendingAction, message: string): void {
    if (!isLatestPluginAction(action)) return;
    const next = { ...action, message } satisfies PluginActionError;
    setPluginActionErrors((current) => [
      ...current.filter((candidate) => pluginActionKey(candidate) !== pluginActionKey(next)),
      next,
    ]);
  }

  function resetForCwd(): void {
    setPlugins([]);
    setPluginsLoading(false);
    setPluginPendingActions([]);
    setPluginActionErrors([]);
    setError(undefined);
    autoConnectInFlightRef.current = undefined;
    latestActionRequestsRef.current.clear();
    loadRequestIdRef.current += 1;
  }

  return {
    state: {
      plugins,
      pluginsLoading,
      pluginPendingActions,
      pluginActionErrors,
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
      clearPluginActionErrors,
      resetForCwd,
    },
    refresh: refreshPlugins,
    isLoading: pluginsLoading,
    error,
    clearError: () => setError(undefined),
  };
}

interface PluginOperationOutcome<T> {
  readonly value: T;
  readonly plugin?: ManagedPluginView;
  readonly errorMessage?: string;
  readonly successMessage?: string;
  readonly noticePluginId?: string;
}

function pluginActionKey(action: Pick<PluginPendingAction, "pluginId" | "action" | "owner">): string {
  return `${action.pluginId}:${action.action}:${action.owner}`;
}

function upsertPendingAction(
  current: readonly PluginPendingAction[],
  pending: PluginPendingAction,
): readonly PluginPendingAction[] {
  return [
    ...current.filter((candidate) => pluginActionKey(candidate) !== pluginActionKey(pending)),
    pending,
  ];
}

function matchesPluginActionFilter(action: PluginActionError, filter: PluginActionErrorFilter): boolean {
  return (filter.pluginId === undefined || action.pluginId === filter.pluginId)
    && (filter.action === undefined || action.action === filter.action)
    && (filter.owner === undefined || action.owner === filter.owner);
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
