import { useEffect, useState, type KeyboardEvent } from "react";
import { Save } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { Field, IconButton, Input } from "../../shared/ui/index.js";

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
    <Field className="channel-name-field" label={t("Name")} error={errorMessage || undefined}>
      <Input
        aria-label={t("Name")}
        value={draftName}
        onChange={(event) => {
          setDraftName(event.target.value);
          setErrorMessage("");
        }}
        onKeyDown={onInputKeyDown}
        disabled={disabled || saving}
        invalid={Boolean(errorMessage)}
        suffix={(
          <IconButton
            className="channel-settings-field-action"
            icon={Save}
            label={t("Save channel")}
            loading={saving}
            loadingLabel={t("Save channel")}
            onClick={() => void saveName()}
            disabled={disabled || !canSave}
            size="sm"
          />
        )}
      />
    </Field>
  );
}
