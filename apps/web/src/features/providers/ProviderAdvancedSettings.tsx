import { useI18n } from "../../i18n.js";
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
}): JSX.Element {
  const { t } = useI18n();

  return (
    <details className="provider-editor-advanced">
      <summary>{t("Advanced settings")}</summary>
      <div className="provider-editor-advanced-body">
        {!isCustomProvider ? (
          <div className="field-row provider-advanced-route-row">
            <label className="field">
              <span>{t("Provider name")}</span>
              <input value={form.displayName} onChange={(event) => onFormChange({ ...form, displayName: event.target.value })} />
            </label>
            <label className="field">
              <span>{t("Base URL")}</span>
              <input value={form.baseUrl} onChange={(event) => onFormChange({ ...form, baseUrl: event.target.value })} />
            </label>
          </div>
        ) : null}

        {form.api === "media-job" ? (
          <div className="field provider-readonly-field">
            <span>{t("Runtime adapter")}</span>
            <strong>{t("Generation adapter")}</strong>
          </div>
        ) : !isCustomProvider ? (
          <label className="field wide">
            <span>{t("API protocol")}</span>
            <select value={form.api} disabled={!canEditCustomProviderFields} onChange={(event) => {
              const api = event.target.value as ProviderFormState["api"];
              onFormChange({ ...form, api, providerTransport: api === "openai-codex-responses" ? form.providerTransport || "auto" : "" });
            }}>
              <option value="openai-completions">{t("OpenAI completions")}</option>
              <option value="openai-responses">{t("OpenAI responses")}</option>
              <option value="openai-codex-responses">{t("OpenAI Codex Responses")}</option>
              <option value="anthropic-messages">{t("Anthropic messages")}</option>
              <option value="google-generative-ai">{t("Google generative AI")}</option>
              <option value="mistral-conversations">{t("Mistral conversations")}</option>
            </select>
          </label>
        ) : null}

        {form.api === "openai-codex-responses" ? (
          <label className="field wide">
            <span>{t("Transport")}</span>
            <select
              value={form.providerTransport || "auto"}
              disabled={!canEditCustomProviderFields}
              onChange={(event) => onFormChange({ ...form, providerTransport: event.target.value as ProviderFormState["providerTransport"] })}
            >
              <option value="auto">{t("Auto")}</option>
              <option value="websocket">{t("WebSocket")}</option>
              <option value="websocket-cached">{t("WebSocket cached")}</option>
              <option value="sse">{t("SSE")}</option>
            </select>
          </label>
        ) : null}

        <label className="field wide provider-secret-headers-field">
          <span>{t("Secret headers")}</span>
          <textarea
            rows={3}
            spellCheck={false}
            value={form.secretHeaderRefsText}
            placeholder={"X-Api-Token: env:PROVIDER_TOKEN"}
            onChange={(event) => onFormChange({ ...form, secretHeaderRefsText: event.target.value })}
          />
          <small>{t("One per line. Store env: or keychain: refs only, not secret values.")}</small>
        </label>

        <div className="provider-advanced-grid">
          <label className="field">
            <span>{t("Context")}</span>
            <input value={form.contextWindow} inputMode="numeric" placeholder={t("Auto")} onChange={(event) => onFormChange({ ...form, contextWindow: event.target.value })} />
          </label>
          <label className="field">
            <span>{t("Max tokens")}</span>
            <input value={form.maxTokens} inputMode="numeric" placeholder={t("Auto")} onChange={(event) => onFormChange({ ...form, maxTokens: event.target.value })} />
          </label>
        </div>

        <label className="field wide">
          <span>{t("Capabilities")}</span>
          <input value={form.capabilitiesText} onChange={(event) => onFormChange({ ...form, capabilitiesText: event.target.value })} />
        </label>

        <div className="provider-toggle-row">
          {editingProviderId ? (
            <label className="settings-toggle">
              <input type="checkbox" checked={form.enabled} onChange={(event) => onFormChange({ ...form, enabled: event.target.checked })} />
              <span>{t("Enabled")}</span>
            </label>
          ) : null}
          <label className="settings-toggle">
            <input type="checkbox" checked={form.authHeader} onChange={(event) => onFormChange({ ...form, authHeader: event.target.checked })} />
            <span>{t("Auth header")}</span>
          </label>
          <label className="settings-toggle">
            <input type="checkbox" checked={form.reasoning} onChange={(event) => onFormChange({ ...form, reasoning: event.target.checked })} />
            <span>{t("Reasoning")}</span>
          </label>
        </div>
      </div>
    </details>
  );
}
