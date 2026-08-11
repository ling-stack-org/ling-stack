import { useI18n } from "../../i18n.js";
import { Field, Input, InspectorSection, Select, Switch, Textarea } from "../../shared/ui/index.js";
import type { ProviderFormState } from "../../types.js";

export function ProviderAdvancedSettings({
  form,
  editingProviderId,
  isCustomProvider,
  canEditCustomProviderFields,
  onFormChange,
}: {
  readonly form: ProviderFormState;
  readonly editingProviderId: string;
  readonly isCustomProvider: boolean;
  readonly canEditCustomProviderFields: boolean;
  readonly onFormChange: (form: ProviderFormState) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  return (
    <InspectorSection className="provider-editor-advanced" title={t("Advanced settings")}>
      <div className="provider-editor-advanced-body">
        {!isCustomProvider ? (
          <div className="provider-advanced-route-row">
            <Field label={t("Provider name")}>
              <Input value={form.displayName} onChange={(event) => onFormChange({ ...form, displayName: event.target.value })} />
            </Field>
            <Field label={t("Base URL")}>
              <Input value={form.baseUrl} onChange={(event) => onFormChange({ ...form, baseUrl: event.target.value })} />
            </Field>
          </div>
        ) : null}
        {form.api === "media-job" ? (
          <div className="provider-readonly-field">
            <span>{t("Runtime adapter")}</span>
            <strong>{t("Generation adapter")}</strong>
          </div>
        ) : !isCustomProvider ? (
          <Field label={t("API protocol")}>
            <Select
              value={form.api}
              disabled={!canEditCustomProviderFields}
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
        {form.api === "openai-codex-responses" ? (
          <Field label={t("Transport")}>
            <Select
              value={form.providerTransport || "auto"}
              disabled={!canEditCustomProviderFields}
              onChange={(event) => onFormChange({ ...form, providerTransport: event.target.value as ProviderFormState["providerTransport"] })}
            >
              <option value="auto">{t("Auto")}</option>
              <option value="websocket">{t("WebSocket")}</option>
              <option value="websocket-cached">{t("WebSocket cached")}</option>
              <option value="sse">{t("SSE")}</option>
            </Select>
          </Field>
        ) : null}
        <Field
          className="provider-secret-headers-field"
          label={t("Secret headers")}
          description={t("One per line. Store env: or keychain: refs only, not secret values.")}
        >
          <Textarea
            rows={3}
            spellCheck={false}
            value={form.secretHeaderRefsText}
            placeholder="X-Api-Token: env:PROVIDER_TOKEN"
            onChange={(event) => onFormChange({ ...form, secretHeaderRefsText: event.target.value })}
          />
        </Field>
        <div className="provider-advanced-grid">
          <Field label={t("Context")}><Input value={form.contextWindow} inputMode="numeric" placeholder={t("Auto")} onChange={(event) => onFormChange({ ...form, contextWindow: event.target.value })} /></Field>
          <Field label={t("Max tokens")}><Input value={form.maxTokens} inputMode="numeric" placeholder={t("Auto")} onChange={(event) => onFormChange({ ...form, maxTokens: event.target.value })} /></Field>
        </div>
        <Field label={t("Capabilities")}><Input value={form.capabilitiesText} onChange={(event) => onFormChange({ ...form, capabilitiesText: event.target.value })} /></Field>
        <div className="provider-toggle-row">
          {editingProviderId ? <Toggle label={t("Enabled")} checked={form.enabled} onChange={(checked) => onFormChange({ ...form, enabled: checked })} /> : null}
          <Toggle label={t("Auth header")} checked={form.authHeader} onChange={(checked) => onFormChange({ ...form, authHeader: checked })} />
          <Toggle label={t("Reasoning")} checked={form.reasoning} onChange={(checked) => onFormChange({ ...form, reasoning: checked })} />
        </div>
      </div>
    </InspectorSection>
  );
}

function Toggle({ label, checked, onChange }: { readonly label: string; readonly checked: boolean; readonly onChange: (checked: boolean) => void }): React.JSX.Element {
  return (
    <label className="provider-toggle-field">
      <Switch aria-label={label} checked={checked} onCheckedChange={onChange} />
      <span>{label}</span>
    </label>
  );
}
