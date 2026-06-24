import type {
  ProviderPreset,
  SecretResolver,
} from "@ling-stack/core";
import {
  resolveProviderWebSearchAdapter,
  type ProviderWebSearchAdapter,
  type WebSearchResult,
} from "./web-search-adapters.js";

export interface ProviderWebSearchServiceInput {
  readonly providerPreset?: ProviderPreset;
  readonly secretResolver: SecretResolver;
  readonly query: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

export interface ProviderWebSearchServiceResult {
  readonly status: "available" | "blocked";
  readonly result?: WebSearchResult;
  readonly reason?: string;
}

interface ProviderWebSearchConfig {
  readonly adapter: ProviderWebSearchAdapter;
  readonly providerPreset: ProviderPreset;
  readonly apiKey: string;
}

interface ProviderWebSearchConfigResolution {
  readonly config?: ProviderWebSearchConfig;
  readonly blockedReason?: string;
}

export async function runProviderWebSearch(input: ProviderWebSearchServiceInput): Promise<ProviderWebSearchServiceResult> {
  const resolution = resolveProviderWebSearchConfig(input);
  if (!resolution.config) {
    return {
      status: "blocked",
      reason: resolution.blockedReason ?? "Current selected Ling provider does not support realtime web search.",
    };
  }
  try {
    const result = await resolution.config.adapter.search({
      providerPreset: resolution.config.providerPreset,
      apiKey: resolution.config.apiKey,
      query: input.query,
      fetch: input.fetch,
      timeoutMs: input.timeoutMs,
    });
    return { status: "available", result };
  } catch (error) {
    return {
      status: "blocked",
      reason: `${resolution.config.adapter.displayName} failed: ${safeErrorMessage(error)}`,
    };
  }
}

function resolveProviderWebSearchConfig(input: {
  readonly providerPreset?: ProviderPreset;
  readonly secretResolver: SecretResolver;
}): ProviderWebSearchConfigResolution {
  const unsupportedProviderReason = "Current selected Ling provider does not support realtime web search. Select an enabled provider with the web_search capability and a Ling web-search adapter in model settings; Ling will not bypass model settings with env:OPENAI_API_KEY.";
  const provider = input.providerPreset;
  if (!provider) {
    return { blockedReason: unsupportedProviderReason };
  }
  if (!provider.enabled || !provider.capabilities.includes("web_search")) {
    return { blockedReason: unsupportedProviderReason };
  }
  const adapter = resolveProviderWebSearchAdapter(provider);
  if (!adapter) {
    return {
      blockedReason: "Selected provider declares web_search, but Ling has no web-search adapter for this provider protocol yet.",
    };
  }
  if (!provider.apiKeyRef) {
    return {
      blockedReason: "Selected web-search provider has no configured provider key.",
    };
  }
  const providerSecret = input.secretResolver.resolve(provider.apiKeyRef, "provider_api_key");
  if (!providerSecret.value) {
    return {
      blockedReason: "Selected web-search provider key is missing.",
    };
  }
  return {
    config: {
      adapter,
      providerPreset: provider,
      apiKey: providerSecret.value,
    },
  };
}

function safeErrorMessage(error: unknown): string {
  return redactSecretLike(error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function redactSecretLike(value: string): string {
  return value.replace(/\bsk-[A-Za-z0-9_.*-]{6,}\b/gu, "[redacted]");
}
