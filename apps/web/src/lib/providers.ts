import type {
  ProviderCheckResult,
  ProviderFormState,
  ProviderPreset,
  ProviderTemplate,
} from "../types.js";

type ProviderTranslate = (key: string, values?: Readonly<Record<string, string | number>>) => string;

export interface ProviderTemplateGroup {
  readonly label: string;
  readonly templates: readonly ProviderTemplate[];
}

export const defaultProviderForm: ProviderFormState = {
  kind: "openai-compatible",
  displayName: "Local Relay",
  providerId: "local-relay",
  model: "gpt-5.5",
  api: "openai-completions",
  baseUrl: "http://127.0.0.1:8317/v1",
  apiKey: "",
  apiKeyRef: "",
  clearApiKey: false,
  capabilitiesText: "chat,tool_call,reasoning",
  inputText: "text",
  enabled: true,
  authHeader: true,
  reasoning: true,
  contextWindow: "128000",
  maxTokens: "16384",
};

export const customOpenAICompatibleForm: ProviderFormState = {
  kind: "openai-compatible",
  displayName: "Custom OpenAI-compatible",
  providerId: "custom-openai-compatible",
  model: "your-model-id",
  api: "openai-completions",
  baseUrl: "https://api.example.com/v1",
  apiKey: "",
  apiKeyRef: "",
  clearApiKey: false,
  capabilitiesText: "chat,tool_call,reasoning",
  inputText: "text",
  enabled: true,
  authHeader: true,
  reasoning: true,
  contextWindow: "128000",
  maxTokens: "16384",
};

export function providerToForm(provider: ProviderPreset, templates: readonly ProviderTemplate[] = []): ProviderFormState {
  return {
    kind: provider.kind,
    displayName: provider.displayName,
    providerId: provider.providerId,
    model: provider.model,
    api: provider.api,
    baseUrl: providerEffectiveBaseUrl(provider, templates),
    apiKey: "",
    apiKeyRef: provider.apiKeyRef?.startsWith("local:") ? "" : provider.apiKeyRef ?? "",
    clearApiKey: false,
    capabilitiesText: provider.capabilities.join(", "),
    inputText: provider.input.join(", "),
    enabled: provider.enabled,
    authHeader: provider.authHeader ?? true,
    reasoning: provider.reasoning ?? false,
    contextWindow: provider.contextWindow ? String(provider.contextWindow) : "",
    maxTokens: provider.maxTokens ? String(provider.maxTokens) : "",
  };
}

export function providerEffectiveBaseUrl(
  provider: Pick<ProviderPreset, "api" | "baseUrl" | "kind" | "providerId">,
  templates: readonly ProviderTemplate[] = [],
): string {
  return provider.baseUrl ?? providerTemplateBaseUrl(provider, templates);
}

function providerTemplateBaseUrl(
  provider: Pick<ProviderPreset, "api" | "kind" | "providerId">,
  templates: readonly ProviderTemplate[],
): string {
  const matchingTemplate =
    templates.find((template) => template.providerId === provider.providerId && template.kind === provider.kind && template.api === provider.api) ??
    templates.find((template) => template.providerId === provider.providerId && template.kind === provider.kind) ??
    templates.find((template) => template.kind === provider.kind && template.api === provider.api);
  return matchingTemplate?.baseUrl ?? "";
}

export function providerTemplateToForm(template: ProviderTemplate, t?: ProviderTranslate): ProviderFormState {
  const isRunnableChatTemplate = template.api !== "media-job" && template.capabilities.includes("chat");
  return {
    kind: template.kind,
    displayName: translateProviderText(t, template.displayName),
    providerId: template.providerId,
    model: template.model,
    api: template.api,
    baseUrl: template.baseUrl ?? "",
    apiKey: "",
    apiKeyRef: "",
    clearApiKey: false,
    capabilitiesText: template.capabilities.join(", "),
    inputText: (template.input ?? ["text"]).join(", "),
    enabled: isRunnableChatTemplate ? true : template.enabled ?? false,
    authHeader: template.authHeader ?? true,
    reasoning: template.reasoning ?? false,
    contextWindow: template.contextWindow ? String(template.contextWindow) : "",
    maxTokens: template.maxTokens ? String(template.maxTokens) : "",
  };
}

export function providerFormToTemplate(form: ProviderFormState): ProviderTemplate {
  return {
    templateId: "custom-openai-compatible",
    description: "Custom OpenAI-compatible endpoint.",
    kind: form.kind,
    displayName: form.displayName,
    providerId: form.providerId,
    model: form.model,
    api: form.api,
    baseUrl: form.baseUrl,
    apiKeyRef: form.apiKeyRef,
    authHeader: form.authHeader,
    reasoning: form.reasoning,
    input: splitProviderCsv(form.inputText) as ProviderTemplate["input"],
    contextWindow: form.contextWindow ? Number(form.contextWindow) : undefined,
    maxTokens: form.maxTokens ? Number(form.maxTokens) : undefined,
    compat: {},
    capabilities: splitProviderCsv(form.capabilitiesText) as ProviderTemplate["capabilities"],
    enabled: form.enabled,
  };
}

export function splitProviderCsv(value: string): readonly string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function canUseProviderForRun(provider: ProviderPreset): boolean {
  return provider.enabled && provider.api !== "media-job" && provider.capabilities.includes("chat") && providerSecretReady(provider);
}

export function canBatchCheckProvider(provider: ProviderPreset): boolean {
  return provider.enabled && provider.api !== "media-job" && provider.capabilities.includes("chat");
}

export function providerSecretReady(provider: ProviderPreset): boolean {
  return !providerNeedsSecret(provider) || provider.apiKeyConfigured;
}

export function providerNeedsSecret(provider: Pick<ProviderPreset, "api" | "authHeader" | "apiKeyRef">): boolean {
  return provider.api === "anthropic-messages" || provider.authHeader !== false || Boolean(provider.apiKeyRef);
}

export function isMediaProvider(provider: ProviderPreset): boolean {
  return provider.api === "media-job";
}

export function providerCodingTaskLabel(provider: ProviderPreset, t?: ProviderTranslate): string {
  const blocker = providerRunPreflightBlocker(provider, t);
  return blocker ? translateProviderText(t, "blocked - {reason}", { reason: blocker }) : translateProviderText(t, "ready");
}

export function providerRunBlockerLabel(provider: ProviderPreset, t?: ProviderTranslate): string {
  if (!provider.enabled) {
    return translateProviderText(t, "disabled");
  }
  if (provider.api === "media-job") {
    return translateProviderText(t, "media job only");
  }
  if (!provider.capabilities.includes("chat")) {
    return translateProviderText(t, "no chat");
  }
  if (!providerSecretReady(provider)) {
    return translateProviderText(t, "API key missing");
  }
  return translateProviderText(t, "not runnable");
}

export function providerRunPreflightBlocker(provider: ProviderPreset | undefined, t?: ProviderTranslate): string | undefined {
  if (!provider) {
    return translateProviderText(t, "Provider preset not found");
  }
  if (!canUseProviderForRun(provider)) {
    return translateProviderText(t, "{providerName}: {reason}.", {
      providerName: provider.displayName,
      reason: providerRunBlockerLabel(provider, t),
    });
  }
  if (!provider.lastCheck) {
    return translateProviderText(t, "{providerName}: provider has not been checked. Use Check run before starting.", {
      providerName: provider.displayName,
    });
  }
  if (!provider.lastCheck.ok) {
    return translateProviderText(t, "{providerName}: provider check failed ({status}). {guidance}", {
      providerName: provider.displayName,
      status: providerCheckStatusLabel(provider.lastCheck, t),
      guidance: providerCheckGuidance(provider.lastCheck, provider, t),
    });
  }
  return undefined;
}

export function providerPreflightReady(provider: ProviderPreset): boolean {
  return providerRunPreflightBlocker(provider) === undefined;
}

export function taskProviderReadinessMessage(provider: ProviderPreset | undefined, blocker: string | undefined, t?: ProviderTranslate): string {
  if (!provider) {
    return translateProviderText(t, "No provider preset is selected for this task run.");
  }
  if (!blocker) {
    return translateProviderText(t, "{providerName} passed the last provider check and can run this task.", {
      providerName: provider.displayName,
    });
  }
  return blocker;
}

export function taskProviderReadinessGuidance(provider: ProviderPreset | undefined, t?: ProviderTranslate): string {
  if (!provider) {
    return translateProviderText(t, "Select a provider preset or set one as the channel default.");
  }
  if (!canUseProviderForRun(provider)) {
    return providerNeedsSecret(provider) && !provider.apiKeyConfigured
      ? translateProviderText(t, "Add an API key in Model Workbench, then Save.")
      : translateProviderText(t, "Open Model Workbench to enable a chat-capable preset before running.");
  }
  if (!provider.lastCheck) {
    return translateProviderText(t, "Save validates the API key, base URL, and model access before starting.");
  }
  if (!provider.lastCheck.ok) {
    return providerCheckGuidance(provider.lastCheck, provider, t);
  }
  return translateProviderText(t, "Run is available until provider settings or API key changes.");
}

export function providerLastCheckLabel(provider: ProviderPreset, t?: ProviderTranslate): string {
  if (!provider.lastCheck) {
    return translateProviderText(t, "unchecked");
  }
  return provider.lastCheck.ok ? translateProviderText(t, "check ready") : providerCheckStatusLabel(provider.lastCheck, t);
}

export function providerLastCheckClass(provider: ProviderPreset): string {
  if (!provider.lastCheck) {
    return "provider-state check-unknown";
  }
  return provider.lastCheck.ok ? "provider-state check-ok" : "provider-state check-bad";
}

export function providerLastCheckTitle(provider: ProviderPreset, t?: ProviderTranslate): string {
  if (!provider.lastCheck) {
    return translateProviderText(t, "Provider has not been checked yet.");
  }
  return `${providerCheckMessage(provider.lastCheck, t)} (${provider.lastCheck.checkedAt})`;
}

export function secretRefSetupGuidance(_ref: string | undefined, t?: ProviderTranslate): string {
  return translateProviderText(t, "Paste an API key in Model Workbench, then Save.");
}

export function providerTemplateKindLabel(template: ProviderTemplate): string {
  if (template.api === "media-job") {
    return "media";
  }
  if (template.kind === "openai" || template.kind === "anthropic") {
    return "global";
  }
  if (template.kind === "openai-compatible") {
    return template.templateId.includes("local") || template.providerId.includes("relay") ? "relay" : "custom";
  }
  return "domestic";
}

export function groupProviderTemplates(templates: readonly ProviderTemplate[]): readonly ProviderTemplateGroup[] {
  const groups: ProviderTemplateGroup[] = [
    { label: "GPT", templates: templates.filter((template) => template.kind === "openai" || template.providerId === "openai") },
    { label: "Claude", templates: templates.filter((template) => template.kind === "anthropic" || template.providerId === "anthropic") },
    { label: "Custom access", templates: templates.filter((template) => providerTemplateKindLabel(template) === "custom") },
    { label: "Domestic AI", templates: templates.filter((template) => providerTemplateKindLabel(template) === "domestic") },
    { label: "Media", templates: templates.filter((template) => providerTemplateKindLabel(template) === "media") },
  ];
  return groups.filter((group) => group.templates.length > 0);
}

export function providerCheckStatusLabel(result: ProviderCheckResult, t?: ProviderTranslate): string {
  if (result.ok) {
    return translateProviderText(t, "ready");
  }
  if (result.code === "secret_missing") {
    return translateProviderText(t, "API key missing");
  }
  if (result.code === "secret_store_unavailable") {
    return translateProviderText(t, "key unavailable");
  }
  if (result.code === "network_failed") {
    return translateProviderText(t, "network failed");
  }
  if (result.code === "auth_failed") {
    return translateProviderText(t, "auth failed");
  }
  if (result.code === "model_unsupported") {
    return translateProviderText(t, "model unsupported");
  }
  if (result.code === "provider_disabled") {
    return translateProviderText(t, "disabled");
  }
  return result.code ? translateProviderText(t, result.code) : translateProviderText(t, "failed");
}

export function providerCheckMessage(result: ProviderCheckResult, t?: ProviderTranslate): string {
  if (result.ok) {
    return translateProviderText(t, result.message);
  }
  if (result.code === "secret_missing" || result.code === "secret_store_unavailable") {
    return translateProviderText(t, "API key missing. Add an API key before running a live check.");
  }
  if (result.code === "auth_failed") {
    return translateProviderText(t, "Invalid API key.");
  }
  if (result.code === "network_failed") {
    return translateProviderText(t, "Provider network check failed. Check Base URL, proxy, and local relay status.");
  }
  if (result.code === "model_unsupported") {
    return translateProviderText(t, "The configured model is not available from this endpoint.");
  }
  if (result.code === "provider_disabled") {
    return translateProviderText(t, "Provider preset is disabled.");
  }
  if (result.code === "unsupported_capability") {
    return translateProviderText(t, "Provider preset cannot run chat tasks.");
  }
  return translateProviderText(t, result.message);
}

export function providerCheckGuidance(result: ProviderCheckResult, provider: ProviderPreset | undefined, t?: ProviderTranslate): string {
  if (result.ok) {
    return translateProviderText(t, "Ready for run. You can select this preset from Workspace or a channel.");
  }

  if (result.code === "secret_missing" || result.code === "secret_store_unavailable") {
    return translateProviderText(t, "Paste an API key, then click Save.");
  }
  if (result.code === "auth_failed") {
    return translateProviderText(t, "Verify the key, account access, balance, and model permission for this provider.");
  }
  if (result.code === "network_failed") {
    return translateProviderText(t, "Check proxy, Base URL, local relay status, and outbound network access from the daemon.");
  }
  if (result.code === "model_unsupported") {
    return translateProviderText(t, "Check the model name, API protocol, and Base URL path for this provider.");
  }
  if (result.code === "provider_disabled") {
    return translateProviderText(t, "Enable the preset before using it for runs.");
  }
  if (result.code === "unsupported_capability") {
    return translateProviderText(t, "This preset needs chat capability before it can run coding tasks.");
  }
  if (result.code === "rate_limited") {
    return translateProviderText(t, "The endpoint is reachable. Wait or switch credentials, then run Check again.");
  }
  return translateProviderText(t, "Inspect the provider response, then verify Base URL, API protocol, and model configuration.");
}

export function extractEnvRef(text: string): string | undefined {
  return text.match(/(?:env|keychain):[A-Za-z0-9._/-]+/)?.[0];
}

function translateProviderText(
  t: ProviderTranslate | undefined,
  key: string,
  values?: Readonly<Record<string, string | number>>,
): string {
  if (t) {
    return t(key, values);
  }
  if (!values) {
    return key;
  }
  return key.replace(/\{([A-Za-z0-9_]+)\}/g, (match, valueKey) => {
    const value = values[valueKey];
    return value === undefined ? match : String(value);
  });
}
