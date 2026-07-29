import { ArrowLeft, RotateCcw, Save } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { Button, IconButton } from "../../shared/ui/index.js";

export function TeammateSettingsHeader({
  title,
  profileActive,
  profileDirty,
  savingProfile,
  modelActive,
  modelDirty,
  savingModel,
  onBack,
  onResetProfile,
  onSaveProfile,
  onResetModel,
  onSaveModel,
}: {
  readonly title: string;
  readonly profileActive: boolean;
  readonly profileDirty: boolean;
  readonly savingProfile: boolean;
  readonly modelActive: boolean;
  readonly modelDirty: boolean;
  readonly savingModel: boolean;
  readonly onBack: () => void;
  readonly onResetProfile: () => void;
  readonly onSaveProfile: () => void;
  readonly onResetModel: () => void;
  readonly onSaveModel: () => void;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <header className="teammate-settings-header" aria-label={t("Single agent settings")}>
      <Button className="teammate-settings-back" leadingIcon={<ArrowLeft />} size="sm" variant="ghost" onClick={onBack}>
        {t("Back to private chat")}
      </Button>
      <h2 title={title}>{title}</h2>
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
      ) : <span />}
    </header>
  );
}
