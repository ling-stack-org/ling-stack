import { ArrowLeft } from "lucide-react";
import { useI18n } from "../../i18n.js";

export function SettingsToolReturnRow({
  className,
  onBack,
}: {
  readonly className?: string;
  readonly onBack: () => void;
}): JSX.Element {
  const { t } = useI18n();

  return (
    <div className={["settings-tool-return-row", className].filter(Boolean).join(" ")}>
      <button className="secondary-button compact-button" type="button" onClick={onBack}>
        <ArrowLeft size={15} />
        {t("Back to workspace tools")}
      </button>
    </div>
  );
}
