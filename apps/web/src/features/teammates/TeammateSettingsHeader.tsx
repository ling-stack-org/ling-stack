import { ArrowLeft, RotateCcw, Save, SlidersHorizontal } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { Button, IconButton } from "../../shared/ui/index.js";

export function TeammateSettingsHeader({
  teammateName,
  profileActive,
  profileDirty,
  savingProfile,
  modelActive,
  modelDirty,
  savingModel,
  permissionsActive,
  permissionsDirty,
  savingPermissions,
  onBack,
  onResetProfile,
  onSaveProfile,
  onResetModel,
  onSaveModel,
  onResetPermissions,
  onSavePermissions,
}: {
  readonly teammateName: string;
  readonly profileActive: boolean;
  readonly profileDirty: boolean;
  readonly savingProfile: boolean;
  readonly modelActive: boolean;
  readonly modelDirty: boolean;
  readonly savingModel: boolean;
  readonly permissionsActive: boolean;
  readonly permissionsDirty: boolean;
  readonly savingPermissions: boolean;
  readonly onBack: () => void;
  readonly onResetProfile: () => void;
  readonly onSaveProfile: () => void;
  readonly onResetModel: () => void;
  readonly onSaveModel: () => void;
  readonly onResetPermissions: () => void;
  readonly onSavePermissions: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  return (
    <header
      className="teammate-settings-header"
      aria-label={t("Single agent settings")}
      data-desktop-window-drag-region="true"
    >
      <div className="channel-settings-header-line teammate-settings-header-line">
        <button className="channel-settings-top-back" type="button" onClick={onBack}>
          <ArrowLeft size={16} />
          {t("Back to private chat")}
        </button>
        <div className="channel-settings-header-title teammate-settings-header-title">
          <span>
            <SlidersHorizontal size={17} aria-hidden="true" />
            <h2>{t("Teammate settings")}</h2>
          </span>
          <small title={teammateName}>{teammateName}</small>
        </div>
      </div>
      {profileActive ? (
        <div className="teammate-settings-header-actions">
          <IconButton
            disabled={!profileDirty || savingProfile}
            icon={RotateCcw}
            label={t("Reset profile")}
            onClick={onResetProfile}
          />
          <Button
            disabled={!profileDirty}
            leadingIcon={<Save />}
            loading={savingProfile}
            loadingLabel={t("Saving")}
            size="sm"
            variant="primary"
            onClick={onSaveProfile}
          >
            {t("Save changes")}
          </Button>
        </div>
      ) : modelActive ? (
        <div className="teammate-settings-header-actions">
          <IconButton
            disabled={!modelDirty || savingModel}
            icon={RotateCcw}
            label={t("Reset model")}
            onClick={onResetModel}
          />
          <Button
            disabled={!modelDirty}
            leadingIcon={<Save />}
            loading={savingModel}
            loadingLabel={t("Saving model")}
            size="sm"
            variant="primary"
            onClick={onSaveModel}
          >
            {t("Save model")}
          </Button>
        </div>
      ) : permissionsActive ? (
        <div className="teammate-settings-header-actions">
          <IconButton
            disabled={!permissionsDirty || savingPermissions}
            icon={RotateCcw}
            label={t("Reset permissions")}
            onClick={onResetPermissions}
          />
          <Button
            disabled={!permissionsDirty}
            leadingIcon={<Save />}
            loading={savingPermissions}
            loadingLabel={t("Saving")}
            size="sm"
            variant="primary"
            onClick={onSavePermissions}
          >
            {t("Save changes")}
          </Button>
        </div>
      ) : null}
    </header>
  );
}
