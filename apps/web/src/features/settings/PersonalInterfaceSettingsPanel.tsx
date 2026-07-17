import { useEffect, useRef, useState } from "react";
import { Bot, Languages, MonitorUp, Palette } from "lucide-react";
import { LanguageSwitcher, useI18n, type Translate } from "../../i18n.js";
import { ThemeSwitcher } from "../../theme.js";
import type { EffectiveConfigResponse, ResponseLanguagePreference, UserProfile } from "../../types.js";
import { ProfilePage } from "../profile/ProfilePage.js";

import { SelectControl } from "../../shared/components/SelectControl.js";

export function PersonalSettingsPanel({
  cwd,
  onProfileChange,
}: {
  readonly cwd: string;
  readonly onProfileChange?: (profile: UserProfile) => void;
}): JSX.Element {
  return (
    <div className="settings-section-stack">
      <ProfilePage cwd={cwd} onProfileChange={onProfileChange} variant="settings" />
    </div>
  );
}

export function InterfacePreferencesSettingsPanel({
  effectiveConfig,
  workspaceResponseLanguage,
  onWorkspaceResponseLanguageChange,
}: {
  readonly effectiveConfig: EffectiveConfigResponse | undefined;
  readonly workspaceResponseLanguage: ResponseLanguagePreference;
  readonly onWorkspaceResponseLanguageChange: (language: ResponseLanguagePreference) => void;
}): JSX.Element {
  const { t } = useI18n();

  return (
    <div className="settings-section-stack">
      <section className="panel settings-panel interface-settings-panel" aria-labelledby="interface-settings-title">
        <div className="panel-title">
          <Palette size={18} />
          <h2 id="interface-settings-title">{t("Interface preferences")}</h2>
        </div>
        <div className="interface-preference-grid">
          <div className="interface-preference-row">
            <span>
              <Palette size={16} />
              <strong>{t("Theme")}</strong>
              <small>{configSourceLabel(effectiveConfig?.values.theme.source, t)}</small>
            </span>
            <ThemeSwitcher />
          </div>
          <div className="interface-preference-row">
            <span>
              <Languages size={16} />
              <strong>{t("Language")}</strong>
              <small>{configSourceLabel(effectiveConfig?.values.locale.source, t)}</small>
            </span>
            <LanguageSwitcher />
          </div>
          <div className="interface-preference-row">
            <span>
              <Bot size={16} />
              <strong>{t("AI response language")}</strong>
              <small>{configSourceLabel(effectiveConfig?.values.responseLanguage.source, t)}</small>
            </span>
            <SelectControl
              value={workspaceResponseLanguage}
              onChange={(event) => onWorkspaceResponseLanguageChange(event.target.value as ResponseLanguagePreference)}
              aria-label={t("AI response language")}
            >
              <option value="follow_user">{t("Follow user message")}</option>
              <option value="zh-CN">{t("Chinese")}</option>
              <option value="en-US">{t("English")}</option>
            </SelectControl>
          </div>
          <DesktopComputerUsePreference />
        </div>
      </section>
    </div>
  );
}

/**
 * Exposes the Desktop-only presentation preference without leaking an Electron
 * bridge into the browser build. The browser surface simply omits this row.
 */
function DesktopComputerUsePreference(): JSX.Element | null {
  const { t } = useI18n();
  const desktopComputerUse = typeof window === "undefined" ? undefined : window.lingDesktop?.computerUse;
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(Boolean(desktopComputerUse));
  const [error, setError] = useState(false);
  const [notPersisted, setNotPersisted] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    if (!desktopComputerUse) {
      setLoading(false);
      return () => {
        mountedRef.current = false;
      };
    }
    setLoading(true);
    void desktopComputerUse.getPreferences().then((preferences) => {
      if (mountedRef.current) {
        setEnabled(preferences.previewAutoShow);
        setError(false);
        setNotPersisted(false);
      }
    }).catch(() => {
      if (mountedRef.current) {
        setError(true);
      }
    }).finally(() => {
      if (mountedRef.current) {
        setLoading(false);
      }
    });
    return () => {
      mountedRef.current = false;
    };
  }, [desktopComputerUse]);

  if (!desktopComputerUse) {
    return null;
  }

  const update = (next: boolean): void => {
    const previous = enabled;
    setEnabled(next);
    setError(false);
    setNotPersisted(false);
    setLoading(true);
    void desktopComputerUse.setAutoShow(next).then((result) => {
      if (!mountedRef.current) {
        return;
      }
      if (!result.accepted) {
        setEnabled(previous);
        setError(true);
        return;
      }
      setNotPersisted(result.reason === "desktop_preferences_not_persisted");
    }).catch(() => {
      if (mountedRef.current) {
        setEnabled(previous);
        setError(true);
      }
    }).finally(() => {
      if (mountedRef.current) {
        setLoading(false);
      }
    });
  };

  return (
    <div className="interface-preference-row desktop-computer-use-preference">
      <span>
        <MonitorUp size={16} />
        <strong>{t("Computer Use picture-in-picture")}</strong>
        <small>{t("Automatically show the approved Computer Use preview on Desktop")}</small>
      </span>
      <label className="interface-preference-toggle">
        <input
          type="checkbox"
          checked={enabled}
          disabled={loading}
          onChange={(event) => update(event.target.checked)}
          aria-label={t("Automatically show Computer Use picture-in-picture")}
        />
        <span>{enabled ? t("On") : t("Off")}</span>
      </label>
      {error ? <small className="interface-preference-error" role="alert">{t("Unable to save Desktop preview preference")}</small> : null}
      {notPersisted ? (
        <small className="interface-preference-error" role="status" aria-live="polite">
          {t("Changed for this session, but not saved. It may revert after restart.")}
        </small>
      ) : null}
    </div>
  );
}

function configSourceLabel(source: EffectiveConfigResponse["values"]["theme"]["source"] | undefined, t: Translate): string {
  if (source === "workspace") {
    return t("Workspace");
  }
  if (source === "user") {
    return t("User default");
  }
  if (source === "built_in") {
    return t("Built-in");
  }
  return t("Loading");
}
