import type {
  ProviderCheckResult,
  ProviderFormState,
  ProviderModelOption,
  ProviderPreset,
  ProviderTemplate,
} from "../types.js";
import {
  filterChatModelOptions as filterCoreChatModelOptions,
  isMediaOnlyModelId,
  mediaModelKind,
} from "@ling-stack/core/provider-adapters";
import { inferGenerationModelFamily } from "@ling-stack/core/provider-generation-models";
import { resolveGenerationProviderRuntimeState } from "@ling-stack/core/provider-media-normalization";
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
type GenerationOperation = "image_generate" | "image_edit" | "video_generate";

const generationCapabilities = new Set<GenerationOperation>(["image_generate", "image_edit", "video_generate"]);
const generationOperations: readonly GenerationOperation[] = ["image_generate", "image_edit", "video_generate"];

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
  secretHeaderRefsText: "",
  capabilitiesText: "chat,tool_call,reasoning",
  inputText: "text",
	  enabled: true,
	  authHeader: true,
	  reasoning: true,
	  thinkingModes: ["off", "minimal", "low", "medium", "high", "xhigh"],
	  contextWindow: "",
	  maxTokens: "",
	};

export const customOpenAICompatibleForm: ProviderFormState = {
  kind: "openai-compatible",
  displayName: "Custom",
  providerId: "custom-openai-compatible",
  model: "your-model-id",
  api: "openai-completions",
  providerTransport: "",
  baseUrl: "https://api.example.com/v1",
  apiKey: "",
  apiKeyRef: "",
  clearApiKey: false,
  secretHeaderRefsText: "",
	  capabilitiesText: "chat,tool_call",
	  inputText: "text",
	  enabled: true,
	  authHeader: true,
	  reasoning: false,
	  thinkingModes: [],
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
    secretHeaderRefsText: formatSecretHeaderRefs(provider.secretHeaderRefs),
    capabilitiesText: provider.capabilities.join(", "),
    inputText: provider.input.join(", "),
	    enabled: provider.enabled,
	    authHeader: provider.authHeader ?? true,
	    reasoning: provider.reasoning ?? false,
	    thinkingModes: provider.thinkingModes ?? [],
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
    secretHeaderRefsText: formatSecretHeaderRefs(template.secretHeaderRefs ?? {}),
    capabilitiesText: template.capabilities.join(", "),
    inputText: (template.input ?? ["text"]).join(", "),
	    enabled: template.capabilities.includes("chat") && template.api !== "media-job" ? true : template.enabled ?? false,
	    authHeader: template.authHeader ?? true,
	    reasoning: template.reasoning ?? false,
	    thinkingModes: template.thinkingModes ?? (template.reasoning ? ["off", "minimal", "low", "medium", "high", "xhigh"] : []),
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
    secretHeaderRefs: formatSecretHeaderRefsInput(form.secretHeaderRefsText),
    authHeader: form.authHeader,
	    reasoning: form.reasoning,
	    thinkingModes: form.thinkingModes,
	    input: splitProviderCsv(form.inputText) as ProviderTemplate["input"],
    contextWindow: form.contextWindow ? Number(form.contextWindow) : undefined,
    maxTokens: form.maxTokens ? Number(form.maxTokens) : undefined,
    compat: {},
    capabilities: splitProviderCsv(form.capabilitiesText) as ProviderTemplate["capabilities"],
    enabled: form.enabled,
  };
}

function formatSecretHeaderRefs(refs: Record<string, string> | undefined): string {
  return Object.entries(refs ?? {})
    .map(([headerName, ref]) => `${headerName}: ${ref}`)
    .join("\n");
}

function formatSecretHeaderRefsInput(value: string): Record<string, string> | undefined {
  const refs = Object.fromEntries(
    value
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .map((line) => {
        const separator = line.includes(":") ? line.indexOf(":") : line.indexOf("=");
        if (separator <= 0) {
          return [line, ""] as const;
        }
        return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()] as const;
      }),
  );
  return Object.keys(refs).length > 0 ? refs : undefined;
}

export function providerFormWithSelectedModel(
  form: ProviderFormState,
  model: ProviderModelOption,
  sourceForm?: ProviderFormState,
): { readonly form: ProviderFormState; readonly notice?: string } {
  const baseForm = sourceForm ?? form;
	  const nextForm = {
	    ...baseForm,
	    model: model.id,
	    api: model.api ?? baseForm.api,
	    capabilitiesText: model.capabilities?.length ? model.capabilities.join(", ") : baseForm.capabilitiesText,
	    inputText: model.input?.length ? model.input.join(", ") : baseForm.inputText,
	    reasoning: model.thinkingModes?.some((mode) => mode !== "off") ?? baseForm.reasoning,
	    thinkingModes: model.thinkingModes ?? baseForm.thinkingModes,
	    contextWindow: model.contextWindow ? String(model.contextWindow) : baseForm.contextWindow,
	    maxTokens: model.maxTokens ? String(model.maxTokens) : baseForm.maxTokens,
	  };
  if (sourceForm) {
    return { form: nextForm };
  }
  return { form: nextForm };
}

export function normalizeProviderModelForImport(
  model: ProviderModelOption,
  form: Pick<ProviderFormState, "api" | "kind" | "providerId" | "capabilitiesText" | "inputText">,
): ProviderModelOption {
  const generationFamily = inferGenerationModelFamily(model.id, form);
  if (generationFamily) {
    return {
      ...model,
      ownedBy: model.ownedBy ?? generationFamily.ownedBy,
      api: model.api ?? generationFamily.api,
      input: model.input?.length ? model.input : generationFamily.input,
      capabilities: model.capabilities?.length ? model.capabilities : generationFamily.capabilities,
      supportedParameters: model.supportedParameters?.length ? model.supportedParameters : generationFamily.supportedParameters,
      capabilitySource: model.capabilitySource ?? generationFamily.capabilitySource,
      capabilityConfidence: model.capabilityConfidence ?? generationFamily.capabilityConfidence,
    };
  }
	  if (
	    model.capabilities?.length ||
	    model.api ||
	    model.input?.length ||
	    model.thinkingModes?.length ||
	    model.contextWindow ||
	    model.maxTokens ||
	    model.supportedParameters?.length ||
	    model.thinkingSupport
	  ) {
	    return model;
	  }
  const knownGenerationKind = mediaModelKind(model.id);
  if (!knownGenerationKind) {
    return model;
  }
  const capabilities: GenerationOperation[] =
    knownGenerationKind === "seedance" ? ["video_generate"] : ["image_generate", "image_edit"];
  return {
    ...model,
    api: "media-job",
    input: ["text", "image"],
    capabilities,
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

export function canUseConversationProvider(provider: ProviderPreset): boolean {
  if (!canUseProviderForRun(provider)) {
    return false;
  }
  if (providerHasGenerationCapability(provider)) {
    return false;
  }
  return inferGenerationModelFamily(provider.model, {
    kind: provider.kind,
    providerId: provider.providerId,
    api: provider.api,
  }) === undefined;
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

export function providerHasGenerationCapability(provider: Pick<ProviderPreset, "capabilities">): boolean {
  return provider.capabilities.some((capability) => generationCapabilities.has(capability as GenerationOperation));
}

export function providerSupportsGenerationOperation(
  provider: Pick<ProviderPreset, "capabilities">,
  operation: GenerationOperation,
): boolean {
  return provider.capabilities.includes(operation);
}

export function isLiveMediaProvider(provider: ProviderPreset): boolean {
  return resolveGenerationProviderRuntimeState(provider).canRun;
}

export function canUseMediaProviderForOperation(
  provider: ProviderPreset,
  operation: GenerationOperation,
): boolean {
  return resolveGenerationProviderRuntimeState(provider, operation).canRun;
}

export const canUseGenerationProviderForOperation = canUseMediaProviderForOperation;

export function providerSecretStatusLabel(provider: ProviderPreset, t?: ProviderTranslate): string {
  if (!providerNeedsSecret(provider)) {
    return translateProviderText(t, "no key required");
  }
  if (!provider.apiKeyConfigured) {
    if (provider.apiKeyRef?.startsWith("keychain:")) {
      return translateProviderText(t, "keychain secret missing");
    }
    return translateProviderText(t, "API key missing");
  }
  if (provider.apiKeyRef?.startsWith("keychain:")) {
    return translateProviderText(t, "keychain ready");
  }
  if (provider.apiKeyRef?.startsWith("env:")) {
    return translateProviderText(t, "env key ready");
  }
  return translateProviderText(t, "key ready");
}

export function providerSecretStatusClass(provider: ProviderPreset): string {
  if (!providerNeedsSecret(provider)) {
    return "provider-state check-unknown";
  }
  return provider.apiKeyConfigured ? "provider-state key-ok" : "provider-state key-missing";
}

export function providerSecretHeaderSummary(provider: ProviderPreset, t?: ProviderTranslate): string | undefined {
  const entries = Object.entries(provider.secretHeaderRefs ?? {});
  if (entries.length === 0) {
    return undefined;
  }
  const configuredCount = entries.length;
  const keychainCount = entries.filter(([, ref]) => ref.startsWith("keychain:")).length;
  const envCount = entries.filter(([, ref]) => ref.startsWith("env:")).length;
  return translateProviderText(t, "{count} secret headers configured · env {envCount} · keychain {keychainCount}", {
    count: configuredCount,
    envCount,
    keychainCount,
  });
}

export function providerGenerationRuntimeSummary(provider: ProviderPreset, t?: ProviderTranslate): string | undefined {
  if (!providerHasGenerationCapability(provider)) {
    return undefined;
  }
  const operations = generationOperations.filter((operation) => canUseGenerationProviderForOperation(provider, operation));
  if (operations.length === 0) {
    const state = resolveGenerationProviderRuntimeState(provider);
    if (state.reason === "secret_missing") {
      return translateProviderText(t, "Real generation: API key missing");
    }
    if (state.reason === "base_url_missing") {
      return translateProviderText(t, "Real generation: Base URL missing");
    }
    return translateProviderText(t, "Real generation is not connected yet.");
  }
  return translateProviderText(t, "Real generation: {operations}", {
    operations: operations.map((operation) => providerGenerationOperationLabel(operation, t)).join(" / "),
  });
}

function providerGenerationOperationLabel(operation: GenerationOperation, t?: ProviderTranslate): string {
  if (operation === "image_generate") {
    return translateProviderText(t, "image generate");
  }
  if (operation === "image_edit") {
    return translateProviderText(t, "URL image edit");
  }
  return translateProviderText(t, "final video");
}

export function providerModelRouteLabel(
  provider: ProviderPreset,
  templates: readonly ProviderTemplate[] = [],
): string {
  const routeLabel = providerRouteShortLabel(provider, templates);
  return routeLabel ? `${provider.model} · ${routeLabel}` : provider.model;
}

export function providerRouteShortLabel(
  provider: Pick<ProviderPreset, "api" | "baseUrl" | "displayName" | "kind" | "model" | "providerId">,
  templates: readonly ProviderTemplate[] = [],
): string {
  const endpointHost = providerEndpointHost(providerEffectiveBaseUrl(provider, templates));
  if (endpointHost) {
    return endpointHost;
  }
  const providerId = provider.providerId.trim();
  if (providerId) {
    return providerId;
  }
  return providerDisplaySourceLabel(provider.displayName, provider.model);
}

export function providerCapabilityChipLabels(
  provider: Pick<ProviderPreset, "capabilities"> | Pick<ProviderModelOption, "id" | "capabilities">,
  t?: ProviderTranslate,
): readonly string[] {
  const capabilities: readonly string[] = "capabilities" in provider && provider.capabilities?.length
    ? provider.capabilities
    : isMediaOnlyModelId("id" in provider ? provider.id : undefined)
      ? inferredGenerationCapabilities("id" in provider ? provider.id : undefined)
      : [];
  const labels: string[] = [];
  if (capabilities.includes("chat")) {
    labels.push(translateProviderText(t, "chat capability"));
  }
  if (capabilities.includes("tool_call")) {
    labels.push(translateProviderText(t, "tool capability"));
  }
  if (capabilities.includes("reasoning")) {
    labels.push(translateProviderText(t, "reasoning capability"));
  }
  if (capabilities.includes("web_search")) {
    labels.push(translateProviderText(t, "web search capability"));
  }
  if (capabilities.includes("image_generate") || capabilities.includes("image_edit")) {
    labels.push(translateProviderText(t, "image capability"));
  }
  if (capabilities.includes("video_generate")) {
    labels.push(translateProviderText(t, "video capability"));
  }
  return labels.length > 0 ? labels : [translateProviderText(t, "unknown capability")];
}

function inferredGenerationCapabilities(modelId: string | undefined): readonly GenerationOperation[] {
  const generationFamily = inferGenerationModelFamily(modelId);
  if (generationFamily) {
    return generationFamily.capabilities.filter((capability): capability is GenerationOperation =>
      generationCapabilities.has(capability as GenerationOperation),
    );
  }
  const kind = mediaModelKind(modelId);
  if (kind === "seedance") {
    return ["video_generate"];
  }
  if (kind === "seedream" || kind === "jimeng") {
    return ["image_generate", "image_edit"];
  }
  return [];
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
    return translateProviderText(t, "not chat-capable");
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

export function sortProvidersForWorkbench(
  providers: readonly ProviderPreset[],
  defaultProviderId: string,
): readonly ProviderPreset[] {
  return [...providers].sort((left, right) => {
    const leftDefaultRank = left.id === defaultProviderId ? 0 : 1;
    const rightDefaultRank = right.id === defaultProviderId ? 0 : 1;
    if (leftDefaultRank !== rightDefaultRank) {
      return leftDefaultRank - rightDefaultRank;
    }
    const timeOrder = providerSortTime(right).localeCompare(providerSortTime(left));
    if (timeOrder !== 0) {
      return timeOrder;
    }
    return left.id.localeCompare(right.id);
  });
}

function providerSortTime(provider: Pick<ProviderPreset, "createdAt" | "updatedAt">): string {
  return provider.updatedAt || provider.createdAt || "";
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
  if (isDomesticProviderTemplate(template)) {
    return "domestic";
  }
  if (template.kind === "openai-compatible") {
    return template.templateId.includes("local") || template.providerId.includes("relay") ? "relay" : "custom";
  }
  return "supplier";
}

const domesticProviderTemplateIds = new Set([
  "alibaba-bailian",
  "baichuan",
  "baidu-qianfan",
  "deepseek",
  "doubao",
  "01ai",
  "glm",
  "minimax",
  "moonshot",
  "siliconflow",
  "stepfun",
  "tencent-hunyuan",
]);

function isDomesticProviderTemplate(template: ProviderTemplate): boolean {
  return (
    domesticProviderTemplateIds.has(template.providerId) ||
    template.kind === "doubao" ||
    template.kind === "deepseek" ||
    template.kind === "minimax" ||
    template.kind === "glm"
  );
}

export function groupProviderTemplates(templates: readonly ProviderTemplate[]): readonly ProviderTemplateGroup[] {
  const groups: ProviderTemplateGroup[] = [
    { label: "GPT", templates: templates.filter((template) => template.kind === "openai" || template.providerId === "openai") },
    { label: "Grok", templates: templates.filter((template) => template.providerId === "xai") },
    { label: "Gemini", templates: templates.filter((template) => template.kind === "google" || template.providerId === "google-gemini") },
    { label: "Claude", templates: templates.filter((template) => template.kind === "anthropic" || template.providerId === "anthropic") },
    {
      label: "Custom access",
      templates: templates.filter((template) => {
        const kindLabel = providerTemplateKindLabel(template);
        return (kindLabel === "custom" || kindLabel === "relay") && template.providerId !== "xai";
      }),
    },
    { label: "Domestic AI", templates: templates.filter((template) => providerTemplateKindLabel(template) === "domestic") },
    { label: "Media", templates: templates.filter((template) => providerTemplateKindLabel(template) === "media") },
  ];
  return groups.filter((group) => group.templates.length > 0);
}

export function isMediaModelOption(model: Pick<ProviderModelOption, "id">): boolean {
  return isMediaOnlyModelId(model.id);
}

export function filterChatModelOptions(models: readonly ProviderModelOption[]): readonly ProviderModelOption[] {
  return filterCoreChatModelOptions(models);
}

export function filterMediaModelOptions(
  models: readonly ProviderModelOption[],
  _form: Pick<ProviderFormState, "kind" | "providerId">,
): readonly ProviderModelOption[] {
  return models.filter(isMediaModelOption);
}

export function hiddenNonMatchingMediaModelCount(
  models: readonly ProviderModelOption[],
  form: Pick<ProviderFormState, "kind" | "providerId">,
): number {
  void form;
  return 0;
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
  if (result.ok && provider?.api === "media-job") {
    return translateProviderText(t, "Generation model configuration check passed.");
  }
  return providerCheckMessage(result, t);
}

export function providerCheckDisplayGuidance(result: ProviderCheckResult, provider: Pick<ProviderPreset, "api"> | undefined, t?: ProviderTranslate): string {
  if (result.ok && provider?.api === "media-job") {
    return translateProviderText(t, "Run Image Generation to create real results. This check does not create an image.");
  }
  return providerCheckGuidance(result, provider, t);
}

export function providerCheckGuidance(result: ProviderCheckResult, provider: Pick<ProviderPreset, "api"> | undefined, t?: ProviderTranslate): string {
  if (result.ok) {
    if (provider?.api === "media-job") {
      return translateProviderText(t, "Model is ready for generation tasks.");
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
    return translateProviderText(t, "Choose a protocol that matches this model capability, or select another model.");
  }
  if (result.code === "provider_disabled") {
    return translateProviderText(t, "Enable the preset before using it for runs.");
  }
  if (result.code === "unsupported_capability") {
    return translateProviderText(t, "This preset needs chat capability before it can run coding tasks.");
  }
  if (result.code === "unsupported_live_probe") {
    return translateProviderText(t, "This model cannot run a live generation check yet. Use a supported generation-capable supplier model.");
  }
  if (result.code === "rate_limited") {
    return translateProviderText(t, "The endpoint is reachable. Wait or switch credentials, then run Check again.");
  }
  return translateProviderText(t, "Inspect the provider response, then verify Base URL, API protocol, and model configuration.");
}

export function extractEnvRef(text: string): string | undefined {
  return text.match(/(?:env|keychain):[A-Za-z0-9._/-]+/)?.[0];
}

function providerEndpointHost(value: string): string {
  const trimmedValue = value.trim();
  if (!trimmedValue) {
    return "";
  }
  try {
    return new URL(trimmedValue).host;
  } catch {
    return "";
  }
}

function providerDisplaySourceLabel(displayName: string, model: string): string {
  const trimmedDisplayName = displayName.trim();
  const trimmedModel = model.trim();
  if (!trimmedDisplayName || !trimmedModel) {
    return trimmedDisplayName;
  }
  const suffixes = [` · ${trimmedModel}`, ` / ${trimmedModel}`, ` - ${trimmedModel}`];
  const matchingSuffix = suffixes.find((suffix) => trimmedDisplayName.toLowerCase().endsWith(suffix.toLowerCase()));
  return matchingSuffix
    ? trimmedDisplayName.slice(0, -matchingSuffix.length).trim()
    : trimmedDisplayName;
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
