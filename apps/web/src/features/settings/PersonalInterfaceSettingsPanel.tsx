import { Languages } from "lucide-react";
import { useI18n, type Locale } from "../../i18n.js";
import { SupportedLocaleOptions } from "../../i18n/SupportedLocaleOptions.js";
import type { ResponseLanguagePreference, UserProfile } from "../../types.js";
import { ProfilePage } from "../profile/ProfilePage.js";

import { Field, Select } from "../../shared/ui/index.js";
import { DesktopComputerUsePreference } from "./DesktopComputerUsePreference.js";
import { InterfaceThemeSettings } from "./InterfaceThemeSettings.js";
import { InterfaceBackgroundSettings } from "./InterfaceBackgroundSettings.js";

export function PersonalSettingsPanel({
  cwd,
  onProfileChange,
}: {
  readonly cwd: string;
  readonly onProfileChange?: (profile: UserProfile) => void;
}): React.JSX.Element {
  return <ProfilePage cwd={cwd} onProfileChange={onProfileChange} variant="settings" />;
}

export function InterfacePreferencesSettingsPanel({
  workspaceResponseLanguage,
  onProductLanguageChange,
  onWorkspaceResponseLanguageChange,
}: {
  readonly workspaceResponseLanguage: ResponseLanguagePreference;
  readonly onProductLanguageChange: (locale: Locale) => Promise<boolean>;
  readonly onWorkspaceResponseLanguageChange: (language: ResponseLanguagePreference) => void;
}): React.JSX.Element {
  const { locale, localeLoadError, pendingLocale, t } = useI18n();

  return (
    <div
      className="interface-settings-panel"
      data-ui2-interface-preferences
    >
      <InterfaceThemeSettings />
      <InterfaceBackgroundSettings />
      <DesktopComputerUsePreference />
      <section
        className="settings-interface-section settings-interface-language"
        aria-labelledby="settings-interface-language-title"
      >
        <header className="settings-interface-section-header">
          <Languages aria-hidden="true" />
          <h2 id="settings-interface-language-title">{t("Language")}</h2>
        </header>
        <div className="settings-interface-language-grid">
          <Field
            label={t("Product language")}
            error={localeLoadError ? <span role="alert">{t("settings.language.load_failed")}</span> : undefined}
          >
            <Select
              aria-label={t("Product language")}
              data-product-language
              value={pendingLocale ?? locale}
              disabled={pendingLocale !== undefined}
              aria-busy={pendingLocale !== undefined}
              onChange={(event) => void onProductLanguageChange(event.target.value as Locale)}
            >
              <SupportedLocaleOptions />
            </Select>
          </Field>
          <Field label={t("AI response language")}>
            <Select
              value={workspaceResponseLanguage}
              data-response-language
              onChange={(event) => onWorkspaceResponseLanguageChange(event.target.value as ResponseLanguagePreference)}
              aria-label={t("AI response language")}
            >
              <option value="follow_user">{t("Follow user message")}</option>
              <SupportedLocaleOptions />
            </Select>
          </Field>
        </div>
      </section>
    </div>
  );
}
