import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { legacyPermissionFromAuthorizationAndAccess } from "@ling-stack/core/session-permissions";
import { clearSavedLocale, readSavedLocale, type Locale } from "../i18n.js";
import { clearSavedThemePreference, readSavedThemePreference, type ThemePreference } from "../theme.js";
import { getEffectiveConfig } from "../api/config.js";
import { updateWorkspaceSettings } from "../api/workspace-settings.js";
import type {
  ChannelCreateFormState,
  ErrorPresentationOptions,
  EffectiveConfigResponse,
  RunFormState,
  UpdateWorkspaceSettingsRequest,
  WorkspaceSettings,
} from "../types.js";
import { resolveAuthorizationMode, resolveWorkspaceAccessMode } from "../lib/conversation-authorization.js";
import { clearSavedWorkspaceCwd, readSavedWorkspaceCwd } from "../lib/local-storage.js";
import {
  domainErrorMessage,
  type FocusedDomainError,
  type FocusedErrorRequest,
  useFocusedDomainErrorOwner,
} from "./use-focused-domain-error-owner.js";

export type WorkspaceSettingsErrorAction = `patch:${string}` | "sync-interface";
export type WorkspaceSettingsError = FocusedDomainError<"workspace-settings", WorkspaceSettingsErrorAction>;

export interface WorkspaceSettingsController {
  readonly workspaceSettings: WorkspaceSettings | undefined;
  readonly effectiveConfig: EffectiveConfigResponse | undefined;
  readonly errors: readonly WorkspaceSettingsError[];
  readonly error: WorkspaceSettingsError | undefined;
  readonly clearError: () => void;
  readonly updateWorkspaceCwd: (cwd: string) => void;
  readonly patchWorkspaceSettings: (
    patch: UpdateWorkspaceSettingsRequest,
    options?: ErrorPresentationOptions,
  ) => Promise<WorkspaceSettings | undefined>;
}

export function useWorkspaceSettingsController(input: {
  readonly daemonHealthy: boolean | undefined;
  readonly form: RunFormState;
  readonly setForm: Dispatch<SetStateAction<RunFormState>>;
  readonly locale: Locale;
  readonly setLocale: (locale: Locale) => void;
  readonly themePreference: ThemePreference;
  readonly setThemePreference: (preference: ThemePreference) => void;
  readonly setChannelForm: Dispatch<SetStateAction<ChannelCreateFormState>>;
  readonly resetForCwd: (cwd: string) => void;
}): WorkspaceSettingsController {
  const [workspaceSettings, setWorkspaceSettings] = useState<WorkspaceSettings | undefined>();
  const [effectiveConfig, setEffectiveConfig] = useState<EffectiveConfigResponse | undefined>();
  const workspaceSettingsLoadedCwdRef = useRef("");
  const interfaceSettingsSyncRef = useRef<{ readonly cwd: string; readonly theme: ThemePreference; readonly locale: Locale } | undefined>();
  const currentLocaleRef = useRef(input.locale);
  const workspaceCwd = input.form.cwd.trim();
  const errorOwner = useFocusedDomainErrorOwner<"workspace-settings", WorkspaceSettingsErrorAction>(
    workspaceCwd || "workspace:unavailable",
  );
  const latestMutationRef = useRef<FocusedErrorRequest<"workspace-settings", WorkspaceSettingsErrorAction>>();

  useEffect(() => {
    currentLocaleRef.current = input.locale;
  }, [input.locale]);

  function updateWorkspaceCwd(cwd: string): void {
    const previousCwd = input.form.cwd;
    if (cwd.trim()) {
      void updateWorkspaceSettings(cwd.trim(), { workspaceCwd: cwd.trim() })
        .then((response) => {
          setWorkspaceSettings(response.settings);
          clearSavedWorkspaceCwd();
        })
        .catch(() => undefined);
    }
    input.setForm({ ...input.form, cwd });
    input.resetForCwd(cwd);
    input.setChannelForm((current) => ({
      ...current,
      boundPath: current.boundPath === previousCwd || !current.boundPath ? cwd : current.boundPath,
    }));
  }

  async function patchWorkspaceSettings(
    patch: UpdateWorkspaceSettingsRequest,
    options?: ErrorPresentationOptions,
  ): Promise<WorkspaceSettings | undefined> {
    if (!workspaceCwd) {
      return undefined;
    }
    const action = workspaceSettingsPatchAction(patch);
    const request = errorOwner.begin("workspace-settings", workspaceCwd, action);
    latestMutationRef.current = request;
    if (options?.errorOwner !== "caller") errorOwner.clear(request);
    try {
      const response = await updateWorkspaceSettings(workspaceCwd, patch);
      if (!isCurrentMutation(request)) return response.settings;
      setWorkspaceSettings(response.settings);
      if ("defaultProviderPresetId" in patch) {
        input.setForm((current) => ({
          ...current,
          providerPresetId: response.settings.defaultProviderPresetId ?? "",
        }));
      }
      if (
        "defaultAuthorizationMode" in patch ||
        "defaultWorkspaceAccessMode" in patch ||
        "defaultPermissionMode" in patch ||
        "defaultPermissionPreset" in patch
      ) {
        input.setForm((current) => syncRunFormPermissionDefaults(current, response.settings));
      }
      setEffectiveConfig((current) =>
        current && current.cwd === workspaceCwd
          ? { ...current, layers: { ...current.layers, workspaceSettings: response.settings } }
          : current,
      );
      if (options?.errorOwner !== "caller") errorOwner.clear(request);
      return response.settings;
    } catch (error: unknown) {
      if (options?.errorOwner === "caller") {
        throw error;
      }
      if (isCurrentMutation(request)) {
        errorOwner.report(request, { scope: "mutation", message: domainErrorMessage(error) });
      }
      return undefined;
    }
  }

  function isCurrentMutation(
    request: FocusedErrorRequest<"workspace-settings", WorkspaceSettingsErrorAction>,
  ): boolean {
    return errorOwner.isCurrent(request)
      && latestMutationRef.current?.requestId === request.requestId
      && latestMutationRef.current.identity === request.identity;
  }

  useEffect(() => {
    if (input.daemonHealthy !== true || !workspaceCwd) {
      setWorkspaceSettings(undefined);
      setEffectiveConfig(undefined);
      workspaceSettingsLoadedCwdRef.current = "";
      interfaceSettingsSyncRef.current = undefined;
      return;
    }
    let cancelled = false;
    workspaceSettingsLoadedCwdRef.current = workspaceCwd;
    void getEffectiveConfig(workspaceCwd)
      .then((response) => {
        if (cancelled || workspaceSettingsLoadedCwdRef.current !== workspaceCwd) {
          return;
        }
        const workspaceLayer = response.layers.workspaceSettings;
        const legacyTheme = readSavedThemePreference();
        const legacyLocale = readSavedLocale();
        const nextTheme =
          !workspaceLayer.theme && response.values.theme.source === "built_in" && legacyTheme
            ? legacyTheme
            : response.values.theme.value;
        const nextLocale =
          !workspaceLayer.locale && response.values.locale.source === "built_in" && legacyLocale
            ? legacyLocale
            : isWorkspaceSettingsLocale(response.values.locale.value)
              ? response.values.locale.value
              : currentLocaleRef.current;
        setWorkspaceSettings(workspaceLayer);
        input.setForm((current) => syncRunFormPermissionDefaults({
          ...current,
          providerPresetId: workspaceLayer.defaultProviderPresetId ?? "",
        }, workspaceLayer));
        setEffectiveConfig(response);
        input.setThemePreference(nextTheme);
        input.setLocale(nextLocale);
        interfaceSettingsSyncRef.current = { cwd: workspaceCwd, theme: nextTheme, locale: nextLocale };

        const migrationPatch: {
          workspaceCwd?: string;
          theme?: ThemePreference;
          locale?: Locale;
        } = {};
        if (workspaceLayer.workspaceCwd !== workspaceCwd) {
          migrationPatch.workspaceCwd = workspaceCwd;
        }
        if (!workspaceLayer.theme && response.values.theme.source === "built_in" && legacyTheme && legacyTheme !== response.values.theme.value) {
          migrationPatch.theme = legacyTheme;
        }
        if (!workspaceLayer.locale && response.values.locale.source === "built_in" && legacyLocale && legacyLocale !== response.values.locale.value) {
          migrationPatch.locale = legacyLocale;
        }
        const shouldClearLegacyTheme = legacyTheme !== undefined && (migrationPatch.theme !== undefined || response.values.theme.source !== "built_in" || legacyTheme === response.values.theme.value);
        const shouldClearLegacyLocale = legacyLocale !== undefined && (migrationPatch.locale !== undefined || response.values.locale.source !== "built_in" || legacyLocale === response.values.locale.value);
        const shouldClearLegacyCwd = readSavedWorkspaceCwd() === workspaceCwd && (migrationPatch.workspaceCwd !== undefined || workspaceLayer.workspaceCwd === workspaceCwd);

        if (Object.keys(migrationPatch).length > 0) {
          void updateWorkspaceSettings(workspaceCwd, migrationPatch)
            .then((updated) => {
              if (!cancelled && workspaceSettingsLoadedCwdRef.current === workspaceCwd) {
                setWorkspaceSettings(updated.settings);
                setEffectiveConfig((current) =>
                  current && current.cwd === workspaceCwd
                    ? { ...current, layers: { ...current.layers, workspaceSettings: updated.settings } }
                    : current,
                );
                if (shouldClearLegacyTheme) {
                  clearSavedThemePreference();
                }
                if (shouldClearLegacyLocale) {
                  clearSavedLocale();
                }
                if (shouldClearLegacyCwd) {
                  clearSavedWorkspaceCwd();
                }
              }
            })
            .catch(() => undefined);
        } else {
          if (shouldClearLegacyTheme) {
            clearSavedThemePreference();
          }
          if (shouldClearLegacyLocale) {
            clearSavedLocale();
          }
          if (shouldClearLegacyCwd) {
            clearSavedWorkspaceCwd();
          }
        }
      })
      .catch(() => {
        if (!cancelled) {
          setWorkspaceSettings(undefined);
          setEffectiveConfig(undefined);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [input.daemonHealthy, input.setLocale, input.setThemePreference, workspaceCwd]);

  useEffect(() => {
    if (input.daemonHealthy !== true || !workspaceCwd) {
      return undefined;
    }
    let cancelled = false;
    const refreshInterfaceSettings = (): void => {
      if (workspaceSettingsLoadedCwdRef.current !== workspaceCwd) {
        return;
      }
      void getEffectiveConfig(workspaceCwd)
        .then((response) => {
          if (cancelled || workspaceSettingsLoadedCwdRef.current !== workspaceCwd) {
            return;
          }
          const workspaceLayer = response.layers.workspaceSettings;
          const nextTheme = response.values.theme.value;
          const nextLocale = isWorkspaceSettingsLocale(response.values.locale.value)
            ? response.values.locale.value
            : currentLocaleRef.current;
          setWorkspaceSettings(workspaceLayer);
          setEffectiveConfig(response);
          input.setForm((current) => syncRunFormPermissionDefaults(current, workspaceLayer));
          input.setThemePreference(nextTheme);
          input.setLocale(nextLocale);
          interfaceSettingsSyncRef.current = { cwd: workspaceCwd, theme: nextTheme, locale: nextLocale };
          clearSavedThemePreference();
          clearSavedLocale();
        })
        .catch(() => undefined);
    };
    const handleFocus = (): void => refreshInterfaceSettings();
    const handleVisibilityChange = (): void => {
      if (globalThis.document?.visibilityState === "visible") {
        refreshInterfaceSettings();
      }
    };
    globalThis.window?.addEventListener("focus", handleFocus);
    globalThis.document?.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      cancelled = true;
      globalThis.window?.removeEventListener("focus", handleFocus);
      globalThis.document?.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [input.daemonHealthy, input.setLocale, input.setThemePreference, workspaceCwd]);

  useEffect(() => {
    if (input.daemonHealthy !== true || !workspaceCwd || workspaceSettingsLoadedCwdRef.current !== workspaceCwd) {
      return;
    }
    const synced = interfaceSettingsSyncRef.current;
    if (synced?.cwd !== workspaceCwd || (synced.theme === input.themePreference && synced.locale === input.locale)) {
      return;
    }
    const timeout = globalThis.setTimeout(() => {
      const request = errorOwner.begin("workspace-settings", workspaceCwd, "sync-interface");
      latestMutationRef.current = request;
      errorOwner.clear(request);
      void updateWorkspaceSettings(workspaceCwd, { theme: input.themePreference, locale: input.locale })
        .then((response) => {
          if (!isCurrentMutation(request)) return;
          setWorkspaceSettings(response.settings);
          setEffectiveConfig((current) =>
            current && current.cwd === workspaceCwd
              ? { ...current, layers: { ...current.layers, workspaceSettings: response.settings } }
              : current,
          );
          interfaceSettingsSyncRef.current = { cwd: workspaceCwd, theme: input.themePreference, locale: input.locale };
          clearSavedThemePreference();
          clearSavedLocale();
          errorOwner.clear(request);
        })
        .catch((error: unknown) => {
          if (isCurrentMutation(request)) {
            errorOwner.report(request, { scope: "mutation", message: domainErrorMessage(error) });
          }
        });
    }, 250);
    return () => globalThis.clearTimeout(timeout);
  }, [input.daemonHealthy, input.locale, input.themePreference, workspaceCwd]);

  return {
    workspaceSettings,
    effectiveConfig,
    errors: errorOwner.errors() as readonly WorkspaceSettingsError[],
    error: errorOwner.latest() as WorkspaceSettingsError | undefined,
    clearError: errorOwner.clearAll,
    updateWorkspaceCwd,
    patchWorkspaceSettings,
  };
}

function workspaceSettingsPatchAction(patch: UpdateWorkspaceSettingsRequest): WorkspaceSettingsErrorAction {
  const fields = Object.keys(patch).sort().join("+") || "empty";
  return `patch:${fields}`;
}

function syncRunFormPermissionDefaults(current: RunFormState, settings: WorkspaceSettings): RunFormState {
  const authorizationMode = resolveAuthorizationMode(
    settings.defaultAuthorizationMode,
    settings.defaultPermissionMode,
    settings.defaultPermissionPreset,
  );
  const workspaceAccessMode = resolveWorkspaceAccessMode(
    settings.defaultWorkspaceAccessMode,
    settings.defaultPermissionMode,
    settings.defaultPermissionPreset,
  );
  const legacy = legacyPermissionFromAuthorizationAndAccess(authorizationMode, workspaceAccessMode);
  return {
    ...current,
    authorizationMode,
    workspaceAccessMode,
    permissionMode: legacy.permissionMode,
    permissionPreset: legacy.permissionPreset,
  };
}

function isWorkspaceSettingsLocale(value: string | undefined): value is Locale {
  return value === "en-US" || value === "zh-CN";
}
