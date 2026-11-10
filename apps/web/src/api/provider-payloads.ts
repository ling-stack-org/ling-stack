import type { ProviderFormState } from "../types.js";
import type { ProviderMutationRequest } from "@ling-stack/contracts";
import { normalizeMediaProviderCompat } from "@ling-stack/core/provider-media-normalization";
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
    secretHeaderRefs: parseSecretHeaderRefsText(form.secretHeaderRefsText),
    capabilities: splitCsv(form.capabilitiesText),
    input: splitCsv(form.inputText),
	    enabled: form.enabled,
	    authHeader: form.authHeader,
	    reasoning: form.reasoning,
	    thinkingModes: form.thinkingModes,
	    contextWindow: form.contextWindow ? Number(form.contextWindow) : undefined,
    maxTokens: form.maxTokens ? Number(form.maxTokens) : undefined,
    compat: providerFormCompat(form),
  };
}

export function parseSecretHeaderRefsText(value: string): Record<string, string> | undefined {
  const entries = value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => {
      const separator = line.includes(":") ? line.indexOf(":") : line.indexOf("=");
      if (separator <= 0) {
        return [line, ""] as const;
      }
      return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()] as const;
    });
  if (entries.length === 0) {
    return undefined;
  }
  return Object.fromEntries(entries);
}

export function providerFormCompat(form: ProviderFormState): Record<string, unknown> | undefined {
  const capabilities = splitCsv(form.capabilitiesText);
  const normalizedCompat = normalizeMediaProviderCompat({
    kind: form.kind,
    providerId: form.providerId,
    model: form.model,
    api: form.api,
    capabilities,
  });
  if (normalizedCompat) {
    return normalizedCompat;
  }
  if (form.api === "media-job") {
    return {};
  }
  return undefined;
}
