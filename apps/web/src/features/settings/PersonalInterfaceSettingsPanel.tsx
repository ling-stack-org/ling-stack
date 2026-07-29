import { Languages } from "lucide-react";
import { useI18n, type Locale } from "../../i18n.js";
import type { ResponseLanguagePreference, UserProfile } from "../../types.js";
import { ProfilePage } from "../profile/ProfilePage.js";

import { Field, Select } from "../../shared/ui/index.js";
import { DesktopComputerUsePreference } from "./DesktopComputerUsePreference.js";
import { InterfaceThemeSettings } from "./InterfaceThemeSettings.js";

export function PersonalSettingsPanel({
  cwd,
  onProfileChange,
}: {
  readonly cwd: string;
  readonly onProfileChange?: (profile: UserProfile) => void;
}): JSX.Element {
  return <ProfilePage cwd={cwd} onProfileChange={onProfileChange} variant="settings" />;
}

export function InterfacePreferencesSettingsPanel({
  workspaceResponseLanguage,
  onWorkspaceResponseLanguageChange,
}: {
  readonly workspaceResponseLanguage: ResponseLanguagePreference;
  readonly onWorkspaceResponseLanguageChange: (language: ResponseLanguagePreference) => void;
}): JSX.Element {
  const { locale, setLocale, t } = useI18n();

  return (
    <div
      className="interface-settings-panel"
      data-ui2-interface-preferences
    >
      <InterfaceThemeSettings />
      <section
        className="settings-interface-section settings-interface-language"
        aria-labelledby="settings-interface-language-title"
      >
        <header className="settings-interface-section-header">
          <Languages aria-hidden="true" />
          <h2 id="settings-interface-language-title">{t("Language")}</h2>
        </header>
        <div className="settings-interface-language-grid">
          <Field label={t("Product language")}>
            <Select
              aria-label={t("Product language")}
              value={locale}
              onChange={(event) => setLocale(event.target.value as Locale)}
            >
              <option value="zh-CN">{t("Chinese")}</option>
              <option value="en-US">{t("English")}</option>
            </Select>
          </Field>
          <Field label={t("AI response language")}>
            <Select
              value={workspaceResponseLanguage}
              onChange={(event) => onWorkspaceResponseLanguageChange(event.target.value as ResponseLanguagePreference)}
              aria-label={t("AI response language")}
            >
              <option value="follow_user">{t("Follow user message")}</option>
              <option value="zh-CN">{t("Chinese")}</option>
              <option value="en-US">{t("English")}</option>
            </Select>
          </Field>
        </div>
      </section>
      <DesktopComputerUsePreference />
    </div>
  );
}
