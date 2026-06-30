import { Bot, Languages, Palette, UserRound } from "lucide-react";
import { LanguageSwitcher, useI18n, type Translate } from "../../i18n.js";
import { ThemeSwitcher } from "../../theme.js";
import type { EffectiveConfigResponse, ResponseLanguagePreference, UserProfile } from "../../types.js";
import { ProfilePage } from "../profile/ProfilePage.js";

export function PersonalInterfaceSettingsPanel({
  cwd,
  effectiveConfig,
  workspaceResponseLanguage,
  onWorkspaceResponseLanguageChange,
  onProfileChange,
}: {
  readonly cwd: string;
  readonly effectiveConfig: EffectiveConfigResponse | undefined;
  readonly workspaceResponseLanguage: ResponseLanguagePreference;
  readonly onWorkspaceResponseLanguageChange: (language: ResponseLanguagePreference) => void;
  readonly onProfileChange?: (profile: UserProfile) => void;
}): JSX.Element {
  const { t } = useI18n();

  return (
    <div className="settings-section-stack">
      <section className="panel settings-panel account-profile-settings-panel" aria-labelledby="account-profile-settings-title">
        <div className="panel-title">
          <UserRound size={18} />
          <h2 id="account-profile-settings-title">{t("Account and profile")}</h2>
        </div>
        <ProfilePage cwd={cwd} onProfileChange={onProfileChange} />
      </section>

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
            <select
              value={workspaceResponseLanguage}
              onChange={(event) => onWorkspaceResponseLanguageChange(event.target.value as ResponseLanguagePreference)}
              aria-label={t("AI response language")}
            >
              <option value="follow_user">{t("Follow user message")}</option>
              <option value="zh-CN">{t("Chinese")}</option>
              <option value="en-US">{t("English")}</option>
            </select>
          </div>
        </div>
      </section>
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
