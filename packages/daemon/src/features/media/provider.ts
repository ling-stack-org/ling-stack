import {
  normalizeProviderBaseUrlForAdapter,
  type CreateMediaJobInput,
  type ProviderPreset,
  type ResolvedSecret,
  type RunStore,
  type SecretResolver,
} from "@ling-stack/core";
import {
  createDefaultMediaAdapterRegistry,
  createLiveMediaVendorTransport,
  resolveMediaAdapter,
  resolveMediaVendorTransportGateConfig,
} from "@ling-stack/providers";
import { HttpError } from "../../errors.js";
import { resolveProviderSecret } from "../providers/secrets.js";

export function assertMediaJobProvider(store: RunStore, input: CreateMediaJobInput, secretResolver?: SecretResolver): ProviderPreset {
  void secretResolver;
  const preset = store.getProviderPreset(input.providerPresetId);
  if (!preset) {
    throw new HttpError(404, "provider_not_found", `Provider preset not found: ${input.providerPresetId}`);
  }
  if (!preset.enabled) {
    throw new HttpError(400, "provider_disabled", `Provider preset is disabled: ${preset.id}`);
  }
  if (preset.api !== "media-job") {
    throw new HttpError(400, "unsupported_capability", "Generation tasks require a generation-capable provider preset");
  }
  if (!preset.capabilities.includes(input.operation)) {
    throw new HttpError(400, "unsupported_capability", `${preset.displayName} does not support ${input.operation}`);
  }
  return preset;
}

export function createMediaAdapterForProvider(store: RunStore, provider: ProviderPreset, secretResolver: SecretResolver) {
  const gate = resolveMediaVendorTransportGateConfig(provider.compat);
  if (!gate.ok) {
    throw new HttpError(400, gate.errorCode ?? "invalid_request", gate.errorMessage ?? "Invalid media vendor transport configuration.");
  }
  const secret: ResolvedSecret = provider.apiKeyRef ? resolveProviderSecret(store, provider, secretResolver) : { configured: false };
  const registry = createDefaultMediaAdapterRegistry({
    mediaVendorTransport: gate.config?.mode === "live"
      ? createLiveMediaVendorTransport({
        baseUrl: provider.baseUrl ? normalizeProviderBaseUrlForAdapter(provider) : undefined,
        apiKeyRef: provider.apiKeyRef,
        apiKeyConfigured: secret.configured,
        apiKey: secret.value,
      })
      : undefined,
  });
  const resolution = resolveMediaAdapter(registry, {
    id: provider.id,
    kind: provider.kind,
    displayName: provider.displayName,
    providerId: provider.providerId,
    model: provider.model,
    api: provider.api,
    baseUrl: provider.baseUrl,
    apiKeyRef: provider.apiKeyRef,
    capabilities: provider.capabilities,
  });
  if (!resolution.ok || !resolution.adapter) {
    throw new HttpError(400, resolution.errorCode ?? "unsupported_capability", resolution.errorMessage ?? "Media adapter is not available.");
  }
  return resolution.adapter;
}
