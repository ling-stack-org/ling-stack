import type { ReactNode } from "react";
import { CheckCircle2, CircleAlert, Eye, EyeOff, Loader2, Plus, Save, X } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { providerCheckStatusLabel } from "../../lib/providers.js";
import type {
  ProviderCheckResult,
  ProviderFormState,
  ProviderPreset,
  ProviderTemplate,
} from "../../types.js";
import { ProviderAdvancedSettings } from "./ProviderAdvancedSettings.js";
import type { ProviderSetupIntent } from "./provider-workbench-view-models.js";

import { SelectControl } from "../../shared/components/SelectControl.js";

export function ProviderEditorPanel({
  supplierTemplates,
  setupIntent,
  selectedTemplateId,
  form,
  editingProvider,
  editingProviderId,
  showApiKey,
  canEditCustomProviderFields,
  modelImportPanel,
  editorErrorMessage,
  editorWarningMessage,
  checkResult,
  editorCheckProviderName,
  editorCheckMessage,
  editorCheckGuidance,
  selectedImportCount,
  isCheckingProviders,
  isSaveChecking,
  onClose,
  onTemplateSelect,
  onResetModelDiscovery,
  onFormChange,
  onShowApiKeyChange,
  onSaveCurrentPreset,
  onPrimaryAction,
}: {
  readonly supplierTemplates: readonly ProviderTemplate[];
  readonly setupIntent: ProviderSetupIntent | "";
  readonly selectedTemplateId: string;
  readonly form: ProviderFormState;
  readonly editingProvider: ProviderPreset | undefined;
  readonly editingProviderId: string;
  readonly showApiKey: boolean;
  readonly canEditCustomProviderFields: boolean;
  readonly modelImportPanel: ReactNode;
  readonly editorErrorMessage: string;
  readonly editorWarningMessage: string;
  readonly checkResult: ProviderCheckResult | undefined;
  readonly editorCheckProviderName: string;
  readonly editorCheckMessage: string;
  readonly editorCheckGuidance: string;
  readonly selectedImportCount: number;
  readonly isCheckingProviders: boolean;
  readonly isSaveChecking: boolean;
  readonly onClose: () => void;
  readonly onTemplateSelect: (template: ProviderTemplate) => void;
  readonly onResetModelDiscovery: () => void;
  readonly onFormChange: (form: ProviderFormState) => void;
  readonly onShowApiKeyChange: (value: boolean) => void;
  readonly onSaveCurrentPreset: () => void;
  readonly onPrimaryAction: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const setupTitle =
    !editingProviderId && setupIntent === "chat"
      ? t("New chat model")
      : !editingProviderId && setupIntent === "generation"
        ? t("New image generation model")
        : !editingProviderId && setupIntent === "video_generation"
          ? t("New video generation model")
        : editingProviderId
          ? t("Edit preset")
          : t("New preset");
  const isCustomProvider = selectedTemplateId === "custom-openai-compatible";

  return (
    <div className="provider-sheet-backdrop" role="presentation">
      <section className="panel provider-form-panel provider-sheet" aria-labelledby="provider-form-title" role="dialog" aria-modal="true">
        <div className="panel-title split provider-sheet-header">
          <span>
            <h2 id="provider-form-title">{setupTitle}</h2>
          </span>
          <button className="icon-button" type="button" onClick={onClose} aria-label={t("Close model preset editor")}>
            <X size={16} />
          </button>
        </div>

        <div className="provider-sheet-body">
          <div className="provider-template-board">
            {supplierTemplates.length === 0 ? (
              <div className="empty-state compact-empty">
                <span>{t("No templates available.")}</span>
              </div>
            ) : (
              <label className="field wide provider-template-select-field">
                <span>{t("Model supplier")}</span>
                <SelectControl
                  value={selectedTemplateId}
                  onChange={(event) => {
                    const template = supplierTemplates.find((item) => item.templateId === event.target.value);
                    if (!template) {
                      return;
                    }
                    onResetModelDiscovery();
                    onTemplateSelect(template);
                  }}
                >
                  {supplierTemplates.map((template) => (
                    <option key={template.templateId} value={template.templateId}>
                      {t(template.displayName)}
                    </option>
                  ))}
                </SelectControl>
              </label>
            )}
          </div>
          {isCustomProvider ? (
            <div className="field-row provider-identity-row">
              <label className="field">
                <span>{t("Provider name")}</span>
                <input value={form.displayName} onChange={(event) => onFormChange({ ...form, displayName: event.target.value })} />
              </label>
              <label className="field">
                <span>{t("Model")}</span>
                <input value={form.model} onChange={(event) => onFormChange({ ...form, model: event.target.value })} />
              </label>
            </div>
          ) : (
            <div className="field-row provider-core-row">
              <label className="field">
                <span>{t("Model")}</span>
                <input value={form.model} onChange={(event) => onFormChange({ ...form, model: event.target.value })} />
              </label>
              <div className="field provider-api-key-field">
                <span>{t("API key")}</span>
                <ProviderSecretInput
                  form={form}
                  editingProvider={editingProvider}
                  showApiKey={showApiKey}
                  onFormChange={onFormChange}
                  onShowApiKeyChange={onShowApiKeyChange}
                />
              </div>
            </div>
          )}

          {isCustomProvider ? (
            <>
              <div className="field-row provider-connection-row">
                <label className="field">
                  <span>{t("Base URL")}</span>
                  <input value={form.baseUrl} onChange={(event) => onFormChange({ ...form, baseUrl: event.target.value })} />
                </label>
                <div className="field provider-api-key-field">
                  <span>{t("API key")}</span>
                  <ProviderSecretInput
                    form={form}
                    editingProvider={editingProvider}
                    showApiKey={showApiKey}
                    onFormChange={onFormChange}
                    onShowApiKeyChange={onShowApiKeyChange}
                  />
                </div>
              </div>
              <label className="field">
                <span>{t("API protocol")}</span>
                <SelectControl
                  value={form.api}
                  onChange={(event) => {
                    const api = event.target.value as ProviderFormState["api"];
                    onFormChange({ ...form, api, providerTransport: api === "openai-codex-responses" ? form.providerTransport || "auto" : "" });
                  }}
                >
                  <option value="openai-completions">{t("OpenAI completions")}</option>
                  <option value="openai-responses">{t("OpenAI responses")}</option>
                  <option value="openai-codex-responses">{t("OpenAI Codex Responses")}</option>
                  <option value="anthropic-messages">{t("Anthropic messages")}</option>
                  <option value="google-generative-ai">{t("Google generative AI")}</option>
                  <option value="mistral-conversations">{t("Mistral conversations")}</option>
                </SelectControl>
              </label>
            </>
          ) : null}

          {modelImportPanel}

          <ProviderAdvancedSettings
            form={form}
            editingProviderId={editingProviderId}
            isCustomProvider={isCustomProvider}
            canEditCustomProviderFields={canEditCustomProviderFields}
            onFormChange={onFormChange}
          />

          {editorErrorMessage ? (
            <div className="inline-error provider-editor-error">
              <CircleAlert size={16} />
              <span>{t(editorErrorMessage)}</span>
            </div>
          ) : null}
          {editorWarningMessage ? (
            <div className="model-fetch-error neutral provider-editor-warning">
              <CircleAlert size={16} />
              <span>{t(editorWarningMessage)}</span>
            </div>
          ) : null}

          {checkResult && !editorErrorMessage ? (
            <div className={checkResult.ok ? "check-result ok" : "check-result bad"}>
              {checkResult.ok ? <CheckCircle2 size={16} /> : <CircleAlert size={16} />}
              <div className="check-result-copy">
                <span className="check-result-status">{providerCheckStatusLabel(checkResult, t)}</span>
                <strong>{editorCheckProviderName || t("Provider check")}</strong>
                <span>{editorCheckMessage}</span>
                {editorCheckGuidance ? <small>{editorCheckGuidance}</small> : null}
                {checkResult.message ? (
                  <details className="provider-check-raw-details">
                    <summary>{t("Check details")}</summary>
                    <small>{t("Provider response")}: {t(checkResult.message)}</small>
                  </details>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>

        <div className="provider-sheet-footer">
          <div className="action-row">
            <button className="secondary-button" type="button" onClick={onClose}>
              {t("Cancel")}
            </button>
            {editingProviderId && selectedImportCount > 0 ? (
              <button
                className="secondary-button"
                type="button"
                disabled={isCheckingProviders}
                onClick={onSaveCurrentPreset}
              >
                <Save size={16} />
                {t("Save current preset")}
              </button>
            ) : null}
            <button
              className="primary-button"
              type="button"
              disabled={isCheckingProviders}
              onClick={onPrimaryAction}
            >
              {isSaveChecking ? <Loader2 className="spin" size={16} /> : selectedImportCount > 0 ? <Plus size={16} /> : <Save size={16} />}
              {selectedImportCount > 0
                ? t("Import selected models ({count})", { count: selectedImportCount })
                : editingProviderId
                  ? t("Save changes")
                  : t("Add model")}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

function ProviderSecretInput({
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
}): JSX.Element {
  const { t } = useI18n();
  return (
    <div className="provider-secret-input">
      <input
        aria-label={t("API key")}
        type={showApiKey ? "text" : "password"}
        autoComplete="new-password"
        value={form.apiKey}
        placeholder={t("Paste API key")}
        onChange={(event) => onFormChange({ ...form, apiKey: event.target.value, clearApiKey: false })}
      />
      {form.apiKey ? (
        <span className="provider-secret-actions">
          <button
            className="icon-button provider-secret-toggle"
            type="button"
            aria-label={showApiKey ? t("Hide API key") : t("Show API key")}
            onClick={() => onShowApiKeyChange(!showApiKey)}
          >
            {showApiKey ? <Eye size={15} /> : <EyeOff size={15} />}
          </button>
          <button
            className="icon-button provider-secret-clear"
            type="button"
            aria-label={t("Clear input")}
            onClick={() => onFormChange({ ...form, apiKey: "", clearApiKey: Boolean(editingProvider?.apiKeyConfigured) })}
          >
            <X size={15} />
          </button>
        </span>
      ) : null}
    </div>
  );
}
