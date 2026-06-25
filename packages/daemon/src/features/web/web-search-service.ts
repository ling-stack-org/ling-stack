import type {
  ProviderPreset,
  ResolvedSecret,
  SecretResolver,
} from "@ling-stack/core";
import {
  isLocalProviderSecretRef,
  readLocalProviderSecretProviderId,
} from "../providers/secrets.js";
import {
  resolveProviderWebSearchAdapter,
  type ProviderWebSearchAdapter,
  type WebSearchResult,
} from "./web-search-adapters.js";

const WEB_SEARCH_TIMEOUT_MS = 12_000;
const WEB_SEARCH_MAX_TIMEOUT_MS = 120_000;

export interface ProviderWebSearchServiceInput {
  readonly providerPreset?: ProviderPreset;
  readonly webSearchProviderPresets?: readonly ProviderPreset[];
  readonly providerStore?: ProviderWebSearchSecretStore;
  readonly secretResolver: SecretResolver;
  readonly query: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

export interface ProviderWebSearchSecretStore {
  getProviderSecret(providerId: string): string | undefined;
  hasProviderSecret(providerId: string): boolean;
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
      timeoutMs: input.timeoutMs ?? providerWebSearchTimeoutMs(resolution.config.providerPreset),
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
  readonly webSearchProviderPresets?: readonly ProviderPreset[];
  readonly providerStore?: ProviderWebSearchSecretStore;
  readonly secretResolver: SecretResolver;
}): ProviderWebSearchConfigResolution {
  const unsupportedProviderReason = "No Ling global web_search backend is configured. Select or add an enabled provider with the web_search capability and a Ling web-search adapter in model settings; Ling will not bypass model settings with env:OPENAI_API_KEY.";
  const candidates = collectWebSearchProviderCandidates(input.webSearchProviderPresets, input.providerPreset);
  if (candidates.length === 0) {
    return { blockedReason: unsupportedProviderReason };
  }

  const missingKeyNames: string[] = [];
  const unsupportedNames: string[] = [];
  for (const provider of candidates) {
    if (!provider.enabled || !provider.capabilities.includes("web_search")) {
      continue;
    }
    const adapter = resolveProviderWebSearchAdapter(provider);
    if (!adapter) {
      unsupportedNames.push(provider.displayName);
      continue;
    }
    const providerSecret = resolveWebSearchProviderSecret(provider, input);
    if (!providerSecret.value) {
      missingKeyNames.push(provider.displayName);
      continue;
    }
    return {
      config: {
        adapter,
        providerPreset: provider,
        apiKey: providerSecret.value,
      },
    };
  }

  if (missingKeyNames.length > 0) {
    return {
      blockedReason: `Ling global web_search backend key is missing for: ${missingKeyNames.join(", ")}.`,
    };
  }
  if (unsupportedNames.length > 0) {
    return {
      blockedReason: "Configured Ling global web_search providers do not have a matching web-search adapter protocol yet.",
    };
  }
  return { blockedReason: unsupportedProviderReason };
}

function collectWebSearchProviderCandidates(
  webSearchProviderPresets: readonly ProviderPreset[] | undefined,
  providerPreset: ProviderPreset | undefined,
): ProviderPreset[] {
  const seen = new Set<string>();
  const candidates: ProviderPreset[] = [];
  for (const provider of [
    ...(webSearchProviderPresets ?? []),
    ...(providerPreset ? [providerPreset] : []),
  ]) {
    if (seen.has(provider.id)) {
      continue;
    }
    seen.add(provider.id);
    candidates.push(provider);
  }
  return candidates;
}

function resolveWebSearchProviderSecret(
  provider: ProviderPreset,
  input: {
    readonly providerStore?: ProviderWebSearchSecretStore;
    readonly secretResolver: SecretResolver;
  },
): ResolvedSecret {
  if (!provider.apiKeyRef) {
    return { configured: false };
  }
  if (!input.providerStore || !isLocalProviderSecretRef(provider.apiKeyRef)) {
    return input.secretResolver.resolve(provider.apiKeyRef, "provider_api_key");
  }
  const providerId = readLocalProviderSecretProviderId(provider.apiKeyRef);
  if (providerId !== provider.id || !input.providerStore.hasProviderSecret(providerId)) {
    return { ref: provider.apiKeyRef, configured: false };
  }
  return {
    ref: provider.apiKeyRef,
    configured: true,
    value: input.providerStore.getProviderSecret(providerId),
  };
}

function providerWebSearchTimeoutMs(provider: ProviderPreset): number {
  const webSearchCompat = isRecord(provider.compat.webSearch)
    ? provider.compat.webSearch
    : isRecord(provider.compat.web_search)
      ? provider.compat.web_search
      : undefined;
  const rawTimeout =
    typeof webSearchCompat?.timeoutMs === "number"
      ? webSearchCompat.timeoutMs
      : typeof webSearchCompat?.timeout_ms === "number"
        ? webSearchCompat.timeout_ms
        : undefined;
  if (rawTimeout === undefined || !Number.isInteger(rawTimeout)) {
    return WEB_SEARCH_TIMEOUT_MS;
  }
  return Math.min(Math.max(rawTimeout, WEB_SEARCH_TIMEOUT_MS), WEB_SEARCH_MAX_TIMEOUT_MS);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function safeErrorMessage(error: unknown): string {
  return redactSecretLike(error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function redactSecretLike(value: string): string {
  return value.replace(/\bsk-[A-Za-z0-9_.*-]{6,}\b/gu, "[redacted]");
}
