import { useEffect, useId, useState, type KeyboardEvent } from "react";
import { Loader2, Save } from "lucide-react";
import { useI18n } from "../../i18n.js";

export function ChannelNameField({
  value,
  disabled,
  onSave,
}: {
  readonly value: string;
  readonly disabled: boolean;
  readonly onSave: (name: string) => Promise<void>;
}): JSX.Element {
  const { t } = useI18n();
  const inputId = useId();
  const [draftName, setDraftName] = useState(value);
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const normalizedName = draftName.trim();
  const canSave = Boolean(normalizedName) && normalizedName !== value.trim();

  useEffect(() => {
    setDraftName(value);
    setErrorMessage("");
  }, [value]);

  async function saveName(): Promise<void> {
    if (!canSave || saving) {
      return;
    }
    setSaving(true);
    setErrorMessage("");
    try {
      await onSave(normalizedName);
      setDraftName(normalizedName);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  function onInputKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key !== "Enter" || !canSave) {
      return;
    }
    event.preventDefault();
    void saveName();
  }

  return (
    <div className="field channel-name-field">
      <span><label htmlFor={inputId}>{t("Name")}</label></span>
      <span className="channel-name-control">
        <input
          id={inputId}
          aria-label={t("Name")}
          aria-invalid={Boolean(errorMessage)}
          value={draftName}
          onChange={(event) => {
            setDraftName(event.target.value);
            setErrorMessage("");
          }}
          onKeyDown={onInputKeyDown}
          disabled={disabled || saving}
        />
        <button
          className="icon-button channel-settings-field-action"
          type="button"
          aria-label={t("Save channel")}
          title={t("Save channel")}
          onClick={() => void saveName()}
          disabled={disabled || saving || !canSave}
        >
          {saving ? <Loader2 className="spin" size={15} /> : <Save size={15} />}
        </button>
      </span>
      {errorMessage ? <small className="channel-name-error danger-text" role="alert">{errorMessage}</small> : null}
    </div>
  );
}
