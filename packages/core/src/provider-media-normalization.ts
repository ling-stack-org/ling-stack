import type { MediaOperation } from "./media-types.js";
import type {
  ProviderApi,
  ProviderCapability,
  ProviderKind,
  ProviderPreset,
} from "./provider-types.js";
import {
  inferGenerationModelFamily,
  shouldAutoEnableLiveMediaTransport,
  type GenerationModelFamilyId,
} from "./provider-generation-models.js";

export type GenerationProviderRuntimeUnavailableReason =
  | "not_media_provider"
  | "not_generation_provider"
  | "provider_disabled"
  | "operation_unsupported"
  | "live_transport_invalid"
  | "live_transport_required"
  | "base_url_missing"
  | "secret_missing"
  | "unsupported_live_adapter";

export type MediaProviderRuntimeUnavailableReason = GenerationProviderRuntimeUnavailableReason;

export type GenerationRuntimeUiCopyKey =
  | "generation_runtime_ready"
  | "generation_runtime_not_media_provider"
  | "generation_runtime_not_generation_provider"
  | "generation_runtime_provider_disabled"
  | "generation_runtime_operation_unsupported"
  | "generation_runtime_live_transport_invalid"
  | "generation_runtime_live_transport_required"
  | "generation_runtime_base_url_missing"
  | "generation_runtime_secret_missing"
  | "generation_runtime_adapter_unsupported";

export interface GenerationProviderRuntimeInput {
  readonly kind?: ProviderKind;
  readonly providerId?: string;
  readonly model?: string;
  readonly modelId?: string;
  readonly api?: ProviderApi;
  readonly baseUrl?: string;
  readonly apiKeyRef?: string;
  readonly apiKeyConfigured?: boolean;
  readonly authHeader?: boolean;
  readonly compat?: Record<string, unknown>;
  readonly capabilities?: readonly string[];
  readonly enabled?: boolean;
}

export type MediaProviderRuntimeInput = GenerationProviderRuntimeInput;

export interface GenerationProviderRuntimeState {
  readonly provider: GenerationProviderRuntimeInput;
  readonly operation?: MediaOperation;
  readonly normalizedCompat: Record<string, unknown>;
  readonly familyId?: GenerationModelFamilyId;
  readonly supportedOperations: readonly MediaOperation[];
  readonly isMediaProvider: boolean;
  readonly isGenerationProvider: boolean;
  readonly supportsOperation: boolean;
  readonly liveTransportEnabled: boolean;
  readonly liveAdapterSupported: boolean;
  readonly canRun: boolean;
  readonly reason?: GenerationProviderRuntimeUnavailableReason;
  readonly uiCopyKey: GenerationRuntimeUiCopyKey;
}

export type MediaProviderRuntimeState = GenerationProviderRuntimeState;

const generationCapabilities = new Set<ProviderCapability>(["image_generate", "image_edit", "video_generate"]);
const generationOperations: readonly MediaOperation[] = ["image_generate", "image_edit", "video_generate"];

export function normalizeGenerationProviderCompat(input: GenerationProviderRuntimeInput): Record<string, unknown> | undefined {
  if (!shouldAutoEnableLiveMediaTransport({
    kind: input.kind,
    providerId: input.providerId,
    modelId: input.modelId ?? input.model,
    api: input.api,
    capabilities: input.capabilities,
  })) {
    return input.compat;
  }
  return {
    ...(input.compat ?? {}),
    mediaVendorTransport: { mode: "live" },
  };
}

export function normalizeMediaProviderCompat(input: MediaProviderRuntimeInput): Record<string, unknown> | undefined {
  return normalizeGenerationProviderCompat(input);
}

export function normalizeProviderPresetForGenerationRuntime<T extends ProviderPreset>(provider: T): T {
  const normalizedCompat = normalizeGenerationProviderCompat(provider);
  if (normalizedCompat === provider.compat || normalizedCompat === undefined) {
    return provider;
  }
  return {
    ...provider,
    compat: normalizedCompat,
  };
}

export function normalizeProviderPresetForMediaRuntime<T extends ProviderPreset>(provider: T): T {
  return normalizeProviderPresetForGenerationRuntime(provider);
}

export function resolveGenerationProviderRuntimeState(
  provider: GenerationProviderRuntimeInput,
  operation?: MediaOperation,
): GenerationProviderRuntimeState {
  const normalizedCompat = normalizeGenerationProviderCompat(provider) ?? provider.compat ?? {};
  const family = inferGenerationModelFamily(provider.modelId ?? provider.model, {
    kind: provider.kind,
    providerId: provider.providerId,
    api: provider.api,
  });
  const isMediaProvider = provider.api === "media-job";
  const supportedOperations = generationOperations.filter((candidate) => provider.capabilities?.includes(candidate) ?? false);
  const hasGenerationCapability = supportedOperations.length > 0 || Boolean(provider.capabilities?.some((capability) =>
    generationCapabilities.has(capability as ProviderCapability)
  ));
  const isGenerationProvider = isMediaProvider && hasGenerationCapability;
  const supportsOperation = operation === undefined ? supportedOperations.length > 0 : supportedOperations.includes(operation);
  const transport = readMediaVendorTransport(normalizedCompat);
  const liveTransportEnabled = transport.mode === "live";
  const liveAdapterSupported = operation === undefined
    ? supportedOperations.some((candidate) => isSupportedLiveMediaAdapter(provider, family?.familyId, candidate))
    : isSupportedLiveMediaAdapter(provider, family?.familyId, operation);
  const apiKeyConfigured = provider.apiKeyConfigured ?? Boolean(provider.apiKeyRef);

  const baseState = {
    provider,
    operation,
    normalizedCompat,
    familyId: family?.familyId,
    supportedOperations,
    isMediaProvider,
    isGenerationProvider,
    supportsOperation,
    liveTransportEnabled,
    liveAdapterSupported,
  };

  if (!isMediaProvider) {
    return unavailableState(baseState, "not_media_provider");
  }
  if (!isGenerationProvider) {
    return unavailableState(baseState, "not_generation_provider");
  }
  if (provider.enabled === false) {
    return unavailableState(baseState, "provider_disabled");
  }
  if (!supportsOperation) {
    return unavailableState(baseState, "operation_unsupported");
  }
  if (!transport.ok) {
    return unavailableState(baseState, "live_transport_invalid");
  }
  if (!liveTransportEnabled) {
    return unavailableState(baseState, "live_transport_required");
  }
  if (!provider.baseUrl) {
    return unavailableState(baseState, "base_url_missing");
  }
  if (!provider.apiKeyRef || !apiKeyConfigured) {
    return unavailableState(baseState, "secret_missing");
  }
  if (!liveAdapterSupported) {
    return unavailableState(baseState, "unsupported_live_adapter");
  }
  return { ...baseState, canRun: true, uiCopyKey: "generation_runtime_ready" };
}

export function resolveMediaProviderRuntimeState(
  provider: MediaProviderRuntimeInput,
  operation?: MediaOperation,
): MediaProviderRuntimeState {
  return resolveGenerationProviderRuntimeState(provider, operation);
}

function isSupportedLiveMediaAdapter(
  provider: GenerationProviderRuntimeInput,
  familyId: GenerationModelFamilyId | undefined,
  operation: MediaOperation,
): boolean {
  if (familyId === "openai-images") {
    return operation === "image_generate" && (provider.kind === "openai" || provider.kind === "openai-compatible");
  }
  if (familyId === "volcengine-seedream") {
    return (operation === "image_generate" || operation === "image_edit") &&
      (provider.kind === "seedream" || provider.providerId === "seedream");
  }
  if (familyId === "volcengine-seedance") {
    return operation === "video_generate" && (provider.kind === "seedance" || provider.providerId === "seedance");
  }
  return false;
}

function unavailableState(
  state: Omit<GenerationProviderRuntimeState, "canRun" | "reason" | "uiCopyKey">,
  reason: GenerationProviderRuntimeUnavailableReason,
): GenerationProviderRuntimeState {
  return { ...state, canRun: false, reason, uiCopyKey: generationRuntimeUiCopyKey(reason) };
}

export function generationRuntimeUiCopyKey(reason: GenerationProviderRuntimeUnavailableReason): GenerationRuntimeUiCopyKey {
  if (reason === "not_media_provider") {
    return "generation_runtime_not_media_provider";
  }
  if (reason === "not_generation_provider") {
    return "generation_runtime_not_generation_provider";
  }
  if (reason === "provider_disabled") {
    return "generation_runtime_provider_disabled";
  }
  if (reason === "operation_unsupported") {
    return "generation_runtime_operation_unsupported";
  }
  if (reason === "live_transport_invalid") {
    return "generation_runtime_live_transport_invalid";
  }
  if (reason === "live_transport_required") {
    return "generation_runtime_live_transport_required";
  }
  if (reason === "base_url_missing") {
    return "generation_runtime_base_url_missing";
  }
  if (reason === "secret_missing") {
    return "generation_runtime_secret_missing";
  }
  return "generation_runtime_adapter_unsupported";
}

function readMediaVendorTransport(compat: Record<string, unknown>): (
  | { readonly ok: true; readonly mode: "disabled" | "live" }
  | { readonly ok: false; readonly mode: "invalid" }
) {
  const transport = compat.mediaVendorTransport;
  if (transport === undefined) {
    return { ok: true, mode: "disabled" };
  }
  if (!isRecord(transport)) {
    return { ok: false, mode: "invalid" };
  }
  const mode = transport.mode;
  if (mode === undefined || mode === "disabled") {
    return { ok: true, mode: "disabled" };
  }
  if (mode === "live") {
    return { ok: true, mode: "live" };
  }
  return { ok: false, mode: "invalid" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
