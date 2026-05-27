import type {
  ProviderCheckResult,
  ProviderFormState,
  ProviderPreset,
  ProviderTemplate,
} from "../types.js";

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

export function providerToForm(provider: ProviderPreset): ProviderFormState {
  return {
    kind: provider.kind,
    displayName: provider.displayName,
    providerId: provider.providerId,
    model: provider.model,
    api: provider.api,
    baseUrl: provider.baseUrl ?? "",
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

export function providerTemplateToForm(template: ProviderTemplate): ProviderFormState {
  const isRunnableChatTemplate = template.api !== "media-job" && template.capabilities.includes("chat");
  return {
    kind: template.kind,
    displayName: template.displayName,
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

export function providerCodingTaskLabel(provider: ProviderPreset): string {
  const blocker = providerRunPreflightBlocker(provider);
  return blocker ? `blocked - ${blocker}` : "ready";
}

export function providerRunBlockerLabel(provider: ProviderPreset): string {
  if (!provider.enabled) {
    return "disabled";
  }
  if (provider.api === "media-job") {
    return "media job only";
  }
  if (!provider.capabilities.includes("chat")) {
    return "no chat";
  }
  if (!providerSecretReady(provider)) {
    return "API key missing";
  }
  return "not runnable";
}

export function providerRunPreflightBlocker(provider: ProviderPreset | undefined): string | undefined {
  if (!provider) {
    return "找不到 provider preset";
  }
  if (!canUseProviderForRun(provider)) {
    return `${provider.displayName}: ${providerRunBlockerLabel(provider)}.`;
  }
  if (!provider.lastCheck) {
    return `${provider.displayName}: provider has not been checked. Use Check run before starting.`;
  }
  if (!provider.lastCheck.ok) {
    return `${provider.displayName}: provider check failed (${providerCheckStatusLabel(provider.lastCheck)}). ${providerCheckGuidance(provider.lastCheck, provider)}`;
  }
  return undefined;
}

export function providerPreflightReady(provider: ProviderPreset): boolean {
  return providerRunPreflightBlocker(provider) === undefined;
}

export function taskProviderReadinessMessage(provider: ProviderPreset | undefined, blocker: string | undefined): string {
  if (!provider) {
    return "No provider preset is selected for this task run.";
  }
  if (!blocker) {
    return `${provider.displayName} passed the last provider check and can run this task.`;
  }
  return blocker;
}

export function taskProviderReadinessGuidance(provider: ProviderPreset | undefined): string {
  if (!provider) {
    return "Select a provider preset or set one as the channel default.";
  }
  if (!canUseProviderForRun(provider)) {
    return providerNeedsSecret(provider) && !provider.apiKeyConfigured
      ? "Add an API key in Model Workbench, then Save & Check."
      : "Open Model Workbench to enable a chat-capable preset before running.";
  }
  if (!provider.lastCheck) {
    return "Use Save & Check to validate the API key, base URL, and model access before starting.";
  }
  if (!provider.lastCheck.ok) {
    return providerCheckGuidance(provider.lastCheck, provider);
  }
  return "Run is available until provider settings or API key changes.";
}

export function providerLastCheckLabel(provider: ProviderPreset): string {
  if (!provider.lastCheck) {
    return "unchecked";
  }
  return provider.lastCheck.ok ? "check ready" : providerCheckStatusLabel(provider.lastCheck);
}

export function providerLastCheckClass(provider: ProviderPreset): string {
  if (!provider.lastCheck) {
    return "provider-state check-unknown";
  }
  return provider.lastCheck.ok ? "provider-state check-ok" : "provider-state check-bad";
}

export function providerLastCheckTitle(provider: ProviderPreset): string {
  if (!provider.lastCheck) {
    return "Provider has not been checked yet.";
  }
  return `${provider.lastCheck.message} (${provider.lastCheck.checkedAt})`;
}

export function envNameFromRef(ref: string): string {
  return ref.startsWith("env:") ? ref.slice("env:".length) : ref;
}

export function secretRefName(ref: string): string {
  if (ref.startsWith("env:")) {
    return ref.slice("env:".length);
  }
  if (ref.startsWith("keychain:")) {
    return ref.slice("keychain:".length);
  }
  return ref;
}

export function secretRefMissingLabel(ref: string): string {
  return ref.startsWith("keychain:") ? `missing keychain:${secretRefName(ref)}` : `missing ${envNameFromRef(ref)}`;
}

export function secretRefSetupGuidance(ref: string | undefined): string {
  if (!ref) {
    return "Paste an API key in Model Workbench, then Save & Check.";
  }
  if (ref.startsWith("local:")) {
    return "Paste an API key in Model Workbench, then Save & Check.";
  }
  if (ref.startsWith("keychain:")) {
    return `Configure ${ref} in the desktop keychain boundary, then run Check.`;
  }
  return `Set ${envNameFromRef(ref)}, restart daemon, then run Check.`;
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
    { label: "GPT / Claude", templates: templates.filter((template) => providerTemplateKindLabel(template) === "global") },
    { label: "OpenAI-compatible relay", templates: templates.filter((template) => providerTemplateKindLabel(template) === "relay") },
    { label: "Custom access", templates: templates.filter((template) => providerTemplateKindLabel(template) === "custom") },
    { label: "Domestic AI", templates: templates.filter((template) => providerTemplateKindLabel(template) === "domestic") },
    { label: "Media", templates: templates.filter((template) => providerTemplateKindLabel(template) === "media") },
  ];
  return groups.filter((group) => group.templates.length > 0);
}

export function providerCheckStatusLabel(result: ProviderCheckResult): string {
  if (result.ok) {
    return "ready";
  }
  if (result.code === "secret_missing") {
    return "API key missing";
  }
  if (result.code === "secret_store_unavailable") {
    return "keychain unavailable";
  }
  if (result.code === "network_failed") {
    return "network failed";
  }
  if (result.code === "auth_failed") {
    return "auth failed";
  }
  if (result.code === "model_unsupported") {
    return "model unsupported";
  }
  if (result.code === "provider_disabled") {
    return "disabled";
  }
  return result.code ?? "failed";
}

export function providerCheckGuidance(result: ProviderCheckResult, provider: ProviderPreset | undefined): string {
  if (result.ok) {
    return "Ready for run. You can select this preset from Workspace or a channel.";
  }

  if (result.code === "secret_missing" || result.code === "secret_store_unavailable") {
    return "Paste an API key, then click Save & Check. Advanced users can set env:NAME or keychain:NAME.";
  }
  if (result.code === "auth_failed") {
    return "Verify the key, account access, balance, and model permission for this provider.";
  }
  if (result.code === "network_failed") {
    return "Check proxy, base URL, local relay status, and outbound network access from the daemon.";
  }
  if (result.code === "model_unsupported") {
    return "Check the model name, API protocol, and base URL path for this provider.";
  }
  if (result.code === "provider_disabled") {
    return "Enable the preset before using it for runs.";
  }
  if (result.code === "unsupported_capability") {
    return "This preset needs chat capability before it can run coding tasks.";
  }
  if (result.code === "rate_limited") {
    return "The endpoint is reachable. Wait or switch credentials, then run Check again.";
  }
  return "Inspect the provider response, then verify base URL, API protocol, and model configuration.";
}

export function extractEnvRef(text: string): string | undefined {
  return text.match(/(?:env|keychain):[A-Za-z0-9._/-]+/)?.[0];
}
