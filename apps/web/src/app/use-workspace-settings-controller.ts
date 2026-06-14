import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { clearSavedLocale, readSavedLocale, type Locale } from "../i18n.js";
import { clearSavedThemePreference, readSavedThemePreference, type ThemePreference } from "../theme.js";
import { getEffectiveConfig } from "../api/config.js";
import { updateWorkspaceSettings } from "../api/workspace-settings.js";
import type {
  ChannelCreateFormState,
  EffectiveConfigResponse,
  RunFormState,
  UpdateWorkspaceSettingsRequest,
  WorkspaceSettings,
} from "../types.js";
import { clearSavedWorkspaceCwd, readSavedWorkspaceCwd } from "../lib/local-storage.js";

export interface WorkspaceSettingsController {
  readonly workspaceSettings: WorkspaceSettings | undefined;
  readonly effectiveConfig: EffectiveConfigResponse | undefined;
  readonly updateWorkspaceCwd: (cwd: string) => void;
  readonly patchWorkspaceSettings: (patch: UpdateWorkspaceSettingsRequest) => void;
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
  readonly setErrorMessage: (message: string) => void;
}): WorkspaceSettingsController {
  const [workspaceSettings, setWorkspaceSettings] = useState<WorkspaceSettings | undefined>();
  const [effectiveConfig, setEffectiveConfig] = useState<EffectiveConfigResponse | undefined>();
  const workspaceSettingsLoadedCwdRef = useRef("");
  const interfaceSettingsSyncRef = useRef<{ readonly cwd: string; readonly theme: ThemePreference; readonly locale: Locale } | undefined>();
  const currentLocaleRef = useRef(input.locale);
  const workspaceCwd = input.form.cwd.trim();

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

  function patchWorkspaceSettings(patch: UpdateWorkspaceSettingsRequest): void {
    if (!workspaceCwd) {
      return;
    }
    void updateWorkspaceSettings(workspaceCwd, patch)
      .then((response) => {
        setWorkspaceSettings(response.settings);
        setEffectiveConfig((current) =>
          current && current.cwd === workspaceCwd
            ? { ...current, layers: { ...current.layers, workspaceSettings: response.settings } }
            : current,
        );
      })
      .catch((error: unknown) => input.setErrorMessage(error instanceof Error ? error.message : String(error)));
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
    if (input.daemonHealthy !== true || !workspaceCwd || workspaceSettingsLoadedCwdRef.current !== workspaceCwd) {
      return;
    }
    const synced = interfaceSettingsSyncRef.current;
    if (synced?.cwd !== workspaceCwd || (synced.theme === input.themePreference && synced.locale === input.locale)) {
      return;
    }
    const timeout = globalThis.setTimeout(() => {
      void updateWorkspaceSettings(workspaceCwd, { theme: input.themePreference, locale: input.locale })
        .then((response) => {
          setWorkspaceSettings(response.settings);
          setEffectiveConfig((current) =>
            current && current.cwd === workspaceCwd
              ? { ...current, layers: { ...current.layers, workspaceSettings: response.settings } }
              : current,
          );
          interfaceSettingsSyncRef.current = { cwd: workspaceCwd, theme: input.themePreference, locale: input.locale };
          clearSavedThemePreference();
          clearSavedLocale();
        })
        .catch((error: unknown) => input.setErrorMessage(error instanceof Error ? error.message : String(error)));
    }, 250);
    return () => globalThis.clearTimeout(timeout);
  }, [input.daemonHealthy, input.locale, input.themePreference, workspaceCwd]);

  return {
    workspaceSettings,
    effectiveConfig,
    updateWorkspaceCwd,
    patchWorkspaceSettings,
  };
}

function isWorkspaceSettingsLocale(value: string | undefined): value is Locale {
  return value === "en-US" || value === "zh-CN";
}
