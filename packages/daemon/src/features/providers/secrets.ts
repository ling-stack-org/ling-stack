import {
  isSupportedSecretRef,
  type ProviderPreset,
  type ProviderPresetInput,
  type PublicProviderPreset,
  type ResolvedSecret,
  type RunStore,
  type SecretPurpose,
  type SecretResolver,
  type SecretStatus,
} from "@ling-stack/core";

const draftProviderSecretRef = "keychain:LING_STACK_DRAFT_PROVIDER_API_KEY";

export function saveLocalProviderSecret(store: RunStore, preset: ProviderPreset, apiKey: string, now: string): ProviderPreset {
  store.setProviderSecret(preset.id, apiKey, now);
  return store.updateProviderPreset(preset.id, { apiKeyRef: localProviderSecretRef(preset.id) }, now) ?? preset;
}

export function providerDraftInputToPreset(input: ProviderPresetInput, apiKey: string | undefined, now: string): ProviderPreset {
  return {
    id: "provider_draft_check",
    kind: input.kind,
    displayName: input.displayName,
    providerId: input.providerId,
    model: input.model,
    api: input.api,
    baseUrl: input.baseUrl,
    apiKeyRef: apiKey ? draftProviderSecretRef : input.apiKeyRef,
    headers: input.headers ?? {},
    authHeader: input.authHeader,
    reasoning: input.reasoning,
    input: input.input ?? ["text"],
    contextWindow: input.contextWindow,
    maxTokens: input.maxTokens,
    compat: input.compat ?? {},
    capabilities: input.capabilities,
    enabled: input.enabled ?? true,
    createdAt: now,
    updatedAt: now,
  };
}

export function createDraftProviderSecretResolver(delegate: SecretResolver, apiKey: string): SecretResolver {
  return {
    status(ref: string, purpose?: SecretPurpose): SecretStatus {
      if (ref === draftProviderSecretRef) {
        return {
          ref,
          kind: "keychain",
          configured: true,
        };
      }
      return delegate.status(ref, purpose);
    },
    resolve(ref: string, purpose?: SecretPurpose): ResolvedSecret {
      const status = this.status(ref, purpose);
      if (ref === draftProviderSecretRef) {
        return {
          ref,
          configured: true,
          value: apiKey,
          status,
        };
      }
      return delegate.resolve(ref, purpose);
    },
  };
}

export function localProviderSecretRef(providerId: string): string {
  return `local:${providerId}`;
}

export function providerSecretStatus(
  store: RunStore,
  preset: Pick<ProviderPreset, "id" | "apiKeyRef">,
  secretResolver: SecretResolver,
): SecretStatus {
  if (!preset.apiKeyRef) {
    return {
      ref: "",
      kind: "local",
      configured: false,
      errorCode: "secret_missing",
      message: "API key missing.",
    };
  }
  if (isLocalProviderSecretRef(preset.apiKeyRef)) {
    const providerId = readLocalProviderSecretProviderId(preset.apiKeyRef);
    const validLocalRef = providerId === preset.id;
    const configured = validLocalRef && store.hasProviderSecret(providerId);
    return {
      ref: preset.apiKeyRef,
      kind: "local",
      configured,
      errorCode: configured ? undefined : validLocalRef ? "secret_missing" : "invalid_secret_ref",
      message: configured ? undefined : validLocalRef ? "API key missing. Add an API key before checking this preset." : "Local API key ref does not match this provider.",
    };
  }
  return secretResolver.status(preset.apiKeyRef, "provider_api_key");
}

export function resolveProviderSecret(
  store: RunStore,
  preset: Pick<ProviderPreset, "id" | "apiKeyRef">,
  secretResolver: SecretResolver,
): ResolvedSecret {
  if (!preset.apiKeyRef) {
    return { configured: false };
  }
  if (isLocalProviderSecretRef(preset.apiKeyRef)) {
    const status = providerSecretStatus(store, preset, secretResolver);
    if (!status.configured) {
      return { ref: preset.apiKeyRef, configured: false, status };
    }
    return {
      ref: preset.apiKeyRef,
      configured: true,
      value: store.getProviderSecret(readLocalProviderSecretProviderId(preset.apiKeyRef)),
      status,
    };
  }
  return secretResolver.resolve(preset.apiKeyRef, "provider_api_key");
}

export function isLocalProviderSecretRef(ref: string): boolean {
  return ref.startsWith("local:");
}

export function readLocalProviderSecretProviderId(ref: string): string {
  return ref.slice("local:".length);
}

export function toPublicProviderPreset(store: RunStore, preset: ProviderPreset, secretResolver: SecretResolver): PublicProviderPreset {
  const apiKeyStatus = preset.apiKeyRef ? providerSecretStatus(store, preset, secretResolver) : undefined;
  return {
    ...preset,
    apiKeyConfigured: apiKeyStatus?.configured ?? false,
    apiKeyStatus,
  };
}

export function toProviderSecretResponse(
  store: RunStore,
  preset: ProviderPreset,
): { readonly providerId: string; readonly apiKey: string; readonly apiKeyRef?: string; readonly configured: boolean } {
  if (!preset.apiKeyRef || !isLocalProviderSecretRef(preset.apiKeyRef)) {
    return {
      providerId: preset.id,
      apiKey: "",
      apiKeyRef: preset.apiKeyRef,
      configured: false,
    };
  }
  const providerId = readLocalProviderSecretProviderId(preset.apiKeyRef);
  const validLocalRef = providerId === preset.id;
  const apiKey = validLocalRef ? store.getProviderSecret(providerId) ?? "" : "";
  return {
    providerId: preset.id,
    apiKey,
    apiKeyRef: preset.apiKeyRef,
    configured: apiKey.length > 0,
  };
}

export function isSupportedProviderApiKeyRef(value: string): boolean {
  return isSupportedSecretRef(value) || isValidLocalProviderSecretRef(value);
}

function isValidLocalProviderSecretRef(value: string): boolean {
  if (!isLocalProviderSecretRef(value)) {
    return false;
  }
  const providerId = readLocalProviderSecretProviderId(value);
  return providerId.trim() === providerId && providerId.length > 0 && !/\s/.test(providerId);
}
