import type { DesktopBrowserPreferences } from "../../../../desktop/shared/browser-capabilities.js";
import { Checkbox, Field, Select } from "../../shared/ui/index.js";
import { useI18n } from "../../i18n.js";

export function BrowserPreferencesPanel({ preferences, disabled, onChange }: {
  readonly preferences: DesktopBrowserPreferences;
  readonly disabled: boolean;
  readonly onChange: (value: DesktopBrowserPreferences) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  return <div className="browser-preferences">
    <Field label={t("Website links")}>
      <Select value={preferences.websiteLinks} disabled={disabled} onChange={event => onChange({ ...preferences, websiteLinks: event.currentTarget.value as DesktopBrowserPreferences["websiteLinks"] })}>
        <option value="in_app">{t("Ling Browser")}</option><option value="system">{t("System browser")}</option>
      </Select>
    </Field>
    <Field label={t("Local development links")}>
      <Select value={preferences.localhostLinks} disabled={disabled} onChange={event => onChange({ ...preferences, localhostLinks: event.currentTarget.value as DesktopBrowserPreferences["localhostLinks"] })}>
        <option value="in_app">{t("Ling Browser")}</option><option value="system">{t("System browser")}</option>
      </Select>
    </Field>
    <Checkbox label={t("Restore browser tabs after restart")} checked={preferences.restoreTabs} disabled={disabled}
      onChange={event => onChange({ ...preferences, restoreTabs: event.currentTarget.checked })} />
  </div>;
}
