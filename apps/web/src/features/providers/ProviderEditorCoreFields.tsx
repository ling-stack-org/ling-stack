import { useMemo, useState } from "react";
import { useI18n } from "../../i18n.js";
import { EmptyState, Field, Input, Select } from "../../shared/ui/index.js";
import type { ProviderFormState, ProviderPreset, ProviderTemplate } from "../../types.js";
import { ProviderSecretInput } from "./ProviderSecretInput.js";
import { providerTemplateMatchesSetupIntent, type ProviderSetupIntent } from "./provider-workbench-view-models.js";

export function ProviderEditorCoreFields({
  supplierTemplates,
  setupIntent,
  selectedTemplateId,
  form,
  editingProvider,
  showApiKey,
  onFormChange,
  onResetModelDiscovery,
  onShowApiKeyChange,
  onTemplateSelect,
}: {
  readonly supplierTemplates: readonly ProviderTemplate[];
  readonly setupIntent: ProviderSetupIntent | "";
  readonly selectedTemplateId: string;
  readonly form: ProviderFormState;
  readonly editingProvider: ProviderPreset | undefined;
  readonly showApiKey: boolean;
  readonly onFormChange: (form: ProviderFormState) => void;
  readonly onResetModelDiscovery: () => void;
  readonly onShowApiKeyChange: (value: boolean) => void;
  readonly onTemplateSelect: (template: ProviderTemplate) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [supplierQuery, setSupplierQuery] = useState("");
  const custom = selectedTemplateId === "custom-openai-compatible";
  const selectedTemplate = supplierTemplates.find((template) => template.templateId === selectedTemplateId);
  const matchingTemplates = useMemo(() => {
    const query = supplierQuery.trim().toLowerCase();
    if (!query) return supplierTemplates;
    const filtered = supplierTemplates.filter((template) =>
      [template.displayName, template.templateId, template.providerId]
        .some((value) => value.toLowerCase().includes(query)),
    );
    if (selectedTemplate && !filtered.some((template) => template.templateId === selectedTemplate.templateId)) {
      return [selectedTemplate, ...filtered];
    }
    return filtered;
  }, [selectedTemplate, supplierQuery, supplierTemplates]);
  const recommendedTemplates = setupIntent
    ? matchingTemplates.filter((template) => providerTemplateMatchesSetupIntent(template, setupIntent))
    : matchingTemplates;
  const otherTemplates = setupIntent
    ? matchingTemplates.filter((template) => !providerTemplateMatchesSetupIntent(template, setupIntent))
    : [];

  function renderTemplateOption(template: ProviderTemplate, disabled = false): React.JSX.Element {
    return (
      <option key={template.templateId} value={template.templateId} disabled={disabled}>
        {t(template.displayName)}
      </option>
    );
  }

  return (
    <>
      <div className="provider-template-board">
        {supplierTemplates.length === 0 ? (
          <EmptyState compact title={t("No templates available.")} />
        ) : (
          <div className="provider-template-picker">
            <Input
              aria-label={t("Search suppliers")}
              className="provider-supplier-search"
              placeholder={t("Search suppliers")}
              value={supplierQuery}
              onChange={(event) => setSupplierQuery(event.target.value)}
            />
            <Field className="provider-template-select-field" label={t("Model supplier")}>
              <Select
                value={selectedTemplateId}
                onChange={(event) => {
                  const template = supplierTemplates.find((item) => item.templateId === event.target.value);
                  if (!template) return;
                  onResetModelDiscovery();
                  onTemplateSelect(template);
                }}
              >
                {recommendedTemplates.length > 0 ? (
                  <optgroup label={setupIntent ? t("Recommended suppliers") : t("Built-in suppliers")}>
                    {recommendedTemplates.map((template) => renderTemplateOption(template))}
                  </optgroup>
                ) : null}
                {otherTemplates.length > 0 ? (
                  <optgroup label={t("Other built-in suppliers")}>
                    {otherTemplates.map((template) => renderTemplateOption(template, true))}
                  </optgroup>
                ) : null}
              </Select>
            </Field>
            {setupIntent && otherTemplates.length > 0 ? (
              <span className="provider-template-directory-note">
                {t("Showing {available} compatible suppliers; {other} more are available for other purposes.", {
                  available: recommendedTemplates.length,
                  other: otherTemplates.length,
                })}
              </span>
            ) : null}
          </div>
        )}
      </div>
      <div className={custom ? "provider-editor-core provider-editor-core-custom" : "provider-editor-core"}>
        {custom ? (
          <Field label={t("Provider name")}>
            <Input value={form.displayName} onChange={(event) => onFormChange({ ...form, displayName: event.target.value })} />
          </Field>
        ) : null}
        <Field label={t("Model")}>
          <Input value={form.model} onChange={(event) => onFormChange({ ...form, model: event.target.value })} />
        </Field>
        {custom ? (
          <Field label={t("Base URL")}>
            <Input value={form.baseUrl} onChange={(event) => onFormChange({ ...form, baseUrl: event.target.value })} />
          </Field>
        ) : null}
        <Field className="provider-api-key-field" label={t("API key")}>
          <ProviderSecretInput
            form={form}
            editingProvider={editingProvider}
            showApiKey={showApiKey}
            onFormChange={onFormChange}
            onShowApiKeyChange={onShowApiKeyChange}
          />
        </Field>
        {custom ? (
          <Field className="provider-api-protocol-field" label={t("API protocol")}>
            <Select
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
            </Select>
          </Field>
        ) : null}
      </div>
    </>
  );
}
