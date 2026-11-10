import { Monitor, Palette } from "lucide-react";
import { useRef, useState } from "react";
import { useI18n, type Translate } from "../../i18n.js";
import { useTheme } from "../../theme.js";
import {
  DataRow,
  InlineFeedback,
  Switch,
  ThemePicker,
  type RegisteredTheme,
  type ThemePickerOption,
} from "../../shared/ui/index.js";

export function InterfaceThemeSettings(): React.JSX.Element {
  const { t } = useI18n();
  const {
    resolved,
    selection,
    setFixedTheme,
    setFollowSystem,
    storageWarning,
    themes,
  } = useTheme();
  const operationRef = useRef(0);
  const [applyingThemeId, setApplyingThemeId] = useState<string>();
  const [systemApplying, setSystemApplying] = useState(false);
  const options = themes
    .filter((theme) => theme.source === "built-in")
    .map((theme) => themePickerOption(theme, resolved.themeId, t));

  const selectTheme = (themeId: string): void => {
    const operation = operationRef.current + 1;
    operationRef.current = operation;
    setApplyingThemeId(themeId);
    void setFixedTheme(themeId)
      .catch(() => undefined)
      .finally(() => {
        if (operationRef.current === operation) setApplyingThemeId(undefined);
      });
  };

  const changeFollowSystem = (enabled: boolean): void => {
    const operation = operationRef.current + 1;
    operationRef.current = operation;
    setSystemApplying(true);
    void setFollowSystem(enabled)
      .catch(() => undefined)
      .finally(() => {
        if (operationRef.current === operation) setSystemApplying(false);
      });
  };

  const feedback = storageWarning === "save-failed"
    ? t("Theme preference could not be saved. The previous theme is still active.")
    : storageWarning === "load-failed"
      ? t("Installed themes could not be loaded. Ling is using a built-in fallback.")
      : storageWarning === "active-sync-failed"
        ? t("Desktop could not confirm the active theme. Destructive theme actions remain blocked.")
        : storageWarning === "cleanup-pending"
          ? t("Desktop recovered the theme library, but some temporary files still need cleanup.")
          : undefined;

  return (
    <section
      className="settings-interface-section settings-interface-appearance"
      aria-labelledby="settings-interface-appearance-title"
      data-ui2-interface-theme
    >
      <header className="settings-interface-section-header">
        <Palette aria-hidden="true" />
        <h2 id="settings-interface-appearance-title">{t("Appearance")}</h2>
      </header>

      <DataRow
        className="settings-interface-preference-row"
        identity={(
          <span className="settings-interface-preference-identity">
            <Monitor aria-hidden="true" />
            <span>
              <strong>{t("Follow system")}</strong>
            </span>
          </span>
        )}
        actions={(
          <Switch
            aria-label={t("Follow system")}
            checked={selection.mode === "system"}
            loading={systemApplying}
            onCheckedChange={changeFollowSystem}
          />
        )}
      />

      <div className="settings-interface-theme-heading">
        <h3>{t("Theme packs")}</h3>
        <span>
          {t("Current theme")}
          <strong>{resolved.manifest.name}</strong>
        </span>
      </div>
      <ThemePicker
        aria-label={t("Theme packs")}
        activeThemeId={resolved.themeId}
        applyingLabel={t("Applying theme")}
        applyingThemeId={applyingThemeId}
        options={options}
        selectedThemeId={selection.mode === "fixed" ? selection.themeId : undefined}
        onThemeSelect={selectTheme}
      />
      {feedback ? (
        <InlineFeedback aria-live="polite" tone="warning">
          {feedback}
        </InlineFeedback>
      ) : null}
    </section>
  );
}

function themePickerOption(
  theme: RegisteredTheme,
  activeThemeId: string,
  t: Translate,
): ThemePickerOption {
  const { manifest } = theme;
  const scheme = manifest.colorScheme === "dark" ? t("Dark") : t("Light");
  const source = t("Built-in");
  const disabledReason = theme.state === "ready"
    ? undefined
    : theme.validationIssue ?? t("Theme unavailable");
  const accessibleLabel = t(
    manifest.id === activeThemeId
      ? "Current theme option {name}, {scheme}, {source}"
      : "Theme option {name}, {scheme}, {source}",
    { name: manifest.name, scheme, source },
  );

  return {
    id: manifest.id,
    name: manifest.name,
    accessibleLabel,
    colorSchemeLabel: scheme,
    sourceLabel: undefined,
    disabled: theme.state !== "ready",
    disabledReason,
    scene: manifest.scene?.id,
    swatch: {
      accent: manifest.tokens.action.accent,
      app: manifest.tokens.background.app,
      danger: manifest.tokens.status.danger.foreground,
      info: manifest.tokens.status.info.foreground,
      panel: manifest.tokens.background.panel,
      success: manifest.tokens.status.success.foreground,
      text: manifest.tokens.text.default,
      warning: manifest.tokens.status.warning.foreground,
    },
  };
}
