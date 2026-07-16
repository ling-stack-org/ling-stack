import {
  normalizeProviderPresetForMediaRuntime,
  normalizeProviderBaseUrlForAdapter,
  resolveMediaProviderRuntimeState,
  type CreateMediaJobInput,
  type ProviderPreset,
  type ProviderStoreFacet,
  type SecretResolver,
} from "@ling-stack/core";
import {
  createDefaultMediaAdapterRegistry,
  createLiveMediaVendorTransport,
  resolveMediaAdapter,
  resolveMediaVendorTransportGateConfig,
} from "@ling-stack/providers";
import { HttpError } from "../../errors.js";
import { materializeProviderSecrets } from "../providers/secret-materializer.js";

export function assertMediaJobProvider(store: ProviderStoreFacet, input: CreateMediaJobInput, secretResolver?: SecretResolver): ProviderPreset {
  void secretResolver;
  if (!input.providerPresetId) {
    throw new HttpError(400, "provider_required", "Direct media generation requires a provider preset");
  }
  const preset = store.getProviderPreset(input.providerPresetId);
  if (!preset) {
    throw new HttpError(404, "provider_not_found", `Provider preset not found: ${input.providerPresetId}`);
  }
  const normalizedPreset = normalizeProviderPresetForMediaRuntime(preset);
  const state = resolveMediaProviderRuntimeState(normalizedPreset, input.operation);
  if (!state.isMediaProvider) {
    throw new HttpError(400, "unsupported_capability", "Generation tasks require a generation-capable provider preset");
  }
  if (!state.supportsOperation) {
    throw new HttpError(400, "unsupported_capability", `${normalizedPreset.displayName} does not support ${input.operation}`);
  }
  if (!state.canRun) {
    throw mediaRuntimeHttpError(state.reason, normalizedPreset.id);
  }
  return normalizedPreset;
}

export function createMediaAdapterForProvider(store: ProviderStoreFacet, provider: ProviderPreset, secretResolver: SecretResolver) {
  const normalizedProvider = normalizeProviderPresetForMediaRuntime(provider);
  const gate = resolveMediaVendorTransportGateConfig(normalizedProvider.compat);
  if (!gate.ok) {
    throw new HttpError(400, gate.errorCode ?? "invalid_request", gate.errorMessage ?? "Invalid media vendor transport configuration.");
  }
  const materialized = materializeProviderSecrets({ store, preset: normalizedProvider, secretResolver });
  const registry = createDefaultMediaAdapterRegistry({
    mediaVendorTransport: gate.config?.mode === "live"
      ? createLiveMediaVendorTransport({
        baseUrl: normalizedProvider.baseUrl ? normalizeProviderBaseUrlForAdapter(normalizedProvider) : undefined,
        apiKeyRef: normalizedProvider.apiKeyRef,
        apiKeyConfigured: materialized.apiKeySecret.configured,
        apiKey: materialized.apiKeySecret.value,
        headers: materialized.headers,
        redactionValues: materialized.redactionValues,
      })
      : undefined,
  });
  const resolution = resolveMediaAdapter(registry, {
    id: normalizedProvider.id,
    kind: normalizedProvider.kind,
    displayName: normalizedProvider.displayName,
    providerId: normalizedProvider.providerId,
    model: normalizedProvider.model,
    api: normalizedProvider.api,
    baseUrl: normalizedProvider.baseUrl,
    apiKeyRef: normalizedProvider.apiKeyRef,
    capabilities: normalizedProvider.capabilities,
  });
  if (!resolution.ok || !resolution.adapter) {
    throw new HttpError(400, resolution.errorCode ?? "unsupported_capability", resolution.errorMessage ?? "Media adapter is not available.");
  }
  return resolution.adapter;
}

function mediaRuntimeHttpError(reason: ReturnType<typeof resolveMediaProviderRuntimeState>["reason"], providerId: string): HttpError {
  if (reason === "provider_disabled") {
    return new HttpError(400, "provider_disabled", `Provider preset is disabled: ${providerId}`);
  }
  if (reason === "base_url_missing") {
    return new HttpError(400, "bad_request", "生成模型缺少 Base URL，请在模型工作台补充后重试。");
  }
  if (reason === "secret_missing") {
    return new HttpError(400, "secret_missing", "生成模型缺少 API Key，请在模型工作台补充后重试。");
  }
  if (reason === "live_transport_invalid") {
    return new HttpError(400, "invalid_request", "生成模型真实生成配置无效，请在模型工作台重新保存。");
  }
  if (reason === "live_transport_required") {
    return new HttpError(400, "live_media_transport_required", "当前没有可真实生成的模型，请先在模型工作台配置具备图片或视频能力的模型。");
  }
  if (reason === "unsupported_live_adapter") {
    return new HttpError(400, "unsupported_capability", "当前只支持 OpenAI Images 图片生成、Seedream 图片生成/URL 编辑和 Seedance 最终视频生成的真实执行，其他生成模型暂未接入真实生成。");
  }
  return new HttpError(400, "unsupported_capability", "Generation tasks require a generation-capable provider preset");
}
