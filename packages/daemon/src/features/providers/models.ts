import {
  builtinMediaModelCandidates,
  enrichProviderModelOption,
  normalizeProviderBaseUrlForAdapter,
  normalizeProviderThinkingModes,
  normalizeProviderThinkingSupport,
  providerModelCatalogInfo,
  providerMediaKind,
  providerApis,
  providerCapabilities,
  type ProviderApi,
  type ProviderCapability,
  type ProviderModelListRequest,
  type ProviderModelListResponse,
  type ProviderModelOption,
  type ProviderPreset,
  type ProviderThinkingSupport,
  type ProviderThinkingMode,
  type ProviderStoreFacet,
  type SecretResolver,
} from "@ling-stack/core";
import { HttpError } from "../../errors.js";
import { readLimitedResponseText } from "../../shared/http.js";
import { redactTextWithSecrets } from "../../shared/redaction.js";
import { isRecord, removeUndefined, validateUrl } from "../../shared/validation.js";
import {
  ProviderSecretMaterializationError,
  materializeProviderSecrets,
} from "./secret-materializer.js";
import { isLocalProviderSecretRef } from "./secrets.js";
import {
  createProviderModelDiscoveryRequest,
  providerModelDiscoveryItems,
  providerModelDiscoveryNeedsApiKey,
  providerModelDiscoveryNextPageToken,
  supportsProviderModelDiscovery,
} from "./model-discovery-adapters.js";

const PROVIDER_CHECK_TIMEOUT_MS = 10_000;
const PROVIDER_MODEL_DISCOVERY_LIMIT = 200;
const PROVIDER_MODEL_DISCOVERY_PAGE_LIMIT = 200;
const providerModelInputTypes = ["text", "image"] as const;

export async function listProviderModels(
  store: ProviderStoreFacet,
  input: ProviderModelListRequest,
  secretResolver: SecretResolver,
): Promise<ProviderModelListResponse> {
  const preset = providerModelListInputToPreset(store, input);
  if (preset.baseUrl) {
    validateUrl(preset.baseUrl, "baseUrl");
  }
  if (preset.api === "media-job") {
    return await listMediaProviderModels(store, preset, input, secretResolver);
  }
  if (!supportsProviderModelDiscovery(preset)) {
    throw new HttpError(400, "unsupported_capability", `Model discovery is not implemented for ${preset.api}.`);
  }
  const materialized = materializeProviderModelListSecrets(store, preset, input, secretResolver);
  if (providerModelDiscoveryNeedsApiKey(preset, materialized.headers) && !materialized.apiKeySecret.configured) {
    throw new HttpError(400, "secret_missing", "API key missing. Add an API key before fetching models.");
  }

  const request = createProviderModelDiscoveryRequest(preset, materialized.headers, materialized.apiKeySecret.value);
  try {
    const signal = AbortSignal.timeout(PROVIDER_CHECK_TIMEOUT_MS);
    const models: ProviderModelOption[] = [];
    const seenModelIds = new Set<string>();
    const seenPageTokens = new Set<string>();
    let pageSource = request.source;
    for (;;) {
      const response = await fetch(pageSource, {
        method: "GET",
        headers: request.headers,
        signal,
      });
      if (!response.ok) {
        throw new HttpError(
          response.status === 401 || response.status === 403 ? 401 : 400,
          response.status === 401 || response.status === 403 ? "auth_failed" : "provider_error",
          await providerModelListFailureMessage(response, materialized.redactionValues),
        );
      }
      const body = await response.json() as unknown;
      models.push(...parseProviderModelsResponse(body, preset, PROVIDER_MODEL_DISCOVERY_LIMIT - models.length, seenModelIds));
      const nextPageToken = providerModelDiscoveryNextPageToken(body, preset);
      if (models.length >= PROVIDER_MODEL_DISCOVERY_LIMIT || !nextPageToken) break;
      if (seenPageTokens.has(nextPageToken) || seenPageTokens.size >= PROVIDER_MODEL_DISCOVERY_PAGE_LIMIT - 1) {
        throw new HttpError(400, "provider_error", "Provider model discovery returned repeated or too many page tokens.");
      }
      seenPageTokens.add(nextPageToken);
      const nextPageUrl = new URL(request.source);
      nextPageUrl.searchParams.set("pageToken", nextPageToken);
      pageSource = nextPageUrl.toString();
    }
    return providerModelListResponse(request.source, models);
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    throw new HttpError(
      400,
      "network_failed",
      `Provider model discovery failed: ${redactTextWithSecrets(error instanceof Error ? error.message : String(error), materialized.redactionValues)}`,
    );
  }
}

async function listMediaProviderModels(
  store: ProviderStoreFacet,
  preset: ProviderPreset,
  input: ProviderModelListRequest,
  secretResolver: SecretResolver,
): Promise<ProviderModelListResponse> {
  const mediaKind = providerMediaKind(preset);
  const builtin = builtinMediaModelCandidates(mediaKind);
  const materialized = materializeProviderModelListSecrets(store, preset, input, secretResolver);
  if (preset.authHeader === false && !materialized.apiKeySecret.configured) {
    return providerModelListResponse("builtin:generation-models", builtin);
  }
  if ((preset.authHeader !== false || preset.apiKeyRef) && !materialized.apiKeySecret.configured) {
    throw new HttpError(400, "secret_missing", "API key missing. Add an API key before fetching models.");
  }

  const request = createProviderModelDiscoveryRequest(preset, materialized.headers, materialized.apiKeySecret.value);
  try {
    const response = await fetch(request.source, {
      method: "GET",
      headers: request.headers,
      signal: AbortSignal.timeout(PROVIDER_CHECK_TIMEOUT_MS),
    });
    if (!response.ok) {
      if (builtin.length > 0) {
        return providerModelListResponse("builtin:generation-models", builtin);
      }
      throw new HttpError(
        response.status === 401 || response.status === 403 ? 401 : 400,
        response.status === 401 || response.status === 403 ? "auth_failed" : "provider_error",
        await providerModelListFailureMessage(response, materialized.redactionValues),
      );
    }
    const body = await response.json() as unknown;
    const models = parseProviderModelsResponse(body, preset);
    return providerModelListResponse(request.source, models.length > 0 ? models : builtin);
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    if (builtin.length > 0) {
      return providerModelListResponse("builtin:generation-models", builtin);
    }
    throw new HttpError(
      400,
      "network_failed",
      `Provider model discovery failed: ${redactTextWithSecrets(error instanceof Error ? error.message : String(error), materialized.redactionValues)}`,
    );
  }
}

function providerModelListInputToPreset(
  store: ProviderStoreFacet,
  input: ProviderModelListRequest,
): ProviderPreset {
  const savedPreset = input.providerPresetId
    ? store.getProviderPreset(input.providerPresetId)
    : undefined;
  if (input.providerPresetId && !savedPreset) {
    throw new HttpError(404, "provider_not_found", `Provider preset not found: ${input.providerPresetId}`);
  }

  const requestedLocalRef = input.apiKeyRef && isLocalProviderSecretRef(input.apiKeyRef)
    ? input.apiKeyRef
    : undefined;
  if (requestedLocalRef && requestedLocalRef !== savedPreset?.apiKeyRef) {
    throw new HttpError(400, "invalid_secret_ref", "The local API key does not belong to this provider preset.");
  }
  const useSavedLocalSecret = !input.apiKey
    && Boolean(savedPreset?.apiKeyRef && isLocalProviderSecretRef(savedPreset.apiKeyRef))
    && (!input.apiKeyRef || input.apiKeyRef === savedPreset?.apiKeyRef);
  if (useSavedLocalSecret && savedPreset && !providerModelConnectionMatchesSavedPreset(input, savedPreset)) {
    throw new HttpError(
      409,
      "provider_model_connection_changed",
      "Save the provider connection changes or enter the API key again before fetching models.",
    );
  }

  return {
    id: useSavedLocalSecret && savedPreset ? savedPreset.id : "provider_model_probe",
    kind: input.kind,
    displayName: "Provider model probe",
    providerId: input.providerId,
    model: "model-probe",
    api: input.api,
    providerTransport: input.providerTransport,
    baseUrl: input.baseUrl,
    apiKeyRef: input.apiKey
      ? "__request_api_key__"
      : useSavedLocalSecret
        ? savedPreset?.apiKeyRef
        : input.apiKeyRef,
    headers: useSavedLocalSecret ? savedPreset?.headers ?? {} : input.headers ?? {},
    secretHeaderRefs: useSavedLocalSecret ? savedPreset?.secretHeaderRefs ?? {} : input.secretHeaderRefs ?? {},
    authHeader: input.authHeader ?? true,
    reasoning: false,
    thinkingModes: [],
    input: ["text"],
    compat: {},
    capabilities: ["chat"],
    enabled: true,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

function providerModelConnectionMatchesSavedPreset(
  input: ProviderModelListRequest,
  savedPreset: ProviderPreset,
): boolean {
  return input.kind === savedPreset.kind
    && input.providerId === savedPreset.providerId
    && input.api === savedPreset.api
    && normalizeProviderBaseUrlForAdapter(input) === normalizeProviderBaseUrlForAdapter(savedPreset)
    && (input.authHeader ?? true) === (savedPreset.authHeader ?? true);
}

function materializeProviderModelListSecrets(
  store: ProviderStoreFacet,
  preset: ProviderPreset,
  input: ProviderModelListRequest,
  secretResolver: SecretResolver,
): ReturnType<typeof materializeProviderSecrets> {
  try {
    return materializeProviderSecrets({
      store,
      preset,
      secretResolver,
      apiKeyOverride: input.apiKey,
    });
  } catch (error) {
    if (error instanceof ProviderSecretMaterializationError) {
      throw new HttpError(400, error.code, error.message);
    }
    throw error;
  }
}

async function providerModelListFailureMessage(response: Response, redactionValues: readonly string[]): Promise<string> {
  const bodyText = redactTextWithSecrets(await readLimitedResponseText(response, 800), redactionValues);
  return `Provider returned HTTP ${response.status}${bodyText ? `: ${bodyText}` : "."}`;
}

function parseProviderModelsResponse(
  body: unknown,
  preset: ProviderPreset,
  limit = PROVIDER_MODEL_DISCOVERY_LIMIT,
  seen = new Set<string>(),
): readonly ProviderModelOption[] {
  const data = providerModelDiscoveryItems(body, preset);
  const models: ProviderModelOption[] = [];
  for (const item of data) {
    const model = parseProviderModelOption(item, preset);
    if (!model || seen.has(model.id)) {
      continue;
    }
    seen.add(model.id);
    models.push(model);
    if (models.length >= limit) {
      break;
    }
  }
  return models;
}

function providerModelListResponse(
  source: string,
  models: readonly ProviderModelOption[],
): ProviderModelListResponse {
  return {
    source,
    fetchedAt: new Date().toISOString(),
    catalog: providerModelCatalogInfo(),
    models,
  };
}

function parseProviderModelOption(value: unknown, preset: ProviderPreset): ProviderModelOption | undefined {
  if (typeof value === "string") {
    const id = value.trim();
    return id ? enrichProviderModelOption({ id }, preset) : undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const id = typeof value.id === "string"
    ? value.id.trim()
    : typeof value.name === "string"
      ? value.name.trim()
      : "";
  if (!id) {
    return undefined;
  }
  const explicitApi = typeof value.api === "string" && providerApis.includes(value.api as ProviderApi)
    ? value.api as ProviderApi
    : undefined;
  const explicitInput = parseProviderModelInput(value);
  const explicitCapabilities = parseProviderModelCapabilities(value);
  const hasUpstreamCapabilityMetadata = explicitApi !== undefined || explicitCapabilities !== undefined || hasProviderModelOutputMetadata(value);
  return enrichProviderModelOption(removeUndefined({
    id,
    displayName: typeof value.display_name === "string" ? value.display_name : typeof value.displayName === "string" ? value.displayName : undefined,
    ownedBy: typeof value.owned_by === "string" ? value.owned_by : typeof value.ownedBy === "string" ? value.ownedBy : undefined,
    createdAt: readProviderModelCreatedAt(value),
    api: explicitApi ?? (explicitCapabilities?.some(isProviderGenerationCapability) ? "media-job" : undefined),
    input: explicitInput ?? (explicitCapabilities?.some(isProviderGenerationCapability) ? providerModelInputTypes : undefined),
    capabilities: explicitCapabilities,
    thinkingModes: parseProviderModelThinkingModes(value),
    thinkingSupport: parseProviderModelThinkingSupport(value),
    contextWindow: readPositiveInteger(
      value.contextWindow ??
      value.context_window ??
      value.context_length ??
      value.contextLength ??
      value.max_context_tokens,
    ),
    maxTokens: readPositiveInteger(
      value.maxTokens ??
      value.max_tokens ??
      value.max_completion_tokens ??
      value.max_output_tokens ??
      value.output_token_limit,
    ),
    supportedParameters: parseProviderModelLooseStringArray(value.supported_parameters ?? value.supportedParameters),
    capabilitySource: hasUpstreamCapabilityMetadata ? "upstream" as const : undefined,
    capabilityConfidence: hasUpstreamCapabilityMetadata ? "known" as const : undefined,
  }), preset);
}

function readProviderModelCreatedAt(value: Record<string, unknown>): string | undefined {
  if (typeof value.created_at === "string") {
    return value.created_at;
  }
  if (typeof value.createdAt === "string") {
    return value.createdAt;
  }
  if (typeof value.created === "number" && Number.isFinite(value.created)) {
    return new Date(value.created * 1000).toISOString();
  }
  return undefined;
}

function parseProviderModelInput(value: Record<string, unknown>): readonly ("text" | "image")[] | undefined {
  const architecture = isRecord(value.architecture) ? value.architecture : undefined;
  return (
    parseProviderModelStringArray(value.input, providerModelInputTypes) ??
    parseProviderModelStringArray(value.input_modalities, providerModelInputTypes) ??
    parseProviderModelStringArray(value.inputModalities, providerModelInputTypes) ??
    parseProviderModelStringArray(architecture?.input_modalities, providerModelInputTypes) ??
    parseProviderModelStringArray(architecture?.inputModalities, providerModelInputTypes) ??
    parseProviderModelModalities(value.modalities)
  );
}

function parseProviderModelCapabilities(value: Record<string, unknown>): readonly ProviderCapability[] | undefined {
  if (Array.isArray(value.capabilities) && value.capabilities.length === 0) return [];
  const architecture = isRecord(value.architecture) ? value.architecture : undefined;
  const metadata = isRecord(value.metadata) ? value.metadata : undefined;
  const result: ProviderCapability[] = [];
  appendProviderCapabilities(result, parseProviderModelStringArray(value.capabilities, providerCapabilities));
  appendProviderCapabilities(result, parseProviderModelLooseCapabilities(value.capabilities));
  appendProviderCapabilities(result, parseProviderModelLooseCapabilities(value.supported_capabilities));
  appendProviderCapabilities(result, parseProviderModelLooseCapabilities(value.supportedCapabilities));
  appendProviderCapabilities(result, parseProviderModelLooseCapabilities(value.features));
  appendProviderCapabilities(result, parseProviderModelLooseCapabilities(metadata?.capabilities));
  appendProviderCapabilities(result, parseProviderModelOutputCapabilities(value.output_modalities ?? value.outputModalities ?? architecture?.output_modalities ?? architecture?.outputModalities));
  appendProviderCapabilities(result, parseProviderModelTaskCapabilities(value.pipeline_tag ?? value.pipelineTag ?? value.task ?? value.type ?? value.category));
  appendProviderCapabilities(result, parseProviderModelTaskCapabilities(value.tags));
  return result.length > 0 ? result : undefined;
}

function appendProviderCapabilities(target: ProviderCapability[], source: readonly ProviderCapability[] | undefined): void {
  for (const capability of source ?? []) {
    if (!target.includes(capability)) {
      target.push(capability);
    }
  }
}

function parseProviderModelLooseCapabilities(value: unknown): readonly ProviderCapability[] | undefined {
  const raw = parseProviderModelLooseStringArray(value);
  if (!raw) {
    return undefined;
  }
  const result: ProviderCapability[] = [];
  for (const item of raw) {
    const capability = normalizeProviderModelCapabilityToken(item);
    if (capability && !result.includes(capability)) {
      result.push(capability);
    }
  }
  return result.length > 0 ? result : undefined;
}

function parseProviderModelOutputCapabilities(value: unknown): readonly ProviderCapability[] | undefined {
  const raw = parseProviderModelLooseStringArray(value);
  if (!raw) {
    return undefined;
  }
  const result: ProviderCapability[] = [];
  for (const item of raw) {
    const normalized = normalizeLooseProviderModelToken(item);
    if (["image", "output_image", "generated_image", "images"].includes(normalized) && !result.includes("image_generate")) {
      result.push("image_generate");
    }
    if (["video", "output_video", "generated_video", "videos"].includes(normalized) && !result.includes("video_generate")) {
      result.push("video_generate");
    }
    if (["text", "output_text", "message"].includes(normalized) && !result.includes("chat")) {
      result.push("chat");
    }
  }
  return result.length > 0 ? result : undefined;
}

function parseProviderModelTaskCapabilities(value: unknown): readonly ProviderCapability[] | undefined {
  const raw = typeof value === "string" ? [value] : parseProviderModelLooseStringArray(value);
  if (!raw) {
    return undefined;
  }
  const result: ProviderCapability[] = [];
  for (const item of raw) {
    const capability = normalizeProviderModelCapabilityToken(item);
    if (capability && !result.includes(capability)) {
      result.push(capability);
    }
  }
  return result.length > 0 ? result : undefined;
}

function normalizeProviderModelCapabilityToken(value: string): ProviderCapability | undefined {
  const normalized = normalizeLooseProviderModelToken(value);
  if (["chat", "completion", "text_generation", "text"].includes(normalized)) {
    return "chat";
  }
  if (["tool_call", "tool_calling", "function_call", "function_calling", "tools"].includes(normalized)) {
    return "tool_call";
  }
  if (["reasoning", "thinking"].includes(normalized)) {
    return "reasoning";
  }
  if (["vision", "image_input", "input_image", "visual_understanding"].includes(normalized)) {
    return "vision";
  }
  if (["text_to_image", "txt2img", "image_generation", "image_generate", "generate_image", "images_generation"].includes(normalized)) {
    return "image_generate";
  }
  if (["image_to_image", "img2img", "image_edit", "image_editing", "edit_image", "inpainting", "outpainting"].includes(normalized)) {
    return "image_edit";
  }
  if (["text_to_video", "video_generation", "video_generate", "generate_video"].includes(normalized)) {
    return "video_generate";
  }
  if (["web_search", "search"].includes(normalized)) {
    return "web_search";
  }
  if (["embedding", "embeddings"].includes(normalized)) {
    return "embedding";
  }
  if (["tts", "text_to_speech"].includes(normalized)) {
    return "tts";
  }
  if (["asr", "speech_to_text"].includes(normalized)) {
    return "asr";
  }
  return undefined;
}

function normalizeLooseProviderModelToken(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function hasProviderModelOutputMetadata(value: Record<string, unknown>): boolean {
  const architecture = isRecord(value.architecture) ? value.architecture : undefined;
  return (
    value.output_modalities !== undefined ||
    value.outputModalities !== undefined ||
    architecture?.output_modalities !== undefined ||
    architecture?.outputModalities !== undefined
  );
}

function isProviderGenerationCapability(capability: ProviderCapability): boolean {
  return capability === "image_generate" || capability === "image_edit" || capability === "video_generate";
}

function parseProviderModelModalities(value: unknown): readonly ("text" | "image")[] | undefined {
  const raw = parseProviderModelLooseStringArray(value);
  if (!raw) {
    return undefined;
  }
  const normalized = raw.map((item) => item.toLowerCase());
  const result: ("text" | "image")[] = [];
  if (normalized.some((item) => ["text", "input_text", "chat", "completion"].includes(item))) {
    result.push("text");
  }
  if (normalized.some((item) => ["image", "input_image", "vision"].includes(item))) {
    result.push("image");
  }
  return result.length > 0 ? result : undefined;
}

function parseProviderModelThinkingModes(value: Record<string, unknown>): readonly ProviderThinkingMode[] | undefined {
  const rawModes = value.thinkingModes ?? value.thinking_modes ?? value.reasoningLevels ?? value.reasoning_levels;
  if (Array.isArray(rawModes) && rawModes.length === 0) return [];
  const explicit = normalizeProviderThinkingModes(
    parseProviderModelLooseStringArray(rawModes),
  );
  if (explicit) {
    return explicit;
  }
  const support = parseProviderModelThinkingSupport(value);
  if (support) {
    return support.levels;
  }
  if (value.reasoning === true || value.supports_reasoning === true || value.supportsThinking === true || value.supports_thinking === true) {
    return ["off", "low", "medium", "high"];
  }
  const supportedParameters = parseProviderModelLooseStringArray(value.supported_parameters ?? value.supportedParameters);
  if (supportedParameters?.some((parameter) => /reasoning|thinking/i.test(parameter))) {
    return ["off", "low", "medium", "high"];
  }
  return undefined;
}

function parseProviderModelThinkingSupport(value: Record<string, unknown>): ProviderThinkingSupport | undefined {
  const thinking = isRecord(value.thinking)
    ? value.thinking
    : isRecord(value.thinking_support)
      ? value.thinking_support
      : isRecord(value.reasoning)
        ? value.reasoning
        : undefined;
  if (!thinking) {
    return undefined;
  }
  const levels = normalizeProviderThinkingModes(parseProviderModelLooseStringArray(thinking.levels));
  if (!levels && !(Array.isArray(thinking.levels) && thinking.levels.length === 0)) return undefined;
  return normalizeProviderThinkingSupport({
    levels: levels ?? [],
    minTokens: readPositiveInteger(thinking.min ?? thinking.min_tokens ?? thinking.minTokens),
    maxTokens: readPositiveInteger(thinking.max ?? thinking.max_tokens ?? thinking.maxTokens),
    zeroAllowed: readOptionalBooleanLike(thinking.zero_allowed ?? thinking.zeroAllowed),
    dynamicAllowed: readOptionalBooleanLike(thinking.dynamic_allowed ?? thinking.dynamicAllowed),
  });
}

function readPositiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

function readOptionalBooleanLike(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  return undefined;
}

function parseProviderModelStringArray<T extends string>(value: unknown, allowed: readonly T[]): readonly T[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const result: T[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !allowed.includes(item as T)) {
      continue;
    }
    result.push(item as T);
  }
  return result.length > 0 ? result : undefined;
}

function parseProviderModelLooseStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    const trimmed = item.trim();
    if (trimmed && !result.includes(trimmed)) {
      result.push(trimmed);
    }
  }
  return result.length > 0 ? result : undefined;
}
