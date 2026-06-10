import type { ProviderFormState, ProviderMutationRequest } from "../types.js";
import { splitCsv } from "./shared.js";

export function providerFormToPayload(form: ProviderFormState): ProviderMutationRequest {
  return {
    kind: form.kind,
    displayName: form.displayName,
    providerId: form.providerId,
    model: form.model,
    api: form.api,
    providerTransport: form.providerTransport || undefined,
    baseUrl: form.baseUrl || undefined,
    apiKeyRef: form.apiKeyRef || undefined,
    apiKey: form.apiKey.trim() || undefined,
    clearApiKey: form.clearApiKey || undefined,
    capabilities: splitCsv(form.capabilitiesText),
    input: splitCsv(form.inputText),
    enabled: form.enabled,
    authHeader: form.authHeader,
    reasoning: form.reasoning,
    contextWindow: form.contextWindow ? Number(form.contextWindow) : undefined,
    maxTokens: form.maxTokens ? Number(form.maxTokens) : undefined,
    compat: providerFormCompat(form),
  };
}

export function providerFormCompat(form: ProviderFormState): Record<string, unknown> | undefined {
  const capabilities = splitCsv(form.capabilitiesText);
  if (form.api === "media-job" && form.kind === "seedream" && capabilities.includes("image_generate")) {
    return { mediaVendorTransport: { mode: "live" } };
  }
  if (form.api === "media-job") {
    return {};
  }
  return undefined;
}
