import type {
  ProviderCheckResult,
  ProviderFormState,
  ProviderModelOption,
  ProviderPreset,
  ProviderTemplate,
} from "../types.js";
import {
  filterChatModelOptions as filterCoreChatModelOptions,
  filterMediaModelOptions as filterCoreMediaModelOptions,
  isMediaOnlyModelId,
  mediaModelKind,
  providerMediaKind,
} from "@ling-stack/core/provider-adapters";
import {
  resolveProviderModelCapabilitySnapshot,
  type ProviderModelCapabilitySnapshot,
} from "@ling-stack/core/provider-model-capabilities";

type ProviderTranslate = (key: string, values?: Readonly<Record<string, string | number>>) => string;

export interface ProviderTemplateGroup {
  readonly label: string;
  readonly templates: readonly ProviderTemplate[];
}

export type ProviderCapabilityUiState = "auto" | "estimated" | "conservative" | "custom_override";
type ProviderCapabilityUiInput =
  | ProviderPreset
  | Pick<ProviderFormState, "api" | "kind" | "providerId" | "model" | "contextWindow" | "maxTokens" | "capabilitiesText">;
type ProviderCapabilityPresetInput = Pick<ProviderPreset, "id" | "api" | "kind" | "providerId" | "model" | "contextWindow" | "maxTokens" | "capabilities">;

export const defaultProviderForm: ProviderFormState = {
  kind: "openai-compatible",
  displayName: "Local Relay",
  providerId: "local-relay",
  model: "gpt-5.5",
  api: "openai-completions",
  providerTransport: "",
  baseUrl: "http://127.0.0.1:8317/v1",
  apiKey: "",
  apiKeyRef: "",
  clearApiKey: false,
  capabilitiesText: "chat,tool_call,reasoning",
  inputText: "text",
  enabled: true,
  authHeader: true,
  reasoning: true,
  contextWindow: "",
  maxTokens: "",
};

export const customOpenAICompatibleForm: ProviderFormState = {
  kind: "openai-compatible",
  displayName: "Custom OpenAI-compatible",
  providerId: "custom-openai-compatible",
  model: "your-model-id",
  api: "openai-completions",
  providerTransport: "",
  baseUrl: "https://api.example.com/v1",
  apiKey: "",
  apiKeyRef: "",
  clearApiKey: false,
  capabilitiesText: "chat,tool_call,reasoning",
  inputText: "text",
  enabled: true,
  authHeader: true,
  reasoning: true,
  contextWindow: "",
  maxTokens: "",
};

export function deriveProviderCapabilityUiState(
  provider: ProviderCapabilityUiInput,
  templates: readonly ProviderTemplate[] = [],
): ProviderCapabilityUiState {
  if (providerHasManualCapabilityOverride(provider)) {
    return "custom_override";
  }
  const snapshot = resolveProviderModelCapabilitySnapshot(providerCapabilityInputToPreset(provider), { templates });
  return providerCapabilitySnapshotToUiState(snapshot);
}

export function providerCapabilityUiStateLabel(state: ProviderCapabilityUiState): string {
  if (state === "auto") {
    return "Provider capability auto";
  }
  if (state === "estimated") {
    return "Provider capability estimated";
  }
  if (state === "conservative") {
    return "Provider capability conservative";
  }
  return "Provider capability custom override";
}

export function providerCapabilityUiStateDescription(state: ProviderCapabilityUiState): string {
  if (state === "auto") {
    return "Ling uses known provider or template capabilities automatically.";
  }
  if (state === "estimated") {
    return "Ling estimates a safe context profile for this provider family.";
  }
  if (state === "conservative") {
    return "Unknown compatible models use conservative defaults unless overridden.";
  }
  return "Advanced model limit overrides are active for this preset.";
}

function providerHasManualCapabilityOverride(provider: ProviderCapabilityUiInput): boolean {
  if ("capabilitiesText" in provider) {
    return provider.contextWindow.trim().length > 0 || provider.maxTokens.trim().length > 0;
  }
  return provider.contextWindow !== undefined || provider.maxTokens !== undefined;
}

function providerCapabilityInputToPreset(provider: ProviderCapabilityUiInput): ProviderCapabilityPresetInput {
  if ("capabilitiesText" in provider) {
    return {
      id: "provider_form_preview",
      api: provider.api,
      kind: provider.kind,
      providerId: provider.providerId,
      model: provider.model,
      contextWindow: providerLimitOverride(provider.contextWindow),
      maxTokens: providerLimitOverride(provider.maxTokens),
      capabilities: splitProviderCsv(provider.capabilitiesText) as ProviderPreset["capabilities"],
    };
  }
  return provider;
}

function providerCapabilitySnapshotToUiState(snapshot: ProviderModelCapabilitySnapshot): ProviderCapabilityUiState {
  if (snapshot.source === "user_override") {
    return "custom_override";
  }
  if (snapshot.source === "non_chat") {
    return "auto";
  }
  if (snapshot.source === "conservative_default" || snapshot.confidence === "conservative") {
    return "conservative";
  }
  if (snapshot.confidence === "estimated") {
    return "estimated";
  }
  return "auto";
}

function providerLimitOverride(value: string): number | undefined {
  const trimmedValue = value.trim();
  if (!trimmedValue) {
    return undefined;
  }
  const parsedValue = Number(trimmedValue);
  return Number.isInteger(parsedValue) && parsedValue > 0 ? parsedValue : undefined;
}

export function providerToForm(provider: ProviderPreset, templates: readonly ProviderTemplate[] = []): ProviderFormState {
  return {
    kind: provider.kind,
    displayName: provider.displayName,
    providerId: provider.providerId,
    model: provider.model,
    api: provider.api,
    providerTransport: provider.providerTransport ?? "",
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

export function providerMatchingTemplate(
  provider: Pick<ProviderPreset, "api" | "kind" | "providerId">,
  templates: readonly ProviderTemplate[],
): ProviderTemplate | undefined {
  return (
    templates.find((template) => template.providerId === provider.providerId && template.kind === provider.kind && template.api === provider.api) ??
    templates.find((template) => template.providerId === provider.providerId && template.kind === provider.kind) ??
    templates.find((template) => template.kind === provider.kind && template.api === provider.api)
  );
}

function providerTemplateBaseUrl(
  provider: Pick<ProviderPreset, "api" | "kind" | "providerId">,
  templates: readonly ProviderTemplate[],
): string {
  const matchingTemplate = providerMatchingTemplate(provider, templates);
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
    providerTransport: template.providerTransport ?? "",
    baseUrl: template.baseUrl ?? "",
    apiKey: "",
    apiKeyRef: "",
    clearApiKey: false,
    capabilitiesText: template.capabilities.join(", "),
    inputText: (template.input ?? ["text"]).join(", "),
    enabled: isRunnableChatTemplate ? true : template.enabled ?? false,
    authHeader: template.authHeader ?? true,
    reasoning: template.reasoning ?? false,
    contextWindow: "",
    maxTokens: "",
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
    providerTransport: form.providerTransport || undefined,
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

export function providerFormWithSelectedModel(
  form: ProviderFormState,
  model: Pick<ProviderModelOption, "id" | "displayName">,
  sourceForm?: ProviderFormState,
): { readonly form: ProviderFormState; readonly notice?: string } {
  const mediaMatch = inferMediaModelProtocol(model.id);
  if (!mediaMatch) {
    if (sourceForm && form.api === "media-job") {
      return {
        form: { ...sourceForm, model: model.id },
        notice: "Selected a chat model. API protocol was restored to the source provider.",
      };
    }
    return { form: { ...form, model: model.id } };
  }

  return {
    form: {
      ...form,
      kind: mediaMatch.kind,
      displayName: shouldReplaceProviderDisplayName(form.displayName, form.providerId)
        ? mediaMatch.displayName
        : form.displayName,
      providerId: mediaMatch.providerId,
      model: model.id,
      api: "media-job",
      providerTransport: "",
      baseUrl: form.baseUrl || mediaMatch.baseUrl,
      capabilitiesText: mediaMatch.capabilitiesText,
      inputText: mediaMatch.inputText,
      reasoning: false,
      contextWindow: "",
      maxTokens: "",
      enabled: true,
      authHeader: true,
    },
    notice: "Selected a media model. API protocol was switched to Media job automatically.",
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

export function canWorkbenchBatchCheckProvider(provider: ProviderPreset): boolean {
  return provider.enabled;
}

export function isWorkbenchReadyProvider(provider: ProviderPreset): boolean {
  return provider.enabled && providerSecretReady(provider) && provider.lastCheck?.ok === true;
}

export function isWorkbenchNeedsConfigProvider(provider: ProviderPreset): boolean {
  return provider.enabled && !isWorkbenchReadyProvider(provider);
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

export function isLiveMediaProvider(provider: ProviderPreset): boolean {
  return (
    isMediaProvider(provider) &&
    provider.enabled &&
    providerSecretReady(provider) &&
    isRecord(provider.compat) &&
    isRecord(provider.compat.mediaVendorTransport) &&
    provider.compat.mediaVendorTransport.mode === "live"
  );
}

export function canUseMediaProviderForOperation(
  provider: ProviderPreset,
  operation: "image_generate" | "image_edit" | "video_generate",
): boolean {
  if (!isLiveMediaProvider(provider) || !provider.capabilities.includes(operation)) {
    return false;
  }
  return provider.kind === "seedream" && operation === "image_generate";
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

function inferMediaModelProtocol(modelId: string): {
  readonly kind: ProviderFormState["kind"];
  readonly displayName: string;
  readonly providerId: string;
  readonly baseUrl: string;
  readonly capabilitiesText: string;
  readonly inputText: string;
} | undefined {
  const kind = mediaModelKind(modelId);
  if (kind === "seedream") {
    return {
      kind: "seedream",
      displayName: "Seedream Image",
      providerId: "seedream",
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      capabilitiesText: "image_generate, image_edit",
      inputText: "text, image",
    };
  }
  if (kind === "seedance") {
    return {
      kind: "seedance",
      displayName: "Seedance Video",
      providerId: "seedance",
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      capabilitiesText: "video_generate",
      inputText: "text, image",
    };
  }
  if (kind === "jimeng") {
    return {
      kind: "jimeng",
      displayName: "Jimeng Image",
      providerId: "jimeng",
      baseUrl: "https://visual.volcengineapi.com",
      capabilitiesText: "image_generate, image_edit",
      inputText: "text, image",
    };
  }
  return undefined;
}

export function isMediaModelOption(model: Pick<ProviderModelOption, "id">): boolean {
  return isMediaOnlyModelId(model.id);
}

export function filterChatModelOptions(models: readonly ProviderModelOption[]): readonly ProviderModelOption[] {
  return filterCoreChatModelOptions(models);
}

export function filterMediaModelOptions(
  models: readonly ProviderModelOption[],
  form: Pick<ProviderFormState, "kind" | "providerId">,
): readonly ProviderModelOption[] {
  return filterCoreMediaModelOptions(models, providerMediaKind(form));
}

export function hiddenNonMatchingMediaModelCount(
  models: readonly ProviderModelOption[],
  form: Pick<ProviderFormState, "kind" | "providerId">,
): number {
  const mediaCount = models.filter(isMediaModelOption).length;
  return mediaCount - filterMediaModelOptions(models, form).length;
}

function shouldReplaceProviderDisplayName(displayName: string, providerId: string): boolean {
  const value = `${displayName} ${providerId}`.toLowerCase();
  return (
    !displayName.trim() ||
    value.includes("doubao") ||
    value.includes("ark") ||
    value.includes("custom") ||
    value.includes("openai-compatible")
  );
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
  if (result.code === "model_api_mismatch") {
    return translateProviderText(t, "protocol mismatch");
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
  if (result.code === "model_api_mismatch") {
    return translateProviderText(t, result.message);
  }
  if (result.code === "provider_disabled") {
    return translateProviderText(t, "Provider preset is disabled.");
  }
  if (result.code === "unsupported_capability") {
    return translateProviderText(t, "Provider preset cannot run chat tasks.");
  }
  return translateProviderText(t, result.message);
}

export function providerCheckDisplayMessage(result: ProviderCheckResult, provider: Pick<ProviderPreset, "api"> | undefined, t?: ProviderTranslate): string {
  return providerCheckMessage(result, t);
}

export function providerCheckDisplayGuidance(result: ProviderCheckResult, provider: Pick<ProviderPreset, "api"> | undefined, t?: ProviderTranslate): string {
  if (result.ok && provider?.api === "media-job") {
    return "";
  }
  return providerCheckGuidance(result, provider, t);
}

export function providerCheckGuidance(result: ProviderCheckResult, provider: Pick<ProviderPreset, "api"> | undefined, t?: ProviderTranslate): string {
  if (result.ok) {
    if (provider?.api === "media-job") {
      return translateProviderText(t, "Media job configuration is ready. Use this provider from Media Jobs.");
    }
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
  if (result.code === "model_api_mismatch") {
    return translateProviderText(t, "Switch the API protocol to Media job, or choose a chat model for this provider.");
  }
  if (result.code === "provider_disabled") {
    return translateProviderText(t, "Enable the preset before using it for runs.");
  }
  if (result.code === "unsupported_capability") {
    return translateProviderText(t, "This preset needs chat capability before it can run coding tasks.");
  }
  if (result.code === "unsupported_live_probe") {
    return translateProviderText(t, "This media provider cannot run a real check yet. Use a supported Seedream or Seedance media template, or configure the model from Media Jobs.");
  }
  if (result.code === "rate_limited") {
    return translateProviderText(t, "The endpoint is reachable. Wait or switch credentials, then run Check again.");
  }
  return translateProviderText(t, "Inspect the provider response, then verify Base URL, API protocol, and model configuration.");
}

export function extractEnvRef(text: string): string | undefined {
  return text.match(/(?:env|keychain):[A-Za-z0-9._/-]+/)?.[0];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
