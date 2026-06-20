import { Loader2, Save, ShieldCheck } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { MetaRow, StatusBadge } from "../../shared/components/index.js";
import type { AiTeammate, ProviderPreset } from "../../types.js";

interface TeammateModelSettingsForm {
  readonly displayName: string;
  readonly description: string;
  readonly providerPresetId: string;
  readonly status: AiTeammate["status"];
  readonly pinned: boolean;
  readonly hidden: boolean;
  readonly systemPrompt: string;
  readonly appendSystemPromptText: string;
}

export function TeammateModelTab({
  providers,
  settingsForm,
  settingsProvider,
  settingsProviderReady,
  isProtectedSystemTeammate,
  saveMessage,
  saving,
  onSettingsFormChange,
  onOpenProviders,
  onSaveSettings,
}: {
  readonly providers: readonly ProviderPreset[];
  readonly settingsForm: TeammateModelSettingsForm;
  readonly settingsProvider: ProviderPreset | undefined;
  readonly settingsProviderReady: boolean;
  readonly isProtectedSystemTeammate: boolean;
  readonly saveMessage: string;
  readonly saving: boolean;
  readonly onSettingsFormChange: (form: TeammateModelSettingsForm) => void;
  readonly onOpenProviders: () => void;
  readonly onSaveSettings: () => void | Promise<void>;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <section className="teammate-list-panel teammate-model-panel" aria-label={t("Model")}>
      <div className="panel-title split">
        <span>
          <ShieldCheck size={16} />
          <h2>{t("Model")}</h2>
        </span>
        <StatusBadge status={isProtectedSystemTeammate ? "managed" : settingsProviderReady ? "ready" : "blocked"} />
      </div>
      {!isProtectedSystemTeammate ? (
        <div className="teammate-settings-grid">
          <label className="field wide">
            <span>{t("Provider")}</span>
            <select value={settingsForm.providerPresetId} onChange={(event) => onSettingsFormChange({ ...settingsForm, providerPresetId: event.target.value })}>
              <option value="">{t("None")}</option>
              {providers.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.displayName} / {item.model}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : null}
      <div className="teammate-config-card">
        <MetaRow label={t("Provider")} value={settingsProvider ? settingsProvider.displayName : t("None")} compact />
        <MetaRow label={t("Model")} value={settingsProvider?.model ?? "-"} compact />
        <MetaRow label={t("Status")} value={settingsProviderReady ? t("Ready") : t("Needs setup")} compact />
      </div>
      {isProtectedSystemTeammate ? (
        <div className="provider-run-notice neutral">
          <ShieldCheck size={16} />
          <span>{t("Ling Agent uses the active channel or workspace provider path. Its provider access is managed by Ling Stack.")}</span>
        </div>
      ) : settingsProvider && !settingsProviderReady ? (
        <div className="provider-run-notice">
          <ShieldCheck size={16} />
          <span>{t("Provider needs a successful check before reliable AI replies.")}</span>
        </div>
      ) : !settingsProvider ? (
        <div className="provider-run-notice neutral">
          <ShieldCheck size={16} />
          <span>{t("No provider is bound. Private chat will record messages but AI replies may be blocked.")}</span>
        </div>
      ) : null}
      {saveMessage ? <small>{saveMessage}</small> : null}
      <div className="teammate-settings-actions">
        <button className="secondary-button" type="button" onClick={onOpenProviders}>
          <ShieldCheck size={15} />
          {t("Model Workbench")}
        </button>
        {!isProtectedSystemTeammate ? (
          <button className="primary-button" type="button" onClick={() => void onSaveSettings()} disabled={saving}>
            {saving ? <Loader2 className="spin" size={15} /> : <Save size={15} />}
            {t("Save")}
          </button>
        ) : null}
      </div>
    </section>
  );
}
