import { Eye, EyeOff, X } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { IconButton, Input } from "../../shared/ui/index.js";
import type { ProviderFormState, ProviderPreset } from "../../types.js";

export function ProviderSecretInput({
  form,
  editingProvider,
  showApiKey,
  onFormChange,
  onShowApiKeyChange,
}: {
  readonly form: ProviderFormState;
  readonly editingProvider: ProviderPreset | undefined;
  readonly showApiKey: boolean;
  readonly onFormChange: (form: ProviderFormState) => void;
  readonly onShowApiKeyChange: (value: boolean) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  return (
    <div className="provider-secret-input">
      <Input
        aria-label={t("API key")}
        autoComplete="new-password"
        type={showApiKey ? "text" : "password"}
        value={form.apiKey}
        placeholder={t("Paste API key")}
        onChange={(event) => onFormChange({ ...form, apiKey: event.target.value, clearApiKey: false })}
      />
      {form.apiKey ? <span className="provider-secret-actions">
      <IconButton
        className="provider-secret-toggle"
        icon={showApiKey ? Eye : EyeOff}
        label={showApiKey ? t("Hide API key") : t("Show API key")}
        onClick={() => onShowApiKeyChange(!showApiKey)}
      />
      <IconButton
        className="provider-secret-clear"
        icon={X}
        label={t("Clear input")}
        onClick={() => onFormChange({ ...form, apiKey: "", clearApiKey: Boolean(editingProvider?.apiKeyConfigured) })}
      />
      </span> : null}
    </div>
  );
}
