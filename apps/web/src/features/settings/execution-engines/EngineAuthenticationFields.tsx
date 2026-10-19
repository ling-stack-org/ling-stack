import { kimiProviderTypes, type ExecutionEngineProfileConfiguration } from "@ling-stack/contracts";
import { useI18n } from "../../../i18n.js";
import { Field, Input, Select, SegmentedControl, SegmentedControlItem } from "../../../shared/ui/index.js";
import { EngineSecretField } from "./EngineSecretField.js";

const providerNames = {
  kimi: "Kimi", anthropic: "Anthropic", openai: "OpenAI Chat Completions",
  openai_responses: "OpenAI Responses", "google-genai": "Google GenAI", vertexai: "Vertex AI",
};

export function EngineAuthenticationFields({ draft, busy, retry, onChange, onMode }: {
  readonly draft: ExecutionEngineProfileConfiguration;
  readonly busy: boolean;
  readonly retry: boolean;
  readonly onChange: (patch: Partial<Omit<ExecutionEngineProfileConfiguration, "engineId">>) => void;
  readonly onMode: (mode: "account" | "apiKey") => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const accountSupported = draft.engineId === "codex-app-server" || draft.engineId === "kimi-acp";
  const keyMode = !accountSupported || draft.secretRef !== undefined;
  const kimi = draft.kimi ?? { providerType: "kimi", baseUrl: "", modelId: "", maxContextSize: 0 };
  return <>
    {accountSupported ? <Field label={t("Authentication")}>
      <SegmentedControl className="engine-profile-region" aria-label={t("Authentication")} value={keyMode ? "apiKey" : "account"}
        onValueChange={(value) => { if (value === "account" || value === "apiKey") onMode(value); }}>
        <SegmentedControlItem value="account" disabled={busy}>{t("Account sign-in")}</SegmentedControlItem>
        <SegmentedControlItem value="apiKey" disabled={busy}>{t("API key")}</SegmentedControlItem>
      </SegmentedControl>
    </Field> : null}
    {draft.engineId === "openclaw-acp" ? <Field label={t("Authentication")}>
      <SegmentedControl className="engine-profile-region" aria-label={t("Authentication")} value={draft.openclaw?.credentialType ?? "token"}
        onValueChange={(value) => {
          if (value === "token" || value === "password") onChange({ openclaw: {
            gatewayUrl: "", agentId: "", ...draft.openclaw, credentialType: value,
          } });
        }}>
        <SegmentedControlItem value="token" disabled={busy}>{t("Token")}</SegmentedControlItem>
        <SegmentedControlItem value="password" disabled={busy}>{t("Password")}</SegmentedControlItem>
      </SegmentedControl>
    </Field> : null}
    {keyMode ? <EngineSecretField key={`${draft.engineId}:${draft.openclaw?.credentialType ?? "key"}`}
      label={draft.engineId === "openclaw-acp" ? draft.openclaw?.credentialType === "password" ? t("Password") : t("Token") : t("API key")}
      secretRef={draft.secretRef} busy={busy} retry={retry} onReference={(secretRef) => onChange({ secretRef })} /> : null}
    {draft.engineId === "kimi-acp" && keyMode ? <div className="engine-key-configuration">
      <Field label={t("Provider type")} required>
        <Select value={kimi.providerType} onChange={(event) => {
          const providerType = kimiProviderTypes.find((value) => value === event.target.value);
          if (providerType) onChange({ kimi: { ...kimi, providerType } });
        }}>
          {kimiProviderTypes.map((value) => <option key={value} value={value}>{providerNames[value]}</option>)}
        </Select>
      </Field>
      <Field label={t("Context window")} required>
        <Input required type="number" min={1} max={Number.MAX_SAFE_INTEGER} step={1} value={kimi.maxContextSize || ""}
          onChange={(event) => onChange({ kimi: { ...kimi, maxContextSize: Number.isNaN(event.target.valueAsNumber) ? 0 : event.target.valueAsNumber } })} />
      </Field>
      <Field className="engine-key-wide" label={t("Base URL")} required>
        <Input required type="url" autoComplete="off" spellCheck={false} value={kimi.baseUrl} maxLength={2048}
          onChange={(event) => onChange({ kimi: { ...kimi, baseUrl: event.target.value } })} />
      </Field>
      <Field className="engine-key-wide" label={t("Model ID")} required>
        <Input required autoComplete="off" spellCheck={false} value={kimi.modelId} maxLength={512}
          onChange={(event) => onChange({ kimi: { ...kimi, modelId: event.target.value } })} />
      </Field>
    </div> : null}
  </>;
}
