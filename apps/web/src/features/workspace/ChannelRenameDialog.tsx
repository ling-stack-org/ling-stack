import type { FormEvent } from "react";
import { FileCheck2, Loader2, PencilLine, X } from "lucide-react";
import { useI18n } from "../../i18n.js";

export function ChannelRenameDialog({
  value,
  currentName,
  saving,
  onValueChange,
  onSubmit,
  onClose,
}: {
  readonly value: string;
  readonly currentName: string;
  readonly saving: boolean;
  readonly onValueChange: (value: string) => void;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  readonly onClose: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const trimmedValue = value.trim();
  const submitDisabled = saving || !trimmedValue || trimmedValue === currentName;
  return (
    <div
      className="channel-create-overlay channel-rename-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <form className="channel-create-dialog channel-rename-dialog" role="dialog" aria-modal="true" aria-label={t("Rename channel")} onSubmit={onSubmit}>
        <div className="channel-create-head">
          <span>
            <PencilLine size={16} />
            <strong>{t("Rename channel")}</strong>
          </span>
          <button className="icon-button" type="button" onClick={onClose} aria-label={t("Cancel")} title={t("Cancel")} disabled={saving}>
            <X size={14} />
          </button>
        </div>
        <div className="channel-rename-body">
          <label className="field wide">
            <span>{t("Channel name")}</span>
            <input
              value={value}
              onChange={(event) => onValueChange(event.target.value)}
              autoFocus
              disabled={saving}
            />
          </label>
          <div className="channel-option-actions">
            <button className="primary-button compact-button" type="submit" disabled={submitDisabled}>
              {saving ? <Loader2 className="spin" size={14} /> : <FileCheck2 size={14} />}
              {t("Confirm")}
            </button>
            <button className="secondary-button compact-button" type="button" onClick={onClose} disabled={saving}>
              {t("Cancel")}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
