import { Monitor, Palette, Sparkles, Upload } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { useI18n, type Translate } from "../../i18n.js";
import { useTheme } from "../../theme.js";
import {
  DataRow,
  Button,
  InlineFeedback,
  Switch,
  ThemePicker,
  type RegisteredTheme,
  type ThemePickerOption,
} from "../../shared/ui/index.js";
import { ThemeDeleteDialog } from "./theme-packages/ThemeDeleteDialog.js";
import { ThemeImportDialog } from "./theme-packages/ThemeImportDialog.js";
import { ThemePackageActions } from "./theme-packages/ThemePackageActions.js";
import { ThemePackageRepairList } from "./theme-packages/ThemePackageRepairList.js";
import { ThemePreviewDialog } from "./theme-packages/ThemePreviewDialog.js";
import { useThemePackageController } from "./theme-packages/useThemePackageController.js";

export function InterfaceThemeSettings({ onCreateTheme }: { readonly onCreateTheme: () => void }): JSX.Element {
  const { t } = useI18n();
  const {
    resolved,
    repositoryReady,
    generatedThemePublishingSupported,
    selection,
    setFixedTheme,
    setFollowSystem,
    storageWarning,
    themePackageRepairs,
    themes,
  } = useTheme();
  const packageController = useThemePackageController();
  const importButtonRef = useRef<HTMLButtonElement | null>(null);
  const operationRef = useRef(0);
  const [applyingThemeId, setApplyingThemeId] = useState<string>();
  const [systemApplying, setSystemApplying] = useState(false);
  const options = themes.map((theme) => themePickerOption(
    theme,
    resolved.themeId,
    t,
    <ThemePackageActions
      busy={
        !repositoryReady
        || (packageController.deleteState.busy && packageController.deleteState.target?.id === theme.manifest.id)
        || (packageController.importState.phase === "publishing"
          && packageController.importState.candidate?.manifest.id === theme.manifest.id)
      }
      theme={theme}
      onDelete={packageController.openDelete}
      onPreview={(target, trigger) => void packageController.openInstalledPreview(target, trigger)}
      onReimport={packageController.openReimport}
    />,
  ));

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
      <ThemePackageRepairList
        items={themePackageRepairs}
        onDelete={packageController.openRepairDelete}
        onReimport={packageController.openRepairReimport}
      />
      <div className="settings-theme-package-toolbar">
        {generatedThemePublishingSupported ? (
          <Button
            disabled={!repositoryReady}
            leadingIcon={<Sparkles aria-hidden="true" />}
            size="sm"
            variant="secondary"
            onClick={onCreateTheme}
          >
            {t("Create theme")}
          </Button>
        ) : null}
        <Button
          ref={importButtonRef}
          disabled={!repositoryReady}
          leadingIcon={<Upload aria-hidden="true" />}
          size="sm"
          variant="secondary"
          onClick={() => packageController.openImport(importButtonRef.current)}
        >
          {t("Import theme")}
        </Button>
      </div>
      {feedback ? (
        <InlineFeedback aria-live="polite" tone="warning">
          {feedback}
        </InlineFeedback>
      ) : null}
      <ThemeImportDialog
        returnFocusRef={packageController.importReturnFocusRef}
        state={packageController.importState}
        onClose={packageController.closeImport}
        onLoadFile={(file) => void packageController.loadFile(file)}
        onPreview={packageController.openCandidatePreview}
        onPublish={() => void packageController.publish()}
        onUseAfterImportChange={packageController.setUseAfterImport}
      />
      <ThemePreviewDialog
        returnFocusRef={packageController.previewReturnFocusRef}
        state={packageController.previewState}
        onClose={packageController.closePreview}
      />
      <ThemeDeleteDialog
        fallbackFocusRef={importButtonRef}
        returnFocusRef={packageController.deleteReturnFocusRef}
        state={packageController.deleteState}
        onClose={packageController.closeDelete}
        onConfirm={() => void packageController.confirmDelete()}
      />
    </section>
  );
}

function themePickerOption(
  theme: RegisteredTheme,
  activeThemeId: string,
  t: Translate,
  actions?: ReactNode,
): ThemePickerOption {
  const { manifest } = theme;
  const scheme = manifest.colorScheme === "dark" ? t("Dark") : t("Light");
  const source = theme.source === "built-in"
    ? t("Built-in")
    : theme.source === "local-generated"
      ? t("Generated theme")
      : t("Local theme");
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
    ...(actions ? { actions } : {}),
    id: manifest.id,
    name: manifest.name,
    accessibleLabel,
    colorSchemeLabel: scheme,
    sourceLabel: theme.source === "built-in" ? undefined : source,
    disabled: theme.state !== "ready",
    disabledReason,
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
